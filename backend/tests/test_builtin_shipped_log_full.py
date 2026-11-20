"""The full Shipped Log (0.2.46): schema v2, the production-setting register,
detected deploy commands and the user's overrides in the report."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend.db import Database, WorkspaceDatabases
from agent_team_backend.plugins.builtin.navide_shipped_log import ledger as ledger_mod
from agent_team_backend.plugins.builtin.navide_shipped_log import report as ship_report
from agent_team_backend.plugins.builtin.navide_shipped_log.ledger import LedgerError, ShipLogLedger

T0 = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)
AT = int(T0.timestamp())


def _fake_github_token() -> str:
    # Built at run time so no token-shaped literal is ever in the repository.
    return "gh" + "p_" + "Zx9" * 12


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    path = tmp_path / "ws"
    path.mkdir()
    return path


@pytest.fixture
def book() -> ShipLogLedger:
    return ShipLogLedger(WorkspaceDatabases())


# ── schema ──────────────────────────────────────────────────────────────────


def test_a_v1_ledger_is_upgraded_and_keeps_its_rows(workspace: Path) -> None:
    db = WorkspaceDatabases().get(str(workspace))
    db.migrate("ship_log", 1, ledger_mod._create_schema_v1)
    with db.transaction() as cur:
        cur.execute(ledger_mod._INSERT, ("k1", AT, AT, "old row", "other", "", 0, "p"))
    book = ShipLogLedger(WorkspaceDatabases())
    assert [e["summary"] for e in book.entries(str(workspace), 0)["entries"]] == ["old row"]
    assert book.register_config(str(workspace), key="mail.sender", location="SSM /app/prod/mail_from")["ok"]
    assert db.schema_version("ship_log") == 2


def test_a_failed_v2_step_disables_the_ledger(book: ShipLogLedger, workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    original = Database.migrate

    def broken(self: Database, component: str, version: int, apply: Any) -> bool:
        if component == "ship_log" and version == 2:
            raise sqlite3.OperationalError("disk I/O error")
        return original(self, component, version, apply)

    monkeypatch.setattr(Database, "migrate", broken)
    assert book.record(str(workspace), summary="x", source_kind="other")["disabled"].startswith("OperationalError")
    with pytest.raises(LedgerError, match="disabled"):
        book.register_config(str(workspace), key="a", location="b")
    assert book.configs(str(workspace))["disabled"].startswith("OperationalError")


# ── the production-setting register ─────────────────────────────────────────


def test_register_update_and_remove(book: ShipLogLedger, workspace: Path) -> None:
    ws = str(workspace)
    first = book.register_config(ws, key="mail.sender", label="Sender address", location="SSM /app/prod/mail_from")
    assert first == {"ok": True, "key": "mail.sender", "created": True, "updated": False}
    again = book.register_config(ws, key="mail.sender", label="Sender", location="ECS task def api-prod, env",
                                 environment="staging")
    assert again["updated"] is True
    [row] = book.configs(ws)["configs"]
    assert (row["label"], row["location"], row["environment"]) == ("Sender", "ECS task def api-prod, env", "staging")
    assert book.register_config(ws, key="mail.sender", remove=True)["removed"] is True
    assert book.configs(ws)["configs"] == []
    assert book.configs(ws, include_removed=True)["configs"][0]["removed_at"] is not None
    # Registering it again brings it back.
    book.register_config(ws, key="mail.sender", location="SSM /app/prod/mail_from")
    assert [c["key"] for c in book.configs(ws)["configs"]] == ["mail.sender"]


@pytest.mark.parametrize("field, value", [
    ("location", lambda: "env MAIL_FROM=" + "ops" + "@example.com"),
    ("note", lambda: "token " + _fake_github_token()),
    ("location", lambda: "postgres://app:" + "s3cr" + "et@db.internal/app"),
    ("label", lambda: "password=" + "hunter" + "2Secret9"),
])
def test_a_value_is_refused_and_nothing_is_written(book: ShipLogLedger, workspace: Path, field: str, value: Any) -> None:
    kwargs = {"key": "x", "location": "SSM /x", field: value()}
    with pytest.raises(LedgerError, match="value") as err:
        book.register_config(str(workspace), **kwargs)
    assert value() not in str(err.value)
    assert book.configs(str(workspace))["configs"] == []


def test_a_console_url_with_query_parameters_is_a_location(book: ShipLogLedger, workspace: Path) -> None:
    url = "https://console.aws.amazon.com/systems-manager/parameters/?region=ap-northeast-1&tab=Table"
    assert book.register_config(str(workspace), key="mail.sender", location=url)["ok"] is True


@pytest.mark.parametrize("kwargs, message", [
    ({"key": "two words", "location": "x"}, "one token"),
    ({"key": "k", "location": ""}, "location is required"),
    ({"key": "k", "location": "x" * 301}, "longer"),
])
def test_invalid_registrations_are_refused(book: ShipLogLedger, workspace: Path, kwargs: dict, message: str) -> None:
    with pytest.raises(LedgerError, match=message):
        book.register_config(str(workspace), **kwargs)


# ── the report: config labels, detections, overrides ────────────────────────


async def test_a_registered_config_entry_carries_its_label(book: ShipLogLedger, workspace: Path) -> None:
    ws = str(workspace)
    book.register_config(ws, key="mail.sender", label="Sender address", location="SSM /app/prod/mail_from")
    book.record(ws, summary="Sender moved to the new domain", source_kind="config", ref="mail.sender", at=AT + 1)
    built = await ship_report.build_report(ws, T0, ledger=book)
    assert built["items"][0]["config_label"] == "Sender address"
    local = ship_report.render_text(built, "en-US", for_chat=False, now=T0)
    assert "Sender address · agent" in local and "mail.sender" not in local


async def test_detections_are_hints_counted_apart(book: ShipLogLedger, workspace: Path) -> None:
    ws = str(workspace)
    book.record_detection(ws, at=AT + 10, pane="api", vendor="claude", rule="npm-publish",
                          excerpt="npm publish --access public", ok=True)
    book.record_detection(ws, at=AT + 20, pane="api", vendor="claude", rule="deploy-script",
                          excerpt="./deploy.sh prod", ok=False)  # failed: left out
    dismissed = book.record_detection(ws, at=AT + 30, pane="api", vendor="claude", rule="docker-push",
                                      excerpt="docker push x", ok=True)
    book.set_detection_status(ws, dismissed, "dismissed")
    book.record(ws, summary="Migration 42 applied", source_kind="migration", at=AT + 40, pane="db")

    built = await ship_report.build_report(ws, T0, ledger=book)
    assert built["count"] == 1 and built["pending_detections"] == 1
    detected = [i for i in built["items"] if i["kind"] == "detected"]
    assert [(i["bases"], i["rule"]) for i in detected] == [(["hook"], "npm-publish")]

    chat = ship_report.render_text(built, "zh-TW", for_chat=True, now=T0)
    local = ship_report.render_text(built, "zh-TW", for_chat=False, now=T0)
    assert "npm publish" not in chat and "1 筆偵測到的部署指令待確認" in chat
    assert "偵測到部署指令（待確認）：npm-publish npm publish --access public" in local


async def test_a_recording_from_the_same_pane_confirms_a_detection(book: ShipLogLedger, workspace: Path) -> None:
    ws = str(workspace)
    book.record_detection(ws, at=AT + 10, pane="api", vendor="claude", rule="npm-publish", excerpt="npm publish", ok=True)
    book.record(ws, summary="Published 2.0", source_kind="other", at=AT + 600, pane="api")
    built = await ship_report.build_report(ws, T0, ledger=book)
    assert built["pending_detections"] == 0 and [i["summary"] for i in built["items"]] == ["Published 2.0"]


async def test_overrides_replace_the_line_and_the_mark(book: ShipLogLedger, workspace: Path) -> None:
    ws = str(workspace)
    book.record(ws, summary="Rate limit raised", source_kind="config", at=AT + 1)
    [item] = (await ship_report.build_report(ws, T0, ledger=book))["items"]
    assert item["sensitive"] is True
    book.set_override(ws, item["key"], summary="Checkout handles more traffic", sensitive=False)
    [item] = (await ship_report.build_report(ws, T0, ledger=book))["items"]
    assert (item["summary"], item["sensitive"], item["edited"]) == ("Checkout handles more traffic", False, True)
    # The ledger row itself is untouched; clearing the override restores it.
    assert book.entries(ws, 0)["entries"][0]["summary"] == "Rate limit raised"
    book.set_override(ws, item["key"])
    [item] = (await ship_report.build_report(ws, T0, ledger=book))["items"]
    assert (item["summary"], item["sensitive"]) == ("Rate limit raised", True)
    with pytest.raises(LedgerError, match="secret"):
        book.set_override(ws, item["key"], summary="key " + _fake_github_token())


def test_settings_round_trip_and_refuse_unknown_keys(book: ShipLogLedger, workspace: Path) -> None:
    ws = str(workspace)
    assert book.settings(ws) == ledger_mod.DEFAULT_SETTINGS
    assert not (workspace / ".agent-team" / "navide.db").exists()  # reading creates nothing
    assert book.put_settings(ws, {"digest_enabled": True, "digest_at": "18:30"})["digest_at"] == "18:30"
    with pytest.raises(LedgerError, match="unknown"):
        book.put_settings(ws, {"value": 1})


# ── the config tools ────────────────────────────────────────────────────────


@pytest.fixture
def tools(monkeypatch: pytest.MonkeyPatch, book: ShipLogLedger, workspace: Path) -> Any:
    from agent_team_backend.plugins.builtin.navide_shipped_log import ship_log_tools

    async def own_workspace(caller: Any, given: str) -> str:
        return given or str(workspace)

    monkeypatch.setattr(ship_log_tools, "resolve_caller", lambda ctx: None)
    monkeypatch.setattr(ship_log_tools, "caller_workspace", own_workspace)
    monkeypatch.setattr(ship_log_tools, "_pane_label", lambda caller: "ops")
    monkeypatch.setattr(ship_log_tools, "ledger", book)
    monkeypatch.setattr(ship_report, "_default_ledger", book)
    return ship_log_tools


async def test_config_tools(tools: Any) -> None:
    made = await tools.ship_log_config_register("mail.sender", None, location="SSM /app/prod/mail_from",
                                                label="Sender address")
    assert made["ok"] is True and made["created"] is True
    listed = await tools.ship_log_config_list(None)
    assert [c["key"] for c in listed["configs"]] == ["mail.sender"]
    refused = await tools.ship_log_config_register("mail.sender", None, location="MAIL_FROM=" + "a" + "@b.example")
    assert refused["ok"] is False and "value" in refused["error"]

    known = await tools.ship_log_record("Sender moved", "config", None, ref="mail.sender")
    assert known["ok"] is True and "warning" not in known
    unknown = await tools.ship_log_record("Flag flipped", "config", None, ref="feature.x")
    assert unknown["ok"] is True and "not a registered" in unknown["warning"]
    removed = await tools.ship_log_config_register("mail.sender", None, remove=True)
    assert removed == {"ok": True, "key": "mail.sender", "removed": True}
