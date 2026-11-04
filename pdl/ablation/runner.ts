import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { Teams } from '../../sim/teams';
import { toID } from '../../sim/dex-data';
import { createTrialArtifact } from '../batch/artifacts';
import { buildTrialEvidence } from '../batch/evidence';
import { CANONICAL_RUNTIME, CANONICAL_EVALUATOR_ID, CANONICAL_EVALUATOR_SHA256 } from '../batch/runtime';
import { runFoulPlayTrial } from '../batch/run-trial';
import { loadFixedScenario, privateBeliefFor, type FixedBuild, type FixedScenarioTeam } from '../fixed/scenario';
import {
	analyzeAblationProtocol, assertAAReproducible, buildPairedSchedule, resolvePreset,
	summarizePairedOutcomes, trustWarning, validateAblationDefinition,
	type AblationChange, type ExploreAblationOptions, type PairedOutcome, type TrustMatrix,
} from './index';

interface TeamReference { readonly id: string; readonly teamPath: string; readonly teraCaptains: readonly string[] }
export interface AblationManifest {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly scenarioPath: string;
	readonly subjectTeamId: string;
	readonly opponentTeamId: string;
	readonly baseline: TeamReference;
	readonly candidate: TeamReference;
	readonly change: AblationChange;
	readonly opponentBuildIds: readonly string[];
	readonly decisionDomains: readonly string[];
}

interface LoadedManifest extends AblationManifest {
	readonly absoluteScenarioPath: string;
	readonly baselineExported: string;
	readonly candidateExported: string;
	readonly baselineTeamPath: string;
	readonly candidateTeamPath: string;
}

interface VariantResult {
	readonly variant: 'baseline' | 'candidate';
	readonly result: { readonly status: string, readonly winnerTeamId: string | null, readonly failureReason: string | null };
	readonly artifact: string;
	readonly auditStatus: string;
	readonly subjectWon: boolean;
	readonly resultDigest: string;
	readonly decisionDigest: string;
	readonly metrics: ReturnType<typeof analyzeAblationProtocol>;
}

interface PairRecord {
	readonly pairId: string;
	readonly opponentBuildId: string;
	readonly orientation: 'forward' | 'reverse';
	readonly seedIndex: number;
	readonly seeds: { readonly battle: string, readonly search: string, readonly belief: string, readonly worldAllocation: string };
	readonly baseline: VariantResult;
	readonly candidate: VariantResult;
}

function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function json(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')) as unknown; }
function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty text.`);
	return value.trim();
}
function strings(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || !value.length || !value.every(item => typeof item === 'string' && item.trim())) throw new Error(`${label} must be a non-empty string array.`);
	return value.map(item => item.trim());
}
function teamReference(value: unknown, label: string): TeamReference {
	const raw = object(value, label);
	return { id: string(raw.id, `${label}.id`), teamPath: string(raw.teamPath, `${label}.teamPath`), teraCaptains: strings(raw.teraCaptains, `${label}.teraCaptains`).map(toID) };
}

/** Loads and validates a practical file-based one-change manifest. */
export function loadAblationManifest(path: string): LoadedManifest {
	const absolute = resolve(path); const base = dirname(absolute); const raw = object(json(absolute), 'manifest');
	if (raw.schemaVersion !== 1) throw new Error('Ablation manifest requires schemaVersion 1.');
	const baseline = teamReference(raw.baseline, 'manifest.baseline');
	const candidate = teamReference(raw.candidate, 'manifest.candidate');
	const baselineTeamPath = resolve(base, baseline.teamPath); const candidateTeamPath = resolve(base, candidate.teamPath);
	const baselineExported = readFileSync(baselineTeamPath, 'utf8'); const candidateExported = readFileSync(candidateTeamPath, 'utf8');
	const change = raw.change as AblationChange;
	if (!change || typeof change.type !== 'string') throw new Error('manifest.change must declare a supported change type.');
	validateAblationDefinition({ baselineExported, candidateExported, baselineTeraCaptains: baseline.teraCaptains, candidateTeraCaptains: candidate.teraCaptains, change });
	return {
		schemaVersion: 1, id: string(raw.id, 'manifest.id'), scenarioPath: string(raw.scenarioPath, 'manifest.scenarioPath'),
		subjectTeamId: toID(string(raw.subjectTeamId, 'manifest.subjectTeamId')), opponentTeamId: toID(string(raw.opponentTeamId, 'manifest.opponentTeamId')),
		baseline, candidate, change, opponentBuildIds: strings(raw.opponentBuildIds, 'manifest.opponentBuildIds'),
		decisionDomains: strings(raw.decisionDomains, 'manifest.decisionDomains'), absoluteScenarioPath: resolve(base, string(raw.scenarioPath, 'manifest.scenarioPath')),
		baselineExported, candidateExported, baselineTeamPath, candidateTeamPath,
	};
}

function build(id: string, exported: string): FixedBuild {
	const parsed = Teams.import(exported);
	if (!parsed?.length) throw new Error(`Invalid team export for ${id}.`);
	return { id, exported, packed: Teams.pack(parsed), team: parsed };
}

function gitRevision(path: string): string {
	try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim(); } catch { return 'unavailable'; }
}

function selectedActions(path: string): readonly string[] {
	if (!existsSync(path)) return [];
	// The bundle contains the normalized observation, selected action, deterministic
	// world allocation digest, and every per-world MCTS root. Hash each complete
	// canonical record so A/A checks the decision evidence, not only its final move.
	return readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line =>
		hash(JSON.stringify(JSON.parse(line)))
	);
}

function terminalDigest(result: VariantResult['result'], subjectWon: boolean, protocol: string): string {
	const turns = [...protocol.matchAll(/^\|turn\|(\d+)/gm)].map(match => Number(match[1]));
	return hash(JSON.stringify({ status: result.status, subjectWon, turns: turns.length ? Math.max(...turns) : 0 }));
}

function mergeMetricTotals(results: readonly VariantResult[]) {
	const generic = { games: results.length, turns: 0, switches: 0, hazardsSet: 0, hazardsRemoved: 0, teraCount: 0, kosBySpecies: {} as Record<string, number>, survival: {} as Record<string, { survived: number, observed: number }> };
	const setup: Record<string, number> = {};
	for (const result of results) {
		for (const key of ['turns', 'switches', 'hazardsSet', 'hazardsRemoved', 'teraCount'] as const) generic[key] += result.metrics.generic[key];
		for (const [species, count] of Object.entries(result.metrics.generic.kosBySpecies)) generic.kosBySpecies[species] = (generic.kosBySpecies[species] || 0) + count;
		for (const [species, survived] of Object.entries(result.metrics.generic.survival)) {
			const row = generic.survival[species] || { survived: 0, observed: 0 };
			row.observed++;
			row.survived += Number(survived);
			generic.survival[species] = row;
		}
		for (const [key, value] of Object.entries(result.metrics.setup)) setup[key] = (setup[key] || 0) + (value || 0);
	}
	return { generic, setup };
}

function sideArtifact(team: FixedScenarioTeam, selected: FixedBuild) {
	return { teamId: team.teamId, packed: selected.packed, exported: selected.exported, teraCaptains: team.teraCaptains };
}

async function runVariant(input: {
	readonly options: ExploreAblationOptions, readonly simulatorRoot: string, readonly outputDirectory: string, readonly manifest: LoadedManifest,
	readonly scenario: ReturnType<typeof loadFixedScenario>, readonly subject: FixedScenarioTeam, readonly opponent: FixedScenarioTeam,
	readonly subjectBuild: FixedBuild, readonly opponentBuild: FixedBuild, readonly variant: 'baseline' | 'candidate',
	readonly pairId: string, readonly orientation: 'forward' | 'reverse', readonly battleSeed: string, readonly searchSeed: string, readonly beliefSeed: string, readonly worldSeed: string,
}): Promise<VariantResult> {
	const subjectFirst = input.orientation === 'forward';
	const p1Team = subjectFirst ? input.subject : input.opponent; const p2Team = subjectFirst ? input.opponent : input.subject;
	const p1Build = subjectFirst ? input.subjectBuild : input.opponentBuild; const p2Build = subjectFirst ? input.opponentBuild : input.subjectBuild;
	const trialId = `${input.pairId}-${input.variant}`;
	const artifact = createTrialArtifact({
		outputDirectory: input.outputDirectory, trialId,
		manifest: { schemaVersion: 1, pairId: input.pairId, side: input.orientation, p1: sideArtifact(p1Team, p1Build), p2: sideArtifact(p2Team, p2Build), metadata: {
			ablationId: input.manifest.id, variant: input.variant, opponentBuildId: input.opponentBuild.id, runtime: { ...CANONICAL_RUNTIME, id: 'pdl-s4-foul-play-eval-fixediter-v1' },
			battleSeed: input.battleSeed, planner: 'native-fixed-120k', fixedIterations: 120000, searchSeed: input.searchSeed, beliefSeed: input.beliefSeed, worldSeed: input.worldSeed,
		} },
		p1Belief: privateBeliefFor(input.scenario, p1Team.teamId, p1Build), p2Belief: privateBeliefFor(input.scenario, p2Team.teamId, p2Build),
	});
	const result = await runFoulPlayTrial({ simulatorRoot: input.simulatorRoot, foulPlayRoot: resolve(input.options.foulRoot), artifact,
		searchTimeMs: input.options.decisionBudgetMs, beliefSamples: input.options.beliefSamples, beliefEngine: input.options.beliefEngine,
		timeoutMs: input.options.timeoutMs, battleSeed: input.battleSeed as `gen5,${string}`, evaluation: { fixedIterations: 120000, mctsSeed: input.searchSeed, beliefSeed: input.beliefSeed, worldSeed: input.worldSeed, worldWorkers: 1 } });
	const evidence = buildTrialEvidence(artifact, result);
	const protocol = readFileSync(artifact.publicProtocolPath, 'utf8');
	const subjectSide = subjectFirst ? 'p1' as const : 'p2' as const;
	const actions = [...selectedActions(artifact.p1DecisionBundlePath), '|', ...selectedActions(artifact.p2DecisionBundlePath)];
	const subjectWon = result.winnerTeamId === input.subject.teamId;
	return { variant: input.variant, result, artifact: artifact.directory, auditStatus: evidence.auditStatus, subjectWon,
		resultDigest: terminalDigest(result, subjectWon, protocol), decisionDigest: hash(JSON.stringify(actions)), metrics: analyzeAblationProtocol(protocol, subjectSide) };
}

export async function runExploratoryAblation(options: ExploreAblationOptions): Promise<string> {
	const manifest = loadAblationManifest(options.manifestPath);
	if (options.preset === 'aa' && manifest.change.type !== 'identity') throw new Error('The aa preset requires change.type identity.');
	if (options.preset !== 'aa' && manifest.change.type === 'identity') throw new Error('Identity manifests may only use the aa preset.');
	const scenario = loadFixedScenario(manifest.absoluteScenarioPath);
	const subject = scenario.teams.find(team => team.teamId === manifest.subjectTeamId);
	const opponent = scenario.teams.find(team => team.teamId === manifest.opponentTeamId);
	if (!subject || !opponent) throw new Error('Manifest subject/opponent team ids must exist in the fixed scenario.');
	const opponentBuilds = manifest.opponentBuildIds.map(id => {
		const found = opponent.builds.find(candidate => candidate.id === id);
		if (!found) throw new Error(`Opponent build ${id} is not present in the fixed scenario.`);
		return found;
	});
	const outputDirectory = resolve(options.outputDirectory);
	if (existsSync(outputDirectory)) throw new Error(`Output directory already exists: ${outputDirectory}.`);
	mkdirSync(outputDirectory, { recursive: false });
	const preset = resolvePreset(options.preset); const fullSchedule = buildPairedSchedule({ runId: manifest.id, opponentBuildIds: manifest.opponentBuildIds, seedsPerCell: preset.seedsPerCell });
	const schedule = options.maxPairs === null ? fullSchedule : fullSchedule.slice(0, options.maxPairs);
	const baseline = build(manifest.baseline.id, manifest.baselineExported); const candidate = build(manifest.candidate.id, manifest.candidateExported);
	const simulatorRoot = resolve(__dirname, '..', '..', '..');
	const trustPath = resolve(simulatorRoot, 'pdl', 'ablation', 'trust-matrix.json');
	const trust = json(trustPath) as TrustMatrix; const warning = trustWarning(manifest.decisionDomains, trust);
	const runManifest = {
		schemaVersion: 1, id: manifest.id, createdAt: new Date().toISOString(), command: process.argv.join(' '), preset: options.preset, purpose: preset.purpose,
		baseline: { id: baseline.id, teamSha256: hash(manifest.baselineExported), teraCaptains: manifest.baseline.teraCaptains },
		candidate: { id: candidate.id, teamSha256: hash(manifest.candidateExported), teraCaptains: manifest.candidate.teraCaptains },
		declaredDifference: manifest.change,
		opponents: opponentBuilds.map(opponentBuild => ({ id: opponentBuild.id, teamSha256: hash(opponentBuild.exported) })),
		runtime: { ...CANONICAL_RUNTIME, id: 'pdl-s4-foul-play-eval-fixediter-v1' }, evaluator: { id: CANONICAL_EVALUATOR_ID, sourceSha256: CANONICAL_EVALUATOR_SHA256 },
		planner: { id: 'native-fixed-120k', actionPolicy: 'argmax', fixedIterations: 120000, searchThreads: 1, worldWorkers: 1, beliefSamples: options.beliefSamples },
		seedContract: { battle: 'applied to Showdown', search: 'injected into deterministic Foul runtime', belief: 'injected into deterministic Foul runtime', worldAllocation: 'injected into deterministic Foul runtime' },
		orientations: ['forward', 'reverse'], games: schedule.length * 2, source: { simulatorGit: gitRevision(simulatorRoot), foulPlayGit: gitRevision(resolve(options.foulRoot)), scenarioSha256: hash(readFileSync(manifest.absoluteScenarioPath)) },
		trustDomains: manifest.decisionDomains, trustWarning: warning, hostedModelCallsExpected: 0, externalInferenceCallsExpected: 0, dryRun: options.dryRun,
	};
	writeFileSync(join(outputDirectory, 'manifest.resolved.json'), `${JSON.stringify(runManifest, null, 2)}\n`);
	writeFileSync(join(outputDirectory, 'schedule.json'), `${JSON.stringify(schedule, null, 2)}\n`);
	copyFileSync(resolve(options.manifestPath), join(outputDirectory, 'ablation.input.json'));
	if (options.dryRun) {
		writeFileSync(join(outputDirectory, 'summary.json'), `${JSON.stringify({ schemaVersion: 1, status: 'dry-run', scheduledPairs: schedule.length, scheduledBattles: schedule.length * 2, trustWarning: warning }, null, 2)}\n`);
		return outputDirectory;
	}
	const pairs: PairRecord[] = [];
	for (const [index, entry] of schedule.entries()) {
		const opponentBuild = opponentBuilds.find(value => value.id === entry.opponentBuildId)!;
		const common = { options, simulatorRoot, outputDirectory, manifest, scenario, subject, opponent, opponentBuild, pairId: entry.pairId, orientation: entry.orientation, battleSeed: entry.baseline.battleSeed, searchSeed: entry.baseline.searchSeed, beliefSeed: entry.baseline.beliefSeed, worldSeed: entry.baseline.worldAllocationSeed };
		const baselineResult = await runVariant({ ...common, subjectBuild: baseline, variant: 'baseline' });
		const candidateResult = await runVariant({ ...common, subjectBuild: candidate, variant: 'candidate' });
		const record = { pairId: entry.pairId, opponentBuildId: entry.opponentBuildId, orientation: entry.orientation, seedIndex: entry.seedIndex,
			seeds: { battle: entry.baseline.battleSeed, search: entry.baseline.searchSeed, belief: entry.baseline.beliefSeed, worldAllocation: entry.baseline.worldAllocationSeed }, baseline: baselineResult, candidate: candidateResult };
		pairs.push(record); writeFileSync(join(outputDirectory, 'pairs.jsonl'), `${pairs.map(value => JSON.stringify(value)).join('\n')}\n`);
		process.stdout.write(`[${index + 1}/${schedule.length}] ${entry.pairId}: ${baselineResult.result.status}/${candidateResult.result.status}\n`);
	}
	const invalid = pairs.filter(pair => pair.baseline.auditStatus !== 'clean' || pair.candidate.auditStatus !== 'clean' || !['completed', 'tied'].includes(pair.baseline.result.status) || !['completed', 'tied'].includes(pair.candidate.result.status));
	if (invalid.length) throw new Error(`${invalid.length} paired cell(s) lack two clean terminal battles.`);
	if (options.preset === 'aa') assertAAReproducible(pairs);
	const outcomes: PairedOutcome[] = pairs.map(pair => ({ opponentBuildId: pair.opponentBuildId, orientation: pair.orientation, baselineWon: pair.baseline.subjectWon, candidateWon: pair.candidate.subjectWon }));
	const pathologies = pairs.flatMap(pair => [pair.baseline, pair.candidate].flatMap(result => result.metrics.pathologyCandidates.map(candidatePathology => ({ pairId: pair.pairId, variant: result.variant, artifact: result.artifact, ...candidatePathology }))));
	const summary = {
		schemaVersion: 1, status: 'complete', aaReproducibility: options.preset === 'aa' ? 'PASS' : 'not-applicable', pairedStatistics: summarizePairedOutcomes(outcomes, manifest.id),
		behavior: { baseline: mergeMetricTotals(pairs.map(pair => pair.baseline)), candidate: mergeMetricTotals(pairs.map(pair => pair.candidate)) },
		pathologyCandidateCount: pathologies.length, trustWarning: warning,
		runtimeAttestation: { hostedModelCalls: 0, externalInferenceCalls: 0, networkPolicy: CANONICAL_RUNTIME.networkPolicy, cleanTrialAudits: pairs.length * 2 },
		limitations: ['Exploratory directional evidence only; not a precise matchup probability.'],
	};
	writeFileSync(join(outputDirectory, 'pathology-candidates.json'), `${JSON.stringify(pathologies, null, 2)}\n`);
	writeFileSync(join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
	return outputDirectory;
}
