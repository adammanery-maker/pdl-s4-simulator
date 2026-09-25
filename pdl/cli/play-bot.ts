import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { get as httpsGet } from 'https';
import { join, resolve } from 'path';
import { TeamValidator } from '../../sim/team-validator';
import { Teams, type PokemonSet } from '../../sim/teams';
import { PDL_FORMAT_ID } from '../format';
import { buildFoulPlayBeliefForSnapshot } from '../sampling/foul-play-export';
import { buildPdlSamplingSnapshotFromLivePayload } from '../sampling/live-snapshot';
import { hashSamplingSnapshot } from '../sampling/snapshot';
import type { PdlSamplingSnapshot } from '../sampling/types';
import { validatePdlTeam } from '../validate-team';

const DEFAULT_LIVE_URL = 'https://pdl-s4.vercel.app/api/roster-transactions';
const DEFAULT_FOUL_ROOT = '/Users/amanery/PDL Vercel App/pdl-s4-foul-play';
const OUTPUT_ROOT = '/private/tmp';

export interface PlayBotOptions {
	readonly teamId: string;
	readonly opponentTeamId: string;
	readonly teamFile: string;
	readonly liveUrl: string;
	readonly foulRoot: string;
	readonly port: number;
	readonly searchTimeMs: number;
	readonly outputDirectory: string;
	readonly runCount: number;
}

interface ProcessOutput {
	readonly child: ChildProcessWithoutNullStreams;
	stdout: string;
	stderr: string;
}

function required(values: Map<string, string>, name: string): string {
	const value = values.get(name);
	if (!value) throw new Error(`Missing required --${name}.`);
	return value;
}

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`--${name} must be an integer from 1 to 65535.`);
	return parsed;
}

function outputDirectory(teamId: string): string {
	const safeId = teamId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
	if (!safeId) throw new Error('--team-id must contain letters or numbers.');
	return join(OUTPUT_ROOT, `pdl-play-${safeId}-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`);
}

/** Parses a narrow local-only human-versus-Foul Play launcher contract. */
export function parsePlayBotArguments(argv: readonly string[]): PlayBotOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('Arguments must use --name value pairs.');
		const name = key.slice(2);
		if (!['team-id', 'opponent-team-id', 'team-file', 'live-url', 'foul-root', 'port', 'search-ms', 'output', 'run-count'].includes(name)) throw new Error(`Unknown --${name}.`);
		if (values.has(name)) throw new Error(`--${name} may only be supplied once.`);
		values.set(name, value);
	}
	const teamId = required(values, 'team-id');
	const configuredOutput = values.get('output');
	if (configuredOutput && !resolve(configuredOutput).startsWith(`${OUTPUT_ROOT}/`)) {
		throw new Error(`--output must be inside ${OUTPUT_ROOT}.`);
	}
	return {
		teamId,
		opponentTeamId: required(values, 'opponent-team-id'),
		teamFile: required(values, 'team-file'),
		liveUrl: values.get('live-url') || DEFAULT_LIVE_URL,
		foulRoot: values.get('foul-root') || DEFAULT_FOUL_ROOT,
		port: values.has('port') ? positiveInteger(required(values, 'port'), 'port') : 8000,
		searchTimeMs: values.has('search-ms') ? positiveInteger(required(values, 'search-ms'), 'search-ms') : 250,
		outputDirectory: configuredOutput ? resolve(configuredOutput) : outputDirectory(teamId),
		runCount: values.has('run-count') ? Number(values.get('run-count')) : 0,
	};
}

/** Official client test page, pointed at this one local unauthenticated server. */
export function buildHumanClientUrl(port: number): string {
	return `https://play.pokemonshowdown.com/testclient.html?~~localhost:${port}`;
}

/** Exact ready line emitted by the pinned local Showdown server. */
export function buildServerReadyPattern(port: number): RegExp {
	return new RegExp(`now listening on .*:${port}`);
}

function readLiveJson(url: string): Promise<unknown> {
	return new Promise((resolvePromise, reject) => {
		httpsGet(url, response => {
			if (response.statusCode !== 200) {
				response.resume();
				reject(new Error(`Live roster request returned HTTP ${response.statusCode}.`));
				return;
			}
			let body = '';
			response.setEncoding('utf8');
			response.on('data', chunk => { body += chunk; });
			response.once('end', () => {
				try { resolvePromise(JSON.parse(body)); } catch (error) { reject(error); }
			});
		}).once('error', reject);
	});
}

function toLeague(snapshot: PdlSamplingSnapshot) {
	return { teams: snapshot.roster.teams.map(team => ({
		id: team.id, name: team.name, draftedTeraTypes: [...team.draftedTeraTypes], roster: team.roster.map(pokemon => ({ ...pokemon })),
	})) };
}

/** Rejects bot exports that are malformed, Showdown-illegal, or not part of its current PDL roster. */
export function validatePlayBotTeam(snapshot: PdlSamplingSnapshot, teamId: string, exportedTeam: string): PokemonSet[] {
	const team = Teams.import(exportedTeam);
	if (!team) throw new Error('Could not parse --team-file as a Pokémon Showdown team export.');
	const errors = [
		...validatePdlTeam({ league: toLeague(snapshot), teamId, team }),
		...(TeamValidator.get(PDL_FORMAT_ID).validateTeam(team) || []),
	];
	if (errors.length) throw new Error(`Bot team is invalid:\n${errors.join('\n')}`);
	return team;
}

function spawnCollected(command: string, args: string[], cwd: string): ProcessOutput {
	const child = spawn(command, args, { cwd, stdio: 'pipe' });
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', chunk => { stdout += chunk; });
	child.stderr.on('data', chunk => { stderr += chunk; });
	return { child, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function stop(processOutput: ProcessOutput | null): void {
	if (processOutput && !processOutput.child.killed && processOutput.child.exitCode === null) processOutput.child.kill('SIGTERM');
}

async function waitFor(output: ProcessOutput, pattern: RegExp, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pattern.test(output.stdout)) return;
		if (output.child.exitCode !== null) throw new Error(`Process exited before becoming ready:\n${output.stderr}`);
		await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
	}
	throw new Error(`Timed out waiting for ${pattern}.`);
}

/** Starts a local human-versus-Foul Play session and stops both children on Ctrl-C. */
export async function runPlayBot(options: PlayBotOptions): Promise<string> {
	if (existsSync(options.outputDirectory)) throw new Error(`Output directory already exists: ${options.outputDirectory}`);
	if (!existsSync(options.teamFile)) throw new Error(`Bot team file does not exist: ${options.teamFile}`);
	const simulatorRoot = resolve(__dirname, '..', '..', '..');
	const foulPython = join(resolve(options.foulRoot), '.venv', 'bin', 'python');
	if (!existsSync(foulPython)) throw new Error(`Foul Play virtualenv Python does not exist: ${foulPython}`);
	const snapshot = buildPdlSamplingSnapshotFromLivePayload(await readLiveJson(options.liveUrl));
	const exportedTeam = readFileSync(options.teamFile, 'utf8');
	validatePlayBotTeam(snapshot, options.teamId, exportedTeam);
	mkdirSync(options.outputDirectory, { recursive: false });
	const belief = buildFoulPlayBeliefForSnapshot(snapshot, [options.teamId, options.opponentTeamId]);
	const beliefPath = join(options.outputDirectory, 'belief.json');
	const botLogPath = join(options.outputDirectory, 'foul-play.log');
	const protocolPath = join(options.outputDirectory, 'foul-play.protocol');
	const showdownLogPath = join(options.outputDirectory, 'showdown.log');
	writeFileSync(join(options.outputDirectory, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
	writeFileSync(beliefPath, `${JSON.stringify(belief, null, 2)}\n`, 'utf8');
	writeFileSync(join(options.outputDirectory, 'bot-team.txt'), exportedTeam, 'utf8');
	writeFileSync(join(options.outputDirectory, 'session.json'), `${JSON.stringify({ schemaVersion: 1, teamId: options.teamId, opponentTeamId: options.opponentTeamId, port: options.port, clientUrl: buildHumanClientUrl(options.port), snapshotHash: hashSamplingSnapshot(snapshot) }, null, 2)}\n`, 'utf8');
	let showdown: ProcessOutput | null = null;
	let foulPlay: ProcessOutput | null = null;
	const finish = () => {
		if (showdown) writeFileSync(showdownLogPath, `${showdown.stdout}${showdown.stderr}`, 'utf8');
		if (foulPlay) writeFileSync(botLogPath, `${foulPlay.stdout}${foulPlay.stderr}`, 'utf8');
		stop(foulPlay);
		stop(showdown);
	};
	try {
		showdown = spawnCollected(process.execPath, ['pokemon-showdown', 'start', '--no-security', String(options.port)], simulatorRoot);
		await waitFor(showdown, buildServerReadyPattern(options.port), 10_000);
		foulPlay = spawnCollected(foulPython, [
			'run.py', '--websocket-uri', `ws://127.0.0.1:${options.port}/showdown/websocket`,
			'--ps-username', 'PDL Foul Play', '--bot-mode', 'accept_challenge', '--pokemon-format', PDL_FORMAT_ID,
			'--pdl-belief-data', beliefPath, '--pdl-team-id', options.teamId, '--team-name', options.teamFile,
			'--protocol-log-path', protocolPath, '--local-no-security', '--search-time-ms', String(options.searchTimeMs),
			'--run-count', String(options.runCount), '--log-level', 'INFO',
		], resolve(options.foulRoot));
		await waitFor(foulPlay, /Waiting for a gen9pdls4 challenge/, 10_000);
		process.stdout.write(`PDL Foul Play is ready. Open:\n${buildHumanClientUrl(options.port)}\n\nChoose a guest name, import six Pokémon from ${options.opponentTeamId}'s current PDL roster, then challenge: PDL Foul Play\nArtifacts: ${options.outputDirectory}\nPress Ctrl-C after the battle to stop the local session.\n`);
		await new Promise<void>(resolvePromise => {
			const done = () => resolvePromise();
			process.once('SIGINT', done);
			process.once('SIGTERM', done);
			if (options.runCount > 0) foulPlay!.child.once('close', done);
			showdown!.child.once('close', done);
		});
		return options.outputDirectory;
	} finally {
		finish();
	}
}

if (require.main === module) {
	runPlayBot(parsePlayBotArguments(process.argv.slice(2))).catch(error => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
