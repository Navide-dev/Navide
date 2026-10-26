"""Watchdog option C (contract section 5.2): the record of resource notices and the user's decisions.

When a third-party backend goes over a resource threshold the Host notifies
the user, who keeps it running or stops it. The Host sends each step as a row
of ``plugin.resource.decision``; the backend keeps them in
``plugin_resource_decisions`` (90 days, like the daily activity counts; a
removed plugin's rows go with ``plugin.activity.forget``). Only the measured
item and numbers are stored, never a path or command line.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, ws_handlers
from agent_team_backend.db import Database
from agent_team_backend.plugins import agent_tools_contract as contract
from agent_team_backend.plugins.audit_log import PluginAuditLog

DAY_MS = 86_400_000
_FIXTURE = (
    Path(__file__).resolve().parents[2] / "docs" / "plugin-contracts" / "agent-tools-fixtures" / "resource-decisions.json"
)


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session(*, host: bool) -> Any:
    session = app.Session(_FakeWebSocket())  # type: ignore[arg-type]
    session.host_authenticated = host
    return session


@pytest.fixture
def audit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> PluginAuditLog:
    log = PluginAuditLog(Database(tmp_path / "navide.db"))
    monkeypatch.setattr(app, "plugin_audit_log", log)
    return log


def _fixture() -> dict[str, Any]:
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def _stored(audit: PluginAuditLog) -> list[dict[str, Any]]:
    audit.flush()
    with audit.db.transaction() as cur:
        return [dict(r) for r in cur.execute("SELECT * FROM plugin_resource_decisions ORDER BY id")]


async def _send(session: Any, payload: Any) -> dict[str, Any]:
    await ws_handlers.plugin_resource_decision(session, "1", contract.PLUGIN_RESOURCE_DECISION_MESSAGE, payload)
    return session.websocket.sent[-1]


def test_the_wire_name_and_enums_are_the_contracts() -> None:
    assert contract.PLUGIN_RESOURCE_DECISION_MESSAGE == "plugin.resource.decision"
    assert contract.PLUGIN_RESOURCE_ITEMS == ("memory", "cpu", "processes", "disk", "stdoutPending")
    assert contract.PLUGIN_RESOURCE_DECISIONS == ("notified", "continue", "terminate")


async def test_every_valid_fixture_row_is_stored_as_sent(audit: PluginAuditLog) -> None:
    rows = _fixture()["valid"]
    now = int(time.time() * 1000)
    rows = [{**row, "at": min(row["at"], now)} for row in rows]  # the fixture's times may be ahead of this clock
    answer = await _send(_session(host=True), {"rows": rows})
    assert answer["payload"] == {"ok": True, "accepted": len(rows)}
    stored = _stored(audit)
    assert [{k: r[k] for k in ("plugin_id", "plugin_version", "item", "usage", "threshold", "decision", "at")}
            for r in stored] == rows


@pytest.mark.parametrize("case", _fixture()["invalid"], ids=lambda case: case["name"])
async def test_every_invalid_fixture_row_is_refused(audit: PluginAuditLog, case: dict[str, Any]) -> None:
    good = _fixture()["valid"][0]
    answer = await _send(_session(host=True), {"rows": [{**good, **case["patch"]}]})
    assert answer["payload"] == {"ok": True, "accepted": 0}
    assert _stored(audit) == []


@pytest.mark.parametrize(
    "patch",
    [
        {"usage": True}, {"threshold": float("inf")}, {"usage": float("nan")}, {"usage": "1"},
        {"at": 2**53}, {"at": True}, {"plugin_version": 1}, {"path": "/Users/me/.ssh"},
        {"command": "rm -rf"},
    ],
)
async def test_strict_validation_refuses_other_shapes_and_extra_fields(audit: PluginAuditLog, patch: dict[str, Any]) -> None:
    good = _fixture()["valid"][0]
    answer = await _send(_session(host=True), {"rows": [{**good, **patch}]})
    assert answer["payload"]["accepted"] == 0
    assert _stored(audit) == []


async def test_a_missing_field_is_refused(audit: PluginAuditLog) -> None:
    row = dict(_fixture()["valid"][0])
    del row["threshold"]
    assert (await _send(_session(host=True), {"rows": [row]}))["payload"]["accepted"] == 0


async def test_only_the_host_can_record(audit: PluginAuditLog) -> None:
    answer = await _send(_session(host=False), {"rows": [_fixture()["valid"][0]]})
    assert answer["error"]["code"] == "UNAUTHORIZED"
    assert _stored(audit) == []


@pytest.mark.parametrize("payload", [{}, {"rows": "x"}, {"rows": [], "more": 1}, []])
async def test_a_malformed_batch_is_refused(audit: PluginAuditLog, payload: Any) -> None:
    assert (await _send(_session(host=True), payload))["error"]["code"] == "BAD_REQUEST"


async def test_a_future_time_is_clamped_to_now(audit: PluginAuditLog) -> None:
    now = int(time.time() * 1000)
    await _send(_session(host=True), {"rows": [{**_fixture()["valid"][0], "at": now + DAY_MS}]})
    after = int(time.time() * 1000)
    assert now <= _stored(audit)[0]["at"] <= after


async def test_skipped_rows_are_logged_by_count_without_their_content(
    audit: PluginAuditLog, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    good = _fixture()["valid"][0]
    with caplog.at_level(logging.WARNING):
        await _send(_session(host=True), {"rows": [good, {**good, "path": "/Users/me/.ssh/id_rsa"}, "x"]})
    assert [r.getMessage() for r in caplog.records if "resource decision" in r.getMessage()] == [
        "plugin resource decision: 2 of 3 rows skipped"
    ]
    assert "id_rsa" not in caplog.text


def test_rows_are_kept_90_days_and_a_removed_plugin_is_forgotten(tmp_path: Path) -> None:
    now = 1_792_108_800_000
    audit = PluginAuditLog(Database(tmp_path / "navide.db"), clock=lambda: now / 1000)
    good = _fixture()["valid"][0]
    for at, plugin in ((now - 100 * DAY_MS, "a.old"), (now - 80 * DAY_MS, "a.kept"), (now - DAY_MS, "a.kept"),
                       (now - DAY_MS, "b.other")):
        assert audit.record_resource_decision(**{**good, "plugin_id": plugin, "at": at})
    audit.prune(now)
    assert [r["plugin_id"] for r in _stored(audit)] == ["a.kept", "a.kept", "b.other"]
    audit.forget_plugin("a.kept")
    assert [r["plugin_id"] for r in _stored(audit)] == ["b.other"]


def test_recording_only_queues_and_flush_writes_them(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    audit = PluginAuditLog(Database(tmp_path / "navide.db"))
    opened: list[int] = []
    real = audit.db.transaction

    def counting() -> Any:
        opened.append(1)
        return real()

    monkeypatch.setattr(audit.db, "transaction", counting)
    for _ in range(50):
        assert audit.record_resource_decision(**_fixture()["valid"][0])
    assert opened == [] and audit.status()["pending"] == 50
    audit.flush()
    assert opened == [1] and audit.status()["pending"] == 0


def test_a_failing_decision_write_never_drops_the_activity_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audit = PluginAuditLog(Database(tmp_path / "navide.db"))
    real = audit.db.transaction

    class _RefuseDecisions:
        def __init__(self, cur: Any) -> None:
            self._cur = cur

        def executemany(self, sql: str, rows: Any) -> Any:
            if "plugin_resource_decisions" in sql:
                raise sqlite3.OperationalError("disk I/O error")
            return self._cur.executemany(sql, rows)

    class _Transaction:
        def __enter__(self) -> Any:
            self._inner = real()
            return _RefuseDecisions(self._inner.__enter__())

        def __exit__(self, *exc: Any) -> Any:
            return self._inner.__exit__(*exc)

    monkeypatch.setattr(audit.db, "transaction", _Transaction)
    assert audit.record_resource_decision(**_fixture()["valid"][0])
    assert audit.record_activity(
        plugin_id="nerdtechnic.devmap", plugin_version="0.2.0", source="broker", address="fs.readFile", outcome="allowed",
    )
    audit.flush()
    monkeypatch.setattr(audit.db, "transaction", real)
    with audit.db.transaction() as cur:
        assert cur.execute("SELECT COUNT(*) FROM plugin_resource_decisions").fetchone()[0] == 0
        assert [tuple(r) for r in cur.execute("SELECT plugin_id, address FROM plugin_activity_counts")] == [
            ("nerdtechnic.devmap", "fs.readFile")
        ]
    assert audit.status()["pending"] == 0


def test_an_old_database_gains_the_table_and_keeps_its_rows(tmp_path: Path) -> None:
    path = tmp_path / "navide.db"
    old = PluginAuditLog(Database(path))
    assert old.record_activity(plugin_id="a.b", plugin_version="1", source="broker", address="fs.read", outcome="allowed")
    old.flush()
    with old.db.transaction() as cur:
        cur.execute("DROP TABLE plugin_resource_decisions")  # as a database from before this table
    old.db.close()
    again = PluginAuditLog(Database(path))
    with again.db.transaction() as cur:
        cols = [r[1] for r in cur.execute("PRAGMA table_info(plugin_resource_decisions)")]
        kept = cur.execute("SELECT SUM(count) FROM plugin_activity_counts").fetchone()[0]
    assert cols == ["id", "at", "plugin_id", "plugin_version", "item", "usage", "threshold", "decision"]
    assert kept == 1


def test_a_disabled_audit_records_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = Database(tmp_path / "navide.db")
    monkeypatch.setattr(db, "migrate", lambda *_a, **_k: (_ for _ in ()).throw(sqlite3.OperationalError("full")))
    assert PluginAuditLog(db).record_resource_decision(**_fixture()["valid"][0]) is False
