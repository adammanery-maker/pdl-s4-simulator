# Delayed-payoff strategy regression baseline

This is the Phase 1 diagnosis for the standard 3x3 Adam-versus-Steve run. It
adds replayable, agent-visible fixtures and makes no evaluator, search, belief,
or mechanics behavior change.

## Active runtime

The PDL wrapper imports the local installed `poke-engine` runtime through
`fp/runtime_contract.py`. The contract requires `poke-engine 0.0.48` and
`genx-static-v0.0.48`, and validates both the evaluator and engine source
fingerprints. The current contract is emitted by the normal runtime and is
recorded in each root-evaluation log.

The live decision path is:

```
run-trial → local Foul Play bot → fp.search.main.find_best_move
          → StandardBattleMode.prepare_battles → poke-engine MCTS → argmax
```

`fp/search/main.py` records evaluator root decompositions, runs each sampled
world, and aggregates the result. `fp/search/standard_battles.py` produces
complete opponent worlds from the current Foul Play belief candidates.
Team-preview and incomplete-move decisions request additional worlds through
`StandardBattleMode.search_params`.

The active static evaluator is `poke-engine/src/genx/evaluate.rs`. It gives the
active Pokémon a fixed 30-point term per Attack, Special Attack, and Speed
boost multiplier, without checking whether its moves use the corresponding
stat. It has no weather term. It does count material, HP, items, hazards,
status, side conditions, and Tera.

The active native MCTS binding expands one move-pair outcome and evaluates that
leaf as `sigmoid(evaluate(leaf) - evaluate(root))`. It has no policy rollout
beyond the expanded leaf. UCB gives every previously unvisited action a visit,
but an action with a bad immediate leaf can receive much less continuation
search after that.

## Belief-world semantics

`beliefSamples: 1` in the study manifest is the requested base parallelism, not
a hard per-decision world count. For preview, an unrevealed active opponent, or
an active opponent with fewer than three revealed moves,
`StandardBattleMode.search_params` doubles that request when not under time
pressure. Thus the standard run searched two worlds in those positions and one
otherwise.

`prepare_battles` samples independently from the existing weighted candidate
machinery, deduplicates complete set combinations, then currently assigns each
unique sampled world equal aggregate weight (`1 / requestedWorlds`). Candidate
weights affect how likely a world is sampled, but not the weight of a distinct
world after sampling. This is intended current behavior, but the field name is
ambiguous; no sampling change is included in this phase.

## Regression fixtures

`tests/fixtures/pdl_delayed_payoff/` contains four compact recorded positions:

- useful Memento and its paired own-Drednaw-unavailable variant;
- useful Sun and its paired own-Scovillain-unavailable variant;
- a Drednaw-versus-Bruxish danger position;
- a Drednaw-versus-Slowbro-Galar safer position.

Each fixture contains only the acting bot's own request/protocol, its own belief
input, own choices, and team identifier. It excludes the opponent request,
Showdown log, audit, and ground-truth set file. The paired variants change only
an own reserve Pokémon's public HP before `ObservedBattleState.capture`.

Run the baseline with:

```bash
.venv/bin/python scripts/run_pdl_delayed_payoff_regressions.py --search-ms 250
```

`docs/pdl-delayed-payoff-phase-1-baseline.json` captures the initial run using
one requested world, the normal posterior belief engine, MCTS, deterministic
argmax, and seed 0. Native time-bounded MCTS makes the measurements
near-deterministic rather than bit-for-bit fixed.

| Scenario | Focus support | Mean leaf utility | Selected action | Desired direction |
| --- | ---: | ---: | --- | --- |
| Useful Memento | 0.712 | 0.417 | Memento | higher than no-beneficiary variant |
| Useless Memento | 0.622 | 0.398 | Memento | lower |
| Useful Sun | 0.636 | 0.397 | Sunny Day | higher than no-beneficiary variant |
| Useless Sun | 0.026 | 0.304 | Encore | lower |
| Dangerous Shell Smash | 0.505 | 0.567 | Shell Smash | lower than safe position |
| Safe Shell Smash | 0.507 | 0.646 | Shell Smash | higher |

The Memento and Sun pairs show that existing search can value a known payoff
beneficiary. The Shell Smash pair is the useful failure: it assigns essentially
identical policy support to a known-danger Bruxish position and a safer
Slowbro-Galar position. This is a controlled diagnostic, not an assertion that
a fixed move must win a particular board.

## Phase 2 scope

The smallest evidence-supported behavior change is to make the generic active
Attack and Special Attack boost terms depend on meaningful physical and special
moves in the exact evaluator. It applies to every Pokémon and does not
special-case Drednaw, Shell Smash, Memento, Sun, or either team. It should be
made and measured independently before considering root exploration, weather,
or belief-world coverage.
