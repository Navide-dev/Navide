"""ACP sessions: one agent process per ACP pane, and what runs on it.

``AcpSessionService`` is to an ACP pane what ``TerminalService`` is to a
terminal pane: it starts the agent, keeps it registered for crash recovery,
runs its turns and stops it. The protocol itself is ``acp_client``.

- Start: the agent runs in a session (POSIX) or kill-on-close Job (Windows) of
  its own via ``osplat.process_tree.contain``, so stopping it ends everything
  it started; its pid is recorded in ``pty_registry`` like a PTY child's, so a
  backend that dies without stopping it has it reaped on the next start.
- Turns: a prompt sent while a turn runs waits for that turn (no cap on how
  many wait). A turn ends only when the agent answers it (ACP has no
  session/stop); ``cancel`` asks it to, and nothing is killed for not obeying.
- Stop: close the agent's stdin, give it the vendor's grace (``ShutdownSpec``)
  to exit, then end its whole tree. ``abandon`` stops a pane's agent by pane id,
  also one still starting: its start then fails with ``acp-cancelled`` and
  nothing it started is left running, however far the start had got. A start
  that fails or is cancelled at any point after the spawn (registration,
  handshake, the request being dropped) ends what it started before the error
  goes on. Descendants are recorded after the handshake and at each turn's
  start and end, so a grandchild that left the agent's group (setsid) is ended
  too when the agent exits on its own; one started and detached since the last
  record can outlive it (POSIX only — on Windows the kill-on-close Job holds
  the whole tree). The agent's own stderr goes to
  ``logs/acp-<session>.log`` (owner only), whose tail is shown when it exits.

Events go to ``emit`` as dicts: ``acp.state``, ``acp.update`` (each
session/update as the agent sent it), ``acp.permission`` (a request waiting
for an answer), ``acp.turn_end`` and ``acp.exit``. Terminal panes and
``TerminalService`` are not touched.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import uuid
import weakref
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import osplat, pty_registry
from .acp_client import AcpClient, AcpClosed, AcpError, AcpInitResult, AcpProtocolError
from .applog import app_data_dir, in_data_dir, log_dir

log = logging.getLogger("agent_team_backend.acp_sessions")

EventSink = Callable[[dict[str, Any]], Awaitable[None]]

# How long a stopping agent gets after its stdin closes, when its vendor
# declares no ShutdownSpec; then SIGTERM, then the whole tree is ended.
_DEFAULT_STOP_GRACE_S = 2.0
_TERM_GRACE_S = 1.0
_STDERR_TAIL_LINES = 20
_STDERR_TAIL_BYTES = 8192

CLIENT_INFO = {"name": "Navide", "title": "Navide"}


class AcpStartError(Exception):
    """The agent could not be started or did not complete the handshake."""

    def __init__(self, code: str, message: str, stderr_tail: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.stderr_tail = stderr_tail


@dataclass
class _Permission:
    request_id: str
    params: dict[str, Any]
    answer: asyncio.Future[str | None]


@dataclass
class _Spawned:
    """A process a start has spawned, until the start ends one way or the other."""

    proc: asyncio.subprocess.Process
    job: int | None = None
    registered: bool = False


@dataclass
class AcpSession:
    id: str
    pane_id: str
    agent_key: str
    cwd: str
    argv: list[str]
    proc: asyncio.subprocess.Process
    client: AcpClient
    job: int | None = None
    acp_session_id: str = ""
    init: AcpInitResult | None = None
    # starting | idle | running | cancelling | exited
    state: str = "starting"
    queue: list[str] = field(default_factory=list)
    permissions: dict[str, _Permission] = field(default_factory=dict)
    turn: asyncio.Task[None] | None = None
    stderr_path: Path | None = None
    exit_code: int | None = None
    stopping: bool = False  # kill() owns the exit: no "exited on its own" event
    # The agent's descendants as last recorded (pid -> start-time identity).
    descendants: dict[int, str] = field(default_factory=dict)

    def stderr_tail(self) -> str:
        if self.stderr_path is None:
            return ""
        try:
            with open(self.stderr_path, "rb") as f:
                f.seek(0, os.SEEK_END)
                f.seek(max(0, f.tell() - _STDERR_TAIL_BYTES))
                text = f.read().decode("utf-8", errors="replace")
        except OSError:
            return ""
        return "\n".join(text.strip().splitlines()[-_STDERR_TAIL_LINES:])

    def snapshot(self) -> dict[str, Any]:
        """What a status read (or a reattaching window) needs."""
        return {
            "session_id": self.id,
            "pane_id": self.pane_id,
            "agent_key": self.agent_key,
            "acp_session_id": self.acp_session_id,
            "state": self.state,
            "queued": len(self.queue),
            "permissions": [
                {"request_id": p.request_id, "toolCall": p.params.get("toolCall"),
                 "options": p.params.get("options")}
                for p in self.permissions.values()
            ],
            "load_session": bool(self.init and self.init.load_session),
            "agent_info": dict(self.init.agent_info) if self.init else {},
        }


class AcpSessionService:
    def __init__(self, emit: EventSink) -> None:
        self._emit = emit
        self._sessions: dict[str, AcpSession] = {}
        self._watchers: set[asyncio.Task[None]] = set()
        self._data_dir = app_data_dir()
        # Creates in progress per pane (two can overlap for one pane), and the
        # panes closed meanwhile; a pane's mark lasts until its last create ends.
        self._creating: dict[str, int] = {}
        self._abandoned: set[str] = set()
        self._spawned: dict[str, _Spawned] = {}

    def get(self, session_id: str) -> AcpSession | None:
        return self._sessions.get(session_id)

    def list(self) -> list[AcpSession]:
        return list(self._sessions.values())

    # -- start ------------------------------------------------------------

    async def create(
        self,
        *,
        pane_id: str,
        agent_key: str,
        argv: list[str],
        cwd: str,
        env: dict[str, str] | None = None,
        load_session_id: str = "",
        mcp_servers: list[dict[str, Any]] | None = None,
    ) -> AcpSession:
        """Start the agent, hand shake, open (or load) its session.

        Raises AcpStartError with a code the pane shows and a stderr tail;
        whatever was started is stopped first. Nothing falls back to a
        terminal pane on its own.
        """
        self._creating[pane_id] = self._creating.get(pane_id, 0) + 1
        try:
            return await self._create(
                pane_id=pane_id, agent_key=agent_key, argv=argv, cwd=cwd, env=env,
                load_session_id=load_session_id, mcp_servers=mcp_servers,
            )
        finally:
            left = self._creating.get(pane_id, 1) - 1
            if left > 0:
                self._creating[pane_id] = left
            else:
                self._creating.pop(pane_id, None)
                self._abandoned.discard(pane_id)

    async def abandon(self, pane_id: str) -> bool:
        """Stop the pane's agent now, also while it is still starting (the pane
        was closed). False when the pane has no agent and no start under way."""
        starting = self._creating.get(pane_id, 0) > 0
        if starting:
            self._abandoned.add(pane_id)
        # Every agent of the pane: two overlapping starts each have one.
        sessions = [s for s in self._sessions.values() if s.pane_id == pane_id and not s.stopping]
        await asyncio.gather(*(self.kill(s.id) for s in sessions))
        return starting or bool(sessions)

    def by_pane(self, pane_id: str) -> AcpSession | None:
        """The pane's agent (starting or running), or None."""
        if not pane_id:
            return None
        for session in self._sessions.values():
            if session.pane_id == pane_id and not session.stopping:
                return session
        return None

    async def _create(
        self, *, pane_id: str, agent_key: str, argv: list[str], cwd: str,
        env: dict[str, str] | None, load_session_id: str, mcp_servers: list[dict[str, Any]] | None,
    ) -> AcpSession:
        session_id = uuid.uuid4().hex
        try:
            return await self._start(
                session_id, pane_id=pane_id, agent_key=agent_key, argv=argv, cwd=cwd, env=env,
                load_session_id=load_session_id, mcp_servers=mcp_servers,
            )
        except BaseException:
            # Whatever failed or cancelled the start, nothing it spawned outlives it.
            await asyncio.shield(self._abort_start(session_id))
            raise
        finally:
            self._spawned.pop(session_id, None)

    async def _start(
        self, session_id: str, *, pane_id: str, agent_key: str, argv: list[str], cwd: str,
        env: dict[str, str] | None, load_session_id: str, mcp_servers: list[dict[str, Any]] | None,
    ) -> AcpSession:
        stderr_path = log_dir() / f"acp-{session_id}.log"
        try:
            fd = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        except OSError as err:
            raise AcpStartError("acp-start-failed", f"cannot open the agent's log: {err}") from err
        try:
            proc = await _spawn(
                argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=fd,
                cwd=cwd,
                env=env if env is not None else dict(os.environ),
                start_new_session=True,
            )
        except OSError as err:
            os.close(fd)
            raise AcpStartError("acp-start-failed", f"{argv[0]} could not be started: {err}") from err
        os.close(fd)  # the child holds its own copy
        spawned = self._spawned[session_id] = _Spawned(proc)
        job: int | None = None
        try:
            job = spawned.job = osplat.process_tree.contain(proc.pid)
        except OSError as err:
            log.warning("ACP %s: not contained (%s); its tree is ended by pid instead", session_id, err)
        # Marked first: a start cancelled while the write runs still unregisters.
        # Should the write land after that, the entry it leaves is reaped on the
        # next start only if pid + start time still match (pty_registry.reap_stale).
        spawned.registered = True
        await asyncio.to_thread(in_data_dir(self._data_dir, pty_registry.register, proc.pid, argv))

        assert proc.stdout is not None and proc.stdin is not None
        holder: dict[str, AcpSession] = {}
        client = AcpClient(
            proc.stdout, proc.stdin,
            on_update=lambda params: self._on_update(holder["s"], params),
            on_permission=lambda params: self._on_permission(holder["s"], params),
        )
        session = AcpSession(
            id=session_id, pane_id=pane_id, agent_key=agent_key, cwd=cwd, argv=list(argv),
            proc=proc, client=client, job=job, stderr_path=stderr_path,
        )
        holder["s"] = session
        self._sessions[session_id] = session
        spawned.registered = False  # from here kill() unregisters it, with the session
        client.start()
        watcher = asyncio.ensure_future(self._watch_exit(session))
        self._watchers.add(watcher)
        watcher.add_done_callback(self._watchers.discard)
        await self._abandon_if_closed(session)
        await self._set_state(session, "starting")
        try:
            session.init = await client.initialize(CLIENT_INFO)
            if load_session_id:
                if not session.init.load_session:
                    raise AcpStartError("acp-no-load", "this agent cannot load an earlier session")
                await client.load_session(load_session_id, cwd, mcp_servers)
                session.acp_session_id = load_session_id
            else:
                session.acp_session_id = await client.new_session(cwd, mcp_servers)
        except AcpStartError as err:
            await self.kill(session_id)
            err.stderr_tail = err.stderr_tail or session.stderr_tail()
            raise
        except (AcpClosed, AcpError, AcpProtocolError) as err:
            await self.kill(session_id)
            await self._abandon_if_closed(session)
            code = "acp-auth-required" if _needs_auth(err, session.init) else "acp-handshake-failed"
            raise AcpStartError(code, str(err), session.stderr_tail()) from err
        await self._abandon_if_closed(session)
        await self._note_descendants(session)
        await self._set_state(session, "idle")
        if session.queue:
            self._start_turn(session, session.queue.pop(0))
        return session

    async def _abandon_if_closed(self, session: AcpSession) -> None:
        """The pane was closed while this start ran: stop what it started, now."""
        if session.pane_id not in self._abandoned:
            return
        await self.kill(session.id)
        raise AcpStartError("acp-cancelled", "the pane was closed while its agent was starting")

    async def _abort_start(self, session_id: str) -> None:
        """End what a failed or cancelled start spawned: the registered session
        through kill(), or a process not yet a session by its tree."""
        if session_id in self._sessions:
            await self.kill(session_id)
            return
        spawned = self._spawned.get(session_id)
        if spawned is None:
            return
        from .terminals import _descendant_pids, _kill_breakaway

        proc = spawned.proc
        descendants: dict[int, str] = {}
        if proc.returncode is None:
            with contextlib.suppress(OSError):
                descendants = await asyncio.to_thread(_descendant_pids, proc.pid)
            try:
                osplat.process_tree.end_contained(proc.pid, spawned.job)
            except OSError:
                with contextlib.suppress(OSError):
                    osplat.process_tree.kill_tree(proc.pid, force=True)
            await self._wait_exit(proc, _TERM_GRACE_S)
        await asyncio.to_thread(_kill_breakaway, descendants)
        if spawned.registered:
            await asyncio.to_thread(in_data_dir(self._data_dir, pty_registry.unregister, proc.pid))

    async def _note_descendants(self, session: AcpSession) -> None:
        """Record the agent's descendants while it runs (see the module doc)."""
        from .terminals import _descendant_pids

        if session.proc.returncode is not None:
            return
        try:
            # Added to, not replaced: a record taken as the agent dies finds no
            # children, and must not erase the ones seen while it ran.
            session.descendants.update(await asyncio.to_thread(_descendant_pids, session.proc.pid))
        except OSError:
            pass

    # -- turns ------------------------------------------------------------

    async def prompt(self, session_id: str, text: str) -> str:
        """Send ``text`` as a prompt: "sent" now, or "queued" behind the running turn."""
        session = self._require(session_id)
        # Starting: it has no ACP session yet; the prompt goes once it is idle.
        if session.state in ("starting", "running", "cancelling"):
            session.queue.append(text)
            await self._set_state(session, session.state)
            return "queued"
        self._start_turn(session, text)
        return "sent"

    async def cancel(self, session_id: str) -> bool:
        """Ask the agent to end the running turn; False when none runs."""
        session = self._require(session_id)
        if session.state != "running":
            return False
        await self._set_state(session, "cancelling")
        await session.client.cancel(session.acp_session_id)
        return True

    def answer_permission(self, session_id: str, request_id: str, option_id: str | None) -> bool:
        """Answer a waiting permission request (None = cancelled); False when it is gone."""
        session = self._require(session_id)
        pending = session.permissions.get(request_id)
        if pending is None or pending.answer.done():
            return False
        if option_id is not None and option_id not in {
            str(o["optionId"]) for o in pending.params.get("options") or []
            if isinstance(o, dict) and o.get("optionId") is not None
        }:
            raise ValueError(f"no option {option_id!r} in this request")
        pending.answer.set_result(option_id)
        return True

    def _start_turn(self, session: AcpSession, text: str) -> None:
        session.state = "running"
        session.turn = asyncio.ensure_future(self._run_turn(session, text))

    async def _run_turn(self, session: AcpSession, text: str) -> None:
        await self._set_state(session, "running")
        await self._note_descendants(session)
        stop_reason, error = "", ""
        try:
            stop_reason = await session.client.prompt(session.acp_session_id, text)
        except (AcpClosed, AcpError, AcpProtocolError) as err:
            error = str(err)
        if session.state == "exited":
            return
        await self._note_descendants(session)
        await self._emit_event(session, "acp.turn_end", {"stopReason": stop_reason, "error": error})
        if session.queue and session.client.closed is False:
            self._start_turn(session, session.queue.pop(0))
            return
        await self._set_state(session, "idle")

    # -- agent -> Navide --------------------------------------------------

    async def _on_update(self, session: AcpSession, params: dict[str, Any]) -> None:
        await self._emit_event(session, "acp.update", {"update": params.get("update")})

    async def _on_permission(self, session: AcpSession, params: dict[str, Any]) -> str | None:
        request = _Permission(uuid.uuid4().hex, params, asyncio.get_running_loop().create_future())
        session.permissions[request.request_id] = request
        try:
            await self._emit_event(session, "acp.permission", {
                "request_id": request.request_id,
                "toolCall": params.get("toolCall"),
                "options": params.get("options"),
            })
            return await request.answer
        finally:
            session.permissions.pop(request.request_id, None)
            await self._emit_event(session, "acp.permission_closed", {"request_id": request.request_id})

    # -- stop -------------------------------------------------------------

    async def kill(self, session_id: str) -> None:
        """Stop the agent: stdin closed, the vendor's grace, SIGTERM, then its whole tree."""
        session = self._sessions.get(session_id)
        if session is None:
            return
        from .terminals import _descendant_pids, _kill_breakaway

        session.stopping = True
        proc = session.proc
        descendants: dict[int, str] = {}
        if proc.returncode is None:
            # Taken while it runs: a grandchild that left its group is found
            # only here (after the exit it has reparented).
            descendants = await asyncio.to_thread(_descendant_pids, proc.pid)
        # With every one recorded earlier (identity-checked before any kill).
        descendants = {**session.descendants, **descendants}
        await _close_client(session)
        await self._wait_exit(proc, _stop_grace(session.agent_key))
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
                osplat.process_tree.kill_group(osplat.process_tree.group_of(proc.pid), force=False)
            await self._wait_exit(proc, _TERM_GRACE_S)
        self._end_tree(session)
        await self._wait_exit(proc, _TERM_GRACE_S)
        await asyncio.to_thread(_kill_breakaway, descendants)
        await self._forget(session)

    async def kill_all(self) -> None:
        # A start still under way would otherwise spawn its agent after this
        # sweep (the backend is going away): it stops it the moment it has one.
        self._abandoned.update(self._creating)
        await asyncio.gather(*(self.kill(sid) for sid in list(self._sessions)), return_exceptions=True)

    def _end_tree(self, session: AcpSession) -> None:
        try:
            osplat.process_tree.end_contained(session.proc.pid, session.job)
        except OSError:
            with contextlib.suppress(OSError):
                osplat.process_tree.kill_tree(session.proc.pid, force=True)

    @staticmethod
    async def _wait_exit(proc: asyncio.subprocess.Process, grace: float) -> None:
        if proc.returncode is not None:
            return
        with contextlib.suppress(TimeoutError, asyncio.TimeoutError):
            await asyncio.wait_for(_exited(proc), grace)

    async def _watch_exit(self, session: AcpSession) -> None:
        code = await _exited(session.proc)
        session.exit_code = code
        if session.stopping or session.id not in self._sessions:
            return
        # It exited on its own: say so first, then end what it left running
        # (breakaway grandchildren included, from the last record of them),
        # which also releases a pipe one of them still holds, and only then
        # close the connection — bounded, never waiting on the pipe's EOF.
        await self._emit_event(session, "acp.exit", {"code": code, "stderr_tail": session.stderr_tail()})
        await self._forget(session)
        self._end_tree(session)
        from .terminals import _kill_breakaway

        await asyncio.to_thread(_kill_breakaway, session.descendants)
        await _close_client(session)

    async def _forget(self, session: AcpSession) -> None:
        if self._sessions.pop(session.id, None) is None:
            return
        session.state = "exited"
        for request in list(session.permissions.values()):
            if not request.answer.done():
                request.answer.set_result(None)
        try:
            await asyncio.to_thread(in_data_dir(self._data_dir, pty_registry.unregister, session.proc.pid))
        except Exception as err:  # noqa: BLE001 — the exit is still reported (owners cleared on it)
            log.warning("ACP %s: crash-registry entry not removed: %s", session.id, err)
        await self._emit_event(session, "acp.state", {"state": "exited", "code": session.proc.returncode})

    # -- events -----------------------------------------------------------

    async def _set_state(self, session: AcpSession, state: str) -> None:
        if session.state == "exited":
            return
        session.state = state
        await self._emit_event(session, "acp.state", {"state": state, "queued": len(session.queue)})

    async def _emit_event(self, session: AcpSession, kind: str, payload: dict[str, Any]) -> None:
        try:
            await self._emit({"type": kind, "payload": {
                "session_id": session.id, "pane_id": session.pane_id, **payload,
            }})
        except Exception as err:  # noqa: BLE001
            log.warning("ACP %s: %s event not delivered: %s", session.id, kind, err)

    def _require(self, session_id: str) -> AcpSession:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"no ACP session {session_id}")
        return session


async def _close_client(session: AcpSession) -> None:
    """Close the agent's connection without waiting on its output's EOF, which
    a descendant holding the pipe can postpone for ever."""
    with contextlib.suppress(TimeoutError, asyncio.TimeoutError):
        await asyncio.wait_for(session.client.close(), _TERM_GRACE_S)


class _ExitSignal(asyncio.subprocess.SubprocessStreamProtocol):
    """asyncio's own subprocess protocol (create_subprocess_exec uses it), plus
    a future done the moment the process exits: process_exited fires then,
    whereas Process.wait() also waits for every pipe to close."""

    def __init__(self, *, limit: int, loop: asyncio.AbstractEventLoop) -> None:
        super().__init__(limit=limit, loop=loop)
        self.exited: asyncio.Future[None] = loop.create_future()

    def process_exited(self) -> None:
        super().process_exited()
        if not self.exited.done():
            self.exited.set_result(None)


# A spawned agent -> its exit signal (see _exited).
_EXIT_SIGNALS: "weakref.WeakKeyDictionary[asyncio.subprocess.Process, asyncio.Future[None]]" = (
    weakref.WeakKeyDictionary()
)


async def _spawn(
    argv: list[str], *, stdin: int, stdout: int, stderr: int, cwd: str,
    env: dict[str, str], start_new_session: bool,
) -> asyncio.subprocess.Process:
    """asyncio.create_subprocess_exec, built the same way, with the exit signal.
    Every stream is named (no inherited stderr handle: #445)."""
    loop = asyncio.get_running_loop()
    transport, protocol = await loop.subprocess_exec(
        lambda: _ExitSignal(limit=2**16, loop=loop), *argv,
        stdin=stdin, stdout=stdout, stderr=stderr, cwd=cwd, env=env,
        start_new_session=start_new_session,
    )
    proc = asyncio.subprocess.Process(transport, protocol, loop)
    _EXIT_SIGNALS[proc] = protocol.exited
    return proc


async def _exited(proc: asyncio.subprocess.Process) -> int:
    """The agent's exit code once it has exited.

    Not proc.wait() alone: that also waits for every pipe to close, and a
    descendant that inherited the agent's stdout keeps it open after the agent
    is gone — the exit would never be seen, nothing would end that descendant,
    and the pane would read running forever. Event-driven: the exit signal is
    set by asyncio's child watcher as the process exits, pipes or not.
    """
    signal = _EXIT_SIGNALS.get(proc)
    if signal is None:  # not spawned here
        return await proc.wait()
    if proc.returncode is None:
        await asyncio.shield(signal)
    assert proc.returncode is not None
    return proc.returncode


def _stop_grace(agent_key: str) -> float:
    from .cli_vendors.registry import vendor

    spec = vendor(agent_key)
    shutdown = spec.shutdown if spec is not None else None
    return float(shutdown.grace_s) if shutdown is not None else _DEFAULT_STOP_GRACE_S


def _needs_auth(err: Exception, init: AcpInitResult | None) -> bool:
    """The agent wants a sign-in Navide does not perform (ACP `authenticate`):
    an auth error code (-32000 "auth required" in the ACP schema) on session/new
    from an agent that declared authentication methods."""
    return isinstance(err, AcpError) and err.code == -32000 and bool(init and init.auth_methods)
