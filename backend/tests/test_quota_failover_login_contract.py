"""Add account -> sign in -> capture -> switch: does the flow protect the
account that was active before the sign-in?

Driven through the real handlers (``app.handle_message``), the real
``CredentialVault`` the conftest roots in tmp (its Keychain is an in-memory
stand-in, never the real one) and the real usage-poller harvest. The CLI's
own sign-in is the only thing simulated: it is modelled as the write the CLI
makes to wherever the vault told the login pane to run — the isolated login
home when ``login_spawn_env`` gives one, the live credential store when it
gives none.

Plan: .agent-team/plans/quota-exhaustion-auto-switch_7b3e91.html — Phase V
("only exchange credentials; a candidate whose login is unknown must never
be restored as an empty credential") and the vault's own promise that an
account switch never loses the outgoing account.
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, quota_failover, usage_service, ws_handlers
from agent_team_backend.credential_vault import LiveCredentials
from agent_team_backend.db import Database
from agent_team_backend.profiles_store import CliProfilesStore
from agent_team_backend.quota_failover import QuotaFailoverService


async def test_scoped_login_watch_harvests_completed_login(rig, monkeypatch):
    profile = rig.store.create(agent_key="pi", name="Scoped", scope="xai")
    slot = profile["id"]
    rig.vault.login_spawn_env("pi", slot, scope="xai")
    home = rig.vault.login_home_path("pi", slot)
    (home / "auth.json").write_text(json.dumps({"xai": {"type": "oauth", "access": "NEW"}}), encoding="utf-8")
    ticks = iter([0.0, 0.0, 11.0])
    monkeypatch.setattr(usage_service, "time", SimpleNamespace(monotonic=lambda: next(ticks)))
    monkeypatch.setattr(usage_service, "LOGIN_WATCH_TIMEOUT_SEC", 10)
    monkeypatch.setattr(usage_service, "LOGIN_WATCH_INTERVAL_SEC", 0)
    await usage_service._login_watch("pi", slot)
    assert rig.vault.read_slot("pi", slot, scope="xai").secret is not None
    assert not home.exists()


async def test_scoped_active_profile_relogin_restores_live(rig):
    profile = rig.store.create(agent_key="pi", name="Scoped", scope="xai")
    slot = profile["id"]
    old = LiveCredentials(secret=json.dumps({"type": "oauth", "access": "OLD"}))
    other = LiveCredentials(secret=json.dumps({"type": "oauth", "access": "OTHER"}))
    rig.vault.write_slot("pi", slot, old, scope="xai")
    rig.vault.write_live("pi", old, scope="xai")
    rig.vault.write_live("pi", other, scope="anthropic")
    rig.store.set_default("pi", slot)
    rig.vault.login_spawn_env("pi", slot, scope="xai")
    home = rig.vault.login_home_path("pi", slot)
    (home / "auth.json").write_text(json.dumps({"xai": {"type": "oauth", "access": "NEW"}}), encoding="utf-8")
    assert await usage_service._harvest_login_home_locked(rig.vault, "pi", slot)
    assert json.loads(rig.vault.read_live("pi", scope="xai").secret)["access"] == "NEW"
    assert json.loads(rig.vault.read_live("pi", scope="anthropic").secret)["access"] == "OTHER"


async def test_rejected_duplicate_live_login_preserves_snapshot_bytes(rig):
    s = session()
    rig.vault.write_live("kilo", LiveCredentials(secret=secret("kilo", "A")))
    slot = rig.store.create(agent_key="kilo", name="B")["id"]
    assert (await spawn_login_pane(s, "kilo", slot))["ok"]
    snapshot = rig.vault._pre_login_snapshot_path("kilo", slot)
    original_bytes = snapshot.read_bytes()
    register_login_pane(s, "kilo", slot)
    term = s.terminals.registry["login-1"]
    term.metadata["live_login"] = True
    rig.vault.write_live("kilo", LiveCredentials(secret=secret("kilo", "B")))
    duplicate = await spawn_login_pane(s, "kilo", slot, msg_id="duplicate")
    assert not duplicate["ok"] and duplicate["error"]["code"] == "LOGIN_BLOCKED_BY_LIVE_PANES"
    assert snapshot.exists() and snapshot.read_bytes() == original_bytes
    term.closed = True
    assert await usage_service._harvest_login_home_locked(rig.vault, "kilo", slot)
    assert same(rig.vault.read_live("kilo").secret, secret("kilo", "A"))
    assert same(rig.vault.read_slot("kilo", slot).secret, secret("kilo", "B"))


@pytest.mark.parametrize("competitor", ["same-profile", "other-profile", "regular"])
async def test_live_login_reserves_store_under_spawn_lock(rig, monkeypatch, competitor):
    s = session()
    second_session = session()
    rig.vault.write_live("kilo", LiveCredentials(secret=secret("kilo", "A")))
    slot = rig.store.create(agent_key="kilo", name="B")["id"]
    other = rig.store.create(agent_key="kilo", name="C")["id"]
    waiting = asyncio.Event()

    class ObservedLock(asyncio.Lock):
        async def acquire(self):
            if self.locked():
                waiting.set()
            return await super().acquire()

    lock = ObservedLock()
    monkeypatch.setattr(rig.vault, "switch_lock", lambda _agent: lock)
    entered, release = threading.Event(), threading.Event()
    snapshots = []
    original = rig.vault.login_spawn_env

    def paused(*args, **kwargs):
        assert lock.locked()
        result = original(*args, **kwargs)
        snapshots.append(rig.vault._pre_login_snapshot_path("kilo", slot).read_bytes())
        entered.set()
        assert release.wait(5)
        return result

    monkeypatch.setattr(rig.vault, "login_spawn_env", paused)
    tasks = [asyncio.create_task(spawn_login_pane(s, "kilo", slot))]
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        if competitor == "regular":
            request = call(s, "terminal.create", {
                "agent_key": "kilo", "pane_id": "regular-new", "cwd": "/ws",
                "command": ["kilo"], "cols": 80, "rows": 24,
            }, msg_id="competitor")
        else:
            request = spawn_login_pane(second_session, "kilo", slot if competitor == "same-profile" else other,
                                       msg_id="competitor")
        tasks.append(asyncio.create_task(request))
        await asyncio.wait_for(waiting.wait(), 2)
        release.set()
        first, second = await asyncio.gather(*tasks)
        assert first["ok"] and not second["ok"]
        assert second["error"]["code"] == (
            "LOGIN_IN_PROGRESS" if competitor == "regular" else "LOGIN_BLOCKED_BY_LIVE_PANES")
        assert len(s.terminals.created) == 1
        assert not second_session.terminals.created
        assert len(snapshots) == 1
        assert rig.vault._pre_login_snapshot_path("kilo", slot).read_bytes() == snapshots[0]
        assert not rig.vault.login_pending("kilo", other)
    finally:
        release.set()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    assert not lock.locked()


async def test_login_lock_timeout_responds_without_snapshot_or_pty(rig, monkeypatch):
    slot = rig.store.create(agent_key="kilo", name="B")["id"]
    lock = rig.vault.switch_lock("kilo")
    await lock.acquire()
    monkeypatch.setattr(ws_handlers, "_SWITCH_LOCK_TIMEOUT_SEC", 0.01)
    s = session()
    try:
        answer = await spawn_login_pane(s, "kilo", slot)
        assert not answer["ok"]
        assert not s.terminals.created
        assert not rig.vault.login_pending("kilo", slot)
        assert not s._terminal_create_transactions
        assert lock.locked()  # A failed waiter must not release somebody else's lock.
    finally:
        lock.release()


async def test_manual_hot_switch_announces_only_proven_vault_panes(rig):
    first, second = session(), session()
    old = active_account(rig, "claude")
    target = rig.store.create(agent_key="claude", name="B")["id"]
    rig.vault.write_slot("claude", target, LiveCredentials(secret=secret("claude", "B")))
    panes = []
    sources = ("vault", "vault", "env-override", "portable", "unknown", "vault", "vault", "vault")
    for index, source in enumerate(sources):
        owner = first if index % 2 == 0 else second
        term = SimpleNamespace(id=f"term-{index}", pane_id=f"pane-{index}", agent_key="claude", closed=False,
                               metadata={"workspace_path": "/ws", "launch_profile_id": old,
                                         "auth_scope": "claude", "credential_source": source})
        if index == 5:
            term.metadata["login_profile_id"] = "another-login"
        if index == 6:
            term.metadata["auth_scope"] = "other-pool"
        if index == 7:
            term.closed = True
        owner.terminals.registry[term.id] = term
        app._PTY_OWNERS[term.id] = owner
        app.pane_account_history.pin(term.pane_id, old)
        panes.append(term)
    answer = await call(first, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": target})
    assert answer["ok"], answer
    changed = [e["payload"] for e in rig.events if e["type"] == "cli_profiles.changed"][-1]
    assert changed["hotSwitchedPanes"] == [
        {"paneId": "pane-0", "termId": "term-0", "profileId": target},
        {"paneId": "pane-1", "termId": "term-1", "profileId": target},
    ]
    assert [p.metadata["launch_profile_id"] for p in panes] == [target, target] + [old] * 6
    assert app.pane_account_history.profile_at("pane-0", float("inf")) == target
    assert app.pane_account_history.profile_at("pane-2", float("inf")) == old
    before = len(rig.events)
    noop = await call(first, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": target}, msg_id="noop")
    assert noop["ok"] and len(rig.events) == before
    rejected = await call(first, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": "absent"}, msg_id="bad")
    assert not rejected["ok"] and len(rig.events) == before
    rig.vault.write_slot("claude", "__default__", LiveCredentials(secret=secret("claude", "Default")))
    default = await call(first, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": None}, msg_id="default")
    assert default["ok"]
    changed = [e["payload"] for e in rig.events if e["type"] == "cli_profiles.changed"][-1]
    assert [row["profileId"] for row in changed["hotSwitchedPanes"]] == [None, None]


async def test_manual_hot_broadcast_drops_rows_overtaken_by_another_window(rig, monkeypatch):
    first, second = session(), session()
    old = active_account(rig, "claude")
    b, c = (rig.store.create(agent_key="claude", name=name)["id"] for name in ("B", "C"))
    for slot in (b, c):
        rig.vault.write_slot("claude", slot, LiveCredentials(secret=secret("claude", slot)))
    term = SimpleNamespace(id="term", pane_id="pane", agent_key="claude", closed=False,
                           metadata={"launch_profile_id": old, "auth_scope": "claude", "credential_source": "vault"})
    first.terminals.registry[term.id] = term
    app._PTY_OWNERS[term.id] = first
    reached, release = asyncio.Event(), asyncio.Event()

    async def broadcast(event, **_kwargs):
        rig.events.append(event)
        if event["type"] == "quota_failover.changed" and not reached.is_set():
            reached.set()
            await release.wait()

    monkeypatch.setattr(app, "broadcast", broadcast)
    pending = asyncio.create_task(call(first, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": b}))
    try:
        await asyncio.wait_for(reached.wait(), 1)
        assert (await call(second, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": c}))["ok"]
        release.set()
        assert (await pending)["ok"]
    finally:
        release.set()
        if not pending.done():
            pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
    changed = [event["payload"] for event in rig.events if event["type"] == "cli_profiles.changed"]
    assert len(changed) == 2
    assert [event["defaults"]["claude"] for event in changed] == [c, c]
    assert changed[0]["hotSwitchedPanes"] == [{"paneId": "pane", "termId": "term", "profileId": c}]
    assert changed[1]["hotSwitchedPanes"] == []
    assert term.metadata["launch_profile_id"] == c
    assert app.pane_account_history.profile_at("pane", float("inf")) == c

# Per-vendor credential payloads in the shape the vault stores for that
# vendor's credential store (a Keychain item map, a pointer entry, a file).
# Fake values throughout; nothing here is a real token.
def secret(agent_key: str, tag: str) -> str:
    from agent_team_backend.cli_vendors.registry import vendor

    switch = vendor(agent_key).account_switch
    if switch.store == "keychain":
        items = {f"{service}|{account}": f"token-{tag}" for service, account in switch.keychain_items}
        return json.dumps({"keychain": items}, separators=(",", ":"))
    if agent_key == "copilot":
        return json.dumps({"host": "github.com", "login": f"user-{tag}"})
    return json.dumps({"token": f"account-{tag}"})


def same(stored: str | None, expected: str) -> bool:
    """The vault may re-serialise a payload it merged; compare the data."""
    return stored is not None and json.loads(stored) == json.loads(expected)

# Vendors whose login pane gets no isolated home (``login_spawn_env`` answers
# ``({}, [])``): the sign-in runs against the real credential store.
NO_ISOLATION = [
    "copilot",
    # kilo shipped this way before the adapter round: same class, kept as the
    # regression row for the behaviour that already existed.
    "kilo",
    pytest.param("cursor", marks=pytest.mark.skipif(
        sys.platform != "darwin", reason="cursor keeps its credential only in the macOS Keychain")),
]


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.registry: dict[str, SimpleNamespace] = {}
        self.created: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        return SimpleNamespace(id=f"term-{len(self.created)}", pane_id=kwargs["pane_id"],
                               command=kwargs["command"], proc=SimpleNamespace(pid=4321))

    def get(self, session_id: str) -> SimpleNamespace | None:
        return self.registry.get(session_id)

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


@pytest.fixture()
def rig(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    db = Database(tmp_path / "navide.db")
    store = CliProfilesStore(path=tmp_path / "cli-profiles.json", profiles_root=tmp_path / "profiles", db=db)
    monkeypatch.setattr(app, "cli_profiles_store", store)
    service = QuotaFailoverService(db=db)
    monkeypatch.setattr(app, "quota_failover", service)
    # claude's display identity lives in <real home>/.claude.json; the conftest
    # vault points the real home at tmp but does not create it.
    Path(app.credential_vault._real_home).mkdir(parents=True, exist_ok=True)
    events: list[dict[str, Any]] = []

    async def record(event: dict[str, Any], *, exclude: Any = None) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", record)
    usage = usage_service.service

    async def announce_claude(slot: Any, *, reading: bool = True) -> None:
        pass

    monkeypatch.setattr(usage, "announce_claude_switch", announce_claude)
    # terminal.create wiring that a login-pane spawn touches; no real CLI, no PTY.
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn",
                        lambda agent_key, _command=None: {"agent_key": agent_key, "binary_path": f"/test/bin/{agent_key}",
                                                          "version": "1.0.0", "duration_ms": 1})
    monkeypatch.setattr(app, "attribution", SimpleNamespace(register_pane=lambda *a, **k: None,
                                                            scan_pane_baseline=lambda *a, **k: None))
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(usage, "request_refresh", lambda *a, **k: None)
    monkeypatch.setattr(usage_service, "start_login_watch", lambda *a, **k: None)
    return SimpleNamespace(store=store, vault=app.credential_vault, usage=usage, events=events, service=service)


def session() -> app.Session:
    s = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    s.terminals = FakeTerminals()  # type: ignore[assignment]
    return s


async def call(s: app.Session, msg_type: str, payload: dict[str, Any], msg_id: str = "m") -> dict[str, Any]:
    before = len(s.websocket.sent)  # type: ignore[attr-defined]
    await app.handle_message(s, {"id": msg_id, "type": msg_type, "payload": payload})
    answers = [f for f in s.websocket.sent[before:] if f.get("id") == msg_id]  # type: ignore[attr-defined]
    assert len(answers) == 1, answers
    return answers[0]


def active_account(rig: SimpleNamespace, agent_key: str) -> str:
    """Profile A, signed in and active, exactly as a completed switch leaves
    it: its credential is live AND mirrored into its slot."""
    a = rig.store.create(agent_key=agent_key, name="A")["id"]
    rig.store.set_default(agent_key, a)
    rig.vault.write_live(agent_key, LiveCredentials(secret=secret(agent_key, "A")))
    rig.vault.capture(agent_key, a)
    assert same(rig.vault.read_slot(agent_key, a).secret, secret(agent_key, "A"))
    return a


def register_login_pane(s: app.Session, agent_key: str, profile_id: str, term_id: str = "login-1") -> None:
    term = SimpleNamespace(id=term_id, pane_id="p-login", agent_key=agent_key, closed=False,
                           metadata={"login_profile_id": profile_id})
    s.terminals.registry[term_id] = term  # type: ignore[attr-defined]
    app._PTY_OWNERS[term_id] = s


def register_regular_pane(s: app.Session, agent_key: str, term_id: str = "work-1") -> None:
    term = SimpleNamespace(id=term_id, pane_id="p-work", agent_key=agent_key, closed=False, metadata={})
    s.terminals.registry[term_id] = term  # type: ignore[attr-defined]
    app._PTY_OWNERS[term_id] = s


async def spawn_login_pane(s: app.Session, agent_key: str, profile_id: str, msg_id: str = "spawn") -> dict[str, Any]:
    """What the Accounts pane's "Add account" does: a terminal.create with
    login_profile_id, the CLI itself replaced by the spawn stubs."""
    return await call(s, "terminal.create", {
        "pane_id": f"{agent_key}-login", "agent_key": agent_key, "command": agent_key,
        "cwd": "/ws", "metadata": {"workspace_path": "/ws"}, "login_profile_id": profile_id,
    }, msg_id=msg_id)


# ── what the vault declares ───────────────────────────────────────────────────

@pytest.mark.parametrize("agent_key", NO_ISOLATION)
def test_these_vendors_sign_in_against_the_live_store(rig, agent_key: str) -> None:
    """No env lever: the pane signs in against the live store. What the
    vault keeps for such a login is only its bookkeeping (the pre-login
    snapshot of the active account), never a credential file the CLI wrote."""
    active_account(rig, agent_key)
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    assert rig.vault.login_spawn_env(agent_key, b) == ({}, [])
    assert rig.vault.login_secret_present(agent_key, b) is False  # nothing signed in yet
    assert rig.vault.slot_is_empty(agent_key, b)


@pytest.mark.parametrize("agent_key", ["codex", "droid"])
def test_these_vendors_get_an_isolated_login_home(rig, agent_key: str) -> None:
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    env_set, _removed = rig.vault.login_spawn_env(agent_key, b)
    home = rig.vault.login_home_path(agent_key, b)
    assert home.is_dir()
    assert list(env_set.values()) == [str(home)] or str(home) in env_set.values()


# ── the flow ──────────────────────────────────────────────────────────────────

async def test_isolated_login_keeps_the_active_account_intact(rig) -> None:
    """Positive control (codex): the sign-in lands in the login home, the
    switch harvests it into B's slot, captures A into A's slot and brings B
    live. Nothing of A is lost."""
    s = session()
    agent_key = "codex"
    a = active_account(rig, "codex")
    b = rig.store.create(agent_key="codex", name="B")["id"]
    env_set, _ = rig.vault.login_spawn_env("codex", b)
    home = Path(env_set["CODEX_HOME"])
    (home / "auth.json").write_text(secret(agent_key, "B"), encoding="utf-8")  # what `codex login` writes there
    assert same(rig.vault.read_live("codex").secret, secret(agent_key, "A"))  # the live account was never touched

    await rig.usage._harvest_active_slots()  # the poller may run before the switch
    assert same(rig.vault.read_slot("codex", a).secret, secret(agent_key, "A"))

    answer = await call(s, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b})
    assert answer["ok"] is True and answer["payload"]["needsLogin"] is False, answer
    assert same(rig.vault.read_live("codex").secret, secret(agent_key, "B"))
    assert same(rig.vault.read_slot("codex", a).secret, secret(agent_key, "A"))
    assert same(rig.vault.read_slot("codex", b).secret, secret(agent_key, "B"))
    assert not home.is_dir()


@pytest.mark.parametrize("agent_key", NO_ISOLATION)
async def test_add_account_login_must_not_cost_the_active_account(rig, agent_key: str) -> None:
    """Same flow for a vendor without login isolation. The contract is the
    same: after "Add account -> sign in as B -> switch to B", A's credential
    is still in A's slot and B's is live. However the product gets there —
    capturing A before the sign-in, harvesting B into B's slot afterwards, or
    refusing the flow up front — it must not end with A overwritten by B's
    credential and B's slot empty."""
    s = session()
    a = active_account(rig, agent_key)
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    assert rig.vault.login_spawn_env(agent_key, b) == ({}, [])
    # The login pane runs against the live store: completing the sign-in
    # replaces the live credential (A's) with B's.
    rig.vault.write_live(agent_key, LiveCredentials(secret=secret(agent_key, "B")))
    assert same(rig.vault.read_live(agent_key).secret, secret(agent_key, "B"))

    await rig.usage._harvest_active_slots()
    # Whatever the harvest did, A's own copy must still be A's...
    assert same(rig.vault.read_slot(agent_key, a).secret, secret(agent_key, "A")), "the poller mirrored B's live credential into A's slot"

    answer = await call(s, "cli_profiles.set_default", {"agent_key": agent_key, "profile_id": b})
    assert same(rig.vault.read_slot(agent_key, a).secret, secret(agent_key, "A")), \
        "switching to B captured B's live credential into A's slot — A's only copy is gone"
    if answer["ok"]:
        assert same(rig.vault.read_live(agent_key).secret, secret(agent_key, "B")), \
            "the switch signed the user out: B's slot was empty, so restoring it cleared the live credential"
        assert same(rig.vault.read_slot(agent_key, b).secret, secret(agent_key, "B"))


@pytest.mark.parametrize("agent_key", NO_ISOLATION)
async def test_live_login_is_refused_while_other_panes_of_the_agent_run(rig, agent_key: str) -> None:
    """A sign-in without isolation replaces the credential every running pane
    of this CLI is using. With such a pane alive the login pane must not be
    spawned (the same quiescence the account switch enforces), and the live
    credential must be untouched by the attempt."""
    s = session()
    a = active_account(rig, agent_key)
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    register_regular_pane(s, agent_key)

    answer = await spawn_login_pane(s, agent_key, b)
    assert answer["ok"] is False, answer
    assert answer["error"]["code"] == "LOGIN_BLOCKED_BY_LIVE_PANES"
    assert answer["error"]["details"]["count"] == 1
    assert s.terminals.created == []  # type: ignore[attr-defined]
    # The refused spawn leaves no "login pending" bookkeeping behind.
    assert rig.vault.login_pending(agent_key, b) is False
    assert same(rig.vault.read_live(agent_key).secret, secret(agent_key, "A"))
    assert same(rig.vault.read_slot(agent_key, a).secret, secret(agent_key, "A"))
    assert rig.store.list()["defaults"][agent_key] == a


@pytest.mark.parametrize("wrote", [False, True], ids=["closed-before-signing-in", "signed-in-then-removed"])
@pytest.mark.parametrize("agent_key", NO_ISOLATION)
async def test_cancelling_a_live_login_keeps_the_active_account(rig, agent_key: str, wrote: bool) -> None:
    """The user abandons "Add account": the login pane is closed, then the
    empty row is removed. Whether or not the CLI had already written B's
    credential over the live store, the outcome is the state before the
    attempt: A live, A's slot intact, no leftover bookkeeping."""
    s = session()
    a = active_account(rig, agent_key)
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    assert rig.vault.login_spawn_env(agent_key, b) == ({}, [])
    if wrote:
        rig.vault.write_live(agent_key, LiveCredentials(secret=secret(agent_key, "B")))
    # The login pane is gone (closed or exited); nothing of it is running.

    answer = await call(s, "cli_profiles.delete", {"id": b}, msg_id="rm")
    assert answer["ok"] is True, answer
    assert same(rig.vault.read_live(agent_key).secret, secret(agent_key, "A")), \
        "removing the abandoned account left B's credential live under A's record"
    assert same(rig.vault.read_slot(agent_key, a).secret, secret(agent_key, "A"))
    assert rig.store.list()["defaults"][agent_key] == a
    assert not rig.vault.login_home_path(agent_key, b).is_dir()
    assert b not in [p["id"] for p in rig.store.list()["profiles"]]


@pytest.mark.parametrize("agent_key", ["codex", *NO_ISOLATION])
async def test_switching_while_the_sign_in_pane_still_runs_is_refused(rig, agent_key: str) -> None:
    """A running sign-in pane for the target account means its credential is
    still being written. The switch must wait (LOGIN_IN_PROGRESS), for every
    vendor — not only for those whose login has a home to harvest."""
    s = session()
    a = active_account(rig, agent_key)
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    rig.vault.login_spawn_env(agent_key, b)
    register_login_pane(s, agent_key, b)

    answer = await call(s, "cli_profiles.set_default", {"agent_key": agent_key, "profile_id": b})
    assert answer["ok"] is False and answer["error"]["code"] == "LOGIN_IN_PROGRESS", answer
    assert same(rig.vault.read_live(agent_key).secret, secret(agent_key, "A"))
    assert same(rig.vault.read_slot(agent_key, a).secret, secret(agent_key, "A"))
    assert rig.store.list()["defaults"][agent_key] == a


# ── live drift: a token refresh is not a different account ───────────────────

def _jwt(email: str) -> str:
    import base64

    def b64(obj: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")
    return f"{b64({'alg': 'none'})}.{b64({'email': email})}.sig"


def identity_secret(agent_key: str, who: str, generation: int, account_id: str | None = None) -> LiveCredentials:
    """A credential whose *tokens* change with ``generation`` (what an OAuth
    refresh does) while its identity stays ``who``. claude keeps the identity
    beside the secret (``oauthAccount``); codex carries it inside the secret
    (the id_token's email)."""
    if agent_key == "claude":
        secret = json.dumps({"claudeAiOauth": {
            "accessToken": f"at-{who}-{generation}", "refreshToken": f"rt-{who}-{generation}",
            "expiresAt": (T0 + 86_400 * generation) * 1000,
        }})
        account: dict[str, Any] = {"emailAddress": f"{who}@example.com"}
        if account_id is not None:
            # ~/.claude.json oauthAccount, kept whole beside the secret by the
            # vault: the organisation the login belongs to. One email can be
            # a member of several organisations, each with its own quota.
            account["accountUuid"] = f"user-{who}"
            account["organizationUuid"] = account_id
        return LiveCredentials(secret=secret, account=account)
    tokens: dict[str, Any] = {
        "access_token": f"at-{who}-{generation}", "refresh_token": f"rt-{who}-{generation}",
        "id_token": _jwt(f"{who}@example.com"),
    }
    if account_id is not None:
        # codex auth.json: the ChatGPT account the tokens belong to
        # (cli_vendors/codex.py reads tokens.account_id for the
        # ChatGPT-Account-Id header) — stable across refreshes, and different
        # for a personal and a team pool that share one email.
        tokens["account_id"] = account_id
    secret = json.dumps({"tokens": tokens, "last_refresh": f"2026-09-21T00:0{generation}:00Z"})
    return LiveCredentials(secret=secret)


T0 = 1_800_000_000


def _tokens(secret: str | None) -> str:
    """The access token of a credential, whichever vendor shape it is in."""
    data = json.loads(secret or "{}")
    return data.get("claudeAiOauth", data.get("tokens", {})).get("accessToken") \
        or data.get("tokens", {}).get("access_token")


@pytest.mark.parametrize("agent_key", ["claude", "codex"])
async def test_a_refreshed_token_of_the_same_account_still_switches_and_is_kept(rig, agent_key: str) -> None:
    """The CLI refreshed A's OAuth tokens since the last switch: the live
    credential differs byte-for-byte from A's slot, but it is still A. A
    switch to B must go ahead and must keep A's *refreshed* tokens."""
    s = session()
    a = rig.store.create(agent_key=agent_key, name="A")["id"]
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    rig.store.set_default(agent_key, a)
    rig.vault.write_live(agent_key, identity_secret(agent_key, "a", 1))
    rig.vault.capture(agent_key, a)                                   # slot A = generation 1
    rig.vault.write_slot(agent_key, b, identity_secret(agent_key, "b", 1))
    rig.vault.write_live(agent_key, identity_secret(agent_key, "a", 2))  # A refreshed itself
    assert rig.vault.identity(agent_key)["email"] == "a@example.com"

    answer = await call(s, "cli_profiles.set_default", {"agent_key": agent_key, "profile_id": b})
    assert answer["ok"] is True, answer.get("error")
    assert answer["payload"].get("adoptedLiveLogin") is not True
    assert _tokens(rig.vault.read_live(agent_key).secret) == "at-b-1"
    assert _tokens(rig.vault.read_slot(agent_key, a).secret) == "at-a-2", "A's refreshed tokens were not kept"
    assert rig.vault.identity(agent_key, a)["email"] == "a@example.com"
    assert rig.store.list()["defaults"][agent_key] == b


@pytest.mark.parametrize("agent_key", ["claude", "codex"])
async def test_a_different_live_identity_does_not_block_a_manual_switch(rig, agent_key: str) -> None:
    """Someone signed in as C against the live store while the record still
    says A: a manual switch to (non-empty) B still goes through — the user's
    pick wins — and reports the drift as a warning."""
    s = session()
    a = rig.store.create(agent_key=agent_key, name="A")["id"]
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    rig.store.set_default(agent_key, a)
    rig.vault.write_live(agent_key, identity_secret(agent_key, "a", 1))
    rig.vault.capture(agent_key, a)
    rig.vault.write_slot(agent_key, b, identity_secret(agent_key, "b", 1))
    rig.vault.write_live(agent_key, identity_secret(agent_key, "c", 1))
    assert rig.vault.identity(agent_key)["email"] == "c@example.com"

    answer = await call(s, "cli_profiles.set_default", {"agent_key": agent_key, "profile_id": b})
    assert answer["ok"] is True, answer.get("error")
    assert answer["payload"]["warning"] == "live-drift"
    assert _tokens(rig.vault.read_live(agent_key).secret) == "at-b-1"
    assert rig.store.list()["defaults"][agent_key] == b


def _seed_identity_accounts(rig: SimpleNamespace, agent_key: str, live: LiveCredentials) -> tuple[str, str]:
    a = rig.store.create(agent_key=agent_key, name="A")["id"]
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    rig.store.set_default(agent_key, a)
    rig.vault.write_live(agent_key, identity_secret(agent_key, "a", 1))
    rig.vault.capture(agent_key, a)
    rig.vault.write_slot(agent_key, b, identity_secret(agent_key, "b", 1))
    rig.vault.write_live(agent_key, live)
    return a, b


def _failover_proposal(agent_key: str, a: str, b: str) -> dict[str, Any]:
    return {"agent_key": agent_key, "to_slot_id": b, "expected_current_slot_id": a,
            "expected_epoch": 0, "idempotency_key": f"drift-{agent_key}"}


@pytest.mark.parametrize("agent_key", ["claude", "codex"])
async def test_failover_route_also_switches_after_a_same_account_refresh(rig, agent_key: str) -> None:
    """The second entry point (quota_failover.switch) must agree with the
    manual route: a refreshed A is still A — switch to B, keep the refreshed
    tokens in A's slot."""
    s = session()
    a, b = _seed_identity_accounts(rig, agent_key, identity_secret(agent_key, "a", 2))
    answer = await call(s, "quota_failover.switch", _failover_proposal(agent_key, a, b))
    assert answer["ok"] is True, answer.get("error")
    tx = answer["payload"]["transaction"]
    assert tx["state"] == "committed" and tx["swapped"] is True
    assert _tokens(rig.vault.read_live(agent_key).secret) == "at-b-1"
    assert _tokens(rig.vault.read_slot(agent_key, a).secret) == "at-a-2", "A's refreshed tokens were not kept"
    assert rig.store.list()["defaults"][agent_key] == b


@pytest.mark.parametrize("agent_key", ["claude", "codex"])
async def test_failover_route_refuses_a_different_live_identity_and_leaves_a_untouched(rig, agent_key: str) -> None:
    s = session()
    a, b = _seed_identity_accounts(rig, agent_key, identity_secret(agent_key, "c", 1))
    answer = await call(s, "quota_failover.switch", _failover_proposal(agent_key, a, b))
    # This route answers with the transaction: it must end cancelled for
    # drift, with nothing swapped (a refusal frame is equally acceptable).
    if answer["ok"]:
        tx = answer["payload"]["transaction"]
        assert tx["state"] == "cancelled" and tx["swapped"] is False, tx
        assert tx["reason"] == "live-drift"
    assert _tokens(rig.vault.read_slot(agent_key, a).secret) == "at-a-1", "A's slot took C's credential"
    assert _tokens(rig.vault.read_live(agent_key).secret) == "at-c-1"
    assert rig.store.list()["defaults"][agent_key] == a
    state = (await call(s, "quota_failover.get_state", {}, msg_id="st"))["payload"]
    assert not any(t["swapped"] for t in state["transactions"] + state["recentTransactions"])


# ── a stable account id beats a shared email ──────────────────────────────────
# codex: auth.json tokens.account_id (cli_vendors/codex.py). claude: the
# oauthAccount object the vault keeps beside the secret (organizationUuid —
# one email, several organisations, each its own quota pool).

async def test_codex_refresh_with_the_same_account_id_still_switches(rig) -> None:
    s = session()
    a, b = _seed_identity_accounts(rig, "codex", identity_secret("codex", "a", 2, account_id="acct-A"))
    # Seed A's slot with the same account id, generation 1.
    rig.vault.write_slot("codex", a, identity_secret("codex", "a", 1, account_id="acct-A"))
    answer = await call(s, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b})
    assert answer["ok"] is True, answer.get("error")
    assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a-2"
    assert json.loads(rig.vault.read_slot("codex", a).secret)["tokens"]["account_id"] == "acct-A"
    assert _tokens(rig.vault.read_live("codex").secret) == "at-b-1"


async def test_codex_same_email_but_another_account_id_is_drift(rig) -> None:
    """A personal and a team ChatGPT account can share one email; the live
    credential belonging to another account id is not a refresh of A."""
    s = session()
    a, b = _seed_identity_accounts(rig, "codex", identity_secret("codex", "a", 2, account_id="acct-TEAM"))
    rig.vault.write_slot("codex", a, identity_secret("codex", "a", 1, account_id="acct-A"))

    answer = await call(s, "quota_failover.switch", _failover_proposal("codex", a, b), msg_id="fo")
    if answer["ok"]:
        tx = answer["payload"]["transaction"]
        assert tx["state"] == "cancelled" and tx["swapped"] is False, tx
    assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a-1"
    assert json.loads(rig.vault.read_slot("codex", a).secret)["tokens"]["account_id"] == "acct-A"
    assert _tokens(rig.vault.read_live("codex").secret) == "at-a-2"
    assert rig.store.list()["defaults"]["codex"] == a

    # The manual route is not gated: it switches and reports the drift.
    answer = await call(s, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b})
    assert answer["ok"] is True, answer.get("error")
    assert answer["payload"]["warning"] == "live-drift", "a different account id behind the same email was treated as a refresh"
    assert _tokens(rig.vault.read_live("codex").secret) == "at-b-1"
    assert rig.store.list()["defaults"]["codex"] == b


async def test_claude_refresh_within_the_same_organisation_still_switches(rig) -> None:
    s = session()
    a, b = _seed_identity_accounts(rig, "claude", identity_secret("claude", "a", 2, account_id="org-A"))
    rig.vault.write_slot("claude", a, identity_secret("claude", "a", 1, account_id="org-A"))
    answer = await call(s, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": b})
    assert answer["ok"] is True, answer.get("error")
    assert _tokens(rig.vault.read_slot("claude", a).secret) == "at-a-2"
    assert rig.vault.read_slot("claude", a).account["organizationUuid"] == "org-A"
    assert _tokens(rig.vault.read_live("claude").secret) == "at-b-1"


async def test_claude_same_email_in_another_organisation_is_drift(rig) -> None:
    s = session()
    a, b = _seed_identity_accounts(rig, "claude", identity_secret("claude", "a", 2, account_id="org-TEAM"))
    rig.vault.write_slot("claude", a, identity_secret("claude", "a", 1, account_id="org-A"))

    answer = await call(s, "quota_failover.switch", _failover_proposal("claude", a, b), msg_id="fo")
    if answer["ok"]:
        tx = answer["payload"]["transaction"]
        assert tx["state"] == "cancelled" and tx["swapped"] is False, tx
    assert _tokens(rig.vault.read_slot("claude", a).secret) == "at-a-1"
    assert rig.vault.read_slot("claude", a).account["organizationUuid"] == "org-A"
    assert _tokens(rig.vault.read_live("claude").secret) == "at-a-2"
    assert rig.store.list()["defaults"]["claude"] == a

    # The manual route is not gated: it switches and reports the drift.
    answer = await call(s, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": b})
    assert answer["ok"] is True, answer.get("error")
    assert answer["payload"]["warning"] == "live-drift", "another organisation behind the same email was treated as a refresh"
    assert _tokens(rig.vault.read_live("claude").secret) == "at-b-1"
    assert rig.store.list()["defaults"]["claude"] == b


# ── opaque credential: the manual "assume live is current" confirmation ──────

def opaque_secret(tag: str) -> LiveCredentials:
    """A codex-shaped credential carrying no identity at all (no id_token,
    no account_id): a rotated token and a foreign sign-in look alike."""
    return LiveCredentials(secret=json.dumps({"tokens": {"access_token": f"at-{tag}", "refresh_token": f"rt-{tag}"}}))


def shown_state(rig: SimpleNamespace, agent_key: str, current: str) -> dict[str, Any]:
    """The state a caller would bind ``assume_live_is_current`` to."""
    return {"currentSlotId": current, "epoch": rig.service.epoch(agent_key),
            "liveFingerprint": quota_failover.live_fingerprint(rig.vault, agent_key, None)}


def resend_with(details: dict[str, Any], **payload: Any) -> dict[str, Any]:
    """The confirmation re-send, carrying back whatever the refusal handed out
    so the backend can bind it to the state the user actually confirmed."""
    out = {**payload, "assume_live_is_current": True, "expected_current_slot_id": details.get("currentSlotId")}
    if details.get("liveFingerprint") is not None:
        out["live_fingerprint"] = details["liveFingerprint"]
    if details.get("epoch") is not None:
        out["expected_epoch"] = details["epoch"]
    return out


async def test_opaque_drift_does_not_ask_the_user_before_a_manual_switch(rig) -> None:
    s = session()
    a = rig.store.create(agent_key="codex", name="A")["id"]
    b = rig.store.create(agent_key="codex", name="B")["id"]
    rig.store.set_default("codex", a)
    rig.vault.write_live("codex", opaque_secret("a1"))
    rig.vault.capture("codex", a)
    rig.vault.write_slot("codex", b, opaque_secret("b1"))
    rig.vault.write_live("codex", opaque_secret("a2"))  # rotated — or foreign; nobody can tell

    answer = await call(s, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b})
    assert answer["ok"] is True, answer.get("error")
    assert answer["payload"]["warning"] == "live-drift-unverified"
    assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a2"  # live captured as A's
    assert _tokens(rig.vault.read_live("codex").secret) == "at-b1"
    assert rig.store.list()["defaults"]["codex"] == b


async def test_a_stale_confirmation_after_another_window_switched_does_not_capture_into_the_new_current(rig) -> None:
    """Window 1 is showing the confirmation for "live is still A". Meanwhile
    window 2 completes a switch, so the active account is B and the live
    credential has moved on again. Window 1's confirmation was about a state
    that no longer exists: it must be refused, and B's slot must not receive
    whatever is live now."""
    w1, w2 = session(), session()
    a = rig.store.create(agent_key="codex", name="A")["id"]
    b = rig.store.create(agent_key="codex", name="B")["id"]
    c = rig.store.create(agent_key="codex", name="C")["id"]
    rig.store.set_default("codex", a)
    rig.vault.write_live("codex", opaque_secret("a1"))
    rig.vault.capture("codex", a)
    rig.vault.write_slot("codex", b, opaque_secret("b1"))
    rig.vault.write_slot("codex", c, opaque_secret("c1"))
    rig.vault.write_live("codex", opaque_secret("a2"))

    details = shown_state(rig, "codex", a)

    # Window 2 confirms and switches to B in the meantime.
    ok2 = await call(w2, "cli_profiles.set_default", resend_with(details, agent_key="codex", profile_id=b), msg_id="w2")
    assert ok2["ok"] is True, ok2.get("error")
    assert rig.store.list()["defaults"]["codex"] == b
    assert _tokens(rig.vault.read_live("codex").secret) == "at-b1"
    rig.vault.write_live("codex", opaque_secret("x9"))  # live moved on again under B

    stale = await call(w1, "cli_profiles.set_default", resend_with(details, agent_key="codex", profile_id=c), msg_id="stale")
    assert stale["ok"] is False, "a confirmation given for the old state was applied to the new one"
    assert stale["error"]["code"] in ("STALE_STATE", "LIVE_DRIFT"), stale["error"]
    assert _tokens(rig.vault.read_slot("codex", b).secret) == "at-b1", "B's slot took the credential live now"
    assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a2"
    assert _tokens(rig.vault.read_live("codex").secret) == "at-x9"
    assert rig.store.list()["defaults"]["codex"] == b


async def test_a_confirmation_without_the_state_it_confirms_cannot_assume(rig) -> None:
    """``assume_live_is_current`` on its own is not a confirmation: the
    re-send must name the state the user saw — current slot, epoch AND the
    live fingerprint. Each row below has everything right except one thing,
    so each guard is exercised on its own; nothing moves in any of them. (The
    fingerprint's value is no longer compared: the manual route does not ask
    for the word, so a stale echo just switches.)"""
    s = session()
    a = rig.store.create(agent_key="codex", name="A")["id"]
    b = rig.store.create(agent_key="codex", name="B")["id"]
    rig.store.set_default("codex", a)
    rig.vault.write_live("codex", opaque_secret("a1"))
    rig.vault.capture("codex", a)
    rig.vault.write_slot("codex", b, opaque_secret("b1"))
    rig.vault.write_live("codex", opaque_secret("a2"))
    details = shown_state(rig, "codex", a)
    assert details.get("liveFingerprint"), details
    good = resend_with(details, agent_key="codex", profile_id=b)

    def untouched(tag: str, live: str = "at-a2") -> None:
        assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a1", tag
        assert _tokens(rig.vault.read_slot("codex", b).secret) == "at-b1", tag
        assert _tokens(rig.vault.read_live("codex").secret) == live, tag
        assert rig.store.list()["defaults"]["codex"] == a, tag

    # 1) assume with nothing to bind it to
    bare = await call(s, "cli_profiles.set_default",
                      {"agent_key": "codex", "profile_id": b, "assume_live_is_current": True}, msg_id="bare")
    assert bare["ok"] is False, bare
    untouched("bare")
    # 2) current and epoch right, fingerprint missing
    no_fp = {k: v for k, v in good.items() if k != "live_fingerprint"}
    answer = await call(s, "cli_profiles.set_default", no_fp, msg_id="no-fp")
    assert answer["ok"] is False, ("a confirmation without the live fingerprint was accepted", answer)
    untouched("no-fp")
    # 3) the honest re-send, against the state it confirms
    answer = await call(s, "cli_profiles.set_default", good, msg_id="honest")
    assert answer["ok"] is True, answer.get("error")
    assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a2"
    assert _tokens(rig.vault.read_live("codex").secret) == "at-b1"
    assert rig.store.list()["defaults"]["codex"] == b


async def test_a_confirmation_is_stale_after_a_round_trip_that_lands_on_the_same_current(rig) -> None:
    """A → C → A in another window: the current slot reads A again, but the
    live credential and the epoch are not what window 1 confirmed."""
    w1, w2 = session(), session()
    a = rig.store.create(agent_key="codex", name="A")["id"]
    b = rig.store.create(agent_key="codex", name="B")["id"]
    c = rig.store.create(agent_key="codex", name="C")["id"]
    rig.store.set_default("codex", a)
    rig.vault.write_live("codex", opaque_secret("a1"))
    rig.vault.capture("codex", a)
    rig.vault.write_slot("codex", b, opaque_secret("b1"))
    rig.vault.write_slot("codex", c, opaque_secret("c1"))
    rig.vault.write_live("codex", opaque_secret("a2"))

    details = shown_state(rig, "codex", a)

    # Window 2: confirm, go to C, then come back to A (a plain switch).
    ok2 = await call(w2, "cli_profiles.set_default", resend_with(details, agent_key="codex", profile_id=c), msg_id="to-c")
    assert ok2["ok"] is True, ok2.get("error")
    back = await call(w2, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": a}, msg_id="to-a")
    assert back["ok"] is True, back.get("error")
    assert rig.store.list()["defaults"]["codex"] == a
    # Same current slot, byte-identical live payload (same fingerprint):
    # only the epoch moved, twice, through the manual switches. The epoch
    # guard has to refuse on its own — nothing else differs.
    assert _tokens(rig.vault.read_live("codex").secret) == "at-a2"
    assert rig.service.epoch("codex") > int(details.get("epoch", 0))

    stale = await call(w1, "cli_profiles.set_default", resend_with(details, agent_key="codex", profile_id=b), msg_id="stale")
    assert stale["ok"] is False, "a confirmation from before the round trip was applied to the new state"
    assert stale["error"]["code"] == "STALE_EPOCH", stale["error"]  # the epoch alone must decide here
    assert _tokens(rig.vault.read_slot("codex", b).secret) == "at-b1"
    assert _tokens(rig.vault.read_live("codex").secret) == "at-a2"  # no switch happened
    assert rig.store.list()["defaults"]["codex"] == a
