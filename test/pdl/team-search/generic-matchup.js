'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
	loadMatchupSearchRequest,
	prepareMatchupSearch,
} = require('../../../dist/pdl/team-search/prepare-matchup');
const { loadTeamSearchManifest, teamSearchCounts } = require('../../../dist/pdl/team-search');
const { runTeamSearch } = require('../../../dist/pdl/team-search/runner');

const root = path.resolve(__dirname, '../../..');
const exampleRequest = path.join(root, 'pdl/team-search/examples/aurora-vs-borealis/request.json');
const legacyManifest = path.join(root, 'pdl/team-search/runs/adam-vs-steve-initial.json');

function temporary(name) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `pdl-${name}-`));
}

function copyRequest(directory) {
	const raw = JSON.parse(fs.readFileSync(exampleRequest, 'utf8'));
	const base = path.dirname(exampleRequest);
	for (const group of [raw.candidateTeams, raw.opponentTeams]) {
		for (const team of group) team.teamPath = path.resolve(base, team.teamPath);
	}
	const requestPath = path.join(directory, 'request.json');
	fs.writeFileSync(requestPath, `${JSON.stringify(raw, null, 2)}\n`);
	return { raw, requestPath };
}

describe('Generic PDL matchup preparation', function () {
	this.timeout(30_000);
	it('compiles a neutral request into the existing immutable team-search runtime', () => {
		const temporaryRoot = temporary('generic-matchup');
		try {
			const { requestPath } = copyRequest(temporaryRoot);
			const output = path.join(temporaryRoot, 'compiled');
			const prepared = prepareMatchupSearch({ requestPath, outputDirectory: output, preset: 'screen-5' });
			const manifest = loadTeamSearchManifest(prepared.manifestPath);

			assert.deepEqual(manifest.validationErrors, []);
			assert.equal(manifest.adamCandidates.length, 2);
			assert.equal(manifest.steveOpponents.length, 1);
			assert.deepEqual(teamSearchCounts(manifest, 'screen-5'), {
				adamCandidates: 2, steveOpponents: 1, orientations: 2,
				seedsPerCell: 5, battlesPerAdamCandidate: 10, totalBattles: 20,
			});
			assert.deepEqual(manifest.metadata.roleAliases, {
				adam: { role: 'candidateParticipant', id: 'aurora', label: 'Hypothetical Aurora' },
				steve: { role: 'opponentParticipant', id: 'borealis', label: 'Hypothetical Borealis' },
			});
			assert.equal(manifest.belief.teams.adam.roster.length, 6);
			assert.equal(manifest.belief.teams.steve.roster.length, 6);
			assert.equal(Object.keys(manifest.belief.sets).length, 12);
			assert.equal(manifest.belief.sets.charizard.length, 192);
			assert.deepEqual(new Set(manifest.belief.sets.charizard.map(set => set.teraType)), new Set(['Fire', 'Flying', 'Fairy', 'Water']));
			assert(manifest.belief.sets.vaporeon.every(set => set.teraType === null));
			const publicData = require('../../../pdl/team-search/data/public-usage-v1.json');
			const observedSpreads = new Set(publicData.species.charizard.spreads.map(spread =>
				`${spread.nature}|${['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(stat => spread.evs[stat]).join(',')}`));
			assert(manifest.belief.sets.charizard.every(set => observedSpreads.has(`${set.nature}|${set.evs.join(',')}`)));
			assert.equal(prepared.counts.totalBattles, 20);
			assert.match(prepared.dryRunCommand, /pdl:team-search/);
			assert.match(prepared.dryRunCommand, /--dry-run true/);
			const audit = JSON.parse(fs.readFileSync(path.join(output, 'preparation.json'), 'utf8'));
			assert.equal(audit.priorDiagnostics.policy.baseCandidateLimit, 48);
			assert.equal(audit.priorDiagnostics.policy.captainCandidateLimit, 192);
			assert.equal(audit.priorDiagnostics.candidateParticipant.Charizard.hypothesisCount, 192);
			assert.deepEqual(
				new Set(audit.priorDiagnostics.candidateParticipant.Charizard.legalTeraTypes),
				new Set(['Fire', 'Flying', 'Fairy', 'Water'])
			);
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	it('preserves lower-frequency public ability/item groups and their marginal mass', () => {
		const temporaryRoot = temporary('prior-groups');
		try {
			const { requestPath } = copyRequest(temporaryRoot);
			const prepared = prepareMatchupSearch({
				requestPath, outputDirectory: path.join(temporaryRoot, 'compiled'), preset: 'quick',
			});
			const belief = loadTeamSearchManifest(prepared.manifestPath).belief;
			const catalogue = require('../../../pdl/team-search/data/public-usage-v1.json');
			const marginal = (sets, field, value) => sets
				.filter(set => set[field] === value).reduce((sum, set) => sum + set.weight, 0);
			const expected = (choices, value) => {
				const total = choices.reduce((sum, choice) => sum + choice.weight, 0);
				return choices.find(choice => choice.name === value).weight / total;
			};
			const close = (actual, target) => assert(Math.abs(actual - target) < 1e-10, `${actual} != ${target}`);

			assert(belief.sets.charizard.some(set => set.ability === 'Solar Power'));
			assert(belief.sets.jolteon.some(set => set.ability === 'Quick Feet'));
			assert(belief.sets.milotic.some(set => set.item === 'Rocky Helmet'));
			close(
				marginal(belief.sets.charizard, 'ability', 'Solar Power'),
				expected(catalogue.species.charizard.abilities, 'Solar Power')
			);
			close(
				marginal(belief.sets.jolteon, 'ability', 'Quick Feet'),
				expected(catalogue.species.jolteon.abilities, 'Quick Feet')
			);
			close(
				marginal(belief.sets.milotic, 'item', 'Rocky Helmet'),
				expected(catalogue.species.milotic.items, 'Rocky Helmet')
			);
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	it('uses only roster registration and bundled public data for belief identity', () => {
		const temporaryRoot = temporary('public-prior');
		try {
			const first = copyRequest(temporaryRoot);
			const firstOutput = path.join(temporaryRoot, 'first');
			const firstPrepared = prepareMatchupSearch({ requestPath: first.requestPath, outputDirectory: firstOutput, preset: 'quick' });

			const alternativeTeam = path.join(temporaryRoot, 'alternative.txt');
			const source = fs.readFileSync(first.raw.candidateTeams[0].teamPath, 'utf8');
			fs.writeFileSync(alternativeTeam, source.replace('Charizard @ Heavy-Duty Boots', 'Charizard @ Leftovers'));
			first.raw.candidateTeams[0].teamPath = alternativeTeam;
			const secondRequest = path.join(temporaryRoot, 'second-request.json');
			fs.writeFileSync(secondRequest, `${JSON.stringify(first.raw, null, 2)}\n`);
			const secondPrepared = prepareMatchupSearch({ requestPath: secondRequest, outputDirectory: path.join(temporaryRoot, 'second'), preset: 'quick' });

			assert.equal(firstPrepared.beliefHash, secondPrepared.beliefHash);
			assert.notEqual(firstPrepared.manifestHash, secondPrepared.manifestHash);

			const alternativeOpponent = path.join(temporaryRoot, 'opponent-alternative.txt');
			const opponentSource = fs.readFileSync(first.raw.opponentTeams[0].teamPath, 'utf8');
			fs.writeFileSync(alternativeOpponent, opponentSource
				.replace('Mismagius @ Heavy-Duty Boots', 'Mismagius @ Leftovers')
				.replace('Tera Type: Steel', 'Tera Type: Dragon'));
			first.raw.opponentTeams[0].teamPath = alternativeOpponent;
			fs.writeFileSync(secondRequest, `${JSON.stringify(first.raw, null, 2)}\n`);
			const thirdPrepared = prepareMatchupSearch({
				requestPath: secondRequest, outputDirectory: path.join(temporaryRoot, 'third'), preset: 'quick',
			});
			assert.equal(firstPrepared.beliefHash, thirdPrepared.beliefHash);
			assert.notEqual(secondPrepared.manifestHash, thirdPrepared.manifestHash);
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	it('keeps full-roster captain hypotheses when the submitted six brings neither captain', () => {
		const temporaryRoot = temporary('bench-captains');
		try {
			const { raw, requestPath } = copyRequest(temporaryRoot);
			raw.candidateParticipant.roster.push({ species: 'Arboliva', cost: 3 }, { species: 'Clawitzer', cost: 2 });
			raw.candidateParticipant.teraCaptains = ['Arboliva', 'Clawitzer'];
			fs.writeFileSync(requestPath, `${JSON.stringify(raw, null, 2)}\n`);
			const prepared = prepareMatchupSearch({
				requestPath, outputDirectory: path.join(temporaryRoot, 'compiled'), preset: 'quick',
			});
			const manifest = loadTeamSearchManifest(prepared.manifestPath);
			assert.deepEqual(manifest.validationErrors, []);
			assert(manifest.adamCandidates.every(team => team.teraCaptains.length === 0));
			assert(manifest.belief.sets.charizard.every(set => set.teraType === null));
			assert(manifest.belief.sets.sandslash.every(set => set.teraType === null));
			assert.deepEqual(new Set(manifest.belief.sets.arboliva.map(set => set.teraType)),
				new Set(['Grass', 'Normal', 'Fairy', 'Water']));
			assert.deepEqual(manifest.belief.teams.adam.teraCaptains, ['arboliva', 'clawitzer']);
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	it('is deterministic, refuses overwrite, and keeps legacy manifest identity stable', () => {
		const temporaryRoot = temporary('deterministic-prep');
		try {
			const { requestPath } = copyRequest(temporaryRoot);
			const first = prepareMatchupSearch({ requestPath, outputDirectory: path.join(temporaryRoot, 'one'), preset: 'quick' });
			const second = prepareMatchupSearch({ requestPath, outputDirectory: path.join(temporaryRoot, 'two'), preset: 'quick' });
			assert.equal(first.beliefHash, second.beliefHash);
			assert.equal(first.manifestHash, second.manifestHash);
			assert.throws(() => prepareMatchupSearch({ requestPath, outputDirectory: path.join(temporaryRoot, 'one'), preset: 'quick' }), /already exists/);
			const legacy = loadTeamSearchManifest(legacyManifest);
			assert.equal(legacy.manifestHash, '745d81ec2f6d8e21b1a7e0283027ecab04a812b093aa8cefc4e53f8a996da37a');
			assert.equal(legacy.beliefHash, 'fa78e5b733946b2cc08967561c5a790b749bb6fc245813ad81bead7318f0cbf6');
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	it('rejects malformed registrations with participant-specific diagnostics', () => {
		const temporaryRoot = temporary('invalid-matchup');
		try {
			const { raw, requestPath } = copyRequest(temporaryRoot);
			raw.opponentParticipant.id = 'AURORA';
			fs.writeFileSync(requestPath, `${JSON.stringify(raw, null, 2)}\n`);
			assert.throws(() => loadMatchupSearchRequest(requestPath), /participant IDs.*distinct/i);

			raw.opponentParticipant.id = 'borealis';
			raw.opponentParticipant.roster[2].species = raw.candidateParticipant.roster[0].species;
			raw.opponentParticipant.roster[2].cost = raw.candidateParticipant.roster[0].cost;
			fs.writeFileSync(requestPath, `${JSON.stringify(raw, null, 2)}\n`);
			assert.throws(() => loadMatchupSearchRequest(requestPath), /rosters overlap.*Charizard/i);

			raw.opponentParticipant.roster[2].species = 'Copperajah';
			raw.opponentParticipant.roster[2].cost = 8;
			raw.candidateParticipant.teraCaptains = ['Charizard'];
			fs.writeFileSync(requestPath, `${JSON.stringify(raw, null, 2)}\n`);
			assert.throws(() => loadMatchupSearchRequest(requestPath), /exactly two.*Tera captains/i);
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	it('bundles complete normalized public usage coverage and propagates neutral role labels', async () => {
		const catalogue = require('../../../pdl/team-search/data/public-usage-v1.json');
		assert.equal(catalogue.source.speciesCount, 150);
		assert.equal(Object.keys(catalogue.species).length, 150);
		assert.equal(catalogue.source.sourceSha256, '9e28815c6f4662aba08d2cc34ed09a9aacdc07ec2890a86e2c9f7be144a475d9');
		for (const [species, usage] of Object.entries(catalogue.species)) {
			assert(usage.moves.length, `${species} moves`);
			assert(usage.abilities.length, `${species} abilities`);
			assert(usage.items.length, `${species} items`);
			assert(usage.spreads.length, `${species} spreads`);
		}

		const temporaryRoot = temporary('role-aliases');
		try {
			const { requestPath } = copyRequest(temporaryRoot);
			const prepared = prepareMatchupSearch({ requestPath, outputDirectory: path.join(temporaryRoot, 'compiled'), preset: 'quick' });
			const dryRun = path.join(temporaryRoot, 'dry-run');
			await runTeamSearch({
				manifestPath: prepared.manifestPath,
				preset: 'quick',
				foulRoot: path.resolve(root, '../pdl-s4-foul-play'),
				outputDirectory: dryRun,
				dryRun: true,
				resume: false,
				timeoutMs: 600_000,
			});
			const summary = JSON.parse(fs.readFileSync(path.join(dryRun, 'summary.json'), 'utf8'));
			const resolved = JSON.parse(fs.readFileSync(path.join(dryRun, 'manifest.resolved.json'), 'utf8'));
			assert.deepEqual(summary.roleAliases, resolved.roleAliases);
			assert.equal(summary.roleAliases.adam.label, 'Hypothetical Aurora');
			assert.equal(summary.roleAliases.steve.label, 'Hypothetical Borealis');
			assert.equal(summary.runnerCalls, 0);
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});
});
