"""SSH Remote panes (experimental): a terminal or CLI pane that runs on
another machine over ssh.

``remote_ssh.connect`` checks the target with one BatchMode ssh call
(:func:`preflight_argv`) and names a failure in plain terms
(:func:`classify`); it then remembers the target as trusted. The pane itself
is opened by ``terminal.create`` with ``remote = {"kind": "ssh", ...}``
(:func:`parse_spec`), which runs :func:`shell_argv` only for a trusted target.

What never leaves this machine: the private key and the SSH agent. The key is
named by path only — this module never opens, reads, copies or stats it; ssh
reads it locally. Agent forwarding is always off (``ForwardAgent=no``, never
``-A``), and the spawn environment is the same allowlist the remote container
panes use, so no SendEnv line can carry a local credential.

The target uses the same host and option rules as remote_devcontainer, so a
later remote container pane can reuse :func:`ssh_options` and
:func:`destination` to reach its host.

A CLI pane (``spec["cli"]`` other than ``"terminal"``) starts that CLI in the
spec's remote folder, signed in however the user signed in on the host —
nothing about local accounts goes there. Claude and Codex also get Navide's
tools the way remote container panes do (:func:`cli_pane_argv`): an ``ssh -R``
tunnel and the pane's own MCP token, written to the PTY once echo is off and
never put on a command line. The token is minted for that pane and stops
working when it closes; it is no account credential.

Each CLI pane remembers its remote session id so a reconnect or a restore
resumes exactly that conversation, never "the latest one in this folder",
which could belong to someone else. Claude is launched with an id chosen
here; Codex's id is read on the host from the session file its own process
holds open and reported back through :data:`SESSION_REPORT`.
"""

from __future__ import annotations

import re
import shlex
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from . import remote_devcontainer as rd

DEFAULT_PORT = 22

# ui_settings key: targets the user connected to from the SSH Remote dialog.
# A pane opens only to a target listed here (see remote_devcontainer.TRUSTED_KEY).
TRUSTED_KEY = "sshRemoteTrusted"
TRUSTED_MAX = 100

# Term metadata key carrying an SSH pane's spec. Not remote_devcontainer's
# "remote": that one means a container pane to the code that reads it.
METADATA_KEY = "ssh_remote"

# Plain-language failure reasons the dialog and the pane banner explain.
REASONS = ("unreachable", "auth", "host-key", "other")

# The folder a pane starts in on the host: the remote user's home by default.
DEFAULT_DIR = "~"

# What an SSH pane runs on the host: a login shell, or one of these CLIs as its
# default command (kept in step with the agent specs' defaultCommand by
# test_remote_ssh). The two in MCP_CLIS also get Navide's tools.
TERMINAL = "terminal"
CLI_COMMANDS: dict[str, tuple[str, ...]] = {
    "claude": ("claude",),
    "codex": ("codex",),
    "aider": ("aider",),
    "antigravity": ("agy",),
    "copilot": ("copilot",),
    "cursor": ("agent",),
    "devin": ("devin",),
    "droid": ("droid",),
    "goose": ("goose",),
    "grok": ("grok",),
    "hermes": ("hermes", "chat"),
    "kilo": ("kilo",),
    "kimi": ("kimi",),
    "kiro": ("kiro-cli", "chat", "--v3"),
    "mcode": ("mcode",),
    "muse": ("muse",),
    "openclaw": ("openclaw", "tui", "--local"),
    "opencode": ("opencode",),
    "pi": ("pi",),
    "qwen": ("qwen",),
}
MCP_CLIS = ("claude", "codex")

# OSC sequences the remote side prints for the pane's output tap: the session
# id it found, and that a requested resume found nothing to resume. Unknown to
# a terminal, so nothing is drawn.
SESSION_REPORT = b"\x1b]7737;navide-session;"
RESUME_MISSED = b"\x1b]7737;navide-resume-miss\x07"

_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,63}$")

# A user name ssh accepts without quoting; a leading "-" would be an option.
_USER_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$")
# A host name, IPv4 address or ssh config alias. No "@": the user is its own field.
_HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$")


class SshTargetError(ValueError):
    """A host, user, port or key path that cannot be used."""


def parse_target(payload: Any) -> dict[str, Any]:
    """The validated ``{"host", "user", "port", "keyPath"}`` from a request.

    ``keyPath`` is checked as text only; the file is never touched.
    """
    if not isinstance(payload, Mapping):
        raise SshTargetError("target must be an object")
    host = str(payload.get("host") or "").strip()
    if not _HOST_RE.match(host):
        raise SshTargetError(f"invalid host: {host!r}")
    user = str(payload.get("user") or "").strip()
    if user and not _USER_RE.match(user):
        raise SshTargetError(f"invalid user: {user!r}")
    raw_port = payload.get("port", DEFAULT_PORT)
    if isinstance(raw_port, bool) or raw_port in (None, ""):
        raw_port = DEFAULT_PORT
    try:
        port = int(raw_port)
    except (TypeError, ValueError):
        raise SshTargetError(f"invalid port: {raw_port!r}") from None
    if not 1 <= port <= 65535:
        raise SshTargetError(f"invalid port: {port}")
    key_path = str(payload.get("keyPath") or "").strip()
    if key_path:
        if key_path.startswith("-") or any(ch in key_path for ch in "\0\r\n"):
            raise SshTargetError("invalid key path")
        if not (Path(key_path).is_absolute() or key_path.startswith("~")):
            raise SshTargetError("key path must be absolute")
    return {"host": host, "user": user, "port": port, "keyPath": key_path}


def destination(target: Mapping[str, Any]) -> str:
    """``user@host`` or ``host`` — accepted by remote_devcontainer.validate_host."""
    dest = f"{target['user']}@{target['host']}" if target.get("user") else str(target["host"])
    return rd.validate_host(dest)


def ssh_options(target: Mapping[str, Any]) -> list[str]:
    """Port and identity options for ``target``. The key goes in as a path.
    The default port is not passed: ``-p 22`` would override the ``Port`` an
    ssh config alias sets."""
    port = int(target.get("port") or DEFAULT_PORT)
    options = ["-p", str(port)] if port != DEFAULT_PORT else []
    key_path = str(target.get("keyPath") or "")
    if key_path:
        options += ["-i", str(Path(key_path).expanduser()), "-o", "IdentitiesOnly=yes"]
    return options


def shell_argv(target: Mapping[str, Any], control_path_dir: Path | None = None) -> list[str]:
    """The argv an SSH Remote terminal pane runs: a login shell on the host,
    in the spec's remote folder when it names one other than home."""
    argv = [
        "ssh", "-tt",
        *rd.ssh_base_options(control_path_dir),
        *ssh_options(target),
        "--", destination(target),
    ]
    remote_dir = str(target.get("dir") or DEFAULT_DIR)
    if remote_dir != DEFAULT_DIR:
        argv.append(f"cd {_cd_target(remote_dir)} && exec $SHELL -l")
    return argv


def parse_spec(payload: Any) -> dict[str, Any]:
    """The validated ``remote`` spec of an SSH pane: ``kind``, the target, the
    remote folder, what runs there, the CLI's session id ("" while unknown)
    and ``resume`` — whether this launch continues an earlier one (a
    reconnect, rebuild or restore). ``resume`` is never persisted."""
    if not isinstance(payload, Mapping) or payload.get("kind") != "ssh":
        raise SshTargetError("not an ssh remote spec")
    remote_dir = str(payload.get("dir") or DEFAULT_DIR).strip()
    if remote_dir.startswith("-") or len(remote_dir) > 1024 or any(ch in remote_dir for ch in "\0\r\n"):
        raise SshTargetError("invalid remote folder")
    cli = str(payload.get("cli") or TERMINAL)
    if cli != TERMINAL and cli not in CLI_COMMANDS:
        raise SshTargetError(f"invalid cli: {cli!r}")
    session_id = str(payload.get("sessionId") or "")
    if session_id and not _SESSION_ID_RE.match(session_id):
        raise SshTargetError("invalid session id")
    return {
        "kind": "ssh", **parse_target(payload),
        "dir": remote_dir, "cli": cli, "sessionId": session_id,
        "resume": payload.get("resume") is True,
    }


def record_spec(spec: Mapping[str, Any]) -> dict[str, Any]:
    """What a pane record keeps of a spec: everything but ``resume``."""
    return {key: value for key, value in spec.items() if key != "resume"}


def _cd_target(remote_dir: str) -> str:
    """``remote_dir`` as a cd argument: quoted, with a leading ``~`` left for
    the remote shell to expand."""
    if remote_dir == "~":
        return "~"
    if remote_dir.startswith("~/"):
        return "~/" + shlex.quote(remote_dir[2:])
    return shlex.quote(remote_dir)


def _osc(text: str) -> str:
    """An OSC sequence spelled for printf."""
    return f"\\033]7737;{text}\\007"


def _session_script(cli: str, argv: list[str], session_id: str, resume: bool) -> str:
    """The lines that start ``argv`` resuming ``session_id`` when asked to and
    the CLI still has it, else fresh; a resume that cannot happen prints
    :data:`RESUME_MISSED`."""
    missed = f"printf '{_osc('navide-resume-miss')}'; " if resume else ""
    cmd = shlex.join(argv)
    if cli == "claude":
        sid = shlex.quote(session_id)
        # The transcript exists only once a turn was taken; without it there
        # is nothing to resume, and the fresh launch keeps the same id.
        return (
            'd="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; '
            f'if [ -n "$(find "$d/projects" -maxdepth 2 -name {sid}.jsonl 2>/dev/null | head -n 1)" ]; '
            f"then exec {cmd} --resume {sid}; fi; "
            f"{missed}exec {cmd} --session-id {sid}"
        )
    if cli == "codex":
        lines = []
        if resume and session_id:
            sid = shlex.quote(session_id)
            lines.append(
                'd="${CODEX_HOME:-$HOME/.codex}"; '
                f'if [ -n "$(find "$d/sessions" -name "*"{sid}.jsonl 2>/dev/null | head -n 1)" ]; '
                f"then exec {cmd} resume {sid}; fi; "
            )
        # Codex cannot be handed an id, so a watcher reads the one it chose
        # from the rollout file its own process (or the native binary the npm
        # launcher starts) holds open — that pane's, and no other's. It ends
        # with the CLI; a host with neither /proc nor lsof reports nothing.
        report = _osc("navide-session;%s")
        watcher = (
            "p=$$; ( while kill -0 $p 2>/dev/null; do "
            "f=$( { for q in $p $(pgrep -P $p 2>/dev/null); do "
            "ls -l /proc/$q/fd 2>/dev/null; lsof -p $q -Fn 2>/dev/null; done; } "
            "| grep -o 'rollout-[^/ ]*[.]jsonl' | head -n 1); "
            'if [ -n "$f" ]; then '
            "id=$(printf %s \"$f\" | sed -E 's/.*([0-9A-Fa-f-]{36})[.]jsonl$/\\1/'); "
            f"printf '{report}' \"$id\" > /dev/tty; exit 0; fi; "
            "sleep 2; done ) </dev/null >/dev/null 2>&1 & "
        )
        lines.append(f"{missed}{watcher}exec {cmd}")
        return "".join(lines)
    return f"{missed}exec {cmd}"


def cli_script(spec: Mapping[str, Any], *, pane_id: str, remote_port: int | None) -> str:
    """The /bin/sh script an SSH CLI pane runs on the host."""
    from . import remote_devcontainer as rd_mod
    from .mcp_server import wiring

    cli = spec["cli"]
    parts: list[str] = []
    if cli in MCP_CLIS:
        if remote_port is None:
            raise SshTargetError("a CLI with Navide tools needs a tunnel port")
        env = wiring.TOKEN_ENV
        request = rd_mod.TOKEN_REQUEST.decode("ascii").replace("\x1b", "\\033").replace("\x07", "\\007")
        parts.append(f"stty -echo; printf '{request}'; IFS= read -r {env}; stty echo; export {env}; ")
        argv = rd_mod.cli_argv(cli, rd_mod.mcp_url({"mode": "host"}, remote_port, pane_id))
    else:
        argv = list(CLI_COMMANDS[cli])
    folder = shlex.quote(spec["dir"])
    parts.append(
        f"cd {_cd_target(spec['dir'])} || "
        f"{{ printf 'Navide: cannot open the remote folder %s\\r\\n' {folder}; exit 1; }}; "
    )
    parts.append(_session_script(cli, argv, str(spec.get("sessionId") or ""), bool(spec.get("resume"))))
    return "".join(parts)


def cli_pane_argv(
    spec: Mapping[str, Any],
    *,
    pane_id: str,
    local_port: int | None,
    remote_port: int,
) -> list[str]:
    """The argv of an SSH CLI pane. The script runs under the user's own
    login shell (interactive, as a local pane's command does) so the CLI is
    found on the PATH the user set up there, then in /bin/sh, whose syntax the
    script is written in whatever that shell is."""
    tunnel: list[str] = []
    port: int | None = None
    if spec["cli"] in MCP_CLIS:
        if local_port is None:
            raise SshTargetError("backend port unknown")
        port = remote_port
        tunnel = [
            # A taken remote port fails the connection rather than leaving
            # the pane without its tools.
            "-o", "ExitOnForwardFailure=yes",
            "-R", f"127.0.0.1:{remote_port}:127.0.0.1:{local_port}",
        ]
    script = cli_script(spec, pane_id=pane_id, remote_port=port)
    inner = "exec /bin/sh -c " + shlex.quote(script)
    return [
        "ssh", "-tt",
        # Its own connection, never a shared master: a master keeps the -R
        # forward bound for ControlPersist seconds after the pane closes.
        *rd.ssh_base_options(None),
        "-o", "ControlPath=none",
        *tunnel,
        *ssh_options(spec),
        "--", destination(spec),
        f"exec $SHELL -ilc {shlex.quote(inner)}",
    ]


class SessionWatcher:
    """Reads :data:`SESSION_REPORT` and :data:`RESUME_MISSED` out of an SSH
    CLI pane's output. Fed every chunk; holds a short tail so a sequence split
    across two reads is still seen."""

    _TAIL = len(SESSION_REPORT) + 80

    def __init__(self, on_session: Callable[[str], Any], on_missed: Callable[[], Any]) -> None:
        self._on_session = on_session
        self._on_missed = on_missed
        self._tail = b""
        self.session_id = ""
        self.missed = False

    def feed(self, chunk: bytes) -> None:
        if self.session_id and self.missed:
            return
        data = self._tail + chunk
        if not self.missed and RESUME_MISSED in data:
            self.missed = True
            self._on_missed()
        start = data.find(SESSION_REPORT)
        if not self.session_id and start >= 0:
            end = data.find(b"\x07", start)
            if end >= 0:
                value = data[start + len(SESSION_REPORT):end].decode("ascii", "replace")
                if _SESSION_ID_RE.match(value):
                    self.session_id = value
                    self._on_session(value)
                data = data[end + 1:]
        self._tail = data[-self._TAIL:]


def _trust_row(target: Mapping[str, Any]) -> dict[str, Any]:
    return {key: target[key] for key in ("host", "user", "port", "keyPath")}


def _trusted_rows(settings: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    raw = (settings or {}).get(TRUSTED_KEY)
    rows = []
    for row in raw if isinstance(raw, list) else []:
        try:
            rows.append(_trust_row(parse_target(row)))
        except SshTargetError:
            continue
    return rows


def is_trusted(settings: Mapping[str, Any] | None, target: Mapping[str, Any]) -> bool:
    return _trust_row(target) in _trusted_rows(settings)


def with_trusted(settings: Mapping[str, Any] | None, target: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The trusted list with ``target`` first, capped."""
    entry = _trust_row(target)
    return [entry, *(row for row in _trusted_rows(settings) if row != entry)][:TRUSTED_MAX]


def preflight_argv(target: Mapping[str, Any]) -> list[str]:
    """One non-interactive call that proves the host is reachable and accepts
    the key. Its own connection: a stale shared master must not answer for it."""
    return [
        "ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        *rd.ssh_base_options(None),
        "-o", "ControlPath=none",
        *ssh_options(target),
        "--", destination(target),
        "echo NAVIDE:OK",
    ]


_HOST_KEY = ("host key verification failed", "remote host identification has changed")
_AUTH = ("permission denied", "too many authentication failures", "no supported authentication",
         "authentication failed", "load key", "bad permissions", "no such identity")
_UNREACHABLE = ("could not resolve", "name or service not known", "nodename nor servname",
                "connection refused", "timed out", "no route to host", "network is unreachable",
                "connection closed", "connection reset", "kex_exchange_identification")


def classify(code: int, stdout: str, stderr: str) -> str | None:
    """None when the preflight reached a shell, else one of :data:`REASONS`."""
    if code == 0 and "NAVIDE:OK" in stdout:
        return None
    err = stderr.lower()
    if any(word in err for word in _HOST_KEY):
        return "host-key"
    if any(word in err for word in _AUTH):
        return "auth"
    if code in (124, 255) or any(word in err for word in _UNREACHABLE):
        return "unreachable"
    return "other"
