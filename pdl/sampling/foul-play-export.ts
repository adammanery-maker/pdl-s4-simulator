import { Dex, toID } from '../../sim/dex';
import { TeamValidator } from '../../sim/team-validator';
import type { PRNGSeed } from '../../sim/prng';
import { Teams, type PokemonSet } from '../../sim/teams';
import { PDL_FORMAT_ID } from '../format';
import { generateSetCandidates } from './candidates';
import { sampleCohesiveTeam, type CohesiveTeamSample } from './sample-team';
import { hashSamplingSnapshot } from './snapshot';
import type { PdlSamplingRosterTeam, PdlSamplingSnapshot, PdlTeamSelectionConstraints } from './types';

const STAT_IDS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;

export interface FoulPlayBeliefCandidate {
	readonly weight: number;
	readonly ability: string;
	readonly item: string;
	readonly nature: string;
	readonly evs: readonly number[];
	readonly moves: readonly string[];
	readonly teraType: string | null;
}

export interface FoulPlayBeliefData {
	readonly schemaVersion: 1;
	readonly snapshot: { readonly id: string; readonly source: string; readonly hash: string };
	readonly teams: Readonly<Record<string, {
		readonly draftedTeraTypes: readonly string[];
		readonly roster: readonly { species: string; cost: number }[];
		readonly teraCaptains?: readonly string[];
	}>>;
	readonly sets: Readonly<Record<string, readonly FoulPlayBeliefCandidate[]>>;
}

export interface FoulPlayMatchArtifacts {
	readonly belief: FoulPlayBeliefData;
	readonly teams: Readonly<Record<string, {
		readonly id: string;
		readonly name: string;
		readonly packed: string;
		readonly exported: string;
		readonly sample: CohesiveTeamSample;
	}>>;
}

export interface BuildFoulPlayMatchArtifactsInput {
	readonly snapshot: PdlSamplingSnapshot;
	readonly p1TeamId: string;
	readonly p2TeamId: string;
	readonly p1Seed: PRNGSeed;
	readonly p2Seed: PRNGSeed;
	readonly p1Constraints?: PdlTeamSelectionConstraints;
	readonly p2Constraints?: PdlTeamSelectionConstraints;
	readonly maxCandidatesPerSpecies?: number;
}

export interface BuildFoulPlayArtifactsFromSamplesInput {
	readonly snapshot: PdlSamplingSnapshot;
	readonly p1TeamId: string;
	readonly p2TeamId: string;
	readonly p1Sample: CohesiveTeamSample;
	readonly p2Sample: CohesiveTeamSample;
	readonly maxCandidatesPerSpecies?: number;
}

function getTeam(snapshot: PdlSamplingSnapshot, teamId: string): PdlSamplingRosterTeam {
	const team = snapshot.roster.teams.find(candidate => toID(candidate.id) === toID(teamId));
	if (!team) throw new Error(`Unknown PDL team: ${teamId}.`);
	return team;
}

function candidateKey(set: PokemonSet): string {
	return [
		toID(set.species), toID(set.ability), toID(set.item), toID(set.nature), toID(set.teraType),
		...set.moves.map(toID),
	].join('|');
}

function toFoulPlayCandidate(set: PokemonSet, weight: number): FoulPlayBeliefCandidate {
	return {
		weight,
		ability: set.ability,
		item: set.item,
		nature: set.nature,
		evs: STAT_IDS.map(stat => set.evs[stat]),
		moves: [...set.moves],
		teraType: set.teraType || null,
	};
}

function beliefCandidates(
	snapshot: PdlSamplingSnapshot,
	team: PdlSamplingRosterTeam,
	species: string,
	maxCandidatesPerSpecies: number
): FoulPlayBeliefCandidate[] {
	const bySet = new Map<string, { set: PokemonSet; weight: number }>();
	for (const candidate of generateSetCandidates({ snapshot, teamId: team.id, species })) {
		if (!candidate.set || candidate.usageWeight <= 0) continue;
		const key = candidateKey(candidate.set);
		const existing = bySet.get(key);
		if (!existing || existing.weight < candidate.usageWeight) {
			bySet.set(key, { set: candidate.set, weight: candidate.usageWeight });
		}
	}
	const candidates = [...bySet.values()]
		.sort((left, right) => right.weight - left.weight || candidateKey(left.set).localeCompare(candidateKey(right.set)))
		.slice(0, maxCandidatesPerSpecies)
		.map(candidate => toFoulPlayCandidate(candidate.set, candidate.weight));
	if (!candidates.length) throw new Error(`Cannot create Foul Play beliefs for ${species}: no legal observed candidates.`);
	return candidates;
}

function topDistinctChoices(choices: readonly import('./types').PdlSamplingUsageChoice[] | undefined, limit: number) {
	const selected = new Map<string, import('./types').PdlSamplingUsageChoice>();
	for (const choice of [...(choices || [])].sort((left, right) => right.weight - left.weight)) {
		const id = toID(choice.name);
		if (id && !selected.has(id)) selected.set(id, choice);
		if (selected.size === limit) break;
	}
	return [...selected.values()];
}

function compactBeliefCandidate(snapshot: PdlSamplingSnapshot, team: PdlSamplingRosterTeam, species: string): FoulPlayBeliefCandidate[] {
	const usage = snapshot.usageBySpecies[toID(species)];
	const rosterPokemon = team.roster.find(pokemon => toID(pokemon.species) === toID(species));
	if (!usage || !rosterPokemon) throw new Error(`Cannot create Foul Play beliefs for ${species}: missing current roster or observed usage.`);
	const moves = topDistinctChoices(usage.moves, 4);
	const ability = topDistinctChoices(usage.abilities, 1)[0];
	const item = topDistinctChoices(usage.items, 1)[0];
	const nature = topDistinctChoices(usage.natures, 1)[0];
	const spread = topDistinctChoices(usage.spreads, 1)[0];
	const evs = spread?.evs;
	if (moves.length !== 4 || !ability || !item || !nature || !spread || !evs || typeof evs !== 'object' || Array.isArray(evs)) {
		throw new Error(`Cannot create Foul Play beliefs for ${species}: incomplete observed usage.`);
	}
	const stats = evs as Record<string, unknown>;
	const set: PokemonSet = {
		name: Dex.species.get(species).name, species: Dex.species.get(species).name, item: item.name, ability: ability.name,
		nature: nature.name, moves: moves.map(move => move.name), gender: '', level: 100,
		evs: { hp: Number(stats.hp), atk: Number(stats.atk), def: Number(stats.def), spa: Number(stats.spa), spd: Number(stats.spd), spe: Number(stats.spe) },
		ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, teraType: '',
	};
	const allowedTeraTypes = new Set([
		...Dex.species.get(species).types,
		...team.draftedTeraTypes,
	].map(toID));
	const tera = rosterPokemon.cost <= 4 && usage.teraTypes?.length
		? topDistinctChoices(usage.teraTypes, 3).find(candidate => allowedTeraTypes.has(toID(candidate.name)))
		: undefined;
	if (tera) {
		set.teraType = tera.name;
	} else {
		delete set.teraType;
	}
	const errors = TeamValidator.get(PDL_FORMAT_ID).validateSet(set, {}) || [];
	if (errors.length) throw new Error(`Cannot create Foul Play beliefs for ${species}: ${errors.join('; ')}`);
	if (rosterPokemon.cost > 4) delete set.teraType;
	return [toFoulPlayCandidate(set, Math.max(1, ability.weight * item.weight * nature.weight * spread.weight))];
}

function buildBelief(
	snapshot: PdlSamplingSnapshot,
	first: CohesiveTeamSample,
	second: CohesiveTeamSample,
	firstTeam: PdlSamplingRosterTeam,
	secondTeam: PdlSamplingRosterTeam,
	maxCandidatesPerSpecies: number
): FoulPlayBeliefData {
	const selectedByTeam = new Map<string, Set<string>>([
		[firstTeam.id, new Set(first.sampledSpecies.map(toID))],
		[secondTeam.id, new Set(second.sampledSpecies.map(toID))],
	]);
	const teams: Record<string, { draftedTeraTypes: readonly string[]; roster: readonly { species: string; cost: number }[] }> = {};
	const sets: Record<string, readonly FoulPlayBeliefCandidate[]> = {};
	for (const team of [firstTeam, secondTeam]) {
		const selected = selectedByTeam.get(team.id)!;
		const roster = team.roster.filter(pokemon => selected.has(toID(pokemon.species)));
		if (roster.length !== 6) throw new Error(`Expected six selected roster Pokémon for ${team.name}.`);
		teams[team.id] = {
			draftedTeraTypes: [...team.draftedTeraTypes],
			roster: roster.map(pokemon => ({ ...pokemon })),
		};
		for (const pokemon of roster) {
			const species = toID(pokemon.species);
			if (sets[species]) throw new Error(`A Foul Play belief snapshot cannot represent duplicate species: ${pokemon.species}.`);
			sets[species] = beliefCandidates(snapshot, team, pokemon.species, maxCandidatesPerSpecies);
		}
	}
	return {
		schemaVersion: 1,
		snapshot: {
			id: `${snapshot.id}:${first.snapshotHash.slice(0, 16)}`,
			source: snapshot.sourceId,
			hash: first.snapshotHash,
		},
		teams,
		sets,
	};
}

/**
 * Exports a complete local PDL belief file for a human-versus-bot session.
 * The bot's submitted team remains a separate, explicit private Showdown
 * export; this file contains only roster-wide plausible set distributions.
 */
export function buildFoulPlayBeliefForSnapshot(snapshot: PdlSamplingSnapshot, teamIds: readonly string[]): FoulPlayBeliefData {
	const requested = new Set(teamIds.map(toID));
	if (!requested.size) throw new Error('At least one PDL team is required for a Foul Play belief snapshot.');
	const teams: Record<string, { draftedTeraTypes: readonly string[]; roster: readonly { species: string; cost: number }[] }> = {};
	const sets: Record<string, readonly FoulPlayBeliefCandidate[]> = {};
	for (const team of snapshot.roster.teams) {
		if (!requested.has(toID(team.id))) continue;
		teams[team.id] = {
			draftedTeraTypes: [...team.draftedTeraTypes],
			roster: team.roster.map(pokemon => ({ ...pokemon })),
		};
		for (const pokemon of team.roster) {
			const species = toID(pokemon.species);
			if (sets[species]) throw new Error(`A Foul Play belief snapshot cannot represent duplicate species: ${pokemon.species}.`);
			sets[species] = compactBeliefCandidate(snapshot, team, pokemon.species);
		}
	}
	for (const teamId of requested) {
		if (!teams[teamId]) throw new Error(`Unknown PDL team for Foul Play belief: ${teamId}.`);
	}
	return {
		schemaVersion: 1,
		snapshot: { id: `${snapshot.id}:full-roster`, source: snapshot.sourceId, hash: hashSamplingSnapshot(snapshot) },
		teams,
		sets,
	};
}

/**
 * Produces all local inputs for one two-bot Foul Play matchup. The belief
 * snapshot contains distributions only; each packed team is the separate,
 * explicit private build submitted by its bot to Showdown.
 */
export function buildFoulPlayMatchArtifacts(input: BuildFoulPlayMatchArtifactsInput): FoulPlayMatchArtifacts {
	const maxCandidatesPerSpecies = input.maxCandidatesPerSpecies ?? 12;
	if (!Number.isInteger(maxCandidatesPerSpecies) || maxCandidatesPerSpecies < 1) {
		throw new Error('maxCandidatesPerSpecies must be a positive integer.');
	}
	const firstTeam = getTeam(input.snapshot, input.p1TeamId);
	const secondTeam = getTeam(input.snapshot, input.p2TeamId);
	const first = sampleCohesiveTeam({
		snapshot: input.snapshot, teamId: firstTeam.id, opponentTeamId: secondTeam.id, seed: input.p1Seed, constraints: input.p1Constraints,
	});
	const second = sampleCohesiveTeam({
		snapshot: input.snapshot, teamId: secondTeam.id, opponentTeamId: firstTeam.id, seed: input.p2Seed, constraints: input.p2Constraints,
	});
	return buildFoulPlayArtifactsFromSamples({
		snapshot: input.snapshot, p1TeamId: input.p1TeamId, p2TeamId: input.p2TeamId,
		p1Sample: first, p2Sample: second, maxCandidatesPerSpecies,
	});
}

/** Builds beliefs and private Showdown teams from already-frozen scenario variants. */
export function buildFoulPlayArtifactsFromSamples(input: BuildFoulPlayArtifactsFromSamplesInput): FoulPlayMatchArtifacts {
	const maxCandidatesPerSpecies = input.maxCandidatesPerSpecies ?? 12;
	if (!Number.isInteger(maxCandidatesPerSpecies) || maxCandidatesPerSpecies < 1) {
		throw new Error('maxCandidatesPerSpecies must be a positive integer.');
	}
	const firstTeam = getTeam(input.snapshot, input.p1TeamId);
	const secondTeam = getTeam(input.snapshot, input.p2TeamId);
	const first = input.p1Sample;
	const second = input.p2Sample;
	if (first.snapshotHash !== second.snapshotHash) throw new Error('Foul Play samples must use one shared snapshot.');
	const belief = buildBelief(input.snapshot, first, second, firstTeam, secondTeam, maxCandidatesPerSpecies);
	return {
		belief,
		teams: {
			[firstTeam.id]: {
				id: firstTeam.id, name: firstTeam.name, packed: Teams.pack(first.team), exported: Teams.export(first.team), sample: first,
			},
			[secondTeam.id]: {
				id: secondTeam.id, name: secondTeam.name, packed: Teams.pack(second.team), exported: Teams.export(second.team), sample: second,
			},
		},
	};
}
