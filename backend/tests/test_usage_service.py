"""Unit tests for usage_service: credential parsing, response normalization,
and the poller's cooldown behavior. No network, no real CLI spawns."""

from __future__ import annotations

import asyncio
import base64
import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import osplat
from agent_team_backend import usage_service as us
from agent_team_backend.cli_vendors import _protocols as protocols_vendor
from agent_team_backend.cli_vendors import antigravity as antigravity_vendor
from agent_team_backend.cli_vendors import grok as grok_vendor
from agent_team_backend.cli_vendors import kilo as kilo_vendor
from agent_team_backend.cli_vendors import kimi as kimi_vendor
from agent_team_backend.cli_vendors import pi as pi_vendor
from agent_team_backend.cli_vendors import opencode as opencode_vendor
from agent_team_backend.cli_vendors import copilot as copilot_vendor
from agent_team_backend.cli_vendors import codex as codex_vendor
from agent_team_backend.cli_vendors import cursor as cursor_vendor
from agent_team_backend.cli_vendors import qwen as qwen_vendor
from agent_team_backend.profiles_store import CliProfilesStore


def _isolated_store(tmp_path: Path) -> CliProfilesStore:
    return CliProfilesStore(
        path=tmp_path / "cli-profiles.json",
        profiles_root=tmp_path / "cli-profiles",
    )


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


# ── Claude credentials ──────────────────────────────────────────────────────

def test_claude_credentials_file_ok(tmp_path):
    _write(tmp_path / ".claude" / ".credentials.json",
           {"claudeAiOauth": {"accessToken": "tok", "expiresAt": 2_000_000_000_000}})
    oauth = us.read_claude_credentials_file(tmp_path)
    assert oauth is not None and oauth["accessToken"] == "tok"


def test_claude_credentials_missing_and_mcp_only(tmp_path):
    assert us.read_claude_credentials_file(tmp_path) is None
    _write(tmp_path / ".claude" / ".credentials.json", {"mcpOAuth": {"x": 1}})
    assert us.read_claude_credentials_file(tmp_path) is None


def test_claude_token_expired_boundary():
    oauth = {"expiresAt": 1_000}
    assert us.claude_token_expired(oauth, now_ms=1_000) is True
    assert us.claude_token_expired(oauth, now_ms=999) is False
    assert us.claude_token_expired({}, now_ms=0) is False  # no expiry -> assume valid


# ── Codex credentials & base URL ────────────────────────────────────────────

def test_codex_credentials_snake_and_camel(tmp_path):
    _write(tmp_path / "auth.json",
           {"tokens": {"access_token": "a", "account_id": "acct"}})
    creds = us.read_codex_credentials(tmp_path)
    assert creds == {"access_token": "a", "account_id": "acct"}
    _write(tmp_path / "auth.json",
           {"tokens": {"accessToken": "b", "accountId": "acct2"}})
    creds = us.read_codex_credentials(tmp_path)
    assert creds == {"access_token": "b", "account_id": "acct2"}


def test_codex_credentials_api_key_form_and_missing(tmp_path):
    _write(tmp_path / "auth.json", {"OPENAI_API_KEY": "sk-x"})
    assert us.read_codex_credentials(tmp_path) == {"access_token": "sk-x", "account_id": None}
    _write(tmp_path / "auth.json", {"tokens": {}})
    assert us.read_codex_credentials(tmp_path) is None
    assert us.read_codex_credentials(tmp_path / "nope") is None


def test_codex_base_url_normalization(tmp_path):
    assert us.codex_base_url(tmp_path) == us.CODEX_DEFAULT_BASE
    (tmp_path / "config.toml").write_text(
        'chatgpt_base_url = "https://chatgpt.com"  # comment\n', encoding="utf-8")
    assert us.codex_base_url(tmp_path) == "https://chatgpt.com/backend-api"
    (tmp_path / "config.toml").write_text(
        "chatgpt_base_url = 'https://proxy.example.com/'\n", encoding="utf-8")
    assert us.codex_base_url(tmp_path) == "https://proxy.example.com"


def test_codex_usage_url_path_selection():
    assert us.codex_usage_url("https://chatgpt.com/backend-api").endswith("/wham/usage")
    assert us.codex_usage_url("https://proxy.example.com").endswith("/api/codex/usage")


# ── Kimi credentials ────────────────────────────────────────────────────────

def test_kimi_env_key_wins(tmp_path):
    assert us.read_kimi_credentials(tmp_path, {"KIMI_CODE_API_KEY": "env-key"}) == "env-key"


def test_kimi_file_expiry_boundary(tmp_path):
    _write(tmp_path / ".kimi-code" / "credentials" / "kimi-code.json",
           {"access_token": "tok", "expires_at": 1_000})
    assert us.read_kimi_credentials(tmp_path, {}, now=939) == "tok"
    assert us.read_kimi_credentials(tmp_path, {}, now=940) is None  # <= now+60
    assert us.read_kimi_credentials(tmp_path / "nope", {}) is None


# ── Grok credentials ────────────────────────────────────────────────────────

def test_grok_prefers_oidc_over_legacy(tmp_path):
    _write(tmp_path / ".grok" / "auth.json", {
        "https://accounts.x.ai/sign-in": {"key": "legacy", "email": "l@x.ai"},
        "https://auth.x.ai::scope": {"key": "oidc", "email": "o@x.ai"},
    })
    creds = us.read_grok_credentials(tmp_path, {})
    assert creds is not None and creds["key"] == "oidc"


def test_grok_legacy_fallback_and_missing(tmp_path):
    _write(tmp_path / ".grok" / "auth.json",
           {"https://accounts.x.ai/sign-in": {"key": "legacy"}})
    creds = us.read_grok_credentials(tmp_path, {})
    assert creds is not None and creds["key"] == "legacy"
    _write(tmp_path / ".grok" / "auth.json", {"other": {"nokey": True}})
    assert us.read_grok_credentials(tmp_path, {}) is None


# ── Antigravity credentials ─────────────────────────────────────────────────

def test_antigravity_refresh_token_plain_and_keyring_blob():
    payload = json.dumps({"token": {"refresh_token": "1//rt", "access_token": "ya29.x"},
                          "auth_method": "consumer"})
    assert antigravity_vendor._antigravity_refresh_token(payload) == "1//rt"
    blob = antigravity_vendor.ANTIGRAVITY_KEYRING_PREFIX + base64.b64encode(payload.encode()).decode()
    assert antigravity_vendor._antigravity_refresh_token(blob) == "1//rt"


def test_antigravity_refresh_token_malformed():
    assert antigravity_vendor._antigravity_refresh_token("not json") is None
    assert antigravity_vendor._antigravity_refresh_token(antigravity_vendor.ANTIGRAVITY_KEYRING_PREFIX + "!!!") is None
    assert antigravity_vendor._antigravity_refresh_token(json.dumps({"token": {}})) is None
    assert antigravity_vendor._antigravity_refresh_token(json.dumps({"token": {"refresh_token": ""}})) is None
    assert antigravity_vendor._antigravity_refresh_token(json.dumps(["token"])) is None


def test_antigravity_credentials_file_and_missing(tmp_path):
    _write(tmp_path / ".gemini" / "antigravity-cli" / "antigravity-oauth-token",
           {"token": {"refresh_token": "1//rt", "expiry": "2026-07-28T00:00:00Z"}})
    assert us.read_antigravity_credentials_file(tmp_path) == "1//rt"
    assert us.read_antigravity_credentials_file(tmp_path / "nope") is None


# ── opencode credentials ────────────────────────────────────────────────────

def test_opencode_credentials_map_and_missing(tmp_path):
    _write(tmp_path / ".local" / "share" / "opencode" / "auth.json", {
        "minimax-coding-plan": {"type": "api", "key": "sk-cp-x"},
        "google": {"type": "api", "key": "AIza-x"},
        "junk": "not-a-dict",  # non-dict entries are dropped
    })
    auth = us.read_opencode_credentials(tmp_path)
    assert auth is not None and set(auth) == {"minimax-coding-plan", "google"}
    assert us.read_opencode_credentials(tmp_path / "nope") is None


def test_opencode_credentials_malformed(tmp_path):
    path = tmp_path / ".local" / "share" / "opencode" / "auth.json"
    path.parent.mkdir(parents=True)
    path.write_text("not json", encoding="utf-8")
    assert us.read_opencode_credentials(tmp_path) is None
    path.write_text(json.dumps(["x"]), encoding="utf-8")
    assert us.read_opencode_credentials(tmp_path) is None
    path.write_text(json.dumps({"a": "str-entry"}), encoding="utf-8")
    assert us.read_opencode_credentials(tmp_path) is None  # no dict entries


def test_opencode_minimax_key_extraction():
    assert us.opencode_minimax_key(
        {"minimax-coding-plan": {"type": "api", "key": "sk-cp-x"}}) == "sk-cp-x"
    assert us.opencode_minimax_key({}) is None
    assert us.opencode_minimax_key(
        {"minimax-coding-plan": {"type": "oauth", "access": "a"}}) is None
    assert us.opencode_minimax_key(
        {"minimax-coding-plan": {"type": "api", "key": ""}}) is None


def test_opencode_anthropic_oauth_mapping():
    oauth = us.opencode_anthropic_oauth(
        {"anthropic": {"type": "oauth", "access": "at", "refresh": "rt",
                       "expires": 2_000_000_000_000}})
    assert oauth == {"accessToken": "at", "expiresAt": 2_000_000_000_000}
    assert us.opencode_anthropic_oauth({}) is None
    assert us.opencode_anthropic_oauth(
        {"anthropic": {"type": "api", "key": "sk-x"}}) is None
    assert us.opencode_anthropic_oauth(
        {"anthropic": {"type": "oauth", "access": ""}}) is None


# ── Qwen credentials ────────────────────────────────────────────────────────

def test_qwen_env_key_wins_and_aliases(tmp_path):
    assert us.read_qwen_credentials(
        tmp_path, {"BAILIAN_CODING_PLAN_API_KEY": "sk-sp-env"}) == "sk-sp-env"
    assert us.read_qwen_credentials(
        tmp_path, {"DASHSCOPE_API_KEY": "sk-alias"}) == "sk-alias"


def test_qwen_dotenv_then_settings_fallback(tmp_path):
    (tmp_path / ".qwen").mkdir()
    (tmp_path / ".qwen" / ".env").write_text(
        "# comment\nexport BAILIAN_CODING_PLAN_API_KEY = 'sk-sp-dotenv'\n",
        encoding="utf-8")
    assert us.read_qwen_credentials(tmp_path, {}) == "sk-sp-dotenv"
    (tmp_path / ".qwen" / ".env").unlink()
    _write(tmp_path / ".qwen" / "settings.json",
           {"env": {"BAILIAN_CODING_PLAN_API_KEY": "sk-sp-settings"}})
    assert us.read_qwen_credentials(tmp_path, {}) == "sk-sp-settings"


def test_qwen_credentials_missing_and_malformed(tmp_path):
    assert us.read_qwen_credentials(tmp_path, {}) is None
    _write(tmp_path / ".qwen" / "settings.json", {"env": "not-a-dict"})
    assert us.read_qwen_credentials(tmp_path, {}) is None
    (tmp_path / ".qwen" / "settings.json").write_text("{broken", encoding="utf-8")
    assert us.read_qwen_credentials(tmp_path, {}) is None


def test_qwen_legacy_oauth_detection(tmp_path):
    assert us.qwen_legacy_oauth_present(tmp_path) is False
    _write(tmp_path / ".qwen" / "oauth_creds.json",
           {"access_token": "t", "refresh_token": "r"})
    assert us.qwen_legacy_oauth_present(tmp_path) is True


# ── Kilo credentials ────────────────────────────────────────────────────────

def test_kilo_credentials_api_and_oauth_forms(tmp_path):
    _write(tmp_path / ".local" / "share" / "kilo" / "auth.json",
           {"kilo": {"type": "api", "key": "kilo_abc"}})
    assert us.read_kilo_credentials(tmp_path, {}) == {
        "token": "kilo_abc", "org_id": None}
    _write(tmp_path / ".local" / "share" / "kilo" / "auth.json",
           {"kilo": {"type": "oauth", "access": "kilo-at", "refresh": "rt",
                     "expires": 2_000_000_000_000, "accountId": "org-1"}})
    assert us.read_kilo_credentials(tmp_path, {}) == {
        "token": "kilo-at", "org_id": "org-1"}


def test_kilo_credentials_follow_xdg_data_home(tmp_path):
    # XDG_DATA_HOME relocates Kilo's data dir, auth.json included; the default
    # ~/.local/share copy must not win over it.
    _write(tmp_path / ".local" / "share" / "kilo" / "auth.json",
           {"kilo": {"type": "api", "key": "home-key"}})
    xdg = tmp_path / "xdg-data"
    _write(xdg / "kilo" / "auth.json", {"kilo": {"type": "api", "key": "xdg-key"}})
    assert us.read_kilo_credentials(tmp_path, {"XDG_DATA_HOME": str(xdg)}) == {
        "token": "xdg-key", "org_id": None}
    # An XDG data dir with no auth.json falls through to the legacy config.
    _write(tmp_path / ".kilocode" / "cli" / "config.json", {"providers": [
        {"provider": "kilocode", "kilocodeToken": "legacy-tok"}]})
    empty = tmp_path / "xdg-empty"
    assert us.read_kilo_credentials(tmp_path, {"XDG_DATA_HOME": str(empty)}) == {
        "token": "legacy-tok", "org_id": None}


def test_kilo_credentials_env_content_wins(tmp_path):
    _write(tmp_path / ".local" / "share" / "kilo" / "auth.json",
           {"kilo": {"type": "api", "key": "file-key"}})
    env = {"KILO_AUTH_CONTENT": json.dumps(
        {"kilo": {"type": "api", "key": "env-key"}})}
    assert us.read_kilo_credentials(tmp_path, env) == {
        "token": "env-key", "org_id": None}


def test_kilo_credentials_legacy_fallback_and_missing(tmp_path):
    assert us.read_kilo_credentials(tmp_path, {}) is None
    _write(tmp_path / ".kilocode" / "cli" / "config.json", {"providers": [
        {"provider": "other", "kilocodeToken": "nope"},
        {"provider": "kilocode", "kilocodeToken": "legacy-tok",
         "kilocodeOrganizationId": "org-2"},
    ]})
    assert us.read_kilo_credentials(tmp_path, {}) == {
        "token": "legacy-tok", "org_id": "org-2"}


def test_kilo_credentials_malformed(tmp_path):
    path = tmp_path / ".local" / "share" / "kilo" / "auth.json"
    path.parent.mkdir(parents=True)
    path.write_text("not json", encoding="utf-8")
    assert us.read_kilo_credentials(tmp_path, {}) is None
    _write(path, {"kilo": {"type": "oauth", "access": ""}})
    assert us.read_kilo_credentials(tmp_path, {}) is None
    _write(path, {"kilo": {"type": "api", "key": None}})
    assert us.read_kilo_credentials(tmp_path, {}) is None
    _write(path, {"other-provider": {"type": "api", "key": "k"}})
    assert us.read_kilo_credentials(tmp_path, {}) is None
    _write(tmp_path / ".kilocode" / "cli" / "config.json", {"providers": "x"})
    assert us.read_kilo_credentials(tmp_path, {}) is None


def test_kilo_base_url():
    assert us.kilo_base_url("kilo_abc", {}) == us.KILO_DEFAULT_BASE
    assert us.kilo_base_url(
        "kilo_abc", {"KILO_API_URL": "https://kilo.corp.example/"}) == \
        "https://kilo.corp.example"
    # A token prefixed "https://host:" re-points the base itself.
    assert us.kilo_base_url("https://kilo.corp.example:tok-part", {}) == \
        "https://kilo.corp.example"


# ── pi credentials ──────────────────────────────────────────────────────────

def test_pi_credentials_map_env_root_and_missing(tmp_path):
    _write(tmp_path / ".pi" / "agent" / "auth.json", {
        "anthropic": {"type": "oauth", "access": "sk-ant-oat", "refresh": "r",
                      "expires": 2_000_000_000_000},
        "openai": {"type": "api_key", "key": "sk-x"},
        "junk": "not-a-dict",  # non-dict entries are dropped
    })
    auth = us.read_pi_credentials(tmp_path, {})
    assert auth is not None and set(auth) == {"anthropic", "openai"}
    assert us.read_pi_credentials(tmp_path / "nope", {}) is None
    # PI_CODING_AGENT_DIR re-points the root (mirrors the pi log reader).
    alt = tmp_path / "alt-root"
    _write(alt / "auth.json", {"openrouter": {"type": "api_key", "key": "k"}})
    auth = us.read_pi_credentials(tmp_path / "nope",
                                  {"PI_CODING_AGENT_DIR": str(alt)})
    assert auth is not None and set(auth) == {"openrouter"}


def test_pi_credentials_malformed(tmp_path):
    path = tmp_path / ".pi" / "agent" / "auth.json"
    path.parent.mkdir(parents=True)
    path.write_text("not json", encoding="utf-8")
    assert us.read_pi_credentials(tmp_path, {}) is None
    path.write_text(json.dumps(["x"]), encoding="utf-8")
    assert us.read_pi_credentials(tmp_path, {}) is None
    path.write_text(json.dumps({"a": "str-entry"}), encoding="utf-8")
    assert us.read_pi_credentials(tmp_path, {}) is None  # no dict entries


def test_pi_oauth_expired_boundary():
    entry = {"expires": 1_000}
    assert us.pi_oauth_expired(entry, now_ms=1_000) is True
    assert us.pi_oauth_expired(entry, now_ms=999) is False
    assert us.pi_oauth_expired({}, now_ms=0) is False  # no expiry -> assume valid


def test_pi_anthropic_oauth_mapping():
    oauth = us.pi_anthropic_oauth(
        {"anthropic": {"type": "oauth", "access": "at", "refresh": "rt",
                       "expires": 2_000_000_000_000}})
    assert oauth == {"accessToken": "at", "expiresAt": 2_000_000_000_000}
    assert us.pi_anthropic_oauth({}) is None
    assert us.pi_anthropic_oauth(
        {"anthropic": {"type": "api_key", "key": "sk-x"}}) is None
    assert us.pi_anthropic_oauth(
        {"anthropic": {"type": "oauth", "access": ""}}) is None


def test_pi_codex_oauth_extraction():
    creds = us.pi_codex_oauth(
        {"openai-codex": {"type": "oauth", "access": "at", "refresh": "rt",
                          "expires": 2_000_000_000_000, "accountId": "acct"}})
    assert creds == {"access_token": "at", "account_id": "acct",
                     "expires": 2_000_000_000_000}
    creds = us.pi_codex_oauth(
        {"openai-codex": {"type": "oauth", "access": "at"}})
    assert creds == {"access_token": "at", "account_id": None, "expires": None}
    assert us.pi_codex_oauth({}) is None
    assert us.pi_codex_oauth(
        {"openai-codex": {"type": "api_key", "key": "sk-x"}}) is None
    assert us.pi_codex_oauth(
        {"openai-codex": {"type": "oauth", "access": ""}}) is None


def test_pi_openrouter_key_extraction():
    assert us.pi_openrouter_key(
        {"openrouter": {"type": "oauth", "access": "or-at"}}) == "or-at"
    assert us.pi_openrouter_key(
        {"openrouter": {"type": "api_key", "key": "sk-or"}}) == "sk-or"
    assert us.pi_openrouter_key({}) is None
    assert us.pi_openrouter_key(
        {"openrouter": {"type": "oauth", "access": ""}}) is None
    assert us.pi_openrouter_key(
        {"openrouter": {"type": "api_key", "key": ""}}) is None


# ── Copilot credentials ─────────────────────────────────────────────────────

def test_copilot_config_parses_jsonc_and_host(tmp_path):
    path = tmp_path / ".copilot" / "config.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        "// GitHub Copilot CLI configuration\n"
        "// Do not edit this file\n"
        '{"firstLaunchAt": "2026-04-28T09:59:37+08:00",\n'
        ' "loggedInUsers": [{"host": "https://github.com", "login": "octo"}],\n'
        ' "lastLoggedInUser": {"host": "https://github.com", "login": "octo"}}\n',
        encoding="utf-8")
    assert us.read_copilot_config(tmp_path) == {"host": "github.com", "login": "octo"}
    _write(path, {"lastLoggedInUser": {"host": "https://ghe.example.com/",
                                       "login": "ent"}})
    assert us.read_copilot_config(tmp_path) == {"host": "ghe.example.com",
                                                "login": "ent"}
    _write(path, {"lastLoggedInUser": {"login": "bare"}})  # no host -> default
    assert us.read_copilot_config(tmp_path) == {"host": "github.com",
                                                "login": "bare"}


def test_copilot_config_missing_and_malformed(tmp_path):
    assert us.read_copilot_config(tmp_path) is None
    path = tmp_path / ".copilot" / "config.json"
    _write(path, {"firstLaunchAt": "2026-04-28"})  # logged out
    assert us.read_copilot_config(tmp_path) is None
    _write(path, {"lastLoggedInUser": {"host": "https://github.com"}})  # no login
    assert us.read_copilot_config(tmp_path) is None
    path.write_text("// only comments, no JSON\n", encoding="utf-8")
    assert us.read_copilot_config(tmp_path) is None


def test_copilot_hosts_token_apps_then_hosts(tmp_path):
    _write(tmp_path / ".config" / "github-copilot" / "hosts.json",
           {"github.com": {"oauth_token": "gho_hosts"}})
    assert us.read_copilot_hosts_token(tmp_path) == "gho_hosts"
    _write(tmp_path / ".config" / "github-copilot" / "apps.json",
           {"github.com:Iv1.abc123": {"oauth_token": "gho_apps"}})
    assert us.read_copilot_hosts_token(tmp_path) == "gho_apps"  # apps.json wins
    assert us.read_copilot_hosts_token(tmp_path, "ghe.example.com") is None
    assert us.read_copilot_hosts_token(tmp_path / "nope") is None


def test_copilot_env_token_priority():
    assert us.copilot_env_token({"GH_TOKEN": "gho_a", "GITHUB_TOKEN": "gho_b"}) == "gho_a"
    assert us.copilot_env_token({"GITHUB_TOKEN": " gho_b "}) == "gho_b"
    assert us.copilot_env_token({"GH_TOKEN": "  "}) is None
    assert us.copilot_env_token({}) is None


def test_copilot_usage_url():
    assert us.copilot_usage_url("github.com") == \
        "https://api.github.com/copilot_internal/user"
    assert us.copilot_usage_url("ghe.example.com") == \
        "https://api.ghe.example.com/copilot_internal/user"


# ── Cursor credentials ──────────────────────────────────────────────────────

def _cursor_jwt(claims: dict) -> str:
    body = base64.urlsafe_b64encode(
        json.dumps(claims).encode()).decode().rstrip("=")
    return f"eyJhbGciOiJSUzI1NiJ9.{body}.sig"


def _write_cursor_state_db(home: Path, value) -> None:
    import sqlite3

    # Resolved through the same platform seam the reader uses, so this fixture
    # lands where the reader will actually look on whatever OS runs the suite.
    path = us.cursor_ide_state_db_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)")
    conn.execute("INSERT OR REPLACE INTO ItemTable VALUES (?, ?)",
                 (us.CURSOR_IDE_TOKEN_KEY, value))
    conn.commit()
    conn.close()


def test_cursor_user_id_from_jwt_sub():
    assert us.cursor_user_id(
        _cursor_jwt({"sub": "google-oauth2|user_xxx"})) == "user_xxx"
    assert us.cursor_user_id(_cursor_jwt({"sub": "user_bare"})) == "user_bare"
    assert us.cursor_user_id(_cursor_jwt({"aud": "https://cursor.com"})) is None
    assert us.cursor_user_id(_cursor_jwt({"sub": ""})) is None
    assert us.cursor_user_id("not-a-jwt") is None
    assert us.cursor_user_id("a.!!!.c") is None


def test_cursor_token_expired_boundary():
    token = _cursor_jwt({"sub": "auth0|u1", "exp": 1_000})
    assert us.cursor_token_expired(token, now=1_000) is True
    assert us.cursor_token_expired(token, now=999) is False
    # No exp claim / unreadable token -> assume valid (the 401 decides).
    assert us.cursor_token_expired(_cursor_jwt({"sub": "u"}), now=0) is False
    assert us.cursor_token_expired("not-a-jwt", now=0) is False


def test_cursor_ide_token_from_state_db(tmp_path):
    token = _cursor_jwt({"sub": "auth0|user_123"})
    _write_cursor_state_db(tmp_path, token)
    assert us.read_cursor_ide_token(tmp_path) == token
    # JSON-quoted and bytes-valued rows parse the same.
    _write_cursor_state_db(tmp_path, json.dumps(token))
    assert us.read_cursor_ide_token(tmp_path) == token
    _write_cursor_state_db(tmp_path, token.encode())
    assert us.read_cursor_ide_token(tmp_path) == token


def test_cursor_ide_token_missing_and_malformed(tmp_path):
    assert us.read_cursor_ide_token(tmp_path) is None  # no db
    path = us.cursor_ide_state_db_path(tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text("not a sqlite db", encoding="utf-8")
    assert us.read_cursor_ide_token(tmp_path) is None
    path.unlink()
    _write_cursor_state_db(tmp_path, "")  # empty value
    assert us.read_cursor_ide_token(tmp_path) is None
    _write_cursor_state_db(tmp_path, '"broken-json')
    assert us.read_cursor_ide_token(tmp_path) is None


# ── Normalizers ─────────────────────────────────────────────────────────────

def test_normalize_claude_named_and_scoped_windows():
    windows, _ = us.normalize_claude({
        "five_hour": {"utilization": 42.5, "resets_at": "2026-07-24T10:00:00.123Z"},
        "seven_day": {"utilization": 12, "resets_at": "2026-07-28T00:00:00Z"},
        "seven_day_opus": {"utilization": None},  # skipped: no utilization
        "limits": [
            {"kind": "weekly_scoped", "group": "weekly", "percent": 7.5,
             "resets_at": "2026-07-28T00:00:00Z", "is_active": False,
             "scope": {"model": {"id": "m", "display_name": "Fable"}}},
            {"kind": "other", "group": "weekly", "percent": 1},  # wrong kind
        ],
    })
    kinds = [(w["kind"], w["usedPercent"]) for w in windows]
    assert ("session", 42.5) in kinds
    assert ("weekly", 12.0) in kinds
    # is_active False must NOT filter the scoped limit out
    assert any(w["label"] == "Fable only" and w["usedPercent"] == 7.5 for w in windows)
    assert len(windows) == 3


def test_normalize_claude_scoped_filters_all_models_and_dedupes():
    windows, _ = us.normalize_claude({
        "limits": [
            # "all models" aggregate row must be dropped.
            {"kind": "weekly_scoped", "group": "weekly", "percent": 50,
             "scope": {"model": {"id": "all-models", "display_name": "All Models"}}},
            {"kind": "weekly_scoped", "group": "weekly", "percent": 7.5,
             "resets_at": "2026-07-28T00:00:00Z",
             "scope": {"model": {"id": "opus", "display_name": "Opus"}}},
            # duplicate opus slug must be de-duplicated (first wins).
            {"kind": "weekly_scoped", "group": "weekly", "percent": 99,
             "scope": {"model": {"id": "opus", "display_name": "Opus"}}},
            {"kind": "weekly_scoped", "group": "weekly", "percent": 3,
             "scope": {"model": {"id": "sonnet", "display_name": "Sonnet"}}},
        ],
    })
    labels = [(w["label"], w["usedPercent"]) for w in windows]
    assert ("Opus only", 7.5) in labels
    assert ("Sonnet only", 3.0) in labels
    assert not any("All Models" in w["label"] for w in windows)
    assert len(windows) == 2  # all-models dropped, duplicate opus collapsed


def test_normalize_claude_shows_null_id_scoped_as_real_data():
    # Real /api/oauth/usage shape (2026-07): the only weekly_scoped entry is a
    # "Fable" bucket with scope.model.id=None. The quota is real (Anthropic
    # reports it), so it is surfaced as-is like any per-model window ("Fable
    # only") — never hidden or relabeled. Sibling limits[] entries
    # (kind=session/weekly_all) must not become extra windows.
    windows, _ = us.normalize_claude({
        "five_hour": {"utilization": 4.0, "resets_at": "2026-07-24T15:50:00Z"},
        "seven_day": {"utilization": 92.0, "resets_at": "2026-07-29T23:00:00Z"},
        "seven_day_opus": None,
        "seven_day_sonnet": None,
        "limits": [
            {"kind": "session", "group": "session", "percent": 4},
            {"kind": "weekly_all", "group": "weekly", "percent": 92},
            {"kind": "weekly_scoped", "group": "weekly", "percent": 100,
             "is_active": True, "severity": "critical",
             "scope": {"model": {"id": None, "display_name": "Fable"}}},
        ],
    })
    labels = [w["label"] for w in windows]
    assert "Session (5h)" in labels
    assert "Weekly (all models)" in labels
    assert any(w["label"] == "Fable only" and w["usedPercent"] == 100.0 for w in windows)
    assert len(windows) == 3


def test_normalize_codex_epoch_and_plan():
    windows, plan = us.normalize_codex({
        "plan_type": "plus",
        "rate_limit": {
            "primary_window": {"used_percent": 37, "reset_at": 1753350000,
                               "limit_window_seconds": 18000},
            "secondary_window": {"used_percent": 12, "reset_at": 1753900000,
                                 "limit_window_seconds": 604800},
        },
    })
    assert plan == "plus"
    session = next(w for w in windows if w["kind"] == "session")
    assert session["usedPercent"] == 37.0
    assert session["resetsAt"].startswith("2025-07-24T")  # epoch converted to ISO
    assert session["windowMinutes"] == 300
    weekly = next(w for w in windows if w["kind"] == "weekly")
    assert weekly["windowMinutes"] == 10080


def test_normalize_codex_classifies_by_window_length_when_reversed():
    # primary carries the 7-day window, secondary the 5-hour one: roles must
    # follow limit_window_seconds, not position.
    windows, _ = us.normalize_codex({
        "rate_limit": {
            "primary_window": {"used_percent": 12, "reset_at": 1753900000,
                               "limit_window_seconds": 604800},
            "secondary_window": {"used_percent": 37, "reset_at": 1753350000,
                                 "limit_window_seconds": 18000},
        },
    })
    weekly = next(w for w in windows if w["kind"] == "weekly")
    session = next(w for w in windows if w["kind"] == "session")
    assert weekly["usedPercent"] == 12.0
    assert session["usedPercent"] == 37.0


def test_normalize_codex_positional_fallback_without_window_minutes():
    # No limit_window_seconds -> fall back to primary=session, secondary=weekly.
    windows, _ = us.normalize_codex({
        "rate_limit": {
            "primary_window": {"used_percent": 5},
            "secondary_window": {"used_percent": 9},
        },
    })
    assert [(w["kind"], w["usedPercent"]) for w in windows] == [
        ("session", 5.0), ("weekly", 9.0)]
    assert all(w["windowMinutes"] is None for w in windows)


def test_codex_credits_parsing():
    windows, _ = us.normalize_codex({"rate_limit": {}})
    assert windows == []
    assert us._codex_credits({}) is None
    assert us._codex_credits({
        "credits": {"has_credits": True, "unlimited": False, "balance": "12.5"},
    }) == {"hasCredits": True, "unlimited": False, "balance": 12.5}
    # Non-numeric balance is preserved as-is.
    assert us._codex_credits({"credits": {"balance": "n/a"}}) == {
        "hasCredits": False, "unlimited": False, "balance": "n/a"}


def test_codex_extra_windows_parsing():
    extra = us._codex_extra_windows({
        "additional_rate_limits": [
            {"limit_name": "gpt-image", "metered_feature": "image_gen",
             "rate_limit": {
                 "primary_window": {"used_percent": 20,
                                    "limit_window_seconds": 18000},
                 "secondary_window": {"used_percent": 80,
                                      "limit_window_seconds": 604800},
             }},
        ],
    })
    assert len(extra) == 1
    assert extra[0]["name"] == "gpt-image"
    kinds = {w["kind"]: w["usedPercent"] for w in extra[0]["windows"]}
    assert kinds == {"session": 20.0, "weekly": 80.0}
    assert us._codex_extra_windows({}) == []


def test_normalize_kimi_string_numbers_and_session():
    # CodexBar's Code-API model nests the 5h rate-limit under limits[0].detail.
    windows, _ = us.normalize_kimi({
        "usage": {"limit": "200", "used": "50", "resetTime": "2026-07-28T00:00:00Z"},
        "limits": [{"window": "5h",
                    "detail": {"limit": 10, "used": 2,
                               "reset_time": "2026-07-24T08:00:00Z"}}],
    })
    weekly = next(w for w in windows if w["kind"] == "weekly")
    assert weekly["usedPercent"] == 25.0
    session = next(w for w in windows if w["kind"] == "session")
    assert session["usedPercent"] == 20.0
    assert session["resetsAt"] == "2026-07-24T08:00:00Z"


def test_normalize_kimi_session_window_reads_nested_detail():
    # Core regression guard: with the 5h window nested in detail, the session
    # window must still emit (top-level limit/used are absent).
    windows, _ = us.normalize_kimi({
        "limits": [{"window": "5h",
                    "detail": {"limit": 100, "used": 40,
                               "resetTime": "2026-07-24T12:00:00Z"}}],
    })
    session = next(w for w in windows if w["kind"] == "session")
    assert session["label"] == "Rate limit (5h)"
    assert session["usedPercent"] == 40.0
    assert session["resetsAt"] == "2026-07-24T12:00:00Z"


def test_normalize_kimi_weekly_remaining_fallback():
    # No "used" — derive it from limit - remaining.
    windows, _ = us.normalize_kimi({
        "usage": {"limit": 200, "remaining": 150},
    })
    weekly = next(w for w in windows if w["kind"] == "weekly")
    assert weekly["usedPercent"] == 25.0


def test_normalize_kimi_reset_at_key():
    windows, _ = us.normalize_kimi({
        "limits": [{"detail": {"limit": 10, "used": 1,
                               "reset_at": "2026-07-24T09:00:00Z"}}],
    })
    session = next(w for w in windows if w["kind"] == "session")
    assert session["resetsAt"] == "2026-07-24T09:00:00Z"


def test_normalize_kimi_zero_limit_is_skipped():
    windows, _ = us.normalize_kimi({"usage": {"limit": 0, "used": 5}})
    assert windows == []


def test_normalize_grok_cents_math():
    windows, _ = us.normalize_grok({
        "billingCycle": {"billingPeriodEnd": "2026-08-01T00:00:00Z"},
        "monthlyLimit": {"val": 3000},
        "usage": {"totalUsed": {"val": 750}},
    })
    assert len(windows) == 1
    assert windows[0]["kind"] == "monthly"
    assert windows[0]["usedPercent"] == 25.0
    assert windows[0]["resetsAt"] == "2026-08-01T00:00:00Z"


def test_normalize_grok_empty():
    windows, _ = us.normalize_grok({})
    assert windows == []


def test_normalize_antigravity_groups_ranked_tightest_first():
    # Verified live shape (2026-07-28): groups[].buckets[] with window,
    # remainingFraction (0..1 remaining) and ISO resetTime.
    windows, plan = us.normalize_antigravity({
        "groups": [
            {"displayName": "Gemini Models", "buckets": [
                {"bucketId": "gemini-weekly", "displayName": "Weekly Limit",
                 "window": "weekly", "resetTime": "2026-07-30T06:18:23Z",
                 "remainingFraction": 0.25},
                {"bucketId": "gemini-5h", "displayName": "Five Hour Limit",
                 "window": "5h", "resetTime": "2026-07-28T20:23:12Z",
                 "remainingFraction": 1},
            ]},
            {"displayName": "Claude and GPT models", "buckets": [
                {"bucketId": "3p-weekly", "displayName": "Weekly Limit",
                 "window": "weekly", "remainingFraction": 0.5},
            ]},
        ],
    })
    assert plan is None
    assert [w["usedPercent"] for w in windows] == [75.0, 50.0, 0.0]
    assert windows[0]["label"] == "Gemini Models — Weekly Limit"
    assert windows[0]["kind"] == "weekly"
    assert windows[0]["resetsAt"] == "2026-07-30T06:18:23Z"
    assert windows[1]["label"] == "Claude and GPT models — Weekly Limit"
    session = next(w for w in windows if w["kind"] == "session")
    assert session["usedPercent"] == 0.0
    assert session["resetsAt"] == "2026-07-28T20:23:12Z"


def test_normalize_antigravity_missing_fraction_means_untouched():
    windows, _ = us.normalize_antigravity({
        "groups": [{"displayName": "G", "buckets": [
            {"bucketId": "b", "displayName": "B", "window": "weekly"}]}],
    })
    assert windows == [{"kind": "weekly", "label": "G — B",
                        "usedPercent": 0.0, "resetsAt": None}]


def test_normalize_antigravity_malformed():
    assert us.normalize_antigravity({}) == ([], None)
    windows, _ = us.normalize_antigravity({
        "groups": [None, {"buckets": None}, {"buckets": [None, "x"]}],
    })
    assert windows == []
    # Unknown window strings pass through; label falls back to bucketId.
    windows, _ = us.normalize_antigravity({
        "groups": [{"buckets": [
            {"bucketId": "b1", "window": "daily", "remainingFraction": 0.9},
            {"bucketId": "b2", "remainingFraction": 0.8},
        ]}],
    })
    assert [(w["kind"], w["label"]) for w in windows] == [
        ("other", "b2"), ("daily", "b1")]


def test_antigravity_plan_and_project_extraction():
    load = {"currentTier": {"id": "free-tier", "name": "Antigravity"},
            "cloudaicompanionProject": "proj-1"}
    assert us.antigravity_plan(load) == "Antigravity"
    assert us.antigravity_project(load) == "proj-1"
    assert us.antigravity_plan({"currentTier": {"id": "free-tier"}}) == "free-tier"
    assert us.antigravity_plan({}) is None
    assert us.antigravity_project({"cloudaicompanionProject": {"id": "p2"}}) == "p2"
    assert us.antigravity_project({"cloudaicompanionProject": {}}) is None
    assert us.antigravity_project({}) is None


def test_normalize_opencode_minimax_general_model():
    # Live-observed shape (2026-07): model_remains[] per model; the coding plan
    # is the model_name == "general" entry; percents are remaining -> used and
    # end times are epoch-ms.
    windows = us.normalize_opencode_minimax({
        "model_remains": [
            {"model_name": "video", "current_interval_remaining_percent": 1},
            {"model_name": "general",
             "end_time": 1753718000000,
             "current_interval_remaining_percent": 80,
             "current_weekly_remaining_percent": 55,
             "weekly_end_time": 1754200000000},
        ],
        "base_resp": {"status_code": 0, "status_msg": "success"},
    })
    session = next(w for w in windows if w["kind"] == "session")
    assert session["label"] == "MiniMax (5h)"
    assert session["usedPercent"] == 20.0
    assert session["resetsAt"].startswith("2025-07-28T")  # epoch-ms -> ISO
    weekly = next(w for w in windows if w["kind"] == "weekly")
    assert weekly["usedPercent"] == 45.0
    assert weekly["resetsAt"].startswith("2025-08-03T")
    assert len(windows) == 2  # the "video" model never contributes


def test_normalize_opencode_minimax_malformed():
    assert us.normalize_opencode_minimax({}) == []
    assert us.normalize_opencode_minimax({"model_remains": [None, "x"]}) == []
    assert us.normalize_opencode_minimax(
        {"model_remains": [{"model_name": "general"}]}) == []
    # Missing end times -> windows without resetsAt.
    windows = us.normalize_opencode_minimax({
        "model_remains": [{"model_name": "general",
                           "current_interval_remaining_percent": 100}]})
    assert windows == [{"kind": "session", "label": "MiniMax (5h)",
                        "usedPercent": 0.0, "resetsAt": None}]


def test_normalize_qwen_windows_and_plan():
    windows, plan = us.normalize_qwen({
        # data/statusCode envelope: found by deep key search, like CodexBar.
        "data": {"codingPlanInstanceInfos": [{
            "planName": "Coding Plan Pro",
            "per5HourUsedQuota": 25, "per5HourTotalQuota": 100,
            "per5HourQuotaNextRefreshTime": 1753718000000,  # epoch ms
            "perWeekUsedQuota": "300", "perWeekTotalQuota": "1000",
            "perWeekQuotaNextRefreshTime": 1754200000,  # epoch s
            "perBillMonthUsedQuota": 3, "perBillMonthTotalQuota": 10,
            "perBillMonthQuotaNextRefreshTime": "2026-08-01 00:00:00",
        }]},
    })
    assert plan == "Coding Plan Pro"
    assert [(w["kind"], w["label"], w["usedPercent"]) for w in windows] == [
        ("session", "Session (5h)", 25.0),
        ("weekly", "Weekly", 30.0),
        ("monthly", "Monthly", 30.0),
    ]
    assert windows[0]["resetsAt"] == us._epoch_to_iso(1753718000)
    assert windows[1]["resetsAt"] == us._epoch_to_iso(1754200000)
    assert windows[2]["resetsAt"] == "2026-08-01T00:00:00+00:00"


def test_normalize_qwen_malformed_and_zero_total():
    assert us.normalize_qwen({}) == ([], None)
    assert us.normalize_qwen({"codingPlanInstanceInfos": "nope"}) == ([], None)
    # Junk entries and zero-total instances are skipped; the first instance
    # with a usable window wins (instanceName as the plan fallback).
    windows, plan = us.normalize_qwen({"codingPlanInstanceInfos": [
        "junk",
        {"instanceName": "Empty", "per5HourUsedQuota": 1, "per5HourTotalQuota": 0},
        {"instanceName": "Plan B", "perWeekUsedQuota": 1, "perWeekTotalQuota": 4,
         "perWeekQuotaNextRefreshTime": "not-a-date"},
    ]})
    assert plan == "Plan B"
    assert [(w["kind"], w["usedPercent"], w["resetsAt"]) for w in windows] == [
        ("weekly", 25.0, None)]


def test_normalize_kilo_balance_credits_window():
    windows = us.normalize_kilo_balance({"balance": 12.34})
    assert windows == [{"kind": "credits", "label": "Credits",
                        "usedPercent": 0.0, "resetsAt": None,
                        "balance": 12.34}]
    # Numbers may arrive as strings; the raw balance survives as a float.
    assert us.normalize_kilo_balance({"balance": "5"})[0]["balance"] == 5.0


def test_normalize_kilo_balance_malformed():
    assert us.normalize_kilo_balance({}) == []
    assert us.normalize_kilo_balance({"balance": None}) == []
    assert us.normalize_kilo_balance({"balance": "n/a"}) == []


def test_normalize_kilo_pass_batched_and_unbatched():
    sub = {"currentPeriodBaseCreditsUsd": 20, "currentPeriodUsageUsd": 6,
           "currentPeriodBonusCreditsUsd": 4,
           "nextBillingAt": "2026-08-15T00:00:00Z"}
    batched = [{"result": {"data": {"json": {"subscription": sub}}}}]
    assert us.normalize_kilo_pass(batched) == [{
        "kind": "period", "label": "Kilo Pass period",
        "usedPercent": 25.0, "resetsAt": "2026-08-15T00:00:00Z"}]
    # Unbatched / json-less nesting parses the same.
    assert us.normalize_kilo_pass({"result": {"data": {"subscription": sub}}}) \
        == us.normalize_kilo_pass(batched)
    assert us.normalize_kilo_pass({"subscription": sub}) \
        == us.normalize_kilo_pass(batched)


def test_normalize_kilo_pass_no_subscription_and_malformed():
    # null subscription = no Kilo Pass.
    assert us.normalize_kilo_pass(
        [{"result": {"data": {"json": {"subscription": None}}}}]) == []
    assert us.normalize_kilo_pass([]) == []
    assert us.normalize_kilo_pass("junk") == []
    assert us.normalize_kilo_pass({"subscription": {
        "currentPeriodBaseCreditsUsd": 0, "currentPeriodUsageUsd": 1}}) == []
    assert us.normalize_kilo_pass({"subscription": {
        "currentPeriodBaseCreditsUsd": 10}}) == []
    # Missing/null nextBillingAt -> no resetsAt.
    windows = us.normalize_kilo_pass({"subscription": {
        "currentPeriodBaseCreditsUsd": 10, "currentPeriodUsageUsd": 5,
        "nextBillingAt": None}})
    assert windows[0]["resetsAt"] is None


def test_normalize_pi_openrouter_with_limit_and_unlimited():
    windows = us.normalize_pi_openrouter(
        {"data": {"usage": 2.5, "limit": 10, "is_free_tier": False}})
    assert windows == [{
        "kind": "credits", "label": "OpenRouter credits", "usedPercent": 25.0,
        "resetsAt": None, "usage": 2.5, "limit": 10.0,
    }]
    # A null limit (unlimited key) surfaces the raw usage with 0% used.
    windows = us.normalize_pi_openrouter({"data": {"usage": 7.2, "limit": None}})
    assert windows[0]["usedPercent"] == 0.0
    assert windows[0]["usage"] == 7.2
    assert windows[0]["limit"] is None


def test_normalize_pi_openrouter_malformed():
    assert us.normalize_pi_openrouter({}) == []
    assert us.normalize_pi_openrouter({"data": "not-a-dict"}) == []
    assert us.normalize_pi_openrouter({"data": {"limit": 10}}) == []
    assert us.normalize_pi_openrouter({"data": {"usage": "junk"}}) == []


def test_normalize_copilot_windows_and_plan():
    # Shape observed live (free-limited individual plan): premium has no quota
    # and is skipped; the others map 100 - percent_remaining.
    windows, plan = us.normalize_copilot({
        "login": "octo",
        "copilot_plan": "individual",
        "quota_reset_date": "2026-08-01",
        "quota_reset_date_utc": "2026-08-01T00:00:00.000Z",
        "quota_snapshots": {
            "chat": {"percent_remaining": 98.7, "has_quota": True,
                     "remaining": 197, "entitlement": 200, "unlimited": False},
            "completions": {"percent_remaining": 100.0, "has_quota": True,
                            "remaining": 2000, "entitlement": 2000},
            "premium_interactions": {"percent_remaining": 0.0,
                                     "has_quota": False, "remaining": 0},
        },
    })
    assert plan == "individual"
    assert windows == [
        {"kind": "monthly", "label": "Chat", "usedPercent": 1.3,
         "resetsAt": "2026-08-01T00:00:00.000Z"},
        {"kind": "monthly", "label": "Completions", "usedPercent": 0.0,
         "resetsAt": "2026-08-01T00:00:00.000Z"},
    ]


def test_normalize_copilot_malformed():
    assert us.normalize_copilot({}) == ([], None)
    assert us.normalize_copilot({"quota_snapshots": [], "copilot_plan": "biz"}) \
        == ([], "biz")
    windows, plan = us.normalize_copilot({
        "quota_snapshots": {
            "chat": {"has_quota": True, "percent_remaining": "n/a"},
            "completions": "not-a-dict",
        },
    })
    assert (windows, plan) == ([], None)
    # No quota_reset_date_utc -> resetsAt None.
    windows, _ = us.normalize_copilot({
        "quota_snapshots": {"chat": {"has_quota": True, "percent_remaining": 40}},
    })
    assert windows == [{"kind": "monthly", "label": "Chat",
                        "usedPercent": 60.0, "resetsAt": None}]


def test_normalize_cursor_plan_and_on_demand():
    # usage-summary shape per CodexBar's CursorUsageSummary models: cent
    # amounts; totalPercentUsed is already in percent units.
    windows, plan = us.normalize_cursor({
        "billingCycleStart": "2026-07-18T02:00:32.193Z",
        "billingCycleEnd": "2026-08-18T02:00:32.193Z",
        "membershipType": "pro",
        "limitType": "soft",
        "isUnlimited": False,
        "individualUsage": {
            "plan": {"enabled": True, "used": 850, "limit": 2000,
                     "remaining": 1150, "totalPercentUsed": 42.5},
            "onDemand": {"enabled": True, "used": 100, "limit": 500,
                         "remaining": 400},
        },
    })
    assert plan == "pro"
    assert windows == [
        {"kind": "cycle", "label": "Plan usage", "usedPercent": 42.5,
         "resetsAt": "2026-08-18T02:00:32.193Z"},
        {"kind": "on-demand", "label": "On-demand", "usedPercent": 20.0,
         "resetsAt": "2026-08-18T02:00:32.193Z"},
    ]


def test_normalize_cursor_used_limit_fallback():
    # No totalPercentUsed -> used/limit; disabled on-demand never contributes.
    windows, plan = us.normalize_cursor({
        "membershipType": "free_trial",
        "individualUsage": {
            "plan": {"enabled": True, "used": 500, "limit": 2000},
            "onDemand": {"enabled": False, "used": 1, "limit": 10},
        },
    })
    assert plan == "free_trial"
    assert windows == [{"kind": "cycle", "label": "Plan usage",
                        "usedPercent": 25.0, "resetsAt": None}]


def test_normalize_cursor_malformed():
    assert us.normalize_cursor({}) == ([], None)
    assert us.normalize_cursor({"individualUsage": "not-a-dict"}) == ([], None)
    assert us.normalize_cursor({
        "membershipType": 7,  # non-string plan is dropped
        "individualUsage": {"plan": {"used": 5, "limit": 0},  # zero limit
                            "onDemand": {"enabled": True, "used": 1}},  # no limit
    }) == ([], None)
    assert us.parse_retry_after("42") == 42.0
    assert us.parse_retry_after("0") == 1.0
    assert us.parse_retry_after(None) == us.RATE_LIMIT_COOLDOWN
    assert us.parse_retry_after("Thu, 24 Jul 2026 00:00:00 GMT") == us.RATE_LIMIT_COOLDOWN


# ── Antigravity fetch (fake httpx transport) ────────────────────────────────

class _FakeResponse:
    def __init__(self, status_code=200, payload=None, headers=None):
        self.status_code = status_code
        self._payload = {} if payload is None else payload
        self.headers = headers or {}

    def json(self):
        return self._payload

    def raise_for_status(self):
        import httpx

        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}", request=None, response=None)


def _fake_httpx(monkeypatch, responses: dict) -> list:
    """Route AsyncClient GETs/POSTs by URL (a _FakeResponse, or an exception
    to raise). Returns the recorded (url, kwargs) calls."""
    import httpx

    calls: list = []

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, **kwargs):
            calls.append((url, kwargs))
            resp = responses[url]
            if isinstance(resp, Exception):
                raise resp
            return resp

        async def get(self, url, **kwargs):
            return await self.post(url, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    return calls


def _with_antigravity_refresh_token(monkeypatch, token="1//rt"):
    async def fake_read(home):
        return token

    monkeypatch.setattr(antigravity_vendor, "read_antigravity_credentials", fake_read)


async def test_fetch_antigravity_no_credentials(monkeypatch):
    _with_antigravity_refresh_token(monkeypatch, token=None)
    snap = await us.fetch_antigravity(Path("/nonexistent"))
    assert snap["status"] == "no-credentials"


async def test_fetch_antigravity_needs_operator_supplied_oauth_config(monkeypatch):
    """Enabling this provider is a deliberate act, not something a build ships.

    Minting the access token needs Antigravity's own OAuth client credentials.
    This app neither bundles nor stores them, so with the environment unset the
    account still reads as signed in and the quota says why it is missing —
    without any request going out."""
    _with_antigravity_refresh_token(monkeypatch)
    monkeypatch.setattr(antigravity_vendor, "ANTIGRAVITY_CLIENT_ID", "")
    monkeypatch.setattr(antigravity_vendor, "ANTIGRAVITY_CLIENT_SECRET", "")
    calls = _fake_httpx(monkeypatch, {})

    snap = await us.fetch_antigravity(Path("/x"))

    assert snap["status"] == "unavailable"
    assert snap["error"] == antigravity_vendor.ANTIGRAVITY_NEEDS_OAUTH_CONFIG
    assert calls == []


def _with_antigravity_oauth_config(monkeypatch):
    monkeypatch.setattr(antigravity_vendor, "ANTIGRAVITY_CLIENT_ID", "cid")
    monkeypatch.setattr(antigravity_vendor, "ANTIGRAVITY_CLIENT_SECRET", "csec")


async def test_fetch_antigravity_reads_the_quota_when_configured(monkeypatch):
    _with_antigravity_refresh_token(monkeypatch)
    _with_antigravity_oauth_config(monkeypatch)
    calls = _fake_httpx(monkeypatch, {
        antigravity_vendor.ANTIGRAVITY_TOKEN_URL: _FakeResponse(200, {"access_token": "ya29.new"}),
        antigravity_vendor.ANTIGRAVITY_LOAD_URL: _FakeResponse(200, {
            "currentTier": {"id": "free-tier", "name": "Antigravity"},
            "cloudaicompanionProject": "proj-1",
        }),
        antigravity_vendor.ANTIGRAVITY_QUOTA_URL: _FakeResponse(200, {
            "groups": [{"displayName": "Gemini Models", "buckets": [
                {"bucketId": "gemini-weekly", "displayName": "Weekly Limit",
                 "window": "weekly", "resetTime": "2026-07-30T06:18:23Z",
                 "remainingFraction": 0.22621265},
            ]}],
        }),
    })

    snap = await us.fetch_antigravity(Path("/x"))

    assert snap["status"] == "ok"
    assert snap["planType"] == "Antigravity"
    assert snap["windows"] == [{
        "kind": "weekly", "label": "Gemini Models — Weekly Limit",
        "usedPercent": 77.4, "resetsAt": "2026-07-30T06:18:23Z",
    }]
    quota_kwargs = next(kw for url, kw in calls if url == antigravity_vendor.ANTIGRAVITY_QUOTA_URL)
    assert quota_kwargs["json"] == {"project": "proj-1"}
    assert quota_kwargs["headers"]["Authorization"] == "Bearer ya29.new"
    # The quota call no longer claims to be the vendor's own client.
    assert quota_kwargs["headers"]["User-Agent"] == "Navide"


async def test_fetch_antigravity_never_writes_the_minted_token_back(monkeypatch):
    """The access token lives in memory for one call. Google's grant returns no
    new refresh token, so nothing the CLI owns rotates — the failure mode that
    killed Claude accounts cannot happen here."""
    _with_antigravity_refresh_token(monkeypatch)
    _with_antigravity_oauth_config(monkeypatch)
    calls = _fake_httpx(monkeypatch, {
        antigravity_vendor.ANTIGRAVITY_TOKEN_URL: _FakeResponse(200, {"access_token": "ya29.x"}),
        antigravity_vendor.ANTIGRAVITY_LOAD_URL: _FakeResponse(403, {}),
        antigravity_vendor.ANTIGRAVITY_QUOTA_URL: _FakeResponse(200, {"groups": []}),
    })

    await us.fetch_antigravity(Path("/x"))

    token_kwargs = next(kw for url, kw in calls if url == antigravity_vendor.ANTIGRAVITY_TOKEN_URL)
    assert token_kwargs["data"]["grant_type"] == "refresh_token"
    assert token_kwargs["data"]["refresh_token"] == "1//rt"
    # Nothing in the response is persisted; only the request carried a secret.
    assert all(url != antigravity_vendor.ANTIGRAVITY_TOKEN_URL or "json" not in kw
               for url, kw in calls)


async def test_fetch_antigravity_expired_grant_reads_as_expired(monkeypatch):
    _with_antigravity_refresh_token(monkeypatch)
    _with_antigravity_oauth_config(monkeypatch)
    _fake_httpx(monkeypatch, {
        antigravity_vendor.ANTIGRAVITY_TOKEN_URL: _FakeResponse(400, {"error": "invalid_grant"}),
    })

    snap = await us.fetch_antigravity(Path("/x"))

    assert snap["status"] == "expired"


# ── opencode fetch (aggregator over auth.json entries) ──────────────────────

def _with_opencode_auth(monkeypatch, auth: dict | None):
    monkeypatch.setattr(opencode_vendor, "read_opencode_credentials", lambda home, env=None: auth)


async def test_fetch_opencode_no_credentials(monkeypatch):
    _with_opencode_auth(monkeypatch, None)
    snap = await us.fetch_opencode(Path("/nonexistent"))
    assert snap["status"] == "no-credentials"


async def test_fetch_opencode_byok_only_is_unavailable(monkeypatch):
    # Plain API keys (e.g. a Gemini BYOK key) have no server-side quota; an
    # opencode Zen entry has no usage endpoint either.
    _with_opencode_auth(monkeypatch, {
        "google": {"type": "api", "key": "AIza-x"},
        "opencode": {"type": "oauth", "access": "a", "refresh": "r"},
    })
    snap = await us.fetch_opencode(Path("/x"))
    assert snap["status"] == "unavailable"
    assert "no auth.json entry" in snap["error"]


async def test_fetch_opencode_minimax_happy_path(monkeypatch):
    _with_opencode_auth(monkeypatch, {
        "minimax-coding-plan": {"type": "api", "key": "sk-cp-x"}})
    calls = _fake_httpx(monkeypatch, {
        us.OPENCODE_MINIMAX_USAGE_URL: _FakeResponse(200, {
            "model_remains": [{
                "model_name": "general",
                "end_time": 1753718000000,
                "current_interval_remaining_percent": 80,
                "current_weekly_remaining_percent": 55,
                "weekly_end_time": 1754200000000,
            }],
            "base_resp": {"status_code": 0, "status_msg": "success"},
        }),
    })
    snap = await us.fetch_opencode(Path("/x"))
    assert snap["status"] == "ok"
    assert [(w["kind"], w["usedPercent"]) for w in snap["windows"]] == [
        ("session", 20.0), ("weekly", 45.0)]
    kwargs = next(kw for url, kw in calls if url == us.OPENCODE_MINIMAX_USAGE_URL)
    assert kwargs["headers"]["Authorization"] == "Bearer sk-cp-x"


async def test_fetch_opencode_minimax_statuses(monkeypatch):
    _with_opencode_auth(monkeypatch, {
        "minimax-coding-plan": {"type": "api", "key": "sk-cp-x"}})
    for status, expected in ((401, "expired"), (403, "expired"), (500, "error")):
        _fake_httpx(monkeypatch, {
            us.OPENCODE_MINIMAX_USAGE_URL: _FakeResponse(status, {})})
        snap = await us.fetch_opencode(Path("/x"))
        assert snap["status"] == expected

    _fake_httpx(monkeypatch, {
        us.OPENCODE_MINIMAX_USAGE_URL: _FakeResponse(
            429, {}, headers={"Retry-After": "88"})})
    snap = await us.fetch_opencode(Path("/x"))
    assert snap["status"] == "rate-limited"
    assert snap["retryAfterSec"] == 88.0

    # MiniMax tunnels auth errors through HTTP 200 + base_resp.status_code != 0.
    _fake_httpx(monkeypatch, {
        us.OPENCODE_MINIMAX_USAGE_URL: _FakeResponse(200, {
            "base_resp": {"status_code": 1004, "status_msg": "login fail"}})})
    snap = await us.fetch_opencode(Path("/x"))
    assert snap["status"] == "error"
    assert snap["error"] == "login fail"


async def test_fetch_opencode_anthropic_entry_reuses_claude_flow(monkeypatch):
    _with_opencode_auth(monkeypatch, {
        "anthropic": {"type": "oauth", "access": "at",
                      "expires": 2_000_000_000_000}})

    async def fake_claude(oauth):
        assert oauth == {"accessToken": "at", "expiresAt": 2_000_000_000_000}
        return us._snapshot(
            "claude", "ok",
            windows=[us._window("session", "Session (5h)", 42, None)])

    monkeypatch.setattr(protocols_vendor, "fetch_claude_oauth", fake_claude)
    snap = await us.fetch_opencode(Path("/x"))
    assert snap["provider"] == "opencode"
    assert snap["status"] == "ok"
    assert [(w["kind"], w["label"], w["usedPercent"]) for w in snap["windows"]] == [
        ("session", "Claude — Session (5h)", 42.0)]


async def test_fetch_opencode_mixed_sources_ok_wins(monkeypatch):
    # minimax fails, anthropic answers -> snapshot is "ok" with only the
    # answering source's windows.
    _with_opencode_auth(monkeypatch, {
        "minimax-coding-plan": {"type": "api", "key": "sk-cp-x"},
        "anthropic": {"type": "oauth", "access": "at"},
    })
    _fake_httpx(monkeypatch, {
        us.OPENCODE_MINIMAX_USAGE_URL: _FakeResponse(500, {})})

    async def fake_claude(oauth):
        return us._snapshot(
            "claude", "ok",
            windows=[us._window("weekly", "Weekly", 5, None)])

    monkeypatch.setattr(protocols_vendor, "fetch_claude_oauth", fake_claude)
    snap = await us.fetch_opencode(Path("/x"))
    assert snap["status"] == "ok"
    assert [w["label"] for w in snap["windows"]] == ["Claude — Weekly"]


async def test_fetch_opencode_first_failure_surfaced_when_none_answer(monkeypatch):
    _with_opencode_auth(monkeypatch, {
        "minimax-coding-plan": {"type": "api", "key": "sk-cp-x"}})
    _fake_httpx(monkeypatch, {
        us.OPENCODE_MINIMAX_USAGE_URL: _FakeResponse(401, {})})
    snap = await us.fetch_opencode(Path("/x"))
    assert snap["provider"] == "opencode"
    assert snap["status"] == "expired"


# ── qwen fetch (ModelStudio Coding Plan console gateway) ────────────────────

def _with_qwen_key(monkeypatch, key="sk-sp-test"):
    monkeypatch.setattr(qwen_vendor, "read_qwen_credentials", lambda home, env=None: key)


async def test_fetch_qwen_no_credentials_and_legacy_oauth(tmp_path):
    snap = await us.fetch_qwen(tmp_path, {})
    assert snap["status"] == "no-credentials"
    _write(tmp_path / ".qwen" / "oauth_creds.json",
           {"access_token": "t", "refresh_token": "r"})
    snap = await us.fetch_qwen(tmp_path, {})
    assert snap["status"] == "unavailable"
    assert "Coding Plan API key" in snap["error"]


async def test_fetch_qwen_reads_the_quota_without_a_browser_costume(
    tmp_path, monkeypatch
):
    """The API key is what the gateway authenticates; the browser User-Agent it
    used to send was decoration. Origin/Referer stay — the gateway refuses
    cross-site posts without them, and they name the console the endpoint
    belongs to rather than claiming to be its client."""
    _with_qwen_key(monkeypatch)
    calls = _fake_httpx(monkeypatch, {
        us.QWEN_INTL_USAGE_URL: _FakeResponse(200, {
            "data": {"codingPlanInstanceInfos": [{
                "planName": "Pro",
                "per5HourUsedQuota": 10, "per5HourTotalQuota": 40,
            }]},
        }),
    })

    snap = await us.fetch_qwen(tmp_path, {})

    assert snap["status"] == "ok"
    assert snap["planType"] == "Pro"
    assert [(w["kind"], w["usedPercent"]) for w in snap["windows"]] == [
        ("session", 25.0)]
    assert len(calls) == 1  # intl answered: no CN retry
    headers = calls[0][1]["headers"]
    assert headers["User-Agent"] == "Navide"
    assert "Mozilla" not in headers["User-Agent"]
    assert headers["Authorization"] == "Bearer sk-sp-test"
    assert headers["Origin"] == "https://modelstudio.console.alibabacloud.com"


async def test_fetch_qwen_retries_the_other_region(tmp_path, monkeypatch):
    """A region that refuses is retried against the alternate one."""
    _with_qwen_key(monkeypatch)
    calls = _fake_httpx(monkeypatch, {
        us.QWEN_INTL_USAGE_URL: _FakeResponse(500, {}),
        us.QWEN_CN_USAGE_URL: _FakeResponse(200, {
            "codingPlanInstanceInfos": [{
                "perWeekUsedQuota": 5, "perWeekTotalQuota": 10}]}),
    })

    snap = await us.fetch_qwen(tmp_path, {})

    assert snap["status"] == "ok"
    assert [url for url, _ in calls] == [us.QWEN_INTL_USAGE_URL,
                                         us.QWEN_CN_USAGE_URL]
    cn_body = calls[1][1]["json"]["queryCodingPlanInstanceInfoRequest"]
    assert cn_body["commodityCode"] == "sfm_codingplan_public_cn"


async def test_fetch_qwen_tunnelled_auth_failure_is_expired(tmp_path, monkeypatch):
    """The gateway answers 200 with a NeedLogin marker instead of a 401."""
    _with_qwen_key(monkeypatch)
    _fake_httpx(monkeypatch, {
        us.QWEN_INTL_USAGE_URL: _FakeResponse(200, {"code": "NeedLogin"}),
        us.QWEN_CN_USAGE_URL: _FakeResponse(200, {"code": "NeedLogin"}),
    })  # both regions tunnel the same auth failure

    snap = await us.fetch_qwen(tmp_path, {})

    assert snap["status"] == "expired"


# ── kilo fetch (credit balance + best-effort Kilo Pass) ─────────────────────

_KILO_BALANCE_URL = us.KILO_DEFAULT_BASE + us.KILO_BALANCE_PATH
_KILO_PASS_URL = us.KILO_DEFAULT_BASE + us.KILO_PASS_PATH


def _with_kilo_creds(monkeypatch, creds={"token": "kilo-tok", "org_id": None}):
    monkeypatch.setattr(kilo_vendor, "read_kilo_credentials", lambda home, env=None, *, bound_store=False: creds)


async def test_fetch_kilo_no_credentials(monkeypatch):
    _with_kilo_creds(monkeypatch, creds=None)
    snap = await us.fetch_kilo(Path("/nonexistent"), {})
    assert snap["status"] == "no-credentials"


async def test_fetch_kilo_happy_path_with_pass(monkeypatch):
    _with_kilo_creds(monkeypatch,
                     creds={"token": "kilo-tok", "org_id": "org-1"})
    calls = _fake_httpx(monkeypatch, {
        _KILO_BALANCE_URL: _FakeResponse(200, {"balance": 42.5}),
        _KILO_PASS_URL: _FakeResponse(200, [{"result": {"data": {"json": {
            "subscription": {
                "currentPeriodBaseCreditsUsd": 20,
                "currentPeriodUsageUsd": 5,
                "currentPeriodBonusCreditsUsd": 0,
                "nextBillingAt": "2026-08-15T00:00:00Z"}}}}}]),
    })
    snap = await us.fetch_kilo(Path("/x"), {})
    assert snap["status"] == "ok"
    assert snap["windows"] == [
        {"kind": "credits", "label": "Credits", "usedPercent": 0.0,
         "resetsAt": None, "balance": 42.5},
        {"kind": "period", "label": "Kilo Pass period", "usedPercent": 25.0,
         "resetsAt": "2026-08-15T00:00:00Z"},
    ]
    kwargs = next(kw for url, kw in calls if url == _KILO_BALANCE_URL)
    assert kwargs["headers"]["Authorization"] == "Bearer kilo-tok"
    assert kwargs["headers"]["X-KILOCODE-ORGANIZATIONID"] == "org-1"


async def test_fetch_kilo_pass_failure_keeps_balance(monkeypatch):
    import httpx

    _with_kilo_creds(monkeypatch)
    for pass_resp in (_FakeResponse(500, {}), httpx.ConnectError("no network")):
        calls = _fake_httpx(monkeypatch, {
            _KILO_BALANCE_URL: _FakeResponse(200, {"balance": 7}),
            _KILO_PASS_URL: pass_resp,
        })
        snap = await us.fetch_kilo(Path("/x"), {})
        assert snap["status"] == "ok"
        assert [w["kind"] for w in snap["windows"]] == ["credits"]
        # No org header without an organization id.
        kwargs = next(kw for url, kw in calls if url == _KILO_BALANCE_URL)
        assert "X-KILOCODE-ORGANIZATIONID" not in kwargs["headers"]


async def test_fetch_kilo_statuses(monkeypatch):
    _with_kilo_creds(monkeypatch)
    for status, expected in ((401, "expired"), (403, "expired"), (500, "error")):
        _fake_httpx(monkeypatch, {
            _KILO_BALANCE_URL: _FakeResponse(status, {})})
        snap = await us.fetch_kilo(Path("/x"), {})
        assert snap["status"] == expected

    _fake_httpx(monkeypatch, {
        _KILO_BALANCE_URL: _FakeResponse(
            429, {}, headers={"Retry-After": "99"})})
    snap = await us.fetch_kilo(Path("/x"), {})
    assert snap["status"] == "rate-limited"
    assert snap["retryAfterSec"] == 99.0

    # HTTP 200 with no usable balance and no Pass -> error.
    _fake_httpx(monkeypatch, {
        _KILO_BALANCE_URL: _FakeResponse(200, {"unexpected": 1}),
        _KILO_PASS_URL: _FakeResponse(200, [{"result": {"data": {"json": {
            "subscription": None}}}}]),
    })
    snap = await us.fetch_kilo(Path("/x"), {})
    assert snap["status"] == "error"
    assert "no usable fields" in snap["error"]


# ── pi fetch (aggregator over auth.json entries) ────────────────────────────

_PI_CODEX_USAGE_URL = us.codex_usage_url(us.CODEX_DEFAULT_BASE)


def _with_pi_auth(monkeypatch, auth: dict | None):
    monkeypatch.setattr(pi_vendor, "read_pi_credentials", lambda home, env=None: auth)


async def test_fetch_pi_no_credentials(monkeypatch):
    _with_pi_auth(monkeypatch, None)
    snap = await us.fetch_pi(Path("/nonexistent"), {})
    assert snap["status"] == "no-credentials"


async def test_fetch_pi_byok_only_is_unavailable(monkeypatch):
    # Plain API keys are BYOK with no server-side quota; github-copilot/xai/
    # radius oauth entries have no known public usage endpoint either.
    _with_pi_auth(monkeypatch, {
        "openai": {"type": "api_key", "key": "sk-x"},
        "github-copilot": {"type": "oauth", "access": "a", "refresh": "r"},
    })
    snap = await us.fetch_pi(Path("/x"), {})
    assert snap["status"] == "unavailable"
    assert "no auth.json credential" in snap["error"]


async def test_fetch_pi_anthropic_entry_reuses_claude_flow(monkeypatch):
    _with_pi_auth(monkeypatch, {
        "anthropic": {"type": "oauth", "access": "sk-ant-oat",
                      "expires": 2_000_000_000_000}})

    async def fake_claude(oauth):
        assert oauth == {"accessToken": "sk-ant-oat",
                         "expiresAt": 2_000_000_000_000}
        return us._snapshot(
            "claude", "ok",
            windows=[us._window("session", "Session (5h)", 42, None)])

    monkeypatch.setattr(protocols_vendor, "fetch_claude_oauth", fake_claude)
    snap = await us.fetch_pi(Path("/x"), {})
    assert snap["provider"] == "pi"
    assert snap["status"] == "ok"
    assert [(w["kind"], w["label"], w["usedPercent"]) for w in snap["windows"]] == [
        ("session", "Claude — Session (5h)", 42.0)]


async def test_fetch_pi_anthropic_expired_locally(monkeypatch):
    # fetch_claude_oauth checks the mapped expiresAt before any request.
    _with_pi_auth(monkeypatch, {
        "anthropic": {"type": "oauth", "access": "sk-ant-oat", "expires": 1_000}})
    snap = await us.fetch_pi(Path("/x"), {})
    assert snap["provider"] == "pi"
    assert snap["status"] == "expired"


async def test_fetch_pi_codex_happy_path(monkeypatch):
    _with_pi_auth(monkeypatch, {
        "openai-codex": {"type": "oauth", "access": "cx-at",
                         "expires": 2_000_000_000_000, "accountId": "acct-1"}})
    calls = _fake_httpx(monkeypatch, {
        _PI_CODEX_USAGE_URL: _FakeResponse(200, {
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {"used_percent": 12.5,
                                   "limit_window_seconds": 18000,
                                   "reset_at": 1753718400},
            },
        }),
    })
    snap = await us.fetch_pi(Path("/x"), {})
    assert snap["status"] == "ok"
    assert [(w["kind"], w["label"], w["usedPercent"]) for w in snap["windows"]] == [
        ("session", "Codex — Session (5h)", 12.5)]
    kwargs = next(kw for url, kw in calls if url == _PI_CODEX_USAGE_URL)
    assert kwargs["headers"]["Authorization"] == "Bearer cx-at"
    assert kwargs["headers"]["ChatGPT-Account-Id"] == "acct-1"


async def test_fetch_pi_codex_expired_locally_and_statuses(monkeypatch):
    # An expires in the past never hits the network (tokens are not refreshed).
    _with_pi_auth(monkeypatch, {
        "openai-codex": {"type": "oauth", "access": "cx-at", "expires": 1_000}})
    snap = await us.fetch_pi(Path("/x"), {})
    assert snap["status"] == "expired"

    _with_pi_auth(monkeypatch, {
        "openai-codex": {"type": "oauth", "access": "cx-at"}})
    for status, expected in ((401, "expired"), (403, "expired"), (500, "error")):
        _fake_httpx(monkeypatch, {
            _PI_CODEX_USAGE_URL: _FakeResponse(status, {})})
        snap = await us.fetch_pi(Path("/x"), {})
        assert snap["status"] == expected

    _fake_httpx(monkeypatch, {
        _PI_CODEX_USAGE_URL: _FakeResponse(
            429, {}, headers={"Retry-After": "66"})})
    snap = await us.fetch_pi(Path("/x"), {})
    assert snap["status"] == "rate-limited"
    assert snap["retryAfterSec"] == 66.0


async def test_fetch_pi_openrouter_happy_path(monkeypatch):
    _with_pi_auth(monkeypatch, {
        "openrouter": {"type": "api_key", "key": "sk-or-x"}})
    calls = _fake_httpx(monkeypatch, {
        us.PI_OPENROUTER_KEY_URL: _FakeResponse(200, {
            "data": {"usage": 3, "limit": 12, "is_free_tier": False}}),
    })
    snap = await us.fetch_pi(Path("/x"), {})
    assert snap["status"] == "ok"
    assert [(w["kind"], w["usedPercent"]) for w in snap["windows"]] == [
        ("credits", 25.0)]
    kwargs = next(kw for url, kw in calls if url == us.PI_OPENROUTER_KEY_URL)
    assert kwargs["headers"]["Authorization"] == "Bearer sk-or-x"


async def test_fetch_pi_openrouter_statuses(monkeypatch):
    _with_pi_auth(monkeypatch, {
        "openrouter": {"type": "api_key", "key": "sk-or-x"}})
    for status, expected in ((401, "expired"), (403, "expired"), (500, "error")):
        _fake_httpx(monkeypatch, {
            us.PI_OPENROUTER_KEY_URL: _FakeResponse(status, {})})
        snap = await us.fetch_pi(Path("/x"), {})
        assert snap["status"] == expected

    _fake_httpx(monkeypatch, {
        us.PI_OPENROUTER_KEY_URL: _FakeResponse(
            429, {}, headers={"Retry-After": "55"})})
    snap = await us.fetch_pi(Path("/x"), {})
    assert snap["status"] == "rate-limited"
    assert snap["retryAfterSec"] == 55.0

    # HTTP 200 with no usable fields -> error.
    _fake_httpx(monkeypatch, {
        us.PI_OPENROUTER_KEY_URL: _FakeResponse(200, {"data": {}})})
    snap = await us.fetch_pi(Path("/x"), {})
    assert snap["status"] == "error"
    assert "no usable fields" in snap["error"]


async def test_fetch_pi_mixed_sources_ok_wins(monkeypatch):
    # openrouter fails, anthropic answers -> snapshot is "ok" with only the
    # answering source's windows.
    _with_pi_auth(monkeypatch, {
        "anthropic": {"type": "oauth", "access": "sk-ant-oat"},
        "openrouter": {"type": "api_key", "key": "sk-or-x"},
    })
    _fake_httpx(monkeypatch, {
        us.PI_OPENROUTER_KEY_URL: _FakeResponse(500, {})})

    async def fake_claude(oauth):
        return us._snapshot(
            "claude", "ok",
            windows=[us._window("weekly", "Weekly", 5, None)])

    monkeypatch.setattr(protocols_vendor, "fetch_claude_oauth", fake_claude)
    snap = await us.fetch_pi(Path("/x"), {})
    assert snap["status"] == "ok"
    assert [w["label"] for w in snap["windows"]] == ["Claude — Weekly"]


async def test_fetch_pi_first_failure_surfaced_when_none_answer(monkeypatch):
    _with_pi_auth(monkeypatch, {
        "openrouter": {"type": "api_key", "key": "sk-or-x"}})
    _fake_httpx(monkeypatch, {
        us.PI_OPENROUTER_KEY_URL: _FakeResponse(401, {})})
    snap = await us.fetch_pi(Path("/x"), {})
    assert snap["provider"] == "pi"
    assert snap["status"] == "expired"


# ── copilot fetch (gh-resolved token against copilot_internal/user) ─────────

_COPILOT_USAGE_URL = us.copilot_usage_url("github.com")


def _with_copilot_gh_token(monkeypatch, token="gho_test"):
    monkeypatch.setattr(copilot_vendor, "read_copilot_config",
                        lambda home: {"host": "github.com", "login": "octo"})

    async def fake_token(login, host):
        assert (login, host) == ("octo", "github.com")
        return token

    monkeypatch.setattr(copilot_vendor, "_copilot_gh_token", fake_token)


async def test_fetch_copilot_no_credentials(monkeypatch):
    monkeypatch.setattr(copilot_vendor, "read_copilot_config", lambda home: None)
    snap = await us.fetch_copilot(Path("/nonexistent"), {})
    assert snap["status"] == "no-credentials"


async def test_fetch_copilot_reads_the_quota_without_a_costume(monkeypatch):
    """The read is back, and it says who is calling.

    It used to send ``GitHubCopilotChat/…`` plus VS Code Editor-Version
    headers. Measured 2026-08-05: the endpoint answers 200 to a plain
    ``User-Agent: Navide`` with the same body, so the costume was never
    load-bearing. This pins that it does not come back."""
    _with_copilot_gh_token(monkeypatch)
    calls = _fake_httpx(monkeypatch, {
        _COPILOT_USAGE_URL: _FakeResponse(200, {
            "copilot_plan": "individual",
            "quota_reset_date_utc": "2026-08-01T00:00:00.000Z",
            "quota_snapshots": {
                "chat": {"percent_remaining": 98.7, "has_quota": True},
            },
        }),
    })

    snap = await us.fetch_copilot(Path("/x"), {})

    assert snap["status"] == "ok"
    assert snap["planType"] == "individual"
    assert snap["windows"] == [{
        "kind": "monthly", "label": "Chat", "usedPercent": 1.3,
        "resetsAt": "2026-08-01T00:00:00.000Z",
    }]
    headers = next(kw for url, kw in calls if url == _COPILOT_USAGE_URL)["headers"]
    assert headers["Authorization"] == "token gho_test"
    assert headers["User-Agent"] == "Navide"
    assert "Editor-Version" not in headers
    assert "Editor-Plugin-Version" not in headers


async def test_fetch_copilot_token_discovery_still_works(monkeypatch):
    """Sign-in detection is unchanged: env fallback still counts as signed in,
    and no token at all is still no-credentials (with no request made)."""
    _with_copilot_gh_token(monkeypatch, token=None)
    calls = _fake_httpx(monkeypatch, {
        _COPILOT_USAGE_URL: _FakeResponse(200, {
            "quota_snapshots": {"chat": {"percent_remaining": 50,
                                         "has_quota": True}},
        }),
    })

    snap = await us.fetch_copilot(Path("/nonexistent"), {"GH_TOKEN": "gho_env"})
    assert snap["status"] == "ok"

    calls.clear()
    snap = await us.fetch_copilot(Path("/nonexistent"), {})
    assert snap["status"] == "no-credentials"
    assert calls == []


# ── cursor fetch (session-cookie auth against usage-summary) ────────────────

def _with_cursor_token(monkeypatch, token):
    async def fake_read(home):
        return token

    monkeypatch.setattr(cursor_vendor, "read_cursor_credentials", fake_read)


async def test_fetch_cursor_no_credentials(monkeypatch):
    _with_cursor_token(monkeypatch, None)
    snap = await us.fetch_cursor(Path("/nonexistent"))
    assert snap["status"] == "no-credentials"


async def test_fetch_cursor_expired_locally(monkeypatch):
    # An exp in the past never hits the network (tokens are not refreshed).
    _with_cursor_token(monkeypatch, _cursor_jwt({"sub": "auth0|u1", "exp": 1}))
    snap = await us.fetch_cursor(Path("/x"))
    assert snap["status"] == "expired"


async def test_fetch_cursor_reads_the_quota_through_the_session_cookie(monkeypatch):
    """The one provider that still needs a browser-shaped credential.

    Measured 2026-08-05: the same token as ``Authorization: Bearer`` gets 401
    from usage-summary, while the session cookie gets 200. The User-Agent is
    honest; the cookie is the only form the endpoint accepts."""
    token = _cursor_jwt({"sub": "google-oauth2|user_123", "exp": 4_102_444_800})
    _with_cursor_token(monkeypatch, token)
    calls = _fake_httpx(monkeypatch, {
        us.CURSOR_USAGE_SUMMARY_URL: _FakeResponse(200, {
            "billingCycleEnd": "2026-08-18T02:00:32.193Z",
            "membershipType": "pro",
            "individualUsage": {
                "plan": {"enabled": True, "used": 850, "limit": 2000,
                         "totalPercentUsed": 42.5},
            },
        }),
    })

    snap = await us.fetch_cursor(Path("/x"))

    assert snap["status"] == "ok"
    assert snap["planType"] == "pro"
    assert snap["windows"] == [{
        "kind": "cycle", "label": "Plan usage", "usedPercent": 42.5,
        "resetsAt": "2026-08-18T02:00:32.193Z",
    }]
    headers = next(
        kw for url, kw in calls if url == us.CURSOR_USAGE_SUMMARY_URL
    )["headers"]
    assert headers["Cookie"] == f"WorkosCursorSessionToken=user_123%3A%3A{token}"
    assert headers["User-Agent"] == "Navide"


async def test_fetch_cursor_local_expiry_still_precedes_unavailable(monkeypatch):
    """A locally-detectable expiry is more informative than "unavailable" and
    must keep winning — it is read from the token itself, not from the network."""
    _with_cursor_token(monkeypatch, _cursor_jwt({"sub": "auth0|u1", "exp": 1}))
    calls = _fake_httpx(monkeypatch, {})
    snap = await us.fetch_cursor(Path("/x"))
    assert snap["status"] == "expired"
    assert calls == []


# ── Poller cooldown behavior ────────────────────────────────────────────────

async def test_poll_once_rate_limit_sets_cooldown(tmp_path, monkeypatch):
    calls = {"claude": 0}

    async def fake_claude(home):
        calls["claude"] += 1
        snap = us._snapshot("claude", "rate-limited")
        snap["retryAfterSec"] = 120.0
        return snap

    async def fake_ok(provider):
        return us._snapshot(provider, "no-credentials")

    monkeypatch.setattr(us, "_get_profiles_store", lambda: None)
    monkeypatch.setattr(us, "fetch_claude", fake_claude)
    monkeypatch.setattr(codex_vendor, "fetch_codex", lambda home: fake_ok("codex"))
    monkeypatch.setattr(kimi_vendor, "fetch_kimi", lambda home: fake_ok("kimi"))
    monkeypatch.setattr(grok_vendor, "fetch_grok", lambda home: fake_ok("grok"))
    monkeypatch.setattr(antigravity_vendor, "fetch_antigravity", lambda home: fake_ok("antigravity"))
    monkeypatch.setattr(opencode_vendor, "fetch_opencode", lambda home: fake_ok("opencode"))
    monkeypatch.setattr(qwen_vendor, "fetch_qwen", lambda home: fake_ok("qwen"))
    monkeypatch.setattr(kilo_vendor, "fetch_kilo", lambda home: fake_ok("kilo"))
    monkeypatch.setattr(pi_vendor, "fetch_pi", lambda home: fake_ok("pi"))
    monkeypatch.setattr(copilot_vendor, "fetch_copilot", lambda home: fake_ok("copilot"))
    monkeypatch.setattr(cursor_vendor, "fetch_cursor", lambda home: fake_ok("cursor"))

    svc = us.UsageService()
    payload = await svc.poll_once(tmp_path)
    assert payload["providers"]["claude"]["status"] == "rate-limited"
    assert "retryAfterSec" not in payload["providers"]["claude"]
    # Second poll skips the blocked provider entirely.
    await svc.poll_once(tmp_path)
    assert calls["claude"] == 1
    # request_refresh clears the gate.
    svc.request_refresh()
    await svc.poll_once(tmp_path)
    assert calls["claude"] == 2


async def test_poll_once_survives_fetcher_exception(tmp_path, monkeypatch):
    async def boom(home):
        raise RuntimeError("kaput")

    async def fake_ok(provider):
        return us._snapshot(provider, "no-credentials")

    monkeypatch.setattr(us, "_get_profiles_store", lambda: None)
    monkeypatch.setattr(us, "fetch_claude", boom)
    monkeypatch.setattr(codex_vendor, "fetch_codex", lambda home: fake_ok("codex"))
    monkeypatch.setattr(kimi_vendor, "fetch_kimi", lambda home: fake_ok("kimi"))
    monkeypatch.setattr(grok_vendor, "fetch_grok", lambda home: fake_ok("grok"))
    monkeypatch.setattr(antigravity_vendor, "fetch_antigravity", lambda home: fake_ok("antigravity"))
    monkeypatch.setattr(opencode_vendor, "fetch_opencode", lambda home: fake_ok("opencode"))
    monkeypatch.setattr(qwen_vendor, "fetch_qwen", lambda home: fake_ok("qwen"))
    monkeypatch.setattr(kilo_vendor, "fetch_kilo", lambda home: fake_ok("kilo"))
    monkeypatch.setattr(pi_vendor, "fetch_pi", lambda home: fake_ok("pi"))
    monkeypatch.setattr(copilot_vendor, "fetch_copilot", lambda home: fake_ok("copilot"))
    monkeypatch.setattr(cursor_vendor, "fetch_cursor", lambda home: fake_ok("cursor"))

    svc = us.UsageService()
    payload = await svc.poll_once(tmp_path)
    assert payload["providers"]["claude"]["status"] == "error"
    assert payload["providers"]["codex"]["status"] == "no-credentials"


def test_usage_cache_loads_last_good_and_ignores_invalid_files(tmp_path):
    cache = tmp_path / "usage-cache.json"
    good = us._snapshot(
        "claude", "ok",
        windows=[us._window("session", "Session", 25, "2099-01-01T00:00:00Z")],
        plan_type="pro",
    )
    good["windows"][0]["accessToken"] = "must-not-persist"
    first = us.UsageService(cache_path=cache)
    assert first._record_claude_snapshot("acct-a", good) is True
    first._save_cache()

    raw = cache.read_text(encoding="utf-8")
    assert "accessToken" not in raw
    assert "refreshToken" not in raw
    assert "must-not-persist" not in raw
    if osplat.paths.enforces_posix_modes():
        assert cache.stat().st_mode & 0o777 == 0o600
    loaded = us.UsageService(
        cache_path=cache,
        active_claude_slot_reader=lambda: "acct-a",
    )
    snap = loaded.payload()["accounts"]["claude"]["acct-a"]
    assert snap["windows"][0]["usedPercent"] == 25
    assert snap["stale"] is True
    assert snap["refreshStatus"] == "not-refreshed"
    assert loaded.payload()["providers"]["claude"] == snap

    cache.write_text("not json", encoding="utf-8")
    assert us.UsageService(cache_path=cache).payload()["accounts"] == {}
    cache.write_text(json.dumps({"schemaVersion": 999, "accounts": {}}), encoding="utf-8")
    assert us.UsageService(cache_path=cache).payload()["accounts"] == {}


def test_usage_cache_merges_failure_and_marks_reset_windows_expired(tmp_path):
    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    good = us._snapshot(
        "claude", "ok",
        windows=[us._window("session", "Session", 70, "2000-01-01T00:00:00Z")],
    )
    svc._record_claude_snapshot("acct-a", good)
    failure = us._snapshot("claude", "expired")

    assert svc._record_claude_snapshot("acct-a", failure) is False
    snap = svc.payload()["accounts"]["claude"]["acct-a"]
    assert snap["status"] == "ok"
    assert snap["refreshStatus"] == "expired"
    assert snap["refreshAttemptedAt"] == failure["fetchedAt"]
    assert snap["lastSuccessAt"] == good["fetchedAt"]
    assert snap["windows"][0]["usedPercent"] == 70
    assert snap["windows"][0]["expired"] is True
    assert snap["staleExpired"] is True


def test_stale_expiry_recomputes_while_polling_is_blocked(tmp_path):
    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    good = us._snapshot(
        "claude", "ok",
        windows=[us._window("session", "Session", 70, "2099-01-01T00:00:00")],
    )
    svc._record_claude_snapshot("acct-a", good)
    svc._record_claude_snapshot("acct-a", us._snapshot("claude", "rate-limited"))
    snap = svc.payload()["accounts"]["claude"]["acct-a"]
    assert snap["staleExpired"] is False

    snap["windows"][0]["resetsAt"] = "2000-01-01T00:00:00"
    refreshed = svc.payload()["accounts"]["claude"]["acct-a"]
    assert refreshed["staleExpired"] is True
    assert refreshed["windows"][0]["expired"] is True


def test_next_sleep_accepts_naive_reset_timestamp():
    svc = us.UsageService()
    svc.account_snapshots = {
        "claude": {
            "acct-a": us._snapshot(
                "claude", "ok",
                windows=[us._window("session", "Session", 10, "2099-01-01T00:00:00")],
            )
        }
    }
    assert svc._next_sleep() == us.DEFAULT_INTERVAL


async def test_poll_once_claude_accounts_are_independent_and_pruned(tmp_path, monkeypatch):
    store = _isolated_store(tmp_path)
    active = store.create(agent_key="claude", name="Active")
    inactive = store.create(agent_key="claude", name="Inactive")
    store.set_default("claude", active["id"])

    class AccountVault:
        def __init__(self):
            self.lock = asyncio.Lock()
            self.calls: list[tuple[str, bool]] = []

        def switch_lock(self, agent_key: str):
            assert agent_key == "claude"
            return self.lock

        def resolve_claude_credentials(self, slot_id: str, *, active: bool):
            self.calls.append((slot_id, active))
            secret = json.dumps({"claudeAiOauth": {"accessToken": slot_id}})
            return SimpleNamespace(secret=secret)

    vault = AccountVault()
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)
    calls: list[str] = []

    async def fake_claude(home):
        # The CLI can only speak for whoever is signed in, so the poll asks it
        # once per cycle rather than once per account.
        calls.append(store.list()["defaults"]["claude"])
        return us._snapshot(
            "claude", "ok",
            windows=[us._window("session", "Session", len(calls), None)],
        )

    async def fake_other(provider):
        return us._snapshot(provider, "no-credentials")

    monkeypatch.setattr(us, "fetch_claude", fake_claude)
    monkeypatch.setattr(codex_vendor, "fetch_codex", lambda home: fake_other("codex"))
    monkeypatch.setattr(kimi_vendor, "fetch_kimi", lambda home: fake_other("kimi"))
    monkeypatch.setattr(grok_vendor, "fetch_grok", lambda home: fake_other("grok"))
    monkeypatch.setattr(antigravity_vendor, "fetch_antigravity", lambda home: fake_other("antigravity"))
    monkeypatch.setattr(opencode_vendor, "fetch_opencode", lambda home: fake_other("opencode"))
    monkeypatch.setattr(qwen_vendor, "fetch_qwen", lambda home: fake_other("qwen"))
    monkeypatch.setattr(kilo_vendor, "fetch_kilo", lambda home: fake_other("kilo"))
    monkeypatch.setattr(pi_vendor, "fetch_pi", lambda home: fake_other("pi"))
    monkeypatch.setattr(copilot_vendor, "fetch_copilot", lambda home: fake_other("copilot"))
    monkeypatch.setattr(cursor_vendor, "fetch_cursor", lambda home: fake_other("cursor"))

    cache = tmp_path / "usage-cache.json"
    svc = us.UsageService(cache_path=cache)
    first = await svc.poll_once(tmp_path)
    # Every account still has a row — the parked ones just carry no figure.
    assert set(first["accounts"]["claude"]) == {
        "__default__", active["id"], inactive["id"],
    }
    assert first["providers"]["claude"] == first["accounts"]["claude"][active["id"]]
    assert first["accounts"]["claude"][active["id"]]["status"] == "ok"
    for parked in ("__default__", inactive["id"]):
        row = first["accounts"]["claude"][parked]
        assert row["status"] == "not-measured"
        assert row["windows"] == []

    # The reading stands for a while: asking the CLI costs a Claude Code start.
    await svc.poll_once(tmp_path)
    assert calls == [active["id"]]
    svc.request_refresh()  # what the badge's refresh button does
    await svc.poll_once(tmp_path)
    assert calls == [active["id"], active["id"]]

    store.delete(inactive["id"])
    third = await svc.poll_once(tmp_path)
    assert inactive["id"] not in third["accounts"]["claude"]
    persisted = json.loads(cache.read_text(encoding="utf-8"))
    assert inactive["id"] not in persisted["accounts"]["claude"]


async def test_refresh_during_poll_runs_next_cycle_with_new_active_account(
    tmp_path, monkeypatch
):
    from agent_team_backend import app

    store = _isolated_store(tmp_path)
    first = store.create(agent_key="claude", name="First")
    second = store.create(agent_key="claude", name="Second")
    store.set_default("claude", first["id"])

    class AccountVault:
        def __init__(self):
            self.lock = asyncio.Lock()

        def switch_lock(self, agent_key: str):
            return self.lock

        def resolve_claude_credentials(self, slot_id: str, *, active: bool):
            secret = json.dumps({"claudeAiOauth": {"accessToken": slot_id}})
            return SimpleNamespace(secret=secret)

        def login_home_path(self, agent_key: str, slot_id: str) -> Path:
            return tmp_path / "missing-login-home"

        def harvest(self, agent_key: str, slot_id: str) -> bool:
            return False

    vault = AccountVault()
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)
    started = asyncio.Event()
    release_first_poll = asyncio.Event()

    async def fake_claude(home):
        # Read the active account when the cycle starts, not when it finishes:
        # the point of the test is that a switch mid-poll lands on the NEXT
        # cycle, so the in-flight one must still report who it began with.
        active = store.list()["defaults"]["claude"]
        if not release_first_poll.is_set():
            started.set()
            await release_first_poll.wait()
        used = 10 if active == first["id"] else 20
        return us._snapshot(
            "claude", "ok",
            windows=[us._window("session", "Session", used, None)],
        )

    async def fake_other(provider):
        return us._snapshot(provider, "no-credentials")

    monkeypatch.setattr(us, "fetch_claude", fake_claude)
    monkeypatch.setattr(codex_vendor, "fetch_codex", lambda home: fake_other("codex"))
    monkeypatch.setattr(kimi_vendor, "fetch_kimi", lambda home: fake_other("kimi"))
    monkeypatch.setattr(grok_vendor, "fetch_grok", lambda home: fake_other("grok"))
    monkeypatch.setattr(antigravity_vendor, "fetch_antigravity", lambda home: fake_other("antigravity"))
    monkeypatch.setattr(opencode_vendor, "fetch_opencode", lambda home: fake_other("opencode"))
    monkeypatch.setattr(qwen_vendor, "fetch_qwen", lambda home: fake_other("qwen"))
    monkeypatch.setattr(kilo_vendor, "fetch_kilo", lambda home: fake_other("kilo"))
    monkeypatch.setattr(pi_vendor, "fetch_pi", lambda home: fake_other("pi"))
    monkeypatch.setattr(copilot_vendor, "fetch_copilot", lambda home: fake_other("copilot"))
    monkeypatch.setattr(cursor_vendor, "fetch_cursor", lambda home: fake_other("cursor"))

    broadcasts: list[dict] = []
    completed = asyncio.Event()
    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    svc.enabled = True

    async def record_broadcast(event):
        broadcasts.append(event)
        if len(broadcasts) == 2:
            svc.enabled = False
            svc.request_refresh()
            completed.set()

    monkeypatch.setattr(app, "broadcast", record_broadcast)
    task = asyncio.create_task(svc._run())
    # 5s, the ceiling this file already uses for a wait on real coroutine work.
    # These three were 1s, which is generous on a developer machine and is not
    # on a loaded Windows runner: the same suite takes ~3 minutes here and took
    # 19.5 there, and this test went red on the 0.2.5 dry run with the code
    # working. Waits on an event that should be set in milliseconds, so a real
    # hang still fails quickly.
    await asyncio.wait_for(started.wait(), timeout=5)
    store.set_default("claude", second["id"])
    svc.request_refresh()
    release_first_poll.set()
    await asyncio.wait_for(completed.wait(), timeout=5)
    await asyncio.wait_for(task, timeout=5)

    assert len(broadcasts) == 2
    first_payload = broadcasts[0]["payload"]
    second_payload = broadcasts[1]["payload"]
    assert first_payload["providers"]["claude"]["windows"][0]["usedPercent"] == 10
    assert second_payload["providers"]["claude"]["windows"][0]["usedPercent"] == 20


# ── Real-home credential reads + opportunistic slot harvest ─────────────────

class _RecordingVault:
    def __init__(self, root: Path | None = None):
        self.harvested: list[tuple[str, str]] = []
        self.login_harvested: list[tuple[str, str]] = []
        self.restored: list[tuple[str, str]] = []
        self._locks: dict[str, asyncio.Lock] = {}
        self._root = root

    def switch_lock(self, agent_key: str) -> asyncio.Lock:
        lock = self._locks.get(agent_key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[agent_key] = lock
        return lock

    def harvest(self, agent_key: str, slot_id: str) -> bool:
        self.harvested.append((agent_key, slot_id))
        return True

    def login_home_path(self, agent_key: str, slot_id: str) -> Path:
        return (self._root or Path("/nonexistent")) / agent_key / slot_id / "login-home"

    def harvest_login_home(self, agent_key: str, slot_id: str) -> bool:
        self.login_harvested.append((agent_key, slot_id))
        return True

    def login_secret_present(self, agent_key: str, slot_id: str) -> bool:
        return False

    def slot_is_empty(self, agent_key: str, slot_id: str) -> bool:
        return True  # this fake never stores a secret

    def identity(self, agent_key: str, slot_id: str | None = None) -> dict:
        # An account the vault cannot name is never folded into another
        # profile, so these tests stay about the harvest bookkeeping alone
        # (de-duplication has its own suite: test_login_dedupe.py).
        return {"email": None, "signedIn": False}

    # No claude account has signed in inside its own config dir.
    def account_dir_signed_in(self, slot_id: str) -> bool:
        return False

    def account_dir_identity(self, slot_id: str) -> dict | None:
        return None

    def restore(self, agent_key: str, slot_id: str) -> None:
        self.restored.append((agent_key, slot_id))


async def test_poll_once_always_reads_real_home(tmp_path, monkeypatch):
    """Every provider reads its original real-home path even while managed
    accounts (non-null defaults) are active — profiles no longer redirect
    credential reads anywhere."""
    store = _isolated_store(tmp_path)
    for key in ("claude", "codex", "kimi", "grok"):
        prof = store.create(agent_key=key, name="Acct")
        store.set_default(key, prof["id"])
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: _RecordingVault())
    monkeypatch.delenv("CODEX_HOME", raising=False)
    seen: dict = {}

    async def spy_claude(home):
        seen["claude"] = home
        return us._snapshot("claude", "no-credentials")

    async def spy_codex(codex_home):
        seen["codex"] = codex_home
        return us._snapshot("codex", "no-credentials")

    async def spy_kimi(home):
        seen["kimi"] = home
        return us._snapshot("kimi", "no-credentials")

    async def spy_grok(home):
        seen["grok"] = home
        return us._snapshot("grok", "no-credentials")

    async def spy_antigravity(home):
        seen["antigravity"] = home
        return us._snapshot("antigravity", "no-credentials")

    async def spy_opencode(home):
        seen["opencode"] = home
        return us._snapshot("opencode", "no-credentials")

    async def spy_qwen(home):
        seen["qwen"] = home
        return us._snapshot("qwen", "no-credentials")

    async def spy_kilo(home):
        seen["kilo"] = home
        return us._snapshot("kilo", "no-credentials")

    async def spy_pi(home):
        seen["pi"] = home
        return us._snapshot("pi", "no-credentials")

    async def spy_copilot(home):
        seen["copilot"] = home
        return us._snapshot("copilot", "no-credentials")

    async def spy_cursor(home):
        seen["cursor"] = home
        return us._snapshot("cursor", "no-credentials")

    monkeypatch.setattr(us, "fetch_claude", spy_claude)
    monkeypatch.setattr(codex_vendor, "fetch_codex", spy_codex)
    monkeypatch.setattr(kimi_vendor, "fetch_kimi", spy_kimi)
    monkeypatch.setattr(grok_vendor, "fetch_grok", spy_grok)
    monkeypatch.setattr(antigravity_vendor, "fetch_antigravity", spy_antigravity)
    monkeypatch.setattr(opencode_vendor, "fetch_opencode", spy_opencode)
    monkeypatch.setattr(qwen_vendor, "fetch_qwen", spy_qwen)
    monkeypatch.setattr(kilo_vendor, "fetch_kilo", spy_kilo)
    monkeypatch.setattr(pi_vendor, "fetch_pi", spy_pi)
    monkeypatch.setattr(copilot_vendor, "fetch_copilot", spy_copilot)
    monkeypatch.setattr(cursor_vendor, "fetch_cursor", spy_cursor)

    real = tmp_path / "realhome"
    await us.UsageService().poll_once(real)
    assert seen["claude"] == real
    assert seen["codex"] == real / ".codex"
    assert seen["kimi"] == real
    assert seen["grok"] == real
    assert seen["antigravity"] == real
    assert seen["opencode"] == real
    assert seen["qwen"] == real
    assert seen["kilo"] == real
    assert seen["pi"] == real
    assert seen["copilot"] == real
    assert seen["cursor"] == real


async def test_poll_once_harvests_active_slots(tmp_path, monkeypatch):
    """Each poll opportunistically offers the ACTIVE accounts a harvest (fills
    an empty slot from live credentials after an in-pane login). Agents on the
    built-in default (null) are never harvested."""
    store = _isolated_store(tmp_path)
    prof = store.create(agent_key="claude", name="Acct")
    store.set_default("claude", prof["id"])
    vault = _RecordingVault()
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)

    async def fake_ok(provider):
        return us._snapshot(provider, "no-credentials")

    monkeypatch.setattr(us, "fetch_claude", lambda home: fake_ok("claude"))
    monkeypatch.setattr(codex_vendor, "fetch_codex", lambda home: fake_ok("codex"))
    monkeypatch.setattr(kimi_vendor, "fetch_kimi", lambda home: fake_ok("kimi"))
    monkeypatch.setattr(grok_vendor, "fetch_grok", lambda home: fake_ok("grok"))
    monkeypatch.setattr(antigravity_vendor, "fetch_antigravity", lambda home: fake_ok("antigravity"))
    monkeypatch.setattr(opencode_vendor, "fetch_opencode", lambda home: fake_ok("opencode"))
    monkeypatch.setattr(qwen_vendor, "fetch_qwen", lambda home: fake_ok("qwen"))
    monkeypatch.setattr(kilo_vendor, "fetch_kilo", lambda home: fake_ok("kilo"))
    monkeypatch.setattr(pi_vendor, "fetch_pi", lambda home: fake_ok("pi"))
    monkeypatch.setattr(copilot_vendor, "fetch_copilot", lambda home: fake_ok("copilot"))
    monkeypatch.setattr(cursor_vendor, "fetch_cursor", lambda home: fake_ok("cursor"))

    await us.UsageService().poll_once(tmp_path)
    assert vault.harvested == [("claude", prof["id"])]


async def test_poll_once_harvests_pending_login_homes(tmp_path, monkeypatch):
    """A profile with a pending isolated login home is harvested even while
    NOT active (the whole point of isolated logins), and the accounts UI is
    told with reason 'login-harvest'. Profiles without a login home are
    skipped."""
    store = _isolated_store(tmp_path)
    pending = store.create(agent_key="claude", name="Second")
    store.create(agent_key="codex", name="NoLogin")
    vault = _RecordingVault(root=tmp_path / "slots")
    vault.login_home_path("claude", pending["id"]).mkdir(parents=True)
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)
    reasons: list[tuple[str, list[str] | None]] = []

    async def record_changed(
        reason: str, harvested_profile_ids: list[str] | None = None
    ) -> None:
        reasons.append((reason, harvested_profile_ids))

    from agent_team_backend import ws_handlers

    monkeypatch.setattr(ws_handlers, "_broadcast_profiles_changed", record_changed)

    async def fake_ok(provider):
        return us._snapshot(provider, "no-credentials")

    monkeypatch.setattr(us, "fetch_claude", lambda home: fake_ok("claude"))
    monkeypatch.setattr(codex_vendor, "fetch_codex", lambda home: fake_ok("codex"))
    monkeypatch.setattr(kimi_vendor, "fetch_kimi", lambda home: fake_ok("kimi"))
    monkeypatch.setattr(grok_vendor, "fetch_grok", lambda home: fake_ok("grok"))
    monkeypatch.setattr(antigravity_vendor, "fetch_antigravity", lambda home: fake_ok("antigravity"))
    monkeypatch.setattr(opencode_vendor, "fetch_opencode", lambda home: fake_ok("opencode"))
    monkeypatch.setattr(qwen_vendor, "fetch_qwen", lambda home: fake_ok("qwen"))
    monkeypatch.setattr(kilo_vendor, "fetch_kilo", lambda home: fake_ok("kilo"))
    monkeypatch.setattr(pi_vendor, "fetch_pi", lambda home: fake_ok("pi"))
    monkeypatch.setattr(copilot_vendor, "fetch_copilot", lambda home: fake_ok("copilot"))
    monkeypatch.setattr(cursor_vendor, "fetch_cursor", lambda home: fake_ok("cursor"))

    await us.UsageService().poll_once(tmp_path)

    assert vault.login_harvested == [("claude", pending["id"])]
    assert vault.harvested == []  # neither profile is the active account
    assert vault.restored == []  # inactive profile: slot-only, live untouched
    # The broadcast names the harvested profile so the initiating window can
    # close its login pane and toast the identity.
    assert reasons == [("login-harvest", [pending["id"]])]


async def test_sweep_pending_login_homes_independent_of_poller(tmp_path, monkeypatch):
    """The one-shot startup sweep harvests leftover login homes without any
    UsageService poll (usage polling disabled) and broadcasts the result."""
    store = _isolated_store(tmp_path)
    pending = store.create(agent_key="claude", name="Second")
    store.create(agent_key="codex", name="NoLogin")
    vault = _RecordingVault(root=tmp_path / "slots")
    vault.login_home_path("claude", pending["id"]).mkdir(parents=True)
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)
    reasons: list[tuple[str, list[str] | None]] = []

    async def record_changed(
        reason: str, harvested_profile_ids: list[str] | None = None
    ) -> None:
        reasons.append((reason, harvested_profile_ids))

    from agent_team_backend import ws_handlers

    monkeypatch.setattr(ws_handlers, "_broadcast_profiles_changed", record_changed)

    await us.sweep_pending_login_homes()

    assert vault.login_harvested == [("claude", pending["id"])]
    assert reasons == [("login-harvest", [pending["id"]])]


async def test_sweep_pending_login_homes_skips_running_login_pane(
    tmp_path, monkeypatch
):
    """A login home whose pane CLI still runs is left alone by the sweep."""
    store = _isolated_store(tmp_path)
    pending = store.create(agent_key="claude", name="Second")
    vault = _RecordingVault(root=tmp_path / "slots")
    vault.login_home_path("claude", pending["id"]).mkdir(parents=True)
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)
    monkeypatch.setattr(us, "_login_pane_running", lambda agent_key, profile_id: True)

    await us.sweep_pending_login_homes()

    assert vault.login_harvested == []
    assert vault.login_home_path("claude", pending["id"]).is_dir()


async def test_poll_once_skips_login_harvest_while_login_pane_runs(
    tmp_path, monkeypatch
):
    """A login home is never harvested while the profile's login pane CLI is
    still running: the CLI could rotate the token right after the snapshot
    (stranding a dead refresh token in the slot) and would lose its config
    home underneath it."""
    store = _isolated_store(tmp_path)
    pending = store.create(agent_key="claude", name="Second")
    vault = _RecordingVault(root=tmp_path / "slots")
    vault.login_home_path("claude", pending["id"]).mkdir(parents=True)
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)

    from agent_team_backend import ws_handlers

    monkeypatch.setattr(
        ws_handlers,
        "_running_login_terminals",
        lambda agent_key, profile_id: ["t-login"]
        if (agent_key, profile_id) == ("claude", pending["id"]) else [],
    )
    reasons: list = []

    async def record_changed(reason, harvested_profile_ids=None):
        reasons.append((reason, harvested_profile_ids))

    monkeypatch.setattr(ws_handlers, "_broadcast_profiles_changed", record_changed)

    async def fake_ok(provider):
        return us._snapshot(provider, "no-credentials")

    monkeypatch.setattr(us, "fetch_claude", lambda home: fake_ok("claude"))
    monkeypatch.setattr(codex_vendor, "fetch_codex", lambda home: fake_ok("codex"))
    monkeypatch.setattr(kimi_vendor, "fetch_kimi", lambda home: fake_ok("kimi"))
    monkeypatch.setattr(grok_vendor, "fetch_grok", lambda home: fake_ok("grok"))
    monkeypatch.setattr(antigravity_vendor, "fetch_antigravity", lambda home: fake_ok("antigravity"))
    monkeypatch.setattr(opencode_vendor, "fetch_opencode", lambda home: fake_ok("opencode"))
    monkeypatch.setattr(qwen_vendor, "fetch_qwen", lambda home: fake_ok("qwen"))
    monkeypatch.setattr(kilo_vendor, "fetch_kilo", lambda home: fake_ok("kilo"))
    monkeypatch.setattr(pi_vendor, "fetch_pi", lambda home: fake_ok("pi"))
    monkeypatch.setattr(copilot_vendor, "fetch_copilot", lambda home: fake_ok("copilot"))
    monkeypatch.setattr(cursor_vendor, "fetch_cursor", lambda home: fake_ok("cursor"))

    await us.UsageService().poll_once(tmp_path)

    assert vault.login_harvested == []
    assert vault.login_home_path("claude", pending["id"]).is_dir()
    assert reasons == []


async def test_login_harvest_for_active_profile_restores_live(tmp_path, monkeypatch):
    """When the harvested profile is the ACTIVE account its slot is restored
    to live right away — the active row's identity is read from the live
    state, and the next capture() mirrors live into the slot, which would
    otherwise silently erase the completed sign-in."""
    store = _isolated_store(tmp_path)
    prof = store.create(agent_key="claude", name="Acct")
    store.set_default("claude", prof["id"])
    vault = _RecordingVault(root=tmp_path / "slots")
    vault.login_home_path("claude", prof["id"]).mkdir(parents=True)
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)
    reasons: list = []

    async def record_changed(reason, harvested_profile_ids=None):
        reasons.append((reason, harvested_profile_ids))

    from agent_team_backend import ws_handlers

    monkeypatch.setattr(ws_handlers, "_broadcast_profiles_changed", record_changed)

    async def fake_ok(provider):
        return us._snapshot(provider, "no-credentials")

    monkeypatch.setattr(us, "fetch_claude", lambda home: fake_ok("claude"))
    monkeypatch.setattr(codex_vendor, "fetch_codex", lambda home: fake_ok("codex"))
    monkeypatch.setattr(kimi_vendor, "fetch_kimi", lambda home: fake_ok("kimi"))
    monkeypatch.setattr(grok_vendor, "fetch_grok", lambda home: fake_ok("grok"))
    monkeypatch.setattr(antigravity_vendor, "fetch_antigravity", lambda home: fake_ok("antigravity"))
    monkeypatch.setattr(opencode_vendor, "fetch_opencode", lambda home: fake_ok("opencode"))
    monkeypatch.setattr(qwen_vendor, "fetch_qwen", lambda home: fake_ok("qwen"))
    monkeypatch.setattr(kilo_vendor, "fetch_kilo", lambda home: fake_ok("kilo"))
    monkeypatch.setattr(pi_vendor, "fetch_pi", lambda home: fake_ok("pi"))
    monkeypatch.setattr(copilot_vendor, "fetch_copilot", lambda home: fake_ok("copilot"))
    monkeypatch.setattr(cursor_vendor, "fetch_cursor", lambda home: fake_ok("cursor"))

    await us.UsageService().poll_once(tmp_path)

    assert vault.login_harvested == [("claude", prof["id"])]
    assert vault.restored == [("claude", prof["id"])]
    assert reasons == [("login-harvest", [prof["id"]])]


# ── Login watch (fast harvest right after a login pane spawn) ───────────────


def _capture_profile_broadcasts(monkeypatch) -> list[tuple[str, list[str] | None]]:
    calls: list[tuple[str, list[str] | None]] = []

    async def record_changed(
        reason: str, harvested_profile_ids: list[str] | None = None
    ) -> None:
        calls.append((reason, harvested_profile_ids))

    from agent_team_backend import ws_handlers

    monkeypatch.setattr(ws_handlers, "_broadcast_profiles_changed", record_changed)
    return calls


async def test_login_watch_harvests_and_broadcasts(tmp_path, monkeypatch):
    """The watch polls the login home, harvests as soon as the vault reports
    credentials, broadcasts login-harvest with the profile id, and stops."""
    vault = _RecordingVault(root=tmp_path / "slots")
    vault.login_home_path("claude", "p1").mkdir(parents=True)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)
    monkeypatch.setattr(us, "LOGIN_WATCH_INTERVAL_SEC", 0.01)
    calls = _capture_profile_broadcasts(monkeypatch)

    us.start_login_watch("claude", "p1")
    task = us._login_watches[("claude", "p1")]
    await asyncio.wait_for(task, timeout=2.0)
    await asyncio.sleep(0)  # let the done callback clean the registry

    assert vault.login_harvested == [("claude", "p1")]
    assert calls == [("login-harvest", ["p1"])]
    assert ("claude", "p1") not in us._login_watches


async def test_login_watch_stops_when_login_home_gone(tmp_path, monkeypatch):
    """A login home harvested elsewhere (usage poll) or a deleted profile ends
    the watch without a harvest attempt or broadcast."""
    vault = _RecordingVault(root=tmp_path / "slots")  # home never created
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)
    monkeypatch.setattr(us, "LOGIN_WATCH_INTERVAL_SEC", 0.01)
    calls = _capture_profile_broadcasts(monkeypatch)

    us.start_login_watch("claude", "p1")
    await asyncio.wait_for(us._login_watches[("claude", "p1")], timeout=2.0)

    assert vault.login_harvested == []
    assert calls == []


async def test_login_watch_times_out_quietly(tmp_path, monkeypatch):
    """An abandoned login (pane closed, never authorized) expires without a
    broadcast; the login home stays for the next attempt."""

    class _NeverReady(_RecordingVault):
        def harvest_login_home(self, agent_key: str, slot_id: str) -> bool:
            super().harvest_login_home(agent_key, slot_id)
            return False

    vault = _NeverReady(root=tmp_path / "slots")
    vault.login_home_path("claude", "p1").mkdir(parents=True)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)
    monkeypatch.setattr(us, "LOGIN_WATCH_INTERVAL_SEC", 0.01)
    monkeypatch.setattr(us, "LOGIN_WATCH_TIMEOUT_SEC", 0.05)
    calls = _capture_profile_broadcasts(monkeypatch)

    us.start_login_watch("claude", "p1")
    await asyncio.wait_for(us._login_watches[("claude", "p1")], timeout=2.0)

    assert vault.login_harvested  # it kept trying until the deadline
    assert calls == []
    assert vault.login_home_path("claude", "p1").is_dir()


async def test_login_watch_dedupes_running_watch(tmp_path, monkeypatch):
    """start_login_watch is idempotent while a watch for the same profile is
    still running — a respawned login pane must not stack watchers."""
    vault = _RecordingVault(root=tmp_path / "slots")
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)
    monkeypatch.setattr(us, "LOGIN_WATCH_INTERVAL_SEC", 0.01)
    _capture_profile_broadcasts(monkeypatch)

    us.start_login_watch("claude", "p1")
    first = us._login_watches[("claude", "p1")]
    us.start_login_watch("claude", "p1")
    assert us._login_watches[("claude", "p1")] is first
    await asyncio.wait_for(first, timeout=2.0)


async def test_login_watch_waits_for_login_pane_exit(tmp_path, monkeypatch):
    """The watch never harvests under a still-running login pane CLI; it
    harvests on the first tick after the pane exits."""
    vault = _RecordingVault(root=tmp_path / "slots")
    vault.login_home_path("claude", "p1").mkdir(parents=True)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)
    monkeypatch.setattr(us, "LOGIN_WATCH_INTERVAL_SEC", 0.01)
    calls = _capture_profile_broadcasts(monkeypatch)

    pane_running = [True]
    from agent_team_backend import ws_handlers

    monkeypatch.setattr(
        ws_handlers,
        "_running_login_terminals",
        lambda agent_key, profile_id: ["t-login"] if pane_running[0] else [],
    )

    us.start_login_watch("claude", "p1")
    task = us._login_watches[("claude", "p1")]
    await asyncio.sleep(0.1)
    assert vault.login_harvested == []  # CLI still running: no harvest

    pane_running[0] = False
    await asyncio.wait_for(task, timeout=2.0)
    assert vault.login_harvested == [("claude", "p1")]
    assert calls == [("login-harvest", ["p1"])]


async def test_login_watch_kills_lingering_pane_once_secret_present(tmp_path, monkeypatch):
    """grok's TUI keeps running after auth: once the login home holds its
    secret file, the watch kills the disposable pane through the standard
    terminals kill path so the harvest can proceed."""
    from types import SimpleNamespace

    class _SecretReady(_RecordingVault):
        def login_secret_present(self, agent_key: str, slot_id: str) -> bool:
            return True

    vault = _SecretReady(root=tmp_path / "slots")
    vault.login_home_path("grok", "p1").mkdir(parents=True)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)
    monkeypatch.setattr(us, "_get_profiles_store", lambda: None)
    monkeypatch.setattr(us, "LOGIN_WATCH_INTERVAL_SEC", 0.01)
    calls = _capture_profile_broadcasts(monkeypatch)

    killed: list[tuple[str, bool]] = []
    panes: list = []

    class _Terminals:
        async def kill(self, tid: str, force: bool = False) -> None:
            killed.append((tid, force))
            panes.clear()

    panes.append(("t-login", SimpleNamespace(terminals=_Terminals())))
    from agent_team_backend import ws_handlers

    monkeypatch.setattr(
        ws_handlers, "_running_login_terminals", lambda agent_key, profile_id: list(panes)
    )

    us.start_login_watch("grok", "p1")
    await asyncio.wait_for(us._login_watches[("grok", "p1")], timeout=2.0)

    assert killed == [("t-login", True)]
    assert vault.login_harvested == [("grok", "p1")]
    assert calls == [("login-harvest", ["p1"])]


async def test_grok_billing_rpc_with_fake_stdio(tmp_path, monkeypatch):
    """Drive grok_billing_rpc against a scripted fake `grok agent stdio`."""
    import sys as _sys

    script = tmp_path / "fake_grok.py"
    script.write_text(
        "import sys, json\n"
        "for line in sys.stdin:\n"
        "    msg = json.loads(line)\n"
        "    if msg['method'] == 'initialize':\n"
        "        print(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': {}}), flush=True)\n"
        "    elif msg['method'] == 'x.ai/billing':\n"
        "        print(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': {\n"
        "            'billingCycle': {'billingPeriodEnd': '2026-08-01T00:00:00Z'},\n"
        "            'monthlyLimit': {'val': 1000}, 'usage': {'totalUsed': {'val': 100}}}}), flush=True)\n",
        encoding="utf-8",
    )

    real_exec = us.asyncio.create_subprocess_exec

    async def fake_exec(binary, *args, **kwargs):
        # Replace `<binary> agent stdio` with `python fake_grok.py`.
        return await real_exec(_sys.executable, str(script), **kwargs)

    monkeypatch.setattr(us.asyncio, "create_subprocess_exec", fake_exec)
    billing = await us.grok_billing_rpc("grok")
    windows, _ = us.normalize_grok(billing)
    assert windows and windows[0]["usedPercent"] == 10.0


async def test_grok_billing_rpc_starts_a_windows_shim_through_cmd(monkeypatch):
    """`grok` installed by npm is a `.cmd` shim: without cmd.exe in front the
    RPC never spawns and the badge reports the CLI unavailable."""
    from agent_team_backend.osplat import _windows

    argv: list[tuple] = []

    class ClosedProc:
        returncode = 0

        class _Stdin:
            def write(self, _data): ...

            async def drain(self): ...

        class _Stdout:
            async def readline(self):
                return b""

        stdin = _Stdin()
        stdout = _Stdout()

    async def fake_exec(*a, **_k):
        argv.append(a)
        return ClosedProc()

    monkeypatch.setattr(grok_vendor.osplat, "paths", _windows.paths)
    monkeypatch.setattr(grok_vendor.asyncio, "create_subprocess_exec", fake_exec)

    try:
        await grok_vendor.grok_billing_rpc(r"C:\npm\grok.cmd")
    except ConnectionError:
        pass  # the fake closes stdout at once; the spawn is what is under test

    assert argv[0] == ("cmd.exe", "/d", "/c", r"C:\npm\grok.cmd", "agent", "stdio")


async def test_copilot_gh_token_starts_a_windows_shim_through_cmd(monkeypatch):
    """A scoop- or npm-installed `gh` is a `gh.cmd`, which CreateProcess never
    finds (it only appends `.exe`) — so the token read used to return None."""
    from agent_team_backend.osplat import _windows

    argv: list[tuple] = []

    class TokenProc:
        returncode = 0

        async def communicate(self):
            return b"gho_shim\n", b""

    async def fake_exec(*a, **_k):
        argv.append(a)
        return TokenProc()

    monkeypatch.setattr(copilot_vendor.osplat, "paths", _windows.paths)
    monkeypatch.setattr(
        _windows.paths, "resolve_program", lambda _name, *, path=None: r"C:\scoop\gh.cmd"
    )
    monkeypatch.setattr(copilot_vendor.asyncio, "create_subprocess_exec", fake_exec)

    assert await copilot_vendor._copilot_gh_token("octo", "github.com") == "gho_shim"
    assert argv[0] == (
        "cmd.exe", "/d", "/c", r"C:\scoop\gh.cmd",
        "auth", "token", "--user", "octo", "--hostname", "github.com",
    )


# ── Codex fetch: stranded in-pane login promotion ───────────────────────────

async def test_fetch_codex_promotes_stranded_pane_login(monkeypatch, tmp_path, set_home):
    """Fresh install: login done inside a manual pane sits in
    ~/.codex-panes/<pane>/auth.json; the poll must adopt it instead of
    reporting no-credentials forever."""
    set_home(tmp_path)
    real = tmp_path / ".codex"
    pane_auth = tmp_path / ".codex-panes" / "pane-1" / "auth.json"
    pane_auth.parent.mkdir(parents=True)
    pane_auth.write_text(
        json.dumps({"tokens": {"access_token": "tok", "account_id": "acc"}}),
        encoding="utf-8",
    )
    calls = _fake_httpx(monkeypatch, {
        us.codex_usage_url(us.codex_base_url(real)): _FakeResponse(200, {}),
    })

    snap = await us.fetch_codex(real)

    assert snap["status"] == "ok"
    assert calls  # promotion produced usable creds; the usage call went out
    assert (real / "auth.json").is_file()
    assert pane_auth.is_symlink()


async def test_fetch_codex_no_credentials_without_stranded_login(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    snap = await us.fetch_codex(tmp_path / ".codex")
    assert snap["status"] == "no-credentials"


# ── Parked Claude slot token refresh ────────────────────────────────────────
#
# A parked slot's access token expires with nobody to refresh it, which froze
# both its badge and every switch that installed the dead snapshot. The poller
# now refreshes parked slots only — never the live location, never the active
# account's slot (its snapshot can share a token family with the live copy).

class _SlotVault:
    """Minimal vault double: one claude slot per id, plus the switch lock."""

    def __init__(self, slots: dict[str, str | None] | None = None) -> None:
        self.slots: dict[str, str | None] = dict(slots or {})
        self.accounts: dict[str, dict | None] = {}
        self.writes: list[tuple[str, str]] = []
        self._lock = asyncio.Lock()

    def switch_lock(self, agent_key: str) -> asyncio.Lock:
        return self._lock

    def read_slot(self, agent_key: str, slot_id: str):
        return SimpleNamespace(
            secret=self.slots.get(slot_id), account=self.accounts.get(slot_id)
        )

    def write_slot(self, agent_key: str, slot_id: str, creds) -> None:
        self.slots[slot_id] = creds.secret
        self.accounts[slot_id] = creds.account
        self.writes.append((slot_id, creds.secret))

    def resolve_claude_credentials(self, slot_id: str, *, active: bool):
        return self.read_slot("claude", slot_id)

    def read_live(self, agent_key: str):
        # The live location mirrors whichever slot the delegated refresh
        # renewed; tests set `live` directly.
        return SimpleNamespace(secret=getattr(self, "live", None))


def _slot_secret(access: str, refresh: str, expires_at: int, **extra) -> str:
    return json.dumps({
        "claudeAiOauth": {
            "accessToken": access, "refreshToken": refresh, "expiresAt": expires_at,
        },
        **extra,
    })


async def test_poll_never_mints_tokens_and_reads_slots_as_stored(
    tmp_path, monkeypatch
):
    """The CLI is the only refresher and the only quota source. The poll reads
    every slot exactly as stored and writes nothing back, so it can never
    rotate a refresh token out from under a running Claude Code."""
    store = _isolated_store(tmp_path)
    active = store.create(agent_key="claude", name="Active")
    parked = store.create(agent_key="claude", name="Parked")
    store.set_default("claude", active["id"])

    dead = 1_000  # epoch ms, long past
    vault = _SlotVault({
        "__default__": _slot_secret("default-old", "rt-default", dead),
        active["id"]: _slot_secret("active-old", "rt-active", dead),
        parked["id"]: _slot_secret("parked-old", "rt-parked", dead),
    })
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)

    async def fake_claude(home):
        return us._snapshot("claude", "ok",
                            windows=[us._window("session", "Session", 10, None)])

    monkeypatch.setattr(us, "fetch_claude", fake_claude)
    _stub_non_claude_fetchers(monkeypatch)

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    payload = await svc.poll_once(tmp_path)

    assert vault.writes == []  # nothing was renewed or rewritten
    assert payload["accounts"]["claude"][active["id"]]["status"] == "ok"
    assert payload["accounts"]["claude"][parked["id"]]["status"] == "not-measured"


async def test_a_parked_account_keeps_its_last_reading_marked_stale(
    tmp_path, monkeypatch
):
    """Only the signed-in account can be measured, but the parked one keeps the
    figure it measured for itself, labelled stale and with the time it was
    taken. Discarding it blanked both cards on every account switch — the
    outgoing one here, the incoming one from when it was parked — and a card
    reading "no data" looks exactly like a broken one. What must never happen
    is the old figure passing for a current one, so the staleness markers are
    asserted alongside the percentage."""
    store = _isolated_store(tmp_path)
    one = store.create(agent_key="claude", name="One")
    two = store.create(agent_key="claude", name="Two")
    store.set_default("claude", one["id"])

    alive = int(time.time() * 1000 + 3_600_000)
    vault = _SlotVault({
        "__default__": _slot_secret("d", "rt-d", alive),
        one["id"]: _slot_secret("a", "rt-a", alive),
        two["id"]: _slot_secret("b", "rt-b", alive),
    })
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)

    async def fake_claude(home):
        return us._snapshot("claude", "ok",
                            windows=[us._window("session", "Session", 40, None)])

    monkeypatch.setattr(us, "fetch_claude", fake_claude)
    _stub_non_claude_fetchers(monkeypatch)

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    first = await svc.poll_once(tmp_path)  # `one` measured while active
    assert svc._last_good["claude"][one["id"]]["windows"]
    # `two` has never been measured, so it has nothing to keep — a bare
    # not-measured row, with no staleness markers implying a lost reading.
    never = first["accounts"]["claude"][two["id"]]
    assert never["status"] == "not-measured"
    assert never["windows"] == []
    assert never.get("stale") is not True

    store.set_default("claude", two["id"])  # it is parked now
    svc.request_refresh()
    payload = await svc.poll_once(tmp_path)

    row = payload["accounts"]["claude"][one["id"]]
    # The reading survives …
    assert [w["usedPercent"] for w in row["windows"]] == [40]
    assert svc._last_good["claude"][one["id"]]["windows"]
    # … and cannot be mistaken for a live one.
    assert row["stale"] is True
    assert row["refreshStatus"] == "not-measured"
    assert row["lastSuccessAt"]


async def test_poll_delegates_refresh_when_the_active_token_expired(
    tmp_path, monkeypatch
):
    """An expired ACTIVE token is renewed by asking the CLI before the quota is
    read. The app still mints nothing — see claude_delegated_refresh."""
    from agent_team_backend import claude_delegated_refresh as dr

    store = _isolated_store(tmp_path)
    store.set_default("claude", None)
    dead, alive = 1_000, int(time.time() * 1000 + 3_600_000)
    vault = _SlotVault({"__default__": _slot_secret("stale", "rt", dead)})
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)

    attempts: list[Any] = []

    async def fake_attempt(v, **kwargs):
        attempts.append(v)
        vault.slots["__default__"] = _slot_secret("renewed", "rt2", alive)
        return dr.OUTCOME_REFRESHED

    monkeypatch.setattr(dr, "attempt", fake_attempt)

    async def fake_claude(home):
        return us._snapshot("claude", "ok",
                            windows=[us._window("session", "Session", 10, None)])

    monkeypatch.setattr(us, "fetch_claude", fake_claude)
    _stub_non_claude_fetchers(monkeypatch)

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    await svc.poll_once(tmp_path)

    assert len(attempts) == 1
    assert us.parse_claude_credentials(
        vault.slots["__default__"]
    )["accessToken"] == "renewed"


async def test_poll_leaves_an_expired_parked_slot_to_the_switch(
    tmp_path, monkeypatch
):
    """The CLI probe touches whatever is live, so a parked slot cannot be
    renewed this way — it stays expired until a switch brings it live."""
    from agent_team_backend import claude_delegated_refresh as dr

    store = _isolated_store(tmp_path)
    active = store.create(agent_key="claude", name="Active")
    parked = store.create(agent_key="claude", name="Parked")
    store.set_default("claude", active["id"])

    alive = int(time.time() * 1000 + 3_600_000)
    vault = _SlotVault({
        "__default__": _slot_secret("default-live", "rt-d", alive),
        active["id"]: _slot_secret("active-live", "rt-a", alive),
        parked["id"]: _slot_secret("parked-stale", "rt-p", 1_000),
    })
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)

    attempts: list[Any] = []

    async def fake_attempt(v, **kwargs):
        attempts.append(v)
        return dr.OUTCOME_REFRESHED

    monkeypatch.setattr(dr, "attempt", fake_attempt)

    async def fake_claude(home):
        return us._snapshot("claude", "ok",
                            windows=[us._window("session", "Session", 10, None)])

    monkeypatch.setattr(us, "fetch_claude", fake_claude)
    _stub_non_claude_fetchers(monkeypatch)

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    await svc.poll_once(tmp_path)

    assert attempts == []  # the active token was fine; the parked one is not ours to fix


async def test_the_residual_anthropic_call_identifies_itself_as_navide(monkeypatch):
    """opencode and pi keep an Anthropic OAuth grant in their own auth files,
    so that one call still goes out from here. It must say who is calling: the
    app used to send `claude-code/<version>`, assembled by running
    `claude --version`, which claimed to be a client it is not."""
    seen: dict = {}

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {}

    class _Client:
        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, headers=None):
            seen["url"] = url
            seen["headers"] = headers or {}
            return _Resp()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", _Client)

    await us.fetch_claude_oauth({
        "accessToken": "tok",
        "expiresAt": int(time.time() * 1000 + 3_600_000),
    })

    assert seen["headers"]["User-Agent"] == "Navide"
    assert "claude-code" not in json.dumps(seen["headers"])


def test_no_impersonating_user_agent_survives_anywhere() -> None:
    """No string this module can actually send may pose as Anthropic's own
    client. Docstrings are excluded on purpose — they explain the history, and
    a guard that failed on its own explanation would just get deleted."""
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(us))
    docstrings = {
        text
        for node in ast.walk(tree)
        if isinstance(
            node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
        )
        and (text := ast.get_docstring(node, clean=False))
    }
    offenders = [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and "claude-code/" in node.value
        and node.value not in docstrings
    ]

    assert offenders == []


async def _no_creds(provider: str) -> dict:
    return us._snapshot(provider, "no-credentials")


def _stub_non_claude_fetchers(monkeypatch) -> None:
    for name in ("codex", "kimi", "grok", "antigravity", "opencode", "qwen",
                 "kilo", "pi", "copilot", "cursor"):
        stub = lambda *a, _p=name, **k: _no_creds(_p)  # noqa: E731
        monkeypatch.setattr(us, f"fetch_{name}", stub)
        # The poll calls each vendor's `fetch_usage`, which late-binds the
        # fetcher in its own module: patching only the re-export above left
        # antigravity reading the real macOS Keychain.
        monkeypatch.setattr(f"agent_team_backend.cli_vendors.{name}.fetch_{name}", stub)


async def test_a_costly_failed_read_waits_the_full_read_interval(tmp_path, monkeypatch):
    """A read that spawned a whole Claude Code and still came back empty cost
    as much as a success. Retrying it on the short failure cooldown would boot
    the CLI three times as often as a working read — permanently."""
    async def costly(home):
        snap = us._snapshot("claude", "unavailable")
        snap["costlyRead"] = True
        return snap

    monkeypatch.setattr(us, "fetch_claude", costly)
    _stub_non_claude_fetchers(monkeypatch)

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    before = time.monotonic()
    payload = await svc.poll_once(tmp_path)

    blocked = svc._blocked_until[("claude", "__default__")]
    assert blocked - before > us.RATE_LIMIT_COOLDOWN  # not the cheap-failure price
    assert blocked - before <= us.CLAUDE_CLI_READ_INTERVAL + 1
    # The transient pricing flag never reaches the published snapshot.
    assert "costlyRead" not in payload["accounts"]["claude"]["__default__"]


async def test_a_spawnless_unavailable_keeps_the_short_cooldown(tmp_path, monkeypatch):
    """unavailable without a spawn (no CLI binary on the machine) stays on the
    short cooldown, so the badge recovers quickly after an install."""
    async def cheap(home):
        return us._snapshot("claude", "unavailable")

    monkeypatch.setattr(us, "fetch_claude", cheap)
    _stub_non_claude_fetchers(monkeypatch)

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    before = time.monotonic()
    await svc.poll_once(tmp_path)

    blocked = svc._blocked_until[("claude", "__default__")]
    assert blocked - before <= us.RATE_LIMIT_COOLDOWN + 1


# ── Switch announcement: making the wait visible ────────────────────────────


async def _append(sink: list, event: dict) -> None:
    sink.append(event)


async def test_announce_claude_switch_points_at_the_new_account_and_marks_it_reading(
    tmp_path, monkeypatch
):
    """A switch must move the badge onto the incoming account immediately and
    say its figure is still being read.

    Without this the pointer only moved inside `poll_once`, so every badge kept
    showing the OUTGOING account's numbers until the next cycle ended — and a
    Claude cycle boots a whole CLI, so that is tens of seconds of a screen that
    looks like the switch did nothing."""
    from agent_team_backend import app

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    svc.enabled = True
    svc._record_claude_snapshot("acct-old", us._snapshot(
        "claude", "ok", windows=[us._window("session", "Session", 10, None)]))
    svc._record_claude_snapshot("acct-new", us._snapshot(
        "claude", "ok", windows=[us._window("session", "Session", 80, None)]))
    svc._active_claude_slot = "acct-old"

    broadcasts: list[dict] = []
    monkeypatch.setattr(app, "broadcast", lambda event: _append(broadcasts, event))

    await svc.announce_claude_switch("acct-new")

    assert svc._active_claude_slot == "acct-new"
    # Broadcast without waiting for a poll — that is what makes it visible.
    assert len(broadcasts) == 1
    provider = broadcasts[0]["payload"]["providers"]["claude"]
    assert provider["windows"][0]["usedPercent"] == 80  # the incoming account
    assert provider["refreshPending"] is True
    # The outgoing account is not marked: nothing is being read for it.
    assert "refreshPending" not in broadcasts[0]["payload"]["accounts"]["claude"]["acct-old"]


async def test_announce_claude_switch_of_the_built_in_default_slot(tmp_path, monkeypatch):
    """`None` is how the built-in Default account is addressed everywhere else;
    it must land on the same slot id the poller uses, or the badge would point
    at an account that does not exist."""
    from agent_team_backend import app

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    svc.enabled = True
    svc._active_claude_slot = "acct-old"
    monkeypatch.setattr(app, "broadcast", lambda event: _append([], event))

    await svc.announce_claude_switch(None)

    assert svc._active_claude_slot == "__default__"
    # Never polled, so it gets the same last-good-or-nothing row a parked slot
    # gets — something has to carry the mark.
    assert svc.account_snapshots["claude"]["__default__"]["refreshPending"] is True


async def test_announce_claude_switch_promises_nothing_while_the_poller_is_off(
    tmp_path, monkeypatch
):
    """With the badge disabled no cycle is coming, so "reading now" would stay
    on screen forever. The pointer still moves — that part is just bookkeeping."""
    from agent_team_backend import app

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    svc.enabled = False
    svc._record_claude_snapshot("acct-new", us._snapshot("claude", "ok"))
    monkeypatch.setattr(app, "broadcast", lambda event: _append([], event))

    await svc.announce_claude_switch("acct-new")

    assert svc._active_claude_slot == "acct-new"
    assert "refreshPending" not in svc.account_snapshots["claude"]["acct-new"]


async def test_the_reading_mark_is_dropped_by_whatever_the_poll_writes(
    tmp_path, monkeypatch
):
    """The mark means "a read is in flight", so it must not outlive the read —
    including a read that failed. Both outcomes replace the snapshot."""
    from agent_team_backend import app

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    svc.enabled = True
    monkeypatch.setattr(app, "broadcast", lambda event: _append([], event))

    await svc.announce_claude_switch("acct-new")
    svc._record_claude_snapshot("acct-new", us._snapshot(
        "claude", "ok", windows=[us._window("session", "Session", 5, None)]))
    assert "refreshPending" not in svc.account_snapshots["claude"]["acct-new"]

    await svc.announce_claude_switch("acct-new")
    svc._record_claude_snapshot("acct-new", us._snapshot("claude", "unavailable"))
    assert "refreshPending" not in svc.account_snapshots["claude"]["acct-new"]

    await svc.announce_claude_switch("acct-new")
    svc._record_parked_claude_slot("acct-new")
    assert "refreshPending" not in svc.account_snapshots["claude"]["acct-new"]


async def test_announce_claude_switch_clears_the_read_cooldown(tmp_path, monkeypatch):
    """The incoming account's own 15-minute cooldown would otherwise hold the
    read the announcement just promised."""
    from agent_team_backend import app

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    svc.enabled = True
    svc._blocked_until[("claude", "acct-new")] = time.monotonic() + us.CLAUDE_CLI_READ_INTERVAL
    monkeypatch.setattr(app, "broadcast", lambda event: _append([], event))

    await svc.announce_claude_switch("acct-new")

    assert svc._blocked_until == {}
    assert svc._wake.is_set()


async def test_a_switch_during_a_poll_does_not_get_undone_by_that_poll(
    tmp_path, monkeypatch
):
    """The cycle that is already running read "who is active" before the switch
    happened. It must not write that answer back: doing so pointed the badge at
    the OUTGOING account, wiped the reading mark, and — worst — filed the CLI's
    figure (which reports whoever is signed in NOW) under the outgoing slot,
    persisting one account's quota as another's."""
    from agent_team_backend import app

    store = _isolated_store(tmp_path)
    one = store.create(agent_key="claude", name="One")
    two = store.create(agent_key="claude", name="Two")
    store.set_default("claude", one["id"])

    alive = int(time.time() * 1000 + 3_600_000)
    vault = _SlotVault({
        "__default__": _slot_secret("d", "rt-d", alive),
        one["id"]: _slot_secret("a", "rt-a", alive),
        two["id"]: _slot_secret("b", "rt-b", alive),
    })
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)
    monkeypatch.setattr(app, "broadcast", lambda event: _append([], event))

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    svc.enabled = True

    switched = asyncio.Event()

    async def fake_claude(home):
        # The read is in flight — this is when the user switches accounts.
        store.set_default("claude", two["id"])
        await svc.announce_claude_switch(two["id"])
        switched.set()
        return us._snapshot("claude", "ok",
                            windows=[us._window("session", "Session", 40, None)])

    monkeypatch.setattr(us, "fetch_claude", fake_claude)
    _stub_non_claude_fetchers(monkeypatch)

    payload = await svc.poll_once(tmp_path)

    assert switched.is_set()
    # The pointer stays where the switch put it.
    assert svc._active_claude_slot == two["id"]
    # The mark survives: a read for the new account is still owed.
    assert payload["accounts"]["claude"][two["id"]]["refreshPending"] is True
    # And the figure read under the new account's credentials was NOT filed
    # under the old one, nor persisted as its last good reading.
    assert svc._last_good.get("claude", {}).get(one["id"]) is None
    assert not (tmp_path / "usage-cache.json").exists()  # nothing was persisted


async def test_an_unresolvable_ledger_clears_a_mark_it_can_never_answer(
    tmp_path, monkeypatch
):
    """With no profiles store the poll can only read `__default__`, so a named
    slot is neither polled nor re-recorded — its mark would say "reading" for
    the rest of the session. Nothing is in flight for it, so it is cleared."""
    from agent_team_backend import app

    monkeypatch.setattr(app, "broadcast", lambda event: _append([], event))
    monkeypatch.setattr(us, "_get_profiles_store", lambda: None)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: None)

    async def fake_claude(home):
        return us._snapshot("claude", "ok",
                            windows=[us._window("session", "Session", 40, None)])

    monkeypatch.setattr(us, "fetch_claude", fake_claude)
    _stub_non_claude_fetchers(monkeypatch)

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    svc.enabled = True
    await svc.announce_claude_switch("acct-b")
    assert svc.account_snapshots["claude"]["acct-b"]["refreshPending"] is True

    await svc.poll_once(tmp_path)

    assert "refreshPending" not in svc.account_snapshots["claude"]["acct-b"]


async def test_announce_without_a_read_moves_the_pointer_but_promises_nothing(
    tmp_path, monkeypatch
):
    """Switching onto an account that has to sign in first opens a login pane;
    telling the user its quota is being read at the same time is a lie."""
    from agent_team_backend import app

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    svc.enabled = True
    monkeypatch.setattr(app, "broadcast", lambda event: _append([], event))

    await svc.announce_claude_switch("acct-out", reading=False)

    assert svc._active_claude_slot == "acct-out"
    assert "refreshPending" not in svc.account_snapshots["claude"]["acct-out"]


async def test_a_second_announcement_clears_a_mark_it_no_longer_owns(
    tmp_path, monkeypatch
):
    """Switching to an account that then turns out to need a sign-in must take
    back the promise made a moment earlier, not leave both on screen."""
    from agent_team_backend import app

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    svc.enabled = True
    monkeypatch.setattr(app, "broadcast", lambda event: _append([], event))

    await svc.announce_claude_switch("acct-b")
    assert svc.account_snapshots["claude"]["acct-b"]["refreshPending"] is True
    await svc.announce_claude_switch("acct-b", reading=False)
    assert "refreshPending" not in svc.account_snapshots["claude"]["acct-b"]


# ── Scoped refresh (one account card's own Refresh button) ──────────────────


def test_request_refresh_without_a_provider_clears_every_cooldown():
    svc = us.UsageService()
    svc._blocked_until = {"codex": 100.0, ("claude", "__default__"): 200.0}

    svc.request_refresh()

    assert svc._blocked_until == {}


def test_request_refresh_for_one_provider_leaves_the_others_waiting():
    """A card's Refresh must not buy every other CLI a read as a side effect —
    for Claude that means launching its CLI, which is what the cooldown is
    there to ration."""
    svc = us.UsageService()
    svc._blocked_until = {
        "codex": 100.0,
        "kimi": 150.0,
        ("claude", "__default__"): 200.0,
    }

    svc.request_refresh("codex")

    assert svc._blocked_until == {"kimi": 150.0, ("claude", "__default__"): 200.0}


def test_request_refresh_for_claude_clears_only_the_named_slot():
    svc = us.UsageService()
    svc._active_claude_slot = "p1"
    svc._blocked_until = {
        "codex": 100.0,
        ("claude", "__default__"): 200.0,
        ("claude", "p1"): 300.0,
    }

    svc.request_refresh("claude", "__default__")
    assert svc._blocked_until == {"codex": 100.0, ("claude", "p1"): 300.0}

    # No slot named: the active account, the only one the CLI can report on.
    svc.request_refresh("claude")
    assert svc._blocked_until == {"codex": 100.0}


async def test_usage_refresh_handler_forwards_the_card_scope(monkeypatch):
    from agent_team_backend import ws_handlers

    calls: list[tuple[str | None, str | None]] = []
    monkeypatch.setattr(
        us.service,
        "request_refresh",
        lambda provider=None, slot_id=None: calls.append((provider, slot_id)),
    )

    class _Session:
        def __init__(self) -> None:
            self.sent: list[dict] = []

        async def send_json(self, message: dict) -> None:
            self.sent.append(message)

    session = _Session()
    await ws_handlers.usage_refresh(
        session, "m1", "usage.refresh", {"agentKey": "claude", "slotId": "p1"}
    )
    await ws_handlers.usage_refresh(session, "m2", "usage.refresh", {"agentKey": "codex"})
    await ws_handlers.usage_refresh(session, "m3", "usage.refresh", {})

    assert calls == [("claude", "p1"), ("codex", None), (None, None)]
    assert [m["payload"]["ok"] for m in session.sent] == [True, True, True]



def _mute_non_claude_vendors(svc: "us.UsageService") -> None:
    """Keep a poll to its Claude leg only.

    `poll_once` reaches the other vendors through `spec.fetch_usage`, which
    holds the vendor module's own function — patching `us.fetch_<vendor>` does
    not intercept it, and `fetch_cursor` really does shell out to
    `/usr/bin/security`. A test that cancels a cycle mid-flight would orphan
    those subprocesses. The cooldown gate is the supported way to skip a
    provider, and Claude's key is a `(provider, slot)` tuple, so its own read
    still runs."""
    blocked = time.monotonic() + 3600
    for provider in us._CLI_VENDORS:
        svc._blocked_until[provider] = blocked


async def test_a_switch_cancels_the_in_flight_claude_read_instead_of_waiting_it_out(
    tmp_path, monkeypatch
):
    """A switch must not have to sit out the read that was already running.

    The epoch guard throws that read's answer away, but only after awaiting it,
    and the poller awaits `poll_once` whole — so the read the switch asked for
    could not even start until the doomed one finished. That wait is the
    Claude probe's whole budget (minutes, not seconds), which is exactly the
    "I switched and nothing happened" the announcement exists to prevent."""
    from agent_team_backend import app

    monkeypatch.setattr(app, "broadcast", lambda event: _append([], event))
    monkeypatch.setattr(us, "_get_profiles_store", lambda: None)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: None)

    reading = asyncio.Event()
    finished = False

    async def slow_claude(home):
        nonlocal finished
        reading.set()
        await asyncio.sleep(30)  # stands in for the CLI boot
        finished = True
        return us._snapshot("claude", "ok",
                            windows=[us._window("session", "Session", 40, None)])

    monkeypatch.setattr(us, "fetch_claude", slow_claude)

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    svc.enabled = True
    _mute_non_claude_vendors(svc)

    poll = asyncio.create_task(svc.poll_once(tmp_path))
    await asyncio.wait_for(reading.wait(), timeout=5)

    await svc.announce_claude_switch("acct-new")

    # The whole point: the cycle returns now, not in 30 seconds.
    payload = await asyncio.wait_for(poll, timeout=5)

    assert finished is False  # the read really was dropped, not awaited
    assert svc._active_claude_slot == "acct-new"
    # Nothing was filed for the cancelled read, under either slot.
    assert svc._last_good.get("claude", {}).get("__default__") is None
    assert payload["accounts"]["claude"]["acct-new"]["refreshPending"] is True
    # The bookkeeping does not leak into the next cycle.
    assert svc._claude_reads == {}
    assert svc._reads_cancelled == set()


async def test_a_cancellation_that_is_not_a_switch_still_propagates(
    tmp_path, monkeypatch
):
    """Shutdown cancels the poller. Swallowing that the way a switch's own
    cancellation is swallowed would leave the cycle running through a stop it
    was told to obey, so only cancellations this service asked for are eaten."""
    from agent_team_backend import app

    monkeypatch.setattr(app, "broadcast", lambda event: _append([], event))
    monkeypatch.setattr(us, "_get_profiles_store", lambda: None)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: None)

    reading = asyncio.Event()

    async def slow_claude(home):
        reading.set()
        await asyncio.sleep(30)
        return us._snapshot("claude", "ok")

    monkeypatch.setattr(us, "fetch_claude", slow_claude)

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    svc.enabled = True
    _mute_non_claude_vendors(svc)

    poll = asyncio.create_task(svc.poll_once(tmp_path))
    await asyncio.wait_for(reading.wait(), timeout=5)
    poll.cancel()

    with pytest.raises(asyncio.CancelledError):
        await poll


async def test_a_read_that_announces_its_own_switch_is_not_cancelled_by_it(
    tmp_path, monkeypatch
):
    """`_cancel_claude_reads` must skip the caller's own task. Announcing from
    inside a read would otherwise cancel the coroutine doing the announcing,
    so `announce_claude_switch` would raise `CancelledError` at its caller —
    and that caller is the account-switch WebSocket handler."""
    from agent_team_backend import app

    monkeypatch.setattr(app, "broadcast", lambda event: _append([], event))
    monkeypatch.setattr(us, "_get_profiles_store", lambda: None)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: None)

    returned = False

    async def self_announcing_claude(home):
        nonlocal returned
        await svc.announce_claude_switch("acct-new")
        returned = True
        return us._snapshot("claude", "ok",
                            windows=[us._window("session", "Session", 40, None)])

    monkeypatch.setattr(us, "fetch_claude", self_announcing_claude)

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    svc.enabled = True
    _mute_non_claude_vendors(svc)

    await asyncio.wait_for(svc.poll_once(tmp_path), timeout=5)

    assert returned is True


class _AccountDirVault(_SlotVault):
    """Slots plus claude accounts that signed in inside their own config dir."""

    def __init__(self, slots, signed_in_dirs):
        super().__init__(slots)
        self.signed_in_dirs = set(signed_in_dirs)

    def account_dir_signed_in(self, slot_id: str) -> bool:
        return slot_id in self.signed_in_dirs

    def account_dir_path(self, slot_id: str) -> Path:
        return Path("/account-dirs") / slot_id


async def test_a_parked_account_with_its_own_config_dir_is_measured_live(
    tmp_path, monkeypatch
):
    """An account that signed in inside its own config dir can be asked
    directly — its /usage read runs on that dir, not the live login — so it
    gets a current figure instead of its old one marked stale. An account
    without one stays not-measured, exactly as before."""
    store = _isolated_store(tmp_path)
    active = store.create(agent_key="claude", name="Active")
    with_dir = store.create(agent_key="claude", name="Dir")
    without = store.create(agent_key="claude", name="NoDir")
    store.set_default("claude", active["id"])
    vault = _AccountDirVault({}, {with_dir["id"]})
    monkeypatch.setattr(us, "_get_profiles_store", lambda: store)
    monkeypatch.setattr(us, "_get_credential_vault", lambda: vault)

    async def fake_claude(home):
        return us._snapshot("claude", "ok",
                            windows=[us._window("session", "Session", 10, None)])

    read_dirs: list[Path] = []

    async def fake_dir(directory):
        read_dirs.append(directory)
        return us._snapshot("claude", "ok",
                            windows=[us._window("session", "Session", 70, None)])

    monkeypatch.setattr(us, "fetch_claude", fake_claude)
    monkeypatch.setattr(us, "fetch_claude_account_dir", fake_dir)
    _stub_non_claude_fetchers(monkeypatch)

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    payload = await svc.poll_once(tmp_path)

    assert read_dirs == [Path("/account-dirs") / with_dir["id"]]
    row = payload["accounts"]["claude"][with_dir["id"]]
    assert row["status"] == "ok"
    assert row["stale"] is False
    assert row["windows"][0]["usedPercent"] == 70
    assert payload["accounts"]["claude"][without["id"]]["status"] == "not-measured"
    assert payload["accounts"]["claude"][active["id"]]["windows"][0]["usedPercent"] == 10


class _IdentityVault(_RecordingVault):
    def __init__(self, root: Path, live: str, slot: str) -> None:
        super().__init__(root=root)
        self._emails = {None: live, "slot": slot}

    def identity(self, agent_key: str, slot_id: str | None = None) -> dict:
        email = self._emails[None if slot_id is None else "slot"]
        return {"signedIn": True, "email": email}

    def restore(self, agent_key: str, slot_id: str) -> bool:
        self.restored.append((agent_key, slot_id))
        return True


@pytest.mark.asyncio
@pytest.mark.parametrize(("live", "restored"), [("me@example.com", True), ("other@example.com", False)])
async def test_a_harvested_active_login_never_overrides_an_account_changed_outside_navide(
    tmp_path, monkeypatch, _isolated_convenience_gate, live, restored
) -> None:
    """D7: restoring live is the auto-repair; a different signed-in account
    is the user's own change, answered with a prompt instead."""
    vault = _IdentityVault(tmp_path / "slots", live=live, slot="me@example.com")
    monkeypatch.setattr(us, "_login_pane_running", lambda agent_key, profile_id: False)
    monkeypatch.setattr(us, "_active_profile_id", lambda agent_key: "p1")
    monkeypatch.setattr(us, "_dedupe_harvested_login", lambda vault, agent_key, profile_id: profile_id)

    assert await us._harvest_login_home_locked(vault, "claude", "p1") is True

    assert vault.restored == ([("claude", "p1")] if restored else [])
    actions = [e["action"] for e in _isolated_convenience_gate.history()]
    assert actions == (["repair"] if restored else ["prompt"])
