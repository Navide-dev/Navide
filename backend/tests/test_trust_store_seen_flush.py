"""Delivered message keys reach disk without waiting for the next message.

The ledger is written in batches (every 25 keys, or on the first key recorded
10 s after the last write) — but only when a key is recorded. Nothing flushed it
at shutdown, and nothing flushed a quiet batch, so a message received shortly
before a normal restart could be replayed after it (review: replay H).
"""

from __future__ import annotations

import ast
from pathlib import Path

from agent_team_backend import trust_store


def _restart() -> None:
    with trust_store._lock:
        trust_store._state = None
        trust_store._seen_pending.clear()
        trust_store._seen_last_flush = 0.0
        trust_store._forget_written()


def test_the_backend_flushes_the_ledger_before_closing_the_database():
    src = Path(__file__).resolve().parents[1] / "agent_team_backend" / "app.py"
    tree = ast.parse(src.read_text(encoding="utf-8"))
    stoppers = [n for n in ast.walk(tree)
                if isinstance(n, ast.AsyncFunctionDef) and n.name == "_stop_log_watcher"]
    assert len(stoppers) == 1
    lines: dict[str, int] = {}
    for node in ast.walk(stoppers[0]):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
            lines.setdefault(f"{node.func.value.id}.{node.func.attr}", node.lineno)
    assert "trust_store.flush_seen_messages" in lines
    assert lines["trust_store.flush_seen_messages"] < lines["database.close"]


def test_a_quiet_batch_is_written_on_a_timer(monkeypatch):
    monkeypatch.setattr(trust_store, "SEEN_FLUSH_SECONDS", 0.05)
    trust_store.load()
    trust_store.note_seen_message("m-1")
    trust_store.note_seen_message("m-2")

    import time
    deadline = time.monotonic() + 3
    while trust_store._seen_pending and time.monotonic() < deadline:
        time.sleep(0.02)

    _restart()
    assert trust_store.has_seen_message("m-1") and trust_store.has_seen_message("m-2")


def test_only_one_timer_is_armed_for_a_batch(monkeypatch):
    monkeypatch.setattr(trust_store, "SEEN_FLUSH_SECONDS", 60)
    trust_store.load()
    for index in range(5):
        trust_store.note_seen_message(f"m-{index}")
    timer = trust_store._seen_timer
    assert timer is not None and timer.daemon
    trust_store.note_seen_message("m-5")
    assert trust_store._seen_timer is timer
    trust_store.flush_seen_messages()
    assert trust_store._seen_timer is None


class _RefusingVault:
    """Stands in for whatever the app-wide vault is once a test has moved on."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def __getattr__(self, name):
        def record(*_args, **_kwargs):
            self.calls.append(name)
            raise AssertionError(f"the timer used a vault it was not armed with: {name}")
        return record


def test_a_timer_writes_where_it_was_armed(monkeypatch, tmp_path):
    """Review R2-9: the timer read app.credential_vault and the data dir when it
    fired, so one outliving its test wrote through whatever was in force then —
    after monkeypatch undo, the import-time vault and its real runner."""
    from agent_team_backend import app

    monkeypatch.setattr(trust_store, "SEEN_FLUSH_SECONDS", 0.3)
    trust_store.load()
    armed_vault = app.credential_vault
    armed_journal = trust_store._journal_path()
    trust_store.note_seen_message("m-bound")
    assert trust_store._seen_timer is not None

    later = _RefusingVault()
    monkeypatch.setattr(app, "credential_vault", later)
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "elsewhere"))

    import time
    deadline = time.monotonic() + 3
    while trust_store._seen_pending and time.monotonic() < deadline:
        time.sleep(0.02)
    # The flush empties the batch before it writes, under the lock: wait for it.
    with trust_store._lock:
        pass

    assert later.calls == []
    assert not (tmp_path / "elsewhere").exists()
    # Through the store's reader: on Windows the journal is DPAPI-wrapped.
    assert "m-bound" in trust_store._read_journal_bytes(armed_journal).decode("utf-8")
    monkeypatch.setattr(app, "credential_vault", armed_vault)


def test_conftest_stops_the_timer_when_a_test_ends():
    """Review R2-9: a reset on the way in left the window between one test's
    teardown and the next test's setup, which the last test of a run never
    closes at all."""
    src = Path(__file__).resolve().parent / "conftest.py"
    tree = ast.parse(src.read_text(encoding="utf-8"))
    fixture = next(n for n in ast.walk(tree)
                   if isinstance(n, ast.FunctionDef) and n.name == "_isolated_trust_store")
    after_yield = False
    stops = False
    for node in fixture.body:
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Yield):
            after_yield = True
        elif after_yield and "_stop_seen_timer_for_test" in ast.dump(node):
            stops = True
    assert stops
