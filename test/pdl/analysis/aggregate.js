'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { Teams } = require('../../../dist/sim/teams');
const { aggregateCompletedPairedTrials, countTerminalPairs } = require('../../../dist/pdl/analysis/aggregate');
const { CANONICAL_RUNTIME_ID } = require('../../../dist/pdl/batch/runtime');

function packed(species) {
	return Teams.pack(species.map(name => ({
		species: name, item: 'Leftovers', ability: 'Sturdy', nature: 'Adamant',
		evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 }, moves: ['Earthquake', 'Protect', 'Substitute', 'Stealth Rock'],
	})));
}

const adam = packed(['Golem', 'Inteleon', 'Flamigo', 'Whimsicott', 'Scovillain', 'Tatsugiri']);
const connor = packed(['Muk', 'Flygon', 'Ribombee', 'Masquerain', 'Coalossal', 'Vikavolt']);

describe('PDL simulation aggregation', () => {
	it('reports records only from a complete side-balanced pair', () => {
		const summary = aggregateCompletedPairedTrials([
			{
				runtimeId: CANONICAL_RUNTIME_ID, pairId: 'pair-0001', side: 'forward', status: 'completed', winnerTeamId: 'adam',
				p1: { teamId: 'adam', botName: 'Adam p1', packed: adam }, p2: { teamId: 'connor', botName: 'Connor p2', packed: connor },
				scenario: { leftTeamId: 'Adam', rightTeamId: 'Connor', leftVariantId: 'adam-sun', rightVariantId: 'connor-core', cellId: 'adam-sun__connor-core' },
				protocol: '|switch|p1a: Golem|Golem, L100|100/100\n|switch|p2a: Muk|Muk, L100|100/100\n|move|p1a: Golem|Earthquake|p2a: Muk\n|-damage|p2a: Muk|0 fnt\n|faint|p2a: Muk\n|win|Adam p1',
			},
			{
				runtimeId: CANONICAL_RUNTIME_ID, pairId: 'pair-0001', side: 'reverse', status: 'completed', winnerTeamId: 'connor',
				p1: { teamId: 'connor', botName: 'Connor p1', packed: connor }, p2: { teamId: 'adam', botName: 'Adam p2', packed: adam },
				scenario: { leftTeamId: 'Adam', rightTeamId: 'Connor', leftVariantId: 'adam-sun', rightVariantId: 'connor-core', cellId: 'adam-sun__connor-core' },
				protocol: '|switch|p1a: Muk|Muk, L100|100/100\n|switch|p2a: Golem|Golem, L100|100/100\n|move|p1a: Muk|Knock Off|p2a: Golem\n|win|Connor p1',
			},
		]);

		assert.equal(summary.completedPairCount, 1);
		const adamRecord = summary.teamRecords.find(record => record.id === 'adam');
		assert.equal(adamRecord.appearances, 2);
		assert.equal(adamRecord.wins, 1);
		assert.equal(adamRecord.losses, 1);
		assert.equal(adamRecord.winRate, 0.5);
		assert.equal(Math.abs(adamRecord.interval[0] - 0.0945286548) < 1e-10, true);
		assert.equal(Math.abs(adamRecord.interval[1] - 0.9054713452) < 1e-10, true);
		assert.deepEqual(summary.pokemonRecords.find(record => record.id === 'golem'), { id: 'golem', appearances: 2, wins: 1, losses: 1, winRate: 0.5, interval: adamRecord.interval });
		assert.equal(summary.moveRecords.find(record => record.id === 'earthquake').uses, 1);
		assert.equal(summary.moveRecords.find(record => record.id === 'earthquake').kos, 1);
		assert.equal(summary.teammatePairs.find(record => record.id === 'golem+inteleon').appearances, 2);
		assert.deepEqual(summary.variantRecords.find(record => record.id === 'adam-sun'), { id: 'adam-sun', appearances: 2, wins: 1, losses: 1, winRate: 0.5, interval: adamRecord.interval });
		assert.deepEqual(summary.cellRecords.find(record => record.id === 'adam-sun__connor-core'), { id: 'adam-sun__connor-core', appearances: 2, wins: 1, losses: 1, winRate: 0.5, interval: adamRecord.interval });
	});

	it('rejects historical or unidentified trials before aggregating outcomes', () => {
		const stale = [{ runtimeId: 'm0-full-information', pairId: 'legacy', side: 'forward', status: 'completed' }];
		assert.throws(() => aggregateCompletedPairedTrials(stale), /expected canonical runtime/);
		assert.throws(() => aggregateCompletedPairedTrials([{ ...stale[0], runtimeId: undefined }]), /expected canonical runtime/);
	});

	it('excludes a paired cell containing a legitimate tie from win/loss aggregation', () => {
		const trials = [
			{ runtimeId: CANONICAL_RUNTIME_ID, pairId: 'tie-pair', side: 'forward', status: 'completed', winnerTeamId: 'adam', p1: adam, p2: connor, protocol: '|win|Adam' },
			{ runtimeId: CANONICAL_RUNTIME_ID, pairId: 'tie-pair', side: 'reverse', status: 'tied', winnerTeamId: null, p1: connor, p2: adam, protocol: '|tie|' },
		];
		const summary = aggregateCompletedPairedTrials(trials);

		assert.equal(summary.completedPairCount, 0);
		assert.equal(summary.excludedTrialCount, 2);
		assert.equal(countTerminalPairs(trials), 1);
		assert.equal(countTerminalPairs(trials.slice(0, 1)), 0);
	});
});
