"""Shared Git security predicates used by Host and backend Git services."""

from __future__ import annotations

import configparser
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

_REMOTE_HELPER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]*::")
_SCP_REMOTE_RE = re.compile(
    r"^(?:(?P<user>[^/@:\s]+)@)?(?P<host>[^/@:\s]+):(?P<path>[^\s]+)$"
)
_WINDOWS_PATH_RE = re.compile(r"^[A-Za-z]:[\\/]")
_MAX_CONFIG_BYTES = 1024 * 1024


@dataclass(frozen=True)
class PublicRemoteTarget:
    """The validated remote identity used by a public provider invocation."""

    host: str
    repository: str
    url: str


def _path_inside_root(path: Path, workspace_root: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(workspace_root)
    except ValueError as exc:
        raise ValueError("command is not permitted by the public shell policy") from exc
    return resolved


def _config_path_inside_root(git_dir: Path, workspace_root: Path) -> Path:
    return _path_inside_root(git_dir / "config", workspace_root)


def is_remote_helper_form(value: str) -> bool:
    """Return whether *value* is Git's ``transport::address`` helper form."""
    return bool(_REMOTE_HELPER_RE.match(value))


def is_scp_remote_form(value: str) -> bool:
    """Return whether *value* is Git's ``[user@]host:path`` form."""
    if (
        not isinstance(value, str)
        or not value
        or "\x00" in value
        or any(ch.isspace() for ch in value)
        or "://" in value
        or _WINDOWS_PATH_RE.match(value)
    ):
        return False
    return _SCP_REMOTE_RE.fullmatch(value) is not None


def is_public_remote_url(value: str) -> bool:
    """Return whether a remote operand is a standard network Git URL.

    Pseudo transports, local paths, and unknown schemes are deliberately not
    public shell inputs.  Local paths are handled separately by the workspace
    containment check at the command grammar boundary.
    """
    if (
        not isinstance(value, str)
        or not value
        or "\x00" in value
        or any(ch.isspace() for ch in value)
    ):
        return False
    if is_remote_helper_form(value):
        return False
    scp_remote = _SCP_REMOTE_RE.fullmatch(value) if is_scp_remote_form(value) else None
    if scp_remote:
        user = scp_remote.group("user")
        host = scp_remote.group("host")
        return not (user and user.startswith("-")) and not host.startswith("-")
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
    except ValueError:
        return False
    return (
        parsed.scheme.lower() in {"http", "https", "ssh"}
        and bool(parsed.netloc)
        and bool(hostname)
        and not hostname.startswith("-")
        and not (parsed.username or "").startswith("-")
    )


def is_git_internal_path(workspace_root: Path, target: Path) -> bool:
    """Return whether *target* is ``.git`` or a descendant of it."""
    resolved_root = workspace_root.resolve()
    resolved_target = target.resolve()
    if ".git" in resolved_root.parts:
        return True
    try:
        relative = resolved_target.relative_to(resolved_root)
    except (OSError, ValueError):
        return False
    return ".git" in relative.parts


def _git_config_path(cwd: Path, workspace_root: Path) -> Path | None:
    """Find a workspace-local Git config without invoking Git itself."""
    current = cwd.resolve()
    root = workspace_root.resolve()
    try:
        current.relative_to(root)
    except ValueError as exc:
        raise ValueError("command is not permitted by the public shell policy") from exc

    while True:
        dot_git = current / ".git"
        if dot_git.is_dir():
            resolved = dot_git.resolve()
            try:
                resolved.relative_to(root)
            except ValueError as exc:
                raise ValueError("command is not permitted by the public shell policy") from exc
            return _config_path_inside_root(resolved, root)
        if dot_git.is_file():
            try:
                line = dot_git.read_text(encoding="utf-8").strip()
            except (OSError, UnicodeError) as exc:
                raise ValueError("command is not permitted by the public shell policy") from exc
            if not line.lower().startswith("gitdir:"):
                raise ValueError("command is not permitted by the public shell policy")
            git_dir = (dot_git.parent / line.split(":", 1)[1].strip()).resolve()
            try:
                git_dir.relative_to(root)
            except ValueError as exc:
                raise ValueError("command is not permitted by the public shell policy") from exc
            return _config_path_inside_root(git_dir, root)
        if current == root:
            return None
        current = current.parent


def _git_config_paths(cwd: Path, workspace_root: Path) -> list[Path]:
    """Return all workspace-contained Git config files a command may load."""
    config_path = _git_config_path(cwd, workspace_root)
    if config_path is None:
        return []

    root = workspace_root.resolve()
    git_dir = config_path.parent
    paths = [config_path]
    worktree_config = _path_inside_root(git_dir / "config.worktree", root)
    paths.append(worktree_config)

    commondir_file = git_dir / "commondir"
    if commondir_file.exists():
        try:
            commondir_value = commondir_file.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError) as exc:
            raise ValueError("command is not permitted by the public shell policy") from exc
        if not commondir_value:
            raise ValueError("command is not permitted by the public shell policy")
        common_dir = (git_dir / commondir_value).resolve()
        paths.append(_config_path_inside_root(common_dir, root))

    return list(dict.fromkeys(paths))


def _read_config_parser(config_path: Path) -> configparser.ConfigParser | None:
    """Read one config file without following Git includes."""
    if not config_path.exists():
        return None
    try:
        if config_path.stat().st_size > _MAX_CONFIG_BYTES:
            raise ValueError("command is not permitted by the public shell policy")
        text = config_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise ValueError("command is not permitted by the public shell policy") from exc

    parser = configparser.ConfigParser(
        interpolation=None,
        strict=False,
        allow_no_value=True,
        delimiters=("=", " ", "\t"),
    )
    parser.optionxform = str.lower
    try:
        parser.read_string(text)
    except configparser.Error as exc:
        raise ValueError("command is not permitted by the public shell policy") from exc
    return parser


def _remote_origin_from_config(config_path: Path) -> str | None:
    parser = _read_config_parser(config_path)
    if parser is None:
        return None
    for raw_section in parser.sections():
        if raw_section.lower() != 'remote "origin"':
            continue
        for raw_key, raw_value in parser.items(raw_section):
            if raw_key.lower() == "url" and raw_value:
                return raw_value.strip()
    return None


def _remote_authority(value: str) -> str | None:
    if is_scp_remote_form(value):
        match = _SCP_REMOTE_RE.fullmatch(value)
        return match.group("host").lower() if match else None
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    if not hostname:
        return None
    host = f"[{hostname.lower()}]" if ":" in hostname else hostname.lower()
    return f"{host}:{port}" if port is not None else host


def _remote_repository(value: str) -> str | None:
    if is_scp_remote_form(value):
        match = _SCP_REMOTE_RE.fullmatch(value)
        path = match.group("path") if match else ""
    else:
        try:
            path = urlsplit(value).path
        except ValueError:
            return None
    repository = path.strip("/")
    if repository.endswith(".git"):
        repository = repository[:-4]
    return repository or None


def normalize_remote_host(value: str) -> str | None:
    """Normalize a host/optional port for exact provider binding."""
    if not isinstance(value, str) or not value or any(ch.isspace() for ch in value) or "\x00" in value:
        return None
    try:
        parsed = urlsplit(f"//{value}")
        if parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
            return None
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    if not hostname:
        return None
    host = f"[{hostname.lower()}]" if ":" in hostname else hostname.lower()
    return f"{host}:{port}" if port is not None else host


def _without_remote_credentials(value: str) -> str:
    """Return a validated remote URL without userinfo or query data."""
    if is_scp_remote_form(value):
        match = _SCP_REMOTE_RE.fullmatch(value)
        if match is None:
            raise ValueError("command is not permitted by the public shell policy")
        host = _remote_authority(value)
        if host is None:
            raise ValueError("command is not permitted by the public shell policy")
        return f"{host}:{match.group('path')}"
    parsed = urlsplit(value)
    host = _remote_authority(value)
    if host is None:
        raise ValueError("command is not permitted by the public shell policy")
    return f"{parsed.scheme.lower()}://{host}{parsed.path}"


def public_remote_target(cwd: str, workspace_root: str) -> PublicRemoteTarget | None:
    """Return one sanitized, workspace-configured remote identity."""
    remote_url: str | None = None
    for config_path in reversed(_git_config_paths(Path(cwd), Path(workspace_root))):
        configured = _remote_origin_from_config(config_path)
        if configured is not None:
            remote_url = configured
    if not remote_url or not is_public_remote_url(remote_url):
        return None
    host = _remote_authority(remote_url)
    repository = _remote_repository(remote_url)
    if not host or not repository:
        return None
    return PublicRemoteTarget(host, repository, _without_remote_credentials(remote_url))


def _assert_config_file_safe(config_path: Path) -> None:
    """Reject config entries that can select a process or outside worktree."""
    parser = _read_config_parser(config_path)
    if parser is None:
        return

    for raw_section in parser.sections():
        section = raw_section.lower()
        if section == "include" or section.startswith("includeif"):
            raise ValueError("command is not permitted by the public shell policy")
        for raw_key, raw_value in parser.items(raw_section):
            key = raw_key.lower()
            value = "" if raw_value is None else raw_value.strip()
            # Newer configparser releases (3.12.14+, 3.14) keep a `name value`
            # line without "=" as one valueless key instead of splitting on the
            # space delimiter, so the name would never reach the lookups below.
            # Git has no such syntax either: reject rather than interpret.
            if any(ch.isspace() for ch in key):
                raise ValueError("command is not permitted by the public shell policy")
            if section == "core" and key in {
                "fsmonitor",
                "hookspath",
                "sshcommand",
                "gitproxy",
                "worktree",
                "editor",
                "pager",
                "askpass",
                "attributesfile",
                "alternaterefscommand",
                "excludesfile",
            }:
                raise ValueError("command is not permitted by the public shell policy")
            if section == "init" and key == "templatedir":
                raise ValueError("command is not permitted by the public shell policy")
            if section == "gc" and key == "recentobjectshook":
                raise ValueError("command is not permitted by the public shell policy")
            if section == "push" and key == "gpgsign":
                raise ValueError("command is not permitted by the public shell policy")
            if section == "sequence" and key == "editor":
                raise ValueError("command is not permitted by the public shell policy")
            if section == "pager":
                raise ValueError("command is not permitted by the public shell policy")
            if section.startswith("diff") and key in {"command", "external", "textconv"}:
                raise ValueError("command is not permitted by the public shell policy")
            if section == "gpg" or section.startswith("gpg "):
                if key == "program":
                    raise ValueError("command is not permitted by the public shell policy")
            if section in {"commit", "tag"} and key == "gpgsign":
                raise ValueError("command is not permitted by the public shell policy")
            if (section == "credential" or section.startswith("credential ")) and key == "helper":
                raise ValueError("command is not permitted by the public shell policy")
            if section.startswith("filter ") and key in {"process", "clean", "smudge"}:
                raise ValueError("command is not permitted by the public shell policy")
            if section.startswith("remote "):
                if key in {"proxy", "vcs", "uploadpack", "receivepack"}:
                    raise ValueError("command is not permitted by the public shell policy")
                if key in {"url", "pushurl"} and not _safe_config_remote(value):
                    raise ValueError("command is not permitted by the public shell policy")
            if section.startswith("merge ") and key == "driver":
                raise ValueError("command is not permitted by the public shell policy")
            if section.startswith(("difftool ", "mergetool ")) and key.endswith("cmd"):
                raise ValueError("command is not permitted by the public shell policy")
            if section.startswith("url ") and key in {"insteadof", "pushinsteadof"}:
                raise ValueError("command is not permitted by the public shell policy")


def _safe_config_remote(value: str) -> bool:
    return is_public_remote_url(value)


def assert_public_git_config_safe(cwd: str, workspace_root: str) -> None:
    """Reject local Git config entries that can select external programs.

    Global/system config is disabled by the public runner.  This preflight
    covers the remaining local config, including linked-worktree indirection,
    before any public Git subprocess is started.  Unknown config structure is
    rejected rather than interpreted optimistically.
    """
    for config_path in _git_config_paths(Path(cwd), Path(workspace_root)):
        _assert_config_file_safe(config_path)
