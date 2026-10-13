"""Kilo Code CLI conversation reader.

Kilo Code (@kilocode/cli) is an OpenCode fork with the same SQLite schema:
one shared WAL database at <XDG_DATA_HOME|~/.local/share>/kilo/kilo.db with
session / message / part tables (message.data carries per-message tokens and
time.completed; user input text is preserved verbatim in part.data, so the
`at-pane:` kickoff marker lands there). Everything OpencodeLogReader does —
read-only short-lived connections, rowid-watermark incremental parsing with a
streaming-pending list, marker scanning over top-level sessions, has_session
preflight, cache-into-input / reasoning-into-output folding — applies
unchanged, so this reader only re-points the vendor name and db location.

Dev-channel databases (kilo-<channel>.db) are intentionally ignored — only
the stable kilo.db is read. Resume: `kilo --session <ses_…>` / `-s <id>`.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from .base import ExtensionsSource, ExtensionsSpec  # noqa: F401
from .base import (
    AccountSwitchSpec,
    Dep,
    McpServerConfig,
    McpValue,
    McpWiring,
    PushChannel,
    VendorSpec,
    command_text,
    provider_map_extract,
    provider_map_merge,
)
from .opencode import OpencodeLogReader  # vendor→vendor: sanctioned fork inheritance
from ..usage_common import (
    HTTP_TIMEOUT,
    _epoch_to_iso,
    _num,
    _snapshot,
    _window,
    parse_retry_after,
)


class KiloLogReader(OpencodeLogReader):
    vendor: str = "kilo"
    _dir_name: str = "kilo"
    _db_name: str = "kilo.db"


# ---- attribution/watch hooks ----------------------------------------------
# Kilo is an OpenCode fork: same shared-db binding, same cwd semantics —
# the flags/hooks inherit from OpencodeLogReader automatically. Nothing to
# override.


# ---- usage quota -----------------------------------------------------------

# kilo (Kilo CLI, @kilocode/cli). auth.json is a map keyed by provider id; the
# "kilo" entry holds either an api key or a long-lived oauth access token that
# IS the Kilo bearer token (1-year expiry, no refresh rotation needed for
# reads). The Kilo Pass query string is tRPC batch syntax for input {"0":null}.
KILO_DEFAULT_BASE = "https://api.kilo.ai"
# Default (no XDG_DATA_HOME) location under $HOME — see _kilo_auth_file.
KILO_AUTH_FILE_REL = (".local", "share", "kilo", "auth.json")
KILO_LEGACY_CONFIG_REL = (".kilocode", "cli", "config.json")
KILO_BALANCE_PATH = "/api/profile/balance"
KILO_PASS_PATH = "/api/trpc/kiloPass.getState?batch=1&input=%7B%220%22%3Anull%7D"


def _kilo_entry_credentials(entry: Any) -> dict | None:
    """One auth.json provider entry -> {token, org_id} or None. ``api`` keys
    and ``oauth`` access tokens are both Kilo bearer tokens; oauth carries the
    organization id as ``accountId``. Local expiry is deliberately not checked
    (the token lives ~1 year) — a genuinely expired token maps to
    status=expired via the endpoint's 401."""
    if not isinstance(entry, dict):
        return None
    if entry.get("type") == "api":
        key = entry.get("key")
        return {"token": key, "org_id": None} \
            if isinstance(key, str) and key else None
    if entry.get("type") == "oauth":
        access = entry.get("access")
        if not isinstance(access, str) or not access:
            return None
        org = entry.get("accountId")
        return {"token": access,
                "org_id": org if isinstance(org, str) and org else None}
    return None


def identity_from_secret(secret):
    """Display identity for the accounts UI, from an ``auth.json`` payload.

    ``email`` stays empty on purpose: kilo's auth.json carries no email, no
    display name and no user id — an ``api`` entry holds only the key, an
    ``oauth`` entry the access token plus ``accountId``, which is the
    ORGANIZATION id (it ships as the X-KILOCODE-ORGANIZATIONID header), not the
    person. Two members of one org share it, so putting it in ``email`` would
    both label the card with an id that names the wrong thing and make the
    duplicate-account detection — which groups rows by exactly this field —
    declare two different logins the same account. With no identity to show,
    the accounts UI names the row by the profile name the user typed (the same
    fallback kimi uses). All this can report is whether a credential exists."""
    data = None
    if secret is not None:
        try:
            data = json.loads(secret)
        except ValueError:
            data = None
    # Either the whole auth.json (legacy whole-file slots, the live file) or
    # the bare "kilo" entry a scoped slot holds (see ``provider_map_extract``).
    if isinstance(data, dict) and "type" in data and "kilo" not in data:
        entry = data
    else:
        entry = data.get("kilo") if isinstance(data, dict) else None
    return {"email": None, "signedIn": _kilo_entry_credentials(entry) is not None}


def _kilo_legacy_credentials(home: Path) -> dict | None:
    """Legacy ``~/.kilocode/cli/config.json``: providers[] entries with
    provider == "kilocode" carry kilocodeToken (+ kilocodeOrganizationId)."""
    try:
        data = json.loads(
            home.joinpath(*KILO_LEGACY_CONFIG_REL).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    providers = data.get("providers") if isinstance(data, dict) else None
    if not isinstance(providers, list):
        return None
    for entry in providers:
        if not isinstance(entry, dict) or entry.get("provider") != "kilocode":
            continue
        token = entry.get("kilocodeToken")
        if isinstance(token, str) and token:
            org = entry.get("kilocodeOrganizationId")
            return {"token": token,
                    "org_id": org if isinstance(org, str) and org else None}
    return None


def _kilo_auth_file(home: Path, env: dict) -> Path:
    """auth.json under Kilo's XDG data dir. Kilo (an OpenCode fork) stores its
    data under ``$XDG_DATA_HOME/kilo`` and only falls back to
    ``<home>/.local/share/kilo`` when the variable is unset — same resolution
    OpencodeLogReader._data_dir already does for the databases, and the lever
    the vendor's own blog post uses to run a second isolated instance
    (https://blog.kilo.ai/p/run-a-second-isolated-kilo-code-without). Reading
    the fixed ``~/.local/share`` path made the quota look logged-out for anyone
    who sets XDG_DATA_HOME."""
    base = env.get("XDG_DATA_HOME")
    if base:
        return Path(base) / "kilo" / "auth.json"
    return home.joinpath(*KILO_AUTH_FILE_REL)


def read_kilo_credentials(home: Path, env: dict | None = None, *, bound_store: bool = False) -> dict | None:
    """The Kilo bearer token + optional organization id, resolved the way the
    Kilo CLI does (read-only): ``KILO_AUTH_CONTENT`` env injects the whole
    auth.json content, otherwise ``<XDG_DATA_HOME|~/.local/share>/kilo/auth.json``
    is read; the legacy ``~/.kilocode/cli/config.json`` is the last fallback.
    Returns ``{token, org_id}`` or None."""
    env = env or {}
    raw = env.get("KILO_AUTH_CONTENT")
    if raw:
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            data = None
    else:
        try:
            data = json.loads(
                _kilo_auth_file(home, env).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = None
    creds = _kilo_entry_credentials(data.get("kilo")) \
        if isinstance(data, dict) else None
    if creds is not None:
        return creds
    return None if bound_store else _kilo_legacy_credentials(home)


def kilo_base_url(token: str, env: dict | None = None) -> str:
    """``KILO_API_URL`` env wins; a token prefixed ``https://host:`` re-points
    the base itself (the CLI's getKiloUrlFromToken — the token is still sent
    unmodified); default api.kilo.ai."""
    env = env or {}
    override = env.get("KILO_API_URL")
    if override:
        return override.rstrip("/")
    if token.startswith("https://"):
        base = token.rsplit(":", 1)[0]
        if base != "https":  # a ":" existed beyond the scheme
            return base.rstrip("/")
    return KILO_DEFAULT_BASE




def normalize_kilo_balance(data: dict) -> list[dict]:
    """``/api/profile/balance``: {"balance": USD remaining} — a prepaid credit
    pool with no reset window and no used/limit ratio, so the raw balance is
    surfaced as-is on a "credits" window (usedPercent is pinned to 0 because
    the window shape requires one; the balance field is the real datum)."""
    balance = _num(data.get("balance"))
    if balance is None:
        return []
    window = _window("credits", "Credits", 0.0, None)
    window["balance"] = balance
    return [window]


def kilo_pass_subscription(data: Any) -> dict | None:
    """The ``subscription`` object from a kiloPass.getState response. The tRPC
    envelope varies (batched array, result/data/json nesting), so wrappers are
    unwrapped level by level; a null subscription means no Kilo Pass."""
    node = data[0] if isinstance(data, list) and data else data
    for _ in range(4):
        if not isinstance(node, dict):
            return None
        sub = node.get("subscription")
        if isinstance(sub, dict):
            return sub
        for key in ("result", "data", "json"):
            if isinstance(node.get(key), dict):
                node = node[key]
                break
        else:
            return None
    return None


def normalize_kilo_pass(data: Any) -> list[dict]:
    """Kilo Pass subscription: currentPeriodUsageUsd against base + bonus
    period credits -> one "period" window resetting at nextBillingAt."""
    sub = kilo_pass_subscription(data)
    if sub is None:
        return []
    base = _num(sub.get("currentPeriodBaseCreditsUsd")) or 0.0
    bonus = _num(sub.get("currentPeriodBonusCreditsUsd")) or 0.0
    used = _num(sub.get("currentPeriodUsageUsd"))
    total = base + bonus
    if not total or used is None:
        return []
    resets = sub.get("nextBillingAt")
    return [_window("period", "Kilo Pass period", used / total * 100,
                    resets if isinstance(resets, str) else None)]




async def fetch_kilo(home: Path, env: dict | None = None, *, bound_store: bool = False) -> dict:
    env = env if env is not None else dict(os.environ)
    creds = read_kilo_credentials(home, env, bound_store=bound_store)
    if creds is None:
        return _snapshot("kilo", "no-credentials")
    import httpx

    base = kilo_base_url(creds["token"], env)
    headers = {
        "Authorization": f"Bearer {creds['token']}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Navide",
    }
    if creds.get("org_id"):
        # Switches the balance to the team's when the auth carries an org.
        headers["X-KILOCODE-ORGANIZATIONID"] = creds["org_id"]
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(f"{base}{KILO_BALANCE_PATH}", headers=headers)
        if resp.status_code in (401, 403):
            return _snapshot("kilo", "expired")
        if resp.status_code == 429:
            snap = _snapshot("kilo", "rate-limited")
            snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
            return snap
        if resp.status_code != 200:
            return _snapshot("kilo", "error", error=f"HTTP {resp.status_code}")
        try:
            payload = resp.json()
        except ValueError:
            return _snapshot("kilo", "error", error="non-JSON response")
        windows = normalize_kilo_balance(payload if isinstance(payload, dict) else {})
        # Kilo Pass period usage is best effort — a Pass endpoint failure must
        # not block the credit balance (the CLI treats non-OK as no Pass too).
        try:
            pass_resp = await client.get(f"{base}{KILO_PASS_PATH}", headers=headers)
            if pass_resp.status_code == 200:
                windows += normalize_kilo_pass(pass_resp.json())
        except (httpx.HTTPError, ValueError):
            pass
    if not windows:
        return _snapshot("kilo", "error", error="response had no usable fields")
    return _snapshot("kilo", "ok", windows=windows)




# ---- resume / session ------------------------------------------------------

# Kilo Code keeps OpenCode's resume flags — same optional-id guard so the
# capture never swallows a following flag.
_RESUME_RE = re.compile(r"^kilo\s+(?:\S+\s+)*(?:--session|-s)\s+([^-\s]\S*)")


def _resume_id_from_command(command) -> str:
    """Session id from a `kilo ... --session <id>` / `-s <id>` command
    ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return m.group(1) if m else ""


def _session_exists(workspace_path: str, session_id: str) -> bool:
    # One shared SQLite db, same as OpenCode; ask the reader so a stale
    # persisted id fails preflight instead of launching a doomed
    # `kilo --session <id>`.
    return KiloLogReader().has_session(session_id)


# ---- vendor spec -----------------------------------------------------------

# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(sources=(
    ExtensionsSource("code-files", (".config", "kilo", "plugins"), "Kilo plugin"),
    ExtensionsSource("npm-list", (".config", "kilo", "kilo.json"), "Kilo plugin", section=("plugin",)),
    ExtensionsSource("npm-list", (".config", "kilo", "kilo.jsonc"), "Kilo plugin", section=("plugin",)),
))

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="kilo",
    # OpenCode fork with arbitrary providers; quota base is not a CLI host set.
    expected_hosts=(),
    # Same XDG database/auth root as KiloLogReader and _kilo_auth_file.
    data_dirs=lambda ctx: (ctx.path(ctx.env.get("XDG_DATA_HOME") or ctx.home / ".local" / "share") / "kilo",),
    data_dir_env_vars=("XDG_DATA_HOME",),
    # Confirmed in source (Kilo-Org/kilocode): the root command declares
    # --model and applies it at the highest priority. No effort flag —
    # --variant exists only on `kilo run`. Details in agents/kilo.ts, which
    # owns the flags themselves.
    supports_model=True,
    # Verified 2026-08-15: kilo's bundle carries no SKILL.md handling at all.
    skills_supported=False,
    label="Kilo Code CLI",
    # An OpenCode fork: identical config document, its own variable.
    mcp_wiring=McpWiring(
        config=McpServerConfig(
            section=("mcp",),
            entry=(
                ("type", "remote"),
                ("url", McpValue.URL),
                ("enabled", True),
            ),
            document=(("$schema", "https://opencode.ai/config.json"),),
        ),
        config_env="KILO_CONFIG_CONTENT",
    ),
    # Same `/tui/*` surface as OpenCode, with the authentication reversed.
    # Verified against 7.4.22: kilo's server refuses an unauthenticated request
    # outright (401), its own TUI DOES read KILO_SERVER_PASSWORD and keeps
    # working when one is set, and the basic-auth user it expects is `kilo`
    # (OpenCode's `opencode` is rejected). So unlike OpenCode this pane gets a
    # per-pane secret and its port is not open to everything on the machine.
    push_channel=PushChannel(
        holds_input_box=True,
        port_flag="--port",
        host_flag="--hostname",
        append_path="/tui/append-prompt",
        submit_path="/tui/submit-prompt",
        clear_path="/tui/clear-prompt",
        password_env="KILO_SERVER_PASSWORD",
        username="kilo",
    ),
    login_command_args="auth login",
    # Multi-account (credential swap): the vault parks and restores this exact
    # file — `kilo auth list` prints the path itself, and it is the same tuple
    # the quota reader already resolves against.
    #
    # The vault follows the same XDG path as the CLI and quota reader.
    live_file=KILO_AUTH_FILE_REL,
    live_file_resolver=lambda home: _kilo_auth_file(home, os.environ),
    live_file_from_context=lambda ctx: ctx.path(_kilo_auth_file(ctx.home, ctx.env)),
    credential_path_env_vars=("XDG_DATA_HOME",),
    slot_file="auth.json",
    identity_from_secret=identity_from_secret,
    # ``auth.json`` is an OpenCode-shaped provider map; only the "kilo" entry
    # is the account, so a switch rewrites that one key and leaves any other
    # provider the user added in place. Slots parked before this split hold
    # the whole file, which the extract reads the same way (it is the same
    # shape), so nothing stored is invalidated. Kilo loads the file at
    # startup, hence restart.
    account_switch=AccountSwitchSpec(
        auth_scope="kilo",
        method="restart",
        store="compound-file",
        evidence="source",
        verified_version="7.4.22",
        scopes=("kilo",),
        extract=provider_map_extract,
        merge=provider_map_merge,
        # The 7.4.22 binary's provider table: kilo's key is KILO_API_KEY; the
        # OpenCode-derived loader's env-vs-auth.json precedence is unverified.
        uncertain_env_by_scope=(("kilo", ("KILO_API_KEY",)),),
        resume="native",
        todo="no A -> B -> A round-trip on two real accounts recorded",
    ),
    # login_home_env / login_home_secret_file stay unset: kilo has no dedicated
    # config-home variable (`kilo debug paths` reports only the generic XDG
    # dirs), so a login pane cannot be given its own credential file without
    # exporting XDG_DATA_HOME — which would relocate every XDG-aware program in
    # that pane, Navide itself included when launched from it. A kilo sign-in
    # therefore runs against the real home and the vault captures the result
    # afterwards (see credential_vault.login_spawn_env).
    # Late-bound (module global at call time) so tests can monkeypatch.
    fetch_usage=lambda home: fetch_kilo(home),
    fetch_usage_from_context=lambda ctx: fetch_kilo(ctx.home, dict(ctx.env), bound_store=True),
    resume_id_from_command=_resume_id_from_command,
    session_exists=_session_exists,
    # Only the env vars Kilo actually documents (kilo-config.md defines
    # KILO_CONFIG, KILO_CONFIG_DIR, KILO_CONFIG_CONTENT and
    # KILO_DISABLE_PROJECT_CONFIG — there is no KILO_DB, so listing it stripped
    # a variable no Kilo build reads):
    # https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/kilocode/skills/kilo-config.md
    # NOTE (unverified — kilo is not installed here, this is documentation-only):
    # neither of these relocates kilo.db / auth.json. KILO_CONFIG_DIR only
    # APPENDS to the config search list, so it is not an isolation lever; the
    # real lever is XDG_DATA_HOME, which is a general-purpose variable and
    # cannot go in this strip-list. Kilo's data locations can be confirmed on a
    # machine that has it installed with `kilo debug paths`.
    home_env_vars=("KILO_CONFIG_DIR", "KILO_CONFIG"),
    make_log_reader=KiloLogReader,
    # Kilo Code (OpenCode fork) ships `kilo upgrade` but no doctor subcommand
    # (`kilo debug` is diagnostics-adjacent, not a doctor — no invented command).
    install_dep=Dep("kilo", "Kilo Code CLI", "Kilo Code terminal coding agent (OpenCode fork)", "agent_cli",
        ["kilo", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @kilocode/cli",
        needs_terminal=True, requires_binaries=("npm",), optional=True,
        docs_url="https://kilo.ai/docs/code-with-ai/platforms/cli",
        update_cmd="kilo upgrade",
        npm_package="@kilocode/cli",
        # Update-state lookup only (see onboarding_deps._config_homes); this is
        # an additional config SEARCH dir, not a relocatable config home.
        config_home_env="KILO_CONFIG_DIR",
        autoupdate_env="KILO_DISABLE_AUTOUPDATE"),
)
