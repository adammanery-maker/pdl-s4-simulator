import { readFileSync } from 'fs';
import { normalizeTeamSelectionConstraints, parseLockedBuild } from '../sampling/constraints';
import type { ExperimentPlan, ExperimentSideInput, ExperimentVariantInput, NormalizedExperimentVariant } from './types';

const DEFAULT_LIVE_URL = 'https://pdl-s4.vercel.app/api/roster-transactions';

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	return value as Record<string, unknown>;
}

function keys(source: Record<string, unknown>, allowed: readonly string[], label: string): void {
	for (const key of Object.keys(source)) if (!allowed.includes(key)) throw new Error(`${label} has unknown field ${key}.`);
}

function text(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
	return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
	if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer.`);
	return value as number;
}

function textList(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${label} must be an array of non-empty strings.`);
	return value.map(item => (item as string).trim());
}

function freeAgents(value: unknown, label: string): ExperimentVariantInput['freeAgents'] {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
	return value.map((entry, index) => {
		const raw = object(entry, `${label}[${index}]`);
		keys(raw, ['pokemon', 'replace'], `${label}[${index}]`);
		const pokemon = text(raw.pokemon, `${label}[${index}].pokemon`);
		return raw.replace === undefined ? { pokemon } : { pokemon, replace: text(raw.replace, `${label}[${index}].replace`) };
	});
}

function parseVariant(value: unknown, side: string): ExperimentVariantInput {
	const raw = object(value, `${side} variant`);
	keys(raw, ['id', 'require', 'exclude', 'locks', 'teraReferences', 'freeAgents'], `${side} variant`);
	const teraReferences = raw.teraReferences === undefined ? undefined : Object.fromEntries(Object.entries(object(raw.teraReferences, `${side} variant teraReferences`)).map(([species, teraType]) => [text(species, `${side} variant tera reference species`), text(teraType, `${side} variant tera reference type`)]));
	return { id: text(raw.id, `${side} variant id`), require: textList(raw.require, `${side} variant require`), exclude: textList(raw.exclude, `${side} variant exclude`), locks: textList(raw.locks, `${side} variant locks`), teraReferences, freeAgents: freeAgents(raw.freeAgents, `${side} variant freeAgents`) };
}

function parseSide(value: unknown, side: string): ExperimentSideInput {
	const raw = object(value, `${side} team`);
	keys(raw, ['teamId', 'variants'], `${side} team`);
	if (!Array.isArray(raw.variants) || !raw.variants.length) throw new Error(`${side} team variants must be a non-empty array.`);
	const variants = raw.variants.map(variant => parseVariant(variant, side));
	if (new Set(variants.map(variant => variant.id)).size !== variants.length) throw new Error(`${side} team has a duplicate variant id.`);
	return { teamId: text(raw.teamId, `${side} teamId`), variants };
}

/** Parses a portable strict JSON experiment plan; agents can supply it through a shell heredoc. */
export function parseExperimentPlan(textValue: string): ExperimentPlan {
	let rawValue: unknown;
	try { rawValue = JSON.parse(textValue); } catch { throw new Error('Experiment plan must be valid JSON.'); }
	const raw = object(rawValue, 'Experiment plan');
	keys(raw, ['version', 'source', 'teams', 'schedule', 'simulation'], 'Experiment plan');
	if (raw.version !== 1) throw new Error('Experiment plan must use version 1.');
	const teamsRaw = object(raw.teams, 'teams');
	keys(teamsRaw, ['left', 'right'], 'teams');
	const left = parseSide(teamsRaw.left, 'left');
	const right = parseSide(teamsRaw.right, 'right');
	if (left.teamId === right.teamId) throw new Error('Experiment sides must use two different PDL teams.');
	const scheduleRaw = object(raw.schedule, 'schedule');
	keys(scheduleRaw, ['strategy', 'totalPairs'], 'schedule');
	if (scheduleRaw.strategy !== 'balanced-cross') throw new Error('Only schedule strategy balanced-cross is supported in version 1.');
	const simulationRaw = object(raw.simulation, 'simulation');
	keys(simulationRaw, ['searchMs', 'timeoutMs', 'foulRoot', 'output'], 'simulation');
	const sourceRaw = raw.source === undefined ? { liveUrl: DEFAULT_LIVE_URL } : object(raw.source, 'source');
	keys(sourceRaw, ['liveUrl', 'snapshotPath'], 'source');
	const liveUrl = sourceRaw.liveUrl === undefined ? undefined : text(sourceRaw.liveUrl, 'source liveUrl');
	const snapshotPath = sourceRaw.snapshotPath === undefined ? undefined : text(sourceRaw.snapshotPath, 'source snapshotPath');
	if (Number(Boolean(liveUrl)) + Number(Boolean(snapshotPath)) !== 1) throw new Error('source must contain exactly one of liveUrl or snapshotPath.');
	return {
		version: 1, source: liveUrl ? { liveUrl } : { snapshotPath: snapshotPath! }, teams: { left, right },
		schedule: { strategy: 'balanced-cross', totalPairs: positiveInteger(scheduleRaw.totalPairs, 'schedule totalPairs') },
		simulation: {
			searchMs: positiveInteger(simulationRaw.searchMs, 'simulation searchMs'),
			timeoutMs: simulationRaw.timeoutMs === undefined ? undefined : positiveInteger(simulationRaw.timeoutMs, 'simulation timeoutMs'),
			foulRoot: text(simulationRaw.foulRoot, 'simulation foulRoot'), output: text(simulationRaw.output, 'simulation output'),
		},
	};
}

/** Converts text locks into one normalized sampler constraint for each named variant. */
export function normalizeExperimentVariant(input: ExperimentVariantInput): NormalizedExperimentVariant {
	return {
		id: input.id,
		constraints: normalizeTeamSelectionConstraints({
			requiredSpecies: input.require, excludedSpecies: input.exclude, lockedSets: (input.locks || []).map(parseLockedBuild), teraReferences: input.teraReferences,
		}),
	};
}

export function readExperimentPlan(pathOrDash: string): { readonly sourceText: string; readonly plan: ExperimentPlan } {
	const sourceText = readFileSync(pathOrDash === '-' ? 0 : pathOrDash, 'utf8');
	return { sourceText, plan: parseExperimentPlan(sourceText) };
}
