"""Tests for mcp_manager — config loading and MCPManager lifecycle.

Real MCP subprocess connections are tested with a mock stdio pair so
no npx/network is required for the unit test suite.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_team_backend.mcp_manager import (
    MCPClient,
    MCPManager,
    MCPServerConfig,
    _default_config,
    load_mcp_config,
)


# ── load_mcp_config ───────────────────────────────────────────────────────────

class TestLoadMcpConfig:
    def test_creates_default_file_when_missing(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        result = load_mcp_config(cfg_path)
        assert cfg_path.exists(), "Config file should be created on first load"
        assert len(result) >= 1
        assert result[0].name == "context7"

    def test_reads_existing_file(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "myserver", "command": "echo", "args": ["hello"], "env": {}, "enabled": True}
        ]))
        result = load_mcp_config(cfg_path)
        assert len(result) == 1
        assert result[0].name == "myserver"
        assert result[0].command == "echo"

    def test_disabled_servers_filtered_out(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "active", "command": "npx", "args": [], "env": {}, "enabled": True},
            {"name": "inactive", "command": "npx", "args": [], "env": {}, "enabled": False},
        ]))
        result = load_mcp_config(cfg_path)
        assert len(result) == 1
        assert result[0].name == "active"

    def test_corrupt_json_is_preserved_and_loads_no_servers(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        content = "NOT VALID JSON {{{{"
        cfg_path.write_text(content)
        result = load_mcp_config(cfg_path)
        assert result == []
        assert cfg_path.read_text() == content

    def test_reads_remote_transports(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {
                "name": "remote",
                "transport": "http",
                "url": "https://example.test/mcp",
                "headers": {"Authorization": "Bearer token"},
            },
            {
                "name": "events",
                "transport": "sse",
                "url": "https://example.test/sse",
            },
        ]))

        result = load_mcp_config(cfg_path)

        assert [(item.name, item.transport) for item in result] == [
            ("remote", "http"),
            ("events", "sse"),
        ]
        assert result[0].headers == {"Authorization": "Bearer token"}

    def test_default_config_has_context7(self):
        defaults = _default_config()
        names = [d["name"] for d in defaults]
        assert "context7" in names

    def test_context7_uses_npx(self):
        defaults = _default_config()
        ctx7 = next(d for d in defaults if d["name"] == "context7")
        assert ctx7["command"] == "npx"
        assert "@upstash/context7-mcp" in ctx7["args"]


# ── MCPServerConfig ───────────────────────────────────────────────────────────

class TestMCPServerConfig:
    def test_defaults(self):
        cfg = MCPServerConfig(name="test", command="echo")
        assert cfg.args == []
        assert cfg.env == {}
        assert cfg.enabled is True
        assert cfg.transport == "stdio"
        assert cfg.url == ""
        assert cfg.headers == {}


# ── MCPClient ─────────────────────────────────────────────────────────────────

class TestMCPClient:
    def _make_client(self, name="test"):
        cfg = MCPServerConfig(name=name, command="npx", args=["-y", "@upstash/context7-mcp"])
        return MCPClient(cfg)

    def test_initial_state(self):
        client = self._make_client()
        assert client.ready is False
        assert client.name == "test"

    @pytest.mark.asyncio
    async def test_call_tool_raises_when_not_ready(self):
        client = self._make_client()
        with pytest.raises(RuntimeError, match="not ready"):
            await client.call_tool("some-tool", {})

    @pytest.mark.asyncio
    async def test_start_sets_ready_on_success(self):
        client = self._make_client()

        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()

        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_cm.__aexit__ = AsyncMock(return_value=None)

        mock_stdio_cm = AsyncMock()
        mock_stdio_cm.__aenter__ = AsyncMock(return_value=(AsyncMock(), AsyncMock()))
        mock_stdio_cm.__aexit__ = AsyncMock(return_value=None)

        # Patch at module level (imports are now at top of mcp_manager.py)
        with patch("agent_team_backend.mcp_manager.stdio_client", return_value=mock_stdio_cm), \
             patch("agent_team_backend.mcp_manager.ClientSession", return_value=mock_session_cm), \
             patch("agent_team_backend.mcp_manager.StdioServerParameters", return_value=MagicMock()), \
             patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            await client.start()

        assert client.ready is True

    @pytest.mark.asyncio
    async def test_stdio_passes_argv_and_merged_environment(self):
        cfg = MCPServerConfig(
            name="stdio",
            command="node",
            args=["--path", "/My Docs", '--label="two words"'],
            env={"MCP_TEST_TOKEN": "secret"},
        )
        client = MCPClient(cfg)
        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()
        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_transport_cm = AsyncMock()
        mock_transport_cm.__aenter__ = AsyncMock(return_value=(AsyncMock(), AsyncMock()))
        server_params = MagicMock()

        with patch("agent_team_backend.mcp_manager.stdio_client", return_value=mock_transport_cm), \
             patch("agent_team_backend.mcp_manager.ClientSession", return_value=mock_session_cm), \
             patch(
                 "agent_team_backend.mcp_manager.StdioServerParameters",
                 return_value=server_params,
             ) as make_params, \
             patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            await client.start()

        make_params.assert_called_once()
        call = make_params.call_args.kwargs
        assert call["command"] == "node"
        assert call["args"] == ["--path", "/My Docs", '--label="two words"']
        assert call["env"]["MCP_TEST_TOKEN"] == "secret"

    @pytest.mark.asyncio
    async def test_streamable_http_uses_headers_and_ignores_session_id_callback(self):
        cfg = MCPServerConfig(
            name="remote",
            transport="http",
            url="https://example.test/mcp",
            headers={"Authorization": "Bearer token"},
        )
        client = MCPClient(cfg)
        read, write, get_session_id = AsyncMock(), AsyncMock(), MagicMock()
        mock_transport_cm = AsyncMock()
        mock_transport_cm.__aenter__ = AsyncMock(
            return_value=(read, write, get_session_id)
        )
        mock_transport_cm.__aexit__ = AsyncMock(return_value=None)
        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()
        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_cm.__aexit__ = AsyncMock(return_value=None)

        with patch(
            "agent_team_backend.mcp_manager.streamablehttp_client",
            return_value=mock_transport_cm,
        ) as make_transport, patch(
            "agent_team_backend.mcp_manager.ClientSession", return_value=mock_session_cm
        ) as make_session, patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            await client.start()
            await client.stop()

        make_transport.assert_called_once_with(
            "https://example.test/mcp",
            headers={"Authorization": "Bearer token"},
        )
        make_session.assert_called_once_with(read, write)
        mock_session_cm.__aexit__.assert_awaited_once_with(None, None, None)
        mock_transport_cm.__aexit__.assert_awaited_once_with(None, None, None)

    @pytest.mark.asyncio
    async def test_sse_uses_two_streams_and_headers(self):
        cfg = MCPServerConfig(
            name="events",
            transport="sse",
            url="https://example.test/sse",
            headers={"X-Api-Key": "secret"},
        )
        client = MCPClient(cfg)
        read, write = AsyncMock(), AsyncMock()
        mock_transport_cm = AsyncMock()
        mock_transport_cm.__aenter__ = AsyncMock(return_value=(read, write))
        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()
        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)

        with patch(
            "agent_team_backend.mcp_manager.sse_client",
            return_value=mock_transport_cm,
        ) as make_transport, patch(
            "agent_team_backend.mcp_manager.ClientSession", return_value=mock_session_cm
        ) as make_session, patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            await client.start()

        assert client.ready is True
        make_transport.assert_called_once_with(
            "https://example.test/sse", headers={"X-Api-Key": "secret"}
        )
        make_session.assert_called_once_with(read, write)

    @pytest.mark.asyncio
    async def test_start_sets_not_ready_on_failure(self):
        client = self._make_client()

        with patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True), \
             patch("agent_team_backend.mcp_manager.stdio_client", side_effect=OSError("npx not found")):
            await client.start()

        assert client.ready is False

    @pytest.mark.asyncio
    async def test_initialize_cancellation_exits_session_and_transport_then_reraises(self):
        client = self._make_client()
        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock(side_effect=asyncio.CancelledError)
        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_cm.__aexit__ = AsyncMock(return_value=None)
        mock_transport_cm = AsyncMock()
        mock_transport_cm.__aenter__ = AsyncMock(return_value=(AsyncMock(), AsyncMock()))
        mock_transport_cm.__aexit__ = AsyncMock(return_value=None)

        with patch(
            "agent_team_backend.mcp_manager.stdio_client",
            return_value=mock_transport_cm,
        ), patch(
            "agent_team_backend.mcp_manager.ClientSession",
            return_value=mock_session_cm,
        ), patch(
            "agent_team_backend.mcp_manager.StdioServerParameters",
            return_value=MagicMock(),
        ), patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            with pytest.raises(asyncio.CancelledError):
                await client.start()

        mock_session_cm.__aexit__.assert_awaited_once_with(None, None, None)
        mock_transport_cm.__aexit__.assert_awaited_once_with(None, None, None)
        assert client.ready is False

    @pytest.mark.asyncio
    async def test_call_tool_delegates_to_session(self):
        client = self._make_client()

        fake_result = MagicMock()
        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()
        mock_session.call_tool = AsyncMock(return_value=fake_result)

        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_cm.__aexit__ = AsyncMock(return_value=None)

        mock_stdio_cm = AsyncMock()
        mock_stdio_cm.__aenter__ = AsyncMock(return_value=(AsyncMock(), AsyncMock()))
        mock_stdio_cm.__aexit__ = AsyncMock(return_value=None)

        with patch("agent_team_backend.mcp_manager.stdio_client", return_value=mock_stdio_cm), \
             patch("agent_team_backend.mcp_manager.ClientSession", return_value=mock_session_cm), \
             patch("agent_team_backend.mcp_manager.StdioServerParameters", return_value=MagicMock()), \
             patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            await client.start()

        result = await client.call_tool("resolve-library-id", {"query": "test", "libraryName": "WordPress"})
        assert result is fake_result
        mock_session.call_tool.assert_awaited_once_with(
            "resolve-library-id", {"query": "test", "libraryName": "WordPress"}
        )

    @pytest.mark.asyncio
    async def test_stop_sets_not_ready(self):
        client = self._make_client()

        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()

        mock_session_cm = AsyncMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_cm.__aexit__ = AsyncMock(return_value=None)

        mock_stdio_cm = AsyncMock()
        mock_stdio_cm.__aenter__ = AsyncMock(return_value=(AsyncMock(), AsyncMock()))
        mock_stdio_cm.__aexit__ = AsyncMock(return_value=None)

        with patch("agent_team_backend.mcp_manager.stdio_client", return_value=mock_stdio_cm), \
             patch("agent_team_backend.mcp_manager.ClientSession", return_value=mock_session_cm), \
             patch("agent_team_backend.mcp_manager.StdioServerParameters", return_value=MagicMock()), \
             patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            await client.start()

        assert client.ready is True
        await client.stop()
        assert client.ready is False


# ── MCPManager ────────────────────────────────────────────────────────────────

class TestMCPManager:
    @pytest.mark.asyncio
    async def test_startup_connects_enabled_servers(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "s1", "command": "echo", "args": [], "env": {}, "enabled": True},
            {"name": "s2", "command": "echo", "args": [], "env": {}, "enabled": False},
        ]))

        manager = MCPManager()

        with patch.object(MCPClient, "start", new_callable=AsyncMock) as mock_start:
            await manager.startup(cfg_path)

        # Only enabled server should be added
        assert "s1" in manager._clients
        assert "s2" not in manager._clients

    @pytest.mark.asyncio
    async def test_get_returns_client(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "ctx", "command": "echo", "args": [], "env": {}, "enabled": True},
        ]))

        manager = MCPManager()
        with patch.object(MCPClient, "start", new_callable=AsyncMock):
            await manager.startup(cfg_path)

        client = manager.get("ctx")
        assert client is not None
        assert manager.get("nonexistent") is None

    @pytest.mark.asyncio
    async def test_call_tool_raises_for_unknown_server(self):
        manager = MCPManager()
        with pytest.raises(KeyError, match="unknown"):
            await manager.call_tool("unknown", "some-tool", {})

    @pytest.mark.asyncio
    async def test_shutdown_clears_clients(self, tmp_path):
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "s1", "command": "echo", "args": [], "env": {}, "enabled": True},
        ]))

        manager = MCPManager()
        with patch.object(MCPClient, "start", new_callable=AsyncMock), \
             patch.object(MCPClient, "stop", new_callable=AsyncMock):
            await manager.startup(cfg_path)
            assert len(manager._clients) == 1
            await manager.shutdown()
            assert len(manager._clients) == 0

    @pytest.mark.asyncio
    async def test_shutdown_does_not_wait_for_a_server_still_starting(self, tmp_path):
        # The app starts MCP servers in a background task at launch, and the
        # default one is `npx -y @upstash/context7-mcp`: a download plus a 15 s
        # initialize budget. A shutdown in that window (a quit right after
        # launch, or the parent-watch seeing the app die) queued behind the
        # startup on the lifecycle lock, and the backend outlived its parent by
        # the whole start time. Shutdown must cancel the start instead.
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "fast", "command": "echo", "args": [], "env": {}, "enabled": True},
            {"name": "slow", "command": "echo", "args": [], "env": {}, "enabled": True},
        ]))
        slow_cancelled = asyncio.Event()

        async def start(client):
            if client.name == "slow":
                try:
                    await asyncio.sleep(60)
                except asyncio.CancelledError:
                    slow_cancelled.set()
                    raise

        manager = MCPManager()
        with patch.object(MCPClient, "start", start), \
             patch.object(MCPClient, "stop", new_callable=AsyncMock) as stop:
            startup = asyncio.create_task(manager.startup(cfg_path))
            while "fast" not in manager._clients:
                await asyncio.sleep(0.01)

            await asyncio.wait_for(manager.shutdown(), timeout=1.0)

            assert slow_cancelled.is_set()
            assert startup.cancelled()
            assert manager._clients == {}
            stop.assert_awaited_once()  # the server that did start is stopped


# ── Shutdown while a stop hangs (0.2.26 packaged check: no "stopped" line) ────

def _hanging_exit_cm(streams=None):
    """A context manager whose __aexit__ never returns on its own."""
    cm = AsyncMock()
    cm.__aenter__ = AsyncMock(return_value=streams or (AsyncMock(), AsyncMock()))

    async def hang(*_args):
        await asyncio.sleep(60)

    cm.__aexit__ = AsyncMock(side_effect=hang)
    return cm


class TestStopUnderShutdown:
    @pytest.mark.asyncio
    async def test_stop_reraises_cancellation_after_exiting_both_contexts(self, caplog):
        client = MCPClient(MCPServerConfig(name="ctx", command="echo"))
        session_cm = _hanging_exit_cm()
        transport_cm = AsyncMock()
        transport_cm.__aexit__ = AsyncMock(return_value=None)
        client._session_cm = session_cm
        client._transport_cm = transport_cm

        caplog.set_level("INFO", logger="agent_team_backend.mcp_manager")
        stopping = asyncio.create_task(client.stop())
        await asyncio.sleep(0.05)
        stopping.cancel()

        with pytest.raises(asyncio.CancelledError):
            await stopping
        transport_cm.__aexit__.assert_awaited_once_with(None, None, None)
        assert client._session_cm is None and client._transport_cm is None
        assert "MCP 'ctx' stopped" in caplog.text

    @pytest.mark.asyncio
    async def test_stop_bounds_an_exit_that_never_returns(self, caplog, monkeypatch):
        monkeypatch.setattr("agent_team_backend.mcp_manager._STOP_TIMEOUT", 0.05)
        monkeypatch.setattr("agent_team_backend.mcp_manager._STOP_GRACE", 0.05)
        client = MCPClient(MCPServerConfig(name="ctx", command="echo"))
        transport_cm = _hanging_exit_cm()
        client._transport_cm = transport_cm

        caplog.set_level("INFO", logger="agent_team_backend.mcp_manager")
        await asyncio.wait_for(client.stop(), timeout=1.0)

        assert "MCP 'ctx' transport exit timed out" in caplog.text
        assert "MCP 'ctx' stopped" in caplog.text

    @pytest.mark.asyncio
    async def test_shutdown_ends_a_startup_whose_failed_server_hangs_in_stop(
        self, tmp_path, caplog
    ):
        # The packaged-app hang: context7 "failed to start", its cleanup stop()
        # blocked in the stdio transport's __aexit__, shutdown cancelled the
        # startup, stop() swallowed that cancel, and startup went on to the
        # next server while shutdown waited on the lifecycle lock for good.
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "broken", "command": "echo", "args": [], "env": {}, "enabled": True},
            {"name": "next", "command": "echo", "args": [], "env": {}, "enabled": True},
        ]))
        failing_session = AsyncMock()
        failing_session.initialize = AsyncMock(side_effect=RuntimeError("handshake failed"))
        session_cm = AsyncMock()
        session_cm.__aenter__ = AsyncMock(return_value=failing_session)
        session_cm.__aexit__ = AsyncMock(return_value=None)
        transports = []

        def make_transport(_params):
            transports.append(_hanging_exit_cm())
            return transports[-1]

        caplog.set_level("INFO", logger="agent_team_backend.mcp_manager")
        manager = MCPManager()
        with patch("agent_team_backend.mcp_manager.stdio_client", side_effect=make_transport), \
             patch("agent_team_backend.mcp_manager.ClientSession", return_value=session_cm), \
             patch("agent_team_backend.mcp_manager.StdioServerParameters", return_value=MagicMock()), \
             patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            startup = asyncio.create_task(manager.startup(cfg_path))
            while not transports:
                await asyncio.sleep(0.01)
            await asyncio.sleep(0.05)  # "broken" is now inside its hanging stop()

            await asyncio.wait_for(manager.shutdown(), timeout=2.0)

        assert startup.cancelled()
        assert len(transports) == 1, "startup must not go on to the next server"
        assert manager._clients == {}
        assert "MCP 'broken' stopped" in caplog.text

    @pytest.mark.asyncio
    async def test_shutdown_does_not_wait_forever_for_a_start_that_ignores_cancel(
        self, tmp_path, caplog, monkeypatch
    ):
        monkeypatch.setattr("agent_team_backend.mcp_manager._SHUTDOWN_LOCK_TIMEOUT", 0.1)
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "stubborn", "command": "echo", "args": [], "env": {}, "enabled": True},
        ]))
        entered = asyncio.Event()

        async def start(_client):
            entered.set()
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                await asyncio.sleep(60)  # swallows the first cancel

        caplog.set_level("INFO", logger="agent_team_backend.mcp_manager")
        manager = MCPManager()
        with patch.object(MCPClient, "start", start):
            startup = asyncio.create_task(manager.startup(cfg_path))
            await entered.wait()
            try:
                await asyncio.wait_for(manager.shutdown(), timeout=1.0)
            finally:
                startup.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await startup

        assert "MCPManager: shutdown gave up waiting for the lifecycle lock" in caplog.text


# A stdio MCP server that answers the handshake, then ignores stdin EOF and
# SIGTERM, with a grandchild in its process group that ignores them too.
_STUBBORN_SERVER = r"""
import json, os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, "-c",
    "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(300)"])
with open(sys.argv[1], "w") as f:
    f.write(f"{os.getpid()} {child.pid}")
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": msg["params"]["protocolVersion"],
            "capabilities": {}, "serverInfo": {"name": "stubborn", "version": "0"}}}),
            flush=True)
time.sleep(300)
"""


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")
@pytest.mark.asyncio
async def test_stop_deadline_kills_a_stdio_server_that_ignores_eof_and_sigterm(
    tmp_path, monkeypatch
):
    # Review of #454, MED-1: the deadline used to cancel the library's own
    # teardown before its SIGKILL step (~4 s on POSIX: 2 s EOF + 2 s SIGTERM),
    # and anyio's Process.aclose then waited for a second cancel that never
    # came — stop() hung for good and the server lived on.
    monkeypatch.setattr("agent_team_backend.mcp_manager._STOP_TIMEOUT", 1.0)
    script = tmp_path / "server.py"
    script.write_text(_STUBBORN_SERVER)
    pidfile = tmp_path / "pids"
    client = MCPClient(MCPServerConfig(
        name="stubborn", command=sys.executable, args=[str(script), str(pidfile)]
    ))
    await client.start()
    assert client.ready
    pids = [int(p) for p in pidfile.read_text().split()]
    try:
        await asyncio.wait_for(client.stop(), timeout=8.0)
        deadline = time.monotonic() + 3.0
        while any(_alive(p) for p in pids) and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        assert not [p for p in pids if _alive(p)], "server and grandchild must be gone"
    finally:
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")
@pytest.mark.asyncio
async def test_cancelled_stop_still_kills_the_server_group(tmp_path, monkeypatch):
    # Review of #454, LOW-2: shutdown's cancel landing in the teardown skipped
    # the library's group kill; anyio then killed only the direct child and a
    # grandchild that ignores EOF was left behind.
    monkeypatch.setattr("agent_team_backend.mcp_manager._STOP_TIMEOUT", 1.0)
    script = tmp_path / "server.py"
    script.write_text(_STUBBORN_SERVER)
    pidfile = tmp_path / "pids"
    client = MCPClient(MCPServerConfig(
        name="stubborn", command=sys.executable, args=[str(script), str(pidfile)]
    ))
    started = asyncio.Event()

    async def lifecycle():
        # Start and stop in one task, as MCPClient.start's own cleanup does:
        # anyio's task group must be exited by the task that entered it.
        await client.start()
        started.set()
        await client.stop()

    stopping = asyncio.create_task(lifecycle())
    await asyncio.wait_for(started.wait(), timeout=8.0)
    assert client.ready
    pids = [int(p) for p in pidfile.read_text().split()]
    try:
        await asyncio.sleep(0.3)  # inside the library's 2 s wait for EOF exit
        stopping.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(stopping, timeout=8.0)
        deadline = time.monotonic() + 3.0
        while any(_alive(p) for p in pids) and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        assert not [p for p in pids if _alive(p)], "server and grandchild must be gone"
    finally:
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
