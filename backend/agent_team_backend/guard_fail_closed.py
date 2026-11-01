"""Guard for a pane nobody is watching: no answer means no.

Everywhere else Guard fails open on purpose, so a bug in it never wedges every
CLI, and a pane that does not bypass permissions has the CLI's own prompt
behind it anyway. An unattended webhook pane has neither a person nor that
prompt, so for it alone a hook that cannot decide refuses the call.

Nothing shared changes. Navide starts such a pane with `ENV` set and one more
PreToolUse hook of its own (`hook_command`), carried by that pane's launch; the
hook every other pane runs and the answers it gets stay as they are. A CLI
takes the strictest answer, so the added hook can only refuse.

What this is for: hook failures. An agent can change the environment of its own
pane, and a hook process that cannot start at all gives the CLI nothing to read,
so this is no defence against an agent trying to get around it.

POSIX only: `unattended_supported` keeps Windows out until it has been measured.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
import shlex
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from . import guard_hooks, osplat

log = logging.getLogger(__name__)

ENV = "NAVIDE_GUARD_FAIL_CLOSED"
HEADER = "X-Navide-Guard-Fail-Closed"

_NO_ANSWER = "Navide Guard could not decide, so this unattended pane refuses the call"


def unattended_supported() -> bool:
    return osplat.platform_id != "win32"


def _denial(vendor: str) -> str:
    """What the hook prints when the backend gives it nothing. Claude and Codex
    read the same shape, and they are the only vendors this runs for."""
    return json.dumps(guard_hooks.render(vendor, SimpleNamespace(action="deny", reason=_NO_ANSWER)))


def hook_command(*, vendor: str, port_expr: str, url_path: str, headers: tuple[str, ...]) -> str:
    """A hook that prints the backend's decision or, for any failure, a denial.

    `{}` is how the backend says no decision, so an empty answer can only mean
    something went wrong. With `ENV` gone the hook steps aside.
    """
    deny = f"printf %s {shlex.quote(_denial(vendor))}; exit 0"
    curl = " ".join([
        "curl -fsS -m 9 -X POST", '-H "Content-Type: application/json"',
        f'-H "{HEADER}: 1"', *headers, f'--data-binary @- "http://127.0.0.1:$PORT{url_path}"',
    ])
    return "; ".join([
        f'[ "${{{ENV}}}" = 1 ] || exit 0',
        f"PORT={port_expr}",
        f'[ -n "$PORT" ] || {{ {deny}; }}',
        f"BODY=$({curl} 2>/dev/null) || {{ {deny}; }}",
        f'[ -n "$BODY" ] || {{ {deny}; }}',
        '[ "$BODY" = "{}" ] && exit 0',
        "printf %s \"$BODY\"",
        "exit 0",
    ])


def claude_settings(port_file: str) -> Path:
    """A settings file for an unattended Claude pane. `--settings` takes one
    file, so this is the pane file every other pane gets, when there is one,
    plus the hook above. Built beside the target and moved into place."""
    from . import claude_hooks, hook_auth
    from .osplat import secret_files

    base = claude_hooks.pane_settings_path()
    settings = json.loads(base.read_text(encoding="utf-8")) if base.is_file() else {}
    command = hook_command(
        vendor="claude",
        port_expr=f"$(cat {shlex.quote(port_file)} 2>/dev/null)",
        url_path="/hooks/claude/pretooluse",
        headers=(
            f"-H @{shlex.quote(str(hook_auth.header_file()))}",
            f'-H "{guard_hooks.PANE_TOKEN_HEADER}: ${guard_hooks.PANE_TOKEN_ENV}"',
        ),
    )
    settings.setdefault("hooks", {}).setdefault("PreToolUse", []).append(
        {"matcher": "*", "hooks": [{"type": "command", "command": command, "timeout": 10}]}
    )
    target = base.with_name("settings-fail-closed.json")
    secret_files.make_private_dir(target.parent)
    staging = target.with_name(f".{target.name}.new")
    secret_files.write_private(staging, json.dumps(settings).encode())
    os.replace(staging, target)
    return target


def codex_hook_command() -> str:
    """The Guard hook an unattended Codex pane would use: same environment, same
    identity as the regular one (see codex_session_hooks). Not wired in. Codex keeps
    one trust entry per hook position, so launching this would replace the trust
    the regular hook holds and ask again in the user's ordinary panes."""
    return hook_command(
        vendor="codex",
        port_expr='$(cat "$NAVIDE_CODEX_PORT_FILE" 2>/dev/null)',
        url_path="/hooks/codex/pretooluse",
        headers=('-H "@$NAVIDE_CODEX_AUTH_FILE"', '-H "X-Navide-Codex-Launch: $NAVIDE_CODEX_LAUNCH"'),
    )


def deny(vendor: str, why: str) -> dict[str, Any]:
    log.warning("guard: refused a call on an unattended pane: %s", why)
    return guard_hooks.render(vendor, SimpleNamespace(action="deny", reason=f"{_NO_ANSWER}: {why}"))


async def respond(vendor: str, payload: Any, *, pane_id: str, cwd: str, workspace: str) -> dict[str, Any]:
    """Always a body: `{}` for no decision, so the hook can tell a real allow
    from silence. Every way of not knowing is a denial."""
    from .guard.engine import switched_off

    if not isinstance(payload, dict):
        return deny(vendor, "the call could not be read")
    if not pane_id:
        return deny(vendor, "the pane is unknown")
    if switched_off():
        return deny(vendor, "Guard is off")
    try:
        decision = await asyncio.wait_for(
            asyncio.get_running_loop().run_in_executor(
                guard_hooks._EXECUTOR,
                functools.partial(guard_hooks.decide, vendor, payload, pane_id=pane_id, cwd=cwd, workspace=workspace),
            ),
            timeout=guard_hooks.EVALUATE_BUDGET_S,
        )
    except Exception as err:  # noqa: BLE001 - not knowing is the whole case
        return deny(vendor, repr(err))
    if decision is None or "guard-error" in decision.rule_ids:
        return deny(vendor, "the rules could not be evaluated")
    return guard_hooks.render(vendor, decision) or {}
