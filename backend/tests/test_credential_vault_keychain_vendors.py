"""Vendors whose account lives in the OS keyring or in a pointer file:
antigravity and cursor (macOS Keychain items declared on the spec), copilot
(``lastLoggedInUser`` pointer in a JSONC config) and droid (an encrypted blob
file). The Keychain is an injected fake keyed by (service, account); nothing
here touches the real one, the real home, or a real token."""

from __future__ import annotations

import base64
import json
import shlex
from pathlib import Path

import pytest

from agent_team_backend.credential_vault import (
    DEFAULT_SLOT_ID,
    CredentialVault,
    CredentialVaultError,
    LiveCredentials,
)
from tests.keychain_fake import security_g_output


class FakeSecurity:
    """`security` CLI double keyed by (service, account) — the shape the
    vendor items need (copilot keeps several logins under one service)."""

    def __init__(self) -> None:
        self.items: dict[tuple[str, str | None], str] = {}
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str], input_text: str | None = None) -> tuple[int, str]:
        self.calls.append(list(args))
        tokens = shlex.split((input_text or "").rstrip("\n")) if args == ["-i"] else list(args)
        cmd = tokens[0]
        service = tokens[tokens.index("-s") + 1]
        account = tokens[tokens.index("-a") + 1] if "-a" in tokens else None
        if cmd == "find-generic-password":
            if account is None:
                hits = [v for (s, _a), v in self.items.items() if s == service]
                return (0, security_g_output(hits[0])) if hits else (44, "")
            value = self.items.get((service, account))
            return (0, security_g_output(value)) if value is not None else (44, "")
        if cmd == "add-generic-password":
            if "-X" in tokens:
                self.items[(service, account)] = bytes.fromhex(tokens[tokens.index("-X") + 1]).decode()
            else:
                self.items[(service, account)] = tokens[tokens.index("-w") + 1]
            return 0, ""
        if cmd == "delete-generic-password":
            if account is None:
                keys = [k for k in self.items if k[0] == service]
            else:
                keys = [k for k in self.items if k == (service, account)]
            for k in keys:
                self.items.pop(k)
            return (0, "") if keys else (44, "")
        return 1, ""


def _mac_vault(tmp_path: Path) -> tuple[CredentialVault, FakeSecurity]:
    sec = FakeSecurity()
    return CredentialVault(
        root=tmp_path / "root", real_home=tmp_path / "home",
        security_runner=sec, platform="darwin",
    ), sec


def _linux_vault(tmp_path: Path) -> CredentialVault:
    return CredentialVault(
        root=tmp_path / "root", real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, ""), platform="linux",
    )


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _agy_blob(refresh: str) -> str:
    payload = json.dumps({"token": {"refresh_token": refresh, "access_token": "stale"}})
    return "go-keyring-base64:" + base64.b64encode(payload.encode()).decode()


# ── antigravity: one fixed-name Keychain item ────────────────────────────


def test_antigravity_switch_swaps_the_gemini_antigravity_item_only(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    sec.items[("gemini", "antigravity")] = _agy_blob("A")
    sec.items[("gemini", "gemini-cli")] = "someone-elses-item"
    vault.write_slot("antigravity", "b", LiveCredentials(
        secret=json.dumps({"keychain": {"gemini|antigravity": _agy_blob("B")}})))

    vault.switch("antigravity", DEFAULT_SLOT_ID, "b")

    assert sec.items[("gemini", "antigravity")] == _agy_blob("B")
    assert sec.items[("gemini", "gemini-cli")] == "someone-elses-item"
    parked = json.loads(vault.read_slot("antigravity", DEFAULT_SLOT_ID).secret)
    assert parked == {"keychain": {"gemini|antigravity": _agy_blob("A")}}
    # Every Keychain read/delete named the account, never the bare service.
    for call in sec.calls:
        if call[0] in ("find-generic-password", "delete-generic-password"):
            assert "-a" in call and call[call.index("-a") + 1] == "antigravity"

    vault.switch("antigravity", "b", DEFAULT_SLOT_ID)
    assert sec.items[("gemini", "antigravity")] == _agy_blob("A")


def test_antigravity_identity_reads_the_refresh_token_presence(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    assert vault.identity("antigravity") == {"email": None, "signedIn": False}
    sec.items[("gemini", "antigravity")] = _agy_blob("A")
    assert vault.identity("antigravity") == {"email": None, "signedIn": True}
    vault.write_slot("antigravity", "x", LiveCredentials(secret='{"keychain": {"gemini|antigravity": "garbage"}}'))
    assert vault.identity("antigravity", "x") == {"email": None, "signedIn": False}


def test_antigravity_empty_slot_deletes_the_item(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    sec.items[("gemini", "antigravity")] = _agy_blob("A")
    vault.switch("antigravity", DEFAULT_SLOT_ID, "empty")
    assert ("gemini", "antigravity") not in sec.items
    assert vault.identity("antigravity")["signedIn"] is False


def test_keychain_vendor_refuses_a_non_keychain_slot_payload(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    sec.items[("gemini", "antigravity")] = _agy_blob("A")
    vault.write_slot("antigravity", "bad", LiveCredentials(secret="not the vault's shape"))
    with pytest.raises(CredentialVaultError):
        vault.switch("antigravity", DEFAULT_SLOT_ID, "bad")
    # Rolled back: the live item is what it was.
    assert sec.items[("gemini", "antigravity")] == _agy_blob("A")


def test_antigravity_capture_is_strict_about_keychain_failures(tmp_path: Path) -> None:
    vault = CredentialVault(
        root=tmp_path / "root", real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, "User interaction is not allowed."),
        platform="darwin",
    )
    with pytest.raises(CredentialVaultError):
        vault.capture("antigravity", DEFAULT_SLOT_ID)
    assert not (vault.slot_dir("antigravity", DEFAULT_SLOT_ID) / "credential.json").exists()


# ── cursor: an access + refresh item pair ────────────────────────────────


def _jwt(sub: str) -> str:
    def b64(obj: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")
    return f"{b64({'alg': 'none'})}.{b64({'sub': sub, 'exp': 9999999999})}.sig"


def test_cursor_switch_swaps_both_items_as_a_pair(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    sec.items[("cursor-access-token", "cursor-user")] = _jwt("google-oauth2|user_A")
    sec.items[("cursor-refresh-token", "cursor-user")] = "refresh-A"
    vault.write_slot("cursor", "b", LiveCredentials(secret=json.dumps({"keychain": {
        "cursor-access-token|cursor-user": _jwt("auth0|user_B"),
        "cursor-refresh-token|cursor-user": "refresh-B",
    }})))

    vault.switch("cursor", DEFAULT_SLOT_ID, "b")

    assert sec.items[("cursor-access-token", "cursor-user")] == _jwt("auth0|user_B")
    assert sec.items[("cursor-refresh-token", "cursor-user")] == "refresh-B"
    assert vault.identity("cursor") == {"email": "user_B", "signedIn": True}
    assert vault.identity("cursor", DEFAULT_SLOT_ID) == {"email": "user_A", "signedIn": True}

    vault.switch("cursor", "b", DEFAULT_SLOT_ID)
    assert sec.items[("cursor-refresh-token", "cursor-user")] == "refresh-A"


def test_cursor_missing_refresh_item_is_parked_as_absent(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    sec.items[("cursor-access-token", "cursor-user")] = _jwt("auth0|only_access")
    vault.capture("cursor", DEFAULT_SLOT_ID)
    parked = json.loads(vault.read_slot("cursor", DEFAULT_SLOT_ID).secret)
    assert set(parked["keychain"]) == {"cursor-access-token|cursor-user"}


def test_keychain_vendors_are_unsupported_off_macos(tmp_path: Path) -> None:
    from agent_team_backend.cli_vendors.base import switch_preflight
    from agent_team_backend.cli_vendors.registry import VENDORS

    for key in ("antigravity", "cursor"):
        row = switch_preflight(VENDORS[key], env_names=[], platform="linux")
        assert row["reason"] == "platform-unsupported", key
    # droid's blob swap needs no keyring access of Navide's own, so it is
    # declared everywhere; the key-file mode is what preflight refuses.
    assert switch_preflight(VENDORS["droid"], env_names=[], platform="linux")["ok"] is True
    assert switch_preflight(VENDORS["droid"], env_names=["FACTORY_DISABLE_KEYRING"], platform="darwin")["reason"] == "shadowed-by-env"
    # cursor declares no file location at all: off macOS the vault has
    # nowhere to read, and says so instead of inventing a path.
    with pytest.raises(CredentialVaultError):
        _linux_vault(tmp_path).read_live("cursor")


# ── copilot: a pointer inside a JSONC config ─────────────────────────────


COPILOT_CONFIG = """// User settings belong in settings.json.
// This file is managed automatically.
{
  "firstLaunchAt": "2026-03-16T20:23:34.900Z",
  "loggedInUsers": [
    { "host": "https://github.com", "login": "alice" },
    { "host": "https://github.com", "login": "bob" }
  ],
  "lastLoggedInUser": { "host": "https://github.com", "login": "alice" },
  "someOtherSetting": 7
}
"""


def test_copilot_switch_flips_the_pointer_and_keeps_the_header(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("COPILOT_HOME", raising=False)
    vault, sec = _mac_vault(tmp_path)
    config = tmp_path / "home" / ".copilot" / "config.json"
    _write(config, COPILOT_CONFIG)
    vault.write_slot("copilot", "bob", LiveCredentials(
        secret='{"host": "https://github.com", "login": "bob"}'))

    vault.switch("copilot", DEFAULT_SLOT_ID, "bob")

    text = config.read_text(encoding="utf-8")
    assert text.startswith("// User settings belong in settings.json.\n// This file is managed automatically.\n{")
    data = json.loads("\n".join(l for l in text.splitlines() if not l.startswith("//")))
    assert data["lastLoggedInUser"] == {"host": "https://github.com", "login": "bob"}
    assert data["loggedInUsers"] == [
        {"host": "https://github.com", "login": "alice"},
        {"host": "https://github.com", "login": "bob"},
    ]
    assert data["firstLaunchAt"] == "2026-03-16T20:23:34.900Z" and data["someOtherSetting"] == 7
    assert sec.calls == []  # never the keyring
    assert vault.identity("copilot") == {"email": "bob", "signedIn": True}
    assert vault.identity("copilot", DEFAULT_SLOT_ID) == {"email": "alice", "signedIn": True}

    vault.switch("copilot", "bob", DEFAULT_SLOT_ID)
    data = json.loads("\n".join(l for l in config.read_text(encoding="utf-8").splitlines() if not l.startswith("//")))
    assert data["lastLoggedInUser"]["login"] == "alice"


def test_copilot_refuses_a_login_the_cli_never_did(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("COPILOT_HOME", raising=False)
    vault = _linux_vault(tmp_path)
    config = tmp_path / "home" / ".copilot" / "config.json"
    _write(config, COPILOT_CONFIG)
    vault.write_slot("copilot", "carol", LiveCredentials(
        secret='{"host": "https://github.com", "login": "carol"}'))
    with pytest.raises(CredentialVaultError):
        vault.switch("copilot", DEFAULT_SLOT_ID, "carol")
    # Rolled back: still alice, the login list intact (the rollback rewrite
    # re-serialises the body, so compare values, not bytes).
    text = config.read_text(encoding="utf-8")
    assert text.startswith("// User settings belong in settings.json.\n")
    data = json.loads("\n".join(l for l in text.splitlines() if not l.startswith("//")))
    assert data["lastLoggedInUser"]["login"] == "alice"
    assert [u["login"] for u in data["loggedInUsers"]] == ["alice", "bob"]


def test_copilot_home_env_relocates_the_config(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("COPILOT_HOME", str(tmp_path / "chome"))
    vault = _linux_vault(tmp_path)
    _write(tmp_path / "chome" / "config.json", COPILOT_CONFIG)
    assert vault.identity("copilot") == {"email": "alice", "signedIn": True}


# ── droid: an encrypted blob file ────────────────────────────────────────


def test_droid_switch_swaps_the_blob_file(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("FACTORY_HOME_OVERRIDE", raising=False)
    vault, sec = _mac_vault(tmp_path)
    blob = tmp_path / "home" / ".factory" / "auth.v2.loginkeychain"
    _write(blob, "ENCRYPTED-A")
    _write(tmp_path / "home" / ".factory" / "settings.json", '{"keep": true}')
    vault.write_slot("droid", "b", LiveCredentials(secret="ENCRYPTED-B"))

    vault.switch("droid", DEFAULT_SLOT_ID, "b")

    assert blob.read_text(encoding="utf-8") == "ENCRYPTED-B"
    assert (tmp_path / "home" / ".factory" / "settings.json").read_text(encoding="utf-8") == '{"keep": true}'
    assert sec.calls == []  # the encryption key in the Keychain is never touched
    assert vault.read_slot("droid", DEFAULT_SLOT_ID).secret == "ENCRYPTED-A"
    assert vault.identity("droid") == {"email": None, "signedIn": True}


def test_droid_prefers_whichever_store_exists(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("FACTORY_HOME_OVERRIDE", raising=False)
    vault, _ = _mac_vault(tmp_path)
    _write(tmp_path / "home" / ".factory" / "auth.v2.keyring", "KEYRING-BLOB")
    assert vault.read_live("droid").secret == "KEYRING-BLOB"


def test_droid_login_home_isolates_under_factory_home_override(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("FACTORY_HOME_OVERRIDE", raising=False)
    vault, _ = _mac_vault(tmp_path)
    env_set, env_remove = vault.login_spawn_env("droid", "p1")
    home = vault.login_home_path("droid", "p1")
    assert env_set == {"FACTORY_HOME_OVERRIDE": str(home)} and env_remove == []
    assert vault.login_secret_present("droid", "p1") is False
    _write(home / "auth.v2.loginkeychain", "ENCRYPTED-NEW")
    assert vault.login_secret_present("droid", "p1") is True
    assert vault.harvest_login_home("droid", "p1") is True
    assert vault.read_slot("droid", "p1").secret == "ENCRYPTED-NEW"
    assert not home.exists()


def test_droid_key_file_mode_is_refused_not_swapped(tmp_path: Path, monkeypatch) -> None:
    """FACTORY_DISABLE_KEYRING keeps the key beside the blob, per directory:
    a blob from another home cannot be decrypted there, so the vault refuses
    to touch such a home instead of publishing an unreadable login."""
    monkeypatch.delenv("FACTORY_HOME_OVERRIDE", raising=False)
    vault, _ = _mac_vault(tmp_path)
    _write(tmp_path / "home" / ".factory" / "auth.v2.key", "KEY")
    _write(tmp_path / "home" / ".factory" / "auth.v2.file", "BLOB")
    vault.write_slot("droid", "b", LiveCredentials(secret="ENCRYPTED-B"))
    with pytest.raises(CredentialVaultError):
        vault.switch("droid", DEFAULT_SLOT_ID, "b")
    assert (tmp_path / "home" / ".factory" / "auth.v2.file").read_text(encoding="utf-8") == "BLOB"


# ── non-isolated logins: the pre-login snapshot contract ─────────────────


@pytest.mark.parametrize("agent_key,seed,written", [
    ("antigravity", lambda sec: sec.items.__setitem__(("gemini", "antigravity"), _agy_blob("A")),
     lambda sec: sec.items.__setitem__(("gemini", "antigravity"), _agy_blob("B"))),
    ("cursor", lambda sec: sec.items.update({("cursor-access-token", "cursor-user"): _jwt("auth0|A"), ("cursor-refresh-token", "cursor-user"): "rA"}),
     lambda sec: sec.items.update({("cursor-access-token", "cursor-user"): _jwt("auth0|B"), ("cursor-refresh-token", "cursor-user"): "rB"})),
])
def test_non_isolated_login_never_costs_the_active_account(tmp_path: Path, agent_key: str, seed, written) -> None:
    """Add account B on a CLI whose sign-in writes the one live store: the
    vault snapshots A before the pane starts, parks what the CLI wrote into
    B's slot afterwards, puts A back, and only a later switch brings B live
    — A's slot is never the place B lands."""
    vault, sec = _mac_vault(tmp_path)
    seed(sec)
    vault.capture(agent_key, "a")                       # A is the active, parked-too account
    a_secret = vault.read_slot(agent_key, "a").secret
    assert vault.login_spawn_env(agent_key, "b") == ({}, [])
    assert not vault.login_home_path(agent_key, "b").exists()
    assert vault.login_pending(agent_key, "b") is True
    assert vault.login_secret_present(agent_key, "b") is False
    assert vault.harvest_login_home(agent_key, "b") is False   # nothing written yet

    written(sec)                                         # the CLI signs in as B, live = B
    assert vault.login_secret_present(agent_key, "b") is True
    assert vault.harvest_login_home(agent_key, "b") is True
    assert vault.login_pending(agent_key, "b") is False
    assert vault.read_live(agent_key).secret == a_secret          # A is live again
    assert vault.read_slot(agent_key, "a").secret == a_secret     # A's slot untouched
    b_secret = vault.read_slot(agent_key, "b").secret
    assert b_secret is not None and b_secret != a_secret

    vault.switch(agent_key, "a", "b")
    assert vault.read_live(agent_key).secret == b_secret
    assert vault.read_slot(agent_key, "a").secret == a_secret


def test_non_isolated_login_discard_keeps_or_parks_but_never_loses(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("COPILOT_HOME", raising=False)
    vault = _linux_vault(tmp_path)
    config = tmp_path / "home" / ".copilot" / "config.json"
    _write(config, COPILOT_CONFIG)                      # alice active
    vault.login_spawn_env("copilot", "bob")
    # Cancelled before the CLI wrote anything: nothing parked, alice stays.
    assert vault.discard_pending_login("copilot", "bob") is False
    assert vault.login_pending("copilot", "bob") is False
    assert vault.identity("copilot")["email"] == "alice"
    # Started again, CLI completed, then the pane was killed: bob is parked,
    # alice is back, nothing pending.
    vault.login_spawn_env("copilot", "bob")
    vault.write_live("copilot", LiveCredentials(secret='{"host":"https://github.com","login":"bob"}'))
    assert vault.discard_pending_login("copilot", "bob") is True
    assert vault.identity("copilot")["email"] == "alice"
    assert vault.identity("copilot", "bob")["email"] == "bob"
    assert vault.login_pending("copilot", "bob") is False


def test_non_isolated_login_with_scope_parks_only_that_provider(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    vault = _linux_vault(tmp_path)
    live = tmp_path / "home" / ".local" / "share" / "kilo" / "auth.json"
    _write(live, json.dumps({"kilo": {"type": "api", "key": "A"}, "google": {"type": "api", "key": "G"}}))
    vault.login_spawn_env("kilo", "b")                  # single scope: "kilo" implied
    _write(live, json.dumps({"kilo": {"type": "oauth", "access": "B"}, "google": {"type": "api", "key": "G2"}}))
    assert vault.harvest_login_home("kilo", "b") is True
    after = json.loads(live.read_text(encoding="utf-8"))
    assert after["kilo"] == {"type": "api", "key": "A"}       # A back
    assert after["google"] == {"type": "api", "key": "G2"}    # not ours to revert
    assert json.loads(vault.read_slot("kilo", "b").secret) == {"type": "oauth", "access": "B"}


def test_isolated_vendors_keep_the_login_home_contract(tmp_path: Path) -> None:
    vault = _linux_vault(tmp_path)
    vault.login_spawn_env("codex", "s1")
    assert vault.login_pending("codex", "s1") is True
    assert vault.discard_pending_login("codex", "s1") is False   # isolated: harvest path, untouched
    assert vault.login_home_path("codex", "s1").is_dir()


def test_deleting_a_profile_mid_login_restores_the_active_account(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("COPILOT_HOME", raising=False)
    vault = _linux_vault(tmp_path)
    config = tmp_path / "home" / ".copilot" / "config.json"
    _write(config, COPILOT_CONFIG)                      # alice active
    vault.login_spawn_env("copilot", "bob")
    vault.write_live("copilot", LiveCredentials(secret='{"host":"https://github.com","login":"bob"}'))

    vault.delete_slot_secrets("copilot", "bob")          # the store renames the slot dir next

    assert vault.identity("copilot")["email"] == "alice"
    assert vault.login_pending("copilot", "bob") is False
    # Closed before signing in: nothing to restore, nothing pending.
    vault.login_spawn_env("copilot", "carol")
    vault.delete_slot_secrets("copilot", "carol")
    assert vault.identity("copilot")["email"] == "alice"
    assert vault.login_pending("copilot", "carol") is False


@pytest.mark.parametrize("where", ["settings.json", "config.json"])
def test_copilot_plaintext_token_mode_is_refused_before_any_mutation(tmp_path: Path, monkeypatch, where: str) -> None:
    """storeTokenPlaintext: the token is not in the keyring and its location
    is unknown to Navide, so the pointer flip could pick another account's
    token. Every entry point refuses up front; config.json and the slots
    stay byte-for-byte as they were."""
    monkeypatch.delenv("COPILOT_HOME", raising=False)
    vault = _linux_vault(tmp_path)
    root = tmp_path / "home" / ".copilot"
    if where == "config.json":
        _write(root / "config.json", COPILOT_CONFIG.replace('"someOtherSetting": 7', '"someOtherSetting": 7,\n  "storeTokenPlaintext": true'))
    else:
        _write(root / "config.json", COPILOT_CONFIG)
        _write(root / "settings.json", '{"storeTokenPlaintext": true}')
    before = (root / "config.json").read_text(encoding="utf-8")
    vault.write_slot("copilot", "bob", LiveCredentials(secret='{"host": "https://github.com", "login": "bob"}'))
    slot_before = (vault.slot_dir("copilot", "bob") / "account.json").read_bytes()

    with pytest.raises(CredentialVaultError, match="storeTokenPlaintext"):
        vault.switch("copilot", DEFAULT_SLOT_ID, "bob")
    with pytest.raises(CredentialVaultError, match="storeTokenPlaintext"):
        vault.login_spawn_env("copilot", "carol")
    assert vault.identity("copilot") == {"email": None, "signedIn": False}   # display-only: never raises
    assert (root / "config.json").read_text(encoding="utf-8") == before
    assert (vault.slot_dir("copilot", "bob") / "account.json").read_bytes() == slot_before
    assert not (vault.slot_dir("copilot", DEFAULT_SLOT_ID) / "account.json").exists()
    assert vault.login_pending("copilot", "carol") is False


def test_copilot_plaintext_flag_false_or_absent_keeps_the_pointer_switch(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("COPILOT_HOME", raising=False)
    vault = _linux_vault(tmp_path)
    root = tmp_path / "home" / ".copilot"
    _write(root / "config.json", COPILOT_CONFIG)
    _write(root / "settings.json", '{"storeTokenPlaintext": false}')
    vault.write_slot("copilot", "bob", LiveCredentials(secret='{"host": "https://github.com", "login": "bob"}'))
    vault.switch("copilot", DEFAULT_SLOT_ID, "bob")
    assert vault.identity("copilot")["email"] == "bob"
