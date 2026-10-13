"""Security review round 10 (three L items)."""

from __future__ import annotations

import pytest

from agent_team_backend import app, settings_bundle, sync_approvals, sync_scopes
from agent_team_backend.osplat.spec import windows_refused_file_name, windows_short_name
from tests.test_settings_bundle import mcp_store, settings, skills  # noqa: F401


@pytest.fixture(autouse=True)
def _own_app_data(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "app_data_dir", lambda: tmp_path / "app-data")


# ── R10-1: only the real 8.3 short-name shape ───────────────────────────────
@pytest.mark.parametrize("name", ["REFERE~1.MD", "progra~1", "a~2", "SHORT~12.TXT", "x~1.c", "v1~2.md"])
def test_the_short_name_shape(name):
    assert windows_short_name(name)


@pytest.mark.parametrize("name", ["reference~1.md", "a~1.longext", "a.b~1", "~1", "a~b", "notes~x.txt"])
def test_not_the_short_name_shape(name):
    assert not windows_short_name(name)


@pytest.mark.parametrize("name", ["v1~2.md", "notes~1.txt", "REFERE~1.MD"])
def test_the_portable_rule_every_install_applies_allows_tildes(name):
    """Not refused by the rule installers apply on every platform; the
    Windows seam (file_name_refused) adds the short-name shape there."""
    assert not windows_refused_file_name(name)


# ── R10-2: a local secret goes back only into the very same server ─────────
_LOCAL = {"name": "srv", "transport": "stdio", "command": "npx", "args": ["--x"],
          "env": {"API_TOKEN": "mine", "MODE": "a"}, "enabled": True}


@pytest.mark.parametrize("change", [
    {"env": {"API_TOKEN": "", "MODE": "b"}},        # a non-secret env value differs
    {"env": {"API_TOKEN": "", "MODE": "a", "NODE_OPTIONS": "--require x"}},  # a new env entry
    {"transport": "stdio", "command": "npx", "args": ["--y"], "env": {"API_TOKEN": "", "MODE": "a"}},
])
def test_a_secret_is_not_restored_into_a_server_that_differs(settings, mcp_store, skills, change):  # noqa: F811
    incoming = {**_LOCAL, "env": {"API_TOKEN": "", "MODE": "a"}, **change}
    restored = settings_bundle.restore_secrets(incoming, _LOCAL)
    assert restored["env"]["API_TOKEN"] == ""


def test_a_secret_is_restored_into_the_same_server(settings, mcp_store, skills):  # noqa: F811
    incoming = {**_LOCAL, "env": {"API_TOKEN": "", "MODE": "a"}, "enabled": False}
    assert settings_bundle.restore_secrets(incoming, _LOCAL)["env"]["API_TOKEN"] == "mine"


def test_a_different_transport_or_cwd_is_a_different_server():
    remote = {"name": "w", "transport": "http", "url": "https://x/mcp", "headers": {"Authorization": "a"}}
    sse = {**remote, "transport": "sse", "headers": {"Authorization": ""}}
    assert settings_bundle.restore_secrets(sse, remote)["headers"]["Authorization"] == ""
    with_cwd = {**_LOCAL, "cwd": "/tmp/evil", "env": {"API_TOKEN": "", "MODE": "a"}}
    assert settings_bundle.restore_secrets(with_cwd, _LOCAL)["env"]["API_TOKEN"] == ""


# ── R10-3: frontmatter YAML that does not parse cannot be shown ────────────
def test_frontmatter_that_is_not_valid_yaml_is_refused():
    md = "---\nname: evil\ndescription: [unclosed\nhooks:\n  - x\n---\nbody\n"
    summary = sync_scopes._skill_summary("evil", {}, {"SKILL.md": {"t": "text", "v": md}})
    assert not sync_approvals.showable(summary)
