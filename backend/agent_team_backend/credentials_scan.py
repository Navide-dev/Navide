"""Read-only credentials and keys risk scan (Phase 1 of the credentials plan).

What it looks at: git credential helper chains, gh / glab accounts, SSH keys
and ``~/.ssh/config``, OS keyring item *metadata*, remote URLs of the repos
under the scan roots, token-looking environment variable names, and plaintext
credential files.

The rules this module is built around:

* **No value leaves this module, and none is kept.** Where a value has to pass
  through memory to be noticed at all (a URL's password, a ``token:`` line in a
  CLI config, an ``export GH_TOKEN=...`` line) only a boolean is derived from
  it and the text is dropped. A URL token is reported as "token present"; no
  prefix, length or hash of it is computed. Finding ids hash the *redacted*
  location only.
* **Nothing is written** except the two KV documents below (user scan roots and
  reminder state) in the global ``navide.db``. No git config, keychain,
  ``~/.ssh`` or remote is ever touched, and no command that prints a secret is
  ever run (no ``gh auth token``, no ``security -w/-g/-d``, no
  ``git credential fill``, no Secret Service GetSecret).
* **No raw subprocess output is logged.** Logs carry counts and codes only.

Neither KV key belongs to any sync scope or settings bundle (guarded by tests):
credential state stays on this machine.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import stat
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Mapping, Sequence
from urllib.parse import unquote, urlsplit, urlunsplit

from . import osplat
from .ipc import make_response

if TYPE_CHECKING:
    from .app import Session

log = logging.getLogger("agent_team_backend.credentials_scan")

#: KV keys (global navide.db). Never part of a sync scope or a bundle.
ROOTS_KV_KEY = "credentials.scan_roots"
REMINDERS_KV_KEY = "credentials.reminders"
KV_KEYS: tuple[str, ...] = (ROOTS_KV_KEY, REMINDERS_KV_KEY)

CACHE_SECONDS = 60.0
MAX_ROOTS = 20
MAX_REPOS = 500
MAX_WALK_DIRS = 20000
WALK_DEPTH = 3
#: Whole-scan wall-clock limit for walking roots, and the share one root gets.
WALK_SECONDS = 20.0
ROOT_WALK_SECONDS = 10.0
#: Wall-clock limit for reading the repos' git config (R2-6).
REPO_READ_SECONDS = 30.0
MAX_REMINDERS = 1000
SNOOZE_DEFAULT_DAYS = 7
SNOOZE_MAX_DAYS = 90

_SKIP_DIR_NAMES = frozenset({
    "node_modules", ".venv", "venv", "__pycache__", ".tox", ".git", "Library",
    ".cache", ".Trash",
})

FINDING_CODES = (
    "url-token", "ssh-no-passphrase-default-host", "ssh-no-passphrase", "ssh-key-unreferenced",
    "ssh-key-mode", "cli-token-plaintext", "gh-active-account-only", "helper-duplicate",
    "helper-shadowed", "env-token-in-shell-rc", "env-token-set", "plaintext-credential-file",
    "keyring-unavailable",
)
_SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}

_TOKEN_PREFIXES = (
    "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "glrt-", "gldt-",
)
#: Usernames that only stand in front of a token; a suggested clean URL drops them.
_PSEUDO_USERS = frozenset({"oauth2", "x-access-token", "x-token-auth", "gitlab-ci-token", "token"})

_FORGE_HOSTS = frozenset({
    "github.com", "ssh.github.com", "gitlab.com", "altssh.gitlab.com", "bitbucket.org",
    "dev.azure.com", "ssh.dev.azure.com",
})

_ENV_ALLOWLIST = frozenset({
    "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITLAB_TOKEN",
    "GLAB_TOKEN", "CI_JOB_TOKEN", "BITBUCKET_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "NPM_TOKEN", "HF_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY",
})
_ENV_SUFFIXES = ("_TOKEN", "_API_KEY", "_SECRET", "_PASSWORD")
#: Navide's own plumbing (pane/hook tokens) is not a user credential.
_ENV_OWN_PREFIXES = ("NAVIDE_", "AGENT_TEAM_")

_SHELL_RC_FILES = (
    ".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile",
    ".config/fish/config.fish",
)
_RC_EXPORT_RE = re.compile(
    r"^\s*(?:export\s+|set\s+-[A-Za-z]*x[A-Za-z]*\s+)([A-Za-z_][A-Za-z0-9_]*)(?:=|\s+)(.*)$"
)

_DEFAULT_IDENTITIES = frozenset({
    "id_rsa", "id_ecdsa", "id_ecdsa_sk", "id_ed25519", "id_ed25519_sk", "id_dsa", "id_xmss",
})
_SSH_NOT_KEYS = frozenset({"config", "known_hosts", "known_hosts.old", "authorized_keys",
                           "authorized_keys2", "environment", "rc"})
_PKCS8_ENCRYPTED = "pkcs8-encrypted"
_KEY_HEADERS = (
    ("-----BEGIN " + "OPENSSH PRIVATE KEY-----", "openssh"),
    ("-----BEGIN " + "RSA PRIVATE KEY-----", "rsa-pem"),
    ("-----BEGIN " + "EC PRIVATE KEY-----", "ec-pem"),
    ("-----BEGIN " + "DSA PRIVATE KEY-----", "dsa-pem"),
    ("-----BEGIN " + "PRIVATE KEY-----", "pkcs8"),
    ("-----BEGIN " + "ENCRYPTED PRIVATE KEY-----", _PKCS8_ENCRYPTED),
    ("PuTTY-User-Key-File-", "putty"),
)

_YAML_TOKEN_KEYS = frozenset({
    "token", "oauth_token", "refresh_token", "oauth2_refresh_token", "access_token",
})
_YAML_EMPTY = frozenset({"", '""', "''", "null", "~", "!!null"})

_LINKS = {
    "github-tokens": {"label": "GitHub tokens", "url": "https://github.com/settings/tokens"},
    "github-ssh": {"label": "GitHub SSH keys", "url": "https://github.com/settings/keys"},
}


def _gitlab_pat_link(host: str) -> dict[str, str]:
    return {
        "label": "GitLab personal access tokens",
        "url": f"https://{host}/-/user_settings/personal_access_tokens",
    }


def _gitlab_ssh_link(host: str) -> dict[str, str]:
    return {"label": "GitLab SSH keys", "url": f"https://{host}/-/user_settings/ssh_keys"}


# ── Process plumbing ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RunResult:
    code: int
    out: str = ""
    err: str = ""


#: ``run(argv, timeout=..., capture=...)``. ``capture=False`` discards stdout and
#: stderr (the ssh-keygen probe never keeps what it prints).
Runner = Callable[..., RunResult]

#: Missing-tool / timeout / spawn-failure sentinel codes.
CODE_TIMEOUT = -2
CODE_SPAWN_FAILED = -3


def child_env(base: Mapping[str, str]) -> dict[str, str]:
    """An environment in which no tool this scan runs can prompt anyone."""
    env = dict(base)
    for name in ("SSH_ASKPASS", "DISPLAY", "GIT_ASKPASS", "WAYLAND_DISPLAY"):
        env.pop(name, None)
    env.update({
        "GIT_TERMINAL_PROMPT": "0",
        "GH_PROMPT_DISABLED": "1",
        "GCM_INTERACTIVE": "never",
        "GH_NO_UPDATE_NOTIFIER": "1",
        "GLAB_CHECK_UPDATE": "false",
        "NO_PROMPT": "1",
        "SSH_ASKPASS_REQUIRE": "never",
        "NO_COLOR": "1",
        "CLICOLOR": "0",
    })
    return env


def make_runner(env: Mapping[str, str]) -> Runner:
    """The real runner: no shell, stdin closed, a timeout on every call."""
    prepared = child_env(env)

    def run(argv: Sequence[str], *, timeout: float = 15.0, capture: bool = True) -> RunResult:
        target = subprocess.PIPE if capture else subprocess.DEVNULL
        try:
            proc = subprocess.run(
                list(argv),
                stdin=subprocess.DEVNULL,
                stdout=target,
                stderr=target,
                timeout=timeout,
                env=prepared,
                start_new_session=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired:
            return RunResult(CODE_TIMEOUT)
        except OSError:
            return RunResult(CODE_SPAWN_FAILED)
        if not capture:
            return RunResult(proc.returncode)
        return RunResult(
            proc.returncode,
            (proc.stdout or b"").decode("utf-8", "replace"),
            (proc.stderr or b"").decode("utf-8", "replace"),
        )

    return run


# ── Small helpers ───────────────────────────────────────────────────────────


def _fingerprint(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:16]


def _tilde(path: str | Path, home: Path) -> str:
    text = str(path)
    root = str(home)
    if text == root:
        return "~"
    if text.startswith(root + os.sep):
        return "~" + text[len(root):].replace(os.sep, "/")
    return text


def _mode_text(mode: int) -> str:
    return format(stat.S_IMODE(mode), "04o")


def _now_iso(now: datetime) -> str:
    return now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(text: Any) -> datetime | None:
    if not isinstance(text, str):
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


#: The only characters a copyable step may contain (R2-1/R2-2). Nothing is
#: escaped: escaping differs per shell (sh, cmd, PowerShell) and got Windows
#: wrong, so a part outside this set means no command at all.
_STEP_PART_RE = re.compile(r"[A-Za-z0-9._~:/@+=-]+")
MAX_READ_BYTES = 1024 * 1024


class StepValue(str):
    """A part of a step that came from scanned data (a path, URL, remote
    name, host, login) rather than from this module. Besides the allowlist
    it must start with a letter, digit or "/" (R3-1): no option ("-"), no
    PowerShell splat or expression ("@", "("), no "=", "~" or "+"."""


class RemoteName(StepValue):
    """A git remote name: additionally may not start with a digit (R3-1)."""


_STEP_VALUE_START_RE = re.compile(r"[A-Za-z0-9/]")


def safe_command(*parts: str) -> str | None:
    """A copyable command, or None when any part falls outside the allowlist
    (the finding then asks for a manual fix rather than offering a command).
    The same rule on every platform."""
    for part in parts:
        if not _STEP_PART_RE.fullmatch(part):
            return None
        if isinstance(part, StepValue) and not _STEP_VALUE_START_RE.match(part):
            return None
        if isinstance(part, RemoteName) and part[:1].isdigit():
            return None
    return " ".join(parts)


def read_text_capped(path: Path, limit: int = MAX_READ_BYTES) -> str | None:
    """A regular file's text, at most ``limit`` bytes; None for anything else.

    Checked with stat first and opened non-blocking, so a FIFO or device a
    config points at can neither hang the scan nor fill memory (CR-7). A file
    longer than the cap is not read at all.
    """
    try:
        info = os.stat(path)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        return None
    try:
        fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining > 0:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
    except OSError:
        return None
    finally:
        os.close(fd)
    data = b"".join(chunks)
    if len(data) > limit:
        return None
    return data.decode("utf-8", "replace")


_LOGIN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,38}")


def plain_login(name: str) -> bool:
    """Whether a URL username can be shown: a known pseudo-user or something
    shaped like a login. Anything else is treated as a token (CR-6)."""
    if not name:
        return False
    if name.lower() in _PSEUDO_USERS:
        return True
    if not _LOGIN_RE.fullmatch(name) or looks_like_token(name):
        return False
    has_upper = re.search(r"[A-Z]", name) is not None
    has_lower = re.search(r"[a-z]", name) is not None
    has_digit = re.search(r"\d", name) is not None
    if len(name) >= 16 and has_upper and has_lower:
        return False
    if len(name) >= 20 and has_digit and not re.search(r"[._-]", name):
        return False
    return True


def looks_like_token(text: str) -> bool:
    """Whether a URL *username* is really a token (judged, never kept)."""
    if not text:
        return False
    if text.startswith(_TOKEN_PREFIXES):
        return True
    if re.fullmatch(r"[0-9a-fA-F]{40}", text):
        return True
    return (
        len(text) >= 32
        and re.fullmatch(r"[A-Za-z0-9_\-]+", text) is not None
        and re.search(r"\d", text) is not None
        and re.search(r"[A-Za-z]", text) is not None
    )


@dataclass(frozen=True)
class RedactedUrl:
    url: str            # userinfo password and any token user removed; no query/fragment
    token_present: bool
    user: str           # the remaining (non-token) user, or ""
    host: str
    scheme: str
    path: str
    has_userinfo: bool
    hostport: str = ""  # host[:port] as written (IPv6 brackets kept); never userinfo


def _split_userinfo(rest: str) -> tuple[str | None, str]:
    """``rest`` is what follows ``scheme://``. Returns (userinfo or None, the
    remainder). The authority runs to the *last* ``@`` before the first
    whitespace, so a password with an unencoded ``/``, ``?`` or ``#`` is still
    userinfo (CR-5); an ``@`` that only appears after the path started (no
    ``:`` before the first ``/``, or a ``:port``) is part of the path."""
    # Whitespace does not end the authority (R2-3): a password may contain it.
    at = rest.rfind("@")
    if at < 0:
        return None, rest
    candidate = rest[:at]
    slash = candidate.find("/")
    colon = candidate.find(":")
    if slash != -1:
        if colon == -1 or colon > slash:
            return None, rest
        if re.fullmatch(r"\d+", candidate[colon + 1:slash]):
            return None, rest  # host:port/path@...
    return candidate, rest[at + 1:]


def redact_url(raw: str) -> RedactedUrl:
    """Split ``raw`` into what may be shown; the secret parts are dropped here."""
    text = raw.strip()
    if "://" not in text:
        # scp-like ``user@host:path`` (or a local path).
        match = re.match(r"^(?:(.+)@)?([^:/\s@\[\]]+):(.*)$", text)
        if match and not re.match(r"^[A-Za-z]:[\\/]", text):
            userinfo = match.group(1) or ""
            host = match.group(2).lower()
            path = match.group(3)
            if userinfo and (":" in userinfo or not plain_login(userinfo)):
                return RedactedUrl(f"{host}:{path}", True, "", host, "ssh", path, True)
            prefix = f"{userinfo}@" if userinfo else ""
            return RedactedUrl(f"{prefix}{host}:{path}", False, userinfo, host, "ssh", path, bool(userinfo))
        return RedactedUrl(text, False, "", "", "", text, False)
    scheme_part, _, rest = text.partition("://")
    scheme = scheme_part.lower()
    userinfo, remainder = _split_userinfo(rest)
    has_userinfo = userinfo is not None
    user = ""
    token = False
    if userinfo is not None:
        name, sep, secret = userinfo.partition(":")
        token = bool(sep and secret)
        del secret
        name = unquote(name)
        if re.search(r"[\s\x00-\x1f\x7f]", userinfo):
            token = True  # in doubt, the whole userinfo goes
        elif plain_login(name):
            user = name
        elif name:
            token = True
    del userinfo
    try:
        parts = urlsplit(f"{scheme}://{remainder}")
        hostport = parts.netloc
        host = (parts.hostname or "").lower()
        path = parts.path
    except ValueError:
        return RedactedUrl("", token, "", "", scheme, "", has_userinfo)
    if "@" in hostport or re.search(r"[\s\x00-\x1f\x7f]", hostport):
        # Never show an authority that still carries userinfo-like text.
        token = True
        hostport = host
    shown_netloc = (f"{user}@" if user else "") + hostport
    shown = urlunsplit((scheme, shown_netloc, path, "", ""))
    return RedactedUrl(shown, token, user, host, scheme, path, has_userinfo, hostport)


#: Hosts whose provider pages are linked without asking anyone (CR-9). Others
#: are linked only when the user's own gh / glab configuration names them.
_TRUSTED_LINK_HOSTS = frozenset({"github.com", "gitlab.com"})


_HOST_RE = re.compile(r"[a-z0-9.-]+(?::\d{1,5})?")


def valid_host(host: str) -> bool:
    """A bare host name with an optional port, nothing else (R2-10)."""
    return bool(_HOST_RE.fullmatch(host)) and not host.startswith((".", "-"))


def _host_links(host: str, trusted: frozenset[str] | set[str], *, ssh: bool = False,
                provider: str = "") -> list[dict[str, str]]:
    """Provider links for ``host`` — only github.com, gitlab.com, or a host
    the user's own gh / glab setup lists (``trusted``); a host taken from a
    repository's config never gets a link of its own (CR-9)."""
    host = host.lower()
    if not valid_host(host):
        return []
    if host == "github.com":
        return [dict(_LINKS["github-ssh" if ssh else "github-tokens"])]
    if host == "gitlab.com":
        return [_gitlab_ssh_link(host) if ssh else _gitlab_pat_link(host)]
    if host in trusted:
        if provider == "gh":
            return [{"label": "GitHub tokens", "url": f"https://{host}/settings/tokens"}]
        return [_gitlab_ssh_link(host) if ssh else _gitlab_pat_link(host)]
    return []


# ── Scan inputs and result building ─────────────────────────────────────────


@dataclass
class ScanContext:
    home: Path
    env: Mapping[str, str]
    roots: list[tuple[str, str]]          # (absolute path, "workspace"|"user")
    run: Runner
    which: Callable[[str], str | None]
    platform: str = osplat.platform_id
    system_dirs: list[Path] = field(default_factory=list)
    enforces_modes: bool = True
    config_home: Path | None = None        # os.UserConfigDir() equivalent (glab)
    roaming_app_data: Path | None = None   # %APPDATA% on Windows (gh)
    repo_workers: int = 6


def default_context(roots: list[tuple[str, str]]) -> ScanContext:
    home = Path.home()
    env = dict(os.environ)
    path_value = env.get("PATH")
    return ScanContext(
        home=home,
        env=env,
        roots=roots,
        run=make_runner(env),
        which=lambda name: osplat.paths.resolve_program(name, path=path_value),
        platform=osplat.platform_id,
        system_dirs=list(osplat.paths.system_dirs()),
        enforces_modes=osplat.paths.enforces_posix_modes(),
        config_home=osplat.paths.config_home(home),
        roaming_app_data=osplat.paths.roaming_app_data(),
    )


class _Collector:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []
        self.findings: list[dict[str, Any]] = []
        self._item_ids: set[str] = set()
        self._finding_ids: set[str] = set()

    def item(self, kind: str, label: str, key: str, detail: dict[str, Any], *, item_id: str | None = None) -> None:
        item_id = item_id or _fingerprint("item", kind, key)
        if item_id in self._item_ids:
            return
        self._item_ids.add(item_id)
        self.items.append({"id": item_id, "kind": kind, "label": label, "detail": detail})

    def finding(
        self,
        code: str,
        severity: str,
        kind: str,
        location: str,
        params: dict[str, str] | None = None,
        links: list[dict[str, str]] | None = None,
        steps: list[Sequence[str]] | None = None,
        actions: list[str] | None = None,
        manual: bool = False,
    ) -> None:
        """``steps`` are argv lists. Each is rendered with every part quoted; a
        step any part of which carries a shell metacharacter is withheld and
        the finding is marked ``manual_fix`` instead (CR-1)."""
        assert code in FINDING_CODES, code
        finding_id = _fingerprint(code, location)
        if finding_id in self._finding_ids:
            return
        self._finding_ids.add(finding_id)
        rendered: list[str] = []
        for argv in steps or []:
            command = safe_command(*argv)
            if command is None:
                manual = True
            else:
                rendered.append(command)
        if manual:
            rendered = []
        action_list = list(actions or [])
        if manual:
            action_list.append("manual-fix")
        self.findings.append({
            "id": finding_id,
            "code": code,
            "severity": severity,
            "kind": kind,
            "location": location,
            "params": {k: str(v) for k, v in (params or {}).items()},
            "links": list(links or []),
            "steps": rendered,
            "actions": action_list,
            "manual_fix": manual,
        })


# ── 1. git credential helpers ───────────────────────────────────────────────


_HELPER_NAME_RE = re.compile(r"[\w.+-]+")


@dataclass(frozen=True)
class HelperEntry:
    scope: str      # system | global | local
    origin: str     # file the entry came from (tilde form)
    context: str    # "*" or a redacted URL
    name: str       # helper name; "" is a reset
    masked: bool = False  # the context lost userinfo, so it no longer matches the real key


def helper_name(value: str) -> str:
    """The helper's name only. An inline ``!`` helper reports its program's
    basename: its body may carry a secret and is never returned."""
    text = value.strip()
    if not text:
        return ""
    inline = text.startswith("!")
    if inline:
        text = text[1:].strip()
    first = text.split()[0] if text.split() else ""
    # An assignment (``GH_TOKEN=... gh``) or anything that is not a plain
    # program name is never echoed: it may be the secret itself (CR-2).
    if not first or "=" in first:
        return "inline-shell"
    base = re.split(r"[\\/]", first)[-1]
    if base.lower().endswith(".exe"):
        base = base[:-4]
    if not inline and base.startswith("git-credential-"):
        base = base[len("git-credential-"):]
    if not _HELPER_NAME_RE.fullmatch(base) or looks_like_token(base) or not plain_login(base):
        return "inline-shell"
    return base


def parse_helper_config(out: str, scope: str, home: Path, *, with_origin: bool) -> list[HelperEntry]:
    """Parse ``git config [--show-origin] -z --get-regexp ^credential\\.`` output."""
    entries: list[HelperEntry] = []
    fields = out.split("\0")
    index = 0
    while index < len(fields):
        origin = ""
        if with_origin:
            origin_field = fields[index]
            index += 1
            if index >= len(fields):
                break
            origin = origin_field.split(":", 1)[1] if ":" in origin_field else origin_field
        record = fields[index]
        index += 1
        if not record:
            continue
        key, _, value = record.partition("\n")
        lower = key.lower()
        if not lower.startswith("credential.") or not lower.endswith(".helper"):
            continue
        middle = key[len("credential."):-len(".helper")]
        context, masked = _helper_context(middle)
        entries.append(HelperEntry(scope, _tilde(origin, home) if origin else "", context,
                                   helper_name(value), masked))
    return entries


def _helper_context(middle: str) -> tuple[str, bool]:
    """The shown context for ``credential.<middle>.helper`` and whether it had
    to be masked (any userinfo, or anything that cannot be shown verbatim)."""
    if not middle:
        return "*", False
    redacted = redact_url(middle)
    shown = redacted.url or "*"
    masked = redacted.has_userinfo or redacted.token_present or shown != middle
    return shown, masked


def effective_chains(entries: Sequence[HelperEntry]) -> dict[str, list[HelperEntry]]:
    chains: dict[str, list[HelperEntry]] = {}
    for entry in entries:
        chain = chains.setdefault(entry.context, [])
        if entry.name == "":
            chain.clear()
            chain.append(entry)  # keep the reset as a marker
        else:
            chain.append(entry)
    return chains


def _chain_names(chain: Sequence[HelperEntry]) -> list[str]:
    return [e.name for e in chain if e.name]


def _scan_global_helpers(ctx: ScanContext, git: str, out: _Collector) -> tuple[list[HelperEntry], set[str]]:
    entries: list[HelperEntry] = []
    for scope in ("system", "global"):
        result = ctx.run([git, "config", f"--{scope}", "--show-origin", "-z", "--get-regexp",
                          r"^credential\..*"], timeout=10)
        if result.code == 0:
            entries.extend(parse_helper_config(result.out, scope, ctx.home, with_origin=True))
    for entry in entries:
        if entry.name:
            out.item("git-helper", entry.name, f"{entry.scope}|{entry.origin}|{entry.context}|{entry.name}",
                     {"scope": entry.scope, "context": entry.context, "origin": entry.origin})
    gh_only: set[str] = set()
    for context, chain in effective_chains(entries).items():
        names = _chain_names(chain)
        _report_duplicates(context, chain, out, location_prefix=chain[-1].origin or chain[-1].scope)
        if names == ["gh"] and chain[0].name == "":
            gh_only.add(context)
    return entries, gh_only


def _report_duplicates(context: str, chain: Sequence[HelperEntry], out: _Collector, *, location_prefix: str,
                       repo: str | None = None) -> None:
    seen: set[str] = set()
    key = "credential.helper" if context == "*" else f"credential.{context}.helper"
    git_prefix = ["git", "-C", StepValue(repo)] if repo else ["git"]
    masked = any(entry.masked for entry in chain)
    for name in _chain_names(chain):
        if name in seen:
            out.finding(
                "helper-duplicate", "low", "git-helper",
                f"{location_prefix} · {key} · {name}",
                params={"helper": name, "context": context},
                steps=[] if masked else [[*git_prefix, "config", "--show-origin", "--get-all", StepValue(key)]],
                actions=["inspect-helper-config"],
                manual=masked,
            )
        seen.add(name)


def _local_helper_findings(repo: str, repo_t: str, local: list[HelperEntry],
                           global_entries: list[HelperEntry], out: _Collector) -> None:
    if not local:
        return
    for entry in local:
        if entry.name:
            out.item("git-helper", entry.name, f"local|{repo}|{entry.context}|{entry.name}",
                     {"scope": "local", "context": entry.context, "origin": repo_t})
    global_chains = effective_chains(global_entries)
    combined = effective_chains([*global_entries, *local])
    by_context: dict[str, list[HelperEntry]] = {}
    for entry in local:
        by_context.setdefault(entry.context, []).append(entry)
    for context, entries in by_context.items():
        key = "credential.helper" if context == "*" else f"credential.{context}.helper"
        _report_duplicates(context, combined.get(context, []), out, location_prefix=repo_t, repo=repo)
        before = _chain_names(global_chains.get(context, []))
        if before and entries[0].name != "":
            out.finding(
                "helper-shadowed", "low", "git-helper",
                f"{repo_t} · {key}",
                params={"repo": repo_t, "context": context, "helper": entries[0].name,
                        "answered_by": before[0]},
                steps=[] if entries[0].masked else [
                    ["git", "-C", StepValue(repo), "config", "--show-origin", "--get-all", StepValue(key)]],
                actions=["inspect-helper-config"],
                manual=entries[0].masked,
            )


# ── 2. gh / glab accounts ───────────────────────────────────────────────────


@dataclass
class CliAccount:
    tool: str
    host: str
    account: str
    active: bool
    storage: str  # keyring | config-file | env | unknown


def _storage_kind(text: str) -> str:
    lowered = text.lower()
    if "keyring" in lowered or "keychain" in lowered:
        return "keyring"
    if "oauth_token" in lowered:
        return "config-file"
    if lowered.endswith("_token") or lowered in {"gh_token", "github_token", "gitlab_token"}:
        return "env"
    if "/" in text or "\\" in text or "hosts.yml" in lowered or "config.yml" in lowered or "oauth_token" in lowered:
        return "config-file"
    return "unknown"


def parse_gh_json(out: str) -> list[CliAccount] | None:
    try:
        doc = json.loads(out)
    except (ValueError, TypeError):
        return None
    hosts = doc.get("hosts") if isinstance(doc, dict) else None
    if not isinstance(hosts, dict):
        return None
    accounts: list[CliAccount] = []
    for host, rows in hosts.items():
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            login = row.get("login")
            if not isinstance(login, str) or not login:
                continue
            source = row.get("tokenSource")
            accounts.append(CliAccount("gh", str(host), login, row.get("active") is True,
                                       _storage_kind(source if isinstance(source, str) else "")))
    return accounts


_GH_LOGIN_RE = re.compile(r"Logged in to (\S+) (?:account|as) (\S+?)(?: \(([^)]*)\))?\s*$")
_ACTIVE_RE = re.compile(r"Active account:\s*(true|false)", re.IGNORECASE)


def parse_auth_status_text(tool: str, text: str) -> list[CliAccount]:
    """Account lines only; token and scope lines are never kept."""
    accounts: list[CliAccount] = []
    for line in text.splitlines():
        match = _GH_LOGIN_RE.search(line)
        if match:
            accounts.append(CliAccount(tool, match.group(1).lower(), match.group(2), tool == "glab",
                                       _storage_kind(match.group(3) or "")))
            continue
        active = _ACTIVE_RE.search(line)
        if active and accounts:
            accounts[-1].active = active.group(1).lower() == "true"
    if tool == "gh":
        # Older gh lists one account per host, which is the active one.
        hosts: dict[str, list[CliAccount]] = {}
        for account in accounts:
            hosts.setdefault(account.host, []).append(account)
        for rows in hosts.values():
            if len(rows) == 1 and not any(_ACTIVE_RE.search(l) for l in text.splitlines()):
                rows[0].active = True
    return accounts


def yaml_token_hosts(text: str) -> dict[str, bool]:
    """Which hosts carry a non-empty token key. Values are looked at only to
    tell empty from non-empty; nothing of them is returned."""
    found: dict[str, bool] = {}
    stack: list[tuple[int, str]] = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        # A key ends at the first ":" followed by whitespace or the line end, so
        # a host:port key stays whole (R3-4).
        match = re.match(r"^(\s*)([^#\s]\S*?)\s*:(?:\s+(.*))?$", raw)
        if not match:
            continue
        indent = len(match.group(1).expandtabs(4))
        key = match.group(2).strip().strip("'\"")
        value_present = (match.group(3) or "").strip().split(" #")[0].strip() not in _YAML_EMPTY
        while stack and stack[-1][0] >= indent:
            stack.pop()
        if key.lower() in _YAML_TOKEN_KEYS and stack:
            # glab nests hosts under `hosts:`; gh's hosts.yml has them at the top.
            if stack[0][1] == "hosts":
                host = stack[1][1] if len(stack) > 1 else ""
            else:
                host = stack[0][1]
            if host:
                found[host.lower()] = found.get(host.lower(), False) or value_present
        if not (match.group(3) or "").strip():
            stack.append((indent, key))
    return {host: present for host, present in found.items() if present}


def _cli_config_files(ctx: ScanContext) -> list[tuple[str, Path]]:
    files: list[tuple[str, Path]] = []
    gh_dir = ctx.env.get("GH_CONFIG_DIR")
    if gh_dir:
        files.append(("gh", Path(gh_dir) / "hosts.yml"))
    else:
        xdg = ctx.env.get("XDG_CONFIG_HOME")
        if xdg:
            files.append(("gh", Path(xdg) / "gh" / "hosts.yml"))
        if ctx.roaming_app_data is not None:
            files.append(("gh", ctx.roaming_app_data / "GitHub CLI" / "hosts.yml"))
        files.append(("gh", ctx.home / ".config" / "gh" / "hosts.yml"))
    glab_dir = ctx.env.get("GLAB_CONFIG_DIR")
    if glab_dir:
        files.append(("glab", Path(glab_dir) / "config.yml"))
    if ctx.config_home is not None:
        files.append(("glab", ctx.config_home / "glab-cli" / "config.yml"))
    files.append(("glab", ctx.home / ".config" / "glab-cli" / "config.yml"))
    unique: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for tool, path in files:
        if str(path) not in seen:
            seen.add(str(path))
            unique.append((tool, path))
    return unique


def _scan_cli_accounts(ctx: ScanContext, out: _Collector, gh_only_contexts: set[str]) -> dict[str, str]:
    """Report gh / glab accounts; return the hosts the user's own CLI setup
    names (host -> tool), the only non-default hosts that get links or widen
    the keychain filter (CR-9)."""
    accounts: list[CliAccount] = []
    gh = ctx.which("gh")
    if gh:
        result = ctx.run([gh, "auth", "status", "--json", "hosts"], timeout=20)
        parsed = parse_gh_json(result.out) if result.code in (0, 1) else None
        if parsed is None:
            result = ctx.run([gh, "auth", "status"], timeout=20)
            parsed = parse_auth_status_text("gh", result.out + "\n" + result.err)
        accounts.extend(parsed)
    glab = ctx.which("glab")
    if glab:
        result = ctx.run([glab, "auth", "status"], timeout=20)
        accounts.extend(parse_auth_status_text("glab", result.out + "\n" + result.err))
    trusted: dict[str, str] = {account.host: account.tool for account in accounts if valid_host(account.host)}
    for account in accounts:
        out.item("cli-account", f"{account.tool} · {account.host} · {account.account}",
                 f"{account.tool}|{account.host}|{account.account}",
                 {"tool": account.tool, "host": account.host, "account": account.account,
                  "active": account.active, "storage": account.storage})

    by_host: dict[str, list[CliAccount]] = {}
    for account in accounts:
        if account.tool == "gh":
            by_host.setdefault(account.host, []).append(account)
    for host, rows in by_host.items():
        logins = sorted({row.account for row in rows})
        if len(logins) < 2:
            continue
        active = next((row.account for row in rows if row.active), "")
        gh_only = any(host in context for context in gh_only_contexts)
        out.finding(
            "gh-active-account-only", "medium", "cli-account", f"gh · {host}",
            params={"host": host, "accounts": ", ".join(logins), "active": active,
                    "helper_chain_gh_only": "true" if gh_only else "false"},
            links=_host_links(host, set(trusted), provider="gh"),
            steps=[["gh", "auth", "switch", "--hostname", StepValue(host), "--user", StepValue(login)]
                   for login in logins if login != active],
            actions=["gh-auth-switch"],
        )

    for tool, path in _cli_config_files(ctx):
        try:
            info = path.stat()
        except OSError:
            continue
        if not stat.S_ISREG(info.st_mode):
            continue
        text = read_text_capped(path)
        if text is None:
            continue
        hosts = yaml_token_hosts(text)
        del text
        for host in hosts:
            if valid_host(host):
                trusted.setdefault(host, tool)
        shown = _tilde(path, ctx.home)
        out.item("plaintext-file", shown, f"{tool}-config|{path}",
                 {"path": shown, "tool": tool, "mode": _mode_text(info.st_mode),
                  "token_present": bool(hosts)})
        for host in sorted(hosts):
            step = (["glab", "auth", "login", "--hostname", StepValue(host), "--use-keyring"] if tool == "glab"
                    else ["gh", "auth", "login", "--hostname", StepValue(host)])
            out.finding(
                "cli-token-plaintext", "medium", "cli-account", f"{shown} · {host}",
                params={"tool": tool, "host": host, "path": shown, "mode": _mode_text(info.st_mode)},
                links=_host_links(host, set(trusted), provider=tool),
                steps=[step],
                actions=["glab-login-keyring" if tool == "glab" else "gh-login-keyring"],
            )
    return trusted


# ── 3. SSH ──────────────────────────────────────────────────────────────────


@dataclass
class SshHost:
    patterns: list[str]
    identity_files: list[str] = field(default_factory=list)
    user: str = ""
    identities_only: str = ""
    use_keychain: str = ""


def _expand_identity(value: str, home: Path) -> str:
    text = value.strip().strip('"')
    text = text.replace("%d", str(home))
    if text.startswith("~"):
        text = str(home) + text[1:]
    path = Path(text)
    if not path.is_absolute():
        path = home / ".ssh" / path
    return os.path.normpath(str(path))


def parse_ssh_config(text: str, home: Path, *, base: Path | None = None, depth: int = 0) -> list[SshHost]:
    blocks: list[SshHost] = [SshHost(["*"])]
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        match = re.match(r"^(\S+?)\s*(?:=\s*|\s+)(.*)$", line)
        if not match:
            continue
        key, value = match.group(1).lower(), match.group(2).strip()
        if key == "host":
            blocks.append(SshHost([p for p in value.split() if p]))
        elif key == "match":
            blocks.append(SshHost(["match:" + value]))
        elif key == "include" and depth < 2:
            ssh_dir = base or home / ".ssh"
            for pattern in value.split():
                pattern = pattern.strip('"')
                if pattern.startswith("~"):
                    pattern = str(home) + pattern[1:]
                target = Path(pattern) if Path(pattern).is_absolute() else ssh_dir / pattern
                for match_path in sorted(target.parent.glob(target.name)):
                    included = read_text_capped(match_path)
                    if included is None:
                        continue
                    blocks.extend(parse_ssh_config(included, home, base=ssh_dir, depth=depth + 1)[1:])
        elif key == "identityfile":
            blocks[-1].identity_files.append(_expand_identity(value, home))
        elif key == "user":
            blocks[-1].user = value
        elif key == "identitiesonly":
            blocks[-1].identities_only = value.lower()
        elif key == "usekeychain":
            blocks[-1].use_keychain = value.lower()
    return blocks


def _read_key_header(path: Path) -> str | None:
    """The private-key format from the first line only; nothing past the first
    newline is kept (and at most 64 bytes are read)."""
    try:
        fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        head = b""
        while len(head) < 64:
            chunk = os.read(fd, 1)
            if not chunk or chunk == b"\n":
                break
            head += chunk
    except OSError:
        return None
    finally:
        os.close(fd)
    line = head.decode("ascii", "replace").strip()
    for prefix, kind in _KEY_HEADERS:
        if line.startswith(prefix):
            return kind
    return None


def _pub_algorithm(path: Path) -> str:
    text = read_text_capped(Path(str(path) + ".pub"), limit=64 * 1024)
    first = text.splitlines()[0].split() if text and text.splitlines() else []
    return first[0] if first else ""


def passphrase_state(ctx: ScanContext, keygen: str | None, path: Path, header: str = "") -> bool | None:
    """True = has a passphrase, False = none, None = could not tell.

    ``ssh-keygen -y -P "" -f key``: success means the empty passphrase opens
    it. Its stdout (the public key) is discarded, stdin is closed, and the
    environment has no askpass or display, so it cannot prompt.
    """
    if not keygen or header == "putty":
        # ssh-keygen cannot open a PuTTY key: a failure there says nothing.
        return None
    result = ctx.run([keygen, "-y", "-P", "", "-f", str(path)], timeout=10, capture=False)
    if result.code == 0:
        return False
    if result.code in (CODE_TIMEOUT, CODE_SPAWN_FAILED):
        return None
    return True


def _scan_ssh(ctx: ScanContext, out: _Collector) -> None:
    ssh_dir = ctx.home / ".ssh"
    config_path = ssh_dir / "config"
    config_text = read_text_capped(config_path)
    blocks: list[SshHost] = parse_ssh_config(config_text, ctx.home) if config_text is not None else []
    referenced: dict[str, list[str]] = {}
    for block in blocks:
        for identity in block.identity_files:
            referenced.setdefault(identity, []).extend(block.patterns)
    try:
        entries = sorted(ssh_dir.iterdir())
    except OSError:
        return
    keygen = ctx.which("ssh-keygen")
    for path in entries:
        name = path.name
        if name in _SSH_NOT_KEYS or name.endswith(".pub") or name.startswith("known_hosts"):
            continue
        try:
            info = path.stat()
        except OSError:
            continue
        if not stat.S_ISREG(info.st_mode):
            continue
        header = _read_key_header(path)
        if header is None:
            continue
        shown = _tilde(path, ctx.home)
        norm = os.path.normpath(str(path))
        hosts = [h for h in referenced.get(norm, []) if not h.startswith("match:")]
        has_passphrase = passphrase_state(ctx, keygen, path, header)
        detail: dict[str, Any] = {
            "path": shown, "format": header, "algorithm": _pub_algorithm(path),
            "mode": _mode_text(info.st_mode), "hosts": ", ".join(hosts),
            "default_name": name in _DEFAULT_IDENTITIES,
            "passphrase_checked": has_passphrase is not None,
        }
        if has_passphrase is not None:
            detail["has_passphrase"] = has_passphrase
        out.item("ssh-key", name, f"ssh|{norm}", detail)
        if ctx.enforces_modes and stat.S_IMODE(info.st_mode) & 0o077:
            out.finding("ssh-key-mode", "high", "ssh-key", shown,
                        params={"path": shown, "mode": _mode_text(info.st_mode)},
                        steps=[["chmod", "600", StepValue(str(path))]], actions=["chmod-600"])
        if has_passphrase is False:
            forge = sorted({h.lower() for h in hosts if h.lower() in _FORGE_HOSTS})
            if forge:
                for host in forge:
                    out.finding("ssh-no-passphrase-default-host", "high", "ssh-key",
                                f"{shown} · Host {host}",
                                params={"path": shown, "host": host},
                                links=_host_links(host, frozenset(), ssh=True),
                                steps=[["ssh-keygen", "-p", "-f", StepValue(str(path))]],
                                actions=["ssh-add-passphrase"])
            else:
                out.finding("ssh-no-passphrase", "medium", "ssh-key", shown,
                            params={"path": shown, "hosts": ", ".join(hosts)},
                            steps=[["ssh-keygen", "-p", "-f", StepValue(str(path))]],
                            actions=["ssh-add-passphrase"])
        if not hosts and name not in _DEFAULT_IDENTITIES and norm not in referenced:
            out.finding("ssh-key-unreferenced", "low", "ssh-key", shown, params={"path": shown})


# ── 4. Keyring metadata ─────────────────────────────────────────────────────


@dataclass
class KeyringReport:
    available: bool
    backend: str | None
    reason: str = ""
    items: list[dict[str, str]] = field(default_factory=list)


_KC_ATTR_RE = re.compile(r'^\s+"(\w{4})"<\w+>=(.*)$')


def _kc_value(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("<NULL>"):
        return ""
    quoted = re.search(r'"((?:[^"\\]|\\.)*)"', raw)
    if quoted is None:
        return ""
    return quoted.group(1).replace("\\000", "")


def parse_dump_keychain(text: str) -> list[dict[str, str]]:
    """Metadata of each item: class, svce, srvr, acct, ptcl, mdat — nothing else."""
    items: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in text.splitlines():
        if line.startswith("class:"):
            value = line.split(":", 1)[1].strip().strip('"')
            current = {"class": value}
            items.append(current)
            continue
        if current is None:
            continue
        match = _KC_ATTR_RE.match(line)
        if match and match.group(1) in {"svce", "srvr", "acct", "ptcl", "mdat"}:
            current[match.group(1)] = _kc_value(match.group(2))
    return items


def _kc_modified(text: str) -> str:
    match = re.match(r"^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z", text)
    if not match:
        return ""
    y, mo, d, h, mi, s = match.groups()
    return f"{y}-{mo}-{d}T{h}:{mi}:{s}Z"


_GENERIC_PREFIXES = ("gh:", "glab", "git:", "navide", "sourcetree")


def _keyring_darwin(ctx: ScanContext, git_hosts: set[str]) -> KeyringReport:
    security = ctx.which("security")
    if not security:
        return KeyringReport(False, "macos-keychain", "security-tool-not-found")
    result = ctx.run([security, "dump-keychain"], timeout=30)
    if result.code != 0:
        return KeyringReport(False, "macos-keychain", "dump-keychain-failed")
    report = KeyringReport(True, "macos-keychain")
    for item in parse_dump_keychain(result.out):
        cls = item.get("class", "")
        service = item.get("svce", "")
        server = item.get("srvr", "").lower()
        relevant = (cls == "inet" and server in git_hosts) or (
            cls == "genp" and service.lower().startswith(_GENERIC_PREFIXES))
        if relevant:
            report.items.append({
                "class": "internet-password" if cls == "inet" else "generic-password",
                "service": service, "server": server, "account": item.get("acct", ""),
                "protocol": item.get("ptcl", ""), "modified": _kc_modified(item.get("mdat", "")),
            })
    return report


def parse_cmdkey(text: str) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in text.splitlines():
        stripped = line.strip()
        lowered = stripped.lower()
        if lowered.startswith("target:"):
            current = {"target": stripped.split(":", 1)[1].strip()}
            items.append(current)
        elif current is not None and lowered.startswith("type:"):
            current["type"] = stripped.split(":", 1)[1].strip()
        elif current is not None and lowered.startswith("user:"):
            current["user"] = stripped.split(":", 1)[1].strip()
    return items


def _keyring_windows(ctx: ScanContext, git_hosts: set[str]) -> KeyringReport:
    cmdkey = ctx.which("cmdkey")
    if not cmdkey:
        return KeyringReport(False, "windows-credential-manager", "cmdkey-not-found")
    result = ctx.run([cmdkey, "/list"], timeout=20)
    if result.code != 0:
        return KeyringReport(False, "windows-credential-manager", "cmdkey-failed")
    report = KeyringReport(True, "windows-credential-manager")
    for item in parse_cmdkey(result.out):
        target = item.get("target", "")
        lowered = target.lower()
        if "git:" in lowered or "github" in lowered or "gitlab" in lowered or any(h in lowered for h in git_hosts):
            report.items.append({
                "class": "generic-credential", "service": re.sub(r"//[^/@\s]*@", "//", target),
                "server": "", "account": item.get("user", ""), "protocol": item.get("type", ""), "modified": "",
            })
    return report


_GVARIANT_PAIR_RE = re.compile(r"'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)'")
_SECRET_ATTR_KEYS = frozenset({"server", "user", "protocol", "service", "xdg:schema", "host", "account"})


def _keyring_linux(ctx: ScanContext, git_hosts: set[str]) -> KeyringReport:
    """Secret Service through D-Bus: SearchItems and item Attributes only —
    never GetSecret(s). Without it the keyring is reported unavailable; no
    plaintext store is read instead."""
    gdbus = ctx.which("gdbus")
    if not gdbus:
        return KeyringReport(False, "secret-service", "gdbus-not-found")
    base = [gdbus, "call", "--session", "--dest", "org.freedesktop.secrets"]
    result = ctx.run([*base, "--object-path", "/org/freedesktop/secrets", "--method",
                      "org.freedesktop.Secret.Service.SearchItems", "{}"], timeout=10)
    if result.code != 0:
        return KeyringReport(False, "secret-service", "secret-service-unavailable")
    report = KeyringReport(True, "secret-service")
    paths = re.findall(r"'(/org/freedesktop/secrets/collection/[^']+)'", result.out)[:200]
    for item_path in paths:
        attrs = ctx.run([*base, "--object-path", item_path, "--method",
                         "org.freedesktop.DBus.Properties.Get", "org.freedesktop.Secret.Item",
                         "Attributes"], timeout=5)
        if attrs.code != 0:
            continue
        pairs = {k: v for k, v in _GVARIANT_PAIR_RE.findall(attrs.out) if k in _SECRET_ATTR_KEYS}
        server = (pairs.get("server") or pairs.get("host") or "").lower()
        schema = pairs.get("xdg:schema", "")
        service = pairs.get("service", "")
        if server in git_hosts or schema == "org.git.Password" or service.lower().startswith(_GENERIC_PREFIXES):
            report.items.append({
                "class": schema or "secret-item", "service": service, "server": server,
                "account": pairs.get("user") or pairs.get("account", ""),
                "protocol": pairs.get("protocol", ""), "modified": "",
            })
    return report


#: Keyed by platform identity (osplat.platform_id), not a behaviour branch.
_KEYRING_READERS: dict[str, Callable[[ScanContext, set[str]], KeyringReport]] = {
    "darwin": _keyring_darwin,
    "win32": _keyring_windows,
    "linux": _keyring_linux,
}


def _scan_keyring(ctx: ScanContext, out: _Collector, git_hosts: set[str]) -> KeyringReport:
    reader = _KEYRING_READERS.get(ctx.platform, _keyring_linux)
    report = reader(ctx, git_hosts)
    for item in report.items:
        label = item.get("service") or item.get("server") or item.get("class", "")
        # A random id per scan (R2-8): a hash of the metadata would let a caller
        # confirm a guessed account name by recomputing it.
        out.item("keychain-item", label, "", dict(item), item_id=secrets.token_hex(8))
    if not report.available:
        out.finding("keyring-unavailable", "low", "keychain-item", f"keyring · {ctx.platform}",
                    params={"reason": report.reason, "platform": ctx.platform})
    return report


# ── 5. Repos and remotes ────────────────────────────────────────────────────


def _under(path: Path, roots: Sequence[Path]) -> bool:
    for root in roots:
        if path == root or root in path.parents:
            return True
    return False


@dataclass
class WalkBudget:
    """Shared by every root of one scan (CR-3): a directory count and a
    wall-clock deadline (``time.monotonic()``)."""

    dirs: int
    deadline: float

    def spent(self) -> bool:
        return self.dirs <= 0 or time.monotonic() >= self.deadline


def _dir_prefixes(dirs: Sequence[Path]) -> tuple[tuple[str, ...], frozenset[str]]:
    exact = frozenset(p for d in dirs for p in (os.path.normpath(str(d)), os.path.realpath(d)))
    return tuple(d.rstrip(os.sep) + os.sep for d in exact), exact


def find_repos(root: Path, system_dirs: Sequence[Path], *, limit: int = MAX_REPOS,
               depth: int = WALK_DEPTH, budget: WalkBudget | None = None,
               deadline: float | None = None) -> list[Path]:
    return find_repos_report(root, system_dirs, limit=limit, depth=depth, budget=budget, deadline=deadline)[0]


def find_repos_report(root: Path, system_dirs: Sequence[Path], *, limit: int = MAX_REPOS,
                      depth: int = WALK_DEPTH, budget: WalkBudget | None = None,
                      deadline: float | None = None) -> tuple[list[Path], bool]:
    """Repos (a ``.git`` dir or file) under ``root`` to ``depth``.

    System directories are matched as precomputed string prefixes, not by
    walking each path's parents (CR-3). ``budget`` is shared across roots;
    ``deadline`` additionally bounds this root.
    """
    if budget is None:
        budget = WalkBudget(MAX_WALK_DIRS, time.monotonic() + WALK_SECONDS)
    prefixes, exact = _dir_prefixes(system_dirs)
    stop_at = budget.deadline if deadline is None else min(deadline, budget.deadline)
    repos: list[Path] = []
    stack: list[tuple[str, int]] = [(os.path.normpath(str(root)), 0)]
    truncated = False
    while stack:
        if len(repos) >= limit or budget.dirs <= 0 or time.monotonic() >= stop_at:
            truncated = True  # the walk stopped with directories left (R2-5)
            break
        directory, level = stack.pop()
        budget.dirs -= 1
        if directory in exact or directory.startswith(prefixes):
            continue
        if os.path.lexists(os.path.join(directory, ".git")):
            repos.append(Path(directory))
        if level >= depth:
            continue
        try:
            with os.scandir(directory) as entries:
                children = sorted(
                    e.path for e in entries if e.is_dir(follow_symlinks=False)
                    and e.name not in _SKIP_DIR_NAMES and not e.name.startswith(".")
                )
        except OSError:
            continue
        stack.extend((child, level + 1) for child in reversed(children))
    return repos, truncated


@dataclass
class RepoConfig:
    remotes: list[tuple[str, RedactedUrl, str]]
    helpers: list[HelperEntry]
    skipped: bool = False  # not read: past the deadline or an irregular config file


def parse_repo_config(out: str, repo_t: str, home: Path) -> RepoConfig:
    """``remotes`` holds (name, redacted URL, kind) with kind ``url``,
    ``pushurl`` or ``insteadof`` (a ``url.<base>.insteadOf`` /
    ``pushInsteadOf`` key, whose *base* is where a token would sit)."""
    remotes: list[tuple[str, RedactedUrl, str]] = []
    helpers: list[HelperEntry] = []
    for record in out.split("\0"):
        if not record:
            continue
        key, _, value = record.partition("\n")
        lower = key.lower()
        if lower.startswith("remote.") and lower.endswith(".url"):
            remotes.append((key[len("remote."):-len(".url")], redact_url(value), "url"))
            del value
        elif lower.startswith("remote.") and lower.endswith(".pushurl"):
            remotes.append((key[len("remote."):-len(".pushurl")], redact_url(value), "pushurl"))
            del value
        elif lower.startswith("url.") and (lower.endswith(".insteadof") or lower.endswith(".pushinsteadof")):
            suffix = ".pushinsteadof" if lower.endswith(".pushinsteadof") else ".insteadof"
            label = "url.pushInsteadOf" if suffix == ".pushinsteadof" else "url.insteadOf"
            remotes.append((label, redact_url(key[len("url."):-len(suffix)]), "insteadof"))
        elif lower.startswith("credential.") and lower.endswith(".helper"):
            middle = key[len("credential."):-len(".helper")]
            context, masked = _helper_context(middle)
            helpers.append(HelperEntry("local", repo_t, context, helper_name(value), masked))
    return RepoConfig(remotes, helpers)


def _config_is_regular(repo: Path) -> bool:
    """A ``.git`` directory's ``config`` must be a regular file (R2-6); a
    ``.git`` file (worktree, submodule) is left to git to resolve."""
    git_entry = repo / ".git"
    try:
        if stat.S_ISDIR(os.lstat(git_entry).st_mode):
            return stat.S_ISREG(os.lstat(git_entry / "config").st_mode)
        return stat.S_ISREG(os.lstat(git_entry).st_mode)
    except OSError:
        return False


def _read_repo(ctx: ScanContext, git: str, repo: Path, deadline: float | None = None) -> RepoConfig:
    remaining = 10.0 if deadline is None else min(10.0, deadline - time.monotonic())
    if remaining <= 0 or not _config_is_regular(repo):
        return RepoConfig([], [], skipped=True)
    result = ctx.run([git, "-C", str(repo), "config", "--local", "-z", "--get-regexp",
                      r"^(remote\..*\.(url|pushurl)|credential\..*|url\..*\.(insteadof|pushinsteadof))$"],
                     timeout=remaining)
    if result.code in (CODE_TIMEOUT, CODE_SPAWN_FAILED):
        return RepoConfig([], [], skipped=True)
    if result.code != 0:
        return RepoConfig([], [])
    return parse_repo_config(result.out, _tilde(repo, ctx.home), ctx.home)


def _clean_url(r: RedactedUrl) -> str:
    if "http" in r.scheme:
        user = "" if r.user.lower() in _PSEUDO_USERS else r.user
        netloc = (f"{user}@" if user else "") + (r.hostport or r.host)
        return urlunsplit((r.scheme, netloc, r.path, "", ""))
    return r.url


# ── 6. Environment and shell rc ─────────────────────────────────────────────


def env_name_matches(name: str) -> bool:
    upper = name.upper()
    if upper.startswith(_ENV_OWN_PREFIXES):
        return False
    return upper in _ENV_ALLOWLIST or upper.endswith(_ENV_SUFFIXES)


def _literal_value(value: str) -> bool:
    text = value.strip().split(" #")[0].strip().rstrip(";").strip()
    text = text.strip("'\"")
    return bool(text) and not text.startswith(("$", "`", "("))


def _scan_env(ctx: ScanContext, out: _Collector) -> None:
    for name in sorted(ctx.env):
        if env_name_matches(name) and ctx.env.get(name):
            out.item("env-var", name, f"process|{name}", {"source": "process", "set": True})
            out.finding("env-token-set", "low", "env-var", f"env · {name}", params={"name": name})
    for rel in _SHELL_RC_FILES:
        path = ctx.home / rel
        text = read_text_capped(path)
        if text is None:
            continue
        shown = _tilde(path, ctx.home)
        for number, line in enumerate(text.splitlines(), start=1):
            match = _RC_EXPORT_RE.match(line)
            if not match or not env_name_matches(match.group(1)):
                continue
            literal = _literal_value(match.group(2))
            name = match.group(1)
            if not literal:
                continue
            out.item("env-var", name, f"rc|{path}|{number}|{name}",
                     {"source": "shell-rc", "file": shown, "line": number, "set": True})
            out.finding("env-token-in-shell-rc", "medium", "env-var", f"{shown}:{number} · {name}",
                        params={"name": name, "file": shown, "line": str(number)})
        del text


# ── 7. Plaintext credential files ───────────────────────────────────────────


def _scan_plaintext_files(ctx: ScanContext, out: _Collector) -> None:
    xdg = ctx.env.get("XDG_CONFIG_HOME")
    candidates = [ctx.home / ".git-credentials",
                  (Path(xdg) if xdg else ctx.home / ".config") / "git" / "credentials",
                  ctx.home / ".netrc", ctx.home / "_netrc"]
    seen: set[str] = set()
    for path in candidates:
        if str(path) in seen:
            continue
        seen.add(str(path))
        try:
            info = path.stat()
        except OSError:
            continue
        if not stat.S_ISREG(info.st_mode):
            continue
        shown = _tilde(path, ctx.home)
        out.item("plaintext-file", shown, f"plain|{path}",
                 {"path": shown, "mode": _mode_text(info.st_mode), "exists": True})
        out.finding("plaintext-credential-file", "medium", "plaintext-file", shown,
                    params={"path": shown, "mode": _mode_text(info.st_mode)})


# ── The scan ────────────────────────────────────────────────────────────────


def run_scan(ctx: ScanContext, *, repo_executor: ThreadPoolExecutor | None = None) -> dict[str, Any]:
    """One full read-only scan. Returns the result without reminder state."""
    started = time.monotonic()
    out = _Collector()
    git = ctx.which("git")
    global_entries: list[HelperEntry] = []
    gh_only: set[str] = set()
    if git:
        global_entries, gh_only = _scan_global_helpers(ctx, git, out)

    trusted = _scan_cli_accounts(ctx, out, gh_only)

    roots_out: list[dict[str, Any]] = []
    repo_list: list[Path] = []
    repo_root: list[int] = []
    seen_repos: set[str] = set()
    budget = WalkBudget(MAX_WALK_DIRS, time.monotonic() + WALK_SECONDS)
    for root_path, source in ctx.roots:
        root = Path(root_path)
        if not root.is_dir():
            found, truncated = [], False
        elif budget.spent():
            found, truncated = [], True
        else:
            found, truncated = find_repos_report(root, ctx.system_dirs, limit=MAX_REPOS, budget=budget,
                                                 deadline=time.monotonic() + ROOT_WALK_SECONDS)
        entry = {"path": _tilde(root, ctx.home), "source": source, "repo_count": len(found),
                 "truncated": truncated}
        roots_out.append(entry)
        for repo in found:
            key = os.path.realpath(repo)
            if key in seen_repos:
                continue
            if len(repo_list) >= MAX_REPOS:
                entry["truncated"] = True
                continue
            seen_repos.add(key)
            repo_list.append(repo)
            repo_root.append(len(roots_out) - 1)

    configs: list[RepoConfig] = []
    if git and repo_list:
        read_deadline = time.monotonic() + REPO_READ_SECONDS
        if repo_executor is not None:
            configs = list(repo_executor.map(lambda r: _read_repo(ctx, git, r, read_deadline), repo_list))
        else:
            with ThreadPoolExecutor(max_workers=max(1, ctx.repo_workers),
                                    thread_name_prefix="navide-credscan-git") as pool:
                configs = list(pool.map(lambda r: _read_repo(ctx, git, r, read_deadline), repo_list))
    for index, config in zip(repo_root, configs):
        if config.skipped:
            roots_out[index]["truncated"] = True

    for repo, config in zip(repo_list, configs):
        repo_t = _tilde(repo, ctx.home)
        _local_helper_findings(str(repo), repo_t, config.helpers, global_entries, out)
        for remote, redacted, kind in config.remotes:
            if "http" not in redacted.scheme or not redacted.has_userinfo:
                continue
            label = f"{remote} (push)" if kind == "pushurl" else remote
            location = f"{repo_t} · {label} · {redacted.url}"
            out.item("remote", f"{repo_t} · {label}", f"remote|{repo}|{kind}|{remote}|{redacted.url}",
                     {"repo": repo_t, "remote": label, "host": redacted.host, "url": redacted.url,
                      "token_present": redacted.token_present})
            if not redacted.token_present:
                continue
            manual = False
            if kind == "insteadof":
                # The real key still holds the token; no command could name it.
                steps: list[list[str]] = []
                actions = ["inspect-url-rewrite"]
                manual = True
            else:
                push = ["--push"] if kind == "pushurl" else []
                steps = [["git", "-C", StepValue(str(repo)), "remote", "set-url", *push, "--",
                          RemoteName(remote), StepValue(_clean_url(redacted))]]
                actions = ["remote-set-url"]
            out.finding(
                "url-token", "high", "remote", location,
                params={"repo": repo_t, "remote": label, "host": redacted.host,
                        "url": redacted.url, "token": "present (redacted)"},
                links=_host_links(redacted.host, set(trusted), provider=trusted.get(redacted.host, "")),
                steps=steps,
                actions=actions,
                manual=manual,
            )

    _scan_ssh(ctx, out)
    # Only hosts the user's own setup names widen the keychain filter, never a
    # host read from some repository's config (CR-9).
    keyring = _scan_keyring(ctx, out, set(_FORGE_HOSTS) | set(trusted))
    _scan_env(ctx, out)
    _scan_plaintext_files(ctx, out)

    out.findings.sort(key=lambda f: (_SEVERITY_ORDER.get(f["severity"], 9), f["code"], f["location"]))
    keyring_out: dict[str, Any] = {"available": keyring.available, "backend": keyring.backend}
    if keyring.reason:
        keyring_out["reason"] = keyring.reason
    duration_ms = int((time.monotonic() - started) * 1000)
    log.info("credentials scan: %d repos, %d items, %d findings in %d ms",
             len(repo_list), len(out.items), len(out.findings), duration_ms)
    return {
        "platform": ctx.platform,
        "complete": not any(root["truncated"] for root in roots_out),
        "duration_ms": duration_ms,
        "keyring": keyring_out,
        "roots": roots_out,
        "items": out.items,
        "findings": out.findings,
    }


# ── Reminders ───────────────────────────────────────────────────────────────


def reminder_for(finding_id: str, reminders: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    entry = reminders.get(finding_id)
    if not isinstance(entry, dict):
        return {"state": "active"}
    state = entry.get("state")
    if state == "dismissed":
        return {"state": "dismissed"}
    if state == "snoozed":
        until = _parse_iso(entry.get("until"))
        if until is not None and until > now:
            return {"state": "snoozed", "until": _now_iso(until)}
    return {"state": "active"}


def apply_reminders(raw: Mapping[str, Any], reminders: Mapping[str, Any], now: datetime) -> list[dict[str, Any]]:
    return [{**f, "reminder": reminder_for(f["id"], reminders, now)} for f in raw["findings"]]


def summarize(findings: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    summary = {"high": 0, "medium": 0, "low": 0, "active_reminders": 0}
    for finding in findings:
        if finding["severity"] in summary:
            summary[finding["severity"]] += 1
        if finding["reminder"]["state"] == "active":
            summary["active_reminders"] += 1
    return summary


class RequestError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def validate_roots(raw: Any, system_dirs: Sequence[Path]) -> list[str]:
    if not isinstance(raw, list):
        raise RequestError("invalid-roots", "roots must be a list of absolute paths")
    if len(raw) > MAX_ROOTS:
        raise RequestError("too-many-roots", f"at most {MAX_ROOTS} roots")
    out: list[str] = []
    for item in raw:
        path = check_root(item, system_dirs)
        if path not in out:
            out.append(path)
    return out


def check_root(item: Any, system_dirs: Sequence[Path]) -> str:
    """One scan root, symlinks resolved *before* it is judged (CR-8); the
    resolved path is what gets stored and walked."""
    if not isinstance(item, str) or not item.strip():
        raise RequestError("invalid-root", "each root must be a non-empty string")
    text = item.strip()
    if not os.path.isabs(text):
        raise RequestError("invalid-root", f"not an absolute path: {text}")
    path = Path(os.path.realpath(text))
    if path.parent == path:
        raise RequestError("invalid-root", f"a filesystem root cannot be scanned: {text}")
    if not path.is_dir():
        raise RequestError("invalid-root", f"not an existing folder: {text}")
    resolved_system = [Path(os.path.realpath(d)) for d in system_dirs]
    if _under(path, system_dirs) or _under(path, resolved_system):
        raise RequestError("forbidden-root", f"a system or credential folder cannot be a scan root: {text}")
    return str(path)


# ── Service ─────────────────────────────────────────────────────────────────

#: Dedicated threads: the scan never waits on (or starves) the shared pool.
_SCAN_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="navide-credscan")
_KV_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="navide-credscan-kv")
_REPO_EXECUTOR = ThreadPoolExecutor(max_workers=6, thread_name_prefix="navide-credscan-git")


def _default_db() -> Any:
    from . import app

    return app.database


def _default_workspace_roots() -> list[str]:
    from . import app

    paths: list[str] = []
    for entry in app.recent_workspaces_store.list():
        path = entry.get("path") if isinstance(entry, dict) else None
        if isinstance(path, str) and path and entry.get("exists", True):
            paths.append(path)
    return paths


class CredentialsService:
    def __init__(
        self,
        *,
        db_getter: Callable[[], Any] = _default_db,
        workspace_roots: Callable[[], list[str]] = _default_workspace_roots,
        context_factory: Callable[[list[tuple[str, str]]], ScanContext] = default_context,
        system_dirs: Callable[[], list[Path]] = lambda: list(osplat.paths.system_dirs()),
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self._db_getter = db_getter
        self._workspace_roots = workspace_roots
        self._context_factory = context_factory
        self._system_dirs = system_dirs
        self._clock = clock
        self._cache: tuple[float, dict[str, Any]] | None = None
        self._inflight: asyncio.Future[dict[str, Any]] | None = None
        #: Bumped whenever the roots change; a scan that started under an
        #: older generation is returned to its waiters but never cached (R2-7).
        self._roots_generation = 0
        self._inflight_generation = 0

    # KV ------------------------------------------------------------------
    def _kv_get(self, key: str, default: Any) -> Any:
        value = self._db_getter().kv_get(key, default)
        return value

    def _kv_set(self, key: str, value: Any) -> None:
        self._db_getter().kv_set(key, value, now=int(time.time()))

    def user_roots(self) -> list[str]:
        raw = self._kv_get(ROOTS_KV_KEY, [])
        return [r for r in raw if isinstance(r, str)] if isinstance(raw, list) else []

    def reminders(self) -> dict[str, Any]:
        raw = self._kv_get(REMINDERS_KV_KEY, {})
        return raw if isinstance(raw, dict) else {}

    # Roots -----------------------------------------------------------------
    def roots_set(self, raw: Any) -> list[str]:
        roots = validate_roots(raw, self._system_dirs())
        self._kv_set(ROOTS_KV_KEY, roots)
        self._roots_generation += 1
        self._cache = None
        return roots

    # Reminders -------------------------------------------------------------
    def reminder_set(self, finding_id: Any, state: Any, days: Any = None) -> dict[str, Any]:
        if not isinstance(finding_id, str) or not re.fullmatch(r"[0-9a-f]{16}", finding_id):
            raise RequestError("invalid-id", "id must be a finding id")
        if state not in {"active", "snoozed", "dismissed"}:
            raise RequestError("invalid-state", "state must be active, snoozed or dismissed")
        now = self._clock()
        reminders = dict(self.reminders())
        # Expired snoozes are dropped whenever the document is written.
        for key, entry in list(reminders.items()):
            if isinstance(entry, dict) and entry.get("state") == "snoozed":
                until = _parse_iso(entry.get("until"))
                if until is None or until <= now:
                    reminders.pop(key)
        if state == "active":
            reminders.pop(finding_id, None)
            result: dict[str, Any] = {"state": "active"}
        elif state == "dismissed":
            reminders[finding_id] = {"state": "dismissed"}
            result = {"state": "dismissed"}
        else:
            if days is None:
                days = SNOOZE_DEFAULT_DAYS
            if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= SNOOZE_MAX_DAYS:
                raise RequestError("invalid-days", f"days must be an integer from 1 to {SNOOZE_MAX_DAYS}")
            until = _now_iso(now + timedelta(days=days))
            reminders[finding_id] = {"state": "snoozed", "until": until}
            result = {"state": "snoozed", "until": until}
        if len(reminders) > MAX_REMINDERS:
            for key in list(reminders)[: len(reminders) - MAX_REMINDERS]:
                reminders.pop(key)
        self._kv_set(REMINDERS_KV_KEY, reminders)
        return result

    # Scan ------------------------------------------------------------------
    def _roots(self) -> list[tuple[str, str]]:
        roots: list[tuple[str, str]] = []
        seen: set[str] = set()
        try:
            workspace = self._workspace_roots()
        except Exception:  # noqa: BLE001 - an unreadable recent list scans nothing from it
            log.warning("credentials scan: workspace list unavailable")
            workspace = []
        system_dirs = self._system_dirs()
        for path, source in [*((p, "workspace") for p in workspace), *((p, "user") for p in self.user_roots())]:
            try:
                norm = check_root(path, system_dirs)
            except RequestError:
                continue  # workspace roots get the same validation as user roots
            if norm in seen:
                continue
            seen.add(norm)
            roots.append((norm, source))
        return roots

    def _scan_blocking(self) -> dict[str, Any]:
        ctx = self._context_factory(self._roots())
        return run_scan(ctx, repo_executor=_REPO_EXECUTOR)

    def _compose(self, raw: dict[str, Any], scanned_at: datetime) -> dict[str, Any]:
        now = self._clock()
        findings = apply_reminders(raw, self.reminders(), now)
        return {
            "ok": True,
            "complete": raw.get("complete", True),
            "scanned_at": _now_iso(scanned_at),
            "duration_ms": raw["duration_ms"],
            "platform": raw["platform"],
            "keyring": raw["keyring"],
            "roots": raw["roots"],
            "summary": summarize(findings),
            "items": raw["items"],
            "findings": findings,
        }

    async def _refresh(self) -> dict[str, Any]:
        generation = self._roots_generation
        try:
            raw = await asyncio.get_running_loop().run_in_executor(_SCAN_EXECUTOR, self._scan_blocking)
            raw = {**raw, "_scanned_at": self._clock()}
            if generation == self._roots_generation:
                self._cache = (time.monotonic(), raw)
            return raw
        finally:
            if self._inflight_generation == generation:
                self._inflight = None

    async def scan(self, *, force: bool = False) -> dict[str, Any]:
        """At most one scan runs; nobody waits on it who need not (CR-3).

        A fresh cached result is served as is. While a refresh is running,
        a non-forced caller gets the previous result instead of queueing; a
        forced caller (or one with nothing cached) joins the running scan.
        """
        cached = self._cache
        fresh = cached is not None and time.monotonic() - cached[0] < CACHE_SECONDS
        if not force and cached is not None and (fresh or self._inflight is not None):
            raw = cached[1]
        else:
            # A running scan from an older roots generation is not joined: it
            # scans roots that are no longer configured (R3-2).
            if self._inflight is None or self._inflight_generation != self._roots_generation:
                self._inflight_generation = self._roots_generation
                self._inflight = asyncio.ensure_future(self._refresh())
            raw = await asyncio.shield(self._inflight)
        return await asyncio.get_running_loop().run_in_executor(
            _KV_EXECUTOR, self._compose, raw, raw["_scanned_at"])


_service: CredentialsService | None = None


def service() -> CredentialsService:
    global _service
    if _service is None:
        _service = CredentialsService()
    return _service


def set_service(svc: CredentialsService | None) -> None:
    """Tests swap in a service built on fakes."""
    global _service
    _service = svc


# ── WS handlers (registered at the end of ws_handlers.py) ───────────────────


def _error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": message, "error_code": code}


async def _answer(session: "Session", msg_id: str, msg_type: str, work: Callable[[], Any]) -> None:
    try:
        result = await work()
    except RequestError as err:
        result = _error(err.code, err.message)
    except Exception as err:  # noqa: BLE001 - answer instead of dropping; never log details
        log.warning("%s failed (%s)", msg_type, type(err).__name__)
        result = _error("internal-error", f"{msg_type} failed")
    await session.send_json(make_response(msg_id, msg_type, result))


async def ws_scan(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    force = isinstance(payload, dict) and payload.get("force") is True

    async def work() -> dict[str, Any]:
        return await service().scan(force=force)

    await _answer(session, msg_id, msg_type, work)


async def ws_roots_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        roots = await asyncio.get_running_loop().run_in_executor(_KV_EXECUTOR, service().user_roots)
        return {"ok": True, "roots": roots}

    await _answer(session, msg_id, msg_type, work)


async def ws_roots_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    raw = payload.get("roots") if isinstance(payload, dict) else None

    async def work() -> dict[str, Any]:
        roots = await asyncio.get_running_loop().run_in_executor(_KV_EXECUTOR, service().roots_set, raw)
        return {"ok": True, "roots": roots}

    await _answer(session, msg_id, msg_type, work)


async def ws_reminder_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    body = payload if isinstance(payload, dict) else {}

    async def work() -> dict[str, Any]:
        reminder = await asyncio.get_running_loop().run_in_executor(
            _KV_EXECUTOR, service().reminder_set, body.get("id"), body.get("state"), body.get("days"))
        return {"ok": True, "reminder": reminder}

    await _answer(session, msg_id, msg_type, work)


MESSAGE_HANDLERS: dict[str, Callable[..., Any]] = {
    "credentials.scan": ws_scan,
    "credentials.roots.get": ws_roots_get,
    "credentials.roots.set": ws_roots_set,
    "credentials.reminder.set": ws_reminder_set,
}
