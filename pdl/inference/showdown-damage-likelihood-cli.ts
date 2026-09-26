/** Narrow stdin/stdout boundary for Foul Play's local belief-inference adapter. */
import { calculateDamageLikelihood, type DamageLikelihoodInput } from './showdown-damage-likelihood';

async function readStdin(): Promise<string> {
	let input = '';
	for await (const chunk of process.stdin) input += chunk;
	return input;
}

async function main() {
	const input = JSON.parse(await readStdin()) as DamageLikelihoodInput;
	const result = await calculateDamageLikelihood(input);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().catch(error => {
	process.stderr.write(`${error.stack || error}\n`);
	process.exitCode = 2;
});
