from __future__ import annotations

import asyncio
import logging
import hashlib
import itertools
import sqlite3
import time
from typing import Any

import pytest

from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels import relay as relay_mod
from agent_team_backend.channels.base import AdapterStatus, Capabilities, InboundMessage, Location
from agent_team_backend.channels.manager import (
    MSG_INTERRUPTED,
    MSG_NOT_BOUND,
    MSG_RECEIVED_BUSY,
    MSG_WORKING,
    ChannelManager,
    Seams,
)
from agent_team_backend.channels.store import ChannelStore
from agent_team_backend.db import Database

# Unique per call: time.monotonic_ns() repeats within a ~15.6 ms tick on Windows.
_MIDS = itertools.count()


class FakeAdapter:
    capabilities = Capabilities(threads=True, create_location=True, edit=True, typing=True,
                                buttons=True, text_limit=4000)

    def __init__(self, platform: str, token: str) -> None:
        self.platform = platform
        self.account = "default"
        self.token = token
        self.status = AdapterStatus()
        self.sent: list[tuple[Location, str]] = []
        self.edits: list[tuple[str, str]] = []
        self.typing = 0
        self.fail_edits = False
        self.emit = None
        self.menus: list[tuple[Location, str, list]] = []
        self.menu_edits: list[tuple[str, str, list]] = []

    async def start(self, emit) -> None:
        self.emit = emit
        self.status.lifecycle = "ready"
        self.status.connected = True

    async def stop(self) -> None:
        self.status.lifecycle = "stopped"
        self.status.connected = False

    async def send_text(self, loc: Location, text: str, *, buttons=None) -> list[str]:
        self.sent.append((loc, text))
        return [str(len(self.sent))]

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None:
        if self.fail_edits:
            self.edits.append((message_id, "FAILED"))
            raise RuntimeError("edit failed")
        self.edits.append((message_id, text))

    async def send_menu(self, loc: Location, text: str, rows: list) -> str:
        if getattr(self, "fail_menus", False):
            raise RuntimeError("Bad Request: BUTTON_DATA_INVALID")
        self.menus.append((loc, text, rows))
        return f"menu{len(self.menus)}"

    async def edit_menu(self, loc: Location, message_id: str, text: str, rows: list) -> None:
        if self.fail_edits:
            raise RuntimeError("edit failed")
        self.menu_edits.append((message_id, text, rows))

    async def send_typing(self, loc: Location) -> None:
        self.typing += 1

    async def create_location(self, chat_id: str, title: str) -> Location:
        return Location(self.platform, self.account, chat_id, "77", title)

    def token_fingerprint(self) -> str:
        return hashlib.sha256(self.token.encode()).hexdigest()

    def texts(self) -> list[str]:
        return [t for _, t in self.sent]


class FakeSeams:
    def __init__(self) -> None:
        self.delivered: list[tuple[str, str, str]] = []
        self.verdicts: dict[str, dict[str, Any]] = {}
        self.interrupts: list[str] = []
        self.states: dict[str, dict[str, Any]] = {}
        self.aliases: dict[str, str] = {}
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.secrets: dict[str, str | None] = {}
        self.kind = "permission"
        self.prompt = "Allow Bash(npm run build)?"
        self.options: list[str] = []
        self.gone: set[str] = set()
        self.answers: list[tuple[str, dict[str, Any]]] = []
        self.answer_result: dict[str, Any] = {"ok": True}
        self.settings: dict[str, Any] = {}
        self.agents: dict[str, str] = {}
        self.skills: dict[str, list[str]] = {}
        self._n = 0

    async def deliver(self, pane_id: str, text: str, from_display: str) -> dict[str, Any]:
        self._n += 1
        self.delivered.append((pane_id, text, from_display))
        return {"ok": True, "msg_key": f"k{self._n}", "pane_id": pane_id}

    async def await_verdict(self, msg_key: str, timeout: float) -> dict[str, Any]:
        await asyncio.sleep(0.01)
        return self.verdicts.get(msg_key, {"status": "queued"})

    async def interrupt(self, pane_id: str) -> dict[str, Any]:
        self.interrupts.append(pane_id)
        return {"ok": True, "sent": True}

    def pane_state(self, pane_id: str) -> dict[str, Any]:
        return self.states.get(pane_id, {"exists": True, "busy": False, "display_status": "idle"})

    async def awaiting_info(self, pane_id: str) -> dict[str, Any]:
        return {"kind": self.kind, "prompt": self.prompt, "options": self.options}

    async def answer(self, pane_id: str, answer: dict[str, Any]) -> dict[str, Any]:
        self.answers.append((pane_id, answer))
        return self.answer_result

    def resolve_pane(self, pane_id: str) -> str:
        return "" if pane_id in self.gone else self.aliases.get(pane_id, pane_id)

    async def broadcast(self, event_type: str, payload: dict[str, Any]) -> None:
        self.events.append((event_type, payload))

    async def read_secret(self, name: str) -> str | None:
        return self.secrets.get(name)

    async def write_secret(self, name: str, secret: str | None) -> None:
        self.secrets[name] = secret

    def seams(self) -> Seams:
        return Seams(deliver=self.deliver, await_verdict=self.await_verdict, interrupt=self.interrupt,
                     pane_state=self.pane_state, awaiting_info=self.awaiting_info, answer=self.answer,
                     resolve_pane=self.resolve_pane, broadcast=self.broadcast,
                     read_secret=self.read_secret, write_secret=self.write_secret,
                     ui_settings=lambda: self.settings, pane_agent=lambda p: self.agents.get(p, ""),
                     agent_skills=lambda a: self.skills.get(a, []))


def _said(env: "Env", needle: str) -> bool:
    """Some sent message contains ``needle`` (replies now carry a source header)."""
    return any(needle in t for t in env.tg.texts())


async def _until(pred, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


@pytest.fixture(autouse=True)
def fast_timers(monkeypatch):
    monkeypatch.setattr(mgr_mod, "VERDICT_POLL_S", 0.01)
    monkeypatch.setattr(mgr_mod, "DEBOUNCE_S", 0.0)
    monkeypatch.setattr(mgr_mod, "TYPING_EVERY_S", 0.05)
    monkeypatch.setattr(mgr_mod, "STATUS_EDIT_EVERY_S", 0.05)
    monkeypatch.setattr(mgr_mod, "STATUS_EDIT_MIN_INTERVAL_S", 0.0)
    monkeypatch.setattr(mgr_mod, "AWAITING_PROBE_EVERY_S", 0.02)
    monkeypatch.setattr(mgr_mod, "STATUS_POLL_S", 0.02)
    monkeypatch.setattr(mgr_mod, "RUN_TICK_S", 0.01)


class Env:
    def __init__(self, tmp_path, clock=time.monotonic) -> None:
        self.clock = clock
        self.db = Database(tmp_path / "navide.db")
        self.store = ChannelStore(self.db)
        self.fake = FakeSeams()
        self.adapters: dict[str, FakeAdapter] = {}

        def factory_for(platform: str):
            def build(config, secret, store):
                ad = FakeAdapter(platform, secret["token"])
                ad.account = config.get("account", "default")
                self.adapters[platform if ad.account == "default" else f"{platform}:{ad.account}"] = ad
                return ad
            return build

        self.m = ChannelManager(self.store, self.fake.seams(), factory_for=factory_for, clock=clock)

    @property
    def tg(self) -> FakeAdapter:
        return self.adapters["telegram"]

    async def inbound(self, text: str, *, sender: str = "7", chat: str = "-100", thread: str = "50",
                      direct: bool = False, mid: str | None = None, platform: str = "telegram",
                      wait: bool = True, account: str = "default", callback: str = "") -> None:
        mid = mid or f"m{next(_MIDS)}"
        await self.m.handle_inbound(InboundMessage(
            platform=platform, account=account, chat_id=chat, thread_id=thread, sender_id=sender,
            sender_name="alice", text=text, message_id=mid, is_direct=direct, ts=time.time(),
            callback_data=callback))
        if wait:
            await self.m.wait_idle()

    def turn_complete(self, pane_id: str, text: str) -> None:
        # A turn ending now ended after anything already armed. On Windows, CPython < 3.13's
        # monotonic clock ticks every ~15.6 ms, so a bare clock() can equal armed_at and the
        # manager would take this for the turn that was running when the message went in.
        self.m.on_pane_activity(pane_id, {"event_type": "turn_complete", "text": text,
                                          "ts_monotonic": self.clock() + 1e-6})


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


async def _make_env(tmp_path, clock=time.monotonic) -> Env:
    e = Env(tmp_path, clock)
    await e.m.start()
    assert (await e.m.configure("telegram", {}, {"token": "tok-A"}))["ok"]
    e.store.add_allow("telegram", "7", "alice", 1)
    # Full, so the suites see everything a pane can mirror; the default is covered on its own.
    e.store.bind("pane-1", Location("telegram", "default", "-100", "50", "api"), verbosity="full")
    return e


@pytest.fixture
async def env(tmp_path):
    e = await _make_env(tmp_path)
    yield e
    await e.m.stop()
    e.db.close()


@pytest.fixture
async def clocked(tmp_path):
    clock = FakeClock()
    e = await _make_env(tmp_path, clock)
    yield e, clock
    await e.m.stop()
    e.db.close()


async def test_configure_stores_single_line_secret_and_masks(env: Env) -> None:
    assert env.fake.secrets["channel-telegram-default"] == '{"token":"tok-A"}'
    listed = env.m.list()
    tg = next(p for p in listed["platforms"] if p["platform"] == "telegram")
    assert tg["configured"] and tg["enabled"] and tg["status"]["lifecycle"] == "ready"
    assert "tok-A" not in str(listed)
    assert tg["capabilities"]["text_limit"] == 4000


async def test_stranger_dm_gets_pairing_code_group_stranger_dropped(env: Env) -> None:
    await env.inbound("hi", sender="99", chat="99", thread="", direct=True)
    assert "配對" in env.tg.texts()[-1]
    code = env.store.list_pairing("telegram")[0].code
    assert f"{code[:4]}-{code[4:]}" in env.tg.texts()[-1]
    assert ("channels.pairing_request", {"platform": "telegram", "account": "default", "code": code,
                                         "sender_name": "alice"}) in env.fake.events
    sent_before = len(env.tg.sent)
    await env.inbound("hi from group", sender="98")
    assert len(env.tg.sent) == sent_before and env.fake.delivered == []
    assert len(env.store.list_pairing("telegram")) == 1
    # Approval lets the sender through and notifies them.
    assert (await env.m.pairing_approve("telegram", code))["ok"]
    assert env.tg.sent[-1][1].startswith("✅")
    env.store.bind("pane-dm", Location("telegram", "default", "99", ""))
    await env.inbound("now allowed", sender="99", chat="99", thread="", direct=True)
    assert env.fake.delivered[-1] == ("pane-dm", "now allowed", "telegram:alice")


async def test_dedup_by_message_id(env: Env) -> None:
    await env.inbound("once", mid="same")
    await env.inbound("once", mid="same")
    assert len(env.fake.delivered) == 1


@pytest.mark.parametrize("word", ["stop", "停止", "/stop", "ESC", "/stop@navide_bot"])
async def test_stop_words_interrupt_instead_of_delivering(env: Env, word: str) -> None:
    await env.inbound(word)
    assert env.fake.interrupts == ["pane-1"] and env.fake.delivered == []
    assert env.tg.texts()[-1] == MSG_INTERRUPTED


async def test_binding_routing_and_unbound_topic(env: Env) -> None:
    env.store.bind("pane-2", Location("telegram", "default", "-100", "51", "web"))
    await env.inbound("to one", thread="50")
    await env.inbound("to two", thread="51")
    assert [d[0] for d in env.fake.delivered] == ["pane-1", "pane-2"]
    await env.inbound("nowhere", thread="52")
    assert env.tg.texts()[-1] == MSG_NOT_BOUND and len(env.fake.delivered) == 2


async def test_alias_follows_rebuilt_pane(env: Env) -> None:
    env.fake.aliases["pane-1"] = "pane-1b"
    await env.inbound("hello")
    assert env.fake.delivered[-1][0] == "pane-1b"
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1b"]


async def test_outbound_after_turn_complete_only(env: Env) -> None:
    await env.inbound("do it")
    # Still queued: a turn ending now is the one the message is waiting behind. It is
    # not this message's reply, but the bound chat still hears it, from the keyboard.
    env.turn_complete("pane-1", "not the reply")
    await _until(lambda: "✅ 完成 · 🖥 本機\nnot the reply" in env.tg.texts())
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    env.turn_complete("pane-1", "the **answer**")
    await _until(lambda: "✅ 完成 · 💬 alice\nthe **answer**" in env.tg.texts())
    loc = next(loc for loc, t in env.tg.sent if t.endswith("the **answer**"))
    assert (loc.chat_id, loc.thread_id) == ("-100", "50")
    assert any(text.startswith("✅") for _, text in env.tg.edits)
    assert env.tg.typing >= 1
    # A later turn with no new message is relayed too, as a local turn.
    env.turn_complete("pane-1", "unsolicited")
    await _until(lambda: "✅ 完成 · 🖥 本機\nunsolicited" in env.tg.texts())


async def test_long_reply_is_chunked(env: Env) -> None:
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    env.turn_complete("pane-1", "\n".join("x" * 99 for _ in range(100)))
    await _until(lambda: sum(1 for t in env.tg.texts() if "xxx" in t) == 3)


async def test_busy_pane_gets_received_status_message(env: Env) -> None:
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "running"}
    await env.inbound("queued please")
    assert env.tg.texts()[-1] == MSG_RECEIVED_BUSY
    status_id = str(len(env.tg.sent))
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: any(mid == status_id and t == MSG_WORKING for mid, t in env.tg.edits))
    assert env.tg.texts().count(MSG_WORKING) == 0  # edited in place, not re-sent


async def test_status_edits_stop_after_three_failures(env: Env) -> None:
    await env.inbound("go")
    env.tg.fail_edits = True
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await asyncio.sleep(0.4)
    assert len(env.tg.edits) == 3


async def test_delivery_failure_posts_notice(env: Env) -> None:
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "failed", "reason": "pane-closed"}
    await _until(lambda: any("pane-closed" in t for t in env.tg.texts()))


async def test_held_gone_posts_notice(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "HOLD_FAILURE_AFTER_S", 0.0)
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "queued", "hold": {"key": "gone"}}
    await _until(lambda: any("gone" in t for t in env.tg.texts()))
    await asyncio.sleep(0.05)
    assert sum("gone" in t for t in env.tg.texts()) == 1


async def test_awaiting_posts_relay_prompt_once(env: Env) -> None:
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "awaiting"}
    env.fake.kind = "question"
    env.fake.options = ["Keep", "Discard"]
    await _until(lambda: any(t.startswith("⏸ pane 需要確認（question）") for t in env.tg.texts()))
    await asyncio.sleep(0.1)
    assert sum(t.startswith("⏸ pane 需要確認") for t in env.tg.texts()) == 1


async def test_kill_switch_stops_everything(env: Env) -> None:
    await env.m.set_global_enabled(False)
    assert env.tg.status.lifecycle == "stopped"
    assert env.m.list()["enabled"] is False
    await env.inbound("ignored")
    assert env.fake.delivered == []
    await env.m.set_global_enabled(True)
    assert env.adapters["telegram"].status.lifecycle == "ready"


async def test_same_token_is_refused_on_second_platform(env: Env) -> None:
    result = await env.m.configure("discord", {}, {"token": "tok-A"})
    assert not result["ok"] and "telegram" in result["error"]
    assert "channel-discord" not in env.fake.secrets
    assert (await env.m.configure("discord", {}, {"token": "tok-B"}))["ok"]


async def test_pane_unregister_keeps_binding(env: Env) -> None:
    # Unregister also means rebuild / detach / workspace switch: never unbind here.
    env.m.on_pane_activity("pane-1", None)
    await asyncio.sleep(0.05)
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1"]


async def test_bind_new_creates_topic_and_status_broadcast(env: Env) -> None:
    result = await env.m.bind("pane-9", "api-refactor", "telegram", "new", "-100")
    assert result["ok"] and result["binding"]["thread_id"] == "77"
    assert result["binding"]["title"] == "api-refactor"
    await _until(lambda: any(e == "channels.status" and p["platform"] == "telegram" for e, p in env.fake.events))


async def test_remove_platform_clears_secret_and_bindings(env: Env) -> None:
    await env.m.remove("telegram")
    assert env.fake.secrets["channel-telegram-default"] is None
    assert env.store.bindings() == [] and env.store.list_allow(None) == []
    assert env.tg.status.lifecycle == "stopped"


async def test_queue_cap_per_pane(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "MAX_QUEUED_PER_PANE", 2)
    for i in range(3):
        await env.inbound(f"m{i}")
    assert len(env.fake.delivered) == 2 and "排隊" in env.tg.texts()[-1]


async def test_second_message_queued_behind_first_turn_still_gets_its_reply(env: Env) -> None:
    await env.inbound("first")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    await env.inbound("second")  # sits in the pane's queue behind turn 1
    await asyncio.sleep(0.05)
    env.turn_complete("pane-1", "reply one")
    await _until(lambda: _said(env, "reply one"))
    env.fake.verdicts["k2"] = {"status": "delivered"}  # now injected
    await asyncio.sleep(0.05)
    env.turn_complete("pane-1", "reply two")
    await _until(lambda: _said(env, "reply two"))


async def test_second_message_not_rearmed_after_unbind(env: Env) -> None:
    await env.inbound("first")
    await env.m.unbind("pane-1")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await asyncio.sleep(0.05)
    env.turn_complete("pane-1", "orphan reply")
    await asyncio.sleep(0.05)
    assert "orphan reply" not in env.tg.texts()


async def test_unbind_tells_the_chat_it_was_disconnected(env: Env) -> None:
    await env.m.unbind("pane-1", pane_name="api-refactor")
    await _until(lambda: any(t.startswith("🔌") for t in env.tg.texts()))
    assert "🔌 這個聊天室已和 pane「api-refactor」中斷連接，之後的訊息不會再送進 pane。" in env.tg.texts()
    assert env.store.bindings() == []


async def test_bind_tells_the_chat_which_pane_it_drives(env: Env) -> None:
    await env.m.unbind("pane-1")
    res = await env.m.bind("pane-2", "api-refactor", "telegram", "existing", "-100", "50")
    assert res["ok"] is True
    await _until(lambda: any(t.startswith("🔗") for t in env.tg.texts()))
    assert "🔗 已連接 pane「api-refactor」，在這裡傳的訊息會送進這個 pane；傳 stop 可以中斷。" in env.tg.texts()


async def test_unbind_on_close_says_the_pane_closed(env: Env) -> None:
    await env.m.unbind("pane-1", reason="closed", pane_name="api-refactor")
    await _until(lambda: any(t.startswith("🔌") for t in env.tg.texts()))
    assert "🔌 pane「api-refactor」已關閉，這個聊天室已中斷連接。" in env.tg.texts()


async def test_unbind_of_an_unbound_pane_posts_nothing(env: Env) -> None:
    await env.m.unbind("no-such-pane")
    await asyncio.sleep(0.05)
    assert not any(t.startswith("🔌") for t in env.tg.texts())


async def test_seen_chats_survive_a_restart(env: Env, tmp_path) -> None:
    await env.inbound("hi", chat="-200", thread="")
    assert [c["chat_id"] for c in env.m.locations("telegram")["locations"]] == ["-200"]
    # A fresh manager over the same database (a backend restart) still lists it.
    again = ChannelManager(ChannelStore(env.db), env.fake.seams(),
                           factory_for=lambda _p: lambda _c, secret, _s: FakeAdapter("telegram", secret["token"]))
    await again.start()
    try:
        assert [c["chat_id"] for c in again.locations("telegram")["locations"]] == ["-200"]
    finally:
        await again.stop()


async def test_a_new_bot_token_does_not_offer_the_old_bots_chats(env: Env) -> None:
    await env.inbound("hi", chat="-200", thread="")
    assert (await env.m.configure("telegram", {}, {"token": "tok-B"}))["ok"]
    assert env.m.locations("telegram")["locations"] == []
    # Switching back offers them again: nothing was thrown away.
    assert (await env.m.configure("telegram", {}, {"token": "tok-A"}))["ok"]
    assert [c["chat_id"] for c in env.m.locations("telegram")["locations"]] == ["-200"]


async def test_bind_and_unbind_notices_keep_their_order(env: Env) -> None:
    await env.m.unbind("pane-1")
    await _until(lambda: any(t.startswith("🔌") for t in env.tg.texts()))
    env.tg.sent.clear()
    real = env.tg.send_text

    async def slow_bound(loc, text, **kw):
        if text.startswith("🔗"):
            await asyncio.sleep(0.05)  # the platform is slow on the first one
        return await real(loc, text, **kw)
    env.tg.send_text = slow_bound
    assert (await env.m.bind("pane-2", "b", "telegram", "existing", "-100", "50"))["ok"]
    await env.m.unbind("pane-2")
    await _until(lambda: len(env.tg.texts()) == 2)
    assert [t[0] for t in env.tg.texts()] == ["🔗", "🔌"]


async def test_a_chat_held_by_a_closed_pane_can_be_taken(env: Env) -> None:
    # pane-1 closed without its unbind reaching the backend (renderer crash,
    # backend down): its binding must not lock the chat away for good.
    env.fake.gone.add("pane-1")
    res = await env.m.bind("pane-2", "b", "telegram", "existing", "-100", "50")
    assert res["ok"] is True
    assert [b.pane_id for b in env.store.bindings()] == ["pane-2"]


async def test_a_failed_seen_chat_write_still_delivers_the_message(env: Env, monkeypatch) -> None:
    def boom(*_a, **_k):
        raise sqlite3.OperationalError("database is locked")
    monkeypatch.setattr(env.store, "remember_chat", boom)
    await env.inbound("do the thing")
    assert [t for _, t, _ in env.fake.delivered] == ["do the thing"]


async def test_a_failed_seen_chat_write_does_not_fail_an_approval(env: Env, monkeypatch) -> None:
    await env.inbound("hello", sender="99", chat="99", thread="", direct=True)
    code = env.store.list_pairing("telegram")[0].code

    def boom(*_a, **_k):
        raise sqlite3.OperationalError("database is locked")
    monkeypatch.setattr(env.store, "remember_chat", boom)
    res = await env.m.pairing_approve("telegram", code)
    assert res["ok"] is True
    assert env.store.is_allowed("telegram", "99")


async def test_a_failed_bind_notice_keeps_the_binding_and_is_not_retried(env: Env) -> None:
    await env.m.unbind("pane-1")
    await _until(lambda: any(t.startswith("🔌") for t in env.tg.texts()))
    calls = 0

    async def failing(loc, text, **kw):
        nonlocal calls
        calls += 1
        raise RuntimeError("429 Too Many Requests")
    env.tg.send_text = failing
    assert (await env.m.bind("pane-2", "b", "telegram", "existing", "-100", "50"))["ok"] is True
    await asyncio.sleep(0.1)
    assert calls == 1
    assert [b.pane_id for b in env.store.bindings()] == ["pane-2"]


async def test_a_newly_seen_chat_announces_a_change_once(env: Env) -> None:
    env.fake.events.clear()
    await env.inbound("hi", chat="-300", thread="")
    await env.inbound("again", chat="-300", thread="")
    assert [e for e, _ in env.fake.events].count("channels.changed") == 1


async def test_approved_pairing_lists_the_dm_without_another_message(env: Env) -> None:
    await env.inbound("hello", sender="99", chat="99", thread="", direct=True)
    code = env.store.list_pairing("telegram")[0].code
    await env.m.pairing_approve("telegram", code)
    locs = env.m.locations("telegram")["locations"]
    assert {"chat_id": "99", "kind": "direct"}.items() <= next(c for c in locs if c["chat_id"] == "99").items()


async def test_a_chat_held_by_another_pane_is_refused_until_released(env: Env) -> None:
    # pane-1 holds telegram -100 / thread 50 (fixture); pane-2 must not take it silently.
    res = await env.m.bind("pane-2", "b", "telegram", "existing", "-100", "50")
    assert res["ok"] is False and res["holder_pane_id"] == "pane-1"
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1"]
    await env.m.unbind("pane-1")
    res = await env.m.bind("pane-2", "b", "telegram", "existing", "-100", "50")
    assert res["ok"] is True
    assert [b.pane_id for b in env.store.bindings()] == ["pane-2"]


async def test_running_watch_is_capped_but_late_reply_still_sent(clocked) -> None:
    env, clock = clocked
    await env.inbound("long job")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    pending = env.m._pending["pane-1"]
    clock.t += mgr_mod.RUN_WATCH_MAX_S + 1
    # The task lives on to probe for an awaiting prompt; only the indicators stop.
    await _until(lambda: env.tg.edits and env.tg.edits[-1][1] == mgr_mod.MSG_STILL_RUNNING)
    typing, edits = env.tg.typing, len(env.tg.edits)
    clock.t += 60
    await asyncio.sleep(0.1)
    assert (env.tg.typing, len(env.tg.edits)) == (typing, edits)  # indicators stopped
    env.turn_complete("pane-1", "finally")
    await _until(lambda: _said(env, "finally"))


async def test_running_status_edits_carry_no_elapsed_seconds(clocked) -> None:
    env, clock = clocked
    await env.inbound("long job")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    clock.t += mgr_mod.STATUS_EDIT_EVERY_S + 1
    await _until(lambda: env.tg.edits)
    assert {text for _, text in env.tg.edits} == {MSG_WORKING}


async def test_pane_close_drops_pending_and_its_task(env: Env) -> None:
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    task = env.m._pending["pane-1"].task
    env.m.on_pane_activity("pane-1", None)
    assert "pane-1" not in env.m._pending
    await _until(lambda: task.done())
    assert task.cancelled()
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1"]


# --- round 2 -------------------------------------------------------------------


async def test_offline_pane_gets_notice_and_keeps_binding(env: Env) -> None:
    env.fake.gone.add("pane-1")
    await env.inbound("hello?")
    assert env.tg.texts()[-1] == mgr_mod.MSG_OFFLINE
    assert env.fake.delivered == [] and len(env.store.bindings()) == 1
    env.fake.gone.clear()
    await env.inbound("back")
    assert env.fake.delivered[-1][0] == "pane-1"


async def test_rebind_moves_binding_and_running_watch(env: Env) -> None:
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    result = await env.m.rebind("pane-1", "pane-1n")
    assert result["ok"] and result["binding"]["pane_id"] == "pane-1n"
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1n"]
    env.turn_complete("pane-1n", "reply after rebuild")
    await _until(lambda: _said(env, "reply after rebuild"))
    assert await env.m.rebind("nobody", "x") == {"ok": True}


async def test_bind_refuses_unknown_pane_but_accepts_placeholder(env: Env) -> None:
    env.fake.gone.add("ghost")
    assert await env.m.bind("ghost", "g", "telegram", "existing", "-100", "60") == {
        "ok": False, "error": "pane not found"}
    # A restore placeholder is registered, so it resolves (the fake knows every non-gone id).
    result = await env.m.bind("placeholder-1", "p", "telegram", "existing", "-100", "61")
    assert result["ok"] and result["binding"]["pane_id"] == "placeholder-1"


async def test_debounce_joins_quick_lines_but_not_stop_words(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "DEBOUNCE_S", 0.3)
    await env.inbound("line one", wait=False)
    await env.inbound("line two", wait=False)
    await env.inbound("stop", wait=False)  # bypasses the buffer
    await _until(lambda: env.fake.interrupts == ["pane-1"])
    assert env.fake.delivered == []
    await env.m.wait_idle()
    assert env.fake.delivered == [("pane-1", "line one\nline two", "telegram:alice")]
    # Another sender / later message is its own delivery.
    env.store.add_allow("telegram", "8", "bob", 1)
    await env.inbound("from bob", sender="8")
    await env.inbound("later")
    await _until(lambda: len(env.fake.delivered) == 3)
    assert [d[1] for d in env.fake.delivered[1:]] == ["from bob", "later"]


async def _awaiting(env: Env, *, stale_off_config: bool = False) -> None:
    # The relay is always on; a stale ``permission_relay: false`` must not turn it off.
    if stale_off_config:
        env.store.upsert_account("telegram", {"permission_relay": False})
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "awaiting"}


def _relay_id(env: Env) -> str:
    return next(iter(env.m.relay._by_id))


async def _until_relay_prompt(env: Env) -> None:
    # The relay registers its id before the prompt is sent, so waiting on the id
    # alone lets a slow runner assert (or send the next message) before the
    # prompt has reached the chat. Wait for the prompt itself.
    await _until(lambda: env.m.relay._by_id and any(t.startswith("⏸") for t in env.tg.texts()))


async def test_stale_relay_off_config_is_ignored(env: Env) -> None:
    await _awaiting(env, stale_off_config=True)
    await _until(lambda: any(t.startswith("⏸ pane 需要確認") for t in env.tg.texts()))
    assert env.m.relay._by_id != {}
    assert "⏸ pane 等待確認（permission）" not in env.tg.texts()


async def test_relay_on_prompt_buttons_and_yes(env: Env) -> None:
    import re

    await _awaiting(env)
    await _until(lambda: any(t.startswith("⏸ pane 需要確認") for t in env.tg.texts()))
    rid = _relay_id(env)
    assert re.fullmatch(r"[a-km-z]{5}", rid)
    text = next(t for t in env.tg.texts() if t.startswith("⏸"))
    assert "Allow Bash(npm run build)?" in text and f"yes {rid} / no {rid}" in text
    delivered_before = len(env.fake.delivered)
    await env.inbound(f"YES {rid}")
    assert env.fake.answers == [("pane-1", {"kind": "permission", "choice": "allow"})]
    assert env.tg.texts()[-1] == "✅ 已送出：允許"
    assert len(env.fake.delivered) == delivered_before  # answered before the queue
    await env.inbound(f"no {rid}")  # single use
    assert env.tg.texts()[-1] == mgr_mod.MSG_RELAY_EXPIRED and len(env.fake.answers) == 1


async def test_relay_buttons_via_callback_and_question_option(env: Env) -> None:
    env.fake.kind = "question"
    env.fake.options = ["Keep", "Discard"]
    sent_buttons: list = []
    orig = env.tg.send_text

    async def capture(loc, text, *, buttons=None):
        if buttons:
            sent_buttons.append(buttons)
        return await orig(loc, text, buttons=buttons)

    env.tg.send_text = capture
    await _awaiting(env)
    await _until(lambda: sent_buttons)
    rid = _relay_id(env)
    assert sent_buttons[0] == [("1. Keep", f"nv1:{rid}:1"), ("2. Discard", f"nv1:{rid}:2")]
    assert all(len(data.encode()) <= 64 for _, data in sent_buttons[0])
    await env.m.handle_inbound(InboundMessage(
        platform="telegram", account="default", chat_id="-100", thread_id="50", sender_id="7",
        sender_name="alice", text="", message_id="cb:1", is_direct=False, ts=time.time(),
        callback_data=f"nv1:{rid}:2"))
    await env.m.wait_idle()
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 2})]
    assert env.tg.texts()[-1] == "✅ 已送出：選項 2"


async def test_relay_rejects_stranger_and_reports_seam_error(env: Env) -> None:
    await _awaiting(env)
    await _until_relay_prompt(env)
    rid = _relay_id(env)
    await env.inbound(f"yes {rid}", sender="99")  # not allowlisted: dropped by the gate
    assert env.fake.answers == [] and rid in env.m.relay._by_id
    env.fake.answer_result = {"ok": False, "error": "unsupported for aider"}
    await env.inbound(f"y {rid}")
    assert env.tg.texts()[-1] == "⚠️ 送出失敗：unsupported for aider"


async def test_relay_id_expires_when_pane_leaves_awaiting_or_ttl(clocked, monkeypatch) -> None:
    env, clock = clocked
    await _awaiting(env)
    clock.t += 1  # the fake clock only moves when told: let the awaiting probe run
    await _until_relay_prompt(env)
    rid = _relay_id(env)
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "running"}
    clock.t += 1  # let the probe run again
    await _until(lambda: env.m.relay._by_id == {})
    await env.inbound(f"yes {rid}")
    assert env.tg.texts()[-1] == mgr_mod.MSG_RELAY_EXPIRED
    # TTL
    req = env.m.relay.create("pane-1", "permission", [], Location("telegram", "default", "-100", "50"))
    clock.t += 1801
    await env.inbound(f"yes {req.id}")
    assert env.tg.texts()[-1] == mgr_mod.MSG_RELAY_EXPIRED and env.fake.answers == []


def _prompt_message(env: Env) -> tuple[str, str]:
    """(message id, text) of the relay prompt the FakeAdapter sent last."""
    i = max(n for n, t in enumerate(env.tg.texts()) if t.startswith("⏸"))
    return str(i + 1), env.tg.texts()[i]


async def test_relay_prompt_is_settled_when_the_pane_leaves_awaiting(clocked) -> None:
    # Answered or skipped at the keyboard: the chat's prompt must say so and drop
    # its buttons (an edit replaces the message), not wait to be pressed and fail.
    env, clock = clocked
    await _awaiting(env)
    clock.t += 1
    await _until_relay_prompt(env)
    mid, text = _prompt_message(env)
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "running"}
    clock.t += 1
    await _until(lambda: any(m == mid for m, _ in env.tg.edits))
    assert (mid, f"{text}\n\n{mgr_mod.MSG_RELAY_DONE_LOCALLY}") in env.tg.edits


async def test_relay_prompt_is_settled_when_a_new_prompt_replaces_it(clocked) -> None:
    env, clock = clocked
    env.fake.prompt = "Allow Bash(rm -rf build)?"
    await _awaiting(env)
    clock.t += 1
    await _until_relay_prompt(env)
    mid, text = _prompt_message(env)
    env.fake.prompt = "Allow Bash(npm publish)?"
    clock.t += mgr_mod.AWAITING_PROBE_EVERY_S + 1
    await _until(lambda: any(m == mid for m, _ in env.tg.edits))
    assert (mid, f"{text}\n\n{mgr_mod.MSG_RELAY_SUPERSEDED}") in env.tg.edits


async def test_relay_prompt_is_settled_when_the_turn_ends(env: Env) -> None:
    await _awaiting(env)
    await _until_relay_prompt(env)
    mid, text = _prompt_message(env)
    env.turn_complete("pane-1", "done")
    await _until(lambda: any(m == mid for m, _ in env.tg.edits))
    assert (mid, f"{text}\n\n{mgr_mod.MSG_RELAY_TURN_ENDED}") in env.tg.edits


async def test_relay_prompt_answered_from_the_chat_is_settled(env: Env) -> None:
    await _awaiting(env)
    await _until_relay_prompt(env)
    mid, text = _prompt_message(env)
    await env.inbound(f"yes {_relay_id(env)}")
    assert env.tg.texts()[-1] == "✅ 已送出：允許"
    await _until(lambda: any(m == mid for m, _ in env.tg.edits))
    assert (mid, f"{text}\n\n{mgr_mod.MSG_RELAY_ANSWERED_IN_CHAT}允許") in env.tg.edits


async def test_relay_prompt_answered_against_a_stale_screen_is_settled(env: Env) -> None:
    env.fake.prompt = "Allow Bash(rm -rf build)?"
    await _awaiting(env)
    await _until_relay_prompt(env)
    mid, text = _prompt_message(env)
    rid = _relay_id(env)
    env.fake.prompt = "Allow Bash(npm publish)?"
    await env.inbound(f"yes {rid}")
    assert env.fake.answers == [] and mgr_mod.MSG_RELAY_EXPIRED in env.tg.texts()
    await _until(lambda: any(m == mid for m, _ in env.tg.edits))
    assert (mid, f"{text}\n\n{mgr_mod.MSG_RELAY_SUPERSEDED}") in env.tg.edits


def _fail_relay_sends(env: Env, times: int) -> list[int]:
    """Make the next ``times`` relay prompt sends raise; returns a one-item failure counter."""
    failed = [0]
    orig = env.tg.send_text

    async def flaky(loc, text, *, buttons=None):
        if text.startswith("⏸") and failed[0] < times:
            failed[0] += 1
            raise RuntimeError("chat unreachable")
        return await orig(loc, text, buttons=buttons)

    env.tg.send_text = flaky
    return failed


async def test_failed_relay_prompt_is_resent_on_next_probe(env: Env) -> None:
    failed = _fail_relay_sends(env, 1)
    await _awaiting(env)
    await _until(lambda: any(t.startswith("⏸ pane 需要確認") for t in env.tg.texts()))
    await asyncio.sleep(0.1)
    assert failed[0] == 1
    assert sum(t.startswith("⏸ pane 需要確認") for t in env.tg.texts()) == 1
    assert len(env.m.relay._by_id) == 1  # only the delivered prompt's id is answerable


async def test_awaiting_info_failure_is_retried(env: Env) -> None:
    calls = [0]
    orig = env.fake.awaiting_info

    async def flaky(pane_id):
        calls[0] += 1
        if calls[0] == 1:
            raise RuntimeError("screen unreadable")
        return await orig(pane_id)

    env.m._seams.awaiting_info = flaky
    await _awaiting(env)
    await _until(lambda: any("Allow Bash(npm run build)?" in t for t in env.tg.texts()))
    await asyncio.sleep(0.1)
    assert sum(t.startswith("⏸") for t in env.tg.texts()) == 1


async def test_failed_relay_send_leaves_no_answerable_id(env: Env) -> None:
    failed = _fail_relay_sends(env, 1_000)
    await _awaiting(env)
    await _until(lambda: failed[0] >= 1)
    await asyncio.sleep(0.3)  # every retry the cap allows has run by now
    assert env.m.relay._by_id == {}
    assert failed[0] == mgr_mod.AWAITING_RETRY_MAX  # capped: no tight retry loop
    assert not any(t.startswith("⏸") for t in env.tg.texts())


# --- receive loop never waits on a slow chat ------------------------------------------


class _Gate:
    def __init__(self) -> None:
        self.release = asyncio.Event()

    async def block(self, *args, **kwargs):
        await self.release.wait()
        return {"ok": True, "sent": True, "msg_key": "kx", "pane_id": "pane-1"}


@pytest.mark.parametrize("stuck", ["interrupt", "deliver", "answer"])
async def test_stuck_seam_does_not_block_other_chats(env: Env, stuck: str) -> None:
    gate = _Gate()
    seen: list[str] = []  # texts that reached the deliver seam, stuck or not
    real_deliver = env.fake.deliver

    async def deliver(pane_id, text, from_display):
        seen.append(text)
        if stuck == "deliver":
            return await gate.block()
        return await real_deliver(pane_id, text, from_display)

    env.m._seams.deliver = deliver
    env.store.bind("pane-2", Location("telegram", "default", "-200", "", "other"))
    if stuck == "answer":
        env.store.upsert_account("telegram", {"permission_relay": True})
        req = env.m.relay.create("pane-1", "permission", [], Location("telegram", "default", "-100", "50"),
                                 prompt=env.fake.prompt)
        env.m._seams.answer = gate.block
        first = f"yes {req.id}"
    elif stuck == "interrupt":
        env.m._seams.interrupt = gate.block
        first = "stop"
    else:
        first = "slow"
    t0 = time.monotonic()
    await env.inbound(first, wait=False)  # returns at once: the receive loop stays free
    assert time.monotonic() - t0 < 0.2
    await env.inbound("side ping", chat="-200", thread="", wait=False)
    await _until(lambda: "side ping" in seen, timeout=1.0)
    gate.release.set()
    await env.m.wait_idle()


async def test_same_chat_keeps_order(env: Env) -> None:
    order: list[str] = []
    real = env.fake.deliver

    async def slow_first(pane_id, text, from_display):
        if text == "one":
            await asyncio.sleep(0.1)
        order.append(text)
        return await real(pane_id, text, from_display)

    env.m._seams.deliver = slow_first
    for text in ("one", "two", "three"):
        await env.inbound(text, wait=False)
    await env.m.wait_idle()
    assert order == ["one", "two", "three"]
    assert env.m._workers == {}  # retired once idle


async def test_stop_leaves_no_tasks(env: Env) -> None:
    gate = _Gate()
    env.m._seams.deliver = gate.block
    await env.inbound("hang", wait=False)
    await _until(lambda: env.m._workers)
    await env.m.stop()
    assert env.m._tasks == set() and env.m._workers == {}
    others = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()
              and (t.get_coro().__qualname__.startswith("ChannelManager."))]
    assert all(t.done() for t in others)


# --- restart aliases and option-based relay kind ---------------------------------------


async def test_bindings_follow_alias_after_restart(env: Env) -> None:
    env.fake.aliases["pane-1"] = "pane-1-new"  # restored pane registered with formerPaneIds
    assert [b["pane_id"] for b in env.m.bindings()["bindings"]] == ["pane-1-new"]
    await _until(lambda: ("channels.changed", {}) in env.fake.events)
    listed = env.m.list()  # already in sync: no second change
    assert listed["enabled"] and [b.pane_id for b in env.store.bindings()] == ["pane-1-new"]


async def test_first_activity_from_new_id_syncs_bindings(env: Env) -> None:
    env.fake.aliases["pane-1"] = "pane-1-new"
    env.m.on_pane_activity("pane-1-new", {"event_type": "agent_active", "text": "",
                                          "ts_monotonic": time.monotonic()})
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1-new"]


async def test_alias_sync_never_overwrites_an_existing_binding(env: Env) -> None:
    env.store.bind("pane-2", Location("telegram", "default", "-100", "51", "b"))
    env.fake.aliases["pane-1"] = "pane-2"
    env.m.bindings()
    assert sorted(b.pane_id for b in env.store.bindings()) == ["pane-1", "pane-2"]


async def test_options_not_starting_with_yes_relay_as_question(env: Env) -> None:
    env.fake.kind = "permission"  # what Claude's AskUserQuestion reports
    env.fake.options = ["Keep it", "Discard"]
    await _awaiting(env)
    await _until_relay_prompt(env)
    rid = _relay_id(env)
    text = next(t for t in env.tg.texts() if t.startswith("⏸"))
    assert "（question）" in text and "1. Keep it" in text and f"回覆 <選項編號> {rid}" in text
    await env.inbound(f"2 {rid}")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 2})]


async def test_options_starting_with_yes_relay_as_permission(env: Env) -> None:
    env.fake.kind = "question"
    env.fake.options = ["Yes", "Yes, and don't ask again", "No"]
    await _awaiting(env)
    await _until_relay_prompt(env)
    rid = _relay_id(env)
    assert f"yes {rid} / no {rid}" in next(t for t in env.tg.texts() if t.startswith("⏸"))
    await env.inbound(f"no {rid}")
    assert env.fake.answers == [("pane-1", {"kind": "permission", "choice": "deny"})]


async def test_permanent_allow_option_is_neither_offered_nor_accepted(env: Env) -> None:
    env.fake.kind = "question"
    env.fake.options = ["Run it once", "Always allow Bash(rm:*)", "Cancel"]
    sent_buttons: list = []
    orig = env.tg.send_text

    async def capture(loc, text, *, buttons=None):
        if buttons:
            sent_buttons.append(buttons)
        return await orig(loc, text, buttons=buttons)

    env.tg.send_text = capture
    await _awaiting(env)
    await _until(lambda: sent_buttons)
    rid = _relay_id(env)
    # Offered options keep their on-screen numbers; the permanent one is left out.
    assert sent_buttons[0] == [("1. Run it once", f"nv1:{rid}:1"), ("3. Cancel", f"nv1:{rid}:3")]
    text = next(t for t in env.tg.texts() if t.startswith("⏸"))
    assert "2. Always allow" not in text and "3. Cancel" in text
    await env.inbound(f"2 {rid}")
    assert env.fake.answers == []
    assert env.tg.texts()[-1] == mgr_mod.MSG_RELAY_PERMANENT


async def test_yes_refused_when_option_one_is_permanent_allow(env: Env) -> None:
    env.fake.options = ["Yes, and don't ask again this session", "No"]
    sent_buttons: list = []
    orig = env.tg.send_text

    async def capture(loc, text, *, buttons=None):
        if buttons:
            sent_buttons.append(buttons)
        return await orig(loc, text, buttons=buttons)

    env.tg.send_text = capture
    await _awaiting(env)
    await _until(lambda: sent_buttons)
    rid = _relay_id(env)
    assert sent_buttons[0] == [("拒絕", f"nv1:{rid}:n")]
    await env.inbound(f"yes {rid}")
    assert env.fake.answers == []
    assert env.tg.texts()[-1] == mgr_mod.MSG_RELAY_PERMANENT


# --- MSG blocks addressed to the chat sender ------------------------------------

async def _armed(env: Env) -> None:
    await env.inbound("question")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())


async def test_msg_reply_to_the_chat_posts_only_its_body(env: Env) -> None:
    await _armed(env)
    env.turn_complete("pane-1", "Thinking it over.\n"
                      "---MSG-START--- to: telegram:alice re: k1\nthe answer\n---MSG-END---")
    await _until(lambda: _said(env, "the answer"))
    reply = next(t for t in env.tg.texts() if "the answer" in t)
    assert "MSG-START" not in reply and "MSG-END" not in reply and "to:" not in reply
    assert not _said(env, "Thinking it over.")


async def test_failed_msg_reply_falls_back_to_the_whole_turn(env: Env, caplog) -> None:
    await _armed(env)
    real = env.tg.send_text

    async def flaky(loc, text, **kw):
        if text.endswith("the answer") and "Intro line" not in text:  # only the MSG body's post fails
            raise RuntimeError("chat is gone")
        return await real(loc, text, **kw)

    env.tg.send_text = flaky
    env.turn_complete("pane-1", "Intro line\n---MSG-START--- to: telegram:alice\nthe answer\n---MSG-END---")
    await _until(lambda: _said(env, "Intro line\nthe answer"))
    assert "MSG reply to telegram:default:-100:50 failed" in caplog.text
    assert not any("MSG-" in t for t in env.tg.texts())


async def test_turn_without_a_chat_msg_posts_its_text_without_markers(env: Env) -> None:
    await _armed(env)
    env.turn_complete("pane-1", "Report\n---MSG-START--- to: reviewer\nplease review\n---MSG-END---")
    await _until(lambda: _said(env, "Report\nplease review"))
    assert not any("MSG-" in t for t in env.tg.texts())


async def test_msg_to_the_chat_is_posted_even_at_replies_level(env: Env) -> None:
    env.store.set_verbosity("pane-1", "replies")
    env.turn_complete("pane-1", "local turn, not mirrored")
    env.turn_complete("pane-1", "---MSG-START--- to: telegram:alice\nheads up\n---MSG-END---")
    await _until(lambda: _said(env, "heads up"))
    assert not _said(env, "local turn, not mirrored")


async def test_msg_reply_with_the_platform_offline_is_only_logged(env: Env, caplog) -> None:
    await _armed(env)
    sent = len(env.tg.sent)
    await env.m.set_enabled("telegram", False)
    env.turn_complete("pane-1", "---MSG-START--- to: telegram:alice\nlost\n---MSG-END---")
    await _until(lambda: "MSG reply for telegram:default:-100:50 dropped" in caplog.text)
    assert len(env.tg.sent) == sent and env.fake.delivered == [("pane-1", "question", "telegram:alice")]


# --- several bots per platform ----------------------------------------------------

async def _second_bot(env: Env, account: str = "bot-b1", token: str = "tok-B") -> FakeAdapter:
    res = await env.m.configure("telegram", {"name": "Ops bot"}, {"token": token}, account)
    assert res["ok"], res
    return env.adapters[f"telegram:{account}"]


async def test_second_bot_runs_beside_the_first_with_its_own_secret(env: Env) -> None:
    b = await _second_bot(env)
    assert env.fake.secrets["channel-telegram-bot-b1"] == '{"token":"tok-B"}'
    assert env.fake.secrets["channel-telegram-default"] == '{"token":"tok-A"}'
    assert env.tg.status.lifecycle == "ready" and b.status.lifecycle == "ready"
    tg = next(p for p in env.m.list()["platforms"] if p["platform"] == "telegram")
    assert [(a["account"], a["name"], a["enabled"]) for a in tg["accounts"]] == [
        ("default", "", True), ("bot-b1", "Ops bot", True)]
    assert tg["status"]["lifecycle"] == "ready" and "tok-B" not in str(tg)


async def test_one_token_cannot_serve_two_bots(env: Env) -> None:
    res = await env.m.configure("telegram", {}, {"token": "tok-A"}, "bot-b1")
    assert not res["ok"] and "telegram" in res["error"]
    assert "channel-telegram-bot-b1" not in env.fake.secrets


async def test_inbound_on_bot_b_never_reaches_a_pane_bound_through_bot_a(env: Env) -> None:
    b = await _second_bot(env)
    env.store.add_allow("telegram", "7", "alice", 1, "bot-b1")
    # Same chat and topic as pane-1's binding, but through the other bot: not bound
    # through it, and with two bots it stays silent.
    await env.inbound("for bot B", account="bot-b1")
    assert env.fake.delivered == [] and b.texts() == [] and MSG_NOT_BOUND not in env.tg.texts()
    env.store.bind("pane-2", Location("telegram", "bot-b1", "-100", "50", "ops"), verbosity="full")
    await env.inbound("for bot B again", account="bot-b1")
    await env.inbound("for bot A")
    assert [(d[0], d[1]) for d in env.fake.delivered] == [("pane-2", "for bot B again"), ("pane-1", "for bot A")]
    # Each pane's reply goes back through the bot its chat came in on.
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in b.texts())
    env.turn_complete("pane-2", "answer from pane 2")
    await _until(lambda: any(t.endswith("answer from pane 2") for t in b.texts()))
    assert not any("answer from pane 2" in t for t in env.tg.texts())


async def test_relay_answer_through_another_bot_is_refused(env: Env) -> None:
    b = await _second_bot(env)
    env.store.add_allow("telegram", "7", "alice", 1, "bot-b1")
    await _awaiting(env)
    await _until_relay_prompt(env)
    rid = _relay_id(env)
    await env.inbound(f"yes {rid}", account="bot-b1")  # same chat and topic, wrong bot
    assert env.fake.answers == [] and b.texts()[-1] == mgr_mod.MSG_RELAY_EXPIRED


async def test_relay_answer_from_another_topic_is_refused(env: Env) -> None:
    env.store.bind("pane-2", Location("telegram", "default", "-100", "51", "web"))
    await _awaiting(env)
    await _until_relay_prompt(env)
    await env.inbound(f"yes {_relay_id(env)}", thread="51")
    assert env.fake.answers == [] and env.tg.texts()[-1] == mgr_mod.MSG_RELAY_EXPIRED


async def test_bind_through_a_chosen_bot_and_the_chat_key_includes_it(env: Env) -> None:
    b = await _second_bot(env)
    # pane-1 holds this chat through bot A; through bot B it is a different location.
    res = await env.m.bind("pane-2", "ops", "telegram", "existing", "-100", "50", account="bot-b1")
    assert res["ok"] and res["binding"]["account"] == "bot-b1"
    await _until(lambda: any("已連接 pane「ops」" in t for t in b.texts()))
    taken = await env.m.bind("pane-3", "x", "telegram", "existing", "-100", "50", account="bot-b1")
    assert not taken["ok"] and taken["holder_pane_id"] == "pane-2"
    missing = await env.m.bind("pane-3", "x", "telegram", "existing", "-100", "", account="bot-zz")
    assert not missing["ok"] and missing["error"] == "telegram/bot-zz is not connected"


async def test_removing_one_bot_keeps_the_other_and_its_allowlist(env: Env) -> None:
    b = await _second_bot(env)
    env.store.add_allow("telegram", "8", "bob", 1, "bot-b1")
    env.store.bind("pane-2", Location("telegram", "bot-b1", "-100", "50", "ops"))
    assert (await env.m.remove("telegram", "bot-b1"))["ok"]
    assert b.status.lifecycle == "stopped" and env.tg.status.lifecycle == "ready"
    assert env.fake.secrets["channel-telegram-bot-b1"] is None
    assert env.fake.secrets["channel-telegram-default"] == '{"token":"tok-A"}'
    assert [x.pane_id for x in env.store.bindings()] == ["pane-1"]
    assert list(env.store.accounts()) == [("telegram", "default")]
    assert env.store.is_allowed("telegram", "7") and not env.store.is_allowed("telegram", "8", "bot-b1")


async def test_rename_keeps_the_bot_running(env: Env) -> None:
    b = await _second_bot(env)
    assert (await env.m.rename_account("telegram", "bot-b1", "  Night shift "))["ok"]
    assert env.store.accounts()[("telegram", "bot-b1")]["config"] == {"name": "Night shift"}
    assert env.adapters["telegram:bot-b1"] is b and b.status.lifecycle == "ready"


async def test_invalid_account_ids_are_refused(env: Env) -> None:
    for bad in ("", "Bot", "a/b", "x" * 40):
        with pytest.raises(ValueError):
            await env.m.configure("telegram", {}, {"token": "tok-Z"}, bad)


async def test_default_bot_still_starts_from_the_legacy_secret_slot(tmp_path) -> None:
    e = Env(tmp_path)
    e.fake.secrets["channel-telegram"] = '{"token":"tok-old"}'  # stored before several bots
    e.store.upsert_account("telegram", {})
    await e.m.start()
    try:
        assert e.tg.token == "tok-old" and e.tg.status.lifecycle == "ready"
        # A new token goes to the new slot; the legacy one is left alone.
        assert (await e.m.configure("telegram", {}, {"token": "tok-new"}))["ok"]
        assert e.fake.secrets["channel-telegram-default"] == '{"token":"tok-new"}'
        assert e.fake.secrets["channel-telegram"] == '{"token":"tok-old"}'
        assert e.tg.token == "tok-new"
    finally:
        await e.m.stop()
        e.db.close()


async def test_approving_a_sender_on_one_bot_does_not_admit_them_on_another(env: Env) -> None:
    b = await _second_bot(env)
    await env.inbound("hi", sender="99", chat="99", thread="", direct=True, account="bot-b1")
    [req] = env.store.list_pairing("telegram")
    assert req.account == "bot-b1" and "配對" in b.texts()[-1] and env.tg.texts() == []
    assert (await env.m.pairing_approve("telegram", req.code))["ok"]
    assert b.texts()[-1].startswith("✅") and env.tg.texts() == []
    assert env.store.is_allowed("telegram", "99", "bot-b1") and not env.store.is_allowed("telegram", "99")
    # On the default bot the same sender is still a stranger: a fresh pairing code there.
    await env.inbound("hi", sender="99", chat="99", thread="", direct=True)
    assert "配對" in env.tg.texts()[-1] and env.fake.delivered == []
    # And a group message from them through the default bot is dropped.
    await env.inbound("in the group", sender="99")
    assert env.fake.delivered == []


async def test_a_link_code_only_works_on_the_bot_that_issued_it(env: Env) -> None:
    b = await _second_bot(env)
    code = env.m.link_create("telegram", "direct", "bot-b1")["code"]
    await env.inbound(f"/start {code}", sender="99", chat="99", thread="", direct=True)
    assert not env.store.is_allowed("telegram", "99")  # the default bot does not know it
    await env.inbound(f"/start {code}", sender="99", chat="99", thread="", direct=True, account="bot-b1")
    assert env.store.is_allowed("telegram", "99", "bot-b1") and not env.store.is_allowed("telegram", "99")
    assert any("已連結" in t for t in b.texts())


@pytest.mark.parametrize("chat,thread", [("-100", "52"), ("-100", ""), ("-555", "")],
                         ids=["unbound topic", "General topic", "unbound chat"])
async def test_a_sole_bot_still_says_the_topic_is_not_bound(env: Env, chat: str, thread: str) -> None:
    await env.inbound("anyone?", chat=chat, thread=thread)
    assert env.tg.texts()[-1] == MSG_NOT_BOUND and env.fake.delivered == []
    loc = env.tg.sent[-1][0]
    assert (loc.chat_id, loc.thread_id) == (chat, thread)


@pytest.mark.parametrize("chat,thread", [("-100", "52"), ("-100", ""), ("-555", "")],
                         ids=["unbound topic", "General topic", "unbound chat"])
async def test_with_two_bots_an_unbound_location_gets_no_notice(env: Env, chat: str, thread: str, caplog) -> None:
    import logging
    caplog.set_level(logging.INFO, logger="agent_team_backend.channels.manager")
    b = await _second_bot(env)
    env.store.add_allow("telegram", "7", "alice", 1, "bot-b1")
    await env.inbound("anyone?", chat=chat, thread=thread)
    await env.inbound("anyone?", chat=chat, thread=thread, account="bot-b1")
    assert env.tg.texts() == [] and b.texts() == [] and env.fake.delivered == []
    assert "staying silent" in caplog.text
    # A disabled second bot is not a second voice: the sole running bot answers again.
    await env.m.set_enabled("telegram", False, "bot-b1")
    await env.inbound("anyone?", chat=chat, thread=thread)
    assert env.tg.texts()[-1] == MSG_NOT_BOUND


async def test_pairing_approval_after_a_restart_goes_through_the_bot_that_got_the_request(tmp_path) -> None:
    e = await _make_env(tmp_path)
    try:
        await _second_bot(e)
        await e.inbound("hi", sender="99", chat="99", thread="", direct=True, account="bot-b1")
        code = e.store.list_pairing("telegram")[0].code
    finally:
        await e.m.stop()
    # A new manager on the same database and vault: nothing about the request is in memory.
    e2 = Env.__new__(Env)
    e2.clock, e2.db, e2.store, e2.fake, e2.adapters = e.clock, e.db, ChannelStore(e.db), e.fake, {}

    def factory_for(platform: str):
        def build(config, secret, store):
            ad = FakeAdapter(platform, secret["token"])
            ad.account = config.get("account", "default")
            e2.adapters[platform if ad.account == "default" else f"{platform}:{ad.account}"] = ad
            return ad
        return build

    e2.m = ChannelManager(e2.store, e2.fake.seams(), factory_for=factory_for)
    await e2.m.start()
    try:
        assert (await e2.m.pairing_approve("telegram", code))["ok"]
        b2 = e2.adapters["telegram:bot-b1"]
        assert b2.texts() == ["✅ 已核准，可以開始對話"] and e2.adapters["telegram"].texts() == []
        assert e2.store.is_allowed("telegram", "99", "bot-b1")
    finally:
        await e2.m.stop()
        e.db.close()


async def test_a_background_task_that_fails_is_logged_with_its_traceback(env: Env, caplog) -> None:
    async def boom() -> None:
        raise RuntimeError("background boom")

    async def forever() -> None:
        await asyncio.sleep(3600)

    caplog.set_level(logging.ERROR, logger=mgr_mod.__name__)
    failed = env.m._spawn(boom())
    cancelled = env.m._spawn(forever())
    await asyncio.sleep(0)
    cancelled.cancel()
    await asyncio.wait({failed, cancelled})
    await asyncio.sleep(0)  # done callbacks run on the next loop turn
    errors = [r for r in caplog.records if r.name == mgr_mod.__name__ and r.levelno >= logging.ERROR]
    assert len(errors) == 1  # the cancelled task is not an error
    assert errors[0].exc_info and "background boom" in str(errors[0].exc_info[1])


async def test_a_relay_prompt_that_runs_out_its_ttl_is_settled(clocked) -> None:
    env, clock = clocked
    req = env.m.relay.create("pane-1", "permission", [], Location("telegram", "default", "-100", "50"))
    req.message_id, req.message_text = "77", "⏸ Allow Bash(npm run build)?"
    clock.t += relay_mod.REQUEST_TTL_S + 1
    assert env.m.relay.get(req.id) is None  # anything that reads the table prunes it
    await _until(lambda: any(m == "77" for m, _ in env.tg.edits))
    assert ("77", f"⏸ Allow Bash(npm run build)?\n\n{mgr_mod.MSG_RELAY_EXPIRED}") in env.tg.edits
    assert env.m.relay._by_id == {}


async def test_a_relay_prompt_that_cannot_be_settled_is_a_warning(env: Env, caplog) -> None:
    caplog.set_level(logging.INFO, logger=mgr_mod.__name__)
    env.tg.fail_edits = True
    req = env.m.relay.create("pane-1", "permission", [], Location("telegram", "default", "-100", "50"))
    req.message_id = "77"
    await env.m._settle_prompt(req, mgr_mod.MSG_RELAY_SUPERSEDED)
    [record] = [r for r in caplog.records if "settling relay prompt" in r.getMessage()]
    assert record.levelno == logging.WARNING
