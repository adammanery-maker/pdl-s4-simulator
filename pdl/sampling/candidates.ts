import { Dex, toID } from '../../sim/dex';
import { TeamValidator } from '../../sim/team-validator';
import type { PokemonSet } from '../../sim/teams';
import { PDL_FORMAT_ID } from '../format';
import type { PdlLeagueSnapshot } from '../types';
import { validatePdlTeam } from '../validate-team';
import type {
	GenerateSetCandidatesInput,
	PdlSamplingJsonValue,
	PdlSamplingRosterTeam,
	PdlSamplingUsageChoice,
	PdlSetCandidateSource,
	SetCandidate,
} from './types';

const MAX_COMPONENT_CHOICES = 3;
const MAX_MOVE_CHOICES = 6;
const STAT_IDS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;

type RequiredComponent = 'moves' | 'abilities' | 'items' | 'natures' | 'spreads';

function toLeagueSnapshot(input: GenerateSetCandidatesInput['snapshot']): PdlLeagueSnapshot {
	return {
		teams: input.roster.teams.map(team => ({
			id: team.id,
			name: team.name,
			draftedTeraTypes: [...team.draftedTeraTypes],
			roster: team.roster.map(pokemon => ({ ...pokemon })),
		})),
	};
}

function topObservedChoices(
	choices: readonly PdlSamplingUsageChoice[] | undefined,
	limit: number
): readonly PdlSamplingUsageChoice[] {
	if (!choices) return [];

	const uniqueChoices = new Map<string, PdlSamplingUsageChoice>();
	for (const choice of choices) {
		const id = toID(choice.name);
		if (!id) continue;
		const existing = uniqueChoices.get(id);
		if (!existing || choice.weight > existing.weight) uniqueChoices.set(id, choice);
	}
	return [...uniqueChoices.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
}

function readStats(value: PdlSamplingJsonValue | undefined): PokemonSet['evs'] | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const source = value as { readonly [key: string]: PdlSamplingJsonValue };
	const stats = {} as PokemonSet['evs'];
	for (const stat of STAT_IDS) {
		if (typeof source[stat] !== 'number' || !Number.isFinite(source[stat])) return undefined;
		stats[stat] = source[stat];
	}
	return stats;
}

function createSet(
	speciesName: string,
	moves: readonly PdlSamplingUsageChoice[],
	ability: PdlSamplingUsageChoice,
	item: PdlSamplingUsageChoice,
	nature: PdlSamplingUsageChoice,
	spread: PdlSamplingUsageChoice,
	teraType?: PdlSamplingUsageChoice
): { set?: PokemonSet, reason?: string } {
	const evs = readStats(spread.evs);
	if (!evs) return { reason: 'Observed spread is missing complete EV values.' };
	const species = Dex.species.get(speciesName);
	if (!species.exists) return { reason: `Observed species ${speciesName} is invalid.` };

	return {
		set: {
			name: species.name,
			species: species.name,
			item: item.name,
			ability: ability.name,
			nature: nature.name,
			moves: moves.map(move => move.name),
			gender: '',
			evs,
			ivs: readStats(spread.ivs) || { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
			level: 100,
		teraType: teraType?.name || '',
		},
	};
}

function validateCandidate(
	set: PokemonSet,
	league: PdlLeagueSnapshot,
	team: PdlSamplingRosterTeam
): string[] {
	if (team.roster.length < 6) {
		return [`${team.name}'s roster has fewer than six Pokémon, so PDL candidate validation cannot run.`];
	}

	const validationTeam = [
		set,
		...team.roster
			.filter(pokemon => toID(pokemon.species) !== toID(set.species))
			.slice(0, 5)
			.map(pokemon => ({ species: pokemon.species } as PokemonSet)),
	];
	const pdlErrors = validatePdlTeam({ league, teamId: team.id, team: validationTeam });
	const showdownSet = {
		...set,
		moves: [...set.moves],
		evs: { ...set.evs },
		ivs: { ...set.ivs },
	};
	const showdownErrors = TeamValidator.get(PDL_FORMAT_ID).validateSet(showdownSet, {}) || [];
	return [...pdlErrors, ...showdownErrors];
}

function sourceFor(
	moves: readonly PdlSamplingUsageChoice[], ability: PdlSamplingUsageChoice, item: PdlSamplingUsageChoice,
	nature: PdlSamplingUsageChoice, spread: PdlSamplingUsageChoice, teraType?: PdlSamplingUsageChoice
): PdlSetCandidateSource {
	return { moves, ability, item, nature, spread, teraType };
}

function usageWeight(source: PdlSetCandidateSource): number {
	const choices = [source.ability, source.item, source.nature, source.spread, ...(source.moves || [])];
	return choices.reduce((weight, choice) => weight * (choice?.weight || 0), source.teraType?.weight || 1);
}

function rejectedCandidate(reason: string, source: PdlSetCandidateSource = {}): SetCandidate {
	return { usageWeight: 0, source, rejectionReasons: [reason] };
}

function distinctMoveCombinations(moves: readonly PdlSamplingUsageChoice[]): PdlSamplingUsageChoice[][] {
	const combinations: PdlSamplingUsageChoice[][] = [];
	for (let first = 0; first < moves.length - 3; first++) {
		for (let second = first + 1; second < moves.length - 2; second++) {
			for (let third = second + 1; third < moves.length - 1; third++) {
				for (let fourth = third + 1; fourth < moves.length; fourth++) {
					combinations.push([moves[first], moves[second], moves[third], moves[fourth]]);
				}
			}
		}
	}
	return combinations;
}

/**
 * Creates bounded, complete candidate sets from observed snapshot components.
 * Missing source data and all-illegal combinations are returned as rejection records.
 */
export function generateSetCandidates(input: GenerateSetCandidatesInput): SetCandidate[] {
	const team = input.snapshot.roster.teams.find(candidate => toID(candidate.id) === toID(input.teamId));
	if (!team) return [rejectedCandidate(`Unknown PDL team: ${input.teamId}.`)];

	const speciesId = toID(input.species);
	if (!team.roster.some(pokemon => toID(pokemon.species) === speciesId)) {
		return [rejectedCandidate(`${input.species} is not on ${team.name}'s current roster.`)];
	}
	const usage = input.snapshot.usageBySpecies[speciesId];
	if (!usage) return [rejectedCandidate(`Missing observed usage data for ${input.species}.`)];

	const choices: Record<RequiredComponent, readonly PdlSamplingUsageChoice[]> = {
		moves: topObservedChoices(usage.moves, MAX_MOVE_CHOICES),
		abilities: topObservedChoices(usage.abilities, MAX_COMPONENT_CHOICES),
		items: topObservedChoices(usage.items, MAX_COMPONENT_CHOICES),
		natures: topObservedChoices(usage.natures, MAX_COMPONENT_CHOICES),
		spreads: topObservedChoices(usage.spreads, MAX_COMPONENT_CHOICES),
	};
	for (const component of Object.keys(choices) as RequiredComponent[]) {
		if (!choices[component].length) return [rejectedCandidate(`Missing observed ${component} for ${input.species}.`)];
	}

	const moveCombinations = distinctMoveCombinations(choices.moves);
	if (!moveCombinations.length) {
		return [rejectedCandidate(`At least four distinct observed moves are required for ${input.species}.`, { moves: choices.moves })];
	}

	const league = toLeagueSnapshot(input.snapshot);
	const candidates: SetCandidate[] = [];
	const rejectionReasons = new Set<string>();
	const rosterPokemon = team.roster.find(pokemon => toID(pokemon.species) === speciesId)!;
	const teraTypes: readonly (PdlSamplingUsageChoice | undefined)[] = rosterPokemon.cost <= 4
		? [undefined, ...topObservedChoices(usage.teraTypes, MAX_COMPONENT_CHOICES)]
		: [undefined];
	for (const moves of moveCombinations) {
		for (const ability of choices.abilities) {
			for (const item of choices.items) {
				for (const nature of choices.natures) {
					for (const spread of choices.spreads) {
						for (const teraType of teraTypes) {
							const source = sourceFor(moves, ability, item, nature, spread, teraType);
							const created = createSet(input.species, moves, ability, item, nature, spread, teraType);
							if (!created.set) {
								rejectionReasons.add(created.reason!);
								continue;
							}
							const errors = validateCandidate(created.set, league, team);
							if (errors.length) {
								for (const error of errors) rejectionReasons.add(error);
								continue;
							}
							candidates.push({ set: created.set, usageWeight: usageWeight(source), source, rejectionReasons: [] });
						}
					}
				}
			}
		}
	}

	if (candidates.length) return candidates;
	return [{
		usageWeight: 0,
		source: { moves: choices.moves },
		rejectionReasons: [...rejectionReasons].sort(),
	}];
}
