'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { applyTemporaryFreeAgents } = require('../../../dist/pdl/experiments/free-agents');
const { normalizePdlSamplingSnapshot } = require('../../../dist/pdl/sampling/snapshot');

function snapshot() {
	return normalizePdlSamplingSnapshot({
		id: 'free-agent-fixture', sourceId: 'fixture',
		roster: { teams: [
			{ id: 'adam', name: 'Adam', draftedTeraTypes: ['Ghost', 'Grass'], roster: [
				{ species: 'Golem', cost: 5 }, { species: 'Tatsugiri', cost: 3 }, { species: 'Uxie', cost: 4 },
			] },
			{ id: 'connor', name: 'Connor', draftedTeraTypes: ['Ghost', 'Grass'], roster: [{ species: 'Flygon', cost: 5 }] },
		] },
		availablePokemon: [{ species: 'Rhydon', cost: 4 }, { species: 'Xatu', cost: 3 }],
		usageBySpecies: {},
	});
}

describe('PDL temporary free-agent variants', () => {
	it('replaces a roster Pokémon without changing the frozen base snapshot', () => {
		const base = snapshot();
		const altered = applyTemporaryFreeAgents({ snapshot: base, teamId: 'adam', additions: [{ pokemon: 'Rhydon', replace: 'Golem' }] });
		assert.deepEqual(base.roster.teams[0].roster.map(pokemon => pokemon.species), ['golem', 'tatsugiri', 'uxie']);
		assert.deepEqual(altered.roster.teams[0].roster.map(pokemon => pokemon.species), ['rhydon', 'tatsugiri', 'uxie']);
	});

	it('expands only the simulation roster when no replacement is named', () => {
		const altered = applyTemporaryFreeAgents({ snapshot: snapshot(), teamId: 'adam', additions: [{ pokemon: 'Xatu' }] });
		assert.deepEqual(altered.roster.teams[0].roster.map(pokemon => pokemon.species), ['golem', 'tatsugiri', 'uxie', 'xatu']);
	});

	it('rejects a Pokémon that is not currently available as a free agent', () => {
		assert.throws(() => applyTemporaryFreeAgents({ snapshot: snapshot(), teamId: 'adam', additions: [{ pokemon: 'Flygon' }] }), /not currently available/i);
	});
});
