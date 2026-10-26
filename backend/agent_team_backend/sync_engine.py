"""Cross-device sync for the Settings → INTEGRATIONS sections.

The wire contract is ``docs/en-US/cloud-sync-protocol.md``; this module is the
client half of it. It knows nothing about prompts, MCP servers or skills — a
*scope adapter* supplies "what does this machine currently hold" and "write
this in", and everything below treats both as opaque JSON.

**The engine never merges and never picks a winner.** That is the decision the
approved plan records: two devices editing the same item produce a conflict
row and a question for the user, not a silent overwrite. Three places enforce
it and all three are needed — a push carries the ``rev`` it is editing from so
the server can refuse a stale write, a pull refuses to apply over local edits
it has not seen pushed, and an item with an unresolved conflict is skipped by
both directions until the user answers.

**A missing key is not a reason to sync in the clear.** Bodies go through
``sync_keyring``, which has no plaintext path; a machine that has not yet been
handed the account key syncs nothing rather than uploading readable records.

**Nothing here can break the app.** Every entry point is called from the link's
own task and every failure is logged and swallowed by the caller: sync is a
convenience laid over state that is already correct on disk.

**The blocking half runs off the loop.** A round reads every skill's file tree
and every instruction file, encrypts each record, and touches SQLite — none of
which is async, and all of which happens inside the backend's own event loop
task. ``loop_watchdog`` calls a 2-second stall a fault and says so in the log,
and a user with a few large instruction files would reach that on an ordinary
sync. So the per-item work is handed to a worker thread in whole batches: one
hop per pull page and one per push, rather than one per item, because the hop
is only worth making if it carries real work.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Protocol

from . import device_signing, sync_keyring, sync_objects
from .db import Database

log = logging.getLogger("agent_team_backend.sync_engine")

_COMPONENT = "sync"

#: The scopes the protocol defines. Anything else is refused before it reaches
#: the wire, so a typo in an adapter cannot create a private fifth scope that
#: only one build knows about.
SCOPES: tuple[str, ...] = ("prompts", "mcp", "skills", "memory", "credentials")
#: Scopes the protocol also carries but no one switches on or off: each rides
#: along with a user-facing scope (its adapter's ``enabled`` answer). Kept out
#: of ``SCOPES`` because that tuple is the list of switches Settings shows.
#: ``skill-files``: the file manifests of skills too large for one record.
INTERNAL_SCOPES: tuple[str, ...] = ("skill-files",)

#: Matches the server's cap. Larger batches are split, not rejected.
PUSH_BATCH = 64
PULL_PAGE = 200
#: A push is one WebSocket frame and the server's ``maxPayload`` is 1 MiB, so
#: the frame — not the item — is the real limit. Both numbers sit under it with
#: room for the envelope, and they are measured on the base64 body as stored,
#: because the server is forbidden to decode it to find out how big it is.
MAX_BODY_BYTES = 512 * 1024
MAX_PUSH_BYTES = 768 * 1024
#: A pull reply is one frame too, and this client's websocket refuses a frame
#: over 1 MiB by closing the whole link (1009) — messaging included — after
#: which the next round asks for the same page again. Navide-Server caps a page
#: by bytes from fix/sync-page-bytes on; an older server only by row count, so
#: the client asks for no more rows than this budget holds at the largest row
#: size it expects. A guess first, then the largest row actually seen.
PULL_FRAME_BUDGET = 768 * 1024
#: A scope starts over (its cursor ahead of the server's) at most once in
#: this long. A server that answers "cursor 0" every round would otherwise
#: make a client forget and re-read the whole scope every time.
RESET_THROTTLE_S = 3600.0
#: Pull pages one round reads at most. A server that keeps saying ``more``
#: with fresh revs would otherwise hold the round (and the scope's lock)
#: forever; the next round carries on from where this one stopped.
MAX_PULL_PAGES = 200
#: An adapter's ``DeferItem`` (files still downloading) is retried at once the
#: first time, then with an exponential backoff from the base to the cap, and
#: reported as given up —
#: still retried — after this many attempts or this long.
DEFER_BACKOFF_BASE_S = 30.0
DEFER_BACKOFF_MAX_S = 15 * 60.0
DEFER_GIVE_UP_ATTEMPTS = 5
DEFER_GIVE_UP_AFTER_S = 30 * 60.0
#: The row size a scope's first page is sized for. Instruction files and
#: inline skills run up to the record limit, so those scopes page one row at a
#: time until their rows are seen; prompt and MCP records are small.
PULL_ROW_GUESS: dict[str, int] = {
    "memory": MAX_BODY_BYTES,
    "skills": MAX_BODY_BYTES,
    "credentials": 16 * 1024,
    "prompts": 32 * 1024,
    "mcp": 16 * 1024,
    "skill-files": 64 * 1024,
}

KEEP_LOCAL = "local"
KEEP_REMOTE = "remote"

#: How one item's two halves stand in an inventory listing.
STATE_IN_SYNC = "in-sync"
STATE_LOCAL_ONLY = "local-only"
STATE_REMOTE_ONLY = "remote-only"
STATE_DIVERGED = "diverged"
STATE_CONFLICT = "conflict"

#: Whether a scope's cloud half could be listed at all. Kept apart from the
#: items because "nothing is up there" and "this machine could not look" are
#: different answers, and a pane that shows an empty list for both asks people
#: to re-upload what is already synced.
INVENTORY_OK = "ok"
INVENTORY_NO_KEY = "no-key"
INVENTORY_NOT_CONNECTED = "not-connected"
INVENTORY_ERROR = "error"
INVENTORY_UNKNOWN_SCOPE = "unknown-scope"
#: A sensitive scope that is switched off: its snapshot opens secrets, so it
#: is not taken to answer a look-before-you-decide question.
INVENTORY_DISABLED = "disabled"


class SyncError(Exception):
    """A sync round could not be completed. Always recoverable by retrying.

    ``code`` is the server's error code for a refusal (or the engine's own,
    such as ``ITEM_ID_KEY_MISSING``); "" when there is none.
    """

    def __init__(self, message: str = "", *, code: str = "") -> None:
        super().__init__(message)
        self.code = code


class StaleRound(SyncError):
    """A round that began under the previous account tried to write."""


class FrameTooLarge(ConnectionError):
    """The link closed because a reply was over the WebSocket frame limit (the
    socket went down with 1009). Raised by the request function the link hands
    the engine; a pull answers it by asking for smaller pages."""


#: The store and the generation the running round began under (None outside a
#: round). Carried into worker threads by ``asyncio.to_thread``, which copies
#: context.
_round_generation: contextvars.ContextVar[tuple[Any, int] | None] = contextvars.ContextVar(
    "sync_round_generation", default=None
)


#: Protocol v3 (``sync.caps``): what one connection negotiated. A server that
#: does not answer it — an older one, a MySQL one — is spoken to as v1, the
#: wire this module has always used.
_V1_CAPS: dict[str, Any] = {"version": 1, "storage": "inline", "itemIds": "legacy"}
#: Scopes that never go up on the v3 path, whatever the server lists.
RETIRED_SCOPES: tuple[str, ...] = ("memory", "credentials")
#: Scopes that hold credentials or keys. Those are only ever stored on the
#: user's own machine (policy of 2026-10-21): no engine registers an adapter
#: for one, and no push names one, whatever a switch or a caller says.
LOCAL_ONLY_SCOPES: frozenset[str] = frozenset({"credentials"})
#: Top-level refusals that mean the negotiated capabilities no longer hold.
_RENEGOTIATE = frozenset({"OBJECTS_DISABLED", "SYNC_PROTOCOL_REQUIRED"})
#: Objects per ``blobs.*`` request, the contract's ceiling.
OBJECT_BATCH = 100
#: The capabilities the running transfer works under (None: v1).
_round_caps: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "sync_round_caps", default=None
)


def _caps_now() -> dict[str, Any]:
    return _round_caps.get() or _V1_CAPS


@contextlib.contextmanager
def _using(caps: dict[str, Any]) -> Any:
    token = _round_caps.set(caps)
    try:
        yield
    finally:
        _round_caps.reset(token)


def _is_v3(caps: dict[str, Any]) -> bool:
    return caps.get("version") == 3


def _retired(caps: dict[str, Any], scope: str) -> bool:
    if not _is_v3(caps):
        return False
    listed = caps.get("retiredScopes")
    return scope in RETIRED_SCOPES or (isinstance(listed, list) and scope in listed)


def _hmac_kid(caps: dict[str, Any]) -> str:
    """D3: the account's ``itemIdKid`` when it has adopted hashed item ids
    on this connection, else ""."""
    if _is_v3(caps) and caps.get("itemIds") == "hmac":
        return str(caps.get("itemIdKid") or "")
    return ""


def _require_item_id_key(caps: dict[str, Any]) -> None:
    """c3: an hmac account whose ``itemIdKid`` this ring lacks stops here —
    no push, no migration, no pull it could not name. Never another key:
    ids under it would be new items, and the old ones would read as deleted.
    Blocking (reads the ring)."""
    if not (_is_v3(caps) and caps.get("itemIds") == "hmac"):
        return
    kid = str(caps.get("itemIdKid") or "")
    held = sync_keyring.ring() or {}
    if not kid or kid not in (held.get("keys") or {}):
        raise SyncError(
            "ITEM_ID_KEY_MISSING: this machine does not hold the key the account's item ids are "
            "made with; pair it again from a device that does",
            code="ITEM_ID_KEY_MISSING",
        )


class _BadWrapper(ValueError):
    """A hashed-id record whose sealed wrapper is malformed or names an item
    whose id is not the one it came under."""


#: ``_resolve_hashed`` found nothing it opened.
_UNOPENED: Any = object()
#: Keys an item carries between building and sending; never on the wire.
_NAME_KEY = "_localName"
_PAIR_KEY = "_pairHead"
#: Marks the legacy tombstone a migrated item still owes (contract c5).
_OWED_KEY = "_owedTombstone"


def _name_of(item: dict[str, Any]) -> str:
    """The local name of a built wire item."""
    return str(item.get(_NAME_KEY) or item.get("itemId") or "")


def _batches(items: list[Any], size: int) -> list[list[Any]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def round_is_current() -> bool:
    """Whether the running round (if any) still belongs to the signed-in account.

    For code an adapter runs inside a round that writes outside the store — the
    detached marks, for one — and must not write for the previous account once
    the account has changed mid-apply. True outside a round.
    """
    began = _round_generation.get()
    return began is None or began[0].generation == began[1]


class DeferItem(Exception):
    """Raised by an adapter's ``apply`` when a record cannot land yet — its
    files are still on their way. The pull stops just short of that row, the
    same way it does for a record under a key this machine lacks, so the next
    round reads it again instead of stepping past it."""


class ScopeAdapter(Protocol):
    """One Settings section's view of itself as syncable items.

    An adapter may also carry ``sensitive = True`` and a ``describe(payload)``
    method. ``sensitive`` is one flag for the four things a scope holding
    secrets needs and nothing else does: its conflict rows are sealed at rest
    and listed as ``describe()`` metadata only, an item missing from its
    snapshot never becomes a cloud tombstone, an unreadable record fails the
    round instead of being skipped, and the inventory carries ``describe()``
    of each side so a pane can name an item without seeing it.
    """

    scope: str

    def snapshot(self) -> dict[str, Any]:
        """Every item this machine holds right now, by stable item id."""

    def apply(self, item_id: str, payload: Any | None) -> None:
        """Write one incoming item in, or remove it when payload is None."""


def _why(err: BaseException) -> str:
    """What may be said about *err* in a log line or a round's result.

    The engine's own errors carry fixed text it wrote; anything else is named
    by its class only, because its message can quote what it failed on — a
    prompt, an MCP header, a path.
    """
    if isinstance(err, SyncError):
        return str(err)
    return f"{type(err).__name__} (details withheld)"


def _sensitive(adapter: Any) -> bool:
    return bool(getattr(adapter, "sensitive", False))


def _describe(adapter: Any, payload: Any) -> dict[str, Any] | None:
    """``adapter.describe(payload)`` when the adapter offers one, else None.

    Never raises: a description is decoration on a listing, and a payload the
    adapter cannot describe must not take the listing down with it.
    """
    fn = getattr(adapter, "describe", None)
    if fn is None or payload is None:
        return None
    try:
        out = fn(payload)
    except Exception as err:  # noqa: BLE001 - see docstring
        log.warning("%s could not describe an item: %s", getattr(adapter, "scope", "?"), _why(err))
        return None
    return out if isinstance(out, dict) else None


def _inbound(adapter: Any, payload: Any) -> Any:
    """*payload* as *adapter* compares a remote copy, when it reads one in a
    narrower form than the record (``McpScope.inbound``: no env or header
    values), so a field it never sends cannot make two copies differ."""
    fn = getattr(adapter, "inbound", None)
    return payload if fn is None or payload is None else fn(payload)


def _agreed_before(adapter: Any, item_id: str, agreed_hash: str) -> bool:
    """Whether *agreed_hash* is this item as an older build sent it
    (``former_snapshot``): unchanged since, only the sent form moved on, and
    not an edit to push or a reason for a conflict."""
    fn = getattr(adapter, "former_snapshot", None)
    if fn is None or not agreed_hash:
        return False
    former = fn()
    return item_id in former and digest(former[item_id]) == agreed_hash


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def canonical(payload: Any) -> str:
    """The exact bytes a body hashes and encrypts as.

    Sorted keys and no whitespace, so two devices that built the same value in
    a different order agree that it is the same value — otherwise every sync
    would rediscover a difference that is not there and push forever.
    """
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(payload: Any) -> str:
    return hashlib.sha256(canonical(payload).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ItemState:
    """What this machine and the server last agreed on for one item.

    ``sealed_kid`` names the account key the agreed body was sealed under
    (empty for a v1 body or when unknown). A rotation makes it differ from the
    active key, which is the only reason an unchanged item is pushed again.
    """

    rev: int
    synced_hash: str
    deleted: bool
    sealed_kid: str = ""
    #: The ``updatedAt`` of the agreed copy, normalised by ``_stamp`` ("" when
    #: unknown). Only ever moves forward; a record older than it is a replay.
    synced_updated_at: str = ""
    #: D3: the hashed id (``h1.``…) the server knows the item by, or "" when
    #: it knows it by its name (a legacy id).
    wire_id: str = ""
    #: D3, contract c5: the rev of the legacy row this item still owes a
    #: tombstone for — its hashed copy went up, the legacy half did not — or
    #: 0 when nothing is owed.
    legacy_rev: int = 0


def _stamp(updated_at: Any) -> str:
    """*updated_at* as one comparable UTC string, or "" when it is not a time.

    Every release writes ``now_iso()``, but the value arrives from the server
    and is compared as text in SQL, so it is normalised first: an offset, a
    fraction or a malformed value must not make an old record look new.
    """
    if not isinstance(updated_at, str) or not updated_at:
        return ""
    try:
        when = datetime.fromisoformat(updated_at)
    except ValueError:
        return ""
    if when.tzinfo is None:
        return ""
    return when.astimezone(timezone.utc).isoformat(timespec="seconds")


def _create_schema(cur: Any) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_state (
            scope       TEXT    NOT NULL,
            item_id     TEXT    NOT NULL,
            rev         INTEGER NOT NULL,
            synced_hash TEXT    NOT NULL,
            deleted     INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (scope, item_id)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_cursor (
            scope  TEXT    PRIMARY KEY,
            cursor INTEGER NOT NULL
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_conflicts (
            scope         TEXT    NOT NULL,
            item_id       TEXT    NOT NULL,
            local_json    TEXT    NOT NULL,
            remote_json   TEXT    NOT NULL,
            remote_rev    INTEGER NOT NULL,
            remote_device TEXT    NOT NULL,
            seen_at       INTEGER NOT NULL,
            PRIMARY KEY (scope, item_id)
        )
        """
    )


def _schema_v2(cur: Any) -> None:
    # ``sealed``: the two payload columns hold ciphertext, not canonical JSON.
    # ``remote_kid``: the key the remote copy came sealed under, so keeping it
    # records the truth and a rotation still finds it. ``sealed_kid``: see
    # ItemState.
    cur.execute("ALTER TABLE sync_conflicts ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE sync_conflicts ADD COLUMN remote_kid TEXT NOT NULL DEFAULT ''")
    cur.execute("ALTER TABLE sync_state ADD COLUMN sealed_kid TEXT NOT NULL DEFAULT ''")


def _schema_v3(cur: Any) -> None:
    # ``synced_updated_at``: see ItemState. Additive, with a default, so a
    # build that predates it reads and writes the table unchanged; checked
    # first so a database that already has the column (a downgrade and
    # upgrade, a hand repair) takes the step without a second ALTER.
    columns = {str(row[1]) for row in cur.execute("PRAGMA table_info(sync_state)").fetchall()}
    if "synced_updated_at" not in columns:
        cur.execute("ALTER TABLE sync_state ADD COLUMN synced_updated_at TEXT NOT NULL DEFAULT ''")


#: The tables whose rows belong to one account (D4).
_ACCOUNT_TABLES = ("sync_state", "sync_cursor", "sync_conflicts")


def _schema_v4(cur: Any) -> None:
    # ``account``: the namespace (``sync_keyring.namespace_for``) a row was
    # agreed under. ``sync_parked`` holds the rows of every account other than
    # the current one, each as a JSON object of its columns, so switching back
    # resumes where that account left off. Additive only: a build that
    # predates v4 never names the column, so its writes take the "" default,
    # and the next settle adopts them (``SyncStore.adopt_account``).
    #
    # Downgrade: a build that predates v4 skips this step (its highest step is
    # lower), reads and writes the live rows as before and never looks at
    # ``sync_parked`` or ``sync-approvals-parked/``. An account switch made by
    # it wipes the live rows the way it always did; the parked ones survive,
    # so after upgrading again only the accounts it switched through are
    # read afresh. Nothing it can do makes another account's rows live.
    for table in _ACCOUNT_TABLES:
        columns = {str(row[1]) for row in cur.execute(f"PRAGMA table_info({table})").fetchall()}
        if "account" not in columns:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN account TEXT NOT NULL DEFAULT ''")
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_parked (
            account  TEXT NOT NULL,
            tbl      TEXT NOT NULL,
            row_json TEXT NOT NULL
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS sync_parked_account ON sync_parked (account)")


def _schema_v5(cur: Any) -> None:
    # D3. ``sync_state.wire_id``: see ItemState. ``sync_conflicts.remote_wire``:
    # the hashed id the remote half came under ("" for a legacy id), so an
    # answer to the conflict is recorded against the id the server holds.
    # Additive with defaults: a build that predates v5 reads and writes the
    # tables unchanged (and, on an hmac account, is refused by the server).
    for table, column in (("sync_state", "wire_id"), ("sync_conflicts", "remote_wire")):
        columns = {str(row[1]) for row in cur.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in columns:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")


def _schema_v6(cur: Any) -> None:
    # Contract c5: the server judges the two halves of a D3 migration
    # separately. ``sync_state.legacy_rev``: see ItemState. Additive with a
    # default: a build that predates v6 reads and writes the table unchanged
    # and only never sends an owed legacy tombstone, as before.
    columns = {str(row[1]) for row in cur.execute("PRAGMA table_info(sync_state)").fetchall()}
    if "legacy_rev" not in columns:
        cur.execute("ALTER TABLE sync_state ADD COLUMN legacy_rev INTEGER NOT NULL DEFAULT 0")


#: Stands in for the two payloads of a sealed conflict row when the account
#: key that would open them is not here. A row the user can neither read nor
#: resolve still has to be listed, or the item stays silently blocked.
SEALED_PLACEHOLDER: dict[str, Any] = {"sealed": True}


class SyncStore:
    """The bookkeeping half: what was agreed, how far we have read, what clashed.

    Conflict rows of a sensitive scope are stored sealed under the account key
    and come back out of ``conflicts()`` as whatever the scope's ``describe``
    makes of them — never the payload. The redactor is handed over by the
    engine at registration, so this class stays ignorant of what a credential
    is while still refusing to hand one to a caller.
    """

    def __init__(self, db: Database) -> None:
        self._db = db
        self._db.migrate(_COMPONENT, 1, _create_schema)
        self._db.migrate(_COMPONENT, 2, _schema_v2)
        self._db.migrate(_COMPONENT, 3, _schema_v3)
        self._db.migrate(_COMPONENT, 4, _schema_v4)
        self._db.migrate(_COMPONENT, 5, _schema_v5)
        self._db.migrate(_COMPONENT, 6, _schema_v6)
        #: The account the live rows belong to; "" until the link settles on one.
        self._account = ""
        self._redactors: dict[str, Callable[[Any], dict[str, Any] | None]] = {}
        #: Bumped when the account changes. A round records the generation it
        #: began under, and a write from a round of an older one is refused:
        #: what it read belongs to the previous account.
        self._generation = 0

    @property
    def generation(self) -> int:
        return self._generation

    def new_generation(self) -> None:
        self._generation += 1

    def _check_round(self) -> None:
        began = _round_generation.get()
        if began is not None and began[0] is self and began[1] != self._generation:
            raise StaleRound("the account changed while this round was running; nothing was recorded")

    def set_redactor(self, scope: str, fn: Callable[[Any], dict[str, Any] | None]) -> None:
        self._redactors[scope] = fn

    # ── accounts (D4) ───────────────────────────────────────────────────
    @property
    def account(self) -> str:
        return self._account

    def adopt_account(self, account: str | None) -> None:
        """Settle on *account* without a switch: the live rows are its, and
        any that no account claimed yet (written before v4, or by a build
        that predates it) are claimed for it."""
        self._account = account or ""
        if not self._account:
            return
        with self._db.transaction() as cur:
            for table in _ACCOUNT_TABLES:
                cur.execute(f"UPDATE {table} SET account = ? WHERE account = ''", (self._account,))

    def park_account(self, account: str | None) -> None:
        """Move every live row aside under its account and empty the tables.

        A row claimed by no account is *account*'s; with no *account* either
        it is dropped, which is what a switch did before v4. Whatever was
        parked earlier for an account whose rows are live now is stale and is
        replaced.
        """
        with self._db.transaction() as cur:
            parked: list[tuple[str, str, str]] = []
            for table in _ACCOUNT_TABLES:
                cur.execute(f"SELECT * FROM {table}")
                names = [d[0] for d in cur.description]
                for row in cur.fetchall():
                    values = dict(zip(names, row))
                    owner = str(values.get("account") or account or "")
                    if owner:
                        parked.append((owner, table, json.dumps(values)))
                cur.execute(f"DELETE FROM {table}")
            for owner in {p[0] for p in parked}:
                cur.execute("DELETE FROM sync_parked WHERE account = ? AND tbl IN (?, ?, ?)",
                            (owner, *_ACCOUNT_TABLES))
            cur.executemany("INSERT INTO sync_parked (account, tbl, row_json) VALUES (?, ?, ?)", parked)
        self._account = ""

    def restore_account(self, account: str | None) -> None:
        """Bring *account*'s parked rows back as the live ones. The live
        tables are expected empty (``park_account`` first)."""
        self._account = account or ""
        if not self._account:
            return
        with self._db.transaction() as cur:
            for table in _ACCOUNT_TABLES:
                columns = {str(r[1]) for r in cur.execute(f"PRAGMA table_info({table})").fetchall()}
                rows = cur.execute(
                    "SELECT row_json FROM sync_parked WHERE account = ? AND tbl = ? ORDER BY rowid",
                    (self._account, table),
                ).fetchall()
                for (raw,) in rows:
                    values = {k: v for k, v in json.loads(raw).items() if k in columns}
                    values["account"] = self._account
                    keys = list(values)
                    cur.execute(
                        f"INSERT OR REPLACE INTO {table} ({', '.join(keys)})"
                        f" VALUES ({', '.join('?' for _ in keys)})",
                        [values[k] for k in keys],
                    )
            cur.execute(
                "DELETE FROM sync_parked WHERE account = ? AND tbl IN (?, ?, ?)",
                (self._account, *_ACCOUNT_TABLES),
            )

    def switch_account(self, previous: str | None, account: str | None) -> None:
        self.park_account(previous)
        self.restore_account(account)

    def park_value(self, account: str, name: str, value: Any) -> None:
        """Keep one JSON value of *account*'s aside until it comes back."""
        with self._db.transaction() as cur:
            cur.execute("DELETE FROM sync_parked WHERE account = ? AND tbl = ?", (account, f"value:{name}"))
            if value is not None:
                cur.execute(
                    "INSERT INTO sync_parked (account, tbl, row_json) VALUES (?, ?, ?)",
                    (account, f"value:{name}", json.dumps(value)),
                )

    def take_parked_value(self, account: str, name: str) -> Any:
        with self._db.transaction() as cur:
            row = cur.execute(
                "SELECT row_json FROM sync_parked WHERE account = ? AND tbl = ?", (account, f"value:{name}")
            ).fetchone()
            cur.execute("DELETE FROM sync_parked WHERE account = ? AND tbl = ?", (account, f"value:{name}"))
        return json.loads(row[0]) if row else None

    # ── agreed state ────────────────────────────────────────────────────
    def state(self, scope: str, item_id: str) -> ItemState | None:
        with self._db.transaction() as cur:
            row = cur.execute(
                "SELECT rev, synced_hash, deleted, sealed_kid, synced_updated_at, wire_id, legacy_rev"
                " FROM sync_state WHERE scope = ? AND item_id = ?",
                (scope, item_id),
            ).fetchone()
        return (
            ItemState(
                int(row[0]), str(row[1]), bool(row[2]), str(row[3] or ""), str(row[4] or ""), str(row[5] or ""),
                int(row[6] or 0),
            )
            if row
            else None
        )

    def states(self, scope: str) -> dict[str, ItemState]:
        with self._db.transaction() as cur:
            rows = cur.execute(
                "SELECT item_id, rev, synced_hash, deleted, sealed_kid, synced_updated_at, wire_id, legacy_rev"
                " FROM sync_state WHERE scope = ?",
                (scope,),
            ).fetchall()
        return {
            str(r[0]): ItemState(
                int(r[1]), str(r[2]), bool(r[3]), str(r[4] or ""), str(r[5] or ""), str(r[6] or ""),
                int(r[7] or 0),
            )
            for r in rows
        }

    def set_state(
        self,
        scope: str,
        item_id: str,
        *,
        rev: int,
        synced_hash: str,
        deleted: bool,
        sealed_kid: str = "",
        synced_updated_at: str = "",
        wire_id: str = "",
    ) -> None:
        """Record what was agreed. ``synced_updated_at`` only moves forward:
        a later write with an older (or no) stamp keeps the newer one, which
        is what lets a replayed old record be told apart from a new one.

        ``wire_id`` likewise only moves forward: a hashed id is recorded when
        given, and a write that gives none ("", what every legacy-id write
        and every caller that predates D3 passes) keeps the one recorded. An
        account never goes back from hashed ids, so nothing needs to unset it.
        """
        self._check_round()
        stamp = _stamp(synced_updated_at)
        with self._db.transaction() as cur:
            cur.execute(
                """
                INSERT INTO sync_state
                    (scope, item_id, rev, synced_hash, deleted, sealed_kid, synced_updated_at, account, wire_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(scope, item_id) DO UPDATE SET
                    wire_id = CASE
                        WHEN excluded.wire_id = '' THEN sync_state.wire_id
                        ELSE excluded.wire_id
                    END,
                    account = excluded.account,
                    rev = excluded.rev,
                    synced_hash = excluded.synced_hash,
                    deleted = excluded.deleted,
                    sealed_kid = excluded.sealed_kid,
                    synced_updated_at = CASE
                        WHEN excluded.synced_updated_at > sync_state.synced_updated_at
                        THEN excluded.synced_updated_at
                        ELSE sync_state.synced_updated_at
                    END
                """,
                (
                    scope, item_id, int(rev), synced_hash, 1 if deleted else 0,
                    sealed_kid or "", stamp, self._account, wire_id or "",
                ),
            )

    def set_legacy_rev(self, scope: str, item_id: str, rev: int) -> None:
        """Record the legacy tombstone *item_id* owes (``ItemState.legacy_rev``;
        0: none). ``set_state`` leaves the column as it is."""
        self._check_round()
        with self._db.transaction() as cur:
            cur.execute(
                "UPDATE sync_state SET legacy_rev = ? WHERE scope = ? AND item_id = ?",
                (max(int(rev), 0), scope, item_id),
            )

    # ── cursor ──────────────────────────────────────────────────────────
    def cursor(self, scope: str) -> int:
        with self._db.transaction() as cur:
            row = cur.execute(
                "SELECT cursor FROM sync_cursor WHERE scope = ?", (scope,)
            ).fetchone()
        return int(row[0]) if row else 0

    def set_cursor(self, scope: str, value: int) -> None:
        self._check_round()
        with self._db.transaction() as cur:
            cur.execute(
                """
                INSERT INTO sync_cursor (scope, cursor, account) VALUES (?, ?, ?)
                ON CONFLICT(scope) DO UPDATE SET cursor = excluded.cursor, account = excluded.account
                """,
                (scope, int(value), self._account),
            )

    # ── conflicts ───────────────────────────────────────────────────────
    def record_conflict(
        self,
        scope: str,
        item_id: str,
        *,
        local: Any,
        remote: Any,
        remote_rev: int,
        remote_device: str,
        sealed: bool = False,
        remote_kid: str = "",
        remote_wire: str = "",
    ) -> None:
        """Remember a clash. ``sealed`` stores both payloads as ciphertext.

        The sealing happens before the row is written, so SQLite — its journal
        and WAL included — never receives the plaintext. Both halves are sealed
        under the same associated data as the record itself; a conflict row is
        the same item, at rest, in a second place.
        """
        if sealed:
            local_text = sync_keyring.encrypt(canonical(local), scope=scope, item_id=item_id)
            remote_text = sync_keyring.encrypt(canonical(remote), scope=scope, item_id=item_id)
        else:
            local_text = canonical(local)
            remote_text = canonical(remote)
        self._check_round()
        with self._db.transaction() as cur:
            cur.execute(
                """
                INSERT INTO sync_conflicts
                    (scope, item_id, local_json, remote_json, remote_rev, remote_device,
                     seen_at, sealed, remote_kid, account, remote_wire)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(scope, item_id) DO UPDATE SET
                    account = excluded.account,
                    local_json = excluded.local_json,
                    remote_json = excluded.remote_json,
                    remote_rev = excluded.remote_rev,
                    remote_device = excluded.remote_device,
                    seen_at = excluded.seen_at,
                    sealed = excluded.sealed,
                    remote_kid = excluded.remote_kid,
                    remote_wire = excluded.remote_wire
                """,
                (
                    scope,
                    item_id,
                    local_text,
                    remote_text,
                    int(remote_rev),
                    remote_device,
                    int(time.time()),
                    1 if sealed else 0,
                    remote_kid or "",
                    self._account,
                    remote_wire or "",
                ),
            )
        log.info("sync conflict on %s/%s — waiting for the user", scope, item_id)

    def _conflict_rows(self, scope: str | None) -> list[tuple[Any, ...]]:
        sql = (
            "SELECT scope, item_id, local_json, remote_json, remote_rev, remote_device, "
            "seen_at, sealed, remote_kid, remote_wire FROM sync_conflicts"
        )
        args: tuple[Any, ...] = ()
        if scope:
            sql += " WHERE scope = ?"
            args = (scope,)
        sql += " ORDER BY seen_at DESC"
        with self._db.transaction() as cur:
            return cur.execute(sql, args).fetchall()

    def _open_sealed(self, scope: str, item_id: str, text: str) -> Any:
        return json.loads(sync_keyring.decrypt(text, scope=scope, item_id=item_id))

    def conflicts(self, scope: str | None = None) -> list[dict[str, Any]]:
        """Every unresolved clash, as a caller outside the engine may see it.

        A sealed row's ``local``/``remote`` are the scope's ``describe()`` of
        each half, or ``SEALED_PLACEHOLDER`` when it cannot be opened here.
        The payloads themselves leave this class only through
        ``conflict_payloads``, which ``resolve`` uses and nothing else should.
        """
        out: list[dict[str, Any]] = []
        for r in self._conflict_rows(scope):
            row_scope, item_id, sealed = str(r[0]), str(r[1]), bool(r[7])
            if sealed:
                redact = self._redactors.get(row_scope)
                local, remote = self._redacted(row_scope, item_id, r[2], r[3], redact)
            else:
                local, remote = json.loads(r[2]), json.loads(r[3])
            out.append(
                {
                    "scope": row_scope,
                    "itemId": item_id,
                    "local": local,
                    "remote": remote,
                    "remoteRev": int(r[4]),
                    "remoteDevice": str(r[5]),
                    "seenAt": int(r[6]),
                    "sealed": sealed,
                    # The server answered rev 0: it holds no row for this item
                    # at all (it never had one, or it is another account's
                    # server). "Keep the cloud copy" would mean deleting the
                    # local one for nothing, so resolve refuses it.
                    "remoteAbsent": int(r[4]) == 0,
                }
            )
        return out

    def _redacted(
        self,
        scope: str,
        item_id: str,
        local_text: str,
        remote_text: str,
        redact: Callable[[Any], dict[str, Any] | None] | None,
    ) -> tuple[Any, Any]:
        if redact is None:
            # No registered describer means no way to say anything safe about
            # the payload, so nothing is said.
            return dict(SEALED_PLACEHOLDER), dict(SEALED_PLACEHOLDER)
        out: list[Any] = []
        for text in (local_text, remote_text):
            try:
                payload = self._open_sealed(scope, item_id, text)
            except Exception:  # noqa: BLE001 - "cannot open here" is an answer
                out.append(dict(SEALED_PLACEHOLDER))
                continue
            described = None
            try:
                described = redact(payload)
            except Exception as err:  # noqa: BLE001 - never leak by failing open
                log.warning("%s could not describe a conflict half: %s", scope, _why(err))
            out.append(described if isinstance(described, dict) else dict(SEALED_PLACEHOLDER))
        return out[0], out[1]

    def conflict_payloads(self, scope: str, item_id: str) -> dict[str, Any] | None:
        """One clash with its real payloads — for the engine's own resolve.

        Raises ``KeyringError`` when a sealed row cannot be opened; the caller
        turns that into "resolve is not possible on this machine right now".
        """
        for r in self._conflict_rows(scope):
            if str(r[1]) != item_id:
                continue
            sealed = bool(r[7])
            local = self._open_sealed(scope, item_id, r[2]) if sealed else json.loads(r[2])
            remote = self._open_sealed(scope, item_id, r[3]) if sealed else json.loads(r[3])
            return {
                "scope": str(r[0]),
                "itemId": item_id,
                "local": local,
                "remote": remote,
                "remoteRev": int(r[4]),
                "remoteDevice": str(r[5]),
                "seenAt": int(r[6]),
                "sealed": sealed,
                "remoteKid": str(r[8] or ""),
                "remoteWire": str(r[9] or ""),
            }
        return None

    def conflict_ids(self, scope: str) -> set[str]:
        with self._db.transaction() as cur:
            rows = cur.execute(
                "SELECT item_id FROM sync_conflicts WHERE scope = ?", (scope,)
            ).fetchall()
        return {str(r[0]) for r in rows}

    def clear_conflict(self, scope: str, item_id: str) -> None:
        self._check_round()
        with self._db.transaction() as cur:
            cur.execute(
                "DELETE FROM sync_conflicts WHERE scope = ? AND item_id = ?", (scope, item_id)
            )

    def forget(self, scope: str) -> None:
        """Drop everything known about a scope — used when it is switched off."""
        self._check_round()
        with self._db.transaction() as cur:
            cur.execute("DELETE FROM sync_state WHERE scope = ?", (scope,))
            cur.execute("DELETE FROM sync_cursor WHERE scope = ?", (scope,))
            cur.execute("DELETE FROM sync_conflicts WHERE scope = ?", (scope,))


RequestFn = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


class SyncEngine:
    """Drives one round of pull-then-push per scope."""

    def __init__(
        self,
        store: SyncStore,
        request: RequestFn,
        *,
        device_id: Callable[[], str],
        enabled: Callable[[str], bool],
        signing_key_for: Callable[[str], str] | None = None,
        on_result: Callable[[dict[str, Any]], None] | None = None,
        account_member: Callable[[], str] | None = None,
        on_forget: Callable[[str], None] | None = None,
    ) -> None:
        self._store = store
        self._request = request
        self._device_id = device_id
        self._enabled = enabled
        if signing_key_for is None:
            # A pin taken under another member does not vouch for a device of
            # this account: the member is part of what was pinned.
            signing_key_for = (
                (lambda device: _pinned_signing_key(device, account_member()))
                if account_member is not None
                else _pinned_signing_key
            )
        self._signing_key_for = signing_key_for
        #: Told when a cursor reset forgets a scope, so state kept outside the
        #: store about that scope's items (detached marks) goes with it.
        self._on_forget = on_forget or (lambda _scope: None)
        #: Told every round's result (see ``sync``) — the link broadcasts it
        #: to the renderer as ``sync.result``. Must not raise; it is guarded.
        self._on_result = on_result
        #: The last result of each scope, for ``sync.status``.
        self._last: dict[str, dict[str, Any]] = {}
        #: Per scope, the largest pulled row seen in this process, in bytes.
        self._row_bytes: dict[str, int] = {}
        #: Per scope, a page size the server's replies forced down: a page that
        #: closed the socket (``FrameTooLarge``) halves it, down to one row, and
        #: a pull that reads to the end drops it. A server with no reply byte
        #: cap would otherwise close the shared link on the same page every
        #: round, for good — the page that is too big never arrives, so its
        #: rows can never teach ``_row_bytes`` their size.
        self._pull_caps: dict[str, int] = {}
        #: Items whose ``apply`` deferred, by (scope, item id): attempts, first
        #: and next-allowed time. In memory on purpose: the stored cursor
        #: already keeps a held row coming back across restarts, so all that
        #: is lost on a restart is the backoff, which then starts over.
        self._defers: dict[tuple[str, str], dict[str, float]] = {}
        self._clock: Callable[[], float] = time.monotonic
        #: Per scope, when it last started over (``_pull``); in memory.
        self._last_reset: dict[str, float] = {}
        #: The store generation the in-memory bookkeeping above belongs to.
        self._memory_generation = store.generation
        #: Per scope, local deletes carried across a cursor reset.
        self._reset_deletes: dict[str, set[str]] = {}
        self._adapters: dict[str, ScopeAdapter] = {}
        #: Per scope, the highest cursor a push reply may move to while a
        #: pulled row is waiting for its key. Set by ``_pull``, honoured by
        #: ``_record_reply``: the push's own accepted revs sit above the held
        #: row, and recording them as read would step the cursor past it.
        self._cursor_barrier: dict[str, int] = {}
        #: One round per scope at a time. A save that asks for a push while
        #: the connect-time round is still running must queue behind it, not
        #: interleave with it: both would read one snapshot and push the
        #: same items from the same base rev, and one of them would come
        #: back as a conflict with itself.
        self._locks: dict[str, asyncio.Lock] = {}
        #: Rounds started by ``_kick``, held so they are not collected mid-run.
        self._kicked: set[asyncio.Task[Any]] = set()
        #: Per scope, the items the running round could not take or send, by
        #: reason ("refused", "held", "tooLarge"). Filled from worker threads,
        #: read once the round ends; one round per scope runs at a time.
        self._notes: dict[str, dict[str, list[str]]] = {}
        #: Per scope, the last ``_reverse`` map and the snapshot it is for.
        self._reverse_cache: dict[str, tuple[dict[str, Any], dict[str, str]]] = {}
        #: What this connection negotiated (``sync.caps``); None until asked.
        self._caps: dict[str, Any] | None = None
        #: Whether this connection already asked to adopt hashed item ids.
        self._adopt_tried = False

    def reset_connection(self) -> None:
        """A new connection: what the last one negotiated no longer holds."""
        self._caps = None
        self._adopt_tried = False

    async def _negotiate(self) -> dict[str, Any]:
        """This connection's capabilities, asked for once per connection.

        Any refusal of ``sync.caps`` — an older server's UNKNOWN_TYPE, a MySQL
        server's UNSUPPORTED, anything — means v1, the wire as it always was;
        so does ``NAVIDE_SYNC_PROTOCOL=1``. A request that got no answer at
        all is v1 for this call only and asked again next time.
        """
        if self._caps is None:
            caps = await self._ask_caps()
            if caps is None:
                return dict(_V1_CAPS)
            self._caps = caps
        return self._caps

    async def _ask_caps(self) -> dict[str, Any] | None:
        if os.environ.get("NAVIDE_SYNC_PROTOCOL") == "1":
            return dict(_V1_CAPS)
        try:
            reply = await self._call("sync.caps", {"protocol": 3})
        except StaleRound:
            raise
        except Exception as err:  # noqa: BLE001 - no answer: v1 for now
            log.info("sync.caps got no answer (%s); speaking v1 for now", _why(err))
            return None
        payload = reply.get("payload") if isinstance(reply, dict) and reply.get("ok") else None
        if not isinstance(payload, dict) or payload.get("version") != 3:
            return dict(_V1_CAPS)
        return dict(payload)

    async def _maybe_adopt(self, caps: dict[str, Any]) -> dict[str, Any]:
        """D3: ask once per connection to move the account to hashed ids.

        Rooted at this machine's active key. The server agrees only when every
        recently seen device speaks v3; until then (HMAC_NOT_READY, or any
        other refusal) items keep their legacy ids for this connection.
        """
        if (
            not _is_v3(caps) or caps.get("storage") != "s3" or caps.get("itemIds") != "legacy"
            or caps.get("adoptHmac") is False or self._adopt_tried
        ):
            # Only an object account on a v3 connection changes its item ids;
            # the server refuses the rest (UNSUPPORTED), and a v1 connection
            # (an older server, a caps answer that never came) never asks.
            # Contract c8: not when caps says the account may not
            # (``adoptHmac: false``). A server that does not say (c7) is asked
            # once per connection, and its UNSUPPORTED ends it.
            return caps
        root = await asyncio.to_thread(sync_keyring.active_key_id)
        if not root:
            return caps
        self._adopt_tried = True
        try:
            reply = await self._call("sync.adoptHmacIds", {"rootKid": root})
        except StaleRound:
            raise
        except Exception as err:  # noqa: BLE001 - stays on legacy ids
            log.info("sync.adoptHmacIds got no answer (%s); item ids stay legacy", _why(err))
            return caps
        payload = reply.get("payload") if isinstance(reply, dict) and reply.get("ok") else None
        if not isinstance(payload, dict) or payload.get("itemIds") != "hmac" or not payload.get("itemIdKid"):
            error = reply.get("error") if isinstance(reply, dict) and isinstance(reply.get("error"), dict) else {}
            details = error.get("details")
            # {blockingDevices: [...]} per the contract; a bare list tolerated.
            if isinstance(details, dict):
                details = details.get("blockingDevices")
            blocking = [
                f"{d.get('deviceId')} (last seen {d.get('lastSeenAt')})"
                for d in (details if isinstance(details, list) else []) if isinstance(d, dict)
            ]
            log.info(
                "the account stays on legacy item ids for now (%s)%s",
                error.get("code") or "no answer",
                f"; waiting for {', '.join(blocking)}" if blocking else "",
            )
            return caps
        adopted = {**caps, "itemIds": "hmac", "itemIdKid": str(payload["itemIdKid"])}
        if self._caps is caps:
            self._caps = adopted
        log.info("the account now names synced items by hashed ids")
        return adopted

    def _heed_refusal(self, msg_type: str, reply: Any) -> None:
        """Forget the negotiated capabilities when a refusal says they no
        longer hold, so the next transfer asks again."""
        if msg_type == "sync.caps" or not isinstance(reply, dict) or reply.get("ok"):
            return
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        code = str(error.get("code") or "")
        if code in _RENEGOTIATE or (
            # On a v3 connection a refused record can mean the account moved
            # on (another device adopted hashed ids) since this one asked.
            code == "BAD_REQUEST" and self._caps is not None and _is_v3(self._caps)
            and msg_type in ("sync.push", "sync.pull")
        ):
            self._caps = None

    def register(self, adapter: ScopeAdapter) -> None:
        if adapter.scope not in SCOPES + INTERNAL_SCOPES:
            raise SyncError(f"{adapter.scope!r} is not a protocol scope")
        if adapter.scope in LOCAL_ONLY_SCOPES or _sensitive(adapter):
            raise SyncError(f"{adapter.scope!r} holds credentials or keys, which never leave this machine")
        self._adapters[adapter.scope] = adapter
        if _sensitive(adapter):
            self._store.set_redactor(adapter.scope, lambda payload: _describe(adapter, payload))

    @property
    def scopes(self) -> list[str]:
        # Internal scopes last: skill-files follows skills, whose settings the
        # files are applied under.
        return [s for s in SCOPES + INTERNAL_SCOPES if s in self._adapters]

    # ── one round ───────────────────────────────────────────────────────
    async def sync(self, scope: str) -> dict[str, Any]:
        """One round of *scope*, and what came of it.

        The answer always has the same shape — ``scope``, ``ok``, ``pulled``,
        ``pushed``, ``conflicts``, ``held``, ``refused``, ``tooLarge``, ``at``,
        plus ``skipped`` or ``error`` when they apply — and is remembered as the
        scope's last result and handed to ``on_result``. A failed round is
        recorded the same way and then re-raised, so a caller that asked for
        this scope by name still hears the failure.
        """
        try:
            result = await self._round(scope)
        except Exception as err:
            self._finish(scope, {"ok": False, "error": _why(err)})
            raise
        return self._finish(scope, result)

    async def _round(self, scope: str) -> dict[str, Any]:
        # The generation is taken before anything is checked: a round that
        # passed its checks for one account and then waited for the lock
        # while the account changed must find out, not run for the next one.
        token = _round_generation.set((self._store, self._store.generation))
        try:
            if scope in LOCAL_ONLY_SCOPES:
                return {"skipped": "local-only"}
            adapter = self._adapters.get(scope)
            if adapter is None:
                raise SyncError(f"no adapter registered for {scope!r}")
            if not self._enabled(scope):
                return {"skipped": "disabled"}
            if not await asyncio.to_thread(sync_keyring.has_account_key):
                return {"skipped": "no-key"}
            async with self._locks.setdefault(scope, asyncio.Lock()):
                self._store._check_round()
                if not self._enabled(scope):
                    return {"skipped": "disabled"}
                return await self._locked_round(scope, adapter)
        finally:
            _round_generation.reset(token)

    def _drop_memory_of_other_accounts(self) -> None:
        """Forget what is kept in memory about a previous account.

        Deletes remembered across a reset, reset times and deferral backoff
        all describe items of the account they were gathered under. The store
        forgets its half on an account change; this half is checked against
        the store's generation whenever a transfer starts, and dropped whole
        when it no longer matches — a delete remembered for A must never be
        sent against B's item of the same name.
        """
        if self._memory_generation == self._store.generation:
            return
        self._reset_deletes.clear()
        self._last_reset.clear()
        self._defers.clear()
        self._memory_generation = self._store.generation

    async def _locked_round(self, scope: str, adapter: ScopeAdapter) -> dict[str, Any]:
        self._drop_memory_of_other_accounts()
        self._notes[scope] = {}
        caps = await self._negotiate()
        if _retired(caps, scope):
            return {"skipped": "retired"}
        caps = await self._maybe_adopt(caps)
        await asyncio.to_thread(_require_item_id_key, caps)
        with _using(caps):
            return await self._round_under_caps(scope, adapter)

    async def _round_under_caps(self, scope: str, adapter: ScopeAdapter) -> dict[str, Any]:
        # An adapter that needs the server for more than records (blob
        # transfers) is handed the connection here, and may decline the
        # round when the server cannot serve it.
        prepare = getattr(adapter, "prepare", None)
        if prepare is not None and not await prepare(self._request, lambda: self._kick(scope)):
            return {"skipped": "unsupported"}
        try:
            pulled = await self._pull(adapter)
        except _ResetThrottled:
            # Nothing is pushed either: this machine's revs and the server's
            # disagree, and edits pushed from them would be guesses.
            return {"resetThrottled": True}
        pushed = await self._push(adapter)
        return {"pulled": pulled, "pushed": pushed}

    def _finish(self, scope: str, outcome: dict[str, Any]) -> dict[str, Any]:
        notes = self._notes.pop(scope, {})
        adapter = self._adapters.get(scope)
        # The adapter's own view joins the engine's: ``oversized()`` is a
        # standing state, not only what this round tried to send, and
        # ``failed()`` names items it gave up on itself (it answered False,
        # which the engine saw as a refusal) — those read as held and given
        # up, not as refused.
        if adapter is not None:
            failed = _adapter_ids(adapter, "failed")
            notes["refused"] = [i for i in notes.get("refused", []) if i not in failed]
            for reason in ("held", "gaveUp"):
                notes[reason] = _merged(notes.get(reason, []), failed)
            notes["tooLarge"] = _merged(notes.get("tooLarge", []), _adapter_ids(adapter, "oversized"))
        try:
            conflicts = len(self._store.conflict_ids(scope))
        except Exception:  # noqa: BLE001 - a result is still worth reporting
            conflicts = 0
        result: dict[str, Any] = {
            "scope": scope,
            "ok": True,
            "pulled": 0,
            "pushed": 0,
            "conflicts": conflicts,
            "held": list(notes.get("held", [])),
            "refused": list(notes.get("refused", [])),
            "tooLarge": list(notes.get("tooLarge", [])),
            # Held items that have deferred too often or too long; a subset
            # of ``held``, still retried.
            "gaveUp": list(notes.get("gaveUp", [])),
            # The server asked this scope to start over again within the hour
            # and was refused; nothing was pulled, pushed or forgotten.
            "resetThrottled": False,
            **outcome,
            "at": now_iso(),
        }
        self._last[scope] = result
        if self._on_result is not None:
            try:
                self._on_result(dict(result))
            except Exception as err:  # noqa: BLE001 - a listener cannot fail a round
                log.warning("the sync result listener failed: %s", _why(err))
        return result

    def last_results(self) -> dict[str, dict[str, Any]]:
        """The last result of each scope that has run since this process began."""
        return {scope: dict(result) for scope, result in self._last.items()}

    def forget_results(self) -> None:
        """Drop the remembered results — they belonged to another account."""
        self._last.clear()

    def cancel_rounds(self) -> None:
        """Cancel the rounds ``_kick`` started — on an account change, so one
        begun for the previous account does not run on into the next."""
        for task in list(self._kicked):
            task.cancel()

    async def _call(self, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        """``_request``, refused for a stale round on either side of the wire:
        nothing goes out for the previous account, and its reply is not read."""
        self._store._check_round()
        reply = await self._request(msg_type, payload)
        self._store._check_round()
        self._heed_refusal(msg_type, reply)
        return reply

    def _kick(self, scope: str) -> None:
        """Run one more round of *scope* soon. For an adapter whose background
        work (a finished download) has made a held record appliable."""
        # The adapter says its files are here: retry now, not at the end of
        # the backoff a deferral earned while they were on their way.
        for key in [k for k in self._defers if k[0] == scope]:
            self._defers[key]["next"] = 0.0
        task = asyncio.get_running_loop().create_task(self.sync(scope))
        self._kicked.add(task)
        task.add_done_callback(self._kicked.discard)

    async def sync_all(self) -> list[dict[str, Any]]:
        results = []
        for scope in self.scopes:
            try:
                results.append(await self.sync(scope))
            except Exception as err:  # noqa: BLE001 - one bad scope must not stop the rest
                log.warning("sync of %s failed: %s", scope, _why(err))
                results.append(self._last.get(scope) or {"scope": scope, "ok": False, "error": _why(err)})
        return results

    # ── pull ────────────────────────────────────────────────────────────
    async def _pull(self, adapter: ScopeAdapter) -> int:
        scope = adapter.scope
        applied = 0
        self._cursor_barrier.pop(scope, None)
        reset = False
        #: Paging position, kept apart from the stored cursor: a held row stops
        #: the stored cursor just short of it, but not the reading of the rows
        #: behind it — one item that cannot land must not hold the whole scope.
        since = self._store.cursor(scope)
        barrier: int | None = None
        pages = 0
        finished = False
        while True:
            pages += 1
            limit = self._pull_limit(scope)
            try:
                raw_reply = await self._call(
                    "sync.pull", {"scope": scope, "since": since, "limit": limit}
                )
            except FrameTooLarge:
                self._pull_caps[scope] = max(1, limit // 2)
                log.warning(
                    "sync.pull on %s: a page of %d rows closed the link as too large; asking for %d next",
                    scope, limit, self._pull_caps[scope],
                )
                raise
            reply = _payload(raw_reply)
            if not reset and since > 0 and int(reply.get("cursor") or 0) < since:
                last = self._last_reset.get(scope)
                if last is not None and self._clock() - last < RESET_THROTTLE_S:
                    # A second reset within the hour. A real account switch
                    # or server reset happens once; one that keeps coming is
                    # the server asking, and nothing is forgotten for it.
                    log.warning(
                        "sync.pull on %s: the server asked for another reset within the hour; refused",
                        scope,
                    )
                    raise _ResetThrottled()
                self._last_reset[scope] = self._clock()
                # The server has never issued the revs this machine has read up
                # to: another account behind the same link, or a server that
                # started over. Everything recorded against the old revs is
                # about rows that are not there, so the scope is read again from
                # the start and its items go up as new ones. Once per round.
                log.warning(
                    "sync.pull on %s: the server's cursor is behind ours; starting %s over",
                    scope, scope,
                )
                # A delete made here and not yet carried up would be lost with
                # the state it is computed from — and the re-read below would
                # bring the item back. Remembered across the reset instead.
                pending = await asyncio.to_thread(self._pending_deletes, adapter)
                self._reset_deletes[scope] = pending
                self._store.forget(scope)
                for item_id in pending:
                    # Written down at once, so a restart before the re-read
                    # reaches the item still carries the delete up (from rev
                    # 0, which the server answers as a conflict to ask about
                    # rather than as nothing).
                    self._store.set_state(scope, item_id, rev=0, synced_hash="", deleted=False)
                try:
                    await asyncio.to_thread(self._on_forget, scope)
                except Exception as err:  # noqa: BLE001 - the reset itself happened
                    log.warning("could not let go of %s's marks after a reset: %s", scope, _why(err))
                reset = True
                since = 0
                continue
            items = reply.get("items")
            items = items if isinstance(items, list) else []
            self._learn_rows(scope, items)
            await self._hydrate(scope, items)
            count, held_rev = await asyncio.to_thread(self._apply_page, adapter, items)
            applied += count
            # The reply's ``cursor`` is the scope's current maximum rev, not the
            # last rev of this page. Stepping on it while ``more`` is set would
            # skip every row between this page and the maximum — for good. So a
            # page that is not the last one advances to its own highest row, and
            # only the last page may take the server's maximum.
            highest = max((_rev_of(raw) for raw in items), default=since)
            cursor = highest if reply.get("more") else max(highest, int(reply.get("cursor") or since))
            if held_rev is not None and barrier is None:
                # A record sealed under a key this machine has not been handed
                # yet, or whose files are still on their way. The stored cursor
                # stops just short of it for good — across restarts too — so a
                # later round reads it again; the rows behind it are applied
                # now and simply re-read (as no-ops) until it lands.
                barrier = max(0, held_rev - 1)
                log.info("sync.pull on %s is holding at rev %d (a newer key, or files in transit)", scope, held_rev)
            stored = self._store.cursor(scope)
            durable = cursor if barrier is None else min(cursor, barrier)
            if durable > stored:
                self._store.set_cursor(scope, durable)
            if not reply.get("more"):
                finished = True
                break
            if cursor <= since:
                # No progress and the server still says "more": stop rather
                # than loop forever on a server that disagrees with itself.
                log.warning("sync.pull on %s made no progress; stopping this round", scope)
                break
            if pages >= MAX_PULL_PAGES:
                log.warning("sync.pull on %s read %d pages; the next round carries on", scope, pages)
                break
            since = cursor
        if barrier is not None:
            self._cursor_barrier[scope] = max(barrier, self._store.cursor(scope))
        if finished:
            # The re-read reached the end: a remembered delete whose item was
            # not on the server at all goes up from rev 0 as it stands.
            self._reset_deletes.pop(scope, None)
            # The rows read on the way have taught ``_row_bytes`` their size.
            self._pull_caps.pop(scope, None)
        return applied

    def _pending_deletes(self, adapter: ScopeAdapter) -> set[str]:
        """Items this machine deleted that the next push would carry up."""
        if _sensitive(adapter):
            return set()
        snapshot = adapter.snapshot()
        oversized = set(_adapter_ids(adapter, "oversized"))
        return {
            item_id
            for item_id, state in self._store.states(adapter.scope).items()
            if not state.deleted and item_id not in snapshot and item_id not in oversized
        }

    def _apply_page(
        self, adapter: ScopeAdapter, items: list[Any]
    ) -> tuple[int, int | None]:
        """Apply one pull page. Runs in a worker thread; touches disk freely.

        Returns how many rows were applied and the lowest rev of a row that
        is held — a key this machine lacks, or files still on their way — or
        None. A held row does not stop the rows behind it.
        """
        # A copy, kept current as rows land: two rows of one item can share a
        # page (a migration's legacy tombstone, then its hashed copy resent),
        # and the second must be compared with what the first left here.
        snapshot = dict(adapter.snapshot())
        blocked = self._store.conflict_ids(adapter.scope)
        applied = 0
        held: int | None = None
        for raw in sorted(items, key=_rev_of):
            try:
                if self._apply_one(adapter, raw, snapshot, blocked):
                    applied += 1
            except _HoldPull as hold:
                self._note(adapter.scope, "held", hold.item_id)
                if self._gave_up(adapter.scope, hold.item_id):
                    self._note(adapter.scope, "gaveUp", hold.item_id)
                held = hold.rev if held is None else min(held, hold.rev)
                if _sensitive(adapter):
                    # A secret scope keeps the stricter rule: nothing behind a
                    # held row is applied until it lands.
                    break
        return applied, held

    def _apply_one(
        self,
        adapter: ScopeAdapter,
        raw: Any,
        snapshot: dict[str, Any],
        blocked: set[str],
        *,
        explicit: bool = False,
    ) -> bool:
        """Apply one pulled row. ``explicit`` marks a row the user asked for by
        name (``pull_items``): then even this device's own write is applied,
        because asking for it means this machine no longer holds it."""
        scope = adapter.scope
        self._store._check_round()
        if not isinstance(raw, dict):
            return False
        # D3: the row's id is what the server knows it by and what its
        # signature and sealing are bound to; the name is what this machine
        # keeps it under. The same string on a legacy id.
        wire_id = str(raw.get("itemId") or "")
        hashed_wire = wire_id if sync_keyring.is_hashed_item_id(wire_id) else ""
        opened: Any = _UNOPENED
        if hashed_wire:
            item_id, opened = self._resolve_hashed(adapter, raw, snapshot)
        else:
            item_id = wire_id
            if item_id and _hmac_kid(_caps_now()):
                prior_state = self._store.state(scope, item_id)
                if prior_state is not None and prior_state.wire_id:
                    # The item moved to its hashed id: a legacy row of it —
                    # the migration's tombstone above all — is a rename,
                    # not a delete or an edit.
                    return False
        if hashed_wire and item_id in blocked and self._stale_delete_clash(scope, item_id):
            # A delete pushed under the legacy id on a connection that had not
            # heard of the migration met the migration's own legacy tombstone.
            # Now that the hashed copy is here, that clash was a rename: it is
            # dropped, and this row is read as one (the delete still stands,
            # and goes up under the hashed id).
            self._store.clear_conflict(scope, item_id)
            blocked.discard(item_id)
        if not item_id or item_id in blocked:
            return False
        rev = int(raw.get("rev") or 0)
        device = str(raw.get("deviceId") or "")
        updated_at = str(raw.get("updatedAt") or "")
        deleted = bool(raw.get("deleted"))
        body = str(raw.get("body") or "")
        origin = self._origin(raw, scope=scope, item_id=wire_id)
        if origin == _ORIGIN_FORGED:
            log.warning("dropping %s/%s: its signature does not match the pinned key", scope, item_id)
            self._note(scope, "refused", item_id)
            return False
        if item_id in self._reset_deletes.get(scope, ()):
            # Deleted here before a reset (see ``_pull``): the row is not
            # applied — even when it came as a too-large stub — only its rev
            # recorded, so the push that follows sends the delete against it.
            self._store.set_state(scope, item_id, rev=rev, synced_hash="", deleted=deleted, wire_id=hashed_wire)
            self._reset_deletes[scope].discard(item_id)
            return False
        if raw.get("tooLarge"):
            # A row the server would not fit in a frame: it names the item and
            # its rev and carries no body. Neither a delete nor anything to
            # apply; reported, and the cursor moves past it as usual.
            self._note(scope, "tooLarge", item_id)
            return False
        # SEC-4: the server hands out revs, so it can serve any stored row again
        # under a new one — an old body, or an old tombstone. A record whose
        # updatedAt is older than the copy this machine last agreed on is such a
        # replay: never applied and never a delete, but asked about below. One
        # that names this machine is our own old write and is simply ignored.
        stamp = _stamp(updated_at)
        prior = self._store.state(scope, item_id)
        replayed = bool(
            stamp and prior is not None and prior.synced_updated_at
            and stamp < prior.synced_updated_at
        )
        if replayed and device == self._device_id() and not explicit:
            log.warning("ignoring %s/%s: an older copy of this machine's own write came back", scope, item_id)
            return False
        if device == self._device_id() and not explicit:
            # Our own write coming back. Record the rev so the next push edits
            # from the right base, but there is nothing to apply. The key it
            # is under is read off the body: it is what we sent, and an empty
            # record here would have the next push send it all over again.
            state = self._store.state(scope, item_id)
            if state is not None:
                self._store.set_state(
                    scope,
                    item_id,
                    rev=rev,
                    synced_hash=state.synced_hash,
                    deleted=deleted,
                    sealed_kid="" if deleted else (_kid_of(body) or state.sealed_kid),
                    synced_updated_at=stamp,
                    wire_id=hashed_wire,
                )
            return False
        try:
            remote = None if deleted else (
                opened if opened is not _UNOPENED
                else json.loads(sync_keyring.decrypt(body, scope=scope, item_id=wire_id))
            )
        except sync_keyring.UnknownKeyId:
            raise _HoldPull(rev, item_id)
        except Exception as err:  # noqa: BLE001 - an unreadable record is not fatal
            if _sensitive(adapter):
                # A credential that will not open is not a row to step over:
                # skipping it would move the cursor past a secret this machine
                # never received. The round fails and is retried whole.
                raise SyncError(f"{scope}/{item_id} could not be opened ({type(err).__name__})") from err
            log.warning("dropping %s/%s: %s", scope, item_id, _why(err))
            return False
        remote = _inbound(adapter, remote)

        state = self._store.state(scope, item_id)
        local = snapshot.get(item_id)
        local_hash = digest(local) if item_id in snapshot else ""
        agreed_hash = state.synced_hash if state else ""
        if agreed_hash != local_hash and _agreed_before(adapter, item_id, agreed_hash):
            agreed_hash = local_hash
        remote_hash = "" if remote is None else digest(remote)
        # Applying over an edit this machine has not pushed yet would lose it.
        # That is the one thing this engine must never do, so it becomes a
        # conflict even though the server was happy to hand the record over —
        # unless the two edits are the same bytes, in which case there is
        # nothing to lose and nothing to ask: two devices that pasted the same
        # token, or two that both resealed one after a rotation, just agree.
        #
        # For a sensitive scope an *absent* local item is never an edit: it
        # means "removed here" or "never set up here", the same absence that
        # sends no tombstone, so an incoming record is offered to the adapter
        # rather than parked as a clash.
        absent_ok = _sensitive(adapter) and item_id not in snapshot
        # A tombstone carries no ciphertext, so nothing but the signature says
        # who wrote it — and a device this machine never pinned has nothing to
        # check that against. A server could mint one for any item. Such a
        # delete is not applied over something this machine holds; it is asked
        # about, the same way a clash is. A live record needs no such care: its
        # body opened under the account key, which is the proof of origin.
        unproven_delete = (
            remote is None and origin == _ORIGIN_UNKNOWN and item_id in snapshot
            and not _sensitive(adapter)
        )
        if (
            hashed_wire and not replayed and state is not None and state.wire_id != hashed_wire
            and agreed_hash and remote_hash == agreed_hash and local_hash != agreed_hash
        ):
            # D3: another device migrated the very copy this machine agreed
            # on to its hashed id. A rename, not an edit: the id and rev move
            # over, the agreed hash stays, and an edit or delete made here
            # and not pushed yet goes up under the hashed id next.
            self._store.set_state(
                scope,
                item_id,
                rev=rev,
                synced_hash=agreed_hash,
                deleted=False,
                sealed_kid=_kid_of(body),
                synced_updated_at=stamp,
                wire_id=hashed_wire,
            )
            return False
        if unproven_delete or (replayed and local_hash != remote_hash) or (
            local_hash != agreed_hash and local_hash != remote_hash and not absent_ok
        ):
            self._store.record_conflict(
                scope,
                item_id,
                local=local,
                remote=remote,
                remote_rev=rev,
                remote_device=device,
                sealed=_sensitive(adapter),
                remote_kid="" if deleted else _kid_of(body),
                remote_wire=hashed_wire,
            )
            if hashed_wire:
                # D3: later rows of the same page about this item — the
                # migration's legacy tombstone right behind its hashed copy —
                # must not record a second conflict over this one.
                blocked.add(item_id)
            return False
        held = True
        if local_hash != remote_hash:
            # An adapter may answer False to say it declined the record and
            # does not hold it — a credential switched off on this device.
            # The rev is still recorded so the row is not re-read, but the
            # agreed hash stays empty: this machine holds nothing for it.
            if self._backing_off(scope, item_id):
                raise _HoldPull(rev, item_id)
            try:
                held = adapter.apply(item_id, remote) is not False
                self._defers.pop((scope, item_id), None)
            except DeferItem:
                self._deferred(scope, item_id)
                raise _HoldPull(rev, item_id) from None
            except Exception as err:  # noqa: BLE001 - a refusal, see below
                if _sensitive(adapter):
                    raise
                # The class only: an adapter's message may quote the payload.
                log.warning("%s refused %s (%s)", scope, item_id, type(err).__name__)
                held = False
            if not held and not _sensitive(adapter):
                # A refusal of an ordinary scope records nothing. Writing the
                # rev down with an empty hash read, on the next push, as "this
                # machine deleted it" (absent from the snapshot) or "this
                # machine edited it" (an older copy still there) — and either
                # one went up and erased the record on the device that wrote
                # it. Leaving the agreed state as it was means neither: the
                # item is listed as refused and waits for its next change.
                self._note(scope, "refused", item_id)
                return False
            if held and _hmac_kid(_caps_now()):
                # D3 only: a page can hold two rows of one item there.
                if remote is None:
                    snapshot.pop(item_id, None)
                else:
                    snapshot[item_id] = remote
        self._store.set_state(
            scope,
            item_id,
            rev=rev,
            synced_hash=remote_hash if held else "",
            deleted=remote is None,
            sealed_kid=_kid_of(body) if (held and not deleted) else "",
            synced_updated_at=stamp,
            wire_id=hashed_wire,
        )
        return held

    def _stale_delete_clash(self, scope: str, item_id: str) -> bool:
        """D3: whether the open conflict on *item_id* is a local delete that met
        a legacy tombstone — both halves deleted, the remote half under the
        legacy id — on an item still agreed under that legacy id."""
        state = self._store.state(scope, item_id)
        if state is None or state.wire_id:
            return False
        try:
            row = self._store.conflict_payloads(scope, item_id)
        except sync_keyring.KeyringError:
            return False
        return bool(
            row is not None and row.get("local") is None and row.get("remote") is None
            and not row.get("remoteWire") and int(row.get("remoteRev") or 0) > 0
        )

    # ── D3: hashed item ids on the way in ───────────────────────────────
    def _unwrap(self, scope: str, wire_id: str, text: str) -> tuple[str, Any]:
        """The name and payload a hashed-id record carries, checked: its
        wrapper is well formed and the name hashes to the id it came under.
        Raises ``_BadWrapper`` otherwise."""
        kid = _hmac_kid(_caps_now())
        if not kid:
            # A hashed id on a connection that negotiated legacy ids: the
            # account moved on since. Ask again next round.
            self._caps = None
            raise SyncError("ITEM_IDS_CHANGED: the account now uses hashed item ids", code="ITEM_IDS_CHANGED")
        try:
            doc = json.loads(text)
        except ValueError as err:
            raise _BadWrapper("the record is not a wrapper") from err
        name = doc.get("name") if isinstance(doc, dict) else None
        if not isinstance(doc, dict) or doc.get("v") != 1 or not isinstance(name, str) or not name \
                or "payload" not in doc:
            raise _BadWrapper("the record is not a wrapper")
        if sync_keyring.hashed_item_id(scope, name, kid) != wire_id:
            raise _BadWrapper("the record's name is not the one its id is made from")
        return name, doc["payload"]

    def _open_payload(self, scope: str, wire_id: str, body: str) -> Any:
        """A record's payload, opened under the id it travels by (and, for a
        hashed id, unwrapped). On a legacy id exactly what v1 always did."""
        text = sync_keyring.decrypt(body, scope=scope, item_id=wire_id)
        adapter = self._adapters.get(scope)
        if not sync_keyring.is_hashed_item_id(wire_id):
            return _inbound(adapter, json.loads(text))
        return _inbound(adapter, self._unwrap(scope, wire_id, text)[1])

    def _reverse(self, scope: str, snapshot: dict[str, Any]) -> dict[str, str]:
        """Hashed id → name for every item this machine knows of: what it
        holds, what it agreed on, what clashed. How a bodiless row (a
        tombstone, a too-large stub) is named. Cached per snapshot."""
        cached = self._reverse_cache.get(scope)
        if cached is not None and cached[0] is snapshot:
            return cached[1]
        kid = _hmac_kid(_caps_now())
        states = self._store.states(scope)
        out = {state.wire_id: name for name, state in states.items() if state.wire_id}
        if kid:
            for name in set(snapshot) | set(states) | self._store.conflict_ids(scope):
                out.setdefault(sync_keyring.hashed_item_id(scope, name, kid), name)
        self._reverse_cache[scope] = (snapshot, out)
        return out

    def _resolve_hashed(
        self, adapter: ScopeAdapter, raw: dict[str, Any], snapshot: dict[str, Any]
    ) -> tuple[str, Any]:
        """The local name of a hashed-id row, and its payload when it had to
        be opened to find it; ("", ...) for a row to step over."""
        scope = adapter.scope
        wire_id = str(raw.get("itemId") or "")
        if not _hmac_kid(_caps_now()):
            self._caps = None
            raise SyncError("ITEM_IDS_CHANGED: the account now uses hashed item ids", code="ITEM_IDS_CHANGED")
        body = str(raw.get("body") or "")
        if raw.get("deleted") or not body:
            # Nothing sealed to read the name from: one this machine knows of,
            # or a row about an item it never had (a no-op).
            return self._reverse(scope, snapshot).get(wire_id, ""), _UNOPENED
        try:
            text = sync_keyring.decrypt(body, scope=scope, item_id=wire_id)
        except sync_keyring.UnknownKeyId:
            raise _HoldPull(int(raw.get("rev") or 0), wire_id) from None
        except Exception as err:  # noqa: BLE001 - an unreadable record is not fatal
            if _sensitive(adapter):
                raise SyncError(f"{scope}/{wire_id} could not be opened ({type(err).__name__})") from err
            log.warning("dropping %s/%s: %s", scope, wire_id, _why(err))
            return "", _UNOPENED
        try:
            return self._unwrap(scope, wire_id, text)
        except _BadWrapper as err:
            log.warning("refusing %s/%s: %s", scope, wire_id, type(err).__name__)
            self._note(scope, "refused", wire_id)
            return "", _UNOPENED

    def _name_rows(self, adapter: ScopeAdapter, rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        """Listed rows by local name. A hashed row wins over a legacy row of
        the same name (the migration's tombstone). Worker thread."""
        if not _hmac_kid(_caps_now()):
            return {str(row.get("itemId") or ""): row for row in rows if row.get("itemId")}
        scope = adapter.scope
        snapshot = adapter.snapshot()
        out: dict[str, dict[str, Any]] = {}
        legacy: dict[str, dict[str, Any]] = {}
        for row in rows:
            wire_id = str(row.get("itemId") or "")
            if not wire_id:
                continue
            if not sync_keyring.is_hashed_item_id(wire_id):
                legacy[wire_id] = row
                continue
            name = ""
            if not row.get("deleted") and row.get("body"):
                try:
                    name = self._unwrap(
                        scope, wire_id, sync_keyring.decrypt(str(row["body"]), scope=scope, item_id=wire_id)
                    )[0]
                except Exception as err:  # noqa: BLE001 - listed only if it can be named
                    log.warning("the cloud copy of %s/%s did not open: %s", scope, wire_id, _why(err))
            name = name or self._reverse(scope, snapshot).get(wire_id, "")
            if name:
                out[name] = row
        for name, row in legacy.items():
            out.setdefault(name, row)
        return out

    def _backing_off(self, scope: str, item_id: str) -> bool:
        entry = self._defers.get((scope, item_id))
        return entry is not None and self._clock() < entry["next"]

    def _deferred(self, scope: str, item_id: str) -> None:
        now = self._clock()
        entry = self._defers.setdefault((scope, item_id), {"attempts": 0, "first": now, "next": now})
        entry["attempts"] += 1
        # The first deferral is free: it is usually "the download just
        # started", and the next round should simply look again.
        attempts = int(entry["attempts"])
        delay = 0.0 if attempts < 2 else min(DEFER_BACKOFF_BASE_S * 2 ** (attempts - 2), DEFER_BACKOFF_MAX_S)
        entry["next"] = now + delay

    def _gave_up(self, scope: str, item_id: str) -> bool:
        """Whether an item has deferred long or often enough to say so: it is
        still retried (on the longest backoff), only reported as stuck."""
        entry = self._defers.get((scope, item_id))
        if entry is None:
            return False
        return (
            entry["attempts"] >= DEFER_GIVE_UP_ATTEMPTS
            or self._clock() - entry["first"] >= DEFER_GIVE_UP_AFTER_S
        )

    def _pull_limit(self, scope: str) -> int:
        """How many rows to ask one pull page for; see ``PULL_FRAME_BUDGET``."""
        row = max(self._row_bytes.get(scope, 0), PULL_ROW_GUESS.get(scope, MAX_BODY_BYTES))
        limit = max(1, min(PULL_PAGE, PULL_FRAME_BUDGET // max(row, 1)))
        return min(limit, self._pull_caps.get(scope, limit))

    def _learn_rows(self, scope: str, rows: list[Any]) -> None:
        sizes = [len(canonical(r).encode("utf-8")) for r in rows if isinstance(r, dict)]
        if sizes and max(sizes) > self._row_bytes.get(scope, 0):
            self._row_bytes[scope] = max(sizes)

    def _note(self, scope: str, reason: str, item_id: str) -> None:
        ids = self._notes.setdefault(scope, {}).setdefault(reason, [])
        if item_id not in ids:
            ids.append(item_id)

    def _origin(self, raw: dict[str, Any], *, scope: str, item_id: str) -> str:
        """Whether the record provably came from the device it names.

        ``_ORIGIN_VERIFIED`` when it carries that device's signature under the
        key pinned for it — or under this machine's own key, for a record that
        names this machine: the server stamps ``deviceId``, so "it says it is
        ours" is the server's word, not proof. ``_ORIGIN_FORGED`` when a key is
        known and the signature does not match. ``_ORIGIN_UNKNOWN`` when no key
        is known to check against.
        """
        device = str(raw.get("deviceId") or "")
        if device and device != self._device_id() and _blocked_here(device):
            # A blocked device of this account still holds the account key, so
            # its records open and, with no pin to check, read as unknown
            # origin — which a live record or a tombstone for an item this
            # machine lacks is taken on. A stolen machine is what a block is for.
            log.warning("refusing a record from %s: that device is blocked on this machine", device)
            return _ORIGIN_FORGED
        if device and device == self._device_id():
            try:
                key = device_signing.public_key()
            except Exception:  # noqa: BLE001 - no own key to check with
                key = ""
        else:
            key = self._signing_key_for(device)
        if (
            device and device == self._device_id() and not str(raw.get("sig") or "")
            and not raw.get("tooLarge")
        ):
            # This release signs everything it writes, so an unsigned row that
            # names this machine was not written by it. A too-large stub is
            # the exception: the server strips the signature with the body,
            # and a stub carries nothing to apply.
            return _ORIGIN_FORGED
        if not key or not str(raw.get("sig") or ""):
            # No key to check against — or no signature to check: releases up
            # to 0.2.3 did not sign. Either way nothing proves who wrote it,
            # which is the unknown-origin rule, not a forgery.
            return _ORIGIN_UNKNOWN
        return _ORIGIN_VERIFIED if self._origin_ok(raw, scope=scope, item_id=item_id, key=key) else _ORIGIN_FORGED

    def _origin_ok(
        self, raw: dict[str, Any], *, scope: str, item_id: str, key: str | None = None
    ) -> bool:
        """Whether the record really came from the device it names.

        Trust on first use, the same rule the message path already follows: a
        peer whose signing key has never been pinned is accepted, and one whose
        key no longer matches what was pinned is refused rather than re-pinned.
        """
        device = str(raw.get("deviceId") or "")
        if key is None:
            key = self._signing_key_for(device)
        if not key:
            return True
        return device_signing.verify_sync(
            str(raw.get("sig") or ""),
            public_key_b64=key,
            scope=scope,
            item_id=item_id,
            updated_at=str(raw.get("updatedAt") or ""),
            deleted=bool(raw.get("deleted")),
            body=str(raw.get("body") or ""),
        )

    # ── push ────────────────────────────────────────────────────────────
    async def _push(self, adapter: ScopeAdapter) -> int:
        # One hop for everything that reads disk or encrypts; what comes back is
        # ready to put on the wire.
        pending, built = await asyncio.to_thread(self._prepare_push, adapter)
        ready = getattr(adapter, "ready", None)
        if ready is not None:
            # An item whose files are not all on the server yet waits: the
            # server would refuse a manifest naming a missing blob anyway, and
            # the adapter starts the upload that lets it go next round.
            keep = {item_id for item_id, payload, _ in pending if payload is None or await ready(item_id, payload)}
            built = [entry for entry in built if entry[0].get(_OWED_KEY) or _name_of(entry[0]) in keep]
        return await self._send_all(adapter.scope, pending, built)

    async def _send_all(
        self,
        scope: str,
        pending: list[tuple[str, Any, str]],
        built: list[tuple[dict[str, Any], int]],
    ) -> int:
        """Put prepared items on the wire, respecting both frame budgets."""
        # Two budgets, because either one alone is wrong: sixty-four tiny items
        # is a fine batch and two large ones is not, and the frame is what the
        # server actually refuses.
        sent = 0
        batch: list[dict[str, Any]] = []
        budget = 0
        index = 0
        while index < len(built):
            # A D3 migration pair (hashed copy, then legacy tombstone) is one
            # unit: the server commits a batch in one transaction.
            group = built[index : index + (2 if built[index][0].get(_PAIR_KEY) else 1)]
            index += len(group)
            size = sum(cost for _item, cost in group)
            if batch and (len(batch) + len(group) > PUSH_BATCH or budget + size > MAX_PUSH_BYTES):
                sent += await self._send_batch(scope, batch, pending)
                batch, budget = [], 0
            batch.extend(item for item, _cost in group)
            budget += size
        if batch:
            sent += await self._send_batch(scope, batch, pending)
        return sent

    def _prepare_push(
        self, adapter: ScopeAdapter
    ) -> tuple[list[tuple[str, Any, str]], list[tuple[dict[str, Any], int]]]:
        """Everything a push needs, computed off the loop."""
        scope = adapter.scope
        snapshot = adapter.snapshot()
        states = self._store.states(scope)
        blocked = self._store.conflict_ids(scope)
        # Items the adapter knows cannot travel for a reason the body size
        # does not show (a skill naming more blobs than the server takes, an
        # instruction file over the record limit). Asked after the snapshot,
        # which is what the answer describes. Neither sent nor — present in
        # the snapshot or not — ever taken for a delete.
        oversized = set(_adapter_ids(adapter, "oversized"))
        # Items the adapter must not send anything for right now — a rejected
        # approval whose held copy no longer opens: neither an edit nor a
        # delete goes up, and the round lists them as held.
        withheld = set(_adapter_ids(adapter, "withheld"))
        for item_id in sorted(withheld):
            self._note(scope, "held", item_id)
        pending: list[tuple[str, Any, str]] = []  # (item_id, payload|None, hash)

        active_kid = sync_keyring.active_key_id() or ""
        held_ring = sync_keyring.ring()
        # Whether this account's key was ever rotated. Until it was, an empty
        # sealed_kid is a v1 body some older device may still need to read
        # (see below); after it, it is a body under something other than the
        # active key — v1, or a retired key a lagging device wrote under — and
        # the whole point of the rotation is that it goes up again.
        rotated = held_ring is not None and len(held_ring.get("keys") or {}) > 1
        id_kid = _hmac_kid(_caps_now())
        for item_id, payload in snapshot.items():
            if item_id in blocked or item_id in withheld:
                continue
            if item_id in oversized:
                self._note(scope, "tooLarge", item_id)
                continue
            item_hash = digest(payload)
            state = states.get(item_id)
            if state is not None and not state.deleted and state.synced_hash != item_hash \
                    and _agreed_before(adapter, item_id, state.synced_hash):
                # Agreed on in the form an older build sent and unchanged
                # since: the agreed hash moves to the form sent now, and
                # nothing goes up for the upgrade alone.
                self._store.set_state(
                    scope,
                    item_id,
                    rev=state.rev,
                    synced_hash=item_hash,
                    deleted=False,
                    sealed_kid=state.sealed_kid,
                    synced_updated_at=state.synced_updated_at,
                    wire_id=state.wire_id,
                )
                state = states[item_id] = self._store.state(scope, item_id) or state
            if state is not None and not state.deleted and state.synced_hash == item_hash:
                # Unchanged — unless the key it went up under has since been
                # retired, in which case the same bytes go up again under the
                # active one. That is the whole of what a rotation asks of the
                # engine: every device re-seals what it holds, and whichever
                # gets there first wins without a conflict (same content).
                #
                # An empty sealed_kid is not a retired key: per ItemState it
                # means "v1 body, or unknown", which is what every row written
                # before this column existed carries. Reading it as retired
                # made the first sync after an upgrade re-seal and re-push
                # every item in every scope — and a device still on the older
                # release cannot read a v2 body, drops it with a log line, and
                # advances its cursor anyway, so the record silently never
                # arrives there again. Leaving v1 bodies alone costs nothing:
                # this release reads them (sync_keyring falls back on the v1
                # format), and a real rotation names a concrete key that
                # differs from the active one.
                if (state.sealed_kid == active_kid or (state.sealed_kid == "" and not rotated)) and not (
                    # D3: an item the server still knows by its name moves
                    # to its hashed id, changed or not.
                    id_kid and not state.wire_id
                ):
                    continue
            pending.append((item_id, payload, item_hash))

        if not _sensitive(adapter):
            # An item the snapshot no longer lists is a delete to carry up —
            # except for a sensitive scope, where "not here" is as often "not
            # set up on this machine" or "removed from this machine only", and
            # a tombstone would sign every other device out. Those scopes
            # never delete by absence; the cloud copy outlives the local one.
            waiting = self._reset_deletes.get(scope, set())
            for item_id, state in states.items():
                if item_id in snapshot or item_id in blocked or state.deleted or item_id in oversized \
                        or item_id in withheld:
                    continue
                if item_id in waiting and state.rev == 0:
                    # A delete carried across a reset whose row the re-read
                    # has not reached yet: it waits for that row's rev.
                    continue
                pending.append((item_id, None, ""))

        updated_at = now_iso()
        if id_kid:
            built = [
                entry
                for i, p, h in pending
                for entry in self._build_hashed(scope, i, p, h, states, updated_at, id_kid)
            ]
            # Contract c5: a migrated item whose legacy half did not go up
            # still owes the server that tombstone, on its own — the hashed
            # copy is never sent again from rev 0.
            for name, state in sorted(states.items()):
                if state.legacy_rev <= 0 or not state.wire_id or name in blocked or name in withheld:
                    continue
                owed = self._wire_item(scope, name, name, state.legacy_rev, updated_at, None, "")
                owed[0][_OWED_KEY] = True
                built.append(owed)
            return pending, built
        built = [
            entry
            for entry in (self._build(scope, i, p, h, states, updated_at) for i, p, h in pending)
            if entry is not None
        ]
        return pending, built

    def _build(
        self,
        scope: str,
        item_id: str,
        payload: Any,
        item_hash: str,
        states: dict[str, ItemState],
        updated_at: str,
    ) -> tuple[dict[str, Any], int] | None:
        """One wire item and the bytes it costs, or None when it cannot go.

        ``deviceId`` is deliberately absent: the server stamps the connection's
        own device on every row, and a client that named itself would be
        claiming an origin rather than stating one.
        """
        deleted = payload is None
        body = ""
        if not deleted:
            body = sync_keyring.encrypt(canonical(payload), scope=scope, item_id=item_id)
            if len(body.encode("utf-8")) > MAX_BODY_BYTES:
                log.warning(
                    "skipping %s/%s: %d bytes is over the %d byte record limit",
                    scope, item_id, len(body.encode("utf-8")), MAX_BODY_BYTES,
                )
                self._note(scope, "tooLarge", item_id)
                return None
        state = states.get(item_id)
        item = {
            "itemId": item_id,
            "baseRev": state.rev if state else 0,
            "updatedAt": updated_at,
            "deleted": 1 if deleted else 0,
            "body": body,
            "sig": device_signing.sign_sync(
                scope=scope,
                item_id=item_id,
                updated_at=updated_at,
                deleted=deleted,
                body=body,
            ),
        }
        refs = getattr(self._adapters.get(scope), "refs", None)
        if refs is not None and not deleted:
            # The blob ids the record names, in the clear, so the server can
            # tell which blobs are still in use. Ids only: they are keyed
            # hashes, and the record naming them stays sealed.
            item["refs"] = refs(payload)
        return item, len(canonical(item).encode("utf-8"))

    def _build_hashed(
        self,
        scope: str,
        name: str,
        payload: Any,
        item_hash: str,
        states: dict[str, ItemState],
        updated_at: str,
        id_kid: str,
    ) -> list[tuple[dict[str, Any], int]]:
        """D3: the wire items for one item of an hmac account.

        A live item goes up under its hashed id with its name sealed inside a
        wrapper. One the server still holds under its name is migrated: the
        hashed copy from rev 0 and, right behind it in the same batch, a
        tombstone for the legacy id. A delete goes to whichever id the item
        was last agreed under.
        """
        state = states.get(name)
        if payload is None:
            wire_id = state.wire_id if state is not None and state.wire_id else name
            return [self._wire_item(scope, name, wire_id, state.rev if state else 0, updated_at, None, "")]
        hashed = sync_keyring.hashed_item_id(scope, name, id_kid)
        on_hashed = state is not None and state.wire_id == hashed
        body = sync_keyring.encrypt(
            canonical({"v": 1, "name": name, "payload": payload}), scope=scope, item_id=hashed
        )
        if len(body.encode("utf-8")) > MAX_BODY_BYTES:
            log.warning("skipping %s/%s: over the %d byte record limit", scope, name, MAX_BODY_BYTES)
            self._note(scope, "tooLarge", name)
            return []
        head = self._wire_item(scope, name, hashed, state.rev if on_hashed else 0, updated_at, payload, body)
        if state is None or on_hashed or state.deleted or state.rev <= 0:
            return [head]
        head[0][_PAIR_KEY] = True
        return [head, self._wire_item(scope, name, name, state.rev, updated_at, None, "")]

    def _wire_item(
        self, scope: str, name: str, wire_id: str, base_rev: int, updated_at: str, payload: Any, body: str
    ) -> tuple[dict[str, Any], int]:
        """One D3 wire item, signed under the id it travels by (see ``_build``)."""
        deleted = payload is None
        item: dict[str, Any] = {
            "itemId": wire_id,
            "baseRev": base_rev,
            "updatedAt": updated_at,
            "deleted": 1 if deleted else 0,
            "body": body,
            "sig": device_signing.sign_sync(
                scope=scope, item_id=wire_id, updated_at=updated_at, deleted=deleted, body=body
            ),
        }
        refs = getattr(self._adapters.get(scope), "refs", None)
        if refs is not None and not deleted:
            item["refs"] = refs(payload)
        size = len(canonical(item).encode("utf-8"))
        item[_NAME_KEY] = name
        return item, size

    async def _send_batch(
        self, scope: str, wire: list[dict[str, Any]], pending: list[tuple[str, Any, str]]
    ) -> int:
        by_id = {item_id: (payload, item_hash) for item_id, payload, item_hash in pending}
        names: dict[str, str] | None = None
        pairs: dict[str, str] = {}
        owed: set[str] = set()
        if any(_NAME_KEY in item for item in wire):
            # D3: the wire speaks ids, the record speaks names.
            names = {str(item["itemId"]): _name_of(item) for item in wire}
            pairs = {str(item["itemId"]): _name_of(item) for item in wire if item.get(_PAIR_KEY)}
            owed = {_name_of(item) for item in wire if item.get(_OWED_KEY)}
            wire = [
                {k: v for k, v in item.items() if k not in (_NAME_KEY, _PAIR_KEY, _OWED_KEY)} for item in wire
            ]
        if scope in LOCAL_ONLY_SCOPES:
            raise SyncError(f"{scope} never leaves this machine")
        caps = _caps_now()
        if _is_v3(caps) and caps.get("storage") == "s3":
            wire = await self._objectify(scope, wire, caps)
        reply = _payload(await self._call("sync.push", {"scope": scope, "items": wire}))
        stamps = {str(item.get("itemId") or ""): str(item.get("updatedAt") or "") for item in wire}
        failure: SyncError | None = None
        conflicts = reply.get("conflicts")
        if isinstance(conflicts, list) and conflicts:
            try:
                await self._hydrate(scope, conflicts)
            except SyncError as err:
                # What was accepted is still written down; the clashes are
                # met again, readable or not, by the next round.
                failure = err
                reply = {**reply, "conflicts": []}
        count = await asyncio.to_thread(self._record_reply, scope, reply, by_id, stamps, names, pairs, owed)
        if failure is not None:
            raise failure
        return count

    # ── records as objects (v3, storage "s3") ───────────────────────────
    async def _objectify(
        self, scope: str, wire: list[dict[str, Any]], caps: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """The batch with every live body stored as an object and named by an
        ``objectRef``. The signature stays: it signs the body, which is the
        object's bytes."""
        live = [i for i, item in enumerate(wire) if not item.get("deleted") and item.get("body")]
        if not live:
            return wire
        if _retired(caps, scope) or scope in RETIRED_SCOPES:
            raise SyncError(f"SCOPE_RETIRED: {scope} does not sync", code="SCOPE_RETIRED")
        data = [str(wire[i]["body"]).encode("utf-8") for i in live]
        ids = await self._upload_objects(data, caps)
        out = list(wire)
        for i, blob_id, raw in zip(live, ids, data):
            item = {k: v for k, v in wire[i].items() if k != "body"}
            item["objectRef"] = {"blobId": blob_id, "sizeBytes": len(raw)}
            out[i] = item
        return out

    async def _upload_objects(self, data: list[bytes], caps: dict[str, Any]) -> list[str]:
        """Store each sealed record as an object; the blob id of each, in
        order. Only what the server does not hold yet is PUT, and only after
        every object is committed does anything name it."""
        ids = await asyncio.to_thread(lambda: [sync_objects.object_id(d) for d in data])
        todo = dict(zip(ids, data))
        size = max(1, min(OBJECT_BATCH, int(caps.get("maxBatch") or OBJECT_BATCH)))
        for _attempt in range(2):
            uploads: list[tuple[str, str]] = []
            for chunk in _batches(sorted(todo), size):
                reply = _payload(await self._call(
                    "blobs.presignPut",
                    {"objects": [{"blobId": b, "sizeBytes": len(todo[b])} for b in chunk]},
                ))
                answers = {
                    str(o.get("blobId") or ""): o for o in reply.get("objects") or [] if isinstance(o, dict)
                }
                for blob_id in chunk:
                    answer = answers.get(blob_id) or {}
                    if answer.get("state") == "complete":
                        continue
                    if answer.get("state") != "upload" or not answer.get("url"):
                        raise SyncError("OBJECT_UPLOAD: the server would not take a record object")
                    uploads.append((blob_id, str(answer["url"])))
            if not uploads:
                return ids
            try:
                await asyncio.to_thread(sync_objects.put_all, [(url, todo[b]) for b, url in uploads])
            except sync_objects.ObjectError as err:
                raise SyncError(f"OBJECT_UPLOAD: {err}") from err
            restart: dict[str, bytes] = {}
            for chunk in _batches([b for b, _ in uploads], size):
                reply = _payload(await self._call("blobs.commit", {"blobIds": chunk}))
                states = {
                    str(o.get("blobId") or ""): str(o.get("state") or "")
                    for o in reply.get("blobs") or [] if isinstance(o, dict)
                }
                for blob_id in chunk:
                    state = states.get(blob_id, "")
                    if state == "incomplete":
                        restart[blob_id] = todo[blob_id]
                    elif state != "complete":
                        raise SyncError(f"OBJECT_UPLOAD: a record object was not stored ({state or 'no answer'})")
            if not restart:
                return ids
            todo = restart
        raise SyncError("OBJECT_UPLOAD: a record object did not complete after starting over")

    async def _hydrate(self, scope: str, rows: list[Any]) -> None:
        """Give every row that names an object instead of carrying a body its
        body, fetched and checked. Rows that carry one are left alone, so a
        v1 reply passes through untouched. Raises ``SyncError`` when any
        object cannot be had whole; nothing of the batch is used then.

        A retired scope never asks for an object: its rows stay bodiless and
        read as unopenable.
        """
        targets: list[tuple[dict[str, Any], str]] = []
        sizes: dict[str, int] = {}
        for row in rows:
            if not isinstance(row, dict) or row.get("deleted") or row.get("body"):
                continue
            ref = row.get("objectRef")
            if not isinstance(ref, dict) or not ref.get("blobId"):
                continue
            blob_id = str(ref["blobId"])
            targets.append((row, blob_id))
            sizes[blob_id] = int(ref.get("sizeBytes") or 0)
        if not targets or scope in RETIRED_SCOPES or _retired(_caps_now(), scope):
            return
        urls: list[tuple[str, str]] = []
        for chunk in _batches(sorted(sizes), OBJECT_BATCH):
            reply = _payload(await self._call("blobs.presignGet", {"blobIds": chunk}))
            answers = {
                str(o.get("blobId") or ""): o for o in reply.get("objects") or [] if isinstance(o, dict)
            }
            for blob_id in chunk:
                answer = answers.get(blob_id) or {}
                if answer.get("error") or not answer.get("url"):
                    raise SyncError(
                        f"OBJECT_UNAVAILABLE: a record object could not be fetched ({answer.get('error') or 'no answer'})"
                    )
                urls.append((blob_id, str(answer["url"])))
        texts = await asyncio.to_thread(_fetch_verified, urls, sizes)
        for row, blob_id in targets:
            row["body"] = texts[blob_id]

    def _record_reply(
        self,
        scope: str,
        reply: dict[str, Any],
        by_id: dict[str, tuple[Any, str]],
        stamps: dict[str, str] | None = None,
        names: dict[str, str] | None = None,
        pairs: dict[str, str] | None = None,
        owed: set[str] | None = None,
    ) -> int:
        """Write what the server said into the local record. Off the loop.

        ``names`` (D3) maps each wire id of the batch to its local name,
        ``pairs`` each migration's hashed id to the name whose legacy
        tombstone rode behind it, and ``owed`` the names whose owed legacy
        tombstone went alone (contract c5); all None/empty on the legacy wire.
        """
        self._store._check_round()
        accepted = reply.get("accepted")
        pairs = pairs or {}
        owed = owed or set()
        migrating = set(pairs.values())
        revs: dict[str, int] = {}
        for entry in accepted if isinstance(accepted, list) else []:
            if not isinstance(entry, dict):
                continue
            wire_id = str(entry.get("itemId") or "")
            item_id = (names or {}).get(wire_id, wire_id)
            if wire_id in owed:
                # The legacy row is gone: nothing is owed any more.
                self._store.set_legacy_rev(scope, wire_id, 0)
                continue
            if item_id not in by_id:
                continue
            revs[wire_id] = int(entry.get("rev") or 0)
            if wire_id in pairs or (item_id in migrating and wire_id == item_id):
                continue  # recorded below, as a pair
            payload, item_hash = by_id[item_id]
            self._store.set_state(
                scope,
                item_id,
                rev=int(entry.get("rev") or 0),
                synced_hash=item_hash,
                deleted=payload is None,
                sealed_kid=(sync_keyring.active_key_id() or "") if payload is not None else "",
                # The updatedAt this push carried: what the server now holds.
                synced_updated_at=(stamps or {}).get(wire_id, ""),
                wire_id=wire_id if sync_keyring.is_hashed_item_id(wire_id) else "",
            )
        for hashed, name in pairs.items():
            self._record_migration(scope, hashed, name, revs, by_id[name], (stamps or {}).get(hashed, ""))
        for entry in reply.get("rejected") or []:
            # Not recorded, so the next round offers it again.
            log.info("sync.push on %s: %s was turned away: %s", scope, entry.get("itemId"), entry.get("code"))
        conflicts = reply.get("conflicts")
        adapter = self._adapters.get(scope)
        for entry in conflicts if isinstance(conflicts, list) else []:
            wire_id = str(entry.get("itemId") or "") if isinstance(entry, dict) else ""
            if wire_id and not sync_keyring.is_hashed_item_id(wire_id) and (
                wire_id in migrating or wire_id in owed
            ):
                # The legacy half clashed: that row changed since this machine
                # last read it (contract c5).
                self._record_legacy_conflict(scope, wire_id, entry, adapter)
                continue
            self._record_push_conflict(scope, entry, by_id, sealed=_sensitive(adapter), names=names)
        cursor = _contiguous_cursor(self._store.cursor(scope), accepted)
        barrier = self._cursor_barrier.get(scope)
        if barrier is not None:
            # A row below is still waiting for its key. Re-reading our own
            # writes next round is cheap; losing that row is not.
            cursor = min(cursor, barrier)
        if cursor > self._store.cursor(scope):
            # Our own accepted writes moved the cursor; recording it here keeps
            # the next pull from re-reading them. Only when they sit directly on
            # top of what was read — see ``_contiguous_cursor``.
            self._store.set_cursor(scope, cursor)
        return len(accepted) if isinstance(accepted, list) else 0

    def _record_migration(
        self,
        scope: str,
        hashed: str,
        name: str,
        revs: dict[str, int],
        sent: tuple[Any, str],
        stamp: str,
    ) -> None:
        """D3: what a migration pair came to. The server judges the two
        halves separately (contract c5), so each is written down as the
        server now holds it; the migration is complete only when both went."""
        payload, item_hash = sent
        if hashed in revs:
            before = self._store.state(scope, name)
            self._store.set_state(
                scope, name, rev=revs[hashed], synced_hash=item_hash, deleted=False,
                sealed_kid=sync_keyring.active_key_id() or "", synced_updated_at=stamp, wire_id=hashed,
            )
            if name not in revs and before is not None and before.rev > 0:
                # Migrated, but the legacy row still stands: its tombstone is
                # owed, at the rev it was sent against (a clash, recorded
                # after this, moves it to the row's current rev).
                log.info("sync.push on %s: a hashed copy went up without its legacy tombstone", scope)
                self._store.set_legacy_rev(scope, name, before.rev)
        elif name in revs:
            # Only the legacy row went: the item is gone from the server, and
            # the next push sends the hashed copy as new.
            self._store.set_state(scope, name, rev=revs[name], synced_hash="", deleted=True)

    def _record_legacy_conflict(self, scope: str, name: str, entry: dict[str, Any], adapter: Any) -> None:
        """The legacy tombstone of a migrated item met a changed legacy row.

        A row deleted since owes nothing. A live one that holds what this
        machine holds is simply owed at its new rev. Anything else was
        written by a device still on legacy ids and is a conflict like any
        other; the tombstone waits for its answer (see ``resolve``).
        """
        state = self._store.state(scope, name)
        if state is None or not state.wire_id:
            return
        rev = int(entry.get("rev") or 0)
        if entry.get("deleted") or rev <= 0:
            self._store.set_legacy_rev(scope, name, 0)
            return
        self._store.set_legacy_rev(scope, name, rev)
        body = str(entry.get("body") or "")
        try:
            remote = self._open_payload(scope, name, body)
        except Exception as err:  # noqa: BLE001 - asked again on the next push
            log.warning("the legacy copy of %s/%s did not open: %s", scope, name, _why(err))
            return
        local = adapter.snapshot().get(name) if adapter is not None else None
        if local is not None and digest(local) == digest(remote):
            return
        self._store.record_conflict(
            scope,
            name,
            local=local,
            remote=remote,
            remote_rev=rev,
            remote_device=str(entry.get("deviceId") or ""),
            sealed=_sensitive(adapter),
            remote_kid=_kid_of(body),
            remote_wire="",
        )

    def _record_push_conflict(
        self,
        scope: str,
        entry: Any,
        by_id: dict[str, tuple[Any, str]],
        *,
        sealed: bool = False,
        names: dict[str, str] | None = None,
    ) -> None:
        if not isinstance(entry, dict):
            return
        wire_id = str(entry.get("itemId") or "")
        item_id = (names or {}).get(wire_id, wire_id)
        hashed_wire = wire_id if sync_keyring.is_hashed_item_id(wire_id) else ""
        if item_id not in by_id:
            return
        if entry.get("tooLarge"):
            # The server's copy is too large to send back (see ``_apply_one``).
            # Not recorded as a conflict with a deleted remote, which keeping
            # local would then push over; reported, and pushed again next round.
            self._note(scope, "tooLarge", item_id)
            return
        # A conflict can also mean "the row you were editing is gone": the
        # server answers rev 0 with every field null, which reads here as a
        # remote delete. Keeping the local copy then re-creates it, because
        # rev 0 is exactly the base a new item pushes from.
        local, local_hash = by_id[item_id]
        remote: Any = None
        body = str(entry.get("body") or "")
        opened = True
        if not entry.get("deleted"):
            try:
                remote = self._open_payload(scope, wire_id, body)
            except Exception as err:  # noqa: BLE001 - show the clash even unreadable
                if sealed:
                    # An unreadable remote half must not be written down as
                    # "deleted": keeping it would then erase the credential.
                    # Nothing is recorded; the item is pushed again next round
                    # and clashes again, readable or held by then.
                    raise SyncError(
                        f"the conflicting copy of {scope}/{item_id} could not be opened ({type(err).__name__})"
                    ) from err
                opened = False
                log.warning("the conflicting copy of %s/%s did not open: %s", scope, item_id, _why(err))
        remote_rev = int(entry.get("rev") or 0)
        if opened and remote is not None and digest(remote) == local_hash:
            # The server refused our write because another device got there
            # first — with the same bytes. Adopt its rev; there is no question.
            self._store.set_state(
                scope,
                item_id,
                rev=remote_rev,
                synced_hash=local_hash,
                deleted=False,
                sealed_kid=_kid_of(body),
                synced_updated_at=str(entry.get("updatedAt") or ""),
                wire_id=hashed_wire,
            )
            return
        self._store.record_conflict(
            scope,
            item_id,
            local=local,
            remote=remote,
            remote_rev=remote_rev,
            remote_device=str(entry.get("deviceId") or ""),
            sealed=sealed,
            remote_kid="" if remote is None else _kid_of(body),
            remote_wire=hashed_wire,
        )

    # ── conflict resolution ─────────────────────────────────────────────
    def resolve(self, scope: str, item_id: str, keep: str) -> None:
        """Answer one conflict. The next round carries the answer to the server.

        Keeping the remote copy writes it in and marks it agreed, so nothing is
        pushed back. Keeping the local copy only clears the block — the item is
        already different from what the server holds, so the next push sends it
        with the rev the conflict reported, which is what makes it win.
        """
        adapter = self._adapters.get(scope)
        if adapter is None:
            raise SyncError(f"no adapter registered for {scope!r}")
        try:
            row = self._store.conflict_payloads(scope, item_id)
        except sync_keyring.KeyringError as err:
            raise SyncError(
                f"the conflict on {scope}/{item_id} cannot be opened here ({type(err).__name__})"
            ) from err
        if row is None:
            raise SyncError(f"no unresolved conflict for {scope}/{item_id}")
        state = self._store.state(scope, item_id)
        if state is not None and state.wire_id and state.legacy_rev > 0 and not row.get("remoteWire"):
            self._resolve_legacy_half(adapter, item_id, keep, row, state)
            return
        if keep == KEEP_REMOTE:
            remote = row["remote"]
            if int(row["remoteRev"]) == 0:
                raise SyncError(
                    f"the cloud holds nothing for {scope}/{item_id}; keep the local copy "
                    "to put it back, or remove it here yourself"
                )
            try:
                refused = adapter.apply(item_id, remote) is False
            except DeferItem as err:
                # Its files are still downloading. Keeping the conflict is the
                # safe answer: marking it agreed now would push this machine's
                # old files over the copy that was just chosen.
                raise SyncError(f"{scope}/{item_id} is still downloading; try again shortly") from err
            if refused:
                # Marking it agreed would push this machine's copy over the one
                # just chosen, exactly as above. The conflict stays.
                raise SyncError(f"{scope}/{item_id} could not be written here; the conflict stays open")
            # Recorded under the key the winning body actually came sealed
            # with (empty when unknown), so a copy under a retired key is
            # still re-sealed by the next push rather than taken as current.
            self._store.set_state(
                scope,
                item_id,
                rev=int(row["remoteRev"]),
                synced_hash="" if remote is None else digest(remote),
                deleted=remote is None,
                sealed_kid="" if remote is None else str(row.get("remoteKid") or ""),
                wire_id=str(row.get("remoteWire") or ""),
            )
        elif keep == KEEP_LOCAL:
            # The agreed hash is cleared, not kept: the local copy may well be
            # the one that was agreed before (a delete arrived over an item
            # nobody here touched), and an unchanged item is never pushed. The
            # choice is only carried up if the next push sees it as changed.
            self._store.set_state(
                scope,
                item_id,
                rev=int(row["remoteRev"]),
                synced_hash="",
                deleted=False,
                wire_id=str(row.get("remoteWire") or ""),
            )
        else:
            raise SyncError(f"{keep!r} is neither {KEEP_LOCAL!r} nor {KEEP_REMOTE!r}")
        self._store.clear_conflict(scope, item_id)

    def _resolve_legacy_half(
        self, adapter: ScopeAdapter, item_id: str, keep: str, row: dict[str, Any], state: ItemState
    ) -> None:
        """Answer a conflict between a migrated item and its changed legacy
        row (contract c5). Either way the item stays on its hashed id at the
        rev it holds there, the legacy tombstone stays owed at the rev the
        conflict reported, and the copy kept is left unagreed, so the next
        push carries it up under the hashed id again.

        Keeping the local copy pushes it again too, though the hashed row
        already holds those bytes: that row was stamped at the migration,
        before the legacy edit it now overrides, and a device that agreed on
        that edit reads an older stamp as a replay (D0) and asks instead of
        taking it. Sent again, the choice carries the time it was made."""
        scope = adapter.scope
        if keep == KEEP_REMOTE:
            try:
                refused = adapter.apply(item_id, row["remote"]) is False
            except DeferItem as err:
                raise SyncError(f"{scope}/{item_id} is still downloading; try again shortly") from err
            if refused:
                raise SyncError(f"{scope}/{item_id} could not be written here; the conflict stays open")
        elif keep != KEEP_LOCAL:
            raise SyncError(f"{keep!r} is neither {KEEP_LOCAL!r} nor {KEEP_REMOTE!r}")
        self._store.set_state(
            scope, item_id, rev=state.rev, synced_hash="", deleted=False,
            sealed_kid=state.sealed_kid, wire_id=state.wire_id,
        )
        self._store.set_legacy_rev(scope, item_id, int(row["remoteRev"]))
        self._store.clear_conflict(scope, item_id)

    # ── inventory ───────────────────────────────────────────────────────
    async def inventory(self, scope: str) -> dict[str, Any]:
        """Line this machine's items up against the account's, item by item.

        **Writes nothing.** No cursor, no agreed state, no conflict row, and the
        adapter is only ever asked to describe itself — a person looking at the
        two sides before deciding what to move must be able to look at a scope
        they have not switched on and have no intention of switching on.

        That also rules out ``ensure_sync_key``, which mints a key or asks a
        paired device for one. Reading is all this does, so a machine without
        the key says so and lists nothing rather than acquiring one to answer.

        Bodies never leave: an item is reported by its fingerprint, because a
        prompt or an MCP record is exactly the kind of thing that holds a
        secret, and the question being asked is only "are these two the same".
        """
        adapter = self._adapters.get(scope)
        if adapter is None:
            raise SyncError(f"no adapter registered for {scope!r}")
        if _sensitive(adapter) and not self._enabled(scope):
            # "Writes nothing" is true of this method and false of a sensitive
            # adapter's snapshot: the credentials one opens every stored secret
            # and mints the row an unseen slot would travel under. Looking
            # before deciding is worth answering a disabled scope for, but not
            # at the price of decrypting credentials for a caller who only had
            # to name the scope. Those describe themselves once switched on.
            return {"scope": scope, "status": INVENTORY_DISABLED, "items": []}
        if not await asyncio.to_thread(sync_keyring.has_account_key):
            return {"scope": scope, "status": INVENTORY_NO_KEY, "items": []}
        caps = await self._negotiate()
        await asyncio.to_thread(_require_item_id_key, caps)
        with _using(caps):
            rows = await self._list_remote(scope)
            items = await asyncio.to_thread(self._compare, adapter, rows)
        return {"scope": scope, "status": INVENTORY_OK, "items": items}

    async def _list_remote(self, scope: str) -> list[dict[str, Any]]:
        """Every row the account holds for *scope*, tombstones included.

        Reads from rev 0 and keeps the paging position in a local variable. The
        stored cursor belongs to the sync round: moving it here would tell the
        next round that rows it has never applied were already read.

        Paging steps on the highest ``rev`` in the page rather than on the
        reply's ``cursor``, which the protocol describes as the scope's current
        maximum. Either reading pages correctly for a server that returns the
        page's last rev; only this one also pages correctly for one that
        returns the maximum, where stepping on the cursor would skip the rest.
        """
        rows: list[dict[str, Any]] = []
        since = 0
        while True:
            reply = _payload(
                await self._call(
                    "sync.pull", {"scope": scope, "since": since, "limit": self._pull_limit(scope)}
                )
            )
            page = reply.get("items")
            page = [r for r in page if isinstance(r, dict)] if isinstance(page, list) else []
            self._learn_rows(scope, page)
            await self._hydrate(scope, page)
            rows.extend(page)
            if not reply.get("more"):
                break
            highest = max((int(r.get("rev") or 0) for r in page), default=since)
            if highest <= since:
                # No progress and the server still says "more": stop rather than
                # loop forever on a server that disagrees with itself.
                log.warning("sync.pull on %s made no progress; stopping the listing", scope)
                break
            since = highest
        return rows

    def _compare(
        self, adapter: ScopeAdapter, rows: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Pair the two halves up. Runs in a worker thread; reads disk freely.

        An item neither side holds is left out: a tombstone whose local copy is
        also gone is a row about nothing, and there is no answer a person could
        give it. A tombstone the local copy outlived is kept — it reads as
        ``local-only`` with ``deleted`` set, which is the whole story.
        """
        scope = adapter.scope
        snapshot = adapter.snapshot()
        blocked = self._store.conflict_ids(scope)
        remote_rows = self._name_rows(adapter, rows)
        out: list[dict[str, Any]] = []
        for item_id in sorted(set(snapshot) | set(remote_rows)):
            local = (
                {"present": True, "fingerprint": digest(snapshot[item_id])}
                if item_id in snapshot
                else None
            )
            if local is not None:
                meta = _describe(adapter, snapshot[item_id])
                if meta is not None:
                    local["meta"] = meta
            remote = self._describe_remote(adapter, item_id, remote_rows.get(item_id))
            state = _item_state(item_id, local, remote, blocked)
            if state is None:
                continue
            out.append({"itemId": item_id, "local": local, "remote": remote, "state": state})
        return out

    def _describe_remote(
        self, adapter: ScopeAdapter, item_id: str, row: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        """One cloud row as the inventory reports it, or None when there is none.

        ``readable`` is false for a record this machine's key will not open —
        another device's key, or a body that was damaged in transit. Said out
        loud rather than folded into "different", because the two call for
        different answers and a fingerprint that could not be computed must not
        read as one that did not match.

        ``meta`` is the adapter's ``describe()`` of the opened body, when it
        has one: what a pane needs to name the item, never the item itself.
        """
        if row is None:
            return None
        scope = adapter.scope
        deleted = bool(row.get("deleted"))
        fingerprint: str | None = None
        meta: dict[str, Any] | None = None
        readable = True
        if not deleted:
            try:
                payload = self._open_payload(scope, str(row.get("itemId") or item_id), str(row.get("body") or ""))
                fingerprint = digest(payload)
                meta = _describe(adapter, payload)
            except Exception as err:  # noqa: BLE001 - an unreadable record still lists
                log.warning("the cloud copy of %s/%s did not open: %s", scope, item_id, _why(err))
                readable = False
        out = {
            "present": not deleted,
            "rev": int(row.get("rev") or 0),
            "updatedAt": str(row.get("updatedAt") or ""),
            "deviceId": str(row.get("deviceId") or ""),
            "deleted": deleted,
            "fingerprint": fingerprint,
            "readable": readable,
        }
        if meta is not None:
            out["meta"] = meta
        return out

    # ── moving one item at a time ───────────────────────────────────────
    async def push_items(self, scope: str, item_ids: Any) -> list[dict[str, Any]]:
        """Send just these items, under every rule a whole push follows.

        Selective, not privileged: an item the user has an unresolved conflict
        on is still skipped, a body over the record limit is still refused, and
        the batches still respect both frame budgets. Choosing what to send
        changes which items go, never what the engine is willing to do.

        That includes the switch. A scope that is off does not send, however
        the send was asked for — without this, anything that could reach the
        local WebSocket could put a credential on the wire while the UI showed
        the scope switched off and said nothing.
        """
        token = _round_generation.set((self._store, self._store.generation))
        try:
            adapter = self._require_adapter(scope)
            self._require_enabled(scope)
            await self._require_key()
            caps = await self._negotiate()
            if _retired(caps, scope):
                raise SyncError(f"SCOPE_RETIRED: {scope} does not sync any more", code="SCOPE_RETIRED")
            await asyncio.to_thread(_require_item_id_key, caps)
            # One transfer per scope at a time, like a round, and under the
            # generation it began with (see ``_round``).
            async with self._locks.setdefault(scope, asyncio.Lock()):
                self._store._check_round()
                self._drop_memory_of_other_accounts()
                return await self._push_chosen(adapter, scope, item_ids, caps)
        finally:
            _round_generation.reset(token)

    async def _push_chosen(
        self, adapter: ScopeAdapter, scope: str, item_ids: Any, caps: dict[str, Any]
    ) -> list[dict[str, Any]]:
        with _using(caps):
            wanted = _unique(item_ids)
            blocked_before = self._store.conflict_ids(scope)
            pending, built = await asyncio.to_thread(self._prepare_push, adapter)
            chosen_pending = [entry for entry in pending if entry[0] in wanted]
            chosen_built = [
                entry for entry in built if _name_of(entry[0]) in wanted
            ]
            if chosen_built:
                await self._send_all(scope, chosen_pending, chosen_built)
            return await asyncio.to_thread(
                self._push_outcomes, scope, wanted, chosen_pending, chosen_built, blocked_before
            )

    def _push_outcomes(
        self,
        scope: str,
        wanted: list[str],
        pending: list[tuple[str, Any, str]],
        built: list[tuple[dict[str, Any], int]],
        blocked_before: set[str],
    ) -> list[dict[str, Any]]:
        """What became of each requested item, read back off the local record.

        Read back rather than collected on the way out, because the record is
        what the next round acts on: an item the server accepted and an item
        whose acceptance was not written down are the same to the user and very
        different to the engine, and only this direction can tell them apart.
        """
        hashes = {item_id: item_hash for item_id, _payload, item_hash in pending}
        buildable = {_name_of(item) for item, _size in built}
        states = self._store.states(scope)
        blocked_now = self._store.conflict_ids(scope)
        out: list[dict[str, Any]] = []
        for item_id in wanted:
            state = states.get(item_id)
            if item_id in blocked_before or item_id in blocked_now:
                result = "conflict"
            elif item_id not in hashes:
                result = "up-to-date" if state is not None else "unknown"
            elif item_id not in buildable:
                result = "too-large"
            elif state is not None and state.synced_hash == hashes[item_id]:
                result = "pushed"
            else:
                result = "failed"
            row: dict[str, Any] = {"itemId": item_id, "result": result}
            if result == "pushed" and state is not None:
                row["rev"] = state.rev
            out.append(row)
        return out

    async def pull_items(self, scope: str, item_ids: Any) -> list[dict[str, Any]]:
        """Take just these items from the account, under a whole pull's rules.

        The cursor stays where it was. This applies a few rows out of order, and
        a cursor moved past them would tell the next round that everything below
        it had been read — which is how one deliberate pull loses every change
        that happened to sit beside it.

        A scope that is off does not apply anything either: taking a credential
        down and putting it into use on this machine is the same decision as
        sending one, and it answers to the same switch.
        """
        token = _round_generation.set((self._store, self._store.generation))
        try:
            adapter = self._require_adapter(scope)
            self._require_enabled(scope)
            await self._require_key()
            # One transfer per scope at a time, like a round, and under the
            # generation it began with (see ``_round``).
            async with self._locks.setdefault(scope, asyncio.Lock()):
                self._store._check_round()
                self._drop_memory_of_other_accounts()
                wanted = _unique(item_ids)
                requested = getattr(adapter, "request_items", None)
                if requested is not None:
                    # Naming an item is asking for it: an adapter that keeps a "not on
                    # this machine" mark for some items lifts it here, before the
                    # rows are read, so the pull below can take them.
                    await asyncio.to_thread(requested, wanted)
                caps = await self._negotiate()
                await asyncio.to_thread(_require_item_id_key, caps)
                with _using(caps):
                    rows = await self._list_remote(scope)
                    by_id = await asyncio.to_thread(self._name_rows, adapter, rows)
                    return await asyncio.to_thread(self._apply_chosen, adapter, wanted, by_id)
        finally:
            _round_generation.reset(token)

    def _apply_chosen(
        self, adapter: ScopeAdapter, wanted: list[str], by_id: dict[str, dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Apply the chosen rows. Worker thread; one snapshot for the batch.

        One snapshot, like ``_apply_page``: each row is a different item, so a
        write does not change what the next comparison reads.
        """
        scope = adapter.scope
        snapshot = dict(adapter.snapshot())
        blocked = self._store.conflict_ids(scope)
        out: list[dict[str, Any]] = []
        refused = self._notes.setdefault(scope, {}).setdefault("refused", [])
        for item_id in wanted:
            row = by_id.get(item_id)
            if item_id in blocked:
                out.append({"itemId": item_id, "result": "conflict"})
            elif row is None:
                out.append({"itemId": item_id, "result": "not-on-server"})
            elif self._applied_chosen(adapter, row, snapshot, blocked):
                out.append(
                    {"itemId": item_id, "result": "pulled", "rev": int(row.get("rev") or 0)}
                )
            elif item_id in self._store.conflict_ids(scope):
                out.append({"itemId": item_id, "result": "conflict"})
            elif item_id in refused:
                out.append({"itemId": item_id, "result": "refused"})
            elif str(row.get("deviceId") or "") == self._device_id():
                out.append({"itemId": item_id, "result": "own-write"})
            else:
                out.append({"itemId": item_id, "result": "skipped"})
        return out

    def _applied_chosen(
        self,
        adapter: ScopeAdapter,
        row: dict[str, Any],
        snapshot: dict[str, Any],
        blocked: set[str],
    ) -> bool:
        try:
            return self._apply_one(adapter, row, snapshot, blocked, explicit=True)
        except _HoldPull:
            # A selective pull has no cursor to hold; the row simply did not
            # come in, and the listing says so.
            return False

    # ── versions (v3, storage "s3") ─────────────────────────────────────
    async def versions(self, scope: str, item_id: str) -> list[dict[str, Any]]:
        """The earlier versions the server keeps of one item, newest first:
        ``rev``, ``updatedAt``, ``deviceId``, ``supersededAt`` each. Only an
        object account on a v3 connection keeps them."""
        token = _round_generation.set((self._store, self._store.generation))
        try:
            self._require_adapter(scope)
            await self._require_key()
            caps = await self._versioned_caps()
            with _using(caps):
                wire_id = await asyncio.to_thread(self._wire_id_of, scope, item_id)
                rows = await self._version_rows(scope, wire_id)
            return [
                {
                    "rev": int(v.get("rev") or 0),
                    "updatedAt": str(v.get("updatedAt") or ""),
                    "deviceId": str(v.get("deviceId") or ""),
                    "supersededAt": str(v.get("supersededAt") or ""),
                }
                for v in rows
            ]
        finally:
            _round_generation.reset(token)

    async def restore(self, scope: str, item_id: str, rev: int) -> dict[str, Any]:
        """Bring back version *rev* of one item.

        The version is fetched and checked like any pulled record and handed
        to the scope's adapter the way a pulled record is — so a version that
        would run something here (an MCP server, a skill) waits for approval
        like any incoming change. Nothing is sent: a version that lands is a
        local edit, and the next round pushes it from the current rev.
        """
        token = _round_generation.set((self._store, self._store.generation))
        try:
            adapter = self._require_adapter(scope)
            self._require_enabled(scope)
            await self._require_key()
            caps = await self._versioned_caps()
            if _retired(caps, scope):
                raise SyncError(f"SCOPE_RETIRED: {scope} does not sync any more", code="SCOPE_RETIRED")
            async with self._locks.setdefault(scope, asyncio.Lock()):
                self._store._check_round()
                self._drop_memory_of_other_accounts()
                with _using(caps):
                    wire_id = await asyncio.to_thread(self._wire_id_of, scope, item_id)
                    rows = await self._version_rows(scope, wire_id)
                    version = next((v for v in rows if int(v.get("rev") or 0) == int(rev)), None)
                    if version is None or not isinstance(version.get("objectRef"), dict):
                        raise SyncError(
                            f"VERSION_NOT_FOUND: {scope}/{item_id} has no version {rev} to restore",
                            code="VERSION_NOT_FOUND",
                        )
                    row = {
                        "itemId": wire_id, "rev": int(rev), "updatedAt": version.get("updatedAt"),
                        "deviceId": version.get("deviceId"), "deleted": 0, "body": None,
                        "sig": version.get("sig"), "objectRef": version["objectRef"],
                    }
                    await self._hydrate(scope, [row])
                    outcome = await asyncio.to_thread(self._restore_one, adapter, item_id, row)
            return {
                "scope": scope, "itemId": item_id, "rev": int(rev),
                "held": outcome == "held", "outcome": outcome,
            }
        finally:
            _round_generation.reset(token)

    async def _versioned_caps(self) -> dict[str, Any]:
        caps = await self._negotiate()
        if not _is_v3(caps) or caps.get("storage") != "s3":
            raise SyncError(
                "VERSIONS_UNAVAILABLE: this account's server keeps no earlier versions",
                code="VERSIONS_UNAVAILABLE",
            )
        await asyncio.to_thread(_require_item_id_key, caps)
        return caps

    async def _version_rows(self, scope: str, wire_id: str) -> list[dict[str, Any]]:
        reply = _payload(await self._call("sync.versions", {"scope": scope, "itemId": wire_id}))
        rows = reply.get("versions")
        return [v for v in rows if isinstance(v, dict)] if isinstance(rows, list) else []

    def _wire_id_of(self, scope: str, item_id: str) -> str:
        """The id the server holds *item_id* under now. Blocking."""
        state = self._store.state(scope, item_id)
        if state is not None and state.wire_id:
            return state.wire_id
        kid = _hmac_kid(_caps_now())
        if kid and state is None:
            return sync_keyring.hashed_item_id(scope, item_id, kid)
        return item_id

    def _restore_one(self, adapter: ScopeAdapter, item_id: str, row: dict[str, Any]) -> str:
        """Open one fetched version and hand it to the adapter. Worker
        thread. What came of it: "held" (filed for approval), "applied" (the
        local copy is now that version) or "not-applied" (the adapter took
        nothing, filed no hold, or the local copy did not change)."""
        scope = adapter.scope
        self._store._check_round()
        if item_id in self._store.conflict_ids(scope):
            raise SyncError(f"{scope}/{item_id} has an unresolved conflict; answer it first")
        from . import sync_approvals

        # The adapter's hold replaces any hold already filed for the item: a
        # pulled change waiting for approval would be dropped with a rejected
        # restore, and the older local copy pushed over it. A previous
        # restore's own hold may be replaced.
        waiting = sync_approvals.entry(scope, item_id)
        if waiting and not waiting.get("restored"):
            raise SyncError(
                f"RESTORE_BLOCKED: an incoming change to {scope}/{item_id} is waiting for approval; "
                "decide it first",
                code="RESTORE_BLOCKED",
            )
        wire_id = str(row["itemId"])
        if self._origin(row, scope=scope, item_id=wire_id) == _ORIGIN_FORGED:
            raise SyncError(f"version {row['rev']} of {scope}/{item_id} is not signed by the device it names")
        try:
            payload = self._open_payload(scope, wire_id, str(row.get("body") or ""))
        except SyncError:
            raise
        except Exception as err:  # noqa: BLE001 - named by class only
            raise SyncError(f"version {row['rev']} of {scope}/{item_id} could not be opened ({type(err).__name__})") from err
        before = adapter.snapshot().get(item_id, _UNOPENED)
        try:
            taken = adapter.apply(item_id, payload) is not False
        except DeferItem as err:
            raise SyncError(f"{scope}/{item_id} is still downloading; try again shortly") from err
        except SyncError:
            raise
        except Exception as err:  # noqa: BLE001 - the class only: the message may quote the payload
            raise SyncError(f"{scope}/{item_id} could not be restored here ({type(err).__name__})") from err
        if not taken:
            return "not-applied"
        entry = sync_approvals.entry(scope, item_id)
        held = bool(entry and entry.get("status") == sync_approvals.PENDING and entry.get("digest") == digest(payload))
        if held:
            sync_approvals.mark_restored(scope, item_id)
            return "held"
        after = adapter.snapshot().get(item_id, _UNOPENED)
        changed = (before is _UNOPENED) != (after is _UNOPENED) or (
            after is not _UNOPENED and digest(before) != digest(after)
        )
        return "applied" if changed else "not-applied"

    def _require_adapter(self, scope: str) -> ScopeAdapter:
        adapter = self._adapters.get(scope)
        if adapter is None:
            raise SyncError(f"no adapter registered for {scope!r}")
        return adapter

    def _require_enabled(self, scope: str) -> None:
        """Refuse an item-level transfer for a scope that is switched off.

        ``sync`` reports this as a skip because a round covers every scope and
        walking past the ones that are off is the normal outcome. Asking for
        named items is a different act: the caller named a scope, so the answer
        is an error rather than a quiet empty result.
        """
        if not self._enabled(scope):
            raise SyncError(f"the {scope} section is switched off")

    async def _require_key(self) -> None:
        if not await asyncio.to_thread(sync_keyring.has_account_key):
            raise SyncError("this machine does not hold the account sync key")


_ORIGIN_VERIFIED = "verified"
_ORIGIN_UNKNOWN = "unknown"
_ORIGIN_FORGED = "forged"


class _ResetThrottled(Exception):
    """The server asked a scope to start over again too soon (see ``_pull``)."""


class _HoldPull(Exception):
    """A pulled record is sealed under a key this machine does not hold yet."""

    def __init__(self, rev: int, item_id: str = "") -> None:
        super().__init__(f"waiting for the key of rev {rev}")
        self.rev = rev
        self.item_id = item_id


def _rev_of(raw: Any) -> int:
    return int(raw.get("rev") or 0) if isinstance(raw, dict) else 0


def _adapter_ids(adapter: Any, name: str) -> list[str]:
    """``adapter.<name>()`` as a list of item ids, or [] when it has none.

    Never raises: these feed a report, and an adapter that cannot say must
    not fail the round that asked.
    """
    fn = getattr(adapter, name, None)
    if fn is None:
        return []
    try:
        ids = fn()
    except Exception as err:  # noqa: BLE001 - see docstring
        log.warning("%s could not list its %s items: %s", getattr(adapter, "scope", "?"), name, _why(err))
        return []
    return [str(i) for i in ids if i] if isinstance(ids, (list, tuple, set)) else []


def _merged(first: list[str], second: list[str]) -> list[str]:
    return first + [i for i in second if i not in first]


def _contiguous_cursor(cursor: int, accepted: Any) -> int:
    """How far a push's own accepted revs may move the read cursor.

    The reply's ``cursor`` is the scope's maximum rev, which includes whatever
    another device wrote between this round's pull and its push. Recording it
    would mark that write as read without ever applying it. So the cursor moves
    only across our own revs that follow on from it without a gap; a gap means
    someone else's row is in there, and the next pull reads it (re-reading our
    own writes on the way is cheap).
    """
    revs = sorted(
        int(entry.get("rev") or 0)
        for entry in (accepted if isinstance(accepted, list) else [])
        if isinstance(entry, dict)
    )
    for rev in revs:
        if rev != cursor + 1:
            break
        cursor = rev
    return cursor


def _kid_of(body: str) -> str:
    """The active key id when *body* is sealed under it, else "" (re-push later)."""
    if not body:
        return ""
    try:
        if sync_keyring.needs_reseal(body):
            return ""
    except Exception:  # noqa: BLE001 - an undecidable body is treated as stale
        return ""
    return sync_keyring.active_key_id() or ""


def _item_state(
    item_id: str,
    local: dict[str, Any] | None,
    remote: dict[str, Any] | None,
    blocked: set[str],
) -> str | None:
    """How the two halves stand, or None for an item neither side holds.

    An unreadable cloud copy counts as different rather than the same: the
    fingerprints could not be compared, and claiming agreement on that is the
    one answer that would let a real difference pass unnoticed.
    """
    if item_id in blocked:
        return STATE_CONFLICT
    if remote is None or not remote["present"]:
        return STATE_LOCAL_ONLY if local else None
    if local is None:
        return STATE_REMOTE_ONLY
    return (
        STATE_IN_SYNC
        if remote["fingerprint"] is not None and remote["fingerprint"] == local["fingerprint"]
        else STATE_DIVERGED
    )


def _unique(item_ids: Any) -> list[str]:
    """The requested ids, in the order asked for, without blanks or repeats."""
    out: list[str] = []
    for raw in item_ids if isinstance(item_ids, list) else []:
        item_id = str(raw or "")
        if item_id and item_id not in out:
            out.append(item_id)
    return out


def _blocked_here(device_id: str) -> bool:
    """Whether this machine's own block list names *device_id*. Never raises:
    ``is_blocked_locally`` answers from the store and logs what it cannot read."""
    from . import trust_store

    return trust_store.is_blocked_locally(device_id=device_id, member_id="")


def _pinned_signing_key(device_id: str, member_id: str | None = None) -> str:
    """The signing key pinned for *device_id*, or "" when there is none.

    With *member_id*, a pin recorded under any other member — or with none,
    or when the signed-in member is not known yet — counts as no pin.
    """
    from . import trust_store

    try:
        pin = trust_store.pin_for(device_id)
    except Exception:  # noqa: BLE001 - an unreadable pin is "not pinned yet"
        return ""
    if not isinstance(pin, dict):
        return ""
    if member_id is not None and (not member_id or pin.get("memberId") != member_id):
        return ""
    # ``signKey`` is the field trust_store writes; the other two names never
    # existed there, which left every signature unchecked.
    key = pin.get("signKey") or pin.get("signPublicKey") or pin.get("signingKey") or ""
    return key if isinstance(key, str) else ""


def _fetch_verified(urls: list[tuple[str, str]], sizes: dict[str, int]) -> dict[str, str]:
    """Download each object and check it is the one its id names. Blocking."""
    try:
        fetched = sync_objects.get_all(urls, sizes)
    except sync_objects.ObjectError as err:
        raise SyncError(f"OBJECT_UNAVAILABLE: {err}") from err
    out: dict[str, str] = {}
    for blob_id, data in fetched.items():
        if len(data) != sizes.get(blob_id) or not sync_objects.object_matches(blob_id, data):
            raise SyncError("OBJECT_INTEGRITY: a record object is not the one its id names")
        out[blob_id] = data.decode("utf-8")
    return out


def _payload(reply: Any) -> dict[str, Any]:
    """The payload of a server reply, or a SyncError naming its refusal."""
    if not isinstance(reply, dict):
        raise SyncError("the server sent a reply that is not an object")
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        code = str(error.get("code") or "UNKNOWN")
        raise SyncError(f"{code}: {error.get('message') or 'the server refused the request'}", code=code)
    payload = reply.get("payload")
    return payload if isinstance(payload, dict) else {}

