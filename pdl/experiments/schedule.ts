import type { ResolvedExperimentPlan, ScheduledExperimentPair } from './types';

function requireDivisible(totalPairs: number, count: number, label: string): number {
	if (totalPairs % count !== 0) throw new Error(`balanced-cross requires totalPairs to divide evenly across ${label} variants.`);
	return totalPairs / count;
}

/**
 * Allocates a deterministic near-uniform matrix. Every cross cell differs by
 * at most one pair; every row and column has its requested exact quota.
 */
export function buildBalancedCrossSchedule(plan: ResolvedExperimentPlan): ScheduledExperimentPair[] {
	const leftCount = plan.left.length;
	const rightCount = plan.right.length;
	if (!leftCount || !rightCount) throw new Error('balanced-cross requires variants on both sides.');
	const totalPairs = plan.sourcePlan.schedule.totalPairs;
	const perLeft = requireDivisible(totalPairs, leftCount, 'left');
	const perRight = requireDivisible(totalPairs, rightCount, 'right');
	const baseline = Math.floor(totalPairs / (leftCount * rightCount));
	const rowExtra = perLeft - baseline * rightCount;
	const columnExtra = perRight - baseline * leftCount;
	if (rowExtra < 0 || columnExtra < 0 || leftCount * rowExtra !== rightCount * columnExtra) {
		throw new Error('balanced-cross cannot satisfy the requested variant totals.');
	}
	const counts = Array.from({ length: leftCount }, () => Array<number>(rightCount).fill(baseline));
	let remainingRowExtras = Array(leftCount).fill(rowExtra);
	let remainingColumnExtras = Array(rightCount).fill(columnExtra);
	for (let leftIndex = 0; leftIndex < leftCount; leftIndex++) {
		for (let offset = 0; offset < rightCount && remainingRowExtras[leftIndex]; offset++) {
			const rightIndex = (leftIndex + offset) % rightCount;
			if (!remainingColumnExtras[rightIndex]) continue;
			counts[leftIndex][rightIndex]++;
			remainingRowExtras[leftIndex]--;
			remainingColumnExtras[rightIndex]--;
		}
	}
	if (remainingRowExtras.some(Boolean) || remainingColumnExtras.some(Boolean)) throw new Error('balanced-cross could not allocate its remainder matrix.');
	const pairs: ScheduledExperimentPair[] = [];
	for (let leftIndex = 0; leftIndex < leftCount; leftIndex++) {
		for (let rightIndex = 0; rightIndex < rightCount; rightIndex++) {
			const left = plan.left[leftIndex];
			const right = plan.right[rightIndex];
			const cellId = `${left.id}__${right.id}`;
			for (let repeat = 0; repeat < counts[leftIndex][rightIndex]; repeat++) {
				pairs.push({
					pairId: `pair-${String(pairs.length + 1).padStart(4, '0')}`, cellId,
					leftVariantId: left.id, rightVariantId: right.id,
				});
			}
		}
	}
	return pairs;
}
