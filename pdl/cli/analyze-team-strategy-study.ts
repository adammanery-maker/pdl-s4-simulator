import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { Teams } from '../../sim/teams';
import { toID } from '../../sim/dex-data';
import { parseBattleProtocol, type BattleEventRecord } from '../analysis/protocol-events';
import { wilsonInterval } from '../analysis/intervals';
import { loadFixedScenario, type FixedScenario } from '../fixed/scenario';
import { parseBeliefTrace } from '../batch/evidence';

interface TrialRecord {
	pairId: string;
	side: 'forward' | 'reverse';
	matchupId: string;
	repetition: number;
	result: { status: string; winnerTeamId: string | null; failureReason: string | null };
	artifact: string;
	auditStatus: string;
	beliefTruthComparison?: BeliefComparison | null;
}
interface BeliefComparison {
	traceCount: number; comparableTraceCount: number; incorrectEliminations: number;
	meanTruthProbability: number; meanMaximumProbability: number; meanBrierScore: number;
	overconfidentWrongTraces: number; initialMeanTruthProbability: number;
	terminalMeanTruthProbability: number; meanConvergence: number;
}
interface AuditDecision { beliefSamples?: readonly { totalVisits?: number }[] }
interface Audit { decisions?: { p1?: readonly AuditDecision[]; p2?: readonly AuditDecision[] }; integrityViolations?: readonly string[] }
interface TrialData { record: TrialRecord; manifest: Record<string, unknown>; audit: Audit; protocol: string; events: BattleEventRecord; turns: number; }
interface Metric { games: number; wins: number; losses: number; ties: number; turns: number[]; p1: number; p2: number }

function fail(message: string): never { throw new Error(message); }
function argument(name: string): string {
	const index = process.argv.indexOf(`--${name}`);
	if (index < 0 || !process.argv[index + 1]) fail(`Missing --${name}.`);
	return process.argv[index + 1];
}
function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T; }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function csv(value: unknown): string {
	const text = String(value ?? '');
	return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function writeCsv(path: string, columns: readonly string[], rows: readonly Record<string, unknown>[]): void {
	writeFileSync(path, `${columns.join(',')}\n${rows.map(row => columns.map(column => csv(row[column])).join(',')).join('\n')}\n`);
}
function mean(values: readonly number[]): number { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function quantile(values: readonly number[], p: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b); const at = (sorted.length - 1) * p;
	const lower = Math.floor(at); const upper = Math.ceil(at);
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (at - lower);
}
function rate(value: number, total: number): number { return total ? value / total : 0; }
function displaySpecies(id: string): string { return id === 'avalugg' ? 'avalugg-hisui' : id; }
function turns(protocol: string): number {
	const values = [...protocol.matchAll(/^\|turn\|(\d+)/gm)].map(match => Number(match[1]));
	return values.length ? Math.max(...values) : 0;
}
function parseTrials(input: string, scenario: FixedScenario): TrialData[] {
	const records = readFileSync(join(input, 'trials.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as TrialRecord);
	return records.map(record => {
		const manifestPath = join(record.artifact, 'manifest.json');
		const protocolPath = join(record.artifact, 'public.protocol');
		if (!existsSync(manifestPath) || !existsSync(protocolPath)) fail(`Missing required trial artifact for ${record.artifact}.`);
		const manifest = readJson<Record<string, unknown>>(manifestPath);
		const audit = existsSync(join(record.artifact, 'audit.json')) ? readJson<Audit>(join(record.artifact, 'audit.json')) : {};
		const protocol = readFileSync(protocolPath, 'utf8');
		const p1 = manifest.p1 as { teamId: string };
		const p2 = manifest.p2 as { teamId: string };
		const bot = /^\|player\|p1\|([^|]+)/m.exec(protocol)?.[1] || '';
		const bot2 = /^\|player\|p2\|([^|]+)/m.exec(protocol)?.[1] || '';
		return { record, manifest, audit, protocol,
			events: parseBattleProtocol(protocol, { p1: { teamId: p1.teamId, botName: bot }, p2: { teamId: p2.teamId, botName: bot2 } }), turns: turns(protocol) };
	});
}
function buildMaps(scenario: FixedScenario) {
	const builds = new Map<string, { teamId: string; species: string[] }>();
	for (const team of scenario.teams) for (const build of team.builds) builds.set(build.id, { teamId: team.teamId, species: build.team.map(set => toID(set.species)) });
	return builds;
}
function metricRows(groups: Map<string, Metric>, keys: readonly string[]): Record<string, unknown>[] {
	return [...groups.entries()].map(([key, value]) => {
		const [ciLow, ciHigh] = wilsonInterval(value.wins, value.games);
		const pieces = key.split('|'); const row: Record<string, unknown> = {};
		keys.forEach((keyName, index) => { row[keyName] = pieces[index] || ''; });
		return { ...row, games: value.games, wins: value.wins, losses: value.losses, ties: value.ties,
			win_rate: rate(value.wins, value.games), wilson95_low: ciLow, wilson95_high: ciHigh,
			mean_turns: mean(value.turns), median_turns: quantile(value.turns, .5), iqr_turns: quantile(value.turns, .75) - quantile(value.turns, .25),
			p1_games: value.p1, p2_games: value.p2 };
	});
}
function addMetric(groups: Map<string, Metric>, key: string, data: TrialData, adamId: string): void {
	const metric = groups.get(key) || { games: 0, wins: 0, losses: 0, ties: 0, turns: [], p1: 0, p2: 0 };
	metric.games++; metric.turns.push(data.turns);
	if (data.record.result.winnerTeamId === adamId) metric.wins++;
	else if (data.record.result.winnerTeamId) metric.losses++; else metric.ties++;
	const p1 = (data.manifest.p1 as { teamId: string }).teamId;
	if (p1 === adamId) metric.p1++; else metric.p2++;
	groups.set(key, metric);
}
function trueCandidateKeys(exported: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const set of Teams.import(exported) || []) {
		const evs = [set.evs.hp, set.evs.atk, set.evs.def, set.evs.spa, set.evs.spd, set.evs.spe];
		const tera = toID(set.teraType || 'typeless');
		result.set(toID(set.species), [tera === 'typeless' ? '' : tera, toID(set.ability || 'none'), toID(set.item || 'none'), toID(set.nature || 'serious'), evs.join(','), ...set.moves.map(toID)].join('|'));
	}
	return result;
}
function posteriorRows(data: readonly TrialData[]): Record<string, unknown>[] {
	const groups = new Map<string, { traces: number; eliminated: number; wrong: number; truth: number[]; maximum: number[]; brier: number[]; initial: number[]; terminal: number[] }>();
	for (const trial of data) {
		const privatePath = join(trial.record.artifact, 'private-ground-truth-audit.json');
		if (!existsSync(privatePath)) continue;
		const privateAudit = readJson<{ p1?: { exported?: string }; p2?: { exported?: string } }>(privatePath);
		for (const side of ['p1', 'p2'] as const) {
			const own = (trial.manifest[side] as { teamId: string }).teamId;
			const other = (trial.manifest[side === 'p1' ? 'p2' : 'p1'] as { teamId: string }).teamId;
			const ownLog = join(trial.record.artifact, `${side}.log`);
			const truth = trueCandidateKeys((side === 'p1' ? privateAudit.p2 : privateAudit.p1)?.exported || '');
			const bySpecies = new Map<string, number[]>();
			for (const raw of parseBeliefTrace(existsSync(ownLog) ? readFileSync(ownLog, 'utf8') : '')) {
				const trace = raw as { species?: string; weights?: Record<string, unknown> };
				const species = toID(trace.species || ''); const expected = truth.get(species); const weights = trace.weights || {};
				const probabilities = Object.values(weights).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
				if (!species || !expected || !probabilities.length) continue;
				const value = number(weights[expected]); const key = `${own}|${other}|${trial.record.matchupId}`;
				const group = groups.get(key) || { traces: 0, eliminated: 0, wrong: 0, truth: [], maximum: [], brier: [], initial: [], terminal: [] };
				group.traces++; group.eliminated += value === 0 ? 1 : 0; const maximum = Math.max(...probabilities);
				group.wrong += maximum >= .9 && value < .1 ? 1 : 0; group.truth.push(value); group.maximum.push(maximum);
				group.brier.push(1 - (2 * value) + probabilities.reduce((sum, p) => sum + p * p, 0)); groups.set(key, group);
				bySpecies.set(species, [...(bySpecies.get(species) || []), value]);
			}
			const group = groups.get(`${own}|${other}|${trial.record.matchupId}`);
			if (group) for (const series of bySpecies.values()) { group.initial.push(series[0]); group.terminal.push(series[series.length - 1]); }
		}
	}
	return [...groups.entries()].map(([key, value]) => {
		const [agent_team, opponent_team, matchup_id] = key.split('|');
		return { agent_team, opponent_team, matchup_id, comparable_traces: value.traces, incorrect_eliminations: value.eliminated, overconfident_wrong: value.wrong,
			mean_truth_probability: mean(value.truth), mean_maximum_probability: mean(value.maximum), mean_brier_score: mean(value.brier),
			initial_truth_probability: mean(value.initial), terminal_truth_probability: mean(value.terminal), convergence: mean(value.terminal) - mean(value.initial) };
	});
}
function moveCount(events: BattleEventRecord, teamId: string, species: string, move: string): number {
	return events.moves.filter(event => event.teamId === teamId && event.species === species && event.move === move).length;
}
function strategyRows(data: readonly TrialData[], scenario: FixedScenario): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = []; const adam = scenario.teams[0].teamId; const steve = scenario.teams[1].teamId;
	const metrics: Record<string, readonly [string, string, string][]> = {
		'adam-sun': [['whimsicott_sunny_day', adam, 'whimsicott|sunnyday'], ['uxie_sunny_day', adam, 'uxie|sunnyday'], ['scovillain_entries', adam, 'scovillain|entry'], ['scovillain_growth', adam, 'scovillain|growth'], ['scovillain_kos', adam, 'scovillain|ko'], ['scovillain_tera', adam, 'scovillain|tera']],
		'adam-shell-smash': [['whimsicott_memento', adam, 'whimsicott|memento'], ['uxie_memento', adam, 'uxie|memento'], ['incineroar_parting_shot', adam, 'incineroar|partingshot'], ['drednaw_entries', adam, 'drednaw|entry'], ['drednaw_shell_smash', adam, 'drednaw|shellsmash'], ['drednaw_kos', adam, 'drednaw|ko']],
		'adam-balance': [['golem_stealth_rock', adam, 'golem|stealthrock'], ['tatsugiri_rapid_spin', adam, 'tatsugiri|rapidspin'], ['incineroar_parting_shot', adam, 'incineroar|partingshot'], ['uxie_u_turn', adam, 'uxie|uturn'], ['magneton_volt_switch', adam, 'magneton|voltswitch']],
		'steve-screens-hazards': [['grimmsnarl_reflect', steve, 'grimmsnarl|reflect'], ['grimmsnarl_light_screen', steve, 'grimmsnarl|lightscreen'], ['avalugg_rapid_spin', steve, 'avalugg|rapidspin'], ['delphox_kos', steve, 'delphox|ko']],
		'steve-volturn-unburden': [['drifblim_unburden_proxy_acrobatics', steve, 'drifblim|acrobatics'], ['electivire_volt_switch', steve, 'electivire|voltswitch'], ['ambipom_fake_out', steve, 'ambipom|fakeout']],
		'steve-pivot-hazards': [['grimmsnarl_thunder_wave', steve, 'grimmsnarl|thunderwave'], ['avalugg_stealth_rock', steve, 'avalugg|stealthrock'], ['drifblim_defog', steve, 'drifblim|defog'], ['ambipom_u_turn', steve, 'ambipom|uturn']],
	};
	for (const [build, definitions] of Object.entries(metrics)) for (const [label, team, spec] of definitions) {
		const [species, action] = spec.split('|'); let count = 0; let games = 0;
		for (const trial of data.filter(value => value.record.matchupId.includes(build))) {
			games++; if (action === 'entry') count += [...trial.protocol.matchAll(new RegExp(`^\\|(switch|drag)\\|p[12]a: ${displaySpecies(species)}`, 'gmi'))].length;
			else if (action === 'ko') count += trial.events.moves.filter(event => event.teamId === team && event.species === species && event.ko).length;
			else if (action === 'tera') count += trial.events.tera.filter(event => event.teamId === team && event.species === species).length;
			else count += moveCount(trial.events, team, species, action);
		}
		rows.push({ build_id: build, metric: label, count, games, rate_per_game: rate(count, games), definition: action === 'entry' ? 'public switch/drag events' : action === 'ko' ? 'KOs attributed by public protocol' : 'public move or Tera events' });
	}
	return rows;
}
function pathologyRows(data: readonly TrialData[]): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = []; const patterns: readonly [string, (trial: TrialData) => boolean][] = [
		['repeated_identical_move_3plus', (trial: TrialData) => /\|move\|([^|]+)\|([^|]+)\|[^\n]+\n(?:[^\n]*\n){0,8}?\|move\|\1\|\2\|[^\n]+\n(?:[^\n]*\n){0,8}?\|move\|\1\|\2\|/g.test(trial.protocol)],
		['stealth_rock_rapid_spin_both_present', (trial: TrialData) => /\|move\|[^|]+\|Stealth Rock\|/.test(trial.protocol) && /\|move\|[^|]+\|Rapid Spin\|/.test(trial.protocol)],
		['recovery_attack_cycle_proxy', (trial: TrialData) => /\|move\|[^|]+\|(Slack Off|Recover|Roost)\|/.test(trial.protocol) && trial.events.moves.some(event => event.damagePercent > 0)],
	];
	for (const [name, predicate] of patterns) {
		const ids = data.filter(predicate).map(trial => trial.record.artifact);
		rows.push({ pathology: name, count: ids.length, trial_artifacts: ids.join(';'), interpretation: 'screening proxy; inspect listed public protocols before treating as a strategic defect' });
	}
	return rows;
}
function report(input: string, scenario: FixedScenario, trials: readonly TrialData[], failures: readonly TrialData[]): string {
	const clean = trials.filter(trial => ['completed', 'tied'].includes(trial.record.result.status) && trial.record.auditStatus === 'clean');
	const adam = scenario.teams[0].teamId; const adamWins = clean.filter(trial => trial.record.result.winnerTeamId === adam).length;
	return `# Adam vs Steve team-strategy study\n\nThis report is generated from the fixed-matchup public protocols and post-battle audit artifacts in \`${input}\`. The live decision path remains local Showdown → Foul Play posterior → existing weighted correlated sampler → poke-engine Rust MCTS → deterministic argmax.\n\n## Inclusion\n\n- Requested trials: ${trials.length}\n- Clean terminal trials included in results: ${clean.length}\n- Excluded/incomplete/unclean trials: ${failures.length}\n- Adam wins among included trials: ${adamWins}/${clean.length} (${rate(adamWins, clean.length).toFixed(3)})\n\n## Reading the outputs\n\n- Win rates are empirical Monte Carlo frequencies with two-sided 95% Wilson intervals. They are not MCTS values or calibrated match-win probabilities.\n- Every planned repetition is side-balanced by forward/reverse pairing. Rows retain side counts so orientation can be checked directly.\n- Pairwise comparisons are unpaired descriptive differences; Showdown battle seeds are not replayed across builds. No causal claim should be drawn from a smoke run.\n- Posterior diagnostics read private ground truth **only after battle**. The runtime agent never receives that file.\n- Search performance reports visits and sampled worlds from decision audit. Wall-clock per-decision time is intentionally blank because the runtime does not record it.\n- Pathology rows are conservative screening proxies. Listed protocols are the evidence; a count alone does not prove a strategic failure.\n\n## Configuration\n\n- Scenario: ${scenario.id}\n- Search: 250 ms per belief world, belief-samples=1, deterministic argmax. Actual sampled-world counts are in statistics/search-performance.csv.\n- Team corrections and validation: \`pdl/studies/adam-vs-steve-team-strategy/TEAM_CORRECTIONS.json\` and \`VALIDATION.json\`\n\n`;
}
function main(): void {
	const input = resolve(argument('input')); const scenario = loadFixedScenario(argument('scenario')); const statistics = join(input, 'statistics');
	if (!existsSync(join(input, 'trials.jsonl'))) fail(`No trials.jsonl under ${input}.`); mkdirSync(statistics, { recursive: true });
	const data = parseTrials(input, scenario); const adam = scenario.teams[0].teamId;
	const included = data.filter(trial => ['completed', 'tied'].includes(trial.record.result.status) && trial.record.auditStatus === 'clean'); const failures = data.filter(trial => !included.includes(trial));
	const cells = new Map<string, Metric>(), adamBuilds = new Map<string, Metric>(), steveBuilds = new Map<string, Metric>(), sides = new Map<string, Metric>();
	for (const trial of included) {
		const [adamBuild, steveBuild] = trial.record.matchupId.split('-vs-'); addMetric(cells, `${adamBuild}|${steveBuild}`, trial, adam); addMetric(adamBuilds, adamBuild, trial, adam); addMetric(steveBuilds, steveBuild, trial, adam); addMetric(sides, trial.record.side, trial, adam);
	}
	writeCsv(join(statistics, 'cell-results.csv'), ['adam_build', 'steve_build', 'games', 'wins', 'losses', 'ties', 'win_rate', 'wilson95_low', 'wilson95_high', 'mean_turns', 'median_turns', 'iqr_turns', 'p1_games', 'p2_games'], metricRows(cells, ['adam_build', 'steve_build']));
	writeCsv(join(statistics, 'adam-build-results.csv'), ['adam_build', 'games', 'wins', 'losses', 'ties', 'win_rate', 'wilson95_low', 'wilson95_high', 'mean_turns', 'median_turns', 'iqr_turns', 'p1_games', 'p2_games'], metricRows(adamBuilds, ['adam_build']));
	writeCsv(join(statistics, 'steve-build-results.csv'), ['steve_build', 'games', 'wins', 'losses', 'ties', 'win_rate', 'wilson95_low', 'wilson95_high', 'mean_turns', 'median_turns', 'iqr_turns', 'p1_games', 'p2_games'], metricRows(steveBuilds, ['steve_build']));
	writeCsv(join(statistics, 'side-results.csv'), ['side', 'games', 'wins', 'losses', 'ties', 'win_rate', 'wilson95_low', 'wilson95_high', 'mean_turns', 'median_turns', 'iqr_turns', 'p1_games', 'p2_games'], metricRows(sides, ['side']));
	const pokemon = new Map<string, { entries: number; moves: number; kos: number; faints: number; tera: number; games: Set<string> }>();
	for (const trial of included) {
		const privateAuditPath = join(trial.record.artifact, 'private-ground-truth-audit.json');
		const privateAudit = existsSync(privateAuditPath) ? readJson<{ p1?: { exported?: string }; p2?: { exported?: string } }>(privateAuditPath) : {};
		const manifestSides = ['p1', 'p2'] as const;
		for (const side of manifestSides) {
			const team = trial.manifest[side] as { teamId: string };
			const exported = privateAudit[side]?.exported;
			for (const set of exported ? Teams.import(exported) || [] : []) { const key = `${team.teamId}|${trial.record.matchupId}|${toID(set.species)}`; const value = pokemon.get(key) || { entries: 0, moves: 0, kos: 0, faints: 0, tera: 0, games: new Set<string>() }; value.games.add(trial.record.artifact); pokemon.set(key, value); }
		}
		for (const event of trial.events.moves) { const key = `${event.teamId}|${trial.record.matchupId}|${event.species}`; const value = pokemon.get(key); if (value) { value.moves++; value.kos += event.ko ? 1 : 0; } }
		for (const event of trial.events.tera) { const key = `${event.teamId}|${trial.record.matchupId}|${event.species}`; const value = pokemon.get(key); if (value) value.tera++; }
		for (const line of trial.protocol.split(/\r?\n/)) { const match = /^\|(switch|drag)\|p[12]a: ([^|]+)\|/.exec(line); if (match) { const side = line.includes('|p1a:') ? 'p1' : 'p2'; const team = trial.manifest[side] as { teamId: string }; const key = `${team.teamId}|${trial.record.matchupId}|${toID(match[2])}`; const value = pokemon.get(key); if (value) value.entries++; } const faint = /^\|faint\|p([12])a: ([^|]+)/.exec(line); if (faint) { const team = trial.manifest[`p${faint[1]}`] as { teamId: string }; const value = pokemon.get(`${team.teamId}|${trial.record.matchupId}|${toID(faint[2])}`); if (value) value.faints++; } }
	}
	writeCsv(join(statistics, 'pokemon-results.csv'), ['team_id', 'matchup_id', 'species', 'games', 'entries', 'moves', 'kos', 'faints', 'tera_uses', 'survived_games', 'note'], [...pokemon.entries()].map(([key, value]) => { const [team_id, matchup_id, species] = key.split('|'); return { team_id, matchup_id, species, games: value.games.size, entries: value.entries, moves: value.moves, kos: value.kos, faints: value.faints, tera_uses: value.tera, survived_games: Math.max(0, value.games.size - value.faints), note: 'End HP is not reconstructed from public protocol.' }; }));
	const teraRows = included.flatMap(trial => trial.events.tera.map(event => ({ matchup_id: trial.record.matchupId, team_id: event.teamId, species: event.species, tera_type: event.type, winner_team_id: trial.record.result.winnerTeamId || '', turn: [...trial.protocol.slice(0, trial.protocol.indexOf(`|-terastallize|`)).matchAll(/^\|turn\|(\d+)/gm)].pop()?.[1] || '', audit_status: trial.record.auditStatus })));
	writeCsv(join(statistics, 'tera-results.csv'), ['matchup_id', 'team_id', 'species', 'tera_type', 'winner_team_id', 'turn', 'audit_status'], teraRows);
	writeCsv(join(statistics, 'strategy-telemetry.csv'), ['build_id', 'metric', 'count', 'games', 'rate_per_game', 'definition'], strategyRows(included, scenario));
	const comparisonRows = [...adamBuilds.entries()].flatMap(([a, left]) => [...adamBuilds.entries()].filter(([b]) => a < b).map(([b, right]) => { const difference = rate(left.wins, left.games) - rate(right.wins, right.games); const se = Math.sqrt(rate(left.wins, left.games) * (1 - rate(left.wins, left.games)) / left.games + rate(right.wins, right.games) * (1 - rate(right.wins, right.games)) / right.games); return { left_build: a, right_build: b, win_rate_difference: difference, wald95_low: difference - 1.96 * se, wald95_high: difference + 1.96 * se, method: 'unpaired descriptive Wald interval; no common battle RNG seeds' }; }));
	writeCsv(join(statistics, 'pairwise-comparisons.csv'), ['left_build', 'right_build', 'win_rate_difference', 'wald95_low', 'wald95_high', 'method'], comparisonRows);
	const decisionRows: Record<string, unknown>[] = []; for (const trial of included) for (const side of ['p1', 'p2'] as const) { const decisions = trial.audit.decisions?.[side] || []; const visits = decisions.flatMap(decision => (decision.beliefSamples || []).map(sample => number(sample.totalVisits))); decisionRows.push({ trial_artifact: trial.record.artifact, matchup_id: trial.record.matchupId, side, decisions: decisions.length, sampled_worlds: visits.length, mean_visits: mean(visits), median_visits: quantile(visits, .5), p95_visits: quantile(visits, .95), search_ms_per_world: (trial.manifest.metadata as { searchTimeMs?: number }).searchTimeMs || '', wall_clock_decision_ms: '', note: 'Wall-clock decision timing is not recorded by this runtime.' }); }
	writeCsv(join(statistics, 'search-performance.csv'), ['trial_artifact', 'matchup_id', 'side', 'decisions', 'sampled_worlds', 'mean_visits', 'median_visits', 'p95_visits', 'search_ms_per_world', 'wall_clock_decision_ms', 'note'], decisionRows);
	writeCsv(join(statistics, 'posterior-diagnostics.csv'), ['agent_team', 'opponent_team', 'matchup_id', 'comparable_traces', 'incorrect_eliminations', 'overconfident_wrong', 'mean_truth_probability', 'mean_maximum_probability', 'mean_brier_score', 'initial_truth_probability', 'terminal_truth_probability', 'convergence'], posteriorRows(included));
	const pathology = [...pathologyRows(included), ...failures.map(trial => ({ pathology: 'excluded_trial', count: 1, trial_artifacts: trial.record.artifact, interpretation: `${trial.record.result.status}; audit=${trial.record.auditStatus}; ${trial.record.result.failureReason || ''}` }))];
	writeCsv(join(statistics, 'pathology-counts.csv'), ['pathology', 'count', 'trial_artifacts', 'interpretation'], pathology);
	writeFileSync(join(input, 'REPORT.md'), report(input, scenario, data, failures));
	process.stdout.write(`Study analysis: ${join(input, 'REPORT.md')}\n`);
}
if (require.main === module) main();
