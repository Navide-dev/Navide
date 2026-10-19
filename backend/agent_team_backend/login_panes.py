"""Which panes are CLI sign-in panes, so their sign-in stays theirs.

A sign-in pane runs a CLI's own login flow. Its screen holds what that flow
prints — an authorization URL, a device code, the code the user pastes back —
and none of it may reach another pane, a chat or a log another agent reads.
Nor may anything but the user type into it: a wizard that takes typed input
(a menu choice, a pasted key) would otherwise let an agent finish the sign-in
on an account it controls.

A pane counts as one when its terminal was spawned with any sign-in marker:
the window's own ``login_pane`` (set for every sign-in pane it spawns), or the
backend's ``login_profile_id`` / ``live_login`` / ``account_dir_login``. The
marker is remembered when the terminal is created (terminals.py), so it holds
after the PTY exits or its window disconnects, until that pane id is reused
for an ordinary terminal (a restored pane) or the backend restarts. Read-only;
nothing here touches a credential.
"""

from __future__ import annotations

from typing import Any

_LOGIN_MARKERS = ("login_pane", "login_profile_id", "live_login", "account_dir_login")

#: Pane ids whose latest terminal was spawned as a sign-in.
_known: set[str] = set()


def note(pane_id: str, metadata: dict[str, Any] | None) -> None:
    """Record what the terminal just spawned for ``pane_id`` is."""
    if not pane_id:
        return
    if any((metadata or {}).get(key) for key in _LOGIN_MARKERS):
        _known.add(pane_id)
    else:
        _known.discard(pane_id)


def is_login_pane(pane_id: str) -> bool:
    """True when ``pane_id``'s terminal was spawned as a CLI sign-in."""
    if not pane_id:
        return False
    if pane_id in _known:
        return True
    from . import app

    for tid, owner in list(app._PTY_OWNERS.items()):
        term = getattr(owner, "terminals", {}).get(tid)
        if term is None or term.pane_id != pane_id:
            continue
        metadata = term.metadata or {}
        if any(metadata.get(key) for key in _LOGIN_MARKERS):
            return True
    return False


def _reset_for_test() -> None:
    _known.clear()
