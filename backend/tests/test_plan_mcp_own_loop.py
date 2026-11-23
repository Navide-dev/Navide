"""/plan-mcp keeps answering the CLIs while the main event loop is stuck.

2026-11-12: a mass restore made every /plan-mcp request take 20–57 s on the
shared loop and thirteen panes gave up connecting. 2026-11-15: the loop
stalled 360 s and 188 s and 65 of 66 panes lost the connection they had.
own_loop serves the endpoint from a thread with its own loop: connecting
(tools/list) no longer waits for the main loop, and a tool call still runs on
the main loop, where the state it reads lives.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
import urllib.error
import urllib.request
from typing import Any

import pytest

from agent_team_backend.mcp_server import auth as plan_mcp_auth, own_loop, server as plan_mcp, wiring as plan_mcp_wiring

_HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}


def _post(port: int, body: dict[str, Any], host: str = "") -> tuple[int, Any, float]:
    """A blocking POST, from whatever thread calls it: (status, json, seconds)."""
    url = f"http://127.0.0.1:{port}/plan-mcp?client=host&t={plan_mcp_auth.internal_token()}"
    headers = dict(_HEADERS)
    if host:
        headers["host"] = host
    request = urllib.request.Request(url, json.dumps(body).encode(), headers)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read() or b"null"), time.monotonic() - started
    except urllib.error.HTTPError as err:
        return err.code, None, time.monotonic() - started


def _in_thread(fn: Any, *args: Any) -> tuple[threading.Thread, list[Any]]:
    out: list[Any] = []
    thread = threading.Thread(target=lambda: out.append(fn(*args)), daemon=True)
    thread.start()
    return thread, out


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


async def test_the_clis_are_wired_to_its_port_while_it_runs(served: int) -> None:
    assert plan_mcp_wiring.plan_mcp_url(4242, "p1").startswith(f"http://127.0.0.1:{served}/plan-mcp?")
    await own_loop.stop()
    assert plan_mcp_wiring.plan_mcp_url(4242, "p1").startswith("http://127.0.0.1:4242/plan-mcp?")


async def test_tools_list_is_answered_while_the_main_loop_is_blocked(served: int) -> None:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    assert _post(served, body)[0] == 200  # warm

    thread, out = _in_thread(_post, served, body)
    time.sleep(3.0)  # the main loop (this test's) is stuck for 3 s
    thread.join(10)

    status, document, seconds = out[0]
    assert status == 200
    assert document["result"]["tools"]
    assert seconds < 2.0, f"tools/list waited {seconds:.1f}s for the blocked main loop"


async def test_a_tool_call_runs_on_the_main_loop(served: int) -> None:
    ran_on: list[int] = []

    def where_am_i() -> str:
        """Test-only tool."""
        ran_on.append(threading.get_ident())
        return "here"

    plan_mcp.server.add_tool(where_am_i)
    try:
        body = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {"name": "where_am_i", "arguments": {}}}
        thread, out = _in_thread(_post, served, body)
        # Let the main loop run so the call can land on it.
        for _ in range(200):
            if out:
                break
            await asyncio.sleep(0.02)
        thread.join(10)
    finally:
        plan_mcp.server.remove_tool("where_am_i")
        plan_mcp.server._mcp_server._tool_cache.pop("where_am_i", None)  # noqa: SLF001

    status, document, _ = out[0]
    assert status == 200, document
    assert document["result"]["content"][0]["text"] == "here"
    assert ran_on == [threading.get_ident()]


async def test_a_foreign_host_and_other_paths_are_refused(served: int) -> None:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    thread, out = _in_thread(_post, served, body, f"evil.example:{served}")
    while thread.is_alive():
        await asyncio.sleep(0.02)
    assert out[0][0] == 403

    def get_root() -> int:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{served}/ws", timeout=10) as response:
                return response.status
        except urllib.error.HTTPError as err:
            return err.code

    thread, out = _in_thread(get_root)
    while thread.is_alive():
        await asyncio.sleep(0.02)
    assert out[0] == 404


async def test_it_stays_off_unless_enabled() -> None:
    assert own_loop._enabled is False
    assert await own_loop.start() is None
    assert own_loop.port() is None
