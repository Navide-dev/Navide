"""What a CLI pane loaded at spawn, reduced to two comparable fingerprints.

A CLI reads its MCP servers and its skills once, when it starts. A pane that
was opened before the user changed either keeps running with the old set
until it is rebuilt, and nothing on screen said so. This module records, at
spawn, a fingerprint of each of the two inputs, so the window can later list
the panes whose inputs moved on and offer the user a rebuild. It never
rebuilds anything itself.

- **mcp**: the agent's own user-global MCP config (``~/.claude.json`` and the
  like), read through :mod:`native_mcp` -- already masked, so no secret value
  feeds the hash. Navide's Settings -> MCP servers are not an input: those are
  the servers the backend connects to as a client, and no spawn reads them.
- **skills**: the managed-skills delivery for that agent -- each targeted
  shared skill with its SKILL.md revision, plus the native skills routed to it.

Read-only by construction: the skills side reads the store's state and never
rebuilds the runtime projection the spawn wiring maintains. A part is ``None``
for a CLI that has no such input, and a part that cannot be read is ``None``
too -- an unknown fingerprint never marks a pane stale.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

log = logging.getLogger(__name__)

#: Key under which a terminal's spawn-time fingerprint lives in its metadata.
METADATA_KEY = "config_fingerprint"


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode("utf-8")).hexdigest()


def mcp_fingerprint(agent_key: str) -> str | None:
    from . import native_mcp

    if not any(source.agent == agent_key for source in native_mcp.NATIVE_SOURCES):
        return None
    try:
        rows = [server.as_dict() for server in native_mcp.scan() if server.agent == agent_key]
    except Exception as err:  # noqa: BLE001 - a disclosure must never break a spawn
        log.warning("MCP fingerprint for %s failed: %s", agent_key, err)
        return None
    for row in rows:
        # The file path is where the servers live, not what they are.
        row.pop("path", None)
    return _digest(sorted(rows, key=lambda row: json.dumps(row, sort_keys=True)))


def skills_fingerprint(agent_key: str) -> str | None:
    from .plugins.builtin.navide_skills.skills_wiring import skills_wiring
    from .skills_store import SkillsStore

    if skills_wiring(agent_key) is None:
        return None
    try:
        store = SkillsStore()
        shared = [
            [name, store.get_skill(name)["skill"]["revision"]]
            for name in store.targets_for(agent_key)
        ]
        native = sorted(store.native_targets_for(agent_key))
    except Exception as err:  # noqa: BLE001 - a disclosure must never break a spawn
        log.warning("Skills fingerprint for %s failed: %s", agent_key, err)
        return None
    return _digest({"shared": shared, "native": native})


def fingerprint(agent_key: str) -> dict[str, str | None]:
    """Both parts for one agent, as recorded at spawn and recomputed later."""
    return {"mcp": mcp_fingerprint(agent_key), "skills": skills_fingerprint(agent_key)}


def stale_parts(recorded: Any, current: dict[str, str | None]) -> list[str]:
    """Which parts changed since spawn. Unknown on either side is not stale."""
    if not isinstance(recorded, dict):
        return []
    return [
        part
        for part in ("mcp", "skills")
        if recorded.get(part) and current.get(part) and recorded[part] != current[part]
    ]
