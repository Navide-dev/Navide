"""Filesystem watcher that keeps the "which account is active" ledger honest
when a CLI is signed in from outside Navide.

``cli_profiles_store.defaults[agentKey]`` is Navide's own bookkeeping: it only
ever moved when the user switched accounts through ``cli_profiles.set_default``.
Running ``claude /login`` (or ``codex login``, …) in a plain terminal rewrites
the live credentials behind the ledger's back, and every account row keeps
naming the old profile until the user notices.

Design:

    CredentialWatcher.start()
        └─ one poll task: stat every exact credential file each ``poll_s``

Each file is polled by path, not watched through its directory: an FSEvents
stream covers its root's whole subtree however ``recursive`` is set, and
``~/.claude.json`` lives directly in the home directory, so its stream took in
every file change on the machine — each one costing memory in watchdog's
FSEvents extension (#144). The ``~/.claude`` and ``~/.codex`` streams likewise
carried every transcript write. A stat signature (inode, mtime, size) also
survives what a file watch would not: these files are written with a tmp-file
+ ``os.replace``, which swaps the inode, and a CLI that was never signed in has
no file (or directory) yet. ``~/.claude.json`` is polled because on macOS
claude's secret lives in the Keychain — that config file's ``oauthAccount``
block is the only on-disk signal that the account changed.

That signal is extremely noisy: ``~/.claude.json`` is Claude Code's entire
config, rewritten on every prompt. So a file change never
reconciles anything by itself — it only triggers an identity fingerprint read,
and the work below runs solely when the fingerprint differs from the last one
seen. Reconciliation never WRITES the live credentials: the live state already
belongs to whichever account the user signed into. Normally only the ledger
pointer is corrected; a login no profile holds at all also gets a profile of
its own, whose (empty by construction) slot is filled from the live snapshot.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from pathlib import Path

from .cli_vendors.registry import VENDORS
from .credential_vault import DEFAULT_SLOT_ID, vault_to_thread
from .profiles_store import SUPPORTED_AGENT_KEYS

log = logging.getLogger("agent_team_backend.credential_watcher")

IdentitySink = Callable[[str], Awaitable[None]]

# Claude Code's config file in the real home. Its top-level ``oauthAccount``
# block is the account identity the vault reads (see
# ``CredentialVault.live_account``).
CLAUDE_CONFIG_FILENAME = ".claude.json"

# How often the credential files are stat'ed. Comparable to the old event path:
# the change still waits out the debounce before the fingerprint is read.
POLL_INTERVAL_S = 1.0

# An identity read that failed, or a change that did not read the same twice,
# is looked at again this many times before waiting for the next file change.
CHECK_RETRIES = 5

# Sentinel for "no fingerprint recorded yet" — a signed-out agent is a
# legitimate reading, so no ordinary value can stand in for "never read".
_UNSEEN = object()


def _watch_targets(
    real_home: Path, agent_keys: tuple[str, ...], resolver=None
) -> dict[Path, dict[str, str]]:
    """``{directory: {filename: agentKey}}`` — every directory holding a file
    that carries an account identity, and those exact file names."""
    targets: dict[Path, dict[str, str]] = {}
    for agent_key in agent_keys:
        spec = VENDORS.get(agent_key)
        if spec is None or spec.live_file is None:
            continue
        live = (resolver(agent_key) if resolver else
                spec.live_file_resolver(real_home) if spec.live_file_resolver else
                real_home.joinpath(*spec.live_file))
        if live is None:
            continue
        targets.setdefault(live.parent, {})[live.name] = agent_key
    if "claude" in agent_keys:
        targets.setdefault(real_home, {})[CLAUDE_CONFIG_FILENAME] = "claude"
    return targets


def live_identity_fingerprint(agent_key: str) -> object:
    """Who the live credentials currently belong to, cheap enough to read on
    every credential-file event.

    claude uses ``~/.claude.json``'s ``oauthAccount`` (email + account uuid) so
    the common case costs one file read instead of a Keychain ``security``
    subprocess. The other agents read their live secret's identity — a file
    read too; kimi has no identity field, so all it can report is whether a
    token exists. Raises when the identity cannot be read (a file caught
    mid-write, a transient Keychain failure) rather than reading that as signed
    out. Blocking I/O: call through ``vault_to_thread``."""
    from . import app

    vault = app.credential_vault
    if agent_key == "claude":
        account = vault.live_account("claude", strict=True) or {}
        return (account.get("emailAddress"), account.get("accountUuid"))
    identity = vault.identity(agent_key, strict=True)
    return (identity.get("email"), bool(identity.get("signedIn")))


def _norm_email(value: object) -> str | None:
    return value.casefold() if isinstance(value, str) and value else None


def _match_live_slot(
    agent_key: str, scope: str | None = None
) -> tuple[str | None, str, str | None]:
    """``(live email, active slot id, matching slot id)`` for one agent
    (``scope``: one provider entry of a per-provider store).

    The live email is None whenever the account cannot be identified at all —
    signed out, kimi (no identity field), or a claude long-lived-token login
    that carries no ``oauthAccount``. Nothing is aligned in that case.

    The active slot is checked first so two slots holding the same login can
    never flip the ledger. An active slot whose snapshot carries no email is
    treated as matching: an empty ``__default__`` (the user never registered a
    profile) means "whatever unmanaged login lives in the real home", and
    reporting that as a foreign account would fire on every untouched install.

    Blocking reads (files, plus the Keychain for claude slots)."""
    from . import app

    vault = app.credential_vault
    kw = {"scope": scope} if scope else {}
    live = vault.identity(agent_key, **kw)
    raw_email = live.get("email") if live.get("signedIn") else None
    email = _norm_email(raw_email)
    doc = app.cli_profiles_store.list()
    active = doc["defaults"].get(agent_key) or DEFAULT_SLOT_ID
    if email is None:
        return None, active, None
    slot_ids = [active] + [
        p["id"]
        for p in doc["profiles"]
        if p.get("agentKey") == agent_key and p.get("id") != active
    ]
    if DEFAULT_SLOT_ID not in slot_ids:
        slot_ids.append(DEFAULT_SLOT_ID)
    for slot_id in slot_ids:
        slot_email = _norm_email(vault.identity(agent_key, slot_id, **kw).get("email"))
        if slot_email == email or (slot_email is None and slot_id == active):
            return raw_email, active, slot_id
    return raw_email, active, None


def _adopt_unregistered_live_account(
    agent_key: str, email: str, *, scope: str | None = None
) -> str | None:
    """Give a live login no slot holds its own profile and make it the active
    one; returns the new profile id, or None when nothing was registered.
    ``scope`` is the provider entry the login was read from (per-provider
    stores); the profile is created in it.

    Without this the ledger keeps naming some other account, and the next
    switch would capture this login into a slot that belongs to a different
    one. The live credentials are never written: ``harvest`` only fills the
    new slot — empty by construction — from the live state.

    That fill is mandatory. A registered profile with an empty slot is a logout
    trap: ``restore`` on it clears the live credentials. So a harvest that does
    not happen takes the profile back down with it rather than leave the trap
    behind. Every failure is contained here — the caller still broadcasts, and
    the ledger keeps naming whichever profile it named before. Blocking; call
    inside ``switch_lock(agent_key)``."""
    from . import app

    store = app.cli_profiles_store
    vault = app.credential_vault
    try:
        profile = store.create(agent_key=agent_key, name=email, scope=scope)
    except Exception as err:  # noqa: BLE001 — a watcher must never crash
        log.warning("registering the live %s account failed: %s", agent_key, err)
        return None
    profile_id = str(profile["id"])
    registered = False
    try:
        if vault.harvest(agent_key, profile_id, **({"scope": scope} if scope else {})):
            store.set_default(agent_key, profile_id)
            registered = True
        else:
            log.warning("the live %s credentials could not be snapshotted", agent_key)
    except Exception as err:  # noqa: BLE001
        log.warning("registering the live %s account failed: %s", agent_key, err)
    if not registered:
        # Secrets first, then the store's archive-by-rename (the order
        # cli_profiles.delete uses — see delete_slot_secrets). Separate
        # attempts: failing to clean a secret must not leave the profile
        # itself registered, which is the half-done state that hurts.
        try:
            vault.delete_slot_secrets(agent_key, profile_id)
        except Exception as err:  # noqa: BLE001
            log.warning("cleaning up slot %s/%s failed: %s", agent_key, profile_id, err)
        try:
            store.delete(profile_id)
        except Exception as err:  # noqa: BLE001
            log.error("undoing profile %s for %s failed: %s", profile_id, agent_key, err)
        return None
    log.info(
        "live %s account %s was unregistered; registered it as profile %s",
        agent_key, email, profile_id,
    )
    return profile_id


def align_default_to_live(agent_key: str, *, scope: str | None = None) -> str | None:
    """Point ``defaults[agent_key]`` at the slot whose snapshot matches the
    live credentials, registering a profile for the account when no slot holds
    it (see ``_adopt_unregistered_live_account``); returns the slot id when the
    pointer moved, else None.

    The live credentials are never captured, restored, swapped or cleared here —
    the live state is already the account the user signed into, and the only
    thing that can be wrong is which profile Navide believes that is. Call
    inside ``credential_vault.switch_lock(agent_key)`` so a manual
    ``cli_profiles.set_default`` cannot interleave. Blocking."""
    from . import app

    email, active, matched = _match_live_slot(agent_key, scope)
    if matched is None:
        # An account nothing holds. Registering it needs an identity to name
        # it by, which is exactly what a None email says we do not have.
        return None if email is None else _adopt_unregistered_live_account(
            agent_key, email, scope=scope
        )
    if matched == active:
        return None
    app.cli_profiles_store.set_default(
        agent_key, None if matched == DEFAULT_SLOT_ID else matched
    )
    log.info(
        "active %s account realigned to slot %s (signed in outside Navide)",
        agent_key, matched,
    )
    return matched


def point_at_profile_holding_live(agent_key: str, *, scope: str | None = None) -> str | None:
    """Make the profile whose slot holds exactly the live secret the active
    one; returns its id, or None when no other profile holds it. For a login
    with no email to match by: the same login followed twice lands on the
    profile it got the first time. Never writes credentials. Call inside
    ``switch_lock(agent_key)``. Blocking."""
    from . import app
    from .quota_failover import profile_scope

    vault = app.credential_vault
    kw = {"scope": scope} if scope else {}
    live = vault.read_live(agent_key, strict=True, **kw).secret
    if live is None:
        return None
    doc = app.cli_profiles_store.list()
    active = doc["defaults"].get(agent_key)
    for profile in doc["profiles"]:
        profile_id = profile.get("id")
        if (
            profile.get("agentKey") != agent_key or profile_id == active
            or profile_scope(agent_key, profile) != scope
        ):
            continue
        if vault.read_slot(agent_key, profile_id, **kw).secret == live:
            app.cli_profiles_store.set_default(agent_key, profile_id)
            return str(profile_id)
    return None


async def reconcile_live_account(agent_key: str) -> None:
    """CredentialWatcher sink: this agent's live credentials now belong to a
    different account than when we last looked.

    ``forced`` stays False in the broadcast — a forced ``cli_profiles.changed``
    makes every window restart its panes of that agent, which is only correct
    when the credentials were swapped underneath them. Nothing was swapped
    here, so restarting would interrupt the user for nothing. The switch is
    likewise not counted against the account-switch rate limit: that budget
    exists to keep switching a manual action, and this is not a switch."""
    from . import app
    from .ws_handlers import _broadcast_profiles_changed

    try:
        async with app.credential_vault.switch_lock(agent_key):
            guard = getattr(app.credential_vault, "require_store_mutation", None)
            if guard is not None:
                await vault_to_thread(guard, agent_key)
            await vault_to_thread(align_default_to_live, agent_key)
    except Exception as err:  # noqa: BLE001 — a watcher must never crash the loop
        log.warning("reconciling the active %s account failed: %s", agent_key, err)
        return
    try:
        await _broadcast_profiles_changed(
            "live_credentials", agent_key=agent_key, forced=False
        )
    except Exception as err:  # noqa: BLE001 — the ledger already moved; say so
        log.warning("announcing the realigned %s account failed: %s", agent_key, err)
    # The usage badges read the active account's credentials — pull them now so
    # the badge follows the account the user just signed into.
    from .usage_service import service

    try:
        service.request_refresh()
    except Exception as err:  # noqa: BLE001
        log.warning("refreshing usage after the %s account change failed: %s", agent_key, err)


def _stamp(path: Path) -> tuple[int, int, int] | None:
    """What changes when a file is rewritten or replaced; None while absent."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_ino, st.st_mtime_ns, st.st_size)


class CredentialWatcher:
    """Polls the live credential files of every profile-capable agent.
    Debounced file changes read the account fingerprint; only a genuine change
    calls ``on_identity_change(agent_key)``."""

    def __init__(
        self,
        on_identity_change: IdentitySink,
        *,
        real_home: Path | None = None,
        agent_keys: tuple[str, ...] = SUPPORTED_AGENT_KEYS,
        fingerprint: Callable[[str], object] = live_identity_fingerprint,
        debounce_s: float = 0.8,
        poll_s: float = POLL_INTERVAL_S,
        resolver=None,
    ) -> None:
        self._on_identity_change = on_identity_change
        self._real_home = Path(real_home or Path.home())
        self._agent_keys = agent_keys
        self._fingerprint = fingerprint
        self._debounce_s = debounce_s
        self._poll_s = poll_s
        self._loop: asyncio.AbstractEventLoop | None = None
        self._poll_task: asyncio.Task | None = None
        self._fingerprints: dict[str, object] = {}
        self._pending: dict[str, asyncio.TimerHandle] = {}
        self._seed_task: asyncio.Task | None = None
        # agent_key -> serializes that agent's checks, so an older reading
        # can never be recorded after a newer one
        self._check_locks: dict[str, asyncio.Lock] = {}
        # agent_key -> checks still allowed before giving up until the next change
        self._retries_left: dict[str, int] = {}
        # Running checks, held so they are not collected mid-flight and so
        # their failures reach the log.
        self._check_tasks: set[asyncio.Task] = set()
        self._started = False
        self._resolver = resolver
        # path -> (agent_key, last stamp)
        self._watched: dict[Path, tuple[str, tuple[int, int, int] | None]] = {}

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._loop = asyncio.get_event_loop()
        for directory, files in _watch_targets(self._real_home, self._agent_keys, self._resolver).items():
            for filename, agent_key in files.items():
                self._watch_file(directory / filename, agent_key)
        self._seed_task = asyncio.ensure_future(self._seed())
        self._poll_task = asyncio.ensure_future(self._poll())
        log.info(
            "CredentialWatcher started (%d files, poll %.0fms, debounce %.0fms)",
            len(self._watched), self._poll_s * 1000, self._debounce_s * 1000,
        )

    def _watch_file(self, path: Path, agent_key: str) -> None:
        if path not in self._watched:
            self._watched[path] = (agent_key, _stamp(path))

    async def watch_bound_store(self, agent_key: str, path: Path) -> None:
        # Bindings cannot be replaced. An unbound vendor had no previous
        # watch, so changes at the old path can never reconcile its new store.
        if path not in self._watched:
            try:
                self._fingerprints[agent_key] = await vault_to_thread(self._fingerprint, agent_key)
            except Exception as err:  # noqa: BLE001 — the watch matters more than the seed
                log.warning("seeding the live %s identity failed: %s", agent_key, err)
            self._watch_file(path, agent_key)

    def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        if self._seed_task is not None:
            self._seed_task.cancel()
            self._seed_task = None
        if self._poll_task is not None:
            self._poll_task.cancel()
            self._poll_task = None
        for th in self._pending.values():
            th.cancel()
        self._pending.clear()
        log.info("CredentialWatcher stopped")

    async def _seed(self) -> None:
        """Record each agent's identity as it is at startup, off the loop.

        Without this the first credential-file event of the process — which
        Claude Code produces within seconds just by writing its config — has
        nothing to compare against and would reconcile and broadcast for a
        change that never happened. An event that gets there first wins: its
        reading is the newer one."""
        for agent_key in self._agent_keys:
            if agent_key in self._fingerprints:
                continue
            try:
                fp = await vault_to_thread(self._fingerprint, agent_key)
            except Exception as err:  # noqa: BLE001
                log.warning("seeding the live %s identity failed: %s", agent_key, err)
                continue
            self._fingerprints.setdefault(agent_key, fp)

    # ───────────────────────── poll + debounce (loop thread) ──────────────

    async def _poll(self) -> None:
        while True:
            await asyncio.sleep(self._poll_s)
            # One failed round must not end the watch for the rest of the
            # process (#144); cancellation is not an Exception and still stops it.
            try:
                paths = list(self._watched)
                # Off the loop: a home directory on a network mount stats slowly.
                stamps = await asyncio.to_thread(lambda: [_stamp(p) for p in paths])
                for path, stamp in zip(paths, stamps):
                    agent_key, last = self._watched[path]
                    if stamp != last:
                        self._watched[path] = (agent_key, stamp)
                        self._retries_left[agent_key] = CHECK_RETRIES
                        self._schedule_fire(agent_key)
            except Exception as err:  # noqa: BLE001
                log.warning("polling the credential files failed: %s", err)

    def _schedule_fire(self, agent_key: str) -> None:
        loop = self._loop
        if loop is None:
            return
        existing = self._pending.get(agent_key)
        if existing is not None:
            existing.cancel()
        self._pending[agent_key] = loop.call_later(
            self._debounce_s, self._fire, agent_key
        )

    def _fire(self, agent_key: str) -> None:
        self._pending.pop(agent_key, None)
        task = asyncio.ensure_future(self._check(agent_key))
        self._check_tasks.add(task)
        task.add_done_callback(self._check_done)

    def _check_done(self, task: asyncio.Task) -> None:
        self._check_tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.warning("checking a live identity failed: %s", task.exception())

    async def _check(self, agent_key: str) -> None:
        """The de-noising gate: read who the live credentials belong to and do
        nothing unless that differs from the last reading.

        A changed reading must read the same again after the debounce before
        it counts: a file caught mid-write parses as signed out, and recording
        that would hide the real change behind a stamp already consumed. A
        read that fails, or a change that has not settled, is retried
        (#144)."""
        lock = self._check_locks.setdefault(agent_key, asyncio.Lock())
        async with lock:
            try:
                fp = await vault_to_thread(self._fingerprint, agent_key)
                if self._fingerprints.get(agent_key, _UNSEEN) == fp:
                    return
                await asyncio.sleep(self._debounce_s)
                settled = await vault_to_thread(self._fingerprint, agent_key) == fp
            except Exception as err:  # noqa: BLE001
                log.warning("reading the live %s identity failed: %s", agent_key, err)
                settled = None
            if not settled:
                self._retry(agent_key)
                return
            self._fingerprints[agent_key] = fp
            try:
                await self._on_identity_change(agent_key)
            except Exception as err:  # noqa: BLE001
                log.warning("handling the %s identity change failed: %s", agent_key, err)

    def _retry(self, agent_key: str) -> None:
        left = self._retries_left.get(agent_key, CHECK_RETRIES)
        if left <= 0:
            log.warning(
                "the live %s identity did not settle; waiting for the next change",
                agent_key,
            )
            return
        self._retries_left[agent_key] = left - 1
        self._schedule_fire(agent_key)
