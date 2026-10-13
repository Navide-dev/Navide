"""Validated MCP server settings persistence.

The app is local-first, so MCP settings are stored as an atomic JSON document
under the app-data directory instead of a relational table.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import re
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .applog import app_data_dir

log = logging.getLogger("agent_team_backend.mcp_settings")

MCP_CONFIG_FILE = "mcp_servers.json"
REDACTED_SECRET = "***"

_MCP_SIZE_LIMIT = 1_000_000
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_HEADER_KEY_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
#: Characters that print as nothing or as a blank though they are not a
#: space: Hangul fillers, the braille blank, the combining grapheme joiner.
_BLANK_LOOKING = frozenset("\u115f\u1160\u3164\uffa0\u2800\u034f")
#: Invisible characters real paths and names carry, allowed: ZWNJ (Persian),
#: ZWJ and VS16 (emoji), NBSP, and NNBSP (macOS screenshot file names). The
#: approval screen shows them escaped.
_ALLOWED_INVISIBLE = frozenset("\u200c\u200d\ufe0f\u00a0\u202f")


def _has_invisible(value: str) -> bool:
    """Whether *value* holds a character that hides what it says: format
    characters (bidi overrides, zero-width space), separators other than the
    plain space, private-use or surrogate code points, variation selectors
    and the blank-looking letters above — less the ones real paths carry
    (``_ALLOWED_INVISIBLE``).

    Not part of the schema: a config this machine already has loads whatever
    it holds. Sync asks it of records that arrive from another device, and of
    a record again when it is approved (sync_scopes)."""
    import unicodedata

    for ch in value:
        if ch in _ALLOWED_INVISIBLE:
            continue
        cat = unicodedata.category(ch)
        cp = ord(ch)
        if cat in ("Cf", "Co", "Cs", "Zl", "Zp") or (cat == "Zs" and ch != " "):
            return True
        if ch in _BLANK_LOOKING or 0xFE00 <= cp <= 0xFE0F or 0xE0100 <= cp <= 0xE01EF:
            return True
    return False
_SECRET_TOKENS = {
    "KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "PASSPHRASE",
    "AUTH",
    "AUTHORIZATION",
    "COOKIE",
    "CREDENTIAL",
    "CREDENTIALS",
}


class MCPSettingsError(ValueError):
    """The persisted MCP document could not be read or validated."""


class MCPSettingsConflictError(MCPSettingsError):
    """The MCP document changed after the caller last read it."""

    def __init__(self, expected_revision: int, actual_revision: int) -> None:
        self.expected_revision = expected_revision
        self.actual_revision = actual_revision
        super().__init__(
            f"MCP settings changed on disk (expected revision {expected_revision}, "
            f"found {actual_revision})"
        )


def default_mcp_servers() -> list[dict[str, Any]]:
    return [
        {
            "name": "context7",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@upstash/context7-mcp"],
            "env": {},
            "enabled": True,
        }
    ]


class _MCPServerBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=64)
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        normalized = value.strip()
        if not _NAME_RE.match(normalized):
            raise ValueError("name must be lowercase letters, digits, underscore or dash")
        return normalized


class MCPStdioServerSetting(_MCPServerBase):
    transport: Literal["stdio"] = "stdio"
    command: str = Field(min_length=1, max_length=256)
    args: list[str] = Field(default_factory=list, max_length=64)
    env: dict[str, str] = Field(default_factory=dict)

    @field_validator("command")
    @classmethod
    def validate_command(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized or _CONTROL_CHARS_RE.search(normalized):
            raise ValueError("command must not contain control characters")
        return normalized

    @field_validator("args")
    @classmethod
    def validate_args(cls, values: list[str]) -> list[str]:
        clean: list[str] = []
        for arg in values:
            if not isinstance(arg, str):
                raise ValueError("args must be strings")
            if len(arg) > 512 or _CONTROL_CHARS_RE.search(arg):
                raise ValueError("args must not contain control characters")
            clean.append(arg)
        return clean

    @field_validator("env")
    @classmethod
    def validate_env(cls, value: dict[str, str]) -> dict[str, str]:
        clean: dict[str, str] = {}
        for key, env_value in value.items():
            if not _ENV_KEY_RE.match(key):
                raise ValueError(f"invalid env key: {key}")
            if not isinstance(env_value, str):
                raise ValueError("env values must be strings")
            if len(env_value) > 4096 or _CONTROL_CHARS_RE.search(env_value):
                raise ValueError("env values must not contain control characters")
            clean[key] = env_value
        return clean


class _MCPRemoteServerSetting(_MCPServerBase):
    url: str = Field(min_length=1, max_length=2048)
    headers: dict[str, str] = Field(default_factory=dict)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        normalized = value.strip()
        if (
            not normalized
            or _CONTROL_CHARS_RE.search(normalized)
            or not normalized.startswith(("http://", "https://"))
        ):
            raise ValueError("url must use http or https and contain no control characters")
        return normalized

    @field_validator("headers")
    @classmethod
    def validate_headers(cls, value: dict[str, str]) -> dict[str, str]:
        clean: dict[str, str] = {}
        for key, header_value in value.items():
            if not _HEADER_KEY_RE.match(key):
                raise ValueError(f"invalid header name: {key}")
            if not isinstance(header_value, str):
                raise ValueError("header values must be strings")
            if len(header_value) > 4096 or _CONTROL_CHARS_RE.search(header_value):
                raise ValueError("header values must not contain control characters")
            clean[key] = header_value
        return clean


class MCPHttpServerSetting(_MCPRemoteServerSetting):
    transport: Literal["http"]


class MCPSseServerSetting(_MCPRemoteServerSetting):
    transport: Literal["sse"]


MCPServerSetting = Annotated[
    MCPStdioServerSetting | MCPHttpServerSetting | MCPSseServerSetting,
    Field(discriminator="transport"),
]


def _add_legacy_transports(servers: Any) -> tuple[Any, bool]:
    if not isinstance(servers, list):
        return servers, False
    migrated = False
    normalized: list[Any] = []
    for server in servers:
        if isinstance(server, dict) and "transport" not in server:
            normalized.append({**server, "transport": "stdio"})
            migrated = True
        else:
            normalized.append(server)
    return normalized, migrated


class MCPServersDocument(BaseModel):
    servers: list[MCPServerSetting] = Field(default_factory=list, max_length=32)

    @model_validator(mode="before")
    @classmethod
    def migrate_legacy_servers(cls, value: Any) -> Any:
        if not isinstance(value, dict) or "servers" not in value:
            return value
        servers, _ = _add_legacy_transports(value.get("servers"))
        return {**value, "servers": servers}

    @model_validator(mode="after")
    def validate_unique_names(self) -> "MCPServersDocument":
        names = [server.name for server in self.servers]
        if len(names) != len(set(names)):
            raise ValueError("server names must be unique")
        return self


def is_secret_setting_name(name: str) -> bool:
    """Return whether an env/header name is likely to contain a secret."""
    camel_split = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name)
    camel_split = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", camel_split)
    tokens = [token for token in re.split(r"[^A-Za-z0-9]+", camel_split.upper()) if token]
    return any(token in _SECRET_TOKENS for token in tokens)


def redact_mcp_server_secrets(servers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a deep copy with secret-looking env/header values redacted."""
    redacted = copy.deepcopy(servers)
    for server in redacted:
        for field_name in ("env", "headers"):
            values = server.get(field_name)
            if not isinstance(values, dict):
                continue
            for key in values:
                if is_secret_setting_name(str(key)) and values[key]:
                    values[key] = REDACTED_SECRET
    return redacted


def restore_mcp_server_secrets(
    servers: list[dict[str, Any]],
    existing_servers: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Restore redacted env/header values from matching existing servers.

    A redacted value with no matching local value is omitted so the sentinel is
    never persisted as a credential.
    """
    restored = copy.deepcopy(servers)
    existing_by_name = {
        server.get("name"): server
        for server in existing_servers
        if isinstance(server, dict) and isinstance(server.get("name"), str)
    }
    for server in restored:
        existing = existing_by_name.get(server.get("name"), {})
        for field_name in ("env", "headers"):
            values = server.get(field_name)
            if not isinstance(values, dict):
                continue
            existing_values = existing.get(field_name, {})
            if not isinstance(existing_values, dict):
                existing_values = {}
            for key, value in list(values.items()):
                if value != REDACTED_SECRET or not is_secret_setting_name(str(key)):
                    continue
                if key in existing_values:
                    values[key] = existing_values[key]
                else:
                    del values[key]
    return restored


class MCPSettingsStore:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (app_data_dir() / MCP_CONFIG_FILE)

    @property
    def path(self) -> Path:
        return self._path

    @property
    def revision(self) -> int:
        try:
            return self._path.stat().st_mtime_ns
        except FileNotFoundError:
            return 0

    def list_servers(self) -> list[dict[str, Any]]:
        return [server.model_dump() for server in self._read_document().servers]

    def list_enabled(self) -> list[dict[str, Any]]:
        return [server for server in self.list_servers() if server.get("enabled", True)]

    def replace_servers(
        self,
        servers: list[dict[str, Any]],
        expected_revision: int | None = None,
    ) -> list[dict[str, Any]]:
        document = MCPServersDocument(servers=servers)
        self._write_document(document, expected_revision=expected_revision)
        log.info("MCP settings saved: %d server(s)", len(document.servers))
        return [server.model_dump() for server in document.servers]

    def reset(self, expected_revision: int | None = None) -> list[dict[str, Any]]:
        document = MCPServersDocument(servers=default_mcp_servers())
        self._write_document(document, expected_revision=expected_revision)
        return [server.model_dump() for server in document.servers]

    def _read_document(self) -> MCPServersDocument:
        if not self._path.exists():
            document = MCPServersDocument(servers=default_mcp_servers())
            self._write_document(document)
            return document
        revision = self.revision
        try:
            if self._path.stat().st_size > _MCP_SIZE_LIMIT:
                raise ValueError("MCP config file exceeds 1 MB")
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                servers_raw = raw
            elif isinstance(raw, dict):
                servers_raw = raw.get("servers")
            else:
                raise ValueError("mcp config must be a JSON array or object")
            servers, migrated = _add_legacy_transports(servers_raw)
            document = MCPServersDocument(servers=servers)
        except Exception as err:
            if isinstance(err, MCPSettingsError):
                raise
            raise MCPSettingsError(f"invalid MCP settings: {err}") from err
        if migrated:
            self._write_document(document, expected_revision=revision)
        return document

    def _write_document(
        self,
        document: MCPServersDocument,
        *,
        expected_revision: int | None = None,
    ) -> None:
        actual_revision = self.revision
        if expected_revision is not None and expected_revision != actual_revision:
            raise MCPSettingsConflictError(expected_revision, actual_revision)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        payload = [server.model_dump() for server in document.servers]
        try:
            tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self._path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
        # The revision is the file's mtime, which Linux advances per kernel tick
        # (milliseconds), so a rewrite inside the tick that stamped
        # `actual_revision` would leave it unchanged and a stale writer could
        # not be told apart from a fresh one. Nudge it past every value a
        # reader may already hold. NTFS stores mtime in 100 ns units, so a
        # nudge of 1 ns rounds back to the same value; step by a microsecond
        # until the stamp actually moves.
        bumped = actual_revision
        while self.revision <= actual_revision:
            bumped += 1_000
            os.utime(self._path, ns=(bumped, bumped))
