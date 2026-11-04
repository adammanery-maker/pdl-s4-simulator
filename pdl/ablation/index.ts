import { createHash } from 'crypto';
import { toID } from '../../sim/dex-data';
import { Teams, type PokemonSet } from '../../sim/teams';

export type AblationChange =
	| { readonly type: 'identity' } |
	{ readonly type: 'roster-slot', readonly fromSpecies: string, readonly toSpecies: string } |
	{ readonly type: 'move' | 'item' | 'ability' | 'nature' | 'tera-type', readonly species: string, readonly from: string, readonly to: string } |
	{ readonly type: 'ev-spread', readonly species: string, readonly from: Readonly<Record<string, number>>, readonly to: Readonly<Record<string, number>> } |
	{ readonly type: 'captain-eligibility', readonly species: string, readonly from: boolean, readonly to: boolean };

export interface AblationDifference {
	readonly species: string;
	readonly field: string;
	readonly before: unknown;
	readonly after: unknown;
}

interface ValidationInput {
	readonly baselineExported: string;
	readonly candidateExported: string;
	readonly baselineTeraCaptains: readonly string[];
	readonly candidateTeraCaptains: readonly string[];
	readonly change: AblationChange;
}

function normalizedSet(set: PokemonSet): Record<string, unknown> {
	const evs = set.evs || {};
	return {
		species: toID(set.species), item: toID(set.item || ''), ability: toID(set.ability || ''),
		nature: toID(set.nature || 'serious'), teraType: toID(set.teraType || ''),
		evs: Object.fromEntries(['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(stat => [stat, evs[stat as keyof typeof evs] || 0])),
		moves: (set.moves || []).map(toID),
	};
}

function team(exported: string, label: string): readonly Record<string, unknown>[] {
	const parsed = Teams.import(exported);
	if (!parsed?.length) throw new Error(`${label} team must be valid Showdown export text.`);
	if (new Set(parsed.map(set => toID(set.species))).size !== parsed.length) throw new Error(`${label} team contains duplicate species.`);
	return parsed.map(normalizedSet);
}

function differences(input: ValidationInput): AblationDifference[] {
	const baseline = team(input.baselineExported, 'Baseline');
	const candidate = team(input.candidateExported, 'Candidate');
	const result: AblationDifference[] = [];
	const length = Math.max(baseline.length, candidate.length);
	for (let index = 0; index < length; index++) {
		const left = baseline[index];
		const right = candidate[index];
		if (!left || !right) {
			const speciesValue = left?.species ?? right?.species;
			const species = typeof speciesValue === 'string' ? speciesValue : String(index);
			result.push({ species, field: `roster.${index}`, before: left || null, after: right || null });
			continue;
		}
		if (left.species !== right.species) {
			result.push({ species: String(left.species), field: `roster.${index}`, before: left, after: right });
			continue;
		}
		for (const field of ['item', 'ability', 'nature', 'teraType', 'evs'] as const) {
			if (JSON.stringify(left[field]) !== JSON.stringify(right[field])) result.push({ species: String(left.species), field, before: left[field], after: right[field] });
		}
		const leftMoves = left.moves as readonly string[];
		const rightMoves = right.moves as readonly string[];
		for (let slot = 0; slot < Math.max(leftMoves.length, rightMoves.length); slot++) {
			if (leftMoves[slot] !== rightMoves[slot]) result.push({ species: String(left.species), field: `moves.${slot}`, before: leftMoves[slot] || null, after: rightMoves[slot] || null });
		}
	}
	const leftCaptains = new Set(input.baselineTeraCaptains.map(toID));
	const rightCaptains = new Set(input.candidateTeraCaptains.map(toID));
	for (const species of new Set([...leftCaptains, ...rightCaptains])) {
		if (leftCaptains.has(species) !== rightCaptains.has(species)) result.push({ species, field: 'captainEligibility', before: leftCaptains.has(species), after: rightCaptains.has(species) });
	}
	return result;
}

function expectedDifference(change: AblationChange): Pick<AblationDifference, 'species' | 'field' | 'before' | 'after'> | null {
	if (change.type === 'identity') return null;
	if (change.type === 'roster-slot') return { species: toID(change.fromSpecies), field: 'roster', before: toID(change.fromSpecies), after: toID(change.toSpecies) };
	if (change.type === 'captain-eligibility') return { species: toID(change.species), field: 'captainEligibility', before: change.from, after: change.to };
	if (change.type === 'ev-spread') return { species: toID(change.species), field: 'evs', before: change.from, after: change.to };
	const field = change.type === 'tera-type' ? 'teraType' : change.type;
	return { species: toID(change.species), field, before: toID(change.from), after: toID(change.to) };
}

/** Rejects any team mutation beyond the single declared experimental variable. */
export function validateAblationDefinition(input: ValidationInput): { readonly differences: readonly AblationDifference[] } {
	const supported = ['identity', 'roster-slot', 'move', 'item', 'ability', 'nature', 'ev-spread', 'tera-type', 'captain-eligibility'];
	if (!supported.includes(input.change.type)) throw new Error(`Unsupported ablation change type: ${String(input.change.type)}.`);
	const actual = differences(input);
	if (input.change.type === 'identity') {
		if (actual.length) throw new Error(`A/A identity requires identical teams; found ${actual.length} difference(s).`);
		return { differences: actual };
	}
	const expected = expectedDifference(input.change)!;
	if (actual.length !== 1) throw new Error(`Ablation must contain exactly one declared difference; found ${actual.length}.`);
	const found = actual[0];
	const fieldMatches = expected.field === 'roster' ? found.field.startsWith('roster.') :
		expected.field === 'move' ? found.field.startsWith('moves.') : found.field === expected.field;
	const before = found.field.startsWith('roster.') ? toID(String((found.before as Record<string, unknown>).species)) : found.before;
	const after = found.field.startsWith('roster.') ? toID(String((found.after as Record<string, unknown>).species)) : found.after;
	if (found.species !== expected.species || !fieldMatches || JSON.stringify(before) !== JSON.stringify(expected.before) || JSON.stringify(after) !== JSON.stringify(expected.after)) {
		throw new Error(`Observed team mutation does not match declared difference: ${JSON.stringify(found)}.`);
	}
	return { differences: actual };
}

export interface PairedScheduleInput {
	readonly runId: string;
	readonly opponentBuildIds: readonly string[];
	readonly seedsPerCell: number;
}

export interface VariantSeeds {
	readonly battleSeed: string;
	readonly searchSeed: string;
	readonly beliefSeed: string;
	readonly worldAllocationSeed: string;
}

export interface PairedScheduleEntry {
	readonly pairId: string;
	readonly opponentBuildId: string;
	readonly orientation: 'forward' | 'reverse';
	readonly seedIndex: number;
	readonly baseline: VariantSeeds;
	readonly candidate: VariantSeeds;
}

function seed(namespace: string, value: string): string {
	return createHash('sha256').update(`${namespace}\0${value}`).digest('hex').slice(0, 16);
}

/** Builds a deterministic common-random-number schedule. */
export function buildPairedSchedule(input: PairedScheduleInput): readonly PairedScheduleEntry[] {
	if (!input.runId.trim()) throw new Error('runId must be non-empty.');
	if (!Number.isInteger(input.seedsPerCell) || input.seedsPerCell < 1) throw new Error('seedsPerCell must be a positive integer.');
	if (!input.opponentBuildIds.length || new Set(input.opponentBuildIds).size !== input.opponentBuildIds.length) throw new Error('opponentBuildIds must be distinct and non-empty.');
	const result: PairedScheduleEntry[] = [];
	for (const opponentBuildId of input.opponentBuildIds) for (const orientation of ['forward', 'reverse'] as const) {
		for (let seedIndex = 1; seedIndex <= input.seedsPerCell; seedIndex++) {
			const pairId = `${toID(input.runId)}-${toID(opponentBuildId)}-${orientation}-${String(seedIndex).padStart(3, '0')}`;
			const value = `${input.runId}|${opponentBuildId}|${orientation}|${seedIndex}`;
			const common = {
				battleSeed: `gen5,${seed('battle', value)}`,
				searchSeed: seed('search', value), beliefSeed: seed('belief', value),
				worldAllocationSeed: seed('world', value),
			};
			result.push({ pairId, opponentBuildId, orientation, seedIndex, baseline: common, candidate: { ...common } });
		}
	}
	return result;
}

export interface PairedOutcome {
	readonly opponentBuildId: string;
	readonly orientation: 'forward' | 'reverse';
	readonly baselineWon: boolean;
	readonly candidateWon: boolean;
}

function binomialCoefficient(n: number, k: number): number {
	let result = 1;
	for (let i = 1; i <= Math.min(k, n - k); i++) result = result * (n - i + 1) / i;
	return result;
}

function exactMcNemar(left: number, right: number): number | null {
	const total = left + right;
	if (!total) return null;
	const tail = Array.from({ length: Math.min(left, right) + 1 }, (_, k) => binomialCoefficient(total, k) * 0.5 ** total).reduce((a, b) => a + b, 0);
	return Math.min(1, 2 * tail);
}

function seededRandom(seedValue: string): () => number {
	let state = Number.parseInt(createHash('sha256').update(seedValue).digest('hex').slice(0, 8), 16) || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

function interval(outcomes: readonly PairedOutcome[], seedValue: string): readonly [number, number] {
	if (!outcomes.length) return [0, 0];
	const random = seededRandom(seedValue);
	const values: number[] = [];
	for (let sample = 0; sample < 10_000; sample++) {
		let sum = 0;
		for (const _outcome of outcomes) {
			const row = outcomes[Math.floor(random() * outcomes.length)];
			sum += Number(row.candidateWon) - Number(row.baselineWon);
		}
		values.push(sum / outcomes.length);
	}
	values.sort((a, b) => a - b);
	return [values[Math.floor(values.length * 0.025)], values[Math.floor(values.length * 0.975)]];
}

function compact(outcomes: readonly PairedOutcome[]) {
	const baselineWins = outcomes.filter(row => row.baselineWon).length;
	const candidateWins = outcomes.filter(row => row.candidateWon).length;
	return { pairs: outcomes.length, baselineWins, candidateWins, winRateDifference: outcomes.length ? (candidateWins - baselineWins) / outcomes.length : 0 };
}

/** Reports ordinary rates alongside paired discordant outcomes. */
export function summarizePairedOutcomes(outcomes: readonly PairedOutcome[], bootstrapSeed: string) {
	const bothWin = outcomes.filter(row => row.baselineWon && row.candidateWon).length;
	const bothLose = outcomes.filter(row => !row.baselineWon && !row.candidateWon).length;
	const baselineOnlyWin = outcomes.filter(row => row.baselineWon && !row.candidateWon).length;
	const candidateOnlyWin = outcomes.filter(row => !row.baselineWon && row.candidateWon).length;
	const orientations = Object.fromEntries((['forward', 'reverse'] as const).map(value => [value, compact(outcomes.filter(row => row.orientation === value))]));
	const builds = Object.fromEntries([...new Set(outcomes.map(row => row.opponentBuildId))].map(value => [value, compact(outcomes.filter(row => row.opponentBuildId === value))]));
	return {
		...compact(outcomes),
		paired: { bothWin, bothLose, baselineOnlyWin, candidateOnlyWin, netDiscordantAdvantage: candidateOnlyWin - baselineOnlyWin },
		mcnemar: { discordant: baselineOnlyWin + candidateOnlyWin, exactTwoSidedP: exactMcNemar(baselineOnlyWin, candidateOnlyWin) },
		pairedBootstrap95: interval(outcomes, bootstrapSeed), byOrientation: orientations, byOpponentBuild: builds,
	};
}

export interface ProtocolMetrics {
	readonly generic: { turns: number, switches: number, hazardsSet: number, hazardsRemoved: number, teraCount: number, kosBySpecies: Readonly<Record<string, number>>, survival: Readonly<Record<string, boolean>> };
	readonly setup: { sunnyDayAttempts: number, firstSunnyDayTurn: number | null, scovillainEntriesUnderSun: number, attacksUnderSun: number, growthAttempts: number, postGrowthAttackReached: number, kosUnderSun: number, mementoAttempts: number, mementoWhileDrednawAlive: number, mementoToDrednaw: number, mementoToDrednawToShellSmash: number, shellSmashAttempts: number, setupSurvival: number, firstBoostedAttack: number, postSetupKos: number };
	readonly pathologyCandidates: readonly { readonly kind: string, readonly turn: number, readonly evidence: string }[];
}

/** Extracts public, audit-safe strategic metrics and conservative review candidates. */
export function analyzeAblationProtocol(protocol: string, adamSide: 'p1' | 'p2'): ProtocolMetrics {
	let turn = 0;
	let sun = false;
	let growthTurn: number | null = null;
	let smashTurn: number | null = null;
	let mementoTurn: number | null = null;
	let mementoToDrednaw = 0;
	let chained = 0;
	let boostedAttack = 0;
	const living = new Set<string>();
	const fainted = new Set<string>();
	const kos: Record<string, number> = {};
	const actions: { turn: number, actor: string, move: string }[] = [];
	const setup = { sunnyDayAttempts: 0, firstSunnyDayTurn: null as number | null, scovillainEntriesUnderSun: 0, attacksUnderSun: 0, growthAttempts: 0, postGrowthAttackReached: 0, kosUnderSun: 0, mementoAttempts: 0, mementoWhileDrednawAlive: 0, mementoToDrednaw: 0, mementoToDrednawToShellSmash: 0, shellSmashAttempts: 0, setupSurvival: 0, firstBoostedAttack: 0, postSetupKos: 0 };
	let switches = 0;
	let hazardsSet = 0;
	let hazardsRemoved = 0;
	let teraCount = 0;
	let lastAdamActor = '';
	const pathologies: { kind: string, turn: number, evidence: string }[] = [];
	for (const line of protocol.split(/\r?\n/)) {
		const fields = line.split('|');
		const type = fields[1];
		if (type === 'turn') {
			turn = Number(fields[2]) || turn;
			continue;
		}
		const sideMatch = /^(p[12])(?:a)?:\s*([^|]+)/.exec(fields[2] || '');
		const side = sideMatch?.[1];
		const actor = toID(sideMatch?.[2] || '');
		if ((type === 'switch' || type === 'drag') && side === adamSide) {
			switches++;
			living.add(actor);
			if (sun && actor === 'scovillain') setup.scovillainEntriesUnderSun++;
			if (mementoTurn !== null && actor === 'drednaw') { mementoToDrednaw++; mementoTurn = null; }
			continue;
		}
		if (type === 'move' && side === adamSide) {
			const move = toID(fields[3] || '');
			lastAdamActor = actor;
			actions.push({ turn, actor, move });
			if (move === 'sunnyday') {
				setup.sunnyDayAttempts++;
				setup.firstSunnyDayTurn ??= turn;
				sun = true;
			}
			if (move === 'growth') {
				setup.growthAttempts++;
				growthTurn = turn;
			} else if (growthTurn !== null && actor === 'scovillain') {
				setup.postGrowthAttackReached++;
				growthTurn = null;
			}
			if (sun && actor === 'scovillain' && move !== 'growth' && move !== 'sunnyday') setup.attacksUnderSun++;
			if (move === 'memento') {
				setup.mementoAttempts++;
				if (!fainted.has('drednaw')) setup.mementoWhileDrednawAlive++;
				mementoTurn = turn;
			}
			if (move === 'shellsmash') {
				setup.shellSmashAttempts++;
				smashTurn = turn;
				if (mementoToDrednaw > chained) {
					chained++;
					setup.mementoToDrednawToShellSmash++;
				}
			} else if (smashTurn !== null && actor === 'drednaw') {
				setup.firstBoostedAttack++;
				boostedAttack++;
				smashTurn = null;
			}
			continue;
		}
		if (type === '-weather' && toID(fields[2] || '') === 'none') sun = false;
		if (type === '-sidestart') hazardsSet++;
		if (type === '-sideend') hazardsRemoved++;
		if (type === '-terastallize' && side === adamSide) teraCount++;
		if (type === 'faint') {
			fainted.add(actor); living.delete(actor);
			if (side !== adamSide && lastAdamActor) {
				kos[lastAdamActor] = (kos[lastAdamActor] || 0) + 1;
				if (sun && lastAdamActor === 'scovillain') setup.kosUnderSun++;
				if (boostedAttack && lastAdamActor === 'drednaw') setup.postSetupKos++;
			}
			if (side === adamSide && actor === 'drednaw' && smashTurn !== null && turn - smashTurn <= 1) pathologies.push({ kind: 'setup-immediately-followed-by-death', turn, evidence: 'Drednaw fainted before a post-Shell-Smash attack.' });
		}
	}
	setup.mementoToDrednaw = mementoToDrednaw;
	setup.setupSurvival = setup.shellSmashAttempts - pathologies.filter(value => value.kind === 'setup-immediately-followed-by-death').length;
	if (setup.mementoAttempts && !setup.mementoToDrednaw) pathologies.push({ kind: 'memento-without-drednaw-followup', turn, evidence: 'Memento was not followed by a Drednaw entry.' });
	if (setup.sunnyDayAttempts && !setup.attacksUnderSun) pathologies.push({ kind: 'sun-without-exploitation', turn, evidence: 'Sunny Day occurred without a Scovillain attack under Sun.' });
	for (let i = 3; i < actions.length; i++) {
		const window = actions.slice(i - 3, i + 1).map(value => `${value.actor}:${value.move}`);
		if (window[0] === window[2] && window[1] === window[3]) pathologies.push({ kind: 'repeated-action-cycle', turn: actions[i].turn, evidence: window.join(' → ') });
	}
	const turns = [...protocol.matchAll(/^\|turn\|(\d+)/gm)].map(match => Number(match[1]));
	return { generic: { turns: turns.length ? Math.max(...turns) : 0, switches, hazardsSet, hazardsRemoved, teraCount, kosBySpecies: kos, survival: Object.fromEntries([...new Set([...living, ...fainted])].map(species => [species, !fainted.has(species)])) }, setup, pathologyCandidates: pathologies };
}

export type TrustMatrix = Readonly<Record<string, { readonly status: 'GREEN' | 'YELLOW' | 'RED', readonly evidence: string }>>;

export function trustWarning(domains: readonly string[], matrix: TrustMatrix): string | null {
	const red = domains.filter(domain => matrix[domain]?.status === 'RED');
	return red.length ? `EXPLORATORY ONLY — CURRENT AGENT NOT VALIDATED FOR THIS STRATEGIC DOMAIN: ${red.join(', ')}` : null;
}

export type AblationPreset = 'aa' | 'quick' | 'screen' | 'screen-20' | 'confirm';

export function resolvePreset(preset: AblationPreset): { readonly seedsPerCell: number, readonly purpose: string } {
	if (preset === 'aa') return { seedsPerCell: 3, purpose: 'reproducibility-gate' };
	if (preset === 'quick') return { seedsPerCell: 3, purpose: 'quick-directional-screen' };
	if (preset === 'screen') return { seedsPerCell: 10, purpose: 'directional-screen' };
	if (preset === 'screen-20') return { seedsPerCell: 20, purpose: 'directional-screen' };
	return { seedsPerCell: 40, purpose: 'promotion-confirmation' };
}

export interface ExploreAblationOptions {
	readonly manifestPath: string;
	readonly preset: AblationPreset;
	readonly foulRoot: string;
	readonly outputDirectory: string;
	readonly decisionBudgetMs: number;
	readonly timeoutMs: number;
	readonly beliefSamples: number;
	readonly beliefEngine: 'legacy' | 'posterior-shadow' | 'posterior';
	readonly dryRun: boolean;
	readonly maxPairs: number | null;
}

function cliPositive(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer.`);
	return parsed;
}

export function parseExploreAblationArguments(argv: readonly string[]): ExploreAblationOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('Arguments must use --name value pairs.');
		values.set(key.slice(2), value);
	}
	const required = (name: string) => {
		const value = values.get(name);
		if (!value) throw new Error(`Missing required --${name}.`);
		return value;
	};
	const preset = (values.get('preset') || 'screen') as AblationPreset;
	if (!['aa', 'quick', 'screen', 'screen-20', 'confirm'].includes(preset)) throw new Error('--preset must be aa, quick, screen, screen-20, or confirm.');
	const beliefEngine = values.get('belief-engine') || 'posterior';
	if (!['legacy', 'posterior-shadow', 'posterior'].includes(beliefEngine)) throw new Error('--belief-engine must be legacy, posterior-shadow, or posterior.');
	return {
		manifestPath: required('manifest'), preset, foulRoot: required('foul-root'), outputDirectory: required('output'),
		decisionBudgetMs: cliPositive(values.get('decision-budget-ms') || '100', 'decision-budget-ms'),
		timeoutMs: cliPositive(values.get('timeout-ms') || '180000', 'timeout-ms'),
		beliefSamples: cliPositive(values.get('belief-samples') || '1', 'belief-samples'),
		beliefEngine: beliefEngine as ExploreAblationOptions['beliefEngine'], dryRun: values.get('dry-run') === 'true',
		maxPairs: values.has('max-pairs') ? cliPositive(required('max-pairs'), 'max-pairs') : null,
	};
}

export interface AAResultPair {
	readonly pairId: string;
	readonly baseline: { readonly resultDigest: string, readonly decisionDigest: string };
	readonly candidate: { readonly resultDigest: string, readonly decisionDigest: string };
}

export function assertAAReproducible(pairs: readonly AAResultPair[]): void {
	const mismatch = pairs.find(pair => pair.baseline.resultDigest !== pair.candidate.resultDigest || pair.baseline.decisionDigest !== pair.candidate.decisionDigest);
	if (mismatch) throw new Error(`A/A reproducibility blocker in ${mismatch.pairId}: result or decision trace diverged.`);
}
