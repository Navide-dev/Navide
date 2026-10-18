"""CLI account switching: what fits `security -i` is written as at v0.2.19;
what does not goes through a hex-encoded argv write instead.

Sizes measured on the reporting machine (2026-10-11, lengths only): Claude
slots 504-2361 B of secret (624-2624 B of command); the larger ones carry
`mcpOAuth`, which grows with every MCP server signed into. A second machine
(2026-10-16) held 4335 B with five MCP logins — past the 4095-byte line, so
`-i` stored a truncated slot and every switch away from it failed.
"""

from __future__ import annotations

import base64
import getpass
import json
import secrets
from pathlib import Path

import pytest

from agent_team_backend.cloud_secrets import SECURITY_LINE_MAX_BYTES
from agent_team_backend.credential_vault import (
    DEFAULT_SLOT_ID,
    CredentialVault,
    LiveCredentials,
    _kc_quote,
)
from tests.test_credential_vault_keychain_vendors import FakeSecurity

#: Written out rather than imported (review KC-7): an imported constant follows
#: a change to it, and the test would never notice the item had been renamed.
CLAUDE_LIVE_KEYCHAIN_SERVICE = "Claude Code-credentials"


class RecordingSecurity(FakeSecurity):
    """The vendor fake, recording every interactive command verbatim."""

    def __init__(self) -> None:
        super().__init__()
        self.commands: list[str] = []

    def __call__(self, args, input_text=None):
        if args == ["-i"]:
            self.commands.append(input_text or "")
        return super().__call__(args, input_text)


def _vault(tmp_path: Path) -> tuple[CredentialVault, RecordingSecurity]:
    sec = RecordingSecurity()
    vault = CredentialVault(root=tmp_path / "root", real_home=tmp_path / "home",
                            security_runner=sec, platform="darwin")
    return vault, sec


def _token(prefix: str, n: int = 95) -> str:
    return prefix + secrets.token_urlsafe(n)[:n]


def _claude_secret(mcp_servers: int) -> str:
    """The shape Claude Code stores: an OAuth pair, plus one entry per MCP
    server the user signed into."""
    doc = {"claudeAiOauth": {
        "accessToken": _token("sk-ant-oat01-"), "refreshToken": _token("sk-ant-ort01-"),
        "expiresAt": 1791700000000, "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
        "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x"}}
    if mcp_servers:
        doc["mcpOAuth"] = {
            f"server-{i}|{secrets.token_hex(8)}": {
                "serverName": f"server-{i}", "serverUrl": f"https://mcp{i}.example.com/mcp",
                "accessToken": _token("mcp_at_", 160), "refreshToken": _token("mcp_rt_", 64),
                "expiresAt": 1791700000000, "clientId": secrets.token_hex(16)}
            for i in range(mcp_servers)}
    return json.dumps(doc, separators=(",", ":"))


def _pre_change_command(service: str, secret: str, account: str | None = None) -> str:
    """The command `_keychain_write` assembled before the line-limit fix."""
    return " ".join(["add-generic-password", "-U", "-a", _kc_quote(account or getpass.getuser()),
                     "-s", _kc_quote(service), "-w", _kc_quote(secret)]) + "\n"


@pytest.mark.parametrize("mcp_servers", [0, 3, 5])
def test_a_claude_switch_writes_and_reads_exactly_as_before(tmp_path, mcp_servers):
    vault, sec = _vault(tmp_path)
    live = _claude_secret(mcp_servers)
    incoming = _claude_secret(mcp_servers)
    sec.items[(CLAUDE_LIVE_KEYCHAIN_SERVICE, getpass.getuser())] = live
    vault.write_slot("claude", "acct1", LiveCredentials(secret=incoming))
    sec.commands.clear()

    vault.switch("claude", DEFAULT_SLOT_ID, "acct1")

    assert sec.items[(CLAUDE_LIVE_KEYCHAIN_SERVICE, getpass.getuser())] == incoming
    assert vault.read_slot("claude", DEFAULT_SLOT_ID).secret == live
    assert _pre_change_command(CLAUDE_LIVE_KEYCHAIN_SERVICE, incoming) in sec.commands
    assert _pre_change_command("Navide CLI account claude-__default__", live) in sec.commands

    vault.switch("claude", "acct1", DEFAULT_SLOT_ID)
    assert sec.items[(CLAUDE_LIVE_KEYCHAIN_SERVICE, getpass.getuser())] == live
    assert vault.read_slot("claude", "acct1").secret == incoming


def test_the_largest_measured_claude_slot_has_room_to_spare():
    """Five MCP servers is already past the largest slot measured (2361 B)."""
    command = _pre_change_command("Navide CLI account claude-33fa8a5d", _claude_secret(5))
    assert len(command.rstrip("\n").encode()) < SECURITY_LINE_MAX_BYTES * 0.9


def _cursor_jwt(sub: str) -> str:
    def b64(obj: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")
    claims = {"sub": sub, "time": "1791700000", "randomness": secrets.token_hex(16),
              "exp": 1796884000, "iss": "https://authentication.cursor.sh",
              "scope": "openid profile email offline_access", "aud": "https://cursor.com", "type": "session"}
    return f"{b64({'alg': 'HS256', 'typ': 'JWT'})}.{b64(claims)}.{secrets.token_urlsafe(32)}"


def test_a_cursor_switch_round_trips_both_real_sized_tokens(tmp_path):
    vault, sec = _vault(tmp_path)
    access_a, refresh_a = _cursor_jwt("google-oauth2|user_A"), _cursor_jwt("google-oauth2|user_A")
    access_b, refresh_b = _cursor_jwt("auth0|user_B"), _cursor_jwt("auth0|user_B")
    sec.items[("cursor-access-token", "cursor-user")] = access_a
    sec.items[("cursor-refresh-token", "cursor-user")] = refresh_a
    vault.write_slot("cursor", "b", LiveCredentials(secret=json.dumps({"keychain": {
        "cursor-access-token|cursor-user": access_b, "cursor-refresh-token|cursor-user": refresh_b}})))

    vault.switch("cursor", DEFAULT_SLOT_ID, "b")
    assert sec.items[("cursor-access-token", "cursor-user")] == access_b
    assert sec.items[("cursor-refresh-token", "cursor-user")] == refresh_b

    vault.switch("cursor", "b", DEFAULT_SLOT_ID)
    assert sec.items[("cursor-access-token", "cursor-user")] == access_a
    assert sec.items[("cursor-refresh-token", "cursor-user")] == refresh_a


def _agy_blob(with_id_token: bool) -> str:
    token = {"access_token": _token("ya29.", 210), "refresh_token": _token("1//0", 99),
             "token_type": "Bearer", "expiry": "2026-10-11T14:00:00+08:00"}
    if with_id_token:
        token["id_token"] = _cursor_jwt("1234567890") + secrets.token_urlsafe(400)
    return "go-keyring-base64:" + base64.b64encode(json.dumps({"token": token}).encode()).decode()


@pytest.mark.parametrize("with_id_token", [False, True])
def test_an_antigravity_switch_round_trips_a_real_sized_item(tmp_path, with_id_token):
    vault, sec = _vault(tmp_path)
    blob_a, blob_b = _agy_blob(with_id_token), _agy_blob(with_id_token)
    sec.items[("gemini", "antigravity")] = blob_a
    vault.write_slot("antigravity", "b", LiveCredentials(
        secret=json.dumps({"keychain": {"gemini|antigravity": blob_b}})))

    vault.switch("antigravity", DEFAULT_SLOT_ID, "b")
    assert sec.items[("gemini", "antigravity")] == blob_b

    vault.switch("antigravity", "b", DEFAULT_SLOT_ID)
    assert sec.items[("gemini", "antigravity")] == blob_a


def _argv_hex_writes(sec: RecordingSecurity, service: str) -> list[str]:
    return [c[c.index("-X") + 1] for c in sec.calls
            if c and c[0] == "add-generic-password" and c[c.index("-s") + 1] == service]


def test_a_credential_past_the_line_switches_through_argv(tmp_path):
    """Past the 4095-byte line `security -i` would store a truncated head, so
    the write moves to argv, hex-encoded — what Claude Code itself does."""
    vault, sec = _vault(tmp_path)
    huge = _claude_secret(14)
    assert len(_pre_change_command(CLAUDE_LIVE_KEYCHAIN_SERVICE, huge).encode()) > SECURITY_LINE_MAX_BYTES
    vault.write_slot("claude", "huge", LiveCredentials(secret=huge))
    sec.commands.clear()

    vault.switch("claude", DEFAULT_SLOT_ID, "huge")

    assert _pre_change_command(CLAUDE_LIVE_KEYCHAIN_SERVICE, huge) not in sec.commands
    assert _argv_hex_writes(sec, CLAUDE_LIVE_KEYCHAIN_SERVICE) == [huge.encode().hex()]
    assert sec.items[(CLAUDE_LIVE_KEYCHAIN_SERVICE, getpass.getuser())] == huge


def test_a_very_long_claude_credential_is_written_whole(tmp_path):
    """Review KC-7: 10-20 KB, far past the line — still stored whole, never
    refused and never cut to its first 4095 bytes."""
    vault, sec = _vault(tmp_path)
    huge = _claude_secret(40)
    assert 10_000 <= len(huge.encode()) <= 20_000
    vault.write_slot("claude", "huge", LiveCredentials(secret=huge))
    assert sec.commands == []
    assert vault.read_slot("claude", "huge").secret == huge
