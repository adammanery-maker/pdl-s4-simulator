'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { fixtureBattle } = require('../dist/pdl/examples/fixture-league');
const { Teams } = require('../dist/sim/teams');
const { toID } = require('../dist/sim/dex');
const { createTrialArtifact } = require('../dist/pdl/batch/artifacts');
const { runFoulPlayTrial } = require('../dist/pdl/batch/run-trial');
const { CANONICAL_RUNTIME_ID } = require('../dist/pdl/batch/runtime');

function logJson(log, prefix) {
	const line = log.split(/\r?\n/).find(candidate => candidate.includes(prefix));
	assert.ok(line, `expected ${prefix} in Foul Play log`);
	return JSON.parse(line.slice(line.indexOf(prefix) + prefix.length).trim());
}

function makeRuntimeBelief() {
	const teams = {};
	const sets = {};
	const sides = [fixtureBattle.p1, fixtureBattle.p2];
	for (const side of sides) {
		const leagueTeam = fixtureBattle.league.teams.find(team => team.id === side.teamId);
		teams[side.teamId] = {
			draftedTeraTypes: [...leagueTeam.draftedTeraTypes],
			teraCaptains: side.teamId === 'red' ? ['Tatsugiri', 'Charizard'] : ['Arcanine', 'Jolteon'],
			roster: leagueTeam.roster.map(pokemon => ({ ...pokemon })),
		};
		for (const set of side.team) {
			const evs = [set.evs.hp, set.evs.atk, set.evs.def, set.evs.spa, set.evs.spd, set.evs.spe];
			// An independent prior hypothesis: it intentionally differs from the private submitted set.
			sets[toID(set.species)] = [{
				weight: 1,
				ability: set.ability,
				item: set.item === 'Leftovers' ? 'Life Orb' : 'Leftovers',
				nature: set.nature,
				evs,
				moves: [...set.moves],
				teraType: null,
			}];
		}
	}
	return {
		schemaVersion: 1,
		snapshot: { id: 'offline-runtime-smoke-prior', source: 'offline-runtime-smoke', hash: 'offline-smoke' },
		teams,
		sets,
	};
}

async function main() {
	const simulatorRoot = resolve(__dirname, '..');
	const foulPlayRoot = process.env.FOUL_PLAY_ROOT || resolve(simulatorRoot, '..', 'pdl-s4-foul-play');
	const outputDirectory = mkdtempSync(join(tmpdir(), 'pdl-offline-runtime-'));
	const trialId = 'offline-zero-token-smoke';
	const p1 = fixtureBattle.p1;
	const p2 = fixtureBattle.p2;
	const artifact = createTrialArtifact({
		outputDirectory,
		trialId,
		manifest: {
			schemaVersion: 1,
			pairId: 'offline-zero-token-smoke',
			side: 'forward',
			p1: { teamId: p1.teamId, packed: Teams.pack(p1.team), exported: Teams.export(p1.team) },
			p2: { teamId: p2.teamId, packed: Teams.pack(p2.team), exported: Teams.export(p2.team) },
			metadata: { smokeTest: true, networkDisabledExceptLocalShowdown: true },
		},
		belief: makeRuntimeBelief(),
	});

	const previous = new Map();
	for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_BASE_URL']) {
		previous.set(name, process.env[name]);
		process.env[name] = 'must-not-reach-runtime';
	}
	try {
		const result = await runFoulPlayTrial({
			simulatorRoot,
			foulPlayRoot,
			artifact,
			searchTimeMs: 10,
			beliefSamples: 1,
			timeoutMs: 180_000,
		});
		assert.equal(result.status, 'completed', `offline battle ended with ${result.status}: ${result.failureReason}`);
		assert.ok(result.winnerTeamId, 'completed battle must report a winning team');
		const p1Log = readFileSync(artifact.p1LogPath, 'utf8');
		const p2Log = readFileSync(artifact.p2LogPath, 'utf8');
		const showdownLog = readFileSync(artifact.showdownLogPath, 'utf8');
		for (const log of [p1Log, p2Log]) {
			const runtime = logJson(log, 'PDL_RUNTIME_CONTRACT');
			assert.equal(runtime.id, CANONICAL_RUNTIME_ID);
			assert.equal(runtime.evaluator.id, 'genx-static-v0.0.48-boost-relevance-v1');
			assert.match(log, /"hostedInferenceCalls":0/);
			const rootEvaluation = logJson(log, 'PDL_ROOT_EVALUATIONS');
			assert.equal(rootEvaluation.evaluator, 'genx-static-v0.0.48-boost-relevance-v1');
			assert.ok(rootEvaluation.worlds[0].components.pokemon !== undefined);
			const decision = logJson(log, 'PDL_DECISION_EVIDENCE');
			assert.equal(decision.actionPolicy, 'argmax');
			assert.equal(decision.evaluator.id, 'genx-static-v0.0.48-boost-relevance-v1');
			assert.doesNotMatch(log, /must-not-reach-runtime/);
		}
		assert.match(showdownLog, /127\.0\.0\.1:\d+/);
		assert.equal(readFileSync(artifact.networkAuditPath, 'utf8'), '', 'no non-Showdown network connection was attempted');
		process.stdout.write(JSON.stringify({
			status: result.status,
			winnerTeamId: result.winnerTeamId,
			runtimeId: CANONICAL_RUNTIME_ID,
			hostedInferenceCalls: 0,
			blockedOrExternalNetworkAttempts: 0,
			artifactDirectory: artifact.directory,
		}, null, 2) + '\n');
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

main().catch(error => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
