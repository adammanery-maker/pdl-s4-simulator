import importlib.util
import sys
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "replay_pdl_position.py"
SPEC = importlib.util.spec_from_file_location("replay_pdl_position_fixture", SCRIPT)
assert SPEC and SPEC.loader
replay = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = replay
SPEC.loader.exec_module(replay)


FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "pdl_delayed_payoff"


def test_fixture_replay_uses_only_actor_data_and_accepts_own_public_mutation():
    recorded = replay.ReplayInput(
        trial_directory=FIXTURE_ROOT / "memento",
        actor="p1",
        target_turn=25,
        search_ms=25,
        requested_worlds=1,
        seed=0,
    )

    search_battle, observed, _recorded_action = replay.prepare_recorded_search_position(
        recorded, ("drednaw",)
    )

    # The fixture deliberately has no opponent request or audit file. The
    # controlled change is visible in the projected state and removes the
    # unavailable beneficiary from legal switching.
    assert not list((FIXTURE_ROOT / "memento").glob("private-p2/*"))
    assert not list((FIXTURE_ROOT / "memento").glob("*ground-truth*"))
    assert observed.digest
    drednaw = next(pokemon for pokemon in search_battle.user.reserve if pokemon.name == "drednaw")
    assert drednaw.hp == 0
