'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { formatProgressLine, parseMatchupArguments } = require('../../../dist/pdl/cli/simulate-matchup');

describe('PDL local simulation command', () => {
	it('requires an explicit frozen data source and creates side-balanced pair settings', () => {
		const options = parseMatchupArguments([
			'--live-url', 'https://pdl-s4.vercel.app/api/roster-transactions',
			'--team-a', 'adam', '--team-b', 'connor', '--battles', '25',
			'--search-ms', '100', '--foul-root', '/tmp/foul-play', '--output', '/tmp/results',
		]);

		assert.equal(options.liveUrl, 'https://pdl-s4.vercel.app/api/roster-transactions');
		assert.equal(options.teamA, 'adam');
		assert.equal(options.teamB, 'connor');
		assert.equal(options.pairs, 25);
		assert.equal(options.beliefSamples, 8);
		assert.equal(options.timeoutMs, 120000);
		assert.throws(() => parseMatchupArguments(['--team-a', 'adam']), /exactly one/i);
	});

	it('formats a useful terminal progress line with outcome counts and ETA', () => {
		assert.equal(formatProgressLine({
			completed: 42, total: 200, winnerTeamId: 'adam', status: 'completed',
			tied: 0, rejected: 0, failed: 2, timedOut: 1, etaMs: 18 * 60_000,
		}), '[42/200] completed — Adam won — 0 tied — 0 rejected — 2 failed — 1 timed out — ETA 18m');
	});

	it('parses inline required, excluded, and repeated locked-build constraints', () => {
		const options = parseMatchupArguments([
			'--live-url', 'https://pdl-s4.vercel.app/api/roster-transactions',
			'--team-a', 'adam', '--team-b', 'connor', '--battles', '1', '--search-ms', '50',
			'--foul-root', '/tmp/foul-play', '--output', '/tmp/results',
			'--require-a', 'golem,tatsugiri', '--exclude-a', 'scovillain',
			'--lock-a', 'Golem|Custap Berry|Sturdy|Adamant|4,252,0,0,0,252|Explosion,Earthquake,Stealth Rock,Rock Blast|Rock',
			'--lock-b', 'Flygon|Loaded Dice|Levitate|Jolly|0,252,0,0,4,252|Earthquake,Dragon Dance,Scale Shot,U-turn|',
		]);

		assert.deepEqual(options.constraintsA.requiredSpecies, ['golem', 'tatsugiri']);
		assert.deepEqual(options.constraintsA.excludedSpecies, ['scovillain']);
		assert.equal(options.constraintsA.lockedSets[0].species, 'Golem');
		assert.equal(options.constraintsB.lockedSets[0].teraType, '');
	});

	it('accepts an explicit belief-world count for the canonical runtime', () => {
		const options = parseMatchupArguments([
			'--snapshot', '/tmp/frozen-roster.json', '--team-a', 'adam', '--team-b', 'connor',
			'--battles', '1', '--search-ms', '50', '--belief-samples', '4',
			'--foul-root', '/tmp/foul-play', '--output', '/tmp/results',
		]);
		assert.equal(options.beliefSamples, 4);
	});
});
