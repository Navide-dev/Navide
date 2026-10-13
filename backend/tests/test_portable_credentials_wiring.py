"""Portable credentials wired through the app: the Claude declaration, the
cli_profiles.portable_* routes, and terminal.create's locked injection.

Every route reply and broadcast is checked for the one thing that matters
most — the secret is consumed and never echoed — and the spawn is checked
for the one behaviour the plan forbids: falling back to the CLI's own login
when the selected credential cannot be used.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, portable_credentials as pc, ws_handlers
from agent_team_backend.cli_vendors.base import SlotKind
from agent_team_backend.cli_vendors.claude import SPEC as CLAUDE, classify_secret
from agent_team_backend.db import Database
from agent_team_backend.profiles_store import CliProfilesStore

TOKEN = "sk-ant-oat01-synthetic-token-value-0123456789"


# ---- Claude declaration ----------------------------------------------------

def test_claude_declares_setup_token_interface():
    declared = CLAUDE.portable_credential
    assert declared is not None
    assert declared.env == "CLAUDE_CODE_OAUTH_TOKEN" and declared.kind == "oauth"
    assert declared.obtain_command == "claude setup-token"
    assert declared.quota_verified is True
    # Everything the documented precedence list ranks above the token, and
    # the endpoint override — never the token variable itself.
    assert set(declared.env_remove) == {
        "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_MANTLE", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
    }
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in declared.env_remove
    roots = dict(declared.managed_roots)
    assert roots == {
        "darwin": "/Library/Application Support/ClaudeCode",
        "linux": "/etc/claude-code",
        "win32": r"C:\Program Files\ClaudeCode",
    }
    files = {(root, parts) for root, parts, _ in declared.shadowing_settings}
    assert files == {
        ("home", (".claude", "settings.json")),
        ("cwd", (".claude", "settings.json")),
        ("cwd", (".claude", "settings.local.json")),
        ("managed", ("managed-settings.json",)),
    }
    keys = {key for _, _, key in declared.shadowing_settings}
    assert ("apiKeyHelper",) in keys
    assert ("env", "ANTHROPIC_API_KEY") in keys and ("env", "ANTHROPIC_BASE_URL") in keys
    assert ("managed", ("managed-settings.json",), ("forceLoginMethod",)) in declared.shadowing_settings


@pytest.mark.parametrize(
    ("secret", "expected"),
    [
        (json.dumps({"claudeAiOauth": {"accessToken": "a", "refreshToken": "r"}}), SlotKind.OAUTH),
        (json.dumps({"claudeAiOauth": {"accessToken": ""}}), SlotKind.UNKNOWN),
        (json.dumps({"claudeAiOauth": {}}), SlotKind.UNKNOWN),
        (json.dumps({"primaryApiKey": "sk-ant-api03-x"}), SlotKind.UNKNOWN),
        ("not json", SlotKind.UNKNOWN),
        ("[]", SlotKind.UNKNOWN),
    ],
)
def test_claude_classifier_only_vouches_for_oauth(secret, expected):
    assert classify_secret(secret) is expected
    assert pc.classify_slot("claude", secret) is expected


def test_claude_classify_slot_empty():
    assert pc.classify_slot("claude", "") is SlotKind.EMPTY


def test_only_claude_is_supported_for_now():
    assert pc.supported_agent_keys() == ["claude"]


def test_claude_plan_removes_the_documented_higher_precedence_variables(tmp_path):
    plan = pc.plan_injection("claude", TOKEN, home=tmp_path / "home", cwd=tmp_path / "ws")
    assert plan.active
    assert plan.env == {"CLAUDE_CODE_OAUTH_TOKEN": TOKEN}
    assert "ANTHROPIC_API_KEY" in plan.env_remove and "ANTHROPIC_BASE_URL" in plan.env_remove


@pytest.mark.parametrize(
    ("where", "body", "expected"),
    [
        (("home", ".claude", "settings.json"), {"apiKeyHelper": "/bin/key"},
         "home:.claude/settings.json:apiKeyHelper"),
        (("home", ".claude", "settings.json"), {"env": {"ANTHROPIC_BASE_URL": "https://proxy"}},
         "home:.claude/settings.json:env.ANTHROPIC_BASE_URL"),
        (("ws", ".claude", "settings.local.json"), {"env": {"ANTHROPIC_API_KEY": "sk"}},
         "cwd:.claude/settings.local.json:env.ANTHROPIC_API_KEY"),
        (("ws", ".claude", "settings.json"), {"env": {"CLAUDE_CODE_USE_VERTEX": "1"}},
         "cwd:.claude/settings.json:env.CLAUDE_CODE_USE_VERTEX"),
    ],
)
def test_claude_plan_is_blocked_by_settings_that_outrank_the_token(tmp_path, where, body, expected):
    path = tmp_path.joinpath(*where)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body))
    plan = pc.plan_injection("claude", TOKEN, home=tmp_path / "home", cwd=tmp_path / "ws")
    assert plan.shadowed_by == (expected,) and not plan.active


def test_claude_empty_env_override_does_not_block(tmp_path):
    """Claude Code treats an empty value as unset for provider selection —
    the documented way to cancel a stale CLAUDE_CODE_USE_VERTEX."""
    path = tmp_path / "home" / ".claude" / "settings.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"env": {"CLAUDE_CODE_USE_VERTEX": ""}}))
    assert pc.plan_injection("claude", TOKEN, home=tmp_path / "home").active


# ---- WS routes -------------------------------------------------------------

class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.killed: list[tuple[str, bool]] = []
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
        self.killed.append((session_id, force))

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


class FakeAttribution:
    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        pass

    def scan_pane_baseline(self, pane_id: str) -> None:
        pass

    def unregister_pane(self, pane_id: str, **kwargs: Any) -> None:
        pass


def _session() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    return session


@pytest.fixture(autouse=True)
def _wired(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "database", Database(tmp_path / "navide.db"))
    # The profiles store is process-wide too; the active-profile test below
    # sets a default that must not leak into the next test's spawn.
    monkeypatch.setattr(app, "cli_profiles_store", CliProfilesStore(
        path=tmp_path / "cli-profiles.json", profiles_root=tmp_path / "cli-profiles"))
    pc.clear_memory()
    broadcasts: list[dict] = []

    async def broadcast(message: dict) -> None:
        broadcasts.append(message)

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
    (tmp_path / "home").mkdir()
    (tmp_path / "ws").mkdir()
    yield broadcasts
    pc.clear_memory()
    for pane in ("claude-pane", "login-pane", "live-login", "shell-pane"):
        pc.forget_launch(pane)


async def _call(session: app.Session, msg_type: str, payload: dict, msg_id: str = "m1") -> dict:
    await app.handle_message(session, {"id": msg_id, "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_portable_set_schedules_the_sync_push_on_the_loop(_wired, monkeypatch):
    from agent_team_backend import sync_scopes

    seen: list[tuple] = []

    def credential_saved(agent_key: str, slot_id: str) -> None:
        # What the real hook needs: a running loop to create its task on.
        seen.append((agent_key, slot_id, asyncio.get_running_loop() is not None))

    monkeypatch.setattr(sync_scopes, "credential_saved", credential_saved, raising=False)
    session = _session()
    await _call(session, "cli_profiles.portable_set",
                {"agent_key": "claude", "profile_id": "__default__", "secret": TOKEN})
    assert seen == [("claude", "__default__", True)]


@pytest.mark.asyncio
async def test_live_login_pane_never_gets_the_token(_wired):
    """A live login (is_login without a profile id) signs the active account
    in again; it reaches the profile-agent branch and must still be skipped."""
    pc.store("claude", "__default__", TOKEN)
    session = _session()
    message = _create(pane="live-login")
    message["payload"]["is_login"] = True
    await app.handle_message(session, message)
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in (created["env"] or {})
    assert created["env_remove"] is None


@pytest.mark.asyncio
async def test_portable_set_get_clear_round_trip(_wired):
    session = _session()
    reply = await _call(session, "cli_profiles.portable_set",
                        {"agent_key": "claude", "profile_id": "__default__", "secret": TOKEN})
    assert reply["type"] == "cli_profiles.portable_set.result" and reply["ok"]
    portable = reply["payload"]["portable"]
    assert portable["configured"] and portable["enabled"] and portable["env"] == "CLAUDE_CODE_OAUTH_TOKEN"
    assert TOKEN not in json.dumps(reply)
    changed = [m for m in _wired if m.get("type") == "cli_profiles.changed"]
    assert changed and changed[-1]["payload"]["reason"] == "portable-set"
    assert "claude/__default__" in changed[-1]["payload"]["portable_credentials"]
    assert TOKEN not in json.dumps(_wired)

    reply = await _call(session, "cli_profiles.portable_get",
                        {"agent_key": "claude"}, msg_id="m2")  # no profile_id = Default
    assert reply["payload"]["portable"]["configured"] is True
    assert TOKEN not in json.dumps(reply)

    reply = await _call(session, "cli_profiles.list", {}, msg_id="m3")
    assert reply["payload"]["portable_supported"] == ["claude"]
    assert reply["payload"]["portable_credentials"]["claude/__default__"]["enabled"] is True
    assert TOKEN not in json.dumps(reply)

    reply = await _call(session, "cli_profiles.portable_enable",
                        {"agent_key": "claude", "profile_id": "__default__", "enabled": False}, msg_id="m4")
    assert reply["payload"]["portable"]["enabled"] is False

    reply = await _call(session, "cli_profiles.portable_clear",
                        {"agent_key": "claude", "profile_id": "__default__"}, msg_id="m5")
    assert reply["payload"] == {"ok": True}
    reply = await _call(session, "cli_profiles.list", {}, msg_id="m6")
    assert reply["payload"]["portable_credentials"] == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"agent_key": "claude", "profile_id": "__default__", "secret": "two\nlines"},
        {"agent_key": "claude", "profile_id": "__default__", "secret": ""},
        {"agent_key": "claude", "profile_id": "__default__"},
        {"agent_key": "claude", "profile_id": "../x", "secret": TOKEN},
        {"agent_key": "codex", "profile_id": "__default__", "secret": TOKEN},
        {"agent_key": "nobody", "profile_id": "__default__", "secret": TOKEN},
    ],
)
async def test_portable_set_rejects_bad_requests_without_storing(_wired, payload):
    session = _session()
    reply = await _call(session, "cli_profiles.portable_set", payload)
    assert reply["ok"] is False and reply["error"]["code"] == "BAD_REQUEST"
    assert TOKEN not in json.dumps(reply)
    assert pc.list_stored() == []
    assert not [m for m in _wired if m.get("type") == "cli_profiles.changed"]


# ---- spawn -----------------------------------------------------------------

def _create(pane: str = "claude-pane", agent: str = "claude", cwd: str = "") -> dict:
    return {
        "id": "c1", "type": "terminal.create",
        "payload": {"pane_id": pane, "agent_key": agent, "command": agent,
                    "cwd": cwd or str(Path.home().parent / "ws"),
                    "metadata": {"workspace_path": "/ws"}},
    }


@pytest.mark.asyncio
async def test_spawn_injects_the_selected_token_and_strips_conflicts(_wired, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "leaked-from-shell")
    pc.store("claude", "__default__", TOKEN)
    session = _session()
    await app.handle_message(session, _create())
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN
    assert "ANTHROPIC_API_KEY" in created["env_remove"]
    assert "ANTHROPIC_BASE_URL" in created["env_remove"]
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in created["env_remove"]
    # Nothing about the spawn — reply, events, log — carries the value.
    assert TOKEN not in json.dumps(session.websocket.sent)  # type: ignore[attr-defined]
    assert TOKEN not in json.dumps(_wired)


@pytest.mark.asyncio
async def test_spawn_without_a_selection_is_untouched(_wired):
    session = _session()
    await app.handle_message(session, _create())
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in (created["env"] or {})
    assert created["env_remove"] is None


@pytest.mark.asyncio
async def test_spawn_with_a_disabled_selection_is_untouched(_wired):
    pc.store("claude", "__default__", TOKEN)
    pc.set_enabled("claude", "__default__", False)
    session = _session()
    await app.handle_message(session, _create())
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in (created["env"] or {})


@pytest.mark.asyncio
async def test_spawn_refuses_when_the_selected_token_is_shadowed(_wired, tmp_path):
    """The user chose the pasted token; a key helper on this machine would
    outrank it. Refuse — do not start the pane as whoever that helper is."""
    pc.store("claude", "__default__", TOKEN)
    settings = Path.home() / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({"apiKeyHelper": "/usr/local/bin/other-identity"}))
    session = _session()
    await app.handle_message(session, _create())
    assert session.terminals.created == []  # type: ignore[attr-defined]
    error = session.websocket.sent[-1]  # type: ignore[attr-defined]
    assert error["error"]["code"] == "PORTABLE_CREDENTIAL_UNAVAILABLE"
    data = error["error"]["details"]
    assert data["reason"] == "shadowed" and data["agent_key"] == "claude"
    assert data["profile_id"] == "__default__"
    assert data["shadowedBy"] == ["home:.claude/settings.json:apiKeyHelper"]
    assert TOKEN not in json.dumps(error)
    # The settings file was not modified.
    assert json.loads(settings.read_text()) == {"apiKeyHelper": "/usr/local/bin/other-identity"}
    # And the lock was released: a later spawn is not stuck.
    assert not app.credential_vault.switch_lock("claude").locked()


@pytest.mark.asyncio
async def test_spawn_refuses_when_the_selected_token_is_corrupt(_wired):
    pc.store("claude", "__default__", TOKEN)
    app.credential_vault.write_app_secret(pc.WRAPPING_KEY_SECRET, None)
    pc.clear_memory()
    session = _session()
    await app.handle_message(session, _create())
    assert session.terminals.created == []  # type: ignore[attr-defined]
    error = session.websocket.sent[-1]  # type: ignore[attr-defined]
    assert error["error"]["code"] == "PORTABLE_CREDENTIAL_UNAVAILABLE"
    assert error["error"]["details"]["reason"] == "corrupt"


@pytest.mark.asyncio
async def test_spawn_follows_the_selection_not_the_native_default_or_the_pin(_wired):
    """Which credential a pane runs on is the portable selection, read under
    the switch lock — neither the native default profile nor a restore's old
    pin picks another account's token, and selecting needs no profile."""
    profile = app.cli_profiles_store.create(agent_key="claude", name="Work")
    app.cli_profiles_store.set_default("claude", profile["id"])
    pc.store("claude", profile["id"], "sk-ant-oat01-work-profile-token-00000")
    pc.store("claude", "__default__", "sk-ant-oat01-default-row-token-000000")
    # Selected explicitly: a slot with no local profile at all.
    pc.store("claude", "a1b2c3d4", TOKEN)
    session = _session()
    message = _create()
    message["payload"]["profile_id"] = "__default__"
    await app.handle_message(session, message)
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN
    # Selecting never touched the native default.
    assert app.cli_profiles_store.get_default_profile("claude")["id"] == profile["id"]


@pytest.mark.asyncio
async def test_imported_named_account_is_selectable_and_launches_without_a_profile(
    _wired, monkeypatch
):
    """Fresh machine B: the only thing it has is what sync pulled. The
    accounts list shows it, portable_enable selects it, the spawn runs on
    it — and no profile, slot directory or provider file came into being."""
    from agent_team_backend import sync_scopes

    monkeypatch.setattr(sync_scopes, "imported_credentials", lambda: [
        {"agentKey": "claude", "slotId": "deadbeef", "available": True,
         "updatedAt": "2026-09-16T01:02:03Z"}], raising=False)
    monkeypatch.setattr(sync_scopes, "imported_credential",
                        lambda a, s: TOKEN if (a, s) == ("claude", "deadbeef") else None,
                        raising=False)
    session = _session()
    reply = await _call(session, "cli_profiles.list", {})
    entry = reply["payload"]["portable_credentials"]["claude/deadbeef"]
    assert entry["source"] == "imported" and entry["configured"] and not entry["enabled"]
    assert TOKEN not in json.dumps(reply)

    reply = await _call(session, "cli_profiles.portable_enable",
                        {"agent_key": "claude", "profile_id": "deadbeef", "enabled": True}, msg_id="m2")
    assert reply["payload"]["portable"]["enabled"] is True
    assert TOKEN not in json.dumps(reply)

    await app.handle_message(session, _create())
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN
    assert app.cli_profiles_store.list()["profiles"] == []
    assert not app.credential_vault.slot_dir("claude", "deadbeef").exists()
    assert TOKEN not in json.dumps(app.database.kv_get(pc.KV_KEY))


@pytest.mark.asyncio
async def test_login_pane_never_gets_the_token(_wired):
    """A login pane exists to sign in to a slot; handing it the pasted token
    would make the CLI skip that sign-in."""
    pc.store("claude", "__default__", TOKEN)
    session = _session()
    message = _create(pane="login-pane")
    message["payload"]["is_login"] = True
    await app.handle_message(session, message)
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in (created["env"] or {})


@pytest.mark.asyncio
async def test_spawn_waits_for_the_switch_lock_before_reading_the_token(_wired):
    pc.store("claude", "__default__", TOKEN)
    session = _session()
    async with app.credential_vault.switch_lock("claude"):
        task = asyncio.create_task(app.handle_message(session, _create()))
        for _ in range(50):
            await asyncio.sleep(0.005)
        assert session.terminals.created == []  # type: ignore[attr-defined]
    await asyncio.wait_for(task, timeout=5)
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN


# ---- attribution and the signed-out advisory --------------------------------

@pytest.mark.asyncio
async def test_bookkeeping_records_the_launch_slot_not_the_current_selection(
    _wired, monkeypatch, tmp_path
):
    """Launch on A, switch the selection to B, then let the bookkeeping
    messages arrive: they must still say A — the pane is running on A's
    token. Both bookkeeping handlers consume the launch fact fixed on the
    terminal at spawn, never the selection current at their own time."""
    from agent_team_backend.projects import ProjectStore

    monkeypatch.setattr(app, "project_store", ProjectStore())
    workspace = tmp_path / "ws"
    profile = app.cli_profiles_store.create(agent_key="claude", name="Work")
    app.cli_profiles_store.set_default("claude", profile["id"])
    pc.store("claude", "aaaa0001", TOKEN)                 # selected: A
    pc.store("claude", "bbbb0002", TOKEN + "b")
    pc.set_enabled("claude", "aaaa0001", True)
    session = _session()
    await app.handle_message(session, _create(cwd=str(workspace)))
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN
    assert created["metadata"][ws_handlers.PORTABLE_SLOT_METADATA_KEY] == "aaaa0001"
    assert TOKEN not in json.dumps(created["metadata"])

    pc.set_enabled("claude", "bbbb0002", True)            # user switches to B
    assert pc.selected_slot("claude") == "bbbb0002"

    await app.handle_message(session, {
        "id": "b1", "type": "manual_pane.spawn",
        "payload": {"workspace_path": str(workspace), "pane_id": "claude-pane",
                    "agent": "claude", "profile_id": "__default__", "command": "claude"},
    })
    reply = session.websocket.sent[-1]  # type: ignore[attr-defined]
    assert reply["ok"], reply
    panes = {p["pane_id"]: p for p in reply["payload"]["project"]["panes"]}
    assert panes["claude-pane"]["profile_id"] == "aaaa0001"

    assert TOKEN not in json.dumps(session.websocket.sent)  # type: ignore[attr-defined]
    # pipeline.slot_spawn goes through the same helper (it needs a pipeline
    # with stages to exercise end to end); the helper agrees, and a pane
    # with no launch fact is native.
    assert ws_handlers._profile_pin_for_bookkeeping("claude", "claude-pane", "__default__") == "aaaa0001"
    assert ws_handlers._profile_pin_for_bookkeeping("claude", "nobody", "__default__") == "__default__"
    assert ws_handlers._profile_pin_for_bookkeeping("claude", "nobody", "") == profile["id"]
    assert ws_handlers._profile_pin_for_bookkeeping("terminal", "claude-pane", "") == ""


@pytest.mark.asyncio
async def test_login_pane_bookkeeping_stays_native(_wired, monkeypatch, tmp_path):
    """A login pane never receives the token, so its launch has no portable
    fact and its record names the native account it signs in to."""
    from agent_team_backend.projects import ProjectStore

    monkeypatch.setattr(app, "project_store", ProjectStore())
    workspace = tmp_path / "ws"
    profile = app.cli_profiles_store.create(agent_key="claude", name="Work")
    app.cli_profiles_store.set_default("claude", profile["id"])
    pc.store("claude", "aaaa0001", TOKEN)
    session = _session()
    message = _create(pane="login-pane", cwd=str(workspace))
    message["payload"]["is_login"] = True
    await app.handle_message(session, message)
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert ws_handlers.PORTABLE_SLOT_METADATA_KEY not in created["metadata"]
    await app.handle_message(session, {
        "id": "b1", "type": "manual_pane.spawn",
        "payload": {"workspace_path": str(workspace), "pane_id": "login-pane",
                    "agent": "claude", "command": "claude"},
    })
    reply = session.websocket.sent[-1]  # type: ignore[attr-defined]
    panes = {p["pane_id"]: p for p in reply["payload"]["project"]["panes"]}
    assert panes["login-pane"]["profile_id"] == profile["id"]


@pytest.mark.asyncio
async def test_spawn_metadata_carries_the_slot_but_never_the_token(_wired, monkeypatch):
    recorded: list[dict] = []

    class Attribution:
        def register_pane(self, pane_id: str, **kwargs: Any) -> None:
            recorded.append({"pane_id": pane_id, **kwargs})

        def scan_pane_baseline(self, pane_id: str) -> None:
            pass

    monkeypatch.setattr(app, "attribution", Attribution())
    pc.store("claude", "a1b2c3d4", TOKEN)
    session = _session()
    message = _create()
    message["payload"]["profile_id"] = "__default__"
    await app.handle_message(session, message)
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN
    assert created["metadata"][ws_handlers.PORTABLE_SLOT_METADATA_KEY] == "a1b2c3d4"
    assert TOKEN not in json.dumps(created["metadata"])
    assert TOKEN not in json.dumps(recorded)


def test_signed_out_advisory_recognises_a_usable_selection(_wired, monkeypatch):
    """No live login at all, but a usable selected token: not signed out."""
    monkeypatch.setattr(app.credential_vault, "identity",
                        lambda agent_key, slot_id=None: {"email": None, "signedIn": False})
    assert app._agent_signed_out("claude") is True
    pc.store("claude", "__default__", TOKEN)
    assert app._agent_signed_out("claude") is False
    pc.set_enabled("claude", "__default__", False)
    assert app._agent_signed_out("claude") is True


def test_signed_out_advisory_ignores_an_unusable_selection(_wired, monkeypatch):
    """Missing or shadowed stays signed out (and the spawn refuses with the
    reason); the selection alone is not a credential."""
    monkeypatch.setattr(app.credential_vault, "identity",
                        lambda agent_key, slot_id=None: {"email": None, "signedIn": False})
    pc.store("claude", "__default__", TOKEN)
    settings = Path.home() / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({"apiKeyHelper": "/bin/other"}))
    assert app._agent_signed_out("claude") is True
    settings.unlink()
    assert app._agent_signed_out("claude") is False
    app.database.kv_set(pc.KV_KEY, {"items": {}, "selected": {"claude": "__default__"}}, now=0)
    assert app._agent_signed_out("claude") is True


@pytest.mark.asyncio
async def test_spawn_with_usable_selection_sends_no_signed_out_event(_wired, monkeypatch):
    monkeypatch.setattr(app.credential_vault, "identity",
                        lambda agent_key, slot_id=None: {"email": None, "signedIn": False})
    session = _session()
    await app.handle_message(session, _create())
    events = [m["type"] for m in session.websocket.sent]  # type: ignore[attr-defined]
    assert "cli.signed_out" in events
    pc.store("claude", "__default__", TOKEN)
    session = _session()
    await app.handle_message(session, _create())
    events = [m["type"] for m in session.websocket.sent]  # type: ignore[attr-defined]
    assert "cli.signed_out" not in events
    assert session.terminals.created[0]["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_bookkeeping_after_a_fast_exit_still_records_the_launch_slot(
    _wired, monkeypatch, tmp_path
):
    """terminal.create acks, the CLI exits at once, the exit path reaps the
    terminal from _PTY_OWNERS and the TerminalService — and only then does
    manual_pane.spawn arrive. The launch fact outlives the terminal."""
    from agent_team_backend.projects import ProjectStore

    monkeypatch.setattr(app, "project_store", ProjectStore())
    workspace = tmp_path / "ws"
    pc.store("claude", "aaaa0001", TOKEN)
    session = _session()
    await app.handle_message(session, _create(cwd=str(workspace)))
    term = session.terminals.created[0]  # type: ignore[attr-defined]
    assert term["metadata"][ws_handlers.PORTABLE_SLOT_METADATA_KEY] == "aaaa0001"
    # Exit cleanup, as terminal.exit does it: owner gone, session gone.
    app._PTY_OWNERS.pop("term-1", None)
    session.terminals.sessions.clear()  # type: ignore[attr-defined]
    pc.set_enabled("claude", "aaaa0001", False)   # and the user moved on

    await app.handle_message(session, {
        "id": "b1", "type": "manual_pane.spawn",
        "payload": {"workspace_path": str(workspace), "pane_id": "claude-pane",
                    "agent": "claude", "command": "claude"},
    })
    reply = session.websocket.sent[-1]  # type: ignore[attr-defined]
    assert reply["ok"], reply
    panes = {p["pane_id"]: p for p in reply["payload"]["project"]["panes"]}
    assert panes["claude-pane"]["profile_id"] == "aaaa0001"


@pytest.mark.asyncio
async def test_native_or_login_relaunch_retires_the_portable_fact(_wired, monkeypatch, tmp_path):
    """Same pane, launched on a token, then relaunched as a login pane (or
    natively after deselecting): the old portable fact must not come back."""
    from agent_team_backend.projects import ProjectStore

    monkeypatch.setattr(app, "project_store", ProjectStore())
    workspace = tmp_path / "ws"
    profile = app.cli_profiles_store.create(agent_key="claude", name="Work")
    app.cli_profiles_store.set_default("claude", profile["id"])
    pc.store("claude", "aaaa0001", TOKEN)
    session = _session()
    await app.handle_message(session, _create(cwd=str(workspace)))
    assert pc.launch_slot("claude-pane") == "aaaa0001"

    relaunch = _create(cwd=str(workspace))
    relaunch["id"] = "c2"
    relaunch["payload"]["is_login"] = True
    await app.handle_message(session, relaunch)
    assert pc.launch_slot("claude-pane") == ""
    await app.handle_message(session, {
        "id": "b1", "type": "manual_pane.spawn",
        "payload": {"workspace_path": str(workspace), "pane_id": "claude-pane",
                    "agent": "claude", "command": "claude"},
    })
    panes = {p["pane_id"]: p for p in session.websocket.sent[-1]["payload"]["project"]["panes"]}  # type: ignore[attr-defined]
    assert panes["claude-pane"]["profile_id"] == profile["id"]

    # Native relaunch after deselecting behaves the same.
    pc.set_enabled("claude", "aaaa0001", True)
    launch = _create(cwd=str(workspace)); launch["id"] = "c3"
    await app.handle_message(session, launch)
    assert pc.launch_slot("claude-pane") == "aaaa0001"
    pc.set_enabled("claude", "aaaa0001", False)
    launch = _create(cwd=str(workspace)); launch["id"] = "c4"
    await app.handle_message(session, launch)
    assert pc.launch_slot("claude-pane") == ""
    # A non-account agent on a pane clears it too.
    pc.note_launch("shell-pane", "aaaa0001")
    await app.handle_message(session, _create(pane="shell-pane", agent="terminal", cwd=str(workspace)))
    assert pc.launch_slot("shell-pane") == ""


@pytest.mark.asyncio
async def test_launch_fact_is_dropped_when_the_pane_is_removed(_wired, monkeypatch, tmp_path):
    from agent_team_backend.projects import ProjectStore

    monkeypatch.setattr(app, "project_store", ProjectStore())
    workspace = tmp_path / "ws"
    pc.store("claude", "aaaa0001", TOKEN)
    session = _session()
    await app.handle_message(session, _create(cwd=str(workspace)))
    assert pc.launch_slot("claude-pane") == "aaaa0001"
    await app.handle_message(session, {
        "id": "u1", "type": "manual_pane.unspawn",
        "payload": {"workspace_path": str(workspace), "pane_id": "claude-pane"},
    })
    assert pc.launch_slot("claude-pane") == ""
    pc.note_launch("claude-pane", "aaaa0001")
    app.forget_pane_activity("claude-pane")
    assert pc.launch_slot("claude-pane") == ""


def test_launch_facts_are_bounded():
    for i in range(pc._LAUNCH_FACTS_MAX + 50):
        pc.note_launch(f"bound-pane-{i}", "slot")
    assert len(pc._launch_facts) == pc._LAUNCH_FACTS_MAX
    assert pc.launch_slot("bound-pane-0") == ""
    assert pc.launch_slot(f"bound-pane-{pc._LAUNCH_FACTS_MAX + 49}") == "slot"
    for i in range(pc._LAUNCH_FACTS_MAX + 50):
        pc.forget_launch(f"bound-pane-{i}")


@pytest.mark.asyncio
async def test_spawn_gives_a_guard_pane_token_to_hooked_vendors_only(_wired):
    """Navide Guard names a not-yet-attributed session's pane by this token;
    it is minted by the backend (a renderer-supplied one is dropped)."""
    from agent_team_backend import guard_hooks

    session = _session()
    message = _create()
    message["payload"]["metadata"]["guard_pane_token"] = "forged"
    await app.handle_message(session, message)
    await app.handle_message(session, _create(pane="shell-pane", agent="terminal"))
    claude, shell = session.terminals.created  # type: ignore[attr-defined]
    token = claude["metadata"]["guard_pane_token"]
    assert token and token != "forged"
    assert claude["env"][guard_hooks.PANE_TOKEN_ENV] == token
    assert "guard_pane_token" not in shell["metadata"]
    assert guard_hooks.PANE_TOKEN_ENV not in (shell["env"] or {})
