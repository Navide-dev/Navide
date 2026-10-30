"""Authenticated Host handoff for agent-initiated plugin capabilities."""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app, ws_handlers
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server.server import _Caller, request_host_agent_capability, request_host_agent_workspace_backend


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_host_register_requires_the_backend_host_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "_HOST_SESSION_TOKEN", "host-secret")
    monkeypatch.setenv("NAVIDE_BACKEND_HOST_TOKEN", "wrong-child-visible-token")
    session = _session()

    await app.handle_message(session, {
        "id": "bad-host",
        "type": "host.register",
        "payload": {"token": "wrong"},
    })
    assert session.host_authenticated is False
    assert session.websocket.sent[-1]["error"]["code"] == "UNAUTHORIZED"  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "good-host",
        "type": "host.register",
        "payload": {"token": "host-secret"},
    })
    assert session.host_authenticated is True
    assert session.websocket.sent[-1]["payload"] == {"registered": True}  # type: ignore[attr-defined]


def test_host_token_matching_uses_the_private_copy_not_child_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "_HOST_SESSION_TOKEN", "host-secret")
    monkeypatch.setenv("NAVIDE_BACKEND_HOST_TOKEN", "wrong-child-visible-token")

    assert app.host_session_token_matches("host-secret") is True
    assert app.host_session_token_matches("wrong-child-visible-token") is False


@pytest.mark.asyncio
async def test_without_a_stdin_host_token_host_register_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """R3-M2: a backend nobody handed a token on stdin (tests, run by hand)
    refuses host.register; the token set from stdin is accepted."""
    monkeypatch.setattr(app, "_HOST_SESSION_TOKEN", "")
    session = _session()
    await app.handle_message(session, {
        "id": "none", "type": "host.register", "payload": {"token": ""},
    })
    assert session.host_authenticated is False

    app.set_host_session_token("from-stdin")
    await app.handle_message(session, {
        "id": "stdin", "type": "host.register", "payload": {"token": "from-stdin"},
    })
    assert session.host_authenticated is True


def test_the_spawn_environment_is_never_a_source_of_the_host_token() -> None:
    """R3-M2: the variable is only scrubbed. A fresh interpreter importing app
    with NAVIDE_BACKEND_HOST_TOKEN set must neither adopt it nor keep it."""
    import os
    import subprocess
    import sys

    script = (
        "import os\n"
        "from agent_team_backend import app\n"
        "print(repr(app._HOST_SESSION_TOKEN), 'NAVIDE_BACKEND_HOST_TOKEN' in os.environ)\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", script],
        env={**os.environ, "NAVIDE_BACKEND_HOST_TOKEN": "env-visible"},
        capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip().splitlines()[-1] == "'' False"


@pytest.mark.asyncio
async def test_unicast_host_skips_unauthenticated_sessions() -> None:
    unauthenticated = _session()
    authenticated = _session()
    authenticated.host_authenticated = True
    previous = set(app._SESSIONS)
    app._SESSIONS.clear()
    app._SESSIONS.update({unauthenticated, authenticated})
    try:
        assert await app.unicast_host({"type": "agent.capability.request"}) is True
        assert unauthenticated.websocket.sent == []  # type: ignore[attr-defined]
        assert authenticated.websocket.sent == [{"type": "agent.capability.request"}]  # type: ignore[attr-defined]
    finally:
        app._SESSIONS.clear()
        app._SESSIONS.update(previous)


@pytest.mark.asyncio
async def test_mcp_handoff_registers_before_host_notification_and_keeps_identity_host_owned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, Any]] = []

    async def fake_unicast_host(event: dict[str, Any]) -> bool:
        events.append(event)
        request = event["payload"]
        assert "initiator" not in request
        assert request["instance_id"] == "view-1"
        assert plan_mcp.resolve_agent_capability(request["request_id"], {"ok": True, "result": "done"})
        return True

    monkeypatch.setattr(app, "unicast_host", fake_unicast_host)
    result = await request_host_agent_capability(
        "view-1",
        "capability",
        {"reqId": "agent-1", "ns": "fs", "method": "readFile", "args": {"path": "a"}},
        caller=_Caller(kind="external"),
    )

    assert result == {"ok": True, "result": "done"}
    assert len(events) == 1
    assert set(events[0]["payload"]) == {"request_id", "instance_id", "operation", "payload"}
    assert plan_mcp._agent_capability_pending.pending == {}


@pytest.mark.parametrize("response", [
    {"ok": True, "result": {"rel_path": ".agent-team/plans/example.html", "name": "Example"}},
    {"ok": False, "error": {"code": "PERMISSION_DENIED", "message": "Agent filesystem access denied"}},
])
async def test_new_core_workspace_handoff_uses_the_single_authenticated_host_channel(
    monkeypatch: pytest.MonkeyPatch, response: dict[str, Any],
) -> None:
    events: list[dict[str, Any]] = []
    call = {"reqId": "plans-1", "name": "plans.read", "args": {"rel_path": ".agent-team/plans/example.html"}}

    async def host_reply(event: dict[str, Any]) -> bool:
        events.append(event)
        payload = event["payload"]
        assert payload["target"] == {"plugin_id": "navide.plans", "workspace_path": "/workspace"}
        assert payload["operation"] == "backend"
        assert payload["payload"] == call
        assert set(payload) == {"request_id", "target", "operation", "payload"}
        assert plan_mcp.resolve_agent_capability(payload["request_id"], response)
        return True

    monkeypatch.setattr(app, "unicast_host", host_reply)
    result = await request_host_agent_workspace_backend(
        "navide.plans", "/workspace", call, caller=_Caller(kind="external"),
    )
    assert result == response
    assert len(events) == 1
    assert plan_mcp._agent_capability_pending.pending == {}


@pytest.mark.asyncio
async def test_agent_capability_result_requires_an_authenticated_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _session()
    resolved: list[tuple[str, dict[str, Any]]] = []

    def resolve(request_id: str, result: dict[str, Any]) -> bool:
        resolved.append((request_id, result))
        return True

    monkeypatch.setattr(plan_mcp, "resolve_agent_capability", resolve)
    await app.handle_message(session, {
        "id": "unauth-result",
        "type": "agent.capability.result",
        "payload": {"request_id": "mcp:1", "response": {"ok": True}},
    })
    assert resolved == []
    assert session.websocket.sent[-1]["error"]["code"] == "UNAUTHORIZED"  # type: ignore[attr-defined]

    session.host_authenticated = True
    await app.handle_message(session, {
        "id": "extra-result",
        "type": "agent.capability.result",
        "payload": {"request_id": "mcp:1", "response": {"ok": True}, "initiator": "forged"},
    })
    assert resolved == []
    assert session.websocket.sent[-1]["error"]["code"] == "BAD_REQUEST"  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "auth-result",
        "type": "agent.capability.result",
        "payload": {"request_id": "mcp:1", "response": {"ok": True}},
    })
    assert resolved == [("mcp:1", {"ok": True})]
    assert session.websocket.sent[-1]["payload"] == {"ok": True, "delivered": True}  # type: ignore[attr-defined]


# The Host gives a backend call its own deadline (payload ``timeoutMs``, else
# 30 s) and reports that timeout itself; the MCP side must still be listening.
_HOST_DEFAULT_BACKEND_DEADLINE_S = 30.0


async def _waited_timeout(monkeypatch: pytest.MonkeyPatch, call) -> float:
    from agent_team_backend.pending_registry import TIMEOUT

    waits: list[float] = []

    async def host_silent(event: dict[str, Any]) -> bool:
        return True

    async def fake_wait(request_id: str, future: Any, *, timeout: float) -> Any:
        waits.append(timeout)
        return TIMEOUT

    monkeypatch.setattr(app, "unicast_host", host_silent)
    monkeypatch.setattr(plan_mcp._agent_capability_pending, "wait", fake_wait)
    result = await call()
    assert result["error_code"] == "host_timeout"
    assert len(waits) == 1
    return waits[0]


def _routes(payload: dict[str, Any]):
    return [
        lambda: request_host_agent_capability(
            "view-1", "backend", payload, caller=_Caller(kind="external"),
        ),
        lambda: request_host_agent_workspace_backend(
            "navide.plans", "/workspace", payload, caller=_Caller(kind="external"),
        ),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("route", [0, 1])
async def test_mcp_outwaits_the_host_default_backend_deadline(
    monkeypatch: pytest.MonkeyPatch, route: int,
) -> None:
    payload = {"reqId": "plans-1", "name": "plans.list", "args": {}}
    waited = await _waited_timeout(monkeypatch, _routes(payload)[route])
    assert waited > _HOST_DEFAULT_BACKEND_DEADLINE_S


@pytest.mark.asyncio
@pytest.mark.parametrize("route", [0, 1])
async def test_mcp_outwaits_a_caller_supplied_backend_deadline(
    monkeypatch: pytest.MonkeyPatch, route: int,
) -> None:
    payload = {"reqId": "plans-1", "name": "plans.list", "args": {}, "timeoutMs": 90_000}
    waited = await _waited_timeout(monkeypatch, _routes(payload)[route])
    assert waited > 90.0


@pytest.mark.asyncio
async def test_a_workspace_backend_request_names_the_pane_only_when_asked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, Any]] = []
    call = {"reqId": "plans-2", "name": "plans.add_note", "args": {"rel_path": ".agent-team/plans/example.html"}}

    async def host_reply(event: dict[str, Any]) -> bool:
        events.append(event["payload"])
        assert plan_mcp.resolve_agent_capability(event["payload"]["request_id"], {"ok": True, "result": {}})
        return True

    monkeypatch.setattr(app, "unicast_host", host_reply)
    await request_host_agent_workspace_backend(
        "navide.plans", "/workspace", call, caller=_Caller(kind="pane", pane_id="p-1"), pane="Reviewer",
    )
    await request_host_agent_workspace_backend(
        "navide.plans", "/workspace", call, caller=_Caller(kind="pane", pane_id="p-1"),
    )

    assert set(events[0]) == {"request_id", "target", "operation", "payload", "pane"}
    assert events[0]["pane"] == "Reviewer" and events[0]["operation"] == "backend"
    # Without it the request is exactly what an older Host accepts.
    assert set(events[1]) == {"request_id", "target", "operation", "payload"}
