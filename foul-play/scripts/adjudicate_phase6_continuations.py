"""Offline current-engine continuation adjudication for verified Phase 5 bundles.

The tool accepts only schema-v2 bundles whose complete worlds were already
sampled at the live information boundary.  It never reads a trial directory,
team file, protocol, or ground-truth audit.  Each legal root action is forced
against an opponent best response and all roots use the same bounded
expectiminimax continuation.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
POKE_ROOT = ROOT.parent / "poke-engine"
CRATE = POKE_ROOT / "diagnostics" / "current-continuation"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fp.runtime_contract import engine_fingerprint, evaluator_fingerprint


def _load_bundle_module():
    path = ROOT / "scripts" / "build_phase5_bundle.py"
    spec = importlib.util.spec_from_file_location("phase6_bundle_verifier", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


bundle_tools = _load_bundle_module()


def diagnostic_source_sha256() -> str:
    digest = hashlib.sha256()
    files = sorted(CRATE.rglob("*.rs")) + [CRATE / "Cargo.toml", CRATE / "Cargo.lock"]
    for path in files:
        digest.update(path.relative_to(CRATE).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def wrapper_source_sha256() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def diagnostic_binary() -> Path:
    subprocess.run(
        ["cargo", "build", "--offline", "--release", "--manifest-path", str(CRATE / "Cargo.toml")],
        cwd=POKE_ROOT,
        check=True,
    )
    binary = CRATE / "target" / "release" / "pdl-current-continuation-adjudicator"
    if not binary.exists():
        raise RuntimeError("continuation diagnostic binary was not produced")
    return binary


def verify_runtime(payload: dict[str, Any]) -> None:
    bundle_tools.verify_bundle(payload)
    if payload.get("requestType") == "team-preview":
        raise RuntimeError("team-preview bundles are outside continuation-adjudicator scope")
    runtime = payload.get("runtime", {})
    if runtime.get("engineSourceSha256") != engine_fingerprint():
        raise RuntimeError("bundle engine fingerprint does not match current poke-engine")
    if runtime.get("evaluatorSourceSha256") != evaluator_fingerprint():
        raise RuntimeError("bundle evaluator fingerprint does not match current evaluator")


def run_world(
    binary: Path,
    *,
    state: str,
    actions: list[str],
    depth: int,
    exact_damage_depth: int,
    node_limit: int,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="pdl-phase6-continuation-") as temporary:
        directory = Path(temporary)
        state_path = directory / "state.txt"
        actions_path = directory / "actions.txt"
        state_path.write_text(state)
        actions_path.write_text("\n".join(actions) + "\n")
        completed = subprocess.run(
            [
                str(binary),
                "--state-file", str(state_path),
                "--root-actions-file", str(actions_path),
                "--depth", str(depth),
                "--exact-damage-depth", str(exact_damage_depth),
                "--node-limit", str(node_limit),
            ],
            text=True,
            capture_output=True,
            check=False,
        )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "continuation diagnostic failed")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"continuation diagnostic emitted invalid JSON: {completed.stdout!r}") from error


def aggregate_worlds(world_results: list[tuple[dict[str, Any], float]]) -> dict[str, dict[str, Any]]:
    if not world_results:
        raise RuntimeError("bundle contains no frozen worlds")
    expected = {row["action"] for row in world_results[0][0]["actions"]}
    if not expected:
        raise RuntimeError("continuation diagnostic returned no actions")
    total_weight = sum(weight for _result, weight in world_results)
    if total_weight <= 0:
        raise RuntimeError("frozen world weights do not have positive mass")
    aggregate = {
        action: {
            "value": 0.0,
            "terminalProbability": 0.0,
            "evaluatorTruncatedProbability": 0.0,
            "principalLine": [],
            "principalWorldWeight": -1.0,
        }
        for action in expected
    }
    for result, weight in world_results:
        rows = {row["action"]: row for row in result["actions"]}
        if set(rows) != expected:
            raise RuntimeError("action set mismatch across frozen worlds")
        normalized = weight / total_weight
        for action, row in rows.items():
            target = aggregate[action]
            target["value"] += normalized * row["value"]
            target["terminalProbability"] += normalized * row["terminalProbability"]
            target["evaluatorTruncatedProbability"] += normalized * row["evaluatorTruncatedProbability"]
            if normalized > target["principalWorldWeight"]:
                target["principalWorldWeight"] = normalized
                target["principalLine"] = row["principalLine"]
    for row in aggregate.values():
        row.pop("principalWorldWeight")
        row["terminalProbability"] = min(1.0, max(0.0, row["terminalProbability"]))
        row["evaluatorTruncatedProbability"] = min(
            1.0, max(0.0, row["evaluatorTruncatedProbability"])
        )
    return {action: aggregate[action] for action in sorted(aggregate)}


def adjudicate(
    payload: dict[str, Any],
    depths: list[int],
    exact_damage_depth: int,
    node_limit: int,
) -> dict[str, Any]:
    verify_runtime(payload)
    binary = diagnostic_binary()
    depth_results: dict[str, Any] = {}
    for depth in depths:
        rows: list[tuple[dict[str, Any], float]] = []
        status = "complete"
        error = None
        for world in payload["worldSampling"]["worlds"]:
            try:
                result = run_world(
                    binary,
                    state=world["state"],
                    actions=payload["legalSearchActions"],
                    depth=depth,
                    exact_damage_depth=min(exact_damage_depth, depth),
                    node_limit=node_limit,
                )
            except RuntimeError as failure:
                status = "intractable" if "node limit" in str(failure) else "failed"
                error = str(failure)
                break
            if result.get("engineSourceSha256") != payload["runtime"]["engineSourceSha256"]:
                raise RuntimeError("diagnostic engine fingerprint does not match bundle")
            rows.append((result, world["weight"]))
        if status == "complete":
            aggregate = aggregate_worlds(rows)
            selected = min(aggregate, key=lambda action: (-aggregate[action]["value"], action))
            depth_results[f"d{depth}"] = {
                "status": status,
                "selectedAction": selected,
                "actions": aggregate,
                "worlds": [result for result, _weight in rows],
            }
        else:
            depth_results[f"d{depth}"] = {"status": status, "error": error}
    return {
        "schemaVersion": 1,
        "bundleSha256": payload["bundleSha256"],
        "trialId": payload["trialId"],
        "actor": payload["actor"],
        "decisionOrdinal": payload["decisionOrdinal"],
        "requestType": payload["requestType"],
        "activeSpecies": payload["activeSpecies"],
        "legalRootActions": payload["legalSearchActions"],
        "frozenWorlds": [
            {"index": world["index"], "weight": world["weight"], "stateSha256": world["stateSha256"]}
            for world in payload["worldSampling"]["worlds"]
        ],
        "configuration": {
            "algorithm": "bounded-expectiminimax-current-engine-chance",
            "depths": depths,
            "exactDamageBranchDepth": exact_damage_depth,
            "nodeLimitPerWorldDepth": node_limit,
            "terminalUtility": {"win": 1.0, "loss": 0.0},
            "nonTerminalLeaf": payload["runtime"]["evaluator"],
        },
        "runtime": payload["runtime"],
        "diagnosticSourceSha256": diagnostic_source_sha256(),
        "wrapperSourceSha256": wrapper_source_sha256(),
        "results": depth_results,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--depths", nargs="+", type=int, default=[2, 4, 6])
    parser.add_argument("--exact-damage-depth", type=int, default=1)
    parser.add_argument("--node-limit", type=int, default=5_000_000)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if any(depth <= 0 for depth in args.depths):
        parser.error("depths must be positive")
    if args.exact_damage_depth < 0 or args.node_limit <= 0:
        parser.error("exact damage depth must be non-negative and node limit positive")
    payload = json.loads(args.bundle.read_text())
    result = adjudicate(payload, args.depths, args.exact_damage_depth, args.node_limit)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(args.output)


if __name__ == "__main__":
    main()
