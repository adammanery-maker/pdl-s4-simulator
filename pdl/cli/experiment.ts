import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { get as httpsGet } from 'https';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { SHOWDOWN_COMMIT } from '../simulate';
import { aggregateCompletedPairedTrials, countTerminalPairs, type AnalysisTrial } from '../analysis/aggregate';
import { createTrialArtifact } from '../batch/artifacts';
import { CANONICAL_RUNTIME } from '../batch/runtime';
import { foulBotName, runFoulPlayTrial } from '../batch/run-trial';
import { buildFoulPlayArtifactsFromSamples } from '../sampling/foul-play-export';
import { buildPdlSamplingSnapshotFromLivePayload } from '../sampling/live-snapshot';
import { hashSamplingSnapshot, normalizePdlSamplingSnapshot } from '../sampling/snapshot';
import type { PdlSamplingSnapshot } from '../sampling/types';
import { buildBalancedCrossSchedule } from '../experiments/schedule';
import { readExperimentPlan } from '../experiments/parse-plan';
import { resolveExperimentVariants } from '../experiments/resolve-variants';
import { applyTemporaryFreeAgents } from '../experiments/free-agents';
import type { ExperimentPlan, ExperimentScenarioMetadata, ResolvedExperimentVariant } from '../experiments/types';
import { renderSimulationReport, type ExperimentReportMetadata } from '../report/render';

const BELIEF_SAMPLES = 8;

export type ExperimentCommandOptions =
	| { readonly planPath: string; readonly resumeDirectory?: never }
	| { readonly resumeDirectory: string; readonly planPath?: never };

function required(values: Map<string, string>, name: string): string {
	const value = values.get(name);
	if (!value) throw new Error(`Missing required --${name}.`);
	return value;
}

/** Parses a new plan or resumes an immutable existing experiment directory. */
export function parseExperimentArguments(argv: readonly string[]): ExperimentCommandOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('Arguments must use --name value pairs.');
		const name = key.slice(2);
		if (values.has(name)) throw new Error(`--${name} may only be supplied once.`);
		values.set(name, value);
	}
	if (values.size !== 1 || (!values.has('plan') && !values.has('resume'))) throw new Error('Experiment runner accepts exactly one of --plan <path|-> or --resume <existing directory>.');
	if (values.has('resume')) return { resumeDirectory: required(values, 'resume') };
	return { planPath: required(values, 'plan') };
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

async function loadSnapshot(plan: ExperimentPlan): Promise<PdlSamplingSnapshot> {
	if (plan.source?.liveUrl) return buildPdlSamplingSnapshotFromLivePayload(await readLiveJson(plan.source.liveUrl));
	return normalizePdlSamplingSnapshot(JSON.parse(readFileSync(plan.source!.snapshotPath!, 'utf8')));
}

function gitRevision(root: string): string {
	try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
	catch { return 'unavailable'; }
}

function protocol(path: string): string { return existsSync(path) ? readFileSync(path, 'utf8') : ''; }

function readRecordedTrials(path: string): AnalysisTrial[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AnalysisTrial);
}

function archiveInterruptedArtifact(outputDirectory: string, trialId: string, resumeId: string): void {
	const source = resolve(outputDirectory, 'trials', trialId);
	if (!existsSync(source)) return;
	const destinationRoot = resolve(outputDirectory, 'interrupted-trials');
	mkdirSync(destinationRoot, { recursive: true });
	renameSync(source, resolve(destinationRoot, `${trialId}-${resumeId}`));
}

function statusCounts(trials: readonly AnalysisTrial[]) {
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

function resolvedById(variants: readonly ResolvedExperimentVariant[]): Map<string, ResolvedExperimentVariant> {
	return new Map(variants.map(variant => [variant.id, variant]));
}

function scenario(plan: ExperimentPlan, leftVariantId: string, rightVariantId: string, cellId: string): ExperimentScenarioMetadata {
	return { leftTeamId: plan.teams.left.teamId, rightTeamId: plan.teams.right.teamId, leftVariantId, rightVariantId, cellId };
}

function experimentReportMetadata(plan: ExperimentPlan, resolved: ReturnType<typeof resolveExperimentVariants>, totalPairs: number): ExperimentReportMetadata {
	const summarize = (variants: readonly ResolvedExperimentVariant[]) => variants.map(variant => ({
		id: variant.id, teamId: variant.teamId, species: variant.team.map(set => set.species),
	}));
	return {
		leftTeamId: plan.teams.left.teamId, rightTeamId: plan.teams.right.teamId, totalPairs,
		leftVariants: summarize(resolved.left), rightVariants: summarize(resolved.right),
	};
}

function matchupSnapshot(snapshot: PdlSamplingSnapshot, left: ResolvedExperimentVariant, right: ResolvedExperimentVariant): PdlSamplingSnapshot {
	let result = snapshot;
	for (const variant of [left, right]) {
		if (variant.temporaryFreeAgents.length) {
			result = applyTemporaryFreeAgents({ snapshot: result, teamId: variant.teamId, additions: variant.temporaryFreeAgents });
		}
	}
	return result;
}

function sampleForSnapshot(variant: ResolvedExperimentVariant, snapshot: PdlSamplingSnapshot) {
	return { ...variant.sample, snapshotHash: hashSamplingSnapshot(snapshot) };
}

/** Runs a plan whose variants were frozen exactly once before any local battle starts. */
export async function runExperiment(options: ExperimentCommandOptions): Promise<string> {
	const resuming = 'resumeDirectory' in options;
	const requestedResumeDirectory = options.resumeDirectory ? resolve(options.resumeDirectory) : undefined;
	if (requestedResumeDirectory && !existsSync(requestedResumeDirectory)) throw new Error(`Resume directory does not exist: ${requestedResumeDirectory}`);
	const storedPlan = resuming ? readExperimentPlan(`${requestedResumeDirectory}/plan.source.json`) : readExperimentPlan(options.planPath!);
	const { sourceText, plan } = storedPlan;
	const outputDirectory = requestedResumeDirectory || resolve(plan.simulation.output);
	if (requestedResumeDirectory && resolve(plan.simulation.output) !== outputDirectory) throw new Error('Resume directory does not match the frozen experiment plan output directory.');
	if (!resuming) mkdirSync(outputDirectory, { recursive: false });
	const simulatorRoot = resolve(__dirname, '..', '..', '..');
	const foulPlayRoot = resolve(plan.simulation.foulRoot);
	const snapshot = resuming
		? normalizePdlSamplingSnapshot(JSON.parse(readFileSync(`${outputDirectory}/snapshot.json`, 'utf8')))
		: await loadSnapshot(plan);
	const snapshotHash = hashSamplingSnapshot(snapshot);
	const resolved = resuming
		? JSON.parse(readFileSync(`${outputDirectory}/plan.resolved.json`, 'utf8')) as ReturnType<typeof resolveExperimentVariants>
		: resolveExperimentVariants({ plan, snapshot });
	const storedRun = resuming ? JSON.parse(readFileSync(`${outputDirectory}/run.json`, 'utf8')) as { readonly snapshotHash?: string; readonly planHash?: string; readonly runtime?: { readonly id?: string } } : undefined;
	if (storedRun && storedRun.runtime?.id !== CANONICAL_RUNTIME.id) throw new Error(`Cannot resume a run without canonical runtime ${CANONICAL_RUNTIME.id}.`);
	if (storedRun && (storedRun.snapshotHash !== snapshotHash || storedRun.planHash !== resolved.planHash)) throw new Error('Frozen experiment metadata does not match its saved snapshot or resolved variants.');
	const schedule = buildBalancedCrossSchedule(resolved);
	const leftById = resolvedById(resolved.left);
	const rightById = resolvedById(resolved.right);
	const totalTrials = schedule.length * 2;
	const startedAt = Date.now();
	if (!resuming) {
		writeFileSync(`${outputDirectory}/plan.source.json`, `${sourceText}\n`, 'utf8');
		writeFileSync(`${outputDirectory}/plan.resolved.json`, `${JSON.stringify(resolved, null, 2)}\n`, 'utf8');
		writeFileSync(`${outputDirectory}/snapshot.json`, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
		writeFileSync(`${outputDirectory}/run.json`, `${JSON.stringify({ schemaVersion: 1, runtime: CANONICAL_RUNTIME, snapshotHash, showdownCommit: SHOWDOWN_COMMIT, foulPlayRevision: gitRevision(foulPlayRoot), totalPairs: schedule.length, planHash: resolved.planHash, beliefSamples: BELIEF_SAMPLES }, null, 2)}\n`, 'utf8');
	}

	const recordedTrials = resuming ? readRecordedTrials(`${outputDirectory}/trials.jsonl`) : [];
	const interrupted = recordedTrials.filter(trial => trial.status !== 'completed' && trial.status !== 'tied');
	if (resuming && interrupted.length) {
		const resumeId = new Date().toISOString().replace(/[:.]/g, '-');
		writeFileSync(`${outputDirectory}/trials.interrupted-${resumeId}.jsonl`, `${interrupted.map(trial => JSON.stringify(trial)).join('\n')}\n`, 'utf8');
		for (const trial of interrupted) archiveInterruptedArtifact(outputDirectory, `${trial.pairId}-${trial.side}`, resumeId);
	}
	const trials: AnalysisTrial[] = recordedTrials.filter(trial => trial.status === 'completed' || trial.status === 'tied');
	if (resuming) writeFileSync(`${outputDirectory}/trials.jsonl`, trials.map(trial => JSON.stringify(trial)).join(trials.length ? '\n' : '') + (trials.length ? '\n' : ''), 'utf8');
	const completedTrialIds = new Set(trials.map(trial => `${trial.pairId}-${trial.side}`));
	const resumeId = new Date().toISOString().replace(/[:.]/g, '-');
	for (const scheduled of schedule) {
		const forwardTrialId = `${scheduled.pairId}-forward`;
		const reverseTrialId = `${scheduled.pairId}-reverse`;
		if (completedTrialIds.has(forwardTrialId) && completedTrialIds.has(reverseTrialId)) continue;
		const left = leftById.get(scheduled.leftVariantId)!;
		const right = rightById.get(scheduled.rightVariantId)!;
		const scenarioMetadata = scenario(plan, left.id, right.id, scheduled.cellId);
		for (const side of ['forward', 'reverse'] as const) {
			const trialId = side === 'forward' ? forwardTrialId : reverseTrialId;
			if (completedTrialIds.has(trialId)) continue;
			const first = side === 'forward' ? left : right;
			const second = side === 'forward' ? right : left;
			const pairSnapshot = matchupSnapshot(snapshot, left, right);
			const artifacts = buildFoulPlayArtifactsFromSamples({
				snapshot: pairSnapshot, p1TeamId: first.teamId, p2TeamId: second.teamId,
				p1Sample: sampleForSnapshot(first, pairSnapshot), p2Sample: sampleForSnapshot(second, pairSnapshot),
			});
			archiveInterruptedArtifact(outputDirectory, trialId, resumeId);
			const artifact = createTrialArtifact({
				outputDirectory, trialId,
				manifest: {
					schemaVersion: 1, pairId: scheduled.pairId, side,
					p1: { teamId: first.teamId, packed: artifacts.teams[first.teamId].packed, exported: artifacts.teams[first.teamId].exported },
					p2: { teamId: second.teamId, packed: artifacts.teams[second.teamId].packed, exported: artifacts.teams[second.teamId].exported },
					metadata: { snapshotHash, scenario: scenarioMetadata, samplerSeeds: { [left.id]: left.samplerSeed, [right.id]: right.samplerSeed }, showdownCommit: SHOWDOWN_COMMIT, foulPlayRevision: gitRevision(foulPlayRoot), searchTimeMs: plan.simulation.searchMs, beliefSamples: BELIEF_SAMPLES, timeoutMs: plan.simulation.timeoutMs || 120_000 },
				}, belief: artifacts.belief,
			});
			const result = await runFoulPlayTrial({ simulatorRoot, foulPlayRoot, artifact, searchTimeMs: plan.simulation.searchMs, beliefSamples: BELIEF_SAMPLES, timeoutMs: plan.simulation.timeoutMs || 120_000 });
			const analysisTrial: AnalysisTrial = {
				runtimeId: CANONICAL_RUNTIME.id, pairId: scheduled.pairId, side, status: result.status, winnerTeamId: result.winnerTeamId,
				p1: { teamId: first.teamId, botName: foulBotName(trialId, 'p1'), packed: artifacts.teams[first.teamId].packed },
				p2: { teamId: second.teamId, botName: foulBotName(trialId, 'p2'), packed: artifacts.teams[second.teamId].packed },
				protocol: protocol(artifact.p1ProtocolPath), scenario: scenarioMetadata,
			};
			trials.push(analysisTrial);
			appendFileSync(`${outputDirectory}/trials.jsonl`, `${JSON.stringify({ ...analysisTrial, artifact: artifact.directory, failureReason: result.failureReason })}\n`, 'utf8');
			const elapsedMs = Date.now() - startedAt;
			const etaMs = elapsedMs / trials.length * (totalTrials - trials.length);
			writeFileSync(`${outputDirectory}/progress.json`, `${JSON.stringify({ completed: trials.length, total: totalTrials, currentCell: scheduled.cellId, status: result.status, ...statusCounts(trials), elapsedMs, etaMs, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
			process.stdout.write(`[${trials.length}/${totalTrials}] ${scheduled.cellId} ${side} ${result.status}\n`);
		}
	}
	const analysis = aggregateCompletedPairedTrials(trials);
	const counts = statusCounts(trials);
	const summary = { schemaVersion: 1, metadata: { runtime: CANONICAL_RUNTIME, snapshotHash, ...counts, planHash: resolved.planHash, beliefSamples: BELIEF_SAMPLES, schedule: { strategy: plan.schedule.strategy, totalPairs: schedule.length }, experiment: experimentReportMetadata(plan, resolved, schedule.length) }, analysis };
	writeFileSync(`${outputDirectory}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
	writeFileSync(`${outputDirectory}/report.html`, renderSimulationReport(summary), 'utf8');
	if (!countTerminalPairs(trials)) throw new Error(`No terminal side-balanced trials finished. Inspect ${outputDirectory}/trials.jsonl.`);
	return outputDirectory;
}

if (require.main === module) {
	runExperiment(parseExperimentArguments(process.argv.slice(2)))
		.then(output => { process.stdout.write(`PDL experiment report: ${output}/report.html\n`); })
		.catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
