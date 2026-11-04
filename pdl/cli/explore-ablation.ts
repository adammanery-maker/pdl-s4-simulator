import { parseExploreAblationArguments } from '../ablation';
import { runExploratoryAblation } from '../ablation/runner';

if (require.main === module) {
	runExploratoryAblation(parseExploreAblationArguments(process.argv.slice(2)))
		.then(directory => process.stdout.write(`Exploratory ablation artifacts: ${directory}/summary.json\n`))
		.catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}

export { runExploratoryAblation };
