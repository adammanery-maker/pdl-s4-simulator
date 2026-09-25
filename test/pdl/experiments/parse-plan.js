'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { parseExperimentPlan, normalizeExperimentVariant } = require('../../../dist/pdl/experiments/parse-plan');

const plan = {
	version: 1,
	teams: {
		left: { teamId: 'adam', variants: [{ id: 'adam-a', require: ['Golem'] }] },
		right: { teamId: 'connor', variants: [{ id: 'connor-a', exclude: ['Muk'] }] },
	},
	schedule: { strategy: 'balanced-cross', totalPairs: 10 },
	simulation: { searchMs: 50, foulRoot: '/tmp/foul', output: '/private/tmp/pdl-plan-test' },
};

describe('PDL experiment plans', () => {
	it('parses a strict portable plan without reading live data', () => {
		const parsed = parseExperimentPlan(JSON.stringify(plan));
		assert.equal(parsed.version, 1);
		assert.equal(parsed.source.liveUrl, 'https://pdl-s4.vercel.app/api/roster-transactions');
		assert.equal(parsed.teams.left.variants[0].id, 'adam-a');
		assert.deepEqual(normalizeExperimentVariant(parsed.teams.left.variants[0]).constraints.requiredSpecies, ['golem']);
	});

	it('accepts informational Tera references as variant metadata', () => {
		const withReference = structuredClone(plan);
		withReference.teams.left.variants[0].teraReferences = { Golem: 'Ghost' };
		const parsed = parseExperimentPlan(JSON.stringify(withReference));
		assert.equal(parsed.teams.left.variants[0].teraReferences.Golem, 'Ghost');
	});

	it('accepts optional free-agent replacements in a variant', () => {
		const withFreeAgent = structuredClone(plan);
		withFreeAgent.teams.left.variants[0].freeAgents = [{ pokemon: 'Rhydon', replace: 'Golem' }, { pokemon: 'Xatu' }];
		const parsed = parseExperimentPlan(JSON.stringify(withFreeAgent));
		assert.deepEqual(parsed.teams.left.variants[0].freeAgents, [{ pokemon: 'Rhydon', replace: 'Golem' }, { pokemon: 'Xatu' }]);
	});

	it('rejects unsupported versions, duplicate variants, and malformed locks', () => {
		assert.throws(() => parseExperimentPlan(JSON.stringify({ ...plan, version: 2 })), /version 1/i);
		assert.throws(() => parseExperimentPlan(JSON.stringify({ ...plan, teams: { ...plan.teams, left: { ...plan.teams.left, variants: [{ id: 'same' }, { id: 'same' }] } } })), /duplicate variant id/i);
		assert.throws(() => normalizeExperimentVariant({ id: 'bad', locks: ['Golem|Bad'] }), /must use/i);
	});
});
