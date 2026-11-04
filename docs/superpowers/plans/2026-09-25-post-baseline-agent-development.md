# Post-Baseline Agent Development Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a measurable sequence from mechanics conformance to robust imperfect-information search without changing all strategic subsystems at once.

**Architecture:** Keep local Showdown as the deterministic authority and the v1 hardened runtime as the control. Add a conformance harness at the simulator boundary, then make Foul Play beliefs and sampled worlds explicit serializable values. Pathology tests consume the attested evaluator and public decision evidence, while controlled A/B runs use identical truth, battle randomness, and world-allocation inputs.

**Tech Stack:** TypeScript local Pokémon Showdown, Python Foul Play, instrumented Rust `poke-engine` 0.0.48, pytest, Mocha.

**Spec:** `docs/superpowers/specs/2026-09-25-post-baseline-agent-development.md`

## Global Constraints

- Preserve `pdl-hardened-baseline-v1` as the control; new results must identify the candidate runtime version.
- Showdown is authoritative for mechanics and battle transitions.
- No agent-visible object, log, process argument, or world sampler may contain opponent hidden truth.
- Runtime stays local-only and zero-token.
- Evaluation runs use deterministic argmax; exploratory stochastic modes must be explicitly named and cannot be aggregated with evaluation results.
- Unseen legal sets remain available after prior contradiction.
- Each task ships separately with its own focused tests and evidence artifact.

## Review Focus

- Damage tests must distinguish exact HP observations from Showdown percentage displays and rounding; Task 1 owns both fixture variants.
- Turn-order tests must exclude priority, Trick Room, and temporary speed effects before asserting a raw speed inequality; Task 1 owns those exclusions.
- Belief updates may never eliminate a legal hypothesis based only on an absent effect whose trigger or visibility is uncertain; Task 2 owns this.
- World allocation must not create item/move/EV combinations that no correlated hypothesis permits; Task 3 owns this.
- Pathology regressions must show candidate values and evaluator terms before asserting that a choice improved; Task 4 owns this.

---

### Task 1: Establish the Showdown–poke-engine mechanics conformance suite

**Files:**
- Create: `pdl/conformance/showdown-fixture.ts`
- Create: `pdl/conformance/poke-engine-probe.py`
- Create: `test/pdl/conformance/mechanics.js`
- Create: `docs/pdl-mechanics-conformance.md`
- Modify: `package.json`
- Modify: `pdl/batch/runtime.ts`

**Interfaces:**
- Consumes: a deterministic Showdown fixture with private submitted teams and a public protocol trace.
- Produces: `ConformanceCaseResult { id, showdown, pokeEngine, comparison, runtime }` without hidden sets in the public result.
- Produces: `npm run pdl:test-mechanics-conformance`.

- [ ] **Step 1: Write failing fixtures for ordinary damage, all damage rolls, STAB, Tera, weather, burn, screens, critical hits, stat stages, Choice items, Life Orb, Assault Vest, Focus Sash/Sturdy, hazards/Boots, Rapid Spin, priority, Trick Room, and the PDL roster abilities.**

- [ ] **Step 2: Run the fixture test before implementing the probe.**

  Run: `npx mocha test/pdl/conformance/mechanics.js`

  Expected: FAIL because the conformance harness does not exist.

- [ ] **Step 3: Implement deterministic Showdown execution and an instrumented-poke-engine probe.**

  The harness must compare only values available to each mechanism: damage roll sets, legal action availability, selected state-transition outcome, and speed/order constraints. It must record whether a comparison is exact, range-compatible, or intentionally unsupported.

- [ ] **Step 4: Add one machine-readable report per fixture and document every currently unsupported comparison.**

- [ ] **Step 5: Run the focused suite and the full simulator test suite.**

- [ ] **Step 6: Commit.**

### Task 2: Replace candidate-elimination state with evidence-backed beliefs

**Files:**
- Create: `fp/pdl/belief_state.py`
- Create: `fp/pdl/evidence.py`
- Modify: `fp/pdl/belief_data.py`
- Modify: `fp/pdl/observation.py`
- Modify: `fp/battle/protocol.py`
- Modify: `fp/battle/inference.py`
- Create: `tests/test_pdl_belief_state.py`
- Create: `tests/test_pdl_evidence.py`

**Interfaces:**
- Consumes: `ObservedBattleState` and a versioned set prior.
- Produces: `BeliefState.apply(observation) -> BeliefDelta`, `PokemonBelief`, and serializable evidence records.
- Produces: `sampleable_hypotheses()` containing hard constraints, posterior weight, and provenance.

- [ ] **Step 1: Write failing tests for move, item, ability, Tera, damage, and speed observations.**

  Include exact direct reveals, uncertain non-activation, one-vs-two damage observations, speed tie preservation, and a legal unseen-set contradiction fallback.

- [ ] **Step 2: Implement immutable evidence records and hard constraints.**

  `EvidenceRecord(turn, source, observation, variables, kind, likelihood)` must distinguish mechanical facts from soft posterior weight changes.

- [ ] **Step 3: Implement correlated candidate hypotheses with smoothing and a broad legal fallback.**

  Direct contradictions eliminate a hypothesis; an unknown prior has low but nonzero mass when legal and evidence-consistent.

- [ ] **Step 4: Route protocol events through the belief update API and extend decision evidence logs with belief deltas.**

- [ ] **Step 5: Run focused inference tests, hidden-marker tests, and the zero-token battle.**

- [ ] **Step 6: Commit.**

### Task 3: Add correlated, stratified, adaptive search-world allocation

**Files:**
- Create: `fp/pdl/world_sampling.py`
- Modify: `fp/search/standard_battles.py`
- Modify: `fp/search/main.py`
- Modify: `fp/config.py`
- Create: `tests/test_pdl_world_sampling.py`

**Interfaces:**
- Consumes: `BeliefState.sampleable_hypotheses()`, deterministic allocation seed, and search budget.
- Produces: `WorldAllocation { worlds, weights, strata, seed, coverage }`.

- [ ] **Step 1: Write failing tests for weighted representation, no duplicate high-impact worlds unless required, joint item/move/EV consistency, and deterministic allocation.**

- [ ] **Step 2: Implement strata by posterior archetype and strategic-impact signature.**

  Guarantee one allocation slot to each material hypothesis before proportional residual allocation; record every excluded low-impact stratum and why.

- [ ] **Step 3: Add adaptive allocation using posterior entropy and action-value disagreement, without inspecting hidden truth.**

- [ ] **Step 4: Replace the existing PDL world preparation path and log allocation metadata per decision.**

- [ ] **Step 5: Run world-sampling, observation-boundary, and full offline runtime tests.**

- [ ] **Step 6: Commit.**

### Task 4: Diagnose and regress pathological strategic positions

**Files:**
- Create: `pdl/regressions/pathological-positions.ts`
- Create: `pdl/cli/replay-pathology.ts`
- Create: `test/pdl/regressions/pathological-positions.js`
- Create: `tests/fixtures/pdl-pathologies/`
- Modify: `fp/search/main.py`
- Modify: `pdl/batch/evidence.ts`

**Interfaces:**
- Consumes: public pre-decision observation, belief snapshot, deterministic world allocation, and budget.
- Produces: `PathologyReplay { candidateActions, support, values, evaluator, horizon, worlds, selected }`.

- [ ] **Step 1: Extract the Growth/Grimmsnarl, Rocks/Spin, Slack Off attack-loop, and irrational Tera/switch positions into versioned fixtures.**

- [ ] **Step 2: Write failing regression tests that require complete diagnostics at 250, 500, 1,500, and 5,000 ms.**

- [ ] **Step 3: Implement replay and evidence capture without prescribing a move choice.**

  Each report must make it possible to attribute behavior to evaluator terms, search horizon, policy support, repeated-state dynamics, or unresolved uncertainty.

- [ ] **Step 4: Make one targeted correction at a time, starting only after the trace identifies a cause.**

- [ ] **Step 5: Run the pathology suite at every budget and record before/after artifacts.**

- [ ] **Step 6: Commit each independently attributable correction.**

### Task 5: Run controlled baseline-versus-candidate comparisons

**Files:**
- Create: `pdl/cli/compare-agent-versions.ts`
- Create: `pdl/analysis/paired-comparison.ts`
- Create: `test/pdl/cli/compare-agent-versions.js`
- Create: `test/pdl/analysis/paired-comparison.js`
- Modify: `pdl/batch/types.ts`
- Modify: `pdl/batch/evidence.ts`

**Interfaces:**
- Consumes: baseline/candidate runtime identifiers, fixed teams, fixed truth selection, fixed Showdown RNG seed, and fixed belief/world allocation seeds.
- Produces: paired result records, discordant counts, confidence interval, and diagnostic links.

- [ ] **Step 1: Write failing tests that reject missing seeds, unmatched runtime contracts, and accidental M0 input.**

- [ ] **Step 2: Implement a paired-run manifest that records common random inputs separately from agent-version inputs.**

- [ ] **Step 3: Implement paired aggregation and require both forward and reverse outcomes before reporting a result.**

- [ ] **Step 4: Run a small fixed-seed comparison against `pdl-hardened-baseline-v1`; do not run a large matchup batch.**

- [ ] **Step 5: Commit.**

## Self-Review

The plan preserves the requested order: mechanics conformance gates belief work, beliefs gate world sampling, and neither evaluator tuning nor large simulations begin before targeted pathologies and paired comparison. It maintains the observation boundary, local-only runtime, and explicit separation of hard constraints from priors. Each review-focus condition is owned by a task with a concrete test. No task uses submitted hidden truth for belief repair or action selection.

## Execution Handoff

Plan complete. Implement Task 1 first; Tasks 2–5 remain blocked on its conformance report and may not be merged into the same change set.
