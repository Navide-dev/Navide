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
    await _until(lambda: (env.store.bindings()[0].workspace_path, env.store.bindings()[0].session_id)
                 == ("/ws", "sess-1"))
    fw.target = {"workspace_path": "/ws", "session_id": "sess-2"}  # a new conversation in the pane
    await env.inbound("again")
    await _until(lambda: env.store.bindings()[0].session_id == "sess-2")
    fw.target = {"workspace_path": "/ws", "session_id": ""}  # not known yet: keep the last one
    await env.inbound("and again")
    await asyncio.sleep(0.05)
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
    notice = _zh("offline_wake", max=wake.STASH_MAX, minutes=int(wake.STASH_TTL_S // 60))
    assert env.tg.texts()[-1] == notice
    assert env.tg.buttons[notice] == WAKE_BUTTONS
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
    ({"ok": False, "code": "session-open-elsewhere", "started": False}, _zh("open_elsewhere")),
    ({"ok": False, "code": "ask-refused", "started": False}, _zh("unresumable", reason=_zh("reason_ask"))),
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


async def test_a_pane_back_on_its_own_gets_the_kept_messages_first(env: Env) -> None:
    _wakeable(env)
    await env.inbound("old one")
    await env.inbound("old two")
    env.fake.gone.discard("pane-1")  # the user opened the window at the computer
    await env.inbound("new")
    assert [d[1] for d in env.fake.delivered] == ["old one", "old two", "new"]


async def test_the_offline_reply_states_the_keeping_limits(env: Env) -> None:
    _wakeable(env)
    await env.inbound("hello")
    for lang in ("zh-TW", "en-US", "ja-JP"):
        notice = wake.text(lang, "offline_wake", max=wake.STASH_MAX, minutes=int(wake.STASH_TTL_S // 60))
        assert str(wake.STASH_MAX) in notice and str(int(wake.STASH_TTL_S // 60)) in notice
    assert env.tg.texts()[-1] == _zh("offline_wake", max=wake.STASH_MAX, minutes=int(wake.STASH_TTL_S // 60))


async def test_a_message_pushed_out_of_the_kept_list_is_reported(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(wake, "STASH_MAX", 2)
    _wakeable(env)
    for text in ("first", "second", "third"):
        await env.inbound(text)
    assert _zh("not_sent_overflow", max=2, count=1, items="「first」") in env.tg.texts()
    await _press_wake(env)
    assert [d[1] for d in env.fake.delivered] == ["second", "third"]


async def test_expired_kept_messages_are_reported_not_dropped_silently(tmp_path) -> None:
    clock = FakeClock()
    env = await _make_env(tmp_path, clock)
    try:
        _wakeable(env)
        await env.inbound("too old")
        clock.t += wake.STASH_TTL_S + 1
        await env.inbound("fresh")
        await _press_wake(env)
        assert [d[1] for d in env.fake.delivered] == ["fresh"]
        minutes = int(wake.STASH_TTL_S // 60)
        assert _zh("not_sent_expired", minutes=minutes, count=1, items="「too old」") in env.tg.texts()
    finally:
        await env.m.stop()
        env.db.close()


async def test_kept_messages_lost_to_a_restart_are_reported(env: Env) -> None:
    _wakeable(env)
    await env.inbound("kept before the restart")
    factory = env.m._factory_for
    await env.m.stop()
    restarted = mgr_mod.ChannelManager(env.store, env.fake.seams(), factory_for=factory, clock=env.clock)
    env.m = restarted
    await restarted.start()
    await restarted.wait_idle()
    assert _zh("not_sent_restart", count=1, items="「kept before the restart」") in env.tg.texts()
    # Told once: a second restart has nothing left to report.
    await restarted.stop()
    again = mgr_mod.ChannelManager(env.store, env.fake.seams(), factory_for=factory, clock=env.clock)
    env.m = again
    await again.start()
    await again.wait_idle()
    assert env.tg.texts().count(_zh("not_sent_restart", count=1, items="「kept before the restart」")) == 0


async def test_a_turn_end_refreshes_the_wake_target(env: Env) -> None:
    # A new conversation started in the window, not through the chat, is what a later wake resumes.
    fw = FakeWake(env).install()
    env.store.set_wake_target("pane-1", "/ws", "sess-1")
    fw.target = {"workspace_path": "/ws", "session_id": "sess-9"}
    env.turn_complete("pane-1", "done")
    await _until(lambda: env.store.bindings()[0].session_id == "sess-9")


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
        placeholder={"ok": True, "reason": "opened", "launched_session_id": "sess-1"}, spawns=[],
        settings={})
    monkeypatch.setattr(app, "live_main_window_ids", lambda: set(state.windows))
    monkeypatch.setattr(app, "project_store", SimpleNamespace(
        peek=lambda ws: SimpleNamespace(panes=state.records) if ws == "/ws" else None), raising=False)
    monkeypatch.setattr(app, "ui_settings_store", SimpleNamespace(get=lambda: dict(state.settings)),
                        raising=False)
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

    async def open_agent(*a, **kw):
        state.spawns.append((a, kw))
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


async def test_seam_refuses_resume_behavior_never_before_opening_the_window(seam) -> None:
    # Opening the window would restore every pane of the workspace fresh, this one included.
    seam.probe = False
    seam.settings = {"agentTeam.resumeBehavior": "never"}
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {
        "ok": False, "code": "fresh-refused", "started": False}
    assert seam.opened_ws == [] and seam.placeholder_calls == []


async def test_seam_opens_the_workspace_and_the_placeholder_onto_its_own_conversation(seam) -> None:
    seam.probe = False
    seam.registry["old-1"] = SimpleNamespace(pane_id="old-1", realized=False)
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {"ok": True, "pane_id": "new-1"}
    assert seam.opened_ws == ["/ws"] and seam.placeholder_calls == [("old-1", True)]


async def test_seam_does_not_take_an_already_open_pane_on_trust(seam) -> None:
    # The window's own restore may have opened it, fresh under "never" or the user's choice.
    seam.registry["old-1"] = SimpleNamespace(pane_id="old-1", realized=True)
    seam.placeholder = {"ok": True, "reason": "already-open", "launched_session_id": ""}
    result = await channels_pkg.wake_pane("old-1", "/ws", "sess-1")
    assert result == {"ok": False, "code": "session-mismatch", "started": True}
    assert seam.placeholder_calls == [("old-1", True)]
    seam.placeholder = {"ok": True, "reason": "already-open", "launched_session_id": "sess-1"}
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {"ok": True, "pane_id": "new-1"}


async def test_seam_fails_a_fresh_open_even_when_the_window_says_ok(seam) -> None:
    seam.registry["old-1"] = SimpleNamespace(pane_id="old-1", realized=False)
    seam.placeholder = {"ok": True, "reason": "fresh", "launched_session_id": "sess-1"}
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {
        "ok": False, "code": "fresh-refused", "started": True}
    seam.placeholder = {"ok": True, "reason": "opened", "launched_session_id": "sess-other"}
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {
        "ok": False, "code": "session-mismatch", "started": True}


async def test_seam_finds_the_pane_by_its_conversation_after_a_rekey(seam) -> None:
    seam.records.append(_Record(pane_id="rekeyed-1", agent="claude", session_id="sess-1",
                                spawn_status="spawned", custom_name="api", auto_name=""))
    seam.registry["rekeyed-1"] = SimpleNamespace(pane_id="rekeyed-1", realized=False)
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {"ok": True, "pane_id": "new-1"}
    assert seam.placeholder_calls == [("rekeyed-1", True)] and seam.spawns == []


async def test_seam_passes_on_a_window_that_would_not_resume(seam) -> None:
    seam.registry["old-1"] = SimpleNamespace(pane_id="old-1", realized=False)
    seam.placeholder = {"ok": False, "reason": "fresh-refused"}
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {
        "ok": False, "code": "fresh-refused", "started": True}


async def test_seam_never_opens_a_second_pane_onto_the_conversation(seam) -> None:
    # The window has not brought the pane back (still loading, or a detached group's): opening
    # another pane onto the same session would run two CLIs on one conversation.
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {
        "ok": False, "code": "pane-not-restored", "started": True}
    assert seam.spawns == []


async def test_seam_refuses_a_conversation_whose_pane_was_closed(seam) -> None:
    # A close whose unbind never reached the backend leaves the binding; closing a pane is
    # the user's word, so its conversation is not brought back.
    seam.records[0].spawn_status = "removed"
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {
        "ok": False, "code": "no-record", "started": False}
    assert seam.spawns == [] and seam.opened_ws == []


async def test_open_placeholder_reports_the_session_the_window_launched(monkeypatch) -> None:
    from agent_team_backend import agent_messaging
    from agent_team_backend.mcp_server import server as mcp

    sent: list[dict[str, Any]] = []

    async def ui_request(workspace, op, *, caller, action, args, **kw):
        sent.append(args)
        return {"ok": True, "result": {"realized": True, "reason": "opened", "paneId": "p2",
                                       "launchedSessionId": "sess-1"}}

    monkeypatch.setattr(mcp, "_ui_request", ui_request)
    monkeypatch.setattr(agent_messaging, "current", lambda pid: None)
    entry = SimpleNamespace(pane_id="p1", workspace_path="/ws")
    opened = await mcp._open_placeholder(entry, require_resume=True)
    assert sent == [{"paneId": "p1", "requireResume": True}]
    assert opened["ok"] and opened["launched_session_id"] == "sess-1"
    await mcp._open_placeholder(entry)
    assert sent[-1] == {"paneId": "p1"}  # every other caller asks exactly as before


async def test_kept_messages_sent_by_a_wake_get_their_reply_when_delivery_is_unconfirmed(env: Env) -> None:
    # #413: an "unconfirmed" delivery (typed and submitted, not seen taken) arms the reply like
    # "delivered". The messages a wake sends in go through that same watch.
    _wakeable(env)
    await env.inbound("first kept")
    await env.inbound("second kept")
    env.fake.verdicts["k1"] = {"status": "unconfirmed"}
    env.fake.verdicts["k2"] = {"status": "unconfirmed"}
    await _press_wake(env)
    assert [d[:2] for d in env.fake.delivered] == [("pane-1b", "first kept"), ("pane-1b", "second kept")]
    await _until(lambda: "pane-1b" in env.m._pending and env.m._pending["pane-1b"].armed_at is not None)
    env.turn_complete("pane-1b", "the woken pane answers")
    await _until(lambda: any("the woken pane answers" in t for t in env.tg.texts()))
    await env.m.wait_idle()
    assert not env.m._queued.get("pane-1b")  # both watches ended; neither is spinning


async def test_the_package_still_starts_and_stops_the_gateway(monkeypatch) -> None:
    # The app lifespan calls channels.start() / channels.stop(); losing them kept the whole
    # backend from starting (CI on bc69b68b0).
    from agent_team_backend import app

    started: list[str] = []

    async def fake_start(self) -> None:
        started.append("start")

    async def fake_stop(self) -> None:
        started.append("stop")

    monkeypatch.setattr(mgr_mod.ChannelManager, "start", fake_start)
    monkeypatch.setattr(mgr_mod.ChannelManager, "stop", fake_stop)
    monkeypatch.setattr(channels_pkg, "_manager", None)
    await channels_pkg.start()
    assert channels_pkg.get_manager() is not None
    await channels_pkg._start_task
    await channels_pkg.stop()
    assert started == ["start", "stop"] and channels_pkg.get_manager() is None



async def test_seam_refuses_a_session_another_pane_already_runs(seam) -> None:
    # Review MED-3: resuming the bound placeholder too would put two CLIs on one conversation.
    seam.records.append(_Record(pane_id="live-2", agent="claude", session_id="sess-1",
                                spawn_status="spawned", custom_name="api", auto_name=""))
    seam.registry["old-1"] = SimpleNamespace(pane_id="old-1", realized=False)
    seam.registry["live-2"] = SimpleNamespace(pane_id="live-2", realized=True)
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {
        "ok": False, "code": "session-open-elsewhere", "started": False}
    assert seam.placeholder_calls == [] and seam.opened_ws == []


async def test_seam_refuses_resume_behavior_ask_without_opening_anything(seam) -> None:
    # Review LOW-9: no window and no restore dialog on the user's computer from a chat.
    seam.probe = False
    seam.settings = {"agentTeam.resumeBehavior": "ask"}
    assert await channels_pkg.wake_pane("old-1", "/ws", "sess-1") == {
        "ok": False, "code": "ask-refused", "started": False}
    assert seam.opened_ws == [] and seam.placeholder_calls == []


async def test_kept_messages_over_the_queue_limit_are_listed_not_dropped(env: Env, monkeypatch) -> None:
    # Review LOW-7: MAX_QUEUED_PER_PANE stays; what does not fit is named in the chat.
    monkeypatch.setattr(mgr_mod, "MAX_QUEUED_PER_PANE", 2)
    _wakeable(env)
    for text in ("kept 1", "kept 2", "kept 3"):
        await env.inbound(text)
    env.fake.gone.discard("pane-1")
    await env.inbound("new")
    # One slot stays for the new message; the kept ones that do not fit are listed.
    assert [d[1] for d in env.fake.delivered] == ["kept 1", "new"]
    assert _zh("not_sent_queue_full", count=2, items="「kept 2」、「kept 3」") in env.tg.texts()


async def test_kept_messages_over_the_queue_limit_on_a_wake_are_listed(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "MAX_QUEUED_PER_PANE", 2)
    _wakeable(env)
    for text in ("kept 1", "kept 2", "kept 3"):
        await env.inbound(text)
    await _press_wake(env)
    assert [d[1] for d in env.fake.delivered] == ["kept 1", "kept 2"]
    assert _zh("not_sent_queue_full", count=1, items="「kept 3」") in env.tg.texts()


async def test_a_lost_list_waits_for_its_bot_and_is_then_deleted(env: Env) -> None:
    # Review LOW-8: a bot that does not start on the restart is told once it does, and the
    # previews do not stay in sqlite after that.
    _wakeable(env)
    await env.inbound("kept before the restart")
    factory = env.m._factory_for
    await env.m.stop()
    env.store.set_account_enabled("telegram", False)
    restarted = mgr_mod.ChannelManager(env.store, env.fake.seams(), factory_for=factory, clock=env.clock)
    env.m = restarted
    await restarted.start()
    await restarted.wait_idle()
    notice = _zh("not_sent_restart", count=1, items="「kept before the restart」")
    assert notice not in env.tg.texts()  # its bot is not running: nowhere to tell it yet
    assert (await restarted.set_enabled("telegram", True))["ok"]
    await restarted.wait_idle()
    await _until(lambda: notice in env.tg.texts())
    assert env.store.kept_previews() == {} and env.store.lost_previews() == {}
