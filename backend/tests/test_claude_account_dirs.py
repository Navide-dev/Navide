"""Per-account CLAUDE_CONFIG_DIR: each claude account signs in once inside its
own config dir and Claude Code keeps that login itself. Navide only prepares
the directory and points panes at it — it never reads, copies or writes the
token. Fake ``security`` runner and tmp homes only."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from agent_team_backend.credential_vault import (
    DEFAULT_SLOT_ID,
    CredentialVault,
    legacy_claude_keychain_service,
)
from tests.test_credential_vault import FakeSecurity


def _vault(tmp_path: Path, platform: str = "darwin") -> tuple[CredentialVault, FakeSecurity]:
    sec = FakeSecurity()
    vault = CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=sec,
        platform=platform,
    )
    return vault, sec


def _real_claude(tmp_path: Path) -> Path:
    real = tmp_path / "home" / ".claude"
    (real / "projects").mkdir(parents=True)
    (real / "skills").mkdir()
    (real / "settings.json").write_text('{"hooks": {}}', encoding="utf-8")
    (real / "daemon.lock").write_text("", encoding="utf-8")
    (real / ".credentials.json").write_text('{"claudeAiOauth": {}}', encoding="utf-8")
    return real


def test_account_dir_path_is_stable_and_default_has_none(tmp_path: Path) -> None:
    vault, _ = _vault(tmp_path)
    path = vault.account_dir_path("p1")
    assert path == vault.account_dir_path("p1")
    assert path.name == "config-dir"
    assert path != vault.profile_home_path("claude", "p1")
    with pytest.raises(ValueError):
        vault.account_dir_path(DEFAULT_SLOT_ID)


def test_prepare_links_shared_entries_but_not_credentials_or_runtime_state(tmp_path: Path) -> None:
    vault, _ = _vault(tmp_path)
    real = _real_claude(tmp_path)
    directory = vault.prepare_account_dir("p1")
    assert (directory / "projects").is_symlink()
    assert (directory / "projects").resolve() == (real / "projects").resolve()
    assert (directory / "settings.json").is_symlink()
    assert (directory / "skills").is_symlink()
    assert not (directory / ".credentials.json").exists()
    assert not (directory / "daemon.lock").exists()
    # An entry the real home does not have is not invented there.
    assert not (directory / "commands").exists()
    assert not (real / "commands").exists()
    if os.name != "nt":
        # Windows has no POSIX mode bits: chmod(0o700) cannot narrow access
        # there, and st_mode always reads 0o777 for a directory.
        assert (directory.stat().st_mode & 0o777) == 0o700


def test_prepare_is_idempotent(tmp_path: Path) -> None:
    vault, _ = _vault(tmp_path)
    _real_claude(tmp_path)
    first = vault.prepare_account_dir("p1")
    second = vault.prepare_account_dir("p1")
    assert first == second
    assert (second / "projects").is_symlink()


def test_seed_copies_settings_but_never_identity_or_keys(tmp_path: Path) -> None:
    vault, _ = _vault(tmp_path)
    _real_claude(tmp_path)
    (tmp_path / "home" / ".claude.json").write_text(json.dumps({
        "hasCompletedOnboarding": True,
        "theme": "dark",
        "projects": {"/w": {"hasTrustDialogAccepted": True}},
        "mcpServers": {"a": {"command": "x"}},
        "oauthAccount": {"emailAddress": "real@example.com"},
        "primaryApiKey": "sk-secret",
        "userID": "u1",
    }), encoding="utf-8")
    directory = vault.prepare_account_dir("p1")
    seeded = json.loads((directory / ".claude.json").read_text(encoding="utf-8"))
    assert seeded["hasCompletedOnboarding"] is True
    assert seeded["projects"] == {"/w": {"hasTrustDialogAccepted": True}}
    assert seeded["mcpServers"] == {"a": {"command": "x"}}
    assert "oauthAccount" not in seeded
    assert "primaryApiKey" not in seeded
    assert "userID" not in seeded
    assert not (directory / ".claude.json").is_symlink()


def test_prepare_keeps_the_accounts_own_config_and_resyncs_mcp(tmp_path: Path) -> None:
    vault, _ = _vault(tmp_path)
    _real_claude(tmp_path)
    real_json = tmp_path / "home" / ".claude.json"
    real_json.write_text(json.dumps({"mcpServers": {"a": {}}}), encoding="utf-8")
    directory = vault.prepare_account_dir("p1")
    own = {"oauthAccount": {"emailAddress": "b@example.com"}, "mcpServers": {"a": {}}}
    (directory / ".claude.json").write_text(json.dumps(own), encoding="utf-8")
    real_json.write_text(json.dumps({"mcpServers": {"a": {}, "b": {}}}), encoding="utf-8")
    vault.prepare_account_dir("p1")
    after = json.loads((directory / ".claude.json").read_text(encoding="utf-8"))
    assert after["oauthAccount"] == {"emailAddress": "b@example.com"}
    assert after["mcpServers"] == {"a": {}, "b": {}}


def test_signed_in_checks_presence_without_reading_the_secret(tmp_path: Path) -> None:
    vault, sec = _vault(tmp_path)
    _real_claude(tmp_path)
    assert vault.account_dir_signed_in("p1") is False  # no dir yet
    directory = vault.prepare_account_dir("p1")
    assert vault.account_dir_signed_in("p1") is False
    sec.items[legacy_claude_keychain_service(directory)] = '{"claudeAiOauth": {}}'
    sec.calls.clear()
    assert vault.account_dir_signed_in("p1") is True
    assert sec.calls, "expected a Keychain lookup"
    for call in sec.calls:
        assert "-g" not in call and "-w" not in call


def test_signed_in_on_file_platforms(tmp_path: Path) -> None:
    vault, _ = _vault(tmp_path, platform="linux")
    _real_claude(tmp_path)
    directory = vault.prepare_account_dir("p1")
    assert vault.account_dir_signed_in("p1") is False
    (directory / ".credentials.json").write_text("{}", encoding="utf-8")
    assert vault.account_dir_signed_in("p1") is True


def test_identity_comes_from_the_dirs_own_claude_json(tmp_path: Path) -> None:
    vault, _ = _vault(tmp_path)
    _real_claude(tmp_path)
    assert vault.account_dir_identity("p1") is None
    directory = vault.prepare_account_dir("p1")
    (directory / ".claude.json").write_text(
        json.dumps({"oauthAccount": {"emailAddress": "b@example.com"}}), encoding="utf-8")
    assert vault.account_dir_identity("p1") == {"emailAddress": "b@example.com"}
    assert vault.account_dir_identity(DEFAULT_SLOT_ID) is None


def test_spawn_env_points_at_the_dir_and_drops_api_key_overrides(tmp_path: Path) -> None:
    vault, _ = _vault(tmp_path)
    env, remove = vault.account_dir_spawn_env("p1")
    assert env == {"CLAUDE_CONFIG_DIR": os.fspath(vault.account_dir_path("p1"))}
    assert "ANTHROPIC_API_KEY" in remove


def test_account_dir_never_touches_live_or_slot_credentials(tmp_path: Path) -> None:
    vault, sec = _vault(tmp_path)
    _real_claude(tmp_path)
    sec.items["Claude Code-credentials"] = "live"
    sec.items["Navide CLI account claude-p1"] = "slot"
    before = dict(sec.items)
    directory = vault.prepare_account_dir("p1")
    sec.items[legacy_claude_keychain_service(directory)] = "dir"
    vault.account_dir_signed_in("p1")
    vault.account_dir_identity("p1")
    vault.account_dir_spawn_env("p1")
    assert {k: v for k, v in sec.items.items() if k in before} == before
    assert sec.items[legacy_claude_keychain_service(directory)] == "dir"
    for call in sec.calls:
        assert call[0] != "-i", "no Keychain writes"


def test_deleting_the_account_removes_its_config_dir_login(tmp_path: Path) -> None:
    """The dir's login lives in a Keychain item named after the dir. The
    store archives the slot dir by renaming it, which would leave that item —
    a working refresh token — behind with nothing able to reach it."""
    vault, sec = _vault(tmp_path)
    _real_claude(tmp_path)
    directory = vault.prepare_account_dir("p1")
    service = legacy_claude_keychain_service(directory)
    sec.items[service] = '{"claudeAiOauth": {}}'
    sec.items["Claude Code-credentials"] = "live"
    vault.delete_slot_secrets("claude", "p1")
    assert service not in sec.items
    assert sec.items["Claude Code-credentials"] == "live"


class _StampedSecurity(FakeSecurity):
    """FakeSecurity that also answers an attributes-only lookup the way
    `security find-generic-password -s` does: a modification date, no
    password. `stamps` is what each item's mdat currently reads."""

    def __init__(self) -> None:
        super().__init__()
        self.stamps: dict[str, str] = {}

    def __call__(self, args, input_text=None):
        if args and args[0] == "find-generic-password" and "-g" not in args and "-w" not in args:
            self.calls.append(list(args))
            service = args[args.index("-s") + 1]
            if service not in self.items:
                return 44, ""
            stamp = self.stamps.get(service, "20261008000000Z")
            return 0, (
                'keychain: "/x/login.keychain-db"\nattributes:\n'
                f'    "mdat"<timedate>=0x00  "{stamp}\\000"\n'
            )
        return super().__call__(args, input_text)


def test_an_expired_dir_login_stops_counting_until_the_account_signs_in_again(tmp_path: Path) -> None:
    """Claude Code empties the tokens in place after invalid_grant; the item
    still exists, so a presence check alone kept reporting the account signed
    in and its panes kept opening on a dead login. Once a pane reports it
    expired, the dir stops counting — until the item changes, which is what a
    new sign-in does. The password is never read."""
    sec = _StampedSecurity()
    vault = CredentialVault(
        root=tmp_path / "root", real_home=tmp_path / "home",
        security_runner=sec, platform="darwin",
    )
    _real_claude(tmp_path)
    directory = vault.prepare_account_dir("p1")
    service = legacy_claude_keychain_service(directory)
    sec.items[service] = '{"claudeAiOauth": {"accessToken": "", "refreshToken": ""}}'
    sec.stamps[service] = "20261008010000Z"
    assert vault.account_dir_signed_in("p1") is True

    vault.mark_account_dir_expired("p1")
    assert vault.account_dir_signed_in("p1") is False

    sec.stamps[service] = "20261008020000Z"  # signed in again: the item changed
    assert vault.account_dir_signed_in("p1") is True
    vault.mark_account_dir_expired("p1")
    assert vault.account_dir_signed_in("p1") is False
    for call in sec.calls:
        assert "-g" not in call and "-w" not in call


def test_an_expired_dir_login_on_file_platforms_clears_when_the_file_changes(tmp_path: Path) -> None:
    vault, _ = _vault(tmp_path, platform="linux")
    _real_claude(tmp_path)
    directory = vault.prepare_account_dir("p1")
    creds = directory / ".credentials.json"
    creds.write_text("{}", encoding="utf-8")
    os.utime(creds, ns=(1_000_000_000, 1_000_000_000))
    vault.mark_account_dir_expired("p1")
    assert vault.account_dir_signed_in("p1") is False
    os.utime(creds, ns=(2_000_000_000, 2_000_000_000))
    assert vault.account_dir_signed_in("p1") is True


def _extended_readlink(real_readlink):
    """os.readlink as Windows reports it: with the \\\\?\\ prefix. On Windows
    the real call already carries it, so it is added only when absent."""
    def readlink(path):
        raw = real_readlink(path)
        return raw if raw.startswith("\\\\?\\") else "\\\\?\\" + raw
    return readlink


def test_a_correct_link_is_left_alone_when_readlink_reports_an_extended_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Windows' os.readlink returns the target with a \\\\?\\ prefix. Compared
    as a raw string against the target, every already-correct link read as
    wrong and was deleted and recreated on every prepare — a window in which
    a running pane writing into projects/ would create a real directory in
    its place."""
    vault, _ = _vault(tmp_path)
    _real_claude(tmp_path)
    directory = vault.prepare_account_dir("p1")
    monkeypatch.setattr(os, "readlink", _extended_readlink(os.readlink))
    recreated: list[str] = []
    real_symlink_to = Path.symlink_to

    def spy(self, target, target_is_directory=False):
        recreated.append(self.name)
        return real_symlink_to(self, target, target_is_directory)

    monkeypatch.setattr(Path, "symlink_to", spy)
    vault.prepare_account_dir("p1")
    assert recreated == []
    assert (directory / "projects").is_symlink()
