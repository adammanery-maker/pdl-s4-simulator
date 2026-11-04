import io
import json
import logging
from types import SimpleNamespace

import pytest

from fp import constants
from fp.battle.state import Battle, LastUsedMove, Pokemon
from fp.battle.protocol import faint, fail, immune, move
from fp.config import BotModes, FoulPlayConfig
from fp.modes.standard_battle import StandardBattleMode
from fp.pdl.observation import ObservedBattleState
from fp.pdl.sun_policy import apply_sun_policy, capture_sun_policy_context
from fp.runtime_contract import runtime_contract
from fp.search.main import select_move_from_mcts_results


def _pokemon(name, *, alive=True):
    pokemon = Pokemon(name, 100)
    if not alive:
        pokemon.hp = 0
        pokemon.fainted = True
    return pokemon


def _battle(*, active="whimsicott", turn=5, sun=False, team_preview=False):
    battle = Battle("battle-gen9pdls4-sun-policy")
    battle.pokemon_format = "gen9pdls4"
    battle.generation = "gen9"
    battle.turn = turn
    battle.team_preview = team_preview
    battle.user.name = "p1"
    battle.opponent.name = "p2"
    battle.user.active = Pokemon.get_dummy() if team_preview else _pokemon(active)
    battle.user.reserve = [
        _pokemon("scovillain"),
        _pokemon("drednaw"),
        _pokemon("tatsugiri"),
        _pokemon("uxie"),
        _pokemon("incineroar"),
    ]
    battle.opponent.active = (
        Pokemon.get_dummy() if team_preview else _pokemon("grimmsnarl")
    )
    battle.opponent.reserve = [_pokemon("delphox") for _ in range(5)]
    battle.weather = constants.Weather.SUN if sun else None
    battle.request_json = {"side": {"id": "p1"}}
    battle.mode = StandardBattleMode()
    return battle


def _mcts_result(support):
    total = sum(support.values())
    return SimpleNamespace(
        total_visits=total,
        side_one=[
            SimpleNamespace(move_choice=action, visits=visits, total_score=visits / 2)
            for action, visits in support.items()
        ],
    )


@pytest.mark.parametrize(
    "previous",
    [LastUsedMove(None, "switch", 0), LastUsedMove("whimsicott", None, 1), None],
)
def test_first_normal_context_accepts_partial_or_absent_previous_action(previous):
    battle = _battle(turn=1)
    battle.user.last_used_move = previous

    observed = ObservedBattleState.capture(battle)
    context = capture_sun_policy_context(observed.reconstruct(StandardBattleMode()))

    assert context["lastUsedMove"] == {
        "species": previous.pokemon_name if previous else None,
        "move": previous.move if previous else None,
        "turn": previous.turn if previous else 0,
    }
    assert context["successfulMementoSelfFaint"] is False
    support = {"memento": 0.6, "moonblast": 0.4}
    s1, s1_evidence = apply_sun_policy("sun-lead-only-v1", context, support)
    assert s1 == support
    assert s1_evidence["forcedAction"] is None
    s2, s2_evidence = apply_sun_policy("sun-sequence-v1", context, support)
    assert s2 == {"moonblast": 0.4}
    assert s2_evidence["forcedAction"] is None


def test_missing_previous_action_attribute_is_neutral():
    battle = _battle(turn=1)
    del battle.user.last_used_move

    context = capture_sun_policy_context(battle)

    assert context["lastUsedMove"] == {"species": None, "move": None, "turn": 0}
    assert context["successfulMementoSelfFaint"] is False


def test_populated_previous_action_still_normalizes_identity():
    battle = _battle()
    battle.user.last_used_move = LastUsedMove("Whimsicott", "Memento", 5)
    battle.pdl_successful_memento_self_faint = LastUsedMove("Whimsicott", "Memento", 5)
    battle.user.active.hp = 0
    battle.force_switch = True

    context = capture_sun_policy_context(battle)

    assert context["lastUsedMove"] == {"species": "whimsicott", "move": "memento", "turn": 5}
    assert context["successfulMementoSelfFaint"] is True
    eligible, evidence = apply_sun_policy(
        "sun-sequence-v1", {**context, "weather": str(constants.Weather.SUN)},
        {"switch scovillain": 0.1, "switch uxie": 0.9},
    )
    assert eligible == {"switch scovillain": 0.1}
    assert evidence["forcedAction"] == "switch scovillain"


@pytest.mark.parametrize(
    "previous",
    [LastUsedMove(None, "memento", 5), LastUsedMove("whimsicott", None, 5), None],
)
def test_missing_previous_action_does_not_infer_memento_replacement(previous):
    battle = _battle(sun=True)
    battle.user.active.hp = 0
    battle.force_switch = True
    battle.user.last_used_move = previous

    context = capture_sun_policy_context(battle)
    support = {"switch scovillain": 0.1, "switch uxie": 0.9}
    eligible, evidence = apply_sun_policy("sun-sequence-v1", context, support)

    assert context["successfulMementoSelfFaint"] is False
    assert eligible == support
    assert evidence["forcedAction"] is None


@pytest.mark.parametrize("policy", ["sun-lead-only-v1", "sun-sequence-v1"])
def test_preview_exclusion_with_missing_previous_actor(policy):
    battle = _battle(team_preview=True)
    battle.user.last_used_move = LastUsedMove(None, None, 0)

    context = capture_sun_policy_context(battle)
    eligible, evidence = apply_sun_policy(
        policy, context, {"switch drednaw": 0.7, "switch uxie": 0.3},
    )

    assert eligible == {"switch uxie": 0.3}
    assert evidence["excludedActions"] == ["switch drednaw"]


def test_lead_only_excludes_drednaw_at_actual_aggregate_selector(monkeypatch):
    monkeypatch.setattr(FoulPlayConfig, "action_policy", "argmax")
    context = capture_sun_policy_context(_battle(team_preview=True))
    result = _mcts_result({"switch drednaw": 70, "switch scovillain": 30})

    assert (
        select_move_from_mcts_results(
            [(result, 1.0, 0)],
            pdl_s4=True,
            sun_policy="sun-lead-only-v1",
            sun_policy_context=context,
        )
        == "switch scovillain"
    )


def test_lead_only_does_not_change_non_preview_decisions():
    context = capture_sun_policy_context(_battle(team_preview=False))
    support = {"memento": 0.7, "moonblast": 0.3}

    eligible, evidence = apply_sun_policy("sun-lead-only-v1", context, support)

    assert eligible == support
    assert evidence["excludedActions"] == []


def test_sequence_forces_plain_sunny_day_in_late_window(monkeypatch):
    monkeypatch.setattr(FoulPlayConfig, "action_policy", "argmax")
    context = capture_sun_policy_context(_battle(turn=11))
    result = _mcts_result({"memento": 75, "sunnyday": 5, "moonblast": 20})

    assert (
        select_move_from_mcts_results(
            [(result, 1.0, 0)],
            pdl_s4=True,
            sun_policy="sun-sequence-v1",
            sun_policy_context=context,
        )
        == "sunnyday"
    )


def test_sequence_constraints_run_before_the_existing_tera_gate(monkeypatch):
    monkeypatch.setattr(FoulPlayConfig, "action_policy", "argmax")
    monkeypatch.setattr(FoulPlayConfig, "tera_gate_minimum_support_margin", 0.05)
    context = capture_sun_policy_context(_battle(turn=5))
    result = _mcts_result({"memento": 39, "flamethrower-tera": 31, "moonblast": 30})

    assert (
        select_move_from_mcts_results(
            [(result, 1.0, 0)],
            pdl_s4=True,
            sun_policy="sun-sequence-v1",
            sun_policy_context=context,
        )
        == "moonblast"
    )


def test_enabled_selector_emits_complete_policy_evidence(monkeypatch):
    monkeypatch.setattr(FoulPlayConfig, "action_policy", "argmax")
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    logger = logging.getLogger("fp.search.main")
    logger.addHandler(handler)
    previous_level = logger.level
    previous_disable = logging.root.manager.disable
    logging.disable(logging.NOTSET)
    logger.setLevel(logging.INFO)
    context = capture_sun_policy_context(_battle(turn=11))
    result = _mcts_result({"memento": 75, "sunnyday": 5, "moonblast": 20})
    try:
        select_move_from_mcts_results(
            [(result, 1.0, 0)],
            pdl_s4=True,
            decision_context={"strategyPolicy": "sun-sequence-v1"},
            sun_policy="sun-sequence-v1",
            sun_policy_context=context,
        )
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous_level)
        logging.disable(previous_disable)

    raw = next(
        line.split("PDL_DECISION_EVIDENCE ", 1)[1]
        for line in stream.getvalue().splitlines()
        if "PDL_DECISION_EVIDENCE " in line
    )
    evidence = json.loads(raw)
    policy = evidence["sunPolicy"]
    assert policy["originalMechanicallyLegalSupport"] == {
        "memento": 0.75,
        "moonblast": 0.2,
        "sunnyday": 0.05,
    }
    assert policy["eligibleActions"] == ["sunnyday"]
    assert policy["forcedAction"] == "sunnyday"
    assert policy["selectedBeforePolicy"] == "memento"
    assert policy["selectedAfterPolicy"] == "sunnyday"
    assert policy["selectedAfterTeraGate"] == "sunnyday"


def test_sequence_excludes_all_memento_variants_before_sun():
    context = capture_sun_policy_context(_battle(turn=5))
    eligible, evidence = apply_sun_policy(
        "sun-sequence-v1",
        context,
        {"memento": 0.5, "memento-tera": 0.3, "moonblast": 0.2},
    )

    assert eligible == {"moonblast": 0.2}
    assert evidence["excludedActions"] == ["memento", "memento-tera"]
    assert evidence["forcedAction"] is None


def test_sequence_leaves_memento_ordinary_while_sun_is_active():
    context = capture_sun_policy_context(_battle(turn=11, sun=True))
    support = {"memento": 0.7, "moonblast": 0.3}

    eligible, evidence = apply_sun_policy("sun-sequence-v1", context, support)

    assert eligible == support
    assert evidence["excludedActions"] == []
    assert evidence["forcedAction"] is None


def test_forced_replacement_requires_publicly_used_memento_not_selected_move():
    battle = _battle(sun=True)
    battle.force_switch = True
    battle.user.active.hp = 0
    battle.user.active.fainted = True
    battle.user.last_selected_move = LastUsedMove("whimsicott", "memento", 5)
    context = capture_sun_policy_context(battle)

    eligible, evidence = apply_sun_policy(
        "sun-sequence-v1", context, {"switch scovillain": 0.1, "switch uxie": 0.9}
    )

    assert eligible == {"switch scovillain": 0.1, "switch uxie": 0.9}
    assert evidence["forcedAction"] is None


def test_successful_memento_self_faint_marker_survives_later_opponent_action(
    monkeypatch,
):
    monkeypatch.setattr(FoulPlayConfig, "pdl_sun_policy", "sun-sequence-v1")
    battle = _battle(sun=True)
    move(
        battle,
        ["", "move", "p1a: Whimsicott", "Memento", "p2a: Grimmsnarl"],
    )
    faint(battle, ["", "faint", "p1a: Whimsicott"])
    move(
        battle,
        ["", "move", "p2a: Grimmsnarl", "Spirit Break", "p1a: Whimsicott"],
    )
    battle.force_switch = True
    context = capture_sun_policy_context(battle)
    assert context["successfulMementoSelfFaint"] is True

    eligible, evidence = apply_sun_policy(
        "sun-sequence-v1", context, {"switch scovillain": 0.1, "switch uxie": 0.9}
    )

    assert eligible == {"switch scovillain": 0.1}
    assert evidence["forcedAction"] == "switch scovillain"


def test_successful_memento_marker_survives_explicit_observation_projection(
    monkeypatch,
):
    monkeypatch.setattr(FoulPlayConfig, "pdl_sun_policy", "sun-sequence-v1")
    battle = _battle(sun=True)
    move(
        battle,
        ["", "move", "p1a: Whimsicott", "Memento", "p2a: Grimmsnarl"],
    )
    faint(battle, ["", "faint", "p1a: Whimsicott"])

    observed = ObservedBattleState.capture(battle)
    restored = observed.reconstruct(StandardBattleMode())

    assert restored.pdl_successful_memento_self_faint == LastUsedMove(
        "whimsicott", "memento", 5
    )
    assert capture_sun_policy_context(restored)["successfulMementoSelfFaint"] is True


def test_failed_memento_then_opponent_ko_does_not_force_scovillain(monkeypatch):
    monkeypatch.setattr(FoulPlayConfig, "pdl_sun_policy", "sun-sequence-v1")
    battle = _battle(sun=True)
    move(
        battle,
        ["", "move", "p1a: Whimsicott", "Memento", "p2a: Grimmsnarl"],
    )
    fail(battle, ["", "-fail", "p2a: Grimmsnarl", "unboost"])
    move(
        battle,
        ["", "move", "p2a: Grimmsnarl", "Spirit Break", "p1a: Whimsicott"],
    )
    faint(battle, ["", "faint", "p1a: Whimsicott"])
    battle.force_switch = True
    context = capture_sun_policy_context(battle)
    assert context["successfulMementoSelfFaint"] is False

    eligible, evidence = apply_sun_policy(
        "sun-sequence-v1", context, {"switch scovillain": 0.1, "switch uxie": 0.9}
    )

    assert eligible == {"switch scovillain": 0.1, "switch uxie": 0.9}
    assert evidence["forcedAction"] is None


@pytest.mark.parametrize("blocked_event", ["protected", "immune"])
def test_blocked_memento_then_opponent_ko_does_not_mark_self_faint(
    monkeypatch, blocked_event
):
    monkeypatch.setattr(FoulPlayConfig, "pdl_sun_policy", "sun-sequence-v1")
    battle = _battle(sun=True)
    move_message = [
        "",
        "move",
        "p1a: Whimsicott",
        "Memento",
        "p2a: Grimmsnarl",
    ]
    if blocked_event == "protected":
        move_message.append("[still]")
    move(battle, move_message)
    if blocked_event == "immune":
        immune(battle, ["", "-immune", "p2a: Grimmsnarl"])
    move(
        battle,
        ["", "move", "p2a: Grimmsnarl", "Spirit Break", "p1a: Whimsicott"],
    )
    faint(battle, ["", "faint", "p1a: Whimsicott"])
    battle.force_switch = True

    context = capture_sun_policy_context(battle)
    eligible, evidence = apply_sun_policy(
        "sun-sequence-v1", context, {"switch scovillain": 0.1, "switch uxie": 0.9}
    )

    assert context["successfulMementoSelfFaint"] is False
    assert eligible == {"switch scovillain": 0.1, "switch uxie": 0.9}
    assert evidence["forcedAction"] is None


def test_stale_observed_memento_does_not_force_a_later_replacement():
    battle = _battle(turn=9, sun=True)
    battle.force_switch = True
    battle.user.active.hp = 0
    battle.user.active.fainted = True
    battle.user.last_used_move = LastUsedMove("whimsicott", "memento", 8)
    context = capture_sun_policy_context(battle)

    eligible, evidence = apply_sun_policy(
        "sun-sequence-v1", context, {"switch scovillain": 0.1, "switch uxie": 0.9}
    )

    assert eligible == {"switch scovillain": 0.1, "switch uxie": 0.9}
    assert evidence["forcedAction"] is None


def test_success_marker_does_not_force_when_a_different_active_pokemon_fainted():
    battle = _battle(active="uxie", sun=True)
    battle.user.active.hp = 0
    battle.user.active.fainted = True
    battle.user.reserve.append(_pokemon("whimsicott", alive=False))
    battle.force_switch = True
    battle.pdl_successful_memento_self_faint = LastUsedMove("whimsicott", "memento", 5)
    context = capture_sun_policy_context(battle)

    eligible, evidence = apply_sun_policy(
        "sun-sequence-v1", context, {"switch scovillain": 0.1, "switch uxie": 0.9}
    )

    assert eligible == {"switch scovillain": 0.1, "switch uxie": 0.9}
    assert evidence["forcedAction"] is None


def test_sequence_never_forces_growth_or_an_attack():
    context = capture_sun_policy_context(
        _battle(active="scovillain", turn=20, sun=True)
    )
    support = {"growth": 0.6, "flamethrower": 0.4}

    eligible, evidence = apply_sun_policy("sun-sequence-v1", context, support)

    assert eligible == support
    assert evidence["forcedAction"] is None


def test_exclusions_that_leave_no_legal_action_fail_closed():
    context = capture_sun_policy_context(_battle(turn=5))

    with pytest.raises(ValueError, match="removed every mechanically legal action"):
        apply_sun_policy("sun-sequence-v1", context, {"memento": 1.0})


def test_context_comes_only_from_identical_serialized_observations():
    first = _battle()
    second = _battle()
    first.opponent.active._ground_truth = "SECRET_A"
    second.opponent.active._ground_truth = "SECRET_B"
    first_observed = ObservedBattleState.capture(first)
    second_observed = ObservedBattleState.capture(second)

    assert first_observed.serialized == second_observed.serialized
    assert capture_sun_policy_context(
        first_observed.reconstruct(object())
    ) == capture_sun_policy_context(second_observed.reconstruct(object()))


def test_default_observation_omits_sun_policy_marker(monkeypatch):
    monkeypatch.setattr(FoulPlayConfig, "pdl_sun_policy", "none")

    serialized = ObservedBattleState.capture(_battle()).serialized

    assert "pdl_successful_memento_self_faint" not in serialized


def test_default_protocol_path_does_not_create_sun_policy_state(monkeypatch):
    monkeypatch.setattr(FoulPlayConfig, "pdl_sun_policy", "none")
    battle = _battle(sun=True)

    move(
        battle,
        ["", "move", "p1a: Whimsicott", "Memento", "p2a: Grimmsnarl"],
    )
    faint(battle, ["", "faint", "p1a: Whimsicott"])

    assert not hasattr(battle, "_pdl_pending_memento")
    assert not hasattr(battle, "pdl_successful_memento_self_faint")
    assert (
        "pdl_successful_memento_self_faint"
        not in ObservedBattleState.capture(battle).serialized
    )


def test_runtime_contract_records_policy_only_when_enabled():
    base = SimpleNamespace(
        offline_runtime=True,
        search_engine="mcts",
        action_policy="argmax",
        evaluation_fixed_iterations=120000,
        pdl_sun_policy="none",
        pdl_candidate_id=None,
    )
    enabled = SimpleNamespace(**vars(base))
    enabled.pdl_sun_policy = "sun-sequence-v1"
    enabled.pdl_candidate_id = "adam-03-sun-drednaw"

    assert "sunPolicy" not in runtime_contract(base)["resolvedConfiguration"]
    resolved = runtime_contract(enabled)["resolvedConfiguration"]
    assert resolved["sunPolicy"] == "sun-sequence-v1"
    assert resolved["candidateId"] == "adam-03-sun-drednaw"


def test_default_selector_is_unchanged_by_explicit_none_policy(monkeypatch):
    monkeypatch.setattr(FoulPlayConfig, "action_policy", "argmax")
    result = _mcts_result({"memento": 60, "sunnyday": 40})

    assert select_move_from_mcts_results(
        [(result, 1.0, 0)]
    ) == select_move_from_mcts_results(
        [(result, 1.0, 0)], sun_policy="none", sun_policy_context=None
    )


@pytest.mark.parametrize(
    ("pokemon_format", "team_id", "candidate_id"),
    [
        ("gen9ou", "adam", "adam-03-sun-drednaw"),
        ("gen9pdls4", "steve", "adam-03-sun-drednaw"),
        ("gen9pdls4", "adam", "adam-02-drednaw-memento"),
    ],
)
def test_enabled_policy_rejects_wrong_scope(
    monkeypatch, pokemon_format, team_id, candidate_id
):
    monkeypatch.setattr(FoulPlayConfig, "pokemon_format", pokemon_format)
    monkeypatch.setattr(FoulPlayConfig, "pdl_team_id", team_id)
    monkeypatch.setattr(FoulPlayConfig, "pdl_candidate_id", candidate_id, raising=False)
    monkeypatch.setattr(
        FoulPlayConfig, "pdl_sun_policy", "sun-sequence-v1", raising=False
    )
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief_data", "belief.json")
    monkeypatch.setattr(FoulPlayConfig, "offline_runtime", False)
    monkeypatch.setattr(
        FoulPlayConfig, "bot_mode", BotModes.accept_challenge, raising=False
    )

    with pytest.raises(ValueError, match="adam-03-sun-drednaw"):
        FoulPlayConfig.validate_config()
