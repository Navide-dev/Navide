"""A workspace registered before Claude's projects root exists still owns its sessions.

On a fresh install ~/.claude/projects is created by the first Claude pane, after
the workspace has already been registered. The workspace's claude_dir used to
stay empty until something re-registered it (a second pane), so every activity
event of the first pane was attributed to no workspace and dropped.
"""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.cli_vendors.claude import ClaudeLogReader
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import TokenUsage, encode_claude_cwd

WS = "/Users/x/wh/wm"


class _Reader(ClaudeLogReader):
    """Like the real root lookup: no root until the directory exists."""

    def __init__(self, root: Path) -> None:
        super().__init__()
        self.root = root

    def _default_root(self) -> Path | None:
        return self.root if self.root.is_dir() else None


def _usage(path: Path) -> TokenUsage:
    return TokenUsage(
        vendor="claude", input_tokens=0, output_tokens=0, cwd="", session_id=path.stem,
        file_path=str(path), dedup_key="k", timestamp="2026-11-27T06:28:44Z",
    )


def _first_session(root: Path) -> Path:
    folder = root / encode_claude_cwd(WS)
    folder.mkdir(parents=True)
    path = folder / "1e0a0fad-7490-43b6-8307-076e783a2c11.jsonl"
    path.write_text(json.dumps({"type": "user", "cwd": WS}) + "\n", encoding="utf-8")
    return path


def test_workspace_registered_before_root_exists_attributes_first_session(tmp_path: Path) -> None:
    reader = _Reader(tmp_path / "projects")
    attr = Attribution([reader], workspaces_path=tmp_path / "workspaces.json")
    attr.register_workspace(WS)

    path = _first_session(reader.root)

    assert attr.attribute(_usage(path)).workspace_path == WS

