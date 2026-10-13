"""Per-vendor graceful shutdown: SIGTERM before the shared force logic.

claude clears ~/.claude.json's fullscreenBootPending entry from a SIGTERM
handler. A SIGKILL skips it, the next start counts a strike, and two strikes
disable its fullscreen TUI (the dim header row of previous prompts). So the
claude VendorSpec declares a ShutdownSpec and its kill leads with SIGTERM.

The regression this file mainly guards is the other direction: a vendor that
declares nothing must take the path that has always run, byte for byte.
"""
from __future__ import annotations

import asyncio
import dataclasses
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import osplat, terminals as terminals_module
from agent_team_backend.cli_vendors.registry import vendor
from agent_team_backend.terminals import TerminalService

#: The graceful path opens with `kill_group(target, force=False)` and waits.
#: That only means anything where `force=False` is a signal the child can
#: survive long enough to handle. On Windows it is not: `_windows.kill` says
#: so in its own comment ("Both `force` values are TerminateProcess: Windows
#: has no SIGTERM"), and `kill_group` routes through `kill_tree` to
#: `TerminateJobObject` — `force` is read by no branch. The child is gone
#: before the grace begins, which CI measured as kill_all returning in 0.06s
#: against the 3.0s claude declares.
#:
#: So these three describe behaviour Windows does not currently have. They are
#: gated rather than weakened because the gap is REAL: ShutdownSpec is a no-op
#: on Windows, claude's exit handler never runs there, and the stale
#: fullscreenBootPending entry it exists to clear is still stranded on both
#: Windows architectures we ship. Closing that needs a Windows mechanism the
#: osplat seam does not have yet (console control events); this marker comes
#: off when it does. Everything else in this file is portable and stays live
#: on Windows, including the reap ceiling, the release-on-failure guards and
#: the kill_all upper bounds.
_needs_a_survivable_signal = pytest.mark.skipif(
    sys.platform == "win32",
    reason=(
        "osplat's Windows kill_group ignores `force` and terminates outright, "
        "so the SIGTERM-then-grace behaviour these assert does not exist "
        "there — a product gap in ShutdownSpec, not a test artefact"
    ),
)


async def _noop_emit(event: dict[str, Any]) -> None:
    return None


def _trap_term_script(marker: Path) -> list[str]:
    """A child that records the fact it was SIGTERMed, then exits. HUP is left
    alone: with defer_master_close the master stays open, and the vendors
    without a spec are SIGKILLed before any HUP can reach them."""
    return ["sh", "-c", f'trap "touch {marker}; exit 0" TERM; sleep 30']


def _ignore_term_script() -> list[str]:
    """A child that refuses SIGTERM, so a grace provably runs its full length.
    HUP is left alone: defer_master_close keeps the master open, so no HUP is
    sent and the escalation is what finally puts it down."""
    return ["sh", "-c", 'trap "" TERM; sleep 30']


async def _wait_for(predicate: Any, timeout_s: float = 8.0) -> bool:
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout_s
    while loop.time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.05)
    return predicate()


@pytest.fixture()
def recorded_signals(monkeypatch: pytest.MonkeyPatch) -> list[tuple[int, bool]]:
    calls: list[tuple[int, bool]] = []
    real = osplat.process_tree.kill_group

    def spy(gid: int, *, force: bool) -> None:
        calls.append((gid, force))
        real(gid, force=force)

    monkeypatch.setattr(osplat.process_tree, "kill_group", spy)
    return calls


def test_only_claude_declares_a_shutdown_spec() -> None:
    # The whole point of the field is that it changes nothing for anyone who
    # has not opted in. If another vendor grows one, that vendor needs its own
    # coverage below before this line is updated.
    assert vendor("claude").shutdown is not None
    for key in (
        "codex", "cursor", "copilot", "kimi", "grok", "qwen", "opencode",
        "kilo", "aider", "droid", "muse", "pi", "antigravity",
    ):
        assert vendor(key).shutdown is None, key


@pytest.mark.asyncio
async def test_vendor_without_spec_keeps_the_existing_kill_path(
    tmp_path: Path, recorded_signals: list[tuple[int, bool]]
) -> None:
    marker = tmp_path / "termed"
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1", agent_key="codex", command=_trap_term_script(marker), cwd="/"
    )
    await asyncio.sleep(0.3)  # let the shell install its trap

    await svc.kill(session.id, force=True)

    # Unchanged behavior: the session is closed and gone the moment kill()
    # returns, and the very first signal is the caller's SIGKILL.
    assert session.closed is True
    assert session.id not in svc._sessions
    assert recorded_signals, "no signal was sent"
    assert recorded_signals[0][1] is True
    assert all(force is True for _, force in recorded_signals)
    await _wait_for(lambda: session.proc.poll() is not None)
    assert session.proc.poll() is not None
    assert not marker.exists(), "a vendor without a spec must not get a SIGTERM"


@_needs_a_survivable_signal
@pytest.mark.asyncio
async def test_claude_gets_sigterm_first_even_when_force_is_requested(
    tmp_path: Path, recorded_signals: list[tuple[int, bool]]
) -> None:
    marker = tmp_path / "termed"
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1", agent_key="claude", command=_trap_term_script(marker), cwd="/"
    )
    await asyncio.sleep(0.3)

    await svc.kill(session.id, force=True)

    # defer_master_close: the PTY master is still open and the session still
    # registered when kill() returns — the grace runs in a task so pane close
    # and respawn keep their current latency.
    assert session.closed is False
    assert session.id in svc._sessions

    assert await _wait_for(lambda: bool(recorded_signals)), "no signal was sent"
    assert recorded_signals[0][1] is False, "first signal must be SIGTERM"
    assert await _wait_for(marker.exists), "the child never saw a SIGTERM"
    # The grace ran its course: the session is closed and the in-flight guard
    # released, so a later kill of the same id is not silently swallowed.
    assert await _wait_for(lambda: not svc._graceful_kills)
    assert session.id not in svc._sessions
    assert session.closed is True
    assert session.proc.poll() is not None


@pytest.mark.asyncio
async def test_wait_until_reaped_blocks_until_the_graceful_kill_finishes(
    tmp_path: Path,
) -> None:
    """terminal.create reaps the PTY it replaces (and any stale PTY resuming
    the same session id) and then spawns. kill() returning early would let two
    claudes append to one session file, which is what that reap prevents — so
    those callers wait here."""
    marker = tmp_path / "termed"
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1", agent_key="claude", command=_trap_term_script(marker), cwd="/"
    )
    await asyncio.sleep(0.3)

    await svc.kill(session.id, force=True)
    assert session.proc.poll() is None, "kill() must not have waited"

    assert await svc.wait_until_reaped(session.id) is True
    # The contract the reap sites rely on: once this returns, the child is gone.
    assert session.proc.poll() is not None
    assert session.closed is True


@_needs_a_survivable_signal
@pytest.mark.asyncio
async def test_rebuild_shaped_double_kill_still_waits_for_the_first_reap(
    recorded_signals: list[tuple[int, bool]]
) -> None:
    """A rebuild closes the pane and then spawns a new one with the SAME
    --resume id, so terminal.create's resume dedup finds the still-live PTY and
    kills it a second time. That second kill is a no-op (the first grace owns
    it), which means the dedup's guarantee rests entirely on the wait: without
    it the rebuild would spawn over a live claude, and two of them would append
    to one session file.

    The child ignores SIGTERM so the first grace is provably still running when
    the second kill arrives — with a child that exits at once the two would
    race and the test would only sometimes exercise the guard.
    """
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1", agent_key="claude", command=_ignore_term_script(), cwd="/"
    )
    await asyncio.sleep(0.3)

    await svc.kill(session.id, force=True)          # the pane close
    assert session.id in svc._graceful_kills
    first = svc._graceful_kills[session.id]

    # The dedup still sees it: not closed, same agent, same resume id.
    assert session in svc.find_live_by_resume_id(
        "claude", "abc", lambda _cmd: "abc"
    )
    await svc.kill(session.id, force=True)          # the dedup's reap
    # Guarded: no second grace, and the first one's completion event survives.
    assert svc._graceful_kills.get(session.id) is first

    assert await svc.wait_until_reaped(session.id) is True
    # A TERM-ignoring child only goes down because the grace escalated. Both
    # counts are read here, once the reap is over: the second kill is answered
    # without awaiting anything, so reading them straight after it would only
    # catch whatever the first grace had managed to send by then.
    assert session.proc.poll() is not None
    signalled = [force for _, force in recorded_signals]
    assert signalled.count(False) == 1, "a second round of signalling"
    assert True in signalled, "the escalation never fired"


@pytest.mark.asyncio
async def test_the_unspawn_sweeps_redundant_kill_costs_no_ps_snapshot() -> None:
    """Closing a pane kills its PTY and then sends manual_pane.unspawn, whose
    sweep addresses the same pane. The grace keeps the session registered, so
    that sweep now reaches kill() where it used to find nothing. It must answer
    before the descendant snapshot: that is a full-system `ps` with a 5s
    budget, and one per pane close to reach the same no-op is waste.
    """
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1", agent_key="claude", command=_ignore_term_script(), cwd="/"
    )
    await asyncio.sleep(0.3)

    snapshots: list[int] = []
    real_snapshot = terminals_module._descendant_pids

    def counted(pid: int) -> dict[int, str]:
        snapshots.append(pid)
        return real_snapshot(pid)

    terminals_module._descendant_pids = counted  # type: ignore[assignment]
    try:
        await svc.kill(session.id, force=True)        # the pane close
        assert len(snapshots) == 1
        # What manual_pane.unspawn's sweep does, addressing the same pane.
        assert svc.live_session_ids_for_pane("p1") == [session.id]
        for tid in svc.live_session_ids_for_pane("p1"):
            await svc.kill(tid, force=True)
        assert snapshots == snapshots[:1], "the redundant kill took a ps snapshot"

        assert await svc.wait_until_reaped(session.id) is True
    finally:
        terminals_module._descendant_pids = real_snapshot  # type: ignore[assignment]
        if session.proc.poll() is None:
            session.proc.kill()
    assert session.proc.poll() is not None


@pytest.mark.asyncio
async def test_a_kill_parked_in_the_ps_snapshot_starts_no_second_grace() -> None:
    """kill() snapshots the descendant tree with a full-system `ps` off the
    loop (5s budget). A kill that entered before that await and resumed after
    the child had already gone must not start a grace on the strength of what
    it read beforehand: the foreground group it captured came from a handle
    that is now closed, and the kernel may have handed that pgid to someone
    else's process group.
    """
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1", agent_key="claude", command=["sleep", "30"], cwd="/"
    )
    await asyncio.sleep(0.2)

    # Park the snapshot, exactly where the real `ps` parks, and record every
    # signal the kill would send from the far side of it.
    gate = threading.Event()
    signals: list[tuple[int, bool]] = []
    real_snapshot = terminals_module._descendant_pids

    def parked(pid: int) -> dict[int, str]:
        gate.wait(5.0)
        return real_snapshot(pid)

    terminals_module._descendant_pids = parked  # type: ignore[assignment]
    real_kill_group = osplat.process_tree.kill_group

    def spy(gid: int, *, force: bool) -> None:
        signals.append((gid, force))
        real_kill_group(gid, force=force)

    osplat.process_tree.kill_group = spy  # type: ignore[assignment]
    try:
        straggler = asyncio.create_task(svc.kill(session.id, force=True))
        await asyncio.sleep(0.2)          # it is now inside the snapshot
        assert not straggler.done()

        # The child's own EOF closes the session while the kill is parked.
        svc._close(session, reason="exit")

        gate.set()
        await straggler
    finally:
        terminals_module._descendant_pids = real_snapshot  # type: ignore[assignment]
        osplat.process_tree.kill_group = real_kill_group  # type: ignore[assignment]
        if session.proc.poll() is None:
            session.proc.kill()

    assert svc._graceful_kills == {}, "a second grace was registered"
    assert signals == [], "signalled a pgid read from a closed handle"


@pytest.mark.asyncio
async def test_wait_until_reaped_returns_at_once_with_nothing_in_flight() -> None:
    # No graceful kill in flight — every vendor without a ShutdownSpec, and any
    # id already reaped. Must not cost the caller a single tick of waiting.
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key="codex", command=["sleep", "30"], cwd="/")

    assert await svc.wait_until_reaped(session.id, timeout=0.0) is True
    assert await svc.wait_until_reaped("no-such-session", timeout=0.0) is True

    await svc.kill(session.id, force=True)
    assert await svc.wait_until_reaped(session.id, timeout=0.0) is True


# --- the reap ceiling ---------------------------------------------------


def test_the_reap_ceiling_is_derived_from_the_declared_graces() -> None:
    """Written-down ceilings go stale; this one has to follow the specs.

    It must cover every bounded step between the SIGTERM and the moment the
    child is confirmed down — the vendor's grace, the escalation's own grace,
    and the wait that reaps the zombie — or a caller that must not spawn over
    a live CLI gives up while the kill is still running normally.
    """
    assert terminals_module._max_vendor_grace_s() == vendor("claude").shutdown.grace_s
    floor = (
        terminals_module._max_vendor_grace_s()
        + terminals_module._KILL_ESCALATION_GRACE_S
        + terminals_module._REAP_CONFIRM_S
    )
    assert terminals_module._reap_wait_timeout_s() > floor


def test_a_longer_vendor_grace_widens_the_ceiling_with_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The regression a hard-coded number cannot survive: a vendor asks for a
    # longer grace and the ceiling silently stops covering it.
    from agent_team_backend.cli_vendors.base import ShutdownSpec
    from agent_team_backend.cli_vendors import registry

    before = terminals_module._reap_wait_timeout_s()
    stretched = dataclasses.replace(
        registry.VENDORS["claude"],
        shutdown=ShutdownSpec(graceful=True, grace_s=30.0, defer_master_close=True),
    )
    monkeypatch.setitem(registry.VENDORS, "claude", stretched)

    assert terminals_module._max_vendor_grace_s() == 30.0
    assert terminals_module._reap_wait_timeout_s() == before + 27.0


@pytest.mark.asyncio
async def test_the_breakaway_ps_sweep_runs_outside_the_reap_wait() -> None:
    """The sweep is a full-system `ps` with a 5s budget of its own.

    Held inside the wait it made the ceiling smaller than the work under it:
    grace 3 + escalation 1 + zombie wait 1 + ps 5 = 10s under an 8s ceiling,
    so a claude pane with any recorded descendant could report "not reaped"
    on a loaded machine while the child was in fact long dead. The sweep is
    about OTHER processes (grandchildren that left the group) and says nothing
    about this child, so the reap is released before it runs.
    """
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1", agent_key="claude", command=_ignore_term_script(), cwd="/"
    )
    await asyncio.sleep(0.3)

    real_descendants = terminals_module._descendant_pids
    real_snapshot = terminals_module._ps_snapshot
    swept = threading.Event()

    # A claude pane with one recorded descendant, so the sweep really runs.
    terminals_module._descendant_pids = lambda pid: {999999: "999999:fake"}

    released = threading.Event()

    def slow_ps() -> dict:
        swept.set()
        # Stands in for the 5s budget _posix._ps_snapshot gives `ps -Ao` on a
        # loaded machine. Interruptible so it does not also become 5s of
        # teardown on every run: the test releases it only after it has
        # measured the reap, so a reap that DID wait for the sweep still pays
        # the full 5s and still trips the ceiling assertion below.
        released.wait(5.0)
        return {}

    terminals_module._ps_snapshot = slow_ps
    try:
        await svc.kill(session.id, force=True)
        started = time.monotonic()
        reaped = await svc.wait_until_reaped(session.id)
        waited = time.monotonic() - started
        # Wait for the sweep INSIDE the patch's lifetime. It runs after the
        # release by design, so restoring the real (fast) snapshot first is a
        # race the sweep thread has to win to be observed at all — measured at
        # 4 microseconds on this machine, which macOS happened to win and
        # every CI runner lost. Losing it left `swept` clear and the
        # self-proof guard below reporting "the sweep never ran", on all three
        # OSes.
        #
        # Polled rather than `swept.wait(...)`: that blocks the loop thread,
        # and the sweep is dispatched BY the loop. It happens to work today
        # only because `to_thread` submits before the graceful task yields —
        # a guarantee this test has no business resting on. The generous
        # window is for a sweep that is never dispatched, not a slow one.
        swept_ran = await _wait_for(swept.is_set, 30.0)
    finally:
        released.set()
        terminals_module._descendant_pids = real_descendants
        terminals_module._ps_snapshot = real_snapshot
        if session.proc.poll() is None:
            session.proc.kill()

    assert reaped is True, f"the ps sweep was inside the wait ({waited:.2f}s)"
    assert session.proc.poll() is not None, "released before the child was down"
    # The whole point: the answer came back on the child's timetable (grace +
    # escalation), not the sweep's.
    assert waited < terminals_module._reap_wait_timeout_s()
    assert swept_ran, "the sweep never ran — the test proved nothing"


@pytest.mark.asyncio
async def test_a_reap_that_never_completes_still_reports_false() -> None:
    """The ceiling has to stay reachable, or the reap sites' refusal to spawn
    is dead code. A grace whose event never fires stands in for the only thing
    that reaches it now: a child that outlived its SIGKILL."""
    svc = TerminalService(emit=_noop_emit)
    svc._graceful_kills["never-finishes"] = asyncio.Event()

    assert await svc.wait_until_reaped("never-finishes", timeout=0.2) is False
    # And the same id answers True the moment the reap completes.
    svc._graceful_kills["never-finishes"].set()
    assert await svc.wait_until_reaped("never-finishes", timeout=0.2) is True


# --- shutdown sweep ------------------------------------------------------


@_needs_a_survivable_signal
@pytest.mark.asyncio
async def test_kill_all_honours_a_declared_grace() -> None:
    """Quitting the app is when every claude pane runs its SIGTERM handler at
    once, against the same ~/.claude.json. kill_all's own 1s grace ignored the
    3s the vendor asked for, so the exact stale-entry bug the ShutdownSpec
    exists to prevent survived on the quit path."""
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1", agent_key="claude", command=_ignore_term_script(), cwd="/"
    )
    await asyncio.sleep(0.3)

    started = time.monotonic()
    await svc.kill_all()
    waited = time.monotonic() - started

    grace = vendor("claude").shutdown.grace_s
    assert waited >= grace * 0.8, (
        f"claude got {waited:.2f}s, not the {grace}s it declared"
    )
    assert session.proc.poll() is not None


class _SteppingClock:
    """The service loop with a clock that moves a fixed step on every read and
    otherwise is the real loop. kill_all's grace poll reads it once per tick,
    so the grace it ran is counted in reads, not measured: the snapshot, the
    breakaway sweep and the lifecycle drain around it take whatever a loaded
    runner gives them (5.38s on Windows CI) without moving it."""

    def __init__(self, loop: asyncio.AbstractEventLoop, step: float) -> None:
        self._real = loop
        self.step = step
        self.now = 0.0

    def time(self) -> float:
        self.now += self.step
        return self.now

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


@pytest.mark.asyncio
async def test_kill_all_leaves_a_vendor_without_a_spec_on_the_old_grace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The other half: nobody who declared nothing pays for this.
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1", agent_key="codex", command=_ignore_term_script(), cwd="/"
    )
    await asyncio.sleep(0.3)
    clock = _SteppingClock(svc._loop, 0.05)  # noqa: SLF001
    svc._loop = clock  # type: ignore[assignment]  # noqa: SLF001
    signalled: list[tuple[bool, float]] = []
    real = osplat.process_tree.kill_group

    def spy(gid: int, *, force: bool) -> None:
        signalled.append((force, clock.now))
        real(gid, force=force)

    monkeypatch.setattr(osplat.process_tree, "kill_group", spy)

    await svc.kill_all()

    assert session.proc.poll() is not None
    term_at = next(at for force, at in signalled if not force)
    killed_at = next((at for force, at in signalled if force), None)
    if killed_at is None:
        # Windows: the TERM already terminated it, so no grace ran at all.
        assert sys.platform == "win32", signalled
    else:
        # It ignores TERM, so the escalation comes when the grace runs out:
        # kill_all's own 1s, not the 3s claude declares.
        assert 1.0 <= killed_at - term_at <= 1.0 + 3 * clock.step, signalled


@pytest.mark.asyncio
async def test_kill_all_waits_the_longest_grace_once_not_once_per_pane() -> None:
    """The cost of honouring the grace has to be the maximum, not the sum —
    Electron kills the backend if quit drags, and a workspace has tens of
    panes. kill_all signals every target first and then polls them together,
    so three TERM-ignoring claudes cost one grace between them."""
    svc = TerminalService(emit=_noop_emit)
    sessions = [
        svc.create(
            pane_id=f"p{i}", agent_key="claude",
            command=_ignore_term_script(), cwd="/",
        )
        for i in range(3)
    ]
    await asyncio.sleep(0.4)

    started = time.monotonic()
    await svc.kill_all()
    waited = time.monotonic() - started

    grace = vendor("claude").shutdown.grace_s
    assert waited < grace * 2, (
        f"three panes took {waited:.2f}s — the waits stacked instead of "
        f"overlapping (one grace is {grace}s)"
    )
    assert all(s.proc.poll() is not None for s in sessions)


# --- failure release -----------------------------------------------------


@pytest.mark.asyncio
async def test_a_task_that_blows_up_still_releases_the_session() -> None:
    """_graceful_kills is the in-flight guard: while an id sits in it, kill()
    short-circuits. An exception escaping the task without popping it left the
    session registered, never closed, its child alive and every later kill a
    silent no-op — with the traceback surfacing only as asyncio's "Task
    exception was never retrieved" at GC time.
    """
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1", agent_key="claude", command=["sleep", "30"], cwd="/"
    )
    await asyncio.sleep(0.3)

    real_close = svc._close
    # Anything the body can raise. _close is inside the try either way; what
    # this proves is that the release is a finally, not a lucky code path.
    def boom(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("kaboom")

    svc._close = boom  # type: ignore[assignment]
    try:
        await svc.kill(session.id, force=True)
        assert await _wait_for(lambda: not svc._graceful_kills, 8.0), (
            "the session stayed in _graceful_kills — it can never be killed again"
        )
        # The waiters were released rather than left to burn the full ceiling.
        assert await svc.wait_until_reaped(session.id, timeout=0.1) is True
    finally:
        svc._close = real_close  # type: ignore[assignment]
        if session.proc.poll() is None:
            session.proc.kill()
        real_close(session, reason="killed")


@pytest.mark.asyncio
async def test_group_of_raising_does_not_strand_the_session() -> None:
    """group_of() used to sit outside the try that owns the release.

    os.getpgid is documented to raise EPERM as well as ESRCH, and the call is
    one line above a finally it was not covered by. Anything it raised that
    was not ProcessLookupError escaped before the release, and from then on
    the id was poisoned: still in _graceful_kills, so kill() short-circuited
    on it forever; never closed, so still in _sessions; child still alive.
    """
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1", agent_key="claude", command=["sleep", "30"], cwd="/"
    )
    await asyncio.sleep(0.3)

    real_group_of = osplat.process_tree.group_of
    calls: list[int] = []

    def raises_once(pid: int) -> int:
        calls.append(pid)
        if len(calls) == 1:
            raise PermissionError(1, "Operation not permitted")
        return real_group_of(pid)

    osplat.process_tree.group_of = raises_once  # type: ignore[assignment]
    try:
        await svc.kill(session.id, force=True)
        tasks = set(svc._kill_tasks)
        # The reap is the promise: a poisoned id never sets its event, so this
        # is False at the ceiling rather than True.
        assert await svc.wait_until_reaped(session.id) is True
        # The entry itself is popped only when the task ends, and the task
        # runs the breakaway sweep (a full process-table read, unbounded on a
        # loaded Windows runner) after the reap. Wait for the task, not a
        # fixed window, then check it released the id rather than raising
        # past the finally.
        await asyncio.wait(tasks)
        assert not svc._graceful_kills, (
            "the id stayed in _graceful_kills — kill() is now a no-op for it"
        )
        assert await _wait_for(lambda: session.closed)
        assert session.id not in svc._sessions
        # EPERM only costs the pgid; the escalation still puts the child down.
        assert await _wait_for(lambda: session.proc.poll() is not None)
    finally:
        osplat.process_tree.group_of = real_group_of  # type: ignore[assignment]
        if session.proc.poll() is None:
            session.proc.kill()
