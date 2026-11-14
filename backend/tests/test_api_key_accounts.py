"""An API key account is a kind of CLI account, and a login account never
enters any of its code."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import agent_team_backend.app as app
from agent_team_backend import api_key_accounts as ak
from agent_team_backend import quota_failover
from agent_team_backend import ws_handlers
from agent_team_backend.db import Database
from agent_team_backend import quota_failover, usage_service, ws_handlers
from agent_team_backend.credential_vault import CredentialVault, CredentialVaultError, LiveCredentials
from agent_team_backend.profiles_store import CliProfilesStore

# Split so no scanner reads these as real credentials.
ANTHROPIC_KEY = "sk-ant-" + "api03-" + "fakefakefake" + "7F2A"
OPENAI_KEY = "sk-" + "proj-" + "fakefakefake" + "9C1B"
SUBSCRIPTION_TOKEN = "sk-ant-" + "oat01-" + "fakefakefake"


@pytest.fixture
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> CredentialVault:
    v = CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, ""),
        platform="linux",
    )
    monkeypatch.setattr(app, "credential_vault", v)
    monkeypatch.setattr(ak, "_codex_system_config", lambda: tmp_path / "system-config.toml")
    # These tests drive the account logic. Windows refuses Claude keys before
    # that logic runs, and test_windows_refuses_a_claude_key pins the refusal.
    monkeypatch.setattr(ak.osplat, "impl_name", "_linux")
    return v


@pytest.fixture
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, vault: CredentialVault) -> CliProfilesStore:
    s = CliProfilesStore(path=tmp_path / "cli-profiles.json", profiles_root=tmp_path / "root")
    monkeypatch.setattr(app, "cli_profiles_store", s)
    return s


def test_create_keeps_the_key_out_of_the_profile(store: CliProfilesStore, vault: CredentialVault) -> None:
    profile = ak.create("claude", " 專案 ", ANTHROPIC_KEY, 50)

    assert profile["name"] == "專案"
    assert profile["authKind"] == "api-key"
    assert profile["last4"] == "7F2A"
    assert profile["monthlyReminderUsd"] == 50.0
    assert profile["autoSwitch"] is False
    assert ANTHROPIC_KEY not in json.dumps(store.list())
    assert ak.read_secret(profile) == ANTHROPIC_KEY


def test_a_failed_secret_write_leaves_no_account(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*args: object) -> None:
        raise RuntimeError(ANTHROPIC_KEY)

    monkeypatch.setattr(ak.cloud_secrets, "write", boom)
    with pytest.raises(ak.ApiKeyError) as err:
        ak.create("claude", "a", ANTHROPIC_KEY)
    assert err.value.code == "store-failed"
    assert ANTHROPIC_KEY not in err.value.message
    assert store.list()["profiles"] == []


def test_replace_updates_the_suffix(store: CliProfilesStore) -> None:
    profile = ak.create("claude", "a", ANTHROPIC_KEY)
    newer = ANTHROPIC_KEY[:-4] + "ABCD"
    assert ak.replace_secret(profile["id"], newer)["last4"] == "ABCD"
    assert ak.read_secret(profile) == newer


def test_delete_removes_key_and_account(store: CliProfilesStore, vault: CredentialVault) -> None:
    profile = ak.create("claude", "a", ANTHROPIC_KEY)
    ak.delete(profile["id"])
    assert store.list()["profiles"] == []
    assert vault.read_app_secret(ak.SECRET_NAME_PREFIX + profile["id"]) is None


def test_update_refuses_a_login_account(store: CliProfilesStore) -> None:
    login = store.create(agent_key="claude", name="Work")
    with pytest.raises(ak.ApiKeyError) as err:
        ak.update(login["id"], {"name": "x"})
    assert err.value.code == "not-found"
    assert "authKind" not in store.get(login["id"])


def test_auto_switch_is_off_until_turned_on(store: CliProfilesStore) -> None:
    profile = ak.create("claude", "a", ANTHROPIC_KEY)
    assert store.get(profile["id"])["autoSwitch"] is False
    assert ak.update(profile["id"], {"autoSwitch": True})["autoSwitch"] is True
    with pytest.raises(ak.ApiKeyError):
        ak.update(profile["id"], {"autoSwitch": "yes"})


@pytest.mark.parametrize(
    ("secret", "code"),
    [
        (SUBSCRIPTION_TOKEN, "subscription-token"),
        (OPENAI_KEY, "wrong-vendor"),
        ("", "invalid-secret"),
        ("has a space", "invalid-secret"),
        ("x" * (ak.SECRET_MAX_CHARS + 1), "invalid-secret"),
        (None, "invalid-secret"),
    ],
)
def test_refused_secrets_leave_no_account(store: CliProfilesStore, secret: object, code: str) -> None:
    with pytest.raises(ak.ApiKeyError) as err:
        ak.create("claude", "a", secret)
    assert err.value.code == code
    assert store.list()["profiles"] == []


@pytest.mark.parametrize("key", ak.CLAUDE_LOGIN_POLICY_KEYS)
def test_a_forced_login_stops_the_account(
    store: CliProfilesStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, key: str
) -> None:
    policy = tmp_path / "managed-settings.json"
    policy.write_text(json.dumps({key: "x"}), encoding="utf-8")
    monkeypatch.setattr(ak, "MANAGED_CLAUDE_SETTINGS", (policy,))
    with pytest.raises(ak.ApiKeyError) as err:
        ak.create("claude", "a", ANTHROPIC_KEY)
    assert err.value.code == "login-policy"
    assert store.list()["profiles"] == []


def test_a_forced_login_stops_the_takeover(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    ak.update(key, {"autoSwitch": True})
    monkeypatch.setattr(ak, "login_policy_blocks", lambda agent: True)
    assert asyncio.run(ak.take_over(_Service(tmp_path), _incident())) is False
    assert store.get_pane_default("claude") is None


def test_unsupported_agent_is_refused(store: CliProfilesStore) -> None:
    with pytest.raises(ak.ApiKeyError) as err:
        ak.create("kimi", "a", ANTHROPIC_KEY)
    assert err.value.code == "unsupported-agent"


@pytest.mark.parametrize(("status", "expected"), [(200, "ok"), (401, "rejected"), (403, "rejected"), (429, "unknown"), (500, "unknown")])
def test_probe_reads_the_status(status: int, expected: str) -> None:
    async def fetch(url: str, headers: dict[str, str]) -> int:
        return status

    assert asyncio.run(ak.probe("claude", ANTHROPIC_KEY, fetch)) == expected


def test_probe_offline_is_unknown() -> None:
    async def fetch(url: str, headers: dict[str, str]) -> int:
        raise OSError("offline")

    assert asyncio.run(ak.probe("claude", ANTHROPIC_KEY, fetch)) == "unknown"


# ── The API key account can never reach the live login ──────────────────────


def _spy(vault: CredentialVault, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []
    real_capture, real_restore = vault.capture, vault.restore
    monkeypatch.setattr(vault, "capture", lambda *a, **k: (calls.append("capture"), real_capture(*a, **k))[1])
    monkeypatch.setattr(vault, "restore", lambda *a, **k: (calls.append("restore"), real_restore(*a, **k))[1])
    return calls


@pytest.mark.parametrize("direction", ["into", "out-of"])
def test_switch_refuses_before_touching_anything(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch, direction: str
) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    login = store.create(agent_key="claude", name="Work")["id"]
    live = LiveCredentials(secret='{"claudeAiOauth":{"accessToken":"t"}}', account=None)
    vault.write_live("claude", live)
    calls = _spy(vault, monkeypatch)

    with pytest.raises(CredentialVaultError):
        vault.switch("claude", *((login, key) if direction == "into" else (key, login)))

    assert calls == []
    assert vault.read_live("claude").secret == live.secret


def test_set_default_refuses_an_api_key_account(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    calls = _spy(vault, monkeypatch)
    sent: list[dict] = []

    class Session:
        async def send_json(self, frame: dict) -> None:
            sent.append(frame)

    asyncio.run(ws_handlers.cli_profiles_set_default(
        Session(), "m1", "cli_profiles.set_default", {"agent_key": "claude", "profile_id": key}))

    assert "API_KEY_ACCOUNT" in json.dumps(sent)
    assert calls == []
    assert store.list()["defaults"].get("claude") is None


def test_failover_sees_no_login_in_its_slot(store: CliProfilesStore, vault: CredentialVault) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    assert vault.identity("claude", key) == {"email": None, "signedIn": False}
    assert ws_handlers._slot_login_reason("claude", key) == "signed-out"


# ── A pane on an API key account ─────────────────────────────────────────────


def test_a_pane_default_runs_on_the_account_dir(store: CliProfilesStore, vault: CredentialVault) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    store.set_pane_default("claude", key)

    assert vault.account_dir_signed_in(key) is True
    assert ws_handlers._account_dir_for_spawn("claude", "", login=False) == key
    env_set, env_remove = vault.account_dir_spawn_env(key)
    assert set(env_set) == {"CLAUDE_CONFIG_DIR"}
    assert "ANTHROPIC_API_KEY" in env_remove


def test_the_key_stays_out_of_the_pane(store: CliProfilesStore, vault: CredentialVault) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    home = vault._real_home / ".claude"
    home.mkdir(parents=True)
    (home / "settings.json").write_text(json.dumps({"theme": "dark"}), encoding="utf-8")

    directory = vault.prepare_account_dir(key)

    settings_file = directory / "settings.json"
    assert not settings_file.is_symlink()
    settings = json.loads(settings_file.read_text(encoding="utf-8"))
    assert settings["theme"] == "dark"
    assert ak.HELPER_FILE in settings["apiKeyHelper"]
    helper = directory / ak.HELPER_FILE
    assert ANTHROPIC_KEY not in settings_file.read_text(encoding="utf-8")
    assert ANTHROPIC_KEY not in helper.read_text(encoding="utf-8")
    assert json.loads((home / "settings.json").read_text(encoding="utf-8")) == {"theme": "dark"}


@pytest.mark.skipif(sys.platform == "win32", reason="Claude API key accounts are refused on Windows")
def test_the_helper_prints_the_key(store: CliProfilesStore, vault: CredentialVault) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    directory = vault.prepare_account_dir(key)
    output = subprocess.run([str(directory / ak.HELPER_FILE)], capture_output=True, text=True, check=True)
    assert output.stdout == ANTHROPIC_KEY


def test_macos_helper_reads_the_keychain_item(tmp_path: Path) -> None:
    vault = CredentialVault(
        root=tmp_path / "root", real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (0, ""), platform="darwin",
    )
    script = ak._helper_script(vault, "abc")
    assert "find-generic-password" in script
    assert "cli-api-key-abc" in script


def test_windows_refuses_a_claude_key(store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ak.osplat, "impl_name", "_windows")
    with pytest.raises(ak.ApiKeyError) as err:
        ak.create("claude", "a", ANTHROPIC_KEY)
    assert err.value.code == "unsupported-platform"


def test_delete_removes_the_helper(store: CliProfilesStore, vault: CredentialVault) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    directory = vault.prepare_account_dir(key)
    ak.delete(key)
    assert not (directory / ak.HELPER_FILE).exists()


def test_a_login_pane_default_still_follows_the_live_login(store: CliProfilesStore, vault: CredentialVault) -> None:
    login = store.create(agent_key="claude", name="Work")["id"]
    store.set_pane_default("claude", login)
    assert ak.pane_default_slot("claude") == ""
    assert ws_handlers._account_dir_for_spawn("claude", "", login=False) == ""


def test_a_login_account_dir_keeps_the_shared_settings(store: CliProfilesStore, vault: CredentialVault) -> None:
    login = store.create(agent_key="claude", name="Work")["id"]
    home = vault._real_home / ".claude"
    home.mkdir(parents=True)
    (home / "settings.json").write_text("{}", encoding="utf-8")
    directory = vault.prepare_account_dir(login)
    assert (directory / "settings.json").is_symlink()
    assert not (directory / ak.HELPER_FILE).exists()


# ── Quota failover ───────────────────────────────────────────────────────────


def test_an_account_stays_out_of_failover_until_opened(store: CliProfilesStore) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    assert quota_failover.QuotaFailoverService._login_state("claude", key) == "api-key-auto-off"
    ak.update(key, {"autoSwitch": True})
    assert ak.held_from_auto_switch(key) is False


def test_a_login_account_is_never_auto_switch_off(store: CliProfilesStore) -> None:
    login = store.create(agent_key="claude", name="Work")["id"]
    assert ak.held_from_auto_switch(login) is False
    assert ak.held_from_auto_switch("__default__") is False


def test_logins_come_before_keys(store: CliProfilesStore) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    login = store.create(agent_key="claude", name="Work")["id"]
    rows = [{"slotId": key}, {"slotId": "__default__"}, {"slotId": login}]
    assert [r["slotId"] for r in ak.logins_first(rows)] == ["__default__", login, key]


class _Service:
    def __init__(self, tmp_path: Path, panes: list[dict] | None = None) -> None:
        self.stopped: list[str] = []
        self.store = quota_failover.QuotaFailoverStore(Database(tmp_path / "failover.db"))
        self._now = lambda: 1_000_000.0
        self.audit_degraded: str | None = None
        self.panes = panes if panes is not None else [
            {"paneId": "p1", "credentialSource": "vault"}, {"paneId": "p2", "credentialSource": "vault"},
        ]
        self.ranked: list[dict] = []
        self.vetoed: set[str] = set()

    async def candidates(self, agent_key: str) -> list[dict]:
        return self.ranked

    def _ledger_vetoes(self, agent_key: str, slot_ids: list[str]) -> set[str]:
        return self.vetoed & set(slot_ids)

    def _current_slot(self, agent_key: str) -> str:
        return str(app.cli_profiles_store.list()["defaults"].get(agent_key) or "__default__")

    def _affected_terminals(self, auth_scope: str) -> list[dict]:
        return self.panes

    def _stop_incident(self, incident: object, reason: str) -> None:
        self.stopped.append(reason)

    def _budget_retry_after(self, agent_key: str, auth_scope: str) -> float:
        used = self.store.automatic_swaps(agent_key, auth_scope, since=self._now() - quota_failover.AUTO_BUDGET_WINDOW_S)
        return 1.0 if len(used) >= quota_failover.AUTO_BUDGET_MAX else 0.0


def _incident(agent: str = "claude", number: int = 1, outgoing: str = "__default__") -> SimpleNamespace:
    return SimpleNamespace(
        id=f"i{number}", agent_key=agent, auth_scope=agent, outgoing_slot_id=outgoing, epoch=0,
    )


def _capture_events(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    events: list[dict] = []

    async def record(event: dict, **_: object) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", record)
    monkeypatch.setattr(app, "broadcast_main_windows", record)
    return events


def test_take_over_moves_panes_and_leaves_the_live_login(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    ak.update(key, {"autoSwitch": True})
    live = LiveCredentials(secret='{"claudeAiOauth":{"accessToken":"t"}}', account=None)
    vault.write_live("claude", live)
    calls = _spy(vault, monkeypatch)
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path)

    assert asyncio.run(ak.take_over(service, _incident())) is True

    assert store.get_pane_default("claude") == key
    assert service.stopped == ["api-key-takeover"]
    takeover = next(e for e in events if e["type"] == ak.TAKEOVER_EVENT)
    assert takeover["payload"]["paneIds"] == ["p1", "p2"]
    assert ANTHROPIC_KEY not in json.dumps(events)
    assert calls == []
    assert vault.read_live("claude").secret == live.secret


def test_take_over_survives_a_failed_accounts_refresh(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    key = _opened_key(store)
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path)

    async def broken(reason: str) -> None:
        raise RuntimeError("no account view")

    monkeypatch.setattr(ws_handlers, "_broadcast_profiles_changed", broken)
    assert asyncio.run(ak.take_over(service, _incident())) is True
    assert service.stopped == ["api-key-takeover"]
    assert store.get_pane_default("claude") == key
    assert any(e["type"] == ak.TAKEOVER_EVENT for e in events)


def test_take_over_counts_against_the_budget(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    ak.update(key, {"autoSwitch": True})
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path)

    for number in range(quota_failover.AUTO_BUDGET_MAX):
        assert asyncio.run(ak.take_over(service, _incident(number=number))) is True
    assert len(service.store.automatic_swaps("claude", "claude", since=0.0)) == quota_failover.AUTO_BUDGET_MAX
    moved = [e for e in events if e["type"] == ak.TAKEOVER_EVENT]

    store.set_pane_default("claude", None)
    assert asyncio.run(ak.take_over(service, _incident(number=99))) is True

    assert service.stopped[-1] == "auto_budget_exhausted"
    assert len([e for e in events if e["type"] == ak.TAKEOVER_EVENT]) == len(moved)
    assert store.get_pane_default("claude") is None


def test_a_move_that_cannot_be_counted_is_not_made(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    ak.update(key, {"autoSwitch": True})
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path)

    def broken(*args: object, **kwargs: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(service.store, "record", broken)
    assert asyncio.run(ak.take_over(service, _incident())) is True
    assert service.stopped == ["api-key-takeover-unrecorded"]
    assert events == []
    assert store.get_pane_default("claude") is None


def test_take_over_needs_the_account_opened(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ak.create("claude", "a", ANTHROPIC_KEY)
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path)
    assert asyncio.run(ak.take_over(service, _incident())) is False
    assert events == [] and service.stopped == []


def test_take_over_is_claude_only(store: CliProfilesStore, tmp_path: Path) -> None:
    assert asyncio.run(ak.take_over(_Service(tmp_path), _incident("codex"))) is False


# ── A login account runs exactly as before ──────────────────────────────────


def test_login_switch_keeps_its_order(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch
) -> None:
    a = store.create(agent_key="claude", name="A")["id"]
    b = store.create(agent_key="claude", name="B")["id"]
    secret_a = '{"claudeAiOauth":{"accessToken":"a"}}'
    secret_b = '{"claudeAiOauth":{"accessToken":"b"}}'
    vault.write_slot("claude", b, LiveCredentials(secret=secret_b, account=None))
    vault.write_live("claude", LiveCredentials(secret=secret_a, account=None))
    calls = _spy(vault, monkeypatch)

    vault.switch("claude", a, b)

    assert calls == ["capture", "restore"]
    assert vault.read_live("claude").secret == secret_b
    assert vault.read_slot("claude", a).secret == secret_a


def test_a_login_profile_has_no_kind_and_no_marker(store: CliProfilesStore, vault: CredentialVault) -> None:
    login = store.create(agent_key="claude", name="Work")
    assert set(login) == {"id", "agentKey", "name", "createdAt"}
    assert not ak.is_api_key(login)
    assert vault.is_api_key_slot("claude", login["id"]) is False
    assert vault.is_api_key_slot("claude", None) is False
    assert vault.is_api_key_slot("codex", login["id"]) is False


# ── Codex: the key lives in the slot and takes the existing switch ───────────


def _slot_doc(vault: CredentialVault, slot_id: str) -> dict | None:
    secret = vault.read_slot("codex", slot_id).secret
    return None if secret is None else json.loads(secret)


def _login_auth(token: str) -> str:
    return json.dumps({"auth_mode": "chatgpt", "tokens": {"access_token": token}})


def test_codex_key_is_the_auth_json_codex_writes(store: CliProfilesStore, vault: CredentialVault) -> None:
    profile = ak.create("codex", "專案", OPENAI_KEY, 20)

    assert _slot_doc(vault, profile["id"]) == {"auth_mode": "apikey", "OPENAI_API_KEY": OPENAI_KEY}
    assert profile["last4"] == "9C1B"
    assert OPENAI_KEY not in json.dumps(store.list())
    assert ak.read_secret(profile) == OPENAI_KEY
    assert vault.read_app_secret(ak.SECRET_NAME_PREFIX + profile["id"]) is None
    assert vault.identity("codex", profile["id"]) == {"email": None, "signedIn": True}
    assert not vault._api_key_slot_marker("codex", profile["id"]).exists()


def test_codex_failed_slot_write_leaves_no_account(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError(OPENAI_KEY)

    monkeypatch.setattr(vault, "write_slot", boom)
    with pytest.raises(ak.ApiKeyError) as err:
        ak.create("codex", "a", OPENAI_KEY)
    assert err.value.code == "store-failed"
    assert OPENAI_KEY not in err.value.message
    assert store.list()["profiles"] == []


def test_codex_anthropic_key_is_refused(store: CliProfilesStore) -> None:
    with pytest.raises(ak.ApiKeyError) as err:
        ak.create("codex", "a", ANTHROPIC_KEY)
    assert err.value.code == "wrong-vendor"
    assert store.list()["profiles"] == []


def test_codex_switch_captures_then_restores_both_ways(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch
) -> None:
    login = store.create(agent_key="codex", name="Login")["id"]
    key = ak.create("codex", "Key", OPENAI_KEY)["id"]
    login_auth = _login_auth("fake-login-token")
    vault.write_live("codex", LiveCredentials(secret=login_auth))
    calls = _spy(vault, monkeypatch)

    vault.switch("codex", login, key)

    assert calls == ["capture", "restore"]
    assert json.loads(vault.read_live("codex").secret)["OPENAI_API_KEY"] == OPENAI_KEY
    assert vault.read_slot("codex", login).secret == login_auth

    vault.switch("codex", key, login)

    assert calls == ["capture", "restore"] * 2
    assert vault.read_live("codex").secret == login_auth
    assert _slot_doc(vault, key)["OPENAI_API_KEY"] == OPENAI_KEY


def test_codex_replace_and_delete_go_through_the_slot(store: CliProfilesStore, vault: CredentialVault) -> None:
    profile = ak.create("codex", "a", OPENAI_KEY)
    fresh = "sk-" + "proj-" + "otherfakeother" + "D4E5"

    assert ak.replace_secret(profile["id"], fresh)["last4"] == "D4E5"
    assert _slot_doc(vault, profile["id"])["OPENAI_API_KEY"] == fresh

    auth_file = vault.slot_dir("codex", profile["id"]) / "auth.json"
    assert auth_file.exists()
    ak.delete(profile["id"])
    assert store.list()["profiles"] == []
    assert not auth_file.exists()


def test_codex_active_key_is_neither_replaced_nor_deleted(store: CliProfilesStore, vault: CredentialVault) -> None:
    profile = ak.create("codex", "a", OPENAI_KEY)
    store.set_default("codex", profile["id"])

    for change in (lambda: ak.replace_secret(profile["id"], OPENAI_KEY), lambda: ak.delete(profile["id"])):
        with pytest.raises(ak.ApiKeyError) as err:
            change()
        assert err.value.code == "account-active"
    assert _slot_doc(vault, profile["id"])["OPENAI_API_KEY"] == OPENAI_KEY
    assert store.get(profile["id"]) is not None


def test_codex_a_slot_without_the_key_says_so(store: CliProfilesStore, vault: CredentialVault) -> None:
    profile = ak.create("codex", "a", OPENAI_KEY)
    vault.write_slot("codex", profile["id"], LiveCredentials(secret=_login_auth("fake-login-token")))

    with pytest.raises(ak.ApiKeyError) as err:
        ak.read_secret(profile)
    assert err.value.code == "secret-missing"


def _user_config(vault: CredentialVault) -> Path:
    path = vault._live_file("codex").with_name("config.toml")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


@pytest.mark.parametrize("layer", ["user", "system"])
@pytest.mark.parametrize(
    "text", ['forced_login_method = "chatgpt"\n', 'forced_login_method = "api"\n', "not toml ["],
)
def test_codex_login_policy_stops_the_new_account(
    store: CliProfilesStore, vault: CredentialVault, tmp_path: Path, layer: str, text: str
) -> None:
    config = _user_config(vault) if layer == "user" else tmp_path / "system-config.toml"
    config.write_text(text, encoding="utf-8")

    with pytest.raises(ak.ApiKeyError) as err:
        ak.create("codex", "a", OPENAI_KEY)

    assert err.value.code == "login-policy"
    assert store.list()["profiles"] == []


def test_codex_system_config_location(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ProgramData", raising=False)
    assert ak._codex_system_config() == Path("/etc/codex/config.toml")
    monkeypatch.setenv("ProgramData", "D:\\Data")
    assert ak._codex_system_config() == Path("D:\\Data", "OpenAI", "Codex", "config.toml")


def test_codex_config_without_a_login_policy_adds_the_account(store: CliProfilesStore, vault: CredentialVault) -> None:
    _user_config(vault).write_text('model = "x"\n[profiles.a]\nmodel = "y"\n', encoding="utf-8")

    assert ak.create("codex", "a", OPENAI_KEY)["authKind"] == "api-key"


def test_codex_login_policy_leaves_claude_alone(store: CliProfilesStore, vault: CredentialVault) -> None:
    _user_config(vault).write_text('forced_login_method = "chatgpt"\n', encoding="utf-8")

    assert ak.create("claude", "a", ANTHROPIC_KEY)["authKind"] == "api-key"


# ── Quota: a key is not probed, and failover needs the opt-in ────────────────


def _poll_codex(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[Path]:
    """One poll cycle with codex as the only vendor; the homes it read."""
    read: list[Path] = []

    async def fetch(home: Path) -> dict:
        read.append(home)
        return usage_service._snapshot("codex", "ok")

    async def fetch_claude(home: Path) -> dict:
        return usage_service._snapshot("claude", "no-credentials")

    async def nothing(*args: object) -> None:
        return None

    spec = SimpleNamespace(fetch_usage=fetch, fetch_usage_from_context=None)
    monkeypatch.setattr(usage_service, "_CLI_VENDORS", {"codex": spec})
    monkeypatch.setattr(usage_service, "fetch_claude", fetch_claude)
    service = usage_service.UsageService()
    monkeypatch.setattr(service, "_harvest_active_slots", nothing)
    monkeypatch.setattr(service, "_claude_credentials_by_slot", nothing)
    monkeypatch.setattr(service, "_file_quota_samples", nothing)
    asyncio.run(service.poll_once(tmp_path))
    return read


def test_active_codex_key_is_not_probed(
    store: CliProfilesStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store.set_default("codex", ak.create("codex", "a", OPENAI_KEY)["id"])

    assert _poll_codex(monkeypatch, tmp_path) == []


def test_codex_login_is_still_probed_beside_a_parked_key(
    store: CliProfilesStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ak.create("codex", "a", OPENAI_KEY)
    store.set_default("codex", store.create(agent_key="codex", name="Login")["id"])

    assert _poll_codex(monkeypatch, tmp_path) == [tmp_path]


def test_failover_leaves_a_key_alone_until_opted_in(store: CliProfilesStore, vault: CredentialVault) -> None:
    key = ak.create("codex", "a", OPENAI_KEY)["id"]
    state = quota_failover.QuotaFailoverService._login_state

    assert state("codex", key) == "api-key-auto-off"
    ak.update(key, {"autoSwitch": True})
    assert state("codex", key) == "ok"


def test_failover_reads_a_login_as_before(store: CliProfilesStore, vault: CredentialVault) -> None:
    login = store.create(agent_key="codex", name="Login")["id"]
    state = quota_failover.QuotaFailoverService._login_state

    assert state("codex", login) == "signed-out"
    vault.write_slot("codex", login, LiveCredentials(secret=_login_auth("fake-login-token")))
    assert state("codex", login) == "ok"


# ── Messages ─────────────────────────────────────────────────────────────────


class FakeSession:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, frame: dict) -> None:
        self.sent.append(frame)


def _call(monkeypatch: pytest.MonkeyPatch, msg_type: str, payload: dict, main_window: bool = True) -> tuple[dict, list[dict]]:
    events: list[dict] = []

    async def broadcast(event: dict, **_: object) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", broadcast)
    monkeypatch.setattr(app, "is_main_window", lambda session: main_window)
    session = FakeSession()
    asyncio.run(ak.MESSAGE_HANDLERS[msg_type](session, "m1", msg_type, payload))
    return session.sent[0], events


def test_no_message_carries_the_key(store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch) -> None:
    created, events = _call(monkeypatch, "cli_profiles.api_key_create", {"agentKey": "claude", "name": "a", "secret": ANTHROPIC_KEY})
    profile_id = created["payload"]["profile"]["id"]
    updated, more = _call(monkeypatch, "cli_profiles.api_key_update", {"id": profile_id, "name": "b"})

    assert updated["payload"]["profile"]["name"] == "b"
    assert events and more
    for frame in (created, updated, *events, *more):
        assert ANTHROPIC_KEY not in json.dumps(frame)


def test_error_answer_does_not_echo_the_paste(store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch) -> None:
    answer, events = _call(monkeypatch, "cli_profiles.api_key_create", {"agentKey": "claude", "name": "a", "secret": OPENAI_KEY})
    assert answer["payload"]["error_code"] == "wrong-vendor"
    assert OPENAI_KEY not in json.dumps(answer)
    assert events == []


def test_plugin_windows_are_refused(store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch) -> None:
    answer, _ = _call(monkeypatch, "cli_profiles.api_key_update", {"id": "x"}, main_window=False)
    assert answer["payload"]["error_code"] == "main-window-only"


def test_test_message_probes_a_stored_key(store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch) -> None:
    profile = ak.create("claude", "a", ANTHROPIC_KEY)
    seen: list[tuple[str, str]] = []

    async def fake_probe(agent: str, secret: str) -> str:
        seen.append((agent, secret))
        return "ok"

    monkeypatch.setattr(ak, "probe", fake_probe)
    answer, _ = _call(monkeypatch, "cli_profiles.api_key_test", {"id": profile["id"]})
    assert answer["payload"] == {"ok": True, "result": "ok"}
    assert seen == [("claude", ANTHROPIC_KEY)]


def test_codex_messages_refuse_the_active_key_under_the_switch_lock(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile = ak.create("codex", "a", OPENAI_KEY)
    store.set_default("codex", profile["id"])

    frame, _ = _call(monkeypatch, "cli_profiles.api_key_delete", {"id": profile["id"]})

    assert frame["payload"]["error_code"] == "account-active"
    assert not vault.switch_lock("codex").locked()
    assert OPENAI_KEY not in json.dumps(frame)


def test_codex_messages_delete_a_parked_key(store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch) -> None:
    profile = ak.create("codex", "a", OPENAI_KEY)

    frame, _ = _call(monkeypatch, "cli_profiles.api_key_delete", {"id": profile["id"]})

    assert frame["payload"]["ok"] is True
    assert store.list()["profiles"] == []


def test_handlers_are_registered() -> None:
    assert set(ak.MESSAGE_HANDLERS) <= set(ws_handlers._REGISTRY)


def test_macos_key_stays_out_of_argv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[list[str], str | None]] = []

    def security(args: list[str], input_text: str | None = None) -> tuple[int, str]:
        calls.append((args, input_text))
        return 0, ""

    vault = CredentialVault(root=tmp_path / "root", real_home=tmp_path / "home", security_runner=security, platform="darwin")
    monkeypatch.setattr(app, "credential_vault", vault)
    store = CliProfilesStore(path=tmp_path / "cli-profiles.json", profiles_root=tmp_path / "root")
    monkeypatch.setattr(app, "cli_profiles_store", store)
    monkeypatch.setattr(ak.osplat, "impl_name", "_darwin")
    ak.create("claude", "a", ANTHROPIC_KEY)

    assert calls
    assert all(ANTHROPIC_KEY not in " ".join(args) for args, _ in calls)
    assert any(ANTHROPIC_KEY in (stdin or "") for _, stdin in calls)


# ── Agents ──────────────────────────────────────────────────────────────────


def test_an_agent_cannot_open_a_pane_on_a_key(store: CliProfilesStore) -> None:
    from agent_team_backend.mcp_server import open_agent_account

    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    refusal = open_agent_account.resolve("claude", key, "", "")
    assert refusal["error_code"] == "unsupported"
    assert ANTHROPIC_KEY not in json.dumps(refusal)


def test_cli_accounts_list_names_the_kind_only_for_a_key() -> None:
    from agent_team_backend.mcp_server import server

    login = server._pick({"id": "a", "agentKey": "claude", "name": "Work"}, server._ACCOUNT_FIELDS)
    key = server._pick(
        {"id": "b", "agentKey": "claude", "name": "Key", "authKind": "api-key", "last4": "7F2A"},
        server._ACCOUNT_FIELDS,
    )
    assert "authKind" not in login
    assert key["authKind"] == "api-key"
    assert "last4" not in key


def test_an_agent_cannot_switch_to_a_key(store: CliProfilesStore) -> None:
    from agent_team_backend import agent_messaging
    from agent_team_backend.mcp_server import server, wiring

    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    agent_messaging._reset_for_test()
    agent_messaging.register("pa", "caller", "ws", agent_key="claude")
    params = {"pane": "pa", "t": wiring.caller_token("pa")}
    ctx = SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))

    answer = asyncio.run(server.cli_account_switch(ctx, agent="claude", profile_id=key, reason="out of quota"))

    assert answer["error_code"] == "api-key-account"
    agent_messaging._reset_for_test()


# ── Review n14 ───────────────────────────────────────────────────────────────


def test_the_generic_delete_refuses_a_key(store: CliProfilesStore, vault: CredentialVault) -> None:
    """S1: it archives the slot, which would leave the key behind in a .deleted dir."""
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    sent: list[dict] = []

    class Session:
        async def send_json(self, frame: dict) -> None:
            sent.append(frame)

    asyncio.run(ws_handlers.cli_profiles_delete(Session(), "m1", "cli_profiles.delete", {"id": key}))

    assert "API_KEY_ACCOUNT" in json.dumps(sent)
    assert store.get(key) is not None
    assert ak.read_secret(store.get(key)) == ANTHROPIC_KEY


def test_a_key_left_live_after_a_failed_switch_is_not_probed(
    store: CliProfilesStore, vault: CredentialVault
) -> None:
    """S6: live holds the key while the default still names a login."""
    profile = ak.create("codex", "a", OPENAI_KEY)
    vault.write_live("codex", vault.read_slot("codex", profile["id"]))
    assert ak.is_active_api_key_account("codex", store) is True


def test_a_key_from_outside_navide_is_left_as_it_was(store: CliProfilesStore, vault: CredentialVault) -> None:
    """Not one of our accounts: main's behaviour stands."""
    ak.create("codex", "a", OPENAI_KEY)
    other = OPENAI_KEY[:-4] + "ZZZZ"
    vault.write_live("codex", LiveCredentials(secret=json.dumps({"auth_mode": "apikey", "OPENAI_API_KEY": other})))
    assert ak.is_active_api_key_account("codex", store) is False


def test_no_key_accounts_means_no_new_read(store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch) -> None:
    def untouched(*args: object, **kwargs: object) -> None:
        raise AssertionError("read live")

    monkeypatch.setattr(vault, "read_live", untouched)
    assert ak.is_active_api_key_account("codex", store) is False


def test_the_poll_never_boots_claude_on_a_key(store: CliProfilesStore, vault: CredentialVault) -> None:
    """B1: reading /usage there starts a whole Claude Code and calls the helper."""
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    vault.prepare_account_dir(key)
    service = usage_service.UsageService()
    assert asyncio.run(service._claude_account_dirs([key])) == []


def _running_pane(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ws_handlers, "_running_account_dir_terminals", lambda slot: ["t1"])


def test_delete_refuses_while_a_pane_runs_on_the_key(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """S2: the helper is removed and that pane's next request fails."""
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    _running_pane(monkeypatch)
    with pytest.raises(ak.ApiKeyError) as err:
        ak.delete(key)
    assert err.value.code == "account-in-use"
    assert store.get(key) is not None
    assert ak.read_secret(store.get(key)) == ANTHROPIC_KEY


def _opened_key(store: CliProfilesStore) -> str:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    ak.update(key, {"autoSwitch": True})
    return key


def test_a_pinned_account_running_out_spends_nothing(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """B2: the live login still has quota, so no money moves."""
    _opened_key(store)
    work = store.create(agent_key="claude", name="Work")["id"]
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path)

    assert asyncio.run(ak.take_over(service, _incident(outgoing=work))) is False

    assert events == []
    assert store.get_pane_default("claude") is None
    assert service.store.automatic_swaps("claude", "claude", since=0.0) == []


def test_take_over_moves_only_panes_on_the_live_login(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """B2: a pane on a pinned account or already on a key stays where it is."""
    _opened_key(store)
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path, panes=[
        {"paneId": "live", "credentialSource": "vault"},
        {"paneId": "pinned", "credentialSource": "account-dir"},
        {"paneId": "env", "credentialSource": "env-override"},
    ])

    assert asyncio.run(ak.take_over(service, _incident())) is True

    takeover = next(e for e in events if e["type"] == ak.TAKEOVER_EVENT)
    assert takeover["payload"]["paneIds"] == ["live"]


# ── A subscription account signed in only in its own folder ──────────────────


def _folder_login(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch, name: str = "Work",
) -> str:
    login = store.create(agent_key="claude", name=name)["id"]
    signed_in = vault.account_dir_signed_in
    monkeypatch.setattr(vault, "account_dir_signed_in", lambda slot: slot == login or signed_in(slot))
    return login


def _row(slot: str, tier: str = "fresh-headroom", excluded: str | None = "signed-out", headroom: float = 40.0) -> dict:
    return {"slotId": slot, "tier": tier, "excluded": excluded, "headroom": headroom}


def test_a_folder_login_with_quota_comes_before_the_key(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _opened_key(store)
    login = _folder_login(store, vault, monkeypatch)
    live = LiveCredentials(secret='{"claudeAiOauth":{"accessToken":"t"}}', account=None)
    vault.write_live("claude", live)
    calls = _spy(vault, monkeypatch)
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path)
    service.ranked = [_row(login)]

    assert asyncio.run(ak.take_over(service, _incident())) is True

    assert service.stopped == ["folder-login-takeover"]
    assert store.get_pane_default("claude") == login
    takeover = next(e for e in events if e["type"] == ak.TAKEOVER_EVENT)["payload"]
    assert takeover["profileId"] == login
    assert takeover["paid"] is False
    assert takeover["paneIds"] == ["p1", "p2"]
    assert len(service.store.automatic_swaps("claude", "claude", since=0.0)) == 1
    # Its slot is empty: a swap would sign the live login out. The pane runs on
    # the folder instead, reached by the pin the reopen carries.
    assert calls == []
    assert vault.read_live("claude").secret == live.secret
    assert ws_handlers._account_dir_for_spawn("claude", login, login=False) == login
    env_set, _ = vault.account_dir_spawn_env(login)
    assert env_set == {"CLAUDE_CONFIG_DIR": str(vault.account_dir_path(login))}


def test_the_move_to_a_key_says_it_is_paid(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _opened_key(store)
    events = _capture_events(monkeypatch)
    assert asyncio.run(ak.take_over(_Service(tmp_path), _incident())) is True
    assert next(e for e in events if e["type"] == ak.TAKEOVER_EVENT)["payload"]["paid"] is True


def test_the_folder_login_with_the_most_quota_wins(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _opened_key(store)
    low = _folder_login(store, vault, monkeypatch, "Low")
    high = _folder_login(store, vault, monkeypatch, "High")
    _capture_events(monkeypatch)
    service = _Service(tmp_path)
    service.ranked = [_row(low, headroom=10.0), _row(high, headroom=70.0)]
    assert asyncio.run(ak.take_over(service, _incident())) is True
    assert store.get_pane_default("claude") == high


@pytest.mark.parametrize("tier", ["stale-headroom", "reset-expected", "unknown"])
def test_quota_that_is_not_confirmed_leaves_the_key(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, tier: str,
) -> None:
    key = _opened_key(store)
    login = _folder_login(store, vault, monkeypatch)
    _capture_events(monkeypatch)
    service = _Service(tmp_path)
    service.ranked = [_row(login, tier=tier)]
    assert asyncio.run(ak.take_over(service, _incident())) is True
    assert service.stopped == ["api-key-takeover"]
    assert store.get_pane_default("claude") == key


@pytest.mark.parametrize("excluded", ["tried", "expired", "login-pending", "exhausted", "current"])
def test_a_row_refused_for_another_reason_leaves_the_key(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, excluded: str,
) -> None:
    key = _opened_key(store)
    login = _folder_login(store, vault, monkeypatch)
    _capture_events(monkeypatch)
    service = _Service(tmp_path)
    service.ranked = [_row(login, excluded=excluded)]
    assert asyncio.run(ak.take_over(service, _incident())) is True
    assert store.get_pane_default("claude") == key


def test_a_login_with_no_folder_sign_in_leaves_the_key(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    key = _opened_key(store)
    login = store.create(agent_key="claude", name="Work")["id"]
    _capture_events(monkeypatch)
    service = _Service(tmp_path)
    service.ranked = [_row(login)]
    assert asyncio.run(ak.take_over(service, _incident())) is True
    assert store.get_pane_default("claude") == key


def test_a_ledger_that_says_spent_leaves_the_key(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    key = _opened_key(store)
    login = _folder_login(store, vault, monkeypatch)
    _capture_events(monkeypatch)
    service = _Service(tmp_path)
    service.ranked = [_row(login)]
    service.vetoed = {login}
    assert asyncio.run(ak.take_over(service, _incident())) is True
    assert store.get_pane_default("claude") == key


def test_the_account_that_ran_out_is_not_its_own_rescue(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    key = _opened_key(store)
    login = _folder_login(store, vault, monkeypatch)
    store.set_default("claude", login)
    _capture_events(monkeypatch)
    service = _Service(tmp_path)
    service.ranked = [_row(login)]
    assert asyncio.run(ak.take_over(service, _incident(outgoing=login))) is True
    assert store.get_pane_default("claude") == key


def test_a_key_row_is_never_taken_for_a_folder_login(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    first = _opened_key(store)
    other = ak.create("claude", "b", ANTHROPIC_KEY)["id"]
    _capture_events(monkeypatch)
    service = _Service(tmp_path)
    service.ranked = [_row(other)]
    assert asyncio.run(ak.take_over(service, _incident())) is True
    assert store.get_pane_default("claude") == first


def test_with_no_key_opened_a_folder_login_changes_nothing(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    login = _folder_login(store, vault, monkeypatch)
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path)
    service.ranked = [_row(login)]
    assert asyncio.run(ak.take_over(service, _incident())) is False
    assert service.stopped == []
    assert store.get_pane_default("claude") is None
    assert events == []


def test_a_failed_candidate_read_leaves_the_key(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    key = _opened_key(store)
    _capture_events(monkeypatch)
    service = _Service(tmp_path)

    async def broken(agent_key: str) -> list[dict]:
        raise RuntimeError("keychain")

    monkeypatch.setattr(service, "candidates", broken)
    assert asyncio.run(ak.take_over(service, _incident())) is True
    assert store.get_pane_default("claude") == key


def test_a_folder_move_that_cannot_be_recorded_is_not_made(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _opened_key(store)
    login = _folder_login(store, vault, monkeypatch)
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path)
    service.ranked = [_row(login)]

    def broken(*_: object, **__: object) -> None:
        raise RuntimeError("disk")

    monkeypatch.setattr(service.store, "record", broken)
    assert asyncio.run(ak.take_over(service, _incident())) is True
    assert service.stopped == ["folder-login-takeover-unrecorded"]
    assert store.get_pane_default("claude") is None
    assert events == []


def test_a_folder_move_that_fails_says_so_as_a_folder_move(
    store: CliProfilesStore, vault: CredentialVault, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _opened_key(store)
    login = _folder_login(store, vault, monkeypatch)
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path)
    service.ranked = [_row(login)]

    def broken(auth_scope: str) -> list[dict]:
        raise RuntimeError("window gone")

    monkeypatch.setattr(service, "_affected_terminals", broken)
    assert asyncio.run(ak.take_over(service, _incident())) is True
    assert service.stopped == ["folder-login-takeover-failed"]
    assert store.get_pane_default("claude") is None
    assert events == []


def test_take_over_never_targets_the_account_that_ran_out(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """B2: a key that reported the incident is not its own way out."""
    key = _opened_key(store)
    store.set_default("claude", None)
    monkeypatch.setattr(store, "list", lambda real=store.list: {**real(), "defaults": {"claude": key}})
    events = _capture_events(monkeypatch)

    assert asyncio.run(ak.take_over(_Service(tmp_path), _incident(outgoing=key))) is False
    assert events == []


def test_take_over_stops_while_the_audit_is_paused(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """S3(b): begin_switch refuses here, so this path must too."""
    _opened_key(store)
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path)
    service.audit_degraded = "disk full"

    assert asyncio.run(ak.take_over(service, _incident())) is True

    assert service.stopped == ["api-key-takeover-paused"]
    assert events == []
    assert store.get_pane_default("claude") is None


def test_a_failed_default_write_stops_cleanly(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """S3(a): the error must end the incident, not escape from report()."""
    _opened_key(store)
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path)

    def broken(*args: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(store, "set_pane_default", broken)
    assert asyncio.run(ak.take_over(service, _incident())) is True
    assert service.stopped == ["api-key-takeover-failed"]
    assert events == []


def test_an_agent_cannot_start_a_sign_in_on_a_key(store: CliProfilesStore) -> None:
    """S5: a login over the slot would replace the key and leave authKind behind."""
    from agent_team_backend import agent_messaging
    from agent_team_backend.mcp_server import server, wiring

    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    agent_messaging._reset_for_test()
    agent_messaging.register("pa", "caller", "ws", agent_key="claude")
    params = {"pane": "pa", "t": wiring.caller_token("pa")}
    ctx = SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))

    answer = asyncio.run(server.cli_account_sign_in(ctx, agent="claude", profile_id=key, reason="sign in"))

    assert answer["error_code"] == "api-key-account"
    agent_messaging._reset_for_test()


def test_a_failed_pane_lookup_changes_nothing(
    store: CliProfilesStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """S3: the error must end the incident, with the default left as it was."""
    _opened_key(store)
    events = _capture_events(monkeypatch)
    service = _Service(tmp_path)

    def broken(auth_scope: str) -> list[dict]:
        raise RuntimeError("window gone")

    monkeypatch.setattr(service, "_affected_terminals", broken)
    assert asyncio.run(ak.take_over(service, _incident())) is True
    assert service.stopped == ["api-key-takeover-failed"]
    assert store.get_pane_default("claude") is None
    assert events == []
