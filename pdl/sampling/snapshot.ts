import { createHash } from 'crypto';
import { toID } from '../../sim/dex-data';
import type {
	PdlSamplingJsonValue,
	PdlSamplingSnapshot,
	PdlSamplingSnapshotInput,
	PdlSamplingUsageChoice,
	PdlSpeciesUsage,
} from './types';

function requireText(value: string, description: string): string {
	if (!value.trim()) throw new Error(`${description.toLowerCase()} is required.`);
	return value;
}

function normalizeId(value: string, description: string): string {
	const id = toID(value);
	if (!id) throw new Error(`${description} must contain a Showdown ID.`);
	return id;
}

function cloneJsonValue(value: PdlSamplingJsonValue): PdlSamplingJsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error('Snapshot JSON values must be finite numbers.');
		return value;
	}
	if (Array.isArray(value)) return value.map(cloneJsonValue);

	const copy: { [key: string]: PdlSamplingJsonValue } = {};
	const object = value as { readonly [key: string]: PdlSamplingJsonValue };
	for (const key of Object.keys(object)) copy[key] = cloneJsonValue(object[key]);
	return copy;
}

function normalizeUsageChoice(choice: PdlSamplingUsageChoice, speciesId: string, component: string): PdlSamplingUsageChoice {
	if (!Number.isFinite(choice.weight) || choice.weight < 0) {
		throw new Error(`Invalid usage weight for ${speciesId}.${component}.`);
	}
	if (!choice.name.trim()) throw new Error(`Usage choice name is required for ${speciesId}.${component}.`);
	return cloneJsonValue(choice) as PdlSamplingUsageChoice;
}

function freeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) freeze(child);
	}
	return value;
}

function canonicalJson(value: PdlSamplingJsonValue): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

	const object = value as { readonly [key: string]: PdlSamplingJsonValue };
	return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

/**
 * Converts a versioned roster and usage-data payload into a portable, immutable
 * sampling snapshot. It does not read any application or live-service state.
 */
export function normalizePdlSamplingSnapshot(input: PdlSamplingSnapshotInput): PdlSamplingSnapshot {
	const id = requireText(input.id, 'Snapshot id');
	const sourceId = requireText(input.sourceId, 'Snapshot source identifier');
	const normalizedTeams = input.roster.teams.map(team => {
		if (team.draftedTeraTypes.length !== 2) {
			throw new Error(`Team ${team.id} must have exactly two drafted Tera types.`);
		}

		const speciesIds = new Set<string>();
		const roster = team.roster.map(pokemon => {
			const species = normalizeId(pokemon.species, `Roster species for ${team.id}`);
			if (speciesIds.has(species)) throw new Error(`Duplicate roster species on ${team.id}: ${species}.`);
			speciesIds.add(species);
			return { species, cost: pokemon.cost };
		});

		return {
			id: normalizeId(team.id, 'Team id'),
			name: requireText(team.name, 'Team name'),
			draftedTeraTypes: team.draftedTeraTypes.map(type => normalizeId(type, `Drafted Tera type for ${team.id}`)),
			roster,
		};
	});
	const rosterSpecies = new Set(normalizedTeams.flatMap(team => team.roster.map(pokemon => pokemon.species)));
	const availablePokemon = (input.availablePokemon || []).map(pokemon => ({
		species: normalizeId(pokemon.species, 'Available free-agent species'), cost: pokemon.cost,
	}));
	const availableSpecies = new Set<string>();
	for (const pokemon of availablePokemon) {
		if (availableSpecies.has(pokemon.species)) throw new Error(`Duplicate available free-agent species: ${pokemon.species}.`);
		if (rosterSpecies.has(pokemon.species)) throw new Error(`${pokemon.species} cannot be both rostered and available.`);
		availableSpecies.add(pokemon.species);
	}

	const usageBySpecies: Record<string, PdlSpeciesUsage> = {};
	for (const [speciesName, usage] of Object.entries(input.usageBySpecies)) {
		const speciesId = normalizeId(speciesName, 'Usage species');
		if (usageBySpecies[speciesId]) throw new Error(`Duplicate usage species after normalization: ${speciesId}.`);

		const normalizedUsage: Record<string, readonly PdlSamplingUsageChoice[]> = {};
		for (const [component, choices] of Object.entries(usage)) {
			normalizedUsage[component] = choices.map(choice => normalizeUsageChoice(choice, speciesId, component));
		}
		usageBySpecies[speciesId] = normalizedUsage;
	}

	return freeze({
		id,
		sourceId,
		roster: { teams: normalizedTeams },
		availablePokemon,
		usageBySpecies,
	});
}

export function hashSamplingSnapshot(snapshot: PdlSamplingSnapshot): string {
	return createHash('sha256').update(canonicalJson(snapshot as unknown as PdlSamplingJsonValue)).digest('hex');
}
