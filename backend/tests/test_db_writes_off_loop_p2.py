"""Handlers commit off the event loop while the disk is slow (phase two).

A single SQLite commit's fsync measured 21.7s on the 0.2.39 VM run. Phase one
moved the pipeline run records to db_executor's worker; phase two moves the
rest of the handler writes (ws_handlers, guard, channels). Here every commit
of a real Database waits a second, still holding the connection lock as a
slow fsync would, and a light request sent meanwhile must answer within 200ms.
"""

from __future__ import annotations

import asyncio
import dataclasses
import threading
import time
from contextlib import contextmanager

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers
from agent_team_backend.analyzer_settings import AnalyzerSettingsStore
from agent_team_backend.channels.manager import ChannelManager, Seams
from agent_team_backend.channels.store import ChannelStore
from agent_team_backend.db import Database
from agent_team_backend.guard import runtime as guard_runtime
from agent_team_backend.guard import ws_api as guard_ws_api
from agent_team_backend.guard.store import GuardStore

SLOW_COMMIT_S = 1.0
LIGHT_REQUEST_BUDGET_S = 0.2


class _Session:
    def __init__(self) -> None:
        self.sent: list = []
        self.dead = False
        self.window_id = "win-1"

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


class _SlowCommits:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._monkeypatch = monkeypatch
        self.threads: list[int] = []

    def start(self) -> None:
        """From now on every outer commit sleeps under the connection lock."""
        original = Database.transaction
        threads = self.threads

        @contextmanager
        def slow_transaction(db: Database):
            with db._lock:
                outer = not db._conn.in_transaction
                with original(db) as cur:
                    yield cur
                if outer:
                    threads.append(threading.get_ident())
                    time.sleep(SLOW_COMMIT_S)

        self._monkeypatch.setattr(Database, "transaction", slow_transaction)


@pytest.fixture
def slow_commits(monkeypatch: pytest.MonkeyPatch) -> _SlowCommits:
    return _SlowCommits(monkeypatch)


async def _ping_while(write) -> float:
    """Start ``write``, then time a ping sent while its commit is in flight."""
    writing = asyncio.create_task(write())
    began = time.monotonic()
    await asyncio.sleep(0.05)  # the write has reached its commit
    session = _Session()
    await ws_handlers.lookup("ping")(session, "p1", "ping", {})
    # Measured from before the sleep: a commit on the loop would stall it.
    latency = time.monotonic() - began - 0.05
    assert session.sent and session.sent[-1]["ok"] is True
    await writing
    return latency


async def test_ws_handler_write_leaves_the_loop_free(tmp_path, monkeypatch, slow_commits) -> None:
    store = AnalyzerSettingsStore(tmp_path / "analyzer.json", Database(tmp_path / "navide.db"))
    slow_commits.start()

    async def fake_broadcast(_event: dict) -> None:
        pass

    monkeypatch.setattr(app_module, "analyzer_settings_store", store, raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    session = _Session()

    latency = await _ping_while(lambda: ws_handlers.lookup("analyzer.settings.set")(
        session, "m1", "analyzer.settings.set", {"enabled": False}))

    assert latency < LIGHT_REQUEST_BUDGET_S, f"ping took {latency:.2f}s behind a slow commit"
    assert slow_commits.threads and threading.get_ident() not in slow_commits.threads
    assert session.sent[-1]["ok"] is True


async def test_guard_write_leaves_the_loop_free(tmp_path, slow_commits) -> None:
    store = GuardStore(Database(tmp_path / "navide.db"))
    guard_runtime.set_store_for_test(store)
    slow_commits.start()
    session = _Session()
    try:
        latency = await _ping_while(lambda: guard_ws_api.handle(
            session, "m1", "guard.set_enabled", {"enabled": False}))
    finally:
        guard_runtime.set_store_for_test(None)

    assert latency < LIGHT_REQUEST_BUDGET_S, f"ping took {latency:.2f}s behind a slow commit"
    assert slow_commits.threads and threading.get_ident() not in slow_commits.threads
    assert session.sent[-1]["payload"] == {"ok": True}
    assert store.enabled() is False


async def test_channel_write_leaves_the_loop_free(tmp_path, slow_commits) -> None:
    async def noop(*_a, **_k):
        return {}

    seams = Seams(**{
        f.name: noop for f in dataclasses.fields(Seams)
        if f.default is dataclasses.MISSING and f.default_factory is dataclasses.MISSING
    })
    store = ChannelStore(Database(tmp_path / "navide.db"))
    manager = ChannelManager(store, seams)
    slow_commits.start()

    latency = await _ping_while(lambda: manager.set_global_enabled(False))

    assert latency < LIGHT_REQUEST_BUDGET_S, f"ping took {latency:.2f}s behind a slow commit"
    assert slow_commits.threads and threading.get_ident() not in slow_commits.threads
    assert store.global_enabled() is False
