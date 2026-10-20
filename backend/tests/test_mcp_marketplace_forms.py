"""W3: the Navide Marketplace developer tools (marketplace_forms.py).

*_open only opens a form in the main windows; *_fill only files the agent's
draft for that form, every field marked as the agent's. Neither sends anything
to the Host or the Registry, and only a window's Submit (decide + finish with
window confirmations) moves a form request on. The status tools ask the Host,
and nothing shaped like a token or a private key reaches the agent, the log or
the audit.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, skills_approvals
from agent_team_backend.db import Database
# server first: its tail imports marketplace_forms and then testplace_tools,
# which needs marketplace_forms complete (importing marketplace_forms first is a cycle).
from agent_team_backend.mcp_server import server as mcp
from agent_team_backend.mcp_server import marketplace_forms as forms
from agent_team_backend.plugins import agent_tools_contract as contract
from agent_team_backend.plugins.audit_log import PluginAuditLog

OPEN_TOOLS = ["marketplace_developer_application_open", "marketplace_publish_open", "marketplace_publish_yank_open"]
FILL_TOOLS = ["marketplace_developer_application_fill", "marketplace_publish_fill", "marketplace_publish_yank_fill"]
STATUS_TOOLS = ["marketplace_developer_status", "marketplace_publish_status"]
ALL_TOOLS = [*OPEN_TOOLS, *FILL_TOOLS, *STATUS_TOOLS]
# Built by concatenation so no scanner mistakes a fixture for a credential.
FAKE_TOKEN = "nva" + "_" + "Zx9" * 10
FAKE_PEM = "-----BEGIN " + "PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI" + "Abc123\n-----END " + "PRIVATE KEY-----"
LEGAL_NAME = "Ada Quillfeather-Lovelace"


class FakeHost:
    """Answers marketplace.developer.request the way developerIpc.ts does."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.answer: dict[str, Any] = {"ok": False, "error": "unset", "error_code": "HOST_UNAVAILABLE"}

    async def unicast_host(self, event: dict[str, Any]) -> bool:
        self.events.append(event)
        if event["type"] == contract.MARKETPLACE_DEVELOPER_REQUEST_EVENT:
            asyncio.get_running_loop().call_soon(
                forms.resolve_developer_query, event["payload"]["request_id"], dict(self.answer),
            )
        return True


@pytest.fixture
def host(monkeypatch: pytest.MonkeyPatch) -> FakeHost:
    fake = FakeHost()
    monkeypatch.setattr(app, "unicast_host", fake.unicast_host)
    return fake


@pytest.fixture
def windows(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def broadcast(event: dict[str, Any], **_: Any) -> None:
        sent.append(event)

    async def broadcast_main_windows(event: dict[str, Any]) -> None:
        sent.append({**event, "to": "main-windows"})

    monkeypatch.setattr(app, "broadcast", broadcast)
    monkeypatch.setattr(app, "broadcast_main_windows", broadcast_main_windows)
    monkeypatch.setattr(app, "has_main_window", lambda: True)
    return sent


@pytest.fixture
def audit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> PluginAuditLog:
    log = PluginAuditLog(Database(tmp_path / "navide.db"))
    monkeypatch.setattr(app, "plugin_audit_log", log)
    return log


@pytest.fixture
def caller(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    agent_messaging._reset_for_test()
    skills_approvals.registry._reset_for_test()
    agent_messaging.register("p-7", "publisher", str(tmp_path), agent_key="claude")
    monkeypatch.setattr(mcp, "_resolve_caller", lambda ctx: mcp._Caller(kind="pane", pane_id="p-7"))
    yield
    agent_messaging._reset_for_test()
    skills_approvals.registry._reset_for_test()


def _tools() -> dict[str, Any]:
    return {t.name: t for t in mcp.server._tool_manager.list_tools()}  # noqa: SLF001


# ── registration ────────────────────────────────────────────────────────────


def test_the_tools_are_core_tools() -> None:
    tools = _tools()
    for name in ALL_TOOLS:
        assert name in tools and name in contract.CORE_TOOL_NAMES, name


@pytest.mark.parametrize("name", ALL_TOOLS)
def test_no_tool_can_submit_or_carry_a_credential(name: str) -> None:
    params = set(_tools()[name].parameters.get("properties", {}))
    for word in ("consent", "approve", "confirm", "submit", "token", "key", "signature", "secret", "trust"):
        assert not any(word in p for p in params), (name, params)


@pytest.mark.parametrize("name", OPEN_TOOLS)
def test_open_tools_say_to_stop_and_wait(name: str) -> None:
    assert "stop and wait" in _tools()[name].description


@pytest.mark.parametrize("name", FILL_TOOLS)
def test_fill_tools_say_the_user_submits(name: str) -> None:
    description = _tools()[name].description
    assert "asked you to" in description and "_open first" in description


# ── open ────────────────────────────────────────────────────────────────────


async def test_open_only_opens_the_form(host, windows, audit, caller) -> None:
    out = await forms.marketplace_publish_open(None, "/tmp/pkg/x-1.0.0-universal.vsix")
    assert out["ok"] is True and out["opened"] is True and out["form"] == "publish"
    [event] = windows
    assert (event["type"], event["to"]) == (contract.MARKETPLACE_FORM_OPEN_EVENT, "main-windows")
    assert event["payload"]["prefill"] == {"path": "/tmp/pkg/x-1.0.0-universal.vsix"}
    assert skills_approvals.registry.plugin_requests() == []
    assert host.events == []


async def test_open_refuses_a_path_that_is_not_an_absolute_vsix(host, windows, caller) -> None:
    for path in ("relative/x.vsix", "/etc/passwd", "/tmp/x.vsix\x00.txt"):
        out = await forms.marketplace_publish_open(None, path)
        assert out["error_code"] == "BAD_REQUEST", path
    assert windows == []


async def test_open_needs_a_main_window(host, windows, caller, monkeypatch) -> None:
    monkeypatch.setattr(app, "has_main_window", lambda: False)
    out = await forms.marketplace_developer_application_open(None)
    assert out["error_code"] == "HOST_UNAVAILABLE"
    assert windows == []


# ── fill ────────────────────────────────────────────────────────────────────


async def test_application_fill_files_a_draft_and_sends_nothing(host, windows, audit, caller) -> None:
    fields = {"applicant_type": "individual", "legal_name": LEGAL_NAME, "contact_email": "ada@example.test",
              "agreed_terms": True}
    out = await forms.marketplace_developer_application_fill(None, fields, "The user asked me to apply.")
    assert set(out) == {"ok", "approval_id", "status", "expires_at", "note"}
    assert out["status"] == "pending"
    record = skills_approvals.registry.get(out["approval_id"])
    assert record["kind"] == "developer-application"
    assert record["draft"] == {"fields": fields, "field_sources": {k: "agent-draft" for k in fields}}
    assert record["expires_at"] == pytest.approx(record["created_at"] + contract.FORM_APPROVAL_TTL_S)
    assert [(e["type"], e["to"]) for e in windows] == [(contract.PLUGIN_APPROVAL_REQUEST_EVENT, "main-windows")]
    # Nothing reached the Host, so nothing reached the Registry.
    assert host.events == []
    status = await mcp.marketplace_request_status(None, out["approval_id"])
    assert status["status"] == "pending" and status["kind"] == "developer-application"


async def test_a_second_draft_replaces_the_pending_one(host, windows, audit, caller) -> None:
    first = await forms.marketplace_developer_application_fill(None, {"legal_name": "A"}, "")
    second = await forms.marketplace_developer_application_fill(None, {"legal_name": "B", "country": "TW"}, "again")
    assert first["approval_id"] == second["approval_id"]
    record = skills_approvals.registry.get(first["approval_id"])
    assert record["draft"]["fields"] == {"legal_name": "B", "country": "TW"}


async def test_application_fill_checks_field_names_and_types(host, windows, caller) -> None:
    out = await forms.marketplace_developer_application_fill(None, {"password": "x"}, "")
    assert out["error_code"] == "BAD_REQUEST" and "password" in out["error"]
    out = await forms.marketplace_developer_application_fill(None, {"legal_name": 3}, "")
    assert out["error_code"] == "BAD_REQUEST"
    assert skills_approvals.registry.plugin_requests() == []


async def test_publish_fill_publishes_at_once_only_when_the_host_says_loopback(host, windows, audit, caller) -> None:
    host.answer = {"ok": True, "result": {
        "kind": "publish-direct", "loopback": True, "published": True, "id": "nerdtechnic.devmap",
        "version": "0.3.0", "digest": "ab" * 32, "status": 201, "token": FAKE_TOKEN,
    }}
    out = await forms.marketplace_publish_fill(None, "/tmp/devmap-0.3.0-universal.vsix", "", "test it locally")
    assert out["ok"] is True and out["loopback"] is True and out["published"] is True
    assert out["id"] == "nerdtechnic.devmap" and "token" not in out and FAKE_TOKEN not in repr(out)
    assert skills_approvals.registry.plugin_requests() == []
    [query] = [e["payload"]["query"] for e in host.events]
    assert query == {"kind": "publish-direct", "path": "/tmp/devmap-0.3.0-universal.vsix", "target": ""}
    [row] = audit.recent_agent_actions()
    assert (row["action"], row["outcome"], row["plugin_id"]) == ("publish-loopback", "allowed", "nerdtechnic.devmap")


@pytest.mark.parametrize("answer", [
    {"ok": True, "result": {"kind": "publish-direct", "loopback": False}},
    {"ok": False, "error": "Navide Host cannot answer developer queries now", "error_code": "HOST_UNAVAILABLE"},
    {"ok": True, "result": {"kind": "publish-direct", "loopback": "yes"}},
    {"ok": True, "result": {"kind": "developer-status", "loopback": True}},
])
async def test_publish_fill_to_the_marketplace_needs_the_users_submit(host, windows, audit, caller, answer) -> None:
    host.answer = answer
    out = await forms.marketplace_publish_fill(None, "/tmp/devmap-0.3.0-universal.vsix", "", "")
    assert out["ok"] is True and out["status"] == "pending" and "approval_id" in out
    [record] = skills_approvals.registry.plugin_requests()
    assert record["kind"] == "plugin-publish"


async def test_publish_and_yank_fill_record_their_target(host, windows, audit, caller) -> None:
    host.answer = {"ok": True, "result": {"kind": "publish-direct", "loopback": False}}
    out = await forms.marketplace_publish_fill(None, "/tmp/x-1.0.0-darwin-arm64.vsix", "darwin-arm64", "release")
    record = skills_approvals.registry.get(out["approval_id"])
    assert record["kind"] == "plugin-publish"
    assert record["draft"]["fields"] == {"path": "/tmp/x-1.0.0-darwin-arm64.vsix", "target": "darwin-arm64"}
    out = await forms.marketplace_publish_yank_fill(None, "nerdtechnic", "devmap", "0.2.0", "broken build")
    record = skills_approvals.registry.get(out["approval_id"])
    assert record["kind"] == "plugin-yank"
    assert record["target"]["id"] == "nerdtechnic.devmap" and record["target"]["version"] == "0.2.0"
    bad = await forms.marketplace_publish_fill(None, "/tmp/x.zip")
    assert bad["error_code"] == "BAD_REQUEST"
    bad = await forms.marketplace_publish_yank_fill(None, "nerdtechnic", "devmap", "latest")
    assert bad["error_code"] == "BAD_REQUEST"
    # Only the loopback question reached the Host; nothing was uploaded.
    assert [e["payload"]["query"]["kind"] for e in host.events] == ["publish-direct"]


def test_form_kinds_and_card_kinds_stay_apart() -> None:
    requester = {"paneId": None, "paneName": None, "workspace": None, "callerKind": "host"}
    with pytest.raises(skills_approvals.SkillApprovalError):
        skills_approvals.registry.request_plugin(
            kind="plugin-publish", requester=requester, reason="",
            target={"id": "a.b", "namespace": "a", "name": "b", "version": "1.0.0"}, card=None, diff=None,
        )
    with pytest.raises(skills_approvals.SkillApprovalError):
        skills_approvals.registry.request_form(
            kind="plugin-install", requester=requester, reason="",
            target={"id": "a.b", "namespace": "a", "name": "b"}, draft={"fields": {}},
        )


# ── status ──────────────────────────────────────────────────────────────────


async def test_publish_status_answers_states_without_secrets(host, windows, caller) -> None:
    host.answer = {"ok": True, "result": {
        "kind": "publish-status", "namespace": "nerdtechnic", "token": FAKE_TOKEN,
        "items": [{"namespace": "nerdtechnic", "name": "devmap", "version": "0.2.0", "status": "rejected",
                   "yanked": False, "reason": f"leaked {FAKE_TOKEN} and {FAKE_PEM}", "privateKey": FAKE_PEM,
                   "Publisher-Token": FAKE_TOKEN}],
    }}
    out = await forms.marketplace_publish_status(None, "nerdtechnic.devmap")
    assert out["ok"] is True and out["namespace"] == "nerdtechnic"
    [query] = [e["payload"]["query"] for e in host.events]
    assert query == {"kind": "publish-status", "id": "nerdtechnic.devmap"}
    text = repr(out)
    assert FAKE_TOKEN not in text and "BEGIN" not in text and "MC4CAQ" not in text
    assert out["items"][0]["reason"] == "leaked [redacted] and [redacted]"


async def test_developer_status_errors_are_redacted_and_coded(host, windows, caller) -> None:
    host.answer = {"ok": False, "error": f"refused {FAKE_TOKEN}", "error_code": "NOT_SIGNED_IN"}
    out = await forms.marketplace_developer_status(None)
    assert out == {"ok": False, "error": "refused [redacted]", "error_code": "NOT_SIGNED_IN"}
    host.answer = {"ok": False, "error": "x", "error_code": "SOMETHING_ELSE"}
    out = await forms.marketplace_developer_status(None)
    assert out["error_code"] == "HOST_UNAVAILABLE"
    out = await forms.marketplace_publish_status(None, "not an id")
    assert out["error_code"] == "BAD_REQUEST"


async def test_nothing_secret_or_personal_is_logged_or_audited(host, windows, audit, caller, caplog) -> None:
    caplog.set_level(logging.DEBUG)
    await forms.marketplace_developer_application_fill(None, {"legal_name": LEGAL_NAME}, "")
    host.answer = {"ok": True, "result": {"kind": "developer-status", "signed_in": {"account": True},
                                          "application": {"fields": {"legal_name": LEGAL_NAME}}, "token": FAKE_TOKEN}}
    out = await forms.marketplace_developer_status(None)
    assert out["ok"] is True and "token" not in out
    assert LEGAL_NAME not in caplog.text and FAKE_TOKEN not in caplog.text
    rows = audit.recent_agent_actions()
    assert rows and LEGAL_NAME not in repr(rows) and FAKE_TOKEN not in repr(rows)


# ── S8-M1: a tainted pane's request says so (disclosure, never a restriction) ──


async def test_a_tainted_panes_draft_carries_the_flag_and_is_still_filed(host, windows, audit, caller, monkeypatch) -> None:
    from agent_team_backend.guard import taint

    monkeypatch.setattr(taint, "is_tainted", lambda pane_id: pane_id == "p-7")
    out = await forms.marketplace_developer_application_fill(None, {"legal_name": "A"}, "")
    assert out["ok"] is True and out["status"] == "pending"
    record = skills_approvals.registry.get(out["approval_id"])
    assert record["requester"]["tainted"] is True
    opened = await forms.marketplace_publish_open(None)
    assert opened["ok"] is True
    assert windows[-1]["payload"]["requester"]["tainted"] is True


async def test_a_clean_panes_requester_keeps_its_shape(host, windows, audit, caller, monkeypatch) -> None:
    from agent_team_backend.guard import taint

    monkeypatch.setattr(taint, "is_tainted", lambda pane_id: False)
    out = await forms.marketplace_developer_application_fill(None, {"legal_name": "A"}, "")
    record = skills_approvals.registry.get(out["approval_id"])
    assert set(record["requester"]) == {"paneId", "paneName", "workspace", "callerKind"}


def test_a_plugin_request_keeps_the_tainted_flag_of_any_requester() -> None:
    skills_approvals.registry._reset_for_test()
    clean = {"paneId": "p-1", "paneName": "a", "workspace": None, "callerKind": "pane"}
    target = {"id": "a.b", "namespace": "a", "name": "b", "version": "1.0.0", "fromVersion": None}
    first = skills_approvals.registry.request_plugin(
        kind="plugin-install", requester=clean, reason="", target=target, card=None, diff=None)
    assert "tainted" not in first["requester"]
    again = skills_approvals.registry.request_plugin(
        kind="plugin-install", requester={**clean, "paneId": "p-2", "tainted": True}, reason="", target=target,
        card=None, diff=None)
    # The coalesced card names its first requester, and says a tainted pane asked too.
    assert again["approval_id"] == first["approval_id"] and again["requester"]["tainted"] is True
    skills_approvals.registry._reset_for_test()
