"""TerminalService.shell_in_foreground: is a plain terminal's shell at its
prompt, or is a program it started in front of the tty?"""

from __future__ import annotations

import os
import sys
import time
import types

import pytest

from agent_team_backend import osplat, terminals
from agent_team_backend.terminals import TerminalService


def _manager_with(session) -> TerminalService:
    mgr = TerminalService.__new__(TerminalService)
    mgr._sessions = {"s1": session}
    return mgr


def _session(fg: int, pid: int = 4242, closed: bool = False):
    return types.SimpleNamespace(
        closed=closed,
        proc=types.SimpleNamespace(pid=pid),
        handle=types.SimpleNamespace(foreground_group=lambda: fg),
    )


@pytest.mark.skipif(os.name == "nt", reason="Windows cannot tell; answers None")
def test_shell_group_in_front_is_at_prompt(monkeypatch):
    monkeypatch.setattr(osplat.process_tree, "group_of", lambda pid: pid)
    assert _manager_with(_session(fg=4242)).shell_in_foreground("s1") is True


@pytest.mark.skipif(os.name == "nt", reason="Windows cannot tell; answers None")
def test_another_group_in_front_is_busy(monkeypatch):
    monkeypatch.setattr(osplat.process_tree, "group_of", lambda pid: pid)
    monkeypatch.setattr(osplat.terminal_backend, "helper", None, raising=False)
    assert _manager_with(_session(fg=5555)).shell_in_foreground("s1") is False


def test_unknown_when_it_cannot_be_told(monkeypatch):
    monkeypatch.setattr(osplat.process_tree, "group_of", lambda pid: pid)
    assert _manager_with(_session(fg=0)).shell_in_foreground("s1") is None
    assert _manager_with(_session(fg=4242, closed=True)).shell_in_foreground("s1") is None
    assert _manager_with(_session(fg=4242)).shell_in_foreground("nope") is None


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX job control")
def test_real_pty_foreground_child_reads_busy(monkeypatch):
    """A real interactive shell on a PTY: at its prompt it is in front; while
    it runs `sleep` in the foreground, sleep's group is."""
    monkeypatch.setattr(osplat.terminal_backend, "helper", None, raising=False)
    import pty
    import signal

    pid, master = pty.fork()
    if pid == 0:  # child: an interactive shell with job control on its own tty
        os.execv("/bin/sh", ["/bin/sh", "-i"])
    try:
        proc = types.SimpleNamespace(pid=pid)
        handle = types.SimpleNamespace(foreground_group=lambda: os.tcgetpgrp(master))
        mgr = _manager_with(types.SimpleNamespace(closed=False, proc=proc, handle=handle))

        def settle(want):
            deadline = time.time() + 5
            while time.time() < deadline:
                try:
                    os.read(master, 4096)  # keep the PTY drained
                except (BlockingIOError, OSError):
                    pass
                if mgr.shell_in_foreground("s1") is want:
                    return True
                time.sleep(0.05)
            return False

        os.set_blocking(master, False)
        assert settle(True)
        os.write(master, b"sleep 3\n")
        assert settle(False)
    finally:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        os.close(master)


def test_unknown_where_the_platform_cannot_see_the_foreground(monkeypatch):
    """Windows: the handle reports the child as the foreground whatever runs,
    so the answer is "cannot tell", never a false "at prompt"."""
    monkeypatch.setattr(osplat.process_tree, "group_of", lambda pid: pid)
    monkeypatch.setattr(osplat.terminal_backend, "reports_foreground", False)
    assert _manager_with(_session(fg=4242)).shell_in_foreground("s1") is None


def test_only_the_windows_backend_cannot_see_the_foreground():
    from agent_team_backend.osplat import _posix, _windows

    assert _posix.PosixTerminalBackend.reports_foreground is True
    assert _windows.WindowsTerminalBackend.reports_foreground is False


# 0.2.43 macOS dmg: every pane runs under the pane helper, so the PTY child is
# the helper and the shell is its child — an interactive zsh then takes a
# process group of its own. Read against the helper's group, an idle terminal
# was busy for good and cli_send to it failed after 120 s (reason=raw).
@pytest.mark.skipif(os.name == "nt", reason="Windows cannot tell; answers None")
def test_the_helpers_shell_in_front_is_at_prompt(monkeypatch):
    monkeypatch.setattr(osplat.process_tree, "group_of", lambda pid: pid)
    monkeypatch.setattr(osplat.terminal_backend, "helper", "/x/navide-pane", raising=False)
    monkeypatch.setattr(terminals, "_parent_pid", {937: 934}.__getitem__)
    assert _manager_with(_session(fg=937, pid=934)).shell_in_foreground("s1") is True


@pytest.mark.skipif(os.name == "nt", reason="Windows cannot tell; answers None")
def test_a_program_the_helpers_shell_runs_is_busy(monkeypatch):
    monkeypatch.setattr(osplat.process_tree, "group_of", lambda pid: pid)
    monkeypatch.setattr(osplat.terminal_backend, "helper", "/x/navide-pane", raising=False)
    monkeypatch.setattr(terminals, "_parent_pid", {990: 937}.__getitem__)
    assert _manager_with(_session(fg=990, pid=934)).shell_in_foreground("s1") is False


@pytest.mark.skipif(os.name == "nt", reason="Windows cannot tell; answers None")
def test_a_vanished_group_leader_is_busy_and_an_unreadable_one_unknown(monkeypatch):
    import psutil

    monkeypatch.setattr(osplat.process_tree, "group_of", lambda pid: pid)
    monkeypatch.setattr(osplat.terminal_backend, "helper", "/x/navide-pane", raising=False)

    def gone(pid):
        raise psutil.NoSuchProcess(pid)

    def denied(pid):
        raise psutil.AccessDenied(pid)

    monkeypatch.setattr(terminals, "_parent_pid", gone)
    assert _manager_with(_session(fg=990, pid=934)).shell_in_foreground("s1") is False
    monkeypatch.setattr(terminals, "_parent_pid", denied)
    assert _manager_with(_session(fg=990, pid=934)).shell_in_foreground("s1") is None


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX job control")
def test_real_helper_tree_reads_at_prompt_at_once_and_holds_a_password_prompt(monkeypatch):
    """The 0.2.46 report, on a real PTY: a helper-shaped PTY child whose one
    child is an interactive shell. A brand-new pane at its prompt must read at
    prompt from the first look — not "busy" until a background snapshot names
    the shell — and a program reading a password from the tty must read busy,
    so nothing queued is typed into it."""
    import pty
    import signal

    monkeypatch.setattr(osplat.terminal_backend, "helper", "/x/navide-pane", raising=False)
    pid, master = pty.fork()
    if pid == 0:  # the "helper": stays the parent of an interactive shell
        os.execv("/bin/sh", ["/bin/sh", "-c", "/bin/sh -i; :"])
    try:
        proc = types.SimpleNamespace(pid=pid)
        handle = types.SimpleNamespace(foreground_group=lambda: os.tcgetpgrp(master))
        mgr = _manager_with(types.SimpleNamespace(closed=False, proc=proc, handle=handle))

        def settle(want):
            deadline = time.time() + 5
            while time.time() < deadline:
                try:
                    os.read(master, 4096)  # keep the PTY drained
                except (BlockingIOError, OSError):
                    pass
                if mgr.shell_in_foreground("s1") is want:
                    return True
                time.sleep(0.05)
            return False

        os.set_blocking(master, False)
        assert settle(True)
        # A password prompt: a program in front of the tty, echo off, reading.
        os.write(master, b"/bin/sh -c 'printf Password:; stty -echo; read p; stty echo'\n")
        assert settle(False)
        os.write(master, b"secret\n")
        assert settle(True)
    finally:
        try:  # the inner shell's own group, then the "helper"
            os.killpg(os.tcgetpgrp(master), signal.SIGKILL)
        except OSError:
            pass
        os.killpg(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        os.close(master)
