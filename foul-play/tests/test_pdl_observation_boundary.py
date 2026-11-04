import json
import asyncio

import pytest

from fp import constants
from fp.battle.state import Battle, Pokemon
from fp.pdl.observation import ObservedBattleState


def battle_with_public_state() -> Battle:
    battle = Battle("battle-gen9pdls4-boundary")
    battle.pokemon_format = "gen9pdls4"
    battle.generation = "gen9"
    battle.user.name = "p1"
    battle.opponent.name = "p2"
    battle.user.active = Pokemon("tatsugiri", 100)
    battle.opponent.active = Pokemon("grimmsnarl", 100)
    battle.opponent.active.revealed = True
    battle.request_json = {"side": {"id": "p1"}}
    return battle


def test_identical_observations_ignore_distinct_hidden_ground_truth_markers():
    first = battle_with_public_state()
    second = battle_with_public_state()
    first.opponent.active._ground_truth = {"item": "choicescarf", "marker": "SECRET_A"}
    second.opponent.active._ground_truth = {"item": "lightclay", "marker": "SECRET_B"}
    first.opponent.active.item = "choicescarf"
    first.opponent.active.ability = "prankster"
    first.opponent.active.original_ability = "secretabilitya"
    first.opponent.active.nature = "jolly"
    first.opponent.active.evs = (0, 252, 0, 0, 4, 252)
    first.opponent.active.max_hp = 200
    first.opponent.active.hp = 200
    first.opponent.active.hp_at_switch_in = 200
    first.opponent.active.stats["spe"] = 999
    first.opponent.active.add_move("suckerpunch")
    first.opponent.team_dict = {"SECRET_A": "private team"}
    second.opponent.active.item = "lightclay"
    second.opponent.active.ability = "frisk"
    second.opponent.active.original_ability = "secretabilityb"
    second.opponent.active.nature = "bold"
    second.opponent.active.evs = (252, 0, 252, 0, 4, 0)
    second.opponent.active.max_hp = 50
    second.opponent.active.hp = 50
    second.opponent.active.hp_at_switch_in = 50
    second.opponent.active.stats["spe"] = 1
    second.opponent.active.add_move("reflect")
    second.opponent.team_dict = {"SECRET_B": "private team"}

    a = ObservedBattleState.capture(first)
    b = ObservedBattleState.capture(second)

    assert a.serialized == b.serialized
    assert "SECRET_A" not in a.serialized
    assert "SECRET_B" not in b.serialized
    assert "secretabilitya" not in a.serialized
    assert "secretabilityb" not in b.serialized


def test_post_reveal_public_evidence_changes_observation():
    before = battle_with_public_state()
    after = battle_with_public_state()
    after.opponent.active.item = "lightclay"
    after.opponent.active.publicly_known_item = True

    assert ObservedBattleState.capture(before).serialized != ObservedBattleState.capture(after).serialized


def test_reconstruction_has_no_aliases_and_no_request_payload():
    source = battle_with_public_state()
    observed = ObservedBattleState.capture(source)
    restored = observed.reconstruct(mode=object())
    source.opponent.active.hp = 1
    restored.user.active.item = "leftovers"

    assert restored.opponent.active.hp != 1
    assert source.user.active.item == constants.UNKNOWN_ITEM
    assert restored.request_json is None
    assert json.loads(observed.serialized)["schema"] == "pdl.observed-battle.v1"


def test_opponent_private_request_is_rejected():
    battle = battle_with_public_state()
    battle.request_json = {"side": {"id": "p2"}}

    with pytest.raises(ValueError, match="Rejected request"):
        ObservedBattleState.capture(battle)


def test_team_preview_dummy_pokemon_survives_observation_projection():
    battle = battle_with_public_state()
    battle.team_preview = True
    battle.user.active = Pokemon.get_dummy()
    battle.opponent.active = Pokemon.get_dummy()

    restored = ObservedBattleState.capture(battle).reconstruct(mode=object())

    assert restored.user.active.name == ""
    assert restored.opponent.active.name == ""
    assert restored.opponent.active.hp == 0


def test_actual_search_callback_receives_only_the_serialized_observation(monkeypatch):
    from fp.modes import base

    battle = battle_with_public_state()
    battle.team_preview = True
    battle.opponent.active.item = "choicescarf"
    battle.opponent.active.ability = "prankster"
    battle.opponent.active.nature = "jolly"
    battle.opponent.active.evs = (0, 252, 0, 0, 4, 252)
    battle.opponent.active.stats["spe"] = 999
    battle.opponent.active.add_move("suckerpunch")
    battle.opponent.team_dict = {"SECRET_TEAM": "private"}
    seen = []

    def inspect_search(observed_battle):
        seen.append(observed_battle)
        return "protect"

    monkeypatch.setattr(base, "find_best_move", inspect_search)
    monkeypatch.setattr(base, "format_decision", lambda _battle, choice: [choice])

    assert asyncio.run(base.async_pick_move(battle)) == ["protect"]
    assert len(seen) == 1
    search_opponent = seen[0].opponent.active
    assert search_opponent.item == "unknownitem"
    assert search_opponent.ability is None
    assert search_opponent.evs == (0, 0, 0, 0, 0, 0)
    assert "spe" not in search_opponent.stats
    assert [move.name for move in search_opponent.moves] == []
    assert seen[0].opponent.team_dict is None
    assert seen[0].request_json is None
    assert "SECRET_TEAM" not in ObservedBattleState.capture(battle).serialized
