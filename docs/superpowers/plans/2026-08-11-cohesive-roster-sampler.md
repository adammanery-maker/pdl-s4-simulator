# Cohesive PDL Roster Sampler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce reproducible, legal, roster-cohesive six-Pokémon PDL teams from frozen PDL roster and usage snapshots.

**Architecture:** The sampler accepts explicit snapshots rather than reading Redis or the PDL application at runtime. It normalizes public usage data into weighted component choices, creates legal candidate sets, scores complete sixes jointly, and seeded-samples from the high-quality team distribution before existing Showdown execution validates and battles them.

**Tech Stack:** Node.js, TypeScript, Pokémon Showdown, Mocha, existing PDL generated JSON snapshots.

## Global Constraints

- Keep Pokémon Showdown commit `2180a5c998b9c930863c5734ab7500bbd301952a` as battle authority.
- Read PDL roster and usage data only from versioned snapshots; do not access production Redis or mutate the PDL web application.
- Never invent missing moves, abilities, items, natures, spreads, or Tera types.
- Use only a team's current roster and its two drafted Tera types.
- Expose only the opposing public roster to the sampler; no hidden sets or battle-state information.
- Retain snapshot hashes, source weights, selected build scores, sampler seed, and rejection reasons.

---

### Task 1: Define portable roster and usage snapshot contracts

**Files:**
- Create: `pdl/sampling/types.ts`
- Create: `pdl/sampling/snapshot.ts`
- Test: `test/pdl/sampling/snapshot.js`

**Interfaces:**
- Produces `normalizePdlSamplingSnapshot(input): PdlSamplingSnapshot`.
- Produces `hashSamplingSnapshot(snapshot): string`.
- `PdlSamplingSnapshot` contains `id`, `roster`, `usageBySpecies`, and no live-service dependencies.

- [ ] **Step 1: Write the failing snapshot tests**

```js
const snapshot = normalizePdlSamplingSnapshot(fixture);
assert.equal(snapshot.roster.teams[0].id, 'adam');
assert.equal(snapshot.usageBySpecies.tatsugiri.moves[0].name, 'Draco Meteor');
assert.equal(hashSamplingSnapshot(snapshot), hashSamplingSnapshot(snapshot));
assert.throws(() => normalizePdlSamplingSnapshot({...fixture, id: ''}), /snapshot id/);
```

- [ ] **Step 2: Run the test and verify it fails because the snapshot module is absent.**

Run: `npx mocha --no-config test/pdl/sampling/snapshot.js`

- [ ] **Step 3: Implement the immutable snapshot normalizer.**

Normalize Showdown IDs, reject duplicate roster species and negative/NaN usage weights, require exactly two drafted Tera types per team, and retain the original source identifier. Hash canonical JSON with Node's `crypto.createHash('sha256')`.

- [ ] **Step 4: Run snapshot tests and TypeScript.**

Run: `npx mocha --no-config test/pdl/sampling/snapshot.js && npm run tsc`

### Task 2: Generate legal weighted set candidates

**Files:**
- Create: `pdl/sampling/candidates.ts`
- Test: `test/pdl/sampling/candidates.js`

**Interfaces:**
- Consumes `generateSetCandidates({snapshot, teamId, species})`.
- Produces `SetCandidate[]`, each with `set`, `usageWeight`, `source`, and `rejectionReasons`.

- [ ] **Step 1: Write failing candidate tests**

```js
const candidates = generateSetCandidates({snapshot, teamId: 'adam', species: 'Tatsugiri'});
assert.equal(candidates.length > 0, true);
assert.equal(candidates.every(candidate => candidate.set.moves.length === 4), true);
assert.equal(candidates.every(candidate => candidate.set.ability === 'Storm Drain'), true);
assert.equal(candidates.some(candidate => candidate.set.teraType === 'Water'), true);
assert.equal(candidates.some(candidate => candidate.set.teraType === 'Fairy'), false);
```

- [ ] **Step 2: Run and verify the test fails because candidate generation is absent.**

Run: `npx mocha --no-config test/pdl/sampling/candidates.js`

- [ ] **Step 3: Implement bounded candidate generation.**

Take the top weighted legal values for each observed component, form bounded combinations, require four distinct moves, and use the existing PDL validator plus Showdown `TeamValidator` to reject invalid combinations. Permit Tera only under the existing PDL cost/type policy. Return a rejection record when a component source is absent or every combination is illegal.

- [ ] **Step 4: Run candidate tests.**

Run: `npx mocha --no-config test/pdl/sampling/candidates.js`

### Task 3: Score and sample cohesive sixes

**Files:**
- Create: `pdl/sampling/cohesion.ts`
- Create: `pdl/sampling/sample-team.ts`
- Test: `test/pdl/sampling/sample-team.js`

**Interfaces:**
- Consumes `sampleCohesiveTeam({snapshot, teamId, opponentTeamId, seed})`.
- Produces `{team, sampledSpecies, candidateScores, teamScore, samplerSeed, snapshotHash}`.

- [ ] **Step 1: Write failing cohesion and reproducibility tests**

```js
const first = sampleCohesiveTeam(input);
const second = sampleCohesiveTeam(input);
assert.deepEqual(first.team, second.team);
assert.equal(first.team.length, 6);
assert.equal(new Set(first.team.map(set => set.species)).size, 6);
assert.equal(first.candidateScores.some(score => score.components.roleCoverage > 0), true);
assert.equal(first.sampledSpecies.every(species => adamRoster.has(species)), true);
```

- [ ] **Step 2: Run and verify failure because cohesive sampling is absent.**

Run: `npx mocha --no-config test/pdl/sampling/sample-team.js`

- [ ] **Step 3: Implement the bounded joint scorer and weighted sampler.**

Construct sixes from per-species candidates, compute usage weight, role coverage, hazards/removal, speed control, physical/special balance, defensive typing, teammate affinity, and public-roster matchup coverage. Normalize these components into a documented team score. Use a seedable Showdown PRNG to sample only from the retained high-scoring distribution; never inspect opponent set candidates.

- [ ] **Step 4: Run sampler tests.**

Run: `npx mocha --no-config test/pdl/sampling/sample-team.js`

### Task 4: Connect sampled teams to battle records and a local command

**Files:**
- Modify: `pdl/simulate.ts`
- Modify: `pdl/types.ts`
- Create: `pdl/examples/sample-and-battle.ts`
- Modify: `package.json`
- Modify: `README-PDL.md`
- Test: `test/pdl/sampling/integration.js`

**Interfaces:**
- Produces `simulateSampledPdlBattle({snapshot, p1TeamId, p2TeamId, samplerSeed, battleSeed})`.
- Battle record includes both `p1Sample` and `p2Sample` with snapshot hash and selected builds.

- [ ] **Step 1: Write the failing integration test**

```js
const result = await simulateSampledPdlBattle(input);
assert.equal(result.winner.length > 0, true);
assert.equal(result.p1Sample.snapshotHash, result.p2Sample.snapshotHash);
assert.equal(result.p1Sample.team.length, 6);
assert.equal(result.protocolLog.some(chunk => chunk.includes('|win|')), true);
```

- [ ] **Step 2: Run and verify failure because sampled battle execution is absent.**

Run: `npx mocha --no-config test/pdl/sampling/integration.js`

- [ ] **Step 3: Implement the adapter and command.**

Sample both sides from the same frozen snapshot, pass their exact builds to existing `simulatePdlBattle`, and retain both sample records without altering the existing explicit-team path. Add `npm run pdl:sample-battle` using a checked-in fixture snapshot and document the inputs, output fields, and known limits.

- [ ] **Step 4: Run full verification.**

Run: `npm run lint && npm run tsc && npm run pdl:acceptance && npx mocha --no-config test/pdl/**/*.js && npm test`

## Self-review

- Snapshot contracts, candidate generation, joint team sampling, and Showdown execution are separated and independently testable.
- Every generated component comes from observed PDL usage data and passes PDL/Showdown validation.
- The plan does not introduce live production access, UI, persistence, advanced battle AI, probability presentation, or calibration.
