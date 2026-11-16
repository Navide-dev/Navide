"""Every inbound message and every binding change leaves a log line that explains it.

A chat message that reached the backend but never went to a pane must say where it
stopped, a binding that changed must say from which pane to which, and a chat whose
worker is stuck must say so: otherwise the log trail just stops (IDA, 2026-11-16).
The lines name a hash of the chat, never the chat id or the message text.
"""

from __future__ import annotations

import asyncio
import time

from agent_team_backend.channels import inbound
from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels.base import InboundMessage, Location

from .test_manager import Env, env, fast_timers  # noqa: F401 — fixtures

CHAT = "-100"
LOC = Location("telegram", "default", CHAT, "50", "api")
LOC_HASH = inbound.chat_hash(LOC.key())


def _lines(caplog, needle: str) -> list[str]:
    return [r.getMessage() for r in caplog.records if needle in r.getMessage()]


def _no_chat_id(caplog) -> None:
    assert not any(CHAT in r.getMessage() for r in caplog.records)


# --- binding changes ------------------------------------------------------------------


async def test_a_rebind_logs_the_pane_it_replaced(env: Env, caplog) -> None:
    caplog.set_level("INFO", logger="agent_team_backend.channels.store")
    env.store.bind("pane-2", LOC)  # the fixture bound pane-1 to LOC
    lines = _lines(caplog, "channels: binding")
    assert len(lines) == 1
    assert f"chat={LOC_HASH}" in lines[0] and "pane-1 -> pane-2" in lines[0]
    _no_chat_id(caplog)


async def test_a_new_binding_logs_no_previous_pane(env: Env, caplog) -> None:
    caplog.set_level("INFO", logger="agent_team_backend.channels.store")
    env.store.bind("pane-3", Location("telegram", "default", "-200", "", "x"))
    assert any("(none) -> pane-3" in line for line in _lines(caplog, "channels: binding"))


async def test_unbind_and_rename_are_logged_and_a_no_op_is_not(env: Env, caplog) -> None:
    caplog.set_level("INFO", logger="agent_team_backend.channels.store")
    assert env.store.rename_pane("pane-1", "pane-9")
    assert not env.store.rename_pane("pane-unknown", "pane-8")
    assert env.store.unbind("pane-9") is not None
    assert env.store.unbind("pane-9") is None
    lines = _lines(caplog, "channels: binding")
    assert len(lines) == 2
    assert "renamed" in lines[0] and "pane-1 -> pane-9" in lines[0] and f"chat={LOC_HASH}" in lines[0]
    assert "removed" in lines[1] and "pane-9 -> (none)" in lines[1]
    _no_chat_id(caplog)


# --- the location worker ----------------------------------------------------------------


async def test_a_stuck_inbound_job_is_logged_while_it_runs_and_when_it_ends(env: Env, caplog, monkeypatch) -> None:
    caplog.set_level("INFO", logger="agent_team_backend.channels.manager")
    monkeypatch.setattr(mgr_mod, "JOB_STALL_WARN_S", 0.05)

    async def slow() -> None:
        await asyncio.sleep(0.2)

    async def quick() -> None:
        return None

    env.m._enqueue(LOC.key(), slow)
    env.m._enqueue(LOC.key(), quick)
    await env.m.wait_idle()
    stuck = _lines(caplog, "still running")
    assert len(stuck) == 1 and f"chat={LOC_HASH}" in stuck[0] and "1 job(s) waiting" in stuck[0]
    assert len(_lines(caplog, "finished after")) == 1
    _no_chat_id(caplog)


async def test_a_quick_job_logs_nothing(env: Env, caplog) -> None:
    caplog.set_level("INFO", logger="agent_team_backend.channels.manager")

    async def quick() -> None:
        return None

    env.m._enqueue(LOC.key(), quick)
    await env.m.wait_idle()
    assert _lines(caplog, "still running") == [] and _lines(caplog, "finished after") == []


async def test_a_cancelled_worker_logs_what_it_did_not_run(env: Env, caplog) -> None:
    caplog.set_level("INFO", logger="agent_team_backend.channels.manager")
    started = asyncio.Event()

    async def hang() -> None:
        started.set()
        await asyncio.sleep(60)

    async def quick() -> None:
        return None

    env.m._enqueue(LOC.key(), hang)
    env.m._enqueue(LOC.key(), quick)
    await started.wait()
    env.m._cancel_workers()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    lines = _lines(caplog, "cancelled")
    assert len(lines) == 1 and f"chat={LOC_HASH}" in lines[0] and "2 job(s)" in lines[0]
    _no_chat_id(caplog)


# --- exits before a pane ----------------------------------------------------------------


async def test_an_invite_code_logs_that_it_is_not_for_a_pane(env: Env, caplog) -> None:
    caplog.set_level("INFO", logger="agent_team_backend.channels.manager")
    invite = env.m.invites.create("telegram", "group")
    await env.m.handle_inbound(InboundMessage(
        platform="telegram", account="default", chat_id="-300", thread_id="", sender_id="7",
        sender_name="alice", text=f"/start {invite.code}", message_id="m-invite", is_direct=False,
        ts=time.time()))
    await env.m.wait_idle()
    assert env.fake.delivered == []
    assert any("m-invite" in line and "an invite code" in line for line in _lines(caplog, "not sent to a pane"))
