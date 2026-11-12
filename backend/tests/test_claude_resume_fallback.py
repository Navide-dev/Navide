"""A pane pinned to a claude account dir resumes inside that dir. When the
transcript is not reachable from there, `claude --resume` would only print
"No conversation found" and exit; the spawn starts a new conversation instead,
with a handoff prompt pointing at where the old transcript may be. Every other
launch must be left byte-for-byte as it was. Fake ids and tmp dirs only."""

from __future__ import annotations

from pathlib import Path

from agent_team_backend.cli_vendors.claude import (
    encode_claude_cwd,
    resume_fallback_command,
    session_exists_in,
)

SID = "00000000-0000-4000-8000-000000000001"
WS = "/Users/someone/work/proj"


def _dirs(tmp_path: Path) -> tuple[Path, Path]:
    config_projects = tmp_path / "config-dir" / "projects"
    real_projects = tmp_path / "home" / ".claude" / "projects"
    config_projects.mkdir(parents=True)
    real_projects.mkdir(parents=True)
    return config_projects, real_projects


def _fallback(command, tmp_path: Path):
    config_projects, real_projects = _dirs(tmp_path)
    return resume_fallback_command(
        command,
        workspace_path=WS,
        config_projects=config_projects,
        real_projects=real_projects,
    )


def test_session_exists_in_scans_every_project(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    (root / "other-project").mkdir(parents=True)
    assert not session_exists_in(root, SID)
    (root / "other-project" / f"{SID}.jsonl").write_text("{}\n", encoding="utf-8")
    assert session_exists_in(root, SID)
    assert not session_exists_in(tmp_path / "missing", SID)
    assert not session_exists_in(root, "../other-project/" + SID)


def test_a_fresh_launch_is_untouched(tmp_path: Path) -> None:
    command = "claude --dangerously-skip-permissions"
    assert _fallback(command, tmp_path) == (command, "")


def test_a_wrapped_fresh_launch_is_untouched(tmp_path: Path) -> None:
    command = ["/bin/zsh", "-ilc", "claude --model opus"]
    assert _fallback(command, tmp_path) == (command, "")


def test_a_resume_the_config_dir_can_see_is_untouched(tmp_path: Path) -> None:
    config_projects, real_projects = _dirs(tmp_path)
    transcript = config_projects / encode_claude_cwd(WS) / f"{SID}.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text("{}\n", encoding="utf-8")
    command = f"claude --resume {SID} --model opus"
    assert resume_fallback_command(
        command,
        workspace_path=WS,
        config_projects=config_projects,
        real_projects=real_projects,
    ) == (command, "")


def test_a_missing_resume_starts_fresh_with_a_handoff_prompt(tmp_path: Path) -> None:
    command, fallback_id = _fallback(f"claude --resume {SID} --model opus", tmp_path)
    assert fallback_id == SID
    assert "--resume" not in command
    assert command.startswith("claude --model opus ")
    assert SID in command
    assert encode_claude_cwd(WS) in command
    assert "config-dir" in command


def test_a_wrapped_missing_resume_rewrites_only_the_cli_command(tmp_path: Path) -> None:
    command, fallback_id = _fallback(["/bin/zsh", "-ilc", f"claude --resume {SID}"], tmp_path)
    assert fallback_id == SID
    assert command[:2] == ["/bin/zsh", "-ilc"]
    assert "--resume" not in command[2]
    assert SID in command[2]


def test_the_handoff_prompt_is_one_shell_safe_argument(tmp_path: Path) -> None:
    command, _ = _fallback(f"claude --resume {SID}", tmp_path)
    prompt_arg = command[len("claude "):]
    for ch in "\n\r%!":
        assert ch not in prompt_arg


def test_an_unusual_resume_id_is_left_alone(tmp_path: Path) -> None:
    command = "claude --resume $(echo x)"
    assert _fallback(command, tmp_path) == (command, "")


def _account_vault(tmp_path: Path):
    from agent_team_backend.credential_vault import CredentialVault
    from tests.test_credential_vault import FakeSecurity

    (tmp_path / "home" / ".claude" / "projects").mkdir(parents=True)
    vault = CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=FakeSecurity(),
        platform="darwin",
    )
    vault.prepare_account_dir("p1")
    return vault


def test_spawn_check_leaves_a_fresh_pinned_launch_alone(tmp_path: Path) -> None:
    from agent_team_backend.ws_handlers import _claude_account_dir_check

    vault = _account_vault(tmp_path)
    command = "claude --dangerously-skip-permissions"
    assert _claude_account_dir_check(vault, "p1", command, WS) == (command, "", [])


def test_spawn_check_leaves_a_reachable_resume_alone(tmp_path: Path) -> None:
    """With the projects link in place the transcript in the real home is the
    one the CLI sees: a normal resume stays a resume, with no prompt."""
    from agent_team_backend.ws_handlers import _claude_account_dir_check

    vault = _account_vault(tmp_path)
    transcript = tmp_path / "home" / ".claude" / "projects" / encode_claude_cwd(WS) / f"{SID}.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text("{}\n", encoding="utf-8")
    command = f"claude --resume {SID}"
    assert _claude_account_dir_check(vault, "p1", command, WS) == (command, "", [])


def test_spawn_check_falls_back_only_for_a_missing_resume(tmp_path: Path) -> None:
    from agent_team_backend.ws_handlers import _claude_account_dir_check

    vault = _account_vault(tmp_path)
    command, fallback_id, unshared = _claude_account_dir_check(
        vault, "p1", f"claude --resume {SID}", WS
    )
    assert fallback_id == SID
    assert "--resume" not in command and "Navide:" in command
    assert unshared == []
