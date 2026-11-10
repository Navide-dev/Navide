"""Local speech-to-text: the ``navide-stt`` sidecar and its whisper model.

Inert until the first ``voice.*`` request. Importing this module spawns no
process, starts no thread and touches no file: the sidecar is launched on the
first ``voice.start``, the worker pool below is created on first use, and the
model is only downloaded when the user asks for it.

Sidecar protocol (JSON Lines; stdout is protocol only, logs go to stderr):

- after the model loads it prints ``{"event":"ready",...,"gpu":bool}``, or
  ``{"event":"fatal","error":...}`` and exits;
- requests carry an ``id`` and are answered with the same ``id``;
- ``{"op":"cancel","target":<id>}`` aborts that request (no reply of its own;
  the target answers ``{"ok":false,"cancelled":true}``);
- ``{"op":"shutdown"}`` or stdin EOF ends it.

Only the process this module spawned is ever signalled — by its own handle,
never by name or pattern.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import sys
import time
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import httpx

from . import frozen_env, osplat
from .applog import app_data_dir
from .http_ssl import default_ssl_context

log = logging.getLogger(__name__)

MODEL_FILENAME = "ggml-base.bin"
# Computed from the file itself (2026-09-24); matches Hugging Face's
# X-Linked-ETag for ggerganov/whisper.cpp ggml-base.bin.
MODEL_SHA256 = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"
MODEL_BYTES = 147_951_465
MODEL_URLS: tuple[str, ...] = (
    "https://dl.navide.dev/models/whisper/ggml-base.bin",
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
)

# An idle sidecar holds the model; give it back after this long. Measured on
# macOS (base model, Metal): ~185 MB resident right after loading, ~22 MB once
# idle (the pages are compressed), so 30 minutes costs little and spares the
# cold start (a shader compile, up to a minute) after a short break.
IDLE_SHUTDOWN_S = 1800.0
# Covers model load plus the Metal warm-up; the first run after an install
# (or a whisper.cpp upgrade) compiles shaders and can take about a minute.
READY_TIMEOUT_S = 120.0
REQUEST_TIMEOUT_S = 120.0
_STOP_GRACE_S = 2.0
_PROGRESS_INTERVAL_S = 0.25
_STREAM_LIMIT = 1 << 20

_BIN_NAME = "navide-stt"

# Created on first use, never at import. Its own pool so a 148 MB download,
# the checksum and temp-file writes never queue behind (or starve) the shared
# default executor that startup work depends on.
_pool: ThreadPoolExecutor | None = None


def _executor() -> ThreadPoolExecutor:
    global _pool
    if _pool is None:
        _pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="voice")
    return _pool


async def run_blocking(fn: Callable[..., Any], *args: Any) -> Any:
    """Run blocking file work on the voice pool, off the event loop."""
    return await asyncio.get_running_loop().run_in_executor(_executor(), fn, *args)


class SidecarError(Exception):
    """The sidecar could not be started or stopped answering."""


class ModelDownloadError(Exception):
    pass


# ── Sidecar binary ──────────────────────────────────────────────────────────


def sidecar_path() -> Path | None:
    """``NAVIDE_STT_BIN`` → packaged ``<resources>/bin`` → dev build → None."""
    candidates: list[Path] = []
    override = os.environ.get("NAVIDE_STT_BIN")
    if override:
        candidates.append(Path(override).expanduser())
    dirs: list[Path] = []
    if getattr(sys, "frozen", False):
        # Next to the frozen backend, in <resources>/bin.
        dirs.append(Path(frozen_env.packaged_bin_dir()))
    dirs.append(Path(__file__).resolve().parents[2] / "native" / "navide-stt" / "target" / "release")
    names = osplat.paths.executable_candidates(_BIN_NAME)
    candidates += [folder / name for folder in dirs for name in names]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def _sidecar_argv(binary: Path, model: Path) -> list[str]:
    return [str(binary), "--model", str(model)]


# ── Model ───────────────────────────────────────────────────────────────────


def model_path() -> Path:
    return app_data_dir() / "models" / "whisper" / MODEL_FILENAME


def model_info() -> dict[str, Any]:
    """Blocking (one stat). Present means the pinned size is on disk; the
    checksum is verified once, when the download finishes."""
    path = model_path()
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    return {"present": size == MODEL_BYTES, "bytes": size, "path": str(path)}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _part_size(part: Path) -> int:
    try:
        return part.stat().st_size
    except OSError:
        return 0


def _unlink(path: Path) -> None:
    with contextlib.suppress(FileNotFoundError):
        path.unlink()


ProgressFn = Callable[[int, int], Awaitable[None]]


async def _fetch(client: httpx.AsyncClient, url: str, part: Path, on_progress: ProgressFn) -> None:
    """Fetch ``url`` into ``part``, resuming from its current size."""
    offset = await run_blocking(_part_size, part)
    headers = {"Range": f"bytes={offset}-"} if offset else {}
    async with client.stream("GET", url, headers=headers) as resp:
        if resp.status_code == 416 and offset:
            # Nothing past what we hold: the part is complete (or bogus — the
            # checksum decides).
            return
        if resp.status_code == 206 and offset:
            mode, done = "ab", offset
            content_range = resp.headers.get("content-range", "")
            total_text = content_range.rpartition("/")[2]
            total = int(total_text) if total_text.isdigit() else offset + int(resp.headers.get("content-length") or 0)
        elif resp.status_code == 200:
            # The server ignored the range (or there was none): start over.
            mode, done = "wb", 0
            total = int(resp.headers.get("content-length") or 0)
        else:
            raise ModelDownloadError(f"{url}: HTTP {resp.status_code}")
        total = total or MODEL_BYTES
        fh = await run_blocking(open, part, mode)
        try:
            last = 0.0
            async for chunk in resp.aiter_bytes(1 << 20):
                await run_blocking(fh.write, chunk)
                done += len(chunk)
                now = time.monotonic()
                if now - last >= _PROGRESS_INTERVAL_S:
                    last = now
                    await on_progress(done, total)
        finally:
            await run_blocking(fh.close)
        await on_progress(done, total)


async def download_model(on_progress: ProgressFn) -> Path:
    """Download the model into ``<app data>/models/whisper``.

    Sources are tried in order; each resumes the shared ``.part`` with an HTTP
    Range request. The file is renamed into place only after its sha256
    matches the pinned value; a mismatching part is deleted.
    """
    dest = model_path()
    part = dest.with_name(dest.name + ".part")
    await run_blocking(lambda: dest.parent.mkdir(parents=True, exist_ok=True))
    errors: list[str] = []
    timeout = httpx.Timeout(30.0, read=60.0)
    async with httpx.AsyncClient(verify=await default_ssl_context(), follow_redirects=True, timeout=timeout) as client:
        for url in MODEL_URLS:
            try:
                await _fetch(client, url, part, on_progress)
            except (httpx.HTTPError, ModelDownloadError, OSError) as err:
                log.info("voice model source failed: %s", err)
                errors.append(str(err) or type(err).__name__)
                continue
            digest = await run_blocking(_sha256_file, part)
            if digest != MODEL_SHA256:
                await run_blocking(_unlink, part)
                errors.append(f"{url}: checksum mismatch")
                continue
            await run_blocking(os.replace, part, dest)
            return dest
    raise ModelDownloadError("; ".join(errors) or "no download source")


# ── Sidecar process ─────────────────────────────────────────────────────────


class SttSidecar:
    """One lazily spawned ``navide-stt`` process, respawned after a crash."""

    def __init__(self) -> None:
        self._proc: asyncio.subprocess.Process | None = None
        self._tasks: list[asyncio.Task] = []
        self._pending: dict[str, asyncio.Future] = {}
        self._start_lock = asyncio.Lock()
        self._idle: asyncio.TimerHandle | None = None
        self._idle_task: asyncio.Task | None = None
        self._next_id = 0
        self.gpu: bool | None = None
        # Why the latest start failed; cleared by a successful one. Shown in
        # Settings so a broken engine says so instead of looking merely idle.
        self.last_error: str | None = None

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    @property
    def starting(self) -> bool:
        return self._start_lock.locked() and not self.running

    async def ensure_started(self) -> None:
        """Spawn the sidecar and wait for ``ready``. Raises SidecarError."""
        try:
            await self._ensure_started()
        except SidecarError as err:
            self.last_error = str(err)
            raise
        self.last_error = None

    async def _ensure_started(self) -> None:
        async with self._start_lock:
            if self.running:
                self._touch()
                return
            await self._reap()
            binary = sidecar_path()
            if binary is None:
                raise SidecarError("sidecar-missing")
            try:
                proc = await asyncio.create_subprocess_exec(
                    *_sidecar_argv(binary, model_path()),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    limit=_STREAM_LIMIT,
                )
            except OSError as err:
                raise SidecarError(f"spawn failed: {err}") from err
            self._proc = proc
            self._tasks = [asyncio.create_task(self._drain_stderr(proc))]
            try:
                ready = await asyncio.wait_for(self._await_ready(proc), READY_TIMEOUT_S)
            except (asyncio.TimeoutError, SidecarError) as err:
                await self._kill(proc)
                raise SidecarError(str(err) or "sidecar did not become ready") from err
            self.gpu = bool(ready.get("gpu"))
            log.info("navide-stt ready pid=%s gpu=%s", proc.pid, self.gpu)
            self._tasks.append(asyncio.create_task(self._read_responses(proc)))
            self._touch()

    async def _await_ready(self, proc: asyncio.subprocess.Process) -> dict:
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                raise SidecarError(f"sidecar exited before ready (code {await proc.wait()})")
            msg = _parse(line)
            if msg.get("event") == "ready":
                return msg
            if msg.get("event") == "fatal":
                raise SidecarError(f"sidecar fatal: {msg.get('error')}")

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        # Keeps the pipe from filling (which would block the sidecar).
        assert proc.stderr is not None
        while line := await proc.stderr.readline():
            log.debug("navide-stt: %s", line.decode("utf-8", "replace").rstrip())

    async def _read_responses(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None
        try:
            while line := await proc.stdout.readline():
                msg = _parse(line)
                future = self._pending.pop(str(msg.get("id")), None)
                if future is not None and not future.done():
                    future.set_result(msg)
        finally:
            code = await proc.wait()
            if self._proc is proc:
                log.warning("navide-stt exited (code %s)", code)
                self._proc = None
                self._cancel_idle()
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(SidecarError(f"sidecar exited (code {code})"))
            self._pending.clear()

    async def request(self, payload: dict[str, Any], timeout: float = REQUEST_TIMEOUT_S) -> dict:
        await self.ensure_started()
        proc = self._proc
        assert proc is not None and proc.stdin is not None
        self._next_id += 1
        req_id = f"r{self._next_id}"
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = future
        self._cancel_idle()
        try:
            proc.stdin.write((json.dumps({"id": req_id, **payload}, ensure_ascii=False) + "\n").encode())
            await proc.stdin.drain()
            return await asyncio.wait_for(future, timeout)
        except asyncio.CancelledError:
            # Nobody wants the answer: have the sidecar abort the work too, so
            # the next request is not stuck behind it. Its reply is dropped.
            # (wait_for has cancelled `future` by now unless a reply won.)
            if (future.cancelled() or not future.done()) and proc.returncode is None:
                with contextlib.suppress(Exception):
                    proc.stdin.write((json.dumps({"op": "cancel", "target": req_id}) + "\n").encode())
            raise
        except (BrokenPipeError, ConnectionResetError) as err:
            raise SidecarError(f"sidecar pipe closed: {err}") from err
        except asyncio.TimeoutError as err:
            # A hung sidecar is useless; the next request respawns it.
            await self._kill(proc)
            raise SidecarError("sidecar timed out") from err
        finally:
            self._pending.pop(req_id, None)
            self._touch()

    async def transcribe(
        self, pcm_path: Path, language: str, initial_prompt: str | None, segments: bool = False,
        script: str | None = None,
    ) -> dict:
        """``segments=True`` adds ``segments: [{t0_ms, t1_ms, text}]`` to the reply.
        ``script`` (``hant-tw``/``hans``/``none``) converts the text and every
        segment; None leaves whisper's output as is."""
        payload: dict[str, Any] = {"op": "transcribe", "pcm_path": str(pcm_path), "language": language}
        if initial_prompt:
            payload["initial_prompt"] = initial_prompt
        if segments:
            payload["segments"] = True
        if script:
            payload["script"] = script
        return await self.request(payload)

    async def ping(self) -> dict:
        return await self.request({"op": "ping"}, timeout=10.0)

    def _cancel_idle(self) -> None:
        if self._idle is not None:
            self._idle.cancel()
            self._idle = None

    def _touch(self) -> None:
        self._cancel_idle()
        if self.running and not self._pending:
            self._idle = asyncio.get_running_loop().call_later(
                IDLE_SHUTDOWN_S, self._fire_idle
            )

    def _fire_idle(self) -> None:
        # Held on self: a bare ensure_future task can be garbage-collected.
        self._idle_task = asyncio.ensure_future(self._idle_stop())

    async def _idle_stop(self) -> None:
        self._idle = None
        if self.running and not self._pending:
            log.info("navide-stt idle for %ss; stopping", IDLE_SHUTDOWN_S)
            await self.stop()

    async def stop(self) -> None:
        """Ask the sidecar to exit; kill it (by its own handle) if it lingers."""
        self._cancel_idle()
        # Detached first so the reader does not log this exit as a crash.
        proc, self._proc = self._proc, None
        if proc is not None and proc.returncode is None and proc.stdin is not None:
            with contextlib.suppress(Exception):
                proc.stdin.write(b'{"op":"shutdown"}\n')
                await proc.stdin.drain()
                proc.stdin.close()
            try:
                await asyncio.wait_for(proc.wait(), _STOP_GRACE_S)
            except asyncio.TimeoutError:
                await self._kill(proc)
        await self._reap()

    async def _kill(self, proc: asyncio.subprocess.Process) -> None:
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(proc.wait(), _STOP_GRACE_S)
        if self._proc is proc:
            self._proc = None

    async def _reap(self) -> None:
        tasks, self._tasks = self._tasks, []
        for task in tasks:
            if not task.done():
                with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError, Exception):
                    await asyncio.wait_for(task, _STOP_GRACE_S)
        if self._proc is not None and self._proc.returncode is not None:
            self._proc = None


def _parse(line: bytes) -> dict:
    try:
        msg = json.loads(line)
    except ValueError:
        log.warning("navide-stt: non-protocol stdout line ignored")
        return {}
    return msg if isinstance(msg, dict) else {}


_sidecar: SttSidecar | None = None


def get_sidecar() -> SttSidecar:
    global _sidecar
    if _sidecar is None:
        _sidecar = SttSidecar()
    return _sidecar


def peek_sidecar() -> SttSidecar | None:
    return _sidecar


async def shutdown() -> None:
    """Backend exit: stop the sidecar if one was ever started."""
    global _sidecar, _pool
    sidecar, _sidecar = _sidecar, None
    if sidecar is not None:
        await sidecar.stop()
    pool, _pool = _pool, None
    if pool is not None:
        pool.shutdown(wait=False, cancel_futures=True)
