'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const {
	buildControlClientUrl,
	formatProcessExit,
	parseControlStart,
	renderControlPanelHtml,
	saveControlBotTeam,
} = require('../../../dist/pdl/cli/control-panel');

describe('PDL Foul Play control panel contract', () => {
	it('accepts a complete local bot launch and rejects unsafe or incomplete requests', () => {
		const start = parseControlStart({
			teamId: 'connor', opponentTeamId: 'adam', matches: 100,
			teamExport: 'Flygon @ Clear Amulet\nAbility: Levitate\n- Earthquake',
		});

		assert.equal(start.teamId, 'connor');
		assert.equal(start.opponentTeamId, 'adam');
		assert.equal(start.matches, 100);
		assert.throws(() => parseControlStart({ teamId: 'adam', opponentTeamId: 'adam', matches: 1, teamExport: 'x' }), /different/);
		assert.throws(() => parseControlStart({ teamId: 'adam', opponentTeamId: 'connor', matches: 0, teamExport: '' }), /matches/i);
	});

	it('opens the maintained rewrite client against the local Showdown port', () => {
		assert.equal(buildControlClientUrl(), 'https://play.pokemonshowdown.com/testclient-new.html?~~localhost:8000');
	});

	it('renders JavaScript that can update the initial loading status', () => {
		const html = renderControlPanelHtml();
		assert.match(html, /<\/b>\\n'\+s\.notice/);
		assert.doesNotMatch(html, /<\/b>\n'\+s\.notice/);
	});

	it('retains a bot startup failure after the managed bot reference is cleared', () => {
		assert.equal(
			formatProcessExit({ stdout: '', stderr: 'belief file missing' }),
			'Foul Play exited:\nbelief file missing',
		);
	});

	it('passes Foul Play a durable team file instead of a closed stdin stream', () => {
		const teamExport = 'Flygon @ Clear Amulet\nAbility: Levitate\n- Earthquake';
		const path = saveControlBotTeam(teamExport);
		assert.equal(readFileSync(path, 'utf8'), teamExport);
	});
});
