import { existsSync, readFileSync, writeFileSync } from 'fs';
import { foulBotName } from './run-trial';
import type { TrialArtifact, TrialResult } from './types';
import { parseBattleProtocol } from '../analysis/protocol-events';
import { toID } from '../../sim/dex-data';
import { Teams } from '../../sim/teams';

export interface TeraAuditViolation {
	readonly teamId: string;
	readonly species: string;
	readonly type: string;
	readonly reason: 'non-captain' | 'mismatched-type' | 'second-tera';
}

export type AuditStatus = 'clean' | 'violating' | 'inconclusive';

export interface TrialEvidence {
	readonly auditStatus: AuditStatus;
	readonly integrityViolations: readonly string[];
	readonly tera: {
		readonly events: readonly unknown[];
		readonly violations: readonly TeraAuditViolation[];
	};
	readonly belief: {
		readonly p1: readonly unknown[];
		readonly p2: readonly unknown[];
		readonly truthComparison: BeliefTruthComparison | null;
	};
}

export interface BeliefTruthComparison {
	readonly traceCount: number;
	readonly comparableTraceCount: number;
	readonly incorrectEliminations: number;
	readonly meanTruthProbability: number;
	readonly meanMaximumProbability: number;
	readonly meanBrierScore: number;
	readonly overconfidentWrongTraces: number;
	readonly initialMeanTruthProbability: number;
	readonly terminalMeanTruthProbability: number;
	readonly meanConvergence: number;
}

function read(path: string): string {
	return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Remove client-only request payloads while retaining the ordered public room protocol. */
export function publicProtocolFromPrivateCapture(protocol: string): string {
	return protocol.split(/\r?\n/)
		.filter(line => !line.startsWith('|request|') && !line.startsWith('|queryresponse|') && !line.startsWith('|sentchoice|'))
		.join('\n').replace(/\n+$/, '') + '\n';
}

export function parseDecisionEvidence(log: string): readonly unknown[] {
	const evidence: unknown[] = [];
	for (const line of log.split(/\r?\n/)) {
		const marker = 'PDL_DECISION_EVIDENCE ';
		const index = line.indexOf(marker);
		if (index < 0) continue;
		try { evidence.push(JSON.parse(line.slice(index + marker.length))); } catch { /* preserved in raw log */ }
	}
	return evidence;
}

/** Parses posterior-shadow traces emitted from the exact public protocol state. */
export function parseBeliefTrace(log: string): readonly unknown[] {
	const traces: unknown[] = [];
	for (const line of log.split(/\r?\n/)) {
		const marker = 'PDL_BELIEF_TRACE ';
		const index = line.indexOf(marker);
		if (index < 0) continue;
		try { traces.push(JSON.parse(line.slice(index + marker.length))); } catch { /* retained in raw log */ }
	}
	return traces;
}

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function truthCandidateKeys(exported: string): Map<string, string> {
	const keys = new Map<string, string>();
	for (const set of Teams.import(exported) || []) {
		const evs = [set.evs.hp, set.evs.atk, set.evs.def, set.evs.spa, set.evs.spd, set.evs.spe];
		const tera = toID(set.teraType || 'typeless');
		keys.set(toID(set.species), [tera === 'typeless' ? '' : tera, toID(set.ability || 'none'), toID(set.item || 'none'), toID(set.nature || 'serious'), evs.join(','), ...set.moves.map(toID)].join('|'));
	}
	return keys;
}

function compareBeliefTraces(
	p1Traces: readonly unknown[], p2Traces: readonly unknown[], privateAuditPath: string,
): BeliefTruthComparison | null {
	if (!existsSync(privateAuditPath)) return null;
	const privateAudit = object(JSON.parse(read(privateAuditPath)));
	const p1 = object(privateAudit?.p1);
	const p2 = object(privateAudit?.p2);
	if (typeof p1?.exported !== 'string' || typeof p2?.exported !== 'string') return null;
	const series = new Map<string, number[]>();
	const measurements: number[] = [];
	const maxima: number[] = [];
	const brierScores: number[] = [];
	let incorrectEliminations = 0;
	let overconfidentWrongTraces = 0;
	const compare = (side: 'p1' | 'p2', traces: readonly unknown[], truth: Map<string, string>) => {
		for (const rawTrace of traces) {
			const trace = object(rawTrace);
			if (!trace || typeof trace.species !== 'string') continue;
			const expected = truth.get(toID(trace.species));
			const weights = object(trace.weights);
			if (!expected || !weights) continue;
			const probabilities = Object.values(weights).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
			if (!probabilities.length) continue;
			const truthProbability = typeof weights[expected] === 'number' ? weights[expected] as number : 0;
			measurements.push(truthProbability);
			const maximum = Math.max(...probabilities);
			maxima.push(maximum);
			brierScores.push(1 - (2 * truthProbability) + probabilities.reduce((sum, value) => sum + (value * value), 0));
			if (truthProbability === 0) incorrectEliminations++;
			if (maximum >= 0.9 && truthProbability < 0.1) overconfidentWrongTraces++;
			const key = `${side}:${toID(trace.species)}`;
			series.set(key, [...(series.get(key) || []), truthProbability]);
		}
	};
	compare('p1', p1Traces, truthCandidateKeys(p2.exported));
	compare('p2', p2Traces, truthCandidateKeys(p1.exported));
	const average = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
	const initial = [...series.values()].map(values => values[0]);
	const terminal = [...series.values()].map(values => values[values.length - 1] || 0);
	return {
		traceCount: p1Traces.length + p2Traces.length,
		comparableTraceCount: measurements.length,
		incorrectEliminations,
		meanTruthProbability: average(measurements),
		meanMaximumProbability: average(maxima),
		meanBrierScore: average(brierScores),
		overconfidentWrongTraces,
		initialMeanTruthProbability: average(initial),
		terminalMeanTruthProbability: average(terminal),
		meanConvergence: average(terminal) - average(initial),
	};
}

function captureCompleteness(protocol: string) {
	return {
		nonEmpty: protocol.trim().length > 0,
		hasPreview: /^\|teampreview(?:\||$)/m.test(protocol),
		hasStart: protocol.includes('|start'),
		hasFirstDecision: protocol.includes('|turn|1') || /\|(win|tie)\|/.test(protocol),
		hasTerminal: /\|(win|tie)\|/.test(protocol),
	};
}

function completeCapture(value: ReturnType<typeof captureCompleteness>): boolean {
	return Object.values(value).every(Boolean);
}

function resultMatchesProtocol(
	result: TrialResult,
	parsed: ReturnType<typeof parseBattleProtocol>
): boolean {
	if (result.status === 'completed') {
		return !parsed.tie && Boolean(result.winnerTeamId) && parsed.winnerTeamId === result.winnerTeamId;
	}
	if (result.status === 'tied') return parsed.tie && parsed.winnerTeamId === null;
	return false;
}

export function buildTrialEvidence(artifact: TrialArtifact, result: TrialResult): TrialEvidence {
	const p1Protocol = read(artifact.p1ProtocolPath);
	const p2Protocol = read(artifact.p2ProtocolPath);
	const publicProtocol = publicProtocolFromPrivateCapture(p1Protocol);
	const p2PublicProtocol = publicProtocolFromPrivateCapture(p2Protocol);
	writeFileSync(artifact.publicProtocolPath, publicProtocol, 'utf8');
	writeFileSync(artifact.p2PublicProtocolPath, p2PublicProtocol, 'utf8');
	const mapping = {
		p1: { teamId: artifact.manifest.p1.teamId, botName: foulBotName(artifact.trialId, 'p1') },
		p2: { teamId: artifact.manifest.p2.teamId, botName: foulBotName(artifact.trialId, 'p2') },
	};
	const parsed = parseBattleProtocol(publicProtocol, mapping);
	const p2Parsed = parseBattleProtocol(p2PublicProtocol, mapping);
	const sides = new Map([
		[artifact.manifest.p1.teamId, artifact.manifest.p1],
		[artifact.manifest.p2.teamId, artifact.manifest.p2],
	]);
	const toId = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	const teraCount = new Map<string, number>();
	const violations: TeraAuditViolation[] = [];
	for (const event of parsed.tera) {
		const side = sides.get(event.teamId);
		const rawCaptains: unknown = side?.teraCaptains;
		const captainObject = object(rawCaptains);
		const captainValues = Array.isArray(rawCaptains)
			? rawCaptains : captainObject ? Object.keys(captainObject) : [];
		const captains = captainValues.map(toId);
		const speciesId = toId(event.species);
		const expectedType = captainObject && typeof captainObject[speciesId] === 'string'
			? toId(captainObject[speciesId] as string) : null;
		const isCaptain = captains.includes(speciesId)
			|| (speciesId === 'avalugg' && captains.includes('avalugghisui'))
			|| (speciesId === 'slowbro' && captains.includes('slowbrogalar'));
		const count = (teraCount.get(event.teamId) || 0) + 1;
		teraCount.set(event.teamId, count);
		if (!isCaptain) violations.push({ ...event, reason: 'non-captain' });
		if (expectedType && expectedType !== toId(event.type)) violations.push({ ...event, reason: 'mismatched-type' });
		if (count > 1) violations.push({ ...event, reason: 'second-tera' });
	}
	const eventKey = (event: { teamId: string; species: string; type: string }) => `${event.teamId}:${event.species}:${event.type}`;
	const streamsAgree = JSON.stringify(parsed.tera.map(eventKey)) === JSON.stringify(p2Parsed.tera.map(eventKey))
		&& parsed.winnerTeamId === p2Parsed.winnerTeamId && parsed.tie === p2Parsed.tie;
	const completeness = { p1: captureCompleteness(publicProtocol), p2: captureCompleteness(p2PublicProtocol) };
	const capturesComplete = completeCapture(completeness.p1) && completeCapture(completeness.p2);
	const resultCoherent = resultMatchesProtocol(result, parsed) && resultMatchesProtocol(result, p2Parsed);
	const integrityViolations = capturesComplete && streamsAgree && !resultCoherent
		? ['TrialResult does not match the independently captured public winner/tie result.']
		: [];
	const conclusive = capturesComplete && streamsAgree && resultCoherent && result.status !== 'rejected';
	let auditStatus: AuditStatus = violations.length || integrityViolations.length
		? 'violating' : conclusive ? 'clean' : 'inconclusive';
	
	if (result.status === 'rejected' && result.failureReason === 'PDL_BELIEF_CONTRADICTION') {
		auditStatus = 'inconclusive';
	}

	const beliefTraces = { p1: parseBeliefTrace(read(artifact.p1LogPath)), p2: parseBeliefTrace(read(artifact.p2LogPath)) };
	const evidence = {
		schemaVersion: 1,
		trialId: artifact.trialId,
		auditStatus,
		integrityViolations,
		result,
		sources: {
			publicProtocol: 'public.protocol (derived from p1 room capture; private messages removed)',
			p2PublicProtocol: 'p2-public.protocol (derived independently from p2 room capture)',
			p1PrivateProtocol: 'p1.protocol', p2PrivateProtocol: 'p2.protocol',
			p1SearchLog: 'p1.log', p2SearchLog: 'p2.log', showdownProcessLog: 'showdown.log',
		},
		protocol: { completeness, streamsAgree, resultCoherent, eventCounts: { p1Moves: parsed.moves.length, p2Moves: p2Parsed.moves.length, tera: parsed.tera.length } },
		decisions: { p1: parseDecisionEvidence(read(artifact.p1LogPath)), p2: parseDecisionEvidence(read(artifact.p2LogPath)) },
		belief: { ...beliefTraces, truthComparison: compareBeliefTraces(beliefTraces.p1, beliefTraces.p2, artifact.privateGroundTruthAuditPath) },
		tera: { events: parsed.tera, violations },
		privateCaptureSizes: { p1Bytes: Buffer.byteLength(p1Protocol), p2Bytes: Buffer.byteLength(p2Protocol) },
	};
	writeFileSync(artifact.auditPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
	return evidence;
}
