import { toID } from '../../sim/dex-data';

export interface BattleSideMapping {
	readonly teamId: string;
	readonly botName: string;
}

export interface BattleProtocolMapping {
	readonly p1: BattleSideMapping;
	readonly p2: BattleSideMapping;
}

export interface MoveEvent {
	readonly teamId: string;
	readonly species: string;
	readonly move: string;
	readonly targetTeamId: string | null;
	readonly targetSpecies: string | null;
	damagePercent: number;
	readonly ko: boolean;
}

export interface TeraEvent {
	readonly teamId: string;
	readonly species: string;
	readonly type: string;
}

export interface BattleEventRecord {
	readonly leads: Readonly<Record<string, string | null>>;
	readonly moves: readonly MoveEvent[];
	readonly tera: readonly TeraEvent[];
	readonly winnerTeamId: string | null;
	readonly tie: boolean;
	readonly unmatchedLines: readonly string[];
}

type Side = 'p1' | 'p2';

function sideFromIdentifier(value: string): Side | null {
	const match = /^(p[12])(?:[a-z])?:/.exec(value.trim());
	return match ? match[1] as Side : null;
}

function speciesFromIdentifier(value: string): string | null {
	const colon = value.indexOf(':');
	if (colon < 0) return null;
	const species = toID(value.slice(colon + 1).trim());
	return species || null;
}

function speciesFromDetails(value: string): string | null {
	const species = toID(value.split(',')[0]);
	return species || null;
}

function currentHp(value: string): { current: number; maximum: number } | null {
	const match = /^(\d+)(?:\/(\d+))?/.exec(value.trim());
	if (!match) return null;
	const current = Number(match[1]);
	const maximum = Number(match[2] || 100);
	return maximum > 0 ? { current, maximum } : null;
}

function teamFor(mapping: BattleProtocolMapping, side: Side): string {
	return mapping[side].teamId;
}

function botWinner(mapping: BattleProtocolMapping, name: string): string | null {
	if (name === mapping.p1.botName) return mapping.p1.teamId;
	if (name === mapping.p2.botName) return mapping.p2.teamId;
	return null;
}

/**
 * Parses public Showdown protocol messages captured from a Foul Play client.
 * The manifest mapping, not a display-name guess, resolves each player side.
 */
export function parseBattleProtocol(protocol: string, mapping: BattleProtocolMapping): BattleEventRecord {
	const leads: Record<string, string | null> = { [mapping.p1.teamId]: null, [mapping.p2.teamId]: null };
	const moves: MoveEvent[] = [];
	const tera: TeraEvent[] = [];
	const unmatchedLines: string[] = [];
	const activeSpecies: Partial<Record<Side, string>> = {};
	const hpBySide: Partial<Record<Side, { current: number; maximum: number }>> = {};
	const lastMoveByTarget: Partial<Record<Side, number>> = {};
	let winnerTeamId: string | null = null;
	let tie = false;

	for (const line of protocol.split(/\r?\n/)) {
		if (!line || line.startsWith('>battle-')) continue;
		if (!line.startsWith('|')) {
			unmatchedLines.push(line);
			continue;
		}
		const fields = line.split('|');
		const type = fields[1];
		if (type === 'switch' || type === 'drag') {
			const side = sideFromIdentifier(fields[2] || '');
			const species = speciesFromDetails(fields[3] || '') || speciesFromIdentifier(fields[2] || '');
			if (!side || !species) {
				unmatchedLines.push(line);
				continue;
			}
			activeSpecies[side] = species;
			if (!leads[teamFor(mapping, side)]) leads[teamFor(mapping, side)] = species;
			const hp = currentHp(fields[4] || '');
			if (hp) hpBySide[side] = hp;
			continue;
		}
		if (type === 'move') {
			const side = sideFromIdentifier(fields[2] || '');
			const targetSide = sideFromIdentifier(fields[4] || '');
			const species = speciesFromIdentifier(fields[2] || '') || activeSpecies[side || 'p1'] || null;
			if (!side || !species) {
				unmatchedLines.push(line);
				continue;
			}
			moves.push({
				teamId: teamFor(mapping, side), species, move: toID(fields[3] || ''),
				targetTeamId: targetSide ? teamFor(mapping, targetSide) : null,
				targetSpecies: targetSide ? (speciesFromIdentifier(fields[4] || '') || activeSpecies[targetSide] || null) : null,
				damagePercent: 0, ko: false,
			});
			if (targetSide) lastMoveByTarget[targetSide] = moves.length - 1;
			continue;
		}
		if (type === '-damage') {
			const side = sideFromIdentifier(fields[2] || '');
			const hp = currentHp(fields[3] || '');
			if (!side || !hp) {
				unmatchedLines.push(line);
				continue;
			}
			const moveIndex = lastMoveByTarget[side];
			const previous = hpBySide[side];
			if (moveIndex !== undefined && previous && previous.maximum === hp.maximum) {
				const damagePercent = Math.max(0, (previous.current - hp.current) * 100 / hp.maximum);
				moves[moveIndex] = { ...moves[moveIndex], damagePercent: moves[moveIndex].damagePercent + damagePercent };
			}
			hpBySide[side] = hp;
			continue;
		}
		if (type === 'faint') {
			const side = sideFromIdentifier(fields[2] || '');
			if (!side) {
				unmatchedLines.push(line);
				continue;
			}
			const moveIndex = lastMoveByTarget[side];
			if (moveIndex !== undefined) moves[moveIndex] = { ...moves[moveIndex], ko: true };
			continue;
		}
		if (type === '-terastallize') {
			const side = sideFromIdentifier(fields[2] || '');
			const species = (side && activeSpecies[side]) || speciesFromIdentifier(fields[2] || '') || null;
			if (!side || !species) {
				unmatchedLines.push(line);
				continue;
			}
			tera.push({ teamId: teamFor(mapping, side), species, type: toID(fields[3] || '') });
			continue;
		}
		if (type === 'win') {
			winnerTeamId = botWinner(mapping, fields[2] || '');
			if (!winnerTeamId) unmatchedLines.push(line);
			continue;
		}
		if (type === 'tie') {
			tie = true;
			continue;
		}
	}
	return { leads, moves, tera, winnerTeamId, tie, unmatchedLines };
}
