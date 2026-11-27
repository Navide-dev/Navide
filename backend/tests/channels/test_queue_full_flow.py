"""A full pane queue as a chat sees it: the overflow notice, the queue-full notice's
[switch account and send] / [show pane] buttons, the requeue button, and a stopped
pane's hold notice offering to resume."""

from __future__ import annotations

import asyncio
from typing import Any

from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels.manager import (
    MSG_QUEUE_FULL,
    MSG_QUEUE_OVERFLOW,
    MSG_SWITCH_NO_HEADROOM,
    QUEUE_FULL_BUTTONS,
    QUEUE_SWITCH_CALLBACK,
    RESUME_BUTTONS,
    STATUS_CALLBACK,
)

from .test_account_menu_flow import _setup
from .test_manager import Env, _until, env, fast_timers  # noqa: F401 — fixtures


def _ranked(*rows: tuple[str, str | None]) -> Any:
    async def candidates(agent_key: str) -> list[dict[str, Any]]:
        return [{"slotId": slot, "excluded": excluded} for slot, excluded in rows]
    return candidates


async def test_a_message_kept_past_the_window_cap_is_said_once_with_both_buttons(env: Env) -> None:
    env.m._seams.pane_directory = lambda: [{"pane_id": "pane-1", "name": "指揮"}]
    await env.inbound("one more")
    env.fake.verdicts["k1"] = {"status": "queued", "hold": {"key": "queue-full", "n": 10}}
    notice = MSG_QUEUE_OVERFLOW.format(name="指揮")
    await _until(lambda: notice in env.tg.texts())
    await asyncio.sleep(0.05)
    assert env.tg.texts().count(notice) == 1
    assert env.tg.buttons[notice] == QUEUE_FULL_BUTTONS


async def test_the_chat_cap_notice_offers_switch_show_and_requeue(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "MAX_QUEUED_PER_PANE", 1)
    await env.inbound("first")
    await env.inbound("second")
    assert env.tg.texts()[-1] == MSG_QUEUE_FULL
    buttons = env.tg.buttons[MSG_QUEUE_FULL]
    assert buttons[:2] == QUEUE_FULL_BUTTONS
    label, data = buttons[2]
    assert label == "🔁 排回佇列" and data.startswith("nv7:")


async def test_an_old_window_failing_on_queue_full_gets_the_buttons_too(env: Env) -> None:
    env.m._seams.pane_directory = lambda: [{"pane_id": "pane-1", "name": "指揮"}]
    await env.inbound("hello")
    env.fake.verdicts["k1"] = {"status": "failed", "reason": "queue-full"}
    notice = "⚠️ 訊息沒有送進分格「指揮」（queue-full）"
    await _until(lambda: notice in env.tg.texts())
    buttons = env.tg.buttons[notice]
    assert buttons[:2] == QUEUE_FULL_BUTTONS and buttons[2][0] == "🔁 排回佇列"


async def test_switch_and_send_takes_the_failover_ranking_first_eligible_account(env: Env) -> None:
    acc = _setup(env)
    env.m._seams.failover_candidates = _ranked(("p-auto", "exhausted"), ("p-work", None), ("p-auto", None))
    await env.inbound("", callback=QUEUE_SWITCH_CALLBACK, direct=True)
    assert acc.calls == [("pane-1", "p-work", "__default__", "telegram:alice")]
    assert env.fake.delivered == []  # a button, never typed into the CLI


async def test_switch_and_send_resumes_a_stopped_pane_after_the_switch(env: Env) -> None:
    _setup(env)
    env.m._seams.failover_candidates = _ranked(("p-work", None))
    env.fake.states["pane-1"] = {"exists": True, "busy": False, "display_status": "stopped"}
    await env.inbound("", callback=QUEUE_SWITCH_CALLBACK, direct=True)
    assert env.fake.resumes == ["pane-1"]


async def test_switch_and_send_with_nobody_eligible_switches_nothing(env: Env) -> None:
    acc = _setup(env)
    env.m._seams.failover_candidates = _ranked(("__default__", "current"), ("p-work", "exhausted"))
    await env.inbound("", callback=QUEUE_SWITCH_CALLBACK, direct=True)
    assert acc.calls == [] and env.tg.texts()[-1] == MSG_SWITCH_NO_HEADROOM


async def test_switch_and_send_in_a_group_chat_only_lists(env: Env) -> None:
    acc = _setup(env)
    env.m._seams.failover_candidates = _ranked(("p-work", None))
    await env.inbound("", callback=QUEUE_SWITCH_CALLBACK, direct=False)
    assert acc.calls == []


async def test_show_pane_is_the_status_card(env: Env) -> None:
    await env.inbound("", callback=STATUS_CALLBACK)
    await env.inbound("/status")
    assert env.fake.delivered == []
    # The button answers exactly as the typed command does.
    said = env.tg.texts()
    assert len(said) == 2 and said[0] == said[1]


async def test_a_stopped_pane_hold_notice_offers_to_resume(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "HOLD_FAILURE_AFTER_S", 0.0)
    await env.inbound("go")
    env.fake.states["pane-1"] = {"exists": True, "busy": False, "display_status": "stopped"}
    env.fake.verdicts["k1"] = {"status": "queued", "hold": {"key": "not-ready"}}
    await _until(lambda: any("not-ready" in t for t in env.tg.texts()))
    notice = next(t for t in env.tg.texts() if "not-ready" in t)
    assert env.tg.buttons[notice] == RESUME_BUTTONS
