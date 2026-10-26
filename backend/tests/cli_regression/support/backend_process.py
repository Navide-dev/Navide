"""Fresh backend + authenticated wire client, shared by regression scenarios."""
from __future__ import annotations

import asyncio
import codecs
from collections import defaultdict
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import uuid

import psutil
import websockets

from agent_team_backend import pty_registry
from agent_team_backend.applog import in_data_dir

from .cli_shim import base_python_executable
from .isolation import isolated_environment


#: How long a shutting-down backend's owned children get to exit on their own
#: before the harness judges them survivors. The Windows winpty ConPTY host
#: (`OpenConsole.exe`) is outside the pane's kill-on-close Job Object, so winpty
#: is what releases it, and it was measured ~2.7s behind the backend on a loaded
#: runner: the shell's tree is long gone by then and only the host is left.
_REAP_WINDOW_S = 10.0

#: How long a fresh backend gets to start serving. Mirrors the app's own
#: health-check default (src/main/health-timeout.ts: 45s, 120s on Linux): a
#: backend the app would accept must not fail here. The former 30s was stricter
#: than the product, and four backends started side by side at load ~140 were
#: measured at 15-27s, so a loaded full run crossed it.
_STARTUP_TIMEOUT_S = 120.0 if sys.platform.startswith("linux") else 45.0


#: How long a backend that did not exit gets to write its stack dump (SIGUSR1)
#: before it is killed.
_STACK_DUMP_WAIT_S = 1.5


class BackendProcess:
    def __init__(self, root: Path):
        self.root = root
        self.env = isolated_environment(root)
        self.env["NAVIDE_REGRESSION_ROOT"] = str(root)
        self.env["NAVIDE_SHUTDOWN_DIAG"] = "1"
        self.env["PYTHONPATH"] = str(Path(__file__).resolve().parents[3])
        self.process = None
        self.url = ""
        self.events: list[dict] = []
        self.output: dict[str, str] = defaultdict(str)
        self.decoders = defaultdict(lambda: codecs.getincrementaldecoder("utf-8")())
        self.children: set[int] = set()
        self._owned_children: dict[int, psutil.Process] = {}
        self.log_path = root / "backend.log"

    async def __aenter__(self):
        self._log = self.log_path.open("w", encoding="utf-8")
        try:
            self.process = subprocess.Popen(
                [sys.executable, "-m", "tests.cli_regression.support.backend_entry",
                 "--port", "0", "--log-level", "warning"],
                env=self.env, cwd=Path(__file__).resolve().parents[3],
                stdin=subprocess.PIPE, stdout=self._log, stderr=subprocess.STDOUT, text=True,
            )
            self.process.stdin.write("\n")
            self.process.stdin.flush()
            async with asyncio.timeout(_STARTUP_TIMEOUT_S):
                while True:
                    if self.process.poll() is not None:
                        raise AssertionError(self.log_path.read_text(encoding="utf-8"))
                    candidate = self._discovery_url()
                    if candidate:
                        self.url = candidate
                        try:
                            async with self.connect():
                                break
                        except OSError:
                            pass
                    await asyncio.sleep(0.02)
        except BaseException:
            await self.__aexit__(*sys.exc_info())
            raise
        return self

    async def _dump_stacks(self) -> None:
        """Have a hung backend write every thread's stack into backend.log
        (NAVIDE_SHUTDOWN_DIAG), then give it a moment to finish writing."""
        if not hasattr(signal, "SIGUSR1"):
            return
        try:
            os.kill(self.process.pid, signal.SIGUSR1)
        except OSError:
            return
        await asyncio.sleep(_STACK_DUMP_WAIT_S)

    def _discovery_url(self) -> str | None:
        # File creation precedes write completion, so the port is validated
        # before use. The token is read only once that port is listening: the
        # backend mints it before it serves, so a listening port means the file
        # is final. Any earlier, the read can land inside the token's
        # os.replace, which Windows refuses with a sharing violation (EACCES).
        # The app reads it the same way, after /health answers.
        try:
            port = (self.root / "data" / "backend-port").read_text().strip()
        except FileNotFoundError:
            return None
        if not port.isdecimal() or not 1 <= int(port) <= 65535:
            return None
        try:
            with socket.create_connection(("127.0.0.1", int(port)), timeout=1):
                pass
        except OSError:
            return None
        try:
            token = (self.root / "data" / "backend-ws-token").read_text().strip()
        except FileNotFoundError:
            return None
        if not token:
            return None
        return f"ws://127.0.0.1:{port}/ws?t={token}"

    async def __aexit__(self, *_exc):
        exit_error = None
        if self.process and (code := self.process.poll()) is not None:
            exit_error = f"backend exited before requested shutdown (exit code {code}); see {self.log_path}"
        # Capture descendants while ownership can still be established. A
        # crashed backend reparents them, so walking only after exit misses
        # precisely the orphan failure this harness must clean up.
        if self.process and self.process.poll() is None:
            try:
                for child in psutil.Process(self.process.pid).children(recursive=True):
                    self.track_child(child.pid)
            except psutil.NoSuchProcess:
                pass
        survivors = []
        try:
            if self.process and exit_error is None:
                try:
                    self.process.stdin.write("shutdown\n")
                    self.process.stdin.flush()
                except BrokenPipeError:
                    exit_error = f"backend exited before shutdown request was delivered; see {self.log_path}"
                try:
                    code = await asyncio.to_thread(self.process.wait, timeout=15)
                    if code != 0:
                        exit_error = f"backend shutdown failed (exit code {code}); see {self.log_path}"
                except subprocess.TimeoutExpired:
                    await self._dump_stacks()
                    try:
                        process = psutil.Process(self.process.pid)
                        for child in process.children(recursive=True):
                            try:
                                child.kill()
                            except psutil.NoSuchProcess:
                                pass
                        process.kill()
                    except psutil.NoSuchProcess:
                        pass
                    await asyncio.to_thread(self.process.wait, timeout=5)
                    raise AssertionError(f"backend shutdown timed out; see {self.log_path}")
        finally:
            registry_reaped = []
            try:
                # The response may never have delivered the child PID to this
                # harness; reuse Navide's durable crash-recovery ownership.
                registry_reaped = await self._reap_registry_children()
            except Exception as err:  # noqa: BLE001
                detail = f"PTY registry cleanup failed: {err}"
                exit_error = f"{exit_error}; {detail}" if exit_error else detail
            survivors = await asyncio.to_thread(self._reap_surviving_children)
            self._log.close()
            if self.process and self.process.stdin:
                try:
                    self.process.stdin.close()
                except BrokenPipeError:
                    pass
            (self.root / "scenario.json").write_text(json.dumps({
                "events": self.events, "children": sorted(self.children), "survivors": survivors,
                "registry_reaped": registry_reaped,
                "backend_exit_code": self.process.returncode if self.process else None,
                "backend_exit_error": exit_error,
                "output": {key: value[-8192:] for key, value in self.output.items()},
            }, indent=2), encoding="utf-8")
            # Never archive the token or isolated credential files. Each
            # process gets its own directory even inside a parameterized test.
            process_id = self.process.pid if self.process else "not-started"
            destination = Path(__file__).resolve().parents[4] / "test-results" / "ci" / "cli-regression" / f"{self.root.parent.name}-{process_id}"
            destination.mkdir(parents=True, exist_ok=True)
            for name in ("backend.log", "scenario.json", "refusals.jsonl"):
                source = self.root / name
                if source.exists():
                    shutil.copyfile(source, destination / name)
            # The backend's own log file, timestamped where backend.log (its
            # stdout) is not. At this harness's warning level it holds the
            # warnings only, the loop watchdog's stall/recover lines among
            # them. One file by name: the data dir also holds the token.
            applog = self.root / "data" / "logs" / "backend.log"
            if applog.exists():
                shutil.copyfile(applog, destination / "backend-applog.log")
        assert exit_error is None, exit_error
        assert not registry_reaped, (
            f"PTY children survived backend shutdown (registry cleanup reaped them): "
            f"{registry_reaped}; {self.log_path}"
        )
        assert not survivors, f"PTY children survived backend shutdown (harness cleaned them): {survivors}; {self.log_path}"
        refusals = self.root / "refusals.jsonl"
        assert not refusals.exists(), f"external boundary reached: {refusals.read_text()}"

    async def _reap_registry_children(self) -> list[int]:
        """Apply Navide's crash-recovery registry to this isolated data dir."""
        return await asyncio.to_thread(
            in_data_dir(self.root / "data", pty_registry.reap_stale)
        )

    def connect(self):
        return websockets.connect(self.url, proxy=None, max_size=4 * 1024 * 1024)

    def fake_command(self) -> list[str]:
        return [base_python_executable(), "-u", str(Path(__file__).with_name("fake_cli.py"))]

    def track_child(self, pid: int) -> None:
        try:
            process = psutil.Process(pid)
            process.create_time()  # retain identity, never kill a reused PID
            descendants = process.children(recursive=True)
        except psutil.NoSuchProcess:
            return
        for child in [process, *descendants]:
            try:
                child.create_time()
                self.children.add(child.pid)
                previous = self._owned_children.get(child.pid)
                if previous is None or not previous.is_running():
                    self._owned_children[child.pid] = child
            except psutil.NoSuchProcess:
                pass

    @staticmethod
    def _describe_process(process: psutil.Process) -> dict:
        """Identify a survivor for the assertion message and scenario.json.

        Call this while the process is still running: after the kill it can be
        a zombie whose name()/cmdline() no longer resolve.
        """
        try:
            return {"pid": process.pid, "name": process.name(), "cmdline": process.cmdline()}
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            return {"pid": process.pid, "name": "", "cmdline": []}

    def _reap_surviving_children(self, window_s: float = _REAP_WINDOW_S) -> list[dict]:
        owned = list(self._owned_children.values())
        # A console host (ConPTY) can outlive the backend it served by a beat.
        # Wait for the whole owned set before judging any of it a survivor.
        _gone, survivors = psutil.wait_procs(owned, timeout=window_s)
        # Describe survivors before killing them, while name()/cmdline() resolve.
        descriptions = [self._describe_process(process) for process in survivors
                        if process.is_running()]
        for process in survivors:
            # psutil.is_running compares cached (pid, creation time). The
            # public kill method repeats that identity check before signalling.
            if not process.is_running():
                continue
            try:
                process.kill()
            except psutil.NoSuchProcess:
                pass
        psutil.wait_procs(survivors, timeout=5)
        # Report what the harness had to rescue, even when the rescue worked.
        return descriptions

    async def receive(self, ws) -> dict | None:
        frame = await ws.recv()
        if isinstance(frame, bytes):
            assert frame[0] == 1
            sid_len = frame[5]
            sid = frame[6:6 + sid_len].decode()
            pane_len = frame[6 + sid_len]
            data = frame[7 + sid_len + pane_len:]
            self.output[sid] += self.decoders[sid].decode(data)
            return None
        message = json.loads(frame)
        self.events.append(message)
        return message

    async def request(self, ws, kind: str, payload: dict, *, ok: bool = True) -> dict:
        request_id = str(uuid.uuid4())
        await ws.send(json.dumps({"id": request_id, "type": kind, "payload": payload}))
        async with asyncio.timeout(15):
            while True:
                response = await self.receive(ws)
                if response and response.get("id") == request_id:
                    if ok:
                        assert response.get("ok"), response
                    if kind == "terminal.create" and response.get("ok"):
                        self.track_child(response["payload"]["pid"])
                    return response

    async def expect_output(self, ws, terminal_id: str, text: str) -> str:
        async with asyncio.timeout(15):
            while text not in self.output[terminal_id]:
                await self.receive(ws)
        for pid in tuple(self.children):
            owned = self._owned_children.get(pid)
            if owned is not None and owned.is_running():
                self.track_child(pid)
        return self.output[terminal_id]

    async def create(self, ws, pane_id="regression-pane", **overrides) -> dict:
        payload = {"pane_id": pane_id, "agent_key": "terminal", "cwd": str(self.root),
                   "command": self.fake_command(), "cols": 100, "rows": 30,
                   "create_generation": str(uuid.uuid4()), **overrides}
        return (await self.request(ws, "terminal.create", payload))["payload"]
