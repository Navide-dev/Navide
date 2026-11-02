"""A SIGTERMed backend exits in bounded time even with a request parked on it.

2026-10-08 17:25: the backend was told to shut down with ~150 Claude panes each
holding a rewake long-poll (`curl -m 1860`). uvicorn closed the listener and
then waited, without a deadline, for every one of those requests to finish, so
the process stayed alive with no port: the app never saw an exit, never
respawned it, and every window sat on "connecting…" against the dead port.
"""

from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest

from agent_team_backend import osplat

from tests.test_main_parent_watch import _isolated_backend_env

#: The bound the backend gives in-flight requests (__main__'s uvicorn config),
#: plus room for the lifespan teardown that runs after it.
_EXIT_DEADLINE_S = 3.0 + 7.0
_LISTEN_DEADLINE_S = 40.0


def _read_listen_port(proc: subprocess.Popen) -> int:
    assert proc.stdout is not None
    stdout = proc.stdout
    lines: queue.SimpleQueue[str] = queue.SimpleQueue()

    def pump() -> None:
        # Stops at the listen line: the caller may go on reading stdout. On a
        # backend that never gets there it ends when the test kills the process.
        while True:
            line = stdout.readline()
            lines.put(line)
            if not line or line.startswith("AGENT_TEAM_BACKEND_LISTEN "):
                return

    # readline blocks, so a deadline read between lines cannot fire on a backend
    # that stops printing: on a Windows gate that is the whole job's timeout.
    threading.Thread(target=pump, daemon=True).start()
    seen: list[str] = []
    deadline = time.monotonic() + _LISTEN_DEADLINE_S
    while True:
        try:
            line = lines.get(timeout=max(0.0, deadline - time.monotonic()))
        except queue.Empty:
            raise AssertionError(_never_listened(seen)) from None
        if not line:
            raise AssertionError(f"the backend exited before listening (code {proc.poll()})")
        if line.startswith("AGENT_TEAM_BACKEND_LISTEN "):
            return int(line.rsplit("port=", 1)[1])
        seen.append(line.strip())


def _never_listened(seen: list[str]) -> str:
    """Where startup stopped: the app log says, once the process got that far."""
    log_lines = [line for line in seen if line.startswith("AGENT_TEAM_BACKEND_LOG path=")]
    if not log_lines:
        return f"the backend never printed its listen line; stdout so far: {seen}"
    log_path = Path(log_lines[-1].split("path=", 1)[1])
    tail = log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-15:]
    return "the backend never printed its listen line; its log ends:\n" + "\n".join(tail)


def test_a_process_that_prints_nothing_fails_the_wait_instead_of_hanging_it(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(sys.modules[__name__], "_LISTEN_DEADLINE_S", 0.2)
    log = tmp_path / "backend.log"
    log.write_text("starting\nstopped here\n", encoding="utf-8")
    silent = subprocess.Popen(
        [sys.executable, "-c", "import sys, time; print('AGENT_TEAM_BACKEND_LOG path=' + sys.argv[1], flush=True); time.sleep(60)", str(log)],
        stdout=subprocess.PIPE, text=True,
    )
    try:
        with pytest.raises(AssertionError, match="stopped here"):
            _read_listen_port(silent)
    finally:
        silent.kill()
        silent.wait(timeout=10)
        assert silent.stdout is not None
        silent.stdout.close()


def _wait_healthy(port: int) -> None:
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as res:
                if res.status == 200:
                    return
        except OSError:
            pass
        time.sleep(0.25)
    raise AssertionError("the backend never became healthy")


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM is the POSIX stop path")
def test_a_parked_rewake_hook_does_not_hold_a_sigtermed_backend_open(tmp_path) -> None:
    env = _isolated_backend_env(tmp_path)
    backend = subprocess.Popen(
        [sys.executable, "-m", "agent_team_backend", "--port", "0", "--log-level", "warning"],
        env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True,
    )
    hook = None
    try:
        port = _read_listen_port(backend)
        _wait_healthy(port)

        # The real hook command the installer writes, against this backend. An
        # unknown session parks in the attribution wait for 30s — the same
        # in-flight request a long-poll is, without needing a live pane.
        script = osplat.scripts.hook_rewake(
            port_file=str(tmp_path / "backend-port"),
            header_file=str(tmp_path / "hook-auth"),
            url_path="/hooks/claude/rewake",
            timeout_s=60,
        )
        hook = subprocess.Popen(
            osplat.paths.shell_command(script), env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        assert hook.stdin is not None
        hook.stdin.write(json.dumps({"session_id": "no-such-session"}))
        hook.stdin.close()
        time.sleep(1.5)
        assert hook.poll() is None, "the hook was answered instead of parked"

        started = time.monotonic()
        os.kill(backend.pid, signal.SIGTERM)
        try:
            backend.wait(timeout=_EXIT_DEADLINE_S)
        except subprocess.TimeoutExpired:
            raise AssertionError(
                f"the backend was still running {_EXIT_DEADLINE_S}s after SIGTERM "
                "with a request parked on it"
            ) from None
        assert time.monotonic() - started < _EXIT_DEADLINE_S

        # The hook on the other end of the dropped connection: "nothing to
        # report" (exit 0, no envelope), promptly — never exit 2, which would
        # wake the agent with whatever curl printed.
        hook.wait(timeout=10)
        assert hook.returncode == 0
        assert hook.stdout is not None and hook.stdout.read() == ""
    finally:
        # Only the processes this test started, by the pid it recorded.
        for proc in (hook, backend):
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
