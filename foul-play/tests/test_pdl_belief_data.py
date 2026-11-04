import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from fp.format_spec import FormatSpec
from fp.pdl.belief_data import PdlBeliefData, PdlBeliefDataError, PdlSetCandidate
from fp.pdl.posterior import PdlPosterior
from fp.pdl.team_datasets import PdlBeliefSmogonSets, PdlTeamDatasets


FIXTURE = Path(__file__).parent / "fixtures" / "pdl-belief-v1.json"


def test_ditto_prior_preserves_its_one_legal_move_through_existing_datasets(tmp_path):
    raw = json.loads(FIXTURE.read_text())
    raw["teams"]["adam"]["roster"].append({"species": "Ditto", "cost": 5})
    raw["sets"]["ditto"] = [{
        "weight": 1, "ability": "Imposter", "item": "Choice Scarf", "nature": "Timid",
        "evs": [252, 0, 0, 0, 4, 252], "moves": ["Transform"], "teraType": None,
    }]
    path = tmp_path / "ditto.json"
    path.write_text(json.dumps(raw))
    belief = PdlBeliefData.load(path)
    datasets = PdlTeamDatasets(belief)
    datasets.initialize(FormatSpec.from_format_string("gen9pdls4"), {"ditto"})
    assert datasets.pkmn_sets["ditto"][0].pkmn_moveset.moves == ("transform",)
    raw["sets"]["ditto"][0]["moves"] = ["Tackle"]
    path.write_text(json.dumps(raw))
    with pytest.raises(PdlBeliefDataError, match="four moves"):
        PdlBeliefData.load(path)


def test_loads_versioned_local_belief_data_and_builds_full_sets():
    belief = PdlBeliefData.load(FIXTURE)
    datasets = PdlTeamDatasets(belief)
    datasets.initialize(FormatSpec.from_format_string("gen9pdls4"), {"tatsugiri"})

    tatsugiri = datasets.pkmn_sets["tatsugiri"][0]
    assert belief.snapshot_id == "pdl-s4-test-snapshot-2026-08-11"
    assert tatsugiri.pkmn_set.tera_type == "grass"
    assert tatsugiri.pkmn_set.item == "choicespecs"
    assert tatsugiri.pkmn_moveset.moves == (
        "dracometeor",
        "muddywater",
        "dragonpulse",
        "icywind",
    )


def test_local_belief_data_contains_only_pdl_legal_tera_candidates():
    belief = PdlBeliefData.load(FIXTURE)

    assert belief.tera_is_allowed("adam", "tatsugiri", "dragon")
    assert belief.tera_is_allowed("adam", "tatsugiri", "grass")  # Adam's drafted type
    assert belief.tera_is_allowed("adam", "tatsugiri", "ghost")  # Adam's drafted type
    assert not belief.tera_is_allowed("adam", "tatsugiri", "electric")


def test_captain_identity_is_public_but_fixed_type_can_be_private():
    belief = PdlBeliefData.load(FIXTURE)

    assert belief.is_tera_captain("connor", "ribombee")




def test_pdl_datasets_do_not_have_a_remote_or_generic_set_fallback():
    belief = PdlBeliefData.load(FIXTURE)
    local_sets = PdlTeamDatasets(belief)
    local_sets.initialize(FormatSpec.from_format_string("gen9pdls4"), {"tatsugiri"})
    marginal_sets = PdlBeliefSmogonSets(belief)
    marginal_sets.initialize(FormatSpec.from_format_string("gen9pdls4"), {"tatsugiri"})

    assert local_sets.raw_pkmn_sets.keys() == {"tatsugiri"}
    assert marginal_sets.current_pkmn_sets_url == "pdl-belief-v1"
    tatsugiri_move_rates = dict(marginal_sets.move_usage_rates_by_name("tatsugiri"))
    assert tatsugiri_move_rates["dracometeor"] == 1
    assert all(0 <= rate <= 1 for rate in tatsugiri_move_rates.values())


def test_rejects_set_candidates_that_assign_tera_to_a_high_cost_pokemon(tmp_path):
    invalid = FIXTURE.read_text().replace('"teraType": null', '"teraType": "grass"', 1)
    path = tmp_path / "invalid.json"
    path.write_text(invalid)

    with pytest.raises(PdlBeliefDataError, match="cost 6"):
        PdlBeliefData.load(path)


def test_posterior_weights_refresh_existing_complete_set_and_marginal_sampling():
    candidates = (
        PdlSetCandidate(
            0.5, "commander", "choicespecs", "timid", (0, 0, 0, 252, 4, 252),
            ("dracometeor", "muddywater", "dragonpulse", "icywind"), "grass",
        ),
        PdlSetCandidate(
            0.5, "stormdrain", "leftovers", "modest", (252, 0, 0, 252, 4, 0),
            ("dracometeor", "surf", "recover", "icywind"), "grass",
        ),
    )
    belief = SimpleNamespace(
        candidates={"tatsugiri": candidates},
        candidates_for=lambda species: candidates if species == "tatsugiri" else (),
    )
    posterior = PdlPosterior.from_candidates({"tatsugiri": candidates})
    full_sets = PdlTeamDatasets(belief)
    marginals = PdlBeliefSmogonSets(belief)
    format_spec = FormatSpec.from_format_string("gen9pdls4")
    full_sets.initialize(format_spec, {"tatsugiri"})
    marginals.initialize(format_spec, {"tatsugiri"})

    posterior.apply_revealed_item("tatsugiri", "choicespecs", turn=1)
    weights = posterior.weights("tatsugiri")
    full_sets.apply_posterior_weights("tatsugiri", weights)
    marginals.apply_posterior_weights("tatsugiri", weights)

    sampled_set = full_sets.pkmn_sets["tatsugiri"]
    assert len(sampled_set) == 1
    assert sampled_set[0].pkmn_set.item == "choicespecs"
    assert sampled_set[0].pkmn_moveset.moves == candidates[0].moves
    assert dict(marginals.move_usage_rates_by_name("tatsugiri"))["muddywater"] == 1
    assert "surf" not in dict(marginals.move_usage_rates_by_name("tatsugiri"))
