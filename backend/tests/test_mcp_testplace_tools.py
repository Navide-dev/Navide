"""W5: marketplace_testplace_invite_open / _fill only open or draft the form.

Neither tool invites anyone: _open broadcasts the form, _fill files a pending
form request whose draft the user reviews; only the user's Send in the main
window creates invitations, and their join tokens never reach the agent.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, skills_approvals
from agent_team_backend.db import Database
from agent_team_backend.mcp_server import marketplace_forms
from agent_team_backend.mcp_server import server as mcp
from agent_team_backend.mcp_server import testplace_tools
from agent_team_backend.plugins import agent_tools_contract as contract
from agent_team_backend.plugins.audit_log import PluginAuditLog

TOOLS = ["marketplace_testplace_invite_open", "marketplace_testplace_invite_fill"]


@pytest.fixture
def window(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def broadcast_main_windows(event: dict[str, Any]) -> None:
        sent.append(event)

    agent_messaging._reset_for_test()
    skills_approvals.registry._reset_for_test()
    agent_messaging.register("p-41", "dev", str(tmp_path), agent_key="claude")
    caller = mcp._Caller(kind="pane", pane_id="p-41")
    # marketplace_forms resolves the caller through the server module (W3).
    monkeypatch.setattr(mcp, "_resolve_caller", lambda ctx: caller)
    monkeypatch.setattr(app, "broadcast_main_windows", broadcast_main_windows)
    monkeypatch.setattr(app, "has_main_window", lambda: True)
    monkeypatch.setattr(app, "plugin_audit_log", PluginAuditLog(Database(tmp_path / "navide.db")))
    yield sent
    agent_messaging._reset_for_test()
    skills_approvals.registry._reset_for_test()


def _tools() -> dict[str, Any]:
    return {t.name: t for t in mcp.server._tool_manager.list_tools()}  # noqa: SLF001


def test_both_tools_are_registered_core_tools() -> None:
    tools = _tools()
    for name in TOOLS:
        assert name in tools and name in contract.CORE_TOOL_NAMES, name


@pytest.mark.parametrize("name", TOOLS)
def test_no_tool_takes_a_consent_or_send_argument(name: str) -> None:
    params = set(_tools()[name].parameters.get("properties", {}))
    for word in ("consent", "approve", "confirm", "token", "send", "submit"):
        assert not any(word in p for p in params), (name, params)


async def test_open_broadcasts_the_form_and_files_nothing(window) -> None:
    out = await testplace_tools.marketplace_testplace_invite_open(None, "acme", "files")
    assert out == {"ok": True, "opened": True, "form": "testplace-invite", "note": marketplace_forms._OPEN_NOTE}
    [event] = window
    assert event["type"] == contract.MARKETPLACE_FORM_OPEN_EVENT
    assert event["payload"]["form"] == "testplace-invite"
    assert event["payload"]["prefill"] == {"id": "acme.files"}
    assert skills_approvals.registry.plugin_requests() == []


async def test_open_without_an_id_lets_the_user_pick(window) -> None:
    out = await testplace_tools.marketplace_testplace_invite_open(None)
    assert out["ok"] is True
    assert window[0]["payload"]["prefill"] == {}


async def test_fill_files_a_pending_draft_marked_as_agent_written(window) -> None:
    out = await testplace_tools.marketplace_testplace_invite_fill(
        None, "acme", "files", [" a@example.com ", "Bob (QA)"], "User asked to invite the QA team."
    )
    assert set(out) == {"ok", "approval_id", "status", "expires_at", "note"}
    assert out["status"] == "pending"
    record = skills_approvals.registry.get(out["approval_id"])
    assert record["kind"] == "testplace-invite"
    assert record["status"] == "pending"
    assert record["target"]["id"] == "acme.files"
    assert record["draft"] == {
        "fields": {"invitees": ["a@example.com", "Bob (QA)"]},
        "field_sources": {"invitees": "agent-draft"},
    }
    assert [e["type"] for e in window] == [contract.PLUGIN_APPROVAL_REQUEST_EVENT]


@pytest.mark.parametrize("invitees", [[], [""], ["x" * 121], "a@example.com"])
async def test_fill_refuses_a_bad_invitee_list(window, invitees) -> None:
    out = await testplace_tools.marketplace_testplace_invite_fill(None, "acme", "files", invitees)
    assert out["ok"] is False and out["error_code"] == "BAD_REQUEST"
    assert skills_approvals.registry.plugin_requests() == []


async def test_fill_takes_more_than_the_former_100_invitees(window) -> None:
    invitees = [f"t{i}@example.com" for i in range(150)]
    out = await testplace_tools.marketplace_testplace_invite_fill(None, "acme", "files", invitees)
    assert out["ok"] is True
    assert skills_approvals.registry.get(out["approval_id"])["draft"]["fields"]["invitees"] == invitees


async def test_fill_and_open_refuse_a_bad_id(window) -> None:
    assert (await testplace_tools.marketplace_testplace_invite_fill(None, "Acme", "files", ["a"]))["error_code"] == "BAD_REQUEST"
    assert (await testplace_tools.marketplace_testplace_invite_open(None, "acme", ""))["error_code"] == "BAD_REQUEST"
    assert window == []
