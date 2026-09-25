'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { buildBalancedCrossSchedule } = require('../../../dist/pdl/experiments/schedule');

function countBy(rows, key) {
	const counts = new Map();
	for (const row of rows) counts.set(row[key], (counts.get(row[key]) || 0) + 1);
	return counts;
}

function plan(leftCount, rightCount, totalPairs) {
	return {
		sourcePlan: { schedule: { strategy: 'balanced-cross', totalPairs } },
		left: Array.from({ length: leftCount }, (_, index) => ({ id: `left-${index + 1}` })),
		right: Array.from({ length: rightCount }, (_, index) => ({ id: `right-${index + 1}` })),
	};
}

describe('PDL balanced-cross scheduling', () => {
	it('allocates the approved 8x4, 200-pair matrix exactly', () => {
		const schedule = buildBalancedCrossSchedule(plan(8, 4, 200));
		assert.equal(schedule.length, 200);
		assert.deepEqual([...countBy(schedule, 'leftVariantId').values()].sort((a, b) => a - b), Array(8).fill(25));
		assert.deepEqual([...countBy(schedule, 'rightVariantId').values()].sort((a, b) => a - b), Array(4).fill(50));
		assert.deepEqual([...countBy(schedule, 'cellId').values()].sort((a, b) => a - b), [...Array(24).fill(6), ...Array(8).fill(7)]);
		assert.deepEqual([...new Map([...countBy(schedule, 'cellId')].map(([cell, count]) => [cell.split('__')[1], count])).keys()].length, 4);
	});

	it('refuses plans that cannot give each variant an exact quota', () => {
		assert.throws(() => buildBalancedCrossSchedule(plan(3, 4, 10)), /divide evenly/i);
	});
});
