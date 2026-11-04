import io
import json
import logging
from types import SimpleNamespace

from fp.config import CustomFormatter, FoulPlayConfig
from fp.search.main import (
    apply_pdl_tera_confidence_gate,
    find_best_move,
    select_move_from_mcts_results,
)


def test_pdl_tera_gate_strips_tera_without_clear_policy_support_margin():
    policy = {"flamethrower-tera": 0.31, "switch tatsugiri": 0.28, "flamethrower": 0.22}

    assert apply_pdl_tera_confidence_gate("flamethrower-tera", policy, minimum_margin=0.05) == "switch tatsugiri"


def test_pdl_tera_gate_preserves_aggregate_argmax_when_rejecting_tera():
    policy = {
        "flamethrower-tera": 0.31,
        "switch tatsugiri": 0.30,
        "flamethrower": 0.12,
    }

    assert apply_pdl_tera_confidence_gate(
        "flamethrower-tera", policy, minimum_margin=0.05
    ) == "switch tatsugiri"


def test_pdl_tera_gate_keeps_tera_when_policy_support_clears_margin():
    policy = {"flamethrower-tera": 0.41, "switch tatsugiri": 0.28, "flamethrower": 0.22}

    assert apply_pdl_tera_confidence_gate("flamethrower-tera", policy) == "flamethrower-tera"


def test_pdl_tera_gate_never_changes_non_tera_action_choice():
    policy = {"flamethrower-tera": 0.60, "switch tatsugiri": 0.20}

    assert apply_pdl_tera_confidence_gate("switch tatsugiri", policy) == "switch tatsugiri"


def test_pdl_decision_evidence_is_json_after_custom_formatter(monkeypatch):
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(CustomFormatter())
    search_logger = logging.getLogger("fp.search.main")
    search_logger.addHandler(handler)
    previous_logging_disable = logging.root.manager.disable
    logging.disable(logging.NOTSET)
    search_logger.setLevel(logging.INFO)
    monkeypatch.setattr(FoulPlayConfig, "action_policy", "argmax", raising=False)
    result = SimpleNamespace(
        total_visits=10,
        side_one=[SimpleNamespace(move_choice="flamethrower", visits=10, total_score=5.0)],
    )

    try:
        select_move_from_mcts_results([(result, 1.0, 0)], pdl_s4=True, battle_turn=7)
    finally:
        search_logger.removeHandler(handler)
        logging.disable(previous_logging_disable)

    evidence_payload = next(
        line.split("PDL_DECISION_EVIDENCE ", 1)[1]
        for line in stream.getvalue().splitlines()
        if "PDL_DECISION_EVIDENCE " in line
    )
    assert evidence_payload.startswith("{")
    evidence = json.loads(evidence_payload)
    assert evidence["turn"] == 7
    assert evidence["beliefSamples"][0]["topActionAverageRolloutUtility"] == 0.5
    assert "topActionAverageStateScore" not in evidence["beliefSamples"][0]


def test_single_worker_search_runs_all_weighted_beliefs_without_process_pool(monkeypatch):
    calls = []
    mode = SimpleNamespace(
        search_params=lambda _battle: (2, 5000),
        prepare_battles=lambda _battle, _count: [("belief-a", 0.7), ("belief-b", 0.3)],
    )
    battle = SimpleNamespace(
        team_preview=False,
        mode=mode,
        format_spec=SimpleNamespace(pdl_s4=False),
        turn=11,
    )
    monkeypatch.setattr(FoulPlayConfig, "parallelism", 1, raising=False)
    monkeypatch.setattr(FoulPlayConfig, "search_threads", 1, raising=False)
    monkeypatch.setattr(
        "fp.search.main.ProcessPoolExecutor",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("single-worker search created a process pool")),
    )
    monkeypatch.setattr(
        "fp.search.main.battle_to_poke_engine_state",
        lambda belief: SimpleNamespace(to_string=lambda: f"state-{belief}"),
    )

    def fake_result(state, search_time_ms, index, threads):
        calls.append((state, search_time_ms, index, threads))
        return SimpleNamespace(
            total_visits=10,
            side_one=[SimpleNamespace(move_choice="flamethrower", visits=10, total_score=5.0)],
        )

    monkeypatch.setattr("fp.search.main.get_result_from_mcts", fake_result)
    monkeypatch.setattr(FoulPlayConfig, "action_policy", "argmax", raising=False)

    assert find_best_move(battle) == "flamethrower"
    assert calls == [
        ("state-belief-a", 5000, 0, 1),
        ("state-belief-b", 5000, 1, 1),
    ]


def test_evaluation_action_policy_is_deterministic_argmax_with_stable_ties(monkeypatch):
    monkeypatch.setattr(FoulPlayConfig, "action_policy", "argmax", raising=False)
    result = SimpleNamespace(
        total_visits=20,
        side_one=[
            SimpleNamespace(move_choice="voltswitch", visits=10, total_score=5.0),
            SimpleNamespace(move_choice="thunderbolt", visits=10, total_score=5.0),
        ],
    )

    assert select_move_from_mcts_results([(result, 1.0, 0)]) == "thunderbolt"
