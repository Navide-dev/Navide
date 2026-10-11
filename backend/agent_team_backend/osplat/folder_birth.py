"""When a folder was created, so one deleted and made again reads as another.

macOS and Windows keep it in ``st_birthtime``. Linux hands a recreated folder
the same inode back and Python's ``os.stat`` has no birth time there, so it is
read with glibc's ``statx`` (glibc 2.28+, a filesystem that records it: ext4,
btrfs, xfs, recent tmpfs). None wherever it cannot be known.
"""

from __future__ import annotations

import ctypes
import os
from pathlib import Path


def from_stat(folder: Path) -> float | None:
    try:
        return getattr(os.stat(folder), "st_birthtime", None)
    except OSError:
        return None


class _Timestamp(ctypes.Structure):
    _fields_ = [("tv_sec", ctypes.c_int64), ("tv_nsec", ctypes.c_uint32), ("_reserved", ctypes.c_int32)]


class _Statx(ctypes.Structure):
    # struct statx, include/uapi/linux/stat.h: 256 bytes.
    _fields_ = [
        ("stx_mask", ctypes.c_uint32), ("stx_blksize", ctypes.c_uint32),
        ("stx_attributes", ctypes.c_uint64),
        ("stx_nlink", ctypes.c_uint32), ("stx_uid", ctypes.c_uint32), ("stx_gid", ctypes.c_uint32),
        ("stx_mode", ctypes.c_uint16), ("_spare0", ctypes.c_uint16),
        ("stx_ino", ctypes.c_uint64), ("stx_size", ctypes.c_uint64), ("stx_blocks", ctypes.c_uint64),
        ("stx_attributes_mask", ctypes.c_uint64),
        ("stx_atime", _Timestamp), ("stx_btime", _Timestamp), ("stx_ctime", _Timestamp), ("stx_mtime", _Timestamp),
        ("stx_rdev_major", ctypes.c_uint32), ("stx_rdev_minor", ctypes.c_uint32),
        ("stx_dev_major", ctypes.c_uint32), ("stx_dev_minor", ctypes.c_uint32),
        ("_spare2", ctypes.c_uint64 * 14),
    ]


_AT_FDCWD = -100
_STATX_BTIME = 0x800


def _libc_statx():
    try:
        return getattr(ctypes.CDLL(None, use_errno=True), "statx", None)
    except (OSError, TypeError):
        return None


#: Looked up on the first Linux call, never at import: elsewhere loading the
#: C library this way raises (TypeError on Windows).
_UNSET = object()
_statx: object = _UNSET


def from_statx(folder: Path) -> float | None:
    global _statx
    if _statx is _UNSET:
        _statx = _libc_statx()
    if _statx is None:
        return None
    buf = _Statx()
    try:
        # A kernel without statx answers -1 (ENOSYS); glibc's fallback for
        # it fills the basic fields only, without STATX_BTIME.
        if _statx(_AT_FDCWD, os.fsencode(folder), 0, _STATX_BTIME, ctypes.byref(buf)) != 0:
            return None
    except (ctypes.ArgumentError, ValueError, OSError):
        return None
    if not buf.stx_mask & _STATX_BTIME:
        return None
    return buf.stx_btime.tv_sec + buf.stx_btime.tv_nsec / 1e9
