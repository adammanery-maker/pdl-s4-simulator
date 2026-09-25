# PDL S4 Showdown Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, pinned prototype that validates explicitly supplied PDL teams and runs reproducible Gen 9 National Dex battles through Pokémon Showdown.

**Architecture:** Pokémon Showdown commit `2180a5c998b9c930863c5734ab7500bbd301952a` is the mechanics authority. A small PDL adapter validates roster ownership and PDL-specific Tera policy before Showdown validates standard game legality and executes a battle through `BattleStream`.

**Tech Stack:** Node.js, TypeScript, Pokémon Showdown simulator, Mocha.

## Global Constraints

- Work only in this standalone local simulator checkout; do not touch the PDL web application.
- Pin and retain Pokémon Showdown revision `2180a5c998b9c930863c5734ab7500bbd301952a` (2026-01-30 UTC).
- Use Gen 9 National Dex mechanics, January 2026 Gen 9 NU non-tier restrictions, and no Mega Evolution, Z-Moves, or Dynamax.
- Pokémon eligibility comes exclusively from the submitted PDL roster manifest; do not ban Pokémon by Smogon tier.
- Only Pokémon costing at most four may Terastallize, into a native type or either drafted team Tera type.
- Keep all battle decisions and RNG authoritative to Showdown; record the input seed, protocol log, teams, format ID, and Showdown commit.

---

### Task 1: Pin the source and define the PDL format

**Files:**
- Modify: `config/formats.ts`
- Create: `pdl/format.ts`
- Test: `test/pdl/format.js`

**Interfaces:**
- Produces `PDL_FORMAT_ID = 'gen9pdls4'`.
- Produces `PDL_NU_NON_TIER_BANS`, containing `Arena Trap`, `Moody`, `Shadow Tag`, `King's Rock`, `Razor Fang`, `Baton Pass`, `Last Respects`, `Shed Tail`, `Light Clay`, `Drought`, and `Quick Claw`.

- [ ] **Step 1: Write failing format tests**

```js
assert.strictEqual(Dex.formats.get('gen9pdls4').exists, true);
assert.deepStrictEqual(
  TeamValidator.get('gen9pdls4').validateTeam(Teams.import('Toxtricity @ Choice Specs\nAbility: Punk Rock\nTera Type: Electric\n- Overdrive')),
  null,
);
```

- [ ] **Step 2: Run the test and verify it fails because `gen9pdls4` is absent.**

Run: `npx mocha test/pdl/format.js`

- [ ] **Step 3: Add the minimal custom Showdown format.**

Use National Dex data/modification, enforce Team Preview and six Pokémon, preserve NU clauses (including `Sleep Moves Clause` rather than Sleep Clause Mod), preserve the January NU non-tier bans above, and add explicit set validators rejecting Mega Stones, Z-Crystals, Mega/Primal/Ultra forms, and Dynamax-capable mechanics.

- [ ] **Step 4: Run the format test and static checks.**

Run: `npx mocha test/pdl/format.js && npm run tsc`

- [ ] **Step 5: Commit.**

```bash
git add config/formats.ts pdl/format.ts test/pdl/format.js
git commit -m "feat: add pinned PDL S4 Showdown format"
```

### Task 2: Add roster and Tera pre-validation

**Files:**
- Create: `pdl/types.ts`
- Create: `pdl/validate-team.ts`
- Test: `test/pdl/validate-team.js`

**Interfaces:**
- Consumes `PdlLeagueSnapshot`, `PdlSide`, and packed or unpacked Showdown team input.
- Produces `validatePdlTeam(input): string[]`, returning all user-actionable violations and no errors for a valid six.

- [ ] **Step 1: Write failing validation tests.**

```js
assert.deepStrictEqual(validatePdlTeam(validInput), []);
assert.match(validatePdlTeam(teamWithOpponentPokemon)[0], /not on Adam's current roster/);
assert.match(validatePdlTeam(teamWithFivePokemon)[0], /exactly six Pokémon/);
assert.match(validatePdlTeam(overFourPointTera)[0], /cost 5.*cannot Terastallize/);
assert.match(validatePdlTeam(invalidTeraType)[0], /must be native or drafted/);
```

- [ ] **Step 2: Run the test and verify it fails because `validatePdlTeam` is absent.**

Run: `npx mocha test/pdl/validate-team.js`

- [ ] **Step 3: Implement the manifest-only validator.**

Match species by Showdown IDs, reject duplicate species and non-owned Pokémon, require exactly six team members, look up each member's cost and native types from Showdown Dex, and apply the user-approved cost/type Tera policy. Do not encode a static PDL roster in production code; tests own their fixture manifest.

- [ ] **Step 4: Run validation tests.**

Run: `npx mocha test/pdl/validate-team.js`

- [ ] **Step 5: Commit.**

```bash
git add pdl/types.ts pdl/validate-team.ts test/pdl/validate-team.js
git commit -m "feat: validate PDL roster ownership and tera policy"
```

### Task 3: Execute deterministic scripted battles and retain records

**Files:**
- Create: `pdl/simulate.ts`
- Create: `pdl/types.ts` (extend)
- Test: `test/pdl/simulate.js`

**Interfaces:**
- Consumes `simulatePdlBattle({league, p1, p2, seed})`.
- Produces `{winner, seed, formatId, showdownCommit, protocolLog, p1Team, p2Team, choices}`.

- [ ] **Step 1: Write failing execution tests.**

```js
const first = await simulatePdlBattle(validBattle);
const second = await simulatePdlBattle(validBattle);
assert.strictEqual(first.winner, second.winner);
assert.deepStrictEqual(first.protocolLog, second.protocolLog);
assert.strictEqual(first.seed, validBattle.seed);
assert.match(first.protocolLog.join('\n'), /\|win\|/);
```

- [ ] **Step 2: Run the test and verify it fails because `simulatePdlBattle` is absent.**

Run: `npx mocha test/pdl/simulate.js`

- [ ] **Step 3: Implement the narrow BattleStream orchestrator.**

First invoke PDL validation, then Showdown `TeamValidator`, then use `BattleStream`/`getPlayerStreams`. Use the upstream random player agent only as the initial deterministic scripted policy, record every selected command, supply the given battle seed in the start spec, consume the omniscient stream to completion, and extract the winner only from the final Showdown protocol output.

- [ ] **Step 4: Run the execution test.**

Run: `npx mocha --timeout 15000 test/pdl/simulate.js`

- [ ] **Step 5: Commit.**

```bash
git add pdl/simulate.ts pdl/types.ts test/pdl/simulate.js
git commit -m "feat: run reproducible PDL Showdown battles"
```

### Task 4: Add a runnable local acceptance command and documentation

**Files:**
- Create: `pdl/examples/fixture-league.ts`
- Create: `pdl/examples/run.ts`
- Modify: `package.json`
- Create: `README-PDL.md`
- Test: `test/pdl/acceptance.js`

**Interfaces:**
- Produces `npm run pdl:acceptance`, which validates a legal team, rejects each required illegal class, runs two fixed-seed battles, and writes no runtime state.

- [ ] **Step 1: Write the failing acceptance test.**

```js
const result = await runAcceptanceFixture();
assert.strictEqual(result.legalTeamAccepted, true);
assert.strictEqual(result.illegalTeamRejected, true);
assert.strictEqual(result.replayReproducible, true);
assert.strictEqual(result.finishedBattles, 2);
```

- [ ] **Step 2: Run it and verify it fails because the runner is absent.**

Run: `npx mocha --timeout 30000 test/pdl/acceptance.js`

- [ ] **Step 3: Implement the fixture and command.**

Document the January 2026 snapshot, every rule implemented, the PDL roster-manifest boundary, recorded fields, and deliberate exclusions: roster-to-six selection, set generation, web API, production deployment, persistent database, advanced agents, and probability calibration.

- [ ] **Step 4: Run focused and complete verification.**

Run: `npm run pdl:acceptance && npm test && npm run tsc`

- [ ] **Step 5: Commit.**

```bash
git add pdl pdl/examples test/pdl package.json README-PDL.md
git commit -m "docs: document PDL S4 simulator prototype"
```

## Self-Review

- The plan retains one authoritative mechanics engine, uses the exact month-end Showdown source, and makes the league-only policy explicit outside of generic Showdown rules.
- It does not introduce roster selection, set generation, external agents, services, containers, website integration, persistence, or calibration.
- Each required acceptance condition has a direct test target, including fixed-seed reproducibility and legal/illegal validation.
