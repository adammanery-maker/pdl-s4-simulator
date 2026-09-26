import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BattleStream } from '../../sim/battle-stream';
import { Teams } from '../../sim/teams';
import type { PokemonSet } from '../../sim/teams';
import { MECHANICS_CONFORMANCE_RUNTIME } from '../batch/runtime';

export const COMPARISON_CLASSIFICATIONS = [
	'EXACT', 'SEMANTIC_EQUIVALENT', 'RANGE_COMPATIBLE', 'KNOWN_APPROXIMATION',
	'UNSUPPORTED', 'MECHANICS_MISMATCH', 'HARNESS_LIMITATION',
] as const;
export type ComparisonClassification = typeof COMPARISON_CLASSIFICATIONS[number];

export const REQUIRED_MECHANICS = [
	'ordinary-damage', 'damage-roll-set', 'stab', 'tera', 'weather', 'burn', 'screens',
	'critical-hit', 'stat-stages', 'choice-items', 'life-orb', 'assault-vest',
	'focus-sash-sturdy', 'hazards-boots', 'rapid-spin', 'priority', 'trick-room',
	'pdl-roster-abilities',
] as const;

type PublicSet = {
	species: string,
	item?: string,
	ability: string,
	nature?: string,
	moves: string[],
	evs?: Record<string, number>,
	boosts?: Record<string, number>,
	teraType?: string,
};
type Fixture = {
	id: string,
	mechanic: typeof REQUIRED_MECHANICS[number],
	p1: PublicSet,
	p2: PublicSet,
	p1Choice?: string,
	p2Choice?: string,
	p2Bench?: PublicSet[],
	followupChoices?: { p1: string, p2: string }[],
	p1Move: string,
	p2Move?: string,
	weather?: 'sun' | 'rain' | 'sand' | 'hail' | 'snow',
	p1Status?: 'burn',
	p2LightScreen?: boolean,
	notes?: string,
	probe?: boolean,
};
type ShowdownResult = { events: string[], targetMaxHp: number, sampledDamageOutcomes: number[], execution: 'fixed-seed-local-showdown' };
type PokeEngineResult = { supported: boolean, damageRollRepresentation?: 'max-normal-and-crit', p1DamageRolls?: number[], p2DamageRolls?: number[], error?: string };
export type ConformanceCaseResult = {
	id: string,
	mechanic: typeof REQUIRED_MECHANICS[number],
	showdown: ShowdownResult,
	pokeEngine: PokeEngineResult,
	comparison: {
		classification: ComparisonClassification,
		reason: string,
		strategicImpact?: string,
		inferenceImpact?: string,
		recommendedTreatment?: string,
	},
};

const EVS = { hp: 0, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 };
const BASE_P1: PublicSet = { species: 'Pikachu', ability: 'Static', nature: 'Modest', moves: ['Thunderbolt'], evs: EVS, teraType: 'Electric' };
const BASE_P2: PublicSet = { species: 'Blissey', item: 'Leftovers', ability: 'Natural Cure', nature: 'Calm', moves: ['Splash'], evs: { hp: 252, atk: 0, def: 0, spa: 0, spd: 252, spe: 0 }, teraType: 'Normal' };

const FIXTURES: Fixture[] = [
	{ id: 'ordinary-damage', mechanic: 'ordinary-damage', p1: BASE_P1, p2: BASE_P2, p1Move: 'thunderbolt' },
	{ id: 'damage-roll-set', mechanic: 'damage-roll-set', p1: BASE_P1, p2: BASE_P2, p1Move: 'thunderbolt', notes: 'The seeded census is an observed outcome set, not a proof that every PRNG state was enumerated.' },
	{ id: 'stab', mechanic: 'stab', p1: BASE_P1, p2: BASE_P2, p1Move: 'thunderbolt' },
	{ id: 'tera', mechanic: 'tera', p1: BASE_P1, p2: BASE_P2, p1Move: 'thunderbolt', p1Choice: 'move 1 terastallize' },
	{ id: 'weather', mechanic: 'weather', p1: { species: 'Ninetales', ability: 'Drought', nature: 'Modest', moves: ['Flamethrower'], evs: EVS, teraType: 'Fire' }, p2: BASE_P2, p1Move: 'flamethrower', weather: 'sun' },
	{ id: 'burn', mechanic: 'burn', p1: { species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', moves: ['Earthquake'], evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 } }, p2: { species: 'Sableye', ability: 'Prankster', nature: 'Calm', moves: ['Will-O-Wisp'], evs: BASE_P2.evs }, p1Move: 'earthquake', p2Move: 'willowisp', p1Status: 'burn' },
	{ id: 'screens', mechanic: 'screens', p1: BASE_P1, p2: { species: 'Klefki', ability: 'Prankster', nature: 'Calm', moves: ['Light Screen'], evs: BASE_P2.evs }, p1Move: 'thunderbolt', p2Move: 'lightscreen', p2LightScreen: true },
	{ id: 'critical-hit', mechanic: 'critical-hit', p1: { species: 'Glaceon', ability: 'Ice Body', nature: 'Modest', moves: ['Frost Breath'], evs: EVS }, p2: BASE_P2, p1Move: 'frostbreath', probe: false },
	{ id: 'stat-stages', mechanic: 'stat-stages', p1: { species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', moves: ['Swords Dance', 'Earthquake'], evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, boosts: { attack: 2 } }, p2: BASE_P2, p1Move: 'earthquake', followupChoices: [{ p1: 'move 2', p2: 'move 1' }] },
	{ id: 'choice-items', mechanic: 'choice-items', p1: { ...BASE_P1, item: 'Choice Specs' }, p2: BASE_P2, p1Move: 'thunderbolt' },
	{ id: 'life-orb', mechanic: 'life-orb', p1: { ...BASE_P1, item: 'Life Orb' }, p2: BASE_P2, p1Move: 'thunderbolt' },
	{ id: 'assault-vest', mechanic: 'assault-vest', p1: BASE_P1, p2: { ...BASE_P2, item: 'Assault Vest' }, p1Move: 'thunderbolt' },
	{ id: 'focus-sash-sturdy', mechanic: 'focus-sash-sturdy', p1: { ...BASE_P1, item: 'Light Ball' }, p2: { species: 'Squirtle', item: 'Focus Sash', ability: 'Torrent', nature: 'Calm', moves: ['Splash'], evs: BASE_P2.evs }, p1Move: 'thunderbolt', probe: false },
	{ id: 'hazards-boots', mechanic: 'hazards-boots', p1: { species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Stealth Rock'], evs: EVS }, p2: { species: 'Squirtle', ability: 'Torrent', nature: 'Calm', moves: ['Splash'], evs: BASE_P2.evs }, p2Bench: [{ species: 'Talonflame', item: 'Heavy-Duty Boots', ability: 'Flame Body', nature: 'Jolly', moves: ['Roost'], evs: EVS }], p1Move: 'stealthrock', followupChoices: [{ p1: 'move 1', p2: 'switch 2' }], probe: false },
	{ id: 'rapid-spin', mechanic: 'rapid-spin', p1: { species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Stealth Rock'], evs: EVS }, p2: { species: 'Blastoise', ability: 'Torrent', nature: 'Modest', moves: ['Rapid Spin'], evs: EVS }, p1Move: 'stealthrock', p2Move: 'rapidspin', probe: false },
	{ id: 'priority', mechanic: 'priority', p1: { species: 'Pikachu', ability: 'Static', nature: 'Adamant', moves: ['Quick Attack'], evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 0 } }, p2: { species: 'Jolteon', ability: 'Volt Absorb', nature: 'Timid', moves: ['Thunderbolt'], evs: EVS }, p1Move: 'quickattack', p2Move: 'thunderbolt', probe: false },
	{ id: 'trick-room', mechanic: 'trick-room', p1: { species: 'Uxie', ability: 'Levitate', nature: 'Sassy', moves: ['Trick Room'], evs: { hp: 252, atk: 0, def: 0, spa: 0, spd: 252, spe: 0 } }, p2: BASE_P2, p1Move: 'trickroom', probe: false },
	{ id: 'pdl-roster-abilities', mechanic: 'pdl-roster-abilities', p1: { species: 'Tatsugiri', ability: 'Storm Drain', nature: 'Modest', moves: ['Surf'], evs: EVS }, p2: { species: 'Gastrodon', ability: 'Storm Drain', nature: 'Calm', moves: ['Splash'], evs: BASE_P2.evs }, p1Move: 'surf', probe: false, notes: 'Storm Drain is a PDL-relevant immunity and boost interaction.' },
];

function revisionAt(path: string): string {
	return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function captureConformanceRuntime() {
	const simulatorRoot = process.cwd();
	const projectRoot = `${simulatorRoot}/..`;
	return Object.freeze({
		...MECHANICS_CONFORMANCE_RUNTIME,
		simulatorRevision: revisionAt(simulatorRoot),
		foulPlayRevision: revisionAt(`${projectRoot}/pdl-s4-foul-play`),
		pokeEngineRevision: revisionAt(`${projectRoot}/poke-engine`),
	});
}

class RecordingBattleStream extends BattleStream {
	readonly protocol: string[] = [];

	override push(chunk: string) {
		this.protocol.push(chunk);
		super.push(chunk);
	}
}

function cloneSet(set: PublicSet): PublicSet {
	return { ...set, moves: [...set.moves], evs: set.evs ? { ...set.evs } : undefined };
}

function toShowdownSet(set: PublicSet): PokemonSet {
	const stat = (name: keyof StatsTable) => set.evs?.[name] || 0;
	return {
		name: set.species,
		species: set.species,
		item: set.item || '',
		ability: set.ability,
		moves: [...set.moves],
		nature: set.nature || 'Serious',
		gender: '',
		evs: { hp: stat('hp'), atk: stat('atk'), def: stat('def'), spa: stat('spa'), spd: stat('spd'), spe: stat('spe') },
		ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
		level: 100,
		teraType: set.teraType,
	};
}

async function executeShowdownFixture(fixture: Fixture, seedIndex: number): Promise<ShowdownResult> {
	const stream = new RecordingBattleStream({ keepAlive: true });
	const p1 = cloneSet(fixture.p1);
	const p2 = cloneSet(fixture.p2);
	await stream.write(`>start ${JSON.stringify({ formatid: 'gen9customgame', seed: [17, 29, 43, seedIndex + 1] })}`);
	await stream.write(`>player p1 ${JSON.stringify({ name: 'fixture-p1', team: Teams.pack([toShowdownSet(p1)]) })}`);
	await stream.write(`>player p2 ${JSON.stringify({ name: 'fixture-p2', team: Teams.pack([toShowdownSet(p2), ...(fixture.p2Bench || []).map(toShowdownSet)]) })}`);
	await stream.write('>p1 team 1\n>p2 team 1');
	await stream.write(`>p1 ${fixture.p1Choice || 'move 1'}\n>p2 ${fixture.p2Choice || 'move 1'}`);
	for (const choice of fixture.followupChoices || []) {
		await stream.write(`>p1 ${choice.p1}\n>p2 ${choice.p2}`);
	}
	const lines = stream.protocol.flatMap(chunk => chunk.split('\n'));
	const switchLine = lines.find(line => line.startsWith('|switch|p2a:'));
	const maxHp = Number(switchLine?.match(/\|(\d+)\/(\d+)$/)?.[2] || 0);
	const damageLine = lines.find(line => line.startsWith('|-damage|p2a:'));
	const remaining = Number(damageLine?.match(/\|(\d+)\//)?.[1] || (damageLine?.includes('|0 fnt') ? 0 : maxHp));
	const damage = maxHp && damageLine ? maxHp - remaining : 0;
	return { events: lines.filter(line => line.startsWith('|move|') || line.startsWith('|-damage|') || line.startsWith('|-ability|') || line.startsWith('|-terastallize|') || line.startsWith('|-sidestart|') || line.startsWith('|-status|') || line.startsWith('|-boost|') || line.startsWith('|switch|')), targetMaxHp: maxHp, sampledDamageOutcomes: damage ? [damage] : [], execution: 'fixed-seed-local-showdown' };
}

function runProbe(python: string, script: string, foulPlayRoot: string, payload: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(python, [script], { cwd: foulPlayRoot, env: { ...process.env, PYTHONPATH: foulPlayRoot }, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });
		child.once('error', reject);
		child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`probe exited ${code}: ${stderr}`)));
		child.stdin.end(payload);
	});
}

async function probePokeEngine(fixture: Fixture): Promise<PokeEngineResult> {
	if (fixture.probe === false) return { supported: false, error: fixture.notes || 'This fixture requires protocol-history state not represented by the current static native probe.' };
	const script = `${process.cwd()}/pdl/conformance/poke-engine-probe.py`;
	const foulPlayRoot = `${process.cwd()}/../pdl-s4-foul-play`;
	const python = `${foulPlayRoot}/.venv/bin/python`;
	const payload = JSON.stringify({
		p1: { ...fixture.p1, terastallized: fixture.p1Choice?.includes('terastallize') || false },
		p2: fixture.p2,
		p1Move: fixture.p1Move,
		p2Move: fixture.p2Move || 'splash',
		p1MovesFirst: true,
		weather: fixture.weather,
		p1Status: fixture.p1Status,
		p2LightScreen: fixture.p2LightScreen,
	});
	try {
		return JSON.parse(await runProbe(python, script, foulPlayRoot, payload)) as PokeEngineResult;
	} catch (error: any) {
		return { supported: false, error: `probe launch failed: ${error.message}` };
	}
}

function comparisonFor(fixture: Fixture, showdown: ShowdownResult, pokeEngine: PokeEngineResult): ConformanceCaseResult['comparison'] {
	const nonExact = (classification: Exclude<ComparisonClassification, 'EXACT'>, reason: string) => ({
		classification, reason,
		strategicImpact: 'Do not use this fixture as proof of an exact live-search transition.',
		inferenceImpact: 'Do not collapse a belief constraint from this comparison alone.',
		recommendedTreatment: 'Keep the limitation in the conformance report and add a stateful adapter before treating this mechanic as exact.',
	});
	if (!pokeEngine.supported) return nonExact('UNSUPPORTED', pokeEngine.error || 'The native probe did not support this fixture.');
	if (fixture.mechanic === 'damage-roll-set') return nonExact('HARNESS_LIMITATION', fixture.notes || 'The fixture samples deterministic PRNG seeds but does not enumerate Showdown’s entire RNG state space.');
	if (!showdown.sampledDamageOutcomes.length) return nonExact('KNOWN_APPROXIMATION', 'The public Showdown trace did not expose an exact direct-damage outcome for this fixture.');
	if (pokeEngine.damageRollRepresentation === 'max-normal-and-crit') {
		const maxNormalDamage = Math.min(pokeEngine.p1DamageRolls?.[0] || 0, showdown.targetMaxHp);
		const minNormalDamage = Math.floor(maxNormalDamage * 0.85);
		if (showdown.sampledDamageOutcomes.every(value => value >= minNormalDamage && value <= maxNormalDamage)) {
			return nonExact('KNOWN_APPROXIMATION', 'poke-engine exposes maximum normal and critical damage only; it does not expose the 16 Gen 9 random damage outcomes or their distribution. The observed Showdown outcome falls inside the derived 85–100% envelope.');
		}
	}
	if (showdown.sampledDamageOutcomes.every(value => pokeEngine.p1DamageRolls?.includes(value))) {
		return nonExact('RANGE_COMPATIBLE', 'Every fixed-seed Showdown outcome observed lies in poke-engine’s calculated damage roll set.');
	}
	return nonExact('MECHANICS_MISMATCH', `Observed Showdown damage ${showdown.sampledDamageOutcomes.join(', ')} is absent from poke-engine rolls ${(pokeEngine.p1DamageRolls || []).join(', ')}.`);
}

export async function runMechanicsConformance() {
	const cases: ConformanceCaseResult[] = [];
	for (const fixture of FIXTURES) {
		const samples = await Promise.all(Array.from({ length: fixture.mechanic === 'damage-roll-set' ? 64 : 1 }, (_, index) => executeShowdownFixture(fixture, index)));
		const showdown: ShowdownResult = {
			...samples[0],
			sampledDamageOutcomes: [...new Set(samples.flatMap(sample => sample.sampledDamageOutcomes))].sort((a, b) => a - b),
		};
		const pokeEngine = await probePokeEngine(fixture);
		cases.push({ id: fixture.id, mechanic: fixture.mechanic, showdown, pokeEngine, comparison: comparisonFor(fixture, showdown, pokeEngine) });
	}
	return { runtime: captureConformanceRuntime(), cases };
}

/** Writes the aggregate manifest plus one independently reviewable result per fixture. */
export async function writeMechanicsConformanceReport(outputDirectory: string): Promise<string[]> {
	const report = await runMechanicsConformance();
	await mkdir(outputDirectory, { recursive: true });
	const indexPath = join(outputDirectory, 'manifest.json');
	await writeFile(indexPath, `${JSON.stringify(report, null, 2)}\n`);
	const casePaths = await Promise.all(report.cases.map(async result => {
		const path = join(outputDirectory, `${result.id}.json`);
		await writeFile(path, `${JSON.stringify({ runtime: report.runtime, ...result }, null, 2)}\n`);
		return path;
	}));
	return [indexPath, ...casePaths];
}
