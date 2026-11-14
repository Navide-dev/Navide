"""Which account a pane actually runs on, for cli_get_status and cli_accounts_list.

Read-only: it reads what the backend already holds and changes nothing. Three
facts, all existing state:

  - the live terminal's ``account_dir_profile_id`` metadata, which the spawn
    sets (and only the spawn) when the pane runs in a claude account's own
    config dir (CLAUDE_CONFIG_DIR) instead of the vendor's live credential;
  - the pane's bookkeeping pin (pane_account_history), the account it was
    filed under at spawn or by a failover re-bind;
  - the vendor's active account in the account store, which is whose
    credential every pane NOT in an account dir is running on right now.

Nothing here reads a credential, asks a window, or touches the vault.
"""

from __future__ import annotations

from typing import Any

#: The built-in Default row's id (cli_profiles' DEFAULT_SLOT_ID).
DEFAULT_ACCOUNT_ID = "__default__"


def _account_dir_profile(pane_id: str) -> str:
    """The claude account whose own config dir ``pane_id``'s live terminal
    runs in, or "" when it runs on the live credential (or has no terminal)."""
    from agent_team_backend import app
    from agent_team_backend.ws_handlers import ACCOUNT_DIR_METADATA_KEY

    for tid, owner in list(app._PTY_OWNERS.items()):  # noqa: SLF001
        lookup = getattr(getattr(owner, "terminals", None), "get", None)
        term = lookup(tid) if callable(lookup) else None
        if term is None or getattr(term, "closed", False) or getattr(term, "pane_id", None) != pane_id:
            continue
        return str(getattr(term, "metadata", {}).get(ACCOUNT_DIR_METADATA_KEY) or "")
    return ""


def _live_profile(doc: dict[str, Any], agent_key: str) -> str:
    """The vendor's active account, read as cli_accounts_list's `active` reads it."""
    return str((doc.get("defaults") or {}).get(agent_key) or DEFAULT_ACCOUNT_ID)


def pane_account(pane_id: str, agent_key: str, doc: dict[str, Any]) -> dict[str, Any] | None:
    """{profile_id, runs_on, live_profile_id, pin} for one pane, or None for a
    vendor Navide keeps no accounts for. ``doc`` is cli_profiles_store.list()."""
    from agent_team_backend import app
    from agent_team_backend.profiles_store import SUPPORTED_AGENT_KEYS

    if agent_key not in SUPPORTED_AGENT_KEYS:
        return None
    live = _live_profile(doc, agent_key)
    account_dir = _account_dir_profile(pane_id)
    return {
        "profile_id": account_dir or live,
        "runs_on": "account-dir" if account_dir else "live",
        "live_profile_id": live,
        "pin": app.pane_account_history.current_profile(pane_id),
    }


def pane_status_account(pane_id: str, agent_key: str) -> dict[str, Any] | None:
    """pane_account with the store read here. Blocking (the store is a
    file): call it off the loop."""
    from agent_team_backend import app
    from agent_team_backend.profiles_store import SUPPORTED_AGENT_KEYS

    if agent_key not in SUPPORTED_AGENT_KEYS:
        return None
    return pane_account(pane_id, agent_key, app.cli_profiles_store.list())


def pane_rows(doc: dict[str, Any], agent: str = "") -> list[dict[str, Any]]:
    """One row per local pane of a vendor with accounts, in cli_accounts_list's
    camelCase: {paneId, name, address, agentKey, profileId, runsOn}. ``agent``
    narrows it to one vendor key."""
    from agent_team_backend import agent_messaging

    rows: list[dict[str, Any]] = []
    for entry in agent_messaging.list_panes():
        if agent and entry.agent_key != agent:
            continue
        account = pane_account(entry.pane_id, entry.agent_key, doc)
        if account is None:
            continue
        rows.append({
            "paneId": entry.pane_id,
            "name": entry.name,
            "address": entry.qualified_name,
            "agentKey": entry.agent_key,
            "profileId": account["profile_id"],
            "runsOn": account["runs_on"],
        })
    return rows
