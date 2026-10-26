"""Crash-recovery registry writes stay in the data dir they belong to.

pty_registry resolves app_data_dir() at call time, and TerminalService runs
register/unregister/update_descendants on worker threads. A job still in
flight when the data dir changes (in tests: the next test's autouse fixture
repoints AGENT_TEAM_DATA_DIR) used to open a second connection on the NEW
dir's navide.db and write there — contending with whatever owns that file
and recording the pid in a registry that never spawned it.
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading
import time
from pathlib import Path

import pytest

from agent_team_backend import osplat, pty_registry, terminals as terminals_module
from agent_team_backend.db import DB_FILENAME, Database
from agent_team_backend.terminals import TerminalService, TerminalSession


async def _emit(_event) -> None:
    return None


@pytest.mark.asyncio
async def test_a_late_register_writes_to_the_data_dir_it_was_queued_under(tmp_path, monkeypatch):
    first = tmp_path / "first"
    second = tmp_path / "second"
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(first))

    gate = threading.Event()
    registered = threading.Event()
    real_start_time = osplat.process_tree.start_time
    real_register = pty_registry.register

    def held_start_time(pid: int):
        gate.wait(10)
        return real_start_time(pid)

    def register(*args) -> None:
        try:
            real_register(*args)
        finally:
            registered.set()

    monkeypatch.setattr(osplat.process_tree, "start_time", held_start_time)
    monkeypatch.setattr(pty_registry, "register", register)

    service = TerminalService(_emit)
    session = service.create(
        pane_id="late-register",
        agent_key=None,
        command=[sys.executable, "-c", "import time; time.sleep(30)"],
        cwd=str(tmp_path),
    )
    try:
        # register() is now parked on the worker thread. The data dir moves
        # on — what the next test's fixture does — before it gets to write.
        monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(second))
        gate.set()
        assert await asyncio.to_thread(registered.wait, 10)

        assert not (second / DB_FILENAME).exists()
        entries = Database(first / DB_FILENAME).kv_get("pty_registry") or {}
        assert str(session.proc.pid) in entries
    finally:
        gate.set()
        await service.kill_all(grace=0.2)


def _child_report(proc, kills, began) -> str:
    """What the child and kill_all's group kills looked like when the
    unregister never came. /proc is read before poll(), which would reap."""
    lines = [f"{time.perf_counter() - began:.3f}s since kill_all started; pid={proc.pid}"]
    stat = Path(f"/proc/{proc.pid}/stat")
    if not sys.platform.startswith("linux"):
        lines.append("/proc: unavailable (not Linux)")
    else:
        try:
            state = stat.read_text().rsplit(")", 1)[1].split()[0]
            wchan = Path(f"/proc/{proc.pid}/wchan").read_text().strip() or "-"
            lines.append(f"/proc: state={state} wchan={wchan}")
        except OSError as err:
            lines.append(f"/proc: unavailable ({err})")
    lines.append(f"proc.poll()={proc.poll()}")
    lines.append(f"kill_group calls: {len(kills)}")
    lines += [f"  +{at:.3f}s kill_group({gid}, force={force}) -> {outcome}" for at, gid, force, outcome in kills]
    return "\n".join(lines)


@pytest.mark.asyncio
async def test_kill_all_waits_for_registry_cleanup_before_returning(tmp_path, monkeypatch):
    registered = threading.Event()
    unregister_started = threading.Event()
    release_unregister = threading.Event()
    final_sweep_started = threading.Event()
    real_register = pty_registry.register
    real_unregister = pty_registry.unregister

    def register(*args) -> None:
        real_register(*args)
        registered.set()

    def held_unregister(pid: int) -> None:
        unregister_started.set()
        release_unregister.wait(5)
        real_unregister(pid)

    monkeypatch.setattr(pty_registry, "register", register)
    monkeypatch.setattr(pty_registry, "unregister", held_unregister)
    monkeypatch.setattr(terminals_module, "_ps_snapshot", lambda: {})
    monkeypatch.setattr(
        terminals_module, "_kill_breakaway", lambda _pids: final_sweep_started.set()
    )
    # CI once saw this test's unregister never come (exit=None at close):
    # recorded so a recurrence says whether kill_all's SIGKILL was sent and
    # what the child was doing. kill_all swallows these exceptions.
    kills: list[tuple[float, int, bool, str]] = []
    real_kill_group = osplat.process_tree.kill_group

    def kill_group(gid: int, *, force: bool) -> None:
        try:
            real_kill_group(gid, force=force)
        except BaseException as err:
            kills.append((time.perf_counter() - began, gid, force, repr(err)))
            raise
        kills.append((time.perf_counter() - began, gid, force, "sent"))

    monkeypatch.setattr(osplat.process_tree, "kill_group", kill_group)
    service = TerminalService(_emit)
    session = service.create(
        pane_id="shutdown-registry",
        agent_key=None,
        command=[sys.executable, "-c", "import time; time.sleep(30)"],
        cwd=str(tmp_path),
    )
    shutdown = None
    try:
        assert await asyncio.to_thread(registered.wait, 5)
        began = time.perf_counter()
        shutdown = asyncio.create_task(service.kill_all(grace=0.2))
        if not await asyncio.to_thread(unregister_started.wait, 5):
            pytest.fail("kill_all never reached pty_registry.unregister\n" + _child_report(session.proc, kills, began))
        assert await asyncio.to_thread(final_sweep_started.wait, 5)
        await asyncio.sleep(0.05)
        assert not shutdown.done(), "kill_all returned while registry cleanup still used the database"
        release_unregister.set()
        await asyncio.wait_for(shutdown, 5)
        assert session.proc.poll() is not None
    finally:
        release_unregister.set()
        if shutdown is not None and not shutdown.done():
            await asyncio.wait_for(shutdown, 5)


@pytest.mark.asyncio
async def test_kill_all_unregisters_a_child_closed_before_it_was_reapable(tmp_path, monkeypatch):
    """The PTY's EOF can close a shutdown session before its child is
    reapable: _close then sees exit=None (CI run 38862563872). That close
    used to skip the unregister for reason="shutdown", and kill_all's own
    _close found the session already closed, so the record stayed behind.
    Here every child still looks alive to that first close."""
    unregistered: list[int] = []
    real_unregister = pty_registry.unregister

    def unregister(pid: int) -> None:
        unregistered.append(pid)
        real_unregister(pid)

    monkeypatch.setattr(pty_registry, "unregister", unregister)
    monkeypatch.setattr(terminals_module, "_ps_snapshot", lambda: {})
    service = TerminalService(_emit)
    session = service.create(
        pane_id="eof-first",
        agent_key=None,
        command=[sys.executable, "-c", "import time; time.sleep(30)"],
        cwd=str(tmp_path),
    )
    real_poll = session.proc.poll
    hidden = True
    session.proc.poll = lambda: None if hidden else real_poll()
    real_close = service._close

    def close(target: TerminalSession, *, reason: str) -> None:
        nonlocal hidden
        real_close(target, reason=reason)
        hidden = False

    monkeypatch.setattr(service, "_close", close)

    await asyncio.wait_for(service.kill_all(grace=0.2), 10)

    assert session.closed and session.exit_code is None, "the close saw an unreapable child"
    assert real_poll() is not None
    assert session.proc.pid in unregistered, "kill_all returned with the child's registry record left behind"


@pytest.mark.asyncio
async def test_kill_all_waits_for_an_inflight_descendant_registry_write(tmp_path, monkeypatch):
    update_started = threading.Event()
    release_update = threading.Event()
    update_finished = threading.Event()
    final_sweep_started = threading.Event()
    service = TerminalService(_emit)
    pid = 987654

    class Proc:
        returncode = None

        def poll(self):
            return self.returncode

        def wait(self, timeout=None):
            self.returncode = 0
            return self.returncode

    class Handle:
        def stop_reading(self):
            pass

        def unwatch_writable(self):
            pass

        def close(self):
            pass

        def foreground_group(self):
            return 0

    proc = Proc()
    proc.pid = pid
    session = TerminalSession(
        id="shutdown-snapshot",
        pane_id="shutdown-snapshot",
        agent_key=None,
        command=["fake"],
        cwd=str(tmp_path),
        handle=Handle(),
        proc=proc,
    )
    service._sessions[session.id] = session

    def snapshot():
        return {pid: (os.getpid(), pid, "child-start")}

    def held_update(descendants) -> None:
        update_started.set()
        release_update.wait(5)
        update_finished.set()

    def kill_group(_pid, *, force):
        proc.returncode = 0

    monkeypatch.setattr(terminals_module, "_ps_snapshot", snapshot)
    monkeypatch.setattr(pty_registry, "update_descendants", held_update)
    monkeypatch.setattr(osplat.process_tree, "group_of", lambda _pid: pid)
    monkeypatch.setattr(osplat.process_tree, "kill_group", kill_group)
    monkeypatch.setattr(
        terminals_module, "_kill_breakaway", lambda _pids: final_sweep_started.set()
    )
    shutdown = None
    try:
        service._snapshot_task = asyncio.create_task(service._snapshot_loop())
        assert await asyncio.to_thread(update_started.wait, 5)
        shutdown = asyncio.create_task(service.kill_all(grace=0.2))
        await asyncio.sleep(0.05)
        assert not final_sweep_started.is_set(), (
            "kill_all advanced while a snapshot worker still used the database"
        )
        release_update.set()
        await asyncio.wait_for(shutdown, 5)
        assert update_finished.is_set() and final_sweep_started.is_set()
    finally:
        release_update.set()
        if shutdown is not None and not shutdown.done():
            await asyncio.wait_for(shutdown, 5)


def _sync_service(monkeypatch, first):
    """A TerminalService used from sync code, so create() finds no running
    loop and takes the inline registry fallback."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(first))
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    return TerminalService(_emit), loop


def _close_sync_service(service, loop) -> None:
    try:
        loop.run_until_complete(service.kill_all(grace=0.2))
    finally:
        asyncio.set_event_loop(None)
        loop.close()


def test_the_inline_register_fallback_writes_to_the_services_data_dir(tmp_path, monkeypatch):
    first = tmp_path / "first"
    second = tmp_path / "second"
    service, loop = _sync_service(monkeypatch, first)
    try:
        # The process points elsewhere by the time create() runs.
        monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(second))
        session = service.create(
            pane_id="inline-register",
            agent_key=None,
            command=[sys.executable, "-c", "import time; time.sleep(30)"],
            cwd=str(tmp_path),
        )

        assert not (second / DB_FILENAME).exists()
        entries = Database(first / DB_FILENAME).kv_get("pty_registry") or {}
        assert str(session.proc.pid) in entries
    finally:
        _close_sync_service(service, loop)


def test_the_inline_failed_create_unregister_uses_the_services_data_dir(tmp_path, monkeypatch):
    from agent_team_backend.applog import app_data_dir

    first = tmp_path / "first"
    second = tmp_path / "second"
    service, loop = _sync_service(monkeypatch, first)
    unregistered_under: list = []

    def failing_register(*_args) -> None:
        raise OSError("registry unavailable")

    def unregister(_pid: int) -> None:
        unregistered_under.append(app_data_dir())

    monkeypatch.setattr(pty_registry, "register", failing_register)
    monkeypatch.setattr(pty_registry, "unregister", unregister)
    try:
        monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(second))
        with pytest.raises(OSError, match="registry unavailable"):
            service.create(
                pane_id="inline-unregister",
                agent_key=None,
                command=[sys.executable, "-c", "import time; time.sleep(30)"],
                cwd=str(tmp_path),
            )

        assert unregistered_under == [first]
    finally:
        _close_sync_service(service, loop)
