"""quota_failover: the backend authority for quota-exhaustion account failover.

Plan: .agent-team/plans/quota-exhaustion-auto-switch_7b3e91.html, Phase B/E.
Everything runs against a temporary database, a temporary profiles store and
a fake vault — no real credentials, no Keychain, no UI.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, quota_failover as qf, usage_service, ws_handlers
from agent_team_backend.db import Database
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.pane_account_history import PaneAccountHistory
from agent_team_backend.profiles_store import CliProfilesStore
from agent_team_backend.quota_ledger import QuotaLedger


NOW = 1_800_000_000.0  # 2027-01-15T08:00:00Z


def iso(ts: float) -> str:
    return qf._now_iso(ts)


# ── fakes ───────────────────────────────────────────────────────────────────

class Clock:
    def __init__(self, start: float = NOW) -> None:
        self.t = start

    def now(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.registry: dict[str, SimpleNamespace] = {}

    def get(self, session_id: str) -> SimpleNamespace | None:
        return self.registry.get(session_id)


class FakeVault:
    """Mirrors the vault surface the authority touches. ``switch`` records
    calls and can be made to fail; slots hold a secret or None."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.switch_calls: list[tuple[str, str, str, str | None]] = []
        self.fail_switch = False
        self.slot_secrets: dict[tuple[str, str], str | None] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self.login_harvests: list[tuple[str, str]] = []

    def switch_lock(self, agent_key: str) -> asyncio.Lock:
        return self._locks.setdefault(agent_key, asyncio.Lock())

    def switch(self, agent_key: str, from_slot_id: str, to_slot_id: str, *, scope: str | None = None) -> None:
        self.switch_calls.append((agent_key, from_slot_id, to_slot_id, scope))
        if self.fail_switch:
            raise RuntimeError("swap boom")

    def read_slot(self, agent_key: str, slot_id: str, *, scope: str | None = None) -> SimpleNamespace:
        return SimpleNamespace(secret=self.slot_secrets.get((agent_key, slot_id)), account=None)

    def login_home_path(self, agent_key: str, slot_id: str) -> Path:
        return self.root / agent_key / slot_id / "login-home"

    def harvest_login_home(self, agent_key: str, slot_id: str, *, scope: str | None = None) -> bool:
        self.login_harvests.append((agent_key, slot_id))
        home = self.login_home_path(agent_key, slot_id)
        if not home.is_dir():
            return False
        shutil.rmtree(home)
        return True

    def identity(self, agent_key: str, slot_id: str | None = None, *, scope: str | None = None) -> dict:
        # ``emails`` maps a secret payload to the account it belongs to; a
        # secret it does not know carries no identity (an opaque credential).
        emails = self.__dict__.get("emails")
        if emails is None:
            return {"email": "live@example.com", "signedIn": True}
        secret = self.read_live(agent_key).secret if slot_id is None else self.slot_secrets.get((agent_key, slot_id))
        return {"email": emails.get(str(secret)), "signedIn": secret is not None}

    # Login seam (mirrors the vault's contract for a vendor without login
    # isolation): a parked pre-login snapshot marks a pending sign-in.
    live_secrets: dict[str, str | None]
    pending_logins: set[tuple[str, str]]
    discarded: list[tuple[str, str]]
    captures: list[tuple[str, str]]

    # No claude account has signed in inside its own config dir.
    def account_dir_signed_in(self, slot_id: str) -> bool:
        return False

    def account_dir_identity(self, slot_id: str) -> dict | None:
        return None

    def _login_isolated(self, agent_key: str) -> bool:
        return agent_key not in getattr(self, "global_login_vendors", set())

    def login_pending(self, agent_key: str, slot_id: str) -> bool:
        return (agent_key, slot_id) in getattr(self, "pending_logins", set()) or \
            self.login_home_path(agent_key, slot_id).is_dir()

    def discard_pending_login(self, agent_key: str, slot_id: str, *, scope: str | None = None) -> bool:
        self.__dict__.setdefault("discarded", []).append((agent_key, slot_id))
        return bool(self.__dict__.setdefault("pending_logins", set()).discard((agent_key, slot_id)) or True)

    def read_live(self, agent_key: str, *, strict: bool = False, scope: str | None = None) -> SimpleNamespace:
        return SimpleNamespace(secret=self.__dict__.setdefault("live_secrets", {}).get(agent_key), account=None)

    def capture(self, agent_key: str, slot_id: str, *, scope: str | None = None) -> SimpleNamespace:
        live = self.read_live(agent_key)
        self.slot_secrets[(agent_key, slot_id)] = live.secret
        self.__dict__.setdefault("captures", []).append((agent_key, slot_id))
        return live


CLAUDE_SECRET = json.dumps({"claudeAiOauth": {
    "accessToken": "at", "refreshToken": "rt", "expiresAt": int((NOW + 86400) * 1000),
}})


def window(kind: str, used: float, resets_in: float, *, now: float = NOW) -> dict:
    return {"kind": kind, "label": kind, "usedPercent": used, "resetsAt": iso(now + resets_in)}


def snap(agent: str, windows: list[dict], *, fetched_at: float = NOW, status: str = "ok",
         stale: bool = False) -> dict:
    return {"provider": agent, "status": status, "windows": windows,
            "fetchedAt": iso(fetched_at), "lastSuccessAt": iso(fetched_at), "stale": stale}


class Harness:
    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.clock = Clock()
        self.db = Database(tmp_path / "navide.db")
        self.store = CliProfilesStore(
            path=tmp_path / "cli-profiles.json", profiles_root=tmp_path / "cli-profiles",
        )
        self.vault = FakeVault(tmp_path / "vault")
        self.history = PaneAccountHistory(self.db)
        self.ledger = QuotaLedger(db=self.db, totals_provider=lambda *a, **k: {})
        self.service = qf.QuotaFailoverService(self.db, now=self.clock.now)
        self.events: list[dict[str, Any]] = []
        self.owners: dict[str, Any] = {}
        self.activity: dict[str, dict[str, Any]] = {}
        monkeypatch.setattr(app, "cli_profiles_store", self.store)
        monkeypatch.setattr(app, "credential_vault", self.vault)
        monkeypatch.setattr(app, "pane_account_history", self.history)
        monkeypatch.setattr(app, "quota_ledger", self.ledger)
        monkeypatch.setattr(app, "quota_failover", self.service)
        monkeypatch.setattr(app, "_PTY_OWNERS", self.owners)
        monkeypatch.setattr(app, "_pane_activity", self.activity)
        monkeypatch.setattr(app, "attribution", Attribution(app._readers, db=self.db))

        async def record(event: dict[str, Any], *, exclude: Any = None) -> None:
            self.events.append(event)

        monkeypatch.setattr(app, "broadcast", record)
        # The usage poller singleton: start from an empty, disabled state.
        svc = usage_service.service
        monkeypatch.setattr(svc, "account_snapshots", {})
        monkeypatch.setattr(svc, "snapshots", {})
        monkeypatch.setattr(svc, "_agent_epochs", {})
        monkeypatch.setattr(svc, "enabled", True)
        self.usage = svc

    # -- setup helpers --
    def profile(self, agent: str, name: str, *, secret: str | None = "secret", scope: str | None = None) -> str:
        p = self.store.create(agent_key=agent, name=name, scope=scope)
        self.vault.slot_secrets[(agent, p["id"])] = secret
        return str(p["id"])

    def session(self) -> app.Session:
        s = app.Session(FakeWebSocket())  # type: ignore[arg-type]
        s.terminals = FakeTerminals()  # type: ignore[assignment]
        return s

    def pane(self, session: app.Session, term_id: str, agent: str, pane_id: str, *,
             auth_scope: str | None = None, workspace: str = "/ws", pin: str | None = None,
             credential_source: str | None = None, started: float = 0.0) -> SimpleNamespace:
        meta: dict[str, Any] = {"workspace_path": workspace}
        if auth_scope is not None:
            meta["auth_scope"] = auth_scope
        if credential_source is not None:
            meta["credential_source"] = credential_source
        term = SimpleNamespace(id=term_id, pane_id=pane_id, agent_key=agent, closed=False,
                               metadata=meta, cwd=workspace, started_monotonic=started)
        session.terminals.registry[term_id] = term  # type: ignore[attr-defined]
        self.owners[term_id] = session
        if pin is not None:
            self.history.pin(pane_id, pin, ts=self.clock.now() - 100)
        return term

    def exhausted_reading(self, agent: str, slot: str, *, resets_in: float = 3600) -> None:
        self.usage.account_snapshots.setdefault(agent, {})[slot] = snap(
            agent, [window("session", 100, resets_in, now=self.clock.now())],
            fetched_at=self.clock.now(),
        )

    def headroom_reading(self, agent: str, slot: str, used: float = 20, *, fetched_at: float | None = None) -> None:
        at = self.clock.now() if fetched_at is None else fetched_at
        self.usage.account_snapshots.setdefault(agent, {})[slot] = snap(
            agent, [window("session", used, 3600, now=at), window("weekly", used, 86400, now=at)],
            fetched_at=at,
        )

    def report_payload(self, agent: str, pane: str, **over: Any) -> dict[str, Any]:
        base = {"agent_key": agent, "pane_id": pane, "at": iso(self.clock.now()),
                "resets_at": iso(self.clock.now() + 3600), "window_kind": "session",
                "signal": "quota-exhausted", "source": "usage-window",
                "idempotency_key": f"r:{pane}", "workspace_path": "/ws"}
        base.update(over)
        return base

    def events_of(self, kind: str) -> list[dict[str, Any]]:
        return [e for e in self.events if e["type"] == kind]


@pytest.fixture()
def h(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Harness:
    return Harness(tmp_path, monkeypatch)


# ── capability / scope derivation ───────────────────────────────────────────

def test_capabilities_cover_every_registry_vendor_and_fail_closed() -> None:
    from agent_team_backend.cli_vendors.registry import VENDORS

    caps = qf.capabilities()
    assert set(caps) == set(VENDORS)
    for key, cap in caps.items():
        assert cap["switchMode"] in ("hot", "restart", "manual", "unsupported")
        if not cap["supported"]:
            assert cap["switchMode"] == "unsupported", key
    assert caps["claude"]["switchMode"] == "hot"
    assert caps["codex"]["switchMode"] == "restart"
    # No vendor inherits another's behaviour: a key that declares nothing is
    # unsupported (and an unknown key is too, rather than defaulting to any).
    assert qf.capability("no-such-vendor")["supported"] is False
    assert qf.capability("no-such-vendor")["switchMode"] == "unsupported"


def test_auth_scope_is_canonical_for_single_scope_vendors(h: Harness) -> None:
    legacy = {"id": "k1", "agentKey": "kilo"}          # predates the scope field
    explicit = {"id": "k2", "agentKey": "kilo", "scope": "kilo"}
    assert qf.auth_scope_for("kilo", None) == "kilo:kilo"
    assert qf.auth_scope_for("kilo", legacy) == qf.auth_scope_for("kilo", explicit) == "kilo:kilo"
    assert qf.auth_scope_for("codex", None) == "codex"
    assert qf.scope_matches("opencode", "opencode:anthropic")
    assert not qf.scope_matches("opencode:openai", "opencode:anthropic")


def test_pane_provenance_records_credential_source_without_values() -> None:
    plain = qf.pane_auth_scope("claude", None, env={"PATH": "/bin"})
    assert plain["credentialSource"] == "vault" and plain["credentialEnv"] == []
    shadowed = qf.pane_auth_scope("claude", None, env={"CLAUDE_CODE_OAUTH_TOKEN": "sk-secret"})
    assert shadowed["credentialSource"] == "env-override"
    assert shadowed["credentialEnv"] == ["CLAUDE_CODE_OAUTH_TOKEN"]
    assert "sk-secret" not in json.dumps(shadowed)
    removed = qf.pane_auth_scope(
        "claude", None, env={"CLAUDE_CODE_OAUTH_TOKEN": "x"}, env_remove=["CLAUDE_CODE_OAUTH_TOKEN"],
    )
    assert removed["credentialSource"] == "vault"
    portable = qf.pane_auth_scope("claude", None, env={}, portable_slot_id="p1")
    assert portable["credentialSource"] == "portable"


# ── candidate ranking (pure) ────────────────────────────────────────────────

def test_ranking_tiers_and_exclusions() -> None:
    snapshots = {
        "fresh": snap("codex", [window("session", 30, 3600), window("weekly", 50, 86400)]),
        "stale": snap("codex", [window("session", 10, 3600)], fetched_at=NOW - 3 * 3600),
        "reset": snap("codex", [window("session", 100, -60)], fetched_at=NOW - 7200),
        "nodata": None,
        "spent": snap("codex", [window("session", 100, 1800)]),
        "future": snap("codex", [window("session", 5, 3600)], fetched_at=NOW + 3600),
        "signed-out": snap("codex", [window("session", 1, 3600)]),
        "current": snap("codex", [window("session", 1, 3600)]),
        "tried": snap("codex", [window("session", 1, 3600)]),
    }
    rows = qf.rank_candidates(
        slot_ids=list(snapshots), current_slot_id="current", snapshots=snapshots,
        login_states={"signed-out": "signed-out"}, tried={"tried"}, now=NOW,
    )
    eligible = [(r["slotId"], r["tier"]) for r in rows if r["excluded"] is None]
    assert eligible == [
        ("fresh", "fresh-headroom"), ("reset", "reset-expected"), ("stale", "stale-headroom"),
        ("future", "unknown"), ("nodata", "unknown"),
    ]
    excluded = {r["slotId"]: r["excluded"] for r in rows if r["excluded"] is not None}
    assert excluded == {"spent": "exhausted", "signed-out": "signed-out",
                        "current": "current", "tried": "tried"}


def test_weekly_exhaustion_vetoes_even_when_the_session_window_reset() -> None:
    weekly_spent = snap("codex", [window("session", 100, -60), window("weekly", 100, 5 * 86400)])
    rows = qf.rank_candidates(
        slot_ids=["a"], current_slot_id="cur", snapshots={"a": weekly_spent},
        login_states={}, tried=set(), now=NOW,
    )
    assert rows[0]["excluded"] == "exhausted"


def test_promotional_per_model_window_never_vetoes_alone() -> None:
    promo = snap("claude", [window("session", 20, 3600), window("weekly", 20, 86400), window("weekly-model", 100, 86400)])
    rows = qf.rank_candidates(
        slot_ids=["a"], current_slot_id="cur", snapshots={"a": promo},
        login_states={}, tried=set(), now=NOW,
    )
    assert rows[0]["excluded"] is None and rows[0]["tier"] == "fresh-headroom"


def test_ledger_veto_beats_an_older_snapshot_whose_reset_passed() -> None:
    # Snapshot says the spent session window reset; the ledger holds a newer
    # weekly exhaustion whose reset is days away. The old snapshot must not
    # lift the hard veto.
    old = snap("codex", [window("session", 100, -60)], fetched_at=NOW - 7200)
    rows = qf.rank_candidates(
        slot_ids=["a"], current_slot_id="cur", snapshots={"a": old},
        login_states={}, tried=set(), now=NOW, ledger_vetoes={"a"},
    )
    assert rows[0]["excluded"] == "exhausted"


def test_unknown_login_and_unknown_quota_are_different_unknowns() -> None:
    rows = qf.rank_candidates(
        slot_ids=["ok-unknown", "expired-unknown", "pending-unknown"], current_slot_id="cur",
        snapshots={}, login_states={"expired-unknown": "expired", "pending-unknown": "login-pending"},
        tried=set(), now=NOW,
    )
    by = {r["slotId"]: r for r in rows}
    assert by["ok-unknown"]["excluded"] is None and by["ok-unknown"]["tier"] == "unknown"
    assert by["expired-unknown"]["excluded"] == "expired"
    assert by["pending-unknown"]["excluded"] == "login-pending"


def test_same_tier_orders_by_weakest_headroom_then_freshness_then_id() -> None:
    a = snap("codex", [window("session", 40, 3600), window("weekly", 90, 86400)])
    b = snap("codex", [window("session", 40, 3600), window("weekly", 70, 86400)])
    c = snap("codex", [window("session", 40, 3600), window("weekly", 70, 86400)], fetched_at=NOW - 60)
    rows = qf.rank_candidates(
        slot_ids=["a", "b", "c"], current_slot_id="cur", snapshots={"a": a, "b": b, "c": c},
        login_states={}, tried=set(), now=NOW,
    )
    assert [r["slotId"] for r in rows] == ["b", "c", "a"]


# ── policy / budget persistence ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_policy_defaults_to_notify_and_persists_across_restart(h: Harness) -> None:
    assert h.service.policy_mode() == "notify"
    await h.service.set_policy("auto")
    again = qf.QuotaFailoverService(h.db, now=h.clock.now)
    assert again.policy_mode() == "auto"
    with pytest.raises(qf.FailoverRefused):
        await h.service.set_policy("sometimes")


@pytest.mark.asyncio
async def test_budget_counts_only_actual_automatic_swaps_and_survives_restart(h: Harness) -> None:
    await h.service.set_policy("auto")
    incident = qf.Incident(agent_key="codex", auth_scope="codex", outgoing_slot_id="__default__",
                           epoch=0, now=NOW, trusted=True, attribution="pane-history",
                           resets_at=None, window_kind=None, auto_allowed=True)
    h.service.incidents[incident.id] = incident

    def tx(state: str, swapped: bool, automatic: bool = True, at: float = NOW) -> qf.Transaction:
        t = qf.Transaction(incident=incident, agent_key="codex", auth_scope="codex",
                           from_slot_id="__default__", to_slot_id="p", automatic=automatic,
                           idempotency_key=f"k{at}{state}{swapped}", switch_mode="restart",
                           restart_strategy="resume", epoch=0, now=at)
        t.state, t.swapped, t.committed_at = state, swapped, at
        return t

    h.service.store.record(tx("committed", True, at=NOW - 100), now=NOW)
    h.service.store.record(tx("partial", True, at=NOW - 50), now=NOW)       # metadata failed: still counts
    h.service.store.record(tx("cancelled", False, at=NOW - 40), now=NOW)   # refused: never counts
    h.service.store.record(tx("failed", False, at=NOW - 30), now=NOW)      # swap failed: never counts
    h.service.store.record(tx("committed", True, automatic=False, at=NOW - 20), now=NOW)  # manual: separate
    budget = h.service.budget("codex", "codex")
    assert budget["used"] == 2 and budget["limit"] == 3
    # 10-minute spacing after the last automatic swap.
    assert qf._parse_iso(budget["nextAllowedAt"]) == pytest.approx(NOW - 50 + 600)
    h.service.store.record(tx("committed", True, at=NOW - 10), now=NOW)
    budget = h.service.budget("codex", "codex")
    assert budget["used"] == 3
    # Window ceiling: next allowed when the oldest of the three ages out.
    assert qf._parse_iso(budget["nextAllowedAt"]) == pytest.approx(NOW - 100 + 5 * 3600)
    # A backend restart reads the same rows.
    again = qf.QuotaFailoverService(h.db, now=h.clock.now)
    assert again.budget("codex", "codex")["used"] == 3


@pytest.mark.asyncio
async def test_a_durable_intent_row_counts_until_reconciled(h: Harness) -> None:
    incident = qf.Incident(agent_key="codex", auth_scope="codex", outgoing_slot_id="__default__",
                           epoch=0, now=NOW, trusted=True, attribution="pane-history",
                           resets_at=None, window_kind=None, auto_allowed=True)
    t = qf.Transaction(incident=incident, agent_key="codex", auth_scope="codex",
                       from_slot_id="__default__", to_slot_id="p", automatic=True,
                       idempotency_key="k", switch_mode="restart", restart_strategy="resume",
                       epoch=0, now=NOW)
    t.state = "swapping"
    h.service.store.record(t, now=NOW)
    assert h.service.budget("codex", "codex")["used"] == 1


# ── reports → incidents ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_report_refuses_signals_that_are_not_quota_exhaustion(h: Harness) -> None:
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.report(h.report_payload("codex", "pane-1", signal="rate-limited"))
    assert err.value.code == "BAD_SIGNAL"


@pytest.mark.asyncio
async def test_report_without_pane_attribution_only_notifies(h: Harness) -> None:
    await h.service.set_policy("auto")
    h.profile("codex", "B")
    incident, created = await h.service.report(h.report_payload("codex", "pane-unknown"))
    assert created and incident.attribution == "unknown" and incident.trusted is False
    assert incident.auto_allowed is False and incident.transaction_ids == []
    assert h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_report_is_untrusted_when_the_backend_snapshot_disagrees(h: Harness) -> None:
    await h.service.set_policy("auto")
    s = h.session()
    h.pane(s, "t1", "codex", "pane-1", pin="__default__")
    h.headroom_reading("codex", "__default__")
    incident, _ = await h.service.report(h.report_payload("codex", "pane-1"))
    assert incident.trusted is False and incident.reason == "usage-window-disagrees"
    assert h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_cli_text_report_needs_a_declared_detector(h: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    await h.service.set_policy("auto")
    s = h.session()
    h.pane(s, "t1", "codex", "pane-1", pin="__default__")
    incident, _ = await h.service.report(h.report_payload(
        "codex", "pane-1", source="cli-text", text="You've hit your usage limit",
    ))
    assert incident.trusted is False and incident.reason == "no-declared-detector"
    # With a vendor-declared pattern the same text is evidence.
    monkeypatch.setattr(qf, "quota_text_patterns", lambda key: [__import__("re").compile("usage limit")])
    h.service.incidents.clear()
    incident, _ = await h.service.report(h.report_payload(
        "codex", "pane-1", source="cli-text", text="You've hit your usage limit", idempotency_key="r2",
    ))
    assert incident.trusted is True


@pytest.mark.asyncio
async def test_non_quota_signals_are_classified_and_never_open_an_incident(h: Harness) -> None:
    for signal in ("rate-limited", "auth-expired", "payment", "network", "context-full"):
        with pytest.raises(qf.FailoverRefused) as err:
            await h.service.report(h.report_payload("codex", "pane-1", signal=signal))
        assert err.value.code == "BAD_SIGNAL"
        assert err.value.details["classified"] == signal
        assert err.value.details["action"] == "notify-only"
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.report(h.report_payload("codex", "pane-1", signal="whatever"))
    assert err.value.details["classified"] == "unknown"
    assert h.service.incidents == {} and h.vault.switch_calls == []


def _recorded_turn_end(h: Harness, pane_id: str, detail: str, *, age_s: float = 1.0,
                       started_offset_s: float = 5.0) -> None:
    import time as _time

    now = _time.monotonic()
    h.activity[pane_id] = {
        "event_type": "turn_complete", "text": "", "ts_monotonic": now - age_s,
        "turn_started_monotonic": now - age_s - started_offset_s, "detail": detail,
    }


@pytest.mark.asyncio
async def test_structured_report_is_verified_against_the_panes_own_recorded_turn_end(
    h: Harness, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import re as _re

    monkeypatch.setattr(qf, "quota_text_patterns",
                        lambda key: [_re.compile(r"^model_usage_exhausted$")] if key == "codex" else [])
    s = h.session()
    h.pane(s, "t1", "codex", "pane-1", pin="__default__", auth_scope="codex")
    h.pane(s, "t2", "codex", "pane-2", pin="__default__", auth_scope="codex")
    # The renderer's payload text is NOT the evidence — only what the reader
    # recorded for that pane is. No recorded turn end: untrusted.
    incident, _ = await h.service.report(h.report_payload(
        "codex", "pane-1", source="structured", text="model_usage_exhausted",
    ))
    assert incident.trusted is False and incident.reason == "no-recorded-turn-end"
    h.service.incidents.clear()
    # A recorded turn end with a non-quota reason: untrusted (classified apart).
    _recorded_turn_end(h, "pane-1", "model_authentication_failed")
    incident, _ = await h.service.report(h.report_payload(
        "codex", "pane-1", source="structured", idempotency_key="r2",
    ))
    assert incident.trusted is False and incident.reason == "detail-did-not-match"
    h.service.incidents.clear()
    # The right pane, the right reason: trusted.
    _recorded_turn_end(h, "pane-1", "model_usage_exhausted")
    incident, _ = await h.service.report(h.report_payload(
        "codex", "pane-1", source="structured", idempotency_key="r3",
    ))
    assert incident.trusted is True
    # Another pane pointing at pane-1's evidence gets nothing: the check is
    # per reported pane.
    h.service.incidents.clear()
    incident, _ = await h.service.report(h.report_payload(
        "codex", "pane-2", source="structured", idempotency_key="r4",
    ))
    assert incident.trusted is False and incident.reason == "no-recorded-turn-end"
    # A turn end far older than the report is not this exhaustion.
    h.service.incidents.clear()
    _recorded_turn_end(h, "pane-1", "model_usage_exhausted", age_s=qf.STRUCTURED_MATCH_WINDOW_S + 60)
    incident, _ = await h.service.report(h.report_payload(
        "codex", "pane-1", source="structured", idempotency_key="r5",
    ))
    assert incident.trusted is False and incident.reason == "turn-end-too-old"
    # A turn end recorded before the pool's last swap is the old account's.
    h.service.incidents.clear()
    _recorded_turn_end(h, "pane-1", "model_usage_exhausted", age_s=1.0)
    import time as _time
    h.service._last_commit_monotonic["codex"] = _time.monotonic()
    incident, _ = await h.service.report(h.report_payload(
        "codex", "pane-1", source="structured", idempotency_key="r6",
    ))
    assert incident.trusted is False and incident.reason == "structured-stale-epoch"


@pytest.mark.asyncio
async def test_report_attributes_to_the_account_pinned_at_that_time_not_todays_default(h: Harness) -> None:
    b = h.profile("codex", "B")
    s = h.session()
    # The pane ran on B when it saw the message; the default moved to A after.
    h.pane(s, "t1", "codex", "pane-1", pin=b)
    a = h.profile("codex", "A")
    h.store.set_default("codex", a)
    h.exhausted_reading("codex", b)
    incident, _ = await h.service.report(h.report_payload("codex", "pane-1"))
    assert incident.outgoing_slot_id == b
    assert incident.trusted is True


@pytest.mark.asyncio
async def test_same_exhaustion_from_two_windows_is_one_incident(h: Harness) -> None:
    s1, s2 = h.session(), h.session()
    h.pane(s1, "t1", "codex", "pane-1", pin="__default__")
    h.pane(s2, "t2", "codex", "pane-2", pin="__default__", workspace="/other")
    h.exhausted_reading("codex", "__default__")
    first, created1 = await h.service.report(h.report_payload("codex", "pane-1"))
    second, created2 = await h.service.report(h.report_payload("codex", "pane-2"))
    assert created1 and not created2 and first is second
    assert set(first.panes) == {"pane-1", "pane-2"}
    # Replaying the same idempotency key changes nothing.
    again, created3 = await h.service.report(h.report_payload("codex", "pane-1"))
    assert again is first and not created3
    assert len([i for i in h.service.incidents.values() if i.open]) == 1


@pytest.mark.asyncio
async def test_report_stamps_the_quota_ledger_like_tokens_quota_exhausted(h: Harness) -> None:
    s = h.session()
    h.pane(s, "t1", "codex", "pane-1", pin="__default__")
    h.exhausted_reading("codex", "__default__")
    h.ledger.observe("codex", "__default__", h.usage.account_snapshots["codex"]["__default__"])
    await h.service.report(h.report_payload("codex", "pane-1"))
    cycles = h.ledger.cycles("codex", "__default__", now=h.clock.now())
    assert cycles and cycles[0]["exhausted_at"] is not None


# ── automatic hot switch (claude) ───────────────────────────────────────────

async def _claude_two_accounts(h: Harness) -> str:
    h.vault.slot_secrets[("claude", "__default__")] = CLAUDE_SECRET
    b = h.profile("claude", "B", secret=CLAUDE_SECRET)
    return b


@pytest.mark.asyncio
async def test_auto_hot_switch_swaps_once_across_windows_and_counts_budget(h: Harness) -> None:
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)
    s1, s2 = h.session(), h.session()
    h.pane(s1, "t1", "claude", "pane-1", pin="__default__", auth_scope="claude")
    h.pane(s2, "t2", "claude", "pane-2", pin="__default__", auth_scope="claude")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    await h.service.report(h.report_payload("claude", "pane-2"))
    assert h.vault.switch_calls == [("claude", "__default__", b, None)], [(t.state, t.reason, t.error) for t in h.service.transactions.values()]
    assert h.store.list()["defaults"]["claude"] == b
    assert incident.state == "settling" and incident.tried == {b}
    tx = h.service.transactions[incident.transaction_ids[0]]
    assert tx.state == "committed" and tx.swapped and tx.automatic and tx.switch_mode == "hot"
    assert tx.epoch_after == 1 and h.service.epoch("claude") == 1
    # Hot: listed for evidence, never restarted.
    assert {p["paneId"] for p in tx.panes.values()} == {"pane-1", "pane-2"}
    commit = h.events_of("quota_failover.commit")
    assert len(commit) == 1 and commit[0]["payload"]["switchMode"] == "hot"
    assert commit[0]["payload"]["restartStrategy"] == "none"
    state = h.service.state()
    assert state["budget"]["claude"]["used"] == 1
    assert [t["id"] for t in state["transactions"]] == [tx.id]
    # The usage poller was told inside the lock and asked for a fresh read.
    assert h.usage._active_claude_slot == b
    assert h.usage.account_snapshots["claude"][b].get("refreshPending") is True
    assert h.events_of("cli_profiles.changed")[-1]["payload"]["forced"] is False


@pytest.mark.asyncio
async def test_notify_policy_never_switches(h: Harness) -> None:
    b = await _claude_two_accounts(h)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    assert incident.state == "detected" and incident.auto_allowed and incident.transaction_ids == []
    assert h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_client_cannot_authorise_automatic_without_the_persisted_policy(h: Harness) -> None:
    b = await _claude_two_accounts(h)
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.begin_switch({
            "agent_key": "claude", "to_slot_id": b, "expected_current_slot_id": "__default__",
            "expected_epoch": 0, "idempotency_key": "k", "automatic": True,
        })
    assert err.value.code == "AUTO_DISABLED" and h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_auto_stops_with_no_candidate_and_never_tries_a_second_one(h: Harness) -> None:
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__")
    h.exhausted_reading("claude", "__default__")
    h.exhausted_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    assert incident.state == "notify-stopped" and incident.reason == "no-candidate"
    assert h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_auto_refuses_a_target_that_cannot_sign_in(h: Harness) -> None:
    await h.service.set_policy("auto")
    h.vault.slot_secrets[("claude", "__default__")] = CLAUDE_SECRET
    dead = h.profile("claude", "Dead", secret=None)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", dead)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    assert incident.state == "notify-stopped" and incident.reason == "no-candidate"
    assert h.vault.switch_calls == []
    # Direct request naming it is refused too — the ranking excludes it.
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.begin_switch({
            "agent_key": "claude", "to_slot_id": dead, "incident_id": incident.id,
            "expected_current_slot_id": "__default__", "expected_epoch": 0,
            "idempotency_key": "k", "automatic": False,
        })
    assert err.value.code == "CANDIDATE_EXCLUDED" and err.value.details["excluded"] == "signed-out"


@pytest.mark.asyncio
async def test_auto_budget_refuses_the_fourth_swap_and_the_ten_minute_gap(h: Harness) -> None:
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)
    for i in range(3):
        stub = qf.Incident(agent_key="claude", auth_scope="claude", outgoing_slot_id="x",
                           epoch=0, now=NOW, trusted=True, attribution="pane-history",
                           resets_at=None, window_kind=None, auto_allowed=True)
        t = qf.Transaction(incident=stub, agent_key="claude", auth_scope="claude",
                           from_slot_id="x", to_slot_id="y", automatic=True,
                           idempotency_key=f"old{i}", switch_mode="hot", restart_strategy="none",
                           epoch=0, now=NOW)
        t.state, t.swapped, t.committed_at = "committed", True, NOW - 3600 - i * 700
        h.service.store.record(t, now=NOW)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    assert incident.state == "notify-stopped" and incident.reason == "auto_budget_exhausted"
    assert h.vault.switch_calls == []
    # Manual switching is independent of the automatic budget.
    tx = await h.service.begin_switch({
        "agent_key": "claude", "to_slot_id": b, "expected_current_slot_id": "__default__",
        "expected_epoch": 0, "idempotency_key": "manual", "automatic": False,
    })
    assert tx.state == "committed" and len(h.vault.switch_calls) == 1


@pytest.mark.asyncio
async def test_swap_failure_stops_the_run_and_counts_nothing(h: Harness) -> None:
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)
    h.vault.fail_switch = True
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    tx = h.service.transactions[incident.transaction_ids[0]]
    assert tx.state == "failed" and tx.reason == "swap-failed" and not tx.swapped
    assert incident.state == "notify-stopped" and incident.reason == "swap-failed"
    assert h.service.budget("claude", "claude")["used"] == 0
    assert h.store.list()["defaults"]["claude"] is None


@pytest.mark.asyncio
async def test_a_credential_store_the_vault_cannot_account_for_stops_without_retry(h: Harness) -> None:
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)
    real_switch = h.vault.switch

    def refuse(*args: Any, **kwargs: Any) -> None:
        h.vault.switch_calls.append(args[:3] + (kwargs.get("scope"),))
        raise RuntimeError("copilot stores its token in plaintext (storeTokenPlaintext); refusing")

    h.vault.switch = refuse  # type: ignore[method-assign]
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__", auth_scope="claude")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    tx = h.service.transactions[incident.transaction_ids[0]]
    assert tx.state == "failed" and tx.reason == "credential-source-unknown" and not tx.swapped
    assert incident.state == "notify-stopped" and incident.reason == "credential-source-unknown"
    assert h.service.budget("claude", "claude")["used"] == 0
    assert len(h.vault.switch_calls) == 1  # no second attempt
    h.vault.switch = real_switch  # type: ignore[method-assign]


@pytest.mark.asyncio
async def test_metadata_failure_after_the_swap_is_partial_visible_and_counted(
    h: Harness, monkeypatch: pytest.MonkeyPatch,
) -> None:
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)

    def boom(agent_key: str, profile_id: str | None) -> dict:
        raise RuntimeError("disk full")

    monkeypatch.setattr(h.store, "set_default", boom)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    tx = h.service.transactions[incident.transaction_ids[0]]
    assert tx.state == "partial" and tx.swapped and tx.reason == "default-persist-failed"
    assert tx.live_identity == {"email": "live@example.com", "signedIn": True}
    assert h.service.budget("claude", "claude")["used"] == 1
    assert h.events_of("quota_failover.commit")[0]["payload"]["state"] == "partial"


@pytest.mark.asyncio
async def test_a_partial_swap_blocks_every_switch_until_reconciled(
    h: Harness, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Data-loss guard: after vault.switch(A -> B) succeeded but the default
    could not be persisted, live is B while the store still says A. A later
    switch reading the store's A as "current" would capture B's live
    credentials INTO A's slot and destroy A's. Both routes must refuse until
    the user reconciles; reconciling moves no credential."""
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)
    real_set_default = h.store.set_default
    fail = {"on": True}

    def flaky(agent_key: str, profile_id: str | None) -> dict:
        if fail["on"]:
            raise RuntimeError("disk full")
        return real_set_default(agent_key, profile_id)

    monkeypatch.setattr(h.store, "set_default", flaky)
    s = h.session()
    term = h.pane(s, "t1", "claude", "pane-1", pin="__default__", auth_scope="claude", credential_source="vault")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    tx = h.service.transactions[incident.transaction_ids[0]]
    assert tx.state == "partial" and tx.reason == "default-persist-failed"
    assert h.history.profile_at("pane-1", h.clock.now()) == "__default__"
    assert h.store.list()["defaults"]["claude"] is None            # store: A
    assert h.vault.switch_calls == [("claude", "__default__", b, None)]  # live: B
    pending = h.service.state()["unreconciled"]["claude"]
    assert pending["transactionId"] == tx.id and pending["liveSlotId"] == b
    # The failover route refuses to guess "current".
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.begin_switch({
            "agent_key": "claude", "to_slot_id": b, "expected_current_slot_id": "__default__",
            "expected_epoch": 1, "idempotency_key": "again", "automatic": False,
        })
    assert err.value.code == "UNRECONCILED_STATE"
    # So does the legacy manual route — with the same code and details.
    monkeypatch.setattr(ws_handlers, "_switch_history", {})
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": b})
    assert not got["ok"] and got["error"]["code"] == "UNRECONCILED_STATE"
    assert len(h.vault.switch_calls) == 1  # A's slot was never overwritten
    # A backend restart still knows.
    again = qf.QuotaFailoverService(h.db, now=h.clock.now)
    assert again.unreconciled("claude")["transactionId"] == tx.id
    # Manual recovery: persist the default that matches the live account. A
    # client naming another account is refused without any change.
    fail["on"] = False
    got = await _call(s, "quota_failover.reconcile", {"agent_key": "claude", "transaction_id": tx.id,
                                                      "live_slot_id": "__default__"})
    assert not got["ok"] and got["error"]["code"] == "BAD_REQUEST"
    assert h.store.list()["defaults"]["claude"] is None and h.service.unreconciled("claude")
    got = await _call(s, "quota_failover.reconcile", {"agent_key": "claude", "transaction_id": tx.id})
    assert got["ok"] and got["payload"]["liveSlotId"] == b
    assert got["payload"]["hotSwitchedPanes"] == [{"paneId": "pane-1", "termId": "t1", "profileId": b}]
    assert h.history.profile_at("pane-1", h.clock.now()) == b
    assert term.metadata["launch_profile_id"] == b
    assert h.store.list()["defaults"]["claude"] == b
    assert h.service.unreconciled("claude") is None
    assert len(h.vault.switch_calls) == 1  # reconciling moved nothing
    assert qf.QuotaFailoverService(h.db, now=h.clock.now).unreconciled("claude") is None
    # Switching works again, from the right "current".
    tx2 = await h.service.begin_switch({
        "agent_key": "claude", "to_slot_id": "__default__", "expected_current_slot_id": b,
        "expected_epoch": h.service.epoch("claude"), "idempotency_key": "back", "automatic": False,
    })
    assert tx2.state == "committed" and h.vault.switch_calls[-1] == ("claude", b, "__default__", None)


@pytest.mark.asyncio
async def test_an_interrupted_swap_needs_the_live_slot_named_to_reconcile(h: Harness) -> None:
    incident = qf.Incident(agent_key="codex", auth_scope="codex", outgoing_slot_id="__default__",
                           epoch=0, now=NOW, trusted=True, attribution="pane-history",
                           resets_at=None, window_kind=None, auto_allowed=True)
    t = qf.Transaction(incident=incident, agent_key="codex", auth_scope="codex",
                       from_slot_id="__default__", to_slot_id="p", automatic=True,
                       idempotency_key="k", switch_mode="restart", restart_strategy="resume",
                       epoch=0, now=NOW)
    t.state = "swapping"
    h.service.store.record(t, now=NOW)  # the process died right after this
    svc = qf.QuotaFailoverService(h.db, now=h.clock.now)
    pending = svc.unreconciled("codex")
    assert pending and pending["liveSlotId"] is None and pending["reason"] == "interrupted-swap"
    with pytest.raises(qf.FailoverRefused) as err:
        await svc.reconcile("codex", t.id)
    assert err.value.code == "BAD_REQUEST"
    p = h.profile("codex", "P")
    c = h.profile("codex", "C")
    # A third account is never a valid answer — no mutation.
    with pytest.raises(qf.FailoverRefused) as err:
        await svc.reconcile("codex", t.id, c)
    assert err.value.code == "BAD_REQUEST" and h.store.list()["defaults"]["codex"] is None
    assert svc.unreconciled("codex") is not None
    # The swap moved between __default__ and "p"; "p" is not a known profile id
    # in this store, so the record's own toSlotId must be re-pointed to a real one.
    svc._unreconciled["codex"]["toSlotId"] = p
    await svc.reconcile("codex", t.id, p)
    assert h.store.list()["defaults"]["codex"] == p and svc.unreconciled("codex") is None


@pytest.mark.asyncio
async def test_changed_events_carry_the_final_incident_state(h: Harness) -> None:
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__", auth_scope="claude")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    h.events.clear()
    h.clock.advance(5)
    h.service.observe_usage("claude", b, snap("claude", [window("session", 12, 3600, now=h.clock.now()), window("weekly", 12, 86400, now=h.clock.now())], fetched_at=h.clock.now()))
    await asyncio.sleep(0.01)  # observe_usage schedules the broadcast
    changed = h.events_of("quota_failover.changed")
    assert changed, "closing an incident must announce it"
    state = changed[-1]["payload"]
    assert state["incidents"] == []
    final = [i for i in state["recentIncidents"] if i["id"] == incident.id]
    assert final and final[0]["state"] == "ready" and final[0]["reason"] == "quota-confirmed"
    assert final[0]["closedAt"] is not None
    # And the committed transaction a switch-back needs is still there.
    tx = [t for t in state["recentTransactions"] if t["incidentId"] == incident.id]
    assert tx and tx[0]["fromSlotId"] == "__default__" and tx[0]["toSlotId"] == b and tx[0]["epochAfter"] == 1
    # Retention: it ages out after a day.
    h.clock.advance(qf.RECENT_RETENTION_S + 1)
    assert h.service.state()["recentIncidents"] == []


@pytest.mark.asyncio
async def test_audit_write_failure_pauses_automatic_switching(h: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)
    real_record = h.service.store.record
    calls = {"n": 0}

    def flaky(tx: qf.Transaction, *, now: float) -> None:
        calls["n"] += 1
        if calls["n"] == 2:  # the post-swap write
            raise RuntimeError("db locked")
        real_record(tx, now=now)

    monkeypatch.setattr(h.service.store, "record", flaky)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    tx = h.service.transactions[incident.transaction_ids[0]]
    assert tx.state == "partial" and tx.reason == "audit-write-failed" and tx.swapped
    assert h.service.audit_degraded
    # The intent row still counts, and the next automatic attempt is refused.
    assert h.service.budget("claude", "claude")["used"] == 1
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.begin_switch({
            "agent_key": "claude", "to_slot_id": "__default__", "expected_current_slot_id": b,
            "expected_epoch": 1, "idempotency_key": "k2", "automatic": True,
        }, _internal=True)
    assert err.value.code == "AUTO_BUDGET_UNVERIFIABLE"


@pytest.mark.asyncio
async def test_stale_epoch_and_stale_state_and_force_are_refused(h: Harness) -> None:
    b = await _claude_two_accounts(h)
    base = {"agent_key": "claude", "to_slot_id": b, "idempotency_key": "k", "automatic": False}
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.begin_switch({**base, "expected_current_slot_id": "__default__",
                                      "expected_epoch": 0, "force": True})
    assert err.value.code == "BAD_REQUEST"
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.begin_switch({**base, "expected_current_slot_id": "__default__"})
    assert err.value.code == "BAD_REQUEST"
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.begin_switch({**base, "expected_current_slot_id": "__default__",
                                      "expected_epoch": 7})
    assert err.value.code == "STALE_EPOCH"
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.begin_switch({**base, "expected_current_slot_id": b, "expected_epoch": 0})
    assert err.value.code == "STALE_STATE"
    assert h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_manual_route_cancels_pending_proposals_and_bumps_the_epoch(h: Harness) -> None:
    await h.service.set_policy("auto")
    h.vault.slot_secrets[("codex", "__default__")] = "secret"
    b = h.profile("codex", "B")
    s = h.session()
    h.pane(s, "t1", "codex", "pane-1", pin="__default__", auth_scope="codex")
    h.exhausted_reading("codex", "__default__")
    h.headroom_reading("codex", b)
    incident, _ = await h.service.report(h.report_payload("codex", "pane-1"))
    tx = h.service.transactions[incident.transaction_ids[0]]
    assert tx.state == "preparing" and incident.state == "waiting-safe"
    await h.service.on_manual_switch("codex", b)
    assert tx.state == "cancelled" and tx.reason == "manual-switch"
    assert incident.state == "notify-stopped" and h.service.epoch("codex") == 1
    # An old button (epoch 0) can no longer commit.
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.begin_switch({
            "agent_key": "codex", "to_slot_id": b, "expected_current_slot_id": "__default__",
            "expected_epoch": 0, "idempotency_key": "old-button", "automatic": False,
        })
    assert err.value.code == "STALE_EPOCH"
    assert h.vault.switch_calls == []


# ── restart vendors: prepare → ack → commit ─────────────────────────────────

async def _codex_incident(h: Harness, *, panes: list[tuple[app.Session, str, str]]) -> tuple[qf.Incident, qf.Transaction, str]:
    await h.service.set_policy("auto")
    h.vault.slot_secrets[("codex", "__default__")] = "secret"
    b = h.profile("codex", "B")
    for session, term_id, pane_id in panes:
        h.pane(session, term_id, "codex", pane_id, pin="__default__", auth_scope="codex",
               workspace=f"/ws-{pane_id}")
    h.exhausted_reading("codex", "__default__")
    h.headroom_reading("codex", b)
    incident, _ = await h.service.report(h.report_payload("codex", panes[0][2]))
    tx = h.service.transactions[incident.transaction_ids[0]]
    return incident, tx, b


def _ready(tx_id: str, pane_id: str, session_id: str = "sess-1") -> dict[str, Any]:
    return {"transaction_id": tx_id, "pane_id": pane_id, "ready": True, "idle": "turn-boundary",
            "resume": {"resumable": True, "session_id": session_id}}


def _restarted_pane(h: Harness, owner: app.Session, tx: qf.Transaction,
                    pane_id: str, term_id: str) -> None:
    pane = tx.panes[pane_id]
    term = h.pane(owner, term_id, tx.agent_key, pane_id, auth_scope=tx.auth_scope,
                  workspace=pane["workspacePath"], credential_source="vault",
                  started=tx.committed_monotonic + 0.5)
    term.metadata.update(launch_profile_id=tx.to_slot_id, credential_epoch=tx.epoch_after)
    app.attribution.register_pane(pane_id, vendor=tx.agent_key, cwd=pane["workspacePath"],
                                  explicit_session_id=pane["sessionId"], defer_baseline=True)


@pytest.mark.asyncio
async def test_restart_vendor_collects_every_window_and_commits_only_when_all_ready(h: Harness) -> None:
    s1, s2 = h.session(), h.session()
    incident, tx, b = await _codex_incident(h, panes=[(s1, "t1", "pane-1"), (s2, "t2", "pane-2")])
    assert tx.state == "preparing" and tx.restart_strategy == "resume"
    # Each owner got a prepare naming only its panes; the credentials are untouched.
    prep1 = [m for m in s1.websocket.sent if m["type"] == "quota_failover.prepare"]
    prep2 = [m for m in s2.websocket.sent if m["type"] == "quota_failover.prepare"]
    assert [p["paneId"] for p in prep1[0]["payload"]["panes"]] == ["pane-1"]
    assert [p["paneId"] for p in prep2[0]["payload"]["panes"]] == ["pane-2"]
    assert prep1[0]["payload"]["restartStrategy"] == "resume"
    assert h.vault.switch_calls == []
    await h.service.ack(_ready(tx.id, "pane-1"))
    assert tx.state == "preparing" and h.vault.switch_calls == []
    await h.service.ack(_ready(tx.id, "pane-2", "sess-2"))
    assert tx.state == "committed" and tx.swapped
    assert h.vault.switch_calls == [("codex", "__default__", b, None)]
    commit = h.events_of("quota_failover.commit")[0]["payload"]
    assert {p["paneId"] for p in commit["panes"]} == {"pane-1", "pane-2"}
    assert commit["restartStrategy"] == "resume" and commit["switchMode"] == "restart"
    assert incident.state == "settling"
    assert h.service.state()["budget"]["codex"]["used"] == 1


@pytest.mark.asyncio
async def test_a_busy_pane_parks_the_transaction_instead_of_cancelling_it(h: Harness) -> None:
    s = h.session()
    incident, tx, b = await _codex_incident(h, panes=[(s, "t1", "pane-1"), (s, "t2", "pane-2")])
    await h.service.ack(_ready(tx.id, "pane-1"))
    await h.service.ack({"transaction_id": tx.id, "pane_id": "pane-2", "ready": False, "reason": "busy"})
    assert tx.state == "waiting-safe" and incident.state == "waiting-safe"
    assert h.vault.switch_calls == []
    # Waiting costs no budget and does not retry on a timer; the window
    # re-acks when the pane reaches its turn boundary.
    assert h.service.budget("codex", "codex")["used"] == 0
    await h.service.ack(_ready(tx.id, "pane-2", "sess-2"))
    assert tx.state == "committed" and len(h.vault.switch_calls) == 1


@pytest.mark.asyncio
async def test_readiness_needs_explicit_resume_data(h: Harness) -> None:
    s = h.session()
    incident, tx, _ = await _codex_incident(h, panes=[(s, "t1", "pane-1")])
    await h.service.ack({"transaction_id": tx.id, "pane_id": "pane-1", "ready": True,
                         "idle": "turn-boundary", "resume": {}})
    assert tx.state == "cancelled" and tx.reason == "pane-resume-data-missing"
    assert incident.state == "notify-stopped" and h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_automatic_readiness_needs_a_turn_boundary_not_silence(h: Harness) -> None:
    s = h.session()
    incident, tx, _ = await _codex_incident(h, panes=[(s, "t1", "pane-1")])
    payload = _ready(tx.id, "pane-1")
    payload.pop("idle")
    await h.service.ack(payload)
    assert tx.state == "cancelled" and tx.reason == "pane-idle-unverified"
    assert h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_a_pane_that_cannot_resume_stops_the_run_without_touching_credentials(h: Harness) -> None:
    s = h.session()
    incident, tx, _ = await _codex_incident(h, panes=[(s, "t1", "pane-1"), (s, "t2", "pane-2")])
    await h.service.ack(_ready(tx.id, "pane-1"))
    await h.service.ack({"transaction_id": tx.id, "pane_id": "pane-2", "ready": False,
                         "reason": "not-resumable"})
    assert tx.state == "cancelled" and tx.reason == "pane-not-resumable"
    assert incident.state == "notify-stopped" and h.vault.switch_calls == []
    assert h.service.budget("codex", "codex")["used"] == 0


@pytest.mark.asyncio
async def test_a_pane_spawned_during_prepare_blocks_the_commit(h: Harness) -> None:
    s = h.session()
    incident, tx, _ = await _codex_incident(h, panes=[(s, "t1", "pane-1")])
    h.pane(s, "t-new", "codex", "pane-new", pin="__default__", auth_scope="codex")
    await h.service.ack(_ready(tx.id, "pane-1"))
    assert tx.state == "cancelled" and tx.reason == "new-pane-during-prepare"
    assert h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_a_turn_starting_after_the_ack_blocks_the_commit(h: Harness) -> None:
    s = h.session()
    incident, tx, _ = await _codex_incident(h, panes=[(s, "t1", "pane-1")])
    h.activity["pane-1"] = {"event_type": "agent_active", "text": "", "ts_monotonic": 1.0}
    await h.service.ack(_ready(tx.id, "pane-1"))
    assert tx.state == "cancelled" and tx.reason == "pane-became-busy"
    assert h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_prepare_and_wait_deadlines_stop_the_run(h: Harness) -> None:
    s = h.session()
    incident, tx, _ = await _codex_incident(h, panes=[(s, "t1", "pane-1")])
    await h.service.tick(tx.id)
    assert tx.state == "cancelled" and tx.reason == "prepare-timeout"
    assert incident.state == "notify-stopped" and incident.reason == "prepare-timeout"
    # waiting-safe has its own ceiling
    h.service.incidents.clear(); h.service.transactions.clear(); h.service._idempotency.clear()
    h.vault.switch_calls.clear()
    incident2, tx2, _ = await _codex_incident(h, panes=[(s, "t1", "pane-1")])
    await h.service.ack({"transaction_id": tx2.id, "pane_id": "pane-1", "ready": False, "reason": "busy"})
    assert tx2.state == "waiting-safe"
    await h.service.tick(tx2.id)
    assert tx2.state == "cancelled" and tx2.reason == "wait-timeout"
    assert h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_deadlines_fire_from_the_running_event_loop_without_a_manual_tick(
    h: Harness, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The timers are armed with loop.call_later inside the handlers, so in the
    # real app they fire on their own; this drives one through the loop.
    monkeypatch.setattr(qf, "PREPARE_ACK_DEADLINE_S", 0.05)
    s = h.session()
    incident, tx, _ = await _codex_incident(h, panes=[(s, "t1", "pane-1")])
    assert tx.state == "preparing"
    await asyncio.sleep(0.3)
    assert tx.state == "cancelled" and tx.reason == "prepare-timeout"
    assert incident.state == "notify-stopped"
    # notify-stopped keeps the incident open (later reports of the same
    # exhaustion fold into it); the changed event carries its final reason.
    shown = h.events_of("quota_failover.changed")[-1]["payload"]["incidents"]
    assert [i["reason"] for i in shown if i["id"] == incident.id] == ["prepare-timeout"]
    monkeypatch.setattr(qf, "SETTLE_TIMEOUT_S", 0.05)
    h.service.incidents.clear(); h.service.transactions.clear(); h.service._idempotency.clear()
    h.vault.switch_calls.clear()
    incident2, tx2, _ = await _codex_incident(h, panes=[(s, "t1", "pane-1")])
    await h.service.ack(_ready(tx2.id, "pane-1"))
    assert tx2.state == "committed" and incident2.state == "settling"
    await asyncio.sleep(0.3)
    assert incident2.state == "notify-stopped" and incident2.reason == "quota-unconfirmed"


@pytest.mark.asyncio
async def test_turning_auto_off_withdraws_pending_automatic_proposals(h: Harness) -> None:
    s = h.session()
    incident, tx, _ = await _codex_incident(h, panes=[(s, "t1", "pane-1")])
    await h.service.set_policy("notify")
    assert tx.state == "cancelled" and tx.reason == "policy-changed"
    # A late ack cannot revive it.
    with pytest.raises(qf.FailoverRefused):
        await h.service.ack(_ready(tx.id, "pane-1"))
    assert h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_policy_change_while_waiting_for_the_lock_is_honoured(h: Harness) -> None:
    s = h.session()
    incident, tx, b = await _codex_incident(h, panes=[(s, "t1", "pane-1")])
    lock = h.vault.switch_lock("codex")
    await lock.acquire()
    ack_task = asyncio.create_task(h.service.ack(_ready(tx.id, "pane-1")))
    await asyncio.sleep(0)
    await h.service.set_policy("off")
    lock.release()
    await ack_task
    assert tx.state == "cancelled" and h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_turning_auto_off_while_the_commit_waits_for_the_lock_settles_the_incident(h: Harness) -> None:
    # Reported by the API contract suite: the transaction was cancelled by the
    # policy change but the incident kept saying "switching" with no open
    # transaction — a permanent "switching" badge that swallows later reports.
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__", auth_scope="claude")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    lock = h.vault.switch_lock("claude")
    await lock.acquire()
    report = asyncio.create_task(h.service.report(h.report_payload("claude", "pane-1")))
    for _ in range(200):
        await asyncio.sleep(0.005)
        pending = [t for t in h.service.transactions.values() if t.open]
        if pending:
            break
    assert len(pending) == 1
    await h.service.set_policy("off")
    lock.release()
    incident, _ = await report
    tx = pending[0]
    assert tx.state == "cancelled" and tx.reason == "policy-changed"
    assert incident.state == "notify-stopped" and incident.reason == "policy-changed"
    assert h.vault.switch_calls == [] and h.service.budget("claude", "claude")["used"] == 0
    assert not [t for t in h.service.state()["transactions"]]


@pytest.mark.asyncio
async def test_identity_less_vendors_never_switch_automatically_or_confirm_quota(
    h: Harness, monkeypatch: pytest.MonkeyPatch,
) -> None:
    real = qf.capability

    def opaque(agent_key: str) -> dict[str, Any]:
        cap = real(agent_key)
        if agent_key == "codex":
            cap["hasIdentity"] = False
        return cap

    monkeypatch.setattr(qf, "capability", opaque)
    await h.service.set_policy("auto")
    h.vault.slot_secrets[("codex", "__default__")] = "secret"
    b = h.profile("codex", "B")
    s = h.session()
    h.pane(s, "t1", "codex", "pane-1", pin="__default__", auth_scope="codex")
    h.exhausted_reading("codex", "__default__")
    h.headroom_reading("codex", b)
    incident, _ = await h.service.report(h.report_payload("codex", "pane-1"))
    assert incident.state == "notify-stopped" and incident.reason == "identity-unknown"
    assert h.vault.switch_calls == []
    # Manual is allowed, but a reading can never be presented as confirmed.
    tx = await h.service.begin_switch({
        "agent_key": "codex", "to_slot_id": b, "expected_current_slot_id": "__default__",
        "expected_epoch": 0, "idempotency_key": "m", "automatic": False,
    })
    await h.service.ack(_ready(tx.id, "pane-1"))
    assert tx.state == "committed"
    manual = h.service.incidents[tx.incident_id]
    _restarted_pane(h, s, tx, "pane-1", "t1-new")
    await h.service.settle({"transaction_id": tx.id, "pane_id": "pane-1", "outcome": "resumed",
                            "session_id": "sess-1", "term_id": "t1-new"})
    h.clock.advance(5)
    h.service.observe_usage("codex", b, snap("codex", [window("session", 5, 3600, now=h.clock.now())], fetched_at=h.clock.now()))
    assert manual.state == "settling"
    await h.service.tick(f"settle:{tx.id}")
    assert manual.state == "notify-stopped" and manual.reason == "quota-unconfirmed"


@pytest.mark.asyncio
async def test_auto_never_restarts_a_vendor_that_cannot_resume(h: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    await h.service.set_policy("auto")
    real = qf.capability

    def lossy(agent_key: str) -> dict[str, Any]:
        cap = real(agent_key)
        if agent_key == "codex":
            cap["resume"] = "lossy"
        return cap

    monkeypatch.setattr(qf, "capability", lossy)
    h.vault.slot_secrets[("codex", "__default__")] = "secret"
    b = h.profile("codex", "B")
    s = h.session()
    h.pane(s, "t1", "codex", "pane-1", pin="__default__", auth_scope="codex")
    h.exhausted_reading("codex", "__default__")
    h.headroom_reading("codex", b)
    incident, _ = await h.service.report(h.report_payload("codex", "pane-1"))
    assert incident.state == "notify-stopped" and incident.reason == "no-resume"
    # Manual: allowed, but only after the user confirms the new conversation.
    tx = await h.service.begin_switch({
        "agent_key": "codex", "to_slot_id": b, "expected_current_slot_id": "__default__",
        "expected_epoch": 0, "idempotency_key": "m", "automatic": False,
    })
    assert tx.state == "awaiting-confirmation" and tx.confirmation == "required"
    assert tx.restart_strategy == "new-conversation" and h.vault.switch_calls == []
    await h.service.confirm(tx.id)
    assert tx.state == "preparing" and tx.confirmation == "confirmed"
    await h.service.ack({"transaction_id": tx.id, "pane_id": "pane-1", "ready": True,
                         "resume": {"resumable": False}})
    assert tx.state == "committed"
    assert h.events_of("quota_failover.commit")[-1]["payload"]["restartStrategy"] == "new-conversation"


@pytest.mark.asyncio
async def test_env_credential_panes_refuse_auto_and_are_listed_untouched_for_manual(h: Harness) -> None:
    await h.service.set_policy("auto")
    h.vault.slot_secrets[("codex", "__default__")] = "secret"
    b = h.profile("codex", "B")
    s = h.session()
    h.pane(s, "t1", "codex", "pane-1", pin="__default__", auth_scope="codex")
    h.pane(s, "t2", "codex", "pane-env", pin="__default__", auth_scope="codex",
           credential_source="env-override")
    h.exhausted_reading("codex", "__default__")
    h.headroom_reading("codex", b)
    incident, _ = await h.service.report(h.report_payload("codex", "pane-1"))
    assert incident.state == "notify-stopped" and incident.reason == "credential-override"
    assert h.vault.switch_calls == []
    tx = await h.service.begin_switch({
        "agent_key": "codex", "to_slot_id": b, "expected_current_slot_id": "__default__",
        "expected_epoch": 0, "idempotency_key": "m", "automatic": False,
    })
    assert tx.overridden_panes == ["pane-env"]
    assert set(tx.panes) == {"pane-1"}


@pytest.mark.asyncio
async def test_scope_unknown_panes_stop_a_provider_bound_switch(h: Harness) -> None:
    # A default-launched pane of a multi-provider store may use any provider
    # in the file; nothing observes which, so the run stops rather than guess.
    await h.service.set_policy("auto")
    a = h.profile("opencode", "A", scope="anthropic")
    b = h.profile("opencode", "B", scope="anthropic")
    h.vault.slot_secrets[("opencode", a)] = "sa"
    h.vault.slot_secrets[("opencode", b)] = "sb"
    h.store.set_default("opencode", a)
    s = h.session()
    h.pane(s, "t1", "opencode", "pane-a", pin=a, auth_scope="opencode:anthropic")
    h.pane(s, "t2", "opencode", "pane-default", pin="__default__", auth_scope="opencode")
    h.exhausted_reading("opencode", a)
    h.headroom_reading("opencode", b)
    incident, _ = await h.service.report(h.report_payload("opencode", "pane-a"))
    assert incident.auth_scope == "opencode:anthropic"
    assert incident.state == "notify-stopped" and incident.reason == "pane-scope-unknown"
    assert h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_compound_default_round_trip_keeps_other_providers_and_one_budget(h: Harness) -> None:
    await h.service.set_policy("auto")
    a = h.profile("opencode", "A", scope="anthropic")
    other = h.profile("opencode", "O", scope="openai")
    h.vault.slot_secrets[("opencode", a)] = "sa"
    h.vault.slot_secrets[("opencode", "__default__")] = "sd"
    h.vault.slot_secrets[("opencode", other)] = "so"
    s = h.session()
    h.pane(s, "t-o", "opencode", "pane-openai", pin=other, auth_scope="opencode:openai")
    # default -> A (the default takes A's provider)
    tx1 = await h.service.begin_switch({
        "agent_key": "opencode", "to_slot_id": a, "expected_current_slot_id": "__default__",
        "expected_epoch": 0, "idempotency_key": "k1", "automatic": False,
    })
    assert tx1.auth_scope == "opencode:anthropic" and tx1.state == "committed"
    assert h.vault.switch_calls[-1] == ("opencode", "__default__", a, "anthropic")
    # The openai pane was never part of it.
    assert tx1.panes == {} and tx1.overridden_panes == []
    # A -> a profile on another provider is a different pool.
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.begin_switch({
            "agent_key": "opencode", "to_slot_id": other, "expected_current_slot_id": a,
            "expected_epoch": 1, "idempotency_key": "k3", "automatic": False,
        })
    assert err.value.code == "SCOPE_MISMATCH"
    # A -> default
    tx2 = await h.service.begin_switch({
        "agent_key": "opencode", "to_slot_id": "__default__", "expected_current_slot_id": a,
        "expected_epoch": 1, "idempotency_key": "k2", "automatic": False,
    })
    assert tx2.auth_scope == "opencode:anthropic"
    assert h.vault.switch_calls[-1] == ("opencode", a, "__default__", "anthropic")
    assert len(h.vault.switch_calls) == 2
    budget = h.service.state()["budget"]
    assert "opencode:anthropic" in budget and budget["opencode:anthropic"]["used"] == 0  # manual


@pytest.mark.asyncio
async def test_kilo_legacy_and_explicit_profiles_share_one_pool_and_one_budget(h: Harness) -> None:
    await h.service.set_policy("auto")
    h.vault.slot_secrets[("kilo", "__default__")] = "sd"
    b = h.profile("kilo", "B")  # scope defaulted to the single declared one
    s = h.session()
    h.pane(s, "t1", "kilo", "pane-1", pin="__default__", auth_scope="kilo:kilo")
    h.exhausted_reading("kilo", "__default__")
    h.headroom_reading("kilo", b)
    h.usage.account_snapshots["kilo"]["__default__"]["windows"] = [{"kind": "credits", "balance": 0}]
    h.usage.account_snapshots["kilo"][b]["windows"] = [{"kind": "credits", "balance": 10}]
    incident, _ = await h.service.report(h.report_payload("kilo", "pane-1"))
    assert incident.auth_scope == "kilo:kilo"
    tx = h.service.transactions[incident.transaction_ids[0]]
    await h.service.ack(_ready(tx.id, "pane-1"))
    assert tx.state == "committed", (tx.reason, tx.error)
    assert h.vault.switch_calls == [("kilo", "__default__", b, "kilo")]
    assert h.service.state()["budget"]["kilo:kilo"]["used"] == 1


# ── settling ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_settling_needs_a_positive_reading_of_the_target_after_the_commit(h: Harness) -> None:
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__", auth_scope="claude")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    tx = h.service.transactions[incident.transaction_ids[0]]
    assert incident.state == "settling"
    # A reading from before the commit, however fresh it looks, is not evidence.
    h.service.observe_usage("claude", b, snap("claude", [window("session", 10, 3600)], fetched_at=tx.committed_at - 1))
    assert incident.state == "settling"
    # Empty windows prove nothing.
    h.clock.advance(5)
    h.service.observe_usage("claude", b, snap("claude", [], fetched_at=h.clock.now()))
    assert incident.state == "settling"
    # A reading of another slot proves nothing.
    h.service.observe_usage("claude", "__default__", snap("claude", [window("session", 1, 3600)], fetched_at=h.clock.now()))
    assert incident.state == "settling"
    # A positive, fresh reading of the target settles it.
    h.service.observe_usage("claude", b, snap("claude", [window("session", 12, 3600, now=h.clock.now()), window("weekly", 12, 86400, now=h.clock.now())], fetched_at=h.clock.now()))
    assert incident.state == "ready" and incident.reason == "quota-confirmed"
    assert tx.closed_at is not None


@pytest.mark.asyncio
async def test_target_exhausted_after_the_switch_stops_the_run(h: Harness) -> None:
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__", auth_scope="claude")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    h.clock.advance(5)
    h.service.observe_usage("claude", b, snap("claude", [window("session", 100, 3600, now=h.clock.now())], fetched_at=h.clock.now()))
    assert incident.state == "notify-stopped" and incident.reason == "target-exhausted"
    # The new account also running out is the same run, not a fresh one: the
    # report on B chains, the tried set carries over and nothing switches back.
    h.pane(s, "t2", "claude", "pane-2", pin=b, auth_scope="claude")
    h.exhausted_reading("claude", b)
    chained, created = await h.service.report(h.report_payload("claude", "pane-2"))
    assert created and chained is not incident
    assert chained.state == "notify-stopped" and chained.reason == "chained-exhaustion"
    assert chained.tried >= {"__default__", b} and chained.auto_allowed is False
    assert len(h.vault.switch_calls) == 1


@pytest.mark.asyncio
async def test_settle_timeout_reports_switched_but_unconfirmed(h: Harness) -> None:
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__", auth_scope="claude")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    tx = h.service.transactions[incident.transaction_ids[0]]
    await h.service.tick(f"settle:{tx.id}")
    assert incident.state == "notify-stopped" and incident.reason == "quota-unconfirmed"
    # A later reading only updates state; nothing switches again.
    h.clock.advance(5)
    h.service.observe_usage("claude", b, snap("claude", [window("session", 12, 3600, now=h.clock.now())], fetched_at=h.clock.now()))
    assert len(h.vault.switch_calls) == 1


@pytest.mark.asyncio
async def test_turn_complete_evidence_requires_membership_lineage_and_resume(h: Harness) -> None:
    s = h.session()
    incident, tx, b = await _codex_incident(h, panes=[(s, "t1", "pane-1"), (s, "t2", "pane-2")])
    await h.service.ack(_ready(tx.id, "pane-1"))
    await h.service.ack(_ready(tx.id, "pane-2", "sess-2"))
    assert tx.state == "committed" and incident.state == "settling"
    # A pane outside the transaction is refused outright.
    with pytest.raises(qf.FailoverRefused):
        await h.service.settle({"transaction_id": tx.id, "pane_id": "pane-x", "outcome": "turn-complete"})
    # A turn newer than the commit on an old PTY, before the pane reported
    # its resume, is not evidence.
    h.activity["pane-1"] = {"event_type": "turn_complete", "text": "", "ts_monotonic": tx.committed_monotonic + 1}
    await h.service.settle({"transaction_id": tx.id, "pane_id": "pane-1", "outcome": "turn-complete"})
    assert incident.state == "settling"
    # Both panes come back on new PTYs started after the commit ...
    _restarted_pane(h, s, tx, "pane-1", "t1-new")
    _restarted_pane(h, s, tx, "pane-2", "t2-new")
    await h.service.settle({"transaction_id": tx.id, "pane_id": "pane-1", "outcome": "resumed",
                            "session_id": "sess-1", "term_id": "t1-new"})
    # ... but pane-2 has not reported yet: quota cannot paper over it.
    await h.service.settle({"transaction_id": tx.id, "pane_id": "pane-1", "outcome": "turn-complete", "term_id": "t1-new"})
    assert incident.state == "settling"
    await h.service.settle({"transaction_id": tx.id, "pane_id": "pane-2", "outcome": "resumed",
                            "session_id": "sess-2", "term_id": "t2-new"})
    await h.service.settle({"transaction_id": tx.id, "pane_id": "pane-1", "outcome": "turn-complete", "term_id": "t1-new"})
    assert incident.state == "ready" and incident.reason == "turn-complete"


@pytest.mark.asyncio
async def test_hot_turn_complete_evidence_uses_the_backends_turn_start_pairing(h: Harness) -> None:
    await h.service.set_policy("auto")
    b = await _claude_two_accounts(h)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__", auth_scope="claude")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", b)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    tx = h.service.transactions[incident.transaction_ids[0]]
    assert tx.state == "committed" and incident.state == "settling"
    # A turn that BEGAN before the swap and ended after it: the old account's
    # work, whatever the renderer claims about its start.
    h.activity["pane-1"] = {"event_type": "turn_complete", "text": "",
                            "ts_monotonic": tx.committed_monotonic + 2,
                            "turn_started_monotonic": tx.committed_monotonic - 1, "detail": "end_turn"}
    await h.service.settle({"transaction_id": tx.id, "pane_id": "pane-1", "outcome": "turn-complete",
                            "turn_started_at": iso(h.clock.now() + 999)})
    assert incident.state == "settling"
    # Equal clock ticks cannot prove that the turn began after the commit.
    h.activity["pane-1"]["turn_started_monotonic"] = tx.committed_monotonic
    await h.service.settle({"transaction_id": tx.id, "pane_id": "pane-1", "outcome": "turn-complete"})
    assert incident.state == "settling"
    # A turn whose recorded end is an exhaustion is not a working turn either.
    h.activity["pane-1"] = {"event_type": "turn_complete", "text": "",
                            "ts_monotonic": tx.committed_monotonic + 3,
                            "turn_started_monotonic": tx.committed_monotonic + 1,
                            "detail": "model_usage_exhausted"}
    import re as _re
    real = qf.quota_text_patterns
    qf.quota_text_patterns = lambda key: [_re.compile("model_usage_exhausted")] if key == "claude" else real(key)
    try:
        await h.service.settle({"transaction_id": tx.id, "pane_id": "pane-1", "outcome": "turn-complete"})
        assert incident.state == "settling"
    finally:
        qf.quota_text_patterns = real
    # A turn that began and ended after the swap: evidence.
    h.activity["pane-1"] = {"event_type": "turn_complete", "text": "",
                            "ts_monotonic": tx.committed_monotonic + 4,
                            "turn_started_monotonic": tx.committed_monotonic + 1, "detail": "end_turn"}
    await h.service.settle({"transaction_id": tx.id, "pane_id": "pane-1", "outcome": "turn-complete"})
    assert incident.state == "ready" and incident.reason == "turn-complete"


def test_activity_store_pairs_turn_start_with_its_end(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app, "_pane_activity", {})
    ticks = iter([10.0, 11.0, 12.0, 13.0, 14.0])
    monkeypatch.setattr(app, "time", SimpleNamespace(monotonic=lambda: next(ticks)))
    app._record_pane_activity("p", "agent_active", "")
    first = app.pane_activity("p")
    assert first["turn_started_monotonic"] == first["ts_monotonic"]
    app._record_pane_activity("p", "agent_active", "")
    assert app.pane_activity("p")["turn_started_monotonic"] == first["ts_monotonic"]
    app._record_pane_activity("p", "turn_complete", "done", detail="end_turn")
    ended = app.pane_activity("p")
    assert ended["turn_started_monotonic"] == first["ts_monotonic"]
    assert ended["detail"] == "end_turn" and ended["text"] == "done"
    # The next activity opens a new turn; detail is kept only on turn ends.
    app._record_pane_activity("p", "agent_active", "", detail="ignored")
    again = app.pane_activity("p")
    assert again["turn_started_monotonic"] > first["ts_monotonic"] and again["detail"] == ""
    assert again["turn_started_monotonic"] == again["ts_monotonic"] == 13.0
    # A turn end with no observed start has an unknown start, never "now".
    app._record_pane_activity("q", "turn_complete", "done")
    assert app.pane_activity("q")["turn_started_monotonic"] is None


def test_activity_store_pairs_turns_that_share_a_clock_tick(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app, "_pane_activity", {})
    ticks = iter([9.0, 10.0, 10.0, 11.0, 12.0])
    monkeypatch.setattr(app, "time", SimpleNamespace(monotonic=lambda: next(ticks)))
    app._record_pane_activity("p", "agent_active", "")
    app._record_pane_activity("p", "turn_complete", "first", detail="end_turn")
    assert app.pane_activity("p")["turn_started_monotonic"] == 9.0
    app._record_pane_activity("p", "agent_active", "", detail="ignored")
    assert app.pane_activity("p")["detail"] == ""
    # A later active event belongs to the second turn, even though its start
    # shared a tick with the preceding turn's end.
    app._record_pane_activity("p", "agent_active", "")
    assert app.pane_activity("p")["turn_started_monotonic"] == 10.0
    app._record_pane_activity("p", "turn_complete", "second", detail="end_turn")
    ended = app.pane_activity("p")
    assert ended["turn_started_monotonic"] == 10.0 and ended["ts_monotonic"] == 12.0
    assert ended["text"] == "second" and ended["detail"] == "end_turn"


@pytest.mark.asyncio
async def test_a_failed_resume_marks_the_transaction_partial_and_stops(h: Harness) -> None:
    s = h.session()
    incident, tx, _ = await _codex_incident(h, panes=[(s, "t1", "pane-1")])
    await h.service.ack(_ready(tx.id, "pane-1"))
    await h.service.settle({"transaction_id": tx.id, "pane_id": "pane-1", "outcome": "failed",
                            "reason": "session not found"})
    assert tx.state == "partial" and tx.reason == "resume-failed"
    assert incident.state == "notify-stopped" and incident.reason == "resume-failed"
    # Credentials moved: it still counts.
    assert h.service.budget("codex", "codex")["used"] == 1
    # A later positive reading does not flip a partial transaction to ready.
    h.clock.advance(5)
    h.service.observe_usage("codex", tx.to_slot_id, snap("codex", [window("session", 12, 3600, now=h.clock.now())], fetched_at=h.clock.now()))
    assert incident.state == "notify-stopped"


@pytest.mark.asyncio
async def test_outgoing_recovery_closes_a_notify_only_incident(h: Harness) -> None:
    s = h.session()
    h.pane(s, "t1", "codex", "pane-1", pin="__default__")
    h.exhausted_reading("codex", "__default__")
    incident, _ = await h.service.report(h.report_payload("codex", "pane-1"))
    assert incident.state == "detected"
    h.clock.advance(5)
    # Still 100 % but reset "passed" per the stamp: not a positive reading.
    h.service.observe_usage("codex", "__default__", snap("codex", [window("session", 100, -1, now=h.clock.now())], fetched_at=h.clock.now()))
    assert incident.state == "detected"
    h.service.observe_usage("codex", "__default__", snap("codex", [window("session", 3, 3600, now=h.clock.now())], fetched_at=h.clock.now()))
    assert incident.state == "ready" and incident.reason == "outgoing-recovered"


@pytest.mark.asyncio
async def test_state_exposes_open_and_unsettled_transactions_for_reconnect(h: Harness) -> None:
    s = h.session()
    incident, tx, _ = await _codex_incident(h, panes=[(s, "t1", "pane-1")])
    state = h.service.state()
    assert [t["id"] for t in state["transactions"]] == [tx.id]
    assert state["transactions"][0]["state"] == "preparing"
    assert state["incidents"][0]["id"] == incident.id
    assert state["policy"]["mode"] == "auto"
    await h.service.ack(_ready(tx.id, "pane-1"))
    assert h.service.state()["transactions"][0]["state"] == "committed"
    assert h.events_of("quota_failover.changed")


# ── usage_service generalisation ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_non_claude_switch_marks_the_account_and_drops_a_mid_read_poll(
    h: Harness, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent_team_backend.cli_vendors import registry

    svc = h.usage
    b = h.profile("codex", "B")
    h.store.set_default("codex", b)
    gate = asyncio.Event()

    async def slow_fetch(home: Path) -> dict:
        await gate.wait()
        return {"provider": "codex", "status": "ok", "fetchedAt": iso(h.clock.now() + 30),
                "windows": [{"kind": "session", "label": "5h", "usedPercent": 7}]}

    import dataclasses
    patched = {k: (dataclasses.replace(v, fetch_usage=slow_fetch) if k == "codex"
                   else dataclasses.replace(v, fetch_usage=None)) for k, v in registry.VENDORS.items()}
    monkeypatch.setattr(usage_service, "_CLI_VENDORS", patched)
    monkeypatch.setattr(svc, "_claude_credentials_by_slot", lambda: asyncio.sleep(0, result=None))
    monkeypatch.setattr(svc, "_harvest_active_slots", lambda: asyncio.sleep(0))
    monkeypatch.setattr(svc, "_file_quota_samples", lambda: asyncio.sleep(0))
    monkeypatch.setattr(usage_service, "fetch_claude", lambda home: asyncio.sleep(0, result={"provider": "claude", "status": "unavailable", "fetchedAt": iso(NOW), "windows": []}))
    poll = asyncio.create_task(svc.poll_once(home=Path("/nonexistent")))
    await asyncio.sleep(0.01)
    # The account switches while the read is out.
    svc.begin_switch_epoch("codex", "__default__", reading=True)
    assert svc._agent_epochs["codex"] == 1
    assert svc.account_snapshots["codex"]["__default__"]["refreshPending"] is True
    gate.set()
    await poll
    # The late read was dropped: the provider view is untouched and the
    # incoming account still says "reading".
    assert "codex" not in svc.snapshots
    assert svc.account_snapshots["codex"]["__default__"]["refreshPending"] is True
    # The next cycle, with no switch in between, files the reading under the
    # active account and clears the mark.
    await svc.poll_once(home=Path("/nonexistent"))
    assert svc.snapshots["codex"]["status"] == "ok"
    active = svc.account_snapshots["codex"][b]
    assert active["status"] == "ok" and "refreshPending" not in active


@pytest.mark.asyncio
async def test_announce_claude_switch_still_works_through_the_generalised_path(h: Harness) -> None:
    svc = h.usage
    await svc.announce_claude_switch("acct-b", reading=True)
    assert svc._active_claude_slot == "acct-b"
    assert svc.account_snapshots["claude"]["acct-b"]["refreshPending"] is True
    assert h.events_of("usage.changed")


# ── WS handlers ─────────────────────────────────────────────────────────────

async def _call(session: app.Session, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    handler = ws_handlers.lookup(msg_type)
    assert handler is not None, msg_type
    await handler(session, "m1", msg_type, payload)
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_ws_handlers_dispatch_and_map_refusals(h: Harness) -> None:
    s = h.session()
    got = await _call(s, "quota_failover.get_state", {})
    assert got["ok"] and got["payload"]["policy"]["mode"] == "notify"
    got = await _call(s, "quota_failover.set_policy", {"mode": "auto"})
    assert got["ok"] and got["payload"]["policy"]["mode"] == "auto"
    got = await _call(s, "quota_failover.set_policy", {"mode": "maybe"})
    assert not got["ok"] and got["error"]["code"] == "BAD_REQUEST"
    got = await _call(s, "quota_failover.report", h.report_payload("codex", "p", signal="network"))
    assert not got["ok"] and got["error"]["code"] == "BAD_SIGNAL"
    got = await _call(s, "quota_failover.candidates", {"agent_key": "no-such-vendor"})
    assert not got["ok"] and got["error"]["code"] == "UNSUPPORTED"
    b = await _claude_two_accounts(h)
    got = await _call(s, "quota_failover.candidates", {"agent_key": "claude"})
    assert got["ok"] and {c["slotId"] for c in got["payload"]["candidates"]} == {"__default__", b}
    got = await _call(s, "quota_failover.switch", {
        "agent_key": "claude", "to_slot_id": b, "expected_current_slot_id": "__default__",
        "expected_epoch": 0, "idempotency_key": "ws", "automatic": False,
    })
    assert got["ok"] and got["payload"]["transaction"]["state"] == "committed"
    got = await _call(s, "quota_failover.switch", {
        "agent_key": "claude", "to_slot_id": b, "expected_current_slot_id": "__default__",
        "expected_epoch": 0, "idempotency_key": "ws", "automatic": False,
    })
    # Same idempotency key: the same transaction, no second swap.
    assert got["ok"] and len(h.vault.switch_calls) == 1
    got = await _call(s, "quota_failover.cancel", {"transaction_id": "nope"})
    assert not got["ok"] and got["error"]["code"] == "NOT_FOUND"


def _login_pane(h: Harness, session: app.Session, agent: str, profile_id: str, *, live: bool) -> None:
    meta = {"login_profile_id": profile_id}
    if live:
        meta["live_login"] = True
    term = SimpleNamespace(id=f"login-{profile_id}", pane_id="p-login", agent_key=agent, closed=False,
                           metadata=meta, cwd="/ws", started_monotonic=0.0)
    session.terminals.registry[term.id] = term  # type: ignore[attr-defined]
    h.owners[term.id] = session


@pytest.mark.asyncio
async def test_switching_is_refused_while_any_live_store_sign_in_runs(h: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ws_handlers, "_switch_history", {})
    monkeypatch.setattr(usage_service, "start_login_watch", lambda *a: None)
    h.vault.slot_secrets[("codex", "__default__")] = "secret-a"
    b = h.profile("codex", "B", secret=None)
    c = h.profile("codex", "C")
    s = h.session()
    # The target's own sign-in pane (home or no home) blocks a switch to it.
    _login_pane(h, s, "codex", b, live=False)
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b})
    assert not got["ok"] and got["error"]["code"] == "LOGIN_IN_PROGRESS"
    # A live-store sign-in of ANY profile blocks every switch of the agent —
    # the live credential is nobody's own until it is harvested.
    h.owners.clear(); s.terminals.registry.clear()  # type: ignore[attr-defined]
    _login_pane(h, s, "codex", b, live=True)
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": c})
    assert not got["ok"] and got["error"]["code"] == "LOGIN_IN_PROGRESS"
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.begin_switch({
            "agent_key": "codex", "to_slot_id": c, "expected_current_slot_id": "__default__",
            "expected_epoch": 0, "idempotency_key": "k", "automatic": False,
        })
    assert err.value.code == "LOGIN_IN_PROGRESS" and err.value.details["profileId"] == b
    assert h.vault.switch_calls == []


@pytest.mark.asyncio
async def test_live_drift_parks_the_fresh_sign_in_instead_of_overwriting_the_active_slot(
    h: Harness, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A vendor without login isolation: the sign-in as B replaced the live
    credential (A's) with B's. Switching to B must not capture B's live
    credential into A's slot."""
    monkeypatch.setattr(ws_handlers, "_switch_history", {})
    monkeypatch.setattr(usage_service, "start_login_watch", lambda *a: None)
    # kilo signs in against the live store (no login isolation).
    h.vault.global_login_vendors = {"kilo"}
    h.vault.emails = {'{"token":"A"}': "a@x", '{"token":"B"}': "b@x", '{"token":"C"}': "c@x", '{"token":"X"}': "x@x"}
    a = h.profile("kilo", "A", secret='{"token":"A"}')
    h.store.set_default("kilo", a)
    b = h.profile("kilo", "B", secret=None)
    h.vault.live_secrets = {"kilo": '{"token":"B"}'}  # the completed live sign-in
    s = h.session()
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "kilo", "profile_id": b})
    assert got["ok"] and got["payload"]["adoptedLiveLogin"] is True
    assert got["payload"]["needsLogin"] is False
    assert h.vault.switch_calls == []                       # nothing swapped
    assert h.vault.captures == [("kilo", b)]                # live -> B's slot
    assert h.vault.slot_secrets[("kilo", a)] == '{"token":"A"}'
    assert h.vault.slot_secrets[("kilo", b)] == '{"token":"B"}'
    assert h.store.list()["defaults"]["kilo"] == b
    # With a NON-empty target the live credential could be anyone's: the
    # failover route stops (ok frame, cancelled tx) — a manual switch does not
    # (test_manual_switch_proceeds_when_the_live_credential_drifted_...).
    h.vault.live_secrets["kilo"] = '{"token":"X"}'
    c = h.profile("kilo", "C", secret='{"token":"C"}')
    fp = qf.live_fingerprint(h.vault, "kilo", None)
    tx = await h.service.begin_switch({
        "agent_key": "kilo", "to_slot_id": c, "expected_current_slot_id": b,
        "expected_epoch": h.service.epoch("kilo"), "idempotency_key": "k", "automatic": False,
        "assume_live_is_current": True, "live_fingerprint": fp,
    })
    assert tx.state == "cancelled" and tx.reason == "live-drift" and h.vault.switch_calls == []
    assert tx.live_identity == {"email": "x@x", "signedIn": True}
    # The same idempotency key returns the cancelled transaction, never a retry.
    again = await h.service.begin_switch({
        "agent_key": "kilo", "to_slot_id": c, "expected_current_slot_id": b,
        "expected_epoch": h.service.epoch("kilo"), "idempotency_key": "k", "automatic": False,
        "assume_live_is_current": True, "live_fingerprint": fp,
    })
    assert again is tx and h.vault.switch_calls == []


def test_live_drift_is_about_identity_not_token_rotation(h: Harness) -> None:
    v = FakeVault(h.vault.root)
    v.global_login_vendors = {"kilo"}
    v.slot_secrets[("kilo", "a")] = '{"token":"A1"}'
    v.emails = {'{"token":"A1"}': "a@x", '{"token":"A2"}': "a@x", '{"token":"B"}': "b@x"}
    # Same account, rotated token (a refresh): not a drift.
    v.live_secrets = {"kilo": '{"token":"A2"}'}
    assert qf.live_drift(v, "kilo", "a", None) == "none"
    # A different identity live: drift.
    v.live_secrets = {"kilo": '{"token":"B"}'}
    assert qf.live_drift(v, "kilo", "a", None) == "drifted"
    # Identical payload: nothing to ask.
    v.live_secrets = {"kilo": '{"token":"A1"}'}
    assert qf.live_drift(v, "kilo", "a", None) == "none"
    # No identity to compare: a refresh and a foreign credential look alike,
    # so neither is assumed — the caller asks the user.
    v.emails = {}
    v.slot_secrets[("codex", "a")] = '{"token":"A1"}'
    v.live_secrets = {"codex": '{"token":"A2"}', "kilo": '{"token":"A2"}'}
    assert qf.live_drift(v, "codex", "a", None) == "unverifiable"
    assert qf.live_drift(v, "kilo", "a", None) == "unverifiable"
    # Unreadable store: unknown, and the caller lets the vault's own refusal speak.
    class Boom(FakeVault):
        def read_live(self, agent_key: str, *, strict: bool = False, scope: str | None = None) -> SimpleNamespace:
            raise RuntimeError("storeTokenPlaintext")
    bv = Boom(h.vault.root); bv.slot_secrets[("kilo", "a")] = "x"
    assert qf.live_drift(bv, "kilo", "a", None) == "unknown"


def _codex_secret(email: str, account_id: str, gen: int, *, in_claims: bool = False) -> str:
    import base64

    claims: dict[str, Any] = {"email": email}
    tokens: dict[str, Any] = {"access_token": f"at-{gen}", "refresh_token": f"rt-{gen}"}
    if in_claims:
        claims["https://api.openai.com/auth"] = {"chatgpt_account_id": account_id}
    else:
        tokens["account_id"] = account_id
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    tokens["id_token"] = f"h.{payload}.s"
    return json.dumps({"tokens": tokens})


def test_stable_account_id_beats_the_email_when_judging_drift(h: Harness) -> None:
    v = FakeVault(h.vault.root)
    # codex: same email, same chatgpt_account_id, rotated tokens → refresh.
    v.slot_secrets[("codex", "a")] = _codex_secret("a@x", "acct-1", 1)
    v.live_secrets = {"codex": _codex_secret("a@x", "acct-1", 2)}
    assert qf.live_drift(v, "codex", "a", None) == "none"
    # Same email, DIFFERENT account id (a team login): a different account.
    v.live_secrets = {"codex": _codex_secret("a@x", "acct-team", 2)}
    assert qf.live_drift(v, "codex", "a", None) == "drifted"
    # The id may also come from the id_token claim when auth.json lacks it.
    v.slot_secrets[("codex", "a")] = _codex_secret("a@x", "acct-1", 1, in_claims=True)
    v.live_secrets = {"codex": _codex_secret("a@x", "acct-1", 2, in_claims=True)}
    assert qf.live_drift(v, "codex", "a", None) == "none"
    v.live_secrets = {"codex": _codex_secret("a@x", "acct-team", 2, in_claims=True)}
    assert qf.live_drift(v, "codex", "a", None) == "drifted"
    # claude: the account record beside the secret carries accountUuid /
    # organizationUuid; same id, new tokens → refresh; same email in another
    # organization → drift.
    class ClaudeVault(FakeVault):
        def __init__(self, root: Path) -> None:
            super().__init__(root)
            self.accounts: dict[str, dict] = {}

        def read_slot(self, agent_key: str, slot_id: str, *, scope: str | None = None) -> SimpleNamespace:
            return SimpleNamespace(secret=self.slot_secrets.get((agent_key, slot_id)),
                                   account=self.accounts.get(f"slot:{slot_id}"))

        def read_live(self, agent_key: str, *, strict: bool = False, scope: str | None = None) -> SimpleNamespace:
            return SimpleNamespace(secret=self.__dict__.setdefault("live_secrets", {}).get(agent_key),
                                   account=self.accounts.get("live"))

    cv = ClaudeVault(h.vault.root)
    cv.slot_secrets[("claude", "a")] = json.dumps({"claudeAiOauth": {"accessToken": "1", "refreshToken": "r1"}})
    cv.live_secrets = {"claude": json.dumps({"claudeAiOauth": {"accessToken": "2", "refreshToken": "r2"}})}
    cv.accounts = {"slot:a": {"accountUuid": "u1", "organizationUuid": "o1", "emailAddress": "a@x"},
                   "live": {"accountUuid": "u1", "organizationUuid": "o1", "emailAddress": "a@x"}}
    assert qf.live_drift(cv, "claude", "a", None) == "none"
    cv.accounts["live"] = {"accountUuid": "u1", "organizationUuid": "o-team", "emailAddress": "a@x"}
    assert qf.live_drift(cv, "claude", "a", None) == "drifted"
    # No ids on either side: the email decides; no email either: unverifiable.
    cv.accounts = {"slot:a": {"emailAddress": "a@x"}, "live": {"emailAddress": "a@x"}}
    assert qf.live_drift(cv, "claude", "a", None) == "none"
    cv.accounts = {}
    assert qf.live_drift(cv, "claude", "a", None) == "unverifiable"


@pytest.mark.asyncio
async def test_unverifiable_live_credential_needs_the_users_word_on_the_failover_route(
    h: Harness, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ws_handlers, "_switch_history", {})
    monkeypatch.setattr(usage_service, "start_login_watch", lambda *a: None)
    h.vault.emails = {}  # an opaque credential: nothing names the account
    a = h.profile("kimi", "A", secret='{"token":"A1"}')
    h.store.set_default("kimi", a)
    b = h.profile("kimi", "B", secret='{"token":"B"}')
    h.vault.live_secrets = {"kimi": '{"token":"A2"}'}  # rotated — or foreign
    s = h.session()
    tx = await h.service.begin_switch({
        "agent_key": "kimi", "to_slot_id": b, "expected_current_slot_id": a,
        "expected_epoch": 0, "idempotency_key": "k1", "automatic": False,
    })
    assert tx.state == "cancelled" and tx.reason == "live-drift-unverified"
    assert tx.live_identity == {"email": None, "signedIn": True}
    # Re-sending the SAME key (even with the user's word) returns the cancelled
    # transaction: a confirmation is a new request with a new key.
    same = await h.service.begin_switch({
        "agent_key": "kimi", "to_slot_id": b, "expected_current_slot_id": a,
        "expected_epoch": 0, "idempotency_key": "k1", "automatic": False,
        "assume_live_is_current": True,
    })
    assert same is tx and h.vault.switch_calls == []
    # The account moving under the confirmation is caught by the expected fields.
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.begin_switch({
            "agent_key": "kimi", "to_slot_id": b, "expected_current_slot_id": a,
            "expected_epoch": 7, "idempotency_key": "k-late", "automatic": False,
            "assume_live_is_current": True,
        })
    assert err.value.code == "STALE_EPOCH"
    fingerprint = qf.live_fingerprint(h.vault, "kimi", None)
    assert fingerprint and tx.live_fingerprint == fingerprint
    assert h.service.epoch("kimi") == 0
    # The manual route never asks for the word, but a caller that sends it
    # must still bind it to a state: missing expected_* → BAD_REQUEST;
    # another account → STALE_STATE; same account but the epoch moved
    # (A -> C -> A) → STALE_EPOCH. None of these touches a credential.
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "kimi", "profile_id": b,
                                                      "assume_live_is_current": True})
    assert not got["ok"] and got["error"]["code"] == "BAD_REQUEST"
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "kimi", "profile_id": b,
                                                      "assume_live_is_current": True,
                                                      "expected_current_slot_id": "__default__",
                                                      "expected_epoch": 0,
                                                      "live_fingerprint": fingerprint})
    assert not got["ok"] and got["error"]["code"] == "STALE_STATE"
    assert got["error"]["details"]["currentSlotId"] == a
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "kimi", "profile_id": b,
                                                      "assume_live_is_current": True,
                                                      "expected_current_slot_id": a,
                                                      "expected_epoch": 3,
                                                      "live_fingerprint": fingerprint})
    assert not got["ok"] and got["error"]["code"] == "STALE_EPOCH"
    assert got["error"]["details"]["epoch"] == 0
    # Without the fingerprint the word is refused outright: the epoch cannot
    # see a CLI rewriting the live store while the dialog is open.
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "kimi", "profile_id": b,
                                                      "assume_live_is_current": True,
                                                      "expected_current_slot_id": a,
                                                      "expected_epoch": 0})
    assert not got["ok"] and got["error"]["code"] == "BAD_REQUEST"
    assert h.vault.switch_calls == [] and getattr(h.vault, "captures", []) == []
    assert h.vault.slot_secrets[("kimi", a)] == '{"token":"A1"}'
    # Same state as shown: a normal switch, and A's slot keeps the rotated
    # token so a switch back does not revive a dead one.
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "kimi", "profile_id": b,
                                                      "assume_live_is_current": True,
                                                      "expected_current_slot_id": a,
                                                      "expected_epoch": 0,
                                                      "live_fingerprint": fingerprint})
    assert got["ok"] and got["payload"].get("adoptedLiveLogin") is False
    assert h.vault.switch_calls == [("kimi", a, b, None)]
    assert h.service.epoch("kimi") == 1
    # (The fake vault's switch does not move the live payload; the real one
    # restores B's — mirror that so the next reads see B live.)
    h.vault.live_secrets["kimi"] = h.vault.slot_secrets[("kimi", b)]
    # An ordinary manual call (no assume, no expected_*) is unchanged.
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "kimi", "profile_id": a})
    assert got["ok"] and h.vault.switch_calls[-1] == ("kimi", b, a, None)
    h.vault.live_secrets["kimi"] = h.vault.slot_secrets[("kimi", a)]
    # A -> C -> A: the account is the same as first shown, the epoch is not.
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "kimi", "profile_id": b,
                                                      "assume_live_is_current": True,
                                                      "expected_current_slot_id": a,
                                                      "expected_epoch": 0,
                                                      "live_fingerprint": fingerprint})
    assert not got["ok"] and got["error"]["code"] == "STALE_EPOCH"
    assert got["error"]["details"]["epoch"] == 2
    h.vault.live_secrets["kimi"] = '{"token":"B2"}'
    # The failover route: expected_* are mandatory there already; the
    # fingerprint is mandatory with the word, must match, and the word is
    # manual-only.
    with pytest.raises(qf.FailoverRefused) as err:
        await h.service.begin_switch({
            "agent_key": "kimi", "to_slot_id": b, "expected_current_slot_id": a,
            "expected_epoch": h.service.epoch("kimi"), "idempotency_key": "k3", "automatic": False,
            "assume_live_is_current": True,
        })
    assert err.value.code == "BAD_REQUEST"
    tx3 = await h.service.begin_switch({
        "agent_key": "kimi", "to_slot_id": b, "expected_current_slot_id": a,
        "expected_epoch": h.service.epoch("kimi"), "idempotency_key": "k4", "automatic": False,
    })
    assert tx3.state == "cancelled" and tx3.reason == "live-drift-unverified" and tx3.live_fingerprint
    tx4 = await h.service.begin_switch({
        "agent_key": "kimi", "to_slot_id": b, "expected_current_slot_id": a,
        "expected_epoch": h.service.epoch("kimi"), "idempotency_key": "k5", "automatic": False,
        "assume_live_is_current": True, "live_fingerprint": "stale",
    })
    assert tx4.state == "cancelled" and tx4.reason == "live-drift-unverified"
    tx5 = await h.service.begin_switch({
        "agent_key": "kimi", "to_slot_id": b, "expected_current_slot_id": a,
        "expected_epoch": h.service.epoch("kimi"), "idempotency_key": "k6", "automatic": False,
        "assume_live_is_current": True, "live_fingerprint": tx3.live_fingerprint,
    })
    assert tx5.state in ("committed", "preparing") and h.vault.switch_calls[-1] == ("kimi", a, b, None)


@pytest.mark.asyncio
async def test_manual_switch_proceeds_when_the_live_credential_drifted_and_the_target_is_not_empty(
    h: Harness, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A switch the user picked by hand is never refused for drift: the
    reconcile gate belongs to the quota failover transaction alone."""
    monkeypatch.setattr(ws_handlers, "_switch_history", {})
    monkeypatch.setattr(usage_service, "start_login_watch", lambda *a: None)
    h.vault.global_login_vendors = {"kilo"}
    h.vault.emails = {'{"token":"A"}': "a@x", '{"token":"B"}': "b@x", '{"token":"X"}': "x@x"}
    a = h.profile("kilo", "A", secret='{"token":"A"}')
    h.store.set_default("kilo", a)
    b = h.profile("kilo", "B", secret='{"token":"B"}')
    h.vault.live_secrets = {"kilo": '{"token":"X"}'}  # someone else signed in
    s = h.session()
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "kilo", "profile_id": b})
    assert got["ok"], got
    assert got["payload"]["warning"] == "live-drift"
    assert [c[:3] for c in h.vault.switch_calls] == [("kilo", a, b)]
    assert h.store.list()["defaults"]["kilo"] == b
    # The failover transaction in the same situation still refuses.
    h.vault.live_secrets["kilo"] = '{"token":"X"}'
    tx = await h.service.begin_switch({
        "agent_key": "kilo", "to_slot_id": a, "expected_current_slot_id": b,
        "expected_epoch": h.service.epoch("kilo"), "idempotency_key": "k", "automatic": False,
    })
    assert tx.state == "cancelled" and tx.reason == "live-drift"
    assert [c[:3] for c in h.vault.switch_calls] == [("kilo", a, b)]


@pytest.mark.asyncio
async def test_manual_switch_does_not_ask_to_confirm_an_unverifiable_live_credential(
    h: Harness, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ws_handlers, "_switch_history", {})
    monkeypatch.setattr(usage_service, "start_login_watch", lambda *a: None)
    h.vault.emails = {}  # an opaque credential: nothing names the account
    a = h.profile("kimi", "A", secret='{"token":"A1"}')
    h.store.set_default("kimi", a)
    b = h.profile("kimi", "B", secret='{"token":"B"}')
    h.vault.live_secrets = {"kimi": '{"token":"A2"}'}  # rotated — or foreign
    s = h.session()
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "kimi", "profile_id": b})
    assert got["ok"], got
    assert got["payload"]["warning"] == "live-drift-unverified"
    assert h.vault.switch_calls == [("kimi", a, b, None)]
    assert h.store.list()["defaults"]["kimi"] == b


@pytest.mark.asyncio
async def test_manual_switch_works_under_the_auto_policy(
    h: Harness, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ws_handlers, "_switch_history", {})
    monkeypatch.setattr(usage_service, "start_login_watch", lambda *a: None)
    await h.service.set_policy("auto")
    h.vault.emails = {'{"token":"A"}': "a@x", '{"token":"B"}': "b@x", '{"token":"X"}': "x@x"}
    a = h.profile("codex", "A", secret='{"token":"A"}')
    h.store.set_default("codex", a)
    b = h.profile("codex", "B", secret='{"token":"B"}')
    h.vault.live_secrets = {"codex": '{"token":"X"}'}
    s = h.session()
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b})
    assert got["ok"], got
    assert h.store.list()["defaults"]["codex"] == b


@pytest.mark.asyncio
@pytest.mark.parametrize("drift", ["drifted", "unverifiable", "unknown", "none"])
async def test_manual_switch_never_runs_a_failover_gate_without_an_exhaustion_event(
    h: Harness, monkeypatch: pytest.MonkeyPatch, drift: str,
) -> None:
    """With no exhaustion incident, whatever the drift reading says, the manual
    route opens no failover transaction and refuses nothing."""
    monkeypatch.setattr(ws_handlers, "_switch_history", {})
    monkeypatch.setattr(usage_service, "start_login_watch", lambda *a: None)
    monkeypatch.setattr(qf, "live_drift", lambda *a, **k: drift)

    async def no_transaction(*a: Any, **k: Any) -> None:
        raise AssertionError("the manual route opened a failover transaction")

    monkeypatch.setattr(h.service, "begin_switch", no_transaction)
    a = h.profile("codex", "A", secret='{"token":"A"}')
    h.store.set_default("codex", a)
    b = h.profile("codex", "B", secret='{"token":"B"}')
    h.vault.live_secrets = {"codex": '{"token":"A"}'}
    s = h.session()
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b})
    assert got["ok"], got
    assert h.vault.switch_calls == [("codex", a, b, None)]
    assert h.service.incidents == {} and h.service.transactions == {}


@pytest.mark.asyncio
async def test_regular_spawn_is_refused_while_a_live_store_sign_in_is_pending(h: Harness) -> None:
    h.vault.global_login_vendors = {"codex"}
    b = h.profile("codex", "B", secret=None)
    h.vault.pending_logins = {("codex", b)}
    assert ws_handlers._live_login_pending("codex") is True
    h.vault.pending_logins = set()
    assert ws_handlers._live_login_pending("codex") is False
    # An isolated vendor never reports a live-store sign-in.
    h.vault.global_login_vendors = set()
    h.vault.pending_logins = {("codex", b)}
    assert ws_handlers._live_login_pending("codex") is False


@pytest.mark.asyncio
async def test_both_capability_surfaces_carry_login_isolation(h: Harness) -> None:
    # cli_profiles.list (accounts UI) and quota_failover.get_state read the
    # same record; neither leaves the field to be guessed from login_home_env.
    s = h.session()
    listed = (await _call(s, "cli_profiles.list", {}))["payload"]["account_capabilities"]
    state = (await _call(s, "quota_failover.get_state", {}))["payload"]["capabilities"]
    from agent_team_backend.cli_vendors.registry import VENDORS
    for key in VENDORS:
        assert listed[key]["loginIsolation"] in ("isolated", "global"), key
        assert listed[key]["loginIsolation"] == state[key]["loginIsolation"], key


def test_capabilities_name_the_login_isolation_shape() -> None:
    caps = qf.capabilities()
    assert caps["claude"]["loginIsolation"] == "isolated"
    assert caps["codex"]["loginIsolation"] == "isolated"
    assert caps["kilo"]["loginIsolation"] == "global"
    assert all(c["loginIsolation"] in ("isolated", "global") for c in caps.values())


@pytest.mark.asyncio
async def test_manual_set_default_handler_calls_the_failover_hook(h: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    b = await _claude_two_accounts(h)
    monkeypatch.setattr(ws_handlers, "_switch_history", {})
    monkeypatch.setattr(usage_service, "start_login_watch", lambda *a: None)
    s = h.session()
    got = await _call(s, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": b})
    assert got["ok"]
    assert h.service.epoch("claude") == 1
