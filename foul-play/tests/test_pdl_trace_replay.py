import json
from copy import deepcopy
from pathlib import Path

from fp.battle.protocol import process_battle_updates, update_battle
from fp.battle.state import Battle, Pokemon
from fp.search.poke_engine_helpers import battle_to_poke_engine_state


FIXTURE = Path(__file__).parent / "fixtures" / "pdl-trace-replay.protocol"


class ReplayMode:
    def add_revealed_pokemon(self, _battle, _pokemon):
        pass


def snapshot(battle):
    state = battle_to_poke_engine_state(battle)
    user = state.side_one.pokemon[0]
    opponent = state.side_two.pokemon[0]
    return {
        "user": {
            "id": user.id, "hp": user.hp, "maxhp": user.maxhp,
            "types": sorted(user.types), "teraType": user.tera_type,
            "terastallized": user.terastallized, "status": user.status,
            "spaBoost": state.side_one.special_attack_boost,
            "accuracyBoost": state.side_one.accuracy_boost,
            "evasionBoost": state.side_one.evasion_boost,
        },
        "opponent": {
            "id": opponent.id, "hp": opponent.hp, "maxhp": opponent.maxhp,
            "types": sorted(opponent.types), "teraType": opponent.tera_type,
            "terastallized": opponent.terastallized, "status": opponent.status,
            "stealthRock": state.side_two.side_conditions.stealth_rock,
        },
        "weather": state.weather,
        "terrain": state.terrain,
        "trickRoom": state.trick_room,
        "forceSwitch": state.side_one.force_switch,
        "teamPreview": state.team_preview,
    }


def test_recorded_protocol_replays_to_expected_serializable_state_turn_by_turn():
    battle = Battle("battle-gen9pdls4-trace")
    battle.generation = "gen9"
    battle.pokemon_format = "gen9pdls4"
    battle.user.name = "p1"
    battle.opponent.name = "p2"
    battle.mode = ReplayMode()
    snapshots = {}

    for line in FIXTURE.read_text().splitlines():
        if line.startswith("|teampreview|"):
            preview = deepcopy(battle)
            preview.user.active = Pokemon("tatsugiri", 100)
            preview.opponent.active = Pokemon("weezing", 100)
            preview.team_preview = True
            snapshots["preview"] = {"teamPreview": battle_to_poke_engine_state(preview).team_preview}
            continue
        if line.startswith("|request|"):
            update_battle(battle, line)
            snapshots["forced"] = snapshot(battle)
            continue
        battle.msg_list.append(line)
        process_battle_updates(battle)
        if line == "|turn|1":
            snapshots["turn1"] = snapshot(battle)
        elif line == "|turn|2":
            snapshots["turn2"] = snapshot(battle)

    assert snapshots["preview"] == {"teamPreview": True}
    assert snapshots["turn1"] == {
        "user": {"id": "tatsugiri", "hp": 301, "maxhp": 301, "types": ["dragon", "water"], "teraType": "typeless", "terastallized": False, "status": "None", "spaBoost": 0, "accuracyBoost": 0, "evasionBoost": 0},
        "opponent": {"id": "weezing", "hp": 292, "maxhp": 292, "types": ["poison", "typeless"], "teraType": "typeless", "terastallized": False, "status": "None", "stealthRock": 0},
        "weather": "none", "terrain": "none", "trickRoom": False, "forceSwitch": False, "teamPreview": False,
    }
    assert snapshots["turn2"] == {
        "user": {"id": "tatsugiri", "hp": 200, "maxhp": 301, "types": ["dragon", "water"], "teraType": "dragon", "terastallized": True, "status": "None", "spaBoost": 2, "accuracyBoost": 1, "evasionBoost": 1},
        "opponent": {"id": "weezing", "hp": 292, "maxhp": 292, "types": ["poison", "typeless"], "teraType": "typeless", "terastallized": False, "status": "Burn", "stealthRock": 1},
        "weather": "rain", "terrain": "electricterrain", "trickRoom": True, "forceSwitch": False, "teamPreview": False,
    }
    assert snapshots["forced"]["forceSwitch"] is True
    assert json.loads(FIXTURE.read_text().split("|request|", 1)[1])["rqid"] == 9
