"""An automatic quota switch is recorded in account_switch_log and handed to the chats
(plan agent-0-2-42_3f728e P3). quota_failover only tells its commit listeners; a listener
cannot hold or fail the switch. Fake store, fake manager, temporary database."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import failover_notice, quota_failover
from agent_team_backend.account_switch_log import AccountSwitchLog
from agent_team_backend.db import Database


class Profiles:
    def list(self) -> dict[str, Any]:
        return {"defaultNames": {"claude": "Home"}}

    def get(self, profile_id: str) -> dict[str, Any] | None:
        return {"p-b": {"name": "Work"}}.get(profile_id)


class Manager:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def notify_failover_switch(self, **kw: Any) -> int:
        self.calls.append(kw)
        return 1


@pytest.fixture
def wired(tmp_path, monkeypatch):
    from agent_team_backend import app
    from agent_team_backend import channels

    db = Database(tmp_path / "navide.db")
    log = AccountSwitchLog(db)
    manager = Manager()
    monkeypatch.setattr(app, "account_switch_log", log, raising=False)
    monkeypatch.setattr(app, "cli_profiles_store", Profiles(), raising=False)
    monkeypatch.setattr(channels, "get_manager", lambda: manager)
    yield log, manager
    db.close()


def _event(**kw: Any) -> dict[str, Any]:
    e = {"transactionId": "tx1", "agentKey": "claude", "fromSlotId": "__default__", "toSlotId": "p-b",
         "automatic": True, "state": "committed", "needsLogin": False, "paneIds": ["pane-1"]}
    e.update(kw)
    return e


async def test_an_automatic_switch_is_recorded_and_told(wired) -> None:
    log, manager = wired
    await failover_notice.on_commit(_event())
    [row] = log.list_recent()
    assert row["source"] == "failover" and row["requester"] == "quota-failover"
    assert row["status"] == "switched" and row["code"] is None
    assert (row["from_profile_id"], row["from_name"]) == ("__default__", "Home")
    assert (row["to_profile_id"], row["to_name"]) == ("p-b", "Work")
    assert row["reason"] == "quota ran out on Home"
    assert manager.calls == [{"agent_key": "claude", "pane_ids": ["pane-1"], "from_id": "__default__",
                              "from_label": "Home", "to_id": "p-b", "to_label": "Work", "needs_login": False}]


async def test_a_switch_the_user_started_is_left_out(wired) -> None:
    log, manager = wired
    await failover_notice.on_commit(_event(automatic=False))
    assert log.list_recent() == [] and manager.calls == []


async def test_a_partial_switch_and_a_sign_in_gap_say_so(wired) -> None:
    log, manager = wired
    await failover_notice.on_commit(_event(state="partial", needsLogin=True))
    [row] = log.list_recent()
    assert row["status"] == "partial" and row["code"] == "target-needs-login"
    assert manager.calls[0]["needs_login"] is True


async def test_no_channels_still_records(wired, monkeypatch) -> None:
    from agent_team_backend import channels

    log, _ = wired
    monkeypatch.setattr(channels, "get_manager", lambda: None)
    await failover_notice.on_commit(_event())
    assert len(log.list_recent()) == 1


def _tx(**kw: Any) -> SimpleNamespace:
    tx = SimpleNamespace(id="tx1", agent_key="claude", from_slot_id="__default__", to_slot_id="p-b",
                         automatic=True, state="committed",
                         panes={"pane-2": {"paneId": "pane-2"}}, hot_switched_panes=[{"paneId": "pane-1"}])
    for k, v in kw.items():
        setattr(tx, k, v)
    return tx


async def test_commit_listeners_get_the_event_and_cannot_fail_the_switch() -> None:
    got: list[dict[str, Any]] = []

    async def good(event: dict[str, Any]) -> None:
        got.append(event)

    async def bad(event: dict[str, Any]) -> None:
        raise RuntimeError("listener broke")

    def not_a_coroutine(event: dict[str, Any]) -> None:
        raise RuntimeError("never started")

    removers = [quota_failover.add_commit_listener(f) for f in (bad, not_a_coroutine, good)]
    try:
        svc = quota_failover.QuotaFailoverService.__new__(quota_failover.QuotaFailoverService)
        svc._notify_commit_listeners(_tx(), "ok")  # must not raise
        await asyncio.sleep(0)
        await asyncio.sleep(0)
    finally:
        for remove in removers:
            remove()
    assert got == [{"transactionId": "tx1", "agentKey": "claude", "fromSlotId": "__default__",
                    "toSlotId": "p-b", "automatic": True, "state": "committed", "needsLogin": False,
                    "paneIds": ["pane-1", "pane-2"]}]
    assert quota_failover._commit_listeners == []


def test_install_registers_once_and_uninstall_removes() -> None:
    before = list(quota_failover._commit_listeners)
    failover_notice.install()
    failover_notice.install()
    try:
        assert quota_failover._commit_listeners.count(failover_notice.on_commit) == 1
    finally:
        failover_notice.uninstall()
    assert quota_failover._commit_listeners == before
