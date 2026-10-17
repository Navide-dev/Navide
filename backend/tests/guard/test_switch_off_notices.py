"""With the Guard switch off a local CLI action is still evaluated and audited,
but a Guard failure is no longer announced: the user turned Guard off, so a
"could not check an action" notice reads as Guard still checking. The chat
relay keeps its notice (it is enforced whatever the switch says), and so does
a switch that cannot be read."""

from __future__ import annotations

import asyncio
import threading

import pytest

from agent_team_backend import guard_hooks
from agent_team_backend.db import Database
from agent_team_backend.guard import engine, evaluate, runtime
from agent_team_backend.guard.store import GuardStore

CLAUDE_RM = {"tool_name": "Bash", "tool_input": {"command": "rm -rf ~"}}


@pytest.fixture()
def events(monkeypatch):
    seen: list = []
    monkeypatch.setattr(runtime, "emit", lambda t, p: seen.append((t, p)))
    return seen


@pytest.fixture()
def gate():
    """Holds the timed-out hook's worker until the test has asserted: left to
    finish, it would decide and announce its own ask into `events`."""
    held = threading.Event()
    yield held
    held.set()


def _slow_hook(monkeypatch, gate):
    monkeypatch.setattr(guard_hooks, "decide", lambda *a, **k: gate.wait(5))
    monkeypatch.setattr(guard_hooks, "EVALUATE_BUDGET_S", 0.05)
    return asyncio.run(guard_hooks.respond("claude", CLAUDE_RM, pane_id="p1", cwd="/w", workspace="/w"))


def _broken_evaluate(monkeypatch, source):
    monkeypatch.setattr(engine, "classify", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("kaput")))
    return evaluate(pane_id="p1", vendor="claude", tool="Bash", tool_input={"command": "ls"},
                    cwd="/w", workspace="/w", source=source)


def test_hook_timeout_is_not_announced_while_switched_off(guard_store, events, gate, monkeypatch):
    guard_store.set_enabled(False)
    assert _slow_hook(monkeypatch, gate) is None
    assert events == []


def test_hook_timeout_is_announced_while_switched_on(guard_store, events, gate, monkeypatch):
    assert _slow_hook(monkeypatch, gate) is None
    assert [(t, p["action"]) for t, p in events] == [("guard.decision", "error")]


def test_evaluate_error_is_not_announced_while_switched_off(guard_store, events, monkeypatch):
    guard_store.set_enabled(False)
    assert _broken_evaluate(monkeypatch, "local").action == "allow"
    assert events == []


def test_relay_error_is_announced_whatever_the_switch(guard_store, events, monkeypatch):
    guard_store.set_enabled(False)
    assert _broken_evaluate(monkeypatch, "relay").action == "deny"
    assert [(t, p["action"]) for t, p in events] == [("guard.decision", "deny")]


def test_unreadable_switch_still_announces(guard_store, events, monkeypatch):
    def locked():
        raise RuntimeError("database is locked")

    monkeypatch.setattr(guard_store, "enabled_cached", locked)
    guard_hooks._announce_failure("p1", "x")
    assert [(t, p["action"]) for t, p in events] == [("guard.decision", "error")]


def test_announcing_on_the_loop_never_touches_the_database(guard_store, events, monkeypatch, tmp_path):
    """_announce_failure runs on the event loop: a switch not read yet counts
    as on (announced, as on main) rather than being loaded from the database."""
    db = Database(tmp_path / "cold.db")
    GuardStore(db).set_enabled(False)
    cold = GuardStore(db)  # same saved switch (off), nothing cached yet
    runtime.set_store_for_test(cold)
    monkeypatch.setattr(db, "kv_get", lambda *a, **k: pytest.fail("kv_get on the event loop"))
    guard_hooks._announce_failure("p1", "x")
    assert [(t, p["action"]) for t, p in events] == [("guard.decision", "error")]


def test_announcing_before_any_store_never_opens_one(guard_store, events, monkeypatch):
    runtime.set_store_for_test(None)
    monkeypatch.setattr(runtime, "GuardStore", lambda *a, **k: pytest.fail("GuardStore built on the event loop"))
    guard_hooks._announce_failure("p1", "x")
    assert [(t, p["action"]) for t, p in events] == [("guard.decision", "error")]
