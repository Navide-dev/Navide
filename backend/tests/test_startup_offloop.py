"""Startup and first-paint work must not run on the event-loop thread.

On a first Windows boot (0.2.37 VM check, 2026-11-02) the backend logged
"listening" and then held the loop for about 40 s: reading the MCP settings
file, building the plugin MCP tools' pydantic models and the CLI hooks pass
all ran inline on the loop, and PATH lookups for the onboarding first paint
did too. uvicorn only accepts connections once the startup handler returns,
and nothing else on the loop (the MCP manager, the watchers) moved meanwhile.
Each test pins one of those steps to a worker thread.
"""

from __future__ import annotations

import ast
import inspect
import textwrap
import threading
from typing import Any

from agent_team_backend import app, mcp_manager, ws_handlers


async def test_mcp_manager_reads_its_config_off_the_loop(monkeypatch) -> None:
    loop_thread = threading.current_thread()
    seen: list[threading.Thread] = []

    def load(path=None):
        seen.append(threading.current_thread())
        return []

    monkeypatch.setattr(mcp_manager, "load_mcp_config", load)

    await mcp_manager.MCPManager().startup()

    assert seen and all(t is not loop_thread for t in seen)


class _Session:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, message: dict[str, Any]) -> None:
        self.sent.append(message)


async def test_onboarding_quick_status_runs_off_the_loop(monkeypatch) -> None:
    loop_thread = threading.current_thread()
    seen: dict[str, threading.Thread] = {}

    def quick_status() -> dict[str, Any]:
        seen["quick_status"] = threading.current_thread()
        return {"deps": [], "quick": True}

    def is_complete() -> bool:
        seen["is_complete"] = threading.current_thread()
        return False

    monkeypatch.setattr(app.onboarding_deps, "quick_status", quick_status)
    monkeypatch.setattr(app.onboarding_deps, "is_complete", is_complete)
    session = _Session()

    await ws_handlers.onboarding_status_quick(session, "m1", "onboarding.status_quick", {})

    assert set(seen) == {"quick_status", "is_complete"}
    assert all(t is not loop_thread for t in seen.values())
    assert session.sent[0]["payload"] == {"deps": [], "quick": True, "complete": False}


def _startup_calls() -> list[ast.Call]:
    source = textwrap.dedent(inspect.getsource(app._start_log_watcher))
    return [n for n in ast.walk(ast.parse(source)) if isinstance(n, ast.Call)]


def _dotted(node: ast.AST) -> str:
    return ast.unparse(node)


def test_startup_builds_plugin_mcp_tools_and_cli_hooks_off_the_loop() -> None:
    # Called directly on the loop, these held it ~2.4 s per tool and 29 s for
    # the hooks pass on the VM; they must reach a worker via asyncio.to_thread.
    calls = _startup_calls()
    offloaded = {
        _dotted(c.args[0]) for c in calls
        if _dotted(c.func) == "asyncio.to_thread" and c.args
    }
    direct = {_dotted(c.func) for c in calls}
    for name in ("plugin_wiring.apply_mcp_tools", "convenience_wiring.install_cli_hooks"):
        assert name in offloaded, f"{name} is not handed to asyncio.to_thread"
        assert name not in direct, f"{name} still runs on the loop"


def test_startup_keeps_the_order_of_the_offloaded_steps() -> None:
    # Same order as before the move: tools before the MCP server snapshots the
    # registry; the hooks pass after both carriers are registered.
    source = inspect.getsource(app._start_log_watcher)
    tools = source.index("plugin_wiring.apply_mcp_tools")
    copilot = source.index('register_pane_carrier("copilot"')
    hooks = source.index("convenience_wiring.install_cli_hooks")
    server = source.index("await mcp_server.startup()")
    assert tools < copilot < hooks < server
