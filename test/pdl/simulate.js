'use strict';

require('../main');

const assert = require('node:assert/strict');
const { simulatePdlBattle } = require('../../dist/pdl/simulate');

const p1Team = [
	{ species: 'Charizard', item: 'Heavy-Duty Boots', ability: 'Blaze', nature: 'Timid', moves: ['Flamethrower', 'Air Slash', 'Roost', 'Defog'] },
	{ species: 'Venusaur', item: 'Leftovers', ability: 'Overgrow', nature: 'Modest', moves: ['Giga Drain', 'Sludge Bomb', 'Synthesis', 'Earth Power'] },
	{ species: 'Blastoise', item: 'Leftovers', ability: 'Torrent', nature: 'Modest', moves: ['Surf', 'Ice Beam', 'Rapid Spin', 'Aura Sphere'] },
	{ species: 'Gengar', item: 'Black Sludge', ability: 'Cursed Body', nature: 'Timid', moves: ['Shadow Ball', 'Sludge Bomb', 'Focus Blast', 'Substitute'] },
	{ species: 'Dragonite', item: 'Heavy-Duty Boots', ability: 'Multiscale', nature: 'Adamant', moves: ['Dragon Claw', 'Extreme Speed', 'Earthquake', 'Roost'] },
	{ species: 'Tatsugiri', item: 'Choice Specs', ability: 'Storm Drain', nature: 'Timid', moves: ['Draco Meteor', 'Surf', 'Muddy Water', 'Dragon Pulse'], teraType: 'Water' },
];

const p2Team = [
	{ species: 'Arcanine', item: 'Heavy-Duty Boots', ability: 'Intimidate', nature: 'Jolly', moves: ['Flare Blitz', 'Extreme Speed', 'Morning Sun', 'Will-O-Wisp'] },
	{ species: 'Vaporeon', item: 'Leftovers', ability: 'Water Absorb', nature: 'Bold', moves: ['Scald', 'Wish', 'Protect', 'Ice Beam'] },
	{ species: 'Jolteon', item: 'Choice Specs', ability: 'Volt Absorb', nature: 'Timid', moves: ['Thunderbolt', 'Volt Switch', 'Shadow Ball', 'Hyper Voice'] },
	{ species: 'Espeon', item: 'Leftovers', ability: 'Magic Bounce', nature: 'Timid', moves: ['Psychic', 'Dazzling Gleam', 'Morning Sun', 'Calm Mind'] },
	{ species: 'Umbreon', item: 'Leftovers', ability: 'Synchronize', nature: 'Careful', moves: ['Foul Play', 'Wish', 'Protect', 'Heal Bell'] },
	{ species: 'Leafeon', item: 'Leftovers', ability: 'Leaf Guard', nature: 'Jolly', moves: ['Leaf Blade', 'Knock Off', 'Swords Dance', 'Synthesis'] },
];

for (const set of [...p1Team, ...p2Team]) {
	set.evs = { spa: 252, spe: 252 };
}

const league = {
	teams: [
		{ id: 'red', name: 'Red', draftedTeraTypes: ['Grass', 'Ghost'], roster: p1Team.map(set => ({ species: set.species, cost: 4 })) },
		{ id: 'blue', name: 'Blue', draftedTeraTypes: ['Electric', 'Fairy'], roster: p2Team.map(set => ({ species: set.species, cost: 4 })) },
	],
};

const battleInput = {
	league,
	p1: { teamId: 'red', name: 'Red', team: p1Team },
	p2: { teamId: 'blue', name: 'Blue', team: p2Team },
	seed: 'gen5,00000000,00000000,00000001',
};

describe('PDL battle simulation', () => {
	it('reproduces the winner and complete protocol log from a fixed seed', async function () {
		this.timeout(15000);
		const first = await simulatePdlBattle(battleInput);
		const second = await simulatePdlBattle(battleInput);

		assert.equal(first.seed, battleInput.seed);
		assert.equal(first.winner, second.winner);
		assert.deepEqual(first.canonicalProtocolLog, second.canonicalProtocolLog);
		assert.match(first.protocolLog.join('\n'), /\|win\|/);
		assert.doesNotMatch(first.canonicalProtocolLog.join('\n'), /\|t:\|\d+/);
	});

	it('records the submitted non-Tera configuration without Showdown defaulting a Tera type', async function () {
		this.timeout(15000);
		const input = structuredClone(battleInput);
		input.league.teams[0].roster[0].cost = 5;
		delete input.p1.team[0].teraType;
		const result = await simulatePdlBattle(input);

		assert.equal(result.p1Team[0].teraType || '', '');
		assert.equal(input.p1.team[0].teraType || '', '');
		assert.equal(result.choices.p1.some(choice => choice.includes('terastallize')), false);
	});
});
