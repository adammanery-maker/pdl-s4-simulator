import pytest

from fp.pdl.belief_data import PdlSetCandidate
from fp.pdl.posterior import PdlPosterior


def two_candidate_posterior():
    return PdlPosterior.from_candidates({
        "tatsugiri": (
            PdlSetCandidate(0.5, "commander", "choicespecs", "timid", (0, 0, 0, 252, 4, 252), ("dracometeor", "muddywater", "dragonpulse", "icywind"), "grass"),
            PdlSetCandidate(0.5, "stormdrain", "leftovers", "modest", (252, 0, 0, 252, 4, 0), ("dracometeor", "surf", "recover", "icywind"), "grass"),
        )
    })


def test_damage_evidence_reweights_templates_without_overclaiming_one_roll():
    posterior = two_candidate_posterior()
    candidates = posterior.for_species("tatsugiri")
    assert len(candidates) == 2

    posterior.apply_damage_likelihood("tatsugiri", {candidates[0].key: 3 / 16, candidates[1].key: 1 / 16}, turn=3)

    weights = posterior.weights("tatsugiri")
    assert weights[candidates[0].key] == pytest.approx(0.75)
    assert weights[candidates[1].key] == pytest.approx(0.25)
    assert posterior.evidence_for("tatsugiri")[-1].source == "damage"


def test_revealed_move_is_a_hard_constraint_but_unseen_templates_can_fall_back():
    posterior = two_candidate_posterior()
    posterior.apply_revealed_move("tatsugiri", "dracometeor", turn=1)
    assert posterior.active_count("tatsugiri") == 2

    posterior.apply_revealed_move("tatsugiri", "hydropump", turn=2)
    assert posterior.fallback_used("tatsugiri")
    assert posterior.active_count("tatsugiri") == 2
    assert posterior.evidence_for("tatsugiri")[-1].fallback_used


def test_direct_item_and_ability_reveals_collapse_only_the_relevant_variable():
    posterior = two_candidate_posterior()
    posterior.apply_revealed_item("tatsugiri", "choicespecs", turn=4)
    posterior.apply_revealed_ability("tatsugiri", "commander", turn=4)

    assert posterior.active_count("tatsugiri") == 1
    candidate = posterior.for_species("tatsugiri")[0]
    assert candidate.candidate.item == "choicespecs"
    assert candidate.candidate.ability == "commander"


def test_speed_order_filters_only_strictly_impossible_hypotheses_and_keeps_ties():
    posterior = two_candidate_posterior()
    candidates = posterior.for_species("tatsugiri")
    posterior.apply_speed_order("tatsugiri", {candidates[0].key: 200, candidates[1].key: 250}, reference_speed=250, opponent_moved_first=True, turn=5)

    assert posterior.active_count("tatsugiri") == 1
    assert posterior.for_species("tatsugiri")[0].key == candidates[1].key
