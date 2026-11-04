"""Measure delayed-payoff policy sensitivity on sanitized recorded positions.

These fixtures replay only the acting bot's public protocol and its own request
state.  Paired variants may mark an *own* reserve Pokemon faint before the
observation projection.  They never read a separate audit or an opponent
request stream.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURES = REPOSITORY_ROOT / "tests" / "fixtures" / "pdl_delayed_payoff"
REPLAY_SCRIPT = REPOSITORY_ROOT / "scripts" / "replay_pdl_position.py"


def load_replay_module():
    spec = importlib.util.spec_from_file_location("pdl_recorded_replay", REPLAY_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {REPLAY_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def focus_metrics(result: dict, action: str) -> dict:
    evidence = result["decisionEvidence"]
    support = evidence["aggregatePolicySupport"].get(action, 0.0)
    world_actions = [
        candidate
        for sample in evidence["beliefSamples"]
        for candidate in sample["actions"]
        if candidate["action"] == action
    ]
    return {
        "support": support,
        "meanRolloutUtility": (
            sum(candidate["meanRolloutUtility"] for candidate in world_actions) / len(world_actions)
            if world_actions
            else None
        ),
        "selected": result["selectedAction"],
        "legal": action in evidence["legalSearchActions"],
    }


def run_scenarios(fixtures_root: Path, search_ms: int | None = None) -> dict:
    definition = json.loads((fixtures_root / "scenarios.json").read_text())
    replay_module = load_replay_module()
    output = {
        "schemaVersion": 1,
        "fixturesRoot": str(fixtures_root),
        "runtime": {
            "searchMsPerWorld": search_ms or definition["searchMsPerWorld"],
            "requestedWorlds": definition["requestedWorlds"],
            "seed": definition["seed"],
        },
        "scenarios": {},
    }
    for name, scenario in definition["scenarios"].items():
        replay = replay_module.ReplayInput(
            trial_directory=fixtures_root / scenario["fixture"],
            actor=scenario["actor"],
            target_turn=scenario["turn"],
            search_ms=search_ms or definition["searchMsPerWorld"],
            requested_worlds=definition["requestedWorlds"],
            seed=definition["seed"],
        )
        result = replay_module.search_recorded_position(
            replay, tuple(scenario.get("unavailableUserSpecies", ()))
        )
        output["scenarios"][name] = {
            "fixture": scenario["fixture"],
            "focusAction": scenario["focusAction"],
            "mutation": scenario.get("unavailableUserSpecies", []),
            "position": result["position"],
            "metrics": focus_metrics(result, scenario["focusAction"]),
            "rootActionSupport": result["decisionEvidence"]["aggregatePolicySupport"],
            "wallClockDecisionMs": result["wallClockDecisionMs"],
        }
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures-root", type=Path, default=DEFAULT_FIXTURES)
    parser.add_argument("--search-ms", type=int)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = run_scenarios(args.fixtures_root.resolve(), args.search_ms)
    serialized = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(serialized)
    else:
        print(serialized, end="")


if __name__ == "__main__":
    main()
