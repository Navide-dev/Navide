"""Navide's Kiro CLI hook: report the end of every turn to this backend.

Kiro CLI (V3 harness) loads every ``*.json`` under its global hooks directory,
``<KIRO_HOME or ~/.kiro>/hooks/`` (kiro.dev/docs/hooks, read 2026-11-12), so
Navide owns one file there end to end. Unlike Copilot's, that file is never
written into the user's own ``~/.kiro``: it lives only in a pane's per-pane
``KIRO_HOME`` (mcp_server/pane_home.py), next to the pane's MCP config, so a
Kiro session the user runs outside Navide never posts to Navide.

The file declares one hook, trigger ``Stop`` (the docs' "Agent Stop", fired
when the agent finishes its turn). Its command pipes the hook's stdin JSON
(``hook_event_name``, ``cwd``, ``session_id``) to ``/hooks/kiro`` as a ``stop``
event. Navide reads no Kiro session store, so the session id names no pane;
the command also sends the pane's spawn token, which is how ``cli_hook`` finds
the pane (``VendorSpec.hook_pane_token``).

The command always exits 0: on any other exit Kiro hands the hook's stderr to
the agent as an error, and curl exits non-zero whenever Navide is not running.
"""

from __future__ import annotations

import json
from typing import Any

from . import osplat

#: Our file in the pane's hooks directory, named for the product.
HOOK_FILENAME = "navide.json"
HOOKS_DIRNAME = "hooks"

#: Seconds Kiro waits for the hook (its default is 60). curl gives up first.
_TIMEOUT_S = 5


def _build_command(port_file: str) -> str:
    from . import guard_hooks, hook_auth

    return osplat.scripts.hook_post_json(
        port_file=port_file,
        header_file=str(hook_auth.header_file()),
        url_path="/hooks/kiro",
        event="stop",
        timeout_s=_TIMEOUT_S - 1,
        exit_zero=True,
        # The pane's spawn token (see ws_handlers' spawn path): the only thing
        # in the hook's environment that names the pane.
        env_header=(guard_hooks.PANE_TOKEN_HEADER, guard_hooks.PANE_TOKEN_ENV),
    )


def document(port_file: str) -> dict[str, Any]:
    """The hook file, in the V3 standalone-hook schema."""
    return {
        "version": "v1",
        "hooks": [
            {
                "name": "navide-turn-end",
                "description": "Tells Navide this pane's turn ended.",
                "trigger": "Stop",
                "action": {"type": "command", "command": _build_command(port_file)},
                "timeout": _TIMEOUT_S,
            }
        ],
    }


def render(port_file: str) -> str:
    return json.dumps(document(port_file), indent=2) + "\n"


def install_hooks(port_file: str) -> dict[str, Any]:
    """Startup installer: nothing to write into the user's ``~/.kiro``.

    Declared so the vendor is admitted to ``/hooks/kiro`` (installing and
    being allowed to post are one decision, see app._HOOK_VENDORS). The file
    itself is written per pane, at spawn, by mcp_server/pane_home.py.
    """
    return {"installed": False, "reason": "written into each pane's KIRO_HOME at spawn"}
