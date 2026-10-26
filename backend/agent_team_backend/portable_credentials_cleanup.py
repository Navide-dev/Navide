"""One-time removal of what the portable-credential feature left behind.

The feature — pasting a long-lived credential (``claude setup-token``) that
Navide injected into new panes — was removed in 0.2.32. A machine that used it
still holds three things that together open the pasted value:

- the AES-GCM wrapping key, a Navide app secret named
  ``navide-portable-credential-key`` (Keychain on macOS, a 0600 file under
  ``~/.navide/cli-profiles/__secrets__/`` elsewhere);
- the ciphertext document, navide.db ``kv`` key ``portable_credentials``;
- credentials an older version pulled from the cloud, navide.db
  ``sync_credential_items`` rows with origin ``imported``.

``run`` erases exactly those, once. A machine that never used the feature has
none of them: the check reads navide.db only and makes no vault (Keychain)
call. Nothing else is touched — no other kv key, no other row, no table is
dropped or altered, no other app secret.

Progress is recorded in kv ``portable_credentials_removed`` *before* anything
is erased, so a run cut short (a locked Keychain, a crash) is finished on the
next start instead of being forgotten once the database side is already gone.
The same record carries the one-time notice the main window shows.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

#: The app secret the removed module wrapped its ciphertext with.
WRAPPING_KEY_SECRET = "navide-portable-credential-key"
#: The kv document the removed module kept its ciphertext in.
KV_KEY = "portable_credentials"
#: This cleanup's own record: ``{"keyDeleted": bool, "noticePending": bool}``.
STATE_KV_KEY = "portable_credentials_removed"
_IMPORTED_TABLE = "sync_credential_items"
_IMPORTED_ORIGIN = "imported"


def _kv_present(cur: Any, key: str) -> bool:
    # Presence, not a parse: a document that no longer decodes is still a
    # leftover to erase.
    return cur.execute("SELECT 1 FROM kv WHERE key = ?", (key,)).fetchone() is not None


def _imported_table_exists(cur: Any) -> bool:
    row = cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (_IMPORTED_TABLE,)
    ).fetchone()
    return row is not None


def _used_here(db: Any) -> bool:
    with db.transaction() as cur:
        if _kv_present(cur, KV_KEY):
            return True
        if not _imported_table_exists(cur):
            return False
        row = cur.execute(
            f"SELECT 1 FROM {_IMPORTED_TABLE} WHERE origin = ? LIMIT 1", (_IMPORTED_ORIGIN,)
        ).fetchone()
        return row is not None


def run(db: Any, vault: Any, *, now: int) -> bool:
    """Erase the feature's leftovers if this machine has any. Returns True when
    this call finished a cleanup. Raises when the vault refuses the key's
    deletion; the record stays unfinished and the next start tries again."""
    state = db.kv_get(STATE_KV_KEY)
    if isinstance(state, dict) and state.get("keyDeleted"):
        return False
    if not isinstance(state, dict):
        if not _used_here(db):
            return False
        state = {"keyDeleted": False, "noticePending": True}
        db.kv_set(STATE_KV_KEY, state, now=now)
    with db.transaction() as cur:
        cur.execute("DELETE FROM kv WHERE key = ?", (KV_KEY,))
        if _imported_table_exists(cur):
            cur.execute(
                f"DELETE FROM {_IMPORTED_TABLE} WHERE origin = ?", (_IMPORTED_ORIGIN,))
    vault.write_app_secret(WRAPPING_KEY_SECRET, None)
    db.kv_set(STATE_KV_KEY, {**state, "keyDeleted": True}, now=now)
    log.info("removed the portable-credential leftovers from this machine")
    return True


def take_notice(db: Any, *, now: int) -> bool:
    """True exactly once on a machine the cleanup ran on: the main window shows
    the notice and it is marked shown in the same call."""
    state = db.kv_get(STATE_KV_KEY)
    if not isinstance(state, dict) or not state.get("noticePending"):
        return False
    db.kv_set(STATE_KV_KEY, {**state, "noticePending": False}, now=now)
    return True
