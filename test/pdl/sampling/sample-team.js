'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { sampleCohesiveTeam } = require('../../../dist/pdl/sampling/sample-team');
const { normalizePdlSamplingSnapshot } = require('../../../dist/pdl/sampling/snapshot');

const physicalEvs = { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 };
const specialEvs = { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 };
const bulkyEvs = { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 };

function usage({ moves, ability, item, nature, evs, teraType, teammates = [] }) {
	return {
		moves: moves.map((name, index) => ({ name, weight: 100 - index })),
		abilities: [{ name: ability, weight: 100 }],
		items: [{ name: item, weight: 100 }],
		natures: [{ name: nature, weight: 100 }],
		spreads: [{ name: `${nature}-fixture`, weight: 100, evs }],
		teraTypes: [{ name: teraType, weight: 100 }],
		teammates: teammates.map((name, index) => ({ name, weight: 80 - index * 5 })),
	};
}

function createSnapshot(opponentUsage = {}) {
	return normalizePdlSamplingSnapshot({
		id: 'pdl-s4-cohesion',
		sourceId: 'fixture:cohesion',
		roster: {
			teams: [
				{
					id: 'Adam',
					name: 'Adam',
					draftedTeraTypes: ['Grass', 'Ghost'],
					roster: [
						{ species: 'Garchomp', cost: 4 },
						{ species: 'Corviknight', cost: 4 },
						{ species: 'Rotom-Wash', cost: 4 },
						{ species: 'Scizor', cost: 4 },
						{ species: 'Clefable', cost: 4 },
						{ species: 'Dragapult', cost: 4 },
						{ species: 'Amoonguss', cost: 4 },
					],
				},
				{
					id: 'Blair',
					name: 'Blair',
					draftedTeraTypes: ['Water', 'Steel'],
					roster: [
						{ species: 'Heatran', cost: 4 },
						{ species: 'Dragonite', cost: 4 },
						{ species: 'Great Tusk', cost: 4 },
						{ species: 'Primarina', cost: 4 },
						{ species: 'Serperior', cost: 4 },
						{ species: 'Gholdengo', cost: 4 },
					],
				},
			],
		},
		usageBySpecies: {
			Garchomp: usage({
				moves: ['Earthquake', 'Dragon Claw', 'Stealth Rock', 'Rock Slide'],
				ability: 'Rough Skin', item: 'Leftovers', nature: 'Jolly', evs: physicalEvs,
				teraType: 'Ground', teammates: ['Corviknight', 'Rotom-Wash'],
			}),
			Corviknight: usage({
				moves: ['Brave Bird', 'Body Press', 'Roost', 'Defog'],
				ability: 'Pressure', item: 'Leftovers', nature: 'Impish', evs: bulkyEvs,
				teraType: 'Flying', teammates: ['Garchomp', 'Rotom-Wash'],
			}),
			'Rotom-Wash': usage({
				moves: ['Hydro Pump', 'Volt Switch', 'Thunder Wave', 'Trick'],
				ability: 'Levitate', item: 'Choice Scarf', nature: 'Timid', evs: specialEvs,
				teraType: 'Water', teammates: ['Garchomp', 'Scizor'],
			}),
			Scizor: usage({
				moves: ['Bullet Punch', 'U-turn', 'Close Combat', 'Swords Dance'],
				ability: 'Technician', item: 'Life Orb', nature: 'Adamant', evs: physicalEvs,
				teraType: 'Bug', teammates: ['Rotom-Wash', 'Clefable'],
			}),
			Clefable: usage({
				moves: ['Moonblast', 'Flamethrower', 'Moonlight', 'Thunder Wave'],
				ability: 'Magic Guard', item: 'Leftovers', nature: 'Bold', evs: bulkyEvs,
				teraType: 'Fairy', teammates: ['Corviknight', 'Dragapult'],
			}),
			Dragapult: usage({
				moves: ['Shadow Ball', 'Draco Meteor', 'U-turn', 'Thunderbolt'],
				ability: 'Infiltrator', item: 'Choice Specs', nature: 'Timid', evs: specialEvs,
				teraType: 'Ghost', teammates: ['Clefable', 'Scizor'],
			}),
			Amoonguss: usage({
				moves: ['Spore', 'Giga Drain', 'Sludge Bomb', 'Clear Smog'],
				ability: 'Regenerator', item: 'Black Sludge', nature: 'Bold', evs: bulkyEvs,
				teraType: 'Grass', teammates: ['Garchomp', 'Dragapult'],
			}),
			...opponentUsage,
		},
	});
}

const input = {
	snapshot: createSnapshot(),
	teamId: 'adam',
	opponentTeamId: 'blair',
	seed: '1,2,3,4',
};

describe('PDL cohesive team sampling', () => {
	it('reproduces one legal six from the current roster and reports every cohesion component', () => {
		const first = sampleCohesiveTeam(input);
		const second = sampleCohesiveTeam(input);
		const adamRoster = new Set(input.snapshot.roster.teams[0].roster.map(pokemon => pokemon.species));
		const componentNames = [
			'usage', 'roleCoverage', 'hazardsRemoval', 'speedControl', 'physicalSpecialBalance',
			'defensiveTyping', 'teammateAffinity', 'publicRosterMatchupCoverage',
		];

		assert.deepEqual(first, second);
		assert.equal(first.team.length, 6);
		assert.equal(new Set(first.team.map(set => set.species)).size, 6);
		assert.equal(first.sampledSpecies.every(species => adamRoster.has(species)), true);
		assert.equal(first.candidateScores.length, 6);
		assert.deepEqual(Object.keys(first.teamScore.components), componentNames);
		assert.equal(componentNames.every(name => Number.isFinite(first.teamScore.components[name])), true);
		assert.equal(first.candidateScores.some(score => score.components.roleCoverage > 0), true);
		assert.equal(first.teamScore.components.hazardsRemoval > 0, true);
		assert.equal(first.teamScore.components.speedControl > 0, true);
		assert.equal(first.teamScore.components.teammateAffinity > 0, true);
		assert.equal(first.teamScore.components.publicRosterMatchupCoverage > 0, true);
		assert.equal(first.samplerSeed, input.seed);
		assert.match(first.snapshotHash, /^[a-f0-9]{64}$/);
	});

	it('uses only the opponent public roster, not hidden opponent usage or sets', () => {
		const changedHiddenUsage = createSnapshot({
			Heatran: { hiddenSets: [{ name: 'unavailable-opponent-set', weight: 999999 }] },
		});
		const first = sampleCohesiveTeam(input);
		const second = sampleCohesiveTeam({ ...input, snapshot: changedHiddenUsage });

		assert.deepEqual(second.team, first.team);
		assert.deepEqual(second.sampledSpecies, first.sampledSpecies);
		assert.deepEqual(second.candidateScores, first.candidateScores);
		assert.deepEqual(second.teamScore, first.teamScore);
		assert.notEqual(second.snapshotHash, first.snapshotHash);
	});

	it('fails clearly when fewer than six roster species have legal observed candidates', () => {
		const snapshot = createSnapshot();
		const raw = structuredClone(snapshot);
		raw.usageBySpecies.amoonguss.natures = [];
		raw.usageBySpecies.dragapult.natures = [];
		const incomplete = normalizePdlSamplingSnapshot(raw);

		assert.throws(
			() => sampleCohesiveTeam({ ...input, snapshot: incomplete }),
			/fewer than six roster species have legal observed candidates/i
		);
	});

	it('always includes required and locked Pokémon while excluding forbidden roster members', () => {
		const lockedGarchomp = {
			species: 'Garchomp', item: 'Choice Scarf', ability: 'Rough Skin', nature: 'Jolly',
			evs: physicalEvs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
			moves: ['Earthquake', 'Dragon Claw', 'Stealth Rock', 'Rock Slide'], level: 100, teraType: 'Ground',
		};
		const sample = sampleCohesiveTeam({
			...input,
			constraints: { requiredSpecies: ['Clefable'], excludedSpecies: ['Amoonguss'], lockedSets: [lockedGarchomp] },
		});

		assert.equal(sample.sampledSpecies.includes('clefable'), true);
		assert.equal(sample.sampledSpecies.includes('garchomp'), true);
		assert.equal(sample.sampledSpecies.includes('amoonguss'), false);
		assert.equal(sample.team.find(set => set.species === 'Garchomp').item, 'Choice Scarf');
	});

	it('rejects constraints that require more than six Pokémon', () => {
		assert.throws(() => sampleCohesiveTeam({
			...input,
			constraints: { requiredSpecies: ['Garchomp', 'Corviknight', 'Rotom-Wash', 'Scizor', 'Clefable', 'Dragapult', 'Amoonguss'] },
		}), /at most six/i);
	});

	it('keeps an ineligible locked Tera type as reference metadata without giving the set a Tera action', () => {
		const raw = structuredClone(input.snapshot);
		raw.roster.teams[0].roster[0].cost = 11;
		const expensiveGarchomp = normalizePdlSamplingSnapshot(raw);
		const locked = {
			species: 'Garchomp', item: 'Choice Scarf', ability: 'Rough Skin', nature: 'Jolly',
			evs: physicalEvs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
			moves: ['Earthquake', 'Dragon Claw', 'Stealth Rock', 'Rock Slide'], level: 100, teraType: 'Ghost',
		};
		const sample = sampleCohesiveTeam({ ...input, snapshot: expensiveGarchomp, constraints: { lockedSets: [locked] } });
		assert.equal(sample.team.find(set => set.species === 'Garchomp').teraType, '');
		assert.equal(sample.constraints.teraReferences.garchomp, 'Ghost');
	});

});
