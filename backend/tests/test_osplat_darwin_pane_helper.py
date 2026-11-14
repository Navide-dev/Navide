"""macOS pane helper: what a pane runs must not show in the Dock as "Navide".

LaunchServices names a registering process after its nearest registered
ancestor. Every pane child descends from Navide.app, so a tool that
registers (a browser CLI did, on each call) appeared in the Dock as another
running "Navide" — the app looked like it relaunched over and over. The
helper (resources/pane-helper, built to build/pane-helper/) is an LSUIElement
bundle that registers first, so anything under it is a UI-element process
the Dock never shows. `DarwinTerminalBackend` runs every pane under it.

These tests pin the attribution fix and that the helper is transparent to
the backend: argv, env, cwd, controlling terminal, exit status, signal
forwarding and the no-helper fallback.
"""

from __future__ import annotations

import os
import re
import select
import signal
import subprocess
import sys
import time

import pytest

# Real POSIX PTY behaviour; the module is skipped where these do not exist.
fcntl = pytest.importorskip("fcntl")

pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="macOS LaunchServices")

from agent_team_backend.osplat import _darwin  # noqa: E402

HELPER = _darwin.find_pane_helper({})
needs_helper = pytest.mark.skipif(
    HELPER is None, reason="pane helper not built (pnpm run build:pane-helper)"
)

REGISTERING_CHILD = (
    "import ctypes, time; "
    "ctypes.CDLL('/System/Library/Frameworks/AppKit.framework/AppKit').NSApplicationLoad(); "
    "print('registered', flush=True); time.sleep(3)"
)


def _ls_record(pid: int) -> tuple[str, str] | None:
    """(name, type) LaunchServices holds for pid, or None if unregistered."""
    asn = subprocess.run(
        ["lsappinfo", "find", f"pid={pid}"], capture_output=True, text=True
    )
    asn = asn.stdout.strip()
    if not asn:
        return None
    info = subprocess.run(
        ["lsappinfo", "info", asn], capture_output=True, text=True
    ).stdout
    name = re.match(r'"([^"]*)"', info.strip())
    typ = re.search(r'type="([^"]*)"', info)
    return (name.group(1) if name else "?", typ.group(1) if typ else "?")


def _read_until_exit(handle, timeout: float = 10.0) -> bytes:
    out = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([handle.fd], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(handle.fd, 65536)
            except BlockingIOError:
                continue
            except OSError:
                break  # slave closed: child exited
            if not chunk:
                break
            out += chunk
        elif handle.proc.poll() is not None:
            break
    handle.proc.wait(timeout=5)
    return bytes(out)


def _spawn(backend, argv, *, cwd=None, env=None):
    return backend.spawn(
        argv,
        cwd=cwd or os.getcwd(),
        env=env if env is not None else {"PATH": "/usr/bin:/bin"},
        rows=24,
        cols=80,
    )


def _wait_for_output(handle, marker: bytes, timeout: float = 8.0) -> None:
    out = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and marker not in out:
        ready, _, _ = select.select([handle.fd], [], [], 0.2)
        if ready:
            try:
                out += os.read(handle.fd, 65536)
            except (BlockingIOError, OSError):
                pass
    assert marker in out, f"child never printed {marker!r}; saw {bytes(out)!r}"


def test_find_pane_helper_honours_the_kill_switch(tmp_path):
    assert _darwin.find_pane_helper({_darwin.PANE_HELPER_ENV: "0"}) is None
    assert _darwin.find_pane_helper({_darwin.PANE_HELPER_ENV: ""}) is None
    # An override must be executable to count; a missing path falls back to bare.
    assert (
        _darwin.find_pane_helper({_darwin.PANE_HELPER_ENV: str(tmp_path / "nope")})
        is None
    )
    exe = tmp_path / "helper"
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    assert _darwin.find_pane_helper({_darwin.PANE_HELPER_ENV: str(exe)}) == str(exe)


def test_darwin_binds_the_helper_backend():
    assert isinstance(_darwin.terminal_backend, _darwin.DarwinTerminalBackend)


def test_frozen_backend_finds_the_packaged_helper(tmp_path, monkeypatch):
    # The packaged layout electron-builder produces (package.json
    # build.mac.extraResources): the frozen backend and the helper bundle are
    # siblings under Contents/Resources/bin.
    bin_dir = tmp_path / "Navide.app" / "Contents" / "Resources" / "bin"
    exe = bin_dir / "Navide Pane.app" / "Contents" / "MacOS" / "navide-pane"
    exe.parent.mkdir(parents=True)
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    backend = bin_dir / "agent_team_backend"
    backend.write_text("")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(backend))
    assert _darwin.find_pane_helper({}) == str(exe)
    # A packaged app without the helper (a build that skipped it) runs bare.
    exe.unlink()
    assert _darwin.find_pane_helper({}) is None


def test_onedir_backend_finds_the_packaged_helper(tmp_path, monkeypatch):
    # A onedir backend runs from bin/agent_team_backend/, one level below the
    # helper bundle it still has to find.
    bin_dir = tmp_path / "Navide.app" / "Contents" / "Resources" / "bin"
    exe = bin_dir / "Navide Pane.app" / "Contents" / "MacOS" / "navide-pane"
    exe.parent.mkdir(parents=True)
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    (bin_dir / "agent_team_backend" / "_internal").mkdir(parents=True)
    backend = bin_dir / "agent_team_backend" / "agent_team_backend"
    backend.write_text("")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(backend))
    assert _darwin.find_pane_helper({}) == str(exe)


@needs_helper
def test_registering_pane_child_is_a_ui_element_not_navide():
    # Control first: run the same registering child bare. Whatever app this
    # test process is attributed to (a Navide pane when run from one, a
    # terminal app otherwise) is what the child inherits, and it registers as
    # a Foreground app — the Dock-tile case. If the control were already a
    # UIElement the assertion below would prove nothing.
    bare = _darwin.DarwinTerminalBackend(None)
    handle = _spawn(bare, [sys.executable, "-c", REGISTERING_CHILD])
    try:
        _wait_for_output(handle, b"registered")
        deadline = time.monotonic() + 2.0
        control = _ls_record(handle.pid)
        while (control is None or control[1] != "Foreground") and time.monotonic() < deadline:
            time.sleep(0.1)
            control = _ls_record(handle.pid)
    finally:
        handle.proc.kill()
        handle.proc.wait(timeout=5)
    if control is None or control[1] != "Foreground":
        # LaunchServices sometimes does not attribute the bare child to any
        # app at all (seen as ("python3", "BackgroundOnly") in full-suite runs
        # shortly after a reboot). Without the Dock-tile case to contrast
        # with, the helper assertion below cannot prove anything.
        pytest.skip(f"control child did not register as Foreground: {control}")

    under_helper = _darwin.DarwinTerminalBackend(HELPER)
    handle = _spawn(under_helper, [sys.executable, "-c", REGISTERING_CHILD])
    try:
        _wait_for_output(handle, b"registered")
        children = subprocess.run(
            ["pgrep", "-P", str(handle.pid)], capture_output=True, text=True
        )
        [child_pid] = [int(p) for p in children.stdout.split()]
        record = _ls_record(child_pid)
    finally:
        handle.proc.kill()
        handle.proc.wait(timeout=5)
    assert record == ("Navide Pane", "UIElement"), record


@needs_helper
def test_helper_is_transparent_to_the_pane_contract(tmp_path):
    (tmp_path / "cwd-marker").write_text("here")
    script = (
        'printf "argv=%s|%s\\n" "$1" "$2"; '
        'printf "env=%s\\n" "$NAVIDE_TEST_VAR"; '
        'printf "cwd=%s\\n" "$(ls cwd-marker)"; '
        'printf "ctty=%s\\n" "$( (: </dev/tty) 2>/dev/null && echo yes || echo no)"; '
        'printf "pgid=%s\\n" "$(ps -o pgid= -p $$ | tr -d " ")"; '
        "exit 7"
    )
    backend = _darwin.DarwinTerminalBackend(HELPER)
    handle = _spawn(
        backend,
        ["/bin/sh", "-c", script, "sh", "first", "two words"],
        cwd=str(tmp_path),
        env={"PATH": "/usr/bin:/bin", "NAVIDE_TEST_VAR": "from-env"},
    )
    out = _read_until_exit(handle).decode("utf-8", "replace").replace("\r", "")
    assert "argv=first|two words" in out
    assert "env=from-env" in out
    assert "cwd=cwd-marker" in out
    assert "ctty=yes" in out
    # The helper is the group and session leader that claimed the ctty; the
    # command runs inside its group, as pty_registry expects of a root.
    pgid = next(line for line in out.splitlines() if line.startswith("pgid="))[5:]
    assert pgid == str(handle.pid), (pgid, handle.pid)
    assert handle.proc.returncode == 7


_SLEEP_MARK = "30.7171"
_SLEEP_PATTERN = "^sleep 30\\.7171$"


@needs_helper
def test_helper_forwards_signals_and_reports_the_signal_exit():
    backend = _darwin.DarwinTerminalBackend(HELPER)
    # A duration no other process on the machine will be sleeping for: the
    # check below is a machine-wide pgrep, and other sessions poll with
    # `sleep 30`.
    handle = _spawn(backend, ["/bin/sh", "-c", f"echo up; sleep {_SLEEP_MARK}"])
    _wait_for_output(handle, b"up")
    # SIGTERM to the pane root (what kill_group reaches) must land on the shell.
    os.kill(handle.pid, signal.SIGTERM)
    handle.proc.wait(timeout=5)
    # The helper dies by the same signal, so the backend logs exit=-15/143
    # exactly as it did when the shell was the root.
    assert handle.proc.returncode == -signal.SIGTERM
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not subprocess.run(
            ["pgrep", "-f", _SLEEP_PATTERN], capture_output=True
        ).stdout:
            break
        time.sleep(0.1)
    assert not subprocess.run(["pgrep", "-f", _SLEEP_PATTERN], capture_output=True).stdout


@needs_helper
def test_helper_reports_a_missing_command_like_exec_would():
    backend = _darwin.DarwinTerminalBackend(HELPER)
    handle = _spawn(backend, ["navide-no-such-command-xyz"])
    out = _read_until_exit(handle)
    assert b"navide-no-such-command-xyz" in out
    assert handle.proc.returncode == 127


def test_without_a_helper_the_command_is_spawned_bare():
    backend = _darwin.DarwinTerminalBackend(None)
    handle = _spawn(backend, ["/bin/sh", "-c", "echo bare-ok"])
    out = _read_until_exit(handle)
    assert b"bare-ok" in out
    assert handle.proc.returncode == 0
    assert handle.proc.args[0] == "/bin/sh"
