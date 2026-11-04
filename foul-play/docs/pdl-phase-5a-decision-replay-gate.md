# Phase 5A: historical decision-replay gate

## Scope

This phase adds an offline-only `DecisionReplayBundle` to
`scripts/replay_pdl_position.py`. It does not change live Foul Play, poke-engine,
belief sampling, evaluator code, or MCTS behaviour.

The bundle is indexed by the actor's decision ordinal, not battle turn. It
contains only:

- the immutable `ObservedBattleState` serialization used by the live decision
  boundary;
- public historical verification metadata: digest, legal root actions, selected
  action, protocol turn, and request category;
- a SHA-256 digest of the actor's own request, without retaining that request.

It does not contain either opponent request stream, a ground-truth audit, or a
private opponent team.

## Fail-closed checks

`build_decision_replay_bundle` requires all of the following before it returns:

1. a `--decision-ordinal` target (the old `--turn` path remains only for the
   existing synthetic regression fixtures);
2. an ordered `PDL_OBSERVATION`, `PDL_DECISION_EVIDENCE`, and `Choice` triple;
3. agreement between the protocol choice and the evidence selection;
4. inclusion of the selected action in the recorded legal root-action set;
5. an exact match between the reconstructed `ObservedBattleState.digest` and
   the historical observation marker; and
6. agreement between the recorded and reconstructed protocol turn.

An error in any check raises `ReplayFidelityError`. No planner is invoked.

## Historical-artifact result

The first four P1 decisions from this supplied standard trial were checked:

`calculations/adam-vs-steve-team-strategy-standard-20260926-164940/trials/0095-adam-sun-vs-steve-volturn-unburden-forward`

| Decision ordinal | Result |
| --- | --- |
| 0 | rejected: observation digest mismatch |
| 1 | rejected: observation digest mismatch |
| 2 | rejected: observation digest mismatch |
| 3 | rejected: observation digest mismatch |

The replayer now preserves the original public battle tag and player account
names and loads the actor's own recorded team where it is present. Its earlier
synthetic tag was one source of drift, but the archived digests still do not
match the current observation projection. Consequently, these are not exact
historical replay inputs under the current hardened runtime. They are not
eligible for planner comparison.

## Archived planner audit

The supplied `Archive.zip` contains only historical result artifacts, not the
archived planner source. The source used for inspection lives separately at:

`/Users/amanery/Downloads/PDL_S4_Antigravity_Handoff/matchups/2026-09-03__adam-vs-steve`

The old `scripts/run_audited_simulation.js` constructs:

```js
new BattleMemory(this.mode, options.perfectOppTeamSets || null)
```

and the legacy `SetBeliefPrior` supports a `perfect` mode. Its normal
`realistic` path can avoid that data, but the original runner is not a safe
comparison adapter: it consumes raw protocol/request streams, loads its own
hard-coded prior file, has fixed Tera-captain and type assumptions, and uses
separate JavaScript mechanics/evaluation code. Forced switches and team preview
also bypass the advertised MCTS policy.

No broad current-vs-legacy planner comparison was run. The required exact
historical input gate failed, and using the old runner would violate the
single-canonical-bundle and mechanics-parity requirements.

## Validation

At the original Phase 5A hand-off, the three-file replay/boundary command
reported **16 passed**. The earlier report's `15 passed` line was stale; it was
not a behavioural discrepancy.

The current, expanded gate command is:

```text
.venv/bin/python -m pytest tests/test_pdl_replay_position.py \
  tests/test_pdl_observation_boundary.py \
  tests/test_pdl_delayed_payoff_regressions.py \
  tests/test_phase5_bundle.py -q
```

It reports **26 passed** after the current-fixture bundle and aggregate-Tera
gate tests were added.
The original 16-versus-15 accounting is therefore reconciled without changing
the replay gate.

The tests cover decision ordinal handling, move-versus-forced-switch requests on
the same turn, public-bundle projection, strict event ordering, and digest
mismatch rejection.

## Required next input

To run the requested paired comparison, create a new recording under the
current hardened runtime (or preserve the exact older observation serializer
and runtime dependencies) so the artifact's recorded digest can be reproduced.
Then implement a narrow, read-only adapter that takes only
`DecisionReplayBundle.planner_input()` and explicitly rejects the legacy
perfect-information mode and private protocol streams. That adapter must pass
the sentinel test before any pilot comparison.
