"""Hard, serialized boundary between Showdown state and PDL search.

The live ``Battle`` object is assembled only from the bot's private request and
public protocol messages.  Search receives a fresh object reconstructed from
this canonical JSON projection, never the live object or its request payload.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import dataclass
from hashlib import sha256
from types import MappingProxyType
from typing import Any

from fp.battle.state import Battle, Battler, LastUsedMove, Move, Pokemon, StatRange


SCHEMA = "pdl.observed-battle.v1"

_BATTLE_FIELDS = (
    "battle_tag", "weather", "weather_turns_remaining", "weather_source",
    "field", "field_turns_remaining", "trick_room", "trick_room_turns_remaining",
    "gravity", "team_preview", "turn", "started", "rqid", "force_switch", "wait",
    "battle_type", "pokemon_format", "generation", "time_remaining", "msg_list",
    "opponent_team_preview_affinities",
)
_OPTIONAL_BATTLE_FIELDS = ("pdl_successful_memento_self_faint",)
_BATTLER_FIELDS = (
    "name", "trapped", "baton_passing", "shed_tailing", "wish", "future_sight",
    "account_name", "team_dict", "last_selected_move", "last_used_move",
)
_POKEMON_FIELDS = (
    "name", "nickname", "base_name", "index", "revealed", "level", "nature", "evs",
    "speed_range", "hidden_power_possibilities", "base_stats", "stats", "max_hp", "hp",
    "substitute_hit", "ability", "types", "item", "removed_item", "unknown_forme",
    "moves_used_since_switch_in", "zoroark_disguised_as", "hp_at_switch_in",
    "status_at_switch_in", "terastallized", "tera_type", "forme_changed",
    "original_ability", "fainted", "reviving", "moves", "status", "volatile_statuses",
    "volatile_status_durations", "boosts", "rest_turns", "sleep_turns", "knocked_off",
    "can_mega_evo", "can_ultra_burst", "can_dynamax", "can_terastallize", "is_mega",
    "mega_name", "can_have_choice_item", "item_inferred", "gen_3_consecutive_sleep_talks",
    "impossible_items", "impossible_abilities",
    "publicly_known_item", "publicly_known_ability", "publicly_known_moves",
)
_MOVE_FIELDS = ("name", "max_pp", "disabled", "can_z", "current_pp")


def _value(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return {"$float": "inf" if value > 0 else "-inf"}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, LastUsedMove):
        return {"$lastMove": [_value(part) for part in value]}
    if isinstance(value, StatRange):
        return {"$statRange": [_value(part) for part in value]}
    if isinstance(value, Move):
        return {"$move": {key: _value(getattr(value, key)) for key in _MOVE_FIELDS}}
    if isinstance(value, Pokemon):
        return {"$pokemon": {key: _value(getattr(value, key)) for key in _POKEMON_FIELDS}}
    if isinstance(value, defaultdict):
        return {"$defaultdict": {str(key): _value(item) for key, item in value.items()}}
    if isinstance(value, dict):
        return {"$dict": [[_value(key), _value(item)] for key, item in value.items()]}
    if isinstance(value, tuple):
        return {"$tuple": [_value(item) for item in value]}
    if isinstance(value, set):
        return {"$set": sorted((_value(item) for item in value), key=repr)}
    if isinstance(value, list):
        return [_value(item) for item in value]
    # Weather, terrain, status, and similar protocol enums are string enums.
    enum_value = getattr(value, "value", None)
    if isinstance(enum_value, (str, int)):
        return enum_value
    raise TypeError(f"Observed battle contains unsupported value {type(value).__name__}")


def _restore(value: Any) -> Any:
    if isinstance(value, list):
        return [_restore(item) for item in value]
    if not isinstance(value, dict):
        return value
    if "$float" in value:
        return float(value["$float"])
    if "$lastMove" in value:
        return LastUsedMove(*(_restore(item) for item in value["$lastMove"]))
    if "$statRange" in value:
        return StatRange(*(_restore(item) for item in value["$statRange"]))
    if "$move" in value:
        fields = value["$move"]
        move = Move(fields["name"])
        for key, item in fields.items():
            setattr(move, key, _restore(item))
        return move
    if "$pokemon" in value:
        fields = value["$pokemon"]
        pokemon = Pokemon(fields["name"], fields["level"]) if fields["name"] else Pokemon.get_dummy()
        for key, item in fields.items():
            setattr(pokemon, key, _restore(item))
        return pokemon
    if "$defaultdict" in value:
        restored = defaultdict(lambda: 0)
        restored.update({key: _restore(item) for key, item in value["$defaultdict"].items()})
        return restored
    if "$dict" in value:
        return {_restore(key): _restore(item) for key, item in value["$dict"]}
    if "$tuple" in value:
        return tuple(_restore(item) for item in value["$tuple"])
    if "$set" in value:
        return {_restore(item) for item in value["$set"]}
    return {key: _restore(item) for key, item in value.items()}


def _opponent_pokemon_value(pokemon: Pokemon | None) -> Any:
    if pokemon is None:
        return None
    fields = {key: getattr(pokemon, key) for key in _POKEMON_FIELDS}
    clean = (
        Pokemon(pokemon.name, pokemon.level, nature="serious", evs=(0, 0, 0, 0, 0, 0))
        if pokemon.name
        else Pokemon.get_dummy()
    )
    hp_fraction = 0 if not pokemon.max_hp else pokemon.hp / pokemon.max_hp
    hp_at_switch_fraction = (
        0 if not pokemon.max_hp else pokemon.hp_at_switch_in / pokemon.max_hp
    )
    fields.update(
        nature="serious",
        evs=(0, 0, 0, 0, 0, 0),
        stats=clean.stats,
        max_hp=clean.max_hp,
        hp=clean.max_hp * hp_fraction,
        hp_at_switch_in=clean.max_hp * hp_at_switch_fraction,
        ability=pokemon.ability if pokemon.publicly_known_ability else None,
        original_ability=(
            pokemon.original_ability if pokemon.publicly_known_ability else None
        ),
        item=pokemon.item if pokemon.publicly_known_item else "unknownitem",
        moves=[move for move in pokemon.moves if move.name in pokemon.publicly_known_moves],
        tera_type=pokemon.tera_type if pokemon.terastallized else None,
    )
    return {"$pokemon": {key: _value(fields[key]) for key in _POKEMON_FIELDS}}


def _battler_payload(side: Battler, *, opponent: bool = False) -> dict[str, Any]:
    battler_fields = {
        key: _value(None if opponent and key == "team_dict" else getattr(side, key))
        for key in _BATTLER_FIELDS
    }
    return {
        "active": _opponent_pokemon_value(side.active) if opponent else _value(side.active),
        "reserve": [_opponent_pokemon_value(pokemon) for pokemon in side.reserve] if opponent else _value(side.reserve),
        "sideConditions": _value(side.side_conditions),
        "fields": battler_fields,
    }


def _restore_battler(payload: dict[str, Any]) -> Battler:
    side = Battler()
    side.active = _restore(payload["active"])
    side.reserve = _restore(payload["reserve"])
    side.side_conditions = _restore(payload["sideConditions"])
    for key, value in payload["fields"].items():
        setattr(side, key, _restore(value))
    return side


@dataclass(frozen=True, slots=True)
class ObservedBattleState:
    """Immutable canonical JSON handed across the decision boundary."""

    serialized: str

    @classmethod
    def capture(cls, battle: Battle) -> "ObservedBattleState":
        request = battle.request_json
        if request is not None:
            request_side = request.get("side", {}).get("id")
            if request_side != battle.user.name:
                raise ValueError(
                    f"Rejected request for {request_side!r}; agent controls {battle.user.name!r}"
                )

        battle_payload = {
            key: _value(getattr(battle, key)) for key in _BATTLE_FIELDS
        }
        battle_payload.update(
            {
                key: _value(getattr(battle, key))
                for key in _OPTIONAL_BATTLE_FIELDS
                if hasattr(battle, key)
            }
        )
        payload = {
            "schema": SCHEMA,
            "battle": battle_payload,
            "user": _battler_payload(battle.user),
            "opponent": _battler_payload(battle.opponent, opponent=True),
        }
        return cls(json.dumps(payload, sort_keys=True, separators=(",", ":")))

    @property
    def digest(self) -> str:
        return sha256(self.serialized.encode()).hexdigest()

    @property
    def payload(self):
        """Read-only parsed payload for logs and tests."""
        return MappingProxyType(json.loads(self.serialized))

    def reconstruct(self, mode) -> Battle:
        payload = json.loads(self.serialized)
        if payload.get("schema") != SCHEMA:
            raise ValueError("Unsupported observed battle schema")
        battle = Battle(_restore(payload["battle"]["battle_tag"]))
        for key, value in payload["battle"].items():
            setattr(battle, key, _restore(value))
        battle.user = _restore_battler(payload["user"])
        battle.opponent = _restore_battler(payload["opponent"])
        battle.request_json = None
        battle.mode = mode
        return battle
