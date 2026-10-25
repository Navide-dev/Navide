"""A close must not be undone by another writer of the project document.

Closing a pane kills its PTY and retires its record. The PTY exit clears the
record's last_live_launch from a worker thread (asyncio.to_thread), while the
renderer's manual_pane.unspawn retires the record on the event loop. Every
store mutation reads the whole project document and saves it back, so a writer
that read the document before the unspawn saved wrote its stale copy back
afterwards and revived the closed pane (spawn_status "spawned", removed_at "")
for the next restore. The save lock therefore has to span each mutation's read
through its save.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend.projects import ProjectStore

_WAIT = 5  # seconds; bounds every wait so a regression fails instead of hanging

MUTATORS: dict[str, Callable[[ProjectStore, str], Any]] = {
    "resume_state": lambda s, ws: s.set_pane_resume_state(ws, pane_id="p1", last_live_launch=""),
    "manual_session": lambda s, ws: s.record_manual_pane_session(ws, pane_id="p1", session_id="s2"),
    "stopped": lambda s, ws: s.set_pane_stopped(ws, pane_id="p1", stopped=True),
    "auto_name": lambda s, ws: s.set_pane_auto_name(ws, pane_id="p1", auto_name="Named"),
    "slot_unspawn": lambda s, ws: s.record_slot_unspawn(ws, stage_index=0, slot_label="a"),
}


class _ProbeLock:
    """The store's RLock, reporting when the unspawn thread has to wait for it."""

    def __init__(self, inner: Any, settled: threading.Event) -> None:
        self._inner, self._settled = inner, settled

    def __enter__(self) -> "_ProbeLock":
        got = self._inner.acquire(blocking=False)
        if not got:
            if threading.current_thread().name == "unspawn":
                self._settled.set()  # fixed code: the unspawn is queued behind the mutator
            self._inner.acquire()
        return self

    def __exit__(self, *exc: object) -> None:
        self._inner.release()


@pytest.mark.parametrize("mutator", MUTATORS)
def test_unspawn_survives_a_concurrent_mutation(tmp_path: Path, mutator: str) -> None:
    store, ws = ProjectStore(), str(tmp_path)
    store.start_pipeline(
        ws, task_description="t", total_stages=1, stage_blueprint=[{"stage_id": "s", "slots": [{"label": "a"}]}]
    )
    store.record_slot_spawn(ws, stage_index=0, slot_label="a", pane_id="slot1")
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="pi", session_id="s1", launch_id="L1")

    loaded, proceed, settled = threading.Event(), threading.Event(), threading.Event()
    store._save_lock = _ProbeLock(store._save_lock, settled)  # type: ignore[assignment]

    def pause_after_read(real: Callable[..., Any]) -> Callable[..., Any]:
        def read(*args: Any, **kwargs: Any) -> Any:
            project = real(*args, **kwargs)
            if threading.current_thread().name == "mutator" and not loaded.is_set():
                loaded.set()
                proceed.wait(timeout=_WAIT)
            return project

        return read

    store.load_or_create = pause_after_read(store.load_or_create)  # type: ignore[method-assign]
    store.peek = pause_after_read(store.peek)  # type: ignore[method-assign]

    def unspawn() -> None:
        try:
            store.record_manual_pane_unspawn(ws, pane_id="p1", session_id="s1")
        finally:
            settled.set()  # unfixed code: the unspawn finished without waiting

    mut = threading.Thread(target=MUTATORS[mutator], args=(store, ws), name="mutator")
    mut.start()
    assert loaded.wait(timeout=_WAIT), "the mutator never read the document"
    unspawn_thread = threading.Thread(target=unspawn, name="unspawn")
    unspawn_thread.start()
    # Either the unspawn finished (no lock spans the mutator's read-to-save) or
    # it is queued on the lock; only then may the mutator save its stale copy.
    assert settled.wait(timeout=_WAIT)
    proceed.set()
    mut.join(timeout=_WAIT)
    unspawn_thread.join(timeout=_WAIT)
    assert not mut.is_alive() and not unspawn_thread.is_alive()

    pane = next(p for p in store.load_or_create(ws).panes if p.pane_id == "p1")
    assert pane.spawn_status == "removed"
    assert pane.removed_at
