import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { Dex, toID } from '../../sim/dex';
import { Teams, type PokemonSet } from '../../sim/teams';
import { TeamValidator } from '../../sim/team-validator';
import { PDL_FORMAT_ID } from '../format';
import type { PdlSunPolicy } from '../batch/types';
import type { FoulPlayBeliefData } from '../sampling/foul-play-export';

export type TeamSearchPreset = 'quick' | 'screen-5' | 'screen' | 'screen-20' | 'confirm';
export type TeamSearchSide = 'adam' | 'steve';
export interface TeamSearchLeagueSide {
	readonly draftedTeraTypes: readonly string[];
	readonly teraCaptains: readonly string[];
	readonly roster: readonly { readonly species: string, readonly cost: number }[];
}
export interface TeamSearchTeam {
	readonly id: string;
	readonly label: string;
	readonly strategyPolicy?: PdlSunPolicy;
	readonly teamPath: string;
	readonly teamHash: string;
	readonly exported: string;
	readonly packed: string;
	readonly team: readonly PokemonSet[];
	/** Captains actually brought; eligibility is derived from league metadata. */
	readonly teraCaptains: readonly string[];
	readonly resolvedTeraTypes: Readonly<Record<string, string>>;
	readonly notes?: string;
	readonly tags?: readonly string[];
	readonly weight: number;
}
export interface TeamSearchManifest {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly adamCandidates: readonly TeamSearchTeam[];
	readonly steveOpponents: readonly TeamSearchTeam[];
	readonly league: Readonly<Record<TeamSearchSide, TeamSearchLeagueSide>>;
	readonly beliefPath: string;
	readonly belief: FoulPlayBeliefData;
	readonly beliefHash: string;
	readonly manifestHash: string;
	readonly validationErrors: readonly string[];
	readonly metadata?: Readonly<Record<string, unknown>>;
}
export function teamSearchHash(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}
function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
	return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be non-empty text.`);
	return value.trim();
}
function list(value: unknown, name: string): unknown[] {
	if (!Array.isArray(value) || !value.length) throw new Error(`${name} must be a non-empty list.`);
	return value;
}
function strings(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string' && entry.trim())) {
		throw new Error(`${name} must be an array of non-empty strings.`);
	}
	return value;
}
function parseLeagueSide(value: unknown, name: string): TeamSearchLeagueSide {
	const raw = object(value, name);
	const draftedTeraTypes = strings(raw.draftedTeraTypes, `${name}.draftedTeraTypes`).map(type => Dex.types.get(type).name);
	if (draftedTeraTypes.length !== 2 || new Set(draftedTeraTypes).size !== 2 || draftedTeraTypes.some(type => !Dex.types.get(type).exists)) {
		throw new Error(`${name} requires two distinct legal drafted Tera types.`);
	}
	const teraCaptains = strings(raw.teraCaptains, `${name}.teraCaptains`).map(toID);
	if (!teraCaptains.length || new Set(teraCaptains).size !== teraCaptains.length) throw new Error(`${name} requires distinct registered captains.`);
	const roster = list(raw.roster, `${name}.roster`).map((value, index) => {
		const pokemon = object(value, `${name}.roster[${index}]`);
		const species = Dex.species.get(text(pokemon.species, `${name}.roster[${index}].species`));
		if (!species.exists || typeof pokemon.cost !== 'number' || !Number.isFinite(pokemon.cost) || pokemon.cost < 0) {
			throw new Error(`${name}.roster[${index}] requires legal species and finite nonnegative cost.`);
		}
		return { species: species.name, cost: pokemon.cost };
	});
	if (new Set(roster.map(pokemon => toID(pokemon.species))).size !== roster.length) throw new Error(`${name} has duplicate roster entries.`);
	for (const captain of teraCaptains) {
		const pokemon = roster.find(entry => toID(entry.species) === captain);
		if (!pokemon || pokemon.cost > 4) throw new Error(`${name} captain ${captain} must be rostered at cost 4 or less.`);
	}
	return { draftedTeraTypes, teraCaptains, roster };
}
export function legalTeamSearchTeraTypes(league: TeamSearchLeagueSide, species: string): readonly string[] {
	if (!league.teraCaptains.includes(toID(species))) return [];
	return [...new Set([...league.draftedTeraTypes, ...Dex.species.get(species).types])];
}
function normalizedTeam(team: readonly PokemonSet[]): string {
	// Retain team/move order, all stats, nickname, gender and explicit hidden power;
	// formatting and identifier spelling do not change normalized team identity.
	return JSON.stringify(team.map(set => ({
		...set, species: toID(set.species), item: toID(set.item), ability: toID(set.ability), nature: toID(set.nature || 'Serious'),
		moves: set.moves.map(toID), teraType: toID(set.teraType || Dex.species.get(set.species).types[0]),
	})));
}
function parseTeam(value: unknown, base: string, name: string, league: TeamSearchLeagueSide, errors: string[]): TeamSearchTeam {
	const raw = object(value, name);
	const id = text(raw.id, `${name}.id`);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(id)) throw new Error(`${name}.id must use letters, numbers, and hyphens.`);
	const strategyPolicy = raw.strategyPolicy;
	if (strategyPolicy !== undefined &&
		(typeof strategyPolicy !== 'string' || !['sun-lead-only-v1', 'sun-sequence-v1'].includes(strategyPolicy) || id !== 'adam-03-sun-drednaw' || !name.startsWith('adamCandidates['))) {
		throw new Error(`${name}.strategyPolicy is only supported for Adam candidate adam-03-sun-drednaw.`);
	}
	const teamPath = resolve(base, text(raw.teamPath, `${name}.teamPath`));
	const sourceExported = readFileSync(teamPath, 'utf8');
	const imported = Teams.import(sourceExported);
	if (!imported?.length) throw new Error(`${name} does not contain a valid Showdown team.`);
	const teamHash = teamSearchHash(normalizedTeam(imported));
	if (raw.teamHash !== undefined && raw.teamHash !== teamHash) throw new Error(`${name}.teamHash does not match normalized teamPath.`);
	const roster = new Set(league.roster.map(entry => toID(entry.species)));
	const team = imported.map(set => ({ ...set, moves: [...set.moves], evs: { ...set.evs }, ivs: { ...set.ivs } }));
	if (team.length !== 6) errors.push(`${id}: expected six Pokémon, found ${team.length}.`);
	if (new Set(team.map(set => toID(set.species))).size !== team.length) errors.push(`${id}: duplicate species.`);
	const resolvedTeraTypes: Record<string, string> = {};
	for (const set of team) {
		if (!roster.has(toID(set.species))) errors.push(`${id}: ${set.species} is not on this run's declared roster.`);
		const legal = legalTeamSearchTeraTypes(league, set.species);
		if (legal.length) {
			const resolvedType = set.teraType || Dex.species.get(set.species).types[0];
			if (!legal.map(toID).includes(toID(resolvedType))) errors.push(`${id}: ${set.species} has illegal Tera type ${resolvedType}; legal pool ${legal.join('/')}.`);
			set.teraType = resolvedType;
			resolvedTeraTypes[toID(set.species)] = resolvedType;
		} else {
			// Import annotations never grant captain eligibility. The existing Foul
			// Play captain boundary denies Tera for these species, even at cost <=4.
			delete set.teraType;
		}
	}
	const mechanicalErrors = TeamValidator.get(PDL_FORMAT_ID).validateTeam(JSON.parse(JSON.stringify(team))) || [];
	errors.push(...mechanicalErrors.map(error => `${id}: ${error}`));
	const teraCaptains = league.teraCaptains.filter(species => team.some(set => toID(set.species) === species));
	if (raw.teraCaptains !== undefined) {
		const declared = strings(raw.teraCaptains, `${name}.teraCaptains`).map(toID).sort();
		if (JSON.stringify(declared) !== JSON.stringify([...teraCaptains].sort())) errors.push(`${id}: teraCaptains must equal registered captains actually brought.`);
	}
	const weight = raw.weight === undefined ? 1 : raw.weight;
	if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) throw new Error(`${name}.weight must be positive and finite.`);
	// Preserve source text when no runtime normalization is required. Explicitly
	// resolved captain Tera types make the own request and search type identical.
	return { id, label: text(raw.label, `${name}.label`), strategyPolicy: strategyPolicy as PdlSunPolicy | undefined, teamPath, teamHash, exported: Teams.export(team), packed: Teams.pack(team), team,
		teraCaptains, resolvedTeraTypes, weight, notes: typeof raw.notes === 'string' ? raw.notes : undefined,
		tags: raw.tags === undefined ? undefined : strings(raw.tags, `${name}.tags`) };
}

/** No selected opponent team is used to construct this run's prior. */
export function loadTeamSearchManifest(path: string): TeamSearchManifest {
	const absolute = resolve(path);
	const raw = object(JSON.parse(readFileSync(absolute, 'utf8')), 'manifest');
	if (raw.schemaVersion !== 1) throw new Error('team-search manifest requires schemaVersion 1.');
	const id = text(raw.id, 'id');
	if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(id)) throw new Error('Manifest id must use letters, numbers, and hyphens.');
	const base = dirname(absolute);
	const leagueRaw = object(raw.league, 'league');
	const league = { adam: parseLeagueSide(leagueRaw.adam, 'league.adam'), steve: parseLeagueSide(leagueRaw.steve, 'league.steve') };
	const adamSpecies = new Set(league.adam.roster.map(pokemon => toID(pokemon.species)));
	if (league.steve.roster.some(pokemon => adamSpecies.has(toID(pokemon.species)))) throw new Error('Existing PDL prior format requires disjoint draft rosters.');
	const validationErrors: string[] = [];
	const adamCandidates = list(raw.adamCandidates, 'adamCandidates').map((value, index) => parseTeam(value, base, `adamCandidates[${index}]`, league.adam, validationErrors));
	const steveOpponents = list(raw.steveOpponents, 'steveOpponents').map((value, index) => parseTeam(value, base, `steveOpponents[${index}]`, league.steve, validationErrors));
	for (const group of [adamCandidates, steveOpponents]) if (new Set(group.map(team => team.id)).size !== group.length) throw new Error('Team IDs must be unique within each pool.');
	const beliefPath = resolve(base, text(raw.beliefPath, 'beliefPath'));
	const beliefText = readFileSync(beliefPath, 'utf8');
	const belief = JSON.parse(beliefText) as FoulPlayBeliefData;
	if (belief.schemaVersion !== 1 || !belief.teams || !belief.sets) throw new Error('beliefPath requires a local schema-v1 PDL prior.');
	for (const side of ['adam', 'steve'] as const) {
		const data = belief.teams[side];
		if (!data || JSON.stringify([...data.draftedTeraTypes].map(toID).sort()) !== JSON.stringify([...league[side].draftedTeraTypes].map(toID).sort()) ||
			JSON.stringify([...(data.teraCaptains || [])].map(toID).sort()) !== JSON.stringify([...league[side].teraCaptains].sort()) ||
			JSON.stringify([...data.roster].map(entry => [toID(entry.species), entry.cost]).sort()) !== JSON.stringify([...league[side].roster].map(entry => [toID(entry.species), entry.cost]).sort())) {
			throw new Error(`Local prior roster/captains/types must match league.${side}.`);
		}
		for (const pokemon of data.roster) if (!belief.sets[toID(pokemon.species)]?.length) throw new Error(`Local prior has no hypotheses for ${pokemon.species}.`);
	}
	const beliefHash = teamSearchHash(beliefText);
	const metadata = raw.metadata === undefined ? undefined : object(raw.metadata, 'metadata');
	const manifestHash = teamSearchHash(JSON.stringify({ id, league, beliefHash, adamCandidates: adamCandidates.map(team => ({ id: team.id, hash: team.teamHash, captains: team.teraCaptains, ...(team.strategyPolicy ? { strategyPolicy: team.strategyPolicy } : {}) })),
		steveOpponents: steveOpponents.map(team => ({ id: team.id, hash: team.teamHash, captains: team.teraCaptains, weight: team.weight })) }));
	return { schemaVersion: 1, id, league, adamCandidates, steveOpponents, beliefPath, belief, beliefHash, manifestHash, validationErrors, metadata };
}
export function seedsForPreset(preset: TeamSearchPreset): number {
	const seeds = ({ quick: 3, 'screen-5': 5, screen: 10, 'screen-20': 20, confirm: 40 })[preset];
	if (!seeds) throw new Error('Preset must be quick, screen-5, screen, screen-20, or confirm.');
	return seeds;
}
export function teamSearchCounts(manifest: TeamSearchManifest, preset: TeamSearchPreset) {
	const seeds = seedsForPreset(preset);
	const perCandidate = manifest.steveOpponents.length * 2 * seeds;
	return { adamCandidates: manifest.adamCandidates.length, steveOpponents: manifest.steveOpponents.length, orientations: 2,
		seedsPerCell: seeds, battlesPerAdamCandidate: perCandidate, totalBattles: manifest.adamCandidates.length * perCandidate };
}
export function sharedCellSeeds(runId: string, steveId: string, orientation: 'forward' | 'reverse', seedIndex: number) {
	const base = `${runId}|${steveId}|${orientation}|${seedIndex}`;
	const seed = (namespace: string) => createHash('sha256').update(`${namespace}\0${base}`).digest('hex').slice(0, 16);
	return { battleSeed: `gen5,${seed('battle')}`, searchSeed: seed('search'), beliefSeed: seed('belief'), worldAllocationSeed: seed('world') };
}
/** Own Tera types are private. Opponent prior and registration stay unchanged. */
export function privateTeamSearchBelief(manifest: TeamSearchManifest, ownSide: TeamSearchSide, ownTeam: TeamSearchTeam): FoulPlayBeliefData {
	const cloned = JSON.parse(JSON.stringify(manifest.belief));
	for (const side of ['adam', 'steve'] as const) {
		delete cloned.teams[side].fixedTeraTypes;
		if (side === ownSide) cloned.teams[side].fixedTeraTypes = { ...ownTeam.resolvedTeraTypes };
	}
	return cloned;
}
