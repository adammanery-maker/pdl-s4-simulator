'use strict';

require('../main');

const assert = require('../assert');
const { Dex } = require('../../dist/sim');

describe('PDL S4 format', () => {
	it('loads the pinned National Dex NU-derived format', () => {
		const format = Dex.formats.get('gen9pdls4');
		const ruleTable = Dex.formats.getRuleTable(format);
		const rules = Array.from(ruleTable.keys());

		assert.equal(format.exists, true);
		assert.equal(format.mod, 'gen9');
		assert.equal(rules.includes('natdexmod'), true);
		assert.equal(rules.includes('sleepmovesclause'), true);
		assert.equal(rules.includes('sleepclausemod'), false);
		assert.equal(rules.includes('zmoveclause'), true);
		assert.equal(rules.includes('dynamaxclause'), true);
	});
});
