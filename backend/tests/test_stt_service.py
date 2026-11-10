"""stt_service: sidecar lifecycle against a fake sidecar, and the model
download (resume, checksum) against a local HTTP server."""

from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from agent_team_backend import stt_service

FAKE = Path(__file__).with_name("fake_navide_stt.py")


@pytest.fixture
def fake_sidecar(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(stt_service, "sidecar_path", lambda: FAKE)
    monkeypatch.setattr(
        stt_service, "_sidecar_argv", lambda binary, model: [sys.executable, str(binary), "--model", str(model)]
    )
    return stt_service.SttSidecar()


async def _stop(sidecar: stt_service.SttSidecar) -> None:
    await sidecar.stop()


# ── Sidecar ────────────────────────────────────────────────────────────────


def test_import_is_inert() -> None:
    """Loading the voice modules must not spawn, start a thread or create
    the pool. A fresh interpreter, since other tests here use the pool."""
    code = (
        "import threading\n"
        "from agent_team_backend import stt_service, voice_handlers\n"
        "assert stt_service.peek_sidecar() is None\n"
        "assert stt_service._pool is None\n"
        "assert voice_handlers._download_task is None\n"
        "assert not [t for t in threading.enumerate() if t.name.startswith('voice')]\n"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr


def test_handlers_registered() -> None:
    from agent_team_backend import voice_handlers, ws_handlers

    assert ws_handlers.lookup("voice.start") is voice_handlers.voice_start
    for name in ("status", "model.download", "chunk", "stop", "cancel"):
        assert ws_handlers.lookup(f"voice.{name}") is not None


async def test_ready_ping_and_transcribe(fake_sidecar, tmp_path: Path) -> None:
    await fake_sidecar.ensure_started()
    try:
        assert fake_sidecar.running
        assert fake_sidecar.gpu is False
        assert await fake_sidecar.ping() == {"id": "r1", "ok": True}
        pcm = tmp_path / "a.pcm"
        pcm.write_bytes(b"\0" * 3200)
        result = await fake_sidecar.transcribe(pcm, "zh", None)
        assert result["ok"] is True
        assert result["text"] == "bytes=3200 lang=zh prompt=-"
        result = await fake_sidecar.transcribe(pcm, "en", "hint")
        assert result["text"] == "bytes=3200 lang=en prompt=hint"
        # Without a script (above) no `script` field is sent at all.
        result = await fake_sidecar.transcribe(pcm, "zh", None, script="hant-tw")
        assert result["text"] == "bytes=3200 lang=zh prompt=- script=hant-tw"
    finally:
        await _stop(fake_sidecar)
    assert not fake_sidecar.running


async def test_transcribe_segments_flag(fake_sidecar, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_STT_DECODE", "1")
    log_path = tmp_path / "log.jsonl"
    monkeypatch.setenv("FAKE_STT_LOG", str(log_path))
    pcm = tmp_path / "a.pcm"
    tone = lambda v: v.to_bytes(2, "little", signed=True) * 3200  # noqa: E731 - 200 ms
    pcm.write_bytes(tone(1000) + bytes(1600) + tone(1001) + bytes(1600))
    try:
        plain = await fake_sidecar.transcribe(pcm, "zh", None)
        assert plain["text"] == "\u4e00\u4e01" and "segments" not in plain
        result = await fake_sidecar.transcribe(pcm, "zh", None, segments=True)
        assert result["segments"] == [{"t0_ms": 0, "t1_ms": 500, "text": "\u4e00\u4e01"}]
    finally:
        await _stop(fake_sidecar)
    flags = [json.loads(line)["segments"] for line in log_path.read_text(encoding="utf-8").splitlines()]
    assert flags == [False, True]


async def test_cancelled_request_is_aborted_in_the_sidecar(
    fake_sidecar, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAKE_STT_DELAY_S", "5")
    pcm = tmp_path / "a.pcm"
    pcm.write_bytes(b"\0" * 3200)
    try:
        task = asyncio.create_task(fake_sidecar.transcribe(pcm, "zh", None))
        for _ in range(500):
            if fake_sidecar._pending or task.done():
                break
            await asyncio.sleep(0.01)
        assert fake_sidecar._pending, "request never reached the sidecar"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        # The sidecar is serial: this answers only because the 5 s request was aborted.
        assert await asyncio.wait_for(fake_sidecar.ping(), 2) == {"id": "r2", "ok": True}
    finally:
        await _stop(fake_sidecar)


async def test_concurrent_requests_are_matched_by_id(fake_sidecar) -> None:
    try:
        results = await asyncio.gather(*(fake_sidecar.ping() for _ in range(5)))
        assert sorted(r["id"] for r in results) == [f"r{i}" for i in range(1, 6)]
    finally:
        await _stop(fake_sidecar)


async def test_crash_fails_pending_then_respawns(fake_sidecar) -> None:
    try:
        await fake_sidecar.ensure_started()
        first_pid = fake_sidecar._proc.pid
        with pytest.raises(stt_service.SidecarError):
            await fake_sidecar.request({"op": "crash"}, timeout=5)
        for _ in range(50):
            if not fake_sidecar.running:
                break
            await asyncio.sleep(0.02)
        assert not fake_sidecar.running
        assert (await fake_sidecar.ping())["ok"] is True
        assert fake_sidecar._proc.pid != first_pid
    finally:
        await _stop(fake_sidecar)


async def test_fatal_and_missing_ready(fake_sidecar, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_STT_MODE", "fatal")
    with pytest.raises(stt_service.SidecarError, match="fatal"):
        await fake_sidecar.ensure_started()
    assert not fake_sidecar.running

    monkeypatch.setenv("FAKE_STT_MODE", "silent")
    monkeypatch.setattr(stt_service, "READY_TIMEOUT_S", 0.5)
    with pytest.raises(stt_service.SidecarError):
        await fake_sidecar.ensure_started()
    assert not fake_sidecar.running


async def test_missing_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stt_service, "sidecar_path", lambda: None)
    with pytest.raises(stt_service.SidecarError, match="sidecar-missing"):
        await stt_service.SttSidecar().ensure_started()


async def test_idle_shutdown(fake_sidecar, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stt_service, "IDLE_SHUTDOWN_S", 0.3)
    try:
        await fake_sidecar.ping()
        proc = fake_sidecar._proc
        assert fake_sidecar.running
        await asyncio.sleep(0.2)
        await fake_sidecar.ping()  # activity pushes the deadline back
        await asyncio.sleep(0.2)
        assert fake_sidecar.running
        await asyncio.wait_for(proc.wait(), 3)
        assert proc.returncode == 0  # asked to shut down, not killed
        assert not fake_sidecar.running
    finally:
        await _stop(fake_sidecar)


def test_sidecar_lookup_order(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    binary = tmp_path / "navide-stt"
    binary.write_text("")
    monkeypatch.setenv("NAVIDE_STT_BIN", str(binary))
    assert stt_service.sidecar_path() == binary
    frozen_dir = tmp_path / "resources" / "bin"
    frozen_dir.mkdir(parents=True)
    packaged = frozen_dir / stt_service.osplat.paths.executable_candidates(stt_service._BIN_NAME)[0]
    packaged.write_text("")
    monkeypatch.setenv("NAVIDE_STT_BIN", str(tmp_path / "absent"))
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(frozen_dir / "agent_team_backend"))
    assert stt_service.sidecar_path() == packaged
    # A onedir backend runs from bin/agent_team_backend/; the sidecar is still in bin.
    (frozen_dir / "agent_team_backend" / "_internal").mkdir(parents=True)
    monkeypatch.setattr(sys, "executable", str(frozen_dir / "agent_team_backend" / "agent_team_backend"))
    assert stt_service.sidecar_path() == packaged


# ── Model download ─────────────────────────────────────────────────────────


class _Server:
    """Serves ``payload`` at /ok (with Range), 404 at /missing, and
    ``bad`` at /bad."""

    def __init__(self, payload: bytes, bad: bytes = b"") -> None:
        self.payload = payload
        self.ranges: list[str | None] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:  # noqa: D401
                pass

            def do_GET(self) -> None:  # noqa: N802
                outer.ranges.append(self.headers.get("Range"))
                if self.path == "/missing":
                    self.send_response(404)
                    self.end_headers()
                    return
                body = outer.payload if self.path == "/ok" else bad
                rng = self.headers.get("Range")
                if rng and self.path == "/ok":
                    start = int(rng.split("=")[1].split("-")[0])
                    if start >= len(body):
                        self.send_response(416)
                        self.end_headers()
                        return
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{len(body) - 1}/{len(body)}")
                    chunk = body[start:]
                else:
                    self.send_response(200)
                    chunk = body
                self.send_header("Content-Length", str(len(chunk)))
                self.end_headers()
                self.wfile.write(chunk)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def model_server(monkeypatch: pytest.MonkeyPatch):
    payload = bytes(range(256)) * 400
    server = _Server(payload, bad=b"x" * len(payload))
    monkeypatch.setattr(stt_service, "MODEL_SHA256", hashlib.sha256(payload).hexdigest())
    monkeypatch.setattr(stt_service, "MODEL_BYTES", len(payload))
    yield server
    server.close()


async def _collect(progress: list):
    async def on_progress(done: int, total: int) -> None:
        progress.append((done, total))

    return on_progress


async def test_download_falls_back_and_verifies(model_server, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stt_service, "MODEL_URLS", (f"{model_server.base}/missing", f"{model_server.base}/ok"))
    progress: list = []
    dest = await stt_service.download_model(await _collect(progress))
    assert dest == stt_service.model_path()
    assert dest.read_bytes() == model_server.payload
    assert not dest.with_name(dest.name + ".part").exists()
    assert progress[-1] == (len(model_server.payload), len(model_server.payload))
    assert stt_service.model_info()["present"] is True


async def test_download_resumes_part_with_range(model_server, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stt_service, "MODEL_URLS", (f"{model_server.base}/ok",))
    dest = stt_service.model_path()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.with_name(dest.name + ".part").write_bytes(model_server.payload[:1000])
    progress: list = []
    await stt_service.download_model(await _collect(progress))
    assert model_server.ranges == ["bytes=1000-"]
    assert dest.read_bytes() == model_server.payload


async def test_download_rejects_checksum_mismatch(model_server, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stt_service, "MODEL_URLS", (f"{model_server.base}/bad",))
    with pytest.raises(stt_service.ModelDownloadError, match="checksum mismatch"):
        await stt_service.download_model(await _collect([]))
    dest = stt_service.model_path()
    assert not dest.exists()
    assert not dest.with_name(dest.name + ".part").exists()
    assert stt_service.model_info()["present"] is False


def test_pinned_model_constants() -> None:
    assert stt_service.MODEL_SHA256 == "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"
    assert stt_service.MODEL_URLS[0].startswith("https://dl.navide.dev/")
    assert stt_service.model_path().relative_to(stt_service.app_data_dir()) == Path("models/whisper/ggml-base.bin")
