import { Dex, toID } from '../../sim/dex';
import type { PokemonSet } from '../../sim/teams';
import type {
	PdlSamplingRosterPokemon,
	PdlSamplingSnapshot,
	SetCandidate,
} from './types';

export const COHESION_COMPONENT_NAMES = [
	'usage',
	'roleCoverage',
	'hazardsRemoval',
	'speedControl',
	'physicalSpecialBalance',
	'defensiveTyping',
	'teammateAffinity',
	'publicRosterMatchupCoverage',
] as const;

export type CohesionComponentName = typeof COHESION_COMPONENT_NAMES[number];
export type CohesionComponents = Record<CohesionComponentName, number>;

export interface LegalSetCandidate extends SetCandidate {
	readonly set: PokemonSet;
}

export interface CandidateCohesionScore {
	readonly species: string;
	readonly usageWeight: number;
	readonly components: CohesionComponents;
	readonly total: number;
}

export interface TeamCohesionScore {
	readonly components: CohesionComponents;
	readonly total: number;
}

export interface ScoreCohesiveTeamInput {
	readonly snapshot: PdlSamplingSnapshot;
	readonly candidates: readonly LegalSetCandidate[];
	readonly opponentRoster: readonly PdlSamplingRosterPokemon[];
}

export interface CohesiveTeamScore {
	readonly candidateScores: readonly CandidateCohesionScore[];
	readonly teamScore: TeamCohesionScore;
}

const ATTACK_TYPES = [
	'Bug', 'Dark', 'Dragon', 'Electric', 'Fairy', 'Fighting', 'Fire', 'Flying', 'Ghost',
	'Grass', 'Ground', 'Ice', 'Normal', 'Poison', 'Psychic', 'Rock', 'Steel', 'Water',
] as const;
const HAZARD_MOVES = new Set(['ceaselessedge', 'spikes', 'stealthrock', 'stickyweb', 'stoneaxe', 'toxicspikes']);
const REMOVAL_MOVES = new Set(['courtchange', 'defog', 'mortalspin', 'rapidspin', 'tidyup']);
const SPEED_CONTROL_MOVES = new Set([
	'electroweb', 'glare', 'icywind', 'nuzzle', 'stickyweb', 'tailwind', 'thunderwave', 'trickroom',
]);
const RECOVERY_MOVES = new Set([
	'aquaring', 'healorder', 'junglehealing', 'lifedew', 'milkdrink', 'moonlight', 'morningsun',
	'painsplit', 'recover', 'rest', 'roost', 'shoreup', 'slackoff', 'softboiled', 'strengthsap', 'synthesis',
]);

// Team components are normalized to [0, 1]. These weights deliberately favor
// observed usage while leaving most of the score to whole-team cohesion.
const COMPONENT_WEIGHTS: Readonly<CohesionComponents> = {
	usage: 0.18,
	roleCoverage: 0.14,
	hazardsRemoval: 0.14,
	speedControl: 0.12,
	physicalSpecialBalance: 0.10,
	defensiveTyping: 0.12,
	teammateAffinity: 0.10,
	publicRosterMatchupCoverage: 0.10,
};

interface CandidateFacts {
	readonly physical: boolean;
	readonly special: boolean;
	readonly support: boolean;
	readonly defensive: boolean;
	readonly hazard: boolean;
	readonly removal: boolean;
	readonly speedControl: number;
	readonly defensiveTyping: number;
	readonly matchupCoverage: number;
}

function clamp(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function blankComponents(): CohesionComponents {
	return {
		usage: 0,
		roleCoverage: 0,
		hazardsRemoval: 0,
		speedControl: 0,
		physicalSpecialBalance: 0,
		defensiveTyping: 0,
		teammateAffinity: 0,
		publicRosterMatchupCoverage: 0,
	};
}

function weightedTotal(components: CohesionComponents): number {
	return rounded(COHESION_COMPONENT_NAMES.reduce(
		(total, component) => total + components[component] * COMPONENT_WEIGHTS[component], 0
	));
}

function moveFacts(set: PokemonSet) {
	const moves = set.moves.map(moveName => Dex.moves.get(moveName));
	return {
		moves,
		physical: moves.some(move => move.category === 'Physical'),
		special: moves.some(move => move.category === 'Special'),
		support: moves.some(move => move.category === 'Status'),
		hazard: moves.some(move => HAZARD_MOVES.has(move.id)),
		removal: moves.some(move => REMOVAL_MOVES.has(move.id)),
	};
}

function candidateFacts(set: PokemonSet, opponentRoster: readonly PdlSamplingRosterPokemon[]): CandidateFacts {
	const species = Dex.species.get(set.species);
	const facts = moveFacts(set);
	const evs = set.evs || {};
	const defensive = facts.moves.some(move => RECOVERY_MOVES.has(move.id)) ||
		(evs.hp || 0) + Math.max(evs.def || 0, evs.spd || 0) >= 500;
	const hasPriority = facts.moves.some(move => move.priority > 0 && move.category !== 'Status');
	const hasSpeedMove = facts.moves.some(move => SPEED_CONTROL_MOVES.has(move.id));
	const speedControl = clamp(
		(hasPriority ? 0.4 : 0) + (hasSpeedMove ? 0.4 : 0) +
		(toID(set.item) === 'choicescarf' ? 0.35 : 0) + (species.baseStats.spe >= 110 ? 0.25 : 0)
	);
	const resistedTypes = ATTACK_TYPES.filter(type =>
		!Dex.getImmunity(type, species) || Dex.getEffectiveness(type, species) < 0
	).length;
	const coveredOpponents = opponentRoster.filter(opponent => {
		const target = Dex.species.get(opponent.species);
		return facts.moves.some(move => move.category !== 'Status' &&
			Dex.getImmunity(move.type, target) && Dex.getEffectiveness(move.type, target) > 0);
	}).length;

	return {
		physical: facts.physical,
		special: facts.special,
		support: facts.support,
		defensive,
		hazard: facts.hazard,
		removal: facts.removal,
		speedControl,
		defensiveTyping: resistedTypes / ATTACK_TYPES.length,
		matchupCoverage: opponentRoster.length ? coveredOpponents / opponentRoster.length : 0,
	};
}

function affinityFor(
	snapshot: PdlSamplingSnapshot,
	speciesId: string,
	selectedSpecies: ReadonlySet<string>
): number {
	const teammateChoices = snapshot.usageBySpecies[speciesId]?.teammates || [];
	const totalWeight = teammateChoices.reduce((total, choice) => total + choice.weight, 0);
	if (!totalWeight) return 0;
	const selectedWeight = teammateChoices.reduce((total, choice) =>
		selectedSpecies.has(toID(choice.name)) ? total + choice.weight : total, 0);
	return clamp(selectedWeight / totalWeight);
}

function candidateComponents(
	snapshot: PdlSamplingSnapshot,
	candidate: LegalSetCandidate,
	facts: CandidateFacts,
	selectedSpecies: ReadonlySet<string>
): CohesionComponents {
	const roleCount = [facts.physical, facts.special, facts.support, facts.defensive].filter(Boolean).length;
	const attackRoleCount = Number(facts.physical) + Number(facts.special);
	return {
		usage: clamp(Math.log10(1 + candidate.usageWeight) / 18),
		roleCoverage: roleCount / 4,
		hazardsRemoval: Number(facts.hazard) * 0.5 + Number(facts.removal) * 0.5,
		speedControl: facts.speedControl,
		physicalSpecialBalance: attackRoleCount === 2 ? 1 : attackRoleCount === 1 ? 0.5 : 0,
		defensiveTyping: facts.defensiveTyping,
		teammateAffinity: affinityFor(snapshot, toID(candidate.set.species), selectedSpecies),
		publicRosterMatchupCoverage: facts.matchupCoverage,
	};
}

function defensiveTeamCoverage(candidates: readonly LegalSetCandidate[]): number {
	if (!candidates.length) return 0;
	const coverage = ATTACK_TYPES.reduce((total, type) => {
		const answers = candidates.filter(candidate => {
			const species = Dex.species.get(candidate.set.species);
			return !Dex.getImmunity(type, species) || Dex.getEffectiveness(type, species) < 0;
		}).length;
		return total + Math.min(answers, 2) / 2;
	}, 0);
	return coverage / ATTACK_TYPES.length;
}

function publicRosterTeamCoverage(
	candidates: readonly LegalSetCandidate[],
	opponentRoster: readonly PdlSamplingRosterPokemon[]
): number {
	if (!opponentRoster.length) return 0;
	const covered = opponentRoster.filter(opponent => {
		const target = Dex.species.get(opponent.species);
		return candidates.some(candidate => candidate.set.moves.some(moveName => {
			const move = Dex.moves.get(moveName);
			return move.category !== 'Status' && Dex.getImmunity(move.type, target) &&
				Dex.getEffectiveness(move.type, target) > 0;
		}));
	}).length;
	return covered / opponentRoster.length;
}

/** Scores complete or partial candidate groups using public snapshot data only. */
export function scoreCohesiveTeam(input: ScoreCohesiveTeamInput): CohesiveTeamScore {
	if (!input.candidates.length) return { candidateScores: [], teamScore: { components: blankComponents(), total: 0 } };

	const selectedSpecies = new Set(input.candidates.map(candidate => toID(candidate.set.species)));
	const facts = input.candidates.map(candidate => candidateFacts(candidate.set, input.opponentRoster));
	const candidateScores = input.candidates.map((candidate, index): CandidateCohesionScore => {
		const components = candidateComponents(input.snapshot, candidate, facts[index], selectedSpecies);
		return {
			species: toID(candidate.set.species),
			usageWeight: candidate.usageWeight,
			components,
			total: weightedTotal(components),
		};
	});
	const roles = new Set<string>();
	for (const candidateFacts of facts) {
		if (candidateFacts.physical) roles.add('physical');
		if (candidateFacts.special) roles.add('special');
		if (candidateFacts.support) roles.add('support');
		if (candidateFacts.defensive) roles.add('defensive');
	}
	const physicalCount = facts.filter(candidate => candidate.physical).length;
	const specialCount = facts.filter(candidate => candidate.special).length;
	const attackingCount = physicalCount + specialCount;
	const components: CohesionComponents = {
		usage: candidateScores.reduce((total, score) => total + score.components.usage, 0) / candidateScores.length,
		roleCoverage: roles.size / 4,
		hazardsRemoval: Number(facts.some(candidate => candidate.hazard)) * 0.5 +
			Number(facts.some(candidate => candidate.removal)) * 0.5,
		speedControl: clamp(facts.reduce((total, candidate) => total + candidate.speedControl, 0) / 1.5),
		physicalSpecialBalance: attackingCount ? 1 - Math.abs(physicalCount - specialCount) / attackingCount : 0,
		defensiveTyping: defensiveTeamCoverage(input.candidates),
		teammateAffinity: candidateScores.reduce(
			(total, score) => total + score.components.teammateAffinity, 0
		) / candidateScores.length,
		publicRosterMatchupCoverage: publicRosterTeamCoverage(input.candidates, input.opponentRoster),
	};
	for (const component of COHESION_COMPONENT_NAMES) components[component] = rounded(clamp(components[component]));

	return { candidateScores, teamScore: { components, total: weightedTotal(components) } };
}
