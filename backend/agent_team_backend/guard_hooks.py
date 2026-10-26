"""Synchronous PreToolUse decisions for the CLIs that can be blocked by a hook.

Each vendor's installer writes a hook that POSTs the CLI's PreToolUse payload
to `/hooks/<vendor>/pretooluse` and prints the response body back to the CLI.
This module turns that payload into the neutral shape `guard.evaluate` takes
and turns its Decision into the answer the vendor reads.

Fail-open is decided here, not by the caller: anything going wrong (guard not
importable, evaluate raising or running past its budget) yields an empty
response, which every vendor below reads as "no decision" and falls back to
its own permission flow. That is the Phase 0 rule for LOCAL panes: a broken
guard must never wedge every CLI on the machine.

Verified vendor facts (official docs, read 2026-09-24):

claude — code.claude.com/docs/en/hooks. Payload: tool_name, tool_input
  (Bash → tool_input.command; Write/Edit/Read → tool_input.file_path),
  session_id, cwd, permission_mode. Output on exit 0: {"hookSpecificOutput":
  {"hookEventName": "PreToolUse", "permissionDecision": "allow|deny|ask|defer",
  "permissionDecisionReason": ...}}. Exit 2 blocks; any other exit does not.
  An `http` hook exists but its headers take only env-var interpolation (no
  file) and its URL is fixed at install time, so it could neither read the
  0600 hook secret nor follow the backend to a new port; the installed hook is
  therefore a command hook that reads both at fire time and prints our body.
  Measured on claude 2.1.281 (2026-09-24, `claude -p`, marker-file check):
  with --dangerously-skip-permissions a "deny" still blocked the command and
  an "ask" did not run it either (headless has no one to ask); interactive
  bypass + "ask" is not measured.

codex — learn.chatgpt.com/docs/hooks. Payload: tool_name "Bash" (command in
  tool_input.command) or "apply_patch" (patch text in tool_input.command), MCP
  tools as mcp__server__tool. Output: same hookSpecificOutput shape, but only
  "deny" and "allow" are honoured — "ask" is "parsed but not supported yet".
  So an ask is sent to codex as deny, with a reason telling the user to run it
  themselves. Hooks are on by default (`[features] hooks = false` turns them
  off); injected per launch with `-c hooks.PreToolUse=...`, see
  codex_session_hooks.

copilot — docs.github.com/en/copilot/reference/hooks-configuration. Payload:
  toolName, toolArgs (object, or a JSON string), cwd, sessionId. Output is
  FLAT: {"permissionDecision": "allow|deny|ask", "permissionDecisionReason"}.
  A timeout is ALWAYS fail-open ("a timed-out hook surfaces a warning and lets
  the tool call proceed") while a non-zero exit other than 2 DENIES — so the
  hook command must end in `exit 0` and this endpoint must answer well inside
  timeoutSec. Default timeoutSec is 30.

qwen — qwenlm.github.io/qwen-code-docs/en/users/features/hooks. Payload:
  tool_name, tool_input, permission_mode. Output: the claude shape with
  allow|deny|ask; "ask" falls back to deny in headless (--prompt) runs and
  background subagents. Exit 2 blocks. Timeout is seconds, default 60.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

log = logging.getLogger("agent_team_backend.guard_hooks")

#: Vendors with a synchronous PreToolUse hook Navide installs.
VENDORS = frozenset({"claude", "codex", "copilot", "qwen"})

#: A per-pane secret put in each pane's environment at spawn; the claude,
#: qwen and copilot guard hooks send it back as a header. It names the pane
#: when the hook's session id is not attributed yet (a fresh session after
#: /clear, a backend restart). Codex needs none: its launch token already
#: names the pane. A hook fired outside Navide carries none and is unaffected.
PANE_TOKEN_ENV = "NAVIDE_GUARD_PANE_TOKEN"
PANE_TOKEN_HEADER = "X-Navide-Pane-Token"
PANE_TOKEN_VENDORS = frozenset({"claude", "copilot", "qwen"})

#: Budget for one decision. The hooks give up at 9s (curl) inside a 10s hook
#: timeout; answering by 5s keeps a slow guard from ever reaching either, which
#: matters most for copilot, where a hook timeout silently allows.
EVALUATE_BUDGET_S = 5.0

#: Decisions get their own threads: queued behind other work on the loop's
#: shared default executor they could spend the whole budget waiting and
#: fail open without ever being evaluated.
_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="navide-guard")

_ACTION_RANK = {"allow": 0, "ask": 1, "deny": 2}

# Neutral tool names from the guard contract.
_SHELL = "shell"
_WRITE = "write"
_READ = "read"

_SHELL_TOOLS = frozenset({
    "bash", "shell", "exec", "exec_command", "local_shell", "run_shell_command",
    "shell_command", "powershell",
})
_WRITE_TOOLS = frozenset({
    "write", "edit", "multiedit", "notebookedit", "write_file", "edit_file",
    "replace", "str_replace_editor", "create",
})
_READ_TOOLS = frozenset({"read", "read_file", "view"})
_PATH_KEYS = ("file_path", "path", "absolute_path", "notebook_path", "filePath")

# apply_patch names every file it touches on one of these header lines.
_PATCH_FILE = re.compile(r"^\*\*\* (?:Add|Update|Delete) File: (.+)$", re.M)
_PATCH_MOVE = re.compile(r"^\*\*\* Move to: (.+)$", re.M)


def _tool_input(vendor: str, payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    if vendor == "copilot":
        name = str(payload.get("toolName") or "")
        args: Any = payload.get("toolArgs")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                args = {"command": args} if name.lower() in _SHELL_TOOLS else {}
    else:
        name = str(payload.get("tool_name") or "")
        args = payload.get("tool_input")
    return name, args if isinstance(args, dict) else {}


def _command_text(value: Any) -> str:
    if isinstance(value, list):
        # Older codex shell calls carry an argv such as ["bash", "-lc", "..."];
        # the classifier reads a command line, so join it back into one.
        import shlex
        return shlex.join(str(v) for v in value)
    return str(value or "")


def normalise(vendor: str, payload: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """The payload as (tool, tool_input) pairs in the guard contract's shape.

    Usually one pair; apply_patch yields one write per file it touches. A tool
    this does not recognise passes through under its own name, which the guard
    grades normal.
    """
    name, args = _tool_input(vendor, payload)
    lower = name.lower()
    if lower == "apply_patch":
        text = _command_text(args.get("command") or args.get("input") or args.get("patch"))
        paths = _PATCH_FILE.findall(text) + _PATCH_MOVE.findall(text)
        return [(_WRITE, {"path": p.strip()}) for p in paths] or [(name, args)]
    if lower in _SHELL_TOOLS:
        return [(_SHELL, {"command": _command_text(args.get("command"))})]
    # Every path field, and every item of a list-valued one, is graded on its own.
    paths = [
        str(p) for k in (*_PATH_KEYS, "paths") if args.get(k)
        for p in (args[k] if isinstance(args[k], list) else [args[k]]) if p
    ]
    if paths and lower in _WRITE_TOOLS:
        return [(_WRITE, {"path": p}) for p in paths]
    if paths and lower in _READ_TOOLS:
        return [(_READ, {"path": p}) for p in paths]
    return [(name, args)]


def decide(
    vendor: str, payload: dict[str, Any], *, pane_id: str, cwd: str, workspace: str
) -> Any:
    """The strictest guard Decision across everything the call touches."""
    from . import guard

    strictest = None
    for tool, tool_input in normalise(vendor, payload):
        decision = guard.evaluate(
            pane_id=pane_id, vendor=vendor, tool=tool, tool_input=tool_input,
            cwd=cwd, workspace=workspace, source="local",
        )
        if strictest is None or _ACTION_RANK.get(decision.action, 0) > _ACTION_RANK.get(strictest.action, 0):
            strictest = decision
    return strictest


def render(vendor: str, decision: Any) -> dict[str, Any] | None:
    """The vendor-native answer, or None for "no decision" (empty body).

    Allow is answered as no decision on purpose: an explicit allow would skip
    the CLI's own permission prompt, and the guard only ever means to add
    friction, never to remove the user's.
    """
    action = getattr(decision, "action", "allow")
    if action not in ("ask", "deny"):
        return None
    reason = f"Navide Guard: {decision.reason}"
    if vendor == "codex" and action == "ask":
        # Codex cannot ask (see module doc); refusing is the safe reading.
        action = "deny"
        reason += " (needs local confirmation: run it yourself in the terminal)"
    if vendor == "copilot":
        return {"permissionDecision": action, "permissionDecisionReason": reason}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": action,
            "permissionDecisionReason": reason,
        }
    }


async def respond(
    vendor: str, payload: dict[str, Any], *, pane_id: str, cwd: str, workspace: str
) -> dict[str, Any] | None:
    """decide + render with the local fail-open rule applied."""
    try:
        decision = await asyncio.wait_for(
            asyncio.get_running_loop().run_in_executor(
                _EXECUTOR,
                functools.partial(decide, vendor, payload, pane_id=pane_id, cwd=cwd, workspace=workspace),
            ),
            timeout=EVALUATE_BUDGET_S,
        )
    except Exception as err:  # noqa: BLE001 - fail-open for local panes (Phase 0)
        log.warning("guard %s pretooluse failed open for pane %r: %r", vendor, pane_id, err)
        why = f"no decision within {EVALUATE_BUDGET_S:g}s" if isinstance(err, TimeoutError) else repr(err)
        _announce_failure(pane_id, f"Navide Guard error, allowed: {why}")
        return None
    return render(vendor, decision) if decision is not None else None


def _announce_failure(pane_id: str, reason: str) -> None:
    """Tell the window a call went through undecided; never raises (the guard
    itself may be what is broken). Not while the Guard switch is off."""
    try:
        from .guard.engine import _emit_failure, switched_off

        if not switched_off():
            _emit_failure(pane_id, reason)
    except Exception:  # noqa: BLE001
        log.warning("guard: could not announce a fail-open", exc_info=True)
