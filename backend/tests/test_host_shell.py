import asyncio
import os
import shlex
import shutil
import subprocess

import pytest

from agent_team_backend import host_shell, osplat
from agent_team_backend.host_shell import (
    HOST_SHELL_EXECUTABLE_ALLOWLIST,
    parse_allowlisted_command,
    parse_public_allowlisted_command,
    run_public_allowlisted_text,
    run_allowlisted_capped,
    run_allowlisted_text,
    validate_argv,
)


def test_allowlist_contains_git_and_issue_clis_only() -> None:
    assert HOST_SHELL_EXECUTABLE_ALLOWLIST == frozenset({"git", "gh", "glab"})


@pytest.mark.parametrize("argv", [["rm", "-rf", "."], ["/tmp/git", "status"], ["git\x00", "status"]])
def test_validate_argv_rejects_unapproved_or_path_qualified_executable(argv: list[str]) -> None:
    with pytest.raises(ValueError):
        validate_argv(argv)


def test_parse_command_rejects_shell_syntax() -> None:
    with pytest.raises(ValueError):
        parse_allowlisted_command("git status; rm -rf .")


@pytest.mark.parametrize(
    "command",
    [
        "git -c alias.pwn=!sh pwn",
        "git -c alias.pwn=!sh status",
        "git --config-env=credential.helper=TOKEN status",
        "git --config user.name=attacker status",
        "git --config-env credential.helper=TOKEN status",
        "git -C ../outside status",
        "git --git-dir=/tmp/repo status",
        "git --work-tree=/tmp/tree status",
        "git --exec-path=/tmp status",
        "git --exec-path /tmp status",
        "git fetch --upload-pack=/tmp/helper origin",
        "git fetch --upload-pack /tmp/helper origin",
        "git push --receive-pack=/tmp/helper origin",
        "git push --receive-pack /tmp/helper origin",
        "git credential fill",
        "git config user.email attacker@example.com",
        "git difftool",
        "git mergetool",
        "git filter-branch",
        "git hook run pre-commit",
        "git send-email patch.txt",
        "git submodule foreach sh -c true",
        "git bisect run ./script",
        "git rebase --exec ./script main",
        "git rebase -x ./script main",
        "git made-up-external-command",
        "git apply ../outside.patch",
        "git clone https://github.com/acme/repo.git /tmp/repo",
        "git init --template template victim",
        "git init --template=template victim",
        "git clone --template template https://example.com/repo.git victim",
        "git clone --template=template https://example.com/repo.git victim",
        'git clone --config protocol.ext.allow=always "ext::sh -c id" d',
        'git clone --config core.sshCommand=id ssh://x/y d',
        "git clone https://example.com/r.git z://../../../../tmp/out",
        "git worktree add a@b:../../etc/out",
        "git clone https://example.com/r.git a@b:../../etc/out",
        "git fetch ext::sh -c id",
        "git clone ext::sh -c id d",
        "git clone ssh://-oProxyCommand=id/x d",
        "git clone user@-oProxyCommand=id:repo d",
        "gh auth token",
        "gh browse",
        "gh issue view 1 --web",
        "gh alias set pwn 'api user'",
        "gh extension exec owner/tool",
        "gh extension install owner/tool",
        "gh config set pager cat",
        "gh repo clone owner/repo out",
        "gh repo fork owner/repo",
        "gh made-up-extension",
        "gh api --input /etc/passwd",
        "gh --repo owner/repo issue list",
        "gh --hostname github.example issue list",
        "glab auth status",
        "glab issue view 1 --web",
        "glab alias set pwn api",
        "glab token list",
        "glab extension install owner/tool",
        "glab config set host value",
        "glab repo clone owner/repo out",
        "glab made-up-extension",
        "glab api --input ../../secret.json",
        "glab --repo owner/repo issue list",
        "glab --hostname gitlab.example issue list",
    ],
)
def test_public_allowlist_rejects_execution_and_credential_escape_hatches(command: str) -> None:
    with pytest.raises(ValueError):
        parse_public_allowlisted_command(command)


@pytest.mark.parametrize(
    "command",
    [
        "git status --short",
        "git --no-pager log -5 --oneline",
        "git diff --stat",
        "git branch --show-current",
        "git fetch origin",
        "git pull --ff-only",
        "git push origin HEAD",
        "gh issue list --limit 10",
        "gh pr view 123",
        "glab issue list",
        "glab mr view 123",
    ],
)
def test_public_allowlist_accepts_supported_git_and_provider_commands(command: str) -> None:
    assert parse_public_allowlisted_command(command)[0] in HOST_SHELL_EXECUTABLE_ALLOWLIST


def test_public_allowlist_applies_workspace_containment_only_to_path_operands(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    accepted = parse_public_allowlisted_command(
        "git clone https://example.com/repo.git child",
        cwd=str(workspace),
        workspace_root=str(workspace),
    )
    assert accepted[-1] == "child"

    with pytest.raises(ValueError):
        parse_public_allowlisted_command(
            "git clone https://example.com/repo.git ../outside",
            cwd=str(workspace),
            workspace_root=str(workspace),
        )


def test_public_allowlist_classifies_scp_remotes_without_a_user(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    accepted = parse_public_allowlisted_command(
        "git clone git.example.com:team/repo child",
        cwd=str(workspace),
        workspace_root=str(workspace),
    )
    assert accepted[-1] == "child"

    with pytest.raises(ValueError):
        parse_public_allowlisted_command(
            "git clone git.example.com:team/repo git.example.com:../../outside",
            cwd=str(workspace),
            workspace_root=str(workspace),
        )


@pytest.mark.parametrize(
    "command",
    [
        "git init ../outside",
        "git commit -- ../outside",
        "git stash push -- ../outside",
        "git log -- ../outside",
        "git fetch https://example.com/repo.git ../outside",
        "git push https://example.com/repo.git ../outside",
        "git worktree add child ../outside",
    ],
)
def test_public_allowlist_contains_all_git_path_operands(tmp_path, command: str) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    with pytest.raises(ValueError):
        parse_public_allowlisted_command(
            command,
            cwd=str(workspace),
            workspace_root=str(workspace),
        )


def test_public_allowlist_rejects_a_cwd_outside_the_workspace(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    with pytest.raises(ValueError):
        parse_public_allowlisted_command(
            "git status",
            cwd=str(outside),
            workspace_root=str(workspace),
        )


@pytest.mark.parametrize(
    "config_text",
    [
        "[core]\nfsmonitor = ./probe\n",
        "[core]\nfsmonitor ./probe\n",
        "[core]\nhooksPath = ./hooks\n",
        "[diff]\nexternal = ./probe\n",
        "[core]\nsshCommand = id\n",
        "[core]\npager = ./probe\n",
        "[core]\naskPass = ./probe\n",
        "[remote \"origin\"]\nvcs = ext\n",
        "[remote \"origin\"]\nuploadpack = ./probe\n",
        "[remote \"origin\"]\nurl = ext::sh -c id\n",
        "[filter \"probe\"]\nprocess = ./probe\n",
        "[diff \"probe\"]\ntextconv = ./probe\n",
        "[diff \"probe\"]\ncommand = printf probe\n",
        "[pager]\nstatus = ./probe\n",
        "[gpg]\nprogram = ./probe\n",
        "[commit]\ngpgSign = true\n",
        "[credential]\nhelper = ./probe\n",
        "[include]\npath = ./included-config\n",
        "[core]\nalternateRefsCommand = printf probe\n",
        "[gc]\nrecentObjectsHook = printf probe\n",
        "[init]\ntemplateDir = ./template\n",
        "[push]\ngpgSign = true\n",
        "[remote \"origin\"]\nproxy = http://proxy.example\n",
    ],
)
@pytest.mark.asyncio
async def test_public_git_rejects_external_program_settings_before_spawn(
    tmp_path, monkeypatch, config_text: str
) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    (repo / ".git" / "config").write_text(config_text, encoding="utf-8")
    spawned = False

    async def fake_run(*args, **kwargs):
        nonlocal spawned
        spawned = True
        return 0, "", ""

    monkeypatch.setattr("agent_team_backend.host_shell.run_allowlisted_text", fake_run)

    rc, stdout, stderr = await run_public_allowlisted_text(["git", "status"], str(repo))

    assert rc == 126
    assert stdout == ""
    assert "public shell policy" in stderr
    assert spawned is False


@pytest.mark.asyncio
async def test_public_git_rejects_worktree_config_external_program_settings_before_spawn(
    tmp_path, monkeypatch
) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    (repo / ".git" / "config").write_text("[extensions]\nworktreeConfig = true\n", encoding="utf-8")
    (repo / ".git" / "config.worktree").write_text("[core]\nfsmonitor ./probe\n", encoding="utf-8")
    spawned = False

    async def fake_run(*args, **kwargs):
        nonlocal spawned
        spawned = True
        return 0, "", ""

    monkeypatch.setattr("agent_team_backend.host_shell.run_allowlisted_text", fake_run)

    rc, stdout, stderr = await run_public_allowlisted_text(["git", "status"], str(repo))

    assert rc == 126
    assert stdout == ""
    assert "public shell policy" in stderr
    assert spawned is False


@pytest.mark.asyncio
async def test_public_git_diff_driver_command_is_rejected_before_spawn(tmp_path) -> None:
    """A configured diff driver command must never reach Git's shell hook."""
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True, text=True)
    (repo / ".gitattributes").write_text("probe.txt diff=probe\n", encoding="utf-8")
    (repo / "probe.txt").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True, capture_output=True, text=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "-c",
            "user.name=Navide Test",
            "-c",
            "user.email=navide-test@example.invalid",
            "commit",
            "-m",
            "fixture",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    (repo / "probe.txt").write_text("after\n", encoding="utf-8")
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "config",
            "diff.probe.command",
            "printf NAVIDE_DIFF_DRIVER_PROBE",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    rc, stdout, stderr = await run_public_allowlisted_text(["git", "diff"], str(repo))

    assert rc == 126
    assert stdout == ""
    assert "NAVIDE_DIFF_DRIVER_PROBE" not in stderr
    assert "public shell policy" in stderr


#: The fake-CLI harness writes `#!/bin/sh` scripts found by bare name. Ask the
#: seam whether it would ever pick such a file up: on Windows
#: `executable_candidates("gh")` is `gh.com`, `gh.exe`, ... — never `gh` —
#: so no launcher written next to the script could be found, and the same is
#: true here when the seam is swapped (`-p tests.osplat_win_swap`).
_BARE_NAME_IS_RUNNABLE = osplat.paths.executable_candidates("gh") == ["gh"]
_GIT_ON_HOST = osplat.paths.resolve_program("git") is not None


def _write_fake_cli(bin_dir, name: str, script: str):
    if not _BARE_NAME_IS_RUNNABLE:
        pytest.skip("fake-CLI harness is a /bin/sh script exec'd by bare name")
    executable = bin_dir / name
    executable.write_text(f"#!/bin/sh\nset -eu\n{script}\n", encoding="utf-8")
    executable.chmod(0o755)
    return executable


def _init_repo_with_origin(repo, remote_url: str) -> None:
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "-C", str(repo), "remote", "add", "origin", remote_url],
        check=True,
        capture_output=True,
        text=True,
    )


def test_glab_config_path_matches_platform_default(tmp_path, monkeypatch) -> None:
    # The code under test reads the home from `paths.home_env_var()` and
    # derives the config dir from `paths.config_home()`; ask the same seam
    # for both rather than branching on `os.name` here, so the test still
    # agrees with the code when the seam is swapped to another platform's
    # implementation (`-p tests.osplat_win_swap`).
    home = tmp_path / "home"
    monkeypatch.setenv(osplat.paths.home_env_var(), str(home))
    monkeypatch.delenv("GLAB_CONFIG_DIR", raising=False)
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.delenv("APPDATA", raising=False)
    expected_home = osplat.paths.config_home(home)

    assert host_shell._provider_config_path("glab") == expected_home / "glab-cli" / "config.yml"


@pytest.mark.asyncio
async def test_public_gh_runner_projects_auth_only_config_and_redacts_secrets(
    tmp_path, monkeypatch
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    source_config = tmp_path / "source-gh"
    source_config.mkdir()
    (source_config / "hosts.yml").write_text(
        "github.com:\n"
        "  user: fixture-user\n"
        "  users:\n"
        "    fixture-user:\n"
        "      oauth_token: gh-secret-fixture\n"
        "  git_protocol: ssh\n"
        "  alias_marker: GH_ALIAS_SHOULD_NOT_COPY\n"
        "enterprise.example:\n"
        "  user: other-user\n"
        "  oauth_token: other-host-secret\n",
        encoding="utf-8",
    )
    repo = tmp_path / "repo"
    _init_repo_with_origin(repo, "https://github.com/acme/repo.git")
    _write_fake_cli(
        bin_dir,
        "gh",
        "if grep -Fq 'gh-secret-fixture' \"$GH_CONFIG_DIR/hosts.yml\"; then echo GH_AUTH_CONFIG_PRESENT; fi\n"
        "if grep -Fq 'GH_ALIAS_SHOULD_NOT_COPY' \"$GH_CONFIG_DIR/hosts.yml\"; then echo GH_UNSAFE_CONFIG_PRESENT; fi\n"
        "if grep -Fq 'git_protocol:' \"$GH_CONFIG_DIR/hosts.yml\"; then echo GH_NON_AUTH_CONFIG_PRESENT; fi\n"
        "if grep -Fq 'users:' \"$GH_CONFIG_DIR/hosts.yml\"; then echo GH_NESTED_USERS_PRESENT; fi\n"
        "if grep -Fq 'other-host-secret' \"$GH_CONFIG_DIR/hosts.yml\"; then echo GH_OTHER_HOST_PRESENT; fi\n"
        "if [ \"$GIT_DIR\" != \"$(pwd)/.git\" ]; then echo GH_GIT_CONTEXT_ISOLATED; fi\n"
        "if grep -Fq 'url = https://github.com/acme/repo.git' \"$GIT_DIR/config\"; then echo GH_REMOTE_CONTEXT_BOUND; fi\n"
        "if [ \"$GH_CONFIG_DIR\" != \"${GH_SOURCE_CONFIG-}\" ]; then echo GH_CONFIG_ISOLATED; fi\n"
        "if [ -z \"${GIT_CONFIG_PARAMETERS-}\" ]; then echo GIT_CONFIG_PARAMETERS_ABSENT; fi\n"
        "if [ -z \"${GIT_EXTERNAL_DIFF-}\" ]; then echo GIT_EXTERNAL_DIFF_ABSENT; fi\n"
        "if [ -z \"${GIT_SSH_COMMAND-}\" ]; then echo GIT_SSH_COMMAND_ABSENT; fi\n"
        "if [ -z \"${BROWSER-}\" ]; then echo BROWSER_ABSENT; fi\n"
        "if [ -z \"${GH_BROWSER-}\" ]; then echo GH_BROWSER_ABSENT; fi\n"
        "printf '%s\\n' 'gh-secret-fixture' >&2\n",
    )
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    monkeypatch.setenv("GH_CONFIG_DIR", str(source_config))
    monkeypatch.setenv("GH_SOURCE_CONFIG", str(source_config))
    monkeypatch.setenv("GIT_CONFIG_PARAMETERS", "fixture-danger")
    monkeypatch.setenv("GIT_EXTERNAL_DIFF", "fixture-danger")
    monkeypatch.setenv("GIT_SSH_COMMAND", "fixture-danger")
    monkeypatch.setenv("BROWSER", "fixture-danger")
    monkeypatch.setenv("GH_BROWSER", "fixture-danger")

    rc, stdout, stderr = await run_public_allowlisted_text(["gh", "issue", "list"], str(repo))

    assert rc == 0
    assert "GH_AUTH_CONFIG_PRESENT" in stdout
    assert "GH_CONFIG_ISOLATED" in stdout
    assert "GH_UNSAFE_CONFIG_PRESENT" not in stdout
    assert "GH_NON_AUTH_CONFIG_PRESENT" not in stdout
    assert "GH_NESTED_USERS_PRESENT" not in stdout
    assert "GH_OTHER_HOST_PRESENT" not in stdout
    assert "GH_GIT_CONTEXT_ISOLATED" in stdout
    assert "GH_REMOTE_CONTEXT_BOUND" in stdout
    assert "GIT_CONFIG_PARAMETERS_ABSENT" in stdout
    assert "GIT_EXTERNAL_DIFF_ABSENT" in stdout
    assert "GIT_SSH_COMMAND_ABSENT" in stdout
    assert "BROWSER_ABSENT" in stdout
    assert "GH_BROWSER_ABSENT" in stdout
    assert "gh-secret-fixture" not in stdout
    assert "gh-secret-fixture" not in stderr
    assert "[redacted]" in stderr


@pytest.mark.asyncio
async def test_public_gh_fails_closed_after_remote_is_rebound_to_another_host(
    tmp_path, monkeypatch
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_fake_cli(
        bin_dir,
        "gh",
        "if [ -n \"${GH_TOKEN-}\" ]; then echo GH_TOKEN_VISIBLE; fi\n"
        "if grep -Fq 'gh-secret-fixture' \"$GH_CONFIG_DIR/hosts.yml\"; then echo GH_CONFIG_VISIBLE; fi\n"
        "touch \"$GH_MARKER\"",
    )
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "-C", str(repo), "remote", "add", "origin", "https://github.com/acme/repo.git"],
        check=True,
        capture_output=True,
        text=True,
    )
    source_config = tmp_path / "source-gh"
    source_config.mkdir()
    (source_config / "hosts.yml").write_text(
        "github.com:\n  user: fixture-user\n  oauth_token: gh-secret-fixture\n",
        encoding="utf-8",
    )
    marker = tmp_path / "gh-spawned"
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    monkeypatch.setenv("GH_CONFIG_DIR", str(source_config))
    monkeypatch.setenv("GH_TOKEN", "gh-token-fixture")
    monkeypatch.setenv("GH_MARKER", str(marker))

    rc, stdout, stderr = await run_public_allowlisted_text(
        ["git", "remote", "set-url", "origin", "https://attacker.example/acme/repo.git"],
        str(repo),
    )
    assert (rc, stdout, stderr) == (0, "", "")

    rc, stdout, stderr = await run_public_allowlisted_text(["gh", "issue", "list"], str(repo))

    assert rc == 126
    assert stdout == ""
    assert "public shell policy" in stderr
    assert not marker.exists()


@pytest.mark.asyncio
async def test_public_gh_fails_closed_when_enterprise_host_is_not_bound(
    tmp_path, monkeypatch
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    marker = tmp_path / "gh-spawned"
    _write_fake_cli(
        bin_dir,
        "gh",
        "if [ -n \"${GH_ENTERPRISE_TOKEN-}\" ]; then echo GH_ENTERPRISE_TOKEN_VISIBLE; fi\n"
        "touch \"$GH_MARKER\"",
    )
    repo = tmp_path / "repo"
    _init_repo_with_origin(repo, "https://enterprise.example/acme/repo.git")
    empty_config = tmp_path / "empty-gh"
    empty_config.mkdir()
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    monkeypatch.setenv("GH_CONFIG_DIR", str(empty_config))
    monkeypatch.setenv("GH_HOST", "different.example")
    monkeypatch.setenv("GH_ENTERPRISE_TOKEN", "gh-enterprise-secret-fixture")
    monkeypatch.setenv("GH_MARKER", str(marker))

    rc, stdout, stderr = await run_public_allowlisted_text(["gh", "issue", "list"], str(repo))

    assert rc == 126
    assert stdout == ""
    assert "GH_ENTERPRISE_TOKEN_VISIBLE" not in stderr
    assert "public shell policy" in stderr
    assert not marker.exists()


@pytest.mark.asyncio
async def test_public_gh_projects_enterprise_auth_only_for_matching_host(tmp_path, monkeypatch) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_fake_cli(
        bin_dir,
        "gh",
        "if [ \"${GH_HOST-}\" = 'enterprise.example' ]; then echo GH_HOST_BOUND; fi\n"
        "if [ \"${GH_ENTERPRISE_TOKEN-}\" = 'gh-enterprise-secret-fixture' ]; then echo GH_ENTERPRISE_AUTH_PRESENT; fi\n"
        "if [ -n \"${GH_TOKEN-}\" ] || [ -n \"${GITHUB_TOKEN-}\" ]; then echo GH_PUBLIC_TOKEN_PRESENT; fi",
    )
    repo = tmp_path / "repo"
    _init_repo_with_origin(repo, "https://enterprise.example/acme/repo.git")
    source_config = tmp_path / "source-gh"
    source_config.mkdir()
    (source_config / "hosts.yml").write_text(
        "enterprise.example:\n"
        "  user: fixture-user\n"
        "  oauth_token: gh-config-secret-fixture\n"
        "other.example:\n"
        "  oauth_token: gh-other-host-secret\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    monkeypatch.setenv("GH_CONFIG_DIR", str(source_config))
    monkeypatch.setenv("GH_HOST", "enterprise.example")
    monkeypatch.setenv("GH_ENTERPRISE_TOKEN", "gh-enterprise-secret-fixture")
    monkeypatch.setenv("GH_TOKEN", "gh-public-secret-must-not-project")
    monkeypatch.setenv("GITHUB_TOKEN", "github-public-secret-must-not-project")

    rc, stdout, stderr = await run_public_allowlisted_text(["gh", "issue", "list"], str(repo))

    assert rc == 0
    assert "GH_HOST_BOUND" in stdout
    assert "GH_ENTERPRISE_AUTH_PRESENT" in stdout
    assert "GH_PUBLIC_TOKEN_PRESENT" not in stdout
    assert "gh-enterprise-secret-fixture" not in stdout
    assert "gh-enterprise-secret-fixture" not in stderr
    assert "gh-config-secret-fixture" not in stdout
    assert "gh-config-secret-fixture" not in stderr
    assert "gh-other-host-secret" not in stdout
    assert "gh-other-host-secret" not in stderr


@pytest.mark.asyncio
async def test_public_glab_fails_closed_after_remote_is_rebound_to_another_host(
    tmp_path, monkeypatch
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_fake_cli(
        bin_dir,
        "glab",
        "if [ -n \"${GITLAB_TOKEN-}\" ]; then echo GLAB_TOKEN_VISIBLE; fi\n"
        "touch \"$GLAB_MARKER\"",
    )
    repo = tmp_path / "repo"
    _init_repo_with_origin(repo, "https://gitlab.com/acme/repo.git")
    source_config = tmp_path / "source-glab"
    source_config.mkdir()
    (source_config / "config.yml").write_text(
        "hosts:\n  gitlab.com:\n    token: glab-secret-fixture\n", encoding="utf-8"
    )
    marker = tmp_path / "glab-spawned"
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    monkeypatch.setenv("GLAB_CONFIG_DIR", str(source_config))
    monkeypatch.setenv("GITLAB_TOKEN", "glab-env-secret-fixture")
    monkeypatch.setenv("GLAB_MARKER", str(marker))

    rc, stdout, stderr = await run_public_allowlisted_text(
        ["git", "remote", "set-url", "origin", "https://attacker.example/acme/repo.git"],
        str(repo),
    )
    assert (rc, stdout, stderr) == (0, "", "")

    rc, stdout, stderr = await run_public_allowlisted_text(["glab", "issue", "list"], str(repo))

    assert rc == 126
    assert stdout == ""
    assert "GLAB_TOKEN_VISIBLE" not in stderr
    assert "public shell policy" in stderr
    assert not marker.exists()


@pytest.mark.asyncio
async def test_public_glab_accepts_a_matching_self_managed_host(tmp_path, monkeypatch) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_fake_cli(
        bin_dir,
        "glab",
        "if grep -Fq 'glab-secret-fixture' \"$GLAB_CONFIG_DIR/config.yml\"; then echo GLAB_AUTH_PRESENT; fi\n"
        "if [ \"$GIT_DIR\" != \"$(pwd)/.git\" ]; then echo GLAB_GIT_CONTEXT_ISOLATED; fi",
    )
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "-C", str(repo), "remote", "add", "origin", "https://code.example.com/acme/repo.git"],
        check=True,
        capture_output=True,
        text=True,
    )
    source_config = tmp_path / "source-glab"
    source_config.mkdir()
    (source_config / "config.yml").write_text(
        "hosts:\n  code.example.com:\n    token: glab-secret-fixture\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    monkeypatch.setenv("GLAB_CONFIG_DIR", str(source_config))

    rc, stdout, stderr = await run_public_allowlisted_text(["glab", "issue", "list"], str(repo))

    assert rc == 0
    assert "GLAB_AUTH_PRESENT" in stdout
    assert "GLAB_GIT_CONTEXT_ISOLATED" in stdout
    assert stderr == ""


@pytest.mark.asyncio
async def test_public_glab_keeps_env_tokens_out_when_config_host_matches_but_env_host_does_not(
    tmp_path, monkeypatch
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_fake_cli(
        bin_dir,
        "glab",
        "if grep -Fq 'glab-config-secret-fixture' \"$GLAB_CONFIG_DIR/config.yml\"; then echo GLAB_AUTH_CONFIG_PRESENT; fi\n"
        "if [ -n \"${GITLAB_TOKEN-}\" ] || [ -n \"${GITLAB_ACCESS_TOKEN-}\" ] || [ -n \"${OAUTH_TOKEN-}\" ]; then echo GLAB_CROSS_HOST_TOKEN_VISIBLE; fi",
    )
    repo = tmp_path / "repo"
    _init_repo_with_origin(repo, "https://code.example.com/acme/repo.git")
    source_config = tmp_path / "source-glab"
    source_config.mkdir()
    (source_config / "config.yml").write_text(
        "hosts:\n  code.example.com:\n    token: glab-config-secret-fixture\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    monkeypatch.setenv("GLAB_CONFIG_DIR", str(source_config))
    monkeypatch.setenv("GITLAB_HOST", "different.example")
    monkeypatch.setenv("GITLAB_TOKEN", "glab-cross-host-secret-fixture")

    rc, stdout, stderr = await run_public_allowlisted_text(["glab", "issue", "list"], str(repo))

    assert rc == 0
    assert "GLAB_AUTH_CONFIG_PRESENT" in stdout
    assert "GLAB_CROSS_HOST_TOKEN_VISIBLE" not in stdout
    assert "glab-cross-host-secret-fixture" not in stdout
    assert "glab-cross-host-secret-fixture" not in stderr
    assert stderr == ""


@pytest.mark.asyncio
async def test_public_glab_runner_projects_auth_only_config_and_hides_repo_local_config(
    tmp_path, monkeypatch
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    source_config = tmp_path / "source-glab"
    source_config.mkdir()
    (source_config / "config.yml").write_text(
        "hosts:\n"
        "  gitlab.com:\n"
        "    token: glab-secret-fixture\n"
        "    user: fixture-user\n"
        "    use_keyring: \"true\"\n"
        "    is_oauth2: \"true\"\n"
        "    client_id: fixture-client\n"
        "    refresh_token: glab-refresh-secret-fixture\n"
        "    api_host: gitlab.com\n"
        "    alias_marker: GLAB_ALIAS_SHOULD_NOT_COPY\n"
        "  code.example.com:\n"
        "    token: GLAB_OTHER_HOST_SECRET\n",
        encoding="utf-8",
    )
    repo = tmp_path / "repo"
    git_dir = repo / ".git"
    git_dir.mkdir(parents=True)
    (git_dir / "config").write_text(
        '[remote "origin"]\nurl = https://gitlab-user:glab-remote-secret@gitlab.com/acme/repo.git\n',
        encoding="utf-8",
    )
    local_glab = git_dir / "glab-cli"
    local_glab.mkdir()
    (local_glab / "config.yml").write_text("local_marker: GLAB_LOCAL_SHOULD_NOT_COPY\n", encoding="utf-8")
    _write_fake_cli(
        bin_dir,
        "glab",
        "if grep -Fq 'glab-secret-fixture' \"$GLAB_CONFIG_DIR/config.yml\"; then echo GLAB_AUTH_CONFIG_PRESENT; fi\n"
        "if grep -Fq 'GLAB_OTHER_HOST_SECRET' \"$GLAB_CONFIG_DIR/config.yml\"; then echo GLAB_OTHER_HOST_PRESENT; fi\n"
        "if grep -Fq 'use_keyring:' \"$GLAB_CONFIG_DIR/config.yml\"; then echo GLAB_KEYRING_METADATA_PRESENT; fi\n"
        "if grep -Fq 'is_oauth2:' \"$GLAB_CONFIG_DIR/config.yml\"; then echo GLAB_OAUTH_METADATA_PRESENT; fi\n"
        "if grep -Fq 'client_id:' \"$GLAB_CONFIG_DIR/config.yml\"; then echo GLAB_CLIENT_ID_PRESENT; fi\n"
        "if grep -Fq 'refresh_token:' \"$GLAB_CONFIG_DIR/config.yml\"; then echo GLAB_REFRESH_METADATA_PRESENT; fi\n"
        "if grep -Fq 'GLAB_ALIAS_SHOULD_NOT_COPY' \"$GLAB_CONFIG_DIR/config.yml\"; then echo GLAB_UNSAFE_CONFIG_PRESENT; fi\n"
        "if grep -Fq 'api_host:' \"$GLAB_CONFIG_DIR/config.yml\"; then echo GLAB_NON_AUTH_CONFIG_PRESENT; fi\n"
        "if [ -f \"$GIT_DIR/glab-cli/config.yml\" ]; then echo GLAB_LOCAL_CONFIG_PRESENT; else echo GLAB_LOCAL_CONFIG_ABSENT; fi\n"
        "if [ \"$GIT_DIR\" != \"$(pwd)/.git\" ]; then echo GLAB_GIT_CONTEXT_ISOLATED; fi\n"
        "if grep -Fq 'url = https://gitlab.com/acme/repo.git' \"$GIT_DIR/config\"; then echo GLAB_REMOTE_CONTEXT_BOUND; fi\n"
        "if grep -Fq 'glab-remote-secret' \"$GIT_DIR/config\"; then echo GLAB_REMOTE_CREDENTIAL_PRESENT; else echo GLAB_REMOTE_CREDENTIAL_ABSENT; fi\n"
        "printf 'GLAB_CONFIG_PATH=%s\\n' \"$GLAB_CONFIG_DIR/config.yml\"\n"
        "printf 'GLAB_GIT_DIR=%s\\n' \"$GIT_DIR\"\n"
        "if [ -z \"${GIT_CONFIG_PARAMETERS-}\" ]; then echo GIT_CONFIG_PARAMETERS_ABSENT; fi\n"
        "if [ -z \"${GIT_EXTERNAL_DIFF-}\" ]; then echo GIT_EXTERNAL_DIFF_ABSENT; fi\n"
        "if [ -z \"${GIT_SSH_COMMAND-}\" ]; then echo GIT_SSH_COMMAND_ABSENT; fi\n"
        "if [ -z \"${BROWSER-}\" ]; then echo BROWSER_ABSENT; fi\n"
        "printf '%s\\n' 'glab-secret-fixture' >&2\n",
    )
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    monkeypatch.setenv("GLAB_CONFIG_DIR", str(source_config))
    monkeypatch.setenv("GIT_CONFIG_PARAMETERS", "fixture-danger")
    monkeypatch.setenv("GIT_EXTERNAL_DIFF", "fixture-danger")
    monkeypatch.setenv("GIT_SSH_COMMAND", "fixture-danger")
    monkeypatch.setenv("BROWSER", "fixture-danger")

    rc, stdout, stderr = await run_public_allowlisted_text(["glab", "issue", "list"], str(repo))

    assert rc == 0
    assert "GLAB_AUTH_CONFIG_PRESENT" in stdout
    assert "GLAB_OTHER_HOST_PRESENT" not in stdout
    assert "GLAB_KEYRING_METADATA_PRESENT" in stdout
    assert "GLAB_OAUTH_METADATA_PRESENT" in stdout
    assert "GLAB_CLIENT_ID_PRESENT" in stdout
    assert "GLAB_REFRESH_METADATA_PRESENT" in stdout
    assert "GLAB_LOCAL_CONFIG_ABSENT" in stdout
    assert "GLAB_GIT_CONTEXT_ISOLATED" in stdout
    assert "GLAB_REMOTE_CONTEXT_BOUND" in stdout
    assert "GLAB_REMOTE_CREDENTIAL_ABSENT" in stdout
    assert "GLAB_REMOTE_CREDENTIAL_PRESENT" not in stdout
    config_path = next(line.split("=", 1)[1] for line in stdout.splitlines() if line.startswith("GLAB_CONFIG_PATH="))
    git_dir_path = next(line.split("=", 1)[1] for line in stdout.splitlines() if line.startswith("GLAB_GIT_DIR="))
    assert not os.path.exists(config_path)
    assert not os.path.exists(git_dir_path)
    assert "GLAB_UNSAFE_CONFIG_PRESENT" not in stdout
    assert "GLAB_NON_AUTH_CONFIG_PRESENT" not in stdout
    assert "GIT_CONFIG_PARAMETERS_ABSENT" in stdout
    assert "GIT_EXTERNAL_DIFF_ABSENT" in stdout
    assert "GIT_SSH_COMMAND_ABSENT" in stdout
    assert "BROWSER_ABSENT" in stdout
    assert "glab-secret-fixture" not in stdout
    assert "glab-secret-fixture" not in stderr
    assert "glab-refresh-secret-fixture" not in stdout
    assert "glab-refresh-secret-fixture" not in stderr
    assert "[redacted]" in stderr


@pytest.mark.asyncio
async def test_public_provider_runner_projects_approved_token_environment(tmp_path, monkeypatch) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_fake_cli(
        bin_dir,
        "gh",
        "if [ \"${GH_TOKEN-}\" = 'gh-env-secret-fixture' ]; then echo GH_AUTH_ENV_PRESENT; fi\n"
        "printf '%s\\n' \"${GH_TOKEN-}\"",
    )
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    empty_config = tmp_path / "empty-gh"
    empty_config.mkdir()
    monkeypatch.setenv("GH_CONFIG_DIR", str(empty_config))
    monkeypatch.setenv("GH_TOKEN", "gh-env-secret-fixture")
    repo = tmp_path / "repo"
    _init_repo_with_origin(repo, "https://github.com/acme/repo.git")

    rc, stdout, stderr = await run_public_allowlisted_text(["gh", "issue", "list"], str(repo))

    assert rc == 0
    assert "GH_AUTH_ENV_PRESENT" in stdout
    assert "gh-env-secret-fixture" not in stdout
    assert stderr == ""


@pytest.mark.parametrize("env_name", ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"])
@pytest.mark.asyncio
async def test_public_glab_runner_projects_approved_token_environment(
    tmp_path, monkeypatch, env_name: str
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_fake_cli(
        bin_dir,
        "glab",
        f"if [ \"${{{env_name}-}}\" = 'glab-env-secret-fixture' ]; then echo GLAB_AUTH_ENV_PRESENT; fi\n"
        f"printf '%s\\n' \"${{{env_name}-}}\"",
    )
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "-C", str(repo), "remote", "add", "origin", "https://gitlab.com/acme/repo.git"],
        check=True,
        capture_output=True,
        text=True,
    )
    source_config = tmp_path / "empty-glab"
    source_config.mkdir()
    (source_config / "config.yml").write_text("hosts: {}\n", encoding="utf-8")
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    monkeypatch.setenv("GLAB_CONFIG_DIR", str(source_config))
    monkeypatch.setenv("GITLAB_HOST", "gitlab.com")
    for name in ("GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(env_name, "glab-env-secret-fixture")

    rc, stdout, stderr = await run_public_allowlisted_text(["glab", "issue", "list"], str(repo))

    assert rc == 0
    assert "GLAB_AUTH_ENV_PRESENT" in stdout
    assert "glab-env-secret-fixture" not in stdout
    assert stderr == ""


@pytest.mark.asyncio
async def test_public_glab_requires_a_validated_gitlab_origin(tmp_path, monkeypatch) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_fake_cli(bin_dir, "glab", "echo SHOULD_NOT_SPAWN")
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    source_config = tmp_path / "source-glab"
    source_config.mkdir()
    (source_config / "config.yml").write_text("hosts:\n  gitlab.com:\n    token: fixture\n", encoding="utf-8")
    monkeypatch.setenv("GLAB_CONFIG_DIR", str(source_config))

    rc, stdout, stderr = await run_public_allowlisted_text(["glab", "issue", "list"], str(tmp_path))

    assert rc == 126
    assert stdout == ""
    assert "SHOULD_NOT_SPAWN" not in stderr
    assert "public shell policy" in stderr


@pytest.mark.asyncio
async def test_public_glab_context_hides_local_config_from_installed_glab(tmp_path, monkeypatch) -> None:
    real_glab = shutil.which("glab")
    if real_glab is None:
        pytest.skip("glab CLI is not installed")
    if not _BARE_NAME_IS_RUNNABLE:
        pytest.skip("the glab wrapper is a /bin/sh script exec'd by bare name")

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    wrapper = bin_dir / "glab"
    wrapper.write_text(
        "#!/bin/sh\n"
        f"exec {shlex.quote(real_glab)} config get local_probe\n",
        encoding="utf-8",
    )
    wrapper.chmod(0o755)
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "-C", str(repo), "remote", "add", "origin", "https://gitlab.com/acme/repo.git"],
        check=True,
        capture_output=True,
        text=True,
    )
    local_glab = repo / ".git" / "glab-cli"
    local_glab.mkdir()
    (local_glab / "config.yml").write_text(
        "local_probe: GLAB_LOCAL_CONFIG_SHOULD_NOT_BE_SEEN\n", encoding="utf-8"
    )
    source_config = tmp_path / "source-glab"
    source_config.mkdir()
    (source_config / "config.yml").write_text("hosts: {}\n", encoding="utf-8")
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/opt/homebrew/bin:/usr/bin:/bin")
    monkeypatch.setenv("GLAB_CONFIG_DIR", str(source_config))

    rc, stdout, stderr = await run_public_allowlisted_text(["glab", "issue", "list"], str(repo))

    assert rc == 0
    assert "GLAB_LOCAL_CONFIG_SHOULD_NOT_BE_SEEN" not in stdout
    assert "GLAB_LOCAL_CONFIG_SHOULD_NOT_BE_SEEN" not in stderr


@pytest.mark.asyncio
async def test_public_glab_runner_disables_update_check_and_telemetry(tmp_path, monkeypatch) -> None:
    # Every public run gets a fresh isolated home, so glab never remembers its
    # last update check: left on, each call phones gitlab.com for a version
    # check and a telemetry event, which took 3-29s and hit the 15s timeout.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_fake_cli(
        bin_dir,
        "glab",
        "echo \"CHECK_UPDATE=${GLAB_CHECK_UPDATE-unset}\"\n"
        "echo \"SEND_TELEMETRY=${GLAB_SEND_TELEMETRY-unset}\"",
    )
    repo = tmp_path / "repo"
    _init_repo_with_origin(repo, "https://gitlab.com/acme/repo.git")
    source_config = tmp_path / "source-glab"
    source_config.mkdir()
    (source_config / "config.yml").write_text("hosts: {}\n", encoding="utf-8")
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    monkeypatch.setenv("GLAB_CONFIG_DIR", str(source_config))
    monkeypatch.setenv("GLAB_CHECK_UPDATE", "true")
    monkeypatch.setenv("GLAB_SEND_TELEMETRY", "true")

    rc, stdout, stderr = await run_public_allowlisted_text(["glab", "issue", "list"], str(repo))

    assert (rc, stderr) == (0, "")
    assert "CHECK_UPDATE=false" in stdout
    assert "SEND_TELEMETRY=false" in stdout


@pytest.mark.asyncio
async def test_public_runner_strips_execution_environment_and_injects_fixed_git_policy(
    tmp_path, monkeypatch
) -> None:
    captured: dict[str, object] = {}

    async def fake_run(args, cwd, *, timeout, input_text=None, env=None):
        captured.update(args=args, cwd=cwd, timeout=timeout, env=env)
        return 0, "ok", ""

    monkeypatch.setattr("agent_team_backend.host_shell.run_allowlisted_text", fake_run)
    monkeypatch.setenv("GIT_SSH_COMMAND", "id")
    monkeypatch.setenv("GIT_EXTERNAL_DIFF", "id")
    monkeypatch.setenv("GIT_CONFIG_PARAMETERS", "'core.fsmonitor'='id'")

    rc, stdout, stderr = await run_public_allowlisted_text(["git", "status"], str(tmp_path))

    assert (rc, stdout, stderr) == (0, "ok", "")
    args = captured["args"]
    assert isinstance(args, list)
    assert args[0] == "git"
    assert args[1:3] == ["-c", "core.fsmonitor=false"]
    assert "core.hooksPath" in " ".join(str(arg) for arg in args)
    env = captured["env"]
    assert isinstance(env, dict)
    assert env["GIT_CONFIG_NOSYSTEM"] == "1"
    assert env["GIT_CONFIG_GLOBAL"]
    assert "GIT_SSH_COMMAND" not in env
    assert "GIT_EXTERNAL_DIFF" not in env
    assert "GIT_CONFIG_PARAMETERS" not in env


@pytest.mark.asyncio
@pytest.mark.skipif(not _GIT_ON_HOST, reason="git is not resolvable through osplat.paths on this host")
async def test_git_runs_through_exec_broker() -> None:
    rc, stdout, stderr = await run_allowlisted_text(["git", "--version"])
    assert rc == 0
    assert stdout.startswith("git version")
    assert stderr == ""


@pytest.mark.asyncio
async def test_run_broker_returns_validation_failure_instead_of_raising() -> None:
    rc, stdout, stderr = await run_allowlisted_text(["rm", "-rf", "."])
    assert rc == 126
    assert stdout == ""
    assert "not allowlisted" in stderr


@pytest.mark.asyncio
async def test_an_allowlisted_name_resolves_to_a_windows_shim(monkeypatch) -> None:
    """`gh` from npm or scoop is a `gh.cmd`, and CreateProcess only ever
    appends `.exe` — so the shim used to be invisible and every call rc 127.

    The allowlist still guards the bare name: resolution happens after it, and
    never lets the caller name a path of its own."""
    from agent_team_backend.osplat import _windows

    argv: list[tuple] = []

    class VersionProc:
        returncode = 0

        async def communicate(self, *_a):
            return b"gh version 2.0.0\n", b""

    async def fake_exec(*a, **_k):
        argv.append(a)
        return VersionProc()

    monkeypatch.setattr(host_shell, "paths", _windows.paths)
    monkeypatch.setattr(
        _windows.paths, "resolve_program", lambda name, *, path=None: rf"C:\scoop\{name}.cmd"
    )
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    rc, stdout, _ = await run_allowlisted_text(["gh", "--version"])

    assert rc == 0 and stdout.startswith("gh version")
    assert argv[0] == ("cmd.exe", "/d", "/c", r"C:\scoop\gh.cmd", "--version")

    # The refusal is unchanged, and nothing is resolved or spawned for it.
    argv.clear()
    rc, _, stderr = await run_allowlisted_text(["rm", "-rf", "."])
    assert rc == 126 and "not allowlisted" in stderr and argv == []


@pytest.mark.asyncio
async def test_a_name_nothing_on_path_answers_to_reports_not_found(monkeypatch) -> None:
    """The same 127 an exec failure produced, so callers read it the same way."""
    monkeypatch.setattr(
        host_shell.paths, "resolve_program", lambda _name, *, path=None: None
    )

    rc, stdout, stderr = await run_allowlisted_text(["git", "--version"])

    assert (rc, stdout) == (127, "")
    assert "git not found" in stderr


# ── run_allowlisted_capped ────────────────────────────────────────────────────
# The capped runner exists so a caller that only shows the head of a command's
# output does not first buffer all of it. These pin the two halves that make it
# worth having: it really stops at the cap, and an uncapped-size run still
# behaves exactly like run_allowlisted.


def _repo_with_large_diff(path, line_count: int) -> None:
    """A repo whose HEAD diff is far larger than any cap used in these tests."""
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "t@t.com"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=path, check=True, capture_output=True)
    (path / "seed.txt").write_text("seed\n")
    subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=path, check=True, capture_output=True)
    (path / "big.txt").write_text("".join(f"line {i} {'x' * 60}\n" for i in range(line_count)))
    subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)


@pytest.mark.asyncio
@pytest.mark.skipif(not _GIT_ON_HOST, reason="git is not resolvable through osplat.paths on this host")
async def test_capped_run_stops_at_the_cap_and_reports_truncation(tmp_path) -> None:
    _repo_with_large_diff(tmp_path, 4000)
    rc, stdout, stderr, truncated = await run_allowlisted_capped(
        ["git", "diff", "HEAD"], str(tmp_path), max_stdout_bytes=30_000
    )
    assert truncated is True
    assert len(stdout) == 30_000
    assert stdout.startswith(b"diff --git")
    # rc is the kill signal, not a command failure - callers check truncated first.
    assert rc != 0
    assert stderr == b""


@pytest.mark.asyncio
@pytest.mark.skipif(not _GIT_ON_HOST, reason="git is not resolvable through osplat.paths on this host")
async def test_capped_run_returns_whole_output_below_the_cap(tmp_path) -> None:
    _repo_with_large_diff(tmp_path, 2)
    rc, stdout, stderr, truncated = await run_allowlisted_capped(
        ["git", "diff", "HEAD"], str(tmp_path), max_stdout_bytes=30_000
    )
    assert (rc, truncated, stderr) == (0, False, b"")
    assert b"line 1" in stdout
    assert len(stdout) < 30_000


@pytest.mark.asyncio
async def test_capped_run_reports_command_failure_with_stderr() -> None:
    rc, stdout, stderr, truncated = await run_allowlisted_capped(
        ["git", "rev-parse", "--verify", "no-such-ref-for-tests"],
        max_stdout_bytes=30_000,
    )
    assert truncated is False
    assert rc != 0
    assert stdout == b""


@pytest.mark.asyncio
async def test_capped_run_returns_validation_failure_instead_of_raising() -> None:
    rc, stdout, stderr, truncated = await run_allowlisted_capped(
        ["rm", "-rf", "."], max_stdout_bytes=30_000
    )
    assert (rc, stdout, truncated) == (126, b"", False)
    assert "not allowlisted" in stderr.decode()


@pytest.mark.asyncio
async def test_capped_read_drains_stderr_while_stdout_is_still_coming() -> None:
    """stderr must not wait for stdout to end.

    A child that fills its stderr pipe blocks, and a reader that only turns to
    stderr after stdout has ended would then wait on a process that can no
    longer write - a stall the cap itself cannot break. Driven through fake
    pipes because the allowlist (git/gh/glab) offers no command that floods
    stderr while stdout is still open.
    """
    order: list[str] = []

    class _Stdout:
        def __init__(self) -> None:
            self.remaining = 3

        async def read(self, _n: int) -> bytes:
            order.append("stdout")
            await asyncio.sleep(0)
            if self.remaining == 0:
                return b""
            self.remaining -= 1
            return b"x" * 10

    class _Stderr:
        async def read(self) -> bytes:
            order.append("stderr")
            await asyncio.sleep(0)
            return b"warning"

    class _Process:
        returncode = 0

        def __init__(self) -> None:
            self.stdout = _Stdout()
            self.stderr = _Stderr()

        async def wait(self) -> int:
            return 0

    rc, stdout, stderr, truncated = await host_shell._read_stdout_capped(_Process(), 30_000)

    assert (rc, stdout, stderr, truncated) == (0, b"x" * 30, b"warning", False)
    assert "stderr" in order
    assert order.index("stderr") < len(order) - 1
