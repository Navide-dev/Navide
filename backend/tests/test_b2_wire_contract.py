"""B2-d end to end, backend side, against the shared wire fixture.

The Host side of the same messages is tests/plugins/pluginB2Registry.e2e.test.ts
(a real Registry, the real IPC and the Host's real answers). The two meet in
docs/plugin-contracts/b2-fixtures/host-messages.json:

- every message the backend sends the Host (marketplace.query.request,
  plugins.agent_action.request) has exactly the fixture's shape;
- every Host answer in the fixture (marketplace.query.result,
  plugins.agent_action.result) and every window message in it
  (plugins.agent_request.finish) and Host message (plugin.activity.forget) is
  accepted by the backend's real tools and handlers;
- a rejected request is the window's "no": nothing is ever asked of the Host.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import hmac
import json
import time
import uuid
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, skills_approvals
from agent_team_backend.db import Database
from agent_team_backend.mcp_server import server as mcp
from agent_team_backend.plugins import agent_tools_contract as contract
from agent_team_backend.plugins.audit_log import PluginAuditLog

pytestmark = pytest.mark.asyncio

FIXTURE_PATH = Path(__file__).parents[2] / "docs" / "plugin-contracts" / "b2-fixtures" / "host-messages.json"
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _kind(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def _problems(actual: Any, example: Any, path: str, optional: list[str], nullable: list[str] = ()) -> list[str]:
    """The same rules as the Host test's shapeProblems."""
    if actual is None and path in nullable:
        return []
    if path in FIXTURE["opaque"]:
        return [] if actual is None or isinstance(actual, dict) else [f"{path}: expected an object"]
    if example is None:
        return [] if actual is None or isinstance(actual, str) else [f"{path}: expected null or a string"]
    if _kind(actual) != _kind(example):
        return [f"{path or '(root)'}: expected {_kind(example)}, got {_kind(actual)}"]
    if isinstance(example, list):
        return [] if not example else [p for item in actual for p in _problems(item, example[0], f"{path}[]", optional, nullable)]
    if not isinstance(example, dict):
        return []
    at = (lambda key: f"{path}.{key}" if path else key)
    problems = [f"{at(key)}: not in the fixture" for key in actual if key not in example]
    for key, value in example.items():
        if key not in actual:
            if at(key) not in optional:
                problems.append(f"{at(key)}: missing")
            continue
        problems.extend(_problems(actual[key], value, at(key), optional, nullable))
    return problems


def wire_problems(kind: str, message: Any) -> list[str]:
    entries = FIXTURE["messages"].get(kind)
    if not entries:
        return [f"{kind}: no fixture entry"]
    found = [_problems(message, entry["message"], "", entry.get("optional", []), entry.get("nullable", []))
             for entry in entries]
    return next((p for p in found if not p), min(found, key=len))


def entry(kind: str, name: str) -> dict[str, Any]:
    return copy.deepcopy(next(e["message"] for e in FIXTURE["messages"][kind] if e["name"] == name))


class FixtureHost:
    """Answers the backend with the fixture's own Host messages, and records what it was asked."""

    def __init__(self) -> None:
        self.asked: list[dict[str, Any]] = []
        self.answers: dict[str, dict[str, Any]] = {}

    async def unicast_host(self, event: dict[str, Any]) -> bool:
        self.asked.append(event)
        payload = event["payload"]
        if event["type"] == contract.MARKETPLACE_QUERY_REQUEST_EVENT:
            answer = self.answers.get(payload["query"]["kind"])
            resolve = mcp.resolve_marketplace_query
        else:
            answer = self.answers.get("action")
            resolve = mcp.resolve_plugin_agent_action
        if answer is not None:
            response = {key: value for key, value in answer.items() if key != "request_id"}
            asyncio.get_running_loop().call_soon(resolve, payload["request_id"], response)
        return True


@pytest.fixture
def host(monkeypatch: pytest.MonkeyPatch) -> FixtureHost:
    fake = FixtureHost()
    monkeypatch.setattr(app, "unicast_host", fake.unicast_host)

    async def quiet(_event: dict[str, Any], **_: Any) -> None:
        pass

    monkeypatch.setattr(app, "broadcast", quiet)
    monkeypatch.setattr(app, "broadcast_main_windows", quiet)
    return fake


@pytest.fixture
def audit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> PluginAuditLog:
    log = PluginAuditLog(Database(tmp_path / "navide.db"))
    monkeypatch.setattr(app, "plugin_audit_log", log)
    return log


@pytest.fixture
def pane(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    from agent_team_backend.guard import taint

    agent_messaging._reset_for_test()
    skills_approvals.registry._reset_for_test()
    # The taint store is process-wide; start and end with p-41 clean (S8-M1).
    taint.clear_taint("p-41")
    agent_messaging.register("p-41", "dev", str(tmp_path), agent_key="claude")
    monkeypatch.setattr(mcp, "_resolve_caller", lambda ctx: mcp._Caller(kind="pane", pane_id="p-41"))
    yield
    taint.clear_taint("p-41")
    agent_messaging._reset_for_test()
    skills_approvals.registry._reset_for_test()


@pytest.fixture
def confirmable():
    from agent_team_backend import confirm_token

    confirm_token._reset_for_test("test-confirmation-key")
    yield
    confirm_token._reset_for_test()


def _confirm(action: str, subject: str) -> dict[str, str]:
    nonce = uuid.uuid4().hex
    expiry = str(time.time() + 30)
    payload = "\x00".join(("navide/trust-confirm/v2", nonce, expiry, action, "", subject))
    return {"nonce": nonce, "expires": expiry,
            "mac": hmac.new(b"test-confirmation-key", payload.encode(), hashlib.sha256).hexdigest()}


def _main_window():
    from tests.test_settings_ws_integration import _session

    session = _session()
    session.navide_window = True
    session.ui_bus_ready = True
    session.window_id = "win-a-00000001"
    return session


# ── the fixture itself ──────────────────────────────────────────────────────


def test_the_fixture_catches_a_missing_or_an_extra_field() -> None:
    message = entry("plugins.agent_action.result", "changed")
    assert wire_problems("plugins.agent_action.result", message) == []
    del message["changed"]
    assert wire_problems("plugins.agent_action.result", message)
    assert wire_problems("plugins.agent_action.result", {**entry("plugins.agent_action.result", "changed"), "x": 1})


# ── backend → Host: what the backend sends ──────────────────────────────────


async def test_every_backend_request_has_the_fixture_shape(host, audit, pane) -> None:
    host.answers = {
        "search": entry("marketplace.query.result", "search"),
        "detail": entry("marketplace.query.result", "detail"),
        "installed": entry("marketplace.query.result", "installed"),
        "action": entry("plugins.agent_action.result", "changed"),
    }
    await mcp.marketplace_search(None, "dev map")
    await mcp.marketplace_search(None, "dev map", category="productivity", cursor="c1", limit=5)
    await mcp.marketplace_detail(None, "nerdtechnic.devmap")
    await mcp.marketplace_detail(None, "nerdtechnic.devmap", "0.2.0")
    await mcp.plugins_list_installed(None)
    await mcp.plugins_disable(None, "nerdtechnic", "devmap")
    kinds = {event["type"] for event in host.asked}
    assert kinds == {contract.MARKETPLACE_QUERY_REQUEST_EVENT, contract.PLUGIN_AGENT_ACTION_REQUEST_EVENT}
    for event in host.asked:
        assert wire_problems(event["type"], event["payload"]) == [], event


# ── Host → backend: what the backend accepts ────────────────────────────────


def _body(fenced: str) -> str:
    """The text inside one external-content fence (ids and versions are the
    publisher's, so the backend always fences them)."""
    return fenced.split("\n")[-2]


@pytest.mark.parametrize("name", ["search", "detail", "installed"])
async def test_every_fixture_query_result_is_accepted(host, audit, pane, name) -> None:
    host.answers = {name: entry("marketplace.query.result", name)}
    if name == "search":
        out = await mcp.marketplace_search(None, "dev map")
        assert [_body(item["id"]) for item in out["items"]] == ["nerdtechnic.devmap"]
    elif name == "detail":
        out = await mcp.marketplace_detail(None, "nerdtechnic.devmap", "0.2.0")
        assert [_body(version) for version in out["versions"]] == ["0.1.0", "0.2.0"]
    else:
        out = await mcp.plugins_list_installed(None)
        assert [_body(item["id"]) for item in out["items"]] == ["nerdtechnic.devmap"]
    assert out["ok"] is True, out


async def test_a_fixture_query_error_is_passed_on(host, audit, pane) -> None:
    host.answers = {"detail": entry("marketplace.query.result", "error")}
    out = await mcp.marketplace_detail(None, "nerdtechnic.devmap")
    assert out["ok"] is False and out["error_code"] == "NOT_FOUND"


@pytest.mark.parametrize("name", ["changed", "refused"])
async def test_every_fixture_action_result_is_accepted(host, audit, pane, name) -> None:
    host.answers = {"action": entry("plugins.agent_action.result", name)}
    out = await mcp.plugins_disable(None, "nerdtechnic", "devmap")
    if name == "changed":
        assert out == {"ok": True, "pluginId": "nerdtechnic.devmap", "pluginVersion": "0.2.0",
                       "disabled": True, "changed": True}
    else:
        assert out == {"ok": False, "error_code": "BUILTIN_PLUGIN",
                       "error": "the bundled Navide plugins are disabled and enabled by the user in Extensions"}


def test_the_fixture_accepts_null_only_where_an_entry_lists_it() -> None:
    message = entry("plugins.agent_action.result", "approval-required")
    assert wire_problems("plugins.agent_action.result", message) == []
    assert wire_problems("plugins.agent_action.result", {**message, "disabled": {**message["disabled"], "at": None}}) == []
    assert wire_problems("plugins.agent_action.result", {**message, "disabled": {**message["disabled"], "by": None}})
    assert wire_problems("plugins.agent_action.result", {**message, "pluginVersion": None})
    # Nullable is null or the example's type, never another type.
    assert wire_problems("plugins.agent_action.result", {**message, "disabled": {**message["disabled"], "at": "x"}})


async def test_the_fixture_approval_required_files_a_plugin_enable_request(host, audit, pane) -> None:
    """B2-c option B: the Host refuses to enable a package the user disabled;
    the backend files a plugin-enable request for the user instead."""
    host.answers = {
        "action": entry("plugins.agent_action.result", "approval-required"),
        "detail": entry("marketplace.query.result", "detail"),
    }
    out = await mcp.plugins_enable(None, "nerdtechnic", "devmap")
    assert out["ok"] is False and out["error_code"] == "APPROVAL_REQUIRED"
    assert out["status"] == "pending" and isinstance(out["approval_id"], str)
    # The Host was asked to enable, in the fixture's request shape, and nothing else acted.
    actions = [e["payload"] for e in host.asked if e["type"] != contract.MARKETPLACE_QUERY_REQUEST_EVENT]
    assert [a["action"] for a in actions] == ["enable"]
    assert wire_problems("plugins.agent_action.request", actions[0]) == []
    record = skills_approvals.registry.get(out["approval_id"])
    assert record is not None and record["kind"] == "plugin-enable" and record["status"] == "pending"
    assert record["target"]["id"] == "nerdtechnic.devmap" and record["target"]["version"] == "0.2.0"
    # Host time is Unix ms; the record keeps Unix seconds.
    assert record["disabled"] == {"by": "user", "at": 1760000000.0, "agent": None}


# ── window and Host messages to the backend ─────────────────────────────────


async def test_the_fixture_finish_is_what_the_backend_accepts_and_a_rejection_asks_nothing(
    host, audit, pane, confirmable,
) -> None:
    from tests.test_settings_ws_integration import _request as ws_request

    host.answers = {"installed": {"request_id": "x", "ok": True, "result": {"kind": "installed", "items": []}},
                    "detail": entry("marketplace.query.result", "detail")}
    session = _main_window()
    decide = contract.PLUGIN_APPROVAL_DECIDE_ACTION
    finish = contract.PLUGIN_APPROVAL_FINISH_ACTION

    # Rejected in the window: the request ends there, and the Host is never asked to act.
    rejected = await mcp.marketplace_request_install(None, "nerdtechnic", "devmap", "0.2.0", "why")
    answer = await ws_request(session, decide, {"approval_id": rejected["approval_id"], "approve": False,
                                                "confirmation": _confirm(decide, f"{rejected['approval_id']}:reject")})
    assert answer["payload"]["approval"]["status"] == "rejected"
    assert (await mcp.marketplace_request_status(None, rejected["approval_id"]))["status"] == "rejected"

    # Approved: the window's finish, in the fixture's shape, completes it.
    approved = await mcp.marketplace_request_install(None, "nerdtechnic", "devmap", "0.1.0", "why")
    approval_id = approved["approval_id"]
    answer = await ws_request(session, decide, {"approval_id": approval_id, "approve": True,
                                                "confirmation": _confirm(decide, f"{approval_id}:approve")})
    assert answer["payload"]["approval"]["status"] == "applying"
    message = entry("plugins.agent_request.finish", "completed")
    message.update(approval_id=approval_id, confirmation=_confirm(finish, f"{approval_id}:completed"))
    assert wire_problems(finish, message) == []
    done = await ws_request(session, finish, message)
    assert done["payload"]["approval"]["status"] == "completed"

    assert contract.PLUGIN_AGENT_ACTION_REQUEST_EVENT not in {event["type"] for event in host.asked}


async def test_the_fixture_activity_forget_is_what_the_backend_accepts(host, audit, monkeypatch) -> None:
    from tests.test_settings_ws_integration import _request as ws_request, _session

    forgotten: list[str] = []
    real = audit.forget_plugin

    def spy(plugin_id: str) -> None:
        forgotten.append(plugin_id)
        real(plugin_id)

    monkeypatch.setattr(audit, "forget_plugin", spy)
    session = _session()
    message = entry("plugin.activity.forget", "removed")
    # Only the authenticated Host session.
    refused = await ws_request(session, contract.PLUGIN_ACTIVITY_FORGET_MESSAGE, message)
    assert refused["error"]["code"] == "UNAUTHORIZED" and forgotten == []
    session.host_authenticated = True
    accepted = await ws_request(session, contract.PLUGIN_ACTIVITY_FORGET_MESSAGE, message)
    assert accepted["payload"] == {"ok": True}
    assert forgotten == ["nerdtechnic.devmap"]
