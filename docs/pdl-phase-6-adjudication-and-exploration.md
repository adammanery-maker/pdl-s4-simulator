# Phase 6 exploratory-ablation workflow

This simulator now has a one-variable, common-random-number ablation layer over the existing local Showdown → Foul Play → poke-engine pipeline. It does not alter live-agent defaults.

The runner validates Showdown team exports field by field, creates the same opponent build, orientation, and battle seed for each baseline/candidate cell, and records derived search, belief, and world-allocation seeds. Only the Showdown battle seed currently has a full-battle injection seam. The other seeds remain recorded paired intent; the artifacts say so explicitly.

Reports include ordinary win counts, discordant paired outcomes, an exact two-sided McNemar p-value, a deterministic paired-bootstrap interval, orientation/build breakdowns, public-protocol behavior metrics, and conservative pathology review candidates. Small screens emphasize direction and discordant counts.

The machine-readable trust matrix is `pdl/ablation/trust-matrix.json`. Current policy is:

- GREEN: ordinary attacks, status.
- YELLOW: ordinary switching, hazards, Sun initiation/positioning, Growth, Memento, Shell Smash.
- RED: team preview.

Any manifest that declares a RED domain receives the prominent exploratory-only warning. The workflow deliberately permits useful exploration while preserving that warning.

The offline boundary is inherited from the hardened trial runner: hosted credentials are stripped, each Foul process is sandboxed to its private inputs, only loopback Showdown is allowed, network attempts are audited, and only clean trial evidence is aggregated.

## A/A gate result — blocker

On October 5, 2026, the smallest real A/A smoke ran two clean, terminal full battles with the same teams, Steve build, orientation, and Showdown seed. Both battles were won by Steve, but their decision traces and battle lengths diverged: Adam produced 50 selected actions in the baseline copy and 34 in the candidate copy. The gate correctly stopped with `A/A reproducibility blocker`.

Evidence is preserved in `calculations/pdl-phase6-aa-smoke-20261005`. This is a Gate A failure. No real demonstration ablation was run. The generated 60-pair/120-battle dry-run schedule is preserved in `calculations/pdl-phase6-demo-dry-run-20261005` to validate manifest mutation, seed pairing, orientations, and artifact planning without making a behavioral claim.

The A/A preset compares terminal outcomes and normalized selected-action traces under identical teams and paired battle seeds. Current Foul search is time-budgeted and offers no search-seed injection, so no real ablation should be interpreted until a deterministic offline-only search seam is added and this gate passes.

Native-120K is therefore the requested evaluation policy but is not falsely claimed by this full-battle runner. H8 is also not exposed as a full-battle switch: it remains a frozen-state architecture-sensitivity diagnostic.
