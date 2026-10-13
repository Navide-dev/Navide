"""Helpers for tests that drive a real GitWatcher observer.

On Windows, watchdog opens the directory handle inside `watch()` but only
issues the first ReadDirectoryChangesW from the emitter thread, and the system
records changes only from that first call on. On a loaded runner that thread
can start well after `watch()` returns, so a write made straight away is never
reported. Tests therefore arm the watcher (write probes until one is seen)
before the writes they assert on, and wait on conditions, not fixed sleeps.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend.git_watcher import _RepoHandler


async def wait_until(cond: Callable[[], Any], timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while not cond():
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.02)
    return True


async def arm(probe_dir: Path, seen: list[Any], per_probe_s: float, timeout: float = 30.0) -> None:
    """Write probe files into `probe_dir` until the sink filling `seen` reports
    one — proof the observer is reading events, not just registered."""
    deadline = time.monotonic() + timeout
    n = 0
    while time.monotonic() < deadline:
        (probe_dir / f"arm-probe-{n}.txt").write_text("x", encoding="utf-8")
        n += 1
        if await wait_until(lambda: seen, per_probe_s):
            return
    raise AssertionError(f"watcher never reported a probe write within {timeout}s")


@pytest.fixture(params=[0.0, 1.0], ids=["armed", "slow-arming"])
def arming_delay(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> float:
    """Replays the Windows start-up gap on any platform: every event a handler
    receives in its first `delay` seconds is dropped, as if the emitter had not
    issued its first read yet."""
    delay: float = request.param
    if delay:
        orig_init = _RepoHandler.__init__
        orig_event = _RepoHandler.on_any_event

        def init(self: _RepoHandler, *args: Any, **kwargs: Any) -> None:
            orig_init(self, *args, **kwargs)
            self._test_armed_at = time.monotonic() + delay  # type: ignore[attr-defined]

        def on_any_event(self: _RepoHandler, event: Any) -> None:
            if time.monotonic() >= self._test_armed_at:  # type: ignore[attr-defined]
                orig_event(self, event)

        monkeypatch.setattr(_RepoHandler, "__init__", init)
        monkeypatch.setattr(_RepoHandler, "on_any_event", on_any_event)
    return delay
