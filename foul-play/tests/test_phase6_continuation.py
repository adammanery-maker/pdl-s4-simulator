import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts" / "adjudicate_phase6_continuations.py"
SPEC = importlib.util.spec_from_file_location("phase6_continuation", SCRIPT)
phase6 = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(phase6)


def test_aggregate_uses_frozen_world_weights_and_preserves_leaf_provenance():
    world_zero = {
        "actions": [{
            "action": "attack", "value": 0.8, "terminalProbability": 0.25,
            "evaluatorTruncatedProbability": 0.75, "principalLine": ["attack | recover"],
        }]
    }
    world_one = {
        "actions": [{
            "action": "attack", "value": 0.2, "terminalProbability": 0.75,
            "evaluatorTruncatedProbability": 0.25, "principalLine": ["attack | switch slowbro"],
        }]
    }

    aggregate = phase6.aggregate_worlds([(world_zero, 0.75), (world_one, 0.25)])

    assert aggregate["attack"]["value"] == pytest.approx(0.65)
    assert aggregate["attack"]["terminalProbability"] == pytest.approx(0.375)
    assert aggregate["attack"]["evaluatorTruncatedProbability"] == pytest.approx(0.625)
    assert aggregate["attack"]["principalLine"] == ["attack | recover"]


def test_aggregate_rejects_action_sets_that_differ_across_worlds():
    first = {"actions": [{"action": "attack", "value": 0.5, "terminalProbability": 0, "evaluatorTruncatedProbability": 1, "principalLine": []}]}
    second = {"actions": [{"action": "switch", "value": 0.5, "terminalProbability": 0, "evaluatorTruncatedProbability": 1, "principalLine": []}]}

    try:
        phase6.aggregate_worlds([(first, 0.5), (second, 0.5)])
    except RuntimeError as error:
        assert "action set mismatch" in str(error)
    else:
        raise AssertionError("mismatched world action sets were accepted")


def test_aggregate_clamps_probability_roundoff_to_unit_interval():
    world = {"actions": [{
        "action": "attack", "value": 0.5, "terminalProbability": 0.0,
        "evaluatorTruncatedProbability": 1.0000001, "principalLine": [],
    }]}

    aggregate = phase6.aggregate_worlds([(world, 1.0)])

    assert aggregate["attack"]["evaluatorTruncatedProbability"] == 1.0
