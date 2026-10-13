"""cli_profiles.* WS handlers + the shared-home spawn contract.

Every regular pane runs on the user's real home and the live credentials of
the active account — spawns get no per-profile env isolation (the only
exception is an isolated LOGIN pane). cli_profiles.set_default swaps the live
credentials through the vault; because running panes share those credentials,
the switch is gated on quiescence (PANES_RUNNING unless force=true) but never
kills a pane itself."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import asyncio
import os
import shutil
import time

import pytest

from agent_team_backend import app
from agent_team_backend import guard_hooks, ws_handlers
from agent_team_backend.credential_vault import CredentialVault
from agent_team_backend.profiles_store import CliProfilesStore


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeProc:
    def __init__(self) -> None:
        self.alive = True

    def poll(self) -> int | None:
        return None if self.alive else 0


class FakeTerminals:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.killed: list[str] = []
        self.registry: dict[str, SimpleNamespace] = {}

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        return SimpleNamespace(
            id="term-1",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1234),
        )

    def get(self, session_id: str) -> SimpleNamespace | None:
        return self.registry.get(session_id)

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []

    async def kill(self, session_id: str, force: bool = False) -> None:
        # Mirrors TerminalService.kill: the terminal closes immediately; the
        # child process dies unless the term is marked as surviving SIGKILL.
        self.killed.append(session_id)
        term = self.registry.get(session_id)
        if term is None:
            return
        term.closed = True
        if not getattr(term, "survives_kill", False):
            term.proc.alive = False


class FakeAttribution:
    def __init__(self) -> None:
        self.registered: list[dict[str, Any]] = []

    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        self.registered.append({"pane_id": pane_id, **kwargs})

    def scan_pane_baseline(self, pane_id: str) -> None:
        pass


class FakeCodexHomeManager:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.real_home = root / "real-codex"
        self.prepared: list[str] = []
        self.prepared_sources: list[Path | None] = []

    def prepare(self, home_id: str, *, source_home: Path | None = None) -> Path:
        self.prepared.append(home_id)
        self.prepared_sources.append(source_home)
        return self.root / home_id

    def find_session_home(self, resume_id: str) -> Path | None:
        return None


class FakeVault:
    def __init__(self, fail: bool = False, root: Path | None = None) -> None:
        self.switch_calls: list[tuple[str, str, str]] = []
        self.login_harvests: list[tuple[str, str]] = []
        self.slot_secrets_deleted: list[tuple[str, str]] = []
        self.delete_slot_secrets_fail = False
        self.fail = fail
        self.root = root
        self._locks: dict[str, asyncio.Lock] = {}
        self.cleared_live: list[str] = []
        self.slot_secrets: dict[tuple[str, str], str | None] = {}
        self.slot_writes: list[tuple[str, str, str | None]] = []

    def clear_live(self, agent_key: str) -> None:
        self.cleared_live.append(agent_key)

    def delete_slot_secrets(self, agent_key: str, slot_id: str) -> None:
        self.slot_secrets_deleted.append((agent_key, slot_id))
        if self.delete_slot_secrets_fail:
            raise RuntimeError("cleanup boom")

    def switch_lock(self, agent_key: str) -> asyncio.Lock:
        lock = self._locks.get(agent_key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[agent_key] = lock
        return lock

    def switch(
        self, agent_key: str, from_slot_id: str, to_slot_id: str, *, scope: str | None = None
    ) -> None:
        self.switch_calls.append((agent_key, from_slot_id, to_slot_id))
        if self.fail:
            raise RuntimeError("swap boom")

    def login_home_path(self, agent_key: str, slot_id: str) -> Path:
        return (self.root or Path("/nonexistent")) / agent_key / slot_id / "login-home"

    def harvest_login_home(self, agent_key: str, slot_id: str, *, scope: str | None = None) -> bool:
        # Mirrors CredentialVault: a home with a secret is captured + removed,
        # a secretless home (login still pending/abandoned) is a no-op.
        self.login_harvests.append((agent_key, slot_id))
        home = self.login_home_path(agent_key, slot_id)
        if not (home / "auth.json").exists():
            return False
        shutil.rmtree(home)
        return True

    def delete_slot_secrets(self, agent_key: str, slot_id: str) -> None:
        if self.delete_slot_secrets_fail:
            raise RuntimeError("cleanup boom")
        self.slot_secrets_deleted.append((agent_key, slot_id))

    def identity(self, agent_key: str, slot_id: str | None = None) -> dict[str, Any]:
        return {"email": None, "signedIn": False}

    # No claude account has signed in inside its own config dir.
    def account_dir_signed_in(self, slot_id: str) -> bool:
        return False

    def account_dir_identity(self, slot_id: str) -> dict | None:
        return None

    # Claude slot snapshots — the switch reads the slot about to become live to
    # decide whether it can authenticate. Empty by default, so tests that do
    # not opt in see a signed-out slot.
    def read_slot(self, agent_key: str, slot_id: str) -> SimpleNamespace:
        return SimpleNamespace(
            secret=self.slot_secrets.get((agent_key, slot_id)),
            account=None,
        )

    def write_slot(self, agent_key: str, slot_id: str, creds: Any) -> None:
        self.slot_secrets[(agent_key, slot_id)] = creds.secret
        self.slot_writes.append((agent_key, slot_id, creds.secret))


def _env_without_guard_token(env: dict[str, str] | None) -> dict[str, str] | None:
    """The spawn env minus Navide Guard's per-pane token, which every claude,
    copilot and qwen pane gets (guard_hooks.PANE_TOKEN_ENV)."""
    rest = {k: v for k, v in (env or {}).items() if k != guard_hooks.PANE_TOKEN_ENV}
    return rest or None


def _session() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    return session


@pytest.fixture(autouse=True)
def login_watch_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Record login-watch starts instead of spawning real (sleeping) tasks."""
    from agent_team_backend import usage_service

    started: list[tuple[str, str]] = []
    monkeypatch.setattr(
        usage_service,
        "start_login_watch",
        lambda agent_key, profile_id: started.append((agent_key, profile_id)),
    )
    return started


@pytest.fixture(autouse=True)
def _stub_agent_cli_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        app,
        "_probe_agent_cli_for_spawn",
        lambda agent_key, _command=None: {
            "agent_key": agent_key,
            "binary_path": f"/test/bin/{agent_key}",
            "version": "1.0.0",
            "duration_ms": 1,
        } if agent_key and agent_key != "terminal" else None,
    )


@pytest.fixture()
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> CliProfilesStore:
    s = CliProfilesStore(
        path=tmp_path / "cli-profiles.json",
        profiles_root=tmp_path / "cli-profiles",
    )
    monkeypatch.setattr(app, "cli_profiles_store", s)
    return s


@pytest.fixture()
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> FakeVault:
    v = FakeVault(root=tmp_path / "fake-vault")
    monkeypatch.setattr(app, "credential_vault", v)
    return v


@pytest.fixture()
def events(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def record(event: dict[str, Any], *, exclude: Any = None) -> None:
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", record)
    return sent


@pytest.fixture()
def spawn_stubs(monkeypatch: pytest.MonkeyPatch) -> FakeAttribution:
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    return fake_attr


def _register_running_terminal(
    session: app.Session,
    terminal_id: str,
    agent_key: str,
    closed: bool = False,
    survives_kill: bool = False,
    login_profile_id: str | None = None,
) -> SimpleNamespace:
    term = SimpleNamespace(
        id=terminal_id,
        agent_key=agent_key,
        closed=closed,
        proc=FakeProc(),
        survives_kill=survives_kill,
        metadata={"login_profile_id": login_profile_id} if login_profile_id else {},
    )
    session.terminals.registry[terminal_id] = term  # type: ignore[attr-defined]
    app._PTY_OWNERS[terminal_id] = session
    return term


# ---- cli_profiles.* CRUD handlers ----


async def test_cli_profiles_create_and_list(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "c1",
        "type": "cli_profiles.create",
        "payload": {"agent_key": "claude", "name": "Work"},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    profile = response["payload"]["profile"]
    assert profile["agentKey"] == "claude"
    assert response["payload"]["profiles"] == [profile]
    assert events[0]["type"] == "cli_profiles.changed"
    assert events[0]["payload"]["reason"] == "create"

    await app.handle_message(session, {
        "id": "l1", "type": "cli_profiles.list", "payload": {},
    })

    listing = session.websocket.sent[1]  # type: ignore[attr-defined]
    assert listing["payload"]["profiles"] == [profile]
    from agent_team_backend.profiles_store import SUPPORTED_AGENT_KEYS

    assert listing["payload"]["defaults"] == {key: None for key in SUPPORTED_AGENT_KEYS}
    assert listing["payload"]["supported_agents"] == list(SUPPORTED_AGENT_KEYS)
    assert listing["payload"]["supported_agents"][:4] == ["claude", "codex", "kimi", "grok"]


async def test_cli_profiles_list_includes_identities(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The list payload carries per-slot display identities. The active
    account (managed or not) reads the live state — its secret and the
    ~/.claude.json email both live in the real home; parked accounts read
    their slot snapshots. (conftest roots the vault's real home at tmp_path.)"""
    import json

    # File mode: reads fall back to disk (the conftest security runner always
    # reports 'not found', so the Keychain path is inert).
    monkeypatch.setattr(app.credential_vault, "_platform", "linux")
    home = tmp_path / "vault-home"
    home.mkdir(parents=True, exist_ok=True)
    (home / ".claude.json").write_text(
        json.dumps({"oauthAccount": {"emailAddress": "live@example.com"}}),
        encoding="utf-8",
    )
    # signedIn requires an actual live credential secret, not just the
    # display-only oauthAccount.
    (home / ".claude").mkdir(exist_ok=True)
    (home / ".claude" / ".credentials.json").write_text('{"tok": 1}', encoding="utf-8")
    profile = store.create(agent_key="claude", name="Work")
    store.set_default("claude", profile["id"])
    session = _session()

    await app.handle_message(session, {
        "id": "l1", "type": "cli_profiles.list", "payload": {},
    })

    identities = session.websocket.sent[0]["payload"]["identities"]  # type: ignore[attr-defined]
    # Active managed profile: secret and email both from the live state.
    assert identities["claude"][profile["id"]] == {
        "email": "live@example.com", "signedIn": True,
    }
    # The built-in Default's slot is empty -> not signed in.
    assert identities["claude"]["__default__"] == {"email": None, "signedIn": False}
    assert identities["kimi"] == {"__default__": {"email": None, "signedIn": False}}


async def test_cli_profiles_changed_broadcast_includes_identities(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "c1",
        "type": "cli_profiles.create",
        "payload": {"agent_key": "claude", "name": "Work"},
    })

    assert events[0]["type"] == "cli_profiles.changed"
    assert "identities" in events[0]["payload"]
    assert events[0]["payload"]["identities"]["claude"]["__default__"] == {
        "email": None, "signedIn": False,
    }
    assert events[0]["payload"]["duplicates"] == {}


# ---- duplicate accounts (two rows storing the same login) ----


def _codex_auth(email: str) -> str:
    """A codex auth.json whose id_token JWT payload carries ``email`` — the
    shape ``cli_vendors.codex.identity_from_secret`` reads."""
    import base64
    import json

    body = base64.urlsafe_b64encode(
        json.dumps({"email": email}).encode()
    ).decode().rstrip("=")
    return json.dumps({"tokens": {"access_token": "tok", "id_token": f"h.{body}.s"}})


def _write_slot(agent_key: str, slot_id: str, filename: str, secret: str) -> None:
    slot = app.credential_vault.slot_dir(agent_key, slot_id)
    slot.mkdir(parents=True, exist_ok=True)
    (slot / filename).write_text(secret, encoding="utf-8")


async def _list_duplicates() -> dict[str, Any]:
    session = _session()
    await app.handle_message(session, {
        "id": "l1", "type": "cli_profiles.list", "payload": {},
    })
    return session.websocket.sent[0]["payload"]["duplicates"]  # type: ignore[attr-defined]


async def test_cli_profiles_list_flags_duplicate_accounts(
    store: CliProfilesStore,
) -> None:
    """Two profiles whose snapshots hold the same login are both flagged, with
    the whole group on each so the pane can name the spare. Emails match
    case-insensitively — the CLIs do not agree on casing."""
    third = store.create(agent_key="codex", name="Account 3")
    fifth = store.create(agent_key="codex", name="Account 5")
    _write_slot("codex", third["id"], "auth.json", _codex_auth("same@example.com"))
    _write_slot("codex", fifth["id"], "auth.json", _codex_auth("SAME@example.com"))

    duplicates = await _list_duplicates()

    assert set(duplicates["codex"]) == {third["id"], fifth["id"]}
    assert duplicates["codex"][third["id"]] == {
        "email": "same@example.com",
        "slotIds": [third["id"], fifth["id"]],
    }
    assert duplicates["codex"][fifth["id"]]["slotIds"] == [third["id"], fifth["id"]]


async def test_distinct_accounts_are_not_duplicates(store: CliProfilesStore) -> None:
    third = store.create(agent_key="codex", name="Account 3")
    fifth = store.create(agent_key="codex", name="Account 5")
    _write_slot("codex", third["id"], "auth.json", _codex_auth("one@example.com"))
    _write_slot("codex", fifth["id"], "auth.json", _codex_auth("two@example.com"))

    assert await _list_duplicates() == {}


async def test_slots_without_an_email_never_duplicate(store: CliProfilesStore) -> None:
    """kimi stores no identity field, so two of its slots holding a token
    cannot be told apart — flagging them would accuse accounts at random."""
    second = store.create(agent_key="kimi", name="Account 2")
    third = store.create(agent_key="kimi", name="Account 3")
    for profile in (second, third):
        _write_slot("kimi", profile["id"], "kimi-code.json", '{"access_token": "tok"}')

    assert await _list_duplicates() == {}


async def test_cli_profiles_create_rejects_unsupported_agent(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "c2",
        "type": "cli_profiles.create",
        "payload": {"agent_key": "aider", "name": "X"},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "BAD_REQUEST"
    assert events == []


async def test_cli_profiles_rename_delete_set_default_flow(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    session = _session()
    profile = store.create(agent_key="kimi", name="Old")

    await app.handle_message(session, {
        "id": "r1",
        "type": "cli_profiles.rename",
        "payload": {"id": profile["id"], "name": "New"},
    })
    assert session.websocket.sent[0]["payload"]["profile"]["name"] == "New"  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "d1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "kimi", "profile_id": profile["id"]},
    })
    assert session.websocket.sent[1]["payload"]["defaults"]["kimi"] == profile["id"]  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "d2",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "kimi", "profile_id": None},
    })
    assert session.websocket.sent[2]["payload"]["defaults"]["kimi"] is None  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "x1",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })
    assert session.websocket.sent[3]["payload"]["profiles"] == []  # type: ignore[attr-defined]
    # Every mutation announces itself once, in order. A completed switch also
    # tells the failover authority the user took over (epoch moves, pending
    # automatic proposals are withdrawn) before announcing profiles, so the
    # renderer recognizes the manual restart. That is the only other event.
    assert [e["type"] for e in events] == [
        "cli_profiles.changed", "quota_failover.changed", "cli_profiles.changed",
        "quota_failover.changed", "cli_profiles.changed", "cli_profiles.changed",
    ]
    profiles_changed = [e for e in events if e["type"] == "cli_profiles.changed"]
    assert [e["payload"]["reason"] for e in profiles_changed] == [
        "rename", "set_default", "set_default", "delete",
    ]
    failover = [e["payload"] for e in events if e["type"] == "quota_failover.changed"]
    assert [f["epochs"]["kimi"] for f in failover] == [1, 2]


async def test_cli_profiles_delete_default_clears_credentials(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "x_default",
        "type": "cli_profiles.delete",
        "payload": {"agent_key": "claude", "id": None},
    })
    assert "profiles" in session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert events[-1]["payload"]["reason"] == "delete"


async def test_set_default_triggers_usage_refresh(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    vault: FakeVault,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Switching the active account forces the usage poller to re-fetch now so
    the quota badge reflects the new account immediately."""
    from agent_team_backend import usage_service

    calls: list[int] = []
    monkeypatch.setattr(usage_service.service, "request_refresh", lambda: calls.append(1))
    session = _session()
    profile = store.create(agent_key="codex", name="Work")

    await app.handle_message(session, {
        "id": "sd1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "codex", "profile_id": profile["id"]},
    })

    assert session.websocket.sent[0]["ok"] is True  # type: ignore[attr-defined]
    assert calls == [1]


async def test_set_default_broadcast_carries_agent_key_and_forced(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """The set_default broadcast names the switched agent and whether the
    request forced past the quiescence gate — every window restarts its own
    panes of that agent from this event. Other reasons carry neither field."""
    session = _session()
    profile = store.create(agent_key="kimi", name="Work")

    await app.handle_message(session, {
        "id": "b1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "kimi", "profile_id": profile["id"]},
    })
    await app.handle_message(session, {
        "id": "b2",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "kimi", "profile_id": None, "force": True},
    })
    await app.handle_message(session, {
        "id": "b3",
        "type": "cli_profiles.rename",
        "payload": {"id": profile["id"], "name": "Renamed"},
    })

    assert [e["type"] for e in events] == [
        "quota_failover.changed", "cli_profiles.changed",
        "quota_failover.changed", "cli_profiles.changed",
        "cli_profiles.changed",
    ]
    plain, forced, renamed = (
        e["payload"] for e in events if e["type"] == "cli_profiles.changed"
    )
    assert (plain["reason"], plain["agent_key"], plain["forced"]) == (
        "set_default", "kimi", False,
    )
    assert (forced["reason"], forced["agent_key"], forced["forced"]) == (
        "set_default", "kimi", True,
    )
    assert renamed["reason"] == "rename"
    assert "agent_key" not in renamed
    assert "forced" not in renamed


async def test_concurrent_switches_serialize_no_slot_clobber(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    vault: FakeVault,
) -> None:
    """Two windows switching the same agent at once must serialize: the second
    switch reads the first's persisted result, so the two never capture from the
    same slot (e.g. both from __default__) and clobber the original login.

    Without the per-agent switch lock both handlers read current_id=None at the
    to_thread yield point and both swap out of __default__ — this test fails."""
    a = store.create(agent_key="codex", name="A")
    b = store.create(agent_key="codex", name="B")

    async def _switch(pid: str) -> None:
        await app.handle_message(_session(), {
            "id": "c",
            "type": "cli_profiles.set_default",
            "payload": {"agent_key": "codex", "profile_id": pid},
        })

    await asyncio.gather(_switch(a["id"]), _switch(b["id"]))

    # Exactly two swaps forming a chain: the second swaps out what the first
    # swapped in — never both out of __default__.
    assert len(vault.switch_calls) == 2
    first, second = vault.switch_calls
    assert first[1] == "__default__"
    assert second[1] == first[2]
    assert {first[2], second[2]} == {a["id"], b["id"]}
    # The account that ran second is the persisted active one.
    assert store.list()["defaults"]["codex"] == second[2]


async def test_cli_profiles_delete_active_refused(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Deleting the agent's ACTIVE profile is refused (PROFILE_ACTIVE): its
    credentials are the live state, and deleting would orphan them. The store
    stays untouched."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    store.set_default("claude", profile["id"])

    await app.handle_message(session, {
        "id": "x3",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "PROFILE_ACTIVE"
    assert store.list()["profiles"] == [profile]
    assert store.list()["defaults"]["claude"] == profile["id"]
    assert vault.slot_secrets_deleted == []
    assert events == []


async def test_cli_profiles_delete_cleans_slot_secrets(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Deleting a non-active profile removes its stranded slot secrets
    (claude's Keychain item etc.) through the vault before the store archives
    the slot dir."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")

    await app.handle_message(session, {
        "id": "x4",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert vault.slot_secrets_deleted == [("claude", profile["id"])]
    assert store.list()["profiles"] == []


async def test_cli_profiles_delete_survives_cleanup_failure(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """A failing secret cleanup must never block the delete itself."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    vault.delete_slot_secrets_fail = True

    await app.handle_message(session, {
        "id": "x5",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert store.list()["profiles"] == []


async def test_cli_profiles_delete_login_in_progress_refused(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """A profile whose isolated login pane CLI still runs cannot be deleted:
    removing the login home under a live CLI breaks it."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    _register_running_terminal(
        session, "t-login", "claude", login_profile_id=profile["id"]
    )

    await app.handle_message(session, {
        "id": "x6",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "LOGIN_IN_PROGRESS"
    assert store.list()["profiles"] == [profile]
    assert vault.slot_secrets_deleted == []
    assert events == []


async def test_cli_profiles_delete_removes_leftover_login_home(
    store: CliProfilesStore, events: list[dict[str, Any]], real_vault: CredentialVault
) -> None:
    """A leftover login home (abandoned sign-in, no running pane) goes with
    the deleted profile — removed before the store renames the slot dir."""
    session = _session()
    profile = store.create(agent_key="codex", name="Work")
    home = real_vault.login_home_path("codex", profile["id"])
    home.mkdir(parents=True)

    await app.handle_message(session, {
        "id": "x7",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert not home.exists()
    assert store.list()["profiles"] == []


async def test_cli_profiles_rename_unknown_is_bad_request(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "r2",
        "type": "cli_profiles.rename",
        "payload": {"id": "nope1234", "name": "X"},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "BAD_REQUEST"


async def test_cli_profiles_rename_default_slot_sets_alias(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "r3",
        "type": "cli_profiles.rename",
        "payload": {"id": "__default__", "name": "Personal", "agentKey": "codex"},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert response["payload"]["defaultNames"] == {"codex": "Personal"}
    assert store.list()["defaultNames"] == {"codex": "Personal"}
    assert store.list()["profiles"] == []
    assert events[0]["type"] == "cli_profiles.changed"
    assert events[0]["payload"]["reason"] == "rename"
    assert events[0]["payload"]["defaultNames"] == {"codex": "Personal"}

    await app.handle_message(session, {
        "id": "l3", "type": "cli_profiles.list", "payload": {},
    })
    listing = session.websocket.sent[1]  # type: ignore[attr-defined]
    assert listing["payload"]["defaultNames"] == {"codex": "Personal"}


async def test_cli_profiles_rename_default_slot_accepts_snake_case_agent_key(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    """Every other cli_profiles handler takes ``agent_key``; an external
    caller following that convention must not be turned away."""
    session = _session()

    await app.handle_message(session, {
        "id": "r3s",
        "type": "cli_profiles.rename",
        "payload": {"id": "__default__", "name": "Personal", "agent_key": "codex"},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert response["payload"]["defaultNames"] == {"codex": "Personal"}
    assert store.list()["defaultNames"] == {"codex": "Personal"}


async def test_cli_profiles_rename_default_slot_requires_agent_key(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()

    for i, extra in enumerate(({}, {"agentKey": "terminal"})):
        await app.handle_message(session, {
            "id": f"r4-{i}",
            "type": "cli_profiles.rename",
            "payload": {"id": "__default__", "name": "X", **extra},
        })
        response = session.websocket.sent[i]  # type: ignore[attr-defined]
        assert response["ok"] is False
        assert response["error"]["code"] == "BAD_REQUEST"
    assert events == []
    assert store.list()["defaultNames"] == {}


async def test_cli_profiles_list_carries_name_is_custom(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()
    auto = store.create(agent_key="claude", name="Account 1")
    custom = store.create(agent_key="claude", name="Account 2")
    store.rename(custom["id"], "Work")

    await app.handle_message(session, {
        "id": "l4", "type": "cli_profiles.list", "payload": {},
    })

    listing = session.websocket.sent[0]  # type: ignore[attr-defined]
    rows = {p["id"]: p for p in listing["payload"]["profiles"]}
    assert "nameIsCustom" not in rows[auto["id"]]
    assert rows[custom["id"]]["nameIsCustom"] is True
    assert listing["payload"]["defaultNames"] == {}


# ---- cli_profiles.set_default credential swap semantics ----


async def test_set_default_swaps_credentials_via_vault(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """null→B captures live into the reserved default slot and restores B;
    B→null captures live into B and restores the reserved slot."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")

    await app.handle_message(session, {
        "id": "s1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })
    await app.handle_message(session, {
        "id": "s2",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": None},
    })

    assert vault.switch_calls == [
        ("claude", "__default__", profile["id"]),
        ("claude", profile["id"], "__default__"),
    ]
    assert store.list()["defaults"]["claude"] is None


async def test_set_default_noop_when_already_active(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Re-selecting the already-active account must not touch any credentials."""
    session = _session()

    await app.handle_message(session, {
        "id": "n1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "grok", "profile_id": None},
    })

    assert session.websocket.sent[0]["ok"] is True  # type: ignore[attr-defined]
    assert vault.switch_calls == []
    assert events == []


async def test_set_default_refused_while_agent_panes_running(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Quiescence gate: a non-hot-swap CLI holds the live credentials in memory,
    so a switch with live panes of the agent is refused (PANES_RUNNING + count)
    — no credentials touched, no pane killed."""
    session = _session()
    profile = store.create(agent_key="codex", name="Work")
    t1 = _register_running_terminal(session, "t1", "codex")
    t2 = _register_running_terminal(session, "t2", "codex")

    await app.handle_message(session, {
        "id": "b1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "codex", "profile_id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "PANES_RUNNING"
    assert response["error"]["details"] == {"count": 2}
    assert session.terminals.killed == []  # type: ignore[attr-defined]
    assert t1.proc.poll() is None and t2.proc.poll() is None
    assert vault.switch_calls == []
    assert store.list()["defaults"]["codex"] is None
    assert events == []


async def test_set_default_claude_not_gated_by_running_panes(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """claude is a hot-swap agent: it re-reads its credential source on every
    request, so live panes neither block the switch nor get restarted. The
    broadcast must NOT carry forced — that flag is what makes windows rebuild
    their panes."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    t1 = _register_running_terminal(session, "t1", "claude")

    await app.handle_message(session, {
        "id": "hs1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert session.terminals.killed == []  # type: ignore[attr-defined]
    assert t1.proc.poll() is None
    assert vault.switch_calls == [("claude", "__default__", profile["id"])]
    changed = next(e["payload"] for e in events if e["type"] == "cli_profiles.changed")
    assert changed["forced"] is False


async def test_set_default_claude_announces_the_new_account_before_any_poll(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault,
    monkeypatch: Any,
) -> None:
    """The badge must be told the account changed at switch time, not at the
    end of the next poll: a Claude read boots a whole CLI, so waiting for the
    poll leaves the outgoing account's numbers on screen for tens of seconds
    with nothing saying why."""
    from agent_team_backend import usage_service

    announced: list[str | None] = []
    refreshed: list[bool] = []
    monkeypatch.setattr(
        usage_service.service, "announce_claude_switch",
        lambda slot_id, reading=True: _record_announce(announced, slot_id, reading),
    )
    monkeypatch.setattr(
        usage_service.service, "request_refresh", lambda: refreshed.append(True)
    )
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    vault.slot_secrets[("claude", profile["id"])] = _claude_slot_secret(
        "good", "rt-work", 4_102_444_800_000
    )

    await app.handle_message(session, {
        "id": "an1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    # A usable slot needs no sign-in, so the announcement promises a read.
    assert announced == [(profile["id"], True)]
    # The announcement requests the refresh itself — asking twice would be a
    # second wake for the same cycle.
    assert refreshed == []


async def _record_announce(sink: list, slot_id: str | None, reading: bool) -> None:
    sink.append((slot_id, reading))


async def test_set_default_claude_promises_no_read_when_a_sign_in_is_needed(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault,
    monkeypatch: Any,
) -> None:
    """An empty slot signs the CLI out, so the switch opens a login pane. The
    badge must not say the account's quota is being read at the same time —
    nothing is reading it, and the two messages contradict each other."""
    from agent_team_backend import usage_service

    announced: list[tuple[str | None, bool]] = []
    monkeypatch.setattr(
        usage_service.service, "announce_claude_switch",
        lambda slot_id, reading=True: _record_announce(announced, slot_id, reading),
    )
    session = _session()
    profile = store.create(agent_key="claude", name="Work")

    await app.handle_message(session, {
        "id": "an3",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    assert session.websocket.sent[0]["payload"]["needsLogin"] is True  # type: ignore[attr-defined]
    assert announced == [(profile["id"], False)]


async def test_set_default_non_claude_only_asks_for_a_refresh(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault,
    monkeypatch: Any,
) -> None:
    """The announcement is about Claude's active-slot pointer; other agents
    have no per-account snapshots to point at, so they keep the plain wake."""
    from agent_team_backend import usage_service

    announced: list[str | None] = []
    refreshed: list[bool] = []
    monkeypatch.setattr(
        usage_service.service, "announce_claude_switch",
        lambda slot_id, reading=True: _record_announce(announced, slot_id, reading),
    )
    monkeypatch.setattr(
        usage_service.service, "request_refresh", lambda: refreshed.append(True)
    )
    session = _session()
    profile = store.create(agent_key="codex", name="Work")

    await app.handle_message(session, {
        "id": "an2",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "codex", "profile_id": profile["id"]},
    })

    assert announced == []
    assert refreshed == [True]


async def test_set_default_claude_broadcast_never_forced(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Even an explicit force=true must not set the restart flag for a hot-swap
    agent: restarting its panes would throw away CLI state for nothing."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    _register_running_terminal(session, "t1", "claude")

    await app.handle_message(session, {
        "id": "hs2",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"], "force": True},
    })

    assert session.websocket.sent[0]["ok"] is True  # type: ignore[attr-defined]
    changed = next(e["payload"] for e in events if e["type"] == "cli_profiles.changed")
    assert changed["forced"] is False


async def test_set_default_rate_limited_after_burst(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Switching stays a manual action: past the per-agent quota a switch is
    refused with SWITCH_RATE_LIMITED and a retryAfter, credentials untouched."""
    session = _session()
    a = store.create(agent_key="claude", name="A")
    b = store.create(agent_key="claude", name="B")

    for i in range(ws_handlers.SWITCH_RATE_MAX):
        await app.handle_message(session, {
            "id": f"rl{i}",
            "type": "cli_profiles.set_default",
            "payload": {"agent_key": "claude", "profile_id": (a if i % 2 == 0 else b)["id"]},
        })
    assert len(vault.switch_calls) == ws_handlers.SWITCH_RATE_MAX

    await app.handle_message(session, {
        "id": "rl-over",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": None},
    })

    response = session.websocket.sent[-1]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "SWITCH_RATE_LIMITED"
    assert 0 < response["error"]["details"]["retryAfter"] <= ws_handlers.SWITCH_RATE_WINDOW_S
    assert len(vault.switch_calls) == ws_handlers.SWITCH_RATE_MAX


async def test_switch_rate_limit_not_bypassed_by_force(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """force means "I accept the pane restart", not "let me switch as fast as I
    like" — it must not open a hole in the rate limit."""
    session = _session()
    profile = store.create(agent_key="codex", name="Work")
    ws_handlers._switch_history["codex"] = [time.monotonic()] * ws_handlers.SWITCH_RATE_MAX

    await app.handle_message(session, {
        "id": "rl-force",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "codex", "profile_id": profile["id"], "force": True},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "SWITCH_RATE_LIMITED"
    assert vault.switch_calls == []


async def test_switch_rate_limit_ignores_noop_switch(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Re-selecting the active account swaps nothing, so it must not burn
    quota — otherwise idle UI churn could lock the user out of switching."""
    session = _session()

    for i in range(ws_handlers.SWITCH_RATE_MAX * 2):
        await app.handle_message(session, {
            "id": f"rl-noop{i}",
            "type": "cli_profiles.set_default",
            "payload": {"agent_key": "claude", "profile_id": None},
        })

    assert all(m["ok"] for m in session.websocket.sent)  # type: ignore[attr-defined]
    assert ws_handlers._switch_history.get("claude", []) == []


async def test_set_default_force_switches_despite_running_panes(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """force=true overrides the quiescence gate: the swap runs and the panes
    stay alive — restarting them is the caller's job, the backend never
    kills."""
    session = _session()
    profile = store.create(agent_key="codex", name="Work")
    t1 = _register_running_terminal(session, "t1", "codex")

    await app.handle_message(session, {
        "id": "b1f",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "codex", "profile_id": profile["id"], "force": True},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert session.terminals.killed == []  # type: ignore[attr-defined]
    assert t1.proc.poll() is None
    assert vault.switch_calls == [("codex", "__default__", profile["id"])]
    assert store.list()["defaults"]["codex"] == profile["id"]


async def test_set_default_already_active_not_gated_by_running_panes(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Re-selecting the already-active account swaps nothing, so running panes
    must not block it."""
    session = _session()
    _register_running_terminal(session, "t1", "claude")

    await app.handle_message(session, {
        "id": "b1a",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": None},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert vault.switch_calls == []


async def test_set_default_other_agent_pane_does_not_block(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    session = _session()
    profile = store.create(agent_key="codex", name="Work")
    _register_running_terminal(session, "t1", "kimi")
    _register_running_terminal(session, "t2", "codex", closed=True)

    await app.handle_message(session, {
        "id": "b2",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "codex", "profile_id": profile["id"]},
    })

    assert session.websocket.sent[0]["ok"] is True  # type: ignore[attr-defined]
    assert session.terminals.killed == []  # type: ignore[attr-defined]
    assert vault.switch_calls == [("codex", "__default__", profile["id"])]


async def test_set_default_ignores_running_login_pane(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """An isolated LOGIN pane is credential-inert: it does not count toward
    the PANES_RUNNING quiescence gate and must never be killed by a switch."""
    session = _session()
    signing_in = store.create(agent_key="codex", name="New")
    target = store.create(agent_key="codex", name="Work")
    _register_running_terminal(
        session, "t-login", "codex", login_profile_id=signing_in["id"]
    )

    await app.handle_message(session, {
        "id": "lp1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "codex", "profile_id": target["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert session.terminals.killed == []  # type: ignore[attr-defined]
    assert vault.switch_calls == [("codex", "__default__", target["id"])]


async def test_set_default_login_in_progress_refused(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """Switching to a profile whose login pane CLI is still running must be
    refused (LOGIN_IN_PROGRESS) — restoring its still-empty slot would sign
    the live state out. No pane is ever killed."""
    session = _session()
    profile = store.create(agent_key="claude", name="New")
    vault.login_home_path("claude", profile["id"]).mkdir(parents=True)
    _register_running_terminal(
        session, "t-login", "claude", login_profile_id=profile["id"]
    )

    await app.handle_message(session, {
        "id": "lp2",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "LOGIN_IN_PROGRESS"
    assert session.terminals.killed == []  # type: ignore[attr-defined]
    assert vault.switch_calls == []
    assert store.list()["defaults"]["claude"] is None


async def test_set_default_harvests_pending_login_before_restore(
    store: CliProfilesStore, events: list[dict[str, Any]], vault: FakeVault
) -> None:
    """A completed-but-unharvested login (pane exited, poller not yet run)
    must land in the slot BEFORE the swap restores it — otherwise the switch
    restores an empty slot and clears the live credentials."""
    session = _session()
    profile = store.create(agent_key="claude", name="New")
    home = vault.login_home_path("claude", profile["id"])
    home.mkdir(parents=True)
    (home / "auth.json").write_text('{"who": "fresh"}', encoding="utf-8")

    harvested_before_swap: list[bool] = []
    orig_switch = vault.switch

    scopes_seen: list[str | None] = []

    def switch_spy(*args: str, scope: str | None = None) -> None:
        harvested_before_swap.append(not home.exists())
        # claude swaps a whole credential, so the handler forwards no
        # provider scope; a per-provider vendor would get its profile's.
        scopes_seen.append(scope)
        orig_switch(*args, scope=scope)

    vault.switch = switch_spy  # type: ignore[method-assign]

    await app.handle_message(session, {
        "id": "lp3",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert vault.login_harvests == [("claude", profile["id"])]
    assert vault.switch_calls == [("claude", "__default__", profile["id"])]
    assert harvested_before_swap == [True]
    assert scopes_seen == [None]


async def test_set_default_swap_failure_keeps_old_default(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    failing = FakeVault(fail=True)
    monkeypatch.setattr(app, "credential_vault", failing)
    session = _session()
    profile = store.create(agent_key="kimi", name="Work")

    await app.handle_message(session, {
        "id": "e1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "kimi", "profile_id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "PROFILE_SWAP_FAILED"
    assert store.list()["defaults"]["kimi"] is None
    assert events == []


# ---- terminal.create: accounts share the real home (no env isolation) ----


@pytest.mark.parametrize("agent_key", ["claude", "kimi", "grok"])
async def test_terminal_create_active_account_gets_no_profile_env(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    agent_key: str,
) -> None:
    """A managed account's regular pane runs on the real home like any other:
    no relocated config home, no env injection or removal — the active
    account's credentials already sit in the live location, and no profile
    home is ever created for the spawn."""
    profile = store.create(agent_key=agent_key, name="Work")
    store.set_default(agent_key, profile["id"])
    session = _session()

    await app.handle_message(session, {
        "id": "m2",
        "type": "terminal.create",
        "payload": {
            "pane_id": f"{agent_key}-pane",
            "agent_key": agent_key,
            "command": agent_key,
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    if agent_key == "kimi":
        assert created["env"] == {"PI_TUI_ESC_TIMEOUT": "100"}
    else:
        assert _env_without_guard_token(created["env"]) is None
    assert created["env_remove"] is None
    assert not real_vault.profile_home_path(agent_key, profile["id"]).exists()


async def test_terminal_create_without_profile_is_unchanged(
    store: CliProfilesStore, spawn_stubs: FakeAttribution
) -> None:
    """Hard regression gate: no active account (built-in default) must spawn
    with the exact pre-profile arguments — no env, no env_remove, no metadata."""
    session = _session()

    await app.handle_message(session, {
        "id": "m3",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert _env_without_guard_token(created["env"]) is None
    assert created["env_remove"] is None
    assert "profile_id" not in created["metadata"]


async def test_terminal_create_codex_active_account_uses_real_home_source(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The per-pane CODEX_HOME mechanism stays (session isolation, not
    credential isolation): even with a managed account active, the pane home's
    symlink source is the real ~/.codex — its auth.json is the live
    credential."""
    profile = store.create(agent_key="codex", name="Work")
    store.set_default("codex", profile["id"])
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    session = _session()

    await app.handle_message(session, {
        "id": "m8",
        "type": "terminal.create",
        "payload": {
            "pane_id": "codex-pane",
            "agent_key": "codex",
            "command": "codex",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws", "session_home_id": "stable-home"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert fake_home.prepared == ["stable-home"]
    assert fake_home.prepared_sources == [None]
    assert created["env"]["CODEX_HOME"] == str(tmp_path / "codex-panes" / "stable-home")
    assert created["env_remove"] is None


# ---- terminal.create: the profile pin is bookkeeping only ----


async def test_terminal_create_pinned_profile_gets_no_profile_env(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    """A recorded pin (restore metadata profile_id) is account bookkeeping
    only: it never relocates the pane's config home or touches the env —
    whatever pin a pane carries, it runs on the live credentials."""
    profile_a = store.create(agent_key="claude", name="A")
    profile_b = store.create(agent_key="claude", name="B")
    store.set_default("claude", profile_b["id"])  # active account is B
    session = _session()

    await app.handle_message(session, {
        "id": "pin1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws", "profile_id": profile_a["id"]},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert _env_without_guard_token(created["env"]) is None
    assert created["env_remove"] is None
    assert not real_vault.profile_home_path("claude", profile_a["id"]).exists()


async def test_terminal_create_pinned_default_stays_on_real_home(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    """A pane pinned to the unmanaged Default ("__default__") runs on the real
    home like every other pane, also while a managed account is active."""
    profile = store.create(agent_key="claude", name="Work")
    store.set_default("claude", profile["id"])  # active managed account
    session = _session()

    await app.handle_message(session, {
        "id": "pin2",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws", "profile_id": "__default__"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert _env_without_guard_token(created["env"]) is None
    assert created["env_remove"] is None


def test_profile_pin_for_spawn_resolves_active_default(
    store: CliProfilesStore,
) -> None:
    """The persisted pin: an explicit value (restore) is kept verbatim; a fresh
    spawn resolves the active default (managed id, or "__default__" for the
    unmanaged Default); non-account agents are never pinned."""
    profile = store.create(agent_key="claude", name="Work")

    # Fresh spawn, no active managed account → Default sentinel.
    assert ws_handlers._profile_pin_for_spawn("claude", None) == "__default__"
    # Fresh spawn with a managed account active → its id.
    store.set_default("claude", profile["id"])
    assert ws_handlers._profile_pin_for_spawn("claude", None) == profile["id"]
    # Restore carries the recorded pin verbatim.
    assert ws_handlers._profile_pin_for_spawn("claude", "some-pin") == "some-pin"
    # Non-account agents are never pinned.
    assert ws_handlers._profile_pin_for_spawn("terminal", None) == ""


# ---- terminal.create: isolated LOGIN panes (login_profile_id) ----


@pytest.fixture()
def real_vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> CredentialVault:
    v = CredentialVault(
        root=tmp_path / "cli-profiles",
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, ""),
        platform="linux",
    )
    (tmp_path / "home").mkdir(exist_ok=True)
    monkeypatch.setattr(app, "credential_vault", v)
    return v


async def _create_login_pane(agent_key: str, profile_id: str) -> app.Session:
    session = _session()
    await app.handle_message(session, {
        "id": "login-1",
        "type": "terminal.create",
        "payload": {
            "pane_id": f"{agent_key}-login-pane",
            "agent_key": agent_key,
            "command": agent_key,
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
            "login_profile_id": profile_id,
        },
    })
    return session


async def test_terminal_create_login_profile_isolates_claude(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    """A login pane runs claude inside the profile's login home (fresh state →
    the CLI prompts its own sign-in) with API overrides dropped; the live
    credentials and every other pane stay on the active account."""
    profile = store.create(agent_key="claude", name="Second")

    session = await _create_login_pane("claude", profile["id"])

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    login_home = real_vault.login_home_path("claude", profile["id"])
    assert created["env"]["CLAUDE_CONFIG_DIR"] == str(login_home)
    # The pane is marked as a LOGIN pane so switch guards and the harvest
    # gate can tell it apart from regular panes.
    assert created["metadata"]["login_profile_id"] == profile["id"]
    assert created["env_remove"] == ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
    assert login_home.is_dir()
    # The active account is untouched.
    assert store.list()["defaults"]["claude"] is None


async def test_terminal_create_login_profile_codex_skips_pane_home(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A codex login pane gets the login home as CODEX_HOME directly — the
    per-pane home would symlink auth.json back to the real ~/.codex and leak
    the login into the live credentials."""
    profile = store.create(agent_key="codex", name="Second")
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "codex_home_manager", fake_home)

    session = await _create_login_pane("codex", profile["id"])

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["CODEX_HOME"] == str(
        real_vault.login_home_path("codex", profile["id"])
    )
    assert fake_home.prepared == []


@pytest.mark.parametrize("agent_key,env_var,home_suffix", [
    ("kimi", "KIMI_CODE_HOME", ""),
    ("grok", "HOME", "home"),
])
async def test_terminal_create_login_profile_kimi_grok(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    agent_key: str,
    env_var: str,
    home_suffix: str,
) -> None:
    profile = store.create(agent_key=agent_key, name="Second")

    session = await _create_login_pane(agent_key, profile["id"])

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    expected = real_vault.login_home_path(agent_key, profile["id"])
    if home_suffix:
        expected = expected / home_suffix
    assert created["env"][env_var] == str(expected)


@pytest.mark.parametrize("agent_key,expected", [
    ("claude", "claude auth login"),
    ("codex", "codex login"),
    ("kimi", "kimi login"),
    ("grok", "grok login"),  # browser OAuth at auth.x.ai; the pane waits
])
async def test_terminal_create_login_pane_runs_direct_login_command(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    agent_key: str,
    expected: str,
) -> None:
    """A login pane never waits for the user to type anything: the backend
    rewrites the spawn command to the CLI's direct sign-in trigger, dropping
    YOLO flags and keeping the shell wrapper."""
    profile = store.create(agent_key=agent_key, name="Second")
    session = _session()

    await app.handle_message(session, {
        "id": "login-cmd",
        "type": "terminal.create",
        "payload": {
            "pane_id": f"{agent_key}-login-pane",
            "agent_key": agent_key,
            "command": ["/bin/zsh", "-ilc", f"{agent_key} --dangerously-skip-permissions"],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
            "login_profile_id": profile["id"],
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["command"] == ["/bin/zsh", "-ilc", expected]


def test_login_spawn_command_variants() -> None:
    # Plain string commands and quoted binary overrides survive the rewrite;
    # non-account agents pass through untouched.
    assert app._login_spawn_command("claude", "claude --flag") == "claude auth login"
    assert app._login_spawn_command(
        "codex", ["/bin/zsh", "-ilc", "'/opt/my codex/codex' --flag"]
    ) == ["/bin/zsh", "-ilc", "'/opt/my codex/codex' login"]
    assert app._login_spawn_command("kilo", "kilo --flag") == "kilo auth login"
    assert app._login_spawn_command("terminal", "bash") == "bash"


async def test_terminal_create_login_pane_starts_login_watch(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    login_watch_calls: list[tuple[str, str]],
) -> None:
    """A successful login spawn starts the fast harvest watch; a regular pane
    does not."""
    profile = store.create(agent_key="claude", name="Second")

    await _create_login_pane("claude", profile["id"])
    assert login_watch_calls == [("claude", profile["id"])]

    session = _session()
    await app.handle_message(session, {
        "id": "plain-1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "plain-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })
    assert login_watch_calls == [("claude", profile["id"])]


async def test_terminal_create_unknown_login_profile_rejected(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    session = await _create_login_pane("claude", "nope")

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "BAD_REQUEST"
    assert session.terminals.created == []  # type: ignore[attr-defined]


async def test_terminal_create_login_profile_wrong_agent_rejected(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    profile = store.create(agent_key="claude", name="Second")

    session = await _create_login_pane("codex", profile["id"])

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "BAD_REQUEST"
    assert session.terminals.created == []  # type: ignore[attr-defined]


def test_sanitize_inherited_cli_env_drops_home_relocations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A backend launched from a shell that still carried home-relocating vars
    # (e.g. `pnpm dev` inside an old profile pane) must not pass them on.
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/tmp/poisoned-claude")
    monkeypatch.setenv("CODEX_HOME", "/tmp/poisoned-codex")
    # CLI child/daemon runtime markers: inherited, claude's makes every
    # spawned pane silently skip transcript saving (blank pane after
    # restart); grok's are the same shape, stripped preemptively.
    monkeypatch.setenv("CLAUDE_CODE_CHILD_SESSION", "1")
    monkeypatch.setenv("GROK_BACKGROUND_CHILD", "1")
    monkeypatch.setenv("GROK_DAEMON_CHILD", "1")

    app._sanitize_inherited_cli_env()

    assert "CLAUDE_CONFIG_DIR" not in os.environ
    assert "CODEX_HOME" not in os.environ
    assert "CLAUDE_CODE_CHILD_SESSION" not in os.environ
    assert "GROK_BACKGROUND_CHILD" not in os.environ
    assert "GROK_DAEMON_CHILD" not in os.environ


# ---- pre-switch token refresh (claude only) ----


def _claude_slot_secret(access: str, refresh: str, expires_at: int) -> str:
    import json

    return json.dumps({
        "claudeAiOauth": {
            "accessToken": access, "refreshToken": refresh, "expiresAt": expires_at,
        }
    })


async def test_set_default_reports_needs_login_for_an_empty_slot(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    vault: FakeVault,
) -> None:
    """Restoring an empty slot CLEARS the live credentials — the CLI is signed
    out the moment the switch lands. The response says so, so the caller can
    start a sign-in instead of dropping the user at a login prompt."""
    profile = store.create(agent_key="claude", name="Work")
    session = _session()

    await app.handle_message(session, {
        "id": "n1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    sent = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert sent["ok"] is True
    assert sent["payload"]["needsLogin"] is True
    assert sent["payload"]["needsLoginReason"] == "signed-out"


async def test_set_default_does_not_ask_login_for_an_expired_but_refreshable_snapshot(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    vault: FakeVault,
) -> None:
    """Nothing renews a parked slot — the CLI is the only refresher — so an
    aged snapshot goes live expired, and Claude Code renews it from the
    restored refresh token on its next run. That is routine: the switch must
    not start a sign-in (every account parked longer than one access-token
    lifetime would re-login on each switch) and, crucially, never mints a
    token itself: rotating one out from under a running Claude Code is what
    killed accounts before."""
    import json

    profile = store.create(agent_key="claude", name="Work")
    vault.slot_secrets[("claude", profile["id"])] = _claude_slot_secret(
        "dead", "rt-work", 1_000
    )
    session = _session()

    await app.handle_message(session, {
        "id": "n2",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    sent = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert sent["ok"] is True
    assert sent["payload"]["needsLogin"] is False
    assert sent["payload"]["needsLoginReason"] is None
    assert vault.slot_writes == []
    assert json.loads(
        vault.slot_secrets[("claude", profile["id"])]
    )["claudeAiOauth"]["accessToken"] == "dead"


async def test_set_default_reports_needs_login_for_an_expired_snapshot_without_refresh_token(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    vault: FakeVault,
) -> None:
    """An expired access token with nothing to refresh it from cannot recover
    on its own — the switch offers a sign-in. Told apart from a lost login:
    parking an account does this to it, and calling it "signed out" reads as
    the switch having broken something."""
    profile = store.create(agent_key="claude", name="Work")
    vault.slot_secrets[("claude", profile["id"])] = _claude_slot_secret(
        "dead", "", 1_000
    )
    session = _session()

    await app.handle_message(session, {
        "id": "n2b",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    sent = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert sent["ok"] is True
    assert sent["payload"]["needsLogin"] is True
    assert sent["payload"]["needsLoginReason"] == "expired"
    assert vault.slot_writes == []


async def test_set_default_reports_needs_login_for_a_wiped_snapshot(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    vault: FakeVault,
) -> None:
    """Claude Code empties both tokens in place when a refresh is rejected.
    The blob still parses and its expiry is far in the future, so the expiry
    check alone calls it usable — but restoring it leaves the CLI with no
    credential at all, exactly like an empty slot. Offer the sign-in."""
    profile = store.create(agent_key="claude", name="Work")
    vault.slot_secrets[("claude", profile["id"])] = _claude_slot_secret(
        "", "", 4_102_444_800_000
    )
    session = _session()

    await app.handle_message(session, {
        "id": "n4",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    sent = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert sent["ok"] is True
    assert sent["payload"]["needsLogin"] is True
    assert sent["payload"]["needsLoginReason"] == "signed-out"


async def test_set_default_reports_no_login_needed_for_a_usable_slot(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    vault: FakeVault,
) -> None:
    """A slot whose token is still valid switches silently — no sign-in."""
    profile = store.create(agent_key="claude", name="Work")
    vault.slot_secrets[("claude", profile["id"])] = _claude_slot_secret(
        "good", "rt-work", 4_102_444_800_000
    )
    session = _session()

    await app.handle_message(session, {
        "id": "n3",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "claude", "profile_id": profile["id"]},
    })

    sent = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert sent["payload"]["needsLogin"] is False
    assert sent["payload"]["needsLoginReason"] is None


@pytest.mark.parametrize(
    "extra",
    [{}, {"name": None}, {"name": 0}, {"name": False}, {"name": ["Work"]}],
    ids=["missing", "null", "zero", "false", "list"],
)
async def test_cli_profiles_rename_without_a_string_name_is_bad_request(
    store: CliProfilesStore, events: list[dict[str, Any]], extra: dict[str, Any]
) -> None:
    """Only an explicit "" clears an alias; a missing or non-string name is a
    malformed request, not a request to clear."""
    profile = store.create(agent_key="claude", name="Old")
    store.rename(profile["id"], "Work")
    store.set_default_name("claude", "Main")
    session = _session()

    await app.handle_message(session, {
        "id": "rn1", "type": "cli_profiles.rename", "payload": {"id": profile["id"], **extra},
    })
    await app.handle_message(session, {
        "id": "rn2",
        "type": "cli_profiles.rename",
        "payload": {"id": "__default__", "agentKey": "claude", **extra},
    })

    for response in session.websocket.sent[:2]:  # type: ignore[attr-defined]
        assert response["ok"] is False
        assert response["error"]["code"] == "BAD_REQUEST"
    assert store.list()["profiles"][0]["name"] == "Work"
    assert store.list()["defaultNames"] == {"claude": "Main"}
    assert events == []


async def test_cli_profiles_rename_empty_string_still_clears(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    profile = store.create(agent_key="claude", name="Old")
    store.rename(profile["id"], "Work")
    session = _session()

    await app.handle_message(session, {
        "id": "rn3", "type": "cli_profiles.rename", "payload": {"id": profile["id"], "name": ""},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert "nameIsCustom" not in response["payload"]["profile"]


async def test_cli_profiles_rename_too_long_is_bad_request(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    profile = store.create(agent_key="claude", name="Old")
    session = _session()

    await app.handle_message(session, {
        "id": "rn4", "type": "cli_profiles.rename", "payload": {"id": profile["id"], "name": "x" * 65},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "BAD_REQUEST"
    assert "64" in response["error"]["message"]
