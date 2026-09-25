import { toID } from '../../sim/dex';
import { PRNG, type PRNGSeed } from '../../sim/prng';
import { TeamValidator } from '../../sim/team-validator';
import type { PokemonSet } from '../../sim/teams';
import { PDL_FORMAT_ID } from '../format';
import { validatePdlTeam } from '../validate-team';
import { generateSetCandidates } from './candidates';
import { normalizeTeamSelectionConstraints, resolveTeraReferences, validateTeamSelectionConstraints } from './constraints';
import {
	scoreCohesiveTeam,
	type CandidateCohesionScore,
	type LegalSetCandidate,
	type TeamCohesionScore,
} from './cohesion';
import { hashSamplingSnapshot } from './snapshot';
import type { NormalizedPdlTeamSelectionConstraints, PdlSamplingRosterTeam, PdlSamplingSnapshot, PdlTeamSelectionConstraints } from './types';

export interface SampleCohesiveTeamInput {
	readonly snapshot: PdlSamplingSnapshot;
	readonly teamId: string;
	readonly opponentTeamId: string;
	readonly seed: PRNGSeed;
	readonly constraints?: PdlTeamSelectionConstraints;
}

export interface CohesiveTeamSample {
	readonly team: PokemonSet[];
	readonly sampledSpecies: string[];
	readonly candidateScores: readonly CandidateCohesionScore[];
	readonly teamScore: TeamCohesionScore;
	readonly samplerSeed: PRNGSeed;
	readonly snapshotHash: string;
	readonly constraints: NormalizedPdlTeamSelectionConstraints;
}

interface CandidatePool {
	readonly speciesId: string;
	readonly candidates: readonly LegalSetCandidate[];
}

interface ScoredSelection {
	readonly candidates: readonly LegalSetCandidate[];
	readonly candidateScores: readonly CandidateCohesionScore[];
	readonly teamScore: TeamCohesionScore;
	readonly key: string;
}

const TEAM_SIZE = 6;
const MAX_CANDIDATES_PER_SPECIES = 2;
const MAX_PARTIALS_PER_SIZE = 256;
const MAX_RETAINED_TEAMS = 64;
const RETAINED_SCORE_WINDOW = 0.2;

function findTeam(snapshot: PdlSamplingSnapshot, teamId: string): PdlSamplingRosterTeam {
	const team = snapshot.roster.teams.find(candidate => toID(candidate.id) === toID(teamId));
	if (!team) throw new Error(`Unknown PDL team: ${teamId}.`);
	return team;
}

function candidateKey(candidate: LegalSetCandidate): string {
	const set = candidate.set;
	return [
		toID(set.species), toID(set.item), toID(set.ability), toID(set.nature), toID(set.teraType),
		...set.moves.map(toID),
	].join('|');
}

function selectionKey(candidates: readonly LegalSetCandidate[]): string {
	return candidates.map(candidateKey).join('||');
}

function lockedCandidate(set: PokemonSet): LegalSetCandidate {
	return { set: { ...set, moves: [...set.moves], evs: { ...set.evs }, ivs: { ...set.ivs } }, usageWeight: 1, source: {}, rejectionReasons: [] };
}

function legalCandidatePools(
	snapshot: PdlSamplingSnapshot, team: PdlSamplingRosterTeam, constraints: NormalizedPdlTeamSelectionConstraints
): CandidatePool[] {
	const lockedSets = new Map(constraints.lockedSets.map(set => [toID(set.species), set]));
	const pools: CandidatePool[] = [];
	for (const rosterPokemon of team.roster) {
		const speciesId = toID(rosterPokemon.species);
		if (constraints.excludedSpecies.includes(speciesId)) continue;
		const locked = lockedSets.get(speciesId);
		if (locked) {
			pools.push({ speciesId, candidates: [lockedCandidate(locked)] });
			continue;
		}
		const candidates = generateSetCandidates({
			snapshot,
			teamId: team.id,
			species: rosterPokemon.species,
		}).filter((candidate): candidate is LegalSetCandidate => !!candidate.set)
			.sort((a, b) => b.usageWeight - a.usageWeight || candidateKey(a).localeCompare(candidateKey(b)))
			.slice(0, MAX_CANDIDATES_PER_SPECIES);
		if (candidates.length) pools.push({ speciesId, candidates });
	}
	return pools;
}

function scoreSelection(
	snapshot: PdlSamplingSnapshot,
	opponent: PdlSamplingRosterTeam,
	candidates: readonly LegalSetCandidate[]
): ScoredSelection {
	const score = scoreCohesiveTeam({ snapshot, candidates, opponentRoster: opponent.roster });
	return { candidates, ...score, key: selectionKey(candidates) };
}

function compareSelections(left: ScoredSelection, right: ScoredSelection): number {
	return right.teamScore.total - left.teamScore.total || left.key.localeCompare(right.key);
}

function buildBoundedSelections(
	snapshot: PdlSamplingSnapshot,
	opponent: PdlSamplingRosterTeam,
	pools: readonly CandidatePool[],
	requiredSpecies: readonly string[]
): ScoredSelection[] {
	let selections: readonly LegalSetCandidate[][] = [[]];
	for (let poolIndex = 0; poolIndex < pools.length; poolIndex++) {
		const pool = pools[poolIndex];
		const remainingSpecies = pools.length - poolIndex - 1;
		const next: LegalSetCandidate[][] = [];
		for (const selection of selections) {
			if (!requiredSpecies.includes(pool.speciesId) && selection.length + remainingSpecies >= TEAM_SIZE) next.push([...selection]);
			if (selection.length < TEAM_SIZE) {
				for (const candidate of pool.candidates) next.push([...selection, candidate]);
			}
		}

		const retained: LegalSetCandidate[][] = [];
		for (let size = 0; size <= TEAM_SIZE; size++) {
			retained.push(...next.filter(selection => selection.length === size)
				.map(selection => scoreSelection(snapshot, opponent, selection))
				.sort(compareSelections)
				.slice(0, MAX_PARTIALS_PER_SIZE)
				.map(selection => [...selection.candidates]));
		}
		selections = retained;
	}
	return selections.filter(selection => selection.length === TEAM_SIZE && requiredSpecies.every(species => selection.some(candidate => toID(candidate.set.species) === species)))
		.map(selection => scoreSelection(snapshot, opponent, selection));
}

function toLeagueSnapshot(snapshot: PdlSamplingSnapshot) {
	return {
		teams: snapshot.roster.teams.map(team => ({
			id: team.id,
			name: team.name,
			draftedTeraTypes: [...team.draftedTeraTypes],
			roster: team.roster.map(pokemon => ({ ...pokemon })),
		})),
	};
}

function clonedTeam(candidates: readonly LegalSetCandidate[]): PokemonSet[] {
	return candidates.map(candidate => ({
		...candidate.set,
		moves: [...candidate.set.moves],
		evs: { ...candidate.set.evs },
		ivs: { ...candidate.set.ivs },
	}));
}

function isLegalCompleteTeam(
	snapshot: PdlSamplingSnapshot,
	team: PdlSamplingRosterTeam,
	selection: ScoredSelection
): boolean {
	const sets = clonedTeam(selection.candidates);
	if (validatePdlTeam({ league: toLeagueSnapshot(snapshot), teamId: team.id, team: sets }).length) return false;
	return !(TeamValidator.get(PDL_FORMAT_ID).validateTeam(sets) || []).length;
}

function weightedSample(prng: PRNG, selections: readonly ScoredSelection[]): ScoredSelection {
	const bestScore = selections[0].teamScore.total;
	const retained = selections.filter((selection, index) =>
		index < MAX_RETAINED_TEAMS && selection.teamScore.total >= bestScore - RETAINED_SCORE_WINDOW
	);
	const weights = retained.map(selection => Math.exp((selection.teamScore.total - bestScore) * 8));
	const totalWeight = weights.reduce((total, weight) => total + weight, 0);
	let target = prng.random() * totalWeight;
	for (let index = 0; index < retained.length; index++) {
		target -= weights[index];
		if (target < 0) return retained[index];
	}
	return retained[retained.length - 1];
}

/** Samples exactly six legal observed candidates without inspecting opponent usage data. */
export function sampleCohesiveTeam(input: SampleCohesiveTeamInput): CohesiveTeamSample {
	const team = findTeam(input.snapshot, input.teamId);
	const opponent = findTeam(input.snapshot, input.opponentTeamId);
	const constraints = resolveTeraReferences({ team, constraints: normalizeTeamSelectionConstraints(input.constraints) });
	validateTeamSelectionConstraints({ snapshot: input.snapshot, team, constraints });
	const pools = legalCandidatePools(input.snapshot, team, constraints);
	if (pools.length < TEAM_SIZE) {
		throw new Error(
			`Cannot sample ${team.name}: fewer than six roster species have legal observed candidates ` +
			`(${pools.length} available).`
		);
	}

	const selections = buildBoundedSelections(input.snapshot, opponent, pools, constraints.requiredSpecies)
		.filter(selection => isLegalCompleteTeam(input.snapshot, team, selection))
		.sort(compareSelections);
	if (!selections.length) throw new Error(`Cannot sample ${team.name}: no legal complete six-Pokémon team was found.`);

	const prng = new PRNG(input.seed);
	const sampled = weightedSample(prng, selections);
	return {
		team: clonedTeam(sampled.candidates),
		sampledSpecies: sampled.candidates.map(candidate => toID(candidate.set.species)),
		candidateScores: sampled.candidateScores,
		teamScore: sampled.teamScore,
		samplerSeed: prng.startingSeed,
		snapshotHash: hashSamplingSnapshot(input.snapshot),
		constraints,
	};
}
