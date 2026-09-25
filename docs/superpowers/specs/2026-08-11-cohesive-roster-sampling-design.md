# Cohesive PDL Roster Sampling Design

## Goal

Generate realistic, reproducible PDL battle teams from each team's current ten-Pokémon roster before Showdown executes a battle.

## Inputs

- A frozen PDL roster snapshot: team IDs, current ownership, Pokémon costs, and each team's two drafted Tera types.
- PDL's generated Pokémon data for each roster member: top moves, abilities, items, spreads, Tera types, teammates, checks/counters, role scores, and archetype tags.
- The opponent's public roster only. The sampler never receives hidden opponent sets, battle state, or private agent data.

## Candidate-set generation

For every roster Pokémon, produce a bounded collection of legal complete sets. Draw each component from observed usage data and retain its source weight. Couple move selections to role requirements so the candidate has a coherent purpose rather than independently combining high-usage fields. Validate every candidate through the PDL validator and Pokémon Showdown's TeamValidator.

If usage data does not provide a legal component, omit that candidate and report the missing-data reason. The sampler must not silently invent a move, item, ability, nature, spread, or Tera type.

## Cohesive six selection

Sample complete six-Pokémon teams from the current ten-Pokémon roster. Score candidates jointly on:

- hazard setting and removal;
- speed control;
- physical/special offense balance;
- defensive typing, pivots, and shared weakness pressure;
- role coverage and teammate affinity;
- public roster matchup coverage against the opponent.

Usage weight remains a strong component of the final score. A seeded weighted sampler selects among high-quality candidates, preserving preparation uncertainty instead of deterministically constructing a perfect six.

## Tera and legality

Every generated Tera type obeys PDL policy: only Pokémon costing four or fewer may receive one, and it must be native or one of the team's drafted Tera types. The existing PDL and Showdown validation layers are authoritative gates before battle execution.

## Records and reproducibility

Each sampled team record includes the roster snapshot ID/hash, source-data version/hash, sampler seed, candidate scores, selected six, selected full builds, legality results, and rejected-candidate reasons. The existing battle record then links to these exact sampled teams, battle seed, Showdown revision, raw protocol log, canonical protocol log, choices, and winner.

## Deliberate exclusions

This milestone does not implement a web API, production PDL integration, persistence service, automatic scouting of private sets, bespoke battle AI, bulk probability reporting, or historical calibration. It creates the trustworthy team-preparation layer those later stages require.
