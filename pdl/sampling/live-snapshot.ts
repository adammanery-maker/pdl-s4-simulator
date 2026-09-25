import { toID } from '../../sim/dex-data';
import { normalizePdlSamplingSnapshot } from './snapshot';
import type { PdlSamplingJsonValue, PdlSamplingSnapshot, PdlSamplingUsageChoice } from './types';

type JsonObject = Readonly<Record<string, unknown>>;

function object(value: unknown, description: string): JsonObject {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${description} must be an object.`);
	return value as JsonObject;
}

function array(value: unknown, description: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new Error(`${description} must be an array.`);
	return value;
}

function text(value: unknown, description: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${description} must be a non-empty string.`);
	return value;
}

function entries(value: unknown, description: string): PdlSamplingUsageChoice[] {
	return array(value, description).flatMap((entry, index) => {
		const source = object(entry, `${description}[${index}]`);
		const name = text(source.name, `${description}[${index}].name`);
		const weight = typeof source.percent === 'number' ? source.percent : source.weighted;
		if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) return [];
		return [{ name, weight, ...source as Record<string, PdlSamplingJsonValue> }];
	});
}

function spreads(value: unknown, description: string): PdlSamplingUsageChoice[] {
	return entries(value, description).flatMap(entry => {
		if (typeof entry.nature !== 'string' || !entry.nature.trim() || !entry.evs) return [];
		return [entry];
	});
}

function natures(observedSpreads: readonly PdlSamplingUsageChoice[]): PdlSamplingUsageChoice[] {
	const distinct = new Map<string, PdlSamplingUsageChoice>();
	for (const spread of observedSpreads) {
		const nature = spread.nature as string;
		const id = toID(nature);
		const existing = distinct.get(id);
		if (!existing || existing.weight < spread.weight) distinct.set(id, { name: nature, weight: spread.weight });
	}
	return [...distinct.values()];
}

function catalog(payload: JsonObject): Map<string, JsonObject> {
	const draft = object(payload.draftSnapshot, 'draftSnapshot');
	const allPokemon = [
		...array(draft.draftedPokemon, 'draftSnapshot.draftedPokemon'),
		...array(draft.availablePokemon, 'draftSnapshot.availablePokemon'),
		...array(draft.teams, 'draftSnapshot.teams').flatMap((team, index) => array(object(team, `draftSnapshot.teams[${index}]`).pokemon, `draftSnapshot.teams[${index}].pokemon`)),
	];
	const bySlug = new Map<string, JsonObject>();
	for (const candidate of allPokemon) {
		const pokemon = object(candidate, 'catalog Pokemon');
		bySlug.set(toID(text(pokemon.slug, 'catalog Pokemon.slug')), pokemon);
	}
	return bySlug;
}

function sourceId(payload: JsonObject): string {
	const draft = object(payload.draftSnapshot, 'draftSnapshot');
	const updatedAt = text(draft.updatedAt, 'draftSnapshot.updatedAt');
	const transactionIds = array(payload.transactions, 'transactions')
		.map((transaction, index) => text(object(transaction, `transactions[${index}]`).id, `transactions[${index}].id`));
	return `pdl-live:${updatedAt}:transactions:${transactionIds.join(',')}`;
}

/**
 * Converts the public PDL roster endpoint into an immutable simulation snapshot.
 * Current roster ownership always comes from the transaction-projected `teams` array.
 */
export function buildPdlSamplingSnapshotFromLivePayload(rawPayload: unknown): PdlSamplingSnapshot {
	const payload = object(rawPayload, 'Live PDL roster payload');
	const draft = object(payload.draftSnapshot, 'draftSnapshot');
	const draftedTeams = new Map(array(draft.teams, 'draftSnapshot.teams').map((rawTeam, index) => {
		const team = object(rawTeam, `draftSnapshot.teams[${index}]`);
		return [toID(text(team.slug, `draftSnapshot.teams[${index}].slug`)), team] as const;
	}));
	const pokemonBySlug = catalog(payload);
	const usageBySpecies: Record<string, Record<string, PdlSamplingUsageChoice[]>> = {};
	const toSamplingPokemon = (pokemon: JsonObject) => {
		const species = text(pokemon.name, 'Catalog Pokémon name');
		const cost = pokemon.cost;
		if (typeof cost !== 'number' || !Number.isFinite(cost)) throw new Error(`Catalog cost for ${species} must be finite.`);
		const observedSpreads = spreads(pokemon.topSpreads, `${species}.topSpreads`);
		usageBySpecies[toID(species)] = {
			moves: entries(pokemon.topMoves, `${species}.topMoves`), abilities: entries(pokemon.topAbilities, `${species}.topAbilities`),
			items: entries(pokemon.topItems, `${species}.topItems`), natures: natures(observedSpreads), spreads: observedSpreads,
			teraTypes: cost <= 4 ? entries(pokemon.topTeraTypes, `${species}.topTeraTypes`) : [], teammates: entries(pokemon.topTeammates, `${species}.topTeammates`),
		};
		return { species, cost };
	};
	const availableFromDraft = array(draft.availablePokemon, 'draftSnapshot.availablePokemon').map(candidate => toSamplingPokemon(object(candidate, 'Available free agent')));
	const teams = array(payload.teams, 'teams').map((rawTeam, index) => {
		const projected = object(rawTeam, `teams[${index}]`);
		const id = text(projected.teamSlug, `teams[${index}].teamSlug`);
		const draftTeam = draftedTeams.get(toID(id));
		if (!draftTeam) throw new Error(`Projected team ${id} is missing from draftSnapshot.teams.`);
		const draftedTeraTypes = array(draftTeam.teraTypes, `draftSnapshot team ${id}.teraTypes`)
			.map((type, teraIndex) => text(object(type, `draftSnapshot team ${id}.teraTypes[${teraIndex}]`).name, 'Drafted Tera type'));
		const roster = array(projected.pokemonSlugs, `teams[${index}].pokemonSlugs`).map((slug, rosterIndex) => {
			const pokemonSlug = text(slug, `teams[${index}].pokemonSlugs[${rosterIndex}]`);
			const pokemon = pokemonBySlug.get(toID(pokemonSlug));
			if (!pokemon) throw new Error(`Current roster Pokémon ${pokemonSlug} is missing from the live catalog.`);
			return toSamplingPokemon(pokemon);
		});
		return { id, name: text(projected.teamName, `teams[${index}].teamName`), draftedTeraTypes, roster };
	});

	const rosteredSpecies = new Set(teams.flatMap(team => team.roster.map(pokemon => toID(pokemon.species))));
	const availablePokemon = availableFromDraft.filter(pokemon => !rosteredSpecies.has(toID(pokemon.species)));
	return normalizePdlSamplingSnapshot({
		id: 'pdl-s4-live-roster', sourceId: sourceId(payload), roster: { teams }, availablePokemon, usageBySpecies,
	});
}
