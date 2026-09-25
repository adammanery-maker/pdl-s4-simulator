# PDL S4 local simulation prototype

This standalone repository is pinned to Pokémon Showdown commit `2180a5c998b9c930863c5734ab7500bbd301952a` (2026-01-30). It is not connected to the PDL web application or production Redis data.

Run the local acceptance fixture with:

```bash
npm ci
npm run pdl:acceptance
```

The prototype uses Showdown as the battle authority and adds a PDL pre-validator:

- Gen 9 National Dex mechanics;
- January 2026 Gen 9 NU clauses and non-tier bans;
- any species allowed only when it appears in the submitted current-roster manifest;
- exactly six distinct Pokémon from that roster;
- Tera only for Pokémon costing four or fewer, using a native type or one of the team's two drafted Tera types;
- no Mega Evolution, Z-Moves, or Dynamax.

Every battle record retains the fixed seed, Showdown commit, PDL format ID, supplied teams, raw protocol log, canonical protocol log, winner, and scripted choices. The canonical log removes only Showdown's wall-clock annotation; the fixture runs twice and requires those logs to match exactly.

## Local batch simulations

All new matchup and experiment results use the single runtime contract
`pdl-s4-foul-play-showdown-local-v2`: local Showdown, a Foul Play client on
each side, serialized `pdl.observed-battle.v1` observations, poke-engine MCTS,
and deterministic aggregate-support argmax. Trial manifests, per-trial rows,
run metadata, and summaries carry this runtime identity; aggregation refuses
trials from an unmarked or different runtime. M0 v2 is retained only as a
historical full-information artifact and is not an eligible evaluation
baseline.

Foul Play must be installed with the instrumented poke-engine 0.0.48 build
from the sibling `../poke-engine` checkout. Its preflight pins both the exact
native evaluator and the complete compiled engine/binding source tree; a
mismatch stops a trial before Showdown starts. Simulation children have
hosted-model credentials stripped, may reach only the configured loopback
Showdown port, and run in a per-agent macOS sandbox that denies the complete
run-output directory except for that agent's private inputs. Showdown binds to
`127.0.0.1`.
Run the complete-battle smoke test with:

```bash
npm run pdl:test-offline-runtime
```

It starts two real Foul Play clients, removes fake model credentials from
their environments, and fails if the battle does not finish or any non-local
connection is attempted.

The local runner reads the public, transaction-projected PDL roster endpoint,
freezes it into an immutable snapshot, samples complete PDL-legal sixes, and
runs each sampled pair on both player sides through local Showdown and Foul
Play. It never writes to the PDL site, Vercel, or Redis.

From this repository, run:

```bash
npm run pdl:simulate -- \
  --live-url https://pdl-s4.vercel.app/api/roster-transactions \
  --team-a adam --team-b connor --battles 100 --search-ms 100 \
  --foul-root '../pdl-s4-foul-play' \
  --output /private/tmp/pdl-adam-vs-connor-100
```

`--battles` is the number of sampled team pairs. The runner executes twice that
many battles: forward and reverse player-side assignments for every exact
sampled pair. It records successful, rejected, failed, and timed-out trials
separately and calculates results only from complete pairs.

Use `--belief-samples N` to select the number of parallel belief-world searches
(default 8). The output directory contains `snapshot.json`, `run.json`, append-only
`trials.jsonl`, `summary.json`, `report.html`, and one directory per trial.
Each trial preserves the PDL belief snapshot, private packed/exported teams,
protocol transcripts, agent logs, manifest, and terminal result. The report
contains descriptive records for teams, Pokémon, exact builds, moves, leads,
Tera uses, and teammate pairs, each with sample counts and Wilson intervals.

The runner requires the separate local Foul Play adapter checkout at the path
given by `--foul-root`. Metamon and PokéChamp are deliberately not blended into
these Foul Play estimates; they remain future independent-policy checks.

## Play against Foul Play locally

To play a real PDL S4 match yourself, run the bot with an exact six-Pokémon
Showdown export. The launcher reads the public transaction-projected roster
once, freezes it locally, verifies the bot’s six against its full current
roster and PDL rules, then starts the pinned local Showdown server and Foul
Play. It never writes to the PDL website, Vercel, or Redis.

```bash
cd "/Users/amanery/PDL Vercel App/pdl-s4-simulator"
npm run pdl:play-bot -- \
  --team-id adam \
	  --opponent-team-id connor \
  --team-file "/Users/amanery/Downloads/Adam Sample Team.txt" \
  --foul-root "/Users/amanery/PDL Vercel App/pdl-s4-foul-play"
```

The command prints a browser URL like:

```text
https://play.pokemonshowdown.com/testclient.html?~~localhost:8000
```

`--opponent-team-id` is the PDL team you will play as. Open that URL, choose a
guest name, import six Pokémon from that team’s current roster in Team Builder,
and challenge **PDL Foul Play** in the **PDL S4** format. Press `Ctrl-C` in the
Terminal window when finished. The printed `/private/tmp/pdl-play-...` folder
contains the frozen roster snapshot, two-team bot belief file, exact bot team,
Showdown log, Foul Play log, and protocol capture.

The local server enforces the battle format; it cannot infer a guest player’s
league ownership. The launcher provides Foul Play only the two public rosters
in the selected matchup, never your hidden build choices.

### Constraining a sampled matchup

For a one-off prep question, constraints can go directly in the terminal
command—no JSON file is needed. They are checked against the frozen current
roster and PDL/Showdown legality before a battle starts:

```bash
npm run pdl:simulate -- \
  --live-url https://pdl-s4.vercel.app/api/roster-transactions \
  --team-a adam --team-b connor --battles 25 --search-ms 100 \
  --foul-root '../pdl-s4-foul-play' --output /private/tmp/pdl-adam-specific \
  --require-a golem,tatsugiri --exclude-a scovillain \
  --require-b flygon \
  --lock-a 'Golem|Custap Berry|Sturdy|Adamant|4,252,0,0,0,252|Explosion,Earthquake,Stealth Rock,Rock Blast|Rock'
```

- `--require-a` / `--require-b`: comma-separated Pokémon that must be in that side's sampled six. Repeat the flag if clearer.
- `--exclude-a` / `--exclude-b`: comma-separated roster Pokémon the sampler must not bring. Repeat the flag if clearer.
- `--lock-a` / `--lock-b`: repeatable exact build lock. Its required format is:
  `Species|Item|Ability|Nature|HP,Atk,Def,SpA,SpD,Spe|Move1,Move2,Move3,Move4|TeraType`.
  Leave the last field empty to use no Tera type, for example `...|U-turn|`.

A locked Pokémon is automatically required. Every chosen species must be on
that team’s current 10-Pokémon roster; no constraint changes the roster data.
The normalized constraints are stored in `run.json`, every trial manifest, and
the local HTML report.

## Structured multi-roster experiments

Use `pdl:experiment` for fixed roster variants, multiple teams, and a balanced
cross-schedule. The command reads one strict JSON plan from standard input; the
plan is local-only and can be generated as a complete heredoc by another agent.
It does not ask the agent to inspect, fetch, or process site JSON.

```bash
cd "/Users/amanery/PDL Vercel App/pdl-s4-simulator" && \
npm run pdl:experiment -- --plan - <<'PDL_PLAN'
{
  "version": 1,
  "teams": {
    "left": {
      "teamId": "adam",
      "variants": [
        {
          "id": "adam-sun",
          "locks": [
            "Flamigo|Choice Scarf|Scrappy|Adamant|0,252,0,0,4,252|Close Combat,Brave Bird,U-turn,Upper Hand|",
            "Tatsugiri|Heavy-Duty Boots|Storm Drain|Quiet|252,0,252,4,0,0|Draco Meteor,Mirror Coat,Rapid Spin,Counter|"
          ],
          "require": ["Uxie"],
          "exclude": ["Inteleon"]
        },
        { "id": "adam-balanced" }
      ]
    },
    "right": {
      "teamId": "connor",
      "variants": [
        { "id": "connor-core-a", "require": ["Flygon", "Heracross", "Ribombee"] },
        { "id": "connor-core-b", "require": ["Flygon", "Heracross", "Ribombee"] }
      ]
    }
  },
  "schedule": { "strategy": "balanced-cross", "totalPairs": 20 },
  "simulation": {
    "searchMs": 100,
    "foulRoot": "/Users/amanery/PDL Vercel App/pdl-s4-foul-play",
    "output": "/private/tmp/pdl-adam-vs-connor-experiment"
  }
}
PDL_PLAN
```

Every variant is frozen into one distinct PDL-legal six before a battle starts.
An empty variant uses the normal deterministic sampler; a partial variant fixes
its locks/requirements while the sampler fills the remainder; six locks make a
fully fixed team. The source plan, resolved plan, frozen roster snapshot, and
all battle artifacts are saved in the output directory.

### Declared Tera type versus usable Tera

An over-four-point Pokémon cannot Terastallize in PDL. If an imported locked
build nevertheless includes its displayed Tera type, keep that final lock field
as written: the experiment runner automatically moves it to
`teraReferences` metadata and clears it from the actual packed Showdown set.
That preserves the coaching/build note in `plan.resolved.json` while preventing
Showdown and Foul Play from receiving a Tera action for that Pokémon. You may
also state this explicitly on a required or locked Pokémon:

```json
"teraReferences": { "Flamigo": "Ghost" }
```

For a four-point-or-lower Pokémon, the final lock field remains a real PDL Tera
type and can be used in battle when legal.

### Testing free-agent additions

Experiment variants can test a Pokémon that is currently in the frozen live
free-agent pool without changing league ownership. Use `freeAgents` with an
optional `replace` field:

```json
{
  "id": "adam-rhydon-over-drednaw",
  "freeAgents": [{ "pokemon": "Rhydon", "replace": "Drednaw" }],
  "require": ["Rhydon"]
}
```

This is a direct temporary add/drop: Rhydon replaces Drednaw only in that
variant. Omit `replace` to expand the simulation roster and let the sampler
decide whether to bring the free agent:

```json
{
  "id": "adam-try-xatu",
  "freeAgents": [{ "pokemon": "Xatu" }]
}
```

The requested Pokémon must be in the current frozen free-agent pool. Its cost,
observed usage, and PDL Tera restrictions are retained. The source snapshot,
live roster, transaction ledger, and free-agent pool are never changed.

When multiple variants intentionally share the same required core (for example,
eight Connor variants all requiring Flygon, Heracross, and Ribombee), the
experiment resolver deterministically selects different viable complements from
the remaining current roster. Inspect `plan.resolved.json` before interpreting a
large run; it records the exact six and builds for every named variant.

`balanced-cross` requires the pair total to divide evenly across the number of
variants on each side. It schedules every cross-cell as evenly as possible. For
8 Connor variants and 4 Adam variants across 200 pairs, each Connor variant is
used 25 times, each Adam variant 50 times, 24 cells run six pairs, and eight
cells run seven. Every pair is then played forward and reverse, so that command
runs 400 battles.

Version 1 deliberately supports `balanced-cross` only. It rejects `paired` and
`explicit` plans rather than quietly substituting a different schedule. Reports
include overall results plus variant and cross-matchup-cell records.
