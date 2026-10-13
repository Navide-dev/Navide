from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any

import pytest

from agent_team_backend.channels.base import ChannelSendError, InboundMessage, Location
from agent_team_backend.channels.slack import SlackAdapter

from .fake_platform import FakeHttp, FakeWs

APP = "xapp-1-app"
BOT = "xoxb-bot"


async def wait_for(pred, timeout: float = 5.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not pred():
        if loop.time() > end:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


def envelope(eid: str, event: dict[str, Any]) -> str:
    return json.dumps({"envelope_id": eid, "type": "events_api", "accepts_response_payload": False,
                       "payload": {"type": "event_callback", "event": event}})


def msg(ts: str, text: str, *, channel: str = "C1", user: str = "U42", thread_ts: str | None = None,
        channel_type: str = "channel", kind: str = "message", **extra: Any) -> dict[str, Any]:
    e: dict[str, Any] = {"type": kind, "channel": channel, "user": user, "text": text, "ts": ts,
                         "channel_type": channel_type, **extra}
    if thread_ts:
        e["thread_ts"] = thread_ts
    return e


class Socket:
    def __init__(self) -> None:
        self.scripts: list[Any] = []
        self.acks: list[str] = []

    async def __call__(self, ws) -> None:
        script = self.scripts.pop(0) if self.scripts else None
        if script is None:
            await ws.wait_closed()
            return
        await script(ws, self)

    async def drain_acks(self, ws, n: int) -> None:
        for _ in range(n):
            self.acks.append(json.loads(await ws.recv())["envelope_id"])


def setup_api(http: FakeHttp, ws_url: str) -> None:
    def auth_test(r):
        if r.headers.get("authorization") != f"Bearer {BOT}":
            return {"ok": False, "error": "invalid_auth"}
        return {"ok": True, "user_id": "UBOT", "user": "navide", "bot_id": "B1", "team_id": "T1"}

    def open_conn(r):
        if r.headers.get("authorization") != f"Bearer {APP}":
            return {"ok": False, "error": "not_allowed_token_type"}
        return {"ok": True, "url": ws_url}

    http.route("POST", "/auth.test", auth_test)
    http.route("POST", "/apps.connections.open", open_conn)
    http.route("POST", "/users.info", lambda r: {"ok": True, "user": {
        "id": r.form()["user"], "name": "alice", "profile": {"display_name": "Alice"}}})


@pytest.fixture
def http():
    with FakeHttp() as h:
        yield h


async def start(http: FakeHttp, emitted: list[InboundMessage], **kw) -> SlackAdapter:
    adapter = SlackAdapter(APP, BOT, base_url=http.base_url, backoff=lambda n, r: 0.01, **kw)

    async def emit(m: InboundMessage) -> None:
        emitted.append(m)

    await adapter.start(emit)
    return adapter


async def test_socket_mode_inbound_acks_and_dedups_mention(http: FakeHttp) -> None:
    sock = Socket()
    emitted: list[InboundMessage] = []

    async def script(ws, s: Socket) -> None:
        await ws.send(json.dumps({"type": "hello", "num_connections": 1}))
        await ws.send(envelope("e1", msg("1.0001", "<@UBOT> hi", thread_ts="0.9")))
        await ws.send(envelope("e2", msg("1.0001", "<@UBOT> hi", thread_ts="0.9", kind="app_mention")))
        await ws.send(envelope("e3", msg("2.0", "dm", channel="D1", channel_type="im")))
        await ws.send(envelope("e4", msg("3.0", "bot", bot_id="B9", subtype="bot_message")))
        await ws.send(envelope("e5", msg("4.0", "self", user="UBOT")))
        await ws.send(envelope("e6", msg("5.0", "edit", subtype="message_changed")))
        await s.drain_acks(ws, 6)
        await ws.wait_closed()

    sock.scripts.append(script)
    async with FakeWs(sock) as fake:
        setup_api(http, fake.url)
        adapter = await start(http, emitted)
        await wait_for(lambda: len(sock.acks) == 6 and len(emitted) == 2)
        assert sock.acks == ["e1", "e2", "e3", "e4", "e5", "e6"]
        assert adapter.status.lifecycle == "ready" and adapter.status.identity == "@navide"
        m1, m2 = emitted
        assert (m1.chat_id, m1.thread_id, m1.sender_id, m1.sender_name, m1.is_direct) == ("C1", "0.9", "U42", "Alice", False)
        assert m1.message_id == "C1:1.0001"
        assert (m2.chat_id, m2.thread_id, m2.is_direct) == ("D1", "", True)
        await adapter.stop()


async def test_send_chunks_buttons_edit_and_create_location(http: FakeHttp) -> None:
    counter = iter(range(1000))
    http.route("POST", "/chat.postMessage", lambda r: {"ok": True, "channel": r.body["channel"], "ts": f"9.{next(counter)}"})
    http.route("POST", "/chat.update", lambda r: {"ok": True})
    adapter = SlackAdapter(APP, BOT, base_url=http.base_url)

    loc = await adapter.create_location("C1", "api-refactor")
    assert loc == Location("slack", "default", "C1", "9.0", "api-refactor")
    root = http.calls_to("POST", "/chat.postMessage")[0]
    assert root.body == {"channel": "C1", "text": "🧵 api-refactor"}
    assert root.headers["authorization"] == f"Bearer {BOT}"

    long_text = ("word " * 3000).strip()  # ~15000 chars -> 2 chunks at 8000
    ids = await adapter.send_text(loc, long_text)
    posts = http.calls_to("POST", "/chat.postMessage")[1:]
    assert len(ids) == len(posts) == 2
    assert all(p.body["thread_ts"] == "9.0" and len(p.body["text"]) <= 8000 for p in posts)

    await adapter.send_text(loc, "approve?", buttons=[("Yes", "nv1:abcde:yes"), ("No", "nv1:abcde:no")])
    last = http.calls_to("POST", "/chat.postMessage")[-1].body
    assert last["blocks"][0]["text"]["text"] == "approve?"
    assert [e["value"] for e in last["blocks"][1]["elements"]] == ["nv1:abcde:yes", "nv1:abcde:no"]

    await adapter.edit_text(loc, "9.1", "x" * 5000)
    upd = http.calls_to("POST", "/chat.update")[0].body
    assert upd["channel"] == "C1" and upd["ts"] == "9.1" and len(upd["text"]) == 4000
    # An edit replaces the message, buttons included: chat.update keeps blocks it is not given.
    assert upd["blocks"] == []
    await adapter.send_typing(loc)  # no-op, no request
    assert not http.calls_to("POST", "/chat.typing")
    await adapter.stop()


async def test_send_retries_429_and_surfaces_api_errors(http: FakeHttp) -> None:
    http.route("POST", "/chat.postMessage", lambda r: {"ok": True, "ts": "1.1"})
    http.fail("POST", "/chat.postMessage", 429, {"ok": False, "error": "ratelimited"}, {"Retry-After": "0"})
    adapter = SlackAdapter(APP, BOT, base_url=http.base_url)
    loc = Location("slack", "default", "C1")
    assert await adapter.send_text(loc, "hi") == ["1.1"]
    assert len(http.calls_to("POST", "/chat.postMessage")) == 2

    http.fail("POST", "/chat.postMessage", 200, {"ok": False, "error": "not_in_channel"})
    with pytest.raises(ChannelSendError, match="not_in_channel"):
        await adapter.send_text(loc, "hi")
    await adapter.stop()


async def test_invalid_token_blocks(http: FakeHttp) -> None:
    http.route("POST", "/auth.test", lambda r: {"ok": False, "error": "invalid_auth"})
    adapter = await start(http, [])
    await wait_for(lambda: adapter.status.lifecycle == "blocked")
    assert "invalid_auth" in adapter.status.last_error
    await asyncio.sleep(0.1)
    assert len(http.calls_to("POST", "/auth.test")) == 1
    await adapter.stop()


async def test_wrong_app_token_blocks(http: FakeHttp) -> None:
    setup_api(http, "ws://127.0.0.1:1")
    adapter = SlackAdapter("xoxb-not-app", BOT, base_url=http.base_url, backoff=lambda n, r: 0.01)

    async def emit(m: InboundMessage) -> None:
        pass

    await adapter.start(emit)
    await wait_for(lambda: adapter.status.lifecycle == "blocked")
    assert "not_allowed_token_type" in adapter.status.last_error
    await adapter.stop()


async def test_disconnect_refresh_reconnects_and_link_disabled_blocks(http: FakeHttp) -> None:
    sock = Socket()

    async def refresh(ws, s: Socket) -> None:
        await ws.send(json.dumps({"type": "hello"}))
        await ws.send(json.dumps({"type": "disconnect", "reason": "refresh_requested"}))
        await ws.wait_closed()

    async def disabled(ws, s: Socket) -> None:
        await ws.send(json.dumps({"type": "hello"}))
        await ws.send(json.dumps({"type": "disconnect", "reason": "link_disabled"}))
        await ws.wait_closed()

    sock.scripts += [refresh, disabled]
    async with FakeWs(sock) as fake:
        setup_api(http, fake.url)
        adapter = await start(http, [])
        await wait_for(lambda: adapter.status.lifecycle == "blocked")
        assert len(fake.connections) == 2
        assert adapter.status.reconnect_attempts == 0  # refresh is not a failure
        assert "link_disabled" in adapter.status.last_error
        await adapter.stop()


async def test_reconnect_after_drop(http: FakeHttp) -> None:
    sock = Socket()
    emitted: list[InboundMessage] = []

    async def drop(ws, s: Socket) -> None:
        await ws.send(json.dumps({"type": "hello"}))
        await ws.close(code=1011)

    async def second(ws, s: Socket) -> None:
        await ws.send(json.dumps({"type": "hello"}))
        await ws.send(envelope("e1", msg("7.0", "back")))
        await ws.wait_closed()

    sock.scripts += [drop, second]
    async with FakeWs(sock) as fake:
        setup_api(http, fake.url)
        adapter = await start(http, emitted)
        await wait_for(lambda: len(emitted) == 1)
        assert adapter.status.lifecycle == "ready" and len(fake.connections) == 2
        assert len(http.calls_to("POST", "/apps.connections.open")) == 2
        await adapter.stop()


async def test_block_action_becomes_callback(http: FakeHttp) -> None:
    sock = Socket()
    emitted: list[InboundMessage] = []

    async def script(ws, s: Socket) -> None:
        await ws.send(json.dumps({"type": "hello"}))
        await ws.send(json.dumps({"envelope_id": "i1", "type": "interactive", "payload": {
            "type": "block_actions", "trigger_id": "trig1",
            "user": {"id": "U42", "username": "alice"}, "channel": {"id": "C1"},
            "container": {"type": "message", "message_ts": "9.5", "thread_ts": "9.0"},
            "message": {"ts": "9.5", "thread_ts": "9.0"},
            "actions": [{"action_id": "nv_0", "value": "nv1:abcde:yes", "action_ts": "10.0"}],
        }}))
        await s.drain_acks(ws, 1)
        await ws.wait_closed()

    sock.scripts.append(script)
    async with FakeWs(sock) as fake:
        setup_api(http, fake.url)
        adapter = await start(http, emitted)
        await wait_for(lambda: len(emitted) == 1 and sock.acks == ["i1"])
        m = emitted[0]
        assert (m.callback_data, m.sender_id, m.chat_id, m.thread_id) == ("nv1:abcde:yes", "U42", "C1", "9.0")
        await adapter.stop()


def test_token_fingerprint_covers_both_tokens() -> None:
    a = SlackAdapter(APP, BOT).token_fingerprint()
    assert a == hashlib.sha256(f"{APP}\n{BOT}".encode()).hexdigest()
    assert a != SlackAdapter(APP, "xoxb-other").token_fingerprint()


def test_create_adapter_requires_both_tokens() -> None:
    from agent_team_backend.channels.slack import create_adapter

    a = create_adapter({"account": "work"}, {"app_token": APP, "bot_token": BOT}, store=None)
    assert isinstance(a, SlackAdapter) and a.account == "work"
    assert a.token_fingerprint() == SlackAdapter(APP, BOT).token_fingerprint()
    for bad in ({"bot_token": BOT}, {"app_token": APP}, {"app_token": BOT, "bot_token": APP}):
        with pytest.raises(ValueError):
            create_adapter({}, bad, store=None)


async def test_known_locations_from_inbound(http: FakeHttp) -> None:
    sock = Socket()
    emitted: list[InboundMessage] = []

    async def script(ws, s: Socket) -> None:
        await ws.send(json.dumps({"type": "hello"}))
        await ws.send(envelope("e1", msg("1.0", "hi")))
        await s.drain_acks(ws, 1)
        await ws.wait_closed()

    sock.scripts.append(script)
    async with FakeWs(sock) as fake:
        setup_api(http, fake.url)
        adapter = await start(http, emitted)
        await wait_for(lambda: len(emitted) == 1)
        assert adapter.known_locations() == [
            {"chat_id": "C1", "title": "C1", "kind": "channel", "supports_topics": True}]
        await adapter.stop()


async def test_link_url_opens_the_app_dm_once_bots_info_names_the_app(http: FakeHttp) -> None:
    http.route("POST", "/bots.info", lambda r: {"ok": True, "bot": {"id": r.form()["bot"], "app_id": "A77"}})
    sock = Socket()

    async def script(ws, s: Socket) -> None:
        await ws.send(json.dumps({"type": "hello", "num_connections": 1}))
        await ws.wait_closed()

    sock.scripts.append(script)
    async with FakeWs(sock) as fake:
        setup_api(http, fake.url)
        adapter = await start(http, [])
        await wait_for(lambda: adapter.status.lifecycle == "ready")
        assert http.calls_to("POST", "/bots.info")[0].form()["bot"] == "B1"
        assert adapter.link_url("ABCD2345", "direct") == "https://slack.com/app_redirect?app=A77&team=T1"
        assert adapter.link_url("ABCD2345", "group") == ""
        await adapter.stop()


async def test_menu_sends_and_edits_one_actions_block_per_button_row(http: FakeHttp) -> None:
    http.route("POST", "/chat.postMessage", lambda r: {"ok": True, "channel": r.body["channel"], "ts": "9.5"})
    http.route("POST", "/chat.update", lambda r: {"ok": True})
    adapter = SlackAdapter(APP, BOT, base_url=http.base_url)
    loc = Location("slack", "default", "C1", "9.0")
    rows = [[("💬 A", "nv2:p:aaaaaaaa"), ("💬 B", "nv2:p:bbbbbbbb")], [("Next ▶", "nv2:g:cccccccc")]]
    assert await adapter.send_menu(loc, "menu", rows) == "9.5"
    body = http.calls_to("POST", "/chat.postMessage")[0].body
    assert body["thread_ts"] == "9.0" and body["blocks"][0]["text"]["text"] == "menu"
    actions = [b for b in body["blocks"] if b["type"] == "actions"]
    assert [[e["value"] for e in b["elements"]] for b in actions] == [[d for _, d in r] for r in rows]
    ids = [e["action_id"] for b in actions for e in b["elements"]]
    assert len(ids) == len(set(ids))
    await adapter.edit_menu(loc, "9.5", "page 2", rows[1:])
    upd = http.calls_to("POST", "/chat.update")[0].body
    assert upd["ts"] == "9.5" and [b["type"] for b in upd["blocks"]] == ["section", "actions"]
