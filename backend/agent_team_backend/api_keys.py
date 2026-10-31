"""API keys as a separate way to pay for a CLI, stored apart from CLI accounts.

A subscription account is a credential slot that ``credential_vault`` swaps
into the CLI's live location. An API key is not: nothing here touches a slot, a
switch, or a quota probe, and this module imports none of those paths.

What is stored, and where:

* the key itself goes to the OS secret store through ``cloud_secrets.write``,
  under a backend-owned name (macOS Keychain; an owner-only file wrapped by the
  platform elsewhere);
* the metadata (name, CLI, last four characters, spend reminder) goes to
  ``api-keys.json`` in the data directory.

Neither is a sync scope, so neither reaches Navide Cloud, a shared bundle or a
settings export. The key never leaves the backend once it is stored: every
message here answers with metadata only, and no error or log line quotes it.

Using a key in a pane is not implemented. ``launch_env`` is the seam for it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Mapping
from uuid import uuid4

import httpx

from . import cloud_secrets
from .applog import app_data_dir
from .credential_vault import CredentialVault
from .http_ssl import default_ssl_context
from .ipc import make_event, make_response

if TYPE_CHECKING:
    from .app import Session

log = logging.getLogger("agent_team_backend.api_keys")

API_KEYS_FILE = "api-keys.json"
SCHEMA_VERSION = 1
#: The CLIs a key can be stored for. Each needs its own way into a pane, so the
#: list grows one vendor at a time.
SUPPORTED_AGENT_KEYS = ("claude", "codex")
NAME_MAX_CHARS = 60
SECRET_MAX_CHARS = 512
MONTHLY_REMINDER_MAX_USD = 1_000_000
PROBE_TIMEOUT_S = 10.0

_SECRET_NAME_PREFIX = "cli-api-key-"
# A Claude subscription token also starts with the Anthropic prefix. It is not
# an API key: it spends the subscription, and storing it is a different
# decision with different terms.
_ANTHROPIC_OAUTH_PREFIX = "sk-ant-" + "oat"
_ANTHROPIC_PREFIX = "sk-ant-"
_OPENAI_PROJECT_PREFIX = "sk-" + "proj-"


class ApiKeyError(Exception):
    """A request that cannot be served. Never carries a key."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def validate_secret(agent_key: str, raw: Any) -> str:
    """The key to store, or an ``ApiKeyError`` saying what is wrong with it."""
    if not isinstance(raw, str):
        raise ApiKeyError("invalid-secret", "Paste the API key.")
    secret = raw.strip()
    if not secret:
        raise ApiKeyError("invalid-secret", "Paste the API key.")
    if len(secret) > SECRET_MAX_CHARS:
        raise ApiKeyError("invalid-secret", "This is too long to be an API key.")
    if any(not 0x21 <= ord(char) <= 0x7E for char in secret):
        raise ApiKeyError("invalid-secret", "An API key has no spaces or line breaks.")
    if secret.startswith(_ANTHROPIC_OAUTH_PREFIX):
        raise ApiKeyError(
            "subscription-token",
            "This is a subscription token, not an API key. Create an API key in the Claude Console.",
        )
    if agent_key == "codex" and secret.startswith(_ANTHROPIC_PREFIX):
        raise ApiKeyError("wrong-vendor", "This is an Anthropic key. Codex needs an OpenAI key.")
    if agent_key == "claude" and secret.startswith(_OPENAI_PROJECT_PREFIX):
        raise ApiKeyError("wrong-vendor", "This is an OpenAI key. Claude Code needs an Anthropic key.")
    return secret


def _validate_agent(raw: Any) -> str:
    if raw not in SUPPORTED_AGENT_KEYS:
        raise ApiKeyError("unsupported-agent", "API keys are not supported for this CLI yet.")
    return raw


def _validate_name(raw: Any) -> str:
    name = raw.strip() if isinstance(raw, str) else ""
    if not name or len(name) > NAME_MAX_CHARS:
        raise ApiKeyError("invalid-name", f"Enter a name of up to {NAME_MAX_CHARS} characters.")
    return name


def _validate_reminder(raw: Any) -> float | None:
    if raw is None or raw == "":
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ApiKeyError("invalid-reminder", "Enter the monthly reminder as an amount in USD.")
    if not 0 < raw <= MONTHLY_REMINDER_MAX_USD:
        raise ApiKeyError("invalid-reminder", "Enter the monthly reminder as an amount above zero.")
    return float(raw)


class ApiKeyStore:
    """The metadata file plus the secret store, kept in step."""

    def __init__(self, vault: CredentialVault, path: Path | None = None) -> None:
        self._vault = vault
        self._path = path
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self._path if self._path is not None else app_data_dir() / API_KEYS_FILE

    def _read(self) -> list[dict[str, Any]]:
        try:
            doc = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        rows = doc.get("keys") if isinstance(doc, dict) else None
        return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []

    def _write(self, rows: list[dict[str, Any]]) -> None:
        path = self.path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{uuid4().hex}.tmp")
        text = json.dumps({"schemaVersion": SCHEMA_VERSION, "keys": rows}, ensure_ascii=False, indent=2)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text)
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)

    def _find(self, rows: list[dict[str, Any]], key_id: Any) -> dict[str, Any]:
        for row in rows:
            if row.get("id") == key_id:
                return row
        raise ApiKeyError("not-found", "This API key no longer exists.")

    def _store_secret(self, key_id: str, secret: str | None) -> None:
        try:
            cloud_secrets.write(self._vault, _SECRET_NAME_PREFIX + key_id, secret)
        except Exception as err:  # noqa: BLE001 - the message may quote the service, never the key
            log.warning("api key secret write failed (%s)", type(err).__name__)
            raise ApiKeyError("store-failed", "Could not save to this computer's keychain.") from None

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._read()

    def create(self, agent_key: Any, name: Any, secret: Any, monthly_reminder: Any = None) -> dict[str, Any]:
        agent = _validate_agent(agent_key)
        clean_name = _validate_name(name)
        reminder = _validate_reminder(monthly_reminder)
        clean_secret = validate_secret(agent, secret)
        row = {
            "id": uuid4().hex,
            "kind": "api-key",
            "agentKey": agent,
            "name": clean_name,
            "last4": clean_secret[-4:],
            "monthlyReminderUsd": reminder,
            "createdAt": int(time.time()),
        }
        with self._lock:
            rows = self._read()
            self._store_secret(row["id"], clean_secret)
            try:
                self._write([*rows, row])
            except OSError:
                self._store_secret(row["id"], None)
                raise ApiKeyError("store-failed", "Could not save this API key.") from None
        return row

    def update(self, key_id: Any, fields: Mapping[str, Any]) -> dict[str, Any]:
        with self._lock:
            rows = self._read()
            row = self._find(rows, key_id)
            if "name" in fields:
                row["name"] = _validate_name(fields["name"])
            if "monthlyReminderUsd" in fields:
                row["monthlyReminderUsd"] = _validate_reminder(fields["monthlyReminderUsd"])
            self._write(rows)
            return row

    def replace_secret(self, key_id: Any, secret: Any) -> dict[str, Any]:
        with self._lock:
            rows = self._read()
            row = self._find(rows, key_id)
            clean_secret = validate_secret(row["agentKey"], secret)
            self._store_secret(row["id"], clean_secret)
            row["last4"] = clean_secret[-4:]
            self._write(rows)
            return row

    def delete(self, key_id: Any) -> None:
        with self._lock:
            rows = self._read()
            row = self._find(rows, key_id)
            # The secret goes first: a failure here keeps the row, so the key is
            # never left behind with nothing in the app pointing at it.
            self._store_secret(row["id"], None)
            self._write([other for other in rows if other is not row])

    def read_secret(self, key_id: Any) -> str:
        """Backend use only. No message handler may return this value."""
        with self._lock:
            row = self._find(self._read(), key_id)
        try:
            secret = self._vault.read_app_secret(_SECRET_NAME_PREFIX + row["id"])
        except Exception as err:  # noqa: BLE001
            log.warning("api key secret read failed (%s)", type(err).__name__)
            raise ApiKeyError("store-failed", "Could not read from this computer's keychain.") from None
        if secret is None:
            raise ApiKeyError("secret-missing", "This API key is no longer in the keychain. Paste it again.")
        return secret


def launch_env(store: ApiKeyStore, agent_key: str, key_id: str) -> dict[str, str]:
    """The environment a pane would need to spend this key.

    TODO: not implemented. Bringing a key into a CLI's launch changes the
    credential path of every spawn and needs the owner's explicit approval
    first. Until then a stored key is not used by any pane.
    """
    return {}


def _probe_request(agent_key: str, secret: str) -> tuple[str, dict[str, str]]:
    if agent_key == "claude":
        return "https://api.anthropic.com/v1/models?limit=1", {"x-api-key": secret, "anthropic-version": "2023-06-01"}
    return "https://api.openai.com/v1/models", {"Authorization": f"Bearer {secret}"}


async def _http_status(url: str, headers: dict[str, str]) -> int:
    async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_S, verify=await default_ssl_context(), follow_redirects=False) as client:
        return (await client.get(url, headers=headers)).status_code


async def probe(
    agent_key: str,
    secret: str,
    fetch_status: Callable[[str, dict[str, str]], Awaitable[int]] = _http_status,
) -> str:
    """Ask the vendor whether the key works. ``ok``, ``rejected``, or
    ``unknown`` when the answer says nothing about the key (offline, rate
    limited, a vendor outage). Sent only to the vendor that issued the key."""
    url, headers = _probe_request(agent_key, secret)
    try:
        status = await fetch_status(url, headers)
    except Exception as err:  # noqa: BLE001 - offline is an answer, and the error text stays out of logs
        log.info("api key probe failed (%s)", type(err).__name__)
        return "unknown"
    if status == 200:
        return "ok"
    return "rejected" if status in (401, 403) else "unknown"


_store: ApiKeyStore | None = None


def store() -> ApiKeyStore:
    global _store
    if _store is None:
        from . import app

        _store = ApiKeyStore(app.credential_vault)
    return _store


def _supported_payload(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {"ok": True, "keys": rows, "supportedAgents": list(SUPPORTED_AGENT_KEYS)}


async def _broadcast() -> None:
    from . import app

    rows = await asyncio.to_thread(store().list)
    await app.broadcast(make_event("api_keys.changed", _supported_payload(rows)))


async def _answer(session: "Session", msg_id: str, msg_type: str, work: Callable[[], Awaitable[dict[str, Any]]]) -> None:
    from . import app

    try:
        # Plugin windows share this socket. Keys are managed from Settings only.
        if not app.is_main_window(session):
            raise ApiKeyError("main-window-only", "API keys can only be managed in Settings.")
        result = await work()
    except ApiKeyError as err:
        result = {"ok": False, "error": err.message, "error_code": err.code}
    except Exception as err:  # noqa: BLE001 - answer instead of dropping; the payload may hold a key
        log.warning("%s failed (%s)", msg_type, type(err).__name__)
        result = {"ok": False, "error": "Something went wrong.", "error_code": "internal-error"}
    await session.send_json(make_response(msg_id, msg_type, result))


async def ws_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        return _supported_payload(await asyncio.to_thread(store().list))

    await _answer(session, msg_id, msg_type, work)


async def ws_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        row = await asyncio.to_thread(
            store().create, payload.get("agentKey"), payload.get("name"), payload.get("secret"),
            payload.get("monthlyReminderUsd"),
        )
        await _broadcast()
        return {"ok": True, "key": row}

    await _answer(session, msg_id, msg_type, work)


async def ws_update(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        fields = {name: payload[name] for name in ("name", "monthlyReminderUsd") if name in payload}
        row = await asyncio.to_thread(store().update, payload.get("id"), fields)
        await _broadcast()
        return {"ok": True, "key": row}

    await _answer(session, msg_id, msg_type, work)


async def ws_replace_secret(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        row = await asyncio.to_thread(store().replace_secret, payload.get("id"), payload.get("secret"))
        await _broadcast()
        return {"ok": True, "key": row}

    await _answer(session, msg_id, msg_type, work)


async def ws_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        await asyncio.to_thread(store().delete, payload.get("id"))
        await _broadcast()
        return {"ok": True}

    await _answer(session, msg_id, msg_type, work)


async def ws_test(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Try a pasted key (``agentKey`` + ``secret``) or a stored one (``id``)."""

    async def work() -> dict[str, Any]:
        key_id = payload.get("id")
        if key_id is not None:
            rows = await asyncio.to_thread(store().list)
            agent = next((row["agentKey"] for row in rows if row.get("id") == key_id), None)
            if agent is None:
                raise ApiKeyError("not-found", "This API key no longer exists.")
            secret = await asyncio.to_thread(store().read_secret, key_id)
        else:
            agent = _validate_agent(payload.get("agentKey"))
            secret = validate_secret(agent, payload.get("secret"))
        return {"ok": True, "result": await probe(agent, secret)}

    await _answer(session, msg_id, msg_type, work)


MESSAGE_HANDLERS: dict[str, Callable[..., Any]] = {
    "api_keys.list": ws_list,
    "api_keys.create": ws_create,
    "api_keys.update": ws_update,
    "api_keys.replace_secret": ws_replace_secret,
    "api_keys.delete": ws_delete,
    "api_keys.test": ws_test,
}
