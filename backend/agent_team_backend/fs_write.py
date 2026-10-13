"""Workspace file writes shared by the core backend and plugin backends.

Atomic single-call writes and chunked (staged) writes under a workspace root,
behind the mutation guard (the workspace path guard plus Git's internal
directory). Standard library only, so a separately packaged plugin backend can
bundle it without pulling in ``fs_service``'s third-party dependencies.
"""

from __future__ import annotations

import base64
import errno
import os
import re
import stat as stat_mod
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .git_security import is_git_internal_path
from .path_guard import FsError, _resolve_safe


# Normalise encoding name for display (match VS Code labels).
_ENC_DISPLAY: dict[str, str] = {
    "utf_8": "UTF-8", "utf_8_sig": "UTF-8 with BOM",
    "utf_16": "UTF-16", "utf_16_le": "UTF-16 LE", "utf_16_be": "UTF-16 BE",
    "latin_1": "Latin-1", "latin-1": "Latin-1",
    "cp1252": "Windows 1252", "cp1251": "Windows 1251",
    "gb2312": "GB2312", "gbk": "GBK", "big5": "Big5",
    "shift_jis": "Shift JIS", "euc_jp": "EUC-JP", "euc_kr": "EUC-KR",
}
# Reverse map so write_file also accepts the display labels read_file returns.
_ENC_FROM_LABEL: dict[str, str] = {v: k for k, v in _ENC_DISPLAY.items()}


def _resolve_mutation_safe(workspace_path: str, rel_path: str) -> Path:
    """Resolve a path and reject writes to Git's internal directory.

    Host Explorer is allowed to inspect ``.git``. The stronger Git-internal
    guard belongs only on filesystem mutation paths, where changing Git's
    metadata could alter the execution policy or repository state.
    """
    target = _resolve_safe(workspace_path, rel_path)
    root = Path(workspace_path).resolve()
    if is_git_internal_path(root, target):
        raise FsError("the Git internal directory is protected")
    return target


_WRITE_SIZE_LIMIT = 50 * 1024 * 1024  # 50 MB — prevent disk-fill via AI tool


# A writer holds the lock for one check-and-rename. Anything holding it far
# longer (a hung or hostile process) fails the write instead of hanging it.
_LOCK_TIMEOUT_S = 10.0

# Chosen by which lock module exists rather than by asking for the platform:
# flock where fcntl is available, msvcrt.locking (Windows) otherwise.
try:
    import fcntl
except ImportError:
    import msvcrt

    _HAVE_FLOCK = False
else:
    _HAVE_FLOCK = True

# Windows cannot remove a file that is open, so there the lock file is closed
# first and removed after; elsewhere it is removed while still held.
_UNLINK_BEFORE_CLOSE = _HAVE_FLOCK

if not _HAVE_FLOCK:

    def _try_lock_fd(fd: int) -> bool:
        os.lseek(fd, 0, os.SEEK_SET)
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError:
            return False
        return True

    def _unlock_fd(fd: int) -> None:
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
else:

    def _try_lock_fd(fd: int) -> bool:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return True

    def _unlock_fd(fd: int) -> None:
        fcntl.flock(fd, fcntl.LOCK_UN)


def _lock_fd(fd: int, deadline: float) -> None:
    while not _try_lock_fd(fd):
        if time.monotonic() >= deadline:
            raise FsError("the file is being written by another process")
        time.sleep(0.005)


@contextmanager
def _target_lock(target: Path) -> Iterator[None]:
    """Serialise the mtime check and the rename onto ``target``.

    Two processes write the same documents (the Plans view backend and the
    headless one), so an in-process lock is not enough: this is an OS file lock
    on a sibling lock file (not the target, whose inode the rename replaces).
    Each acquisition opens its own descriptor, which also excludes threads of
    one process. The lock file is removed on release; a waiter that wakes up
    holding a lock on a removed (or replaced) lock file retries on the current
    one, so removal never lets two writers in at once.
    """
    lock_path = target.parent / f".{target.name}.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    deadline = time.monotonic() + _LOCK_TIMEOUT_S
    while True:
        fd = os.open(lock_path, flags, 0o600)
        try:
            _lock_fd(fd, deadline)
        except BaseException:
            os.close(fd)
            raise
        try:
            current = os.stat(lock_path)
        except FileNotFoundError:
            current = None
        if current is not None and os.path.samestat(os.fstat(fd), current):
            break
        _unlock_fd(fd)
        os.close(fd)
    try:
        yield
    finally:
        if _UNLINK_BEFORE_CLOSE:
            try:
                os.unlink(lock_path)
            except OSError:
                pass
            os.close(fd)
        else:
            # Once closed, the removal fails harmlessly while another writer
            # has the file open.
            _unlock_fd(fd)
            os.close(fd)
            try:
                os.unlink(lock_path)
            except OSError:
                pass


def _remove_orphan_temps(target: Path) -> None:
    """Remove the temp files earlier writes of ``target`` left behind.

    Called with ``target``'s lock held: every writer of it makes its temp file
    under that lock, so one still there now belongs to a writer that died
    between writing it and renaming it. A failed removal is left for the next
    write."""
    pattern = re.compile(re.escape(target.name) + r"\.[0-9a-f]{32}\.tmp")
    try:
        entries = list(os.scandir(target.parent))
    except OSError:
        return
    for entry in entries:
        if pattern.fullmatch(entry.name):
            try:
                os.unlink(entry.path)
            except OSError:
                pass


#: The conflict checks treat mtimes within 1e-4 s as the same (float st_mtime
#: round-trips through JSON). A replacement must land further away than that.
_MTIME_TOLERANCE_NS = 100_000
#: Steps tried to push a replacement's mtime past the one it replaced: 1 ms,
#: then 1 s and 2 s for filesystems that keep coarser times (HFS+, FAT).
_MTIME_STEPS_NS = (1_000_000, 1_000_000_000, 2_000_000_000)


def _advance_mtime(target: Path, replaced_ns: int) -> None:
    """Make ``target``'s mtime tell it apart from the file it replaced.

    The mtime is the only thing the conflict check compares. A replacement
    written in the same clock tick as the file it replaced (Windows updates
    file times in ~15.6 ms steps) reads back the same mtime, so a second
    writer holding the old one would pass the check and overwrite the first:
    a lost update. Called under the target lock, right after the replace.
    """
    for step_ns in _MTIME_STEPS_NS:
        st = target.stat()
        if st.st_mtime_ns - replaced_ns > _MTIME_TOLERANCE_NS:
            return
        os.utime(target, ns=(st.st_atime_ns, replaced_ns + step_ns))


def write_file(
    workspace_path: str,
    rel_path: str,
    content: str,
    encoding: str = "utf-8",
    expected_mtime: float | None = None,
) -> dict[str, Any]:
    """Overwrite (or create) a text file with `content`.

    ``encoding`` is the codec used to encode ``content`` (read_file's display
    labels, e.g. "UTF-8 with BOM", are accepted too). When ``expected_mtime``
    is given and the file on disk has a different mtime, the write is refused
    with ``conflict=True`` so the caller can surface a conflict dialog.
    Success responses include the file's new ``mtime``.
    """
    try:
        target = _resolve_mutation_safe(workspace_path, rel_path)
        if target == Path(workspace_path).resolve():
            raise FsError("invalid path")
        if target.exists() and target.is_dir():
            raise FsError("path is a directory")
        codec = _ENC_FROM_LABEL.get(encoding, encoding)
        try:
            encoded = content.encode(codec)
        except (LookupError, UnicodeEncodeError) as exc:
            return {"ok": False, "error": f"cannot encode content as {encoding}: {exc}"}
        if len(encoded) > _WRITE_SIZE_LIMIT:
            raise FsError(f"content too large ({len(encoded) // 1024} KB; limit 50 MB)")
        target.parent.mkdir(parents=True, exist_ok=True)
        with _target_lock(target):
            _remove_orphan_temps(target)
            orig_mode: int | None = None
            replaced_ns: int | None = None
            if target.exists():
                st = target.stat()
                orig_mode = st.st_mode
                replaced_ns = st.st_mtime_ns
                if expected_mtime is not None and abs(st.st_mtime - expected_mtime) > 1e-4:
                    return {
                        "ok": False,
                        "conflict": True,
                        "mtime": st.st_mtime,
                        "error": "file changed on disk",
                    }
            # Atomic write: write to a temp file then rename so a crash can't
            # leave the target half-written/truncated. The name is unique per
            # write so no other writer can touch it.
            tmp = target.parent / f"{target.name}.{uuid.uuid4().hex}.tmp"
            try:
                tmp.write_bytes(encoded)
                if orig_mode is not None:
                    # os.replace swaps the inode; keep the original permission
                    # bits (e.g. a script's executable bit) on the replacement.
                    os.chmod(tmp, stat_mod.S_IMODE(orig_mode))
                os.replace(tmp, target)
            except Exception:
                tmp.unlink(missing_ok=True)
                raise
            if replaced_ns is not None:
                _advance_mtime(target, replaced_ns)
            return {"ok": True, "mtime": target.stat().st_mtime}
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}


# ── chunked (multi-part) writes ─────────────────────────────────────────────
#
# write_file takes the whole content in one message, which cannot carry a
# document past one WebSocket / Backend Wire frame. A chunked write stages the
# bytes in a sibling file part by part, then swaps it in with the same atomic
# rename and the same mtime conflict check write_file uses. Only the size of
# one part is bounded; the document is not.

_UPLOAD_ID_RE = re.compile(r"[0-9a-f]{32}")
_WRITE_PART_MAX_BYTES = 1024 * 1024


def _staging_path(workspace_path: str, rel_path: str, upload_id: str) -> tuple[Path, Path]:
    if not isinstance(upload_id, str) or _UPLOAD_ID_RE.fullmatch(upload_id) is None:
        raise FsError("invalid upload id")
    target = _resolve_mutation_safe(workspace_path, rel_path)
    if target == Path(workspace_path).resolve():
        raise FsError("invalid path")
    if target.exists() and target.is_dir():
        raise FsError("path is a directory")
    return target, target.parent / f".{target.name}.{upload_id}.upload"


_STAGING_NAME_RE = re.compile(r"\..+\.[0-9a-f]{32}\.upload")
_STAGING_MAX_AGE_S = 3600


def _sweep_stale_staging(directory: Path) -> None:
    """Remove abandoned chunked-write staging files (older than an hour).

    Only names of the exact staging shape are touched, and never symlinks'
    targets: an upload killed mid-way must not leave litter forever.
    """
    cutoff = time.time() - _STAGING_MAX_AGE_S
    try:
        for entry in directory.iterdir():
            if _STAGING_NAME_RE.fullmatch(entry.name) is None:
                continue
            try:
                if entry.lstat().st_mtime < cutoff:
                    entry.unlink()
            except OSError:
                continue
    except OSError:
        return


def write_part(
    workspace_path: str, rel_path: str, upload_id: str, offset: int, data_base64: str
) -> dict[str, Any]:
    """Append one part to the staging file of a chunked write.

    Parts must arrive in order: ``offset`` is the number of bytes already
    staged (0 starts the upload). Returns the new staged size.
    """
    try:
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise FsError("invalid offset")
        if not isinstance(data_base64, str):
            raise FsError("invalid data")
        try:
            data = base64.b64decode(data_base64, validate=True)
        except ValueError:
            raise FsError("invalid data") from None
        if len(data) > _WRITE_PART_MAX_BYTES:
            raise FsError("part too large")
        target, staging = _staging_path(workspace_path, rel_path, upload_id)
        # O_NOFOLLOW does not exist on Windows: there a symlink staging file is
        # refused by the explicit lstat check instead (also done on POSIX, so
        # the refusal does not depend on the flag alone).
        nofollow = getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        if staging.is_symlink():
            raise FsError("cannot create upload file")
        if offset == 0:
            target.parent.mkdir(parents=True, exist_ok=True)
            _sweep_stale_staging(target.parent)
            if not staging.is_symlink():
                staging.unlink(missing_ok=True)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow
        else:
            flags = os.O_WRONLY | os.O_APPEND | nofollow
        try:
            fd = os.open(staging, flags, 0o600)
        except OSError as exc:
            if offset == 0:
                raise FsError("cannot create upload file") from exc
            # Only a size mismatch below means out of order. A missing staging
            # file is an upload that expired or whose earlier part failed (a
            # failed part removes it); anything else keeps its own reason.
            if exc.errno == errno.ENOENT:
                raise FsError("no such upload (it expired or an earlier part failed)") from exc
            raise FsError(f"cannot open upload file: {exc.strerror}") from exc
        out_of_order = False
        try:
            with os.fdopen(fd, "ab") as handle:
                st = os.fstat(handle.fileno())
                owned = not hasattr(os, "getuid") or st.st_uid == os.getuid()
                # Without O_NOFOLLOW a link planted after the is_symlink check
                # is followed by the open: the name must be the file we opened.
                same = os.path.samestat(st, os.lstat(staging))
                if not stat_mod.S_ISREG(st.st_mode) or not owned or not same:
                    raise FsError("upload file is not a regular file")
                if offset != 0 and st.st_size != offset:
                    out_of_order = True
                    raise FsError("upload part out of order")
                handle.write(data)
        except Exception:
            if not out_of_order:
                staging.unlink(missing_ok=True)
            raise
        return {"ok": True, "size": offset + len(data)}
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}


def write_commit(
    workspace_path: str,
    rel_path: str,
    upload_id: str,
    total_size: int,
    expected_mtime: float | None = None,
) -> dict[str, Any]:
    """Swap a fully staged upload in as ``rel_path``.

    Same contract as :func:`write_file`: when ``expected_mtime`` is given and
    the file on disk has a different mtime the write is refused with
    ``conflict=True`` (the staging file is discarded); success returns the new
    ``mtime``. The replace is one atomic rename, so a reader never sees a
    half-written document.
    """
    staging: Path | None = None
    try:
        if isinstance(total_size, bool) or not isinstance(total_size, int) or total_size < 0:
            raise FsError("invalid size")
        target, staging = _staging_path(workspace_path, rel_path, upload_id)
        _sweep_stale_staging(target.parent)
        if staging.is_symlink() or not staging.is_file():
            raise FsError("no such upload")
        if staging.stat().st_size != total_size:
            raise FsError("upload incomplete")
        with _target_lock(target):
            _remove_orphan_temps(target)
            orig_mode: int | None = None
            replaced_ns: int | None = None
            if target.exists():
                st = target.stat()
                orig_mode = st.st_mode
                replaced_ns = st.st_mtime_ns
                if expected_mtime is not None and abs(st.st_mtime - expected_mtime) > 1e-4:
                    staging.unlink(missing_ok=True)
                    return {"ok": False, "conflict": True, "mtime": st.st_mtime, "error": "file changed on disk"}
            if orig_mode is not None:
                os.chmod(staging, stat_mod.S_IMODE(orig_mode))
            os.replace(staging, target)
            if replaced_ns is not None:
                _advance_mtime(target, replaced_ns)
            return {"ok": True, "mtime": target.stat().st_mtime}
    except (FsError, OSError) as exc:
        if staging is not None:
            staging.unlink(missing_ok=True)
        return {"ok": False, "error": str(exc)}


def write_abort(workspace_path: str, rel_path: str, upload_id: str) -> dict[str, Any]:
    """Discard the staging file of a chunked write (idempotent)."""
    try:
        _target, staging = _staging_path(workspace_path, rel_path, upload_id)
        staging.unlink(missing_ok=True)
        return {"ok": True}
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
