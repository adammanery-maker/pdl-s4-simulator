import type { PokemonSet } from '../../sim/teams';
import type { CohesiveTeamSample } from '../sampling/sample-team';
import type { NormalizedPdlTeamSelectionConstraints, PdlTeamSelectionConstraints } from '../sampling/types';

export type ExperimentSource =
	| { readonly liveUrl: string; readonly snapshotPath?: never }
	| { readonly snapshotPath: string; readonly liveUrl?: never };

export interface ExperimentVariantInput {
	readonly id: string;
	readonly require?: readonly string[];
	readonly exclude?: readonly string[];
	readonly locks?: readonly string[];
	readonly teraReferences?: Readonly<Record<string, string>>;
	readonly freeAgents?: readonly ExperimentFreeAgentInput[];
}

export interface ExperimentFreeAgentInput {
	readonly pokemon: string;
	readonly replace?: string;
}

export interface ExperimentSideInput {
	readonly teamId: string;
	readonly variants: readonly ExperimentVariantInput[];
}

export interface ExperimentPlan {
	readonly version: 1;
	readonly source?: ExperimentSource;
	readonly teams: { readonly left: ExperimentSideInput; readonly right: ExperimentSideInput };
	readonly schedule: { readonly strategy: 'balanced-cross'; readonly totalPairs: number };
	readonly simulation: { readonly searchMs: number; readonly timeoutMs?: number; readonly foulRoot: string; readonly output: string };
}

export interface NormalizedExperimentVariant {
	readonly id: string;
	readonly constraints: NormalizedPdlTeamSelectionConstraints;
}

export interface ResolvedExperimentVariant {
	readonly id: string;
	readonly teamId: string;
	readonly constraints: NormalizedPdlTeamSelectionConstraints;
	readonly samplerSeed: string;
	readonly team: readonly PokemonSet[];
	readonly packed: string;
	readonly exported: string;
	readonly sample: CohesiveTeamSample;
	readonly temporaryFreeAgents: readonly ExperimentFreeAgentInput[];
}

export interface ResolvedExperimentPlan {
	readonly schemaVersion: 1;
	readonly planHash: string;
	readonly sourcePlan: ExperimentPlan;
	readonly left: readonly ResolvedExperimentVariant[];
	readonly right: readonly ResolvedExperimentVariant[];
}

export interface ScheduledExperimentPair {
	readonly pairId: string;
	readonly cellId: string;
	readonly leftVariantId: string;
	readonly rightVariantId: string;
}

export interface ExperimentScenarioMetadata {
	readonly leftTeamId: string;
	readonly rightTeamId: string;
	readonly leftVariantId: string;
	readonly rightVariantId: string;
	readonly cellId: string;
}

export function variantConstraints(input: ExperimentVariantInput): PdlTeamSelectionConstraints {
	return { requiredSpecies: input.require, excludedSpecies: input.exclude };
}
