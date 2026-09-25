# PDL Experiment Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a local, deterministic scenario-plan command that schedules reusable PDL roster variants across balanced matchup cells.

**Architecture:** Add focused plan parser, variant resolver, and balanced scheduler modules above the existing sampler and batch runner. The experiment CLI resolves a frozen plan once, then delegates every scheduled pair to the existing local Showdown/Foul Play execution path and augments the existing aggregate/report artifacts with scenario identifiers.

**Tech Stack:** TypeScript, Node.js standard library, existing Pokémon Showdown sampler/validator, existing Foul Play adapter, Mocha tests.

## Global Constraints

- Operate only in `pdl-s4-simulator`; do not modify the PDL site, Vercel, Redis, or Foul Play checkout.
- Use the frozen public roster endpoint only as a read source.
- Preserve the existing `pdl:simulate` command and its artifacts.
- Keep PDL/Showdown legality and Tera checks at the existing constraint-validation boundary.
- Count only completed forward/reverse pairs in rates.
- Do not silently approximate unsupported schedule strategies.

---

### Task 1: Plan model and strict parser

**Files:**
- Create: `pdl/experiments/types.ts`
- Create: `pdl/experiments/parse-plan.ts`
- Create: `test/pdl/experiments/parse-plan.js`
- Modify: `package.json`

**Interfaces:**
- Produces `parseExperimentPlan(text: string): ExperimentPlan`.
- Produces `readExperimentPlan(pathOrDash: string): ExperimentPlan`.
- `ExperimentPlan` contains `version`, `teams`, `schedule`, and `simulation`.

- [ ] **Step 1: Write failing parser tests**

```js
assert.equal(parseExperimentPlan(planText).schedule.strategy, 'balanced-cross');
assert.throws(() => parseExperimentPlan('version: 2'), /version 1/i);
assert.throws(() => parseExperimentPlan(duplicateVariantPlan), /duplicate variant id/i);
```

- [ ] **Step 2: Run parser tests to verify failure**

Run: `npx mocha --no-config test/pdl/experiments/parse-plan.js`

- [ ] **Step 3: Implement the minimal strict plan parser**

Use the project's pinned YAML dependency if present; otherwise add the small
`yaml` dependency. Reject unknown top-level keys, non-string IDs, non-positive
counts, duplicate team/variant IDs, and unsupported schedule values. Map
`locks`, `require`, and `exclude` into `PdlTeamSelectionConstraints`.

- [ ] **Step 4: Run parser tests to verify pass**

Run: `node build && npx mocha --no-config test/pdl/experiments/parse-plan.js`

### Task 2: Resolve deterministic distinct variants

**Files:**
- Create: `pdl/experiments/resolve-variants.ts`
- Create: `test/pdl/experiments/resolve-variants.js`

**Interfaces:**
- Consumes `ExperimentPlan`, `PdlSamplingSnapshot`.
- Produces `ResolvedExperimentPlan` with resolved packed/exported teams and normalized constraints.

- [ ] **Step 1: Write failing resolver tests**

```js
const resolved = resolveExperimentVariants({ plan, snapshot });
assert.equal(resolved.variants.length, 12);
assert.equal(new Set(resolved.variants.filter(v => v.teamId === 'connor').map(v => v.packed)).size, 8);
assert.throws(() => resolveExperimentVariants({ plan: impossiblePlan, snapshot }), /could not produce.*distinct/i);
```

- [ ] **Step 2: Run resolver tests to verify failure**

Run: `npx mocha --no-config test/pdl/experiments/resolve-variants.js`

- [ ] **Step 3: Implement variant resolution**

Resolve every variant exactly once via `sampleCohesiveTeam`, forwarding its
constraints. For full locks, require all six exact sets. For generated variants,
derive attempt seeds from the stable plan hash and variant ID, reject duplicate
packed teams for the same team, and stop after a documented fixed attempt cap.

- [ ] **Step 4: Run resolver tests to verify pass**

Run: `node build && npx mocha --no-config test/pdl/experiments/resolve-variants.js`

### Task 3: Balanced-cross schedule allocation

**Files:**
- Create: `pdl/experiments/schedule.ts`
- Create: `test/pdl/experiments/schedule.js`

**Interfaces:**
- Produces `buildBalancedCrossSchedule(resolvedPlan): ScheduledPair[]`.
- Every `ScheduledPair` has `pairId`, `cellId`, `leftVariantId`, `rightVariantId`.

- [ ] **Step 1: Write failing allocation tests**

```js
const schedule = buildBalancedCrossSchedule(resolvedEightByFourPlan);
assert.equal(schedule.length, 200);
assert.deepEqual(countBy(schedule, 'leftVariantId').values(), Array(8).fill(25));
assert.deepEqual(countBy(schedule, 'rightVariantId').values(), Array(4).fill(50));
assert.deepEqual([...countBy(schedule, 'cellId').values()].sort(), [...Array(24).fill(6), ...Array(8).fill(7)]);
```

- [ ] **Step 2: Run schedule tests to verify failure**

Run: `npx mocha --no-config test/pdl/experiments/schedule.js`

- [ ] **Step 3: Implement deterministic balanced allocation**

Require `totalPairs % leftVariantCount === 0` and `totalPairs % rightVariantCount === 0`. Allocate baseline cell counts then rotate the remainder across cells so every row and column receives the required extra count. Reject unsupported strategies with a direct error.

- [ ] **Step 4: Run schedule tests to verify pass**

Run: `node build && npx mocha --no-config test/pdl/experiments/schedule.js`

### Task 4: Experiment execution and artifacts

**Files:**
- Create: `pdl/cli/experiment.ts`
- Modify: `pdl/batch/types.ts`
- Modify: `pdl/batch/artifacts.ts`
- Modify: `pdl/analysis/aggregate.ts`
- Create: `test/pdl/cli/experiment.js`

**Interfaces:**
- Adds `npm run pdl:experiment -- --plan <path|->`.
- Trial metadata contains `leftVariantId`, `rightVariantId`, and `cellId`.
- `AnalysisTrial` carries optional scenario fields without breaking old runs.

- [ ] **Step 1: Write failing execution/artifact tests**

```js
const options = parseExperimentArguments(['--plan', '-']);
assert.equal(options.planPath, '-');
assert.equal(artifact.manifest.metadata.cellId, 'adam-sun__connor-core-1');
```

- [ ] **Step 2: Run execution tests to verify failure**

Run: `npx mocha --no-config test/pdl/cli/experiment.js`

- [ ] **Step 3: Implement the experiment CLI**

Read a file or standard input, load/freeze the snapshot once, resolve variants,
write `plan.source.yaml` and `plan.resolved.json`, schedule pairs, and reuse
`runFoulPlayTrial` twice per pair. Write progress after every trial. Do not
reuse the simple runner's generated teams.

- [ ] **Step 4: Run execution tests to verify pass**

Run: `node build && npx mocha --no-config test/pdl/cli/experiment.js`

### Task 5: Scenario aggregation, report, and documentation

**Files:**
- Modify: `pdl/analysis/aggregate.ts`
- Modify: `pdl/report/render.ts`
- Modify: `README-PDL.md`
- Create: `test/pdl/analysis/experiment-aggregate.js`
- Modify: `test/pdl/report/render.js`

**Interfaces:**
- `SimulationSummary` adds `variantRecords` and `cellRecords`.
- Report renders normalized plan, variant records, and cross-cell records.

- [ ] **Step 1: Write failing aggregation/report tests**

```js
assert.deepEqual(summary.variantRecords.find(row => row.id === 'adam-sun').appearances, 100);
assert.match(renderSimulationReport(summary), /Variant records/);
assert.match(renderSimulationReport(summary), /Cross-matchup cells/);
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx mocha --no-config test/pdl/analysis/experiment-aggregate.js test/pdl/report/render.js`

- [ ] **Step 3: Implement descriptive scenario tables and documentation**

Aggregate scenario records from eligible side-balanced trials only. Document the
heredoc terminal interface, constraints, balanced-cross math, saved artifacts,
and explicit refusal of currently unsupported schedule strategies.

- [ ] **Step 4: Run all targeted tests and static checks**

Run: `node build && npx mocha --no-config test/pdl/experiments/*.js test/pdl/cli/experiment.js test/pdl/analysis/experiment-aggregate.js test/pdl/report/render.js && npx tsc --noEmit && git diff --check`
