"""Frozen launch facts for panes that never used a pasted credential.

Removing the portable-credential feature must leave every other pane's
launch byte-identical: the names ``credential_env_vars`` reports (the
env-override detection and the CredentialLaunch helper both read them, in
order), the provenance ``pane_auth_scope`` records, and what terminal.create
hands the PTY — environment, removals and credential metadata. The values
below were captured on main before the removal; a change here is a change of
behaviour for users who never touched the feature.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, quota_failover, ws_handlers
from agent_team_backend.cli_vendors import registry
from agent_team_backend.db import Database
from agent_team_backend.profiles_store import CliProfilesStore

CLAUDE_CREDENTIAL_ENV = (
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
)


# ---- credential_env_vars -----------------------------------------------------

def test_credential_env_vars_are_frozen_for_every_vendor():
    observed = {key: quota_failover.credential_env_vars(key) for key in sorted(registry.VENDORS)}
    expected = {key: () for key in observed}
    expected["claude"] = CLAUDE_CREDENTIAL_ENV
    assert observed == expected


def test_credential_env_vars_unknown_vendor_is_empty():
    assert quota_failover.credential_env_vars("no-such-cli") == ()


# ---- pane_auth_scope ---------------------------------------------------------

@pytest.mark.parametrize(
    ("env", "env_remove", "account_dir", "source", "overriding"),
    [
        ({}, (), False, "vault", []),
        ({"NAVIDE_PANE_ID": "p"}, (), False, "vault", []),
        ({"ANTHROPIC_BASE_URL": "x", "CLAUDE_CODE_USE_BEDROCK": "1"}, (), False,
         "env-override", ["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BASE_URL"]),
        ({"CLAUDE_CODE_OAUTH_TOKEN": "t"}, (), False, "env-override", ["CLAUDE_CODE_OAUTH_TOKEN"]),
        ({"ANTHROPIC_API_KEY": "k"}, ("ANTHROPIC_API_KEY",), False, "vault", []),
        ({"ANTHROPIC_API_KEY": "k"}, (), True, "account-dir", []),
    ],
)
def test_claude_pane_auth_scope_is_frozen(env, env_remove, account_dir, source, overriding):
    result = quota_failover.pane_auth_scope(
        "claude", None, env=env, env_remove=env_remove, account_dir=account_dir)
    assert result["profileId"] == "__default__"
    assert result["scope"] is None
    assert result["authScope"] == "claude"
    assert result["credentialSource"] == source
    assert result["credentialEnv"] == overriding


@pytest.mark.parametrize("agent_key", sorted(k for k in registry.VENDORS if k != "claude"))
def test_other_vendors_ignore_claude_credential_variables(agent_key):
    env = {name: "x" for name in CLAUDE_CREDENTIAL_ENV}
    result = quota_failover.pane_auth_scope(agent_key, None, env=env)
    assert result["credentialSource"] == "vault"
    assert result["credentialEnv"] == []


# ---- terminal.create ---------------------------------------------------------

class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.sessions: dict[str, SimpleNamespace] = {}

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        term = SimpleNamespace(
            id=f"term-{len(self.created)}", pane_id=kwargs["pane_id"], command=kwargs["command"],
            proc=SimpleNamespace(pid=1234), closed=False,
            started_monotonic=float(len(self.created)),
            metadata=kwargs.get("metadata") or {},
        )
        self.sessions[term.id] = term
        return term

    def get(self, session_id: str) -> SimpleNamespace | None:
        return self.sessions.get(session_id)

    def live_session_ids_for_pane(self, pane_id: str) -> list[str]:
        return [t.id for t in self.sessions.values() if t.pane_id == pane_id and not t.closed]

    async def kill(self, session_id: str, force: bool = False) -> None:
        pass

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


class FakeAttribution:
    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        pass

    def scan_pane_baseline(self, pane_id: str) -> None:
        pass

    def unregister_pane(self, pane_id: str, **kwargs: Any) -> None:
        pass


@pytest.fixture
def wired(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "database", Database(tmp_path / "navide.db"))
    monkeypatch.setattr(app, "cli_profiles_store", CliProfilesStore(
        path=tmp_path / "cli-profiles.json", profiles_root=tmp_path / "cli-profiles"))

    async def broadcast(message: dict) -> None:
        pass

    monkeypatch.setattr(app, "broadcast", broadcast)
    monkeypatch.setattr(ws_handlers, "_profile_account_view",
                        lambda: {"identities": {}, "duplicates": {}, "accountDirs": {}})
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(
        app, "_probe_agent_cli_for_spawn",
        lambda agent_key, _command=None: {
            "agent_key": agent_key, "binary_path": f"/test/bin/{agent_key}",
            "version": "1.0.0", "duration_ms": 1,
        },
    )
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
    for name in CLAUDE_CREDENTIAL_ENV:
        monkeypatch.delenv(name, raising=False)
    (tmp_path / "home").mkdir()
    (tmp_path / "ws").mkdir()
    return tmp_path


async def _spawn(tmp_path: Path, agent: str) -> dict[str, Any]:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    await app.handle_message(session, {
        "id": "c1", "type": "terminal.create",
        "payload": {"pane_id": f"{agent}-pane", "agent_key": agent, "command": agent,
                    "cwd": str(tmp_path / "ws"), "metadata": {"workspace_path": "/ws"}},
    })
    created = session.terminals.created  # type: ignore[attr-defined]
    assert len(created) == 1, session.websocket.sent  # type: ignore[attr-defined]
    return created[0]


CREDENTIAL_METADATA = ("launch_profile_id", "profile_scope", "auth_scope",
                       "credential_source", "credential_env")


def _credential_facts(created: dict[str, Any]) -> dict[str, Any]:
    env = created.get("env") or {}
    return {
        "credentialEnvInjected": sorted(n for n in env if n in CLAUDE_CREDENTIAL_ENV),
        "envRemove": created.get("env_remove"),
        "metadata": {k: created["metadata"].get(k) for k in CREDENTIAL_METADATA},
        "portableSlot": "portable_slot_id" in created["metadata"],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("agent", "inherited", "expected"),
    [
        ("claude", {}, {
            "credentialEnvInjected": [], "envRemove": None, "portableSlot": False,
            "metadata": {"launch_profile_id": "__default__", "profile_scope": None,
                         "auth_scope": "claude", "credential_source": "vault",
                         "credential_env": []},
        }),
        # Inherited from the backend's own environment, not handed to the
        # pane by Navide: the spawn leaves it to the PTY's inheritance and
        # records nothing about it here.
        ("claude", {"ANTHROPIC_API_KEY": "inherited"}, {
            "credentialEnvInjected": [], "envRemove": None, "portableSlot": False,
            "metadata": {"launch_profile_id": "__default__", "profile_scope": None,
                         "auth_scope": "claude", "credential_source": "vault",
                         "credential_env": []},
        }),
        ("codex", {}, {
            "credentialEnvInjected": [], "envRemove": None, "portableSlot": False,
            "metadata": {"launch_profile_id": "__default__", "profile_scope": None,
                         "auth_scope": "codex", "credential_source": "vault",
                         "credential_env": []},
        }),
    ],
)
async def test_spawn_credential_facts_are_frozen(wired, monkeypatch, agent, inherited, expected):
    for name, value in inherited.items():
        monkeypatch.setenv(name, value)
    created = await _spawn(wired, agent)
    assert _credential_facts(created) == expected
