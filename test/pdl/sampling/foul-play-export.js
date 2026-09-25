'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { buildFoulPlayMatchArtifacts, buildFoulPlayBeliefForSnapshot } = require('../../../dist/pdl/sampling/foul-play-export');
const { normalizePdlSamplingSnapshot } = require('../../../dist/pdl/sampling/snapshot');

const physicalEvs = { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 };
const specialEvs = { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 };

function usage(moves, ability, item, nature, evs, teraType) {
	return {
		moves: moves.map((name, index) => ({ name, weight: 100 - index })),
		abilities: [{ name: ability, weight: 100 }],
		items: [{ name: item, weight: 100 }],
		natures: [{ name: nature, weight: 100 }],
		spreads: [{ name: `${nature}-fixture`, weight: 100, evs }],
		teraTypes: [{ name: teraType, weight: 100 }],
		teammates: [],
	};
}

function snapshot() {
	const adam = [
		['Garchomp', 'Rough Skin', 'Leftovers', 'Jolly', physicalEvs, 'Ground', ['Earthquake', 'Dragon Claw', 'Stealth Rock', 'Rock Slide']],
		['Corviknight', 'Pressure', 'Leftovers', 'Impish', physicalEvs, 'Flying', ['Brave Bird', 'Body Press', 'Roost', 'Defog']],
		['Rotom-Wash', 'Levitate', 'Choice Scarf', 'Timid', specialEvs, 'Water', ['Hydro Pump', 'Volt Switch', 'Thunder Wave', 'Trick']],
		['Scizor', 'Technician', 'Life Orb', 'Adamant', physicalEvs, 'Bug', ['Bullet Punch', 'U-turn', 'Close Combat', 'Swords Dance']],
		['Clefable', 'Magic Guard', 'Leftovers', 'Bold', physicalEvs, 'Fairy', ['Moonblast', 'Flamethrower', 'Moonlight', 'Thunder Wave']],
		['Dragapult', 'Infiltrator', 'Choice Specs', 'Timid', specialEvs, 'Ghost', ['Shadow Ball', 'Draco Meteor', 'U-turn', 'Thunderbolt']],
	];
	const blair = [
		['Heatran', 'Flash Fire', 'Leftovers', 'Modest', specialEvs, 'Fire', ['Magma Storm', 'Earth Power', 'Flash Cannon', 'Taunt']],
		['Dragonite', 'Multiscale', 'Heavy-Duty Boots', 'Adamant', physicalEvs, 'Dragon', ['Dragon Claw', 'Extreme Speed', 'Earthquake', 'Roost']],
		['Great Tusk', 'Protosynthesis', 'Leftovers', 'Jolly', physicalEvs, 'Ground', ['Headlong Rush', 'Close Combat', 'Rapid Spin', 'Stealth Rock']],
		['Primarina', 'Torrent', 'Choice Specs', 'Modest', specialEvs, 'Water', ['Moonblast', 'Hydro Pump', 'Ice Beam', 'Psychic']],
		['Serperior', 'Contrary', 'Leftovers', 'Timid', specialEvs, 'Grass', ['Leaf Storm', 'Dragon Pulse', 'Glare', 'Substitute']],
		['Gholdengo', 'Good as Gold', 'Leftovers', 'Timid', specialEvs, 'Steel', ['Make It Rain', 'Shadow Ball', 'Recover', 'Focus Blast']],
	];
	const toUsage = entries => Object.fromEntries(entries.map(([species, ability, item, nature, evs, tera, moves]) =>
		[species, usage(moves, ability, item, nature, evs, tera)]
	));
	return normalizePdlSamplingSnapshot({
		id: 'pdl-s4-foul-play-export', sourceId: 'fixture:foul-play-export',
		roster: { teams: [
			{ id: 'adam', name: 'Adam', draftedTeraTypes: ['Grass', 'Ghost'], roster: adam.map(([species]) => ({ species, cost: 4 })) },
			{ id: 'blair', name: 'Blair', draftedTeraTypes: ['Water', 'Steel'], roster: blair.map(([species]) => ({ species, cost: 4 })) },
		] },
		usageBySpecies: { ...toUsage(adam), ...toUsage(blair) },
	});
}

describe('Foul Play match artifact export', () => {
	it('exports beliefs for every Pokémon on each current roster when a human supplies the opponent team', () => {
		const belief = buildFoulPlayBeliefForSnapshot(snapshot(), ['adam', 'blair']);

		assert.deepEqual(belief.teams.adam.roster.map(entry => entry.species), ['garchomp', 'corviknight', 'rotomwash', 'scizor', 'clefable', 'dragapult']);
		assert.deepEqual(belief.teams.blair.roster.map(entry => entry.species), ['heatran', 'dragonite', 'greattusk', 'primarina', 'serperior', 'gholdengo']);
		assert.ok(belief.sets.garchomp.length > 0);
		assert.ok(belief.sets.dragapult.length > 0);
		assert.ok(belief.sets.heatran.length > 0);
		assert.ok(belief.sets.gholdengo.length > 0);
		assert.equal(belief.sets.garchomp.length, 1);
		assert.equal(belief.sets.heatran.length, 1);
		assert.equal(belief.sets.garchomp[0].teraType, 'Ground');
	});

	it('drops a popular but PDL-illegal Tera type from compact human-play beliefs', () => {
		const live = structuredClone(snapshot());
		live.usageBySpecies.garchomp.teraTypes = [{ name: 'Steel', weight: 100 }];
		const belief = buildFoulPlayBeliefForSnapshot(live, ['adam']);

		assert.equal(belief.sets.garchomp[0].teraType, null);
	});

	it('emits a versioned belief snapshot and two reproducible packed PDL sixes', () => {
		const result = buildFoulPlayMatchArtifacts({
			snapshot: snapshot(), p1TeamId: 'adam', p2TeamId: 'blair',
			p1Seed: '1,2,3,4', p2Seed: '5,6,7,8', maxCandidatesPerSpecies: 2,
		});

		assert.equal(result.belief.schemaVersion, 1);
		assert.equal(result.belief.snapshot.source, 'fixture:foul-play-export');
		assert.deepEqual(Object.keys(result.belief.teams).sort(), ['adam', 'blair']);
		assert.equal(result.belief.teams.adam.roster.length, 6);
		assert.equal(Object.keys(result.belief.sets).length, 12);
		assert.equal(result.belief.sets.garchomp[0].moves.length, 4);
		assert.equal(result.belief.sets.garchomp[0].evs.length, 6);
		assert.equal(result.teams.adam.packed.includes('Garchomp'), true);
		assert.equal(result.teams.blair.packed.includes('Heatran'), true);
		assert.equal(result.teams.adam.exported.includes('Garchomp'), true);
		assert.equal(result.teams.blair.exported.includes('Heatran'), true);
	});
});
