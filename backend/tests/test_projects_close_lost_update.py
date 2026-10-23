"""A close must not be undone by the live-stamp clear a PTY exit triggers.

Closing a pane kills its PTY and retires its record. The exit event clears the
record's last_live_launch from a worker thread (asyncio.to_thread), while the
renderer's manual_pane.unspawn retires the record on the event loop. Both are
read-modify-write cycles over the whole project document, so a clear that read
the document before the unspawn saved wrote it back afterwards and revived the
closed pane (spawn_status "spawned", removed_at "") for the next restore.
"""

from __future__ import annotations

import threading
from pathlib import Path

from agent_team_backend.projects import ProjectStore


def test_unspawn_survives_a_concurrent_live_stamp_clear(tmp_path: Path) -> None:
    store, ws = ProjectStore(), str(tmp_path)
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="pi", session_id="s1", launch_id="L1")

    loaded, proceed = threading.Event(), threading.Event()
    real_load = store.load_or_create
    clear_thread: list[threading.Thread] = []

    def load_then_pause(*args, **kwargs):  # type: ignore[no-untyped-def]
        project = real_load(*args, **kwargs)
        if clear_thread and threading.current_thread() is clear_thread[0] and not loaded.is_set():
            loaded.set()
            proceed.wait(timeout=2)
        return project

    store.load_or_create = load_then_pause  # type: ignore[method-assign]

    clear = threading.Thread(
        target=store.set_pane_resume_state,
        args=(ws,),
        kwargs={"pane_id": "p1", "last_live_launch": ""},
    )
    clear_thread.append(clear)
    clear.start()
    assert loaded.wait(timeout=2)

    unspawn = threading.Thread(
        target=store.record_manual_pane_unspawn, args=(ws,), kwargs={"pane_id": "p1", "session_id": "s1"}
    )
    unspawn.start()
    unspawn.join(timeout=0.3)  # unfixed: finishes here; fixed: waits for the clear
    proceed.set()
    clear.join(timeout=5)
    unspawn.join(timeout=5)

    store.load_or_create = real_load  # type: ignore[method-assign]
    pane = next(p for p in store.load_or_create(ws).panes if p.pane_id == "p1")
    assert pane.spawn_status == "removed"
    assert pane.removed_at
