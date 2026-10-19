"""POSIX process-tree and terminal implementations, shared by Darwin and Linux.

Everything here is the code `terminals.py` and `pty_registry.py` ran before
the seam existed, moved rather than rewritten: `pty.openpty` + a non-blocking
master, `setsid` + TIOCSCTTY for the child, `ps` snapshots keyed by start
time for identity, and `killpg` for the group. macOS is the shipped platform,
so the acceptance test for this file is that its behaviour did not change.
"""

from __future__ import annotations

import asyncio
import os
import shlex
import signal
import struct
import subprocess
from collections.abc import Mapping
from typing import Callable

# Guarded so the module imports on Windows: the ratchet test and the Windows
# suite import it for its classes, and only a call into them needs the
# terminal modules — which no Windows caller ever makes.
try:
    import fcntl
    import pty
    import termios
except ImportError:  # pragma: no cover - Windows
    fcntl = pty = termios = None  # type: ignore[assignment]

from .proctree import children_map, walk_descendants
from .spec import ChildProcess, ProcInfo

# Force a fixed locale so the lstart string captured at register time compares
# equal to the one read back at reap time.
_PS_ENV = {**os.environ, "LC_ALL": "C"}


# ---------------------------------------------------------------------------
# Process tree
# ---------------------------------------------------------------------------


def _ps(pid: int, fields: str) -> str | None:
    """One-line ps probe; None means the probe itself failed (not "no such
    process" — that returns an empty string)."""
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", fields],
            capture_output=True,
            text=True,
            timeout=5,
            env=_PS_ENV,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.strip()


def _ps_snapshot() -> dict[int, ProcInfo]:
    """pid -> (ppid, pgid, lstart) for every process, from one ps snapshot.
    lstart (process start time) is the identity that defeats pid recycling;
    pgid distinguishes detached descendants (own group) from same-group
    children. The fixed locale (_PS_ENV) keeps the lstart string comparable
    to one captured by a previous backend run. Empty on failure."""
    try:
        out = subprocess.run(
            ["ps", "-Ao", "pid=,ppid=,pgid=,lstart="],
            capture_output=True,
            text=True,
            timeout=5,
            env=_PS_ENV,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}
    snap: dict[int, ProcInfo] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            pid, ppid, pgid = int(parts[0]), int(parts[1]), int(parts[2])
        except ValueError:
            continue
        snap[pid] = ProcInfo(ppid, pgid, " ".join(parts[3:]))
    return snap


def _signal_for(force: bool) -> int:
    return signal.SIGKILL if force else signal.SIGTERM


class PosixProcessTree:
    """`ps` for enumeration and identity, `kill`/`killpg` for signalling."""

    def snapshot(self) -> dict[int, ProcInfo]:
        return _ps_snapshot()

    def descendants(self, pid: int) -> list[int]:
        """Every PID descended from pid (child, grandchild, ...) from one ps
        snapshot. killpg on the PTY child's process group misses any grandchild
        that called setsid to start its own session/group (some CLIs do) —
        those outlive the group kill and become orphans. Snapshot the tree
        while root is still alive; once it dies the grandchildren reparent to
        launchd (ppid 1) and the ancestry is gone."""
        return walk_descendants(children_map(_ps_snapshot()), pid)

    def group_of(self, pid: int) -> int:
        return os.getpgid(pid)

    def start_time(self, pid: int) -> str:
        return _ps(pid, "lstart=") or ""

    def identity(self, pid: int) -> str:
        start = self.start_time(pid)
        return f"{pid}:{start}" if start else ""

    def command_of(self, pid: int) -> str | None:
        return _ps(pid, "command=")

    def is_alive(self, pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def is_orphan_parent(self, ppid: int, me: int) -> bool:
        # Reparented to init/launchd, or to this backend (observed on macOS).
        return ppid in (1, me)

    def parent_to_follow(self, env: Mapping[str, str]) -> int | None:
        # Not os.getppid(): the frozen backend's parent is PyInstaller's
        # bootloader and the dev backend's is `uv run`, neither of which is the
        # app. The app says which pid it is.
        raw = env.get("AGENT_TEAM_PARENT_PID", "")
        try:
            pid = int(raw)
        except ValueError:
            return None
        return pid if pid > 0 else None

    def kill(self, pid: int, *, force: bool) -> None:
        os.kill(pid, _signal_for(force))

    def kill_group(self, gid: int, *, force: bool) -> None:
        os.killpg(gid, _signal_for(force))

    def contain(self, pid: int) -> None:
        # Started with start_new_session: its session is the tree.
        return None

    def end_contained(self, pid: int, job: int | None = None) -> None:
        try:
            os.killpg(pid, _signal_for(True))
        except (ProcessLookupError, PermissionError):
            pass

    def stderr_handle_info(self) -> str:
        return ""

    def kill_tree(self, pid: int, *, force: bool) -> None:
        """Group kill plus each descendant individually: the descendants are
        snapshotted first because a dead root's grandchildren reparent and
        can no longer be found."""
        descendants = self.descendants(pid)
        sig = _signal_for(force)
        try:
            os.killpg(os.getpgid(pid), sig)
        except (ProcessLookupError, PermissionError):
            pass
        for child in descendants:
            try:
                os.kill(child, sig)
            except (ProcessLookupError, PermissionError):
                pass


# ---------------------------------------------------------------------------
# Terminal
# ---------------------------------------------------------------------------


def _claim_ctty() -> None:
    """Give the child a controlling terminal. Runs between fork() and exec().

    start_new_session=True only calls setsid(): the child leads a new session
    with NO controlling terminal, and dup2'ing the slave onto fd 0/1/2 does not
    claim one. Without a ctty the kernel never gives the tty a foreground
    process group, so it delivers neither SIGINT (^C) nor SIGWINCH (resize),
    job control stays off, and /dev/tty is ENXIO — which is why sudo in a pane
    refused with "a terminal is required to read the password" while `tty` and
    `[ -t 0 ]` both looked healthy (those only check isatty()).

    setsid() has already run by this point, so we are a session leader and the
    ioctl is legal. Keep this minimal: only async-signal-safe work is valid
    after fork(), so no logging and no allocation beyond the call itself.

    It also resets the signals the tty line discipline raises (^C, ^\\, ^Z) to
    SIG_DFL. An ignored disposition survives exec, so a backend that was itself
    started as a background job or under nohup would otherwise hand every pane
    child SIGINT=SIG_IGN, and ^C would silently do nothing to a `sleep`, a `cat`
    or an interpreter (which then skips installing its own handler).
    """
    for sig in (signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP):
        try:
            signal.signal(sig, signal.SIG_DFL)
        except (OSError, ValueError):
            pass
    try:
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    except OSError:
        # Degrade to the historical no-ctty behaviour rather than fail the
        # spawn: an exception here propagates through Popen's errpipe and
        # would make every pane unopenable. A pane without sudo and job
        # control still beats no pane at all.
        pass


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


class PosixTerminalHandle:
    """A PTY master fd plus the child on its slave.

    `proc` may be None for a handle built around a bare fd (tests drive the
    read/write paths through pipes); everything except `pid` works without it.
    """

    def __init__(self, fd: int, proc: ChildProcess | None = None) -> None:
        self.fd = fd
        self.proc = proc  # type: ignore[assignment]
        self._loop: asyncio.AbstractEventLoop | None = None
        self._on_readable: Callable[[], None] | None = None
        self._write_loop: asyncio.AbstractEventLoop | None = None

    @property
    def pid(self) -> int:
        return self.proc.pid if self.proc is not None else 0

    def read(self, max_bytes: int) -> bytes | None:
        return os.read(self.fd, max_bytes) or None

    def write(self, data: bytes) -> int:
        return os.write(self.fd, data)

    def resize(self, rows: int, cols: int) -> None:
        _set_winsize(self.fd, rows, cols)

    def foreground_group(self) -> int:
        """The process group the tty considers foreground, or 0.

        With a ctty in play the PTY child is an interactive login shell whose
        job control is live, so it puts the CLI in a process group of its OWN
        and makes that group foreground. Signalling only the shell's group
        would then leave the CLI untouched — it would die later by SIGHUP when
        the master closes, with no chance to flush its transcript, which is
        exactly what resume depends on. Ask the tty who is actually in front.
        """
        try:
            fg = os.tcgetpgrp(self.fd)
        except OSError:
            return 0
        return fg if fg > 0 else 0

    def start_reading(
        self, loop: asyncio.AbstractEventLoop, callback: Callable[[], None]
    ) -> None:
        self._loop = loop
        self._on_readable = callback
        loop.add_reader(self.fd, callback)

    def pause_reading(self) -> None:
        if self._loop is None:
            return
        try:
            self._loop.remove_reader(self.fd)
        except (ValueError, KeyError):
            pass

    def resume_reading(self) -> None:
        if self._loop is None or self._on_readable is None:
            return
        self._loop.add_reader(self.fd, self._on_readable)

    def stop_reading(self) -> None:
        self.pause_reading()
        self._on_readable = None

    def watch_writable(
        self, loop: asyncio.AbstractEventLoop, callback: Callable[[], None]
    ) -> None:
        self._write_loop = loop
        loop.add_writer(self.fd, callback)

    def unwatch_writable(self) -> None:
        if self._write_loop is None:
            return
        try:
            self._write_loop.remove_writer(self.fd)
        except (ValueError, KeyError, OSError):
            pass

    def close(self) -> None:
        try:
            os.close(self.fd)
        except OSError:
            pass


class PosixTerminalBackend:
    """`pty.openpty` + `Popen(start_new_session=True, preexec_fn=_claim_ctty)`."""

    helper_waits_for_child: bool = False
    reports_foreground: bool = True

    def parse_command(self, command: str) -> list[str]:
        return shlex.split(command)

    def self_check_conpty(self) -> tuple[bool, str]:
        # The pty comes from the kernel via `pty.openpty`; there is no bundled
        # console host to lose, so nothing to check.
        return True, "conpty self-check: skipped (POSIX pty needs no bundled host)"

    def spawn(
        self,
        argv: list[str] | str,
        *,
        cwd: str,
        env: dict[str, str],
        rows: int,
        cols: int,
    ) -> PosixTerminalHandle:
        if isinstance(argv, str):
            argv = self.parse_command(argv)
        master, slave = pty.openpty()
        _set_winsize(master, rows, cols)
        flags = fcntl.fcntl(master, fcntl.F_GETFL)
        fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        try:
            proc = subprocess.Popen(
                argv,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                cwd=cwd,
                env=env,
                close_fds=True,
                start_new_session=True,
                # setsid() alone leaves the child without a controlling
                # terminal; claim the slave so the kernel will deliver ^C,
                # SIGWINCH and hangups, and so /dev/tty resolves. See
                # _claim_ctty.
                preexec_fn=_claim_ctty,
            )
        except Exception:
            os.close(master)
            os.close(slave)
            raise
        try:
            os.close(slave)
        except BaseException:
            # The child is running but its master is about to be unreachable:
            # take the whole group down before surfacing the failure.
            try:
                os.close(master)
            except OSError:
                pass
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                proc.wait(timeout=1.0)
            except (subprocess.TimeoutExpired, OSError):
                pass
            raise
        return PosixTerminalHandle(master, proc)


process_tree = PosixProcessTree()
terminal_backend = PosixTerminalBackend()
