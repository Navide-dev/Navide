"""/plan-mcp on an event loop of its own.

Every CLI pane reaches Navide's tools over /plan-mcp. On the backend's main
loop that endpoint waits behind everything else the loop does — the PTY output
of every pane, the windows' WebSocket traffic, the log readers, the scheduler.
On 2026-11-12 a mass restore made each /plan-mcp request take 20–57 s and
thirteen panes gave up connecting; on 2026-11-15 the loop stalled 360 s and
188 s and 65 of 66 panes lost the connection they had. Claude Code allows 30 s
to connect and about 15 s to reconnect, then stops trying.

So the endpoint also listens on a loopback port of its own, served by a
thread with its own event loop and its own session manager. The requests a
CLI needs to connect and stay connected — initialize, tools/list, ping, the
long-lived GET stream — are answered there without waiting for the main loop.
Every other request (tools/call above all) still runs on the main loop, where
the state the tools read and change lives: it is handed over with
run_coroutine_threadsafe and the answer comes back the same way. A tool call
can therefore still be slow while the main loop is busy, but the CLI stays
connected while it waits.

Wiring (plan_mcp_url) points the CLIs at this port while it is up. The route
on the main port stays for everything that was given that URL (external
clients, a CLI spawned before this started). Only the production entry point
turns this on (``enable``); tests and in-process apps keep one loop.

``restart`` replaces the thread and its loop without touching a PTY: the MCP
health probe's soft recovery. The listening socket is this module's for the
whole run and each server is handed a duplicate of it: asyncio closes the
socket a server was given when that server closes, which would release the
port, and between that and a rebind any local process could take the port
and collect the pane tokens the CLIs send to it. With the socket kept open
the port is never free, and connections made while the new loop starts wait
in its backlog.

Not on Windows. A proactor loop ties a socket to its I/O completion port, and
Windows ties every duplicate of a socket to that same port for good: the next
loop's accept fails (WinError 87) and the listener answers nothing again.
Binding a fresh socket to the port while the old one holds it would need
SO_REUSEADDR, which on Windows also lets any other local process bind the port
and take the CLIs' connections. So there ``restart`` reports
"unsupported-platform" and changes nothing: the window still shows the red
light and the chat still gets its notice, and the whole-backend restart stays
the way back. On Windows the listener binds with SO_EXCLUSIVEADDRUSE (no other
socket can share the port); elsewhere SO_REUSEADDR, which does not let a
second socket bind a port that is listening.
"""

from __future__ import annotations

import asyncio
import logging
import socket
import threading
from dataclasses import dataclass, field
from typing import Any

from agent_team_backend import osplat

log = logging.getLogger(__name__)

#: How long startup waits for the thread to be serving before giving up on it
#: (the CLIs are then wired to the main port, as before).
_START_TIMEOUT_S = 15.0
_JOIN_TIMEOUT_S = 10.0

_enabled = False

#: Whether ``restart`` can bring the listener back on a new loop (see the
#: module docstring: not on Windows).
_SOFT_RESTART_SUPPORTED = osplat.listener_can_change_loops


@dataclass
class _OwnLoop:
    sock: socket.socket
    main_loop: asyncio.AbstractEventLoop
    ready: threading.Event = field(default_factory=threading.Event)
    loop: asyncio.AbstractEventLoop | None = None
    server: Any = None
    thread: threading.Thread | None = None
    error: BaseException | None = None

    @property
    def port(self) -> int:
        return int(self.sock.getsockname()[1])


_state: _OwnLoop | None = None


def enable() -> None:
    """Serve /plan-mcp on its own loop from the next app startup on."""
    global _enabled
    _enabled = True


def port() -> int | None:
    """The port the CLIs should be wired to, or None to use the main port."""
    state = _state
    if state is None or not state.ready.is_set() or state.error is not None:
        return None
    return state.port


def main_loop() -> asyncio.AbstractEventLoop | None:
    state = _state
    return state.main_loop if state is not None else None


# ── the listener ─────────────────────────────────────────────────────────────


async def _app(scope: dict[str, Any], receive: Any, send: Any) -> None:
    """/plan-mcp and nothing else, with the main app's Host check."""
    from starlette.responses import Response

    from agent_team_backend.app import is_local_host_header
    from agent_team_backend.mcp_server import server as plan_mcp

    if scope.get("type") != "http":
        return
    if scope.get("path") != plan_mcp.ROUTE_PATH:
        await Response(status_code=404)(scope, receive, send)
        return
    host = next((v.decode("latin-1") for k, v in scope.get("headers") or [] if k == b"host"), "")
    if not is_local_host_header(host):
        await Response(status_code=403)(scope, receive, send)
        return
    if scope.get("method") not in plan_mcp.ROUTE_METHODS:
        await Response(status_code=405)(scope, receive, send)
        return
    await plan_mcp.asgi_app(scope, receive, send)


async def _serve(state: _OwnLoop) -> None:
    import uvicorn

    from agent_team_backend.mcp_server import server as plan_mcp

    loop = asyncio.get_running_loop()
    state.loop = loop
    plan_mcp._own_loop = loop
    runner = plan_mcp._start_runner()
    plan_mcp._own_runner = runner
    try:
        await runner.ready.wait()
        if runner.task.done():
            runner.task.result()
        config = uvicorn.Config(
            _app,
            lifespan="off",
            # The main entry point configured logging (and its token
            # redaction); a dictConfig here would replace those handlers.
            log_config=None,
            access_log=False,
            ws="none",
            # Same reasons as the main server's (see __main__).
            timeout_keep_alive=75,
            timeout_graceful_shutdown=5,
        )
        listening = asyncio.Event()

        class _Server(uvicorn.Server):
            async def startup(self, sockets: Any = None) -> None:
                await super().startup(sockets=sockets)
                listening.set()

        state.server = _Server(config)
        # Ready as soon as the listener is up, not when serve() returns. A
        # duplicate: closing the server closes it, and the port stays held by
        # state.sock (see the module docstring).
        serving = loop.create_task(state.server.serve(sockets=[state.sock.dup()]))
        waiting = loop.create_task(listening.wait())
        await asyncio.wait({serving, waiting}, return_when=asyncio.FIRST_COMPLETED)
        waiting.cancel()
        if serving.done():
            serving.result()
        state.ready.set()
        await serving
    finally:
        # A restart may have put a newer loop in place already (this one's
        # join timed out): leave that one's alone.
        if plan_mcp._own_runner is runner:
            plan_mcp._own_runner = None
        runner.stop.set()
        await asyncio.wait([runner.task])
        if plan_mcp._own_loop is loop:
            plan_mcp._own_loop = None


def _thread_main(state: _OwnLoop) -> None:
    try:
        asyncio.run(_serve(state))
    except BaseException as err:  # noqa: BLE001 — reported, and the main port takes over
        state.error = err
        log.error("plan-mcp: own event loop stopped: %s", err, exc_info=err)
    finally:
        state.ready.set()


# ── calls that belong on the main loop ───────────────────────────────────────


def _install_dispatch() -> None:
    """Make every request but tools/list and ping run on the main loop when it
    arrives on this one. Idempotent; a no-op for a call already on the main
    loop, so the main port's route and the tests are unaffected."""
    import mcp.types as types

    from agent_team_backend.mcp_server import server as plan_mcp

    local = (types.ListToolsRequest, types.PingRequest)
    handlers = plan_mcp.server._mcp_server.request_handlers  # noqa: SLF001
    for kind, handler in list(handlers.items()):
        if kind in local or getattr(handler, "navide_main_loop", False):
            continue
        handlers[kind] = _on_main_loop(handler)


def _on_main_loop(handler: Any) -> Any:
    async def run(request: Any) -> Any:
        from agent_team_backend.mcp_server import server as plan_mcp

        own = plan_mcp._own_loop
        target = main_loop()
        if own is None or target is None or asyncio.get_running_loop() is not own:
            return await handler(request)
        # The context — the SDK's request context, the body size — travels
        # with the call: call_soon_threadsafe copies it in this thread.
        future = asyncio.run_coroutine_threadsafe(handler(request), target)
        return await asyncio.wrap_future(future)

    run.navide_main_loop = True  # type: ignore[attr-defined]
    return run


# ── lifecycle ────────────────────────────────────────────────────────────────


async def start() -> int | None:
    """Start the listener if enabled; its port, or None (main port only)."""
    global _state
    if not _enabled or _state is not None:
        return port()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, osplat.exclusive_listener_option, 1)
    sock.bind(("127.0.0.1", 0))
    sock.set_inheritable(False)
    _install_dispatch()
    state = _OwnLoop(sock=sock, main_loop=asyncio.get_running_loop())
    _state = state
    await _launch(state)
    if port() is None:
        log.warning("plan-mcp: own event loop did not start; CLIs use the main port")
        return None
    log.info("plan-mcp: serving on its own event loop at 127.0.0.1:%d", state.port)
    return state.port


async def _launch(state: _OwnLoop) -> None:
    state.thread = threading.Thread(target=_thread_main, args=(state,), name="plan-mcp-loop", daemon=True)
    state.thread.start()
    await asyncio.to_thread(state.ready.wait, _START_TIMEOUT_S)


async def _stop_thread(state: _OwnLoop) -> bool:
    """Ask the state's server to exit and join its thread. False when the
    thread was still alive after the join timeout."""
    if state.server is not None and state.loop is not None:
        try:
            state.loop.call_soon_threadsafe(setattr, state.server, "should_exit", True)
        except RuntimeError:
            pass  # that loop has already closed
    if state.thread is not None:
        await asyncio.to_thread(state.thread.join, _JOIN_TIMEOUT_S)
        return not state.thread.is_alive()
    return True


_restart_lock: asyncio.Lock | None = None


async def restart() -> dict[str, Any]:
    """Replace the listener's thread and loop, on the same socket and so the
    same port: the CLIs' wired URLs keep working and no PTY is touched.

    Returns {ok, port, joined} or {ok: False, reason}: "not-running" when
    this run never served on its own loop (nothing to restart),
    "unsupported-platform" on Windows (nothing is touched; see the module
    docstring), "not-ready" when the new loop did not come up in time."""
    global _state, _restart_lock
    if _restart_lock is None:
        _restart_lock = asyncio.Lock()
    async with _restart_lock:
        old = _state
        if old is None:
            return {"ok": False, "reason": "not-running"}
        if not _SOFT_RESTART_SUPPORTED:
            return {"ok": False, "reason": "unsupported-platform"}
        joined = await _stop_thread(old)
        if not joined:
            # Still holding its own duplicate, but told to exit: it accepts
            # nothing while stuck and closes only that duplicate when it ends.
            log.warning("plan-mcp: the old own-loop thread did not stop in %.0fs; starting a new one anyway",
                        _JOIN_TIMEOUT_S)
        state = _OwnLoop(sock=old.sock, main_loop=old.main_loop)
        _state = state
        await _launch(state)
        if port() is None:
            log.warning("plan-mcp: own event loop did not come back after a restart: %s", state.error)
            return {"ok": False, "reason": "not-ready", "joined": joined}
        log.info("plan-mcp: own event loop restarted at 127.0.0.1:%d", state.port)
        return {"ok": True, "port": state.port, "joined": joined}


async def stop() -> None:
    """Stop the listener and join its thread. Idempotent."""
    global _state
    state, _state = _state, None
    if state is None:
        return
    await _stop_thread(state)
    try:
        state.sock.close()
    except OSError:
        pass
