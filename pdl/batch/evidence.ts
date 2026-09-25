import { existsSync, readFileSync, writeFileSync } from 'fs';
import { foulBotName } from './run-trial';
import type { TrialArtifact, TrialResult } from './types';
import { parseBattleProtocol } from '../analysis/protocol-events';

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
		const captains = (side?.teraCaptains || []).map(toId);
		const speciesId = toId(event.species);
		const isCaptain = captains.includes(speciesId)
			|| (speciesId === 'avalugg' && captains.includes('avalugghisui'))
			|| (speciesId === 'slowbro' && captains.includes('slowbrogalar'));
		const count = (teraCount.get(event.teamId) || 0) + 1;
		teraCount.set(event.teamId, count);
		if (!isCaptain) violations.push({ ...event, reason: 'non-captain' });
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
		tera: { events: parsed.tera, violations },
		privateCaptureSizes: { p1Bytes: Buffer.byteLength(p1Protocol), p2Bytes: Buffer.byteLength(p2Protocol) },
	};
	writeFileSync(artifact.auditPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
	return evidence;
}
