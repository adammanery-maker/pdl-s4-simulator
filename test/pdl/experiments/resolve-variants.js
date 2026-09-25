'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { diversifiedConstraints } = require('../../../dist/pdl/experiments/resolve-variants');

const team = {
	id: 'connor', name: 'Connor', draftedTeraTypes: ['Ghost', 'Grass'],
	roster: ['Flygon', 'Heracross', 'Ribombee', 'Muk', 'Coalossal', 'Vikavolt', 'Masquerain', 'Poliwrath', 'Noivern', 'Forretress'].map(species => ({ species, cost: 4 })),
};
const constraints = { requiredSpecies: ['flygon', 'heracross', 'ribombee'], excludedSpecies: [], lockedSets: [] };

describe('PDL experiment variant resolution', () => {
	it('deterministically fills a fixed core with different legal species combinations', () => {
		const first = diversifiedConstraints({ team, constraints, selectionIndex: 0 });
		const second = diversifiedConstraints({ team, constraints, selectionIndex: 1 });
		assert.equal(first.requiredSpecies.length, 6);
		assert.equal(second.requiredSpecies.length, 6);
		assert.deepEqual(first.requiredSpecies.slice(0, 3), ['flygon', 'heracross', 'ribombee']);
		assert.notDeepEqual(first.requiredSpecies, second.requiredSpecies);
	});

	it('uses the canonical live roster team id after case-insensitive plan matching', () => {
		const resolved = require('../../../dist/pdl/experiments/resolve-variants').canonicalTeamId(team, 'Connor');
		assert.equal(resolved, 'connor');
	});
});
