# PDL S4 Foul Play Adapter Plan

> **Execution:** This plan is being executed inline in the isolated `feature/pdl-s4-adapter` checkout. It modifies Foul Play only; it does not modify or deploy the production PDL application.

## Goal

Create a maintained, test-covered Foul Play adapter that:

1. recognizes `gen9pdls4` as a Generation 9 National Dex PDL format;
2. loads a versioned, local PDL set-belief dataset instead of requesting generic external set data; and
3. blocks Tera choices that violate PDL S4 rules (only rostered Pokémon costing four points or fewer may Terastallize, and their Tera type must be native or one of their team's drafted Tera types).

## Data contract

`pdl-belief-v1.json` is a portable, versioned input to the adapter. It contains the simulation snapshot identity, public roster ownership/costs/drafted Tera types, and weighted full-set candidates. The adapter treats it as belief data, never as hidden opponent ground truth.

## Tasks

### 1. Add explicit PDL format recognition

**Files**
- Modify: `fp/format_spec.py`
- Add: `tests/test_pdl_format_spec.py`

**Steps**
1. Write failing tests asserting that `gen9pdls4` reports Gen 9, National Dex mechanics, and a PDL S4 flag, while ordinary formats retain current behaviour.
2. Add the minimal format metadata needed by the adapter.
3. Run the focused format tests.

### 2. Add the local PDL belief-data adapter

**Files**
- Add: `fp/pdl/__init__.py`
- Add: `fp/pdl/belief_data.py`
- Add: `fp/pdl/team_datasets.py`
- Add: `tests/fixtures/pdl-belief-v1.json`
- Add: `tests/test_pdl_belief_data.py`

**Steps**
1. Write failing tests for schema parsing, roster/cost lookup, allowed Tera types, set conversion, and invalid input rejection.
2. Implement strict parsing for schema version 1 and deterministic conversion to Foul Play set strings.
3. Implement a `TeamDatasets` replacement that serves only local belief candidates and has no HTTP retrieval path.
4. Run the focused belief-data tests.

### 3. Wire PDL mode into configuration and set inference

**Files**
- Modify: `fp/config.py`
- Modify: `fp/modes/standard_battle.py`
- Add or modify: focused tests alongside existing configuration/mode tests

**Steps**
1. Write failing tests for PDL-specific configuration requiring a local belief-data path and own team id.
2. Add PDL-only configuration options.
3. Route PDL standard battles to local `PdlTeamDatasets` and prevent fallback to `SmogonSets` / remote public sets.
4. Preserve existing non-PDL behaviour.
5. Run the focused configuration and mode tests.

### 4. Add the PDL Tera action filter

**Files**
- Add: `fp/pdl/tera.py`
- Modify: `fp/modes/base.py`
- Add: `tests/test_pdl_tera.py`

**Steps**
1. Write failing tests for high-cost rejection, valid native Tera, valid drafted Tera, invalid Tera rejection, and unchanged non-Tera actions.
2. Implement a side-aware action filter which removes `-tera` when PDL legality is not satisfied.
3. Apply it at the final decision-formatting boundary, before a command is sent to Showdown.
4. Run focused Tera and mode tests.

### 5. Verify the adapter contract

**Files**
- Modify: `README.md` (PDL adapter usage and its information boundary)
- Add: `docs/pdl-s4-adapter.md`

**Steps**
1. Document the JSON contract, invocations, and the requirement to generate/PIN belief snapshots separately from a simulation.
2. Run the complete relevant test suite and static checks.
3. Inspect the working-tree diff and report the exact uncommitted scope. Do not commit, push, or deploy unless requested.

## Acceptance criteria

- `FormatSpec.from_format_string('gen9pdls4')` enables National Dex mechanics and PDL metadata.
- PDL mode cannot run without a local, schema-valid belief file and own team id.
- PDL candidate sets load without contacting `play.pokemonshowdown.com` or `data.foulplay.cc`.
- No PDL path can use the default generic Smogon set source.
- A high-cost PDL Pokémon cannot emit a `terastallize` command; eligible native/drafted Tera types can.
- Existing focused Foul Play format, mode, and poke-engine serialization tests remain passing.
