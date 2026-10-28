"""cli_open_agent's `account`: which account the new pane runs on.

Plan mcp-pane-cli-usage_213031 P3. This adds no way of choosing an account.
It hands the request to the one that already exists: a spawn with an explicit
pin (``metadata.profile_id``), which the UI's 📌 pin, "switch only this pane"
and restores use. For claude, the backend's _account_dir_for_spawn runs such
a pane in that account's own folder (CLAUDE_CONFIG_DIR) once the account has
signed in there. Nothing here switches the live credential, writes
paneDefaults, or touches any other pane.

  - "" / "inherit" (the default): the account the calling pane runs on. Only a
    pane in an account's own folder runs on anything but the live login, so
    only then is a pin passed on; every other case opens the pane exactly as
    "active" does.
  - "active": no pin, the vendor's live login, as before this parameter.
  - an account id: that account's folder, refused when it cannot run there.

``resolve`` is blocking (the account store is a file, and the folder sign-in
check is a Keychain presence check on macOS): call it off the loop.
"""

from __future__ import annotations

from typing import Any

INHERIT = "inherit"
ACTIVE = "active"
#: The built-in Default row's id (cli_profiles' DEFAULT_SLOT_ID).
DEFAULT_ACCOUNT_ID = "__default__"
#: The only vendor with account folders (ws_handlers._account_dir_for_spawn).
FOLDER_AGENT = "claude"


class Resolved:
    """What to send and what to report: ``pin`` is the explicit profile id for
    the spawn ("" = none, the old payload), ``mode`` what was asked for."""

    def __init__(self, mode: str, pin: str = "", advisory: str = "") -> None:
        self.mode = mode
        self.pin = pin
        self.advisory = advisory


def _refusal(error_code: str, error: str) -> dict[str, Any]:
    return {"ok": False, "error": f"{error}; no pane was opened", "error_code": error_code}


def _account_dir_of(pane_id: str) -> str:
    """The claude account whose own folder ``pane_id``'s live terminal runs
    in, or "" when it runs on the live login."""
    from agent_team_backend import app
    from agent_team_backend.ws_handlers import ACCOUNT_DIR_METADATA_KEY

    for tid, owner in list(app._PTY_OWNERS.items()):  # noqa: SLF001
        lookup = getattr(getattr(owner, "terminals", None), "get", None)
        term = lookup(tid) if callable(lookup) else None
        if term is None or getattr(term, "closed", False) or getattr(term, "pane_id", None) != pane_id:
            continue
        return str(getattr(term, "metadata", {}).get(ACCOUNT_DIR_METADATA_KEY) or "")
    return ""


def resolve(agent_key: str, account: str, caller_pane_id: str, caller_agent_key: str) -> Resolved | dict[str, Any]:
    """The pin for a cli_open_agent spawn, or a refusal dict for an account
    that cannot be used. ``caller_pane_id`` is "" for a caller with no pane."""
    from agent_team_backend import app

    asked = (account or "").strip()
    if asked in ("", INHERIT):
        if not caller_pane_id or caller_agent_key != agent_key or agent_key != FOLDER_AGENT:
            return Resolved(INHERIT)
        parent = _account_dir_of(caller_pane_id)
        if not parent:
            return Resolved(INHERIT)
        if not app.credential_vault.account_dir_signed_in(parent):
            return Resolved(INHERIT, advisory=(
                f"inherit-account-dir-signed-out: the account you run on ({parent}) is no longer "
                "signed in inside its own folder, so the new pane runs on the live login instead"
            ))
        return Resolved(INHERIT, pin=parent)
    if asked == ACTIVE:
        return Resolved(ACTIVE)

    doc = app.cli_profiles_store.list()
    live = str((doc.get("defaults") or {}).get(agent_key) or DEFAULT_ACCOUNT_ID)
    if asked == DEFAULT_ACCOUNT_ID:
        if live == DEFAULT_ACCOUNT_ID:
            return Resolved(asked)
        return _refusal("unsupported", (
            "the built-in Default account has no folder of its own, so a pane can only run on it "
            "while it is the live login; switch to it with cli_account_switch, or pass another account"
        ))
    row = next((r for r in doc.get("profiles") or [] if r.get("id") == asked), None)
    if row is None:
        return _refusal("unknown-profile", f'no account "{asked}"; cli_accounts_list lists them')
    if row.get("agentKey") != agent_key:
        return _refusal("vendor-mismatch", f'account "{asked}" belongs to {row.get("agentKey")}, not {agent_key}')
    if agent_key != FOLDER_AGENT:
        return _refusal("unsupported", (
            f"{agent_key} panes all run on its live login; only claude can run one pane on another "
            "account. Use account \"active\", or cli_account_switch to change the live login"
        ))
    if asked == live:
        # The live login already is that account: a pin would only stop the
        # pane following a later switch, which nobody asked for.
        return Resolved(asked)
    if not app.credential_vault.account_dir_signed_in(asked):
        return _refusal("needs-user", (
            f'account "{asked}" has not signed in inside its own folder yet; sign it in with '
            'cli_account_sign_in(mode="folder") (the user completes it), then open the pane'
        ))
    return Resolved(asked, pin=asked)


def report(resolved: Resolved, new_pane_id: str, agent_key: str) -> dict[str, Any]:
    """cli_open_agent's `account` answer, read back from the pane that opened:
    {mode, profile_id, runs_on, fixed}. `fixed` is the renderer's own rule for
    a pane spawned with a pin it can run in: it no longer follows a switch."""
    from agent_team_backend import app

    in_dir = _account_dir_of(new_pane_id) if new_pane_id else ""
    if in_dir:
        return {"mode": resolved.mode, "profile_id": in_dir, "runs_on": "account-dir", "fixed": True}
    active = app.cli_profiles_store.get_default_profile(agent_key)
    return {
        "mode": resolved.mode,
        "profile_id": str(active["id"]) if active else DEFAULT_ACCOUNT_ID,
        "runs_on": "live",
        "fixed": False,
    }
