"""mcp_menu: the allowlist every /mcp row goes through, and Navide's own servers' reads."""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import native_mcp
from agent_team_backend.channels import mcp_menu

SECRET = "sk-" + "live-" + "abcdef123456"


def _native(name: str, agent: str = "claude", path: str = "") -> native_mcp.NativeMcpServer:
    return native_mcp.NativeMcpServer(
        name=name, agent=agent, transport="stdio", path=path or str(Path.home() / ".claude.json"),
        command="/opt/bin/" + SECRET, args=("--token", SECRET), url="https://x/?k=" + SECRET,
        env=(("API_KEY", SECRET),), headers=(("Authorization", SECRET),),
    )


def test_native_rows_keep_only_the_allowlisted_fields_of_that_cli() -> None:
    rows = mcp_menu.native_rows([_native("github"), _native("other", agent="codex")], "claude")
    assert rows == [{"name": "github", "transport": "stdio", "enabled": True, "valid": True,
                     "source": "~/.claude.json"}]


def test_a_source_outside_home_is_named_by_its_file_only() -> None:
    rows = mcp_menu.native_rows([_native("github", path="/etc/someone/mcp.json")], "claude")
    assert rows[0]["source"] == "mcp.json"


class _Client:
    def __init__(self, tools: list[str], *, ready: bool = True, delay: float = 0.0) -> None:
        self.ready = ready
        self._tools = tools
        self._delay = delay

    async def list_tools(self) -> list[dict[str, str]]:
        await asyncio.sleep(self._delay)
        return [{"name": t, "description": "untrusted " + SECRET} for t in self._tools]


async def test_navide_rows_read_status_and_tool_count_with_a_timeout() -> None:
    servers = [
        {"name": "search", "enabled": True, "command": SECRET, "env": {"K": SECRET}},
        {"name": "slow", "enabled": True},
        {"name": "broken", "enabled": True},
        {"name": "off", "enabled": False},
    ]
    clients: dict[str, Any] = {"search": _Client(["a", "b"]), "slow": _Client(["a"], delay=5),
                               "broken": _Client([], ready=False)}
    rows = await mcp_menu.navide_rows(servers, clients.get, timeout=0.2)
    assert rows == [
        {"name": "search", "status": "connected", "tool_count": 2},
        {"name": "slow", "status": "timeout", "tool_count": None},
        {"name": "broken", "status": "error", "tool_count": None},
        {"name": "off", "status": "disabled", "tool_count": None},
    ]


async def test_navide_tools_are_names_only_and_none_on_timeout() -> None:
    clients: dict[str, Any] = {"search": _Client(["b", "a"]), "slow": _Client(["a"], delay=5)}
    assert await mcp_menu.navide_tools(clients.get, "search", timeout=0.2) == ["b", "a"]
    assert await mcp_menu.navide_tools(clients.get, "slow", timeout=0.2) is None
    assert await mcp_menu.navide_tools(clients.get, "missing", timeout=0.2) == []


def test_guard_the_cli_seam_reads_config_and_starts_no_server(monkeypatch: pytest.MonkeyPatch) -> None:
    """/mcp lists a CLI's own servers from its config file; it never launches one."""
    from agent_team_backend import mcp_manager
    from agent_team_backend.channels import default_seams

    def refuse(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("/mcp must not start a process or connect to a server")

    monkeypatch.setattr(native_mcp, "scan", lambda home=None: [_native("github")])
    monkeypatch.setattr(subprocess, "Popen", refuse)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", refuse)
    monkeypatch.setattr(asyncio, "create_subprocess_shell", refuse)
    monkeypatch.setattr(mcp_manager.MCPClient, "start", refuse)
    monkeypatch.setattr(mcp_manager.MCPClient, "list_tools", refuse)
    rows = default_seams().agent_mcp("claude")
    assert rows == [{"name": "github", "transport": "stdio", "enabled": True, "valid": True,
                     "source": "~/.claude.json"}]
    assert SECRET not in repr(rows)
