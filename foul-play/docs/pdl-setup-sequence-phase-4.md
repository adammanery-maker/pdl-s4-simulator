# PDL setup-sequence Phase 4 diagnostics

## 1. Executive conclusion

No production decision gate is met. The controlled runs rule out root-action starvation as the explanation for Memento in the tested positions: forcing every side-one root action to receive 1,000–25,000 visits decreases rather than increases Memento's mean leaf utility. The engine can value the downstream sequence once it is reached (replacement, Shell Smash, and a conversion attack), while the root sacrifice remains unattractive. That is not enough to identify a missing evaluator feature or to authorize a behavioural change.

The correct next step is to inspect a mechanically verified, late-game recorded positive control and the selected real-decision replays before changing MCTS, evaluation, preview, or belief sampling.

## 2. Root-floor methodology

`poke-engine` now has an **offline-only**, exact-iteration diagnostic entry point. It uses the normal move generator, side-two UCB selection, stochastic instruction sampling, rollout evaluator, and backpropagation. The sole difference is that, before ordinary root UCB resumes, side-one root options are visited round-robin until each reaches an optional minimum floor. Production `perform_mcts` and the live Python `mcts` binding do not call it.

Runs used one frozen complete belief world, seed 0, and 500,000 iterations. Floors apply to every side-one root option, never to a named move. `selected after floor` below subtracts the common forced-floor allocation; it is therefore the unrestricted-UCB leader, not the raw visit winner contaminated by the floor.

## 3. Root-floor Memento results

The original healthy Uxie-versus-Avalugg state has Memento at 0.394 utility with ordinary allocation. More investigation makes its estimate worse, not better.

| floor | Memento visits | Memento utility | max depth | mean depth | post-floor leader |
| ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 645 | 0.394 | 4 | 2.87 | Psychic Noise |
| 1,000 | 1,000 | 0.373 | 4 | 3.00 | Psychic Noise |
| 5,000 | 5,000 | 0.324 | 5 | 3.54 | Psychic Noise |
| 10,000 | 10,000 | 0.309 | 6 | 3.80 | Psychic Noise |
| 25,000 | 25,000 | 0.292 | 6 | 4.14 | Psychic Noise |

At floor 0 Psychic Noise had 86.3% support and 0.588 utility. Memento's generic prefix trace does reach `Memento → Drednaw → Shell Smash`, but sparsely; at 5,000 forced Memento visits that prefix had 144 evaluations and 0.433 mean leaf utility. The useful line is reached, but it does not lift the root average.

## 4. Memento positive-control proof

A controlled complete-information chain was constructed from the existing safe-Shell-Smash frozen world using only engine-generated transitions:

1. Drednaw switches to Uxie while Slowbro-Galar uses Slack Off.
2. Healthy Uxie uses Memento before Slowbro-Galar's Flamethrower; Uxie faints and Slowbro-Galar receives -2 Attack and -2 Special Attack.
3. Healthy Drednaw enters legally. The representative ordinary outcome of the -2 Flamethrower loses 12 HP (332 to 320).
4. Drednaw uses Shell Smash; White Herb restores the defensive drops and the representative -2 Flamethrower loses 12 HP (320 to 308).
5. +2 Crunch has a 58.1% ordinary-roll direct KO branch against the remaining full-HP Slowbro-Galar; the other ordinary Crunch rolls deal 377 of 394 HP. Liquidation deals 211 or 318 HP depending on roll/critical branch.

The state construction and probability-selected legal instruction lineage are retained in the Phase 4 JSON artifact. The representative outcome was the highest-probability ordinary outcome, never a favourable rare roll. The engine also selected Drednaw at M1 and Shell Smash at M2, so this is a valid downstream tactical control. It does **not** prove that Memento is the best M0 action while Stealth Rock remains available; that distinction is decisive for the gate below.

## 5. Memento M0/M1/M2/M3 sequence

| checkpoint | intended action | 120k result | 500k result | interpretation |
| --- | --- | --- | --- | --- |
| M0, Uxie vs Slowbro-Galar | Memento | 421 visits, 0.381; Stealth Rock leads | 452 visits, 0.371; Stealth Rock leads | root rejects sacrifice |
| M1, forced replacement | Switch Drednaw | 97.1% support | 98.5% support | beneficiary choice works |
| M2, Drednaw vs -2 Slowbro-Galar | Shell Smash | 68.9% support | 50.5% support | safe setup is valued |
| M3, post-Smash | Crunch | Stone Edge leads at 120k; Crunch leads at 500k | Crunch leads, 39.4% support | conversion is found at larger budget |

At M0, even a 25,000-per-root floor produces 0.339 Memento utility (depth 7, mean depth 4.15) and leaves Stealth Rock as the post-floor leader. The evidence isolates the rejection to the sacrifice/root tradeoff, but does not show a value reversal after adequate root investigation.

## 6. Sun S0/S1/S2/S3 sequence

The coherent Sun replay has the following current-runtime results.

| checkpoint | intended action | 120k | 500k | result |
| --- | --- | ---: | ---: | --- |
| S0, before positioning | Switch Whimsicott | 47.4% | 44.2% | selected at both budgets |
| S1, setter active and Sun absent | Sunny Day | 65.9% | 91.8% | selected at 120k and 500k |
| S2, Sun active | Switch Scovillain | 34.4% | 26.5% | legal and substantial, but Moonblast leads at 120k/500k |
| S3, Scovillain under Sun | Growth | 18.0% | 18.5% | direct Fire Blast leads; Growth is not assumed correct |

The S1 counterfactual without Scovillain had only about 0.8% Sunny Day support at 500k. This confirms that the existing search recognizes beneficiary-specific Sun value. It does not establish that every real Sun opening should be forced through Scovillain.

## 7. Real 150-game Sun decision audit

The original 150 Sun trials (runtime v2, stock evaluator) contain 1,216 decisions with Sunny Day legal: 71 selected and 1,145 rejected; 809 occurred by turn 20. Lead distribution was Incineroar 79, Magneton 41, Uxie 25, Tatsugiri 5, and zero Whimsicott/Scovillain leads.

These counts are an inventory, not a claim that all 1,145 rejections were mistakes. The targeted replay runner currently targets a protocol turn rather than a decision ordinal, so it cannot yet safely select the requested deterministic 10-early/10-midgame sample when multiple requests occur in one turn. No speculative classification was made. The S0–S3 replay above is the mechanically reconstructed representative run at current runtime v5.

## 8. Real 150-game Memento decision audit

The original 150 Shell-Smash trials contain 1,430 decisions with Memento legal: 73 selected and 1,357 rejected; 815 occurred by turn 20. The candidate inventory must additionally filter for living Drednaw and a support user above 50% HP before calling a rejection a missed setup opportunity.

The original healthy-Avalugg replay and the controlled Slowbro-Galar chain show why that filter matters: a legal Memento can be genuinely inferior despite a later Drednaw line being viable. The decision-ordinal replay extension is required before rerunning a representative historical sample at 120k/500k without risking protocol/action drift.

## 9. Team-preview lead audit

The historical Memento lead distribution is Drednaw 81, Magneton 45, Incineroar 22, Uxie 2, and zero Whimsicott; the Sun distribution is in section 7. This makes preview/positioning a credible hypothesis, but the available replay helper has no decision-index-0 reconstruction that mirrors live team preview. It would be misleading to treat an ordinary turn-one reconstruction as a preview rerun.

No preview behaviour is changed. The missing work is a diagnostic-only preview projection and decision-ordinal targeter, followed by six clean Adam-build × Steve-build preview positions at 120k and 500k.

## 10. Matched Growth control

A safe/danger matched Growth pair is not yet available. The S3 control establishes that direct Fire Blast can remain better even after Sun and Scovillain positioning work, so a generic Growth expectation would be invalid. A valid pair needs to retain the same Scovillain and opponent state while deriving the safety difference from legal transitions; no evaluator change was made in lieu of that control.

## 11. Matched Shell Smash control

The current nearest pair is informative but not tightly matched: safe Shell Smash received 85.1% support at 120k and 54.6% at 500k, while dangerous Shell Smash received 8.3% and 8.5% and the agent selected a switch. The controlled M2 state also selects Shell Smash at both budgets. This demonstrates setup-window discrimination, but it is not yet the requested same-board/debuff-only pair.

## 12. Decision gate reached

**Gate E-style caution, not a production gate.** Root starvation (Gate A) is rejected for the tested Memento root: floors exposed lower, not higher, Memento utility. Gate D is not supported for Memento because 500k does not discover a reversal. Gate C remains plausible but unproven because preview was not safely replayed. Gate B is not proven because the M0 control does not establish that Memento should beat Stealth Rock, and no missing static-evaluation feature has been isolated.

## 13. Recommended minimal production change, if any

None. Keep deterministic argmax, current world sampling, evaluator, and normal MCTS unchanged. The only code added is offline diagnostic instrumentation and a root-floor regression test; it is not on the live decision path.

## 14. Expected computational cost

A 500,000-iteration one-world diagnostic took roughly 1–2 seconds for these frozen positions on this machine. A full real-decision sample (20 Sun plus 20 Memento positions, two budgets, and Memento floor matrix) should be run only after decision-ordinal replay exists; its cost is expected to be minutes rather than normal per-decision latency. Normal runtime remains at its configured 120k-ish study budget and has no floor overhead.

## 15. Remaining uncertainty

The highest-value missing evidence is a decision-index-safe replay audit of the real trials and a true late-game M0 where Memento is externally verified as strategically superior to its legal alternatives. Until then, the observed root rejection could reflect a correct resource trade, a long-horizon credit limitation, or preview positioning. The present data do not distinguish those possibilities safely enough to tune the agent.
