"""Windows implementations of the platform seams.

Process enumeration and identity come from `psutil`; the terminal is a
ConPTY through `pywinpty` (3.x, the `winpty.PTY` class); and every terminal
child is placed in a Job Object created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
The job is what gives Windows the property POSIX gets from process groups plus
the descendant snapshot: `kill_tree` is one `TerminateJobObject`, and if the
backend dies without cleaning up, the kernel closes the job handle and takes
the whole tree with it — the crash-recovery reaper has nothing left to find.

What Windows cannot offer, stated once here rather than hidden in the calls:

* No graceful signal. `force=False` and `force=True` both terminate; a CLI
  never gets a shutdown notice to flush its transcript.
* No foreground process group. `foreground_group()` is the child's pid.
* No reparenting. A process whose parent died keeps the stale ppid, so a
  snapshot reports `ppid=0` for it (see `_stale_parent`) and that 0 is what
  `is_orphan_parent` matches for the EOF-path orphan sweep in `terminals`.
* No selectable fd. A worker thread pumps the ConPTY output pipe into a queue
  and wakes the event loop with `call_soon_threadsafe`; `read` serves the
  queue and raises `BlockingIOError` when it is empty.
* Writes to the ConPTY input pipe are synchronous (`WriteFile` on the loop
  thread) and always consume everything, so `watch_writable` only exists to
  satisfy the contract: it retries the drain after a short delay rather than
  spinning, and in practice is never reached.

`ctypes` calls into kernel32/shell32 are resolved lazily through
`_kernel32()`/`_shell32()` so this module imports on any platform (the
tests exercise it on macOS with those two functions stubbed).
"""

from __future__ import annotations

import asyncio
import codecs
import ctypes
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from collections import deque
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Callable

import psutil

from .proctree import children_map, walk_descendants
from .spec import ProcInfo, windows_refused_file_name, windows_short_name

log = logging.getLogger(__name__)


# A temp path for a hook's response body, ending the hook (exit 0) with one
# line on stderr when none can be made. A random name rather than
# GetTempFileName: that creates tmpXXXX.tmp and fails for good once 65535 are
# left behind by hooks killed mid-wait; curl creates this file itself.
_PS_TEMP_PATH = (
    "$TMP = $null; $TMPERR = ''; "
    "try { $TMP = Join-Path $env:TEMP ([IO.Path]::GetRandomFileName()) } catch { $TMPERR = \"$_\" }; "
    "if (-not $TMP) { [Console]::Error.Write('navide hook: no temp file: ' + $TMPERR + "
    "[Environment]::NewLine); exit 0 }; "
)


class WindowsPaths:
    """`%APPDATA%` / `%LOCALAPPDATA%`, falling back to their standard layout.

    The environment variables are normally set for any interactive session,
    but a service-started process may not have them, so the documented default
    path under the user profile is used rather than raising.
    """

    def app_support_dir(self, app_name: str, *, home: Path | None = None) -> Path:
        if home is not None:
            return home / "AppData" / "Roaming" / app_name
        configured = os.environ.get("APPDATA")
        base = Path(configured) if configured else Path.home() / "AppData" / "Roaming"
        return base / app_name

    def cache_dir(self, *, home: Path | None = None) -> Path:
        if home is not None:
            return home / "AppData" / "Local"
        configured = os.environ.get("LOCALAPPDATA")
        return Path(configured) if configured else Path.home() / "AppData" / "Local"


class WindowsResourceProbe:
    """Memory and CPU from psutil, one process handle per pid.

    `psutil` reads both out of the same `NtQueryInformationProcess` family of
    calls that Task Manager uses, so this is the cheap in-process path the
    other platforms get from `proc_pid_rusage` and `/proc` — there is no `ps`
    here to shell out to anyway.

    Memory is the private working set (`private`, what Task Manager calls
    "Commit size"), not `rss`: RSS on Windows is the working set, which
    charges every page of a shared DLL to each of the processes mapping it and
    so over-reports a fleet of same-binary CLIs exactly the way it does on
    POSIX. `private` is not interchangeable with `phys_footprint` or PSS — it
    excludes shared pages outright where those charge them once — which is why
    `memory_kind` names it for the panel to label.
    """

    def available(self) -> bool:
        return True

    def sample(self, pids: list[int]) -> dict[int, tuple[int, float]]:
        out: dict[int, tuple[int, float]] = {}
        for pid in pids:
            if pid <= 0:
                continue
            try:
                proc = psutil.Process(pid)
                memory = proc.memory_info()
                cpu = proc.cpu_times()
            except (psutil.Error, OSError):
                # Died mid-sweep, or belongs to another user. Same contract as
                # the Darwin and Linux probes: absent rather than zero, so the
                # caller can tell "not measured" from "measured as nothing".
                continue
            # `private` is Windows-only on the psutil namedtuple; a build that
            # does not carry it still answers with the working set.
            private = getattr(memory, "private", None)
            out[pid] = (
                int(private if private is not None else memory.rss),
                float(cpu.user) + float(cpu.system),
            )
        return out

    def memory_kind(self) -> str:
        return "private_bytes"

    def peak_rss_bytes(self) -> int | None:
        try:
            return int(psutil.Process().memory_info().peak_wset)
        except (psutil.Error, AttributeError, OSError):
            return None


# ---------------------------------------------------------------------------
# Win32 plumbing
# ---------------------------------------------------------------------------

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
CREATE_SUSPENDED = 0x00000004
JobObjectExtendedLimitInformation = 9
PROCESS_TERMINATE = 0x0001
PROCESS_SET_QUOTA = 0x0100
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SYNCHRONIZE = 0x00100000
STD_INPUT_HANDLE = 0xFFFFFFF6  # (DWORD)-10
STD_ERROR_HANDLE = 0xFFFFFFF4  # (DWORD)-12
WAIT_OBJECT_0 = 0x00000000
WAIT_TIMEOUT = 0x00000102
INFINITE = 0xFFFFFFFF
#: GetExitCodeProcess returns this while a process is still running.
STILL_ACTIVE = 259
#: Exit code handed to TerminateProcess/TerminateJobObject.
_TERMINATE_EXIT_CODE = 1


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", _IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


_k32: Any = None
#: The NUL descriptor `isolate_stdin_from_children` made the stdin handle.
_stdin_nul_fd: int | None = None
_sh32: Any = None


def _kernel32() -> Any:
    """kernel32 with the prototypes this module uses, resolved once."""
    global _k32
    if _k32 is None:
        from ctypes import wintypes

        k = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k.CreateJobObjectW.restype = wintypes.HANDLE
        k.SetInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ]
        k.SetInformationJobObject.restype = wintypes.BOOL
        k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k.AssignProcessToJobObject.restype = wintypes.BOOL
        k.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        k.TerminateJobObject.restype = wintypes.BOOL
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.OpenProcess.restype = wintypes.HANDLE
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.CloseHandle.restype = wintypes.BOOL
        k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k.WaitForSingleObject.restype = wintypes.DWORD
        k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k.GetExitCodeProcess.restype = wintypes.BOOL
        k.LocalFree.argtypes = [ctypes.c_void_p]
        k.LocalFree.restype = ctypes.c_void_p
        k.GetStdHandle.argtypes = [wintypes.DWORD]
        k.GetStdHandle.restype = wintypes.HANDLE
        k.GetHandleInformation.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k.GetHandleInformation.restype = wintypes.BOOL
        k.SetStdHandle.argtypes = [wintypes.DWORD, wintypes.HANDLE]
        k.SetStdHandle.restype = wintypes.BOOL
        _k32 = k
    return _k32


def _shell32() -> Any:
    global _sh32
    if _sh32 is None:
        from ctypes import wintypes

        s = ctypes.WinDLL("shell32", use_last_error=True)  # type: ignore[attr-defined]
        s.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
        s.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
        _sh32 = s
    return _sh32


def _win_error() -> OSError:
    return ctypes.WinError(ctypes.get_last_error())  # type: ignore[attr-defined]


def _split_command_line(command: str) -> list[str]:
    """`CommandLineToArgvW`: the OS's own parsing, so what we split is what
    the child would have seen had the string been handed to CreateProcess."""
    if not command.strip():
        return []
    k = _kernel32()
    argc = ctypes.c_int(0)
    argv = _shell32().CommandLineToArgvW(command, ctypes.byref(argc))
    if not argv:
        raise _win_error()
    try:
        return [argv[i] for i in range(argc.value)]
    finally:
        k.LocalFree(argv)


def _create_kill_on_close_job() -> int:
    """A job whose every process dies when its last handle closes."""
    k = _kernel32()
    job = k.CreateJobObjectW(None, None)
    if not job:
        raise _win_error()
    info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not k.SetInformationJobObject(
        job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)
    ):
        err = _win_error()
        k.CloseHandle(job)
        raise err
    return int(job)


def _assign_to_job(job: int, pid: int) -> None:
    k = _kernel32()
    handle = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
    if not handle:
        raise _win_error()
    try:
        if not k.AssignProcessToJobObject(job, handle):
            raise _win_error()
    finally:
        k.CloseHandle(handle)


#: Root pid -> (job handle, start-time identity) for every live terminal.
#: `kill_tree` on a root pid terminates the job instead of walking the table,
#: which also reaches grandchildren that were spawned after the last snapshot.
#: The identity is what keeps a recycled pid from reaching another pane's
#: job: a root that exited stays in the table until its handle is closed,
#: and a new pane can be spawned onto the same pid in that window.
_jobs: dict[int, tuple[int, str]] = {}
_jobs_lock = threading.Lock()


def _register_job(pid: int, job: int) -> None:
    start = process_tree.start_time(pid)
    with _jobs_lock:
        _jobs[pid] = (job, start)


def _release_job(pid: int, job: int) -> None:
    """Close the job handle — with KILL_ON_JOB_CLOSE that ends the tree.

    Only the handle's own job is closed and only its own entry is dropped: a
    pane spawned onto this pid after the first one exited owns the table
    entry by then, and its job must survive the first pane's close.
    """
    with _jobs_lock:
        entry = _jobs.get(pid)
        if entry is not None and entry[0] == job:
            del _jobs[pid]
    _kernel32().CloseHandle(job)


def _terminate_job(pid: int) -> bool:
    with _jobs_lock:
        entry = _jobs.get(pid)
    if entry is None:
        return False
    job, start = entry
    # A pid whose identity no longer matches (or never could be read) is not
    # the process this job was made for: leave the job alone and let the
    # caller walk the table for whatever runs under that pid now.
    if not start or process_tree.start_time(pid) != start:
        return False
    return bool(_kernel32().TerminateJobObject(job, _TERMINATE_EXIT_CODE))


# ---------------------------------------------------------------------------
# Process tree
# ---------------------------------------------------------------------------


def _start_str(create_time: float | None) -> str:
    return "" if create_time is None else repr(float(create_time))


def _translate(exc: psutil.Error) -> OSError:
    """psutil's exceptions are not OSError subclasses; callers expect the
    POSIX ones so they can keep a single `except` clause."""
    if isinstance(exc, psutil.NoSuchProcess):
        return ProcessLookupError(exc.pid)
    if isinstance(exc, psutil.AccessDenied):
        return PermissionError(str(exc))
    return OSError(str(exc))


class WindowsProcessTree:
    """`psutil` for the table, Job Objects / `TerminateProcess` for kills."""

    def snapshot(self) -> dict[int, ProcInfo]:
        rows: dict[int, tuple[int, float | None]] = {}
        # A fresh Process per pid, not process_iter(): that caches one Process
        # per pid module-wide, and when Windows recycles a pid between two
        # snapshots the cached instance notices the reuse mid-read and the
        # pid's new, live process is dropped from this snapshot altogether.
        # And every ppid from ONE table read. `Process.ppid()` on Windows is
        # `ppid_map()[pid]` — a fresh toolhelp snapshot of the whole table per
        # call — so asking each process made this loop quadratic: measured at
        # 2.3-3.5s for 151 processes, 9-19s for 305 under load, on a path
        # kill() awaits and the breakaway sweep runs after every reap.
        try:
            for pid, raw_ppid in psutil._ppid_map().items():
                try:
                    created = psutil.Process(pid).create_time()
                except psutil.NoSuchProcess:
                    continue
                except psutil.AccessDenied:
                    created = None
                try:
                    ppid = int(raw_ppid or 0)
                except (TypeError, ValueError):
                    ppid = 0
                rows[pid] = (ppid, created)
        except psutil.Error:
            return {}
        snap: dict[int, ProcInfo] = {}
        for pid, (ppid, created) in rows.items():
            if _stale_parent(rows, ppid, created):
                ppid = 0
            snap[pid] = ProcInfo(ppid, pid, _start_str(created))
        return snap

    def descendants(self, pid: int) -> list[int]:
        return walk_descendants(children_map(self.snapshot()), pid)

    def group_of(self, pid: int) -> int:
        if not psutil.pid_exists(pid):
            raise ProcessLookupError(pid)
        return pid

    def start_time(self, pid: int) -> str:
        try:
            return _start_str(psutil.Process(pid).create_time())
        except psutil.Error:
            return ""

    def identity(self, pid: int) -> str:
        start = self.start_time(pid)
        return f"{pid}:{start}" if start else ""

    def command_of(self, pid: int) -> str | None:
        try:
            proc = psutil.Process(pid)
            return subprocess.list2cmdline(proc.cmdline()) or proc.name()
        except psutil.NoSuchProcess:
            return ""
        except psutil.Error:
            return None

    def is_alive(self, pid: int) -> bool:
        # `pid_exists` is the cheap first cut, but on Windows a process can have
        # exited while a handle to it is still held — a debugger, or WerFault
        # collecting a crash dump of the app for the seconds it takes — which
        # keeps the pid from being reused and which psutil reads inconsistently.
        # The backend follows the app's pid to know when to shut down, so a
        # crashed parent read as "still alive" is exactly how it would be
        # orphaned. Ask the kernel: a process that has exited has an exit code,
        # only STILL_ACTIVE is actually running.
        if not psutil.pid_exists(pid):
            return False
        k = _kernel32()
        handle = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            # Cannot open it to ask; pid_exists already said it is there.
            return True
        try:
            code = ctypes.c_uint32(0)
            if k.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return True
        finally:
            k.CloseHandle(handle)

    def is_orphan_parent(self, ppid: int, me: int) -> bool:
        # No reparenting here: `snapshot` writes 0 for a parent that is gone
        # (see `_stale_parent`), so 0 is what an orphan looks like.
        return ppid in (0, me)

    def parent_to_follow(self, env: Mapping[str, str]) -> int | None:
        # Follow the pid the app named, the same as POSIX. There is no Job
        # Object tying this backend to the app — the app never creates one (the
        # KILL_ON_JOB_CLOSE job in this module owns a pane's PTY child, not this
        # process) — so on an abnormal exit (a crash or Task-Manager kill of the
        # app, where its normal quit path and the stdin `shutdown` line never
        # run) nothing else would end this backend, and the next launch finds a
        # second one holding the port. `_watch_parent_for_shutdown` guards the
        # fast Windows pid reuse with `identity` (pid + start time).
        raw = env.get("AGENT_TEAM_PARENT_PID", "")
        try:
            pid = int(raw)
        except ValueError:
            return None
        return pid if pid > 0 else None

    def kill(self, pid: int, *, force: bool) -> None:
        # Both `force` values are TerminateProcess: Windows has no SIGTERM.
        try:
            psutil.Process(pid).kill()
        except psutil.Error as exc:
            raise _translate(exc) from None

    def kill_group(self, gid: int, *, force: bool) -> None:
        # No process groups: the "group" is the subtree rooted at gid.
        self.kill_tree(gid, force=force)

    def own_group_spawn_kwargs(self) -> dict[str, int]:
        # Suspended until `start_own_group` has put it in its job: a child
        # that ran first could start a process (cmd\git.exe starts the real
        # git.exe at once) before the assignment, and that one and everything
        # it starts would be outside the job.
        return {"creationflags": CREATE_SUSPENDED}

    def end_own_group(self, pid: int) -> None:
        return None

    def start_own_group(self, pid: int) -> int | None:
        job: int | None = None
        try:
            job = self.contain(pid)
        except OSError as exc:
            # Degraded, not fatal: the run works, and a timeout falls back to
            # killing the snapshot of its tree.
            log.warning("job object unavailable for pid %s: %s", pid, exc)
        try:
            # NtResumeProcess: Popen has already closed the thread handle.
            psutil.Process(pid).resume()
        except psutil.Error as exc:
            if job is not None:
                self.end_contained(pid, job)
            else:
                try:
                    self.kill(pid, force=True)
                except OSError:
                    pass
            raise _translate(exc) from None
        return job

    def release_contained(self, pid: int, job: int) -> None:
        with _jobs_lock:
            entry = _jobs.get(pid)
            if entry is not None and entry[0] == job:
                del _jobs[pid]
        k = _kernel32()
        # Zeroed limits: no KILL_ON_JOB_CLOSE, so the close below ends nothing.
        info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        if k.SetInformationJobObject(
            job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)
        ):
            k.CloseHandle(job)
            return
        # Closing it now would end what the run left running: keep the handle.
        log.warning(
            "could not clear kill-on-close for pid %s (error %s); keeping its job open",
            pid,
            ctypes.get_last_error(),  # type: ignore[attr-defined]
        )

    def contain(self, pid: int) -> int | None:
        job = _create_kill_on_close_job()
        try:
            _assign_to_job(job, pid)
        except OSError:
            _kernel32().CloseHandle(job)
            raise
        _register_job(pid, job)
        return job

    def end_contained(self, pid: int, job: int | None = None) -> None:
        if job is not None:
            # The caller's own job only, as `_release_job`: a pane spawned
            # onto this pid after the root exited owns the entry by then, and
            # closing that pane's job would end its whole tree.
            with _jobs_lock:
                entry = _jobs.get(pid)
                if entry is not None and entry[0] == job:
                    del _jobs[pid]
            _kernel32().CloseHandle(job)
            return
        with _jobs_lock:
            entry = _jobs.pop(pid, None)
        if entry is not None:
            # KILL_ON_JOB_CLOSE: closing the last handle ends every process
            # in the job, the root's or not, the root alive or not.
            _kernel32().CloseHandle(entry[0])
            return
        try:
            self.kill_tree(pid, force=True)
        except OSError:
            pass

    def isolate_stdin_from_children(self) -> bool:
        global _stdin_nul_fd
        try:
            import msvcrt

            if _stdin_nul_fd is None:
                # Held for the life of the process: it is the std handle now.
                _stdin_nul_fd = os.open(os.devnull, os.O_RDONLY)
            handle = msvcrt.get_osfhandle(_stdin_nul_fd)
            if _kernel32().SetStdHandle(STD_INPUT_HANDLE, handle):
                return True
            error = ctypes.get_last_error()  # type: ignore[attr-defined]
            log.warning("SetStdHandle(NUL) failed (error %s); children still inherit stdin", error)
        except OSError as exc:
            log.warning("could not point stdin at NUL (%s); children still inherit stdin", exc)
        return False

    def stderr_handle_info(self) -> str:
        try:
            from ctypes import wintypes

            k = _kernel32()
            handle = k.GetStdHandle(STD_ERROR_HANDLE)
            flags = wintypes.DWORD(0)
            ok = k.GetHandleInformation(handle, ctypes.byref(flags))
            error = 0 if ok else ctypes.get_last_error()  # type: ignore[attr-defined]
            return f"stderr handle={handle!r} GetHandleInformation ok={bool(ok)} flags={flags.value:#x} error={error}"
        except Exception as exc:  # noqa: BLE001 - diagnostics never raise
            return f"stderr handle not readable: {exc}"

    def kill_tree(self, pid: int, *, force: bool) -> None:
        if _terminate_job(pid):
            return
        try:
            root = psutil.Process(pid)
            children = root.children(recursive=True)
        except psutil.Error as exc:
            raise _translate(exc) from None
        # Root first so it cannot fork replacements while the list dies. It
        # may exit after the snapshot; still signal every child we observed.
        root_error: psutil.Error | None = None
        try:
            root.kill()
        except psutil.NoSuchProcess:
            pass
        except psutil.Error as exc:
            root_error = exc
        for child in children:
            try:
                child.kill()
            except psutil.Error:
                pass
        if root_error is not None:
            raise _translate(root_error) from None


def _stale_parent(
    rows: dict[int, tuple[int, float | None]], ppid: int, created: float | None
) -> bool:
    """Whether a ppid points at a process that is not really the parent.

    Windows never reparents: a process whose parent exited keeps the old ppid,
    and once that number is recycled the table shows an unrelated process as
    its parent. A parent that started after its child cannot be its parent.
    """
    parent = rows.get(ppid)
    if parent is None:
        return True
    parent_created = parent[1]
    if parent_created is None or created is None:
        return False
    return parent_created > created


# ---------------------------------------------------------------------------
# Terminal
# ---------------------------------------------------------------------------


class _WindowsChild:
    """`subprocess.Popen`'s `pid/poll/wait/returncode` over a process handle.

    Holds its own `OpenProcess` handle rather than the one pywinpty keeps, so
    the exit code is still readable after the pseudoconsole has been released
    — `terminals` polls *after* `TerminalHandle.close()`. The handle is closed
    by whichever `poll`/`wait` first reads the exit code, exactly once.
    """

    def __init__(self, pid: int, handle: int) -> None:
        self.pid = pid
        self.returncode: int | None = None
        self._handle = handle

    def poll(self) -> int | None:
        if self.returncode is not None:
            return self.returncode
        k = _kernel32()
        if k.WaitForSingleObject(self._handle, 0) != WAIT_OBJECT_0:
            return None
        code = ctypes.c_uint32(0)
        if k.GetExitCodeProcess(self._handle, ctypes.byref(code)):
            self.returncode = int(code.value)
        else:
            self.returncode = _TERMINATE_EXIT_CODE
        k.CloseHandle(self._handle)
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is not None:
            return self.returncode
        millis = INFINITE if timeout is None else max(0, int(timeout * 1000))
        if _kernel32().WaitForSingleObject(self._handle, millis) != WAIT_OBJECT_0:
            raise subprocess.TimeoutExpired(str(self.pid), timeout or 0)
        code = self.poll()
        return code if code is not None else _TERMINATE_EXIT_CODE


#: Sleep between two consecutive empty reads while the child is still alive
#: (the reader channel came back empty but the process has not gone yet).
_PUMP_IDLE_S = 0.001
#: How long the exit watcher waits per slice before re-checking `_closed`.
_EXIT_WATCH_MS = 250
#: Grace between the child's exit and cutting the pump's read: the conout
#: pipe may still carry what the child wrote last, and the pump needs a
#: moment to drain it.
_EXIT_DRAIN_S = 0.05
#: How long `watch_writable` waits before retrying a drain (see module doc).
_WRITE_RETRY_S = 0.05
#: Output a pause may leave queued before the oldest chunks are dropped. A
#: pause cannot throttle the CLI here (see `pause_reading`), so this is what
#: bounds the backend's memory while a drain stalls. Equal to terminals'
#: _BUF_CAP, the bound POSIX applies to the same stall one layer up.
_PAUSED_QUEUE_CAP = 5 * 1024 * 1024


class WindowsTerminalHandle:
    """A ConPTY plus the job that owns its child.

    Output flows pump thread -> `_chunks` -> `read()` on the loop thread; the
    pump wakes the loop at most once per batch (`_scheduled`), and the
    delivery callback re-arms itself while chunks remain so a caller that
    drains in bounded slices keeps getting called, the way a level-triggered
    `add_reader` would.
    """

    def __init__(self, pty: Any, pid: int, job: int | None, process_handle: int) -> None:
        self._pty: Any = pty
        self.pid = pid
        self._job = job
        self.proc = _WindowsChild(pid, process_handle)
        self._chunks: deque[bytes] = deque()
        self._queued = 0
        self._dropped = 0
        self._lock = threading.Lock()
        self._eof = False
        self._closed = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._callback: Callable[[], None] | None = None
        self._paused = False
        self._scheduled = False
        self._pump: threading.Thread | None = None
        self._process_handle = process_handle
        self._watcher: threading.Thread | None = None
        self._write_retry: asyncio.TimerHandle | None = None
        # Input arrives as UTF-8 bytes and pywinpty wants text; a chunk that
        # ends mid-character keeps its tail here until the rest arrives.
        self._input_decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    # -- output ---------------------------------------------------------------

    def read(self, max_bytes: int) -> bytes | None:
        with self._lock:
            if not self._chunks:
                if self._eof:
                    return None
                raise BlockingIOError(11, "no output pending")
            head = self._chunks[0]
            if len(head) <= max_bytes:
                self._chunks.popleft()
            else:
                self._chunks[0] = head[max_bytes:]
                head = head[:max_bytes]
            self._queued -= len(head)
            return head

    def start_reading(
        self, loop: asyncio.AbstractEventLoop, callback: Callable[[], None]
    ) -> None:
        with self._lock:
            self._loop = loop
            self._callback = callback
            self._paused = False
            start = self._pump is None and not self._closed
            if start:
                self._pump = threading.Thread(
                    target=self._run_pump,
                    args=(self._pty,),
                    name=f"conpty-pump-{self.pid}",
                    daemon=True,
                )
                if self._process_handle:
                    self._watcher = threading.Thread(
                        target=self._watch_exit,
                        args=(self._pty, self._process_handle),
                        name=f"conpty-exit-{self.pid}",
                        daemon=True,
                    )
        if start:
            self._pump.start()  # type: ignore[union-attr]
            if self._watcher is not None:
                self._watcher.start()
        else:
            self._notify()

    def pause_reading(self) -> None:
        # Holds the callback only; the pump keeps draining into `_chunks`.
        # Holding the pump too would buy nothing: pywinpty's `PTY.read` is a
        # `recv()` from winpty-rs's own reader thread, which reads the conout
        # pipe without pause into an unbounded channel (winpty-rs 1.0.6,
        # pty/base.rs, `reader_out_tx`). The CLI is never throttled either
        # way — POSIX gets that from the kernel's bounded pty buffer — and a
        # held pump would only move the growth into that channel, where the
        # watcher's EOF could overtake output still queued there.
        with self._lock:
            self._paused = True

    def resume_reading(self) -> None:
        with self._lock:
            self._paused = False
            dropped, self._dropped = self._dropped, 0
        if dropped:
            log.warning(
                "conpty output dropped pid=%s bytes=%d (paused queue over %d)",
                self.pid, dropped, _PAUSED_QUEUE_CAP,
            )
        self._notify()

    def stop_reading(self) -> None:
        with self._lock:
            self._callback = None
            self._paused = True

    def _run_pump(self, pty: Any) -> None:
        """Worker: block on the ConPTY output until EOF, queueing every chunk.

        `PTY.read(blocking=True)` raises once winpty-rs's own reader has hit
        EOF or had its I/O cancelled, and returns "" once that reader thread
        has gone; an empty result while the child still lives is idled on
        briefly rather than spun on.
        """
        try:
            while not self._closed:
                try:
                    text = pty.read(blocking=True)
                except Exception:  # noqa: BLE001 — WinptyError: EOF or cancelled
                    break
                if text:
                    self._enqueue(text.encode("utf-8", "replace"))
                    continue
                try:
                    if pty.iseof() or not pty.isalive():
                        break
                except Exception:  # noqa: BLE001
                    break
                time.sleep(_PUMP_IDLE_S)
        finally:
            # The read ending is not the child ending. Once `close()` has
            # cut the read, or without a watcher to say otherwise, it is
            # EOF; but an output stream that ends under a child that is
            # still running must not become one — `terminals` closes the
            # session on EOF, and that close tears the pseudoconsole out
            # from under a live CLI. The watcher owns the exit: it makes
            # the EOF once the process handle signals.
            if self._closed or not self._process_handle or self._child_exited():
                with self._lock:
                    self._eof = True
                self._notify()
            else:
                log.warning(
                    "conpty output ended while pid %s is still running; "
                    "waiting for its exit before reporting EOF",
                    self.pid,
                )

    def _child_exited(self) -> bool:
        """Whether the process handle has signalled (the watcher's reading:
        anything but a timeout, `WAIT_FAILED` on a handle `poll()` has
        already released included)."""
        return (
            _kernel32().WaitForSingleObject(self._process_handle, 0) != WAIT_TIMEOUT
        )

    def _watch_exit(self, pty: Any, process_handle: int) -> None:
        """Worker: turn the child's exit into EOF on the output.

        ConPTY keeps the conout pipe open until the pseudoconsole itself is
        closed, so a child that exits leaves the pump parked in ReadFile for
        good — POSIX gets its EOF from the kernel here, Windows has to make
        one. Waits on the process handle in slices so `close()` is noticed;
        anything but a timeout means the child is gone (`WAIT_FAILED` too:
        `poll()` closes the handle once it has read the exit code). Then
        gives the pump a moment to drain what the child wrote last and cuts
        its read, which is the same unblocking `close()` relies on.
        """
        k = _kernel32()
        while not self._closed:
            if k.WaitForSingleObject(process_handle, _EXIT_WATCH_MS) != WAIT_TIMEOUT:
                break
        if self._closed:
            return
        time.sleep(_EXIT_DRAIN_S)
        try:
            pty.cancel_io()
        except Exception:  # noqa: BLE001
            pass
        # The pump marks EOF itself once its read raises; this covers a read
        # that returns instead, so the exit reaches the loop either way.
        with self._lock:
            self._eof = True
        self._notify()

    def _enqueue(self, data: bytes) -> None:
        with self._lock:
            self._chunks.append(data)
            self._queued += len(data)
            # Only a pause lets the queue build up; drop the oldest, keeping
            # at least the chunk that just arrived.
            while self._paused and self._queued > _PAUSED_QUEUE_CAP and len(self._chunks) > 1:
                old = self._chunks.popleft()
                self._queued -= len(old)
                self._dropped += len(old)
        self._notify()

    def _notify(self) -> None:
        with self._lock:
            loop = self._loop
            if (
                loop is None
                or self._callback is None
                or self._paused
                or self._scheduled
                or not (self._chunks or self._eof)
            ):
                return
            self._scheduled = True
        try:
            loop.call_soon_threadsafe(self._deliver)
        except RuntimeError:
            # The pane's loop went away before its pump did — a window closing,
            # or shutdown. POSIX reaches this moment with an `add_reader`
            # callback the loop simply stops calling; here it is a cross-thread
            # call into a closed loop, which raises on the pump thread. Nothing
            # can be delivered any more, so end the pump the way `close()`
            # would rather than let it surface as a thread exception.
            with self._lock:
                self._scheduled = False
                self._closed = True

    def _deliver(self) -> None:
        with self._lock:
            self._scheduled = False
            callback = self._callback
            paused = self._paused
        if callback is None or paused:
            return
        callback()
        # Level-triggered: a bounded drain leaves the rest for the next tick.
        with self._lock:
            rearm = bool(self._chunks) and self._callback is not None and not self._paused
            if rearm and not self._scheduled and self._loop is not None:
                self._scheduled = True
                self._loop.call_soon(self._deliver)

    # -- input ----------------------------------------------------------------

    def write(self, data: bytes) -> int:
        if self._closed:
            raise OSError("terminal is closed")
        text = self._input_decoder.decode(data)
        if text:
            try:
                self._pty.write(text)
            except Exception as exc:  # noqa: BLE001 — WinptyError has no errno
                raise OSError(str(exc)) from None
        return len(data)

    def watch_writable(
        self, loop: asyncio.AbstractEventLoop, callback: Callable[[], None]
    ) -> None:
        self.unwatch_writable()
        self._write_retry = loop.call_later(_WRITE_RETRY_S, callback)

    def unwatch_writable(self) -> None:
        if self._write_retry is not None:
            self._write_retry.cancel()
            self._write_retry = None

    # -- control --------------------------------------------------------------

    def resize(self, rows: int, cols: int) -> None:
        try:
            self._pty.set_size(cols, rows)
        except Exception as exc:  # noqa: BLE001
            raise OSError(str(exc)) from None

    def foreground_group(self) -> int:
        return self.pid

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.unwatch_writable()
        # Closing the job handle is the kill (KILL_ON_JOB_CLOSE) — the same
        # outcome the POSIX close reaches through SIGHUP on the master.
        if self._job is not None:
            _release_job(self.pid, self._job)
        else:
            try:
                process_tree.kill_tree(self.pid, force=True)
            except OSError:
                pass
        pty, self._pty = self._pty, None
        if pty is not None:
            try:
                # Unblock a pump parked in ReadFile so it can exit and drop the
                # last reference; the pseudoconsole is released when it does.
                pty.cancel_io()
            except Exception:  # noqa: BLE001
                pass
        # A child that is already gone gives up its process handle here; one
        # the job close is still terminating keeps it until the caller's own
        # poll/wait sees the exit (the exit code must survive this close).
        # `_closed` is set above, so the watcher stops instead of waiting on
        # what is now a closed handle.
        if self._process_handle:
            self.proc.poll()


class WindowsTerminalBackend:
    """`winpty.PTY` (ConPTY) with the child assigned to a kill-on-close job."""

    helper_waits_for_child: bool = True
    reports_foreground: bool = False

    def parse_command(self, command: str) -> list[str]:
        return _split_command_line(command)

    def self_check_conpty(self) -> tuple[bool, str]:
        # Real ConPTY, not a mock: spawn `cmd /c exit 0` and require a clean
        # exit. pywinpty does not create the pseudoconsole itself — conpty.dll
        # launches winpty's `OpenConsole.exe` as the host — so a frozen build
        # that dropped that file spawns fine but the child is torn down at once
        # and exits with STATUS_CONTROL_C_EXIT (0xC000013A). That is exactly
        # the "every pane dies on Windows" regression, caught here in CI before
        # it ships.
        status_control_c_exit = 0xC000013A
        try:
            import winpty
        except Exception as exc:  # noqa: BLE001
            return False, f"conpty self-check: FAIL — cannot import winpty: {exc}"
        winpty_dir = os.path.dirname(winpty.__file__)
        open_console = os.path.join(winpty_dir, "OpenConsole.exe")
        if not os.path.exists(open_console):
            return False, (
                "conpty self-check: FAIL — OpenConsole.exe missing from "
                f"{winpty_dir}; ConPTY panes would die with STATUS_CONTROL_C_EXIT"
            )
        cmd = os.path.join(
            os.environ.get("SystemRoot", r"C:\Windows"), "System32", "cmd.exe"
        )
        try:
            pty = winpty.PTY(80, 24)
            pty.spawn(cmd, cmdline="/c exit 0")
        except Exception as exc:  # noqa: BLE001
            return False, f"conpty self-check: FAIL — spawn raised: {exc}"
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            try:
                alive = pty.isalive()
            except Exception:  # noqa: BLE001
                alive = False
            if not alive:
                break
            time.sleep(0.05)
        else:
            return False, "conpty self-check: FAIL — child never exited within 10s"
        try:
            status = pty.get_exitstatus()
        except Exception:  # noqa: BLE001
            status = None
        if status == status_control_c_exit:
            return False, (
                "conpty self-check: FAIL — child exited with STATUS_CONTROL_C_EXIT "
                "(pseudoconsole torn down; OpenConsole.exe not usable)"
            )
        return True, (
            f"conpty self-check: OK — clean ConPTY exit (status={status}), "
            "OpenConsole.exe present"
        )

    def spawn(
        self,
        argv: list[str] | str,
        *,
        cwd: str,
        env: dict[str, str],
        rows: int,
        cols: int,
    ) -> WindowsTerminalHandle:
        # A ready-made command line is parsed by the OS's own rules and
        # rebuilt with the same quoting, so both shapes take one path below.
        words = self.parse_command(argv) if isinstance(argv, str) else list(argv)
        if not words:
            raise ValueError("command is empty")
        # PATHEXT lookup: `claude` resolves to npm's `claude.cmd` shim. The
        # launch seam decides what actually starts: the `node.exe <script>`
        # behind a recognised shim, else cmd.exe on the shim (a .cmd is not
        # an image CreateProcess can run). winpty-rs puts `appname` at the
        # head of the command line and leaves lpApplicationName NULL.
        exe = shutil.which(words[0], path=env.get("PATH") or None)
        if not exe:
            raise FileNotFoundError(f"executable not found: {words[0]}")
        head, tail = paths.pty_launch_parts(exe, words[1:], path=env.get("PATH") or None)
        appname = subprocess.list2cmdline([head])
        cmdline = subprocess.list2cmdline(tail) or None
        env_block = "\0".join(f"{k}={v}" for k, v in env.items()) + "\0"
        try:
            import winpty
        except ImportError as exc:  # pragma: no cover - dependency marker
            raise RuntimeError("pywinpty is required for terminals on Windows") from exc
        pty = winpty.PTY(cols, rows)
        try:
            pty.spawn(appname, cmdline=cmdline, cwd=cwd, env=env_block)
        except Exception as exc:  # noqa: BLE001 — WinptyError carries only text
            raise OSError(f"spawn failed: {exc}") from None
        pid = pty.pid
        if not pid:
            raise OSError("spawn failed: no pid")
        pid = int(pid)
        k = _kernel32()
        process_handle = k.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, pid
        )
        if not process_handle:
            err = _win_error()
            _kill_orphaned_spawn(pty, pid)
            raise err
        job: int | None = None
        try:
            job = _create_kill_on_close_job()
            _assign_to_job(job, pid)
        except OSError as exc:
            # Degraded, not fatal: the pane still works, kill_tree falls
            # back to walking the table, and a backend crash leaks the tree.
            log.warning("job object unavailable for pid %s: %s", pid, exc)
            if job is not None:
                # Created but never populated: closing it kills nothing.
                k.CloseHandle(job)
            job = None
        if job is not None:
            _register_job(pid, job)
        return WindowsTerminalHandle(pty, pid, job, int(process_handle))


def _kill_orphaned_spawn(pty: Any, pid: int) -> None:
    try:
        psutil.Process(pid).kill()
    except psutil.Error:
        pass
    try:
        pty.cancel_io()
    except Exception:  # noqa: BLE001
        pass


paths = WindowsPaths()
resource_probe = WindowsResourceProbe()
process_tree = WindowsProcessTree()
terminal_backend = WindowsTerminalBackend()


# ---- appended: Paths members and SecretFiles for the Windows port -----------
#
# Re-added after a whole-file rewrite of this module clobbered the first
# version. A subclass rather than edits to `WindowsPaths` above, so this lands
# as a pure append; `paths` is rebound below to the complete implementation.

import tempfile  # noqa: E402


class WindowsLayout(WindowsPaths):
    def state_dir(self, app_name: str) -> Path:
        # One directory for both roles on Windows: `%APPDATA%\<app>`.
        return self.app_support_dir(app_name)

    def config_home(self, home: Path) -> Path:
        configured = os.environ.get("APPDATA")
        return Path(configured) if configured else home / "AppData" / "Roaming"

    def roaming_app_data(self) -> Path | None:
        configured = os.environ.get("APPDATA")
        return Path(configured) if configured else None

    def system_dirs(self) -> list[Path]:
        # Each folder is listed both where its variable points and at its documented
        # default: a changed variable can add a folder, never drop C:\Windows.
        env = os.environ
        found: list[Path] = []
        for var, default in (
            ("SystemRoot", r"C:\Windows"), ("ProgramFiles", r"C:\Program Files"),
            ("ProgramFiles(x86)", r"C:\Program Files (x86)"), ("ProgramData", r"C:\ProgramData"),
        ):
            found += [Path(default)] + ([Path(env[var])] if env.get(var) else [])
        home = Path.home()
        # Credential Manager, DPAPI master keys and browser profiles (cookies, logins).
        for var, default, rels in (
            ("APPDATA", home / "AppData" / "Roaming",
             ("Microsoft/Credentials", "Microsoft/Protect", "Microsoft/Crypto",
              "Microsoft/SystemCertificates", "Mozilla/Firefox", "GitHub CLI", "gnupg")),
            ("LOCALAPPDATA", home / "AppData" / "Local",
             ("Microsoft/Credentials", "Microsoft/Vault", "Google/Chrome/User Data",
              "Microsoft/Edge/User Data", "BraveSoftware", "Chromium/User Data")),
        ):
            bases = [default] + ([Path(env[var])] if env.get(var) else [])
            found += [base.joinpath(*rel.split("/")) for base in bases for rel in rels]
        # The CLIs' dot folders in %USERPROFILE% (.ssh, .aws, .config\gh ...), as on POSIX.
        from ._posix_paths import _DOT_SECRET_DIRS

        found += [home.joinpath(*rel.split("/")) for rel in _DOT_SECRET_DIRS]
        return found

    def home_env_var(self) -> str:
        return "USERPROFILE"

    def isolated_home_env(self, home_dir: Path) -> dict[str, str]:
        home = str(home_dir)
        return {"USERPROFILE": home, "HOME": home, "TEMP": home, "TMP": home}

    def env_name_key(self, name: str) -> str:
        # The env block handed to CreateProcess is matched case-insensitively,
        # so a request spelled `minimax_data_dir` sets MINIMAX_DATA_DIR.
        return name.casefold()

    def askpass_launcher(self, helper_py: Path, launch_argv: list[str]) -> Path:
        """A sibling `.cmd` that runs this backend's own askpass entry mode.

        git execs `GIT_ASKPASS` with no shell and Windows cannot exec a
        `.py`, so the launcher has to name something runnable. `launch_argv`
        is this process's executable plus the flag, never the bare name
        `python`: that name resolves on a stock Windows to the Store's alias
        stub, which prints its install page and hands git an empty credential.

        Rewritten only when its content differs, so a launcher that is
        already right keeps its mtime and no other process sees it flicker.
        Best effort on the write, like the POSIX chmod: git_service resolves
        this at import, so an unwritable directory must not stop the backend
        — git reports the missing launcher itself when a credential is asked.
        """
        launcher = helper_py.with_suffix(".cmd")
        content = f"@{subprocess.list2cmdline(launch_argv)} %*\r\n".encode("utf-8")
        try:
            if launcher.read_bytes() == content:
                return launcher
        except OSError:
            pass
        try:
            launcher.write_bytes(content)
        except OSError as err:
            log.warning("cannot write git askpass launcher %s: %s", launcher, err)
        return launcher


# -- DPAPI-backed secret files --------------------------------------------------
#
# `os.chmod(0o600)` is a no-op on NTFS, so mode bits cannot protect a secret
# here. `write_private` wraps the content with `CryptProtectData` instead:
# only the same Windows account can unwrap it, whichever ACL the file ends up
# with. `write_private_plain` has to stay in the clear because another program
# reads it, so that one is protected the only way NTFS expresses it — an
# owner-only ACL, written with `icacls` (see `_restrict_to_owner`).

#: Header that marks a DPAPI-wrapped file; anything without it is read as-is.
DPAPI_MAGIC = b"NAVIDE-DPAPI-1\n"
#: `CRYPTPROTECT_UI_FORBIDDEN`: a headless backend must never pop a dialog.
CRYPTPROTECT_UI_FORBIDDEN = 0x1


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


_c32: Any = None


def _crypt32() -> Any:
    global _c32
    if _c32 is None:
        c = ctypes.WinDLL("crypt32", use_last_error=True)  # type: ignore[attr-defined]
        blob = ctypes.POINTER(_DATA_BLOB)
        c.CryptProtectData.argtypes = [
            blob, ctypes.c_wchar_p, blob, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_uint32, blob,
        ]
        c.CryptProtectData.restype = ctypes.c_int
        c.CryptUnprotectData.argtypes = [
            blob, ctypes.POINTER(ctypes.c_wchar_p), blob, ctypes.c_void_p,
            ctypes.c_void_p, ctypes.c_uint32, blob,
        ]
        c.CryptUnprotectData.restype = ctypes.c_int
        _c32 = c
    return _c32


def _local_free(pointer: Any) -> None:
    """DPAPI output buffers are LocalAlloc'd by the system."""
    _kernel32().LocalFree(pointer)


def _dpapi(name: str, data: bytes) -> bytes:
    source = ctypes.create_string_buffer(data, len(data))
    blob_in = _DATA_BLOB(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_char)))
    blob_out = _DATA_BLOB()
    ok = getattr(_crypt32(), name)(
        ctypes.byref(blob_in), None, None, None, None,
        CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out),
    )
    if not ok:
        try:
            raise _win_error()
        except AttributeError:  # not on Windows: no WinError to consult
            raise OSError(f"{name} failed") from None
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        _local_free(blob_out.pbData)


def _write_atomic(path: Path, data: bytes) -> None:
    """Same-directory temp file moved into place; nothing left on failure."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".")
    tmp = Path(tmp_name)
    try:
        try:
            os.write(handle, data)
        finally:
            os.close(handle)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


#: `icacls` is a local, non-networked call; a timeout this generous only
#: matters when the machine is thrashing.
_ICACLS_TIMEOUT_S = 10.0


def _current_user() -> str | None:
    """The account to grant, or None when the name cannot be established."""
    try:
        name = os.getlogin()
    except OSError:
        # No console attached (a service-started backend): the environment is
        # the other place the session's user name is written down.
        name = ""
    return name or os.environ.get("USERNAME") or None


def _restrict_to_owner(path: Path, *, container: bool) -> None:
    """Take `path` down to one full-control ACE for this account, via `icacls`.

    `/inheritance:r` drops what the parent handed down — on a default profile
    that is SYSTEM and Administrators, and on a tree someone has widened it can
    be Users — and `/grant:r` then replaces any remaining grant for this
    account rather than adding a second ACE, so calling this twice is the same
    as calling it once. A directory also takes `(OI)(CI)` so the files created
    inside it start owner-only too.

    What is left behind is the machine itself: SYSTEM, and on an administrator
    account the local Administrators group, arrive on a new file as *explicit*
    ACEs off the creating token's default DACL, so `/inheritance:r` has nothing
    to remove and `/grant:r` only rewrites the entry it names. That is the
    boundary this draws, and it is the one `0600` draws on POSIX: no other
    person, rather than nobody at all — an administrator holds
    SeTakeOwnershipPrivilege and can put any DACL back whatever is written
    here, so spending a `/remove` on them would cost backup and system access
    and buy no confidentiality.

    Never raises. The secret is already written and correct at this point; a
    box where `icacls` is missing or refuses must still start, with the failure
    in the log rather than in the caller.
    """
    user = _current_user()
    if not user:
        log.warning("cannot restrict %s: no account name to grant to", path)
        return
    rights = "(OI)(CI)F" if container else "F"
    argv = ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:{rights}"]
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=_ICACLS_TIMEOUT_S,
            # No console flash on a GUI-launched backend; absent off Windows,
            # where this module still imports for the tests.
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as err:
        log.warning("icacls failed for %s: %s", path, err)
        return
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        log.warning("icacls refused %s (exit %s): %s", path, proc.returncode, detail)


class WindowsSecretFiles:
    """`SecretFiles` through DPAPI for our own content, ACLs for the rest."""

    def write_private(self, path: Path, data: bytes) -> None:
        # Wrap first: a DPAPI failure must leave no file behind at all.
        wrapped = DPAPI_MAGIC + _dpapi("CryptProtectData", data)
        _write_atomic(path, wrapped)

    def write_private_plain(self, path: Path, data: bytes) -> None:
        _write_atomic(path, data)
        # After the replace, not before: the ACL has to land on the file that
        # survives, and the temp file is the one that gets thrown away.
        _restrict_to_owner(path, container=False)

    def read_private(self, path: Path) -> bytes:
        raw = path.read_bytes()
        if not raw.startswith(DPAPI_MAGIC):
            return raw  # legacy plaintext, or copied over from a POSIX machine
        return _dpapi("CryptUnprotectData", raw[len(DPAPI_MAGIC):])

    def harden_file(self, path: Path) -> None:
        # `stat` first, so a missing file reports like the POSIX one does
        # rather than as an `icacls` exit code in the log.
        path.stat()
        _restrict_to_owner(path, container=False)

    def make_private_dir(self, path: Path) -> None:
        path.mkdir(parents=True, exist_ok=True)
        _restrict_to_owner(path, container=True)




# ---- appended: discovery, shell and symlink members of Paths ----------------

_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"


def _pathext() -> list[str]:
    raw = os.environ.get("PATHEXT") or _DEFAULT_PATHEXT
    # Always ";": PATHEXT is a Windows variable even when read on another OS.
    return [ext.lower() for ext in raw.split(";") if ext.startswith(".")]


#: Result of the one-time symlink probe; None until first asked.
_symlinks_available: bool | None = None


def _probe_symlinks() -> bool:
    """Create one link in a temp dir. `WinError 1314` (privilege not held)
    is the ordinary answer on a box without Developer Mode."""
    with tempfile.TemporaryDirectory(prefix="navide-symlink-") as tmp:
        target = Path(tmp) / "target"
        target.write_bytes(b"")
        try:
            os.symlink(target, Path(tmp) / "link")
        except OSError as err:
            log.warning(
                "symbolic links are not available to this process (%s); "
                "per-pane CLI homes and managed skills stay unwired — enable "
                "Windows Developer Mode (Settings > For developers) or run "
                "Navide elevated",
                err,
            )
            return False
    return True


class WindowsDiscoveryLayout(WindowsLayout):
    def executable_candidates(self, name: str) -> list[str]:
        exts = _pathext()
        if any(name.lower().endswith(ext) for ext in exts):
            return [name]
        return [name + ext for ext in exts]

    def is_executable(self, path: Path) -> bool:
        # No execute bit on NTFS: runnability is the extension, and
        # `executable_candidates` only ever names runnable ones.
        return True

    def login_path_probe(self) -> list[str] | None:
        # No login shell: PATH comes from the registry and the process
        # already carries it.
        return None

    def login_path_fallbacks(self, home: Path) -> list[str]:
        # Nothing the registry PATH would be missing.
        return []

    def login_path_tail_fallbacks(self, home: Path) -> list[str]:
        return []

    def git_subprocess_env(self, askpass: str) -> dict[str, str]:
        # GIT_ASKPASS only, as before: whether the bundled OpenSSH execs the
        # `.cmd` launcher as SSH_ASKPASS is unverified, and git's own prompts
        # are the ones the Windows port has exercised.
        return {"GIT_ASKPASS": askpass}

    def backend_entry_on_disk(self, entry: str) -> str:
        if Path(entry).suffix:
            return entry
        return entry + ".exe"

    def enforces_posix_modes(self) -> bool:
        return False

    def file_name_refused(self, name: str) -> bool:
        return windows_refused_file_name(name) or windows_short_name(name)

    def symlinks_available(self) -> bool:
        global _symlinks_available
        if _symlinks_available is None:
            _symlinks_available = _probe_symlinks()
        return _symlinks_available

    def shell_command(self, command: str) -> list[str]:
        return ["cmd.exe", "/d", "/s", "/c", command]

    def quote_arg(self, arg: str) -> str:
        return subprocess.list2cmdline([arg])

    def resolve_program(self, name_or_path: str, *, path: str | None = None) -> str | None:
        # `shutil.which` consults PATHEXT itself, but only for a bare name and
        # only on a Windows interpreter: asking it once per candidate gives the
        # same answer wherever this runs and also extends a stored override
        # (`C:\...\npm\claude`) to the shim that is actually on disk.
        for candidate in self.executable_candidates(name_or_path):
            found = shutil.which(candidate, path=path)
            if found:
                return found
        return None

    def launch_kind(self, program: str) -> str:
        suffix = Path(program).suffix.lower()
        if suffix in (".cmd", ".bat"):
            return "cmd"
        if suffix == ".ps1":
            return "powershell"
        return "direct"

    def launch_argv(self, program: str, args: Sequence[str] = ()) -> list[str]:
        kind = self.launch_kind(program)
        if kind == "cmd":
            # No `/s` here, unlike `shell_command`. `/s` makes cmd strip the
            # first and the last quote of everything after `/c` — which is
            # exactly the pair `list2cmdline` puts around a program path that
            # contains a space, leaving cmd looking for `C:\Program`. Without
            # it cmd keeps that pair (its documented rule for a command line
            # whose one quoted token is the name of an executable).
            # `/d` skips AutoRun, the same reason `shell_command` passes it.
            return ["cmd.exe", "/d", "/c", program, *args]
        if kind == "powershell":
            # `-File` and not `-Command`: `-File` takes the rest of the line as
            # plain arguments, where `-Command` would re-parse them as
            # PowerShell source. `-NoProfile` also keeps a user profile from
            # printing into the script's output.
            return [
                "powershell.exe", "-NoLogo", "-NonInteractive", "-NoProfile",
                "-ExecutionPolicy", "Bypass", "-File", program, *args,
            ]
        return [program, *args]

    def pty_launch_parts(
        self, program: str, args: Sequence[str] = (), *, path: str | None = None
    ) -> tuple[str, list[str]]:
        if self.launch_kind(program) == "cmd":
            unwrapped = _unwrap_node_shim(program, path=path)
            if unwrapped is not None:
                node, script = unwrapped
                return node, [script, *args]
        argv = self.launch_argv(program, args)
        return argv[0], argv[1:]


#: Largest file still read as a shim. Every generator's output is well under
#: 1 KiB; anything bigger is a real batch file and is left to cmd.exe.
_SHIM_MAX_BYTES = 4096

# The lines a generated node shim may consist of, one pattern per line shape,
# matched whole against each stripped line (batch is case-insensitive). The
# set is the union of what npm's cmd-shim (2.x through 8.x), yarn classic's
# @zkochan/cmd-shim and pnpm's @pnpm/cmd-shim write when they wrap a node
# script with no extra arguments and no environment of their own. A shim is
# accepted only when every one of its lines is here or is the invocation
# below; a line that sets NODE_PATH or PATH, or anything unknown, makes the
# whole file unrecognised — it is matched, never interpreted.
_SHIM_LINE_RES = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"@?ECHO off$",
        r"GOTO start$",
        r":find_dp0$",
        r":start$",
        r"SET dp0=%~dp0$",
        r"EXIT /b$",
        r"@?SETLOCAL$",
        r"@?ENDLOCAL$",
        r"CALL :find_dp0$",
        r'@?IF EXIST "(?:%~dp0|%dp0%)\\node\.exe" \($',
        r'@?SET "_prog=(?:%~dp0|%dp0%)\\node\.exe"$',
        r'@?SET "_prog=node"$',
        r"\) ELSE \($",
        r"\)$",
        r"@?SET PATHEXT=%PATHEXT:;\.JS;=;%$",
    )
]
#: The line that runs the script: node (next to the shim, or from PATH), the
#: script relative to the shim's directory, and `%*` — nothing in between.
_SHIM_INVOKE_RE = re.compile(
    r"^(?:endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & )?@?"
    r'(?:"%_prog%"|"(?:%~dp0|%dp0%)\\node\.exe"|node)\s+'
    r'"(?:%~dp0|%dp0%)\\(?P<target>[^"]+)"\s+%\*$',
    re.IGNORECASE,
)


def _unwrap_node_shim(program: str, *, path: str | None) -> tuple[str, str] | None:
    """`(node.exe, script)` for a generated node shim at `program`, else None.

    None means "run it through cmd.exe as before": the file is not a shim
    of a known shape, its script is not on disk, or no `node.exe` can be
    found where the shim would have looked (next to it, then on `path`).
    """
    try:
        if os.path.getsize(program) > _SHIM_MAX_BYTES:
            return None
        text = Path(program).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    targets: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        invoke = _SHIM_INVOKE_RE.match(line)
        if invoke:
            targets.add(invoke.group("target"))
            continue
        if not any(pattern.match(line) for pattern in _SHIM_LINE_RES):
            return None
    if len(targets) != 1:
        return None
    shim_dir = os.path.dirname(os.path.abspath(program))
    # `%~dp0` ends in a backslash, so the target is shim-relative; it is
    # written with backslashes whatever the host, hence the split.
    script = os.path.normpath(os.path.join(shim_dir, *targets.pop().split("\\")))
    if not os.path.isfile(script):
        return None
    node = os.path.join(shim_dir, "node.exe")
    if not os.path.isfile(node):
        node = shutil.which("node.exe", path=path)
        if not node:
            return None
    # The pane's reported binary stays the shim (that is what resolved); this
    # line is where a log shows which process the pane actually holds.
    log.info("node shim %s runs %s on %s", program, node, script)
    return node, script


class WindowsScheduler:
    """Inert: neither cron nor launchd exists here, and Task Scheduler is
    not wired (see `spec.Scheduler`). Lists as unsupported without spawning
    anything; mutations name the platform."""

    async def list_jobs(self, kind: str) -> dict:
        if kind == "crontab":
            return {"supported": False, "entries": [], "unparsed": 0, "error": None}
        if kind == "launchagent":
            return {"supported": False, "entries": [], "unreadable": 0, "error": None}
        raise ValueError(f"unknown execution kind: {kind!r}")

    async def set_enabled(self, kind: str, target: str, enabled: bool) -> None:
        self._refuse(kind)

    async def remove(self, kind: str, target: str) -> None:
        self._refuse(kind)

    @staticmethod
    def _refuse(kind: str) -> None:
        if kind not in ("crontab", "launchagent"):
            raise ValueError(f"unknown execution kind: {kind!r}")
        from .spec import SchedulerError

        raise SchedulerError(
            f"{kind} jobs cannot be managed on Windows (no cron or launchd; "
            "Task Scheduler is not integrated)"
        )


paths = WindowsDiscoveryLayout()
secret_files = WindowsSecretFiles()
scheduler = WindowsScheduler()


# ---- appended: the PowerShell renderings of the scripts the backend writes ---
#
# PowerShell rather than cmd because that is what reads these texts here:
# Claude Code runs a hook under Git Bash when it is installed and PowerShell
# otherwise (so the entry declares which it wrote), Copilot's hook file has a
# `powershell` key next to its `bash` one, and `external-terminal.ts` opens a
# terminal with `powershell -NoExit -Command`.


def _ps_quote(value: str) -> str:
    """`value` as a PowerShell single-quoted string: only `'` needs escaping.

    Single quotes and not double: inside double quotes PowerShell expands
    `$name` and backticks, and these strings carry Windows paths a user chose
    the characters of.
    """
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


class WindowsScripts:
    def hook_entry(self, command: str) -> dict:
        # Without `shell`, Claude Code looks for Git Bash and only falls back
        # to PowerShell when it finds none -- so a box that has Git installed
        # would run this text under the wrong shell.
        return {"type": "command", "shell": "powershell", "command": command}

    def hook_post_json(
        self,
        *,
        port_file: str,
        header_file: str,
        url_path: str,
        event: str,
        timeout_s: int,
        keep_body: bool = False,
        exit_zero: bool = False,
        env_header: tuple[str, str] | None = None,
    ) -> str:
        # System32's curl.exe by full path, never `curl` (a PowerShell alias
        # for Invoke-WebRequest, which takes none of these arguments) and never
        # `curl.exe` off PATH: a Git or MSYS2 bin directory ahead of System32
        # supplies a curl that reads its arguments in the ANSI code page, so a
        # non-ASCII header file path arrives as `???`. `'@-'` and
        # `'@file'` are quoted because `@` starts a splat or an array here.
        # `exit_zero` costs nothing to honour -- the line already ends that
        # way, because a PowerShell failure otherwise surfaces as a hook error.
        # A kept body goes through a temp file and leaves as its raw bytes:
        # PowerShell's native-output capture re-codes curl's UTF-8 through the
        # console code page, which garbled a Stop decision carrying a message
        # in Chinese (the #147 garbling on the Stop path). The console encoding
        # is left alone for the reason hook_rewake gives.
        sink = "-o $TMP " if keep_body else "-o NUL "
        extra = f"-H ('{env_header[0]}: ' + $env:{env_header[1]}) " if env_header else ""
        post = (
            f"& ($env:SystemRoot + '\\System32\\curl.exe') -fsS -m {timeout_s} {sink}-X POST "
            f"-H 'Content-Type: application/json' "
            f"-H 'X-Agent-Team-Event: {event}' "
            f"-H {_ps_quote('@' + header_file)} {extra}"
            f"--data-binary '@-' "
            f'"http://127.0.0.1:$PORT{url_path}"'
        )
        if keep_body:
            post = (
                f"{_PS_TEMP_PATH}"
                f"{post}; "
                f"$OUTB = $null; try {{ $OUTB = [IO.File]::ReadAllBytes($TMP) }} catch {{}}; "
                f"Remove-Item -LiteralPath $TMP -Force -ErrorAction SilentlyContinue; "
                f"if ($OUTB) {{ $OUTS = [Console]::OpenStandardOutput(); "
                f"$OUTS.Write($OUTB, 0, $OUTB.Length); $OUTS.Flush() }}"
            )
        return (
            f"$PORT = Get-Content -ErrorAction SilentlyContinue {_ps_quote(port_file)}; "
            f"if ($PORT) {{ {post} }}; exit 0"
        )

    def hook_rewake(
        self, *, port_file: str, header_file: str, url_path: str, timeout_s: int
    ) -> str:
        # The body never passes through PowerShell's native-output capture:
        # that splits a multi-line body into object[] (which WriteLine printed
        # as `System.Object[]`) and decodes it with the console code page, so
        # CJK came out as `?` on a cp950 box (#147). curl writes it to a temp
        # file, it is read back as UTF-8 and written to stderr as UTF-8 bytes.
        # [Console]::OutputEncoding is left alone: set and restored, it still
        # left the parent console on 65001 when two hooks interleaved or one
        # was killed mid-wait.
        return (
            f"$PORT = Get-Content -ErrorAction SilentlyContinue {_ps_quote(port_file)}; "
            f"if (-not $PORT) {{ exit 0 }}; "
            f"{_PS_TEMP_PATH}"
            f"& ($env:SystemRoot + '\\System32\\curl.exe') -fsS -m {timeout_s} -o $TMP -X POST "
            f"-H 'Content-Type: application/json' "
            f"-H 'X-Agent-Team-Event: rewake' "
            f"-H {_ps_quote('@' + header_file)} "
            f"--data-binary '@-' "
            f'"http://127.0.0.1:$PORT{url_path}" 2>$null; '
            f"$BODY = $null; try {{ $BODY = [IO.File]::ReadAllLines($TMP, [Text.Encoding]::UTF8) }} catch {{}}; "
            f"Remove-Item -LiteralPath $TMP -Force -ErrorAction SilentlyContinue; "
            f"if (($BODY -join '').Trim()) {{ "
            f"$ERRB = [Text.Encoding]::UTF8.GetBytes(($BODY -join [Environment]::NewLine) + [Environment]::NewLine); "
            f"$ERRS = [Console]::OpenStandardError(); $ERRS.Write($ERRB, 0, $ERRB.Length); $ERRS.Flush(); "
            f"exit 2 }}; exit 0"
        )

    def confirm_then_run(self, description: str, command: str) -> str:
        # `&` is the call operator: `command` starts with a quoted path, which
        # PowerShell would otherwise treat as a string to print.
        return (
            f"Write-Host {_ps_quote(description)}; "
            f"$a = Read-Host 'Continue? [y/N]'; "
            f"if ($a -match '^[Yy]') {{ & {command} }} else {{ Write-Host 'Cancelled.' }}"
        )


scripts = WindowsScripts()


class WindowsDurableSecretFiles:
    """`DurableSecretFiles` through DPAPI — the same files `secret_files` writes,
    synced before the rename. Not `_write_atomic`: that writer is shared with
    CLI account slots and is left exactly as it was (KC2R-8)."""

    def read(self, path: Path) -> bytes:
        return secret_files.read_private(path)

    def write(self, path: Path, data: bytes) -> None:
        # Wrap first, as write_private does: a DPAPI failure leaves no file.
        wrapped = DPAPI_MAGIC + _dpapi("CryptProtectData", data)
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".")
        tmp = Path(tmp_name)
        try:
            try:
                view = memoryview(wrapped)
                while view:
                    view = view[os.write(handle, view):]
                os.fsync(handle)
            finally:
                os.close(handle)
            os.replace(tmp, path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise


durable_secret_files = WindowsDurableSecretFiles()
