export type PdlSamplingJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly PdlSamplingJsonValue[]
	| { readonly [key: string]: PdlSamplingJsonValue };

export interface PdlSamplingRosterPokemon {
	readonly species: string;
	readonly cost: number;
}

export interface PdlSamplingRosterTeam {
	readonly id: string;
	readonly name: string;
	readonly draftedTeraTypes: readonly string[];
	readonly roster: readonly PdlSamplingRosterPokemon[];
}

export interface PdlSamplingRosterSnapshot {
	readonly teams: readonly PdlSamplingRosterTeam[];
}

export interface PdlSamplingAvailablePokemon {
	readonly species: string;
	readonly cost: number;
}

export interface PdlSamplingUsageChoice {
	readonly name: string;
	readonly weight: number;
	readonly [key: string]: PdlSamplingJsonValue;
}

export interface PdlSpeciesUsage {
	readonly [component: string]: readonly PdlSamplingUsageChoice[];
}

export interface PdlSamplingSnapshot {
	readonly id: string;
	readonly sourceId: string;
	readonly roster: PdlSamplingRosterSnapshot;
	readonly availablePokemon: readonly PdlSamplingAvailablePokemon[];
	readonly usageBySpecies: Readonly<Record<string, PdlSpeciesUsage>>;
}

export interface PdlSamplingSnapshotInput {
	id: string;
	sourceId: string;
	roster: {
		teams: Array<{
			id: string;
			name: string;
			draftedTeraTypes: string[];
			roster: Array<{ species: string; cost: number }>;
		}>;
	};
	availablePokemon?: Array<{ species: string; cost: number }>;
	usageBySpecies: Record<string, Record<string, Array<PdlSamplingUsageChoice>>>;
}

/**
 * Explicit team-selection instructions for a single sampled six. These are
 * local-run constraints only: they never alter the frozen PDL roster snapshot.
 */
export interface PdlTeamSelectionConstraints {
	readonly requiredSpecies?: readonly string[];
	readonly excludedSpecies?: readonly string[];
	readonly lockedSets?: readonly import('../../sim/teams').PokemonSet[];
	/** Informational declared Tera types; never grants a Tera battle action. */
	readonly teraReferences?: Readonly<Record<string, string>>;
}

export interface NormalizedPdlTeamSelectionConstraints {
	readonly requiredSpecies: readonly string[];
	readonly excludedSpecies: readonly string[];
	readonly lockedSets: readonly import('../../sim/teams').PokemonSet[];
	readonly teraReferences: Readonly<Record<string, string>>;
}

export interface GenerateSetCandidatesInput {
	readonly snapshot: PdlSamplingSnapshot;
	readonly teamId: string;
	readonly species: string;
}

export interface PdlSetCandidateSource {
	readonly moves?: readonly PdlSamplingUsageChoice[];
	readonly ability?: PdlSamplingUsageChoice;
	readonly item?: PdlSamplingUsageChoice;
	readonly nature?: PdlSamplingUsageChoice;
	readonly spread?: PdlSamplingUsageChoice;
	readonly teraType?: PdlSamplingUsageChoice;
}

export interface SetCandidate {
	readonly set?: import('../../sim/teams').PokemonSet;
	readonly usageWeight: number;
	readonly source: PdlSetCandidateSource;
	readonly rejectionReasons: readonly string[];
}
