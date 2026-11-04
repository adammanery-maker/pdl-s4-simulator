import { analyzeSunStrategy, type SunStrategyTelemetry } from './sun-telemetry';
import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import {
	analyzeAblationProtocol, summarizePairedOutcomes, type PairedOutcome, type ProtocolMetrics,
} from '../ablation';
import { createTrialArtifact } from '../batch/artifacts';
import { buildTrialEvidence } from '../batch/evidence';
import { CANONICAL_RUNTIME } from '../batch/runtime';
import { assertSunPolicyRuntime, parseRuntimeContractFromLog, runFoulPlayTrial } from '../batch/run-trial';
import type { PdlSunPolicy, TrialArtifact, TrialResult } from '../batch/types';
import {
	loadTeamSearchManifest, privateTeamSearchBelief, sharedCellSeeds, teamSearchCounts, teamSearchHash,
	type TeamSearchManifest, type TeamSearchPreset, type TeamSearchTeam,
} from './index';

const FIXED_ITERATIONS = 120_000;
const WORLD_WORKERS = 1;
const SEARCH_THREADS = 1;
const SEARCH_TIME_MS = 1_000;
const BELIEF_SAMPLES = 1;
const EVALUATION_RUNTIME_ID = 'pdl-s4-foul-play-eval-fixediter-v1';

const EVALUATION_RUNTIME = Object.freeze({
	...CANONICAL_RUNTIME,
	id: EVALUATION_RUNTIME_ID,
	resolvedConfiguration: Object.freeze({
		...CANONICAL_RUNTIME.resolvedConfiguration,
		fixedIterations: FIXED_ITERATIONS,
		searchThreads: SEARCH_THREADS,
		seedScheme: 'sha256-v1',
	}),
});

export interface TeamSearchOptions {
	readonly manifestPath: string;
	readonly preset: TeamSearchPreset;
	readonly foulRoot: string;
	readonly outputDirectory: string;
	readonly dryRun: boolean;
	readonly resume: boolean;
	readonly timeoutMs: number;
}

interface EvidenceResult { readonly auditStatus: string }

export interface TeamSearchDependencies {
	readonly loadManifest?: (path: string) => TeamSearchManifest;
	readonly runTrial?: typeof runFoulPlayTrial;
	readonly buildEvidence?: (artifact: TrialArtifact, result: TrialResult) => EvidenceResult;
}

interface CellSchedule {
	readonly cellId: string;
	readonly adamCandidateId: string;
	readonly steveOpponentId: string;
	readonly orientation: 'forward' | 'reverse';
	readonly seedIndex: number;
	readonly seeds: ReturnType<typeof sharedCellSeeds>;
}

interface CellRecord extends CellSchedule {
	readonly schemaVersion: 1;
	readonly attempt: number;
	readonly strategyPolicy?: PdlSunPolicy;
	readonly trialId: string;
	readonly artifact: string;
	readonly result: TrialResult;
	readonly auditStatus: string;
	readonly cleanTerminal: boolean;
	readonly adamWon: boolean;
	readonly tied: boolean;
	readonly metrics: ProtocolMetrics;
	readonly sunStrategy?: SunStrategyTelemetry;
	readonly sunStrategyInputHash?: string;
	readonly leads: { readonly adam: string | null, readonly steve: string | null };
	readonly identity: {
		readonly run: string, readonly configuration: string, readonly runtime: string, readonly source: string,
		readonly manifest: string, readonly belief: string, readonly adamTeam: string, readonly steveTeam: string,
	};
	readonly actualRuntime: { readonly p1: unknown, readonly p2: unknown } | null;
	readonly actualRuntimeHash: string | null;
	readonly artifactEvidenceHash: string;
}

interface AggregateRow {
	readonly games: number;
	readonly wins: number;
	readonly ties: number;
	readonly losses: number;
	readonly winRate: number;
	readonly nonLossRate: number;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function gitRevision(path: string): string {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
	} catch {
		return 'unavailable';
	}
}

function sourceTreeHash(root: string, relativePaths: readonly string[]): string {
	const files: string[] = [];
	const visit = (relativePath: string) => {
		const absolute = join(root, relativePath);
		if (!existsSync(absolute)) return;
		if (statSync(absolute).isDirectory()) {
			for (const child of readdirSync(absolute).sort()) visit(join(relativePath, child));
		} else if (/\.(?:py|ts|json)$/.test(relativePath)) {
			files.push(relativePath);
		}
	};
	for (const relativePath of relativePaths) visit(relativePath);
	if (!files.length) return 'unavailable';
	return teamSearchHash(files
		.map(path => `${path}\0${teamSearchHash(readFileSync(join(root, path), 'utf8'))}`)
		.join('\n'));
}

function scheduleFor(manifest: TeamSearchManifest, preset: TeamSearchPreset): readonly CellSchedule[] {
	const schedule: CellSchedule[] = [];
	const seedsPerCell = teamSearchCounts(manifest, preset).seedsPerCell;
	for (const adam of manifest.adamCandidates) {
		for (const steve of manifest.steveOpponents) {
			for (const orientation of ['forward', 'reverse'] as const) {
				for (let seedIndex = 1; seedIndex <= seedsPerCell; seedIndex++) {
					const seeds = sharedCellSeeds(manifest.id, steve.id, orientation, seedIndex);
					const key = teamSearchHash(JSON.stringify([
						manifest.id, adam.id, adam.teamHash, steve.id, steve.teamHash, orientation, seedIndex, seeds,
					]));
					const cellId = `${manifest.id.slice(0, 48)}-${orientation}-${String(seedIndex).padStart(3, '0')}-${key}`;
					schedule.push({
						cellId, adamCandidateId: adam.id, steveOpponentId: steve.id, orientation, seedIndex, seeds,
					});
				}
			}
		}
	}
	return schedule;
}

function resolvedIdentity(options: TeamSearchOptions, manifest: TeamSearchManifest, simulatorRoot: string) {
	const configuration = {
		preset: options.preset,
		timeoutMs: options.timeoutMs,
		searchTimeMs: SEARCH_TIME_MS,
		beliefSamples: BELIEF_SAMPLES,
		beliefEngine: 'posterior',
		fixedIterations: FIXED_ITERATIONS,
		searchThreads: SEARCH_THREADS,
		worldWorkers: WORLD_WORKERS,
		seedScheme: 'sha256-v1',
		strategyPolicies: Object.fromEntries(manifest.adamCandidates.filter(team => team.strategyPolicy).map(team => [team.id, team.strategyPolicy])),
	};
	const source = {
		simulatorGit: gitRevision(simulatorRoot),
		foulPlayGit: gitRevision(resolve(options.foulRoot)),
		simulatorSourceSha256: sourceTreeHash(simulatorRoot, [
			'pdl', 'sim', 'data', 'config/formats.ts', 'server/rooms.ts',
		]),
		foulRuntimeSourceSha256: sourceTreeHash(resolve(options.foulRoot), ['run.py', 'fp']),
	};
	const runtimeHash = teamSearchHash(JSON.stringify(EVALUATION_RUNTIME));
	const configurationHash = teamSearchHash(JSON.stringify(configuration));
	const sourceHash = teamSearchHash(JSON.stringify(source));
	const identityHash = teamSearchHash(JSON.stringify({
		manifestHash: manifest.manifestHash,
		beliefHash: manifest.beliefHash,
		runtimeHash,
		configurationHash,
		sourceHash,
	}));
	return { configuration, source, runtimeHash, configurationHash, sourceHash, identityHash };
}

function sideArtifact(side: 'adam' | 'steve', team: TeamSearchTeam) {
	return { teamId: side, packed: team.packed, exported: team.exported, teraCaptains: team.teraCaptains };
}

function protocolLeads(protocol: string, adamSide: 'p1' | 'p2'): { adam: string | null, steve: string | null } {
	const leads: { p1: string | null, p2: string | null } = { p1: null, p2: null };
	for (const match of protocol.matchAll(/^\|(?:switch|drag)\|(p[12])a?:[^|]+\|([^,|]+)/gm)) {
		const side = match[1] as 'p1' | 'p2';
		leads[side] ??= match[2].trim();
	}
	const steveSide = adamSide === 'p1' ? 'p2' : 'p1';
	return { adam: leads[adamSide], steve: leads[steveSide] };
}

function records(path: string): readonly CellRecord[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as CellRecord);
}

function isClean(record: CellRecord): boolean {
	return record.cleanTerminal && record.actualRuntime !== null &&
		record.auditStatus === 'clean' && ['completed', 'tied'].includes(record.result.status);
}

function sunTelemetryFromArtifacts(
	adam: TeamSearchManifest['adamCandidates'][number], directory: string,
	orientation: CellSchedule['orientation'], result: TrialResult
) {
	if (!adam.team.some(set => set.species.toLowerCase() === 'scovillain')) return undefined;
	const side = orientation === 'forward' ? 'p1' : 'p2';
	const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';
	const inputs = {
		protocol: read(join(directory, side === 'p1' ? 'public.protocol' : 'p2-public.protocol')),
		decisionBundles: read(join(directory, `private-${side}`, 'decision-bundles.jsonl')),
		decisionEvidenceLog: read(join(directory, `${side}.log`)),
	};
	return {
		telemetry: analyzeSunStrategy({ ...inputs, adamSide: side, ownTeam: adam.team, result }),
		inputHash: teamSearchHash(JSON.stringify(inputs)),
	};
}

/** Post-battle audit fingerprint; none of these bytes enter the agent. */
function artifactEvidenceHash(directory: string): string {
	const paths = ['manifest.json', 'result.json', 'audit.json', 'public.protocol', 'p2-public.protocol',
		'p1.log', 'p2.log', 'showdown.log', 'offline-network-audit.log', 'private-ground-truth-audit.json',
		'sun-strategy.json', ...['p1', 'p2'].flatMap(side => ['protocol.log', 'decision-bundles.jsonl',
			'offline-network-audit.log', 'team.txt', 'belief.json'].map(file => `private-${side}/${file}`))];
	return teamSearchHash(JSON.stringify(paths.map(path => [path, existsSync(join(directory, path)) ?
		teamSearchHash(readFileSync(join(directory, path), 'utf8')) : null])));
}

function persistedClean(
	record: CellRecord,
	identity: ReturnType<typeof resolvedIdentity>,
	manifest: TeamSearchManifest,
	cell: CellSchedule
): boolean {
	if (!isClean(record) || !record.actualRuntime ||
		record.artifactEvidenceHash !== artifactEvidenceHash(record.artifact) ||
		record.actualRuntimeHash !== teamSearchHash(JSON.stringify(record.actualRuntime)) ||
		record.cellId !== cell.cellId || record.adamCandidateId !== cell.adamCandidateId ||
		record.steveOpponentId !== cell.steveOpponentId || record.orientation !== cell.orientation ||
		record.seedIndex !== cell.seedIndex || JSON.stringify(record.seeds) !== JSON.stringify(cell.seeds)) return false;
	const adam = manifest.adamCandidates.find(team => team.id === record.adamCandidateId);
	const steve = manifest.steveOpponents.find(team => team.id === record.steveOpponentId);
	if (!adam || !steve || record.strategyPolicy !== adam.strategyPolicy || record.identity?.run !== identity.identityHash ||
		record.identity.configuration !== identity.configurationHash || record.identity.runtime !== identity.runtimeHash ||
		record.identity.source !== identity.sourceHash || record.identity.manifest !== manifest.manifestHash ||
		record.identity.belief !== manifest.beliefHash || record.identity.adamTeam !== adam.teamHash ||
		record.identity.steveTeam !== steve.teamHash) return false;
	try {
		const result = JSON.parse(readFileSync(join(record.artifact, 'result.json'), 'utf8')) as TrialResult;
		const audit = JSON.parse(readFileSync(join(record.artifact, 'audit.json'), 'utf8')) as { auditStatus?: string };
		const protocol = readFileSync(join(record.artifact, 'public.protocol'), 'utf8');
		const side = cell.orientation === 'forward' ? 'p1' : 'p2';
		if (record.adamWon !== (result.status === 'completed' && result.winnerTeamId === 'adam') ||
			record.tied !== (result.status === 'tied') ||
			JSON.stringify(record.metrics) !== JSON.stringify(analyzeAblationProtocol(protocol, side)) ||
			JSON.stringify(record.leads) !== JSON.stringify(protocolLeads(protocol, side))) return false;
		const contracts = {
			p1: parseRuntimeContractFromLog(readFileSync(join(record.artifact, 'p1.log'), 'utf8'), true),
			p2: parseRuntimeContractFromLog(readFileSync(join(record.artifact, 'p2.log'), 'utf8'), true),
		};
		const adamFirst = cell.orientation === 'forward';
		assertSunPolicyRuntime(contracts.p1, adamFirst ? adam.strategyPolicy : undefined);
		assertSunPolicyRuntime(contracts.p2, adamFirst ? undefined : adam.strategyPolicy);
		const sun = sunTelemetryFromArtifacts(adam, record.artifact, cell.orientation, result);
		if (sun && (sun.inputHash !== record.sunStrategyInputHash ||
			JSON.stringify(sun.telemetry) !== JSON.stringify(record.sunStrategy) ||
			JSON.stringify(JSON.parse(readFileSync(join(record.artifact, 'sun-strategy.json'), 'utf8'))) !== JSON.stringify(sun.telemetry))) return false;
		return audit.auditStatus === 'clean' && result.status === record.result.status &&
			result.winnerTeamId === record.result.winnerTeamId &&
			JSON.stringify(contracts) === JSON.stringify(record.actualRuntime);
	} catch {
		return false;
	}
}

function latestByCell(all: readonly CellRecord[]): Map<string, CellRecord> {
	const latest = new Map<string, CellRecord>();
	for (const record of all) {
		const current = latest.get(record.cellId);
		if (!current || current.attempt < record.attempt || (!isClean(current) && isClean(record))) {
			latest.set(record.cellId, record);
		}
	}
	return latest;
}

function nextAttempt(outputDirectory: string, cell: CellSchedule, all: readonly CellRecord[]): number {
	let attempt = Math.max(0, ...all.filter(record => record.cellId === cell.cellId).map(record => record.attempt)) + 1;
	while (existsSync(join(
		outputDirectory, 'trials', `${cell.cellId}-attempt-${String(attempt).padStart(3, '0')}`
	))) attempt++;
	return attempt;
}

function aggregate(selected: readonly CellRecord[]): AggregateRow {
	const wins = selected.filter(record => record.adamWon).length;
	const ties = selected.filter(record => record.tied).length;
	const games = selected.length;
	return {
		games, wins, ties, losses: games - wins - ties,
		winRate: games ? wins / games : 0,
		nonLossRate: games ? (wins + ties) / games : 0,
	};
}

function mergeBehavior(selected: readonly CellRecord[]) {
	const generic = {
		games: selected.length, turns: 0, switches: 0, hazardsSet: 0, hazardsRemoved: 0, teraCount: 0,
		kosBySpecies: {} as Record<string, number>,
		survival: {} as Record<string, { survived: number, observed: number }>,
	};
	const setup: Record<string, number> = {};
	for (const record of selected) {
		const metrics = record.metrics;
		for (const key of ['turns', 'switches', 'hazardsSet', 'hazardsRemoved', 'teraCount'] as const) {
			generic[key] += metrics.generic[key];
		}
		for (const [species, count] of Object.entries(metrics.generic.kosBySpecies)) {
			generic.kosBySpecies[species] = (generic.kosBySpecies[species] || 0) + count;
		}
		for (const [species, survived] of Object.entries(metrics.generic.survival)) {
			const row = generic.survival[species] || { survived: 0, observed: 0 };
			row.observed++;
			row.survived += Number(survived);
			generic.survival[species] = row;
		}
		for (const [key, value] of Object.entries(metrics.setup)) setup[key] = (setup[key] || 0) + (value || 0);
	}
	return { generic, setup };
}

function groupedResults(
	recordsToGroup: readonly CellRecord[],
	keys: readonly string[],
	value: (record: CellRecord) => string
) {
	return Object.fromEntries(keys.map(key => [key, aggregate(recordsToGroup.filter(record => value(record) === key))]));
}

function leadFrequencies(clean: readonly CellRecord[]) {
	const counts = (side: 'adam' | 'steve') => {
		const result: Record<string, number> = {};
		for (const record of clean) {
			const lead = record.leads[side] || 'unknown';
			result[lead] = (result[lead] || 0) + 1;
		}
		return result;
	};
	return { adam: counts('adam'), steve: counts('steve') };
}

function pairwiseResults(clean: readonly CellRecord[], manifest: TeamSearchManifest) {
	const comparisons = [];
	const matrix: Record<string, Record<string, unknown>> = Object.fromEntries(
		manifest.adamCandidates.map(team => [team.id, {}])
	);
	for (let leftIndex = 0; leftIndex < manifest.adamCandidates.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < manifest.adamCandidates.length; rightIndex++) {
			const left = manifest.adamCandidates[leftIndex];
			const right = manifest.adamCandidates[rightIndex];
			const byKey = (candidateId: string) => new Map(clean.filter(record => record.adamCandidateId === candidateId)
				.map(record => [`${record.steveOpponentId}|${record.orientation}|${record.seedIndex}`, record]));
			const leftRows = byKey(left.id);
			const rightRows = byKey(right.id);
			const outcomes: PairedOutcome[] = [];
			for (const [key, leftRow] of leftRows) {
				const rightRow = rightRows.get(key);
				if (!rightRow) continue;
				outcomes.push({
					opponentBuildId: leftRow.steveOpponentId,
					orientation: leftRow.orientation,
					baselineWon: leftRow.adamWon,
					candidateWon: rightRow.adamWon,
				});
			}
			const statistics = summarizePairedOutcomes(outcomes, `${manifest.id}|${left.id}|${right.id}`);
			const comparison = {
				rowCandidateId: left.id,
				columnCandidateId: right.id,
				rowOnlyWins: statistics.paired.baselineOnlyWin,
				columnOnlyWins: statistics.paired.candidateOnlyWin,
				netRowAdvantage: statistics.paired.baselineOnlyWin - statistics.paired.candidateOnlyWin,
				statistics,
			};
			comparisons.push(comparison);
			matrix[left.id][right.id] = comparison;
			matrix[right.id][left.id] = {
				rowCandidateId: right.id,
				columnCandidateId: left.id,
				rowOnlyWins: comparison.columnOnlyWins,
				columnOnlyWins: comparison.rowOnlyWins,
				netRowAdvantage: -comparison.netRowAdvantage,
				pairedCells: statistics.pairs,
			};
		}
	}
	return {
		metric: 'row candidate-only wins minus column candidate-only wins; ties count as non-wins',
		candidateIds: manifest.adamCandidates.map(team => team.id), matrix, comparisons,
	};
}

function sunStrategyReports(outputDirectory: string, selected: readonly CellRecord[]) {
	const rows = selected.filter(record => record.sunStrategy).map(record => ({
		cellId: record.cellId, adamCandidateId: record.adamCandidateId, steveOpponentId: record.steveOpponentId,
		orientation: record.orientation, seedIndex: record.seedIndex, seeds: record.seeds, strategyPolicy: record.strategyPolicy || 'none',
		artifact: record.artifact, cleanTerminal: record.cleanTerminal,
		telemetry: record.sunStrategy!,
	}));
	if (!rows.length) return null;
	const clean = rows.filter(row => row.cleanTerminal);
	const summarize = (group: typeof rows) => ({
		battles: group.length,
		wins: group.filter(row => row.telemetry.outcome === 'win').length,
		losses: group.filter(row => row.telemetry.outcome === 'loss').length,
		ties: group.filter(row => row.telemetry.outcome === 'tie').length,
		battlesWithSun: group.filter(row => row.telemetry.sunOccurred).length,
		battlesWithScovillainEntryUnderSun: group.filter(row => row.telemetry.scovillainEntries.some(entry => entry.sunActive)).length,
		battlesWithMementoToScovillainUnderSun: group.filter(row => row.telemetry.scovillainEntries.some(entry => entry.precededByWhimsicottMemento)).length,
		battlesWithScovillainAttackUnderSun: group.filter(row => row.telemetry.attacksUnderSun.length).length,
		battlesWithScovillainDamageUnderSun: group.filter(row => row.telemetry.attacksUnderSun.some(attack => attack.successfulDamage)).length,
		growthOpportunities: group.reduce((sum, row) => sum + row.telemetry.growth.opportunities, 0),
		growthSelections: group.reduce((sum, row) => sum + row.telemetry.growth.selections, 0),
		growthExecutions: group.reduce((sum, row) => sum + row.telemetry.growth.executions, 0),
		scovillainKosUnderSun: group.reduce((sum, row) => sum + row.telemetry.kosUnderSun.length, 0),
		scovillainTeraBattles: group.filter(row => row.telemetry.tera.some(event => event.scovillain)).length,
		weatherTimerMismatchEntries: group.reduce((sum, row) => sum + row.telemetry.scovillainEntries.filter(entry => entry.sunTurnsRemaining?.searchMismatch).length, 0),
	});
	const summary = {
		schemaVersion: 1, recordedBattles: rows.length, cleanBattles: clean.length,
		...summarize(clean),
		byOpponent: Object.fromEntries([...new Set(clean.map(row => row.steveOpponentId))].map(id => [id, summarize(clean.filter(row => row.steveOpponentId === id))])),
		byOrientation: Object.fromEntries(['forward', 'reverse'].map(side => [side, summarize(clean.filter(row => row.orientation === side))])),
		limitations: [
			'Small samples are exploratory; conditional conversion rates are descriptive, not causal estimates.',
			'Telemetry uses actor-visible events and own items; the live client weather timer is unchanged.',
		],
	};
	writeFileSync(join(outputDirectory, 'sun-strategy-cells.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
	writeJson(join(outputDirectory, 'sun-strategy-summary.json'), summary);
	return summary;
}

function reports(
	outputDirectory: string,
	manifest: TeamSearchManifest,
	selected: readonly CellRecord[],
	scheduledBattles: number
) {
	const clean = selected.filter(isClean);
	const candidates = manifest.adamCandidates.map(candidate => {
		const candidateCells = clean.filter(record => record.adamCandidateId === candidate.id);
		const weighted = manifest.steveOpponents.reduce((total, opponent) => {
			const opponentCells = candidateCells.filter(record => record.steveOpponentId === opponent.id);
			const opponentWinRate = opponentCells.length ?
				opponentCells.filter(record => record.adamWon).length / opponentCells.length : 0;
			return total + opponent.weight * opponentWinRate;
		}, 0) / manifest.steveOpponents.reduce((total, opponent) => total + opponent.weight, 0);
		const pathologyCount = candidateCells.reduce((total, record) => total + record.metrics.pathologyCandidates.length, 0);
		return {
			id: candidate.id,
			label: candidate.label,
			...aggregate(candidateCells),
			weightedOpponentWinRate: weighted,
			byOrientation: groupedResults(candidateCells, ['forward', 'reverse'], record => record.orientation),
			byOpponent: groupedResults(
				candidateCells, manifest.steveOpponents.map(team => team.id), record => record.steveOpponentId
			),
			behavior: mergeBehavior(candidateCells),
			averageTurns: candidateCells.length ?
				candidateCells.reduce((sum, record) => sum + record.metrics.generic.turns, 0) / candidateCells.length : null,
			pathologyCount,
			pathologyRatePerBattle: candidateCells.length ? pathologyCount / candidateCells.length : 0,
			previewLeadChoices: leadFrequencies(candidateCells).adam,
		};
	});
	const ranking = [...candidates].sort((left, right) => right.winRate - left.winRate || left.id.localeCompare(right.id))
		.map((candidate, index) => ({ rank: index + 1, ...candidate }));
	const pairwise = pairwiseResults(clean, manifest);
	const pathologies = clean.flatMap(record => record.metrics.pathologyCandidates.map(pathology => ({
		cellId: record.cellId, artifact: record.artifact, adamCandidateId: record.adamCandidateId,
		steveOpponentId: record.steveOpponentId, ...pathology,
	})));
	const leads = leadFrequencies(clean);
	const orientation = groupedResults(clean, ['forward', 'reverse'], record => record.orientation);
	const opponents = groupedResults(clean, manifest.steveOpponents.map(team => team.id), record => record.steveOpponentId);
	writeJson(join(outputDirectory, 'candidate-results.json'), candidates);
	writeJson(join(outputDirectory, 'pairwise.json'), pairwise);
	writeJson(join(outputDirectory, 'pathology-candidates.json'), pathologies);
	writeJson(join(outputDirectory, 'pathologies.json'), pathologies);
	writeJson(join(outputDirectory, 'lead-frequencies.json'), leads);
	writeJson(join(outputDirectory, 'orientation-results.json'), orientation);
	writeJson(join(outputDirectory, 'opponent-results.json'), opponents);
	return { clean, candidates, ranking, pairwise, pathologies, leads, orientation, opponents, scheduledBattles };
}

/** Execute or resume the immutable, common-random-number team-search schedule. */
export async function runTeamSearch(
	options: TeamSearchOptions,
	dependencies: TeamSearchDependencies = {}
): Promise<string> {
	const loadManifest = dependencies.loadManifest || loadTeamSearchManifest;
	const runTrial = dependencies.runTrial || runFoulPlayTrial;
	const buildEvidence = dependencies.buildEvidence || buildTrialEvidence;
	const manifest = loadManifest(options.manifestPath);
	const outputDirectory = resolve(options.outputDirectory);
	const simulatorRoot = resolve(__dirname, '..', '..', '..');
	const schedule = scheduleFor(manifest, options.preset);
	const counts = teamSearchCounts(manifest, options.preset);
	const identity = resolvedIdentity(options, manifest, simulatorRoot);
	const roleAliases = manifest.metadata?.roleAliases;
	const resolvedManifest = {
		schemaVersion: 1,
		id: manifest.id,
		manifestHash: manifest.manifestHash,
		beliefPath: manifest.beliefPath,
		beliefHash: manifest.beliefHash,
		identityHash: identity.identityHash,
		configurationHash: identity.configurationHash,
		runtimeHash: identity.runtimeHash,
		sourceHash: identity.sourceHash,
		configuration: identity.configuration,
		runtime: EVALUATION_RUNTIME,
		source: identity.source,
		counts,
		validationErrors: manifest.validationErrors,
		...(roleAliases ? { roleAliases } : {}),
		adamCandidates: manifest.adamCandidates.map(team => ({
			id: team.id, label: team.label, teamPath: team.teamPath, teamHash: team.teamHash,
			teraCaptains: team.teraCaptains, resolvedTeraTypes: team.resolvedTeraTypes, strategyPolicy: team.strategyPolicy,
		})),
		steveOpponents: manifest.steveOpponents.map(team => ({
			id: team.id, label: team.label, teamPath: team.teamPath, teamHash: team.teamHash,
			teraCaptains: team.teraCaptains, resolvedTeraTypes: team.resolvedTeraTypes, strategyPolicy: team.strategyPolicy, weight: team.weight,
		})),
		offlineAttestation: {
			hostedModelCallsExpected: 0,
			externalInferenceCallsExpected: 0,
			networkPolicy: EVALUATION_RUNTIME.networkPolicy,
		},
	};
	const resolvedPath = join(outputDirectory, 'manifest.resolved.json');
	const trustWarnings = [
		'Samples are exploratory; this run does not establish precise matchup probabilities.',
		'Team preview remains RED; switching, hazards, Sun, Growth, Memento and Shell Smash remain YELLOW.',
	];
	process.stdout.write(`${JSON.stringify({ ...counts, planner: 'native-fixed-120k', runtime: EVALUATION_RUNTIME_ID }, null, 2)}\n`);
	if (options.resume) {
		if (!existsSync(resolvedPath)) throw new Error(`Cannot resume without ${resolvedPath}.`);
		const prior = JSON.parse(readFileSync(resolvedPath, 'utf8')) as { identityHash?: string };
		if (prior.identityHash !== identity.identityHash) {
			throw new Error('Cannot resume stale team-search configuration: identity hash changed.');
		}
	} else {
		if (existsSync(outputDirectory) && readdirSync(outputDirectory).length) {
			throw new Error(`Output directory already exists and is not empty: ${outputDirectory}.`);
		}
		mkdirSync(outputDirectory, { recursive: true });
		writeJson(resolvedPath, resolvedManifest);
		writeJson(join(outputDirectory, 'schedule.json'), schedule);
	}
	if (options.dryRun) {
		writeJson(join(outputDirectory, 'summary.json'), {
			schemaVersion: 1,
			status: manifest.validationErrors.length ? 'validation-failed' : 'dry-run',
			counts,
			validationErrors: manifest.validationErrors,
			...(roleAliases ? { roleAliases } : {}),
			runnerCalls: 0,
			runIdentity: identity.identityHash,
			planner: 'native-fixed-120k', runtime: EVALUATION_RUNTIME,
			trustWarnings,
			runtimeAttestation: resolvedManifest.offlineAttestation,
		});
		if (manifest.validationErrors.length) {
			throw new Error(`Team-search validation failed; dry-run only:\n- ${manifest.validationErrors.join('\n- ')}`);
		}
		return outputDirectory;
	}
	if (manifest.validationErrors.length) {
		throw new Error(`Team-search validation failed; no trials created:\n- ${manifest.validationErrors.join('\n- ')}`);
	}
	const cellsPath = join(outputDirectory, 'cells.jsonl');
	const all = [...records(cellsPath)];
	const latest = latestByCell(all);
	for (const [scheduleIndex, cell] of schedule.entries()) {
		const prior = latest.get(cell.cellId);
		if (prior && persistedClean(prior, identity, manifest, cell)) {
			process.stdout.write(`[${scheduleIndex + 1}/${schedule.length}] ${cell.cellId}: resume-skip clean\n`);
			continue;
		}
		const adam = manifest.adamCandidates.find(team => team.id === cell.adamCandidateId)!;
		const steve = manifest.steveOpponents.find(team => team.id === cell.steveOpponentId)!;
		const attempt = nextAttempt(outputDirectory, cell, all);
		const trialId = `${cell.cellId}-attempt-${String(attempt).padStart(3, '0')}`;
		const adamFirst = cell.orientation === 'forward';
		const p1 = adamFirst ? sideArtifact('adam', adam) : sideArtifact('steve', steve);
		const p2 = adamFirst ? sideArtifact('steve', steve) : sideArtifact('adam', adam);
		const artifact = createTrialArtifact({
			outputDirectory,
			trialId,
			manifest: {
				schemaVersion: 1,
				pairId: cell.cellId,
				side: cell.orientation,
				p1,
				p2,
				metadata: {
					teamSearchId: manifest.id,
					...(roleAliases ? { roleAliases } : {}),
					adamCandidateId: adam.id,
					steveOpponentId: steve.id,
					strategyPolicy: adam.strategyPolicy || 'none',
					attempt,
					runtime: EVALUATION_RUNTIME,
					planner: 'native-fixed-120k',
					battleSeed: cell.seeds.battleSeed,
					searchSeed: cell.seeds.searchSeed,
					beliefSeed: cell.seeds.beliefSeed,
					worldAllocationSeed: cell.seeds.worldAllocationSeed,
				},
			},
			p1Belief: privateTeamSearchBelief(manifest, adamFirst ? 'adam' : 'steve', adamFirst ? adam : steve),
			p2Belief: privateTeamSearchBelief(manifest, adamFirst ? 'steve' : 'adam', adamFirst ? steve : adam),
		});
		const result = await runTrial({
			simulatorRoot,
			foulPlayRoot: resolve(options.foulRoot),
			artifact,
			sunPolicies: adam.strategyPolicy ? { [adamFirst ? 'p1' : 'p2']: adam.strategyPolicy } : undefined,
			searchTimeMs: SEARCH_TIME_MS,
			beliefSamples: BELIEF_SAMPLES,
			beliefEngine: 'posterior',
			timeoutMs: options.timeoutMs,
			battleSeed: cell.seeds.battleSeed as `gen5,${string}`,
			evaluation: {
				fixedIterations: FIXED_ITERATIONS,
				mctsSeed: cell.seeds.searchSeed,
				beliefSeed: cell.seeds.beliefSeed,
				worldSeed: cell.seeds.worldAllocationSeed,
				worldWorkers: WORLD_WORKERS,
			},
		});
		const evidence = buildEvidence(artifact, result);
		let actualRuntime: CellRecord['actualRuntime'] = null;
		let actualRuntimeHash: string | null = null;
		let auditStatus = evidence.auditStatus;
		if (evidence.auditStatus === 'clean' && ['completed', 'tied'].includes(result.status)) {
			try {
				actualRuntime = {
					p1: parseRuntimeContractFromLog(readFileSync(artifact.p1LogPath, 'utf8'), true),
					p2: parseRuntimeContractFromLog(readFileSync(artifact.p2LogPath, 'utf8'), true),
				};
				assertSunPolicyRuntime(actualRuntime.p1, adamFirst ? adam.strategyPolicy : undefined);
				assertSunPolicyRuntime(actualRuntime.p2, adamFirst ? undefined : adam.strategyPolicy);
				actualRuntimeHash = teamSearchHash(JSON.stringify(actualRuntime));
			} catch {
				auditStatus = 'inconclusive';
			}
		}
		const protocol = existsSync(artifact.publicProtocolPath) ? readFileSync(artifact.publicProtocolPath, 'utf8') : '';
		const adamSide = adamFirst ? 'p1' as const : 'p2' as const;
		const sun = sunTelemetryFromArtifacts(adam, artifact.directory, cell.orientation, result);
		const sunStrategy = sun?.telemetry;
		if (sunStrategy) writeJson(join(artifact.directory, 'sun-strategy.json'), sunStrategy);
		const record: CellRecord = {
			schemaVersion: 1,
			...cell,
			attempt,
			strategyPolicy: adam.strategyPolicy,
			trialId,
			artifact: artifact.directory,
			result,
			auditStatus,
			cleanTerminal: auditStatus === 'clean' && actualRuntime !== null && ['completed', 'tied'].includes(result.status),
			adamWon: result.status === 'completed' && result.winnerTeamId === 'adam',
			tied: result.status === 'tied',
			metrics: analyzeAblationProtocol(protocol, adamSide),
			sunStrategy,
			sunStrategyInputHash: sun?.inputHash,
			leads: protocolLeads(protocol, adamSide),
			identity: {
				run: identity.identityHash,
				configuration: identity.configurationHash,
				runtime: identity.runtimeHash,
				source: identity.sourceHash,
				manifest: manifest.manifestHash,
				belief: manifest.beliefHash,
				adamTeam: adam.teamHash,
				steveTeam: steve.teamHash,
			},
			actualRuntime,
			actualRuntimeHash,
			artifactEvidenceHash: artifactEvidenceHash(artifact.directory),
		};
		appendFileSync(cellsPath, `${JSON.stringify(record)}\n`, 'utf8');
		if (sunStrategy) {
			appendFileSync(join(outputDirectory, 'sun-strategy-cells.jsonl'), `${JSON.stringify({
				cellId: record.cellId, adamCandidateId: adam.id, steveOpponentId: steve.id, orientation: cell.orientation,
				seedIndex: cell.seedIndex, seeds: cell.seeds, strategyPolicy: adam.strategyPolicy || 'none', artifact: artifact.directory, cleanTerminal: record.cleanTerminal, telemetry: sunStrategy,
			})}\n`, 'utf8');
		}
		all.push(record);
		latest.set(cell.cellId, record);
		writeJson(join(outputDirectory, 'summary.json'), {
			schemaVersion: 1, status: 'running', runIdentity: identity.identityHash, counts,
			...(roleAliases ? { roleAliases } : {}),
			completedCleanBattles: [...latest.values()].filter(isClean).length,
			trustWarnings,
		});
		process.stdout.write(`[${scheduleIndex + 1}/${schedule.length}] ${cell.cellId}: ${result.status}/${auditStatus}\n`);
	}
	const selected = schedule.flatMap(cell => {
		const record = latest.get(cell.cellId);
		return record ? [record] : [];
	});
	const report = reports(outputDirectory, manifest, selected, counts.totalBattles);
	const sunStrategySummary = sunStrategyReports(outputDirectory, selected);
	const status = report.clean.length === counts.totalBattles ? 'complete' : 'incomplete';
	writeJson(join(outputDirectory, 'summary.json'), {
		schemaVersion: 1,
		status,
		runIdentity: identity.identityHash,
		manifestHash: manifest.manifestHash, beliefHash: manifest.beliefHash,
		...(roleAliases ? { roleAliases } : {}),
		runtime: EVALUATION_RUNTIME, source: identity.source, configuration: identity.configuration,
		trustWarnings: status === 'complete' ? trustWarnings : [...trustWarnings, 'Incomplete cells: ranking uses clean completed battles only.'],
		ranking: report.ranking,
		opponents: manifest.steveOpponents.map(team => ({ id: team.id, label: team.label, weight: team.weight })),
		counts,
		completedCleanBattles: report.clean.length,
		failedOrUncleanBattles: counts.totalBattles - report.clean.length,
		candidateResults: report.candidates,
		pairwiseComparisons: report.pairwise,
		sunStrategySummary,
		pathologyCandidateCount: report.pathologies.length,
		byOrientation: report.orientation,
		byOpponent: report.opponents,
		leadFrequencies: report.leads,
		runtimeAttestation: {
			hostedModelCalls: status === 'complete' ? 0 : null,
			externalInferenceCalls: status === 'complete' ? 0 : null,
			networkPolicy: EVALUATION_RUNTIME.networkPolicy,
			cleanTrialAudits: report.clean.length,
			nonLocalBattleDecisionNetworkCalls: report.clean.length === counts.totalBattles ? 0 : null,
		},
	});
	return outputDirectory;
}
