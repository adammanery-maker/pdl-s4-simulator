"""Runtime network boundary for reproducible local simulations."""

from __future__ import annotations

import ipaddress
import os
import socket
from urllib.parse import urlparse


_enabled = False


def _loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def enable_loopback_only_network(websocket_uri: str) -> None:
    """Permit the configured Showdown websocket only; reject all other sockets."""
    global _enabled
    if _enabled:
        return
    parsed = urlparse(websocket_uri)
    host = parsed.hostname
    port = parsed.port
    if parsed.scheme != "ws" or not host or port is None or not _loopback(host):
        raise ValueError("Offline mode requires a ws:// loopback Showdown websocket URI with an explicit port.")
    allowed = {(host, port)}
    if host == "localhost":
        allowed.update({("127.0.0.1", port), ("::1", port)})

    def reject(hostname: str, target_port: int) -> None:
        if (hostname, target_port) in allowed:
            return
        message = f"offline runtime blocked non-Showdown connection to {hostname}:{target_port}"
        audit_path = os.environ.get("PDL_OFFLINE_NETWORK_AUDIT_PATH")
        if audit_path:
            with open(audit_path, "a", encoding="utf8") as audit_file:
                audit_file.write(message + "\n")
        raise OSError(message)

    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex

    def guarded_connect(sock, address):
        host = address[0] if isinstance(address, tuple) else ""
        port = address[1] if isinstance(address, tuple) and len(address) > 1 else -1
        reject(str(host), int(port))
        return original_connect(sock, address)

    def guarded_connect_ex(sock, address):
        host = address[0] if isinstance(address, tuple) else ""
        port = address[1] if isinstance(address, tuple) and len(address) > 1 else -1
        reject(str(host), int(port))
        return original_connect_ex(sock, address)

    socket.socket.connect = guarded_connect
    socket.socket.connect_ex = guarded_connect_ex
    _enabled = True
