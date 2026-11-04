import asyncio

from fp.run_battle import ProtocolCapture
from fp.websocket_client import PSWebsocketClient


def test_protocol_capture_writes_exact_received_messages_in_order(tmp_path):
    capture = ProtocolCapture(tmp_path / "battle.protocol")

    capture.append(">battle-gen9pdls4-1\n|switch|p1a: Golem|Golem, L100|100/100")
    capture.append(">battle-gen9pdls4-1\n|move|p1a: Golem|Earthquake|p2a: Muk")
    capture.close()

    assert (tmp_path / "battle.protocol").read_text() == (
        ">battle-gen9pdls4-1\n|switch|p1a: Golem|Golem, L100|100/100\n"
        ">battle-gen9pdls4-1\n|move|p1a: Golem|Earthquake|p2a: Muk\n"
    )


def test_protocol_capture_creates_parent_output_directory(tmp_path):
    output = tmp_path / "nested" / "battle.protocol"
    capture = ProtocolCapture(output)

    capture.append(">battle-gen9pdls4-1\n|win|Adam")
    capture.close()

    assert output.read_text() == ">battle-gen9pdls4-1\n|win|Adam\n"


def test_websocket_capture_starts_before_battle_mode_consumes_preview(tmp_path):
    class FakeWebsocket:
        async def recv(self):
            return ">battle-gen9pdls4-1\n|teampreview|6\n|request|{}"

    output = tmp_path / "full.protocol"
    capture = ProtocolCapture(output)
    client = PSWebsocketClient()
    client.websocket = FakeWebsocket()
    client.protocol_capture = capture

    asyncio.run(client.receive_message())
    capture.close()

    assert "|teampreview|6" in output.read_text()
