# Current native MCTS versus H8-NEUTRAL

This report is the decision-level companion to
[`pdl-setup-sequence-phase-5.md`](pdl-setup-sequence-phase-5.md). It reports
root actions only. Support is weighted root-policy support across frozen belief
worlds, not a match-win probability.

| Fixture | Recorded | Native 120K | Native 500K | H8-512 | H8 adaptive | Five-seed H8-512 | H4 / H6 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| balance-hazard-control | Stealth Rock | Stealth Rock | Earthquake | Switch Magneton | Switch Magneton | stable | Switch Magneton / Switch Magneton |
| balance-status | Will-O-Wisp | Knock Off | Knock Off | Flare Blitz | Flare Blitz | unstable | — |
| balance-tactical | Earthquake | Tera Stealth Rock | Tera Stealth Rock | Tera Earthquake | Tera Earthquake | unstable | — |
| drednaw-healthy-shell-smash | Shell Smash | Shell Smash | Crunch | Crunch | Crunch | stable | same as Native 500K |
| drednaw-replacement | Switch Drednaw | Switch Magneton | Switch Magneton | Switch Magneton | Switch Magneton | stable | same |
| drednaw-shell-smash | Shell Smash | Shell Smash | Liquidation | Switch Magneton | Switch Magneton | stable | Crunch / Shell Smash |
| memento-preview-a | Switch Magneton | Switch Incineroar | Switch Uxie | Switch Uxie | Switch Magneton | stable | same as Native 500K |
| memento-preview-b | Switch Drednaw | Switch Drednaw | Switch Drednaw | Switch Uxie | Switch Magneton | stable | Switch Uxie / Switch Uxie |
| memento-window | Parting Shot | Parting Shot | Parting Shot | Flare Blitz | Flare Blitz | stable | Flare Blitz / Switch Drednaw |
| scovillain-growth | Growth | Growth | varies | varies | varies | unstable | — |
| sun-positioning-a | Switch Whimsicott | Switch Uxie | Switch Uxie | Switch Scovillain | Switch Scovillain | stable | Switch Scovillain / Switch Scovillain |
| sun-positioning-b | Moonblast | Moonblast | Moonblast | Memento | Memento | stable | Memento / Memento |
| sun-preview-a | Switch Incineroar | Switch Incineroar | Switch Tatsugiri | Switch Scovillain | Switch Scovillain | stable | Switch Scovillain / Switch Scovillain |
| sun-preview-b | Switch Uxie | Switch Incineroar | Switch Uxie | Switch Scovillain | Switch Scovillain | stable | Switch Scovillain / Switch Scovillain |
| sunny-day-a | Sunny Day | Sunny Day | varies | Switch Scovillain | Switch Scovillain | stable | Switch Magneton / Switch Scovillain |
| sunny-day-b | Sunny Day | Moonblast | Moonblast | varies | Memento | unstable | — |

The raw per-action support, Q values, simulation counts, and depth metrics are in the
corresponding JSON files under
`pdl-s4-simulator/calculations/pdl-phase5-current-v5-corpus/comparison-results/`.

The table must not be interpreted as a quality ranking. The correct conclusion
is that the comparison exposes both stable and unstable architecture-dependent
choices. It does not yet contain independent continuation evidence capable of
crediting a strategic win to either implementation.
