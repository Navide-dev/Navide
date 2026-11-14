"""POSIX process identity must survive a wall-clock step.

Linux `ps -o lstart=` is computed as "now - uptime + start jiffies", so a
clock correction (VMware tools after a VM restore, an NTP step, wake from
sleep) moves the same process's lstart by a second or more. The backend's
parent watch read that as "the parent was replaced" and shut itself down.
`identity()` now reads /proc/<pid>/stat field 22 (ticks since boot) first.
"""

from __future__ import annotations

import io
import os
from pathlib import Path

import pytest

from agent_team_backend.osplat import _posix


def _stat_line(pid: int, comm: str, starttime: int) -> str:
    # Fields 3..52 after "(comm)"; field 22 (starttime) is index 19 of them.
    rest = ["S", "1", str(pid), str(pid)] + ["0"] * 15 + [str(starttime)] + ["0"] * 30
    return f"{pid} ({comm}) " + " ".join(rest) + "\n"


def _fake_proc(monkeypatch, contents: dict[int, str]) -> None:
    def fake_open(path, mode="r", *a, **k):
        prefix = "/proc/"
        if path.startswith(prefix) and path.endswith("/stat"):
            pid = int(path[len(prefix) : -len("/stat")])
            if pid in contents:
                return io.BytesIO(contents[pid].encode())
        raise FileNotFoundError(path)

    monkeypatch.setattr(_posix, "open", fake_open, raising=False)


@pytest.mark.parametrize(
    "comm",
    ["python3", "my prog", "a) b (c", "x)) 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20"],
)
def test_proc_starttime_counts_fields_from_the_last_paren(monkeypatch, comm):
    _fake_proc(monkeypatch, {4242: _stat_line(4242, comm, 987654)})
    assert _posix._proc_starttime(4242) == "987654"


def test_proc_starttime_empty_without_proc(monkeypatch):
    _fake_proc(monkeypatch, {})
    assert _posix._proc_starttime(4242) == ""


def test_proc_starttime_empty_on_truncated_stat(monkeypatch):
    _fake_proc(monkeypatch, {4242: "4242 (sh) S 1 2 3\n"})
    assert _posix._proc_starttime(4242) == ""


def test_identity_ignores_an_lstart_jump_when_proc_starttime_is_unchanged(monkeypatch):
    lstarts = iter(["Sun Nov  8 22:17:21 2026", "Sun Nov  8 22:17:22 2026"])
    monkeypatch.setattr(_posix, "_ps", lambda pid, fields: next(lstarts))
    _fake_proc(monkeypatch, {2634: _stat_line(2634, "navide main", 123456)})
    tree = _posix.PosixProcessTree()
    before = tree.identity(2634)
    after = tree.identity(2634)
    assert before == after != ""


def test_identity_changes_when_proc_starttime_changes(monkeypatch):
    # A recycled pid has a different starttime and must still read as a new process.
    monkeypatch.setattr(_posix, "_ps", lambda pid, fields: "Sun Nov  8 22:17:21 2026")
    tree = _posix.PosixProcessTree()
    _fake_proc(monkeypatch, {2634: _stat_line(2634, "a", 100)})
    first = tree.identity(2634)
    _fake_proc(monkeypatch, {2634: _stat_line(2634, "b", 200)})
    assert tree.identity(2634) != first


def test_identity_falls_back_to_lstart_without_proc(monkeypatch):
    # macOS (no /proc) keeps the lstart identity unchanged.
    _fake_proc(monkeypatch, {})
    monkeypatch.setattr(_posix, "_ps", lambda pid, fields: "Sun Nov  8 22:17:21 2026")
    assert _posix.PosixProcessTree().identity(2634) == "2634:Sun Nov  8 22:17:21 2026"


def test_identity_empty_when_nothing_is_readable(monkeypatch):
    _fake_proc(monkeypatch, {})
    monkeypatch.setattr(_posix, "_ps", lambda pid, fields: None)
    assert _posix.PosixProcessTree().identity(2634) == ""


@pytest.mark.skipif(not Path("/proc/self/stat").exists(), reason="needs Linux /proc")
def test_real_proc_identity_is_stable_for_this_process():
    tree = _posix.PosixProcessTree()
    first = tree.identity(os.getpid())
    assert ":ticks:" in first
    assert tree.identity(os.getpid()) == first
