"""Workspace path guard shared by the core backend and plugin backends.

Resolves a caller-supplied relative path under a workspace root and rejects
``..`` traversal, absolute-path and symlink escapes, and access to the internal
``.agent-team`` directory outside its user-facing subtrees. Standard library
only, so a separately packaged plugin backend can bundle it without pulling in
``fs_service``'s third-party dependencies.
"""

from __future__ import annotations

import os
from pathlib import Path

PROJECT_DIR_NAME = ".agent-team"

# User-facing plan documents live under <workspace>/.agent-team/plans/ and reports
# live under <workspace>/.agent-team/reports/ (see plan_provisioning).
# These subtrees are exempt from the internal-dir protection.
_ALLOWED_AGENT_TEAM_SUBDIRS = frozenset({"plans", "reports"})
# Mockups may be inspected and previewed, but filesystem mutations stay blocked.
_READABLE_AGENT_TEAM_SUBDIRS = _ALLOWED_AGENT_TEAM_SUBDIRS | {"mockups"}


class FsError(Exception):
    """Raised on invalid or unsafe filesystem operations."""

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


def _resolve_safe(
    workspace_path: str, rel_path: str, *, allow_internal_root: bool = False,
    allow_mockups: bool = False,
) -> Path:
    """Resolve ``rel_path`` under the workspace root, rejecting any escape.

    Guards against ``..`` traversal, absolute-path escapes, symlink escapes
    (via ``resolve()``), and operations touching the internal ``.agent-team``
    directory — except its user-facing subtrees. ``mockups/`` is read-only.
    Only read-only callers may opt in with ``allow_mockups``.
    """
    if not workspace_path:
        raise FsError("no workspace selected")
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        raise FsError("workspace not found")

    rel = (rel_path or "").strip().replace("\\", "/").lstrip("/")
    target = (root / rel).resolve()

    if target != root and root not in target.parents:
        raise FsError("path escapes workspace")

    # Listing the workspace's OWN internal dir is allowed so the file tree can
    # show it. The exemption is keyed on the root, not on the directory name:
    # a caller that names `<ws>/.agent-team` as its root does not match this
    # (its `internal_root` would be one level deeper), so the guard below still
    # rejects it — that route is how a caller could otherwise enumerate the
    # internal state. Nothing under the dir opens up either; every child except
    # the allowed subtrees fails the guard on its own path.
    if allow_internal_root and _same_path(target, root / PROJECT_DIR_NAME):
        return target
    _reject_protected_internal_dir(target, allow_mockups=allow_mockups)
    return target


def _same_path(a: Path, b: Path) -> bool:
    """Whether two paths name the same directory entry on disk.

    ``==`` compares strings, and on a case-insensitive filesystem (APFS by
    default) ``.Agent-Team`` and ``.agent-team`` are different strings for the
    same directory — ``Path.resolve()`` does not fold case, so a string
    comparison lets the internal-dir guard be walked around by capitalising
    one letter. ``samefile`` asks the filesystem, which also covers a symlink
    that points into the internal dir. Either path missing means "not the
    same" — the caller still gets its 404 later, but never a false pass.
    """
    if a == b:
        return True
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def _internal_dir_index(parts: tuple[str, ...]) -> int | None:
    """Index of the ``.agent-team`` component in an absolute, resolved path.

    Matched by identity on disk, not by name: for each prefix of the path,
    ask whether it is the same entry as ``<parent>/.agent-team``. A name that
    differs only in case, in Unicode normalisation, or by way of a symlink
    still lands on the internal dir and is still caught.
    """
    for i, part in enumerate(parts):
        if part == PROJECT_DIR_NAME:
            return i
        if i == 0:
            continue
        prefix = Path(*parts[: i + 1])
        candidate = prefix.parent / PROJECT_DIR_NAME
        if _same_path(prefix, candidate):
            return i
    return None


def _reject_protected_internal_dir(target: Path, *, allow_mockups: bool = False) -> None:
    """Reject paths inside an internal ``.agent-team`` dir, wherever it sits.

    The check walks the whole absolute path rather than only the part below the
    root: a caller may name any existing directory as its root (that is how
    files outside a workspace are opened), and rooting at
    ``<ws>/.agent-team`` would otherwise leave the guard looking at a filename
    where it expects the internal dir. ``plans/`` and ``reports/`` support
    reads and mutations; ``mockups/`` is allowed only for reads.
    """
    parts = target.parts
    i = _internal_dir_index(parts)
    if i is None:
        return
    # `target` is already resolve()d, so a traversal like
    # `.agent-team/plans/../chat-threads.json` normalizes to a protected
    # path before reaching this check.
    nxt = parts[i + 1] if i + 1 < len(parts) else None
    allowed = _READABLE_AGENT_TEAM_SUBDIRS if allow_mockups else _ALLOWED_AGENT_TEAM_SUBDIRS
    if nxt not in allowed:
        raise FsError("the internal directory is protected")
