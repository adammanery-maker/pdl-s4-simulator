"""Run seeded fixed-iteration MCTS tree diagnostics on one frozen belief world.

This is intentionally offline and diagnostic-only.  It reconstructs a public
recorded position, lets the existing Foul Play sampler construct one complete
hypothetical world, serializes that world, and calls the opt-in poke-engine
diagnostic binding.  The live bot never imports this script or its output.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import random
import sys
from dataclasses import asdict
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from poke_engine import (
    State as PokeEngineState,
    evaluate_state_breakdown,
    evaluator_metadata,
    monte_carlo_tree_search_diagnostic,
)

from fp.search.poke_engine_helpers import battle_to_poke_engine_state


def load_replay_module():
    path = REPOSITORY_ROOT / "scripts" / "replay_pdl_position.py"
    spec = importlib.util.spec_from_file_location("pdl_recorded_replay", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to import {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def diagnostic_result_to_dict(result) -> dict:
    return {
        "totalIterations": result.result.total_visits,
        "rootVisitFloor": result.root_visit_floor,
        "roots": [asdict(root) for root in result.roots],
        "pathPrefixes": [asdict(path) for path in result.path_prefixes],
    }


def freeze_world(replay, unavailable_user_species: tuple[str, ...], world_seed: int) -> tuple[str, dict]:
    replay_module = load_replay_module()
    random.seed(world_seed)
    battle, observed, recorded_action = replay_module.prepare_recorded_search_position(
        replay, unavailable_user_species
    )
    prepared = battle.mode.prepare_battles(battle, 1)
    if len(prepared) != 1:
        raise RuntimeError(f"Expected one prepared world, got {len(prepared)}")
    complete_battle, weight = prepared[0]
    serialized = battle_to_poke_engine_state(complete_battle).to_string()
    metadata = {
        "recordedAction": recorded_action,
        "observationDigest": observed.digest,
        "worldWeight": weight,
        "worldSeed": world_seed,
        "stateSha256": hashlib.sha256(serialized.encode()).hexdigest(),
        "active": {
            "sideOne": complete_battle.user.active.name,
            "sideTwo": complete_battle.opponent.active.name,
        },
    }
    return serialized, metadata


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--trial", required=True, type=Path)
    parser.add_argument("--actor", required=True, choices=("p1", "p2"))
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--turn", type=int)
    target.add_argument("--decision-ordinal", type=int)
    parser.add_argument("--unavailable-user-species", action="append", default=[])
    parser.add_argument("--iterations", default="10000,50000,120000,500000")
    parser.add_argument("--mcts-seed", default=0, type=int)
    parser.add_argument(
        "--root-floors",
        default="0",
        help="Comma-separated diagnostic-only minimum side-one root visits before UCB resumes.",
    )
    parser.add_argument(
        "--focus-root-action",
        help="Optional generic root action whose top downstream side-one prefixes are recorded.",
    )
    parser.add_argument("--world-seed", default=0, type=int)
    parser.add_argument("--freeze-state", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    budgets = [int(value) for value in args.iterations.split(",") if value]
    root_floors = [int(value) for value in args.root_floors.split(",") if value]
    if not budgets or any(value <= 0 for value in budgets):
        parser.error("--iterations must contain positive integers")
    if not root_floors or any(value < 0 for value in root_floors):
        parser.error("--root-floors must contain non-negative integers")
    replay_module = load_replay_module()
    if args.decision_ordinal is not None and args.decision_ordinal < 0:
        parser.error("--decision-ordinal must be non-negative")
    replay = replay_module.ReplayInput(
        trial_directory=args.trial.resolve(),
        actor=args.actor,
        target_turn=args.turn,
        # The fixed-iteration binding does not use this, but the position
        # reconstruction requires a valid positive search duration.
        search_ms=1,
        requested_worlds=1,
        seed=args.world_seed,
        target_decision_ordinal=args.decision_ordinal,
    )
    state_text, world = freeze_world(
        replay, tuple(args.unavailable_user_species), args.world_seed
    )
    if args.freeze_state:
        args.freeze_state.write_text(state_text + "\n", encoding="utf-8")

    state = PokeEngineState.from_string(state_text)
    breakdown = evaluate_state_breakdown(state)
    output = {
        "schemaVersion": 1,
        "purpose": "offline fixed-iteration MCTS tree-depth diagnostic",
        "input": {
            "trial": str(args.trial.resolve()),
            "actor": args.actor,
            "turn": args.turn,
            "decisionOrdinal": args.decision_ordinal,
            "unavailableUserSpecies": args.unavailable_user_species,
            "mctsSeed": args.mcts_seed,
            "focusRootAction": args.focus_root_action,
            "rootFloors": root_floors,
        },
        "world": world,
        "engine": {
            "metadata": evaluator_metadata(),
            "rootEvaluation": {
                "pokemon": breakdown.pokemon,
                "hazards": breakdown.hazards,
                "activeEffects": breakdown.active_effects,
                "boosts": breakdown.boosts,
                "tera": breakdown.tera,
                "sideConditions": breakdown.side_conditions,
                "total": breakdown.total,
            },
        },
        "budgets": {},
        "runs": {},
    }
    for iterations in budgets:
        for root_floor in root_floors:
            result = monte_carlo_tree_search_diagnostic(
                PokeEngineState.from_string(state_text),
                iterations,
                args.mcts_seed,
                root_floor,
                args.focus_root_action,
            )
            serialized_result = diagnostic_result_to_dict(result)
            output["runs"][f"{iterations}/floor-{root_floor}"] = serialized_result
            if len(root_floors) == 1:
                output["budgets"][str(iterations)] = serialized_result

    rendered = json.dumps(output, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
