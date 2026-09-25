import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { get as httpsGet } from 'https';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import type { PRNGSeed } from '../../sim/prng';
import { SHOWDOWN_COMMIT } from '../simulate';
import { aggregateCompletedPairedTrials, countTerminalPairs, type AnalysisTrial } from '../analysis/aggregate';
import { createTrialArtifact } from '../batch/artifacts';
import { foulBotName, runFoulPlayTrial } from '../batch/run-trial';
import { buildFoulPlayMatchArtifacts } from '../sampling/foul-play-export';
import { normalizeTeamSelectionConstraints, parseLockedBuild } from '../sampling/constraints';
import { buildPdlSamplingSnapshotFromLivePayload } from '../sampling/live-snapshot';
import { hashSamplingSnapshot, normalizePdlSamplingSnapshot } from '../sampling/snapshot';
import type { NormalizedPdlTeamSelectionConstraints, PdlSamplingSnapshot } from '../sampling/types';
import { renderSimulationReport } from '../report/render';
import { CANONICAL_RUNTIME } from '../batch/runtime';

export interface MatchupOptions {
	readonly liveUrl: string | null;
	readonly snapshotPath: string | null;
	readonly teamA: string;
	readonly teamB: string;
	readonly pairs: number;
	readonly searchTimeMs: number;
	readonly beliefSamples: number;
	readonly timeoutMs: number;
	readonly foulRoot: string;
	readonly outputDirectory: string;
	readonly constraintsA: NormalizedPdlTeamSelectionConstraints;
	readonly constraintsB: NormalizedPdlTeamSelectionConstraints;
}

export interface SimulationProgress {
	readonly completed: number;
	readonly total: number;
	readonly winnerTeamId: string | null;
	readonly status: 'completed' | 'tied' | 'rejected' | 'failed' | 'timed_out';
	readonly rejected: number;
	readonly failed: number;
	readonly timedOut: number;
	readonly tied: number;
	readonly etaMs: number | null;
}

function displayTeamId(teamId: string): string {
	return teamId ? `${teamId[0].toUpperCase()}${teamId.slice(1)}` : 'Unknown';
}

function formatDuration(milliseconds: number | null): string {
	if (milliseconds === null || !Number.isFinite(milliseconds)) return 'calculating';
	const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.ceil(seconds / 60)}m`;
}

/** One concise line per finished trial for unattended terminal runs. */
export function formatProgressLine(progress: SimulationProgress): string {
	const outcome = progress.status === 'completed' && progress.winnerTeamId
		? `completed — ${displayTeamId(progress.winnerTeamId)} won`
		: progress.status.replace('_', ' ');
	return `[${progress.completed}/${progress.total}] ${outcome} — ${progress.tied || 0} tied — ${progress.rejected} rejected — ${progress.failed} failed — ${progress.timedOut} timed out — ETA ${formatDuration(progress.etaMs)}`;
}

function required(options: Map<string, readonly string[]>, name: string): string {
	const value = options.get(name)?.[0];
	if (!value) throw new Error(`Missing required --${name}.`);
	return value;
}

function single(options: Map<string, readonly string[]>, name: string): string | undefined {
	const values = options.get(name);
	if (!values?.length) return undefined;
	if (values.length !== 1) throw new Error(`--${name} may only be supplied once.`);
	return values[0];
}

function speciesValues(options: Map<string, readonly string[]>, name: string): string[] {
	return (options.get(name) || []).flatMap(value => value.split(',').map(species => species.trim()).filter(Boolean));
}

function constraintsFromOptions(options: Map<string, readonly string[]>, side: 'a' | 'b'): NormalizedPdlTeamSelectionConstraints {
	return normalizeTeamSelectionConstraints({
		requiredSpecies: speciesValues(options, `require-${side}`),
		excludedSpecies: speciesValues(options, `exclude-${side}`),
		lockedSets: (options.get(`lock-${side}`) || []).map(parseLockedBuild),
	});
}

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer.`);
	return parsed;
}

/** Parses the deliberately small, explicit terminal interface for a local batch. */
export function parseMatchupArguments(argv: readonly string[]): MatchupOptions {
	const values = new Map<string, readonly string[]>();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error('Arguments must use --name value pairs.');
		const name = key.slice(2);
		const existing = values.get(name) || [];
		if (existing.length && name !== 'lock-a' && name !== 'lock-b' && name !== 'require-a' && name !== 'require-b' && name !== 'exclude-a' && name !== 'exclude-b') {
			throw new Error(`--${name} may only be supplied once.`);
		}
		values.set(name, [...existing, value]);
	}
	const liveUrl = single(values, 'live-url') || null;
	const snapshotPath = single(values, 'snapshot') || null;
	if (Number(Boolean(liveUrl)) + Number(Boolean(snapshotPath)) !== 1) {
		throw new Error('Provide exactly one of --live-url or --snapshot.');
	}
	return {
		liveUrl,
		snapshotPath,
		teamA: required(values, 'team-a'),
		teamB: required(values, 'team-b'),
		pairs: positiveInteger(required(values, 'battles'), 'battles'),
		searchTimeMs: positiveInteger(required(values, 'search-ms'), 'search-ms'),
		beliefSamples: positiveInteger(values.get('belief-samples')?.[0] || '8', 'belief-samples'),
		timeoutMs: values.has('timeout-ms') ? positiveInteger(required(values, 'timeout-ms'), 'timeout-ms') : 120_000,
		foulRoot: required(values, 'foul-root'),
		outputDirectory: required(values, 'output'),
		constraintsA: constraintsFromOptions(values, 'a'),
		constraintsB: constraintsFromOptions(values, 'b'),
	};
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

async function loadSnapshot(options: MatchupOptions): Promise<PdlSamplingSnapshot> {
	if (options.liveUrl) return buildPdlSamplingSnapshotFromLivePayload(await readLiveJson(options.liveUrl));
	const raw = JSON.parse(readFileSync(options.snapshotPath!, 'utf8'));
	return normalizePdlSamplingSnapshot(raw);
}

function seed(pairIndex: number, lane: number): PRNGSeed {
	return `gen5,00000000,00000000,${(pairIndex * 4 + lane).toString(16).padStart(8, '0')}`;
}

function gitRevision(root: string): string {
	try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
	catch { return 'unavailable'; }
}

function protocol(path: string): string {
	return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function statusCounts(trials: readonly AnalysisTrial[]): { completedTrials: number; tiedTrials: number; rejectedTrials: number; failedTrials: number; timedOutTrials: number } {
	const counts = { completedTrials: 0, tiedTrials: 0, rejectedTrials: 0, failedTrials: 0, timedOutTrials: 0 };
	for (const trial of trials) {
		if (trial.status === 'completed') counts.completedTrials++;
		if (trial.status === 'tied') counts.tiedTrials++;
		if (trial.status === 'rejected') counts.rejectedTrials++;
		if (trial.status === 'failed') counts.failedTrials++;
		if (trial.status === 'timed_out') counts.timedOutTrials++;
	}
	return counts;
}

function trialId(pairIndex: number, side: 'forward' | 'reverse'): string {
	return `pair-${String(pairIndex + 1).padStart(4, '0')}-${side}`;
}

export async function runLocalMatchup(options: MatchupOptions): Promise<string> {
	const outputDirectory = resolve(options.outputDirectory);
	mkdirSync(outputDirectory, { recursive: false });
	const simulatorRoot = resolve(__dirname, '..', '..', '..');
	const foulPlayRoot = resolve(options.foulRoot);
	const snapshot = await loadSnapshot(options);
	const snapshotHash = hashSamplingSnapshot(snapshot);
	const startedAt = Date.now();
	const totalTrials = options.pairs * 2;
	writeFileSync(`${outputDirectory}/snapshot.json`, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
	writeFileSync(`${outputDirectory}/run.json`, `${JSON.stringify({
		schemaVersion: 1, runtime: CANONICAL_RUNTIME, snapshotHash, showdownCommit: SHOWDOWN_COMMIT, foulPlayRevision: gitRevision(foulPlayRoot), options,
	}, null, 2)}\n`, 'utf8');

	const analysisTrials: AnalysisTrial[] = [];
	for (let pairIndex = 0; pairIndex < options.pairs; pairIndex++) {
		const artifacts = buildFoulPlayMatchArtifacts({
			snapshot, p1TeamId: options.teamA, p2TeamId: options.teamB, p1Seed: seed(pairIndex, 1), p2Seed: seed(pairIndex, 2),
			p1Constraints: options.constraintsA, p2Constraints: options.constraintsB,
		});
		for (const side of ['forward', 'reverse'] as const) {
			const firstTeamId = side === 'forward' ? options.teamA : options.teamB;
			const secondTeamId = side === 'forward' ? options.teamB : options.teamA;
			const id = trialId(pairIndex, side);
			const artifact = createTrialArtifact({
				outputDirectory,
				trialId: id,
				manifest: {
					schemaVersion: 1, pairId: `pair-${String(pairIndex + 1).padStart(4, '0')}`, side,
					p1: { teamId: firstTeamId, packed: artifacts.teams[firstTeamId].packed, exported: artifacts.teams[firstTeamId].exported },
					p2: { teamId: secondTeamId, packed: artifacts.teams[secondTeamId].packed, exported: artifacts.teams[secondTeamId].exported },
					metadata: {
						snapshotHash, samplerSeeds: { [options.teamA]: seed(pairIndex, 1), [options.teamB]: seed(pairIndex, 2) },
						constraints: { [options.teamA]: artifacts.teams[options.teamA].sample.constraints, [options.teamB]: artifacts.teams[options.teamB].sample.constraints },
						showdownCommit: SHOWDOWN_COMMIT, foulPlayRevision: gitRevision(foulPlayRoot), searchTimeMs: options.searchTimeMs, beliefSamples: options.beliefSamples, timeoutMs: options.timeoutMs,
					},
				},
				belief: artifacts.belief,
			});
			const result = await runFoulPlayTrial({ simulatorRoot, foulPlayRoot, artifact, searchTimeMs: options.searchTimeMs, beliefSamples: options.beliefSamples, timeoutMs: options.timeoutMs });
			const p1 = { teamId: firstTeamId, botName: foulBotName(id, 'p1'), packed: artifacts.teams[firstTeamId].packed };
			const p2 = { teamId: secondTeamId, botName: foulBotName(id, 'p2'), packed: artifacts.teams[secondTeamId].packed };
			const analysisTrial: AnalysisTrial = { runtimeId: CANONICAL_RUNTIME.id, pairId: artifact.manifest.pairId, side, status: result.status, winnerTeamId: result.winnerTeamId, p1, p2, protocol: protocol(artifact.p1ProtocolPath) };
			analysisTrials.push(analysisTrial);
			appendFileSync(`${outputDirectory}/trials.jsonl`, `${JSON.stringify({ ...analysisTrial, artifact: artifact.directory, failureReason: result.failureReason })}\n`, 'utf8');
			const counts = statusCounts(analysisTrials);
			const elapsedMs = Date.now() - startedAt;
			const etaMs = analysisTrials.length ? elapsedMs / analysisTrials.length * (totalTrials - analysisTrials.length) : null;
			const progress: SimulationProgress = {
				completed: analysisTrials.length, total: totalTrials, winnerTeamId: result.winnerTeamId, status: result.status,
				rejected: counts.rejectedTrials, failed: counts.failedTrials, timedOut: counts.timedOutTrials, tied: counts.tiedTrials, etaMs,
			};
			writeFileSync(`${outputDirectory}/progress.json`, `${JSON.stringify({ ...progress, elapsedMs, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
			process.stdout.write(`${formatProgressLine(progress)}\n`);
		}
	}
	const analysis = aggregateCompletedPairedTrials(analysisTrials);
	const counts = statusCounts(analysisTrials);
	const summary = { schemaVersion: 1, metadata: { runtime: CANONICAL_RUNTIME, snapshotHash, ...counts, constraints: { [options.teamA]: options.constraintsA, [options.teamB]: options.constraintsB } }, analysis };
	writeFileSync(`${outputDirectory}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
	writeFileSync(`${outputDirectory}/report.html`, renderSimulationReport(summary), 'utf8');
	if (!countTerminalPairs(analysisTrials)) throw new Error(`No terminal side-balanced trials finished. Inspect ${outputDirectory}/trials.jsonl.`);
	return outputDirectory;
}

if (require.main === module) {
	runLocalMatchup(parseMatchupArguments(process.argv.slice(2)))
		.then(outputDirectory => { process.stdout.write(`PDL simulation report: ${outputDirectory}/report.html\n`); })
		.catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
