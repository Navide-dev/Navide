"""SSH Remote panes (experimental): a terminal pane whose shell runs on
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
"""

from __future__ import annotations

import re
from collections.abc import Mapping
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
    """The argv an SSH Remote pane would run: a login shell on the host."""
    return [
        "ssh", "-tt",
        *rd.ssh_base_options(control_path_dir),
        *ssh_options(target),
        "--", destination(target),
    ]


def parse_spec(payload: Any) -> dict[str, Any]:
    """The validated ``remote`` spec of an SSH pane: ``kind`` plus the target."""
    if not isinstance(payload, Mapping) or payload.get("kind") != "ssh":
        raise SshTargetError("not an ssh remote spec")
    return {"kind": "ssh", **parse_target(payload)}


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
