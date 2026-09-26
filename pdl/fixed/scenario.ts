import { Dex } from "../../sim/dex";
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { toID } from '../../sim/dex-data';
import { Teams, type PokemonSet } from '../../sim/teams';
import type { FoulPlayBeliefData } from '../sampling/foul-play-export';

interface MutableFoulPlayBeliefData {
	schemaVersion: 1;
	snapshot: FoulPlayBeliefData['snapshot'];
	teams: Record<string, {
		draftedTeraTypes: readonly string[];
		roster: readonly { species: string; cost: number }[];
		teraCaptains?: readonly string[];
		fixedTeraTypes?: Readonly<Record<string, string>>;
	}>;
	sets: FoulPlayBeliefData['sets'];
}

export interface FixedBuild {
	readonly id: string;
	readonly exported: string;
	readonly packed: string;
	readonly team: readonly PokemonSet[];
}

export interface FixedScenarioTeam {
	readonly teamId: string;
	readonly draftedTeraTypes: readonly string[];
	readonly teraCaptains: readonly string[];
	readonly builds: readonly FixedBuild[];
}

export interface FixedScenario {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly belief: FoulPlayBeliefData;
	readonly teams: readonly [FixedScenarioTeam, FixedScenarioTeam];
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty text.`);
	return value.trim();
}

function exportedText(raw: Record<string, unknown>, label: string): string {
	if (typeof raw.exported === 'string') return raw.exported.trim() + '\n';
	if (Array.isArray(raw.exportLines) && raw.exportLines.every(line => typeof line === 'string')) {
		return raw.exportLines.join('\n').trim() + '\n';
	}
	throw new Error(`${label} requires exported or exportLines.`);
}

function stringArray(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) throw new Error(`${label} must be an array of strings.`);
	return value.map(v => toID(v));
}

function parseBuild(value: unknown, captains: readonly string[], draftedTeraTypes: readonly string[], label: string): FixedBuild {
	const raw = object(value, label);
	const exported = exportedText(raw, label);
	const team = Teams.import(exported);
	if (!team || team.length !== 6) throw new Error(`${label} must import as exactly six Pokémon.`);
	const bySpecies = new Map<string, PokemonSet>(team.map(set => [toID(set.species), set]));
	for (const species of captains) {
		const set = bySpecies.get(species);
		if (!set) continue;
		if (!set.teraType) throw new Error(`${label} captain ${species} must have a declared true Tera Type.`);
		const nativeTypes = Dex.species.get(species).types.map(toID);
		const legal = new Set([...nativeTypes, ...draftedTeraTypes]);
		if (!legal.has(toID(set.teraType))) throw new Error(`${label} captain ${species} has illegal Tera Type ${set.teraType}.`);
	}
	for (const set of team) {
		if (set.teraType && !captains.includes(toID(set.species))) {
			throw new Error(`${label} assigns Tera Type ${set.teraType} to non-captain ${set.species}.`);
		}
	}
	return { id: text(raw.id, `${label}.id`), exported, packed: Teams.pack(team), team };
}

function parseTeam(value: unknown, label: string): FixedScenarioTeam {
	const raw = object(value, label);
	const draftedTeraTypes = stringArray(raw.draftedTeraTypes, `${label}.draftedTeraTypes`);
	const teraCaptains = stringArray(raw.teraCaptains, `${label}.teraCaptains`);
	if (!teraCaptains.length || new Set(teraCaptains).size !== teraCaptains.length) {
		throw new Error(`${label}.teraCaptains must declare one or more distinct captains.`);
	}
	
	if (!Array.isArray(raw.builds) || !raw.builds.length) throw new Error(`${label}.builds must be non-empty.`);
	const builds = raw.builds.map((build, index) => parseBuild(build, teraCaptains, draftedTeraTypes, `${label}.builds[${index}]`));
	if (new Set(builds.map(build => build.id)).size !== builds.length) throw new Error(`${label} contains duplicate build ids.`);
	return { teamId: toID(text(raw.teamId, `${label}.teamId`)), draftedTeraTypes, teraCaptains, builds };
}

function beliefSupportsCaptainTypes(belief: FoulPlayBeliefData, teams: readonly FixedScenarioTeam[]): void {
	for (const team of teams) {
		for (const build of team.builds) {
			for (const set of build.team) {
				const speciesID = toID(set.species);
				const candidates = belief.sets[speciesID] || [];
				const isCaptain = team.teraCaptains.includes(speciesID);
				const targetTera = isCaptain ? (set.teraType || 'typeless') : 'typeless';
				const targetEvs = [set.evs?.hp || 0, set.evs?.atk || 0, set.evs?.def || 0, set.evs?.spa || 0, set.evs?.spd || 0, set.evs?.spe || 0];
				const targetMoves = (set.moves || []).map(toID).sort();
				
				const supported = candidates.some(c => 
					c.ability === (set.ability || 'none') &&
					c.item === (set.item || 'none') &&
					c.nature === (set.nature || 'Serious') &&
					JSON.stringify(c.evs) === JSON.stringify(targetEvs) &&
					JSON.stringify(c.moves.map(toID).sort()) === JSON.stringify(targetMoves) &&
					toID(c.teraType) === toID(targetTera)
				);
				
				if (!supported) {
					throw new Error(`Belief prior does not exactly support true set: ${team.teamId} ${speciesID} in ${build.id}`);
				}
			}
		}
	}
}

export function parseFixedScenario(rawValue: unknown, baseDirectory: string): FixedScenario {
	const raw = object(rawValue, 'scenario');
	if (raw.schemaVersion !== 1) throw new Error('Fixed scenario requires schemaVersion 1.');
	if (!Array.isArray(raw.teams) || raw.teams.length !== 2) throw new Error('Fixed scenario must contain exactly two teams.');
	const teams = raw.teams.map((team, index) => parseTeam(team, `scenario.teams[${index}]`)) as unknown as readonly [FixedScenarioTeam, FixedScenarioTeam];
	if (teams[0].teamId === teams[1].teamId) throw new Error('Fixed scenario team ids must differ.');
	const beliefPath = resolve(baseDirectory, text(raw.beliefPath, 'scenario.beliefPath'));
	const belief = JSON.parse(readFileSync(beliefPath, 'utf8')) as FoulPlayBeliefData;
	if (belief.schemaVersion !== 1) throw new Error('Fixed scenario belief requires schemaVersion 1.');
	beliefSupportsCaptainTypes(belief, teams);
	return { schemaVersion: 1, id: text(raw.id, 'scenario.id'), belief, teams };
}

export function loadFixedScenario(path: string): FixedScenario {
	const absolute = resolve(path);
	return parseFixedScenario(JSON.parse(readFileSync(absolute, 'utf8')), dirname(absolute));
}

/** 
 * Build private belief context.
 * In Phase 1, we ensure Zander does NOT know Adam's true tera type. Zander only knows the legal types.
 * We rely on `foul-play` receiving the `teraCaptains` and `draftedTeraTypes` and deriving legal possibilities.
 */
export function privateBeliefFor(
	scenario: FixedScenario,
	ownTeamId: string,
	ownBuild?: FixedBuild,
): FoulPlayBeliefData {
	const cloned = JSON.parse(JSON.stringify(scenario.belief)) as MutableFoulPlayBeliefData;
	const teams = cloned.teams;
	const normalizedOwnTeamId = toID(ownTeamId);
	for (const scenarioTeam of scenario.teams) {
		const beliefTeam = teams[scenarioTeam.teamId];
		beliefTeam.draftedTeraTypes = scenarioTeam.draftedTeraTypes;
		beliefTeam.teraCaptains = scenarioTeam.teraCaptains;
		if (scenarioTeam.teamId === normalizedOwnTeamId) {
			const fixedTeraTypes: Record<string, string> = {};
			if (ownBuild) {
				for (const species of scenarioTeam.teraCaptains) {
					const set = ownBuild.team.find(candidate => toID(candidate.species) === species);
					if (set?.teraType) fixedTeraTypes[species] = set.teraType;
				}
			} else {
				const legacyCaptainTypes = scenarioTeam.teraCaptains as unknown;
				if (legacyCaptainTypes && !Array.isArray(legacyCaptainTypes) && typeof legacyCaptainTypes === 'object') {
					Object.assign(fixedTeraTypes, legacyCaptainTypes);
				}
			}
			beliefTeam.fixedTeraTypes = fixedTeraTypes;
		} else {
			delete beliefTeam.fixedTeraTypes;
		}
	}
	return cloned;
}
