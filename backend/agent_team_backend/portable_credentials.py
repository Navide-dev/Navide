"""Portable credentials: a pasted secret that reaches a CLI only through its
spawn environment.

A parked *slot* (``credential_vault``) is a copy of what a CLI's own ``/login``
wrote, moved between the live location and a parking spot. A *portable*
credential is the other thing a vendor offers: a value its documentation says
to carry to any machine and hand over in a variable (``claude setup-token`` →
``CLAUDE_CODE_OAUTH_TOKEN`` is the model case). This module owns that second
kind end to end — validating, storing, classifying and turning it into the
``env`` / ``env_remove`` pair a spawn already accepts.

Where things live, and why two places:

    wrapping key (32 bytes)       → credential_vault app secret
                                    "navide-portable-credential-key"
                                    (Keychain / DPAPI file / 0600 file)
    ciphertext + intent + metadata → navide.db KV "portable_credentials"
                                    AES-256-GCM, AAD bound to agent+slot

The value is therefore ciphertext at rest on every platform. What protects
the *key* is the platform's own secret store, and ``describe`` reports which
one (``keyStorage``) rather than calling all three "encrypted": on Linux the
key is a 0600 file, which is the same protection every other backend-owned
secret has there (the existing threat model — file permissions are defense
in depth, not a vault) and no more. Neither store is a CLI slot: the
credential watcher and the login harvest never see these entries, and a
provider's own login files are never touched.

Four rules the rest of the code relies on:

*The plaintext exists in memory only, on the way in and on the way out.*
Never written under the CLI's home, never logged, never part of a broadcast:
``describe`` and ``list_stored`` return metadata, ``read_secret`` and
``spawn_env`` are the readers, and a spawn plan redacts itself.

*Unknown is a refusal, not a default.* ``classify_slot`` answers ``UNKNOWN``
for anything a vendor did not positively classify — no spec, no classifier,
a classifier that raised or answered off-vocabulary. Callers deciding what
may leave the machine must treat only ``API_KEY``/``OAUTH`` as classified.

*Selected means used or refused, never replaced.* The user's recorded
intent is one selected slot per agent (``enabled`` in ``describe`` is "this
slot is the selected one"). Selection is independent of the CLI accounts'
native default: choosing a pasted or imported credential parks nothing,
restores nothing and writes no provider file — which is what lets a machine
that has never signed in to an account still run on that account's token.
While a slot is selected, a value that is missing, corrupt or shadowed by a
session file / key helper / provider route / managed policy makes
``spawn_env`` raise instead of letting the pane start on whatever login the
CLI would otherwise pick up — that would be a silent identity swap. The
report names what is in the way; nothing here changes it.

*Nothing here knows a vendor.* Which variable, which conflicting variables,
which shadowing file or setting, which managed directory: all of it is the
vendor's ``PortableCredential`` declaration. A vendor without one cannot
store a portable credential at all.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import cloud_secrets, osplat
from .cli_vendors.base import PortableCredential, SlotKind
from .cli_vendors.registry import VENDORS, vendor

log = logging.getLogger("agent_team_backend.portable_credentials")

#: Vault entry holding the base64 wrapping key. One per install.
WRAPPING_KEY_SECRET = "navide-portable-credential-key"
#: KV document holding ciphertext, intent and metadata.
KV_KEY = "portable_credentials"
SCHEMA_VERSION = 1

_KEY_LEN = 32
_NONCE_LEN = 12
_AAD_PREFIX = b"navide/portable-credential/v1"

#: A profile id, or the built-in Default row's reserved id.
DEFAULT_SLOT_ID = "__default__"
_SLOT_ID_RE = re.compile(r"^(__default__|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$")
_MAX_VALUE_LEN = 8192

#: The wrapping key once read — one Keychain call per process, not per spawn.
#: Cleared by ``clear_memory``.
_cached_key: bytes | None = None
#: One lock for both the key and the document. Reentrant because a store
#: mints the key inside the document update. Held across the whole
#: read-or-mint (two first saves racing would otherwise mint two keys and
#: orphan one of them) and across every document read-modify-write (two
#: saves racing would otherwise drop one entry).
_store_lock = threading.RLock()


class PortableCredentialError(ValueError):
    """A value or address that must not be stored or injected."""


class PortableCredentialUnavailable(RuntimeError):
    """A selected credential cannot be put in effect. ``reason`` is one of
    "missing", "corrupt", "shadowed", "import_failed"; ``shadowed_by`` names
    what is in the way for "shadowed". Never carries the value."""

    def __init__(self, agent_key: str, slot_id: str, reason: str,
                 shadowed_by: tuple[str, ...] = ()) -> None:
        self.agent_key = agent_key
        self.slot_id = slot_id
        self.reason = reason
        self.shadowed_by = shadowed_by
        detail = f": {', '.join(shadowed_by)}" if shadowed_by else ""
        super().__init__(
            f"the portable credential selected for {agent_key} is {reason}{detail}"
        )


# ---- classification ---------------------------------------------------------

def classify_slot(agent_key: str, secret: str | None) -> SlotKind:
    """What kind of secret a parked slot holds, fail-closed.

    ``EMPTY`` for nothing at all; ``UNKNOWN`` whenever the vendor cannot
    vouch for the answer. The vendor's classifier sees only the secret text
    and is trusted for exactly two answers, ``API_KEY`` and ``OAUTH``.
    """
    if secret is None or not secret.strip():
        return SlotKind.EMPTY
    spec = vendor(agent_key)
    classify = spec.classify_secret if spec is not None else None
    if classify is None:
        return SlotKind.UNKNOWN
    try:
        kind = classify(secret)
    except Exception:  # noqa: BLE001 - a classifier that cannot decide has not decided
        log.warning("classify_secret for %s raised; treating slot as unknown", agent_key)
        return SlotKind.UNKNOWN
    if kind in (SlotKind.API_KEY, SlotKind.OAUTH):
        return SlotKind(kind)
    return SlotKind.UNKNOWN


# ---- declaration lookup -----------------------------------------------------

def portable_spec(agent_key: str) -> PortableCredential | None:
    """The vendor's declaration, or None when it has none (= unsupported)."""
    spec = vendor(agent_key)
    return spec.portable_credential if spec is not None else None


def supported_agent_keys() -> list[str]:
    """Vendors that declare a portable credential interface, registry order."""
    return [key for key, spec in VENDORS.items() if spec.portable_credential is not None]


def _require_spec(agent_key: str) -> PortableCredential:
    declared = portable_spec(agent_key)
    if declared is None:
        raise PortableCredentialError(
            f"{agent_key!r} has no portable credential interface"
        )
    return declared


def _item_key(agent_key: str, slot_id: str) -> str:
    if not _SLOT_ID_RE.match(slot_id or ""):
        raise PortableCredentialError(f"invalid slot id: {slot_id!r}")
    return f"{agent_key}/{slot_id}"


def _vault():
    # Late import: app imports the modules that import this one, and tests
    # swap the singleton wholesale to stay off the Keychain.
    from . import app

    return app.credential_vault


def _db():
    from . import app

    return app.database


def key_storage() -> str:
    """Where the wrapping key sits: what the platform's secret store is, in
    the words the UI shows. "keychain" (macOS), "dpapi" (Windows, an
    owner-encrypted file), "file" (a 0600 file — the honest name for it)."""
    if osplat.platform_id == "darwin":
        return "keychain"
    if osplat.platform_id == "win32":
        return "dpapi"
    return "file"


# ---- wrapping key -----------------------------------------------------------

def _wrapping_key(*, create: bool) -> bytes | None:
    """The wrapping key, minting one on first store. A vault that will not
    answer raises: a locked Keychain must not read as "no key" and mint a
    second one that opens nothing already stored."""
    global _cached_key
    with _store_lock:
        if _cached_key is not None:
            return _cached_key
        stored = _vault().read_app_secret(WRAPPING_KEY_SECRET)
        if stored:
            try:
                raw = base64.b64decode(stored.strip().encode("ascii"), validate=True)
            except (ValueError, TypeError) as err:
                raise PortableCredentialError(
                    "the stored portable-credential key is not valid base64") from err
            if len(raw) != _KEY_LEN:
                raise PortableCredentialError("the stored portable-credential key is not 32 bytes")
        elif create:
            raw = os.urandom(_KEY_LEN)
            cloud_secrets.write(_vault(), WRAPPING_KEY_SECRET, base64.b64encode(raw).decode("ascii"))
            log.info("minted the portable-credential wrapping key (%s)", key_storage())
        else:
            return None
        _cached_key = raw
        return raw


def clear_memory() -> None:
    """Drop the in-process key cache — on logout, account or server switch.
    Nothing else is held: values are decrypted per call and returned."""
    global _cached_key
    with _store_lock:
        _cached_key = None


def _aad(agent_key: str, slot_id: str) -> bytes:
    return b"\x00".join((_AAD_PREFIX, agent_key.encode("utf-8"), slot_id.encode("utf-8")))


def _seal(agent_key: str, slot_id: str, value: str) -> str:
    key = _wrapping_key(create=True)
    nonce = os.urandom(_NONCE_LEN)
    sealed = AESGCM(key).encrypt(nonce, value.encode("utf-8"), _aad(agent_key, slot_id))
    return base64.b64encode(nonce + sealed).decode("ascii")


def _open(agent_key: str, slot_id: str, wire: str) -> str | None:
    """The value, or None when the record cannot be opened (no key, bad
    base64, wrong AAD, tampered). Logged without the record."""
    try:
        key = _wrapping_key(create=False)
        if key is None:
            log.warning("portable credential %s/%s: no wrapping key on this machine",
                        agent_key, slot_id)
            return None
        raw = base64.b64decode(wire.encode("ascii"), validate=True)
        return AESGCM(key).decrypt(
            raw[:_NONCE_LEN], raw[_NONCE_LEN:], _aad(agent_key, slot_id)
        ).decode("utf-8")
    except (InvalidTag, ValueError, TypeError, UnicodeDecodeError):
        log.warning("portable credential %s/%s is corrupt", agent_key, slot_id)
        return None


# ---- validation -------------------------------------------------------------

def validate_value(agent_key: str, value: str) -> str:
    """The value as it will be stored, or raise. Strips surrounding
    whitespace (a pasted token often carries a trailing newline), then
    refuses anything that could not be one environment variable's value:
    empty, multi-line, control characters, absurd length, or off the shape
    the vendor declared."""
    declared = _require_spec(agent_key)
    cleaned = (value or "").strip()
    if not cleaned:
        raise PortableCredentialError("the credential is empty")
    if len(cleaned) > _MAX_VALUE_LEN:
        raise PortableCredentialError("the credential is too long")
    if any(ord(ch) < 0x20 or ch == "\x7f" for ch in cleaned):
        raise PortableCredentialError(
            "the credential must be a single line without control characters"
        )
    if declared.value_pattern and not re.fullmatch(declared.value_pattern, cleaned):
        raise PortableCredentialError(
            f"the value does not look like a {declared.env} value"
        )
    return cleaned


# ---- the document -----------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _read_doc() -> dict:
    data = _db().kv_get(KV_KEY)
    items = data.get("items") if isinstance(data, dict) else None
    selected = data.get("selected") if isinstance(data, dict) else None
    return {
        "schemaVersion": SCHEMA_VERSION,
        "items": dict(items) if isinstance(items, dict) else {},
        # agent_key -> the slot whose credential its panes run on.
        "selected": {
            str(k): str(v) for k, v in selected.items() if isinstance(v, str) and v
        } if isinstance(selected, dict) else {},
    }


def _write_doc(doc: dict) -> None:
    _db().kv_set(KV_KEY, doc, now=int(time.time()))


def _raw_item(agent_key: str, slot_id: str) -> dict | None:
    item = _read_doc()["items"].get(_item_key(agent_key, slot_id))
    return item if isinstance(item, dict) else None


def _item(agent_key: str, slot_id: str) -> dict | None:
    """A configured entry: one whose ciphertext is actually there."""
    item = _raw_item(agent_key, slot_id)
    return item if item is not None and isinstance(item.get("ciphertext"), str) else None


# ---- storage ----------------------------------------------------------------

def store(agent_key: str, slot_id: str, value: str) -> dict:
    """Validate, encrypt and store *value* for ``agent_key``/``slot_id``,
    selecting it (``enabled``). Blocking (Keychain on first use); call off
    the event loop. Returns ``describe``."""
    key = _item_key(agent_key, slot_id)
    declared = _require_spec(agent_key)
    cleaned = validate_value(agent_key, value)
    with _store_lock:
        doc = _read_doc()
        doc["items"][key] = {
            "agentKey": agent_key,
            "slotId": slot_id,
            "kind": declared.kind,
            "updatedAt": _now_iso(),
            "ciphertext": _seal(agent_key, slot_id, cleaned),
        }
        # A paste is a choice: the user just handed over the credential
        # they want this agent to run on.
        doc["selected"][agent_key] = slot_id
        _write_doc(doc)
    log.info("portable credential stored for %s/%s", agent_key, slot_id)
    return describe(agent_key, slot_id)


def notify_saved(agent_key: str, slot_id: str) -> None:
    """Tell sync a paste landed so it carries it up now rather than on the
    next round. Separate from ``store`` on purpose: ``store`` runs off the
    loop (Keychain), while sync schedules its push ON the loop — called from
    a worker thread it would find no running loop and quietly do nothing.
    Call this from the async handler after the store has been awaited."""
    _notify_sync("credential_saved", agent_key, slot_id)


def selected_slot(agent_key: str) -> str | None:
    """The slot this agent's panes run on, or None for the CLI's own login."""
    return _read_doc()["selected"].get(agent_key)


def selection_usable(agent_key: str, *, home: Path | None = None) -> bool:
    """Whether the agent's selected slot could be put in effect right now,
    judged without opening it: a local record or an available imported copy
    exists and nothing under *home* shadows it. For the signed-out advisory
    — a usable selection means the pane will not open on a sign-in prompt.
    The spawn itself still decrypts and re-checks; this never replaces it."""
    declared = portable_spec(agent_key)
    if declared is None:
        return False
    slot_id = selected_slot(agent_key)
    if slot_id is None:
        return False
    if _item(agent_key, slot_id) is None and not _imported_available(agent_key, slot_id):
        return False
    return not _shadowing_present(declared, home)


def set_enabled(agent_key: str, slot_id: str, enabled: bool) -> dict:
    """Select this slot for the agent (one per agent; ``True``) or, if it
    is the selected one, go back to the CLI's own login (``False``). The
    slot has to exist here or on the sync side — selecting nothing would
    refuse every spawn for no reason the UI can show. Blocking (DB)."""
    key = _item_key(agent_key, slot_id)
    _require_spec(agent_key)
    with _store_lock:
        doc = _read_doc()
        if enabled:
            if doc["items"].get(key) is None and not _imported_available(agent_key, slot_id):
                raise PortableCredentialError(f"no portable credential stored for {key}")
            doc["selected"][agent_key] = slot_id
        elif doc["selected"].get(agent_key) == slot_id:
            doc["selected"].pop(agent_key, None)
        _write_doc(doc)
    log.info("portable credential %s for %s/%s", "selected" if enabled else "deselected",
             agent_key, slot_id)
    return describe(agent_key, slot_id)


def forget(agent_key: str, slot_id: str, *, notify_sync: bool = True) -> None:
    """Erase ciphertext, intent and metadata — on this machine only. A
    no-op for an entry that is not there. Blocking (DB).

    ``notify_sync=False`` is for the sync adapter itself, which calls this
    to retire a local paste that the cloud has superseded: telling sync
    about that removal would make it retire the imported copy it is about
    to serve."""
    key = _item_key(agent_key, slot_id)
    with _store_lock:
        doc = _read_doc()
        removed = doc["items"].pop(key, None) is not None
        # Only a removal the user asked for drops the selection: the sync
        # adapter retiring a superseded local paste (notify_sync=False) is
        # about to serve the imported copy under the same slot.
        if notify_sync and doc["selected"].get(agent_key) == slot_id:
            doc["selected"].pop(agent_key, None)
            removed = True
        if removed:
            _write_doc(doc)
    log.info("portable credential forgotten for %s/%s", agent_key, slot_id)
    if notify_sync:
        _notify_sync("forget_credential", agent_key, slot_id)


def list_stored() -> list[tuple[str, str]]:
    """Every configured (agent_key, slot_id), document order. Blocking (DB)."""
    out: list[tuple[str, str]] = []
    for item in _read_doc()["items"].values():
        if isinstance(item, dict) and isinstance(item.get("ciphertext"), str):
            out.append((str(item.get("agentKey") or ""), str(item.get("slotId") or "")))
    return out


def read_secret(agent_key: str, slot_id: str) -> str | None:
    """The locally stored value, decrypted into memory, or None when nothing
    is stored or the record cannot be opened. Blocking; call off the loop.
    For the sync snapshot — spawns go through ``spawn_env``."""
    item = _item(agent_key, slot_id)
    if item is None:
        return None
    return _open(agent_key, slot_id, item["ciphertext"])


def describe(
    agent_key: str,
    slot_id: str,
    *,
    home: Path | None = None,
    cwd: Path | None = None,
) -> dict:
    """Metadata for the UI — never the value.

    ``shadowedBy`` lists the vendor-declared files and settings present
    under *home* / *cwd* / the managed root that would keep the CLI from
    using the injected variable; a root the caller does not pass is not
    checked (the managed root always is). Blocking; call off the loop.
    """
    declared = _require_spec(agent_key)
    doc = _read_doc()
    item = doc["items"].get(_item_key(agent_key, slot_id))
    item = item if isinstance(item, dict) and isinstance(item.get("ciphertext"), str) else None
    imported = None if item is not None else _imported_entry(agent_key, slot_id)
    source = "local" if item is not None else "imported" if imported is not None else "none"
    return {
        "agentKey": agent_key,
        "slotId": slot_id,
        "configured": source != "none",
        # Where the value would come from: a paste on this machine, a copy
        # another device synced here, or nothing.
        "source": source,
        # "this slot is the one the agent's panes run on"
        "enabled": doc["selected"].get(agent_key) == slot_id,
        # For an imported copy: whether sync can currently serve it.
        "available": True if item is not None else bool(imported and imported.get("available")),
        "kind": declared.kind,
        "updatedAt": (item or imported or {}).get("updatedAt"),
        "env": declared.env,
        "keyStorage": key_storage(),
        "quotaVerified": declared.quota_verified,
        "obtainCommand": declared.obtain_command,
        "docsUrl": declared.docs_url,
        "shadowedBy": list(_shadowing_present(declared, home, cwd)),
    }


def describe_all(*, home: Path | None = None) -> dict[str, dict]:
    """``describe`` for every entry this machine knows — pasted here or
    synced from another device — keyed "<agent>/<slot>". An imported copy
    with no local record is listed too, so a machine that never signed in
    to that account can still see and select it."""
    addresses = list(list_stored())
    for entry in _imported_entries():
        address = (entry["agentKey"], entry["slotId"])
        if address not in addresses:
            addresses.append(address)
    return {
        f"{agent_key}/{slot_id}": describe(agent_key, slot_id, home=home)
        for agent_key, slot_id in addresses
        if portable_spec(agent_key) is not None and _SLOT_ID_RE.match(slot_id or "")
    }


# ---- sync hooks (optional, owned by sync_scopes) ------------------------------

def _sync_hook(name: str):
    try:
        from . import sync_scopes
    except Exception:  # noqa: BLE001 - sync is optional to this module
        return None
    return getattr(sync_scopes, name, None)


def _notify_sync(name: str, agent_key: str, slot_id: str) -> None:
    hook = _sync_hook(name)
    if hook is None:
        return
    try:
        hook(agent_key, slot_id)
    except Exception as err:  # noqa: BLE001 - sync must never block a local save
        log.warning("sync hook %s for %s/%s failed: %s", name, agent_key, slot_id, err)


def _imported_entries() -> list[dict]:
    """Metadata for every credential sync holds for this account, as
    ``sync_scopes.imported_credentials()`` reports it: dicts with
    ``agentKey``, ``slotId``, ``available`` and ``updatedAt``. Never a
    value. Empty when sync is absent or cannot answer."""
    hook = _sync_hook("imported_credentials")
    if hook is None:
        return []
    try:
        entries = hook()
    except Exception as err:  # noqa: BLE001 - listing is display only
        log.warning("imported credential listing failed: %s", err)
        return []
    return [
        e for e in (entries or ())
        if isinstance(e, dict) and isinstance(e.get("agentKey"), str)
        and isinstance(e.get("slotId"), str)
    ]


def _imported_entry(agent_key: str, slot_id: str) -> dict | None:
    for entry in _imported_entries():
        if entry["agentKey"] == agent_key and entry["slotId"] == slot_id:
            return entry
    return None


def _imported_available(agent_key: str, slot_id: str) -> bool:
    entry = _imported_entry(agent_key, slot_id)
    return bool(entry and entry.get("available"))


def _imported_value(agent_key: str, slot_id: str) -> str | None:
    """A value another device synced here, held in memory by sync_scopes.
    None when sync has none (or is not present at all). A lookup that
    raises is not "none": sync may well hold a selected credential it
    cannot open right now, and answering None here would start the pane on
    the native login instead — so the failure is passed up as a refusal."""
    hook = _sync_hook("imported_credential")
    if hook is None:
        return None
    try:
        value = hook(agent_key, slot_id)
    except Exception as err:  # noqa: BLE001
        log.warning("imported credential lookup for %s/%s failed: %s", agent_key, slot_id, err)
        raise PortableCredentialUnavailable(agent_key, slot_id, "import_failed") from err
    return value if isinstance(value, str) and value else None


# ---- launch facts -----------------------------------------------------------

#: pane_id -> the portable slot its most recent launch was injected with
#: ("" for a native or login launch). Non-secret. Survives the terminal's
#: exit so the bookkeeping messages that follow a fast exit still record
#: the launch's identity; bounded (oldest evicted) and dropped when the pane
#: is removed, so it cannot grow with the life of the backend.
_LAUNCH_FACTS_MAX = 512
_launch_facts: "OrderedDict[str, str]" = OrderedDict()
_launch_lock = threading.Lock()


def note_launch(pane_id: str, slot_id: str) -> None:
    """Record what this launch of ``pane_id`` ran on. Every launch writes —
    a native or login relaunch of the same pane writes "" and so retires the
    previous portable fact rather than letting it resurface."""
    if not pane_id:
        return
    with _launch_lock:
        _launch_facts.pop(pane_id, None)
        _launch_facts[pane_id] = slot_id or ""
        while len(_launch_facts) > _LAUNCH_FACTS_MAX:
            _launch_facts.popitem(last=False)


def launch_slot(pane_id: str) -> str:
    """The portable slot of the pane's most recent launch, or ""."""
    with _launch_lock:
        return _launch_facts.get(pane_id, "")


def forget_launch(pane_id: str) -> None:
    """The pane is gone for good."""
    with _launch_lock:
        _launch_facts.pop(pane_id, None)


# ---- spawn injection --------------------------------------------------------

@dataclass(frozen=True)
class SpawnInjection:
    """What a spawn adds to and removes from the pane's environment.

    ``env`` carries the plaintext and is excluded from ``repr`` so the object
    can be logged or shown in a traceback without leaking it.
    """

    env: dict[str, str] = field(repr=False)
    env_remove: tuple[str, ...]
    #: Files and settings present on this machine that the CLI ranks above
    #: the variable. Non-empty means ``env`` is EMPTY: nothing is injected
    #: until the user resolves them, and this is what the UI shows them.
    shadowed_by: tuple[str, ...]
    #: The slot the value came from — the launch's identity, fixed at the
    #: moment of injection. Bookkeeping that runs later (history, attribution)
    #: must record THIS, never the selection current at its own time: the
    #: user may have switched slots in between, and the pane is still running
    #: on this one. "" for a plan built from a bare value.
    slot_id: str = ""

    @property
    def active(self) -> bool:
        return bool(self.env) and not self.shadowed_by


def _setting_present(root: Path, parts: tuple[str, ...], key_path: tuple[str, ...]) -> bool:
    try:
        raw = root.joinpath(*parts).read_text(encoding="utf-8")
    except OSError:
        return False
    try:
        node = json.loads(raw)
    except ValueError:
        # A settings file that does not parse cannot be shown not to route
        # elsewhere; the CLI may still honour part of it. Fail closed.
        return True
    for step in key_path:
        if not isinstance(node, dict) or step not in node:
            return False
        node = node[step]
    return node not in (None, "", [], {}, False)


def managed_root(declared: PortableCredential) -> Path | None:
    """The vendor's policy directory on this platform, or None."""
    for platform, path in declared.managed_roots:
        if platform == osplat.platform_id:
            return Path(path)
    return None


def _shadowing_present(
    declared: PortableCredential, home: Path | None, cwd: Path | None = None
) -> tuple[str, ...]:
    roots = {"home": home, "cwd": cwd, "managed": managed_root(declared)}
    found: list[str] = []
    if home is not None:
        found.extend(
            "/".join(parts)
            for parts in declared.shadowing_files
            if home.joinpath(*parts).exists()
        )
    for root_name, parts, key_path in declared.shadowing_settings:
        root = roots.get(root_name)
        if root is not None and _setting_present(root, parts, key_path):
            found.append(f"{root_name}:{'/'.join(parts)}:{'.'.join(key_path)}")
    return tuple(found)


def plan_injection(
    agent_key: str,
    value: str,
    *,
    home: Path | None = None,
    cwd: Path | None = None,
) -> SpawnInjection:
    """The environment edits that put *value* in effect for one spawn.

    Pure over the declaration and the file system: no vault access, so a
    test can hand it a synthetic value. The value goes in as-is (it was
    validated on the way into the vault), the vendor's companions beside it,
    and the variables the CLI ranks above it are scheduled for removal — with
    ``env`` itself never in the removal list, whatever the declaration says.

    Fail-closed: while anything the vendor declared as shadowing is present
    under *home*, *cwd* or the managed root, the plan carries no edits at
    all. Injecting anyway would at best be ignored and at worst hand the
    value to a helper or a base URL the user configured for a different
    identity.
    """
    declared = _require_spec(agent_key)
    shadowed = _shadowing_present(declared, home, cwd)
    if shadowed:
        return SpawnInjection(env={}, env_remove=(), shadowed_by=shadowed)
    env = {declared.env: value}
    for key, fixed in declared.env_extra:
        env.setdefault(key, fixed)
    remove = tuple(
        key for key in dict.fromkeys(declared.env_remove) if key not in env
    )
    return SpawnInjection(env=env, env_remove=remove, shadowed_by=())


def spawn_env(
    agent_key: str,
    *,
    home: Path | None = None,
    cwd: Path | None = None,
) -> SpawnInjection | None:
    """The injection for a spawn of ``agent_key``, per its selected slot.

    None = no portable credential is selected for this agent (or the vendor
    has no interface): the spawn proceeds on the CLI's own login exactly as
    before. A selected credential that cannot be put in effect raises
    ``PortableCredentialUnavailable`` ("missing" — neither a local record
    nor an imported copy; "corrupt" — the local record does not open;
    "import_failed" — sync could not answer; "shadowed" — something on this
    machine outranks it) rather than letting the pane start as someone else.
    Blocking; call off the event loop, and for a profile agent inside its
    switch lock.
    """
    if portable_spec(agent_key) is None:
        return None
    slot_id = selected_slot(agent_key)
    if slot_id is None:
        return None
    item = _raw_item(agent_key, slot_id)
    if item is not None and isinstance(item.get("ciphertext"), str):
        value = _open(agent_key, slot_id, item["ciphertext"])
        if value is None:
            raise PortableCredentialUnavailable(agent_key, slot_id, "corrupt")
    else:
        value = _imported_value(agent_key, slot_id)
        if value is None:
            raise PortableCredentialUnavailable(agent_key, slot_id, "missing")
    plan = plan_injection(agent_key, value, home=home, cwd=cwd)
    if not plan.active:
        raise PortableCredentialUnavailable(agent_key, slot_id, "shadowed", plan.shadowed_by)
    return SpawnInjection(
        env=plan.env, env_remove=plan.env_remove, shadowed_by=(), slot_id=slot_id
    )
