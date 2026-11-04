# Phase 6 current-engine continuation adjudication

## Scope and boundary

This diagnostic is offline and does not change Foul Play's live search.  The
Python entry point verifies an immutable Phase 5 schema-v2 bundle before the
isolated Rust crate receives any input.  The crate accepts only a serialized
poke-engine `State`, the canonical legal-root-action list, a depth, an exact
damage-branch depth, and a node limit.  It has no protocol, team-file, belief
sampler, network, or hidden-truth input.

For every frozen complete world, every legal root action is forced in turn.
The same maximin continuation is used for every root.  The opponent minimizes
side-one utility; side one maximizes it on later transitions.  Instruction
probabilities returned by current poke-engine are aggregated as chance nodes.
The first joint transition branches exact damage rolls in this run.  Later
damage uses poke-engine's expected-damage transition to keep the bounded
diagnostic finite.  Terminal leaves are exactly 1 for a side-one win and 0 for
a loss.  Non-terminal leaves use
`genx-static-v0.0.48-boost-relevance-v1`, transformed to the same relative
0–1 scale used by the current diagnostics.

The tool uses a transposition cache and an exact maximin alpha cutoff.  The
cap was 100,000 expanded states per frozen world and depth.  A cap failure is
recorded as `intractable`; it is never replaced by a partial value.

Run it with:

```bash
.venv/bin/python scripts/adjudicate_phase6_continuations.py \
  --bundle /absolute/path/to/schema-v2-bundle.json \
  --depths 2 4 6 \
  --exact-damage-depth 1 \
  --node-limit 100000 \
  --output /absolute/path/to/result.json
```

## Six non-preview disagreements

All D2 selected-action leaves were evaluator-truncated: terminal probability
was 0% and evaluator-truncated probability was 100%.  D2 is therefore useful
architecture evidence, not proof of optimal play.  Five D4 searches exceeded
the explicit cap.  Sun positioning B completed D4, but its ranking reversed.
D6 exceeded the cap for all six fixtures.

| Fixture | Native 500K | H8-512 | D2 | D4 | Label |
| --- | --- | --- | --- | --- | --- |
| balance hazard-control | Earthquake | switch Magneton | Stealth Rock (0.3992) | intractable | UNRESOLVED |
| Drednaw Shell Smash | Liquidation | switch Magneton | Shell Smash (0.5142) | intractable | UNRESOLVED |
| Memento window | Parting Shot | Flare Blitz | Parting Shot (0.5927) | intractable | UNRESOLVED |
| Sun positioning A | switch Uxie | switch Scovillain | switch Whimsicott (0.5744) | intractable | UNRESOLVED |
| Sun positioning B | Moonblast | Memento | Memento (0.7653) | Moonblast (0.8114) | DEPTH SENSITIVE |
| Sunny Day A | switch Magneton | switch Scovillain | Memento (0.3383) | intractable | UNRESOLVED |

The principal continuations explain what the bounded search valued.  Examples:

- Drednaw: `Shell Smash | switch Avalugg-Hisui` then
  `Liquidation-Tera | Rapid Spin`.
- Memento window: `Parting Shot | Slack Off` then
  `switch Whimsicott | Slack Off`.
- Sun positioning B at D2: `Memento | switch Avalugg-Hisui` then
  `switch Scovillain | No Move`.  At D4, the principal Moonblast line instead
  continues through Strength Sap, a forced replacement, Memento, and Uxie.

The complete per-action D2 values, the one complete per-action D4 table,
terminal/truncation percentages, frozen-world hashes and weights, node counts,
cache hits, and principal lines are in
[`docs/artifacts/pdl-phase-6-continuation/`](artifacts/pdl-phase-6-continuation/).

## Conclusion

The independent algorithm does not broadly validate either Native 500K or
H8.  It gives bounded support to Shell Smash and Parting Shot at D2, chooses
alternatives in three other positions, and directly demonstrates depth
sensitivity in Sun positioning B.  Because every completed leaf was
evaluator-truncated and five D4 cases were intractable, the proper labels are
one `DEPTH SENSITIVE` and five `UNRESOLVED`.  These results should keep setup
and Sun sequencing in a sensitivity-required domain; they do not establish a
production planner winner.
