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
    assert db.schema_version("cost_ledger") == 3
    with db.transaction() as cur:
        names = {r["name"] for r in cur.execute("SELECT name FROM sqlite_master")}
    assert {"usage_calls", "usage_daily", "usage_calls_ts", "usage_calls_cwd_ts",
            "usage_calls_session", "pane_sessions", "pane_sessions_session",
            "usage_calls_profile_ts"} <= names


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
    monkeypatch.setattr(app.pane_account_history, "profile_at", lambda *_a: "acc" + "-7")
    result = await app._on_log_token_usage(ev)
    assert result.handled is True
    assert [(r["dedup_key"], r["profile_id"]) for r in _rows(db)] == [("m9::r9", "acc-7")]

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


def test_file_local_keys_do_not_collide_but_claude_keys_dedup_across_files(
    tmp_path: Path,
) -> None:
    db = Database(tmp_path / "navide.db")
    ledger = CostLedger(db)

    def ev(vendor: str, path: str, key: str) -> TokenUsage:
        return TokenUsage(vendor=vendor, input_tokens=3, output_tokens=1, cwd="/w",
                          session_id="s", file_path=path, dedup_key=key)

    # aider keys on a byte offset inside one log: two logs, two calls.
    assert ledger.record(ev("aider", "/a.md", "aider::s::@10")) is True
    assert ledger.record(ev("aider", "/b.md", "aider::s::@10")) is True
    # claude's message id is global: a resumed transcript re-carrying it is one call.
    assert ledger.record(ev("claude", "/old.jsonl", "m1::r1")) is True
    assert ledger.record(ev("claude", "/resumed.jsonl", "m1::r1")) is False
    assert len(_rows(db)) == 3


def _codex_rollout(path: Path, totals: list[tuple[int, int, int]]) -> None:
    lines = [
        {"type": "session_meta", "payload": {"id": "cx1", "cwd": "/Users/me/proj",
                                             "model_provider": "openai"}},
        {"type": "turn_context", "payload": {"model": "gpt-5.6-sol"}},
    ]
    for inp, cached, out in totals:
        lines.append({"type": "event_msg", "timestamp": "2026-11-05T02:00:00Z", "payload": {
            "type": "token_count", "info": {"total_token_usage": {
                "input_tokens": inp, "cached_input_tokens": cached,
                "cache_write_input_tokens": 0, "output_tokens": out,
                "reasoning_output_tokens": 0, "total_tokens": inp + out}}}})
    path.write_text("".join(json.dumps(x) + "\n" for x in lines))


def test_codex_session_totals_match_however_the_log_was_read(tmp_path: Path) -> None:
    from agent_team_backend.cli_vendors.codex import CodexLogReader

    rollout = tmp_path / "rollout-2026-11-05T02-00-00-cx1.jsonl"
    reader = CodexLogReader()
    db_live, db_full = Database(tmp_path / "live.db"), Database(tmp_path / "full.db")
    live, full = CostLedger(db_live), CostLedger(db_full)

    # Live: read after the first count, then again after the second.
    _codex_rollout(rollout, [(1000, 600, 50)])
    first = reader.parse_incremental(rollout, {})
    for ev in first.events:
        live.record(ev, "/ws", "pane-1")
    _codex_rollout(rollout, [(1000, 600, 50), (2500, 1800, 90)])
    for ev in reader.parse_incremental(rollout, first.checkpoint).events:
        live.record(ev, "", "")
    # Backfill: one read of the whole log; a second backfill changes nothing.
    for _ in range(2):
        full.record_many(reader.parse_incremental(rollout, {}).events)

    pick = ("model", "input", "cache_read", "output", "cwd")
    [lrow], [frow] = _rows(db_live), _rows(db_full)
    assert {k: lrow[k] for k in pick} == {k: frow[k] for k in pick} == {
        "model": "gpt-5.6-sol", "input": 700, "cache_read": 1800, "output": 90,
        "cwd": "/Users/me/proj"}
    assert (lrow["workspace"], lrow["pane"]) == ("/ws", "pane-1")  # kept on update


def test_cwd_is_nfc(monkeypatch: pytest.MonkeyPatch) -> None:
    nfd = "/Users/me/café"
    ev = TokenUsage(vendor="codex", input_tokens=1, output_tokens=1, cwd=nfd,
                    session_id="s", file_path="/x.jsonl", dedup_key="k")
    assert cost_ledger.transcript_cwd(ev) == "/Users/me/café"


# ── B: pane ↔ session map, cost report, reconciliation ─────────────────────


def _call(key: str, session: str, *, cwd: str = "/w", ts: str = "2026-11-05T02:00:00Z",
          model: str = "claude-opus-5-5", inp: int = 1_000_000, out: int = 0) -> TokenUsage:
    return TokenUsage(vendor="codex", input_tokens=inp, output_tokens=out, cwd=cwd,
                      session_id=session, file_path=f"/{session}.jsonl", dedup_key=key,
                      timestamp=ts, model=model)


def _pricing() -> dict:
    return {"version": 7, "effective": "2026-10-06", "models": {"claude-opus-5-5": {
        "input": 5.0, "cache_read": 0.2, "cache_write_5m": 6.25, "cache_write_1h": 10.0, "output": 25.0,
    }}}


def test_a_call_naming_a_pane_maps_its_session(tmp_path: Path) -> None:
    db = Database(tmp_path / "navide.db")
    ledger = CostLedger(db)
    ledger.record(_call("k1", "s1", ts="2026-11-05T02:00:00Z"), "/w", "01:dev")
    ledger.record(_call("k2", "s1", ts="2026-11-05T03:00:00Z"), "/w", "01:dev")
    ledger.record(_call("k3", "s2"), "/w", "")
    with db.transaction() as cur:
        rows = [dict(r) for r in cur.execute("SELECT * FROM pane_sessions")]
    assert len(rows) == 1
    assert rows[0]["pane"] == "01:dev" and rows[0]["session_id"] == "s1"
    assert rows[0]["last_ts"] - rows[0]["first_ts"] == 3600


def test_report_prices_groups_and_keeps_unpriced_apart(tmp_path: Path) -> None:
    ledger = CostLedger(Database(tmp_path / "navide.db"))
    ledger.record(_call("k1", "s1", inp=1_000_000, out=1_000_000), "/w", "01:dev")
    ledger.record(_call("k2", "s2", model="gpt-x"), "/w", "02:qa")
    report = ledger.report("pane", pricing=_pricing())
    by_key = {g["key"]: g for g in report["groups"]}
    assert by_key["01:dev"]["usd"] == 30.0
    assert by_key["01:dev"]["unpriced_calls"] == 0
    assert by_key["02:qa"]["usd"] == 0.0 and by_key["02:qa"]["unpriced_calls"] == 1
    assert report["pricing"] == {"version": 7, "effective": "2026-10-06"}
    with pytest.raises(ValueError):
        ledger.report("vendor", pricing=_pricing())


def test_report_filters_by_folder_day_and_pane(tmp_path: Path) -> None:
    ledger = CostLedger(Database(tmp_path / "navide.db"))
    ledger.record(_call("k1", "s1", cwd="/w"), "/w", "01:dev")
    ledger.record(_call("k2", "s1", cwd="/w/sub", ts="2026-11-06T02:00:00Z"), "/w", "01:dev")
    ledger.record(_call("k3", "s3", cwd="/w2"), "/w2", "01:dev")
    ledger.record(_call("k4", "s4", cwd="/w"), "/w", "02:qa")

    def keys(**filters) -> dict[str, int]:
        return {g["key"]: g["calls"] for g in ledger.report(filters.pop("by"), pricing=_pricing(), **filters)["groups"]}

    # "/w" keeps "/w/sub" but not its neighbour "/w2".
    assert keys(by="cwd", cwd="/w") == {"/w": 2, "/w/sub": 1}
    assert keys(by="day", cwd="/w", since="2026-11-06") == {"2026-11-06": 1}
    assert keys(by="day", cwd="/w", until="2026-11-05") == {"2026-11-05": 2}
    assert keys(by="session", cwd="/w", pane="01:dev") == {"s1": 2}


def test_a_call_without_a_pane_takes_its_sessions_pane(tmp_path: Path) -> None:
    """A backfilled call names no pane; the map says whose session it was."""
    ledger = CostLedger(Database(tmp_path / "navide.db"))
    ledger.record(_call("live", "s1"), "/w", "01:dev")
    ledger.record_many([_call("old", "s1"), _call("orphan", "s9")])
    groups = {g["key"]: g["calls"] for g in ledger.report("pane", pricing=_pricing())["groups"]}
    assert groups == {"01:dev": 2, "": 1}


def test_pane_reconciliation_lists_only_the_panes_that_disagree(tmp_path: Path) -> None:
    ledger = CostLedger(Database(tmp_path / "navide.db"))
    ledger.record(_call("a1", "s1", inp=10), "/w", "01:dev")
    ledger.record(_call("b1", "s2", inp=10), "/w", "02:qa")
    ledger.record_many([_call("b0", "s2", inp=5)])  # read before 02:qa claimed s2
    report = ledger.report("pane", pricing=_pricing())
    assert report["differences"] == [{"pane": "02:qa", "tagged_tokens": 10, "session_tokens": 15}]
    assert ledger.report("pane", pane="01:dev", pricing=_pricing())["differences"] == []


# ── account (profile_id, schema 3) ─────────────────────────────────────────


def _profile_path(root: str, slot: str, sep: str = "/") -> str:
    return sep.join([root, ".navide", "cli-profiles", "claude", slot, "config-dir",
                     "projects", "-w", "s.jsonl"])


def test_v2_to_v3_backfills_profile_from_log_path_for_30_days(tmp_path: Path) -> None:
    import time as _time

    db = Database(tmp_path / "navide.db")
    db.migrate("cost_ledger", 1, cost_ledger._create_schema_v1)
    db.migrate("cost_ledger", 2, cost_ledger._create_schema_v2)
    now = int(_time.time())
    day = 86400
    slot_a, slot_b, slot_c = "a1" + "b2c3d4", "0f" + "0f0f0f", "9e" + "9e9e9e"
    old_rows = [
        ("recent", "claude", now - 2 * day, _profile_path("/Users/me", slot_a)),
        ("deleted", "claude", now - 3 * day, _profile_path("/Users/me", slot_b + ".deleted-1784968180034567000")),
        ("windows", "claude", now - 4 * day, _profile_path("C:\\Users\\me", slot_c, "\\")),
        ("too-old", "claude", now - 40 * day, _profile_path("/Users/me", slot_a)),
        ("live-login", "claude", now - day, "/Users/me/.claude/projects/-w/s.jsonl"),
        ("other-vendor", "codex", now - day, _profile_path("/Users/me", slot_a)),
    ]
    with db.transaction() as cur:
        for key, vendor, ts, src in old_rows:
            cur.execute(
                "INSERT INTO usage_calls VALUES (?, ?, 's', '/w', '', '', 'm', ?, 1, 0, 0, 0, 1, ?)",
                (vendor, key, ts, src),
            )
    CostLedger(db)
    assert db.schema_version("cost_ledger") == 3
    with db.transaction() as cur:
        got = dict(cur.execute("SELECT dedup_key, profile_id FROM usage_calls").fetchall())
        daily = cur.execute("SELECT profile_id, SUM(calls) AS c FROM usage_daily"
                            " GROUP BY profile_id ORDER BY profile_id").fetchall()
    assert got == {"recent": slot_a, "deleted": slot_b, "windows": slot_c,
                   "too-old": "", "live-login": "", "other-vendor": ""}
    assert {r["profile_id"]: r["c"] for r in daily} == {"": 3, slot_a: 1, slot_b: 1, slot_c: 1}


def test_record_stores_profile_and_unknown_is_blank(tmp_path: Path) -> None:
    db = Database(tmp_path / "navide.db")
    ledger = CostLedger(db)
    ledger.record(_call("k1", "s1"), "/w", "01:dev", "acc-1")
    ledger.record(_call("k2", "s2"), "/w", "01:dev", "unknown")
    ledger.record(_call("k3", "s3"), "/w", "01:dev")
    assert {r["session_id"]: r["profile_id"] for r in _rows(db)} == {"s1": "acc-1", "s2": "", "s3": ""}


def test_record_many_reads_profile_off_the_log_path(tmp_path: Path) -> None:
    db = Database(tmp_path / "navide.db")
    ledger = CostLedger(db)
    ev = TokenUsage(vendor="claude", input_tokens=3, output_tokens=1, cwd="/w", session_id="s",
                    file_path=_profile_path("/Users/me", "acc-2"), dedup_key="m1::r1")
    plain = TokenUsage(vendor="claude", input_tokens=3, output_tokens=1, cwd="/w", session_id="s",
                       file_path="/Users/me/.claude/projects/-w/s.jsonl", dedup_key="m2::r2")
    ledger.record_many([ev, plain])
    assert {r["dedup_key"]: r["profile_id"] for r in _rows(db)} == {"m1::r1": "acc-2", "m2::r2": ""}


def test_codex_totals_update_keeps_its_profile(tmp_path: Path) -> None:
    from agent_team_backend.cli_vendors.codex import CodexLogReader

    rollout = tmp_path / "rollout-2026-11-05T02-00-00-cx1.jsonl"
    reader = CodexLogReader()
    db = Database(tmp_path / "navide.db")
    ledger = CostLedger(db)
    _codex_rollout(rollout, [(1000, 600, 50)])
    first = reader.parse_incremental(rollout, {})
    for ev in first.events:
        ledger.record(ev, "/ws", "pane-1", "acc-3")
    _codex_rollout(rollout, [(1000, 600, 50), (2500, 1800, 90)])
    for ev in reader.parse_incremental(rollout, first.checkpoint).events:
        ledger.record(ev, "", "", "")
    [row] = _rows(db)
    assert (row["output"], row["profile_id"]) == (90, "acc-3")


def test_report_by_account_and_model_account(tmp_path: Path) -> None:
    ledger = CostLedger(Database(tmp_path / "navide.db"))
    ledger.record(_call("k1", "s1", inp=1_000_000), "/w", "01:dev", "acc-1")
    ledger.record(_call("k2", "s2", inp=1_000_000), "/w", "01:dev", "acc-1")
    ledger.record(_call("k3", "s3", model="gpt-x"), "/w", "02:qa", "acc-1")
    ledger.record(_call("k4", "s4", inp=1_000_000), "/w", "02:qa", "")

    by_account = {g["key"]: (g["calls"], g["usd"], g["unpriced_calls"])
                  for g in ledger.report("account", pricing=_pricing())["groups"]}
    assert by_account == {"acc-1": (3, 10.0, 1), "": (1, 5.0, 0)}

    groups = ledger.report("model_account", pricing=_pricing())["groups"]
    cross = {(g["model"], g["account"]): (g["key"], g["calls"]) for g in groups}
    assert cross == {
        ("claude-opus-5-5", "acc-1"): ("claude-opus-5-5::acc-1", 2),
        ("gpt-x", "acc-1"): ("gpt-x::acc-1", 1),
        ("claude-opus-5-5", ""): ("claude-opus-5-5::", 1),
    }
