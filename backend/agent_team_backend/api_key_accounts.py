"""API key accounts: a CLI account that pays by usage instead of a login.

An API key is one more kind of account in ``cli_profiles``. A profile carrying
``authKind: "api-key"`` is that kind; a profile without the field is a login
account and none of this code touches it.

A Claude key goes to the OS secret store through ``cloud_secrets.write``, under
a backend-owned name: the Keychain on macOS, an owner-only file on Linux. A
Codex key lives in the account's slot, as the ``auth.json`` ``codex login
--with-api-key`` writes. The profile holds only the key's last four characters,
the spend reminder and the automatic-switch opt-in. Secrets are not a sync
scope, so a key never reaches Navide Cloud, a shared bundle or a settings
export, and no message here returns one.

A claude API key account has no login in its slot, and restoring an empty slot
clears the live login. ``CredentialVault.mark_api_key_slot`` records the slot so
the vault refuses to swap it.

A codex API key account is the opposite: its slot holds the ``auth.json`` that
``codex login --with-api-key`` writes, so the existing switch swaps it like any
login and the pane restarts onto it. Live and slot are the same file content
then, and the next switch captures live back over the slot, so the slot of the
active account is not written or removed here.
"""

from __future__ import annotations

import asyncio
import getpass
import json
import logging
import os
import shlex
import tomllib
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Mapping

import httpx

from . import cloud_secrets, osplat
from .credential_vault import LiveCredentials, vault_to_thread
from .http_ssl import default_ssl_context
from .ipc import make_event, make_response

if TYPE_CHECKING:
    from .app import Session

log = logging.getLogger("agent_team_backend.api_keys")

AUTH_KIND = "api-key"
HELPER_FILE = "navide-api-key-helper"
TAKEOVER_EVENT = "quota_failover.api_key_takeover"
CLAUDE_LOGIN_POLICY_KEYS = ("forceLoginOrgUUID", "forceLoginMethod")
MANAGED_CLAUDE_SETTINGS = (
    Path("/Library/Application Support/ClaudeCode/managed-settings.json"),
    Path("/etc/claude-code/managed-settings.json"),
)
#: The CLIs that take an API key account. Each needs its own way into a pane, so
#: the list grows one vendor at a time.
SUPPORTED_AGENT_KEYS = ("claude", "codex")
#: The CLIs whose key lives in the account's slot, swapped by the existing
#: switch. The others keep it in the OS secret store.
_SLOT_KEY_AGENTS = ("codex",)
NAME_MAX_CHARS = 60
SECRET_MAX_CHARS = 512
MONTHLY_REMINDER_MAX_USD = 1_000_000
PROBE_TIMEOUT_S = 10.0

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


SECRET_NAME_PREFIX = "cli-api-key-"


def is_api_key(profile: Mapping[str, Any] | None) -> bool:
    """The one test every new branch starts with. A login profile has no
    ``authKind``."""
    return bool(profile) and profile.get("authKind") == AUTH_KIND


def is_active_api_key_account(agent_key: str, store: Any) -> bool:
    """Is the live credential of this slot-keyed CLI an API key account's? The
    usage poll stops here: its endpoint is the subscription's, and the key must
    not be sent there."""
    if agent_key not in _SLOT_KEY_AGENTS or store is None:
        return False
    doc = store.list()
    active = doc["defaults"].get(agent_key)
    keys = [p for p in doc["profiles"] if p.get("agentKey") == agent_key and is_api_key(p)]
    if not keys:
        return False
    return any(p.get("id") == active for p in keys) or _live_key_is_ours(agent_key, keys)


def _live_key_is_ours(agent_key: str, keys: list[dict[str, Any]]) -> bool:
    """A switch that stopped midway leaves one of our keys live while the
    default still names a login. A key the user set up outside Navide is not
    ours, and stays as it always was."""
    try:
        data = json.loads(_vault().read_live(agent_key).secret or "")
        live = data.get("OPENAI_API_KEY") if data.get("auth_mode") == "apikey" else None
    except Exception:  # noqa: BLE001 - a failed read leaves the poll as it was
        return False
    return isinstance(live, str) and any(live[-4:] == p.get("last4") for p in keys)


def held_from_auto_switch(slot_id: str) -> bool:
    """An API key account spends money, so failover leaves it alone until the
    user turns on ``autoSwitch`` for it."""
    profile = _store().get(slot_id)
    return is_api_key(profile) and not profile.get("autoSwitch")


def _vault() -> Any:
    from . import app

    return app.credential_vault


def _store() -> Any:
    from . import app

    return app.cli_profiles_store


def _store_secret(profile_id: str, secret: str | None) -> None:
    try:
        cloud_secrets.write(_vault(), SECRET_NAME_PREFIX + profile_id, secret)
    except Exception as err:  # noqa: BLE001 - the message may quote the service, never the key
        log.warning("api key secret write failed (%s)", type(err).__name__)
        raise ApiKeyError("store-failed", "Could not save to this computer's keychain.") from None


def _sets_forced_login(path: Path) -> bool:
    """Does this Codex config set ``forced_login_method``? A file that exists
    and cannot be read may set it, so it counts as setting it."""
    try:
        return "forced_login_method" in tomllib.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        return True


def _codex_system_config() -> Path:
    """``ProgramData`` is set on Windows and nowhere else."""
    program_data = os.environ.get("ProgramData")
    if program_data:
        return Path(program_data, "OpenAI", "Codex", "config.toml")
    return Path("/etc/codex/config.toml")


def login_policy_blocks(agent_key: str) -> bool:
    """Whoever set the CLI's login policy decides how it signs in, so no API key
    account is added under one. Read once and never worked around."""
    return _claude_login_policy() if agent_key == "claude" else _codex_login_policy()


def _codex_login_policy() -> bool:
    user_config = _vault()._live_file("codex").with_name("config.toml")
    return _sets_forced_login(user_config) or _sets_forced_login(_codex_system_config())


def _auth_json(secret: str) -> str:
    """What ``codex login --with-api-key`` writes. Codex serializes its AuthMode
    in lowercase and leaves out the empty ``tokens`` and ``last_refresh``."""
    return json.dumps({"auth_mode": "apikey", "OPENAI_API_KEY": secret})


def _write_key(agent_key: str, profile_id: str, secret: str | None) -> None:
    if agent_key not in _SLOT_KEY_AGENTS:
        _store_secret(profile_id, secret)
        return
    try:
        _vault().write_slot(
            agent_key, profile_id, LiveCredentials(secret=None if secret is None else _auth_json(secret)),
        )
    except Exception as err:  # noqa: BLE001 - the message may quote the path, never the key
        log.warning("api key slot write failed (%s)", type(err).__name__)
        raise ApiKeyError("store-failed", "Could not save the API key on this computer.") from None


def _read_slot_key(profile: Mapping[str, Any]) -> str:
    try:
        stored = _vault().read_slot(str(profile["agentKey"]), str(profile["id"])).secret
        data = json.loads(stored) if stored is not None else None
    except Exception as err:  # noqa: BLE001
        log.warning("api key slot read failed (%s)", type(err).__name__)
        raise ApiKeyError("store-failed", "Could not read the API key on this computer.") from None
    secret = data.get("OPENAI_API_KEY") if isinstance(data, dict) else None
    if not isinstance(secret, str) or not secret:
        raise ApiKeyError("secret-missing", "This account no longer holds its API key. Paste it again.")
    return secret


def _refuse_if_live(profile: Mapping[str, Any]) -> None:
    agent_key = profile["agentKey"]
    if agent_key in _SLOT_KEY_AGENTS and _store().list()["defaults"].get(agent_key) == profile["id"]:
        raise ApiKeyError("account-active", "This account is in use. Switch to another account first.")


def read_secret(profile: Mapping[str, Any]) -> str:
    """Backend use only. No message handler may return this value."""
    if profile.get("agentKey") in _SLOT_KEY_AGENTS:
        return _read_slot_key(profile)
    try:
        secret = _vault().read_app_secret(SECRET_NAME_PREFIX + str(profile["id"]))
    except Exception as err:  # noqa: BLE001
        log.warning("api key secret read failed (%s)", type(err).__name__)
        raise ApiKeyError("store-failed", "Could not read from this computer's keychain.") from None
    if secret is None:
        raise ApiKeyError("secret-missing", "This API key is no longer in the keychain. Paste it again.")
    return secret


def _require(profile_id: Any) -> dict[str, Any]:
    profile = _store().get(str(profile_id or ""))
    if not is_api_key(profile):
        raise ApiKeyError("not-found", "This API key account no longer exists.")
    return profile


def _claude_login_policy() -> bool:
    for path in (_vault()._real_home / ".claude" / "settings.json", *MANAGED_CLAUDE_SETTINGS):
        try:
            settings = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(settings, dict) and any(key in settings for key in CLAUDE_LOGIN_POLICY_KEYS):
            return True
    return False


def pane_default_slot(agent_key: str) -> str:
    """The pane default when it is an API key account, else "". Reads the same
    choice ``cli_profiles.set_pane_default`` stores."""
    from . import app

    getter = getattr(app.cli_profiles_store, "get_pane_default", None)
    chosen = getter(agent_key) if callable(getter) else None
    return str(chosen) if chosen and is_api_key(app.cli_profiles_store.get(chosen)) else ""


def wake_verdict(agent_key: str, recorded_pin: str) -> str:
    """What an API key means for a chat's wake of a pane recorded on
    ``recorded_pin``: "key" when it can only come back on that key, "unclear"
    when it might come back on a key it was not on, or off the one it was on,
    and "" when no key is involved.

    The key a new spawn lands on is claude's pane default or codex's live
    account. Whether a restored claude pane keeps its pin or follows that
    default is the window's to say (``accountFollow``), and a pane reopened
    without a placeholder always follows it. So only a pin equal to that key
    gives the same answer both ways."""
    if agent_key not in SUPPORTED_AGENT_KEYS:
        return ""
    target = pane_default_slot(agent_key)
    if agent_key in _SLOT_KEY_AGENTS:
        active = _store().list()["defaults"].get(agent_key)
        target = active if active and is_api_key(_store().get(active)) else ""
        if not target and is_active_api_key_account(agent_key, _store()):
            return "unclear"  # A switch that stopped midway left a key live.
    if not target and not is_api_key(_store().get(recorded_pin)):
        return ""
    return "key" if recorded_pin == target else "unclear"


def logins_first(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The same ranking with API key accounts last: an account that costs
    nothing more is always tried before one that charges by use."""
    return sorted(candidates, key=lambda row: is_api_key(_store().get(str(row["slotId"]))))


def _record_move(service: Any, incident: Any, profile_id: str) -> None:
    from .quota_failover import Transaction

    now = service._now()
    move = Transaction(
        incident=incident, agent_key=incident.agent_key, auth_scope=incident.auth_scope,
        from_slot_id=incident.outgoing_slot_id, to_slot_id=profile_id, automatic=True,
        idempotency_key=f"auto:{incident.id}:{profile_id}", switch_mode="restart",
        restart_strategy="resume", epoch=incident.epoch, now=now,
    )
    move.state, move.swapped, move.committed_at = "committed", True, now
    service.store.record(move, now=now)


async def _folder_login_with_quota(service: Any, incident: Any) -> dict[str, Any] | None:
    """The subscription account with the most confirmed quota that signed in
    only inside its own config dir. Its slot is empty, so failover reads it as
    signed out and no swap can reach it, but a pane pinned to it runs on it.
    Only a current reading counts: a guess here would stop a pane that a key
    could have kept running."""
    try:
        rows = await service.candidates("claude")
    except Exception as err:  # noqa: BLE001 - the key stays the answer, as it was
        log.warning("api key takeover: candidates unavailable (%s)", type(err).__name__)
        return None
    rows = [
        row for row in rows
        if row["excluded"] == "signed-out" and row["tier"] == "fresh-headroom"
        and row["slotId"] != incident.outgoing_slot_id
    ]

    def usable() -> list[dict[str, Any]]:
        vetoed = service._ledger_vetoes("claude", [str(row["slotId"]) for row in rows])
        found = []
        for row in rows:
            profile = _store().get(row["slotId"])
            if profile is None or is_api_key(profile) or row["slotId"] in vetoed:
                continue
            if _vault().account_dir_signed_in(row["slotId"]):
                found.append(row)
        return found

    best = max(await vault_to_thread(usable), key=lambda row: row["headroom"] or 0.0, default=None)
    return _store().get(best["slotId"]) if best else None


async def take_over(service: Any, incident: Any) -> bool:
    """Every login is out: move the panes on claude's live login to an API key
    account the user opened to this. Claude's live login is never swapped for a
    key, so instead of a transaction the new default goes to ``paneDefaults``
    and each window reopens its panes, leaving any that are busy.

    A subscription account with confirmed quota in its own folder is not out,
    so it takes the panes instead of the key, the same way and at no charge.

    Runs only when the live login itself ran out: a pinned account running out
    leaves the live login's quota unspent, and that must cost nothing. Counts
    against the automatic-switch budget like any other swap."""
    from . import app

    if incident.agent_key != "claude" or incident.outgoing_slot_id != service._current_slot("claude"):
        return False
    target = next(
        (p for p in _store().list()["profiles"]
         if p.get("agentKey") == "claude" and is_api_key(p) and p.get("autoSwitch") is True
         and p.get("id") != incident.outgoing_slot_id),
        None,
    )
    if target is None or login_policy_blocks("claude"):
        return False
    if service.audit_degraded:
        service._stop_incident(incident, "api-key-takeover-paused")
        return True
    if service._budget_retry_after("claude", incident.auth_scope) > 0:
        service._stop_incident(incident, "auto_budget_exhausted")
        return True
    folder_login = await _folder_login_with_quota(service, incident)
    outcome = "folder-login-takeover" if folder_login else "api-key-takeover"
    target = folder_login or target
    # The same row an automatic swap writes, so this move counts against the
    # same 5-hour ceiling. Written first: a move that cannot be counted is not
    # made.
    try:
        _record_move(service, incident, target["id"])
    except Exception as err:  # noqa: BLE001
        log.warning("api key takeover not recorded (%s)", type(err).__name__)
        service._stop_incident(incident, f"{outcome}-unrecorded")
        return True
    try:
        panes = [
            row["paneId"] for row in service._affected_terminals(incident.auth_scope)
            if row.get("paneId") and row.get("credentialSource") == "vault"
        ]
        _store().set_pane_default("claude", target["id"])
    except Exception as err:  # noqa: BLE001
        log.warning("api key takeover not applied (%s)", type(err).__name__)
        service._stop_incident(incident, f"{outcome}-failed")
        return True
    service._stop_incident(incident, outcome)
    await app.broadcast_main_windows(make_event(TAKEOVER_EVENT, {
        "agentKey": "claude", "profileId": target["id"], "name": target.get("name"), "paneIds": panes,
        "paid": folder_login is None,
    }))
    from .ws_handlers import _broadcast_profiles_changed

    # The move is done and told; a list that stays stale until the next read
    # must not turn it into a failed quota report.
    try:
        await _broadcast_profiles_changed("api-key")
    except Exception as err:  # noqa: BLE001
        log.warning("api key takeover: accounts refresh failed (%s)", type(err).__name__)
    return True


def _helper_script(vault: Any, profile_id: str) -> str:
    name = SECRET_NAME_PREFIX + profile_id
    if vault._is_macos:
        read = (
            f"/usr/bin/security find-generic-password -a {shlex.quote(getpass.getuser())} "
            f"-s {shlex.quote(vault.app_secret_service(name))} -w"
        )
    else:
        read = f"cat {shlex.quote(str(vault.app_secret_path(name)))}"
    return f"#!/bin/sh\nexec {read}\n"


def write_account_dir_settings(vault: Any, directory: Path, profile_id: str) -> None:
    """Point this account dir at a helper that prints the key on demand, so the
    key never sits in a pane's environment or in a file Claude Code reads.

    ``settings.json`` is the user's own, copied rather than linked, plus
    ``apiKeyHelper``. It is refreshed on every spawn. The helper holds no key:
    it only names where the key is stored."""
    helper = directory / HELPER_FILE
    osplat.secret_files.write_private_plain(helper, _helper_script(vault, profile_id).encode("utf-8"))
    helper.chmod(0o700)
    try:
        user = json.loads((vault._real_home / ".claude" / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        user = {}
    settings = {**(user if isinstance(user, dict) else {}), "apiKeyHelper": shlex.quote(str(helper))}
    target = directory / "settings.json"
    if target.is_symlink():
        target.unlink()
    osplat.secret_files.write_private_plain(target, json.dumps(settings, indent=2).encode("utf-8"))


def create(agent_key: Any, name: Any, secret: Any, monthly_reminder: Any = None) -> dict[str, Any]:
    agent = _validate_agent(agent_key)
    if agent == "claude" and osplat.impl_name == "_windows":
        raise ApiKeyError("unsupported-platform", "API key accounts for Claude Code are not available on Windows yet.")
    clean_name = _validate_name(name)
    reminder = _validate_reminder(monthly_reminder)
    clean_secret = validate_secret(agent, secret)
    if login_policy_blocks(agent):
        raise ApiKeyError("login-policy", "This CLI's login policy does not allow adding an API key account.")
    profile = _store().create_api_key(
        agent_key=agent, name=clean_name, last4=clean_secret[-4:], monthly_reminder_usd=reminder,
    )
    try:
        if agent not in _SLOT_KEY_AGENTS:
            _vault().mark_api_key_slot(agent, profile["id"])
        _write_key(agent, profile["id"], clean_secret)
    except Exception:
        _store().delete(profile["id"])
        raise
    return profile


def update(profile_id: Any, fields: Mapping[str, Any]) -> dict[str, Any]:
    profile = _require(profile_id)
    changes: dict[str, Any] = {}
    if "name" in fields:
        changes["name"] = _validate_name(fields["name"])
    if "monthlyReminderUsd" in fields:
        changes["monthlyReminderUsd"] = _validate_reminder(fields["monthlyReminderUsd"])
    if "autoSwitch" in fields:
        if not isinstance(fields["autoSwitch"], bool):
            raise ApiKeyError("invalid-auto-switch", "Choose on or off.")
        changes["autoSwitch"] = fields["autoSwitch"]
    return _store().update_api_key(profile["id"], changes)


def replace_secret(profile_id: Any, secret: Any) -> dict[str, Any]:
    profile = _require(profile_id)
    _refuse_if_live(profile)
    clean_secret = validate_secret(profile["agentKey"], secret)
    _write_key(profile["agentKey"], profile["id"], clean_secret)
    return _store().update_api_key(profile["id"], {"last4": clean_secret[-4:]})


def delete(profile_id: Any) -> None:
    profile = _require(profile_id)
    _refuse_if_live(profile)
    from .ws_handlers import _running_account_dir_terminals, _running_login_terminals

    if _running_login_terminals(profile["agentKey"], profile["id"]) or _running_account_dir_terminals(profile["id"]):
        raise ApiKeyError("account-in-use", "A pane is using this account. Close it before deleting the account.")
    # The secret goes first: a failure keeps the account, so the key is never
    # left behind with nothing in the app pointing at it.
    _write_key(profile["agentKey"], profile["id"], None)
    (_vault().account_dir_path(profile["id"]) / HELPER_FILE).unlink(missing_ok=True)
    _store().delete(profile["id"])


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


async def _broadcast(reason: str) -> None:
    from .ws_handlers import _broadcast_profiles_changed

    await _broadcast_profiles_changed(reason)


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


async def _under_switch_lock(profile_id: Any, work: Callable[..., Any], *args: Any) -> Any:
    """A switch reads who is active and captures that slot, so a change to a
    slot must not land in between."""
    profile = await asyncio.to_thread(_require, profile_id)
    async with _vault().switch_lock(str(profile["agentKey"])):
        return await vault_to_thread(work, *args)


async def ws_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        profile = await asyncio.to_thread(
            create, payload.get("agentKey"), payload.get("name"), payload.get("secret"),
            payload.get("monthlyReminderUsd"),
        )
        await _broadcast("api-key")
        return {"ok": True, "profile": profile}

    await _answer(session, msg_id, msg_type, work)


async def ws_update(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        fields = {name: payload[name] for name in ("name", "monthlyReminderUsd", "autoSwitch") if name in payload}
        profile = await asyncio.to_thread(update, payload.get("id"), fields)
        await _broadcast("api-key")
        return {"ok": True, "profile": profile}

    await _answer(session, msg_id, msg_type, work)


async def ws_replace_secret(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        profile = await _under_switch_lock(payload.get("id"), replace_secret, payload.get("id"), payload.get("secret"))
        await _broadcast("api-key")
        return {"ok": True, "profile": profile}

    await _answer(session, msg_id, msg_type, work)


async def ws_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        await _under_switch_lock(payload.get("id"), delete, payload.get("id"))
        await _broadcast("api-key")
        return {"ok": True}

    await _answer(session, msg_id, msg_type, work)


async def ws_test(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Try a pasted key (``agentKey`` + ``secret``) or a stored one (``id``)."""

    async def work() -> dict[str, Any]:
        profile_id = payload.get("id")
        if profile_id is not None:
            profile = await asyncio.to_thread(_require, profile_id)
            agent = str(profile["agentKey"])
            secret = await asyncio.to_thread(read_secret, profile)
        else:
            agent = _validate_agent(payload.get("agentKey"))
            secret = validate_secret(agent, payload.get("secret"))
        return {"ok": True, "result": await probe(agent, secret)}

    await _answer(session, msg_id, msg_type, work)


MESSAGE_HANDLERS: dict[str, Callable[..., Any]] = {
    "cli_profiles.api_key_create": ws_create,
    "cli_profiles.api_key_update": ws_update,
    "cli_profiles.api_key_replace": ws_replace_secret,
    "cli_profiles.api_key_delete": ws_delete,
    "cli_profiles.api_key_test": ws_test,
}
