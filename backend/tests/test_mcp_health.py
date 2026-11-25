"""/plan-mcp health: initialize outcomes and the main process' probe verdict
(2026-11-08: every new MCP connection failed at initialize for hours while
nothing showed it), and the soft recovery a "down" verdict starts: the
listener's own thread and loop restarted, no pane touched."""

from __future__ import annotations

import asyncio
import json
import logging
import urllib.error
import urllib.request
from typing import Any

import pytest

from agent_team_backend.mcp_server import auth as plan_mcp_auth, health, own_loop, server as plan_mcp

_INITIALIZE = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}}


@pytest.fixture(autouse=True)
def _clean() -> Any:
    health._reset_for_tests()
    yield
    health._reset_for_tests()


def _post(port: int, body: dict[str, Any]) -> tuple[int, Any]:
    url = f"http://127.0.0.1:{port}/plan-mcp?client=host&t={plan_mcp_auth.internal_token()}"
    request = urllib.request.Request(url, json.dumps(body).encode(), {
        "accept": "application/json, text/event-stream", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"null")


@pytest.fixture()
async def served(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr(own_loop, "_enabled", True)
    await plan_mcp.startup()
    port = await own_loop.start()
    assert port is not None
    try:
        yield port
    finally:
        await own_loop.stop()
        await plan_mcp.shutdown()


async def test_initialize_outcomes_are_counted(served: int, monkeypatch: pytest.MonkeyPatch,
                                               caplog: pytest.LogCaptureFixture) -> None:
    assert (await asyncio.to_thread(_post, served, _INITIALIZE))[0] == 200
    assert health.snapshot()["initialize_last_ok_at"] is not None

    def broken(*_a: Any, **_k: Any) -> Any:
        raise RuntimeError("server_version is None")

    monkeypatch.setattr(plan_mcp.server._mcp_server, "create_initialization_options", broken)  # noqa: SLF001
    with caplog.at_level(logging.WARNING):
        status, document = await asyncio.to_thread(_post, served, _INITIALIZE)
        await asyncio.to_thread(_post, served, _INITIALIZE)
    assert status >= 500
    # The CLI's error carries the cause and the way back.
    assert plan_mcp.RECOVERY_HINT in document["error"]["message"]
    snap = health.snapshot()
    assert snap["initialize_failures"] == 2
    assert snap["initialize_consecutive_failures"] == 2
    assert "event=initialize_failed total=2 consecutive=2" in caplog.text

    monkeypatch.undo()
    assert (await asyncio.to_thread(_post, served, _INITIALIZE))[0] == 200
    assert health.snapshot()["initialize_consecutive_failures"] == 0
    assert health.snapshot()["initialize_failures"] == 2


async def test_health_route_carries_the_mcp_block() -> None:
    from agent_team_backend import app

    body = await app.health()
    assert body["mcp"]["initialize_failures"] == 0
    assert "port" in body["mcp"]
    # Counters and a port only: no credential, no path.
    assert all(not isinstance(v, str) for k, v in body["mcp"].items() if k != "probe_state")


async def test_a_down_verdict_restarts_mcp_once_and_ok_disarms_the_notice(
        monkeypatch: pytest.MonkeyPatch) -> None:
    restarts: list[int] = []
    notices: list[int] = []

    async def fake_restart() -> dict[str, Any]:
        restarts.append(1)
        return {"ok": True, "port": 1, "joined": True}

    class FakeManager:
        async def notify_mcp_endpoint_down(self) -> None:
            notices.append(1)

    monkeypatch.setattr(own_loop, "restart", fake_restart)
    monkeypatch.setattr(health, "NOTICE_GRACE_S", 0.05)
    monkeypatch.setattr("agent_team_backend.channels.get_manager", lambda: FakeManager())

    out = await health.handle_report("down", 3, "timeout")
    assert out["changed"] and out["soft_restart"]["ok"]
    # Every window reports the same verdict: only the first restarts.
    assert (await health.handle_report("down", 4))["changed"] is False
    assert restarts == [1]
    assert (await health.handle_report("ok", 0))["changed"]
    await asyncio.sleep(0.15)
    assert notices == []


async def test_still_down_after_the_grace_tells_the_main_bot_once(monkeypatch: pytest.MonkeyPatch) -> None:
    notices: list[int] = []

    async def fake_restart() -> dict[str, Any]:
        return {"ok": True, "port": 1, "joined": True}

    class FakeManager:
        async def notify_mcp_endpoint_down(self) -> None:
            notices.append(1)

    monkeypatch.setattr(own_loop, "restart", fake_restart)
    monkeypatch.setattr(health, "NOTICE_GRACE_S", 0.05)
    monkeypatch.setattr("agent_team_backend.channels.get_manager", lambda: FakeManager())

    await health.handle_report("down", 3)
    await health.handle_report("down", 5)
    await asyncio.sleep(0.2)
    assert notices == [1]


async def test_a_flapping_verdict_does_not_restart_mcp_over_and_over(monkeypatch: pytest.MonkeyPatch) -> None:
    restarts: list[int] = []

    async def fake_restart() -> dict[str, Any]:
        restarts.append(1)
        return {"ok": True, "port": 1, "joined": True}

    monkeypatch.setattr(own_loop, "restart", fake_restart)
    monkeypatch.setattr("agent_team_backend.channels.get_manager", lambda: None)
    for _ in range(3):
        await health.handle_report("down", 3)
        await health.handle_report("degraded", 1)
    assert restarts == [1]


async def test_a_degraded_verdict_restarts_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fail() -> dict[str, Any]:
        raise AssertionError("no restart on degraded")

    monkeypatch.setattr(own_loop, "restart", fail)
    out = await health.handle_report("degraded", 1, "timeout")
    assert out == {"changed": True, "state": "degraded"}


def test_an_unknown_verdict_is_refused() -> None:
    with pytest.raises(ValueError):
        health.report("broken", 1)


def _probe_post(port: int, body: dict[str, Any], token: str) -> tuple[int, Any]:
    request = urllib.request.Request(f"http://127.0.0.1:{port}/plan-mcp?client=probe", json.dumps(body).encode(), {
        "accept": "application/json, text/event-stream", "content-type": "application/json",
        "authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as err:
        return err.code, None


async def test_the_probe_credential_initializes_but_calls_no_tool(served: int,
                                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import app

    token = "probe-" + "x" * 24  # built at run time, not a real token
    monkeypatch.setattr(app, "_HOST_SESSION_TOKEN", token)

    status, document = await asyncio.to_thread(_probe_post, served, _INITIALIZE, token)
    assert status == 200 and document["result"]["serverInfo"]["name"]

    assert (await asyncio.to_thread(_probe_post, served, _INITIALIZE, token + "y"))[0] == 401

    call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "cli_whoami", "arguments": {}}}
    status, document = await asyncio.to_thread(_probe_post, served, call, token)
    text = json.dumps(document)
    assert "probe credential cannot call tools" in text


async def test_no_probe_credential_without_a_host_session(served: int, monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import app

    monkeypatch.setattr(app, "_HOST_SESSION_TOKEN", "")
    assert (await asyncio.to_thread(_probe_post, served, _INITIALIZE, ""))[0] == 401
