'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { createTrialArtifact, finalizeTrialArtifact, writePrivateGroundTruthAudit } = require('../../../dist/pdl/batch/artifacts');

describe('PDL local simulation trial artifacts', () => {
	it('writes immutable battle inputs before recording a terminal result', () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), 'pdl-trial-artifact-'));
		const artifact = createTrialArtifact({
			outputDirectory,
			trialId: 'pair-0001-forward',
			manifest: {
				schemaVersion: 1,
				pairId: 'pair-0001',
				side: 'forward',
				p1: { teamId: 'adam', packed: 'Adam-packed', exported: 'Adam export' },
				p2: { teamId: 'connor', packed: 'Connor-packed', exported: 'Connor export' },
			},
			belief: { schemaVersion: 1, snapshot: { id: 'fixture', source: 'fixture', hash: 'abc' }, teams: {}, sets: {} },
		});

		assert.equal(existsSync(artifact.p1BeliefPath), true);
		assert.equal(existsSync(artifact.p2BeliefPath), true);
		assert.equal(readFileSync(artifact.p1TeamPath, 'utf8'), 'Adam export');
		assert.equal(readFileSync(artifact.p2TeamPath, 'utf8'), 'Connor export');
		assert.equal(existsSync(artifact.resultPath), false);
		const publicManifest = JSON.parse(readFileSync(artifact.manifestPath, 'utf8'));
		assert.equal(publicManifest.metadata.runtime.id, 'pdl-s4-foul-play-showdown-local-v2');
		assert.equal(publicManifest.schemaVersion, 2);
		assert.equal(JSON.stringify(publicManifest).includes('Adam-packed'), false);
		assert.equal(JSON.stringify(publicManifest).includes('Adam export'), false);
		assert.equal(existsSync(artifact.privateGroundTruthAuditPath), false);

		finalizeTrialArtifact(artifact, { status: 'completed', winnerTeamId: 'adam', failureReason: null });
		writePrivateGroundTruthAudit(artifact);

		assert.deepEqual(JSON.parse(readFileSync(artifact.resultPath, 'utf8')), {
			status: 'completed', winnerTeamId: 'adam', failureReason: null,
		});
		const groundTruth = JSON.parse(readFileSync(artifact.privateGroundTruthAuditPath, 'utf8'));
		assert.equal(groundTruth.writtenAfterAgentShutdown, true);
		assert.equal(groundTruth.p2.packed, 'Connor-packed');
	});
});
