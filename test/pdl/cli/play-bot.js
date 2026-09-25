'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { buildHumanClientUrl, buildServerReadyPattern, parsePlayBotArguments, validatePlayBotTeam } = require('../../../dist/pdl/cli/play-bot');
const { normalizePdlSamplingSnapshot } = require('../../../dist/pdl/sampling/snapshot');

describe('PDL human-versus-bot command', () => {
	it('requires an exact bot team and derives a safe local session configuration', () => {
		const options = parsePlayBotArguments([
			'--team-id', 'adam', '--opponent-team-id', 'connor', '--team-file', '/Users/amanery/Downloads/Adam Sample Team.txt',
			'--foul-root', '/Users/amanery/PDL Vercel App/pdl-s4-foul-play',
		]);

		assert.equal(options.teamId, 'adam');
		assert.equal(options.opponentTeamId, 'connor');
		assert.equal(options.teamFile, '/Users/amanery/Downloads/Adam Sample Team.txt');
		assert.equal(options.port, 8000);
		assert.equal(options.searchTimeMs, 250);
		assert.match(options.outputDirectory, /^\/private\/tmp\/pdl-play-adam-/);
		assert.throws(() => parsePlayBotArguments(['--team-id', 'adam']), /opponent-team-id/);
		assert.throws(() => parsePlayBotArguments([
			'--team-id', 'adam', '--opponent-team-id', 'connor', '--team-file', '/tmp/team.txt', '--port', '0', '--foul-root', '/tmp/foul',
		]), /port/);
	});

	it('uses the official test client URL targeting the selected local server', () => {
		assert.equal(
			buildHumanClientUrl(8123),
			'https://play.pokemonshowdown.com/testclient.html?~~localhost:8123'
		);
	});

	it('matches the actual selected Showdown port instead of a template literal', () => {
		assert.equal(buildServerReadyPattern(8123).test('Worker 1 now listening on 0.0.0.0:8123'), true);
		assert.equal(buildServerReadyPattern(8123).test('Worker 1 now listening on 0.0.0.0:8000'), false);
	});

	it('rejects an exact bot team that includes a Pokémon outside its transaction-projected roster', () => {
		const snapshot = normalizePdlSamplingSnapshot({
			id: 'play-bot-fixture', sourceId: 'fixture:play-bot',
			roster: { teams: [{
				id: 'adam', name: 'Adam', draftedTeraTypes: ['Grass', 'Ghost'],
				roster: [
					{ species: 'Flamigo', cost: 11 }, { species: 'Tatsugiri', cost: 3 }, { species: 'Whimsicott', cost: 5 },
					{ species: 'Scovillain', cost: 3 }, { species: 'Golem', cost: 1 }, { species: 'Inteleon', cost: 7 },
				],
			}] },
			usageBySpecies: {},
		});
		const exportText = `Flamigo @ Choice Scarf\nAbility: Scrappy\nEVs: 252 Atk / 4 SpD / 252 Spe\nAdamant Nature\n- Close Combat\n- Brave Bird\n- U-turn\n- Upper Hand\n\nTatsugiri @ Heavy-Duty Boots\nAbility: Storm Drain\nEVs: 252 HP / 252 Def / 4 SpA\nQuiet Nature\n- Draco Meteor\n- Mirror Coat\n- Rapid Spin\n- Counter\n\nWhimsicott @ Heat Rock\nAbility: Prankster\nEVs: 252 HP / 252 Def / 4 SpD\nBold Nature\n- Moonblast\n- Encore\n- Memento\n- Sunny Day\n\nScovillain @ Life Orb\nAbility: Chlorophyll\nTera Type: Fire\nEVs: 252 SpA / 4 SpD / 252 Spe\nTimid Nature\n- Flamethrower\n- Growth\n- Overheat\n- Solar Beam\n\nGolem @ Leftovers\nAbility: Sturdy\nEVs: 252 HP / 252 Atk / 4 SpD\nAdamant Nature\n- Earthquake\n- Rock Blast\n- Stealth Rock\n- Explosion\n\nLeafeon @ Life Orb\nAbility: Chlorophyll\nEVs: 252 Atk / 4 SpD / 252 Spe\nAdamant Nature\n- Swords Dance\n- Knock Off\n- Solar Blade\n- Synthesis`;

		assert.throws(() => validatePlayBotTeam(snapshot, 'adam', exportText), /Leafeon is not on Adam's current roster/);
	});
});
