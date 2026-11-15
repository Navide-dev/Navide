"""The seam to the Rust CLI runtime when the process misbehaves.

``test_cli_runtime_parity.py`` shows that the runtime's answers are main's.
This file shows that a process which stalls, dies or is missing can never stop
a reader: the call times out or fails over to the Python reader, the switch
can always be turned off at once, a crash loop is given up on, and
``status()`` says who answered.

The misbehaving processes are small scripts started in place of the binary
(``NAVIDE_CLI_RUNTIME_BIN``).
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

import pytest

from agent_team_backend import cli_runtime, osplat
from agent_team_backend.cli_vendors.registry import vendor as cli_vendor
from tests import cli_runtime_build
from tests import test_cli_runtime_parity as parity

pytestmark = pytest.mark.skipif(osplat.platform_id == "win32", reason="the stand-in processes are #! scripts")

#: Answers the handshake (it observes qwen), then reads requests and never answers.
STALLS = """
seen = open(sys.argv[0] + ".log", "a")
for line in sys.stdin:
    request = json.loads(line)
    seen.write(request["op"] + "\\n")
    seen.flush()
    if request["op"] == "observes":
        print(json.dumps({"id": request["id"], "ok": True, "result": __OBSERVES__}), flush=True)
"""

#: Exits as soon as it starts.
DIES = """
with open(sys.argv[0] + ".log", "a") as seen:
    seen.write("start\\n")
sys.exit(3)
"""


def _observes(**runtime: str) -> dict:
    """The handshake answer of a process built from this checkout (it observes
    qwen); ``runtime`` overrides what it says its build is."""
    build = {"version": cli_runtime.RUNTIME_VERSION, "declarations": cli_runtime._declarations_fingerprint(), **runtime}
    return {"qwen": {"cwd": "written"}, cli_runtime.RUNTIME_KEY: build}


def _stand_in(tmp_path: Path, body: str, observes: dict | None = None) -> Path:
    """A script that runs in place of the binary; ``__OBSERVES__`` in its body
    is its handshake answer (by default a process built from this checkout)."""
    script = tmp_path / "stand-in-runtime"
    body = body.replace("__OBSERVES__", repr(observes if observes is not None else _observes()))
    script.write_text(f"#!{sys.executable}\nimport json, sys\n{body}", encoding="utf-8")
    script.chmod(0o755)
    return script


def _seen(script: Path) -> list[str]:
    log_file = Path(str(script) + ".log")
    return log_file.read_text(encoding="utf-8").split() if log_file.exists() else []


@pytest.fixture
def routes(pytestconfig: pytest.Config) -> int:
    """How many routes one reader call passes through: `wrap` routes the
    instance, and under ``-p tests.cli_runtime_on`` the class is routed as
    well. A call the runtime declines is counted once by each."""
    return 2 if pytestconfig.pluginmanager.has_plugin("tests.cli_runtime_on") else 1


def _wait_for(done: Callable[[], bool], seconds: float = 10.0) -> None:
    deadline = time.monotonic() + seconds
    while not done():
        assert time.monotonic() < deadline, "timed out waiting"
        time.sleep(0.02)


@pytest.fixture
def seam(monkeypatch: pytest.MonkeyPatch):
    """The switch off and the counters empty; both as they were afterwards."""
    before = cli_runtime.enabled()
    monkeypatch.setattr(cli_runtime, "_counts", {})
    cli_runtime.apply(False)
    yield cli_runtime
    cli_runtime.apply(False)
    cli_runtime.apply(before)


def _qwen(tmp_path: Path) -> tuple[Any, Path]:
    """A wrapped reader and an empty chat it can read."""
    chat = tmp_path / "chat.jsonl"
    chat.write_text("", encoding="utf-8")
    return cli_runtime.wrap(cli_vendor("qwen").make_log_reader()), chat


def test_a_stalled_process_times_out_and_python_answers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam,
                                                        routes: int) -> None:
    exe = _stand_in(tmp_path, STALLS)
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(exe))
    monkeypatch.setattr(cli_runtime, "CALL_TIMEOUT_S", 0.4)
    monkeypatch.setattr(cli_runtime, "BACKOFF_BASE_S", 1000.0)
    scenario = parity._scenarios()["qwen_0_25"]
    expected = parity._run(scenario, tmp_path / "py", parity._python_reader("qwen"), monkeypatch)
    seam.apply(True)
    started = time.monotonic()
    wrapped = parity._run(scenario, tmp_path / "rt",
                          lambda: cli_runtime.wrap(cli_vendor("qwen").make_log_reader()), monkeypatch)
    assert time.monotonic() - started < 5.0, "one timeout, then no more waiting"
    assert parity._compared(wrapped).replace("/rt", "/py") == parity._compared(expected)
    # The stalled process got exactly one reader call, was killed, and is not
    # started again before its delay.
    assert _seen(exe) == ["observes", "usage"]
    counts = seam.status()["calls"]["qwen"]
    assert counts["rust"] == 0
    # Every routed call is one fallback: usage and activity for each step, the
    # turns call, and the `parse_activity` that Python's own turns read makes
    # through the reader (a routed method too), once per route.
    assert counts["fallback"] == (2 * len(scenario["steps"]) + 1 + 1) * routes
    assert seam.status()["state"] == "waiting-to-restart"


def test_switching_off_returns_at_once_and_frees_a_stalled_call(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                                seam) -> None:
    exe = _stand_in(tmp_path, STALLS)
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(exe))
    monkeypatch.setattr(cli_runtime, "CALL_TIMEOUT_S", 120.0)
    reader, chat = _qwen(tmp_path)
    seam.apply(True)
    results: list[Any] = []
    caller = threading.Thread(target=lambda: results.append(reader.parse_incremental(chat, {})), daemon=True)
    caller.start()
    _wait_for(lambda: "usage" in _seen(exe))
    assert caller.is_alive(), "the call is waiting on the stalled process"

    started = time.monotonic()
    seam.apply(False)
    assert time.monotonic() - started < 1.0, "the escape hatch does not wait for the call"

    caller.join(5.0)
    assert not caller.is_alive(), "killing the process woke the waiting call"
    assert results and results[0].events == []
    assert seam.status()["state"] == "off"


def test_a_process_that_keeps_dying_is_given_up_on_and_said_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                                 seam, caplog: pytest.LogCaptureFixture) -> None:
    exe = _stand_in(tmp_path, DIES)
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(exe))
    monkeypatch.setattr(cli_runtime, "BACKOFF_BASE_S", 0.0)
    monkeypatch.setattr(cli_runtime, "BREAKER_FAILURES", 3)
    reader, chat = _qwen(tmp_path)
    seam.apply(True)
    with caplog.at_level(logging.WARNING, logger=cli_runtime.log.name):
        for _ in range(8):
            assert reader.parse_incremental(chat, {}).events == []
    assert _seen(exe) == ["start"] * 3, "three starts, then none"
    assert seam.status()["state"] == "stopped-after-failures"
    assert len([r for r in caplog.records if "in a row" in r.getMessage()]) == 1

    # Flipping the switch is the way back: the process is started again.
    seam.apply(False)
    seam.apply(True)
    reader.parse_incremental(chat, {})
    assert len(_seen(exe)) > 3


def test_a_failed_process_is_not_restarted_before_its_delay(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                            seam) -> None:
    exe = _stand_in(tmp_path, DIES)
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(exe))
    monkeypatch.setattr(cli_runtime, "BACKOFF_BASE_S", 1000.0)
    reader, chat = _qwen(tmp_path)
    seam.apply(True)
    for _ in range(6):
        reader.parse_incremental(chat, {})
    assert _seen(exe) == ["start"]
    assert seam.status()["state"] == "waiting-to-restart"
    assert seam.status()["failures"] == 1


#: Answers the handshake, reads `sys.argv[0].count` usage requests without
#: answering any, then exits: every caller is waiting when it dies.
DIES_WITH_CALLERS_WAITING = """
waiting = 0
for line in sys.stdin:
    request = json.loads(line)
    if request["op"] == "observes":
        print(json.dumps({"id": request["id"], "ok": True, "result": __OBSERVES__}), flush=True)
        continue
    waiting += 1
    if waiting == int(open(sys.argv[0] + ".count").read()):
        sys.exit(3)
"""


def test_one_dead_process_is_one_failure_however_many_callers_waited(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                                     seam, routes: int) -> None:
    callers = cli_runtime.BREAKER_FAILURES + 3
    exe = _stand_in(tmp_path, DIES_WITH_CALLERS_WAITING)
    Path(str(exe) + ".count").write_text(str(callers), encoding="utf-8")
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(exe))
    monkeypatch.setattr(cli_runtime, "BACKOFF_BASE_S", 1000.0)
    reader, chat = _qwen(tmp_path)
    seam.apply(True)
    # One call first, so the process is up and has said what it observes:
    # every thread below then goes straight to its own request.
    assert cli_runtime._client_for_call() is not None and cli_runtime._observed(cli_runtime._client) == {
        "qwen": {"cwd": "written"}}, "the CLIs it observes, without the build's identity"

    start = threading.Barrier(callers)
    results: list[Any] = []

    def call() -> None:
        start.wait(10.0)
        results.append(reader.parse_incremental(chat, {}))

    threads = [threading.Thread(target=call, daemon=True) for _ in range(callers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(15.0)
    assert not any(thread.is_alive() for thread in threads)
    assert len(results) == callers and all(result.events == [] for result in results), "Python answered every caller"

    status = seam.status()
    assert status["failures"] == 1, "the process died once"
    assert status["state"] == "waiting-to-restart", "one death does not trip the breaker"
    assert status["calls"]["qwen"]["fallback"] == callers * routes


def test_one_failed_start_is_one_attempt_and_one_failure_however_many_callers_wanted_it(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam) -> None:
    callers = cli_runtime.BREAKER_FAILURES + 3
    present = tmp_path / "navide-cli-runtime"
    present.write_text("", encoding="utf-8")
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(present))
    monkeypatch.setattr(cli_runtime, "BACKOFF_BASE_S", 1000.0)
    attempts: list[int] = []
    meet = threading.Barrier(callers)

    def popen_fails(_exe: Path) -> Any:
        attempts.append(1)
        try:
            meet.wait(1.0)  # every caller that tries to start is here together, if any but one does
        except threading.BrokenBarrierError:
            pass
        raise OSError("EAGAIN: the process limit")

    monkeypatch.setattr(cli_runtime, "_Client", popen_fails)
    reader, chat = _qwen(tmp_path)
    seam.apply(True)

    start = threading.Barrier(callers)
    results: list[Any] = []

    def call() -> None:
        start.wait(10.0)
        results.append(reader.parse_incremental(chat, {}))

    threads = [threading.Thread(target=call, daemon=True) for _ in range(callers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(15.0)
    assert not any(thread.is_alive() for thread in threads)
    assert len(results) == callers and all(result.events == [] for result in results), "Python answered every caller"

    assert len(attempts) == 1, "one caller started the process; the rest used Python for that call"
    status = seam.status()
    assert status["failures"] == 1, "the start failed once"
    assert status["state"] == "waiting-to-restart", "one failed start does not trip the breaker"


def test_a_start_that_cannot_get_a_thread_falls_back_backs_off_and_kills_the_child(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam) -> None:
    exe = _stand_in(tmp_path, STALLS)
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(exe))
    monkeypatch.setattr(cli_runtime, "BACKOFF_BASE_S", 1000.0)
    children: list[Any] = []
    real_popen = subprocess.Popen

    def popen(*args: Any, **kwargs: Any) -> Any:
        children.append(real_popen(*args, **kwargs))  # the start itself succeeds
        return children[-1]

    class OutOfThreads(threading.Thread):
        def start(self) -> None:
            if self.name == "cli-runtime-read":
                raise RuntimeError("can't start new thread")
            super().start()

    monkeypatch.setattr(cli_runtime.subprocess, "Popen", popen)
    monkeypatch.setattr(cli_runtime, "threading", SimpleNamespace(Thread=OutOfThreads, Lock=threading.Lock,
                                                                  Event=threading.Event, local=threading.local))
    reader, chat = _qwen(tmp_path)
    seam.apply(True)

    assert reader.parse_incremental(chat, {}).events == [], "Python answered"
    status = seam.status()
    assert status["failures"] == 1 and status["state"] == "waiting-to-restart"
    assert len(children) == 1 and children[0].poll() is not None, "the child was killed and reaped"


def test_calls_during_a_start_are_deferred_not_faults_and_the_state_says_starting(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam, caplog: pytest.LogCaptureFixture) -> None:
    present = tmp_path / "navide-cli-runtime"
    present.write_text("", encoding="utf-8")
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(present))
    monkeypatch.setattr(cli_runtime, "BACKOFF_BASE_S", 1000.0)
    monkeypatch.setattr(cli_runtime, "SLOW_START_S", 0.05)
    entered, release = threading.Event(), threading.Event()

    def held_start(_exe: Path) -> Any:
        entered.set()
        release.wait(10.0)
        raise OSError("the start failed in the end")

    monkeypatch.setattr(cli_runtime, "_Client", held_start)
    seam.apply(True)
    starter = threading.Thread(target=lambda: cli_runtime._call("qwen", "usage"), daemon=True)
    starter.start()
    assert entered.wait(10.0)
    assert seam.status()["state"] == "starting"

    with caplog.at_level(logging.WARNING, logger=cli_runtime.log.name):
        time.sleep(0.1)
        for _ in range(3):
            assert cli_runtime._call("qwen", "usage") is None
    assert seam.status()["calls"] == {"qwen": {"rust": 0, "unsupported": 0, "unreadable": 0, "python": 0, "deferred": 3,
                                               "fallback": 0}}
    assert len([r for r in caplog.records if "has been starting" in r.getMessage()]) == 1, "said once"

    release.set()
    starter.join(10.0)
    assert not starter.is_alive()
    status = seam.status()
    assert status["state"] == "waiting-to-restart" and status["failures"] == 1


class _LateClient:
    """What a start returns after it was given up on: only ended, never used."""

    dead = False
    generation = 0

    def __init__(self) -> None:
        self.killed = threading.Event()

    def kill(self) -> None:
        self.killed.set()

    def close(self) -> None:
        pass


def _held_start(monkeypatch: pytest.MonkeyPatch, outcome: str = "comes up") -> tuple[threading.Event, threading.Event, _LateClient]:
    """Make `_Client(...)` block until released, then return a stand-in client
    (``outcome`` "comes up") or raise (``"fails"``)."""
    entered, release, late = threading.Event(), threading.Event(), _LateClient()

    def start(_exe: Path) -> Any:
        entered.set()
        release.wait(10.0)
        if outcome == "fails":
            raise OSError("the start failed in the end")
        return late

    monkeypatch.setattr(cli_runtime, "_Client", start)
    return entered, release, late


def _present_binary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    present = tmp_path / "navide-cli-runtime"
    present.write_text("", encoding="utf-8")
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(present))
    monkeypatch.setattr(cli_runtime, "BACKOFF_BASE_S", 1000.0)


def test_nothing_is_starting_while_the_binary_is_being_looked_for(monkeypatch: pytest.MonkeyPatch, seam) -> None:
    seam.apply(True)
    seen: list[tuple[str, dict]] = []
    looking = []

    def no_binary() -> None:
        # `status()` looks for the binary too: only the first look is the start's.
        if not looking:
            looking.append(True)
            state = seam.status()["state"]
            # A second caller arrives while the first is looking.
            assert cli_runtime._call("qwen", "usage") is None
            seen.append((state, seam.status()["calls"]))
        return None

    monkeypatch.setattr(cli_runtime, "binary", no_binary)
    assert cli_runtime._client_for_call() is None
    assert seen == [("idle", {})], "no start was in flight, and the second caller was not counted as stepping aside"
    assert seam.status()["state"] == "idle" and seam.status()["failures"] == 0


@pytest.mark.parametrize("late", ["comes up", "fails"])
def test_a_start_past_its_deadline_is_abandoned_and_what_it_returns_later_is_not_used(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam, late: str) -> None:
    _present_binary(tmp_path, monkeypatch)
    monkeypatch.setattr(cli_runtime, "START_DEADLINE_S", 0.05)
    entered, release, client = _held_start(monkeypatch, late)
    seam.apply(True)
    results: list[Any] = []
    starter = threading.Thread(target=lambda: results.append(cli_runtime._client_for_call()), daemon=True)
    starter.start()
    assert entered.wait(10.0)
    assert seam.status()["state"] == "starting"
    time.sleep(0.1)

    assert cli_runtime._client_for_call() is None, "this caller found the start past its deadline"
    status = seam.status()
    assert status["state"] == "waiting-to-restart" and status["failures"] == 1, "abandoned: one failed start"

    release.set()
    starter.join(10.0)
    assert not starter.is_alive()
    assert results == [None] and cli_runtime._client is None, "the late result was not installed"
    if late == "comes up":
        assert client.killed.wait(5.0), "the late process was ended"
    assert seam.status()["failures"] == 1, "the late start did not count a second failure"


def test_a_start_that_began_before_the_switch_went_off_and_on_installs_nothing(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam) -> None:
    _present_binary(tmp_path, monkeypatch)
    entered, release, client = _held_start(monkeypatch)
    seam.apply(True)
    results: list[Any] = []
    starter = threading.Thread(target=lambda: results.append(cli_runtime._client_for_call()), daemon=True)
    starter.start()
    assert entered.wait(10.0)

    seam.apply(False)
    seam.apply(True)
    assert seam.status()["state"] == "idle", "applying the switch ends the start in flight"
    release.set()
    starter.join(10.0)
    assert not starter.is_alive()
    assert results == [None] and cli_runtime._client is None, "the start from before the flip installed nothing"
    assert client.killed.wait(5.0), "its process was ended"


def test_wrapping_a_reader_twice_routes_it_once(seam) -> None:
    reader = cli_runtime.wrap(cli_vendor("qwen").make_log_reader())
    routed = {name: getattr(reader, name) for name, _ in cli_runtime.ROUTES}
    assert cli_runtime.wrap(reader) is reader
    assert {name: getattr(reader, name) for name in routed} == routed, "the second wrap replaced nothing"


def test_a_call_that_arrives_as_the_process_dies_does_not_wait_out_its_timeout(tmp_path: Path) -> None:
    client = cli_runtime._Client(_stand_in(tmp_path, STALLS))

    class DiesBeforeTheNextId:
        """Between a call's start and its registration, the process goes."""

        def __next__(self) -> int:
            client.kill()
            _wait_for(lambda: client.dead)
            return 1

    client._ids = DiesBeforeTheNextId()
    started = time.monotonic()
    with pytest.raises(OSError, match="exited"):
        client.call("usage", 30.0)
    assert time.monotonic() - started < 5.0
    client.close()


#: Answers every reader call with an error of the kind a panic gives.
ANSWERS_PANIC = """
for line in sys.stdin:
    request = json.loads(line)
    if request["op"] == "observes":
        print(json.dumps({"id": request["id"], "ok": True, "result": __OBSERVES__}), flush=True)
    else:
        print(json.dumps({"id": request["id"], "ok": False, "kind": "panic", "error": "panic: a rule"}), flush=True)
"""


def test_an_error_answered_on_every_poll_is_logged_once_and_counted_every_time(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam, caplog: pytest.LogCaptureFixture, routes: int) -> None:
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(_stand_in(tmp_path, ANSWERS_PANIC)))
    reader, chat = _qwen(tmp_path)
    seam.apply(True)
    with caplog.at_level(logging.WARNING, logger=cli_runtime.log.name):
        for _ in range(5):
            assert reader.parse_incremental(chat, {}).events == []
    assert len([r for r in caplog.records if "could not answer" in r.getMessage()]) == 1
    assert seam.status()["calls"]["qwen"]["fallback"] == 5 * routes  # every poll, once per route
    assert seam.status()["state"] == "running", "an error answer is not a dead process"


def test_a_call_after_shutdown_does_not_start_the_process_again(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                                seam) -> None:
    exe = _stand_in(tmp_path, STALLS)
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(exe))
    monkeypatch.setattr(cli_runtime, "CALL_TIMEOUT_S", 0.3)
    reader, chat = _qwen(tmp_path)
    seam.apply(True)
    assert cli_runtime._client_for_call() is not None
    seam.shutdown()

    assert reader.parse_incremental(chat, {}).events == []
    assert cli_runtime._client is None and _seen(exe) == [], "no process was asked anything"
    # Applying the switch is what lets it start again.
    seam.apply(True)
    assert cli_runtime._client_for_call() is not None


def test_switched_on_without_a_binary_says_so_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam,
                                                   caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(tmp_path / "missing"))
    reader, chat = _qwen(tmp_path)
    with caplog.at_level(logging.WARNING, logger=cli_runtime.log.name):
        seam.apply(True)
        seam.apply(True)
        for _ in range(3):
            assert reader.parse_incremental(chat, {}).events == []
    assert len([r for r in caplog.records if "was not found" in r.getMessage()]) == 1
    status = seam.status()
    assert status["enabled"] is True and status["binary"] is False and status["calls"] == {}


def test_the_binary_is_looked_up_like_the_other_sidecars(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    name = osplat.paths.bundled_executable("navide-cli-runtime")
    packaged = tmp_path / "resources" / "bin"
    packaged.mkdir(parents=True)
    (packaged / name).write_text("", encoding="utf-8")
    monkeypatch.delenv(cli_runtime.BINARY_ENV, raising=False)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(cli_runtime.frozen_env, "packaged_bin_dir", lambda: str(packaged))
    assert cli_runtime.binary() == packaged / name

    override = tmp_path / "my-build"
    override.write_text("", encoding="utf-8")
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(override))
    assert cli_runtime.binary() == override
    # A named binary that is not there is not quietly replaced by another.
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(tmp_path / "gone"))
    assert cli_runtime.binary() is None


def test_the_repository_build_is_looked_for_only_outside_the_packaged_backend(tmp_path: Path,
                                                                              monkeypatch: pytest.MonkeyPatch) -> None:
    built = cli_runtime_build.binary()  # the repository's release build exists now
    name = osplat.paths.bundled_executable("navide-cli-runtime")
    packaged = tmp_path / "resources" / "bin"
    packaged.mkdir(parents=True)
    monkeypatch.delenv(cli_runtime.BINARY_ENV, raising=False)
    monkeypatch.setattr(cli_runtime.frozen_env, "packaged_bin_dir", lambda: str(packaged))

    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert cli_runtime.binary() is None, "packaged: no sidecar there means none, whatever a source tree holds"

    monkeypatch.delattr(sys, "frozen", raising=False)
    (packaged / name).write_text("", encoding="utf-8")
    assert cli_runtime.binary() == built, "from source: the repository's build, not a packaged folder"


def test_a_binary_that_cannot_even_be_looked_for_is_no_binary(monkeypatch: pytest.MonkeyPatch, seam) -> None:
    def refuses(_self: Path) -> bool:
        raise PermissionError("a volume that refuses the lookup")

    monkeypatch.delenv(cli_runtime.BINARY_ENV, raising=False)
    monkeypatch.setattr(Path, "is_file", refuses)
    assert cli_runtime.binary() is None
    seam.apply(True)  # never raises
    assert seam.status()["binary"] is False


def test_the_seams_runtime_version_is_the_crates() -> None:
    manifest = (Path(__file__).resolve().parents[2] / "native" / "navide-cli-runtime" / "Cargo.toml").read_text(encoding="utf-8")
    versions = [line.split("=", 1)[1].strip().strip('"') for line in manifest.splitlines() if line.startswith("version =")]
    assert versions == [cli_runtime.RUNTIME_VERSION], "bump RUNTIME_VERSION with the crate's version"


def test_a_request_python_cannot_send_as_utf8_is_python_reads_it_and_the_process_is_left_alone(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam) -> None:
    exe = _stand_in(tmp_path, STALLS)
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(exe))
    monkeypatch.setattr(cli_runtime, "CALL_TIMEOUT_S", 30.0)  # a call that waited would show
    seam.apply(True)
    started = time.monotonic()
    undecodable = os.fsdecode(b"/chats/a\xffb.jsonl")  # surrogateescape: '\udcff'
    assert "\udcff" in undecodable
    assert cli_runtime._call("qwen", "usage", path=undecodable, checkpoint={}) is None
    assert cli_runtime._call("qwen", "usage", path="/chats/a.jsonl", checkpoint={"ratio": float("nan")}) is None
    assert time.monotonic() - started < 5.0, "nothing waited for an answer"
    status = seam.status()
    assert status["calls"]["qwen"]["python"] == 2 and status["calls"]["qwen"]["fallback"] == 0
    assert status["failures"] == 0 and status["state"] == "running", "the process was not killed or counted"
    assert _seen(exe) == ["observes"], "no request was sent"


#: Answers every reader call with the same error answer (`__ANSWER__`).
ANSWERS_ERROR = """
for line in sys.stdin:
    request = json.loads(line)
    if request["op"] == "observes":
        print(json.dumps({"id": request["id"], "ok": True, "result": __OBSERVES__}), flush=True)
    else:
        print(json.dumps({"id": request["id"], "ok": False, "kind": "request", "error": "bad request: a field"}), flush=True)
"""


def test_a_request_the_process_refuses_is_answered_at_once_and_does_not_count_against_it(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam) -> None:
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(_stand_in(tmp_path, ANSWERS_ERROR)))
    monkeypatch.setattr(cli_runtime, "CALL_TIMEOUT_S", 30.0)
    reader, chat = _qwen(tmp_path)
    seam.apply(True)
    started = time.monotonic()
    for _ in range(3):
        assert reader.parse_incremental(chat, {}).events == []
    assert time.monotonic() - started < 5.0
    assert seam.status()["failures"] == 0 and seam.status()["state"] == "running"


def test_the_binary_answers_a_request_it_cannot_parse_under_its_id() -> None:
    """The real binary, given what the backend no longer sends (a lone surrogate
    escape) and a field of the wrong type, answers each under its id at once."""
    done = subprocess.run([str(cli_runtime_build.binary()), "serve"], timeout=30, check=True, capture_output=True,
                          input=b'{"id":7,"op":"usage","path":"/a/\\udcff"}\n{"id":8,"op":"usage","bag":"x"}\n')
    answers = {answer["id"]: answer for answer in map(json.loads, done.stdout.splitlines())}
    assert (answers[7]["ok"], answers[7]["kind"]) == (False, "python")
    assert (answers[8]["ok"], answers[8]["kind"]) == (False, "request")


@pytest.mark.parametrize("runtime", [{"version": "9.9.9"}, {"declarations": "0" * 16}, None],
                         ids=["other version", "other declarations", "says nothing"])
def test_a_build_that_is_not_this_backends_counts_as_no_binary(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam, caplog: pytest.LogCaptureFixture, runtime: dict | None) -> None:
    observes = _observes(**(runtime or {}))
    if runtime is None:
        del observes[cli_runtime.RUNTIME_KEY]
    exe = _stand_in(tmp_path, STALLS, observes)
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(exe))
    reader, chat = _qwen(tmp_path)
    seam.apply(True)
    with caplog.at_level(logging.WARNING, logger=cli_runtime.log.name):
        for _ in range(4):
            assert reader.parse_incremental(chat, {}).events == []
    assert _seen(exe) == ["observes"], "it was asked what it is, then nothing, and not started again"
    status = seam.status()
    assert status["binary"] is False and status["runtime"]["unusable"]
    assert status["calls"].get("qwen", {}).get("fallback", 0) == 0, "not a fault"
    assert status["failures"] == 0
    assert len([r for r in caplog.records if "is not used" in r.getMessage()]) == 1, "said once"
    # Applying the switch asks again.
    seam.apply(True)
    assert seam.status()["runtime"]["unusable"] is None


#: Writes to stderr, then exits without answering.
DIES_LOUDLY = """
sys.stdin.readline()
sys.stderr.write("navide-cli-runtime: panic at src/observe/file.rs:99\\n" + "x" * 5000 + "\\n")
sys.stderr.flush()
sys.exit(3)
"""


def test_what_the_process_wrote_to_stderr_is_logged_once_bounded_when_it_dies(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(_stand_in(tmp_path, DIES_LOUDLY)))
    monkeypatch.setattr(cli_runtime, "BACKOFF_BASE_S", 1000.0)
    reader, chat = _qwen(tmp_path)
    seam.apply(True)
    with caplog.at_level(logging.WARNING, logger=cli_runtime.log.name):
        for _ in range(3):
            assert reader.parse_incremental(chat, {}).events == []
    said = [r.getMessage() for r in caplog.records if "stderr:" in r.getMessage()]
    assert len(said) == 1, "once, with the failure that counted the process"
    assert "panic at src/observe/file.rs:99" in said[0]
    assert len(said[0]) < 600, "bounded"


def test_an_answer_that_cannot_be_read_falls_back_to_python_not_into_the_watcher(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam, caplog: pytest.LogCaptureFixture) -> None:
    reader, chat = _qwen(tmp_path)
    seam.apply(True)
    # What the runtime answers: events with a field missing, a bag of the wrong type.
    answers = {"usage": {"events": [{"vendor": "qwen"}], "checkpoint": {}}, "activity": {"events": [], "bag": 5},
               "turns": {"turns": [{"turn_index": 1}]}}
    monkeypatch.setattr(cli_runtime, "_call", lambda vendor, op, **fields: (answers[op], {"cwd": "written"}))
    bag = {"kept"}
    with caplog.at_level(logging.WARNING, logger=cli_runtime.log.name):
        assert reader.parse_incremental(chat, {}).events == []
        assert reader.parse_activity(chat, bag) == [] and bag == {"kept"}, "the caller's bag was not touched"
        assert reader.turns_for_session(chat, "") == []
    assert len([r for r in caplog.records if "shape this backend cannot read" in r.getMessage()]) == 1, "said once per CLI"
    assert seam.status()["calls"]["qwen"]["fallback"] >= 3


@pytest.mark.parametrize("op", ["usage", "activity", "turns"])
@pytest.mark.parametrize("bad", ["no-result", "read-without-reason"])
def test_what_an_unreadable_answer_said_beside_its_result_is_not_applied_and_the_reader_reads(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam, no_read_problems, caplog: pytest.LogCaptureFixture,
        op: str, bad: str) -> None:
    """`notes` and `reads` are applied once the result is converted: an answer
    with no result, or a `reads` entry without its `reason`, falls back to the
    reader (the watcher sees no error) and writes nothing to the registry, not
    even the entries before the malformed one."""
    from tests.vendors import test_opencode as builders
    import sqlite3

    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    db = tmp_path / "opencode" / "opencode.db"
    db.parent.mkdir()
    con = sqlite3.connect(db)
    con.executescript(builders._SCHEMA)
    con.commit()
    con.close()
    reader = cli_runtime.wrap(cli_vendor("opencode").make_log_reader())
    seam.apply(True)

    reads = [{"ok": False, "key": "first", "reason": "query-failed", "detail": "d", "status": "unreadable"},
             {"ok": False, "key": "second", "detail": "d", "status": "unreadable"}]  # no `reason`
    results = {"usage": {"events": [], "checkpoint": {}}, "activity": {"events": [], "bag": []}, "turns": {"turns": []}}
    answer = None if bad == "no-result" else {**results[op], "reads": reads}
    monkeypatch.setattr(cli_runtime, "_call", lambda vendor, op_, **fields: (answer, {"cwd": "written"}))

    with caplog.at_level(logging.WARNING, logger=cli_runtime.log.name):
        if op == "usage":
            assert reader.parse_incremental(db, {}).events == []
        elif op == "activity":
            assert reader.parse_activity(db, set()) == []
        else:
            assert reader.turns_for_session(db, "") == []
    assert no_read_problems.read_problem("opencode") is None, "nothing was written to the registry"
    assert len([r for r in caplog.records if "shape this backend cannot read" in r.getMessage()]) == 1
    assert seam.status()["calls"]["opencode"]["fallback"] >= 1


def test_status_counts_who_answered(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam) -> None:
    cli_runtime_build.binary()
    scenario = parity._scenarios()["qwen_0_25"]
    seam.apply(True)
    parity._run(scenario, tmp_path, lambda: cli_runtime.wrap(cli_vendor("qwen").make_log_reader()), monkeypatch)
    status = seam.status()
    assert status["state"] == "running" and status["failures"] == 0
    assert status["calls"] == {"qwen": {"rust": 2 * len(scenario["steps"]) + 1, "unsupported": 0, "unreadable": 0,
                                        "python": 0, "deferred": 0, "fallback": 0}}
    # The process said which build it is, and it is the one this backend is written for.
    assert status["runtime"]["unusable"] is None and status["runtime"]["version"] == cli_runtime.RUNTIME_VERSION
    assert status["runtime"]["declarations"] == cli_runtime._declarations_fingerprint()
    seam.shutdown()
    assert seam.status()["state"] == "idle"


def test_the_cost_ledgers_own_readers_go_through_the_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    """The ledger builds a Claude and a Codex reader of its own; they are routed like the backend's."""
    from agent_team_backend import cost_ledger

    wrapped: list[str] = []
    real_wrap = cli_runtime.wrap

    def recording(reader: Any) -> Any:
        wrapped.append(str(reader.vendor))
        return real_wrap(reader)

    monkeypatch.setattr(cli_runtime, "wrap", recording)
    monkeypatch.setattr(cost_ledger, "_claude_reader", None)
    usage = cost_ledger.TokenUsage(vendor="claude", input_tokens=1, output_tokens=1, cwd="/w", session_id="s",
                                   file_path="/nowhere/s.jsonl", dedup_key="k")
    cost_ledger.transcript_cwd(usage)
    cost_ledger.transcript_cwd(usage)  # built once, kept
    assert wrapped == ["claude"]

    # The backfill command: both readers, wrapped, before any file is read.
    handed_over: list[Any] = []
    monkeypatch.setattr(cost_ledger, "CostLedger", lambda _db: None)
    monkeypatch.setattr(cost_ledger, "Database", lambda _path: None)
    monkeypatch.setattr(cost_ledger, "backfill", lambda _ledger, readers: handed_over.extend(readers) or (0, 0))
    assert cost_ledger.main(["backfill", "unused.db"]) == 0
    assert wrapped == ["claude", "claude", "codex"]
    assert [reader.parse_incremental.__name__ for reader in handed_over] == ["routed", "routed"]


@pytest.fixture
def no_read_problems():
    from agent_team_backend.cli_vendors import opencode

    opencode._READ_PROBLEMS.clear()
    yield opencode
    opencode._READ_PROBLEMS.clear()


def test_what_the_schema_check_finds_reaches_the_readers_problem_registry(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam, no_read_problems) -> None:
    """The runtime read the store; the CLI's status must say what main's reader would."""
    cli_runtime_build.binary()
    import sqlite3

    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    db = tmp_path / "opencode" / "opencode.db"
    db.parent.mkdir()
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE conversation_v3 (id TEXT)")
    con.commit()
    reader = cli_runtime.wrap(cli_vendor("opencode").make_log_reader())
    seam.apply(True)

    assert reader.parse_incremental(db, {}).events == []
    problem = no_read_problems.read_problem("opencode")
    assert (problem["status"], problem["reason"], problem["detail"]) == ("unreadable", "unrecognized-schema",
                                                                         "tables: conversation_v3")
    assert problem["path"] == str(db)
    since = problem["since"]
    assert reader.parse_activity(db, set()) == []
    assert no_read_problems.read_problem("opencode")["since"] == since  # the same problem, not a new one

    # A schema it knows: the same entry is cleared by the read that now works.
    from tests.vendors import test_opencode as builders

    con.executescript("DROP TABLE conversation_v3;" + builders._SCHEMA)
    con.commit()
    con.close()
    reader.parse_incremental(db, {})
    assert no_read_problems.read_problem("opencode") is None
    calls = seam.status()["calls"]["opencode"]
    assert (calls["rust"], calls["unsupported"], calls["deferred"], calls["fallback"]) == (3, 0, 0, 0)


def test_a_failing_query_is_the_readers_to_record_and_to_clear(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam, no_read_problems) -> None:
    """The runtime declines a read whose query fails; main's reader makes it,
    records why, and keeps making it until it works and clears its entry."""
    cli_runtime_build.binary()
    import sqlite3

    from tests.vendors import test_opencode as builders

    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    db = tmp_path / "opencode" / "opencode.db"
    db.parent.mkdir()
    con = sqlite3.connect(db)
    # No `part` table: usage reads, activity cannot.
    con.executescript(builders._SCHEMA + "DROP TABLE part;")
    builders._add_session(con, "ses_a", "/ws")
    builders._add_message(con, "m1", "ses_a", builders._assistant_data({"input": 5, "output": 2}))
    reader = cli_runtime.wrap(cli_vendor("opencode").make_log_reader())
    seam.apply(True)

    def calls() -> tuple[int, int, int]:
        counts = seam.status()["calls"]["opencode"]
        return counts["rust"], counts["unsupported"], counts["deferred"]

    # (Counts are compared loosely where `-p tests.cli_runtime_on` routes the class as well as the instance.)
    assert len(reader.parse_incremental(db, {}).events) == 1
    assert calls() == (1, 0, 0)
    seen: set[str] = set()
    assert reader.parse_activity(db, seen) == []
    rust, declined, deferred = calls()
    assert (rust, deferred) == (1, 0) and declined > 0  # declined: the reader read it, and recorded why
    problem = no_read_problems.read_problem("opencode")
    assert problem["reason"] == "query-failed" and "no such table: part" in problem["detail"]

    # While the query is on record as failing, the reader makes every read.
    reader.parse_incremental(db, {})
    reader.parse_activity(db, seen)
    assert calls()[:2] == (1, declined) and calls()[2] > 1
    assert no_read_problems.read_problem("opencode") == problem  # held still: same entry, same `since`

    # The table is there again: the reader's own read clears its entry, and the runtime answers the next one.
    con.executescript("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,"
                      " time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);")
    con.commit()
    con.close()
    reader.parse_activity(db, seen)
    assert no_read_problems.read_problem("opencode") is None
    assert calls()[:2] == (1, declined)
    deferred = calls()[2]
    reader.parse_activity(db, seen)
    assert calls() == (2, declined, deferred)


def test_what_the_reader_would_log_is_logged_once_through_its_own_logger(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seam, caplog: pytest.LogCaptureFixture) -> None:
    cli_runtime_build.binary()
    # The scenario has a session no table gives a key (two polls read it).
    scenario = parity._scenarios()["openclaw_db"]
    seam.apply(True)
    with caplog.at_level(logging.WARNING, logger="agent_team_backend.log_readers.openclaw"):
        parity._run(scenario, tmp_path, lambda: cli_runtime.wrap(cli_vendor("openclaw").make_log_reader()),
                    monkeypatch)
    said = [r for r in caplog.records if "names no session key" in r.getMessage()]
    assert len(said) == 1 and said[0].name == "agent_team_backend.log_readers.openclaw"
    assert seam.status()["calls"]["openclaw"]["fallback"] == 0


def test_cargo_runs_with_the_accounts_rust_homes_not_the_suites_empty_home(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The suite's ``HOME`` is an empty directory. A rustup-managed cargo given
    only that finds no toolchain there, which failed every build on CI's Linux."""
    pwd = pytest.importorskip("pwd")
    account = tmp_path / "account"
    for name in (".rustup", ".cargo"):
        (account / name).mkdir(parents=True)
    stand_in = tmp_path / "bin" / "cargo"
    stand_in.parent.mkdir()
    stand_in.write_text('#!/bin/sh\necho "$RUSTUP_HOME"\necho "$CARGO_HOME"\n', encoding="utf-8")
    stand_in.chmod(0o755)
    monkeypatch.setenv("PATH", str(stand_in.parent), prepend=os.pathsep)
    monkeypatch.setenv(cli_runtime_build.REQUIRED_ENV, "1")
    monkeypatch.delenv("RUSTUP_HOME", raising=False)
    monkeypatch.delenv("CARGO_HOME", raising=False)
    monkeypatch.setattr(pwd, "getpwuid", lambda uid: SimpleNamespace(pw_dir=str(account)))
    assert cli_runtime_build.cargo("build").stdout.splitlines() == [str(account / ".rustup"), str(account / ".cargo")]
    # A home the environment names is the one cargo gets.
    monkeypatch.setenv("RUSTUP_HOME", str(tmp_path / "named"))
    assert cli_runtime_build.cargo("build").stdout.splitlines()[0] == str(tmp_path / "named")
