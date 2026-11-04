import importlib.util
import logging
import sys
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts" / "replay_pdl_position.py"
SPEC = importlib.util.spec_from_file_location("replay_pdl_position", SCRIPT)
assert SPEC and SPEC.loader
replay = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = replay
SPEC.loader.exec_module(replay)


def test_protocol_chunks_retains_only_public_protocol_lines(tmp_path):
    protocol = tmp_path / "protocol.log"
    protocol.write_text(
        ">battle-gen9pdls4-1\n"
        "|turn|1\n"
        "|request|{\"rqid\": 1}\n"
        ">battle-gen9pdls4-1\n"
        "|move|p1a: Uxie|Stealth Rock|p2a: Avalugg\n"
    )

    assert replay.protocol_chunks(protocol) == [
        ["|turn|1", "|request|{\"rqid\": 1}"],
        ["|move|p1a: Uxie|Stealth Rock|p2a: Avalugg"],
    ]


def test_recorded_choices_only_reads_the_actor_action_log(tmp_path):
    log = tmp_path / "p1.log"
    log.write_text(
        "INFO     Choice: team 123\n"
        "DEBUG    hidden detail\n"
        "INFO     Choice: stealthrock\n"
    )

    assert replay.recorded_choices(log) == ["team 123", "stealthrock"]


def test_evidence_capture_accepts_only_structured_search_logs():
    handler = replay.EvidenceCapture()
    logger = logging.getLogger("pdl-replay-test")
    handler.emit(logger.makeRecord(
        logger.name, logging.INFO, __file__, 1, "ordinary log line", (), None
    ))
    handler.emit(logger.makeRecord(
        logger.name, logging.INFO, __file__, 1,
        'PDL_ROOT_EVALUATIONS [{"worldIndex": 0}]', (), None,
    ))
    handler.emit(logger.makeRecord(
        logger.name, logging.INFO, __file__, 1,
        'PDL_DECISION_EVIDENCE {"selectedAction": "thunderbolt"}', (), None,
    ))

    assert handler.root_evaluations == [{"worldIndex": 0}]
    assert handler.decision_evidence == {"selectedAction": "thunderbolt"}


FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "pdl_delayed_payoff"


def _ordinal(ordinal: int):
    return replay.ReplayInput(
        trial_directory=FIXTURE_ROOT / "sun",
        actor="p1",
        target_turn=None,
        target_decision_ordinal=ordinal,
        search_ms=1,
        requested_worlds=1,
        seed=0,
    )


def test_decision_ordinal_distinguishes_move_and_forced_switch_on_same_turn():
    move_battle, move_action, move = replay.replay_to_decision(_ordinal(2))
    switch_battle, switch_action, switch = replay.replay_to_decision(_ordinal(3))

    assert move["protocolTurn"] == switch["protocolTurn"] == 2
    assert move["requestType"] == "move"
    assert switch["requestType"] == "forced-switch"
    assert move_action == "knockoff"
    assert switch_action == "switch scovillain"
    assert move_battle.user.active.name == "incineroar"
    assert switch_battle.user.active.name == "incineroar"


def test_preview_ordinal_uses_live_dummy_active_projection():
    battle, action, decision = replay.replay_to_decision(_ordinal(0))

    assert decision["requestType"] == "team-preview"
    assert action == "switch incineroar"
    assert battle.team_preview is True
    assert battle.user.active.name == ""
    assert battle.opponent.active.name == ""
    assert len(battle.user.reserve) == len(battle.opponent.reserve) == 6


def test_ordinal_out_of_range_fails_closed():
    with pytest.raises(ValueError, match="decision ordinal"):
        replay.replay_to_decision(_ordinal(10_000))


def test_recorded_decision_evidence_requires_complete_ordered_triples(tmp_path):
    log = tmp_path / "p1.log"
    log.write_text(
        "INFO     PDL_OBSERVATION schema=pdl.observed-battle.v1 digest=abc\n"
        'INFO     PDL_DECISION_EVIDENCE {"actor":"p1","decisionOrdinal":0,"requestType":"move","activeSpecies":"incineroar","turn":1,"legalSearchActions":["knockoff"],"selected":"knockoff"}\n'
        "INFO     Choice: knockoff\n"
    )

    assert replay.recorded_decision_evidence(log) == [{
        "observationDigest": "abc",
        "evidence": {"actor": "p1", "decisionOrdinal": 0, "requestType": "move", "activeSpecies": "incineroar", "turn": 1, "legalSearchActions": ["knockoff"], "selected": "knockoff"},
        "choice": "knockoff",
    }]

    log.write_text("INFO     Choice: knockoff\n")
    with pytest.raises(replay.ReplayFidelityError, match="not paired"):
        replay.recorded_decision_evidence(log)


def test_decision_replay_bundle_exposes_only_observed_state(monkeypatch):
    source = _ordinal(2)
    battle, action, decision = replay.replay_to_decision(source)
    battle.user.update_from_request_json(battle.request_json)
    observed = replay.ObservedBattleState.capture(battle)

    def evidence(_path):
        record = {
            "observationDigest": observed.digest,
            "evidence": {
                "actor": source.actor,
                "decisionOrdinal": decision["decisionOrdinal"],
                "requestType": decision["requestType"],
                "activeSpecies": decision["activeSpecies"],
                "legalSearchActions": [action],
                "selected": action,
                "turn": decision["protocolTurn"],
            },
            "choice": action,
        }
        return [record, record, record]

    monkeypatch.setattr(replay, "recorded_decision_evidence", evidence)
    bundle = replay.build_decision_replay_bundle(source)

    assert bundle.recorded_action == action
    assert bundle.observation_digest == observed.digest
    payload = bundle.planner_input().payload
    assert payload["opponent"]["fields"]["team_dict"] is None
    assert "request" not in bundle.planner_input().serialized


def test_decision_replay_bundle_rejects_digest_mismatch(monkeypatch):
    source = _ordinal(2)
    battle, action, decision = replay.replay_to_decision(source)

    def evidence(_path):
        record = {
            "observationDigest": "not-the-reconstructed-digest",
            "evidence": {
                "actor": source.actor,
                "decisionOrdinal": decision["decisionOrdinal"],
                "requestType": decision["requestType"],
                "activeSpecies": decision["activeSpecies"],
                "legalSearchActions": [action],
                "selected": action,
                "turn": decision["protocolTurn"],
            },
            "choice": action,
        }
        return [record, record, record]

    monkeypatch.setattr(replay, "recorded_decision_evidence", evidence)
    with pytest.raises(replay.ReplayFidelityError, match="digest mismatch"):
        replay.build_decision_replay_bundle(source)


@pytest.mark.parametrize(("field", "replacement", "message"), [
    ("actor", "p2", "actor"),
    ("decisionOrdinal", 99, "ordinal"),
    ("requestType", "forced-switch", "request type"),
    ("activeSpecies", "wrongactive", "active species"),
])
def test_decision_replay_bundle_rejects_fidelity_metadata_mismatch(monkeypatch, field, replacement, message):
    source = _ordinal(2)
    battle, action, decision = replay.replay_to_decision(source)
    battle.user.update_from_request_json(battle.request_json)
    observed = replay.ObservedBattleState.capture(battle)
    evidence = {
        "actor": source.actor,
        "decisionOrdinal": decision["decisionOrdinal"],
        "requestType": decision["requestType"],
        "activeSpecies": decision["activeSpecies"],
        "turn": decision["protocolTurn"],
        "legalSearchActions": [action],
        "selected": action,
    }
    evidence[field] = replacement
    record = {"observationDigest": observed.digest, "evidence": evidence, "choice": action}
    monkeypatch.setattr(replay, "recorded_decision_evidence", lambda _path: [record, record, record])

    with pytest.raises(replay.ReplayFidelityError, match=message):
        replay.build_decision_replay_bundle(source)


def test_decision_replay_bundle_rejects_selected_or_legal_action_mismatch(monkeypatch):
    source = _ordinal(2)
    battle, action, decision = replay.replay_to_decision(source)
    battle.user.update_from_request_json(battle.request_json)
    observed = replay.ObservedBattleState.capture(battle)
    evidence = {
        "actor": source.actor,
        "decisionOrdinal": decision["decisionOrdinal"],
        "requestType": decision["requestType"],
        "activeSpecies": decision["activeSpecies"],
        "turn": decision["protocolTurn"],
        "legalSearchActions": ["different-action"],
        "selected": action,
    }
    record = {"observationDigest": observed.digest, "evidence": evidence, "choice": action}
    monkeypatch.setattr(replay, "recorded_decision_evidence", lambda _path: [record, record, record])

    with pytest.raises(replay.ReplayFidelityError, match="legal action"):
        replay.build_decision_replay_bundle(source)
