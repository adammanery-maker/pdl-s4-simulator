import logging
from pathlib import Path

import pytest

from fp.config import FoulPlayConfig
from fp.battle.state import Battle, Pokemon
from fp.constants import BattleType
from fp.modes import battle_mode
from fp.pdl.belief_data import PdlBeliefData
from fp.pdl.team_datasets import PdlBeliefSmogonSets, PdlTeamDatasets
from fp.modes.standard_battle import StandardBattleMode
from fp.search import standard_battles
from fp.search.standard_battles import prepare_battles


FIXTURE = Path(__file__).parent / "fixtures" / "pdl-belief-v1.json"


@pytest.fixture
def configured_pdl_mode(monkeypatch):
    monkeypatch.setattr(FoulPlayConfig, "pokemon_format", "gen9pdls4")
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief_data", str(FIXTURE))
    monkeypatch.setattr(FoulPlayConfig, "pdl_team_id", "adam")
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief", PdlBeliefData.load(FIXTURE))
    return StandardBattleMode()


def test_pdl_mode_uses_only_local_pdl_dataset_sources(configured_pdl_mode):
    assert isinstance(configured_pdl_mode.team_datasets, PdlTeamDatasets)
    assert isinstance(configured_pdl_mode.smogon_sets, PdlBeliefSmogonSets)


def test_posterior_shadow_trace_uses_public_state_and_skips_removed_item(
    monkeypatch, caplog
):
    caplog.set_level(logging.INFO)
    monkeypatch.setattr(FoulPlayConfig, "pokemon_format", "gen9pdls4")
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief_data", str(FIXTURE))
    monkeypatch.setattr(FoulPlayConfig, "pdl_team_id", "adam")
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief", PdlBeliefData.load(FIXTURE))
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief_engine", "posterior-shadow")
    mode = StandardBattleMode()
    battle = Battle(None)
    battle.mode = mode
    battle.turn = 4
    battle.opponent.active = Pokemon("tatsugiri", 100)
    battle.opponent.active.publicly_known_item = True
    battle.opponent.active.item = None  # Knock Off after an earlier public reveal.
    battle.opponent.active.publicly_known_moves.add("dracometeor")

    mode.observe_posterior(battle)

    assert all(
        evidence.observation != "item:none"
        for evidence in mode.posterior.evidence_for("tatsugiri")
    )
    assert "PDL_BELIEF_TRACE {" in caplog.text


def test_posterior_mode_refreshes_existing_sampling_weights_from_public_evidence(
    monkeypatch
):
    monkeypatch.setattr(FoulPlayConfig, "pokemon_format", "gen9pdls4")
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief_data", str(FIXTURE))
    monkeypatch.setattr(FoulPlayConfig, "pdl_team_id", "adam")
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief", PdlBeliefData.load(FIXTURE))
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief_engine", "posterior")
    mode = StandardBattleMode()
    mode.initialize_team_preview_datasets("gen9pdls4", {"tatsugiri"}, "")
    refreshed = []
    monkeypatch.setattr(
        mode.team_datasets,
        "apply_posterior_weights",
        lambda species, weights: refreshed.append(("full", species, weights)),
    )
    monkeypatch.setattr(
        mode.smogon_sets,
        "apply_posterior_weights",
        lambda species, weights: refreshed.append(("marginal", species, weights)),
    )
    battle = Battle(None)
    battle.mode = mode
    battle.turn = 4
    battle.opponent.active = Pokemon("tatsugiri", 100)
    battle.opponent.active.publicly_known_moves.add("dracometeor")

    mode.observe_posterior(battle)

    assert [entry[:2] for entry in refreshed] == [
        ("full", "tatsugiri"),
        ("marginal", "tatsugiri"),
    ]


def test_posterior_shadow_does_not_refresh_sampling_weights(monkeypatch):
    monkeypatch.setattr(FoulPlayConfig, "pokemon_format", "gen9pdls4")
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief_data", str(FIXTURE))
    monkeypatch.setattr(FoulPlayConfig, "pdl_team_id", "adam")
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief", PdlBeliefData.load(FIXTURE))
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief_engine", "posterior-shadow")
    mode = StandardBattleMode()
    mode.initialize_team_preview_datasets("gen9pdls4", {"tatsugiri"}, "")
    monkeypatch.setattr(
        mode.team_datasets,
        "apply_posterior_weights",
        lambda *_args: pytest.fail("shadow mode must not change sampler weights"),
    )
    battle = Battle(None)
    battle.mode = mode
    battle.turn = 4
    battle.opponent.active = Pokemon("tatsugiri", 100)
    battle.opponent.active.publicly_known_moves.add("dracometeor")

    mode.observe_posterior(battle)


def test_pdl_mode_registry_rebuilds_the_standard_mode_after_cli_configuration(
    configured_pdl_mode
):
    mode = battle_mode(BattleType.STANDARD_BATTLE)

    assert isinstance(mode.team_datasets, PdlTeamDatasets)
    assert isinstance(mode.smogon_sets, PdlBeliefSmogonSets)


def test_pdl_mode_initializes_from_the_local_snapshot_without_remote_sources(
    configured_pdl_mode, monkeypatch
):
    def remote_source_was_used(*_args, **_kwargs):
        raise AssertionError("PDL mode must not request a generic remote set source")

    monkeypatch.setattr(
        "fp.data.sets.team_datasets.get_ps_sets_file", remote_source_was_used
    )
    monkeypatch.setattr(
        "fp.data.sets.team_datasets.get_pkmn_sets_file", remote_source_was_used
    )

    configured_pdl_mode.initialize_team_preview_datasets(
        "gen9pdls4", {"tatsugiri", "flamigo", "flygon", "ribombee"}, ""
    )

    assert configured_pdl_mode.team_datasets.pkmn_sets["tatsugiri"]
    assert configured_pdl_mode.smogon_sets.pkmn_sets["ribombee"]


def test_pdl_mode_samples_a_complete_opponent_set_from_the_local_snapshot(
    configured_pdl_mode
):
    battle = Battle(None)
    battle.pokemon_format = "gen9pdls4"
    battle.generation = battle.format_spec.generation
    battle.battle_type = battle.format_spec.battle_type
    battle.mode = configured_pdl_mode
    battle.user.active = Pokemon("flamigo", 100)
    battle.opponent.active = Pokemon("tatsugiri", 100)
    configured_pdl_mode.initialize_team_preview_datasets(
        "gen9pdls4", {"tatsugiri", "flamigo"}, ""
    )

    sampled_battle, probability = prepare_battles(battle, 1)[0]

    assert probability == 1
    assert sampled_battle.opponent.active.ability == "commander"
    assert sampled_battle.opponent.active.item == "choicespecs"
    assert [move.name for move in sampled_battle.opponent.active.moves] == [
        "dracometeor",
        "muddywater",
        "dragonpulse",
        "icywind",
    ]


def test_pdl_mode_never_samples_a_national_dex_mega(monkeypatch, configured_pdl_mode):
    battle = Battle(None)
    battle.pokemon_format = "gen9pdls4"
    battle.generation = battle.format_spec.generation
    battle.mode = configured_pdl_mode
    battle.user.active = Pokemon("flamigo", 100)
    battle.opponent.active = Pokemon("garchomp", 100)
    sampled_megas = []
    monkeypatch.setattr(battle, "mega_evolve_possible", lambda: True)
    monkeypatch.setattr(configured_pdl_mode, "sample_mega_evolution", lambda *_args: sampled_megas.append(True))
    monkeypatch.setattr(standard_battles, "sample_pokemon", lambda *_args: None)

    prepare_battles(battle, 1)

    assert sampled_megas == []


def test_pdl_configuration_requires_local_belief_data_and_own_team_id(monkeypatch):
    monkeypatch.setattr(FoulPlayConfig, "pokemon_format", "gen9pdls4")
    monkeypatch.setattr(FoulPlayConfig, "pdl_belief_data", None)
    monkeypatch.setattr(FoulPlayConfig, "pdl_team_id", None)

    with pytest.raises(ValueError, match="--pdl-belief-data"):
        FoulPlayConfig.validate_config()
