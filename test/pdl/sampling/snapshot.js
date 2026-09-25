'use strict';

const assert = require('node:assert/strict');
const {
	normalizePdlSamplingSnapshot,
	hashSamplingSnapshot,
} = require('../../../dist/pdl/sampling/snapshot');

const fixture = {
	id: 'pdl-s4-2026-08-11',
	sourceId: 'redis:league:s4:2026-08-11',
	roster: {
		teams: [{
			id: 'Adam',
			name: 'Adam',
			draftedTeraTypes: ['Grass', 'Ghost'],
			roster: [
				{ species: 'Tatsugiri', cost: 4 },
				{ species: 'Rotom-Wash', cost: 4 },
			],
		}],
	},
	usageBySpecies: {
		Tatsugiri: {
			moves: [{ name: 'Draco Meteor', weight: 62.5 }],
			abilities: [{ name: 'Storm Drain', weight: 100 }],
			items: [{ name: 'Choice Specs', weight: 54.2 }],
		},
	},
};

describe('PDL sampling snapshots', () => {
	it('normalizes Showdown IDs while retaining source identifiers and usage labels', () => {
		const snapshot = normalizePdlSamplingSnapshot(fixture);

		assert.equal(snapshot.id, 'pdl-s4-2026-08-11');
		assert.equal(snapshot.sourceId, 'redis:league:s4:2026-08-11');
		assert.equal(snapshot.roster.teams[0].id, 'adam');
		assert.equal(snapshot.roster.teams[0].roster[1].species, 'rotomwash');
		assert.deepEqual(snapshot.roster.teams[0].draftedTeraTypes, ['grass', 'ghost']);
		assert.equal(snapshot.usageBySpecies.tatsugiri.moves[0].name, 'Draco Meteor');
	});

	it('hashes an equivalent snapshot deterministically from canonical JSON', () => {
		const snapshot = normalizePdlSamplingSnapshot(fixture);
		const reorderedSnapshot = normalizePdlSamplingSnapshot({
			usageBySpecies: fixture.usageBySpecies,
			roster: fixture.roster,
			sourceId: fixture.sourceId,
			id: fixture.id,
		});
		const nestedKeyReorderedSnapshot = normalizePdlSamplingSnapshot({
			usageBySpecies: {
				Tatsugiri: {
					moves: [{ weight: 62.5, name: 'Draco Meteor' }],
					abilities: [{ weight: 100, name: 'Storm Drain' }],
					items: [{ weight: 54.2, name: 'Choice Specs' }],
				},
			},
			roster: fixture.roster,
			sourceId: fixture.sourceId,
			id: fixture.id,
		});

		const expectedHash = 'ac0827cde898e095209ee1d9aaa70461d2da76e9dad72ce0646f7564e6068c13';
		assert.equal(hashSamplingSnapshot(snapshot), expectedHash);
		assert.equal(hashSamplingSnapshot(reorderedSnapshot), expectedHash);
		assert.equal(hashSamplingSnapshot(nestedKeyReorderedSnapshot), expectedHash);
	});

	it('rejects an empty snapshot id', () => {
		assert.throws(() => normalizePdlSamplingSnapshot({ ...fixture, id: '' }), /snapshot id/);
	});

	it('rejects duplicate roster species after Showdown ID normalization', () => {
		const roster = structuredClone(fixture.roster);
		roster.teams[0].roster.push({ species: 'tatsugiri', cost: 4 });

		assert.throws(
			() => normalizePdlSamplingSnapshot({ ...fixture, roster }),
			/duplicate roster species/i
		);
	});

	it('requires exactly two drafted Tera types per team', () => {
		const roster = structuredClone(fixture.roster);
		roster.teams[0].draftedTeraTypes = ['Grass'];

		assert.throws(
			() => normalizePdlSamplingSnapshot({ ...fixture, roster }),
			/exactly two drafted Tera types/i
		);
	});

	it('rejects negative and NaN usage weights', () => {
		for (const weight of [-1, NaN]) {
			const usageBySpecies = structuredClone(fixture.usageBySpecies);
			usageBySpecies.Tatsugiri.moves[0].weight = weight;

			assert.throws(
				() => normalizePdlSamplingSnapshot({ ...fixture, usageBySpecies }),
				/usage weight/i
			);
		}
	});
});
