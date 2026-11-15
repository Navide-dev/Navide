"""The builtin navide.shipped-log plugin: ledger, report merge and its tools."""
from __future__ import annotations

import os
import sqlite3
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import osplat
from agent_team_backend.db import Database, WorkspaceDatabases
from agent_team_backend.plugins.builtin.navide_shipped_log import report as ship_report
from agent_team_backend.plugins.builtin.navide_shipped_log.ledger import LedgerError, ShipLogLedger

T0 = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)
needs_git = pytest.mark.skipif(osplat.paths.resolve_program("git") is None, reason="git is not resolvable")


def _fake_npm_token() -> str:
    # Built at run time so no token-shaped literal is ever in the repository.
    return "np" + "m_" + "Ab3" * 12


def _git(repo: Path, *args: str, at: datetime | None = None) -> str:
    env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1"}
    if at is not None:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = f"{int(at.timestamp())} +0000"
    return subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True, text=True).stdout.strip()


def _commit(repo: Path, name: str, message: str, at: datetime) -> str:
    (repo / name).write_text(name, encoding="utf-8")
    _git(repo, "add", name)
    _git(repo, "commit", "-q", "-m", message, at=at)
    return _git(repo, "rev-parse", "HEAD")


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    path = tmp_path / "ws"
    path.mkdir()
    return path


@pytest.fixture
def book() -> ShipLogLedger:
    return ShipLogLedger(WorkspaceDatabases())


@pytest.fixture
def repo(workspace: Path) -> Path:
    _git(workspace, "init", "-q", "-b", "main")
    _git(workspace, "config", "user.email", "t@example.invalid")
    _git(workspace, "config", "user.name", "T")
    _git(workspace, "config", "commit.gpgsign", "false")
    return workspace


# ── ledger ───────────────────────────────────────────────────────────────────


def test_record_is_insert_only_and_deduplicated(book: ShipLogLedger, workspace: Path) -> None:
    at = int(T0.timestamp())
    first = book.record(str(workspace), summary="Sender  address moved", source_kind="config", at=at)
    again = book.record(str(workspace), summary="Sender address moved", source_kind="config", at=at)
    assert first["recorded"] is True and first["sensitive"] is True  # config defaults to sensitive
    assert again == {**first, "recorded": False, "duplicate": True}
    book.record(str(workspace), summary="feat landed", source_kind="commit", ref="ABCDEF1", at=at)
    book.record(str(workspace), summary="told twice", source_kind="commit", ref="abcdef1", at=at + 9)
    rows = book.entries(str(workspace), at)["entries"]
    assert [(r["summary"], r["sensitive"]) for r in rows] == [("Sender address moved", True), ("feat landed", False)]


def test_entries_are_windowed_and_ordered(book: ShipLogLedger, workspace: Path) -> None:
    at = int(T0.timestamp())
    for offset, text in ((50, "late"), (-10, "before"), (5, "early")):
        book.record(str(workspace), summary=text, source_kind="other", at=at + offset)
    assert [r["summary"] for r in book.entries(str(workspace), at, at + 50)["entries"]] == ["early"]


@pytest.mark.parametrize("summary, ref", [
    (lambda: f"rotated the token {_fake_npm_token()}", lambda: ""),
    (lambda: "set password=" + "hunter" + "2Secret9", lambda: ""),
    (lambda: "published", _fake_npm_token),
])
def test_a_secret_is_refused_and_nothing_is_written(book: ShipLogLedger, workspace: Path, summary: Any, ref: Any) -> None:
    with pytest.raises(LedgerError, match="secret"):
        book.record(str(workspace), summary=summary(), source_kind="config", ref=ref())
    assert book.entries(str(workspace), 0)["entries"] == []


@pytest.mark.parametrize("kwargs, message", [
    ({"summary": " ", "source_kind": "other"}, "summary is required"),
    ({"summary": "x", "source_kind": "deploy"}, "source_kind"),
    ({"summary": "x", "source_kind": "other", "ref": "a b"}, "ref"),
    ({"summary": "x" * 501, "source_kind": "other"}, "longer"),
])
def test_invalid_entries_are_refused(book: ShipLogLedger, workspace: Path, kwargs: dict, message: str) -> None:
    with pytest.raises(LedgerError, match=message):
        book.record(str(workspace), **kwargs)


def test_reading_never_creates_the_workspace_database(book: ShipLogLedger, workspace: Path) -> None:
    assert book.entries(str(workspace), 0) == {"ok": True, "entries": []}
    assert not (workspace / ".agent-team" / "navide.db").exists()


def test_a_failed_migration_disables_only_the_ledger(
    book: ShipLogLedger, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(self: Database, component: str, version: int, apply: Any) -> bool:
        if component == "ship_log":
            raise sqlite3.OperationalError("disk I/O error")
        return original(self, component, version, apply)

    original = Database.migrate
    monkeypatch.setattr(Database, "migrate", broken)
    result = book.record(str(workspace), summary="x", source_kind="other")
    assert result == {"ok": False, "disabled": "OperationalError: disk I/O error"}
    assert book.entries(str(workspace), 0)["disabled"].startswith("OperationalError")
    # The workspace database itself still works for everything else.
    db = WorkspaceDatabases().get(str(workspace))
    db.kv_set("other", {"v": 1}, now=0)
    assert db.kv_get("other") == {"v": 1}


# ── windows and plain-language lines ────────────────────────────────────────


def test_window_words() -> None:
    now = datetime(2026, 11, 16, 10, 30, tzinfo=timezone(timedelta(hours=8)))
    today = now.replace(hour=0, minute=0)
    assert ship_report.parse_window("今天", now=now) == (today, None)
    assert ship_report.parse_window("yesterday", now=now) == (today - timedelta(days=1), today)
    assert ship_report.parse_window("7d", now=now)[0] == now - timedelta(days=7)
    assert ship_report.parse_window("12h", now=now)[0] == now - timedelta(hours=12)
    assert ship_report.parse_window("2026-11-15T09:00+08:00", "2026-11-15T18:00+08:00", now=now) == (
        datetime(2026, 11, 15, 9, tzinfo=timezone(timedelta(hours=8))),
        datetime(2026, 11, 15, 18, tzinfo=timezone(timedelta(hours=8))),
    )
    for bad in ("last week", "", "2026-13-01"):
        with pytest.raises(ship_report.WindowError):
            ship_report.parse_window(bad, now=now)
    with pytest.raises(ship_report.WindowError, match="later"):
        ship_report.parse_window("2026-11-15", "2026-11-14", now=now)


@pytest.mark.parametrize("subject, body, expected", [
    ("feat(git): first-parent log", "", ("added", "first-parent log")),
    ("fix: the reply was lost", "", ("fixed", "the reply was lost")),
    ("chore!: drop python 3.10", "", ("changed", "drop python 3.10")),
    ("Bump the docs", "", ("changed", "Bump the docs")),
    ("Merge pull request #890 from Navide-dev/fix/x", "fix(guard): name the worst first\n\nmore", ("fixed", "name the worst first")),
])
def test_plain_lines(subject: str, body: str, expected: tuple[str, str]) -> None:
    assert ship_report.plain(subject, body) == expected


# ── the merged report ───────────────────────────────────────────────────────


@needs_git
async def test_report_merges_three_commits_and_one_config_without_duplicates(book: ShipLogLedger, repo: Path) -> None:
    _commit(repo, "0", "chore: before", T0 - timedelta(days=1))
    a = _commit(repo, "a", "feat: invoices export", T0 + timedelta(hours=1))
    _commit(repo, "b", "fix: login loop", T0 + timedelta(hours=2))
    c = _commit(repo, "c", "docs: readme", T0 + timedelta(hours=3))
    _git(repo, "tag", "-a", "v1.0", "-m", "release", c, at=T0 + timedelta(hours=4))
    book.record(str(repo), summary="Invoices can be exported as CSV", source_kind="commit", ref=a[:8],
                at=int((T0 + timedelta(hours=5)).timestamp()))
    book.record(str(repo), summary="Sender address moved to the new domain", source_kind="config",
                at=int((T0 + timedelta(hours=6)).timestamp()))

    built = await ship_report.build_report(str(repo), T0, ledger=book)

    assert built["branch"] == "main" and built["count"] == 4 and built["warnings"] == []
    items = built["items"]
    assert [i["at"] for i in items] == sorted(i["at"] for i in items)
    assert [i["summary"] for i in items] == [
        "Invoices can be exported as CSV", "login loop", "readme", "Sender address moved to the new domain"]
    assert [i["bases"] for i in items] == [["agent", "branch"], ["branch"], ["branch", "tag"], ["agent"]]
    assert items[0]["at"] == int((T0 + timedelta(hours=1)).timestamp())  # the git time stays
    assert items[2]["tags"] == ["v1.0"]
    assert items[3]["sensitive"] is True


@needs_git
async def test_report_text_folds_sensitive_items_for_the_chat_only(book: ShipLogLedger, repo: Path) -> None:
    _commit(repo, "a", "feat: invoices export", T0 + timedelta(hours=1))
    book.record(str(repo), summary="SMTP relay switched", source_kind="config", ref="ops-42",
                at=int((T0 + timedelta(hours=2)).timestamp()))
    built = await ship_report.build_report(str(repo), T0, ledger=book)

    chat = ship_report.render_text(built, "zh-TW", for_chat=True, now=T0)
    local = ship_report.render_text(built, "zh-TW", for_chat=False, now=T0)

    assert "新增 invoices export" in chat
    assert "SMTP relay switched" not in chat and "ops-42" not in chat
    assert "正式機設定變更 1 筆" in chat
    assert "SMTP relay switched" in local and "ops-42" not in local


@needs_git
async def test_report_warns_about_a_named_branch_with_nothing(book: ShipLogLedger, repo: Path) -> None:
    _commit(repo, "a", "feat: x", T0 + timedelta(hours=1))
    built = await ship_report.build_report(str(repo), T0, branch="production", ledger=book)
    assert built["count"] == 0 and "production" in built["warnings"][0]


async def test_report_of_a_folder_without_git_still_lists_the_ledger(book: ShipLogLedger, workspace: Path) -> None:
    book.record(str(workspace), summary="DB column added", source_kind="migration", at=int(T0.timestamp()) + 1)
    built = await ship_report.build_report(str(workspace), T0, ledger=book)
    assert [i["summary"] for i in built["items"]] == ["DB column added"]
    assert "no deploy branch" in built["warnings"][0]


# ── the plugin and its MCP tools ────────────────────────────────────────────


def test_the_plugin_is_a_discovered_builtin() -> None:
    from agent_team_backend.plugins import wiring

    dirs = wiring.discover_backend_plugin_dirs(wiring.builtin_plugins_root())
    assert wiring.builtin_plugins_root() / "navide_shipped_log" in dirs


@pytest.fixture
def tools(monkeypatch: pytest.MonkeyPatch, book: ShipLogLedger, workspace: Path) -> Any:
    from agent_team_backend.plugins.builtin.navide_shipped_log import ship_log_tools

    async def own_workspace(caller: Any, given: str) -> str:
        return given or str(workspace)

    monkeypatch.setattr(ship_log_tools, "resolve_caller", lambda ctx: None)
    monkeypatch.setattr(ship_log_tools, "caller_workspace", own_workspace)
    monkeypatch.setattr(ship_log_tools, "_pane_label", lambda caller: "release")
    monkeypatch.setattr(ship_log_tools, "ledger", book)
    monkeypatch.setattr(ship_report, "_default_ledger", book)
    return ship_log_tools


async def test_record_and_report_through_the_tools(tools: Any, workspace: Path, book: ShipLogLedger) -> None:
    ok = await tools.ship_log_record("Sender address moved", "config", None, ref="ops-7",
                                     at="2026-11-10T13:00:00+00:00")
    assert ok["ok"] is True and ok["recorded"] is True and ok["sensitive"] is True
    assert book.entries(str(workspace), 0)["entries"][0]["pane"] == "release"

    refused = await tools.ship_log_record(f"key {_fake_npm_token()}", "config", None)
    assert refused["ok"] is False and "secret" in refused["error"] and _fake_npm_token() not in refused["error"]
    assert (await tools.ship_log_record("x", "other", None, at="yesterday"))["ok"] is False

    as_json = await tools.ship_log_report("2026-11-10", None, format="json")
    assert as_json["ok"] is True and as_json["count"] == 1
    assert "ref" not in as_json["items"][0] and as_json["items"][0]["summary"] == "Sender address moved"
    as_text = await tools.ship_log_report("2026-11-10", None)
    assert "Sender address moved" in as_text["text"] and "ops-7" not in as_text["text"]

    assert (await tools.ship_log_report("2026-11-10", None, format="pdf"))["ok"] is False
    assert (await tools.ship_log_report("last week", None))["ok"] is False


async def test_the_tools_hide_while_the_plugin_is_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import app
    from agent_team_backend.mcp_server import server as core
    from agent_team_backend.plugins.builtin.navide_shipped_log import ship_log_tools

    if "ship_log_report" not in {t.name for t in await core.server.list_tools()}:
        ship_log_tools.install(core.server)
    monkeypatch.setattr(app, "host_disabled_plugins", lambda: frozenset({"navide.shipped-log"}))
    names = {t.name for t in await core.list_visible_tools()}
    assert "ship_log_record" not in names and "ship_log_report" not in names
    monkeypatch.setattr(app, "host_disabled_plugins", lambda: frozenset())
    assert {"ship_log_record", "ship_log_report"} <= {t.name for t in await core.list_visible_tools()}
