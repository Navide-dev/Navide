"""Quota-exhaustion account failover: the backend authority.

Plan: .agent-team/plans/quota-exhaustion-auto-switch_7b3e91.html (Phase B/E).

The renderer only *reports* what it saw and *asks* for a switch; everything
that decides whether credentials move lives here:

- ``policy`` — persisted ``off`` / ``notify`` / ``auto`` (default ``notify``).
  ``automatic: true`` on a request is a provenance mark, never an authority.
- ``incidents`` — one exhaustion event per ``(agentKey, authScope,
  outgoingSlotId, epoch)``. Every pane and window that reports the same
  exhaustion lands in the same incident, so a multi-window app switches once.
- ``candidates`` — a pure ranking over the per-account usage snapshots.
- ``budget`` — automatic swaps that actually moved credentials, persisted in
  ``navide.db`` so a backend restart does not reset the 3-per-5h / 10-minute
  spacing. Manual switches keep their own, separate 60-second rule in
  ``ws_handlers.cli_profiles_set_default``.
- ``transactions`` — a switch in flight. Hot vendors commit directly under the
  agent's ``switch_lock``; restart vendors go through prepare → ack → commit,
  and a busy pane parks the transaction in ``waiting-safe`` rather than
  cancelling it. A failure of any kind ends the incident's automatic run
  (``notify-stopped``); there is never a second candidate tried by itself.

Everything about *how* a vendor switches — hot or restart, which credential
pool it shares, whether a restarted pane can resume — is read from the
vendor's ``VendorSpec.account_switch`` declaration (owned by the vendor
files). A vendor that declares nothing is unsupported here and only ever gets
a notification; it never inherits another vendor's behaviour.

Runtime seams are reached the way ``ws_handlers`` reaches them (``from .
import app`` at call time), so the same monkeypatching the profile tests use
drives this module with a temporary vault and database.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import logging
import math
import re
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

from .db import Database

log = logging.getLogger(__name__)

_COMPONENT = "quota_failover"
_POLICY_KV_KEY = "quota_failover.policy"

POLICY_MODES = ("off", "notify", "auto")
DEFAULT_POLICY_MODE = "notify"

# Automatic swaps only. Persisted; a no-op or a refused switch never counts.
AUTO_BUDGET_MAX = 3
AUTO_BUDGET_WINDOW_S = 5 * 3600.0
AUTO_MIN_GAP_S = 600.0

# How long a window has to answer a prepare (ready / busy / cannot) before the
# transaction is cancelled for an unresponsive owner.
PREPARE_ACK_DEADLINE_S = 30.0
# Ceiling on waiting for busy panes to reach a safe point. Waiting costs no
# budget and never retries on a timer; when this passes the run stops and the
# user is told why.
WAIT_SAFE_MAX_S = 30 * 60.0
# After a commit: how long the incident waits for evidence that the target
# account actually works before it says "switched, quota unconfirmed".
SETTLE_TIMEOUT_S = 120.0
# A reading older than this is no longer "fresh" headroom.
FRESH_READING_MAX_AGE_S = 30 * 60.0
# Closed incidents (and their transactions) stay in ``state()`` this long, and
# at most this many, so a window that missed the closing broadcast still sees
# the final state/reason and has the slot ids a manual switch-back needs.
RECENT_RETENTION_S = 24 * 3600.0
RECENT_MAX = 20
# A reading stamped further into the future than this cannot be trusted as
# fresh (clock skew between the provider and this machine is tolerated).
FUTURE_STAMP_TOLERANCE_S = 5 * 60.0

# The only exhaustion signal the backend acts on. Rate limits, network errors,
# login expiry, a full context window or a payment problem are different
# things and are refused rather than folded in — but named back, so the
# renderer can show the right notice and nothing retries by itself.
TRUSTED_SIGNAL = "quota-exhausted"
NON_QUOTA_SIGNALS = ("rate-limited", "auth-expired", "payment", "network", "context-full")
# usage-window: the backend's own per-account snapshot shows the slot at 100 %.
# cli-text: the quoted text matches the vendor's declared exhaustion patterns.
# structured: the pane's OWN recorded turn end (app._pane_activity, written
# by the vendor's log reader) carries a stop reason matching those patterns —
# the renderer only points at the pane; it cannot supply the reason.
REPORT_SOURCES = ("cli-text", "usage-window", "structured")
# A structured report must name a turn end the backend recorded within this
# long of the report's own timestamp.
STRUCTURED_MATCH_WINDOW_S = 10 * 60.0

# Mirrors each renderer vendor's quotaSemantics; a contract test pins parity.
# Undeclared vendors may veto a known spent window, but cannot prove headroom.
QUOTA_SEMANTICS = {
    "claude": {"hard": ("session", "weekly"), "required": ("session", "weekly"), "scoped": ("weekly-model",)},
    "codex": {"hard": ("session", "weekly"), "required": ("session",)},
    "grok": {"hard": ("monthly",), "required": ("monthly",)},
    "copilot": {"hard": ("monthly",), "required": ("monthly",)},
    "pi": {"hard": ("credits",), "required": ("credits",)},
    "cursor": {"hard": ("cycle",), "required": ("cycle",), "alternate": ("on-demand",)},
    "kilo": {"hard": ("credits", "period"), "required": ()},
    "qwen": {"hard": ("session", "weekly", "monthly"), "required": ("session",)},
    "kimi": {"hard": ("weekly", "session"), "required": ("weekly",)},
}
EXHAUSTED_USED_PCT = 100.0

INCIDENT_STATES = (
    "detected", "waiting-safe", "switching", "settling", "ready", "notify-stopped",
)
TRANSACTION_STATES = (
    "awaiting-confirmation", "preparing", "waiting-safe", "swapping", "committed",
    "cancelled", "failed", "partial",
)
OPEN_TRANSACTION_STATES = frozenset({"awaiting-confirmation", "preparing", "waiting-safe"})

DEFAULT_SLOT_ID = "__default__"


class FailoverRefused(Exception):
    """A request the authority declines. ``code`` is the WS error code."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def _now_iso(ts: float | None = None) -> str:
    return datetime.fromtimestamp(
        time.time() if ts is None else ts, tz=timezone.utc
    ).isoformat().replace("+00:00", "Z")


def _parse_iso(raw: object) -> float | None:
    text = str(raw or "").strip()
    if not text:
        return None
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


# ── Vendor capability ─────────────────────────────────────────────────────────

def capability(agent_key: str) -> dict[str, Any]:
    """What the vendor declares about switching accounts, JSON-safe.

    Reads ``VendorSpec.account_switch`` (an ``AccountSwitchSpec``: auth_scope,
    method, evidence, resume, scopes, todo …) through the registry's
    ``account_capability`` when the registry exports one, else straight off the
    spec. A vendor without the declaration is reported as unsupported — the
    legacy ``HOT_SWAP_AGENTS`` set is honoured only for the claude hot path
    that already ships, so no vendor silently gains a behaviour it never
    declared."""
    from .cli_vendors import registry

    spec = registry.vendor(agent_key)
    out: dict[str, Any] = {
        "agentKey": agent_key,
        "supported": False,
        "switchMode": "unsupported",
        "authScope": agent_key,
        "evidence": None,
        "resume": "native" if (spec is not None and spec.supports_session_resume) else "none",
        "scopes": [],
        "platforms": [],
        "verifiedVersion": "",
        # Whether the vendor can say WHICH account a credential belongs to.
        # Without it a switch cannot be verified to have landed on a different
        # account, so automatic switching is not offered and no reading is
        # ever presented as "quota confirmed" for it.
        "hasIdentity": bool(spec is not None and (spec.identity_from_secret is not None or agent_key == "claude")),
        "hasSlots": bool(spec is not None and spec.slot_file),
        "todo": "",
    }
    if spec is None:
        out["todo"] = "unknown vendor"
        return out
    # Whether this vendor's sign-in pane gets its own credential store. The
    # vault owns the rule (claude/grok are special cases); the UI must read
    # this field, never guess from login_home_env.
    out["loginIsolation"] = "isolated" if _login_isolated(agent_key) else "global"
    declared: Any = None
    getter = getattr(registry, "account_capability", None)
    if callable(getter):
        try:
            declared = getter(agent_key)
        except Exception:  # noqa: BLE001 — a broken declaration reads as none
            declared = None
    if isinstance(declared, dict):
        method = str(declared.get("method") or "")
        out.update({
            "supported": bool(declared.get("supported", method in ("hot", "restart", "manual"))),
            "switchMode": method if declared.get("supported", True) and method else "unsupported",
            "authScope": str(declared.get("authScope") or agent_key),
            "evidence": declared.get("evidence"),
            "resume": str(declared.get("resume") or out["resume"]),
            "scopes": list(declared.get("scopes") or ()),
            "platforms": list(declared.get("platforms") or ()),
            "verifiedVersion": str(declared.get("verifiedVersion") or ""),
            "hasIdentity": bool(declared.get("hasIdentity", True)),
            "todo": str(declared.get("todo") or ""),
        })
        return out
    switch = getattr(spec, "account_switch", None)
    if switch is not None:
        method = str(getattr(switch, "method", "") or "")
        out.update({
            "supported": method in ("hot", "restart", "manual"),
            "switchMode": method or "unsupported",
            "authScope": str(getattr(switch, "auth_scope", "") or agent_key),
            "evidence": getattr(switch, "evidence", None),
            "resume": str(getattr(switch, "resume", "") or out["resume"]),
            "scopes": list(getattr(switch, "scopes", ()) or ()),
            "platforms": list(getattr(switch, "platforms", ()) or ()),
            "verifiedVersion": str(getattr(switch, "verified_version", "") or ""),
            "todo": str(getattr(switch, "todo", "") or ""),
        })
        return out
    # No declaration yet. Only the hot path that already ships is known.
    if spec.slot_file and agent_key == "claude":
        out.update({"supported": True, "switchMode": "hot", "evidence": "live"})
    elif spec.slot_file:
        out["todo"] = "account_switch not declared; the live-pane gate remains manual"
    else:
        out["todo"] = "no credential slot layout declared"
    return out


def _login_isolated(agent_key: str, vault: Any = None) -> bool:
    try:
        if vault is None:
            from . import app

            vault = app.credential_vault
        isolated = getattr(vault, "_login_isolated", None)
        if callable(isolated):
            return bool(isolated(agent_key))
    except Exception:  # noqa: BLE001
        pass
    from .cli_vendors import registry

    spec = registry.vendor(agent_key)
    return agent_key in ("claude", "grok") or bool(spec is not None and spec.login_home_env is not None)


def capabilities() -> dict[str, dict[str, Any]]:
    from .cli_vendors.registry import VENDORS

    return {key: capability(key) for key in VENDORS}


def profile_scope(agent_key: str, profile: dict[str, Any] | None) -> str | None:
    """The provider scope of a profile's credentials, as the vault wants it
    (``profiles_store.profile_scope``); None for whole-file vendors."""
    from . import profiles_store

    fn = getattr(profiles_store, "profile_scope", None)
    if callable(fn):
        return fn(profile, agent_key)
    stored = (profile or {}).get("scope")
    return str(stored) if stored else None


def auth_scope_for(agent_key: str, profile: dict[str, Any] | None) -> str:
    """The credential pool a profile of ``agent_key`` lives in — derived here
    from the vendor declaration and the profile record, never taken from a
    client. A compound-file vendor's profile bound to one provider scopes to
    ``<vendorScope>:<provider>`` (``cli_vendors.base.auth_scope_for``)."""
    return auth_scope_for_scope(agent_key, profile_scope(agent_key, profile))


def auth_scope_for_scope(agent_key: str, scope: str | None) -> str:
    from .cli_vendors import base, registry

    spec = registry.vendor(agent_key)
    fn = getattr(base, "auth_scope_for", None)
    if spec is not None and callable(fn):
        resolved = fn(spec, scope)
        if resolved:
            return str(resolved)
    pool = capability(agent_key)["authScope"]
    return f"{pool}:{scope}" if scope else pool


def credential_env_vars(agent_key: str) -> tuple[str, ...]:
    """Environment variables through which this CLI takes a credential that
    outranks the file / Keychain the vault swaps: the vendor's portable
    credential variable and whatever it declares as ranking above it, plus
    any ``account_switch.credential_env_vars`` the adapter names."""
    from .cli_vendors import registry

    spec = registry.vendor(agent_key)
    if spec is None:
        return ()
    names: list[str] = []
    portable = getattr(spec, "portable_credential", None)
    if portable is not None:
        names.append(portable.env)
        names.extend(portable.env_remove)
    switch = getattr(spec, "account_switch", None)
    names.extend(getattr(switch, "credential_env_vars", ()) or ())
    return tuple(dict.fromkeys(n for n in names if n))


def pane_auth_scope(
    agent_key: str, profile: dict[str, Any] | None, *,
    env: dict[str, str] | None = None, env_remove: list[str] | tuple[str, ...] = (),
    portable_slot_id: str | None = None,
    account_dir: bool = False,
) -> dict[str, Any]:
    """Launch provenance recorded on a pane's terminal metadata at spawn:
    which profile it started on, that profile's provider scope, the
    credential pool those resolve to, and where the CLI actually takes its
    credential from — ``vault`` (the file / Keychain a switch swaps),
    ``portable`` (a pasted credential injected into the environment) or
    ``env-override`` (a credential variable the CLI ranks above the file
    reached the pane) or ``account-dir`` (a claude account's own config dir,
    whose login the CLI keeps itself). Only the variable's *name* is
    recorded, never a value.
    A pane not on ``vault`` does not change account when the vault swaps, so
    the transaction must not count it as switched — nor let auto pretend it
    did. The transaction reads only this record — never the default profile of
    the moment, which may have moved on."""
    source = "vault"
    overriding: list[str] = []
    scope = profile_scope(agent_key, profile)
    removed = set(env_remove or ())
    env_names = [name for name in (env or {}) if name not in removed]
    preflight = switch_preflight(agent_key, env_names=env_names, scope=scope)
    if portable_slot_id:
        source = "portable"
    elif account_dir:
        source = "account-dir"
    else:
        for name in credential_env_vars(agent_key):
            if name in env_names:
                overriding.append(name)
        for name in preflight.get("shadowedBy") or ():
            if name not in overriding:
                overriding.append(name)
        if overriding:
            source = "env-override"
    return {
        "profileId": str((profile or {}).get("id") or DEFAULT_SLOT_ID),
        "scope": scope,
        "authScope": auth_scope_for(agent_key, profile),
        "credentialSource": source,
        "credentialEnv": overriding,
        # The vendor's own verdict on whether the vault's swap reaches the
        # credential this pane uses (cli_vendors.base.switch_preflight).
        "preflight": preflight,
    }


def switch_preflight(
    agent_key: str, *, env_names: list[str] | tuple[str, ...] = (), scope: str | None = None,
) -> dict[str, Any]:
    """``cli_vendors.base.switch_preflight`` when the tree has it, else a
    best-effort answer from the capability record. Secret-free: names only."""
    from .cli_vendors import base, registry

    spec = registry.vendor(agent_key)
    fn = getattr(base, "switch_preflight", None)
    if spec is not None and callable(fn):
        try:
            return dict(fn(spec, env_names=env_names, scope=scope))
        except Exception:  # noqa: BLE001 — a broken declaration reads as unsupported
            pass
    cap = capability(agent_key)
    if not cap["supported"]:
        return {"ok": False, "reason": "unsupported", "authScope": None,
                "method": None, "shadowedBy": []}
    return {"ok": True, "reason": None, "authScope": auth_scope_for_scope(agent_key, scope),
            "method": cap["switchMode"], "shadowedBy": []}


def scope_matches(incident_scope: str, transaction_scope: str) -> bool:
    """An incident filed on the vendor-level pool (a default-slot pane of a
    compound-file vendor has no provider of its own) belongs to a transaction
    that resolves the pool to one provider; two provider-bound scopes must be
    the same one."""
    return incident_scope == transaction_scope or transaction_scope.startswith(incident_scope + ":")


def scope_members(auth_scope: str) -> list[str]:
    """Every vendor whose declared pool is ``auth_scope`` (or the vendor part
    of a provider-bound scope). Panes of all of them run on the credentials a
    switch of that pool moves."""
    base = auth_scope.split(":", 1)[0]
    return [key for key, cap in capabilities().items() if cap["authScope"] in (auth_scope, base)]


def quota_text_patterns(agent_key: str) -> list[re.Pattern[str]]:
    """The vendor's declared exhaustion text detectors, compiled. A vendor
    that declares none makes a ``cli-text`` report untrusted: the words
    "quota exhausted" in a payload are not evidence by themselves."""
    from .cli_vendors import registry

    spec = registry.vendor(agent_key)
    raw = getattr(spec, "quota_exhausted_patterns", None) if spec is not None else None
    out: list[re.Pattern[str]] = []
    for item in raw or ():
        try:
            out.append(item if isinstance(item, re.Pattern) else re.compile(str(item), re.I))
        except re.error:
            continue
    return out


# ── Vault helpers shared with the manual route ────────────────────────────────

def login_pending(vault: Any, agent_key: str, slot_id: str) -> bool:
    """``vault.login_pending`` (an isolated login home that still exists, or
    a non-isolated sign-in whose pre-login snapshot is parked); a vault
    without it is read by the login home alone."""
    pending = getattr(vault, "login_pending", None)
    if callable(pending):
        return bool(pending(agent_key, slot_id))
    try:
        return bool(vault.login_home_path(agent_key, slot_id).is_dir())
    except Exception:  # noqa: BLE001
        return False


def scope_of(agent_key: str, profile: dict[str, Any] | None) -> str | None:
    return profile_scope(agent_key, profile)


def scope_kwargs(fn: Any, agent_key: str, profile: dict[str, Any] | None) -> dict[str, Any]:
    """``{"scope": …}`` for a vault call about a per-provider vendor's
    profile — only when the method takes ``scope`` and the profile has one."""
    try:
        if "scope" not in inspect.signature(fn).parameters:
            return {}
    except (TypeError, ValueError):
        return {}
    scope = profile_scope(agent_key, profile)
    return {"scope": scope} if scope else {}


def secrets_equal(a: str | None, b: str | None) -> bool:
    """Two credential payloads for the same account. Compared as data when
    both are JSON (the vault may re-serialise what it merges)."""
    if a is None or b is None:
        return a is b
    try:
        import json

        return json.loads(a) == json.loads(b)
    except (TypeError, ValueError):
        return a == b


def _jwt_claims(token: object) -> dict[str, Any]:
    """The payload of a JWT, unverified — comparison of two claim sets the
    same source produced, never a trust decision."""
    import base64
    import json

    if not isinstance(token, str) or token.count(".") < 2:
        return {}
    payload = token.split(".")[1]
    try:
        decoded = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (ValueError, UnicodeDecodeError):
        return {}
    return decoded if isinstance(decoded, dict) else {}


def account_identity(
    vault: Any, agent_key: str, slot_id: str | None, scope: str | None, *, creds: Any = None,
) -> dict[str, str | None]:
    """``{"id", "email"}`` for the live credential (``slot_id`` None) or a
    slot's, from the vendor's own stored fields — no network:

    * claude: ``oauthAccount.accountUuid`` + ``organizationUuid`` (the account
      record the vault keeps beside the secret) and ``emailAddress``;
    * codex: auth.json ``tokens.account_id`` (a team and a personal login
      share one email but not this), else the id_token's
      ``https://api.openai.com/auth`` ``chatgpt_account_id`` claim; the email
      from the id_token;
    * every other vendor: the vault's display identity (email only).
    Whatever cannot be read is None; the caller then falls back a level."""
    kw = {"scope": scope} if scope else {}
    out: dict[str, str | None] = {"id": None, "email": None}
    try:
        if creds is None:
            creds = vault.read_live(agent_key, **kw) if slot_id is None else vault.read_slot(agent_key, slot_id, **kw)
    except Exception:  # noqa: BLE001
        return out
    try:
        if agent_key == "claude":
            account = creds.account if isinstance(getattr(creds, "account", None), dict) else {}
            uuid_ = str(account.get("accountUuid") or "").strip()
            org = str(account.get("organizationUuid") or "").strip()
            out["id"] = f"{uuid_}|{org}" if uuid_ else None
            email = str(account.get("emailAddress") or "").strip().lower()
            out["email"] = email or None
            return out
        if agent_key == "codex":
            import json

            data = json.loads(creds.secret) if isinstance(creds.secret, str) else None
            tokens = (data or {}).get("tokens") if isinstance(data, dict) else None
            tokens = tokens if isinstance(tokens, dict) else {}
            # auth.json ``tokens.account_id`` (the ChatGPT-Account-Id the CLI
            # sends — see cli_vendors/codex.py read_codex_credentials) first;
            # the id_token's ``chatgpt_account_id`` claim as the fallback.
            acct = str(tokens.get("account_id") or tokens.get("accountId") or "").strip()
            if not acct:
                claims = _jwt_claims(tokens.get("id_token"))
                auth = claims.get("https://api.openai.com/auth")
                acct = str((auth or {}).get("chatgpt_account_id") or "").strip() if isinstance(auth, dict) else ""
            else:
                claims = _jwt_claims(tokens.get("id_token"))
            out["id"] = acct or None
            email = str(claims.get("email") or "").strip().lower()
            out["email"] = email or None
            return out
        identity = vault.identity(agent_key, slot_id, **kw) if slot_id is not None else vault.identity(agent_key, **kw)
        email = str((identity or {}).get("email") or "").strip().lower()
        out["email"] = email or None
    except Exception:  # noqa: BLE001
        pass
    return out


# Per-process key for live-credential fingerprints: a fingerprint identifies
# "the payload the user was shown" across a refusal and its confirming
# resend, and nothing else — it cannot be matched offline against a token.
_FINGERPRINT_KEY = uuid.uuid4().bytes


def live_fingerprint(vault: Any, agent_key: str, scope: str | None) -> str | None:
    """Opaque handle for the live credential payload as it is right now.
    Returned in a LIVE_DRIFT refusal and required back on a confirming resend,
    so the user's "it is still my account" applies to exactly the payload they
    were asked about — not to whatever is live by the time they answer."""
    import hashlib
    import hmac

    try:
        live = vault.read_live(agent_key, **({"scope": scope} if scope else {}))
    except Exception:  # noqa: BLE001
        return None
    if live.secret is None:
        return None
    return hmac.new(_FINGERPRINT_KEY, live.secret.encode("utf-8"), hashlib.sha256).hexdigest()[:24]


def live_drift(vault: Any, agent_key: str, current_slot_id: str, scope: str | None) -> str:
    """Is a DIFFERENT ACCOUNT live than the active slot's own? ``"none"``
    (same account, or nothing to compare), ``"drifted"`` (a sign-in against
    the live store put another account's credential there),
    ``"unverifiable"`` (the payload changed but no identity says whose it
    is), ``"unknown"`` (could not read).

    Compared by identity first — a stable account id when the vendor stores
    one, else the email: the CLI rotates its own tokens on refresh, so a
    changed secret under the same identity is the same account, never a
    drift.
    Only when neither side carries an identity does the raw payload decide —
    and then only for a vendor whose sign-in writes the live store; an
    isolated vendor's live store is written by the CLI and the vault alone,
    so a changed payload there can only be a refresh. Blocking — thread it."""
    kw = {"scope": scope} if scope else {}
    try:
        slot = vault.read_slot(agent_key, current_slot_id, **kw)
        if slot.secret is None:
            return "none"
        live = vault.read_live(agent_key, **kw)
    except Exception:  # noqa: BLE001
        return "unknown"
    if live.secret is None:
        return "none"
    if secrets_equal(live.secret, slot.secret):
        return "none"
    live_id = account_identity(vault, agent_key, None, scope, creds=live)
    slot_id = account_identity(vault, agent_key, current_slot_id, scope, creds=slot)
    # A stable account id beats the display email: the same email can name a
    # personal and a team identity (Claude organizationUuid, Codex
    # chatgpt_account_id), and those are different accounts.
    if live_id["id"] and slot_id["id"]:
        return "drifted" if live_id["id"] != slot_id["id"] else "none"
    if live_id["email"] and slot_id["email"]:
        return "drifted" if live_id["email"] != slot_id["email"] else "none"
    # No identity on one side: a rotated token and a foreign credential look
    # the same. Neither is assumed — the caller refuses until the user says
    # which it is (``assume_live_is_current``), never overwriting a slot with
    # a credential of unknown origin.
    return "unverifiable"


# ── Candidate ranking (pure) ──────────────────────────────────────────────────

def _binding_windows(snapshot: dict[str, Any] | None) -> list[dict[str, Any]]:
    windows = [w for w in (snapshot or {}).get("windows", []) if isinstance(w, dict)]
    semantics = QUOTA_SEMANTICS.get(str((snapshot or {}).get("provider") or ""))
    if semantics is not None:
        return [w for w in windows if w.get("kind") in semantics["hard"]]
    return [w for w in windows if not str(w.get("kind") or "").endswith("-model")]


def _window_reset_passed(window: dict[str, Any], now: float) -> bool:
    resets = _parse_iso(window.get("resetsAt"))
    return resets is not None and resets <= now


def _finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _window_remaining(window: dict[str, Any]) -> float | None:
    balance = window.get("balance")
    if balance is not None:
        return (100.0 if balance > 0 else 0.0) if _finite_number(balance) else None
    if window.get("kind") == "credits":
        limit, usage = window.get("limit"), window.get("usage")
        if not _finite_number(limit) or limit <= 0:
            return None
        if usage is not None:
            if not _finite_number(usage) or usage < 0:
                return None
            return max(0.0, min(100.0, 100.0 * (1.0 - usage / limit)))
    used = window.get("usedPercent")
    if not _finite_number(used) or used < 0:
        return None
    return max(0.0, min(100.0, 100.0 - used))


def _window_exhausted(window: dict[str, Any], now: float) -> bool:
    return (_window_remaining(window) == 0 and not window.get("expired")
            and not _window_reset_passed(window, now))


def _quota_verdict(snapshot: dict[str, Any] | None, now: float) -> tuple[bool, bool, float | None]:
    """One vendor verdict shared by signal validation, ranking and recovery."""
    semantics = QUOTA_SEMANTICS.get(str((snapshot or {}).get("provider") or ""))
    windows = _binding_windows(snapshot)
    current = [w for w in windows if not w.get("expired") and not _window_reset_passed(w, now)]
    spent = any(_window_exhausted(w, now) for w in windows)
    if semantics and any(
        isinstance(w, dict) and w.get("kind") in semantics.get("alternate", ())
        and not w.get("expired") and not _window_reset_passed(w, now)
        and (_window_remaining(w) or 0) > 0
        for w in (snapshot or {}).get("windows", [])
    ):
        spent = False
    remaining = [_window_remaining(w) for w in current]
    measured = [value for value in remaining if value is not None]
    positive = bool(semantics is not None and current and not spent and None not in remaining
                    and set(semantics["required"]) <= {w.get("kind") for w in current})
    return spent, positive, min(measured) if measured else None


def snapshot_exhausted(snapshot: dict[str, Any] | None, now: float | None = None) -> bool:
    """A binding window at 100 % whose reset has not passed."""
    now = time.time() if now is None else now
    return _quota_verdict(snapshot, now)[0]


def classify_candidate(
    snapshot: dict[str, Any] | None, *, now: float
) -> tuple[str, float | None, float | None]:
    """``(tier, headroom, fetchedAt)`` for one account's snapshot.

    fresh-headroom: a current, non-stale ok reading with every binding window
    below 100 %. reset-expected: a reading that was exhausted, but every
    exhausted window's reset has passed and no other window vetoes — a
    *possible* recovery, never a full one. stale-headroom: a stale reading with
    headroom. unknown: nothing usable. ``None`` (vetoed) is signalled with tier
    "exhausted"."""
    if not snapshot or snapshot.get("status") not in ("ok", "not-refreshed", "not-measured", "error", "rate-limited", "unavailable"):
        return "unknown", None, None
    windows = _binding_windows(snapshot)
    fetched_at = _parse_iso(snapshot.get("lastSuccessAt") or snapshot.get("fetchedAt"))
    if not windows or fetched_at is None or not math.isfinite(fetched_at):
        return "unknown", None, None
    if fetched_at > now + FUTURE_STAMP_TOLERANCE_S:
        # A reading stamped in the future is a clock problem, not freshness.
        return "unknown", None, fetched_at
    exhausted, positive, headroom = _quota_verdict(snapshot, now)
    if exhausted:
        return "exhausted", 0.0, fetched_at
    was_exhausted = any(
        _window_remaining(w) == 0
        and _window_reset_passed(w, now)
        for w in windows
    )
    if was_exhausted:
        return "reset-expected", headroom, fetched_at
    if not positive:
        return "unknown", headroom, fetched_at
    stale = bool(snapshot.get("stale") or snapshot.get("staleExpired") or snapshot.get("refreshPending")) or snapshot.get("status") != "ok" \
        or (now - fetched_at) > FRESH_READING_MAX_AGE_S
    return ("stale-headroom" if stale else "fresh-headroom"), headroom, fetched_at


_TIER_ORDER = {"fresh-headroom": 0, "reset-expected": 1, "stale-headroom": 2, "unknown": 3}


def rank_candidates(
    *,
    slot_ids: list[str],
    current_slot_id: str,
    snapshots: dict[str, dict[str, Any] | None],
    login_states: dict[str, str | None],
    tried: set[str],
    now: float,
    ledger_vetoes: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Order the accounts a switch may target. Excluded rows stay in the
    result with ``excluded`` set so the UI can say *why* nobody is eligible
    ("can sign in" / "can re-read" / "no data") instead of "all exhausted".

    ``login_states`` values: None or "ok" = usable, "signed-out", "expired",
    "login-pending". A login problem and a missing quota reading are different
    unknowns: only an account whose credential is confirmed usable may be the
    run's single "unknown quota" attempt. ``ledger_vetoes`` are slots whose
    quota ledger still holds an exhausted, un-reset cycle — newer than any
    snapshot and never overridden by one whose reset has passed. Percentages
    are never compared across vendors — the caller passes one vendor's
    slots."""
    rows: list[dict[str, Any]] = []
    for slot_id in slot_ids:
        snap = snapshots.get(slot_id)
        login = login_states.get(slot_id) or "ok"
        tier, headroom, fetched_at = classify_candidate(snap, now=now)
        excluded: str | None = None
        if slot_id == current_slot_id:
            excluded = "current"
        elif slot_id in tried:
            excluded = "tried"
        elif login != "ok":
            excluded = login
        elif tier == "exhausted" or slot_id in (ledger_vetoes or ()):
            excluded = "exhausted"
        rows.append({
            "slotId": slot_id,
            "tier": "unknown" if tier == "exhausted" else tier,
            "loginState": login,
            "excluded": excluded,
            "headroom": headroom,
            "fetchedAt": _now_iso(fetched_at) if fetched_at is not None else None,
        })
    eligible = [r for r in rows if r["excluded"] is None]
    eligible.sort(key=lambda r: (
        _TIER_ORDER.get(r["tier"], 9),
        -(r["headroom"] if r["headroom"] is not None else -1.0),
        -(_parse_iso(r["fetchedAt"]) or 0.0),
        r["slotId"],
    ))
    excluded_rows = [r for r in rows if r["excluded"] is not None]
    return eligible + excluded_rows


# ── Persistence ───────────────────────────────────────────────────────────────

def _create_schema(cur: sqlite3.Cursor) -> None:
    # The audit and the budget are one table: a row with swapped=1 and
    # automatic=1 is what the budget counts. No token or secret is ever
    # written here — slot ids, reasons and outcomes only.
    cur.execute(
        "CREATE TABLE quota_failover_switches ("
        " id TEXT PRIMARY KEY,"
        " agent_key TEXT NOT NULL,"
        " auth_scope TEXT NOT NULL,"
        " incident_id TEXT NOT NULL,"
        " from_slot TEXT NOT NULL,"
        " to_slot TEXT NOT NULL,"
        " automatic INTEGER NOT NULL,"
        " swapped INTEGER NOT NULL,"
        " state TEXT NOT NULL,"
        " at REAL NOT NULL,"
        " detail TEXT NOT NULL)"
    )
    cur.execute(
        "CREATE INDEX quota_failover_switches_budget"
        " ON quota_failover_switches (agent_key, auth_scope, automatic, swapped, at)"
    )


class QuotaFailoverStore:
    """Policy (kv) plus the swap audit / budget table in the global database."""

    def __init__(self, db: Database) -> None:
        self._db = db
        self._db.migrate(_COMPONENT, 1, _create_schema)

    def policy(self) -> dict[str, Any]:
        doc = self._db.kv_get(_POLICY_KV_KEY)
        mode = doc.get("mode") if isinstance(doc, dict) else None
        if mode not in POLICY_MODES:
            return {"mode": DEFAULT_POLICY_MODE, "updatedAt": None}
        return {"mode": mode, "updatedAt": doc.get("updatedAt")}

    def set_policy(self, mode: str, *, now: float) -> dict[str, Any]:
        if mode not in POLICY_MODES:
            raise ValueError(f"unknown policy mode: {mode!r}")
        doc = {"mode": mode, "updatedAt": _now_iso(now)}
        self._db.kv_set(_POLICY_KV_KEY, doc, now=int(now))
        return doc

    def record(self, tx: "Transaction", *, now: float) -> None:
        """Write the transaction's current shape. Called once BEFORE the swap
        with ``state="swapping"`` (durable intent) and again after: a crash or
        a failed second write leaves the intent row, which the budget counts
        as a swap that may have happened — never as one that did not."""
        import json

        with self._db.transaction() as cur:
            cur.execute(
                "INSERT OR REPLACE INTO quota_failover_switches"
                " (id, agent_key, auth_scope, incident_id, from_slot, to_slot,"
                "  automatic, swapped, state, at, detail)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    tx.id, tx.agent_key, tx.auth_scope, tx.incident_id,
                    tx.from_slot_id, tx.to_slot_id, int(tx.automatic), int(tx.swapped),
                    tx.state, tx.committed_at if tx.committed_at is not None else now,
                    json.dumps({"reason": tx.reason, "error": tx.error,
                                "panes": tx.panes, "liveIdentity": tx.live_identity}),
                ),
            )

    # A row counts against the budget when the credentials moved (swapped=1)
    # OR when the intent was written and nothing came after ("swapping"): the
    # process may have died mid-swap, and a budget that assumed it did not
    # would let a restart loop around the ceiling.
    _COUNTED = "(swapped = 1 OR state = 'swapping')"

    def automatic_swaps(self, agent_key: str, auth_scope: str, *, since: float) -> list[float]:
        with self._db.transaction() as cur:
            rows = cur.execute(
                "SELECT at FROM quota_failover_switches"
                " WHERE agent_key = ? AND auth_scope = ? AND automatic = 1"
                f" AND {self._COUNTED} AND at > ? ORDER BY at",
                (agent_key, auth_scope, since),
            ).fetchall()
        return [float(r["at"]) for r in rows]

    def last_automatic_swap(self, agent_key: str, auth_scope: str) -> float | None:
        with self._db.transaction() as cur:
            row = cur.execute(
                "SELECT MAX(at) AS at FROM quota_failover_switches"
                f" WHERE agent_key = ? AND auth_scope = ? AND automatic = 1 AND {self._COUNTED}",
                (agent_key, auth_scope),
            ).fetchone()
        return float(row["at"]) if row is not None and row["at"] is not None else None

    def unreconciled_rows(self) -> list[dict[str, Any]]:
        """Swaps whose bookkeeping never caught up with the live state: the
        default was not persisted after the credentials moved
        (``default-persist-failed``), or the intent row was written and nothing
        followed (a crash mid-swap). Each names the transaction, the slots it
        moved between and — when known — the slot that is live now."""
        import json

        with self._db.transaction() as cur:
            rows = cur.execute(
                "SELECT id, agent_key, auth_scope, from_slot, to_slot, state, detail"
                " FROM quota_failover_switches"
                " WHERE state IN ('partial', 'swapping') ORDER BY at"
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            detail = json.loads(r["detail"])
            if detail.get("reconciledAt"):
                continue
            if r["state"] == "partial" and detail.get("reason") != "default-persist-failed":
                continue
            out.append({
                "transactionId": r["id"], "agentKey": r["agent_key"], "authScope": r["auth_scope"],
                "fromSlotId": r["from_slot"], "toSlotId": r["to_slot"],
                # After a persist failure the live account IS the target; after
                # a crash mid-swap nobody can say without looking.
                "liveSlotId": r["to_slot"] if r["state"] == "partial" else None,
                "reason": detail.get("reason") or ("interrupted-swap" if r["state"] == "swapping" else None),
            })
        return out

    def mark_reconciled(self, transaction_id: str, live_slot_id: str, *, now: float) -> None:
        import json

        with self._db.transaction() as cur:
            row = cur.execute(
                "SELECT detail FROM quota_failover_switches WHERE id = ?", (transaction_id,)
            ).fetchone()
            if row is None:
                return
            detail = json.loads(row["detail"])
            detail["reconciledAt"] = _now_iso(now)
            detail["reconciledLiveSlotId"] = live_slot_id
            cur.execute(
                "UPDATE quota_failover_switches SET detail = ? WHERE id = ?",
                (json.dumps(detail), transaction_id),
            )

    def scopes_seen(self) -> set[tuple[str, str]]:
        with self._db.transaction() as cur:
            rows = cur.execute(
                "SELECT DISTINCT agent_key, auth_scope FROM quota_failover_switches"
            ).fetchall()
        return {(str(r["agent_key"]), str(r["auth_scope"])) for r in rows}

    def history(self, agent_key: str | None = None) -> list[dict[str, Any]]:
        import json

        with self._db.transaction() as cur:
            if agent_key:
                rows = cur.execute(
                    "SELECT * FROM quota_failover_switches WHERE agent_key = ? ORDER BY at",
                    (agent_key,),
                ).fetchall()
            else:
                rows = cur.execute(
                    "SELECT * FROM quota_failover_switches ORDER BY at"
                ).fetchall()
        return [
            {
                "id": r["id"], "agentKey": r["agent_key"], "authScope": r["auth_scope"],
                "incidentId": r["incident_id"], "fromSlotId": r["from_slot"],
                "toSlotId": r["to_slot"], "automatic": bool(r["automatic"]),
                "swapped": bool(r["swapped"]), "state": r["state"], "at": _now_iso(r["at"]),
                **json.loads(r["detail"]),
            }
            for r in rows
        ]


# ── Records ───────────────────────────────────────────────────────────────────

class Incident:
    def __init__(self, *, agent_key: str, auth_scope: str, outgoing_slot_id: str,
                 epoch: int, now: float, trusted: bool, attribution: str,
                 resets_at: float | None, window_kind: str | None, auto_allowed: bool,
                 tried: set[str] | None = None) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.agent_key = agent_key
        self.auth_scope = auth_scope
        self.outgoing_slot_id = outgoing_slot_id
        self.epoch = epoch
        self.state = "detected"
        self.reason: str | None = None
        self.trusted = trusted
        self.attribution = attribution
        self.auto_allowed = auto_allowed
        self.tried: set[str] = set(tried or ())
        self.panes: dict[str, str] = {}   # pane_id -> workspace_path
        self.reports: set[str] = set()    # idempotency keys seen
        self.transaction_ids: list[str] = []
        self.detected_at = now
        self.resets_at = resets_at
        self.window_kind = window_kind
        self.closed_at: float | None = None
        self.updated_at = now

    @property
    def key(self) -> tuple[str, str, str, int]:
        return (self.agent_key, self.auth_scope, self.outgoing_slot_id, self.epoch)

    @property
    def open(self) -> bool:
        return self.closed_at is None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "agentKey": self.agent_key,
            "authScope": self.auth_scope,
            "outgoingSlotId": self.outgoing_slot_id,
            "epoch": self.epoch,
            "state": self.state,
            "reason": self.reason,
            "trusted": self.trusted,
            "attribution": self.attribution,
            "autoAllowed": self.auto_allowed,
            "tried": sorted(self.tried),
            "panes": [{"paneId": p, "workspacePath": w} for p, w in self.panes.items()],
            "transactionIds": list(self.transaction_ids),
            "detectedAt": _now_iso(self.detected_at),
            "resetsAt": _now_iso(self.resets_at) if self.resets_at is not None else None,
            "windowKind": self.window_kind,
            "closedAt": _now_iso(self.closed_at) if self.closed_at is not None else None,
            "updatedAt": _now_iso(self.updated_at),
        }


class Transaction:
    def __init__(self, *, incident: Incident, agent_key: str, auth_scope: str,
                 from_slot_id: str, to_slot_id: str, automatic: bool,
                 idempotency_key: str, switch_mode: str, restart_strategy: str,
                 epoch: int, now: float) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.incident_id = incident.id
        self.agent_key = agent_key
        self.auth_scope = auth_scope
        self.from_slot_id = from_slot_id
        self.to_slot_id = to_slot_id
        self.automatic = automatic
        self.idempotency_key = idempotency_key
        self.switch_mode = switch_mode              # hot | restart | manual
        self.restart_strategy = restart_strategy    # none | resume | new-conversation
        self.confirmation = "none"                  # none | required | confirmed
        self.state = "preparing"
        self.reason: str | None = None
        self.error: str | None = None
        self.swapped = False
        self.epoch_before = epoch
        self.epoch_after: int | None = None
        # pane_id -> {paneId, termId, workspacePath, agentKey, ack, ackReason, settle, settleReason}
        self.panes: dict[str, dict[str, Any]] = {}
        self.restart_owners: dict[str, Any] = {}
        self.restart_terms: dict[str, str] = {}
        self.retry_requested = False
        self.proof_after_at: float | None = None
        self.proof_after_monotonic: float | None = None
        self.hot_switched_panes: list[dict[str, Any]] = []
        self.created_at = now
        self.prepare_sent_at: float | None = None
        self.waiting_since: float | None = None
        self.committed_at: float | None = None
        self.committed_monotonic: float | None = None
        self.closed_at: float | None = None
        self.live_identity: dict[str, Any] | None = None
        # Panes of the pool whose credential reaches the CLI through the
        # environment — untouched by the swap, never restarted, shown as such.
        self.overridden_panes: list[str] = []
        # Named through an incident (automatic, or an announcement's button):
        # the target must stay an eligible candidate up to the commit.
        self.bound_to_candidates = False
        # The user's explicit answer to an unverifiable live credential: "it is
        # still my current account" (manual only; auto never assumes), bound
        # to the fingerprint of the payload they were shown.
        self.assume_live_is_current = False
        self.assumed_fingerprint: str | None = None
        self.live_fingerprint: str | None = None

    @property
    def open(self) -> bool:
        return self.state in OPEN_TRANSACTION_STATES

    @property
    def unsettled(self) -> bool:
        """Committed, but the incident still awaits evidence — a window that
        reconnects must align with it instead of restarting panes again."""
        return self.state in ("committed", "partial") and self.closed_at is None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "incidentId": self.incident_id,
            "agentKey": self.agent_key,
            "authScope": self.auth_scope,
            "fromSlotId": self.from_slot_id,
            "toSlotId": self.to_slot_id,
            "automatic": self.automatic,
            "idempotencyKey": self.idempotency_key,
            "switchMode": self.switch_mode,
            "restartStrategy": self.restart_strategy,
            "confirmation": self.confirmation,
            "state": self.state,
            "reason": self.reason,
            "error": self.error,
            "swapped": self.swapped,
            "epochBefore": self.epoch_before,
            "epochAfter": self.epoch_after,
            "panes": list(self.panes.values()),
            "hotSwitchedPanes": self.hot_switched_panes,
            "overriddenPanes": list(self.overridden_panes),
            "createdAt": _now_iso(self.created_at),
            "committedAt": _now_iso(self.committed_at) if self.committed_at is not None else None,
            "closedAt": _now_iso(self.closed_at) if self.closed_at is not None else None,
            "liveIdentity": self.live_identity,
            "liveFingerprint": self.live_fingerprint,
        }


# ── Service ───────────────────────────────────────────────────────────────────

class QuotaFailoverService:
    """See the module docstring. Single instance, event-loop confined; the only
    blocking work (credential I/O) goes through ``vault_to_thread`` under the
    agent's ``switch_lock`` exactly as the manual switch does."""

    def __init__(self, db: Database, *, now: Callable[[], float] = time.time) -> None:
        self.store = QuotaFailoverStore(db)
        self._now = now
        self._epochs: dict[str, int] = {}
        self.incidents: dict[str, Incident] = {}
        self.transactions: dict[str, Transaction] = {}
        self._idempotency: dict[str, str] = {}
        self._timers: dict[str, asyncio.TimerHandle] = {}
        # Set when a post-swap audit write failed: the budget can no longer be
        # reconciled against what happened, so automatic switching stops
        # until a write succeeds again. Manual switching is unaffected.
        self.audit_degraded: str | None = None
        # agent_key -> the swap whose bookkeeping did not catch up with the
        # live state (see ``unreconciled``). While one exists no switch of
        # that agent may proceed: a switch that read the stale store default
        # as "current" would capture the live account's credentials into the
        # other account's slot, destroying the latter.
        self._unreconciled: dict[str, dict[str, Any]] = {}
        self._load_unreconciled()
        # When each agent's pool last swapped (monotonic): recorded turn ends
        # older than this belong to the outgoing account.
        self._last_commit_monotonic: dict[str, float] = {}

    # ── policy / epoch / state ────────────────────────────────────────────

    def policy_mode(self) -> str:
        return self.store.policy()["mode"]

    # ── reconciliation of half-finished swaps ─────────────────────────────

    def _load_unreconciled(self) -> None:
        try:
            rows = self.store.unreconciled_rows()
        except Exception:  # noqa: BLE001 — a broken audit table must not stop startup
            log.exception("quota_failover: could not read unreconciled swaps")
            return
        for row in rows:
            live = row.get("liveSlotId")
            try:
                current = self._current_slot(row["agentKey"])
            except Exception:  # noqa: BLE001
                current = None
            if live is not None and current == live:
                # Someone (a restart of set_default, the user) already made
                # the store agree with the live state.
                try:
                    self.store.mark_reconciled(row["transactionId"], live, now=self._now())
                except Exception:  # noqa: BLE001
                    log.exception("quota_failover: reconcile mark failed")
                continue
            self._unreconciled[row["agentKey"]] = row

    @staticmethod
    def _live_matches_slot(agent_key: str, slot_id: str, live_identity: dict[str, Any]) -> bool | None:
        """Does the live credential belong to ``slot_id``? True / False when
        both identities carry a comparable email, None when the vendor cannot
        say (an opaque credential) — then only the two-choice rule applies.
        Blocking (Keychain) — thread it."""
        from . import app

        try:
            slot_identity = app.credential_vault.identity(agent_key, slot_id)
        except Exception:  # noqa: BLE001
            return None
        live_email = str((live_identity or {}).get("email") or "").strip().lower()
        slot_email = str((slot_identity or {}).get("email") or "").strip().lower()
        if not live_email or not slot_email:
            return None
        return live_email == slot_email

    def unreconciled(self, agent_key: str) -> dict[str, Any] | None:
        """The half-finished swap blocking this agent, or None. Read by
        ``begin_switch`` and by the manual ``cli_profiles.set_default``."""
        return self._unreconciled.get(agent_key)

    def _note_unreconciled(self, tx: Transaction) -> None:
        self._unreconciled[tx.agent_key] = {
            "transactionId": tx.id, "agentKey": tx.agent_key, "authScope": tx.auth_scope,
            "fromSlotId": tx.from_slot_id, "toSlotId": tx.to_slot_id,
            "liveSlotId": tx.to_slot_id, "reason": tx.reason,
        }

    async def reconcile(self, agent_key: str, transaction_id: str, live_slot_id: str | None = None) -> dict[str, Any]:
        """The manual recovery path: make the store's default agree with the
        account that is actually live, then lift the block. No credential
        moves. ``live_slot_id`` is required when the record cannot say which
        account is live (a swap interrupted mid-way); the UI shows the live
        identity next to every slot's so the user can name it."""
        from . import app
        from .credential_vault import vault_to_thread

        pending = self._unreconciled.get(agent_key)
        if pending is None or pending["transactionId"] != transaction_id:
            raise FailoverRefused("NOT_FOUND", "no unreconciled swap for that agent and transaction")
        known_live = str(pending.get("liveSlotId") or "")
        requested = str(live_slot_id or "")
        if known_live:
            # The record knows who is live (the swap completed, only the
            # default was not written). The server decides; a client naming a
            # different account is refused without any change.
            if requested and requested != known_live:
                raise FailoverRefused(
                    "BAD_REQUEST",
                    f"the live account is {known_live}, not {requested}",
                    {"liveSlotId": known_live},
                )
            live = known_live
        else:
            # Interrupted mid-swap: live is one of the two accounts the swap
            # moved between — never a third. The named one must also agree
            # with the live identity when the vendor can read one.
            live_identity = await vault_to_thread(app.credential_vault.identity, agent_key)
            if not requested:
                raise FailoverRefused(
                    "BAD_REQUEST", "live_slot_id is required: the record cannot say which account is live",
                    {"liveIdentity": live_identity,
                     "choices": [pending["fromSlotId"], pending["toSlotId"]]},
                )
            if requested not in (pending["fromSlotId"], pending["toSlotId"]):
                raise FailoverRefused(
                    "BAD_REQUEST", "the live account can only be one of the two the swap moved between",
                    {"choices": [pending["fromSlotId"], pending["toSlotId"]]},
                )
            verdict = await vault_to_thread(self._live_matches_slot, agent_key, requested, live_identity)
            if verdict is False:
                raise FailoverRefused(
                    "IDENTITY_MISMATCH", f"the live credential is not account {requested}",
                    {"liveIdentity": live_identity},
                )
            live = requested
        if live != DEFAULT_SLOT_ID and self._profile(agent_key, live) is None:
            raise FailoverRefused("BAD_REQUEST", f"unknown account slot: {live}")
        now = self._now()
        lock = app.credential_vault.switch_lock(agent_key)
        try:
            await asyncio.wait_for(lock.acquire(), timeout=10.0)
        except asyncio.TimeoutError as err:
            raise FailoverRefused("SWITCH_LOCK_TIMEOUT", "could not acquire the credential switch lock") from err
        try:
            if self._unreconciled.get(agent_key) is not pending:
                raise FailoverRefused("STALE_STATE", "the pending reconciliation changed")
            try:
                app.cli_profiles_store.set_default(agent_key, None if live == DEFAULT_SLOT_ID else live)
            except Exception as err:  # noqa: BLE001 — still not persisted: still blocked
                raise FailoverRefused("PERSIST_FAILED", f"could not persist the default: {err}") from err
            self.store.mark_reconciled(transaction_id, live, now=now)
            self._unreconciled.pop(agent_key, None)
            self._bump_epoch(agent_key)
            rebound = self.rebind_hot_panes(agent_key, live, pending["authScope"])
            tx = self.transactions.get(transaction_id)
            if tx is not None:
                tx.hot_switched_panes = rebound
                tx.reason = "reconciled"
                tx.closed_at = tx.closed_at or now
        finally:
            lock.release()
        try:
            from .ws_handlers import _broadcast_profiles_changed

            await _broadcast_profiles_changed("set_default", agent_key=agent_key, forced=False,
                                              hot_switched_panes=rebound)
        except Exception:  # noqa: BLE001
            log.exception("quota_failover: profiles broadcast failed")
        await self._broadcast_changed()
        return {"agentKey": agent_key, "liveSlotId": live, "transactionId": transaction_id,
                "hotSwitchedPanes": rebound}

    async def set_policy(self, mode: str) -> dict[str, Any]:
        if mode not in POLICY_MODES:
            raise FailoverRefused("BAD_REQUEST", f"unknown policy mode: {mode!r}")
        now = self._now()
        doc = self.store.set_policy(mode, now=now)
        if mode != "auto":
            # Turning auto off (or down to notify) withdraws every automatic
            # proposal that has not moved credentials yet. A committed one is
            # past the point of no return and keeps reconciling.
            for tx in list(self.transactions.values()):
                if tx.automatic and tx.open:
                    self._withdraw(tx, "policy-changed", now)
        await self._broadcast_changed()
        return doc

    def epoch(self, agent_key: str) -> int:
        return self._epochs.get(agent_key, 0)

    def _bump_epoch(self, agent_key: str) -> int:
        self._epochs[agent_key] = self._epochs.get(agent_key, 0) + 1
        return self._epochs[agent_key]

    def budget(self, agent_key: str, auth_scope: str | None = None) -> dict[str, Any]:
        scope = auth_scope or capability(agent_key)["authScope"]
        now = self._now()
        used = self.store.automatic_swaps(agent_key, scope, since=now - AUTO_BUDGET_WINDOW_S)
        last = self.store.last_automatic_swap(agent_key, scope)
        next_allowed = 0.0
        if len(used) >= AUTO_BUDGET_MAX:
            next_allowed = max(next_allowed, used[0] + AUTO_BUDGET_WINDOW_S)
        if last is not None:
            next_allowed = max(next_allowed, last + AUTO_MIN_GAP_S)
        return {
            "agentKey": agent_key,
            "authScope": scope,
            "used": len(used),
            "limit": AUTO_BUDGET_MAX,
            "windowSec": int(AUTO_BUDGET_WINDOW_S),
            "minGapSec": int(AUTO_MIN_GAP_S),
            "nextAllowedAt": _now_iso(next_allowed) if next_allowed > now else None,
        }

    def _budget_retry_after(self, agent_key: str, auth_scope: str) -> float:
        info = self.budget(agent_key, auth_scope)
        nxt = _parse_iso(info["nextAllowedAt"])
        return max(0.0, nxt - self._now()) if nxt is not None else 0.0

    def _known_scopes(self, caps: dict[str, dict[str, Any]]) -> set[tuple[str, str]]:
        """Every (agentKey, resolved auth scope) a budget can be filed under:
        each declared provider scope of a slot vendor (a single-scope vendor
        resolves to ``kilo:kilo``, a whole-file one to its bare pool), plus
        whatever the audit table already holds."""
        out: set[tuple[str, str]] = set()
        for key, cap in caps.items():
            if not cap["hasSlots"] or not cap["supported"]:
                continue
            if cap["scopes"]:
                for scope in cap["scopes"]:
                    out.add((key, auth_scope_for_scope(key, scope)))
            else:
                out.add((key, cap["authScope"]))
        try:
            out.update(self.store.scopes_seen())
        except Exception:  # noqa: BLE001
            pass
        return out

    def state(self) -> dict[str, Any]:
        caps = capabilities()
        return {
            "policy": self.store.policy(),
            "auditDegraded": self.audit_degraded,
            # Half-finished swaps by agent: every switch of that agent is
            # refused (UNRECONCILED_STATE) until quota_failover.reconcile.
            "unreconciled": dict(self._unreconciled),
            "capabilities": caps,
            # Keyed by the RESOLVED pool the ledger counts under — the same
            # string a transaction's authScope carries — so a UI reading the
            # budget for a kilo switch looks up "kilo:kilo" and sees the swap
            # it just made, not a bare "kilo" that is forever at 0.
            "budget": {
                scope: self.budget(agent, scope) for agent, scope in sorted(self._known_scopes(caps))
            },
            "epochs": dict(self._epochs),
            "incidents": [i.to_dict() for i in self.incidents.values() if i.open],
            # Open (awaiting-confirmation / preparing / waiting-safe) and
            # committed-but-unsettled: a window that reconnects reads these
            # to resume waiting or to see a restart it must not repeat.
            "transactions": [
                t.to_dict() for t in self.transactions.values() if t.open or t.unsettled
            ],
            # Final states, newest first: the announcement stays readable after
            # ready / notify-stopped and a switch-back knows what to undo.
            "recentIncidents": [i.to_dict() for i in self._recent_incidents()],
            "recentTransactions": [
                t.to_dict() for t in self.transactions.values()
                if t.closed_at is not None and any(
                    t.incident_id == i.id for i in self._recent_incidents()
                )
            ],
        }

    def _recent_incidents(self) -> list[Incident]:
        self._prune_recent()
        closed = [i for i in self.incidents.values() if not i.open]
        closed.sort(key=lambda i: i.closed_at or 0.0, reverse=True)
        return closed[:RECENT_MAX]

    def _prune_recent(self) -> None:
        """Forget closed incidents past the retention window, with their
        transactions (the audit rows in the database stay)."""
        cutoff = self._now() - RECENT_RETENTION_S
        for incident in [i for i in self.incidents.values() if not i.open and (i.closed_at or 0) < cutoff]:
            for tid in incident.transaction_ids:
                tx = self.transactions.pop(tid, None)
                if tx is not None:
                    self._idempotency.pop(tx.idempotency_key, None)
            self.incidents.pop(incident.id, None)

    async def _broadcast_changed(self) -> None:
        try:
            from . import app
            from .ipc import make_event

            await app.broadcast(make_event("quota_failover.changed", self.state()))
        except Exception:  # noqa: BLE001 — a broadcast failure never breaks the authority
            log.exception("quota_failover: broadcast failed")

    # ── reports → incidents ───────────────────────────────────────────────

    def _open_incident_for_scope(self, agent_key: str, auth_scope: str) -> Incident | None:
        for inc in self.incidents.values():
            if inc.open and inc.agent_key == agent_key and (
                scope_matches(inc.auth_scope, auth_scope) or scope_matches(auth_scope, inc.auth_scope)
            ):
                return inc
        return None

    def _current_slot(self, agent_key: str) -> str:
        from . import app

        return str(app.cli_profiles_store.list()["defaults"].get(agent_key) or DEFAULT_SLOT_ID)

    def _profile(self, agent_key: str, slot_id: str) -> dict[str, Any] | None:
        from . import app

        if slot_id == DEFAULT_SLOT_ID:
            return None
        profile = app.cli_profiles_store.get(slot_id)
        return profile if profile and profile.get("agentKey") == agent_key else None

    def _verify_signal(
        self, agent_key: str, slot_id: str, source: str, text: str,
        window_kind: str | None, *, pane_id: str = "", at: float | None = None,
    ) -> tuple[bool, str]:
        """Is this exhaustion report evidence the backend can stand behind?

        ``usage-window``: the backend's own per-account snapshot for that slot
        must show a binding window at 100 % (the renderer only points at it).
        ``cli-text``: the vendor must have declared exhaustion text patterns
        and the quoted text must match one. ``structured``: the pane's own
        recorded turn end carries a detail matching those patterns, was
        recorded near the report's time and after the pool's last swap.
        Anything else is recorded as an untrusted incident that only ever
        notifies."""
        if source == "structured":
            return self._verify_structured(agent_key, pane_id, at)
        if source == "usage-window":
            from .usage_service import service

            snap = service.account_snapshots.get(agent_key, {}).get(slot_id)
            if snap is None and slot_id == self._current_slot(agent_key):
                snap = service.snapshots.get(agent_key)
            if snapshot_exhausted(snap, self._now()):
                return True, "usage-window"
            return False, "usage-window-disagrees"
        patterns = quota_text_patterns(agent_key)
        if not patterns:
            return False, "no-declared-detector"
        if text and any(p.search(text) for p in patterns):
            return True, "cli-text"
        return False, "text-did-not-match"

    def _verify_structured(self, agent_key: str, pane_id: str, at: float | None) -> tuple[bool, str]:
        from . import app

        patterns = quota_text_patterns(agent_key)
        if not patterns:
            return False, "no-declared-detector"
        activity = app.pane_activity(pane_id) if pane_id else None
        if activity is None or activity.get("event_type") != "turn_complete":
            return False, "no-recorded-turn-end"
        detail = str(activity.get("detail") or "")
        if not detail or not any(p.search(detail) for p in patterns):
            return False, "detail-did-not-match"
        ts = float(activity.get("ts_monotonic") or 0.0)
        if at is not None:
            # Map the report's wall-clock stamp onto the monotonic clock the
            # activity store uses and require the two to be close.
            report_mono = time.monotonic() - max(0.0, self._now() - at)
            if abs(ts - report_mono) > STRUCTURED_MATCH_WINDOW_S:
                return False, "turn-end-too-old"
        last_commit = self._last_commit_monotonic.get(agent_key)
        if last_commit is not None and ts <= last_commit:
            # A turn that ended before the pool last switched accounts is the
            # previous account's exhaustion; it cannot open an incident on the
            # one live now.
            return False, "structured-stale-epoch"
        return True, "structured"

    async def report(self, payload: dict[str, Any]) -> tuple[Incident, bool]:
        from . import app
        from .pane_account_history import UNKNOWN_PROFILE_ID
        from .profiles_store import SUPPORTED_AGENT_KEYS

        agent_key = str(payload.get("agent_key") or "")
        pane_id = str(payload.get("pane_id") or "")
        signal = str(payload.get("signal") or "")
        source = str(payload.get("source") or "")
        idem = str(payload.get("idempotency_key") or "")
        if signal != TRUSTED_SIGNAL:
            # Classified, never acted on: the renderer gets the class back for
            # its notice, and no incident (so no candidate, no retry) exists.
            raise FailoverRefused(
                "BAD_SIGNAL", f"{signal!r} is not a quota exhaustion signal",
                {"accepted": [TRUSTED_SIGNAL],
                 "classified": signal if signal in NON_QUOTA_SIGNALS else "unknown",
                 "action": "notify-only"},
            )
        if source not in REPORT_SOURCES:
            raise FailoverRefused("BAD_REQUEST", f"unknown report source: {source!r}")
        from .cli_vendors.registry import VENDORS

        if agent_key not in VENDORS:
            raise FailoverRefused("BAD_REQUEST", f"unknown vendor: {agent_key!r}")
        now = self._now()
        at = _parse_iso(payload.get("at")) or now
        resets_at = _parse_iso(payload.get("resets_at"))
        window_kind = str(payload.get("window_kind") or "") or None
        workspace_path = str(payload.get("workspace_path") or "")

        # Attribution: the account the pane was pinned to when it saw the
        # message — a late signal from an old pane must not land on a default
        # that has since moved on.
        slot_id = app.pane_account_history.profile_at(pane_id, at) if pane_id else UNKNOWN_PROFILE_ID
        attribution = "pane-history"
        if slot_id == UNKNOWN_PROFILE_ID:
            if agent_key in SUPPORTED_AGENT_KEYS:
                attribution = "unknown"
            else:
                # A vendor without accounts has exactly one — the default.
                slot_id = DEFAULT_SLOT_ID
                attribution = "single-account"
        profile = self._profile(agent_key, slot_id) if attribution != "unknown" else None
        auth_scope = auth_scope_for(agent_key, profile)
        epoch = self.epoch(agent_key)
        trusted, why = (False, "unattributed")
        if attribution != "unknown":
            trusted, why = self._verify_signal(
                agent_key, slot_id, source, str(payload.get("text") or ""), window_kind,
                pane_id=pane_id, at=at,
            )
        if trusted and at is not None:
            try:
                updated = await asyncio.to_thread(
                    app.quota_ledger.mark_exhausted, agent_key, slot_id, at, resets_at
                )
            except Exception:  # noqa: BLE001 — the ledger is bookkeeping, not the decision
                updated = []
            for kind in updated:
                from .ipc import make_event

                await app.broadcast(make_event("tokens.quota_cycles_changed", {
                    "agent_key": agent_key, "profile_id": slot_id, "window_kind": kind,
                }))

        if not trusted:
            # Unverified notices cannot chain/close an authoritative incident
            # or poison the tried set that drives later candidate selection.
            incident = next((inc for inc in self.incidents.values()
                             if not inc.trusted and inc.agent_key == agent_key
                             and inc.outgoing_slot_id == slot_id and idem in inc.reports), None) if idem else None
            created = incident is None
            if incident is None:
                incident = Incident(agent_key=agent_key, auth_scope=auth_scope, outgoing_slot_id=slot_id,
                                    epoch=epoch, now=now, trusted=False, attribution=attribution,
                                    resets_at=resets_at, window_kind=window_kind, auto_allowed=False)
                incident.reason, incident.closed_at = why, now
                self.incidents[incident.id] = incident
            if idem:
                incident.reports.add(idem)
            if pane_id:
                incident.panes[pane_id] = workspace_path
            await self._broadcast_changed()
            return incident, created
        prior = self._open_incident_for_scope(agent_key, auth_scope)
        created = False
        if prior is not None and prior.outgoing_slot_id == slot_id:
            # The same account running out again — including a window's late
            # report of the exhaustion that was already switched away from
            # (its epoch moved, the account did not) — is the same incident.
            incident = prior
            if idem and idem in incident.reports:
                return incident, False
        else:
            tried: set[str] = set()
            auto_allowed = trusted
            chained_from = prior or self._switched_onto(agent_key, auth_scope, slot_id)
            if chained_from is not None:
                # Exhaustion on a different account while the earlier incident
                # is unresolved, or on the very account an earlier run switched
                # onto: the run continues, it does not start over. The tried
                # set carries over and no automatic attempt is made — a switch
                # that landed on an exhausted account stops there.
                tried = set(chained_from.tried) | {chained_from.outgoing_slot_id}
                auto_allowed = False
                if chained_from.open:
                    self._close_incident(chained_from, "notify-stopped", "chained-exhaustion", now)
            prior = chained_from
            incident = Incident(
                agent_key=agent_key, auth_scope=auth_scope, outgoing_slot_id=slot_id,
                epoch=epoch, now=now, trusted=trusted, attribution=attribution,
                resets_at=resets_at, window_kind=window_kind, auto_allowed=auto_allowed,
                tried=tried,
            )
            if not trusted:
                incident.reason = why
            elif prior is not None:
                incident.state = "notify-stopped"
                incident.reason = "chained-exhaustion"
            self.incidents[incident.id] = incident
            created = True
        if idem:
            incident.reports.add(idem)
        if pane_id:
            incident.panes[pane_id] = workspace_path
        incident.updated_at = now

        if created and incident.auto_allowed and self.policy_mode() == "auto":
            await self._try_automatic(incident)
        await self._broadcast_changed()
        return incident, created

    def _switched_onto(self, agent_key: str, auth_scope: str, slot_id: str) -> Incident | None:
        """The most recent incident (open or retained) whose committed
        transaction moved the pool onto ``slot_id`` — the account now reported
        exhausted was a switch target, so this exhaustion chains onto that run
        rather than opening a fresh one."""
        best: Incident | None = None
        for incident in self.incidents.values():
            if incident.agent_key != agent_key:
                continue
            if not (scope_matches(incident.auth_scope, auth_scope)
                    or scope_matches(auth_scope, incident.auth_scope)):
                continue
            if any(
                self.transactions[t].swapped and self.transactions[t].to_slot_id == slot_id
                for t in incident.transaction_ids if t in self.transactions
            ) and (best is None or incident.updated_at > best.updated_at):
                best = incident
        return best

    async def _try_automatic(self, incident: Incident) -> None:
        """One automatic attempt per incident. Every refusal is recorded on
        the incident as ``notify-stopped`` with the reason; nothing retries."""
        cap = capability(incident.agent_key)
        if cap["switchMode"] not in ("hot", "restart"):
            self._stop_incident(incident, "unsupported" if not cap["supported"] else "manual-only")
            return
        if not self._platform_supported(cap):
            self._stop_incident(incident, "platform-unsupported")
            return
        if not cap.get("hasIdentity", True):
            self._stop_incident(incident, "identity-unknown")
            return
        if cap["switchMode"] == "restart" and cap["resume"] != "native":
            self._stop_incident(incident, "no-resume")
            return
        try:
            ranked = await self.candidates(incident.agent_key)
        except FailoverRefused as refused:
            self._stop_incident(incident, refused.code.lower())
            return
        eligible = [c for c in ranked if c["excluded"] is None and c["slotId"] not in incident.tried]
        if not eligible:
            self._stop_incident(incident, "no-candidate")
            return
        target = eligible[0]
        if target["tier"] == "unknown" and any(
            c["tier"] == "unknown" for c in eligible[1:]
        ):
            # An unknown candidate may be the incident's single attempt; there
            # is nothing to choose between several of them.
            pass
        try:
            await self.begin_switch({
                "agent_key": incident.agent_key,
                "to_slot_id": target["slotId"],
                "incident_id": incident.id,
                "expected_current_slot_id": incident.outgoing_slot_id,
                "expected_epoch": incident.epoch,
                "idempotency_key": f"auto:{incident.id}:{target['slotId']}",
                "automatic": True,
            }, _internal=True)
        except FailoverRefused as refused:
            self._stop_incident(incident, refused.code.lower())

    @staticmethod
    def _platform_supported(cap: dict[str, Any]) -> bool:
        """The adapter declares this platform (an empty declaration means
        every platform). ``evidence`` is deliberately NOT a gate: it records
        how the layout was established for the acceptance record, and the
        pending real-machine verification stays listed as pending."""
        from . import osplat

        platforms = cap.get("platforms") or ()
        return not platforms or osplat.platform_id in platforms

    def _stop_incident(self, incident: Incident, reason: str) -> None:
        if incident.state == "notify-stopped" and incident.reason:
            # Already stopped with a more specific reason (a transaction's
            # own failure); the refusal that follows adds nothing.
            return
        incident.state = "notify-stopped"
        incident.reason = reason
        incident.updated_at = self._now()

    def _close_incident(self, incident: Incident, state: str, reason: str | None, now: float) -> None:
        incident.state = state
        if reason is not None:
            incident.reason = reason
        incident.closed_at = now
        incident.updated_at = now
        for tid in incident.transaction_ids:
            tx = self.transactions.get(tid)
            if tx is not None and tx.open:
                self._close_transaction(tx, "cancelled", reason or "incident-closed", now)
            elif tx is not None and tx.unsettled:
                tx.closed_at = now

    # ── candidates ────────────────────────────────────────────────────────

    async def candidates(self, agent_key: str) -> list[dict[str, Any]]:
        from . import app
        from .credential_vault import vault_to_thread
        from .profiles_store import SUPPORTED_AGENT_KEYS
        from .usage_service import service

        if agent_key not in SUPPORTED_AGENT_KEYS:
            raise FailoverRefused("UNSUPPORTED", f"{agent_key!r} has no account slots")
        doc = app.cli_profiles_store.list()
        current = str(doc["defaults"].get(agent_key) or DEFAULT_SLOT_ID)
        slot_ids = [DEFAULT_SLOT_ID] + [
            str(p["id"]) for p in doc["profiles"] if p.get("agentKey") == agent_key and p.get("id")
        ]
        snapshots = dict(service.account_snapshots.get(agent_key, {}))
        if current not in snapshots and agent_key in service.snapshots:
            snapshots[current] = service.snapshots[agent_key]
        # One thread hop for every blocking read (Keychain-backed slot reads,
        # the ledger): the ranking is consulted on the hot path of a report.
        def _blocking() -> tuple[dict[str, str | None], set[str]]:
            states = {slot_id: self._login_state(agent_key, slot_id) for slot_id in slot_ids}
            return states, self._ledger_vetoes(agent_key, slot_ids)

        login_states, vetoes = await vault_to_thread(_blocking)
        incident = self._open_incident_for_scope(agent_key, capability(agent_key)["authScope"])
        tried = set(incident.tried) if incident is not None else set()
        return rank_candidates(
            slot_ids=slot_ids, current_slot_id=current, snapshots=snapshots,
            login_states=login_states, tried=tried, now=self._now(), ledger_vetoes=vetoes,
        )

    def _ledger_vetoes(self, agent_key: str, slot_ids: list[str]) -> set[str]:
        """Slots whose quota ledger holds an open cycle that ran out and has
        not reset. The ledger is stamped by the panes' own limit messages, so
        it can know about an exhaustion newer than the last usage read."""
        from . import app

        ledger = getattr(app, "quota_ledger", None)
        if ledger is None:
            return set()
        out: set[str] = set()
        for slot_id in slot_ids:
            try:
                cycles = ledger.cycles(agent_key, slot_id, now=self._now())
            except Exception:  # noqa: BLE001 — bookkeeping cannot block a candidate list
                continue
            if any(not c.get("closed") and c.get("exhausted_at") for c in cycles):
                out.add(slot_id)
        return out

    @staticmethod
    def _login_state(agent_key: str, slot_id: str) -> str:
        """"ok" / "signed-out" / "expired" / "login-pending" for a slot, using
        the same judgement the manual switch makes (``_slot_login_reason``)
        plus the isolated login home check. Blocking — thread it."""
        from . import app
        from .ws_handlers import _running_login_terminals, _slot_login_reason

        if slot_id != DEFAULT_SLOT_ID:
            try:
                # A running sign-in pane for the slot means its credential is
                # still being written — for every vendor, with or without a
                # login home. A started, unharvested sign-in counts too.
                if _running_login_terminals(agent_key, slot_id) or login_pending(
                    app.credential_vault, agent_key, slot_id
                ):
                    return "login-pending"
            except Exception:  # noqa: BLE001
                pass
        return _slot_login_reason(agent_key, slot_id) or "ok"

    @staticmethod
    def _store_matches(agent_key: str, metadata: dict) -> bool:
        from . import app

        stores = getattr(app.credential_vault, "stores", None)
        return stores is None or not stores.enabled(agent_key) or stores.matches(agent_key, metadata)

    # ── switch transactions ───────────────────────────────────────────────

    def _affected_terminals(self, auth_scope: str) -> list[dict[str, Any]]:
        """Every live regular pane running on the credential pool — across
        windows and workspaces, and across every vendor sharing the pool.

        For a provider-bound pool (``opencode:anthropic``) a pane belongs only
        when the account it was pinned to at launch (pane_account_history) is
        bound to that provider; a pane of the same CLI on another provider is
        left alone. A pane whose pin is unknown cannot be placed either way and
        is returned with ``scopeUnknown`` — the caller stops rather than
        guess (``_scope_unknown_panes``)."""
        from . import app

        members = set(scope_members(auth_scope))
        bound = ":" in auth_scope
        out: list[dict[str, Any]] = []
        for tid, owner in list(app._PTY_OWNERS.items()):
            term = owner.terminals.get(tid)
            if (
                term is None or getattr(term, "closed", False)
                or term.agent_key not in members
                or term.metadata.get("login_profile_id")
            ):
                continue
            pane_id = str(getattr(term, "pane_id", "") or "")
            scope_unknown = False
            recorded = str(term.metadata.get("auth_scope") or "")
            if bound:
                # Only the pool recorded at launch places a pane. A pane older
                # than provenance, or one launched on the default slot of a
                # multi-provider store (it may use any provider in the file and
                # nothing observes which), cannot be placed and stops the run.
                if not recorded or ":" not in recorded:
                    scope_unknown = True
                elif recorded != auth_scope:
                    continue
            elif recorded and recorded.split(":", 1)[0] != auth_scope.split(":", 1)[0]:
                continue
            out.append({
                "scopeUnknown": scope_unknown or not self._store_matches(term.agent_key, term.metadata),
                "credentialStoreId": term.metadata.get("credential_store_id"),
                # Recorded at launch; a pane older than provenance says "vault"
                # only because nothing else could have put it elsewhere.
                "credentialSource": str(term.metadata.get("credential_source") or "vault"),
                "paneId": pane_id,
                "termId": tid,
                "agentKey": term.agent_key,
                "workspacePath": str(term.metadata.get("workspace_path") or getattr(term, "cwd", "") or ""),
                "ack": None,
                "ackReason": None,
                "settle": None,
                "settleReason": None,
            })
        return out

    def _owner_of(self, term_id: str):
        from . import app

        return app._PTY_OWNERS.get(term_id)

    def rebind_hot_panes(self, agent_key: str, slot_id: str, auth_scope: str) -> list[dict[str, Any]]:
        """Re-pin proven hot vault consumers; the caller holds the switch lock."""
        from . import app

        if capability(agent_key)["switchMode"] != "hot":
            return []
        rebound = []
        for term_id, owner in list(app._PTY_OWNERS.items()):
            lookup = getattr(getattr(owner, "terminals", None), "get", None)
            term = lookup(term_id) if callable(lookup) else None
            if term is None or getattr(term, "closed", False) or term.agent_key != agent_key:
                continue
            meta = term.metadata
            if (meta.get("login_profile_id") or meta.get("credential_source") != "vault"
                    or meta.get("auth_scope") != auth_scope
                    or not self._store_matches(agent_key, meta)):
                continue
            meta["launch_profile_id"] = slot_id
            app.pane_account_history.pin(term.pane_id, slot_id, ts=self._now())
            rebound.append({"paneId": term.pane_id, "termId": term_id,
                            "profileId": None if slot_id == DEFAULT_SLOT_ID else slot_id})
        return rebound

    def _pane_busy(self, pane_id: str) -> bool:
        """Backend-side defence only: the last activity event is a running
        turn. The renderer's ack is the reliable readiness judgement; this
        catches a turn that started after the ack was sent."""
        from . import app

        activity = app.pane_activity(pane_id)
        return bool(activity and activity.get("event_type") == "agent_active")

    async def begin_switch(self, payload: dict[str, Any], *, _internal: bool = False) -> Transaction:
        from .profiles_store import SUPPORTED_AGENT_KEYS

        agent_key = str(payload.get("agent_key") or "")
        to_slot = str(payload.get("to_slot_id") or DEFAULT_SLOT_ID)
        automatic = bool(payload.get("automatic"))
        idem = str(payload.get("idempotency_key") or "")
        if agent_key not in SUPPORTED_AGENT_KEYS:
            raise FailoverRefused("UNSUPPORTED", f"{agent_key!r} has no account slots")
        if not idem:
            raise FailoverRefused("BAD_REQUEST", "idempotency_key is required")
        if payload.get("force"):
            # The manual route's force means "restart my panes for me". This
            # authority never forces: a busy pane waits, it is not restarted.
            raise FailoverRefused("BAD_REQUEST", "force is not accepted by quota_failover.switch")
        if "expected_current_slot_id" not in payload or "expected_epoch" not in payload:
            raise FailoverRefused(
                "BAD_REQUEST", "expected_current_slot_id and expected_epoch are required",
            )
        existing_id = self._idempotency.get(idem)
        if existing_id is not None and existing_id in self.transactions:
            return self.transactions[existing_id]
        from . import app
        from .credential_vault import vault_to_thread
        guard = getattr(app.credential_vault, "require_store_mutation", None)
        if guard is not None:
            try:
                await vault_to_thread(guard, agent_key)
            except ValueError as err:
                raise FailoverRefused("CREDENTIAL_STORE_UNVERIFIED", str(err)) from err
        cap = capability(agent_key)
        if not cap["supported"]:
            raise FailoverRefused("UNSUPPORTED", cap["todo"] or f"{agent_key} declares no account switch")
        login_block = self._live_login_block(agent_key)
        if login_block is not None:
            # A sign-in against the live credential store is under way (or its
            # result is not parked yet): the live credential is nobody's own
            # until the vault harvests or discards it.
            raise FailoverRefused(
                "LOGIN_IN_PROGRESS",
                f"a {agent_key} sign-in is rewriting the live credential; wait for it to finish",
                login_block,
            )
        pending = self.unreconciled(agent_key)
        if pending is not None:
            # The store's default and the live account disagree. Reading the
            # default as "current" here would capture the live credentials
            # into the wrong slot — refuse until the user reconciles.
            raise FailoverRefused(
                "UNRECONCILED_STATE",
                "an earlier switch moved the credentials but its bookkeeping did not "
                "finish; reconcile it before switching again",
                dict(pending),
            )
        if automatic and not _internal:
            # A renderer may propose, never authorise: the persisted policy is
            # the only thing that makes a switch automatic.
            if self.policy_mode() != "auto":
                raise FailoverRefused("AUTO_DISABLED", "automatic switching is not enabled")
        if automatic and cap["switchMode"] == "manual":
            raise FailoverRefused("MANUAL_ONLY", f"{agent_key} switches accounts manually only")
        if to_slot != DEFAULT_SLOT_ID and self._profile(agent_key, to_slot) is None:
            raise FailoverRefused("BAD_REQUEST", f"profile not found for {agent_key}: {to_slot}")
        profile_to = self._profile(agent_key, to_slot)
        now = self._now()
        current = self._current_slot(agent_key)
        if str(payload.get("expected_current_slot_id") or DEFAULT_SLOT_ID) != current:
            raise FailoverRefused(
                "STALE_STATE", "the active account changed since this was proposed",
                {"currentSlotId": current},
            )
        try:
            expected_epoch = int(payload.get("expected_epoch"))
        except (TypeError, ValueError):
            raise FailoverRefused("BAD_REQUEST", "expected_epoch must be an integer") from None
        if expected_epoch != self.epoch(agent_key):
            raise FailoverRefused(
                "STALE_EPOCH", "an account switch already happened",
                {"epoch": self.epoch(agent_key)},
            )
        if to_slot == current:
            raise FailoverRefused("NOOP", "that account is already active")
        # The pool the swap moves. The built-in default slot has no profile
        # record and so no provider of its own: it takes the scope of the
        # profile on the other side (scoped A -> default and default -> A both
        # swap A's provider entry). Two profiles must name the same one.
        profile_from = self._profile(agent_key, current)
        scope_from = profile_scope(agent_key, profile_from)
        scope_to = profile_scope(agent_key, profile_to)
        if profile_from is not None and profile_to is not None and scope_from != scope_to:
            raise FailoverRefused(
                "SCOPE_MISMATCH", "the target account belongs to a different credential pool",
            )
        tx_scope = scope_to if profile_to is not None else scope_from
        auth_scope = auth_scope_for_scope(agent_key, tx_scope)
        if capability(agent_key)["scopes"] and not tx_scope:
            # A multi-provider store with no provider named on either side:
            # the vault would have to guess which entry to move.
            raise FailoverRefused(
                "SCOPE_UNKNOWN", "neither account names the provider whose credential moves",
            )
        preflight = switch_preflight(agent_key, scope=tx_scope)
        if not preflight.get("ok"):
            reason = str(preflight.get("reason") or "unsupported")
            raise FailoverRefused(
                reason.upper().replace("-", "_"), f"{agent_key} account switch refused: {reason}",
                {"preflight": preflight},
            )
        incident = None
        incident_id = str(payload.get("incident_id") or "")
        if incident_id:
            incident = self.incidents.get(incident_id)
            if incident is None or not incident.open:
                raise FailoverRefused("STALE_INCIDENT", "that incident is no longer open")
            if incident.agent_key != agent_key or not scope_matches(incident.auth_scope, auth_scope):
                raise FailoverRefused("BAD_REQUEST", "incident does not belong to this account pool")
        else:
            incident = self._open_incident_for_scope(agent_key, auth_scope)
            if incident is None:
                incident = Incident(
                    agent_key=agent_key, auth_scope=auth_scope, outgoing_slot_id=current,
                    epoch=self.epoch(agent_key), now=now, trusted=False,
                    attribution="manual", resets_at=None, window_kind=None,
                    auto_allowed=False,
                )
                incident.reason = "manual-request"
                self.incidents[incident.id] = incident
        for tid in incident.transaction_ids:
            other = self.transactions.get(tid)
            if other is not None and other.open:
                if other.to_slot_id == to_slot:
                    # Same proposal from another window — one result for both.
                    self._idempotency[idem] = other.id
                    return other
                raise FailoverRefused(
                    "TRANSACTION_ACTIVE", "another switch for this account pool is in flight",
                    {"transactionId": other.id},
                )
        if automatic:
            if to_slot in incident.tried:
                raise FailoverRefused("ALREADY_TRIED", "that account was already tried in this run")
            if not incident.auto_allowed:
                raise FailoverRefused("AUTO_STOPPED", incident.reason or "automatic run already stopped")
            if not self._platform_supported(cap):
                raise FailoverRefused(
                    "PLATFORM_UNSUPPORTED", f"{agent_key} account switching is not declared for this platform",
                )
            if not cap.get("hasIdentity", True):
                raise FailoverRefused(
                    "IDENTITY_UNKNOWN",
                    f"{agent_key} credentials carry no readable identity; a switch cannot be verified",
                )
            if self.audit_degraded:
                raise FailoverRefused(
                    "AUTO_BUDGET_UNVERIFIABLE",
                    "an earlier switch could not be recorded; automatic switching is "
                    "paused until the budget can be reconciled",
                    {"error": self.audit_degraded},
                )
            retry_after = self._budget_retry_after(agent_key, auth_scope)
            if retry_after > 0:
                raise FailoverRefused(
                    "AUTO_BUDGET_EXHAUSTED",
                    f"automatic switch budget spent; next allowed in {retry_after:.0f}s",
                    {"retryAfter": retry_after, "budget": self.budget(agent_key, auth_scope)},
                )
        bound_to_candidates = bool(automatic or incident_id)
        if bound_to_candidates:
            # An automatic pick and an announcement's button both name a
            # candidate; neither may name one the ranking excludes (a weekly
            # or ledger veto, a login problem, an already-tried slot). A
            # deliberate manual switch (no incident named) may pick any
            # account that can sign in.
            await self._require_eligible(agent_key, to_slot)
        restart_strategy = "none"
        if cap["switchMode"] in ("restart", "manual"):
            restart_strategy = "resume" if cap["resume"] == "native" else "new-conversation"
        if automatic and restart_strategy == "new-conversation":
            raise FailoverRefused("NO_RESUME", f"{agent_key} panes cannot resume after a restart")

        tx = Transaction(
            incident=incident, agent_key=agent_key, auth_scope=auth_scope,
            from_slot_id=current, to_slot_id=to_slot, automatic=automatic,
            idempotency_key=idem, switch_mode=cap["switchMode"],
            restart_strategy=restart_strategy, epoch=self.epoch(agent_key), now=now,
        )
        tx.bound_to_candidates = bound_to_candidates
        tx.assume_live_is_current = bool(payload.get("assume_live_is_current")) and not automatic
        # A confirming resend answers exactly the refused state: expected_*
        # (mandatory above) plus the live payload's fingerprint from the
        # cancelled transaction — the epoch cannot see a CLI rewriting the live
        # store during the dialog.
        tx.assumed_fingerprint = str(payload.get("live_fingerprint") or "") or None
        if tx.assume_live_is_current and not tx.assumed_fingerprint:
            raise FailoverRefused(
                "BAD_REQUEST", "assume_live_is_current requires the live_fingerprint from the refusal",
            )
        self.transactions[tx.id] = tx
        self._idempotency[idem] = tx.id
        incident.transaction_ids.append(tx.id)
        incident.updated_at = now
        if automatic:
            incident.tried.add(to_slot)

        affected = self._affected_terminals(auth_scope)
        tx.panes = {p["paneId"] or p["termId"]: p for p in affected}
        overridden = self._overridden_panes(affected)
        if overridden and automatic:
            self._fail(tx, incident, "cancelled", "credential-override", now)
            await self._broadcast_changed()
            raise FailoverRefused(
                "CREDENTIAL_OVERRIDE",
                "some panes take their credential from the environment; the swap "
                "would not change their account",
                {"panes": overridden, "transactionId": tx.id},
            )
        if overridden:
            # Manual: the swap proceeds for the vault-backed panes; the others
            # are listed as untouched so nobody reads them as switched.
            tx.overridden_panes = overridden
            tx.panes = {k: p for k, p in tx.panes.items() if (p["paneId"] or p["termId"]) not in overridden}
        unknown = self._scope_unknown_panes(affected)
        if unknown:
            # Panes that may or may not run on this pool: nobody can say whether
            # the swap would pull their credentials, so nothing moves.
            self._fail(tx, incident, "cancelled", "pane-scope-unknown", now)
            await self._broadcast_changed()
            raise FailoverRefused(
                "SCOPE_UNKNOWN", "some panes cannot be placed in a credential pool",
                {"panes": unknown, "transactionId": tx.id},
            )
        if cap["switchMode"] == "hot":
            # Hot panes are never restarted; they are listed so the evidence
            # of who was affected — and later, who completed a turn under the
            # new account — is checkable.
            await self._commit(tx, incident)
        else:
            if restart_strategy == "new-conversation" and not payload.get("confirmed"):
                # Work in those panes cannot be carried over. The user must say
                # so before credentials move; auto never reaches this branch.
                tx.state = "awaiting-confirmation"
                tx.confirmation = "required"
                incident.state = "waiting-safe"
            elif not affected:
                await self._commit(tx, incident)
            else:
                if payload.get("confirmed"):
                    tx.confirmation = "confirmed"
                await self._send_prepare(tx, incident)
        await self._broadcast_changed()
        return tx

    @staticmethod
    def _live_login_block(agent_key: str) -> dict[str, Any] | None:
        """``{"agentKey", "profileId"}`` when a live-store sign-in of this
        agent is running or has left an unharvested pre-login snapshot."""
        from . import app
        from .ws_handlers import _live_login_pending, _running_live_login_terminals

        running = _running_live_login_terminals(agent_key)
        if running:
            term = None
            owner = app._PTY_OWNERS.get(running[0])
            lookup = getattr(getattr(owner, "terminals", None), "get", None)
            term = lookup(running[0]) if callable(lookup) else None
            profile = str(getattr(term, "metadata", {}).get("login_profile_id") or "") if term else ""
            return {"agentKey": agent_key, "profileId": profile or None, "state": "running"}
        if _live_login_pending(agent_key):
            return {"agentKey": agent_key, "profileId": None, "state": "pending"}
        return None

    async def _require_eligible(self, agent_key: str, to_slot: str, *, allow_tried: bool = False) -> None:
        """``allow_tried``: the commit's own re-check — the slot was marked
        tried when this very transaction was proposed."""
        ranked = await self.candidates(agent_key)
        row = next((c for c in ranked if c["slotId"] == to_slot), None)
        if row is None:
            raise FailoverRefused("BAD_REQUEST", f"unknown account slot: {to_slot}")
        if row["excluded"] == "tried" and allow_tried:
            return
        if row["excluded"] is not None:
            raise FailoverRefused(
                "CANDIDATE_EXCLUDED", f"account {to_slot} is not eligible: {row['excluded']}",
                {"excluded": row["excluded"], "candidate": row},
            )

    @staticmethod
    def _scope_unknown_panes(panes: list[dict[str, Any]]) -> list[str]:
        return [p["paneId"] or p["termId"] for p in panes if p.get("scopeUnknown")]

    @staticmethod
    def _overridden_panes(panes: list[dict[str, Any]]) -> list[str]:
        """Panes whose credential comes from the environment, not the vault:
        the swap does not change their account. Auto refuses rather than
        count a switch that changed nothing for them."""
        return [
            p["paneId"] or p["termId"] for p in panes
            if p.get("credentialSource", "vault") != "vault"
        ]

    async def confirm(self, transaction_id: str) -> Transaction:
        tx = self.transactions.get(transaction_id)
        if tx is None:
            raise FailoverRefused("NOT_FOUND", "unknown transaction")
        if tx.state != "awaiting-confirmation":
            raise FailoverRefused("BAD_STATE", f"transaction is {tx.state}, not awaiting confirmation")
        incident = self.incidents[tx.incident_id]
        tx.confirmation = "confirmed"
        tx.panes = {p["paneId"] or p["termId"]: p for p in self._affected_terminals(tx.auth_scope)}
        if not tx.panes:
            await self._commit(tx, incident)
        else:
            await self._send_prepare(tx, incident)
        await self._broadcast_changed()
        return tx

    async def _send_prepare(self, tx: Transaction, incident: Incident) -> None:
        """Ask every window owning an affected pane whether that pane can be
        stopped and resumed. Panes nobody owns cannot be restarted by anyone,
        so the transaction cannot proceed."""
        from .ipc import make_event

        now = self._now()
        tx.state = "preparing"
        tx.prepare_sent_at = now
        incident.state = "waiting-safe"
        by_owner: dict[Any, list[dict[str, Any]]] = {}
        for pane in tx.panes.values():
            owner = self._owner_of(pane["termId"])
            if owner is None or getattr(owner, "dead", False):
                self._close_transaction(tx, "cancelled", "pane-unowned", now)
                incident.state = "notify-stopped"
                incident.reason = "pane-unowned"
                return
            by_owner.setdefault(owner, []).append(pane)
            tx.restart_owners[pane["paneId"]] = owner
        deadline = now + PREPARE_ACK_DEADLINE_S
        for owner, panes in by_owner.items():
            await owner.send_json(make_event("quota_failover.prepare", {
                "transactionId": tx.id,
                "incidentId": incident.id,
                "agentKey": tx.agent_key,
                "authScope": tx.auth_scope,
                "fromSlotId": tx.from_slot_id,
                "toSlotId": tx.to_slot_id,
                "restartStrategy": tx.restart_strategy,
                "automatic": tx.automatic,
                "deadlineAt": _now_iso(deadline),
                "panes": [
                    {"paneId": p["paneId"], "termId": p["termId"],
                     "agentKey": p["agentKey"], "workspacePath": p["workspacePath"]}
                    for p in panes
                ],
            }))
        self._arm_timer(tx.id, PREPARE_ACK_DEADLINE_S)

    async def ack(self, payload: dict[str, Any]) -> Transaction:
        """A window's answer for one pane. ``ready=true`` marks it safe to
        stop; ``ready=false`` with reason ``busy`` parks the transaction in
        waiting-safe (the window re-acks when the pane reaches a turn
        boundary); any other reason — no session, not resumable, unsupported,
        refused — ends the transaction."""
        tx = self.transactions.get(str(payload.get("transaction_id") or ""))
        if tx is None:
            raise FailoverRefused("NOT_FOUND", "unknown transaction")
        if not tx.open or tx.state == "awaiting-confirmation":
            raise FailoverRefused("BAD_STATE", f"transaction is {tx.state}")
        incident = self.incidents[tx.incident_id]
        pane_id = str(payload.get("pane_id") or "")
        pane = tx.panes.get(pane_id)
        if pane is None:
            raise FailoverRefused("BAD_REQUEST", f"pane {pane_id} is not part of this transaction")
        now = self._now()
        ready = bool(payload.get("ready"))
        reason = str(payload.get("reason") or "")
        resume = payload.get("resume") if isinstance(payload.get("resume"), dict) else {}
        if ready and tx.restart_strategy == "resume":
            # Ready means "this pane can be stopped and brought back on its
            # conversation": the window must say so explicitly and name the
            # session. Missing data is not readiness.
            if resume.get("resumable") is not True or not str(resume.get("session_id") or ""):
                ready, reason = False, (
                    "not-resumable" if resume.get("resumable") is False else "resume-data-missing"
                )
        if ready and tx.automatic and str(payload.get("idle") or "") != "turn-boundary":
            # Automatic stops nothing on a guess: the window has to have seen a
            # turn boundary, not silence.
            ready, reason = False, "idle-unverified"
        pane["ack"] = "ready" if ready else ("busy" if reason == "busy" else "refused")
        pane["ackReason"] = None if ready else (reason or "refused")
        if resume.get("session_id"):
            pane["sessionId"] = str(resume["session_id"])
        if not ready and reason != "busy":
            self._close_transaction(tx, "cancelled", f"pane-{reason or 'refused'}", now)
            incident.state = "notify-stopped"
            incident.reason = tx.reason
            await self._broadcast_changed()
            return tx
        if all(p["ack"] == "ready" for p in tx.panes.values()):
            self._disarm_timer(tx.id)
            await self._commit(tx, incident)
        elif any(p["ack"] == "busy" for p in tx.panes.values()) and all(
            p["ack"] in ("ready", "busy") for p in tx.panes.values()
        ):
            if tx.state != "waiting-safe":
                tx.state = "waiting-safe"
                tx.waiting_since = now
                self._arm_timer(tx.id, WAIT_SAFE_MAX_S)
        await self._broadcast_changed()
        return tx

    async def cancel(self, transaction_id: str, reason: str = "user-cancelled") -> Transaction:
        tx = self.transactions.get(transaction_id)
        if tx is None:
            raise FailoverRefused("NOT_FOUND", "unknown transaction")
        if not tx.open:
            raise FailoverRefused("BAD_STATE", f"transaction is {tx.state}")
        now = self._now()
        self._withdraw(tx, reason, now)
        await self._broadcast_changed()
        return tx

    def _withdraw(self, tx: Transaction, reason: str, now: float) -> None:
        """Cancel an un-committed transaction AND settle its incident: an
        incident left in waiting-safe / switching with no open transaction
        would read as "switching" forever and swallow the next report."""
        self._close_transaction(tx, "cancelled", reason, now)
        incident = self.incidents.get(tx.incident_id)
        if incident is not None and incident.open and incident.state in (
            "detected", "waiting-safe", "switching",
        ):
            incident.state = "notify-stopped"
            incident.reason = reason
            incident.updated_at = now

    def _close_transaction(self, tx: Transaction, state: str, reason: str, now: float) -> None:
        self._disarm_timer(tx.id)
        tx.state = state
        tx.reason = reason
        tx.closed_at = now
        try:
            self.store.record(tx, now=now)
        except Exception:  # noqa: BLE001 — the audit must not mask the outcome
            log.exception("quota_failover: audit write failed for %s", tx.id)

    async def _commit(self, tx: Transaction, incident: Incident) -> None:
        """Move the credentials. Under the agent's switch_lock: re-read the
        active account and the epoch, re-list the pool's panes (a pane spawned
        after the prepare must not slip across the commit boundary), re-check
        the target can sign in, then swap. Never forces, never kills."""
        from . import app
        from .credential_vault import vault_to_thread
        from .usage_service import service
        from .ws_handlers import _running_login_terminals

        vault = app.credential_vault
        now = self._now()
        incident.state = "switching"
        incident.updated_at = now
        lock = vault.switch_lock(tx.agent_key)
        try:
            await asyncio.wait_for(lock.acquire(), timeout=10.0)
        except asyncio.TimeoutError:
            if tx.open:
                self._fail(tx, incident, "failed", "switch-lock-timeout", now)
            else:
                self._settle_stopped(incident, tx.reason or "switch-lock-timeout", now)
            return
        try:
            guard = getattr(vault, "require_store_mutation", None)
            if guard is not None:
                try:
                    await vault_to_thread(guard, tx.agent_key)
                except ValueError:
                    self._fail(tx, incident, "failed", "credential-store-unverified", now)
                    return
            # The wait for the lock (and every await below) is a window in
            # which the user may have cancelled, switched by hand or turned
            # auto off. Nothing here may revive a closed transaction.
            refused = self._recheck_locked(tx)
            if refused is not None:
                if tx.open:
                    self._fail(tx, incident, "cancelled", refused, now)
                else:
                    self._settle_stopped(incident, tx.reason or refused, now)
                return
            if tx.switch_mode != "hot":
                live = [
                    p for p in self._affected_terminals(tx.auth_scope)
                    if (p["paneId"] or p["termId"]) not in tx.overridden_panes
                ]
                known = {p["termId"] for p in tx.panes.values()}
                if any(p["termId"] not in known for p in live):
                    self._fail(tx, incident, "cancelled", "new-pane-during-prepare", now)
                    return
                if self._scope_unknown_panes(live):
                    self._fail(tx, incident, "cancelled", "pane-scope-unknown", now)
                    return
                if any(self._pane_busy(p["paneId"]) for p in live if p["paneId"]):
                    self._fail(tx, incident, "cancelled", "pane-became-busy", now)
                    return
            profile_to = self._profile(tx.agent_key, tx.to_slot_id)
            if tx.to_slot_id != DEFAULT_SLOT_ID:
                if _running_login_terminals(tx.agent_key, tx.to_slot_id):
                    self._fail(tx, incident, "cancelled", "login-pending", now)
                    return
                if await vault_to_thread(login_pending, vault, tx.agent_key, tx.to_slot_id):
                    try:
                        await vault_to_thread(
                            functools.partial(
                                vault.harvest_login_home, tx.agent_key, tx.to_slot_id,
                                **scope_kwargs(vault.harvest_login_home, tx.agent_key, profile_to),
                            )
                        )
                    except Exception as err:  # noqa: BLE001 — credentials untouched
                        self._fail(tx, incident, "failed", "login-harvest-failed", now, str(err))
                        return
            # The live credential must still be the outgoing account's: a
            # sign-in against the live store (a vendor with no login isolation)
            # replaces it, and capturing THAT into the outgoing slot would
            # destroy the outgoing account's only copy.
            drift = await vault_to_thread(
                live_drift, vault, tx.agent_key, tx.from_slot_id,
                scope_of(tx.agent_key, self._profile(tx.agent_key, tx.from_slot_id)),
            )
            assumed = False
            if drift == "unverifiable" and tx.assume_live_is_current:
                # The user's word applies to the payload they were shown: the
                # fingerprint from the refusal must still be the live one.
                current_fp = await vault_to_thread(
                    live_fingerprint, vault, tx.agent_key,
                    scope_of(tx.agent_key, self._profile(tx.agent_key, tx.from_slot_id)),
                )
                assumed = bool(current_fp) and current_fp == tx.assumed_fingerprint
            if drift == "drifted" or (drift == "unverifiable" and not assumed):
                # Who is live, for the notice (display identity only, never a
                # secret): the same record the manual route shows.
                try:
                    tx.live_identity = await vault_to_thread(vault.identity, tx.agent_key)
                except Exception:  # noqa: BLE001
                    tx.live_identity = None
                tx.live_fingerprint = await vault_to_thread(
                    live_fingerprint, vault, tx.agent_key,
                    scope_of(tx.agent_key, self._profile(tx.agent_key, tx.from_slot_id)),
                )
                self._fail(tx, incident, "cancelled",
                           "live-drift" if drift == "drifted" else "live-drift-unverified", now)
                return
            login_state = await vault_to_thread(self._login_state, tx.agent_key, tx.to_slot_id)
            if login_state != "ok" and (tx.automatic or login_state == "login-pending"):
                # Automatic never restores an account that cannot authenticate:
                # that signs the user out with nobody at the keyboard.
                self._fail(tx, incident, "cancelled", f"target-{login_state}", now)
                return
            switch_kwargs: dict[str, Any] = {}
            scope = tx.auth_scope.split(":", 1)[1] if ":" in tx.auth_scope else None
            if scope:
                try:
                    if "scope" in inspect.signature(vault.switch).parameters:
                        switch_kwargs["scope"] = scope
                except (TypeError, ValueError):
                    pass
            if tx.bound_to_candidates:
                # The ranking may have changed while we waited (a newer limit
                # message stamped the ledger, a login expired): re-verify the
                # target is still eligible before anything moves.
                try:
                    await self._require_eligible(tx.agent_key, tx.to_slot_id, allow_tried=True)
                except FailoverRefused as refused_err:
                    self._fail(tx, incident, "cancelled", refused_err.code.lower(), now)
                    return
            # Point of no return: the last await is behind us. Re-verify the
            # transaction is still wanted, then write the durable intent —
            # a swap that cannot be recorded is not attempted.
            refused = self._recheck_locked(tx)
            if refused is not None:
                if tx.open:
                    self._fail(tx, incident, "cancelled", refused, now)
                else:
                    self._settle_stopped(incident, tx.reason or refused, now)
                return
            tx.state = "swapping"
            try:
                self.store.record(tx, now=self._now())
            except Exception as err:  # noqa: BLE001 — nothing moved yet; refuse cleanly
                tx.state = "preparing"
                self._fail(tx, incident, "failed", "audit-write-failed", now, str(err))
                return
            try:
                await vault_to_thread(
                    functools.partial(
                        vault.switch, tx.agent_key, tx.from_slot_id, tx.to_slot_id, **switch_kwargs
                    )
                )
            except Exception as err:  # noqa: BLE001 — switch() rolled the live state back
                # The vault refuses a credential store it cannot account for
                # (copilot storeTokenPlaintext) before any write — name that
                # apart from a swap that failed midway. Neither retries.
                reason = "credential-source-unknown" if "storeTokenPlaintext" in str(err) else "swap-failed"
                self._fail(tx, incident, "failed", reason, now, str(err))
                return
            # Credentials moved: this counts, whatever the bookkeeping below does.
            tx.swapped = True
            tx.committed_at = self._now()
            tx.committed_monotonic = time.monotonic()
            self._last_commit_monotonic[tx.agent_key] = tx.committed_monotonic
            tx.epoch_after = self._bump_epoch(tx.agent_key)
            # Invalidate the usage poller's view while the lock is still held:
            # a read that started under the outgoing account must not be
            # filed as the incoming one's figure in the gap before the
            # announcement below.
            try:
                service.begin_switch_epoch(
                    tx.agent_key, None if tx.to_slot_id == DEFAULT_SLOT_ID else tx.to_slot_id,
                    reading=login_state == "ok",
                )
            except Exception:  # noqa: BLE001
                log.exception("quota_failover: usage epoch bump failed")
            try:
                app.cli_profiles_store.set_default(
                    tx.agent_key, None if tx.to_slot_id == DEFAULT_SLOT_ID else tx.to_slot_id
                )
                tx.state = "committed"
                tx.hot_switched_panes = self.rebind_hot_panes(tx.agent_key, tx.to_slot_id, tx.auth_scope)
            except Exception as err:  # noqa: BLE001 — live state moved; say so, do not roll back
                tx.state = "partial"
                tx.error = str(err)
                tx.reason = "default-persist-failed"
                self._note_unreconciled(tx)
                try:
                    tx.live_identity = await vault_to_thread(vault.identity, tx.agent_key)
                except Exception:  # noqa: BLE001
                    tx.live_identity = None
            try:
                self.store.record(tx, now=tx.committed_at)
                if self.audit_degraded:
                    self.audit_degraded = None
            except Exception as err:  # noqa: BLE001
                # The intent row stays as "swapping" and keeps counting. What
                # cannot be reconciled stops automatic switching (see
                # begin_switch) rather than being treated as a clean success.
                log.exception("quota_failover: audit write failed for %s", tx.id)
                tx.state = "partial"
                tx.reason = "audit-write-failed"
                tx.error = str(err)
                self.audit_degraded = str(err)
            incident.state = "settling"
            incident.reason = None if tx.state == "committed" else tx.reason
            incident.updated_at = tx.committed_at
            if login_state != "ok":
                tx.reason = f"target-{login_state}"
        finally:
            lock.release()
        await self._after_commit(tx, incident, login_state)

    def _recheck_locked(self, tx: Transaction) -> str | None:
        """Why the swap must not proceed, or None. Run under the switch lock,
        both right after acquiring it and again after the last await before
        the credentials move."""
        if not tx.open and tx.state != "swapping":
            return tx.reason or "cancelled"
        current = self._current_slot(tx.agent_key)
        if current != tx.from_slot_id or self.epoch(tx.agent_key) != tx.epoch_before:
            return "stale-state"
        if tx.automatic:
            if self.policy_mode() != "auto":
                return "policy-changed"
            if self.audit_degraded:
                return "auto_budget_unverifiable"
            if self._budget_retry_after(tx.agent_key, tx.auth_scope) > 0:
                return "auto_budget_exhausted"
        return None

    def _settle_stopped(self, incident: Incident, reason: str, now: float) -> None:
        """A transaction closed while its commit was waiting: the incident it
        left in "switching" must not keep saying so."""
        if incident.open and incident.state in ("detected", "waiting-safe", "switching"):
            incident.state = "notify-stopped"
            incident.reason = reason
            incident.updated_at = now

    def _fail(self, tx: Transaction, incident: Incident, state: str, reason: str,
              now: float, error: str | None = None) -> None:
        tx.error = error
        self._close_transaction(tx, state, reason, now)
        incident.state = "notify-stopped"
        incident.reason = reason
        incident.updated_at = now

    async def _after_commit(self, tx: Transaction, incident: Incident, login_state: str) -> None:
        from . import app
        from .ipc import make_event
        from .usage_service import service
        from .ws_handlers import _broadcast_profiles_changed

        try:
            await _broadcast_profiles_changed("set_default", agent_key=tx.agent_key, forced=False,
                                              hot_switched_panes=tx.hot_switched_panes)
        except Exception:  # noqa: BLE001
            log.exception("quota_failover: profiles broadcast failed")
        try:
            # The epoch and the pending mark were set inside the lock; this
            # only publishes them and queues the fresh read.
            await service.announce_switch(
                tx.agent_key, None if tx.to_slot_id == DEFAULT_SLOT_ID else tx.to_slot_id,
                reading=login_state == "ok", mark=False,
            )
        except Exception:  # noqa: BLE001
            log.exception("quota_failover: usage announcement failed")
        await app.broadcast(make_event("quota_failover.commit", {
            "transactionId": tx.id,
            "incidentId": incident.id,
            "agentKey": tx.agent_key,
            "authScope": tx.auth_scope,
            "fromSlotId": tx.from_slot_id,
            "toSlotId": tx.to_slot_id,
            "epoch": tx.epoch_after,
            "switchMode": tx.switch_mode,
            "restartStrategy": tx.restart_strategy,
            "state": tx.state,
            "hotSwitchedPanes": tx.hot_switched_panes,
            "needsLogin": login_state != "ok",
            "needsLoginReason": None if login_state == "ok" else login_state,
            "panes": [
                {"paneId": p["paneId"], "termId": p["termId"],
                 "agentKey": p["agentKey"], "workspacePath": p["workspacePath"]}
                for p in tx.panes.values()
            ],
        }))
        self._arm_timer(f"settle:{tx.id}", SETTLE_TIMEOUT_S)

    # ── settling ──────────────────────────────────────────────────────────

    def _restart_context(self, transaction_id: str, pane_id: str) -> tuple[Transaction, dict[str, Any]]:
        tx = self.transactions.get(transaction_id)
        if tx is None:
            raise FailoverRefused("NOT_FOUND", "unknown transaction")
        pane = tx.panes.get(pane_id)
        if (pane is None or tx.switch_mode != "restart" or not tx.swapped or tx.closed_at is not None
                or tx.state not in ("committed", "partial")
                or tx.state == "partial" and tx.reason != "resume-failed"):
            raise FailoverRefused("BAD_RESTART_PROOF", "no committed restart for this pane")
        if tx.epoch_after != self.epoch(tx.agent_key) or self._current_slot(tx.agent_key) != tx.to_slot_id:
            raise FailoverRefused("STALE_EPOCH", "the restart belongs to an earlier account switch")
        return tx, pane

    @staticmethod
    def _restart_provenance_matches(tx: Transaction, pane: dict[str, Any], agent_key: str,
                                    metadata: dict[str, Any]) -> bool:
        return (
            agent_key == pane["agentKey"]
            and metadata.get("workspace_path") == pane["workspacePath"]
            and metadata.get("auth_scope") == tx.auth_scope
            and metadata.get("credential_source") == "vault"
            and metadata.get("launch_profile_id") == tx.to_slot_id
            and metadata.get("credential_epoch") == tx.epoch_after
            and not metadata.get("login_profile_id")
            and QuotaFailoverService._store_matches(agent_key, metadata)
            and metadata.get("credential_store_id") == pane.get("credentialStoreId")
        )

    def validate_restart_spawn(self, transaction_id: str, pane_id: str, *, owner: Any,
                               agent_key: str, metadata: dict[str, Any]) -> None:
        """Validate a renderer's spawn claim while the credential lock is held."""
        tx, pane = self._restart_context(transaction_id, pane_id)
        if not tx.unsettled:
            raise FailoverRefused("BAD_RESTART_PROOF", "the restart has already settled")
        expected_owner = self._owner_of(pane["termId"]) or tx.restart_owners.get(pane_id)
        if owner is not expected_owner or not self._restart_provenance_matches(tx, pane, agent_key, metadata):
            raise FailoverRefused("BAD_RESTART_PROOF", "restart owner or credential provenance differs")
        previous_id = tx.restart_terms.get(pane_id)
        previous_owner = self._owner_of(previous_id) if previous_id else None
        previous = previous_owner.terminals.get(previous_id) if previous_owner is not None else None
        if previous is not None and not getattr(previous, "closed", False):
            raise FailoverRefused("BAD_RESTART_PROOF", "this pane already has a live restart")

    def record_restart_spawn(self, transaction_id: str, pane_id: str, term_id: str) -> None:
        tx = self.transactions[transaction_id]
        tx.restart_terms[pane_id] = term_id
        owner = self._owner_of(term_id)
        term = owner.terminals.get(term_id) if owner is not None else None
        if term is not None:
            tx.panes[pane_id].update(newPaneId=term.pane_id, newTermId=term_id, newSessionId="")
        if tx.state == "partial" and tx.reason == "resume-failed" and tx.panes[pane_id].get("settle") == "failed":
            tx.retry_requested = True

    def note_pty_owner(self, term_id: str, owner: Any) -> None:
        """Keep a verified PTY takeover after a reconnect, even if it is then killed."""
        if self._owner_of(term_id) is not owner or owner.terminals.get(term_id) is None:
            return
        for tx in self.transactions.values():
            if not tx.unsettled and not tx.open:
                continue
            for pane_id, pane in tx.panes.items():
                if term_id in (pane["termId"], tx.restart_terms.get(pane_id)):
                    tx.restart_owners[pane_id] = owner

    def _restart_proof(self, tx: Transaction, pane: dict[str, Any], payload: dict[str, Any],
                       owner: Any = None) -> tuple[str, str, str]:
        from . import app

        self._restart_context(tx.id, pane["paneId"])
        term_id = str(payload.get("term_id") or pane.get("newTermId") or "")
        actual_owner = self._owner_of(term_id)
        term = actual_owner.terminals.get(term_id) if actual_owner is not None else None
        if (term is None or getattr(term, "closed", False)
                or owner is not None and owner is not actual_owner
                or tx.committed_monotonic is None
                or float(getattr(term, "started_monotonic", 0) or 0) <= tx.committed_monotonic
                or not self._restart_provenance_matches(tx, pane, term.agent_key, term.metadata)):
            raise FailoverRefused("BAD_RESTART_PROOF", "PTY owner, start or credential provenance differs")
        new_pane_id = str(term.pane_id)
        if payload.get("new_pane_id") and str(payload["new_pane_id"]) != new_pane_id:
            raise FailoverRefused("BAD_RESTART_PROOF", "new pane does not own the PTY")
        if pane.get("newTermId") and pane["newTermId"] != term_id and pane.get("settle") != "failed":
            raise FailoverRefused("BAD_RESTART_PROOF", "restart PTY changed after settlement")
        claimed_tx = term.metadata.get("quota_transaction_id")
        if claimed_tx:
            if (claimed_tx != tx.id or term.metadata.get("quota_original_pane_id") != pane["paneId"]
                    or tx.restart_terms.get(pane["paneId"]) != term_id):
                raise FailoverRefused("BAD_RESTART_PROOF", "PTY belongs to another restart")
        elif tx.restart_strategy != "resume":
            raise FailoverRefused("BAD_RESTART_PROOF", "new conversation has no validated spawn claim")
        elif actual_owner is not (self._owner_of(pane["termId"]) or tx.restart_owners.get(pane["paneId"])):
            raise FailoverRefused("BAD_RESTART_PROOF", "legacy resume belongs to another owner")
        expected = str(pane.get("sessionId") or "") if tx.restart_strategy == "resume" else ""
        session_id = str(payload.get("session_id") or pane.get("newSessionId") or expected)
        if expected and session_id != expected:
            raise FailoverRefused("BAD_RESTART_PROOF", "resumed session differs from prepare")
        if expected or session_id:
            bound_pane, workspace, _stage = app.attribution.pane_for_session(session_id)
            if bound_pane != new_pane_id or workspace != pane["workspacePath"]:
                raise FailoverRefused("BAD_RESTART_PROOF", "session is not bound to the restarted pane")
        elif tx.restart_strategy == "resume":
            raise FailoverRefused("BAD_RESTART_PROOF", "expected resume session is missing")
        return new_pane_id, term_id, session_id

    async def settle(self, payload: dict[str, Any], *, owner: Any = None) -> Transaction:
        """Per-pane restart evidence from the renderer: ``resumed`` (with the
        session id it landed on), ``failed`` (with why), or ``turn-complete``
        (the pane finished a whole turn under the new account — the recovery
        evidence for a vendor with no quota API). A late turn from before the
        commit is not evidence: the activity stamp must be newer than the
        commit."""
        tx = self.transactions.get(str(payload.get("transaction_id") or ""))
        if tx is None:
            raise FailoverRefused("NOT_FOUND", "unknown transaction")
        if not tx.unsettled and tx.state not in ("committed", "partial"):
            raise FailoverRefused("BAD_STATE", f"transaction is {tx.state}")
        incident = self.incidents[tx.incident_id]
        pane_id = str(payload.get("pane_id") or "")
        outcome = str(payload.get("outcome") or "")
        now = self._now()
        pane = tx.panes.get(pane_id)
        if pane is None:
            raise FailoverRefused("BAD_REQUEST", f"pane {pane_id} is not part of this transaction")
        if outcome == "turn-complete":
            if self._turn_completed_after_commit(tx, pane, payload, owner=owner) and incident.open \
                    and incident.state == "settling" and tx.state == "committed" \
                    and self._restarts_settled(tx):
                self._close_incident(incident, "ready", "turn-complete", now)
                self._disarm_timer(f"settle:{tx.id}")
            await self._broadcast_changed()
            return tx
        if outcome not in ("resumed", "failed", "new-conversation"):
            raise FailoverRefused("BAD_REQUEST", f"unknown settle outcome: {outcome!r}")
        if outcome in ("resumed", "new-conversation"):
            if outcome != ("resumed" if tx.restart_strategy == "resume" else "new-conversation"):
                raise FailoverRefused("BAD_RESTART_PROOF", "outcome differs from the restart strategy")
            new_pane_id, term_id, session_id = self._restart_proof(tx, pane, payload, owner)
            pane.update(newPaneId=new_pane_id, newTermId=term_id, newSessionId=session_id)
        pane["settle"] = outcome
        pane["settleReason"] = str(payload.get("reason") or "") or None
        if outcome == "failed":
            tx.state = "partial"
            tx.reason = "resume-failed"
            if incident.open:
                self._close_incident(incident, "notify-stopped", "resume-failed", now)
            # The automatic recovery stopped; an explicit retry may still
            # restore this pane, and other panes must be able to report back.
            tx.closed_at = None
        elif tx.retry_requested and self._restarts_settled(tx):
            # Only a user-requested replacement of a failed pane reopens
            # recovery. Successful spawn/resume is not yet quota evidence.
            tx.state, tx.reason, tx.retry_requested = "committed", None, False
            tx.proof_after_at, tx.proof_after_monotonic = self._now(), time.monotonic()
            incident.state, incident.reason, incident.closed_at = "settling", None, None
            incident.updated_at = now
            self._arm_timer(f"settle:{tx.id}", SETTLE_TIMEOUT_S)
        try:
            self.store.record(tx, now=now)
        except Exception:  # noqa: BLE001
            log.exception("quota_failover: audit write failed for %s", tx.id)
        await self._broadcast_changed()
        return tx

    @staticmethod
    def _restarts_settled(tx: Transaction) -> bool:
        """For a restart transaction, every listed pane has reported a
        successful resume; a quota reading cannot paper over a pane that
        failed to come back or has not reported yet."""
        if tx.switch_mode == "hot":
            return True
        return all(p.get("settle") == "resumed" for p in tx.panes.values())

    def _turn_completed_after_commit(
        self, tx: Transaction, pane: dict[str, Any], payload: dict[str, Any], *, owner: Any = None
    ) -> bool:
        """Is this pane's turn evidence of the *new* account working?

        Restart vendors: the pane must have reported its resume, and the turn
        must come from the PTY started after the commit (its
        ``started_monotonic`` is later than the commit). Hot vendors keep
        their PTY, so the turn's own start — ``turn_started_monotonic`` in
        the backend's activity store, never a renderer-supplied stamp — must
        be later than the commit. In both cases the last recorded activity
        must be a turn_complete newer than the commit whose detail is not
        itself an exhaustion; a turn that began before the swap and finished
        after it is the old account's work."""
        from . import app

        if (tx.committed_monotonic is None or tx.committed_at is None
                or tx.epoch_after != self.epoch(tx.agent_key)
                or self._current_slot(tx.agent_key) != tx.to_slot_id):
            return False
        proof_after = tx.proof_after_monotonic or tx.committed_monotonic
        activity_pane = pane["paneId"]
        if tx.switch_mode == "restart":
            if pane.get("settle") != "resumed":
                return False
            try:
                activity_pane, _term_id, _session_id = self._restart_proof(tx, pane, payload, owner)
            except FailoverRefused:
                return False
        activity = app.pane_activity(activity_pane)
        if (
            activity is None or activity.get("event_type") != "turn_complete"
            or float(activity.get("ts_monotonic") or 0) <= proof_after
        ):
            return False
        detail = str(activity.get("detail") or "")
        if detail and any(p.search(detail) for p in quota_text_patterns(tx.agent_key)):
            # The turn ended because the account ran out — not a working one.
            return False
        if tx.switch_mode == "hot":
            # Backend-owned pairing: the activity store keeps when the turn
            # began (its first agent_active). A turn that began before the swap
            # and ended after it is the old account's work, whatever the
            # renderer says about it.
            started = activity.get("turn_started_monotonic")
            return started is not None and float(started) > proof_after
        if pane.get("settle") != "resumed":
            return False
        new_term_id = str(payload.get("term_id") or pane.get("newTermId") or "")
        owner = self._owner_of(new_term_id) if new_term_id else None
        term = owner.terminals.get(new_term_id) if owner is not None else None
        return (
            term is not None
            and float(getattr(term, "started_monotonic", 0.0) or 0.0) > tx.committed_monotonic
        )

    def observe_usage(self, agent_key: str, slot_id: str, snapshot: dict[str, Any]) -> None:
        """Called by the usage poller for every reading it *kept* (a reading
        whose account switched mid-read is dropped before this). Only a
        reading of the target slot taken after the commit settles an
        incident; a fresh headroom reading of the outgoing slot closes a
        notify-only incident as recovered."""
        if snapshot.get("status") != "ok":
            return
        fetched = _parse_iso(snapshot.get("fetchedAt"))
        if fetched is None:
            return
        now = self._now()
        changed = False
        # Only a positive reading counts: every binding window present, finite
        # and below 100 %, stamped fresh. Empty windows, an expired reading
        # still at 100 %, or a missing weekly window prove nothing — the
        # incident stays unverified until the settle timeout says so.
        tier, _headroom, _at = classify_candidate(snapshot, now=now)
        confirmed = tier == "fresh-headroom"
        exhausted = snapshot_exhausted(snapshot, now)
        for incident in list(self.incidents.values()):
            if not incident.open or incident.agent_key != agent_key:
                continue
            if incident.state == "settling":
                tx = next(
                    (self.transactions[t] for t in reversed(incident.transaction_ids)
                     if t in self.transactions and self.transactions[t].swapped),
                    None,
                )
                if tx is None or slot_id != tx.to_slot_id or tx.committed_at is None:
                    continue
                if (fetched <= (tx.proof_after_at or tx.committed_at)
                        or tx.epoch_after != self.epoch(agent_key)
                        or self._current_slot(agent_key) != tx.to_slot_id):
                    continue
                if exhausted:
                    self._close_incident(incident, "notify-stopped", "target-exhausted", now)
                elif (
                    confirmed and tx.state == "committed" and self._restarts_settled(tx)
                    and capability(agent_key).get("hasIdentity", True)
                ):
                    # A vendor whose credential names no account cannot prove
                    # the reading is the target's; it stays unconfirmed until
                    # the settle timeout says so.
                    self._close_incident(incident, "ready", "quota-confirmed", now)
                else:
                    continue
                self._disarm_timer(f"settle:{tx.id}")
                changed = True
            elif slot_id == incident.outgoing_slot_id and fetched > incident.detected_at:
                if confirmed and incident.state in (
                    "detected", "notify-stopped"
                ) and not any(
                    self.transactions[t].swapped for t in incident.transaction_ids
                    if t in self.transactions
                ):
                    self._close_incident(incident, "ready", "outgoing-recovered", now)
                    changed = True
        if changed:
            self._schedule_broadcast()

    # ── manual route hook ─────────────────────────────────────────────────

    async def on_manual_switch(self, agent_key: str, to_slot_id: str | None) -> None:
        """``cli_profiles.set_default`` succeeded outside this module: the
        user took over. Pending automatic proposals for the agent are
        withdrawn and the epoch moves, so a stale proposal cannot commit
        later against the account the user chose."""
        now = self._now()
        self._bump_epoch(agent_key)
        for tx in list(self.transactions.values()):
            if tx.agent_key == agent_key and tx.open:
                self._withdraw(tx, "manual-switch", now)
        for incident in self.incidents.values():
            if incident.open and incident.agent_key == agent_key and incident.state in (
                "waiting-safe", "switching", "detected",
            ):
                incident.state = "notify-stopped"
                incident.reason = "manual-switch"
                incident.updated_at = now
        await self._broadcast_changed()

    # ── timers ────────────────────────────────────────────────────────────

    def _arm_timer(self, key: str, delay: float) -> None:
        self._disarm_timer(key)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._timers[key] = loop.call_later(
            delay, lambda: asyncio.ensure_future(self._on_timer(key))
        )

    def _disarm_timer(self, key: str) -> None:
        handle = self._timers.pop(key, None)
        if handle is not None:
            handle.cancel()

    async def _on_timer(self, key: str) -> None:
        self._timers.pop(key, None)
        await self.tick(key)

    def _schedule_broadcast(self) -> None:
        try:
            asyncio.get_running_loop().create_task(self._broadcast_changed())
        except RuntimeError:
            pass

    async def tick(self, key: str) -> None:
        """Deadline handling, also callable directly by tests. ``key`` is a
        transaction id (prepare / waiting-safe deadline) or ``settle:<id>``."""
        now = self._now()
        if key.startswith("settle:"):
            tx = self.transactions.get(key[len("settle:"):])
            if tx is None:
                return
            incident = self.incidents.get(tx.incident_id)
            if incident is not None and incident.open and incident.state == "settling":
                self._close_incident(incident, "notify-stopped", "quota-unconfirmed", now)
                await self._broadcast_changed()
            return
        tx = self.transactions.get(key)
        if tx is None or not tx.open:
            return
        incident = self.incidents.get(tx.incident_id)
        if tx.state == "preparing":
            reason = "prepare-timeout"
        elif tx.state == "waiting-safe":
            reason = "wait-timeout"
        else:
            return
        self._close_transaction(tx, "cancelled", reason, now)
        if incident is not None and incident.open:
            incident.state = "notify-stopped"
            incident.reason = reason
            incident.updated_at = now
        await self._broadcast_changed()
