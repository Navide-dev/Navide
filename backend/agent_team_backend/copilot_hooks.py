"""Install a GitHub Copilot CLI hook that reports when a pane is waiting.

Unlike Claude and Qwen, Copilot loads every ``*.json`` under its hooks
directory on its own, with no registration anywhere else. That lets us own a
single file end to end — ``$COPILOT_HOME/hooks/agent-team.json`` — instead of
merging into a document the user also edits, so there is nothing of theirs to
preserve, corrupt, or back up. The file is rewritten wholesale each startup.

Copilot's handler shape is FLAT (``{"command": ..., "timeoutSec": ...}``),
not Claude's nested ``{"hooks": [{"type": "command", ...}]}``. It accepts the
nested form through a compatibility layer, but the flat one is native.

We install ONE event: ``notification`` (lowercase — Copilot's event names are
not Claude's). It carries the same ``notification_type`` vocabulary the other
two vendors use, and ``permission_prompt`` there was measured to fire only
when a prompt actually blocks the turn. Its sibling ``permissionRequest`` hook
is deliberately NOT used: it also fires when a tool is auto-approved (verified
with --allow-all-tools), which would report a working pane as blocked.

A second event, ``preToolUse``, carries Navide Guard's synchronous decision
(see guard_hooks for the verified Copilot facts, notably timeout = allow).
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from . import osplat

log = logging.getLogger("agent_team_backend.copilot_hooks")

# Our file inside Copilot's hooks directory. Named for the product so a user
# reading the directory can tell where it came from.
_HOOK_FILENAME = "agent-team.json"


def hooks_dir() -> Path:
    """Resolve ~/.copilot/hooks. Honours $COPILOT_HOME (the config ROOT)."""
    env = os.environ.get("COPILOT_HOME")
    root = Path(env) if env else Path.home() / ".copilot"
    return root / "hooks"


def _build_command(port_file: str, shell: str) -> str:
    """One `shell` one-liner forwarding the hook's stdin JSON to this backend.

    Reads the port at fire time so it survives backend restarts. Ends in
    `exit 0` unconditionally: a non-zero exit is how a Copilot hook reports
    failure, and curl exits non-zero whenever the backend is down — which is
    the normal state when Navide is not running.
    """
    from . import hook_auth

    # The secret comes out of a 0600 file at fire time (`-H @file`); see hook_auth.
    return osplat.scripts_by_shell[shell].hook_post_json(
        port_file=port_file,
        header_file=str(hook_auth.header_file()),
        url_path="/hooks/copilot",
        event="notification",
        timeout_s=2,
        exit_zero=True,
    )


#: Navide Guard's hook budget. Copilot lets a call through when a hook times
#: out, so curl (9s) and the backend's evaluate budget (5s) both finish first.
_GUARD_TIMEOUT_S = 10


def _build_guard_command(port_file: str, shell: str) -> str:
    """The synchronous preToolUse hook: POST the payload, print the decision.

    Unlike the notification hook, the body is kept — it is the decision
    (guard_hooks.render). The exit is still 0 no matter what: in Copilot a
    non-zero preToolUse exit DENIES the call, so a backend that is down must
    read as "no decision", not as a refusal of every tool.
    """
    from . import guard_hooks, hook_auth

    return osplat.scripts_by_shell[shell].hook_post_json(
        port_file=port_file,
        header_file=str(hook_auth.header_file()),
        url_path="/hooks/copilot/pretooluse",
        event="pre_tool_use",
        timeout_s=_GUARD_TIMEOUT_S - 1,
        keep_body=True,
        exit_zero=True,
        env_header=(guard_hooks.PANE_TOKEN_HEADER, guard_hooks.PANE_TOKEN_ENV),
    )


def install_hooks(port_file: str, hooks_directory: Path | None = None) -> dict[str, Any]:
    """Write our hook file. Idempotent by construction — the file is ours.

    Skipped when Copilot's config root does not exist: creating it would
    provision a directory tree for a CLI the user has not installed.
    """
    directory = hooks_directory or hooks_dir()
    if hooks_directory is None and not directory.parent.is_dir():
        return {"installed": False, "path": str(directory), "reason": "copilot not configured"}

    path = directory / _HOOK_FILENAME
    document = _document(port_file)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_text(json.dumps(document, indent=2), encoding="utf-8")
            os.replace(tmp, path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
    except OSError as err:
        log.warning("could not write copilot hook file: %s", err)
        return {"installed": False, "path": str(path), "error": str(err)}

    log.info("installed Copilot hook → %s (port_file=%s)", path, port_file)
    return {"installed": True, "path": str(path), "events": 2, "port_file": port_file}


def _document(port_file: str) -> dict[str, Any]:
    """Navide's hook file, the same for the shared folder and the panes."""
    return {
        "version": 1,
        "disableAllHooks": False,
        "hooks": {
            "notification": [
                {
                    # `command` is the cross-platform fallback Copilot copies
                    # into whichever shell it runs; `bash` and `powershell`
                    # take precedence over it per platform. All three are
                    # written on every platform because this one file is read
                    # wherever Copilot runs, not only where it was installed.
                    "command": _build_command(port_file, "bash"),
                    "bash": _build_command(port_file, "bash"),
                    "powershell": _build_command(port_file, "powershell"),
                    "timeoutSec": 5,
                }
            ],
            "preToolUse": [
                {
                    "command": _build_guard_command(port_file, "bash"),
                    "bash": _build_guard_command(port_file, "bash"),
                    "powershell": _build_guard_command(port_file, "powershell"),
                    "timeoutSec": _GUARD_TIMEOUT_S,
                }
            ],
        },
    }


def uninstall_hooks(hooks_directory: Path | None = None) -> dict[str, Any]:
    """Delete our hook file. Other files in the directory are the user's."""
    path = (hooks_directory or hooks_dir()) / _HOOK_FILENAME
    if not path.is_file():
        return {"removed": False, "path": str(path), "reason": "hook file absent"}
    try:
        path.unlink()
    except OSError as err:
        log.warning("could not remove copilot hook file: %s", err)
        return {"removed": False, "path": str(path), "error": str(err)}
    log.info("removed Copilot hook → %s", path)
    return {"removed": True, "path": str(path)}


# ── Phase 3: the hooks ride on the panes Navide starts ─────────────────────
#
# Copilot merges every hook file it finds, so a pane whose COPILOT_HOME shim
# has a real ``hooks`` folder — Navide's file plus a link to each of the
# user's — runs both sets (verified for sessionStart, userPromptSubmitted,
# preToolUse and sessionEnd, fresh and --resume) and nothing is written under
# ~/.copilot. The shim's folder links to Navide's file rather than copying it:
# the one file in Navide's data is rewritten at every startup, so no pane can
# keep a stale copy of it.


def pane_hooks_file() -> Path:
    """Navide's hook file for the panes, inside Navide's own data."""
    from .applog import app_data_dir

    return app_data_dir() / "runtime" / "copilot" / "hooks" / _HOOK_FILENAME


def prepare_pane_hooks(port_file: str, skip: frozenset[str]) -> Path:
    """The pane carrier's ``prepare``: write the file the shared folder held.

    ``skip`` is always empty here — the file is Navide's alone, so the user
    removes it whole, never one hook of it (convenience_wiring._PER_HOOK).

    Raises when the panes could not carry it — no skills plugin to build
    their shims, or a COPILOT_HOME the shims do not mirror — so the shared
    file stays in use instead.
    """
    from .osplat import secret_files
    from .plugins.builtin.navide_skills import skills_wiring

    if not skills_wiring.active():
        raise RuntimeError("the skills plugin that builds the pane shims is not running")
    mirrored = skills_wiring.real_home() / ".copilot"
    if _resolved(hooks_dir().parent) != _resolved(mirrored):
        raise RuntimeError(f"COPILOT_HOME {hooks_dir().parent} is not the {mirrored} the pane shims mirror")
    path = pane_hooks_file()
    secret_files.make_private_dir(path.parent)
    secret_files.write_private_plain(path, json.dumps(_document(port_file), indent=2).encode("utf-8"))
    return path


def another_backends(path: Path) -> bool:
    """Whether ``path`` is a Navide hook file another backend wrote — the
    installed app's, seen from a dev backend beside it, or the other way
    round. Its commands read their secret from that backend's data folder."""
    from . import hook_auth
    from .applog import app_data_dir

    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    text = "\n".join(_strings(document))
    return "/hooks/copilot" in text and str(app_data_dir() / hook_auth.FILENAME) not in text


def _resolved(folder: Path) -> Path:
    try:
        return folder.resolve()
    except OSError:
        return folder


def _strings(node: Any) -> list[str]:
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        node = list(node.values())
    if isinstance(node, list):
        return [text for item in node for text in _strings(item)]
    return []


def wire_pane_hooks(shim: Path, user_hooks: Path) -> None:
    """Rebuild a pane shim's ``hooks`` entry; run on every spawn.

    While the panes carry Navide's hooks it is a real folder: Navide's file
    plus a fresh link to each entry of ``user_hooks``, so a file the user
    adds later is seen. A user file with Navide's name is linked under
    ``agent-team.user.json`` rather than hidden, and anything the pane holds
    in Navide's place is moved aside the same way; another backend's Navide
    file is left out, as this pane reports to this backend only. Otherwise
    it is what it always was, a link to ``user_hooks``. Nothing is written
    under ``user_hooks``.
    """
    from .convenience_wiring import pane_carries_hooks

    hooks = shim / "hooks"
    if hooks.is_dir() and not hooks.is_symlink():
        # Only the links made here; one the CLI made itself stays.
        for entry in hooks.iterdir():
            if entry.is_symlink() and _ours(entry, user_hooks):
                entry.unlink()
    if not pane_carries_hooks("copilot"):
        if hooks.is_dir() and not hooks.is_symlink():
            try:
                hooks.rmdir()
            except OSError:
                # Something the CLI made here: kept, never moved into ~/.copilot.
                log.warning("%s holds files of its own; leaving it a folder", hooks)
                return
        if not hooks.is_symlink() and user_hooks.is_dir():
            hooks.symlink_to(user_hooks, target_is_directory=True)
        return
    if hooks.is_symlink():
        hooks.unlink()
    hooks.mkdir(exist_ok=True)
    theirs = sorted(user_hooks.iterdir()) if user_hooks.is_dir() else []
    names = {entry.name for entry in theirs} | {entry.name for entry in hooks.iterdir()}
    mine = hooks / _HOOK_FILENAME
    if mine.exists() or mine.is_symlink():
        # Anything else in Navide's place would silently cost the pane its
        # hooks, Navide Guard included: moved aside, kept and still loaded.
        aside = hooks / _free_name(names)
        log.warning("moving %s aside to %s to make room for Navide's hooks", mine, aside)
        os.replace(mine, aside)
        names.add(aside.name)
    links = {_HOOK_FILENAME: pane_hooks_file()}
    for entry in theirs:
        name = entry.name
        if name == _HOOK_FILENAME:
            if another_backends(entry):
                log.info("leaving another backend's %s out of the pane", entry)
                continue
            name = _free_name(names)
        links[name] = entry
    for name, target in links.items():
        link = hooks / name
        if link.exists() or link.is_symlink():
            log.warning("%s is a file of the pane's own; not linking %s", link, target)
            continue
        link.symlink_to(target, target_is_directory=target.is_dir())


def _ours(link: Path, user_hooks: Path) -> bool:
    """Whether ``link`` is one wire_pane_hooks made: to Navide's file or
    to an entry of the user's hooks folder."""
    try:
        target = Path(os.readlink(link))
    except OSError:
        return False
    return target == pane_hooks_file() or target.parent == user_hooks


def _free_name(taken: set[str]) -> str:
    stem, suffix = os.path.splitext(_HOOK_FILENAME)
    name, n = f"{stem}.user{suffix}", 1
    while name in taken:
        n += 1
        name = f"{stem}.user{n}{suffix}"
    return name
