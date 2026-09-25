import { Dex, toID } from '../sim/dex';
import type { PokemonSet } from '../sim/teams';
import type { PdlLeagueTeam, PdlTeamValidationInput } from './types';

function getLeagueTeam(input: PdlTeamValidationInput): PdlLeagueTeam | undefined {
	return input.league.teams.find(team => toID(team.id) === toID(input.teamId));
}

function validateTeraType(set: PokemonSet, team: PdlLeagueTeam, cost: number): string | undefined {
	if (!set.teraType) return undefined;
	if (cost > 4) {
		return `${set.species} has cost ${cost} and cannot Terastallize in PDL S4.`;
	}

	const species = Dex.species.get(set.species);
	const permittedTypes = new Set([...species.types, ...team.draftedTeraTypes].map(toID));
	if (!permittedTypes.has(toID(set.teraType))) {
		return `${set.species}'s Tera type ${set.teraType} must be a native type or one of ${team.name}'s drafted Tera types.`;
	}
}

/**
 * Validates PDL-only constraints. Standard move, item, ability, and Pokémon
 * legality remains the responsibility of Showdown's TeamValidator.
 */
export function validatePdlTeam(input: PdlTeamValidationInput): string[] {
	const leagueTeam = getLeagueTeam(input);
	if (!leagueTeam) return [`Unknown PDL team: ${input.teamId}.`];
	if (input.team.length !== 6) return [`${leagueTeam.name}'s battle team must contain exactly six Pokémon.`];

	const errors: string[] = [];
	const roster = new Map(leagueTeam.roster.map(pokemon => [toID(pokemon.species), pokemon]));
	const selected = new Set<string>();

	for (const set of input.team) {
		const speciesId = toID(set.species);
		if (selected.has(speciesId)) {
			errors.push(`${set.species} appears more than once on ${leagueTeam.name}'s battle team.`);
			continue;
		}
		selected.add(speciesId);

		const rosterPokemon = roster.get(speciesId);
		if (!rosterPokemon) {
			errors.push(`${set.species} is not on ${leagueTeam.name}'s current roster.`);
			continue;
		}

		const teraError = validateTeraType(set, leagueTeam, rosterPokemon.cost);
		if (teraError) errors.push(teraError);
	}

	return errors;
}
