"""The stdin shutdown line: the cooperative stop Electron uses on Windows,
where there is no SIGTERM to deliver."""

from __future__ import annotations

import io
import sys

import pytest

from agent_team_backend.__main__ import (
    SHUTDOWN_LINE,
    _read_confirm_key,
    _read_handover,
    _watch_stdin_for_shutdown,
)


class _Server:
    should_exit = False


class _Tty(io.StringIO):
    def isatty(self) -> bool:  # noqa: D401
        return True


def test_the_shutdown_line_sets_uvicorn_should_exit() -> None:
    server = _Server()
    _watch_stdin_for_shutdown(server, io.StringIO(f"noise\n  {SHUTDOWN_LINE}\n"))
    assert server.should_exit is True


def test_eof_without_the_line_is_not_a_shutdown() -> None:
    server = _Server()
    _watch_stdin_for_shutdown(server, io.StringIO("just-the-confirm-key\n"))
    assert server.should_exit is False


def test_a_tty_or_missing_stdin_is_never_read() -> None:
    server = _Server()
    _watch_stdin_for_shutdown(server, _Tty(f"{SHUTDOWN_LINE}\n"))
    assert server.should_exit is False


# ---- Windows: the pipe stays open after the handover line ------------------


def test_windows_the_handover_line_then_the_shutdown_line_still_stops() -> None:
    """Windows keeps the pipe open after the handover line: a later
    `shutdown` must still reach the watcher, and neither credential may be
    mistaken for it."""
    stream = io.StringIO(f"confirm-key host-token\n{SHUTDOWN_LINE}\n")
    assert _read_handover(stream) == ("confirm-key", "host-token")
    server = _Server()
    _watch_stdin_for_shutdown(server, stream)
    assert server.should_exit is True


def test_windows_the_handover_line_and_eof_is_not_a_shutdown() -> None:
    stream = io.StringIO("confirm-key host-token\n")
    _read_handover(stream)
    server = _Server()
    _watch_stdin_for_shutdown(server, stream)
    assert server.should_exit is False


# ---- one handover line: confirm key and host token -------------------------


def test_the_handover_line_carries_both_credentials() -> None:
    assert _read_handover(io.StringIO("confirm-key host-token\n")) == ("confirm-key", "host-token")


def test_a_handover_line_with_only_the_confirm_key_has_no_host_token() -> None:
    assert _read_handover(io.StringIO("confirm-key\n")) == ("confirm-key", "")
    assert _read_handover(io.StringIO("\n")) == ("", "")


def test_a_one_line_launcher_that_keeps_the_pipe_open_is_never_waited_on() -> None:
    """A launcher that writes one line and keeps stdin open for `shutdown`
    (Windows, the cli_regression harness) must not hang the backend: the
    handover is exactly one line."""
    import os
    import threading

    read_fd, write_fd = os.pipe()
    os.write(write_fd, b"confirm-key\n")
    stream = os.fdopen(read_fd, "r")
    result: list[tuple[str, str]] = []
    reader = threading.Thread(target=lambda: result.append(_read_handover(stream)), daemon=True)
    try:
        reader.start()
        reader.join(5)
        assert result == [("confirm-key", "")]
    finally:
        os.close(write_fd)
        reader.join(5)
        stream.close()


def test_main_reads_one_handover_line_not_two() -> None:
    from pathlib import Path

    import agent_team_backend.__main__ as entry

    source = Path(entry.__file__).read_text(encoding="utf-8")
    body = source[source.index("def main("):]
    assert "_read_handover()" in body


def test_a_spawned_backend_takes_the_handover_line_and_still_stops_on_shutdown(tmp_path) -> None:
    """End to end, as Electron main does it: one "<confirm key> <host token>"
    line, the pipe left open (Windows), host.register succeeds with that
    token and only that token, both credentials are adopted, and a later
    `shutdown` line still stops the process."""
    import json
    import subprocess
    import sys

    from websockets.sync.client import connect

    from tests.test_main_graceful_shutdown import _read_listen_port, _wait_healthy
    from tests.test_main_parent_watch import _isolated_backend_env

    env = _isolated_backend_env(tmp_path)
    backend = subprocess.Popen(
        [sys.executable, "-m", "agent_team_backend", "--port", "0", "--log-level", "info"],
        env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    try:
        assert backend.stdin is not None
        backend.stdin.write("ab" * 32 + " host-token-xyz\n")
        backend.stdin.flush()
        port = _read_listen_port(backend)
        _wait_healthy(port)
        token = (tmp_path / "backend-ws-token").read_text(encoding="utf-8").strip()

        def register(value: str) -> dict:
            with connect(f"ws://127.0.0.1:{port}/ws?t={token}") as ws:
                ws.send(json.dumps({"id": "r1", "type": "host.register", "payload": {"token": value}}))
                while True:
                    reply = json.loads(ws.recv(timeout=20))
                    if reply.get("id") == "r1":
                        return reply

        assert register("host-token-xyz").get("payload", {}).get("registered") is True
        assert register("wrong-token")["error"]["code"] == "UNAUTHORIZED"
        log_text = "".join(path.read_text(encoding="utf-8", errors="replace") for path in tmp_path.rglob("*.log"))
        assert "adopted the trust-confirmation key from the parent process" in log_text
        assert "adopted the host token from the parent process" in log_text
        # Windows: the real backend did take its children off the shutdown pipe.
        if sys.platform == "win32":
            assert "children no longer inherit stdin" in log_text

        backend.stdin.write(f"{SHUTDOWN_LINE}\n")
        backend.stdin.flush()
        assert backend.wait(timeout=20) == 0
    finally:
        if backend.poll() is None:
            backend.kill()
            backend.wait(timeout=10)



# ---- children never inherit the shutdown pipe ------------------------------
# Windows 0.2.27/0.2.28: every git.exe and node.exe the backend started hung at
# launch (main thread in Wait:Executive), because each inherited the stdin
# pipe that the watcher above sits in a synchronous read on.


def test_main_isolates_stdin_after_the_handover_and_before_the_watcher() -> None:
    from pathlib import Path

    import agent_team_backend.__main__ as entry

    source = Path(entry.__file__).read_text(encoding="utf-8")
    body = source[source.index("def main("):]
    handover = body.index("_read_handover()")
    isolate = body.index("osplat.process_tree.isolate_stdin_from_children()")
    watcher = body.index("target=_watch_stdin_for_shutdown")
    assert handover < isolate < watcher


def test_posix_has_nothing_to_isolate() -> None:
    from agent_team_backend.osplat import _posix

    assert _posix.PosixProcessTree().isolate_stdin_from_children() is False


def _run_a_child_while_stdin_is_a_pipe_being_read(isolate: bool):
    """Make this process's stdin handle a pipe with a thread parked in a
    synchronous read on it (the backend's state on Windows), optionally
    isolate, start a child that never reads stdin, then put everything back."""
    import os
    import subprocess
    import sys
    import threading
    import time

    import msvcrt

    from agent_team_backend.osplat import _windows

    k = _windows._kernel32()
    original = k.GetStdHandle(_windows.STD_INPUT_HANDLE)
    read_fd, write_fd = os.pipe()

    reader = threading.Thread(target=os.read, args=(read_fd, 1), daemon=True)
    try:
        assert k.SetStdHandle(_windows.STD_INPUT_HANDLE, msvcrt.get_osfhandle(read_fd))
        reader.start()
        # Let the read be pending before the child starts: on a loaded runner
        # the thread may not have reached ReadFile yet, and a child started
        # first would not hang, which would read as "mechanism is wrong".
        time.sleep(0.2)
        if isolate:
            assert _windows.process_tree.isolate_stdin_from_children() is True
        try:
            return subprocess.run(
                [sys.executable, "-c", "pass"], capture_output=True, timeout=10
            ).returncode
        except subprocess.TimeoutExpired:
            return "hung"
    finally:
        k.SetStdHandle(_windows.STD_INPUT_HANDLE, original)
        os.write(write_fd, b"x")
        reader.join(5)
        os.close(write_fd)
        os.close(read_fd)


@pytest.mark.skipif(sys.platform != "win32", reason="the synchronous-pipe lock is Windows behaviour")
def test_windows_a_child_inheriting_the_read_pipe_hangs_at_launch() -> None:
    """The root cause itself, pinned so a Windows that stops behaving this
    way is noticed: with nothing isolated, a child that never touches stdin
    still does not get past its start."""
    assert _run_a_child_while_stdin_is_a_pipe_being_read(isolate=False) == "hung"


@pytest.mark.skipif(sys.platform != "win32", reason="the synchronous-pipe lock is Windows behaviour")
def test_windows_after_isolation_the_same_child_starts_and_exits() -> None:
    assert _run_a_child_while_stdin_is_a_pipe_being_read(isolate=True) == 0
