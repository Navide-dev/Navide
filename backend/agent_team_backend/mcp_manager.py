"""Generic MCP (Model Context Protocol) client manager.

Manages persistent connections to one or more MCP servers.
Config lives at app_data_dir() / "mcp_servers.json" — written with defaults
on first launch so users can customise without touching source code.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO

from . import applog, osplat
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
# The MCP handshake. A remote (http/sse) server gets _INIT_TIMEOUT. A local
# (stdio) server is waited on for as long as its process is alive, up to
# STDIO_INIT_HARD_CAP: a first `npx`/`uvx` run downloads the package before the
# server can answer (18-36 s measured on a loaded Windows VM), so a fixed 15 s
# gave up on servers that were working. The cap is a safety net against a
# server that never answers, not a limit on a slow one; the user is told while
# it starts (SLOW_START_NOTE_AFTER) and why it failed.
_INIT_TIMEOUT = 15.0
STDIO_INIT_HARD_CAP = 300.0
SLOW_START_NOTE_AFTER = 15.0
_ALIVE_POLL = 1.0  # seconds between liveness checks of a starting server
# The status shows the end of what a stdio server printed on stderr (npm's
# download messages, a crash), read from logs/mcp-<name>.log.
_STDERR_TAIL_LINES = 20
_STDERR_TAIL_BYTES = 8192
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

    This reads a private detail of mcp (checked against 1.30): the async
    generator behind `stdio_client` and its local named `process`. Should an
    mcp upgrade rename or restructure either, this returns None — no error —
    and the deadline only cancels the teardown again instead of also ending
    the server tree: stop() still returns, but a server that ignores EOF and
    SIGTERM is then left to the library (and to the backend's own exit).
    """
    pid = getattr(_stdio_server_process(transport_cm), "pid", None)
    return pid if isinstance(pid, int) else None


def _stdio_server_process(transport_cm: Any) -> Any:
    """The process object behind a live `stdio_client`, or None (the same
    private detail `_stdio_server_pid` reads)."""
    frame = getattr(getattr(transport_cm, "gen", None), "ag_frame", None)
    f_locals = getattr(frame, "f_locals", None)
    return f_locals.get("process") if isinstance(f_locals, dict) else None


def _exit_code(process: Any) -> int | None:
    """The exit code of a stdio server's process, or None while it runs (or
    when it cannot be told: then only the hard cap ends the wait).

    anyio's Process has ``returncode``; the Windows fallback wraps a Popen."""
    popen = getattr(process, "popen", None)
    if popen is not None:
        return popen.poll()
    code = getattr(process, "returncode", None)
    return code if isinstance(code, int) else None


def stderr_log_path(name: str) -> Path:
    """logs/mcp-<name>.log, with the name reduced to a safe file name: no path
    separator, no leading dot (so never `..`), bounded length."""
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", name).lstrip(".")[:80] or "server"
    return applog.log_dir() / f"mcp-{safe}.log"


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
        self._server_start = ""  # the server's start time, to tell a reused pid
        self._lock = asyncio.Lock()
        self.ready = False
        # "starting" until start() ends, then "connected" or "error" (with
        # ``error`` saying why). Shown in Settings -> MCP while it lasts.
        self.status = "starting"
        self.error = ""
        self._started_at: float | None = None
        self._process: Any = None
        self._errlog: TextIO | None = None
        self._stderr_path: Path | None = None

    def starting_seconds(self) -> float:
        if self._started_at is None:
            return 0.0
        return asyncio.get_running_loop().time() - self._started_at

    def stderr_tail(self) -> str:
        """The last lines the stdio server printed on stderr, for the status.
        Only what the server itself wrote: Navide writes nothing of the
        config (env, headers) there."""
        if self._stderr_path is None:
            return ""
        try:
            with open(self._stderr_path, "rb") as f:
                f.seek(0, os.SEEK_END)
                f.seek(max(0, f.tell() - _STDERR_TAIL_BYTES))
                text = f.read().decode("utf-8", errors="replace")
        except OSError:
            return ""
        return "\n".join(text.strip().splitlines()[-_STDERR_TAIL_LINES:])

    def _open_errlog(self) -> TextIO:
        # Truncated on every start: the file holds the latest run only.
        try:
            path = stderr_log_path(self.name)
            self._errlog = open(path, "w", encoding="utf-8", errors="replace")  # noqa: SIM115
            self._stderr_path = path
            return self._errlog
        except OSError as err:
            log.warning("MCP '%s' stderr log unavailable: %s", self.name, err)
            return sys.stderr

    async def _exit_code_soon(self) -> int | None:
        # The exit is reaped a moment after stdout closes. Without a process
        # object there is nothing to wait for.
        if self._process is None:
            return None
        for _ in range(10):
            code = _exit_code(self._process)
            if code is not None:
                return code
            await asyncio.sleep(0.1)
        return None

    async def _await_initialize(self) -> None:
        init = asyncio.ensure_future(self._session.initialize())
        try:
            if self._config.transport != "stdio":
                try:
                    await asyncio.wait_for(init, timeout=_INIT_TIMEOUT)
                except TimeoutError:
                    raise TimeoutError(
                        f"no answer to initialize after {_INIT_TIMEOUT:.0f} s"
                    ) from None
                return
            loop = asyncio.get_running_loop()
            deadline = (self._started_at or loop.time()) + STDIO_INIT_HARD_CAP
            while True:
                done, _ = await asyncio.wait({init}, timeout=_ALIVE_POLL)
                if done:
                    if not init.cancelled() and init.exception() is not None:
                        # A server that exits closes stdout, and the library
                        # reports only "Connection closed": name the exit.
                        code = await self._exit_code_soon()
                        if code is not None:
                            raise RuntimeError(
                                f"the server exited with code {code} before answering initialize"
                            ) from init.exception()
                    init.result()
                    return
                code = _exit_code(self._process)
                if code is not None:
                    raise RuntimeError(f"the server exited with code {code} before answering initialize")
                if loop.time() >= deadline:
                    raise TimeoutError(
                        f"no answer to initialize after {STDIO_INIT_HARD_CAP:.0f} s "
                        "while the server process was still running"
                    )
        finally:
            if not init.done():
                init.cancel()

    async def start(self) -> None:
        """Connect to the MCP server and perform the MCP handshake."""
        if not _MCP_AVAILABLE:
            log.warning("MCP '%s' skipped — mcp package not installed", self.name)
            self.status = "error"
            self.error = "the mcp package is not installed"
            return
        self.status = "starting"
        self.error = ""
        self._started_at = asyncio.get_running_loop().time()
        try:
            if self._config.transport == "stdio":
                final_env = os.environ.copy()
                final_env.update(self._config.env)
                server_params = StdioServerParameters(
                    command=self._config.command,
                    args=self._config.args,
                    env=final_env,
                )
                transport_cm = stdio_client(server_params, errlog=self._open_errlog())
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
                self._process = _stdio_server_process(transport_cm)
                self._server_pid = _stdio_server_pid(transport_cm)
                if self._server_pid is not None:
                    # A ps probe on POSIX (5 s cap), so off the event loop.
                    self._server_start = await asyncio.to_thread(
                        osplat.process_tree.start_time, self._server_pid
                    )
            # mcp>=1.27 streamable HTTP yields (read, write, get_session_id),
            # while stdio and SSE yield only (read, write).
            read, write = streams[:2]
            session_cm = ClientSession(read, write)
            self._session = await session_cm.__aenter__()
            self._session_cm = session_cm
            await self._await_initialize()
            self.ready = True
            self.status = "connected"
            log.info("MCP '%s' connected", self.name)
        except asyncio.CancelledError:
            await self.stop()
            raise
        except Exception as err:  # noqa: BLE001
            log.warning("MCP '%s' failed to start: %s", self.name, err)
            self.ready = False
            self.status = "error"
            self.error = str(err) or type(err).__name__
            await self.stop()  # ensure spawned subprocess is cleaned up

    async def stop(self) -> None:
        """Tear down the session and its underlying transport.

        A cancellation (shutdown cancelling a startup that is cleaning up a
        failed server) still exits both contexts, then propagates: swallowing it
        let the startup carry on while shutdown waited on the lifecycle lock.

        The stdio server's descendants are read before the teardown and any
        still alive after it are ended: the library ends only the Job object
        (group on POSIX) it made, and on Windows `npx`'s node.exe under
        cmd.exe can be outside that Job — once cmd.exe is gone nothing walks
        down to it, since Windows never reparents.
        """
        cancelled: asyncio.CancelledError | None = None
        leftovers: list[tuple[int, str]] = []
        if self._transport_cm is not None:
            try:
                leftovers = await asyncio.to_thread(self._server_descendants)
            except asyncio.CancelledError as err:
                cancelled = err
            except Exception:  # noqa: BLE001
                pass
        for label, cm in (("session", self._session_cm), ("transport", self._transport_cm)):
            if cm is not None:
                try:
                    await self._exit_bounded(label, cm)
                except asyncio.CancelledError as err:
                    cancelled = err
                except Exception:  # noqa: BLE001
                    pass
        if leftovers:
            try:
                await asyncio.to_thread(self._end_leftovers, leftovers)
            except asyncio.CancelledError as err:
                cancelled = err
            except Exception:  # noqa: BLE001
                pass
        self._session = None
        self._session_cm = None
        self._transport_cm = None
        self._server_pid = None
        self._server_start = ""
        self._process = None
        if self._errlog is not None:
            try:
                self._errlog.close()
            except OSError:
                pass
            self._errlog = None
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
        # Only while the pid is still that server: Windows reuses pids fast,
        # and a tree kill on a reused one ends someone else's process. A start
        # time that cannot be read, then or now, leaves it to the library's own
        # teardown (its Job object on Windows).
        start = self._server_start
        if not start or osplat.process_tree.start_time(pid) != start:
            log.warning("MCP '%s' server %d not ended: no longer the server it started", self.name, pid)
            return
        osplat.process_tree.end_contained(pid)
        log.warning("MCP '%s' server tree %d ended", self.name, pid)

    def _server_descendants(self) -> list[tuple[int, str]]:
        """`(pid, identity)` of every process below the live stdio server, or
        [] when the pid is no longer the server this client started."""
        pid = self._server_pid
        start = self._server_start
        if pid is None or not start or osplat.process_tree.start_time(pid) != start:
            return []
        found = []
        for child in osplat.process_tree.descendants(pid):
            identity = osplat.process_tree.identity(child)
            if identity:
                found.append((child, identity))
        return found

    def _end_leftovers(self, leftovers: list[tuple[int, str]]) -> None:
        """End the descendants the teardown left alive, each only while its
        pid is still the process that was read (Windows reuses pids fast)."""
        ended = []
        for pid, identity in leftovers:
            if osplat.process_tree.identity(pid) != identity:
                continue
            try:
                osplat.process_tree.kill(pid, force=True)
            except OSError:
                continue
            ended.append(pid)
        if ended:
            log.warning("MCP '%s' left %s running after stop; ended them", self.name, ended)

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
                # Registered before they start, so the status shows them as
                # starting; started together, so one slow server (a first npx
                # download) does not hold up the others. A cancel (shutdown)
                # reaches every start through gather; each stops itself.
                for cfg in configs:
                    self._clients[cfg.name] = MCPClient(cfg)
                await asyncio.gather(*(client.start() for client in list(self._clients.values())))
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
            entry: dict[str, Any] = {
                "name": name,
                "status": client.status,
                "tool_count": len(tools),
                "tools": tools,
            }
            if client.status == "starting":
                seconds = client.starting_seconds()
                entry["starting_seconds"] = int(seconds)
                entry["slow_start"] = seconds >= SLOW_START_NOTE_AFTER
            if client.status == "error":
                entry["error"] = client.error
            if client.status != "connected":
                tail = await asyncio.to_thread(client.stderr_tail)
                if tail:
                    entry["stderr_tail"] = tail
            result.append(entry)
        return result

    async def call_tool(self, server: str, tool: str, arguments: dict[str, Any]) -> Any:
        client = self.get(server)
        if client is None:
            raise KeyError(f"No MCP server named '{server}'")
        return await client.call_tool(tool, arguments)
