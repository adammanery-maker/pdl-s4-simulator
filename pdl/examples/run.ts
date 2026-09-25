import { runAcceptanceFixture } from './fixture-league';

void runAcceptanceFixture().then(result => {
	console.log(JSON.stringify(result, null, 2));
}).catch(error => {
	console.error(error);
	process.exitCode = 1;
});
