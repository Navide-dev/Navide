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
    ClientSession,
    MCPClient,
    MCPManager,
    MCPServerConfig,
    _default_config,
    _exit_code,
    load_mcp_config,
    stderr_log_path,
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
            # Both were registered before starting (so the status can show
            # them as starting), and shutdown stops every registered client;
            # stop() on one whose start was cancelled has nothing left to end.
            assert stop.await_count == 2


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

    @pytest.mark.parametrize(
        ("recorded", "now", "killed"),
        [
            ("100", "100", True),  # still the server it spawned
            ("100", "200", False),  # pid reused by another process
            ("100", "", False),  # gone, or its start time unreadable
            ("", "100", False),  # start time never read at start
        ],
    )
    @pytest.mark.asyncio
    async def test_stop_deadline_kills_the_server_only_while_its_pid_is_still_it(
        self, monkeypatch, recorded, now, killed
    ):
        # Review of #454, LOW-7: the pid is read at start and used at the
        # deadline; Windows reuses pids fast, and a tree kill on a reused pid
        # would end someone else's process — possibly another pane.
        from agent_team_backend import osplat

        monkeypatch.setattr("agent_team_backend.mcp_manager._STOP_TIMEOUT", 0.05)
        monkeypatch.setattr("agent_team_backend.mcp_manager._STOP_GRACE", 0.05)
        monkeypatch.setattr(osplat.process_tree, "start_time", lambda pid: now)
        ended = []
        monkeypatch.setattr(osplat.process_tree, "end_contained", lambda pid: ended.append(pid))
        client = MCPClient(MCPServerConfig(name="ctx", command="echo"))
        client._transport_cm = _hanging_exit_cm()
        client._server_pid = 4242
        client._server_start = recorded

        await asyncio.wait_for(client.stop(), timeout=1.0)

        assert ended == ([4242] if killed else [])

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

        def make_transport(_params, **_kwargs):
            transports.append(_hanging_exit_cm())
            return transports[-1]

        caplog.set_level("INFO", logger="agent_team_backend.mcp_manager")
        manager = MCPManager()
        with patch("agent_team_backend.mcp_manager.stdio_client", side_effect=make_transport), \
             patch("agent_team_backend.mcp_manager.ClientSession", return_value=session_cm), \
             patch("agent_team_backend.mcp_manager.StdioServerParameters", return_value=MagicMock()), \
             patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
            startup = asyncio.create_task(manager.startup(cfg_path))
            while len(transports) < 2:
                await asyncio.sleep(0.01)
            await asyncio.sleep(0.05)  # both are now inside their hanging stop()

            await asyncio.wait_for(manager.shutdown(), timeout=2.0)

        assert startup.cancelled()
        # Servers start together now, so both were under way; the cancel
        # still reaches each one's hanging stop() and shutdown does not wait.
        assert len(transports) == 2
        assert manager._clients == {}
        # Each server was stopped once, by its own start: a second, concurrent
        # stop() from shutdown would re-enter the transport's exit and log
        # "stopped" again (review of #578, H1).
        for transport in transports:
            assert transport.__aexit__.await_count == 1
        assert caplog.text.count("MCP 'broken' stopped") == 1
        assert caplog.text.count("MCP 'next' stopped") == 1

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


def _probe_start_times(monkeypatch) -> None:
    """Where `ps` cannot run (a sandbox denying setuid binaries, as the local
    keychain-safe pytest wrapper is), stand in for the start-time probe so the
    kill path is still exercised; elsewhere, CI included, the real one runs."""
    from agent_team_backend import osplat

    if not osplat.process_tree.start_time(os.getpid()):
        monkeypatch.setattr(
            osplat.process_tree, "start_time", lambda pid: "alive" if _alive(pid) else ""
        )


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
    _probe_start_times(monkeypatch)
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
    _probe_start_times(monkeypatch)
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


# A stdio MCP server that answers the handshake and exits on stdin EOF, with a
# grandchild that left its process group: the shape of `npx` on Windows, where
# node.exe under cmd.exe is outside the library's Job object and so outlives a
# teardown that ends only cmd.exe.
_ESCAPED_GRANDCHILD_SERVER = r"""
import json, os, subprocess, sys
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"],
    start_new_session=True)
with open(sys.argv[1], "w") as f:
    f.write(f"{os.getpid()} {child.pid}")
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": msg["params"]["protocolVersion"],
            "capabilities": {}, "serverInfo": {"name": "escaped", "version": "0"}}}),
            flush=True)
"""


def _probe_descendants(monkeypatch) -> None:
    """As _probe_start_times, for the descendant walk and identity probe that
    stop() reads from `ps`."""
    from agent_team_backend import osplat

    if osplat.process_tree.descendants(os.getppid()):
        return
    import psutil

    def descendants(pid):
        try:
            return [p.pid for p in psutil.Process(pid).children(recursive=True)]
        except psutil.Error:
            return []

    monkeypatch.setattr(osplat.process_tree, "descendants", descendants)
    monkeypatch.setattr(
        osplat.process_tree, "identity", lambda pid: f"{pid}:alive" if _alive(pid) else ""
    )


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX sessions stand in for a Job escape")
@pytest.mark.asyncio
async def test_stop_ends_a_server_descendant_outside_its_group(tmp_path, monkeypatch):
    # 0.2.27 packaged Windows check: after a normal quit the context7 server's
    # cmd.exe was gone but its node.exe lived on — the library's teardown ends
    # the Job (or group) it made, and a descendant outside it was left behind.
    _probe_start_times(monkeypatch)
    _probe_descendants(monkeypatch)
    script = tmp_path / "server.py"
    script.write_text(_ESCAPED_GRANDCHILD_SERVER)
    pidfile = tmp_path / "pids"
    client = MCPClient(MCPServerConfig(
        name="escaped", command=sys.executable, args=[str(script), str(pidfile)]
    ))
    await client.start()
    assert client.ready
    pids = [int(p) for p in pidfile.read_text().split()]
    try:
        await asyncio.wait_for(client.stop(), timeout=8.0)
        deadline = time.monotonic() + 3.0
        while any(_alive(p) for p in pids) and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        assert not [p for p in pids if _alive(p)], "server and escaped grandchild must be gone"
    finally:
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


# ── Cold start: wait while the stdio server lives, say why it failed ─────────

# A stdio MCP server that prints to stderr, then answers initialize after
# argv[1] seconds; argv[2] = "exit:<code>" exits instead of answering.
_SLOW_SERVER = r"""
import json, sys, time
delay, mode = float(sys.argv[1]), sys.argv[2]
print("npm warn exec The following package was not found and will be installed", file=sys.stderr, flush=True)
if mode.startswith("exit:"):
    print("npm error 404 Not Found", file=sys.stderr, flush=True)
    sys.exit(int(mode.split(":")[1]))
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        time.sleep(delay)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": msg["params"]["protocolVersion"],
            "capabilities": {}, "serverInfo": {"name": "slow", "version": "0"}}}),
            flush=True)
"""


def _slow_client(tmp_path, name: str, delay: float, mode: str = "answer", env=None) -> MCPClient:
    script = tmp_path / "slow_server.py"
    script.write_text(_SLOW_SERVER)
    return MCPClient(MCPServerConfig(
        name=name, command=sys.executable, args=[str(script), str(delay), mode], env=env or {},
    ))


@pytest.fixture
def fast_polling(monkeypatch):
    monkeypatch.setattr("agent_team_backend.mcp_manager._ALIVE_POLL", 0.1)
    monkeypatch.setattr("agent_team_backend.mcp_manager.SLOW_START_NOTE_AFTER", 0.5)
    # The fixed handshake budget now applies to remote servers only.
    monkeypatch.setattr("agent_team_backend.mcp_manager._INIT_TIMEOUT", 0.5)


class TestColdStart:
    @pytest.mark.asyncio
    async def test_a_stdio_server_slower_than_the_old_budget_still_connects(self, tmp_path, fast_polling):
        client = _slow_client(tmp_path, "slow", delay=2.0)
        try:
            await asyncio.wait_for(client.start(), timeout=20)
            assert client.ready and client.status == "connected"
        finally:
            await client.stop()

    @pytest.mark.asyncio
    async def test_a_starting_server_is_listed_as_starting_with_its_stderr(self, tmp_path, fast_polling):
        manager = MCPManager()
        cfg_path = tmp_path / "mcp_servers.json"
        script = tmp_path / "slow_server.py"
        script.write_text(_SLOW_SERVER)
        cfg_path.write_text(json.dumps([
            {"name": "slow", "command": sys.executable, "args": [str(script), "3", "answer"], "env": {}, "enabled": True},
        ]))
        startup = asyncio.create_task(manager.startup(cfg_path))
        try:
            entry = None
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                await asyncio.sleep(0.1)
                rows = await manager.list_status()
                # The row leaves stderr_tail out until the server's first stderr
                # line has been read; on a slow Windows start, slow_start is
                # already set before that, so wait for both.
                if rows and rows[0].get("slow_start") and rows[0].get("stderr_tail"):
                    entry = rows[0]
                    break
            assert entry is not None, "a slow start is disclosed, with its stderr, while it lasts"
            assert entry["status"] == "starting"
            assert entry["starting_seconds"] >= 0
            assert "will be installed" in entry["stderr_tail"]
            await asyncio.wait_for(startup, timeout=20)
            assert (await manager.list_status())[0]["status"] == "connected"
        finally:
            await manager.shutdown()

    @pytest.mark.asyncio
    async def test_a_server_that_exits_fails_at_once_with_the_reason(self, tmp_path, fast_polling):
        client = _slow_client(tmp_path, "gone", delay=0, mode="exit:3")
        began = time.monotonic()
        await asyncio.wait_for(client.start(), timeout=20)

        assert time.monotonic() - began < 10
        assert client.status == "error" and not client.ready
        assert "exited with code 3" in client.error
        assert "404 Not Found" in client.stderr_tail()

    @staticmethod
    def _cancel_transport_once_the_server_exits(client: MCPClient, monkeypatch, *, then=None) -> None:
        """Make initialize run only once the stdio server has exited, after the
        transport's task group has cancelled its scope — what stdio_client does
        when writing initialize to the dead server's stdin fails (its writer
        catches ClosedResourceError only, not BrokenResourceError)."""
        real = ClientSession.initialize

        async def initialize(session):
            deadline = time.monotonic() + 10
            while _exit_code(client._process) is None and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
            client._transport_cm.gen.ag_frame.f_locals["tg"].cancel_scope.cancel()
            if then is not None:
                then()
            return await real(session)

        monkeypatch.setattr(ClientSession, "initialize", initialize)

    @pytest.mark.asyncio
    async def test_a_server_that_exits_mid_initialize_fails_with_the_reason_not_a_cancel(
        self, tmp_path, fast_polling, monkeypatch,
    ):
        # The liveness poll must not get to see the exit first.
        monkeypatch.setattr("agent_team_backend.mcp_manager._ALIVE_POLL", 30.0)
        client = _slow_client(tmp_path, "gone", delay=0, mode="exit:3")
        self._cancel_transport_once_the_server_exits(client, monkeypatch)

        await asyncio.wait_for(client.start(), timeout=20)

        assert client.status == "error" and not client.ready
        assert "exited with code 3" in client.error
        assert "404 Not Found" in client.stderr_tail()
        assert client._transport_cm is None and client._session_cm is None

    @pytest.mark.asyncio
    async def test_a_cancel_of_start_itself_still_propagates_when_the_server_exits(
        self, tmp_path, fast_polling, monkeypatch,
    ):
        monkeypatch.setattr("agent_team_backend.mcp_manager._ALIVE_POLL", 30.0)
        client = _slow_client(tmp_path, "gone", delay=0, mode="exit:3")
        starting: list[asyncio.Task] = []
        # Shutdown cancelling the startup, at the same moment.
        self._cancel_transport_once_the_server_exits(client, monkeypatch, then=lambda: starting[0].cancel())
        starting.append(asyncio.create_task(client.start()))

        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(starting[0], timeout=20)
        assert client._transport_cm is None and client._session_cm is None

    @pytest.mark.asyncio
    async def test_a_cancel_of_start_that_arrives_while_it_stops_still_propagates(
        self, tmp_path, fast_polling, monkeypatch,
    ):
        monkeypatch.setattr("agent_team_backend.mcp_manager._ALIVE_POLL", 30.0)
        client = _slow_client(tmp_path, "gone", delay=0, mode="exit:3")
        self._cancel_transport_once_the_server_exits(client, monkeypatch)
        starting: list[asyncio.Task] = []
        real_stop = MCPClient.stop
        stops = [0]

        async def stop(self):
            stops[0] += 1
            if stops[0] == 1:
                # Shutdown cancelling the startup while it is cleaning up after
                # the transport's own cancel.
                starting[0].cancel()
            await real_stop(self)

        monkeypatch.setattr(MCPClient, "stop", stop)
        starting.append(asyncio.create_task(client.start()))

        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(starting[0], timeout=20)
        assert stops[0] == 1
        assert client._transport_cm is None and client._session_cm is None

    @pytest.mark.asyncio
    async def test_the_hard_cap_ends_a_server_that_never_answers(self, tmp_path, fast_polling, monkeypatch):
        monkeypatch.setattr("agent_team_backend.mcp_manager.STDIO_INIT_HARD_CAP", 1.0)
        client = _slow_client(tmp_path, "mute", delay=60)
        await asyncio.wait_for(client.start(), timeout=20)

        assert client.status == "error"
        assert "no answer to initialize after 1 s" in client.error
        assert "still running" in client.error
        assert client._transport_cm is None  # stopped, its process tree ended

    @pytest.mark.asyncio
    async def test_one_slow_server_does_not_hold_up_the_others(self, tmp_path, fast_polling):
        script = tmp_path / "slow_server.py"
        script.write_text(_SLOW_SERVER)
        cfg_path = tmp_path / "mcp_servers.json"
        cfg_path.write_text(json.dumps([
            {"name": "slow", "command": sys.executable, "args": [str(script), "4", "answer"], "env": {}, "enabled": True},
            {"name": "fast", "command": sys.executable, "args": [str(script), "0", "answer"], "env": {}, "enabled": True},
        ]))
        manager = MCPManager()
        startup = asyncio.create_task(manager.startup(cfg_path))
        try:
            deadline = time.monotonic() + 10
            statuses: dict[str, str] = {}
            while time.monotonic() < deadline:
                await asyncio.sleep(0.1)
                statuses = {row["name"]: row["status"] for row in await manager.list_status()}
                if statuses.get("fast") == "connected":
                    break
            assert statuses == {"slow": "starting", "fast": "connected"}
            await asyncio.wait_for(startup, timeout=20)
        finally:
            await manager.shutdown()

    @pytest.mark.asyncio
    async def test_the_stderr_log_never_holds_the_config_env(self, tmp_path, fast_polling):
        secret = "s3cr" + "3t-value"
        client = _slow_client(tmp_path, "env", delay=0, mode="exit:1", env={"MCP_TEST_TOKEN": secret})
        await asyncio.wait_for(client.start(), timeout=20)

        log_text = stderr_log_path("env").read_text()
        assert "will be installed" in log_text
        assert secret not in log_text
        assert secret not in client.error


@pytest.mark.parametrize("name", ["../../etc/passwd", "..", "a/b\\c", ".hidden", "", "context7"])
def test_the_stderr_log_name_stays_inside_the_logs_folder(name):
    from agent_team_backend import applog

    path = stderr_log_path(name)
    assert path.parent == applog.log_dir()
    assert path.name.startswith("mcp-") and path.name.endswith(".log")
    assert "/" not in path.name and "\\" not in path.name
    assert not path.name.removeprefix("mcp-").startswith(".")


# ── Review of #578: H1 (one stop per server, all done before shutdown) ──────


@pytest.mark.asyncio
async def test_shutdown_waits_for_every_starting_server_to_finish_stopping(tmp_path, caplog):
    """gather returns at the first start that ends cancelled; the lock must not
    be handed to shutdown while another server is still being stopped, or its
    leftover processes (#566) are never ended."""
    caplog.set_level("INFO", logger="agent_team_backend.mcp_manager")
    cfg_path = tmp_path / "mcp_servers.json"
    cfg_path.write_text(json.dumps([
        {"name": "quick", "command": "echo", "args": ["quick"], "env": {}, "enabled": True},
        {"name": "slow", "command": "echo", "args": ["slow"], "env": {}, "enabled": True},
    ]))
    exited: dict[str, float] = {}
    transports: dict[str, AsyncMock] = {}

    def make_transport(params, **_kwargs):
        name = params.args[0]
        cm = AsyncMock()
        cm.__aenter__ = AsyncMock(return_value=(AsyncMock(), AsyncMock()))

        async def exit_(*_args):
            await asyncio.sleep(0.1 if name == "quick" else 1.0)
            exited[name] = time.monotonic()

        cm.__aexit__ = AsyncMock(side_effect=exit_)
        transports[name] = cm
        return cm

    def make_session(*_args):
        session = AsyncMock()

        async def never():
            await asyncio.sleep(60)

        session.initialize = AsyncMock(side_effect=never)
        cm = AsyncMock()
        cm.__aenter__ = AsyncMock(return_value=session)
        cm.__aexit__ = AsyncMock(return_value=None)
        return cm

    manager = MCPManager()
    with patch("agent_team_backend.mcp_manager.stdio_client", side_effect=make_transport), \
         patch("agent_team_backend.mcp_manager.ClientSession", side_effect=make_session), \
         patch("agent_team_backend.mcp_manager.StdioServerParameters",
               side_effect=lambda **kw: MagicMock(args=kw["args"])), \
         patch("agent_team_backend.mcp_manager._MCP_AVAILABLE", True):
        startup = asyncio.create_task(manager.startup(cfg_path))
        while len(transports) < 2:
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)

        await asyncio.wait_for(manager.shutdown(), timeout=4.0)
        returned = time.monotonic()

    assert startup.cancelled()
    assert set(exited) == {"quick", "slow"}, "both stops finished"
    assert max(exited.values()) <= returned, "before shutdown returned"
    for transport in transports.values():
        assert transport.__aexit__.await_count == 1
    assert caplog.text.count("MCP 'quick' stopped") == 1
    assert caplog.text.count("MCP 'slow' stopped") == 1


# ── Review of #578: N1 (no shared log file), N3 (0600, removed server) ─────


@pytest.mark.parametrize(("one", "two"), [("a/b", "a_b"), ("上下文", "資料庫"), ("Foo", "foo")])
def test_two_servers_never_share_a_log_file(one, two):
    assert stderr_log_path(one).name.lower() != stderr_log_path(two).name.lower()


def test_a_plain_name_keeps_its_plain_log_file():
    assert stderr_log_path("context7").name == "mcp-context7.log"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_the_stderr_log_is_owner_only(tmp_path):
    path = stderr_log_path("perm-check")
    path.write_text("old")
    path.chmod(0o644)
    client = MCPClient(MCPServerConfig(name="perm-check", command="echo"))
    f = client._open_errlog()
    try:
        assert (path.stat().st_mode & 0o777) == 0o600
        assert path.read_text() == ""  # the latest start only
    finally:
        f.close()


@pytest.mark.asyncio
async def test_removing_a_server_deletes_its_log_and_switching_one_off_keeps_it(tmp_path):
    cfg_path = tmp_path / "mcp_servers.json"

    def write(rows):
        cfg_path.write_text(json.dumps(rows))

    write([
        {"name": "gone", "command": "echo", "args": [], "env": {}, "enabled": True},
        {"name": "off", "command": "echo", "args": [], "env": {}, "enabled": True},
    ])
    manager = MCPManager()
    with patch.object(MCPClient, "start", AsyncMock()), patch.object(MCPClient, "stop", AsyncMock()):
        await manager.startup(cfg_path)
        for name in ("gone", "off"):
            stderr_log_path(name).write_text("what it printed")
        write([{"name": "off", "command": "echo", "args": [], "env": {}, "enabled": False}])
        await manager.reload(cfg_path)

    assert not stderr_log_path("gone").exists()
    assert stderr_log_path("off").exists()


def test_a_start_error_from_an_exception_group_names_the_real_error():
    from agent_team_backend.mcp_manager import _reason

    group = ExceptionGroup("unhandled errors in a TaskGroup", [RuntimeError("401 Unauthorized")])
    assert _reason(group) == "401 Unauthorized"
    assert _reason(TimeoutError()) == "TimeoutError"

