"""A pane that is not online: the notice, the startup grace for a restart's backlog, and
waking the pane back onto its own conversation from the chat."""

from __future__ import annotations

import asyncio
import dataclasses
from types import SimpleNamespace
from typing import Any

import pytest

import agent_team_backend.channels as channels_pkg
from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels import store as store_mod
from agent_team_backend.channels import wake
from agent_team_backend.channels.base import Capabilities, Location
from agent_team_backend.channels.manager import WAKE_BUTTONS, WAKE_CALLBACK
from agent_team_backend.channels.store import ChannelStore
from agent_team_backend.db import Database

from .test_manager import Env, FakeClock, _make_env, _until, env, fast_timers  # noqa: F401 — pytest fixtures


async def test_offline_notice_no_longer_points_at_another_workspace(env: Env) -> None:
    env.fake.gone.add("pane-1")
    await env.inbound("hello?")
    assert env.tg.texts()[-1] == mgr_mod.MSG_OFFLINE
    assert "workspace" not in mgr_mod.MSG_OFFLINE
    for lang in ("zh-TW", "en-US", "ja-JP"):
        notice = wake.text(lang, "offline")
        assert "workspace" not in notice.lower() and "工作區" not in notice


async def test_offline_notice_follows_the_navide_language(env: Env) -> None:
    env.fake.gone.add("pane-1")
    for lang in ("en-US", "ja-JP", "zh-TW"):
        env.fake.settings = {"agent-team:language": lang}
        await env.inbound("hello?")
        assert env.tg.texts()[-1] == wake.text(lang, "offline")


async def test_a_restarts_backlog_waits_for_its_pane_instead_of_being_dropped(env: Env, monkeypatch) -> None:
    # Right after a restart Telegram hands over what queued while Navide was down, before
    # the windows have registered their panes again.
    monkeypatch.setattr(mgr_mod, "STARTUP_GRACE_S", 5.0)
    monkeypatch.setattr(mgr_mod, "STARTUP_POLL_S", 0.01)
    env.fake.gone.add("pane-1")
    await env.inbound("sent while Navide was closed", wait=False)
    await asyncio.sleep(0.05)
    assert env.fake.delivered == []
    env.fake.gone.clear()  # the window is back
    await _until(lambda: bool(env.fake.delivered))
    assert env.fake.delivered[0][:2] == ("pane-1", "sent while Navide was closed")
    assert mgr_mod.MSG_OFFLINE not in env.tg.texts()


async def test_past_the_startup_grace_an_offline_pane_is_answered_at_once(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "STARTUP_GRACE_S", 5.0)
    monkeypatch.setattr(mgr_mod, "STARTUP_POLL_S", 0.01)
    env.m._started_at -= 10.0
    env.fake.gone.add("pane-1")
    await asyncio.wait_for(env.inbound("hello?"), 1.0)
    assert env.tg.texts()[-1] == mgr_mod.MSG_OFFLINE


# --- waking ---------------------------------------------------------------------


class FakeWake:
    """The wake seams: what a woken pane comes back as, and every wake asked for."""

    def __init__(self, env: Env) -> None:
        self.env = env
        self.windows = True
        self.target = {"workspace_path": "/ws", "session_id": "sess-1"}
        self.result: dict[str, Any] = {"ok": True, "pane_id": "pane-1b"}
        self.calls: list[tuple[str, str, str]] = []
        self.gate: asyncio.Event | None = None

    async def wake(self, pane_id: str, workspace_path: str, session_id: str) -> dict[str, Any]:
        self.calls.append((pane_id, workspace_path, session_id))
        if self.gate is not None:
            await self.gate.wait()
        if self.result.get("ok"):
            self.env.fake.gone.discard(self.result["pane_id"])
        return dict(self.result)

    def install(self) -> "FakeWake":
        self.env.m._seams = dataclasses.replace(
            self.env.m._seams, wake=self.wake, windows_open=lambda: self.windows,
            wake_target=lambda _pane_id: dict(self.target))
        return self


def _wakeable(env: Env) -> FakeWake:
    """pane-1 was seen online on /ws with conversation sess-1, then went offline."""
    fw = FakeWake(env).install()
    env.store.set_wake_target("pane-1", "/ws", "sess-1")
    env.fake.gone.add("pane-1")
    return fw


def _zh(key: str, **kw: Any) -> str:
    return wake.text("zh-TW", key, **kw)


async def _press_wake(env: Env, **kw: Any) -> None:
    await env.inbound("", callback=WAKE_CALLBACK, **kw)


def _no_buttons(env: Env) -> None:
    env.tg.capabilities = Capabilities(threads=True, create_location=True, edit=True, typing=True,
                                       buttons=False, text_limit=4000)


def test_v6_gives_old_bindings_no_wake_target_and_keeps_one_across_a_rename(tmp_path) -> None:
    db = Database(tmp_path / "n.db")
    for version, fn in ((1, store_mod._v1), (2, store_mod._v2), (3, store_mod._v3), (4, store_mod._v4),
                        (5, store_mod._v5)):
        db.migrate("channels", version, fn)
    with db.transaction() as cur:
        cur.execute("INSERT INTO channel_bindings (pane_id, platform, account, chat_id, thread_id, title,"
                    " created_at) VALUES ('p1', 'telegram', 'default', '-1', '5', 't', 9)")
    s = ChannelStore(db)
    assert db.schema_version("channels") == 6
    [b] = s.bindings()
    assert (b.workspace_path, b.session_id) == ("", "")
    assert s.set_wake_target("p1", "/ws", "sess-1")
    assert s.rename_pane("p1", "p2")
    [b] = s.bindings()
    assert (b.pane_id, b.workspace_path, b.session_id) == ("p2", "/ws", "sess-1")
    assert "workspace_path" not in b.public()  # the renderer's binding shape is unchanged
    db.close()


async def test_an_online_pane_records_its_workspace_and_conversation(env: Env) -> None:
    fw = FakeWake(env).install()
    await env.inbound("hello")
    [b] = env.store.bindings()
    assert (b.workspace_path, b.session_id) == ("/ws", "sess-1")
    fw.target = {"workspace_path": "/ws", "session_id": "sess-2"}  # a new conversation in the pane
    await env.inbound("again")
    assert env.store.bindings()[0].session_id == "sess-2"
    fw.target = {"workspace_path": "/ws", "session_id": ""}  # not known yet: keep the last one
    await env.inbound("and again")
    assert env.store.bindings()[0].session_id == "sess-2"


async def test_binding_a_pane_records_its_wake_target(env: Env) -> None:
    FakeWake(env).install()
    assert (await env.m.bind("pane-2", "p2", "telegram", "existing", "-100", "70"))["ok"]
    b = next(b for b in env.store.bindings() if b.pane_id == "pane-2")
    assert (b.workspace_path, b.session_id) == ("/ws", "sess-1")


async def test_a_binding_without_a_wake_target_is_only_told_as_before(env: Env) -> None:
    fw = FakeWake(env).install()
    env.fake.gone.add("pane-1")
    await env.inbound("hello?")
    assert env.tg.texts()[-1] == mgr_mod.MSG_OFFLINE
    assert env.tg.buttons.get(mgr_mod.MSG_OFFLINE) in (None, [])
    await _press_wake(env)
    assert fw.calls == []


async def test_offline_pane_offers_a_wake_and_keeps_the_message(env: Env) -> None:
    fw = _wakeable(env)
    await env.inbound("please run the tests")
    assert env.tg.texts()[-1] == _zh("offline_wake")
    assert env.tg.buttons[_zh("offline_wake")] == WAKE_BUTTONS
    assert env.fake.delivered == [] and fw.calls == []


async def test_pressing_wake_resumes_the_pane_and_sends_the_kept_message(env: Env) -> None:
    fw = _wakeable(env)
    await env.inbound("please run the tests")
    await _press_wake(env)
    assert fw.calls == [("pane-1", "/ws", "sess-1")]
    texts = env.tg.texts()
    assert _zh("waking") in texts and texts.index(_zh("waking")) < texts.index(_zh("woke_sent", count=1))
    assert env.fake.delivered[-1][:2] == ("pane-1b", "please run the tests")
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1b"]
    await env.inbound("next")  # the chat drives the woken pane from now on
    assert env.fake.delivered[-1][:2] == ("pane-1b", "next")


async def test_a_buttonless_platform_wakes_with_the_typed_command(env: Env) -> None:
    fw = _wakeable(env)
    _no_buttons(env)
    await env.inbound("hello")
    assert "/wake" in env.tg.texts()[-1]
    await env.inbound("/wake")
    assert fw.calls and env.fake.delivered[-1][:2] == ("pane-1b", "hello")


async def test_no_navide_window_is_only_explained(env: Env) -> None:
    fw = _wakeable(env)
    fw.windows = False
    await env.inbound("hello")
    assert env.tg.texts()[-1] == _zh("no_window")
    await _press_wake(env)
    assert env.tg.texts()[-1] == _zh("no_window") and fw.calls == []
    fw.windows = True
    await _press_wake(env)
    assert env.fake.delivered == []  # nothing was kept while no window could wake it


async def test_stop_on_an_offline_pane_is_not_kept(env: Env) -> None:
    fw = _wakeable(env)
    await env.inbound("stop")
    assert env.tg.texts()[-1] == _zh("offline_wake_nothing_kept")
    assert env.fake.interrupts == []
    await _press_wake(env)
    assert fw.calls and env.fake.delivered == [] and env.tg.texts()[-1] == _zh("woke")


@pytest.mark.parametrize(("result", "expected"), [
    ({"ok": False, "code": "quota", "agent": "claude", "started": False}, _zh("quota", agent="claude")),
    ({"ok": False, "code": "unknown-session-id", "started": False},
     _zh("unresumable", reason=_zh("reason_unavailable"))),
    ({"ok": False, "code": "fresh-refused", "started": True}, _zh("unresumable", reason=_zh("reason_fresh"))),
    ({"ok": False, "code": "window-not-ready", "started": True}, _zh("failed", reason=_zh("reason_window"))),
])
async def test_a_refused_wake_says_why_and_sends_nothing(env: Env, result, expected) -> None:
    fw = _wakeable(env)
    fw.result = result
    await env.inbound("hello")
    await _press_wake(env)
    assert env.tg.texts()[-1] == expected
    assert env.fake.delivered == [] and [b.pane_id for b in env.store.bindings()] == ["pane-1"]


async def test_a_wake_refused_up_front_does_not_start_the_cooldown(env: Env) -> None:
    fw = _wakeable(env)
    fw.result = {"ok": False, "code": "quota", "agent": "claude", "started": False}
    await _press_wake(env)
    await _press_wake(env)
    assert len(fw.calls) == 2


async def test_cooldown_and_daily_cap(tmp_path) -> None:
    clock = FakeClock()
    env = await _make_env(tmp_path, clock)
    try:
        fw = _wakeable(env)
        fw.result = {"ok": False, "code": "window-not-ready", "started": True}
        await _press_wake(env)
        await _press_wake(env)
        assert len(fw.calls) == 1
        assert env.tg.texts()[-1] == _zh("cooldown", wait=int(wake.COOLDOWN_S) + 1)
        for _ in range(wake.DAILY_MAX - 1):
            clock.t += wake.COOLDOWN_S
            await _press_wake(env)
        assert len(fw.calls) == wake.DAILY_MAX
        clock.t += wake.COOLDOWN_S
        await _press_wake(env)
        assert len(fw.calls) == wake.DAILY_MAX and env.tg.texts()[-1] == _zh("daily", max=wake.DAILY_MAX)
        env.m._wake_limits.today = lambda: "tomorrow"
        await _press_wake(env)
        assert len(fw.calls) == wake.DAILY_MAX + 1
    finally:
        await env.m.stop()
        env.db.close()


async def test_only_one_pane_wakes_at_a_time(env: Env) -> None:
    fw = _wakeable(env)
    env.store.bind("pane-2", Location("telegram", "default", "-100", "51", "other"))
    env.store.set_wake_target("pane-2", "/ws", "sess-2")
    env.fake.gone.add("pane-2")
    fw.gate = asyncio.Event()
    await _press_wake(env, wait=False)
    await _until(lambda: len(fw.calls) == 1)
    await _press_wake(env, thread="51", wait=False)  # wait_idle would wait for the gated wake too
    await _until(lambda: _zh("busy") in env.tg.texts())
    assert len(fw.calls) == 1
    fw.gate.set()
    await env.m.wait_idle()
    assert _zh("woke") in env.tg.texts()


async def test_a_wake_press_after_the_pane_came_back_sends_what_was_kept(env: Env) -> None:
    fw = _wakeable(env)
    await env.inbound("kept while offline")
    env.fake.gone.discard("pane-1")  # back on its own
    await _press_wake(env)
    assert env.tg.texts()[-1] == _zh("already_online") and fw.calls == []
    assert env.fake.delivered[-1][:2] == ("pane-1", "kept while offline")


async def test_a_message_while_online_drops_what_was_kept(env: Env) -> None:
    fw = _wakeable(env)
    await env.inbound("old")
    env.fake.gone.discard("pane-1")
    await env.inbound("new")
    assert [d[1] for d in env.fake.delivered] == ["new"]
    env.fake.gone.add("pane-1")
    fw.result = {"ok": True, "pane_id": "pane-1"}
    await _press_wake(env)
    assert [d[1] for d in env.fake.delivered] == ["new"]


async def test_kept_messages_expire(tmp_path) -> None:
    clock = FakeClock()
    env = await _make_env(tmp_path, clock)
    try:
        _wakeable(env)
        await env.inbound("too old")
        clock.t += wake.STASH_TTL_S + 1
        await env.inbound("fresh")
        await _press_wake(env)
        assert [d[1] for d in env.fake.delivered] == ["fresh"]
    finally:
        await env.m.stop()
        env.db.close()


def test_wake_texts_exist_in_every_language() -> None:
    keys = set(wake.STRINGS["zh-TW"])
    for lang in ("en-US", "ja-JP"):
        assert set(wake.STRINGS[lang]) == keys


# --- the real wake seam ---------------------------------------------------------


class _Record(SimpleNamespace):
    pass


@pytest.fixture
def seam(monkeypatch):
    """wake_pane against fakes for the window, the registry, the pane records and the MCP tools."""
    from agent_team_backend import agent_messaging, app, quota_failover
    from agent_team_backend.mcp_server import server as mcp

    state = SimpleNamespace(
        windows={"w1"}, records=[_Record(pane_id="old-1", agent="claude", session_id="sess-1",
                                         spawn_status="spawned", custom_name="api", auto_name="")],
        registry={}, refusal=None, exhausted=False, probe=True, opened_ws=[], placeholder_calls=[],
        placeholder={"ok": True, "reason": "opened"}, spawns=[])
    monkeypatch.setattr(app, "live_main_window_ids", lambda: set(state.windows))
    monkeypatch.setattr(app, "project_store", SimpleNamespace(
        peek=lambda ws: SimpleNamespace(panes=state.records) if ws == "/ws" else None), raising=False)
    monkeypatch.setattr(agent_messaging, "current", lambda pid: state.registry.get(pid))
    monkeypatch.setattr(mcp, "_refuse_unresumable_session", lambda *a: state.refusal)

    async def usage(agent_key):
        return {"agent": agent_key}

    monkeypatch.setattr(mcp, "_cached_usage_snapshot", usage)
    monkeypatch.setattr(quota_failover, "snapshot_exhausted", lambda snap, now=None: state.exhausted)

    async def probe(ws, timeout):
        return state.probe

    async def workspace_open(path, ctx):
        state.opened_ws.append(path)
        state.probe = True
        return {"ok": True, "path": path, "ready": True}

    async def open_placeholder(entry, *, require_resume=False):
        state.placeholder_calls.append((entry.pane_id, require_resume))
        if not state.placeholder["ok"]:
            return {**state.placeholder, "pane": entry}
        return {**state.placeholder, "pane": SimpleNamespace(pane_id="new-1", realized=True)}

    async def open_agent(agent, name, task, ctx, workspace_path="", session_id="", **kw):
        state.spawns.append((agent, name, task, workspace_path, session_id))
        return {"ok": True, "pane_id": "spawned-1"}

    monkeypatch.setattr(mcp, "_probe_window", probe)
    monkeypatch.setattr(mcp, "workspace_open", workspace_open)
    monkeypatch.setattr(mcp, "_open_placeholder", open_placeholder)
    monkeypatch.setattr(mcp, "cli_open_agent", open_agent)
    monkeypatch.setattr(channels_pkg, "_host_ctx", lambda: None)
    monkeypatch.setattr(channels_pkg, "WAKE_PANE_WAIT_S", 0.05)
    monkeypatch.setattr(channels_pkg, "WAKE_PANE_POLL_S", 0.01)
    return state


async def test_seam_refuses_up_front_without_opening_anything(seam) -> None:
    seam.windows = set()
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {
        "ok": False, "code": "no-window", "started": False}
    seam.windows = {"w1"}
    assert (await channels_pkg.wake_pane("old-1", "/ws", "sess-other"))["code"] == "no-record"
    seam.refusal = {"ok": False, "error_code": "unknown-session-id"}
    assert (await channels_pkg.wake_pane("old-1", "/ws", "sess-1"))["code"] == "unknown-session-id"
    seam.refusal = None
    seam.exhausted = True
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {
        "ok": False, "code": "quota", "agent": "claude", "started": False}
    assert seam.opened_ws == [] and seam.placeholder_calls == [] and seam.spawns == []


async def test_seam_opens_the_workspace_and_the_placeholder_onto_its_own_conversation(seam) -> None:
    seam.probe = False
    seam.registry["old-1"] = SimpleNamespace(pane_id="old-1", realized=False)
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {"ok": True, "pane_id": "new-1"}
    assert seam.opened_ws == ["/ws"] and seam.placeholder_calls == [("old-1", True)]


async def test_seam_finds_the_pane_by_its_conversation_after_a_rekey(seam) -> None:
    seam.records.append(_Record(pane_id="rekeyed-1", agent="claude", session_id="sess-1",
                                spawn_status="spawned", custom_name="api", auto_name=""))
    seam.registry["rekeyed-1"] = SimpleNamespace(pane_id="rekeyed-1", realized=True)
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {"ok": True, "pane_id": "rekeyed-1"}
    assert seam.placeholder_calls == [] and seam.spawns == []


async def test_seam_passes_on_a_window_that_would_not_resume(seam) -> None:
    seam.registry["old-1"] = SimpleNamespace(pane_id="old-1", realized=False)
    seam.placeholder = {"ok": False, "reason": "fresh-refused"}
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {
        "ok": False, "code": "fresh-refused", "started": True}


async def test_seam_opens_a_pane_onto_the_session_when_the_window_holds_none(seam) -> None:
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {"ok": True, "pane_id": "spawned-1"}
    assert seam.spawns == [("claude", "api", "", "/ws", "sess-1")]
