"""Inbound chat messages are kept in channel_inbound until settled (a restart replays them),
held while the pane's CLI reports an expired login, and missed platform updates are told."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from agent_team_backend.channels import inbound
from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels.base import Location

from .test_manager import (  # noqa: F401 — fixtures and helpers shared with the manager suite
    Env, _said, _until, env, fast_timers,
)


@pytest.fixture(autouse=True)
def fast_probe(monkeypatch):
    monkeypatch.setattr(inbound, "CLI_PROBE_EVERY_S", 0.02)


def _rows(e: Env) -> list[tuple[int, float, dict[str, Any]]]:
    return e.store.inbound("telegram", "default")


def _health(e: Env, state: dict[str, Any]) -> None:
    async def cli_health(_pane_id: str) -> dict[str, Any]:
        return dict(state)

    e.m._seams.cli_health = cli_health


async def _restarted(tmp_path, old: Env) -> Env:
    await old.m.stop()
    old.db.close()
    e = Env(tmp_path)
    await e.m.start()
    assert (await e.m.configure("telegram", {}, {"token": "tok-A"}))["ok"]
    return e


async def test_a_delivered_message_leaves_no_row(env: Env) -> None:
    await env.inbound("hello")
    assert [d[1] for d in env.fake.delivered] == ["hello"]
    assert _rows(env) == []


async def test_a_message_not_yet_delivered_survives_a_restart(tmp_path, monkeypatch) -> None:
    first = Env(tmp_path)
    await first.m.start()
    assert (await first.m.configure("telegram", {}, {"token": "tok-A"}))["ok"]
    first.store.add_allow("telegram", "7", "alice", 1)
    first.store.bind("pane-1", Location("telegram", "default", "-100", "50", "api"))
    monkeypatch.setattr(mgr_mod, "DEBOUNCE_S", 30.0)  # still waiting to be joined when Navide stops
    await first.inbound("before the crash", wait=False)
    assert len(_rows(first)) == 1 and first.fake.delivered == []
    monkeypatch.setattr(mgr_mod, "DEBOUNCE_S", 0.0)
    e = await _restarted(tmp_path, first)
    try:
        await _until(lambda: e.fake.delivered)
        assert [d[1] for d in e.fake.delivered] == ["before the crash"]
        await e.m.wait_idle()
        assert _rows(e) == []
    finally:
        await e.m.stop()
        e.db.close()


async def test_an_unsettled_message_over_a_day_old_is_reported_not_sent(tmp_path) -> None:
    first = Env(tmp_path)
    await first.m.start()
    assert (await first.m.configure("telegram", {}, {"token": "tok-A"}))["ok"]
    first.store.add_allow("telegram", "7", "alice", 1)
    first.store.bind("pane-1", Location("telegram", "default", "-100", "50", "api"))
    row = first.store.add_inbound("telegram", "default", {
        "platform": "telegram", "account": "default", "chat_id": "-100", "thread_id": "50",
        "sender_id": "7", "sender_name": "alice", "text": "stale", "message_id": "old-1",
        "is_direct": False, "ts": time.time() - 2 * 86400})
    with first.db.transaction() as cur:
        cur.execute("UPDATE channel_inbound SET created_at = ? WHERE id = ?", (time.time() - 2 * 86400, row))
    e = await _restarted(tmp_path, first)
    try:
        await _until(lambda: _said(e, "Navide 重啟了"))
        await e.m.wait_idle()
        assert e.fake.delivered == [] and _rows(e) == []
    finally:
        await e.m.stop()
        e.db.close()


async def test_an_expired_login_queues_the_message_tells_the_chat_and_sends_it_after(env: Env) -> None:
    state = {"login_expired": True}
    _health(env, state)
    await env.inbound("check kling usage")
    assert env.fake.delivered == []
    assert _said(env, "目前回報登入過期，訊息已排隊")
    assert len(_rows(env)) == 1  # parked: a restart now would still send it
    await env.inbound("and a report")
    assert env.fake.delivered == [] and _said(env, "（第 2 則）")
    state["login_expired"] = False
    await _until(lambda: len(env.fake.delivered) == 2)
    assert [d[1] for d in env.fake.delivered] == ["check kling usage", "and a report"]
    await _until(lambda: _said(env, "登入已恢復，已補送"))
    await env.m.wait_idle()
    assert _rows(env) == []


async def test_a_message_held_for_an_expired_login_survives_a_restart(tmp_path) -> None:
    first = Env(tmp_path)
    await first.m.start()
    assert (await first.m.configure("telegram", {}, {"token": "tok-A"}))["ok"]
    first.store.add_allow("telegram", "7", "alice", 1)
    first.store.bind("pane-1", Location("telegram", "default", "-100", "50", "api"))
    _health(first, {"login_expired": True})
    await first.inbound("held across a restart")
    assert first.fake.delivered == [] and len(_rows(first)) == 1
    e = await _restarted(tmp_path, first)
    try:
        await _until(lambda: e.fake.delivered)
        assert [d[1] for d in e.fake.delivered] == ["held across a restart"]
        await e.m.wait_idle()
        assert _rows(e) == []
    finally:
        await e.m.stop()
        e.db.close()


async def test_a_window_that_does_not_answer_never_holds_a_message(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(inbound, "CLI_PROBE_TIMEOUT_S", 0.05)

    async def stuck(_pane_id: str) -> dict[str, Any]:
        await asyncio.sleep(5)
        return {"login_expired": True}

    env.m._seams.cli_health = stuck
    await env.inbound("goes straight in")
    assert [d[1] for d in env.fake.delivered] == ["goes straight in"]


async def test_missed_updates_are_told_to_the_bots_bound_chats(env: Env) -> None:
    env.m._on_missed_updates(("telegram", "default"), 3)
    await env.m.wait_idle()
    assert _said(env, "有 3 則訊息沒有經過 Navide 就被取走了")

