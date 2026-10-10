"""Per-CLI quota/usage monitor (CodexBar-style).

Reads the credentials each CLI already stores locally and calls that
provider's own usage surface — no login flow, no credential writes:

- claude: no request from here at all — the CLI's own ``/usage`` panel is
  read instead, so Claude Code asks under its own identity
  (see :mod:`claude_cli_usage`). ``api/oauth/usage`` is still reached for the
  Anthropic OAuth grants that opencode and pi keep in their own auth files,
  where there is no vendor CLI to delegate to.
- codex:  ``$CODEX_HOME/auth.json`` -> ``GET <base>/wham/usage``
  (base from ``config.toml`` ``chatgpt_base_url``, default chatgpt.com)
- kimi:   ``~/.kimi-code/credentials/kimi-code.json`` ->
  ``GET https://api.kimi.com/coding/v1/usages``
- grok:   ``~/.grok/auth.json`` + ``grok agent stdio`` JSON-RPC
  method ``x.ai/billing``
- antigravity: refresh token from macOS Keychain ``gemini``/``antigravity``
  (stale-file fallback ``~/.gemini/antigravity-cli/antigravity-oauth-token``)
  -> in-memory Google OAuth refresh ->
  ``POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary``.
  Minting the token needs Antigravity's OAuth client credentials, which this
  app neither ships nor stores: set NAVIDE_ANTIGRAVITY_CLIENT_ID/_SECRET to
  enable the quota read. Unset, the account still reports as signed in.
- opencode: ``~/.local/share/opencode/auth.json`` is an aggregator (a map of
  providerID -> credential); each supported entry is mapped to that
  provider's own usage endpoint: ``minimax-coding-plan`` ->
  ``GET https://api.minimax.io/v1/token_plan/remains``; ``anthropic`` oauth
  reuses the Claude flow. opencode Zen and plain BYOK API keys expose no
  usage surface -> unavailable.
- qwen: Alibaba ModelStudio Coding Plan API key (``sk-sp-...``) from the
  process env (``BAILIAN_CODING_PLAN_API_KEY`` + CodexBar's aliases),
  ``~/.qwen/.env`` or the ``env`` block of ``~/.qwen/settings.json`` ->
  ``POST <console gateway>/data/api.json queryCodingPlanInstanceInfoV2``
  (international region first, China-mainland retry). The key is what the
  gateway authenticates; the browser User-Agent this once sent is gone, while
  Origin/Referer stay because the gateway refuses cross-site posts without
  them. The legacy Qwen OAuth file has no usage API (free tier discontinued).
- kilo: ``~/.local/share/kilo/auth.json`` (the ``kilo`` entry: api key, or the
  long-lived oauth access token + accountId org; legacy fallback
  ``~/.kilocode/cli/config.json``) ->
  ``GET https://api.kilo.ai/api/profile/balance`` (prepaid credit balance) +
  best-effort ``GET /api/trpc/kiloPass.getState`` (Kilo Pass period usage).
- pi: ``~/.pi/agent/auth.json`` (root overridable via ``PI_CODING_AGENT_DIR``)
  is an aggregator (a map of provider id -> credential); pi has no server of
  its own, so each supported entry is mapped to that provider's own usage
  endpoint: ``anthropic`` oauth reuses the Claude flow (pi's OAuth uses Claude
  Code's client id, so the token is interchangeable), ``openai-codex`` oauth
  -> ChatGPT ``wham/usage``, ``openrouter`` ->
  ``GET https://openrouter.ai/api/v1/key`` (credit usage). Plain BYOK API
  keys and github-copilot/xai/radius expose no usage surface -> unavailable.
- copilot: ``~/.copilot/config.json`` (JSONC) names the signed-in GitHub
  account; the CLI's own OAuth token lives in the macOS Keychain (not probed),
  so the token is read via ``gh auth token -u <login>`` (fallbacks: the
  VS Code-style ``~/.config/github-copilot/{apps,hosts}.json`` oauth_token,
  then ``GH_TOKEN``/``GITHUB_TOKEN`` env)
  -> ``GET https://api.<host>/copilot_internal/user``, identified as Navide
  (the VS Code extension headers it once sent turned out not to be required).
- cursor: session JWT from the macOS Keychain generic password
  ``cursor-access-token`` (cursor-agent CLI; fallback: the Cursor IDE's
  ``~/Library/Application Support/Cursor/User/globalStorage/state.vscdb``
  sqlite row ``cursorAuth/accessToken``) ->
  ``GET https://cursor.com/api/usage-summary``. The only provider here that
  still needs a browser-shaped credential: the endpoint authenticates a
  signed-in cursor.com session, so the JWT is presented as that site's own
  ``WorkosCursorSessionToken`` cookie (Bearer returns 401).

Every credential file is read-only here; token refresh is left to the CLI
that owns the file (refreshing ourselves would rotate the CLI's tokens).
antigravity is the one exception: Google's refresh grant returns no new
refresh token (verified), so a fresh access token is minted in memory
without rotating anything the CLI owns.
Snapshots are normalized to one shape so the frontend never sees provider
quirks (epoch seconds, used/limit ratios, cent amounts are converted here):

    { provider, status: ok|no-credentials|expired|rate-limited|unavailable|
                        cli-missing|not-measured|unverified|error,
      planType, windows: [{ kind, label, usedPercent, resetsAt }], fetchedAt,
      error }

A single background poller serves every window (broadcast via
``usage.changed``); per-provider 429 cooldowns respect ``Retry-After`` and a
reset-boundary refresh re-polls shortly after a window's ``resetsAt`` passes.
"""

from __future__ import annotations

import asyncio
import base64
import copy
import functools
import json
import logging
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .applog import app_data_dir
from .osplat import secret_files
from .cli_vendors.registry import VENDORS as _CLI_VENDORS
from .cli_vendors.registry import vendor as _cli_vendor
from .credential_store import StoreUnverified
from .credential_vault import vault_to_thread

log = logging.getLogger(__name__)

# How long a `/usage` panel reading stands before the CLI is asked again. The
# read costs a full Claude Code start, so it deliberately does not follow the
# poll interval; the badge's refresh button clears it via `request_refresh`.
CLAUDE_CLI_READ_INTERVAL = 900.0
# Claude OAuth tokens are never minted here. Anthropic rotates refresh tokens,
# so every exchange invalidates the previous one: whenever this app refreshed a
# credential the CLI also owns, one of the two ended up holding a dead token and
# the account had to be signed in again. The CLI is the only refresher — a
# parked slot's access token is simply allowed to expire, and Claude Code
# renews it from the restored refresh token the first time it runs.
# cursor (Cursor / cursor-agent CLI). The session JWT the CLI stores in the
# macOS Keychain (fallback: the Cursor IDE's state.vscdb sqlite row) is still
# read to detect sign-in and local expiry, and to authenticate usage-summary by
# rebuilding cursor.com's own WorkosCursorSessionToken cookie. Unofficial but
# stable, and the only form that answers: the legacy Bearer endpoint returns
# null limits on dollar-based plans, and Bearer against usage-summary itself
# returns 401 (measured 2026-08-05).
CURSOR_KEYCHAIN_SERVICE = "cursor-access-token"
CURSOR_IDE_TOKEN_KEY = "cursorAuth/accessToken"
CURSOR_USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary"
RESET_BOUNDARY_GRACE = 30.0
DEFAULT_INTERVAL = 300.0
MIN_INTERVAL = 60.0
USAGE_CACHE_FILE = "usage-cache.json"
USAGE_CACHE_SCHEMA_VERSION = 1


# Snapshot plumbing lives in usage_common (importable by vendor modules);
# re-exported here so this module's namespace is unchanged for callers/tests.
from .usage_common import (  # noqa: E402,F401
    communicate_or_kill as _communicate_or_kill,
    HTTP_TIMEOUT,
    RATE_LIMIT_COOLDOWN,
    _clamp_pct,
    _epoch_to_iso,
    _now_iso,
    _num,
    _snapshot,
    _window,
    parse_retry_after,
)

# R2: qwen's usage stack moved to its vendor module; re-exported so this
# module's namespace (and its tests) keep working until the cleanup round.
from .cli_vendors.claude import (  # noqa: E402,F401
    CLAUDE_KEYCHAIN_SERVICE,
    fetch_claude,
    fetch_claude_account_dir,
    parse_claude_credentials,
    read_claude_credentials,
    read_claude_credentials_file,
)
from .cli_vendors.codex import (  # noqa: E402,F401
    codex_base_url,
    fetch_codex,
    read_codex_credentials,
)
from .cli_vendors.kimi import (  # noqa: E402,F401
    KIMI_DEFAULT_BASE,
    fetch_kimi,
    normalize_kimi,
    read_kimi_credentials,
)
from .cli_vendors.grok import (  # noqa: E402,F401
    GROK_BILLING_TIMEOUT,
    GROK_INIT_TIMEOUT,
    fetch_grok,
    grok_billing_rpc,
    normalize_grok,
    read_grok_credentials,
)
from .cli_vendors.pi import (  # noqa: E402,F401
    PI_AGENT_DIR_ENV,
    PI_OPENROUTER_KEY_URL,
    fetch_pi,
    normalize_pi_openrouter,
    pi_anthropic_oauth,
    pi_codex_oauth,
    pi_oauth_expired,
    pi_openrouter_key,
    read_pi_credentials,
)
from .cli_vendors.kilo import (  # noqa: E402,F401
    KILO_AUTH_FILE_REL,
    KILO_BALANCE_PATH,
    KILO_DEFAULT_BASE,
    KILO_LEGACY_CONFIG_REL,
    KILO_PASS_PATH,
    fetch_kilo,
    kilo_base_url,
    kilo_pass_subscription,
    normalize_kilo_balance,
    normalize_kilo_pass,
    read_kilo_credentials,
)
from .cli_vendors.opencode import (  # noqa: E402,F401
    OPENCODE_AUTH_FILE_REL,
    OPENCODE_MINIMAX_USAGE_URL,
    fetch_opencode,
    normalize_opencode_minimax,
    opencode_anthropic_oauth,
    opencode_minimax_key,
    read_opencode_credentials,
)
from .cli_vendors._protocols import (  # noqa: E402,F401
    CODEX_DEFAULT_BASE,
    _codex_credits,
    _codex_extra_windows,
    codex_usage_url,
    normalize_codex,
    CLAUDE_BETA_HEADER,
    CLAUDE_USAGE_URL,
    claude_token_expired,
    fetch_claude_oauth,
    normalize_claude,
)
from .cli_vendors.antigravity import (  # noqa: E402,F401
    _antigravity_refresh_token,
    ANTIGRAVITY_CLIENT_ID,
    ANTIGRAVITY_CLIENT_SECRET,
    ANTIGRAVITY_KEYCHAIN_ACCOUNT,
    ANTIGRAVITY_KEYCHAIN_SERVICE,
    ANTIGRAVITY_LOAD_URL,
    ANTIGRAVITY_QUOTA_URL,
    ANTIGRAVITY_TOKEN_FILE_REL,
    ANTIGRAVITY_TOKEN_URL,
    antigravity_plan,
    antigravity_project,
    fetch_antigravity,
    normalize_antigravity,
    read_antigravity_credentials,
    read_antigravity_credentials_file,
    refresh_antigravity_token,
)
from .cli_vendors.copilot import (  # noqa: E402,F401
    COPILOT_CONFIG_FILE_REL,
    COPILOT_DEFAULT_HOST,
    COPILOT_ENV_KEYS,
    COPILOT_HOSTS_FILES_REL,
    copilot_env_token,
    copilot_usage_url,
    fetch_copilot,
    normalize_copilot,
    read_copilot_config,
    read_copilot_hosts_token,
)
from .cli_vendors.cursor import (  # noqa: E402,F401
    CURSOR_IDE_STATE_DB_SUFFIX,
    CURSOR_IDE_TOKEN_KEY,
    cursor_ide_state_db_path,
    CURSOR_KEYCHAIN_SERVICE,
    CURSOR_USAGE_SUMMARY_URL,
    cursor_token_expired,
    cursor_user_id,
    fetch_cursor,
    normalize_cursor,
    read_cursor_credentials,
    read_cursor_ide_token,
)
from .cli_vendors.qwen import (  # noqa: E402,F401
    QWEN_CN_USAGE_URL,
    QWEN_ENV_KEYS,
    QWEN_INTL_USAGE_URL,
    QWEN_REGIONS,
    fetch_qwen,
    normalize_qwen,
    qwen_legacy_oauth_present,
    read_qwen_credentials,
)


# ── Credential readers (pure; ``home`` injectable for tests) ────────────────

# ── Poller service ──────────────────────────────────────────────────────────

def _get_profiles_store():
    """The app-wide CLI profiles store, or ``None`` when unavailable (unit
    tests, early startup). Isolated behind a function so tests can stub profile
    resolution without importing the whole app."""
    try:
        from . import app
        return app.cli_profiles_store
    except Exception:  # noqa: BLE001
        return None


def _get_credential_vault():
    """The app-wide credential vault, or ``None`` when unavailable (unit
    tests, early startup)."""
    try:
        from . import app
        return app.credential_vault
    except Exception:  # noqa: BLE001
        return None


# ── Login watch ─────────────────────────────────────────────────────────────
# A login pane just spawned into a profile's isolated login home. Poll that
# home on a short interval so the account row flips to signed-in the moment
# the browser authorization completes, instead of waiting for the next usage
# poll. Reuses the poller's switch lock + harvest; an abandoned login (pane
# closed, never authorized) simply times out and leaves the login home in
# place for the next attempt.

LOGIN_WATCH_INTERVAL_SEC = 2.0
LOGIN_WATCH_TIMEOUT_SEC = 600.0

_login_watches: dict[tuple[str, str], asyncio.Task] = {}


def _login_pending(vault, agent_key: str, profile_id: str) -> bool:
    """Is a sign-in for this profile started and not yet harvested? The
    vault's ``login_pending`` covers both shapes — an isolated login home that
    still exists, and a non-isolated sign-in whose pre-login snapshot is still
    parked. A vault without the predicate (an older fake) is read the old
    way, by the login home alone."""
    pending = getattr(vault, "login_pending", None)
    if callable(pending):
        return bool(pending(agent_key, profile_id))
    return vault.login_home_path(agent_key, profile_id).is_dir()


def _login_pane_running(agent_key: str, profile_id: str) -> bool:
    """True while the profile's isolated login pane still runs its CLI.
    Harvesting under a running login CLI is unsafe: the CLI can rotate its
    OAuth token after the snapshot (invalidating the harvested refresh token)
    and loses its config home mid-run. False when the ws layer is unavailable
    (unit tests, early startup)."""
    try:
        from .ws_handlers import _running_login_terminals

        return bool(_running_login_terminals(agent_key, profile_id))
    except Exception:  # noqa: BLE001
        return False


def _active_profile_id(agent_key: str) -> str | None:
    store = _get_profiles_store()
    if store is None:
        return None
    try:
        return store.list()["defaults"].get(agent_key)
    except Exception:  # noqa: BLE001
        return None


def _duplicate_account_profile(vault, store, agent_key: str, profile_id: str) -> str | None:
    """Another profile of ``agent_key`` whose slot snapshot holds the same
    account as ``profile_id``'s slot, or None when there is no such profile.

    The identity is display-only and not always readable: kimi has no identity
    field at all, and a claude long-lived-token login carries no oauthAccount.
    An account that cannot be named matches nothing — merging two logins on a
    guess would destroy a profile the user still needs. Blocking reads."""
    from .credential_watcher import _norm_email

    email = _norm_email(vault.identity(agent_key, profile_id).get("email"))
    if email is None:
        return None
    for profile in store.list()["profiles"]:
        other_id = str(profile.get("id") or "")
        if not other_id or other_id == profile_id or profile.get("agentKey") != agent_key:
            continue
        if _norm_email(vault.identity(agent_key, other_id).get("email")) == email:
            return other_id
    return None


def _dedupe_harvested_login(vault, agent_key: str, profile_id: str) -> str | None:
    """Fold a just-harvested login into the profile that already holds that
    account and drop the duplicate ``profile_id`` was created for. Returns the
    surviving profile id, or None when nothing was folded.

    ``cli_profiles.create`` only enforces a unique id, so signing into an
    account a profile already exists for leaves two slots holding the same
    login. The fresh login wins over the survivor's older snapshot.

    Ordering is load-bearing: the ledger pointer moves BEFORE the delete
    (``CliProfilesStore.delete`` nulls a default that names the deleted
    profile), and the slot secrets go before the store archives the slot dir,
    or claude's Keychain slot item is stranded forever. Blocking; call inside
    ``switch_lock(agent_key)``."""
    store = _get_profiles_store()
    if store is None:
        return None
    keep_id = _duplicate_account_profile(vault, store, agent_key, profile_id)
    if keep_id is None:
        return None
    vault.write_slot(agent_key, keep_id, vault.read_slot(agent_key, profile_id))
    if store.list()["defaults"].get(agent_key) == profile_id:
        store.set_default(agent_key, keep_id)
    vault.delete_slot_secrets(agent_key, profile_id)
    store.delete(profile_id)
    log.info(
        "%s login duplicated profile %s; merged into existing profile %s",
        agent_key, profile_id, keep_id,
    )
    return keep_id


def _scope_kwargs(fn, agent_key: str, profile_id: str) -> dict:
    """``{"scope": <provider>}`` for a vault call about a per-provider
    vendor's profile, ``{}`` for whole-file vendors — and ``{}`` for a vault
    (a test fake) whose method takes no ``scope``."""
    import inspect

    try:
        if "scope" not in inspect.signature(fn).parameters:
            return {}
    except (TypeError, ValueError):
        return {}
    store = _get_profiles_store()
    profile = store.get(profile_id) if store is not None else None
    from .quota_failover import profile_scope

    scope = profile_scope(agent_key, profile)
    return {"scope": scope} if scope else {}


def _login_against_live_store(vault, agent_key: str) -> bool:
    """Does this vendor's sign-in rewrite the live credential store (no
    login isolation)? False when the vault cannot say."""
    isolated = getattr(vault, "_login_isolated", None)
    try:
        return callable(isolated) and not isolated(agent_key)
    except Exception:  # noqa: BLE001
        return False


async def _discard_pending_login_locked(vault, agent_key: str, profile_id: str) -> bool:
    """Abandon a sign-in that never completed (``vault.discard_pending_login``
    under the agent's switch lock). False when the vault has nothing to
    discard or no such method."""
    discard = getattr(vault, "discard_pending_login", None)
    if not callable(discard):
        return False
    async with vault.switch_lock(agent_key):
        return bool(await vault_to_thread(
            functools.partial(discard, agent_key, profile_id,
                              **_scope_kwargs(discard, agent_key, profile_id))
        ))


async def _harvest_login_home_locked(vault, agent_key: str, profile_id: str) -> bool:
    """Harvest the profile's pending login home under the agent's switch lock.
    Skipped (False) while the profile's login pane CLI is still running. When
    the harvested profile is the ACTIVE account, the slot is immediately
    restored to live — the active row's identity is read from the live state,
    and the next capture() mirrors live into the slot, which would otherwise
    erase the fresh login. A login that landed in a profile created for it and
    turns out to be an account another profile already holds is folded into
    that profile (see ``_dedupe_harvested_login``). Returns True when something
    was harvested."""
    if _login_pane_running(agent_key, profile_id):
        return False
    followed = None
    async with vault.switch_lock(agent_key):
        # Read before the harvest fills it: an empty slot is what tells the
        # de-duplication that this profile was created for this login. Signing
        # back into a profile that already had credentials is the user
        # re-logging a slot they arranged themselves — never ours to remove.
        slot_was_empty = await vault_to_thread(
            functools.partial(
                vault.slot_is_empty, agent_key, profile_id,
                **_scope_kwargs(vault.slot_is_empty, agent_key, profile_id),
            )
        )
        # The slot's secret before the harvest replaces it: a live login
        # without an identity that still carries it is this account's own.
        slot_before = None if slot_was_empty else await vault_to_thread(
            _slot_secret, vault, agent_key, profile_id
        )
        # A sign-in against the live store (no login isolation) puts the
        # login it replaced back live: that copy is this account's own.
        pre_login = await vault_to_thread(_pre_login_secret, vault, agent_key, profile_id)
        harvested = await vault_to_thread(
            functools.partial(
                vault.harvest_login_home, agent_key, profile_id,
                **_scope_kwargs(vault.harvest_login_home, agent_key, profile_id),
            )
        )
        if not harvested:
            return False
        slot_id = profile_id
        if slot_was_empty:
            try:
                slot_id = await vault_to_thread(
                    _dedupe_harvested_login, vault, agent_key, profile_id
                ) or profile_id
            except Exception as err:  # noqa: BLE001 — both profiles stay usable
                log.warning("de-duplicating the %s login failed: %s", agent_key, err)
        if _active_profile_id(agent_key) == slot_id:
            # The convenience feature credentials.auto-repair (D7): announced,
            # skipped when off, and never over an account the user signed
            # into outside Navide — that becomes a prompt.
            from .convenience_wiring import repair_live_login

            try:
                live_email, slot_email, other = await vault_to_thread(
                    _compare_live_to_slot, vault, agent_key, slot_id, slot_before, pre_login
                )
            except Exception as err:  # noqa: BLE001 — unread is not signed out
                log.warning(
                    "reading the live %s login failed; left it as is: %s", agent_key, err
                )
                return True
            fingerprint = await vault_to_thread(
                _live_fingerprint, vault, agent_key, slot_id
            ) if other else ""
            written = await vault_to_thread(functools.partial(
                repair_live_login, agent_key, slot_id,
                functools.partial(
                    vault.restore, agent_key, slot_id,
                    **_scope_kwargs(vault.restore, agent_key, slot_id),
                ),
                reason="signed in through Navide",
                live_email=live_email, slot_email=slot_email,
                slot_label=_profile_name(slot_id), other_account=other,
                live_fingerprint=fingerprint, requested=True,
            ))
            if other and not written:
                # Navide's active account must follow the login that stays
                # live, or the next switch captures it into this slot.
                followed = await vault_to_thread(
                    _follow_live_account, agent_key, slot_id, live_email,
                    _scope_kwargs(vault.identity, agent_key, slot_id).get("scope"),
                )
    if followed is not None:
        from .ws_handlers import _broadcast_profiles_changed

        try:
            await _broadcast_profiles_changed("live_credentials", agent_key=agent_key, forced=False)
        except Exception as err:  # noqa: BLE001 — the ledger already moved
            log.warning("announcing the realigned %s account failed: %s", agent_key, err)
    return True


def _slot_secret(vault, agent_key: str, slot_id: str) -> str | None:
    """A slot's secret, None when unreadable. Blocking."""
    try:
        return vault.read_slot(
            agent_key, slot_id, **_scope_kwargs(vault.read_slot, agent_key, slot_id)
        ).secret
    except Exception:  # noqa: BLE001 — no proof the live login is this account's
        return None


def _live_fingerprint(vault, agent_key: str, slot_id: str) -> str:
    """``login_fingerprint`` of the live login in ``slot_id``'s scope; ''
    when it cannot be read. Blocking."""
    from .convenience_wiring import login_fingerprint

    try:
        live = vault.read_live(
            agent_key, strict=True, **_scope_kwargs(vault.read_live, agent_key, slot_id)
        )
    except Exception:  # noqa: BLE001 — the switch-back then refuses, never guesses
        return ""
    return login_fingerprint(live.secret)


def _pre_login_secret(vault, agent_key: str, slot_id: str) -> str | None:
    """The live secret a sign-in against the live store replaced (its
    pre-login snapshot), None when there is none. Blocking."""
    snapshot = getattr(vault, "_pre_login_snapshot", None)
    if not callable(snapshot):
        return None
    try:
        present, before, _scope = snapshot(agent_key, slot_id)
    except Exception:  # noqa: BLE001 — no proof the live login is this account's
        return None
    return before if present else None


def _compare_live_to_slot(
    vault, agent_key: str, slot_id: str, slot_before: str | None,
    pre_login: str | None = None,
) -> tuple[str | None, str | None, bool]:
    """``(live email, slot email, other account)``: is the live login an
    account other than ``slot_id``'s? Emails decide when both are known.
    With neither one (kimi, the per-provider stores) nothing can tell an
    account apart, so it is the same account and the login is restored, as
    before the prompt existed. With one, only the slot's own secret (now,
    before the harvest, or the pre-login copy a live-store sign-in put back)
    proves it is the same account. An empty live login is no other account.
    Raises when the live login cannot be read. Blocking (Keychain for
    claude)."""
    kw = _scope_kwargs(vault.identity, agent_key, slot_id)
    live = vault.identity(agent_key, strict=True, **kw)
    if not live.get("signedIn"):
        return None, None, False
    slot_email = vault.identity(agent_key, slot_id, **kw).get("email") or None
    live_email = live.get("email") or None
    if live_email and slot_email:
        return live_email, slot_email, live_email.casefold() != slot_email.casefold()
    if not live_email and not slot_email:
        return None, None, False
    kw = _scope_kwargs(vault.read_live, agent_key, slot_id)
    live_secret = vault.read_live(agent_key, strict=True, **kw).secret
    own = {_slot_secret(vault, agent_key, slot_id), slot_before, pre_login} - {None}
    return live_email, slot_email, live_secret not in own


def _profile_name(profile_id: str) -> str:
    store = _get_profiles_store()
    try:
        profile = store.get(profile_id) if store is not None else None
    except Exception:  # noqa: BLE001 — the prompt falls back to the email
        return ""
    return str((profile or {}).get("name") or "")


def _follow_live_account(
    agent_key: str, slot_id: str, live_email: str | None, scope: str | None = None
) -> str | None:
    """Point Navide's active account at the live login after a prompt left
    it live: the profile holding it (by email, else by its exact secret),
    else a new one registered for it in ``scope`` (see
    ``credential_watcher``). Never writes the live login. Call inside
    ``switch_lock``. Blocking."""
    from .credential_watcher import (
        _adopt_unregistered_live_account,
        align_default_to_live,
        point_at_profile_holding_live,
    )

    try:
        moved = align_default_to_live(agent_key, scope=scope)
        if moved is None and _active_profile_id(agent_key) == slot_id and not live_email:
            moved = point_at_profile_holding_live(agent_key, scope=scope)
        if moved is None and _active_profile_id(agent_key) == slot_id:
            moved = _adopt_unregistered_live_account(
                agent_key, live_email or "Signed in outside Navide", scope=scope
            )
    except Exception as err:  # noqa: BLE001
        log.warning("following the live %s account failed: %s", agent_key, err)
        return None
    return moved


async def _harvest_pending_login_homes(store, vault) -> list[str]:
    """Harvest every profile's pending isolated login home (skipping profiles
    whose login pane CLI still runs). Best effort — per-profile failures are
    silent. Returns the profile ids that were harvested."""
    try:
        profiles = store.list()["profiles"]
    except Exception:  # noqa: BLE001
        return []
    harvested_ids: list[str] = []
    for profile in profiles:
        agent_key = str(profile.get("agentKey") or "")
        profile_id = str(profile.get("id") or "")
        if not agent_key or not profile_id:
            continue
        try:
            # Cheap pre-check outside the lock: most profiles have no
            # pending sign-in.
            if not _login_pending(vault, agent_key, profile_id):
                continue
            if await _harvest_login_home_locked(vault, agent_key, profile_id):
                harvested_ids.append(profile_id)
        except Exception:  # noqa: BLE001
            pass
    return harvested_ids


async def sweep_pending_login_homes() -> None:
    """One-shot sweep of leftover isolated login homes, independent of the
    usage poller (which also harvests, but only while usage polling is
    enabled). A login that completed right before a backend restart would
    otherwise stay unharvested forever with usage disabled. Called from the
    app startup hook as a background task."""
    store = _get_profiles_store()
    vault = _get_credential_vault()
    if store is None or vault is None:
        return
    harvested_ids = await _harvest_pending_login_homes(store, vault)
    if harvested_ids:
        try:
            from .ws_handlers import _broadcast_profiles_changed

            await _broadcast_profiles_changed(
                "login-harvest", harvested_profile_ids=harvested_ids
            )
        except Exception:  # noqa: BLE001
            pass


def start_login_watch(agent_key: str, profile_id: str) -> None:
    """Begin the harvest watch for one profile's login home (idempotent while
    a watch for the same profile is still running)."""
    key = (agent_key, profile_id)
    task = _login_watches.get(key)
    if task is not None and not task.done():
        return
    task = asyncio.create_task(_login_watch(agent_key, profile_id))
    _login_watches[key] = task
    task.add_done_callback(
        lambda t, key=key: _login_watches.pop(key, None)
        if _login_watches.get(key) is t
        else None
    )


async def _kill_completed_login_panes(agent_key: str, profile_id: str) -> None:
    """Kill the profile's still-running login pane once its sign-in secret
    exists. claude/codex/kimi sign-in commands exit on completion, but grok's
    TUI keeps running after auth and would defer the harvest until the user
    closes the pane. The pane is disposable — kill it through the standard
    terminals kill path; the harvest then proceeds on a later check."""
    try:
        from .ws_handlers import _running_login_terminals

        panes = _running_login_terminals(agent_key, profile_id)
    except Exception:  # noqa: BLE001
        return
    for tid, owner in panes:
        try:
            await owner.terminals.kill(tid, force=True)
        except Exception:  # noqa: BLE001
            pass


def start_account_dir_login_watch(profile_id: str) -> None:
    """Watch a claude sign-in into the account's own config dir and announce
    it as a completed login (idempotent per profile)."""
    key = ("claude-account-dir", profile_id)
    task = _login_watches.get(key)
    if task is not None and not task.done():
        return
    task = asyncio.create_task(_account_dir_login_watch(profile_id))
    _login_watches[key] = task
    task.add_done_callback(
        lambda t, key=key: _login_watches.pop(key, None)
        if _login_watches.get(key) is t
        else None
    )


async def _account_dir_login_watch(profile_id: str) -> None:
    """Poll until the account dir holds a login, then broadcast the same
    ``login-harvest`` event an isolated login sends, so the window that
    opened the sign-in closes its pane and confirms the identity. Nothing is
    read from or copied out of the dir: Claude Code owns that credential."""
    deadline = time.monotonic() + LOGIN_WATCH_TIMEOUT_SEC
    while time.monotonic() < deadline:
        await asyncio.sleep(LOGIN_WATCH_INTERVAL_SEC)
        vault = _get_credential_vault()
        if vault is None:
            continue
        try:
            signed_in = await vault_to_thread(vault.account_dir_signed_in, profile_id)
            identity = await vault_to_thread(vault.account_dir_identity, profile_id)
        except Exception:  # noqa: BLE001 — retry on the next tick
            continue
        # The Keychain item can appear a moment before Claude Code records
        # the account; wait for both so the confirmation can name it.
        if not signed_in or identity is None:
            continue
        try:
            from .ws_handlers import _broadcast_profiles_changed

            await _broadcast_profiles_changed(
                "login-harvest", harvested_profile_ids=[profile_id]
            )
        except Exception:  # noqa: BLE001
            pass
        return


async def _login_watch(agent_key: str, profile_id: str) -> None:
    deadline = time.monotonic() + LOGIN_WATCH_TIMEOUT_SEC
    while time.monotonic() < deadline:
        await asyncio.sleep(LOGIN_WATCH_INTERVAL_SEC)
        vault = _get_credential_vault()
        if vault is None:
            continue
        try:
            if not _login_pending(vault, agent_key, profile_id):
                return  # harvested elsewhere (usage poll) or profile deleted
            if await vault_to_thread(functools.partial(
                vault.login_secret_present, agent_key, profile_id,
                **_scope_kwargs(vault.login_secret_present, agent_key, profile_id),
            )):
                await _kill_completed_login_panes(agent_key, profile_id)
            elif _login_against_live_store(vault, agent_key) and not _login_pane_running(
                agent_key, profile_id
            ):
                # A live-store sign-in whose pane is gone with nothing written:
                # the user cancelled or the CLI failed. Give the pre-login
                # credential back and stop. (An isolated login home is left
                # for the switch to harvest, as before.)
                if await _discard_pending_login_locked(vault, agent_key, profile_id):
                    return
            harvested = await _harvest_login_home_locked(vault, agent_key, profile_id)
        except Exception:  # noqa: BLE001 — retry on the next tick
            continue
        if harvested:
            try:
                from .ws_handlers import _broadcast_profiles_changed

                await _broadcast_profiles_changed(
                    "login-harvest", harvested_profile_ids=[profile_id]
                )
            except Exception:  # noqa: BLE001
                pass
            return


class UsageService:
    """Single app-wide poller. ``configure`` is idempotent and multi-window
    safe (last write wins); results are cached and broadcast on change."""

    def __init__(
        self,
        cache_path: Path | None = None,
        active_claude_slot_reader: Callable[[], str | None] | None = None,
    ) -> None:
        self.enabled = False
        self.interval = DEFAULT_INTERVAL
        self.snapshots: dict[str, dict] = {}
        self.account_snapshots: dict[str, dict[str, dict]] = {}
        self._last_good: dict[str, dict[str, dict]] = {}
        self._active_claude_slot = "__default__"
        # Bumped by every announced account switch. A poll cycle reads who is
        # active once, near its start, and then spends tens of seconds in the
        # CLI; comparing this counter tells it whether that answer is still
        # true before it writes anything based on it.
        self._switch_epoch = 0
        # The same, per non-Claude vendor: an account switch of codex must
        # drop a codex read that started before it, and must not touch a
        # kimi read in flight at the same time.
        self._agent_epochs: dict[str, int] = {}
        # Claude reads currently out in the CLI, by slot. The epoch above keeps
        # a mid-read switch from writing the wrong account's figure, but the
        # cycle still has to wait for that doomed read to finish before the
        # next one can start — and the poller awaits `poll_once` whole. So the
        # announcement cancels them instead of outliving them; `_reads_cancelled`
        # records which cancellations were ours, since a CancelledError from a
        # shutdown must still propagate.
        self._claude_reads: dict[str, asyncio.Task] = {}
        self._reads_cancelled: set[str] = set()
        # Account-dir /usage reads run one at a time (each boots a Claude Code).
        self._account_dir_read_lock = asyncio.Lock()
        self._cache_path = cache_path
        from .token_monitor import QuotaHistory

        self.quota_history = (
            QuotaHistory(cache_path.with_name("claude-quota-history.sqlite3"))
            if cache_path is not None else None
        )
        self._active_claude_slot_reader = active_claude_slot_reader
        self._blocked_until: dict[object, float] = {}
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._load_cache()
        if self._active_claude_slot_reader is not None:
            try:
                self._active_claude_slot = self._active_claude_slot_reader() or "__default__"
            except Exception:  # noqa: BLE001 — cached data remains usable with the default
                pass

    def payload(self) -> dict:
        for accounts in self.account_snapshots.values():
            for snap in accounts.values():
                if snap.get("stale"):
                    self._refresh_stale_expiry(snap)
        providers = dict(self.snapshots)
        active = self.account_snapshots.get("claude", {}).get(self._active_claude_slot)
        if active is not None:
            providers["claude"] = active
        return {
            "providers": providers,
            "accounts": self.account_snapshots,
            "enabled": self.enabled,
            "intervalSec": self.interval,
        }

    def _load_cache(self) -> None:
        if self._cache_path is None:
            return
        try:
            raw = json.loads(self._cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(raw, dict) or raw.get("schemaVersion") != USAGE_CACHE_SCHEMA_VERSION:
            return
        accounts = raw.get("accounts")
        claude = accounts.get("claude") if isinstance(accounts, dict) else None
        if not isinstance(claude, dict):
            return
        valid: dict[str, dict] = {}
        for slot_id, snap in claude.items():
            if (
                isinstance(slot_id, str)
                and isinstance(snap, dict)
                and snap.get("provider") == "claude"
                and snap.get("status") == "ok"
                and isinstance(snap.get("windows"), list)
                and all(isinstance(window, dict) for window in snap["windows"])
                and isinstance(snap.get("fetchedAt"), str)
            ):
                valid[slot_id] = self._cache_safe_snapshot(snap)
        if valid:
            self._last_good["claude"] = valid
            self.account_snapshots["claude"] = {
                slot_id: self._merge_cached(snap, "not-refreshed", None)
                for slot_id, snap in valid.items()
            }

    @staticmethod
    def _cache_safe_snapshot(snap: dict) -> dict:
        windows = []
        for window in snap.get("windows", []):
            kind = window.get("kind")
            label = window.get("label")
            used = window.get("usedPercent")
            resets = window.get("resetsAt")
            minutes = window.get("windowMinutes")
            if (
                not isinstance(kind, str)
                or not isinstance(label, str)
                or isinstance(used, bool)
                or not isinstance(used, (int, float))
                or (resets is not None and not isinstance(resets, str))
                or (minutes is not None and (
                    isinstance(minutes, bool) or not isinstance(minutes, (int, float))
                ))
            ):
                continue
            safe_window = {
                "kind": kind,
                "label": label,
                "usedPercent": used,
                "resetsAt": resets,
            }
            if "windowMinutes" in window:
                safe_window["windowMinutes"] = minutes
            windows.append(safe_window)
        plan_type = snap.get("planType")
        return {
            "provider": "claude",
            "status": "ok",
            "planType": plan_type if isinstance(plan_type, str) else None,
            "windows": windows,
            "fetchedAt": str(snap.get("fetchedAt") or _now_iso()),
            "error": None,
        }

    def _save_cache(self) -> None:
        if self._cache_path is None:
            return
        doc = {
            "schemaVersion": USAGE_CACHE_SCHEMA_VERSION,
            "accounts": self._last_good,
        }
        try:
            secret_files.write_private_plain(
                self._cache_path, json.dumps(doc, indent=2, ensure_ascii=False).encode("utf-8")
            )
        except Exception as err:  # noqa: BLE001 — cache failure must not sink polling
            log.warning("usage cache write failed: %s", err)

    @staticmethod
    def _reset_datetime(raw: object) -> datetime | None:
        if not raw:
            return None
        try:
            reset = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except ValueError:
            return None
        if reset.tzinfo is None:
            reset = reset.replace(tzinfo=timezone.utc)
        return reset

    @classmethod
    def _window_reset_passed(cls, window: dict) -> bool:
        reset = cls._reset_datetime(window.get("resetsAt"))
        return reset is not None and reset <= datetime.now(timezone.utc)

    def _refresh_stale_expiry(self, snap: dict) -> None:
        expired = False
        for window in snap.get("windows", []):
            window_expired = self._window_reset_passed(window)
            if window_expired:
                window["expired"] = True
                expired = True
            else:
                window.pop("expired", None)
        snap["staleExpired"] = expired

    def _merge_cached(
        self, cached: dict, refresh_status: str, attempted_at: str | None,
        error: str | None = None,
    ) -> dict:
        merged = copy.deepcopy(cached)
        merged.update({
            "stale": True,
            "lastSuccessAt": cached.get("fetchedAt"),
            "refreshStatus": refresh_status,
            "refreshAttemptedAt": attempted_at,
            "error": error,
        })
        self._refresh_stale_expiry(merged)
        return merged

    def _record_parked_claude_slot(self, slot_id: str) -> None:
        """A parked account cannot be measured right now.

        Only the CLI can report a figure and it speaks only for whoever is
        signed in, so a parked slot gets no fresh read. What it last measured
        *for itself* is kept and surfaced as stale rather than discarded:
        dropping it blanked both cards on every account switch — the outgoing
        one here, the incoming one because the same had happened to it while it
        was parked — and a card reading "no data" is indistinguishable from a
        broken one. The figure is the account's own past reading, labelled with
        its age, never presented as current. The cache itself is untouched."""
        cached = self._last_good.get("claude", {}).get(slot_id)
        self.account_snapshots.setdefault("claude", {})[slot_id] = (
            self._merge_cached(cached, "not-measured", None)
            if cached is not None
            else _snapshot("claude", "not-measured")
        )

    def _record_claude_snapshot(self, slot_id: str, fresh: dict) -> bool:
        account = self.account_snapshots.setdefault("claude", {})
        if fresh.get("status") == "ok":
            good = self._cache_safe_snapshot(fresh)
            self._last_good.setdefault("claude", {})[slot_id] = good
            account[slot_id] = {**copy.deepcopy(good), "stale": False,
                                "lastSuccessAt": good["fetchedAt"]}
            return True
        cached = self._last_good.get("claude", {}).get(slot_id)
        if cached is None:
            account[slot_id] = fresh
        else:
            account[slot_id] = self._merge_cached(
                cached,
                str(fresh.get("status") or "error"),
                fresh.get("fetchedAt"),
                fresh.get("error"),
            )
        return False

    async def _claude_credentials_by_slot(self) -> tuple[str, dict[str, dict | None]] | None:
        store = _get_profiles_store()
        vault = _get_credential_vault()
        resolver = getattr(vault, "resolve_claude_credentials", None) if vault else None
        if store is None or not callable(resolver):
            return None
        doc = await asyncio.to_thread(store.list)
        active = str(doc["defaults"].get("claude") or "__default__")
        slot_ids = ["__default__"] + [
            str(profile["id"])
            for profile in doc["profiles"]
            if profile.get("agentKey") == "claude" and profile.get("id")
        ]

        def _read_all() -> dict[str, dict | None]:
            return {
                slot_id: parse_claude_credentials(
                    resolver(slot_id, active=slot_id == active).secret
                )
                for slot_id in slot_ids
            }

        credentials = await asyncio.to_thread(_read_all)
        credentials = await self._delegate_active_claude_refresh(
            vault, active, credentials, _read_all
        )
        allowed = set(slot_ids)
        removed = False
        for mapping in (
            self._last_good.get("claude", {}),
            self.account_snapshots.get("claude", {}),
        ):
            for slot_id in set(mapping) - allowed:
                mapping.pop(slot_id, None)
                removed = True
        if removed:
            await asyncio.to_thread(self._save_cache)
        return active, credentials

    async def _delegate_active_claude_refresh(
        self, vault, active: str, credentials: dict[str, dict | None], read_all
    ) -> dict[str, dict | None]:
        """When the ACTIVE account's token has expired, ask the CLI to renew it
        and re-read. Nothing is minted here — see ``claude_delegated_refresh``.

        Only the active account can be renewed this way: the CLI probe touches
        whatever credential is live. A parked slot stays expired until a switch
        brings it live, where the CLI takes over. Best effort — a poll on an
        expired token still reports the account as expired, which is the
        behaviour without this step."""
        oauth = credentials.get(active)
        if oauth is None or not claude_token_expired(oauth):
            return credentials
        if not hasattr(vault, "read_live"):
            return credentials
        from .claude_delegated_refresh import OUTCOME_REFRESHED, attempt

        try:
            outcome = await attempt(vault)
        except Exception as err:  # noqa: BLE001 — must not sink the poll
            log.warning("claude delegated refresh errored: %s", err)
            return credentials
        if outcome != OUTCOME_REFRESHED:
            return credentials
        return await asyncio.to_thread(read_all)

    def configure(self, enabled: bool, interval_sec: float | None) -> None:
        self.enabled = bool(enabled)
        if interval_sec is not None:
            try:
                self.interval = max(MIN_INTERVAL, float(interval_sec))
            except (TypeError, ValueError):
                pass
        if self.enabled and (self._task is None or self._task.done()):
            self._task = asyncio.create_task(self._run())
        self._wake.set()

    def request_refresh(
        self, provider: str | None = None, slot_id: str | None = None
    ) -> None:
        """Clear read cooldowns and wake the poller.

        Without ``provider`` every cooldown goes — the "re-read every CLI"
        button. With one, only that provider's cooldown is cleared: the cycle
        still runs, but providers still inside their cooldown are skipped by
        ``poll_once`` as usual, so refreshing one account does not pay for a
        Claude Code launch nobody asked for. ``slot_id`` picks the Claude
        account slot (Claude's cooldowns are keyed per account); it defaults to
        the active one, the only slot the CLI can report on."""
        if provider is None:
            self._blocked_until.clear()
        elif provider == "claude":
            self._blocked_until.pop(
                ("claude", slot_id or self._active_claude_slot), None
            )
        else:
            self._blocked_until.pop(provider, None)
        self._wake.set()

    async def announce_claude_switch(
        self, slot_id: str | None, *, reading: bool = True
    ) -> None:
        """Point the badges at the account that just became active, and say its
        figure is still being read.

        The active slot is otherwise only learned inside ``poll_once``, so
        every badge kept showing the *outgoing* account's numbers from the
        moment the swap returned until the end of the next cycle — with nothing
        on screen saying a read was in flight. That gap is long: reading
        Claude's panel boots a whole Claude Code, and the refresh this requests
        queues behind a cycle already running. Long enough that the switch
        reads as having done nothing. So flip the pointer now and mark the
        incoming snapshot as being refreshed; whatever ``poll_once`` writes for
        the slot replaces the snapshot and drops the mark with it.

        The mark is only set when the poller is enabled — with no cycle coming,
        promising one would leave the wait on screen forever. `reading` is the
        caller's way of saying a read is not what happens next: switching onto
        an account that has to sign in first would otherwise promise a figure
        while a login pane opens.

        The epoch bump is what stops a poll cycle already in flight from
        undoing all of this — see `poll_once`."""
        await self.announce_switch("claude", slot_id, reading=reading)

    def begin_switch_epoch(
        self, agent_key: str, slot_id: str | None, *, reading: bool = True
    ) -> None:
        """The synchronous half of an account-switch announcement: move the
        active pointer, bump the vendor's epoch, mark the incoming snapshot as
        being read and drop reads in flight. Callable from inside the
        credential switch lock — no await, no broadcast — so a poll that
        started under the outgoing account is invalidated before the lock is
        released, not in the gap after it."""
        slot = slot_id or "__default__"
        if agent_key == "claude":
            self._active_claude_slot = slot
            self._switch_epoch += 1
            account = self.account_snapshots.setdefault("claude", {})
            if slot not in account:
                # Never polled (or polled before this account existed): give it
                # the same last-good-or-nothing snapshot a parked slot gets, so
                # the card has something to carry the mark.
                self._record_parked_claude_slot(slot)
            if self.enabled and reading:
                account[slot]["refreshPending"] = True
            else:
                account[slot].pop("refreshPending", None)
            self._cancel_claude_reads()
            self.request_refresh()
            return
        self._agent_epochs[agent_key] = self._agent_epochs.get(agent_key, 0) + 1
        account = self.account_snapshots.setdefault(agent_key, {})
        if slot not in account:
            account[slot] = _snapshot(agent_key, "not-measured")
        if self.enabled and reading:
            account[slot]["refreshPending"] = True
        else:
            account[slot].pop("refreshPending", None)
        self.request_refresh(agent_key)

    async def announce_switch(
        self, agent_key: str, slot_id: str | None, *, reading: bool = True, mark: bool = True
    ) -> None:
        """``announce_claude_switch`` for any vendor. ``mark=False`` when the
        caller already ran ``begin_switch_epoch`` under the switch lock and
        only the broadcast is left."""
        if mark:
            self.begin_switch_epoch(agent_key, slot_id, reading=reading)
        from . import app
        from .ipc import make_event

        await app.broadcast(make_event("usage.changed", self.payload()))

    def _notify_failover(self, agent_key: str, slot_id: str, snap: dict) -> None:
        """Hand a reading this cycle KEPT to the failover authority (a reading
        dropped for a mid-read switch never gets here). Best effort."""
        try:
            from . import app

            failover = getattr(app, "quota_failover", None)
            if failover is not None:
                failover.observe_usage(agent_key, slot_id, snap)
        except Exception as err:  # noqa: BLE001 — settling must not break polling
            log.warning("usage: failover observe failed for %s: %s", agent_key, err)

    def _cancel_claude_reads(self) -> None:
        """Drop any Claude read still out in the CLI.

        The epoch guard already stops a mid-read result from being filed under
        the wrong account, but it only discards the answer *after* waiting for
        it — and the probe's budget is minutes, not seconds. Left alone, a
        switch that lands one second into a read pays that whole budget before
        the read it actually asked for can start. Cancelling collapses that to
        nothing; the `request_refresh` that follows queues the real one.

        Never the caller's own task: an announcement raised from inside a read
        would otherwise cancel the very coroutine making it, turning this into
        a function that throws `CancelledError` at whoever called it. A read
        that announces its own switch has already finished the work the cancel
        exists to save, and the epoch guard covers what it writes."""
        current = asyncio.current_task()
        for slot_id, task in list(self._claude_reads.items()):
            if task is not current and not task.done():
                self._reads_cancelled.add(slot_id)
                task.cancel()

    async def _harvest_active_slots(self) -> None:
        """Opportunistic harvest: (a) when an agent's ACTIVE account slot is
        still empty but live credentials exist (the user just logged in inside
        a pane), copy them into the slot so a later switch can bring the
        account back; (b) when a profile has a pending isolated login home (a
        login pane completed its sign-in there), capture it into the profile's
        slot and clear the home. Best effort — failures are silent."""
        store = _get_profiles_store()
        vault = _get_credential_vault()
        if store is None or vault is None:
            return
        try:
            defaults = store.list()["defaults"]
        except Exception:  # noqa: BLE001
            return
        harvested = False
        for agent_key, profile_id in defaults.items():
            if not profile_id:
                continue
            try:
                # Same lock as the switch handler: a harvest must not interleave
                # with a live credential swap for this agent.
                async with vault.switch_lock(agent_key):
                    harvested = await vault_to_thread(
                        functools.partial(
                            vault.harvest, agent_key, profile_id,
                            **_scope_kwargs(vault.harvest, agent_key, profile_id),
                        )
                    ) or harvested
            except Exception:  # noqa: BLE001
                pass
        login_harvested_ids = await _harvest_pending_login_homes(store, vault)
        if harvested or login_harvested_ids:
            # A pane login just landed in a slot — let the accounts UI pick up
            # the new identity.
            try:
                from .ws_handlers import _broadcast_profiles_changed

                await _broadcast_profiles_changed(
                    "login-harvest" if login_harvested_ids else "harvest",
                    harvested_profile_ids=login_harvested_ids or None,
                )
            except Exception:  # noqa: BLE001
                pass

    async def _claude_account_dirs(self, slot_ids: list[str]) -> list[tuple[str, Path]]:
        """``(slot, config dir)`` for every one of ``slot_ids`` whose account
        signed in inside its own config dir. A vault without account dirs, or
        a failed lookup, reads as none — the slot stays not-measured."""
        vault = _get_credential_vault()
        signed_in = getattr(vault, "account_dir_signed_in", None)
        path_of = getattr(vault, "account_dir_path", None)
        if not callable(signed_in) or not callable(path_of):
            return []

        def _lookup() -> list[tuple[str, Path]]:
            found: list[tuple[str, Path]] = []
            for slot_id in slot_ids:
                if slot_id == "__default__":
                    continue
                try:
                    if signed_in(slot_id):
                        found.append((slot_id, path_of(slot_id)))
                except Exception as err:  # noqa: BLE001 — one account must not sink the rest
                    log.warning("claude account dir lookup failed for %s: %s", slot_id, err)
            return found

        return await asyncio.to_thread(_lookup)

    async def _read_account_dir(self, directory: Path) -> dict:
        async with self._account_dir_read_lock:
            return await fetch_claude_account_dir(directory)

    async def poll_once(self, home: Path | None = None) -> dict:
        home = home or Path.home()
        codex_home = Path(os.environ["CODEX_HOME"]) if os.environ.get("CODEX_HOME") \
            else home / ".codex"
        # Providers with a managed destination read its bound context. Claude resolves
        # every account independently without switching the active profile.
        await self._harvest_active_slots()
        now = time.monotonic()
        # Everything below about Claude rests on this answer to "who is active".
        # Capture the epoch first: if a switch lands while the cycle is out
        # reading the CLI, the answer is stale and must not be written back.
        switch_epoch = self._switch_epoch
        agent_epochs = dict(self._agent_epochs)
        claude_accounts = await self._claude_credentials_by_slot()
        cache_changed = False
        # Claude quota comes from the CLI's own `/usage` panel — Claude Code
        # asks under its own identity and this reads what it printed. Only the
        # signed-in account can be reported that way, so a parked account shows
        # its own last reading marked stale, never a figure passed off as live.
        parked_slots: list[str] = []
        if claude_accounts is None:
            claude_active = "__default__"
        else:
            claude_active, credentials = claude_accounts
            parked_slots = [s for s in credentials if s != claude_active]
        claude_coros = {claude_active: lambda: fetch_claude(home)}
        # A parked account that signed in inside its own config dir is not
        # parked for measuring: its /usage read runs on that dir. One at a
        # time — each read boots a whole Claude Code.
        for slot_id, directory in await self._claude_account_dirs(parked_slots):
            claude_coros[slot_id] = functools.partial(self._read_account_dir, directory)
        parked_slots = [s for s in parked_slots if s not in claude_coros]
        if self._switch_epoch == switch_epoch:
            for slot_id in parked_slots:
                self._record_parked_claude_slot(slot_id)
            self._active_claude_slot = claude_active
        claude_tasks: dict[str, asyncio.Task] = {}
        for slot_id, coro in claude_coros.items():
            key = ("claude", slot_id)
            if self._blocked_until.get(key, 0) <= now:
                claude_tasks[slot_id] = asyncio.create_task(coro())
        # Published so an account switch can cancel them rather than wait them
        # out — see `_cancel_claude_reads`.
        self._claude_reads = dict(claude_tasks)

        # Declaring `fetch_usage` in the vendor file is what puts a vendor in
        # the poll — adding one needs no edit here, which is the promise
        # docs/adding-a-cli-vendor.md makes. The inverse risk (a fetch quietly
        # disappearing and the vendor dropping out unnoticed) is covered by
        # test_usage_providers.py, which pins the expected set.
        tasks: dict[str, Any] = {}
        for provider, spec in _CLI_VENDORS.items():
            if provider == "claude":  # claude polls per-slot above
                continue
            if spec.fetch_usage is None:
                continue
            if self._blocked_until.get(provider, 0) > now:
                continue
            fetch = spec.fetch_usage
            vault = _get_credential_vault()
            stores = getattr(vault, "stores", None)
            if stores is not None and stores.enabled(provider) and spec.fetch_usage_from_context:
                try:
                    context = stores.context(provider)
                except StoreUnverified as err:
                    # Only a standard pane can verify the store, so there is
                    # nothing to read until one does. Check again next cycle
                    # rather than poll: the record appears once a pane binds.
                    unverified = asyncio.get_running_loop().create_future()
                    unverified.set_exception(err)
                    tasks[provider] = unverified
                    continue
                except Exception as err:  # noqa: BLE001 — one provider must not sink the rest
                    # A store that cannot be read (a locked database, a bad
                    # row) fails only this vendor; raising here would abandon
                    # the reads already started for the others. Logged with
                    # the other fetch failures below.
                    failed = asyncio.get_running_loop().create_future()
                    failed.set_exception(err)
                    tasks[provider] = failed
                    continue
                async def bound_fetch(ctx=context, adapter=spec):
                    return await adapter.fetch_usage_from_context(ctx)
                tasks[provider] = asyncio.create_task(bound_fetch())
            else:
                tasks[provider] = asyncio.create_task(fetch(home))
        for slot_id, task in claude_tasks.items():
            try:
                snap = await task
            except asyncio.CancelledError:
                # Ours (a switch landed) or the backend's (shutdown). Only the
                # first is ours to swallow — swallowing the second would leave
                # the poller running through a shutdown it was told to stop for.
                if slot_id not in self._reads_cancelled:
                    raise
                self._reads_cancelled.discard(slot_id)
                log.info("usage: cancelled the in-flight claude read for %s — "
                         "the account switched and asked for a fresh one", slot_id)
                continue
            except Exception as err:  # noqa: BLE001 — one account must not sink the rest
                log.warning("usage poll failed for claude account %s: %s", slot_id, err)
                snap = _snapshot("claude", "error", error=str(err))
            retry_after = snap.pop("retryAfterSec", None)
            costly = snap.pop("costlyRead", False)
            cooldown = retry_after if snap["status"] == "rate-limited" else \
                (RATE_LIMIT_COOLDOWN if snap["status"] == "unavailable" else None)
            if snap["status"] == "ok" or costly:
                # Reading the panel starts a whole Claude Code (seconds, plus
                # the user's MCP servers), so it must not ride the poll
                # interval — and a read that spawned but produced nothing cost
                # the same as one that succeeded, so it waits the same.
                # `request_refresh` clears this, which is what makes the
                # badge's own refresh button feel immediate.
                cooldown = CLAUDE_CLI_READ_INTERVAL
            if cooldown:
                self._blocked_until[("claude", slot_id)] = time.monotonic() + cooldown
            if self._switch_epoch != switch_epoch:
                # The account changed while this read was running. The CLI
                # reports whoever is signed in *now*, so filing this figure
                # under the slot that was active when the read started would
                # attribute one account's quota to another — and persist it.
                # Drop it; the switch already asked for another cycle.
                log.info("usage: discarding claude read for %s — account "
                         "switched mid-read", slot_id)
                continue
            cache_changed = self._record_claude_snapshot(slot_id, snap) or cache_changed
            self._notify_failover("claude", slot_id, snap)
            if self.quota_history is not None and snap.get("status") == "ok":
                try:
                    await asyncio.to_thread(
                        self.quota_history.record, slot_id, self._cache_safe_snapshot(snap)
                    )
                except Exception as err:  # noqa: BLE001 — history cannot interrupt polling
                    log.warning("quota history write failed: %s", err)
        self._claude_reads.clear()
        self._reads_cancelled.clear()
        if self._switch_epoch == switch_epoch:
            # Any slot this cycle did not write cannot have a read in flight —
            # clear a mark left by an announcement the poller could not act on
            # (an unresolvable ledger leaves every named slot untouched), or it
            # would say "reading" forever.
            touched = set(parked_slots) | set(claude_coros)
            for slot_id, snapshot in self.account_snapshots.get("claude", {}).items():
                if slot_id not in touched:
                    snapshot.pop("refreshPending", None)
        for provider, task in tasks.items():
            try:
                snap = await task
            except StoreUnverified as err:
                log.debug("usage poll skipped for %s: %s", provider, err)
                snap = _snapshot(provider, "unverified", error=str(err))
            except Exception as err:  # noqa: BLE001 — one provider must not sink the rest
                log.warning("usage poll failed for %s: %s", provider, err)
                snap = _snapshot(provider, "error", error=str(err))
            retry_after = snap.pop("retryAfterSec", None)
            cooldown = retry_after if snap["status"] == "rate-limited" else \
                (RATE_LIMIT_COOLDOWN if snap["status"] == "unavailable" else None)
            if cooldown:
                self._blocked_until[provider] = time.monotonic() + cooldown
            if self._agent_epochs.get(provider, 0) != agent_epochs.get(provider, 0):
                # This vendor's account switched while the read was out. The
                # CLI reports whoever is signed in *now*; the figure belongs to
                # neither the account the read started under nor, reliably,
                # the new one. Drop it — the switch already asked for another
                # cycle — however fresh its fetchedAt looks.
                log.info("usage: discarding %s read — account switched mid-read", provider)
                continue
            self.snapshots[provider] = snap
            # Per-account view for vendors other than Claude: the reading is
            # the active profile's ("__default__" without profiles). Parked
            # accounts keep whatever they last measured for themselves.
            active_slot = _active_profile_id(provider) or "__default__"
            account = self.account_snapshots.setdefault(provider, {})
            account[active_slot] = {**copy.deepcopy(snap), "stale": False}
            if snap.get("status") == "ok":
                account[active_slot]["lastSuccessAt"] = snap.get("fetchedAt")
            self._notify_failover(provider, active_slot, snap)
        for provider, epoch in agent_epochs.items():
            if provider not in tasks and self._agent_epochs.get(provider, 0) == epoch:
                # Skipped this cycle (cooldown) with no switch since: nothing
                # is being read, so no snapshot may say it is.
                for snapshot in self.account_snapshots.get(provider, {}).values():
                    snapshot.pop("refreshPending", None)
        if cache_changed:
            await asyncio.to_thread(self._save_cache)
        await self._file_quota_samples()
        return self.payload()

    async def _file_quota_samples(self) -> None:
        """Hand every fresh snapshot to the quota cycle ledger and announce
        the cycles it changed. Each vendor's snapshot belongs to the account
        slot captured when its fetch was accepted ("__default__" without
        profiles). Best effort: the ledger is not allowed to
        break the poll."""
        try:
            from . import app
            from .ipc import make_event
        except Exception:  # noqa: BLE001 — unit tests without the app
            return
        ledger = getattr(app, "quota_ledger", None)
        if ledger is None:
            return
        # The slot captured when the fetch was accepted owns the reading.
        # Looking up the active profile again after awaiting another provider
        # can file the outgoing account's reading under the incoming one.
        readings: list[tuple[str, str, dict]] = [
            (provider, slot_id, snap)
            for provider, accounts in self.account_snapshots.items()
            for slot_id, snap in accounts.items()
        ]
        try:
            changed = await asyncio.to_thread(
                lambda: [
                    key
                    for agent, profile_id, snap in readings
                    for key in ledger.observe(agent, profile_id, snap)
                ]
            )
        except Exception as err:  # noqa: BLE001
            log.warning("quota ledger update failed: %s", err)
            return
        for agent, profile_id, window_kind in dict.fromkeys(changed):
            await app.broadcast(make_event("tokens.quota_cycles_changed", {
                "agent_key": agent, "profile_id": profile_id, "window_kind": window_kind,
            }))

    def _next_sleep(self) -> float:
        """Regular interval, shortened to land just after the nearest window
        reset (CodexBar's reset-boundary refresh)."""
        sleep = self.interval
        now = datetime.now(timezone.utc)
        snapshots = list(self.snapshots.values()) + [
            snap
            for accounts in self.account_snapshots.values()
            for snap in accounts.values()
        ]
        for snap in snapshots:
            for win in snap.get("windows", []):
                resets = self._reset_datetime(win.get("resetsAt"))
                if resets is None:
                    continue
                delta = (resets - now).total_seconds() + RESET_BOUNDARY_GRACE
                if 5.0 < delta < sleep:
                    sleep = delta
        return max(5.0, sleep)

    async def _run(self) -> None:
        from . import app
        from .ipc import make_event

        while self.enabled:
            # Consume the wake that led to this poll. A refresh requested while
            # the poll is running remains set and triggers the next iteration.
            self._wake.clear()
            try:
                payload = await self.poll_once()
                await app.broadcast(make_event("usage.changed", payload))
            except Exception as err:  # noqa: BLE001 — poller must survive anything
                log.warning("usage poll cycle failed: %s", err)
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self._next_sleep())
            except asyncio.TimeoutError:
                pass


service = UsageService(
    cache_path=app_data_dir() / USAGE_CACHE_FILE,
    active_claude_slot_reader=lambda: _active_profile_id("claude"),
)
