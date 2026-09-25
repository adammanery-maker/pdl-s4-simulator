import { createHash } from 'crypto';
import type { PRNGSeed } from '../../sim/prng';
import { Teams } from '../../sim/teams';
import { sampleCohesiveTeam } from '../sampling/sample-team';
import { toID } from '../../sim/dex';
import type { NormalizedPdlTeamSelectionConstraints, PdlSamplingRosterTeam, PdlSamplingSnapshot } from '../sampling/types';
import { normalizeExperimentVariant } from './parse-plan';
import { applyTemporaryFreeAgents } from './free-agents';
import type { ExperimentPlan, ExperimentSideInput, ResolvedExperimentPlan, ResolvedExperimentVariant } from './types';

const MAX_VARIANT_ATTEMPTS = 64;
const TEAM_SIZE = 6;

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function samplerSeed(planHash: string, side: string, variantId: string, attempt: number): PRNGSeed {
	const hash = sha256(`${planHash}|${side}|${variantId}|${attempt}`);
	return `gen5,${hash.slice(0, 8)},${hash.slice(8, 16)},${hash.slice(16, 24)}`;
}

/** Returns the exact live-snapshot id used as a key by battle artifacts. */
export function canonicalTeamId(team: PdlSamplingRosterTeam, requestedId: string): string {
	if (toID(team.id) !== toID(requestedId)) throw new Error(`Unknown PDL team: ${requestedId}.`);
	return toID(team.id);
}

function combinations(values: readonly string[], size: number, start = 0, current: string[] = []): string[][] {
	if (current.length === size) return [[...current]];
	const results: string[][] = [];
	for (let index = start; index <= values.length - (size - current.length); index++) {
		current.push(values[index]);
		results.push(...combinations(values, size, index + 1, current));
		current.pop();
	}
	return results;
}

/** Forces a different legal species six around a variant's fixed core before set scoring. */
export function diversifiedConstraints(input: {
	readonly team: PdlSamplingRosterTeam;
	readonly constraints: NormalizedPdlTeamSelectionConstraints;
	readonly selectionIndex: number;
}): NormalizedPdlTeamSelectionConstraints {
	const core = input.constraints.requiredSpecies;
	const additionalCount = TEAM_SIZE - core.length;
	if (additionalCount < 0) throw new Error('Experiment variant requires more than six Pokémon.');
	const choices = input.team.roster
		.map(pokemon => toID(pokemon.species))
		.filter(species => !core.includes(species) && !input.constraints.excludedSpecies.includes(species))
		.sort();
	const alternatives = combinations(choices, additionalCount);
	if (!alternatives.length) throw new Error(`Cannot form a six-Pokémon experiment variant from ${input.team.name}'s current roster and constraints.`);
	return {
		requiredSpecies: [...core, ...alternatives[input.selectionIndex % alternatives.length]],
		excludedSpecies: input.constraints.excludedSpecies,
		lockedSets: input.constraints.lockedSets,
		teraReferences: input.constraints.teraReferences,
	};
}

function resolveSide(input: {
	readonly planHash: string;
	readonly snapshot: PdlSamplingSnapshot;
	readonly side: 'left' | 'right';
	readonly team: ExperimentSideInput;
	readonly opponentTeamId: string;
}): ResolvedExperimentVariant[] {
	const seenPacked = new Set<string>();
	const rosterTeam = input.snapshot.roster.teams.find(team => toID(team.id) === toID(input.team.teamId));
	if (!rosterTeam) throw new Error(`Unknown PDL team: ${input.team.teamId}.`);
	const teamId = canonicalTeamId(rosterTeam, input.team.teamId);
	const resolved: ResolvedExperimentVariant[] = [];
	for (let variantIndex = 0; variantIndex < input.team.variants.length; variantIndex++) {
		const rawVariant = input.team.variants[variantIndex];
		const normalized = normalizeExperimentVariant(rawVariant);
		const variantSnapshot = rawVariant.freeAgents?.length
			? applyTemporaryFreeAgents({ snapshot: input.snapshot, teamId, additions: rawVariant.freeAgents })
			: input.snapshot;
		const variantRosterTeam = variantSnapshot.roster.teams.find(team => toID(team.id) === teamId)!;
		let found: ResolvedExperimentVariant | undefined;
		for (let attempt = 0; attempt < MAX_VARIANT_ATTEMPTS; attempt++) {
			const seed = samplerSeed(input.planHash, input.side, normalized.id, attempt);
			const constraints = diversifiedConstraints({ team: variantRosterTeam, constraints: normalized.constraints, selectionIndex: variantIndex + attempt });
			const sampled = sampleCohesiveTeam({
				snapshot: variantSnapshot, teamId, opponentTeamId: input.opponentTeamId, seed,
				constraints,
			});
			const packed = Teams.pack(sampled.team);
			if (seenPacked.has(packed)) continue;
			found = {
				id: normalized.id, teamId, constraints: sampled.constraints, samplerSeed: seed,
				team: sampled.team, packed, exported: Teams.export(sampled.team), sample: sampled,
				temporaryFreeAgents: rawVariant.freeAgents || [],
			};
			seenPacked.add(packed);
			break;
		}
		if (!found) {
			throw new Error(`Could not produce a distinct legal variant for ${teamId}/${rawVariant.id} after ${MAX_VARIANT_ATTEMPTS} attempts.`);
		}
		resolved.push(found);
	}
	return resolved;
}

/** Freezes each named variant into one distinct, PDL-legal packed six before scheduling battles. */
export function resolveExperimentVariants(input: {
	readonly plan: ExperimentPlan;
	readonly snapshot: PdlSamplingSnapshot;
}): ResolvedExperimentPlan {
	const planHash = sha256(JSON.stringify(input.plan));
	return {
		schemaVersion: 1, planHash, sourcePlan: input.plan,
		left: resolveSide({ planHash, snapshot: input.snapshot, side: 'left', team: input.plan.teams.left, opponentTeamId: input.plan.teams.right.teamId }),
		right: resolveSide({ planHash, snapshot: input.snapshot, side: 'right', team: input.plan.teams.right, opponentTeamId: input.plan.teams.left.teamId }),
	};
}
