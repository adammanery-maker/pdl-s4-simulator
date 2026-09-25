'use strict';

require('../main');

const assert = require('node:assert/strict');
const { validatePdlTeam } = require('../../dist/pdl/validate-team');

const league = {
	teams: [{
		id: 'adam',
		name: 'Adam',
		draftedTeraTypes: ['Grass', 'Ghost'],
		roster: [
			{ species: 'Tatsugiri', cost: 4 },
			{ species: 'Toxtricity', cost: 5 },
			{ species: 'Rotom-Wash', cost: 4 },
			{ species: 'Scizor', cost: 4 },
			{ species: 'Gligar', cost: 3 },
			{ species: 'Milotic', cost: 3 },
		],
	}],
};

const validTeam = [
	{ species: 'Tatsugiri', teraType: 'Water' },
	{ species: 'Toxtricity' },
	{ species: 'Rotom-Wash' },
	{ species: 'Scizor' },
	{ species: 'Gligar' },
	{ species: 'Milotic' },
];

describe('PDL roster validation', () => {
	it('accepts a six-Pokémon current roster with a permitted Tera type', () => {
		assert.deepEqual(validatePdlTeam({ league, teamId: 'adam', team: validTeam }), []);
	});

	it('rejects a Pokémon that is not on the current roster', () => {
		const team = [...validTeam.slice(0, 5), { species: 'Pikachu' }];
		assert.match(validatePdlTeam({ league, teamId: 'adam', team })[0], /not on Adam's current roster/);
	});

	it('requires exactly six Pokémon', () => {
		assert.match(validatePdlTeam({ league, teamId: 'adam', team: validTeam.slice(0, 5) })[0], /exactly six Pokémon/);
	});

	it('rejects Terastallization by a Pokémon costing more than four', () => {
		const team = validTeam.map(set => ({ ...set }));
		team[1].teraType = 'Electric';
		assert.match(validatePdlTeam({ league, teamId: 'adam', team })[0], /cost 5.*cannot Terastallize/);
	});

	it('rejects a non-native, non-drafted Tera type', () => {
		const team = validTeam.map(set => ({ ...set }));
		team[0].teraType = 'Fairy';
		assert.match(validatePdlTeam({ league, teamId: 'adam', team })[0], /must be a native type or one of Adam's drafted Tera types/);
	});
});
