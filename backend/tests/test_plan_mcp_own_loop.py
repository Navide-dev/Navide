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
import sys
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


# ── restart: the MCP health probe's soft recovery ───────────────────────────

_INITIALIZE = {"jsonrpc": "2.0", "id": 9, "method": "initialize", "params": {
    "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}}


async def _post_off_loop(port: int, body: dict[str, Any]) -> tuple[int, Any, float]:
    return await asyncio.to_thread(_post, port, body)


#: Windows cannot restart the listener on a new loop (own_loop's docstring):
#: there every restart test checks that it says so and changes nothing.
WINDOWS = sys.platform == "win32"


async def _restart_is_refused_and_nothing_breaks(served: int) -> None:
    thread = own_loop._state.thread  # noqa: SLF001
    assert await own_loop.restart() == {"ok": False, "reason": "unsupported-platform"}
    assert own_loop._state.thread is thread and thread.is_alive()  # noqa: SLF001
    assert own_loop.port() == served
    status, document, _ = await _post_off_loop(served, _INITIALIZE)
    assert status == 200
    assert document["result"]["serverInfo"]["name"]


async def test_where_restart_is_unsupported_it_says_so_and_keeps_serving(
        served: int, monkeypatch: pytest.MonkeyPatch) -> None:
    """Windows' path, run on every platform."""
    monkeypatch.setattr(own_loop, "_SOFT_RESTART_SUPPORTED", False)
    await _restart_is_refused_and_nothing_breaks(served)
    await _call_after_restart_tool(served)


async def test_restart_keeps_the_port_and_answers_again(served: int) -> None:
    assert (await _post_off_loop(served, _INITIALIZE))[0] == 200
    if WINDOWS:
        await _restart_is_refused_and_nothing_breaks(served)
        return
    old_thread = own_loop._state.thread  # noqa: SLF001

    result = await own_loop.restart()

    assert result == {"ok": True, "port": served, "joined": True}
    assert own_loop.port() == served
    assert own_loop._state.thread is not old_thread  # noqa: SLF001
    assert not old_thread.is_alive()
    status, document, _ = await _post_off_loop(served, _INITIALIZE)
    assert status == 200
    assert document["result"]["serverInfo"]["name"]
    # The CLIs' wired URL is unchanged.
    assert plan_mcp_wiring.plan_mcp_url(4242, "p1").startswith(f"http://127.0.0.1:{served}/plan-mcp?")


@pytest.mark.parametrize("reuse_address", [False, True], ids=["plain", "so_reuseaddr"])
async def test_the_port_is_never_free_during_a_restart(served: int, reuse_address: bool) -> None:
    """No other process can bind the port while the new loop starts: it would
    receive the pane tokens the CLIs send. Not even with SO_REUSEADDR, which
    on Windows would share a port bound without SO_EXCLUSIVEADDRUSE."""
    import socket

    stop_probing = threading.Event()
    took: list[int] = []

    def try_to_take() -> None:
        while not stop_probing.is_set():
            thief = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                if reuse_address:
                    thief.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                thief.bind(("127.0.0.1", served))
                took.append(1)
            except OSError:
                pass
            finally:
                thief.close()

    thread = threading.Thread(target=try_to_take, daemon=True)
    thread.start()
    try:
        for _ in range(2):
            result = await own_loop.restart()
            assert result["ok"] is not WINDOWS, result
    finally:
        stop_probing.set()
        thread.join(5)
    assert took == []


async def test_a_tool_call_still_runs_on_the_main_loop_after_a_restart(served: int) -> None:
    if WINDOWS:
        await _restart_is_refused_and_nothing_breaks(served)
    else:
        assert (await own_loop.restart())["ok"]
    await _call_after_restart_tool(served)


async def _call_after_restart_tool(served: int) -> None:
    def after_restart() -> str:
        """Test-only tool."""
        return "back"

    plan_mcp.server.add_tool(after_restart)
    try:
        body = {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {"name": "after_restart", "arguments": {}}}
        status, document, _ = await _post_off_loop(served, body)
    finally:
        plan_mcp.server.remove_tool("after_restart")
        plan_mcp.server._mcp_server._tool_cache.pop("after_restart", None)  # noqa: SLF001
    assert status == 200, document
    assert document["result"]["content"][0]["text"] == "back"


async def test_restart_brings_back_a_loop_that_died(served: int) -> None:
    state = own_loop._state  # noqa: SLF001
    state.loop.call_soon_threadsafe(setattr, state.server, "should_exit", True)
    state.thread.join(10)
    assert not state.thread.is_alive()

    if WINDOWS:
        assert await own_loop.restart() == {"ok": False, "reason": "unsupported-platform"}
        return
    assert (await own_loop.restart())["ok"]
    assert (await _post_off_loop(served, _INITIALIZE))[0] == 200


async def test_restart_without_an_own_loop_says_so() -> None:
    assert await own_loop.restart() == {"ok": False, "reason": "not-running"}


async def test_a_connected_mcp_client_keeps_working_across_a_restart(served: int) -> None:
    """What a CLI does: one client session, calls before and after. Stateless
    JSON mode: every call is its own POST, so nothing has to reconnect."""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    url = f"http://127.0.0.1:{served}/plan-mcp?client=host&t={plan_mcp_auth.internal_token()}"
    async with streamablehttp_client(url) as (read, write, _), ClientSession(read, write) as session:
        await session.initialize()
        assert (await session.list_tools()).tools
        result = await own_loop.restart()
        assert result["ok"] is not WINDOWS, result
        assert (await session.list_tools()).tools
