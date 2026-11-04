import json
from types import SimpleNamespace

from fp.pdl.damage_likelihood import calculate_local_showdown_likelihood


def test_local_showdown_damage_wrapper_passes_only_explicit_hypothesis_payload(monkeypatch):
    captured = {}
    payload = {
        "attacker": {"species": "Pikachu", "ability": "Static", "moves": ["Thunderbolt"]},
        "defender": {"species": "Blissey", "ability": "Natural Cure", "moves": ["Splash"]},
        "move": "Thunderbolt",
        "critical": False,
    }

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["payload"] = json.loads(kwargs["input"])
        return SimpleNamespace(returncode=0, stdout='{"outcomeKind":{"kind":"DAMAGE"}}', stderr="")

    monkeypatch.setattr("fp.pdl.damage_likelihood.subprocess.run", fake_run)
    result = calculate_local_showdown_likelihood(payload, simulator_root="/local/simulator")

    assert result == {"outcomeKind": {"kind": "DAMAGE"}}
    assert captured["command"] == ["node", "/local/simulator/dist/pdl/inference/showdown-damage-likelihood-cli.js"]
    assert captured["payload"] == payload
