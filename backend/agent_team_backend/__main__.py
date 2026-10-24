from __future__ import annotations

import argparse
import logging
import sys

from .git_askpass_helper import ASKPASS_FLAG, main as askpass_main
from .credential_path_helper import HELPER_FLAG, main as credential_path_main
from .agent_tool_result_worker import WORKER_FLAG as RESULT_WORKER_FLAG, main as result_worker_main

if len(sys.argv) > 1 and sys.argv[1] == HELPER_FLAG:
    raise SystemExit(credential_path_main(sys.argv[2:]))

# The helper process that parses and wraps large agent tool results
# (agent_tool_result_worker): its frames own stdout.
if len(sys.argv) > 1 and sys.argv[1] == RESULT_WORKER_FLAG:
    raise SystemExit(result_worker_main())

# This process was started by git as GIT_ASKPASS (through the launcher
# `osplat.paths.askpass_launcher` wrote), not to serve: answer the one prompt
# on argv and exit, which the helper does itself.
#
# Before the imports below, not inside `main()`, and this is why: git takes the
# FIRST LINE OF STDOUT as the credential, and importing the backend prints to
# stdout on the way up. It also keeps a credential prompt instant instead of
# paying for a whole backend import.
#
# Deliberately not an argparse subcommand: git's prompt is free text ("Password
# for 'https://x':") that must never be parsed as options.
if len(sys.argv) > 1 and sys.argv[1] == ASKPASS_FLAG:
    askpass_main(sys.argv[2] if len(sys.argv) > 2 else "")


def _self_check_conpty() -> int:
    """Prove the packaged build can actually open a ConPTY, then exit.

    Windows CI runs this against the FROZEN onefile exe after packaging. The
    unit tests can only see what the spec collects; they cannot see whether the
    bootloader extracts winpty's `OpenConsole.exe` such that conpty.dll finds
    it at runtime. The real work lives in the platform seam
    (`osplat.terminal_backend.self_check_conpty`) so nothing here branches on
    the platform: Windows spawns a real ConPTY and fails on a torn-down
    pseudoconsole, POSIX reports a skip. Kept before the heavy imports and
    behind an explicit flag so it costs a normal launch nothing.
    """
    from . import osplat

    ok, message = osplat.terminal_backend.self_check_conpty()
    print(message)
    return 0 if ok else 1


if len(sys.argv) > 2 and sys.argv[1] == "--self-check" and sys.argv[2] == "conpty":
    raise SystemExit(_self_check_conpty())

import faulthandler  # noqa: E402
import os  # noqa: E402
import signal  # noqa: E402
import socket  # noqa: E402

import threading  # noqa: E402
import time  # noqa: E402

import uvicorn  # noqa: E402

from . import __version__, osplat  # noqa: E402
from .app import app as _fastapi_app, cli_risk_service  # noqa: E402
from . import app as _app_module  # noqa: E402
from . import confirm_token, log_redaction, ws_auth  # noqa: E402
from .applog import backend_port_file, setup_file_logging  # noqa: E402


def _read_confirm_key(stream=None) -> str:
    """The first line of stdin, or "" when there is nothing there.

    Never blocks a backend started by hand: the app closes the pipe straight
    after writing, so EOF is the ordinary answer for every other caller, and a
    terminal that is a tty is not read from at all.
    """
    stream = sys.stdin if stream is None else stream
    try:
        if stream is None or stream.closed or stream.isatty():
            return ""
        return stream.readline().strip()
    except Exception:  # noqa: BLE001 - startup must not die over a missing pipe
        return ""


def _read_handover(stream=None) -> tuple[str, str]:
    """``(confirm key, host token)`` from the first line of stdin.

    Main writes both on that one line, separated by a space. One line, not
    two: a launcher that writes a single line and keeps the pipe open for the
    `shutdown` line (Windows, the cli_regression harness) must not leave the
    backend waiting on a second one. No host token on the line means none.
    """
    confirm, _, host = _read_confirm_key(stream).partition(" ")
    return confirm, host.strip()


SHUTDOWN_LINE = "shutdown"

# Set only by the cli_regression harness: a backend that does not exit after
# the shutdown line gets SIGUSR1 before it is killed, and this dumps every
# thread's stack to stderr so the step it hung in is on record. Unset (every
# real launch) nothing is registered. Windows has no SIGUSR1.
SHUTDOWN_DIAG_ENV = "NAVIDE_SHUTDOWN_DIAG"


def _register_shutdown_diag(environ=None) -> bool:
    environ = os.environ if environ is None else environ
    if environ.get(SHUTDOWN_DIAG_ENV) != "1" or not hasattr(signal, "SIGUSR1"):
        return False
    faulthandler.register(signal.SIGUSR1, file=sys.stderr, all_threads=True)
    return True


def _watch_stdin_for_shutdown(server: "uvicorn.Server", stream=None) -> None:
    """Turn a `shutdown` line on stdin into uvicorn's cooperative exit.

    The parent process closes stdin right after the confirm key on POSIX, so
    EOF is the ordinary case there and means nothing. On Windows there is no
    SIGTERM to deliver, so Electron keeps the pipe open and writes this line
    to run the same lifespan shutdown (PTY sweep, watcher teardown) a signal
    would. Any other line is ignored; a missing or tty stdin is never read.
    """
    stream = sys.stdin if stream is None else stream
    try:
        if stream is None or stream.closed or stream.isatty():
            return
        for line in stream:
            if line.strip() == SHUTDOWN_LINE:
                logging.getLogger("agent_team_backend.main").info("shutdown requested on stdin")
                server.should_exit = True
                return
    except Exception:  # noqa: BLE001 - a broken pipe must not take the server down
        return


# How long uvicorn waits on in-flight requests after SIGTERM before the
# lifespan teardown (and with it the PTY sweep) starts. See the call site.
# Parked rewake long-polls always use all of it, and the sweep after it waits
# out the largest vendor SIGTERM grace — both must fit inside main's SIGKILL
# timer (tests/test_shutdown_budget.py), so this stays short.
_GRACEFUL_SHUTDOWN_S = 0.5


def _watch_parent_for_shutdown(
    server: "uvicorn.Server", pid: int, *, interval_s: float = 2.0, is_alive=None, identity=None
) -> None:
    """The backend dies with the app when the app cannot say so itself.

    Same cooperative exit as a `shutdown` line on stdin: `should_exit` lets
    uvicorn run the lifespan shutdown (PTY sweep, watcher teardown) instead of
    leaving every CLI child behind. Polled, because neither platform has a
    signal for "your parent is gone" that survives the PyInstaller bootloader
    and `uv run` sitting between the app and this process — and on Windows the
    normal quit's stdin `shutdown` never runs after a crash or a Task-Manager
    kill either.

    The pid alone is not enough on Windows, which reuses pids quickly: a dead
    parent's number can belong to something else within the poll interval and
    read as "still alive". So capture the parent's `identity` (pid + start
    time) up front and treat a changed identity as the parent being gone, the
    same reading `process_tree.identity` is documented for.
    """
    alive = is_alive or osplat.process_tree.is_alive
    identity_of = identity or osplat.process_tree.identity
    log = logging.getLogger("agent_team_backend.main")
    # "" means the probe could not read the identity (a `ps` that timed out on a
    # loaded machine): that is "unknown", never "gone". An unread original is
    # captured on a later poll; until then liveness is the only check.
    original_identity = identity_of(pid)
    while not server.should_exit:
        if not alive(pid):
            log.info("parent process %d is gone (no such process); shutting down", pid)
            server.should_exit = True
            return
        current = identity_of(pid)
        if current and not original_identity:
            original_identity = current
        elif current and current != original_identity:
            log.info(
                "parent process %d is gone (identity changed %r -> %r); shutting down",
                pid, original_identity, current,
            )
            server.should_exit = True
            return
        time.sleep(interval_s)


def main() -> int:
    parser = argparse.ArgumentParser(prog="navide-backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 = pick a free port")
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level.upper(),
        format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("agent_team_backend")
    log_file = setup_file_logging(args.log_level)
    _register_shutdown_diag()
    log.info("starting backend version=%s", __version__)
    log.info("backend log file: %s", log_file)
    print(f"AGENT_TEAM_BACKEND_LOG path={log_file}", flush=True)

    # When --port=0, resolve to an actual free port BEFORE handing to uvicorn so
    # we can write the port file (Claude hooks rely on it being available
    # before the server starts accepting).
    resolved_port = args.port
    if resolved_port == 0:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind((args.host, 0))
            resolved_port = s.getsockname()[1]
        log.info("resolved free port: %d", resolved_port)
    # The CLI risk observer must not flag a CLI's calls back to this backend.
    cli_risk_service.bound_port = resolved_port

    # Write the current port to a discovery file so Claude hooks (installed
    # globally in ~/.claude/settings.json) can find us. Best-effort.
    try:
        port_path = backend_port_file()
        port_path.parent.mkdir(parents=True, exist_ok=True)
        port_path.write_text(str(resolved_port), encoding="utf-8")
        log.info("wrote backend port to %s", port_path)
    except OSError as err:
        log.warning("could not write port-file: %s", err)

    # The credential for that port. Separate file, 0600, minted fresh each run:
    # the port above is written world-readable on purpose (a shell hook resolves
    # it with `cat`), and a secret must not inherit that. Unlike the port this
    # is not best-effort — a backend that cannot write it would accept nobody,
    # and failing here says so instead of leaving that to every client.
    ws_auth.issue_token()

    # The other credential, and it travels the other way: the main process
    # generates it and hands it over on stdin, first line, before anything else
    # runs. Deliberately not a file and not an environment variable — reading a
    # file and reading `ps -E` are the two things a CLI agent on this machine
    # can do without trying, and this key is what tells a person's own window
    # apart from an agent driving the same socket through MCP. See
    # confirm_token for what that does and does not buy.
    #
    # Absent is normal for a backend nobody spawned from the app (the tests, a
    # developer running this by hand); it means the six trust-changing actions
    # refuse rather than that they stop being checked.
    confirm_key, host_token = _read_handover()
    if confirm_token.set_key(confirm_key):
        log.info("adopted the trust-confirmation key from the parent process")
    else:
        log.info(
            "no trust-confirmation key on stdin; actions that change device "
            "trust will be refused on this backend"
        )

    # The host token rides on the same line, for the same reason: the
    # environment it used to travel in is readable with `ps -E`. Absent means
    # host.register refuses and every connection is an ordinary ws client.
    if _app_module.set_host_session_token(host_token):
        log.info("adopted the host token from the parent process")
    else:
        log.info("no host token on stdin; host.register will be refused on this backend")

    # From here on stdin carries only the `shutdown` line, read by the thread
    # below. Before anything spawns: a child that inherits this pipe on Windows
    # hangs at launch behind that thread's read (osplat for the mechanism).
    if osplat.process_tree.isolate_stdin_from_children():
        log.info("children no longer inherit stdin; it is NUL for them")

    # Use the already-imported app object so PyInstaller can detect this
    # dependency statically (string-based import is invisible to the bundler).
    config = uvicorn.Config(
        _fastapi_app,
        host=args.host,
        port=resolved_port,
        log_level=args.log_level,
        access_log=False,
        # Terminal output dominates this socket: many panes, each emitting
        # frames up to 64 KB. Deflating every one of them runs zlib on the
        # event loop, and everything else -- including the heartbeat pong --
        # waits behind that. The traffic is loopback, so the bytes saved buy
        # nothing.
        ws_per_message_deflate=False,
        # Be explicit about the protocol-level heartbeat rather than inheriting
        # 20s/20s. Under heavy PTY output a send can stall for seconds, and a
        # tight server-side timeout closes connections that are busy, not dead.
        ws_ping_interval=20.0,
        ws_ping_timeout=60.0,
        # Every idle Claude pane parks a rewake long-poll here (curl -m 1860).
        # Unbounded, shutdown closes the listener and then waits on all of them,
        # leaving a process with no port that the app never sees exit — so it
        # never respawns it. Bounded, the parked requests are cancelled (the
        # hook reads a dropped connection as "nothing to report") and the
        # lifespan teardown runs.
        timeout_graceful_shutdown=_GRACEFUL_SHUTDOWN_S,
    )
    # After Config, whose dictConfig replaces the uvicorn handlers: uvicorn logs
    # every ws handshake at INFO with its query, and the query is the token.
    log_redaction.install()
    server = uvicorn.Server(config)
    threading.Thread(
        target=_watch_stdin_for_shutdown, args=(server,), name="stdin-shutdown", daemon=True
    ).start()
    parent = osplat.process_tree.parent_to_follow(os.environ)
    if parent is not None:
        threading.Thread(
            target=_watch_parent_for_shutdown, args=(server, parent), name="parent-watch", daemon=True
        ).start()

    log.info("listening on http://%s:%s", args.host, resolved_port)
    print(f"AGENT_TEAM_BACKEND_LISTEN host={args.host} port={resolved_port}", flush=True)

    server.run()
    log.info("shutdown: server stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
