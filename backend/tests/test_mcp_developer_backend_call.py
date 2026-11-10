"""plugins_developer_backend_call: the Developer Mode backend call (0.2.40).

What these pin: the request the Host receives (operation developerBackend,
the credential-checked caller, the call payload), the answer passed back,
the Host's refusals passed through with their codes, argument checks made
before anything is sent, and one activity row per call, ok or not, that the
automatic-pause rules count (a tool-call row of the plugin).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import developer_backend_tool, server as core, wiring


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    agent_messaging.register("pa", "dev", "/ws/alpha", agent_key="claude")
    yield
    agent_messaging._reset_for_test()


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


class FakeHost:
    def __init__(self, answer: dict[str, Any] | None) -> None:
        self.answer = answer
        self.requests: list[dict[str, Any]] = []

    async def unicast_host(self, event: dict[str, Any]) -> bool:
        if event["type"] != "agent.capability.request":
            return True
        request = event["payload"]
        self.requests.append(request)
        if self.answer is not None:
            answer = {"reqId": request["payload"]["reqId"], **self.answer}
            asyncio.get_running_loop().call_soon(core.resolve_agent_capability, request["request_id"], answer)
        return True


class FakeAudit:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    def record_tool_call(self, **row: Any) -> int:
        self.rows.append(row)
        return len(self.rows)


@pytest.fixture
def audit(monkeypatch: pytest.MonkeyPatch) -> FakeAudit:
    log = FakeAudit()
    monkeypatch.setattr(app, "plugin_audit_log", log)
    return log


def _host(monkeypatch: pytest.MonkeyPatch, answer: dict[str, Any] | None) -> FakeHost:
    fake = FakeHost(answer)
    monkeypatch.setattr(app, "unicast_host", fake.unicast_host)
    return fake


@pytest.mark.asyncio
async def test_a_call_reaches_the_host_and_is_recorded(monkeypatch: pytest.MonkeyPatch, audit: FakeAudit) -> None:
    host = _host(monkeypatch, {"ok": True, "result": {"rows": 3}, "packageVersion": "0.1.0"})
    answer = await developer_backend_tool.plugins_developer_backend_call(
        "acme.todo", "todo.count", _ctx(), arguments={"open": True},
    )
    assert answer == {"ok": True, "pluginId": "acme.todo", "pluginVersion": "0.1.0", "method": "todo.count",
                      "result": {"rows": 3}}
    request = host.requests[0]
    assert request["operation"] == "developerBackend"
    assert request["target"] == {"plugin_id": "acme.todo", "workspace_path": "/ws/alpha"}
    assert request["caller"] == {"kind": "pane", "paneId": "pa", "workspace": "/ws/alpha", "verifiedTo": "pane"}
    assert request["payload"] == {"reqId": request["request_id"], "name": "todo.count", "args": {"open": True},
                                  "timeoutMs": 30_000}
    [row] = audit.rows
    assert (row["tool"], row["plugin_id"], row["plugin_version"], row["outcome"], row["risk"]) == (
        "plugins_developer_backend_call", "acme.todo", "0.1.0", "ok", "write")
    assert row["arguments"] == {"method": "todo.count", "arguments": {"open": True}}
    assert (row["caller_kind"], row["pane_id"], row["pane_name"], row["target_workspace"]) == ("pane", "pa", "dev", "/ws/alpha")


@pytest.mark.asyncio
async def test_a_host_refusal_comes_back_with_its_code_and_is_recorded(
    monkeypatch: pytest.MonkeyPatch, audit: FakeAudit,
) -> None:
    _host(monkeypatch, {"ok": False, "error": {"code": "NOT_DEVELOPER_PLUGIN", "message": "Only a folder plugin."}})
    answer = await developer_backend_tool.plugins_developer_backend_call("acme.todo", "todo.count", _ctx())
    assert answer == {"ok": False, "error": "Only a folder plugin.", "error_code": "NOT_DEVELOPER_PLUGIN"}
    [row] = audit.rows
    assert (row["outcome"], row["error_code"], row["plugin_version"]) == ("error", "NOT_DEVELOPER_PLUGIN", "")


@pytest.mark.asyncio
async def test_a_host_that_is_not_connected_is_an_error(monkeypatch: pytest.MonkeyPatch, audit: FakeAudit) -> None:
    async def offline(_event: dict[str, Any]) -> bool:
        return False

    monkeypatch.setattr(app, "unicast_host", offline)
    answer = await developer_backend_tool.plugins_developer_backend_call("acme.todo", "todo.count", _ctx())
    assert answer["error_code"] == "HOST_UNAVAILABLE"
    assert audit.rows[0]["outcome"] == "error"


@pytest.mark.asyncio
@pytest.mark.parametrize("kwargs", [
    {"arguments": ["not", "an", "object"]},
    {"timeout_ms": 0},
    {"timeout_ms": 120_001},
    {"timeout_ms": True},
])
async def test_bad_arguments_are_refused_before_anything_is_sent(
    monkeypatch: pytest.MonkeyPatch, audit: FakeAudit, kwargs: dict[str, Any],
) -> None:
    host = _host(monkeypatch, {"ok": True, "result": None})
    answer = await developer_backend_tool.plugins_developer_backend_call("acme.todo", "m", _ctx(), **kwargs)
    assert answer["error_code"] == "BAD_REQUEST"
    assert host.requests == [] and audit.rows == []


@pytest.mark.asyncio
async def test_an_explicit_workspace_is_the_target(monkeypatch: pytest.MonkeyPatch, audit: FakeAudit) -> None:
    host = _host(monkeypatch, {"ok": True, "result": None, "packageVersion": "0.1.0"})
    await developer_backend_tool.plugins_developer_backend_call(
        "acme.todo", "m", _ctx(), workspace_path="/ws/beta", timeout_ms=5000,
    )
    assert host.requests[0]["target"]["workspace_path"] == "/ws/beta"
    assert host.requests[0]["payload"]["timeoutMs"] == 5000


def test_the_tool_is_registered_last() -> None:
    names = [tool.name for tool in core.server._tool_manager.list_tools()]  # noqa: SLF001
    core_names = [name for name in names if not name.startswith(("plan_", "skills_"))]
    assert core_names[-2:] == ["cli_rename_pane", "plugins_developer_backend_call"]
