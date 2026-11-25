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

Navide Guard (POSIX only): a second hook, trigger ``PreToolUse``, posts the
call to ``/hooks/kiro/pretooluse`` (guard_hooks). Kiro reads no JSON decision
from a PreToolUse hook; exit 2 blocks the tool and hands stderr to the agent
(/docs/reference/exit-codes). So the command exits 2 with the backend's body on
stderr only when the backend answers (it answers only a deny), and exits 0 on
everything else: no backend, curl missing or failing, an empty answer. Kiro
Guard is NOT VERIFIED ON A REAL INSTALL and fails open for now. It never sends
guard_fail_closed's header, so no Kiro pane is ever fail-closed. Windows gets
no Guard hook until its shell spelling is measured.
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

#: The Guard hook's budget: curl gives up at 9s, the backend answers by 5s
#: (guard_hooks.EVALUATE_BUDGET_S), as for the other vendors' guard hooks.
_GUARD_TIMEOUT_S = 10


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


def _build_guard_command(port_file: str) -> str:
    """POSIX: exit 2 with the body on stderr when the backend answers, else 0."""
    import shlex

    from . import guard_hooks, hook_auth

    post = osplat.scripts._post(
        header_file=str(hook_auth.header_file()),
        url_path="/hooks/kiro/pretooluse",
        event="pre_tool_use",
        timeout_s=_GUARD_TIMEOUT_S - 1,
        discard=False,
        env_header=(guard_hooks.PANE_TOKEN_HEADER, guard_hooks.PANE_TOKEN_ENV),
    )
    return (
        f"PORT=$(cat {shlex.quote(port_file)} 2>/dev/null); "
        '[ -n "$PORT" ] || exit 0; '
        f"BODY=$({post} 2>/dev/null) || exit 0; "
        '[ -n "$BODY" ] || exit 0; '
        "printf '%s\\n' \"$BODY\" >&2; exit 2"
    )


def document(port_file: str) -> dict[str, Any]:
    """The hook file, in the V3 standalone-hook schema."""
    hooks: list[dict[str, Any]] = [
        {
            "name": "navide-turn-end",
            "description": "Tells Navide this pane's turn ended.",
            "trigger": "Stop",
            "action": {"type": "command", "command": _build_command(port_file)},
            "timeout": _TIMEOUT_S,
        }
    ]
    if osplat.platform_id != "win32":
        # No matcher: Kiro's default is every tool (kiro.dev/docs/hooks).
        hooks.append({
            "name": "navide-guard",
            "description": "Navide Guard (not verified on a real install; fails open).",
            "trigger": "PreToolUse",
            "action": {"type": "command", "command": _build_guard_command(port_file)},
            "timeout": _GUARD_TIMEOUT_S,
        })
    return {"version": "v1", "hooks": hooks}


def render(port_file: str) -> str:
    return json.dumps(document(port_file), indent=2) + "\n"


def install_hooks(port_file: str) -> dict[str, Any]:
    """Startup installer: nothing to write into the user's ``~/.kiro``.

    Declared so the vendor is admitted to ``/hooks/kiro`` (installing and
    being allowed to post are one decision, see app._HOOK_VENDORS). The file
    itself is written per pane, at spawn, by mcp_server/pane_home.py.
    """
    return {"installed": False, "reason": "written into each pane's KIRO_HOME at spawn"}
