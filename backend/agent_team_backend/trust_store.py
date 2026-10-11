"""What this machine has decided to believe about the other ones, on disk.

Three pieces of state decide whether a cross-device message is honoured, and
before this module all three lived in a Python attribute that a restart erased:

*Which signing key belongs to which device.* Without it a signature proves only
that *somebody* holds *a* key — and the relay can mint keys all day. Pinned on
first sight (trust on first use), and a device whose key later changes is
refused rather than re-pinned.

*The highest policy sequence this device has ever signed.* The pane policy is
stored by the server, so the server chooses which version to hand back; without
a locally held high-water mark it can hand back an older one, or none, and
nothing notices.

*Which peers have ever been sent ciphertext.* ``server_link`` refuses to fall
back to plaintext for a peer it has seen a key for, which is the right rule and
was, until now, forgotten on every backend restart — so the relay could get
plaintext simply by dropping a key from the directory and waiting for the next
restart, which is a daily event.

**Why two storage systems.** The state itself goes in the credential vault (the
Keychain on macOS, a 0600 file elsewhere), and a bare "this machine has been
initialised" marker goes in ``navide.db``. They are deliberately in different
places, because the failure this design exists to prevent is *silent* reset: if
both lived together, one `rm` would take the marker with the state and the next
start would look exactly like a first start. Split, a missing state file with
the marker present is a state this machine can recognise and refuse to work in.

**Fail closed, and no upgrade grace.** Marker present but state unreadable means
cross-device traffic stops and the user is told, rather than the pins quietly
starting over. There is no "old installs get one free pass" allowance either: a
grace period is an attacker-reachable reset, repeatable as often as they like,
and the population it would serve does not exist — no shipped build has ever
written any of this.

**The marker records who wrote it, and that is not a loophole.** The first thing
ever to trip this lock was our own verification script, which used to run
against the real app-data directory: it left a marker with no state behind, and
the symptom — cross-device traffic stopping in both directions — is exactly what
a real attacker deleting the state would produce. Someone who did not happen to
know what they had run ten minutes earlier would have investigated the wrong
thing. So the marker carries the program and the time that created it, and the
lock message quotes them. This changes no decision: the lock holds whatever the
provenance says, and nothing here treats a marker as dismissible. It only means
the person reading the message is told a fact instead of having to guess, which
is the same problem as a warning buried under noise — the defence is intact and
the part where *a human finds out* is what got damaged.

The judgement behind all of it: losing a *private key* breaks things visibly, so
it can be regenerated. Losing a *pin* breaks nothing visible and removes a
protection, so it must not be regenerated. Anything that would fail silently is
treated here as an error.
"""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import sys
import threading
import time
from pathlib import Path
from typing import Any

from agent_team_backend import cloud_secrets, device_signing, trust_file
from agent_team_backend.applog import app_data_dir, in_data_dir
from agent_team_backend.osplat import durable_secret_files

log = logging.getLogger(__name__)

#: The vault entry holding the state document, and the navide.db key holding
#: the "we have been here before" marker. See the module note on why they are
#: not the same store.
SECRET_NAME = "navide-device-trust"
INITIALISED_KEY = "p2p.trust.initialised"

#: The fast-growing half of the state — up to MAX_NOTICES notices and
#: MAX_SEEN_MESSAGES ledger keys — kept in an owner-only file in the data dir
#: rather than in the vault entry. Inside it they pushed the Keychain item past
#: `security -i`'s 4095-byte line after about fifteen remote commands, and a
#: write that long was stored truncated. Neither decides whom to trust: losing
#: the file costs the notices and, for one TTL, replay protection — the same
#: price ``_parse`` already accepts for a document that predates the ledger.
JOURNAL_FILENAME = "device-trust-journal.json"
#: Its own owner-only directory, so the permission that guards it does not
#: depend on how the rest of the data dir was created.
JOURNAL_DIRNAME = "device-trust"
_JOURNAL_KEYS = ("notices", "seenMessages")
#: The record itself, sealed with a key the Keychain keeps (plan 797ad7, B1).
#: It outgrew the one Keychain line ``security -i`` writes, which capped
#: pairing at a handful of devices; a file has no such line.
RECORD_FILENAME = "device-trust.json.sealed"
#: The marker's ``store`` once the record lives in the sealed file. A marker
#: that says so is never read back from the Keychain item, so the item an
#: earlier build left cannot roll the record back.
STORE_FILE = "file-v1"
#: What the Keychain item held when this build last wrote it, sealed like the
#: record: the common ancestor when an earlier build has changed that item
#: since (review F2), so coming back merges rather than replaces.
MIRROR_FILENAME = "device-trust-mirror.json.sealed"
#: Whether a record still in the Keychain moves into the file. A hotfix switch,
#: not a setting: off, a new record stays in the Keychain as before.
FILE_STORE = True

STATE_VERSION = 1

#: How many remote devices this machine will pin. The directory is filled by
#: other machines, so it is only as small as they are well behaved. At the cap
#: new devices stop being pinnable — which denies them, rather than evicting an
#: existing pin, because an evicted pin is a protection that disappears without
#: anything going wrong on screen.
MAX_DEVICES = 200

#: Notices waiting to be read. The *refusal* a notice describes comes from the
#: pin and is never dropped, so the cap costs visibility rather than protection
#: — but visibility is the whole job here, so what gets evicted is not
#: whichever is oldest. See ``_record_locked``.
MAX_NOTICES = 50

#: Bounds on the delivered-message ledger. Same shape and reasoning as the
#: in-memory version it replaces: a map fed by a remote peer needs a ceiling,
#: and a delivered message stops being interesting once no sender would retry.
MAX_SEEN_MESSAGES = 500
#: Longest string kept in a notice. Names and ids in one come from the other
#: machine or the relay, and fifty notices are kept.
MAX_NOTICE_TEXT = 200
SEEN_MESSAGE_TTL_S = 3600

#: How long recording a delivery may stay in memory before it reaches disk.
#:
#: Without this, every inbound message rewrites the whole state document into
#: the Keychain — on the delivery path, so the cost lands as latency before the
#: message reaches a pane.
#:
#: The trade is worth stating rather than assuming: a process killed with
#: unflushed keys forgets them, so those messages could be replayed once. That
#: is acceptable because this ledger defends against replay after a *clean*
#: restart — which a relay can simply wait for — not after a crash, which it
#: cannot arrange and which loses at most a few seconds of keys.
SEEN_FLUSH_AFTER = 25
SEEN_FLUSH_SECONDS = 10.0

NOTICE_FIRST_SEEN = "device-first-seen"
NOTICE_KEY_CHANGED = "device-key-changed"
NOTICE_POLICY_UNVERIFIED = "policy-unverified"
NOTICE_MEMBER_CHANGED = "member-changed"
#: A peer that has been encrypting sent plaintext, and this machine refused it.
#: The send side has refused to *emit* plaintext to such a peer since the
#: downgrade record was made durable; this is the other half — without it, a
#: relay that wants cleartext only has to ask the far end for it, because the
#: far end had no rule against accepting.
NOTICE_PLAINTEXT_REFUSED = "plaintext-refused"

#: What happened to a pairing: it completed, the other side refused, or the
#: other side later revoked it. All three are things the person at *this*
#: machine did not do and would otherwise have no way to learn — which is the
#: whole complaint the pairing exchange exists to answer.
NOTICE_PAIRING = "device-pairing"

#: A remote device sent a command to a pane here. One line per delivery, kept
#: because "who has been driving my machines" was answerable only from a log
#: file nobody opens.
NOTICE_REMOTE_COMMAND = "remote-command"

#: Only a first sighting may be dismissed. A key change is not a notification
#: to acknowledge — it is a refusal in force, and a button that made it go away
#: would let the answer to "somebody may be standing in for that machine" be one
#: click, which is the click an attacker is counting on.
#:
#: A refused downgrade is the same shape and stays for the same reason: it says
#: a message was dropped, and dropped messages are exactly what a person needs
#: to keep seeing while they work out why.
DISMISSIBLE = frozenset({NOTICE_FIRST_SEEN})

#: Every kind this module can record. Exists so the renderer's union can be
#: checked against it: a kind the UI has no branch for does not fail to render,
#: it falls through to whichever branch is last — which is how `member-changed`
#: came to be displayed as "first seen this device", a sentence that is not
#: merely unhelpful but false. Type systems cannot catch that: the values
#: arrive as JSON, so a union missing a member is perfectly legal TypeScript.
ALL_NOTICE_KINDS = frozenset({
    NOTICE_FIRST_SEEN,
    NOTICE_KEY_CHANGED,
    NOTICE_POLICY_UNVERIFIED,
    NOTICE_MEMBER_CHANGED,
    NOTICE_PLAINTEXT_REFUSED,
})


class TrustStoreNotLocked(RuntimeError):
    """Raised when a rebuild is asked for and there is nothing wrong.

    Refused rather than performed: a rebuild destroys every pairing, and a
    caller that reaches for it against a healthy store has misunderstood what it
    does. It is never the answer to "something feels off".
    """


class TrustStoreLocked(RuntimeError):
    """The state was initialised once and cannot be read now.

    Never resolved by starting over: that is precisely the outcome an attacker
    who can delete a file would be buying.
    """


class TrustStoreFull(RuntimeError):
    """The device cap is reached, so a new pin cannot be taken."""


_FULL_MESSAGE = (
    "the pairing record is full: this build keeps it in one macOS Keychain "
    "item, which has no room for this change. Update Navide to pair more devices"
)
#: A policy sequence as long as one is ever expected to get, for the reserve.
_RESERVED_SEQ = 10**9
#: Stands in for this machine's own device id in the reserve: its policy
#: sequence lives in the same map and is not one of the pins.
_OWN_DEVICE_PLACEHOLDER = "00000000-0000-4000-8000-000000000000"


_lock = threading.RLock()
_state: dict[str, Any] | None = None
_locked_reason = ""
#: Whether the latched lock is a record that is there but does not parse — cut
#: off by a write, rather than missing. Said apart because the way out differs:
#: a damaged record is known to be useless, so pairing again is the fix.
_damaged = False
#: A read that failed for a reason that may not still be true — a locked
#: keychain, a dismissed authorisation dialog, a ``security`` timeout. Reported
#: like a lock, because nothing works while it holds, but not latched.
_transient_reason = ""
_transient_failures = 0
#: How many consecutive transient failures before this is treated as settled.
#:
#: Not unlimited, and not one. Retrying for ever means every trust operation
#: shells out to ``security`` again — which on a locked keychain means another
#: authorisation dialog, so "keep trying" turns into a machine that will not
#: stop asking. Giving up after the first means one dismissed dialog locks the
#: process until it restarts, which is the failure this exists to remove.
#:
#: Three is a judgement, not a measurement: enough that a dialog dismissed by
#: accident, or a keychain unlocked a moment later, costs nothing; few enough
#: that a keychain which is genuinely unavailable settles quickly instead of
#: prompting on every call.
TRANSIENT_RETRY_LIMIT = 3


# ---- storage -----------------------------------------------------------------


#: The vault a timed flush was armed with, while it runs (see _arm_seen_timer_locked).
_timer_vault: Any = None


def _vault():
    if _timer_vault is not None:
        return _timer_vault
    # Late import for the same reason server_link does it: app imports both, and
    # tests swap the app-wide vault wholesale to stay off the real Keychain.
    from . import app

    return app.credential_vault


def _database():
    from . import app

    return app.database


def _blank() -> dict[str, Any]:
    return {
        "v": STATE_VERSION,
        # credential fingerprint -> the member id that credential means. A map
        # rather than one entry because signing out of one account and back into
        # another is ordinary, and a single slot would let the second sign-in
        # overwrite the first pin — so returning to the first account would take
        # whatever the server said that day.
        "ownMembers": {},
        "pins": {},
        # deviceId -> the highest policy sequence this machine ever signed for
        # that device. Keyed rather than flat because the sequence belongs to
        # the policy document, and a document names the device it governs: a
        # single counter would make one device's write look like a rollback of
        # another's. In production this map holds exactly one entry.
        "policySeqs": {},
        # A local copy of the block list, which otherwise exists only inside the
        # server-held policy document. Blocking is the one decision here that
        # has to survive that document being unreadable: the policy is refused
        # wholesale when its signature does not verify, and the first version of
        # this let that refusal *unblock* every device — the panel put them back
        # on the "waiting for you to vouch" card, and the delivery path stopped
        # refusing them. A server that wants a block gone could therefore get it
        # by making the policy fail to verify, which is far easier than forging
        # one that verifies without it. Entries are {deviceId, memberId}; either
        # may be empty, and they are read as alternatives, exactly as the
        # policy's own list is.
        "blocked": [],
        "encryptedPeers": [],
        # msg_key -> unix seconds when it was first delivered. Persisted because
        # the in-memory version expired at every restart, and a backend restart
        # is a daily event rather than something a relay has to arrange — so
        # "we already delivered that" was a promise anyone could simply wait out.
        "seenMessages": {},
        "notices": [],
    }


def _parse(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        doc = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(doc, dict) or doc.get("v") != STATE_VERSION:
        return None
    for key, kind in (
        ("ownMembers", dict),
        ("pins", dict),
        ("encryptedPeers", list),
    ):
        if not isinstance(doc.get(key), kind):
            return None
    # Fields added after v1 shipped. Absent means "this state file predates the
    # field", which has to read as the empty value rather than as a parse
    # failure: every other guarantee in this module — the pins (C1), the policy
    # sequences (C2), the downgrade list (H1/H2) — is read out of this same
    # document. A missing ledger costs replay protection for one restart; an
    # unreadable document costs all four at once.
    # The notices are among them now: a vault entry written since they moved to
    # the journal no longer carries them.
    for later, empty in (("policySeqs", {}), ("seenMessages", {}), ("notices", [])):
        value = doc.get(later)
        if value is None:
            doc[later] = empty
        elif not isinstance(value, type(empty)):
            return None
    return doc


#: Where the record lives in this process: "file", "keychain", or None before
#: the first load. Decided by the marker; see ``_load_locked``.
_store_mode: str | None = None
#: The key the sealed record opens with, once read.
_record_key: bytes | None = None
#: The record as last written to the Keychain item in file mode, so it is
#: rewritten only when it changed (plan 797ad7, B3). See ``_mirror_locked``.
_last_mirror: str | None = None

#: What was last written to (or read from) each store, so a save that changed
#: only the journal does not rewrite the Keychain item, and vice versa.
_last_core: str | None = None
_last_journal: str | None = None
#: The vault half as last read or confirmed written. A decision write whose save
#: fails is rolled back to it (see ``_save_locked``).
_committed_core: dict[str, Any] | None = None


def _core_of(state: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in state.items() if key not in _JOURNAL_KEYS}


def _journal_path() -> Path:
    return app_data_dir() / JOURNAL_DIRNAME / JOURNAL_FILENAME


def _record_path() -> Path:
    return app_data_dir() / JOURNAL_DIRNAME / RECORD_FILENAME


def _mirror_base_path() -> Path:
    return app_data_dir() / JOURNAL_DIRNAME / MIRROR_FILENAME


def _remember_mirror_locked(text: str) -> None:
    """Keep *text* as what the Keychain item now holds. Never raises: a copy
    that is missing, or does not match the marker, only means the next merge
    has no common ancestor (see ``_read_mirror_base``)."""
    try:
        durable_secret_files.write(
            _mirror_base_path(), trust_file.seal(_record_key, text.encode("utf-8"), trust_file.AAD_MIRROR)
        )
    except Exception as err:  # noqa: BLE001 - a merge aid, never a failure
        log.warning("the last downgrade copy of the device trust record was not kept (%s)", err)


def _read_mirror_base(digest: Any) -> dict[str, Any] | None:
    """What this build last wrote to the Keychain item, or None when that is
    not known — never one that differs from what the marker says it wrote."""
    try:
        path = _mirror_base_path()
        if path.is_symlink():
            return None
        text = trust_file.unseal(_record_key, durable_secret_files.read(path), trust_file.AAD_MIRROR).decode("utf-8")
    except Exception:  # noqa: BLE001 - unknown ancestor
        return None
    return _parse(text) if _digest(text) == digest else None


def _merge_returned(ours: dict[str, Any], theirs: dict[str, Any], base: dict[str, Any] | None) -> dict[str, Any]:
    """The record after a downgrade and back (review F2). *theirs* is what the
    earlier build left in the Keychain item, *base* what this build last put
    there. An entry the earlier build changed or removed takes its value; one
    it did not touch keeps ours — which is how a pin it never saw, because the
    item could not hold it, survives. Blocks and encrypted peers are unions and
    policy sequences maxima: each only ever fails closed. Without a known base,
    pins and owned members are taken whole from theirs, as before."""
    merged = dict(ours)
    for key in ("ownMembers", "pins"):
        mine, other = ours.get(key) or {}, theirs.get(key) or {}
        if base is None:
            merged[key] = dict(other)
            continue
        old = base.get(key) or {}
        result = {}
        for entry in {**mine, **other, **old}:
            side = other if other.get(entry) != old.get(entry) else mine
            if entry in side:
                result[entry] = side[entry]
        merged[key] = result
    seqs = dict(ours.get("policySeqs") or {})
    for device_id, seq in (theirs.get("policySeqs") or {}).items():
        if isinstance(seq, int) and seq > seqs.get(device_id, -1):
            seqs[device_id] = seq
    merged["policySeqs"] = seqs
    for key in ("blocked", "encryptedPeers"):
        union = list(ours.get(key) or [])
        union += [entry for entry in theirs.get(key) or [] if entry not in union]
        merged[key] = union
    return merged


def _write_record_locked(core: str) -> None:
    """Seal *core* into the record file. Raises what the writer raises."""
    durable_secret_files.write(
        _record_path(), trust_file.seal(_record_key, core.encode("utf-8"), trust_file.AAD_RECORD)
    )


def _mirror_locked(core: str) -> None:
    """Keep the Keychain item an earlier build reads current, while it fits
    (plan 797ad7, B3: one release of dual writes, so a downgrade sees the
    pairings and blocks made since the move). Never raises: the file is the
    record, and this copy is only for going back."""
    global _last_mirror
    if core == _last_mirror:
        return
    try:
        if not cloud_secrets.fits(_vault(), SECRET_NAME, core):
            return
        _remember_mirror_locked(core)
        cloud_secrets.write(_vault(), SECRET_NAME, core)
        _last_mirror = core
        marker = _database().kv_get(INITIALISED_KEY)
        if isinstance(marker, dict):
            _database().kv_set(INITIALISED_KEY, {**marker, "mirror": _digest(core)}, now=int(time.time()))
    except Exception as err:  # noqa: BLE001 - a downgrade copy, never a failure
        log.warning("the downgrade copy of the device trust record was not updated (%s)", err)


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _read_mirror() -> str | None:
    try:
        return _vault().read_app_secret(SECRET_NAME)
    except Exception:  # noqa: BLE001 - unknown means "rewrite on the next save"
        return None


def _enter_file_store_locked(marker: Any) -> bool:
    """Move this process onto the sealed file, making the key if there is none.
    False, and the Keychain item stays the record, when that cannot be done."""
    global _store_mode, _record_key
    if not FILE_STORE:
        _store_mode = "keychain"
        return False
    try:
        _record_key = trust_file.key(create=True)
    except Exception as err:  # noqa: BLE001 - stay where the record already is
        log.warning("the device trust record stays in the Keychain for now (%s)", err)
        _store_mode = "keychain"
        return False
    _store_mode = "file"
    return True


def _mark_file_store_locked(marker: Any, mirror: str | None) -> None:
    """Record that the file is the record, and — as ``mirror`` — what the
    Keychain item held when this build last wrote it. An item that no longer
    matches was written by someone else: an earlier build, after a downgrade."""
    base = dict(marker) if isinstance(marker, dict) else {"at": int(time.time())}
    base["store"] = STORE_FILE
    if mirror:
        _remember_mirror_locked(mirror)
        base["mirror"] = _digest(mirror)
    _database().kv_set(INITIALISED_KEY, base, now=int(time.time()))


def _read_journal_bytes(path: Path) -> bytes:
    """The journal's bytes, never through a link. Raises FileNotFoundError when
    there is none, OSError when it cannot be read."""
    return durable_secret_files.read(path)


def _write_journal_bytes(path: Path, data: bytes) -> None:
    """Replace the journal durably: owner-only directory and file, every byte
    written, file and directory fsynced, then an atomic rename — which replaces
    a link at that path rather than writing through it.

    Not ``secret_files.write_private``: that writer is shared with CLI account
    slots and is left exactly as it was, and it writes once without fsync, so
    a power cut could leave an empty journal behind.
    """
    durable_secret_files.write(path, data)


#: Set while the journal exists but cannot be read. No journal is written until
#: a read succeeds: writing then would replace a file that was only momentarily
#: locked with this process's empty view of it.
_journal_blocked = False
#: What is wrong with the journal, for the account view, or "" when nothing is.
_journal_problem = ""


def journal_problem() -> str:
    """Why the journal is not in use as it should be, or "" when it is."""
    return _journal_problem


def _read_journal() -> dict[str, Any] | None:
    """The journal's notices and ledger: {} when there is no journal yet, None
    when there is one that cannot be read right now. Never raises, never locks
    — nothing in it decides trust.

    A journal that reads but is not a journal (bad JSON, wrong shape) is set
    aside under a ``.damaged-<time>`` name rather than overwritten, and reads as
    empty; one that cannot be read at all is left where it is.
    """
    global _journal_blocked, _journal_problem
    path = _journal_path()
    try:
        # A link is not a journal: set aside below like any other non-journal.
        raw = b"" if path.is_symlink() else _read_journal_bytes(path)
    except FileNotFoundError:
        return {}
    except OSError as err:
        if not _journal_blocked:
            log.warning("the device trust journal could not be read; leaving it untouched (%s)", err)
        _journal_blocked = True
        _journal_problem = (
            f"the device trust journal could not be read ({err}); it is left untouched "
            "and not written until it can be — notices and the delivered-message "
            "ledger are kept in memory meanwhile"
        )
        return None
    if raw.startswith(trust_file.MAGIC):
        try:
            key = _record_key if _record_key is not None else trust_file.key(create=False)
        except Exception:  # noqa: BLE001 - read as "cannot be read right now"
            key = None
        if key is None:
            # Not damaged: sealed, and the key is not to hand. Left as it is.
            _journal_blocked = True
            _journal_problem = (
                "the device trust journal is sealed and its key could not be read; it is "
                "left untouched and not written until it can be"
            )
            return None
        try:
            raw = trust_file.unseal(key, raw, trust_file.AAD_JOURNAL)
        except trust_file.SealError:
            raw = b""  # does not open: set aside below, like any non-journal
    doc: Any = None
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        pass
    if not isinstance(doc, dict) or not isinstance(doc.get("notices", []), list) or not isinstance(
        doc.get("seenMessages", {}), dict
    ):
        aside = path.with_name(f"{path.name}.damaged-{int(time.time())}")
        try:
            path.replace(aside)
        except OSError as err:
            log.warning("a damaged device trust journal could not be set aside (%s)", err)
            _journal_blocked = True
            _journal_problem = (
                f"the device trust journal is damaged and could not be set aside ({err}); "
                "it is not written until that is resolved"
            )
            return None
        log.warning("the device trust journal was damaged; set it aside as %s", aside.name)
        _journal_blocked = False
        _journal_problem = (
            f"the device trust journal was damaged and was set aside as {aside.name}; "
            "notices and the delivered-message ledger started over from empty"
        )
        return {}
    if _journal_blocked:
        _journal_blocked = False
        _journal_problem = ""
    journal: dict[str, Any] = {}
    if isinstance(doc.get("notices"), list):
        journal["notices"] = doc["notices"]
    if isinstance(doc.get("seenMessages"), dict):
        journal["seenMessages"] = doc["seenMessages"]
    return journal


def _merge_journal(state: dict[str, Any], journal: dict[str, Any]) -> None:
    """Fold *journal* into *state*, keeping both sides: notices merged by key,
    ledgers merged by message key."""
    if "notices" in journal:
        known = {notice.get("key") for notice in journal["notices"] if isinstance(notice, dict)}
        others = [
            notice for notice in state.get("notices") or []
            if isinstance(notice, dict) and notice.get("key") not in known
        ]
        state["notices"] = sorted(
            others + journal["notices"],
            key=lambda notice: int(notice.get("at") or 0) if isinstance(notice, dict) else 0,
        )
    if "seenMessages" in journal:
        merged = dict(state.get("seenMessages") or {})
        merged.update(journal["seenMessages"])
        state["seenMessages"] = merged


def _adopt_journal(state: dict[str, Any], stored_core: str | None) -> None:
    """Fold the journal into a freshly parsed vault document. Caller holds
    ``_lock``. A vault entry written before the move still carries its own
    notices and ledger; both halves are kept, merged by key, and the vault's
    copy leaves it on the next save.

    ``stored_core`` is the vault item as read, so the first save after a load
    rewrites it only if it changed (R2-5): a flush that rewrote it anyway was
    one Keychain write per restart, and one more way to fail."""
    global _last_core, _last_journal
    journal = _read_journal()
    if journal:
        _merge_journal(state, journal)
    _last_core = stored_core
    _last_journal = None


def _carry_unsaved_blocks_locked(state: dict[str, Any]) -> list[dict[str, str]]:
    """Put back into *state* each block an earlier save could not keep, as far
    as the record has room for it, and return the ones carried. One that still
    does not fit stays in ``_unsaved_blocks`` and changes nothing about this
    save: the save it rides on is somebody else's, and must not fail for it."""
    carried = []
    blocked = state.setdefault("blocked", [])
    for entry in list(_unsaved_blocks):
        if entry in blocked:
            carried.append(entry)
            continue
        blocked.append(dict(entry))
        core = json.dumps(_core_of(state), ensure_ascii=False, separators=(",", ":"))
        if _store_mode == "file" or cloud_secrets.fits(_vault(), SECRET_NAME, core):
            carried.append(entry)
        else:
            blocked.pop()
    return carried


def _write(state: dict[str, Any]) -> None:
    global _last_core, _committed_core
    carried = _carry_unsaved_blocks_locked(state)
    # One line, always: `cloud_secrets.write` refuses a multi-line payload outright,
    # and a payload that got past it truncated at the first newline would leave
    # a state document that parses as far as "{" and locks this machine out.
    core = json.dumps(_core_of(state), ensure_ascii=False, separators=(",", ":"))
    try:
        if _store_mode == "file":
            if core != _last_core:
                _write_record_locked(core)
                _last_core = core
            _mirror_locked(core)
        elif core != _last_core:
            cloud_secrets.write(_vault(), SECRET_NAME, core)
            _last_core = core
        _committed_core = json.loads(core)
        # Saved now, so no longer only in memory.
        _unsaved_blocks[:] = [entry for entry in _unsaved_blocks if entry not in carried]
    finally:
        # The journal is written even when the vault half was refused (R2-5):
        # the ledger and notices do not depend on it, and a refused Keychain
        # write used to cost them as well.
        _write_journal_locked(state)


def _write_journal_locked(state: dict[str, Any]) -> None:
    global _last_journal
    if _journal_blocked:
        # Try again rather than overwrite: a read that succeeds now brings back
        # what was on disk, merged with what this process recorded meanwhile.
        recovered = _read_journal()
        if recovered is None:
            return
        _merge_journal(state, recovered)
    journal = json.dumps(
        {"v": STATE_VERSION, **{key: state.get(key) for key in _JOURNAL_KEYS}},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    if journal != _last_journal:
        data = journal.encode("utf-8")
        if _store_mode == "file" and _record_key is not None:
            # Sealed with the record's key (plan 797ad7, Q3): the ledger decides
            # which messages are replays, so an edit on disk must not pass.
            data = trust_file.seal(_record_key, data, trust_file.AAD_JOURNAL)
        try:
            _write_journal_bytes(_journal_path(), data)
        except OSError as err:
            # The vault half — the part that decides trust — is saved apart from this.
            log.warning("the device trust journal could not be saved (%s)", err)
            return
        _last_journal = journal


def _load_locked() -> dict[str, Any]:
    """Read the state, or raise. Caller holds ``_lock``.

    Two kinds of failure, and they are not the same kind of thing:

    *The record is there and does not parse* — latched. Reading it again returns
    the same bytes, so retrying is only a slower way to reach the same answer,
    and the stability is the point: this is the state a person has to be told
    about and decide on.

    *The record could not be read at all* — retried, up to
    ``TRANSIENT_RETRY_LIMIT``. None of the things that land here is a statement
    about the record, and latching on the first meant one mis-clicked dialog
    pinned the process until it restarted — with the only exit on that screen
    being one that erases a record nothing was ever wrong with.
    """
    global _state, _transient_reason, _transient_failures
    global _store_mode, _last_core, _last_mirror
    if _state is not None:
        return _state
    if _locked_reason:
        raise TrustStoreLocked(_locked_reason)

    database = _database()
    marker = database.kv_get(INITIALISED_KEY)
    if isinstance(marker, dict) and marker.get("store") == STORE_FILE:
        return _load_file_locked(marker)
    try:
        raw = _vault().read_app_secret(SECRET_NAME)
    except Exception as err:  # noqa: BLE001 - a vault that will not answer is a lock
        if marker is not None:
            _note_unreadable_locked(err)
        raw = None
    _transient_failures = 0
    _transient_reason = ""
    parsed = _parse(raw)

    if marker is not None:
        salvaged: list[str] = []
        if parsed is None and raw:
            parsed = _salvage(raw)
            salvaged = list((parsed or {}).get("pins") or {})
        if parsed is None:
            _refuse_unparsed_locked(raw, marker)
        _adopt_journal(parsed, raw)
        for device_id in salvaged:
            _record_locked(parsed, NOTICE_PAIRING, device_id=device_id, detail={"pairing": "salvaged"})
        _remember_committed(parsed)
        _state = parsed
        _store_mode = "keychain"
        # A record from before the move: into the sealed file now, and the
        # Keychain item stays as the downgrade copy (see _mirror_locked).
        if _enter_file_store_locked(marker):
            core = json.dumps(_core_of(parsed), ensure_ascii=False, separators=(",", ":"))
            try:
                _write_record_locked(core)
                _mark_file_store_locked(marker, raw)
            except Exception as err:  # noqa: BLE001 - stays in the Keychain, tries again
                log.warning("the device trust record could not move into its file yet (%s)", err)
                _store_mode = "keychain"
            else:
                _last_core = core
                _last_mirror = raw
                # Notices and the ledger an older record still carried are now
                # only in memory: the file holds the core alone.
                _write_journal_locked(parsed)
        return _state

    # No marker: a first start. An existing, readable document is adopted rather
    # than replaced — the marker is written after the document, so a crash
    # between the two lands here, and starting over would throw away real pins
    # for a reason nobody would ever see.
    if raw and parsed is None:
        log.warning(
            "a device trust document exists but is unreadable and this machine was "
            "never marked initialised; starting a new one"
        )
    _state = parsed if parsed is not None else _blank()
    # Read even for a blank start: the journal outlives the record, and writing
    # the blank state without reading it first replaced it with nothing.
    _adopt_journal(_state, raw if parsed is not None else None)
    in_file = _enter_file_store_locked(None)
    if in_file:
        _last_core = None
        _last_mirror = raw if parsed is not None else None
    _write(_state)
    marker = {
        # See the module note: this is read back into the lock message so the
        # person looking at a stopped link is told what created the record
        # rather than having to remember. It decides nothing.
        "at": int(time.time()), "by": Path(sys.argv[0] or "?").name,
    }
    if in_file:
        marker["store"] = STORE_FILE
        if _last_mirror:
            _remember_mirror_locked(_last_mirror)
            marker["mirror"] = _digest(_last_mirror)
    database.kv_set(INITIALISED_KEY, marker, now=int(time.time()))
    return _state


def _load_file_locked(marker: dict[str, Any]) -> dict[str, Any]:
    """Read the sealed record. Caller holds ``_lock``. The same two kinds of
    failure as the Keychain item: a key or file that could not be read at all
    is retried; one that is missing, or does not open, is latched."""
    global _state, _locked_reason, _damaged, _transient_reason, _transient_failures
    global _store_mode, _record_key, _last_mirror
    path = _record_path()
    try:
        key = trust_file.key(create=False)
        blob = None if key is None or path.is_symlink() else durable_secret_files.read(path)
    except FileNotFoundError:
        key, blob = key, None
    except trust_file.SealError:
        key, blob = None, None
    except Exception as err:  # noqa: BLE001 - the same as a Keychain that will not answer
        _note_unreadable_locked(err)
    _transient_failures = 0
    _transient_reason = ""
    if key is None:
        _damaged = True
        _locked_reason = (
            "the key that opens this machine's cross-device pairing record is missing, "
            "so none of the record can be read. Pair your devices again — start over "
            "here, then pair each other device from both ends"
            + _provenance(marker)
        )
        raise TrustStoreLocked(_locked_reason)
    if blob is None:
        _refuse_unparsed_locked(None, marker)
    try:
        raw = trust_file.unseal(key, blob, trust_file.AAD_RECORD).decode("utf-8")
    except (trust_file.SealError, UnicodeDecodeError):
        _damaged = True
        _locked_reason = (
            "the cross-device pairing record on this machine is damaged: it does not "
            "open with its key, so none of it can be trusted. Pair your devices again "
            "— start over here, then pair each other device from both ends"
            + _provenance(marker)
        )
        raise TrustStoreLocked(_locked_reason) from None
    parsed = _parse(raw)
    if parsed is None:
        _refuse_unparsed_locked(raw, marker)
    _store_mode = "file"
    _record_key = key
    mirror = _read_mirror()
    _last_mirror = mirror
    returned = _parse(mirror) if mirror and marker.get("mirror") not in (None, _digest(mirror)) else None
    if returned is not None:
        # The Keychain item changed since this build last wrote it, so an
        # earlier build has been running on it — a downgrade and back. What it
        # decided there is newer than the file, but it could only decide on
        # what fit in the item: merge, against what this build last put there.
        base = _read_mirror_base(marker.get("mirror"))
        log.warning(
            "the device trust record was changed by an earlier build; merging its copy%s",
            "" if base is not None else " (no common ancestor: its pins are taken whole)",
        )
        merged = _merge_returned(_core_of(parsed), _core_of(returned), base)
        core = json.dumps(merged, ensure_ascii=False, separators=(",", ":"))
        _write_record_locked(core)
        _mark_file_store_locked(_database().kv_get(INITIALISED_KEY), mirror)
        parsed, raw = merged, core
    _adopt_journal(parsed, raw)
    _remember_committed(parsed)
    _state = parsed
    return _state


def _salvage(raw: str) -> dict[str, Any] | None:
    """What can be trusted in a record cut off mid-write (plan 797ad7, Q2), or
    None when the cut makes it no safer to read than main would (review F1).

    ``security -i`` stored the first 4095 bytes of a write that was too long.
    The record's fields are written in order — owned members, pins, policy
    sequences, blocks, encrypted peers, then the ledger and the notices — and
    the cut usually lands in those last two, which decide nothing. So every
    field that decides trust must have been written whole: a pin kept without
    the block written after it would trust a blocked device again. Then the
    record is taken as it was, its pins going back to ``approved: False`` — the
    default-deny rules — until a person approves them again. A cut anywhere
    before that locks the record as damaged, exactly as main does.
    """
    decoder = json.JSONDecoder()
    head = '{"v":%d,' % STATE_VERSION
    if not raw.startswith(head):
        return None
    whole: dict[str, Any] = {}
    pos = len(head)
    while pos < len(raw):
        try:
            key, pos = decoder.raw_decode(raw, pos)
            if not isinstance(key, str) or raw[pos] != ":":
                break
            value, pos = decoder.raw_decode(raw, pos + 1)
        except (ValueError, IndexError):
            break
        whole[key] = value
        if pos < len(raw) and raw[pos] == ",":
            pos += 1
        else:
            break
    state = _blank()
    for key in ("ownMembers", "pins", "policySeqs", "blocked", "encryptedPeers"):
        if key not in whole or not isinstance(whole[key], type(state[key])):
            return None
        state[key] = whole[key]
    for key in _JOURNAL_KEYS:
        if isinstance(whole.get(key), type(state[key])):
            state[key] = whole[key]
    pins = {
        device_id: {**pin, "approved": False}
        for device_id, pin in state["pins"].items()
        if isinstance(pin, dict) and isinstance(pin.get("signKey"), str) and pin.get("signKey")
    }
    if not pins:
        return None
    state["pins"] = pins
    return state


def _note_unreadable_locked(err: Exception) -> None:
    """A store that could not be read at all: retried, not latched at first. A
    locked keychain, a dismissed authorisation dialog and a `security` timeout
    all land here, and none of them says anything about the record — while
    latching sent the person to the one screen that offers to erase it."""
    global _locked_reason, _transient_reason, _transient_failures
    _transient_failures += 1
    reason = f"the device trust store could not be read ({err})"
    if _transient_failures >= TRANSIENT_RETRY_LIMIT:
        _transient_reason = ""
        _locked_reason = reason
    else:
        _transient_reason = reason
    raise TrustStoreLocked(reason) from err


def _refuse_unparsed_locked(raw: str | None, marker: Any) -> None:
    """Latch the lock for a record that is there and is not a record."""
    global _locked_reason, _damaged
    if raw:
        # Only a record that is not JSON at all is "cut off": a whole record
        # of another version or shape may be perfectly good, and telling
        # its owner to pair again would have them erase it.
        try:
            whole = json.loads(raw)
        except ValueError:
            whole = _NOT_JSON
        if whole is _NOT_JSON:
            _damaged = True
            _locked_reason = (
                "the cross-device pairing record on this machine is damaged: it was "
                f"saved incomplete ({len(raw.encode('utf-8'))} bytes that do not parse), "
                "so none of it can be trusted. Pair your devices again — start over "
                "here, then pair each other device from both ends"
                + _provenance(marker)
            )
        elif isinstance(whole, dict) and whole.get("v") != STATE_VERSION:
            _locked_reason = (
                "the cross-device trust record on this machine was written by a "
                f"different version of Navide (record version {whole.get('v')!r}, this "
                f"build reads {STATE_VERSION}). It is left as it is: run the version "
                "that wrote it rather than starting over"
                + _provenance(marker)
            )
        else:
            _locked_reason = (
                "the cross-device trust record on this machine is complete but not in "
                "the shape this build expects. It is left as it is; do not start over "
                "until it is clear why"
                + _provenance(marker)
            )
        raise TrustStoreLocked(_locked_reason)
    _locked_reason = (
        "this machine has a cross-device trust record but its contents are "
        "missing or unreadable"
        + _provenance(marker)
    )
    raise TrustStoreLocked(_locked_reason)


def _provenance(marker: Any) -> str:
    """Where the lock came from, as a clause to append to the reason.

    Deliberately just a statement of what was recorded. It does not suggest an
    action and nothing branches on it: a marker written by a test is exactly as
    locking as one written by the app, because a program name is not evidence
    about whether pins were lost.
    """
    if not isinstance(marker, dict):
        return ""
    by = str(marker.get("by") or "")
    at = marker.get("at")
    when = ""
    if isinstance(at, int) and not isinstance(at, bool):
        when = time.strftime(" on %Y-%m-%d at %H:%M", time.localtime(at))
    if not by and not when:
        return ""
    return f" (the record was created by {by or 'an unknown program'}{when})"


def load() -> dict[str, Any]:
    """The state document. Blocking (Keychain); call off the event loop."""
    with _lock:
        return dict(_load_locked())


def transient_lock() -> bool:
    """Whether the current refusal is a read that may succeed next time.

    What it gates is the offer to start over: that erases every pairing, and on
    a keychain that was locked for a moment there is nothing wrong to erase. The
    surface reports the same stop either way; only the button waits.
    """
    with _lock:
        return bool(_transient_reason) and not _locked_reason


_NOT_JSON = object()


def damaged() -> bool:
    """Whether the lock in force is a record that exists but is cut off."""
    return bool(_locked_reason) and _damaged


def locked_reason() -> str:
    """Why cross-device traffic must be refused, or "" when all is well.

    Never raises: every caller of this is deciding what to tell somebody, and a
    status read that could itself fail would leave them with nothing to say.
    """
    with _lock:
        if _state is not None:
            return ""
        try:
            _load_locked()
        except TrustStoreLocked as err:
            return str(err)
        except Exception as err:  # noqa: BLE001
            return f"the device trust store could not be opened ({err})"
        return ""


def _save_locked(state: dict[str, Any]) -> None:
    """Save after a decision. Caller holds ``_lock``.

    A save that fails takes the decision back out of memory too: every caller
    changed the cached state first, and a change left there was acted on until
    the next restart — a pairing reported as failed was still trusted, a block
    held only until the restart, a policy sequence could go backwards. Only the
    vault half is rolled back; notices and the ledger stay, as they would after
    a record-only save that failed.
    """
    try:
        # Checked before anything is written, so a change that cannot be stored
        # is refused as what it is — the record is full — rather than as a
        # Keychain error after the fact.
        core = json.dumps(_core_of(state), ensure_ascii=False, separators=(",", ":"))
        if _store_mode != "file" and not cloud_secrets.fits(_vault(), SECRET_NAME, core):
            raise TrustStoreFull(_FULL_MESSAGE)
        _write(state)
    except Exception:
        if _committed_core is not None:
            for key in [key for key in state if key not in _JOURNAL_KEYS]:
                del state[key]
            state.update(copy.deepcopy(_committed_core))
        raise


def _fits_with_reserve_locked(state: dict[str, Any]) -> bool:
    """Whether the vault half fits with room left for what every pinned device
    may still add — an encrypted-peer entry, a long policy sequence and a block
    — plus one more block (KC2R-1). Checked when a pin is taken, so a full
    record refuses the next pairing rather than a later decision about a device
    already paired. A block keeps the pin (main's behaviour, kept on purpose),
    so its room is reserved here rather than freed by the block. A sealed file
    has no line to fit in."""
    if _store_mode == "file":
        return True
    worst = copy.deepcopy(_core_of(state))
    peers = worst.setdefault("encryptedPeers", [])
    seqs = worst.setdefault("policySeqs", {})
    blocked = worst.setdefault("blocked", [])
    for device_id, pin in list(worst.get("pins", {}).items()) + [(_OWN_DEVICE_PLACEHOLDER, {})]:
        if device_id not in peers:
            peers.append(device_id)
        seqs[device_id] = max(int(seqs.get(device_id) or 0), _RESERVED_SEQ)
        member_id = pin.get("memberId", "") if isinstance(pin, dict) else ""
        blocked.append({"deviceId": device_id, "memberId": member_id or "m-" + "0" * 32})
    core = json.dumps(worst, ensure_ascii=False, separators=(",", ":"))
    return cloud_secrets.fits(_vault(), SECRET_NAME, core)


def _save_record_locked(state: dict[str, Any], what: str) -> None:
    """Save after a write that only *records* something. Caller holds ``_lock``.

    Logged, never raised: these run on the delivery path, and a save that
    failed used to fail the message it was recording — every relayed message
    was acked failed once the record outgrew the Keychain. The change stays in
    the in-memory state, so this process still acts on it.
    """
    try:
        _write(state)
    except Exception as err:  # noqa: BLE001
        log.warning("the device trust record could not be saved after %s; kept in memory only (%s)", what, err)


def _state_for_read() -> dict[str, Any]:
    """The state, for every public read. Caller holds ``_lock``.

    Exists because four separate readers each answered from an empty cache, and
    each of those answers was the permissive one: no pin, no downgrade rule, no
    notices, sequence zero. The writes had always loaded; only the reads had
    not, so every durable guarantee in this module was conditional on the order
    in which the process happened to warm up. Two of them reopened a CRITICAL
    that way — `pin_for` gave the relay back key substitution (C1), `policy_seq`
    gave it back policy rollback (C2).

    Fixing them one at a time would have left the fifth reader to be written
    wrong later, so the cache is no longer reachable from a read: there is one
    door and it loads. A new reader gets a loaded state without having to know
    that it must.
    """
    return _load_locked() if _state is None else _state


def _try_load() -> dict[str, Any] | None:
    """The state, or None when it cannot be had. Caller holds ``_lock``.

    For the writes that only *record* something. Those run on paths that are
    already refusing a message, and a raise from one of them would turn a
    refusal — which is the intended outcome — into a dropped connection, which
    is not. The writes that decide something (pins, sequences, the
    no-downgrade list) still raise, because carrying on without them is what
    this module exists to prevent.
    """
    try:
        return _load_locked()
    except Exception:  # noqa: BLE001
        return None


# ---- this account's own member id --------------------------------------------


def _token_fingerprint(url: str, token: str) -> str:
    """Which account a credential names, as far as this machine is concerned.

    The address is part of it, not just the token: the same string presented to
    a different server is a different account, and treating the two as one would
    make an ordinary second deployment look like a server changing its mind.
    Both halves are chosen by this machine, never by the far side.
    """
    import hashlib

    return hashlib.sha256(f"{url}\x00{token}".encode("utf-8")).hexdigest()[:32]


def member_for_credential(url: str, token: str) -> str:
    """The member this credential was last seen to belong to, or "".

    A read-only peek at what ``adopt_own_member`` pinned, for the one caller
    that needs the answer *before* ``auth.hello`` can give it: the link has to
    choose which node id to present, and that choice is per member. Never
    raises — a store that cannot be read simply has no hint, and the link falls
    back to the id it has always presented.
    """
    if not url or not token:
        return ""
    try:
        with _lock:
            state = _load_locked()
            return str(state["ownMembers"].get(_token_fingerprint(url, token)) or "")
    except Exception:  # noqa: BLE001 - a hint that cannot be read is just absent
        return ""


def only_credential_ever(url: str, token: str) -> bool:
    """Whether this credential is the only one this machine has ever pinned a
    member for — so anything on this machine that predates accounts being
    told apart can only belong to it.

    Both halves matter: the fingerprint is over the address and the token, so
    "one entry, and it is this one" establishes the server as well as the
    member. A machine with two entries — a second sign-in, a second server —
    answers no even when both name the same member, because the entries do
    not say which server each was for. Never raises.
    """
    if not url or not token:
        return False
    try:
        with _lock:
            owners = _load_locked()["ownMembers"]
    except Exception:  # noqa: BLE001 - unreadable is not evidence
        return False
    return set(owners) == {_token_fingerprint(url, token)}


def adopt_own_member(url: str, token: str, member_id: str) -> str:
    """Pin the member id this credential belongs to, and return the pinned one.

    ``auth.hello`` answers with a member id, and until now that answer *was*
    this machine's identity — so a relay could name any id it liked and then
    send messages "from" it, which the delivery path read as one of the user's
    own machines. Pinning it per credential closes that: the same token may
    only ever mean the same member.

    Keyed on the credential rather than stored flat because signing in with a
    different account is an ordinary thing to do and must not read as an attack.
    A *different* id under the *same* credential is not ordinary, and raises.
    """
    with _lock:
        state = _load_locked()
        owners = state["ownMembers"]
        fingerprint = _token_fingerprint(url, token)
        pinned = str(owners.get(fingerprint) or "")
        if pinned:
            if pinned != member_id:
                _record_locked(
                    state,
                    NOTICE_MEMBER_CHANGED,
                    device_id="",
                    detail={"pinned": pinned, "offered": member_id},
                )
                _save_locked(state)
                raise TrustStoreLocked(
                    "the server answered this credential with a different member id "
                    f"than the one pinned here ({pinned})"
                )
            return pinned
        owners[fingerprint] = member_id
        _save_locked(state)
        return member_id


# ---- device pins -------------------------------------------------------------


def pin_for(device_id: str) -> dict[str, Any] | None:
    """The pinned key and member for *device_id*.

    **Raises ``TrustStoreLocked`` when the record cannot be read, and the
    precondition belongs to the caller.** This said "never raises" for a while,
    on the strength of one caller: the delivery path checks the lock before it
    gets here, so for that path the sentence was true. It was read as a property
    of this function, and the second caller — the device-list snapshot — was
    written against it and took the whole handler down with it the first time a
    machine's record went unreadable.

    Kept raising rather than made total, deliberately. The delivery path's
    precondition is real and worth keeping: "the store is locked, so stop
    delivering" is a stronger guarantee expressed as an exception than as a
    return value somebody can forget to check. What was wrong was the docstring
    claiming the guarantee for everyone.
    """
    with _lock:
        if not device_id:
            return None
        # Load rather than answer from an empty cache. Returning None here means
        # "never seen this device", and the caller answers that by trusting the
        # key the relay advertises — so a cold cache silently handed the relay
        # back the substitution that pinning exists to stop, for as long as it
        # took something else to touch the store. The writes have always loaded;
        # only the reads did not, which made the durable half of TOFU
        # conditional on the order in which the process happened to warm up.
        pin = (_state_for_read().get("pins") or {}).get(device_id)
        return dict(pin) if isinstance(pin, dict) else None


def pin_device(
    device_id: str, *, sign_key: str, member_id: str, own_member_id: str = ""
) -> dict[str, Any]:
    """Take a first pin for *device_id*. Blocking; call off the event loop.

    Only ever called after the message actually verified against *sign_key*, so
    the relay cannot fill this map with keys nobody can sign for. That is a
    smaller guarantee than it sounds — the relay can generate a keypair and sign
    with it — and it is why a first sighting is surfaced rather than silent.
    """
    with _lock:
        state = _load_locked()
        pins = state["pins"]
        existing = pins.get(device_id)
        if isinstance(existing, dict):
            return dict(existing)
        if len(pins) >= MAX_DEVICES:
            raise TrustStoreFull(f"this machine already pins {len(pins)} devices")
        pin = {
            "signKey": sign_key,
            "memberId": member_id,
            "at": int(time.time()),
            # Taken, but not yet vouched for. Pinning settles *which* key this
            # device id may use from here on; it does not settle whether the
            # machine behind it is the one the person has in mind. The member
            # id above arrived in the message, which the relay writes, so a
            # relay that names a device nobody has seen, signs with a key it
            # just generated, and fills in this account's own member id would
            # otherwise land in the own-device ring, the one ring that consults
            # no rules at all. Approval is what a person adds to that, by
            # comparing the fingerprint in the notice against the other machine.
            "approved": False,
        }
        pins[device_id] = pin
        if not _fits_with_reserve_locked(state):
            del pins[device_id]
            raise TrustStoreFull(_FULL_MESSAGE)
        _record_locked(
            state,
            NOTICE_FIRST_SEEN,
            device_id=device_id,
            detail={
                "memberId": member_id,
                "fingerprint": device_signing.fingerprint(sign_key),
                # Whether this pin puts the device in the own-device ring, which
                # consults no rules at all. That makes it the one first sighting
                # a person has to actually look at, so it is stated rather than
                # left to be worked out from the member id.
                "own": bool(member_id) and member_id == own_member_id,
            },
        )
        _save_locked(state)
        return dict(pin)


def approve_device(device_id: str) -> bool:
    """Vouch for a pinned device: this really is the machine it claims to be.

    Blocking; call off the event loop. Returns whether anything changed, so a
    second approval is not an error and does not re-announce.

    Only the *approval* is recorded here. The pinned key is untouched, and
    approving cannot revise it: that is still one attempt per device id. What
    approval releases is the own-device ring, which skips the pane policy. An
    unapproved device is not refused, it is merely held to the same rules as
    everyone else, and those deny by default.
    """
    with _lock:
        if not device_id:
            return False
        state = _load_locked()
        pin = state["pins"].get(device_id)
        if not isinstance(pin, dict) or pin.get("approved") is True:
            return False
        pin["approved"] = True
        _save_locked(state)
        return True


#: Blocks that could not be saved, held for the life of the process so this
#: machine refuses the device anyway. See ``note_blocked``.
_unsaved_blocks: list[dict[str, str]] = []


def note_blocked(device_id: str, member_id: str) -> bool:
    """Keep a local copy of a block. Blocking; call off the event loop.

    The policy on the server stays the enforcement record; this is the copy that
    is still here when that document cannot be read. Returns whether anything
    changed, so a repeat block is not an error.
    """
    with _lock:
        device_id = str(device_id or "")
        member_id = str(member_id or "")
        if not device_id and not member_id:
            return False
        try:
            state = _load_locked()
            blocked = state.setdefault("blocked", [])
            for entry in blocked:
                if not isinstance(entry, dict):
                    continue
                if device_id and entry.get("deviceId") == device_id:
                    return False
                if member_id and not device_id and entry.get("memberId") == member_id:
                    return False
            blocked.append({"deviceId": device_id, "memberId": member_id})
            _save_locked(state)
        except Exception:
            # Fail closed: a block that could not be saved — or whose record
            # could not even be read (review F1) — still holds until the
            # restart, and the next save that succeeds writes it. _save_locked
            # took it back out of the state, as it does every decision it could
            # not store, and for a block that is the unsafe direction.
            _unsaved_blocks.append({"deviceId": device_id, "memberId": member_id})
            raise
        return True


def note_unblocked(device_id: str, member_id: str) -> bool:
    """Drop a local block. Blocking; call off the event loop.

    Lifting is a decision too, and it has to reach the same place the block did
    — otherwise a device unblocked in the policy would stay refused here for
    ever, with nothing on screen to explain it.
    """
    with _lock:
        device_id = str(device_id or "")
        member_id = str(member_id or "")

        def lifted(entry: Any) -> bool:
            return isinstance(entry, dict) and bool(
                (device_id and entry.get("deviceId") == device_id)
                or (member_id and entry.get("memberId") == member_id)
            )

        unsaved = len(_unsaved_blocks)
        _unsaved_blocks[:] = [entry for entry in _unsaved_blocks if not lifted(entry)]
        state = _load_locked()
        blocked = state.setdefault("blocked", [])
        kept = [entry for entry in blocked if not lifted(entry)]
        if len(kept) == len(blocked):
            return len(_unsaved_blocks) != unsaved
        state["blocked"] = kept
        _save_locked(state)
        return True


def is_blocked_locally(*, device_id: str, member_id: str) -> bool:
    """Whether this machine's own copy names this sender.

    Never raises; this sits on the delivery path. An unreadable store is not
    read as "nothing is blocked": ``locked_reason`` already stops all
    cross-device traffic in that state, so the safe answer here is the one that
    refuses, and the caller reaching this at all means the store opened.
    """
    try:
        with _lock:
            state = _try_load() if _state is None else _state
            for entry in [*((state or {}).get("blocked") or []), *_unsaved_blocks]:
                if not isinstance(entry, dict):
                    continue
                if entry.get("deviceId") and entry["deviceId"] == device_id:
                    return True
                if entry.get("memberId") and entry["memberId"] == member_id:
                    return True
    except Exception:  # noqa: BLE001 - a delivery decision, never a crash
        log.exception("could not read the local block list")
    return False


def defer_device(device_id: str) -> bool:
    """Stop asking about a pinned device until it knocks again.

    Blocking; call off the event loop. Returns whether anything changed.

    Deliberately *not* a decision. Approving and blocking both answer the
    question and are recorded where the answer is enforced — the pin and the
    policy. This records only that a person looked and moved on, so the pin is
    left exactly as it was: still pinned, still unapproved, still held to the
    ordinary rules, which deny by default. What it buys is that the panel
    stops presenting an open question as if it were new every three seconds.

    It is cleared by ``note_knock``, so the row comes back the moment that
    device actually tries to reach this one. A dismissal that survived the next
    attempt would be a way to silence a machine without ever deciding about it.
    """
    with _lock:
        if not device_id:
            return False
        state = _load_locked()
        pin = state["pins"].get(device_id)
        if not isinstance(pin, dict) or pin.get("approved") is True:
            return False
        if pin.get("dismissedAt"):
            return False
        pin["dismissedAt"] = int(time.time())
        _save_locked(state)
        return True


def note_knock(device_id: str) -> bool:
    """A message from *device_id* just verified. Undo any "not now".

    Blocking; call off the event loop. Returns whether anything changed, so the
    caller only re-announces when a row is actually coming back.

    Called on every verified message rather than only on the first, because
    "not now" is scoped to the attempts a person has already seen. An approved
    device has nothing to undo and is left alone.
    """
    with _lock:
        if not device_id:
            return False
        state = _load_locked()
        pin = state["pins"].get(device_id)
        if not isinstance(pin, dict) or not pin.get("dismissedAt"):
            return False
        pin.pop("dismissedAt", None)
        _save_locked(state)
        return True


def pin_paired_device(
    device_id: str,
    *,
    sign_key: str,
    enc_key: str,
    member_id: str,
    own_member_id: str = "",
) -> bool:
    """Write the pin a completed pairing earns. Blocking; call off the loop.

    **The only place a pin is written.** It used to have company: a message
    arriving from an unknown device took one (whoever spoke first got the key
    slot), and a button in the device list took one from whatever key the
    directory advertised. Both are gone, so "which key does this machine trust
    for that device, and who decided" has one answer and one moment.

    The key comes from the pairing frames rather than from the directory,
    because the directory is the relay's word and the six digits two people
    compared are what checked it. An existing pin is never revised: one attempt
    per device id still holds, and a device whose key later changes becomes
    unreachable rather than impersonable.

    ``enc_key`` is the X25519 encryption key the same six digits covered. It is
    pinned next to the signing key so that "who may open what this machine
    seals for that device" is decided here too, and never by the directory. A
    pin written before this field existed stays as it is — never revised, like
    the signing key — and a reader that needs the encryption key treats its
    absence as "not pinned", not as "ask the directory".

    Returns whether anything changed.
    """
    with _lock:
        if not device_id or not sign_key or not enc_key:
            return False
        state = _load_locked()
        pins = state["pins"]
        existing = pins.get(device_id)
        if isinstance(existing, dict):
            if existing.get("approved") is True:
                return False
            existing["approved"] = True
            _save_locked(state)
            return True
        if len(pins) >= MAX_DEVICES:
            raise TrustStoreFull(f"this machine already pins {len(pins)} devices")
        pins[device_id] = {
            "signKey": sign_key,
            "encKey": enc_key,
            "memberId": member_id,
            "at": int(time.time()),
            # Approved in the same breath: the approval *is* the pairing, and a
            # pin left unapproved here would be a state nobody asked for.
            "approved": True,
        }
        if not _fits_with_reserve_locked(state):
            del pins[device_id]
            raise TrustStoreFull(_FULL_MESSAGE)
        _save_locked(state)
        # After the save, not before: a pairing that could not be stored is
        # rolled back, and a "paired" notice recorded first outlived it (R2-3).
        _record_locked(
            state,
            NOTICE_FIRST_SEEN,
            device_id=device_id,
            detail={
                "memberId": member_id,
                "fingerprint": device_signing.fingerprint(sign_key),
                "ownMember": bool(own_member_id and member_id == own_member_id),
                "paired": True,
            },
        )
        _save_record_locked(state, "a pairing")
        return True


def note_signs_v2(device_id: str) -> bool:
    """Record that *device_id* has sent a message whose v2 signature verified
    (plan 797ad7, B4). From then on its messages without one are refused, the
    same no-going-back rule as ``encryptedPeers``. Returns whether anything
    changed. Blocking; call off the event loop."""
    with _lock:
        state = _load_locked()
        pin = state["pins"].get(device_id)
        if not isinstance(pin, dict) or pin.get("sigV2") is True:
            return False
        pin["sigV2"] = True
        _save_locked(state)
        return True


def _note_device_once(device_id: str, pairing: str, what: str) -> None:
    """One device-pairing notice *pairing* per device, recorded the first time
    only. Never raises: these are notices, never a failed delivery."""
    try:
        with _lock:
            state = _load_locked()
            for notice in state.get("notices") or []:
                if (
                    isinstance(notice, dict) and notice.get("kind") == NOTICE_PAIRING
                    and notice.get("pairing") == pairing and notice.get("deviceId") == device_id
                ):
                    return
            _record_locked(state, NOTICE_PAIRING, device_id=device_id, detail={"pairing": pairing})
            _save_record_locked(state, what)
    except Exception as err:  # noqa: BLE001 - a notice, never a failed delivery
        log.warning("could not record %s from %s (%s)", what, device_id, err)


def note_sig2_missing(device_id: str) -> None:
    """A device that signs v2 sent a message without it (plan 797ad7, B4):
    taken in 0.2.20, but something on the way dropped the time signature — a
    server without sig2, or a relay removing it."""
    _note_device_once(device_id, "sig2-missing", "a missing v2 signature")


def note_sig2_unusable(device_id: str) -> None:
    """A message's v2 signature did not verify, or its send time was outside
    the window (review B4-1): decided on v1 in 0.2.20. Usually one of the two
    machines' clocks is off."""
    _note_device_once(device_id, "sig2-unusable", "an unusable v2 signature")


def pinned_encryption_key(device_id: str) -> str:
    """The X25519 key a completed pairing pinned for *device_id*, or "".

    Empty for a device that is not pinned *and* for one pinned before the
    encryption key was part of the exchange. Both read the same to a caller
    about to seal something, on purpose: the alternative — falling back to the
    directory for the older pin — is the substitution the pin exists to stop,
    and a legacy pin is fixed by pairing again, not by trusting the relay once
    more. Raises ``TrustStoreLocked`` like ``pin_for``.
    """
    pin = pin_for(device_id)
    if not isinstance(pin, dict):
        return ""
    return str(pin.get("encKey") or "")


def legacy_pinned_devices() -> list[str]:
    """Devices whose pin predates the encryption key being part of the
    exchange. Nothing is sealed to such a pin; the route back is to unpair
    the device and pair again. Raises ``TrustStoreLocked`` like ``pin_for``.
    """
    with _lock:
        pins = _state_for_read().get("pins") or {}
        return sorted(
            device_id
            for device_id, pin in pins.items()
            if isinstance(pin, dict) and not pin.get("encKey")
        )


def unapproved_devices() -> list[dict[str, Any]]:
    """Pinned devices still waiting for someone to vouch for them.

    Never raises; this feeds a panel. Kept separate from ``notices`` on purpose:
    a first-sighting notice can be dismissed, and dismissing it must not be able
    to hide a device that is still pending. The notice records an event; this
    records a state nobody has resolved yet.

    A pin written before approval existed carries no ``approved`` key and is
    reported here rather than grandfathered. Reading a missing field as "yes"
    would hand every device pinned under the old rule the very ring this
    function exists to gate, including one that was an impostor all along.
    """
    with _lock:
        state = _try_load() if _state is None else _state
        pins = (state or {}).get("pins") or {}
        out: list[dict[str, Any]] = []
        for device_id, pin in pins.items():
            if not isinstance(pin, dict) or pin.get("approved") is True:
                continue
            out.append(
                {
                    "deviceId": device_id,
                    "memberId": str(pin.get("memberId") or ""),
                    "at": pin.get("at"),
                    "fingerprint": device_signing.fingerprint(str(pin.get("signKey") or "")),
                    # When somebody said "not now". The question is still open —
                    # that is why the row is still here — but the panel stops
                    # asking it until the device knocks again.
                    "dismissedAt": pin.get("dismissedAt"),
                }
            )
        out.sort(key=lambda row: (row.get("at") or 0))
        return out


def forget_device(device_id: str) -> dict[str, Any]:
    """Undo a pairing: forget what this machine decided about *device_id*.

    Blocking; call off the event loop. Returns how many entries went, per
    category, plus whether anything was there at all — so "unpaired" and "there
    was nothing here to unpair" are different answers. A call that always
    reported success would make a mistyped device id look like a completed act.

    Four things go, and one deliberately stays.

    *The pin*, which is the pairing itself. Without it the next message from
    that device is a first sighting again: pinned anew, unapproved, announced.
    That is the point — everything approval released is gone, and getting it
    back costs a person another fingerprint comparison.

    *Its notices.* Leaving them would leave the panel asking about a device this
    machine no longer knows, and a "compare these two fingerprints" notice whose
    pinned key has been dropped cannot be acted on any more.

    *Not* its place in the encrypted-peers list either, and for the same reason
    as the sequence. That entry is a promise about a peer — this one has had
    ciphertext, so never accept plaintext from it — and dropping it was
    justified by the rule re-establishing itself the first time the device is
    sealed for again. Between the unpair and that moment, though, the promise is
    simply gone, and the window is one a relay can arrange: downgrade the next
    message to plaintext and it is no longer refused. Keeping a stale entry
    costs nothing but a refusal a person can see and fix.

    *Not* the policy sequence, and this one was the other way round until now.
    That number is what makes an older signed policy unreplayable, so clearing
    it let a device paired again under the same id start from zero — and every
    policy document signed before the unpair verify once more. A server holding
    an old document only had to wait for an unpair, which is a thing users do
    for unrelated reasons. It was dropped to keep the ordinary case tidy: a
    re-paired machine numbering its own new policy below a mark it no longer
    remembers setting. That is a worse trade than it looked, because the tidy
    case is recoverable by saving the rules once and the replay is not
    recoverable at all.

    *Not* ``seenMessages``. Those keys are per message, not per device, and they
    exist so a relay cannot replay something already delivered. Unpairing is not
    a reason to make a delivered message deliverable again, and that ledger
    expires on its own.

    A block is policy rather than pairing and is not touched here: unpairing a
    blocked device leaves it blocked.
    """
    with _lock:
        # policySeqs and encryptedPeers are reported so the caller's shape does
        # not change, and are always zero: both are deliberately kept — see the
        # docstring for what each one protects.
        removed = {"pins": 0, "notices": 0, "encryptedPeers": 0, "policySeqs": 0}
        if not device_id:
            return {**removed, "found": False}
        state = _load_locked()
        if state["pins"].pop(device_id, None) is not None:
            removed["pins"] = 1
        kept_notices = [n for n in state["notices"] if n.get("deviceId") != device_id]
        removed["notices"] = len(state["notices"]) - len(kept_notices)
        if removed["notices"]:
            state["notices"] = kept_notices
        found = any(removed.values())
        if found:
            _save_locked(state)
            # The device id and the counts, and nothing else. The pin held a
            # signing key, and a log line is the one place it could outlive the
            # state document it was removed from.
            log.info("forgot device %s: %s", device_id, removed)
        return {**removed, "found": found}


def note_pairing(device_id: str, *, kind: str, device_name: str = "") -> None:
    """Record how a pairing ended. Never raises; this feeds a panel.

    ``kind`` is "paired", "refused" or "revoked". All three describe something
    the *other* machine did, which is exactly the class of event the old
    one-sided pairing had no way to report: it granted access without anybody
    at the far end being asked, and without telling them afterwards.
    "full" is this machine's own: the digits matched but the pin did not fit in
    the record, so the person is told why the device is not paired.
    """
    with _lock:
        state = _try_load()
        if state is None:
            return
        _record_locked(
            state,
            NOTICE_PAIRING,
            device_id=device_id,
            detail={"pairing": kind, "deviceName": device_name},
        )
        _save_record_locked(state, "a pairing notice")


def note_remote_command(device_id: str, *, device_name: str, workspace: str, pane_name: str) -> None:
    """Record that a paired device drove a pane here. Never raises.

    Deliberately after the fact rather than a prompt: a device that has been
    paired *is* allowed to do this, and asking every time would train people to
    click through. What was missing was any way to answer "has anything been
    driving my machines", which a log file nobody opens does not.
    """
    with _lock:
        state = _try_load()
        if state is None:
            return
        _record_locked(
            state,
            NOTICE_REMOTE_COMMAND,
            device_id=device_id,
            detail={
                "deviceName": device_name,
                "workspace": workspace,
                "paneName": pane_name,
            },
        )
        _save_record_locked(state, "a remote-command notice")


def note_key_change(device_id: str, *, pinned_key: str, offered_key: str, member_id: str) -> None:
    """Record that a pinned device is now offering a different key.

    The refusal itself does not depend on this being written — it comes from the
    pin, which is not touched here. This only makes the refusal *visible*, with
    both fingerprints, because "they reinstalled" and "somebody is standing in
    for them" look identical from the wire and only a person can tell them apart.
    """
    with _lock:
        state = _try_load()
        if state is None:
            return
        for notice in state["notices"]:
            if notice.get("kind") == NOTICE_KEY_CHANGED and notice.get("deviceId") == device_id:
                return
        _record_locked(
            state,
            NOTICE_KEY_CHANGED,
            device_id=device_id,
            detail={
                "memberId": member_id,
                "pinnedFingerprint": device_signing.fingerprint(pinned_key),
                "offeredFingerprint": device_signing.fingerprint(offered_key),
            },
        )
        _save_record_locked(state, "a key-change notice")


# ---- the pane policy's sequence ----------------------------------------------


def policy_seq(device_id: str) -> int:
    """The highest policy sequence accepted for *device_id*, or 0.

    Reads through ``_state_for_read``. Answering 0 from a cold cache made the
    monotonicity check (``offered < seq`` in server_link) vacuous, so a relay
    could replay any older but properly signed policy — the permissive one from
    before the user tightened it, say — and the acceptance would then write that
    lower number back as the new high-water mark.
    """
    with _lock:
        return int((_state_for_read().get("policySeqs") or {}).get(device_id) or 0)


def reserve_policy_seq(device_id: str) -> int:
    """Claim the next sequence for a policy about to be written, and persist it
    before it is used.

    Persisting first means a write that fails leaves a number burned rather than
    reusable: the next attempt takes a higher one. A burned sequence costs a
    re-save (until then the stored policy verifies but reads as stale, and this
    machine denies); reusing one would let a relay replay the older document
    that shares it, which costs the whole check.
    """
    with _lock:
        state = _load_locked()
        seqs = state["policySeqs"]
        seq = int(seqs.get(device_id) or 0) + 1
        seqs[device_id] = seq
        _save_locked(state)
        return seq


def note_policy_seq(device_id: str, seq: int) -> None:
    """Adopt a sequence read back from the server, when it moves forward."""
    with _lock:
        state = _load_locked()
        seqs = state["policySeqs"]
        if seq > int(seqs.get(device_id) or 0):
            seqs[device_id] = seq
            _save_locked(state)


def note_policy_unverified(reason: str, *, device_id: str = "", seq: Any = None) -> None:
    with _lock:
        state = _try_load()
        if state is None:
            return
        for notice in state["notices"]:
            if notice.get("kind") == NOTICE_POLICY_UNVERIFIED:
                return
        _record_locked(
            state,
            NOTICE_POLICY_UNVERIFIED,
            device_id=device_id,
            detail={
                "reason": reason,
                "seq": seq,
                "expected": (state.get("policySeqs") or {}).get(device_id, 0),
            },
        )
        _save_record_locked(state, "a policy-unverified notice")


def clear_policy_notice() -> None:
    """Drop the "policy could not be verified" notice once one verifies again.

    Deliberately *not* converted to ``_state_for_read``. Its cold-cache
    behaviour is "do not clear the warning", which fails toward keeping a notice
    that should have gone — the harmless direction. Every other reader failed
    the other way, which is why they were changed and this one was not.
    """
    with _lock:
        if _state is None:
            return
        keep = [n for n in _state["notices"] if n.get("kind") != NOTICE_POLICY_UNVERIFIED]
        if len(keep) != len(_state["notices"]):
            _state["notices"] = keep
            _save_locked(_state)


# ---- peers that have been sent ciphertext ------------------------------------


def is_encrypted_peer(device_id: str) -> bool:
    """Whether this peer has been sent — or has sent — sealed traffic before.

    Loads on a cold cache, for the same reason ``pin_for`` does: False here
    means "no downgrade rule applies", and both sides of the rule read this
    one function. Answering from an empty cache made the refusal expire at
    every restart — which is precisely the property the record was moved to
    disk to remove.
    """
    with _lock:
        return device_id in set(_state_for_read().get("encryptedPeers") or [])


def note_encrypted_peer(device_id: str) -> None:
    """Remember that this machine has sealed a message for *device_id*.

    Across restarts, deliberately. Held only in memory this was a promise that
    expired every time the backend came back up, and a backend restart is a
    daily event, not an attack the relay has to arrange.
    """
    with _lock:
        state = _load_locked()
        peers = state["encryptedPeers"]
        if device_id in peers:
            return
        if len(peers) >= MAX_DEVICES:
            # Refusing to record is what keeps the promise honest: an unrecorded
            # peer would be eligible for a plaintext fallback on the next send.
            raise TrustStoreFull(f"this machine already tracks {len(peers)} encrypted peers")
        peers.append(device_id)
        _save_locked(state)


# ---- notices -----------------------------------------------------------------


def _bounded(value: Any) -> Any:
    return value[:MAX_NOTICE_TEXT] if isinstance(value, str) else value


def _record_locked(state: dict[str, Any], kind: str, *, device_id: str, detail: dict) -> None:
    notices = state["notices"]
    # Device ids and names here come from the other machine or the relay.
    device_id = _bounded(device_id)
    notices.append(
        {
            "key": f"{kind}:{device_id}:{int(time.time() * 1000)}",
            "kind": kind,
            "deviceId": device_id,
            "at": int(time.time()),
            **{field: _bounded(value) for field, value in detail.items()},
        }
    )
    # Evict the oldest *dismissible* notice first, and only fall back to the
    # oldest of any kind when nothing dismissible is left.
    #
    # Plain oldest-first was wrong in a way worth naming: a first sighting is
    # recorded whenever an unknown device id signs a message, and the party that
    # chooses device ids is the relay. So it could introduce fifty devices and
    # push a "this pinned device changed its key" notice off the end — the
    # refusal would stay in force, because that comes from the pin, but the only
    # thing that tells a person about it would be gone. A warning an attacker
    # can flush is a warning with a hole in it.
    while len(notices) > MAX_NOTICES:
        index = next(
            (i for i, n in enumerate(notices) if n.get("kind") in DISMISSIBLE), 0
        )
        notices.pop(index)


def note_plaintext_refused(device_id: str, *, msg_key: str) -> None:
    """Record that a message from *device_id* was dropped for arriving in the
    clear from a peer that had been encrypting.

    Recorded even though the sender is also told, because the two audiences
    learn different things: the sender is told its message was refused, which a
    hostile sender already knew; the person at this machine is told that
    something asked them to accept cleartext, which is the part worth seeing.
    """
    with _lock:
        state = _try_load()
        if state is None:
            return
        _record_locked(state, NOTICE_PLAINTEXT_REFUSED,
                       device_id=device_id, detail={"msgKey": msg_key})
        _save_record_locked(state, "a plaintext-refused notice")


# ---- messages already delivered ----------------------------------------------

#: Keys recorded but not yet written out. See SEEN_FLUSH_AFTER.
_seen_pending: dict[str, int] = {}
_seen_last_flush: float = 0.0
#: Writes out a batch that no later message arrives to complete. Without it the
#: keys sat in memory until the next delivery — or a restart, which lost them.
_seen_timer: threading.Timer | None = None


def _arm_seen_timer_locked() -> None:
    """Arm the flush with the vault and data dir in force now. Read when it fired
    instead, a timer outliving the test that armed it wrote through whatever was
    in force by then — the import-time vault, with its real runner (R2-9)."""
    global _seen_timer
    if _seen_timer is None:
        _seen_timer = threading.Timer(
            SEEN_FLUSH_SECONDS, in_data_dir(app_data_dir(), _timed_seen_flush, _vault()))
        _seen_timer.daemon = True
        _seen_timer.start()


def _disarm_seen_timer_locked() -> None:
    global _seen_timer
    if _seen_timer is not None:
        _seen_timer.cancel()
        _seen_timer = None


def _timed_seen_flush(vault: Any) -> None:
    global _seen_timer, _timer_vault
    with _lock:
        _seen_timer = None
        if _seen_pending:
            _timer_vault = vault
            try:
                _flush_seen_locked(time.time())
            finally:
                _timer_vault = None


def _stop_seen_timer_for_test() -> None:
    """Cancel a pending flush and wait for one already running, so nothing of
    this test's is written after its patches are gone."""
    with _lock:
        timer = _seen_timer
        _disarm_seen_timer_locked()
    if timer is not None:
        timer.join(timeout=10)


def has_seen_message(msg_key: str) -> bool:
    """Whether this message was already delivered.

    Loads on a cold cache — answering False from an empty one would put the
    ledger back where it was before it was persisted, which is the whole bug.

    But it does not *raise* on a store that cannot be opened, which the other
    readers do. This one runs earlier than they do: it is the first thing the
    inbound path asks, ahead of the check that refuses everything while the pins
    are unreadable. Raising here would turn that refusal — the intended outcome
    — into a dropped connection before the refusal could be sent. False is safe
    precisely because the very next check says no anyway.
    """
    with _lock:
        if msg_key in _seen_pending:
            return True
        state = _try_load() if _state is None else _state
        return msg_key in ((state or {}).get("seenMessages") or {})


def note_seen_message(msg_key: str) -> None:
    """Record a delivery, writing out in batches rather than per message.

    Recorded in memory immediately — so a duplicate arriving in the same second
    is still refused — and flushed once a batch or a few seconds have passed.
    """
    global _seen_last_flush
    with _lock:
        now = time.time()
        _seen_pending[msg_key] = int(now)
        if _seen_last_flush == 0.0:
            _seen_last_flush = now
        if (
            len(_seen_pending) >= SEEN_FLUSH_AFTER
            or now - _seen_last_flush >= SEEN_FLUSH_SECONDS
        ):
            _flush_seen_locked(now)
        else:
            _arm_seen_timer_locked()


def flush_seen_messages() -> None:
    """Write out whatever is pending. For shutdown, and for tests that need the
    ledger on disk without waiting for a batch to fill."""
    with _lock:
        if _seen_pending:
            _flush_seen_locked(time.time())


def _flush_seen_locked(now: float) -> None:
    global _seen_last_flush
    _disarm_seen_timer_locked()
    state = _try_load()
    if state is None:
        # Keep the keys in memory rather than dropping them: this runs while a
        # message is being delivered, and raising would turn a delivery into a
        # dropped connection.
        return
    seen = state.setdefault("seenMessages", {})
    seen.update(_seen_pending)
    _seen_pending.clear()
    _seen_last_flush = now
    cutoff = int(now) - SEEN_MESSAGE_TTL_S
    for key in [k for k, at in seen.items() if int(at or 0) < cutoff]:
        del seen[key]
    # Sorted by recorded time, not insertion order: a flush merges a batch with
    # dict.update, after which insertion order is no longer delivery order.
    if len(seen) > MAX_SEEN_MESSAGES:
        for key in sorted(seen, key=lambda k: int(seen[k] or 0))[: len(seen) - MAX_SEEN_MESSAGES]:
            del seen[key]
    _save_record_locked(state, "the delivered-message ledger")


def notices() -> list[dict[str, Any]]:
    """Every recorded notice. Never raises: this feeds a panel, and a status
    read that could fail would leave it with nothing to say. But it does load —
    an empty list from a cold cache reads as "nothing has happened", which is
    the most reassuring thing this function can say and the least likely to be
    checked."""
    with _lock:
        # _try_load, not _state_for_read: this one promises never to raise —
        # it feeds a panel, and a status read that could fail leaves it with
        # nothing to say. It still loads; it just tolerates not being able to.
        state = _try_load() if _state is None else _state
        return [dict(n) for n in (state or {}).get("notices") or []]


def dismiss_notice(key: str) -> bool:
    """Drop one notice. Only a first sighting may go — see ``DISMISSIBLE``."""
    with _lock:
        state = _load_locked()
        for index, notice in enumerate(state["notices"]):
            if notice.get("key") != key:
                continue
            if notice.get("kind") not in DISMISSIBLE:
                return False
            state["notices"].pop(index)
            _save_locked(state)
            return True
        return False


def rebuild_locked_store() -> dict[str, Any]:
    """Start the trust record over, on purpose, with a person present.

    The lock exists because a *silent* reset is the attack: delete the state and
    the machine re-pins whatever keys it is next shown, with nobody the wiser.
    Which is why there is no automatic recovery and never should be — but the
    absence of any recovery at all was not a decision anybody made, and on a
    machine that hits this the only way out was Keychain Access. That is not a
    safer state; it is the same reset, performed with less information and
    without clearing the marker, so the two halves stay disagreeing.

    So: the same act, made visible and consistent. It refuses unless the store
    is actually locked, it drops the record and the marker together so they
    cannot disagree afterwards, and every pin goes with it — both machines have
    to pair again, which is the point. The caller is responsible for the
    confirmation that says a person asked for this; nothing here can tell.
    """
    global _state, _locked_reason, _transient_reason, _transient_failures, _damaged
    global _store_mode, _record_key
    with _lock:
        if not _locked_reason:
            try:
                _load_locked()
            except TrustStoreLocked:
                pass
        if not _locked_reason:
            # Not "is it locked right now" — "has it settled". A read that
            # failed once may succeed on the next call, and erasing every
            # pairing on the strength of a dismissed dialog is the mistake this
            # distinction exists to prevent.
            raise TrustStoreNotLocked(
                "the device trust store is readable, or has not finished retrying"
            )
        cleared = _locked_reason
        _transient_reason = ""
        _transient_failures = 0
        cloud_secrets.write(_vault(), SECRET_NAME, None)
        _journal_path().unlink(missing_ok=True)
        _record_path().unlink(missing_ok=True)
        _mirror_base_path().unlink(missing_ok=True)
        # A JSON null reads back as "no marker" (kv_get's default), which is
        # what the marker's absence means; the kv store has no delete.
        _database().kv_set(INITIALISED_KEY, None, now=0)
        _state = None
        _store_mode = None
        _record_key = None
        _locked_reason = ""
        _damaged = False
        _seen_pending.clear()
        _forget_written()
        log.warning("device trust store rebuilt after a lock: %s", cleared)
        return {"rebuilt": True, "was": cleared}


def _remember_committed(state: dict[str, Any]) -> None:
    global _committed_core
    _committed_core = copy.deepcopy(_core_of(state))


def _forget_written() -> None:
    global _last_core, _last_journal, _committed_core, _journal_blocked, _journal_problem
    global _last_mirror
    _last_mirror = None
    _last_core = None
    _last_journal = None
    _committed_core = None
    _journal_blocked = False
    _journal_problem = ""


def _reset_for_test() -> None:
    """Forget the process cache and the marker. Tests run against a throwaway
    vault and a throwaway data dir, so this touches nothing real."""
    global _state, _locked_reason, _transient_reason, _transient_failures, _damaged
    global _seen_last_flush, _store_mode, _record_key
    with _lock:
        _state = None
        _store_mode = None
        _record_key = None
        _locked_reason = ""
        _transient_reason = ""
        _transient_failures = 0
        _damaged = False
        # Module-level too, and just as much part of "this process has seen
        # nothing". Left behind, a batch recorded by one test is still pending
        # when the next starts and lands in its state document instead.
        _seen_pending.clear()
        _seen_last_flush = 0.0
        _disarm_seen_timer_locked()
        _unsaved_blocks.clear()
        _forget_written()
        # A JSON null reads back as "no marker" (kv_get's default), which is
        # what the marker's absence means; the kv store has no delete.
        _database().kv_set(INITIALISED_KEY, None, now=0)
