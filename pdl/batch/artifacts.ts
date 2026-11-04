import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { CreateTrialArtifactInput, TrialArtifact, TrialResult } from './types';
import { CANONICAL_RUNTIME } from './runtime';

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Creates an immutable per-trial directory before any child process starts. */
export function createTrialArtifact(input: CreateTrialArtifactInput): TrialArtifact {
	if (!/^[a-z0-9-]+$/i.test(input.trialId)) throw new Error('Trial id must contain only letters, digits, and hyphens.');
	const trialsDirectory = resolve(input.outputDirectory, 'trials');
	mkdirSync(trialsDirectory, { recursive: true });
	const directory = join(trialsDirectory, input.trialId);
	mkdirSync(directory, { recursive: false });
	const p1PrivateDirectory = join(directory, 'private-p1');
	const p2PrivateDirectory = join(directory, 'private-p2');
	mkdirSync(p1PrivateDirectory, { mode: 0o700 });
	mkdirSync(p2PrivateDirectory, { mode: 0o700 });
	const manifest = {
		...input.manifest,
		metadata: { ...input.manifest.metadata, runtime: input.manifest.metadata?.runtime || CANONICAL_RUNTIME },
	};
	const artifact: TrialArtifact = {
		trialId: input.trialId,
		directory,
		manifestPath: join(directory, 'manifest.json'),
		p1PrivateDirectory,
		p2PrivateDirectory,
		p1BeliefPath: join(p1PrivateDirectory, 'belief.json'),
		p2BeliefPath: join(p2PrivateDirectory, 'belief.json'),
		p1TeamPath: join(p1PrivateDirectory, 'team.txt'),
		p2TeamPath: join(p2PrivateDirectory, 'team.txt'),
		p1ProtocolPath: join(p1PrivateDirectory, 'protocol.log'),
		p2ProtocolPath: join(p2PrivateDirectory, 'protocol.log'),
		p1DecisionBundlePath: join(p1PrivateDirectory, 'decision-bundles.jsonl'),
		p2DecisionBundlePath: join(p2PrivateDirectory, 'decision-bundles.jsonl'),
		p1LogPath: join(directory, 'p1.log'),
		p2LogPath: join(directory, 'p2.log'),
		showdownLogPath: join(directory, 'showdown.log'),
		resultPath: join(directory, 'result.json'),
		publicProtocolPath: join(directory, 'public.protocol'),
		p2PublicProtocolPath: join(directory, 'p2-public.protocol'),
		auditPath: join(directory, 'audit.json'),
		networkAuditPath: join(directory, 'offline-network-audit.log'),
		p1NetworkAuditPath: join(p1PrivateDirectory, 'offline-network-audit.log'),
		p2NetworkAuditPath: join(p2PrivateDirectory, 'offline-network-audit.log'),
		privateGroundTruthAuditPath: join(directory, 'private-ground-truth-audit.json'),
		manifest,
	};
	writeJson(artifact.manifestPath, {
		schemaVersion: 2,
		pairId: manifest.pairId,
		side: manifest.side,
		p1: { teamId: manifest.p1.teamId, teraCaptains: manifest.p1.teraCaptains },
		p2: { teamId: manifest.p2.teamId, teraCaptains: manifest.p2.teraCaptains },
		metadata: manifest.metadata,
	});
	const p1Belief = input.p1Belief || input.belief;
	const p2Belief = input.p2Belief || input.belief;
	if (!p1Belief || !p2Belief) throw new Error('Trial artifacts require beliefs for both agents.');
	writeJson(artifact.p1BeliefPath, p1Belief);
	writeJson(artifact.p2BeliefPath, p2Belief);
	writeFileSync(artifact.p1TeamPath, manifest.p1.exported, 'utf8');
	writeFileSync(artifact.p2TeamPath, manifest.p2.exported, 'utf8');
	return artifact;
}

/** Persist exact submitted sets only after both agent process trees have stopped. */
export function writePrivateGroundTruthAudit(artifact: TrialArtifact): void {
	writeJson(artifact.privateGroundTruthAuditPath, {
		schemaVersion: 1,
		trialId: artifact.trialId,
		writtenAfterAgentShutdown: true,
		p1: artifact.manifest.p1,
		p2: artifact.manifest.p2,
	});
}

/** Writes the sole terminal status after every child process has stopped. */
export function finalizeTrialArtifact(artifact: TrialArtifact, result: TrialResult): void {
	if (result.status === 'completed' && !result.winnerTeamId) {
		throw new Error('Completed trial results require a winner team id.');
	}
	if (result.status !== 'completed' && result.winnerTeamId) {
		throw new Error('Only completed trials may record a winner team id.');
	}
	if (result.status === 'tied' && result.winnerTeamId !== null) throw new Error('Tied trials cannot record a winner.');
	writeJson(artifact.resultPath, result);
}
