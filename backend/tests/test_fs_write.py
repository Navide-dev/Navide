"""The workspace write path lives in a standard-library-only module.

fs_service re-exports it unchanged, and a separately packaged plugin backend
bundles it; these tests pin both halves of that arrangement and the one write
property no other test pinned: a single-call write replaces the file by rename.
"""

from __future__ import annotations

import base64
import errno
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

from agent_team_backend import fs_service, fs_write

BACKEND_ROOT = Path(__file__).resolve().parents[1]
MOVED = (
    "_ENC_DISPLAY", "_ENC_FROM_LABEL", "_STAGING_MAX_AGE_S", "_STAGING_NAME_RE", "_UPLOAD_ID_RE",
    "_WRITE_PART_MAX_BYTES", "_WRITE_SIZE_LIMIT", "_resolve_mutation_safe", "_staging_path",
    "_sweep_stale_staging", "write_abort", "write_commit", "write_file", "write_part",
)


def test_fs_service_reexports_the_write_path_unchanged() -> None:
    for name in MOVED:
        assert getattr(fs_service, name) is getattr(fs_write, name), name


def test_the_write_path_imports_only_the_standard_library() -> None:
    # Only what importing fs_write adds counts: site hooks may load
    # third-party modules before any code runs (pywin32's .pth does on
    # Windows), and those are not the write path's imports.
    probe = (
        "import sys\n"
        "before = set(sys.modules)\n"
        "import agent_team_backend.fs_write\n"
        "added = set(sys.modules) - before\n"
        "loaded = sorted(m for m in sys.modules if m.startswith('agent_team_backend'))\n"
        "third = sorted({m.split('.')[0] for m in added} - set(sys.stdlib_module_names)\n"
        "               - set(sys.builtin_module_names) - {'agent_team_backend'})\n"
        "print(loaded); print(third)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], cwd=BACKEND_ROOT, capture_output=True, text=True, check=True,
    )
    loaded, third = result.stdout.splitlines()
    assert loaded == str([
        "agent_team_backend", "agent_team_backend.fs_write",
        "agent_team_backend.git_security", "agent_team_backend.path_guard",
    ])
    assert third == "[]"


def test_a_single_call_write_replaces_the_file_by_rename(tmp_path: Path) -> None:
    target = tmp_path / "doc.html"
    target.write_text("old", encoding="utf-8")
    before = target.stat()

    result = fs_service.write_file(str(tmp_path), "doc.html", "new", expected_mtime=before.st_mtime)

    assert result["ok"] is True
    assert target.read_text(encoding="utf-8") == "new"
    assert target.stat().st_ino != before.st_ino
    assert sorted(path.name for path in tmp_path.iterdir()) == ["doc.html"]


# ── concurrent writers ───────────────────────────────────────────────────────
#
# Every writer reads the same mtime and then writes with it as expected_mtime:
# exactly one may land, every other one must be told "conflict", and the
# winner must be told it won. os.replace is slowed down so that, without a
# lock, every writer passes the mtime check before any of them renames.

_SLOW_REPLACE_S = 0.3

_CHILD_WRITER = """
import json, os, sys, time
from agent_team_backend import fs_write

root, expected, call = sys.argv[1], float(sys.argv[2]), sys.argv[4]
# The content comes from a file: at ~180 KB it is over Linux's per-argument
# limit and Windows' whole command-line limit.
with open(sys.argv[3], encoding="utf-8") as f:
    content = f.read()
real_replace = os.replace
def slow_replace(src, dst):
    time.sleep(float(sys.argv[5]))
    real_replace(src, dst)
os.replace = slow_replace
upload_id = os.urandom(16).hex()
if call == "commit":
    data = content.encode()
    staged = fs_write.write_part(root, "doc.html", upload_id, 0, __import__("base64").b64encode(data).decode())
    assert staged["ok"], staged
print("ready", flush=True)
sys.stdin.readline()
if call == "commit":
    result = fs_write.write_commit(root, "doc.html", upload_id, len(content.encode()), expected)
else:
    result = fs_write.write_file(root, "doc.html", content, expected_mtime=expected)
print(json.dumps(result), flush=True)
"""


def _assert_exactly_one_writer_won(
    root: Path, results: list[dict], contents: list[str], before_mtime: float
) -> None:
    winners = [i for i, result in enumerate(results) if result.get("ok") is True]
    assert len(winners) == 1, results
    for i, result in enumerate(results):
        if i != winners[0]:
            assert result.get("conflict") is True, result
    assert (root / "doc.html").read_text(encoding="utf-8") == contents[winners[0]]
    assert results[winners[0]]["mtime"] == (root / "doc.html").stat().st_mtime
    assert results[winners[0]]["mtime"] != before_mtime
    assert sorted(path.name for path in root.iterdir()) == ["doc.html"]


def _race_in_processes(root: Path, call: str, writers: int = 4) -> None:
    target = root / "doc.html"
    target.write_text("old", encoding="utf-8")
    before = target.stat().st_mtime
    contents = [f"writer {i} " * 20_000 for i in range(writers)]
    # Outside root, which must end up holding doc.html alone.
    content_dir = Path(tempfile.mkdtemp())
    content_files = []
    for i, content in enumerate(contents):
        content_file = content_dir / f"content-{i}.txt"
        content_file.write_text(content, encoding="utf-8")
        content_files.append(content_file)
    children = [
        subprocess.Popen(
            [sys.executable, "-c", _CHILD_WRITER, str(root), repr(before), str(content_file), call,
             str(_SLOW_REPLACE_S)],
            cwd=BACKEND_ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        for content_file in content_files
    ]
    try:
        for child in children:
            assert child.stdout.readline().strip() == "ready"
        for child in children:
            child.stdin.write("go\n")
            child.stdin.flush()
        results = [json.loads(child.stdout.readline()) for child in children]
    finally:
        for child in children:
            child.stdin.close()
            child.wait(timeout=30)
            child.stdout.close()
        shutil.rmtree(content_dir, ignore_errors=True)
    _assert_exactly_one_writer_won(root, results, contents, before)


def test_concurrent_writes_from_separate_processes_land_exactly_once(tmp_path: Path) -> None:
    _race_in_processes(tmp_path, "write")


def test_concurrent_chunked_commits_from_separate_processes_land_exactly_once(tmp_path: Path) -> None:
    _race_in_processes(tmp_path, "commit")


def test_concurrent_writes_from_threads_land_exactly_once(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "doc.html"
    target.write_text("old", encoding="utf-8")
    before = target.stat().st_mtime
    real_replace = os.replace

    def slow_replace(src, dst):
        time.sleep(_SLOW_REPLACE_S)
        real_replace(src, dst)

    monkeypatch.setattr(os, "replace", slow_replace)
    contents = [f"thread {i} " * 20_000 for i in range(4)]
    results: list[dict] = [{} for _ in contents]
    start = threading.Barrier(len(contents))

    def write(i: int) -> None:
        start.wait()
        results[i] = fs_write.write_file(str(tmp_path), "doc.html", contents[i], expected_mtime=before)

    threads = [threading.Thread(target=write, args=(i,)) for i in range(len(contents))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    _assert_exactly_one_writer_won(tmp_path, results, contents, before)


def _coarse_clock(monkeypatch, target: Path) -> None:
    """Every replacement lands with the mtime of the file it replaced, as on
    a filesystem whose clock has not ticked since (Windows updates file times
    in ~15.6 ms steps; a write in the same step as the last one reads back
    the same mtime)."""
    real_replace = os.replace

    def same_tick_replace(src, dst):
        old = Path(dst).stat().st_mtime_ns if Path(dst).exists() else None
        real_replace(src, dst)
        if old is not None and Path(dst) == target:
            os.utime(dst, ns=(old, old))

    monkeypatch.setattr(os, "replace", same_tick_replace)


def test_a_write_in_the_same_clock_tick_still_moves_the_mtime(tmp_path: Path, monkeypatch) -> None:
    # The mtime is the whole conflict check: a second writer holding the
    # first one's starting mtime must be refused even when the first write
    # finished before the clock ticked (the lost update the Windows arm64
    # release gate caught: both of two racing writers reported ok).
    target = tmp_path / "doc.html"
    target.write_text("old", encoding="utf-8")
    before = target.stat().st_mtime
    _coarse_clock(monkeypatch, target)

    first = fs_write.write_file(str(tmp_path), "doc.html", "first", expected_mtime=before)
    second = fs_write.write_file(str(tmp_path), "doc.html", "second", expected_mtime=before)

    assert first["ok"] is True
    assert first["mtime"] != before
    assert first["mtime"] == target.stat().st_mtime
    assert second.get("conflict") is True, second
    assert target.read_text(encoding="utf-8") == "first"
    # The new mtime is still a token the next writer can use.
    third = fs_write.write_file(str(tmp_path), "doc.html", "third", expected_mtime=first["mtime"])
    assert third["ok"] is True, third


def test_a_commit_in_the_same_clock_tick_still_moves_the_mtime(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "doc.html"
    target.write_text("old", encoding="utf-8")
    before = target.stat().st_mtime
    _coarse_clock(monkeypatch, target)

    assert _part(tmp_path, 0, b"first")["ok"] is True
    first = fs_write.write_commit(str(tmp_path), "doc.html", _UPLOAD_ID, 5, before)
    second = fs_write.write_file(str(tmp_path), "doc.html", "second", expected_mtime=before)

    assert first["ok"] is True, first
    assert first["mtime"] != before
    assert first["mtime"] == target.stat().st_mtime
    assert second.get("conflict") is True, second
    assert target.read_text(encoding="utf-8") == "first"


def test_a_write_leaves_a_sibling_named_like_its_old_temp_file_alone(tmp_path: Path) -> None:
    (tmp_path / "doc.html").write_text("old", encoding="utf-8")
    (tmp_path / "doc.html.tmp").write_text("the user's own file", encoding="utf-8")

    result = fs_write.write_file(str(tmp_path), "doc.html", "new")

    assert result["ok"] is True
    assert (tmp_path / "doc.html").read_text(encoding="utf-8") == "new"
    assert (tmp_path / "doc.html.tmp").read_text(encoding="utf-8") == "the user's own file"


@pytest.mark.skipif(sys.platform == "win32", reason="Windows cannot remove a lock file another handle has open")
def test_a_writer_woken_on_a_removed_lock_file_waits_for_the_current_one(
    tmp_path: Path, monkeypatch
) -> None:
    # The previous holder removed the lock file this writer was waiting on, and
    # a newcomer already holds the new one: entering now would let two in.
    lock_path = tmp_path / ".doc.html.lock"
    real_lock = fs_write._lock_fd
    rival: list[int] = []

    def lock_then_find_the_file_replaced(fd: int, deadline: float) -> None:
        real_lock(fd, deadline)
        if not rival:
            os.unlink(lock_path)
            rival.append(os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600))
            real_lock(rival[0], deadline)

            def release_rival() -> None:
                fs_write._unlock_fd(rival[0])
                os.close(rival[0])

            threading.Timer(_SLOW_REPLACE_S, release_rival).start()

    monkeypatch.setattr(fs_write, "_lock_fd", lock_then_find_the_file_replaced)
    started = time.monotonic()
    with fs_write._target_lock(tmp_path / "doc.html"):
        waited = time.monotonic() - started
    assert waited >= _SLOW_REPLACE_S
    assert not lock_path.exists()



@pytest.mark.skipif(sys.platform == "win32", reason="Windows cannot remove a lock file that is still open")
def test_the_lock_file_is_removed_before_its_lock_is_released(tmp_path: Path, monkeypatch) -> None:
    # Removing it only after the release would let a waiter that wakes up on
    # it enter while a newcomer takes a fresh lock file: two writers at once.
    lock_path = tmp_path / ".doc.html.lock"
    present_at_close: list[bool] = []
    real_close = os.close

    def close(fd: int) -> None:
        present_at_close.append(lock_path.exists())
        real_close(fd)

    with fs_write._target_lock(tmp_path / "doc.html"):
        monkeypatch.setattr(os, "close", close)
    monkeypatch.undo()

    assert present_at_close == [False]


def test_a_write_fails_instead_of_hanging_while_another_process_holds_the_lock(
    tmp_path: Path, monkeypatch
) -> None:
    (tmp_path / "doc.html").write_text("old", encoding="utf-8")
    monkeypatch.setattr(fs_write, "_LOCK_TIMEOUT_S", _SLOW_REPLACE_S)
    holder = subprocess.Popen(
        [sys.executable, "-c", _CHILD_LOCK_HOLDER, str(tmp_path / ".doc.html.lock")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    try:
        assert holder.stdout.readline().strip() == "locked"
        started = time.monotonic()
        result = fs_write.write_file(str(tmp_path), "doc.html", "new")
        waited = time.monotonic() - started
    finally:
        holder.stdin.close()
        holder.wait(timeout=30)
        holder.stdout.close()

    assert result["ok"] is False
    assert "another process" in result["error"]
    assert _SLOW_REPLACE_S <= waited < 5
    assert (tmp_path / "doc.html").read_text(encoding="utf-8") == "old"


_CHILD_LOCK_HOLDER = """
import os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o600)
if os.name == "nt":
    import msvcrt
    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
else:
    import fcntl
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
print("locked", flush=True)
sys.stdin.readline()
"""


# ── chunked-write part errors ────────────────────────────────────────────────

_UPLOAD_ID = "0123456789abcdef0123456789abcdef"


def _part(root: Path, offset: int, data: bytes) -> dict:
    return fs_write.write_part(str(root), "doc.html", _UPLOAD_ID, offset, base64.b64encode(data).decode())


def test_a_later_part_of_a_missing_upload_says_the_upload_is_gone(tmp_path: Path) -> None:
    result = _part(tmp_path, 5, b"later")

    assert result["ok"] is False
    assert "out of order" not in result["error"]
    assert "no such upload" in result["error"]


def test_a_later_part_that_cannot_open_the_upload_reports_why(tmp_path: Path, monkeypatch) -> None:
    assert _part(tmp_path, 0, b"first")["ok"] is True
    real_open = os.open

    def refuse(path, flags, *args, **kwargs):
        if str(path).endswith(".upload"):
            raise PermissionError(errno.EACCES, "Permission denied", str(path))
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", refuse)
    result = _part(tmp_path, 5, b"later")

    assert result["ok"] is False
    assert "out of order" not in result["error"]
    assert "Permission denied" in result["error"]


def test_the_part_after_a_failed_write_says_the_upload_is_gone(tmp_path: Path, monkeypatch) -> None:
    assert _part(tmp_path, 0, b"first")["ok"] is True
    real_fdopen = os.fdopen

    class DiskFull:
        def __init__(self, handle):
            self.handle = handle

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return self.handle.__exit__(*exc)

        def fileno(self):
            return self.handle.fileno()

        def write(self, data):
            raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(os, "fdopen", lambda fd, mode: DiskFull(real_fdopen(fd, mode)))
    failed = _part(tmp_path, 5, b"second")
    monkeypatch.undo()
    after = _part(tmp_path, 5, b"second")

    assert failed["ok"] is False
    assert "No space left on device" in failed["error"]
    assert after["ok"] is False
    assert "out of order" not in after["error"]
    assert "no such upload" in after["error"]


def test_a_part_at_the_wrong_offset_is_still_out_of_order(tmp_path: Path) -> None:
    assert _part(tmp_path, 0, b"first")["ok"] is True

    result = _part(tmp_path, 3, b"later")

    assert result == {"ok": False, "error": "upload part out of order"}
    assert _part(tmp_path, 5, b"later")["ok"] is True


# ── leftovers of a writer that died mid-write ────────────────────────────────
#
# A write's temp file has a unique name, so a writer killed between writing
# it and renaming it leaves one behind that no later write overwrites. The
# next write to the same file, holding its lock, removes them: no live writer
# of that file can have one in flight. The lock file of a dead holder goes the
# same way, as the next writer releases it.


def test_a_write_removes_temp_files_left_by_a_dead_writer_of_that_file(tmp_path: Path) -> None:
    (tmp_path / "doc.html").write_text("old", encoding="utf-8")
    (tmp_path / f"doc.html.{'a' * 32}.tmp").write_text("half", encoding="utf-8")
    (tmp_path / ".doc.html.lock").write_text("", encoding="utf-8")
    other = tmp_path / f"other.html.{'b' * 32}.tmp"  # another file's: not this write's to judge
    other.write_text("half", encoding="utf-8")

    result = fs_service.write_file(str(tmp_path), "doc.html", "new")

    assert result["ok"] is True
    assert sorted(path.name for path in tmp_path.iterdir()) == ["doc.html", other.name]


def test_a_chunked_commit_removes_temp_files_left_by_a_dead_writer(tmp_path: Path) -> None:
    (tmp_path / f"doc.html.{'c' * 32}.tmp").write_text("half", encoding="utf-8")
    data = base64.b64encode(b"new").decode()
    assert fs_write.write_part(str(tmp_path), "doc.html", "d" * 32, 0, data)["ok"] is True

    result = fs_write.write_commit(str(tmp_path), "doc.html", "d" * 32, 3)

    assert result["ok"] is True
    assert sorted(path.name for path in tmp_path.iterdir()) == ["doc.html"]
