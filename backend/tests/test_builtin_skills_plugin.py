from __future__ import annotations

from collections.abc import Iterator

import pytest

from agent_team_backend.plugins import wiring
from agent_team_backend.plugins.activation_catalog import (
    ACTIVATION_CATALOG_DIGEST_ENV,
    ACTIVATION_CATALOG_PATH_ENV,
)
from agent_team_backend.plugins.host import PluginHost


@pytest.fixture
def host(monkeypatch: pytest.MonkeyPatch) -> Iterator[PluginHost]:
    monkeypatch.delenv(ACTIVATION_CATALOG_PATH_ENV, raising=False)
    monkeypatch.delenv(ACTIVATION_CATALOG_DIGEST_ENV, raising=False)
    host = PluginHost()
    yield host
    wiring.shutdown(host)


def test_builtin_root_contains_navide_skills() -> None:
    dirs = wiring.discover_backend_plugin_dirs(wiring.builtin_plugins_root())
    assert wiring.builtin_plugins_root() / "navide_skills" in dirs


def test_startup_activates_skills_plugin_and_registers_transformer(
    host: PluginHost,
) -> None:
    assert wiring.startup(host) == ["navide.plans", "navide.shipped-log", "navide.skills"]
    # Only skills registers a spawn transformer now: the MCP endpoint wiring
    # that navide.plans used to contribute is core, applied ahead of the
    # plugin transformers by the terminal.create handler.
    assert [plugin_id for plugin_id, _ in host.spawn_transformers()] == ["navide.skills"]
