"""Tests for reaping orphans after a PTY child dies on its own.

kill() (pane close) snapshots the descendant tree while the child is alive and
sweeps breakaway grandchildren. But when the child dies by itself — crash,
external SIGKILL — the EOF path runs _close with no sweep, and grandchildren
that live in their own process group (e.g. MCP servers a CLI spawns detached)
leak as orphans (observed: `npm exec @upstash/context7-mcp` pairs reparented to
the backend, surviving for days). The fix: a rolling per-session descendant
snapshot (pid -> lstart) plus a batch sweeper that kills snapshot pids now
orphaned (reparented to launchd or this process), identity-checked via lstart
to defeat pid recycling, along with their current subtrees. Detached
descendants are also persisted to pty_registry for the backend-crash path.

The setsid-grandchild harness and ps stubs are shared with
test_terminals_breakaway_kill.py via conftest fixtures.
"""
from __future__ import annotations

import asyncio
import os
import signal
import sys
import time
from typing import Any

import pytest

from agent_team_backend import osplat, terminals
from agent_team_backend.osplat import _posix
from agent_team_backend.terminals import (
    TerminalService,
    _children_map,
    _ps_snapshot,
    _walk_descendants,
)


async def _noop_emit(event: dict[str, Any]) -> None:
    return None


def _fake_base(*real: int) -> int:
    """A base for fake pids that can never be one of the real pids a test
    mixes them with. A hardcoded fake (900) once matched the spawned child's
    pid on a Windows runner: the fake entry overwrote the child's own row and
    the test saw no descendants at all."""
    return max(real) + 1_000_000


# ---- _ps_snapshot: parsing ----
# _ps_snapshot delegates to whichever tree osplat wired for the host; the
# ps-table parser under test is the POSIX one, so it is driven directly.

def test_ps_snapshot_parses_fields_and_skips_garbage(monkeypatch, fake_ps):
    table = (
        "100 1 100 Thu Jul 24 10:05:00 2026\n"
        "200 100 200 Thu Jul 24 10:05:03 2026\n"
        "BAD\n\n"
        "300 200 100\n"
    )
    monkeypatch.setattr(_posix.subprocess, "run", fake_ps(table))
    assert _posix.process_tree.snapshot() == {
        100: (1, 100, "Thu Jul 24 10:05:00 2026"),
        200: (100, 200, "Thu Jul 24 10:05:03 2026"),
        300: (200, 100, ""),
    }


def test_ps_snapshot_empty_on_failure(monkeypatch):
    def boom(*a, **k):
        raise OSError("no ps")
    monkeypatch.setattr(_posix.subprocess, "run", boom)
    assert _posix.process_tree.snapshot() == {}


# ---- _refresh_descendants: rolling snapshot + registry payload ----

async def test_refresh_updates_sessions_and_returns_detached_only_payload():
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    try:
        pid = session.proc.pid
        base = _fake_base(pid, os.getpid())
        a, b, c, other = base + 900, base + 901, base + 902, base + 999
        # tree: child -> a (detached, own group) -> b (a's group),
        # child -> c (same group as child: transient helper), unrelated other
        snap = {
            pid: (os.getpid(), pid, "L-child"),
            a: (pid, a, "L900"),
            b: (a, a, "L901"),
            c: (pid, pid, "L902"),
            other: (1, other, "L999"),
        }
        payload = svc._refresh_descendants(snap)
        # In-memory snapshot keeps the whole tree (runtime reaper needs it)…
        assert session.descendants == {a: "L900", b: "L901", c: "L902"}
        # …but only descendants outside the root's group are registry-worthy.
        assert payload == {pid: {a: "L900", b: "L901"}}
    finally:
        await svc.kill_all(grace=0.3)


async def test_refresh_keeps_last_snapshot_on_ps_failure_or_missing_root():
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    try:
        pid = session.proc.pid
        base = _fake_base(pid, os.getpid())
        a, other = base + 900, base + 999
        svc._refresh_descendants({pid: (os.getpid(), pid, "L"), a: (pid, a, "L900")})
        assert session.descendants == {a: "L900"}
        # ps failure ({}) must not wipe the good snapshot.
        assert svc._refresh_descendants({}) == {}
        assert session.descendants == {a: "L900"}
        # Child absent from the table (death racing EOF) — keep the snapshot.
        svc._refresh_descendants({other: (1, other, "L999")})
        assert session.descendants == {a: "L900"}
    finally:
        await svc.kill_all(grace=0.3)


# ---- _reap_exit_orphans: orphan check + lstart identity + subtree kill ----

async def test_snapshot_loop_persists_descendants_to_registry(monkeypatch):
    # The rolling snapshot must reach the crash-recovery registry so a
    # SIGKILLed backend leaves the next start enough to reap detached
    # grandchildren (backend-crash path of the same leak).
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    pid = session.proc.pid
    a = _fake_base(pid, os.getpid()) + 900
    persisted: list[dict[int, dict[int, str]]] = []
    monkeypatch.setattr(
        terminals.pty_registry, "update_descendants", persisted.append
    )
    monkeypatch.setattr(
        terminals, "_ps_snapshot",
        lambda: {pid: (os.getpid(), pid, "L-child"), a: (pid, a, "L900")},
    )
    # The fake table is still in force when kill_all runs below, so its
    # breakaway sweep would take the fake pid for a verified grandchild and SIGKILL
    # whatever real process holds that pid on the host (on a CI runner: the
    # runner itself). Stub the kill; the sweep is not what this test is about.
    monkeypatch.setattr(terminals, "_kill_breakaway", lambda pids: None)
    try:
        # The first snapshot tick runs on the fake table: a ps read off the
        # loop, then a registry write. Wait for the write, not a fixed time.
        assert await _until(lambda: persisted and persisted[-1] == {pid: {a: "L900"}}), persisted
    finally:
        await svc.kill_all(grace=0.3)


async def test_reap_kills_orphaned_snapshot_pids_and_their_subtree(monkeypatch):
    svc = TerminalService(emit=_noop_emit)
    me = os.getpid()
    base = _fake_base(me)
    p200, p250, p300, p400, p555, p999 = (base + n for n in (200, 250, 300, 400, 555, 999))
    # Snapshot was {200, 300, 400}. Now: 200 reparented to launchd with a
    # fresh child 250; 300 reparented to this backend; 400 still has a live
    # parent (555) — must be spared, as must unrelated 999.
    snap = {
        p200: (1, p200, "L200"),
        p250: (p200, p200, "L250"),
        p300: (me, p300, "L300"),
        p400: (p555, p400, "L400"),
        p555: (1, p555, "L555"),
        p999: (1, p999, "L999"),
    }
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: snap)
    # The table above is POSIX-shaped (launchd is ppid 1); pin the seam to
    # that reading so the sweep, not the host's tree, is what is tested.
    monkeypatch.setattr(
        terminals.osplat.process_tree, "is_orphan_parent",
        lambda ppid, me: ppid in (1, me),
    )
    killed: list[int] = []
    monkeypatch.setattr(
        terminals, "_kill_breakaway", lambda pids: killed.extend(pids)
    )
    await svc._reap_exit_orphans({p200: "L200", p300: "L300", p400: "L400"})
    assert sorted(killed) == [p200, p250, p300]


# Which ppid marks an orphan is the tree's call (Windows normalises a stale
# parent to 0, where a literal `(1, me)` would never match), so the sweep must
# route through `is_orphan_parent` rather than decide for itself.
async def test_reap_asks_the_process_tree_which_ppid_is_an_orphan(monkeypatch):
    svc = TerminalService(emit=_noop_emit)
    snap = {
        200: (0, 200, "L200"),  # stale parent, as a Windows snapshot reports it
        300: (1, 300, "L300"),
    }
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: snap)
    monkeypatch.setattr(
        terminals.osplat.process_tree, "is_orphan_parent",
        lambda ppid, me: ppid in (0, me),
    )
    killed: list[int] = []
    monkeypatch.setattr(
        terminals, "_kill_breakaway", lambda pids: killed.extend(pids)
    )
    await svc._reap_exit_orphans({200: "L200", 300: "L300"})
    assert killed == [200]


async def test_reap_spares_recycled_pid_via_lstart_mismatch(monkeypatch):
    svc = TerminalService(emit=_noop_emit)
    # pid 200 was recycled: same number, launchd-parented, different lstart.
    snap = {200: (1, 200, "L-new-process")}
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: snap)
    killed: list[int] = []
    monkeypatch.setattr(
        terminals, "_kill_breakaway", lambda pids: killed.extend(pids)
    )
    await svc._reap_exit_orphans({200: "L-original"})
    assert killed == []


async def test_reap_never_kills_an_unverifiable_descendant(monkeypatch):
    svc = TerminalService(emit=_noop_emit)
    # No identity on one side or the other: the pid may well have been
    # recycled (on Windows: by this backend's next pane) — never kill blind.
    snap = {200: (1, 200, "L200"), 300: (1, 300, "")}
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: snap)
    monkeypatch.setattr(
        terminals.osplat.process_tree, "is_orphan_parent",
        lambda ppid, me: ppid in (1, me),
    )
    killed: list[int] = []
    monkeypatch.setattr(
        terminals, "_kill_breakaway", lambda pids: killed.extend(pids)
    )
    await svc._reap_exit_orphans({200: "", 300: "L300"})
    assert killed == []


async def test_reap_noop_when_ps_fails(monkeypatch):
    svc = TerminalService(emit=_noop_emit)
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: {})
    killed: list[int] = []
    monkeypatch.setattr(
        terminals, "_kill_breakaway", lambda pids: killed.extend(pids)
    )
    await svc._reap_exit_orphans({200: "L200"})
    assert killed == []


# ---- batch sweeper wiring ----

async def test_close_schedules_reap_on_exit_but_not_on_kill(monkeypatch, tmp_path):
    monkeypatch.setattr(terminals, "_EXIT_ORPHAN_GRACE_S", 0.01)
    reaped: list[list[int]] = []

    async def fake_reap(self, descendants):
        reaped.append(sorted(descendants))

    monkeypatch.setattr(TerminalService, "_reap_exit_orphans", fake_reap)
    # The rolling snapshot loop ticks as soon as a session exists; a table
    # that catches the child alive and childless would replace the seeded
    # snapshot with {} (it did on Windows, where the spawn is slower than
    # the process walk). An empty table is "ps failed": last snapshot kept.
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: {})

    svc = TerminalService(emit=_noop_emit)
    # Natural exit: short-lived child, snapshot pre-seeded.
    s1 = svc.create(
        pane_id="p1",
        agent_key=None,
        command=[sys.executable, "-c", "raise SystemExit(0)"],
        cwd=str(tmp_path),
    )
    s1.descendants = {111: ""}
    for _ in range(100):
        if s1.closed:
            break
        await asyncio.sleep(0.05)
    assert s1.closed
    # The sweep runs once the child is confirmed dead and the batch grace has
    # elapsed; wait for it rather than for a fixed time a loaded runner misses.
    assert await _until(lambda: reaped == [[111]]), reaped

    # kill() path: must NOT queue for the exit reaper (it sweeps on its own).
    s2 = svc.create(
        pane_id="p2",
        agent_key=None,
        command=[sys.executable, "-c", "import time; time.sleep(30)"],
        cwd=str(tmp_path),
    )
    s2.descendants = {222: ""}
    await svc.kill(s2.id, force=True)
    await asyncio.sleep(0.2)
    assert reaped == [[111]]
    await svc.kill_all(grace=0.3)


#: A child that lives until it is told otherwise. The base interpreter, not
#: a Windows venv's python.exe: that is a launcher with the real interpreter
#: as its own child, which killing the launcher's pid would leave running.
_SLEEPER = [getattr(sys, "_base_executable", None) or sys.executable, "-c", "import time; time.sleep(30)"]


class _NotYetReapable:
    """A child the PTY reported EOF for before it could be reaped: poll()
    says it is alive while ``held``, whatever the real process is doing. A
    real child that outlives its PTY closing would need POSIX (a HUP trap)
    and would still race; this holds the window open on every platform."""

    def __init__(self, proc: Any) -> None:
        self._proc = proc
        self.held = True

    def poll(self) -> int | None:
        return None if self.held else self._proc.poll()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._proc, name)


def _end(pid: int) -> None:
    """Put the real child down through the platform seam (SIGKILL, or
    TerminateProcess on Windows)."""
    try:
        osplat.process_tree.kill(pid, force=True)
    except OSError:
        pass  # already gone: closing its PTY (HUP, or the job on Windows) may have ended it


async def _until(predicate: Any, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.01)
    return True


async def test_an_eof_before_the_child_is_reapable_still_sweeps_and_unregisters(
    monkeypatch, tmp_path
):
    """The PTY can report EOF while the child is still finishing its exit:
    it has closed its end of the tty but cannot be reaped yet. Its orphans
    (MCP servers and the like) must still be swept and its crash-recovery
    record dropped once it is confirmed dead."""
    monkeypatch.setattr(terminals, "_EXIT_ORPHAN_GRACE_S", 1.0)
    reaped: list[list[int]] = []
    unregistered: list[int] = []

    async def fake_reap(self, descendants):
        reaped.append(sorted(descendants))

    monkeypatch.setattr(TerminalService, "_reap_exit_orphans", fake_reap)
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: {})
    monkeypatch.setattr(terminals.pty_registry, "unregister", unregistered.append)

    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=_SLEEPER, cwd=str(tmp_path))
    session.descendants = {111: ""}
    session.proc = gate = _NotYetReapable(session.proc)
    svc._close(session, reason="exit")  # EOF first; the child is not reapable yet
    _end(session.proc.pid)
    gate.held = False  # ...and finishes exiting just after

    assert await _until(
        lambda: reaped == [[111]] and session.proc.pid in unregistered
    ), (reaped, unregistered)
    await svc.kill_all(grace=0.3)


async def test_an_eof_whose_child_keeps_running_is_left_alone(
    monkeypatch, tmp_path, caplog
):
    """A child that closed its PTY but is still alive when the settle window
    ends is not ours to sweep under: its descendants are not orphans, and its
    record must stay for the next start's reap_stale."""
    monkeypatch.setattr(terminals, "_EXIT_ORPHAN_GRACE_S", 0.3)
    reaped: list[list[int]] = []
    unregistered: list[int] = []

    async def fake_reap(self, descendants):
        reaped.append(sorted(descendants))

    monkeypatch.setattr(TerminalService, "_reap_exit_orphans", fake_reap)
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: {})
    monkeypatch.setattr(terminals.pty_registry, "unregister", unregistered.append)

    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=_SLEEPER, cwd=str(tmp_path))
    session.descendants = {111: ""}
    session.proc = gate = _NotYetReapable(session.proc)
    try:
        svc._close(session, reason="exit")
        settling = list(svc._exit_settles)
        assert settling, "an EOF with a live child must wait for it"
        await asyncio.gather(*settling)
        await asyncio.sleep(0.1)  # nothing may follow the settle either
        assert reaped == []
        assert session.proc.pid not in unregistered
        assert "still alive" in caplog.text
    finally:
        gate.held = False
        _end(session.proc.pid)
        session.proc.wait(timeout=5)


async def test_kill_all_waits_for_an_eof_still_settling(monkeypatch, tmp_path):
    """Shutdown right after such an EOF: the app closes the database once
    kill_all returns, so the settle's registry write must be done by then."""
    monkeypatch.setattr(terminals, "_EXIT_ORPHAN_GRACE_S", 3.0)
    unregistered: list[int] = []
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: {})
    monkeypatch.setattr(terminals.pty_registry, "unregister", unregistered.append)

    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=_SLEEPER, cwd=str(tmp_path))
    session.proc = gate = _NotYetReapable(session.proc)
    svc._close(session, reason="exit")
    _end(session.proc.pid)

    def exited() -> None:
        gate.held = False

    # The child becomes reapable only once kill_all is under way, so a
    # kill_all that does not wait for the settle returns without the write.
    asyncio.get_running_loop().call_later(1.0, exited)
    await svc.kill_all(grace=0.3)
    assert session.proc.pid in unregistered


async def test_queued_deaths_share_one_sweep(monkeypatch):
    # Everything queued before the sweeper's drain is merged into ONE
    # _reap_exit_orphans call (one ps for the whole batch).
    monkeypatch.setattr(terminals, "_EXIT_ORPHAN_GRACE_S", 0.05)
    reaped: list[list[int]] = []

    async def fake_reap(self, descendants):
        reaped.append(sorted(descendants))

    monkeypatch.setattr(TerminalService, "_reap_exit_orphans", fake_reap)

    svc = TerminalService(emit=_noop_emit)
    svc._pending_reaps.update({111: "", 222: ""})
    await svc._reap_pending_orphans()
    assert reaped == [[111, 222]]


async def test_death_during_grace_waits_for_next_full_grace(monkeypatch):
    # A death landing while a batch sleeps its grace must NOT ride that batch
    # with a truncated grace — it is swept in the next round.
    monkeypatch.setattr(terminals, "_EXIT_ORPHAN_GRACE_S", 0.2)
    reaped: list[list[int]] = []

    async def fake_reap(self, descendants):
        reaped.append(sorted(descendants))

    monkeypatch.setattr(TerminalService, "_reap_exit_orphans", fake_reap)

    svc = TerminalService(emit=_noop_emit)
    svc._pending_reaps.update({111: ""})
    task = asyncio.get_running_loop().create_task(svc._reap_pending_orphans())
    await asyncio.sleep(0.05)  # batch 1 is mid-grace
    svc._pending_reaps.update({222: ""})
    await task
    assert reaped == [[111], [222]]


async def test_sweeper_survives_reap_exception(monkeypatch):
    # One failing sweep must not kill the sweeper: later batches still run.
    monkeypatch.setattr(terminals, "_EXIT_ORPHAN_GRACE_S", 0.05)
    calls: list[list[int]] = []

    async def flaky_reap(self, descendants):
        calls.append(sorted(descendants))
        if len(calls) == 1:
            raise RuntimeError("executor shutting down")

    monkeypatch.setattr(TerminalService, "_reap_exit_orphans", flaky_reap)

    svc = TerminalService(emit=_noop_emit)
    svc._pending_reaps.update({111: ""})
    task = asyncio.get_running_loop().create_task(svc._reap_pending_orphans())
    await asyncio.sleep(0.02)  # batch 1 is mid-grace; queue a second death
    svc._pending_reaps.update({222: ""})
    await task  # batch 1's reap raises, batch 2 must still be swept
    assert calls == [[111], [222]]


# ---- integration: a real detached grandchild orphaned by parent death ----

@pytest.mark.skipif(not hasattr(os, "setsid"), reason="needs POSIX setsid")
async def test_exit_orphan_reaped_end_to_end(
    setsid_grandchild, pid_alive, wait_pid_dead
):
    # SIGKILL the parent (simulating a CLI crash — no kill() sweep runs): the
    # setsid grandchild is orphaned. _reap_exit_orphans with the pre-death
    # snapshot must take it down (real lstart identities match).
    parent, grand_pid = setsid_grandchild

    # Rolling snapshot (with real lstart) taken while the parent lives.
    snap = _ps_snapshot()
    pids = _walk_descendants(_children_map(snap), parent.pid)
    descendants = {pid: snap[pid][2] for pid in pids}
    assert grand_pid in descendants

    # Parent dies ungracefully; grandchild survives as an orphan.
    os.killpg(os.getpgid(parent.pid), signal.SIGKILL)
    parent.wait(timeout=2)
    time.sleep(0.1)
    assert pid_alive(grand_pid), "grandchild should survive the parent's death"

    svc = TerminalService(emit=_noop_emit)
    await svc._reap_exit_orphans(descendants)
    assert wait_pid_dead(grand_pid), "orphan must be reaped by _reap_exit_orphans"
