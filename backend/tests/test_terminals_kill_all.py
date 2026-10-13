"""kill_all() must terminate every PTY child on backend shutdown.

Children are spawned with start_new_session=True (own process group), so a
dying backend never propagates signals to them — without an explicit sweep
they outlive the app as orphans (observed: 30+ orphaned CLI processes driving
load average past 200).
"""
from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest

from agent_team_backend.terminals import TerminalService


async def _noop_emit(event: dict[str, Any]) -> None:
    return None


@pytest.mark.asyncio
async def test_kill_all_terminates_children() -> None:
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    await svc.kill_all(grace=0.5)
    assert session.proc.poll() is not None
    assert svc._sessions == {}


@pytest.mark.asyncio
async def test_kill_all_terminates_many_children_with_one_snapshot() -> None:
    # The descendant sweep now takes ONE shared ps snapshot for all sessions
    # (a per-session snapshot pushed shutdown past Electron's SIGKILL
    # deadline). Every child must still die.
    svc = TerminalService(emit=_noop_emit)
    sessions = [
        svc.create(pane_id=f"p{i}", agent_key=None, command=["sleep", "30"], cwd="/")
        for i in range(3)
    ]
    await svc.kill_all(grace=0.5)
    for session in sessions:
        assert session.proc.poll() is not None
    assert svc._sessions == {}


@pytest.mark.asyncio
async def test_kill_all_escalates_to_sigkill() -> None:
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1",
        agent_key=None,
        command=["sh", "-c", 'trap "" TERM; sleep 30'],
        cwd="/",
    )
    # Give the shell a moment to install the TERM trap before signalling.
    await asyncio.sleep(0.3)
    await svc.kill_all(grace=0.3)
    # SIGKILL delivery is asynchronous; poll briefly until the child is reaped.
    for _ in range(20):
        if session.proc.poll() is not None:
            break
        await asyncio.sleep(0.05)
    assert session.proc.poll() is not None
    assert svc._sessions == {}


@pytest.mark.asyncio
async def test_drain_does_not_spin_on_a_finished_registry_write() -> None:
    """A registry write that has finished but whose discard callback has not
    run yet (it is queued behind the step that set the result) must not keep
    the drain from returning. gather() over futures that are all done
    completes without yielding to the loop (Python 3.12), so a drain that
    re-gathers whatever is in the set never lets that callback run: it spun
    forever and hung kill_all, and with it the CI backend suite (the Linux
    job cancelled at its 15-minute limit)."""
    svc = TerminalService(emit=_noop_emit)
    write = asyncio.get_running_loop().create_future()
    svc._lifecycle_futures.add(write)
    write.add_done_callback(svc._lifecycle_futures.discard)
    write.set_result(None)  # done; its discard is queued, not yet run

    # A drain that spins never yields, so no await can bound it: a thread
    # empties the set if the drain has not returned, and the test fails on
    # that instead of hanging the run.
    drained = threading.Event()
    rescued = threading.Event()

    def rescue() -> None:
        if not drained.wait(5.0):
            rescued.set()
            svc._lifecycle_futures.clear()

    threading.Thread(target=rescue, daemon=True).start()
    await svc._drain_lifecycle()
    drained.set()
    assert not rescued.is_set(), "the drain spun on a finished write"
