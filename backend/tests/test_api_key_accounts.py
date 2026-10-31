"""An API key account is a kind of CLI account, and a login account never
enters any of its code."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

import agent_team_backend.app as app
from agent_team_backend import api_key_accounts as ak
from agent_team_backend import ws_handlers
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
