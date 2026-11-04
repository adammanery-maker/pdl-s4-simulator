import socket

import pytest

from fp.offline import enable_loopback_only_network


def test_offline_runtime_allows_only_the_configured_showdown_port(monkeypatch, tmp_path):
    calls = []
    audit_path = tmp_path / "network-audit.log"

    def fake_connect(_socket, address):
        calls.append(address)

    monkeypatch.setattr(socket.socket, "connect", fake_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", fake_connect)
    monkeypatch.setattr("fp.offline._enabled", False)
    monkeypatch.setenv("PDL_OFFLINE_NETWORK_AUDIT_PATH", str(audit_path))
    enable_loopback_only_network("ws://127.0.0.1:8000/showdown/websocket")
    client = socket.socket()

    client.connect(("127.0.0.1", 8000))
    with pytest.raises(OSError, match="blocked non-Showdown"):
        client.connect(("127.0.0.1", 11434))
    with pytest.raises(OSError, match="blocked non-Showdown"):
        client.connect(("8.8.8.8", 443))
    assert calls == [("127.0.0.1", 8000)]
    assert audit_path.read_text().splitlines() == [
        "offline runtime blocked non-Showdown connection to 127.0.0.1:11434",
        "offline runtime blocked non-Showdown connection to 8.8.8.8:443",
    ]
