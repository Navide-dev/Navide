"""Token panel reads: daily quota peaks (quota_history_read) and the two
tokens.* requests behind the by-model / by-account views."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.cost_ledger import CostLedger
from agent_team_backend.db import Database
from agent_team_backend.log_readers.base import TokenUsage
from agent_team_backend.quota_history_read import daily_peaks
from agent_team_backend.quota_ledger import QuotaLedger

DAY = 86400
#: 2026-11-09 12:00 UTC — a Monday; with +8h the local day is the same date.
NOW = 1794225600.0
MIDNIGHT = NOW - 12 * 3600  # 2026-11-09 00:00 UTC


def _ledger(tmp_path: Path) -> tuple[Database, QuotaLedger]:
    db = Database(tmp_path / "navide.db")
    return db, QuotaLedger(db, lambda *_a: {})


def _sample(db: Database, kind: str, pct: float, fetched: float, resets: float,
            agent: str = "claude", profile: str = "acc-1") -> None:
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO quota_samples (agent, profile_id, window_kind, used_percent,"
            " resets_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
            (agent, profile, kind, pct, resets, fetched),
        )


def test_daily_peak_carries_the_last_reading_until_its_window_resets(tmp_path: Path) -> None:
    db, _ledger_ = _ledger(tmp_path)
    reset = MIDNIGHT - 2 * DAY + 3600  # the window resets 01:00 on 11-07
    _sample(db, "weekly", 40.0, MIDNIGHT - 10 * DAY, reset)   # before the range, carried in
    _sample(db, "weekly", 55.0, MIDNIGHT - 4 * DAY + 100, reset)
    _sample(db, "weekly", 70.0, MIDNIGHT - 4 * DAY + 200, reset)
    _sample(db, "weekly", 5.0, MIDNIGHT - 1 * DAY + 50, MIDNIGHT + 5 * DAY)

    out = daily_peaks(db, days=7, now=NOW)
    assert out["days"] == ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
                           "2026-11-07", "2026-11-08", "2026-11-09"]
    [account] = out["accounts"]
    [window] = account["windows"]
    assert (account["agent_key"], account["profile_id"], window["window_kind"]) == ("claude", "acc-1", "weekly")
    # 11-03/04 carry 40; 11-05 peaks at 70; 70 holds through 11-07, whose
    # first hour precedes the 01:00 reset; 11-08 starts after it (0) and
    # reads 5; 11-09 carries 5.
    assert window["peaks"] == [40.0, 40.0, 70.0, 70.0, 70.0, 5.0, 5.0]
    assert window["latest"] == {"used_percent": 5.0, "resets_at": MIDNIGHT + 5 * DAY,
                                "fetched_at": MIDNIGHT - DAY + 50}


def test_days_before_the_first_reading_are_none_and_offset_moves_days(tmp_path: Path) -> None:
    db, _ledger_ = _ledger(tmp_path)
    # 11-08 20:00 UTC is 11-09 04:00 in UTC+8.
    _sample(db, "session", 30.0, MIDNIGHT - 4 * 3600, MIDNIGHT + DAY, profile="acc-2")
    utc = daily_peaks(db, days=3, now=NOW)["accounts"][0]["windows"][0]["peaks"]
    local = daily_peaks(db, days=3, utc_offset_min=480, now=NOW)["accounts"][0]["windows"][0]["peaks"]
    assert utc == [None, 30.0, 30.0]
    assert local == [None, None, 30.0]


def test_cost_report_day_model_and_local_offset(tmp_path: Path) -> None:
    ledger = CostLedger(Database(tmp_path / "ledger.db"))

    def call(key: str, ts: str, model: str) -> TokenUsage:
        return TokenUsage(vendor="codex", input_tokens=10, output_tokens=1, cwd="/w",
                          session_id="s", file_path="/s.jsonl", dedup_key=key,
                          timestamp=ts, model=model)

    ledger.record(call("k1", "2026-11-05T20:00:00Z", "m-a"), "/w", "", "acc-1")
    ledger.record(call("k2", "2026-11-05T02:00:00Z", "m-b"), "/w", "", "acc-1")
    pricing = {"version": 1, "effective": "x", "models": {}}
    utc = {g["key"]: (g["day"], g["model"]) for g in ledger.report("day_model", pricing=pricing)["groups"]}
    assert utc == {"2026-11-05::m-a": ("2026-11-05", "m-a"), "2026-11-05::m-b": ("2026-11-05", "m-b")}
    local = ledger.report("day_model", utc_offset_min=480, since="2026-11-06", pricing=pricing)["groups"]
    assert [(g["day"], g["model"]) for g in local] == [("2026-11-06", "m-a")]


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


async def _call(msg_type: str, **payload: Any) -> dict[str, Any]:
    session = app.Session(_FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {"id": "m1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]["payload"]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_ws_cost_report_and_quota_history(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db, _ledger_ = _ledger(tmp_path)
    ledger = CostLedger(db)
    monkeypatch.setattr(app, "database", db)
    monkeypatch.setattr(app, "cost_ledger", ledger)
    ledger.record(TokenUsage(vendor="codex", input_tokens=10, output_tokens=1, cwd="/w/sub",
                             session_id="s", file_path="/s.jsonl", dedup_key="k",
                             timestamp="2026-11-05T02:00:00Z", model="m"), "/w", "", "acc-9")
    _sample(db, "weekly", 12.0, 1700000000.0, 1700500000.0, profile="acc-9")

    report = await _call("tokens.cost_report", by="account", cwd="/w")
    assert report["ok"] is True
    assert [(g["key"], g["calls"]) for g in report["groups"]] == [("acc-9", 1)]
    assert (await _call("tokens.cost_report", by="vendor"))["ok"] is False

    history = await _call("tokens.quota_history", days=2)
    assert history["ok"] is True and len(history["days"]) == 2
    assert [a["profile_id"] for a in history["accounts"]] == ["acc-9"]
