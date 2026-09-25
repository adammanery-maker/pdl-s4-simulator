'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { parseFixedMatchupArguments, summarizeFixedRecords } = require('../../../dist/pdl/cli/simulate-fixed-matchup');
const { privateBeliefFor } = require('../../../dist/pdl/fixed/scenario');

describe('fixed two-agent matchup CLI', () => {
	it('defaults native per-turn search to 5000ms', () => {
		const options = parseFixedMatchupArguments([
			'--scenario', '/tmp/scenario.json', '--repetitions', '10',
			'--foul-root', '/tmp/foul', '--output', '/tmp/output',
		]);

		assert.equal(options.searchTimeMs, 5000);
		assert.equal(options.timeoutMs, 15 * 60_000);
		assert.equal(options.repetitions, 10);
	});

	it('accepts a deeper explicit per-turn search budget', () => {
		const options = parseFixedMatchupArguments([
			'--scenario', '/tmp/scenario.json', '--repetitions', '10', '--search-time-ms', '30000',
			'--foul-root', '/tmp/foul', '--output', '/tmp/output',
		]);

		assert.equal(options.searchTimeMs, 30000);
	});

	it('keeps pinned public opponent candidates unchanged and overlays only own fixed Tera mapping', () => {
		const sets = { honchkrow: [{ weight: 3, ability: 'Moxie', item: 'Life Orb', nature: 'Jolly', evs: [0, 252, 0, 0, 4, 252], moves: ['Brave Bird', 'Sucker Punch', 'Roost', 'U-turn'], teraType: 'Water' }] };
		const scenario = {
			belief: { schemaVersion: 1, snapshot: { id: 'x', source: 'public', hash: 'x' }, sets, teams: {
				adam: { draftedTeraTypes: ['Grass', 'Ghost'], roster: [] },
				zander: { draftedTeraTypes: ['Dark', 'Water'], roster: [] },
			} },
			teams: [
				{ teamId: 'adam', teraCaptains: { scovillain: 'Fire', tatsugiri: 'Dragon' }, builds: [] },
				{ teamId: 'zander', teraCaptains: { weezing: 'Poison', honchkrow: 'Flying' }, builds: [] },
			],
		};

		const privateBelief = privateBeliefFor(scenario, 'adam');

		assert.deepEqual(privateBelief.sets, sets);
		assert.deepEqual(privateBelief.teams.adam.fixedTeraTypes, { scovillain: 'Fire', tatsugiri: 'Dragon' });
		assert.equal(privateBelief.teams.zander.fixedTeraTypes, undefined);
	});

	it('aggregates only complete clean forward/reverse pairs and retains ties', () => {
		const result = (status, winnerTeamId = null) => ({ status, winnerTeamId, failureReason: null });
		const records = [
			{ pairId: 'good', side: 'forward', matchupId: 'm', repetition: 1, result: result('completed', 'adam'), artifact: 'a', auditStatus: 'clean' },
			{ pairId: 'good', side: 'reverse', matchupId: 'm', repetition: 2, result: result('tied'), artifact: 'b', auditStatus: 'clean' },
			{ pairId: 'bad', side: 'forward', matchupId: 'm', repetition: 3, result: result('completed', 'zander'), artifact: 'c', auditStatus: 'clean' },
			{ pairId: 'bad', side: 'reverse', matchupId: 'm', repetition: 4, result: result('failed'), artifact: 'd', auditStatus: 'inconclusive' },
		];

		const summary = summarizeFixedRecords(records, ['adam', 'zander']);

		assert.equal(summary.completedPairIds.size, 1);
		assert.equal(summary.aggregatedTrials.length, 2);
		assert.deepEqual(summary.wins, { adam: 1, zander: 0 });
		assert.equal(summary.ties, 1);
		assert.equal(summary.incompletePairs.length, 1);
	});
});
