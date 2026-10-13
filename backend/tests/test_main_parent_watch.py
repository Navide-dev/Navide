"""The backend dies with the app, on every platform.

Electron names itself in AGENT_TEAM_PARENT_PID; the backend polls that pid and
takes the same cooperative exit as the stdin `shutdown` line when it is gone.
Found the hard way twice: a SIGTERMed Electron on Ubuntu left both backend
processes running, reparented to PID 1, and the next launch started a second
backend beside them — and later, on Windows, a Task-Manager kill of the app
left the backend and its CLI tree orphaned because that path trusted a Job
Object the app never actually created. Windows now follows the pid too, guarded
against its fast pid reuse by the parent's `identity` (pid + start time).
"""

from __future__ import annotations

import os
import json
import subprocess
import sys
import threading
import time

import pytest

from agent_team_backend import osplat
from agent_team_backend.__main__ import _watch_parent_for_shutdown
from agent_team_backend.osplat import _posix, _windows


def _isolated_backend_env(tmp_path):
    from agent_team_backend.cli_vendors.registry import VENDORS

    home = tmp_path / "home"
    home.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    # A subprocess does not inherit conftest's in-process monkeypatches.
    # Remove vendor overrides before using their isolated-home defaults.
    for spec in VENDORS.values():
        for name in spec.home_env_vars:
            env.pop(name, None)
    env.update(osplat.paths.isolated_home_env(home))
    env.update({
        "AGENT_TEAM_DATA_DIR": str(tmp_path),
        "APPDATA": str(home / "AppData" / "Roaming"),
        "LOCALAPPDATA": str(home / "AppData" / "Local"),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_STATE_HOME": str(home / ".local" / "state"),
        "XDG_CACHE_HOME": str(home / ".cache"),
    })
    return env


def test_backend_child_hook_installers_use_only_the_isolated_home(tmp_path, monkeypatch):
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "settings.json"
    sentinel.write_text('{"keep": "unchanged"}', encoding="utf-8")
    for name in ("CLAUDE_CONFIG_DIR", "QWEN_HOME", "COPILOT_HOME", "CODEX_HOME",
                 "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"):
        monkeypatch.setenv(name, str(outside))
    child_env = _isolated_backend_env(tmp_path / "child")
    script = (
        "import json\n"
        "from pathlib import Path\n"
        "from agent_team_backend import claude_hooks, qwen_hooks, copilot_hooks\n"
        "from agent_team_backend.applog import backend_port_file\n"
        "paths = [claude_hooks.settings_path(), qwen_hooks.settings_path(), "
        "copilot_hooks.hooks_dir() / 'agent-team.json']\n"
        "for path in paths: path.parent.mkdir(parents=True, exist_ok=True)\n"
        "for installer in (claude_hooks, qwen_hooks, copilot_hooks): "
        "installer.install_hooks(str(backend_port_file()))\n"
        "assert all(path.exists() for path in paths)\n"
        "print(json.dumps([str(path) for path in paths]))\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script], env=child_env,
        capture_output=True, text=True, check=True, timeout=30,
    )
    from pathlib import Path

    assert all(Path(path).is_relative_to(tmp_path / "child" / "home")
               for path in json.loads(result.stdout))
    assert sentinel.read_text(encoding="utf-8") == '{"keep": "unchanged"}'
    assert list(outside.iterdir()) == [sentinel]


class _Server:
    should_exit = False


def test_posix_follows_the_pid_the_app_named() -> None:
    tree = _posix.PosixProcessTree()
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": "4242"}) == 4242
    # Nobody spawned this backend from the app: nothing to follow.
    assert tree.parent_to_follow({}) is None
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": ""}) is None
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": "not-a-pid"}) is None
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": "0"}) is None


def test_windows_follows_the_pid_the_app_named() -> None:
    tree = _windows.WindowsProcessTree()
    # No Job Object ties the backend to the app on Windows, so it follows the
    # named pid just like POSIX (it used to return None and orphan on a crash).
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": "4242"}) == 4242
    assert tree.parent_to_follow({}) is None
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": ""}) is None
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": "not-a-pid"}) is None
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": "0"}) is None


def test_a_reused_parent_pid_still_counts_as_gone() -> None:
    # Windows reuses pids fast: the parent can die and its number belong to
    # another process before the next poll, so a bare liveness check reads it as
    # alive. The identity (pid + start time) changes on reuse, and that must end
    # the watch just as a vanished pid does.
    server = _Server()
    identities = iter(["4242:START-A", "4242:START-A", "4242:START-B"])
    thread = threading.Thread(
        target=_watch_parent_for_shutdown,
        args=(server, 4242),
        kwargs={
            "interval_s": 0.05,
            "is_alive": lambda _pid: True,  # the pid is always "alive" (reused)
            "identity": lambda _pid: next(identities, "4242:START-B"),
        },
        daemon=True,
    )
    thread.start()
    thread.join(timeout=2)
    assert server.should_exit is True


def test_an_unreadable_parent_identity_falls_back_to_liveness() -> None:
    # If the parent's identity cannot be read at startup ("") the watch must not
    # exit on an empty match — it falls back to the liveness check alone.
    server = _Server()
    alive = {"value": True}
    thread = threading.Thread(
        target=_watch_parent_for_shutdown,
        args=(server, 4242),
        kwargs={
            "interval_s": 0.05,
            "is_alive": lambda _pid: alive["value"],
            "identity": lambda _pid: "",
        },
        daemon=True,
    )
    thread.start()
    time.sleep(0.2)
    assert server.should_exit is False  # empty identity does not trigger exit
    alive["value"] = False
    thread.join(timeout=2)
    assert server.should_exit is True


def _run_watch_for(server, identities, polls: int = 6) -> None:
    """Run the watcher against a scripted identity sequence on a parent that is
    always alive; stop it from outside after `polls` reads if it did not exit."""
    seq = iter(identities)
    reads = {"n": 0}

    def identity(_pid):
        reads["n"] += 1
        if reads["n"] > polls:
            server.should_exit = "stopped-by-test"
        return next(seq, identities[-1])

    thread = threading.Thread(
        target=_watch_parent_for_shutdown,
        args=(server, 4242),
        kwargs={"interval_s": 0.01, "is_alive": lambda _pid: True, "identity": identity},
        daemon=True,
    )
    thread.start()
    thread.join(timeout=2)


def test_a_failed_identity_probe_mid_watch_is_not_a_dead_parent() -> None:
    # 2026-10-08 17:25: one `ps` probe timed out on a loaded machine, the start
    # time read as "", and a live app's backend shut itself down.
    server = _Server()
    _run_watch_for(server, ["4242:START-A", "", "4242:START-A"])
    assert server.should_exit == "stopped-by-test"


def test_a_failed_identity_probe_at_startup_is_captured_later() -> None:
    # The first read failing used to pin "" (or "4242:") as the original, so
    # the next successful read mismatched and the backend exited 2s after start.
    server = _Server()
    _run_watch_for(server, ["", "4242:START-A", "4242:START-A"])
    assert server.should_exit == "stopped-by-test"


def test_a_late_captured_identity_still_detects_pid_reuse() -> None:
    server = _Server()
    _run_watch_for(server, ["", "4242:START-A", "4242:START-B"])
    assert server.should_exit is True


def test_posix_identity_is_empty_when_the_probe_fails(monkeypatch) -> None:
    monkeypatch.setattr(_posix, "_ps", lambda _pid, _fields: None)
    assert _posix.PosixProcessTree().identity(4242) == ""


def test_the_watcher_takes_the_cooperative_exit_once_the_parent_is_gone() -> None:
    server = _Server()
    alive = {"value": True}
    thread = threading.Thread(
        target=_watch_parent_for_shutdown,
        args=(server, 4242),
        kwargs={"interval_s": 0.05, "is_alive": lambda _pid: alive["value"]},
        daemon=True,
    )
    thread.start()
    time.sleep(0.2)
    assert server.should_exit is False  # a live parent changes nothing
    alive["value"] = False
    thread.join(timeout=2)
    assert server.should_exit is True


def test_a_shutdown_from_elsewhere_ends_the_watcher() -> None:
    server = _Server()
    server.should_exit = True  # the stdin line got there first
    _watch_parent_for_shutdown(server, 4242, interval_s=0.05, is_alive=lambda _pid: True)


def test_a_backend_whose_parent_dies_exits_by_itself(tmp_path) -> None:
    """The whole chain, on every platform: a stand-in parent spawns the real
    backend with its own pid in AGENT_TEAM_PARENT_PID, gets killed, and the
    backend must be gone within the poll interval plus uvicorn's shutdown.
    Runs on Windows too now that the backend follows the pid there."""
    env = _isolated_backend_env(tmp_path)
    parent_script = (
        "import os, subprocess, sys, time\n"
        "child = subprocess.Popen(\n"
        "    [sys.executable, '-m', 'agent_team_backend', '--port', '0', '--log-level', 'warning'],\n"
        "    env=dict(os.environ, AGENT_TEAM_PARENT_PID=str(os.getpid())),\n"
        "    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,\n"
        ")\n"
        "print(child.pid, flush=True)\n"
        "time.sleep(120)\n"
    )
    parent = subprocess.Popen(
        [sys.executable, "-c", parent_script], env=env, stdout=subprocess.PIPE, text=True
    )
    try:
        line = parent.stdout.readline() if parent.stdout else ""
        backend_pid = int(line.strip())
        # Let the backend get past its imports and into the server loop; the
        # port file is the first thing main() writes.
        deadline = time.monotonic() + 40
        while not (tmp_path / "backend-port").exists():
            assert time.monotonic() < deadline, "the backend never started"
            assert osplat.process_tree.is_alive(backend_pid), "the backend died before its parent did"
            time.sleep(0.2)
        time.sleep(1.0)
        assert osplat.process_tree.is_alive(backend_pid)

        parent.kill()
        parent.wait(timeout=10)

        deadline = time.monotonic() + 20
        while osplat.process_tree.is_alive(backend_pid):
            assert time.monotonic() < deadline, "the backend outlived its parent"
            time.sleep(0.25)
    finally:
        # Release our handle so the parent's pid is fully gone rather than a
        # handle-held zombie, the way it is in production once the app is gone.
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
        # Only a backend that outlived its parent is still here to kill. POSIX
        # raises ProcessLookupError for an already-dead pid; Windows raises
        # OSError (WinError 87) — catch both, or a passing run dies in cleanup.
        try:
            os.kill(backend_pid, 9)
        except (ProcessLookupError, NameError, OSError):
            pass


@pytest.mark.skipif(sys.platform != "win32", reason="Windows GetExitCodeProcess path")
def test_windows_is_alive_uses_the_exit_code_not_just_pid_exists() -> None:
    # A running process is alive; once it exits it is not — even in the window
    # where a held handle keeps its pid around. The hardened check asks the
    # kernel for the exit code rather than trusting pid_exists alone.
    import subprocess

    from agent_team_backend.osplat import _windows

    tree = _windows.WindowsProcessTree()
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert tree.is_alive(proc.pid) is True
        proc.kill()
        proc.wait(timeout=5)
        # The Popen object still holds a handle to the now-dead process here.
        assert tree.is_alive(proc.pid) is False
    finally:
        if proc.poll() is None:
            proc.kill()
