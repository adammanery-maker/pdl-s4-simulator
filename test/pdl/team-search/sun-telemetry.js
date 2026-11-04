'use strict';

const assert = require('assert').strict;
const { analyzeSunStrategy } = require('../../../dist/pdl/team-search/sun-telemetry');

const completed = winnerTeamId => ({ status: 'completed', winnerTeamId, failureReason: null });
const team = (setter = 'heatrock') => [
	{ species: 'Whimsicott', item: setter, moves: ['Sunny Day', 'Memento', 'Encore', 'Moonblast'] },
	{ species: 'Uxie', item: 'Eject Button', moves: ['Sunny Day', 'Memento', 'Stealth Rock', 'U-turn'] },
	{ species: 'Scovillain', item: 'Life Orb', moves: ['Growth', 'Fire Blast', 'Solar Beam', 'Crunch'] },
];
const bundle = value => `${JSON.stringify(value)}\n`;
const observedBundle = (turn, selectedAction = 'growth', weatherTurns = 5) => bundle({
	activeSpecies: 'scovillain', decisionOrdinal: turn + 10, requestType: 'move', selectedAction,
	observation: JSON.stringify({
		battle: { turn, weather: 'sunnyday', weather_turns_remaining: weatherTurns },
		user: { active: { $pokemon: { name: 'scovillain', moves: [{ $move: { name: 'growth', current_pp: 8, disabled: false } }] } } },
	}),
});
const evidence = value => `INFO PDL_DECISION_EVIDENCE ${JSON.stringify(value)}\n`;

describe('Sun strategy telemetry', () => {
	it('tracks Heat Rock Sun, direct Memento replacement, growth, damage, Tera, KO, and simultaneous switches', () => {
		const protocol = [
			'|turn|1',
			'|move|p1a: Whimsicott|Sunny Day|p1a: Whimsicott',
			'|-weather|SunnyDay|[from] move: Sunny Day|[of] p1a: Whimsicott',
			'|upkeep',
			'|turn|2',
			'|move|p1a: Whimsicott|Memento|p2a: Goodra',
			'|faint|p1a: Whimsicott',
			'|switch|p1a: Scovillain|Scovillain, M|200/271',
			'|switch|p2a: Avalugg|Avalugg-Hisui, M|100/100',
			'|-terastallize|p1a: Scovillain|Fire',
			'|move|p1a: Scovillain|Growth|p1a: Scovillain',
			'|upkeep',
			'|turn|3',
			'|move|p1a: Scovillain|Fire Blast|p2a: Avalugg',
			'|-damage|p2a: Avalugg|0 fnt',
			'|faint|p2a: Avalugg',
			'|win|adam',
		].join('\n');
		const result = analyzeSunStrategy({
			protocol, decisionBundles: observedBundle(2, 'growth', 5),
			decisionEvidenceLog: evidence({ activeSpecies: 'scovillain', turn: 2, decisionOrdinal: 12, legalSearchActions: ['growth', 'fireblast'] }),
			adamSide: 'p1', ownTeam: team(), result: completed('adam'),
		});
		assert.equal(result.sunOccurred, true);
		assert.equal(result.firstSunTurn, 1);
		assert.equal(result.firstSunSetter, 'whimsicott');
		assert.deepEqual(result.scovillainEntries[0], {
			turn: 2,
			hp: { current: 200, max: 271, fraction: 200 / 271, raw: '200/271' },
			opponentActive: 'avalugghisui',
			sunActive: true,
			sunTurnsRemaining: {
				min: 7, max: 7, exact: 7, source: 'known-own-item', searchReported: 5, searchReportedTurn: 2,
				searchMismatch: true,
			},
			precededByWhimsicottMemento: true,
			mementoTurn: 2,
		});
		assert.deepEqual(result.growth, {
			opportunities: 1, selections: 1, executions: 1, opportunitySource: 'decision-evidence', caveat: null,
			events: [
				{ kind: 'execution', turn: 2, decisionOrdinal: null },
				{ kind: 'opportunity', turn: 2, decisionOrdinal: 12 },
				{ kind: 'selection', turn: 2, decisionOrdinal: 12 },
			],
		});
		assert.deepEqual(result.attacksUnderSun, [{ turn: 3, move: 'fireblast', target: 'avalugg', successfulDamage: true }]);
		assert.deepEqual(result.kosUnderSun, [{ turn: 3, target: 'avalugg', move: 'fireblast' }]);
		assert.deepEqual(result.tera, [{ turn: 2, species: 'scovillain', type: 'fire', scovillain: true }]);
		assert.equal(result.outcome, 'win');
	});

	it('does not count a failed Sunny Day attempt and uses observed move state only as a caveated fallback', () => {
		const result = analyzeSunStrategy({
			protocol: '|turn|1\n|move|p1a: Whimsicott|Sunny Day|p1a: Whimsicott|[still]\n|-fail|p1a: Whimsicott',
			decisionBundles: observedBundle(1), adamSide: 'p1', ownTeam: team(), result: completed('steve'),
		});
		assert.equal(result.sunOccurred, false);
		assert.equal(result.growth.opportunities, 1);
		assert.equal(result.growth.opportunitySource, 'decision-bundle-observation');
		assert.match(result.growth.caveat, /transient request restrictions/);
		assert.equal(result.outcome, 'loss');
	});

	it('treats zero legal Growth actions in decision evidence as known zero instead of falling back', () => {
		const result = analyzeSunStrategy({
			protocol: '|turn|1', decisionBundles: observedBundle(1),
			decisionEvidenceLog: evidence({
				activeSpecies: 'scovillain', turn: 1, decisionOrdinal: 11, legalSearchActions: ['fireblast', 'switch uxie'],
			}),
			adamSide: 'p1', ownTeam: team(), result: completed('adam'),
		});
		assert.equal(result.growth.opportunities, 0);
		assert.equal(result.growth.opportunitySource, 'decision-evidence');
		assert.equal(result.growth.caveat, null);
	});

	it('derives five turns from a known non-Heat-Rock setter and ranges a hidden opposing item', () => {
		const own = analyzeSunStrategy({
			protocol: '|turn|4\n|move|p2a: Uxie|Sunny Day|p2a: Uxie\n|-weather|SunnyDay|[from] move: Sunny Day|[of] p2a: Uxie\n|switch|p2a: Scovillain|Scovillain|271/271',
			decisionBundles: '', adamSide: 'p2', ownTeam: team(), result: completed('adam'),
		});
		assert.equal(own.scovillainEntries[0].sunTurnsRemaining.exact, 5);
		assert.equal(own.scovillainEntries[0].sunTurnsRemaining.source, 'known-own-item');

		const opposing = analyzeSunStrategy({
			protocol: '|turn|4\n|-weather|SunnyDay|[from] ability: Drought|[of] p2a: Torkoal\n|switch|p1a: Scovillain|Scovillain|271/271',
			decisionBundles: '', adamSide: 'p1', ownTeam: team(), result: completed('adam'),
		});
		assert.equal(opposing.firstSunSetter, 'torkoal');
		assert.deepEqual(opposing.scovillainEntries[0].sunTurnsRemaining, {
			min: 5, max: 8, exact: null, source: 'unknown-public-item', searchReported: null, searchReportedTurn: null,
			searchMismatch: null,
		});
	});

	it('uses public item removal before weather and does not chain a failed Memento into an opponent KO', () => {
		const result = analyzeSunStrategy({
			protocol: [
				'|switch|p1a: Whimsicott|Whimsicott|319/319',
				'|-enditem|p1a: Whimsicott|Heat Rock|[from] move: Knock Off',
				'|turn|1', '|move|p1a: Whimsicott|Sunny Day|p1a: Whimsicott', '|-weather|SunnyDay',
				'|move|p1a: Whimsicott|Memento|p2a: Goodra', '|-immune|p2a: Goodra',
				'|move|p2a: Goodra|Sludge Bomb|p1a: Whimsicott', '|-damage|p1a: Whimsicott|0 fnt',
				'|faint|p1a: Whimsicott', '|switch|p1a: Scovillain|Scovillain|271/271',
			].join('\n'),
			decisionBundles: '', adamSide: 'p1', ownTeam: team(), result: completed('steve'),
		});
		assert.equal(result.scovillainEntries[0].sunTurnsRemaining.exact, 5);
		assert.equal(result.scovillainEntries[0].precededByWhimsicottMemento, false);
	});

	it('keeps a completed Memento chain through the opponent remaining action', () => {
		const result = analyzeSunStrategy({
			protocol: [
				'|turn|2', '|-weather|SunnyDay|[from] ability: Drought|[of] p2a: Torkoal',
				'|move|p1a: Whimsicott|Memento|p2a: Torkoal', '|faint|p1a: Whimsicott',
				'|move|p2a: Torkoal|Flamethrower|p1a: Whimsicott', '|-fail|p2a: Torkoal',
				'|upkeep', '|switch|p1a: Scovillain|Scovillain|271/271',
			].join('\n'),
			decisionBundles: '', adamSide: 'p1', ownTeam: team(), result: completed('adam'),
		});
		assert.equal(result.scovillainEntries[0].precededByWhimsicottMemento, true);
		assert.equal(result.scovillainEntries[0].mementoTurn, 2);
	});

	it('compares a later first search timer at that turn and never borrows a later entry decision', () => {
		const protocol = [
			'|turn|1', '|move|p1a: Uxie|Sunny Day|p1a: Uxie', '|-weather|SunnyDay',
			'|switch|p1a: Scovillain|Scovillain|271/271', '|upkeep', '|turn|2',
			'|move|p1a: Scovillain|Growth|p1a: Scovillain',
			'|switch|p1a: Uxie|Uxie|300/300', '|upkeep', '|turn|3',
		].join('\n');
		const result = analyzeSunStrategy({
			protocol, decisionBundles: observedBundle(2, 'growth', 4),
			adamSide: 'p1', ownTeam: team(), result: completed('adam'),
		});
		assert.equal(result.scovillainEntries[0].sunTurnsRemaining.exact, 5);
		assert.equal(result.scovillainEntries[0].sunTurnsRemaining.searchMismatch, false);
		const absent = analyzeSunStrategy({
			protocol, decisionBundles: observedBundle(4, 'growth', 2),
			adamSide: 'p1', ownTeam: team(), result: completed('adam'),
		});
		assert.equal(absent.scovillainEntries[0].sunTurnsRemaining.searchReported, null);
	});

	it('requires a direct Whimsicott Memento replacement and active Sun', () => {
		const result = analyzeSunStrategy({
			protocol: [
				'|turn|1', '|-weather|SunnyDay|[from] ability: Drought|[of] p2a: Torkoal',
				'|move|p1a: Whimsicott|Memento|p2a: Torkoal', '|faint|p1a: Whimsicott',
				'|switch|p1a: Uxie|Uxie|300/300', '|upkeep', '|turn|2',
				'|switch|p1a: Scovillain|Scovillain|271/271',
			].join('\n'),
			decisionBundles: '', adamSide: 'p1', ownTeam: team(), result: completed('steve'),
		});
		assert.equal(result.scovillainEntries[0].precededByWhimsicottMemento, false);
	});

	it('does not credit misses, residual damage, delayed attacks, or attacks after Sun ends as Sun KOs', () => {
		const result = analyzeSunStrategy({
			protocol: [
				'|turn|1', '|-weather|SunnyDay|[from] ability: Drought|[of] p2a: Torkoal',
				'|move|p1a: Scovillain|Fire Blast|p2a: Goodra', '|-miss|p1a: Scovillain|p2a: Goodra',
				'|move|p1a: Scovillain|Crunch|p2a: Goodra', '|-damage|p2a: Goodra|10/100',
				'|-damage|p2a: Goodra|0 fnt|[from] psn', '|faint|p2a: Goodra',
				'|move|p1a: Scovillain|Future Sight|p2a: Torkoal',
				'|-weather|none', '|move|p1a: Scovillain|Solar Beam|p2a: Torkoal', '|-damage|p2a: Torkoal|0 fnt', '|faint|p2a: Torkoal',
			].join('\n'),
			decisionBundles: '', adamSide: 'p1', ownTeam: team(), result: { status: 'failed', winnerTeamId: null, failureReason: 'fixture' },
		});
		assert.deepEqual(result.attacksUnderSun, [
			{ turn: 1, move: 'fireblast', target: 'goodra', successfulDamage: false },
			{ turn: 1, move: 'crunch', target: 'goodra', successfulDamage: true },
		]);
		assert.deepEqual(result.kosUnderSun, []);
		assert.equal(result.outcome, 'incomplete');
	});
});
