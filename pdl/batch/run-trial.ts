import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'fs';
import { createServer, connect } from 'net';
import { dirname, join, resolve } from 'path';
import { finalizeTrialArtifact, writePrivateGroundTruthAudit } from './artifacts';
import type { TrialArtifact, TrialResult } from './types';
import { CANONICAL_ENGINE_SOURCE_SHA256, CANONICAL_EVALUATOR_SHA256, CANONICAL_RUNTIME_ID } from './runtime';

const MAX_CAPTURED_PROCESS_OUTPUT = 1_000_000;

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

interface FoulPlayArgumentsInput {
	readonly websocketUri: string;
	readonly username: string;
	readonly mode: 'challenge_user' | 'accept_challenge';
	readonly challengeUser?: string;
	readonly teamId: string;
	readonly teamPath: string;
	readonly beliefPath: string;
	readonly protocolPath: string;
	readonly searchTimeMs: number;
	readonly beliefSamples: number;
	readonly beliefEngine?: 'legacy' | 'posterior-shadow' | 'posterior';
}

interface BotIdentity {
	readonly botName: string;
	readonly teamId: string;
}

interface WinnerInput {
	readonly p1Log: string;
	readonly p2Log: string;
	readonly p1: BotIdentity;
	readonly p2: BotIdentity;
}

interface ProcessOutput {
	readonly child: ChildProcessWithoutNullStreams;
	readonly completion: Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>;
	stdout: string;
	stderr: string;
	closeLog(): void;
}

const MODEL_CREDENTIALS = new Set([
	'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
	'COHERE_API_KEY', 'HUGGINGFACE_API_KEY', 'HF_TOKEN', 'CLAUDE_API_KEY',
	'MISTRAL_API_KEY', 'OPENROUTER_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY',
	'REPLICATE_API_TOKEN', 'AI21_API_KEY', 'CEREBRAS_API_KEY', 'DEEPSEEK_API_KEY',
	'GROQ_API_KEY', 'XAI_API_KEY', 'PERPLEXITY_API_KEY', 'AZURE_OPENAI_API_KEY',
	'AWS_BEDROCK_API_KEY', 'VERTEX_API_KEY',
]);

/** Child environment for the canonical zero-token runtime. */
export function offlineRuntimeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(source).filter(([name]) => !MODEL_CREDENTIALS.has(name)
		&& !/^(OPENAI|ANTHROPIC|CLAUDE|GEMINI|GOOGLE|MISTRAL|COHERE|OPENROUTER|TOGETHER|FIREWORKS|REPLICATE|AI21|CEREBRAS|DEEPSEEK|GROQ|XAI|PERPLEXITY|HUGGINGFACE|HF|AZURE_OPENAI|AWS_BEDROCK|VERTEX)_/.test(name)));
}

export function assertCanonicalFoulPlayRuntime(value: unknown): void {
	if (!value || typeof value !== 'object') throw new Error('Foul Play runtime contract is not an object.');
	const runtime = value as {
		id?: unknown; agent?: unknown; authoritativeEngine?: unknown; searchEngine?: unknown;
		actionPolicy?: unknown; informationBoundary?: unknown; networkPolicy?: unknown; modelInference?: unknown;
		resolvedConfiguration?: { offlineRuntime?: unknown; searchEngine?: unknown; actionPolicy?: unknown };
		evaluator?: { engine?: unknown; version?: unknown; id?: unknown; sourceSha256?: unknown; engineSourceSha256?: unknown; feature?: unknown };
	};
	if (runtime.id !== CANONICAL_RUNTIME_ID || runtime.agent !== 'foul-play'
		|| runtime.authoritativeEngine !== 'pokemon-showdown-local' || runtime.searchEngine !== 'poke-engine-mcts'
		|| runtime.actionPolicy !== 'argmax' || runtime.informationBoundary !== 'pdl.observed-battle.v1'
		|| runtime.networkPolicy !== 'showdown-loopback-only' || runtime.modelInference !== 'forbidden'
		|| runtime.resolvedConfiguration?.offlineRuntime !== true
		|| runtime.resolvedConfiguration?.searchEngine !== 'mcts'
		|| runtime.resolvedConfiguration?.actionPolicy !== 'argmax'
		|| runtime.evaluator?.engine !== 'poke-engine'
		|| runtime.evaluator?.version !== '0.0.48' || runtime.evaluator?.id !== 'genx-static-v0.0.48'
		|| runtime.evaluator?.sourceSha256 !== CANONICAL_EVALUATOR_SHA256
		|| runtime.evaluator?.engineSourceSha256 !== CANONICAL_ENGINE_SOURCE_SHA256
		|| runtime.evaluator?.feature !== 'terastallization') {
		throw new Error(`Foul Play runtime does not match canonical contract ${CANONICAL_RUNTIME_ID}.`);
	}
}

export function parseRuntimeContractFromLog(log: string): unknown {
	const marker = 'PDL_RUNTIME_CONTRACT ';
	const payloads = log.split(/\r?\n/)
		.filter(line => line.includes(marker))
		.map(line => line.slice(line.indexOf(marker) + marker.length));
	if (payloads.length !== 1) throw new Error(`Expected exactly one bot runtime attestation, found ${payloads.length}.`);
	let contract: unknown;
	try { contract = JSON.parse(payloads[0]); } catch { throw new Error('Bot emitted invalid runtime-attestation JSON.'); }
	assertCanonicalFoulPlayRuntime(contract);
	return contract;
}

function sbplString(path: string): string {
	return JSON.stringify(realpathSync(resolve(path)));
}

/** Deny the complete run output and simulator tree, reopening only this side's private inputs. */
export function foulPlaySandboxProfile(simulatorRoot: string, privateDirectory: string, showdownPort: number): string {
	const trialDirectory = dirname(resolve(privateDirectory));
	const trialsDirectory = dirname(trialDirectory);
	const outputDirectory = dirname(trialsDirectory);
	return [
		'(version 1)',
		'(allow default)',
		`(deny file-read* file-write* (subpath ${sbplString(outputDirectory)}))`,
		`(deny file-read* (subpath ${sbplString(simulatorRoot)}))`,
		'(deny network-outbound)',
		`(allow network-outbound (remote tcp "localhost:${showdownPort}"))`,
		`(allow file-read* file-write* (subpath ${sbplString(privateDirectory)}))`,
	].join('\n');
}

export function sandboxedFoulPlayInvocation(
	simulatorRoot: string, privateDirectory: string, showdownPort: number, python: string, args: string[]
): { readonly command: string; readonly args: string[] } {
	if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
		throw new Error('Canonical runtime v2 requires macOS sandbox-exec filesystem isolation.');
	}
	return {
		command: '/usr/bin/sandbox-exec',
		args: ['-p', foulPlaySandboxProfile(simulatorRoot, privateDirectory, showdownPort), python, ...args],
	};
}

/** Fails before server startup if the virtualenv contains an uninstrumented or mismatched engine. */
export function preflightFoulPlayRuntime(foulPlayRoot: string): unknown {
	const python = join(foulPlayRoot, '.venv', 'bin', 'python');
	const output = execFileSync(python, ['-m', 'fp.runtime_contract'], {
		cwd: foulPlayRoot,
		env: offlineRuntimeEnvironment(),
		encoding: 'utf8',
		timeout: 10_000,
	});
	let contract: unknown;
	try { contract = JSON.parse(output.trim()); } catch { throw new Error('Foul Play emitted invalid runtime-contract JSON.'); }
	assertCanonicalFoulPlayRuntime(contract);
	return contract;
}

/** Retains recent diagnostics without allowing a noisy child to exhaust the runner heap. */
export function appendProcessOutput(current: string, chunk: string, limit = MAX_CAPTURED_PROCESS_OUTPUT): string {
	const combined = current + chunk;
	return combined.length > limit ? combined.slice(-limit) : combined;
}

export interface RunFoulPlayTrialInput {
	readonly simulatorRoot: string;
	readonly foulPlayRoot: string;
	readonly artifact: TrialArtifact;
	readonly searchTimeMs: number;
	readonly beliefSamples: number;
	readonly beliefEngine?: 'legacy' | 'posterior-shadow' | 'posterior';
	readonly timeoutMs: number;
	readonly port?: number;
}

function winnerNames(log: string): string[] {
	return [...log.matchAll(/^INFO\s+Winner: (.+)$/gm)].map(match => match[1].trim());
}

/** Builds the exact local-only command line for one Foul Play client. */
export function foulPlayArguments(input: FoulPlayArgumentsInput): string[] {
	const args = [
		'run.py', '--websocket-uri', input.websocketUri,
		'--ps-username', input.username, '--bot-mode', input.mode,
		'--pokemon-format', 'gen9pdls4', '--pdl-belief-data', input.beliefPath,
		'--pdl-team-id', input.teamId, '--belief-zero-policy', 'restore', '--team-name', input.teamPath,
		'--protocol-log-path', input.protocolPath, '--local-no-security',
		'--offline-runtime', '--search-engine', 'mcts', '--action-policy', 'argmax',
		'--belief-engine', input.beliefEngine || 'legacy',
		'--search-time-ms', String(input.searchTimeMs), '--search-parallelism', String(input.beliefSamples),
		'--run-count', '1', '--log-level', 'INFO',
	];
	if (input.challengeUser) args.push('--user-to-challenge', input.challengeUser);
	return args;
}

/** Compact, deterministic local usernames; Pokémon Showdown limits account-name length. */
export function foulBotName(trialId: string, side: 'p1' | 'p2'): string {
	return `pdl${createHash('sha256').update(trialId).digest('hex').slice(0, 12)}${side}`;
}

/** Rejects partial or contradictory bot outputs rather than guessing a winner. */
export function determineWinnerTeamId(input: WinnerInput): string | null {
	const p1Winners = winnerNames(input.p1Log);
	const p2Winners = winnerNames(input.p2Log);
	const p1Winner = p1Winners[p1Winners.length - 1];
	const p2Winner = p2Winners[p2Winners.length - 1];
	if (!p1Winner || !p2Winner) throw new Error('Both agents must report a winner.');
	if (p1Winner !== p2Winner) throw new Error(`Agents disagree on the winner: ${p1Winner} versus ${p2Winner}.`);
	if (p1Winner === 'None') return null;
	if (p1Winner === input.p1.botName) return input.p1.teamId;
	if (p1Winner === input.p2.botName) return input.p2.teamId;
	throw new Error(`Winner ${p1Winner} is not a known trial bot.`);
}

export function appendCompleteProcessLog(path: string, chunk: string): void {
	appendFileSync(path, chunk, 'utf8');
}

export function spawnCollectedWithCompleteLog(
	command: string,
	args: string[],
	cwd: string,
	logPath: string | null,
	env: NodeJS.ProcessEnv = offlineRuntimeEnvironment(),
): ProcessOutput {
	const child = spawn(command, args, { cwd, stdio: 'pipe', detached: process.platform !== 'win32', env });
	const logFd = logPath ? openSync(logPath, 'w') : null;
	let logClosed = false;
	const closeLog = () => {
		if (logFd === null || logClosed) return;
		closeSync(logFd);
		logClosed = true;
	};
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', chunk => {
		stdout = appendProcessOutput(stdout, chunk);
		if (logFd !== null) writeSync(logFd, chunk, undefined, 'utf8');
	});
	child.stderr.on('data', chunk => {
		stderr = appendProcessOutput(stderr, chunk);
		if (logFd !== null) writeSync(logFd, chunk, undefined, 'utf8');
	});
	const completion = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
		child.once('error', () => { closeLog(); resolve({ exitCode: null, signal: null }); });
		child.once('close', (exitCode, signal) => { closeLog(); resolve({ exitCode, signal }); });
	});
	return {
		child,
		completion,
		get stdout() { return stdout; },
		get stderr() { return stderr; },
		closeLog,
	};
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	if (process.platform !== 'win32' && child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'ESRCH' && code !== 'EPERM') throw error;
		}
	}
	if (child.exitCode === null && child.signalCode === null) {
		try {
			child.kill(signal);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'ESRCH' && code !== 'EPERM') throw error;
		}
	}
}

function processTreeExists(child: ChildProcessWithoutNullStreams): boolean {
	if (process.platform !== 'win32' && child.pid) {
		try {
			process.kill(-child.pid, 0);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ESRCH' || code === 'EPERM') return false;
			throw error;
		}
	}
	return child.exitCode === null && child.signalCode === null;
}

/** Terminates the dedicated local process group, escalating after a bounded grace period. */
export async function terminateProcessTree(output: ProcessOutput, graceMs = 1_000): Promise<void> {
	signalProcessTree(output.child, 'SIGTERM');
	const parentClosed = await Promise.race([
		output.completion.then(() => true),
		delay(graceMs).then(() => false),
	]);
	if (parentClosed && processTreeExists(output.child)) await delay(graceMs);
	if (!processTreeExists(output.child)) return;
	signalProcessTree(output.child, 'SIGKILL');
	await Promise.race([output.completion, delay(graceMs)]);
}

async function availablePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				reject(new Error('Could not reserve a local Showdown port.'));
				return;
			}
			server.close(error => error ? reject(error) : resolve(address.port));
		});
	});
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const connected = await new Promise<boolean>(resolve => {
			const socket = connect({ host: '127.0.0.1', port });
			socket.once('connect', () => { socket.destroy(); resolve(true); });
			socket.once('error', () => { socket.destroy(); resolve(false); });
		});
		if (connected) return;
		await delay(50);
	}
	throw new Error(`Local Showdown did not start on port ${port}.`);
}

async function waitForLog(output: ProcessOutput, pattern: RegExp, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pattern.test(output.stdout)) return;
		if (output.child.exitCode !== null) throw new Error('Foul Play acceptor exited before becoming ready.');
		await delay(50);
	}
	throw new Error('Foul Play acceptor did not become ready before timeout.');
}

async function awaitBots(
	p1: ProcessOutput,
	p2: ProcessOutput,
	timeoutMs: number
): Promise<{ readonly timedOut: boolean; readonly failed: boolean; readonly contradiction?: boolean }> {
	let timeoutHandle: NodeJS.Timeout | undefined;
	const timeout = new Promise<'timeout'>(resolve => {
		timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
	});
	const p1Finished = p1.completion.then(result => ({ side: 'p1' as const, result }));
	const p2Finished = p2.completion.then(result => ({ side: 'p2' as const, result }));
	try {
		const first = await Promise.race([p1Finished, p2Finished, timeout]);
		if (first === 'timeout') {
			await Promise.all([terminateProcessTree(p1), terminateProcessTree(p2)]);
			return { timedOut: true, failed: false };
		}
		if (first.result.exitCode !== 0) {
			await terminateProcessTree(first.side === 'p1' ? p2 : p1);
			const contradiction = first.side === 'p1' ? p1.stdout.includes('PDL_BELIEF_CONTRADICTION') : p2.stdout.includes('PDL_BELIEF_CONTRADICTION');
			if (contradiction) return { timedOut: false, failed: true, contradiction: true };
			return { timedOut: false, failed: true };
		}
		const second = await Promise.race([
			first.side === 'p1' ? p2Finished : p1Finished,
			timeout,
		]);
		if (second === 'timeout') {
			await Promise.all([terminateProcessTree(p1), terminateProcessTree(p2)]);
			return { timedOut: true, failed: false };
		}
		if (second.result.exitCode !== 0) {
			const contradiction = second.side === 'p1' ? p1.stdout.includes('PDL_BELIEF_CONTRADICTION') : p2.stdout.includes('PDL_BELIEF_CONTRADICTION');
			if (contradiction) return { timedOut: false, failed: true, contradiction: true };
		}
		return { timedOut: false, failed: second.result.exitCode !== 0 };
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}

function writeProcessLogs(artifact: TrialArtifact, p1: ProcessOutput | null, p2: ProcessOutput | null, showdown: ProcessOutput | null): void {
	if (!p1) writeFileSync(artifact.p1LogPath, '', 'utf8');
	if (!p2) writeFileSync(artifact.p2LogPath, '', 'utf8');
	if (!showdown) writeFileSync(artifact.showdownLogPath, '', 'utf8');
}

/** Executes one trial against a newly started local Showdown process. */
export async function runFoulPlayTrial(input: RunFoulPlayTrialInput): Promise<TrialResult> {
	let showdown: ProcessOutput | null = null;
	let p1: ProcessOutput | null = null;
	let p2: ProcessOutput | null = null;
	let result: TrialResult;
	try {
		const runtime = input.artifact.manifest.metadata?.runtime as { id?: unknown } | undefined;
		if (runtime?.id !== CANONICAL_RUNTIME_ID) {
			throw new Error(`Trial manifest must declare canonical runtime ${CANONICAL_RUNTIME_ID}.`);
		}
		preflightFoulPlayRuntime(input.foulPlayRoot);
		const artifactRoot = resolve(input.artifact.directory);
		const foulRoot = resolve(input.foulPlayRoot);
		if (artifactRoot === foulRoot || artifactRoot.startsWith(`${foulRoot}/`)) {
			throw new Error('Canonical private artifacts must be outside the Foul Play source root.');
		}
		const port = input.port ?? await availablePort();
		writeFileSync(input.artifact.networkAuditPath, '', 'utf8');
		writeFileSync(input.artifact.p1NetworkAuditPath, '', 'utf8');
		writeFileSync(input.artifact.p2NetworkAuditPath, '', 'utf8');
		const showdownEnvironment = { ...offlineRuntimeEnvironment(), PSBINDADDR: '127.0.0.1' };
		showdown = spawnCollectedWithCompleteLog(
			process.execPath,
			['pokemon-showdown', 'start', '--no-security', String(port)],
			input.simulatorRoot,
			input.artifact.showdownLogPath,
			showdownEnvironment,
		);
		await waitForPort(port, Math.min(input.timeoutMs, 10_000));
		const websocketUri = `ws://127.0.0.1:${port}/showdown/websocket`;
		const p1BotName = foulBotName(input.artifact.trialId, 'p1');
		const p2BotName = foulBotName(input.artifact.trialId, 'p2');
		const python = join(input.foulPlayRoot, '.venv', 'bin', 'python');
		const p2Invocation = sandboxedFoulPlayInvocation(input.simulatorRoot, input.artifact.p2PrivateDirectory, port, python, foulPlayArguments({
			websocketUri, username: p2BotName, mode: 'accept_challenge',
			teamId: input.artifact.manifest.p2.teamId, teamPath: input.artifact.p2TeamPath,
			beliefPath: input.artifact.p2BeliefPath, protocolPath: input.artifact.p2ProtocolPath,
			searchTimeMs: input.searchTimeMs, beliefSamples: input.beliefSamples, beliefEngine: input.beliefEngine,
		}));
		p2 = spawnCollectedWithCompleteLog(p2Invocation.command, p2Invocation.args, input.foulPlayRoot, input.artifact.p2LogPath, {
			...offlineRuntimeEnvironment(), TMPDIR: input.artifact.p2PrivateDirectory,
			PDL_OFFLINE_NETWORK_AUDIT_PATH: input.artifact.p2NetworkAuditPath,
		});
		await waitForLog(p2, /Waiting for a gen9pdls4 challenge/, Math.min(input.timeoutMs, 10_000));
		const p1Invocation = sandboxedFoulPlayInvocation(input.simulatorRoot, input.artifact.p1PrivateDirectory, port, python, foulPlayArguments({
			websocketUri, username: p1BotName, mode: 'challenge_user', challengeUser: p2BotName,
			teamId: input.artifact.manifest.p1.teamId, teamPath: input.artifact.p1TeamPath,
			beliefPath: input.artifact.p1BeliefPath, protocolPath: input.artifact.p1ProtocolPath,
			searchTimeMs: input.searchTimeMs, beliefSamples: input.beliefSamples, beliefEngine: input.beliefEngine,
		}));
		p1 = spawnCollectedWithCompleteLog(p1Invocation.command, p1Invocation.args, input.foulPlayRoot, input.artifact.p1LogPath, {
			...offlineRuntimeEnvironment(), TMPDIR: input.artifact.p1PrivateDirectory,
			PDL_OFFLINE_NETWORK_AUDIT_PATH: input.artifact.p1NetworkAuditPath,
		});
		const terminal = await awaitBots(p1, p2, input.timeoutMs);
		if (terminal.timedOut) {
			result = { status: 'timed_out', winnerTeamId: null, failureReason: `Trial exceeded ${input.timeoutMs}ms.` };
		} else if (terminal.failed) {
			if (terminal.contradiction) {
				result = { status: 'rejected', winnerTeamId: null, failureReason: 'PDL_BELIEF_CONTRADICTION' };
			} else {
				result = { status: 'failed', winnerTeamId: null, failureReason: 'A Foul Play client exited unsuccessfully.' };
			}
		} else {
			// A child cannot self-certify by label alone: parse and validate what each
			// running bot resolved from its actual command-line configuration. The
			// bounded in-memory tail deliberately drops early startup lines during
			// verbose MCTS runs, so attestations and winner claims come from the
			// complete parent-owned process logs after both clients exit.
			const p1CompleteLog = readFileSync(input.artifact.p1LogPath, 'utf8');
			const p2CompleteLog = readFileSync(input.artifact.p2LogPath, 'utf8');
			parseRuntimeContractFromLog(p1CompleteLog);
			parseRuntimeContractFromLog(p2CompleteLog);
			const winnerTeamId = determineWinnerTeamId({
				p1Log: p1CompleteLog, p2Log: p2CompleteLog,
				p1: { botName: p1BotName, teamId: input.artifact.manifest.p1.teamId },
				p2: { botName: p2BotName, teamId: input.artifact.manifest.p2.teamId },
			});
			result = winnerTeamId
				? { status: 'completed', winnerTeamId, failureReason: null }
				: { status: 'tied', winnerTeamId: null, failureReason: null };
		}
	} catch (error) {
		result = { status: 'failed', winnerTeamId: null, failureReason: error instanceof Error ? error.message : String(error) };
	} finally {
		await Promise.all([p1, p2, showdown].filter((output): output is ProcessOutput => Boolean(output)).map(output => terminateProcessTree(output)));
		writeProcessLogs(input.artifact, p1, p2, showdown);
		const p1Audit = existsSync(input.artifact.p1NetworkAuditPath) ? readFileSync(input.artifact.p1NetworkAuditPath, 'utf8') : '';
		const p2Audit = existsSync(input.artifact.p2NetworkAuditPath) ? readFileSync(input.artifact.p2NetworkAuditPath, 'utf8') : '';
		writeFileSync(input.artifact.networkAuditPath, p1Audit + p2Audit, 'utf8');
	}
	finalizeTrialArtifact(input.artifact, result);
	writePrivateGroundTruthAudit(input.artifact);
	return result;
}
