# Phase 5: current-engine planner architecture study

## Scope and conclusion

This is a diagnostic comparison, not a production change. The supplied
runtime-v2 artifacts remain ineligible for exact replay because their
observation digests cannot be reproduced by the hardened projection. The
comparison therefore uses new, fixed-seed v5 battles and identical frozen
inputs for native poke-engine MCTS and a diagnostic H8-NEUTRAL planner.

The study found material root-action disagreements. It did **not** establish
that H8 improves competitive sequencing. Six stable disagreements retained the
same H8 action at H4, H6, and H8; three changed with horizon. No continuation
was sufficiently adjudicated to call either planner clearer. No production
search, evaluator, belief, or normal study budget changed.

## Fidelity and Track A

`DecisionReplayBundle` remains fail closed for digest, request type, active
species, legal action, selected action, actor, and decision ordinal. There is
no force path.

Track A identified an older observation-projection source in retained history,
but the matching runtime dependency state is unavailable and the archived
digests still do not reproduce. The result is: **historical exact replay
unavailable; fresh hardened fixtures used for architecture comparison**.

The Phase 5A bookkeeping discrepancy is resolved in
[`pdl-phase-5a-decision-replay-gate.md`](pdl-phase-5a-decision-replay-gate.md):
the prior `15 passed` text was stale, the hand-off command had 16, and the
expanded current command has 26 tests.

## Fresh comparison corpus

The corpus is at
`pdl-s4-simulator/calculations/pdl-phase5-current-v5-corpus/`.

- 18 completed fixed-seed battles: three Adam teams × three Steve teams × both
  orientations.
- Battle-seed map SHA-256:
  `85c938dd063db17f01452a59e55138a46d1732447e543724b526b8786861c601`.
- 16 fixtures selected before planner outputs using the recorded category and
  source-order rule in `comparison-fixtures/selection.json`.
- The sample has two Sun previews, two Memento previews, two Sun positioning
  decisions, two Sunny Day decisions, four Drednaw/Memento decisions, one
  Growth decision, and three balance/control decisions.

These are diagnostic decisions, not a win-rate estimate. The 18 battles ended
Adam 10, Steve 8, with no ties.

## Canonical bundle and information boundary

Each version-2 bundle stores the actor, ordinal, request category and turn,
exact public observation serialization and digest, own legal actions, recorded
action, local belief/world seed, weighted serialized poke-engine worlds, and
runtime evaluator/engine fingerprints. Bundle verification rejects component
or whole-bundle tampering and rejects a ground-truth audit reference.

The diagnostic reads only a verified bundle. It has no protocol parser, team
file reader, belief-prior reader, network client, archived JavaScript runner,
or ground-truth audit input. Both planners consume the exact same frozen state,
weighted belief worlds, normalized root actions, and Tera gate. The gate is
applied after cross-world support aggregation, as in the live agent.

## Mechanics, evaluator, and H8 architecture

The isolated crate at `poke-engine/diagnostics/current-h8/` calls the current
poke-engine transition generator, instruction application/reversal, legal
action generator, terminal check, and `genx-static-v0.0.48-boost-relevance-v1`
evaluator. Its recorded engine source SHA-256 is
`13ac9863be2fb05143429b5bd2faaf2366dec4fce33e2764badce3f7a7b776c7` and
evaluator source SHA-256 is
`5c013486e9a07bb04f345518431e648a2884893e8a7acc69991c8a3f8bbde397`.

H8-NEUTRAL uses explicit H=8 forward simulation, PUCT `cpuct=1.25`, uniform
action priors, B=512, deterministic local branch sampling, and optional B=1024
when the specified aggregate Q near-tie condition is met. It has no strategic
or species-specific prior. Native configurations use exact current-engine
MCTS at 120,000 and 500,000 iterations. Their iteration counts are not treated
as comparable work units: per-world JSON records simulations, transitions,
leaf evaluations, terminal leaves, and reached-depth statistics where defined.

## Pilot and seed stability

All 16 fixtures ran NATIVE-120K, NATIVE-500K, H8-512, and H8-ADAPTIVE. The
raw reports are under `comparison-results/`; five fixed local planner seeds
per fixture are under `comparison-results/seeds/`.

- NATIVE-120K was action-stable for all 16 fixtures.
- NATIVE-500K was action-stable for 13/16; Growth and one Sunny Day decision
  changed across seeds.
- H8-512 was action-stable for 12/16; balance-status, balance-tactical,
  Growth, and one Sunny Day decision changed.
- Nine H8-512 actions were stable and disagreed with NATIVE-500K. Three of
  these are team-preview positions, whose current non-BSS poke-engine preview
  continuation path is not an adequate strategic adjudicator.

Stable non-preview disagreements include hazard control, a Drednaw Shell
Smash window, a Memento window, two Sun positioning decisions, and a Sunny Day
window. They show that architecture changes decisions, but not that one choice
creates a better line.

## Horizon and native-budget ablations

H4/H6 ran only on the nine stable H8 disagreements.

- H4/H6/H8 agreed for balance hazard control, Memento preview B, Sun
  positioning A/B, and both Sun previews.
- Drednaw Shell Smash changed at every horizon: H4 `crunch`, H6 `shellsmash`,
  H8 `switch magneton`.
- The Memento window was H4 `flareblitz`, H6 `switch drednaw`, H8 `flareblitz`.
- Sunny Day A was H4 `switch magneton`, H6/H8 `switch scovillain`.

Native 500K often changed the 120K native choice, including Drednaw and both
Sun-preview examples. More native search therefore does not generally collapse
the architecture differences, but it also does not establish H8 quality.

## Strategic adjudication and selective trigger

No disagreement meets the required standard for `H8 CLEARER` or `CURRENT
CLEARER`. The classifications are **UNRESOLVED**: frozen root distributions
are useful evidence of behavioural differences, but they do not substitute for
an independent current-mechanics continuation evaluation of the relevant
2–4-decision sequence. Preview positions are additionally limited by the
current non-BSS preview transition behaviour.

The historical trigger would have selected many of these decisions: Sun
positions have a weather beneficiary alive; Memento and Shell Smash fixtures
have setup/pivot availability; Tera selections and close supports are
high-consequence. This is descriptive only. No trigger was added to production.

The expansion condition requires at least three **strategically meaningful,
adjudicated** stable disagreements. That threshold was not met, so no 40–60
fixture expansion was run.

## Answers and recommended next phase

**Q1.** Yes. H8 makes materially different choices on the same frozen inputs.

**Q2.** Differences appear often in setup and positioning, but also in hazard
control and preview; the sample does not establish concentration.

**Q3.** No. The present evidence does not demonstrate a more coherent Memento
→ Drednaw → Shell Smash or Sun → Scovillain sequence.

**Q4.** No. Native 500K changes several 120K choices but does not eliminate all
differences.

**Q5.** No. Six results persist across H4/H6/H8 and three are horizon-sensitive;
there is no monotonic quality result.

**Q6.** Several targeted setup/weather positions match the trigger's descriptive
conditions, but this was not validated as selective search.

**Q7.** No. A later production experiment is not justified yet.

The next phase should add an information-safe, current-engine continuation
adjudicator for non-preview fixtures, then repeat this fixed corpus before any
search or evaluator changes.

## Validation limits

The focused Foul Play suite passes 26 tests, the isolated H8 crate passes
offline `cargo check` and release build, and the simulator build passes. A
same-bundle/same-seed H8 comparison is byte-identical on repeat. The H8 crate
does not yet have direct Rust unit tests, and the parent crate's no-feature
`cargo test --offline` configuration has unrelated Gen X compile failures;
neither is represented as an H8 mechanics-conformance pass. The diagnostic
uses the required `terastallization` feature and was validated only through
its isolated build and frozen-fixture runs.
