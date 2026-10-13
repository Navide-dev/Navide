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
import signal
import subprocess
import sys
import time
import urllib.request

import pytest

from agent_team_backend import osplat

from tests.test_main_parent_watch import _isolated_backend_env

#: The bound the backend gives in-flight requests (__main__'s uvicorn config),
#: plus room for the lifespan teardown that runs after it.
_EXIT_DEADLINE_S = 3.0 + 7.0


def _read_listen_port(proc: subprocess.Popen) -> int:
    assert proc.stdout is not None
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if not line:
            raise AssertionError(f"the backend exited before listening (code {proc.poll()})")
        if line.startswith("AGENT_TEAM_BACKEND_LISTEN "):
            return int(line.rsplit("port=", 1)[1])
    raise AssertionError("the backend never printed its listen line")


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
