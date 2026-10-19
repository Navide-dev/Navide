"""Generic MCP (Model Context Protocol) client manager.

Manages persistent connections to one or more MCP servers.
Config lives at app_data_dir() / "mcp_servers.json" — written with defaults
on first launch so users can customise without touching source code.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import osplat
from .mcp_settings import MCPSettingsStore, default_mcp_servers

log = logging.getLogger("agent_team_backend.mcp_manager")

try:
    from mcp import ClientSession
    from mcp.client.sse import sse_client
    from mcp.client.stdio import StdioServerParameters, stdio_client
    from mcp.client.streamable_http import streamablehttp_client
    _MCP_AVAILABLE = True
except ImportError:
    _MCP_AVAILABLE = False
    ClientSession = None  # type: ignore[assignment,misc]
    StdioServerParameters = None  # type: ignore[assignment,misc]
    sse_client = None  # type: ignore[assignment]
    stdio_client = None  # type: ignore[assignment]
    streamablehttp_client = None  # type: ignore[assignment]

_CALL_TIMEOUT = 30.0  # seconds per tool call
# Bounds on a shutdown that would otherwise hang, not on work: the mcp library's
# own stdio teardown ends within ~4 s on POSIX (2 s for the server to exit on
# stdin EOF, then SIGTERM to its group, 2 s, then SIGKILL) and ~2 s on Windows,
# and the backend cannot exit until MCPManager.shutdown returns.
_STOP_TIMEOUT = 5.0  # seconds per session/transport __aexit__
_STOP_GRACE = 1.0  # seconds between the deadline's steps (kill, then cancels)
_SHUTDOWN_LOCK_TIMEOUT = 5.0  # seconds shutdown waits for a cancelled startup


def _stdio_server_pid(transport_cm: Any) -> int | None:
    """The pid of the server a live `stdio_client` spawned, or None.

    stdio_client does not expose its process; it is a local of the suspended
    generator. Read once at start so a stuck teardown can still kill it.
    """
    frame = getattr(getattr(transport_cm, "gen", None), "ag_frame", None)
    f_locals = getattr(frame, "f_locals", None)
    process = f_locals.get("process") if isinstance(f_locals, dict) else None
    pid = getattr(process, "pid", None)
    return pid if isinstance(pid, int) else None


# ── Config ────────────────────────────────────────────────────────────────────

@dataclass
class MCPServerConfig:
    name: str
    command: str = ""
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    enabled: bool = True
    transport: str = "stdio"
    url: str = ""
    headers: dict[str, str] = field(default_factory=dict)


def _default_config() -> list[dict[str, Any]]:
    return default_mcp_servers()


def load_mcp_config(path: Path | None = None) -> list[MCPServerConfig]:
    try:
        raw = MCPSettingsStore(path).list_enabled()
    except ValueError as err:
        log.warning("MCP config not loaded: %s", err)
        return []
    return [MCPServerConfig(**item) for item in raw]


# ── Single server client ───────────────────────────────────────────────────────

class MCPClient:
    """Persistent connection to one MCP server."""

    def __init__(self, config: MCPServerConfig) -> None:
        self.name = config.name
        self._config = config
        self._session: Any = None
        self._transport_cm: Any = None
        self._session_cm: Any = None
        self._server_pid: int | None = None
        self._lock = asyncio.Lock()
        self.ready = False

    async def start(self) -> None:
        """Connect to the MCP server and perform the MCP handshake."""
        if not _MCP_AVAILABLE:
            log.warning("MCP '%s' skipped — mcp package not installed", self.name)
            return
        try:
            if self._config.transport == "stdio":
                final_env = os.environ.copy()
                final_env.update(self._config.env)
                server_params = StdioServerParameters(
                    command=self._config.command,
                    args=self._config.args,
                    env=final_env,
                )
                transport_cm = stdio_client(server_params)
            elif self._config.transport == "http":
                transport_cm = streamablehttp_client(
                    self._config.url,
                    headers=self._config.headers or None,
                )
            elif self._config.transport == "sse":
                transport_cm = sse_client(
                    self._config.url,
                    headers=self._config.headers or None,
                )
            else:
                raise ValueError(f"unsupported MCP transport: {self._config.transport}")
            streams = await transport_cm.__aenter__()
            self._transport_cm = transport_cm
            if self._config.transport == "stdio":
                self._server_pid = _stdio_server_pid(transport_cm)
            # mcp>=1.27 streamable HTTP yields (read, write, get_session_id),
            # while stdio and SSE yield only (read, write).
            read, write = streams[:2]
            session_cm = ClientSession(read, write)
            self._session = await session_cm.__aenter__()
            self._session_cm = session_cm
            await asyncio.wait_for(self._session.initialize(), timeout=15.0)
            self.ready = True
            log.info("MCP '%s' connected", self.name)
        except asyncio.CancelledError:
            await self.stop()
            raise
        except Exception as err:  # noqa: BLE001
            log.warning("MCP '%s' failed to start: %s", self.name, err)
            self.ready = False
            await self.stop()  # ensure spawned subprocess is cleaned up

    async def stop(self) -> None:
        """Tear down the session and its underlying transport.

        A cancellation (shutdown cancelling a startup that is cleaning up a
        failed server) still exits both contexts, then propagates: swallowing it
        let the startup carry on while shutdown waited on the lifecycle lock.
        """
        cancelled: asyncio.CancelledError | None = None
        for label, cm in (("session", self._session_cm), ("transport", self._transport_cm)):
            if cm is not None:
                try:
                    await self._exit_bounded(label, cm)
                except asyncio.CancelledError as err:
                    cancelled = err
                except Exception:  # noqa: BLE001
                    pass
        self._session = None
        self._session_cm = None
        self._transport_cm = None
        self._server_pid = None
        self.ready = False
        log.info("MCP '%s' stopped", self.name)
        if cancelled is not None:
            raise cancelled

    async def _exit_bounded(self, label: str, cm: Any) -> None:
        """`cm.__aexit__`, ended if it outlives _STOP_TIMEOUT.

        Past the deadline the stdio server's process group is SIGKILLed first,
        which lets the library's own teardown finish normally. Only if it still
        has not, the task is cancelled every _STOP_GRACE: a single cancel is not
        enough, since anyio's Process.aclose waits for a second one before it
        kills, and a cancel landing before the library's SIGKILL step skips it.
        A cancel from outside (shutdown) still propagates to the caller.
        """
        task = asyncio.current_task()
        assert task is not None
        loop = asyncio.get_running_loop()
        outside = task.cancelling()
        ours = 0
        handle: asyncio.TimerHandle

        def cancel_again() -> None:
            nonlocal ours, handle
            ours += 1
            task.cancel()
            handle = loop.call_later(_STOP_GRACE, cancel_again)

        def on_deadline() -> None:
            nonlocal handle
            log.warning(
                "MCP '%s' %s exit timed out after %.0fs", self.name, label, _STOP_TIMEOUT
            )
            if label == "transport":
                self._kill_server_group()
            handle = loop.call_later(_STOP_GRACE, cancel_again)

        handle = loop.call_later(_STOP_TIMEOUT, on_deadline)
        try:
            await cm.__aexit__(None, None, None)
        except asyncio.CancelledError:
            handle.cancel()
            for _ in range(ours):
                task.uncancel()
            if task.cancelling() > outside:
                raise
        finally:
            handle.cancel()

    def _kill_server_group(self) -> None:
        """End the stdio server and everything it started. stdio_client spawns
        it with start_new_session (a Job object on Windows), the shape
        osplat's end_contained ends: the group on POSIX, the tree on Windows."""
        pid = self._server_pid
        if pid is None:
            return
        osplat.process_tree.end_contained(pid)
        log.warning("MCP '%s' server tree %d ended", self.name, pid)

    async def list_tools(self) -> list[dict[str, str]]:
        """Return the tools exposed by this server (best-effort, empty on failure)."""
        if not self.ready or self._session is None:
            return []
        try:
            result = await asyncio.wait_for(self._session.list_tools(), timeout=10.0)
            return [
                {"name": t.name, "description": t.description or ""}
                for t in result.tools
            ]
        except Exception:  # noqa: BLE001
            return []

    async def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        if not self.ready or self._session is None:
            raise RuntimeError(f"MCP '{self.name}' not ready")
        async with self._lock:
            return await asyncio.wait_for(
                self._session.call_tool(tool_name, arguments),
                timeout=_CALL_TIMEOUT,
            )


# ── Multi-server manager ───────────────────────────────────────────────────────

class MCPManager:
    """Lifecycle manager for all configured MCP servers."""

    def __init__(self) -> None:
        self._clients: dict[str, MCPClient] = {}
        self._lifecycle_lock = asyncio.Lock()
        self._config_path: Path | None = None
        self._starting: asyncio.Task[Any] | None = None

    async def startup(self, config_path: Path | None = None) -> None:
        async with self._lifecycle_lock:
            self._starting = asyncio.current_task()
            try:
                self._config_path = config_path
                await self._shutdown_unlocked()
                configs = load_mcp_config(config_path)
                for cfg in configs:
                    client = MCPClient(cfg)
                    await client.start()
                    self._clients[cfg.name] = client
                log.info("MCPManager: %d server(s) initialised", len(self._clients))
            finally:
                self._starting = None

    async def shutdown(self) -> None:
        # A start can take as long as an `npx` download plus the 15 s handshake,
        # and the backend cannot exit until this returns: cancel it rather than
        # queue behind it on the lock. MCPClient.start stops its own half-started
        # server on cancellation; the ones already up are stopped below.
        if self._starting is not None:
            self._starting.cancel()
        try:
            await asyncio.wait_for(self._lifecycle_lock.acquire(), timeout=_SHUTDOWN_LOCK_TIMEOUT)
        except TimeoutError:
            # The startup did not end on cancel. Stop what it has registered so
            # far rather than keep the backend from exiting.
            log.warning(
                "MCPManager: shutdown gave up waiting for the lifecycle lock after %.0fs",
                _SHUTDOWN_LOCK_TIMEOUT,
            )
            await self._shutdown_unlocked()
            return
        try:
            await self._shutdown_unlocked()
        finally:
            self._lifecycle_lock.release()

    async def reload(self, config_path: Path | None = None) -> None:
        await self.startup(config_path or self._config_path)

    async def _shutdown_unlocked(self) -> None:
        for client in list(self._clients.values()):
            await client.stop()
        self._clients.clear()

    def get(self, name: str) -> MCPClient | None:
        return self._clients.get(name)

    async def list_status(self) -> list[dict[str, Any]]:
        """Return live status + tool info for every running client."""
        result = []
        for name, client in self._clients.items():
            tools = await client.list_tools()
            result.append({
                "name": name,
                "status": "connected" if client.ready else "error",
                "tool_count": len(tools),
                "tools": tools,
            })
        return result

    async def call_tool(self, server: str, tool: str, arguments: dict[str, Any]) -> Any:
        client = self.get(server)
        if client is None:
            raise KeyError(f"No MCP server named '{server}'")
        return await client.call_tool(tool, arguments)
