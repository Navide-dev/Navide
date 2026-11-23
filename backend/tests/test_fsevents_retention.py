"""watchdog's macOS FSEvents observer must not retain memory per event.

watchdog 6.0.0's `_watchdog_fsevents` never released the lists it hands to the
Python callback, nor the `NativeEvent` objects built from them — about 370
bytes for every raw filesystem event under any watched root (#144). The
backend carried its own emitter to work around it until watchdog 7.1.0 fixed
both in the extension; this keeps the fix from regressing on an upgrade.
"""

from __future__ import annotations

import gc
import os
import sys
import time
import tracemalloc
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="FSEvents is macOS-only")


def _churn(watched: Path, seen: list[str], ops: int, tag: str) -> None:
    deleted = seen.count("deleted")
    for i in range(ops):
        p = watched / f"{tag}{i}.json"
        p.write_text("{}")
        os.remove(p)
        if i % 20 == 0:
            time.sleep(0.02)
    # Settled means nothing new for a whole second — events still queued for
    # dispatch at snapshot time would read as retained memory.
    deadline = time.monotonic() + 60
    last = -1
    while time.monotonic() < deadline and len(seen) != last:
        last = len(seen)
        time.sleep(1.0)
    assert seen.count("deleted") - deleted >= ops // 2, "the observer stopped delivering events"


def _watchdog_bytes(snapshot: tracemalloc.Snapshot) -> int:
    """Bytes allocated by watchdog code — an exact path, since a loose pattern
    also takes in this file, whose own lists grow meanwhile."""
    import watchdog

    only = [tracemalloc.Filter(True, os.path.join(os.path.dirname(watchdog.__file__), "*"))]
    return sum(stat.size for stat in snapshot.filter_traces(only).statistics("filename"))


def test_observed_events_do_not_accumulate(tmp_path: Path) -> None:
    """Retention is measured between two windows after a warm-up, so a fixed
    residue (first batches, allocator caches) cancels out whatever the batch
    sizes, which shrink on a loaded machine — while anything retained per
    event or per callback still shows up in full."""
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer

    assert Observer.__module__ == "watchdog.observers.fsevents"

    seen: list[str] = []

    class _Handler(FileSystemEventHandler):
        def on_any_event(self, event) -> None:  # noqa: ANN001
            seen.append(event.event_type)

    watched = tmp_path / "w"
    watched.mkdir()
    observer = Observer()
    observer.schedule(_Handler(), str(watched), recursive=True)
    observer.start()
    tracemalloc.start(1)
    ops = 2000
    try:
        time.sleep(1.0)
        _churn(watched, seen, 1000, "warm")
        _churn(watched, seen, ops, "a")
        gc.collect()
        start = _watchdog_bytes(tracemalloc.take_snapshot())
        _churn(watched, seen, ops, "b")
        gc.collect()
        end = _watchdog_bytes(tracemalloc.take_snapshot())
    finally:
        tracemalloc.stop()
        observer.stop()
        observer.join()

    # watchdog 6.0.0: ~390 bytes per create+delete; leaking only the four list
    # shells per callback: tens of bytes, more the smaller the batches.
    assert (end - start) / ops < 10, f"{(end - start) / ops:.0f} bytes retained per operation"
