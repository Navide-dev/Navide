"""Run the backend suite on the Windows CI runner and always come back.

A step on the GitHub runner ends only when the runner agent can finalise it,
and with pytest run as the step's own child under `--timeout-method=thread`
and `faulthandler_timeout` that never happened: the step outlived python and
its own `timeout-minutes`, the job timeout discarded the log, and 17 rounds
of instrumentation never caught the culprit in the act. The same suite run
bare (release.yml's gates, no watchdog flags) finishes as a plain step, so
the hang is those watchdog threads meeting the step's console, not pytest;
detached, with the flags, it has finished every time. So:

* `--detach` starts a copy of this script with a log file as its only
  inherited handle (DETACHED_PROCESS, no console, `close_fds`) and returns;
  the workflow polls the log from a shell with no children and a `.done`
  marker carries the exit code.
* the copy joins a kill-on-close Job Object with process and memory limits
  before it spawns pytest, so anything a test leaves behind dies with it and
  can be listed while the suite runs.
"""

from __future__ import annotations

import ctypes
import os
import re
import subprocess
import sys
import time
from ctypes import wintypes

import psutil

LOG = "pytest.log"
WRAPPER_LOG = "ci-windows-tests.log"
DONE = "ci-windows-tests.done"
# The suite outgrew 20 minutes on 2026-09-14: main at 78954961 was killed here
# with 5530 of ~5630 results in, while the same suite had finished in 16m30s on
# a faster runner an hour earlier. Every layer above this has to stay longer
# than it or the cap stops being the thing that decides: the waiting step polls
# for 34 minutes with a 35-minute step timeout, inside a 45-minute job.
# By 2026-09-25 the whole suite took 1109-1880 s on one runner depending on the
# host (8400 tests), so CI splits it with `--shard K/N` rather than stretching
# the cap again (three shards since 2026-10-12, when one half hit the cap;
# four since later that day; five since 2026-10-19, when a slow runner took a
# shard to 1627 s of pytest, 1742 s on this clock).
CAP_SECONDS = 30 * 60
REPORT_EVERY = 60
RESULT_RE = re.compile(r" (PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)")
# A test still running this long gets the host read while it is stuck:
# pytest-timeout (90 s, thread method) dumps Python stacks and exits, so a
# read at the next 60 s report finds the hang already gone. On 2026-10-22 two
# shards hung inside file calls (a sqlite COMMIT; fsync/os.replace in
# durable_secret_files.write) at 3-9% CPU, and nothing said why.
POLL_EVERY = 5
STALL_SECONDS = 45
TIMEOUT_RE = re.compile(r"\+{3,} Timeout \+{3,}")
CREATE_NO_WINDOW = 0x08000000
# One PowerShell for the parts psutil cannot read. The Defender log names
# scans, detections and setting changes, not every file it inspects.
_HOST_PROBE = r"""
$ErrorActionPreference = 'Continue'
try { 'defender: ' + (Get-MpComputerStatus | Select-Object AMRunningMode, RealTimeProtectionEnabled, OnAccessProtectionEnabled, IoavProtectionEnabled, BehaviorMonitorEnabled | ConvertTo-Json -Compress) } catch { 'defender: ' + $_ }
try { 'defender exclusions: ' + ((Get-MpPreference).ExclusionPath -join '; ') } catch { 'defender exclusions: ' + $_ }
try { 'disk: ' + (((Get-Counter '\PhysicalDisk(*)\Current Disk Queue Length', '\PhysicalDisk(*)\Avg. Disk sec/Write').CounterSamples | ForEach-Object { '{0}={1:N3}' -f $_.Path, $_.CookedValue }) -join '; ') } catch { 'disk: ' + $_ }
'defender events, last 10 min:'
try { Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; StartTime = (Get-Date).AddMinutes(-10) } -MaxEvents 20 -ErrorAction Stop | ForEach-Object { '  {0:HH:mm:ss} {1} {2}' -f $_.TimeCreated, $_.Id, ($_.Message -split "`n")[0].Trim() } } catch { '  ' + $_ }
"""

JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x0008
JOB_OBJECT_LIMIT_JOB_MEMORY = 0x0200
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
# A spawn or allocation past these fails inside the job, with a traceback
# that names the test, instead of taking the runner down.
MAX_PROCESSES = 48
MAX_JOB_MEMORY = 4 * 1024 ** 3
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
JobObjectBasicProcessIdList = 3
JobObjectExtendedLimitInformation = 9


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
    )]


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
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


def _pid_list_struct(capacity: int):
    class _JOBOBJECT_BASIC_PROCESS_ID_LIST(ctypes.Structure):
        _fields_ = [
            ("NumberOfAssignedProcesses", wintypes.DWORD),
            ("NumberOfProcessIdsInList", wintypes.DWORD),
            ("ProcessIdList", ctypes.c_size_t * capacity),
        ]

    return _JOBOBJECT_BASIC_PROCESS_ID_LIST()


def _kernel32():
    k = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    k.CreateJobObjectW.restype = wintypes.HANDLE
    k.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k.SetInformationJobObject.restype = wintypes.BOOL
    k.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
    k.QueryInformationJobObject.restype = wintypes.BOOL
    k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k.AssignProcessToJobObject.restype = wintypes.BOOL
    k.GetCurrentProcess.argtypes = []
    k.GetCurrentProcess.restype = wintypes.HANDLE
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    k.CloseHandle.restype = wintypes.BOOL
    return k


def _join_job():
    """Put this process in a fresh kill-on-close job; return (kernel32, job) or None."""
    k32 = _kernel32()
    job = k32.CreateJobObjectW(None, None)
    if not job:
        print(f"--- job object: CreateJobObjectW failed ({ctypes.get_last_error()})")
        return None
    info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY
    info.BasicLimitInformation.ActiveProcessLimit = MAX_PROCESSES
    info.JobMemoryLimit = MAX_JOB_MEMORY
    if not k32.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)):
        print(f"--- job object: SetInformationJobObject failed ({ctypes.get_last_error()})")
        if not k32.CloseHandle(job):
            print(f"--- job object: CloseHandle failed ({ctypes.get_last_error()})")
        return None
    if not k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()):
        # Nested jobs need Windows 8+; the runner has that, but say so if not.
        print(f"--- job object: AssignProcessToJobObject failed ({ctypes.get_last_error()})")
        if not k32.CloseHandle(job):
            print(f"--- job object: CloseHandle failed ({ctypes.get_last_error()})")
        return None
    print(f"--- job object: joined, kill-on-close, max {MAX_PROCESSES} processes, {MAX_JOB_MEMORY >> 30} GiB")
    return k32, job


def _job_pids(job) -> list[int]:
    k32, handle = job
    info = _pid_list_struct(256)
    k32.QueryInformationJobObject(handle, JobObjectBasicProcessIdList, ctypes.byref(info), ctypes.sizeof(info), None)
    return [int(pid) for pid in info.ProcessIdList[: info.NumberOfProcessIdsInList]]


def _runner_procs() -> str:
    """The runner agent and the poll step's shell, by name."""
    found = []
    for proc in psutil.process_iter(["name"]):
        name = proc.info.get("name") or ""
        if name.lower().startswith(("runner.", "pwsh", "powershell")):
            found.append(f"{name}({proc.pid})")
    return ", ".join(sorted(found)) or "(none)"


def _describe(pids: list[int]) -> str:
    names = []
    for pid in pids:
        if pid == os.getpid():
            continue
        try:
            proc = psutil.Process(pid)
            name = proc.name()
            # The venv's python.exe is a launcher that runs the real
            # interpreter as its child, so pytest shows up twice; the command
            # line tail tells a test's own child from those.
            tail = " ".join(proc.cmdline()[-2:])[-80:] if name.lower().startswith("python") else ""
            names.append(f"{name}({pid}{': ' + tail if tail else ''})")
        except psutil.Error:
            names.append(f"?({pid})")
    return ", ".join(names) or "(none)"


def _progress() -> str:
    try:
        with open(LOG, encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError:
        return "0 results"
    done = sum(1 for line in lines if RESULT_RE.search(line))
    last = next((line.strip()[:140] for line in reversed(lines) if "::" in line), "")
    return f"{done} results; last: {last}"


def _stall_diagnostics(job) -> str:
    """What the host is doing while a test is stuck: the job's processes with
    their handle and thread counts, Defender's CPU and state, the disk queue."""
    rows = []
    for pid in _job_pids(job):
        if pid == os.getpid():
            continue
        try:
            proc = psutil.Process(pid)
            rows.append(f"    {proc.name()}({pid}) handles={proc.num_handles()} threads={proc.num_threads()}")
        except psutil.Error:
            rows.append(f"    ?({pid})")
    for proc in psutil.process_iter(["name"]):
        if (proc.info.get("name") or "").lower() == "msmpeng.exe":
            try:
                rows.append(f"    MsMpEng.exe({proc.pid}) cpu {proc.cpu_percent(interval=1.0)}%")
            except psutil.Error:
                pass
    try:
        probe = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", _HOST_PROBE],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace",
            timeout=60, creationflags=CREATE_NO_WINDOW,
        )
        rows.extend("    " + line for line in (probe.stdout + probe.stderr).splitlines() if line.strip())
    except (OSError, subprocess.TimeoutExpired) as exc:
        rows.append(f"    host probe failed: {type(exc).__name__}")
    return "\n".join(rows)


def _timeout_dumps(lines: list[str]) -> list[str]:
    """Every pytest-timeout dump in full: the marker opens on the test's own
    line and closes on a line of its own. The last 200 lines cut them short
    and left out the very threads that were stuck."""
    out, inside = [], False
    for line in lines:
        if TIMEOUT_RE.search(line):
            out.append(line)
            inside = not inside
        elif inside:
            out.append(line)
    return out


def _detach() -> int:
    """Start the real run with a log file as its only inherited handle."""
    for stale in (WRAPPER_LOG, DONE, LOG):
        try:
            os.remove(stale)
        except OSError:
            pass
    runner = _spawn_detached("--run", WRAPPER_LOG, *_pytest_args())
    print(f"--- detached runner pid {runner.pid}; log in {WRAPPER_LOG}, marker {DONE}")
    return 0


def _spawn_detached(mode: str, log_path: str, *extra: str) -> subprocess.Popen:
    args = [sys.executable, os.path.abspath(__file__), mode, *extra]
    flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    with open(log_path, "wb") as log:
        try:
            return subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, close_fds=True, creationflags=flags | CREATE_BREAKAWAY_FROM_JOB)
        except OSError as exc:
            # The runner may hold the step in a job that forbids breakaway.
            print(f"--- breakaway refused ({exc}); detaching inside the runner's job")
            return subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, close_fds=True, creationflags=flags)




def _pytest_args() -> list[str]:
    """Forward suite selection and reports through both detached processes."""
    args = []
    for option in ("--shard", "--junitxml", "--collection-report"):
        if option in sys.argv:
            args.extend([option, sys.argv[sys.argv.index(option) + 1]])
    return args


def main() -> int:
    if "--detach" in sys.argv:
        return _detach()
    # stdout is a file: line-buffer it so the poller sees progress as it
    # happens, and never let one non-cp1252 byte from a test crash the report.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    try:
        job = _join_job()
    except Exception as exc:  # noqa: BLE001
        print(f"--- job object setup raised {type(exc).__name__}: {exc}", flush=True)
        job = None
    if job is None:
        # This is a required CI isolation boundary. Emit a verdict now so the
        # workflow fails promptly instead of waiting for its outer timeout.
        print("--- pytest not started: required Job Object unavailable", flush=True)
        with open(DONE, "w", encoding="ascii") as marker:
            marker.write("1")
        return 1
    args = [
        sys.executable, "-X", "faulthandler", "-m", "pytest", "backend/tests", "-v",
        "-p", "no:cacheprovider", "--timeout=90", "--timeout-method=thread",
        "-o", "faulthandler_timeout=120", "--durations=30", *_pytest_args(),
    ]
    with open(LOG, "wb") as log:
        # close_fds restricts the child's handle list to exactly these three.
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, close_fds=True)
    print(f"--- pytest pid {child.pid}, cap {CAP_SECONDS}s, {' '.join(_pytest_args()) or 'no shard'}", flush=True)

    started = time.monotonic()
    next_report = started + REPORT_EVERY
    progress, progress_since, captured = "", started, ""
    rc: int | None = None
    while time.monotonic() - started < CAP_SECONDS:
        rc = child.poll()
        if rc is not None:
            break
        time.sleep(POLL_EVERY)
        now = time.monotonic()
        current = _progress()
        if current != progress:
            progress, progress_since = current, now
        elif now - progress_since >= STALL_SECONDS and captured != progress:
            # Once per stuck test, while it is still stuck.
            captured = progress
            print(f"--- stalled {int(now - progress_since)}s at: {progress}\n{_stall_diagnostics(job)}", flush=True)
        if now < next_report:
            continue
        next_report += REPORT_EVERY
        elapsed = int(now - started)
        peers = _describe(_job_pids(job))
        vm = psutil.virtual_memory()
        print(f"--- {elapsed}s: {_progress()}\n    in job: {peers}\n    vm: {vm.percent}% of {vm.total >> 20} MiB used, cpu {psutil.cpu_percent()}%, {len(psutil.pids())} processes\n    runner: {_runner_procs()}", flush=True)
    if rc is None:
        # The loop leaves at the cap after a sleep, without polling: pytest
        # may have ended during that last interval, and its exit decides.
        rc = child.poll()

    survivors = [pid for pid in _job_pids(job) if pid != os.getpid()]
    print(f"--- pytest exit: {rc if rc is not None else 'still running at cap'}")
    print(f"--- still in job: {_describe(survivors)}")
    for pid in survivors:
        try:
            psutil.Process(pid).kill()
        except psutil.Error:
            pass

    with open(LOG, encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()
    dumps = _timeout_dumps(lines)
    if dumps:
        print("--- timeout dumps, in full:")
        sys.stdout.write("".join(dumps))
    print("--- last 200 lines of pytest.log:")
    sys.stdout.write("".join(lines[-200:]))
    print("--- summary:")
    for line in lines:
        if line.startswith(("FAILED ", "ERROR ")) or re.match(r"=+ .*(passed|failed|error).* =+", line):
            sys.stdout.write(line)
    sys.stdout.flush()
    rc = 1 if rc is None else rc
    with open(DONE, "w") as marker:
        marker.write(str(rc))
    return rc


if __name__ == "__main__":
    sys.exit(main())
