import { simulatePdlBattle } from '../simulate';
import { validatePdlTeam } from '../validate-team';
import type { PokemonSet } from '../../sim/teams';
import type { PdlBattleInput } from '../types';

const evs = { hp: 0, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 };
const makeSet = (set: Pick<PokemonSet, 'species' | 'item' | 'ability' | 'nature' | 'moves' | 'evs' | 'teraType'>): PokemonSet => ({
	name: set.species,
	gender: '',
	ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
	level: 100,
	...set,
});

const red = [
	makeSet({ species: 'Charizard', item: 'Heavy-Duty Boots', ability: 'Blaze', nature: 'Timid', moves: ['Flamethrower', 'Air Slash', 'Roost', 'Defog'], evs }),
	makeSet({ species: 'Venusaur', item: 'Leftovers', ability: 'Overgrow', nature: 'Modest', moves: ['Giga Drain', 'Sludge Bomb', 'Synthesis', 'Earth Power'], evs }),
	makeSet({ species: 'Blastoise', item: 'Leftovers', ability: 'Torrent', nature: 'Modest', moves: ['Surf', 'Ice Beam', 'Rapid Spin', 'Aura Sphere'], evs }),
	makeSet({ species: 'Gengar', item: 'Black Sludge', ability: 'Cursed Body', nature: 'Timid', moves: ['Shadow Ball', 'Sludge Bomb', 'Focus Blast', 'Substitute'], evs }),
	makeSet({ species: 'Dragonite', item: 'Heavy-Duty Boots', ability: 'Multiscale', nature: 'Adamant', moves: ['Dragon Claw', 'Extreme Speed', 'Earthquake', 'Roost'], evs }),
	makeSet({ species: 'Tatsugiri', item: 'Choice Specs', ability: 'Storm Drain', nature: 'Timid', moves: ['Draco Meteor', 'Surf', 'Muddy Water', 'Dragon Pulse'], teraType: 'Water', evs }),
];

const blue = [
	makeSet({ species: 'Arcanine', item: 'Heavy-Duty Boots', ability: 'Intimidate', nature: 'Jolly', moves: ['Flare Blitz', 'Extreme Speed', 'Morning Sun', 'Will-O-Wisp'], evs }),
	makeSet({ species: 'Vaporeon', item: 'Leftovers', ability: 'Water Absorb', nature: 'Bold', moves: ['Scald', 'Wish', 'Protect', 'Ice Beam'], evs }),
	makeSet({ species: 'Jolteon', item: 'Choice Specs', ability: 'Volt Absorb', nature: 'Timid', moves: ['Thunderbolt', 'Volt Switch', 'Shadow Ball', 'Hyper Voice'], evs }),
	makeSet({ species: 'Espeon', item: 'Leftovers', ability: 'Magic Bounce', nature: 'Timid', moves: ['Psychic', 'Dazzling Gleam', 'Morning Sun', 'Calm Mind'], evs }),
	makeSet({ species: 'Umbreon', item: 'Leftovers', ability: 'Synchronize', nature: 'Careful', moves: ['Foul Play', 'Wish', 'Protect', 'Heal Bell'], evs }),
	makeSet({ species: 'Leafeon', item: 'Leftovers', ability: 'Leaf Guard', nature: 'Jolly', moves: ['Leaf Blade', 'Knock Off', 'Swords Dance', 'Synthesis'], evs }),
];

export const fixtureBattle: PdlBattleInput = {
	league: { teams: [
		{ id: 'red', name: 'Red', draftedTeraTypes: ['Grass', 'Ghost'], roster: red.map(set => ({ species: set.species, cost: 4 })) },
		{ id: 'blue', name: 'Blue', draftedTeraTypes: ['Electric', 'Fairy'], roster: blue.map(set => ({ species: set.species, cost: 4 })) },
	] },
	p1: { teamId: 'red', name: 'Red', team: red },
	p2: { teamId: 'blue', name: 'Blue', team: blue },
	seed: 'gen5,00000000,00000000,00000001',
};

export async function runAcceptanceFixture() {
	const legalTeamAccepted = validatePdlTeam({
		league: fixtureBattle.league, teamId: fixtureBattle.p1.teamId, team: fixtureBattle.p1.team,
	}).length === 0;
	const invalidTeam = fixtureBattle.p1.team.map(set => ({ ...set }));
	invalidTeam[0] = { ...invalidTeam[0], species: 'Pikachu' };
	const illegalTeamRejected = validatePdlTeam({
		league: fixtureBattle.league, teamId: fixtureBattle.p1.teamId, team: invalidTeam,
	}).length > 0;
	const first = await simulatePdlBattle(fixtureBattle);
	const second = await simulatePdlBattle(fixtureBattle);
	return {
		legalTeamAccepted,
		illegalTeamRejected,
		replayReproducible: first.winner === second.winner &&
			JSON.stringify(first.canonicalProtocolLog) === JSON.stringify(second.canonicalProtocolLog),
		finishedBattles: 2,
	};
}
