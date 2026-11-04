# Phase 3 search diagnostic

## 1. Executive conclusion

No strategic behaviour was changed in this phase. The evidence rules out a
local MCTS integration regression for the healthy-Memento position: pristine
`poke-engine v0.0.48`, the Phase 1 evaluator, and the current Phase 2
evaluator all give Memento about 0.1% support at 500,000 iterations on the
same serialized complete world.

The diagnostic instead found two distinct behaviours in the unmodified native
search. Proactive Sun is beneficiary-sensitive and receives progressively
deeper exploration; healthy Memento receives very little of the tree and its
subtree remains shallow. This establishes an upstream search/evaluation
limitation, but does not yet establish whether the smallest safe correction is
root allocation or an evaluator term. No fix is implemented under the
one-fix authorization.

## 2. Upstream/local parity table

| Component | Stock Foul Play / poke-engine | Local behaviour | Material to planning? |
| --- | --- | --- | --- |
| Search algorithm | Native simultaneous-action UCB MCTS | Same production `mcts.rs` selection, expansion, rollout and backpropagation | Yes: no local algorithm fork explains the result. |
| Search time | Time or explicit iteration limit | 250 ms/world in studies; the diagnostic uses fixed iterations | Yes: timing noise is removed only for the diagnostic. |
| Threads | One tree or optional shared threaded tree | Study and diagnostic use one native tree thread | Yes: threaded-tree behaviour was not inferred from these results. |
| World count | Standard sampled battles | PDL usually requests one and expands to two when opponent information is sparse | Yes: complete-world runs isolate this. |
| World weighting | Standard worlds have equal likelihood | PDL samples correlated complete candidates by local weights, then deduplicates worlds with equal final weights | Yes: may matter only after complete-world search is understood. |
| MCTS root aggregation | Aggregate visit fractions per sampled battle | Same, weighted by supplied world chance | No difference found in the Memento complete-world check. |
| Final selection | Stock may randomly choose among near-best choices | Evaluation mode uses deterministic aggregate argmax, then the PDL Tera confidence gate | Material only after a policy has meaningful support; it cannot rescue 0.1% Memento. |
| Tera handling | Stock legal action set | PDL restricts captain eligibility and rejects weakly supported Tera choices | Not exercised by the principal non-Tera fixtures. |
| Evaluator | `v0.0.48` static Gen X evaluator | Phase 2 suppresses positive Atk/SpA boost value without a usable matching move; all other terms remain stock | Material for Shell Smash; not the Memento parity result. |
| Team preview | Standard Foul Play flow | Public PDL projection plus local candidate data | Outside the frozen midgame complete-world tests. |

Foul Play's `origin` is the locally frozen spike with shallow grafted history;
the identifiable base is `25c976f`. The PDL adapter begins at `fe9c88f`
(`pdl-hardened-baseline-v1`). Poke-engine's `origin` is
`https://github.com/pmariglia/poke-engine.git`; pristine comparison commit is
`bcf1382` (`v0.0.48`). The current evaluator derives from `19e9b15` plus
`f2bb1b3`.

## 3. Exact search architecture

Foul Play projects public state, samples a complete opponent world through
the existing correlated candidate machinery, serializes it into poke-engine,
then calls native MCTS. At each MCTS node, both sides select a legal move or
switch independently by UCB. A previously expanded joint move pair samples a
weighted instruction outcome and selection continues recursively. A new pair
expands its outcomes, samples one outcome, statically evaluates that leaf
relative to the root through a sigmoid, and backpropagates to both players'
move statistics. There is no rollout policy beyond that static leaf.

The diagnostic uses a single frozen serialized world and a seeded
single-threaded MCTS sibling. It calls the same production `Node::selection`,
`Node::expand`, `Node::rollout`, and `Node::backpropagate`; ordinary MCTS does
not allocate diagnostics or use the seeded path.

## 4. Tree-depth instrumentation definition

Depth is the number of expanded simultaneous move-pair transitions from the
root to an evaluated leaf. One joint action resolution is one edge even when
it yields several stochastic damage outcomes. A root action's `Nodes` count is
the number of created chance-outcome nodes reachable under that action.
`Pairs` is the count of distinct direct root joint move pairs expanded for
that side-one action. `Terminal` and `Static` count evaluated leaves that were
battle outcomes or native static-evaluator leaves respectively.

The histogram is `[depth 0, depth 1, depth 2, depth 3, depth 4, depth 5+]`.
`Deepest meaningful` is the greatest exact depth with at least
`max(10, ceil(0.1% of that root action's leaves))` evaluations. Percentiles
use nearest-rank on evaluated-leaf depths.

## 5. Fixture definitions

All positions use the sanitized actor-only protocol replay framework. The
complete worlds below are belief samples, not submitted opponent sets.

| Fixture | Public position | Controlled comparison |
| --- | --- | --- |
| Healthy Memento | Uxie vs Avalugg-Hisui, turn 4; Drednaw is healthy on bench | Same public position with own Drednaw marked unavailable. |
| Proactive Sun | Whimsicott vs Electivire, turn 5; Sun absent and Scovillain healthy | Same with own Scovillain unavailable. |
| Sun handoff | Whimsicott vs Slowbro-Galar, turn 7; Sun active and Scovillain healthy | Same with own Scovillain unavailable. |
| Growth window | Scovillain vs Ambipom, turn 8 under Sun | Measures Growth against three attacks and switches. A paired danger case is still missing. |
| Shell safe | Drednaw vs Slowbro-Galar, turn 6 | Existing safe setup window. |
| Shell dangerous | Drednaw vs Bruxish, turn 1 | Existing dangerous setup window. It is not a fully matched pair and remains a limitation. |

The Sun handoff and Growth scenarios are now named regression scenarios in
`tests/fixtures/pdl_delayed_payoff/scenarios.json`.

## 6. Fixed-iteration results

All rows use seed 0 and one frozen world per scenario. The selected action is
the root action with highest visits; support is the visit fraction.

| Scenario/action | 10k | 50k | 120k | 500k |
| --- | --- | --- | --- | --- |
| Healthy Memento support | 3.86% | 1.10% | 0.51% | 0.13% |
| Healthy Memento max depth | 3 | 4 | 4 | 4 |
| Proactive Sunny Day support | 7.0% | 19.8% | 65.9% | 91.8% |
| Proactive Sunny Day max depth | 4 | 7 | 8 | 9 |
| Sunny Day without Scovillain support | 7.2% | 3.7% | 2.5% | 0.8% |
| Growth under Sun support | 17.1% | 20.3% | 18.0% | 18.5% |
| Safe Shell Smash support | 63.8% | 80.8% | 85.1% | 54.6% |
| Dangerous Shell Smash support | 9.1% | 7.1% | 8.3% | 8.5% |

At 500k, healthy Memento has mean root utility 0.394 versus Psychic Noise
0.588. The useful/no-Drednaw Memento supports are 0.13%/0.11%; the beneficiary
changes the value slightly but does not cause the MCTS policy to pursue the
line.

## 7. Per-root-action depth tables

The tables show the leading relevant actions at 500,000 iterations. All shown
leaves were static except the one terminal Sunny Day leaf.

### Healthy Memento

| Action | Visits | Support | Mean utility | Pairs | Nodes | Max depth | Mean leaf depth | P90 | Terminal / Static |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Psychic Noise | 431,630 | 86.3% | 0.588 | 13 | 664,023 | 8 | 4.13 | 5 | 0 / 431,630 |
| Stealth Rock | 16,883 | 3.4% | 0.556 | 13 | 26,733 | 5 | 3.01 | 4 | 0 / 16,883 |
| Thunder Wave | 15,846 | 3.2% | 0.555 | 13 | 27,893 | 5 | 2.87 | 3 | 0 / 15,846 |
| Memento | 645 | 0.1% | 0.394 | 13 | 1,010 | 4 | 2.87 | 3 | 0 / 645 |

### Proactive Sun and handoff

| Action | Visits | Support | Mean utility | Nodes | Max depth | Mean leaf depth | P90 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Sunny Day, proactive | 459,077 | 91.8% | 0.435 | 635,257 | 9 | 4.93 | 6 |
| Moonblast, proactive | 18,225 | 3.6% | 0.374 | 28,440 | 6 | 3.67 | 5 |
| Moonblast, handoff | 325,069 | 65.0% | 0.440 | 476,559 | 9 | 5.00 | 6 |
| Switch Scovillain, handoff | 132,305 | 26.5% | 0.435 | 191,139 | 8 | 4.99 | 6 |

### Shell Smash

| Action | Visits | Support | Mean utility | Nodes | Max depth | Mean leaf depth | P90 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Shell Smash, safe | 273,205 | 54.6% | 0.600 | 404,607 | 8 | 4.75 | 6 |
| Liquidation, safe | 188,110 | 37.6% | 0.598 | 260,622 | 10 | 5.63 | 7 |
| Switch Incineroar, dangerous | 204,791 | 41.0% | 0.441 | 305,141 | 8 | 4.66 | 6 |
| Shell Smash, dangerous | 42,368 | 8.5% | 0.428 | 60,949 | 7 | 4.10 | 5 |

## 8. Memento diagnosis

Healthy Memento is not merely a one-edge search: it reaches depth 4. It is
nevertheless starved relative to the alternatives: at 500k it gets 645 leaves
while Psychic Noise gets 431,630, and its P90 depth is 3 while Psychic Noise's
is 5. Increasing iterations reduces, rather than increases, Memento support.

The deeper-search control also sees a beneficiary effect: at depth 3 the
Memento minimax value is -79.7 with Drednaw available and -193.1 with Drednaw
unavailable. It still chooses Thunder Wave. This is evidence that the state
and evaluator do distinguish the two worlds, but it does not prove Memento is
the strategically correct choice in this exact position.

## 9. Sun/Scovillain diagnosis

This is the positive control. With Scovillain present, Sunny Day climbs from
7.0% to 91.8% and reaches depth 9. Removing Scovillain makes it fall to 0.8%
and depth 6 at the same 500k budget. Sun handoff gives switching Scovillain
26.5% support at depth 8. In the under-Sun Growth window, Growth remains a
competitive 18.5% action at 500k alongside Fire Blast (20.5%), Solar Beam
(19.6%), and Crunch (18.2%).

The native MCTS can therefore represent multi-turn Sun value. This audit does
not support a hard-coded weather or Scovillain rule.

## 10. Shell Smash diagnosis

The safe/dangerous fixtures are not matched closely enough to attribute every
difference to setup safety, but the direction is stable. Safe Shell Smash has
0.600 mean utility and 54.6% support at 500k. Dangerous Shell Smash has 0.428
and 8.5%. It reaches `Shell Smash → opponent response → later Drednaw action`
in the dangerous tree (maximum depth 7), so root support alone would have been
misleading.

## 11. Stock vs current evaluator comparison

Each variant received byte-identical frozen state files. Stock and Phase 1
were built in separate local environments; their ordinary MCTS uses its
existing unseeded RNG, so figures below are one fixed-iteration run rather
than an RNG-identical comparison. The differences are much smaller than the
safe/dangerous separation.

| World/action at 500k | Stock v0.0.48 | Phase 1 evaluator | Current Phase 2 |
| --- | ---: | ---: | ---: |
| Healthy Memento support / utility | 0.1% / 0.389 | 0.1% / 0.399 | 0.1% / 0.391 |
| Safe Shell Smash support / utility | 42.1% / 0.696 | 43.0% / 0.696 | 57.1% / 0.597 |
| Dangerous Shell Smash support / utility | 12.7% / 0.450 | 11.3% / 0.447 | 9.4% / 0.429 |

The Phase 2 correction changes Shell Smash valuation, as intended, but does
not explain the healthy-Memento failure.

## 12. MCTS vs deeper-search diagnostic comparison

The existing iterative-deepening expectiminimax was used only as a control on
the healthy-Memento complete world. It reached depth 3 by 250 ms (and did not
deepen further by 5 s), selected Thunder Wave, and assigned Memento -79.7
versus -193.1 without Drednaw. It agrees that Memento is not the best root
move under this evaluator, while proving that the downstream beneficiary
changes its value. The control is too shallow to resolve whether a different
leaf term or root allocation would make that plan best.

## 13. Complete-world vs belief-world comparison

The healthy-Memento complete world is
`0df152bd05d039f4d7103e1fa081158c7fa44ec58389031dd56aafeb2861c059`.
All stock, Phase 1, and current runs read that exact serialized file. Current
complete-world Memento support is 0.13% at 500k. The ordinary Foul Play
belief-layer replay generated two worlds at 250 ms (109k and 113k visits) and
gave Memento 0.52% and 0.54%, aggregated to 0.53%. Both layers reject the
line. Belief aggregation may matter elsewhere, but it is not the primary
cause of this pathology.

## 14. Root-cause decision gate reached

**Gate 6 is reached:** pristine stock `v0.0.48` fails the same healthy-Memento
state at the same fixed iteration budgets. The defect is not omitted by the
local integration.

Gate 2 is plausible but not decisive: Memento receives far fewer visits and
shallower leaves, yet the deeper-search control still ranks it below Thunder
Wave. Gate 3 is also plausible but not decisive: the evaluator recognizes the
Drednaw difference without making Memento favourable. Gate 5 is not reached.

## 15. Any minimal fix implemented

None. The only code added is opt-in offline diagnostic instrumentation and
fixture labels. Production UCB, expansion order, random sampling, evaluator
values, belief sampling, Tera gating, and action selection are unchanged.

## 16. Before/after validation

The diagnostic core has a fixed-iteration accounting unit test. `cargo test
--offline --no-default-features --features terastallization --lib` passes all
232 tests. The rebuilt runtime contract reports
`pdl-s4-foul-play-showdown-local-v4`, the unchanged Phase 2 evaluator source
hash `5c0134…`, and source hash `fc6227…` that includes the diagnostic API.
The TypeScript simulator type check passes.

## 17. Remaining uncertainty

The Growth and Shell Smash danger controls need closer matched public states.
The threaded shared-tree MCTS has not been instrumented; these conclusions are
for the study's one-thread configuration. Stock's normal binding has no seeded
RNG API, so its comparison should be repeated across a small seed/replicate
set if numerical precision becomes important. Most importantly, no evidence
yet selects a minimal root-exploration correction over a targeted evaluator
correction for Memento; implementing either now would be speculative.
