"""Account isolation, bounded transcript analysis and the monitor wire contract."""

import json
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from agent_team_backend import token_monitor as monitor
from agent_team_backend import usage_service as usage
from agent_team_backend.cli_vendors.claude import ClaudeLogReader


def stamp(days=0):
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def quota(value=0, **changes):
    return {"status": "ok", "fetchedAt": stamp(), "planType": "max",
            "windows": [{"kind": "session", "label": "Session", "usedPercent": value,
                         "resetsAt": stamp(-1), "windowMinutes": 300}], **changes}


def test_quota_persists_only_fresh_numeric_observations_and_isolates_accounts(tmp_path):
    path = tmp_path / "history.sqlite3"
    history = monitor.QuotaHistory(path)
    good = quota(0, accessToken="must-not-persist", prompt="private")
    history.record("a", good)
    history.record("a", good)
    history.record("b", quota(85))
    for value in (None, True, float("nan"), -1, 101):
        history.record("a", quota(value))
    history.record("a", quota(50, stale=True))
    history.record("a", quota(50, status="error"))
    history.record("a", quota(50, fetchedAt=stamp(181)))
    restored = monitor.QuotaHistory(path)
    rows = restored.samples("a", 90)
    assert len(rows) == 1
    assert rows[0]["windows"][0]["usedPercent"] == 0
    assert "must-not-persist" not in json.dumps(rows)
    assert "private" not in json.dumps(rows)
    assert restored.samples("b", 90)[0]["windows"][0]["usedPercent"] == 85
    assert restored.samples("unknown", 90) == []


def transcript(path, *, days=0, model="claude-opus", output=4):
    records = [
        {"type": "user", "promptId": "p", "timestamp": stamp(days),
         "message": {"content": "private prompt"}},
        {"type": "assistant", "requestId": "r", "timestamp": stamp(days),
         "message": {"id": "m", "model": model, "usage": {
             "input_tokens": 1, "cache_read_input_tokens": 20,
             "cache_creation_input_tokens": 3, "output_tokens": output}}},
    ]
    path.write_text("\n".join(json.dumps(r) for r in [*records, records[1]]))


def test_turns_use_exact_dedup_cache_and_time_window(tmp_path, monkeypatch):
    path = tmp_path / "session.jsonl"
    old = tmp_path / "old.jsonl"
    transcript(path)
    transcript(old, days=40)
    reader = ClaudeLogReader()
    monkeypatch.setattr(reader, "session_files", lambda: [path, old])
    calls = []
    original = reader.turns_for_session

    def tracked(*args):
        calls.append(args)
        return original(*args)

    monkeypatch.setattr(reader, "turns_for_session", tracked)
    history = monitor.TurnHistory()
    first = history.scan(reader, 30)
    assert len(first["turns"]) == 1
    assert first["turns"][0]["total"] == 28
    assert first["turns"][0]["calls"] == 1
    assert "prompt_excerpt" not in first["turns"][0]
    assert history.scan(reader, 30) == first
    assert len(calls) == 2
    assert len(history.scan(reader, 90)["turns"]) == 2
    assert len(calls) == 2  # unchanged files reused across period switches
    transcript(path, output=40)
    monkeypatch.setattr(monitor, "CACHE_SECONDS", 0)
    assert history.scan(reader, 30)["turns"][0]["total"] == 64
    assert len(calls) == 3


def test_scan_caps_and_duplicate_sessions_are_visible(tmp_path, monkeypatch):
    first = tmp_path / "session.jsonl"
    duplicate = tmp_path / "copy" / "session.jsonl"
    duplicate.parent.mkdir()
    transcript(first)
    transcript(duplicate)
    reader = ClaudeLogReader()
    monkeypatch.setattr(reader, "session_files", lambda: [first, duplicate])
    assert len(monitor.TurnHistory().scan(reader, 30)["turns"]) == 1
    monkeypatch.setattr(monitor, "MAX_FILE_BYTES", 1)
    result = monitor.TurnHistory().scan(reader, 30)
    assert result["turns"] == []
    assert result["coverage"]["truncated"] is True
    assert result["coverage"]["sessions_scanned"] == 0


async def test_poll_records_success_but_discards_mid_read_account_switch(tmp_path, monkeypatch):
    service = usage.UsageService(cache_path=tmp_path / "usage.json")
    for provider in usage._CLI_VENDORS:
        service._blocked_until[provider] = time.monotonic() + 3600
    monkeypatch.setattr(usage, "_get_profiles_store", lambda: None)
    monkeypatch.setattr(usage, "_get_credential_vault", lambda: None)

    async def fetch(home):
        return quota(33)

    monkeypatch.setattr(usage, "fetch_claude", fetch)
    await service.poll_once(tmp_path)
    assert len(service.quota_history.samples("__default__", 30)) == 1
    service._blocked_until.pop(("claude", "__default__"))

    async def switched(home):
        service._switch_epoch += 1
        return quota(77)

    monkeypatch.setattr(usage, "fetch_claude", switched)
    await service.poll_once(tmp_path)
    assert len(service.quota_history.samples("__default__", 30)) == 1


async def test_monitor_handler_runs_off_loop_and_reports_unknown_attribution(tmp_path, monkeypatch):
    from agent_team_backend import app

    path = tmp_path / "session.jsonl"
    transcript(path)
    reader = ClaudeLogReader()
    threads = []

    def files():
        threads.append(threading.current_thread().name)
        return [path]

    monkeypatch.setattr(reader, "session_files", files)
    monkeypatch.setattr(app, "_readers", [reader])
    monkeypatch.setattr(monitor, "history", monitor.TurnHistory())
    monkeypatch.setattr(usage, "service", SimpleNamespace(
        _active_claude_slot="a", enabled=False,
        quota_history=monitor.QuotaHistory(tmp_path / "quota.sqlite3"),
    ))
    messages = []

    async def send(frame):
        messages.append(frame)

    session = app.Session(SimpleNamespace(send_json=send))
    await app.handle_message(session, {"id": "monitor", "type": "tokens.monitor", "payload": {"days": 30}})
    reply = messages[-1]["payload"]
    assert messages[-1]["type"] == "tokens.monitor.result"
    assert reply["ok"] and reply["account_attribution"] == "unknown"
    assert reply["turns"][0]["total"] == 28
    assert reply["quota"] == {"active_slot_id": "a", "enabled": False, "samples": [], "error": None}
    assert all(name.startswith("token-monitor") for name in threads)

    def unreadable(*args):
        raise sqlite3.DatabaseError("corrupt")

    monkeypatch.setattr(usage.service.quota_history, "samples", unreadable)
    degraded = await monitor.snapshot(30)
    assert degraded["ok"] and degraded["turns"]
    assert degraded["quota"]["error"]
    assert degraded["quota"]["samples"] == []


async def test_history_write_failure_does_not_break_existing_usage(tmp_path, monkeypatch):
    service = usage.UsageService(cache_path=tmp_path / "usage.json")
    for provider in usage._CLI_VENDORS:
        service._blocked_until[provider] = time.monotonic() + 3600
    monkeypatch.setattr(usage, "_get_profiles_store", lambda: None)
    monkeypatch.setattr(usage, "_get_credential_vault", lambda: None)

    async def fetch(home):
        return quota(33)

    def unwritable(*args):
        raise sqlite3.OperationalError("read-only")

    monkeypatch.setattr(usage, "fetch_claude", fetch)
    monkeypatch.setattr(service.quota_history, "record", unwritable)
    result = await service.poll_once(tmp_path)
    assert result["providers"]["claude"]["status"] == "ok"
    assert result["providers"]["claude"]["windows"][0]["usedPercent"] == 33


@pytest.mark.parametrize("days", [0, 9999, "30", None, True, [], {}])
async def test_invalid_period_is_rejected(days):
    assert await monitor.snapshot(days) == {"ok": False, "error": "days must be 14, 30, or 90"}


def test_websocket_monitor_round_trip_without_startup_side_effects(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from agent_team_backend import app, ws_auth

    path = tmp_path / "session.jsonl"
    transcript(path)
    reader = ClaudeLogReader()
    monkeypatch.setattr(reader, "session_files", lambda: [path])
    monkeypatch.setattr(app, "_readers", [reader])
    monkeypatch.setattr(app, "get_terminals", lambda: SimpleNamespace())
    monkeypatch.setattr(app, "version_change", lambda: None)
    monkeypatch.setattr(app.server_link, "roster_changed", lambda: None)
    monkeypatch.setattr(ws_auth, "_token", "monitor-test-token")
    monkeypatch.setattr(monitor, "history", monitor.TurnHistory())
    history = monitor.QuotaHistory(tmp_path / "quota.sqlite3")
    history.record("active", quota(0))
    history.record("other", quota(90))
    monkeypatch.setattr(usage, "service", SimpleNamespace(
        _active_claude_slot="active", enabled=True, quota_history=history,
    ))
    # Do not use a TestClient context manager: it would run real startup
    # hooks and shutdown shared application resources. Only /ws is exercised.
    client = TestClient(app.app, base_url="http://127.0.0.1")
    with client.websocket_connect("/ws?t=monitor-test-token") as ws:
        # Every connection opens with the window challenge.
        assert ws.receive_json()["type"] == "ws.welcome"
        for days in (14, 30, 90):
            ws.send_json({"id": str(days), "type": "tokens.monitor", "payload": {"days": days}})
            frame = ws.receive_json()
            assert frame["id"] == str(days)
            assert frame["type"] == "tokens.monitor.result"
            result = frame["payload"]
            assert result["scope"] == "local-claude-history"
            assert result["account_attribution"] == "unknown"
            assert result["turns"][0]["total"] == 28
            assert result["turns"][0]["calls"] == 1
            assert result["quota"]["error"] is None
            assert len(result["quota"]["samples"]) == 1
            assert result["quota"]["samples"][0]["windows"][0]["usedPercent"] == 0
        ws.send_json({"id": "invalid", "type": "tokens.monitor", "payload": {"days": 1}})
        invalid = ws.receive_json()
        assert invalid["id"] == "invalid"
        assert invalid["payload"] == {"ok": False, "error": "days must be 14, 30, or 90"}
