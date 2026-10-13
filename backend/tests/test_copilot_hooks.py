"""Tests for the GitHub Copilot CLI hook installer.

Copilot auto-loads every *.json in its hooks directory, so we own one file
outright instead of merging into the user's config. That makes the installer
simple; what these tests pin is the file SHAPE, which is Copilot's own (flat
handler, lowercase event name) rather than Claude's, and the failure mode of
the command it installs.
"""

from __future__ import annotations

import json

from agent_team_backend import copilot_hooks


def _document(directory) -> dict:
    return json.loads((directory / "agent-team.json").read_text())


def test_installs_a_flat_notification_handler(tmp_path) -> None:
    result = copilot_hooks.install_hooks("/tmp/port-file", hooks_directory=tmp_path)

    assert result["installed"] is True
    doc = _document(tmp_path)
    assert doc["version"] == 1
    assert doc["disableAllHooks"] is False
    # Copilot's event names are lowercase, unlike Claude's.
    # preToolUse is Navide Guard's hook, covered in tests/guard_hooks.
    assert list(doc["hooks"]) == ["notification", "preToolUse"]
    handler = doc["hooks"]["notification"][0]
    # Flat shape: the command sits directly on the entry, not nested under a
    # second "hooks" list the way Claude and Qwen do it.
    assert "hooks" not in handler
    assert "/hooks/copilot" in handler["command"]
    assert handler["timeoutSec"] == 5


def test_the_command_always_exits_zero(tmp_path) -> None:
    # A non-zero exit is how a Copilot hook reports failure, and curl exits
    # non-zero whenever the backend is down — the normal state when Navide
    # is not running. Reporting that as a hook failure would be noise at best.
    copilot_hooks.install_hooks("/tmp/port-file", hooks_directory=tmp_path)

    handler = _document(tmp_path)["hooks"]["notification"][0]
    for key in ("command", "bash", "powershell"):
        assert handler[key].rstrip().endswith("exit 0"), key


def test_both_shells_are_written_on_every_platform(tmp_path) -> None:
    """`command` is the cross-platform fallback Copilot copies into whichever
    shell it runs; `bash` and `powershell` take precedence per platform. This
    one file is read wherever Copilot runs, not only where it was installed,
    so all three are written on every platform — a sh one-liner handed to
    PowerShell is a syntax error, not a failed request.
    """
    copilot_hooks.install_hooks("/tmp/port-file", hooks_directory=tmp_path)

    handler = _document(tmp_path)["hooks"]["notification"][0]
    assert handler["bash"] == handler["command"]
    assert handler["bash"].startswith("PORT=$(cat /tmp/port-file 2>/dev/null); ")
    # `curl` alone is a PowerShell alias for Invoke-WebRequest; `@` starts a splat.
    assert handler["powershell"].startswith(
        "$PORT = Get-Content -ErrorAction SilentlyContinue '/tmp/port-file'; "
    )
    assert "& ($env:SystemRoot + '\\System32\\curl.exe') -fsS -m 2 -o NUL -X POST" in handler["powershell"]
    assert "--data-binary '@-'" in handler["powershell"]
    assert "/hooks/copilot" in handler["powershell"]


def test_the_command_reads_the_port_at_fire_time(tmp_path) -> None:
    # The backend's port changes across restarts, so the installed command
    # must not bake one in.
    copilot_hooks.install_hooks("/var/run/navide.port", hooks_directory=tmp_path)

    handler = _document(tmp_path)["hooks"]["notification"][0]
    for key in ("command", "bash", "powershell"):
        assert "/var/run/navide.port" in handler[key], key
        assert "$PORT" in handler[key], key


def test_reinstalling_overwrites_rather_than_accumulates(tmp_path) -> None:
    copilot_hooks.install_hooks("/tmp/port-a", hooks_directory=tmp_path)
    copilot_hooks.install_hooks("/tmp/port-b", hooks_directory=tmp_path)

    doc = _document(tmp_path)
    assert len(doc["hooks"]["notification"]) == 1
    assert "/tmp/port-b" in doc["hooks"]["notification"][0]["command"]
    assert list(tmp_path.glob("*.json")) == [tmp_path / "agent-team.json"]


def test_leaves_other_hook_files_in_the_directory_alone(tmp_path) -> None:
    theirs = tmp_path / "user-hook.json"
    theirs.write_text('{"version": 1, "hooks": {}}')

    copilot_hooks.install_hooks("/tmp/port-file", hooks_directory=tmp_path)

    assert theirs.read_text() == '{"version": 1, "hooks": {}}'


def test_skips_when_copilot_is_not_configured(tmp_path, monkeypatch) -> None:
    # Creating ~/.copilot/hooks would provision a config tree for a CLI the
    # user never installed.
    monkeypatch.setattr(copilot_hooks.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("COPILOT_HOME", raising=False)

    result = copilot_hooks.install_hooks("/tmp/port-file")

    assert result["installed"] is False
    assert result["reason"] == "copilot not configured"
    assert not (tmp_path / ".copilot").exists()


def test_uninstall_removes_only_our_hook_file(tmp_path) -> None:
    hooks = tmp_path / "hooks"
    hooks.mkdir()
    (hooks / "mine.json").write_text("{}")
    copilot_hooks.install_hooks("/tmp/port-file", hooks_directory=hooks)

    result = copilot_hooks.uninstall_hooks(hooks_directory=hooks)

    assert result["removed"] is True
    assert sorted(p.name for p in hooks.iterdir()) == ["mine.json"]
    assert copilot_hooks.uninstall_hooks(hooks_directory=hooks)["removed"] is False
