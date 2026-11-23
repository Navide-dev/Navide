"""NAVIDE_SHUTDOWN_DIAG: the stack dump a hung backend writes on SIGUSR1.

Only the cli_regression harness sets it; every real launch must register
nothing, exactly as before the variable existed."""

from __future__ import annotations

import asyncio
import signal
import subprocess
import sys

import pytest

from agent_team_backend import __main__ as backend_main
from tests.cli_regression.support import backend_process
from tests.cli_regression.support.backend_process import BackendProcess


@pytest.fixture
def registered(monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    calls: list[tuple] = []
    # faulthandler.register does not exist on Windows; main() never reaches it
    # there (no SIGUSR1), and the fake is what proves that.
    monkeypatch.setattr(
        backend_main.faulthandler, "register",
        lambda *args, **kwargs: calls.append((args, kwargs)), raising=False,
    )
    return calls


@pytest.mark.parametrize("environ", [{}, {"NAVIDE_SHUTDOWN_DIAG": "0"}, {"NAVIDE_SHUTDOWN_DIAG": ""}])
def test_a_real_launch_registers_nothing(registered: list, environ: dict) -> None:
    assert backend_main._register_shutdown_diag(environ) is False
    assert registered == []


def test_a_platform_without_sigusr1_registers_nothing(
    registered: list, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(signal, "SIGUSR1", raising=False)
    assert backend_main._register_shutdown_diag({"NAVIDE_SHUTDOWN_DIAG": "1"}) is False
    assert registered == []


@pytest.mark.skipif(not hasattr(signal, "SIGUSR1"), reason="no SIGUSR1 on this platform")
def test_the_harness_variable_registers_an_all_threads_dump(registered: list) -> None:
    assert backend_main._register_shutdown_diag({"NAVIDE_SHUTDOWN_DIAG": "1"}) is True
    assert registered == [((signal.SIGUSR1,), {"file": sys.stderr, "all_threads": True})]


def test_the_harness_sets_the_variable(tmp_path) -> None:
    assert BackendProcess(tmp_path).env["NAVIDE_SHUTDOWN_DIAG"] == "1"


@pytest.mark.skipif(not hasattr(signal, "SIGUSR1"), reason="no SIGUSR1 on this platform")
async def test_a_hung_backend_writes_its_stacks_before_it_is_killed(tmp_path) -> None:
    # Stands in for a backend stuck in teardown: it registers the dump the way
    # main() does under the variable, then never exits.
    hung = (
        "import faulthandler, signal, sys, time\n"
        "faulthandler.register(signal.SIGUSR1, file=sys.stderr, all_threads=True)\n"
        "print('ready', flush=True)\n"
        "def stuck_in_teardown():\n"
        "    time.sleep(60)\n"
        "stuck_in_teardown()\n"
    )
    log_path = tmp_path / "backend.log"
    with log_path.open("w", encoding="utf-8") as log:
        proc = subprocess.Popen([sys.executable, "-c", hung], stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = asyncio.get_running_loop().time() + 10
            while "ready" not in log_path.read_text(encoding="utf-8"):
                assert asyncio.get_running_loop().time() < deadline, "child never got ready"
                await asyncio.sleep(0.02)
            harness = BackendProcess(tmp_path)
            harness.process = proc
            await harness._dump_stacks()
            assert proc.poll() is None  # the dump does not end it; the kill does
        finally:
            proc.kill()
            proc.wait(5)
    dump = log_path.read_text(encoding="utf-8")
    assert "most recent call first" in dump and "stuck_in_teardown" in dump


def test_the_dump_wait_is_short() -> None:
    # It runs after the 15 s shutdown wait, which it must not stand in for.
    assert 1 <= backend_process._STACK_DUMP_WAIT_S <= 2


@pytest.fixture
def armed(monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    calls: list[tuple] = []
    monkeypatch.setattr(
        backend_main.faulthandler, "dump_traceback_later",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )
    return calls


def test_without_sigusr1_the_harness_variable_arms_a_timed_dump(
    armed: list, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(signal, "SIGUSR1", raising=False)
    assert backend_main._arm_shutdown_dump({"NAVIDE_SHUTDOWN_DIAG": "1"}) is True
    assert armed == [((backend_main._SHUTDOWN_DUMP_AFTER_S,), {"file": sys.stderr})]


@pytest.mark.parametrize("environ", [{}, {"NAVIDE_SHUTDOWN_DIAG": "0"}])
def test_a_real_launch_arms_no_timed_dump(
    armed: list, monkeypatch: pytest.MonkeyPatch, environ: dict,
) -> None:
    monkeypatch.delattr(signal, "SIGUSR1", raising=False)
    assert backend_main._arm_shutdown_dump(environ) is False
    assert armed == []


@pytest.mark.skipif(not hasattr(signal, "SIGUSR1"), reason="no SIGUSR1 on this platform")
def test_with_sigusr1_the_signal_dump_is_used_instead(armed: list) -> None:
    assert backend_main._arm_shutdown_dump({"NAVIDE_SHUTDOWN_DIAG": "1"}) is False
    assert armed == []


def test_the_shutdown_line_arms_the_dump(monkeypatch: pytest.MonkeyPatch) -> None:
    import io

    calls: list[None] = []
    monkeypatch.setattr(backend_main, "_arm_shutdown_dump", lambda: calls.append(None))
    server = type("_Server", (), {"should_exit": False})()
    backend_main._watch_stdin_for_shutdown(server, io.StringIO(f"{backend_main.SHUTDOWN_LINE}\n"))
    assert server.should_exit is True and calls == [None]


def test_the_timed_dump_fires_inside_the_harness_wait() -> None:
    # The harness waits 15 s for the exit, then kills; the dump must land first,
    # and a backend that shuts down normally must be gone long before it.
    assert 5 <= backend_main._SHUTDOWN_DUMP_AFTER_S <= 12


async def test_a_hung_backend_without_sigusr1_writes_its_stacks(tmp_path) -> None:
    # A Windows-shaped backend (no SIGUSR1) that gets the shutdown line and then
    # never exits: the harness's signal dump is a no-op there, so this timed one
    # is the only record of where it stopped. Isolated env: importing the
    # backend's main module must not touch a real data dir.
    from tests.cli_regression.support.isolation import isolated_environment

    hung = (
        "import io, signal, sys, time\n"
        "if hasattr(signal, 'SIGUSR1'): del signal.SIGUSR1\n"
        "from agent_team_backend import __main__ as m\n"
        "m._SHUTDOWN_DUMP_AFTER_S = 0.5\n"
        "server = type('S', (), {'should_exit': False})()\n"
        "m._watch_stdin_for_shutdown(server, io.StringIO(m.SHUTDOWN_LINE + '\\n'))\n"
        "print('shutdown requested', flush=True)\n"
        "def stuck_in_startup():\n"
        "    time.sleep(60)\n"
        "stuck_in_startup()\n"
    )
    env = isolated_environment(tmp_path)
    env["NAVIDE_SHUTDOWN_DIAG"] = "1"
    env["PYTHONPATH"] = str(backend_process.Path(backend_process.__file__).resolve().parents[3])
    log_path = tmp_path / "backend.log"
    with log_path.open("w", encoding="utf-8") as log:
        proc = subprocess.Popen(
            [sys.executable, "-c", hung], stdout=log, stderr=subprocess.STDOUT, env=env,
            cwd=env["PYTHONPATH"],
        )
        try:
            deadline = asyncio.get_running_loop().time() + 30
            while "stuck_in_startup" not in log_path.read_text(encoding="utf-8"):
                assert proc.poll() is None, log_path.read_text(encoding="utf-8")
                assert asyncio.get_running_loop().time() < deadline, "no stack dump was written"
                await asyncio.sleep(0.05)
            assert proc.poll() is None  # the dump does not end it; the kill does
        finally:
            proc.kill()
            proc.wait(5)
    dump = log_path.read_text(encoding="utf-8")
    assert "shutdown requested" in dump and "most recent call first" in dump
