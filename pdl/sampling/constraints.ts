import { Dex, toID } from '../../sim/dex';
import { TeamValidator } from '../../sim/team-validator';
import type { PokemonSet } from '../../sim/teams';
import { PDL_FORMAT_ID } from '../format';
import { validatePdlTeam } from '../validate-team';
import type {
	NormalizedPdlTeamSelectionConstraints,
	PdlSamplingRosterTeam,
	PdlSamplingSnapshot,
	PdlTeamSelectionConstraints,
} from './types';

const STAT_IDS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
const TEAM_SIZE = 6;

function cloneSet(set: PokemonSet): PokemonSet {
	return { ...set, moves: [...set.moves], evs: { ...set.evs }, ivs: { ...set.ivs } };
}

function normalizedSpecies(values: readonly string[] | undefined, label: string): string[] {
	const ids = (values || []).map(value => toID(value));
	if (ids.some(id => !id)) throw new Error(`${label} must name a Pokémon.`);
	if (new Set(ids).size !== ids.length) throw new Error(`${label} must not repeat a Pokémon.`);
	return ids;
}

function normalizedTeraReferences(value: Readonly<Record<string, string>> | undefined): Record<string, string> {
	const references: Record<string, string> = {};
	for (const [species, teraType] of Object.entries(value || {})) {
		const speciesId = toID(species);
		const type = Dex.types.get(teraType);
		if (!speciesId || !type.exists) throw new Error('Tera references must use valid Pokémon names and types.');
		references[speciesId] = type.name;
	}
	return references;
}

/** Parses `Species|Item|Ability|Nature|HP,Atk,Def,SpA,SpD,Spe|Move1,Move2,Move3,Move4|TeraType`. */
export function parseLockedBuild(value: string): PokemonSet {
	const fields = value.split('|').map(field => field.trim());
	if (fields.length !== 7) {
		throw new Error('--lock-a/--lock-b must use Species|Item|Ability|Nature|HP,Atk,Def,SpA,SpD,Spe|Move1,Move2,Move3,Move4|TeraType.');
	}
	const [species, item, ability, nature, evsText, movesText, teraType] = fields;
	if (![species, item, ability, nature, evsText, movesText].every(Boolean)) {
		throw new Error('Locked builds require species, item, ability, nature, EVs, and four moves.');
	}
	const evValues = evsText.split(',').map(value => Number(value.trim()));
	if (evValues.length !== STAT_IDS.length || evValues.some(value => !Number.isInteger(value) || value < 0 || value > 252) || evValues.reduce((total, value) => total + value, 0) > 510) {
		throw new Error('Locked-build EVs must contain six integer values from 0 to 252 totaling at most 510.');
	}
	const moves = movesText.split(',').map(move => move.trim());
	if (moves.length !== 4 || moves.some(move => !toID(move)) || new Set(moves.map(toID)).size !== 4) {
		throw new Error('Locked builds require exactly four distinct moves.');
	}
	return {
		name: species, species, item, ability, nature, moves,
		evs: Object.fromEntries(STAT_IDS.map((stat, index) => [stat, evValues[index]])) as PokemonSet['evs'],
		ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, gender: '', level: 100, teraType,
	};
}

/** Normalizes terminal/API constraints before roster-specific validation. */
export function normalizeTeamSelectionConstraints(
	constraints: PdlTeamSelectionConstraints | undefined
): NormalizedPdlTeamSelectionConstraints {
	const requiredSpecies = normalizedSpecies(constraints?.requiredSpecies, 'Required Pokémon');
	const excludedSpecies = normalizedSpecies(constraints?.excludedSpecies, 'Excluded Pokémon');
	const lockedSets = (constraints?.lockedSets || []).map(cloneSet);
	const lockedSpecies = lockedSets.map(set => toID(set.species));
	if (lockedSpecies.some(id => !id)) throw new Error('Locked builds must name a Pokémon species.');
	if (new Set(lockedSpecies).size !== lockedSpecies.length) throw new Error('Only one locked build is permitted per Pokémon.');
	const required = [...new Set([...requiredSpecies, ...lockedSpecies])];
	if (required.some(species => excludedSpecies.includes(species))) {
		throw new Error('A Pokémon cannot be both required and excluded.');
	}
	if (required.length > TEAM_SIZE) throw new Error(`At most six Pokémon may be required or locked for one battle team.`);
	return { requiredSpecies: required, excludedSpecies, lockedSets, teraReferences: normalizedTeraReferences(constraints?.teraReferences) };
}

/**
 * Separates declared-but-ineligible Tera types from actual battle sets. This
 * preserves a coach's build note without exposing a forbidden Showdown action.
 */
export function resolveTeraReferences(input: {
	readonly team: PdlSamplingRosterTeam;
	readonly constraints: NormalizedPdlTeamSelectionConstraints;
}): NormalizedPdlTeamSelectionConstraints {
	const roster = new Map(input.team.roster.map(pokemon => [toID(pokemon.species), pokemon]));
	const teraReferences = { ...input.constraints.teraReferences };
	for (const [species] of Object.entries(teraReferences)) {
		if (!roster.has(toID(species))) throw new Error(`${species} is not on ${input.team.name}'s current roster.`);
		if (!input.constraints.requiredSpecies.includes(species)) {
			throw new Error(`Tera reference ${species} must belong to a required or locked Pokémon.`);
		}
	}
	const lockedSets = input.constraints.lockedSets.map(original => {
		const set = cloneSet(original);
		const rosterPokemon = roster.get(toID(set.species));
		if (set.teraType && rosterPokemon && rosterPokemon.cost > 4) {
			const existing = teraReferences[toID(set.species)];
			if (existing && toID(existing) !== toID(set.teraType)) {
				throw new Error(`${set.species} has conflicting declared Tera reference types.`);
			}
			teraReferences[toID(set.species)] = Dex.types.get(set.teraType).name;
			set.teraType = '';
		}
		return set;
	});
	return { ...input.constraints, lockedSets, teraReferences };
}

function toLeagueSnapshot(snapshot: PdlSamplingSnapshot) {
	return {
		teams: snapshot.roster.teams.map(team => ({
			id: team.id, name: team.name, draftedTeraTypes: [...team.draftedTeraTypes], roster: team.roster.map(pokemon => ({ ...pokemon })),
		})),
	};
}

/** Ensures all explicit constraints refer to a live roster and legal PDL/Showdown build. */
export function validateTeamSelectionConstraints(input: {
	readonly snapshot: PdlSamplingSnapshot;
	readonly team: PdlSamplingRosterTeam;
	readonly constraints: NormalizedPdlTeamSelectionConstraints;
}): void {
	const roster = new Set(input.team.roster.map(pokemon => toID(pokemon.species)));
	for (const species of [...input.constraints.requiredSpecies, ...input.constraints.excludedSpecies]) {
		if (!roster.has(toID(species))) throw new Error(`${species} is not on ${input.team.name}'s current roster.`);
	}
	for (const set of input.constraints.lockedSets) {
		const validationTeam: PokemonSet[] = [cloneSet(set), ...input.team.roster
			.filter(pokemon => toID(pokemon.species) !== toID(set.species))
			.slice(0, TEAM_SIZE - 1)
			.map(pokemon => ({ species: pokemon.species } as PokemonSet))];
		const pdlErrors = validatePdlTeam({ league: toLeagueSnapshot(input.snapshot), teamId: input.team.id, team: validationTeam });
		const showdownErrors = TeamValidator.get(PDL_FORMAT_ID).validateSet(cloneSet(set), {}) || [];
		const errors = [...pdlErrors, ...showdownErrors];
		if (errors.length) throw new Error(`Locked build for ${set.species} is not PDL-legal: ${errors.join(' ')}`);
	}
}
