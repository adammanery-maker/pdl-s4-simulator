import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { Dex, toID } from '../../sim/dex';
import { TeamValidator } from '../../sim/team-validator';
import { loadFixedScenario, type FixedBuild } from '../fixed/scenario';
import { PDL_FORMAT_ID } from '../format';
import { validatePdlTeam } from '../validate-team';

interface Options {
	scenarioPath: string;
	outputPath: string;
}

function parseOptions(argv: readonly string[]): Options {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error('Arguments must use --name value pairs.');
		values.set(key.slice(2), value);
	}
	const scenarioPath = values.get('scenario');
	const outputPath = values.get('output');
	if (!scenarioPath || !outputPath) throw new Error('Required: --scenario PATH --output PATH');
	return { scenarioPath, outputPath };
}

function speedAtLevel100(baseSpeed: number, ev: number, nature: 'plus' | 'neutral' = 'plus'): number {
	const preNature = 2 * baseSpeed + 31 + Math.floor(ev / 4) + 5;
	return nature === 'plus' ? Math.floor(preNature * 1.1) : preNature;
}

function fixedCandidateMatch(build: FixedBuild, speciesId: string, candidates: readonly Record<string, unknown>[]): boolean {
	const set = build.team.find(candidate => toID(candidate.species) === speciesId);
	if (!set) return true;
	const expectedEvs = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(stat => set.evs?.[stat as keyof typeof set.evs] || 0);
	const expectedMoves = set.moves.map(toID).sort().join('|');
	const expectedTera = set.teraType || 'typeless';
	return candidates.some(candidate =>
		toID(String(candidate.ability || 'None')) === toID(set.ability || 'None') &&
		toID(String(candidate.item || 'None')) === toID(set.item || 'None') &&
		toID(String(candidate.nature || 'Serious')) === toID(set.nature || 'Serious') &&
		JSON.stringify(candidate.evs) === JSON.stringify(expectedEvs) &&
		Array.isArray(candidate.moves) && candidate.moves.map(value => toID(String(value))).sort().join('|') === expectedMoves &&
		toID(String(candidate.teraType || 'typeless')) === toID(expectedTera)
	);
}

export function validateTeamStrategyStudy(options: Options): Record<string, unknown> {
	const scenario = loadFixedScenario(options.scenarioPath);
	const league = {
		teams: Object.entries(scenario.belief.teams).map(([id, team]) => ({
			id, name: id, draftedTeraTypes: [...team.draftedTeraTypes], roster: [...team.roster],
		})),
	};
	const builds: Record<string, unknown>[] = [];
	const failures: Record<string, unknown>[] = [];
	for (const team of scenario.teams) {
		for (const build of team.builds) {
			// Showdown's validator normalizes the submitted set in place. Keep the
			// parsed fixed build untouched for the subsequent prior-support check.
			const submittedTeam = structuredClone(build.team) as typeof build.team extends readonly (infer T)[] ? T[] : never;
			const pdlErrors = validatePdlTeam({ league, teamId: team.teamId, team: submittedTeam });
			const showdownErrors = TeamValidator.get(PDL_FORMAT_ID).validateTeam(submittedTeam) || [];
			const candidateSupport = build.team.map(set => {
				const species = toID(set.species);
				const candidates = scenario.belief.sets[species] || [];
				return {
					species,
					candidateCount: candidates.length,
					truthSupported: fixedCandidateMatch(build, species, candidates as unknown as readonly Record<string, unknown>[]),
					maximumPriorWeight: candidates.reduce((maximum, candidate) => Math.max(maximum, candidate.weight), 0),
				};
			});
			const record = { teamId: team.teamId, buildId: build.id, pokemonCount: build.team.length, pdlErrors, showdownErrors, candidateSupport };
			builds.push(record);
			if (pdlErrors.length || showdownErrors.length || candidateSupport.some(candidate => !candidate.truthSupported || candidate.candidateCount < 2 || candidate.maximumPriorWeight >= 1)) failures.push(record);
		}
	}
	const whimsicott = speedAtLevel100(Dex.species.get('Whimsicott').baseStats.spe, 224);
	const lycanroc = speedAtLevel100(Dex.species.get('Lycanroc').baseStats.spe, 252);
	const drednaw = speedAtLevel100(Dex.species.get('Drednaw').baseStats.spe, 212);
	const delphox = speedAtLevel100(Dex.species.get('Delphox').baseStats.spe, 252);
	const drifblim = speedAtLevel100(Dex.species.get('Drifblim').baseStats.spe, 176);
	const benchmarks = {
		whimsicottVsLycanroc: { whimsicott, lycanroc, passes: whimsicott > lycanroc },
		drednawVsScarfDelphox: { drednaw, shellSmash: drednaw * 2, delphox, choiceScarf: Math.floor(delphox * 1.5), passes: drednaw * 2 > Math.floor(delphox * 1.5) },
		drifblimVsDrednaw: { drifblim, unburden: drifblim * 2, drednawAfterShellSmash: drednaw * 2, passes: drifblim * 2 > drednaw * 2 },
	};
	const correctionsPath = resolve(options.scenarioPath, '..', 'TEAM_CORRECTIONS.json');
	const report = {
		schemaVersion: 1,
		scenarioId: scenario.id,
		format: PDL_FORMAT_ID,
		buildCount: builds.length,
		status: failures.length || !Object.values(benchmarks).every(value => value.passes) ? 'failed' : 'passed',
		builds,
		benchmarks,
		corrections: JSON.parse(readFileSync(correctionsPath, 'utf8')).corrections,
		failures,
	};
	writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
	if (report.status !== 'passed') throw new Error(`Study validation failed; see ${options.outputPath}.`);
	return report;
}

if (require.main === module) {
	try {
		const report = validateTeamStrategyStudy(parseOptions(process.argv.slice(2)));
		process.stdout.write(`Validated ${report.buildCount} fixed builds.\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
