"""The MCP server names its own version, so a session can start without the
installed ``mcp`` package metadata (2026-11-08: the onefile backend's extraction
directory lost its dist-info to the macOS temp purge and every new MCP session
failed to initialize)."""

from __future__ import annotations

import importlib.metadata

import pytest

from agent_team_backend import __version__
from agent_team_backend.mcp_server import server as navide_mcp


def test_initialization_options_carry_the_backend_version() -> None:
    options = navide_mcp.server._mcp_server.create_initialization_options()
    assert options.server_version == __version__


def test_initialization_does_not_need_package_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing(_name: str) -> str:
        raise importlib.metadata.PackageNotFoundError("mcp")

    monkeypatch.setattr(importlib.metadata, "version", missing)
    options = navide_mcp.server._mcp_server.create_initialization_options()
    assert options.server_version == __version__
