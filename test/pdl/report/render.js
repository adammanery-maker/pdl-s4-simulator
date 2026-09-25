'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { renderSimulationReport } = require('../../../dist/pdl/report/render');

describe('PDL simulation report rendering', () => {
	it('renders auditable tables for every requested local statistic', () => {
		const html = renderSimulationReport({
			metadata: { snapshotHash: 'abc123', completedTrials: 2, rejectedTrials: 0, failedTrials: 0, timedOutTrials: 0 },
			analysis: {
				completedPairCount: 1, excludedTrialCount: 0,
				teamRecords: [{ id: 'adam', appearances: 2, wins: 1, losses: 1, winRate: 0.5, interval: [0.1, 0.9] }],
				pokemonRecords: [{ id: 'golem', appearances: 2, wins: 1, losses: 1, winRate: 0.5, interval: [0.1, 0.9] }],
				setRecords: [{ id: 'golem|sturdy|leftovers|adamant||0|252|0|0|4|252|earthquake|protect|substitute|stealthrock', appearances: 2, wins: 1, losses: 1, winRate: 0.5, interval: [0.1, 0.9] }],
				moveRecords: [{ id: 'earthquake', appearances: 1, wins: 1, losses: 0, winRate: 1, interval: [0.2, 1], uses: 1, kos: 1, damagePercent: 100 }],
				teammatePairs: [{ id: 'golem+inteleon', appearances: 2, wins: 1, losses: 1, winRate: 0.5, interval: [0.1, 0.9] }],
				leadRecords: [{ id: 'golem', appearances: 1, wins: 1, losses: 0, winRate: 1, interval: [0.2, 1] }],
				teraRecords: [{ id: 'golem:rock', appearances: 1, wins: 1, losses: 0, winRate: 1, interval: [0.2, 1] }],
				variantRecords: [{ id: 'adam-sun', appearances: 2, wins: 1, losses: 1, winRate: 0.5, interval: [0.1, 0.9] }],
				cellRecords: [{ id: 'adam-sun__connor-core', appearances: 2, wins: 1, losses: 1, winRate: 0.5, interval: [0.1, 0.9] }],
			},
		});

		for (const heading of ['Team records', 'Variant records', 'Cross-matchup cells', 'Pokémon records', 'Exact builds', 'Moves', 'Teammate pairs', 'Leads', 'Tera uses']) {
			assert.match(html, new RegExp(heading));
		}
		assert.match(html, /Descriptive simulation association/);
		assert.match(html, /Golem @ Leftovers/);
	});

	it('renders resolved roster and left-perspective context for experiment scenarios', () => {
		const empty = [];
		const html = renderSimulationReport({
			metadata: {
				snapshotHash: 'abc', completedTrials: 2, rejectedTrials: 0, failedTrials: 0, timedOutTrials: 0,
				experiment: {
					leftTeamId: 'connor', rightTeamId: 'adam', totalPairs: 1,
					leftVariants: [{ id: 'connor-core', teamId: 'connor', species: ['Flygon', 'Ribombee'] }],
					rightVariants: [{ id: 'adam-sun', teamId: 'adam', species: ['Flamigo', 'Tatsugiri'] }],
				},
			},
			analysis: {
				completedPairCount: 1, excludedTrialCount: 0, teamRecords: empty, pokemonRecords: empty, setRecords: empty,
				moveRecords: empty, teammatePairs: empty, leadRecords: empty, teraRecords: empty,
				variantRecords: [{ id: 'connor-core', appearances: 2, wins: 2, losses: 0, winRate: 1, interval: [0.3, 1] }],
				cellRecords: [{ id: 'connor-core__adam-sun', appearances: 2, wins: 2, losses: 0, winRate: 1, interval: [0.3, 1] }],
			},
		});
		assert.match(html, /Roster variant results/);
		assert.match(html, /Flygon · Ribombee/);
		assert.match(html, /Cross-matchup results/);
		assert.match(html, /left team’s perspective/);
	});
});
