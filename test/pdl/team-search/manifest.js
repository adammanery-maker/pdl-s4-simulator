'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {loadTeamSearchManifest, teamSearchCounts, sharedCellSeeds, privateTeamSearchBelief, legalTeamSearchTeraTypes} = require('../../../dist/pdl/team-search');
const realManifest = path.resolve(__dirname, '../../../pdl/team-search/runs/adam-vs-steve-initial.json');

describe('Generic team-search manifest', () => {
	it('resolves exact supplied 4 by 4 schedule and all preset sizes', () => {
		const manifest = loadTeamSearchManifest(realManifest);
		assert.equal(manifest.adamCandidates.length, 4);
		assert.equal(manifest.steveOpponents.length, 4);
		assert.deepEqual(teamSearchCounts(manifest, 'quick'), {adamCandidates: 4, steveOpponents: 4, orientations: 2, seedsPerCell: 3, battlesPerAdamCandidate: 24, totalBattles: 96});
		assert.deepEqual(teamSearchCounts(manifest, 'screen-5'), {adamCandidates: 4, steveOpponents: 4, orientations: 2, seedsPerCell: 5, battlesPerAdamCandidate: 40, totalBattles: 160});
		assert.equal(teamSearchCounts(manifest, 'screen').totalBattles, 320);
		assert.equal(teamSearchCounts(manifest, 'screen-20').totalBattles, 640);
		assert.equal(teamSearchCounts(manifest, 'confirm').totalBattles, 1280);
		assert.equal(teamSearchCounts({...manifest, adamCandidates: Array(40).fill(manifest.adamCandidates[0]), steveOpponents: Array(5).fill(manifest.steveOpponents[0])}, 'quick').totalBattles, 1200);
	});
	it('uses opponent cell streams independent of the Adam candidate', () => {
		const streams = sharedCellSeeds('run', 'arbitrary-opponent', 'reverse', 2);
		assert.deepEqual(streams, sharedCellSeeds('run', 'arbitrary-opponent', 'reverse', 2));
		assert.notDeepEqual(streams, sharedCellSeeds('run', 'arbitrary-opponent', 'forward', 2));
		assert.notDeepEqual(streams, sharedCellSeeds('run', 'different-opponent', 'reverse', 2));
	});
	it('derives captain eligibility from league, including a six with no eligible captain', () => {
		const manifest = loadTeamSearchManifest(realManifest);
		assert.deepEqual(manifest.adamCandidates.map(t => t.teraCaptains), [['tatsugiri'], ['tatsugiri'], ['scovillain'], []]);
		assert.deepEqual(new Set(legalTeamSearchTeraTypes(manifest.league.adam, 'Tatsugiri')), new Set(['Grass', 'Ghost', 'Dragon', 'Water']));
		assert.deepEqual(legalTeamSearchTeraTypes(manifest.league.adam, 'Drednaw'), []);
		assert.deepEqual(new Set(legalTeamSearchTeraTypes(manifest.league.steve, 'Avalugg-Hisui')), new Set(['Fighting', 'Fire', 'Ice', 'Rock']));
		assert.deepEqual(new Set(legalTeamSearchTeraTypes(manifest.league.steve, 'Drifblim')), new Set(['Fighting', 'Fire', 'Ghost', 'Flying']));
	});
	it('returns the same opponent priors independent of selected teams and clones own state', () => {
		const manifest = loadTeamSearchManifest(realManifest);
		const first = privateTeamSearchBelief(manifest, 'adam', manifest.adamCandidates[0]);
		const fourth = privateTeamSearchBelief(manifest, 'adam', manifest.adamCandidates[3]);
		assert.deepEqual(first.teams.steve, fourth.teams.steve);
		assert.deepEqual(first.sets, fourth.sets);
		assert.deepEqual(fourth.teams.adam.fixedTeraTypes, {});
		assert.deepEqual(fourth.teams.adam.teraCaptains.map(s => s.toLowerCase()), ['tatsugiri', 'scovillain']);
		first.sets.tatsugiri[0].moves[0] = 'PRIVATE-MUTATION';
		assert.notDeepEqual(first.sets, manifest.belief.sets);
	});
	it('validates the corrected eight teams and still rejects local banned items and moves', () => {
		const manifest = loadTeamSearchManifest(realManifest);
		assert.deepEqual(manifest.validationErrors, []);
		const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-illegal-team-fixture-'));
		try {
			const raw = JSON.parse(fs.readFileSync(realManifest, 'utf8'));
			const base = path.dirname(realManifest);
			raw.beliefPath = path.resolve(base, raw.beliefPath);
			for (const t of raw.adamCandidates) t.teamPath = path.resolve(base, t.teamPath);
			for (const [index, t] of raw.steveOpponents.entries()) {
				let text = fs.readFileSync(path.resolve(base, t.teamPath), 'utf8');
				if (index < 3) {
					text = text.replace(/(Slowbro-Galar[\s\S]*?)- Psyshock/, '$1- Psychic Noise');
				}
				if (index === 0) text = text.replace('Grimmsnarl @ Leftovers', 'Grimmsnarl @ Light Clay');
				if (index === 3) text = text.replace('Grimmsnarl @ Heavy-Duty Boots', 'Grimmsnarl @ Light Clay');
				t.teamPath = path.join(temporary, t.id + '.txt');
				fs.writeFileSync(t.teamPath, text);
				delete t.teamHash;
			}
			const manifestPath = path.join(temporary, 'manifest.json');
			fs.writeFileSync(manifestPath, JSON.stringify(raw));
			const rejected = loadTeamSearchManifest(manifestPath);
			assert.equal(rejected.validationErrors.length, 5);
			assert.equal(rejected.validationErrors.filter(e => e.includes('Light Clay')).length, 2);
			assert.equal(rejected.validationErrors.filter(e => e.includes('Psychic Noise')).length, 3);
		} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
	});
	it('rejects normalized hash drift and does not grant Tera from a noncaptain annotation', () => {
		const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-team-search-manifest-'));
		try {
			const raw = JSON.parse(fs.readFileSync(realManifest, 'utf8'));
			const base = path.dirname(realManifest);
			raw.beliefPath = path.resolve(base, raw.beliefPath);
			for (const group of [raw.adamCandidates, raw.steveOpponents]) for (const t of group) t.teamPath = path.resolve(base, t.teamPath);
			const exportPath = path.join(temporary, 'annotated.txt');
			fs.writeFileSync(exportPath, fs.readFileSync(raw.adamCandidates[3].teamPath, 'utf8').replace('Drednaw @ White Herb', 'Drednaw @ White Herb\nTera Type: Water'));
			raw.adamCandidates[3].teamPath = exportPath;
			delete raw.adamCandidates[3].teamHash;
			const changedPath = path.join(temporary, 'manifest.json');
			fs.writeFileSync(changedPath, JSON.stringify(raw));
			const loaded = loadTeamSearchManifest(changedPath);
			assert.deepEqual(loaded.adamCandidates[3].teraCaptains, []);
			assert(!loaded.adamCandidates[3].exported.includes('Tera Type:'));
			raw.adamCandidates[3].teamHash = 'bad';
			fs.writeFileSync(changedPath, JSON.stringify(raw));
			assert.throws(() => loadTeamSearchManifest(changedPath), /teamHash/);
		} finally { fs.rmSync(temporary, {recursive: true, force: true}); }
	});
});
