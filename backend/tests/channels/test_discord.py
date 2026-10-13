from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from agent_team_backend.channels.base import ChannelSendError, InboundMessage, Location
from agent_team_backend.channels.discord import INTENTS, DiscordAdapter

from .fake_platform import FakeHttp, FakeWs, Resp

TOKEN = "discord-bot-token"


async def wait_for(pred, timeout: float = 5.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not pred():
        if loop.time() > end:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


def hello(interval_ms: int = 45000) -> str:
    return json.dumps({"op": 10, "d": {"heartbeat_interval": interval_ms}})


def dispatch(t: str, d: dict[str, Any], s: int) -> str:
    return json.dumps({"op": 0, "t": t, "d": d, "s": s})


class Gateway:
    """Scripted gateway: each connection runs the next script in ``scripts``."""

    def __init__(self) -> None:
        self.scripts: list[Any] = []
        self.received: list[dict[str, Any]] = []

    async def __call__(self, ws) -> None:
        script = self.scripts.pop(0) if self.scripts else None
        if script is None:
            await ws.wait_closed()
            return
        await script(ws, self)

    async def recv(self, ws) -> dict[str, Any]:
        while True:
            msg = json.loads(await ws.recv())
            self.received.append(msg)
            if msg.get("op") != 1:  # skip heartbeats
                return msg


def ready(url: str, s: int = 1) -> str:
    return dispatch("READY", {"user": {"id": "999", "username": "navide"}, "session_id": "sess1",
                              "resume_gateway_url": url}, s)


def message(mid: str, channel_id: str, content: str, *, author_id: str = "42", guild: bool = True,
            bot: bool = False) -> dict[str, Any]:
    d: dict[str, Any] = {"id": mid, "channel_id": channel_id, "content": content, "type": 0,
                         "author": {"id": author_id, "username": "alice", "global_name": "Alice", "bot": bot}}
    if guild:
        d["guild_id"] = "g1"
    return d


@pytest.fixture
def http():
    with FakeHttp() as h:
        yield h


async def start_adapter(http: FakeHttp, gw_url: str, emitted: list[InboundMessage], **kw) -> DiscordAdapter:
    http.route("GET", "/gateway/bot", lambda r: {"url": gw_url})
    adapter = DiscordAdapter(TOKEN, base_url=http.base_url, backoff=lambda n, r: 0.01, **kw)

    async def emit(m: InboundMessage) -> None:
        emitted.append(m)

    await adapter.start(emit)
    return adapter


async def test_connect_identify_and_inbound_mapping(http: FakeHttp) -> None:
    gw = Gateway()
    emitted: list[InboundMessage] = []
    http.route("GET", "/channels/T2", lambda r: {"id": "T2", "type": 11, "parent_id": "C9"})
    http.route("GET", "/channels/C1", lambda r: {"id": "C1", "type": 0})
    http.route("GET", "/channels/D1", lambda r: {"id": "D1", "type": 1})

    async def script(ws, g: Gateway) -> None:
        await ws.send(hello())
        ident = await g.recv(ws)
        assert ident["op"] == 2
        assert ident["d"]["token"] == TOKEN and ident["d"]["intents"] == INTENTS
        await ws.send(ready(fake.url))
        await ws.send(dispatch("THREAD_CREATE", {"id": "T1", "type": 11, "parent_id": "C1"}, 2))
        await ws.send(dispatch("MESSAGE_CREATE", message("m1", "T1", "in thread"), 3))
        await ws.send(dispatch("MESSAGE_CREATE", message("m2", "C1", "in channel"), 4))
        await ws.send(dispatch("MESSAGE_CREATE", message("m3", "D1", "dm", guild=False), 5))
        await ws.send(dispatch("MESSAGE_CREATE", message("m4", "C1", "from bot", bot=True), 6))
        await ws.send(dispatch("MESSAGE_CREATE", message("m5", "T2", "unknown thread"), 7))
        await ws.wait_closed()

    gw.scripts.append(script)
    async with FakeWs(gw) as fake:
        adapter = await start_adapter(http, fake.url, emitted)
        await wait_for(lambda: len(emitted) == 4)
        assert adapter.status.lifecycle == "ready" and adapter.status.connected
        assert adapter.status.identity == "@navide"
        m1, m2, m3, m5 = emitted
        assert (m1.chat_id, m1.thread_id, m1.sender_id, m1.sender_name, m1.is_direct) == ("C1", "T1", "42", "Alice", False)
        assert m1.message_id == "m1" and m1.text == "in thread"
        assert (m2.chat_id, m2.thread_id) == ("C1", "")
        assert (m3.chat_id, m3.thread_id, m3.is_direct) == ("D1", "", True)
        assert (m5.chat_id, m5.thread_id) == ("C9", "T2")  # parent resolved over REST
        assert m1.location_key() == "discord:default:C1:T1"
        await adapter.stop()
        assert adapter.status.lifecycle == "stopped"


async def test_send_chunks_buttons_edit_typing_and_create_location(http: FakeHttp) -> None:
    counter = iter(range(1000))
    http.route("POST", r"/channels/[^/]+/messages", lambda r: {"id": f"msg{next(counter)}"})
    http.route("PATCH", r"/channels/[^/]+/messages/[^/]+", lambda r: {"id": "x"})
    http.route("POST", r"/channels/[^/]+/typing", lambda r: Resp(204, ""))
    http.route("POST", r"/channels/C1/threads", lambda r: {"id": "T77", "type": 11, "name": r.body["name"]})
    adapter = DiscordAdapter(TOKEN, base_url=http.base_url)

    loc = await adapter.create_location("C1", "api-refactor")
    assert loc == Location("discord", "default", "C1", "T77", "api-refactor")
    body = http.calls_to("POST", "/channels/C1/threads")[0].body
    assert body == {"name": "api-refactor", "type": 11, "auto_archive_duration": 10080}
    assert http.calls_to("POST", "/channels/C1/threads")[0].headers["authorization"] == f"Bot {TOKEN}"

    text = "\n".join(f"line {i}" for i in range(40))
    ids = await adapter.send_text(loc, text, buttons=[("Yes", "nv1:abcde:yes"), ("No", "nv1:abcde:no")])
    posts = http.calls_to("POST", "/channels/T77/messages")
    assert len(ids) == len(posts) >= 3
    assert all(len(p.body["content"]) <= 2000 and p.body["content"].count("\n") < 17 for p in posts)
    assert "components" not in posts[0].body
    buttons = posts[-1].body["components"][0]["components"]
    assert [b["custom_id"] for b in buttons] == ["nv1:abcde:yes", "nv1:abcde:no"]

    await adapter.edit_text(loc, ids[0], "edited")
    patch = http.calls_to("PATCH", f"/channels/T77/messages/{ids[0]}")[0].body
    # An edit replaces the message, buttons included: a settled prompt keeps none.
    assert patch["content"] == "edited" and patch["components"] == []
    await adapter.send_typing(loc)
    assert http.calls_to("POST", "/channels/T77/typing")
    # A plain channel location posts to the channel itself.
    await adapter.send_text(Location("discord", "default", "C1"), "hi")
    assert http.calls_to("POST", "/channels/C1/messages")
    await adapter.stop()


async def test_send_honours_429_retry_after_and_reports_errors(http: FakeHttp) -> None:
    http.route("POST", r"/channels/C1/messages", lambda r: {"id": "ok1"})
    http.fail("POST", r"/channels/C1/messages", 429, {"retry_after": 0.05, "global": False})
    adapter = DiscordAdapter(TOKEN, base_url=http.base_url)
    loc = Location("discord", "default", "C1")
    assert await adapter.send_text(loc, "hello") == ["ok1"]
    assert len(http.calls_to("POST", "/channels/C1/messages")) == 2

    http.fail("POST", r"/channels/C1/messages", 403, {"message": "Missing Permissions", "code": 50013})
    with pytest.raises(ChannelSendError, match="Missing Permissions"):
        await adapter.send_text(loc, "hello")
    http.fail("POST", r"/channels/C1/messages", 500, {"message": "boom"})
    with pytest.raises(ChannelSendError) as info:
        await adapter.send_text(loc, "hello")
    assert info.value.retryable is False
    await adapter.stop()


async def test_rest_401_blocks_without_retry(http: FakeHttp) -> None:
    http.fail("GET", "/gateway/bot", 401, {"message": "401: Unauthorized", "code": 0})
    adapter = DiscordAdapter(TOKEN, base_url=http.base_url, backoff=lambda n, r: 0.01)

    async def emit(m: InboundMessage) -> None:
        pass

    await adapter.start(emit)
    await wait_for(lambda: adapter.status.lifecycle == "blocked")
    await asyncio.sleep(0.1)
    assert len(http.calls_to("GET", "/gateway/bot")) == 1
    assert "401" in adapter.status.last_error
    await adapter.stop()


@pytest.mark.parametrize("code,needle", [(4004, "token"), (4014, "Message Content Intent")])
async def test_fatal_close_codes_block(http: FakeHttp, code: int, needle: str) -> None:
    gw = Gateway()

    async def script(ws, g: Gateway) -> None:
        await ws.send(hello())
        await g.recv(ws)
        await ws.close(code=code, reason="nope")

    gw.scripts.append(script)
    async with FakeWs(gw) as fake:
        adapter = await start_adapter(http, fake.url, [])
        await wait_for(lambda: adapter.status.lifecycle == "blocked")
        assert needle in adapter.status.last_error
        await asyncio.sleep(0.1)
        assert len(fake.connections) == 1
        await adapter.stop()


async def test_reconnect_after_drop_resumes_session(http: FakeHttp) -> None:
    gw = Gateway()
    emitted: list[InboundMessage] = []

    async def first(ws, g: Gateway) -> None:
        await ws.send(hello())
        await g.recv(ws)
        await ws.send(ready(fake.url, s=5))
        await ws.close(code=4000, reason="drop")

    async def second(ws, g: Gateway) -> None:
        await ws.send(hello())
        resume = await g.recv(ws)
        assert resume == {"op": 6, "d": {"token": TOKEN, "session_id": "sess1", "seq": 5}}
        await ws.send(dispatch("RESUMED", {}, 6))
        await ws.send(dispatch("MESSAGE_CREATE", message("m9", "D1", "after resume", guild=False), 7))
        await ws.wait_closed()

    gw.scripts += [first, second]
    http.route("GET", "/channels/D1", lambda r: {"id": "D1", "type": 1})
    async with FakeWs(gw) as fake:
        adapter = await start_adapter(http, fake.url, emitted)
        await wait_for(lambda: len(emitted) == 1)
        assert adapter.status.lifecycle == "ready"
        assert adapter.status.reconnect_attempts == 0
        assert len(fake.connections) == 2
        # Resume skips GET /gateway/bot and dials resume_gateway_url.
        assert len(http.calls_to("GET", "/gateway/bot")) == 1
        await adapter.stop()


async def test_missing_heartbeat_ack_reconnects(http: FakeHttp) -> None:
    gw = Gateway()

    async def silent(ws, g: Gateway) -> None:
        await ws.send(hello(interval_ms=50))
        await g.recv(ws)
        await ws.send(ready(fake.url))
        async for raw in ws:  # never ACKs heartbeats
            g.received.append(json.loads(raw))

    async def healthy(ws, g: Gateway) -> None:
        await ws.send(hello())
        await g.recv(ws)
        await ws.send(dispatch("RESUMED", {}, 2))
        await ws.wait_closed()

    gw.scripts += [silent, healthy]
    async with FakeWs(gw) as fake:
        adapter = await start_adapter(http, fake.url, [])
        await wait_for(lambda: len(fake.connections) == 2)
        assert any(m.get("op") == 1 for m in gw.received)
        await wait_for(lambda: adapter.status.lifecycle == "ready")
        await adapter.stop()


async def test_invalid_session_reidentifies(http: FakeHttp) -> None:
    gw = Gateway()

    async def first(ws, g: Gateway) -> None:
        await ws.send(hello())
        await g.recv(ws)
        await ws.send(json.dumps({"op": 9, "d": False}))
        await ws.wait_closed()

    async def second(ws, g: Gateway) -> None:
        await ws.send(hello())
        ident = await g.recv(ws)
        assert ident["op"] == 2
        await ws.send(ready(fake.url))
        await ws.wait_closed()

    gw.scripts += [first, second]
    async with FakeWs(gw) as fake:
        adapter = await start_adapter(http, fake.url, [], invalid_session_wait_s=0.01)
        await wait_for(lambda: adapter.status.lifecycle == "ready")
        assert len(fake.connections) == 2
        await adapter.stop()


async def test_button_interaction_is_acked_and_emitted(http: FakeHttp) -> None:
    gw = Gateway()
    emitted: list[InboundMessage] = []
    http.route("POST", r"/interactions/[^/]+/[^/]+/callback", lambda r: Resp(204, ""))

    async def script(ws, g: Gateway) -> None:
        await ws.send(hello())
        await g.recv(ws)
        await ws.send(ready(fake.url))
        await ws.send(dispatch("THREAD_CREATE", {"id": "T1", "type": 11, "parent_id": "C1"}, 2))
        await ws.send(dispatch("INTERACTION_CREATE", {
            "id": "i1", "token": "itok", "type": 3, "channel_id": "T1", "guild_id": "g1",
            "member": {"user": {"id": "42", "username": "alice"}},
            "data": {"custom_id": "nv1:abcde:yes", "component_type": 2},
        }, 3))
        await ws.wait_closed()

    gw.scripts.append(script)
    async with FakeWs(gw) as fake:
        adapter = await start_adapter(http, fake.url, emitted)
        await wait_for(lambda: len(emitted) == 1)
        m = emitted[0]
        assert (m.callback_data, m.sender_id, m.chat_id, m.thread_id) == ("nv1:abcde:yes", "42", "C1", "T1")
        assert http.calls_to("POST", "/interactions/i1/itok/callback")[0].body == {"type": 6}
        await adapter.stop()


def test_token_fingerprint_is_sha256() -> None:
    import hashlib

    assert DiscordAdapter(f" {TOKEN} ").token_fingerprint() == hashlib.sha256(TOKEN.encode()).hexdigest()


def test_create_adapter_from_config_and_secret() -> None:
    from agent_team_backend.channels.discord import create_adapter

    a = create_adapter({"account": "work"}, {"token": f" {TOKEN} "}, store=None)
    assert isinstance(a, DiscordAdapter) and a.account == "work"
    assert a.token_fingerprint() == DiscordAdapter(TOKEN).token_fingerprint()
    with pytest.raises(ValueError):
        create_adapter({}, {}, store=None)


async def test_known_locations_from_guild_channels_and_dms(http: FakeHttp) -> None:
    gw = Gateway()
    emitted: list[InboundMessage] = []
    http.route("GET", "/channels/D1", lambda r: {"id": "D1", "type": 1})

    async def script(ws, g: Gateway) -> None:
        await ws.send(hello())
        await g.recv(ws)
        await ws.send(ready(fake.url))
        await ws.send(dispatch("GUILD_CREATE", {"id": "g1", "threads": [], "channels": [
            {"id": "C1", "type": 0, "name": "general"}, {"id": "V1", "type": 2, "name": "voice"}]}, 2))
        await ws.send(dispatch("MESSAGE_CREATE", message("m1", "D1", "dm", guild=False), 3))
        await ws.wait_closed()

    gw.scripts.append(script)
    async with FakeWs(gw) as fake:
        adapter = await start_adapter(http, fake.url, emitted)
        await wait_for(lambda: len(emitted) == 1)
        assert adapter.known_locations() == [
            {"chat_id": "C1", "title": "#general", "kind": "channel", "supports_topics": True},
            {"chat_id": "D1", "title": "alice", "kind": "dm", "supports_topics": False},
        ]
        await adapter.stop()


async def test_link_url_is_the_bot_install_url_from_ready() -> None:
    adapter = DiscordAdapter("tok")
    assert adapter.link_url("ABCD2345", "group") == ""  # before READY
    await adapter._dispatch("READY", {"user": {"id": "999", "username": "navide"}, "session_id": "s",
                                      "resume_gateway_url": "wss://x", "application": {"id": "555"}})
    assert adapter.link_url("ABCD2345", "group") == (
        "https://discord.com/oauth2/authorize?client_id=555&scope=bot&permissions=309237713920")
    assert adapter.link_url("ABCD2345", "direct") == ""


async def test_menu_sends_and_edits_one_action_row_per_button_row(http: FakeHttp) -> None:
    http.route("POST", r"/channels/[^/]+/messages", lambda r: {"id": "msg1"})
    http.route("PATCH", r"/channels/[^/]+/messages/[^/]+", lambda r: {"id": "msg1"})
    adapter = DiscordAdapter(TOKEN, base_url=http.base_url)
    loc = Location("discord", "default", "C1", "T77")
    rows = [[(f"💬 {i}", f"nv2:p:aaaaaaa{i}") for i in range(5)], [("Next ▶", "nv2:g:bbbbbbbb")]]
    assert await adapter.send_menu(loc, "menu", rows) == "msg1"
    body = http.calls_to("POST", "/channels/T77/messages")[0].body
    assert [r["type"] for r in body["components"]] == [1, 1]
    assert [b["custom_id"] for b in body["components"][0]["components"]] == [d for _, d in rows[0]]
    assert body["components"][1]["components"][0]["label"] == "Next ▶"
    await adapter.edit_menu(loc, "msg1", "page 2", rows[1:])
    patch = http.calls_to("PATCH", "/channels/T77/messages/msg1")[0].body
    assert patch["content"] == "page 2" and len(patch["components"]) == 1
