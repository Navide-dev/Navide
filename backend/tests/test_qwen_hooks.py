"""Tests for the Qwen Code hook installer.

Qwen reuses Claude Code's settings.json hook schema, so the installer reuses
claude_hooks' merge machinery. These tests pin the two things that are Qwen's
own — the endpoint it posts to and the single event we install — plus the
non-negotiable property shared with Claude: the user's own hooks survive.
"""

from __future__ import annotations

import json

from agent_team_backend import qwen_hooks


def _hook_commands(settings: dict) -> list[str]:
    out: list[str] = []
    for entries in settings.get("hooks", {}).values():
        for entry in entries:
            for hook in entry.get("hooks", []):
                out.append(hook.get("command", ""))
    return out


def test_installs_a_notification_hook_pointing_at_the_qwen_endpoint(tmp_path) -> None:
    settings = tmp_path / "settings.json"

    result = qwen_hooks.install_hooks("/tmp/port-file", settings_file=settings)

    assert result["installed"] is True
    data = json.loads(settings.read_text())
    # PreToolUse is Navide Guard's hook, covered in tests/guard_hooks.
    assert list(data["hooks"]) == ["Notification", "PreToolUse"]
    command = _hook_commands(data)[0]
    assert "/hooks/qwen" in command
    assert "X-Agent-Team-Event: notification" in command
    assert "/tmp/port-file" in command


def test_reinstalling_does_not_stack_duplicate_entries(tmp_path) -> None:
    # install_hooks runs on every backend startup, so a non-idempotent merge
    # would grow the user's settings.json without bound.
    settings = tmp_path / "settings.json"

    qwen_hooks.install_hooks("/tmp/port-file", settings_file=settings)
    qwen_hooks.install_hooks("/tmp/port-file", settings_file=settings)
    qwen_hooks.install_hooks("/tmp/port-file", settings_file=settings)

    # One Notification hook plus Navide Guard's PreToolUse hook.
    assert len(_hook_commands(json.loads(settings.read_text()))) == 2


def test_keeps_hooks_the_user_wrote_themselves(tmp_path) -> None:
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({
        "hooks": {
            "Notification": [{"hooks": [{"type": "command", "command": "notify-send mine"}]}],
            "Stop": [{"hooks": [{"type": "command", "command": "echo done"}]}],
        },
        "theme": "dark",
    }))

    qwen_hooks.install_hooks("/tmp/port-file", settings_file=settings)

    data = json.loads(settings.read_text())
    commands = _hook_commands(data)
    assert "notify-send mine" in commands
    assert "echo done" in commands
    assert any("/hooks/qwen" in c for c in commands)
    # Unrelated settings are untouched.
    assert data["theme"] == "dark"


def test_refuses_to_write_over_settings_it_cannot_parse(tmp_path) -> None:
    # Qwen's settings.json descends from gemini-cli and tolerates `//`
    # comments, which json.loads does not. The shared reader reports an
    # unparseable file as an empty dict, so merging into it would replace the
    # user's models, auth and mcpServers with nothing but our hook.
    settings = tmp_path / "settings.json"
    original = '{\n  // which model to use\n  "model": "qwen3-coder-plus"\n}'
    settings.write_text(original)

    result = qwen_hooks.install_hooks("/tmp/port-file", settings_file=settings)

    assert result["installed"] is False
    assert result["reason"] == "settings.json unparseable"
    assert settings.read_text() == original


def test_backs_up_the_original_before_the_first_write(tmp_path) -> None:
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"theme": "dark"}))

    qwen_hooks.install_hooks("/tmp/port-file", settings_file=settings)

    backup = settings.with_suffix(settings.suffix + ".pre-agent-team.bak")
    assert backup.is_file()
    assert json.loads(backup.read_text()) == {"theme": "dark"}


def test_skips_when_qwen_is_not_configured(tmp_path, monkeypatch) -> None:
    # Writing settings.json would create ~/.qwen for a CLI the user never
    # installed. Only the default path is guarded — an explicit settings_file
    # is a caller's deliberate choice (and how these tests work).
    monkeypatch.setattr(qwen_hooks.Path, "home", staticmethod(lambda: tmp_path))
    # settings_path() prefers $QWEN_HOME, so a dev machine that sets it would
    # otherwise make this assertion test the wrong directory.
    monkeypatch.delenv("QWEN_HOME", raising=False)

    result = qwen_hooks.install_hooks("/tmp/port-file")

    assert result["installed"] is False
    assert result["reason"] == "qwen not configured"
    assert not (tmp_path / ".qwen").exists()


def test_uninstall_removes_only_our_hooks(tmp_path) -> None:
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({
        "hooks": {"Notification": [{"hooks": [{"type": "command", "command": "notify-send mine"}]}]},
        "theme": "dark",
    }))
    qwen_hooks.install_hooks("/tmp/port-file", settings_file=settings)

    result = qwen_hooks.uninstall_hooks(settings_file=settings)

    assert result["removed"] is True
    data = json.loads(settings.read_text())
    assert _hook_commands(data) == ["notify-send mine"]
    assert data["theme"] == "dark"


def test_uninstall_leaves_a_file_it_cannot_parse_alone(tmp_path) -> None:
    settings = tmp_path / "settings.json"
    original = '{\n  // which model to use\n  "model": "qwen3-coder-plus"\n}'
    settings.write_text(original)

    result = qwen_hooks.uninstall_hooks(settings_file=settings)

    assert result["removed"] is False
    assert settings.read_text() == original
