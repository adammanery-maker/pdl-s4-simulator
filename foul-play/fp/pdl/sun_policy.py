"""Narrow, opt-in action constraints for the Adam 03 Sun experiment.

The context accepted here is deliberately a primitive snapshot derived from an
``ObservedBattleState`` reconstruction.  This module never receives a Showdown
request, an authoritative battle object, or an opponent team definition.
"""

from __future__ import annotations

from typing import Any

from fp import constants
from fp.battle.helpers import normalize_name


POLICIES = ("none", "sun-lead-only-v1", "sun-sequence-v1")
SUN_WEATHER = {constants.Weather.SUN, constants.Weather.DESOLATE_LAND}


def _pokemon_snapshot(pokemon) -> dict[str, Any] | None:
    if pokemon is None or not getattr(pokemon, "name", ""):
        return None
    return {
        "species": normalize_name(pokemon.name),
        "alive": bool(pokemon.is_alive()),
    }


def capture_sun_policy_context(battle) -> dict[str, Any]:
    """Capture only public, decision-relevant primitives before preview pop."""

    own = [
        snapshot
        for snapshot in [
            _pokemon_snapshot(battle.user.active),
            *(_pokemon_snapshot(pokemon) for pokemon in battle.user.reserve),
        ]
        if snapshot is not None
    ]
    opponent = [
        snapshot
        for snapshot in [
            _pokemon_snapshot(battle.opponent.active),
            *(_pokemon_snapshot(pokemon) for pokemon in battle.opponent.reserve),
        ]
        if snapshot is not None
    ]
    last_used = getattr(battle.user, "last_used_move", None)
    successful_memento = getattr(battle, "pdl_successful_memento_self_faint", None)
    return {
        "teamPreview": bool(battle.team_preview),
        "forceSwitch": bool(battle.force_switch),
        "turn": int(battle.turn or 0),
        "weather": str(battle.weather) if battle.weather is not None else None,
        "activeSpecies": (
            normalize_name(battle.user.active.name)
            if battle.user.active is not None and battle.user.active.name
            else None
        ),
        "ownPokemon": own,
        "opponentPokemon": opponent,
        "lastUsedMove": {
            "species": (
                normalize_name(last_used.pokemon_name)
                if getattr(last_used, "pokemon_name", None)
                else None
            ),
            "move": (
                normalize_name(last_used.move)
                if getattr(last_used, "move", None)
                else None
            ),
            "turn": int(getattr(last_used, "turn", 0) or 0),
        },
        "successfulMementoSelfFaint": (
            successful_memento is not None
            and normalize_name(successful_memento.pokemon_name) == "whimsicott"
            and normalize_name(successful_memento.move) == "memento"
            and int(successful_memento.turn or 0) == int(battle.turn or 0)
        ),
    }


def _alive(
    context: dict[str, Any], side: str, species: str | None = None
) -> int | bool:
    alive = [pokemon for pokemon in context[side] if pokemon["alive"]]
    if species is None:
        return len(alive)
    return any(pokemon["species"] == species for pokemon in alive)


def _is_memento(action: str) -> bool:
    return action == "memento" or action.startswith("memento-")


def apply_sun_policy(
    policy: str,
    context: dict[str, Any],
    policy_support: dict[str, float],
) -> tuple[dict[str, float], dict[str, Any] | None]:
    """Constrain aggregate root actions and return an auditable evidence block."""

    if policy == "none":
        return dict(policy_support), None
    if policy not in POLICIES:
        raise ValueError(f"Unsupported PDL Sun policy {policy!r}")
    if not policy_support:
        raise ValueError("PDL Sun policy received no mechanically legal root actions")

    original = dict(policy_support)
    eligible = dict(original)
    excluded: list[str] = []
    forced_action = None

    scovillain_alive = bool(_alive(context, "ownPokemon", "scovillain"))
    sun_active = context["weather"] in {str(weather) for weather in SUN_WEATHER}
    own_alive = int(_alive(context, "ownPokemon"))
    opponent_alive = int(_alive(context, "opponentPokemon"))
    late_sun_window = context["turn"] >= 11 or own_alive <= 4 or opponent_alive <= 4
    active_whimsicott = context["activeSpecies"] == "whimsicott"
    successful_memento = context["successfulMementoSelfFaint"]
    whimsicott_fainted = any(
        pokemon["species"] == "whimsicott" and not pokemon["alive"]
        for pokemon in context["ownPokemon"]
    )

    if context["teamPreview"]:
        excluded = [action for action in eligible if action == "switch drednaw"]
        for action in excluded:
            eligible.pop(action)

    if policy == "sun-sequence-v1" and not context["teamPreview"]:
        if active_whimsicott and scovillain_alive and not sun_active:
            memento_actions = [action for action in eligible if _is_memento(action)]
            excluded.extend(memento_actions)
            for action in memento_actions:
                eligible.pop(action)
            if late_sun_window and "sunnyday" in original:
                forced_action = "sunnyday"

        if (
            context["forceSwitch"]
            and active_whimsicott
            and whimsicott_fainted
            and successful_memento
            and sun_active
            and scovillain_alive
        ):
            forced_action = "switch scovillain"

    if forced_action is not None:
        if forced_action not in original:
            raise ValueError(
                f"PDL Sun policy forced {forced_action}, but it is not mechanically legal"
            )
        eligible = {forced_action: original[forced_action]}

    if not eligible:
        raise ValueError("PDL Sun policy removed every mechanically legal action")

    evidence = {
        "policy": policy,
        "predicates": {
            "teamPreview": context["teamPreview"],
            "forceSwitch": context["forceSwitch"],
            "turn": context["turn"],
            "activeSpecies": context["activeSpecies"],
            "scovillainAlive": scovillain_alive,
            "sunActive": sun_active,
            "ownAlive": own_alive,
            "opponentAlive": opponent_alive,
            "lateSunWindow": late_sun_window,
            "whimsicottFainted": whimsicott_fainted,
            "successfulMementoSelfFaintThisTurn": successful_memento,
        },
        "originalMechanicallyLegalSupport": original,
        "eligibleActions": sorted(eligible),
        "excludedActions": sorted(set(excluded)),
        "forcedAction": forced_action,
    }
    return eligible, evidence
