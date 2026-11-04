import { Dex, toID } from '../../sim';
import type { PokemonSet } from '../../sim/teams';
import type { TrialResult } from '../batch/types';

export interface SunTurnsRemaining {
	readonly min: number;
	readonly max: number;
	readonly exact: number | null;
	readonly source: 'known-own-item' | 'unknown-public-item';
	readonly searchReported: number | null;
	readonly searchReportedTurn: number | null;
	readonly searchMismatch: boolean | null;
}

export interface ScovillainSunEntry {
	readonly turn: number;
	readonly hp: { readonly current: number | null, readonly max: number | null, readonly fraction: number | null, readonly raw: string };
	readonly opponentActive: string | null;
	readonly sunActive: boolean;
	readonly sunTurnsRemaining: SunTurnsRemaining | null;
	readonly precededByWhimsicottMemento: boolean;
	readonly mementoTurn: number | null;
}

export interface SunStrategyTelemetry {
	readonly schemaVersion: 1;
	readonly sunOccurred: boolean;
	readonly firstSunTurn: number | null;
	readonly firstSunSetter: string | null;
	readonly sunActivations: readonly { readonly turn: number, readonly setter: string | null, readonly side: 'adam' | 'opponent' | null }[];
	readonly scovillainEntries: readonly ScovillainSunEntry[];
	readonly growth: {
		readonly opportunities: number,
		readonly selections: number,
		readonly executions: number,
		readonly opportunitySource: 'decision-evidence' | 'decision-bundle-observation' | 'unavailable',
		readonly caveat: string | null,
		readonly events: readonly { readonly kind: 'opportunity' | 'selection' | 'execution', readonly turn: number | null, readonly decisionOrdinal: number | null }[],
	};
	readonly attacksUnderSun: readonly {
		readonly turn: number, readonly move: string, readonly target: string | null, readonly successfulDamage: boolean,
	}[];
	readonly tera: readonly { readonly turn: number, readonly species: string, readonly type: string, readonly scovillain: boolean }[];
	readonly kosUnderSun: readonly { readonly turn: number, readonly target: string, readonly move: string }[];
	readonly outcome: 'win' | 'loss' | 'tie' | 'incomplete';
	readonly limitations: readonly string[];
}

export interface AnalyzeSunStrategyInput {
	readonly protocol: string;
	readonly decisionBundles: string;
	readonly decisionEvidenceLog?: string;
	readonly adamSide: 'p1' | 'p2';
	readonly ownTeam: readonly PokemonSet[];
	readonly result: TrialResult;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function protocolPokemon(value: string | undefined): { side: 'p1' | 'p2' | null, species: string | null } {
	const match = value?.match(/^(p[12])[a-z]?:\s*(.+)$/i);
	return { side: match ? match[1].toLowerCase() as 'p1' | 'p2' : null, species: match ? toID(match[2]) : null };
}

function parseJsonLines(text: string): JsonObject[] {
	const values: JsonObject[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const value = object(JSON.parse(line));
			if (value) values.push(value);
		} catch { /* The raw artifact remains authoritative for malformed lines. */ }
	}
	return values;
}

function parseEvidence(text: string): JsonObject[] {
	const marker = 'PDL_DECISION_EVIDENCE ';
	const values: JsonObject[] = [];
	for (const line of text.split(/\r?\n/)) {
		const index = line.indexOf(marker);
		if (index < 0) continue;
		try {
			const value = object(JSON.parse(line.slice(index + marker.length)));
			if (value) values.push(value);
		} catch { /* The raw log remains available for diagnosis. */ }
	}
	return values;
}

function number(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function string(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function observation(bundle: JsonObject): JsonObject | null {
	if (typeof bundle.observation !== 'string') return null;
	try { return object(JSON.parse(bundle.observation)); } catch { return null; }
}

function activePokemon(observationValue: JsonObject | null): JsonObject | null {
	const user = object(observationValue?.user);
	const wrapped = object(user?.active);
	return object(wrapped?.$pokemon) || wrapped;
}

function growthAvailableInObservation(bundle: JsonObject): boolean {
	const active = activePokemon(observation(bundle));
	if (toID(string(active?.name) || string(active?.base_name) || string(bundle.activeSpecies)) !== 'scovillain') return false;
	const moves = Array.isArray(active?.moves) ? active.moves : [];
	return moves.some(raw => {
		const wrapped = object(raw);
		const move = object(wrapped?.$move) || wrapped;
		return toID(string(move?.name)) === 'growth' && move?.disabled !== true && (number(move?.current_pp) ?? 1) > 0;
	});
}

function condition(raw: string): ScovillainSunEntry['hp'] {
	const token = raw.trim().split(' ')[0];
	const match = /^(\d+)\/(\d+)$/.exec(token);
	if (!match) return { current: token === '0' ? 0 : null, max: null, fraction: token === '0' ? 0 : null, raw };
	const current = Number(match[1]);
	const max = Number(match[2]);
	return { current, max, fraction: max ? current / max : null, raw };
}

function resultOutcome(result: TrialResult): SunStrategyTelemetry['outcome'] {
	if (result.status === 'tied') return 'tie';
	if (result.status !== 'completed') return 'incomplete';
	return result.winnerTeamId === 'adam' ? 'win' : 'loss';
}

/** Analyze only public battle events, Adam's own team, and Adam's own search logs. */
export function analyzeSunStrategy(input: AnalyzeSunStrategyInput): SunStrategyTelemetry {
	const bundles = parseJsonLines(input.decisionBundles);
	const evidence = parseEvidence(input.decisionEvidenceLog || '');
	const ownItems = new Map<string, string>(input.ownTeam.map(set => [toID(set.species), toID(set.item || '')]));
	const opponentSide = input.adamSide === 'p1' ? 'p2' : 'p1';
	const entries: (ScovillainSunEntry & { opponentPending: boolean, exitTurn: number | null })[] = [];
	const sunAtTurn = new Map<number, { min: number, max: number } | null>();
	const activations: { turn: number, setter: string | null, side: 'adam' | 'opponent' | null }[] = [];
	const attacks: { turn: number, move: string, target: string | null, successfulDamage: boolean }[] = [];
	const tera: { turn: number, species: string, type: string, scovillain: boolean }[] = [];
	const kos: { turn: number, target: string, move: string }[] = [];
	const growthEvents: { kind: 'opportunity' | 'selection' | 'execution', turn: number | null, decisionOrdinal: number | null }[] = [];
	const active = new Map<'p1' | 'p2', string>();
	let turn = 0;
	let sun: { min: number, max: number, source: SunTurnsRemaining['source'] } | null = null;
	let lastSunnyDayActor: { side: 'p1' | 'p2' | null, species: string | null } | null = null;
	let pendingMemento: { turn: number, moved: boolean, fainted: boolean, sunActive: boolean } | null = null;
	let pendingKo: {
		move: string, targetSide: 'p1' | 'p2', targetSpecies: string | null, turn: number,
		fatalDamage: boolean, attack: { successfulDamage: boolean },
	} | null = null;

	for (const rawLine of input.protocol.split(/\r?\n/)) {
		if (!rawLine.startsWith('|')) continue;
		const fields = rawLine.split('|');
		const event = fields[1];
		if (event !== 'switch' && event !== 'drag' && event !== 'replace') {
			for (const entry of entries) entry.opponentPending = false;
		}
		if (event === 'turn') {
			turn = Number(fields[2]) || turn;
			sunAtTurn.set(turn, sun ? { min: sun.min, max: sun.max } : null);
			pendingKo = null;
			if (pendingMemento && pendingMemento.turn < turn) pendingMemento = null;
			continue;
		}
		const eventTurn = turn || 1;
		if (event === 'switch' || event === 'drag' || event === 'replace') {
			const pokemon = protocolPokemon(fields[2]);
			const detailsSpecies = toID((fields[3] || '').split(',')[0]);
			const species = detailsSpecies || pokemon.species;
			if (pokemon.side === input.adamSide && active.get(input.adamSide) === 'scovillain') {
				const previous = entries[entries.length - 1];
				if (previous) previous.exitTurn = eventTurn;
			}
			if (pokemon.side && species) active.set(pokemon.side, species);
			if (pokemon.side === opponentSide) {
				for (let index = entries.length - 1; index >= 0 && entries[index].opponentPending; index--) {
					(entries[index] as { opponentActive: string | null }).opponentActive = species;
					entries[index].opponentPending = false;
				}
			}
			if (pokemon.side === input.adamSide && species === 'scovillain') {
				const remaining = sun ? {
					min: sun.min, max: sun.max, exact: sun.min === sun.max ? sun.min : null, source: sun.source,
					searchReported: null, searchReportedTurn: null, searchMismatch: null,
				} : null;
				entries.push({
					turn: eventTurn, hp: condition(fields[4] || ''), opponentActive: active.get(opponentSide) || null,
					opponentPending: true, exitTurn: null, sunActive: Boolean(sun), sunTurnsRemaining: remaining,
					precededByWhimsicottMemento: Boolean(sun && pendingMemento?.sunActive && pendingMemento.moved && pendingMemento.fainted),
					mementoTurn: sun && pendingMemento?.sunActive && pendingMemento.moved && pendingMemento.fainted ? pendingMemento.turn : null,
				});
				pendingMemento = null;
			} else if (pokemon.side === input.adamSide && pendingMemento?.fainted) {
				pendingMemento = null;
			}
			pendingKo = null;
			continue;
		}
		if (event === 'move') {
			const actor = protocolPokemon(fields[2]);
			const move = fields[3] || '';
			const moveId = toID(move);
			const target = protocolPokemon(fields[4]);
			pendingKo = null;
			lastSunnyDayActor = moveId === 'sunnyday' ? actor : null;
			if (pendingMemento && !pendingMemento.fainted && !(actor.side === input.adamSide && actor.species === 'whimsicott' && moveId === 'memento')) {
				pendingMemento = null;
			}
			if (actor.side === input.adamSide && actor.species === 'whimsicott' && moveId === 'memento') {
				pendingMemento = { turn: eventTurn, moved: true, fainted: false, sunActive: Boolean(sun) };
			}
			if (actor.side === input.adamSide && actor.species === 'scovillain') {
				if (moveId === 'growth') growthEvents.push({ kind: 'execution', turn: eventTurn, decisionOrdinal: null });
				const data = Dex.moves.get(moveId);
				if (sun && data.exists && data.category !== 'Status' && moveId !== 'futuresight' && moveId !== 'doomdesire' && !fields.includes('[still]')) {
					const attack = { turn: eventTurn, move: moveId, target: target.species, successfulDamage: false };
					attacks.push(attack);
					if (target.side === opponentSide) pendingKo = {
						move: moveId, targetSide: opponentSide, targetSpecies: target.species, turn: eventTurn,
						fatalDamage: false, attack,
					};
				}
			}
			continue;
		}
		if (event === '-damage' && pendingKo) {
			const damaged = protocolPokemon(fields[2]);
			const sourced = fields.slice(4).some(field => field.startsWith('[from]'));
			const targetMatches = damaged.side === pendingKo.targetSide &&
				(!pendingKo.targetSpecies || damaged.species === pendingKo.targetSpecies);
			if (targetMatches && sourced) {
				pendingKo = null;
			} else if (targetMatches) {
				pendingKo.attack.successfulDamage = true;
				pendingKo.fatalDamage = condition(fields[3] || '').current === 0;
			}
			continue;
		}
		if (event === '-enditem' || event === '-item') {
			const pokemon = protocolPokemon(fields[2]);
			if (pokemon.side === input.adamSide) {
				const species = active.get(input.adamSide) || pokemon.species;
				if (species) ownItems.set(species, event === '-item' ? toID(fields[3] || '') : '');
			}
			continue;
		}
		if (event === '-fail' || event === '-immune' || event === '-miss' ||
			(event === '-activate' && fields.some(field => /move:\s*protect/i.test(field)))) {
			if (!pendingMemento?.fainted) pendingMemento = null;
			if (event === '-fail') lastSunnyDayActor = null;
			continue;
		}
		if (event === '-weather') {
			const weather = toID(fields[2] || '');
			const upkeep = fields.includes('[upkeep]');
			if (weather === 'sunnyday' && !upkeep) {
				let source = lastSunnyDayActor;
				const of = fields.find(field => field.startsWith('[of] '));
				if (of) source = protocolPokemon(of.slice('[of] '.length));
				const knownOwn = source?.side === input.adamSide;
				const duration = knownOwn ? (ownItems.get(source?.species || '') === 'heatrock' ? 8 : 5) : null;
				sun = duration ? { min: duration, max: duration, source: 'known-own-item' } : { min: 5, max: 8, source: 'unknown-public-item' };
				activations.push({ turn: eventTurn, setter: source?.species || null, side: source?.side === input.adamSide ? 'adam' : source?.side === opponentSide ? 'opponent' : null });
				lastSunnyDayActor = null;
			} else if (weather !== 'sunnyday') {
				sun = null;
			}
			continue;
		}
		if (event === 'upkeep') {
			if (sun) {
				sun = { ...sun, min: Math.max(0, sun.min - 1), max: Math.max(0, sun.max - 1) };
				if (sun.max === 0) sun = null;
			}
			pendingKo = null;
			continue;
		}
		if (event === 'faint') {
			const fainted = protocolPokemon(fields[2]);
			if (fainted.side === input.adamSide && fainted.species === 'whimsicott' && pendingMemento?.moved) pendingMemento.fainted = true;
			if (sun && pendingKo?.fatalDamage && fainted.side === pendingKo.targetSide && (!pendingKo.targetSpecies || fainted.species === pendingKo.targetSpecies)) {
				kos.push({ turn: pendingKo.turn, target: fainted.species || 'unknown', move: pendingKo.move });
			}
			pendingKo = null;
			continue;
		}
		if (event === '-terastallize') {
			const pokemon = protocolPokemon(fields[2]);
			if (pokemon.side === input.adamSide && pokemon.species) tera.push({ turn: eventTurn, species: pokemon.species, type: toID(fields[3] || ''), scovillain: pokemon.species === 'scovillain' });
		}
	}

	let opportunitySource: SunStrategyTelemetry['growth']['opportunitySource'] = 'unavailable';
	const scovillainEvidence = evidence.filter(value =>
		toID(string(value.activeSpecies)) === 'scovillain' && Array.isArray(value.legalSearchActions)
	);
	const evidenceOpportunities = scovillainEvidence.filter(value =>
		(value.legalSearchActions as unknown[]).some(action =>
			toID(string(action).replace(/-tera$/, '')) === 'growth')
	);
	const fallbackOpportunities = bundles.filter(growthAvailableInObservation);
	const opportunities = scovillainEvidence.length ? evidenceOpportunities : fallbackOpportunities;
	if (scovillainEvidence.length) opportunitySource = 'decision-evidence';
	else if (fallbackOpportunities.length) opportunitySource = 'decision-bundle-observation';
	for (const value of opportunities) growthEvents.push({ kind: 'opportunity', turn: number(value.turn) ?? number(object(observation(value)?.battle)?.turn), decisionOrdinal: number(value.decisionOrdinal) });
	for (const value of bundles.filter(bundle => toID(string(bundle.activeSpecies)) === 'scovillain' &&
		toID(string(bundle.selectedAction).replace(/-tera$/, '')) === 'growth')) {
		growthEvents.push({ kind: 'selection', turn: number(object(observation(value)?.battle)?.turn), decisionOrdinal: number(value.decisionOrdinal) });
	}

	return {
		schemaVersion: 1,
		sunOccurred: activations.length > 0,
		firstSunTurn: activations[0]?.turn ?? null,
		firstSunSetter: activations[0]?.setter ?? null,
		sunActivations: activations,
		scovillainEntries: entries.map(({ opponentPending: _pending, exitTurn, ...entry }) => {
			if (!entry.sunTurnsRemaining) return entry;
			const reportedBundle = bundles.find(bundle => {
				if (toID(string(bundle.activeSpecies)) !== 'scovillain' || bundle.requestType !== 'move') return false;
				const reportedTurn = number(object(observation(bundle)?.battle)?.turn);
				return reportedTurn !== null && reportedTurn >= entry.turn && (exitTurn === null || reportedTurn <= exitTurn);
			});
			const reportedBattle = object(observation(reportedBundle || {})?.battle);
			const reportedTurn = number(reportedBattle?.turn);
			const reported = number(reportedBattle?.weather_turns_remaining);
			// Compare at the first decision's turn, not against an earlier entry timer.
			const expected = reportedTurn === entry.turn ? entry.sunTurnsRemaining :
				reportedTurn !== null ? sunAtTurn.get(reportedTurn) : undefined;
			return { ...entry, sunTurnsRemaining: { ...entry.sunTurnsRemaining,
				searchReported: reported !== null && reported >= 0 ? reported : null,
				searchReportedTurn: reported !== null && reported >= 0 ? reportedTurn : null,
				searchMismatch: reported !== null && reported >= 0 && expected !== undefined ?
					reported < (expected?.min ?? 0) || reported > (expected?.max ?? 0) : null,
			} };
		}),
		growth: {
			opportunities: opportunities.length,
			selections: growthEvents.filter(event => event.kind === 'selection').length,
			executions: growthEvents.filter(event => event.kind === 'execution').length,
			opportunitySource,
			caveat: opportunitySource === 'decision-evidence' ? null : opportunitySource === 'decision-bundle-observation' ?
				'Fallback infers move availability from PP/disabled state; transient request restrictions may be unavailable.' :
				'No mechanically legal action evidence or usable observed move state was available.',
			events: growthEvents,
		},
		attacksUnderSun: attacks,
		tera,
		kosUnderSun: kos,
		outcome: resultOutcome(input.result),
		limitations: ['Sun duration uses public weather events and Adam\'s known item; an opposing setter\'s hidden item remains a 5–8 turn range.'],
	};
}
