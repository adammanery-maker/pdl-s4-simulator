# Phase 2: relevance-aware offensive boosts

This phase makes one evaluator change only. It does not alter MCTS depth, root
exploration, weather, belief sampling, team roles, or strategy-specific logic.

## Change

`poke-engine/src/genx/evaluate.rs` now awards a **positive** active Attack
boost only when that Pokémon has an enabled, PP-remaining Physical move, and a
positive Special Attack boost only when it has an enabled, PP-remaining Special
move. The existing boost magnitude is unchanged when the category is present.
Speed is unchanged.

Negative Attack and Special Attack stages deliberately retain their prior
scoring. That preserves Memento's opponent-debuff accounting in this isolated
experiment; it will need its own targeted test before any change.

The evaluator uses the engine's existing `MoveCategory`. This intentionally
does not add special exceptions for moves whose category and damage stat can
differ, such as Body Press or Foul Play. Those remain a documented limitation
of this small category-level heuristic, not a species or move-specific rule.

The evaluator metadata, source pin, engine-source pin, and runtime id were
advanced together to make the behavioral change auditable:

- runtime: `pdl-s4-foul-play-showdown-local-v3`
- evaluator: `genx-static-v0.0.48-boost-relevance-v1`
- evaluator source SHA-256: `5c013486e9a07bb04f345518431e648a2884893e8a7acc69991c8a3f8bbde397`
- engine source SHA-256: `b9144342c8a48c244a02ab022c9c1652d7a0941ac2112d64300f119c152b64ef`

## Evaluator tests

The exact Rust evaluator has tests for a physical-only, special-only, mixed,
and status-only active moveset, plus an unchanged unboosted state. They prove
that only relevant positive offensive boosts contribute and that defensive,
Speed, and unboosted evaluation are not part of this change.

## Delayed-payoff replay

The before and after runs use the same sanitized fixtures, posterior belief
mode, one requested world, seed 0, 250 ms per sampled world, and argmax. MCTS
is time-bounded, so these are near-deterministic measurements rather than
bit-for-bit reproducible visit counts. The raw artifacts are:

- `docs/pdl-delayed-payoff-phase-2-before.json`
- `docs/pdl-delayed-payoff-phase-2-after.json`

| Scenario | Before support | After support | Before utility | After utility | Before selected | After selected |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Useful Memento | 0.676 | 0.727 | 0.419 | 0.418 | Memento | Memento |
| No-beneficiary Memento | 0.623 | 0.612 | 0.396 | 0.401 | Memento | Memento |
| Healthy useful Memento | 0.005 | 0.005 | 0.401 | 0.397 | Psychic Noise | Psychic Noise |
| Healthy no-beneficiary Memento | 0.005 | 0.004 | 0.399 | 0.396 | Psychic Noise | Psychic Noise |
| Useful Sunny Day | 0.650 | 0.629 | 0.397 | 0.396 | Sunny Day | Sunny Day |
| No-beneficiary Sunny Day | 0.025 | 0.029 | 0.302 | 0.307 | Encore | Encore |
| Dangerous Shell Smash | 0.506 | 0.464 | 0.568 | 0.520 | Shell Smash | Shell Smash |
| Safer Shell Smash | 0.512 | 0.474 | 0.649 | 0.599 | Shell Smash | Shell Smash |

The controlled Shell Smash support gap grew from 0.006 to 0.010. Both positions
became less eager to Shell Smash, with the danger position declining slightly
more. The utility gap is essentially unchanged (0.080 before, 0.079 after).
The correction therefore removes artificial immediate value, but does not by
itself make the search meaningfully distinguish safe from dangerous setup.

Healthy Memento remains almost indifferent to Drednaw's availability. This is
consistent with the current MCTS evaluating a shallow leaf before it has
searched Memento → replacement → Drednaw continuation. The Phase 2 change does
not address that horizon.

## Complete post-change Shell Smash root support

| Action | Dangerous Bruxish position | Safer Slowbro-Galar position |
| --- | ---: | ---: |
| Crunch | 0.058783 | 0.036806 |
| Crunch + Tera | 0.007351 | 0.004258 |
| Liquidation | 0.025215 | 0.206678 |
| Liquidation + Tera | 0.004184 | 0.030581 |
| Shell Smash | 0.463998 | 0.474433 |
| Shell Smash + Tera | 0.015659 | 0.020054 |
| Stone Edge | 0.045779 | 0.076140 |
| Stone Edge + Tera | 0.005158 | 0.025786 |
| Switch Incineroar | 0.218588 | 0.060711 |
| Switch Magneton | 0.006055 | — |
| Switch Tatsugiri | 0.076839 | 0.009080 |
| Switch Uxie | 0.058130 | 0.037621 |
| Switch Whimsicott | 0.014261 | 0.017855 |

## Validation

- `cargo test --offline --no-default-features --features terastallization --lib`: 231 passed.
- Foul Play evaluator/runtime/PDL suite: 69 passed.
- `npm run tsc`: passed.
- `npm run pdl:test-offline-runtime`: completed a full local battle with zero hosted-inference calls and no blocked/external network attempts.

The full Foul Play suite was also run: 795 passed and two unrelated pre-existing failures remained in Leftovers/Black Sludge upkeep inference and unique-world-count sampling. They are outside this evaluator patch and were not changed.

## Stop point

Do not proceed to Phase 3 automatically. The evidence says this evaluator
correction is necessary but insufficient for proactive healthy Memento. Any
next change should test a small, general root-continuation or exploration
mechanism against the same fixtures before touching weather or belief worlds.
