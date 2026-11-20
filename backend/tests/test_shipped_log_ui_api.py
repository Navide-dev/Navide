"""Shipped Log batch 4: the panel's ship_log.* requests."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import scheduler as sched_mod
from agent_team_backend import ws_handlers
from agent_team_backend.db import Database, WorkspaceDatabases
from agent_team_backend.plugins.builtin.navide_shipped_log import ui_api
from agent_team_backend.plugins.builtin.navide_shipped_log.ledger import ShipLogLedger
from agent_team_backend.scheduler import SchedulerService
from agent_team_backend.scheduler_store import SchedulerStore

NOW = datetime(2026, 11, 20, 9, 0, tzinfo=timezone.utc)


@pytest.fixture
def ws(tmp_path: Path) -> str:
    path = tmp_path / "proj"
    path.mkdir()
    return str(path.resolve())


@pytest.fixture
def book() -> ShipLogLedger:
    return ShipLogLedger(WorkspaceDatabases())


async def call(book: ShipLogLedger, msg_type: str, **payload: Any) -> dict[str, Any]:
    return await ui_api.handle(msg_type, payload, book=book)


def test_every_type_is_registered_with_the_websocket() -> None:
    for msg_type in ui_api.TYPES:
        assert ws_handlers.lookup(msg_type) is ws_handlers.ship_log_request


async def test_a_workspace_is_required(book: ShipLogLedger) -> None:
    assert (await call(book, "ship_log.report"))["ok"] is False


async def test_add_confirm_edit_and_report(book: ShipLogLedger, ws: str) -> None:
    at = int(NOW.timestamp())
    detected = book.record_detection(ws, at=at, pane="api", vendor="claude", rule="npm-publish",
                                     excerpt="npm publish", ok=True)
    noise = book.record_detection(ws, at=at, pane="api", vendor="claude", rule="docker-push",
                                  excerpt="docker push x", ok=True)
    added = await call(book, "ship_log.record", workspace=ws, summary="Published 2.0", source_kind="other",
                       at="2026-11-20T09:05:00+00:00", detection_id=detected)
    assert added["ok"] is True and added["recorded"] is True
    assert book.entries(ws, 0)["entries"][0]["pane"] == ui_api.USER_PANE
    assert (await call(book, "ship_log.detection", workspace=ws, id=noise, status="dismissed"))["ok"] is True
    assert (await call(book, "ship_log.detection", workspace=ws, id=999, status="dismissed"))["ok"] is False

    report = await call(book, "ship_log.report", workspace=ws, since="2026-11-20")
    assert report["ok"] is True and report["pending_detections"] == 0
    [item] = report["items"]
    edited = await call(book, "ship_log.override", workspace=ws, item_key=item["key"], summary="Version 2.0 is out",
                        sensitive=True)
    assert edited["ok"] is True
    [item] = (await call(book, "ship_log.report", workspace=ws, since="2026-11-20"))["items"]
    assert (item["summary"], item["sensitive"], "ref" in item) == ("Version 2.0 is out", True, False)
    assert (await call(book, "ship_log.report", workspace=ws, since="last week"))["ok"] is False


async def test_config_requests(book: ShipLogLedger, ws: str) -> None:
    made = await call(book, "ship_log.config_set", workspace=ws, key="mail.sender", location="SSM /app/prod/mail_from")
    assert made["ok"] is True
    refused = await call(book, "ship_log.config_set", workspace=ws, key="x", location="X=" + "y" + "z")
    assert refused["ok"] is False and "value" in refused["error"]
    assert [c["key"] for c in (await call(book, "ship_log.configs", workspace=ws))["configs"]] == ["mail.sender"]
    assert (await call(book, "ship_log.config_set", workspace=ws, key="mail.sender", remove=True))["removed"] is True


async def test_digest_requests(book: ShipLogLedger, ws: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = Database(tmp_path / "navide.db")

    async def quiet(event: dict, *, exclude: Any = None) -> None:
        pass

    monkeypatch.setattr(app_module, "broadcast", quiet)
    service = SchedulerService(SchedulerStore(db), clock=lambda: NOW.timestamp(), bridge=object())
    monkeypatch.setattr(sched_mod, "_service", service)
    try:
        got = await call(book, "ship_log.digest_get", workspace=ws)
        assert got["ok"] is True and got["settings"]["digest_enabled"] is False and got["next_run_at"] is None
        saved = await call(book, "ship_log.digest_set", workspace=ws, settings={"digest_enabled": True,
                                                                              "digest_at": "18:00"})
        assert saved["ok"] is True and saved["next_run_at"] is not None
        assert (await call(book, "ship_log.digest_set", workspace=ws, settings={"digest_at": "8pm"}))["ok"] is False
    finally:
        db.close()
