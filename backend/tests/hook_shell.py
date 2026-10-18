"""Run an installed hook command the way the CLI that reads it would.

A hook's `command` is a program for a shell, and which shell is not the test's
choice: the installer writes the text and declares the shell in the same entry
(`osplat.scripts.hook_entry`) — POSIX sh on a POSIX box, PowerShell on Windows.
Both read the event JSON on stdin and answer on stdout, stderr and the exit
code, so one argv builder serves both and the tests stay about the guarantee
rather than about the spelling.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

import pytest


def _bash() -> str | None:
    """Git for Windows' bash first: a bare `which("bash")` can land on the WSL
    stub in System32, which has no distribution to run anything with."""
    git = shutil.which("git")
    if git is not None:
        candidate = Path(git).resolve().parent.parent / "bin" / "bash.exe"
        if candidate.is_file():
            return str(candidate)
    return shutil.which("bash")


def shell_argv(entry: dict) -> list[str]:
    """The interpreter for one hook entry, skipping when it is not installed.

    `-Command` and not `-File`, because that is the shape Claude Code runs a
    PowerShell hook with: the text, not a script on disk. `-NoProfile` keeps a
    developer's profile out of the run and `-NonInteractive` makes a prompt an
    error rather than a hang.
    """
    command = entry["command"]
    if entry.get("shell") == "powershell":
        exe = shutil.which("powershell.exe") or shutil.which("pwsh")
        if exe is None:
            pytest.skip("the hook command is PowerShell and no PowerShell is on PATH")
        return [exe, "-NoProfile", "-NonInteractive", "-Command", command]
    bash = _bash()
    if bash is None:
        pytest.skip("the hook command is a POSIX sh script and no bash is on PATH")
    return [bash, "-c", command]



_cold_start_s: dict[str, float] = {}


def cold_start_s(argv: list[str]) -> float:
    """Seconds the interpreter in `argv` takes to start and exit doing nothing.

    Measured once per interpreter per session. PowerShell 5.1 starts in under
    a second on the x64 runner and on a Windows 11 arm64 machine, but in about
    24 s on the windows-11-arm runner (Defender stays on there: tamper
    protection stops the image build from disabling it), and a hook test whose
    whole run is one cold start cannot hold a fixed wall-clock budget across
    both.
    """
    exe = argv[0]
    if exe not in _cold_start_s:
        started = time.perf_counter()
        subprocess.run([*argv[:-1], "exit 0"], stdin=subprocess.DEVNULL, capture_output=True, timeout=300)
        _cold_start_s[exe] = time.perf_counter() - started
    return _cold_start_s[exe]


def warm(argv: list[str], attempt_s: float, attempts: int = 2) -> None:
    """Start the interpreter in `argv` doing nothing, and record that as its
    cold start (`cold_start_s`), before any hook test needs it.

    A start that has not exited after `attempt_s` is killed and started again.
    On the Windows x64 runner `powershell.exe -Command "exit 0"` once
    stayed up for over two minutes, though the same shard had started it fine
    seconds before; `cold_start_s` waited for it (300 s) inside one test's
    120 s pytest-timeout. A start that hangs every time still fails here.
    """
    exe = argv[0]
    for attempt in range(1, attempts + 1):
        if exe in _cold_start_s:
            return
        started = time.perf_counter()
        try:
            subprocess.run([*argv[:-1], "exit 0"], stdin=subprocess.DEVNULL, capture_output=True, timeout=attempt_s)
        except subprocess.TimeoutExpired:
            if attempt == attempts:
                raise
            continue
        _cold_start_s[exe] = time.perf_counter() - started


def warm_powershell(attempt_s: float) -> None:
    """`warm` for the PowerShell `shell_argv` picks, when there is one."""
    exe = shutil.which("powershell.exe") or shutil.which("pwsh")
    if exe is not None:
        warm([exe, "-NoProfile", "-NonInteractive", "-Command", "exit 0"], attempt_s)


def hang_ceiling(argv: list[str], budget_s: float) -> float:
    """A hang detector for one hook run: `budget_s` for the hook's own work,
    plus room for the interpreter to cold-start a few times over. Not an
    expected duration — the assertions are on the output and the exit code."""
    return budget_s + 3 * cold_start_s(argv)
