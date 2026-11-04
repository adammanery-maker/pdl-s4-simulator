'use strict';

const assert = require('../../assert');
const { mkdtempSync, readFileSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const { parseTeamSearchArguments } = require('../../../dist/pdl/cli/team-search');
const { CANONICAL_RUNTIME } = require('../../../dist/pdl/batch/runtime');
const { runTeamSearch } = require('../../../dist/pdl/team-search/runner');

const evaluationRuntime = {
	...CANONICAL_RUNTIME,
	id: 'pdl-s4-foul-play-eval-fixediter-v1',
	resolvedConfiguration: {
		...CANONICAL_RUNTIME.resolvedConfiguration, fixedIterations: 120000, searchThreads: 1, seedScheme: 'sha256-v1',
	},
};

function team(id) {
	const exported = `${id}\nAbility: Overgrow\n- Tackle\n`;
	return {
		id, label: id, teamPath: `/fixture/${id}.txt`, teamHash: `${id}-hash`, exported,
		packed: `${id}||||tackle|||||||||||`, team: [{ name: id, species: id, ability: 'Overgrow', moves: ['Tackle'] }],
		teraCaptains: [], weight: 1,
	};
}

function manifest(validationErrors = []) {
	return {
		schemaVersion: 1, id: 'fixture-search', manifestHash: 'manifest-hash', beliefHash: 'belief-hash',
		beliefPath: '/fixture/belief.json', belief: {
			schemaVersion: 1, snapshot: { id: 'fixture', source: 'fixture', hash: 'belief-hash' },
			teams: {
				adam: { draftedTeraTypes: [], roster: [], teraCaptains: [] },
				steve: { draftedTeraTypes: [], roster: [], teraCaptains: [] },
			},
			sets: {},
		},
		league: {
			adam: { id: 'adam', draftedTeraTypes: [], teraCaptains: [], roster: [] },
			steve: { id: 'steve', draftedTeraTypes: [], teraCaptains: [], roster: [] },
		},
		adamCandidates: [team('adam-a'), team('adam-b')], steveOpponents: [team('steve-a')], validationErrors,
	};
}

function json(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function dependencies(loaded, calls, failFirstCell = false, winner = input => input.artifact.manifest.p1.teamId) {
	let failed = false;
	return {
		loadManifest: () => loaded,
		runTrial: async input => {
			calls.push(input);
			const shouldFail = failFirstCell && !failed;
			failed ||= shouldFail;
			const protocol = shouldFail ? '' : '|turn|1\n|switch|p1a: Bulbasaur|Bulbasaur, L100|100/100\n|switch|p2a: Charmander|Charmander, L100|100/100\n|win|p1\n';
			writeFileSync(input.artifact.publicProtocolPath, protocol);
			const contractFor = side => input.sunPolicies?.[side] ? {
				...evaluationRuntime, resolvedConfiguration: { ...evaluationRuntime.resolvedConfiguration,
					sunPolicy: input.sunPolicies[side], candidateId: 'adam-03-sun-drednaw' },
			} : evaluationRuntime;
			writeFileSync(input.artifact.p1LogPath, `PDL_RUNTIME_CONTRACT ${JSON.stringify(contractFor('p1'))}\n`);
			writeFileSync(input.artifact.p2LogPath, `PDL_RUNTIME_CONTRACT ${JSON.stringify(contractFor('p2'))}\n`);
			const result = shouldFail ?
				{ status: 'failed', winnerTeamId: null, failureReason: 'fixture failure' } :
				{ status: 'completed', winnerTeamId: winner(input), failureReason: null };
			writeFileSync(input.artifact.resultPath, `${JSON.stringify(result)}\n`);
			return result;
		},
		buildEvidence: (artifact, result) => {
			const evidence = { auditStatus: result.status === 'completed' ? 'clean' : 'inconclusive' };
			writeFileSync(artifact.auditPath, `${JSON.stringify(evidence)}\n`);
			return evidence;
		},
	};
}

describe('team-search runner', () => {
	it('parses the explicit team-search CLI contract', () => {
		assert.deepEqual(parseTeamSearchArguments([
			'--manifest', 'input.json', '--preset', 'screen', '--foul-root', '/foul', '--output', '/out',
			'--dry-run', 'true', '--resume', 'true', '--timeout-ms', '9000',
		]), { manifestPath: 'input.json', preset: 'screen', foulRoot: '/foul', outputDirectory: '/out', dryRun: true, resume: true, timeoutMs: 9000 });
		assert.throws(() => parseTeamSearchArguments(['--manifest', 'x']), /Missing --preset/);
	});

	it('schedules screen-5 as ten mirrored battles per pairing with unchanged shared seeds', async () => {
		const calls = [];
		const loaded = manifest();
		const schedules = {};
		for (const preset of ['screen-5', 'screen']) {
			const outputDirectory = mkdtempSync(join(tmpdir(), 'pdl-team-search-five-'));
			const options = parseTeamSearchArguments([
				'--manifest', 'fixture.json', '--preset', preset, '--foul-root', '/foul',
				'--output', outputDirectory, '--dry-run', 'true',
			]);
			await runTeamSearch(options, dependencies(loaded, calls));
			schedules[preset] = json(join(outputDirectory, 'schedule.json'));
			assert.equal(json(join(outputDirectory, 'summary.json')).runnerCalls, 0);
		}
		assert.equal(calls.length, 0);
		assert.equal(schedules['screen-5'].length, 20);
		assert.deepEqual(schedules['screen-5'], schedules.screen.filter(cell => cell.seedIndex <= 5));
		for (const orientation of ['forward', 'reverse']) {
			for (let seedIndex = 1; seedIndex <= 5; seedIndex++) {
				const cells = schedules['screen-5'].filter(cell => cell.orientation === orientation && cell.seedIndex === seedIndex);
				assert.equal(cells.length, 2);
				assert.deepEqual(cells[0].seeds, cells[1].seeds);
			}
		}
	});

	it('writes a validation-aware dry-run schedule without launching trials', async () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), 'pdl-team-search-dry-'));
		const calls = [];
		await assert.rejects(
			runTeamSearch({ manifestPath: 'fixture.json', preset: 'quick', foulRoot: '/foul', outputDirectory, dryRun: true, resume: false, timeoutMs: 12_000 }, dependencies(manifest(['steve-a: Light Clay is banned']), calls)),
			/validation failed/i
		);

		assert.equal(calls.length, 0);
		const schedule = json(join(outputDirectory, 'schedule.json'));
		assert.equal(schedule.length, 12);
		assert.equal(schedule[0].seeds.battleSeed, schedule[6].seeds.battleSeed);
		assert.equal(json(join(outputDirectory, 'summary.json')).status, 'validation-failed');
		assert.deepEqual(json(join(outputDirectory, 'manifest.resolved.json')).validationErrors, ['steve-a: Light Clay is banned']);
	});

	it('runs fixed evaluations, writes reports, and skips clean cells on resume', async () => {
		const outputDirectory = join(mkdtempSync(join(tmpdir(), 'pdl-team-search-run-')), 'output');
		const calls = [];
		const options = { manifestPath: 'fixture.json', preset: 'quick', foulRoot: '/foul', outputDirectory, dryRun: false, resume: false, timeoutMs: 12_000 };
		await runTeamSearch(options, dependencies(manifest(), calls));

		assert.equal(calls.length, 12);
		assert.deepEqual(calls[0].evaluation, {
			fixedIterations: 120000, mctsSeed: calls[0].evaluation.mctsSeed, beliefSeed: calls[0].evaluation.beliefSeed,
			worldSeed: calls[0].evaluation.worldSeed, worldWorkers: 1,
		});
		assert.equal(calls[0].artifact.manifest.p1.teamId, 'adam');
		assert.equal(calls[0].artifact.manifest.p2.teamId, 'steve');
		assert.equal(calls[3].artifact.manifest.p1.teamId, 'steve');
		assert.equal(calls[3].artifact.manifest.p2.teamId, 'adam');
		assert.equal(json(join(outputDirectory, 'summary.json')).status, 'complete');
		for (const name of ['candidate-results.json', 'pairwise.json', 'pathology-candidates.json', 'pathologies.json', 'lead-frequencies.json', 'orientation-results.json', 'opponent-results.json']) {
			assert.equal(Boolean(json(join(outputDirectory, name))), true, name);
		}

		const resumedCalls = [];
		await runTeamSearch({ ...options, resume: true }, dependencies(manifest(), resumedCalls));
		assert.equal(resumedCalls.length, 0);
		assert.equal(readFileSync(join(outputDirectory, 'cells.jsonl'), 'utf8').trim().split('\n').length, 12);
	});

	it('retries failed cells in new attempt directories and rejects stale configuration', async () => {
		const outputDirectory = join(mkdtempSync(join(tmpdir(), 'pdl-team-search-resume-')), 'output');
		const firstCalls = [];
		const options = { manifestPath: 'fixture.json', preset: 'quick', foulRoot: '/foul', outputDirectory, dryRun: false, resume: false, timeoutMs: 12_000 };
		await runTeamSearch(options, dependencies(manifest(), firstCalls, true));
		assert.equal(json(join(outputDirectory, 'summary.json')).status, 'incomplete');

		const retryCalls = [];
		await runTeamSearch({ ...options, resume: true }, dependencies(manifest(), retryCalls));
		assert.equal(retryCalls.length, 1);
		assert.match(retryCalls[0].artifact.trialId, /-attempt-002$/);
		assert.equal(json(join(outputDirectory, 'summary.json')).status, 'complete');
		await assert.rejects(
			runTeamSearch({ ...options, resume: true, timeoutMs: 12_001 }, dependencies(manifest(), [])),
			/stale|configuration|identity/i
		);
	});
	it('executes five arbitrary supplied opponents and computes aligned candidate advantages', async () => {
		const loaded = manifest();
		loaded.steveOpponents = ['custom-alpha', 'custom-beta', 'custom-gamma', 'custom-delta', 'custom-epsilon'].map(team);
		const outputDirectory = join(mkdtempSync(join(tmpdir(), 'pdl-team-search-generic-')), 'output');
		const calls = [];
		await runTeamSearch({ manifestPath: 'fixture.json', preset: 'quick', foulRoot: '/foul', outputDirectory, dryRun: false, resume: false, timeoutMs: 12000 },
			dependencies(loaded, calls, false, input => input.artifact.manifest.metadata.adamCandidateId === 'adam-a' ? 'adam' : 'steve'));
		assert.equal(calls.length, 60);
		assert.deepEqual(new Set(calls.map(input => input.artifact.manifest.metadata.steveOpponentId)), new Set(loaded.steveOpponents.map(t => t.id)));
		for (let index = 0; index < 30; index++) {
			assert.deepEqual(calls[index].evaluation, calls[index + 30].evaluation);
			assert.equal(calls[index].battleSeed, calls[index + 30].battleSeed);
		}
		const summary = json(join(outputDirectory, 'summary.json'));
		assert.equal(summary.counts.battlesPerAdamCandidate, 30);
		assert.equal(summary.ranking[0].id, 'adam-a');
		assert.equal(summary.ranking[0].wins, 30);
		assert.equal(Object.keys(summary.ranking[0].byOpponent).length, 5);
		assert.equal(summary.ranking[0].byOrientation.reverse.wins, 15);
		assert.equal(summary.ranking[0].averageTurns, 1);
		assert(summary.trustWarnings.some(w => w.includes('exploratory')));
		const pairwise = json(join(outputDirectory, 'pairwise.json'));
		assert.equal(pairwise.matrix['adam-a']['adam-b'].netRowAdvantage, 30);
		assert.equal(pairwise.matrix['adam-b']['adam-a'].netRowAdvantage, -30);
		assert.equal(pairwise.matrix['adam-a']['adam-b'].statistics.pairs, 30);
	});

	it('rechecks saved audit and runtime artifacts rather than trusting JSONL clean labels', async () => {
		const outputDirectory = join(mkdtempSync(join(tmpdir(), 'pdl-team-search-integrity-')), 'output');
		const options = { manifestPath: 'fixture.json', preset: 'quick', foulRoot: '/foul', outputDirectory, dryRun: false, resume: false, timeoutMs: 12000 };
		const calls = [];
		await runTeamSearch(options, dependencies(manifest(), calls));
		writeFileSync(calls[0].artifact.auditPath, JSON.stringify({ auditStatus: 'violating' }));
		writeFileSync(calls[1].artifact.p1LogPath, 'no runtime attestation');
		const retries = [];
		await runTeamSearch({ ...options, resume: true }, dependencies(manifest(), retries));
		assert.equal(retries.length, 2);
		assert(retries.every(input => input.artifact.trialId.endsWith('-attempt-002')));
		const changed = { ...manifest(), manifestHash: 'changed-team-hash' };
		await assert.rejects(runTeamSearch({ ...options, resume: true }, dependencies(changed, [])), /stale/);
	});

	it('keeps hyphenated IDs unambiguous and rejects modified recorded seeds on resume', async () => {
		const loaded = manifest();
		loaded.adamCandidates = [team('a-b'), team('a')];
		loaded.steveOpponents = [team('c'), team('b-c')];
		const outputDirectory = join(mkdtempSync(join(tmpdir(), 'pdl-team-search-collision-')), 'output');
		const options = { manifestPath: 'fixture.json', preset: 'quick', foulRoot: '/foul', outputDirectory, dryRun: false, resume: false, timeoutMs: 12000 };
		const calls = [];
		await runTeamSearch(options, dependencies(loaded, calls));
		assert.equal(calls.length, 24);
		const schedule = json(join(outputDirectory, 'schedule.json'));
		assert.equal(new Set(schedule.map(cell => cell.cellId)).size, 24);
		const rows = readFileSync(join(outputDirectory, 'cells.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
		rows[0].seeds.searchSeed = 'tampered-seed';
		rows[1].orientation = 'reverse';
		writeFileSync(join(outputDirectory, 'cells.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
		const retries = [];
		await runTeamSearch({ ...options, resume: true }, dependencies(loaded, retries));
		assert.equal(retries.length, 2);
		assert.equal(json(join(outputDirectory, 'summary.json')).completedCleanBattles, 24);
	});

	it('routes the experimental policy only to Adam in both orientations', async () => {
		const { loadTeamSearchManifest } = require('../../../dist/pdl/team-search');
		const base = require('path').resolve(__dirname, '../../../pdl/team-search/runs');
		const original = loadTeamSearchManifest(join(base, 'adam-vs-steve-initial.json'));
		const callsByPolicy = [];
		for (const label of ['s1', 's2']) {
			const loaded = loadTeamSearchManifest(join(base, `adam-vs-steve-sun-${label}.json`));
			const outputDirectory = join(mkdtempSync(join(tmpdir(), 'pdl-sun-policy-')), 'output');
			const calls = [];
			await runTeamSearch({ manifestPath: 'fixture.json', preset: 'quick', foulRoot: '/foul', outputDirectory, dryRun: false, resume: false, timeoutMs: 12000 }, dependencies(loaded, calls));
			assert.equal(calls.length, 24);
			for (const input of calls) {
				const side = input.artifact.manifest.p1.teamId === 'adam' ? 'p1' : 'p2';
				assert.deepEqual(input.sunPolicies, { [side]: loaded.adamCandidates[0].strategyPolicy });
				assert.equal(input.artifact.manifest.metadata.adamCandidateId, 'adam-03-sun-drednaw');
			}
			assert.equal(loaded.id, original.id);
			assert.equal(loaded.beliefHash, original.beliefHash);
			assert.equal(loaded.adamCandidates[0].teamHash, original.adamCandidates[2].teamHash);
			assert.equal(json(join(outputDirectory, 'summary.json')).status, 'complete');
			callsByPolicy.push(calls);
		}
		for (let index = 0; index < 24; index++) {
			assert.equal(callsByPolicy[0][index].battleSeed, callsByPolicy[1][index].battleSeed);
			assert.deepEqual(callsByPolicy[0][index].evaluation, callsByPolicy[1][index].evaluation);
		}
	});

	it('revalidates Sun telemetry and its actor-visible inputs before resume', async () => {
		const { loadTeamSearchManifest } = require('../../../dist/pdl/team-search');
		const loaded = loadTeamSearchManifest(require('path').resolve(__dirname, '../../../pdl/team-search/runs/adam-vs-steve-sun-s1.json'));
		const outputDirectory = join(mkdtempSync(join(tmpdir(), 'pdl-sun-resume-')), 'output');
		const calls = [];
		const options = { manifestPath: 'fixture.json', preset: 'quick', foulRoot: '/foul', outputDirectory, dryRun: false, resume: false, timeoutMs: 12000 };
		await runTeamSearch(options, dependencies(loaded, calls));
		const rows = readFileSync(join(outputDirectory, 'cells.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
		assert.equal(json(join(outputDirectory, 'sun-strategy-summary.json')).recordedBattles, 24);
		rows[0].sunStrategy.sunOccurred = true;
		rows[6].adamWon = !rows[6].adamWon;
		rows[7].metrics.generic.turns += 100;
		writeFileSync(join(outputDirectory, 'cells.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
		writeFileSync(join(rows[1].artifact, 'public.protocol'), '|turn|1\n|-weather|SunnyDay\n');
		writeFileSync(join(rows[2].artifact, 'sun-strategy.json'), '{}\n');
		writeFileSync(join(rows[3].artifact, 'public.protocol'), '|turn|1\n|-weather|SunnyDay\n');
		writeFileSync(join(rows[4].artifact, 'private-p2', 'protocol.log'), '|turn|999\n');
		writeFileSync(join(rows[5].artifact, 'offline-network-audit.log'), 'tampered evidence\n');
		await runTeamSearch({ ...options, resume: true }, dependencies(loaded, calls));
		assert.equal(calls.length, 32);
		assert.equal(json(join(outputDirectory, 'sun-strategy-summary.json')).recordedBattles, 24);
		assert.equal(json(join(outputDirectory, 'sun-strategy-summary.json')).battlesWithSun, 0);
	});

	it('validates experiment arguments and actual policy attestation', () => {
		const { foulPlayArguments, assertSunPolicyRuntime } = require('../../../dist/pdl/batch/run-trial');
		const input = { websocketUri: 'ws://localhost:8000', username: 'pdl', mode: 'accept_challenge', teamId: 'adam',
			teamPath: '/private/team', beliefPath: '/private/belief', protocolPath: '/private/protocol', decisionBundlePath: '/private/bundles', searchTimeMs: 1000, beliefSamples: 1 };
		assert(!foulPlayArguments(input).includes('--pdl-sun-policy'));
		const args = foulPlayArguments({ ...input, sunPolicy: 'sun-sequence-v1', candidateId: 'adam-03-sun-drednaw' });
		assert.equal(args[args.indexOf('--pdl-sun-policy') + 1], 'sun-sequence-v1');
		assert.throws(() => foulPlayArguments({ ...input, teamId: 'steve', sunPolicy: 'sun-sequence-v1', candidateId: 'adam-03-sun-drednaw' }), /restricted/);
		assert.throws(() => foulPlayArguments({ ...input, sunPolicy: 'sun-sequence-v1', candidateId: 'adam-01-balance-uxie' }), /restricted/);
		assertSunPolicyRuntime(evaluationRuntime);
		assert.throws(() => assertSunPolicyRuntime(evaluationRuntime, 'sun-sequence-v1'), /attest/);
		const enabled = { ...evaluationRuntime, resolvedConfiguration: { ...evaluationRuntime.resolvedConfiguration, sunPolicy: 'sun-sequence-v1', candidateId: 'adam-03-sun-drednaw' } };
		assertSunPolicyRuntime(enabled, 'sun-sequence-v1');
		assert.throws(() => assertSunPolicyRuntime(enabled), /Unrequested/);
	});

});
