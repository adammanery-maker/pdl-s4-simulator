'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { mkdtempSync, readdirSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runMechanicsConformance, writeMechanicsConformanceReport, REQUIRED_MECHANICS, COMPARISON_CLASSIFICATIONS } = require('../../../dist/pdl/conformance/showdown-fixture');

describe('PDL Showdown ↔ poke-engine mechanics conformance', () => {
	it('records every required mechanic with an auditable public comparison', async function () {
		this.timeout(30000);
		const report = await runMechanicsConformance();

		assert.deepEqual(new Set(report.cases.map(result => result.mechanic)), new Set(REQUIRED_MECHANICS));
		assert.equal(report.runtime.authoritativeEngine, 'pokemon-showdown-local');
		assert.equal(report.runtime.searchEngine, 'poke-engine-mcts');
		assert.equal(report.runtime.baselineTag, 'pdl-hardened-baseline-v1');
		for (const key of ['simulatorRevision', 'foulPlayRevision', 'pokeEngineRevision']) {
			assert.match(report.runtime[key], /^[0-9a-f]{40}$/);
		}

		for (const result of report.cases) {
			assert(COMPARISON_CLASSIFICATIONS.includes(result.comparison.classification), result.id);
			assert.equal(typeof result.comparison.reason, 'string', result.id);
			assert.equal(typeof result.showdown, 'object', result.id);
			assert.equal(typeof result.pokeEngine, 'object', result.id);
			assert.equal(JSON.stringify(result).includes('privateTeam'), false, result.id);
			if (result.comparison.classification !== 'EXACT') {
				assert.equal(typeof result.comparison.strategicImpact, 'string', result.id);
				assert.equal(typeof result.comparison.inferenceImpact, 'string', result.id);
				assert.equal(typeof result.comparison.recommendedTreatment, 'string', result.id);
			}
		}
	});

	it('writes one machine-readable report per fixture without submitted-team data', async function () {
		this.timeout(30000);
		const outputDirectory = mkdtempSync(join(tmpdir(), 'pdl-mechanics-conformance-'));
		const paths = await writeMechanicsConformanceReport(outputDirectory);

		assert.equal(paths.length, REQUIRED_MECHANICS.length + 1);
		assert.equal(readdirSync(outputDirectory).length, REQUIRED_MECHANICS.length + 1);
		for (const path of paths) assert.equal(readFileSync(path, 'utf8').includes('privateTeam'), false);
	});

	it('does not mislabel poke-engine’s max-damage probe as a full Showdown roll set', async function () {
		this.timeout(30000);
		const report = await runMechanicsConformance();
		const ordinaryDamage = report.cases.find(result => result.id === 'ordinary-damage');

		assert.equal(ordinaryDamage.pokeEngine.damageRollRepresentation, 'max-normal-and-crit');
		assert.equal(ordinaryDamage.comparison.classification, 'KNOWN_APPROXIMATION');
		assert.match(ordinaryDamage.comparison.reason, /does not expose the 16 Gen 9 random damage outcomes/i);
	});

	it('executes public evidence for stateful fixture mechanics', async function () {
		this.timeout(30000);
		const report = await runMechanicsConformance();
		const byId = new Map(report.cases.map(result => [result.id, result]));

		assert(byId.get('burn').showdown.events.some(event => event.includes('|-status|p1a:') && event.includes('|brn')));
		assert(byId.get('screens').showdown.events.some(event => event.includes('|-sidestart|p2:') && event.includes('Light Screen')));
		assert(byId.get('stat-stages').showdown.events.some(event => event.includes('|-boost|p1a:') && event.includes('|atk|2')));
		assert(byId.get('hazards-boots').showdown.events.some(event => event.startsWith('|switch|p2a: Talonflame')));
		assert(byId.get('pdl-roster-abilities').showdown.events.some(event => event.includes('|-ability|p2a:') && event.includes('Storm Drain')));
	});

	it('caps native damage predictions at the public target HP before comparing a knockout', async function () {
		this.timeout(30000);
		const report = await runMechanicsConformance();
		const statStages = report.cases.find(result => result.id === 'stat-stages');

		assert.notEqual(statStages.comparison.classification, 'MECHANICS_MISMATCH');
		assert.equal(statStages.showdown.targetMaxHp, 714);
	});
});
