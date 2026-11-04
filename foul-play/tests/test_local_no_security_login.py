import asyncio

from fp.websocket_client import PSWebsocketClient


class RecordingClient(PSWebsocketClient):
    def __init__(self):
        self.username = "PDL Bot Adam"
        self.local_no_security = True
        self.sent = []

    async def send_message(self, room, message_list):
        self.sent.append((room, message_list))


def test_local_no_security_login_uses_the_local_showdown_guest_command():
    client = RecordingClient()

    user_id = asyncio.run(client.login())

    assert user_id == "PDL Bot Adam"
    assert client.sent == [("", ["/trn PDL Bot Adam,0,"])]
