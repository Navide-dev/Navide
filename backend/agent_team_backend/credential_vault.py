"""Per-account credential slots for CLI agents.

Profiles no longer isolate a CLI's whole config home: every agent runs
against the user's real home, and a profile is only a credential slot.
Switching the active account captures the live credentials into the outgoing
account's slot and restores the incoming account's slot into the live
location. The reserved slot ``__default__`` holds the unmanaged original
login while a managed account is active. Every agent — claude included —
follows the same model: the active account's secret lives in the live
location and the slots are cold backups.

Live credential locations (relative to the real home):

    claude  macOS: Keychain generic password, service
            ``Claude Code-credentials`` (file fallback
            ``~/.claude/.credentials.json``); elsewhere the file only.
            The display-only ``oauthAccount`` object lives at the top level
            of ``~/.claude.json``.
    codex   ``~/.codex/auth.json``
    kimi    ``~/.kimi-code/credentials/kimi-code.json``
    grok    ``~/.grok/auth.json``

Slot storage:

    claude on macOS  backend-owned Keychain item
                     ``Navide CLI account claude-<slot_id>`` for the secret,
                     plus ``oauth-account.json`` (display info, not a secret)
                     in the slot directory
    everything else  0600 files under ``<profiles_root>/<agentKey>/<slot_id>/``

All Keychain access goes through an injectable ``security_runner`` so tests
never touch the real Keychain.
"""

from __future__ import annotations

import asyncio
import base64
import getpass
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .applog import app_data_dir, default_app_data_dir
from .osplat import secret_files
from .cli_vendors.registry import vendor as _cli_vendor_spec
from .profiles_store import (
    CLAUDE_ENV_OVERRIDES,
    PROFILE_HOME_DIRNAME,
    SUPPORTED_AGENT_KEYS,
    canonical_path_str,
    default_profiles_root,
)

log = logging.getLogger("agent_team_backend.credential_vault")

# Dedicated pool for blocking credential I/O (Keychain ``security``
# subprocesses, 0600 secret files). Every one of these calls runs while its
# agent's ``switch_lock`` is held, so it must never queue behind unrelated
# work: on asyncio's shared default executor a burst of CLI spawn probes can
# occupy every worker, leaving the lock holder waiting for a thread and the
# lock held indefinitely. One worker per profile agent: ``switch_lock`` already
# serializes vault work per agent, so ``len(SUPPORTED_AGENT_KEYS)`` is the true
# concurrency ceiling. Sizing it smaller would requeue the very calls this pool
# exists to unblock — a 10s Keychain ``security`` timeout each, against the
# 30s spawn-side lock budget.
_VAULT_EXECUTOR = ThreadPoolExecutor(
    max_workers=len(SUPPORTED_AGENT_KEYS), thread_name_prefix="vault-io"
)


async def vault_to_thread(fn: Callable, *args):
    """``asyncio.to_thread`` for credential I/O, pinned to ``_VAULT_EXECUTOR``.

    Use this — never ``asyncio.to_thread`` — for anything called while holding
    an agent's ``switch_lock``.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_VAULT_EXECUTOR, fn, *args)


# Reserved slot for the unmanaged original login (defaults[agent] = null).
DEFAULT_SLOT_ID = "__default__"

CLAUDE_LIVE_KEYCHAIN_SERVICE = "Claude Code-credentials"
_SLOT_SERVICE_PREFIX = "Navide CLI account "

# Backend-owned secrets that are not a CLI vendor's credential (the
# Navide-Server access token is the first). Same storage rules as a slot
# secret — Keychain on macOS, a 0600 file elsewhere — so there is one place
# where "how Navide stores a secret" is decided.
_APP_SECRET_SERVICE_PREFIX = "Navide secret "
_APP_SECRET_DIRNAME = "__secrets__"

#: Characters a Windows filename may not hold. A secret's name is written by
#: the caller, not by a person, and one of them carries an account namespace
#: after a colon — which on NTFS opens an alternate data stream rather than a
#: file, so the write failed with "the parameter is incorrect" and sync could
#: not keep a key on Windows at all. The platform with no Keychain is the one
#: where this file IS the secret, so the failure was total there.
_FILENAME_RESERVED = '<>:"/\\|?*'


def _filename_for(name: str) -> str:
    """*name* as a filename every supported platform accepts.

    Percent-escaped, and ``%`` with it so the mapping stays one-to-one. Every
    name that is already a legal filename — which is all of the fixed ones —
    maps to itself, so no stored secret moves.
    """
    out = []
    for ch in name:
        if ch == "%" or ch in _FILENAME_RESERVED or ord(ch) < 32:
            out.append(f"%{ord(ch):02X}")
        else:
            out.append(ch)
    return "".join(out)


# Secret file name inside a slot directory, per agent.
_SLOT_FILES = {
}

# Live secret file path segments, relative to the real home.
_LIVE_FILES = {
}

_OAUTH_ACCOUNT_SLOT_FILE = "oauth-account.json"

# Isolated config home a login pane runs in, inside the profile's slot dir.
# The CLI completes its login there without touching the live credentials;
# the usage poller then harvests it into the slot and removes it.
LOGIN_HOME_DIRNAME = "login-home"
# For a CLI that cannot be given an isolated home, the login pane signs in
# against the LIVE store and would overwrite the active account. Before the
# pane starts the vault snapshots the live credential into this file INSIDE
# THE SLOT DIR (no login home is created — that directory means "isolated
# login" to the handlers). The harvest parks whatever the CLI wrote into the
# profile's slot and puts the snapshot back, so "add account" never costs the
# account that was signed in. Private file (a secret); JSON {secret, scope}.
# ``login_pending`` is the one predicate covering both kinds of login.
_PRE_LOGIN_SNAPSHOT_FILE = ".pre-login-live.json"

# A claude account's own CLAUDE_CONFIG_DIR, inside the profile's slot dir.
# The account signs in there once and Claude Code keeps, refreshes and locks
# that login itself; Navide only points panes at the directory and never
# reads, copies or writes the token. A different name from the legacy profile
# home (``PROFILE_HOME_DIRNAME``) on purpose: the legacy promotion and the
# login harvest read that home and may delete its Keychain item.
ACCOUNT_DIR_DIRNAME = "config-dir"

# Entries of ~/.claude an account dir shares with the real home by symlink, so
# sessions, settings (Navide's hooks) and the user's skills follow the user,
# not the account. ``(name, is_dir)``. Runtime state (daemon, locks, ide,
# session-env, shell snapshots) is deliberately not shared: it belongs to the
# process tree of one config dir. Linked only when the real entry exists,
# except ``_CLAUDE_ALWAYS_SHARED``, which a pane may create first.
CLAUDE_SHARED_ENTRIES: tuple[tuple[str, bool], ...] = (
    ("projects", True),
    ("file-history", True),
    ("todos", True),
    ("tasks", True),
    ("history.jsonl", False),
    ("settings.json", False),
    ("settings.local.json", False),
    ("CLAUDE.md", False),
    ("skills", True),
    ("plugins", True),
    ("agents", True),
    ("commands", True),
    ("output-styles", True),
    ("keybindings.json", False),
)
_CLAUDE_ALWAYS_SHARED = frozenset({"projects", "settings.json"})

# Top-level ``~/.claude.json`` keys copied into a new account dir's own
# ``.claude.json`` so its first pane skips onboarding and keeps folder trust
# and user MCP servers. Never ``oauthAccount`` or any API-key field: the
# account's identity comes from its own sign-in. ``mcpServers`` is re-synced
# on every prepare so MCP edits keep reaching every account.
_CLAUDE_SEED_KEYS = (
    "hasCompletedOnboarding",
    "lastOnboardingVersion",
    "theme",
    "editorMode",
    "projects",
    "mcpServers",
    "bypassPermissionsModeAccepted",
)

# Where each CLI writes its secret inside an isolated login home, relative to
# the login-home dir. Env vars and layouts mirror the pre-refactor config-home
# isolation (verified in commit 0bcfcf8^): claude uses CLAUDE_CONFIG_DIR (macOS
# secret in a path-hashed Keychain item — see harvest_legacy_claude_home),
# codex CODEX_HOME, kimi KIMI_CODE_HOME, grok a HOME shim with a real ``.grok``
# dir one level in.
_LOGIN_HOME_SECRET_FILES = {
}

# Where each CLI kept its secret inside a legacy persistent profile home,
# relative to the home dir (claude used the path-hashed Keychain item /
# ``.credentials.json`` — see ``_claude_profile_home_secret``). Only read by
# the one-time profile-home promotion; spawns no longer use these homes.
_PROFILE_HOME_SECRET_FILES = {
}


def _apply_vendor_credential_files() -> None:
    """Overlay migrated vendors' credential layouts onto the legacy tables.

    One-file-per-vendor bridge: a vendor's round moves its entries from the
    literals above into its ``cli_vendors/<key>.py`` spec and deletes them
    here; this overlay keeps the four tables complete either way, so the 16
    lookup/membership/iteration sites in this module stay untouched."""
    from .cli_vendors.registry import VENDORS

    for key, spec in VENDORS.items():
        if spec.slot_file is not None:
            _SLOT_FILES[key] = spec.slot_file
        if spec.live_file is not None:
            _LIVE_FILES[key] = spec.live_file
        if spec.login_home_secret_file is not None:
            _LOGIN_HOME_SECRET_FILES[key] = spec.login_home_secret_file
        if spec.profile_home_secret_file is not None:
            _PROFILE_HOME_SECRET_FILES[key] = spec.profile_home_secret_file


_apply_vendor_credential_files()


def _parse_json_dict(raw: str | None) -> dict | None:
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _claude_oauth_expires_at(secret: str | None) -> float | None:
    """Epoch-ms token expiry from a claude credentials JSON
    (``claudeAiOauth.expiresAt``); None when absent or unparsable."""
    data = _parse_json_dict(secret)
    oauth = data.get("claudeAiOauth") if data else None
    expires = oauth.get("expiresAt") if isinstance(oauth, dict) else None
    if isinstance(expires, bool) or not isinstance(expires, (int, float)):
        return None
    return float(expires)


def _claude_home_secret_is_fresher(home_secret: str | None, slot_secret: str) -> bool:
    """True when the first credential's token expiry is at least as new as the
    second's. Anthropic OAuth refresh tokens rotate, and a legacy profile home
    was refreshed in place by its running CLI while the slot only changed on
    capture/harvest — so the profile-home promotion (and the stale-home-copy
    check in ``harvest_login_home``) must prefer the home copy unless the slot
    is strictly newer (a fresh re-login harvest). When either side has no
    parsable expiry the comparison is impossible and returns False ("cannot
    prove fresher")."""
    home_exp = _claude_oauth_expires_at(home_secret)
    slot_exp = _claude_oauth_expires_at(slot_secret)
    return home_exp is not None and slot_exp is not None and home_exp >= slot_exp


def _claude_credential_is_wiped(secret: str | None) -> bool:
    """True when a claude credentials JSON keeps its ``claudeAiOauth`` wrapper
    but holds neither token. Claude Code empties ``accessToken`` and
    ``refreshToken`` in place when the server rejects a refresh
    (``invalid_grant``), leaving a structurally valid blob that carries no
    credential at all. Such a blob must never be mirrored into a slot: it would
    replace that account's only surviving refresh token with empty strings and
    the account could only be recovered by signing in again."""
    data = _parse_json_dict(secret)
    oauth = data.get("claudeAiOauth") if data else None
    if not isinstance(oauth, dict):
        return False
    return not (oauth.get("accessToken") or oauth.get("refreshToken"))


class CredentialVaultError(RuntimeError):
    """A credential read/write against the live location or a slot failed."""


#: Shape of the injectable Keychain runner: takes the `security` argv (plus
#: optional stdin) and returns (returncode, stdout). Named for the annotation
#: on CredentialVault.__init__, which had no definition to resolve to.
SecurityRunner = Callable[..., tuple[int, str]]


def _default_security_runner(args: list[str], input_text: str | None = None) -> tuple[int, str]:
    proc = subprocess.run(
        ["/usr/bin/security", *args],
        input=input_text,
        capture_output=True,
        text=True,
        timeout=10,
    )
    out = proc.stdout
    # Always appended: besides error text, `find-generic-password -g` prints
    # the password itself on stderr.
    if proc.stderr:
        out = (out + "\n" if out else "") + proc.stderr.strip()
    return proc.returncode, out


def _kc_quote(value: str) -> str:
    """Quote a value for the `security -i` interactive command parser."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _parse_security_password(out: str) -> str:
    """The password from `security find-generic-password -g` output.

    `-w` prints a password verbatim when every byte is printable ASCII and as
    bare lowercase hex otherwise, so a plaintext secret that is itself hex
    cannot be told apart from an encoded one. `-g` marks the form instead:
    `password: "<verbatim>"` or `password: 0x<HEX>  "<escaped>"` (and a bare
    `password: ` when empty). Raises ValueError when no such line is present
    or the hex is not UTF-8.
    """
    for line in reversed(out.splitlines()):
        if not line.startswith("password:"):
            continue
        value = line[len("password:"):].removeprefix(" ")
        if value.startswith("0x"):
            return bytes.fromhex(value[2:].split(" ", 1)[0]).decode("utf-8")
        if len(value) >= 2 and value[0] == value[-1] == '"':
            return value[1:-1]
        if not value.strip():
            return ""
        break
    raise ValueError("no password line in security output")


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def _read_private_text(path: Path) -> str | None:
    """A file written by ``_write_private``; None when absent or unreadable."""
    try:
        return secret_files.read_private(path).decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _write_private(path: Path, text: str) -> None:
    """Atomically write an owner-only file this vault alone reads back (a
    slot or app secret): the content lands in a same-directory tmp file
    that then replaces the target, so a crash or a full disk mid-write can
    never leave a truncated or world-readable secret. Read it back with
    ``_read_private_text`` — the platform may wrap the content."""
    secret_files.write_private(path, text.encode("utf-8"))


def _write_live_file(path: Path, text: str) -> None:
    """Same guarantees, plain content: the CLI itself reads this file."""
    secret_files.write_private_plain(path, text.encode("utf-8"))


def _link_target(raw: str) -> str:
    """A symlink's target as it was written: Windows' ``os.readlink`` returns
    it as an extended-length path (``\\\\?\\`` / ``\\\\?\\UNC\\``), which never
    equals the plain path the link was created from."""
    if raw.startswith("\\\\?\\UNC\\"):
        return "\\\\" + raw[len("\\\\?\\UNC\\"):]
    if raw.startswith("\\\\?\\"):
        return raw[len("\\\\?\\"):]
    return raw


def legacy_claude_keychain_service(config_dir: Path | str) -> str:
    """Keychain service Claude Code used under CLAUDE_CONFIG_DIR isolation:
    the fixed service name suffixed with sha256(config-dir string)[:8]."""
    digest = hashlib.sha256(canonical_path_str(config_dir).encode("utf-8")).hexdigest()
    return f"{CLAUDE_LIVE_KEYCHAIN_SERVICE}-{digest[:8]}"


@dataclass
class LiveCredentials:
    """A point-in-time credential snapshot for one agent.

    ``secret`` is the raw credential payload (JSON text) or ``None`` when
    logged out. ``account`` is claude's display-only ``oauthAccount`` object.
    """

    secret: str | None = None
    account: dict | None = None


class CredentialVault:
    def __init__(
        self,
        *,
        root: Path | None = None,
        real_home: Path | None = None,
        security_runner: SecurityRunner | None = None,
        platform: str | None = None,
        stores=None,
    ) -> None:
        self._root = Path(canonical_path_str(root or default_profiles_root()))
        self._real_home = Path(real_home or Path.home())
        self._security = security_runner or _default_security_runner
        self._platform = platform or sys.platform
        self._switch_locks: dict[str, asyncio.Lock] = {}
        self.stores = stores
        # Account dirs whose login a pane reported expired, keyed to the
        # login's change stamp at that moment (see mark_account_dir_expired).
        self._expired_dir_logins: dict[str, str] = {}

    def switch_lock(self, agent_key: str) -> asyncio.Lock:
        """Per-agent lock serializing credential swaps and opportunistic
        harvests against the shared OS credential locations (Keychain / files).
        Concurrent switches on the same agent — multiple windows, or a switch
        racing the usage poller's harvest — would otherwise interleave their
        capture/restore steps and clobber a slot (worst case: the ``__default__``
        original login). Acquire in the event loop before any ``switch``/
        ``harvest`` call. Kept on the instance so each test gets a fresh lock
        bound to its own event loop."""
        lock = self._switch_locks.get(agent_key)
        if lock is None:
            lock = asyncio.Lock()
            self._switch_locks[agent_key] = lock
        return lock

    # ---- locations ----

    @property
    def _is_macos(self) -> bool:
        return self._platform == "darwin"

    def slot_dir(self, agent_key: str, slot_id: str) -> Path:
        return self._root / agent_key / slot_id

    def _slot_service(self, agent_key: str, slot_id: str) -> str:
        return f"{_SLOT_SERVICE_PREFIX}{agent_key}-{slot_id}"

    def require_store_mutation(self, agent_key: str) -> None:
        if self.stores is not None:
            self.stores.require_mutation(agent_key)

    def _live_file(self, agent_key: str) -> Path:
        if self.stores is not None and self.stores.enabled(agent_key):
            return self.stores.path(agent_key)
        spec = _cli_vendor_spec(agent_key)
        if spec is not None and spec.live_file_resolver is not None:
            try:
                return spec.live_file_resolver(self._real_home)
            except ValueError as err:
                # The vendor knows the layout in use cannot be swapped
                # (droid's per-directory key-file mode): say so, do nothing.
                raise CredentialVaultError(f"{agent_key}: {err}") from err
        if agent_key not in _LIVE_FILES:
            raise CredentialVaultError(f"{agent_key} has no live credential file on this platform")
        return self._real_home.joinpath(*_LIVE_FILES[agent_key])

    def _claude_config_json(self) -> Path:
        return self._real_home / ".claude.json"

    # ---- Keychain primitives (injectable runner; never the real Keychain
    # in tests) ----

    def _keychain_read(
        self, service: str, *, strict: bool = False, account: str | None = None
    ) -> str | None:
        """Read a generic-password item. A missing item (exit code 44 /
        "could not be found") is a legitimate signed-out state and returns
        None. Any other failure (locked keychain, denied access, timeout) is
        indistinguishable from signed-out, so with ``strict=True`` it raises
        instead — capture paths must never mistake a transient read failure
        for a logout and erase the slot. Read-only display paths keep the
        lax default (a transient failure shows as signed-out, harmless).
        ``account`` narrows the lookup to one account attribute — a vendor
        that keeps several logins under one service name (copilot) needs it,
        and a vendor sharing a generic service name (antigravity's "gemini")
        must not read another program's item."""
        args = ["find-generic-password", "-s", service]
        if account:
            args += ["-a", account]
        try:
            rc, out = self._security(args + ["-g"], None)
        except Exception as err:  # noqa: BLE001
            if strict:
                raise CredentialVaultError(
                    f"keychain read failed for {service!r}: {err}"
                ) from err
            log.warning("keychain read %s failed: %s", service, err)
            return None
        if rc != 0:
            if rc == 44 or "could not be found" in out:
                return None  # item does not exist: signed out
            if strict:
                lines = out.strip().splitlines()
                detail = lines[-1][:200] if lines else ""
                raise CredentialVaultError(
                    f"keychain read failed for {service!r} (rc {rc})"
                    + (f": {detail}" if detail else "")
                )
            log.warning("keychain read %s failed (rc %s)", service, rc)
            return None
        try:
            secret = _parse_security_password(out)
        except ValueError as err:
            # The message only, never the error: a decode error quotes bytes.
            if strict:
                raise CredentialVaultError(
                    f"keychain read failed for {service!r}: unparsable output"
                ) from err
            log.warning("keychain read %s failed: unparsable output", service)
            return None
        return secret or None

    def _keychain_write(
        self, service: str, secret: str, *, account: str | None = None
    ) -> None:
        # Refuse a multi-line payload BEFORE touching the item: `security -i`
        # parses one command per line, so it would store everything up to the
        # first newline and fail on the rest — leaving a truncated, unusable
        # credential behind (observed: an item reduced to "{").
        if "\n" in secret:
            raise CredentialVaultError(
                f"refusing to write a multi-line secret for {service!r}"
            )
        # -U updates in place when the item already exists. The account
        # attribute mirrors what the CLIs use (the login user name).
        # Interactive mode (-i) takes the command on stdin so the secret
        # never appears in the argv, which any local process can read via
        # the process table.
        command = " ".join(
            [
                "add-generic-password",
                "-U",
                "-a", _kc_quote(account or getpass.getuser()),
                "-s", _kc_quote(service),
                "-w", _kc_quote(secret),
            ]
        )
        rc, out = self._security(["-i"], command + "\n")
        if rc != 0:
            # Last line only, truncated: enough for the security error message
            # while guaranteeing the secret (a long JSON blob) is never logged.
            lines = out.strip().splitlines()
            detail = lines[-1][:200] if lines else ""
            raise CredentialVaultError(
                f"keychain write failed for {service!r}"
                + (f": {detail}" if detail else "")
            )

    def _keychain_delete(self, service: str, *, account: str | None = None) -> None:
        # A missing item is fine — deletion is idempotent.
        args = ["delete-generic-password", "-s", service]
        if account:
            args += ["-a", account]
        self._security(args, None)

    # ---- vendor adapters (declared on the spec, mechanics here) ----

    @staticmethod
    def _switch_spec(agent_key: str):
        spec = _cli_vendor_spec(agent_key)
        return spec.account_switch if spec is not None else None

    def _require_scope(self, agent_key: str, scope: str | None) -> str | None:
        """Validate a profile's provider ``scope`` against the vendor's
        declaration. A per-provider store demands one of its declared scopes
        — never an arbitrary client string, never a whole-file fallback that
        would carry other providers along; every other vendor takes none."""
        switch = self._switch_spec(agent_key)
        scopes = switch.scopes if switch is not None else ()
        if scopes:
            if scope is None and len(scopes) == 1:
                # One declared provider: a caller predating the scope field
                # (and every profile of that vendor) can only mean it.
                return scopes[0]
            if scope not in scopes:
                raise CredentialVaultError(
                    f"{agent_key} needs a provider scope from {list(scopes)}, got {scope!r}"
                )
            return scope
        if scope:
            raise CredentialVaultError(f"{agent_key} takes no provider scope, got {scope!r}")
        return None

    def _is_vendor_keychain(self, agent_key: str) -> bool:
        """True when this vendor's live secret is one or more macOS Keychain
        items declared on its spec (claude keeps its own branches)."""
        switch = self._switch_spec(agent_key)
        return (
            agent_key != "claude"
            and self._is_macos
            and switch is not None
            and switch.store == "keychain"
            and bool(switch.keychain_items)
        )

    def _read_vendor_keychain(self, agent_key: str, *, strict: bool) -> str | None:
        """Every declared item as one JSON payload ``{"keychain": {"<service>|<account>": secret}}``
        — the slot stores exactly this so a restore puts each item back where
        it came from. None when no item exists (signed out)."""
        switch = self._switch_spec(agent_key)
        found: dict[str, str] = {}
        for service, account in switch.keychain_items:
            value = self._keychain_read(service, strict=strict, account=account or None)
            if value is not None:
                found[f"{service}|{account}"] = value
        if not found:
            return None
        return json.dumps({"keychain": found}, separators=(",", ":"))

    def _write_vendor_keychain(self, agent_key: str, secret: str | None) -> None:
        switch = self._switch_spec(agent_key)
        items = _parse_json_dict(secret)
        stored = items.get("keychain") if items else None
        if secret is not None and not isinstance(stored, dict):
            raise CredentialVaultError(
                f"{agent_key} slot payload is not a keychain item map"
            )
        for service, account in switch.keychain_items:
            value = stored.get(f"{service}|{account}") if isinstance(stored, dict) else None
            if isinstance(value, str) and value:
                self._keychain_write(service, value, account=account or None)
            else:
                self._keychain_delete(service, account=account or None)

    def _extract(self, agent_key: str, document: str | None, scope: str) -> str | None:
        switch = self._switch_spec(agent_key)
        try:
            return switch.extract(document, scope)
        except Exception as err:  # noqa: BLE001 — a vendor bug must not look like a logout
            raise CredentialVaultError(f"{agent_key} credential extract failed: {err}") from err

    def _merge(self, agent_key: str, document: str | None, scope: str, portion: str | None) -> str:
        switch = self._switch_spec(agent_key)
        try:
            merged = switch.merge(document, scope, portion)
        except Exception as err:  # noqa: BLE001
            raise CredentialVaultError(f"{agent_key} credential merge failed: {err}") from err
        if not isinstance(merged, str):
            raise CredentialVaultError(f"{agent_key} credential merge returned no document")
        return merged

    # ---- live credentials ----

    def read_live(
        self, agent_key: str, *, strict: bool = False, scope: str | None = None
    ) -> LiveCredentials:
        """``strict=True`` raises on a transient Keychain failure instead of
        reporting signed-out — required on capture paths (see _keychain_read).
        ``scope`` selects one provider entry of a per-provider store (see
        ``_require_scope``); the secret is then that entry alone."""
        if agent_key == "claude":
            secret = (
                self._keychain_read(CLAUDE_LIVE_KEYCHAIN_SERVICE, strict=strict)
                if self._is_macos else None
            )
            if secret is None:
                secret = _read_text(self._live_file("claude"))
            return LiveCredentials(secret=secret, account=self._read_live_oauth_account())
        scope = self._require_scope(agent_key, scope)
        if self._is_vendor_keychain(agent_key):
            return LiveCredentials(secret=self._read_vendor_keychain(agent_key, strict=strict))
        document = _read_text(self._live_file(agent_key))
        if scope is not None:
            return LiveCredentials(secret=self._extract(agent_key, document, scope))
        return LiveCredentials(secret=document)

    def write_live(
        self, agent_key: str, creds: LiveCredentials, *, scope: str | None = None
    ) -> None:
        self.require_store_mutation(agent_key)
        if agent_key == "claude":
            if creds.secret is None:
                if self._is_macos:
                    self._keychain_delete(CLAUDE_LIVE_KEYCHAIN_SERVICE)
                self._live_file("claude").unlink(missing_ok=True)
            elif self._is_macos:
                self._keychain_write(CLAUDE_LIVE_KEYCHAIN_SERVICE, creds.secret)
                # Stale file credentials would shadow-report the old account.
                self._live_file("claude").unlink(missing_ok=True)
            else:
                _write_live_file(self._live_file("claude"), creds.secret)
            self._write_live_oauth_account(creds.account)
            return
        scope = self._require_scope(agent_key, scope)
        if self._is_vendor_keychain(agent_key):
            self._write_vendor_keychain(agent_key, creds.secret)
            return
        if scope is not None:
            # Targeted rewrite: only this provider's entry changes; the rest
            # of the CLI's document (other providers, settings, comments) is
            # carried through by the vendor's ``merge``.
            path = self._live_file(agent_key)
            merged = self._merge(agent_key, _read_text(path), scope, creds.secret)
            switch = self._switch_spec(agent_key)
            companions: tuple[tuple[Path, str | None], ...] = ()
            if switch is not None and switch.companion_writes is not None:
                # Derived before anything is written: a refusal here (mcode's
                # region guard) leaves the live store exactly as it was.
                try:
                    companions = switch.companion_writes(path, merged, scope)
                except Exception as err:  # noqa: BLE001
                    raise CredentialVaultError(
                        f"{agent_key} companion credential files failed: {err}"
                    ) from err
            _write_live_file(path, merged)
            for companion_path, text in companions:
                if text is None:
                    companion_path.unlink(missing_ok=True)
                else:
                    _write_live_file(companion_path, text)
            return
        if creds.secret is None:
            self._live_file(agent_key).unlink(missing_ok=True)
        else:
            _write_live_file(self._live_file(agent_key), creds.secret)

    def clear_live(self, agent_key: str, *, scope: str | None = None) -> None:
        self.write_live(agent_key, LiveCredentials(), scope=scope)

    # ---- app secrets (not tied to a CLI vendor or an account slot) ----

    def _app_secret_suffix(self) -> str:
        """`@<digest>` for a backend running beside the shipped install, else "".

        Keyed on the **data directory**, which is the thing that actually makes
        two backends separate: ``AGENT_TEAM_DATA_DIR`` is what the dev launcher
        sets, and what a packaged build under test is given.

        This used to be keyed on ``self._root``, the CLI-profiles root — and
        that root is ``~/.navide/cli-profiles`` for every process, because
        nothing passes one (``app.py`` constructs ``CredentialVault()`` with no
        argument) and it is not derived from the data directory. So the branch
        was unreachable: a dev backend and the installed app computed the same
        service name, exactly what the docstring said it had fixed. Two runs
        with different ``AGENT_TEAM_DATA_DIR`` values are now the test.

        What that cost, on this machine, on 2026-09-05: a packaged backend
        started a few times for release checks wrote the shared
        ``navide-device-trust`` entry under its own code signature; the Keychain
        ACL followed the writer, the dev backend could no longer read the item
        it could still see, and the trust store failed closed with every pairing
        gone.

        The default install keeps the unsuffixed name. That is the whole reason
        for the branch: suffixing unconditionally would be tidier and would sign
        out every shipped install exactly once, to fix a collision only a second
        data directory can cause.
        """
        current = canonical_path_str(app_data_dir())
        if current == canonical_path_str(default_app_data_dir()):
            return ""
        return "@" + hashlib.sha256(current.encode("utf-8")).hexdigest()[:8]

    def app_secret_path(self, name: str) -> Path:
        """The file fallback, isolated the same way and for the same reason.

        Isolating only the Keychain would leave two backends sharing this file:
        it is read whenever the Keychain has no answer, and it is the whole
        story on a platform that has no Keychain.
        """
        return self._root / (_APP_SECRET_DIRNAME + self._app_secret_suffix()) / _filename_for(name)

    def app_secret_service(self, name: str) -> str:
        """Keychain service for a backend-owned secret, per data directory."""
        return _APP_SECRET_SERVICE_PREFIX + name + self._app_secret_suffix()

    def read_app_secret(self, name: str) -> str | None:
        """Read a backend-owned secret, or None when it was never stored.

        **Strict, and on macOS the file is not a fallback.** Both halves of that
        sentence were the other way round, and together they made one hole.

        Strict, because a locked keychain, a dismissed authorisation dialog and
        a ``security`` timeout all used to come back as ``None`` — the same
        answer as "never stored". A caller cannot tell those apart and the two
        demand opposite responses: one is "wait and try again", the other is
        "this machine has nothing". The two misreadings do not cost the same
        either, which is what settles the direction: reading a transient failure
        as "nothing" sends a caller down a path that erases real state, while
        reading a genuine absence as a failure costs one retry. Anything that is
        not an unambiguous "no such item" is therefore a failure.

        And on macOS the file is not consulted at all, because on macOS the file
        is never *written*: ``write_app_secret`` deletes it after every Keychain
        write, precisely so a leftover cannot shadow the real item. A file
        present on this platform is therefore a leftover from another one or
        something somebody put there — never content this program authenticated.
        Reading it was the only thing giving it any authority.
        """
        if self._is_macos:
            return self._keychain_read(self.app_secret_service(name), strict=True)
        return _read_private_text(self.app_secret_path(name))

    def write_app_secret(self, name: str, secret: str | None) -> None:
        """Store *secret*, or erase it when None. ``_keychain_write`` refuses a
        multi-line payload, so a caller serialising JSON must keep it on one
        line."""
        if secret is None:
            if self._is_macos:
                self._keychain_delete(self.app_secret_service(name))
            self.app_secret_path(name).unlink(missing_ok=True)
            return
        if self._is_macos:
            self._keychain_write(self.app_secret_service(name), secret)
            # A leftover file from a run on another platform would shadow the
            # Keychain item on the next read.
            self.app_secret_path(name).unlink(missing_ok=True)
        else:
            _write_private(self.app_secret_path(name), secret)

    def _read_live_oauth_account(self, *, strict: bool = False) -> dict | None:
        raw = _read_text(self._claude_config_json())
        if raw is None:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            if strict:
                raise
            return None
        account = data.get("oauthAccount") if isinstance(data, dict) else None
        return account if isinstance(account, dict) else None

    def _write_live_oauth_account(self, account: dict | None) -> None:
        """Set/remove the top-level ``oauthAccount`` in ``~/.claude.json``,
        preserving every other key. Written atomically (same-directory tmp
        file + ``os.replace``, keeping the original file's mode) — this file
        is the user's whole Claude config, and a crash or full disk mid-write
        must never corrupt it."""
        path = self._claude_config_json()
        raw = _read_text(path)
        try:
            data = json.loads(raw) if raw is not None else {}
        except ValueError:
            log.warning("%s is not valid JSON; leaving oauthAccount untouched", path)
            return
        if not isinstance(data, dict):
            return
        if account is None:
            if "oauthAccount" not in data:
                return
            data.pop("oauthAccount")
        else:
            data["oauthAccount"] = account
        tmp = path.with_name(path.name + ".tmp")
        try:
            mode = path.stat().st_mode & 0o777
        except OSError:
            mode = None
        try:
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            if mode is not None:
                os.chmod(tmp, mode)
            os.replace(tmp, path)
        except OSError as err:
            tmp.unlink(missing_ok=True)
            raise CredentialVaultError(f"cannot update {path}: {err}") from err

    # ---- slots ----

    def read_slot(
        self, agent_key: str, slot_id: str, *, scope: str | None = None
    ) -> LiveCredentials:
        slot = self.slot_dir(agent_key, slot_id)
        if agent_key == "claude":
            if self._is_macos:
                secret = self._keychain_read(self._slot_service(agent_key, slot_id))
            else:
                secret = _read_private_text(slot / _SLOT_FILES["claude"])
            account_raw = _read_private_text(slot / _OAUTH_ACCOUNT_SLOT_FILE)
            account = None
            if account_raw is not None:
                try:
                    parsed = json.loads(account_raw)
                    account = parsed if isinstance(parsed, dict) else None
                except ValueError:
                    account = None
            return LiveCredentials(secret=secret, account=account)
        scope = self._require_scope(agent_key, scope)
        stored = _read_private_text(slot / _SLOT_FILES[agent_key])
        if scope is not None:
            # A per-provider slot document has the vendor's own shape, one
            # key per scope, so the reserved ``__default__`` slot can park
            # several providers side by side without one overwriting another.
            return LiveCredentials(secret=self._extract(agent_key, stored, scope))
        return LiveCredentials(secret=stored)

    def _claude_profile_home_secret(self, slot_id: str) -> str | None:
        """The credential a managed claude profile's own persistent home holds
        — the copy a running CLI refreshes in place. None when the home has
        none (no pane has run for this profile yet)."""
        home = self.profile_home_path("claude", slot_id)
        return (
            self._keychain_read(legacy_claude_keychain_service(home))
            if self._is_macos
            else _read_text(home / ".credentials.json")
        )

    def resolve_claude_credentials(
        self, slot_id: str, *, active: bool
    ) -> LiveCredentials:
        """Read the credential a Claude account currently uses: the active
        account owns the live location, a parked account its slot snapshot.
        Read-only: never captures, restores, switches, or writes credentials.
        """
        return self.read_live("claude") if active else self.read_slot("claude", slot_id)

    def write_slot(
        self,
        agent_key: str,
        slot_id: str,
        creds: LiveCredentials,
        *,
        scope: str | None = None,
    ) -> None:
        slot = self.slot_dir(agent_key, slot_id)
        if agent_key == "claude":
            # A wiped credential holds no token to store, and writing it would
            # replace the account's only surviving refresh token with empty
            # strings (see ``_claude_credential_is_wiped``). Every path that
            # mirrors a credential into a slot — switch capture, login-home and
            # legacy-home harvest, startup promotion — funnels through here, so
            # the guard lives here rather than at each call site. The stored
            # secret is left as it is; the display-only account still updates.
            # An explicit ``None`` keeps clearing the slot: that is a real
            # sign-out, not a wipe.
            wiped = _claude_credential_is_wiped(creds.secret)
            if wiped:
                log.warning(
                    "refusing to store a wiped claude credential in slot %s; "
                    "keeping the one already stored", slot_id,
                )
            if self._is_macos:
                service = self._slot_service(agent_key, slot_id)
                if creds.secret is None:
                    self._keychain_delete(service)
                elif not wiped:
                    self._keychain_write(service, creds.secret)
            elif creds.secret is None:
                (slot / _SLOT_FILES["claude"]).unlink(missing_ok=True)
            elif not wiped:
                _write_private(slot / _SLOT_FILES["claude"], creds.secret)
            account_file = slot / _OAUTH_ACCOUNT_SLOT_FILE
            if creds.account is None:
                account_file.unlink(missing_ok=True)
            else:
                _write_private(account_file, json.dumps(creds.account, indent=2))
            return
        scope = self._require_scope(agent_key, scope)
        target = slot / _SLOT_FILES[agent_key]
        if scope is not None:
            merged = self._merge(agent_key, _read_private_text(target), scope, creds.secret)
            _write_private(target, merged)
            return
        if creds.secret is None:
            target.unlink(missing_ok=True)
        else:
            _write_private(target, creds.secret)

    def slot_is_empty(
        self, agent_key: str, slot_id: str, *, scope: str | None = None
    ) -> bool:
        return self.read_slot(agent_key, slot_id, scope=scope).secret is None

    def slot_account(self, agent_key: str, slot_id: str) -> dict | None:
        """The slot's display-only account info (claude's ``oauthAccount``)."""
        return self.read_slot(agent_key, slot_id).account

    def live_account(self, agent_key: str, *, strict: bool = False) -> dict | None:
        """The live display-only account info — claude's ``oauthAccount`` in
        ``~/.claude.json``, read WITHOUT touching the Keychain. The credential
        watcher re-reads this on every write to that file (Claude Code rewrites
        it constantly), and telling one account from another needs no secret.
        None for the other agents, which have no such block. ``strict=True``
        raises on unparsable JSON (a file caught mid-write) instead of reading
        it as signed out."""
        return self._read_live_oauth_account(strict=strict) if agent_key == "claude" else None

    def identity(
        self,
        agent_key: str,
        slot_id: str | None = None,
        *,
        scope: str | None = None,
        strict: bool = False,
    ) -> dict:
        """Display-only identity for one account slot (``slot_id=None`` = the
        live state, i.e. the currently active account). ``signedIn`` reflects
        whether an actual credential secret exists — a claude blob Claude Code
        wiped in place carries none, so it does not count (see
        ``_claude_credential_is_wiped``). claude's ``oauthAccount`` email is
        display-only (a long-lived-token login carries no oauthAccount but is
        still signed in). Reads files — plus, for
        claude on macOS, the Keychain — so call off the event loop.
        Returns ``{"email": str | None, "signedIn": bool}``; never raises unless
        ``strict=True``, which surfaces a failed read (a transient Keychain
        failure included) instead of reporting it as signed out."""
        try:
            if agent_key == "claude":
                # The active row reads the live state (~/.claude.json account
                # + live secret), a parked row its slot snapshot.
                base = (
                    self.read_live("claude", strict=strict) if slot_id is None
                    else self.read_slot("claude", slot_id)
                )
                email = (
                    base.account.get("emailAddress")
                    if isinstance(base.account, dict) else None
                )
                email = email if isinstance(email, str) and email else None
                signed_in = (
                    base.secret is not None
                    and not _claude_credential_is_wiped(base.secret)
                )
                return {"email": email, "signedIn": signed_in}
            spec = _cli_vendor_spec(agent_key)
            switch = spec.account_switch if spec is not None else None
            if scope is None and switch is not None and len(switch.scopes) > 1:
                # The CLI as a whole (no provider named): signed in when ANY
                # declared provider entry holds a credential. The scoped
                # answer is what the accounts UI and the switch use; this one
                # keeps the spawn-time "signed out" advisory honest.
                return {
                    "email": None,
                    "signedIn": any(
                        self.identity(agent_key, slot_id, scope=candidate, strict=strict)["signedIn"]
                        for candidate in switch.scopes
                    ),
                }
            if slot_id is None:
                secret = self.read_live(agent_key, strict=strict, scope=scope).secret
            else:
                secret = self.read_slot(agent_key, slot_id, scope=scope).secret
            if spec is not None and spec.identity_from_secret is not None:
                return spec.identity_from_secret(secret)
            # kimi (and any future agent without an identity field): presence
            # of a token is all we can show.
            data = _parse_json_dict(secret)
            return {"email": None, "signedIn": bool(data and data.get("access_token"))}
        except Exception:  # noqa: BLE001 — identity is display-only, never fatal
            if strict:
                raise
            return {"email": None, "signedIn": False}

    # ---- account switching ----

    def capture(
        self, agent_key: str, slot_id: str, *, scope: str | None = None
    ) -> LiveCredentials:
        """Mirror the live credential state — the credentials ``slot_id``
        currently runs on — into the slot (a logged-out state empties the
        slot). Returns the snapshot. Reads strictly: a transient Keychain
        failure aborts BEFORE any slot is written — emptying the slot on a
        misread would lose the account's token globally. A claude credential
        whose tokens Claude Code wiped in place leaves the slot's stored secret
        alone (``write_slot``); the returned snapshot still mirrors the live
        state so callers can roll it back."""
        self.require_store_mutation(agent_key)
        creds = self.read_live(agent_key, strict=True, scope=scope)
        self.write_slot(agent_key, slot_id, creds, scope=scope)
        return creds

    def restore(self, agent_key: str, slot_id: str, *, scope: str | None = None) -> None:
        """Make ``slot_id`` the active account: its slot content becomes the
        live credentials, and an empty slot clears them (the CLI then prompts
        a fresh login)."""
        self.write_live(agent_key, self.read_slot(agent_key, slot_id, scope=scope), scope=scope)

    def switch(
        self,
        agent_key: str,
        from_slot_id: str,
        to_slot_id: str,
        *,
        scope: str | None = None,
    ) -> None:
        """Atomically capture the outgoing account into ``from_slot_id`` and
        bring ``to_slot_id`` live. On a restore failure the captured snapshot is
        written back so the live state is never lost. ``scope`` (per-provider
        stores) names the one provider entry both sides of the swap touch."""
        outgoing = self.capture(agent_key, from_slot_id, scope=scope)
        try:
            self.restore(agent_key, to_slot_id, scope=scope)
        except Exception as err:
            try:
                self.write_live(agent_key, outgoing, scope=scope)
            except Exception as rollback_err:  # noqa: BLE001
                log.error(
                    "credential rollback for %s failed after restore error: %s",
                    agent_key, rollback_err,
                )
            raise CredentialVaultError(
                f"switching {agent_key} credentials failed: {err}"
            ) from err

    def harvest(self, agent_key: str, slot_id: str, *, scope: str | None = None) -> bool:
        """Opportunistically fill an EMPTY slot from the live credentials the
        account currently runs on (the user just logged in inside a pane).
        No-op when the slot already holds a secret or nothing is signed in — a
        claude credential whose tokens were wiped counts as nothing.
        Returns True when something was harvested."""
        self.require_store_mutation(agent_key)
        if not self.slot_is_empty(agent_key, slot_id, scope=scope):
            return False
        creds = self.read_live(agent_key, scope=scope)
        if creds.secret is None:
            return False
        if agent_key == "claude" and _claude_credential_is_wiped(creds.secret):
            return False
        self.write_slot(agent_key, slot_id, creds, scope=scope)
        return True

    def delete_slot_secrets(self, agent_key: str, slot_id: str) -> None:
        """Cleanup for a profile deletion: remove the secrets the store's
        archive-by-rename cannot carry, plus any pending login home. The store
        keeps file-based slot secrets inside the renamed slot directory, but
        claude's macOS slot Keychain item (and a claude login home's
        path-hashed item) would be stranded forever. Idempotent; call inside
        ``switch_lock(agent_key)`` BEFORE the store renames the slot dir."""
        home = self.login_home_path(agent_key, slot_id)
        if home.is_dir():
            if agent_key == "claude" and self._is_macos:
                self._keychain_delete(legacy_claude_keychain_service(home))
            shutil.rmtree(home, ignore_errors=True)
        if not self._login_isolated(agent_key) and self.login_pending(agent_key, slot_id):
            # Deleting a profile mid-sign-in: whatever the CLI wrote into the
            # live store belongs to the account being deleted, and the one
            # that was active before must come back — otherwise the next
            # switch would capture the deleted login into the active slot.
            try:
                self.discard_pending_login(agent_key, slot_id)
            except CredentialVaultError as err:
                log.warning("restoring the pre-login %s credential failed: %s", agent_key, err)
        self._pre_login_snapshot_path(agent_key, slot_id).unlink(missing_ok=True)
        if agent_key == "claude":
            if self._is_macos:
                self._keychain_delete(self._slot_service(agent_key, slot_id))
                if slot_id != DEFAULT_SLOT_ID:
                    # The account's own config-dir login is a Keychain item
                    # named after the dir; once the slot dir is archived by
                    # rename nothing can reach it, so it goes with the account.
                    self._keychain_delete(
                        legacy_claude_keychain_service(self.account_dir_path(slot_id))
                    )
            (self.slot_dir(agent_key, slot_id) / _OAUTH_ACCOUNT_SLOT_FILE).unlink(
                missing_ok=True
            )

    def harvest_legacy_claude_home(self, slot_id: str, legacy_home: Path) -> bool:
        """Capture a legacy CLAUDE_CONFIG_DIR home's credentials into a slot.

        Under CLAUDE_CONFIG_DIR isolation, Claude Code stored the secret in a
        Keychain item whose service is suffixed with a hash of the config-dir
        path (see ``legacy_claude_keychain_service``); the non-macOS fallback
        is ``<home>/.credentials.json``. Display info comes from the legacy
        home's own ``.claude.json``. Returns True when a secret was captured —
        a home whose tokens Claude Code wiped counts as having none, so the
        caller leaves it in place instead of reporting a successful capture.
        """
        secret = None
        if self._is_macos:
            secret = self._keychain_read(legacy_claude_keychain_service(legacy_home))
        if secret is None:
            secret = _read_text(legacy_home / ".credentials.json")
        account = None
        raw = _read_text(legacy_home / ".claude.json")
        if raw is not None:
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict) and isinstance(parsed.get("oauthAccount"), dict):
                    account = parsed["oauthAccount"]
            except ValueError:
                pass
        if secret is None or _claude_credential_is_wiped(secret):
            return False
        self.write_slot("claude", slot_id, LiveCredentials(secret=secret, account=account))
        if self._is_macos:
            # The slot owns the credential now; the legacy item would strand
            # a token copy in the Keychain forever (its config dir is archived
            # and no CLI reads it again). Deletion is idempotent.
            self._keychain_delete(legacy_claude_keychain_service(legacy_home))
        return True

    # ---- isolated login homes ----

    def login_home_path(self, agent_key: str, slot_id: str) -> Path:
        return self.slot_dir(agent_key, slot_id) / LOGIN_HOME_DIRNAME

    def _refresh_grok_login_shim(self, login_home: Path) -> Path:
        """Build/refresh the HOME shim for a grok login pane (shim lives one
        level in, at ``<login_home>/home``)."""
        return self._populate_grok_shim(login_home / "home")

    def _populate_grok_shim(self, shim: Path) -> Path:
        """Build/refresh a grok HOME shim at ``shim``.

        The shim mirrors every top-level entry of the real home via symlink so
        the CLI (and the pane's login shell) still sees the user's shell
        config, except ``.grok`` which is a real directory inside the shim —
        that's where grok keeps its credentials. Refreshing on every spawn
        picks up new real-home entries and drops dangling symlinks (ported from
        the pre-refactor ``refresh_grok_home_shim``)."""
        shim.mkdir(parents=True, exist_ok=True)
        (shim / ".grok").mkdir(exist_ok=True)
        # ``.grok`` stays a real dir (it holds the isolated ``auth.json``), but
        # the session database is shared: symlink grok.db (+ its sqlite -wal /
        # -shm sidecars) back to the real ~/.grok so sessions follow the user,
        # not the account.
        real_grok = self._real_home / ".grok"
        for name in ("grok.db", "grok.db-wal", "grok.db-shm"):
            self._link_shared(shim / ".grok" / name, real_grok / name, is_dir=False)
        try:
            for entry in shim.iterdir():
                if entry.is_symlink() and not entry.exists():
                    entry.unlink(missing_ok=True)
        except OSError as err:
            log.warning("grok shim cleanup in %s failed: %s", shim, err)
        try:
            real_entries = list(self._real_home.iterdir())
        except OSError as err:
            log.warning("cannot list real home %s for grok shim: %s", self._real_home, err)
            real_entries = []
        for src in real_entries:
            if src.name == ".grok":
                continue
            dst = shim / src.name
            if dst.exists() or dst.is_symlink():
                continue
            try:
                dst.symlink_to(src, target_is_directory=src.is_dir())
            except OSError as err:
                log.warning("grok shim symlink %s -> %s failed: %s", dst, src, err)
        return shim

    def _login_isolated(self, agent_key: str) -> bool:
        """Does a login pane of this CLI get its own credential store?"""
        if agent_key in ("claude", "grok"):
            return True
        spec = _cli_vendor_spec(agent_key)
        return spec is not None and spec.login_home_env is not None

    def _pre_login_snapshot_path(self, agent_key: str, slot_id: str) -> Path:
        return self.slot_dir(agent_key, slot_id) / _PRE_LOGIN_SNAPSHOT_FILE

    def login_pending(self, agent_key: str, slot_id: str) -> bool:
        """Is a sign-in for this profile started and not yet harvested? True
        for an isolated login home that still exists, and for a non-isolated
        login whose pre-login snapshot is still held. The handlers' "login in
        progress" guards must ask this, not ``login_home_path().is_dir()``,
        or a CLI without isolation is switchable mid-sign-in."""
        if self._login_isolated(agent_key):
            return self.login_home_path(agent_key, slot_id).is_dir()
        return self._pre_login_snapshot_path(agent_key, slot_id).is_file()

    def discard_pending_login(
        self, agent_key: str, slot_id: str, *, scope: str | None = None
    ) -> bool:
        """End a sign-in that was cancelled, failed or timed out. A completed
        write is still parked (never lost), the pre-login credential is put
        back, and the pending marker is removed. Returns True when a
        credential was parked. Isolated logins keep their home for the
        ordinary harvest; only the non-isolated kind needs this."""
        if self._login_isolated(agent_key):
            return False
        parked = self.harvest_login_home(agent_key, slot_id, scope=scope)
        self._pre_login_snapshot_path(agent_key, slot_id).unlink(missing_ok=True)
        return parked

    def _pre_login_snapshot(self, agent_key: str, slot_id: str) -> tuple[bool, str | None, str | None]:
        """``(present, secret, scope)`` of the snapshot a non-isolated login
        holds; ``present`` False when there is none."""
        raw = _read_private_text(self._pre_login_snapshot_path(agent_key, slot_id))
        data = _parse_json_dict(raw)
        if data is None or "secret" not in data:
            return False, None, None
        secret = data.get("secret")
        scope = data.get("scope")
        return (
            True,
            secret if isinstance(secret, str) else None,
            scope if isinstance(scope, str) else None,
        )

    def login_spawn_env(
        self, agent_key: str, slot_id: str, *, scope: str | None = None
    ) -> tuple[dict[str, str], list[str]]:
        """Env for spawning ``agent_key``'s login pane inside the profile's
        isolated login home: ``(env_set, env_remove)``. Creates the login home
        (0700 — it will hold fresh credentials). A CLI with no way to relocate
        its credential file gets no isolation — an empty pair means "sign in
        against the real home" — and its login home holds only a snapshot of
        the live credential taken now (see ``_PRE_LOGIN_SNAPSHOT_FILE``).
        ``scope`` is the profile's provider scope for a per-provider store.
        Blocking I/O — call off the event loop."""
        self.require_store_mutation(agent_key)
        if agent_key not in _SLOT_FILES:
            raise ValueError(f"unsupported agent for CLI login homes: {agent_key!r}")
        spec = _cli_vendor_spec(agent_key)
        if not self._login_isolated(agent_key):
            # No isolation lever exists for this CLI (kilo: only the
            # general-purpose XDG_DATA_HOME, which would relocate every
            # XDG-aware program in the pane; copilot/cursor/antigravity keep
            # one machine-wide store). The sign-in runs against the real home
            # and REPLACES the live credential, so the active account's copy
            # is snapshotted first, into a login home that exists for that
            # snapshot alone (and so the switch handler and the poller treat
            # the profile as "login pending" until it is harvested).
            scope = self._require_scope(agent_key, scope)
            live = self.read_live(agent_key, strict=True, scope=scope)
            _write_private(
                self._pre_login_snapshot_path(agent_key, slot_id),
                json.dumps({"secret": live.secret, "scope": scope}),
            )
            return {}, []
        home = self.login_home_path(agent_key, slot_id)
        secret_files.make_private_dir(home)  # the home will hold fresh secrets
        home_str = canonical_path_str(home)
        if agent_key == "claude":
            # Claude derives its Keychain item name from the literal
            # CLAUDE_CONFIG_DIR string; the canonical path here must match the
            # one harvest_login_home hashes later, byte for byte.
            return {"CLAUDE_CONFIG_DIR": home_str}, list(CLAUDE_ENV_OVERRIDES)
        if spec is not None and spec.login_home_env is not None:
            return {spec.login_home_env: home_str}, []
        # grok: HOME shim; its .grok dir lives one level in.
        shim = self._refresh_grok_login_shim(Path(home_str))
        return {"HOME": canonical_path_str(shim)}, []

    def login_secret_present(
        self, agent_key: str, slot_id: str, *, scope: str | None = None
    ) -> bool:
        """True when the isolated login home already holds the CLI's secret
        file (file-based agents only — claude's Keychain secret has no cheap
        peek and its sign-in command exits on completion anyway). For a
        per-provider store the file must hold the profile's scope entry."""
        if not self._login_isolated(agent_key):
            # The CLI wrote to the live store: the login is complete once the
            # live credential differs from the pre-login snapshot.
            present, before, snap_scope = self._pre_login_snapshot(agent_key, slot_id)
            if not present:
                return False
            try:
                live = self.read_live(agent_key, scope=scope or snap_scope).secret
            except CredentialVaultError:
                return False
            return live is not None and live != before
        segments = _LOGIN_HOME_SECRET_FILES.get(agent_key)
        if segments is None:
            return False
        path = self.login_home_path(agent_key, slot_id).joinpath(*segments)
        if not path.is_file():
            return False
        scope = self._require_scope(agent_key, scope)
        if scope is None:
            return True
        try:
            return self._extract(agent_key, _read_text(path), scope) is not None
        except CredentialVaultError:
            return False

    def _login_home_is_stale(self, agent_key: str, slot_id: str, home: Path) -> bool:
        """True when the slot already holds a NEWER credential than the login
        home — an old leftover home (e.g. found by the startup sweep long
        after a later re-login) must not overwrite it. Conservative: an empty
        slot or any missing mtime keeps the normal overwrite behavior.
        claude's Keychain entries carry no mtime, so the home directory itself
        stands in for the home's secret and the slot's ``oauth-account.json``
        for the slot's."""
        if not self._login_isolated(agent_key):
            return False
        try:
            if agent_key == "claude":
                if self.read_slot("claude", slot_id).secret is None:
                    return False
            elif _read_private_text(
                self.slot_dir(agent_key, slot_id) / _SLOT_FILES[agent_key]
            ) is None:
                return False
            slot = self.slot_dir(agent_key, slot_id)
            if agent_key == "claude":
                home_mtime = home.stat().st_mtime
                slot_mtime = (slot / _OAUTH_ACCOUNT_SLOT_FILE).stat().st_mtime
            else:
                home_mtime = home.joinpath(
                    *_LOGIN_HOME_SECRET_FILES[agent_key]
                ).stat().st_mtime
                slot_mtime = (slot / _SLOT_FILES[agent_key]).stat().st_mtime
        except OSError:
            return False
        return home_mtime < slot_mtime

    def harvest_login_home(
        self, agent_key: str, slot_id: str, *, scope: str | None = None
    ) -> bool:
        """Capture a finished isolated login into the profile's slot.

        Overwrites the slot — the user just re-logged this account, so the
        login home's credentials win over whatever the slot held — unless the
        home is STALE (the slot was re-signed after the home was written), in
        which case the home is discarded untouched. On success the login home
        is deleted; a login home without credentials yet (login still in
        progress or abandoned) is a no-op and stays for a later poll. Call
        inside ``switch_lock(agent_key)``."""
        if not self._login_isolated(agent_key):
            # The CLI signed in against the live store. Park what it wrote
            # into this profile's slot and put the pre-login credential back
            # so the account that was active stays active (and its own slot
            # untouched); switching to the new account is a separate, normal
            # switch. Nothing written yet = login still pending: no-op. The
            # slot is written BEFORE the live store is touched, so a failure
            # in between leaves the new login parked and the old one live.
            present, before, snap_scope = self._pre_login_snapshot(agent_key, slot_id)
            if not present:
                return False
            scope = self._require_scope(agent_key, scope if scope is not None else snap_scope)
            live = self.read_live(agent_key, strict=True, scope=scope)
            if live.secret is None or live.secret == before:
                return False
            self.write_slot(agent_key, slot_id, live, scope=scope)
            self.write_live(agent_key, LiveCredentials(secret=before), scope=scope)
            self._pre_login_snapshot_path(agent_key, slot_id).unlink(missing_ok=True)
            return True
        home = self.login_home_path(agent_key, slot_id)
        if not home.is_dir():
            return False
        if self._login_home_is_stale(agent_key, slot_id, home):
            log.info("discarding stale %s login home for slot %s", agent_key, slot_id)
            if agent_key == "claude" and self._is_macos:
                self._keychain_delete(legacy_claude_keychain_service(home))
            shutil.rmtree(home, ignore_errors=True)
            return False
        if agent_key == "claude":
            # Same locations as a legacy CLAUDE_CONFIG_DIR home: path-hashed
            # Keychain item (deleted after capture) or .credentials.json, plus
            # the home's own .claude.json for the display-only oauthAccount.
            if not self.harvest_legacy_claude_home(slot_id, home):
                return False
            # The user just re-logged this account, so the login must win. The
            # legacy profile-home promotion (promote_profile_home_secrets)
            # keeps a home copy whose expiry is not older than the slot's — an
            # obsolete copy whose expiresAt outlives the new login's (e.g. a
            # revoked long-lived token with a far-future expiry) would shadow
            # the fresh login at every startup. Drop the home copy only in
            # that case; otherwise leave it for any still-running panes
            # spawned in this profile's home before the unification.
            profile_home = self.profile_home_path(agent_key, slot_id)
            new_secret = self.read_slot("claude", slot_id).secret
            home_service = legacy_claude_keychain_service(profile_home)
            home_file = profile_home / ".credentials.json"
            home_secret = (
                self._keychain_read(home_service) if self._is_macos else _read_text(home_file)
            )
            if (
                new_secret is not None
                and home_secret != new_secret
                and _claude_home_secret_is_fresher(home_secret, new_secret)
            ):
                if self._is_macos:
                    self._keychain_delete(home_service)
                else:
                    try:
                        home_file.unlink(missing_ok=True)
                    except OSError as err:
                        log.warning("stale profile-home credential cleanup failed: %s", err)
        else:
            scope = self._require_scope(agent_key, scope)
            secret = _read_text(home.joinpath(*_LOGIN_HOME_SECRET_FILES[agent_key]))
            if secret is not None and scope is not None:
                secret = self._extract(agent_key, secret, scope)
            if secret is None:
                return False
            self.write_slot(agent_key, slot_id, LiveCredentials(secret=secret), scope=scope)
        shutil.rmtree(home, ignore_errors=True)
        return True

    # ---- per-account config dirs (claude) ----

    def account_dir_path(self, slot_id: str) -> Path:
        """The claude account's own ``CLAUDE_CONFIG_DIR``. Byte-for-byte
        stable: Claude Code names the Keychain item after a hash of this exact
        string. The built-in Default account is the real ``~/.claude`` and has
        none."""
        if not slot_id or slot_id == DEFAULT_SLOT_ID:
            raise ValueError("the Default account uses the real ~/.claude")
        return Path(canonical_path_str(self.slot_dir("claude", slot_id) / ACCOUNT_DIR_DIRNAME))

    def _keychain_item_exists(self, service: str) -> bool:
        """Whether a generic-password item exists, asking for its attributes
        only — the secret is never read (no ``-g``/``-w``)."""
        return self._keychain_item_stamp(service)[0]

    def _keychain_item_stamp(self, service: str) -> tuple[bool, str | None]:
        """``(exists, modification stamp)`` of a generic-password item, from
        its attributes only — the secret is never read (no ``-g``/``-w``).
        The stamp is the raw ``mdat`` value, or None when it is not printed."""
        try:
            rc, out = self._security(["find-generic-password", "-s", service], None)
        except Exception as err:  # noqa: BLE001
            log.warning("keychain lookup %s failed: %s", service, err)
            return False, None
        if rc != 0:
            return False, None
        for line in out.splitlines():
            marker = '"mdat"<timedate>='
            if marker in line:
                return True, line.split(marker, 1)[1].strip() or None
        return True, None

    def _account_dir_login_stamp(self, slot_id: str) -> tuple[bool, str | None]:
        """``(present, change stamp)`` of the login inside the account dir:
        the Keychain item's modification date on macOS, the credentials
        file's mtime elsewhere. Never the credential itself."""
        directory = self.account_dir_path(slot_id)
        if not directory.is_dir():
            return False, None
        if self._is_macos:
            return self._keychain_item_stamp(legacy_claude_keychain_service(directory))
        try:
            return True, str((directory / ".credentials.json").stat().st_mtime_ns)
        except OSError:
            return False, None

    def account_dir_signed_in(self, slot_id: str) -> bool:
        """Whether the account has signed in inside its own config dir. A
        presence check only: Claude Code owns the credential and refreshes it,
        so Navide never reads it. A login a pane reported expired does not
        count until it changes — a new sign-in rewrites it. Blocking (a
        ``security`` call on macOS)."""
        present, stamp = self._account_dir_login_stamp(slot_id)
        if not present:
            return False
        expired_at = self._expired_dir_logins.get(slot_id)
        if expired_at is None:
            return True
        if stamp is not None and stamp != expired_at:
            self._expired_dir_logins.pop(slot_id, None)
            return True
        return False

    def mark_account_dir_expired(self, slot_id: str) -> bool:
        """A pane on this account dir reported its login expired. Claude Code
        empties the tokens in place after ``invalid_grant`` and the item stays,
        so presence alone would keep sending panes to a dead login. Until the
        login changes the dir no longer counts as signed in, and panes fall
        back to the live credential. Returns False when no change stamp can be
        read — nothing could ever clear the mark, so none is set. In memory:
        a restart re-learns it from the next pane that hits it."""
        present, stamp = self._account_dir_login_stamp(slot_id)
        if not present or stamp is None:
            return False
        self._expired_dir_logins[slot_id] = stamp
        return True

    def account_dir_identity(self, slot_id: str) -> dict | None:
        """The ``oauthAccount`` Claude Code recorded in the account dir's own
        ``.claude.json`` (display only, not a secret), or None."""
        try:
            directory = self.account_dir_path(slot_id)
        except ValueError:
            return None
        parsed = _parse_json_dict(_read_text(directory / ".claude.json"))
        account = parsed.get("oauthAccount") if parsed else None
        return account if isinstance(account, dict) else None

    def prepare_account_dir(self, slot_id: str) -> Path:
        """Create or refresh the account dir and return it: owner-only, the
        shared ``~/.claude`` entries linked in, and its ``.claude.json`` seeded
        once from the real one (user MCP servers re-synced every time).
        Credentials are never touched. Blocking — call off the event loop."""
        directory = self.account_dir_path(slot_id)
        secret_files.make_private_dir(directory)
        real = self._real_home / ".claude"
        for name, is_dir in CLAUDE_SHARED_ENTRIES:
            target = real / name
            if name in _CLAUDE_ALWAYS_SHARED or target.exists() or target.is_symlink():
                self._link_shared(directory / name, target, is_dir=is_dir)
        self._seed_account_dir_config(directory)
        return directory

    def _seed_account_dir_config(self, directory: Path) -> None:
        real = _parse_json_dict(_read_text(self._claude_config_json())) or {}
        path = directory / ".claude.json"
        raw = _read_text(path)
        if raw is None:
            seed = {key: real[key] for key in _CLAUDE_SEED_KEYS if key in real}
            try:
                _write_live_file(path, json.dumps(seed, indent=2))
            except OSError as err:
                log.warning("cannot seed %s: %s", path, err)
            return
        current = _parse_json_dict(raw)
        if current is None or "mcpServers" not in real:
            return
        if current.get("mcpServers") == real["mcpServers"]:
            return
        current["mcpServers"] = real["mcpServers"]
        try:
            _write_live_file(path, json.dumps(current, indent=2))
        except OSError as err:
            log.warning("cannot sync MCP servers into %s: %s", path, err)

    def account_dir_spawn_env(self, slot_id: str) -> tuple[dict[str, str], list[str]]:
        """``(env_set, env_remove)`` that runs claude on the account's own
        config dir. The API-key overrides are removed for the same reason a
        login pane removes them: they would outrank the account's login."""
        return (
            {"CLAUDE_CONFIG_DIR": os.fspath(self.account_dir_path(slot_id))},
            list(CLAUDE_ENV_OVERRIDES),
        )

    # ---- legacy persistent isolated homes ----

    def profile_home_path(self, agent_key: str, slot_id: str) -> Path:
        """The persistent config home a managed account's regular panes used
        to run in (legacy). Spawns no longer relocate a CLI's config home, but
        an existing home can still host panes spawned before the unification
        and hold the freshest copy of the account's credentials — the startup
        promotion (``promote_profile_home_secrets``) reads it, and the log
        readers keep enumerating it for old session files. The literal path
        must be byte-for-byte stable: claude derives its Keychain item name
        from a hash of ``CLAUDE_CONFIG_DIR``."""
        return self.slot_dir(agent_key, slot_id) / PROFILE_HOME_DIRNAME

    # ---- shared-home symlinks (only credentials stay isolated) ----
    #
    # An isolated home (today only the grok login shim) isolates ONLY the
    # credential secret; everything shareable is symlinked back to the user's
    # real home so panes share one session store regardless of which account
    # is active.

    def _ensure_target_base(self, target: Path, *, is_dir: bool) -> None:
        """Make sure a shared symlink can be written through: the target dir
        itself for a directory link, or the target's parent for a file link
        (the file is created by the CLI on first write, through the symlink)."""
        try:
            (target if is_dir else target.parent).mkdir(parents=True, exist_ok=True)
        except OSError as err:
            log.warning("cannot ensure shared target base %s: %s", target, err)

    def _migrate_file(self, src: Path, target: Path) -> bool:
        """Move a real file that shadows a shared link into the real home.
        Never overwrites an existing real-home file; a clash moves ``src``
        aside into a sibling ``<name>.unmerged`` quarantine so it stops
        shadowing the shared link (leaving it in place would keep the file
        unshared on every future spawn). Returns True only when ``src`` was
        moved away (so the caller may replace it with a symlink)."""
        try:
            if target.exists():
                quarantine = src.with_name(src.name + ".unmerged")
                log.warning(
                    "shared target %s already exists; quarantining %s at %s",
                    target, src, quarantine,
                )
                shutil.move(os.fspath(src), os.fspath(quarantine))
                return True
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(os.fspath(src), os.fspath(target))
            return True
        except OSError as err:
            log.warning("migrating %s -> %s failed: %s", src, target, err)
            return False

    def _migrate_dir(self, src: Path, target: Path) -> bool:
        """Merge a real directory that shadows a shared link (session/projects
        data written under the old whole-home isolation) into the real home.
        A name clash never overwrites the real copy: the clashing file is
        moved into a sibling ``<name>.unmerged`` quarantine instead of being
        left in place, so one stale file cannot keep the whole store unshared
        forever (an unshared ``projects`` hides every resumable session from
        the CLI — the "No conversation found" restart loop). ``src`` is
        removed only once every file drained; a src that could not be fully
        merged is left in place unshared. Returns True only when ``src`` was
        fully drained and removed."""
        quarantine = src.with_name(src.name + ".unmerged")
        try:
            target.mkdir(parents=True, exist_ok=True)
            drained = True
            for root, _dirs, files in os.walk(src):
                rel = Path(root).relative_to(src)
                for name in files:
                    dest = target / rel / name
                    if dest.exists():
                        # Never overwrite the real copy; quarantine ours.
                        dest = quarantine / rel / name
                        log.warning(
                            "shared target already has %s; quarantining at %s",
                            rel / name, dest,
                        )
                    try:
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(os.fspath(Path(root) / name), os.fspath(dest))
                    except OSError as err:
                        log.warning("migrating %s -> %s failed: %s", Path(root) / name, dest, err)
                        drained = False
            if not drained:
                log.warning("kept %s unshared: could not fully merge into %s", src, target)
                return False
            shutil.rmtree(src, ignore_errors=True)
            return True
        except OSError as err:
            log.warning("migrating dir %s -> %s failed: %s", src, target, err)
            return False

    def _link_shared(self, dst: Path, target: Path, *, is_dir: bool) -> None:
        """Point ``dst`` at the shared real-home ``target`` via symlink.

        Idempotent (refreshed on every spawn) and data-safe: an already-correct
        symlink is a no-op; a dangling/wrong symlink is repointed; a real
        dir/file left by an earlier whole-home-isolation build is migrated back
        into the real home first (see ``_migrate_dir``/``_migrate_file``) and,
        only if fully drained, replaced with the symlink. Every IO path is
        guarded — a failure only logs and lets the spawn proceed against the
        isolated home, never raising."""
        try:
            if dst.is_symlink():
                if _link_target(os.readlink(dst)) == os.fspath(target):
                    self._ensure_target_base(target, is_dir=is_dir)
                    return
                dst.unlink()  # stale/wrong link -> repoint
            elif dst.exists():
                migrated = (
                    self._migrate_dir(dst, target) if is_dir
                    else self._migrate_file(dst, target)
                )
                if not migrated:
                    return  # could not drain safely; leave unshared
            self._ensure_target_base(target, is_dir=is_dir)
            dst.symlink_to(target, target_is_directory=is_dir)
        except OSError as err:
            log.warning("shared-home link %s -> %s failed: %s", dst, target, err)

    # ---- one-time promotion of legacy profile-home credentials ----

    def _promote_profile_home(
        self, agent_key: str, profile_id: str, *, active: bool, scope: str | None = None
    ) -> None:
        """Promote the credentials a legacy profile home still holds into the
        profile's slot. Read-only towards the home — a pane spawned before the
        unification may still be running in it, so nothing in the home is ever
        modified or removed. claude compares token expiries (the home copy was
        refreshed in place by its running CLI, so it wins unless the slot is
        strictly newer — a fresh re-login harvest); other agents only fill an
        empty slot."""
        home = self.profile_home_path(agent_key, profile_id)
        if not home.is_dir():
            return
        if agent_key == "claude":
            home_secret = self._claude_profile_home_secret(profile_id)
            if home_secret is None:
                return
            slot = self.read_slot("claude", profile_id)
            if home_secret == slot.secret:
                return
            if slot.secret is not None and not _claude_home_secret_is_fresher(
                home_secret, slot.secret
            ):
                return
            # The active profile owns the live ~/.claude.json display account;
            # a parked profile keeps whatever its slot already carries.
            account = self._read_live_oauth_account() if active else slot.account
            self.write_slot(
                "claude", profile_id, LiveCredentials(secret=home_secret, account=account)
            )
            return
        if agent_key not in _PROFILE_HOME_SECRET_FILES:
            return  # the vendor never had legacy isolated homes
        scope = self._require_scope(agent_key, scope)
        if self.read_slot(agent_key, profile_id, scope=scope).secret is not None:
            return
        secret = _read_text(home.joinpath(*_PROFILE_HOME_SECRET_FILES[agent_key]))
        if secret is not None and scope is not None:
            secret = self._extract(agent_key, secret, scope)
        if secret is not None:
            self.write_slot(agent_key, profile_id, LiveCredentials(secret=secret), scope=scope)

    def _claude_live_unified_marker(self) -> Path:
        return self._root / "claude" / ".live-unified"

    def _homes_promoted_marker(self, agent_key: str) -> Path:
        return self._root / agent_key / ".homes-promoted"

    def _unify_claude_live(self, active_id: str | None) -> None:
        """One-shot (marker-guarded) alignment of claude's live location with
        the active account. Under the pre-unification model a managed claude
        profile never owned the live location: while it was active, the live
        secret still belonged to the reserved default account. Left as is, the
        first unified switch away from that profile would capture the default
        account's token into the profile's slot (cross-account corruption). So
        exactly once: park the live secret in the default slot (keeping that
        slot's own display account) and publish the active profile's slot into
        the live location. Must run at most once SUCCESSFULLY — after that the
        live secret belongs to the active profile, and re-running would park
        it in the default slot instead. The marker is therefore written only
        on success: a failed attempt leaves the live state as the default
        secret (park is idempotent), so the next startup retries safely —
        writing the marker on failure would freeze the pre-unification state
        forever and the next switch's capture would park the default token
        into the profile's slot (cross-account corruption)."""
        marker = self._claude_live_unified_marker()
        if marker.exists():
            return
        try:
            if active_id and active_id != DEFAULT_SLOT_ID:
                live = self.read_live("claude", strict=True)
                if live.secret is not None:
                    default_slot = self.read_slot("claude", DEFAULT_SLOT_ID)
                    self.write_slot(
                        "claude",
                        DEFAULT_SLOT_ID,
                        LiveCredentials(secret=live.secret, account=default_slot.account),
                    )
                self.restore("claude", active_id)
        except Exception as err:  # noqa: BLE001 — retried on next startup
            log.warning(
                "claude live unification failed (will retry on next startup): %s",
                err,
            )
            return
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.touch()
        except OSError as err:
            log.warning("cannot write claude live-unification marker: %s", err)

    def _promote_agent_profile_homes(
        self,
        agent_key: str,
        profile_ids: list[str],
        active_id: str | None,
        scopes: dict[str, str | None] | None = None,
    ) -> None:
        scopes = scopes or {}
        # One-shot per agent: re-running the promotion every startup would let
        # a legacy home copy with a far-future expiresAt (e.g. a revoked
        # long-lived token) repeatedly overwrite a slot's newer credentials.
        # The marker is written only after every profile promoted cleanly —
        # a failed profile leaves it unwritten so the next startup retries.
        promoted_marker = self._homes_promoted_marker(agent_key)
        if not promoted_marker.exists():
            all_promoted = True
            for profile_id in profile_ids:
                try:
                    self._promote_profile_home(
                        agent_key, profile_id, active=profile_id == active_id,
                        scope=scopes.get(profile_id),
                    )
                except Exception as err:  # noqa: BLE001
                    all_promoted = False
                    log.warning(
                        "promoting %s/%s profile-home credentials failed: %s",
                        agent_key, profile_id, err,
                    )
            if all_promoted:
                try:
                    promoted_marker.parent.mkdir(parents=True, exist_ok=True)
                    promoted_marker.touch()
                except OSError as err:
                    log.warning(
                        "cannot write %s homes-promoted marker: %s", agent_key, err
                    )
        if agent_key == "claude":
            self._unify_claude_live(active_id)
        if not active_id or active_id == DEFAULT_SLOT_ID:
            return
        # Repair: a managed account is active but the live location is empty
        # (e.g. its secret only ever existed in the legacy profile home) —
        # publish the freshly promoted slot so panes are signed in.
        try:
            active_scope = scopes.get(active_id)
            if (
                self.read_live(agent_key, scope=active_scope).secret is None
                and self.read_slot(agent_key, active_id, scope=active_scope).secret is not None
            ):
                self.restore(agent_key, active_id, scope=active_scope)
        except Exception as err:  # noqa: BLE001
            log.warning(
                "restoring active %s account after promotion failed: %s",
                agent_key, err,
            )

    async def promote_profile_home_secrets(self, store) -> None:
        """One-time, non-destructive migration off per-profile isolated homes:
        for every profile whose legacy home still holds credentials, promote
        them into the profile's slot, then make sure the active account's
        credentials are in the live location (see ``_unify_claude_live`` and
        the empty-live repair). Homes are only read — never modified or
        removed. Idempotent: re-running finds the slots already up to date.
        Serialized per agent with ``switch_lock`` so it cannot interleave with
        an account switch or a usage-poller harvest."""
        try:
            doc = await asyncio.to_thread(store.list)
        except Exception as err:  # noqa: BLE001
            log.warning("profile-home promotion: cannot read profile registry: %s", err)
            return
        for agent_key in _SLOT_FILES:
            profile_ids = [
                str(p["id"]) for p in doc["profiles"]
                if p.get("agentKey") == agent_key and p.get("id")
            ]
            scopes = {
                str(p["id"]): (p.get("scope") or None) for p in doc["profiles"]
                if p.get("agentKey") == agent_key and p.get("id")
            }
            active_id = doc["defaults"].get(agent_key)
            try:
                async with self.switch_lock(agent_key):
                    await vault_to_thread(
                        self._promote_agent_profile_homes,
                        agent_key, profile_ids, active_id, scopes,
                    )
            except Exception as err:  # noqa: BLE001
                log.warning("profile-home promotion for %s failed: %s", agent_key, err)
