"""quota_failover.* WS API contract, driven through the real handlers.

Every request goes through ``app.handle_message`` (the same dispatch a
window uses) against a throwaway ``navide.db``, the real ``CliProfilesStore``
/ ``PaneAccountHistory`` on that database, and the real
``QuotaFailoverService`` under a controllable clock. Only the seams that
touch secrets or processes are stood in for: the credential vault (records
swaps, holds the switch lock, answers slot reads), the usage poller's
announcements, the PTY owner registry and the quota ledger.

Plan: .agent-team/plans/quota-exhaustion-auto-switch_7b3e91.html — these are
the Phase B / D / E acceptance rows the plan lists, asserted as the contract
the renderer relies on. A red row here is a real integration gap, not a
fixture to loosen.
"""

from __future__ import annotations

import asyncio
import inspect
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, quota_failover, usage_service
from agent_team_backend.db import Database
from agent_team_backend.pane_account_history import PaneAccountHistory
from agent_team_backend.profiles_store import CliProfilesStore
from agent_team_backend.quota_failover import (
    AUTO_BUDGET_MAX,
    DEFAULT_SLOT_ID,
    QuotaFailoverService,
)

T0 = 1_800_000_000.0  # fixed epoch the fake clock starts at


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


# ── seams ─────────────────────────────────────────────────────────────────────

class Clock:
    def __init__(self) -> None:
        self.t = T0

    def __call__(self) -> float:
        return self.t


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    """Owner-side registry the handlers consult through ``_PTY_OWNERS``."""

    def __init__(self) -> None:
        self.registry: dict[str, SimpleNamespace] = {}
        self.killed: list[str] = []

    def get(self, session_id: str) -> SimpleNamespace | None:
        return self.registry.get(session_id)

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []

    async def kill(self, session_id: str, force: bool = False) -> None:
        self.killed.append(session_id)


class FakeVault:
    """Credential seam: never touches a home or a Keychain. ``live`` is the
    compound document a per-provider vendor swaps one entry of; whole-file
    vendors just get the call recorded."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.switch_calls: list[tuple[Any, ...]] = []
        self.fail = False
        self._locks: dict[str, asyncio.Lock] = {}
        self.slot_secrets: dict[tuple[str, str], str | None] = {}
        self.live: dict[str, dict[str, str]] = {}      # agent -> {scope: entry}
        self.parked: dict[tuple[str, str, str], str] = {}  # (agent, slot, scope) -> entry
        # Whole-file vendors, when a test opts in: the live credential and
        # the identity each secret resolves to (what ``identity`` answers).
        self.live_secret: dict[str, str | None] = {}
        self.emails: dict[str, str] = {}

    def switch_lock(self, agent_key: str) -> asyncio.Lock:
        return self._locks.setdefault(agent_key, asyncio.Lock())

    def switch(self, agent_key: str, from_slot_id: str, to_slot_id: str,
               scope: str | None = None) -> None:
        self.switch_calls.append((agent_key, from_slot_id, to_slot_id, scope))
        if self.fail:
            raise RuntimeError("swap boom")
        if scope is None and agent_key in self.live_secret:
            # CredentialVault.switch: capture the live credential into the
            # outgoing slot, then restore the target slot into the live spot.
            self.slot_secrets[(agent_key, from_slot_id)] = self.live_secret[agent_key]
            self.live_secret[agent_key] = self.slot_secrets.get((agent_key, to_slot_id))
        if scope is not None:
            # Only that provider's entry moves; every other entry stays.
            live = self.live.setdefault(agent_key, {})
            if scope in live:
                self.parked[(agent_key, from_slot_id, scope)] = live.pop(scope)
            restored = self.parked.pop((agent_key, to_slot_id, scope), None)
            if restored is not None:
                live[scope] = restored

    def login_home_path(self, agent_key: str, slot_id: str) -> Path:
        return self.root / agent_key / slot_id / "login-home"

    def harvest_login_home(self, agent_key: str, slot_id: str) -> bool:
        return False

    def identity(self, agent_key: str, slot_id: str | None = None) -> dict[str, Any]:
        secret = self.live_secret.get(agent_key) if slot_id is None else self.slot_secrets.get((agent_key, slot_id))
        email = self.emails.get(secret or "")
        return {"email": email, "signedIn": email is not None}

    # No claude account has signed in inside its own config dir.
    def account_dir_signed_in(self, slot_id: str) -> bool:
        return False

    def account_dir_identity(self, slot_id: str) -> dict | None:
        return None

    def read_slot(self, agent_key: str, slot_id: str) -> SimpleNamespace:
        return SimpleNamespace(secret=self.slot_secrets.get((agent_key, slot_id)), account=None)


class FakeLedger:
    def mark_exhausted(self, *args: Any, **kwargs: Any) -> list[str]:
        return []

    def cycles(self, *args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        return []


CLAUDE_OK_SECRET = json.dumps({"claudeAiOauth": {
    "accessToken": "at-fake", "refreshToken": "rt-fake", "expiresAt": (T0 + 86_400) * 1000,
}})


def snapshot(*, used: float, fetched_at: float, resets_at: float | None = None,
             stale: bool = False, kind: str = "session") -> dict[str, Any]:
    return {
        "provider": "claude", "status": "ok", "stale": stale,
        "fetchedAt": iso(fetched_at), "lastSuccessAt": iso(fetched_at),
        "windows": [{"kind": kind, "usedPercent": used,
                     "resetsAt": iso(resets_at if resets_at is not None else fetched_at + 3600)}]
                   + ([{"kind": "weekly", "usedPercent": used, "resetsAt": iso(fetched_at + 86400)}]
                      if kind == "session" else []),
    }


# ── fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture()
def clock() -> Clock:
    return Clock()


@pytest.fixture()
def db(tmp_path: Path) -> Database:
    return Database(tmp_path / "navide.db")


@pytest.fixture()
def rig(tmp_path: Path, db: Database, clock: Clock, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """The app wired to throwaway state: real store / history / authority on
    a temp database, fake vault, usage announcements and ledger recorded."""
    store = CliProfilesStore(path=tmp_path / "cli-profiles.json", profiles_root=tmp_path / "profiles", db=db)
    history = PaneAccountHistory(db=db)
    vault = FakeVault(tmp_path / "fake-vault")
    service = QuotaFailoverService(db=db, now=clock)
    monkeypatch.setattr(app, "cli_profiles_store", store)
    monkeypatch.setattr(app, "pane_account_history", history)
    monkeypatch.setattr(app, "credential_vault", vault)
    monkeypatch.setattr(app, "quota_ledger", FakeLedger())
    monkeypatch.setattr(app, "quota_failover", service)

    events: list[dict[str, Any]] = []

    async def record(event: dict[str, Any], *, exclude: Any = None) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", record)

    usage = usage_service.service
    announced: list[tuple[Any, ...]] = []
    monkeypatch.setattr(usage, "account_snapshots", {})
    monkeypatch.setattr(usage, "snapshots", {})
    monkeypatch.setattr(usage, "begin_switch_epoch",
                        lambda agent, slot, *, reading=True: announced.append(("epoch", agent, slot)))

    async def announce(agent: str, slot: Any, *, reading: bool = True, mark: bool = True) -> None:
        announced.append(("announce", agent, slot))

    async def announce_claude(slot: Any, *, reading: bool = True) -> None:
        announced.append(("announce", "claude", slot))

    monkeypatch.setattr(usage, "announce_switch", announce)
    monkeypatch.setattr(usage, "announce_claude_switch", announce_claude)
    monkeypatch.setattr(usage, "request_refresh", lambda *a, **k: None)
    monkeypatch.setattr(usage_service, "start_login_watch", lambda *a, **k: None)
    return SimpleNamespace(store=store, history=history, vault=vault, service=service,
                           usage=usage, events=events, announced=announced, clock=clock, db=db)


def session() -> app.Session:
    s = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    s.terminals = FakeTerminals()  # type: ignore[assignment]
    return s


async def call(s: app.Session, msg_type: str, payload: dict[str, Any], msg_id: str = "m") -> dict[str, Any]:
    """Dispatch one frame the way a window does and return its answer."""
    before = len(s.websocket.sent)  # type: ignore[attr-defined]
    await app.handle_message(s, {"id": msg_id, "type": msg_type, "payload": payload})
    answers = [f for f in s.websocket.sent[before:] if f.get("id") == msg_id]  # type: ignore[attr-defined]
    assert len(answers) == 1, f"{msg_type}: expected one answer, got {answers}"
    return answers[0]


def ok(frame: dict[str, Any]) -> dict[str, Any]:
    assert frame["ok"] is True, frame
    return frame["payload"]


def refused(frame: dict[str, Any], code: str) -> dict[str, Any]:
    assert frame["ok"] is False, frame
    assert frame["error"]["code"] == code, frame["error"]
    return frame["error"]


def add_pane(s: app.Session, rig: SimpleNamespace, *, term_id: str, pane_id: str, agent_key: str,
             slot_id: str, workspace: str, auth_scope: str | None = None) -> SimpleNamespace:
    """A live regular pane owned by ``s``, pinned to ``slot_id`` since T0-100."""
    term = SimpleNamespace(
        id=term_id, pane_id=pane_id, agent_key=agent_key, closed=False, cwd=workspace,
        started_monotonic=0.0,
        metadata={"workspace_path": workspace, "credential_source": "vault",
                  "auth_scope": auth_scope or quota_failover.capability(agent_key)["authScope"]},
    )
    s.terminals.registry[term_id] = term  # type: ignore[attr-defined]
    app._PTY_OWNERS[term_id] = s
    rig.history.pin(pane_id, slot_id, T0 - 100)
    return term


def report_payload(agent_key: str, pane_id: str, *, idem: str, at: float = T0) -> dict[str, Any]:
    return {"agent_key": agent_key, "pane_id": pane_id, "signal": "quota-exhausted",
            "source": "usage-window", "at": iso(at), "idempotency_key": idem,
            "workspace_path": "/ws/a"}


def two_accounts(rig: SimpleNamespace, agent_key: str, *, secret: str = "tok") -> tuple[str, str]:
    """Profiles A (active, exhausted) and B (parked, fresh headroom) of one
    vendor. Login state comes from the vault seam; quota from the poller's
    per-account snapshots — the only reading the authority trusts."""
    a = rig.store.create(agent_key=agent_key, name="A")["id"]
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    rig.store.set_default(agent_key, a)
    for slot in (a, b):
        rig.vault.slot_secrets[(agent_key, slot)] = secret
    rig.usage.account_snapshots[agent_key] = {
        a: snapshot(used=100, fetched_at=T0 - 60, resets_at=T0 + 3600),
        b: snapshot(used=20, fetched_at=T0 - 60),
    }
    return a, b


async def set_policy(s: app.Session, mode: str) -> dict[str, Any]:
    return ok(await call(s, "quota_failover.set_policy", {"mode": mode}, msg_id=f"policy-{mode}"))


# ── policy ────────────────────────────────────────────────────────────────────

async def test_policy_defaults_to_notify_and_persists_across_a_backend_restart(rig, db, clock) -> None:
    s = session()
    state = ok(await call(s, "quota_failover.get_state", {}))
    assert state["policy"]["mode"] == "notify"

    state = await set_policy(s, "auto")
    assert state["policy"]["mode"] == "auto"
    assert state["policy"]["updatedAt"] == iso(T0)
    refused(await call(s, "quota_failover.set_policy", {"mode": "always"}, msg_id="bad"), "BAD_REQUEST")

    # A new authority on the same database (backend restart) reads the
    # persisted value; nothing lives only in memory.
    reloaded = QuotaFailoverService(db=db, now=clock)
    assert reloaded.policy_mode() == "auto"
    assert reloaded.state()["policy"] == state["policy"]


# ── automatic hot switch on the real registry ────────────────────────────────

async def test_registry_claude_auto_switches_once_and_budget_counts_one(rig) -> None:
    s = session()
    a, b = two_accounts(rig, "claude", secret=CLAUDE_OK_SECRET)
    add_pane(s, rig, term_id="t1", pane_id="p1", agent_key="claude", slot_id=a, workspace="/ws/a")
    await set_policy(s, "auto")

    cap = ok(await call(s, "quota_failover.get_state", {}))["capabilities"]["claude"]
    assert cap["switchMode"] == "hot" and cap["supported"] is True
    # The registry declares how the layout was established; the acceptance
    # record must show that, not a "live" round-trip nobody has run.
    assert cap["evidence"] == "source"

    result = ok(await call(s, "quota_failover.report", report_payload("claude", "p1", idem="r1")))
    assert result["created"] is True
    incident = result["incident"]
    assert incident["trusted"] is True and incident["state"] == "settling"

    assert rig.vault.switch_calls == [("claude", a, b, None)]
    assert rig.store.list()["defaults"]["claude"] == b
    assert s.terminals.killed == []  # type: ignore[attr-defined]

    state = ok(await call(s, "quota_failover.get_state", {}, msg_id="after"))
    assert state["budget"]["claude"]["used"] == 1
    assert state["budget"]["claude"]["limit"] == AUTO_BUDGET_MAX
    assert state["epochs"]["claude"] == 1
    (tx,) = state["transactions"]
    assert tx["automatic"] is True and tx["state"] == "committed" and tx["swapped"] is True
    assert tx["fromSlotId"] == a and tx["toSlotId"] == b
    commit = [e for e in rig.events if e["type"] == "quota_failover.commit"]
    assert len(commit) == 1 and commit[0]["payload"]["toSlotId"] == b
    # The usage epoch moved under the lock and the switch was announced.
    assert ("epoch", "claude", b) in rig.announced


async def test_manual_choice_from_two_windows_swaps_once_and_costs_no_auto_budget(rig) -> None:
    """notify: both windows report the same exhaustion into one incident; the
    announcement's button pressed in each window moves credentials once."""
    w1, w2 = session(), session()
    a, b = two_accounts(rig, "claude", secret=CLAUDE_OK_SECRET)
    add_pane(w1, rig, term_id="t1", pane_id="p1", agent_key="claude", slot_id=a, workspace="/ws/a")
    add_pane(w2, rig, term_id="t2", pane_id="p2", agent_key="claude", slot_id=a, workspace="/ws/b")

    first = ok(await call(w1, "quota_failover.report", report_payload("claude", "p1", idem="w1-r")))
    second = ok(await call(w2, "quota_failover.report", report_payload("claude", "p2", idem="w2-r")))
    assert first["created"] is True and second["created"] is False
    assert second["incident"]["id"] == first["incident"]["id"]
    assert {p["paneId"] for p in second["incident"]["panes"]} == {"p1", "p2"}
    assert rig.vault.switch_calls == []  # notify never moves credentials by itself

    proposal = {"agent_key": "claude", "to_slot_id": b, "incident_id": first["incident"]["id"],
                "expected_current_slot_id": a, "expected_epoch": 0}
    tx1 = ok(await call(w1, "quota_failover.switch", {**proposal, "idempotency_key": "k1"}))["transaction"]
    assert tx1["state"] == "committed" and tx1["automatic"] is False
    # Same key from the other window: the same result, not a second swap.
    tx2 = ok(await call(w2, "quota_failover.switch", {**proposal, "idempotency_key": "k1"}, msg_id="w2"))["transaction"]
    assert tx2["id"] == tx1["id"]
    # A different proposal against the state before the swap is stale.
    err = refused(await call(w2, "quota_failover.switch", {**proposal, "idempotency_key": "k2"}, msg_id="w2b"), "STALE_STATE")
    assert err["details"]["currentSlotId"] == b

    assert rig.vault.switch_calls == [("claude", a, b, None)]
    state = ok(await call(w1, "quota_failover.get_state", {}, msg_id="st"))
    assert state["budget"]["claude"]["used"] == 0


async def test_stale_epoch_after_a_manual_switch_and_malformed_proposals_are_refused(rig) -> None:
    s = session()
    a, b = two_accounts(rig, "claude", secret=CLAUDE_OK_SECRET)
    base = {"agent_key": "claude", "to_slot_id": b, "expected_current_slot_id": a, "expected_epoch": 0}

    refused(await call(s, "quota_failover.switch", base, msg_id="no-idem"), "BAD_REQUEST")
    refused(await call(s, "quota_failover.switch", {**base, "idempotency_key": "f", "force": True}, msg_id="force"), "BAD_REQUEST")
    refused(await call(s, "quota_failover.switch",
                       {"agent_key": "claude", "to_slot_id": b, "idempotency_key": "x"}, msg_id="no-expect"), "BAD_REQUEST")
    # A renderer may propose an automatic switch, never authorise one.
    refused(await call(s, "quota_failover.switch", {**base, "idempotency_key": "au", "automatic": True}, msg_id="auto"), "AUTO_DISABLED")
    assert rig.vault.switch_calls == []

    # The user switches by hand through the manual route: the epoch moves.
    ok(await call(s, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": b}, msg_id="manual"))
    assert rig.vault.switch_calls == [("claude", a, b, None)]
    state = ok(await call(s, "quota_failover.get_state", {}, msg_id="st"))
    assert state["epochs"]["claude"] == 1
    assert state["budget"]["claude"]["used"] == 0  # manual switches never spend the auto budget

    # A proposal made before that switch names the old epoch / old account.
    refused(await call(s, "quota_failover.switch",
                       {"agent_key": "claude", "to_slot_id": a, "expected_current_slot_id": b,
                        "expected_epoch": 0, "idempotency_key": "old"}, msg_id="stale"), "STALE_EPOCH")
    refused(await call(s, "quota_failover.switch",
                       {"agent_key": "claude", "to_slot_id": a, "expected_current_slot_id": a,
                        "expected_epoch": 1, "idempotency_key": "old2"}, msg_id="stale2"), "STALE_STATE")
    assert rig.vault.switch_calls == [("claude", a, b, None)]


# ── reports the authority does not act on ────────────────────────────────────

async def test_untrusted_or_wrong_signal_reports_never_switch(rig) -> None:
    s = session()
    a, _b = two_accounts(rig, "claude", secret=CLAUDE_OK_SECRET)
    add_pane(s, rig, term_id="t1", pane_id="p1", agent_key="claude", slot_id=a, workspace="/ws/a")
    await set_policy(s, "auto")

    err = refused(await call(s, "quota_failover.report",
                             {**report_payload("claude", "p1", idem="rl"), "signal": "rate-limited"}, msg_id="rl"), "BAD_SIGNAL")
    assert err["details"]["accepted"] == ["quota-exhausted"]

    # Quoted CLI text is evidence only when the vendor declares a detector.
    text = ok(await call(s, "quota_failover.report",
                         {**report_payload("claude", "p1", idem="txt"), "source": "cli-text",
                          "text": "Claude AI usage limit reached"}, msg_id="txt"))
    assert text["incident"]["trusted"] is False and text["incident"]["state"] == "detected"
    assert text["incident"]["reason"] in ("no-declared-detector", "text-did-not-match")
    assert rig.vault.switch_calls == []
    assert ok(await call(s, "quota_failover.get_state", {}, msg_id="st"))["budget"]["claude"]["used"] == 0


async def test_swap_failure_stops_the_automatic_run_without_trying_the_next_candidate(rig) -> None:
    s = session()
    a, b = two_accounts(rig, "claude", secret=CLAUDE_OK_SECRET)
    c = rig.store.create(agent_key="claude", name="C")["id"]
    rig.vault.slot_secrets[("claude", c)] = CLAUDE_OK_SECRET
    rig.usage.account_snapshots["claude"][c] = snapshot(used=40, fetched_at=T0 - 60)
    add_pane(s, rig, term_id="t1", pane_id="p1", agent_key="claude", slot_id=a, workspace="/ws/a")
    await set_policy(s, "auto")
    rig.vault.fail = True

    incident = ok(await call(s, "quota_failover.report", report_payload("claude", "p1", idem="r1")))["incident"]
    assert incident["state"] == "notify-stopped" and incident["reason"] == "swap-failed"
    assert incident["tried"] == [b]
    assert rig.vault.switch_calls == [("claude", a, b, None)]  # C was never attempted
    assert rig.store.list()["defaults"]["claude"] == a
    state = ok(await call(s, "quota_failover.get_state", {}, msg_id="st"))
    assert state["budget"]["claude"]["used"] == 0  # a rolled-back swap costs nothing
    assert state["policy"]["mode"] == "auto"

    # The same exhaustion reported again lands on the same incident and does
    # not start a second attempt.
    again = ok(await call(s, "quota_failover.report", report_payload("claude", "p1", idem="r1"), msg_id="again"))
    assert again["created"] is False and again["incident"]["id"] == incident["id"]
    assert rig.vault.switch_calls == [("claude", a, b, None)]


# ── restart vendor: prepare / ack / commit ───────────────────────────────────

async def _codex_two_windows(rig) -> tuple[app.Session, app.Session, str, str, dict[str, Any]]:
    w1, w2 = session(), session()
    a, b = two_accounts(rig, "codex")
    add_pane(w1, rig, term_id="t1", pane_id="p1", agent_key="codex", slot_id=a, workspace="/ws/a")
    add_pane(w2, rig, term_id="t2", pane_id="p2", agent_key="codex", slot_id=a, workspace="/ws/b")
    await set_policy(w1, "auto")
    incident = ok(await call(w1, "quota_failover.report", report_payload("codex", "p1", idem="r1")))["incident"]
    return w1, w2, a, b, incident


def prepare_events(s: app.Session) -> list[dict[str, Any]]:
    return [f for f in s.websocket.sent if f.get("type") == "quota_failover.prepare"]  # type: ignore[attr-defined]


def ready_ack(tx_id: str, pane_id: str, **extra: Any) -> dict[str, Any]:
    return {"transaction_id": tx_id, "pane_id": pane_id, "ready": True, "idle": "turn-boundary",
            "resume": {"resumable": True, "session_id": f"sess-{pane_id}"}, **extra}


@pytest.mark.parametrize("check", ["restart-field", "withdraw-order"])
async def test_manual_restart_switch_withdraws_proposal_before_profiles_changed(rig, check):
    w1, _w2, _a, b, _incident = await _codex_two_windows(rig)
    rig.events.clear()
    ok(await call(w1, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b, "force": True}))
    changed_index = next(i for i, event in enumerate(rig.events) if event["type"] == "cli_profiles.changed")
    changed = rig.events[changed_index]["payload"]
    assert changed["forced"] is True
    if check == "restart-field":
        assert "hotSwitchedPanes" not in changed
    else:
        quota_index = next(i for i, event in enumerate(rig.events) if event["type"] == "quota_failover.changed")
        assert quota_index < changed_index
        assert not rig.events[quota_index]["payload"]["transactions"]
        assert rig.service.epoch("codex") == 1


async def test_restart_vendor_asks_every_owning_window_and_waits_for_busy_panes_without_forcing(rig) -> None:
    w1, w2, a, b, incident = await _codex_two_windows(rig)
    assert incident["state"] == "waiting-safe"
    state = ok(await call(w1, "quota_failover.get_state", {}, msg_id="st"))
    (tx,) = state["transactions"]
    assert tx["state"] == "preparing" and tx["restartStrategy"] == "resume"
    assert {p["paneId"] for p in tx["panes"]} == {"p1", "p2"}
    # Each window is asked only about its own panes, with a deadline.
    (e1,), (e2,) = prepare_events(w1), prepare_events(w2)
    assert [p["paneId"] for p in e1["payload"]["panes"]] == ["p1"]
    assert [p["paneId"] for p in e2["payload"]["panes"]] == ["p2"]
    assert e1["payload"]["deadlineAt"] == iso(T0 + quota_failover.PREPARE_ACK_DEADLINE_S)
    assert rig.vault.switch_calls == []

    ok(await call(w1, "quota_failover.ack", ready_ack(tx["id"], "p1"), msg_id="a1"))
    busy = ok(await call(w2, "quota_failover.ack",
                         {"transaction_id": tx["id"], "pane_id": "p2", "ready": False, "reason": "busy"}, msg_id="a2"))["transaction"]
    assert busy["state"] == "waiting-safe"
    assert next(p for p in busy["panes"] if p["paneId"] == "p2")["ack"] == "busy"
    assert rig.vault.switch_calls == []  # a busy pane parks the switch; nothing is stopped
    assert w2.terminals.killed == []  # type: ignore[attr-defined]

    # The pane reaches a turn boundary: its window re-acks and the swap runs.
    done = ok(await call(w2, "quota_failover.ack", ready_ack(tx["id"], "p2"), msg_id="a3"))["transaction"]
    assert done["state"] == "committed" and done["swapped"] is True
    assert rig.vault.switch_calls == [("codex", a, b, None)]
    assert rig.store.list()["defaults"]["codex"] == b
    assert w1.terminals.killed == [] and w2.terminals.killed == []  # type: ignore[attr-defined]
    changed = [e for e in rig.events if e["type"] == "cli_profiles.changed"]
    assert changed and changed[-1]["payload"].get("forced") is False
    assert ok(await call(w1, "quota_failover.get_state", {}, msg_id="st2"))["budget"]["codex"]["used"] == 1


async def test_ack_without_resume_proof_or_turn_boundary_is_not_readiness(rig) -> None:
    w1, w2, a, b, _incident = await _codex_two_windows(rig)
    tx_id = ok(await call(w1, "quota_failover.get_state", {}, msg_id="st"))["transactions"][0]["id"]

    # "ready" without naming a resumable session is a refusal, not readiness.
    tx = ok(await call(w1, "quota_failover.ack",
                       {"transaction_id": tx_id, "pane_id": "p1", "ready": True, "idle": "turn-boundary"}, msg_id="a1"))["transaction"]
    assert tx["state"] == "cancelled" and tx["reason"] == "pane-resume-data-missing"
    assert rig.vault.switch_calls == []
    state = ok(await call(w1, "quota_failover.get_state", {}, msg_id="st2"))
    assert state["incidents"] == [] or state["incidents"][0]["state"] == "notify-stopped"
    assert state["budget"]["codex"]["used"] == 0

    # The stopped incident stays the incident: the same exhaustion reported
    # again joins it and does not start a second attempt.
    again = ok(await call(w2, "quota_failover.report", report_payload("codex", "p2", idem="r2"), msg_id="r2"))
    assert again["created"] is False and again["incident"]["state"] == "notify-stopped"
    assert rig.vault.switch_calls == []


async def test_automatic_never_stops_a_pane_on_silence_alone(rig) -> None:
    w1, _w2, _a, _b, _incident = await _codex_two_windows(rig)
    tx_id = ok(await call(w1, "quota_failover.get_state", {}, msg_id="st"))["transactions"][0]["id"]
    tx = ok(await call(w1, "quota_failover.ack",
                       {"transaction_id": tx_id, "pane_id": "p1", "ready": True,
                        "resume": {"resumable": True, "session_id": "s1"}}, msg_id="a1"))["transaction"]
    assert tx["state"] == "cancelled" and tx["reason"] == "pane-idle-unverified"
    assert rig.vault.switch_calls == []


async def test_pane_that_becomes_busy_after_its_ack_is_not_stopped(rig) -> None:
    w1, w2, a, b, _incident = await _codex_two_windows(rig)
    tx_id = ok(await call(w1, "quota_failover.get_state", {}, msg_id="st"))["transactions"][0]["id"]
    ok(await call(w1, "quota_failover.ack", ready_ack(tx_id, "p1"), msg_id="a1"))
    # p2 started a turn after its window judged it idle; the commit re-checks.
    app._record_pane_activity("p2", "agent_active", "")
    tx = ok(await call(w2, "quota_failover.ack", ready_ack(tx_id, "p2"), msg_id="a2"))["transaction"]
    assert tx["state"] == "cancelled" and tx["reason"] == "pane-became-busy"
    assert rig.vault.switch_calls == []
    assert w1.terminals.killed == [] and w2.terminals.killed == []  # type: ignore[attr-defined]


async def test_turning_auto_off_or_cancelling_while_pending_withdraws_the_swap(rig) -> None:
    w1, w2, a, b, _incident = await _codex_two_windows(rig)
    tx_id = ok(await call(w1, "quota_failover.get_state", {}, msg_id="st"))["transactions"][0]["id"]
    ok(await call(w1, "quota_failover.ack", ready_ack(tx_id, "p1"), msg_id="a1"))

    state = await set_policy(w1, "off")
    assert state["transactions"] == []  # the pending automatic proposal is withdrawn
    late = refused(await call(w2, "quota_failover.ack", ready_ack(tx_id, "p2"), msg_id="late"), "BAD_STATE")
    assert "cancelled" in late["message"]
    assert rig.vault.switch_calls == []
    assert rig.store.list()["defaults"]["codex"] == a

    # A second run under notify: the user cancels from the announcement.
    rig.clock.t = T0 + 5
    await set_policy(w1, "notify")
    proposal = {"agent_key": "codex", "to_slot_id": b, "expected_current_slot_id": a,
                "expected_epoch": 0, "idempotency_key": "manual-1"}
    tx2 = ok(await call(w1, "quota_failover.switch", proposal, msg_id="sw"))["transaction"]
    assert tx2["state"] == "preparing"
    cancelled = ok(await call(w1, "quota_failover.cancel", {"transaction_id": tx2["id"]}, msg_id="c"))["transaction"]
    assert cancelled["state"] == "cancelled" and cancelled["reason"] == "user-cancelled"
    refused(await call(w2, "quota_failover.ack", ready_ack(tx2["id"], "p2"), msg_id="late2"), "BAD_STATE")
    assert rig.vault.switch_calls == []


@asynccontextmanager
async def _report_waiting_for_switch_lock(rig, s):
    lock = rig.vault.switch_lock("claude")
    await lock.acquire()
    waiting = asyncio.Event()
    acquire = lock.acquire

    async def observed_acquire():
        waiting.set()
        return await acquire()

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(lock, "acquire", observed_acquire)
        report = asyncio.create_task(call(s, "quota_failover.report", report_payload("claude", "p1", idem="r1")))
        try:
            # Candidate reads run in the vault executor before the commit
            # reaches this lock. Event-loop turns do not bound that work.
            await asyncio.wait_for(waiting.wait(), timeout=5.0)
            yield lock, report
        finally:
            if not report.done():
                report.cancel()
            await asyncio.gather(report, return_exceptions=True)
            if lock.locked():
                lock.release()


async def test_auto_turned_off_while_the_switch_lock_is_held_does_not_swap(rig) -> None:
    """The window between deciding and moving credentials: a hot switch that
    is waiting for the agent's switch lock must re-check the policy once it
    holds the lock and stand down."""
    s = session()
    a, b = two_accounts(rig, "claude", secret=CLAUDE_OK_SECRET)
    add_pane(s, rig, term_id="t1", pane_id="p1", agent_key="claude", slot_id=a, workspace="/ws/a")
    await set_policy(s, "auto")

    async with _report_waiting_for_switch_lock(rig, s) as (lock, report):
        (tx,) = rig.service.transactions.values()
        assert tx.state == "preparing"
        (incident,) = rig.service.incidents.values()
        assert incident.state == "switching" and rig.vault.switch_calls == []

        await set_policy(s, "off")
        lock.release()
        result = ok(await asyncio.wait_for(report, timeout=5.0))
    assert rig.vault.switch_calls == []
    assert rig.store.list()["defaults"]["claude"] == a
    (tx,) = rig.service.transactions.values()
    assert tx.state == "cancelled" and tx.reason == "policy-changed" and tx.swapped is False
    # Nothing is moving any more: the incident must not keep claiming a
    # switch is in progress.
    assert result["incident"]["state"] != "switching"
    assert incident.state != "switching"
    assert ok(await call(s, "quota_failover.get_state", {}, msg_id="st"))["budget"]["claude"]["used"] == 0


async def test_switch_waiting_for_the_lock_proceeds_when_nothing_changed(rig) -> None:
    """The twin of the test above: waiting for the lock is not itself a
    refusal. With the policy untouched the swap runs once the lock frees."""
    s = session()
    a, b = two_accounts(rig, "claude", secret=CLAUDE_OK_SECRET)
    add_pane(s, rig, term_id="t1", pane_id="p1", agent_key="claude", slot_id=a, workspace="/ws/a")
    await set_policy(s, "auto")

    async with _report_waiting_for_switch_lock(rig, s) as (lock, report):
        (tx,) = rig.service.transactions.values()
        assert tx.state == "preparing"
        assert rig.vault.switch_calls == []  # nothing moves while the lock is held
        lock.release()
        result = ok(await asyncio.wait_for(report, timeout=5.0))
    assert result["incident"]["state"] == "settling"
    assert tx.state == "committed" and tx.swapped is True
    assert rig.vault.switch_calls == [("claude", a, b, None)]
    assert ok(await call(s, "quota_failover.get_state", {}, msg_id="st"))["budget"]["claude"]["used"] == 1


# ── settling: what counts as the new account working ─────────────────────────

async def _committed_claude(rig) -> tuple[app.Session, str, str, dict[str, Any]]:
    s = session()
    a, b = two_accounts(rig, "claude", secret=CLAUDE_OK_SECRET)
    add_pane(s, rig, term_id="t1", pane_id="p1", agent_key="claude", slot_id=a, workspace="/ws/a")
    await set_policy(s, "auto")
    ok(await call(s, "quota_failover.report", report_payload("claude", "p1", idem="r1")))
    (tx,) = ok(await call(s, "quota_failover.get_state", {}, msg_id="st"))["transactions"]
    assert tx["state"] == "committed"
    return s, a, b, tx


def incident_state(s: app.Session, rig: SimpleNamespace, incident_id: str) -> str:
    return rig.service.incidents[incident_id].state


async def test_only_a_fresh_positive_reading_of_the_target_after_the_commit_settles(rig) -> None:
    s, a, b, tx = await _committed_claude(rig)
    inc = tx["incidentId"]
    observe = rig.usage._notify_failover  # the poller's hand-off, as it calls it
    rig.clock.t = T0 + 30

    # The outgoing account's reading, however good, says nothing about B.
    observe("claude", a, snapshot(used=10, fetched_at=T0 + 20))
    assert incident_state(s, rig, inc) == "settling"
    # A reading of B taken before the credentials moved is the old view.
    observe("claude", b, snapshot(used=10, fetched_at=T0 - 1))
    assert incident_state(s, rig, inc) == "settling"
    # A stale reading is headroom nobody has confirmed.
    observe("claude", b, snapshot(used=10, fetched_at=T0 + 20, stale=True))
    assert incident_state(s, rig, inc) == "settling"
    # Windows missing or an unrelated per-model bucket prove nothing.
    observe("claude", b, {"status": "ok", "fetchedAt": iso(T0 + 20), "windows": []})
    assert incident_state(s, rig, inc) == "settling"
    # A turn that began under the old account is the old account's work.
    app._record_pane_activity("p1", "turn_complete", "done")
    ok(await call(s, "quota_failover.settle",
                  {"transaction_id": tx["id"], "pane_id": "p1", "outcome": "turn-complete",
                   "turn_started_at": iso(T0 - 5)}, msg_id="old-turn"))
    assert incident_state(s, rig, inc) == "settling"
    refused(await call(s, "quota_failover.settle",
                       {"transaction_id": tx["id"], "pane_id": "p1", "outcome": "healthy"}, msg_id="bad"), "BAD_REQUEST")

    observe("claude", b, snapshot(used=10, fetched_at=T0 + 20))
    assert incident_state(s, rig, inc) == "ready"
    assert rig.service.incidents[inc].reason == "quota-confirmed"
    assert rig.vault.switch_calls == [("claude", a, b, None)]  # settling never switches again


async def test_target_also_exhausted_or_no_evidence_in_time_stops_and_never_retries(rig) -> None:
    s, a, b, tx = await _committed_claude(rig)
    inc = tx["incidentId"]
    rig.clock.t = T0 + 30
    rig.usage._notify_failover("claude", b, snapshot(used=100, fetched_at=T0 + 20, resets_at=T0 + 3600))
    assert incident_state(s, rig, inc) == "notify-stopped"
    assert rig.service.incidents[inc].reason == "target-exhausted"
    assert rig.vault.switch_calls == [("claude", a, b, None)]

    # Settle deadline on a second, separate switch: "switched, unconfirmed".
    rig.store.set_default("claude", a)
    rig.clock.t = T0 + quota_failover.AUTO_MIN_GAP_S + 1
    rig.history.pin("p1", a, rig.clock.t - 1)
    ok(await call(s, "quota_failover.report",
                  report_payload("claude", "p1", idem="r2", at=rig.clock.t), msg_id="r2"))
    (tx2,) = [t for t in rig.service.transactions.values() if t.id != tx["id"]]
    assert tx2.state == "committed"
    await rig.service.tick(f"settle:{tx2.id}")
    inc2 = rig.service.incidents[tx2.incident_id]
    assert inc2.state == "notify-stopped" and inc2.reason == "quota-unconfirmed"
    # Late evidence only updates the record; nothing switches a third time.
    rig.usage._notify_failover("claude", b, snapshot(used=10, fetched_at=rig.clock.t + 5))
    assert len(rig.vault.switch_calls) == 2
    state = ok(await call(s, "quota_failover.get_state", {}, msg_id="st"))
    assert state["budget"]["claude"]["used"] == 2


def find_incident(state: dict[str, Any], incident_id: str) -> dict[str, Any] | None:
    """A closed incident as the announcement panel reads it: from
    ``recentIncidents`` — the public shape the renderer consumes. Any other
    list (debug, history) does not count as visible."""
    return next((row for row in state["recentIncidents"] if row["id"] == incident_id), None)


def find_recent_transaction(state: dict[str, Any], tx_id: str) -> dict[str, Any] | None:
    return next((row for row in state["recentTransactions"] if row["id"] == tx_id), None)


async def test_terminal_states_reach_the_renderer_through_get_state_and_the_changed_event(rig) -> None:
    """ready / notify-stopped close the incident; the window still has to
    show the announcement and offer the manual switch-back, so both the
    broadcast and a reconnecting get_state must carry the final state."""
    s, a, b, tx = await _committed_claude(rig)
    inc = tx["incidentId"]
    rig.clock.t = T0 + 30
    rig.events.clear()
    rig.usage._notify_failover("claude", b, snapshot(used=10, fetched_at=T0 + 20))
    assert rig.service.incidents[inc].state == "ready"
    # observe_usage schedules its broadcast; let it run.
    for _ in range(10):
        await asyncio.sleep(0)
    changed = [e for e in rig.events if e["type"] == "quota_failover.changed"]
    assert changed, "closing the incident as ready must broadcast quota_failover.changed"
    seen = find_incident(changed[-1]["payload"], inc)
    assert seen is not None and seen["state"] == "ready" and seen["reason"] == "quota-confirmed"

    state = ok(await call(s, "quota_failover.get_state", {}, msg_id="st"))
    row = find_incident(state, inc)
    assert row is not None and row["state"] == "ready", state.keys()
    # A switch-back needs to know what to undo: the committed swap stays
    # readable next to its incident, in recentTransactions.
    done = find_recent_transaction(state, tx["id"])
    assert done is not None and done["fromSlotId"] == a and done["toSlotId"] == b and done["swapped"] is True
    assert find_recent_transaction(changed[-1]["payload"], tx["id"]) is not None
    assert row["id"] not in {i["id"] for i in state["incidents"]}  # not still "in progress"

    # The stopped-and-closed shape is visible the same way.
    rig.store.set_default("claude", a)
    rig.clock.t = T0 + quota_failover.AUTO_MIN_GAP_S + 1
    rig.history.pin("p1", a, rig.clock.t - 1)
    ok(await call(s, "quota_failover.report", report_payload("claude", "p1", idem="r2", at=rig.clock.t), msg_id="r2"))
    (tx2,) = [t for t in rig.service.transactions.values() if t.id != tx["id"]]
    rig.events.clear()
    await rig.service.tick(f"settle:{tx2.id}")
    changed = [e for e in rig.events if e["type"] == "quota_failover.changed"]
    assert changed
    seen = find_incident(changed[-1]["payload"], tx2.incident_id)
    assert seen is not None and seen["state"] == "notify-stopped" and seen["reason"] == "quota-unconfirmed"
    state = ok(await call(s, "quota_failover.get_state", {}, msg_id="st2"))
    row = find_incident(state, tx2.incident_id)
    assert row is not None and row["state"] == "notify-stopped" and row["reason"] == "quota-unconfirmed"


def claude_secret(tag: str) -> str:
    return json.dumps({"claudeAiOauth": {
        "accessToken": f"at-{tag}", "refreshToken": f"rt-{tag}", "expiresAt": (T0 + 86_400) * 1000,
    }})


async def test_partial_commit_never_lets_a_later_switch_capture_live_b_into_slot_a(rig, monkeypatch) -> None:
    """Credentials moved A -> B but persisting the default failed: the store
    still says A while B is live. Whatever is asked next — the failover
    route or the legacy manual route — must not "capture the outgoing
    account" into slot A, because the outgoing credential is now B's.
    Refusing until reconciled, or reading the live identity and filing B
    correctly, are both acceptable; overwriting A's only copy is not."""
    s = session()
    secret_a, secret_b = claude_secret("A"), claude_secret("B")
    a = rig.store.create(agent_key="claude", name="A")["id"]
    b = rig.store.create(agent_key="claude", name="B")["id"]
    rig.store.set_default("claude", a)
    rig.vault.slot_secrets[("claude", a)] = secret_a
    rig.vault.slot_secrets[("claude", b)] = secret_b
    rig.vault.live_secret["claude"] = secret_a
    rig.vault.emails = {secret_a: "a@example.com", secret_b: "b@example.com"}
    rig.usage.account_snapshots["claude"] = {
        a: snapshot(used=100, fetched_at=T0 - 60, resets_at=T0 + 3600),
        b: snapshot(used=20, fetched_at=T0 - 60),
    }

    real_set_default = rig.store.set_default
    failures = {"left": 1}

    def flaky_set_default(agent_key: str, profile_id: str | None) -> dict[str, Any]:
        if failures["left"]:
            failures["left"] -= 1
            raise RuntimeError("disk full")
        return real_set_default(agent_key, profile_id)

    monkeypatch.setattr(rig.store, "set_default", flaky_set_default)

    tx = ok(await call(s, "quota_failover.switch",
                       {"agent_key": "claude", "to_slot_id": b, "expected_current_slot_id": a,
                        "expected_epoch": 0, "idempotency_key": "k1"}, msg_id="sw"))["transaction"]
    assert tx["state"] == "partial" and tx["reason"] == "default-persist-failed" and tx["swapped"] is True
    assert rig.vault.live_secret["claude"] == secret_b          # B is what the CLI now uses
    assert rig.vault.slot_secrets[("claude", a)] == secret_a    # A's copy was captured correctly
    assert rig.store.list()["defaults"]["claude"] == a          # ...but the record still says A
    state = ok(await call(s, "quota_failover.get_state", {}, msg_id="st"))
    (visible,) = [t for t in state["transactions"] if t["id"] == tx["id"]]
    assert visible["state"] == "partial" and visible["liveIdentity"] == {"email": "b@example.com", "signedIn": True}

    pending = state["unreconciled"]["claude"]
    assert pending["transactionId"] == tx["id"] and pending["fromSlotId"] == a and pending["toSlotId"] == b
    assert pending["liveSlotId"] == b

    def intact() -> None:
        assert rig.vault.slot_secrets[("claude", a)] == secret_a, "slot A was overwritten with B's live credential"
        assert rig.vault.slot_secrets[("claude", b)] == secret_b
        assert rig.vault.live_secret["claude"] == secret_b
        assert rig.vault.switch_calls == [("claude", a, b, None)]  # nothing moved since the partial swap

    # 1) The legacy manual route and 2) the failover route are both refused
    #    while the record disagrees with what is live; neither captures.
    err = refused(await call(s, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": b}, msg_id="manual"),
                  "UNRECONCILED_STATE")
    assert err["details"]["transactionId"] == tx["id"]
    intact()
    err = refused(await call(s, "quota_failover.switch",
                             {"agent_key": "claude", "to_slot_id": b, "expected_current_slot_id": a,
                              "expected_epoch": rig.service.epoch("claude"), "idempotency_key": "k2"}, msg_id="sw2"),
                  "UNRECONCILED_STATE")
    assert err["details"]["transactionId"] == tx["id"]
    intact()
    assert rig.store.list()["defaults"]["claude"] == a

    # 2b) A backend restart must not forget: the block lives in navide.db,
    #     not in memory. Rebuild the authority on the same database with the
    #     same store / vault / live state and ask the legacy route again.
    restarted = QuotaFailoverService(db=rig.db, now=rig.clock)
    monkeypatch.setattr(app, "quota_failover", restarted)
    rig.service = restarted
    state = ok(await call(s, "quota_failover.get_state", {}, msg_id="st-restart"))
    assert state["unreconciled"]["claude"] == pending, "the unreconciled swap was lost across a restart"
    err = refused(await call(s, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": b}, msg_id="manual2"),
                  "UNRECONCILED_STATE")
    assert err["details"]["transactionId"] == tx["id"]
    intact()
    refused(await call(s, "quota_failover.switch",
                       {"agent_key": "claude", "to_slot_id": b, "expected_current_slot_id": a,
                        "expected_epoch": restarted.epoch("claude"), "idempotency_key": "k3"}, msg_id="sw3"),
            "UNRECONCILED_STATE")
    intact()
    assert rig.store.list()["defaults"]["claude"] == a
    epoch_before = restarted.epoch("claude")

    # 3) The public recovery path. A wrong slot must not become the record:
    #    an unknown id, and a real profile that is not the live account.
    c = rig.store.create(agent_key="claude", name="C")["id"]
    rig.vault.slot_secrets[("claude", c)] = claude_secret("C")
    for bad, msg_id in (("nope", "rc-unknown"), (c, "rc-wrong")):
        answer = await call(s, "quota_failover.reconcile",
                            {"agent_key": "claude", "transaction_id": tx["id"], "live_slot_id": bad}, msg_id=msg_id)
        assert answer["ok"] is False, (bad, answer)
        assert rig.store.list()["defaults"]["claude"] == a, f"reconcile wrote {bad!r} into the record"
        assert ok(await call(s, "quota_failover.get_state", {}, msg_id=f"{msg_id}-st"))["unreconciled"]["claude"] == pending
        intact()
    refused(await call(s, "quota_failover.reconcile", {"agent_key": "claude", "transaction_id": "zzz"}, msg_id="rc-tx"), "NOT_FOUND")
    intact()

    rig.events.clear()
    done = ok(await call(s, "quota_failover.reconcile", {"agent_key": "claude", "transaction_id": tx["id"]}, msg_id="rc"))
    assert done["liveSlotId"] == b
    intact()  # reconciling moves no credential
    assert rig.store.list()["defaults"]["claude"] == b
    state = ok(await call(s, "quota_failover.get_state", {}, msg_id="st3"))
    assert "claude" not in state["unreconciled"]
    assert state["epochs"]["claude"] == epoch_before + 1  # a stale proposal cannot commit after this
    assert {e["type"] for e in rig.events} >= {"cli_profiles.changed", "quota_failover.changed"}
    assert not any(t["id"] == tx["id"] for t in state["transactions"])  # no longer pending
    # The recovery is durable too: another restart sees nothing pending.
    assert "claude" not in QuotaFailoverService(db=rig.db, now=rig.clock).state()["unreconciled"]

    # 4) With the record honest again, switching back A <- B is an ordinary
    #    manual switch: B's live credential is captured into B's own slot
    #    and A's copy comes back untouched.
    ok(await call(s, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": a}, msg_id="back"))
    assert rig.vault.switch_calls[-1] == ("claude", b, a, None)
    assert rig.vault.live_secret["claude"] == secret_a
    assert rig.vault.slot_secrets[("claude", a)] == secret_a
    assert rig.vault.slot_secrets[("claude", b)] == secret_b
    assert rig.store.list()["defaults"]["claude"] == a


# ── deadlines fire from the event loop itself ─────────────────────────────────

async def test_deadlines_fire_without_polling_or_a_renderer(rig, monkeypatch) -> None:
    """The prepare and settle deadlines are ``loop.call_later`` timers armed
    by the handlers themselves: nothing polls, no usage reading and no
    renderer request is needed for a stuck transaction to time out. This
    lets the real timer fire (short deadlines) instead of calling ``tick``."""
    monkeypatch.setattr(quota_failover, "SETTLE_TIMEOUT_S", 0.05)
    monkeypatch.setattr(quota_failover, "PREPARE_ACK_DEADLINE_S", 0.05)

    # Hot: committed, no reading ever arrives (a vendor without fetch_usage).
    s, a, b, tx = await _committed_claude(rig)
    assert f"settle:{tx['id']}" in rig.service._timers
    await asyncio.sleep(0.3)
    inc = rig.service.incidents[tx["incidentId"]]
    assert inc.state == "notify-stopped" and inc.reason == "quota-unconfirmed"
    assert f"settle:{tx['id']}" not in rig.service._timers
    assert [e for e in rig.events if e["type"] == "quota_failover.changed"]

    # Restart: prepare sent, the owning window never answers.
    rig.events.clear()
    w1, _w2, _a2, _b2, incident = await _codex_two_windows(rig)
    (tx2,) = [t for t in rig.service.transactions.values() if t.agent_key == "codex"]
    assert tx2.state == "preparing" and tx2.id in rig.service._timers
    await asyncio.sleep(0.3)
    assert tx2.state == "cancelled" and tx2.reason == "prepare-timeout"
    assert rig.service.incidents[incident["id"]].state == "notify-stopped"
    assert rig.vault.switch_calls == [("claude", a, b, None)]  # codex never swapped
    state = ok(await call(w1, "quota_failover.get_state", {}, msg_id="st"))
    assert state["transactions"] == []


# ── per-provider store: default -> A -> default ──────────────────────────────

async def test_multi_scope_switch_moves_one_provider_entry_and_manual_costs_no_budget(rig) -> None:
    s = session()
    a = rig.store.create(agent_key="opencode", name="A", scope="anthropic")["id"]
    rig.vault.slot_secrets[("opencode", a)] = "anthropic-a"
    rig.vault.slot_secrets[("opencode", DEFAULT_SLOT_ID)] = "anthropic-default"
    rig.vault.live["opencode"] = {"anthropic": "live-anthropic-default", "openai": "live-openai"}
    rig.vault.parked[("opencode", a, "anthropic")] = "parked-anthropic-a"
    assert "scope" in inspect.signature(rig.vault.switch).parameters

    proposal = {"agent_key": "opencode", "to_slot_id": a, "expected_current_slot_id": DEFAULT_SLOT_ID,
                "expected_epoch": 0, "idempotency_key": "d-a"}
    tx = ok(await call(s, "quota_failover.switch", proposal, msg_id="1"))["transaction"]
    assert tx["state"] == "committed" and tx["authScope"] == "opencode:anthropic"
    assert rig.vault.switch_calls == [("opencode", DEFAULT_SLOT_ID, a, "anthropic")]
    assert rig.vault.live["opencode"] == {"anthropic": "parked-anthropic-a", "openai": "live-openai"}
    assert rig.store.list()["defaults"]["opencode"] == a

    back = {"agent_key": "opencode", "to_slot_id": DEFAULT_SLOT_ID, "expected_current_slot_id": a,
            "expected_epoch": 1, "idempotency_key": "a-d"}
    tx2 = ok(await call(s, "quota_failover.switch", back, msg_id="2"))["transaction"]
    assert tx2["state"] == "committed" and tx2["authScope"] == "opencode:anthropic"
    assert rig.vault.switch_calls[-1] == ("opencode", a, DEFAULT_SLOT_ID, "anthropic")
    # The other provider's entry never moved in either direction.
    assert rig.vault.live["opencode"] == {"anthropic": "live-anthropic-default", "openai": "live-openai"}
    assert rig.store.list()["defaults"]["opencode"] is None

    state = ok(await call(s, "quota_failover.get_state", {}, msg_id="st"))
    assert state["budget"]["opencode:anthropic"]["used"] == 0
    assert state["epochs"]["opencode"] == 2
    history = rig.service.store.history("opencode")
    assert [h["automatic"] for h in history] == [False, False]
    assert all(h["swapped"] for h in history)
