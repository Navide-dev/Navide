"""Read-only memory and todo summaries for agent panes (Hermes, OpenClaw).

What an agent pane's control panel shows under "Memory" and "Todos" (plan
agent-0-2-40_78e071). Only sources that were measured or documented are read;
everything else is reported as unavailable, never guessed:

* **Hermes** keeps its memory as files in ``<HERMES_HOME>/memories`` — the
  installer creates that directory (``stage_config`` in the measured install
  script, plan openclaw-hermes-0-2-40_a50148). ``state.db`` has no memory or
  notes table in the measured schema, so it is not read for this. Todos live
  in ``kanban.db``, whose schema was not measured: unavailable.
* **OpenClaw** keeps long-term memory in ``<workspace>/MEMORY.md`` and daily
  notes in ``<workspace>/memory/*.md`` (docs.openclaw.ai/concepts/memory),
  with the workspace at ``<state dir>/workspace``. Its docs name no todo file:
  unavailable.

Files are opened read-only, symlinks are skipped, and only the head of each
file is read. Nothing here writes to the vendor's home.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from .cli_vendors.hermes import hermes_home

log = logging.getLogger("agent_team_backend.agent_notes")

DEFAULT_LIMIT = 5
MAX_LIMIT = 20
_PREVIEW_CHARS = 160
_HEAD_BYTES = 4096
_MEMORY_SUFFIXES = (".md", ".json")

# (agent_key, section, status) triples already logged, so an unavailable
# source is written to the log once per process rather than on every refresh.
_logged: set[tuple[str, str, str]] = set()


def _log_once(agent_key: str, section: str, status: str, detail: str) -> None:
    key = (agent_key, section, status)
    if key in _logged:
        return
    _logged.add(key)
    log.info("agent notes: %s %s %s (%s)", agent_key, section, status, detail)


def openclaw_workspace() -> Path:
    """``$OPENCLAW_STATE_DIR/workspace``, else ``~/.openclaw/workspace``."""
    override = os.environ.get("OPENCLAW_STATE_DIR")
    base = Path(override) if override else Path.home() / ".openclaw"
    return base / "workspace"


def _preview(path: Path) -> str:
    try:
        with path.open("rb") as fh:
            head = fh.read(_HEAD_BYTES)
    except OSError:
        return ""
    text = head.decode("utf-8", errors="replace")
    lines = [ln.strip().lstrip("#").strip() for ln in text.splitlines()]
    joined = " ".join(ln for ln in lines if ln)
    return joined if len(joined) <= _PREVIEW_CHARS else joined[: _PREVIEW_CHARS - 1] + "…"


def _files(directory: Path, suffixes: tuple[str, ...]) -> list[Path]:
    """Regular files directly in ``directory`` (no symlinks, no recursion)."""
    out: list[Path] = []
    try:
        with os.scandir(directory) as it:
            for entry in it:
                if entry.name.startswith("."):
                    continue
                if not entry.is_file(follow_symlinks=False):
                    continue
                if entry.name.lower().endswith(suffixes):
                    out.append(Path(entry.path))
    except OSError:
        return []
    return out


def _entries(root: Path, files: list[Path], limit: int) -> list[dict[str, Any]]:
    rows: list[tuple[float, Path]] = []
    for f in files:
        try:
            rows.append((f.stat(follow_symlinks=False).st_mtime, f))
        except OSError:
            continue
    rows.sort(key=lambda r: r[0], reverse=True)
    return [
        {
            "name": f.relative_to(root).as_posix(),
            "path": str(f),
            "modified_at": int(mtime * 1000),
            "preview": _preview(f),
        }
        for mtime, f in rows[:limit]
    ]


def _section(agent_key: str, name: str, root: Path | None, files: list[Path], limit: int,
             unsupported: str = "") -> dict[str, Any]:
    if root is None:
        _log_once(agent_key, name, "unsupported", unsupported)
        return {"status": "unsupported", "root": "", "entries": []}
    if not root.is_dir():
        _log_once(agent_key, name, "missing", str(root))
        return {"status": "missing", "root": str(root), "entries": []}
    entries = _entries(root, files, limit)
    return {"status": "ok" if entries else "empty", "root": str(root), "entries": entries}


def read_agent_notes(agent_key: str, limit: int = DEFAULT_LIMIT) -> dict[str, Any]:
    """``{memory: section, todos: section}`` for one agent vendor.

    A section is ``{status, root, entries}``; status is ``ok`` (entries
    found), ``empty`` (the folder exists, nothing in it), ``missing`` (the
    folder does not exist) or ``unsupported`` (no measured source).
    """
    key = (agent_key or "").strip().lower()
    n = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
    if key == "hermes":
        root = hermes_home() / "memories"
        memory = _section(key, "memory", root, _files(root, _MEMORY_SUFFIXES), n)
        todos = _section(key, "todos", None, [], n, "kanban.db schema not measured")
    elif key == "openclaw":
        root = openclaw_workspace()
        files = [p for p in _files(root, (".md",)) if p.name == "MEMORY.md"]
        files += _files(root / "memory", (".md",))
        memory = _section(key, "memory", root, files, n)
        todos = _section(key, "todos", None, [], n, "no todo file in the OpenClaw docs")
    else:
        memory = _section(key, "memory", None, [], n, "not an agent vendor")
        todos = _section(key, "todos", None, [], n, "not an agent vendor")
    return {"agent_key": key, "memory": memory, "todos": todos}
