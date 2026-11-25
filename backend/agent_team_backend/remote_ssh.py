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

A pane whose spec names a ``tmuxSession`` (chosen by the app when the pane is
first opened, kept across reconnects, rebuilds and restores) runs inside that
tmux session on the host when the host has tmux (:func:`tmux_script`): a
reconnect attaches to the session that kept running, so the work in it is not
interrupted. Navide runs its own tmux server (``tmux -L navide``), so the
user's own tmux sessions and settings are never touched. Without tmux on the
host the pane starts as above. Closing the pane ends the session
(:func:`end_session_argv`).
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
# id it found (``<prefix><nonce>;<id>BEL``), and that a requested resume found
# nothing to resume (``<prefix><nonce>BEL``). Unknown to a terminal, so nothing
# is drawn. The nonce is new for every launch, so text the CLI prints (a file
# it shows, a page it fetched) cannot pass for either.
SESSION_REPORT = b"\x1b]7737;navide-session;"
RESUME_MISSED = b"\x1b]7737;navide-resume-miss;"
_NONCE_RE = re.compile(r"^[0-9a-f]{32}$")


def new_nonce() -> str:
    import secrets

    return secrets.token_hex(16)

_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,63}$")

# The tmux session of a pane: chosen by the app, one per pane, and safe to put
# on a command line unquoted (tmux reserves "." and ":" in targets).
_TMUX_SESSION_RE = re.compile(r"^navide-[0-9a-f]{16,32}$")
# Navide's own tmux server socket on the host, apart from the user's.
TMUX_SOCKET = "navide"

# Pane ids whose CLI holds a tool token on the host. The token is revoked as
# soon as the pane's ssh exits, even while the pane stays on screen: a CLI
# left running in a tmux session keeps calling its tunnel port while the
# connection is down, and whoever binds that port on the host then would
# be handed the token (revoke_exited).
_TOKEN_PANES: set[str] = set()


def note_token_pane(pane_id: str) -> None:
    _TOKEN_PANES.add(pane_id)


def revoke_exited(pane_id: str) -> None:
    """The ssh of ``pane_id`` exited: revoke its CLI's tool token now."""
    if pane_id in _TOKEN_PANES:
        from .mcp_server import wiring

        _TOKEN_PANES.discard(pane_id)
        wiring.revoke_pane_token(pane_id)


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
    in the spec's remote folder when it names one other than home, inside the
    spec's tmux session when it names one and the host has tmux."""
    argv = [
        "ssh", "-tt",
        *rd.ssh_base_options(control_path_dir),
        *ssh_options(target),
        "--", destination(target),
    ]
    if target.get("tmuxSession"):
        # In its tmux session when the host has tmux; the login shell finds it.
        inner = "exec /bin/sh -c " + shlex.quote(terminal_script({"dir": DEFAULT_DIR, **target}))
        argv.append(f"exec $SHELL -lc {shlex.quote(inner)}")
        return argv
    remote_dir = str(target.get("dir") or DEFAULT_DIR)
    if remote_dir != DEFAULT_DIR:
        argv.append(f"cd {_cd_target(remote_dir)} && exec $SHELL -l")
    return argv


def parse_spec(payload: Any) -> dict[str, Any]:
    """The validated ``remote`` spec of an SSH pane: ``kind``, the target, the
    remote folder, what runs there, the CLI's session id ("" while unknown)
    and ``resume`` — whether this launch continues an earlier one (a
    reconnect, rebuild or restore). ``tmuxSession`` ("" for none) is the
    host's tmux session the pane runs in. ``resume`` is never persisted."""
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
    tmux_session = str(payload.get("tmuxSession") or "")
    if tmux_session and not _TMUX_SESSION_RE.match(tmux_session):
        raise SshTargetError("invalid tmux session")
    return {
        "kind": "ssh", **parse_target(payload),
        "dir": remote_dir, "cli": cli, "sessionId": session_id,
        "tmuxSession": tmux_session,
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


def _session_script(
    cli: str, argv: list[str], session_id: str, resume: bool, nonce: str, out: str = "",
) -> str:
    """The lines that start ``argv`` resuming ``session_id`` when asked to and
    the CLI still has it, else fresh; a resume that cannot happen prints
    :data:`RESUME_MISSED`. ``out`` is where the reports are written: "" for
    the pane's own terminal, or a shell word naming the ssh connection's
    terminal from inside tmux, which would swallow them."""
    if not _NONCE_RE.match(nonce):
        raise SshTargetError("invalid nonce")
    to_out = f" > {out}" if out else ""
    missed = f"printf '{_osc('navide-resume-miss;' + nonce)}'{to_out}; " if resume else ""
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
        report = _osc(f"navide-session;{nonce};%s")
        watcher = (
            "p=$$; ( while kill -0 $p 2>/dev/null; do "
            "f=$( { for q in $p $(pgrep -P $p 2>/dev/null); do "
            "ls -l /proc/$q/fd 2>/dev/null; lsof -p $q -Fn 2>/dev/null; done; } "
            "| grep -o 'rollout-[^/ ]*[.]jsonl' | head -n 1); "
            'if [ -n "$f" ]; then '
            "id=$(printf %s \"$f\" | sed -E 's/.*([0-9A-Fa-f-]{36})[.]jsonl$/\\1/'); "
            f"printf '{report}' \"$id\" > {out or '/dev/tty'}; exit 0; fi; "
            "sleep 2; done ) </dev/null >/dev/null 2>&1 & "
        )
        lines.append(f"{missed}{watcher}exec {cmd}")
        return "".join(lines)
    return f"{missed}exec {cmd}"


def cli_script(spec: Mapping[str, Any], *, pane_id: str, remote_port: int | None, nonce: str) -> str:
    """The /bin/sh script an SSH CLI pane runs on the host."""
    from . import remote_devcontainer as rd_mod
    from .mcp_server import wiring

    cli = spec["cli"]
    token = tmux_token = ""
    if cli in MCP_CLIS:
        if remote_port is None:
            raise SshTargetError("a CLI with Navide tools needs a tunnel port")
        env = wiring.TOKEN_ENV
        request = rd_mod.TOKEN_REQUEST.decode("ascii").replace("\x1b", "\\033").replace("\x07", "\\007")
        token = f"stty -echo; printf '{request}'; IFS= read -r {env}; stty echo; export {env}; "
        # In tmux the token goes to the session only: a variable of this
        # shell's, never exported, so the tmux server this shell may start
        # does not keep it in its global environment for every session.
        tmux_token = f"unset navide_k; stty -echo; printf '{request}'; IFS= read -r navide_k; stty echo; "
        argv = rd_mod.cli_argv(cli, rd_mod.mcp_url({"mode": "host"}, remote_port, pane_id))
    else:
        argv = list(CLI_COMMANDS[cli])
    session_id = str(spec.get("sessionId") or "")
    resume = bool(spec.get("resume"))
    plain = token + _cd_script(spec) + _session_script(cli, argv, session_id, resume, nonce)
    if not spec.get("tmuxSession"):
        return plain
    inner = _session_script(cli, argv, session_id, resume, nonce, out='"$o"')
    return tmux_script(spec, inner, token=tmux_token, fallback=plain)


def _cd_script(spec: Mapping[str, Any]) -> str:
    folder = shlex.quote(spec["dir"])
    return (
        f"cd {_cd_target(spec['dir'])} || "
        f"{{ printf 'Navide: cannot open the remote folder %s\\r\\n' {folder}; exit 1; }}; "
    )


def tmux_script(spec: Mapping[str, Any], inner: str, *, token: str, fallback: str) -> str:
    """The /bin/sh script of a pane that runs in its tmux session.

    The session already there (a reconnect, a rebuild, Navide restarted):
    attach to it, so what runs in it carries on. Otherwise ``token`` (the
    lines reading the tool token, "" for none) runs here, a new detached
    session starts ``inner`` in the remote folder, and this attaches to it.
    ``inner`` gets three lines through a fifo, never through a command line
    or a file: this connection's terminal (``$o``, where reports go, since
    tmux swallows them), the login shell's PATH and the token, which this
    shell holds unexported and no tmux command is run with. On a host
    without tmux, ``fallback`` (the plain launch) runs instead."""
    from .mcp_server import wiring

    name = str(spec["tmuxSession"])
    if not _TMUX_SESSION_RE.match(name):
        raise SshTargetError("invalid tmux session")
    env = wiring.TOKEN_ENV
    # Never with a token in its environment, whatever the login shell set:
    # the server copies the environment of the client that starts it.
    tm = f"env -u {env} -u navide_k tmux -L {TMUX_SOCKET}"
    head = (
        't=$1; unset navide_k; { IFS= read -r o; IFS= read -r p; IFS= read -r navide_k; } < "$t/k"; rm -rf "$t"; '
        'PATH=$p; export PATH; '
    )
    if token:
        head += f"{env}=$navide_k; export {env}; "
    head += "unset navide_k; "
    # The session's own server: no status line, no prefix key (Ctrl-B is
    # the CLI's), no Esc delay, the size of the newest client, and output
    # that reaches the pane's scrollback.
    options = "".join(
        f"{tm} {opt} 2>/dev/null; " for opt in (
            "set-option -g status off", "set-option -g prefix None", "set-option -g prefix2 None",
            "set-option -s escape-time 0", "set-option -g window-size latest",
            "set-option -sa terminal-overrides ',*:smcup@:rmcup@'",
        )
    )
    start = shlex.quote("exec /bin/sh -c " + shlex.quote(head + inner) + " sh ")
    # attach -d: a connection that dropped may still hold the session; the
    # new one takes it over.
    attach = f"exec {tm} attach-session -d -t ={name}"
    return (
        "if command -v tmux >/dev/null 2>&1; then "
        f"if {tm} has-session -t ={name} 2>/dev/null; then {attach}; fi; "
        f"{token}{_cd_script(spec)}"
        "t=$(mktemp -d) && mkfifo \"$t/k\" || { printf 'Navide: cannot start tmux\\r\\n'; exit 1; }; "
        # Its own server starts with no user config and runs the command
        # with /bin/sh, whatever the login shell is.
        f"{tm} -f /dev/null start-server \\; set-option -g default-shell /bin/sh \\; "
        f"new-session -d -s {name} -c \"$PWD\" {start}\"$t\" "
        "|| { rm -rf \"$t\"; printf 'Navide: cannot start tmux\\r\\n'; exit 1; }; "
        f"{options}"
        "o=$(tty 2>/dev/null) || o=/dev/null; "
        "printf '%s\\n' \"$o\" \"$PATH\" \"${navide_k:-}\" > \"$t/k\"; unset navide_k; "
        f"{attach}; "
        f"fi; {fallback}"
    )


def terminal_script(spec: Mapping[str, Any]) -> str:
    """The /bin/sh script of a terminal pane that runs in its tmux session:
    a login shell there, or, without tmux, here."""
    fallback = _cd_script(spec) + "exec $SHELL -l"
    return tmux_script(spec, "exec $SHELL -l", token="", fallback=fallback)


def end_session_argv(spec: Mapping[str, Any]) -> list[str]:
    """One non-interactive call that ends a closed pane's tmux session, so
    nothing is left running on the host. Its own connection, like the
    preflight."""
    name = str(spec.get("tmuxSession") or "")
    if not _TMUX_SESSION_RE.match(name):
        raise SshTargetError("invalid tmux session")
    command = f"tmux -L {TMUX_SOCKET} kill-session -t ={name} 2>/dev/null; true"
    return [
        "ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        *rd.ssh_base_options(None),
        "-o", "ControlPath=none",
        *ssh_options(spec),
        "--", destination(spec),
        f"exec $SHELL -lc {shlex.quote(command)}",
    ]


def cli_pane_argv(
    spec: Mapping[str, Any],
    *,
    pane_id: str,
    local_port: int | None,
    remote_port: int,
    nonce: str,
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
            # the pane without its tools, or its token for whoever holds it.
            "-o", "ExitOnForwardFailure=yes",
            "-R", f"127.0.0.1:{remote_port}:127.0.0.1:{local_port}",
        ]
    script = cli_script(spec, pane_id=pane_id, remote_port=port, nonce=nonce)
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
    """Reads this launch's :data:`SESSION_REPORT` and :data:`RESUME_MISSED`
    out of an SSH CLI pane's output, each at most once and only with the
    launch's nonce. ``on_session`` is None for a CLI whose id was chosen
    here (claude): nothing on the host may replace it. Fed every chunk; holds
    a short tail so a sequence split across two reads is still seen."""

    def __init__(
        self,
        nonce: str,
        on_session: Callable[[str], Any] | None,
        on_missed: Callable[[], Any],
    ) -> None:
        self._session_prefix = SESSION_REPORT + nonce.encode("ascii") + b";"
        self._missed_seq = RESUME_MISSED + nonce.encode("ascii") + b"\x07"
        self._tail_len = len(self._session_prefix) + 80
        self._on_session = on_session
        self._on_missed = on_missed
        self._tail = b""
        self.session_id = ""
        self.missed = False

    def _done(self) -> bool:
        return self.missed and (self._on_session is None or bool(self.session_id))

    def feed(self, chunk: bytes) -> None:
        if self._done():
            return
        data = self._tail + chunk
        if not self.missed and self._missed_seq in data:
            self.missed = True
            self._on_missed()
        start = data.find(self._session_prefix) if self._on_session is not None and not self.session_id else -1
        if start >= 0:
            end = data.find(b"\x07", start)
            if end >= 0:
                value = data[start + len(self._session_prefix):end].decode("ascii", "replace")
                if _SESSION_ID_RE.match(value):
                    self.session_id = value
                    self._on_session(value)
                data = data[end + 1:]
        self._tail = data[-self._tail_len:]


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
