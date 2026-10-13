"""Read-only credentials and keys scan (credentials_scan).

The assertions that matter most are negative: a sentinel secret planted
wherever a real tool or file could hold one (a remote URL, a glab config, a
shell rc, the process env, gh/glab/security output, an inline helper body, a
private key body) must appear nowhere in what the scan returns, logs, answers
over WS or MCP, or stores in KV — and the scan must not write a single file.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import credentials_scan as cs
from agent_team_backend.db import Database

SENT = "SENTINELq7Zx"
GLPAT = f"glpat-{SENT}abcdefghij"
GHP = f"ghp_{SENT}0123456789abcdef01234567"
PASSPHRASE = f"{SENT}-PASSPHRASE"

GIT = shutil.which("git")
needs_git = pytest.mark.skipif(GIT is None, reason="git is required for the real repo fixture")

OPENSSH_HEADER = "-----BEGIN " + "OPENSSH PRIVATE KEY-----\n"


def _git_env(home: Path) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({"HOME": str(home), "USERPROFILE": str(home), "GIT_CONFIG_NOSYSTEM": "1"})
    env.pop("XDG_CONFIG_HOME", None)
    return env


def _git(home: Path, *args: str) -> None:
    subprocess.run([GIT, *args], check=True, env=_git_env(home), capture_output=True)


def _write_key(path: Path, mode: int = 0o600) -> None:
    path.write_text(OPENSSH_HEADER + f"b3BlbnNzaC1rZXktdjE{SENT}KEYBODY\n-----END " + "OPENSSH PRIVATE KEY-----\n")
    Path(str(path) + ".pub").write_text("ssh-ed25519 AAAAC3Nza me@example\n")
    os.chmod(path, mode)


@pytest.fixture
def home(tmp_path: Path) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    (home / ".gitconfig").write_text(
        "[credential]\n"
        "\thelper = osxkeychain\n"
        "\thelper = osxkeychain\n"
        '[credential "https://github.com"]\n'
        "\thelper = \n"
        "\thelper = !/opt/homebrew/bin/gh auth git-credential\n"
        '[credential "https://example.com"]\n'
        f'\thelper = "!f() {{ echo password={SENT}; }}; f"\n'
    )
    ssh = home / ".ssh"
    ssh.mkdir()
    (ssh / "config").write_text(
        "Host github.com\n  IdentityFile ~/.ssh/id_work\n  IdentitiesOnly yes\n"
        "Host lab\n  HostName git.lab.example\n  IdentityFile ~/.ssh/id_locked\n"
    )
    _write_key(ssh / "id_work")
    _write_key(ssh / "id_locked")
    _write_key(ssh / "stray_key", mode=0o644)
    (ssh / "known_hosts").write_text("github.com ssh-ed25519 AAAA\n")
    glab = home / ".config" / "glab-cli"
    glab.mkdir(parents=True)
    (glab / "config.yml").write_text(
        "git_protocol: ssh\nhosts:\n    gitlab.com:\n"
        f"        token: {GLPAT}\n        user: nt.fitbody\n"
        f"        oauth2_refresh_token: {SENT}refresh\n"
        "    gitlab.example.org:\n        token: \n        user: someone\n"
    )
    (home / ".zshrc").write_text(
        "alias ll='ls -l'\n"
        f"export GH_TOKEN={GHP}\n"
        "export OPENAI_API_KEY=$(op read op://vault/openai)\n"
        "export EDITOR=vim\n"
    )
    (home / ".git-credentials").write_text(f"https://nt:{GLPAT}@gitlab.com\n")
    os.chmod(home / ".git-credentials", 0o600)
    return home


@pytest.fixture
def work(home: Path) -> Path:
    if GIT is None:
        pytest.skip("git missing")
    work = home / "work"
    repo = work / "proj"
    repo.mkdir(parents=True)
    _git(home, "-C", str(repo), "-c", "init.defaultBranch=main", "init", "-q")
    _git(home, "-C", str(repo), "remote", "add", "origin", f"https://oauth2:{GLPAT}@gitlab.com/grp/proj.git")
    _git(home, "-C", str(repo), "remote", "add", "gh", f"https://{GHP}@github.com/o/r.git")
    _git(home, "-C", str(repo), "remote", "add", "plain", "git@github.com:o/r.git")
    _git(home, "-C", str(repo), "config", "--local", "credential.helper", "store")
    # A clean repo nested deeper, and one inside node_modules that must be skipped.
    clean = work / "a" / "clean"
    clean.mkdir(parents=True)
    _git(home, "-C", str(clean), "-c", "init.defaultBranch=main", "init", "-q")
    _git(home, "-C", str(clean), "remote", "add", "origin", "https://github.com/o/clean.git")
    skipped = work / "node_modules" / "dep"
    skipped.mkdir(parents=True)
    _git(home, "-C", str(skipped), "-c", "init.defaultBranch=main", "init", "-q")
    return work


GH_TEXT = (
    "github.com\n"
    "  ✓ Logged in to github.com account nt-nerdtechnic (keyring)\n"
    "  - Active account: false\n"
    "  - Git operations protocol: https\n"
    f"  - Token: {GHP}\n"
    "\n"
    "  ✓ Logged in to github.com account nt-neil (keyring)\n"
    "  - Active account: true\n"
    f"  - Token: {GHP}\n"
)
GLAB_TEXT = (
    "gitlab.com\n"
    "  ✓ Logged in to gitlab.com as nt.fitbody (/home/x/.config/glab-cli/config.yml)\n"
    f"  ✓ Token: {GLPAT}\n"
)
DUMP_KEYCHAIN = (
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"\n'
    "version: 512\n"
    'class: "inet"\n'
    "attributes:\n"
    '    0x00000007 <blob>="gitlab.com"\n'
    '    "acct"<blob>="nt"\n'
    f'    "desc"<blob>="{SENT}"\n'
    '    "mdat"<timedate>=0x32303234  "20240102030405Z\\000"\n'
    '    "ptcl"<uint32>="htps"\n'
    '    "srvr"<blob>="gitlab.com"\n'
    'class: "genp"\n'
    "attributes:\n"
    '    "acct"<blob>="nt-neil"\n'
    f'    "gena"<blob>="{SENT}"\n'
    '    "svce"<blob>="gh:github.com"\n'
    'class: "genp"\n'
    "attributes:\n"
    '    "acct"<blob>="me"\n'
    '    "svce"<blob>="Some Unrelated App"\n'
)


class FakeTools:
    """Real git (against the fake HOME); canned gh/glab/security/ssh-keygen
    that print the sentinel wherever a real tool might print a secret."""

    def __init__(self, home: Path, *, present: set[str] | None = None, no_passphrase: set[str] | None = None):
        self.home = home
        self.present = present if present is not None else {"git", "gh", "glab", "security", "ssh-keygen"}
        self.no_passphrase = no_passphrase if no_passphrase is not None else {"id_work", "stray_key"}
        self.calls: list[list[str]] = []

    def which(self, name: str) -> str | None:
        if name not in self.present:
            return None
        return GIT if name == "git" else f"/fake/bin/{name}"

    def run(self, argv, *, timeout: float = 15.0, capture: bool = True) -> cs.RunResult:
        argv = list(argv)
        self.calls.append(argv)
        assert timeout and timeout > 0
        tool = Path(argv[0]).name
        if tool == "git" or argv[0] == GIT:
            proc = subprocess.run(argv, capture_output=True, env=_git_env(self.home), timeout=timeout,
                                  stdin=subprocess.DEVNULL)
            return cs.RunResult(proc.returncode, proc.stdout.decode(), proc.stderr.decode())
        if tool == "gh":
            if "--json" in argv:
                return cs.RunResult(1, "", f"unknown flag: --json {GHP}")
            return cs.RunResult(0, GH_TEXT, "")
        if tool == "glab":
            return cs.RunResult(0, "", GLAB_TEXT)
        if tool == "security":
            return cs.RunResult(0, DUMP_KEYCHAIN, "")
        if tool == "ssh-keygen":
            assert capture is False, "the ssh-keygen probe must discard what it prints"
            return cs.RunResult(0 if Path(argv[-1]).name in self.no_passphrase else 255)
        return cs.RunResult(cs.CODE_SPAWN_FAILED)


def _ctx(home: Path, tools: FakeTools, roots: list[tuple[str, str]], *, platform: str = "darwin",
         env: dict[str, str] | None = None) -> cs.ScanContext:
    return cs.ScanContext(
        home=home,
        env=env if env is not None else {"HOME": str(home), "PATH": "/usr/bin", "GITHUB_TOKEN": GHP,
                                         "NAVIDE_PANE_TOKEN": "x", "EDITOR": "vim"},
        roots=roots,
        run=tools.run,
        which=tools.which,
        platform=platform,
        system_dirs=[home / ".ssh"],
        enforces_modes=True,
        config_home=home / ".config",
        roaming_app_data=None,
        repo_workers=2,
    )


def _snapshot(root: Path) -> dict[str, tuple[bytes, int]]:
    snap = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and not path.is_symlink():
            snap[str(path)] = (path.read_bytes(), path.stat().st_mtime_ns)
    return snap


def _codes(result: dict[str, Any]) -> list[tuple[str, str]]:
    return sorted((f["code"], f["severity"]) for f in result["findings"])


def _step_path_ok(path: Path) -> bool:
    """Whether ``path`` passes the copyable-step allowlist on this platform."""
    return cs.safe_command("x", cs.StepValue(str(path))) is not None


def _forbidden(argv: list[str]) -> bool:
    joined = " ".join(argv)
    tool = Path(argv[0]).name
    if tool == "gh" and ("token" in argv[1:3] or "--show-token" in argv or "-t" in argv):
        return True
    if tool == "glab" and "--show-token" in argv:
        return True
    if tool == "security" and any(a in argv for a in ("-w", "-g", "-d", "find-generic-password",
                                                     "find-internet-password")):
        return True
    if tool == "git" and "credential" in argv and "fill" in argv:
        return True
    return "GetSecret" in joined or "secret-tool" in joined


# ── The full scan ───────────────────────────────────────────────────────────


@needs_git
def test_scan_finds_each_problem_with_the_right_code_and_severity(home, work):
    tools = FakeTools(home)
    result = cs.run_scan(_ctx(home, tools, [(str(work), "user")]))
    codes = _codes(result)
    assert codes.count(("url-token", "high")) == 2
    assert ("ssh-no-passphrase-default-host", "high") in codes
    assert ("ssh-no-passphrase", "medium") in codes          # stray_key
    assert ("ssh-key-unreferenced", "low") in codes          # stray_key
    assert ("ssh-key-mode", "high") in codes                 # stray_key is 0644
    assert ("cli-token-plaintext", "medium") in codes        # glab config, gitlab.com only
    assert ("gh-active-account-only", "medium") in codes
    assert ("helper-duplicate", "low") in codes              # osxkeychain twice
    assert ("helper-shadowed", "low") in codes               # repo-local store after osxkeychain
    assert ("env-token-in-shell-rc", "medium") in codes      # GH_TOKEN literal; $(op read) is not
    assert ("env-token-set", "low") in codes
    assert ("plaintext-credential-file", "medium") in codes
    assert not any(c == "keyring-unavailable" for c, _ in codes)
    assert all(c in cs.FINDING_CODES for c, _ in codes)

    by_code = {f["code"]: f for f in result["findings"]}
    plaintext = [f for f in result["findings"] if f["code"] == "cli-token-plaintext"]
    assert [f["params"]["host"] for f in plaintext] == ["gitlab.com"]
    rc = by_code["env-token-in-shell-rc"]
    assert rc["location"] == "~/.zshrc:2 · GH_TOKEN"
    env_names = {f["params"]["name"] for f in result["findings"] if f["code"] == "env-token-set"}
    assert env_names == {"GITHUB_TOKEN"}
    gh = by_code["gh-active-account-only"]
    assert gh["params"]["active"] == "nt-neil"
    assert gh["params"]["helper_chain_gh_only"] == "true"
    assert gh["steps"] == ["gh auth switch --hostname github.com --user nt-nerdtechnic"]
    default_host = by_code["ssh-no-passphrase-default-host"]
    assert default_host["location"] == "~/.ssh/id_work · Host github.com"
    assert default_host["links"][0]["url"] == "https://github.com/settings/keys"
    # A path outside the step allowlist (a Windows path has backslashes) gets no
    # command, only the manual-fix note.
    if _step_path_ok(home):
        assert default_host["steps"][0].startswith("ssh-keygen -p -f ")
    else:
        assert default_host["steps"] == [] and default_host["manual_fix"]

    url_findings = sorted((f for f in result["findings"] if f["code"] == "url-token"),
                          key=lambda f: f["params"]["remote"])
    assert url_findings[0]["location"] == "~/work/proj · gh · https://github.com/o/r.git"
    assert url_findings[0]["links"] == [{"label": "GitHub tokens", "url": "https://github.com/settings/tokens"}]
    assert url_findings[1]["location"] == "~/work/proj · origin · https://oauth2@gitlab.com/grp/proj.git"
    assert url_findings[1]["links"][0]["url"] == "https://gitlab.com/-/user_settings/personal_access_tokens"
    if _step_path_ok(work):
        assert url_findings[1]["steps"][0].endswith("remote set-url -- origin https://gitlab.com/grp/proj.git")
    else:
        assert url_findings[1]["steps"] == [] and url_findings[1]["manual_fix"]
    for finding in result["findings"]:
        assert len(finding["id"]) == 16
        assert all(isinstance(v, str) for v in finding["params"].values())
        assert all(isinstance(s, str) for s in finding["steps"])

    # Roots: node_modules skipped, nested repo at depth 2 found.
    assert result["roots"] == [{"path": "~/work", "source": "user", "repo_count": 2, "truncated": False}]
    assert result["complete"] is True
    kinds = {i["kind"] for i in result["items"]}
    assert kinds == {"git-helper", "cli-account", "ssh-key", "keychain-item", "remote", "env-var",
                     "plaintext-file"}
    remotes = [i for i in result["items"] if i["kind"] == "remote"]
    assert {i["detail"]["remote"] for i in remotes} == {"origin", "gh"}  # only URLs with userinfo
    keychain = [i for i in result["items"] if i["kind"] == "keychain-item"]
    assert {i["label"] for i in keychain} == {"gitlab.com", "gh:github.com"}
    inline = [i for i in result["items"] if i["kind"] == "git-helper" and i["detail"]["context"] == "https://example.com"]
    assert [i["label"] for i in inline] == ["inline-shell"]
    assert result["keyring"] == {"available": True, "backend": "macos-keychain"}


@needs_git
def test_no_sentinel_anywhere_and_no_forbidden_command(home, work, caplog):
    caplog.set_level(logging.DEBUG)
    tools = FakeTools(home)
    result = cs.run_scan(_ctx(home, tools, [(str(work), "user")]))
    assert SENT not in json.dumps(result, ensure_ascii=False)
    assert SENT not in caplog.text
    for record in caplog.records:
        assert SENT not in record.getMessage()
    assert not [argv for argv in tools.calls if _forbidden(argv)]
    keygen_calls = [a for a in tools.calls if Path(a[0]).name == "ssh-keygen"]
    assert keygen_calls and all(a[1:4] == ["-y", "-P", ""] for a in keygen_calls)
    security_calls = [a for a in tools.calls if Path(a[0]).name == "security"]
    assert security_calls == [["/fake/bin/security", "dump-keychain"]]


@needs_git
def test_the_scan_writes_nothing(home, work):
    before = _snapshot(home)
    cs.run_scan(_ctx(home, FakeTools(home), [(str(work), "user")]))
    assert _snapshot(home) == before


def test_child_env_cannot_prompt():
    env = cs.child_env({"SSH_ASKPASS": "/x", "DISPLAY": ":0", "GIT_ASKPASS": "/y", "PATH": "/bin"})
    assert "SSH_ASKPASS" not in env and "DISPLAY" not in env and "GIT_ASKPASS" not in env
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    assert env["GH_PROMPT_DISABLED"] == "1"
    assert env["GCM_INTERACTIVE"] == "never"
    assert env["PATH"] == "/bin"


def test_real_runner_never_uses_a_shell(monkeypatch):
    seen: dict[str, Any] = {}

    def fake_run(argv, **kwargs):
        seen.update(kwargs, argv=argv)
        return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

    monkeypatch.setattr(cs.subprocess, "run", fake_run)
    cs.make_runner({"PATH": "/bin"})(["git", "--version"], timeout=3)
    assert seen.get("shell") in (None, False)
    assert seen["timeout"] == 3
    assert seen["stdin"] is subprocess.DEVNULL
    assert seen["env"]["GIT_TERMINAL_PROMPT"] == "0"


# ── Keyring per platform ────────────────────────────────────────────────────


def test_linux_without_secret_service_is_unavailable_and_reads_no_plaintext_store(home):
    keyrings = home / ".local" / "share" / "keyrings"
    keyrings.mkdir(parents=True)
    (keyrings / "login.keyring").write_text(SENT)
    tools = FakeTools(home, present={"ssh-keygen"})
    result = cs.run_scan(_ctx(home, tools, [], platform="linux", env={"HOME": str(home)}))
    assert result["keyring"] == {"available": False, "backend": "secret-service", "reason": "gdbus-not-found"}
    assert [f["params"]["reason"] for f in result["findings"] if f["code"] == "keyring-unavailable"] == [
        "gdbus-not-found"]
    assert SENT not in json.dumps(result)
    assert not [i for i in result["items"] if i["kind"] == "keychain-item"]


def test_linux_secret_service_reads_attributes_only(home):
    calls: list[list[str]] = []

    def run(argv, *, timeout=15.0, capture=True):
        calls.append(list(argv))
        if "org.freedesktop.Secret.Service.SearchItems" in argv:
            return cs.RunResult(0, "([objectpath '/org/freedesktop/secrets/collection/login/1'], "
                                   "[objectpath '/org/freedesktop/secrets/collection/login/2'])\n")
        if argv[-1] == "Attributes" and argv[argv.index("--object-path") + 1].endswith("/1"):
            return cs.RunResult(0, "(<{'protocol': 'https', 'server': 'github.com', 'user': 'nt', "
                                   f"'xdg:schema': 'org.git.Password', 'note': '{SENT}'}}>,)\n")
        return cs.RunResult(0, "(<{'application': 'other'}>,)\n")

    ctx = cs.ScanContext(home=home, env={}, roots=[], run=run, which=lambda n: "/bin/gdbus" if n == "gdbus" else None,
                         platform="linux")
    result = cs.run_scan(ctx)
    assert result["keyring"] == {"available": True, "backend": "secret-service"}
    items = [i for i in result["items"] if i["kind"] == "keychain-item"]
    assert len(items) == 1 and items[0]["detail"]["server"] == "github.com"
    assert SENT not in json.dumps(result)
    assert not any("GetSecret" in " ".join(c) for c in calls)


def test_windows_cmdkey_lists_target_type_user_only(home):
    out = (
        "Currently stored credentials:\n\n"
        "    Target: LegacyGeneric:target=git:https://github.com\n"
        "    Type: Generic \n"
        "    User: PersonalAccessToken\n"
        "    Local machine persistence\n\n"
        "    Target: Domain:target=fileserver\n"
        "    Type: Domain Password\n"
        "    User: corp\\me\n"
    )
    ctx = cs.ScanContext(home=home, env={}, roots=[],
                         run=lambda argv, **kw: cs.RunResult(0, out) if argv[-1] == "/list" else cs.RunResult(1),
                         which=lambda n: "C:/Windows/cmdkey.exe" if n == "cmdkey" else None, platform="win32")
    result = cs.run_scan(ctx)
    assert result["keyring"]["backend"] == "windows-credential-manager"
    items = [i for i in result["items"] if i["kind"] == "keychain-item"]
    assert [i["detail"]["service"] for i in items] == ["LegacyGeneric:target=git:https://github.com"]


# ── Parsers ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("raw, shown, token", [
    (f"https://oauth2:{GLPAT}@gitlab.com/g/p.git", "https://oauth2@gitlab.com/g/p.git", True),
    (f"https://{GHP}@github.com/o/r.git", "https://github.com/o/r.git", True),
    (f"https://nt:{SENT}@host.example/x?private_token={SENT}#f", "https://nt@host.example/x", True),
    ("https://nt@gitlab.com/g/p.git", "https://nt@gitlab.com/g/p.git", False),
    ("https://x-access-token@github.com/o/r", "https://x-access-token@github.com/o/r", False),
    ("git@github.com:o/r.git", "git@github.com:o/r.git", False),
    ("https://github.com/o/r.git", "https://github.com/o/r.git", False),
])
def test_redact_url(raw, shown, token):
    redacted = cs.redact_url(raw)
    assert redacted.url == shown
    assert redacted.token_present is token
    assert SENT not in repr(redacted)


def test_helper_name_never_returns_an_inline_body():
    assert cs.helper_name("!/opt/homebrew/bin/gh auth git-credential") == "gh"
    assert cs.helper_name(f"!f() {{ echo password={SENT}; }}; f") == "inline-shell"
    assert cs.helper_name(f"!sh -c 'echo {SENT}'") == "sh"
    assert cs.helper_name("osxkeychain") == "osxkeychain"
    assert cs.helper_name("/usr/lib/git-core/git-credential-libsecret") == "libsecret"
    assert cs.helper_name("manager") == "manager"
    assert cs.helper_name("") == ""


def test_yaml_token_hosts_reports_booleans_only():
    gh_hosts = (
        "github.com:\n    users:\n        nt-neil:\n            oauth_token: gho_x\n"
        "    oauth_token: gho_y\n    user: nt-neil\n"
        "ghe.example.com:\n    user: me\n    oauth_token: \"\"\n"
    )
    assert cs.yaml_token_hosts(gh_hosts) == {"github.com": True}
    glab = "hosts:\n  gitlab.com:\n    token: x\n  other.example:\n    token:\n"
    assert cs.yaml_token_hosts(glab) == {"gitlab.com": True}


def test_gh_json_and_text_status_parsing():
    doc = {"hosts": {"github.com": [
        {"state": "success", "active": True, "host": "github.com", "login": "a", "tokenSource": "keyring",
         "token": GHP},
        {"state": "success", "active": False, "host": "github.com", "login": "b",
         "tokenSource": "/home/x/.config/gh/hosts.yml"},
    ]}}
    accounts = cs.parse_gh_json(json.dumps(doc))
    assert [(a.account, a.active, a.storage) for a in accounts] == [("a", True, "keyring"), ("b", False, "config-file")]
    assert SENT not in repr(accounts)
    old = "github.com\n  ✓ Logged in to github.com as solo (oauth_token)\n  ✓ Token: " + GHP + "\n"
    parsed = cs.parse_auth_status_text("gh", old)
    assert [(a.account, a.active, a.storage) for a in parsed] == [("solo", True, "config-file")]


def test_dump_keychain_parser_keeps_only_named_metadata():
    items = cs.parse_dump_keychain(DUMP_KEYCHAIN)
    assert items[0] == {"class": "inet", "acct": "nt", "mdat": "20240102030405Z", "ptcl": "htps", "srvr": "gitlab.com"}
    assert SENT not in json.dumps(items)


def test_find_repos_respects_depth_cap_and_skips(tmp_path):
    for rel in ("r0", "a/r1", "a/b/r2", "a/b/c/r3", "node_modules/x", ".hidden/r", "secret/r"):
        (tmp_path / rel / ".git").mkdir(parents=True)
    found = cs.find_repos(tmp_path, [tmp_path / "secret"])
    assert sorted(p.relative_to(tmp_path).as_posix() for p in found) == ["a/b/r2", "a/r1", "r0"]
    assert len(cs.find_repos(tmp_path, [], limit=1)) == 1


# ── Roots and reminders ─────────────────────────────────────────────────────


def _service(tmp_path: Path, *, ctx_factory=None, clock=None, workspace=None, system=None) -> cs.CredentialsService:
    db = Database(tmp_path / "navide.db")
    return cs.CredentialsService(
        db_getter=lambda: db,
        workspace_roots=lambda: list(workspace or []),
        context_factory=ctx_factory or (lambda roots: cs.ScanContext(
            home=tmp_path, env={}, roots=roots, run=lambda *a, **k: cs.RunResult(1), which=lambda n: None,
            platform="darwin")),
        system_dirs=lambda: list(system or []),
        clock=clock or (lambda: datetime(2026, 10, 9, 8, 0, tzinfo=timezone.utc)),
    )


def test_roots_validation(tmp_path):
    ok = tmp_path / "ok"
    ok.mkdir()
    secret = tmp_path / "secret"
    (secret / "inner").mkdir(parents=True)
    svc = _service(tmp_path, system=[secret])
    assert svc.roots_set([str(ok), str(ok) + os.sep]) == [str(ok)]
    assert svc.user_roots() == [str(ok)]
    for bad, code in [
        ("relative/path", "invalid-root"),
        (str(tmp_path / "missing"), "invalid-root"),
        (str(secret / "inner"), "forbidden-root"),
        (str(secret), "forbidden-root"),
        (os.path.abspath(os.sep), "invalid-root"),
    ]:
        with pytest.raises(cs.RequestError) as err:
            svc.roots_set([bad])
        assert err.value.code == code
    with pytest.raises(cs.RequestError) as err:
        svc.roots_set([str(ok)] * 21)
    assert err.value.code == "too-many-roots"
    with pytest.raises(cs.RequestError):
        svc.roots_set("not-a-list")
    assert svc.user_roots() == [str(ok)]


def test_reminder_snooze_dismiss_and_expiry(tmp_path):
    now = [datetime(2026, 10, 9, 8, 0, tzinfo=timezone.utc)]
    svc = _service(tmp_path, clock=lambda: now[0])
    fid = "0123456789abcdef"
    snoozed = svc.reminder_set(fid, "snoozed")
    assert snoozed == {"state": "snoozed", "until": "2026-10-16T08:00:00Z"}
    assert cs.reminder_for(fid, svc.reminders(), now[0]) == snoozed
    assert svc.reminder_set(fid, "snoozed", 30)["until"] == "2026-11-08T08:00:00Z"
    now[0] += timedelta(days=31)
    assert cs.reminder_for(fid, svc.reminders(), now[0]) == {"state": "active"}
    assert svc.reminder_set(fid, "dismissed") == {"state": "dismissed"}
    assert cs.reminder_for(fid, svc.reminders(), now[0]) == {"state": "dismissed"}
    assert svc.reminder_set(fid, "active") == {"state": "active"}
    assert fid not in svc.reminders()
    for bad in [("nothex", "snoozed", None), (fid, "later", None), (fid, "snoozed", 0), (fid, "snoozed", 91),
                (fid, "snoozed", True), (fid, "snoozed", "7")]:
        with pytest.raises(cs.RequestError):
            svc.reminder_set(*bad)


# ── WS / MCP / KV end to end ────────────────────────────────────────────────


class FakeSession:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        self.sent.append(data)


@needs_git
@pytest.mark.asyncio
async def test_ws_and_mcp_replies_and_kv_carry_no_secret(home, work, tmp_path, caplog):
    from agent_team_backend import ws_handlers
    from agent_team_backend.mcp_server import auth as plan_mcp_auth
    from agent_team_backend.mcp_server import server as plan_mcp

    caplog.set_level(logging.DEBUG)
    tools = FakeTools(home)
    svc = _service(tmp_path, workspace=[str(work)],
                   ctx_factory=lambda roots: _ctx(home, tools, roots))
    cs.set_service(svc)
    try:
        session = FakeSession()
        scan = ws_handlers.lookup("credentials.scan")
        await scan(session, "1", "credentials.scan", {})
        reply = session.sent[-1]
        assert reply["ok"] is True and reply["payload"]["ok"] is True
        payload = reply["payload"]
        assert set(payload) == {"ok", "complete", "scanned_at", "duration_ms", "platform", "keyring", "roots", "summary",
                                "items", "findings"}
        assert payload["roots"][0]["source"] == "workspace"
        assert payload["summary"]["high"] >= 4
        assert payload["summary"]["active_reminders"] == len(payload["findings"])
        assert len(json.dumps(payload).encode()) < 200 * 1024
        calls_after_first = len(tools.calls)

        target = payload["findings"][0]["id"]
        await ws_handlers.lookup("credentials.reminder.set")(
            session, "2", "credentials.reminder.set", {"id": target, "state": "snoozed", "days": 7})
        assert session.sent[-1]["payload"] == {"ok": True, "reminder": {
            "state": "snoozed", "until": "2026-10-16T08:00:00Z"}}
        await scan(session, "3", "credentials.scan", {})
        cached = session.sent[-1]["payload"]
        assert len(tools.calls) == calls_after_first  # served from the 60 s cache
        assert next(f for f in cached["findings"] if f["id"] == target)["reminder"]["state"] == "snoozed"
        assert cached["summary"]["active_reminders"] == len(cached["findings"]) - 1
        await scan(session, "4", "credentials.scan", {"force": True})
        assert len(tools.calls) > calls_after_first

        await ws_handlers.lookup("credentials.roots.set")(
            session, "5", "credentials.roots.set", {"roots": [str(work)]})
        assert session.sent[-1]["payload"] == {"ok": True, "roots": [str(work)]}
        await ws_handlers.lookup("credentials.roots.get")(session, "6", "credentials.roots.get", {})
        assert session.sent[-1]["payload"] == {"ok": True, "roots": [str(work)]}
        await ws_handlers.lookup("credentials.roots.set")(
            session, "7", "credentials.roots.set", {"roots": ["relative"]})
        assert session.sent[-1]["payload"]["ok"] is False
        assert session.sent[-1]["payload"]["error_code"] == "invalid-root"
        await ws_handlers.lookup("credentials.reminder.set")(
            session, "8", "credentials.reminder.set", {"id": "x", "state": "snoozed"})
        assert session.sent[-1]["payload"]["error_code"] == "invalid-id"

        ctx = SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(
            query_params={"client": "host", "t": plan_mcp_auth.internal_token()})))
        listed = await plan_mcp.credentials_list(ctx)
        found = await plan_mcp.credentials_findings(ctx)
        assert set(listed) == {"ok", "scanned_at", "platform", "keyring", "items"}
        assert set(found) == {"ok", "scanned_at", "summary", "findings"}
        assert all("reminder" in f for f in found["findings"])

        kv_rows = svc._db_getter()._conn.execute("SELECT key, value FROM kv").fetchall()
        assert {row["key"] for row in kv_rows} <= set(cs.KV_KEYS)
        dumped = json.dumps([session.sent, listed, found, [tuple(r) for r in kv_rows]], ensure_ascii=False)
        assert SENT not in dumped
        assert SENT not in caplog.text
    finally:
        cs.set_service(None)


@pytest.mark.asyncio
async def test_mcp_tools_are_registered_without_arguments():
    from agent_team_backend.mcp_server import server as plan_mcp

    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    for name in ("credentials_list", "credentials_findings"):
        assert name in tools
        assert not (tools[name].inputSchema.get("properties") or {})
        description = tools[name].description or ""
        assert "never returned" in description and "read-only" in description.lower()


# ── Never synced, never bundled ─────────────────────────────────────────────


BACKEND = Path(__file__).resolve().parents[1] / "agent_team_backend"


def test_credentials_kv_keys_are_in_no_sync_scope_and_no_bundle():
    from agent_team_backend import settings_bundle, sync_engine

    assert all(key.startswith("credentials.") for key in cs.KV_KEYS)
    # The scopes that exist: none is this feature's, and a bundle carries only its four.
    assert set(settings_bundle.SCOPES) == {"prompts", "mcp", "skills", "memory"}
    for scope in (*sync_engine.SCOPES, *sync_engine.INTERNAL_SCOPES):
        assert scope not in {"credentials-scan", "credentials.scan", "credentials-reminders"}
    # No sync or bundle code reads these keys or this module.
    for name in ("sync_scopes.py", "sync_engine.py", "settings_bundle.py", "sync_approvals.py",
                 "sync_keyring.py"):
        source = (BACKEND / name).read_text(encoding="utf-8")
        assert "credentials_scan" not in source, name
        for key in cs.KV_KEYS:
            assert key not in source, (name, key)


def test_bundle_export_never_reads_credentials_kv(monkeypatch, tmp_path):
    from agent_team_backend import app, settings_bundle
    from agent_team_backend.mcp_settings import MCPSettingsStore
    from agent_team_backend.skills_store import SkillsStore

    class FakeSettings:
        def get(self) -> dict:
            return {}

        def set(self, updates: dict) -> dict:
            return dict(updates)

    monkeypatch.setattr(app, "ui_settings_store", FakeSettings())
    monkeypatch.setattr(app, "mcp_settings_store", MCPSettingsStore(path=tmp_path / "mcp.json"))
    monkeypatch.setattr(app, "skills_store", SkillsStore(
        root=tmp_path / "skills", state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime", native_roots=[tmp_path / "native"]))
    app.database.kv_set(cs.REMINDERS_KV_KEY, {"0123456789abcdef": {"state": "dismissed", "x": SENT}}, now=1)
    app.database.kv_set(cs.ROOTS_KV_KEY, [f"/tmp/{SENT}"], now=1)
    read: list[str] = []
    original = Database.kv_get

    def spy(self, key, default=None):
        read.append(key)
        return original(self, key, default)

    monkeypatch.setattr(Database, "kv_get", spy)
    try:
        inventory = settings_bundle.inventory()
        bundle = settings_bundle.export_bundle({scope: [] for scope in settings_bundle.SCOPES})
        assert SENT not in json.dumps([inventory, bundle])
        assert not [key for key in read if key.startswith("credentials.")]
    finally:
        monkeypatch.undo()
        app.database._conn.execute("DELETE FROM kv WHERE key IN (?, ?)", cs.KV_KEYS)


def test_ws_handlers_are_registered():
    from agent_team_backend import ws_handlers

    for name in ("credentials.scan", "credentials.roots.get", "credentials.roots.set", "credentials.reminder.set"):
        assert ws_handlers.lookup(name) is cs.MESSAGE_HANDLERS[name]


def test_module_does_not_branch_on_platform():
    source = (BACKEND / "credentials_scan.py").read_text(encoding="utf-8")
    assert "sys.platform" not in source and "os.name" not in source
    assert "shell=True" not in source
