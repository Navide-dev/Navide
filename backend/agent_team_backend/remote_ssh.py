"""SSH Remote panes (experimental): a shell on another machine over ssh.

Only the connection shape exists so far — the target the setup dialog sends,
validated, and the ssh argv a pane would run. Opening the pane is not built
yet (it needs a test host); ``remote_ssh.connect`` answers
``REMOTE_SSH_UNSUPPORTED`` until it is.

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
    """Port and identity options for ``target``. The key goes in as a path."""
    options = ["-p", str(int(target.get("port") or DEFAULT_PORT))]
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
