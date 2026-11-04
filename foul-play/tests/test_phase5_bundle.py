import importlib.util
import sys
from pathlib import Path

import pytest

from fp.config import FoulPlayConfig


SCRIPT = Path(__file__).parents[1] / "scripts" / "build_phase5_bundle.py"
SPEC = importlib.util.spec_from_file_location("phase5_bundle", SCRIPT)
assert SPEC and SPEC.loader
bundle = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bundle
SPEC.loader.exec_module(bundle)


def valid_bundle():
    payload = {
        "schemaVersion": 2,
        "actor": "p1",
        "recordedAction": "knockoff",
        "legalSearchActions": ["knockoff"],
        "observation": {"serialized": "public-observation", "sha256": ""},
        "worldSampling": {"worlds": [{"state": "world", "weight": 1.0}], "sha256": ""},
    }
    payload["observation"]["sha256"] = bundle.hashlib.sha256(
        payload["observation"]["serialized"].encode()
    ).hexdigest()
    payload["legalActionSha256"] = bundle.digest(payload["legalSearchActions"])
    payload["worldSampling"]["sha256"] = bundle.digest(payload["worldSampling"]["worlds"])
    payload["bundleSha256"] = bundle.digest(payload)
    return payload


def test_bundle_verification_is_deterministic_and_fail_closed():
    payload = valid_bundle()
    bundle.verify_bundle(payload)
    assert bundle.digest(payload) == bundle.digest(payload)

    changed = dict(payload)
    changed["recordedAction"] = "switch uxie"
    with pytest.raises(bundle.replay.ReplayFidelityError, match="bundle digest"):
        bundle.verify_bundle(changed)


@pytest.mark.parametrize("field", ["legalSearchActions", "worldSampling"])
def test_bundle_rejects_component_digest_tampering(field):
    payload = valid_bundle()
    if field == "legalSearchActions":
        payload[field] = ["different-action"]
        message = "legal-action"
    else:
        payload[field]["worlds"][0]["state"] = "different-world"
        message = "world digest"
    with pytest.raises(bundle.replay.ReplayFidelityError, match=message):
        bundle.verify_bundle(payload)


def test_bundle_rejects_ground_truth_audit_reference():
    payload = valid_bundle()
    payload["note"] = "private-ground-truth-audit.json"
    payload["bundleSha256"] = bundle.digest({key: value for key, value in payload.items() if key != "bundleSha256"})
    with pytest.raises(bundle.replay.ReplayFidelityError, match="ground-truth"):
        bundle.verify_bundle(payload)


def test_comparison_aggregates_before_applying_the_tera_gate():
    """The diagnostic must select one information-set action, not one/world."""
    comparison_path = Path(__file__).parents[1] / "scripts" / "compare_phase5_planners.py"
    comparison_spec = importlib.util.spec_from_file_location("phase5_compare", comparison_path)
    assert comparison_spec and comparison_spec.loader
    comparison = importlib.util.module_from_spec(comparison_spec)
    sys.modules[comparison_spec.name] = comparison
    comparison_spec.loader.exec_module(comparison)

    # Tera leads in the first world and loses in the second. Its aggregate
    # lead is below the live gate's required margin, so the gate must choose
    # the non-Tera action after aggregation; a per-world gate would differ.
    world_a = {"actions": [
        {"action": "fireblast-tera", "support": 0.608, "q": 0.8},
        {"action": "fireblast", "support": 0.392, "q": 0.7},
    ]}
    world_b = {"actions": [
        {"action": "fireblast-tera", "support": 0.4, "q": 0.2},
        {"action": "fireblast", "support": 0.6, "q": 0.3},
    ]}
    original_margin = FoulPlayConfig.tera_gate_minimum_support_margin
    try:
        FoulPlayConfig.tera_gate_minimum_support_margin = 0.01
        result = comparison.aggregate([(world_a, 0.5), (world_b, 0.5)])
    finally:
        FoulPlayConfig.tera_gate_minimum_support_margin = original_margin
    assert result["selectedActionBeforeTeraGate"] == "fireblast-tera"
    assert result["selectedAction"] == "fireblast"
