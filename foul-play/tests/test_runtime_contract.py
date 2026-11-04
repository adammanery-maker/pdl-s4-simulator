from types import SimpleNamespace

from fp.runtime_contract import RUNTIME_ID, runtime_contract


def test_runtime_contract_attests_resolved_configuration():
    canonical = runtime_contract(
        SimpleNamespace(offline_runtime=True, search_engine="mcts", action_policy="argmax")
    )
    assert canonical["id"] == RUNTIME_ID
    assert canonical["resolvedConfiguration"] == {
        "offlineRuntime": True,
        "searchEngine": "mcts",
        "actionPolicy": "argmax",
    }
    assert canonical["evaluator"]["engineSourceSha256"]

    for noncanonical in (
        SimpleNamespace(offline_runtime=False, search_engine="mcts", action_policy="argmax"),
        SimpleNamespace(offline_runtime=True, search_engine="expectiminimax", action_policy="argmax"),
        SimpleNamespace(offline_runtime=True, search_engine="mcts", action_policy="stochastic"),
    ):
        try:
            runtime_contract(noncanonical)
        except RuntimeError as error:
            assert "requires --offline-runtime" in str(error)
        else:
            raise AssertionError("noncanonical configuration claimed the canonical runtime id")
