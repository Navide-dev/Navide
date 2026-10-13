"""Spawning claude on an account's own config dir, and the pane-default
account. An account that signed in inside its dir runs there; an account that
never did keeps the swap model exactly as before. The live credential and the
swap slots are never touched."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, quota_failover
from agent_team_backend.credential_vault import DEFAULT_SLOT_ID, CredentialVault
from agent_team_backend.profiles_store import CliProfilesStore
from tests.test_app_cli_profiles import (  # noqa: F401 — pytest fixtures
    FakeAttribution,
    _session,
    _stub_agent_cli_probe,
    events,
    login_watch_calls,
    real_vault,
    spawn_stubs,
    store,
)


def _sign_in_dir(vault: CredentialVault, profile_id: str, email: str = "b@example.com") -> Path:
    """What Claude Code leaves behind after `claude auth login` in the dir
    (file platform: .credentials.json; .claude.json carries the account)."""
    directory = vault.prepare_account_dir(profile_id)
    (directory / ".credentials.json").write_text("{}", encoding="utf-8")
    (directory / ".claude.json").write_text(
        json.dumps({"oauthAccount": {"emailAddress": email}}), encoding="utf-8")
    return directory


async def _spawn(session: app.Session, **extra: Any) -> dict[str, Any]:
    metadata = {"workspace_path": "/ws", **extra.pop("metadata", {})}
    await app.handle_message(session, {
        "id": "s1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": metadata,
            **extra,
        },
    })
    created = session.terminals.created  # type: ignore[attr-defined]
    assert created, session.websocket.sent  # type: ignore[attr-defined]
    return created[0]


@pytest.fixture()
def dir_watch_calls(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    from agent_team_backend import usage_service

    started: list[str] = []
    monkeypatch.setattr(usage_service, "start_account_dir_login_watch", started.append)
    return started


async def test_pinned_pane_runs_on_its_signed_in_account_dir(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    profile = store.create(agent_key="claude", name="B")
    directory = _sign_in_dir(real_vault, profile["id"])
    created = await _spawn(_session(), metadata={"profile_id": profile["id"]})
    assert created["env"]["CLAUDE_CONFIG_DIR"] == str(directory)
    assert "ANTHROPIC_API_KEY" in created["env_remove"]
    assert created["metadata"]["account_dir_profile_id"] == profile["id"]
    assert created["metadata"]["profile_id"] == profile["id"]
    assert created["metadata"]["credential_source"] == "account-dir"


async def test_account_without_a_dir_login_keeps_the_live_credential(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    profile = store.create(agent_key="claude", name="B")
    created = await _spawn(_session(), metadata={"profile_id": profile["id"]})
    assert "CLAUDE_CONFIG_DIR" not in (created["env"] or {})
    assert "account_dir_profile_id" not in created["metadata"]
    assert created["metadata"]["credential_source"] == "vault"
    assert not real_vault.account_dir_path(profile["id"]).exists()


async def test_renderer_cannot_claim_an_account_dir(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    profile = store.create(agent_key="claude", name="B")
    created = await _spawn(_session(), metadata={
        "account_dir_profile_id": profile["id"], "account_dir_login": True,
    })
    assert "CLAUDE_CONFIG_DIR" not in (created["env"] or {})
    assert "account_dir_profile_id" not in created["metadata"]
    assert "account_dir_login" not in created["metadata"]


async def test_fresh_pane_follows_the_live_credential_despite_the_pane_default(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    """Plan claude_f1bf4b (scheme A): only an explicit pin runs on an account
    dir. A fresh pane follows the live credential even when the pane default
    signed in inside its dir."""
    profile = store.create(agent_key="claude", name="B")
    _sign_in_dir(real_vault, profile["id"])
    store.set_pane_default("claude", profile["id"])
    created = await _spawn(_session())
    assert "CLAUDE_CONFIG_DIR" not in (created["env"] or {})
    assert "account_dir_profile_id" not in created["metadata"]
    # Filed under the live credential's owner, as any pane on the live login.
    assert created["metadata"]["profile_id"] == DEFAULT_SLOT_ID


async def test_fresh_pane_follows_the_live_credential_when_the_live_owner_has_a_dir(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    """The live owner having signed in inside its own dir no longer files new
    panes there: they stay on the live credential, so a switch reaches them."""
    live = store.create(agent_key="claude", name="A")
    store.set_default("claude", live["id"])
    _sign_in_dir(real_vault, live["id"])
    created = await _spawn(_session())
    assert "CLAUDE_CONFIG_DIR" not in (created["env"] or {})
    assert "account_dir_profile_id" not in created["metadata"]
    assert created["metadata"]["credential_source"] == "vault"


async def test_pane_default_without_a_dir_login_files_the_pane_under_the_live_owner(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    live = store.create(agent_key="claude", name="A")
    chosen = store.create(agent_key="claude", name="B")
    store.set_default("claude", live["id"])
    store.set_pane_default("claude", chosen["id"])
    created = await _spawn(_session())
    assert "CLAUDE_CONFIG_DIR" not in (created["env"] or {})
    assert created["metadata"]["profile_id"] == live["id"]


async def test_account_dir_login_signs_in_inside_the_dir(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    dir_watch_calls: list[str],
) -> None:
    profile = store.create(agent_key="claude", name="B")
    created = await _spawn(
        _session(), metadata={"profile_id": profile["id"]}, account_dir_login=True)
    directory = real_vault.account_dir_path(profile["id"])
    assert created["env"]["CLAUDE_CONFIG_DIR"] == str(directory)
    assert directory.is_dir()
    assert created["metadata"]["account_dir_login"] is True
    assert created["command"] == "claude auth login"
    assert dir_watch_calls == [profile["id"]]
    # The swap model is untouched: no login home, no default change.
    assert not real_vault.login_home_path("claude", profile["id"]).exists()
    assert store.list()["defaults"]["claude"] is None


async def test_account_dir_login_needs_a_claude_profile(
    store: CliProfilesStore, spawn_stubs: FakeAttribution, real_vault: CredentialVault
) -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "s1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane", "agent_key": "claude", "command": "claude",
            "cwd": "/ws", "metadata": {"workspace_path": "/ws", "profile_id": "nope"},
            "account_dir_login": True,
        },
    })
    assert session.terminals.created == []  # type: ignore[attr-defined]
    reply = session.websocket.sent[-1]  # type: ignore[attr-defined]
    assert reply["ok"] is False


async def _send(session: app.Session, msg_type: str, payload: dict) -> dict:
    await app.handle_message(session, {"id": "r1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


async def test_set_pane_default_requires_a_dir_login(
    store: CliProfilesStore, real_vault: CredentialVault, events: list[dict[str, Any]]
) -> None:
    profile = store.create(agent_key="claude", name="B")
    session = _session()
    refused = await _send(session, "cli_profiles.set_pane_default",
                          {"agent_key": "claude", "profile_id": profile["id"]})
    assert refused["ok"] is False
    assert refused["error"]["code"] == "ACCOUNT_DIR_SIGNED_OUT"
    assert store.get_pane_default("claude") is None

    _sign_in_dir(real_vault, profile["id"])
    ok = await _send(session, "cli_profiles.set_pane_default",
                     {"agent_key": "claude", "profile_id": profile["id"]})
    assert ok["ok"] is True
    assert store.get_pane_default("claude") == profile["id"]
    assert events[-1]["payload"]["reason"] == "set_pane_default"
    assert events[-1]["payload"]["paneDefaults"] == {"claude": profile["id"]}
    # Nothing was swapped.
    assert store.list()["defaults"]["claude"] is None

    cleared = await _send(session, "cli_profiles.set_pane_default",
                          {"agent_key": "claude", "profile_id": None})
    assert cleared["ok"] is True
    assert store.get_pane_default("claude") is None


async def test_set_pane_default_is_claude_only(
    store: CliProfilesStore, real_vault: CredentialVault
) -> None:
    profile = store.create(agent_key="codex", name="B")
    reply = await _send(_session(), "cli_profiles.set_pane_default",
                        {"agent_key": "codex", "profile_id": profile["id"]})
    assert reply["ok"] is False


async def test_list_reports_account_dirs_and_their_identity(
    store: CliProfilesStore, real_vault: CredentialVault
) -> None:
    signed = store.create(agent_key="claude", name="B")
    unsigned = store.create(agent_key="claude", name="C")
    _sign_in_dir(real_vault, signed["id"], email="b@example.com")
    store.set_pane_default("claude", signed["id"])
    reply = await _send(_session(), "cli_profiles.list", {})
    payload = reply["payload"]
    dirs = payload["accountDirs"]["claude"]
    assert dirs[signed["id"]] == {"signedIn": True, "email": "b@example.com"}
    assert dirs[unsigned["id"]] == {"signedIn": False, "email": None}
    assert DEFAULT_SLOT_ID not in dirs
    assert payload["identities"]["claude"][signed["id"]] == {
        "email": "b@example.com", "signedIn": True}
    assert payload["paneDefaults"] == {"claude": signed["id"]}


def test_deleting_a_profile_clears_its_pane_default(store: CliProfilesStore) -> None:
    profile = store.create(agent_key="claude", name="B")
    store.set_pane_default("claude", profile["id"])
    store.delete(profile["id"])
    assert store.get_pane_default("claude") is None


def test_account_dir_panes_are_not_counted_as_vault_panes() -> None:
    scope = quota_failover.pane_auth_scope(
        "claude", None, env={"CLAUDE_CONFIG_DIR": "/x"}, account_dir=True)
    assert scope["credentialSource"] == "account-dir"


async def test_deleting_an_account_in_use_by_an_account_dir_pane_is_refused(
    store: CliProfilesStore, real_vault: CredentialVault, events: list[dict[str, Any]]
) -> None:
    """A pane running on the account's own config dir would lose that dir
    when the slot is archived and fall into "Login expired"; refuse instead,
    with a code the UI can explain."""
    from types import SimpleNamespace

    profile = store.create(agent_key="claude", name="B")
    _sign_in_dir(real_vault, profile["id"])
    session = _session()
    term = SimpleNamespace(
        id="t-dir", agent_key="claude", closed=False,
        metadata={"account_dir_profile_id": profile["id"]},
    )
    session.terminals.registry["t-dir"] = term  # type: ignore[attr-defined]
    app._PTY_OWNERS["t-dir"] = session
    try:
        reply = await _send(session, "cli_profiles.delete", {"id": profile["id"]})
    finally:
        app._PTY_OWNERS.pop("t-dir", None)
    assert reply["ok"] is False
    assert reply["error"]["code"] == "ACCOUNT_DIR_IN_USE"
    assert reply["error"]["details"]["count"] == 1
    assert store.get(profile["id"]) is not None
    assert real_vault.account_dir_signed_in(profile["id"]) is True


async def test_a_pane_reporting_its_dir_login_expired_sends_new_panes_back_to_live(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    real_vault: CredentialVault,
    events: list[dict[str, Any]],
) -> None:
    profile = store.create(agent_key="claude", name="B")
    _sign_in_dir(real_vault, profile["id"])
    session = _session()
    reply = await _send(session, "cli_profiles.account_dir_expired", {"profile_id": profile["id"]})
    assert reply["ok"] is True
    assert events[-1]["payload"]["accountDirs"]["claude"][profile["id"]]["signedIn"] is False
    created = await _spawn(_session(), metadata={"profile_id": profile["id"]})
    assert "CLAUDE_CONFIG_DIR" not in (created["env"] or {})


async def test_account_dir_expired_needs_a_claude_profile(
    store: CliProfilesStore, real_vault: CredentialVault
) -> None:
    reply = await _send(_session(), "cli_profiles.account_dir_expired", {"profile_id": "nope"})
    assert reply["ok"] is False
