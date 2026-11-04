import { createHash } from 'crypto';
import {
	existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { Dex, toID } from '../../sim/dex';
import type { PokemonSet } from '../../sim/teams';
import { generateSetCandidates } from '../sampling/candidates';
import type { FoulPlayBeliefCandidate, FoulPlayBeliefData } from '../sampling/foul-play-export';
import { normalizePdlSamplingSnapshot } from '../sampling/snapshot';
import type { PdlSamplingUsageChoice } from '../sampling/types';
import {
	loadTeamSearchManifest, teamSearchCounts, teamSearchHash,
	type TeamSearchPreset,
} from './index';

const BASE_CANDIDATE_LIMIT = 48;
const CAPTAIN_CANDIDATE_LIMIT = 192;
const PRIOR_POLICY = Object.freeze({
	id: 'pdl-public-complete-set-prior-v2',
	baseCandidateLimit: BASE_CANDIDATE_LIMIT,
	captainCandidateLimit: CAPTAIN_CANDIDATE_LIMIT,
	selection: 'one representative per legal ability/item/nature-EV group, then highest component-product weight',
	weighting: 'preserve each legal group total mass when compressing its moveset alternatives; nature compatibility is not a second multiplier',
	deduplication: 'species, ability, item, nature, EVs, and moves',
	spreadCorrelation: 'only observed nature and EV-spread pairs are retained',
	tera: 'registered captains are projected uniformly across every legal native plus drafted type; noncaptains use null',
});
const STAT_IDS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
const PUBLIC_CATALOGUE_PATH = resolve(
	__dirname, '..', '..', '..', 'pdl', 'team-search', 'data', 'public-usage-v1.json'
);

interface PublicUsageSpecies {
	readonly species: string;
	readonly cost: number;
	readonly abilities: readonly PdlSamplingUsageChoice[];
	readonly items: readonly PdlSamplingUsageChoice[];
	readonly spreads: readonly PdlSamplingUsageChoice[];
	readonly moves: readonly PdlSamplingUsageChoice[];
	readonly teraTypes: readonly PdlSamplingUsageChoice[];
}

interface PublicUsageCatalogue {
	readonly schemaVersion: 1;
	readonly source: {
		readonly id: string,
		readonly sourceSha256: string,
		readonly bundledOn: string,
		readonly usagePeriod: string,
		readonly speciesCount: number,
		readonly policySha256: string,
	};
	readonly species: Readonly<Record<string, PublicUsageSpecies>>;
}

export interface MatchupParticipantRequest {
	readonly id: string;
	readonly label: string;
	readonly draftedTeraTypes: readonly string[];
	readonly teraCaptains: readonly string[];
	readonly roster: readonly { readonly species: string, readonly cost: number }[];
}

export interface MatchupTeamRequest {
	readonly id: string;
	readonly label: string;
	readonly teamPath: string;
	readonly teamHash?: string;
	readonly notes?: string;
	readonly tags?: readonly string[];
	readonly weight?: number;
}

export interface MatchupSearchRequest {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly candidateParticipant: MatchupParticipantRequest;
	readonly opponentParticipant: MatchupParticipantRequest;
	readonly candidateTeams: readonly MatchupTeamRequest[];
	readonly opponentTeams: readonly MatchupTeamRequest[];
	readonly metadata?: Readonly<Record<string, unknown>>;
}

type PublicPriorRequest = Pick<
	MatchupSearchRequest, 'id' | 'candidateParticipant' | 'opponentParticipant'
>;

export interface PrepareMatchupSearchOptions {
	readonly requestPath: string;
	readonly outputDirectory: string;
	readonly preset: TeamSearchPreset;
}

export interface PreparedMatchupSearch {
	readonly directory: string;
	readonly manifestPath: string;
	readonly beliefPath: string;
	readonly requestHash: string;
	readonly manifestHash: string;
	readonly beliefHash: string;
	readonly counts: ReturnType<typeof teamSearchCounts>;
	readonly dryRunCommand: string;
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
	return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be non-empty text.`);
	return value.trim();
}

function id(value: unknown, name: string): string {
	const result = text(value, name);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(result)) throw new Error(`${name} must use letters, numbers, and hyphens.`);
	return result;
}

function strings(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string' && entry.trim())) {
		throw new Error(`${name} must be an array of non-empty strings.`);
	}
	return value.map(entry => entry.trim());
}

function list(value: unknown, name: string): unknown[] {
	if (!Array.isArray(value) || !value.length) throw new Error(`${name} must be a non-empty list.`);
	return value;
}

function loadCatalogue(): PublicUsageCatalogue {
	const catalogue = JSON.parse(readFileSync(PUBLIC_CATALOGUE_PATH, 'utf8')) as PublicUsageCatalogue;
	if (catalogue.schemaVersion !== 1 || catalogue.source.speciesCount !== 150 ||
		Object.keys(catalogue.species).length !== catalogue.source.speciesCount) {
		throw new Error('Bundled public usage catalogue is missing or incomplete.');
	}
	return catalogue;
}

function parseParticipant(value: unknown, name: string, catalogue: PublicUsageCatalogue): MatchupParticipantRequest {
	const raw = object(value, name);
	const participantId = id(raw.id, `${name}.id`);
	const label = text(raw.label, `${name}.label`);
	const draftedTeraTypes = strings(raw.draftedTeraTypes, `${name}.draftedTeraTypes`)
		.map(type => Dex.types.get(type).name);
	if (draftedTeraTypes.length !== 2 || new Set(draftedTeraTypes.map(toID)).size !== 2 ||
		draftedTeraTypes.some(type => !Dex.types.get(type).exists)) {
		throw new Error(`${name} requires exactly two distinct legal drafted Tera types.`);
	}
	const roster = list(raw.roster, `${name}.roster`).map((rosterValue, index) => {
		const entry = object(rosterValue, `${name}.roster[${index}]`);
		const species = Dex.species.get(text(entry.species, `${name}.roster[${index}].species`));
		if (!species.exists) throw new Error(`${name}.roster[${index}] has an invalid species.`);
		if (typeof entry.cost !== 'number' || !Number.isFinite(entry.cost) || entry.cost < 0) {
			throw new Error(`${name}.roster[${index}].cost must be finite and nonnegative.`);
		}
		const publicEntry = catalogue.species[toID(species.name)];
		if (!publicEntry) throw new Error(`${name} has no bundled public usage data for ${species.name}.`);
		if (publicEntry.cost !== entry.cost) {
			throw new Error(
				`${name} cost for ${species.name} is ${entry.cost}; bundled PDL catalogue requires ${publicEntry.cost}.`
			);
		}
		return { species: species.name, cost: entry.cost };
	});
	if (roster.length < 6) throw new Error(`${name} roster must contain at least six Pokémon.`);
	if (new Set(roster.map(entry => toID(entry.species))).size !== roster.length) {
		throw new Error(`${name} has duplicate roster species.`);
	}
	const teraCaptains = strings(raw.teraCaptains, `${name}.teraCaptains`)
		.map(species => Dex.species.get(species).name);
	if (teraCaptains.length !== 2 || new Set(teraCaptains.map(toID)).size !== 2) {
		throw new Error(`${name} requires exactly two distinct registered Tera captains.`);
	}
	for (const captain of teraCaptains) {
		const rosterEntry = roster.find(entry => toID(entry.species) === toID(captain));
		if (!rosterEntry) throw new Error(`${name} Tera captain ${captain} is not rostered.`);
		if (rosterEntry.cost > 4) {
			throw new Error(`${name} Tera captain ${captain} costs ${rosterEntry.cost}; captains must cost 4 or less.`);
		}
	}
	return { id: participantId, label, draftedTeraTypes, teraCaptains, roster };
}

function parseTeams(value: unknown, name: string, base: string): MatchupTeamRequest[] {
	const teams = list(value, name).map((teamValue, index) => {
		const raw = object(teamValue, `${name}[${index}]`);
		const weight = raw.weight === undefined ? undefined : raw.weight;
		if (weight !== undefined && (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0)) {
			throw new Error(`${name}[${index}].weight must be positive and finite.`);
		}
		const teamHash = raw.teamHash === undefined ? undefined :
			text(raw.teamHash, `${name}[${index}].teamHash`);
		if (teamHash !== undefined && !/^[0-9a-f]{64}$/.test(teamHash)) {
			throw new Error(`${name}[${index}].teamHash must be SHA-256.`);
		}
		return {
			id: id(raw.id, `${name}[${index}].id`),
			label: text(raw.label, `${name}[${index}].label`),
			teamPath: resolve(base, text(raw.teamPath, `${name}[${index}].teamPath`)),
			...(teamHash ? { teamHash } : {}),
			...(typeof raw.notes === 'string' ? { notes: raw.notes } : {}),
			...(raw.tags === undefined ? {} : { tags: strings(raw.tags, `${name}[${index}].tags`) }),
			...(weight === undefined ? {} : { weight }),
		};
	});
	if (new Set(teams.map(team => team.id)).size !== teams.length) throw new Error(`${name} IDs must be unique.`);
	return teams;
}

/** Parse and normalize a participant-neutral matchup request without reading private team contents. */
export function loadMatchupSearchRequest(path: string): MatchupSearchRequest {
	const absolute = resolve(path);
	const raw = object(JSON.parse(readFileSync(absolute, 'utf8')), 'request');
	if (raw.schemaVersion !== 1) throw new Error('matchup-search request requires schemaVersion 1.');
	const catalogue = loadCatalogue();
	const candidateParticipant = parseParticipant(raw.candidateParticipant, 'candidateParticipant', catalogue);
	const opponentParticipant = parseParticipant(raw.opponentParticipant, 'opponentParticipant', catalogue);
	if (toID(candidateParticipant.id) === toID(opponentParticipant.id)) {
		throw new Error('Candidate and opponent participant IDs must be distinct after normalization.');
	}
	const candidateSpecies = new Map(candidateParticipant.roster
		.map(entry => [toID(entry.species), entry.species]));
	const overlap = opponentParticipant.roster
		.flatMap(entry => candidateSpecies.has(toID(entry.species)) ? [entry.species] : []);
	if (overlap.length) throw new Error(`Participant rosters overlap: ${overlap.join(', ')}.`);
	return {
		schemaVersion: 1,
		id: id(raw.id, 'id'),
		candidateParticipant,
		opponentParticipant,
		candidateTeams: parseTeams(raw.candidateTeams, 'candidateTeams', dirname(absolute)),
		opponentTeams: parseTeams(raw.opponentTeams, 'opponentTeams', dirname(absolute)),
		metadata: raw.metadata === undefined ? undefined : object(raw.metadata, 'metadata'),
	};
}

function natureForSpread(spread: PdlSamplingUsageChoice | undefined): string {
	if (!spread) return '';
	const explicit = spread.nature;
	return typeof explicit === 'string' ? explicit : spread.name.split(':')[0];
}

function candidateKey(set: PokemonSet): string {
	return [
		toID(set.species), toID(set.ability), toID(set.item), toID(set.nature),
		...STAT_IDS.map(stat => set.evs[stat]), ...set.moves.map(toID),
	].join('|');
}

function candidateGroupKey(set: PokemonSet): string {
	return [
		toID(set.ability), toID(set.item), toID(set.nature),
		...STAT_IDS.map(stat => set.evs[stat]),
	].join('|');
}

function candidatesForSpecies(
	snapshot: ReturnType<typeof normalizePdlSamplingSnapshot>,
	teamId: 'adam' | 'steve',
	participant: MatchupParticipantRequest,
	species: string
): FoulPlayBeliefCandidate[] {
	const generated = generateSetCandidates({ snapshot, teamId, species });
	const bySet = new Map<string, { set: PokemonSet, weight: number }>();
	const rejections = new Set<string>();
	for (const candidate of generated) {
		for (const reason of candidate.rejectionReasons) rejections.add(reason);
		if (!candidate.set || candidate.usageWeight <= 0) continue;
		// Tera is projected from the registered legal pool below. Keep exactly
		// one generated base universe rather than counting observed Tera rows.
		if (candidate.source.teraType) continue;
		if (toID(candidate.set.nature) !== toID(natureForSpread(candidate.source.spread))) continue;
		const set = {
			...candidate.set,
			moves: [...candidate.set.moves],
			evs: { ...candidate.set.evs },
			ivs: { ...candidate.set.ivs },
		};
		delete set.teraType;
		const key = candidateKey(set);
		const current = bySet.get(key);
		if (!current || current.weight < candidate.usageWeight) bySet.set(key, { set, weight: candidate.usageWeight });
	}
	const legal = [...bySet.values()].sort((left, right) =>
		right.weight - left.weight || candidateKey(left.set).localeCompare(candidateKey(right.set)));
	if (!legal.length) {
		throw new Error(
			`Bundled public usage produced no legal hypotheses for ${species}: ` +
			`${[...rejections].join('; ') || 'no complete candidates'}.`
		);
	}
	const groups = new Map<string, { mass: number, candidates: typeof legal }>();
	for (const candidate of legal) {
		const key = candidateGroupKey(candidate.set);
		const group = groups.get(key) || { mass: 0, candidates: [] };
		group.mass += candidate.weight;
		group.candidates.push(candidate);
		groups.set(key, group);
	}
	if (groups.size > BASE_CANDIDATE_LIMIT) {
		throw new Error(
			`Public prior policy cannot represent all ${groups.size} component groups for ${species} ` +
			`within ${BASE_CANDIDATE_LIMIT} base slots.`
		);
	}
	const selected = new Map<string, { set: PokemonSet, weight: number }>();
	for (const key of [...groups.keys()].sort()) {
		const representative = groups.get(key)!.candidates[0];
		selected.set(candidateKey(representative.set), representative);
	}
	for (const candidate of legal) {
		if (selected.size >= BASE_CANDIDATE_LIMIT) break;
		selected.set(candidateKey(candidate.set), candidate);
	}
	const selectedByGroup = new Map<string, typeof legal>();
	for (const candidate of selected.values()) {
		const key = candidateGroupKey(candidate.set);
		const values = selectedByGroup.get(key) || [];
		values.push(candidate);
		selectedByGroup.set(key, values);
	}
	const base = [...selectedByGroup].flatMap(([key, candidates]) => {
		const group = groups.get(key)!;
		const selectedMass = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
		return candidates.map(candidate => ({
			set: candidate.set,
			weight: group.mass * candidate.weight / selectedMass,
		}));
	}).sort((left, right) =>
		right.weight - left.weight || candidateKey(left.set).localeCompare(candidateKey(right.set)));
	const captain = participant.teraCaptains.some(value => toID(value) === toID(species));
	const teraTypes = captain ?
		[...new Set([...Dex.species.get(species).types, ...participant.draftedTeraTypes])] : [];
	const expanded = base.flatMap(entry => {
		const types: readonly (string | null)[] = captain ? teraTypes : [null];
		return types.map(teraType => ({
			weight: entry.weight / types.length,
			ability: entry.set.ability,
			item: entry.set.item,
			nature: entry.set.nature,
			evs: STAT_IDS.map(stat => entry.set.evs[stat]),
			moves: [...entry.set.moves],
			teraType,
		}));
	});
	const totalWeight = expanded.reduce((sum, candidate) => sum + candidate.weight, 0);
	return expanded.map(candidate => ({ ...candidate, weight: candidate.weight / totalWeight }));
}

function buildPublicBelief(request: PublicPriorRequest, catalogue: PublicUsageCatalogue): FoulPlayBeliefData {
	const aliases = [
		['adam', request.candidateParticipant] as const,
		['steve', request.opponentParticipant] as const,
	];
	const usageBySpecies: Record<string, Record<string, PdlSamplingUsageChoice[]>> = {};
	for (const [, participant] of aliases) {
		for (const rosterEntry of participant.roster) {
			const usage = catalogue.species[toID(rosterEntry.species)];
			if (!usage) throw new Error(`No bundled public usage data for ${rosterEntry.species}.`);
			const natures = new Map<string, PdlSamplingUsageChoice>();
			for (const spread of usage.spreads) {
				const nature = natureForSpread(spread);
				// The spread's published weight already represents the joint nature/EV
				// observation. Nature is a compatibility key, not a second multiplier.
				natures.set(toID(nature), { name: nature, weight: 1 });
			}
			usageBySpecies[toID(rosterEntry.species)] = {
				moves: [...usage.moves], abilities: [...usage.abilities], items: [...usage.items],
				natures: [...natures.values()], spreads: [...usage.spreads], teraTypes: [...usage.teraTypes],
			};
		}
	}
	const snapshot = normalizePdlSamplingSnapshot({
		id: `${request.id}-public-prior-v1`,
		sourceId: `${catalogue.source.id}:${catalogue.source.sourceSha256}:${catalogue.source.policySha256}`,
		roster: { teams: aliases.map(([alias, participant]) => ({
			id: alias, name: participant.label, draftedTeraTypes: [...participant.draftedTeraTypes],
			roster: participant.roster.map(entry => ({ ...entry })),
		})) },
		usageBySpecies,
	});
	const sets: Record<string, readonly FoulPlayBeliefCandidate[]> = {};
	for (const [alias, participant] of aliases) {
		for (const entry of participant.roster) {
			sets[toID(entry.species)] = candidatesForSpecies(snapshot, alias, participant, entry.species);
		}
	}
	const teams = Object.fromEntries(aliases.map(([alias, participant]) => [alias, {
		draftedTeraTypes: [...participant.draftedTeraTypes],
		teraCaptains: participant.teraCaptains.map(toID),
		roster: participant.roster.map(entry => ({ ...entry })),
	}])) as FoulPlayBeliefData['teams'];
	const priorInputHash = teamSearchHash(JSON.stringify({ source: catalogue.source, policy: PRIOR_POLICY, teams, sets }));
	return {
		schemaVersion: 1,
		snapshot: { id: `${request.id}:public-full-roster-v1`, source: catalogue.source.id, hash: priorInputHash },
		teams,
		sets,
	};
}

function priorDiagnostics(request: MatchupSearchRequest, belief: FoulPlayBeliefData) {
	const participant = (registration: MatchupParticipantRequest) => Object.fromEntries(
		registration.roster.map(entry => {
			const sets = belief.sets[toID(entry.species)];
			return [entry.species, {
				hypothesisCount: sets.length,
				legalTeraTypes: [...new Set(sets.flatMap(set => set.teraType ? [set.teraType] : []))],
				captain: registration.teraCaptains.some(captain => toID(captain) === toID(entry.species)),
			}];
		})
	);
	return {
		policy: PRIOR_POLICY,
		candidateParticipant: participant(request.candidateParticipant),
		opponentParticipant: participant(request.opponentParticipant),
	};
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Prepare a neutral matchup request for the unchanged hardened team-search runtime. */
export function prepareMatchupSearch(options: PrepareMatchupSearchOptions): PreparedMatchupSearch {
	const requestPath = resolve(options.requestPath);
	const outputDirectory = resolve(options.outputDirectory);
	if (existsSync(outputDirectory)) {
		throw new Error(`Output directory already exists; preparation will not overwrite it: ${outputDirectory}.`);
	}
	const request = loadMatchupSearchRequest(requestPath);
	const catalogue = loadCatalogue();
	const belief = buildPublicBelief({
		id: request.id,
		candidateParticipant: request.candidateParticipant,
		opponentParticipant: request.opponentParticipant,
	}, catalogue);
	const beliefDiagnostics = priorDiagnostics(request, belief);
	const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
	mkdirSync(dirname(outputDirectory), { recursive: true });
	const staging = mkdtempSync(join(dirname(outputDirectory), '.pdl-matchup-prep-'));
	try {
		const beliefPath = join(staging, 'belief.json');
		const manifestPath = join(staging, 'manifest.json');
		writeJson(beliefPath, belief);
		const roleAliases = {
			adam: {
				role: 'candidateParticipant', id: request.candidateParticipant.id,
				label: request.candidateParticipant.label,
			},
			steve: {
				role: 'opponentParticipant', id: request.opponentParticipant.id,
				label: request.opponentParticipant.label,
			},
		};
		const team = (entry: MatchupTeamRequest) => ({
			id: entry.id, label: entry.label, teamPath: entry.teamPath,
			...(entry.teamHash ? { teamHash: entry.teamHash } : {}),
			...(entry.notes ? { notes: entry.notes } : {}),
			...(entry.tags ? { tags: entry.tags } : {}),
			...(entry.weight === undefined ? {} : { weight: entry.weight }),
		});
		const manifest = {
			schemaVersion: 1,
			id: request.id,
			beliefPath: 'belief.json',
			league: {
				adam: {
					draftedTeraTypes: request.candidateParticipant.draftedTeraTypes,
					teraCaptains: request.candidateParticipant.teraCaptains,
					roster: request.candidateParticipant.roster,
				},
				steve: {
					draftedTeraTypes: request.opponentParticipant.draftedTeraTypes,
					teraCaptains: request.opponentParticipant.teraCaptains,
					roster: request.opponentParticipant.roster,
				},
			},
			adamCandidates: request.candidateTeams.map(team),
			steveOpponents: request.opponentTeams.map(team),
			metadata: {
				...(request.metadata || {}),
				roleAliases,
				requestSchema: 'pdl-neutral-matchup-request-v1',
				requestHash,
				priorSource: catalogue.source,
				priorPolicy: PRIOR_POLICY,
				priorPrivacyBoundary: 'Private submitted teams are excluded from prior generation.',
			},
		};
		writeJson(manifestPath, manifest);
		const firstLoad = loadTeamSearchManifest(manifestPath);
		if (firstLoad.validationErrors.length) {
			throw new Error(`Matchup team validation failed:\n- ${firstLoad.validationErrors.join('\n- ')}`);
		}
		const compiled = {
			...manifest,
			adamCandidates: firstLoad.adamCandidates.map((loaded, index) => ({
				...manifest.adamCandidates[index], teamHash: loaded.teamHash,
			})),
			steveOpponents: firstLoad.steveOpponents.map((loaded, index) => ({
				...manifest.steveOpponents[index], teamHash: loaded.teamHash,
			})),
		};
		writeJson(manifestPath, compiled);
		const loaded = loadTeamSearchManifest(manifestPath);
		if (loaded.validationErrors.length) {
			throw new Error(`Matchup team validation failed:\n- ${loaded.validationErrors.join('\n- ')}`);
		}
		const counts = teamSearchCounts(loaded, options.preset);
		const finalManifestPath = join(outputDirectory, 'manifest.json');
		const finalBeliefPath = join(outputDirectory, 'belief.json');
		const simulatorRoot = resolve(__dirname, '..', '..', '..');
		const foulRoot = resolve(simulatorRoot, '..', 'pdl-s4-foul-play');
		const dryRunOutput = `${outputDirectory}-dry-run`;
		const dryRunCommand = `cd ${shellQuote(simulatorRoot)} && npm run pdl:team-search -- ` +
			`--manifest ${shellQuote(finalManifestPath)} --preset ${options.preset} ` +
			`--foul-root ${shellQuote(foulRoot)} --output ${shellQuote(dryRunOutput)} --dry-run true`;
		const prepared = {
			schemaVersion: 1,
			requestPath,
			requestHash,
			manifestPath: finalManifestPath,
			manifestHash: loaded.manifestHash,
			beliefPath: finalBeliefPath,
			beliefHash: loaded.beliefHash,
			counts,
			roleAliases,
			priorDiagnostics: beliefDiagnostics,
			validationErrors: loaded.validationErrors,
			planner: 'native-fixed-120k',
			runtime: 'pdl-s4-foul-play-eval-fixediter-v1',
			dryRunCommand,
		};
		writeJson(join(staging, 'preparation.json'), prepared);
		renameSync(staging, outputDirectory);
		return {
			directory: outputDirectory,
			manifestPath: finalManifestPath,
			beliefPath: finalBeliefPath,
			requestHash,
			manifestHash: loaded.manifestHash,
			beliefHash: loaded.beliefHash,
			counts,
			dryRunCommand,
		};
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
}
