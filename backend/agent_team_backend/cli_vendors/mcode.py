"""MiniMax Code (``mcode``) — MiniMax's terminal coding agent.

Verified against mcode 0.4.12 (npm ``@minimax-ai/code``) on macOS.

What this spec deliberately leaves unset, and why — every one of these was
probed against the real binary rather than read off the docs, because the
published reference mixes the interactive command's flags with those of the
``exec`` subcommand, and Navide only ever spawns the interactive one:

* **No model or effort capability.** ``mcode --help`` lists exactly five
  options for the interactive command: ``--lane``, ``--session``,
  ``-c/--continue``, ``--tui-mode`` and ``--version``. ``--model`` and
  ``--effort`` exist only under ``mcode exec``. This matters more here than
  for the vendors that silently drop an unknown flag: mcode is strict, so
  passing one is not merely ignored —

      $ mcode --bogus-flag-xyz
      error: unknown option '--bogus-flag-xyz'

  — the process exits and the pane never starts. A guessed flag here is a
  dead pane, not a degraded one.

* **No permission-bypass flag.** The interactive command has none. mcode's
  unattended mode is a *setting*, not an argument: ``permissionMode`` in
  ``<data-dir>/config.yaml`` (``default``/``auto``/``bypassPermissions``/
  ``off``), or Alt+M inside the TUI. ``--permission <policy>`` belongs to
  ``mcode exec`` and is rejected by the interactive command, so YOLO mode
  cannot be expressed as argv for this vendor.

* **No session resume.** ``--session <id>`` does exist on the interactive
  command, but Navide can only use it if something can name the id of a
  session it just started, and that means a log reader. mcode stores its
  conversations in SQLite — ``<data-dir>/v2/sqlite/runtime-state.sqlite``
  (WAL), with ``local_runtime_sessions`` (session_id, workspace_dir, title)
  and ``local_runtime_message_rows`` (role, turn_id, data_json) — which is a
  shape no existing reader covers, and the row payloads cannot be honestly
  modelled without an authenticated session to read. Left unset until one
  exists; the schema is recorded here so that work starts from a fact.

* **Account switching (source-read, then checked against the CLI's own
  auth module on synthetic tokens; no real login).** Read from the 0.4.12
  package (chunks/chunk-WAVNKSSE.js, ``J``/``L``/``G``):

  - the credential file is ``<data-dir>/auth/auth.json`` —
    ``{"schemaVersion": 1, "records": {"<service>NUL<account>": <credential>}}``
    with ``service = com.minimax.mcode.oauth.<buildEnv>.<region>`` and
    ``account = base64url(sha256("<data-dir>/auth" + NUL + "mcode-public"))``
    (the hash names the data dir, not the person), credential =
    {schemaVersion 1, accessToken, refreshToken, tokenType "Bearer", clientId
    "mcode-public", scopes, audience "agent-backend", expiresAtMs,
    generation, loginEpoch?, subject?, accountId?};
  - the state file is ``<data-dir>/auth/<buildEnv>/<region>/mcode-public/
    auth-state.json`` (schemaVersion 2, status, storeKind "file", clientId,
    scopes, audience, buildEnv, region, generation, expiresAtMs), under the
    CLI's ``auth.lock`` (proper-lockfile: a ``auth.lock.lock`` directory
    while held, stale after 30 s);
  - ``buildEnv`` is "prod" for the released package; ``region`` is "cn" or
    "en", chosen by ``MAVIS_REGION``, then ``preferences/mcode-region.json``
    (``{"version": 1, "regions": {"prod": "cn"}}``), then whichever region
    has an active state, then "cn".

  Rules checked on 0.4.12's own ``getStatus`` with synthetic files (scratch
  probe, temp data dir): credential and state must carry the SAME
  ``generation`` (mismatch → status "error"); a pair swapped whole is
  accepted in either direction, a lower generation included; a state left
  "authorizing" with a newer credential self-heals; a missing credential
  under an "authenticated" state is "error"; ``auth.json`` and the auth dir
  must be private (0600 / 0700) or reads raise. Hence the adapter: the
  profile scope is the region, ``extract``/``merge`` touch one namespace
  record of ``auth.json`` (re-keyed to the live data dir's hash, so a login
  harvested from another data dir lands under the right key), and
  ``companion_writes`` derives ``auth-state.json`` for that namespace from
  the credential just written (anonymous, generation+1, when removed). The
  region preference file is left alone: switching to an account of the other
  region is refused by ``merge`` unless that region is the CLI's current one.
  Not seen on a real account; ``evidence`` says so.

What is verified and set: ``MINIMAX_DATA_DIR`` really does relocate the whole
data root. Pointing it at an empty directory and running the CLI creates the
entire tree there (``config.yaml``, ``auth/``, ``v2/sqlite/``, ``agents/``,
``plugins/``) and leaves ``~/.minimax`` untouched — checked explicitly.

That is what makes it a ``home_env_vars`` entry, and the field is a guard
rather than an injection: the backend strips these names from its own
inherited environment and from probe spawns, and ``spawn_env_deny_list``
refuses a spawn request that tries to set one. Verified over the real socket —
a ``terminal.create`` carrying ``MINIMAX_DATA_DIR=/tmp/attacker-controlled``
reached the process with no MINIMAX var at all, and the window was told why
via ``cli.env_ignored`` (``denied: ["MINIMAX_DATA_DIR"]``).
"""

import base64
import hashlib
import json
import os
import time
from pathlib import Path

from .base import ExtensionsSource, ExtensionsSpec  # noqa: F401
from .base import AccountSwitchSpec, Dep, VendorSpec

MCODE_BUILD_ENV = "prod"
MCODE_REGIONS = ("cn", "en")
MCODE_CLIENT_ID = "mcode-public"
MCODE_AUDIENCE = "agent-backend"
MCODE_LOCK_STALE_S = 30.0


def mcode_data_dir(home: Path, env: dict | None = None) -> Path:
    env = os.environ if env is None else env
    override = env.get("MINIMAX_DATA_DIR") or env.get("MAVIS_DATA_DIR")
    return Path(override) if override else home / ".minimax"


def _auth_home(home: Path, env: dict | None = None) -> Path:
    return mcode_data_dir(home, env) / "auth"


def _lock_held(lock_path: Path) -> bool:
    """proper-lockfile keeps a ``<lock>.lock`` directory while the CLI holds
    the auth lock; one older than the CLI's own stale threshold is ignored."""
    marker = lock_path.with_name(lock_path.name + ".lock")
    try:
        st = marker.stat()
    except OSError:
        return False
    return time.time() - st.st_mtime < MCODE_LOCK_STALE_S


def _mcode_credential_file(home: Path, env: dict | None = None) -> Path:
    """``<data-dir>/auth/auth.json``; refused while the CLI holds its auth
    lock (either the legacy lock beside the file or a namespace lock)."""
    auth_home = _auth_home(home, env)
    locks = [auth_home / "auth.lock"]
    for region in MCODE_REGIONS:
        locks.append(auth_home / MCODE_BUILD_ENV / region / MCODE_CLIENT_ID / "auth.lock")
    if any(_lock_held(lock) for lock in locks):
        raise ValueError("mcode is holding its auth lock; try again once it is idle")
    return auth_home / "auth.json"


def _record_service(region: str) -> str:
    return f"com.minimax.mcode.oauth.{MCODE_BUILD_ENV}.{region}"


def _record_account(auth_home: Path) -> str:
    digest = hashlib.sha256(f"{auth_home}\0{MCODE_CLIENT_ID}".encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _current_region(auth_home: Path, env: dict | None = None) -> str | None:
    """The region the CLI would use, by its own precedence (MAVIS_REGION, the
    preference file, an active state), or None when it cannot be told."""
    env = os.environ if env is None else env
    forced = env.get("MAVIS_REGION")
    if forced in MCODE_REGIONS:
        return forced
    try:
        prefs = json.loads(
            (auth_home.parent / "preferences" / "mcode-region.json").read_text(encoding="utf-8")
        )
        region = prefs.get("regions", {}).get(MCODE_BUILD_ENV) if isinstance(prefs, dict) else None
        if region in MCODE_REGIONS:
            return region
    except (OSError, ValueError, AttributeError):
        pass
    for region in MCODE_REGIONS:
        try:
            state = json.loads(_state_path(auth_home, region).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(state, dict) and state.get("status") in (
            "authorizing", "authenticated", "refreshing", "scope_upgrade_required", "expired",
        ):
            return region
    return None


def _state_path(auth_home: Path, region: str) -> Path:
    return auth_home / MCODE_BUILD_ENV / region / MCODE_CLIENT_ID / "auth-state.json"


def _credential_ok(entry: object) -> bool:
    return (
        isinstance(entry, dict)
        and isinstance(entry.get("accessToken"), str) and bool(entry["accessToken"])
        and isinstance(entry.get("refreshToken"), str) and bool(entry["refreshToken"])
        and entry.get("clientId") == MCODE_CLIENT_ID
        and isinstance(entry.get("generation"), int)
    )


def _mcode_extract(document: str | None, scope: str) -> str | None:
    """The one record of ``scope``'s namespace, whatever data-dir hash it is
    keyed under, as JSON text."""
    if document is None or scope not in MCODE_REGIONS:
        return None
    try:
        payload = json.loads(document)
    except ValueError:
        return None
    records = payload.get("records") if isinstance(payload, dict) else None
    if not isinstance(records, dict):
        return None
    prefix = _record_service(scope) + "\0"
    for key, entry in records.items():
        if isinstance(key, str) and key.startswith(prefix) and _credential_ok(entry):
            return json.dumps(entry, separators=(",", ":"), sort_keys=True)
    return None


_UNKEYED = "?"  # placeholder account hash until the data dir is known


def _mcode_merge(document: str | None, scope: str, portion: str | None) -> str:
    """Replace (or remove) ``scope``'s namespace record and nothing else. The
    record is keyed with the data-dir hash the document already uses; a
    document that has none (a parked slot document, or a fresh data dir)
    gets the ``_UNKEYED`` placeholder, which ``_mcode_companions`` rewrites
    to the live data dir's real hash right after the live write."""
    if scope not in MCODE_REGIONS:
        raise ValueError(f"mcode has no credential scope {scope!r}")
    if document is None or not document.strip():
        payload: dict = {"schemaVersion": 1, "records": {}}
    else:
        payload = json.loads(document)
    if not isinstance(payload, dict) or not isinstance(payload.get("records"), dict):
        raise ValueError("auth.json is not an mcode credential payload")
    records = payload["records"]
    prefix = _record_service(scope) + "\0"
    existing_keys = [k for k in records if isinstance(k, str) and k.startswith(prefix)]
    for key in existing_keys:
        records.pop(key)
    if portion is not None:
        entry = json.loads(portion)
        if not _credential_ok(entry):
            raise ValueError("mcode credential portion is not a valid credential record")
        hashes = {k.split("\0", 1)[1] for k in records if isinstance(k, str) and "\0" in k}
        hashes.update(k.split("\0", 1)[1] for k in existing_keys)
        hashes.discard(_UNKEYED)
        if len(hashes) > 1:
            raise ValueError("auth.json holds records of more than one data dir")
        records[prefix + (hashes.pop() if hashes else _UNKEYED)] = entry
    payload["schemaVersion"] = 1
    return json.dumps(payload, indent=2)


def _mcode_companions(live_path: Path, document: str | None, scope: str) -> tuple[tuple[Path, str | None], ...]:
    """Derive ``auth-state.json`` for the namespace just written so its
    ``generation`` matches the credential (the CLI reads "error" otherwise).
    Removed credential → an anonymous state one generation later, as the
    CLI's own logout writes. A switch into the region the CLI is NOT using
    is refused here: the pane would keep talking to the other region."""
    auth_home = live_path.parent
    current = _current_region(auth_home)
    if current is not None and current != scope:
        raise ValueError(
            f"mcode currently uses region {current!r}; switch it to {scope!r} in the CLI first"
        )
    writes: list[tuple[Path, str | None]] = []
    # Records the merge could not key (no record was on this data dir yet)
    # get the real hash now that the data dir is known.
    payload = json.loads(document) if document else {"schemaVersion": 1, "records": {}}
    records = payload.get("records", {}) if isinstance(payload, dict) else {}
    unkeyed = [k for k in records if isinstance(k, str) and k.endswith("\0" + _UNKEYED)]
    if unkeyed:
        real = _record_account(auth_home)
        for key in unkeyed:
            records[key[: -len(_UNKEYED)] + real] = records.pop(key)
        document = json.dumps(payload, indent=2)
        writes.append((live_path, document))
    entry = json.loads(_mcode_extract(document, scope) or "null")
    state_path = _state_path(auth_home, scope)
    previous_generation = 0
    try:
        previous = json.loads(state_path.read_text(encoding="utf-8"))
        if isinstance(previous, dict) and isinstance(previous.get("generation"), int):
            previous_generation = previous["generation"]
    except (OSError, ValueError):
        pass
    base = {
        "schemaVersion": 2,
        "storeKind": "file",
        "clientId": MCODE_CLIENT_ID,
        "scopes": ["agent.default"],
        "audience": MCODE_AUDIENCE,
        "buildEnv": MCODE_BUILD_ENV,
        "region": scope,
    }
    if entry is None:
        state = {**base, "status": "anonymous", "generation": previous_generation + 1}
    else:
        state = {
            **base,
            "status": "authenticated",
            "scopes": list(entry.get("scopes") or ["agent.default"]),
            "generation": entry["generation"],
            "expiresAtMs": entry.get("expiresAtMs"),
        }
    state_path.parent.mkdir(parents=True, exist_ok=True)
    writes.append((state_path, json.dumps(state, indent=2)))
    return tuple(writes)


def identity_from_secret(secret):
    """A parked record: signed in when it holds both tokens. ``subject`` /
    ``accountId`` are opaque ids in the token response, not an email."""
    data = None
    if secret is not None:
        try:
            data = json.loads(secret)
        except ValueError:
            data = None
    return {"email": None, "signedIn": _credential_ok(data)}


# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(sources=(
    ExtensionsSource("plugin-dirs", (".minimax", "plugins"), "MiniMax Code plugin"),
))

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="mcode",
    # Region/environment auth routing is known; service hosts are not verified.
    expected_hosts=(),
    # Relocation and legacy fallback verified against mcode 0.4.12 above.
    data_dirs=lambda ctx: (ctx.path(ctx.env.get("MINIMAX_DATA_DIR") or ctx.env.get("MAVIS_DATA_DIR") or ctx.home / ".minimax"),),
    data_dir_env_vars=("MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"),
    label="MiniMax Code",
    # `--session <id>` exists on the interactive command, but resume also
    # needs something able to NAME the id of a session Navide started, and
    # that is the log reader mcode does not have yet (see the module
    # docstring for the SQLite schema it would read). Declared False so the
    # default True does not advertise a resume that would find no id —
    # unlike aider, this is a missing reader, not a missing concept.
    supports_session_resume=False,
    # Relocates the entire data root — config, auth, session SQLite. The CLI
    # also honours MAVIS_DATA_DIR as a legacy fallback. Navide strips rather
    # than injects these variables, so both names must be guarded or the
    # fallback can redirect a pane to a different account and session store.
    home_env_vars=("MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"),
    # `mcode login` (add `--region global` for a non-mainland account, which
    # is a choice the user makes in the CLI's own flow, not something Navide
    # can pick for them).
    login_command_args="login",
    # Multi-account: see the module docstring. One record of
    # ``<data-dir>/auth/auth.json`` per region scope, with the namespace's
    # ``auth-state.json`` derived to match. MINIMAX_DATA_DIR relocates the
    # whole tree, so a login pane gets its own data dir and the harvested
    # record is re-keyed to the real one on restore. Restart afterwards.
    live_file=(".minimax", "auth", "auth.json"),
    live_file_resolver=lambda home: _mcode_credential_file(home),
    slot_file="credential.json",
    login_home_secret_file=("auth", "auth.json"),
    login_home_env="MINIMAX_DATA_DIR",
    identity_from_secret=identity_from_secret,
    account_switch=AccountSwitchSpec(
        auth_scope="mcode",
        method="restart",
        store="compound-file",
        evidence="source",
        verified_version="0.4.12",
        scopes=MCODE_REGIONS,
        extract=_mcode_extract,
        merge=_mcode_merge,
        companion_writes=_mcode_companions,
        # MAVIS_REGION forces the region the CLI reads, ahead of the stored
        # preference: a pane carrying it may not be using the switched record.
        shadowing_env=("MAVIS_REGION",),
        # No log reader yet, so nothing can name the session to resume.
        resume="none",
        todo="rules checked on 0.4.12's own auth module with synthetic tokens only; no real login or round-trip; no session reader, so a restarted pane starts a new conversation",
    ),
    # Quota exhaustion text from the 0.4.12 package (chunk-PMTJEVJF.js kind
    # messages, launcher banner, codex-oauth path, goal status); rate-limit
    # and auth messages are deliberately not listed. Source-read only.
    quota_exhausted_patterns=(
        r"(LLM usage limit reached|LLM credits exhausted|hit your ChatGPT usage limit|usage_limited\(provider_quota\))",
    ),
    install_dep=Dep("mcode", "MiniMax Code", "MiniMax terminal coding agent", "agent_cli",
        ["mcode", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @minimax-ai/code", needs_terminal=True,
        requires_binaries=("npm",), optional=True,
        docs_url="https://agent.minimaxi.com/docs/cli/quick-start",
        # `mcode update` is the CLI's own updater (listed by `mcode --help`).
        # No doctor command exists.
        update_cmd="mcode update",
        npm_package="@minimax-ai/code",
        config_home_env="MINIMAX_DATA_DIR", config_home_default=".minimax"),
)
