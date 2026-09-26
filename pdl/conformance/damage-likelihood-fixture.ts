import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	calculateDamageLikelihood,
	type DamageLikelihoodInput,
} from '../inference/showdown-damage-likelihood';
import { MECHANICS_CONFORMANCE_RUNTIME } from '../batch/runtime';

const SPECIAL_EVS = { hp: 0, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 };
const PHYSICAL_EVS = { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 };
const BASE_ATTACKER = {
	species: 'Pikachu', ability: 'Static', nature: 'Modest', moves: ['Thunderbolt'],
	evs: SPECIAL_EVS, teraType: 'Electric',
};
const BASE_DEFENDER = {
	species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', moves: ['Splash'],
	evs: { hp: 252, atk: 0, def: 0, spa: 0, spd: 252, spe: 0 }, teraType: 'Normal',
};

type LikelihoodFixture = { id: string, input: DamageLikelihoodInput };

const FIXTURES: LikelihoodFixture[] = [
	{
		id: 'ordinary-damage',
		input: { attacker: BASE_ATTACKER, defender: BASE_DEFENDER, move: 'Thunderbolt', critical: false },
	},
	{
		id: 'tera',
		input: { attacker: BASE_ATTACKER, defender: BASE_DEFENDER, move: 'Thunderbolt', critical: false, tera: true },
	},
	{
		id: 'weather',
		input: {
			attacker: { species: 'Ninetales', ability: 'Drought', nature: 'Modest', moves: ['Flamethrower'], evs: SPECIAL_EVS },
			defender: BASE_DEFENDER, move: 'Flamethrower', critical: false, weather: 'sun',
		},
	},
	{
		id: 'terrain',
		input: {
			attacker: BASE_ATTACKER, defender: BASE_DEFENDER, move: 'Thunderbolt',
			critical: false, terrain: 'electricterrain',
		},
	},
	{
		id: 'burn',
		input: {
			attacker: { species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', moves: ['Earthquake'], evs: PHYSICAL_EVS },
			defender: { species: 'Sableye', ability: 'Prankster', nature: 'Calm', moves: ['Splash'], evs: BASE_DEFENDER.evs },
			move: 'Earthquake', critical: false, attackerStatus: 'brn',
		},
	},
	{
		id: 'screens',
		input: {
			attacker: BASE_ATTACKER, defender: BASE_DEFENDER, move: 'Thunderbolt',
			critical: false, defenderSideConditions: ['lightscreen'],
		},
	},
	{
		id: 'critical-hit',
		input: { attacker: BASE_ATTACKER, defender: BASE_DEFENDER, move: 'Thunderbolt', critical: true },
	},
	{
		id: 'stat-stages',
		input: {
			attacker: { species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', moves: ['Earthquake'], evs: PHYSICAL_EVS },
			defender: BASE_DEFENDER, move: 'Earthquake', critical: false, attackerBoosts: { atk: 2 },
		},
	},
	{
		id: 'choice-specs',
		input: {
			attacker: { ...BASE_ATTACKER, item: 'Choice Specs' }, defender: BASE_DEFENDER,
			move: 'Thunderbolt', critical: false,
		},
	},
	{
		id: 'life-orb',
		input: {
			attacker: { ...BASE_ATTACKER, item: 'Life Orb' }, defender: BASE_DEFENDER,
			move: 'Thunderbolt', critical: false,
		},
	},
	{
		id: 'assault-vest',
		input: {
			attacker: BASE_ATTACKER, defender: { ...BASE_DEFENDER, item: 'Assault Vest' },
			move: 'Thunderbolt', critical: false,
		},
	},
	{
		id: 'ability-immunity',
		input: {
			attacker: BASE_ATTACKER,
			defender: { species: 'Jolteon', ability: 'Volt Absorb', nature: 'Timid', moves: ['Splash'], evs: SPECIAL_EVS },
			move: 'Thunderbolt', critical: false,
		},
	},
];

export async function runDamageLikelihoodConformance() {
	const cases = await Promise.all(FIXTURES.map(async fixture => {
		const likelihood = await calculateDamageLikelihood(fixture.input);
		const outcomeKind = likelihood.outcomeKind.kind;
		return {
			id: fixture.id,
			classification: outcomeKind === 'DAMAGE' ? 'EXACT' : outcomeKind,
			mechanicsSource: likelihood.mechanicsSource,
			sourceRevision: likelihood.sourceRevision,
			enumeration: 'local-showdown Battle#randomizer forced for every factor 85..100',
			outcomeKind,
			critical: fixture.input.critical,
			rolls: likelihood.rolls,
			outcomes: likelihood.outcomes,
			multiplicity: likelihood.outcomes.reduce((sum, outcome) => sum + outcome.multiplicity, 0),
			minDamage: likelihood.minDamage,
			maxDamage: likelihood.maxDamage,
		};
	}));
	return {
		...MECHANICS_CONFORMANCE_RUNTIME,
		mechanicsSource: 'pokemon-showdown-local' as const,
		purpose: 'exact damage likelihoods for belief inference, separate from poke-engine MCTS transitions',
		cases,
	};
}

export async function writeDamageLikelihoodConformance(outputDirectory: string): Promise<string> {
	const path = join(outputDirectory, 'damage-likelihood.json');
	await writeFile(path, `${JSON.stringify(await runDamageLikelihoodConformance(), null, 2)}\n`);
	return path;
}
