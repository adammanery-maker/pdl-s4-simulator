# Sun strategy experiments S1 and S2

These experiments keep all eight team exports and the existing native fixed-120K MCTS, evaluator, posterior and sampled-world machinery unchanged. Only Adam candidate `adam-03-sun-drednaw` receives an explicitly selected experiment policy. Steve has no policy override.

- **S1 / `sun-lead-only-v1`:** exclude Drednaw from team-preview lead selection, then choose the highest-supported remaining aggregate MCTS action.
- **S2 / `sun-sequence-v1`:** apply S1, then the following sequence constraints: while Scovillain lives and Sun is inactive, exclude Whimsicott's Memento. Force Sunny Day when Whimsicott is active, Scovillain lives, Sun is inactive, Sunny Day is legal, and at least one late-window condition holds: turn >= 11, Adam has <= 4 living Pokémon, or Steve has <= 4 living Pokémon. Under active Sun, Memento is available normally. After public protocol confirms a successful Whimsicott Memento self-faint creates a forced replacement in active Sun, choose a living legal Scovillain. Scovillain's Growth, attacks, switches and Tera are chosen normally.

The hook operates after belief-weighted root action aggregation and before the existing Tera gate. It changes eligible/forced selections without changing HP, move flags, reserve order, engine state, sampled worlds or evaluation scores. Search still explores the ordinary legal tree; future rollout decisions are not constrained by this experiment policy. This is a limited execution experiment, not a new search algorithm.

`strategyPolicy` is opt-in manifest data, included in manifest/config identity and trial metadata. The bot receives its own candidate ID and policy only. Its runtime attestation and decision evidence record the policy; enabled policies are rejected for other candidates/sides. Old results remain historical artifacts and cannot be resumed into a changed source/configuration.

Both experiment manifests retain the seed namespace `adam-vs-steve-initial`. Each includes the unchanged Sun candidate and the same four supplied Steve opponents, both orientations and three seeds. Therefore each has 24 cells aligned to the completed baseline; S1 and S2 together have 48 battles. Source/configuration and result directories distinguish the experiments, despite shared seed values.

## Telemetry

Each battle's Sun record is derived from the Adam-perspective protocol, own submitted team and actor-private observation/decision records. It does not read the opponent's ground-truth audit. Record successful Sun activation separately from Sunny Day attempts; all Scovillain entries, HP and opposing active Pokémon; Memento chains; Growth legality, selection and execution; attacks/damage under Sun; Tera; causal KOs under Sun; and outcome.

Sun duration uses ordered activation/upkeep/end events. Adam's known Whimsicott Heat Rock implies eight turns, while Uxie's Eject Button implies five. Unknown opposing setter items produce an interval instead of an exact duration. The existing client timer defaults move-set weather to five turns; this experiment deliberately does not change that mechanics path. Accurate telemetry and reported-client timer disagreements should remain visible when interpreting results.

The original Sun candidate went 4–20, led Drednaw in 10 games, and had a Scovillain attack under Sun in only 4 games. That evaluates the original planner's execution, and does not isolate the intended Sun sequence. Small rerun samples remain exploratory.

The real experiments are launched from Terminal, independently of Codex. No runtime LLM or hosted inference is introduced. Use separate output directories; add `--resume true` only when resuming the same experiment/configuration.

## Saved baseline reanalysis

`calculations/adam-vs-steve-sun-baseline-analysis/` contains 24 per-battle records and a summary generated from the saved actor-visible artifacts. No new battle was launched. The baseline was 4 wins / 20 losses, with 10 Drednaw leads, Sun in 6 battles, Scovillain entry and attack under Sun in 4 battles, no Whimsicott Memento-to-Scovillain Sun entries, 2 direct Scovillain KOs under Sun, and 1 Scovillain Tera battle. Growth was legal in 64 recorded decisions, selected 8 times and publicly executed 5 times. One Sun-entry episode had a client weather-timer discrepancy. These are descriptive execution metrics, not proof that Sun is weak.

Per-trial `sun-strategy.json`, run-level `sun-strategy-cells.jsonl` and `sun-strategy-summary.json` are written for the reruns. Each resumed Sun cell rechecks its actor-visible input hash, recomputes telemetry, and compares the cell and per-trial records before skipping it. Failed or incomplete cells remain separate from clean result rates.

## Terminal launch

Run from Terminal after closing Codex if desired. The local runtime strips model credentials and permits only Showdown loopback networking. No model inference is used.

```bash
cd "/Users/amanery/PDL Vercel App/pdl-s4-simulator"
unset OPENAI_API_KEY CODEX_API_KEY ANTHROPIC_API_KEY GOOGLE_API_KEY GEMINI_API_KEY

# S1: lead exclusion only; 24 battles
npm run pdl:team-search -- --manifest pdl/team-search/runs/adam-vs-steve-sun-s1.json --preset quick --foul-root "/Users/amanery/PDL Vercel App/pdl-s4-foul-play" --output calculations/adam-vs-steve-sun-s1-quick

# S2: full sequence; 24 battles
npm run pdl:team-search -- --manifest pdl/team-search/runs/adam-vs-steve-sun-s2.json --preset quick --foul-root "/Users/amanery/PDL Vercel App/pdl-s4-foul-play" --output calculations/adam-vs-steve-sun-s2-quick
```

The runner prints `[completed/scheduled]` after each battle. In another Terminal, inspect the current run with:

```bash
cat "/Users/amanery/PDL Vercel App/pdl-s4-simulator/calculations/adam-vs-steve-sun-s1-quick/summary.json"
tail -f "/Users/amanery/PDL Vercel App/pdl-s4-simulator/calculations/adam-vs-steve-sun-s1-quick/sun-strategy-cells.jsonl"
```

Use the corresponding `s2` path for S2. Add `--resume true` to the same launch command if interrupted; changing code, teams, priors or configuration invalidates reuse.

## Validation and limits

Both `pdl:prepare-team-search` runs validate the unchanged candidate and four opponents with zero errors. The initial manifest also validates all eight complete teams, and SHA-256 checks confirm all eight exports stayed byte-identical during this experiment implementation. S1/S2 final dry-run artifacts are saved in `calculations/adam-vs-steve-sun-s1-quick-dry-run-final/` and `calculations/adam-vs-steve-sun-s2-quick-dry-run-final/`; each schedule has 24 cells, all four seed streams match the saved baseline, and `runnerCalls` is zero.

Focused wrapper/telemetry tests, the focused Foul Play policy/Tera/boundary/offline suite, and TypeScript checking pass. The broad Foul Play suite retains one unrelated existing Leftovers-upkeep inference failure; this experiment does not repair or weaken that test. Scoped TypeScript lint has no errors but retains style warnings. No new full battle was run inside Codex; new policy efficacy remains to be measured by the Terminal experiments.

The existing live client assumes five turns for move-set Sun; it does not correctly carry Whimsicott's eight-turn Heat Rock duration into every hypothetical search world. This remains an explicit limitation and is logged separately. The experiment gates only current root selections; hypothetical future rollout choices are unconstrained. Entry HP is the switching protocol condition before any subsequent hazard damage. Small samples and conditional conversion statistics remain exploratory.
