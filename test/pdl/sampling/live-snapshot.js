'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { buildPdlSamplingSnapshotFromLivePayload } = require('../../../dist/pdl/sampling/live-snapshot');

function pokemon(slug, cost) {
	return {
		slug,
		name: slug === 'tatsugiri' ? 'Tatsugiri' : slug,
		cost,
		topAbilities: [{ name: 'Storm Drain', percent: 97.737 }],
		topItems: [{ name: 'Heavy-Duty Boots', percent: 53.297 }],
		topSpreads: [{
			name: 'Timid:0/0/0/252/4/252', percent: 31.406, nature: 'Timid',
			evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 },
		}],
		topMoves: ['Rapid Spin', 'Draco Meteor', 'Surf', 'Nasty Plot'].map((name, index) => ({ name, percent: 100 - index })),
		topTeraTypes: [{ name: 'Ghost', percent: 4.313 }],
		topTeammates: [],
	};
}

describe('live PDL sampling snapshot adapter', () => {
	it('uses transaction-projected rosters rather than historical draft ownership', () => {
		const snapshot = buildPdlSamplingSnapshotFromLivePayload({
			teams: [
				{ teamSlug: 'adam', teamName: 'Adam', pokemonSlugs: ['tatsugiri', 'toxtricity'] },
				{ teamSlug: 'jon', teamName: 'Jon', pokemonSlugs: ['flamigo', 'wo-chien'] },
			],
			transactions: [{ id: 'add-toxtricity', recordedAt: '2026-08-11T00:00:00.000Z' }],
			draftSnapshot: {
				updatedAt: '2026-08-02T19:32:51.362Z',
				teams: [
					{ slug: 'adam', name: 'Adam', teraTypes: [{ name: 'Grass' }, { name: 'Ghost' }], pokemon: [pokemon('tatsugiri', 3), pokemon('rhydon', 4)] },
					{ slug: 'jon', name: 'Jon', teraTypes: [{ name: 'Dragon' }, { name: 'Ice' }], pokemon: [pokemon('flamigo', 11), pokemon('wo-chien', 8)] },
				],
				draftedPokemon: [pokemon('tatsugiri', 3), pokemon('toxtricity', 5), pokemon('flamigo', 11), pokemon('wo-chien', 8)],
		availablePokemon: [pokemon('rhydon', 4), pokemon('toxtricity', 5)],
			},
		});

		assert.deepEqual(snapshot.roster.teams[0].roster.map(entry => entry.species), ['tatsugiri', 'toxtricity']);
		assert.deepEqual(snapshot.roster.teams[0].draftedTeraTypes, ['grass', 'ghost']);
		assert.deepEqual(snapshot.availablePokemon, [{ species: 'rhydon', cost: 4 }]);
		assert.equal('rhydon' in snapshot.usageBySpecies, true);
		assert.deepEqual(snapshot.usageBySpecies.tatsugiri.natures.map(entry => entry.name), ['Timid']);
		assert.equal(snapshot.usageBySpecies.tatsugiri.spreads[0].evs.spa, 252);
		assert.match(snapshot.sourceId, /add-toxtricity/);
	});
});
