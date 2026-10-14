"""Capability API + host injection tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend import app
from agent_team_backend.plugins.capabilities import (
    CapabilityError,
    ChatCapability,
    FsCapability,
    GitCapability,
    IssuesCapability,
    SearchCapability,
    TerminalCapability,
    UiCapability,
    build_capabilities,
)
from agent_team_backend.plugins.host import PluginHost
from agent_team_backend.plugins.manifest import KNOWN_CAPABILITIES, parse_manifest

MINI_IDE_MANIFEST = (
    Path(__file__).resolve().parents[1]
    / "agent_team_backend"
    / "plugins"
    / "examples"
    / "mini-ide.plugin.json"
)

FS_READER_PLUGIN_DIR = (
    Path(__file__).resolve().parents[1]
    / "agent_team_backend"
    / "plugins"
    / "examples"
    / "fs_reader_plugin"
)


# -- build_capabilities: authorization -----------------------------------


def test_build_only_declared_capability() -> None:
    caps = build_capabilities(["fs"])

    assert set(caps) == {"fs"}
    assert isinstance(caps["fs"], FsCapability)
    assert "git" not in caps
    assert "terminal" not in caps


def test_build_all_capabilities() -> None:
    caps = build_capabilities(["fs", "git", "terminal"])

    assert set(caps) == {"fs", "git", "terminal"}
    assert isinstance(caps["fs"], FsCapability)
    assert isinstance(caps["git"], GitCapability)
    assert isinstance(caps["terminal"], TerminalCapability)


def test_build_empty_requires_yields_nothing() -> None:
    assert build_capabilities([]) == {}


def test_build_unknown_capability_rejected() -> None:
    with pytest.raises(CapabilityError, match="unknown capability"):
        build_capabilities(["bogus"])


def test_known_capabilities_is_full_set() -> None:
    assert KNOWN_CAPABILITIES == frozenset(
        {"fs", "git", "terminal", "search", "chat", "ui", "issues", "plans"}
    )


def test_build_issues_capability() -> None:
    caps = build_capabilities(["issues"])

    assert set(caps) == {"issues"}
    assert isinstance(caps["issues"], IssuesCapability)


def test_issues_capability_delegates_to_issue_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple] = []
    sentinel = {"issues": []}

    async def fake_list_issues(workspace_path, limit):
        calls.append((workspace_path, limit))
        return sentinel

    monkeypatch.setattr(app.issue_service, "list_issues", fake_list_issues)

    import asyncio

    result = asyncio.run(IssuesCapability().list("/ws", limit=15))

    assert result is sentinel
    assert calls == [("/ws", 15)]


def test_build_new_capabilities() -> None:
    caps = build_capabilities(["search", "chat", "ui"])

    assert set(caps) == {"search", "chat", "ui"}
    assert isinstance(caps["search"], SearchCapability)
    assert isinstance(caps["chat"], ChatCapability)
    assert isinstance(caps["ui"], UiCapability)


def test_search_chat_ui_absent_when_not_declared() -> None:
    caps = build_capabilities(["fs"])

    assert "search" not in caps
    assert "chat" not in caps
    assert "ui" not in caps


# -- delegation to core services -----------------------------------------


def test_fs_capability_delegates_to_fs_service(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple] = []
    sentinel = {"content": "hi"}

    def fake_read_file(workspace_path, rel_path, encoding_override=None):
        calls.append((workspace_path, rel_path, encoding_override))
        return sentinel

    monkeypatch.setattr(app.fs_service, "read_file", fake_read_file)

    result = FsCapability().read_file("/ws", "a.txt")

    assert result is sentinel
    assert calls == [("/ws", "a.txt", None)]


def test_git_capability_delegates_to_git_service(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple] = []
    sentinel = {"branch": "main"}

    def fake_get_status(workspace_path, include_ignored=False):
        calls.append((workspace_path, include_ignored))
        return sentinel

    monkeypatch.setattr(app.git_service, "get_status", fake_get_status)

    result = GitCapability().status("/ws")

    assert result is sentinel
    assert calls == [("/ws", False)]


def test_fs_new_method_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple] = []
    sentinel = {"files": []}

    def fake_glob_files(workspace_path, pattern):
        calls.append((workspace_path, pattern))
        return sentinel

    monkeypatch.setattr(app.fs_service, "glob_files", fake_glob_files)

    result = FsCapability().glob_files("/ws", "**/*.py")

    assert result is sentinel
    assert calls == [("/ws", "**/*.py")]


def test_git_new_method_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple] = []
    sentinel = {"ok": True}

    def fake_commit(workspace_path, message, commit_all):
        calls.append((workspace_path, message, commit_all))
        return sentinel

    monkeypatch.setattr(app.git_service, "commit", fake_commit)

    result = GitCapability().commit("/ws", "msg", commit_all=True)

    assert result is sentinel
    assert calls == [("/ws", "msg", True)]


def test_search_capability_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple] = []
    sentinel = {"matches": []}

    def fake_find_in_files(workspace_path, query, **kwargs):
        calls.append((workspace_path, query, kwargs))
        return sentinel

    monkeypatch.setattr(app.search_service, "find_in_files", fake_find_in_files)

    result = SearchCapability().find_in_files("/ws", "needle", is_regex=True)

    assert result is sentinel
    assert calls == [("/ws", "needle", {"is_regex": True})]


def test_chat_settings_delegate_to_store(monkeypatch: pytest.MonkeyPatch) -> None:
    sentinel = {"provider": "ollama"}
    monkeypatch.setattr(app.ai_chat_settings_store, "get", lambda: sentinel)

    assert ChatCapability().settings_get() is sentinel


# -- terminal capability ---------------------------------------------------


def test_terminal_list_uses_public_accessor(monkeypatch: pytest.MonkeyPatch) -> None:
    class StubTerminals:
        def list_session_ids(self) -> list[str]:
            return ["s1", "s2"]

    monkeypatch.setattr(app, "get_terminals", lambda: StubTerminals())

    assert TerminalCapability().list() == ["s1", "s2"]


def test_terminal_run_rejects_unregistered_cwd(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import asyncio

    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [])

    with pytest.raises(CapabilityError, match="not registered"):
        asyncio.run(TerminalCapability().run("echo hi", cwd=str(tmp_path)))


def test_terminal_run_without_a_cwd_is_refused(tmp_path: Path) -> None:
    """d1, the second entry point: with no cwd this ran the command in the
    backend's own cwd, past the registered-workspace check."""
    import asyncio

    marker = tmp_path / "ran"
    with pytest.raises(CapabilityError, match="workspace path is required"):
        asyncio.run(TerminalCapability().run(f"touch {marker}"))
    assert not marker.exists()


def _host_has_the_seam_shell() -> bool:
    """`TerminalCapability.run` execs whatever `osplat.paths.shell_command()`
    names. Gate on that program being on this host — not on which OS this
    is — so the two tests below skip, rather than die on FileNotFoundError,
    when the seam is swapped to another platform's implementation
    (`-p tests.osplat_win_swap`)."""
    import shutil

    from agent_team_backend import osplat

    return shutil.which(osplat.paths.shell_command("")[0]) is not None


@pytest.mark.skipif(
    not _host_has_the_seam_shell(), reason="the seam's shell is not on this host"
)
def test_terminal_run_allows_registered_subdir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import asyncio

    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [str(tmp_path)])
    subdir = tmp_path / "sub"
    subdir.mkdir()

    result = asyncio.run(TerminalCapability().run("echo hi", cwd=str(subdir)))

    assert result["ok"] is True
    assert "hi" in result["output"]
    assert result["exit_code"] == 0


@pytest.mark.skipif(
    not _host_has_the_seam_shell(), reason="the seam's shell is not on this host"
)
def test_terminal_run_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import asyncio

    from agent_team_backend.plugins import capabilities as capabilities_module

    monkeypatch.setattr(capabilities_module, "_RUN_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [str(tmp_path)])

    with pytest.raises(CapabilityError, match="timed out"):
        asyncio.run(TerminalCapability().run("sleep 5", cwd=str(tmp_path)))


# -- ui capability: host-side placeholder --------------------------------


def test_ui_capability_is_host_side() -> None:
    ui = UiCapability()
    with pytest.raises(CapabilityError, match="host-side"):
        ui.open_external("https://example.com")
    with pytest.raises(CapabilityError, match="host-side"):
        ui.get_cli_pane_buffer()


# -- expanded whitelist lets mini-ide manifest validate ------------------


def test_mini_ide_manifest_parses_with_expanded_whitelist() -> None:
    import json

    data = json.loads(MINI_IDE_MANIFEST.read_text(encoding="utf-8"))
    manifest = parse_manifest(data)

    assert manifest.requires == ["fs", "git", "terminal", "search", "chat", "ui", "issues"]
    assert all(cap in KNOWN_CAPABILITIES for cap in manifest.requires)


# -- host injection + authorization semantics ----------------------------


def test_host_injects_only_declared_capabilities() -> None:
    host = PluginHost()

    loaded = host.load(FS_READER_PLUGIN_DIR)

    assert set(loaded.context.capabilities) == {"fs"}
    assert isinstance(loaded.context.capabilities["fs"], FsCapability)
    assert "git" not in loaded.context.capabilities


def test_plugin_activate_uses_capability_end_to_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sentinel = {"content": "from-plugin"}

    def fake_read_file(workspace_path, rel_path, encoding_override=None):
        return sentinel

    monkeypatch.setattr(app.fs_service, "read_file", fake_read_file)

    host = PluginHost()
    loaded = host.load(FS_READER_PLUGIN_DIR)
    host.activate("navide.fs-reader")

    # The plugin captured the fs capability on activation...
    assert loaded.module.declared_capabilities == ["fs"]
    # ...and can drive a real delegation through it.
    assert loaded.module.read("/ws", "note.md") is sentinel
