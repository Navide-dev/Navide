"""POSIX seams on Android, with the desktop behaviour locked in place.

Android has no /bin (only /system/bin/sh), and Chaquopy's CPython has neither
os.openpty nor os.forkpty. Every fallback below must leave macOS and desktop
Linux exactly as they were, which the *_desktop_* tests pin.
"""
from __future__ import annotations

import os
import struct
import sys

import pytest

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX seams")

from agent_team_backend.osplat import _posix  # noqa: E402


# ── PTY without os.openpty ───────────────────────────────────────────────────

def test_openpty_desktop_uses_pty_openpty(monkeypatch: pytest.MonkeyPatch) -> None:
    assert hasattr(os, "openpty")
    monkeypatch.setattr(_posix.pty, "openpty", lambda: (101, 102))
    assert _posix._openpty() == (101, 102)


def test_openpty_without_os_openpty_unlocks_dev_ptmx(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delattr(_posix.os, "openpty")
    opened, ioctls = [], []

    def fake_open(path, flags, *a, **k):
        opened.append(path)
        return {"/dev/ptmx": 50, "/dev/pts/7": 51}[path]

    def fake_ioctl(fd, request, arg=0, *a):
        ioctls.append((fd, request))
        return struct.pack("I", 7) if request == _posix._TIOCGPTN else arg

    monkeypatch.setattr(_posix.os, "open", fake_open)
    monkeypatch.setattr(_posix.fcntl, "ioctl", fake_ioctl)
    assert _posix._openpty() == (50, 51)
    assert opened == ["/dev/ptmx", "/dev/pts/7"]
    assert ioctls == [(50, _posix._TIOCSPTLCK), (50, _posix._TIOCGPTN)]


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="/dev/ptmx ioctls are Linux's")
def test_openpty_ptmx_round_trip_on_linux(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delattr(_posix.os, "openpty")
    master, slave = _posix._openpty()
    try:
        os.write(master, b"ping\n")
        assert os.read(slave, 16).strip() == b"ping"
    finally:
        os.close(master); os.close(slave)
