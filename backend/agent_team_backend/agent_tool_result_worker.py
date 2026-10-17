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
While it works the helper writes an empty frame every ``HEARTBEAT_S`` seconds;
the backend waits ``IDLE_S`` for each frame, so a helper that crashes or hangs
is given up on in bounded time (a time window, not a size limit) and the
result is handled in the backend process instead.

Started as ``<backend> --agent-tool-result-worker`` (``__main__``) or, from a
source checkout, by running this file. It exits when stdin closes, so it never
outlives the backend.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import sys
import threading
from pathlib import Path
from typing import Any, BinaryIO

WORKER_FLAG = "--agent-tool-result-worker"
#: Seconds between the helper's empty frames while it works.
HEARTBEAT_S = 2.0
#: Seconds the backend waits for the next frame (or room to write) before it
#: gives the helper up; the same window as AGENT_TOOL_CHUNK_IDLE_MS.
IDLE_S = 30.0
#: Characters encoded, and bytes decoded, per step on the event loop.
_SLICE = 1 << 18


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


def main() -> int:
    """Serve requests until stdin closes."""
    # Frames go to the original stdout; anything else written to fd 1 from
    # here on (an import that prints) lands on stderr instead.
    out = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    stdin = sys.stdin.buffer
    from agent_team_backend.mcp_server.plugin_agent_tools import wrap_result

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
    """The helper process could not answer (it failed to start or died)."""


class InvalidResult(Exception):
    """The result text is not strict JSON."""


class ResultWorker:
    """The backend's side: one long-lived helper, one request at a time."""

    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._lock: asyncio.Lock | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    @staticmethod
    def argv() -> list[str]:
        if getattr(sys, "frozen", False):
            return [sys.executable, WORKER_FLAG]
        return [sys.executable, str(Path(__file__)), WORKER_FLAG]

    async def _started(self) -> asyncio.subprocess.Process:
        process = self._process
        if process is not None and process.returncode is None:
            return process
        self._process = await asyncio.create_subprocess_exec(
            *self.argv(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            limit=_SLICE,
        )
        return self._process

    @staticmethod
    async def _frame(stream: asyncio.StreamReader) -> bytes:
        """The next non-empty frame; each wait is bounded by IDLE_S, which the
        helper's empty frames (it is still working) restart."""
        while True:
            size = int.from_bytes(await asyncio.wait_for(stream.readexactly(8), IDLE_S), "big")
            if size:
                return await asyncio.wait_for(stream.readexactly(size), IDLE_S)

    def stop(self) -> None:
        """Kill the helper; the next request starts a new one."""
        process, self._process = self._process, None
        if process is not None and process.returncode is None:
            process.kill()

    async def wrap(self, entry: dict[str, Any], pieces: list[str]) -> str:
        """``wrap_result(entry, strict_loads("".join(pieces)))``, computed by the helper.

        Raises InvalidResult when the text is not strict JSON, and
        ResultWorkerError when the helper cannot answer. The event loop only
        encodes, writes, reads and decodes, a slice at a time.
        """
        # Pipes and the lock belong to one event loop; a new loop starts over.
        loop = asyncio.get_running_loop()
        if self._loop is not loop or self._lock is None:
            self.stop()
            self._loop = loop
            self._lock = asyncio.Lock()
        async with self._lock:
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
                    raise ResultWorkerError(str(answer.get("reason")))
                data = await self._frame(process.stdout)
            except (InvalidResult, ResultWorkerError):
                raise
            except BaseException as error:
                # A request cut short leaves the pipes mid-frame: start over next time.
                self.stop()
                if isinstance(error, Exception):
                    raise ResultWorkerError(str(error)) from error
                raise
        parts: list[str] = []
        start = 0
        while len(data) - start > _SLICE:
            end = start + _SLICE
            while data[end] & 0xC0 == 0x80:
                end -= 1
            parts.append(data[start:end].decode("utf-8", "surrogatepass"))
            start = end
            await asyncio.sleep(0)
        parts.append(data[start:].decode("utf-8", "surrogatepass"))
        return "".join(parts)


if __name__ == "__main__":
    # Run from a source checkout: import this checkout's package.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    raise SystemExit(main())
