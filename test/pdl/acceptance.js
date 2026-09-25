'use strict';

require('../main');

const assert = require('node:assert/strict');
const { runAcceptanceFixture } = require('../../dist/pdl/examples/fixture-league');

describe('PDL prototype acceptance', () => {
	it('validates rules and reproduces fixed-seed battles', async function () {
		this.timeout(30000);
		const result = await runAcceptanceFixture();

		assert.equal(result.legalTeamAccepted, true);
		assert.equal(result.illegalTeamRejected, true);
		assert.equal(result.replayReproducible, true);
		assert.equal(result.finishedBattles, 2);
	});
});
