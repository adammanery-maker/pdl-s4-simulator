# PDL Local Batch Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run reproducible, high-volume PDL roster simulations locally and produce auditable matchup, Pokémon, set, move, and teammate-combination reports.

**Architecture:** The simulator checkout owns immutable PDL snapshots, sample generation, per-trial artifacts, orchestration, log parsing, aggregation, and static reports. The separate Foul Play checkout adds only a raw received-protocol capture option; it still uses the pinned local Showdown server as its battle authority. The production PDL application is read-only through its public roster endpoint and is never modified.

**Tech Stack:** Node.js/TypeScript, pinned local Pokémon Showdown, Python 3.11 Foul Play + poke-engine, JSONL, static HTML.

## Global Constraints

- All runtime artifacts are local under an explicit output directory; no Vercel, Redis, or PDL app writes.
- Every trial persists snapshot hash, PDL format version, Showdown commit, Foul revision/configuration, sampler seeds, packed teams, protocol transcript, and terminal status.
- Foul Play uses only local PDL belief data; no remote dataset fallback is allowed for `gen9pdls4`.
- Every sampled pair runs once on each player side; no incomplete trial is included in win-rate or attribution metrics.
- Reports show cohort counts and uncertainty; they do not label simple correlations as causal value.

---

### Task 1: Raw protocol capture in Foul Play

**Files:**
- Modify: `../pdl-s4-foul-play/fp/config.py`
- Modify: `../pdl-s4-foul-play/fp/run_battle.py`
- Test: `../pdl-s4-foul-play/tests/test_protocol_capture.py`

**Interfaces:**
- Consumes: optional `--protocol-log-path <absolute path>`.
- Produces: one newline-delimited raw Showdown message transcript per Foul client.

- [ ] **Step 1: Write failing tests**

```python
def test_protocol_capture_writes_each_received_message(tmp_path):
    capture = ProtocolCapture(tmp_path / "battle.protocol")
    capture.append(">battle-gen9pdls4-1\n|move|p1a: Golem|Earthquake|p2a: Muk")
    assert capture.path.read_text() == ">battle-gen9pdls4-1\n|move|p1a: Golem|Earthquake|p2a: Muk\n"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_protocol_capture.py -q`

Expected: FAIL because protocol capture does not exist.

- [ ] **Step 3: Implement the smallest capture interface**

Add `protocol_log_path: str | None` to config. Create a `ProtocolCapture` that opens an explicit local output path, appends exact received websocket messages, and closes in `finally` when the battle returns or raises. Wire it around `receive_message()` in `pokemon_battle`.

- [ ] **Step 4: Run focused and full Foul verification**

Run: `.venv/bin/ruff check && .venv/bin/pytest tests -q`

Expected: all existing tests plus the capture test pass.

- [ ] **Step 5: Commit**

```bash
git -C ../pdl-s4-foul-play add fp/config.py fp/run_battle.py tests/test_protocol_capture.py
git -C ../pdl-s4-foul-play commit -m "feat: capture local battle protocols"
```

### Task 2: Versioned trial artifact and local process runner

**Files:**
- Create: `pdl/batch/types.ts`
- Create: `pdl/batch/artifacts.ts`
- Create: `pdl/batch/run-trial.ts`
- Test: `test/pdl/batch/artifacts.js`
- Test: `test/pdl/batch/run-trial.js`

**Interfaces:**
- Consumes: normalized `PdlSamplingSnapshot`, team IDs, seeds, explicit Foul root, search budget, and per-battle timeout.
- Produces: `TrialRecord` with `completed | rejected | failed | timed_out`, paths to immutable inputs/transcripts, side assignment, and winner only for completed trials.

- [ ] **Step 1: Write failing artifact tests**

```js
it('creates isolated inputs and records a rejected illegal sample without a winner', () => {
  const trial = createTrialArtifact(fixture);
  assert.equal(trial.status, 'rejected');
  assert.equal(trial.winner, null);
  assert.match(trial.failureReason, /invalid/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run tsc && npx mocha test/pdl/batch/artifacts.js --timeout 30000`

Expected: FAIL because the batch artifact module does not exist.

- [ ] **Step 3: Implement immutable per-trial layout**

Create `<output>/trials/<trial-id>/` containing `belief.json`, both packed/exported teams, `manifest.json`, each agent's stdout/stderr, protocol transcript, and a final `result.json`. Generate trial IDs from pair index, side, seeds, and snapshot hash. Start a dedicated local Showdown port, spawn exactly two Foul processes with absolute team paths, stop all children on completion/error/timeout, and never count a partial result.

- [ ] **Step 4: Run focused tests**

Run: `npm run tsc && npx mocha test/pdl/batch/artifacts.js test/pdl/batch/run-trial.js --timeout 30000`

Expected: PASS using a fake process boundary for timeout/cleanup and real artifact serialization.

- [ ] **Step 5: Commit**

```bash
git add pdl/batch/types.ts pdl/batch/artifacts.ts pdl/batch/run-trial.ts test/pdl/batch
git commit -m "feat: add reproducible local simulation trials"
```

### Task 3: Protocol-to-event normalization and aggregation

**Files:**
- Create: `pdl/analysis/protocol-events.ts`
- Create: `pdl/analysis/aggregate.ts`
- Create: `pdl/analysis/intervals.ts`
- Test: `test/pdl/analysis/protocol-events.js`
- Test: `test/pdl/analysis/aggregate.js`

**Interfaces:**
- Consumes: completed `TrialRecord` plus a side-to-team mapping and its primary Foul protocol transcript.
- Produces: `BattleEventRecord` and `SimulationSummary` with records for teams, Pokémon, exact sets, moves, leads, Tera, and unordered teammate pairs.

- [ ] **Step 1: Write failing protocol parser tests**

```js
it('attributes moves, KOs, leads, switches, Tera and winner to the correct PDL team', () => {
  const parsed = parseBattleProtocol(protocolFixture, mapping);
  assert.equal(parsed.leads.adam, 'golem');
  assert.equal(parsed.moves[0].move, 'earthquake');
  assert.equal(parsed.tera[0].species, 'muk');
  assert.equal(parsed.winnerTeamId, 'adam');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run tsc && npx mocha test/pdl/analysis/protocol-events.js --timeout 30000`

Expected: FAIL because the parser does not exist.

- [ ] **Step 3: Implement lossless event parsing**

Parse only known Showdown protocol lines (`player`, `switch`/`drag`, `move`, `-damage`, `faint`, `-terastallize`, `win`, `tie`). Preserve unmatched lines for audit. Resolve p1/p2 to PDL team IDs using the trial manifest rather than display-name guessing.

- [ ] **Step 4: Implement matched aggregation**

Aggregate completed paired trials only. Calculate team records; Pokémon/set appearance and record; moves used, damage, KO count, and record; leads; Tera; and same-six teammate pairs. For every rate expose completed sample count and a Wilson interval. Mark all rankings descriptive until a later matched counterfactual estimator exists.

- [ ] **Step 5: Run focused analysis tests**

Run: `npm run tsc && npx mocha test/pdl/analysis --timeout 30000`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pdl/analysis test/pdl/analysis
git commit -m "feat: analyze local PDL simulation events"
```

### Task 4: Batch command and static report

**Files:**
- Create: `pdl/cli/simulate-matchup.ts`
- Create: `pdl/report/render.ts`
- Modify: `package.json`
- Modify: `README-PDL.md`
- Test: `test/pdl/report/render.js`
- Test: `test/pdl/cli/simulate-matchup.js`

**Interfaces:**
- Consumes: `--live-url` or `--snapshot`, `--team-a`, `--team-b`, `--battles`, `--search-ms`, `--output`, and `--foul-root`.
- Produces: `summary.json`, `trials.jsonl`, `report.html`, and preserved trial folders; exits non-zero if no paired completed trials exist.

- [ ] **Step 1: Write failing report tests**

```js
it('renders team, Pokémon, set, move, Tera, lead and teammate tables with samples', () => {
  const html = renderReport(summary);
  for (const heading of ['Team record', 'Pokémon records', 'Exact sets', 'Moves', 'Teammate pairs']) {
    assert.match(html, new RegExp(heading));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run tsc && npx mocha test/pdl/report/render.js --timeout 30000`

Expected: FAIL because the report renderer does not exist.

- [ ] **Step 3: Implement CLI**

Validate all arguments; fetch the public roster URL only when `--live-url` is supplied; convert it immediately to a frozen snapshot; run a deterministic sequence of sampled pair seeds; execute each pair twice with swapped player sides; stream append-only `trials.jsonl`; aggregate only complete pairs; write JSON and self-contained HTML.

- [ ] **Step 4: Implement report copy and tables**

Show the snapshot/version manifest and explicitly separate completed, rejected, failed, and timed-out trials. Label rankings "descriptive simulation association" and include sample count/interval. Include direct links to each trial's manifest and protocol transcript.

- [ ] **Step 5: Run unit verification**

Run: `npm run tsc && npx mocha test/pdl/cli/simulate-matchup.js test/pdl/report/render.js --timeout 30000`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pdl/cli pdl/report test/pdl/cli test/pdl/report package.json README-PDL.md
git commit -m "feat: add local PDL simulation reports"
```

### Task 5: End-to-end local smoke batch

**Files:**
- No source changes required unless a test exposes a defect.

- [ ] **Step 1: Compile and run all simulator tests**

Run: `npm run tsc && npx mocha test/pdl --timeout 30000`

Expected: PASS.

- [ ] **Step 2: Run full isolated Foul Play validation**

Run: `../pdl-s4-foul-play/.venv/bin/ruff check && ../pdl-s4-foul-play/.venv/bin/pytest ../pdl-s4-foul-play/tests -q`

Expected: PASS.

- [ ] **Step 3: Run a two-pair local live-data smoke batch**

Run:

```bash
npm run pdl:simulate -- \
  --live-url https://pdl-s4.vercel.app/api/roster-transactions \
  --team-a adam --team-b connor --battles 2 --search-ms 100 \
  --foul-root '../pdl-s4-foul-play' --output /private/tmp/pdl-s4-smoke
```

Expected: four side-balanced trials finish or are explicitly classified; `summary.json` and `report.html` exist, and no live PDL state changes.

- [ ] **Step 4: Commit documentation-only verification note if required**

```bash
git add README-PDL.md
git commit -m "docs: document local PDL simulation workflow"
```
