"""cli_open_agent carries the caller's taint into the pane it opens."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.guard import is_tainted, mark_tainted
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    async def fake_broadcast(_event: dict[str, Any], **_kwargs: Any) -> None:
        pass

    monkeypatch.setattr(app, "broadcast", fake_broadcast)


def _ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


async def _window(child: str) -> None:
    for _ in range(400):
        keys = list(plan_mcp._pending_spawns)
        if keys:
            agent_messaging.register(child, "helper", "/ws/alpha")
            plan_mcp.resolve_spawn(keys[0], {"ok": True, "pane_id": child, "name": "helper"})
            plan_mcp.resolve_kickoff(keys[0], {"pane_id": child, "kickoff": "sent"})
            return
        await asyncio.sleep(0.005)
    raise AssertionError("no spawn request")


async def _open(caller: str, child: str) -> dict[str, Any]:
    task = asyncio.create_task(_window(child))
    result = await plan_mcp.cli_open_agent("claude", "helper", "do the thing", _ctx(caller))
    await task
    return result


async def test_a_tainted_caller_taints_the_pane_it_opens() -> None:
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    mark_tainted("pa", "remote", "chat message")
    assert (await _open("pa", "child-1"))["ok"] is True
    assert is_tainted("child-1")


async def test_an_untainted_caller_opens_an_untainted_pane() -> None:
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    assert (await _open("pa", "child-2"))["ok"] is True
    assert not is_tainted("child-2")
