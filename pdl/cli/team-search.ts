import { runTeamSearch, type TeamSearchOptions } from '../team-search/runner';
import { seedsForPreset, type TeamSearchPreset } from '../team-search';

function required(values: ReadonlyMap<string, string | boolean>, name: string): string {
	const value = values.get(name);
	if (typeof value !== 'string' || !value) throw new Error(`Missing --${name}.`);
	return value;
}

/** Parse the deliberately small batch-runner command line. */
export function parseTeamSearchArguments(args: readonly string[]): TeamSearchOptions {
	const values = new Map<string, string | boolean>();
	const booleans = new Set(['dry-run', 'resume']);
	const known = new Set(['manifest', 'preset', 'foul-root', 'output', 'dry-run', 'resume', 'timeout-ms']);
	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		if (!token.startsWith('--') || !known.has(token.slice(2))) throw new Error(`Unknown team-search argument: ${token}.`);
		const name = token.slice(2);
		if (values.has(name)) throw new Error(`Duplicate --${name}.`);
		if (booleans.has(name)) {
			const next = args[index + 1];
			if (!next || next.startsWith('--')) {
				values.set(name, true);
			} else {
				if (!['true', 'false'].includes(next)) throw new Error(`--${name} accepts only true or false.`);
				values.set(name, next === 'true');
				index++;
			}
		} else {
			const next = args[++index];
			if (!next || next.startsWith('--')) throw new Error(`Missing --${name}.`);
			values.set(name, next);
		}
	}
	const preset = required(values, 'preset') as TeamSearchPreset;
	seedsForPreset(preset);
	const timeoutText = values.has('timeout-ms') ? required(values, 'timeout-ms') : '600000';
	const timeoutMs = Number(timeoutText);
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer.');
	const dryRun = values.get('dry-run') === true;
	const resume = values.get('resume') === true;
	return {
		manifestPath: required(values, 'manifest'),
		preset,
		foulRoot: required(values, 'foul-root'),
		outputDirectory: required(values, 'output'),
		dryRun,
		resume,
		timeoutMs,
	};
}

if (require.main === module) {
	runTeamSearch(parseTeamSearchArguments(process.argv.slice(2)))
		.then(directory => process.stdout.write(`Team search: ${directory}/summary.json\n`))
		.catch(error => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		});
}
