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
	getSampleTeam,
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

	it('formats cloud deployment client URLs for Fly.io, Railway, and Render', () => {
		const oldFly = process.env.FLY_APP_NAME;
		const oldRailway = process.env.RAILWAY_PUBLIC_DOMAIN;
		const oldPublic = process.env.PUBLIC_URL;
		try {
			process.env.FLY_APP_NAME = 'my-pdl-bot';
			assert.equal(buildControlClientUrl(), 'https://play.pokemonshowdown.com/testclient-new.html?~~my-pdl-bot.fly.dev');
			delete process.env.FLY_APP_NAME;

			process.env.RAILWAY_PUBLIC_DOMAIN = 'pdl-production.up.railway.app';
			assert.equal(buildControlClientUrl(), 'https://play.pokemonshowdown.com/testclient-new.html?~~pdl-production.up.railway.app');
			delete process.env.RAILWAY_PUBLIC_DOMAIN;

			process.env.PUBLIC_URL = 'https://custom-bot.example.com/';
			assert.equal(buildControlClientUrl(), 'https://play.pokemonshowdown.com/testclient-new.html?~~custom-bot.example.com');
		} finally {
			if (oldFly !== undefined) process.env.FLY_APP_NAME = oldFly; else delete process.env.FLY_APP_NAME;
			if (oldRailway !== undefined) process.env.RAILWAY_PUBLIC_DOMAIN = oldRailway; else delete process.env.RAILWAY_PUBLIC_DOMAIN;
			if (oldPublic !== undefined) process.env.PUBLIC_URL = oldPublic; else delete process.env.PUBLIC_URL;
		}
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

	it('resolves bundled sample teams and rejects unknown teams', () => {
		for (const coach of ['adam', 'connor', 'steve', 'jon', 'greg', 'jordan', 'zander', 'nick']) {
			const team = getSampleTeam(coach);
			assert(team && team.length > 0, `Missing sample team for ${coach}`);
		}
		const adamTeam = getSampleTeam('adam');
		assert.match(adamTeam, /Whimsicott|Flamigo/);
		const adamVar2 = getSampleTeam('adam', 2);
		assert.match(adamVar2, /Incineroar|Magneton|Flamigo/);
		const connorTeam = getSampleTeam('connor');
		assert.match(connorTeam, /Ribombee|Heracross/);
		const nickTeam = getSampleTeam('nick');
		assert.match(nickTeam, /Flygon/);
		assert.throws(() => getSampleTeam('nonexistent_coach'), /No saved sample file/);
	});
});
