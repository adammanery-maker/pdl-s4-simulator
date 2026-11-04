from pathlib import Path

from fp.battle.state import Battle, Pokemon
from fp.config import FoulPlayConfig
from fp.modes.base import format_decision
from fp.pdl.belief_data import PdlBeliefData
from fp.pdl.tera import apply_pdl_tera_search_restrictions, filter_pdl_tera_decision
from poke_engine import Move as EngineMove, Pokemon as EnginePokemon, Side, State, monte_carlo_tree_search


FIXTURE = Path(__file__).parent / "fixtures" / "pdl-belief-v1.json"


def make_battle(species: str, tera_type: str | None, can_terastallize=True):
    battle = Battle(None)
    battle.user.active = Pokemon(species, 100)
    battle.user.active.tera_type = tera_type
    battle.user.active.can_terastallize = can_terastallize
    return battle


def test_strips_tera_from_a_high_cost_pokemon():
    battle = make_battle("flamigo", "grass")

    assert (
        filter_pdl_tera_decision(battle, "closecombat-tera", PdlBeliefData.load(FIXTURE), "adam")
        == "closecombat"
    )


def test_allows_a_native_type_tera_for_an_eligible_pokemon():
    battle = make_battle("tatsugiri", "dragon")

    assert (
        filter_pdl_tera_decision(battle, "dracometeor-tera", PdlBeliefData.load(FIXTURE), "adam")
        == "dracometeor-tera"
    )


def test_allows_a_drafted_type_tera_for_an_eligible_pokemon():
    battle = make_battle("tatsugiri", "ghost")

    assert (
        filter_pdl_tera_decision(battle, "dracometeor-tera", PdlBeliefData.load(FIXTURE), "adam")
        == "dracometeor-tera"
    )


def test_strips_an_invalid_tera_type_and_preserves_non_tera_actions():
    battle = make_battle("tatsugiri", "electric")
    belief = PdlBeliefData.load(FIXTURE)

    assert filter_pdl_tera_decision(battle, "dracometeor-tera", belief, "adam") == "dracometeor"
    assert filter_pdl_tera_decision(battle, "dracometeor", belief, "adam") == "dracometeor"


def test_final_showdown_decision_boundary_cannot_emit_illegal_pdl_tera(monkeypatch):
    battle = make_battle("flamigo", "grass")
    battle.rqid = 3
    battle.user.active.add_move("closecombat")
    monkeypatch.setattr(FoulPlayConfig, "pokemon_format", "gen9pdls4")
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief", PdlBeliefData.load(FIXTURE))
    monkeypatch.setattr(FoulPlayConfig, "pdl_team_id", "adam")

    assert format_decision(battle, "closecombat-tera") == ["/choose move closecombat", "3"]


def test_final_showdown_decision_boundary_keeps_legal_pdl_tera(monkeypatch):
    battle = make_battle("tatsugiri", "dragon")
    battle.rqid = 4
    battle.user.active.add_move("dracometeor")
    monkeypatch.setattr(FoulPlayConfig, "pokemon_format", "gen9pdls4")
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief", PdlBeliefData.load(FIXTURE))
    monkeypatch.setattr(FoulPlayConfig, "pdl_team_id", "adam")

    assert format_decision(battle, "dracometeor-tera") == [
        "/choose move dracometeor terastallize",
        "4",
    ]


def test_search_restrictions_keep_only_believed_captains():
    battle = make_battle("tatsugiri", "grass")
    battle.user.reserve = [Pokemon("golem", 100)]
    battle.user.reserve[0].tera_type = "rock"
    battle.opponent.active = Pokemon("ribombee", 100)
    battle.opponent.active.tera_type = "fairy"
    battle.opponent.reserve = [Pokemon("flygon", 100)]
    battle.opponent.reserve[0].tera_type = "ground"

    apply_pdl_tera_search_restrictions(battle, PdlBeliefData.load(FIXTURE), "adam")

    assert battle.user.active.tera_type == "grass"
    assert battle.user.reserve[0].tera_type == "rock"
    assert battle.opponent.active.tera_type == "fairy"
    assert battle.opponent.reserve[0].tera_type is None


def test_search_restrictions_remove_every_future_tera_after_team_spends_it():
    battle = make_battle("tatsugiri", "dragon")
    battle.user.active.terastallized = True
    battle.user.reserve = [Pokemon("golem", 100)]
    battle.user.reserve[0].tera_type = "rock"

    apply_pdl_tera_search_restrictions(battle, PdlBeliefData.load(FIXTURE), "adam")

    assert battle.user.reserve[0].tera_type is None


def test_search_exposes_both_future_captains_before_team_spends_tera():
    battle = make_battle("flamigo", "flying")
    tatsugiri = Pokemon("tatsugiri", 100)
    tatsugiri.tera_type = "dragon"
    golem = Pokemon("golem", 100)
    golem.tera_type = "rock"
    battle.user.reserve = [tatsugiri, golem]

    apply_pdl_tera_search_restrictions(battle, PdlBeliefData.load(FIXTURE), "adam")

    assert battle.user.active.tera_type is None
    assert tatsugiri.tera_type == "dragon"
    assert golem.tera_type == "rock"


def _engine_pokemon(species, tera_type="typeless", terastallized=False):
    return EnginePokemon(
        id=species, hp=100, maxhp=100, tera_type=tera_type, terastallized=terastallized,
        moves=[EngineMove(id="tackle"), EngineMove(id="protect"), EngineMove(id="none", disabled=True), EngineMove(id="none", disabled=True)],
    )


def test_native_mcts_offers_active_captain_tera_but_blocks_second_team_tera():
    opponent = Side(pokemon=[_engine_pokemon("bulbasaur")])
    for active_species, active_type, teammate_species, teammate_type in (
        ("pikachu", "electric", "charizard", "fire"),
        ("charizard", "fire", "pikachu", "electric"),
    ):
        available = State(side_one=Side(pokemon=[
            _engine_pokemon(active_species, active_type),
            _engine_pokemon(teammate_species, teammate_type),
        ]), side_two=opponent)
        available_actions = {
            result.move_choice for result in monte_carlo_tree_search(available, 10, threads=1).side_one
        }
        assert "tackle-tera" in available_actions

        spent = State(side_one=Side(pokemon=[
            _engine_pokemon(active_species, active_type),
            _engine_pokemon(teammate_species, teammate_type, terastallized=True),
        ]), side_two=opponent)
        spent_actions = {
            result.move_choice for result in monte_carlo_tree_search(spent, 10, threads=1).side_one
        }
        assert all(not action.endswith("-tera") for action in spent_actions)
