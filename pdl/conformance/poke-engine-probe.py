#!/usr/bin/env python3
"""Local, structured probe of the exact poke-engine binding Foul Play uses.

This process receives an explicitly supplied fixture state.  It does not read a
Showdown battle, trial manifest, audit artifact, environment credential, or
network resource.  The parent deliberately retains the submitted fixture sets;
only calculated mechanics facts are returned.
"""

import json
import sys

from fp import constants
from fp.battle.state import Battle, Pokemon
from fp.config import FoulPlayConfig
from fp.search.poke_engine_helpers import poke_engine_get_damage_rolls


def normalized(value):
    return "".join(ch for ch in value.lower() if ch.isalnum())


def build_pokemon(spec):
    evs = spec.get("evs", {})
    spread = tuple(int(evs.get(stat, 0)) for stat in ("hp", "atk", "def", "spa", "spd", "spe"))
    pokemon = Pokemon(spec["species"], int(spec.get("level", 100)), spec.get("nature", "serious").lower(), spread)
    pokemon.ability = normalized(spec.get("ability", ""))
    pokemon.original_ability = pokemon.ability
    pokemon.item = normalized(spec.get("item", "")) or "None"
    pokemon.tera_type = normalized(spec.get("teraType", "")) or None
    pokemon.terastallized = bool(spec.get("terastallized", False))
    for move in spec.get("moves", []):
        pokemon.add_move(move)
    for stat, stage in spec.get("boosts", {}).items():
        pokemon.boosts[stat] = int(stage)
    return pokemon


def main():
    fixture = json.load(sys.stdin)
    # Pokemon construction uses Foul Play's configured generation to calculate
    # stats.  The conformance fixture is a Gen 9 singles state.
    FoulPlayConfig.pokemon_format = "gen9randombattle"
    battle = Battle(None)
    battle.generation = "gen9"
    battle.user.active = build_pokemon(fixture["p1"])
    battle.opponent.active = build_pokemon(fixture["p2"])
    if fixture.get("p1Status") == "burn":
        battle.user.active.status = constants.Status.BURN
    if fixture.get("p2LightScreen"):
        battle.opponent.side_conditions[constants.LIGHT_SCREEN] = 5

    weather = fixture.get("weather")
    if weather:
        battle.weather = getattr(constants.Weather, weather.upper())
        battle.weather_turns_remaining = 5
    if fixture.get("trickRoom"):
        battle.trick_room = True
        battle.trick_room_turns_remaining = 5

    try:
        p1_rolls, p2_rolls = poke_engine_get_damage_rolls(
            battle,
            normalized(fixture["p1Move"]),
            normalized(fixture.get("p2Move", "splash")),
            bool(fixture.get("p1MovesFirst", True)),
        )
        # The current native binding returns the maximum normal and maximum
        # critical damage, not Showdown's sixteen discrete Gen 9 RNG outcomes.
        json.dump({"supported": True, "damageRollRepresentation": "max-normal-and-crit", "p1DamageRolls": sorted(set(p1_rolls)), "p2DamageRolls": sorted(set(p2_rolls))}, sys.stdout)
    except Exception as error:  # A conformance report must capture unsupported states, not abort.
        json.dump({"supported": False, "error": f"{type(error).__name__}: {error}"}, sys.stdout)


if __name__ == "__main__":
    main()
