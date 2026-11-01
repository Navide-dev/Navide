"""Invocation-scoped Codex SessionStart identity, with log verification.

The command is stable across launches: per-process identity lives in the
spawn environment, not the hook definition that Codex asks the user to trust.
No user config is written and no hook-trust bypass is requested.

That stability is what should keep the trust screen to a one-off, and on some
Codex builds it does not — the screen returns for every pane and the user
cannot get past it without answering. Rather than write their config or pass
`--dangerously-bypass-hook-trust` (which would exempt the user's own hooks
too), Navide stops injecting on a machine where that screen has been seen; see
`trust_gate_blocks_injection`.
"""
from __future__ import annotations

import base64
import json
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from . import osplat
from .cli_vendors.codex import is_subagent_session_meta

LAUNCH_ENV = 'NAVIDE_CODEX_LAUNCH'
LAUNCH_HEADER = 'X-Navide-Codex-Launch'
_UUID = re.compile(r'^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')


def resume_identity(value: str) -> str:
    """Only an explicit UUID is a known identity; names/--last are selectors."""
    return value if _UUID.fullmatch(value) else ''


def hook_command() -> str:
    if osplat.platform_id == 'win32':
        script = '''[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not $env:NAVIDE_CODEX_LAUNCH) { exit 0 }; try {
$navidePort = Get-Content -ErrorAction Stop $env:NAVIDE_CODEX_PORT_FILE
$body = [Console]::In.ReadToEnd()
$body | & ($env:SystemRoot + '\\System32\\curl.exe') -fsS -m 2 -o NUL -X POST -H 'Content-Type: application/json' -H ("@" + $env:NAVIDE_CODEX_AUTH_FILE) -H ("X-Navide-Codex-Launch: " + $env:NAVIDE_CODEX_LAUNCH) --data-binary '@-' ("http://127.0.0.1:" + $navidePort + "/hooks/codex/session-start")
} catch {}; exit 0'''
        return 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + base64.b64encode(script.encode('utf-16-le')).decode()
    return (
        '[ -n "$NAVIDE_CODEX_LAUNCH" ] || exit 0; '
        'navide_port=$(cat "$NAVIDE_CODEX_PORT_FILE" 2>/dev/null); '
        '[ -n "$navide_port" ] || exit 0; '
        'curl -fsS -m 2 -o /dev/null -X POST '
        '-H "Content-Type: application/json" '
        '-H "@$NAVIDE_CODEX_AUTH_FILE" '
        '-H "X-Navide-Codex-Launch: $NAVIDE_CODEX_LAUNCH" '
        '--data-binary @- "http://127.0.0.1:$navide_port/hooks/codex/session-start" '
        '2>/dev/null || true'
    )


def guard_hook_command() -> str:
    """Navide Guard's PreToolUse hook: same environment and identity as the
    SessionStart hook above, but the response body is printed — it is the
    decision (guard_hooks.render). Every failure leaves stdout empty and the
    exit 0, which Codex reads as no decision."""
    if osplat.platform_id == 'win32':
        # cmd, not PowerShell: Codex hands the text to `%COMSPEC% /C "<text>"`
        # verbatim (codex-rs hooks command_runner.rs), and a PowerShell cold
        # start alone can outlast the 10s hook timeout on a loaded arm64 box,
        # where Codex lets the call through undecided. curl reads the hook's
        # stdin itself, so the payload bytes reach the backend untouched. The
        # variables are expanded when the line is parsed, which is safe: Codex
        # sets all three together. `for /f` reads the port at run time; a
        # missing file runs nothing, and the outer `exit 0` covers every path.
        # The `@` matters: cmd echoes a `for` body, prompt included, to stdout,
        # which is where Codex reads the decision. curl is System32's by full
        # path: one from a Git or MSYS2 bin directory ahead of it on PATH reads
        # its arguments in the ANSI code page, so a non-ASCII auth file path
        # arrives as `???` and the request is never sent. Forward slashes, which
        # cmd accepts, because this text crosses TOML and argv quoting.
        return (
            '(if not defined NAVIDE_CODEX_LAUNCH (exit 0) else '
            'for /f "usebackq delims=" %p in ("%NAVIDE_CODEX_PORT_FILE%") do '
            '@%SystemRoot%/System32/curl.exe -fsS -m 9 -X POST '
            '-H "Content-Type: application/json" '
            '-H "@%NAVIDE_CODEX_AUTH_FILE%" '
            '-H "X-Navide-Codex-Launch: %NAVIDE_CODEX_LAUNCH%" '
            '--data-binary @- "http://127.0.0.1:%p/hooks/codex/pretooluse") '
            '2>nul & exit 0'
        )
    return (
        '[ -n "$NAVIDE_CODEX_LAUNCH" ] || exit 0; '
        'navide_port=$(cat "$NAVIDE_CODEX_PORT_FILE" 2>/dev/null); '
        '[ -n "$navide_port" ] || exit 0; '
        'curl -fsS -m 9 -X POST '
        '-H "Content-Type: application/json" '
        '-H "@$NAVIDE_CODEX_AUTH_FILE" '
        '-H "X-Navide-Codex-Launch: $NAVIDE_CODEX_LAUNCH" '
        '--data-binary @- "http://127.0.0.1:$navide_port/hooks/codex/pretooluse" '
        '2>/dev/null; exit 0'
    )


_HOOKS_KV_KEY = 'codex_hooks'
_TRUST_BLOCKED_FIELD = 'session_start_trust_blocked'


def _hooks_state() -> dict[str, Any]:
    # Imported here, not at module scope: onboarding_deps owns the Database
    # handle and importing it up top would close an import cycle through
    # cli_vendors.
    from .onboarding_deps import _get_db
    try:
        data = _get_db().kv_get(_HOOKS_KV_KEY)
    except Exception:  # noqa: BLE001 - a hook is optional; never block a spawn
        return {}
    return data if isinstance(data, dict) else {}


def trust_gate_blocks_injection() -> bool:
    """Whether this machine's Codex hides our injected hook behind a trust screen.

    Codex makes the user approve a hook it has not seen before. Some builds
    apply that to a hook passed on the command line, which turns every pane
    Navide opens into a modal someone has to clear; others do not, and which
    is which cannot be read off a version number — 0.155 here runs the same
    injection without asking, while 0.154 was reported asking every time.

    So it is observed rather than predicted: the window reports the screen the
    first time it sees it (`codex.hook_trust_blocked`) and every later spawn
    leaves the hook out. Nothing about the user's environment is touched —
    only Navide's own behaviour changes, and the hook is an accuracy
    optimisation that log and marker discovery already cover without it.
    """
    return bool(_hooks_state().get(_TRUST_BLOCKED_FIELD))


def set_trust_gate_blocked(blocked: bool) -> bool:
    """Record (or clear) that verdict. Returns whether the value changed."""
    from .onboarding_deps import _get_db
    state = _hooks_state()
    if bool(state.get(_TRUST_BLOCKED_FIELD)) == blocked:
        return False
    state[_TRUST_BLOCKED_FIELD] = blocked
    try:
        _get_db().kv_set(_HOOKS_KV_KEY, state, now=int(time.time()))
    except Exception:  # noqa: BLE001 - losing the note only costs one retry
        return False
    return True


def _toml_literal(value: str) -> str:
    """`value` as a TOML literal string, so the TOML spelling adds no `"`.

    Codex runs the `-c` text under `cmd.exe /d /s /c` on Windows, where a
    backslash is not an escape: `subprocess.list2cmdline` renders a `"` as
    `\\"`, which closes the quote early. The old basic-string spelling added
    `"` of its own around every value, and for the SessionStart matcher that
    exposed the `|` inside it to cmd as a pipe. A literal string adds none, so
    an override whose content has no `"` needs no escaping at all.
    Single-quoted, or triple-quoted when the value itself contains a `'`
    (neither hook command does today).
    """
    if "'" not in value:
        return "'" + value + "'"
    return "'''" + value + "'''"


def wire(command: Any, env: dict, metadata: dict, home: Path, port_file: Path, auth_file: Path) -> Any:
    """Append a session-layer hook; Codex appends lower-layer user hooks too."""
    # A Codex that gates this hook behind its trust screen would stop the pane
    # on a modal instead of starting it. Seen once, never injected again.
    if trust_gate_blocks_injection():
        return command
    text = str(command[-1]) if isinstance(command, list) and command else str(command or '')
    # A custom session-layer SessionStart override belongs to the user. Adding
    # the same override twice would replace that layer's array, so leave it.
    if re.search(r"(?:^|\s)(?:-c(?:=|\s*)|--config(?:=|\s+))[\"']?hooks(?:[.=\s]|$)", text):
        return command
    nonce = secrets.token_urlsafe(32)
    metadata['codex_launch_token'] = nonce
    metadata['codex_session_home'] = str(home)
    if metadata.get('explicit_session_id'):
        metadata['codex_current_session_id'] = metadata['explicit_session_id']
    env.update({LAUNCH_ENV: nonce, 'NAVIDE_CODEX_PORT_FILE': str(port_file), 'NAVIDE_CODEX_AUTH_FILE': str(auth_file)})
    definition = (
        'hooks.SessionStart=[{matcher=' + _toml_literal('^(startup|resume)$')
        + ',hooks=[{type=' + _toml_literal('command')
        + ',command=' + _toml_literal(hook_command())
        + ',timeout=3}]}]'
    )
    text += ' -c ' + osplat.paths.quote_arg(definition)
    # Navide Guard. Behind the same trust gate and user-override check as
    # SessionStart: it is one more hook Codex may ask the user to trust.
    guard = (
        'hooks.PreToolUse=[{hooks=[{type=' + _toml_literal('command')
        + ',command=' + _toml_literal(guard_hook_command())
        + ',timeout=10}]}]'
    )
    text += ' -c ' + osplat.paths.quote_arg(guard)
    return [*command[:-1], text] if isinstance(command, list) else text


class PendingStarts:
    """A callback may precede both attribution registration and rollout flush."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending: dict[tuple[str, str], dict] = {}
        self._consumed: set[tuple[str, str]] = set()
        self._current: dict[str, str] = {}

    def add(self, token: str, payload: dict) -> bool:
        sid = resume_identity(str(payload.get('session_id') or ''))
        if payload.get('hook_event_name') != 'SessionStart':
            return False
        if not isinstance(payload.get('cwd'), str) or not payload['cwd']:
            return False
        if payload.get('transcript_path') is not None and not isinstance(payload['transcript_path'], str):
            return False
        if not token or not sid or payload.get('source') not in ('startup', 'resume'):
            return False
        with self._lock:
            if (token, sid) in self._consumed:
                return False
            current = self._current.get(token)
            if current and current != sid:
                return False
            self._current[token] = sid
            self._pending[(token, sid)] = dict(payload)
        return True

    def has_pending(self, token: str = "") -> bool:
        with self._lock:
            return any(not token or t == token for t, _ in self._pending)

    def paths(self, token: str) -> list[Path]:
        with self._lock:
            return [Path(p['transcript_path']) for (t, _), p in self._pending.items()
                    if t == token and isinstance(p.get('transcript_path'), str) and p['transcript_path']]

    def find_paths(self, token: str, home: Path) -> list[Path]:
        with self._lock:
            ids = [sid for t, sid in self._pending if t == token]
        return [p for sid in ids for p in (home / 'sessions').rglob(f'rollout-*{sid}.jsonl')]

    def match(self, path: Path, live: dict[str, tuple[str, str]]) -> tuple[str, str, str] | None:
        with self._lock:
            # Drop old processes before any read: delayed hooks cannot revive
            # a pane after a respawn, even when its UI id stays unchanged.
            self._pending = {k: v for k, v in self._pending.items() if k[0] in live}
            self._consumed = {k for k in self._consumed if k[0] in live}
            self._current = {k: v for k, v in self._current.items() if k in live}
            pending = dict(self._pending)
        if not pending:
            return None
        try:
            with path.open(encoding='utf-8') as f:
                first = json.loads(f.readline(524_288))
        except (OSError, ValueError):
            return None
        meta = first.get('payload') if isinstance(first, dict) and first.get('type') == 'session_meta' else None
        if not isinstance(meta, dict) or is_subagent_session_meta(meta):
            return None
        sid = str(meta.get('id') or '')
        for (token, expected), payload in pending.items():
            if expected != sid:
                continue
            pane, cwd = live[token]
            if Path(str(meta.get('cwd') or '')).resolve() != Path(cwd).resolve():
                continue
            if payload.get('cwd') and Path(payload['cwd']).resolve() != Path(cwd).resolve():
                continue
            declared = payload.get('transcript_path')
            if declared and Path(declared).resolve() != path.resolve():
                continue
            return token, pane, sid
        return None

    def consume(self, token: str, sid: str) -> None:
        with self._lock:
            self._pending.pop((token, sid), None)
            self._consumed.add((token, sid))
            self._current[token] = sid
