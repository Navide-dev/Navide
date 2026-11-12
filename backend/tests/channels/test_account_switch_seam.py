"""The channels' switch_account seam on the real shared entry (request_account_switch),
with the window faked: what the window is asked, the queued answer, and the settle that
reaches the chat. No real window, account or chat."""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend import app as backend_app
from agent_team_backend import channels
from agent_team_backend.account_switch_log import AccountSwitchLog
from agent_team_backend.db import Database
from agent_team_backend.mcp_server import server as mcp


class _Untouchable:
    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"touched credential_vault.{name}")


@pytest.fixture
def window(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    agent_messaging._reset_for_test()
    log = AccountSwitchLog(Database(tmp_path / "navide.db"))
    monkeypatch.setattr(backend_app, "account_switch_log", log)
    monkeypatch.setattr(backend_app, "credential_vault", _Untouchable())
    monkeypatch.setattr(mcp, "_app_store_get", lambda pid: {"name": f"name-{pid}"})
    calls: list[dict[str, Any]] = []
    answers: dict[str, dict[str, Any]] = {}

    async def ui_request(workspace_path: str, op: str, **kw: Any) -> dict[str, Any]:
        calls.append({"workspace_path": workspace_path, "op": op, **kw})
        return answers.get(str(kw.get("action")), {"ok": True, "result": None})

    monkeypatch.setattr(mcp, "_ui_request", ui_request)
    audits: list[tuple[str, str, str, str]] = []
    monkeypatch.setattr(channels, "_audit_account_switch",
                        lambda pane, who, frm, to, status: audits.append((who, frm, to, status)))
    agent_messaging.register("pane-1", "main", "/ws/alpha", agent_key="claude")
    yield {"calls": calls, "answers": answers, "log": log, "audits": audits}
    agent_messaging._reset_for_test()


@pytest.mark.asyncio
async def test_a_chat_press_runs_the_shared_switch_and_hears_when_it_settles(window: dict[str, Any]) -> None:
    window["answers"]["ui.accounts.switch"] = {
        "ok": True, "result": {"status": "queued", "waiting": 2, "from": "Default", "to": "Work"}}
    told: list[dict[str, Any]] = []

    async def on_settled(answer: dict[str, Any]) -> None:
        told.append(answer)

    seams = channels.default_seams()
    answer = await seams.switch_account("pane-1", "p-work", "__default__", "telegram:alice", on_settled)
    assert answer == {"status": "queued", "from": "Default", "to": "Work", "waiting": 2}
    [call] = window["calls"]
    assert call["action"] == "ui.accounts.switch"
    assert call["args"]["expectedFrom"] == "__default__"
    assert call["args"]["requester"] == {"source": "telegram", "name": "telegram:alice"}
    assert window["audits"] == []  # a queued switch is audited when it settles

    [row] = window["log"].list_recent()
    await mcp.settle_account_switch({"request_id": str(row["id"]), "status": "switched", "from": "Default", "to": "Work"})
    assert told == [{"status": "switched", "from": "Default", "to": "Work"}]
    assert window["audits"] == [("telegram:alice", "__default__", "p-work", "switched")]
    [row] = window["log"].list_recent()
    assert (row["source"], row["requester"], row["status"]) == ("telegram", "telegram:alice", "switched")


@pytest.mark.asyncio
async def test_a_stale_menu_switches_nothing_and_is_audited(window: dict[str, Any]) -> None:
    window["answers"]["ui.accounts.switch"] = {"ok": True, "result": {"status": "stale"}}
    answer = await channels.default_seams().switch_account("pane-1", "p-work", "p-old", "telegram:alice")
    assert answer["status"] == "stale"
    assert window["audits"] == [("telegram:alice", "p-old", "p-work", "stale")]
