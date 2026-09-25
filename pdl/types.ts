import type { PokemonSet } from '../sim/teams';
import type { PRNGSeed } from '../sim/prng';

export interface PdlRosterPokemon {
	species: string;
	cost: number;
}

export interface PdlLeagueTeam {
	id: string;
	name: string;
	draftedTeraTypes: string[];
	roster: PdlRosterPokemon[];
}

export interface PdlLeagueSnapshot {
	teams: PdlLeagueTeam[];
}

export interface PdlTeamValidationInput {
	league: PdlLeagueSnapshot;
	teamId: string;
	team: PokemonSet[];
}

export interface PdlBattleSide {
	teamId: string;
	name: string;
	team: PokemonSet[];
}

export interface PdlBattleInput {
	league: PdlLeagueSnapshot;
	p1: PdlBattleSide;
	p2: PdlBattleSide;
	seed: PRNGSeed;
}

export interface PdlBattleRecord {
	winner: string;
	seed: PRNGSeed;
	formatId: string;
	showdownCommit: string;
	protocolLog: string[];
	canonicalProtocolLog: string[];
	p1Team: PokemonSet[];
	p2Team: PokemonSet[];
	choices: { p1: string[], p2: string[] };
}
