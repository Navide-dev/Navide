"""The managed Skills library: ``~/.agents/skills`` plus its delivery state.

The library is the shared root six CLIs already read on their own (codex,
copilot, grok, opencode, muse, cursor), not a private Navide directory: a
skill created here reaches those six without any delivery at all, and the
other five (claude, kimi, pi, qwen, antigravity) get it through the per-pane
views ``skills_wiring`` builds.

Because the root is the user's own directory, Navide only ever writes and
deletes entries it created itself — every one carries a ``.navide`` marker
file. Anything else found there is the user's, listed read-only.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import shutil
import stat
import tempfile
import unicodedata
from datetime import datetime, timezone
import threading
from functools import wraps
from pathlib import Path
from typing import Any

import yaml
from send2trash import send2trash

from . import native_skills, osplat
from .osplat.spec import windows_refused_file_name
from .applog import app_data_dir

log = logging.getLogger("agent_team_backend.skills_store")

#: The shared discovery root, relative to the user's home. Six CLIs read it.
SHARED_ROOT = (".agents", "skills")
#: Marker Navide leaves in every skill directory it creates; the only thing
#: that makes a directory ours to edit or delete.
MARKER_FILE = ".navide"
SKILLS_STATE_FILE = "skills.json"
SKILLS_RUNTIME_DIR = "runtime/skills"
SKILL_FILE = "SKILL.md"
SKILL_FILE_SIZE_LIMIT = 1_000_000
_STATE_FILE_SIZE_LIMIT = 1_000_000
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
_DIRECTORY_FDS = hasattr(os, "O_DIRECTORY") and all(
    operation in os.supports_dir_fd
    for operation in (os.open, os.mkdir, os.link, os.stat, os.unlink, os.rmdir)
)
_FRONTMATTER_RE = re.compile(
    r"\A---[ \t]*\r?\n(?P<yaml>.*?)^---[ \t]*(?:\r?\n|\Z)(?P<body>.*)\Z",
    re.MULTILINE | re.DOTALL,
)


def agent_targets() -> list[dict[str, Any]]:
    """Every CLI vendor and what the managed library can actually do with it.

    Three states, because "off" and "impossible" must not look alike in the
    UI: ``wired`` (a spawn carries the library to it), ``planned`` (the CLI
    has skills but Navide does not wire them yet), ``unsupported`` (no skills
    mechanism exists to wire).
    """
    from .cli_vendors.registry import VENDORS

    agents: list[dict[str, Any]] = []
    for key in sorted(VENDORS):
        spec = VENDORS[key]
        if spec.skills_wiring is not None:
            state = "wired"
        elif spec.skills_supported:
            state = "planned"
        else:
            state = "unsupported"
        agents.append(
            {
                "key": key,
                "label": spec.label,
                "state": state,
                # Shared skills reach this CLI with no delivery at all — and
                # cannot be withheld from it without touching the user's
                # directory. The UI paints those cells "automatic".
                "reads_shared_root": bool(
                    spec.skills_wiring is not None and spec.skills_wiring.reads_shared_root
                ),
            }
        )
    return agents


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError):
        return False


def _real_home() -> Path:
    """The user's real home, immune to a shimmed ``$HOME`` (see native_skills)."""
    try:
        import pwd

        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except (ImportError, AttributeError, KeyError, OSError):
        return Path.home()


class SkillsStoreError(Exception):
    """Base error for managed Skills operations."""


class SkillNotFoundError(SkillsStoreError):
    """Raised when a managed skill does not exist."""


class SkillConflictError(SkillsStoreError):
    """Raised when a caller attempts to overwrite a stale revision."""


class SkillValidationError(SkillsStoreError):
    """Raised for invalid names, paths, files, or frontmatter."""


class SkillConsentRequired(SkillsStoreError):
    """The first write into the shared root needs the user's explicit consent.

    Carries the directory so the prompt can name exactly what will be
    written to; nothing has been written when this is raised.
    """

    def __init__(self, root: str) -> None:
        self.root = root
        super().__init__(f"writing to {root} needs the user's consent")


def _serialized(operation):
    """Keep UI, MCP and sync updates on one store from losing each other's state."""
    @wraps(operation)
    def run(self, *args, **kwargs):
        with self._lock:
            return operation(self, *args, **kwargs)
    return run


class SkillsStore:
    def __init__(
        self,
        root: Path | None = None,
        state_path: Path | None = None,
        runtime_root: Path | None = None,
        native_roots: list[Path] | tuple[Path, ...] | None = None,
    ) -> None:
        self._lock = threading.RLock()
        data_root = app_data_dir()
        requested_root = root or _real_home().joinpath(*SHARED_ROOT)
        self._root = requested_root.parent.resolve() / requested_root.name
        self._state_path = state_path or (data_root / SKILLS_STATE_FILE)
        self._runtime_root = runtime_root or (data_root / SKILLS_RUNTIME_DIR)
        # Roots whose same-named skill wins over ours (native > shared): the
        # CLI that owns that root reads it directly and must not see it
        # displaced. Everything native_skills scans counts.
        if native_roots is not None:
            self._native_roots = tuple(native_roots)
        else:
            try:
                self._native_roots = tuple(
                    path for _source, path in native_skills.native_roots()
                )
            except (OSError, RuntimeError):
                self._native_roots = ()

    @property
    def root(self) -> Path:
        return self._root

    @property
    def state_path(self) -> Path:
        return self._state_path

    @property
    def runtime_root(self) -> Path:
        return self._runtime_root

    def list_skills(self) -> dict[str, Any]:
        self._ensure_safe_root()
        state = self._read_state()
        targets = self._read_targets()
        skills: list[dict[str, Any]] = []
        if self._root.exists():
            if self._root.is_symlink() or not self._root.is_dir():
                raise SkillValidationError("skills root must be a directory, not a symlink")
            for entry in sorted(self._root.iterdir(), key=lambda path: path.name):
                if not entry.is_dir() and not entry.is_symlink():
                    continue
                try:
                    name = self._validate_name(entry.name)
                    skill = self._read_skill(name, state, targets)
                    skills.append(self._summary(skill))
                except SkillsStoreError as exc:
                    if _NAME_RE.fullmatch(entry.name):
                        skills.append(
                            {
                                "name": entry.name,
                                "description": "",
                                "enabled": bool(state.get(entry.name, True)),
                                "native_conflict": self._native_conflict(entry.name),
                                "targets": targets.get(entry.name),
                                "managed": self._is_managed(entry),
                                "valid": False,
                                "error": str(exc),
                                "path": str(entry),
                            }
                        )
        return {
            "skills": skills,
            "native": [skill.as_dict() for skill in self.native_skills()],
            "native_targets": self._read_native_targets(),
            "root": str(self._root),
            "write_consented": self.write_consented(),
            "agents": agent_targets(),
        }

    def native_skills(self) -> list[native_skills.NativeSkill]:
        """Skills the CLIs keep in their own directories — read-only reflection.

        A native entry that resolves into the shared root is the same skill
        seen twice (a link the user made, or one a future migration left
        behind); it is excluded here so it appears once, as the shared entry.
        """
        shared: set[Path] = set()
        if self._root.is_dir():
            for entry in self._root.iterdir():
                try:
                    shared.add(entry.resolve())
                except OSError:
                    continue
        return native_skills.scan(exclude_real_paths=shared)

    def get_skill(self, name: str) -> dict[str, Any]:
        self._ensure_safe_root()
        return {"skill": self._read_skill(name, self._read_state(), self._read_targets())}

    @_serialized
    def create_skill(
        self, name: str, description: str = "", *, consent: bool = False
    ) -> dict[str, Any]:
        """Create a skill in the shared root — the user's directory.

        The first write there needs the user's explicit say-so; ``consent``
        is that say-so, recorded on success so it is asked once. Until then
        the call fails with ``SkillConsentRequired`` and writes nothing.
        """
        self._ensure_safe_root()
        name = self._validate_name(name)
        if not isinstance(description, str):
            raise SkillValidationError("description must be a string")
        if not self.write_consented() and not consent:
            raise SkillConsentRequired(str(self._root))
        skill_dir = self._skill_dir(name)
        if skill_dir.exists() or skill_dir.is_symlink():
            raise SkillValidationError(f"skill already exists: {name}")

        self._root.mkdir(parents=True, exist_ok=True)
        skill_dir.mkdir()
        try:
            # The marker goes down first: a directory that only ever gets as
            # far as this line is still recognisably ours to clean up.
            (skill_dir / MARKER_FILE).write_text("", encoding="utf-8")
            self._write_skill_file(skill_dir / SKILL_FILE, {"name": name, "description": description}, "")
            state = self._read_state()
            state[name] = True
            self._write_state(
                state, self._read_targets(), self._read_native_targets(), consented=True
            )
        except Exception:
            shutil.rmtree(skill_dir, ignore_errors=True)
            raise
        self._refresh_runtime_projection()
        return self.get_skill(name)

    @_serialized
    def save_skill(
        self,
        name: str,
        fields: dict[str, Any],
        body: str,
        expected_revision: str,
    ) -> dict[str, Any]:
        self._ensure_safe_root()
        if not isinstance(fields, dict):
            raise SkillValidationError("fields must be an object")
        if not isinstance(body, str):
            raise SkillValidationError("body must be a string")
        if not isinstance(expected_revision, str) or not expected_revision:
            raise SkillValidationError("expected_revision is required")

        current = self._read_skill(name, self._read_state())
        if not current["managed"]:
            raise SkillValidationError(
                "this skill was not created by Navide; edit it where it lives"
            )
        if current["revision"] != expected_revision:
            raise SkillConflictError("skill changed on disk; reload before saving")

        merged_fields = dict(current["fields"])
        merged_fields.update(fields)
        merged_fields["name"] = current["name"]
        self._validate_fields(merged_fields)
        self._write_skill_file(self._skill_file(name), merged_fields, body)
        self._refresh_runtime_projection()
        return self.get_skill(name)

    @_serialized
    def set_enabled(self, name: str, enabled: bool) -> dict[str, Any]:
        self._ensure_safe_root()
        name = self._validate_name(name)
        if not isinstance(enabled, bool):
            raise SkillValidationError("enabled must be a boolean")
        self._require_safe_skill_dir(name)
        state = self._read_state()
        state[name] = enabled
        self._write_state(state, self._read_targets(), self._read_native_targets())
        self._refresh_runtime_projection()
        return self.get_skill(name)

    @_serialized
    def set_targets(self, name: str, agents: list[str] | None) -> dict[str, Any]:
        """Restrict ``name`` to ``agents``, or to every wired agent when None.

        Stored beside the enabled flags rather than in SKILL.md: which of the
        user's CLIs a skill goes to is this machine's routing, not part of the
        portable skill, and writing it into the file would make an exported
        skill carry another machine's agent list.
        """
        self._ensure_safe_root()
        name = self._validate_name(name)
        self._require_safe_skill_dir(name)
        targets = self._read_targets()
        if agents is None:
            targets.pop(name, None)
        else:
            targets[name] = self._validate_agents(agents)
        self._write_state(self._read_state(), targets, self._read_native_targets())
        return self.get_skill(name)

    def targets_for(self, agent_key: str) -> list[str]:
        """Enabled skill names this agent receives, in directory order."""
        self._ensure_safe_root()
        state = self._read_state()
        targets = self._read_targets()
        names: list[str] = []
        if not self._root.is_dir():
            return names
        for entry in sorted(self._root.iterdir(), key=lambda path: path.name):
            name = entry.name
            if not _NAME_RE.fullmatch(name) or not state.get(name, True):
                continue
            allowed = targets.get(name)
            if allowed is not None and agent_key not in allowed:
                continue
            names.append(name)
        return names

    # ── Native skills: delivery targets keyed by real path ─────────────────
    #
    # A native skill's name is not unique (cursor-plan-mode-workflow exists as
    # three separate copies), so its targets are keyed by the resolved
    # directory. Nothing here reads or writes the native directories
    # themselves; only ``skills.json`` changes.

    @_serialized
    def set_native_targets(self, real_path: str, agents: list[str] | None) -> None:
        """Deliver the native skill at ``real_path`` to ``agents``; None = to none.

        The default for a native skill is the opposite of a shared one:
        *nobody* receives it until the user opts in, because it already
        works for the CLI that owns it and delivering it elsewhere is a
        deliberate choice, not the baseline.
        """
        if not isinstance(real_path, str) or not os.path.isabs(real_path):
            raise SkillValidationError("real_path must be an absolute path")
        native = self._read_native_targets()
        if not agents:
            native.pop(real_path, None)
        else:
            native[real_path] = self._validate_agents(agents)
        self._write_state(self._read_state(), self._read_targets(), native)

    @_serialized
    def get_delivery_revision(self, *, name: str = "", real_path: str = "") -> str:
        """A compare-and-set token for routing, distinct from SKILL.md's revision."""
        if bool(name) == bool(real_path):
            raise SkillValidationError("name or real_path is required, exclusively")
        if name:
            skill = self.get_skill(name)["skill"]
            value = [name, skill["revision"], skill["enabled"], skill["targets"]]
        else:
            native = next((s for s in self.native_skills() if s.real_path == real_path), None)
            if native is None:
                raise SkillNotFoundError("native skill is no longer present")
            if not native.valid:
                raise SkillValidationError("native skill is invalid")
            value = [real_path, self._read_native_targets().get(real_path, [])]
        return hashlib.sha256(json.dumps(value, sort_keys=True).encode("utf-8")).hexdigest()

    def _check_delivery(
        self,
        *,
        name: str,
        real_path: str,
        targets: list[str] | None,
        expected_revision: str,
        enabled: bool | None,
    ) -> list[str] | None:
        """Validate a routing decision without writing; returns the clean targets."""
        before = self.get_delivery_revision(name=name, real_path=real_path)
        if not isinstance(expected_revision, str) or not expected_revision:
            raise SkillValidationError("expected_revision is required")
        if expected_revision != before:
            raise SkillConflictError("skill delivery changed; inspect it again before retrying")
        if enabled is not None and not isinstance(enabled, bool):
            raise SkillValidationError("enabled must be a boolean")
        if real_path and enabled is not None:
            raise SkillValidationError("a native skill's enabled state belongs to its CLI")
        clean = None if targets is None else self._validate_agents(targets)
        capabilities = {row["key"]: row for row in agent_targets()}
        for target in clean or []:
            if target not in capabilities or capabilities[target]["state"] != "wired":
                raise SkillValidationError(f"skill delivery is unsupported for agent: {target}")
        return clean

    @_serialized
    def delivery_widens(
        self,
        *,
        name: str = "",
        real_path: str = "",
        targets: list[str] | None,
        expected_revision: str,
        enabled: bool | None = None,
    ) -> bool:
        """Whether a valid routing decision reaches a CLI the skill does not reach now.

        Raises like ``set_delivery`` for a stale revision or invalid targets, and
        writes nothing. Turning a disabled shared skill on also widens it.
        """
        clean = self._check_delivery(
            name=name, real_path=real_path, targets=targets,
            expected_revision=expected_revision, enabled=enabled,
        )
        if real_path:
            return not set(clean or []) <= set(self._read_native_targets().get(real_path, []))
        if enabled is True and not self._read_state().get(name, True):
            return True
        wired = {row["key"] for row in agent_targets() if row["state"] == "wired"}
        current = self._read_targets().get(name)
        before = wired if current is None else set(current)
        return not (wired if clean is None else set(clean)) <= before

    @_serialized
    def set_delivery(
        self,
        *,
        name: str = "",
        real_path: str = "",
        targets: list[str] | None,
        expected_revision: str,
        enabled: bool | None = None,
    ) -> dict[str, Any]:
        """Apply one routing decision atomically, preserving other skills' decisions."""
        clean = self._check_delivery(
            name=name, real_path=real_path, targets=targets,
            expected_revision=expected_revision, enabled=enabled,
        )
        state = self._read_state()
        shared = self._read_targets()
        native = self._read_native_targets()
        if name:
            if enabled is not None:
                state[name] = enabled
            if clean is None:
                shared.pop(name, None)
            else:
                shared[name] = clean
            changed = (
                (enabled is not None and enabled != self._read_state().get(name, True))
                or clean != self._read_targets().get(name)
            )
        else:
            changed = (clean or []) != native.get(real_path, [])
            if clean:
                native[real_path] = clean
            else:
                native.pop(real_path, None)
        if changed:
            self._write_state(state, shared, native)
            if name and enabled is not None:
                self._refresh_runtime_projection()
        return {
            "name": name or Path(real_path).name,
            "targets": clean if name else (clean or []),
            "enabled": state.get(name, True) if name else None,
            "revision": self.get_delivery_revision(name=name, real_path=real_path),
            "changed": changed,
        }

    def write_consented(self) -> bool:
        """Whether the user has once allowed Navide to write into the shared root."""
        return bool(self._read_state_document().get("write_consented"))

    def native_targets(self) -> dict[str, list[str]]:
        return self._read_native_targets()

    def native_targets_for(self, agent_key: str) -> list[str]:
        """Real paths of native skills the user chose to deliver to ``agent_key``."""
        return [
            real for real, agents in self._read_native_targets().items()
            if agent_key in agents
        ]

    # ── Migration: move a CLI's own skill into the shared root, reversibly ──
    #
    # The one operation that changes a user's directory. Every step is
    # ordered so an interruption leaves the skill readable from at least one
    # place, and every failure unwinds back to exactly the original layout.

    @_serialized
    def migrate_native(self, real_path: str, *, consent: bool = False) -> dict[str, Any]:
        """Move the native skill at ``real_path`` into the shared root and
        leave a symlink in its place, so the owning CLI keeps reading it.

        Requires ``consent`` on every call — this is per-item, never remembered.
        Refuses when: the shared root already has that name, the source is
        not a real directory (a link is someone else's arrangement), or the
        source is inside the shared root already.
        """
        if not consent:
            raise SkillConsentRequired(str(self._root))
        source = self._native_source(real_path)
        name = self._validate_name(source.name)
        self._ensure_safe_root()
        target = self._skill_dir(name)
        if target.exists() or target.is_symlink():
            raise SkillValidationError(f"the shared root already has a skill named {name}")

        self._root.mkdir(parents=True, exist_ok=True)
        # 1. Copy first (never move): until step 3 the original is untouched,
        #    so a crash anywhere before it costs nothing.
        shutil.copytree(source, target, symlinks=True)
        try:
            (target / MARKER_FILE).write_text(
                f"migrated-from: {source}\n", encoding="utf-8"
            )
            # Verify the copy reads back as a valid skill before touching the
            # original: a broken copy must not replace a working skill.
            self._read_skill(name, {}, {})
            # 2. Swap: original → aside, link → original's place. Two renames
            #    on the same filesystem; the aside copy is what makes step 3
            #    reversible.
            aside = source.with_name(f".{source.name}.navide-migrating")
            if aside.exists() or aside.is_symlink():
                self._remove_tree(aside)
            os.rename(source, aside)
            try:
                os.symlink(target, source, target_is_directory=True)
            except OSError:
                os.rename(aside, source)
                raise
            # 3. Only now is the original gone; the link already serves it.
            self._remove_tree(aside)
        except Exception:
            self._remove_tree(target)
            raise
        state = self._read_state()
        state.setdefault(name, True)
        native = self._read_native_targets()
        native.pop(str(source.resolve()), None)
        native.pop(real_path, None)
        self._write_state(state, self._read_targets(), native, consented=True)
        self._refresh_runtime_projection()
        return {"skill": self._read_skill(name, state, self._read_targets()), "from": str(source)}

    @_serialized
    def restore_native(self, name: str) -> dict[str, Any]:
        """Undo ``migrate_native``: move the skill back where it came from and
        remove the link. Refuses unless the skill's marker records an origin
        and that origin is still the link we left."""
        self._ensure_safe_root()
        name = self._validate_name(name)
        skill_dir = self._require_safe_skill_dir(name)
        origin = self._migration_origin(skill_dir)
        if origin is None:
            raise SkillValidationError("this skill was not migrated by Navide")
        if not origin.is_symlink() or origin.resolve() != skill_dir.resolve():
            raise SkillValidationError(
                "the original location no longer holds Navide's link; not restoring over it"
            )
        # Reverse order of migrate: copy back beside the link, verify, swap.
        aside = origin.with_name(f".{origin.name}.navide-restoring")
        if aside.exists() or aside.is_symlink():
            self._remove_tree(aside)
        shutil.copytree(skill_dir, aside, symlinks=True)
        try:
            (aside / MARKER_FILE).unlink(missing_ok=True)
            os.unlink(origin)
            try:
                os.rename(aside, origin)
            except OSError:
                os.symlink(skill_dir, origin, target_is_directory=True)
                raise
        except Exception:
            self._remove_tree(aside)
            raise
        # The shared copy goes only after the original is back in place.
        self._remove_tree(skill_dir)
        state = self._read_state()
        state.pop(name, None)
        targets = self._read_targets()
        targets.pop(name, None)
        self._write_state(state, targets, self._read_native_targets())
        self._refresh_runtime_projection()
        return {"name": name, "restored_to": str(origin)}

    def _native_source(self, real_path: str) -> Path:
        if not isinstance(real_path, str) or not os.path.isabs(real_path):
            raise SkillValidationError("real_path must be an absolute path")
        source = Path(real_path)
        if source.is_symlink() or not source.is_dir():
            raise SkillValidationError("only a real directory can be migrated")
        try:
            source.resolve().relative_to(self._root.resolve())
        except ValueError:
            pass
        else:
            raise SkillValidationError("that skill is already in the shared root")
        allowed = any(
            _is_within(source, root) for _s, root in native_skills.native_roots()
        )
        if not allowed and self._native_roots:
            allowed = any(_is_within(source, root) for root in self._native_roots)
        if not allowed:
            raise SkillValidationError("only a skill inside a CLI's own skills directory can be migrated")
        return source

    @staticmethod
    def _migration_origin(skill_dir: Path) -> Path | None:
        try:
            text = (skill_dir / MARKER_FILE).read_text(encoding="utf-8")
        except OSError:
            return None
        for line in text.splitlines():
            if line.startswith("migrated-from: "):
                origin = line[len("migrated-from: "):].strip()
                return Path(origin) if os.path.isabs(origin) else None
        return None

    @staticmethod
    def _remove_tree(path: Path) -> None:
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
        elif path.exists():
            shutil.rmtree(path)

    @_serialized
    def delete_skill(self, name: str) -> dict[str, Any]:
        self._ensure_safe_root()
        name = self._validate_name(name)
        skill_dir = self._require_safe_skill_dir(name)
        if not self._is_managed(skill_dir):
            # The one rule that keeps the shared root the user's: a directory
            # without our marker was put there by them, and stays.
            raise SkillValidationError(
                "this skill was not created by Navide; remove it where it lives"
            )
        state = self._read_state()
        try:
            send2trash(str(skill_dir))
        except Exception as exc:  # noqa: BLE001
            log.warning("send2trash failed for skill %s (%s); keeping original", name, exc)
            raise SkillsStoreError(f"could not move skill to trash: {name}") from exc

        state.pop(name, None)
        targets = self._read_targets()
        targets.pop(name, None)
        self._write_state(state, targets, self._read_native_targets())
        self._refresh_runtime_projection()
        return {"name": name, "deleted": True}

    # ── Content, for cross-device sync ─────────────────────────────────────
    #
    # Only skills carrying the marker take part. A shared-root entry the user
    # put there themselves is listed and routed like any other, but its files
    # are theirs: uploading them would make this feature a backup service for
    # a directory it does not own, and writing them back on another machine
    # would be the same mistake in the other direction.

    #: A packed skill is one sync record, so the record limit is the real cap.
    CONTENT_TOTAL_LIMIT = 512 * 1024
    CONTENT_FILE_LIMIT = 256 * 1024
    MAX_CONTENT_FILES = 64

    #: What an installed skill may hold. Larger than the sync limits on
    #: purpose: a skill too big to sync still installs, and only its
    #: enabled/targets decision travels between devices.
    INSTALL_TOTAL_LIMIT = 32 * 1024 * 1024
    INSTALL_FILE_LIMIT = 8 * 1024 * 1024
    MAX_INSTALL_FILES = 512

    def export_content(self, name: str) -> dict[str, dict[str, str]] | None:
        """Every file of a managed skill, or None when it is not ours to send.

        Text is carried as text so a diff of two versions stays readable;
        anything that is not valid UTF-8 rides as base64.
        """
        name = self._validate_name(name)
        skill_dir = self._skill_dir(name)
        if not skill_dir.is_dir() or not self._is_managed(skill_dir):
            return None
        files: dict[str, dict[str, str]] = {}
        total = 0
        for path in sorted(skill_dir.rglob("*")):
            if path.is_symlink() or not path.is_file():
                continue
            relative = path.relative_to(skill_dir).as_posix()
            if relative == MARKER_FILE:
                continue  # recreated on the far side; never carried
            if _is_generated(relative):
                continue
            if _safe_relative(relative) is None:
                # import_content refuses the whole skill over one such path
                # (a dotfile, say); list_files leaves it out the same way.
                log.info("skill %s: %s is not carried to other devices", name, relative)
                continue
            size = path.stat().st_size
            if size > self.CONTENT_FILE_LIMIT:
                # Sending the rest would land a skill with a file missing.
                log.warning("skill %s: %s is too large to sync; not sending its files", name, relative)
                return None
            total += size
            if total > self.CONTENT_TOTAL_LIMIT or len(files) >= self.MAX_CONTENT_FILES:
                log.warning("skill %s is too large to sync whole; not sending its files", name)
                return None
            raw = path.read_bytes()
            try:
                files[relative] = {"t": "text", "v": raw.decode("utf-8")}
            except UnicodeDecodeError:
                files[relative] = {"t": "b64", "v": base64.b64encode(raw).decode("ascii")}
            if _carries_exec_bit(path, raw):
                # Only when set, so a skill without scripts keeps the record
                # it always had; a build that predates the flag ignores it.
                files[relative]["x"] = True
        return files if SKILL_FILE in files else None

    def install_bundle(
        self, name: str, files: dict[str, Any], *, targets: list[str] | None,
        consent: bool = False, provenance: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Install reviewed bytes without replacing any existing skill.

        Unlike device sync, installation is add-only and records consent and
        delivery state together. A failed write restores the previous state.
        """
        with self._lock:
            self._ensure_safe_root()
            name = self._validate_name(name)
            targets = None if targets is None else self._validate_agents(targets)
            supported = {agent["key"] for agent in agent_targets() if agent["state"] == "wired"}
            if targets is not None and any(agent not in supported for agent in targets):
                raise SkillValidationError("skill target is not wired for delivery")
            if not self.write_consented() and consent is not True:
                raise SkillConsentRequired(str(self._root))
            destination = self._skill_dir(name)
            if destination.exists() or destination.is_symlink() or self._native_conflict(name):
                raise SkillConflictError(f"skill already exists: {name}")
            if not isinstance(files, dict) or "SKILL.md" not in files or len(files) > self.MAX_INSTALL_FILES:
                raise SkillValidationError("invalid skill bundle")
            _validate_bundle_paths(files)
            total = 0
            for relative, entry in files.items():
                if _safe_relative(relative) is None or ":" in relative or not isinstance(entry, dict):
                    raise SkillValidationError("invalid skill bundle path")
                data = entry.get("data")
                if not isinstance(data, bytes) or len(data) > self.INSTALL_FILE_LIMIT:
                    raise SkillValidationError("invalid skill bundle file")
                if not isinstance(entry.get("executable"), bool):
                    raise SkillValidationError("invalid executable flag")
                total += len(data)
            if total > self.INSTALL_TOTAL_LIMIT:
                raise SkillValidationError("skill bundle exceeds size limit")
            try:
                fields, _ = self._parse_skill_file(files["SKILL.md"]["data"].decode("utf-8"))
            except UnicodeDecodeError as exc:
                raise SkillValidationError("SKILL.md must be UTF-8") from exc
            if fields["name"] != name:
                raise SkillValidationError("skill name does not match bundle")
            receipt = None
            if provenance is not None:
                receipt = {**provenance, "installed_at": datetime.now(timezone.utc).isoformat()}
                if not _valid_installation_receipt(receipt):
                    raise SkillValidationError("invalid installation provenance")
            state = self._read_state()
            routes = self._read_targets()
            native = self._read_native_targets()
            previous_state = self._state_path.read_bytes() if self._state_path.exists() else None
            self._root.mkdir(parents=True, exist_ok=True)
            staging = Path(tempfile.mkdtemp(prefix=f".{name}-install-", dir=self._root))
            claimed = False
            published: list[tuple[Path, os.stat_result]] = []
            created_dirs: list[Path] = []
            directory_ids: dict[Path, os.stat_result] = {}
            directory_fds: dict[Path, int] = {}

            def check_directories() -> None:
                for directory, original in directory_ids.items():
                    current = directory.lstat()
                    if not stat.S_ISDIR(current.st_mode) or (
                        current.st_dev, current.st_ino
                    ) != (original.st_dev, original.st_ino):
                        raise SkillConflictError("skill directory changed during installation")

            def claim_directory(directory: Path) -> None:
                if _DIRECTORY_FDS:
                    parent_fd = directory_fds[directory.parent]
                    os.mkdir(directory.name, dir_fd=parent_fd)
                    created_dirs.append(directory)
                    directory_ids[directory] = os.stat(directory.name, dir_fd=parent_fd, follow_symlinks=False)
                    directory_fds[directory] = os.open(
                        directory.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd,
                    )
                else:
                    directory.mkdir()
                    created_dirs.append(directory)
                    directory_ids[directory] = directory.lstat()
                check_directories()

            try:
                (staging / MARKER_FILE).write_text(
                    json.dumps({"installation": receipt}, ensure_ascii=False) + "\n" if receipt else "",
                    encoding="utf-8",
                )
                for relative, entry in files.items():
                    path = staging / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with path.open("xb") as handle:
                        handle.write(entry["data"])
                    path.chmod(0o755 if entry["executable"] else 0o644)
                # mkdir is an exclusive claim even if an external writer raced
                # the earlier existence check. Never replace their directory.
                if _DIRECTORY_FDS:
                    directory_fds[self._root] = os.open(self._root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    directory_ids[self._root] = os.fstat(directory_fds[self._root])
                else:
                    directory_ids[self._root] = self._root.lstat()
                claim_directory(destination)
                claimed = True
                # Automatic CLI discovery must not see instructions before
                # their bundled helpers are present. This is not a filesystem
                # transaction for other observers; SKILL.md is published last.
                for child in sorted(staging.rglob("*"), key=lambda path: (path == staging / SKILL_FILE, len(path.parts), str(path))):
                    check_directories()
                    target = destination / child.relative_to(staging)
                    if child.is_dir():
                        claim_directory(target)
                    else:
                        # Same-filesystem hard links publish complete file
                        # bytes atomically and fail if an entry raced us.
                        if _DIRECTORY_FDS:
                            os.link(child, target.name, dst_dir_fd=directory_fds[target.parent])
                        else:
                            os.link(child, target)
                        published.append((target, child.stat()))
                        check_directories()
                state[name] = True
                if targets is not None:
                    routes[name] = targets
                else:
                    routes.pop(name, None)
                self._write_state(state, routes, native, consented=True)
                result = self.get_skill(name)
                self.rebuild_runtime_projection()
            except Exception:
                if claimed or created_dirs:
                    # Remove only our own entries. A file another writer
                    # added or replaced during publication is not ours.
                    for path, original in reversed(published):
                        try:
                            current = os.stat(path.name, dir_fd=directory_fds[path.parent], follow_symlinks=False) if _DIRECTORY_FDS else path.lstat()
                            if (current.st_dev, current.st_ino) == (original.st_dev, original.st_ino):
                                if _DIRECTORY_FDS:
                                    os.unlink(path.name, dir_fd=directory_fds[path.parent])
                                else:
                                    path.unlink()
                        except FileNotFoundError:
                            pass
                    for directory in reversed(created_dirs):
                        try:
                            original = directory_ids.get(directory)
                            if original is None:
                                continue
                            current = os.stat(directory.name, dir_fd=directory_fds[directory.parent], follow_symlinks=False) if _DIRECTORY_FDS else directory.lstat()
                            if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino):
                                continue
                            if _DIRECTORY_FDS:
                                os.rmdir(directory.name, dir_fd=directory_fds[directory.parent])
                            else:
                                directory.rmdir()
                        except OSError:
                            pass  # preserve concurrently added foreign files
                    if previous_state is None:
                        self._state_path.unlink(missing_ok=True)
                    else:
                        self._atomic_write(self._state_path, previous_state)
                    self._refresh_runtime_projection()
                raise
            finally:
                for fd in reversed(list(directory_fds.values())):
                    os.close(fd)
                shutil.rmtree(staging, ignore_errors=True)
            return {**result, "name": name, "path": str(destination),
                    "revision": result["skill"]["revision"], "changed": True}

    @_serialized
    def import_content(self, name: str, files: dict[str, Any]) -> bool:
        """Write a skill that arrived from another device. Returns whether it landed.

        Refuses, rather than merges, when a directory of that name is already
        there and is not ours: displacing the user's own skill is the one
        outcome this whole feature must never produce.
        """
        name = self._validate_name(name)
        self._ensure_safe_root()
        if not isinstance(files, dict) or SKILL_FILE not in files:
            log.warning("skill %s arrived without %s; not written", name, SKILL_FILE)
            return False
        skill_dir = self._skill_dir(name)
        if (skill_dir.exists() or skill_dir.is_symlink()) and not self._is_managed(skill_dir):
            log.warning("skill %s already exists here and is not ours; leaving it alone", name)
            return False
        if self._native_conflict(name):
            log.warning("skill %s collides with a native skill; leaving it alone", name)
            return False

        decoded: dict[str, bytes] = {}
        executable: set[str] = set()
        for relative, entry in files.items():
            safe = _safe_relative(relative)
            if safe is None or not isinstance(entry, dict):
                log.warning("skill %s: refusing the path %r", name, relative)
                return False
            kind, value = entry.get("t"), entry.get("v")
            if not isinstance(value, str):
                return False
            try:
                raw = value.encode("utf-8") if kind == "text" else base64.b64decode(value, validate=True)
            except (ValueError, TypeError):
                log.warning("skill %s: %s did not decode", name, safe)
                return False
            if len(raw) > self.CONTENT_FILE_LIMIT:
                return False
            decoded[safe] = raw
            if entry.get("x") is True:
                executable.add(safe)
        try:
            _validate_bundle_paths(list(decoded), portable_names=False)
        except SkillValidationError as err:
            log.warning("skill %s: %s", name, err)
            return False

        self._root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{name}-", dir=self._root))
        try:
            (staging / MARKER_FILE).write_text("", encoding="utf-8")
            for relative, raw in decoded.items():
                target = staging / relative
                if not _inside(target, staging):
                    raise SkillValidationError(f"skill {name}: {relative} leaves the skill directory")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
                if relative in executable:
                    target.chmod(0o755)
            backup = self._root / f".{name}.old"
            self._remove_tree(backup)
            if skill_dir.exists() or skill_dir.is_symlink():
                os.replace(skill_dir, backup)
            os.replace(staging, skill_dir)
            self._remove_tree(backup)
        except Exception:
            self._remove_tree(staging)
            raise
        self._refresh_runtime_projection()
        log.info("wrote skill %s from another device", name)
        return True

    # ── Files, for skills too large to ride in one sync record ──────────────
    #
    # The same ownership rules as export_content / import_content, without the
    # size limits: these files travel as blobs (skill_blobs), streamed from and
    # to disk, never as one record. Neither method reads a whole file.

    def list_files(self, name: str) -> dict[str, Path] | None:
        """Every file a managed skill would carry, by relative path, or None when
        it is not ours to send (or has no SKILL.md).

        A path the receiving side would refuse — a dotfile, say — is left out
        here rather than sent, since one refused path refuses the whole skill.
        """
        name = self._validate_name(name)
        skill_dir = self._skill_dir(name)
        if not skill_dir.is_dir() or not self._is_managed(skill_dir):
            return None
        files: dict[str, Path] = {}
        for path in sorted(skill_dir.rglob("*")):
            if path.is_symlink() or not path.is_file():
                continue
            relative = path.relative_to(skill_dir).as_posix()
            if relative == MARKER_FILE or _is_generated(relative):
                continue
            if _safe_relative(relative) is None:
                log.info("skill %s: %s is not carried to other devices", name, relative)
                continue
            files[relative] = path
        return files if SKILL_FILE in files else None

    def can_import(self, name: str) -> bool:
        """Whether a synced copy of *name* may be written here at all — asked
        before downloading hundreds of megabytes only to be refused."""
        name = self._validate_name(name)
        skill_dir = self._skill_dir(name)
        if (skill_dir.exists() or skill_dir.is_symlink()) and not self._is_managed(skill_dir):
            return False
        return not self._native_conflict(name)

    @_serialized
    def import_files(self, name: str, files: dict[str, Path], *, executable: set[str] | None = None) -> bool:
        """Write a skill whose files arrived as blobs. *files* maps each relative
        path to a verified local file, which is copied (streamed) into place.

        The same refusals as ``import_content``, and the same atomic swap: the
        skill is either wholly the new version or untouched.
        """
        name = self._validate_name(name)
        self._ensure_safe_root()
        if not isinstance(files, dict) or SKILL_FILE not in files:
            log.warning("skill %s arrived without %s; not written", name, SKILL_FILE)
            return False
        skill_dir = self._skill_dir(name)
        if (skill_dir.exists() or skill_dir.is_symlink()) and not self._is_managed(skill_dir):
            log.warning("skill %s already exists here and is not ours; leaving it alone", name)
            return False
        if self._native_conflict(name):
            log.warning("skill %s collides with a native skill; leaving it alone", name)
            return False
        safe_files: dict[str, Path] = {}
        for relative, source in files.items():
            safe = _safe_relative(relative)
            if safe is None or not isinstance(source, Path) or not source.is_file():
                log.warning("skill %s: refusing the path %r", name, relative)
                return False
            safe_files[safe] = source
        try:
            _validate_bundle_paths(list(safe_files), portable_names=False)
        except SkillValidationError as err:
            log.warning("skill %s: %s", name, err)
            return False

        self._root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{name}-", dir=self._root))
        try:
            (staging / MARKER_FILE).write_text("", encoding="utf-8")
            for relative, source in safe_files.items():
                target = staging / relative
                if not _inside(target, staging):
                    raise SkillValidationError(f"skill {name}: {relative} leaves the skill directory")
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
                if executable and relative in executable:
                    target.chmod(0o755)
            backup = self._root / f".{name}.old"
            self._remove_tree(backup)
            if skill_dir.exists() or skill_dir.is_symlink():
                os.replace(skill_dir, backup)
            os.replace(staging, skill_dir)
            self._remove_tree(backup)
        except Exception:
            self._remove_tree(staging)
            raise
        self._refresh_runtime_projection()
        log.info("wrote skill %s (%d files) from another device", name, len(safe_files))
        return True

    def rebuild_runtime_projection(self) -> Path:
        """Atomically replace the enabled-only runtime directory."""
        self._ensure_safe_root()
        state = self._read_state()
        runtime_parent = self._runtime_root.parent
        runtime_parent.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix=f".{self._runtime_root.name}-", dir=runtime_parent))
        backup = runtime_parent / f".{self._runtime_root.name}.old"
        try:
            if self._root.exists():
                for entry in sorted(self._root.iterdir(), key=lambda path: path.name):
                    if not _NAME_RE.fullmatch(entry.name) or not state.get(entry.name, True):
                        continue
                    try:
                        source = self._require_safe_skill_dir(entry.name)
                        self._read_skill(entry.name, state)
                    except SkillsStoreError as exc:
                        log.warning("Skipping invalid skill %s in runtime projection: %s", entry.name, exc)
                        continue
                    # Point at the real directory: a view of a link of a link
                    # is one hop more for every CLI that resolves it.
                    os.symlink(source.resolve(), tmp / entry.name, target_is_directory=True)

            if backup.exists() or backup.is_symlink():
                self._remove_projection_path(backup)
            if self._runtime_root.exists() or self._runtime_root.is_symlink():
                os.replace(self._runtime_root, backup)
            os.replace(tmp, self._runtime_root)
            if backup.exists() or backup.is_symlink():
                self._remove_projection_path(backup)
        except Exception:
            self._remove_projection_path(tmp)
            if not self._runtime_root.exists() and backup.exists():
                os.replace(backup, self._runtime_root)
            raise
        return self._runtime_root

    def _refresh_runtime_projection(self) -> None:
        try:
            self.rebuild_runtime_projection()
        except Exception as exc:  # noqa: BLE001 - projection is derived and retryable
            log.warning("Managed Skills saved but runtime projection refresh failed: %s", exc)

    def _read_skill(
        self,
        name: str,
        state: dict[str, bool],
        targets: dict[str, list[str]] | None = None,
    ) -> dict[str, Any]:
        name = self._validate_name(name)
        skill_dir = self._require_safe_skill_dir(name)
        skill_file = skill_dir / SKILL_FILE
        if skill_file.is_symlink() or not skill_file.is_file():
            raise SkillValidationError(f"{SKILL_FILE} must be a regular file")
        if skill_file.stat().st_size > SKILL_FILE_SIZE_LIMIT:
            raise SkillValidationError(f"{SKILL_FILE} exceeds the 1 MB size limit")

        raw = skill_file.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise SkillValidationError(f"{SKILL_FILE} must be UTF-8") from exc
        fields, body = self._parse_skill_file(text)
        if fields.get("name") != name:
            raise SkillValidationError("frontmatter name must match the skill directory")
        attachments = self._list_attachments(skill_dir)
        provenance = self._installation_provenance(skill_dir)
        return {
            "name": name,
            "description": fields.get("description", ""),
            "fields": fields,
            "body": body,
            "enabled": bool(state.get(name, True)),
            "native_conflict": self._native_conflict(name),
            "targets": (targets or {}).get(name),
            "managed": self._is_managed(skill_dir),
            "migrated_from": (
                str(origin) if (origin := self._migration_origin(skill_dir)) else None
            ),
            "revision": hashlib.sha256(raw).hexdigest(),
            "valid": True,
            "path": str(skill_dir),
            "attachments": attachments,
            **({"provenance": provenance} if provenance is not None else {}),
        }

    @staticmethod
    def _installation_provenance(skill_dir: Path) -> dict[str, Any] | None:
        marker = skill_dir / MARKER_FILE
        try:
            if marker.is_symlink() or marker.stat().st_size > 16 * 1024:
                return None
            for line in marker.read_text(encoding="utf-8").splitlines():
                if not line.startswith("{"):
                    continue
                document = json.loads(line)
                receipt = document.get("installation") if isinstance(document, dict) else None
                if _valid_installation_receipt(receipt):
                    return receipt
            return None
        except (OSError, UnicodeError, ValueError):
            # Empty ownership markers and migrated-from text remain valid.
            return None

    def _parse_skill_file(self, text: str) -> tuple[dict[str, Any], str]:
        match = _FRONTMATTER_RE.match(text)
        if not match:
            raise SkillValidationError(f"{SKILL_FILE} requires YAML frontmatter")
        try:
            fields = yaml.safe_load(match.group("yaml"))
        except yaml.YAMLError as exc:
            raise SkillValidationError(f"invalid YAML frontmatter: {exc}") from exc
        if not isinstance(fields, dict):
            raise SkillValidationError("frontmatter must be an object")
        self._validate_fields(fields)
        return fields, match.group("body")

    def _validate_fields(self, fields: dict[str, Any]) -> None:
        name = fields.get("name")
        if not isinstance(name, str):
            raise SkillValidationError("frontmatter name must be a string")
        self._validate_name(name)
        description = fields.get("description", "")
        if not isinstance(description, str):
            raise SkillValidationError("frontmatter description must be a string")
        try:
            yaml.safe_dump(fields, allow_unicode=True, sort_keys=False)
        except yaml.YAMLError as exc:
            raise SkillValidationError(f"frontmatter is not YAML-safe: {exc}") from exc

    def _write_skill_file(self, path: Path, fields: dict[str, Any], body: str) -> None:
        self._validate_fields(fields)
        yaml_text = yaml.safe_dump(fields, allow_unicode=True, sort_keys=False).rstrip("\n")
        payload = f"---\n{yaml_text}\n---\n{body}"
        encoded = payload.encode("utf-8")
        if len(encoded) > SKILL_FILE_SIZE_LIMIT:
            raise SkillValidationError(f"{SKILL_FILE} exceeds the 1 MB size limit")
        self._atomic_write(path, encoded)

    def _read_state_document(self) -> dict[str, Any]:
        if not self._state_path.exists():
            return {}
        if self._state_path.is_symlink() or not self._state_path.is_file():
            raise SkillValidationError("skills state must be a regular file")
        if self._state_path.stat().st_size > _STATE_FILE_SIZE_LIMIT:
            raise SkillValidationError("skills state exceeds the 1 MB size limit")
        try:
            raw = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SkillValidationError(f"invalid skills state: {exc}") from exc
        return raw if isinstance(raw, dict) else {}

    def _read_state(self) -> dict[str, bool]:
        raw = self._read_state_document()
        if not raw:
            return {}
        enabled = raw.get("enabled")
        if not isinstance(enabled, dict):
            raise SkillValidationError("skills state must contain an enabled object")
        clean: dict[str, bool] = {}
        for name, value in enabled.items():
            self._validate_name(name)
            if not isinstance(value, bool):
                raise SkillValidationError("skills enabled values must be booleans")
            clean[name] = value
        return clean

    def _read_native_targets(self) -> dict[str, list[str]]:
        raw = self._read_state_document().get("native_targets")
        if raw is None:
            return {}
        if not isinstance(raw, dict):
            raise SkillValidationError("skills native_targets must be an object")
        clean: dict[str, list[str]] = {}
        for real, agents in raw.items():
            if not isinstance(real, str) or not os.path.isabs(real):
                raise SkillValidationError("native target keys must be absolute paths")
            clean[real] = self._validate_agents(agents)
        return clean

    def _read_targets(self) -> dict[str, list[str]]:
        """Per-skill agent allow-lists; a missing entry means "every agent"."""
        raw = self._read_state_document().get("targets")
        if raw is None:
            return {}
        if not isinstance(raw, dict):
            raise SkillValidationError("skills targets must be an object")
        clean: dict[str, list[str]] = {}
        for name, agents in raw.items():
            self._validate_name(name)
            clean[name] = self._validate_agents(agents)
        return clean

    @staticmethod
    def _validate_agents(agents: Any) -> list[str]:
        if not isinstance(agents, list):
            raise SkillValidationError("skill targets must be a list of agent keys")
        clean: list[str] = []
        for agent in agents:
            if not isinstance(agent, str) or not _AGENT_RE.fullmatch(agent):
                raise SkillValidationError("invalid agent key in skill targets")
            if agent not in clean:
                clean.append(agent)
        return clean

    def _write_state(
        self,
        state: dict[str, bool],
        targets: dict[str, list[str]] | None = None,
        native_targets: dict[str, list[str]] | None = None,
        *,
        consented: bool | None = None,
    ) -> None:
        document: dict[str, Any] = {"enabled": state}
        if targets:
            document["targets"] = targets
        if native_targets:
            document["native_targets"] = native_targets
        # Consent is sticky: once given it survives every later rewrite.
        if consented if consented is not None else self.write_consented():
            document["write_consented"] = True
        payload = json.dumps(document, indent=2, ensure_ascii=False).encode("utf-8")
        self._atomic_write(self._state_path, payload)

    def _atomic_write(self, path: Path, payload: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise

    def _skill_dir(self, name: str) -> Path:
        candidate = self._root / self._validate_name(name)
        if candidate.parent != self._root:
            raise SkillValidationError("skill path escapes the managed root")
        return candidate

    def _ensure_safe_root(self) -> None:
        if self._root.is_symlink():
            raise SkillValidationError("skills root must be a directory, not a symlink")
        if self._root.exists() and not self._root.is_dir():
            raise SkillValidationError("skills root must be a directory, not a symlink")

    def _native_conflict(self, name: str) -> bool:
        """Return whether a user-owned native skills root contains ``name``.

        Native roots can be unreadable or disappear while being inspected;
        those failures must not make the managed Skills library unusable.
        """
        for root in self._native_roots:
            try:
                entry = root / name
                if entry.is_dir() or entry.is_file() or entry.is_symlink():
                    return True
            except OSError:
                continue
        return False

    @staticmethod
    def _validate_name(name: str) -> str:
        if not isinstance(name, str) or not _NAME_RE.fullmatch(name):
            raise SkillValidationError(
                "skill name must be lowercase letters, digits, underscores, or dashes"
            )
        return name

    def _skill_file(self, name: str) -> Path:
        return self._require_safe_skill_dir(name) / SKILL_FILE

    def _require_safe_skill_dir(self, name: str) -> Path:
        """The skill's directory, with the safety rule that fits who owns it.

        A directory *we* created must be a real directory inside the root:
        Navide writes there, and a link would let a write land anywhere.
        A directory the *user* put in the shared root may be a symlink — that
        is how tools like ego-browser install themselves — because Navide
        only ever reads it. Either way it must resolve to something real.
        """
        skill_dir = self._skill_dir(name)
        if not skill_dir.is_dir():
            raise SkillNotFoundError(f"skill not found: {name}")
        if skill_dir.is_symlink():
            if self._is_managed(skill_dir):
                raise SkillValidationError("a Navide-created skill must not be a symlink")
            return skill_dir
        try:
            skill_dir.resolve().relative_to(self._root)
        except ValueError as exc:
            raise SkillValidationError("skill path escapes the managed root") from exc
        return skill_dir

    @staticmethod
    def _is_managed(skill_dir: Path) -> bool:
        """Whether Navide created this directory (and so may edit or delete it)."""
        try:
            return (skill_dir / MARKER_FILE).is_file()
        except OSError:
            return False

    def _list_attachments(self, skill_dir: Path) -> list[dict[str, Any]]:
        attachments: list[dict[str, Any]] = []
        strict = self._is_managed(skill_dir)
        for path in sorted(skill_dir.rglob("*")):
            if path.is_symlink():
                if strict:
                    raise SkillValidationError("skill attachments must not contain symlinks")
                continue  # the user's own layout; listed, never followed
            if path.is_file() and path != skill_dir / SKILL_FILE and path.name != MARKER_FILE:
                attachments.append(
                    {"path": path.relative_to(skill_dir).as_posix(), "size": path.stat().st_size}
                )
        return attachments

    @staticmethod
    def _summary(skill: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in skill.items() if key not in {"fields", "body"}}

    @staticmethod
    def _remove_projection_path(path: Path) -> None:
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
        elif path.exists():
            shutil.rmtree(path)


def _carries_exec_bit(path: Path, raw: bytes) -> bool:
    """Whether a synced copy of *path* should be executable. Windows keeps no
    such bit, so there a script is taken by its shebang."""
    if osplat.paths.enforces_posix_modes():
        return bool(path.stat().st_mode & 0o111)
    return raw[:2] == b"#!"


def _is_generated(relative: str) -> bool:
    return (
        "__pycache__/" in f"{relative}/"
        or relative.endswith(".pyc")
        or relative.split("/")[-1] == ".DS_Store"
    )


def _valid_installation_receipt(receipt: Any) -> bool:
    if not isinstance(receipt, dict) or not {"source", "digest", "installed_at"} <= set(receipt):
        return False
    if set(receipt) - {"source", "digest", "installed_at", "schema_version", "prepared_at"}:
        return False
    if "schema_version" in receipt and receipt["schema_version"] != 1:
        return False
    if not isinstance(receipt["digest"], str) or not re.fullmatch(r"[0-9a-f]{64}", receipt["digest"]):
        return False
    try:
        if datetime.fromisoformat(receipt["installed_at"]).tzinfo is None:
            return False
        if "prepared_at" in receipt and datetime.fromisoformat(receipt["prepared_at"]).tzinfo is None:
            return False
    except (ValueError, TypeError):
        return False
    source = receipt["source"]
    if not isinstance(source, dict):
        return False
    if source.get("kind") == "local":
        return set(source) == {"kind", "path"} and isinstance(source["path"], str) and os.path.isabs(source["path"])
    if source.get("kind") == "github":
        return (
            {"kind", "repository", "commit", "subdir"} <= set(source)
            and not set(source) - {"kind", "repository", "commit", "subdir", "requested_ref"}
            and isinstance(source.get("requested_ref", ""), str)
            and isinstance(source["repository"], str)
            and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source["repository"]) is not None
            and isinstance(source["commit"], str)
            and re.fullmatch(r"[0-9a-f]{40}", source["commit"]) is not None
            and isinstance(source["subdir"], str)
            and all(part not in {".", ".."} and "\\" not in part and ":" not in part for part in source["subdir"].split("/"))
        )
    return False


def _alias_key(path: str) -> str:
    """One key for every spelling a case-insensitive, normalising volume
    opens as the same file: the canonical caseless match
    NFD(casefold(NFD(p))) — a full casefold decomposes, so composing first
    and folding after misses pairs APFS treats as one (U+0390 and its
    decomposed uppercase) — with simple uppercase folded in as well, so
    pairs such as dotless ı and I, one file on NTFS, share it too."""
    folded = unicodedata.normalize("NFD", path).casefold()
    return unicodedata.normalize("NFD", folded.upper().casefold())


def _validate_bundle_paths(
    paths: Any, *, directories: Any = (), allow_hidden: bool = False, portable_names: bool = True
) -> None:
    """Reject filenames that cannot retain distinct identities on all hosts.

    Two paths that are one file on a case-insensitive or normalising volume
    (``SKILL.md``/``skill.md``, NFC/NFD) are refused: one would be written
    over the other, so what was shown is not what lands. ``portable_names``
    False leaves Windows-reserved names to the platform that reserves them
    (``osplat.paths.file_name_refused``), as sync does."""
    spellings: dict[str, str] = {}
    files = set(paths)
    directories = set(directories)
    if files & directories:
        raise SkillValidationError("skill path is both a file and directory")
    for relative in files | directories:
        if _safe_relative(relative, allow_hidden=allow_hidden) is None or ":" in relative:
            raise SkillValidationError("invalid skill bundle path")
        parts = relative.split("/")
        for index, part in enumerate(parts):
            refused = windows_refused_file_name(part) if portable_names else osplat.paths.file_name_refused(part)
            if refused:
                raise SkillValidationError(f"nonportable skill path: {relative}")
            prefix = "/".join(parts[:index + 1])
            key = _alias_key(prefix)
            if key in spellings and spellings[key] != prefix:
                raise SkillValidationError(f"skill paths alias on some filesystems: {relative}")
            spellings[key] = prefix
            if index < len(parts) - 1 and prefix in files:
                raise SkillValidationError(f"skill path is both a file and directory: {prefix}")


def _inside(path: Path, root: Path) -> bool:
    """Whether *path*, resolved, is *root* or under it."""
    try:
        resolved = path.resolve()
        base = root.resolve()
    except OSError:
        return False
    return resolved == base or base in resolved.parents


def _safe_relative(relative: Any, *, allow_hidden: bool = False) -> str | None:
    """``relative`` as a path that cannot leave the skill directory, or None.

    Absolute paths, ``..`` segments, backslashes and empty parts are all
    refused rather than sanitised: a path that needed fixing is a path whose
    sender meant something this side should not guess at.
    """
    if not isinstance(relative, str) or not relative or len(relative) > 255:
        return None
    if relative.startswith("/") or "\\" in relative or "\x00" in relative:
        return None
    parts = relative.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    # A ":" is refused on every platform: on Windows it is a drive ("C:/x",
    # "D:x") or an alternate data stream ("SKILL.md:ads") and leaves the
    # directory it is joined onto. Names only Windows reads differently
    # (reserved devices, a trailing dot or space) are refused where they
    # would be misread; "aux.c" is an ordinary file on macOS and Linux, and a
    # skill carrying one is refused by the Windows device it reaches.
    if any(":" in part or osplat.paths.file_name_refused(part) for part in parts):
        return None
    # Every dotfile is refused, the marker included: this side writes its own
    # marker, and nothing else hidden has a reason to travel between machines.
    if not allow_hidden and any(part.startswith(".") for part in parts):
        return None
    return "/".join(parts)
