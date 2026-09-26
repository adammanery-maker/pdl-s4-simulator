import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { SHOWDOWN_COMMIT } from '../simulate';
import { createTrialArtifact } from '../batch/artifacts';
import { CANONICAL_RUNTIME } from '../batch/runtime';
import { buildTrialEvidence, type AuditStatus, type BeliefTruthComparison } from '../batch/evidence';
import { runFoulPlayTrial } from '../batch/run-trial';
import type { TrialResult } from '../batch/types';
import { loadFixedScenario, privateBeliefFor, type FixedBuild, type FixedScenarioTeam } from '../fixed/scenario';

export interface FixedMatchupOptions {
	readonly scenarioPath: string;
	readonly repetitions: number;
	readonly searchTimeMs: number;
	readonly beliefSamples: number;
	readonly timeoutMs: number;
	readonly foulRoot: string;
	readonly outputDirectory: string;
	readonly beliefEngine: 'legacy' | 'posterior-shadow' | 'posterior';
}

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer.`);
	return parsed;
}

export function parseFixedMatchupArguments(argv: readonly string[]): FixedMatchupOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error('Arguments must use --name value pairs.');
		const name = key.slice(2);
		if (values.has(name)) throw new Error(`--${name} may only be supplied once.`);
		values.set(name, value);
	}
	const required = (name: string) => {
		const value = values.get(name);
		if (!value) throw new Error(`Missing required --${name}.`);
		return value;
	};
	const beliefEngine = values.get('belief-engine') || 'legacy';
	if (!['legacy', 'posterior-shadow', 'posterior'].includes(beliefEngine)) throw new Error('--belief-engine must be legacy, posterior-shadow, or posterior.');
	return {
		scenarioPath: required('scenario'),
		repetitions: positiveInteger(required('repetitions'), 'repetitions'),
		searchTimeMs: positiveInteger(values.get('decision-budget-ms') || values.get('search-time-ms') || '5000', 'decision-budget-ms'),
		beliefSamples: positiveInteger(values.get('belief-samples') || '8', 'belief-samples'),
		timeoutMs: positiveInteger(values.get('timeout-ms') || '900000', 'timeout-ms'),
		foulRoot: required('foul-root'),
		outputDirectory: required('output'),
		beliefEngine: beliefEngine as FixedMatchupOptions['beliefEngine'],
	};
}

function safeId(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function sideArtifact(team: FixedScenarioTeam, build: FixedBuild) {
	return { teamId: team.teamId, packed: build.packed, exported: build.exported, teraCaptains: team.teraCaptains };
}

export interface FixedTrialRecord {
	readonly pairId: string;
	readonly side: 'forward' | 'reverse';
	readonly matchupId: string;
	readonly repetition: number;
	readonly result: TrialResult;
	readonly artifact: string;
	readonly auditStatus: AuditStatus;
	readonly beliefTruthComparison: BeliefTruthComparison | null;
}

function summarizePosteriorShadow(records: readonly FixedTrialRecord[]) {
	const comparisons = records.map(record => record.beliefTruthComparison).filter((value): value is BeliefTruthComparison => value !== null);
	const comparable = comparisons.reduce((sum, value) => sum + value.comparableTraceCount, 0);
	const weighted = (field: keyof Pick<BeliefTruthComparison, 'meanTruthProbability' | 'meanMaximumProbability' | 'meanBrierScore'>) => comparable
		? comparisons.reduce((sum, value) => sum + value[field] * value.comparableTraceCount, 0) / comparable : 0;
	return {
		trialsWithTraceComparison: comparisons.length,
		traceCount: comparisons.reduce((sum, value) => sum + value.traceCount, 0),
		comparableTraceCount: comparable,
		incorrectEliminations: comparisons.reduce((sum, value) => sum + value.incorrectEliminations, 0),
		overconfidentWrongTraces: comparisons.reduce((sum, value) => sum + value.overconfidentWrongTraces, 0),
		meanTruthProbability: weighted('meanTruthProbability'),
		meanMaximumProbability: weighted('meanMaximumProbability'),
		meanBrierScore: weighted('meanBrierScore'),
		meanConvergence: comparisons.length
			? comparisons.reduce((sum, value) => sum + value.meanConvergence, 0) / comparisons.length : 0,
	};
}

export function summarizeFixedRecords(records: readonly FixedTrialRecord[], teamIds: readonly string[]) {
	const byPair = new Map<string, FixedTrialRecord[]>();
	for (const record of records) byPair.set(record.pairId, [...(byPair.get(record.pairId) || []), record]);
	const pairs = [...byPair.entries()].map(([pairId, trials]) => {
		const forward = trials.find(trial => trial.side === 'forward');
		const reverse = trials.find(trial => trial.side === 'reverse');
		const terminal = (trial: FixedTrialRecord | undefined) => trial && ['completed', 'tied'].includes(trial.result.status);
		const complete = Boolean(forward && reverse && terminal(forward) && terminal(reverse)
			&& forward.auditStatus === 'clean' && reverse.auditStatus === 'clean');
		return { pairId, complete, forward: forward?.result.status || 'missing', reverse: reverse?.result.status || 'missing', audits: { forward: forward?.auditStatus || 'missing', reverse: reverse?.auditStatus || 'missing' } };
	});
	const completedPairIds = new Set(pairs.filter(pair => pair.complete).map(pair => pair.pairId));
	const aggregatedTrials = records.filter(record => completedPairIds.has(record.pairId));
	const wins = Object.fromEntries(teamIds.map(teamId => [teamId, aggregatedTrials.filter(record => record.result.winnerTeamId === teamId).length]));
	const ties = aggregatedTrials.filter(record => record.result.status === 'tied').length;
	const statusCounts = Object.fromEntries(['completed', 'tied', 'rejected', 'failed', 'timed_out'].map(status => [status, records.filter(record => record.result.status === status).length]));
	return {
		pairs, completedPairIds, aggregatedTrials, wins, ties, statusCounts,
		violatingTrials: records.filter(record => record.auditStatus === 'violating').map(record => record.artifact),
		inconclusiveTrials: records.filter(record => record.auditStatus === 'inconclusive').map(record => record.artifact),
		incompletePairs: pairs.filter(pair => !pair.complete),
	};
}

export async function runFixedMatchupTournament(options: FixedMatchupOptions): Promise<string> {
	if (options.repetitions % 2 !== 0) throw new Error('--repetitions must be even so every fixed matchup is side-balanced.');
	const scenario = loadFixedScenario(options.scenarioPath);
	const outputDirectory = resolve(options.outputDirectory);
	mkdirSync(outputDirectory, { recursive: false });
	const simulatorRoot = resolve(__dirname, '..', '..', '..');
	const foulPlayRoot = resolve(options.foulRoot);
	const [firstTeam, secondTeam] = scenario.teams;
	const foulPlayCommit = execSync('git rev-parse HEAD', { cwd: foulPlayRoot }).toString().trim();
	const simulatorCommit = execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim();
	const nodeVersion = process.version;
	const pythonVersion = execSync(`"${join(foulPlayRoot, '.venv', 'bin', 'python')}" --version`).toString().trim();
	const scenarioHash = createHash('sha256').update(readFileSync(options.scenarioPath)).digest('hex');
	
	writeFileSync(`${outputDirectory}/run.json`, `${JSON.stringify({
		schemaVersion: 1, runtime: CANONICAL_RUNTIME, scenarioId: scenario.id, showdownCommit: SHOWDOWN_COMMIT, foulPlayCommit, simulatorCommit, nodeVersion, pythonVersion, scenarioHash, options,
		estimateSemantics: 'Repeated completed battles are empirical Monte Carlo trials. Native MCTS policy support and state values are search estimates, not match-win probabilities.',
	}, null, 2)}\n`);
	const records: FixedTrialRecord[] = [];
	let serial = 0;
	for (const firstBuild of firstTeam.builds) {
		for (const secondBuild of secondTeam.builds) {
			const matchupId = `${firstBuild.id}-vs-${secondBuild.id}`;
			for (let repetition = 0; repetition < options.repetitions; repetition++) {
				serial++;
				const reversed = repetition % 2 === 1;
				const p1Team = reversed ? secondTeam : firstTeam;
				const p2Team = reversed ? firstTeam : secondTeam;
				const p1Build = reversed ? secondBuild : firstBuild;
				const p2Build = reversed ? firstBuild : secondBuild;
				const id = `${String(serial).padStart(4, '0')}-${safeId(matchupId)}-${reversed ? 'reverse' : 'forward'}`;
				const pairId = `${safeId(matchupId)}-${Math.floor(repetition / 2) + 1}`;
				const side = reversed ? 'reverse' as const : 'forward' as const;
				const artifact = createTrialArtifact({
					outputDirectory, trialId: id,
					manifest: {
						schemaVersion: 1, pairId, side,
						p1: sideArtifact(p1Team, p1Build), p2: sideArtifact(p2Team, p2Build),
						metadata: { scenarioId: scenario.id, matchupId, repetition: repetition + 1, searchTimeMs: options.searchTimeMs, beliefSamples: options.beliefSamples, timeoutMs: options.timeoutMs, informationModel: 'separate private team and own fixed-Tera inputs; weighted opponent set beliefs' },
					},
					p1Belief: privateBeliefFor(scenario, p1Team.teamId, p1Build),
					p2Belief: privateBeliefFor(scenario, p2Team.teamId, p2Build),
				});
				const result = await runFoulPlayTrial({ simulatorRoot, foulPlayRoot, artifact, searchTimeMs: options.searchTimeMs, beliefSamples: options.beliefSamples, beliefEngine: options.beliefEngine, timeoutMs: options.timeoutMs });
				const evidence = buildTrialEvidence(artifact, result);
				const record = {
					pairId, side, matchupId, repetition: repetition + 1, result,
					artifact: artifact.directory, auditStatus: evidence.auditStatus,
					beliefTruthComparison: evidence.belief.truthComparison,
				};
				records.push(record);
				appendFileSync(`${outputDirectory}/trials.jsonl`, `${JSON.stringify(record)}\n`);
				process.stdout.write(`[${serial}/${firstTeam.builds.length * secondTeam.builds.length * options.repetitions}] ${matchupId} ${result.status}${result.winnerTeamId ? ` — ${result.winnerTeamId} won` : ''} — audit ${record.auditStatus}\n`);
			}
		}
	}
	const aggregate = summarizeFixedRecords(records, scenario.teams.map(team => team.teamId));
	const posteriorShadow = summarizePosteriorShadow(records);
	const summary = {
		schemaVersion: 1, runtime: CANONICAL_RUNTIME, scenarioId: scenario.id, requestedTrials: records.length, statusCounts: aggregate.statusCounts,
		requestedPairs: aggregate.pairs.length, completedPairs: aggregate.completedPairIds.size, incompletePairs: aggregate.incompletePairs,
		aggregatedTrials: aggregate.aggregatedTrials.length, wins: aggregate.wins, ties: aggregate.ties,
		violatingTrials: aggregate.violatingTrials, inconclusiveTrials: aggregate.inconclusiveTrials,
		empiricalMonteCarlo: { applicable: aggregate.completedPairIds.size > 0, independentRandomness: 'Each battle launches fresh Showdown and Foul Play processes; no deterministic battle seed is reused.', inclusionRule: 'Only clean terminal forward/reverse pairs are aggregated.' },
		searchValues: 'Native MCTS state evaluations and policy support; not match-win probabilities.',
		posteriorShadow,
	};
	writeFileSync(`${outputDirectory}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
	if (aggregate.incompletePairs.length) throw new Error(`${aggregate.incompletePairs.length} requested pair(s) failed, were incomplete, or had non-clean evidence. Inspect summary.json.`);
	return outputDirectory;
}

if (require.main === module) {
	runFixedMatchupTournament(parseFixedMatchupArguments(process.argv.slice(2)))
		.then(directory => process.stdout.write(`Fixed belief tournament: ${directory}/summary.json\n`))
		.catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
