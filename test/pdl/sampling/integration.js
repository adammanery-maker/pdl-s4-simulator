'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { simulateSampledPdlBattle } = require('../../../dist/pdl/simulate');
const { normalizePdlSamplingSnapshot } = require('../../../dist/pdl/sampling/snapshot');

const physicalEvs = { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 };
const specialEvs = { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 };
const bulkyEvs = { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 };

function usage({ moves, ability, item, nature, evs, teraType }) {
	return {
		moves: moves.map((name, index) => ({ name, weight: 100 - index })),
		abilities: [{ name: ability, weight: 100 }],
		items: [{ name: item, weight: 100 }],
		natures: [{ name: nature, weight: 100 }],
		spreads: [{ name: `${nature}-fixture`, weight: 100, evs }],
		teraTypes: [{ name: teraType, weight: 100 }],
	};
}

function createSnapshot() {
	return normalizePdlSamplingSnapshot({
		id: 'pdl-s4-sampled-battle',
		sourceId: 'fixture:sampled-battle',
		roster: {
			teams: [
				{
					id: 'Adam', name: 'Adam', draftedTeraTypes: ['Grass', 'Ghost'],
					roster: [
						{ species: 'Garchomp', cost: 4 }, { species: 'Corviknight', cost: 4 },
						{ species: 'Rotom-Wash', cost: 4 }, { species: 'Scizor', cost: 4 },
						{ species: 'Clefable', cost: 4 }, { species: 'Dragapult', cost: 4 },
					],
				},
				{
					id: 'Blair', name: 'Blair', draftedTeraTypes: ['Water', 'Steel'],
					roster: [
						{ species: 'Heatran', cost: 4 }, { species: 'Dragonite', cost: 4 },
						{ species: 'Great Tusk', cost: 4 }, { species: 'Primarina', cost: 4 },
						{ species: 'Serperior', cost: 4 }, { species: 'Gholdengo', cost: 4 },
					],
				},
			],
		},
		usageBySpecies: {
			Garchomp: usage({ moves: ['Earthquake', 'Dragon Claw', 'Stealth Rock', 'Rock Slide'], ability: 'Rough Skin', item: 'Leftovers', nature: 'Jolly', evs: physicalEvs, teraType: 'Ground' }),
			Corviknight: usage({ moves: ['Brave Bird', 'Body Press', 'Roost', 'Defog'], ability: 'Pressure', item: 'Leftovers', nature: 'Impish', evs: bulkyEvs, teraType: 'Flying' }),
			'Rotom-Wash': usage({ moves: ['Hydro Pump', 'Volt Switch', 'Thunder Wave', 'Trick'], ability: 'Levitate', item: 'Choice Scarf', nature: 'Timid', evs: specialEvs, teraType: 'Water' }),
			Scizor: usage({ moves: ['Bullet Punch', 'U-turn', 'Close Combat', 'Swords Dance'], ability: 'Technician', item: 'Life Orb', nature: 'Adamant', evs: physicalEvs, teraType: 'Bug' }),
			Clefable: usage({ moves: ['Moonblast', 'Flamethrower', 'Moonlight', 'Thunder Wave'], ability: 'Magic Guard', item: 'Leftovers', nature: 'Bold', evs: bulkyEvs, teraType: 'Fairy' }),
			Dragapult: usage({ moves: ['Shadow Ball', 'Draco Meteor', 'U-turn', 'Thunderbolt'], ability: 'Infiltrator', item: 'Choice Specs', nature: 'Timid', evs: specialEvs, teraType: 'Ghost' }),
			Heatran: usage({ moves: ['Magma Storm', 'Earth Power', 'Flash Cannon', 'Taunt'], ability: 'Flash Fire', item: 'Leftovers', nature: 'Modest', evs: specialEvs, teraType: 'Fire' }),
			Dragonite: usage({ moves: ['Dragon Claw', 'Extreme Speed', 'Earthquake', 'Roost'], ability: 'Multiscale', item: 'Heavy-Duty Boots', nature: 'Adamant', evs: physicalEvs, teraType: 'Dragon' }),
			'Great Tusk': usage({ moves: ['Headlong Rush', 'Close Combat', 'Rapid Spin', 'Stealth Rock'], ability: 'Protosynthesis', item: 'Leftovers', nature: 'Jolly', evs: physicalEvs, teraType: 'Ground' }),
			Primarina: usage({ moves: ['Moonblast', 'Hydro Pump', 'Ice Beam', 'Psychic'], ability: 'Torrent', item: 'Choice Specs', nature: 'Modest', evs: specialEvs, teraType: 'Water' }),
			Serperior: usage({ moves: ['Leaf Storm', 'Dragon Pulse', 'Glare', 'Substitute'], ability: 'Contrary', item: 'Leftovers', nature: 'Timid', evs: specialEvs, teraType: 'Grass' }),
			Gholdengo: usage({ moves: ['Make It Rain', 'Shadow Ball', 'Recover', 'Focus Blast'], ability: 'Good as Gold', item: 'Leftovers', nature: 'Timid', evs: specialEvs, teraType: 'Steel' }),
		},
	});
}

describe('PDL sampled battle simulation', () => {
	it('samples both teams from one snapshot and retains the exact sampled builds in the battle record', async function () {
		this.timeout(20000);
		const result = await simulateSampledPdlBattle({
			snapshot: createSnapshot(),
			p1TeamId: 'adam',
			p2TeamId: 'blair',
			samplerSeed: '1,2,3,4',
			battleSeed: 'gen5,00000000,00000000,00000001',
		});

		assert.equal(result.winner.length > 0, true);
		assert.equal(result.p1Sample.snapshotHash, result.p2Sample.snapshotHash);
		assert.equal(result.p1Sample.team.length, 6);
		assert.equal(result.p2Sample.team.length, 6);
		assert.deepEqual(result.p1Team, result.p1Sample.team);
		assert.deepEqual(result.p2Team, result.p2Sample.team);
		assert.equal(result.protocolLog.some(chunk => chunk.includes('|win|')), true);
	});
});
