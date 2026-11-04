'use strict';

require('../../main');

const assert = require('node:assert/strict');
const {
	validateAblationDefinition,
	buildPairedSchedule,
	summarizePairedOutcomes,
	analyzeAblationProtocol,
	trustWarning,
	parseExploreAblationArguments,
	resolvePreset,
	assertAAReproducible,
} = require('../../../dist/pdl/ablation');

const baseTeam = `Pikachu @ Light Ball\nAbility: Static\nTera Type: Electric\nEVs: 4 HP / 252 SpA / 252 Spe\nTimid Nature\n- Thunderbolt\n- Volt Switch\n- Grass Knot\n- Surf\n\nCharizard @ Heavy-Duty Boots\nAbility: Blaze\nEVs: 252 SpA / 4 SpD / 252 Spe\nTimid Nature\n- Flamethrower\n- Air Slash\n- Roost\n- Will-O-Wisp\n`;
const candidateTeam = baseTeam.replace('- Surf', '- Protect');

describe('Phase 6 exploratory paired ablation', () => {
	it('accepts exactly the declared one-move change and rejects an undeclared item change', () => {
		const valid = validateAblationDefinition({
			baselineExported: baseTeam, candidateExported: candidateTeam,
			baselineTeraCaptains: ['Pikachu'], candidateTeraCaptains: ['Pikachu'],
			change: { type: 'move', species: 'Pikachu', from: 'Surf', to: 'Protect' },
		});
		assert.equal(valid.differences.length, 1);
		assert.equal(valid.differences[0].field, 'moves.3');

		assert.throws(() => validateAblationDefinition({
			baselineExported: baseTeam,
			candidateExported: candidateTeam.replace('Light Ball', 'Leftovers'),
			baselineTeraCaptains: ['Pikachu'], candidateTeraCaptains: ['Pikachu'],
			change: { type: 'move', species: 'Pikachu', from: 'Surf', to: 'Protect' },
		}), /exactly one declared difference/);
	});

	it('supports identity-only A/A and rejects identical teams as a real ablation', () => {
		assert.doesNotThrow(() => validateAblationDefinition({
			baselineExported: baseTeam, candidateExported: baseTeam,
			baselineTeraCaptains: ['Pikachu'], candidateTeraCaptains: ['Pikachu'],
			change: { type: 'identity' },
		}));
		assert.throws(() => validateAblationDefinition({
			baselineExported: baseTeam, candidateExported: baseTeam,
			baselineTeraCaptains: ['Pikachu'], candidateTeraCaptains: ['Pikachu'],
			change: { type: 'item', species: 'Pikachu', from: 'Light Ball', to: 'Leftovers' },
		}), /declared difference/);
	});

	it('rejects an unknown runtime change type instead of treating it as a field name', () => {
		assert.throws(() => validateAblationDefinition({
			baselineExported: baseTeam, candidateExported: candidateTeam,
			baselineTeraCaptains: ['Pikachu'], candidateTeraCaptains: ['Pikachu'],
			change: { type: 'arbitrary-json', species: 'Pikachu', from: 'Surf', to: 'Protect' },
		}), /Unsupported ablation change type/);
	});

	it('builds common-random-number pairs across builds and orientations', () => {
		const schedule = buildPairedSchedule({
			runId: 'demo', opponentBuildIds: ['steve-a', 'steve-b', 'steve-c'], seedsPerCell: 2,
		});
		assert.equal(schedule.length, 12);
		assert.deepEqual(new Set(schedule.map(row => row.orientation)), new Set(['forward', 'reverse']));
		for (const row of schedule) {
			assert.equal(row.baseline.battleSeed, row.candidate.battleSeed);
			assert.equal(row.baseline.searchSeed, row.candidate.searchSeed);
			assert.equal(row.baseline.beliefSeed, row.candidate.beliefSeed);
		}
		assert.deepEqual(schedule, buildPairedSchedule({ runId: 'demo', opponentBuildIds: ['steve-a', 'steve-b', 'steve-c'], seedsPerCell: 2 }));
	});

	it('reports paired discordance, exact McNemar probability, and breakdowns', () => {
		const summary = summarizePairedOutcomes([
			{ opponentBuildId: 'a', orientation: 'forward', baselineWon: true, candidateWon: true },
			{ opponentBuildId: 'a', orientation: 'reverse', baselineWon: true, candidateWon: false },
			{ opponentBuildId: 'b', orientation: 'forward', baselineWon: false, candidateWon: true },
			{ opponentBuildId: 'b', orientation: 'reverse', baselineWon: false, candidateWon: true },
		], 'fixed');
		assert.deepEqual(summary.paired, { bothWin: 1, bothLose: 0, baselineOnlyWin: 1, candidateOnlyWin: 2, netDiscordantAdvantage: 1 });
		assert.equal(summary.baselineWins, 2);
		assert.equal(summary.candidateWins, 3);
		assert.equal(summary.mcnemar.exactTwoSidedP, 1);
		assert.equal(summary.byOrientation.forward.pairs, 2);
	});

	it('extracts strategic metrics and review candidates from a public protocol', () => {
		const protocol = [
			'|turn|1', '|switch|p1a: Whimsicott|Whimsicott, L50|100/100',
			'|move|p1a: Whimsicott|Sunny Day|p1a: Whimsicott',
			'|turn|2', '|move|p1a: Whimsicott|Memento|p2a: Grimmsnarl',
			'|switch|p1a: Drednaw|Drednaw, L50|100/100',
			'|turn|3', '|move|p1a: Drednaw|Shell Smash|p1a: Drednaw',
			'|turn|4', '|move|p1a: Drednaw|Liquidation|p2a: Grimmsnarl',
			'|faint|p2a: Grimmsnarl', '|-terastallize|p1a: Drednaw|Water',
		].join('\n');
		const result = analyzeAblationProtocol(protocol, 'p1');
		assert.equal(result.generic.turns, 4);
		assert.equal(result.generic.teraCount, 1);
		assert.equal(result.setup.sunnyDayAttempts, 1);
		assert.equal(result.setup.mementoToDrednawToShellSmash, 1);
		assert.equal(result.setup.firstBoostedAttack, 1);
		assert.equal(result.setup.postSetupKos, 1);
	});

	it('prints a prominent warning whenever a declared domain is red', () => {
		assert.match(trustWarning(['team-preview', 'ordinary-attacks'], {
			'team-preview': { status: 'RED', evidence: 'not independently adjudicated' },
			'ordinary-attacks': { status: 'GREEN', evidence: 'conformant' },
		}), /EXPLORATORY ONLY/);
	});

	it('uses explicit screen and confirm sizes and requires a manifest, Foul root, and output', () => {
		assert.deepEqual(resolvePreset('screen'), { seedsPerCell: 10, purpose: 'directional-screen' });
		assert.deepEqual(resolvePreset('screen-20'), { seedsPerCell: 20, purpose: 'directional-screen' });
		assert.deepEqual(resolvePreset('confirm'), { seedsPerCell: 40, purpose: 'promotion-confirmation' });
		const options = parseExploreAblationArguments([
			'--manifest', '/tmp/a.json', '--preset', 'screen', '--foul-root', '/tmp/foul', '--output', '/tmp/out',
			'--decision-budget-ms', '100', '--dry-run', 'true',
		]);
		assert.equal(options.preset, 'screen');
		assert.equal(options.dryRun, true);
		assert.equal(options.maxPairs, null);
		assert.throws(() => parseExploreAblationArguments(['--preset', 'screen']), /manifest/);
	});

	it('treats any A/A result or decision digest divergence as a blocker', () => {
		assert.doesNotThrow(() => assertAAReproducible([
			{ pairId: 'x', baseline: { resultDigest: 'a', decisionDigest: 'b' }, candidate: { resultDigest: 'a', decisionDigest: 'b' } },
		]));
		assert.throws(() => assertAAReproducible([
			{ pairId: 'x', baseline: { resultDigest: 'a', decisionDigest: 'b' }, candidate: { resultDigest: 'a', decisionDigest: 'c' } },
		]), /A\/A reproducibility blocker/);
	});
});
