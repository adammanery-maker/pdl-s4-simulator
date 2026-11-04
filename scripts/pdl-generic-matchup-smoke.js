'use strict';

// Development acceptance check: two complete mirrored battles, not a win-rate batch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTeamSearchManifest, privateTeamSearchBelief, sharedCellSeeds } = require('../dist/pdl/team-search');
const { createTrialArtifact } = require('../dist/pdl/batch/artifacts');
const { buildTrialEvidence } = require('../dist/pdl/batch/evidence');
const { runFoulPlayTrial, parseRuntimeContractFromLog } = require('../dist/pdl/batch/run-trial');
const { CANONICAL_RUNTIME } = require('../dist/pdl/batch/runtime');

async function main(args) {
	const options = new Map();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		if (!['--manifest', '--output', '--foul-root'].includes(key) || !args[index + 1] || options.has(key)) {
			throw new Error('Use --manifest <prepared manifest> --output <fresh directory> [--foul-root <path>].');
		}
		options.set(key, args[index + 1]);
	}
	assert(options.has('--manifest') && options.has('--output'), 'Explicit manifest and fresh output required.');
	const simulatorRoot = path.resolve(__dirname, '..');
	const foulPlayRoot = path.resolve(options.get('--foul-root') || path.join(simulatorRoot, '..', 'pdl-s4-foul-play'));
	const outputDirectory = path.resolve(options.get('--output'));
	assert(!fs.existsSync(outputDirectory), 'Smoke output must be fresh.');
	const manifest = loadTeamSearchManifest(options.get('--manifest'));
	assert.deepEqual(manifest.validationErrors, []);
	assert(manifest.metadata?.roleAliases, 'Use a generic prepared matchup with explicit participant identities.');
	const candidate = manifest.adamCandidates[0];
	const opponent = manifest.steveOpponents[0];
	assert(!candidate.strategyPolicy && !opponent.strategyPolicy, 'Generic smoke must use ordinary MCTS policy.');
	const runtime = {
		...CANONICAL_RUNTIME, id: 'pdl-s4-foul-play-eval-fixediter-v1',
		resolvedConfiguration: { ...CANONICAL_RUNTIME.resolvedConfiguration,
			fixedIterations: 120000, searchThreads: 1, seedScheme: 'sha256-v1' },
	};
	const side = (role, team) => ({ teamId: role, packed: team.packed, exported: team.exported, teraCaptains: team.teraCaptains });
	const report = { schemaVersion: 1, kind: 'development-smoke', manifestHash: manifest.manifestHash,
		beliefHash: manifest.beliefHash, roleAliases: manifest.metadata.roleAliases, results: [] };
	fs.mkdirSync(outputDirectory, { recursive: true });
	for (const orientation of ['forward', 'reverse']) {
		const forward = orientation === 'forward';
		const seeds = sharedCellSeeds(manifest.id, opponent.id, orientation, 1);
		const trialId = `generic-smoke-${orientation}`;
		const artifact = createTrialArtifact({ outputDirectory, trialId, manifest: {
			schemaVersion: 1, pairId: trialId, side: orientation,
			p1: forward ? side('adam', candidate) : side('steve', opponent),
			p2: forward ? side('steve', opponent) : side('adam', candidate),
			metadata: { runtime, roleAliases: manifest.metadata.roleAliases, smokeOnly: true, ...seeds },
		},
		p1Belief: privateTeamSearchBelief(manifest, forward ? 'adam' : 'steve', forward ? candidate : opponent),
		p2Belief: privateTeamSearchBelief(manifest, forward ? 'steve' : 'adam', forward ? opponent : candidate) });
		process.stdout.write(`Starting ${orientation} fixed-120K generic smoke\n`);
		const result = await runFoulPlayTrial({ simulatorRoot, foulPlayRoot, artifact, searchTimeMs: 1000,
			beliefSamples: 1, beliefEngine: 'posterior', timeoutMs: 600000, battleSeed: seeds.battleSeed,
			evaluation: { fixedIterations: 120000, mctsSeed: seeds.searchSeed,
				beliefSeed: seeds.beliefSeed, worldSeed: seeds.worldAllocationSeed, worldWorkers: 1 } });
		const evidence = buildTrialEvidence(artifact, result);
		const record = { orientation, seeds, result, auditStatus: evidence.auditStatus, artifact: artifact.directory };
		report.results.push(record);
		fs.writeFileSync(path.join(outputDirectory, 'smoke-summary.json'), JSON.stringify(report, null, 2) + '\n');
		assert(['completed', 'tied'].includes(result.status), `Smoke failed: ${result.failureReason}`);
		assert.equal(evidence.auditStatus, 'clean');
		const contracts = [];
		for (const logPath of [artifact.p1LogPath, artifact.p2LogPath]) {
			const log = fs.readFileSync(logPath, 'utf8');
			const contract = parseRuntimeContractFromLog(log, true);
			assert.equal(contract.actionPolicy, 'argmax');
			assert.equal(contract.resolvedConfiguration.fixedIterations, 120000);
			assert.equal(contract.networkPolicy, 'showdown-loopback-only');
			assert.match(log, /"hostedInferenceCalls":0/);
			assert.match(log, /PDL_DECISION_EVIDENCE/);
			contracts.push(contract);
		}
		for (const auditPath of [artifact.networkAuditPath, artifact.p1NetworkAuditPath, artifact.p2NetworkAuditPath]) {
			assert.equal(fs.readFileSync(auditPath, 'utf8'), '', 'Unexpected external-network attempt.');
		}
		Object.assign(record, { contracts, hostedInferenceCalls: 0, externalNetworkAttempts: 0 });
		fs.writeFileSync(path.join(outputDirectory, 'smoke-summary.json'), JSON.stringify(report, null, 2) + '\n');
		process.stdout.write(`${orientation}: ${result.status}; audit clean; hosted inference calls 0\n`);
	}
	process.stdout.write(`Smoke evidence: ${outputDirectory}/smoke-summary.json\n`);
}

if (require.main === module) {
	main(process.argv.slice(2)).catch(error => {
		process.stderr.write(`${error.stack || error}\n`);
		process.exitCode = 1;
	});
}

module.exports = { main };
