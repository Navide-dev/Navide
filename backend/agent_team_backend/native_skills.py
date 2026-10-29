"""Read-only reflection of the skills each CLI keeps in its own directory.

Users arrive with skills already installed where their CLIs look for them
(``~/.copilot/skills``, ``~/.claude/skills``, ...). Navide lists those so
they can be seen and delivered to *other* agents, but it never copies,
links, moves or edits them: this module has no write path at all, by
construction. Every call is a fresh scan; nothing is cached on disk.

Three rules the scan keeps:

- **Dedupe by real path.** The same skill is often reachable from several
  roots (``ego-browser`` is a link from ``.claude``, ``.agents`` and ``.grok``
  to one directory). ``resolve()`` is the identity; the first root that
  reaches it is the primary source, the others are recorded as aliases.
- **The shared root is not native.** ``~/.agents/skills`` is a discovery root
  for six CLIs, but Navide also *manages* it (see ``SkillsStore``), so a scan
  excludes it — otherwise a managed skill would surface twice, once editable
  and once read-only.
- **A native skill is never delivered to its own agent.** That agent already
  reads it from where it is; delivering it again would double it up.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

log = logging.getLogger("agent_team_backend.native_skills")

SKILL_FILE = "SKILL.md"
_SKILL_FILE_SIZE_LIMIT = 1_000_000
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_FRONTMATTER_RE = re.compile(
    r"\A---[ \t]*\r?\n(?P<yaml>.*?)^---[ \t]*(?:\r?\n|\Z)(?P<body>.*)\Z",
    re.MULTILINE | re.DOTALL,
)

#: Where each CLI keeps the skills it owns, relative to the user's home. The
#: shared ``.agents/skills`` is deliberately absent (see module docstring).
#: Verified 2026-08-15 against each binary or its official docs.
NATIVE_ROOTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("claude", (".claude", "skills")),
    ("codex", (".codex", "skills")),
    ("copilot", (".copilot", "skills")),
    ("qwen", (".qwen", "skills")),
    ("gemini", (".gemini", "skills")),
    ("kimi", (".kimi-code", "skills")),
    ("cursor", (".cursor", "skills")),
    ("opencode", (".config", "opencode", "skills")),
    ("grok", (".grok", "skills")),
)

#: A native root's owner as an agent key. ``gemini`` is antigravity's home
#: directory sibling: the Gemini CLI reads ``~/.gemini/skills`` and antigravity
#: shares that tree, so a skill there is antigravity's own.
_ROOT_AGENT: dict[str, str] = {"gemini": "antigravity"}


@dataclass(frozen=True)
class NativeSkill:
    """One skill found in a CLI's own directory. Immutable, like the scan."""

    name: str
    description: str
    #: The root it was first found under, e.g. ``"copilot"``.
    source: str
    #: Agent key that already reads this skill without Navide's help.
    owner_agent: str
    #: Directory as it appears under the primary root (may be a link).
    path: str
    #: What ``path`` resolves to; the dedupe identity.
    real_path: str
    #: Other roots the same directory is reachable from.
    aliases: tuple[str, ...] = ()
    #: False when SKILL.md is missing, unreadable, or its frontmatter is not
    #: what the CLIs expect; the skill is still listed so the user sees it.
    valid: bool = True
    error: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "source": self.source,
            "owner_agent": self.owner_agent,
            "path": self.path,
            "real_path": self.real_path,
            "aliases": list(self.aliases),
            "valid": self.valid,
            "error": self.error,
        }


def native_roots(home: Path | None = None) -> list[tuple[str, Path]]:
    """``(source, directory)`` for every native root, existing or not."""
    home = home or _home()
    return [(source, home.joinpath(*relative)) for source, relative in NATIVE_ROOTS]


def scan(
    home: Path | None = None,
    *,
    exclude_real_paths: set[Path] | frozenset[Path] = frozenset(),
) -> list[NativeSkill]:
    """Every native skill on this machine, deduped, in root order then name.

    ``exclude_real_paths`` are directories the caller already accounts for
    (the shared root's skills): a native link pointing into one of them is
    an alias of a managed skill, not a native skill of its own.
    """
    found: dict[Path, NativeSkill] = {}
    for source, root in native_roots(home):
        try:
            if root.is_symlink() and not root.is_dir():
                continue
            if not root.is_dir():
                continue
            entries = sorted(root.iterdir(), key=lambda entry: entry.name)
        except OSError as err:
            log.debug("native root %s unreadable: %s", root, err)
            continue
        for entry in entries:
            if entry.name.startswith(".") or not _NAME_RE.fullmatch(entry.name):
                continue
            try:
                if not entry.is_dir():
                    continue
                real = entry.resolve()
            except OSError:
                continue
            if real in exclude_real_paths:
                continue
            existing = found.get(real)
            if existing is not None:
                if source not in existing.aliases and source != existing.source:
                    found[real] = NativeSkill(
                        **{**existing.__dict__, "aliases": (*existing.aliases, source)}
                    )
                continue
            found[real] = _read(entry, real, source)
    return list(found.values())


def owner_agent(source: str) -> str:
    return _ROOT_AGENT.get(source, source)


def _read(entry: Path, real: Path, source: str) -> NativeSkill:
    base = {
        "name": entry.name,
        "source": source,
        "owner_agent": owner_agent(source),
        "path": str(entry),
        "real_path": str(real),
    }
    skill_file = real / SKILL_FILE
    try:
        if not skill_file.is_file():
            return NativeSkill(**base, description="", valid=False, error=f"{SKILL_FILE} missing")
        if skill_file.stat().st_size > _SKILL_FILE_SIZE_LIMIT:
            return NativeSkill(
                **base, description="", valid=False, error=f"{SKILL_FILE} exceeds 1 MB"
            )
        text = skill_file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as err:
        return NativeSkill(**base, description="", valid=False, error=str(err))
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return NativeSkill(**base, description="", valid=False, error="no YAML frontmatter")
    try:
        fields = yaml.safe_load(match.group("yaml"))
    except yaml.YAMLError as err:
        return NativeSkill(**base, description="", valid=False, error=f"invalid frontmatter: {err}")
    if not isinstance(fields, dict):
        return NativeSkill(**base, description="", valid=False, error="frontmatter must be an object")
    description = fields.get("description")
    return NativeSkill(
        **base,
        description=description if isinstance(description, str) else "",
    )


def _home() -> Path:
    """The user's real home, immune to a shimmed ``$HOME``.

    Launching Navide from inside a pane whose HOME is a per-pane shim would
    otherwise make every native root resolve into that shim. An isolated
    backend (dev web mode sets ``AGENT_TEAM_ISOLATED_HOME=1``) uses its
    scratch ``$HOME`` instead, so it never reads the user's real one.
    """
    if os.environ.get("AGENT_TEAM_ISOLATED_HOME") == "1":
        return Path.home()
    try:
        import pwd

        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except (ImportError, AttributeError, KeyError, OSError):
        return Path.home()
