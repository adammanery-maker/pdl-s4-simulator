from fp.battle.helpers import normalize_name
from fp.pdl.belief_data import PdlBeliefData


def _all_pokemon(side):
    return [side.active, *side.reserve] if side.active is not None else list(side.reserve)


def _restrict_side(side, belief: PdlBeliefData, team_id: str) -> None:
    pokemon = _all_pokemon(side)
    spent = any(candidate.terastallized for candidate in pokemon)
    for candidate in pokemon:
        if candidate.terastallized:
            continue
        species = normalize_name(candidate.name)
        if spent or not belief.is_tera_captain(team_id, species):
            candidate.tera_type = None
            if getattr(candidate, "can_terastallize", False):
                candidate.can_terastallize = False
            continue
        
        if not belief.tera_is_allowed(team_id, species, candidate.tera_type):
            candidate.tera_type = None
            if getattr(candidate, "can_terastallize", False):
                candidate.can_terastallize = False


def apply_pdl_tera_search_restrictions(battle, belief: PdlBeliefData, team_id: str) -> None:
    """Expose both legal captains while retaining native team-wide Tera spending."""
    normalized_team_id = normalize_name(team_id)
    _restrict_side(battle.user, belief, normalized_team_id)
    opponent_team_id = next(
        (belief.owner_for(candidate.name) for candidate in _all_pokemon(battle.opponent) if belief.owner_for(candidate.name) != normalized_team_id),
        None,
    )
    if opponent_team_id:
        _restrict_side(battle.opponent, belief, opponent_team_id)


def filter_pdl_tera_decision(battle, decision: str, belief: PdlBeliefData, team_id: str) -> str:
    """Return a legal PDL action by dropping an invalid Tera suffix.

    The underlying move remains the agent's selected legal move. This is a
    safety boundary: it never invents an alternative move or a Tera type.
    """
    if not decision.endswith("-tera"):
        return decision
    active = battle.user.active
    if not getattr(active, "can_terastallize", False):
        return decision.removesuffix("-tera")
    if not belief.tera_is_allowed(team_id, normalize_name(active.name), active.tera_type):
        return decision.removesuffix("-tera")
    return decision
