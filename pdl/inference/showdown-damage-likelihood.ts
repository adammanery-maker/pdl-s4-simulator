/** Exact Gen 9 damage likelihoods for belief updates.
 *
 * This is intentionally separate from poke-engine's fast MCTS transition
 * calculator. It invokes the vendored, local Pokemon Showdown executor once
 * for each of Showdown's sixteen random-damage factors. Inputs contain only
 * public state plus a caller-supplied belief hypothesis; this module never
 * receives an authoritative battle or submitted opponent team.
 */
import { BattleStream } from '../../sim/battle-stream';
import { Teams, type PokemonSet } from '../../sim/teams';
import { SHOWDOWN_COMMIT } from '../simulate';

type Boosts = Partial<Record<Exclude<keyof BoostsTable, 'accuracy' | 'evasion'>, number>>;
type DamageStatus = 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz';
type Weather = 'sun' | 'rain' | 'sand' | 'hail' | 'snow';
type Terrain = 'electricterrain' | 'grassyterrain' | 'mistyterrain' | 'psychicterrain';
type SideCondition = 'reflect' | 'lightscreen' | 'auroraveil';

export type DamageCalculatorSet = {
	species: string,
	item?: string,
	ability: string,
	nature?: string,
	moves: string[],
	level?: number,
	evs?: Partial<StatsTable>,
	ivs?: Partial<StatsTable>,
	teraType?: string,
};

/** Every field is either public knowledge or a value from one sampled belief hypothesis. */
export type DamageLikelihoodInput = {
	attacker: DamageCalculatorSet,
	defender: DamageCalculatorSet,
	move: string,
	critical: boolean,
	tera?: boolean,
	weather?: Weather,
	terrain?: Terrain,
	attackerStatus?: DamageStatus,
	defenderStatus?: DamageStatus,
	attackerBoosts?: Boosts,
	defenderBoosts?: Boosts,
	attackerSideConditions?: SideCondition[],
	defenderSideConditions?: SideCondition[],
};

export type DamageRoll = { randomFactor: number, damage: number };
export type DamageOutcome = { damage: number, multiplicity: number, probability: number };
export type DamageOutcomeKind =
	| { kind: 'DAMAGE' } |
	{ kind: 'IMMUNE', source: string } |
	{ kind: 'UNSUPPORTED', reason: string } |
	{ kind: 'CALCULATION_ERROR', reason: string };

export type DamageLikelihood = {
	mechanicsSource: 'pokemon-showdown-local',
	sourceRevision: string,
	observationModel: 'exact-hp',
	outcomeKind: DamageOutcomeKind,
	rolls: DamageRoll[],
	outcomes: DamageOutcome[],
	minDamage: number | null,
	maxDamage: number | null,
};

export type DamageObservation =
	| { kind: 'exact-hp', observedDamage: number } |
	{ kind: 'displayed-percentage', targetMaxHp: number, beforePercent: number, afterPercent: number };

export type ObservationLikelihood = {
	observationModel: 'exact-hp' | 'showdown-displayed-percentage',
	probability: number,
	compatibleDamages: number[],
	compatibleMultiplicity: number,
	/** Exact integer HP values compatible with a percentage observation, when applicable. */
	possibleBeforeHp?: number[],
};

class RecordingBattleStream extends BattleStream {
	readonly protocol: string[] = [];

	override push(chunk: string) {
		this.protocol.push(chunk);
		super.push(chunk);
	}
}

function toShowdownSet(set: DamageCalculatorSet): PokemonSet {
	const stat = (name: keyof StatsTable) => set.evs?.[name] || 0;
	const iv = (name: keyof StatsTable) => set.ivs?.[name] ?? 31;
	return {
		name: set.species,
		species: set.species,
		item: set.item || '',
		ability: set.ability,
		moves: [...set.moves],
		nature: set.nature || 'Serious',
		gender: '',
		evs: {
			hp: stat('hp'), atk: stat('atk'), def: stat('def'),
			spa: stat('spa'), spd: stat('spd'), spe: stat('spe'),
		},
		ivs: {
			hp: iv('hp'), atk: iv('atk'), def: iv('def'),
			spa: iv('spa'), spd: iv('spd'), spe: iv('spe'),
		},
		level: set.level || 100,
		teraType: set.teraType,
	};
}

function applyPublicState(battle: any, input: DamageLikelihoodInput) {
	const attacker = battle.sides[0].active[0];
	const defender = battle.sides[1].active[0];
	if (!attacker || !defender) throw new Error('Showdown did not initialize active Pokemon for likelihood calculation.');
	if (input.weather) battle.field.setWeather(input.weather, 'debug');
	if (input.terrain) battle.field.setTerrain(input.terrain, 'debug');
	if (input.attackerStatus) attacker.setStatus(input.attackerStatus, null, 'debug');
	if (input.defenderStatus) defender.setStatus(input.defenderStatus, null, 'debug');
	for (const [stat, amount] of Object.entries(input.attackerBoosts || {})) attacker.boosts[stat] = amount;
	for (const [stat, amount] of Object.entries(input.defenderBoosts || {})) defender.boosts[stat] = amount;
	for (const condition of input.attackerSideConditions || []) battle.sides[0].addSideCondition(condition, 'debug');
	for (const condition of input.defenderSideConditions || []) battle.sides[1].addSideCondition(condition, 'debug');
}

async function calculateFactor(
	input: DamageLikelihoodInput, randomFactor: number
): Promise<{ damage: number, immuneSource?: string }> {
	const stream = new RecordingBattleStream({ keepAlive: true });
	await stream.write(`>start ${JSON.stringify({ formatid: 'gen9customgame', seed: [17, 29, 43, 1] })}`);
	await stream.write(`>player p1 ${JSON.stringify({
		name: 'inference-attacker', team: Teams.pack([toShowdownSet(input.attacker)]),
	})}`);
	await stream.write(`>player p2 ${JSON.stringify({
		name: 'inference-defender', team: Teams.pack([toShowdownSet(input.defender)]),
	})}`);
	await stream.write('>p1 team 1\n>p2 team 1');
	const battle = stream.battle!;
	applyPublicState(battle, input);
	const attacker = battle.sides[0].active[0];
	// Critical hits are observations, not another uncertainty dimension here.
	// Focus Energy provides a local, battle-scoped crit-ratio hook, so this can
	// force the requested critical state without mutating frozen Dex move data.
	attacker.addVolatile('focusenergy');
	let criticalRollPending = true;
	battle.randomChance = (numerator: number, denominator: number) => {
		if (criticalRollPending && numerator === 1 && [1, 2, 8, 24].includes(denominator)) {
			criticalRollPending = false;
			return input.critical;
		}
		return true;
	};
	// This exactly matches Battle#randomizer: trunc(trunc(base * factor) / 100).
	battle.randomizer = (baseDamage: number) => Math.trunc(Math.trunc(baseDamage * randomFactor) / 100);
	await stream.write(`>p1 move 1${input.tera ? ' terastallize' : ''}\n>p2 move 1`);

	const lines = stream.protocol.flatMap(chunk => chunk.split('\n'));
	const switchLine = lines.find(line => line.startsWith('|switch|p2a:'));
	const maxHp = Number(switchLine?.match(/\|(\d+)\/(\d+)$/)?.[2] || 0);
	const damageLine = lines.find(line => line.startsWith('|-damage|p2a:'));
	if (damageLine) {
		const remaining = Number((/\|(\d+)\//.exec(damageLine))?.[1] || (damageLine.includes('|0 fnt') ? 0 : maxHp));
		return { damage: maxHp - remaining };
	}
	const immunity = lines.find(line => line.startsWith('|-immune|p2a:'));
	if (immunity) {
		const ability = (/ability: ([^\]|]+)/.exec(immunity))?.[1];
		return { damage: 0, immuneSource: ability ? `ability: ${ability}` : 'type' };
	}
	throw new Error(`Showdown did not produce damage or immunity for ${input.move}: ${lines.join('\n')}`);
}

/** Enumerates all sixteen Gen 9 random damage factors with local Showdown. */
export async function calculateDamageLikelihood(input: DamageLikelihoodInput): Promise<DamageLikelihood> {
	try {
		const results = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
			const randomFactor = index + 85;
			return { randomFactor, ...(await calculateFactor(input, randomFactor)) };
		}));
		const immunity = results.find(result => result.immuneSource);
		if (immunity) {
			return {
				mechanicsSource: 'pokemon-showdown-local', sourceRevision: SHOWDOWN_COMMIT, observationModel: 'exact-hp',
				outcomeKind: { kind: 'IMMUNE', source: immunity.immuneSource! },
				rolls: [], outcomes: [], minDamage: null, maxDamage: null,
			};
		}
		const rolls = results.map(({ randomFactor, damage }) => ({ randomFactor, damage }));
		const multiplicities = new Map<number, number>();
		for (const { damage } of rolls) multiplicities.set(damage, (multiplicities.get(damage) || 0) + 1);
		const outcomes = [...multiplicities.entries()]
			.map(([damage, multiplicity]) => ({ damage, multiplicity, probability: multiplicity / 16 }))
			.sort((a, b) => a.damage - b.damage);
		return {
			mechanicsSource: 'pokemon-showdown-local', sourceRevision: SHOWDOWN_COMMIT,
			observationModel: 'exact-hp', outcomeKind: { kind: 'DAMAGE' },
			rolls, outcomes, minDamage: outcomes[0].damage,
			maxDamage: outcomes[outcomes.length - 1].damage,
		};
	} catch (error: any) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			mechanicsSource: 'pokemon-showdown-local', sourceRevision: SHOWDOWN_COMMIT, observationModel: 'exact-hp',
			outcomeKind: { kind: 'CALCULATION_ERROR', reason }, rolls: [], outcomes: [], minDamage: null, maxDamage: null,
		};
	}
}

/** Returns the integer HP values Showdown's Gen 7+ shared health display can represent. */
export function possibleHpForDisplayedPercent(maxHp: number, percent: number): number[] {
	if (!Number.isInteger(maxHp) || maxHp <= 0 || !Number.isInteger(percent) || percent < 0 || percent > 100) {
		return [];
	}
	if (percent === 0) return [0];
	if (percent === 100) return [maxHp]; // Showdown displays damaged 100% as 99%.
	const values: number[] = [];
	for (let hp = 1; hp < maxHp; hp++) if (Math.ceil(100 * hp / maxHp) === percent) values.push(hp);
	return values;
}

/** Converts an exact or quantized public HP observation into P(observation | H). */
export function calculateObservationLikelihood(
	likelihood: DamageLikelihood, observation: DamageObservation
): ObservationLikelihood {
	const observationModel = observation.kind === 'exact-hp' ? 'exact-hp' : 'showdown-displayed-percentage';
	if (likelihood.outcomeKind.kind !== 'DAMAGE') {
		return { observationModel, probability: 0, compatibleDamages: [], compatibleMultiplicity: 0 };
	}
	let compatible: DamageOutcome[];
	let possibleBeforeHp: number[] | undefined;
	if (observation.kind === 'exact-hp') {
		compatible = likelihood.outcomes.filter(outcome => outcome.damage === observation.observedDamage);
	} else {
		possibleBeforeHp = possibleHpForDisplayedPercent(observation.targetMaxHp, observation.beforePercent);
		const afterHp = new Set(
			possibleHpForDisplayedPercent(observation.targetMaxHp, observation.afterPercent)
		);
		compatible = likelihood.outcomes.filter(
			outcome => possibleBeforeHp!.some(before => afterHp.has(before - outcome.damage))
		);
	}
	const compatibleMultiplicity = compatible.reduce((sum, outcome) => sum + outcome.multiplicity, 0);
	return {
		observationModel, probability: compatibleMultiplicity / 16,
		compatibleDamages: compatible.map(outcome => outcome.damage), compatibleMultiplicity,
		...(possibleBeforeHp ? { possibleBeforeHp } : {}),
	};
}
