import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { aggregateCompletedPairedTrials, type AnalysisTrial } from '../analysis/aggregate';
import { renderSimulationReport, type ExperimentReportMetadata } from '../report/render';

function requiredDirectory(argv: readonly string[]): string {
	if (argv.length !== 2 || argv[0] !== '--output') throw new Error('Use --output <existing experiment directory>.');
	return resolve(argv[1]);
}

function reportMetadata(resolved: { readonly sourcePlan: { readonly teams: { readonly left: { readonly teamId: string }; readonly right: { readonly teamId: string } } }; readonly left: readonly { id: string; teamId: string; team: readonly { species: string }[] }[]; readonly right: readonly { id: string; teamId: string; team: readonly { species: string }[] }[] }, totalPairs: number): ExperimentReportMetadata {
	const summarize = (variants: readonly { id: string; teamId: string; team: readonly { species: string }[] }[]) => variants.map(variant => ({ id: variant.id, teamId: variant.teamId, species: variant.team.map(set => set.species) }));
	return { leftTeamId: resolved.sourcePlan.teams.left.teamId, rightTeamId: resolved.sourcePlan.teams.right.teamId, totalPairs, leftVariants: summarize(resolved.left), rightVariants: summarize(resolved.right) };
}

/** Rebuilds summary/report from retained trial data without running a battle. */
export function rerenderExperimentReport(outputDirectory: string): string {
	const trials = readFileSync(`${outputDirectory}/trials.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AnalysisTrial);
	const oldSummary = JSON.parse(readFileSync(`${outputDirectory}/summary.json`, 'utf8'));
	const resolved = JSON.parse(readFileSync(`${outputDirectory}/plan.resolved.json`, 'utf8'));
	const analysis = aggregateCompletedPairedTrials(trials);
	const summary = { ...oldSummary, metadata: { ...oldSummary.metadata, experiment: reportMetadata(resolved, analysis.completedPairCount) }, analysis };
	writeFileSync(`${outputDirectory}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
	writeFileSync(`${outputDirectory}/report.html`, renderSimulationReport(summary), 'utf8');
	return outputDirectory;
}

if (require.main === module) {
	try { const output = rerenderExperimentReport(requiredDirectory(process.argv.slice(2))); process.stdout.write(`PDL experiment report rebuilt: ${output}/report.html\n`); }
	catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
