# PDL S4 adapter

This fork adds a narrow adapter for `gen9pdls4`. It does not change the
authoritative battle engine: Pokémon Showdown remains responsible for team
validation, action legality, battle mechanics, randomness, and the outcome.

## Rules enforced by the adapter

- `gen9pdls4` uses Generation 9 National Dex mechanics inside Foul Play.
- Foul Play uses a versioned local set-belief file for PDL; it does not request
  Showdown custom-set, Foul Play, or Smogon usage data in this mode.
- A bot may ask to Terastallize only when its active Pokémon costs four points
  or fewer and its known Tera type is a native type or one of its team's two
  drafted Tera types.
- The filter removes only the invalid `-tera` suffix. It does not select a
  different move or invent a Tera type.

The Showdown format must independently enforce the full PDL ruleset. In
particular, this adapter is an agent-side guardrail, not a replacement for
server-side legality validation.

## Local belief snapshot contract

Pass a JSON file with `schemaVersion: 1` through `--pdl-belief-data`. The file
is an immutable input to one simulation batch and must be retained with its
simulation records. It contains candidate distributions, not a hidden actual
opponent set.

```json
{
  "schemaVersion": 1,
  "snapshot": {"id": "pdl-s4-2026-08-11T120000Z"},
  "teams": {
    "adam": {
      "draftedTeraTypes": ["grass", "ghost"],
      "roster": [{"species": "Tatsugiri", "cost": 4}]
    }
  },
  "sets": {
    "tatsugiri": [{
      "weight": 0.75,
      "ability": "Commander",
      "item": "Choice Specs",
      "nature": "Timid",
      "evs": [0, 0, 0, 252, 4, 252],
      "moves": ["Draco Meteor", "Muddy Water", "Dragon Pulse", "Icy Wind"],
      "teraType": "grass"
    }]
  }
}
```

The loader rejects malformed data, unknown/unrostered species, duplicate
ownership, incomplete roster candidate coverage, invalid EVs, illegal Tera
types, and any Tera candidate for a Pokémon costing more than four points.

## Invocation

Use two independently configured bot processes for a local Showdown battle.
Each process needs the same pinned belief snapshot and its own team id:

```bash
python run.py \
  --websocket-uri ws://127.0.0.1:8000/showdown/websocket \
  --ps-username 'PDL Bot Adam' \
  --bot-mode challenge_user \
  --user-to-challenge 'PDL Bot Connor' \
  --pokemon-format gen9pdls4 \
  --pdl-belief-data /absolute/path/pdl-belief-v1.json \
  --pdl-team-id adam \
  --team-name pdl-adam
```

`pdl-adam` follows Foul Play's existing `fp/teams/teams/` lookup convention.
The packed team submitted to Showdown remains the bot's private chosen team.
The belief file is limited to public rosters and weighted plausible sets, and
does not disclose the opponent's particular sampled build.
