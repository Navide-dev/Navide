"""Backend logging: rotating file handler under the platform app-data dir."""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from contextvars import ContextVar
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import TypeVar

from . import osplat

_T = TypeVar("_T")

# Set only while a job bound by in_data_dir runs; see there.
_BOUND_DATA_DIR: ContextVar[Path | None] = ContextVar("agent_team_bound_data_dir", default=None)


def default_app_data_dir() -> Path:
    """Where a shipped install keeps its state, ignoring any override.

    Split out from ``app_data_dir`` so something can ask "is this process
    running on the default state, or beside it?" — which is the question that
    decides whether a stored secret may share a name with the shipped app's.
    """
    return osplat.paths.state_dir("Agent-Team")


def app_data_dir() -> Path:
    """The app data dir: ``AGENT_TEAM_DATA_DIR`` or the platform default.

    An explicit ``AGENT_TEAM_DATA_DIR`` override wins over the platform default.
    The dev launcher sets it so a `npm run dev` instance keeps its backend state
    (sessions, settings, backend-port) separate from a packaged app running at
    the same time — otherwise two backends fight over one state dir.
    """
    bound = _BOUND_DATA_DIR.get()
    if bound is not None:
        return bound
    override = os.environ.get("AGENT_TEAM_DATA_DIR")
    if override:
        return Path(os.path.expanduser(override))
    return default_app_data_dir()


def in_data_dir(data_dir: Path, fn: Callable[..., _T], /, *args: object) -> Callable[[], _T]:
    """``fn(*args)`` as a zero-argument job that sees ``app_data_dir()`` as
    ``data_dir`` while it runs.

    For work handed to a thread pool: it runs later, and resolving the data
    dir then would pick whatever the process points at by that time instead
    of the dir the work belongs to — in tests, the next test's dir, whose
    navide.db the late job would open a second connection on and write into.
    """

    def run() -> _T:
        token = _BOUND_DATA_DIR.set(data_dir)
        try:
            return fn(*args)
        finally:
            _BOUND_DATA_DIR.reset(token)

    return run


def log_dir() -> Path:
    d = app_data_dir() / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def backend_log_path() -> Path:
    return log_dir() / "backend.log"


def backend_port_file() -> Path:
    """Path to the small text file holding the currently-running backend port.

    Used by Claude Code hooks installed in ~/.claude/settings.json so each
    hook fire can resolve the current port without us baking it into config.
    """
    return app_data_dir() / "backend-port"


def backend_ws_token_file() -> Path:
    """Path to the one-shot credential the local ``/ws`` endpoint requires.

    Deliberately a *separate* file from ``backend-port``. The port is written
    world-readable on purpose — Claude Code hooks resolve it with a plain
    ``cat`` from a shell this process does not control — while this one must
    not be. Two facts with two different audiences do not belong in one file.
    """
    return app_data_dir() / "backend-ws-token"


def setup_file_logging(level: str = "info") -> Path:
    """Attach a rotating file handler to the agent_team_backend logger tree.

    Returns the active log file path so callers (e.g. the entrypoint) can print
    it to stdout — the renderer reads stdout to surface the path in the UI.
    """
    path = backend_log_path()
    handler = RotatingFileHandler(
        path, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    handler.setLevel(level.upper())
    handler.setFormatter(
        logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s")
    )
    # The MCP SDK logs the exception behind every "-32603 Error handling POST
    # request" under its own ``mcp`` tree (issue #490); its warnings and errors
    # go to the same file, its per-request info lines do not.
    handler.addFilter(
        lambda record: not (record.name == "mcp" or record.name.startswith("mcp."))
        or record.levelno >= logging.WARNING
    )
    for name in ("agent_team_backend", "mcp"):
        logger = logging.getLogger(name)
        # Avoid duplicate handlers if called twice.
        if not any(isinstance(h, RotatingFileHandler) and Path(h.baseFilename) == path for h in logger.handlers):
            logger.addHandler(handler)
    return path
