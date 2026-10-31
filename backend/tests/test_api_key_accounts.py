"""An API key account is a kind of CLI account, and a login account never
enters any of its code."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import agent_team_backend.app as app
from agent_team_backend import api_key_accounts as ak
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
    ak.create("claude", "a", ANTHROPIC_KEY)

    assert calls
    assert all(ANTHROPIC_KEY not in " ".join(args) for args, _ in calls)
    assert any(ANTHROPIC_KEY in (stdin or "") for _, stdin in calls)


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
