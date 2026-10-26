"""A helper process that parses and wraps large third-party agent tool results.

A result longer than one piece (agent-tools contract 4.4, R2 to R3) must never
hold the backend's event loop. Parsing it, spelling it again for the agent and
neutralizing it are single C calls over the whole text (json, regex, NFKC),
and a worker thread would still hold the interpreter lock through each of
them. This process does that work with the very same functions
(``plugin_agent_tools.wrap_result``), so the agent sees the same text; the
event loop only moves bytes, a slice at a time.

Frames on stdin and stdout: an 8-byte big-endian length, then that many bytes.
A request is a JSON header frame (``{"entry": {...}}``) and the result text
(UTF-8, ``surrogatepass``). The answer is a JSON header frame (``{"ok": true}``
or ``{"ok": false, "reason": "json" | "error"}``) and, when ok, the wrapped text.
Once its imports are done the helper writes ``{"ready": true}``: a helper that
does not start or has not said so within ``READY_S`` is counted as
unavailable. Whatever fails after that is one request's failure (``crashed``
or ``timeout``), never the helper's unavailability: a result that breaks the
helper must not keep other Navide plugins' results from it. While it works it writes an empty frame every
``HEARTBEAT_S`` seconds; the backend waits ``IDLE_S`` for each frame, so a
helper that crashes or hangs is given up on in bounded time (a time window,
not a size limit).

Started as ``<backend> --agent-tool-result-worker`` (``__main__``) or, from a
source checkout, by running this file, in a session of its own. It exits when
stdin closes, and when the backend (``PARENT_ENV``) is gone it ends its whole
process tree, so it never outlives the backend.
"""

from __future__ import annotations

import asyncio
import atexit
import codecs
import json
import logging
import math
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, BinaryIO

log = logging.getLogger(__name__)

WORKER_FLAG = "--agent-tool-result-worker"
#: Seconds between the helper's empty frames while it works.
HEARTBEAT_S = 2.0
#: Seconds the backend waits for the next frame (or room to write) before it
#: gives the helper up; the same window as AGENT_TOOL_CHUNK_IDLE_MS.
IDLE_S = 30.0
#: Seconds a stopped helper gets to exit by itself before its tree is killed.
STOP_GRACE_S = 2.0
#: Seconds after a failed start before the next start is tried (each try forks).
RETRY_START_S = 60.0
#: Seconds a helper may sit idle after a request before it is stopped: what
#: a large result left in its memory goes with it, and the next large result
#: starts a new one. A time window, not a limit on work.
IDLE_EXIT_S = 60.0
#: Seconds a new helper has to say it is ready: a onefile build unpacks
#: itself on every start, which a virus scan can slow down; as IDLE_S.
READY_S = 30.0
#: The backend's pid, handed to the helper: it ends itself when that is gone.
PARENT_ENV = "NAVIDE_RESULT_HELPER_PARENT"
#: Characters encoded, and bytes decoded, per step on the event loop.
_SLICE = 1 << 18
_READY = b'{"ready": true}'


def strict_loads(text: str) -> Any:
    """``json.loads`` with the Host's JSON rules: no NaN, no Infinity, and no
    number that only parses as an infinity (``1e400``)."""

    def constant(name: str) -> Any:
        raise ValueError(f"{name} is not JSON")

    def number(spelled: str) -> float:
        value = float(spelled)
        if not math.isfinite(value):
            raise ValueError(f"{spelled} is not a finite number")
        return value

    return json.loads(text, parse_constant=constant, parse_float=number)


def _read_frame(stream: BinaryIO) -> bytes | None:
    size = stream.read(8)
    if len(size) < 8:
        return None
    data = stream.read(int.from_bytes(size, "big"))
    return data


def _write_frame(stream: BinaryIO, data: bytes) -> None:
    stream.write(len(data).to_bytes(8, "big"))
    stream.write(data)


def _end_when_parent_goes(parent: int, group: int) -> None:
    """Watch the backend; once it is gone, kill this helper's whole tree.

    A helper that is idle sees its stdin close when the backend dies; one
    that is busy or hung does not, and lives in a session of its own, so it
    checks."""
    from agent_team_backend import osplat

    while True:
        time.sleep(HEARTBEAT_S)
        if not osplat.process_tree.is_alive(parent):
            try:
                # The tree contain() made in main(): a kill-on-close job on
                # Windows (this process and all it started, not this process
                # first and its children never), this process's group on
                # POSIX when it leads one.
                osplat.process_tree.end_contained(os.getpid())
            except OSError:
                pass
            try:
                # Under a onefile bootloader on POSIX the group is the bootloader's.
                osplat.process_tree.kill_group(group, force=True)
            except OSError:
                pass
            finally:
                os._exit(1)


def _outlive_no_parent(parent: int, group: int) -> None:
    """Put this process's tree in reach (what it starts from now on is in it
    too), then end that tree once the backend `parent` is gone."""
    from agent_team_backend import osplat

    try:
        osplat.process_tree.contain(os.getpid())
    except OSError:
        pass
    threading.Thread(target=_end_when_parent_goes, args=(parent, group), daemon=True).start()


def main() -> int:
    """Serve requests until stdin closes."""
    # Frames go to the original stdout; anything else written to fd 1 from
    # here on (an import that prints) lands on stderr instead.
    out = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    stdin = sys.stdin.buffer
    parent = os.environ.get(PARENT_ENV, "")
    if parent.isdigit():
        # The group the backend started: this process, or under a onefile
        # bootloader that process.
        _outlive_no_parent(int(parent), os.getppid() if getattr(sys, "frozen", False) else os.getpid())
    from agent_team_backend.mcp_server.plugin_agent_tools import wrap_result

    _write_frame(out, _READY)
    out.flush()

    def work(header: bytes, text: bytes, done: list[tuple[dict[str, Any], bytes | None]]) -> None:
        try:
            value = strict_loads(text.decode("utf-8", "surrogatepass"))
        except (ValueError, RecursionError):
            done.append(({"ok": False, "reason": "json"}, None))
            return
        try:
            body = wrap_result(json.loads(header)["entry"], value).encode("utf-8", "surrogatepass")
        except Exception:  # noqa: BLE001 - reported to the backend as an error answer
            done.append(({"ok": False, "reason": "error"}, None))
            return
        done.append(({"ok": True}, body))

    while True:
        header = _read_frame(stdin)
        text = _read_frame(stdin) if header is not None else None
        if header is None or text is None:
            return 0
        done: list[tuple[dict[str, Any], bytes | None]] = []
        worker = threading.Thread(target=work, args=(header, text, done), daemon=True)
        worker.start()
        # The empty frames tell the backend this helper is still working.
        while True:
            worker.join(HEARTBEAT_S)
            if not worker.is_alive():
                break
            _write_frame(out, b"")
            out.flush()
        answer, body = done[0] if done else ({"ok": False, "reason": "error"}, None)
        _write_frame(out, json.dumps(answer).encode())
        if body is not None:
            _write_frame(out, body)
        out.flush()


class ResultWorkerError(Exception):
    """The helper process could not answer: ``reason`` is ``crashed`` (it died
    or broke its frames) or ``timeout`` (nothing came within IDLE_S)."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


class ResultWorkerUnavailable(ResultWorkerError):
    """The helper process cannot be used: it did not start or did not say it
    was ready. ``attempted`` is true when this call tried a start (false
    while waiting for the retry)."""

    def __init__(self, detail: str = "", *, attempted: bool) -> None:
        super().__init__("unavailable", detail)
        self.attempted = attempted


class InvalidResult(Exception):
    """The result text is not strict JSON."""


class ResultWorker:
    """The backend's side: one long-lived helper, one request at a time.

    ``state`` is ``idle`` (no helper running), ``ready`` or ``unavailable``,
    with ``last_error`` and ``since`` (ms); ``on_state`` hears every change."""

    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._lock: asyncio.Lock | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._start_failed: tuple[float, str] | None = None
        self._idle_exit: asyncio.TimerHandle | None = None
        #: The job contain() made for the running helper (Windows), so that
        #: stopping it ends that job and never another one on a reused pid.
        self._job: int | None = None
        #: The start time of a running helper contain() could not put in a
        #: job (None when it could): stopping it then ends its pid's tree only
        #: while that pid is still this helper.
        self._loose: str | None = None
        self.state = "idle"
        self.last_error = ""
        self.since = int(time.time() * 1000)
        self.on_state: Any = None

    def snapshot(self) -> dict[str, Any]:
        return {"state": self.state, "lastError": self.last_error, "since": self.since}

    def _set_state(self, state: str, error: str = "") -> None:
        if (state, error) == (self.state, self.last_error):
            return
        self.state, self.last_error, self.since = state, error, int(time.time() * 1000)
        if self.on_state is not None:
            try:
                self.on_state(self.snapshot())
            except Exception:  # noqa: BLE001 - a listener never breaks the helper
                pass

    @staticmethod
    def argv() -> list[str]:
        if getattr(sys, "frozen", False):
            return [sys.executable, WORKER_FLAG]
        return [sys.executable, str(Path(__file__)), WORKER_FLAG]

    def _bind(self) -> None:
        """Pipes and the lock belong to one event loop; a new loop starts over."""
        loop = asyncio.get_running_loop()
        if self._loop is not loop or self._lock is None:
            self.stop()
            self._loop = loop
            self._lock = asyncio.Lock()

    def _unavailable(self, detail: str) -> ResultWorkerUnavailable:
        """A start that did not give a working helper: no new start for RETRY_START_S."""
        self.stop()
        self._start_failed = (time.monotonic() + RETRY_START_S, detail)
        self._set_state("unavailable", detail)
        return ResultWorkerUnavailable(detail, attempted=True)

    async def _started(self) -> asyncio.subprocess.Process:
        self._bind()
        process = self._process
        if process is not None and process.returncode is None:
            return process
        from agent_team_backend import osplat

        if process is not None:
            # It exited since the last request, before its idle stop: end what
            # it left (its own job, once) before a new helper takes its place.
            # It adds no state change of its own: a start that then fails is
            # heard as `unavailable` alone (main sent a transient `idle` first).
            # Without a job (POSIX) its pid is the group to end; a pid alive
            # again is another process's by now.
            job, loose = self._job, self._loose
            self._process, self._job, self._loose = None, None, None
            if job is not None or loose is not None or not osplat.process_tree.is_alive(process.pid):
                _stopping[process] = (job, loose)
                _kill_tree(process)
        if self._start_failed is not None and time.monotonic() < self._start_failed[0]:
            raise ResultWorkerUnavailable(self._start_failed[1], attempted=False)
        try:
            # Its own session (process group on POSIX), so stop() ends the
            # whole tree: a onefile build runs Python under a bootloader.
            process = await asyncio.create_subprocess_exec(
                *self.argv(),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                # Not inherited on Windows: that duplicates the backend's
                # standard error handle, which mem_probe swaps on another
                # thread every minute, and a start in that window fails with
                # WinError 6. So on Windows the helper's own error output
                # (tracebacks included) no longer reaches the backend log.
                stderr=asyncio.subprocess.DEVNULL if osplat.platform_id == "win32" else None,
                limit=_SLICE,
                start_new_session=True,
                env={**os.environ, PARENT_ENV: str(os.getpid())},
            )
        except OSError as error:
            info = osplat.process_tree.stderr_handle_info()
            if info:
                log.warning(
                    "result helper could not be started: %s (%s; read after the failure, mem_probe may have restored it)",
                    error,
                    info,
                )
            raise self._unavailable(f"it could not be started: {error}") from error
        self._process = process
        self._job = None
        self._loose = None
        try:
            # The tree stop() can end whole (a kill-on-close job on Windows).
            self._job = osplat.process_tree.contain(process.pid)
        except OSError:
            self._loose = osplat.process_tree.start_time(process.pid)
        assert process.stdout is not None
        try:
            ready = await self._frame(process.stdout, READY_S)
        except (asyncio.TimeoutError, TimeoutError):
            raise self._unavailable(f"it did not say it was ready within {READY_S:g} s") from None
        except (asyncio.IncompleteReadError, OSError) as error:
            raise self._unavailable(f"it exited before it was ready ({type(error).__name__})") from None
        if ready != _READY:
            raise self._unavailable("it answered something other than ready")
        self._start_failed = None
        self._set_state("ready")
        return process

    @staticmethod
    async def _frame(stream: asyncio.StreamReader, window: float | None = None) -> bytes:
        """The next non-empty frame; each wait is bounded by ``window`` (IDLE_S),
        which the helper's empty frames (it is still working) restart."""
        window = IDLE_S if window is None else window
        while True:
            size = int.from_bytes(await asyncio.wait_for(stream.readexactly(8), window), "big")
            if size:
                return await asyncio.wait_for(stream.readexactly(size), window)

    @staticmethod
    async def _text_frame(stream: asyncio.StreamReader) -> str:
        """The next non-empty frame as text, read and decoded a slice at a
        time: the bytes are never held whole, only the text at the end."""
        size = 0
        while not size:
            size = int.from_bytes(await asyncio.wait_for(stream.readexactly(8), IDLE_S), "big")
        decoder = codecs.getincrementaldecoder("utf-8")("surrogatepass")
        parts: list[str] = []
        left = size
        while left:
            chunk = await asyncio.wait_for(stream.read(min(left, _SLICE)), IDLE_S)
            if not chunk:
                raise asyncio.IncompleteReadError(b"", left)
            left -= len(chunk)
            parts.append(decoder.decode(chunk, final=not left))
            # read() returns at once when the bytes are already buffered:
            # hand the loop back after every slice all the same.
            await asyncio.sleep(0)
        return "".join(parts)

    def _schedule_idle_exit(self) -> None:
        """Stop the helper once it has been idle for IDLE_EXIT_S."""
        if self._process is None or self._loop is None:
            return
        self._idle_exit = self._loop.call_later(IDLE_EXIT_S, self._exit_idle)

    def _exit_idle(self) -> None:
        self._idle_exit = None
        if self._lock is not None and self._lock.locked():
            return  # a request is in progress; it schedules the next check
        self.stop()

    def stop(self) -> None:
        """End the helper; the next request starts a new one.

        Its stdin is closed first, so a helper that is waiting exits by
        itself (a onefile bootloader then removes what it unpacked); after
        STOP_GRACE_S its whole process tree is killed, whatever it is doing,
        and also when it has exited (what it started may still run)."""
        if self._idle_exit is not None:
            self._idle_exit.cancel()
            self._idle_exit = None
        process, self._process = self._process, None
        if process is None:
            return
        if self.state == "ready":
            self._set_state("idle")
        if process.stdin is not None and not process.stdin.is_closing():
            try:
                process.stdin.close()
            except RuntimeError:
                pass  # its event loop is gone, and the pipe with it
        # A timer thread, not the event loop: it runs even if the loop ends
        # first; one still waiting when the backend exits is run then.
        _stopping[process] = (self._job, self._loose)
        self._job = self._loose = None
        timer = threading.Timer(STOP_GRACE_S if process.returncode is None else 0, _kill_tree, args=(process,))
        timer.daemon = True
        timer.start()

    async def wrap(self, entry: dict[str, Any], pieces: list[str]) -> str:
        """``wrap_result(entry, strict_loads("".join(pieces)))``, computed by the helper.

        Raises InvalidResult when the text is not strict JSON,
        ResultWorkerUnavailable when no helper starts and says it is ready,
        and ResultWorkerError when a ready helper fails this request. The
        event loop only encodes, writes, reads and decodes, a slice at a time.
        """
        self._bind()
        assert self._lock is not None
        async with self._lock:
            if self._idle_exit is not None:
                self._idle_exit.cancel()
                self._idle_exit = None
            try:
                return await self._wrap_locked(entry, pieces)
            finally:
                self._schedule_idle_exit()

    async def _wrap_locked(self, entry: dict[str, Any], pieces: list[str]) -> str:
        try:
            process = await self._started()
            assert process.stdin is not None and process.stdout is not None
            header = json.dumps({"entry": entry}).encode()
            process.stdin.write(len(header).to_bytes(8, "big") + header)
            encoded: list[bytes] = []
            for piece in pieces:
                encoded.append(piece.encode("utf-8", "surrogatepass"))
                await asyncio.sleep(0)
            process.stdin.write(sum(len(part) for part in encoded).to_bytes(8, "big"))
            for part in encoded:
                process.stdin.write(part)
                await asyncio.wait_for(process.stdin.drain(), IDLE_S)
            answer = json.loads(await self._frame(process.stdout))
            if not answer.get("ok"):
                if answer.get("reason") == "json":
                    raise InvalidResult
                raise ResultWorkerError("crashed", f"the helper reported {answer.get('reason')}")
            text = await self._text_frame(process.stdout)
        except (InvalidResult, ResultWorkerUnavailable):
            raise
        except BaseException as error:
            # A request cut short leaves the pipes mid-frame: start over next time.
            if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
                failure = ResultWorkerError("timeout", f"nothing for {IDLE_S:g} s")
            elif isinstance(error, ResultWorkerError):
                failure = error
            elif isinstance(error, Exception):
                failure = ResultWorkerError("crashed", f"{type(error).__name__}: {error}")
            else:
                self.stop()
                raise
            # A ready helper that fails is this request's failure: the next
            # request starts a new helper at once.
            self.stop()
            raise failure from error
        return text


#: Helpers stopped whose grace has not run out yet, with the job contain()
#: made for each (None on POSIX or when there is none) and, when contain()
#: failed, the helper's start time (None otherwise).
_stopping: dict[asyncio.subprocess.Process, tuple[int | None, str | None]] = {}


@atexit.register
def _kill_stopping() -> None:
    for process in list(_stopping):
        _kill_tree(process)


def _kill_tree(process: asyncio.subprocess.Process) -> None:
    """Kill a helper with every process under it, also when the helper itself
    has exited: what it started may still run."""
    try:
        # Taken out before it is ended, so the timer and the exit hook never
        # both end it (closing the same job handle twice).
        job, loose = _stopping.pop(process)
    except KeyError:
        return
    from agent_team_backend import osplat

    try:
        if loose is not None:
            # No job of its own: a job table entry for its pid is someone
            # else's (a pane spawned onto it), so only the pid's tree is
            # killed, and only while that pid is still this helper. A start
            # time that could not be read leaves it to its parent watchdog.
            if loose and osplat.process_tree.start_time(process.pid) == loose:
                osplat.process_tree.kill_tree(process.pid, force=True)
            return
        osplat.process_tree.end_contained(process.pid, job)
    except OSError:
        pass


if __name__ == "__main__":
    # Run from a source checkout: import this checkout's package.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    raise SystemExit(main())
