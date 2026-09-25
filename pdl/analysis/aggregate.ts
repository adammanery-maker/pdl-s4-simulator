import { toID } from '../../sim/dex-data';
import { Teams, type PokemonSet } from '../../sim/teams';
import { parseBattleProtocol } from './protocol-events';
import { wilsonInterval } from './intervals';
import { CANONICAL_RUNTIME_ID } from '../batch/runtime';

export interface AnalysisTrialSide {
	readonly teamId: string;
	readonly botName: string;
	readonly packed: string;
}

export interface AnalysisTrial {
	readonly runtimeId: string;
	readonly pairId: string;
	readonly side: 'forward' | 'reverse';
	readonly status: 'completed' | 'tied' | 'rejected' | 'failed' | 'timed_out';
	readonly winnerTeamId: string | null;
	readonly p1: AnalysisTrialSide;
	readonly p2: AnalysisTrialSide;
	readonly protocol: string;
	readonly scenario?: { readonly leftTeamId: string; readonly rightTeamId: string; readonly leftVariantId: string; readonly rightVariantId: string; readonly cellId: string };
}

export interface RecordSummary {
	readonly id: string;
	readonly appearances: number;
	readonly wins: number;
	readonly losses: number;
	readonly winRate: number;
	readonly interval: [number, number];
}

export interface MoveSummary extends RecordSummary {
	readonly uses: number;
	readonly kos: number;
	readonly damagePercent: number;
}

export interface SimulationSummary {
	readonly completedPairCount: number;
	readonly excludedTrialCount: number;
	readonly teamRecords: readonly RecordSummary[];
	readonly pokemonRecords: readonly RecordSummary[];
	readonly setRecords: readonly RecordSummary[];
	readonly moveRecords: readonly MoveSummary[];
	readonly teammatePairs: readonly RecordSummary[];
	readonly leadRecords: readonly RecordSummary[];
	readonly teraRecords: readonly RecordSummary[];
	readonly variantRecords: readonly RecordSummary[];
	readonly cellRecords: readonly RecordSummary[];
}

interface MutableRecord {
	appearances: number;
	wins: number;
	losses: number;
}

interface MutableMoveRecord extends MutableRecord {
	uses: number;
	kos: number;
	damagePercent: number;
}

function addRecord(records: Map<string, MutableRecord>, id: string, won: boolean): void {
	const record = records.get(id) || { appearances: 0, wins: 0, losses: 0 };
	record.appearances++;
	if (won) record.wins++;
	else record.losses++;
	records.set(id, record);
}

function summarize(records: Map<string, MutableRecord>): RecordSummary[] {
	return [...records.entries()].map(([id, record]) => ({
		id, appearances: record.appearances, wins: record.wins, losses: record.losses,
		winRate: record.wins / record.appearances, interval: wilsonInterval(record.wins, record.appearances),
	})).sort((left, right) => right.winRate - left.winRate || right.appearances - left.appearances || left.id.localeCompare(right.id));
}

function summarizeMoves(records: Map<string, MutableMoveRecord>): MoveSummary[] {
	return [...records.entries()].map(([id, record]) => ({
		id, appearances: record.appearances, wins: record.wins, losses: record.losses,
		winRate: record.wins / record.appearances, interval: wilsonInterval(record.wins, record.appearances),
		uses: record.uses, kos: record.kos, damagePercent: record.damagePercent,
	})).sort((left, right) => right.winRate - left.winRate || right.uses - left.uses || left.id.localeCompare(right.id));
}

function exactSetId(set: PokemonSet): string {
	const evs = set.evs || {};
	return [
		toID(set.species), toID(set.ability), toID(set.item), toID(set.nature), toID(set.teraType || ''),
		...['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(stat => String(evs[stat as keyof typeof evs] || 0)),
		...set.moves.map(toID),
	].join('|');
}

function eligibleTrials(trials: readonly AnalysisTrial[]): AnalysisTrial[] {
	const pairs = new Map<string, AnalysisTrial[]>();
	for (const trial of trials) {
		const pair = pairs.get(trial.pairId) || [];
		pair.push(trial);
		pairs.set(trial.pairId, pair);
	}
	const eligible: AnalysisTrial[] = [];
	for (const pair of pairs.values()) {
		const forward = pair.find(trial => trial.side === 'forward');
		const reverse = pair.find(trial => trial.side === 'reverse');
		if (forward?.status === 'completed' && reverse?.status === 'completed' && forward.winnerTeamId && reverse.winnerTeamId) {
			eligible.push(forward, reverse);
		}
	}
	return eligible;
}

/** Counts side-balanced pairs whose two battles both reached a real terminal result. */
export function countTerminalPairs(trials: readonly AnalysisTrial[]): number {
	const pairs = new Map<string, Set<AnalysisTrial['side']>>();
	for (const trial of trials) {
		if (trial.status !== 'completed' && trial.status !== 'tied') continue;
		const sides = pairs.get(trial.pairId) || new Set<AnalysisTrial['side']>();
		sides.add(trial.side);
		pairs.set(trial.pairId, sides);
	}
	return [...pairs.values()].filter(sides => sides.has('forward') && sides.has('reverse')).length;
}

/** Aggregates only complete forward/reverse pairs to prevent player-side bias. */
export function aggregateCompletedPairedTrials(trials: readonly AnalysisTrial[]): SimulationSummary {
	for (const trial of trials) {
		if (trial.runtimeId !== CANONICAL_RUNTIME_ID) {
			throw new Error(`Cannot aggregate ${trial.pairId}/${trial.side}: expected canonical runtime ${CANONICAL_RUNTIME_ID}.`);
		}
	}
	const eligible = eligibleTrials(trials);
	const teamRecords = new Map<string, MutableRecord>();
	const pokemonRecords = new Map<string, MutableRecord>();
	const setRecords = new Map<string, MutableRecord>();
	const moveRecords = new Map<string, MutableMoveRecord>();
	const teammatePairs = new Map<string, MutableRecord>();
	const leadRecords = new Map<string, MutableRecord>();
	const teraRecords = new Map<string, MutableRecord>();
	const variantRecords = new Map<string, MutableRecord>();
	const cellRecords = new Map<string, MutableRecord>();

	for (const trial of eligible) {
		const parsed = parseBattleProtocol(trial.protocol, { p1: trial.p1, p2: trial.p2 });
		if (parsed.winnerTeamId && parsed.winnerTeamId !== trial.winnerTeamId) {
			throw new Error(`Protocol winner does not match result for ${trial.pairId}/${trial.side}.`);
		}
		for (const side of [trial.p1, trial.p2]) {
			const won = side.teamId === trial.winnerTeamId;
			addRecord(teamRecords, side.teamId, won);
			if (trial.scenario) {
				const variantId = toID(side.teamId) === toID(trial.scenario.leftTeamId)
					? trial.scenario.leftVariantId : trial.scenario.rightVariantId;
				addRecord(variantRecords, variantId, won);
			}
			const team = Teams.unpack(side.packed);
			if (!team) throw new Error(`Trial ${trial.pairId}/${trial.side} has an invalid packed team for ${side.teamId}.`);
			for (const set of team) {
				addRecord(pokemonRecords, toID(set.species), won);
				addRecord(setRecords, exactSetId(set), won);
			}
			for (let left = 0; left < team.length; left++) {
				for (let right = left + 1; right < team.length; right++) {
					const pair = [toID(team[left].species), toID(team[right].species)].sort().join('+');
					addRecord(teammatePairs, pair, won);
				}
			}
		}
		for (const move of parsed.moves) {
			const record = moveRecords.get(move.move) || { appearances: 0, wins: 0, losses: 0, uses: 0, kos: 0, damagePercent: 0 };
			record.appearances++;
			record.uses++;
			record.damagePercent += move.damagePercent;
			if (move.ko) record.kos++;
			if (move.teamId === trial.winnerTeamId) record.wins++;
			else record.losses++;
			moveRecords.set(move.move, record);
		}
		for (const [teamId, species] of Object.entries(parsed.leads)) {
			if (species) addRecord(leadRecords, species, teamId === trial.winnerTeamId);
		}
		for (const event of parsed.tera) addRecord(teraRecords, `${event.species}:${event.type}`, event.teamId === trial.winnerTeamId);
		if (trial.scenario) addRecord(cellRecords, trial.scenario.cellId, toID(trial.winnerTeamId || '') === toID(trial.scenario.leftTeamId));
	}

	return {
		completedPairCount: eligible.length / 2,
		excludedTrialCount: trials.length - eligible.length,
		teamRecords: summarize(teamRecords), pokemonRecords: summarize(pokemonRecords), setRecords: summarize(setRecords),
		moveRecords: summarizeMoves(moveRecords), teammatePairs: summarize(teammatePairs), leadRecords: summarize(leadRecords), teraRecords: summarize(teraRecords),
		variantRecords: summarize(variantRecords), cellRecords: summarize(cellRecords),
	};
}
