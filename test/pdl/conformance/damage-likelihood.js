'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { calculateDamageLikelihood, calculateObservationLikelihood } = require('../../../dist/pdl/inference/showdown-damage-likelihood');

const attacker = {
	species: 'Pikachu', ability: 'Static', nature: 'Modest', moves: ['Thunderbolt'],
	evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 }, teraType: 'Electric',
};
const defender = {
	species: 'Blissey', item: 'Leftovers', ability: 'Natural Cure', nature: 'Calm', moves: ['Splash'],
	evs: { hp: 252, atk: 0, def: 0, spa: 0, spd: 252, spe: 0 }, teraType: 'Normal',
};

describe('local Showdown damage likelihood calculator', () => {
	it('preserves all sixteen exact normal damage factors and duplicate multiplicities', async function () {
		this.timeout(30000);
		const likelihood = await calculateDamageLikelihood({ attacker, defender, move: 'Thunderbolt', critical: false });

		assert.equal(likelihood.mechanicsSource, 'pokemon-showdown-local');
		assert.equal(likelihood.observationModel, 'exact-hp');
		assert.deepEqual(likelihood.rolls.map(roll => roll.randomFactor), Array.from({ length: 16 }, (_, index) => index + 85));
		assert.equal(likelihood.outcomes.reduce((sum, outcome) => sum + outcome.multiplicity, 0), 16);
		assert.equal(likelihood.outcomes.every(outcome => Number.isInteger(outcome.damage) && outcome.probability === outcome.multiplicity / 16), true);
	});

	it('returns typed immunity without inventing damage likelihood', async function () {
		this.timeout(30000);
		const likelihood = await calculateDamageLikelihood({
			attacker: { ...attacker, moves: ['Thunderbolt'] },
			defender: { ...defender, species: 'Jolteon', ability: 'Volt Absorb' },
			move: 'Thunderbolt', critical: false,
		});

		assert.equal(likelihood.outcomes.length, 0);
		assert.deepEqual(likelihood.outcomeKind, { kind: 'IMMUNE', source: 'ability: Volt Absorb' });
	});

	it('applies public field modifiers and preserves an exact critical outcome set', async function () {
		this.timeout(30000);
		const normal = await calculateDamageLikelihood({
			attacker: { ...attacker, moves: ['Flamethrower'], teraType: 'Fire' },
			defender,
			move: 'Flamethrower',
			critical: false,
			weather: 'sun',
			attackerBoosts: { spa: 2 },
			defenderSideConditions: ['lightscreen'],
		});
		const critical = await calculateDamageLikelihood({
			attacker: { ...attacker, moves: ['Flamethrower'], teraType: 'Fire' },
			defender,
			move: 'Flamethrower',
			critical: true,
			weather: 'sun',
			attackerBoosts: { spa: 2 },
			defenderSideConditions: ['lightscreen'],
		});

		assert.equal(normal.outcomeKind.kind, 'DAMAGE');
		assert.equal(critical.outcomeKind.kind, 'DAMAGE');
		assert.equal(critical.minDamage > normal.minDamage, true);
		assert.equal(critical.rolls.length, 16);
	});

	it('computes likelihoods for exact and percentage-only HP observations without claiming exact damage', async function () {
		this.timeout(30000);
		const likelihood = await calculateDamageLikelihood({ attacker, defender, move: 'Thunderbolt', critical: false });
		const exact = calculateObservationLikelihood(likelihood, { kind: 'exact-hp', observedDamage: likelihood.rolls[0].damage });
		const displayed = calculateObservationLikelihood(likelihood, {
			kind: 'displayed-percentage', targetMaxHp: 714, beforePercent: 100,
			afterPercent: Math.ceil(100 * (714 - likelihood.rolls[0].damage) / 714),
		});

		assert.equal(exact.observationModel, 'exact-hp');
		assert.equal(exact.probability > 0 && exact.probability <= 1, true);
		assert.equal(displayed.observationModel, 'showdown-displayed-percentage');
		assert.equal(displayed.compatibleDamages.includes(likelihood.rolls[0].damage), true);
		assert.equal(displayed.probability > 0 && displayed.probability <= 1, true);
	});
});
