'use strict';

require('../../main');

const assert = require('node:assert/strict');
const { parseExperimentArguments } = require('../../../dist/pdl/cli/experiment');

describe('PDL experiment command', () => {
	it('accepts only an explicit plan file or standard input', () => {
		assert.deepEqual(parseExperimentArguments(['--plan', '-']), { planPath: '-' });
		assert.deepEqual(parseExperimentArguments(['--resume', '/private/tmp/pdl-run']), { resumeDirectory: '/private/tmp/pdl-run' });
		assert.throws(() => parseExperimentArguments([]), /exactly one/i);
		assert.throws(() => parseExperimentArguments(['--plan', '-', '--output', '/tmp/no']), /exactly one/i);
		assert.throws(() => parseExperimentArguments(['--plan', '-', '--resume', '/private/tmp/pdl-run']), /exactly one/i);
	});
});
