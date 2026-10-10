"""The stdin shutdown line: the cooperative stop Electron uses on Windows,
where there is no SIGTERM to deliver."""

from __future__ import annotations

import io

from agent_team_backend.__main__ import (
    SHUTDOWN_LINE,
    _read_confirm_key,
    _read_host_token,
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


# ---- the two lines main hands over before anything else ---------------------


def test_the_host_token_is_the_second_line() -> None:
    """R3-M2: the host token used to travel in the spawn environment, where a
    same-uid process reads it with `ps -E` even after os.environ.pop. It now
    follows the confirm key on stdin."""
    stream = io.StringIO("confirm-key\nhost-token\n")
    assert _read_confirm_key(stream) == "confirm-key"
    assert _read_host_token(stream) == "host-token"


def test_one_line_means_no_host_token() -> None:
    """A backend started with only the confirm key (an older main, a test)
    has no host token, so host.register refuses and every session is a
    ws-client."""
    stream = io.StringIO("confirm-key\n")
    assert _read_confirm_key(stream) == "confirm-key"
    assert _read_host_token(stream) == ""


def test_a_tty_stdin_has_no_host_token() -> None:
    assert _read_host_token(_Tty("host-token\n")) == ""


def test_windows_two_lines_then_the_shutdown_line_still_stops() -> None:
    """Windows keeps the pipe open after both lines: a later `shutdown` must
    still reach the watcher, and neither credential may be mistaken for it."""
    stream = io.StringIO(f"confirm-key\nhost-token\n{SHUTDOWN_LINE}\n")
    assert _read_confirm_key(stream) == "confirm-key"
    assert _read_host_token(stream) == "host-token"
    server = _Server()
    _watch_stdin_for_shutdown(server, stream)
    assert server.should_exit is True


def test_windows_two_lines_and_eof_is_not_a_shutdown() -> None:
    stream = io.StringIO("confirm-key\nhost-token\n")
    _read_confirm_key(stream)
    _read_host_token(stream)
    server = _Server()
    _watch_stdin_for_shutdown(server, stream)
    assert server.should_exit is False
