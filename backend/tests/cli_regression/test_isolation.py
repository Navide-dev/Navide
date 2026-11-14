"""Isolation policy tests execute guards in disposable interpreters."""
import asyncio
import json
import socket
import importlib.util
from pathlib import Path
import subprocess
import sys
import time
import uuid

import pytest

from agent_team_backend import osplat, pty_registry
from agent_team_backend.applog import in_data_dir

from .support.isolation import isolated_environment, real_cli_in
from .support.backend_process import BackendProcess
from .support.cli_shim import base_python_executable


pytestmark = [pytest.mark.cli_regression, pytest.mark.cli_shared]


def test_environment_discards_provider_and_shell_configuration(tmp_path, monkeypatch):
    for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
                "BASH_ENV", "ENV", "NODE_OPTIONS", "PYTHONPATH", "HTTP_PROXY"):
        monkeypatch.setenv(key, "must-not-propagate")
    env = isolated_environment(tmp_path)
    assert "must-not-propagate" not in env.values()
    assert Path(env["HOME"]).is_relative_to(tmp_path)
    assert Path(env["USERPROFILE"]).is_relative_to(tmp_path)


def test_environment_excludes_user_cli_path(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path / "user-global-bin"))
    assert str(tmp_path / "user-global-bin") not in isolated_environment(tmp_path)["PATH"]


def test_main_suite_scrubs_vendor_paths_before_app_import(tmp_path):
    from agent_team_backend.cli_vendors.registry import VENDORS

    keys = {key for spec in VENDORS.values() for key in (
        *spec.home_env_vars, *spec.data_dir_env_vars, *spec.credential_path_env_vars,
        *spec.network_override_env_vars,
    )} - {"HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"}
    env = isolated_environment(tmp_path)
    env.update({key: "inherited-provider-location" for key in keys})
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    script = """
import json, os, sys
from pathlib import Path
import tests.conftest
assert all(key not in os.environ for key in json.loads(sys.argv[1]))
assert 'navide-test-home-' in str(Path.home())
"""
    subprocess.run([sys.executable, "-c", script, json.dumps(sorted(keys))], env=env, check=True)


@pytest.mark.parametrize("argv", [
    ["sh", "-c", "VAR=value echo safe; claude --version"],
    ["cmd.exe", "/d", "/s", "/c", '"claude" --version'],
    ["env", "FOO=1", "claude", "--version"],
    ["sh", "-c", "echo safe;claude --version"],
])
def test_guard_recognizes_cli_after_shell_wrappers(tmp_path, monkeypatch, argv):
    executable = tmp_path / "installed" / "claude"
    executable.parent.mkdir()
    executable.write_text("unused")
    monkeypatch.setattr("shutil.which", lambda *args, **kwargs: str(executable))
    assert real_cli_in(argv, {}, (tmp_path / "allowed",)) == str(executable)
    assert real_cli_in(argv, {}, (tmp_path,)) is None


@pytest.mark.parametrize("argv", [
    ["codex", "exec", "hi"],
    ["cmd", "/c", "codex.cmd", "--flag"],
    ["cmd.exe", "/d", "/c", "codex.cmd --flag"],
    ["sh", "-lc", "codex --flag"],
    ["zsh", "-ilc", "cd /tmp && codex --flag"],
    "codex --flag",
])
def test_guard_still_refuses_a_real_cli_launch(tmp_path, monkeypatch, argv):
    executable = tmp_path / "installed" / "codex"
    executable.parent.mkdir()
    executable.write_text("unused")
    monkeypatch.setattr("shutil.which", lambda *args, **kwargs: str(executable))
    assert real_cli_in(argv, {}, (tmp_path / "allowed",)) == str(executable)


def test_guard_refuses_a_cli_script_run_by_node(tmp_path):
    script = tmp_path / "installed" / "codex.js"
    script.parent.mkdir()
    script.write_text("unused")
    argv = ["node", str(script), "--flag"]
    assert real_cli_in(argv, {}, (tmp_path / "allowed",)) == str(script)


@pytest.mark.parametrize("argv", [
    # A Keychain service named after a CLI is data, not a launch.
    ["/usr/bin/security", "find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
    # A fake CLI handed the vendor name as an argument.
    ["python", "x.py", "codex", "--flag"],
    ["sh", "-c", "python x.py codex --flag"],
    ["git", "log", "--author", "claude"],
])
def test_guard_ignores_a_cli_name_passed_as_data(tmp_path, monkeypatch, argv):
    executable = tmp_path / "installed" / "codex"
    executable.parent.mkdir()
    executable.write_text("unused")
    monkeypatch.setattr("shutil.which", lambda *args, **kwargs: str(executable))
    assert real_cli_in(argv, {}, (tmp_path / "allowed",)) is None


def test_hook_url_is_not_mistaken_for_a_cli_executable(tmp_path):
    assert real_cli_in(["curl", "-X", "POST", "http://127.0.0.1:1234/hooks/claude"], {}, (tmp_path,)) is None


def test_caught_network_refusal_still_leaves_failure_evidence(tmp_path):
    script = """
from pathlib import Path
import socket, sys
from tests.cli_regression.support.isolation import install_external_guards
install_external_guards(Path(sys.argv[1]))
try:
    socket.create_connection(('203.0.113.1', 443), timeout=0.1)
except PermissionError:
    pass
"""
    env = isolated_environment(tmp_path)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    subprocess.run([sys.executable, "-c", script, str(tmp_path)], env=env, check=True)
    refusals = [json.loads(line) for line in (tmp_path / "refusals.jsonl").read_text().splitlines()]
    assert refusals == [{"boundary": "non-loopback network"}]


@pytest.mark.parametrize("loop_kind", ["asyncio"] + (["uvloop"] if importlib.util.find_spec("uvloop") else []))
@pytest.mark.parametrize("operation", ["connect", "dns"])
def test_async_network_refusal_cannot_bypass_socket_guard(tmp_path, loop_kind, operation):
    script = """
from pathlib import Path
import asyncio, sys
from tests.cli_regression.support.isolation import install_external_guards
install_external_guards(Path(sys.argv[1]))
factory = asyncio.new_event_loop
if sys.argv[2] == 'uvloop':
    import uvloop
    factory = uvloop.new_event_loop
async def attempt():
    loop = asyncio.get_running_loop()
    try:
        if sys.argv[3] == 'connect':
            await loop.create_connection(asyncio.Protocol, '203.0.113.1', 443)
        else:
            await loop.getaddrinfo('provider.invalid', 443)
    except PermissionError:
        pass
    else:
        raise AssertionError('external network was not refused')
with asyncio.Runner(loop_factory=factory) as runner:
    runner.run(attempt())
"""
    env = isolated_environment(tmp_path)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    subprocess.run([sys.executable, "-c", script, str(tmp_path), loop_kind, operation],
                   env=env, check=True, timeout=10)
    assert json.loads((tmp_path / "refusals.jsonl").read_text()) == {"boundary": "non-loopback network"}


def test_spawn_path_remains_isolated_after_product_refresh(tmp_path):
    script = """
from pathlib import Path
import os, subprocess, sys
from tests.cli_regression.support.isolation import install_external_guards
install_external_guards(Path(sys.argv[1]))
os.environ['PATH'] = sys.argv[2] + os.pathsep + os.environ['PATH']
print(subprocess.check_output([sys.executable, '-c', 'import os;print(os.environ["PATH"])'], text=True))
"""
    env = isolated_environment(tmp_path)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    exposed_path = str(tmp_path.parent / "user-global-bin")
    result = subprocess.run([sys.executable, "-c", script, str(tmp_path), exposed_path],
                            env=env, capture_output=True, text=True, check=True)
    assert exposed_path not in result.stdout


@pytest.mark.parametrize("boundary", ["popen", "native"])
def test_caught_real_cli_refusal_covers_native_spawn(tmp_path, boundary):
    # An executable outside this scenario's allowlisted fake root models an
    # installed CLI without ever invoking one from the developer's machine.
    executable = tmp_path / "outside" / "claude"
    executable.parent.mkdir()
    executable.write_text("must never execute")
    root = tmp_path / "scenario"
    env = isolated_environment(root)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    script = """
from pathlib import Path
import subprocess, sys
from tests.cli_regression.support.isolation import install_external_guards
install_external_guards(Path(sys.argv[1]))
try:
    if sys.argv[3] == 'popen':
        subprocess.Popen([sys.argv[2]])
    else:
        from agent_team_backend import osplat
        osplat.terminal_backend.spawn([sys.argv[2]], cwd=sys.argv[1], env={}, rows=30, cols=100)
except PermissionError:
    pass
else:
    raise AssertionError('external CLI reached the OS')
"""
    subprocess.run([sys.executable, "-c", script, str(root), str(executable), boundary], env=env, check=True)
    refusal = json.loads((root / "refusals.jsonl").read_text())
    assert refusal["boundary"] == ("real CLI" if boundary == "popen" else "real native CLI")


@pytest.mark.parametrize("n", [2, 3, 4, 5])
def test_shards_partition_real_collection_without_omission(tmp_path, n):
    backend_root = Path(__file__).resolve().parents[2]
    reports = []
    for k in range(1, n + 1):
        report = tmp_path / f"collection-{k}.json"
        env = isolated_environment(tmp_path / f"collector-{k}")
        subprocess.run(
            # Two files, so every one of five shards gets at least one test.
            [sys.executable, "-m", "pytest", "tests/cli_regression/test_shared.py",
             "tests/cli_regression/test_catalog.py", "--collect-only", "-q", "--shard", f"{k}/{n}", "--collection-report", str(report)],
            cwd=backend_root, env=env, capture_output=True, text=True, check=True,
        )
        reports.append(json.loads(report.read_text()))
    assert all(report["collected"] == reports[0]["collected"] for report in reports)
    selected = [set(report["selected"]) for report in reports]
    assert all(selected)
    assert sum(len(part) for part in selected) == len(set().union(*selected))
    assert set().union(*selected) == set(reports[0]["collected"])


def test_failure_cleanup_reaps_a_tracked_orphan(tmp_path):
    backend = BackendProcess(tmp_path)
    # The real interpreter: a Windows venv's python.exe is a launcher that runs
    # it as a child, which track_child rightly adds to the owned tree.
    child = subprocess.Popen([base_python_executable(), "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE)
    try:
        backend.track_child(child.pid)
        # Model a backend that has exited without reaping this known child.
        # It is no longer reachable through the backend's process tree.
        assert backend.process is None
        assert backend._owned_children[child.pid].is_running()
        survivors = backend._reap_surviving_children()
        assert [entry["pid"] for entry in survivors] == [child.pid]
        assert survivors[0]["name"] and survivors[0]["cmdline"]
        child.wait(timeout=5)
        assert child.poll() is not None
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        child.stdin.close()


def test_a_child_that_outlives_the_reap_window_is_still_reported(tmp_path):
    """The reap waits its window, then reports whatever is left.

    A child that would have exited on its own is still a survivor if it is
    alive when the window closes, so the window has to fit the slowest real
    child, not merely the shell.
    """
    backend = BackendProcess(tmp_path)
    # One process, not a venv launcher and its interpreter (see above).
    child = subprocess.Popen([base_python_executable(), "-c", "import time; time.sleep(2)"])
    try:
        backend.track_child(child.pid)
        assert backend.process is None
        started = time.monotonic()
        survivors = backend._reap_surviving_children(window_s=0.5)
        # A window, not an immediate sweep: it held before judging the child.
        # One clock tick of slack: Windows monotonic ticks ~15.6 ms, and the
        # subtraction of two tick-aligned floats can land a hair under 0.5.
        tick = time.get_clock_info("monotonic").resolution
        assert time.monotonic() - started >= 0.5 - tick
        assert [entry["pid"] for entry in survivors] == [child.pid]
        child.wait(timeout=5)
        assert child.poll() is not None
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)


async def test_failure_cleanup_reaps_registry_child_before_create_ack(tmp_path):
    backend = BackendProcess(tmp_path / "backend")
    child_pids = []
    child_start_times = {}

    def same_child_is_alive(pid, start_time):
        return bool(start_time) and osplat.process_tree.is_alive(pid) and (
            osplat.process_tree.start_time(pid) == start_time
        )

    with pytest.raises(AssertionError, match="backend exited before requested shutdown"):
        async with backend:
            async with backend.connect() as ws:
                await ws.send(json.dumps({
                    "id": str(uuid.uuid4()),
                    "type": "terminal.create",
                    "payload": {
                        "pane_id": "regression-pane",
                        "agent_key": "terminal",
                        "cwd": str(backend.root),
                        "command": [
                            base_python_executable(),
                            "-c",
                            "import signal, time; s = getattr(signal, 'SIGHUP', None); "
                            "s is not None and signal.signal(s, signal.SIG_IGN); "
                            "from pathlib import Path; Path('child.ready').write_text('ready'); "
                            "time.sleep(60)",
                        ],
                        "cols": 100,
                        "rows": 30,
                        "create_generation": str(uuid.uuid4()),
                    },
                }))
                # Read the real backend's durable spawn record without reading
                # the terminal.create response that would teach the harness
                # which PID to track.
                async with asyncio.timeout(15):
                    while not child_pids:
                        entries = await asyncio.to_thread(
                            in_data_dir(backend.root / "data", pty_registry._load)
                        )
                        child_start_times = {
                            int(pid): entry.get("lstart", "")
                            for pid, entry in entries.items()
                        }
                        child_pids = list(child_start_times)
                        if not child_pids:
                            await asyncio.sleep(0.02)
                async with asyncio.timeout(15):
                    while not (backend.root / "child.ready").exists():
                        await asyncio.sleep(0.02)
                assert backend.children == set()
                backend.process.kill()
                await asyncio.to_thread(backend.process.wait, timeout=5)

    try:
        scenario = json.loads((backend.root / "scenario.json").read_text(encoding="utf-8"))
        # Windows' kill-on-close PTY job and registry recovery are both valid
        # cleanup owners. The harness's direct-PID fallback is not: the response
        # was withheld, so it must not discover the child.
        assert scenario["survivors"] == []
        assert scenario["children"] == []
        assert all(child_start_times.values())
        async with asyncio.timeout(5):
            while any(
                same_child_is_alive(pid, start_time)
                for pid, start_time in child_start_times.items()
            ):
                await asyncio.sleep(0.02)
    finally:
        # Keep a failed cleanup assertion from leaking the deliberately orphaned
        # process into later tests; this runs only after the assertions above.
        for pid, start_time in child_start_times.items():
            if same_child_is_alive(pid, start_time):
                try:
                    await asyncio.to_thread(osplat.process_tree.kill_tree, pid, force=True)
                except (ProcessLookupError, PermissionError):
                    pass
        async with asyncio.timeout(5):
            while any(
                same_child_is_alive(pid, start_time)
                for pid, start_time in child_start_times.items()
            ):
                await asyncio.sleep(0.02)


def test_readiness_waits_for_discovery_file_contents(tmp_path):
    backend = BackendProcess(tmp_path)
    port = tmp_path / "data" / "backend-port"
    token = tmp_path / "data" / "backend-ws-token"
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        number = listener.getsockname()[1]
        assert backend._discovery_url() is None
        port.touch()
        token.touch()
        assert backend._discovery_url() is None
        port.write_text(str(number))
        assert backend._discovery_url() is None
        token.write_text("fixture-token")
        assert backend._discovery_url() == f"ws://127.0.0.1:{number}/ws?t=fixture-token"


def test_readiness_does_not_read_the_token_before_the_port_listens(tmp_path):
    """The backend mints the token before it serves; until it listens, the
    token may still be mid-os.replace, which Windows refuses to open."""
    backend = BackendProcess(tmp_path)
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))  # bound, never listening
        number = reserved.getsockname()[1]
        (tmp_path / "data" / "backend-port").write_text(str(number))
        # A directory in the token's place fails any read, so returning None
        # here proves the read was never attempted.
        (tmp_path / "data" / "backend-ws-token").mkdir()
        assert backend._discovery_url() is None


@pytest.mark.parametrize("exit_kind", ["clean", "crash"])
async def test_harness_rejects_backend_exit_before_requested_shutdown(tmp_path, exit_kind):
    with pytest.raises(AssertionError, match=r"backend exited before requested shutdown.*exit code"):
        async with BackendProcess(tmp_path) as backend:
            # Even a clean exit is unexpected while the scenario still owns
            # a live backend. Reap it before leaving to make this deterministic.
            if exit_kind == "clean":
                backend.process.stdin.write("shutdown\n")
                backend.process.stdin.flush()
            else:
                backend.process.kill()
            code = await asyncio.to_thread(backend.process.wait, timeout=15)
            assert (code == 0) == (exit_kind == "clean")
    diagnostic = json.loads((tmp_path / "scenario.json").read_text(encoding="utf-8"))
    assert diagnostic["backend_exit_code"] == code
    assert "before requested shutdown" in diagnostic["backend_exit_error"]


async def test_harness_rejects_nonzero_backend_shutdown(tmp_path, monkeypatch):
    original_popen = subprocess.Popen
    entry = "tests.cli_regression.support.backend_entry"
    # Run the real backend through normal startup and cooperative shutdown,
    # then model a process-level failure after its children have been reaped.
    driver = f"""
import runpy
try:
    runpy.run_module({entry!r}, run_name='__main__')
except SystemExit as result:
    if result.code:
        raise
    raise SystemExit(23)
"""

    def failed_shutdown_process(args, *rest, **kwargs):
        if args[1:3] == ["-m", entry]:
            args = [args[0], "-c", driver, *args[3:]]
        return original_popen(args, *rest, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", failed_shutdown_process)
    with pytest.raises(AssertionError, match=r"backend shutdown failed.*exit code 23"):
        async with BackendProcess(tmp_path) as backend:
            assert backend.process.poll() is None
    diagnostic = json.loads((tmp_path / "scenario.json").read_text(encoding="utf-8"))
    assert diagnostic["backend_exit_code"] == 23
    assert "shutdown failed" in diagnostic["backend_exit_error"]
