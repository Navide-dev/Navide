"""Pre-trust the skills view Navide hands Claude Code with ``--add-dir``.

Claude Code 2.1.32x started asking about every ``--add-dir`` directory it has
no trust record for ("Adding a new directory: ... This session hasn't worked
here before"), and the answer holds for one session only. Navide adds its own
managed-skills view (``<app data>/runtime/skills-views/claude``) to every
Claude pane, so every new pane stopped on that prompt before its first turn.

The CLI's own remedy, printed by the CLI for an untrusted added folder, is a
trust record: ``projects[<dir>].hasTrustDialogAccepted: true`` in its global
config (``$CLAUDE_CONFIG_DIR/.claude.json``, else ``~/.claude.json``) — the
same record its own trust dialog persists and its self-hosted runner seeds.
The record is written only for that one directory, which Navide creates and
rebuilds itself out of the skills the user enabled; it is never written for a
workspace, a parent folder or anything else the user opened.

The file is rewritten wholesale by every running claude, so the write is done
under Claude Code's own config lock (``<config>.lock``, a directory as
proper-lockfile makes it) and only when the record is missing: read, add the
one key, replace atomically, release. A lock that stays held is waited out
briefly and never broken; the pane then starts as before and shows the prompt.
"""

from __future__ import annotations

import json
import logging
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from . import osplat
from .osplat import secret_files

log = logging.getLogger("agent_team_backend.claude_skills_trust")

CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR"
CONFIG_NAME = ".claude.json"
TRUST_KEY = "hasTrustDialogAccepted"
#: How long a held lock is waited for before the write is skipped.
LOCK_WAIT_S = 2.0
_LOCK_POLL_S = 0.05


class LockBusy(RuntimeError):
    """Claude Code holds its config lock for longer than ``LOCK_WAIT_S``."""


def config_file(env: dict[str, str] | None, home: Path) -> Path:
    """The global config file the pane's claude reads: its
    ``CLAUDE_CONFIG_DIR`` (the spawn env first, then the backend's own),
    else ``~/.claude.json``."""
    configured = (env or {}).get(CONFIG_DIR_ENV) or os.environ.get(CONFIG_DIR_ENV) or ""
    if configured:
        return Path(configured).expanduser() / CONFIG_NAME
    return home / CONFIG_NAME


def project_key(directory: Path) -> str:
    """The key Claude Code files a directory's trust under: its real path,
    with forward slashes (the CLI normalises Windows paths that way)."""
    real = os.path.realpath(os.fspath(directory))
    return real.replace("\\", "/") if osplat.platform_id == "win32" else real


def _read(path: Path) -> dict[str, Any] | None:
    """The parsed config; ``{}`` when it does not exist; None when it is not
    a JSON object (never overwritten then)."""
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    try:
        parsed = json.loads(raw) if raw.strip() else {}
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def is_trusted(path: Path, directory: Path) -> bool:
    """Whether ``path`` carries the trust record for ``directory``. Raises
    ValueError for a config that is not a JSON object, so the gate reads it
    as unknown rather than as the user's removal."""
    config = _read(path)
    if config is None:
        raise ValueError(f"{path} is not a JSON object")
    entry = (config.get("projects") or {}).get(project_key(directory))
    return isinstance(entry, dict) and entry.get(TRUST_KEY) is True


@contextmanager
def _config_lock(path: Path) -> Iterator[None]:
    """Claude Code's own config lock: ``<config>.lock`` created by mkdir."""
    lock = Path(os.fspath(path) + ".lock")
    deadline = time.monotonic() + LOCK_WAIT_S
    while True:
        try:
            os.mkdir(lock)
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise LockBusy(f"{lock} is held") from None
            time.sleep(_LOCK_POLL_S)
    try:
        yield
    finally:
        try:
            os.rmdir(lock)
        except OSError as err:
            log.warning("could not release %s: %s", lock, err)


def _update(path: Path, change: Any) -> bool:
    """Apply ``change(config) -> bool`` under the lock and write the result
    when it reports a change. Returns whether the file was written."""
    target = path.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    with _config_lock(path):
        config = _read(target)
        if config is None:
            raise ValueError(f"{target} is not a JSON object; left unchanged")
        if not change(config):
            return False
        secret_files.write_private_plain(
            target, (json.dumps(config, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        )
        return True


def ensure_trusted(path: Path, directory: Path) -> bool:
    """Add the trust record for ``directory`` to ``path`` when it is missing.
    Every other key, and every other field of an existing entry, is kept."""
    key = project_key(directory)

    def change(config: dict[str, Any]) -> bool:
        projects = config.get("projects")
        if not isinstance(projects, dict):
            if projects is not None:
                raise ValueError("projects is not an object; left unchanged")
            projects = config["projects"] = {}
        entry = projects.get(key)
        if isinstance(entry, dict) and entry.get(TRUST_KEY) is True:
            return False
        projects[key] = {**(entry if isinstance(entry, dict) else {}), TRUST_KEY: True}
        return True

    return _update(path, change)


def take_back(path: Path, directory: Path) -> bool:
    """Remove the record ``ensure_trusted`` added: the whole entry when the
    record is all it holds, otherwise only the flag."""
    key = project_key(directory)

    def change(config: dict[str, Any]) -> bool:
        projects = config.get("projects")
        entry = projects.get(key) if isinstance(projects, dict) else None
        if not isinstance(entry, dict) or TRUST_KEY not in entry:
            return False
        if set(entry) == {TRUST_KEY}:
            del projects[key]
        else:
            entry[TRUST_KEY] = False
        return True

    return _update(path, change)
