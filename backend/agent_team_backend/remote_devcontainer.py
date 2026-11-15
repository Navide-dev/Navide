"""Remote devcontainer panes (experimental, off by default).

A Claude or Codex pane that runs inside a Docker container on another machine:
``ssh -tt host`` → ``docker exec -it container`` → the CLI. Navide's MCP
endpoint reaches the container through an ``ssh -R`` reverse tunnel.

What never leaves this machine: account credentials, API keys, the SSH agent.
The pane's own MCP token is the one value that does — the remote CLI needs it
to call back — and it travels as the first line of the PTY's input, read with
echo off, never on a command line (``ps`` on the remote host would show it).

Only the host alias and the container name are stored; the connection uses the
user's own ssh configuration. Nothing here runs ``ssh-add`` or reads or writes
``~/.ssh``.
"""

from __future__ import annotations

import json
import os
import random
import re
import shlex
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

# ui_settings key; off when absent or not exactly True.
SETTING_KEY = "remoteDevcontainerExperimental"

# Term metadata key carrying {"host", "container", "network"}; its presence is
# what marks a pane as remote everywhere else (account switch, failover).
METADATA_KEY = "remote"

AGENTS = ("claude", "codex")

# ui_settings key: the targets the user opened from the setup dialog. App-level
# on purpose — a pane record lives in the workspace's .agent-team/ database,
# which a cloned repository can carry, so a target found there is only a claim.
# A pane connects only to a target listed here.
TRUSTED_KEY = "remoteDevcontainerTrusted"
TRUSTED_MAX = 100

# The remote side prints this once its tty echo is off; only then is the
# token written. An OSC sequence: a terminal that does not know it draws
# nothing.
TOKEN_REQUEST = b"\x1b]7737;navide-token\x07"

# An ssh config alias, or user@host. A leading "-" would be read as an option.
_HOST_RE = re.compile(r"^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$")
# Docker's own container-name rule.
_CONTAINER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_IPV4_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")

# Environment the local ssh client keeps. Everything else is removed from the
# spawn so that no SendEnv line in the user's ssh config can carry a local
# credential (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) to the remote host.
# SSH_AUTH_SOCK stays for local key authentication; forwarding it is off.
_ENV_KEEP = frozenset({
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM",
    "LANG", "SSH_AUTH_SOCK", "COLUMNS", "LINES",
    "SYSTEMROOT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
})

REMOTE_PORT_RANGE = (40000, 59999)


class RemoteSpecError(ValueError):
    """A host, container or agent that cannot be used."""


def enabled(settings: Mapping[str, Any] | None) -> bool:
    return bool(settings) and settings.get(SETTING_KEY) is True


def _trusted_rows(settings: Mapping[str, Any] | None) -> list[dict[str, str]]:
    raw = (settings or {}).get(TRUSTED_KEY)
    if not isinstance(raw, list):
        return []
    return [
        {"host": str(row["host"]), "container": str(row["container"])}
        for row in raw
        if isinstance(row, Mapping) and isinstance(row.get("host"), str) and isinstance(row.get("container"), str)
    ]


def is_trusted(settings: Mapping[str, Any] | None, spec: Mapping[str, Any]) -> bool:
    return any(
        row["host"] == spec["host"] and row["container"] == spec["container"]
        for row in _trusted_rows(settings)
    )


def with_trusted(settings: Mapping[str, Any] | None, spec: Mapping[str, Any]) -> list[dict[str, str]]:
    """The trusted list with ``spec`` first, names only, capped."""
    entry = {"host": spec["host"], "container": spec["container"]}
    rest = [row for row in _trusted_rows(settings) if row != entry]
    return [entry, *rest][:TRUSTED_MAX]


def validate_host(host: str) -> str:
    host = str(host or "").strip()
    if not _HOST_RE.match(host):
        raise RemoteSpecError(f"invalid host: {host!r}")
    return host


def validate_container(container: str) -> str:
    container = str(container or "").strip()
    if not _CONTAINER_RE.match(container):
        raise RemoteSpecError(f"invalid container name: {container!r}")
    return container


def validate_network(network: Mapping[str, Any] | None) -> dict[str, str]:
    """``{"mode": "host"}`` or ``{"mode": "bridge", "gateway": "<ipv4>"}``."""
    network = network or {}
    mode = str(network.get("mode") or "host")
    if mode == "host":
        return {"mode": "host"}
    if mode == "bridge":
        gateway = str(network.get("gateway") or "")
        if not _IPV4_RE.match(gateway):
            raise RemoteSpecError(f"invalid bridge gateway: {gateway!r}")
        return {"mode": "bridge", "gateway": gateway}
    raise RemoteSpecError(f"invalid network mode: {mode!r}")


def parse_remote(payload: Any) -> dict[str, Any]:
    """The validated remote spec from a terminal.create payload's ``remote``."""
    if not isinstance(payload, Mapping):
        raise RemoteSpecError("remote must be an object")
    return {
        "host": validate_host(payload.get("host", "")),
        "container": validate_container(payload.get("container", "")),
        "network": validate_network(payload.get("network")),
    }


def control_dir() -> Path | None:
    """Where ssh keeps its ControlMaster sockets: one connection per host,
    shared by every pane opened on it. Under /tmp on purpose — a unix socket
    path has a ~104-byte limit the app data dir would overrun. Owner-only;
    None (no connection sharing) on Windows, whose OpenSSH lacks it, or when
    the directory is not safely ours."""
    if os.name == "nt":
        return None
    path = Path(f"/tmp/navide-cm-{os.getuid()}")
    try:
        path.mkdir(mode=0o700, exist_ok=True)
        st = path.lstat()
        import stat

        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
            return None
        if st.st_mode & 0o077:
            path.chmod(0o700)
    except OSError:
        return None
    return path


def ssh_base_options(control_path_dir: Path | None) -> list[str]:
    options = [
        # 26–30 ms of added latency per keystroke on OpenSSH 10 without this.
        "-o", "ObscureKeystrokeTiming=no",
        # Never hand the local agent, X11 or a local credential to the host.
        "-o", "ForwardAgent=no",
        "-o", "ForwardX11=no",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
    ]
    if control_path_dir is not None:
        options += [
            "-o", "ControlMaster=auto",
            "-o", f"ControlPath={control_path_dir}/%C",
            "-o", "ControlPersist=60",
        ]
    return options


def pick_remote_port(rng: random.Random | None = None) -> int:
    return (rng or random).randint(*REMOTE_PORT_RANGE)


def tunnel_host(network: Mapping[str, str]) -> str:
    """The address the container dials, and the remote end of ``-R`` binds."""
    return network["gateway"] if network.get("mode") == "bridge" else "127.0.0.1"


def mcp_url(network: Mapping[str, str], remote_port: int, pane_id: str) -> str:
    """The endpoint as the container sees it. No token: it rides as a bearer
    header read from NAVIDE_MCP_TOKEN."""
    from urllib.parse import quote

    return f"http://{tunnel_host(network)}:{remote_port}/plan-mcp?pane={quote(pane_id, safe='')}"


def cli_argv(agent_key: str, url: str) -> list[str]:
    """The CLI and its MCP wiring, as content rather than a local file path."""
    from .mcp_server import wiring

    if agent_key == "claude":
        document = wiring.config_document("claude", url)
        for entry in document.get("mcpServers", {}).values():
            # Expanded by Claude Code from the container's environment.
            entry["headers"] = {"Authorization": f"Bearer ${{{wiring.TOKEN_ENV}}}"}
        return ["claude", "--mcp-config", json.dumps(document, separators=(",", ":"))]
    if agent_key == "codex":
        name = wiring.SERVER_NAME
        return [
            "codex",
            "-c", f'mcp_servers.{name}.url="{url}"',
            "-c", f'mcp_servers.{name}.bearer_token_env_var="{wiring.TOKEN_ENV}"',
        ]
    raise RemoteSpecError(f"remote panes support claude and codex, not {agent_key!r}")


def remote_script(container: str, argv: list[str]) -> str:
    """The shell line run on the remote host.

    Echo goes off before the token is requested, so the token never shows on
    the pane; it is exported and handed to ``docker exec`` by name only.
    """
    from .mcp_server import wiring

    env = wiring.TOKEN_ENV
    request = TOKEN_REQUEST.decode("ascii").replace("\x1b", "\\033").replace("\x07", "\\007")
    return (
        f"stty -echo; printf '{request}'; IFS= read -r {env}; stty echo; export {env}; "
        "export LANG=C.UTF-8 LC_ALL=C.UTF-8; "
        f"exec docker exec -it -e {env} -e LANG -e LC_ALL -e TERM "
        f"{shlex.quote(container)} {shlex.join(argv)}"
    )


def pane_argv(
    spec: Mapping[str, Any],
    agent_key: str,
    *,
    pane_id: str,
    local_port: int,
    remote_port: int,
    control_path_dir: Path | None,
) -> list[str]:
    network = spec["network"]
    forward = f"{tunnel_host(network)}:{remote_port}:127.0.0.1:{local_port}"
    argv = cli_argv(agent_key, mcp_url(network, remote_port, pane_id))
    return [
        "ssh", "-tt",
        *ssh_base_options(control_path_dir),
        # A taken remote port fails the connection rather than leaving the
        # pane without its tools.
        "-o", "ExitOnForwardFailure=yes",
        "-R", forward,
        spec["host"], "--",
        remote_script(spec["container"], argv),
    ]


def list_argv(host: str, control_path_dir: Path | None) -> list[str]:
    """Lists the host's containers, with the network facts a pane needs."""
    fmt = "{{.Name}}\t{{.State.Status}}\t{{.HostConfig.NetworkMode}}\t" \
          "{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}"
    script = f"docker ps -aq | xargs -r docker inspect --format {shlex.quote(fmt)}"
    return [
        "ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        *ssh_base_options(control_path_dir),
        validate_host(host), "--", script,
    ]


def parse_container_list(text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        name = parts[0].strip().lstrip("/")
        if not _CONTAINER_RE.match(name):
            continue
        mode = parts[2].strip()
        gateways = [g for g in (parts[3].split() if len(parts) > 3 else []) if _IPV4_RE.match(g)]
        if mode == "host":
            network: dict[str, str] = {"mode": "host"}
        elif gateways:
            network = {"mode": "bridge", "gateway": gateways[0]}
        else:
            network = {"mode": "unsupported", "detail": mode}
        rows.append({
            "name": name,
            "running": parts[1].strip() == "running",
            "network": network,
        })
    rows.sort(key=lambda row: (not row["running"], row["name"]))
    return rows


def probe_argv(
    spec: Mapping[str, Any],
    agent_key: str,
    *,
    local_port: int,
    remote_port: int,
    control_path_dir: Path | None,
) -> list[str]:
    """Connection test: reaches the host, enters the container, finds the CLI,
    and calls the MCP endpoint through the tunnel WITHOUT a token — a 401
    proves the path works and sends nothing secret."""
    if agent_key not in AGENTS:
        raise RemoteSpecError(f"remote panes support claude and codex, not {agent_key!r}")
    network = spec["network"]
    url = f"http://{tunnel_host(network)}:{remote_port}/plan-mcp"
    inner = (
        f'echo "CLI:$(command -v {agent_key})"; '
        f'echo "VER:$({agent_key} --version 2>/dev/null | head -n 1)"; '
        f"echo \"MCP:$(curl -s -o /dev/null -w '%{{http_code}}' --max-time 5 -X POST {url} 2>/dev/null || echo none)\""
    )
    script = f"docker exec {shlex.quote(spec['container'])} sh -lc {shlex.quote(inner)}"
    return [
        "ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        *ssh_base_options(control_path_dir),
        "-o", "ExitOnForwardFailure=yes",
        "-R", f"{tunnel_host(network)}:{remote_port}:127.0.0.1:{local_port}",
        spec["host"], "--", script,
    ]


def parse_probe(text: str) -> dict[str, Any]:
    fields: dict[str, str] = {}
    for line in text.splitlines():
        key, sep, value = line.partition(":")
        if sep and key in ("CLI", "VER", "MCP"):
            fields[key] = value.strip()
    mcp = fields.get("MCP", "")
    if mcp == "401":
        # Reached the endpoint and refused without a token: the tunnel works.
        status = "ok"
    elif mcp.startswith("000"):
        # curl ran (and printed 000) but could not connect.
        status = "unreachable"
    elif mcp[:3].isdigit():
        status = f"http-{mcp[:3]}"
    else:
        # No curl in the container: the tunnel is untested, not broken.
        status = "unknown"
    return {
        "cli_path": fields.get("CLI", ""),
        "cli_version": fields.get("VER", ""),
        "mcp": status,
    }


def spawn_env_remove(environ: Mapping[str, str]) -> list[str]:
    """Every variable the ssh client does not need, to be removed at spawn."""
    return sorted(
        key for key in environ
        if key not in _ENV_KEEP and not key.startswith("LC_")
    )


class TokenFeeder:
    """Writes the pane's token once the remote side asks for it.

    Fed every chunk of PTY output until it fires; holds a short tail so a
    request split across two reads is still seen.
    """

    def __init__(self, token: str, write: Callable[[str], Any]) -> None:
        self._token = token
        self._write = write
        self._tail = b""
        self.done = False

    def feed(self, chunk: bytes) -> None:
        if self.done:
            return
        data = self._tail + chunk
        if TOKEN_REQUEST in data:
            self.done = True
            self._tail = b""
            self._write(self._token + "\r")
            return
        self._tail = data[-(len(TOKEN_REQUEST) - 1):]


def default_cwd() -> str:
    return os.path.expanduser("~")
