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

from agent_team_backend import osplat  # noqa: E402
from agent_team_backend.osplat import _posix, _posix_paths  # noqa: E402


# ── /bin/sh and /bin/bash ────────────────────────────────────────────────────

def test_shell_command_desktop_keeps_bin_sh() -> None:
    assert os.path.exists("/bin/sh")
    assert _posix_paths.shell_command("echo hi") == ["/bin/sh", "-c", "echo hi"]


def test_shell_command_falls_back_when_bin_sh_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    real_exists = os.path.exists
    monkeypatch.setattr(_posix_paths.os.path, "exists", lambda p: False if p == "/bin/sh" else real_exists(p))
    monkeypatch.setattr(_posix_paths.shutil, "which", lambda name: None)
    assert _posix_paths.shell_command("echo hi") == ["/system/bin/sh", "-c", "echo hi"]
    monkeypatch.setattr(_posix_paths.shutil, "which", lambda name: "/data/prefix/bin/sh" if name == "sh" else None)
    assert _posix_paths.shell_command("echo hi") == ["/data/prefix/bin/sh", "-c", "echo hi"]


def test_login_probe_desktop_defaults_to_bin_bash(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SHELL", raising=False)
    assert os.path.exists("/bin/bash")
    assert _posix_paths.login_path_probe()[0] == "/bin/bash"
    monkeypatch.setenv("SHELL", "/bin/zsh")
    assert _posix_paths.login_path_probe()[0] == "/bin/zsh"


def test_login_probe_falls_back_when_bin_bash_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SHELL", raising=False)
    real_exists = os.path.exists
    monkeypatch.setattr(_posix_paths.os.path, "exists",
                        lambda p: False if p in ("/bin/bash", "/bin/sh") else real_exists(p))
    monkeypatch.setattr(_posix_paths.shutil, "which", lambda name: None)
    assert _posix_paths.login_path_probe()[0] == "/system/bin/sh"


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


# ── static binaries and DNS ──────────────────────────────────────────────────

def test_desktop_never_needs_the_loopback_dns_proxy() -> None:
    assert osplat.paths.needs_loopback_dns_proxy() is False


def test_android_without_resolv_conf_needs_the_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    real_exists = os.path.exists
    monkeypatch.setattr(_posix_paths.os.path, "exists",
                        lambda p: False if p == "/etc/resolv.conf" else real_exists(p))
    monkeypatch.setattr(_posix_paths.sys, "platform", "android")
    assert _posix_paths.static_binaries_lack_resolver() is True
    monkeypatch.setattr(_posix_paths.sys, "platform", "linux")
    assert _posix_paths.static_binaries_lack_resolver() is False
