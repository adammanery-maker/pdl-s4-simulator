# PDL S4 battle-agent options

Research date: 2026-08-11. This is an evaluation only; no external agent has
been installed or integrated.

## Decision

Keep the pinned local Pokémon Showdown instance as the authoritative mechanics
engine. No candidate is currently verified as a drop-in, PDL-compatible
decision agent. The most promising near-term evaluation target is Foul Play;
Metamon is the strongest longer-term train/fine-tune platform.

## Compatibility matrix

| Component | What it provides | PDL fit | Blocker before use |
| --- | --- | --- | --- |
| Pokémon Showdown | Custom formats, validation, battle execution, protocol. | Required mechanics authority. | It has no strategic player policy. [Custom rules](https://github.com/smogon/pokemon-showdown/blob/master/config/CUSTOM-RULES.md), [protocol](https://github.com/smogon/pokemon-showdown/blob/master/PROTOCOL.md). |
| poke-env | Python client for scripted agents, self-play, and RL workflows against a Showdown server. | Useful adapter/orchestration layer, not a strong policy itself. | Verify exact custom NatDex PDL format and Tera protocol behavior. It requires Python 3.10+ and recommends a local server. [README](https://github.com/hsahovic/poke-env) |
| Foul Play | Search-based singles Showdown bot backed by Rust `poke-engine`. | Best candidate to evaluate first as a practical strong policy. | Its README does not establish Gen 9 Tera or custom-NatDex compatibility. Audit its opponent-set assumptions, then run fixed PDL legality/Tera tests. Requires Python 3.11+ and Rust. [README](https://github.com/pmariglia/foul-play) |
| Metamon | RL/IL policies, team-preview model, self-play/data pipeline, configurable observations/actions. | Strong long-term option after PDL-specific training or fine-tuning. | Existing Gen 9 policies target OU. Older backends document Tera issues; hidden-team/set prediction must be isolated from ground-truth data. [models](https://github.com/UT-Austin-RPL/metamon#pretrained-models), [backends](https://github.com/UT-Austin-RPL/metamon#battle-backends) |
| PokéChamp | Minimax/LLM agents plus Bayesian hidden-set inference. | Candidate for a small, expensive ensemble/evaluation role. | Documented evaluation is Gen 9 OU. Custom NatDex/PDL support, inference leakage, API cost, and reproducibility require separate validation. [architecture](https://github.com/sethkarten/pokechamp#architecture), [evaluation](https://github.com/sethkarten/pokechamp#reproducing-paper-results) |

## Information boundary

The decision agent may observe only its own complete team, the opposing roster
at team preview, revealed opponent information, and a probabilistic prior from
public usage data. It must never receive actual unrevealed opposing moves,
items, abilities, EVs, or Tera type.

## Recommended evaluation order

1. **Completed 2026-08-11:** an isolated Foul Play spike on macOS/Python 3.11
   installed its Tera-enabled `poke-engine` and passed 70 focused upstream
   format/mode/serialization tests. Out-of-the-box PDL compatibility failed:
   `gen9pdls4` parses as non-National Dex, and its set-data requests for
   `gen9pdls4` returned HTTP 404 from both `play.pokemonshowdown.com` and
   `data.foulplay.cc`; no usable Tatsugiri candidates were loaded. Its global
   Tera handling also has no knowledge of PDL point costs or drafted Tera
   types. Do not integrate it unchanged.
2. A future Foul Play adapter would need an explicit `gen9pdls4` NatDex format
   alias, a versioned local PDL set-belief dataset in place of its remote
   datasets, and an action filter for the PDL Tera rule. Then rerun against the
   pinned PDL Showdown server with hidden-information tests.
3. If Foul Play cannot represent the format/Tera rules, use poke-env only as a
   transport layer for a public-state policy—not as a replacement battle engine.
4. Evaluate Metamon separately in an isolated Python environment after PDL
   trajectories exist for training/finetuning.
5. Reserve PokéChamp for low-volume cross-checks, not the bulk simulation loop.
