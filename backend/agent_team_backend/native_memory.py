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

One limit the table does not model: several CLIs let an environment variable
move their config root -- ``XDG_CONFIG_HOME`` (muse, opencode, kilo),
``FACTORY_HOME_OVERRIDE`` (droid), ``KIMI_CODE_HOME``, ``KILO_CONFIG_DIR``,
``CODEX_HOME``. All were unset when the paths were verified, and a set one
makes that CLI's rows point at a file it no longer reads rather than at
nothing, so the failure is quiet. Model them here if that ever bites.
"""

from __future__ import annotations

import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .cli_vendors.registry import VENDORS

log = logging.getLogger("agent_team_backend.native_memory")

#: An instruction file bigger than this is not something the CLIs load either;
#: refusing it keeps a stray binary out of the editor.
FILE_SIZE_LIMIT = 1_000_000

USER_SCOPE = "user"
PROJECT_SCOPE = "project"


class MemoryConflictError(RuntimeError):
    """The file changed on disk since the editor read it."""


@dataclass(frozen=True)
class MemorySource:
    """One instruction file one CLI loads, described well enough to find."""

    #: Agent key, as used everywhere else in the backend.
    agent: str
    #: ``"user"`` (relative to the real home) or ``"project"`` (relative to
    #: the workspace root).
    scope: str
    #: Path to the file, or -- with ``glob`` -- to the directory holding them.
    relative: tuple[str, ...]
    #: True when this is the file Navide offers to create for the agent. A
    #: canonical row is listed even when the file does not exist yet; the
    #: others are listed only once the user has one.
    canonical: bool = False
    #: Non-empty when ``relative`` is a directory of instruction files rather
    #: than a single file, e.g. cursor's ``.cursor/rules``.
    glob: str = ""


#: Where each CLI looks for its instructions. Verified 2026-08-28 against the
#: installed binary or its bundled docs -- never against documentation alone.
#: A file read by several CLIs gets one row per reader; ``scan`` merges them.
MEMORY_SOURCES: tuple[MemorySource, ...] = (
    # -- claude: ~/.claude/CLAUDE.md plus the project file and its untracked
    # sibling; nested CLAUDE.md files load per directory (not enumerated).
    MemorySource("claude", USER_SCOPE, (".claude", "CLAUDE.md"), canonical=True),
    MemorySource("claude", PROJECT_SCOPE, ("CLAUDE.md",), canonical=True),
    MemorySource("claude", PROJECT_SCOPE, ("CLAUDE.local.md",)),
    MemorySource("claude", PROJECT_SCOPE, (".claude", "CLAUDE.md")),
    # -- codex: AGENTS.md, with AGENTS.override.md replacing it per directory.
    MemorySource("codex", USER_SCOPE, (".codex", "AGENTS.md"), canonical=True),
    MemorySource("codex", PROJECT_SCOPE, ("AGENTS.md",), canonical=True),
    MemorySource("codex", PROJECT_SCOPE, ("AGENTS.override.md",)),
    # -- antigravity: readGlobalRules stats both ~/.gemini and ~/.gemini/config
    # for each of the two filenames; the project tier walks cwd up to the git
    # root. The .agents/rules aliases (.agent, _agents, _agent) are not listed.
    MemorySource("antigravity", USER_SCOPE, (".gemini", "GEMINI.md"), canonical=True),
    MemorySource("antigravity", USER_SCOPE, (".gemini", "AGENTS.md")),
    MemorySource("antigravity", USER_SCOPE, (".gemini", "config", "GEMINI.md")),
    MemorySource("antigravity", USER_SCOPE, (".gemini", "config", "AGENTS.md")),
    MemorySource("antigravity", PROJECT_SCOPE, ("GEMINI.md",), canonical=True),
    MemorySource("antigravity", PROJECT_SCOPE, ("AGENTS.md",)),
    MemorySource("antigravity", PROJECT_SCOPE, (".agents", "rules"), glob="*.md"),
    # -- copilot: `copilot init` writes the .github file; AGENTS.md is loaded
    # too ("--no-custom-instructions ... from AGENTS.md and related files").
    MemorySource(
        "copilot", PROJECT_SCOPE, (".github", "copilot-instructions.md"), canonical=True
    ),
    MemorySource("copilot", PROJECT_SCOPE, ("AGENTS.md",)),
    # -- cursor: rules live in .cursor/rules/**/*.mdc; it also reads the
    # other agents' project files verbatim.
    MemorySource("cursor", PROJECT_SCOPE, (".cursor", "rules"), glob="**/*.mdc"),
    MemorySource("cursor", PROJECT_SCOPE, ("AGENTS.md",)),
    MemorySource("cursor", PROJECT_SCOPE, ("CLAUDE.md",)),
    MemorySource("cursor", PROJECT_SCOPE, ("CLAUDE.local.md",)),
    MemorySource("cursor", PROJECT_SCOPE, (".cursorrules",)),
    # cursor has no user-scope loader: loadRulesFromDirAndAncestors walks up to
    # the filesystem root, so the home tree is reached only while the workspace
    # lives under it -- true for a normal project, false on an external volume.
    MemorySource("cursor", USER_SCOPE, (".cursor", "rules"), glob="**/*.mdc"),
    MemorySource("cursor", USER_SCOPE, ("AGENTS.md",)),
    MemorySource("cursor", USER_SCOPE, ("CLAUDE.md",)),
    MemorySource("cursor", USER_SCOPE, ("CLAUDE.local.md",)),
    # -- droid: three personal dot dirs (the bare home is explicitly skipped),
    # and the same dirs per project level. The Claude.md/Agents.md/agents.md
    # spellings are the same files on a case-insensitive volume, so one row.
    MemorySource("droid", USER_SCOPE, (".factory", "AGENTS.md"), canonical=True),
    MemorySource("droid", USER_SCOPE, (".factory", "CLAUDE.md")),
    MemorySource("droid", USER_SCOPE, (".agents", "AGENTS.md")),
    MemorySource("droid", USER_SCOPE, (".agent", "AGENTS.md")),
    MemorySource("droid", PROJECT_SCOPE, ("AGENTS.md",), canonical=True),
    MemorySource("droid", PROJECT_SCOPE, ("CLAUDE.md",)),
    MemorySource("droid", PROJECT_SCOPE, (".factory", "AGENTS.md")),
    MemorySource("droid", PROJECT_SCOPE, (".agents", "AGENTS.md")),
    # -- grok: ~/.grok/AGENTS.md, then AGENTS.override.md/AGENTS.md per level.
    MemorySource("grok", USER_SCOPE, (".grok", "AGENTS.md"), canonical=True),
    MemorySource("grok", PROJECT_SCOPE, ("AGENTS.md",), canonical=True),
    MemorySource("grok", PROJECT_SCOPE, ("AGENTS.override.md",)),
    # -- kilo: its own config dir, and ~/.claude/CLAUDE.md unless disabled.
    MemorySource("kilo", USER_SCOPE, (".config", "kilo", "AGENTS.md"), canonical=True),
    MemorySource("kilo", USER_SCOPE, (".claude", "CLAUDE.md")),
    MemorySource("kilo", PROJECT_SCOPE, ("AGENTS.md",), canonical=True),
    MemorySource("kilo", PROJECT_SCOPE, ("CLAUDE.md",)),
    MemorySource("kilo", PROJECT_SCOPE, ("CONTEXT.md",)),
    # -- kimi: $KIMI_CODE_HOME/AGENTS.md, else ~/.kimi-code/AGENTS.md.
    MemorySource("kimi", USER_SCOPE, (".kimi-code", "AGENTS.md"), canonical=True),
    MemorySource("kimi", PROJECT_SCOPE, ("AGENTS.md",), canonical=True),
    # -- mcode: `mcode init .` writes AGENTS.md from a directory analysis,
    # which is the only instruction file the CLI documents. No user-scope row:
    # the data dir (~/.minimax, $MINIMAX_DATA_DIR) holds config.yaml, auth and
    # the session SQLite, and nothing observed there is an instruction file —
    # `agents/` is agent DEFINITIONS (agent.md per built-in agent), not memory.
    MemorySource("mcode", PROJECT_SCOPE, ("AGENTS.md",), canonical=True),
    # -- muse: $XDG_CONFIG_HOME/muse (default ~/.config/muse), then every level
    # from the VCS root down. CLAUDE.md is read only where AGENTS.md is absent.
    MemorySource("muse", USER_SCOPE, (".config", "muse", "AGENTS.md"), canonical=True),
    MemorySource("muse", USER_SCOPE, (".config", "muse", "CLAUDE.md")),
    MemorySource("muse", PROJECT_SCOPE, ("AGENTS.md",), canonical=True),
    MemorySource("muse", PROJECT_SCOPE, ("CLAUDE.md",)),
    # -- opencode: same loader family as kilo.
    MemorySource(
        "opencode", USER_SCOPE, (".config", "opencode", "AGENTS.md"), canonical=True
    ),
    MemorySource("opencode", USER_SCOPE, (".claude", "CLAUDE.md")),
    MemorySource("opencode", PROJECT_SCOPE, ("AGENTS.md",), canonical=True),
    MemorySource("opencode", PROJECT_SCOPE, ("CLAUDE.md",)),
    MemorySource("opencode", PROJECT_SCOPE, ("CONTEXT.md",)),
    # -- pi: ~/.pi/agent/ and every ancestor directory, override first.
    MemorySource("pi", USER_SCOPE, (".pi", "agent", "AGENTS.md"), canonical=True),
    MemorySource("pi", USER_SCOPE, (".pi", "agent", "CLAUDE.md")),
    MemorySource("pi", PROJECT_SCOPE, ("AGENTS.md",), canonical=True),
    MemorySource("pi", PROJECT_SCOPE, ("AGENTS.override.md",)),
    MemorySource("pi", PROJECT_SCOPE, ("CLAUDE.md",)),
    # -- qwen: hierarchical QWEN.md, plus the private project-local file.
    MemorySource("qwen", USER_SCOPE, (".qwen", "QWEN.md"), canonical=True),
    MemorySource("qwen", PROJECT_SCOPE, ("QWEN.md",), canonical=True),
    MemorySource("qwen", PROJECT_SCOPE, (".qwen", "QWEN.local.md")),
    MemorySource("qwen", PROJECT_SCOPE, ("AGENTS.md",)),
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
    for path, (scope, relative, readers, canonical) in candidates(home, workspace).items():
        files.append(
            _describe(path, scope, relative, tuple(sorted(readers)), canonical)
        )
    files.sort(key=lambda f: (not f.exists, f.scope != USER_SCOPE, f.relative))
    return files


def read(path: str, home: Path | None = None, workspace: Path | None = None) -> dict[str, Any]:
    """The text of one listed file. Raises ``ValueError`` for anything else."""
    target, _scope, _root = _allowed(path, home, workspace)
    if not target.is_file():
        return {"path": str(target), "text": "", "exists": False}
    size = target.stat().st_size
    if size > FILE_SIZE_LIMIT:
        raise ValueError(f"file is too large to edit ({size} bytes)")
    return {
        "path": str(target),
        "text": target.read_text(encoding="utf-8", errors="replace"),
        "exists": True,
        "modified": target.stat().st_mtime,
    }


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
    handle, temp = tempfile.mkstemp(dir=str(written.parent), prefix=".navide-", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
        os.replace(temp, written)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise
    log.info("memory file saved: %s (%d bytes)", target, len(text))
    stat = target.stat()
    return {"path": str(target), "size": stat.st_size, "modified": stat.st_mtime}


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
    for candidate, (scope, _relative_path, _readers, _canonical) in candidates(
        home, workspace
    ).items():
        if candidate == target:
            root = workspace if scope == PROJECT_SCOPE and workspace else home
            return candidate, scope, root
    raise ValueError("not a known instruction file")


def _describe(
    path: Path, scope: str, relative: str, readers: tuple[str, ...], canonical: bool
) -> MemoryFile:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return MemoryFile(scope, str(path), relative, readers, canonical, exists=False)
    except OSError as exc:
        return MemoryFile(
            scope, str(path), relative, readers, canonical, exists=True, error=str(exc)
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
    )


def _relative(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def _home() -> Path:
    return Path.home()
