'use strict';

require('../../main');

const assert = require('node:assert/strict');
const {
	appendCompleteProcessLog, appendProcessOutput, determineWinnerTeamId, foulPlayArguments,
	assertCanonicalFoulPlayRuntime, foulBotName, foulPlaySandboxProfile, offlineRuntimeEnvironment,
	parseRuntimeContractFromLog, spawnCollectedWithCompleteLog, terminateProcessTree,
} = require('../../../dist/pdl/batch/run-trial');
const { CANONICAL_RUNTIME } = require('../../../dist/pdl/batch/runtime');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

describe('PDL local simulation process runner', () => {
	it('removes hosted-model credentials from every canonical runtime child', () => {
		const env = offlineRuntimeEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', OPENAI_BASE_URL: 'https://hosted.invalid' });
		assert.deepEqual(env, { PATH: '/bin' });
	});
	it('accepts only the measured canonical Foul Play evaluator and search contract', () => {
		assert.doesNotThrow(() => assertCanonicalFoulPlayRuntime(CANONICAL_RUNTIME));
		assert.throws(() => assertCanonicalFoulPlayRuntime({ ...CANONICAL_RUNTIME, actionPolicy: 'stochastic' }), /does not match canonical/);
		assert.throws(() => assertCanonicalFoulPlayRuntime({ ...CANONICAL_RUNTIME, evaluator: { ...CANONICAL_RUNTIME.evaluator, id: 'unknown' } }), /does not match canonical/);
		assert.throws(() => assertCanonicalFoulPlayRuntime({ ...CANONICAL_RUNTIME, resolvedConfiguration: { ...CANONICAL_RUNTIME.resolvedConfiguration, offlineRuntime: false } }), /does not match canonical/);
		assert.throws(() => assertCanonicalFoulPlayRuntime({ ...CANONICAL_RUNTIME, evaluator: { ...CANONICAL_RUNTIME.evaluator, sourceSha256: 'dirty-source' } }), /does not match canonical/);
		assert.throws(() => assertCanonicalFoulPlayRuntime({ ...CANONICAL_RUNTIME, evaluator: { ...CANONICAL_RUNTIME.evaluator, engineSourceSha256: 'dirty-engine-source' } }), /does not match canonical/);
	});
	it('parses and validates each bot emitted runtime attestation', () => {
		const log = `INFO PDL_RUNTIME_CONTRACT ${JSON.stringify(CANONICAL_RUNTIME)}\n`;
		assert.deepEqual(parseRuntimeContractFromLog(log), CANONICAL_RUNTIME);
		assert.throws(() => parseRuntimeContractFromLog('INFO ready\n'), /exactly one/);
		assert.throws(() => parseRuntimeContractFromLog(`${log}${log}`), /exactly one/);
	});
	it('scoped sandbox blocks a malicious child from reading a sibling hidden marker', function () {
		if (process.platform !== 'darwin') this.skip();
		const root = mkdtempSync(join(tmpdir(), 'pdl-sandbox-canary-'));
		const outputDirectory = join(root, 'run-output');
		const own = join(outputDirectory, 'trials', 'pair-0001-forward', 'private-p1');
		const sibling = join(outputDirectory, 'trials', 'pair-0001-forward', 'private-p2');
		mkdirSync(own, { recursive: true });
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(own, 'own.txt'), 'public-to-this-child');
		writeFileSync(join(sibling, 'hidden-marker.txt'), 'PDL_HIDDEN_MARKER_CANARY');
		writeFileSync(join(outputDirectory, 'trials.jsonl'), 'PDL_HIDDEN_TRIALS_MARKER');
		writeFileSync(join(outputDirectory, 'plan.resolved.json'), 'PDL_HIDDEN_PLAN_MARKER');
		const profile = foulPlaySandboxProfile(process.cwd(), own, 65534);
		assert.equal(execFileSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/cat', join(own, 'own.txt')], { encoding: 'utf8' }), 'public-to-this-child');
		for (const hiddenPath of [
			join(sibling, 'hidden-marker.txt'),
			join(outputDirectory, 'trials.jsonl'),
			join(outputDirectory, 'plan.resolved.json'),
		]) {
			assert.throws(
				() => execFileSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/cat', hiddenPath], { stdio: 'pipe' }),
				/error|denied|Operation not permitted|exit/i,
			);
		}
	});
	it('terminates the explicitly spawned local process group after the grace period', async function () {
		if (process.platform === 'win32') this.skip();
		const script = [
			'const {spawn}=require("child_process")',
			'process.on("SIGTERM",()=>{})',
			'const child=spawn(process.execPath,["-e","process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"})',
			'console.log(child.pid)',
			'setInterval(()=>{},1000)',
		].join(';');
		const output = spawnCollectedWithCompleteLog(process.execPath, ['-e', script], process.cwd(), null);
		let childPid;
		try {
			const deadline = Date.now() + 2000;
			while (!output.stdout.includes('\n') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
			childPid = Number(output.stdout.trim());
			assert.equal(Number.isInteger(childPid), true);

			await terminateProcessTree(output, 25);
			const completion = await Promise.race([output.completion.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('hung'), 1000))]);
			assert.equal(completion, 'closed');
			await new Promise(resolve => setTimeout(resolve, 25));
			assert.throws(() => process.kill(childPid, 0), /ESRCH/);
		} finally {
			if (output.child.exitCode === null) output.child.kill('SIGKILL');
			if (childPid) {
				try { process.kill(childPid, 'SIGKILL'); } catch { /* already terminated */ }
			}
		}
	});

	it('bounds captured subprocess output while retaining the most recent diagnostics', () => {
		assert.equal(appendProcessOutput('abc', 'def', 5), 'bcdef');
	});

	it('writes complete evidence logs independently of bounded in-memory diagnostics', () => {
		const directory = mkdtempSync(join(tmpdir(), 'pdl-complete-log-'));
		const path = join(directory, 'agent.log');
		appendCompleteProcessLog(path, 'first-decision\n');
		appendCompleteProcessLog(path, 'terminal-result\n');

		assert.equal(readFileSync(path, 'utf8'), 'first-decision\nterminal-result\n');
	});

	it('keeps an early runtime contract verifiable when the in-memory tail is truncated', () => {
		const contract = `PDL_RUNTIME_CONTRACT ${JSON.stringify(CANONICAL_RUNTIME)}\n`;
		const complete = `${contract}${'verbose-search\n'.repeat(100)}`;
		const tail = appendProcessOutput(contract, 'verbose-search\n'.repeat(100), 32);

		assert.doesNotMatch(tail, /PDL_RUNTIME_CONTRACT/);
		assert.deepEqual(parseRuntimeContractFromLog(complete), CANONICAL_RUNTIME);
	});

	it('passes only local PDL belief and private team inputs to each Foul agent', () => {
		const args = foulPlayArguments({
			websocketUri: 'ws://127.0.0.1:8123/showdown/websocket',
			username: 'PDL Sim pair-0001 p1',
			mode: 'challenge_user',
			challengeUser: 'PDL Sim pair-0001 p2',
			teamId: 'adam',
			teamPath: '/tmp/p1-team.txt',
			beliefPath: '/tmp/belief.json',
			protocolPath: '/tmp/p1.protocol',
			searchTimeMs: 100, beliefSamples: 2,
		});

		assert.deepEqual(args, [
			'run.py', '--websocket-uri', 'ws://127.0.0.1:8123/showdown/websocket',
			'--ps-username', 'PDL Sim pair-0001 p1', '--bot-mode', 'challenge_user',
			'--pokemon-format', 'gen9pdls4', '--pdl-belief-data', '/tmp/belief.json',
			'--pdl-team-id', 'adam', '--belief-zero-policy', 'restore', '--team-name', '/tmp/p1-team.txt',
			'--protocol-log-path', '/tmp/p1.protocol', '--local-no-security', '--offline-runtime',
			'--search-engine', 'mcts', '--action-policy', 'argmax',
			'--belief-engine', 'legacy',
			'--search-time-ms', '100', '--search-parallelism', '2', '--run-count', '1', '--log-level', 'INFO',
			'--user-to-challenge', 'PDL Sim pair-0001 p2',
		]);
	});

	it('can give each agent a different private belief artifact', () => {
		const p1 = foulPlayArguments({
			websocketUri: 'ws://localhost', username: 'p1', mode: 'challenge_user', challengeUser: 'p2',
			teamId: 'adam', teamPath: '/private/p1-team.txt', beliefPath: '/private/p1-belief.json',
			protocolPath: '/private/p1.protocol', searchTimeMs: 5000, beliefSamples: 4,
		});
		const p2 = foulPlayArguments({
			websocketUri: 'ws://localhost', username: 'p2', mode: 'accept_challenge',
			teamId: 'zander', teamPath: '/private/p2-team.txt', beliefPath: '/private/p2-belief.json',
			protocolPath: '/private/p2.protocol', searchTimeMs: 5000, beliefSamples: 4,
		});

		assert.equal(p1.includes('/private/p1-belief.json'), true);
		assert.equal(p2.includes('/private/p2-belief.json'), true);
		assert.equal(p1.includes('/private/p2-team.txt'), false);
		assert.equal(p2.includes('/private/p1-team.txt'), false);
	});

	it('accepts a winner only when both agents report the same known bot', () => {
		const winner = determineWinnerTeamId({
			p1Log: 'INFO Winner: PDL Sim pair-0001 p1\nINFO W: 1\tL: 0',
			p2Log: 'INFO Winner: PDL Sim pair-0001 p1\nINFO W: 0\tL: 1',
			p1: { botName: 'PDL Sim pair-0001 p1', teamId: 'adam' },
			p2: { botName: 'PDL Sim pair-0001 p2', teamId: 'connor' },
		});

		assert.equal(winner, 'adam');
		assert.throws(() => determineWinnerTeamId({
			p1Log: 'INFO Winner: PDL Sim pair-0001 p1',
			p2Log: 'INFO Winner: PDL Sim pair-0001 p2',
			p1: { botName: 'PDL Sim pair-0001 p1', teamId: 'adam' },
			p2: { botName: 'PDL Sim pair-0001 p2', teamId: 'connor' },
		}), /disagree/);
	});

	it('returns null only when both agents distinctly report a legitimate tie', () => {
		assert.equal(determineWinnerTeamId({
			p1Log: 'INFO Winner: None', p2Log: 'INFO Winner: None',
			p1: { botName: 'p1', teamId: 'adam' }, p2: { botName: 'p2', teamId: 'zander' },
		}), null);
	});

	it('uses deterministic Showdown-safe bot names for every trial side', () => {
		assert.equal(foulBotName('pair-0001-forward', 'p1'), foulBotName('pair-0001-forward', 'p1'));
		assert.notEqual(foulBotName('pair-0001-forward', 'p1'), foulBotName('pair-0001-forward', 'p2'));
		assert.equal(foulBotName('pair-0001-forward', 'p1').length <= 18, true);
	});
});
