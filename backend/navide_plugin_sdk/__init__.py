"""The public Python surface a plugin backend builds against.

A backend imports these names and never ``agent_team_backend``. The names are
versioned: ``API_VERSION`` shares its major with ``PLUGIN_API_VERSION`` in
``@navide/plugin-contracts``, and a major changes only under the Compatibility
policy in ``docs/en-US/plugin-development-v2.md``. What sits behind a name is
free to change, and is bundled into each backend at build time, so a Host
update never reaches a published package.
"""

from __future__ import annotations

from agent_team_backend import plan_versions
from agent_team_backend.fs_write import (
    _WRITE_PART_MAX_BYTES as WRITE_PART_MAX_BYTES,
    _resolve_mutation_safe as resolve_mutation_safe,
    _staging_path as staging_path,
    write_abort,
    write_commit,
    write_file,
    write_part,
)
from agent_team_backend.path_guard import FsError, _resolve_safe as resolve_safe

API_VERSION = "1.0.0"

__all__ = [
    "API_VERSION",
    "FsError",
    "WRITE_PART_MAX_BYTES",
    "plan_versions",
    "resolve_mutation_safe",
    "resolve_safe",
    "staging_path",
    "write_abort",
    "write_commit",
    "write_file",
    "write_part",
]
