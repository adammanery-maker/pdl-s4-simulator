'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createTrialArtifact } = require('../../../dist/pdl/batch/artifacts');
const { buildTrialEvidence, parseDecisionEvidence, publicProtocolFromPrivateCapture } = require('../../../dist/pdl/batch/evidence');
const { foulBotName } = require('../../../dist/pdl/batch/run-trial');

const belief = { schemaVersion: 1, snapshot: { id: 'x', source: 'x', hash: 'x' }, teams: {}, sets: {} };

describe('PDL fixed-trial evidence', () => {
	it('parses a complete JSON payload from the Foul Play CustomFormatter line', () => {
		const log = 'INFO     PDL_DECISION_EVIDENCE {"aggregatePolicySupport":{"flamethrower":1},"selected":"flamethrower","turn":7}\n';

		assert.deepEqual(parseDecisionEvidence(log), [{
			aggregatePolicySupport: { flamethrower: 1 }, selected: 'flamethrower', turn: 7,
		}]);
	});

	it('retains separate private captures and audits captain type plus team-wide use', () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), 'pdl-evidence-'));
		const artifact = createTrialArtifact({ outputDirectory, trialId: 'fixed-0001', belief, manifest: {
			schemaVersion: 1, pairId: 'fixed', side: 'forward',
			p1: { teamId: 'adam', packed: 'a', exported: 'a', teraCaptains: { scovillain: 'Fire', tatsugiri: 'Dragon' } },
			p2: { teamId: 'zander', packed: 'z', exported: 'z', teraCaptains: { weezing: 'Poison', honchkrow: 'Flying' } },
		} });
		const publicLines = `>battle-test\n|teampreview\n|start\n|turn|1\n|-terastallize|p2a: Honchkrow|Flying\n|move|p2a: Honchkrow|Brave Bird|p1a: Scovillain\n|win|${foulBotName('fixed-0001', 'p1')}`;
		writeFileSync(artifact.p1ProtocolPath, `${publicLines}\n|request|{"private":"p1"}\n|sentchoice|move 1\n`);
		writeFileSync(artifact.p2ProtocolPath, `${publicLines}\n|request|{"private":"p2"}\n|sentchoice|move 2\n`);
		writeFileSync(artifact.p1LogPath, 'PDL_DECISION_EVIDENCE {"turn":1,"selected":"flamethrower"}\n');
		writeFileSync(artifact.p2LogPath, '');

		const audit = buildTrialEvidence(artifact, { status: 'completed', winnerTeamId: 'adam', failureReason: null });

		assert.equal(audit.auditStatus, 'clean');
		assert.equal(audit.decisions.p1.length, 1);
		assert.doesNotMatch(readFileSync(artifact.publicProtocolPath, 'utf8'), /private|sentchoice/);
		assert.notEqual(readFileSync(artifact.p1ProtocolPath, 'utf8'), readFileSync(artifact.p2ProtocolPath, 'utf8'));
	});

	it('flags mismatched and second Tera events', () => {
		assert.doesNotMatch(publicProtocolFromPrivateCapture('|turn|1\n|request|secret\n|move|x'), /secret/);
		const outputDirectory = mkdtempSync(join(tmpdir(), 'pdl-evidence-invalid-'));
		const artifact = createTrialArtifact({ outputDirectory, trialId: 'fixed-invalid', belief, manifest: {
			schemaVersion: 1, pairId: 'fixed', side: 'forward',
			p1: { teamId: 'adam', packed: 'a', exported: 'a', teraCaptains: { scovillain: 'Fire', tatsugiri: 'Dragon' } },
			p2: { teamId: 'zander', packed: 'z', exported: 'z', teraCaptains: { weezing: 'Poison', honchkrow: 'Flying' } },
		} });
		const invalid = '>battle-test\n|teampreview|6\n|start\n|turn|1\n|-terastallize|p2a: Honchkrow|Dark\n|-terastallize|p2a: Weezing|Poison\n|tie|\n';
		writeFileSync(artifact.p1ProtocolPath, invalid);
		writeFileSync(artifact.p2ProtocolPath, invalid);
		writeFileSync(artifact.p1LogPath, '');
		writeFileSync(artifact.p2LogPath, '');

		const audit = buildTrialEvidence(artifact, { status: 'failed', winnerTeamId: null, failureReason: 'fixture' });

		assert.equal(audit.auditStatus, 'violating');
		assert.deepEqual(audit.tera.violations.map(violation => violation.reason), ['mismatched-type', 'second-tera']);
	});

	it('is inconclusive when either full capture is empty or misses preview/terminal evidence', () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), 'pdl-evidence-incomplete-'));
		const artifact = createTrialArtifact({ outputDirectory, trialId: 'fixed-incomplete', belief, manifest: {
			schemaVersion: 1, pairId: 'fixed', side: 'forward',
			p1: { teamId: 'adam', packed: 'a', exported: 'a', teraCaptains: { scovillain: 'Fire', tatsugiri: 'Dragon' } },
			p2: { teamId: 'zander', packed: 'z', exported: 'z', teraCaptains: { weezing: 'Poison', honchkrow: 'Flying' } },
		} });
		writeFileSync(artifact.p1ProtocolPath, '>battle-test\n|start\n');
		writeFileSync(artifact.p2ProtocolPath, '');
		writeFileSync(artifact.p1LogPath, '');
		writeFileSync(artifact.p2LogPath, '');

		const audit = buildTrialEvidence(artifact, { status: 'failed', winnerTeamId: null, failureReason: 'fixture' });

		assert.equal(audit.auditStatus, 'inconclusive');
	});

	it('is violating when a complete public winner disagrees with TrialResult', () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), 'pdl-evidence-result-mismatch-'));
		const artifact = createTrialArtifact({ outputDirectory, trialId: 'fixed-mismatch', belief, manifest: {
			schemaVersion: 1, pairId: 'fixed', side: 'forward',
			p1: { teamId: 'adam', packed: 'a', exported: 'a', teraCaptains: { scovillain: 'Fire', tatsugiri: 'Dragon' } },
			p2: { teamId: 'zander', packed: 'z', exported: 'z', teraCaptains: { weezing: 'Poison', honchkrow: 'Flying' } },
		} });
		const protocol = `>battle-test\n|teampreview|6\n|start\n|turn|1\n|win|${foulBotName('fixed-mismatch', 'p2')}\n`;
		writeFileSync(artifact.p1ProtocolPath, protocol);
		writeFileSync(artifact.p2ProtocolPath, protocol);
		writeFileSync(artifact.p1LogPath, '');
		writeFileSync(artifact.p2LogPath, '');

		const audit = buildTrialEvidence(artifact, { status: 'completed', winnerTeamId: 'adam', failureReason: null });

		assert.equal(audit.auditStatus, 'violating');
		assert.equal(audit.integrityViolations.length, 1);
	});

	it('accepts a legitimate tie only when both public streams and TrialResult agree', () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), 'pdl-evidence-tie-'));
		const artifact = createTrialArtifact({ outputDirectory, trialId: 'fixed-tie', belief, manifest: {
			schemaVersion: 1, pairId: 'fixed', side: 'forward',
			p1: { teamId: 'adam', packed: 'a', exported: 'a', teraCaptains: {} },
			p2: { teamId: 'zander', packed: 'z', exported: 'z', teraCaptains: {} },
		} });
		const protocol = '>battle-test\n|teampreview|6\n|start\n|turn|1\n|tie|\n';
		writeFileSync(artifact.p1ProtocolPath, protocol);
		writeFileSync(artifact.p2ProtocolPath, protocol);
		writeFileSync(artifact.p1LogPath, '');
		writeFileSync(artifact.p2LogPath, '');

		const audit = buildTrialEvidence(artifact, { status: 'tied', winnerTeamId: null, failureReason: null });

		assert.equal(audit.auditStatus, 'clean');
		assert.equal(audit.integrityViolations.length, 0);
	});
});
