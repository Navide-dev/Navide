"""Per-call cost ledger: schema, dedup, transcript cwd, pricing, backfill, sink wiring."""

from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path

import pytest

from agent_team_backend import app, cost_ledger
from agent_team_backend.cli_vendors.claude import ClaudeLogReader
from agent_team_backend.cost_ledger import CostLedger, backfill, call_cost_usd, load_pricing
from agent_team_backend.db import Database
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import TokenUsage, encode_claude_cwd
from agent_team_backend.tokens_store import TokensStore


def _assistant(msg_id: str, req_id: str, cwd: str, *, model: str = "claude-opus-5-5") -> str:
    return json.dumps({
        "type": "assistant", "cwd": cwd, "requestId": req_id,
        "timestamp": "2026-11-05T02:00:00Z", "version": "2.1.318",
        "message": {"id": msg_id, "model": model, "usage": {
            "input_tokens": 2, "cache_read_input_tokens": 1000,
            "cache_creation_input_tokens": 300, "output_tokens": 50,
            "cache_creation": {"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 200},
        }},
    }) + "\n"


def _projects(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    config = tmp_path / "claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(config))
    return config / "projects"


def _rows(db: Database) -> list[dict]:
    with db.transaction() as cur:
        return [dict(r) for r in cur.execute("SELECT * FROM usage_calls ORDER BY dedup_key")]


def test_schema_goes_through_migrate_with_indexes(tmp_path: Path) -> None:
    db = Database(tmp_path / "navide.db")
    CostLedger(db)
    CostLedger(db)  # second open is a no-op step
    assert db.schema_version("cost_ledger") == 1
    with db.transaction() as cur:
        names = {r["name"] for r in cur.execute("SELECT name FROM sqlite_master")}
    assert {"usage_calls", "usage_daily", "usage_calls_ts", "usage_calls_cwd_ts",
            "usage_calls_session"} <= names


def test_claude_call_splits_tokens_and_uses_transcript_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Two same-length Chinese folder names share one Claude project dir; the
    # row must carry the transcript's real cwd, not the dashed dir name.
    projects = _projects(tmp_path, monkeypatch)
    real_cwd = "/Users/me/Desktop/AI建模"
    session = projects / encode_claude_cwd(real_cwd) / "s1.jsonl"
    session.parent.mkdir(parents=True)
    session.write_text(_assistant("m1", "r1", real_cwd) + _assistant("m1", "r1", real_cwd))

    db = Database(tmp_path / "navide.db")
    ledger = CostLedger(db)
    events = ClaudeLogReader().parse_incremental(session, {}).events
    for ev in events:
        ledger.record(ev, "/ws", "slot-1")
    assert ledger.record(events[0], "/ws", "slot-1") is False  # replay is ignored

    [row] = _rows(db)
    assert row["dedup_key"] == "m1::r1"
    assert row["cwd"] == real_cwd
    assert row["session_id"] == "s1"
    assert (row["input"], row["cache_read"], row["cache_write_5m"],
            row["cache_write_1h"], row["output"]) == (2, 1000, 100, 200, 50)
    assert (row["workspace"], row["pane"], row["model"]) == ("/ws", "slot-1", "claude-opus-5-5")


def test_event_without_dedup_key_is_skipped_and_logged_once(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    ledger = CostLedger(Database(tmp_path / "navide.db"))
    ev = TokenUsage(vendor="aider", input_tokens=5, output_tokens=1, cwd="/w",
                    session_id="s", file_path="/w/log", dedup_key="")
    with caplog.at_level("WARNING", logger="agent_team_backend.cost_ledger"):
        assert ledger.record(ev) is False
        assert ledger.record(ev) is False
    assert sum("no dedup_key" in r.message for r in caplog.records) == 1


def test_pricing_has_version_and_unknown_model_is_null() -> None:
    pricing = load_pricing()
    assert pricing["version"] >= 1 and pricing["effective"]
    bucket = {"model": "claude-opus-5-5", "input": 1_000_000, "cache_read": 1_000_000,
              "cache_write_5m": 1_000_000, "cache_write_1h": 1_000_000, "output": 1_000_000}
    assert call_cost_usd(bucket, pricing) == pytest.approx(4 + 0.2 + 5 + 8 + 20)
    assert call_cost_usd({**bucket, "model": "some-unpriced-model"}, pricing) is None


def test_backfill_writes_only_the_ledger(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    projects = _projects(tmp_path, monkeypatch)
    cwd = "/Users/me/proj"
    session = projects / encode_claude_cwd(cwd) / "s2.jsonl"
    session.parent.mkdir(parents=True)
    session.write_text(_assistant("a", "1", cwd) + _assistant("b", "2", cwd))

    db = Database(tmp_path / "navide.db")
    ledger = CostLedger(db)
    assert backfill(ledger, [ClaudeLogReader()]) == (2, 0)
    assert backfill(ledger, [ClaudeLogReader()]) == (0, 2)  # rerun is idempotent
    with db.transaction() as cur:
        assert cur.execute("SELECT calls FROM usage_daily").fetchone()["calls"] == 2
        assert cur.execute(
            "SELECT name FROM sqlite_master WHERE name = 'ingestion_checkpoints'"
        ).fetchone() is None


@pytest.mark.asyncio
async def test_sink_records_ledger_and_survives_ledger_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    projects = _projects(tmp_path, monkeypatch)
    workspace_path = tmp_path / "workspace"
    workspace_path.mkdir()
    workspace = str(workspace_path)
    session = projects / encode_claude_cwd(workspace) / "s3.jsonl"
    session.parent.mkdir(parents=True)
    session.write_text(_assistant("m9", "r9", workspace))

    attribution = Attribution([ClaudeLogReader()], workspaces_path=tmp_path / "known.json")
    attribution.register_workspace(workspace)
    store = TokensStore(
        global_path=tmp_path / "tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
        ingestion_state_path=tmp_path / "token-ingestion-state.json",
    )
    db = Database(tmp_path / "ledger.db")
    monkeypatch.setattr(app, "attribution", attribution)
    monkeypatch.setattr(app, "tokens_store", store)
    monkeypatch.setattr(app, "cost_ledger", CostLedger(db))
    monkeypatch.setattr(app, "track_live_session", lambda **_kwargs: None)
    monkeypatch.setattr(app, "_schedule_tokens_broadcast", lambda _ws: None)

    [ev] = ClaudeLogReader().parse_incremental(session, {}).events
    result = await app._on_log_token_usage(ev)
    assert result.handled is True
    assert [r["dedup_key"] for r in _rows(db)] == ["m9::r9"]

    @contextmanager
    def broken():
        raise RuntimeError("disk full")
        yield  # pragma: no cover

    monkeypatch.setattr(db, "transaction", broken)
    session.write_text(_assistant("m9", "r9", workspace) + _assistant("m10", "r10", workspace))
    [ev2] = [e for e in ClaudeLogReader().parse_incremental(session, {}).events
             if e.dedup_key == "m10::r10"]
    result = await app._on_log_token_usage(ev2)
    assert result.handled is True
    totals = store.snapshot(workspace)["workspace"]["cumulative"]["totals"]
    assert totals["calls"] == 2


def test_cwd_is_nfc(monkeypatch: pytest.MonkeyPatch) -> None:
    nfd = "/Users/me/café"
    ev = TokenUsage(vendor="codex", input_tokens=1, output_tokens=1, cwd=nfd,
                    session_id="s", file_path="/x.jsonl", dedup_key="k")
    assert cost_ledger.transcript_cwd(ev) == "/Users/me/café"
