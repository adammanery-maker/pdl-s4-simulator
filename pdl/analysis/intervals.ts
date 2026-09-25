/** Two-sided 95% Wilson score interval for a binomial win rate. */
export function wilsonInterval(wins: number, total: number): [number, number] {
	if (!Number.isInteger(wins) || !Number.isInteger(total) || wins < 0 || total < 0 || wins > total) {
		throw new Error('Wilson interval requires integer 0 <= wins <= total.');
	}
	if (!total) return [0, 0];
	const z = 1.96;
	const zSquared = z * z;
	const proportion = wins / total;
	const denominator = 1 + zSquared / total;
	const centre = (proportion + zSquared / (2 * total)) / denominator;
	const margin = z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * total)) / total) / denominator;
	return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}
