import { toID } from '../../sim/dex';
import { normalizePdlSamplingSnapshot } from '../sampling/snapshot';
import type { PdlSamplingSnapshot } from '../sampling/types';
import type { ExperimentFreeAgentInput } from './types';

/** Applies variant-local free-agent what-ifs to a new immutable sampling snapshot. */
export function applyTemporaryFreeAgents(input: {
	readonly snapshot: PdlSamplingSnapshot;
	readonly teamId: string;
	readonly additions: readonly ExperimentFreeAgentInput[];
}): PdlSamplingSnapshot {
	const teamId = toID(input.teamId);
	const available = new Map(input.snapshot.availablePokemon.map(pokemon => [toID(pokemon.species), pokemon]));
	const used = new Set<string>();
	const teams = input.snapshot.roster.teams.map(team => {
		if (toID(team.id) !== teamId) return { id: team.id, name: team.name, draftedTeraTypes: [...team.draftedTeraTypes], roster: team.roster.map(pokemon => ({ ...pokemon })) };
		let roster = team.roster.map(pokemon => ({ ...pokemon }));
		for (const addition of input.additions) {
			const species = toID(addition.pokemon);
			const freeAgent = available.get(species);
			if (!freeAgent) throw new Error(`${addition.pokemon} is not currently available as a free agent.`);
			if (used.has(species) || roster.some(pokemon => toID(pokemon.species) === species)) throw new Error(`${addition.pokemon} is already included in this simulation roster.`);
			used.add(species);
			if (addition.replace) {
				const replace = toID(addition.replace);
				const index = roster.findIndex(pokemon => toID(pokemon.species) === replace);
				if (index < 0) throw new Error(`${addition.replace} is not on ${team.name}'s current simulation roster, so it cannot be replaced.`);
				roster[index] = { species: freeAgent.species, cost: freeAgent.cost };
			} else {
				roster.push({ species: freeAgent.species, cost: freeAgent.cost });
			}
		}
		return { id: team.id, name: team.name, draftedTeraTypes: [...team.draftedTeraTypes], roster };
	});
	return normalizePdlSamplingSnapshot({
		id: input.snapshot.id, sourceId: input.snapshot.sourceId,
		roster: { teams }, availablePokemon: input.snapshot.availablePokemon.filter(pokemon => !used.has(toID(pokemon.species))).map(pokemon => ({ ...pokemon })),
		usageBySpecies: Object.fromEntries(Object.entries(input.snapshot.usageBySpecies).map(([species, usage]) => [species, Object.fromEntries(Object.entries(usage).map(([component, choices]) => [component, [...choices]]))])),
	});
}
