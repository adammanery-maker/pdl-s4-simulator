"""Run current native MCTS and current-engine H8 on one frozen bundle.

The script has no access to protocols, team files, audit truth, or legacy JS
assets. It accepts only a verified Phase 5 bundle, writes its already-frozen
world states to temporary files, and asks the isolated Rust diagnostic crate
to search them. Production Foul Play never imports this module.
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
CRATE = POKE_ROOT / "diagnostics" / "current-h8"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fp.runtime_contract import engine_fingerprint, evaluator_fingerprint
from fp.search.main import apply_pdl_tera_confidence_gate


def load_bundle_module():
    path = ROOT / "scripts" / "build_phase5_bundle.py"
    spec = importlib.util.spec_from_file_location("phase5_bundle_compare", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


bundle_tools = load_bundle_module()


def diagnostic_source_sha256() -> str:
    digest = hashlib.sha256()
    for path in sorted(CRATE.rglob("*.rs")) + [CRATE / "Cargo.toml", CRATE / "Cargo.lock"]:
        digest.update(path.relative_to(CRATE).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def diagnostic_binary() -> Path:
    binary = CRATE / "target" / "release" / "pdl-current-h8-diagnostic"
    if binary.exists():
        return binary
    subprocess.run(
        ["cargo", "build", "--offline", "--release", "--manifest-path", str(CRATE / "Cargo.toml")],
        cwd=POKE_ROOT, check=True,
    )
    if not binary.exists():
        raise RuntimeError("current-h8 diagnostic binary was not produced")
    return binary


def run_world(binary: Path, *, planner: str, state: str, actions: list[str], horizon: int, budget: int, seed: int) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="pdl-phase5-") as temporary:
        directory = Path(temporary)
        state_path = directory / "state.txt"
        actions_path = directory / "actions.txt"
        state_path.write_text(state)
        actions_path.write_text("\n".join(actions) + "\n")
        completed = subprocess.run(
            [str(binary), "--planner", planner, "--state-file", str(state_path),
             "--root-actions-file", str(actions_path), "--horizon", str(horizon),
             "--budget", str(budget), "--cpuct", "1.25", "--seed", str(seed)],
            text=True, capture_output=True, check=False,
        )
    if completed.returncode != 0:
        raise RuntimeError(f"{planner} rejected frozen world: {completed.stderr.strip()}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{planner} emitted invalid JSON: {completed.stdout!r}") from error


def aggregate(world_results: list[tuple[dict[str, Any], float]]) -> dict[str, Any]:
    support: dict[str, float] = {}
    q_total: dict[str, float] = {}
    q_weight: dict[str, float] = {}
    for result, weight in world_results:
        for action in result["actions"]:
            name = action["action"]
            support[name] = support.get(name, 0.0) + weight * action["support"]
            q_total[name] = q_total.get(name, 0.0) + weight * action["q"]
            q_weight[name] = q_weight.get(name, 0.0) + weight
    ranked = sorted(support, key=lambda action: (-support[action], action))
    if not ranked:
        raise RuntimeError("planner returned no root actions")
    selected_before_gate = ranked[0]
    # The comparison is intended to exercise the same final PDL decision rule
    # as the live agent.  Root support is aggregated across the frozen belief
    # worlds first; only then may the public Tera confidence gate choose the
    # best supported non-Tera action.  Applying it per world would be a
    # strategy-fusion bug.
    selected = apply_pdl_tera_confidence_gate(selected_before_gate, support)
    return {
        "selectedAction": selected,
        "selectedActionBeforeTeraGate": selected_before_gate,
        "support": {action: support[action] for action in sorted(support)},
        "q": {action: q_total[action] / q_weight[action] for action in sorted(q_total) if q_weight[action]},
    }


def verify_runtime(payload: dict[str, Any]) -> None:
    bundle_tools.verify_bundle(payload)
    runtime = payload.get("runtime", {})
    if runtime.get("engineSourceSha256") != engine_fingerprint():
        raise RuntimeError("bundle engine fingerprint does not match current poke-engine")
    if runtime.get("evaluatorSourceSha256") != evaluator_fingerprint():
        raise RuntimeError("bundle evaluator fingerprint does not match current evaluator")


def run_configuration(payload: dict[str, Any], binary: Path, planner: str, horizon: int, budget: int, seed: int) -> dict[str, Any]:
    expected = payload["legalSearchActions"]
    rows = []
    for world in payload["worldSampling"]["worlds"]:
        result = run_world(
            binary, planner=planner, state=world["state"], actions=expected,
            horizon=horizon, budget=budget, seed=seed + world["index"],
        )
        if result.get("engineSourceSha256") != payload["runtime"]["engineSourceSha256"]:
            raise RuntimeError("planner engine fingerprint does not match bundle")
        rows.append((result, world["weight"]))
    return {
        "planner": planner,
        "horizon": horizon if planner == "h8-neutral" else None,
        "budgetPerWorld": budget,
        "seed": seed,
        "aggregate": aggregate(rows),
        "worlds": [result for result, _weight in rows],
    }


def compare(payload: dict[str, Any], seed: int) -> dict[str, Any]:
    verify_runtime(payload)
    binary = diagnostic_binary()
    results = {
        "native120k": run_configuration(payload, binary, "native", 1, 120_000, seed),
        "native500k": run_configuration(payload, binary, "native", 1, 500_000, seed),
        "h8_512": run_configuration(payload, binary, "h8-neutral", 8, 512, seed),
    }
    top_q = sorted(results["h8_512"]["aggregate"]["q"].values(), reverse=True)
    adaptive = len(top_q) >= 2 and abs(top_q[0] - top_q[1]) <= 0.02
    results["h8_adaptive"] = (
        run_configuration(payload, binary, "h8-neutral", 8, 1024, seed)
        if adaptive else results["h8_512"]
    )
    return {
        "schemaVersion": 1,
        "bundleSha256": payload["bundleSha256"],
        "diagnosticSourceSha256": diagnostic_source_sha256(),
        "configuration": {
            "nativeIterations": [120_000, 500_000], "horizon": 8,
            "h8BudgetPerWorld": 512, "adaptiveBudgetPerWorld": 1024,
            "adaptiveNearTieQ": 0.02, "cpuct": 1.25, "priors": "uniform",
        },
        "adaptiveEscalated": adaptive,
        "results": results,
    }


def compare_h8_horizons(payload: dict[str, Any], seed: int, horizons: list[int]) -> dict[str, Any]:
    """Run only the requested H8 diagnostic horizons on one frozen bundle.

    This deliberately omits native MCTS so the bounded H4/H6 confirmation
    stage cannot be mistaken for another full planner comparison.
    """
    verify_runtime(payload)
    binary = diagnostic_binary()
    results = {
        f"h{horizon}_512": run_configuration(
            payload, binary, "h8-neutral", horizon, 512, seed
        )
        for horizon in horizons
    }
    return {
        "schemaVersion": 1,
        "bundleSha256": payload["bundleSha256"],
        "diagnosticSourceSha256": diagnostic_source_sha256(),
        "configuration": {
            "horizons": horizons, "h8BudgetPerWorld": 512,
            "cpuct": 1.25, "priors": "uniform",
        },
        "results": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--seed", default=0, type=int)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--h8-only-horizons", type=int, nargs="+", default=None,
        help="Run only specified H8 horizons (used for bounded H4/H6 follow-up).",
    )
    args = parser.parse_args()
    payload = json.loads(args.bundle.read_text())
    result = (
        compare_h8_horizons(payload, args.seed, args.h8_only_horizons)
        if args.h8_only_horizons is not None
        else compare(payload, args.seed)
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(args.output)


if __name__ == "__main__":
    main()
