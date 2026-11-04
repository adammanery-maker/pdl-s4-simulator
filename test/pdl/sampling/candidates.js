'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { generateSetCandidates } = require('../../../dist/pdl/sampling/candidates');
const { normalizePdlSamplingSnapshot } = require('../../../dist/pdl/sampling/snapshot');

const evs = { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 };

function createSnapshot({ cost = 4, usage = {} } = {}) {
	return normalizePdlSamplingSnapshot({
		id: 'pdl-s4-candidates',
		sourceId: 'fixture:candidates',
		roster: {
			teams: [{
				id: 'Adam',
				name: 'Adam',
				draftedTeraTypes: ['Grass', 'Ghost'],
				roster: [
					{ species: 'Tatsugiri', cost },
					{ species: 'Rotom-Wash', cost: 4 },
					{ species: 'Scizor', cost: 4 },
					{ species: 'Gligar', cost: 3 },
					{ species: 'Milotic', cost: 3 },
					{ species: 'Toxtricity', cost: 5 },
				],
			}],
		},
		usageBySpecies: {
			Tatsugiri: {
				moves: [
					{ name: 'Draco Meteor', weight: 100 },
					{ name: 'Surf', weight: 95 },
					{ name: 'Muddy Water', weight: 80 },
					{ name: 'Dragon Pulse', weight: 70 },
				],
				abilities: [{ name: 'Storm Drain', weight: 100 }],
				items: [{ name: 'Choice Specs', weight: 100 }],
				natures: [{ name: 'Timid', weight: 100 }],
				spreads: [{ name: 'timid-special', weight: 100, evs }],
				teraTypes: [{ name: 'Water', weight: 100 }, { name: 'Fairy', weight: 75 }],
				...usage,
			},
		},
	});
}

describe('PDL set candidate generation', () => {
	it('represents Ditto with its sole legal move instead of inventing four moves', () => {
		const input = JSON.parse(JSON.stringify(createSnapshot()));
		input.roster.teams[0].roster[0] = { species: 'Ditto', cost: 5 };
		input.usageBySpecies.ditto = {
			moves: [{ name: 'Transform', weight: 100 }],
			abilities: [{ name: 'Imposter', weight: 100 }],
			items: [{ name: 'Choice Scarf', weight: 100 }],
			natures: [{ name: 'Timid', weight: 100 }],
			spreads: [{ name: 'timid-hp', weight: 100, evs: { hp: 252, atk: 0, def: 0, spa: 0, spd: 4, spe: 252 } }],
		};
		const candidates = generateSetCandidates({ snapshot: normalizePdlSamplingSnapshot(input), teamId: 'adam', species: 'Ditto' });
		assert(candidates.length > 0);
		assert(candidates.every(candidate => candidate.set));
		assert(candidates.every(candidate => JSON.stringify(candidate.set.moves) === JSON.stringify(['Transform'])));
		assert(candidates.every(candidate => !candidate.set.teraType));
	});

	it('builds four-move observed sets and filters non-PDL Tera types', () => {
		const candidates = generateSetCandidates({ snapshot: createSnapshot(), teamId: 'adam', species: 'Tatsugiri' });

		assert.equal(candidates.length > 0, true);
		assert.equal(candidates.every(candidate => candidate.set.moves.length === 4), true);
		assert.equal(candidates.every(candidate => candidate.set.ability === 'Storm Drain'), true);
		assert.equal(candidates.some(candidate => candidate.set.teraType === 'Water'), true);
		assert.equal(candidates.some(candidate => candidate.set.teraType === 'Fairy'), false);
	});

	it('reports a missing component instead of inventing a nature', () => {
		const candidates = generateSetCandidates({
			snapshot: createSnapshot({ usage: { natures: [] } }), teamId: 'adam', species: 'Tatsugiri',
		});

		assert.deepEqual(candidates.map(candidate => candidate.set), [undefined]);
		assert.match(candidates[0].rejectionReasons[0], /missing observed natures/i);
	});

	it('creates a legal non-Tera candidate when the roster cost disallows Terastallization', () => {
		const candidates = generateSetCandidates({ snapshot: createSnapshot({ cost: 5 }), teamId: 'adam', species: 'Tatsugiri' });

		assert.equal(candidates.some(candidate => candidate.set && !candidate.set.teraType), true);
		assert.equal(candidates.some(candidate => candidate.set && candidate.set.teraType), false);
	});

	it('rejects Showdown-illegal observed components without removing legal candidates', () => {
		const candidates = generateSetCandidates({
			snapshot: createSnapshot({
				usage: { abilities: [{ name: 'Storm Drain', weight: 100 }, { name: 'Not An Ability', weight: 90 }] },
			}),
			teamId: 'adam',
			species: 'Tatsugiri',
		});

		assert.equal(candidates.every(candidate => candidate.set.ability === 'Storm Drain'), true);
	});
});
