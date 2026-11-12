"""account_switch_log (plan agent-0-2-42_3f728e D7): the after-the-fact record
of switches nobody clicked. 90 days, only names, ids and 300 characters of
reason; a failure is swallowed, never raised at the switch."""

from __future__ import annotations

from typing import Any

from agent_team_backend.account_switch_log import RETENTION_S, AccountSwitchLog
from agent_team_backend.db import Database


class _Clock:
    def __init__(self) -> None:
        self.now = 1_000_000_000.0

    def __call__(self) -> float:
        return self.now


def _store(tmp_path: Any, clock: _Clock | None = None) -> AccountSwitchLog:
    return AccountSwitchLog(Database(tmp_path / "navide.db"), clock=clock or _Clock())


def test_a_request_is_recorded_then_settled(tmp_path: Any) -> None:
    log = _store(tmp_path)
    row_id = log.record_request(
        source="mcp", requester="builder", agent_key="claude", to_profile_id="p-2",
        to_name="Work", pane_name=None, reason="quota ran out",
    )
    assert row_id is not None
    assert log.get(row_id)["status"] == "requested"
    assert log.finish(row_id, "switched", from_profile_id="p-1", from_name="Personal")
    row = log.get(row_id)
    assert (row["status"], row["from_profile_id"], row["from_name"], row["to_name"]) == ("switched", "p-1", "Personal", "Work")


def test_the_reason_is_cut_at_300_characters(tmp_path: Any) -> None:
    log = _store(tmp_path)
    row_id = log.record_request(source="mcp", requester="b", agent_key="claude", to_profile_id="p", reason="y" * 400)
    assert log.get(row_id)["reason"] == "y" * 300


def test_rows_older_than_90_days_are_dropped(tmp_path: Any) -> None:
    clock = _Clock()
    log = _store(tmp_path, clock)
    old = log.record_request(source="mcp", requester="b", agent_key="claude", to_profile_id="p", reason="old")
    clock.now += RETENTION_S + 1
    assert [r["reason"] for r in log.list_recent()] == []
    log.record_request(source="mcp", requester="b", agent_key="claude", to_profile_id="p", reason="new")
    assert log.get(old) is None
    assert [r["reason"] for r in log.list_recent()] == ["new"]


def test_newest_first(tmp_path: Any) -> None:
    clock = _Clock()
    log = _store(tmp_path, clock)
    for reason in ("one", "two", "three"):
        log.record_request(source="telegram", requester="t", agent_key="claude", to_profile_id="p", reason=reason)
        clock.now += 1
    assert [r["reason"] for r in log.list_recent()] == ["three", "two", "one"]
    assert len(log.list_recent(limit=2)) == 2


def test_a_closed_database_is_swallowed(tmp_path: Any) -> None:
    db = Database(tmp_path / "navide.db")
    log = AccountSwitchLog(db)
    db._conn.close()
    assert log.record_request(source="mcp", requester="b", agent_key="claude", to_profile_id="p", reason="x") is None
    assert log.finish(1, "switched") is False
    assert log.list_recent() == []
