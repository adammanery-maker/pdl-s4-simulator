# Post-Baseline Agent Development Specification

## Baseline

`pdl-hardened-baseline-v1` is the only comparison point for this work:

- simulator: `d4608d16cc2de7c1d7ec9709ea66f381dc41fb9e`
- Foul Play: `fe9c88f6d6244cb78043f770253e13c47c8a0a50`
- poke-engine: `19e9b15132d999d225c08ec1270bf3f762b0daa9`

It uses local Pokémon Showdown as authority, a formal observed-state boundary,
loopback-only and zero-token execution, deterministic MCTS argmax selection,
and evaluator plus complete engine-source attestation.

## Required sequence

1. Establish Showdown-versus-instrumented-poke-engine mechanics conformance
   before changing inference or strategic evaluation.
2. Redesign beliefs as hard constraints plus soft evidence with provenance,
   retaining legal unseen-set fallback.
3. Replace iid tiny-world sampling with correlated, stratified, adaptive world
   allocation that represents strategically important hypotheses.
4. Use evaluator instrumentation and preserved pathological positions to
   identify whether each failure is evaluator, horizon, or search dynamics.
5. Compare old and new agents with common random inputs before any large
   matchup batch.

## Global constraints

- Pokémon Showdown remains the authoritative mechanics executor.
- The agent may consume only serialized observations and belief-generated
  worlds; it must never receive hidden submitted opponent data.
- Runtime uses no model, hosted inference, API key, or non-loopback network.
- Evaluation mode remains deterministic argmax under fixed search outputs.
- Priors are not a legality whitelist. Contradiction fallback retains legal,
  evidence-consistent unseen sets.
- Do not combine these phases in a simultaneous rewrite.
- Every phase adds a focused regression suite and records versioned evidence.
