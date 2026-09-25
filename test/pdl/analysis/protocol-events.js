'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { parseBattleProtocol } = require('../../../dist/pdl/analysis/protocol-events');

describe('PDL simulation protocol events', () => {
	it('attributes public battle events to the manifest team sides', () => {
		const parsed = parseBattleProtocol([
			'>battle-gen9pdls4-1',
			'|switch|p1a: Golem|Golem, L100|100/100',
			'|switch|p2a: Muk|Muk, L100|100/100',
			'|move|p1a: Golem|Earthquake|p2a: Muk',
			'|-damage|p2a: Muk|0 fnt',
			'|faint|p2a: Muk',
			'|-terastallize|p1a: Golem|Rock',
			'|win|PDL Sim pair-0001 p1',
		].join('\n'), {
			p1: { teamId: 'adam', botName: 'PDL Sim pair-0001 p1' },
			p2: { teamId: 'connor', botName: 'PDL Sim pair-0001 p2' },
		});

		assert.equal(parsed.leads.adam, 'golem');
		assert.equal(parsed.leads.connor, 'muk');
		assert.deepEqual(parsed.moves, [{ teamId: 'adam', species: 'golem', move: 'earthquake', targetTeamId: 'connor', targetSpecies: 'muk', damagePercent: 100, ko: true }]);
		assert.deepEqual(parsed.tera, [{ teamId: 'adam', species: 'golem', type: 'rock' }]);
		assert.equal(parsed.winnerTeamId, 'adam');
	});
});
