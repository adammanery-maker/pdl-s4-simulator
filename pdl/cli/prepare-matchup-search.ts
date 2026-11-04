import { prepareMatchupSearch } from '../team-search/prepare-matchup';
import { seedsForPreset, type TeamSearchPreset } from '../team-search';

function parseArguments(args: readonly string[]) {
	const values = new Map<string, string>();
	const known = new Set(['request', 'output', 'preset']);
	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		const name = token.startsWith('--') ? token.slice(2) : '';
		if (!known.has(name)) throw new Error(`Unknown matchup-preparation argument: ${token}.`);
		if (values.has(name)) throw new Error(`Duplicate --${name}.`);
		const value = args[++index];
		if (!value || value.startsWith('--')) throw new Error(`Missing --${name}.`);
		values.set(name, value);
	}
	const required = (name: string) => {
		const value = values.get(name);
		if (!value) throw new Error(`Missing --${name}.`);
		return value;
	};
	const preset = required('preset') as TeamSearchPreset;
	seedsForPreset(preset);
	return { requestPath: required('request'), outputDirectory: required('output'), preset };
}

if (require.main === module) {
	try {
		const result = prepareMatchupSearch(parseArguments(process.argv.slice(2)));
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
