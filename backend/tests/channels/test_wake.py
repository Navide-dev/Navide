"""A pane that is not online: the notice, the startup grace for a restart's backlog, and
waking the pane back onto its own conversation from the chat."""

from __future__ import annotations

import asyncio

from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels import wake

from .test_manager import Env, _until, env, fast_timers  # noqa: F401 — pytest fixtures


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
