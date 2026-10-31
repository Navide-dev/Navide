"""API keys are stored apart from CLI accounts and never come back out."""

from __future__ import annotations

import asyncio
import json
import stat
from pathlib import Path

import pytest

from agent_team_backend import api_keys as ak
from agent_team_backend.credential_vault import CredentialVault

# Split so no scanner reads these as real credentials.
ANTHROPIC_KEY = "sk-ant-" + "api03-" + "fakefakefake" + "7F2A"
OPENAI_KEY = "sk-" + "proj-" + "fakefakefake" + "9C1B"
SUBSCRIPTION_TOKEN = "sk-ant-" + "oat01-" + "fakefakefake"


@pytest.fixture
def vault(tmp_path: Path) -> CredentialVault:
    return CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, ""),
        platform="linux",
    )


@pytest.fixture
def store(vault: CredentialVault, tmp_path: Path) -> ak.ApiKeyStore:
    return ak.ApiKeyStore(vault, tmp_path / ak.API_KEYS_FILE)


def test_create_keeps_the_key_out_of_the_metadata(store: ak.ApiKeyStore) -> None:
    row = store.create("claude", " 專案 ", ANTHROPIC_KEY, 50)

    assert row["name"] == "專案"
    assert row["last4"] == "7F2A"
    assert row["monthlyReminderUsd"] == 50.0
    assert ANTHROPIC_KEY not in store.path.read_text(encoding="utf-8")
    assert ANTHROPIC_KEY not in json.dumps(row)
    assert store.read_secret(row["id"]) == ANTHROPIC_KEY


def test_metadata_file_is_owner_only(store: ak.ApiKeyStore) -> None:
    store.create("claude", "a", ANTHROPIC_KEY)
    assert stat.S_IMODE(store.path.stat().st_mode) == 0o600


def test_key_survives_a_restart(store: ak.ApiKeyStore, vault: CredentialVault) -> None:
    row = store.create("codex", "a", OPENAI_KEY)
    again = ak.ApiKeyStore(vault, store.path)
    assert [item["id"] for item in again.list()] == [row["id"]]
    assert again.read_secret(row["id"]) == OPENAI_KEY


def test_replace_secret_updates_the_suffix(store: ak.ApiKeyStore) -> None:
    row = store.create("claude", "a", ANTHROPIC_KEY)
    newer = ANTHROPIC_KEY[:-4] + "ABCD"
    assert store.replace_secret(row["id"], newer)["last4"] == "ABCD"
    assert store.read_secret(row["id"]) == newer


def test_delete_removes_both_halves(store: ak.ApiKeyStore) -> None:
    row = store.create("claude", "a", ANTHROPIC_KEY)
    store.delete(row["id"])
    assert store.list() == []
    with pytest.raises(ak.ApiKeyError) as err:
        store.read_secret(row["id"])
    assert err.value.code == "not-found"
    assert store._vault.read_app_secret("cli-api-key-" + row["id"]) is None


def test_failed_secret_write_leaves_no_row(store: ak.ApiKeyStore, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*args: object) -> None:
        raise RuntimeError(ANTHROPIC_KEY)

    monkeypatch.setattr(ak.cloud_secrets, "write", boom)
    with pytest.raises(ak.ApiKeyError) as err:
        store.create("claude", "a", ANTHROPIC_KEY)
    assert err.value.code == "store-failed"
    assert ANTHROPIC_KEY not in err.value.message
    assert store.list() == []


def test_failed_metadata_write_erases_the_secret(store: ak.ApiKeyStore, monkeypatch: pytest.MonkeyPatch) -> None:
    written: list[tuple[str, str | None]] = []
    monkeypatch.setattr(ak.cloud_secrets, "write", lambda vault, name, secret: written.append((name, secret)))

    def full_disk(rows: object) -> None:
        raise OSError("no space")

    monkeypatch.setattr(store, "_write", full_disk)
    with pytest.raises(ak.ApiKeyError):
        store.create("claude", "a", ANTHROPIC_KEY)
    assert [secret is None for _, secret in written] == [False, True]
    assert written[0][0] == written[1][0]


@pytest.mark.parametrize(
    ("agent", "secret", "code"),
    [
        ("claude", SUBSCRIPTION_TOKEN, "subscription-token"),
        ("codex", SUBSCRIPTION_TOKEN, "subscription-token"),
        ("codex", ANTHROPIC_KEY, "wrong-vendor"),
        ("claude", OPENAI_KEY, "wrong-vendor"),
        ("claude", "", "invalid-secret"),
        ("claude", "has a space", "invalid-secret"),
        ("claude", "x" * (ak.SECRET_MAX_CHARS + 1), "invalid-secret"),
        ("claude", None, "invalid-secret"),
    ],
)
def test_refused_secrets(store: ak.ApiKeyStore, agent: str, secret: object, code: str) -> None:
    with pytest.raises(ak.ApiKeyError) as err:
        store.create(agent, "a", secret)
    assert err.value.code == code
    assert store.list() == []


def test_unsupported_agent_is_refused(store: ak.ApiKeyStore) -> None:
    with pytest.raises(ak.ApiKeyError) as err:
        store.create("kimi", "a", ANTHROPIC_KEY)
    assert err.value.code == "unsupported-agent"


@pytest.mark.parametrize("value", [0, -1, True, "50", ak.MONTHLY_REMINDER_MAX_USD + 1])
def test_bad_reminder_is_refused(store: ak.ApiKeyStore, value: object) -> None:
    with pytest.raises(ak.ApiKeyError) as err:
        store.create("claude", "a", ANTHROPIC_KEY, value)
    assert err.value.code == "invalid-reminder"


def test_launch_env_is_empty_until_approved(store: ak.ApiKeyStore) -> None:
    row = store.create("claude", "a", ANTHROPIC_KEY)
    assert ak.launch_env(store, "claude", row["id"]) == {}


@pytest.mark.parametrize(
    ("status", "expected"),
    [(200, "ok"), (401, "rejected"), (403, "rejected"), (429, "unknown"), (500, "unknown")],
)
def test_probe_reads_the_status(status: int, expected: str) -> None:
    async def fetch(url: str, headers: dict[str, str]) -> int:
        return status

    assert asyncio.run(ak.probe("claude", ANTHROPIC_KEY, fetch)) == expected


def test_probe_offline_is_unknown() -> None:
    async def fetch(url: str, headers: dict[str, str]) -> int:
        raise OSError("offline")

    assert asyncio.run(ak.probe("codex", OPENAI_KEY, fetch)) == "unknown"


@pytest.mark.parametrize(
    ("agent", "secret", "host"),
    [("claude", ANTHROPIC_KEY, "https://api.anthropic.com/"), ("codex", OPENAI_KEY, "https://api.openai.com/")],
)
def test_probe_only_talks_to_the_issuing_vendor(agent: str, secret: str, host: str) -> None:
    url, headers = ak._probe_request(agent, secret)
    assert url.startswith(host)
    assert secret not in url
    assert any(secret in value for value in headers.values())


class FakeSession:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, frame: dict) -> None:
        self.sent.append(frame)


def _call(
    store: ak.ApiKeyStore, monkeypatch: pytest.MonkeyPatch, msg_type: str, payload: dict, main_window: bool = True
) -> tuple[dict, list[dict]]:
    events: list[dict] = []

    async def broadcast(event: dict, **_: object) -> None:
        events.append(event)

    import agent_team_backend.app as app

    monkeypatch.setattr(app, "broadcast", broadcast)
    monkeypatch.setattr(app, "is_main_window", lambda session: main_window)
    monkeypatch.setattr(ak, "_store", store)
    session = FakeSession()
    asyncio.run(ak.MESSAGE_HANDLERS[msg_type](session, "m1", msg_type, payload))
    return session.sent[0], events


def test_no_message_carries_the_key(store: ak.ApiKeyStore, monkeypatch: pytest.MonkeyPatch) -> None:
    created, events = _call(store, monkeypatch, "api_keys.create", {"agentKey": "claude", "name": "a", "secret": ANTHROPIC_KEY})
    key_id = created["payload"]["key"]["id"]
    listed, _ = _call(store, monkeypatch, "api_keys.list", {})
    updated, more = _call(store, monkeypatch, "api_keys.update", {"id": key_id, "name": "b"})

    assert updated["payload"]["key"]["name"] == "b"
    for frame in (created, listed, updated, *events, *more):
        assert ANTHROPIC_KEY not in json.dumps(frame)
    assert events[0]["type"] == "api_keys.changed"


def test_error_answer_does_not_echo_the_paste(store: ak.ApiKeyStore, monkeypatch: pytest.MonkeyPatch) -> None:
    answer, events = _call(store, monkeypatch, "api_keys.create", {"agentKey": "codex", "name": "a", "secret": ANTHROPIC_KEY})
    assert answer["payload"]["error_code"] == "wrong-vendor"
    assert ANTHROPIC_KEY not in json.dumps(answer)
    assert events == []


def test_test_message_probes_a_stored_key(store: ak.ApiKeyStore, monkeypatch: pytest.MonkeyPatch) -> None:
    row = store.create("claude", "a", ANTHROPIC_KEY)
    seen: list[tuple[str, str]] = []

    async def fake_probe(agent: str, secret: str) -> str:
        seen.append((agent, secret))
        return "ok"

    monkeypatch.setattr(ak, "probe", fake_probe)
    answer, _ = _call(store, monkeypatch, "api_keys.test", {"id": row["id"]})
    assert answer["payload"] == {"ok": True, "result": "ok"}
    assert seen == [("claude", ANTHROPIC_KEY)]


def test_plugin_windows_are_refused(store: ak.ApiKeyStore, monkeypatch: pytest.MonkeyPatch) -> None:
    answer, _ = _call(store, monkeypatch, "api_keys.list", {}, main_window=False)
    assert answer["payload"]["error_code"] == "main-window-only"


def test_handlers_are_registered() -> None:
    from agent_team_backend import ws_handlers

    assert set(ak.MESSAGE_HANDLERS) <= set(ws_handlers._REGISTRY)


def test_macos_key_stays_out_of_argv(tmp_path: Path) -> None:
    calls: list[tuple[list[str], str | None]] = []

    def security(args: list[str], input_text: str | None = None) -> tuple[int, str]:
        calls.append((args, input_text))
        return 0, ""

    vault = CredentialVault(root=tmp_path / "root", real_home=tmp_path / "home", security_runner=security, platform="darwin")
    store = ak.ApiKeyStore(vault, tmp_path / ak.API_KEYS_FILE)
    store.create("claude", "a", ANTHROPIC_KEY)

    assert calls
    assert all(ANTHROPIC_KEY not in " ".join(args) for args, _ in calls)
    assert any(ANTHROPIC_KEY in (stdin or "") for _, stdin in calls)
