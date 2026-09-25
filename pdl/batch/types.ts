import type { FoulPlayBeliefData } from '../sampling/foul-play-export';

export type TrialStatus = 'completed' | 'tied' | 'rejected' | 'failed' | 'timed_out';

export interface TrialSideArtifact {
	readonly teamId: string;
	readonly packed: string;
	readonly exported: string;
	readonly teraCaptains?: readonly string[];
}

export interface TrialManifest {
	readonly schemaVersion: 1;
	readonly pairId: string;
	readonly side: 'forward' | 'reverse';
	readonly p1: TrialSideArtifact;
	readonly p2: TrialSideArtifact;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TrialResult {
	readonly status: TrialStatus;
	readonly winnerTeamId: string | null;
	readonly failureReason: string | null;
}

export interface TrialArtifact {
	readonly trialId: string;
	readonly directory: string;
	readonly manifestPath: string;
	readonly p1PrivateDirectory: string;
	readonly p2PrivateDirectory: string;
	readonly p1BeliefPath: string;
	readonly p2BeliefPath: string;
	readonly p1TeamPath: string;
	readonly p2TeamPath: string;
	readonly p1ProtocolPath: string;
	readonly p2ProtocolPath: string;
	readonly p1LogPath: string;
	readonly p2LogPath: string;
	readonly showdownLogPath: string;
	readonly resultPath: string;
	readonly publicProtocolPath: string;
	readonly p2PublicProtocolPath: string;
	readonly auditPath: string;
	readonly networkAuditPath: string;
	readonly p1NetworkAuditPath: string;
	readonly p2NetworkAuditPath: string;
	readonly privateGroundTruthAuditPath: string;
	readonly manifest: TrialManifest;
}

export interface CreateTrialArtifactInput {
	readonly outputDirectory: string;
	readonly trialId: string;
	readonly manifest: TrialManifest;
	readonly belief?: FoulPlayBeliefData;
	readonly p1Belief?: FoulPlayBeliefData;
	readonly p2Belief?: FoulPlayBeliefData;
}
