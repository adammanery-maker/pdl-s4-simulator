# PDL Experiment Plans Design

## Goal

Add a local-only, reusable experiment runner for PDL S4 simulations. It must
let a single terminal invocation define any number of roster variants for any
current PDL teams, schedule those variants, run side-balanced battles, and
retain scenario-level results. It must not modify the PDL web application,
Vercel, Redis, or live league data.

## Input model

`npm run pdl:experiment -- --plan -` reads one YAML-like plan from standard
input. A helper agent may return the full heredoc command, so the user never
has to hand-create JSON files. `--plan path/to/file.yaml` is also supported for
reproducible stored plans.

A plan contains:

- `version: 1`;
- exactly two named current-roster teams;
- one or more variants per team;
- a schedule strategy and total pair count;
- simulation settings and an output directory.

Each variant is either fully locked (six full builds), partially locked,
required/excluded, or unconstrained. Existing PDL selection constraints apply:
all named Pokémon must be on the frozen current roster; a lock requires its
Pokémon; no more than six required/locked Pokémon; every locked set must pass
PDL and Showdown validation. Variants may request a deterministic generated
six. Generated variants for the same team must be different by complete packed
team identity; failure to find the requested number is an explicit error.

## Scheduling

The first strategy is `balanced-cross`.

For left variants `L`, right variants `R`, and `totalPairs` `P`, a valid plan
requires `P` to divide evenly across both variant totals: every left variant
receives `P / L` pairs and every right variant receives `P / R` pairs. A
deterministic round-robin allocator gives each cross cell either
`floor(P / (L * R))` or `ceil(P / (L * R))` pairs while satisfying both totals.

For the approved 8×4, 200-pair example, each left variant gets 25 pairs, each
right variant gets 50, and twenty-four cells get six pairs while eight get seven.

The design reserves `explicit` and `paired` strategies for later work; version
one rejects them clearly instead of silently approximating them.

## Execution model

The runner freezes the public roster endpoint once, resolves every variant
once, and writes `plan.resolved.json` before any battle. A resolved variant
contains its ID, team ID, normalized selection constraints, sampler seed, and
packed/exported six. A scheduled pair references the two resolved variants.
Each scheduled pair runs forward and reverse through the existing local
Showdown/Foul Play runner, preserving the exact builds for both side-swapped
battles.

Every run retains the source plan, resolved plan, frozen snapshot, per-trial
manifest/belief/teams/logs/result, append-only trial index, progress, summary,
and report. Trial manifests include the two variant IDs and cross-cell ID.

## Reports

Existing overall association tables remain. The summary and HTML report add:

- variant records;
- cross-matchup-cell records;
- variant schedule counts, including planned and completed paired trials;
- the normalized plan for auditability.

All rates remain descriptive and use only complete forward/reverse pairs.

## Errors and reproducibility

The parser rejects unknown fields, malformed builds, duplicate IDs, invalid
counts, unsupported strategies, invalid current-roster references, and
impossible generated-variant requests before it starts any battle. Seeds derive
deterministically from a plan hash, variant ID, and pair number. The exact
resolved plan is authoritative for a rerun; it does not resample variants.

## Tests

Tests cover plan parsing, strict validation, deterministic distinct variant
resolution, 8×4/200 balanced allocation, invalid allocation rejection, trial
metadata, and scenario-level aggregation/reporting. A small live smoke test is
run only in a fresh `/private/tmp` directory and never touches the PDL site.
