import { resolve } from 'node:path';
import { writeMechanicsConformanceReport } from './showdown-fixture';

async function main() {
	const outputDirectory = resolve(process.argv[2] || 'calculations/mechanics-conformance');
	const paths = await writeMechanicsConformanceReport(outputDirectory);
	process.stdout.write(`${JSON.stringify({ outputDirectory, reports: paths.length })}\n`);
}

void main().catch(error => {
	process.stderr.write(`${error.stack || error}\n`);
	process.exitCode = 1;
});
