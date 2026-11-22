"""WebSocket requests for remote devcontainer panes (experimental).

``remote_devcontainer.list`` lists a host's containers, ``remote_devcontainer.probe``
tests one, and ``terminal.create`` with a ``remote`` object opens the pane
through :func:`create_remote_pane`. Every request is refused with
``REMOTE_DISABLED`` while the experimental switch is off.

A remote pane skips everything about local credentials by construction: no
CODEX_HOME, no account dir, no credential launch helper, no launch provenance,
no local MCP config file. Its term metadata carries ``remote``, which the
account-switch and failover callers read to leave it alone.

Registered on import (app imports this module next to ws_handlers).
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import TYPE_CHECKING, Any

from . import remote_devcontainer as rd
from .ipc import make_error, make_response
from .ws_handlers import handler

if TYPE_CHECKING:
    from .app import Session

log = logging.getLogger("agent_team_backend.remote_devcontainer_ws")

_SSH_TIMEOUT_S = 25.0

# Keys only the backend may set on a remote pane's metadata.
_SERVER_KEYS = (
    "quota_transaction_id", "quota_original_pane_id", "credential_epoch",
    "credential_store_verified", "credential_store_id", "credential_store_error",
    "credential_launch_term_id", "guard_pane_token", "account_dir_profile_id",
    "account_dir_login", "login_profile_id", "live_login", "profile_id",
    "launch_profile_id", "auth_scope", "credential_source", "credential_env",
)


async def _settings() -> dict[str, Any]:
    from . import app
    from .db_executor import run_in_db_thread

    return await run_in_db_thread(app.ui_settings_store.get)


async def _enabled() -> bool:
    return rd.enabled(await _settings())


def is_remote_term(term: Any) -> bool:
    metadata = getattr(term, "metadata", None)
    return isinstance(metadata, dict) and bool(metadata.get(rd.METADATA_KEY))


def is_remote_pane(pane_id: str) -> bool:
    """Whether a live PTY of ``pane_id`` is a remote pane."""
    from . import app

    for tid, owner in list(app._PTY_OWNERS.items()):
        term = owner.terminals.get(tid)
        if term is not None and not term.closed and term.pane_id == pane_id and is_remote_term(term):
            return True
    return False


async def _run_ssh(argv: list[str]) -> tuple[int, str, str]:
    env = {key: value for key, value in os.environ.items() if key not in set(rd.spawn_env_remove(os.environ))}
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=_SSH_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()  # our own child, by its handle
        await proc.wait()
        return 124, "", "timed out"
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def _ssh_error(code: int, stderr: str) -> dict[str, Any]:
    tail = "\n".join(stderr.strip().splitlines()[-3:])
    return {"exit_code": code, "stderr": tail[:600]}


@handler("remote_devcontainer.list")
async def remote_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    if not await _enabled():
        await session.send_json(make_error(msg_id, msg_type, "REMOTE_DISABLED", "remote devcontainer panes are off"))
        return
    try:
        argv = rd.list_argv(str(payload.get("host") or ""), rd.control_dir())
    except rd.RemoteSpecError as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    code, out, err = await _run_ssh(argv)
    if code != 0:
        await session.send_json(make_error(
            msg_id, msg_type, "REMOTE_SSH_FAILED", "could not list containers", _ssh_error(code, err)))
        return
    await session.send_json(make_response(msg_id, msg_type, {"containers": rd.parse_container_list(out)}))


@handler("remote_devcontainer.probe")
async def remote_probe(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from .mcp_server import wiring

    if not await _enabled():
        await session.send_json(make_error(msg_id, msg_type, "REMOTE_DISABLED", "remote devcontainer panes are off"))
        return
    local_port = wiring.backend_port()
    try:
        spec = rd.parse_remote(payload.get("remote"))
        if local_port is None:
            raise rd.RemoteSpecError("backend port unknown")
        argv = rd.probe_argv(
            spec, local_port=local_port, remote_port=rd.pick_remote_port(),
            control_path_dir=rd.control_dir(),
        )
    except rd.RemoteSpecError as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    loop = asyncio.get_running_loop()
    started = loop.time()
    code, out, err = await _run_ssh(argv)
    elapsed_ms = int((loop.time() - started) * 1000)
    if code == 255 or code == 124:
        await session.send_json(make_error(
            msg_id, msg_type, "REMOTE_SSH_FAILED", "could not reach the host", _ssh_error(code, err)))
        return
    result = rd.parse_probe(out, spec["network"])
    result.update({"host_ok": True, "container_ok": code == 0 or bool(result["cli_path"]), "elapsed_ms": elapsed_ms})
    if not result["container_ok"]:
        result["error"] = _ssh_error(code, err)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("remote_devcontainer.trust")
async def remote_trust(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The user opened this target from the setup dialog: remember it in the
    app-level trusted list, the only place create_remote_pane accepts a
    target from."""
    from . import app
    from .db_executor import run_in_db_thread

    if not await _enabled():
        await session.send_json(make_error(msg_id, msg_type, "REMOTE_DISABLED", "remote devcontainer panes are off"))
        return
    try:
        spec = rd.parse_remote(payload.get("remote"))
    except rd.RemoteSpecError as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    trusted = rd.with_trusted(await _settings(), spec)
    await run_in_db_thread(app.ui_settings_store.set, {rd.TRUSTED_KEY: trusted})
    await session.send_json(make_response(msg_id, msg_type, {"trusted": True}))


async def create_remote_pane(
    session: "Session",
    msg_id: str,
    msg_type: str,
    payload: dict,
    transaction: dict[str, Any],
    generation: str,
) -> None:
    """``terminal.create`` for a pane whose payload carries ``remote``."""
    from . import app
    from .mcp_server import wiring

    remote = payload.get("remote")
    if isinstance(remote, dict) and remote.get("kind") == "ssh":
        await create_ssh_pane(session, msg_id, msg_type, payload, transaction, generation)
        return

    settings = await _settings()
    if not rd.enabled(settings):
        await session.send_json(make_error(msg_id, msg_type, "REMOTE_DISABLED", "remote devcontainer panes are off"))
        return
    agent_key = str(payload.get("agent_key") or "")
    pane_id = str(payload["pane_id"])
    local_port = wiring.backend_port()
    try:
        spec = rd.parse_remote(payload.get("remote"))
        if agent_key != rd.AGENT_KEY:
            raise rd.RemoteSpecError(f"a remote pane's agent_key is {rd.AGENT_KEY!r}, not {agent_key!r}")
        if local_port is None:
            raise rd.RemoteSpecError("backend port unknown")
        if not rd.is_trusted(settings, spec):
            # A target from a restored pane record that the user never opened
            # from the dialog (a workspace database can carry one): no ssh.
            await session.send_json(make_error(
                msg_id, msg_type, "REMOTE_UNTRUSTED",
                "open this host and container from the remote container dialog first",
                {"host": spec["host"], "container": spec["container"]},
            ))
            return
        argv = rd.pane_argv(
            spec, pane_id=pane_id, local_port=local_port,
            remote_port=rd.pick_remote_port(),
        )
    except rd.RemoteSpecError as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return

    metadata = dict(payload.get("metadata") or {})
    for key in _SERVER_KEYS:
        metadata.pop(key, None)
    metadata[rd.METADATA_KEY] = spec

    # The previous PTY of this pane, on a rebuild or reconnect.
    replaces_tid = str(payload.get("replaces_terminal_id") or "")
    if replaces_tid:
        stale = session.terminals.get(replaces_tid)
        if stale is not None and not stale.closed and stale.pane_id == pane_id:
            await session.terminals.kill(replaces_tid, force=True)
            await session.terminals.wait_until_reaped(replaces_tid)
    if transaction["cancelled"]:
        from .ws_handlers import _TerminalCreateCancelled

        raise _TerminalCreateCancelled

    cwd = str(payload.get("cwd") or "")
    if not os.path.isdir(cwd):
        cwd = rd.default_cwd()
    term = session.terminals.create(
        pane_id=pane_id,
        agent_key=agent_key,
        command=argv,
        cwd=cwd,
        cols=int(payload.get("cols", 100)),
        rows=int(payload.get("rows", 30)),
        env_remove=rd.spawn_env_remove(os.environ),
        metadata=metadata,
    )
    transaction["term_id"] = term.id
    app._PTY_OWNERS[term.id] = session
    feeder = rd.TokenFeeder(
        wiring.spawn_token(pane_id),
        lambda text: session.terminals.write(term.id, text),
    )
    term.output_taps.append(feeder.feed)

    response_payload = {
        "terminal_session_id": term.id,
        "pane_id": term.pane_id,
        "pid": term.proc.pid,
        "command": [argv[0], spec["host"], spec["container"], spec["cli"]],
        "startup_probe": None,
        "create_generation": generation,
        "remote": spec,
    }
    await session.send_json(make_response(msg_id, msg_type, response_payload))
    if session.dead or transaction["cancelled"]:
        from .ws_handlers import _TerminalCreateCancelled

        raise _TerminalCreateCancelled
    transaction["response_payload"] = response_payload
    transaction["committed"] = True


@handler("remote_ssh.connect")
async def remote_ssh_connect(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """SSH Remote dialog → Connect: one BatchMode ssh call to the target. On
    success, or with ``force`` after a key or host-key refusal (the pane's
    own ssh can then ask for a passphrase or the fingerprint), the target is
    remembered as trusted and the answer is ``{"spec": ...}`` for
    ``terminal.create``. A failure is ``REMOTE_SSH_FAILED`` with ``reason``,
    one of remote_ssh.REASONS. Rides the remote panes switch."""
    from . import app, remote_ssh
    from .db_executor import run_in_db_thread

    if not await _enabled():
        await session.send_json(make_error(msg_id, msg_type, "REMOTE_DISABLED", "remote panes are off"))
        return
    try:
        target = remote_ssh.parse_target(payload.get("target"))
        argv = remote_ssh.preflight_argv(target)
    except (remote_ssh.SshTargetError, rd.RemoteSpecError) as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    code, out, err = await _run_ssh(argv)
    reason = remote_ssh.classify(code, out, err)
    if reason is not None and not (payload.get("force") is True and reason in ("auth", "host-key")):
        await session.send_json(make_error(
            msg_id, msg_type, "REMOTE_SSH_FAILED", f"ssh failed: {reason}",
            {"reason": reason, **_ssh_error(code, err)},
        ))
        return
    trusted = remote_ssh.with_trusted(await _settings(), target)
    await run_in_db_thread(app.ui_settings_store.set, {remote_ssh.TRUSTED_KEY: trusted})
    await session.send_json(make_response(msg_id, msg_type, {"spec": {"kind": "ssh", **target}}))


async def create_ssh_pane(
    session: "Session",
    msg_id: str,
    msg_type: str,
    payload: dict,
    transaction: dict[str, Any],
    generation: str,
) -> None:
    """``terminal.create`` for an SSH Remote terminal pane: the login shell on
    a target the user connected to from the dialog, never one a pane record
    alone names."""
    from . import app, remote_ssh

    settings = await _settings()
    if not rd.enabled(settings):
        await session.send_json(make_error(msg_id, msg_type, "REMOTE_DISABLED", "remote panes are off"))
        return
    pane_id = str(payload["pane_id"])
    try:
        spec = remote_ssh.parse_spec(payload.get("remote"))
        if str(payload.get("agent_key") or "") != "terminal":
            raise remote_ssh.SshTargetError("an SSH Remote pane is a terminal pane")
        argv = remote_ssh.shell_argv(spec)
    except (remote_ssh.SshTargetError, rd.RemoteSpecError) as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    if not remote_ssh.is_trusted(settings, spec):
        await session.send_json(make_error(
            msg_id, msg_type, "REMOTE_UNTRUSTED", "connect to this host from the SSH Remote dialog first",
            {"host": spec["host"]},
        ))
        return

    metadata = dict(payload.get("metadata") or {})
    for key in _SERVER_KEYS:
        metadata.pop(key, None)
    metadata[remote_ssh.METADATA_KEY] = spec

    replaces_tid = str(payload.get("replaces_terminal_id") or "")
    if replaces_tid:
        stale = session.terminals.get(replaces_tid)
        if stale is not None and not stale.closed and stale.pane_id == pane_id:
            await session.terminals.kill(replaces_tid, force=True)
            await session.terminals.wait_until_reaped(replaces_tid)
    if transaction["cancelled"]:
        from .ws_handlers import _TerminalCreateCancelled

        raise _TerminalCreateCancelled

    cwd = str(payload.get("cwd") or "")
    if not os.path.isdir(cwd):
        cwd = rd.default_cwd()
    term = session.terminals.create(
        pane_id=pane_id,
        agent_key="terminal",
        command=argv,
        cwd=cwd,
        cols=int(payload.get("cols", 100)),
        rows=int(payload.get("rows", 30)),
        env_remove=rd.spawn_env_remove(os.environ),
        metadata=metadata,
    )
    transaction["term_id"] = term.id
    app._PTY_OWNERS[term.id] = session
    response_payload = {
        "terminal_session_id": term.id,
        "pane_id": term.pane_id,
        "pid": term.proc.pid,
        "command": [argv[0], remote_ssh.destination(spec)],
        "startup_probe": None,
        "create_generation": generation,
        "remote": spec,
    }
    await session.send_json(make_response(msg_id, msg_type, response_payload))
    if session.dead or transaction["cancelled"]:
        from .ws_handlers import _TerminalCreateCancelled

        raise _TerminalCreateCancelled
    transaction["response_payload"] = response_payload
    transaction["committed"] = True
