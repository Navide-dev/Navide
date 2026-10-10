"""CredentialVault: slot capture/restore, atomic switching, harvest.

The file backend runs against tmp paths only; the macOS Keychain backend runs
against an injected fake `security` runner — the real Keychain and the real
home are NEVER touched."""

from __future__ import annotations

import json
import os
import shlex
import stat
from pathlib import Path

import pytest

from agent_team_backend import osplat
from tests.keychain_fake import security_g_output, security_w_output
from agent_team_backend.credential_vault import (
    CLAUDE_LIVE_KEYCHAIN_SERVICE,
    DEFAULT_SLOT_ID,
    CredentialVault,
    CredentialVaultError,
    LiveCredentials,
    legacy_claude_keychain_service,
)


class FakeSecurity:
    """In-memory generic-password store mimicking the `security` CLI."""

    def __init__(self) -> None:
        self.items: dict[str, str] = {}
        self.calls: list[list[str]] = []
        self.stdin_commands: list[str] = []

    def __call__(self, args: list[str], input_text: str | None = None) -> tuple[int, str]:
        self.calls.append(list(args))
        if args == ["-i"]:
            # Interactive mode: the whole command arrives on stdin.
            self.stdin_commands.append(input_text or "")
            body = (input_text or "").rstrip("\n")
            if "\n" in body:
                # Real `security -i` reads ONE command per line: a payload
                # carrying a newline is cut there and the remainder is parsed
                # as further (bogus) commands. Reject it the same way so a
                # multi-line secret can never pass in tests but fail on a Mac.
                return 1, "unknown command"
            tokens = shlex.split(body)
        else:
            tokens = list(args)
        service = tokens[tokens.index("-s") + 1]
        cmd = tokens[0]
        if cmd == "find-generic-password":
            if service in self.items:
                return 0, security_g_output(self.items[service])
            return 44, ""
        if cmd == "add-generic-password":
            self.items[service] = tokens[tokens.index("-w") + 1]
            return 0, ""
        if cmd == "delete-generic-password":
            return (0, "") if self.items.pop(service, None) is not None else (44, "")
        return 1, ""


def _file_vault(tmp_path: Path) -> CredentialVault:
    return CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, ""),
        platform="linux",
    )


def _mac_vault(tmp_path: Path) -> tuple[CredentialVault, FakeSecurity]:
    sec = FakeSecurity()
    vault = CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=sec,
        platform="darwin",
    )
    return vault, sec


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# ── file backend ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("agent_key,live_rel", [
    ("codex", ".codex/auth.json"),
    ("kimi", ".kimi-code/credentials/kimi-code.json"),
    ("grok", ".grok/auth.json"),
    ("claude", ".claude/.credentials.json"),
])
def test_capture_and_restore_round_trip(tmp_path: Path, agent_key: str, live_rel: str) -> None:
    # Every agent follows the same model: the active account's secret lives in
    # the live location and the slots are cold backups.
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / live_rel
    _write(live, '{"who": "acct-a"}')

    assert vault.slot_is_empty(agent_key, DEFAULT_SLOT_ID)
    vault.capture(agent_key, DEFAULT_SLOT_ID)
    assert not vault.slot_is_empty(agent_key, DEFAULT_SLOT_ID)

    vault.clear_live(agent_key)
    assert not live.exists()

    vault.restore(agent_key, DEFAULT_SLOT_ID)
    assert live.read_text(encoding="utf-8") == '{"who": "acct-a"}'


@pytest.mark.skipif(
    not osplat.paths.enforces_posix_modes(),
    reason="POSIX mode bits: NTFS has none, secret_files hardens with an ACL",
)
def test_slot_files_are_private(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".codex" / "auth.json", "{}")
    vault.capture("codex", "slot1")
    slot_file = vault.slot_dir("codex", "slot1") / "auth.json"
    assert stat.S_IMODE(os.stat(slot_file).st_mode) == 0o600


def test_capture_logged_out_live_empties_slot(tmp_path: Path) -> None:
    """Capture mirrors reality: no live credentials -> the slot goes empty."""
    vault = _file_vault(tmp_path)
    vault.write_slot("grok", "slot1", LiveCredentials(secret="stale"))

    vault.capture("grok", "slot1")

    assert vault.slot_is_empty("grok", "slot1")


def test_restore_from_empty_slot_clears_live(tmp_path: Path) -> None:
    """A never-used account slot clears the live credentials so the CLI
    prompts a fresh login on the next pane."""
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / ".codex" / "auth.json"
    _write(live, '{"who": "old"}')

    vault.restore("codex", "fresh-slot")

    assert not live.exists()


def test_switch_moves_live_between_slots(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / ".kimi-code" / "credentials" / "kimi-code.json"
    _write(live, '{"who": "A"}')
    vault.write_slot("kimi", "slot-b", LiveCredentials(secret='{"who": "B"}'))

    vault.switch("kimi", DEFAULT_SLOT_ID, "slot-b")

    assert vault.read_slot("kimi", DEFAULT_SLOT_ID).secret == '{"who": "A"}'
    assert live.read_text(encoding="utf-8") == '{"who": "B"}'

    # And back: B -> default restores the original login.
    vault.switch("kimi", "slot-b", DEFAULT_SLOT_ID)
    assert vault.read_slot("kimi", "slot-b").secret == '{"who": "B"}'
    assert live.read_text(encoding="utf-8") == '{"who": "A"}'


def test_switch_to_empty_slot_clears_live(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / ".grok" / "auth.json"
    _write(live, '{"who": "A"}')

    vault.switch("grok", DEFAULT_SLOT_ID, "new-account")

    assert vault.read_slot("grok", DEFAULT_SLOT_ID).secret == '{"who": "A"}'
    assert not live.exists()


def test_switch_restore_failure_rolls_back_live(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / ".codex" / "auth.json"
    _write(live, '{"who": "A"}')

    def boom(agent_key: str, slot_id: str) -> None:
        raise RuntimeError("disk full")

    monkeypatch.setattr(vault, "restore", boom)
    with pytest.raises(CredentialVaultError):
        vault.switch("codex", DEFAULT_SLOT_ID, "slot-b")

    # The capture into the outgoing slot happened, and live is unchanged.
    assert vault.read_slot("codex", DEFAULT_SLOT_ID).secret == '{"who": "A"}'
    assert live.read_text(encoding="utf-8") == '{"who": "A"}'


def test_harvest_fills_only_empty_slot(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / ".codex" / "auth.json"

    assert vault.harvest("codex", "slot1") is False  # nothing live yet

    _write(live, '{"who": "A"}')
    assert vault.harvest("codex", "slot1") is True
    assert vault.read_slot("codex", "slot1").secret == '{"who": "A"}'

    _write(live, '{"who": "B"}')
    assert vault.harvest("codex", "slot1") is False  # occupied slot untouched
    assert vault.read_slot("codex", "slot1").secret == '{"who": "A"}'


# ── wiped claude credentials ────────────────────────────────────────────────
#
# Claude Code empties accessToken/refreshToken in place when the server
# rejects a refresh, leaving a valid-looking blob with no credential in it.


def _wiped_claude_secret(expires_at: int = 1000) -> str:
    """What Claude Code leaves behind when a refresh is rejected: the wrapper
    and metadata survive, both tokens are emptied in place."""
    return json.dumps({
        "claudeAiOauth": {
            "accessToken": "",
            "refreshToken": "",
            "expiresAt": expires_at,
            "scopes": ["user:inference"],
        }
    })


_WIPED = _wiped_claude_secret()
_LIVE_TOKENS = json.dumps({
    "claudeAiOauth": {
        "accessToken": "sk-live",
        "refreshToken": "rt-live",
        "expiresAt": 2000,
    }
})


def test_write_slot_keeps_stored_secret_but_updates_account_when_wiped(
    tmp_path: Path,
) -> None:
    """The guard lives in write_slot, so every mirroring path inherits it: the
    stored secret survives while the display-only account still refreshes."""
    vault = _file_vault(tmp_path)
    vault.write_slot("claude", "slot1", LiveCredentials(
        secret=_LIVE_TOKENS, account={"emailAddress": "old@x.com"},
    ))

    vault.write_slot("claude", "slot1", LiveCredentials(
        secret=_WIPED, account={"emailAddress": "new@x.com"},
    ))

    slot = vault.read_slot("claude", "slot1")
    assert slot.secret == _LIVE_TOKENS
    assert slot.account == {"emailAddress": "new@x.com"}


def test_write_slot_still_clears_the_slot_on_a_real_sign_out(tmp_path: Path) -> None:
    """A signed-out state is ``None``, not a wiped blob — it must keep emptying
    the slot exactly as before."""
    vault = _file_vault(tmp_path)
    vault.write_slot("claude", "slot1", LiveCredentials(secret=_LIVE_TOKENS))

    vault.write_slot("claude", "slot1", LiveCredentials(secret=None))

    assert vault.slot_is_empty("claude", "slot1")


@pytest.mark.parametrize("incoming,stored_survives", [
    # Both tokens emptied in place — the shape Claude Code leaves behind.
    ('{"claudeAiOauth": {"accessToken": "", "refreshToken": ""}}', True),
    # An empty wrapper carries no token either.
    ('{"claudeAiOauth": {}}', True),
    # Expired access token but the refresh token survives: still recoverable,
    # so it must be stored — this is the common expired-credential case.
    ('{"claudeAiOauth": {"accessToken": "", "refreshToken": "rt"}}', False),
    ('{"claudeAiOauth": {"accessToken": "at", "refreshToken": ""}}', False),
    # Not an OAuth blob at all (long-lived token, API key, junk): the guard is
    # about one known shape and must not swallow anything else.
    ('{"someOtherLogin": {"token": "t"}}', False),
    ("not-json-at-all", False),
    ("", False),
])
def test_write_slot_wiped_guard_shapes(
    tmp_path: Path, incoming: str, stored_survives: bool
) -> None:
    vault = _file_vault(tmp_path)
    vault.write_slot("claude", "slot1", LiveCredentials(secret=_LIVE_TOKENS))

    vault.write_slot("claude", "slot1", LiveCredentials(secret=incoming))

    expected = _LIVE_TOKENS if stored_survives else incoming
    assert vault.read_slot("claude", "slot1").secret == expected


def test_write_slot_wiped_guard_is_claude_only(tmp_path: Path) -> None:
    """Other agents have no such format; their blobs pass through untouched."""
    vault = _file_vault(tmp_path)
    vault.write_slot("codex", "slot1", LiveCredentials(secret=_WIPED))

    assert vault.read_slot("codex", "slot1").secret == _WIPED


def test_capture_keeps_slot_when_live_claude_tokens_are_wiped(tmp_path: Path) -> None:
    """The slot's stored refresh token is the account's only surviving copy —
    a wiped live blob must never overwrite it."""
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".claude" / ".credentials.json", _WIPED)
    vault.write_slot("claude", "slot1", LiveCredentials(secret=_LIVE_TOKENS))

    captured = vault.capture("claude", "slot1")

    assert vault.read_slot("claude", "slot1").secret == _LIVE_TOKENS
    # The snapshot still mirrors live so switch() can roll it back.
    assert captured.secret == _WIPED


def test_capture_never_replaces_a_newer_login_of_the_same_account_with_an_older_one(tmp_path: Path) -> None:
    """P4: the slot holds a fresh sign-in of the account while live still
    runs on the account's older token; mirroring live back would lose it."""
    vault = _file_vault(tmp_path)
    older = json.dumps({"claudeAiOauth": {"accessToken": "a1", "refreshToken": "r1", "expiresAt": 1000}})
    newer = json.dumps({"claudeAiOauth": {"accessToken": "a2", "refreshToken": "r2", "expiresAt": 2000}})
    vault.write_live("claude", LiveCredentials(secret=older, account={"emailAddress": "a@x.com"}))
    vault.write_slot("claude", "slot1", LiveCredentials(secret=newer, account={"emailAddress": "a@x.com"}))

    captured = vault.capture("claude", "slot1")

    assert vault.read_slot("claude", "slot1").secret == newer
    assert captured.secret == older  # switch() can still roll live back


def test_capture_still_mirrors_an_older_token_of_a_different_account(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    older = json.dumps({"claudeAiOauth": {"accessToken": "b1", "refreshToken": "r1", "expiresAt": 1000}})
    newer = json.dumps({"claudeAiOauth": {"accessToken": "a2", "refreshToken": "r2", "expiresAt": 2000}})
    vault.write_live("claude", LiveCredentials(secret=older, account={"emailAddress": "b@x.com"}))
    vault.write_slot("claude", "slot1", LiveCredentials(secret=newer, account={"emailAddress": "a@x.com"}))

    vault.capture("claude", "slot1")

    assert vault.read_slot("claude", "slot1").secret == older


def test_capture_stores_claude_credential_that_still_has_a_token(tmp_path: Path) -> None:
    """Only a fully wiped blob is refused: an expired-but-refreshable
    credential still carries the refresh token and must be backed up."""
    vault = _file_vault(tmp_path)
    expired = json.dumps({
        "claudeAiOauth": {"accessToken": "", "refreshToken": "rt-1", "expiresAt": 1}
    })
    _write(tmp_path / "home" / ".claude" / ".credentials.json", expired)

    vault.capture("claude", "slot1")

    assert vault.read_slot("claude", "slot1").secret == expired


def test_switch_away_from_wiped_claude_login_preserves_slot_token(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / ".claude" / ".credentials.json"
    _write(live, _WIPED)
    vault.write_slot("claude", "slot-a", LiveCredentials(secret=_LIVE_TOKENS))
    vault.write_slot("claude", "slot-b", LiveCredentials(secret='{"who": "B"}'))

    vault.switch("claude", "slot-a", "slot-b")

    # slot-a keeps the credential it can still be recovered from...
    assert vault.read_slot("claude", "slot-a").secret == _LIVE_TOKENS
    # ...and the target account came live as usual.
    assert live.read_text(encoding="utf-8") == '{"who": "B"}'


def test_harvest_ignores_wiped_claude_credential(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".claude" / ".credentials.json", _WIPED)

    assert vault.harvest("claude", "slot1") is False
    assert vault.slot_is_empty("claude", "slot1")


def test_claude_oauth_account_round_trip(tmp_path: Path) -> None:
    """`~/.claude.json` oauthAccount travels with the credentials; other keys
    in the file survive both clear and restore."""
    vault = _file_vault(tmp_path)
    # A token must be present: capture() refuses to mirror a wiped credential.
    _write(tmp_path / "home" / ".claude" / ".credentials.json", _LIVE_TOKENS)
    _write(
        tmp_path / "home" / ".claude.json",
        json.dumps({"oauthAccount": {"emailAddress": "a@x.com"}, "theme": "dark"}),
    )

    vault.capture("claude", "slot1")
    assert vault.slot_account("claude", "slot1") == {"emailAddress": "a@x.com"}

    vault.clear_live("claude")
    config = json.loads((tmp_path / "home" / ".claude.json").read_text(encoding="utf-8"))
    assert "oauthAccount" not in config
    assert config["theme"] == "dark"

    vault.restore("claude", "slot1")
    config = json.loads((tmp_path / "home" / ".claude.json").read_text(encoding="utf-8"))
    assert config["oauthAccount"] == {"emailAddress": "a@x.com"}
    assert config["theme"] == "dark"


# ── claude follows the same live↔slot swap model as every other agent ───────


def _claude_live_file(tmp_path: Path) -> Path:
    return tmp_path / "home" / ".claude" / ".credentials.json"


def _claude_secret(token: str, expires_at: object | None = None) -> str:
    oauth: dict = {"accessToken": token}
    if expires_at is not None:
        oauth["expiresAt"] = expires_at
    return json.dumps({"claudeAiOauth": oauth})


def _oauth_account(tmp_path: Path) -> object:
    config = json.loads((tmp_path / "home" / ".claude.json").read_text(encoding="utf-8"))
    return config.get("oauthAccount")


def test_claude_switch_live_slot_round_trip(tmp_path: Path) -> None:
    """Switching to a managed claude profile swaps the live secret exactly
    like any other agent: the default login is parked in __default__ and the
    profile's slot secret + display account are published to the live
    location; switching back reverses it verbatim."""
    vault = _file_vault(tmp_path)
    live = _claude_live_file(tmp_path)
    _write(live, "DEFAULT-TOKEN")
    _write(
        tmp_path / "home" / ".claude.json",
        json.dumps({"oauthAccount": {"emailAddress": "default@x.com"}, "theme": "dark"}),
    )
    vault.write_slot(
        "claude", "acct1",
        LiveCredentials(secret="ACCT1-TOKEN", account={"emailAddress": "acct1@x.com"}),
    )

    vault.switch("claude", DEFAULT_SLOT_ID, "acct1")

    assert live.read_text(encoding="utf-8") == "ACCT1-TOKEN"
    default_slot = vault.read_slot("claude", DEFAULT_SLOT_ID)
    assert default_slot.secret == "DEFAULT-TOKEN"
    assert default_slot.account == {"emailAddress": "default@x.com"}
    config = json.loads((tmp_path / "home" / ".claude.json").read_text(encoding="utf-8"))
    assert config["oauthAccount"] == {"emailAddress": "acct1@x.com"}
    assert config["theme"] == "dark"

    vault.switch("claude", "acct1", DEFAULT_SLOT_ID)

    assert live.read_text(encoding="utf-8") == "DEFAULT-TOKEN"
    acct1_slot = vault.read_slot("claude", "acct1")
    assert acct1_slot.secret == "ACCT1-TOKEN"
    assert acct1_slot.account == {"emailAddress": "acct1@x.com"}
    assert _oauth_account(tmp_path) == {"emailAddress": "default@x.com"}


def test_mac_claude_switch_moves_secret_into_live_keychain(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE] = "DEFAULT-TOKEN"
    vault.write_slot("claude", "acct1", LiveCredentials(secret="ACCT1-TOKEN"))

    vault.switch("claude", DEFAULT_SLOT_ID, "acct1")

    assert sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE] == "ACCT1-TOKEN"
    assert sec.items["Navide CLI account claude-__default__"] == "DEFAULT-TOKEN"

    vault.switch("claude", "acct1", DEFAULT_SLOT_ID)

    assert sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE] == "DEFAULT-TOKEN"
    assert sec.items["Navide CLI account claude-acct1"] == "ACCT1-TOKEN"


def test_restore_overwrites_live_with_slot_snapshot(tmp_path: Path) -> None:
    """restore() publishes the incoming slot unconditionally, even when the
    live token carries a newer expiry: the two secrets belong to DIFFERENT
    accounts, so a freshness comparison would be meaningless — and the
    outgoing account's live state was already captured into its own slot."""
    vault = _file_vault(tmp_path)
    _write(_claude_live_file(tmp_path), _claude_secret("OUTGOING", 2000))
    _write(
        tmp_path / "home" / ".claude.json",
        '{"oauthAccount": {"emailAddress": "out@x.com"}, "theme": "dark"}',
    )
    vault.write_slot(
        "claude", "acct1",
        LiveCredentials(
            secret=_claude_secret("INCOMING", 1000),
            account={"emailAddress": "in@x.com"},
        ),
    )

    vault.restore("claude", "acct1")

    assert _claude_live_file(tmp_path).read_text(encoding="utf-8") == \
        _claude_secret("INCOMING", 1000)
    assert _oauth_account(tmp_path) == {"emailAddress": "in@x.com"}


def test_restore_empty_default_slot_still_clears_live(tmp_path: Path) -> None:
    """Logged-out semantics: an empty __default__ slot clears the live
    credentials and the account display, however fresh the live secret is."""
    vault = _file_vault(tmp_path)
    _write(_claude_live_file(tmp_path), _claude_secret("LIVE", 2000))
    _write(
        tmp_path / "home" / ".claude.json",
        '{"oauthAccount": {"emailAddress": "acct1@x.com"}, "theme": "dark"}',
    )

    vault.restore("claude", DEFAULT_SLOT_ID)

    assert not _claude_live_file(tmp_path).exists()
    assert _oauth_account(tmp_path) is None
    config = json.loads((tmp_path / "home" / ".claude.json").read_text(encoding="utf-8"))
    assert config["theme"] == "dark"


def test_claude_switch_rollback_restores_live_secret(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed restore writes the captured outgoing state (secret + display
    account) back to the live location — same rollback as every other agent."""
    vault = _file_vault(tmp_path)
    live = _claude_live_file(tmp_path)
    _write(live, "ACCT1-TOKEN")
    _write(
        tmp_path / "home" / ".claude.json",
        '{"oauthAccount": {"emailAddress": "acct1@x.com"}}',
    )

    def boom(agent_key: str, slot_id: str) -> None:
        raise RuntimeError("disk full")

    monkeypatch.setattr(vault, "restore", boom)
    with pytest.raises(CredentialVaultError):
        vault.switch("claude", "acct1", DEFAULT_SLOT_ID)

    assert live.read_text(encoding="utf-8") == "ACCT1-TOKEN"
    assert vault.read_slot("claude", "acct1").secret == "ACCT1-TOKEN"
    config = json.loads((tmp_path / "home" / ".claude.json").read_text(encoding="utf-8"))
    assert config["oauthAccount"] == {"emailAddress": "acct1@x.com"}


# ── atomic writes ───────────────────────────────────────────────────────────


def test_claude_config_write_failure_preserves_original(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`~/.claude.json` is the user's whole Claude config: a failed publish
    (os.replace raising, e.g. disk full) must leave the original intact and
    no tmp file behind — content goes to a tmp file first, never in place."""
    vault = _file_vault(tmp_path)
    config = tmp_path / "home" / ".claude.json"
    original = json.dumps({"oauthAccount": {"emailAddress": "a@x.com"}, "theme": "dark"})
    _write(config, original)

    def boom(src: object, dst: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(CredentialVaultError):
        vault.write_live(
            "claude", LiveCredentials(secret=None, account={"emailAddress": "b@x.com"})
        )

    assert config.read_text(encoding="utf-8") == original
    assert not config.with_name(config.name + ".tmp").exists()


def test_atomic_writes_leave_no_tmp_and_keep_slot_private(tmp_path: Path) -> None:
    """Normal writes publish atomically: no `.tmp` remnants anywhere, and slot
    secret files still end up 0600."""
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".codex" / "auth.json", '{"who": "A"}')
    _write(tmp_path / "home" / ".claude.json", '{"theme": "dark"}')

    vault.capture("codex", "slot1")
    vault.write_live(
        "claude",
        LiveCredentials(secret='{"claudeAiOauth": {}}', account={"emailAddress": "a@x.com"}),
    )

    slot_file = vault.slot_dir("codex", "slot1") / "auth.json"
    if osplat.paths.enforces_posix_modes():  # NTFS has no mode bits
        assert stat.S_IMODE(os.stat(slot_file).st_mode) == 0o600
    assert list((tmp_path / "home").rglob("*.tmp")) == []
    assert list((tmp_path / "root").rglob("*.tmp")) == []


# ── macOS Keychain backend (fake `security` runner) ─────────────────────────


def test_mac_switch_moves_secret_between_keychain_services(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    sec.items["Claude Code-credentials"] = '{"claudeAiOauth": {"accessToken": "A"}}'

    vault.switch("claude", DEFAULT_SLOT_ID, "acct1")

    # Old login snapshotted into the backend-owned slot item; the live item is
    # cleared (acct1 has no credentials yet, so the CLI prompts a login).
    assert sec.items["Navide CLI account claude-__default__"] == \
        '{"claudeAiOauth": {"accessToken": "A"}}'
    assert "Claude Code-credentials" not in sec.items

    # Switching back restores the live item from the slot.
    vault.switch("claude", "acct1", DEFAULT_SLOT_ID)
    assert sec.items["Claude Code-credentials"] == \
        '{"claudeAiOauth": {"accessToken": "A"}}'


def test_mac_keychain_write_command_assembly(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    vault.write_slot("claude", "acct1", LiveCredentials(secret="SECRET"))

    # Writes go through `security -i` with the command on stdin: the secret
    # must never appear in the argv, where the process table leaks it.
    assert all("SECRET" not in " ".join(call) for call in sec.calls)
    assert len(sec.stdin_commands) == 1
    tokens = shlex.split(sec.stdin_commands[0].strip())
    assert tokens[0] == "add-generic-password"
    assert "-U" in tokens  # update-in-place, never a duplicate item
    assert tokens[tokens.index("-s") + 1] == "Navide CLI account claude-acct1"
    assert tokens[tokens.index("-w") + 1] == "SECRET"
    assert sec.items["Navide CLI account claude-acct1"] == "SECRET"


def test_mac_clear_live_deletes_keychain_and_file(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    sec.items["Claude Code-credentials"] = "S"
    _write(tmp_path / "home" / ".claude" / ".credentials.json", "S")
    _write(tmp_path / "home" / ".claude.json", '{"oauthAccount": {"e": 1}}')

    vault.clear_live("claude")

    assert "Claude Code-credentials" not in sec.items
    assert not (tmp_path / "home" / ".claude" / ".credentials.json").exists()
    config = json.loads((tmp_path / "home" / ".claude.json").read_text(encoding="utf-8"))
    assert "oauthAccount" not in config


def test_mac_non_claude_agents_use_files_not_keychain(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    _write(tmp_path / "home" / ".codex" / "auth.json", "{}")

    vault.capture("codex", "slot1")

    assert sec.calls == []
    assert (vault.slot_dir("codex", "slot1") / "auth.json").exists()


def test_mac_harvest_legacy_claude_home(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    legacy_home = tmp_path / "legacy" / "37a6f4f2"
    _write(legacy_home / ".claude.json", '{"oauthAccount": {"emailAddress": "old@x.com"}}')
    sec.items[legacy_claude_keychain_service(legacy_home)] = "LEGACY-SECRET"

    assert vault.harvest_legacy_claude_home("37a6f4f2", legacy_home) is True

    slot = vault.read_slot("claude", "37a6f4f2")
    assert slot.secret == "LEGACY-SECRET"
    assert slot.account == {"emailAddress": "old@x.com"}
    # The legacy Keychain item is cleaned up once the slot owns the secret.
    assert legacy_claude_keychain_service(legacy_home) not in sec.items


def test_mac_harvest_legacy_home_without_credentials(tmp_path: Path) -> None:
    vault, _sec = _mac_vault(tmp_path)
    legacy_home = tmp_path / "legacy" / "4ad13e88"
    legacy_home.mkdir(parents=True)

    assert vault.harvest_legacy_claude_home("4ad13e88", legacy_home) is False
    assert vault.slot_is_empty("claude", "4ad13e88")


def test_mac_harvest_legacy_home_with_wiped_credentials(tmp_path: Path) -> None:
    """A home Claude Code wiped counts as having no credentials: the slot keeps
    its own, and the home is reported as not captured so the caller leaves it
    (and its Keychain item) in place."""
    vault, sec = _mac_vault(tmp_path)
    legacy_home = tmp_path / "legacy" / "5be24f99"
    _write(legacy_home / ".claude.json", '{"oauthAccount": {"emailAddress": "old@x.com"}}')
    service = legacy_claude_keychain_service(legacy_home)
    sec.items[service] = _WIPED
    vault.write_slot("claude", "5be24f99", LiveCredentials(secret=_LIVE_TOKENS))

    assert vault.harvest_legacy_claude_home("5be24f99", legacy_home) is False

    assert vault.read_slot("claude", "5be24f99").secret == _LIVE_TOKENS
    assert sec.items[service] == _WIPED


def test_mac_write_slot_never_puts_a_wiped_credential_in_the_keychain(
    tmp_path: Path,
) -> None:
    vault, sec = _mac_vault(tmp_path)
    slot_service = "Navide CLI account claude-acct1"
    sec.items[slot_service] = _LIVE_TOKENS

    vault.write_slot("claude", "acct1", LiveCredentials(secret=_WIPED))

    assert sec.items[slot_service] == _LIVE_TOKENS


def test_resolve_claude_credentials_ignores_legacy_profile_home(tmp_path: Path) -> None:
    """A token left in a legacy profile home no longer shadows anything:
    resolution is strictly active → live, parked → slot."""
    vault = _file_vault(tmp_path)
    vault.write_slot("claude", "acct1", LiveCredentials(secret="SLOT"))
    _write(vault.profile_home_path("claude", "acct1") / ".credentials.json", "RUNTIME")

    assert vault.resolve_claude_credentials("acct1", active=False).secret == "SLOT"


def test_resolve_claude_credentials_active_reads_live(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".claude" / ".credentials.json", "LIVE")
    _write(
        tmp_path / "home" / ".claude.json",
        '{"oauthAccount": {"emailAddress": "live@example.com"}}',
    )

    resolved = vault.resolve_claude_credentials("acct1", active=True)

    assert resolved.secret == "LIVE"
    assert resolved.account == {"emailAddress": "live@example.com"}


def test_resolve_claude_credentials_parked_reads_slot_without_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = _file_vault(tmp_path)
    vault.write_slot("claude", "acct1", LiveCredentials(secret="SLOT"))

    def forbidden(*_args, **_kwargs):
        raise AssertionError("credential resolver attempted a mutation")

    for name in ("capture", "restore", "switch", "write_live", "write_slot"):
        monkeypatch.setattr(vault, name, forbidden)

    resolved = vault.resolve_claude_credentials("acct1", active=False)

    assert resolved.secret == "SLOT"


# ── isolated login homes ────────────────────────────────────────────────────


@pytest.mark.parametrize("agent_key,secret_rel", [
    ("codex", "auth.json"),
    ("kimi", "credentials/kimi-code.json"),
    ("grok", "home/.grok/auth.json"),
])
def test_harvest_login_home_captures_and_removes(
    tmp_path: Path, agent_key: str, secret_rel: str
) -> None:
    vault = _file_vault(tmp_path)
    home = vault.login_home_path(agent_key, "slot1")
    _write(home / secret_rel, '{"who": "fresh-login"}')

    assert vault.harvest_login_home(agent_key, "slot1") is True
    assert vault.read_slot(agent_key, "slot1").secret == '{"who": "fresh-login"}'
    assert not home.exists()


def test_harvest_login_home_overwrites_existing_slot(tmp_path: Path) -> None:
    """The user just re-logged this account — the login home wins over
    whatever secret the slot already held."""
    vault = _file_vault(tmp_path)
    vault.write_slot("codex", "slot1", LiveCredentials(secret='{"who": "old"}'))
    home = vault.login_home_path("codex", "slot1")
    _write(home / "auth.json", '{"who": "new"}')

    assert vault.harvest_login_home("codex", "slot1") is True
    assert vault.read_slot("codex", "slot1").secret == '{"who": "new"}'
    assert not home.exists()


def test_harvest_login_home_without_secret_is_noop(tmp_path: Path) -> None:
    """A login still in progress (home exists, no secret yet) keeps both the
    slot and the login home untouched for a later poll."""
    vault = _file_vault(tmp_path)
    vault.write_slot("codex", "slot1", LiveCredentials(secret='{"who": "kept"}'))
    home = vault.login_home_path("codex", "slot1")
    home.mkdir(parents=True)

    assert vault.harvest_login_home("codex", "slot1") is False
    assert vault.read_slot("codex", "slot1").secret == '{"who": "kept"}'
    assert home.exists()


def test_harvest_login_home_missing_dir_is_noop(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    assert vault.harvest_login_home("claude", "slot1") is False
    assert vault.slot_is_empty("claude", "slot1")


@pytest.mark.parametrize("agent_key,secret_rel", [
    ("codex", "auth.json"),
    ("kimi", "credentials/kimi-code.json"),
    ("grok", "home/.grok/auth.json"),
])
def test_login_secret_present_file_agents(
    tmp_path: Path, agent_key: str, secret_rel: str
) -> None:
    vault = _file_vault(tmp_path)
    assert vault.login_secret_present(agent_key, "slot1") is False
    _write(vault.login_home_path(agent_key, "slot1") / secret_rel, "{}")
    assert vault.login_secret_present(agent_key, "slot1") is True


def test_login_secret_present_claude_never_peeks(tmp_path: Path) -> None:
    # claude's secret lives in the Keychain (no cheap peek); its sign-in
    # command exits on completion, so the peek always reports False.
    vault = _file_vault(tmp_path)
    vault.login_home_path("claude", "slot1").mkdir(parents=True)
    assert vault.login_secret_present("claude", "slot1") is False


def test_mac_harvest_login_home_claude(tmp_path: Path) -> None:
    """Claude login homes mirror legacy CLAUDE_CONFIG_DIR homes: secret in the
    path-hashed Keychain item (deleted after capture), display account in the
    home's own .claude.json."""
    vault, sec = _mac_vault(tmp_path)
    home = vault.login_home_path("claude", "slot1")
    home.mkdir(parents=True)
    sec.items[legacy_claude_keychain_service(home)] = "FRESH-SECRET"
    _write(home / ".claude.json", '{"oauthAccount": {"emailAddress": "new@x.com"}}')

    assert vault.harvest_login_home("claude", "slot1") is True

    slot = vault.read_slot("claude", "slot1")
    assert slot.secret == "FRESH-SECRET"
    assert slot.account == {"emailAddress": "new@x.com"}
    assert legacy_claude_keychain_service(home) not in sec.items
    assert not home.exists()


def test_mac_harvest_login_home_drops_obsolete_profile_home_copy(tmp_path: Path) -> None:
    """A re-login must win. A legacy profile-home copy whose expiresAt
    outlives the new login's (e.g. a revoked long-lived token) would win the
    startup promotion and shadow the fresh login, so harvest drops that copy;
    a copy that is NOT fresher than the new login stays in place (still-running
    legacy panes keep using it, and the promotion prefers the newer slot)."""
    def secret(expires_at: int, token: str) -> str:
        return json.dumps(
            {"claudeAiOauth": {"accessToken": token, "expiresAt": expires_at}}
        )

    vault, sec = _mac_vault(tmp_path)
    profile_home = vault.profile_home_path("claude", "slot1")
    profile_service = legacy_claude_keychain_service(profile_home)

    # Case 1: obsolete-but-far-future home copy → dropped after the harvest.
    sec.items[profile_service] = secret(9_999, "obsolete-long-lived")
    login_home = vault.login_home_path("claude", "slot1")
    login_home.mkdir(parents=True)
    sec.items[legacy_claude_keychain_service(login_home)] = secret(5_000, "fresh-login")
    assert vault.harvest_login_home("claude", "slot1") is True
    assert profile_service not in sec.items
    assert vault.read_slot("claude", "slot1").secret == secret(5_000, "fresh-login")

    # Case 2: home copy older than the new login → left for running panes.
    sec.items[profile_service] = secret(5_000, "older-copy")
    login_home.mkdir(parents=True)
    sec.items[legacy_claude_keychain_service(login_home)] = secret(8_000, "newer-login")
    assert vault.harvest_login_home("claude", "slot1") is True
    assert sec.items[profile_service] == secret(5_000, "older-copy")
    assert vault.read_slot("claude", "slot1").secret == secret(8_000, "newer-login")


def test_login_spawn_env_per_agent(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)

    env_set, env_remove = vault.login_spawn_env("claude", "slot1")
    home = vault.login_home_path("claude", "slot1")
    assert env_set == {"CLAUDE_CONFIG_DIR": str(home)}
    assert env_remove == ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
    # The home will hold fresh secrets — private regardless of umask.
    if osplat.paths.enforces_posix_modes():  # NTFS has no mode bits
        assert stat.S_IMODE(os.stat(home).st_mode) == 0o700

    assert vault.login_spawn_env("codex", "s1") == (
        {"CODEX_HOME": str(vault.login_home_path("codex", "s1"))}, []
    )
    assert vault.login_spawn_env("kimi", "s1") == (
        {"KIMI_CODE_HOME": str(vault.login_home_path("kimi", "s1"))}, []
    )


def test_login_spawn_env_grok_builds_home_shim(tmp_path: Path) -> None:
    """Grok isolates via a HOME shim: real .grok dir inside the login home,
    every other real-home entry symlinked so shell config still applies."""
    vault = _file_vault(tmp_path)
    real_home = tmp_path / "home"
    _write(real_home / ".zshrc", "export X=1")

    env_set, env_remove = vault.login_spawn_env("grok", "slot1")

    shim = vault.login_home_path("grok", "slot1") / "home"
    assert env_set == {"HOME": str(shim)}
    assert env_remove == []
    assert (shim / ".grok").is_dir() and not (shim / ".grok").is_symlink()
    assert (shim / ".zshrc").is_symlink()
    assert (shim / ".zshrc").resolve() == (real_home / ".zshrc").resolve()


# ── slot secret cleanup on profile deletion ─────────────────────────────────


def test_mac_delete_slot_secrets_removes_keychain_and_account_file(tmp_path: Path) -> None:
    """Deleting a claude profile removes its backend-owned slot Keychain item
    and the display-only oauth-account.json — the store only archives files,
    so the Keychain token would otherwise be stranded forever."""
    vault, sec = _mac_vault(tmp_path)
    vault.write_slot(
        "claude", "acct1",
        LiveCredentials(secret="S", account={"emailAddress": "a@x.com"}),
    )
    assert "Navide CLI account claude-acct1" in sec.items
    account_file = vault.slot_dir("claude", "acct1") / "oauth-account.json"
    assert account_file.exists()

    vault.delete_slot_secrets("claude", "acct1")

    assert "Navide CLI account claude-acct1" not in sec.items
    assert not account_file.exists()
    # Idempotent — a second call is a no-op, never an error.
    vault.delete_slot_secrets("claude", "acct1")


def test_mac_delete_slot_secrets_removes_login_home_and_its_keychain(
    tmp_path: Path,
) -> None:
    """A pending claude login home goes with the deleted profile, including
    the login home's path-hashed Keychain item."""
    vault, sec = _mac_vault(tmp_path)
    home = vault.login_home_path("claude", "acct1")
    home.mkdir(parents=True)
    sec.items[legacy_claude_keychain_service(home)] = "PENDING-SECRET"

    vault.delete_slot_secrets("claude", "acct1")

    assert not home.exists()
    assert legacy_claude_keychain_service(home) not in sec.items


def test_delete_slot_secrets_non_claude_keeps_slot_files(tmp_path: Path) -> None:
    """File-based agents keep their slot secret inside the slot dir (archived
    by the store's rename); only a leftover login home is removed."""
    vault = _file_vault(tmp_path)
    vault.write_slot("codex", "acct1", LiveCredentials(secret='{"who": "A"}'))
    home = vault.login_home_path("codex", "acct1")
    home.mkdir(parents=True)

    vault.delete_slot_secrets("codex", "acct1")

    assert not home.exists()
    assert (vault.slot_dir("codex", "acct1") / "auth.json").exists()


# ── stale login-home protection ─────────────────────────────────────────────


def test_harvest_login_home_stale_discarded(tmp_path: Path) -> None:
    """A login home OLDER than the slot's signed-in credential (e.g. found by
    the startup sweep long after a later re-login) is discarded, never
    harvested over the newer secret."""
    vault = _file_vault(tmp_path)
    home = vault.login_home_path("codex", "slot1")
    _write(home / "auth.json", '{"who": "stale"}')
    vault.write_slot("codex", "slot1", LiveCredentials(secret='{"who": "newer"}'))
    slot_file = vault.slot_dir("codex", "slot1") / "auth.json"
    os.utime(home / "auth.json", (slot_file.stat().st_mtime - 100,) * 2)

    assert vault.harvest_login_home("codex", "slot1") is False
    assert vault.read_slot("codex", "slot1").secret == '{"who": "newer"}'
    assert not home.exists()


def test_harvest_login_home_newer_than_slot_overwrites(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    vault.write_slot("codex", "slot1", LiveCredentials(secret='{"who": "old"}'))
    home = vault.login_home_path("codex", "slot1")
    _write(home / "auth.json", '{"who": "fresh"}')
    slot_file = vault.slot_dir("codex", "slot1") / "auth.json"
    os.utime(home / "auth.json", (slot_file.stat().st_mtime + 100,) * 2)

    assert vault.harvest_login_home("codex", "slot1") is True
    assert vault.read_slot("codex", "slot1").secret == '{"who": "fresh"}'
    assert not home.exists()


def test_mac_harvest_login_home_stale_claude_uses_dir_mtime(tmp_path: Path) -> None:
    """claude's Keychain entries carry no mtime: the login home dir stands in
    for the home's secret, the slot's oauth-account.json for the slot's. A
    stale home is discarded together with its path-hashed Keychain item."""
    vault, sec = _mac_vault(tmp_path)
    home = vault.login_home_path("claude", "slot1")
    home.mkdir(parents=True)
    sec.items[legacy_claude_keychain_service(home)] = "STALE-SECRET"
    vault.write_slot(
        "claude", "slot1",
        LiveCredentials(secret="NEWER", account={"emailAddress": "n@x.com"}),
    )
    account_file = vault.slot_dir("claude", "slot1") / "oauth-account.json"
    os.utime(home, (account_file.stat().st_mtime - 100,) * 2)

    assert vault.harvest_login_home("claude", "slot1") is False
    assert vault.read_slot("claude", "slot1").secret == "NEWER"
    assert not home.exists()
    assert legacy_claude_keychain_service(home) not in sec.items


def test_harvest_login_home_missing_mtime_keeps_overwrite(tmp_path: Path) -> None:
    """Conservative fallback: without a comparable slot mtime (claude slot
    lacking oauth-account.json) the normal overwrite behavior stays."""
    vault = _file_vault(tmp_path)
    vault.write_slot("claude", "slot1", LiveCredentials(secret="OLD"))
    home = vault.login_home_path("claude", "slot1")
    _write(home / ".credentials.json", "FRESH")

    assert vault.harvest_login_home("claude", "slot1") is True
    assert vault.read_slot("claude", "slot1").secret == "FRESH"


# ── display identities (signedIn = an actual credential secret exists) ──────


def _jwt(payload: dict) -> str:
    import base64

    seg = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    return f"header.{seg}.signature"


def test_identity_claude_live_and_slot(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".claude.json",
           '{"oauthAccount": {"emailAddress": "live@x.com"}}')
    vault.write_slot("claude", "slot1",
                     LiveCredentials(secret="s", account={"emailAddress": "slot@x.com"}))

    # An oauthAccount left behind without a credential secret is not a login.
    assert vault.identity("claude") == {"email": "live@x.com", "signedIn": False}
    _write(tmp_path / "home" / ".claude" / ".credentials.json", '{"tok": 1}')
    assert vault.identity("claude") == {"email": "live@x.com", "signedIn": True}
    assert vault.identity("claude", "slot1") == {"email": "slot@x.com", "signedIn": True}
    assert vault.identity("claude", "missing") == {"email": None, "signedIn": False}


def test_identity_claude_wiped_credential_is_not_a_login(tmp_path: Path) -> None:
    """A credential Claude Code emptied in place (``invalid_grant``) keeps its
    claudeAiOauth wrapper but carries no token. Reporting it as signed in tells
    the user an account works when nothing can authenticate with it. write_slot
    refuses to create such a slot, but one written before that guard existed
    still reads back, so the display side has to judge it too."""
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".claude.json",
           '{"oauthAccount": {"emailAddress": "live@x.com"}}')
    _write(tmp_path / "home" / ".claude" / ".credentials.json", _WIPED)
    _write(vault.slot_dir("claude", "slot1") / ".credentials.json", _WIPED)

    assert vault.identity("claude") == {"email": "live@x.com", "signedIn": False}
    assert vault.identity("claude", "slot1") == {"email": None, "signedIn": False}


def test_mac_identity_claude_signed_in_reflects_secret(tmp_path: Path) -> None:
    """signedIn comes from the actual credential secret (Keychain item);
    the oauthAccount email is display-only. A long-lived-token login carries
    no oauthAccount but is still signed in; an oauthAccount without a secret
    is not."""
    vault, sec = _mac_vault(tmp_path)

    sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE] = "SECRET"
    assert vault.identity("claude") == {"email": None, "signedIn": True}

    del sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE]
    _write(tmp_path / "home" / ".claude.json",
           '{"oauthAccount": {"emailAddress": "live@x.com"}}')
    assert vault.identity("claude") == {"email": "live@x.com", "signedIn": False}

    # Slots: secret lives in the slot's own Keychain item.
    vault.write_slot("claude", "slot1", LiveCredentials(secret="S2"))
    assert vault.identity("claude", "slot1") == {"email": None, "signedIn": True}


def test_identity_codex_email_from_id_token(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".codex" / "auth.json", json.dumps({
        "tokens": {"access_token": "t", "id_token": _jwt({"email": "codex@x.com"})},
    }))

    assert vault.identity("codex") == {"email": "codex@x.com", "signedIn": True}


def test_identity_codex_api_key_has_no_email(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".codex" / "auth.json", '{"OPENAI_API_KEY": "sk-x"}')

    assert vault.identity("codex") == {"email": None, "signedIn": True}


def test_identity_grok_email_from_auth_entry(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".grok" / "auth.json", json.dumps({
        "https://auth.x.ai::scope": {"key": "k", "email": "grok@x.com"},
    }))

    assert vault.identity("grok") == {"email": "grok@x.com", "signedIn": True}


def test_identity_kimi_signed_in_without_email(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".kimi-code" / "credentials" / "kimi-code.json",
           '{"access_token": "t", "expires_at": 9999999999}')

    assert vault.identity("kimi") == {"email": None, "signedIn": True}


@pytest.mark.parametrize("entry", [
    {"type": "api", "key": "kilo_abc"},
    {"type": "oauth", "access": "kilo-at", "accountId": "org-1"},
])
def test_identity_kilo_signed_in_without_email(tmp_path: Path, entry: dict) -> None:
    """Both credential forms count as signed in, and neither names the user:
    kilo's auth.json has no email, and ``accountId`` is the organization."""
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".local" / "share" / "kilo" / "auth.json",
           json.dumps({"kilo": entry}))

    assert vault.identity("kilo") == {"email": None, "signedIn": True}


@pytest.mark.parametrize("payload", [
    "{not json",
    '{"kilo": {"type": "api", "key": ""}}',
    '{"kilo": {"type": "oauth"}}',
    '{"other": {"type": "api", "key": "k"}}',
])
def test_identity_kilo_unusable_secret_is_signed_out(
    tmp_path: Path, payload: str
) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".local" / "share" / "kilo" / "auth.json", payload)

    assert vault.identity("kilo") == {"email": None, "signedIn": False}


def test_identity_kilo_slot_snapshot_and_missing_file(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    assert vault.identity("kilo") == {"email": None, "signedIn": False}

    vault.write_slot("kilo", "slot1", LiveCredentials(
        secret=json.dumps({"kilo": {"type": "api", "key": "k"}})))

    assert vault.identity("kilo", "slot1") == {"email": None, "signedIn": True}
    assert vault.identity("kilo", "missing") == {"email": None, "signedIn": False}


def test_kilo_switch_swaps_only_the_kilo_entry(tmp_path: Path) -> None:
    """kilo's auth.json is a provider map. A switch rewrites the "kilo" entry
    and nothing else: the user's other provider keys stay byte-for-byte the
    same values, and the outgoing entry lands in the default slot."""
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / ".local" / "share" / "kilo" / "auth.json"
    _write(live, json.dumps({
        "kilo": {"type": "api", "key": "A"},
        "anthropic": {"type": "oauth", "access": "keep-me", "refresh": "r"},
    }))
    vault.write_slot("kilo", "b", LiveCredentials(secret='{"type": "api", "key": "B"}'))

    vault.switch("kilo", DEFAULT_SLOT_ID, "b")

    after = json.loads(live.read_text(encoding="utf-8"))
    assert after["kilo"] == {"type": "api", "key": "B"}
    assert after["anthropic"] == {"type": "oauth", "access": "keep-me", "refresh": "r"}
    assert json.loads(vault.read_slot("kilo", DEFAULT_SLOT_ID).secret) == {
        "type": "api", "key": "A",
    }
    # The parked document has the vendor's own shape, keyed by scope, and
    # carries nothing but the kilo entry.
    parked = json.loads(
        osplat.secret_files.read_private(vault.slot_dir("kilo", DEFAULT_SLOT_ID) / "auth.json").decode("utf-8")
    )
    assert parked == {"kilo": {"type": "api", "key": "A"}}


def test_kilo_legacy_whole_file_slot_still_restores(tmp_path: Path) -> None:
    """Slots parked before the per-provider split hold the whole auth.json;
    its "kilo" entry is what a restore now publishes, and any other provider
    that was parked with it stays parked (never pushed over the live one)."""
    vault = _file_vault(tmp_path)
    live = tmp_path / "home" / ".local" / "share" / "kilo" / "auth.json"
    _write(live, '{"kilo": {"type": "api", "key": "A"}, "google": {"type": "api", "key": "G"}}')
    slot_file = vault.slot_dir("kilo", "b") / "auth.json"
    slot_file.parent.mkdir(parents=True)
    slot_file.write_text(
        '{"kilo": {"type": "oauth", "access": "B"}, "google": {"type": "api", "key": "OLD"}}',
        encoding="utf-8",
    )

    vault.switch("kilo", DEFAULT_SLOT_ID, "b")

    after = json.loads(live.read_text(encoding="utf-8"))
    assert after == {"kilo": {"type": "oauth", "access": "B"}, "google": {"type": "api", "key": "G"}}
    assert vault.identity("kilo", "b") == {"email": None, "signedIn": True}


def test_kilo_switch_uses_xdg_live_credentials(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    vault = _file_vault(tmp_path)
    live = tmp_path / "xdg" / "kilo" / "auth.json"
    fallback = tmp_path / "home" / ".local" / "share" / "kilo" / "auth.json"
    _write(live, '{"kilo": {"type": "api", "key": "A"}}')
    _write(fallback, "unrelated fallback credentials")
    vault.write_slot("kilo", "b", LiveCredentials(secret='{"type": "api", "key": "B"}'))

    vault.switch("kilo", DEFAULT_SLOT_ID, "b")

    assert json.loads(live.read_text(encoding="utf-8")) == {"kilo": {"type": "api", "key": "B"}}
    assert json.loads(vault.read_slot("kilo", DEFAULT_SLOT_ID).secret) == {"type": "api", "key": "A"}
    assert fallback.read_text(encoding="utf-8") == "unrelated fallback credentials"


def test_kilo_rejects_a_foreign_scope(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    with pytest.raises(CredentialVaultError):
        vault.read_live("kilo", scope="anthropic")
    # Whole-file vendors take no scope at all.
    with pytest.raises(CredentialVaultError):
        vault.read_live("codex", scope="kilo")


def test_login_spawn_env_kilo_has_no_isolation(tmp_path: Path) -> None:
    """kilo has no config-home variable, so its sign-in runs against the real
    home: no env override and — just as important — no login home directory,
    whose existence alone would send the switch handler and the usage poller
    into a harvest that has no secret file to read."""
    vault = _file_vault(tmp_path)

    assert vault.login_spawn_env("kilo", "slot1") == ({}, [])
    assert not vault.login_home_path("kilo", "slot1").exists()


def test_identity_logged_out_and_garbage_never_raise(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(tmp_path / "home" / ".codex" / "auth.json", "not json")

    assert vault.identity("codex") == {"email": None, "signedIn": False}
    assert vault.identity("grok") == {"email": None, "signedIn": False}
    assert vault.identity("kimi", "slot1") == {"email": None, "signedIn": False}


def test_keychain_write_failure_surfaces_security_error(tmp_path: Path) -> None:
    """The raised error carries the last line of the `security` output so the
    log shows WHY the write failed, never just the exit code — and never the
    secret (the detail is a single truncated line)."""
    vault = CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (
            36, "security: The specified item already exists."
        ),
        platform="darwin",
    )
    with pytest.raises(CredentialVaultError, match="item already exists"):
        vault.write_live("claude", LiveCredentials(secret='{"t": 1}'))


def test_login_spawn_env_grok_migrates_legacy_db(tmp_path: Path) -> None:
    """A real grok.db left in the login shim (written under the old whole-home
    isolation) is moved back to ~/.grok, then shared via symlink."""
    vault = _file_vault(tmp_path)
    shim = vault.login_home_path("grok", "slot1") / "home"
    _write(shim / ".grok" / "grok.db", "DBDATA")

    vault.login_spawn_env("grok", "slot1")

    assert (tmp_path / "home" / ".grok" / "grok.db").read_text(encoding="utf-8") == "DBDATA"
    assert (shim / ".grok" / "grok.db").is_symlink()


# ── one-time promotion of legacy profile-home credentials ───────────────────


class _FakeStore:
    """Minimal stand-in for CliProfilesStore.list()."""

    def __init__(self, profiles: list[dict], defaults: dict) -> None:
        self._doc = {"profiles": profiles, "defaults": defaults}

    def list(self) -> dict:
        return self._doc


@pytest.mark.parametrize("agent_key,home_rel", [
    ("codex", "auth.json"),
    ("kimi", "credentials/kimi-code.json"),
    ("grok", ".grok/auth.json"),
])
async def test_promote_fills_empty_slot_from_profile_home(
    tmp_path: Path, agent_key: str, home_rel: str
) -> None:
    vault = _file_vault(tmp_path)
    home = vault.profile_home_path(agent_key, "acct1")
    _write(home / home_rel, '{"who": "home"}')
    store = _FakeStore([{"id": "acct1", "agentKey": agent_key}], {agent_key: None})

    await vault.promote_profile_home_secrets(store)

    assert vault.read_slot(agent_key, "acct1").secret == '{"who": "home"}'
    # Non-destructive: the home copy stays for still-running legacy panes.
    assert (home / home_rel).read_text(encoding="utf-8") == '{"who": "home"}'


async def test_promote_never_overwrites_occupied_non_claude_slot(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    home = vault.profile_home_path("codex", "acct1")
    _write(home / "auth.json", '{"who": "home"}')
    vault.write_slot("codex", "acct1", LiveCredentials(secret='{"who": "slot"}'))
    store = _FakeStore([{"id": "acct1", "agentKey": "codex"}], {"codex": None})

    await vault.promote_profile_home_secrets(store)

    assert vault.read_slot("codex", "acct1").secret == '{"who": "slot"}'


async def test_promote_claude_home_wins_unless_slot_strictly_newer(tmp_path: Path) -> None:
    """claude promotion is expiry-compared: the home copy (refreshed in place
    by its running CLI) wins unless the slot is strictly newer (a fresh
    re-login harvest); an unparsable expiry cannot prove freshness and keeps
    the slot. Parked profiles keep their slot's display account."""
    vault = _file_vault(tmp_path)
    _write(
        vault.profile_home_path("claude", "p1") / ".credentials.json",
        _claude_secret("REFRESHED", 2000),
    )
    vault.write_slot("claude", "p1", LiveCredentials(
        secret=_claude_secret("STALE", 1000), account={"emailAddress": "p1@x.com"},
    ))
    _write(
        vault.profile_home_path("claude", "p2") / ".credentials.json",
        _claude_secret("OLD", 1000),
    )
    vault.write_slot("claude", "p2", LiveCredentials(secret=_claude_secret("RELOGIN", 2000)))
    _write(vault.profile_home_path("claude", "p3") / ".credentials.json", "not-json")
    vault.write_slot("claude", "p3", LiveCredentials(secret=_claude_secret("KEPT", 1000)))
    store = _FakeStore(
        [{"id": pid, "agentKey": "claude"} for pid in ("p1", "p2", "p3")],
        {"claude": None},
    )

    await vault.promote_profile_home_secrets(store)

    p1 = vault.read_slot("claude", "p1")
    assert p1.secret == _claude_secret("REFRESHED", 2000)
    assert p1.account == {"emailAddress": "p1@x.com"}
    assert vault.read_slot("claude", "p2").secret == _claude_secret("RELOGIN", 2000)
    assert vault.read_slot("claude", "p3").secret == _claude_secret("KEPT", 1000)
    # Non-destructive: every home copy is still in place.
    assert (
        vault.profile_home_path("claude", "p1") / ".credentials.json"
    ).read_text(encoding="utf-8") == _claude_secret("REFRESHED", 2000)


async def test_promote_never_replaces_a_slot_with_a_wiped_home_credential(
    tmp_path: Path,
) -> None:
    """A profile home whose CLI hit an invalid_grant keeps its expiresAt, so it
    still looks 'fresher' than the slot — promotion must not let that empty the
    account's only surviving refresh token."""
    vault = _file_vault(tmp_path)
    _write(
        vault.profile_home_path("claude", "p1") / ".credentials.json",
        _wiped_claude_secret(2000),
    )
    vault.write_slot("claude", "p1", LiveCredentials(secret=_claude_secret("GOOD", 1000)))
    store = _FakeStore([{"id": "p1", "agentKey": "claude"}], {"claude": None})

    await vault.promote_profile_home_secrets(store)

    assert vault.read_slot("claude", "p1").secret == _claude_secret("GOOD", 1000)


async def test_promote_claude_fills_empty_slot_from_home(tmp_path: Path) -> None:
    vault = _file_vault(tmp_path)
    _write(
        vault.profile_home_path("claude", "acct1") / ".credentials.json",
        _claude_secret("HOME", 1000),
    )
    store = _FakeStore([{"id": "acct1", "agentKey": "claude"}], {"claude": None})

    await vault.promote_profile_home_secrets(store)

    assert vault.read_slot("claude", "acct1").secret == _claude_secret("HOME", 1000)


async def test_mac_promote_claude_reads_path_hashed_keychain(tmp_path: Path) -> None:
    vault, sec = _mac_vault(tmp_path)
    home = vault.profile_home_path("claude", "acct1")
    home.mkdir(parents=True)
    sec.items[legacy_claude_keychain_service(home)] = "HOME-TOKEN"
    store = _FakeStore([{"id": "acct1", "agentKey": "claude"}], {"claude": None})

    await vault.promote_profile_home_secrets(store)

    assert sec.items["Navide CLI account claude-acct1"] == "HOME-TOKEN"
    # Non-destructive: the home's Keychain item survives.
    assert sec.items[legacy_claude_keychain_service(home)] == "HOME-TOKEN"


async def test_promote_unifies_claude_live_with_active_profile(tmp_path: Path) -> None:
    """Legacy state: a managed claude profile is active but the live location
    still holds the default account's token (the old model never swapped
    claude's live secret). The one-shot alignment parks the live secret in
    __default__ — keeping that slot's own display account — and publishes the
    active profile's promoted secret to the live location. Re-running is a
    no-op (marker-guarded): the now-live profile secret must never be parked
    into the default slot."""
    vault = _file_vault(tmp_path)
    _write(_claude_live_file(tmp_path), "DEFAULT-TOKEN")
    _write(
        tmp_path / "home" / ".claude.json",
        '{"oauthAccount": {"emailAddress": "acct1@x.com"}}',
    )
    vault.write_slot("claude", DEFAULT_SLOT_ID, LiveCredentials(
        secret="OLD-DEFAULT-SNAPSHOT", account={"emailAddress": "default@x.com"},
    ))
    _write(vault.profile_home_path("claude", "acct1") / ".credentials.json", "ACCT1-TOKEN")
    store = _FakeStore([{"id": "acct1", "agentKey": "claude"}], {"claude": "acct1"})

    await vault.promote_profile_home_secrets(store)

    assert _claude_live_file(tmp_path).read_text(encoding="utf-8") == "ACCT1-TOKEN"
    assert vault.read_slot("claude", "acct1").secret == "ACCT1-TOKEN"
    default_slot = vault.read_slot("claude", DEFAULT_SLOT_ID)
    assert default_slot.secret == "DEFAULT-TOKEN"
    assert default_slot.account == {"emailAddress": "default@x.com"}
    assert _oauth_account(tmp_path) == {"emailAddress": "acct1@x.com"}

    await vault.promote_profile_home_secrets(store)  # idempotent

    assert _claude_live_file(tmp_path).read_text(encoding="utf-8") == "ACCT1-TOKEN"
    assert vault.read_slot("claude", DEFAULT_SLOT_ID).secret == "DEFAULT-TOKEN"


async def test_promote_restores_active_account_when_live_empty(tmp_path: Path) -> None:
    """An active managed account whose promoted slot has a secret while the
    live location is empty gets restored — the secret may only ever have
    existed in the legacy profile home."""
    vault = _file_vault(tmp_path)
    _write(vault.profile_home_path("codex", "acct1") / "auth.json", '{"who": "acct1"}')
    store = _FakeStore([{"id": "acct1", "agentKey": "codex"}], {"codex": "acct1"})

    await vault.promote_profile_home_secrets(store)

    assert (
        tmp_path / "home" / ".codex" / "auth.json"
    ).read_text(encoding="utf-8") == '{"who": "acct1"}'


async def test_promote_without_homes_is_noop(tmp_path: Path) -> None:
    """No legacy profile homes on disk: nothing is written anywhere."""
    vault = _file_vault(tmp_path)
    store = _FakeStore([{"id": "acct1", "agentKey": "codex"}], {"codex": None})

    await vault.promote_profile_home_secrets(store)

    assert vault.slot_is_empty("codex", "acct1")
    assert not (tmp_path / "home" / ".codex" / "auth.json").exists()


# ── strict Keychain reads (capture paths) ───────────────────────────────────


class _FlakySecurity(FakeSecurity):
    """FakeSecurity whose find calls can fail transiently (locked keychain)."""

    def __init__(self) -> None:
        super().__init__()
        self.fail_find = False

    def __call__(self, args: list[str], input_text: str | None = None) -> tuple[int, str]:
        if self.fail_find and args and args[0] == "find-generic-password":
            return 36, "security: User interaction is not allowed."
        return super().__call__(args, input_text)


def _flaky_mac_vault(tmp_path: Path) -> tuple[CredentialVault, _FlakySecurity]:
    sec = _FlakySecurity()
    vault = CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=sec,
        platform="darwin",
    )
    return vault, sec


def test_capture_treats_keychain_not_found_as_signed_out(tmp_path: Path) -> None:
    """A genuinely missing live item (the security CLI's exit code 44) is a
    legitimate signed-out state: strict capture empties the slot, no raise."""
    vault, sec = _mac_vault(tmp_path)
    vault.write_slot("claude", "p1", LiveCredentials(secret="SNAPSHOT"))

    creds = vault.capture("claude", "p1")

    assert creds.secret is None
    assert vault.read_slot("claude", "p1").secret is None


def test_capture_transient_keychain_failure_raises_slot_untouched(tmp_path: Path) -> None:
    """A locked/denied Keychain is NOT a logout: strict capture raises before
    any slot write, so the parked snapshot survives."""
    vault, sec = _flaky_mac_vault(tmp_path)
    sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE] = "LIVE-TOKEN"
    vault.write_slot("claude", "p1", LiveCredentials(secret="SNAPSHOT"))
    sec.fail_find = True

    with pytest.raises(CredentialVaultError):
        vault.capture("claude", "p1")

    sec.fail_find = False
    assert vault.read_slot("claude", "p1").secret == "SNAPSHOT"


def test_capture_raising_security_runner_raises(tmp_path: Path) -> None:
    """A crashing/timing-out security runner likewise aborts strict capture."""

    def boom(args: list[str], input_text: str | None = None) -> tuple[int, str]:
        raise RuntimeError("security timed out")

    vault = CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=boom,
        platform="darwin",
    )

    with pytest.raises(CredentialVaultError):
        vault.capture("claude", "p1")


def test_switch_aborts_before_any_write_on_keychain_failure(tmp_path: Path) -> None:
    """switch()'s capture happens before any slot or live write: a transient
    Keychain failure aborts with both slots and the live state untouched."""
    vault, sec = _flaky_mac_vault(tmp_path)
    sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE] = "ACCT-A"
    vault.write_slot("claude", "p1", LiveCredentials(secret="ACCT-B"))
    sec.fail_find = True

    with pytest.raises(CredentialVaultError):
        vault.switch("claude", DEFAULT_SLOT_ID, "p1")

    sec.fail_find = False
    assert sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE] == "ACCT-A"
    assert vault.read_slot("claude", "p1").secret == "ACCT-B"
    assert vault.slot_is_empty("claude", DEFAULT_SLOT_ID)


def test_readonly_paths_stay_lax_on_keychain_failure(tmp_path: Path) -> None:
    """Display-only reads must never raise on a transient Keychain failure —
    they just show signed-out until the next poll."""
    vault, sec = _flaky_mac_vault(tmp_path)
    sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE] = "LIVE-TOKEN"
    sec.fail_find = True

    assert vault.identity("claude") == {"email": None, "signedIn": False}
    assert vault.resolve_claude_credentials("p1", active=True).secret is None
    assert vault.read_live("claude").secret is None


# ── live-unification marker only on success ─────────────────────────────────


class _WriteFailSecurity(FakeSecurity):
    """FakeSecurity whose interactive writes (`security -i`) can fail."""

    def __init__(self) -> None:
        super().__init__()
        self.fail_writes = False

    def __call__(self, args: list[str], input_text: str | None = None) -> tuple[int, str]:
        if self.fail_writes and args == ["-i"]:
            return 1, "security: unable to write to keychain"
        return super().__call__(args, input_text)


async def test_unify_failure_writes_no_marker_and_retries(tmp_path: Path) -> None:
    """A failed live unification must NOT write the .live-unified marker:
    the live state still holds the default account's token, so the next
    startup retries; marking it done would freeze the pre-unification state
    and let the next switch park the default token into the profile's slot."""
    sec = _WriteFailSecurity()
    vault = CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=sec,
        platform="darwin",
    )
    sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE] = "DEFAULT-TOKEN"
    sec.items["Navide CLI account claude-acct1"] = "ACCT1-TOKEN"
    store = _FakeStore([{"id": "acct1", "agentKey": "claude"}], {"claude": "acct1"})
    marker = tmp_path / "root" / "claude" / ".live-unified"

    sec.fail_writes = True
    await vault.promote_profile_home_secrets(store)

    assert not marker.exists()
    assert sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE] == "DEFAULT-TOKEN"
    assert "Navide CLI account claude-__default__" not in sec.items

    sec.fail_writes = False
    await vault.promote_profile_home_secrets(store)  # startup retry

    assert marker.exists()
    assert sec.items[CLAUDE_LIVE_KEYCHAIN_SERVICE] == "ACCT1-TOKEN"
    assert sec.items["Navide CLI account claude-__default__"] == "DEFAULT-TOKEN"


# ── one-shot per-agent promotion marker ─────────────────────────────────────


async def test_promotion_is_one_shot_per_agent(tmp_path: Path) -> None:
    """A legacy home copy with a far-future expiresAt must not clobber a
    slot's newer credentials on later startups: after one clean promotion the
    per-agent marker skips the agent entirely."""
    vault = _file_vault(tmp_path)
    _write(
        vault.profile_home_path("claude", "p1") / ".credentials.json",
        _claude_secret("LEGACY", 9999),
    )
    store = _FakeStore([{"id": "p1", "agentKey": "claude"}], {"claude": None})

    await vault.promote_profile_home_secrets(store)

    assert vault.read_slot("claude", "p1").secret == _claude_secret("LEGACY", 9999)
    assert (tmp_path / "root" / "claude" / ".homes-promoted").exists()

    # A fresh re-login stores a newer secret with an earlier expiry; without
    # the marker the far-future home copy would win again on every startup.
    vault.write_slot("claude", "p1", LiveCredentials(secret=_claude_secret("RELOGIN", 1000)))
    await vault.promote_profile_home_secrets(store)

    assert vault.read_slot("claude", "p1").secret == _claude_secret("RELOGIN", 1000)


async def test_promotion_failure_writes_no_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed profile promotion leaves the agent's marker unwritten so the
    next startup retries; the retry then promotes and writes the marker."""
    vault = _file_vault(tmp_path)
    _write(vault.profile_home_path("codex", "p1") / "auth.json", '{"who": "home"}')
    store = _FakeStore([{"id": "p1", "agentKey": "codex"}], {"codex": None})
    marker = tmp_path / "root" / "codex" / ".homes-promoted"
    real_promote = vault._promote_profile_home

    def boom(agent_key: str, profile_id: str, *, active: bool) -> None:
        raise RuntimeError("disk error")

    monkeypatch.setattr(vault, "_promote_profile_home", boom)
    await vault.promote_profile_home_secrets(store)

    assert not marker.exists()
    assert vault.slot_is_empty("codex", "p1")

    monkeypatch.setattr(vault, "_promote_profile_home", real_promote)
    await vault.promote_profile_home_secrets(store)  # startup retry

    assert marker.exists()
    assert vault.read_slot("codex", "p1").secret == '{"who": "home"}'


# ── rewritten claude payloads must survive the Keychain writer ───────────────


def test_write_slot_stores_a_rewritten_claude_secret_on_macos(tmp_path: Path) -> None:
    """A re-login or capture rewrites a slot through write_slot. On macOS that
    goes through `security -i`, which parses one command per line — so the
    payload must stay on a single line. Regression: an indented rewrite stored
    only "{" and destroyed the account's credential."""
    vault, sec = _mac_vault(tmp_path)
    original = json.dumps({
        "claudeAiOauth": {
            "accessToken": "old", "refreshToken": "rt", "expiresAt": 1,
            "scopes": ["user:inference"],
        }
    })
    vault.write_slot("claude", "acct1", LiveCredentials(secret=original))

    rewritten = json.dumps({
        "claudeAiOauth": {
            "accessToken": "new", "refreshToken": "rt", "expiresAt": 2,
            "scopes": ["user:inference"],
        }
    }, separators=(",", ":"))
    vault.write_slot("claude", "acct1", LiveCredentials(secret=rewritten))

    stored = vault.read_slot("claude", "acct1").secret
    assert json.loads(stored)["claudeAiOauth"] == {
        "accessToken": "new", "refreshToken": "rt", "expiresAt": 2,
        "scopes": ["user:inference"],
    }
    assert all("\n" not in cmd.rstrip("\n") for cmd in sec.stdin_commands)


def test_write_slot_rejects_a_multiline_secret_without_touching_the_item(
    tmp_path: Path,
) -> None:
    """A newline must be refused BEFORE the write: `security -i` would store
    the payload up to the first newline and fail on the rest, leaving a
    truncated credential (observed in the wild as an item reduced to "{")."""
    vault, sec = _mac_vault(tmp_path)
    good = json.dumps({"claudeAiOauth": {"accessToken": "keep"}})
    vault.write_slot("claude", "acct1", LiveCredentials(secret=good))
    writes_before = len(sec.stdin_commands)

    indented = json.dumps({"claudeAiOauth": {"accessToken": "a"}}, indent=2)
    with pytest.raises(CredentialVaultError):
        vault.write_slot("claude", "acct1", LiveCredentials(secret=indented))

    assert len(sec.stdin_commands) == writes_before  # never reached `security`
    assert vault.read_slot("claude", "acct1").secret == good


# ---- app secrets are per data directory, in Keychain as well as on disk ------


def test_two_data_directories_do_not_share_one_keychain_secret(tmp_path, monkeypatch):
    """A dev build beside the installed app must not overwrite its secrets.

    These two vaults are built the way production builds one — ``app.py`` says
    ``CredentialVault()`` and passes no root — so the only thing separating them
    is ``AGENT_TEAM_DATA_DIR``, which is exactly what separates a dev backend
    from the installed app.

    The previous version of this test varied the vault's ``root`` instead, and
    it passed for a build where the isolation did not work at all: no caller
    ever passes a root, so both processes computed the same name and the second
    to write took the Keychain item's ACL with it. On 2026-09-05 that locked the
    device trust store closed on this machine — the item was still there, the
    dev backend simply could not read it any more.
    """
    sec = FakeSecurity()

    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "installed"))
    one = CredentialVault(
        real_home=tmp_path / "home", security_runner=sec, platform="darwin"
    )
    one.write_app_secret("navide-server-token", "tok-installed")

    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dev"))
    two = CredentialVault(
        real_home=tmp_path / "home", security_runner=sec, platform="darwin"
    )
    two.write_app_secret("navide-server-token", "tok-dev")

    # Both names are computed at call time, so each vault answers for whichever
    # data directory is current — read them while that directory is set.
    assert two.read_app_secret("navide-server-token") == "tok-dev"
    dev_service = two.app_secret_service("navide-server-token")
    dev_file = two.app_secret_path("navide-server-token")

    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "installed"))
    assert one.read_app_secret("navide-server-token") == "tok-installed"
    assert one.app_secret_service("navide-server-token") != dev_service
    # The file fallback too: isolating only the Keychain would leave the two
    # sharing the file that is read whenever the Keychain has no answer.
    assert one.app_secret_path("navide-server-token") != dev_file


def test_the_default_data_directory_keeps_its_existing_keychain_name(tmp_path, monkeypatch):
    """Suffixing every install would sign each one out exactly once, to fix a
    collision only a second data directory can cause. So the shipped install
    keeps the unsuffixed name, and the discriminator is what a *second* data
    directory gets."""
    from agent_team_backend.applog import default_app_data_dir
    from agent_team_backend.credential_vault import _APP_SECRET_SERVICE_PREFIX

    vault = CredentialVault(
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, ""),
        platform="darwin",
    )

    monkeypatch.delenv("AGENT_TEAM_DATA_DIR", raising=False)
    assert vault.app_secret_service("navide-server-token") == (
        _APP_SECRET_SERVICE_PREFIX + "navide-server-token"
    )
    # Spelling the default path out explicitly is the same answer, so an
    # existing install is not suffixed by having the variable set to where it
    # already points.
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(default_app_data_dir()))
    assert vault.app_secret_service("navide-server-token") == (
        _APP_SECRET_SERVICE_PREFIX + "navide-server-token"
    )

    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "elsewhere"))
    assert vault.app_secret_service("navide-server-token").startswith(
        _APP_SECRET_SERVICE_PREFIX + "navide-server-token@"
    )


def test_the_profiles_root_is_not_what_separates_two_backends(tmp_path, monkeypatch):
    """The mistake that made the previous fix unreachable, pinned so it cannot
    come back: two vaults with different profile roots but one data directory
    are one backend's storage, and must answer with one name."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "one-backend"))
    a = CredentialVault(
        root=tmp_path / "root-a",
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, ""),
        platform="darwin",
    )
    b = CredentialVault(
        root=tmp_path / "root-b",
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, ""),
        platform="darwin",
    )
    assert a.app_secret_service("navide-server-token") == b.app_secret_service(
        "navide-server-token"
    )


def test_a_transient_keychain_failure_is_not_read_as_signed_out(tmp_path, monkeypatch):
    """A locked keychain, a dismissed dialog and a `security` timeout all used
    to come back as None — the same answer as "never stored".

    The two demand opposite responses and cost different amounts to get wrong:
    reading a transient failure as "nothing" sends the caller down a path that
    erases real state, while reading a genuine absence as a failure costs one
    retry. So anything that is not an unambiguous "no such item" raises.
    """
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dd"))
    calls: list[list[str]] = []

    def flaky(args, input_text=None):
        calls.append(args)
        return (51, "User interaction is not allowed.")

    vault = CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=flaky,
        platform="darwin",
    )
    with pytest.raises(CredentialVaultError):
        vault.read_app_secret("navide-device-trust")
    assert calls, "it did ask the keychain"


def test_a_genuine_absence_is_still_just_absent(tmp_path, monkeypatch):
    """The other direction, so the strictness cannot be "raise on everything":
    exit code 44 is the keychain saying the item is not there, and a machine
    that never stored one has to be able to say so."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dd"))
    vault = CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (44, "could not be found"),
        platform="darwin",
    )
    assert vault.read_app_secret("navide-device-trust") is None


def test_a_planted_file_cannot_stand_in_for_the_keychain(tmp_path, monkeypatch):
    """On macOS the file is never *written* — `write_app_secret` deletes it
    after every keychain write, so a leftover cannot shadow the real item. A
    file present on this platform is therefore a leftover from another one or
    something somebody put there, and reading it was the only thing giving it
    any authority. There is no MAC because there is nothing to authenticate:
    the answer is not to read it.
    """
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dd"))
    vault = CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (44, "could not be found"),
        platform="darwin",
    )
    planted = vault.app_secret_path("navide-device-trust")
    planted.parent.mkdir(parents=True, exist_ok=True)
    planted.write_text('{"pins":{"attacker":{"approved":true}}}', encoding="utf-8")

    assert vault.read_app_secret("navide-device-trust") is None


def test_a_platform_without_a_keychain_still_uses_the_file(tmp_path, monkeypatch):
    """The file is not dead code — it is the whole story where there is no
    keychain to prefer over it."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dd"))
    vault = CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, ""),
        platform="linux",
    )
    vault.write_app_secret("navide-server-token", "tok")
    assert vault.read_app_secret("navide-server-token") == "tok"


def test_a_secret_named_with_a_colon_is_stored_on_every_platform(tmp_path, monkeypatch):
    """Windows has no Keychain, so this file IS the secret there — and a
    filename holding a colon opens an NTFS alternate data stream instead of a
    file, failing the write with "the parameter is incorrect".

    `sync_keyring` names the account ring `<prefix>:<namespace>`, so on Windows
    it could not keep a key at all: every test in test_sync_keyring.py errored
    in setup, and a signed-in user would have hit exactly the same write.
    """
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    vault = CredentialVault(
        root=tmp_path / "vault", real_home=tmp_path / "home", platform="linux"
    )
    name = "navide-sync-account-key:https-example-com|m1"

    vault.write_app_secret(name, "ring-json")

    path = vault.app_secret_path(name)
    assert not set(path.name) & set('<>:"/\\|?*'), path.name
    assert path.exists()
    assert vault.read_app_secret(name) == "ring-json"

    vault.write_app_secret(name, None)
    assert vault.read_app_secret(name) is None
    assert not path.exists()


def test_two_secret_names_that_escape_alike_stay_apart(tmp_path, monkeypatch):
    """The escape has to be one-to-one, or two names would share one file and
    the second write would silently take the first one's value."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    vault = CredentialVault(
        root=tmp_path / "vault", real_home=tmp_path / "home", platform="linux"
    )

    vault.write_app_secret("navide-x:y", "colon")
    vault.write_app_secret("navide-x%3Ay", "already-escaped")

    assert vault.read_app_secret("navide-x:y") == "colon"
    assert vault.read_app_secret("navide-x%3Ay") == "already-escaped"


def test_the_fixed_secret_names_keep_the_file_they_already_have(tmp_path, monkeypatch):
    """Escaping must not move a secret that is already stored: every name the
    backend uses is a legal filename, so each one maps to itself."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    vault = CredentialVault(
        root=tmp_path / "vault", real_home=tmp_path / "home", platform="linux"
    )

    for name in (
        "navide-server-token",
        "navide-device-trust",
        "navide-sync-account-key",
        "navide-portable-credential-key",
        "navide-workspace-digest-salt",
    ):
        assert vault.app_secret_path(name).name == name


class PrintingSecurity(FakeSecurity):
    """`security find-generic-password` as it really prints: `-w` gives the
    password verbatim or, when any byte is not printable ASCII, as bare
    lowercase hex; `-g` gives a `password:` line that says which form it is."""

    def __call__(self, args: list[str], input_text: str | None = None) -> tuple[int, str]:
        rc, out = super().__call__(args, input_text)
        if rc == 0 and args[:1] == ["find-generic-password"]:
            secret = self.items[args[args.index("-s") + 1]]
            if "-w" in args:
                return 0, security_w_output(secret)
            if "-g" in args:
                return 0, 'keychain: "/x"\nattributes:\n' + security_g_output(secret)
            return 0, ""
        return rc, out


def test_a_non_ascii_app_secret_survives_the_keychain_round_trip(tmp_path, monkeypatch):
    """The device trust store writes JSON with ``ensure_ascii=False``, and a
    `remote-command` notice records the pane name — on this user's machine a
    Chinese one. `security -w` then hands the document back as hex, which
    parsed as nothing, and every restart locked cross-device traffic with
    "contents are missing or unreadable" over a record that was intact."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dd"))
    sec = PrintingSecurity()
    vault = CredentialVault(
        root=tmp_path / "root", real_home=tmp_path / "home",
        security_runner=sec, platform="darwin",
    )
    doc = json.dumps({"notices": [{"paneName": "建立CLI視窗安排工作"}]},
                     ensure_ascii=False, separators=(",", ":"))
    vault.write_app_secret("navide-device-trust", doc)

    assert vault.read_app_secret("navide-device-trust") == doc


def test_an_app_secret_that_is_a_hex_string_is_not_decoded(tmp_path, monkeypatch):
    """The other direction: `security` prints an all-printable password
    verbatim, so a secret that genuinely is hex must come back unchanged."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dd"))
    sec = PrintingSecurity()
    vault = CredentialVault(
        root=tmp_path / "root", real_home=tmp_path / "home",
        security_runner=sec, platform="darwin",
    )
    for token in ("4142", "deadbeef" * 8):
        vault.write_app_secret("navide-server-token", token)
        assert vault.read_app_secret("navide-server-token") == token


def test_an_app_secret_that_looks_like_hex_is_read_back_exactly(tmp_path, monkeypatch):
    """`-w` hex output and a plaintext secret that is itself lowercase hex are
    indistinguishable: "0a" decodes to a newline, "1f..." to control bytes.
    Any such secret must come back exactly as written."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dd"))
    sec = PrintingSecurity()
    vault = CredentialVault(
        root=tmp_path / "root", real_home=tmp_path / "home",
        security_runner=sec, platform="darwin",
    )
    for token in ("0a", "7b0a7d", "1f" + "61" * 15, "00" * 16):
        vault.write_app_secret("navide-server-token", token)
        assert vault.read_app_secret("navide-server-token") == token


def test_an_app_secret_with_a_backslash_or_quote_is_read_back_exactly(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "dd"))
    sec = PrintingSecurity()
    vault = CredentialVault(
        root=tmp_path / "root", real_home=tmp_path / "home",
        security_runner=sec, platform="darwin",
    )
    for token in ('{"a":"b\\"}', 'x"y', "tab\there"):
        vault.write_app_secret("navide-server-token", token)
        assert vault.read_app_secret("navide-server-token") == token


# ── Startup repair of the live login (security review D2/D2b) ────────────────

_REPAIR_SEC_A = '{"claudeAiOauth":{"accessToken":"tokA","refreshToken":"rA","expiresAt":9999999999999}}'
_REPAIR_SEC_B = '{"claudeAiOauth":{"accessToken":"tokB","refreshToken":"rB","expiresAt":9999999999999}}'


def _promoted(root: Path) -> None:
    for marker in (".live-unified", ".homes-promoted"):
        path = root / "claude" / marker
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()


def test_a_failed_keychain_read_at_startup_never_overwrites_the_live_login(
    tmp_path, _isolated_convenience_gate
) -> None:
    """D2: rc 36 from security is not an empty live login."""
    from agent_team_backend.credential_vault import CLAUDE_LIVE_KEYCHAIN_SERVICE

    items: dict[str, str] = {}

    def security(args, input_text=None):
        tokens = shlex.split((input_text or "").rstrip("\n")) if args == ["-i"] else list(args)
        service = tokens[tokens.index("-s") + 1]
        if tokens[0] == "find-generic-password":
            if service == CLAUDE_LIVE_KEYCHAIN_SERVICE:
                return 36, "User interaction is not allowed."
            return (0, security_g_output(items[service])) if service in items else (44, "")
        if tokens[0] == "add-generic-password":
            items[service] = tokens[tokens.index("-w") + 1]
            return 0, ""
        if tokens[0] == "delete-generic-password":
            return (0, "") if items.pop(service, None) is not None else (44, "")
        return 1, ""

    (tmp_path / "home").mkdir()
    vault = CredentialVault(root=tmp_path / "root", real_home=tmp_path / "home",
                            security_runner=security, platform="darwin")
    vault.write_slot("claude", "pA", LiveCredentials(secret=_REPAIR_SEC_A, account={"emailAddress": "a@x.com"}))
    items[CLAUDE_LIVE_KEYCHAIN_SERVICE] = _REPAIR_SEC_B
    _promoted(tmp_path / "root")

    vault._promote_agent_profile_homes("claude", ["pA"], "pA")

    assert items[CLAUDE_LIVE_KEYCHAIN_SERVICE] == _REPAIR_SEC_B
    assert _isolated_convenience_gate.history() == []


def test_a_sign_out_outside_navide_is_a_prompt_not_a_sign_back_in(
    tmp_path, _isolated_convenience_gate
) -> None:
    """D2b: once the live login was published, an empty one at startup is the
    user's `claude /logout` — told, never undone."""
    vault = CredentialVault(root=tmp_path / "root", real_home=tmp_path / "home",
                            security_runner=lambda a, i=None: (1, ""), platform="linux")
    vault.write_slot("claude", "pA", LiveCredentials(secret=_REPAIR_SEC_A, account={"emailAddress": "a@x.com"}))
    _promoted(tmp_path / "root")

    vault._promote_agent_profile_homes("claude", ["pA"], "pA")

    assert vault.read_live("claude").secret is None
    [entry] = _isolated_convenience_gate.history()
    assert entry["action"] == "prompt"
    assert json.loads(entry["detail"]) == {"agentKey": "claude", "reason": "logout"}


def test_one_sign_out_outside_navide_is_one_prompt_however_many_startups(
    tmp_path, _isolated_convenience_gate
) -> None:
    """AC-N3: the user stays signed out across startups: told once. Signing
    in and out again is a new sign-out, told again."""
    vault = CredentialVault(root=tmp_path / "root", real_home=tmp_path / "home",
                            security_runner=lambda a, i=None: (1, ""), platform="linux")
    vault.write_slot("claude", "pA", LiveCredentials(secret=_REPAIR_SEC_A, account={"emailAddress": "a@x.com"}))
    _promoted(tmp_path / "root")

    for _ in range(3):
        vault._promote_agent_profile_homes("claude", ["pA"], "pA")
    assert [e["action"] for e in _isolated_convenience_gate.history()] == ["prompt"]

    vault.write_live("claude", LiveCredentials(secret=_REPAIR_SEC_A, account={"emailAddress": "a@x.com"}))
    vault._promote_agent_profile_homes("claude", ["pA"], "pA")
    vault.write_live("claude", LiveCredentials(secret=None))
    for _ in range(2):
        vault._promote_agent_profile_homes("claude", ["pA"], "pA")

    assert [e["action"] for e in _isolated_convenience_gate.history()] == ["prompt", "prompt"]
    assert vault.read_live("claude").secret is None


def test_a_sign_out_seen_while_auto_repair_is_off_is_told_once_it_is_on(
    tmp_path, _isolated_convenience_gate
) -> None:
    """R3-L6: with auto-repair off nothing is told, so nothing may be marked
    as told either — turning the feature back on tells the sign-out."""
    vault = CredentialVault(root=tmp_path / "root", real_home=tmp_path / "home",
                            security_runner=lambda a, i=None: (1, ""), platform="linux")
    vault.write_slot("claude", "pA", LiveCredentials(secret=_REPAIR_SEC_A, account={"emailAddress": "a@x.com"}))
    _promoted(tmp_path / "root")

    _isolated_convenience_gate.set_allowed("credentials.auto-repair", False)
    vault._promote_agent_profile_homes("claude", ["pA"], "pA")
    _isolated_convenience_gate.set_allowed("credentials.auto-repair", True)
    vault._promote_agent_profile_homes("claude", ["pA"], "pA")

    assert [e["action"] for e in _isolated_convenience_gate.history() if e["action"] == "prompt"] == ["prompt"]
    assert vault.read_live("claude").secret is None


def test_the_first_promotion_still_publishes_the_active_account(
    tmp_path, _isolated_convenience_gate
) -> None:
    """The migration case the repair exists for keeps working."""
    vault = CredentialVault(root=tmp_path / "root", real_home=tmp_path / "home",
                            security_runner=lambda a, i=None: (1, ""), platform="linux")
    vault.write_slot("claude", "pA", LiveCredentials(secret=_REPAIR_SEC_A, account={"emailAddress": "a@x.com"}))
    (tmp_path / "root" / "claude" / ".live-unified").touch()

    vault._promote_agent_profile_homes("claude", ["pA"], "pA")

    assert vault.read_live("claude").secret == _REPAIR_SEC_A
    assert [e["action"] for e in _isolated_convenience_gate.history()] == ["repair"]
