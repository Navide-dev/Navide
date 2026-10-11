"""Approval before a synced skill or MCP server can run here.

A record another device sends can carry something this machine will execute:
an MCP server's command, a skill's scripts. Applying it on arrival meant one
compromised device could run code on every other device of the account. So a
record that is *new here*, or that changes what would run, is held instead of
applied — not written, not enabled, not projected to any CLI, no executable
bit — until the user approves it in the main window. A change that does not
touch what runs (a skill switched off, a rotated token in an MCP env) and a
deletion behave as before.

The skills install gate (``skills_approvals``) is the model: a pending
request, approve or reject in the window, the write only on approval. It is
not reused as-is because its records live in memory and point at installer
previews. A held sync record has to survive a restart: while it waits, the
adapter shows the engine the held payload in place of the local item (see
``overlay``), so the engine sees agreement and pushes nothing. Forgetting the
hold on a restart would make the next round push this machine's old copy over
the change on every other device. Hence:

- the index is a store of its own, ``index.json`` beside the payloads under
  the app data directory — not a UI setting, which the window may write —
  as ``{scope: {item_id: {digest, base, status, kind, summary, at}}}``. The
  summary — everything the user is shown, whole — is sealed under the
  account key like the payload, so the file keeps no secret in the clear;
- each payload is sealed under the account key, the same way it travelled;
- an approval is a token sealed under that key too (``_approval_token``),
  written only by ``decide``: a hand-edited ``status`` approves nothing.

What the user approves is exactly and completely what lands: a summary
that cannot hold the whole record is refused (the adapter reports it), never
held as a stub, and a stub found in the index is never approvable.

Bounded: at most ``MAX_HOLDS_PER_SCOPE`` records per scope *waiting* — a
full queue refuses the next record (``full_scopes`` says so) rather than
making room. A rejection is never evicted to make room: dropping one would
let this machine's own copy (or its absence, a delete) go up over the
change it rejected.

A rejection is kept: the cloud copy goes on standing in for the local item, so
nothing is pushed back, until a newer record for the item arrives — which is
a new request. A local edit of the item while it waits ends the hold: the edit
is the user's newer decision and syncs as one.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable

from . import sync_engine, sync_keyring

log = logging.getLogger("agent_team_backend.sync_approvals")

#: The UI-settings key an earlier build of this branch kept the index under.
#: Nothing reads it now; ws_handlers refuses it from the window all the same.
APPROVALS_KEY = "sync-approvals"
#: Records waiting per scope, and the summary bytes one may keep.
MAX_HOLDS_PER_SCOPE = 64
MAX_SUMMARY_BYTES = 192 * 1024
#: One lock for every read-modify-write of the index: a sync worker filing a
#: record and the window deciding one must not interleave.
_lock = threading.RLock()

PENDING = "pending"
REJECTED = "rejected"
#: Approved, but not landed yet (a large skill's files still downloading).
APPROVED = "approved"

#: Why a record waits: the item is not here at all, what runs changed, or a
#: delete that would change what runs (the default prompt's: the loop
#: prompt would become another).
KIND_NEW = "new"
KIND_CHANGED = "changed"
KIND_DELETE = "delete"
#: Scopes sync no longer offers (user decision 2026-10-09: memory). Their
#: holds are not listed and never land; their code stays.
RETIRED_SCOPES = frozenset({"memory"})
#: The inventory status of a retired scope asked for by name.
INVENTORY_RETIRED = "retired"


class RetiredScopeError(sync_engine.SyncError):
    """A selective push or pull of a scope sync no longer offers."""

    def __init__(self, scope: str) -> None:
        super().__init__(f"{scope} is not synced any more; nothing of it is pushed or pulled")
        self.scope = scope
#: The payload a held delete is sealed as: a real record never has this key.
DELETE_PAYLOAD: dict[str, Any] = {"$delete": True}
#: A listing row whose summary is longer than this is sent collapsed: its
#: small fields only, the rest loaded by ``detail`` when the card opens.
BRIEF_BYTES = 2048
#: Scopes whose full view is built only on ``detail`` (a memory file can be
#: a megabyte, twice with its diff).
_DETAIL_ONLY = frozenset({"memory"})


def _stash_dir() -> Path:
    from . import app

    return app.app_data_dir() / "sync-approvals"


def _private_dir(path: Path) -> Path:
    """*path* as a directory only this user can open (0700), with every
    directory this module made on the way to it."""
    root = _stash_dir()
    path.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        current = path
        while True:
            os.chmod(current, 0o700)
            if current == root or root not in current.parents:
                break
            current = current.parent
    return path


def private_file(path: Path) -> Path:
    """Create *path* empty, readable by this user only (0600)."""
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    os.close(fd)
    return path


def clean_leftover_temps(staging: Path | None = None) -> None:
    """Remove plaintext temporaries a crash left behind: review downloads in
    the hold area (fetch-*), and landing copies (review-*) here or in an
    older build's *staging* directory."""
    from . import app

    root = _stash_dir() / "files"
    patterns = ("fetch-*", "review-*")
    try:
        data_dir = Path(app.app_data_dir()).resolve()
    except OSError:
        return
    for base in (root, staging):
        if base is None or base.is_symlink() or not base.is_dir():
            continue
        # Never anywhere but under the data dir, whatever a link on the way
        # points at.
        try:
            resolved = base.resolve()
        except OSError:
            continue
        if data_dir not in resolved.parents:
            continue
        for pattern in patterns:
            for leftover in base.rglob(pattern):
                if leftover.is_file():
                    leftover.unlink(missing_ok=True)


def review_cache_bytes() -> int:
    """Bytes the sealed review copies of every hold take on disk."""
    root = _stash_dir() / "files"
    if not root.is_dir():
        return 0
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file())


def _stash_path(scope: str, item_id: str) -> Path:
    name = hashlib.sha256(f"{scope}\0{item_id}".encode("utf-8")).hexdigest()
    return _stash_dir() / scope / f"{name}.sealed"


def _index_path() -> Path:
    return _stash_dir() / "index.json"


def _index() -> dict[str, dict[str, dict[str, Any]]]:
    try:
        raw = json.loads(_index_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as err:
        log.warning("the sync approval index could not be read: %s", err)
        return {}
    if not isinstance(raw, dict):
        return {}
    return {
        str(scope): {str(i): dict(e) for i, e in entries.items() if isinstance(e, dict)}
        for scope, entries in raw.items()
        if isinstance(entries, dict)
    }


def _write_index(index: dict[str, dict[str, dict[str, Any]]]) -> None:
    """Atomically. Raises OSError when it cannot be written: a hold that is
    not on disk would be forgotten, and the engine told it was taken."""
    path = _index_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(f".{os.getpid()}.tmp")
    temp.write_text(json.dumps({s: e for s, e in index.items() if e}), encoding="utf-8")
    temp.replace(path)


def _approval_token(scope: str, item_id: str, payload_digest: str) -> str:
    """Proof that ``decide`` approved this exact payload: sealed under the
    account key, so editing the index cannot mint one."""
    return sync_keyring.encrypt(f"approved:{payload_digest}", scope=f"approval:{scope}", item_id=item_id)


def _token_ok(scope: str, item_id: str, record: dict[str, Any]) -> bool:
    token = record.get("token")
    if not isinstance(token, str) or not token:
        return False
    try:
        opened = sync_keyring.decrypt(token, scope=f"approval:{scope}", item_id=item_id)
    except Exception:  # noqa: BLE001 - a token that does not open approves nothing
        return False
    return opened == f"approved:{record.get('digest', '')}"


def _seal_summary(scope: str, item_id: str, summary: dict[str, Any]) -> str:
    return sync_keyring.encrypt(json.dumps(summary), scope=f"summary:{scope}", item_id=item_id)


def _open_summary(scope: str, item_id: str, record: dict[str, Any]) -> dict[str, Any] | None:
    sealed = record.get("summary")
    if not isinstance(sealed, str):
        return None
    try:
        opened = json.loads(sync_keyring.decrypt(sealed, scope=f"summary:{scope}", item_id=item_id))
    except Exception:  # noqa: BLE001 - a summary that does not open shows nothing
        return None
    return opened if isinstance(opened, dict) else None


#: Summary keys that mark a stub or a cut list. A preview cut with its own
#: visible flag (``skillMdTruncated``, a preview's ``truncated``) is not one:
#: the list of what lands is still whole.
_STUB_KEYS = frozenset({"truncated", "argsTruncated", "envTruncated", "headersTruncated", "filesTruncated"})


def _displayable(summary: dict[str, Any] | None) -> bool:
    """Whether a summary shows the whole record: never a stub or a cut list,
    and not one whose content could not be fetched for review
    (``unavailable`` says why)."""
    return isinstance(summary, dict) and not (_STUB_KEYS & set(summary)) and "unavailable" not in summary


#: Per scope, how a held record is shown in full when listed: built then
#: from the sealed payload and this machine's copy, so the index stays small
#: and a memory file can be shown up to the memory scope's own size limit.
_presenters: dict[str, Callable[[str, Any, dict[str, Any]], dict[str, Any]]] = {}


def register_presenter(scope: str, present: Callable[[str, Any, dict[str, Any]], dict[str, Any]]) -> None:
    """``present(item_id, payload, summary) -> summary`` for *scope*'s holds."""
    _presenters[scope] = present


def _presented(scope: str, item_id: str, summary: dict[str, Any] | None) -> dict[str, Any] | None:
    present = _presenters.get(scope)
    if present is None or summary is None:
        return summary
    payload = held_payload(scope, item_id)
    if payload is None:
        return summary
    try:
        return present(item_id, payload, summary)
    except Exception as err:  # noqa: BLE001 - shown as not approvable, never as less
        log.warning("held %s/%s could not be shown: %s", scope, item_id, err)
        return {**summary, "unavailable": f"it could not be shown here: {err}"}


def showable(summary: Any) -> bool:
    """Whether *summary* can be put in front of a person whole: what a hold
    requires, and what a settings-bundle import requires too."""
    return _displayable(summary) and len(json.dumps(summary)) <= MAX_SUMMARY_BYTES


def _waiting(entries: dict[str, dict[str, Any]]) -> int:
    return sum(1 for e in entries.values() if e.get("status") != REJECTED)


def full_scopes() -> list[str]:
    """Scopes whose approval queue is full: new records there are refused
    (and show as refused in the round's result) until some are decided."""
    return sorted(s for s, entries in _index().items() if _waiting(entries) >= MAX_HOLDS_PER_SCOPE)


def _round_is_stale() -> bool:
    # A round begun for the previous account must not file requests under
    # the next one (the same guard the detached marks take).
    is_current = getattr(sync_engine, "round_is_current", None)
    return is_current is not None and not is_current()


def digest(payload: Any) -> str:
    return sync_engine.digest(payload)


def entry(scope: str, item_id: str) -> dict[str, Any] | None:
    return _index().get(scope, {}).get(item_id)


def hold(
    scope: str,
    item_id: str,
    payload: Any,
    *,
    local: Any | None,
    kind: str,
    summary: dict[str, Any],
) -> bool:
    """File *payload* for approval instead of applying it. Worker thread.

    ``local`` is the item as this machine holds it now (None when absent);
    its digest is what ``overlay`` checks to notice a local edit. False when
    nothing was filed — a stale round, a scope full of pending records, or a
    store that would not write — which the adapter reports as a refusal.
    """
    if _round_is_stale():
        return False
    if not isinstance(summary, dict) or _STUB_KEYS & set(summary) or len(json.dumps(summary)) > MAX_SUMMARY_BYTES:
        log.warning("synced %s/%s cannot be shown in full for approval; refused", scope, item_id)
        return False
    with _lock:
        index = _index()
        entries = index.setdefault(scope, {})
        replacing = entries.get(item_id)
        if (replacing is None or replacing.get("status") == REJECTED) and _waiting(entries) >= MAX_HOLDS_PER_SCOPE:
            log.warning("%s already has %d records waiting for approval; %s is refused",
                        scope, _waiting(entries), item_id)
            return False
        try:
            path = _stash_path(scope, item_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            sealed = sync_keyring.encrypt(sync_engine.canonical(payload), scope=scope, item_id=item_id)
            temp = path.with_suffix(".tmp")
            temp.write_text(sealed, encoding="utf-8")
            temp.replace(path)
            entries[item_id] = {
                "digest": digest(payload),
                "base": digest(local) if local is not None else "",
                "status": PENDING,
                "kind": kind,
                "summary": _seal_summary(scope, item_id, summary),
                "at": int(time.time()),
            }
            _write_index(index)
            _prune_held_files(scope, index)
        except (OSError, sync_keyring.KeyringError) as err:
            log.warning("synced %s/%s could not be held for approval: %s", scope, item_id, err)
            return False
    log.info("synced %s/%s is waiting for approval (%s)", scope, item_id, kind)
    return True


# ── files downloaded for review (large skills) ──────────────────────────────
#
# A large skill's files travel as blobs, after its record. To be shown before
# approval they are downloaded into the hold area and sealed there under the
# account key, segment by segment, each bound to scope, item, the record's
# digest and the file's path: never in a skills directory, never executable,
# and a file swapped for another one of the hold does not open.

_SEGMENT = 1024 * 1024
_HELD_FILE_MAGIC = b"NVHF1\n"


def _held_files_dir(scope: str, item_id: str, payload_digest: str) -> Path:
    name = hashlib.sha256(f"{scope}\0{item_id}\0{payload_digest}".encode("utf-8")).hexdigest()
    return _stash_dir() / "files" / scope / name


def _file_label(scope: str, item_id: str, payload_digest: str, rel: str) -> str:
    return hashlib.sha256(f"{scope}\0{item_id}\0{payload_digest}\0{rel}".encode("utf-8")).hexdigest()


def seal_held_file(scope: str, item_id: str, payload_digest: str, rel: str, source: Path) -> None:
    """Seal *source* (plaintext) into the hold area as *rel* of this record."""
    kid = sync_keyring.active_key_id()
    if not kid:
        raise sync_keyring.KeyringError("no account key to seal a held file under")
    label = _file_label(scope, item_id, payload_digest, rel)
    size = source.stat().st_size
    count = max(1, -(-size // _SEGMENT))
    directory = _private_dir(_held_files_dir(scope, item_id, payload_digest))
    target = directory / label
    temp = private_file(target.with_suffix(".tmp"))
    with open(source, "rb") as src, open(temp, "wb") as out:
        out.write(_HELD_FILE_MAGIC + kid.encode("ascii") + b"\n" + str(count).encode() + b"\n")
        for index in range(count):
            sealed = sync_keyring.seal_segment(
                src.read(_SEGMENT), kid=kid, blob_id=label, index=index, count=count
            )
            out.write(len(sealed).to_bytes(4, "big") + sealed)
    os.chmod(temp, 0o600)
    temp.replace(target)


def _held_file_segments(scope: str, item_id: str, payload_digest: str, rel: str):
    """Yield the plaintext segments of a held file; raises when it does not open."""
    label = _file_label(scope, item_id, payload_digest, rel)
    path = _held_files_dir(scope, item_id, payload_digest) / label
    with open(path, "rb") as fh:
        if fh.read(len(_HELD_FILE_MAGIC)) != _HELD_FILE_MAGIC:
            raise sync_keyring.KeyringError(f"held file {rel} is not sealed")
        kid = fh.readline().strip().decode("ascii")
        count = int(fh.readline().strip())
        for index in range(count):
            length = int.from_bytes(fh.read(4), "big")
            yield sync_keyring.open_segment(fh.read(length), kid=kid, blob_id=label, index=index, count=count)
        if fh.read(1):
            raise sync_keyring.KeyringError(f"held file {rel} has trailing data")


def held_file_head(scope: str, item_id: str, payload_digest: str, rel: str, limit: int) -> tuple[bytes, bool]:
    """The first *limit* bytes of a held file, and whether there is more."""
    out = b""
    for segment in _held_file_segments(scope, item_id, payload_digest, rel):
        out += segment
        if len(out) > limit:
            return out[:limit], True
    return out, False


def open_held_file(scope: str, item_id: str, payload_digest: str, rel: str, dest: Path) -> str:
    """Write a held file's plaintext to *dest*; returns its SHA-256."""
    sha = hashlib.sha256()
    private_file(dest)
    with open(dest, "wb") as out:
        for segment in _held_file_segments(scope, item_id, payload_digest, rel):
            sha.update(segment)
            out.write(segment)
    return sha.hexdigest()


def drop_held_files(scope: str, item_id: str, payload_digest: str | None = None) -> None:
    import shutil

    if payload_digest is not None:
        shutil.rmtree(_held_files_dir(scope, item_id, payload_digest), ignore_errors=True)
        return
    record = entry(scope, item_id)
    if record is not None:
        shutil.rmtree(_held_files_dir(scope, item_id, str(record.get("digest", ""))), ignore_errors=True)


def held_summary(scope: str, item_id: str) -> dict[str, Any] | None:
    record = entry(scope, item_id)
    return _open_summary(scope, item_id, record) if record is not None else None


def update_summary(scope: str, item_id: str, payload_digest: str, summary: dict[str, Any]) -> bool:
    """Replace the summary of a hold still at *payload_digest* (a review that
    finished, or failed). False when the hold moved on or the summary is cut."""
    if _STUB_KEYS & set(summary) or len(json.dumps(summary)) > MAX_SUMMARY_BYTES:
        summary = {"name": summary.get("name"), "unavailable": "the review is too large to show"}
    with _lock:
        index = _index()
        record = index.get(scope, {}).get(item_id)
        if record is None or record.get("digest") != payload_digest:
            return False
        record["summary"] = _seal_summary(scope, item_id, summary)
        _write_index(index)
    return True


def held_payload(scope: str, item_id: str) -> Any | None:
    """The held payload, or None when there is none or it will not open here."""
    path = _stash_path(scope, item_id)
    try:
        sealed = path.read_text(encoding="utf-8")
        return json.loads(sync_keyring.decrypt(sealed, scope=scope, item_id=item_id))
    except FileNotFoundError:
        return None
    except Exception as err:  # noqa: BLE001 - a hold that will not open is no hold
        log.warning("the held %s/%s could not be opened: %s", scope, item_id, err)
        return None


def drop(scope: str, item_id: str) -> None:
    with _lock:
        index = _index()
        if index.get(scope, {}).pop(item_id, None) is not None:
            _write_index(index)
        _stash_path(scope, item_id).unlink(missing_ok=True)
        _prune_held_files(scope, index)


def _prune_held_files(scope: str, index: dict[str, dict[str, dict[str, Any]]]) -> None:
    """Remove files downloaded for review of any hold *index* no longer has
    (or has at another digest): they go with the hold."""
    import shutil

    root = _stash_dir() / "files" / scope
    if not root.is_dir():
        return
    keep = {_held_files_dir(scope, i, str(e.get("digest", ""))).name for i, e in index.get(scope, {}).items()}
    for directory in root.iterdir():
        if directory.name not in keep:
            shutil.rmtree(directory, ignore_errors=True)


def is_approved(scope: str, item_id: str, payload: Any) -> bool:
    """Whether ``decide`` approved exactly *payload* for this item."""
    held = entry(scope, item_id)
    return bool(
        held and held.get("status") == APPROVED and held.get("digest") == digest(payload)
        and _token_ok(scope, item_id, held)
    )


def is_rejected(scope: str, item_id: str, payload: Any) -> bool:
    held = entry(scope, item_id)
    return bool(held and held.get("status") == REJECTED and held.get("digest") == digest(payload))


def overlay(scope: str, snapshot: dict[str, Any]) -> dict[str, Any]:
    """*snapshot* with each held item replaced by its held payload.

    That is what keeps the engine from pushing this machine's copy over the
    change it holds. A hold whose local copy has since changed (or whose
    payload no longer opens) is dropped: the local edit is newer.
    """
    held = _index().get(scope)
    if not held:
        return snapshot
    out = dict(snapshot)
    for item_id, record in held.items():
        local = snapshot.get(item_id)
        local_digest = digest(local) if local is not None else ""
        if local_digest != record.get("base", ""):
            log.info("%s/%s changed here while it waited for approval; the local edit wins", scope, item_id)
            drop(scope, item_id)
            continue
        payload = held_payload(scope, item_id)
        if payload is None:
            # Fails closed, waiting or rejected alike: the hold stays, and
            # ``withheld`` keeps the engine from pushing this machine's copy —
            # or its absence, a delete — over the change it held. A missing
            # payload is never a delete.
            continue
        if payload == DELETE_PAYLOAD:
            # A held delete stands in as the item's absence, which is what
            # the engine already agreed on: nothing is pushed back.
            out.pop(item_id, None)
            continue
        out[item_id] = payload
    return out


def withheld(scope: str) -> list[str]:
    """Holds whose payload no longer opens here (or is gone), and restored
    versions still waiting for a yes: the engine sends nothing for them — no
    edit, no delete — and reports them as held, until a newer record for the
    item replaces the hold or the user decides."""
    return sorted(
        item_id for item_id, record in _index().get(scope, {}).items()
        if record.get("restored") or held_payload(scope, item_id) is None
    )


def mark_restored(scope: str, item_id: str) -> None:
    """The hold of *item_id* is an earlier version the user asked to bring
    back, not a record the cloud agreed on. Unlike a pulled hold it differs
    from what was agreed, so ``overlay`` showing it would push it before it
    was approved here; ``withheld`` keeps it back instead, and a "no" drops it."""
    with _lock:
        index = _index()
        record = index.get(scope, {}).get(item_id)
        if record is None:
            return
        record["restored"] = True
        _write_index(index)


def set_status(scope: str, item_id: str, status: str, *, token: str = "") -> None:
    with _lock:
        index = _index()
        record = index.get(scope, {}).get(item_id)
        if record is None:
            return
        record["status"] = status
        if token:
            record["token"] = token
        else:
            record.pop("token", None)
        _write_index(index)


def _row(scope: str, item_id: str, record: dict[str, Any], *, brief: bool) -> dict[str, Any]:
    stored = _open_summary(scope, item_id, record)
    collapsed = False
    if brief and scope in _DETAIL_ONLY:
        summary, collapsed = stored, True
    else:
        summary = _presented(scope, item_id, stored)
        persist = summary.pop("persist", None) if isinstance(summary, dict) else None
        if isinstance(persist, dict) and isinstance(stored, dict) and any(
            stored.get(k) != v for k, v in persist.items()
        ):
            # What the card now shows is what an approval is checked against.
            update_summary(scope, item_id, str(record.get("digest", "")), {**stored, **persist})
    displayable = _displayable(summary)
    if brief and summary is not None and len(json.dumps(summary)) > BRIEF_BYTES:
        summary = {k: v for k, v in summary.items() if len(json.dumps(v)) <= 256}
        collapsed = True
    return {
        "scope": scope,
        "itemId": item_id,
        "digest": record.get("digest", ""),
        "status": record.get("status", PENDING),
        "kind": record.get("kind", KIND_NEW),
        "summary": summary or {},
        # False: the window shows "cannot be displayed — reject" and no
        # Approve; decide() refuses an approval of it too.
        "displayable": displayable,
        # True: the summary holds only its small fields; ``detail`` gives the
        # rest, and the window loads it before it offers Approve.
        "collapsed": collapsed,
        "at": record.get("at", 0),
    }


def listing(*, brief: bool = False) -> list[dict[str, Any]]:
    """Every held record, for the window: no payload, only its summary, and
    the digest of the exact payload — which ``decide`` must be handed back,
    so what is approved is what was shown. ``brief`` (what the window asks
    for) collapses long summaries; ``detail`` gives one whole."""
    out = []
    for scope, entries in sorted(_index().items()):
        if scope in RETIRED_SCOPES:
            continue
        for item_id, record in sorted(entries.items()):
            out.append(_row(scope, item_id, record, brief=brief))
    return out


def detail(scope: str, item_id: str) -> dict[str, Any]:
    """One held record with its whole summary (the card, expanded)."""
    record = entry(scope, item_id)
    if record is None or scope in RETIRED_SCOPES:
        raise sync_engine.SyncError(f"nothing from {scope}/{item_id} is waiting for approval")
    return _row(scope, item_id, record, brief=False)


def decide(adapter: Any, item_id: str, approve: bool, shown_digest: str) -> dict[str, Any]:
    """Apply the user's decision on one held record. Worker thread.

    *shown_digest* is the ``digest`` the window listed: a record replaced by
    a newer version since is refused, to be reviewed again. Approval writes
    the held payload through the adapter, now let past the gate; a large
    skill whose files must download first stays ``approved`` until they land
    (``SkillFilesScope`` retries it each round). Rejection keeps the hold, so
    the cloud copy goes on standing in for the local one.
    """
    scope = adapter.scope
    if scope in RETIRED_SCOPES:
        raise sync_engine.SyncError(f"{scope} is not synced any more; nothing from it lands")
    with _lock:
        record = entry(scope, item_id)
        if record is None:
            raise sync_engine.SyncError(f"nothing from {scope}/{item_id} is waiting for approval")
        if not shown_digest or record.get("digest") != shown_digest:
            raise sync_engine.SyncError(
                f"{scope}/{item_id} changed since it was shown; review it again"
            )
        if not approve and record.get("restored"):
            # A restore nobody wants: the agreed copy is the local one, so
            # there is nothing to keep standing in for it.
            drop(scope, item_id)
            drop_held_files(scope, item_id, shown_digest)
            return {"scope": scope, "itemId": item_id, "status": REJECTED}
        if not approve:
            set_status(scope, item_id, REJECTED)
            # Nothing reviewed is kept for a "no".
            drop_held_files(scope, item_id, shown_digest)
            return {"scope": scope, "itemId": item_id, "status": REJECTED}
        # The local copy the hold was filed against, read the way the adapter
        # read it then (approval_local, or its local snapshot).
        approval_local = getattr(adapter, "approval_local", None)
        local_snapshot = getattr(adapter, "local_snapshot", None)
        local = approval_local(item_id) if approval_local is not None else (
            local_snapshot().get(item_id) if local_snapshot is not None else None
        )
        if (approval_local is not None or local_snapshot is not None) and (
            digest(local) if local is not None else ""
        ) != record.get("base", ""):
            if isinstance(local, dict) and digest({**local, "isDefault": not local.get("isDefault")}) == record.get("base"):
                raise sync_engine.SyncError(
                    f"another approval changed which prompt is the default here since {item_id} was shown; "
                    "review it again"
                )
            raise sync_engine.SyncError(
                f"{scope}/{item_id} changed here since it was shown; review it again"
            )
        presented = _presented(scope, item_id, _open_summary(scope, item_id, record))
        if isinstance(presented, dict):
            presented.pop("persist", None)
        if not _displayable(presented):
            raise sync_engine.SyncError(
                f"{scope}/{item_id} cannot be shown in full here, so it cannot be approved; reject it"
            )
        payload = held_payload(scope, item_id)
        if payload is None or digest(payload) != shown_digest:
            # Kept, not dropped: dropping would let the engine push this
            # machine's copy (or a delete) over it.
            raise sync_engine.SyncError(f"the held {scope}/{item_id} could not be opened here; reject it")
        set_status(scope, item_id, APPROVED, token=_approval_token(scope, item_id, shown_digest))
    return {"scope": scope, "itemId": item_id, "status": land(adapter, item_id, payload)}


def land(adapter: Any, item_id: str, payload: Any) -> str:
    """Write an approved payload; the status it leaves the hold in."""
    scope = adapter.scope
    try:
        result = adapter.apply(item_id, payload)
    except sync_engine.DeferItem:
        return APPROVED  # files on their way; landed on a later round
    except sync_engine.SyncError:
        set_status(scope, item_id, PENDING)  # not landed: back to waiting, without the token
        raise
    if result is False:
        # Refused here after all (the store would not take it). The hold goes
        # back to waiting, so the window shows it still unresolved.
        set_status(scope, item_id, PENDING)
        raise sync_engine.SyncError(f"{scope}/{item_id} was approved but could not be written here")
    drop(scope, item_id)
    return "applied"


def land_approved(adapter: Any) -> None:
    """Retry every approved-but-not-landed hold of *adapter*'s scope — only
    those ``decide`` approved (its token checks out for the held payload)."""
    for item_id, record in list(_index().get(adapter.scope, {}).items()):
        if record.get("status") != APPROVED or not _token_ok(adapter.scope, item_id, record):
            continue
        payload = held_payload(adapter.scope, item_id)
        if payload is None:
            # Fails closed, as in overlay/withheld: kept, never a delete.
            continue
        if digest(payload) != record.get("digest"):
            drop(adapter.scope, item_id)
            continue
        try:
            land(adapter, item_id, payload)
        except sync_engine.SyncError as err:
            log.warning("%s", err)


def _parked_dir(account: str) -> Path | None:
    from . import app

    # A namespace is hex; anything else never names a directory.
    if not account or not all(c in "0123456789abcdef" for c in account):
        return None
    return app.app_data_dir() / "sync-approvals-parked" / account


def park_approvals(account: str) -> bool:
    """Move every hold aside under *account* (D4), sealed as they are under
    that account's key, so switching back finds them waiting. False when
    there is no such place, and the holds stay for ``forget_approvals``."""
    import shutil

    dest = _parked_dir(account)
    if dest is None:
        return False
    with _lock:
        src = _stash_dir()
        if dest.exists():
            shutil.rmtree(dest)
        if src.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.replace(src, dest)
    return True


def restore_approvals(account: str) -> None:
    """Bring *account*'s parked holds back. Raises OSError when they cannot be."""
    import shutil

    src = _parked_dir(account)
    if src is None or not src.exists():
        return
    with _lock:
        live = _stash_dir()
        if live.exists():
            shutil.rmtree(live)
        live.parent.mkdir(parents=True, exist_ok=True)
        os.replace(src, live)


def discard_parked_approvals(account: str) -> None:
    import shutil

    parked = _parked_dir(account)
    if parked is not None:
        shutil.rmtree(parked, ignore_errors=True)


def forget_approvals(scope: str | None = None) -> None:
    """Drop every hold of *scope*, or of every scope — on an account change,
    whose key the held payloads are sealed under."""
    with _lock:
        index = _index()
        scopes = list(index) if scope is None else [scope]
        import shutil

        for name in scopes:
            for item_id in list(index.get(name, {})):
                _stash_path(name, item_id).unlink(missing_ok=True)
            index.pop(name, None)
            shutil.rmtree(_stash_dir() / "files" / name, ignore_errors=True)
        _write_index(index)
