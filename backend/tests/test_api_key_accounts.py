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
    assert settings["apiKeyHelper"].endswith(ak.HELPER_FILE)
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
    monkeypatch.setattr(ak.sys, "platform", "win32")
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
    assert quota_failover.QuotaFailoverService._login_state("claude", key) == "auto-switch-off"
    ak.update(key, {"autoSwitch": True})
    assert ak.auto_switch_off(key) is False


def test_a_login_account_is_never_auto_switch_off(store: CliProfilesStore) -> None:
    login = store.create(agent_key="claude", name="Work")["id"]
    assert ak.auto_switch_off(login) is False
    assert ak.auto_switch_off("__default__") is False


def test_logins_come_before_keys(store: CliProfilesStore) -> None:
    key = ak.create("claude", "a", ANTHROPIC_KEY)["id"]
    login = store.create(agent_key="claude", name="Work")["id"]
    rows = [{"slotId": key}, {"slotId": "__default__"}, {"slotId": login}]
    assert [r["slotId"] for r in ak.logins_first(rows)] == ["__default__", login, key]


class _Service:
    def __init__(self, tmp_path: Path) -> None:
        self.stopped: list[str] = []
        self.store = quota_failover.QuotaFailoverStore(Database(tmp_path / "failover.db"))
        self._now = lambda: 1_000_000.0

    def _affected_terminals(self, auth_scope: str) -> list[dict]:
        return [{"paneId": "p1"}, {"paneId": "p2"}]

    def _stop_incident(self, incident: object, reason: str) -> None:
        self.stopped.append(reason)

    def _budget_retry_after(self, agent_key: str, auth_scope: str) -> float:
        used = self.store.automatic_swaps(agent_key, auth_scope, since=self._now() - quota_failover.AUTO_BUDGET_WINDOW_S)
        return 1.0 if len(used) >= quota_failover.AUTO_BUDGET_MAX else 0.0


def _incident(agent: str = "claude", number: int = 1) -> SimpleNamespace:
    return SimpleNamespace(
        id=f"i{number}", agent_key=agent, auth_scope=agent, outgoing_slot_id="__default__", epoch=0,
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
    assert service.stopped == ["audit-write-failed"]
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
    ak.create("claude", "a", ANTHROPIC_KEY)

    assert calls
    assert all(ANTHROPIC_KEY not in " ".join(args) for args, _ in calls)
    assert any(ANTHROPIC_KEY in (stdin or "") for _, stdin in calls)
