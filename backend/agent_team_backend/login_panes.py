"""Which panes are CLI sign-in panes, so what they print stays with them.

A sign-in pane runs a CLI's own login flow, and its screen holds what that
flow prints: an authorization URL, a device code, the code the user pastes
back. None of it may reach another pane, a chat or a log another agent reads.

A pane counts as one when its terminal carries any sign-in marker: the
window's own ``login_pane`` (set for every sign-in pane it spawns), or the
backend's ``login_profile_id`` / ``live_login`` / ``account_dir_login``. A
pane whose sign-in has exited still counts: its scrollback is unchanged.
Read-only; nothing here touches a credential.
"""

from __future__ import annotations

_LOGIN_MARKERS = ("login_pane", "login_profile_id", "live_login", "account_dir_login")


def is_login_pane(pane_id: str) -> bool:
    """True when a terminal of ``pane_id`` was spawned as a CLI sign-in."""
    if not pane_id:
        return False
    from . import app

    for tid, owner in list(app._PTY_OWNERS.items()):
        term = getattr(owner, "terminals", {}).get(tid)
        if term is None or term.pane_id != pane_id:
            continue
        metadata = term.metadata or {}
        if any(metadata.get(key) for key in _LOGIN_MARKERS):
            return True
    return False
