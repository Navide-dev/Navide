"""Host-owned execution broker for the small set of approved CLIs.

Git and the provider CLIs are intentionally executed here rather than from
feature services. The broker accepts argv, never a shell string, and rejects
path-qualified executables so callers cannot smuggle an alternate binary under
an allowlisted basename.
"""

from __future__ import annotations

import asyncio
import os
import re
import shlex
import tempfile
from pathlib import Path
from typing import Mapping, Sequence

import yaml

from .osplat import paths, secret_files, terminal_backend
from .git_security import (
    PublicRemoteTarget,
    assert_public_git_config_safe,
    is_public_remote_url,
    is_remote_helper_form,
    is_scp_remote_form,
    normalize_remote_host,
    public_remote_target,
)

HOST_SHELL_EXECUTABLE_ALLOWLIST = frozenset({"git", "gh", "glab"})
_SHELL_SYNTAX = re.compile(r"[;&|<>`\n\r]")
_PUBLIC_GIT_COMMANDS = frozenset(
    {
        "add",
        "am",
        "apply",
        "bisect",
        "blame",
        "branch",
        "checkout",
        "cherry-pick",
        "clean",
        "clone",
        "commit",
        "describe",
        "diff",
        "fetch",
        "for-each-ref",
        "init",
        "log",
        "ls-files",
        "merge",
        "mv",
        "pull",
        "push",
        "rebase",
        "reflog",
        "remote",
        "reset",
        "restore",
        "revert",
        "rev-list",
        "rev-parse",
        "show",
        "stash",
        "status",
        "submodule",
        "switch",
        "tag",
        "worktree",
    }
)
_PUBLIC_GH_COMMANDS = frozenset(
    {
        "api",
        "cache",
        "gist",
        "issue",
        "label",
        "pr",
        "release",
        "repo",
        "run",
        "search",
        "status",
        "variable",
        "workflow",
    }
)
_PUBLIC_GLAB_COMMANDS = frozenset(
    {
        "api",
        "ci",
        "deploy-key",
        "incident",
        "issue",
        "label",
        "milestone",
        "mr",
        "release",
        "repo",
        "schedule",
        "snippet",
        "variable",
    }
)
_PUBLIC_GIT_OVERRIDE_OPTIONS = (
    "--config",
    "--config-env",
    "--exec-path",
    "--git-dir",
    "--receive-pack",
    "--template",
    "--upload-pack",
    "--work-tree",
)

_PUBLIC_GIT_BOOLEAN_OPTIONS = frozenset(
    {
        "--all",
        "--ahead-behind",
        "--bare",
        "--branch",
        "--cached",
        "--check",
        "--column",
        "--decorate",
        "--delete",
        "--detach",
        "--dry-run",
        "--ff-only",
        "--follow",
        "--force",
        "--graph",
        "--ignored",
        "--literal-pathspecs",
        "--name-only",
        "--name-status",
        "--no-ahead-behind",
        "--no-edit",
        "--no-ff",
        "--no-rebase",
        "--no-renames",
        "--no-tags",
        "--no-track",
        "--no-verify",
        "--oneline",
        "--porcelain",
        "--prune",
        "--quiet",
        "--rebase",
        "--set-upstream",
        "--short",
        "--show-current",
        "--show-stash",
        "--staged",
        "--stat",
        "--summary",
        "--tags",
        "--track",
        "--untracked-files",
        "--verbose",
        "-A",
        "-u",
        "-v",
    }
)
_PUBLIC_GIT_VALUE_OPTIONS = frozenset(
    {
        "--author",
        "--branch",
        "--format",
        "--grep",
        "--max-count",
        "--message",
        "--since",
        "--strategy",
        "--until",
        "-b",
        "-m",
        "-n",
    }
)
_PUBLIC_GIT_PATH_VALUE_OPTIONS = frozenset({"--file"})
_PUBLIC_PROVIDER_FORBIDDEN_NESTED = frozenset(
    {"alias", "auth", "clone", "config", "exec", "extension", "fork", "helper", "ssh", "token"}
)
_PUBLIC_PROVIDER_SUBCOMMANDS = {
    "gh": {
        "issue": frozenset({"list", "view", "create", "comment"}),
        "pr": frozenset({"list", "view", "create", "comment"}),
        "repo": frozenset({"list", "view", "status"}),
        "run": frozenset({"list", "view"}),
    },
    "glab": {
        "issue": frozenset({"list", "view", "create", "note"}),
        "mr": frozenset({"list", "view"}),
        "repo": frozenset({"list", "view"}),
    },
}
_PUBLIC_PROVIDER_VALUE_OPTIONS = frozenset(
    {
        "--assignee",
        "--author",
        "--body",
        "--description",
        "--json",
        "--label",
        "--limit",
        "--message",
        "--milestone",
        "--output",
        "--per-page",
        "--search",
        "--state",
        "--title",
    }
)
_PUBLIC_PROVIDER_BOOLEAN_OPTIONS = frozenset({"--all", "--comments"})
_PUBLIC_GLAB_AUTH_ENV = ("GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN")
_PUBLIC_GLAB_AUTH_KEYS = frozenset(
    {
        "token",
        "job_token",
        "refresh_token",
        "oauth2_refresh_token",
        "oauth2_expiry_date",
        "is_oauth2",
        "use_keyring",
        "client_id",
        "user",
    }
)
_PUBLIC_SECRET_REPLACEMENT = "[redacted]"
_MAX_PROVIDER_CONFIG_BYTES = 1024 * 1024
# Read granularity for run_allowlisted_capped: large enough that a capped
# read finishes in a few awaits, small enough not to overshoot the cap much.
_CAPPED_READ_CHUNK = 64 * 1024


def validate_argv(args: Sequence[str]) -> list[str]:
    """Validate and copy an argv intended for the Host shell broker."""
    if not args or any(not isinstance(arg, str) or "\x00" in arg for arg in args):
        raise ValueError("command arguments must be non-empty strings")
    executable = args[0]
    if executable != Path(executable).name or executable not in HOST_SHELL_EXECUTABLE_ALLOWLIST:
        raise ValueError("executable is not allowlisted")
    return list(args)


def _launch_argv(argv: Sequence[str], env: Mapping[str, str] | None) -> list[str] | None:
    """`argv` resolved to a real file and wrapped in whatever starts it.

    The allowlist check above stays on the bare name — resolution happens
    after it, so it is still `gh` that is permitted and never a path the
    caller chose. What resolution adds is the extension: `gh` installed by
    npm or scoop on Windows is a `gh.cmd` shim, which `CreateProcess` only
    appends `.exe` for and therefore cannot see. None when nothing on PATH
    answers to the name, which the callers report the way a failed exec did.
    """
    program = paths.resolve_program(argv[0], path=(env or {}).get("PATH"))
    if not program:
        return None
    return paths.launch_argv(program, argv[1:])


def parse_allowlisted_command(command: str) -> list[str]:
    """Parse a display-oriented command without enabling shell syntax."""
    if not isinstance(command, str) or not command.strip() or _SHELL_SYNTAX.search(command):
        raise ValueError("command must be one allowlisted executable invocation")
    try:
        args = terminal_backend.parse_command(command)
    except (ValueError, OSError) as exc:
        raise ValueError("command quoting is invalid") from exc
    return validate_argv(args)


def _public_policy_error() -> ValueError:
    return ValueError("command is not permitted by the public shell policy")


def _option_matches(arg: str, option: str) -> bool:
    return arg == option or arg.startswith(f"{option}=")


def _public_command_index(args: Sequence[str], executable: str) -> int:
    """Return the command index after validated, safe global options."""
    index = 1
    while index < len(args):
        arg = args[index]
        if arg == "--":
            raise _public_policy_error()
        if executable == "git" and arg in {
            "--no-pager",
            "--paginate",
            "--no-replace-objects",
            "--literal-pathspecs",
        }:
            index += 1
            continue
        if arg.startswith("-"):
            if executable == "git" and (
                arg == "-c" or arg.startswith("-c") or arg == "-C" or arg.startswith("-C")
            ):
                raise _public_policy_error()
            if executable == "git" and any(_option_matches(arg, option) for option in _PUBLIC_GIT_OVERRIDE_OPTIONS):
                raise _public_policy_error()
            raise _public_policy_error()
        return index
    raise _public_policy_error()


def _public_command_name(args: Sequence[str]) -> str:
    """Return the top-level tool command after safe global options."""
    return args[_public_command_index(args, args[0])]


def _workspace_operand(value: str, workspace_root: str | None) -> None:
    """Require a path operand to resolve inside the public workspace."""
    if not value or "\x00" in value or "://" in value or is_remote_helper_form(value):
        raise _public_policy_error()
    if is_scp_remote_form(value):
        raise _public_policy_error()
    if workspace_root is None:
        if value.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:[\\/]", value):
            raise _public_policy_error()
        if ".." in re.split(r"[\\/]", value):
            raise _public_policy_error()
        return
    root = Path(workspace_root).resolve()
    target = Path(value).expanduser()
    if not target.is_absolute():
        target = root / target
    try:
        target.resolve().relative_to(root)
    except (OSError, ValueError) as exc:
        raise _public_policy_error() from exc


def _validate_public_cwd(cwd: str | None, workspace_root: str | None) -> None:
    if cwd is None:
        return
    if not isinstance(cwd, str) or not cwd or not workspace_root:
        raise _public_policy_error()
    try:
        root = Path(workspace_root).resolve()
        current = Path(cwd).resolve()
        if not root.is_dir() or not current.is_dir():
            raise _public_policy_error()
        current.relative_to(root)
    except (OSError, ValueError) as exc:
        raise _public_policy_error() from exc


def _validate_git_options(
    command: str,
    args: Sequence[str],
    workspace_root: str | None,
) -> list[str]:
    """Validate command options and return positional operands."""
    positionals: list[str] = []
    index = 0
    after_double_dash = False
    while index < len(args):
        arg = args[index]
        if after_double_dash:
            positionals.append(arg)
            index += 1
            continue
        if arg == "--":
            after_double_dash = True
            index += 1
            continue
        if not arg.startswith("-") or arg == "-":
            positionals.append(arg)
            index += 1
            continue
        name, separator, inline_value = arg.partition("=")
        if any(_option_matches(arg, option) for option in _PUBLIC_GIT_OVERRIDE_OPTIONS):
            raise _public_policy_error()
        if arg == "-c" or arg.startswith("-c") or arg == "-C" or arg.startswith("-C"):
            raise _public_policy_error()
        if command == "log" and re.fullmatch(r"-\d+", arg):
            index += 1
            continue
        if name in _PUBLIC_GIT_BOOLEAN_OPTIONS:
            if separator:
                raise _public_policy_error()
            index += 1
            continue
        if name in _PUBLIC_GIT_VALUE_OPTIONS or name in _PUBLIC_GIT_PATH_VALUE_OPTIONS:
            if separator:
                value = inline_value
            else:
                if index + 1 >= len(args):
                    raise _public_policy_error()
                value = args[index + 1]
                index += 1
            if name in _PUBLIC_GIT_PATH_VALUE_OPTIONS:
                _workspace_operand(value, workspace_root)
            elif not value or "\x00" in value:
                raise _public_policy_error()
            index += 1
            continue
        raise _public_policy_error()
    return positionals


def _validate_remote_operand(value: str, workspace_root: str | None) -> None:
    if is_remote_helper_form(value):
        raise _public_policy_error()
    if is_public_remote_url(value):
        return
    _workspace_operand(value, workspace_root)


def _validate_git_command(
    command: str,
    command_args: Sequence[str],
    workspace_root: str | None,
) -> None:
    positionals = _validate_git_options(command, command_args, workspace_root)
    if command == "clone":
        if len(positionals) not in {1, 2}:
            raise _public_policy_error()
        _validate_remote_operand(positionals[0], workspace_root)
        if len(positionals) == 2:
            _workspace_operand(positionals[1], workspace_root)
        return
    if command == "worktree":
        if not positionals or positionals[0] != "add" or len(positionals) < 2:
            raise _public_policy_error()
        _workspace_operand(positionals[1], workspace_root)
        for value in positionals[2:]:
            _workspace_operand(value, workspace_root)
        return
    if command == "remote":
        if not positionals:
            return
        subcommand = positionals[0]
        if subcommand in {"add", "set-url"}:
            if len(positionals) != 3:
                raise _public_policy_error()
            _workspace_operand(positionals[1], workspace_root)
            _validate_remote_operand(positionals[2], workspace_root)
            return
        for value in positionals:
            _workspace_operand(value, workspace_root)
        return
    if command in {"fetch", "pull", "push"} and positionals:
        first = positionals[0]
        if is_remote_helper_form(first):
            raise _public_policy_error()
        if not is_public_remote_url(first):
            _workspace_operand(first, workspace_root)
        for value in positionals[1:]:
            _workspace_operand(value, workspace_root)
        return
    if command == "init" and len(positionals) > 1:
        raise _public_policy_error()
    for value in positionals:
        _workspace_operand(value, workspace_root)


def _validate_provider_command(
    executable: str,
    command: str,
    command_args: Sequence[str],
    workspace_root: str | None,
) -> None:
    lowered = [value.lower() for value in command_args]
    if any(value in _PUBLIC_PROVIDER_FORBIDDEN_NESTED for value in lowered):
        raise _public_policy_error()
    if command == "api":
        if not command_args or any(value.startswith("-") for value in command_args):
            raise _public_policy_error()
        if any("://" in value or is_remote_helper_form(value) for value in command_args):
            raise _public_policy_error()
        return
    subcommands = _PUBLIC_PROVIDER_SUBCOMMANDS[executable].get(command)
    if subcommands is None:
        if command_args:
            raise _public_policy_error()
        return
    if not command_args or command_args[0] not in subcommands:
        raise _public_policy_error()
    index = 1
    while index < len(command_args):
        arg = command_args[index]
        if arg == "--":
            raise _public_policy_error()
        if not arg.startswith("-"):
            if "://" in arg or is_remote_helper_form(arg):
                raise _public_policy_error()
            index += 1
            continue
        name, separator, inline_value = arg.partition("=")
        if name == "--input" or name not in _PUBLIC_PROVIDER_VALUE_OPTIONS and name not in _PUBLIC_PROVIDER_BOOLEAN_OPTIONS:
            raise _public_policy_error()
        if name in _PUBLIC_PROVIDER_BOOLEAN_OPTIONS:
            if separator:
                raise _public_policy_error()
            index += 1
            continue
        if separator:
            value = inline_value
        else:
            if index + 1 >= len(command_args):
                raise _public_policy_error()
            value = command_args[index + 1]
            index += 1
        if not value or "\x00" in value:
            raise _public_policy_error()
        if name == "--output":
            _workspace_operand(value, workspace_root)
        index += 1


def validate_public_argv(
    args: Sequence[str],
    *,
    cwd: str | None = None,
    workspace_root: str | None = None,
) -> list[str]:
    """Validate an argv supplied by a Manifest v2 public ``shell.run`` call.

    Internal Git and Issues services use :func:`validate_argv`; this stricter
    policy exists only for commands authored by an installed plugin.
    """
    argv = validate_argv(args)
    executable = argv[0]
    root = workspace_root or cwd
    _validate_public_cwd(cwd, root)
    command_index = _public_command_index(argv, executable)
    command = argv[command_index]
    command_args = argv[command_index + 1 :]
    if executable == "git":
        if command not in _PUBLIC_GIT_COMMANDS:
            raise _public_policy_error()
        if command in {"credential", "config", "difftool", "filter-branch", "hook", "mergetool", "send-email"}:
            raise _public_policy_error()
        if command == "submodule" and (not command_args or command_args[0] != "status"):
            raise _public_policy_error()
        if command == "bisect" and command_args and command_args[0] == "run":
            raise _public_policy_error()
        _validate_git_command(command, command_args, root)
        return argv

    allowed = _PUBLIC_GH_COMMANDS if executable == "gh" else _PUBLIC_GLAB_COMMANDS
    if command not in allowed:
        raise _public_policy_error()
    _validate_provider_command(executable, command, command_args, root)
    return argv


def parse_public_allowlisted_command(
    command: str,
    *,
    cwd: str | None = None,
    workspace_root: str | None = None,
) -> list[str]:
    """Parse and validate one public plugin command without enabling a shell."""
    if not isinstance(command, str) or not command.strip() or _SHELL_SYNTAX.search(command):
        raise _public_policy_error()
    try:
        args = terminal_backend.parse_command(command)
    except (ValueError, OSError) as exc:
        raise _public_policy_error() from exc
    return validate_public_argv(args, cwd=cwd, workspace_root=workspace_root)


def _platform_config_home(home: Path | None, xdg_config_home: str | None) -> Path | None:
    if xdg_config_home:
        return Path(xdg_config_home).expanduser()
    if home is None:
        return None
    return paths.config_home(home)


def _provider_config_path(executable: str) -> Path | None:
    """Resolve the provider's existing auth config without exposing it."""
    source_env = os.environ
    home_value = source_env.get(paths.home_env_var())
    home = Path(home_value).expanduser() if home_value else None
    xdg_config_home = source_env.get("XDG_CONFIG_HOME")
    if executable == "gh":
        configured_dir = source_env.get("GH_CONFIG_DIR")
        if configured_dir:
            return Path(configured_dir).expanduser() / "hosts.yml"
        if xdg_config_home:
            return Path(xdg_config_home).expanduser() / "gh" / "hosts.yml"
        # gh is the one tool that names its Windows directory differently
        # (`%APPDATA%\GitHub CLI`) instead of following `config_home`.
        roaming = paths.roaming_app_data()
        if roaming is not None:
            return roaming.expanduser() / "GitHub CLI" / "hosts.yml"
        return home / ".config" / "gh" / "hosts.yml" if home else None

    configured_dir = source_env.get("GLAB_CONFIG_DIR")
    if configured_dir:
        return Path(configured_dir).expanduser() / "config.yml"
    legacy_home = home / ".config" if home else None
    if legacy_home:
        legacy_path = legacy_home / "glab-cli" / "config.yml"
        if legacy_path.is_file():
            return legacy_path
    config_home = _platform_config_home(home, xdg_config_home)
    return config_home / "glab-cli" / "config.yml" if config_home else None


def _read_provider_yaml(path: Path | None) -> dict:
    if path is None:
        return {}
    try:
        if not path.is_file() or path.stat().st_size > _MAX_PROVIDER_CONFIG_BYTES:
            return {}
        with path.open("r", encoding="utf-8") as stream:
            value = yaml.safe_load(stream)
    except (OSError, UnicodeError, yaml.YAMLError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_private_yaml(path: Path, value: dict) -> None:
    secret_files.make_private_dir(path.parent)
    serialized = yaml.safe_dump(value, default_flow_style=False, sort_keys=False)
    # Plain content: the provider CLI reads this projected config itself.
    secret_files.write_private_plain(path, serialized.encode("utf-8"))


def _project_gh_auth(
    config_path: Path, destination: Path, target_host: str
) -> tuple[set[str], bool]:
    source = _read_provider_yaml(config_path)
    secrets: set[str] = set()
    for host, record in source.items():
        if (
            not isinstance(host, str)
            or normalize_remote_host(host) != target_host
            or not isinstance(record, dict)
        ):
            continue
        auth: dict[str, str] = {}
        user = record.get("user")
        if isinstance(user, str) and user:
            auth["user"] = user
        token = record.get("oauth_token")
        users = record.get("users")
        if not isinstance(token, str) or not token:
            selected_user = users.get(user) if isinstance(users, dict) and isinstance(user, str) else None
            token = selected_user.get("oauth_token") if isinstance(selected_user, dict) else None
        if isinstance(token, str) and token:
            auth["oauth_token"] = token
            secrets.add(token)
        if auth:
            _write_private_yaml(destination / "hosts.yml", {target_host: auth})
        return secrets, True
    return secrets, False


def _project_glab_auth(
    config_path: Path, destination: Path, target_host: str
) -> tuple[set[str], bool]:
    source = _read_provider_yaml(config_path)
    source_hosts = source.get("hosts")
    if not isinstance(source_hosts, dict):
        return set(), False
    secrets: set[str] = set()
    for host, record in source_hosts.items():
        if (
            not isinstance(host, str)
            or normalize_remote_host(host) != target_host
            or not isinstance(record, dict)
        ):
            continue
        auth: dict[str, object] = {}
        for key in _PUBLIC_GLAB_AUTH_KEYS:
            value = record.get(key)
            if key in {"is_oauth2", "use_keyring"}:
                if isinstance(value, bool):
                    auth[key] = value
                elif isinstance(value, str) and value.lower() in {"true", "false"}:
                    auth[key] = value
            elif isinstance(value, str) and value:
                auth[key] = value
                if key in {"token", "job_token", "refresh_token", "oauth2_refresh_token"}:
                    secrets.add(value)
        if auth:
            _write_private_yaml(destination / "config.yml", {"hosts": {target_host: auth}})
        return secrets, True
    return secrets, False


def _copy_auth_environment(
    names: tuple[str, ...], env: dict[str, str], secrets: set[str]
) -> None:
    for name in names:
        value = os.environ.get(name)
        if value:
            env[name] = value
            secrets.add(value)


def _project_provider_auth(
    executable: str,
    target: PublicRemoteTarget,
    config_home: Path,
    env: dict[str, str],
) -> set[str]:
    source_config = _provider_config_path(executable)
    if executable == "gh":
        secrets, config_bound = _project_gh_auth(source_config, config_home / "gh", target.host)
        host_env = normalize_remote_host(os.environ.get("GH_HOST", ""))
        if target.host == "github.com":
            _copy_auth_environment(("GH_TOKEN", "GITHUB_TOKEN"), env, secrets)
            provider_bound = True
        elif host_env == target.host:
            env["GH_HOST"] = target.host
            _copy_auth_environment(
                ("GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"), env, secrets
            )
            provider_bound = True
        else:
            provider_bound = config_bound
    else:
        secrets, config_bound = _project_glab_auth(source_config, config_home / "glab", target.host)
        raw_host_env = os.environ.get("GITLAB_HOST")
        host_env = normalize_remote_host(raw_host_env or "")
        env_bound = host_env == target.host if raw_host_env else target.host == "gitlab.com"
        if env_bound:
            if raw_host_env:
                env["GITLAB_HOST"] = target.host
            _copy_auth_environment(_PUBLIC_GLAB_AUTH_ENV, env, secrets)
        provider_bound = config_bound or env_bound or target.host == "gitlab.com"
    if not provider_bound:
        raise _public_policy_error()
    return secrets


def _redact_provider_output(value: str, secrets: set[str]) -> str:
    for secret in sorted(secrets, key=len, reverse=True):
        value = value.replace(secret, _PUBLIC_SECRET_REPLACEMENT)
    return value


def _prepare_public_provider_git_context(
    isolated_path: Path, target: PublicRemoteTarget, workspace_root: str, env: dict[str, str]
) -> None:
    git_dir = isolated_path / "provider-git"
    secret_files.make_private_dir(git_dir)
    config = (
        "[core]\n"
        "\trepositoryformatversion = 0\n"
        "\tbare = false\n"
        "[remote \"origin\"]\n"
        f"\turl = {target.url}\n"
    )
    (git_dir / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    config_path = git_dir / "config"
    secret_files.write_private_plain(config_path, config.encode("utf-8"))
    env["GIT_DIR"] = str(git_dir)
    env["GIT_WORK_TREE"] = str(Path(workspace_root).resolve())


async def run_allowlisted(
    args: Sequence[str],
    cwd: str | None = None,
    *,
    timeout: float = 15.0,
    input_bytes: bytes | None = None,
    env: Mapping[str, str] | None = None,
) -> tuple[int, bytes, bytes]:
    """Run one allowlisted executable and return ``(rc, stdout, stderr)``.

    Validation errors are returned as a normal process-style failure so a
    malformed Host call cannot escape the WebSocket handler as an exception.
    Direct callers that need input validation before execution can still use
    ``validate_argv`` explicitly.
    """
    try:
        argv = validate_argv(args)
    except ValueError as exc:
        return 126, b"", str(exc).encode("utf-8")
    launch = _launch_argv(argv, env)
    if launch is None:
        return 127, b"", f"{argv[0]} not found".encode()
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(
            *launch,
            cwd=cwd,
            env=dict(env) if env is not None else None,
            stdin=asyncio.subprocess.PIPE if input_bytes is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        communication = process.communicate() if input_bytes is None else process.communicate(input_bytes)
        stdout, stderr = await asyncio.wait_for(communication, timeout=timeout)
        return process.returncode or 0, stdout, stderr
    except asyncio.TimeoutError:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        return 128, b"", f"{argv[0]} timed out".encode()
    except FileNotFoundError:
        return 127, b"", f"{argv[0]} not found".encode()
    except Exception as exc:  # noqa: BLE001 - preserve service-level error envelope
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        return 128, b"", str(exc).encode()


async def _read_stdout_capped(
    process: asyncio.subprocess.Process, max_stdout_bytes: int
) -> tuple[int, bytes, bytes, bool]:
    """Read *process* stdout until EOF or *max_stdout_bytes*, killing it if capped."""
    assert process.stdout is not None and process.stderr is not None
    # stderr is drained concurrently: a command that fails while writing a large
    # diagnostic would otherwise fill its pipe and block before stdout ends.
    stderr_task = asyncio.ensure_future(process.stderr.read())
    chunks: list[bytes] = []
    total = 0
    truncated = False
    try:
        while True:
            chunk = await process.stdout.read(_CAPPED_READ_CHUNK)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > max_stdout_bytes:
                truncated = True
                break
        if truncated and process.returncode is None:
            process.kill()
        if truncated:
            # Keep reading (and dropping) until the killed child's end of the
            # pipe closes. `process.wait()` resolves only once every pipe has
            # disconnected, and a stream that paused its transport on a full
            # buffer issues no further read, so it never sees EOF unless it
            # is drained — under the Proactor loop that was a hang until the
            # caller's timeout, reported as "not truncated".
            while await process.stdout.read(_CAPPED_READ_CHUNK):
                pass
        stderr = await stderr_task
    except BaseException:
        stderr_task.cancel()
        raise
    rc = await process.wait()
    return rc, b"".join(chunks)[:max_stdout_bytes], stderr, truncated


async def run_allowlisted_capped(
    args: Sequence[str],
    cwd: str | None = None,
    *,
    timeout: float = 15.0,
    max_stdout_bytes: int,
    env: Mapping[str, str] | None = None,
) -> tuple[int, bytes, bytes, bool]:
    """Run one allowlisted executable, stopping once stdout passes the cap.

    ``run_allowlisted`` buffers the whole of stdout before a caller can truncate
    it, so a command whose output the caller only wants the head of still peaks
    in memory at its full length. This variant stops reading and kills the child
    at the cap, and reports whether it did as the fourth element -- callers must
    check that flag before the return code, which is the kill signal, not a
    failure of the command.
    """
    try:
        argv = validate_argv(args)
    except ValueError as exc:
        return 126, b"", str(exc).encode("utf-8"), False
    launch = _launch_argv(argv, env)
    if launch is None:
        return 127, b"", f"{argv[0]} not found".encode(), False
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(
            *launch,
            cwd=cwd,
            env=dict(env) if env is not None else None,
            stdin=None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        return await asyncio.wait_for(
            _read_stdout_capped(process, max_stdout_bytes), timeout=timeout
        )
    except asyncio.TimeoutError:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        return 128, b"", f"{argv[0]} timed out".encode(), False
    except FileNotFoundError:
        return 127, b"", f"{argv[0]} not found".encode(), False
    except Exception as exc:  # noqa: BLE001 - preserve service-level error envelope
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        return 128, b"", str(exc).encode(), False


async def run_allowlisted_text(
    args: Sequence[str],
    cwd: str | None = None,
    *,
    timeout: float = 15.0,
    input_text: str | None = None,
    env: Mapping[str, str] | None = None,
) -> tuple[int, str, str]:
    """Text-decoding wrapper used by Git and Issues services."""
    rc, stdout, stderr = await run_allowlisted(
        args,
        cwd,
        timeout=timeout,
        input_bytes=input_text.encode("utf-8") if input_text is not None else None,
        env=env,
    )
    return rc, stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")


async def run_public_allowlisted_text(
    args: Sequence[str],
    cwd: str,
    *,
    workspace_root: str | None = None,
    timeout: float = 15.0,
    input_text: str | None = None,
) -> tuple[int, str, str]:
    """Run one public command with a Host-owned environment and Git policy."""
    try:
        argv = validate_public_argv(
            args,
            cwd=cwd,
            workspace_root=workspace_root or cwd,
        )
        if argv[0] == "git":
            assert_public_git_config_safe(cwd, workspace_root or cwd)
    except ValueError as exc:
        return 126, "", str(exc)

    try:
        with tempfile.TemporaryDirectory(prefix="navide-public-cli-") as isolated_home:
            isolated_path = Path(isolated_home)
            config_home = isolated_path / "config"
            secret_files.make_private_dir(config_home)
            secret_files.make_private_dir(config_home / "gh")
            secret_files.make_private_dir(config_home / "glab")
            env = {
                "PATH": os.environ.get("PATH", os.defpath),
                **paths.isolated_home_env(isolated_path),
                "XDG_CONFIG_HOME": str(config_home),
                "GH_CONFIG_DIR": str(config_home / "gh"),
                "GLAB_CONFIG_DIR": str(config_home / "glab"),
                "LANG": os.environ.get("LANG", "C"),
                "LC_ALL": os.environ.get("LC_ALL", "C"),
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_SYSTEM": os.devnull,
                "GIT_TERMINAL_PROMPT": "0",
                "GIT_PAGER": "cat",
                "GIT_EDITOR": "true",
                "GIT_SEQUENCE_EDITOR": "true",
                "GH_PAGER": "cat",
                "GH_EDITOR": "true",
                "GLAB_PAGER": "cat",
                # The fresh isolated home drops glab's update-check throttle, so
                # each run would otherwise call gitlab.com for a version check
                # and a telemetry event before doing any work (seconds per call,
                # past the timeout under load).
                "GLAB_CHECK_UPDATE": "false",
                "GLAB_SEND_TELEMETRY": "false",
                "EDITOR": "true",
                "VISUAL": "true",
            }
            command = list(argv)
            secrets: set[str] = set()
            if command[0] in {"gh", "glab"}:
                target = public_remote_target(cwd, workspace_root or cwd)
                if target is None:
                    raise _public_policy_error()
                secrets = _project_provider_auth(command[0], target, config_home, env)
                _prepare_public_provider_git_context(
                    isolated_path, target, workspace_root or cwd, env
                )
            if command[0] == "git":
                hooks_path = isolated_path / "hooks"
                secret_files.make_private_dir(hooks_path)
                command = [
                    "git",
                    "-c",
                    "core.fsmonitor=false",
                    "-c",
                    f"core.hooksPath={hooks_path}",
                    "-c",
                    "diff.external=",
                    "-c",
                    "core.sshCommand=",
                    "-c",
                    "credential.helper=",
                    "-c",
                    "protocol.ext.allow=never",
                    "-c",
                    "core.gitProxy=",
                    *command[1:],
                ]
            rc, stdout, stderr = await run_allowlisted_text(
                command,
                cwd,
                timeout=timeout,
                input_text=input_text,
                env=env,
            )
            if command[0] in {"gh", "glab"}:
                stdout = _redact_provider_output(stdout, secrets)
                stderr = _redact_provider_output(stderr, secrets)
            return rc, stdout, stderr
    except (OSError, ValueError) as exc:
        return 126, "", str(exc)
