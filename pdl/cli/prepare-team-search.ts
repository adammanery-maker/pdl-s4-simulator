import { loadTeamSearchManifest, teamSearchCounts, type TeamSearchPreset } from '../team-search';

if (require.main === module) {
	try {
		const args = process.argv.slice(2);
		const get = (name: string): string => {
			const index = args.indexOf(name);
			if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`);
			return args[index + 1];
		};
		const manifest = loadTeamSearchManifest(get('--manifest'));
		const preset = get('--preset') as TeamSearchPreset;
		console.log(JSON.stringify({ manifest, counts: teamSearchCounts(manifest, preset) }, null, 2));
		if (manifest.validationErrors.length) process.exitCode = 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
