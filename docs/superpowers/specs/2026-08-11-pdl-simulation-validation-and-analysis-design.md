# PDL S4 Simulation Validation and Analysis Design

## Goal

Turn the existing isolated PDL Showdown/Foul Play prototype into a trustworthy
simulation experiment before exposing a one-command bulk runner. The system
must distinguish mechanics correctness, preparation uncertainty, battle RNG,
agent-policy uncertainty, and performance attribution.

This work remains outside the production PDL application. It neither writes to
the league Redis store nor changes the public site.

## Decisions

- Pinned local Pokémon Showdown remains the sole authority for rules,
  validation, battle state, RNG, and results.
- The existing PDL-adapted Foul Play checkout is the first high-volume policy.
  It receives only its own full six, the opposing six visible at team preview,
  revealed battle information, and a local PDL belief snapshot. It never sees
  an opponent's actual unrevealed set.
- Current PDL ten-Pokémon rosters and their drafted Tera types are the only
  source of roster ownership. Build candidates remain PDL legal and come from
  observed, versioned usage data; missing data is reported rather than
  invented.
- Metamon is a separate, later independent-policy evaluation lane. Its public
  Gen 9 OU models and replay data are useful broad priors, but are not treated
  as PDL/National Dex truth and are not merged blindly into Foul Play results.
- PokéChamp is deferred to a low-volume strategic adjudication lane. It is not
  part of bulk simulation because an LLM-driven search is slower, costlier, and
  currently less reproducible for the custom PDL format.

## Phased scope

### Phase 1: Foul Play experiment contract

Build a local experiment runner around already validated single-battle inputs.
For every trial it must retain:

- immutable PDL roster/build-belief snapshot identifier and SHA-256 hash;
- sampler seeds, sampled sixes, full packed teams, and validation results;
- Showdown revision and PDL ruleset version;
- battle seed, agent configuration/search budget, player-side assignment, and
  Foul Play revision;
- raw protocol log, winner, battle completion status, and any failure reason.

The runner must reject an incomplete or illegal trial rather than include it in
a percentage. A batch report shows completed, rejected, and failed counts
separately.

### Phase 2: Validity gates before probability claims

The system may label a result a *simulation estimate* only after all of these
gates pass:

1. PDL rules validation accepts known legal teams and rejects known illegal
   teams, including invalid National Dex, banned-mechanic, cost, and Tera
   cases.
2. Replaying the same packed teams, agent settings, and battle seed reproduces
   the canonical battle log and winner.
3. Re-sampling with the same snapshot and sampler seeds reproduces both full
   teams exactly.
4. Both player-side assignments are exercised for every sampled team pair. The
   report measures any side imbalance; it may not silently combine unbalanced
   results.
5. Agent searches complete legal Showdown battles without remote data fallback,
   invalid Mega/Z/Dynamax choices, illegal PDL Tera choices, or exposure of an
   opponent's true hidden set.
6. A held-out suite of real PDL replays, when enough exists, is evaluated only
   as calibration evidence. Sparse history cannot be used to claim a proven
   human-coach model.

### Phase 3: Performance attribution

Each completed battle will be transformed into a normalized event record:

- sampled six, full sets, item, ability, EVs, nature, moves, Tera eligibility,
  actual Tera action, lead, switches, move use, damage, KOs, faints, and
  result;
- opponent roster, sampled opponent six/builds, field state events, battle
  seed, policy, and search budget;
- cohort identifiers for roster snapshot, matchup, sampled-build family, and
  agent.

Reports must not rank Pokémon simply by total wins. The attribution model
compares an entity with its matched baseline within a roster matchup and
simulation cohort. It presents:

- Pokémon marginal contribution with an uncertainty interval;
- full-set contribution (moves, item, ability, nature, EVs, and Tera type);
- move outcome metrics: use rate, damage, KO conversion, and win association;
- teammate-pair synergy and anti-synergy after controlling for roster matchup;
- lead and Tera value as descriptive, non-causal metrics unless paired
  counterfactual sampling is available;
- sample count and uncertainty beside every ranking.

No leaderboard can report a confident positive or negative conclusion below a
predefined minimum completed, matched-trial count. Insufficient evidence is a
result, not a zero.

### Phase 4: Independent policy validation

Create a separate Metamon environment and adapter only after the Foul Play
batch contract passes. It must use the same pinned PDL Showdown revision,
packed teams, format, visible-information boundary, seed recording, and result
schema. Its results remain a separately labeled policy estimate.

For a selected matchup/build cohort, compare Foul Play and Metamon on the same
balanced trial design. Agreement supports robustness; disagreement is reported
as agent-policy uncertainty rather than averaged away.

### Phase 5: Targeted PokéChamp evaluation

After custom-format compatibility, information boundaries, and cost are
verified, run PokéChamp only against representative high-leverage cohorts. It
may challenge a conclusion; it does not replace the reproducible batch engine
or silently determine a published percentage.

## Report contract

Every matchup report presents these values independently:

| Dimension | Meaning |
| --- | --- |
| Build uncertainty | Variation from selecting sixes and legal plausible builds from each ten-Pokémon roster. |
| Battle RNG | Variation across authoritative Showdown battle seeds. |
| Player-side effect | Difference after swapping each exact team pair between p1 and p2. |
| Agent-policy uncertainty | Difference between Foul Play and, once validated, Metamon/PokéChamp cohorts. |
| Evidence quality | Completed-trial count, rejected/failed count, snapshot version, and calibration status. |

The displayed percentage is an estimate with an interval and a cohort label,
never a claim about a real coach's deterministic chance to win.

## Explicit non-goals

- No live-site, Vercel, Redis, or commissioner UI integration.
- No assumed coach-specific profiles from sparse PDL replay history.
- No fabricated sets, legality exceptions, Pokémon statistics, or private
  opponent information.
- No broad Metamon/PokéChamp data download, training, or deployment until the
  Foul Play experiment contract and PDL custom-format compatibility are
  demonstrated.

## First implementation slice

Implement Phase 1 and the mechanical portions of Phase 2 first. It should
produce reproducible, balanced Foul Play experiment records from frozen PDL
snapshots, but it must not yet publish a public win probability. The next slice
then adds the normalized event parser and attribution report before Metamon is
introduced.
