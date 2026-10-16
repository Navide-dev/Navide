"""The account dimension end to end, plus the two new tokens.* handlers.

- terminal.create pins the pane's account; usage on its session is credited
  to that account by the event's own time, a re-pin on another account
  splits the ledger, and the release on unregister sends what follows to
  "unknown" (contract-dimensions §2).
- tokens.turns stamps every turn with the account the pane held when the
  turn started, and lists the accounts involved (§1).
- tokens.quota_cycles / tokens.account_periods follow §3 / §4 / §6.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, quota_ledger, ws_handlers
from agent_team_backend.db import Database
from agent_team_backend.log_readers import ClaudeLogReader, TokenUsage
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import LogReader, TurnCall, TurnUsage
from agent_team_backend.log_readers.claude import encode_claude_cwd
from agent_team_backend.pane_account_history import PaneAccountHistory
from agent_team_backend.quota_ledger import QuotaLedger
from agent_team_backend.tokens_store import TokensStore

from .test_app_terminal_create import _session, _stub_agent_cli_probe  # noqa: F401

T0 = "2026-09-16T01:00:00Z"
T0_EPOCH = 1789520400.0
#: The ledger's clock for the quota tests. tokens.quota_cycles without a range
#: reads the 30 days up to the ledger's now, so on the real clock these fixed
#: T0 cycles fell out of it on 2026-10-16 06:00 UTC (T0 + 5h + 30d).
LEDGER_NOW = T0_EPOCH + 86400


@pytest.fixture
def ledger_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pins the ledger's default now; an explicit `now` still wins."""
    monkeypatch.setattr(quota_ledger, "_now", lambda now: LEDGER_NOW if now is None else float(now))


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@pytest.fixture
def stores(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Fresh store / history / ledger on a temp database, wired into app."""
    db = Database(tmp_path / "navide.db")
    db.kv_set("tokens.slices_since", 1733011200.0, now=1)  # observed since December 2024
    store = TokensStore(global_path=tmp_path / "g.json", workspace_base_dir=tmp_path / "w", db=db)
    history = PaneAccountHistory(db)
    ledger = QuotaLedger(db, store.account_window_totals)
    attribution = Attribution([ClaudeLogReader()], workspaces_path=tmp_path / "known.json", db=db)
    attribution.on_unregister = history.release
    monkeypatch.setattr(app, "tokens_store", store)
    monkeypatch.setattr(app, "pane_account_history", history)
    monkeypatch.setattr(app, "quota_ledger", ledger)
    monkeypatch.setattr(app, "attribution", attribution)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(app, "track_live_session", lambda **_kwargs: None)
    monkeypatch.setattr(app, "_schedule_tokens_broadcast", lambda _ws: None)
    monkeypatch.setattr(app, "_live_scans", {})
    yield store, history, ledger, attribution
    store.flush()
    db.close()


async def _call(msg_type: str, **payload: Any) -> dict[str, Any]:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {"id": "m1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]["payload"]  # type: ignore[attr-defined]


def _usage(workspace: str, session_file: Path, key: str, ts: str, tokens: int = 100) -> TokenUsage:
    return TokenUsage(
        vendor="claude", input_tokens=tokens, output_tokens=1, cwd=workspace,
        session_id="sess-1", file_path=str(session_file), dedup_key=key,
        timestamp=ts, cli_version="2.1.273",
    )


@pytest.mark.asyncio
async def test_usage_is_credited_to_the_account_the_pane_held_at_the_time(
    stores, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, history, _ledger, attribution = stores
    config = tmp_path / "claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(config))
    workspace_path = tmp_path / "workspace"
    workspace_path.mkdir()
    workspace = str(workspace_path)
    session_file = config / "projects" / encode_claude_cwd(workspace) / "sess-1.jsonl"
    session_file.parent.mkdir(parents=True)
    session_file.write_text("")
    # The pin terminal.create resolves — the real rule reads the machine's
    # active profile, which this test must not depend on.
    pins = iter(["acct-a", "acct-b"])
    monkeypatch.setattr(
        ws_handlers, "_profile_pin_for_bookkeeping", lambda *_a: next(pins),
    )

    create = {
        "pane_id": "pane-1", "agent_key": "claude", "command": "claude", "cwd": workspace,
        "metadata": {"workspace_path": workspace, "explicit_session_id": "sess-1"},
    }
    await app.handle_message(_session(), {"id": "c1", "type": "terminal.create", "payload": create})
    [(profile, since, until)] = history.intervals("pane-1")
    assert profile == "acct-a" and until is None

    # A resumed transcript's old turn: before the pin → unknown. A live call
    # (stamped now-ish) → acct-a.
    import time
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()))
    await app._on_log_token_usage(_usage(workspace, session_file, "old::1", "2026-01-01T00:00:00Z", 7))
    await app._on_log_token_usage(_usage(workspace, session_file, "live::1", now_iso, 100))
    cum = store.snapshot(workspace)["workspace"]["cumulative"]
    assert cum["by_account"] == {
        "unknown": {"input": 7, "output": 1, "calls": 1},
        "acct-a": {"input": 100, "output": 1, "calls": 1},
    }
    assert cum["by_version"] == {"claude@2.1.273": {"input": 107, "output": 2, "calls": 2}}

    # Re-created on another account (restore / account switch): the same
    # pane id, a new interval; what follows lands on acct-b.
    time.sleep(0.01)
    await app.handle_message(_session(), {"id": "c2", "type": "terminal.create", "payload": create})
    assert [p for p, _, _ in history.intervals("pane-1")] == ["acct-a", "acct-b"]
    time.sleep(0.01)
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 1))
    await app._on_log_token_usage(_usage(workspace, session_file, "live::2", now_iso, 30))
    cum = store.snapshot(workspace)["workspace"]["cumulative"]
    assert cum["by_account"]["acct-b"] == {"input": 30, "output": 1, "calls": 1}
    assert cum["by_account"]["acct-a"] == {"input": 100, "output": 1, "calls": 1}

    # Dropping the registration (kill / unspawn / PTY death) closes the
    # interval; the pane no longer attributes, so the sink cannot even reach
    # an account — but the history itself reads unknown from here on.
    attribution.unregister_pane("pane-1")
    assert history.intervals("pane-1")[-1][2] is not None
    assert history.profile_at("pane-1", None) == "unknown"
    # Conservation held throughout.
    total_by_account = sum(b["input"] for b in cum["by_account"].values())
    assert total_by_account == cum["by_vendor"]["claude"]["input"]


class _TurnsReader(LogReader):
    vendor = "fake"
    turns_method = "exact"

    def project_dirs(self) -> list[Path]:
        return []

    def session_files(self) -> list[Path]:
        return []

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list:
        return []

    def turns_for_session(self, path: Path, session_id: str = "") -> list[TurnUsage]:
        out = []
        for n, (started, version) in enumerate(
            (("2026-09-16T00:30:00Z", "2.1.270"), ("2026-09-16T01:30:00Z", "2.1.273"),
             ("2026-09-16T02:30:00Z", "2.1.273")), 1,
        ):
            turn = TurnUsage(turn_index=n, session_id=session_id, started_at=started,
                             ended_at=started, prompt_excerpt=f"p{n}")
            turn.add_call(TurnCall(ts=started, model="m", input=1, cache_read=0,
                                   cache_creation=0, output=1, cli_version=version))
            out.append(turn)
        return out


@pytest.mark.asyncio
async def test_turns_carry_the_account_of_their_start_and_the_accounts_list(
    stores, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _store, history, _ledger, _attribution = stores
    monkeypatch.setattr(app, "_readers", [_TurnsReader()])
    log = tmp_path / "sess-1.jsonl"
    log.write_text("{}\n")
    app._live_scans[(str(tmp_path), "sess-1")] = {
        "vendor": "fake", "session_id": "sess-1", "session_file": str(log),
        "identity": "", "size": -1, "mtime": -1.0, "cursor": {},
        "totals": {"input": 0, "output": 0, "calls": 0}, "panes": {"pane-1"},
    }
    # acct-a from 01:00Z, acct-b from 02:00Z; the 00:30 turn predates the pin.
    history.pin("pane-1", "acct-a", ts=T0_EPOCH)
    history.pin("pane-1", "acct-b", ts=T0_EPOCH + 3600)

    reply = await _call("tokens.turns", pane_id="pane-1", include_calls=True)
    assert reply["ok"] is True
    assert [(t["turn_index"], t["profile_id"], t["cli_version"]) for t in reply["turns"]] == [
        (1, "unknown", "2.1.270"), (2, "acct-a", "2.1.273"), (3, "acct-b", "2.1.273"),
    ]
    assert reply["accounts"] == ["unknown", "acct-a", "acct-b"]
    assert reply["turns"][0]["calls_detail"][0]["cli_version"] == "2.1.270"
    # A bare session id resolves the account through the bound pane too.
    bare = await _call("tokens.turns", session_id="sess-1")
    assert [t["profile_id"] for t in bare["turns"]] == ["unknown", "acct-a", "acct-b"]


@pytest.mark.asyncio
async def test_quota_cycles_handler_follows_the_contract(stores, ledger_clock, tmp_path: Path) -> None:
    store, _history, ledger, _attribution = stores
    workspace = str(tmp_path)
    resets = T0_EPOCH + 5 * 3600
    from datetime import datetime, timezone

    def iso(ts: float) -> str:
        return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")

    ledger.observe("claude", "acct-a", {
        "status": "ok", "fetchedAt": iso(T0_EPOCH + 10),
        "windows": [{"kind": "session", "label": "Session (5h)", "usedPercent": 100.0,
                     "resetsAt": iso(resets)}],
    }, now=T0_EPOCH + 10)
    # Usage inside the window (a 2026 stamp is well within slice retention
    # only if the clock says so — use an in-window stamp relative to T0 and
    # accept that the slice may be pruned when the test runs far in the
    # future; the closed-cycle path below is what freezes it).
    store.record(workspace, source="cli", vendor="claude", input_tokens=500, output_tokens=5,
                 dedup_key="k1", profile_id="acct-a", timestamp=iso(T0_EPOCH + 3600))
    unknown_vendor = await _call("tokens.quota_cycles", agent_key="nope", profile_id="acct-a")
    assert unknown_vendor == {"ok": False, "error": "unknown-vendor"}

    empty = await _call("tokens.quota_cycles", agent_key="codex", profile_id="acct-a")
    assert {key: empty[key] for key in ("ok", "agent_key", "profile_id", "cycles", "summary")} == {
        "ok": True, "agent_key": "codex", "profile_id": "acct-a", "cycles": [], "summary": {}}
    assert empty["total_count"] == 0 and empty["next_cursor"] is None

    reply = await _call("tokens.quota_cycles", agent_key="claude", profile_id="acct-a")
    assert reply["ok"] is True and reply["agent_key"] == "claude"
    [cycle] = reply["cycles"]
    assert cycle["window_kind"] == "session"
    assert cycle["started_at"] == iso(T0_EPOCH) and cycle["resets_at"] == iso(resets)
    assert cycle["exhausted_at"] == iso(T0_EPOCH + 10)
    assert cycle["max_percent"] == 100.0 and cycle["samples"] == 1
    assert set(cycle) >= {"input", "cache_read", "cache_creation", "output", "total",
                          "calls", "turns", "closed"}
    assert reply["summary"]["session"]["cycles"] == 1
    assert reply["summary"]["session"]["exhausted"] == 1
    # window_kind filter
    none = await _call("tokens.quota_cycles", agent_key="claude", profile_id="acct-a",
                       window_kind="weekly")
    assert none["cycles"] == []


@pytest.mark.asyncio
async def test_account_periods_handler_rolls_days_into_months_and_years(stores, tmp_path: Path) -> None:
    store, _history, ledger, _attribution = stores
    workspace = str(tmp_path)
    for n, (profile, ts, tokens) in enumerate((
        ("acct-a", "2026-09-01T00:00:00Z", 300),
        ("acct-a", "2026-09-20T00:00:00Z", 200),
        ("acct-b", "2026-09-05T00:00:00Z", 400),
        ("acct-a", "2026-08-05T00:00:00Z", 50),
        ("", "2025-12-31T23:00:00Z", 9),
    )):
        store.record(workspace, source="cli", vendor="claude", input_tokens=tokens, output_tokens=1,
                     dedup_key=f"k{n}", profile_id=profile, timestamp=ts,
                     cache_read_tokens=tokens // 2)
    store.record_turn("claude", "acct-a", "2026-09-01T00:00:01Z")
    from datetime import datetime, timezone

    def iso(ts: float) -> str:
        return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")

    # Two 5h cycles for acct-a in September, one exhausted (closed by now).
    for n, pct in enumerate((100.0, 40.0)):
        start = T0_EPOCH + n * 5 * 3600
        ledger.observe("claude", "acct-a", {
            "status": "ok", "fetchedAt": iso(start + 60),
            "windows": [{"kind": "session", "label": "Session (5h)", "usedPercent": pct,
                         "resetsAt": iso(start + 5 * 3600)}],
        }, now=start + 60)

    bad = await _call("tokens.account_periods", agent_key="nope", granularity="month")
    assert bad == {"ok": False, "error": "unknown-vendor"}

    selected_range = {"range_start": "2025-01-01T00:00:00Z", "range_end": "2027-01-01T00:00:00Z"}
    reply = await _call("tokens.account_periods", granularity="month", **selected_range)
    assert reply["ok"] is True and reply["granularity"] == "month"
    rows = reply["rows"]
    assert [(r["period"], r["profile_id"]) for r in rows] == [
        ("2026-09", "acct-a"), ("2026-09", "acct-b"), ("2026-08", "acct-a"), ("2025-12", "unknown"),
    ]
    sept_a = rows[0]
    assert (sept_a["agent_key"], sept_a["input"], sept_a["cache_read"], sept_a["output"]) == (
        "claude", 250, 250, 2,
    )
    assert sept_a["total"] == 502 and sept_a["calls"] == 2 and sept_a["turns"] == 1
    assert (sept_a["cycles"], sept_a["exhausted"], sept_a["weekly_exhausted"]) == (2, 1, 0)
    assert rows[1]["cycles"] == 0 and rows[1]["avg_total_exhausted"] is None
    assert [{key: r[key] for key in ("period", "total", "calls", "turns")} for r in reply["totals_by_period"]] == [
        {"period": "2026-09", "total": 502 + 401, "calls": 3, "turns": 1},
        {"period": "2026-08", "total": 51, "calls": 1, "turns": 0},
        {"period": "2025-12", "total": 10, "calls": 1, "turns": 0},
    ]

    yearly = await _call("tokens.account_periods", agent_key="claude", profile_id="acct-a",
                         granularity="year", **selected_range)
    assert [(r["period"], r["total"], r["cycles"]) for r in yearly["rows"]] == [("2026", 553, 2)]
    # Filters that match nothing are ok + empty.
    nothing = await _call("tokens.account_periods", profile_id="ghost", granularity="year")
    assert {key: nothing[key] for key in ("ok", "granularity", "rows", "totals_by_period")} == {
        "ok": True, "granularity": "year", "rows": [], "totals_by_period": []}
    assert nothing["total_count"] == 0 and nothing["next_offset"] is None


@pytest.mark.asyncio
async def test_quota_exhausted_handler_stamps_the_panes_account(stores, ledger_clock, monkeypatch) -> None:
    _store, history, ledger, _attribution = stores
    from datetime import datetime, timezone

    def iso(ts: float) -> str:
        return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")

    resets = T0_EPOCH + 5 * 3600
    sample_at = T0_EPOCH + 4 * 3600 + 35 * 60
    seen_at = T0_EPOCH + 4 * 3600 + 31 * 60
    history.pin("pane-1", "acct-a", ts=T0_EPOCH)
    ledger.observe("claude", "acct-a", {
        "status": "ok", "fetchedAt": iso(sample_at),
        "windows": [{"kind": "session", "label": "Session (5h)", "usedPercent": 100.0,
                     "resetsAt": iso(resets)}],
    }, now=sample_at)
    events: list[dict] = []

    async def broadcast(event, **_kw):
        events.append(event)

    monkeypatch.setattr(app, "broadcast", broadcast)

    bad = await _call("tokens.quota_exhausted", agent_key="nope", pane_id="pane-1",
                      at=iso(seen_at), resets_at=iso(resets), reset_precision="minute", window_kind="session")
    assert bad == {"ok": False, "error": "unknown-vendor"}
    # A pane with no account resolves to nothing to stamp.
    none = await _call("tokens.quota_exhausted", agent_key="claude", pane_id="ghost",
                       at=iso(seen_at), resets_at=iso(resets), reset_precision="minute", window_kind="session")
    assert none == {"ok": True, "updated": []} and events == []
    # Neither does a message that named no window: which of the account's
    # windows hit the wall is then unknown, and the 100 % sample owns the stamp.
    blind = await _call("tokens.quota_exhausted", agent_key="claude", pane_id="pane-1",
                        at=iso(seen_at))
    assert blind == {"ok": True, "updated": []} and events == []

    reply = await _call("tokens.quota_exhausted", agent_key="claude", pane_id="pane-1",
                        at=iso(seen_at), resets_at=iso(resets), reset_precision="minute", window_kind="session")
    assert reply == {"ok": True, "updated": ["session"]}
    assert [e["type"] for e in events] == ["tokens.quota_cycles_changed"]
    assert events[0]["payload"] == {"agent_key": "claude", "profile_id": "acct-a", "window_kind": "session"}
    cycles = await _call("tokens.quota_cycles", agent_key="claude", profile_id="acct-a")
    assert cycles["cycles"][0]["exhausted_at"] == iso(seen_at)
    # Later detection: no change, no broadcast.
    again = await _call("tokens.quota_exhausted", agent_key="claude", pane_id="pane-1",
                        at=iso(sample_at + 60), resets_at=iso(resets), reset_precision="minute", window_kind="session")
    assert again == {"ok": True, "updated": []} and len(events) == 1


@pytest.mark.asyncio
async def test_non_account_vendor_pins_the_slot_its_usage_samples_are_filed_under(
    stores, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A vendor without profiles records "" as its
    restore pin, but the usage poller files its quota samples under the
    Default slot. The history must pin that same id, or the cycle's token
    side never finds the pane's slices (it would sum "__default__" while the
    usage sat under "unknown")."""
    from datetime import datetime, timezone

    from agent_team_backend import usage_service as us

    store, history, ledger, _attribution = stores
    workspace_path = tmp_path / "workspace"
    workspace_path.mkdir()
    workspace = str(workspace_path)
    # Every registry vendor now declares a credential slot, so the
    # non-account case is simulated by taking mcode out of the profile set;
    # the rule itself is the real one: "" for a non-account agent.
    monkeypatch.setattr(
        ws_handlers, "PROFILE_AGENT_KEYS",
        tuple(k for k in ws_handlers.PROFILE_AGENT_KEYS if k != "mcode"),
    )
    assert ws_handlers._profile_pin_for_bookkeeping("mcode", "pane-mc", None) == ""
    create = {
        "pane_id": "pane-mc", "agent_key": "mcode", "command": "mcode", "cwd": workspace,
        "metadata": {"workspace_path": workspace},
    }
    await app.handle_message(_session(), {"id": "c1", "type": "terminal.create", "payload": create})
    [(profile, _since, until)] = history.intervals("pane-mc")
    assert profile == "__default__" and until is None
    assert history.profile_at("pane-mc", None) == "__default__"

    # Usage on that pane lands on the same id and inside the cycle window.
    import time
    now = time.time()
    now_iso = datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    store.record(
        workspace, source="cli", vendor="mcode", agent_key="mcode", pane_id="pane-mc",
        session_id="s", input_tokens=40, output_tokens=2, dedup_key="oc::1",
        profile_id=history.profile_at("pane-mc", now), timestamp=now_iso,
    )
    resets_iso = datetime.fromtimestamp(now + 3600, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    svc = us.UsageService()
    svc.account_snapshots["mcode"] = {"__default__": {
        "provider": "mcode", "status": "ok", "fetchedAt": now_iso,
        "windows": [{"kind": "session", "label": "Session (5h)", "usedPercent": 12.0,
                     "resetsAt": resets_iso}],
    }}
    events: list[dict] = []

    async def broadcast(event, **_kw):
        events.append(event)

    monkeypatch.setattr(app, "broadcast", broadcast)
    await svc._file_quota_samples()
    assert [e["payload"] for e in events] == [
        {"agent_key": "mcode", "profile_id": "__default__", "window_kind": "session"}
    ]
    [cycle] = ledger.cycles("mcode", "__default__")
    assert cycle["coverage_reason"] == "start_unknown" and cycle["total"] is None
    assert tuple(cycle["recorded_totals"][key] for key in ("input", "output", "calls")) == (40, 2, 1)
    assert ledger.cycles("mcode", "unknown") == []
