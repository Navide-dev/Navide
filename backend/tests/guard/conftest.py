from __future__ import annotations

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.db import Database
from agent_team_backend.guard import runtime, terminal_policy
from agent_team_backend.guard.store import GuardStore


@pytest.fixture(autouse=True)
def guard_store(tmp_path):
    """A fresh navide.db per test; never the process-wide app.database."""
    db = Database(tmp_path / "navide.db")
    store = GuardStore(db)
    runtime.set_store_for_test(store)
    agent_messaging._reset_for_test()
    terminal_policy._EXEMPT_AUDITED.clear()
    yield store
    runtime.set_store_for_test(None)
    agent_messaging._reset_for_test()
    terminal_policy._EXEMPT_AUDITED.clear()
