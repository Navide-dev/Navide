"""Claude Code hook installer + payload normaliser.

Claude Code (CLI) supports hooks: `~/.claude/settings.json` may declare shell
commands to run at specific lifecycle events (PreToolUse / Stop / Notification
/ SubagentStop / etc.). Each hook receives a JSON payload on stdin.

We install seven hooks pointing at our local FastAPI endpoint so the
orchestrator gets reliable signals (better than buffer-scanning):
  - PreToolUse         → 100% signal: agent is actively working
  - Stop               → 100% signal: turn ended
  - Notification       → user attention requested (e.g. waiting for approval)
  - SubagentStop       → a subagent (Task tool) finished
  - PermissionRequest  → the permission box is about to open (report-only)
  - PostToolUse        → a tool finished; with PostToolUseFailure, tells the
    PostToolUseFailure   frontend the box for that tool was answered (async)

PreToolUse also carries a second, synchronous hook: Navide Guard's decision
(`_build_guard_command`), whose printed body can deny or ask for the call.

PreToolUse and SubagentStop together are what let the backend count the
background subagents a pane is waiting on: Task going in, its stop coming
back out. The unattended loop reads that count to tell "the turn ended
because the work is done" apart from "the turn ended to wait", which no
amount of buffer-scanning could distinguish.

The installer is MERGE-safe: it reads the existing settings.json, only adds
our hook entries (tagged with a sentinel comment), and never overwrites the
user's other settings. Removal cleans up only entries we added.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import stat
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from . import osplat

log = logging.getLogger("agent_team_backend.claude_hooks")

# Sentinel that marks a hook command as ours (so we can identify our entries
# on subsequent runs without touching the user's own hooks).
_AGENT_TEAM_MARKER = "# agent-team-hook"

# Lifecycle events we want signals for. Mapping to a stable kind label used
# both in the curl command (POST body) and in our marker.
_HOOK_EVENTS: dict[str, str] = {
    "PreToolUse": "pre_tool_use",
    "Stop": "stop",
    "Notification": "notification",
    "SubagentStop": "subagent_stop",
    # The permission-box pair. PermissionRequest runs only when Claude Code is
    # about to show its permission dialog; ours reports it and returns no
    # decision, so the dialog appears exactly as it would without us. The
    # answer then shows up as the tool finishing (PostToolUse /
    # PostToolUseFailure) or, for a denial — which fires no hook at all — as
    # the denial record in the transcript.
    "PermissionRequest": "permission_request",
    "PostToolUse": "post_tool_use",
    "PostToolUseFailure": "post_tool_use_failure",
}

#: Report-only events that fire once per tool call. Claude Code runs a command
#: hook flagged `"async": true` in the background without waiting for it, so
#: these two add no hook latency to every tool call. Safe because nothing reads
#: their reply — the hook already discards the response body — and they are
#: never needed before the tool proceeds. PermissionRequest stays synchronous:
#: it fires once per box, and the box should not open before it has reported.
_ASYNC_EVENTS: frozenset[str] = frozenset({"PostToolUse", "PostToolUseFailure"})

#: Events that also arm the background rewake waiter — the hook that lets an
#: inter-CLI message reach a claude pane that is sitting IDLE, which is the one
#: moment the Stop hook above cannot cover. SessionStart puts one in place for a
#: pane that starts idle; Stop re-arms it after every turn, which is what keeps
#: the channel alive for the rest of the session.
#:
#: UserPromptSubmit is deliberately left out. It would re-arm more often, but
#: exiting 2 on that event normally means "erase the prompt the user just
#: typed"; asyncRewake is documented to route exit 2 through the wake path
#: instead, and that has not been verified here. The gain does not justify the
#: failure mode.
_REWAKE_EVENTS: tuple[str, ...] = ("SessionStart", "Stop")

#: How long the hook itself allows the parked request to run. Ordered above the
#: backend's own `push_delivery.HOOK_WAIT_S` and the curl deadline below it, so
#: the backend is always the one that gives up first: a curl that timed out
#: while the backend still believed in its waiter would take a message with it.
_REWAKE_TIMEOUT_S = 2100
_REWAKE_CURL_TIMEOUT_S = 1860


def settings_path() -> Path:
    """Resolve ~/.claude/settings.json. Honours $CLAUDE_CONFIG_DIR override."""
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    if env:
        return Path(env) / "settings.json"
    return Path.home() / ".claude" / "settings.json"


#: Response timeout for the Stop hook, which is the one event whose reply the
#: CLI acts on. Wider than the others' 2s so it outlasts the backend's own
#: `hook_drain.DRAIN_TIMEOUT_S` wait for the owning window — a curl that gave up
#: first would throw away a message the window had already marked delivered.
_STOP_TIMEOUT_S = 4


def _build_curl_command(port_file: str, event_kind: str, endpoint: str = "claude") -> str:
    """Build a curl invocation that forwards the hook stdin payload to us.

    Reads the current backend port from `port_file` at hook-fire time so the
    command survives backend restarts with different ports. If the file is
    absent (backend not running), the curl is skipped via the `|| true` tail.

    Hard-caps the request + `|| true` so a slow/offline backend never blocks the
    agent's main work. `--data-binary @-` preserves the JSON stdin verbatim.

    The Stop hook keeps the response body, because that is where Claude Code
    reads a hook's decision from: an inter-CLI message waiting for this pane
    comes back as `{"decision": "block", ...}` and becomes the agent's next
    instruction without ever touching its input box (see `hook_drain`). Nothing
    to deliver means an empty body, which is exactly "no decision to report".
    Every other event still discards it — their responses are acks, and an
    unrecognized object on a hook's stdout is reported as a hook error.

    `endpoint` is the vendor segment of /hooks/<vendor>; it defaults to claude
    so hook commands written by earlier builds keep the exact same text (the
    installer compares by marker, but an unchanged command also means an
    unchanged settings.json diff).
    """
    from . import hook_auth

    # Claude's Stop hook only: qwen borrows this builder, and nothing has
    # established that its CLI reads a hook's stdout the same way.
    keeps_body = event_kind == "stop" and endpoint == "claude"
    # The secret is read out of a 0600 file when the hook fires (`-H @file`),
    # never written into this command: settings.json is world readable and
    # `ps` would show an argument. See hook_auth.
    return f"{_AGENT_TEAM_MARKER} kind={event_kind}\n" + osplat.scripts.hook_post_json(
        port_file=port_file,
        header_file=str(hook_auth.header_file()),
        url_path=f"/hooks/{endpoint}",
        event=event_kind,
        timeout_s=_STOP_TIMEOUT_S if keeps_body else 2,
        keep_body=keeps_body,
    )


#: Navide Guard's synchronous PreToolUse decision. The hook's own timeout sits
#: above curl's deadline, which sits above the backend's evaluate budget
#: (guard_hooks.EVALUATE_BUDGET_S), so a slow guard is always given up on by
#: the backend first and answered with "no decision".
GUARD_EVENT = "PreToolUse"
_GUARD_TIMEOUT_S = 10
_GUARD_CURL_TIMEOUT_S = 9


def _build_guard_command(port_file: str, endpoint: str = "claude") -> str:
    """Build the Navide Guard hook: POST the payload, print the decision.

    A separate hook object from the PreToolUse signal hook, which stays
    fire-and-forget: the two run side by side, so activity detection is not
    made to wait on the guard and the guard's body is the only one the CLI
    reads. Fails open by construction — no port file, a refused connection,
    a 403 or a timeout all leave stdout empty and the exit code 0, which is
    "no decision" and lets the CLI's own permission flow carry on.

    A command hook rather than Claude Code's `type: "http"`: an http hook's
    URL is fixed when written and its headers interpolate env vars only, so
    it could neither follow the backend to a new port nor send the secret,
    which lives in a 0600 file (see hook_auth). Qwen shares this builder.
    """
    from . import guard_hooks, hook_auth

    return f"{_AGENT_TEAM_MARKER} kind=guard\n" + osplat.scripts.hook_post_json(
        port_file=port_file,
        header_file=str(hook_auth.header_file()),
        url_path=f"/hooks/{endpoint}/pretooluse",
        event="pre_tool_use",
        timeout_s=_GUARD_CURL_TIMEOUT_S,
        keep_body=True,
        env_header=(guard_hooks.PANE_TOKEN_HEADER, guard_hooks.PANE_TOKEN_ENV),
    )


def guard_hook_entry(port_file: str, endpoint: str = "claude") -> dict[str, Any]:
    script = _windows_guard_script(port_file) if endpoint == "claude" else None
    if script is not None:
        # Exec form: Claude Code starts cmd.exe itself, with no PowerShell in
        # between. A PowerShell 5.1 cold start alone can outlast the hook
        # timeout on a loaded arm64 machine, where Claude Code cancels the
        # hook and lets the tool call through undecided.
        return {
            "type": "command",
            "command": "cmd.exe",
            "args": ["/d", "/c", str(script)],
            "timeout": _GUARD_TIMEOUT_S,
        }
    return {
        **osplat.scripts.hook_entry(_build_guard_command(port_file, endpoint)),
        "timeout": _GUARD_TIMEOUT_S,
    }


#: The first Claude Code build that runs a hook's `args` (exec form) without a
#: shell. An older one ignores `args` and runs a bare `cmd.exe` under the
#: shell, which reads the hook's JSON as commands — so the exec form is written
#: only once a probe has seen a new enough build, and the PowerShell hook stays
#: otherwise.
_EXEC_FORM_SINCE = (2, 1, 139)
_GUARD_SCRIPT_NAME = "navide-guard.cmd"
_CLAUDE_VERSION_KV_KEY = "claude_hooks_cli_version"
#: `cmd /c "<path>"` keeps the quotes Node puts around a path with a space only
#: when none of these sit between them (`cmd /?`); a path with one falls back.
_CMD_UNSAFE = frozenset('&<>()@^|"%!')
_version_refresh_started = False


def _guard_script_text(port_name: str, header_name: str) -> str:
    """The batch file behind the exec-form guard hook.

    ASCII only, because cmd reads a batch file in the OEM code page: the paths
    it needs are siblings of the script and reach it through `%~dp0`, which
    cmd expands as Unicode at run time. Same request, headers and output
    contract as the PowerShell hook: the body is the decision, and every path
    exits 0, which is "no decision". An unset pane token expands to nothing
    in a batch file, as it does in PowerShell. curl is the system one by full
    path, never `curl.exe` off PATH: a Git or MSYS2 bin directory ahead of
    System32 supplies a curl that reads its arguments in the ANSI code page,
    so a non-ASCII `%~dp0` reaches it as `???` and nothing is ever sent.
    """
    from . import guard_hooks

    lines = [
        "@echo off",
        f"rem {_AGENT_TEAM_MARKER} kind=guard: Navide Guard for Claude Code, rewritten on every hook install",
        'set "NAVIDE_PORT="',
        f'for /f "usebackq delims=" %%p in ("%~dp0{port_name}") do set "NAVIDE_PORT=%%p"',
        "if not defined NAVIDE_PORT exit /b 0",
        f"%SystemRoot%\\System32\\curl.exe -fsS -m {_GUARD_CURL_TIMEOUT_S} -X POST "
        '-H "Content-Type: application/json" '
        '-H "X-Agent-Team-Event: pre_tool_use" '
        f'-H "@%~dp0{header_name}" '
        f'-H "{guard_hooks.PANE_TOKEN_HEADER}: %{guard_hooks.PANE_TOKEN_ENV}%" '
        "--data-binary @- "
        '"http://127.0.0.1:%NAVIDE_PORT%/hooks/claude/pretooluse"',
        "exit /b 0",
    ]
    return "\r\n".join(lines) + "\r\n"


def _windows_guard_script(port_file: str) -> Path | None:
    """Write the exec-form guard script and return its path, or None to keep
    the PowerShell hook: not Windows, no probe has seen a Claude Code that runs
    `args`, or a path the script cannot reach safely."""
    from . import hook_auth

    if osplat.platform_id != "win32":
        return None
    version = _known_claude_version()
    if version is None or version < _EXEC_FORM_SINCE:
        return None
    port = Path(port_file)
    header = hook_auth.header_file()
    script = port.parent / _GUARD_SCRIPT_NAME
    if header.parent != port.parent or _CMD_UNSAFE & set(str(script)):
        return None
    if not (port.name.isascii() and header.name.isascii()):
        return None
    text = _guard_script_text(port.name, header.name)
    try:
        if not script.is_file() or script.read_bytes() != text.encode("ascii"):
            script.write_bytes(text.encode("ascii"))
    except OSError as err:
        log.warning("could not write the guard hook script %s: %s", script, err)
        return None
    return script


def _known_claude_version() -> tuple[int, ...] | None:
    from .onboarding_deps import _get_db

    try:
        stored = _get_db().kv_get(_CLAUDE_VERSION_KV_KEY)
    except Exception:  # noqa: BLE001 - unknown is the safe answer
        return None
    version = stored.get("version") if isinstance(stored, dict) else None
    if isinstance(version, list) and version and all(isinstance(p, int) for p in version):
        return tuple(version)
    return None


def _probe_claude_version() -> tuple[int, ...] | None:
    """`claude --version` as numbers, or None when it cannot be told."""
    program = osplat.paths.resolve_program("claude")
    if not program:
        return None
    try:
        proc = subprocess.run(
            osplat.paths.launch_argv(program, ["--version"]),
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", proc.stdout or "")
    return tuple(int(p) for p in match.groups()) if match else None


def _refresh_claude_version(port_file: str) -> None:
    """Probe in the background and reinstall when the answer changed.

    Off the startup path on purpose: `claude --version` is a Node cold start,
    seconds on a loaded Windows machine. Until it answers, the hooks are
    whatever the last probe allowed — PowerShell on a first run.
    """
    version = _probe_claude_version()
    if version == _known_claude_version():
        return
    from .onboarding_deps import _get_db

    try:
        _get_db().kv_set(
            _CLAUDE_VERSION_KV_KEY, {"version": list(version) if version else None}, now=int(time.time())
        )
    except Exception as err:  # noqa: BLE001
        log.warning("could not record the Claude Code version: %s", err)
        return
    log.info("Claude Code version %s: reinstalling hooks", version)
    from .convenience_wiring import install_hooks_gated

    install_hooks_gated("claude", install_hooks, port_file)


def _build_rewake_command(port_file: str) -> str:
    """Build the parked-waiter hook.

    Runs as an `asyncRewake` hook, which means Claude Code backgrounds it and
    reads its exit code rather than its stdout: exiting 2 wakes the agent — even
    an idle one — and shows the hook's stderr as a system reminder. So the
    envelope is written to stderr and the exit code is the whole protocol.

    The request blocks until the backend has something to say or gives up, and
    a backend that is not running (no port file, connection refused) leaves the
    hook exiting 0, which is "nothing to report" and costs the pane nothing.

    Authenticated the same way as every other hook — the header curl reads out
    of the 0600 file in the app data directory when it fires (see hook_auth).
    This used to be a `?t=` written into the command text instead; that put
    the secret in a settings file every account on the machine can read, so
    it never proved even the weaker thing it claimed (that the caller had been
    through this machine's installer). Reading the file at fire time also
    keeps a pane that was started before a backend restart working.
    """
    from . import hook_auth

    return f"{_AGENT_TEAM_MARKER} kind=rewake\n" + osplat.scripts.hook_rewake(
        port_file=port_file,
        header_file=str(hook_auth.header_file()),
        url_path="/hooks/claude/rewake",
        timeout_s=_REWAKE_CURL_TIMEOUT_S,
    )


def _rewake_wanted() -> bool:
    """Whether claude's push channel is switched on right now.

    Read here rather than only at delivery time so switching the channel off
    actually takes the hook out of the user's settings file, which is what the
    Settings copy promises. Asked through `channel_for` like everything else,
    so a channel cannot be half-off — and so an unreadable switch leaves the
    hook installed, which is that function's own default.
    """
    from . import push_delivery

    return push_delivery.channel_for("claude") is not None


def _is_ours(command: str) -> bool:
    return _AGENT_TEAM_MARKER in command


def _hook_is_ours(hook: Any) -> bool:
    """Ours by the marker in the command, or, for the exec-form guard hook
    (whose command is a bare `cmd.exe`), by the script it runs. An older
    Navide only knows the marker and leaves that entry in place."""
    if not isinstance(hook, dict):
        return False
    if _is_ours(str(hook.get("command", ""))):
        return True
    args = hook.get("args")
    return (
        isinstance(args, list) and bool(args)
        and str(args[-1]).replace("/", "\\").endswith("\\" + _GUARD_SCRIPT_NAME)
    )


def _hook_text(hook: dict) -> str:
    return " ".join([str(hook.get("command", "")), *map(str, hook.get("args") or [])])


def _owned(hook: Any, dev_only: bool) -> bool:
    """Ours, and for a dev backend (``dev_only``) aimed at a dev backend: the
    installed app's entries are never a dev backend's to take out, or the
    user's installed Navide would silently lose its hooks."""
    return _hook_is_ours(hook) and (not dev_only or "-dev" in _hook_text(hook))


def _read_settings(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError) as err:
        log.warning("settings.json unreadable (%s); skipping merge", err)
        return {}


def _write_settings(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Back up only on the first write per session (and only if there isn't
    # already a backup we'd clobber).
    backup = path.with_suffix(path.suffix + ".pre-agent-team.bak")
    if path.exists() and not backup.exists():
        try:
            shutil.copy2(path, backup)
            # No vendor name: qwen_hooks reuses this writer for its own file.
            log.info("backed up CLI settings → %s", backup)
        except OSError as err:
            log.warning("backup failed (%s); proceeding without backup", err)
    # The file a symlink points at is the one rewritten (a dotfiles-managed
    # settings.json stays a link), and its mode is kept: the temp file starts
    # 0600 and takes the original's mode before it replaces it, so a file
    # that may hold an API key is never left wider than the user made it.
    target = path.resolve()
    try:
        mode: int | None = stat.S_IMODE(target.stat().st_mode)
    except OSError:
        mode = None
    tmp = target.with_suffix(target.suffix + ".tmp")
    try:
        tmp.unlink(missing_ok=True)  # a leftover keeps its own mode
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(data, indent=2, ensure_ascii=False))
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, target)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def install_hooks(
    port_file: str, settings_file: Path | None = None, *, skip: frozenset[str] = frozenset()
) -> dict[str, Any]:
    """Idempotent merge: ensure our hooks are present for each event.

    `port_file` is the absolute path to a small text file containing the
    current backend port. The installed hook commands cat it at fire time so
    they survive backend restarts.

    Reads existing settings.json, removes any prior agent-team hook entries
    (by marker), and adds fresh entries. Returns status dict for logging.

    The rewake waiter is the one entry that is conditional: it exists only to
    serve claude's push channel, so a user who switched that channel off gets
    it stripped here and not written back. The signal hooks are unaffected —
    they feed activity detection, which has nothing to do with push delivery.

    ``skip`` names hooks (``hook_parts`` keys) the user deleted by hand: they
    are not written back, and the others are installed as usual.
    """
    path = settings_file or settings_path()
    # Refuse to write over a file that is not a JSON object. _read_settings
    # reports it as an empty dict, and merging into that would replace every
    # setting the user has with nothing but our hooks.
    if path.is_file():
        try:
            parsed = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as err:
            parsed = err
        if not isinstance(parsed, dict):
            log.warning("claude settings.json unparseable (%s); leaving it alone", parsed)
            return {"installed": False, "path": str(path), "reason": "settings.json unparseable"}

    settings = _read_settings(path)
    hooks_section = settings.get("hooks")
    if not isinstance(hooks_section, dict):
        hooks_section = {}

    rewake_wanted = _rewake_wanted()
    # If this is a dev backend instance and the existing settings already point
    # to a live production hook (non-dev port file), preserve the production
    # hook so launching dev never breaks the running production app.
    is_dev_port = "-dev" in port_file
    if is_dev_port and any(
        isinstance(e, dict)
        and any(
            isinstance(h, dict)
            and _hook_is_ours(h)
            and "-dev" not in _hook_text(h)
            for h in e.get("hooks", [])
            if isinstance(h, dict)
        )
        for entries in hooks_section.values()
        if isinstance(entries, list)
        for e in entries
        if isinstance(e, dict)
    ):
        log.info("dev backend skipping hook install: production hook is active")
        return {"status": "skipped", "reason": "production hook active"}

    added = 0
    for event_name in [*_HOOK_EVENTS, *(e for e in _REWAKE_EVENTS if e not in _HOOK_EVENTS)]:
        event_kind = _HOOK_EVENTS.get(event_name, "")
        entries = hooks_section.get(event_name)
        if not isinstance(entries, list):
            entries = []
        # Strip any prior agent-team entries from this event.
        cleaned: list[dict[str, Any]] = []
        for entry in entries:
            if not isinstance(entry, dict):
                cleaned.append(entry)
                continue
            inner_hooks = entry.get("hooks")
            if isinstance(inner_hooks, list):
                inner_hooks = [
                    h for h in inner_hooks
                    if not _hook_is_ours(h)
                ]
                if inner_hooks:
                    entry = {**entry, "hooks": inner_hooks}
                    cleaned.append(entry)
                # else: drop the empty wrapper
            else:
                cleaned.append(entry)
        # Append our entries. The two are separate hook objects on purpose: the
        # signal hook is synchronous and its answer is read, the rewake waiter
        # is backgrounded and only its exit code matters, and a single event
        # (Stop) wants both.
        ours: list[dict[str, Any]] = []
        if event_kind and f"{event_name}:{event_kind}" not in skip:
            signal = osplat.scripts.hook_entry(_build_curl_command(port_file, event_kind))
            if event_name in _ASYNC_EVENTS:
                signal = {**signal, "async": True}
            ours.append(signal)
        if event_name == GUARD_EVENT and f"{event_name}:guard" not in skip:
            ours.append(guard_hook_entry(port_file))
        if event_name in _REWAKE_EVENTS and rewake_wanted and f"{event_name}:rewake" not in skip:
            ours.append({
                **osplat.scripts.hook_entry(_build_rewake_command(port_file)),
                "asyncRewake": True,
                "timeout": _REWAKE_TIMEOUT_S,
            })
        if ours:
            cleaned.append({"hooks": ours})
            added += 1
        # An event we contribute nothing to (SessionStart with the rewake
        # channel off) must not leave an empty wrapper behind, and must not
        # keep a key we are the only reason for.
        if cleaned:
            hooks_section[event_name] = cleaned
        else:
            hooks_section.pop(event_name, None)

    settings["hooks"] = hooks_section
    try:
        _write_settings(path, settings)
    except OSError as err:
        log.warning("could not write settings.json: %s", err)
        return {"installed": False, "path": str(path), "error": str(err)}

    log.info("installed Claude hooks → %s (events=%d, port_file=%s)",
             path, added, port_file)
    # Only for the real settings file: the probe serves what Claude Code will
    # read, and runs once per backend.
    if settings_file is None:
        _start_version_probe(port_file)
    return {"installed": True, "path": str(path), "events": added, "port_file": port_file}


def _start_version_probe(port_file: str) -> None:
    global _version_refresh_started
    if osplat.platform_id == "win32" and not _version_refresh_started:
        _version_refresh_started = True
        threading.Thread(
            target=_refresh_claude_version, args=(port_file,), name="claude-version-probe", daemon=True
        ).start()


# ── Phase 3: the hooks ride on the panes Navide starts ──────────────────────

#: The flag a carried pane is started with; Claude Code merges the file's
#: hooks with the user's own settings rather than replacing them.
SETTINGS_FLAG = "--settings"

#: The (port_file, skip) the pane file was last prepared with, so a file that
#: went missing while the panes carry the hooks can be written again at spawn.
_prepared_with: tuple[str, frozenset[str]] | None = None


def pane_settings_path() -> Path:
    """The settings file a carried pane gets through ``--settings``: Navide's
    hooks alone, inside Navide's own data."""
    from .push_delivery import runtime_dir

    return runtime_dir("claude") / "settings.json"


def prepare_pane_settings(port_file: str, skip: frozenset[str]) -> Path:
    """Write the pane-side copy of Navide's hooks: exactly what
    ``install_hooks`` merges into the shared file (rewake per the push-channel
    switch, minus ``skip``), alone in a 0600 file of Navide's. Built beside
    it and moved into place, so a pane starting meanwhile reads the old copy
    or the new one, never half of one. Raises when it cannot be written."""
    from .osplat import secret_files

    target = pane_settings_path()
    secret_files.make_private_dir(target.parent)
    staging = target.with_name(f".{target.name}.new")
    # Starts from nothing: install_hooks would merge into (and back up) a
    # leftover from an interrupted write.
    staging.unlink(missing_ok=True)
    result = install_hooks(port_file, settings_file=staging, skip=skip)
    if not result.get("installed"):
        staging.unlink(missing_ok=True)
        raise OSError(f"could not write {staging}: {result}")
    os.replace(staging, target)
    global _prepared_with
    _prepared_with = (port_file, skip)
    # What the probe decides (the exec-form guard) is in this file now.
    _start_version_probe(port_file)
    return target


def wire_spawn(command: Any) -> Any:
    """``command`` with ``--settings <pane file>`` appended, once. A command
    that already names a settings file is left alone: whoever wrote it chose
    that file, and Claude Code reads only one. A pane file gone missing is
    written again first; when it cannot be, the pane starts without it rather
    than not at all."""
    from .push_delivery import _append_to_command, _command_text, _has_flag

    if _has_flag(_command_text(command), SETTINGS_FLAG):
        if str(pane_settings_path()) not in _command_text(command):
            log.warning("claude pane names its own %s; Navide's hooks are not added", SETTINGS_FLAG)
        return command
    if not pane_settings_path().is_file():
        try:
            if _prepared_with is None:
                raise FileNotFoundError(pane_settings_path())
            prepare_pane_settings(*_prepared_with)
        except Exception as err:  # noqa: BLE001 — a spawn is never broken over this
            log.warning("claude pane settings missing and not written again; pane starts without hooks: %s", err)
            return command
    return _append_to_command(command, f"{SETTINGS_FLAG} {osplat.paths.quote_arg(str(pane_settings_path()))}")


def hooks_present(settings_file: Path | None = None, *, dev_only: bool = False) -> bool:
    """Whether the settings file still carries any hook Navide wrote (a dev
    backend's own only, with ``dev_only``).

    Raises when the file exists but cannot be read as a JSON object: an
    unreadable file says nothing about whether the user removed our hooks.
    So does a link that leads nowhere (a dotfiles checkout mid-switch).
    """
    path = settings_file or settings_path()
    if not path.is_file():
        if path.is_symlink():
            raise FileNotFoundError(f"{path} is a link that leads nowhere")
        return False
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a JSON object")
    hooks_section = data.get("hooks")
    if not isinstance(hooks_section, dict):
        return False
    return any(
        _owned(hook, dev_only)
        for entries in hooks_section.values() if isinstance(entries, list)
        for entry in entries if isinstance(entry, dict)
        for hook in (entry.get("hooks") if isinstance(entry.get("hooks"), list) else [])
    )


_KIND_RE = re.compile(re.escape(_AGENT_TEAM_MARKER) + r" kind=(\w+)")


def hook_parts(settings_file: Path | None = None) -> set[str]:
    """Each Navide hook in the settings file, as "<event>:<kind>" (kind is
    the marker's: stop, guard, rewake …). One the user deleted by hand is
    missing here while the rest are not. Raises like ``hooks_present``."""
    path = settings_file or settings_path()
    if not path.is_file():
        return set()
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a JSON object")
    hooks_section = data.get("hooks")
    if not isinstance(hooks_section, dict):
        return set()
    parts: set[str] = set()
    for event_name, entries in hooks_section.items():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            inner = entry.get("hooks") if isinstance(entry, dict) else None
            for hook in inner if isinstance(inner, list) else []:
                if _hook_is_ours(hook):
                    # The exec-form guard runs a script and carries no marker.
                    match = _KIND_RE.search(str(hook.get("command", "")))
                    parts.add(f"{event_name}:{match.group(1) if match else 'guard'}")
    return parts


def uninstall_hooks(settings_file: Path | None = None, *, dev_only: bool = False) -> dict[str, Any]:
    """Remove all agent-team hook entries (a dev backend's own only, with
    ``dev_only``); leave everything else alone."""
    path = settings_file or settings_path()
    if not path.is_file():
        return {"removed": False, "reason": "settings.json absent"}
    settings = _read_settings(path)
    hooks_section = settings.get("hooks")
    if not isinstance(hooks_section, dict):
        return {"removed": False, "reason": "no hooks section"}

    changed = False
    for event_name, entries in list(hooks_section.items()):
        if not isinstance(entries, list):
            continue
        cleaned: list[Any] = []
        for entry in entries:
            if not isinstance(entry, dict):
                cleaned.append(entry)
                continue
            inner_hooks = entry.get("hooks")
            if isinstance(inner_hooks, list):
                filtered = [
                    h for h in inner_hooks
                    if not _owned(h, dev_only)
                ]
                if filtered:
                    cleaned.append({**entry, "hooks": filtered})
                else:
                    changed = True  # dropped wrapper
            else:
                cleaned.append(entry)
        if cleaned != entries:
            changed = True
            if cleaned:
                hooks_section[event_name] = cleaned
            else:
                hooks_section.pop(event_name, None)

    if changed:
        settings["hooks"] = hooks_section
        try:
            _write_settings(path, settings)
        except OSError as err:
            return {"removed": False, "error": str(err)}
    return {"removed": changed, "path": str(path)}
