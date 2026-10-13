"""Startup orphan reaper: PTY children recorded on spawn must be reaped by the
next backend start when the previous run died without its shutdown sweep.

Identity is pid + ps lstart (survives the shell's exec of the final command
and defeats pid recycling); entries owned by a live sibling backend are left
untouched."""
from __future__ import annotations

import asyncio
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest

from agent_team_backend import osplat, pty_registry
from agent_team_backend.terminals import TerminalService


def _registry() -> dict:
    return pty_registry._load()


def _set_owner(pid: int, owner: int) -> None:
    """Rewrite an entry's owner so reap treats the recording backend as dead
    (pid 1 = launchd: alive but not an agent_team_backend process)."""
    entries = _registry()
    entries[str(pid)]["owner"] = owner
    pty_registry._save(entries)


def test_register_unregister_roundtrip() -> None:
    proc = subprocess.Popen(["sleep", "30"], start_new_session=True)
    try:
        pty_registry.register(proc.pid, ["sleep", "30"])
        entry = _registry()[str(proc.pid)]
        assert entry["argv0"] == "sleep"
        assert entry["lstart"]
        assert entry["owner"] == os.getpid()
        pty_registry.unregister(proc.pid)
        assert _registry() == {}
    finally:
        proc.kill()
        proc.wait()


def test_scan_orphans_lists_dead_backend_children_read_only() -> None:
    proc = subprocess.Popen(["sleep", "300"], start_new_session=True)
    try:
        pty_registry.register(proc.pid, ["sleep", "300"])
        _set_owner(proc.pid, 1)  # recording backend looks dead (owner = launchd)

        orphans = pty_registry.scan_orphans()

        assert orphans == [proc.pid]
        # Read-only: the process is NOT killed and the registry is untouched.
        assert proc.poll() is None
        assert str(proc.pid) in _registry()
    finally:
        proc.kill()
        proc.wait()


def test_scan_orphans_empty_registry() -> None:
    assert pty_registry.scan_orphans() == []


def test_legacy_json_imported_once_and_retired() -> None:
    import json

    legacy = pty_registry._registry_path()
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text(
        json.dumps({"123": {"argv0": "zsh", "lstart": "x", "owner": 1}}),
        encoding="utf-8",
    )
    assert pty_registry._load() == {"123": {"argv0": "zsh", "lstart": "x", "owner": 1}}
    assert not legacy.exists()
    assert legacy.with_name(legacy.name + ".migrated-v1").exists()
    # Import runs once; the imported data survives a re-read.
    assert "123" in pty_registry._load()


def test_scan_orphans_skips_live_sibling_owned(monkeypatch) -> None:
    proc = subprocess.Popen(["sleep", "300"], start_new_session=True)
    try:
        pty_registry.register(proc.pid, ["sleep", "300"])
        _set_owner(proc.pid, 999999)  # owned by another backend pid
        monkeypatch.setattr(pty_registry, "_backend_alive", lambda _pid: True)

        assert pty_registry.scan_orphans() == []  # a live sibling owns it
    finally:
        proc.kill()
        proc.wait()


def test_scan_orphans_skips_own_live_children() -> None:
    # Entries owned by THIS backend are its live in-window sessions, not
    # orphans — regression: `owner != me` used to let them fall through to
    # _classify, so the badge counted (and reap killed) live sessions.
    proc = subprocess.Popen(["sleep", "300"], start_new_session=True)
    try:
        pty_registry.register(proc.pid, ["sleep", "300"])  # owner = os.getpid()

        assert pty_registry.scan_orphans() == []
    finally:
        proc.kill()
        proc.wait()


def test_reap_leaves_own_live_children_untouched() -> None:
    proc = subprocess.Popen(["sleep", "300"], start_new_session=True)
    try:
        pty_registry.register(proc.pid, ["sleep", "300"])  # owner = os.getpid()

        assert pty_registry.reap_stale(grace=0.0) == []
        assert proc.poll() is None  # not signalled
        assert str(proc.pid) in _registry()  # entry preserved
    finally:
        proc.kill()
        proc.wait()


def test_reap_kills_recorded_orphan() -> None:
    proc = subprocess.Popen(["sleep", "300"], start_new_session=True)
    pty_registry.register(proc.pid, ["sleep", "300"])
    _set_owner(proc.pid, 1)

    reaped = pty_registry.reap_stale(grace=0.2)

    assert reaped == [proc.pid]
    proc.wait(timeout=5)
    assert _registry() == {}


@pytest.mark.skipif(not hasattr(os, "setsid"), reason="/bin/sh exec + lstart identity is POSIX-only")
def test_reap_kills_orphan_behind_shell_exec() -> None:
    # The real app spawns `<shell> -lc <cmd>`; the shell execs the final
    # command, so ps shows `sleep 300`, not the shell. Identity must still
    # match via lstart. The exec is spelled out so the test does not depend on
    # which /bin/sh (bash, dash, zsh) applies that optimisation on its own.
    argv = ["/bin/sh", "-c", "exec sleep 300"]
    proc = subprocess.Popen(argv, start_new_session=True)
    pty_registry.register(proc.pid, argv)
    _set_owner(proc.pid, 1)

    reaped = pty_registry.reap_stale(grace=0.2)

    assert reaped == [proc.pid]
    proc.wait(timeout=5)
    assert _registry() == {}


def test_update_descendants_attaches_to_existing_entry_only() -> None:
    proc = subprocess.Popen(["sleep", "30"], start_new_session=True)
    try:
        pty_registry.register(proc.pid, ["sleep", "30"])
        unknown = proc.pid + 1_000_000  # never the registered root
        pty_registry.update_descendants(
            {proc.pid: {900: "L900"}, unknown: {901: "L901"}}
        )
        entries = _registry()
        assert entries[str(proc.pid)]["descendants"] == {"900": "L900"}
        assert str(unknown) not in entries  # unknown root must not create an entry
    finally:
        proc.kill()
        proc.wait()
        pty_registry.unregister(proc.pid)


def test_update_descendants_skips_write_when_unchanged(monkeypatch) -> None:
    proc = subprocess.Popen(["sleep", "30"], start_new_session=True)
    try:
        pty_registry.register(proc.pid, ["sleep", "30"])
        pty_registry.update_descendants({proc.pid: {900: "L900"}})
        saves = []
        monkeypatch.setattr(pty_registry, "_save", lambda e: saves.append(e))
        pty_registry.update_descendants({proc.pid: {900: "L900"}})
        assert saves == []  # unchanged snapshot must not rewrite the file
    finally:
        proc.kill()
        proc.wait()
        pty_registry.unregister(proc.pid)


def _dead_pid() -> int:
    p = subprocess.Popen(["sleep", "0.01"])
    p.wait()
    return p.pid


def test_reap_kills_matching_descendant_of_gone_root() -> None:
    # The root CLI died on its own while its backend was down (no EOF reap
    # ran); its detached grandchild survives. reap_stale must identity-check
    # the recorded descendant and take it down even though the root is gone.
    orphan = subprocess.Popen(["sleep", "300"], start_new_session=True)
    try:
        lstart = osplat.process_tree.start_time(orphan.pid)
        assert lstart
        root_pid = _dead_pid()
        pty_registry._save({
            str(root_pid): {
                "argv0": "x",
                "lstart": "Thu Jan  1 00:00:00 1970",
                "owner": 1,
                "descendants": {str(orphan.pid): lstart},
            }
        })

        # scan_orphans must surface the same set reap_stale would kill —
        # the UI gates manual cleanup on this count.
        assert pty_registry.scan_orphans() == [orphan.pid]

        reaped = pty_registry.reap_stale(grace=0.2)

        assert reaped == [orphan.pid]
        orphan.wait(timeout=5)
        assert _registry() == {}
    finally:
        try:
            orphan.kill()
        except ProcessLookupError:
            pass
        orphan.wait()


def test_reap_never_kills_descendants_under_an_unverifiable_live_root() -> None:
    # register()'s lstart probe can fail at spawn time (stored as "") — the
    # root then classifies unverifiable even while ALIVE. Its recorded
    # descendants are its live MCP servers; killing them under a running CLI
    # is the one unacceptable outcome. Root pid present in the table ⇒ never
    # sweep; the entry is dropped without signalling anything.
    root = subprocess.Popen(["sleep", "300"], start_new_session=True)
    server = subprocess.Popen(["sleep", "300"], start_new_session=True)
    try:
        lstart = osplat.process_tree.start_time(server.pid)
        assert lstart
        pty_registry._save({
            str(root.pid): {
                "argv0": "x",
                "lstart": "",  # register-time probe failed
                "owner": 1,
                "descendants": {str(server.pid): lstart},
            }
        })

        assert pty_registry.scan_orphans() == []
        assert pty_registry.reap_stale(grace=0.0) == []
        assert root.poll() is None  # root untouched
        assert server.poll() is None  # its live server untouched
        assert _registry() == {}  # unverifiable entry dropped
    finally:
        for p in (root, server):
            try:
                p.kill()
            except ProcessLookupError:
                pass
            p.wait()


def test_reap_spares_descendant_with_wrong_lstart() -> None:
    # A recycled descendant pid (recorded lstart no longer matches) must not
    # be signalled; the dead root's entry is still dropped.
    bystander = subprocess.Popen(["sleep", "300"], start_new_session=True)
    try:
        root_pid = _dead_pid()
        pty_registry._save({
            str(root_pid): {
                "argv0": "x",
                "lstart": "Thu Jan  1 00:00:00 1970",
                "owner": 1,
                "descendants": {str(bystander.pid): "Thu Jan  1 00:00:00 1970"},
            }
        })

        assert pty_registry.reap_stale(grace=0.0) == []
        assert bystander.poll() is None  # not signalled
        assert _registry() == {}
    finally:
        bystander.kill()
        bystander.wait()


def test_reap_kills_root_group_and_detached_descendant_together() -> None:
    # The backend-SIGKILL scenario: root CLI still alive (killpg reaps it) AND
    # its MCP-style grandchild detached into its own session — killpg misses
    # it, the recorded descendant snapshot must not.
    root = subprocess.Popen(["sleep", "300"], start_new_session=True)
    detached = subprocess.Popen(["sleep", "300"], start_new_session=True)
    try:
        pty_registry.register(root.pid, ["sleep", "300"])
        _set_owner(root.pid, 1)
        lstart = osplat.process_tree.start_time(detached.pid)
        assert lstart
        pty_registry.update_descendants({root.pid: {detached.pid: lstart}})

        reaped = pty_registry.reap_stale(grace=0.2)

        assert sorted(reaped) == sorted([root.pid, detached.pid])
        root.wait(timeout=5)
        detached.wait(timeout=5)
        assert _registry() == {}
    finally:
        for p in (root, detached):
            try:
                p.kill()
            except ProcessLookupError:
                pass
            p.wait()


def test_reap_never_signals_a_recycled_pid() -> None:
    # Entry whose pid now belongs to a different process (us) with a different
    # start time: must be dropped without being signalled.
    pty_registry.register(os.getpid(), ["definitely-not-this-executable"])
    entries = _registry()
    entries[str(os.getpid())]["lstart"] = "Thu Jan  1 00:00:00 1970"
    entries[str(os.getpid())]["owner"] = 1
    pty_registry._save(entries)

    assert pty_registry.reap_stale(grace=0.0) == []
    assert _registry() == {}


def test_reap_force_round_re_verifies_identity_after_the_grace(monkeypatch) -> None:
    # The root matched at the first look and got the polite signal; during
    # the grace its pid was recycled (a Windows backend's own first panes can
    # land there). The force round must be re-checked against a fresh table:
    # the recycled pid is dropped, the still-matching descendant is kept, and
    # a fresh probe that fails authorizes nothing.
    tables = [
        {77: (77, "L77"), 88: (88, "L88")},        # verdict snapshot
        {77: (77, "L77-recycled"), 88: (88, "L88")},  # after the grace
    ]
    monkeypatch.setattr(pty_registry, "_ps_table", lambda: tables.pop(0))
    monkeypatch.setattr(pty_registry, "_backend_alive", lambda pid: False)
    sent: list[tuple[list[tuple[int, bool]], bool]] = []
    monkeypatch.setattr(
        pty_registry, "_signal_each",
        lambda targets, *, force: sent.append((list(targets), force)),
    )
    pty_registry._save({
        "77": {"argv0": "x", "lstart": "L77", "owner": 1, "descendants": {"88": "L88"}},
    })

    assert pty_registry.reap_stale(grace=0.0) == [77, 88]
    assert sent == [([(77, True), (88, True)], False), ([(88, True)], True)]

    tables[:] = [{77: (77, "L77")}, None]  # the fresh probe fails
    sent.clear()
    pty_registry._save({"77": {"argv0": "x", "lstart": "L77", "owner": 1}})
    pty_registry.reap_stale(grace=0.0)
    assert sent == [([(77, True)], False), ([], True)]


def test_reap_leaves_live_sibling_entries_untouched(monkeypatch) -> None:
    proc = subprocess.Popen(["sleep", "30"], start_new_session=True)
    try:
        pty_registry.register(proc.pid, ["sleep", "30"])
        _set_owner(proc.pid, 99999)
        monkeypatch.setattr(pty_registry, "_backend_alive", lambda pid: pid == 99999)

        assert pty_registry.reap_stale(grace=0.0) == []
        assert proc.poll() is None  # not signalled
        assert str(proc.pid) in _registry()  # entry preserved
    finally:
        proc.kill()
        proc.wait()


def test_concurrent_register_unregister_keeps_registry_consistent(monkeypatch) -> None:
    # register/unregister run on executor threads in the real app (terminals.py
    # keeps their ps + file I/O off the event loop) — interleaved
    # load-modify-save must not lose entries or raise.
    monkeypatch.setattr(
        pty_registry.osplat.process_tree, "start_time", lambda pid: "stub lstart"
    )
    pids = list(range(900_000, 900_032))

    def churn(pid: int) -> None:
        for _ in range(5):
            pty_registry.register(pid, ["sleep"])
            pty_registry.unregister(pid)
        pty_registry.register(pid, ["sleep"])

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(churn, pids))  # re-raises any worker exception

    # Each pid is churned by exactly one thread and ends registered — a lost
    # update from an unlocked read-modify-write would drop some of them.
    assert set(_registry()) == {str(p) for p in pids}


async def _noop_emit(event: dict[str, Any]) -> None:
    return None


async def _wait_registry_empty(timeout: float = 5.0) -> None:
    """The entry is dropped only once the child is confirmed dead (kill()'s
    escalation task) — a live TERM-trapping child must stay visible to the
    next start's reap_stale."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if _registry() == {}:
            return
        await asyncio.sleep(0.05)
    assert _registry() == {}


async def _wait_registry_has(pid: int, timeout: float = 5.0) -> None:
    """create() registers via the default executor (off the event loop), so
    the entry appears shortly after create() returns, not synchronously."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        try:
            if str(pid) in _registry():
                return
        except FileNotFoundError:
            pass  # registry file not written yet
        await asyncio.sleep(0.05)
    assert str(pid) in _registry()


@pytest.mark.asyncio
async def test_terminal_service_registers_and_unregisters() -> None:
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    await _wait_registry_has(session.proc.pid)

    await svc.kill(session.id)
    # Poll on the loop rather than proc.wait(): a blocking wait starves the
    # SIGKILL escalation task on this loop, so a child slow to die on SIGTERM
    # (a loaded machine) outlasts the timeout and the test fails spuriously.
    for _ in range(200):
        await asyncio.sleep(0.05)
        if session.proc.poll() is not None:
            break
    assert session.proc.poll() is not None, "child survived the kill"
    await _wait_registry_empty()


@pytest.mark.asyncio
async def test_kill_escalates_term_trapping_child_and_unregisters() -> None:
    # A CLI that traps SIGTERM must still be put down (SIGKILL escalation) and
    # only then lose its crash-recovery record.
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1",
        agent_key=None,
        # HUP trapped too — see test_terminals_error_close_kill.py.
        command=["sh", "-c", 'trap "" TERM HUP; sleep 300'],
        cwd="/",
    )
    await _wait_registry_has(session.proc.pid)
    # Give the shell a moment to install the TERM trap before signalling.
    await asyncio.sleep(0.3)
    await svc.kill(session.id)
    # Entry must survive while the child is still alive under SIGTERM; the
    # SIGKILL escalation then reaps it. Poll on the loop rather than calling
    # proc.wait(): that blocks synchronously and would starve _escalate_kill,
    # which runs as a task on this very loop -- the SIGKILL would never be sent.
    for _ in range(200):
        await asyncio.sleep(0.05)
        if session.proc.poll() is not None:
            break
    assert session.proc.poll() is not None, (
        "child survived the SIGKILL escalation"
    )
    await _wait_registry_empty()
