"""The instruction files each CLI loads on its own -- listed, read and saved.

Every coding CLI reads a markdown file before it starts working: claude reads
``CLAUDE.md``, codex and most others read ``AGENTS.md``, qwen reads
``QWEN.md``, cursor reads ``.cursor/rules/*.mdc``. They are the highest-leverage
configuration a user owns, and until now Navide could not show them at all --
a user had to remember where fourteen CLIs each keep theirs.

Unlike ``native_skills`` and ``native_mcp``, this module **writes**: the page it
feeds is an editor, not a mirror. Two rules keep that safe:

- **Only files the table names.** ``read`` and ``save`` resolve their argument
  against the same candidate set ``scan`` produces and refuse anything else, so
  the WS surface cannot be turned into arbitrary filesystem access. The
  workspace half of that set is treated as untrusted input, because it arrives
  with a clone: a project row whose real path leaves the workspace is dropped
  rather than listed, and the ``read:`` entries of a workspace
  ``.aider.conf.yml`` may only name files inside that same workspace.
- **A save is atomic, and never blind.** Text goes to a sibling temp file and
  is renamed over the target, so a crash mid-write cannot truncate a user's
  instructions; and a save carrying the mtime it read refuses to overwrite a
  file something else has touched since, because these files are edited by
  the CLIs themselves as often as by hand.

These files live outside Navide's own folder, so a save must stay reversible:
before it replaces a file, the text it is about to overwrite is kept in
Navide's data dir (``memory-backups``, one previous version per file), and
``restore_previous`` writes that text back -- through ``save``, so a restore
can itself be undone the same way. A save that *creates* a file has nothing to
keep, so it records instead that Navide created it and the exact text it
wrote; the main process uses that record to move the file to the Trash when
the user undoes the creation. A later save that changes the file drops the
record, and the previous-version restore takes over.

The unit listed is the *file*, not the CLI, because one file is usually read by
several CLIs: ``~/.claude/CLAUDE.md`` is claude's own and is also loaded by
kilo and opencode. A row therefore carries every reader, and the same path is
never listed twice.

Every CLI in the registry is covered, and every path was verified on
2026-08-28 against the installed binary -- the code that builds the path, not
a filename string, and for muse and cursor a live run in an isolated tree --
rather than against documentation, which was wrong about cursor (it claims
user rules never touch disk) and silent about droid's ``FACTORY_HOME_OVERRIDE``.
Two consequences worth knowing while reading the table: cursor has no
user-scope loader at all -- its ancestor walk simply reaches ``$HOME`` while
the workspace lives under it -- and aider has no filename of its own, so its
rows come from whatever ``read:`` in the user's ``.aider.conf.yml`` names.

Claude Code's auto-memory is listed too, as project rows: the notes Claude
writes about a project by itself while it works -- ``MEMORY.md``, the index it
loads at the start of every session, plus one ``.md`` per topic -- kept in
``~/.claude/projects/<slug>/memory/``. Verified 2026-10-26 against Claude Code
2.1.310: ``<slug>`` is the project root with every non-alphanumeric UTF-16
unit replaced by ``-`` (past 200 characters, cut and suffixed with a hash), and
the project root is the main working tree of the git repository, so every
worktree and subdirectory of one repo shares a folder. Navide's per-account
config dirs (``CLAUDE_CONFIG_DIR``) always link their ``projects`` back to the
real ``~/.claude`` (``credential_vault.CLAUDE_SHARED_ENTRIES``), and the backend
drops an inherited ``CLAUDE_CONFIG_DIR`` at startup, so the real home is the
one location for every account. Not modelled: the ``autoMemoryDirectory``
setting, which moves the folder elsewhere -- the page then shows the default
folder's files, which Claude no longer updates.

One limit the table does not model: several CLIs let an environment variable
move their config root -- ``XDG_CONFIG_HOME`` (muse, opencode, kilo),
``FACTORY_HOME_OVERRIDE`` (droid), ``KIMI_CODE_HOME``, ``KILO_CONFIG_DIR``,
``CODEX_HOME``. All were unset when the paths were verified, and a set one
makes that CLI's rows point at a file it no longer reads rather than at
nothing, so the failure is quiet. Model them here if that ever bites.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .applog import app_data_dir
from .cli_vendors.base import PROJECT_SCOPE, USER_SCOPE, MemorySource  # noqa: F401 — re-exported
from .cli_vendors.registry import VENDORS

log = logging.getLogger("agent_team_backend.native_memory")

#: An instruction file bigger than this is not something the CLIs load either;
#: refusing it keeps a stray binary out of the editor.
FILE_SIZE_LIMIT = 1_000_000

#: Under the app data dir: the previous version of each file a save replaced.
BACKUP_DIR_NAME = "memory-backups"

#: The reader of auto-memory rows: Claude writes and loads them itself.
AUTO_MEMORY_AGENT = "claude"
#: Claude Code cuts a longer project folder name and appends a hash.
_CLAUDE_SLUG_LIMIT = 200


class MemoryConflictError(RuntimeError):
    """The file changed on disk since the editor read it."""


#: Where each CLI looks for its instructions: every vendor's own
#: ``VendorSpec.memory_sources``, in registry order (verified against the
#: installed binary or its bundled docs, never against documentation alone;
#: see each ``cli_vendors/<key>.py``). A file read by several CLIs has one row
#: per reader; ``scan`` merges them. The order is not observable except in one
#: case: ``candidates`` keeps the scope and relative path of the first row to
#: reach a path, so when the workspace is itself a CLI's user directory (``~/.codex``)
#: its ``AGENTS.md`` is listed under the first project row's label (registry
#: order: Project ``AGENTS.md``), where main listed it under User
#: ``.codex/AGENTS.md``. Readers are sorted and ``canonical`` is merged by OR,
#: and the set of allowed paths does not depend on the order. Pinned by
#: ``test_native_memory.py``.
MEMORY_SOURCES: tuple[MemorySource, ...] = tuple(
    source for spec in VENDORS.values() for source in spec.memory_sources
)

#: aider is the one CLI with no filename of its own: ``main.py`` loads whatever
#: ``read:`` in ``.aider.conf.yml`` names, so its rows are discovered per
#: machine rather than declared here. ``CONVENTIONS.md`` is only the name the
#: official docs suggest -- the code does not know it.
_CONFIGURED: frozenset[str] = frozenset({"aider"})

#: aider's config file, searched in the home and in the project (the git root
#: and cwd both resolve to the workspace for a Navide pane).
AIDER_CONFIG = ".aider.conf.yml"
#: A config naming more files than this is not describing instructions any
#: more; the rest are left out rather than flooding the page.
AIDER_READ_LIMIT = 20


@dataclass(frozen=True)
class MemoryFile:
    """One instruction file on disk, and every CLI that loads it."""

    scope: str
    #: Absolute path.
    path: str
    #: Path as shown to the user: relative to the home or the workspace root.
    relative: str
    #: Agent keys that read this file, sorted.
    readers: tuple[str, ...]
    #: True when at least one reader treats it as its own canonical file.
    canonical: bool
    exists: bool
    size: int = 0
    #: Epoch seconds, 0 when the file does not exist.
    modified: float = 0.0
    #: Non-empty when the file exists but could not be stat'ed or read.
    error: str = ""
    #: True for a Claude Code auto-memory file: written by Claude itself, and
    #: ``relative`` is then relative to the memory folder, not the workspace.
    auto_memory: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "path": self.path,
            "relative": self.relative,
            "readers": list(self.readers),
            "canonical": self.canonical,
            "exists": self.exists,
            "size": self.size,
            "modified": self.modified,
            "error": self.error,
            "auto_memory": self.auto_memory,
        }


def agent_targets() -> list[dict[str, Any]]:
    """Every CLI vendor and how Navide finds its instruction files.

    Two states: ``mapped`` (the table names the paths) and ``configured``
    (the CLI has the mechanism but no filename of its own, so the files are
    whatever the user's config names -- aider, and only aider). Every vendor
    in the registry is one or the other; a third "unknown" state existed while
    four CLIs were still unverified and is deliberately gone.
    """
    mapped = {source.agent for source in MEMORY_SOURCES}
    targets: list[dict[str, Any]] = []
    for key, spec in sorted(VENDORS.items()):
        state = "configured" if key in _CONFIGURED else "mapped" if key in mapped else "unknown"
        scopes = sorted({s.scope for s in MEMORY_SOURCES if s.agent == key})
        if key in _CONFIGURED:
            scopes = [USER_SCOPE, PROJECT_SCOPE]
        targets.append({"agent": key, "label": spec.label, "state": state, "scopes": scopes})
    return targets


def _aider_reads(home: Path, workspace: Path | None) -> list[tuple[Path, str]]:
    """The files aider loads because a ``.aider.conf.yml`` names them.

    aider resolves a relative ``read:`` entry against its cwd, which for a
    Navide pane is the workspace. Only files that exist are returned: a
    directory entry makes aider read the whole tree, which is not something
    this page should offer to edit one file at a time.
    """
    found: list[tuple[Path, str]] = []
    for conf_root in (home, workspace):
        if conf_root is None:
            continue
        conf = conf_root / AIDER_CONFIG
        if not conf.is_file():
            continue
        try:
            document = yaml.safe_load(conf.read_text(encoding="utf-8", errors="replace"))
        except (OSError, yaml.YAMLError) as exc:
            log.info("aider config unreadable: %s (%s)", conf, exc)
            continue
        if not isinstance(document, dict):
            continue
        # A .aider.conf.yml inside the workspace is project content: it arrives
        # with a clone, so it may only name files inside that workspace. The
        # home one is the user's own and may also reach the project, but both
        # are kept out of hidden directories -- naming ~/.ssh/id_rsa in a
        # config must not turn this page into a reader of it.
        roots = (workspace,) if conf_root is workspace else (home, workspace)
        raw = document.get("read")
        entries = raw if isinstance(raw, list) else [raw]
        for entry in entries[:AIDER_READ_LIMIT]:
            if not isinstance(entry, str) or not entry.strip():
                continue
            path = Path(entry).expanduser()
            if not path.is_absolute():
                # aider resolves a relative entry against its cwd, which for a
                # Navide pane is the workspace.
                path = (workspace or home) / path
            try:
                resolved = path.resolve()
            except OSError:
                continue
            if not resolved.is_file():
                continue
            base = next((r for r in roots if r is not None and _within(resolved, r)), None)
            if base is None:
                continue
            if any(part.startswith(".") for part in resolved.relative_to(base.resolve()).parts):
                continue
            scope = (
                PROJECT_SCOPE if workspace is not None and _within(resolved, workspace) else USER_SCOPE
            )
            found.append((resolved, scope))
    return found


def auto_memory_dir(home: Path | None = None, workspace: Path | None = None) -> Path | None:
    """Claude Code's auto-memory folder for the workspace, or None without one.

    The folder need not exist: Claude creates it the first time it saves a
    note for the project.
    """
    if workspace is None:
        return None
    root = _git_project_root(workspace)
    return (home or _home()) / ".claude" / "projects" / _claude_project_slug(str(root)) / "memory"


def _git_project_root(workspace: Path) -> Path:
    """The main working tree of the repository holding ``workspace``.

    Claude keys auto-memory by the repository, so a linked worktree resolves
    to the main checkout through its ``commondir``. Outside a repository (or
    in a bare or unreadable one) the workspace itself is the project.
    """
    try:
        start = workspace.resolve()
    except OSError:
        return workspace
    for folder in (start, *start.parents):
        marker = folder / ".git"
        if marker.is_dir():
            return folder
        if not marker.is_file():
            continue
        try:
            line = marker.read_text(encoding="utf-8").strip()
        except OSError:
            return folder
        if not line.startswith("gitdir:"):
            return folder
        gitdir = Path(line[len("gitdir:"):].strip())
        if not gitdir.is_absolute():
            gitdir = folder / gitdir
        try:
            common = (gitdir / "commondir").read_text(encoding="utf-8").strip()
        except OSError:
            # A submodule: its own gitdir, no shared one, so it is its own project.
            return folder
        common_dir = Path(common) if Path(common).is_absolute() else gitdir / common
        try:
            common_dir = common_dir.resolve()
        except OSError:
            return folder
        return common_dir.parent if common_dir.name == ".git" else folder
    return start


def _claude_project_slug(root: str) -> str:
    """Claude Code's folder name for a project root under ``~/.claude/projects``.

    Claude works on JavaScript strings, so the replacement and the hash run
    over UTF-16 code units: a character outside the BMP becomes two dashes.
    """
    data = root.encode("utf-16-le")
    units = [int.from_bytes(data[i:i + 2], "little") for i in range(0, len(data), 2)]
    slug = "".join(
        chr(unit) if unit < 128 and chr(unit).isalnum() else "-" for unit in units
    )
    if len(slug) <= _CLAUDE_SLUG_LIMIT:
        return slug
    value = 0
    for unit in units:
        value = (value * 31 + unit) & 0xFFFFFFFF
    if value >= 0x80000000:
        value -= 0x100000000
    return f"{slug[:_CLAUDE_SLUG_LIMIT]}-{_base36(abs(value))}"


def _base36(value: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        value, rest = divmod(value, 36)
        out = digits[rest] + out
        if value == 0:
            return out


def _within(path: Path, root: Path) -> bool:
    """True when ``path`` is ``root`` or sits under it, both fully resolved."""
    try:
        root = root.resolve()
        path = path.resolve()
    except OSError:
        return False
    return root == path or root in path.parents


def candidates(
    home: Path | None = None, workspace: Path | None = None
) -> dict[Path, tuple[str, str, set[str], bool]]:
    """Every path the table reaches, as ``{path: (scope, relative, readers, canonical)}``.

    This is the allow-list: ``read`` and ``save`` accept a path only if it is a
    key here. Glob sources contribute the files that currently exist under
    them; the fixed rows contribute their path whether or not it exists.
    """
    home = home or _home()
    found: dict[Path, tuple[str, str, set[str], bool]] = {}

    def add(path: Path, scope: str, relative: str, agent: str, canonical: bool) -> None:
        entry = found.get(path)
        if entry is None:
            found[path] = (scope, relative, {agent}, canonical)
            return
        entry[2].add(agent)
        if canonical and not entry[3]:
            found[path] = (entry[0], entry[1], entry[2], True)

    for source in MEMORY_SOURCES:
        if source.scope == USER_SCOPE:
            root = home
        elif workspace is not None:
            root = workspace
        else:
            continue
        base = root.joinpath(*source.relative)
        if source.glob:
            if not base.is_dir():
                continue
            for path in sorted(base.glob(source.glob)):
                if path.is_file() and _contained(path, source.scope, root):
                    add(path, source.scope, _relative(path, root), source.agent, False)
            continue
        if not _contained(base, source.scope, root):
            continue
        add(base, source.scope, _relative(base, root), source.agent, source.canonical)
    for path, scope in _aider_reads(home, workspace):
        root = workspace if scope == PROJECT_SCOPE and workspace else home
        add(path, scope, _relative(path, root), "aider", False)
    # Claude's auto-memory: only the files it has written, never offered for
    # creation, and only those that really sit in the folder.
    memory_dir = auto_memory_dir(home, workspace)
    if memory_dir is not None and memory_dir.is_dir():
        for path in sorted(memory_dir.glob("*.md")):
            if path.is_file() and _within(path, memory_dir):
                add(path, PROJECT_SCOPE, path.name, AUTO_MEMORY_AGENT, False)
    # Readers are merged first, then the rows are filtered: a canonical file
    # that does not exist yet is still read by every CLI naming it, so
    # dropping the non-canonical rows earlier would make ~/.claude/CLAUDE.md
    # claim one reader before it is created and three the moment it is saved.
    return {
        path: entry for path, entry in found.items() if entry[3] or path.is_file()
    }


def scan(home: Path | None = None, workspace: Path | None = None) -> list[MemoryFile]:
    """Every instruction file the table reaches, existing files first."""
    files: list[MemoryFile] = []
    memory_dir = auto_memory_dir(home, workspace)
    for path, (scope, relative, readers, canonical) in candidates(home, workspace).items():
        files.append(
            _describe(
                path,
                scope,
                relative,
                tuple(sorted(readers)),
                canonical,
                auto_memory=memory_dir is not None and path.parent == memory_dir,
            )
        )
    files.sort(key=lambda f: (not f.exists, f.scope != USER_SCOPE, f.relative))
    return files


def read(path: str, home: Path | None = None, workspace: Path | None = None) -> dict[str, Any]:
    """The text of one listed file. Raises ``ValueError`` for anything else."""
    target, _scope, _root = _allowed(path, home, workspace)
    kept = _previous_meta(target)
    if not target.is_file():
        result: dict[str, Any] = {"path": str(target), "text": "", "exists": False}
    else:
        size = target.stat().st_size
        if size > FILE_SIZE_LIMIT:
            raise ValueError(f"file is too large to edit ({size} bytes)")
        result = {
            "path": str(target),
            "text": target.read_text(encoding="utf-8", errors="replace"),
            "exists": True,
            "modified": target.stat().st_mtime,
        }
    # Only present when there is one, so a reply for a file Navide never
    # saved keeps the shape older clients know.
    if kept is not None:
        result["previous"] = kept
    created = _created_meta(target) if result["exists"] else None
    if created is not None:
        result["created"] = created
    return result


def save(
    path: str,
    text: str,
    home: Path | None = None,
    workspace: Path | None = None,
    expected_modified: float | None = None,
) -> dict[str, Any]:
    """Write one listed file, creating it and its parent if needed.

    ``expected_modified`` is the mtime ``read`` reported (0.0 for a file that
    did not exist yet). When given, a file that has moved on since raises
    ``MemoryConflictError`` rather than losing the other writer's edit.
    """
    target, scope, root = _allowed(path, home, workspace)
    if len(text.encode("utf-8")) > FILE_SIZE_LIMIT:
        raise ValueError("the text is too large to save")
    if expected_modified is not None and _mtime(target) != expected_modified:
        raise MemoryConflictError("the file changed on disk since it was opened")
    target.parent.mkdir(parents=True, exist_ok=True)
    # mkdir may have just followed a link, and the listing that produced this
    # path was a separate call: re-check the directory actually being written.
    if not _contained(target, scope, root):
        raise ValueError("not a known instruction file")
    # A linked file is written where the link points: os.replace would
    # otherwise swap the link itself for a plain file, cutting the user's
    # dotfiles repo out. _contained has already kept a project link inside
    # its workspace. A dangling link is refused: following it would create a
    # file, and directories, wherever it happens to point.
    written = target
    if target.is_symlink():
        try:
            written = target.resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise ValueError("the instruction file is a link to nothing") from exc
        if not written.is_file():
            raise ValueError("the instruction file links to something that is not a file")
    # Keep what is about to be overwritten before touching the file; if that
    # cannot be kept, the save is refused rather than made irreversible. A
    # file that does not exist yet has nothing to keep: the record that Navide
    # created it is what makes that save reversible instead.
    creating = not written.exists()
    if creating:
        _record_created(target, text)
    else:
        _keep_previous(target, written, text)
    handle, temp = tempfile.mkstemp(dir=str(written.parent), prefix=".navide-", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
        os.replace(temp, written)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        if creating:
            _created_path(target).unlink(missing_ok=True)
        raise
    if not creating:
        _drop_created_if_changed(target, text)
    log.info("memory file saved: %s (%d bytes)", target, len(text))
    stat = target.stat()
    result: dict[str, Any] = {"path": str(target), "size": stat.st_size, "modified": stat.st_mtime}
    kept = _previous_meta(target)
    if kept is not None:
        result["previous"] = kept
    created = _created_meta(target)
    if created is not None:
        result["created"] = created
    return result


def restore_previous(
    path: str,
    home: Path | None = None,
    workspace: Path | None = None,
    expected_modified: float | None = None,
) -> dict[str, Any]:
    """Write back the version the last save replaced.

    It goes through ``save``, so the same table, size and conflict checks
    apply, and the text being replaced becomes the new previous version: a
    restore is undone by restoring again.
    """
    target, _scope, _root = _allowed(path, home, workspace)
    stored = _backup_paths(target)[0]
    try:
        text = stored.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError as exc:
        raise ValueError("there is no previous version to restore") from exc
    return save(str(target), text, home, workspace, expected_modified)


def _backup_paths(target: Path) -> tuple[Path, Path]:
    """Where the previous text of ``target`` and its description are kept."""
    key = hashlib.sha256(str(target).encode("utf-8")).hexdigest()[:32]
    folder = app_data_dir() / BACKUP_DIR_NAME
    return folder / f"{key}.txt", folder / f"{key}.json"


def _created_path(target: Path) -> Path:
    """Where the record that Navide created ``target`` is kept.

    The main process reads it by the same key (``memoryUndoCreate.ts``), so
    the name and the fields below are a contract with it.
    """
    return _backup_paths(target)[0].with_suffix(".created.json")


def _record_created(target: Path, text: str) -> None:
    """Note that a save is about to create ``target`` with exactly ``text``."""
    data = text.encode("utf-8")
    record = {
        "path": str(target),
        "created_at": time.time(),
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "text": text,
    }
    _write_atomic(_created_path(target), json.dumps(record).encode("utf-8"))


def _drop_created_if_changed(target: Path, text: str) -> None:
    """Forget the create record once a save wrote something else.

    From then on the kept previous version is the undo; a save of the very
    text Navide created the file with changes nothing, so the record stays.
    """
    record = _created_record(target)
    if record is not None and record.get("text") != text:
        _created_path(target).unlink(missing_ok=True)


def _created_record(target: Path) -> dict[str, Any] | None:
    try:
        record = json.loads(_created_path(target).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict) or record.get("path") != str(target):
        return None
    return record


def _created_meta(target: Path) -> dict[str, Any] | None:
    """``{created_at, size}`` when Navide created ``target``, or None."""
    record = _created_record(target)
    if record is None:
        return None
    try:
        return {"created_at": float(record.get("created_at") or 0), "size": int(record.get("size") or 0)}
    except (TypeError, ValueError):
        return None


def _write_atomic(destination: Path, data: bytes) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=str(destination.parent), prefix=".navide-", suffix=".tmp")
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
        os.replace(temp, destination)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def _keep_previous(target: Path, written: Path, text: str) -> None:
    """Copy the file's current text aside before ``save`` replaces it.

    Nothing is kept for a file that does not exist yet, and a save that
    would not change the text keeps the older previous version instead of
    replacing it with an identical copy.
    """
    try:
        current = written.read_bytes()
    except FileNotFoundError:
        return
    if current == text.encode("utf-8"):
        return
    stored, meta = _backup_paths(target)
    stored.parent.mkdir(parents=True, exist_ok=True)
    description = {"path": str(target), "saved_at": time.time(), "size": len(current)}
    for destination, data in (
        (stored, current),
        (meta, json.dumps(description).encode("utf-8")),
    ):
        handle, temp = tempfile.mkstemp(
            dir=str(destination.parent), prefix=".navide-", suffix=".tmp"
        )
        try:
            with os.fdopen(handle, "wb") as stream:
                stream.write(data)
            os.replace(temp, destination)
        except BaseException:
            Path(temp).unlink(missing_ok=True)
            raise


def _previous_meta(target: Path) -> dict[str, Any] | None:
    """``{saved_at, size}`` of the kept previous version, or None."""
    stored, meta = _backup_paths(target)
    if not stored.is_file():
        return None
    try:
        description = json.loads(meta.read_text(encoding="utf-8"))
        saved_at = float(description.get("saved_at") or 0)
    except (OSError, ValueError, AttributeError, TypeError):
        saved_at = 0.0
    try:
        size = stored.stat().st_size
    except OSError:
        return None
    return {"saved_at": saved_at, "size": size}


def _contained(path: Path, scope: str, root: Path) -> bool:
    """Whether a row may be listed: for the workspace, that it stays inside it.

    A project file is repository content and can be a symlink someone else
    wrote -- ``AGENTS.md -> ~/.ssh/id_rsa`` in a cloned repo would otherwise be
    editable through this page. The parent is checked too, and first: ``save``
    creates its temp file in that directory and renames from there, so a
    symlinked ``.github`` escapes even though the file inside it does not exist
    yet. Home rows are left alone: pointing a dotfile at a managed directory is
    how many users keep their instructions in git.
    """
    if scope != PROJECT_SCOPE:
        return True
    if not _within(path.parent, root):
        return False
    # ``save`` writes through a link only to an existing file and refuses a
    # dangling one, but a dangling link in a repository is not something to
    # offer either.
    if path.is_symlink() or path.exists():
        return _within(path, root)
    return True


def _mtime(path: Path) -> float:
    """The file's mtime, or 0.0 when it does not exist -- what ``read`` reports."""
    try:
        return path.stat().st_mtime
    except FileNotFoundError:
        return 0.0


def _allowed(
    path: str, home: Path | None, workspace: Path | None
) -> tuple[Path, str, Path]:
    """``path`` with its scope and root, or ``ValueError`` if unlisted."""
    target = Path(path).expanduser()
    home = home or _home()
    memory_dir = auto_memory_dir(home, workspace)
    for candidate, (scope, _relative_path, _readers, _canonical) in candidates(
        home, workspace
    ).items():
        if candidate == target:
            root = workspace if scope == PROJECT_SCOPE and workspace else home
            # An auto-memory file lives outside the workspace: its folder is
            # the root the save re-checks containment against.
            if memory_dir is not None and candidate.parent == memory_dir:
                root = memory_dir
            return candidate, scope, root
    raise ValueError("not a known instruction file")


def _describe(
    path: Path,
    scope: str,
    relative: str,
    readers: tuple[str, ...],
    canonical: bool,
    auto_memory: bool = False,
) -> MemoryFile:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return MemoryFile(
            scope, str(path), relative, readers, canonical, exists=False, auto_memory=auto_memory
        )
    except OSError as exc:
        return MemoryFile(
            scope,
            str(path),
            relative,
            readers,
            canonical,
            exists=True,
            error=str(exc),
            auto_memory=auto_memory,
        )
    return MemoryFile(
        scope,
        str(path),
        relative,
        readers,
        canonical,
        exists=True,
        size=stat.st_size,
        modified=stat.st_mtime,
        auto_memory=auto_memory,
    )


def _relative(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def _home() -> Path:
    return Path.home()
