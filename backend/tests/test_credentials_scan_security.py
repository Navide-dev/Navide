"""Security review CR-1..CR-10 of the credentials scan, as regression tests.

Ported from the review's repros (read as data, re-written here): every
interpolated value in a copyable step is quoted or the step is withheld,
helper names never carry an assignment, the URL redactor finds userinfo the
way git does, the walk is bounded, nothing blocks on a FIFO, roots are
resolved before they are judged, links and keychain filters trust only known
hosts, and MCP returns action names rather than shell commands.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import credentials_scan as cs
from agent_team_backend.db import Database

GIT = shutil.which("git")
needs_git = pytest.mark.skipif(GIT is None, reason="git is required")
has_mkfifo = pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="needs FIFOs")

TOKEN = "ghp_" + "a" * 36


def _env(home: Path) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({"HOME": str(home), "USERPROFILE": str(home), "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": str(home / ".gitconfig")})
    env.pop("XDG_CONFIG_HOME", None)
    return env


def _git(home: Path, *args: str) -> None:
    subprocess.run([GIT, *args], check=True, env=_env(home), capture_output=True)


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "home"
    (h / ".ssh").mkdir(parents=True)
    (h / ".config").mkdir()
    (h / ".gitconfig").write_text("")
    return h


def _run_git(home: Path):
    def run(argv, *, timeout: float = 15.0, capture: bool = True) -> cs.RunResult:
        if Path(argv[0]).name != Path(GIT or "git").name and argv[0] != GIT:
            return cs.RunResult(cs.CODE_SPAWN_FAILED)
        proc = subprocess.run(list(argv), capture_output=True, env=_env(home), timeout=timeout,
                              stdin=subprocess.DEVNULL)
        return cs.RunResult(proc.returncode, proc.stdout.decode(), proc.stderr.decode())
    return run


def _ctx(home: Path, roots: list[Path], *, which=None, run=None, system_dirs=None) -> cs.ScanContext:
    return cs.ScanContext(
        home=home, env={"HOME": str(home)}, roots=[(str(r), "user") for r in roots],
        run=run or _run_git(home), which=which or (lambda n: GIT if n == "git" else None),
        platform="darwin", system_dirs=list(system_dirs if system_dirs is not None else [home / ".ssh"]),
        config_home=home / ".config", repo_workers=2,
    )


def _repo(home: Path, path: Path) -> Path:
    path.mkdir(parents=True)
    _git(home, "-C", str(path), "-c", "init.defaultBranch=main", "init", "-q")
    return path


def _paste_every_step(result: dict, cwd: Path, home: Path) -> None:
    """What a user who copies each suggested step into a shell gets."""
    for finding in result["findings"]:
        for step in finding["steps"]:
            subprocess.run(cs.osplat.paths.shell_command(step), cwd=cwd, env=_env(home), capture_output=True,
                           timeout=10)


# ── CR-1: copyable steps cannot be injected ────────────────────────────────


@needs_git
@pytest.mark.parametrize("payload", [
    ";touch${IFS}{pwn};#",
    "$(touch${IFS}{pwn})",
    "`touch${IFS}{pwn}`",
    "|touch${IFS}{pwn}",
    "&touch${IFS}{pwn}",
])
def test_cr1_remote_url_payload_never_reaches_a_runnable_step(home, tmp_path, payload):
    pwn = tmp_path / "PWNED"
    root = tmp_path / "ws"
    repo = _repo(home, root / "evil")
    _git(home, "-C", str(repo), "config", "remote.origin.url",
         f"https://{TOKEN}@github.com/a/b" + payload.replace("{pwn}", str(pwn)))
    result = cs.run_scan(_ctx(home, [root]))
    finding = next(f for f in result["findings"] if f["code"] == "url-token")
    assert finding["manual_fix"] is True
    assert finding["steps"] == []
    assert "manual-fix" in finding["actions"]
    _paste_every_step(result, tmp_path, home)
    assert not pwn.exists()
    assert TOKEN not in json.dumps(result)


@needs_git
def test_cr1_helper_duplicate_context_payload_is_withheld(home, tmp_path):
    pwn = tmp_path / "PWNED3"
    root = tmp_path / "ws"
    repo = _repo(home, root / "evil")
    key = f"credential.https://github.com/$(touch${{IFS}}{pwn}).helper"
    _git(home, "-C", str(repo), "config", "--add", key, "store")
    _git(home, "-C", str(repo), "config", "--add", key, "store")
    result = cs.run_scan(_ctx(home, [root]))
    dup = [f for f in result["findings"] if f["code"] == "helper-duplicate"]
    assert dup and all(f["manual_fix"] and not f["steps"] for f in dup)
    _paste_every_step(result, tmp_path, home)
    assert not pwn.exists()


@needs_git
def test_cr1_helper_shadowed_context_payload_is_withheld(home, tmp_path):
    pwn = tmp_path / "PWNED2"
    _git(home, "config", "--global", "credential.https://github.com;touch " + str(pwn) + ";#.helper", "osxkeychain")
    root = tmp_path / "ws"
    repo = _repo(home, root / "evil")
    _git(home, "-C", str(repo), "config", f"credential.https://github.com;touch {pwn};#.helper", "store")
    result = cs.run_scan(_ctx(home, [root]))
    shadowed = [f for f in result["findings"] if f["code"] == "helper-shadowed"]
    assert shadowed and all(f["manual_fix"] and not f["steps"] for f in shadowed)
    _paste_every_step(result, tmp_path, home)
    assert not pwn.exists()


@needs_git
def test_cr1_values_outside_the_allowlist_need_a_manual_fix(home, tmp_path):
    # Superseded by R2-1: nothing is escaped any more, so a path with a space
    # gets no command rather than a quoted one.
    root = tmp_path / "ws"
    repo = _repo(home, root / "with space")
    _git(home, "-C", str(repo), "config", "remote.origin.url", f"https://{TOKEN}@github.com/a/b.git")
    result = cs.run_scan(_ctx(home, [root]))
    finding = next(f for f in result["findings"] if f["code"] == "url-token")
    assert finding["manual_fix"] is True
    assert finding["actions"] == ["remote-set-url", "manual-fix"]
    assert finding["steps"] == []


def test_cr1_step_builder_refuses_metacharacters():
    for bad in ("a$(b)", "a`b`", "a;b", "a|b", "a&b", "a\nb", "a\rb"):
        assert cs.safe_command("git", "-C", bad) is None
    assert cs.safe_command("chmod", "600", "/x y/z") is None
    assert cs.safe_command("chmod", "600", "/x/y.z") == "chmod 600 /x/y.z"


# ── CR-2: helper names never carry an assignment or a body ─────────────────


@pytest.mark.parametrize("value", [
    "!GH_TOKEN=ghp_FAKEFAKEFAKE1234567890 gh auth git-credential",
    "!TOKEN=abc123secret git-credential-foo",
    "!password=SECRETY",
    "!echo password=SECRETX",
    "!f() { echo password=X; }; f",
    "!'/opt/x y/gh' auth git-credential",
    "FOO=bar",
])
def test_cr2_helper_name_is_a_plain_basename_or_inline_shell(value):
    name = cs.helper_name(value)
    assert "=" not in name and "SECRET" not in name and "FAKE" not in name and "abc123" not in name
    assert name == "inline-shell" or __import__("re").fullmatch(r"[\w.+-]+", name)


@needs_git
def test_cr2_env_prefixed_inline_helper_does_not_leak(home):
    _git(home, "config", "--global", "credential.helper", "!GH_TOKEN=ghp_FAKEFAKEFAKE1234567890 gh auth git-credential")
    result = cs.run_scan(_ctx(home, []))
    assert "FAKEFAKE" not in json.dumps(result)


# ── CR-5 / CR-6: redaction ─────────────────────────────────────────────────


@pytest.mark.parametrize("raw, secret", [
    ("https://user:ab/cdSECRETPW@host.example/r", "SECRETPW"),
    ("https://user:ab?cdSECRETPW@host.example/r", "SECRETPW"),
    ("https://user:ab#cdSECRETPW@h/r", "SECRETPW"),
    ("user:hunter2SECRETPW@host.example:path", "SECRETPW"),
    ("https://eyJhbGciOi.eyJzdWIiOi.c2lnSECRETPW@github.com/a/b", "SECRETPW"),
    ("https://AbCdEfGhIjKlMnOpSECRETPW@gitlab.com/a/b", "SECRETPW"),
    ("https://abcdEFGHijklMNOP@github.com/a/b", "abcdEFGHijklMNOP"),
    ("https://dXNlcjpwYXNz+SECRETPW==@github.com/a", "SECRETPW"),
    ("git+https://u:SECRETPW@h.example/x", "SECRETPW"),
    ("https://h.example/a/b?private_token=SECRETPW#frag", "SECRETPW"),
])
def test_cr5_cr6_redaction_finds_and_drops_the_secret(raw, secret):
    redacted = cs.redact_url(raw)
    assert secret not in repr(redacted)
    if "@" in raw:
        assert redacted.token_present is True


@pytest.mark.parametrize("raw, shown", [
    ("https://nt-nerdtechnic@github.com/a/b.git", "https://nt-nerdtechnic@github.com/a/b.git"),
    ("https://nt.fitbody@gitlab.com/a/b.git", "https://nt.fitbody@gitlab.com/a/b.git"),
    ("https://host.example/path@v1/x", "https://host.example/path@v1/x"),
    ("https://host.example:8443/p@x", "https://host.example:8443/p@x"),
    ("git@github.com:o/r.git", "git@github.com:o/r.git"),
])
def test_cr6_plain_logins_and_path_ats_are_kept(raw, shown):
    redacted = cs.redact_url(raw)
    assert redacted.url == shown
    assert redacted.token_present is False


@needs_git
def test_cr5_helper_context_with_slash_in_password_is_redacted(home):
    _git(home, "config", "--global", "credential.https://me:pa/SECRETPW@host.example.helper", "store")
    result = cs.run_scan(_ctx(home, []))
    assert "SECRETPW" not in json.dumps(result)


@needs_git
def test_cr6_git_plus_https_remote_is_reported(home, tmp_path):
    root = tmp_path / "ws"
    repo = _repo(home, root / "r")
    _git(home, "-C", str(repo), "config", "remote.origin.url", "git+https://u:SECRETPW@h.example/x")
    result = cs.run_scan(_ctx(home, [root]))
    assert [f["code"] for f in result["findings"] if f["code"] == "url-token"] == ["url-token"]
    assert "SECRETPW" not in json.dumps(result)


# ── CR-7: no read can block or balloon ─────────────────────────────────────


@has_mkfifo
def test_cr7_ssh_include_fifo_does_not_hang(home, tmp_path):
    os.mkfifo(tmp_path / "pipe")
    (home / ".ssh" / "config").write_text(f"Include {tmp_path}/pipe\n")
    (home / ".zshrc").unlink(missing_ok=True)
    os.mkfifo(home / ".zshrc")
    thread = threading.Thread(target=cs.run_scan, args=(_ctx(home, []),), daemon=True)
    thread.start()
    thread.join(5)
    hung = thread.is_alive()
    if hung:  # unblock the stuck reader so the test process can exit
        for pipe in (tmp_path / "pipe", home / ".zshrc"):
            try:
                os.close(os.open(pipe, os.O_WRONLY | os.O_NONBLOCK))
            except OSError:
                pass
    assert not hung


def test_cr7_reads_are_capped(home):
    big = home / ".zshrc"
    big.write_text("x" * (cs.MAX_READ_BYTES + 10) + "\nexport GH_TOKEN=late\n")
    result = cs.run_scan(_ctx(home, [], which=lambda n: None))
    assert not [f for f in result["findings"] if f["code"] == "env-token-in-shell-rc"]


# ── CR-3: bounded, fast walk; readers are not blocked ──────────────────────


def test_cr3_walk_is_fast_against_many_system_dirs(tmp_path):
    wide = tmp_path / "wide"
    for i in range(60):
        for j in range(60):
            (wide / f"d{i}" / f"e{j}").mkdir(parents=True)
    system = [Path(f"/nonexistent/sys{i}") for i in range(80)]
    started = time.monotonic()
    cs.find_repos(wide, system)
    assert time.monotonic() - started < 2.0


def test_cr3_directory_budget_is_shared_across_roots(tmp_path, monkeypatch):
    monkeypatch.setattr(cs, "MAX_WALK_DIRS", 50)
    roots = []
    for r in range(3):
        root = tmp_path / f"root{r}"
        for i in range(40):
            (root / f"repo{i}" / ".git").mkdir(parents=True)
        roots.append(root)
    ctx = _ctx(tmp_path, roots, which=lambda n: None, system_dirs=[])
    result = cs.run_scan(ctx)
    assert sum(r["repo_count"] for r in result["roots"]) <= 50


def test_cr3_walk_stops_at_the_deadline(tmp_path, monkeypatch):
    monkeypatch.setattr(cs, "WALK_SECONDS", 0.0)
    (tmp_path / "root" / "repo" / ".git").mkdir(parents=True)
    result = cs.run_scan(_ctx(tmp_path, [tmp_path / "root"], which=lambda n: None, system_dirs=[]))
    assert result["roots"][0]["repo_count"] == 0


@pytest.mark.asyncio
async def test_cr3_a_running_scan_does_not_block_readers_of_the_last_result(tmp_path):
    gate = threading.Event()
    calls = []

    def factory(roots):
        calls.append(1)
        if len(calls) > 1:
            gate.wait(10)
        return _ctx(tmp_path, [], which=lambda n: None, system_dirs=[])

    db = Database(tmp_path / "navide.db")
    svc = cs.CredentialsService(db_getter=lambda: db, workspace_roots=lambda: [], context_factory=factory,
                                system_dirs=lambda: [],
                                clock=lambda: datetime(2026, 10, 9, tzinfo=timezone.utc))
    first = await svc.scan()
    refresh = asyncio_task(svc.scan(force=True))
    try:
        for _ in range(100):
            if len(calls) > 1:
                break
            await _sleep(0.01)
        started = time.monotonic()
        second = await svc.scan()
        assert time.monotonic() - started < 1.0
        assert second["scanned_at"] == first["scanned_at"]
    finally:
        gate.set()
        await refresh


def asyncio_task(coro):
    import asyncio

    return asyncio.ensure_future(coro)


async def _sleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(seconds)


# ── CR-8: roots are resolved before they are judged ────────────────────────


def test_cr8_symlinked_roots_are_resolved(tmp_path):
    secret = tmp_path / "secret"
    secret.mkdir()
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "to_secret").symlink_to(secret)
    (tmp_path / "to_real").symlink_to(real)
    (tmp_path / "to_fsroot").symlink_to(Path(os.path.abspath(os.sep)))
    for bad in ("to_secret", "to_fsroot"):
        with pytest.raises(cs.RequestError):
            cs.validate_roots([str(tmp_path / bad)], [secret])
    assert cs.validate_roots([str(tmp_path / "to_real")], [secret]) == [os.path.realpath(real)]


def test_cr8_workspace_roots_go_through_the_same_validation(tmp_path):
    secret = tmp_path / "secret"
    secret.mkdir()
    good = tmp_path / "good"
    good.mkdir()
    (tmp_path / "ws_link").symlink_to(secret)
    db = Database(tmp_path / "navide.db")
    svc = cs.CredentialsService(
        db_getter=lambda: db,
        workspace_roots=lambda: [str(tmp_path / "ws_link"), str(good), "relative", str(tmp_path / "gone")],
        context_factory=lambda roots: _ctx(tmp_path, [], which=lambda n: None),
        system_dirs=lambda: [secret])
    assert svc._roots() == [(os.path.realpath(good), "workspace")]


# ── CR-9: only trusted hosts get links and widen the keychain filter ───────


def test_cr9_links_only_for_trusted_hosts():
    assert cs._host_links("gitlab.attacker.example", frozenset()) == []
    assert cs._host_links("gitlab.com", frozenset())[0]["url"].startswith("https://gitlab.com/")
    assert cs._host_links("github.com", frozenset())[0]["url"] == "https://github.com/settings/tokens"
    assert cs._host_links("git.corp.example", frozenset({"git.corp.example"}))[0]["url"].startswith(
        "https://git.corp.example/")


@needs_git
def test_cr9_untrusted_remote_host_gets_no_link_and_no_keychain_widening(home, tmp_path):
    root = tmp_path / "ws"
    repo = _repo(home, root / "r")
    _git(home, "-C", str(repo), "config", "remote.origin.url", f"https://{TOKEN}@gitlab.attacker.example/a/b")
    dump = ('class: "inet"\nattributes:\n    "acct"<blob>="victim"\n    "srvr"<blob>="gitlab.attacker.example"\n'
            'class: "inet"\nattributes:\n    "acct"<blob>="nt"\n    "srvr"<blob>="github.com"\n')
    base_run = _run_git(home)

    def run(argv, **kw):
        if Path(argv[0]).name == "security":
            return cs.RunResult(0, dump)
        return base_run(argv, **kw)

    which = {"git": GIT, "security": "/fake/security"}
    result = cs.run_scan(_ctx(home, [root], which=which.get, run=run))
    finding = next(f for f in result["findings"] if f["code"] == "url-token")
    assert finding["links"] == []
    keychain = [i["detail"]["server"] for i in result["items"] if i["kind"] == "keychain-item"]
    assert keychain == ["github.com"]


# ── CR-4: MCP returns names and action codes, not locators or commands ─────


@pytest.mark.asyncio
async def test_cr4_mcp_tools_strip_locators_and_commands(tmp_path):
    from agent_team_backend.mcp_server import auth as plan_mcp_auth
    from agent_team_backend.mcp_server import server as plan_mcp

    raw = {
        "ok": True, "scanned_at": "2026-10-09T00:00:00Z", "duration_ms": 1, "platform": "darwin",
        "keyring": {"available": True, "backend": "macos-keychain"}, "roots": [],
        "summary": {"high": 1, "medium": 0, "low": 0, "active_reminders": 1},
        "items": [{"id": "i1", "kind": "keychain-item", "label": "gh:github.com",
                   "detail": {"class": "generic-password", "service": "gh:github.com", "server": "github.com",
                              "account": "nt-neil", "protocol": "", "modified": ""}},
                  {"id": "i2", "kind": "ssh-key", "label": "id_ed25519", "detail": {"path": "~/.ssh/id_ed25519"}}],
        "findings": [{"id": "f1", "code": "ssh-no-passphrase", "severity": "medium", "kind": "ssh-key",
                      "location": "~/.ssh/id_ed25519", "params": {}, "links": [], "manual_fix": False,
                      "actions": ["ssh-add-passphrase"], "steps": ["ssh-keygen -p -f /x"],
                      "reminder": {"state": "active"}}],
    }

    class FakeService:
        async def scan(self, *, force=False):
            return json.loads(json.dumps(raw))

    cs.set_service(FakeService())
    try:
        ctx = SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(
            query_params={"client": "host", "t": plan_mcp_auth.internal_token()})))
        listed = await plan_mcp.credentials_list(ctx)
        found = await plan_mcp.credentials_findings(ctx)
    finally:
        cs.set_service(None)
    keychain = next(i for i in listed["items"] if i["kind"] == "keychain-item")
    assert not {"service", "account", "server"} & set(keychain["detail"])
    assert "gh:github.com" not in json.dumps(keychain) and "nt-neil" not in json.dumps(keychain)
    assert all("steps" not in f for f in found["findings"])
    assert found["findings"][0]["actions"] == ["ssh-add-passphrase"]
    assert "ssh-keygen" not in json.dumps(found)


# ── CR-10: coverage gaps that are cheap to close ───────────────────────────


@needs_git
def test_cr10_pushurl_and_insteadof_tokens_are_reported(home, tmp_path):
    root = tmp_path / "ws"
    repo = _repo(home, root / "r")
    _git(home, "-C", str(repo), "config", "remote.origin.url", "https://github.com/a/b.git")
    _git(home, "-C", str(repo), "config", "remote.origin.pushurl", "https://ghp_" + "b" * 36 + "@github.com/a/b.git")
    _git(home, "-C", str(repo), "config", "url.https://ghp_" + "c" * 36 + "@github.com/.insteadOf",
         "https://github.com/")
    result = cs.run_scan(_ctx(home, [root]))
    tokens = [f for f in result["findings"] if f["code"] == "url-token"]
    assert len(tokens) == 2
    blob = json.dumps(result)
    assert "b" * 36 not in blob and "c" * 36 not in blob


def test_cr10_clean_url_keeps_port_and_ipv6():
    for raw, clean in [
        (f"https://{TOKEN}@git.example:8443/a/b.git", "https://git.example:8443/a/b.git"),
        (f"https://u:{TOKEN}@[::1]:8080/r", "https://u@[::1]:8080/r"),
    ]:
        assert cs._clean_url(cs.redact_url(raw)) == clean


def test_cr10_putty_key_passphrase_is_unknown(home):
    (home / ".ssh" / "work.ppk").write_text("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n")

    def run(argv, **kw):
        return cs.RunResult(1)

    result = cs.run_scan(_ctx(home, [], which=lambda n: "/x/ssh-keygen" if n == "ssh-keygen" else None, run=run))
    item = next(i for i in result["items"] if i["kind"] == "ssh-key")
    assert item["detail"]["passphrase_checked"] is False and "has_passphrase" not in item["detail"]


# ══ Security review round 2 (R2-1..R2-11) ══════════════════════════════════


def _url_token_steps(result: dict) -> list[dict]:
    return [f for f in result["findings"] if f["code"] == "url-token"]


@needs_git
@pytest.mark.parametrize("name", [
    "(iex(-join([char[]](99,97,108,99))))",
    "@(calc)",
    "{calc}",
    "a,b",
    "--push",
    "x\x1b[201~\x15touch PWNCTL\x0f",
    "tab\there",
])
def test_r2_1_hostile_remote_names_never_reach_a_step(home, tmp_path, monkeypatch, name):
    import subprocess as sp

    monkeypatch.setattr(cs.osplat.paths, "quote_arg", lambda a: sp.list2cmdline([a]))
    root = tmp_path / "ws"
    repo = _repo(home, root / "r")
    _git(home, "-C", str(repo), "config", f"remote.{name}.url", f"https://{TOKEN}@github.com/a/b")
    ctx = _ctx(home, [root])
    ctx.platform = "win32"
    findings = _url_token_steps(cs.run_scan(ctx))
    assert findings and all(f["manual_fix"] and f["steps"] == [] for f in findings)


@needs_git
def test_r2_1_hostile_url_path_is_withheld(home, tmp_path):
    root = tmp_path / "ws"
    repo = _repo(home, root / "r")
    _git(home, "-C", str(repo), "config", "remote.origin.url", f"https://{TOKEN}@github.com/x/y%PATH%^!x!(z)\"q")
    findings = _url_token_steps(cs.run_scan(_ctx(home, [root])))
    assert findings and all(f["manual_fix"] and not f["steps"] for f in findings)


@needs_git
def test_r2_1_safe_step_ends_options_before_the_remote_name(home, tmp_path):
    root = tmp_path / "ws"
    repo = _repo(home, root / "r")
    _git(home, "-C", str(repo), "config", "remote.origin.url", f"https://{TOKEN}@github.com/a/b.git")
    finding = _url_token_steps(cs.run_scan(_ctx(home, [root])))[0]
    if cs.safe_command("x", cs.StepValue(str(repo))) is None:
        # A Windows tmp path has backslashes: the allowlist refuses it on purpose.
        assert finding["steps"] == [] and finding["manual_fix"]
    else:
        assert finding["steps"] == [f"git -C {repo} remote set-url -- origin https://github.com/a/b.git"]


def test_r2_1_values_are_allowlisted_not_escaped():
    V = cs.StepValue
    assert cs.safe_command("git", "-C", V("/a/b"), "remote", "set-url", "--", V("origin"), V("https://h/x")) == \
        "git -C /a/b remote set-url -- origin https://h/x"
    for bad in ("(calc)", "@(calc)", "{calc}", "a,b", "-x", "a b", "a\x1bb", "%PATH%", "a^b", "a'b", 'a"b', "a!b",
                "a$b", "a`b", "a;b", "a|b", "a&b", "a\\b", "a*b", "a\tb", "é"):
        assert cs.safe_command("git", V(bad)) is None, bad


@needs_git
@pytest.mark.parametrize("key", [
    "credential.https://me:pa SECRETSP@host.example.helper",
    "credential.https://me:pb\tSECRETSP@host2.example.helper",
])
def test_r2_3_whitespace_in_helper_context_password_is_masked(home, key):
    _git(home, "config", "--global", key, "store")
    assert "SECRETSP" not in json.dumps(cs.run_scan(_ctx(home, [])))


@needs_git
def test_r2_4_token_shaped_helper_word_is_inline_shell(home):
    assert cs.helper_name("!" + TOKEN + " get") == "inline-shell"
    assert cs.helper_name("!a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 get") == "inline-shell"
    _git(home, "config", "--global", "credential.helper", "!" + TOKEN + " get")
    assert TOKEN not in json.dumps(cs.run_scan(_ctx(home, [])))


@needs_git
def test_r2_5_partial_walk_is_flagged(home, tmp_path, monkeypatch):
    root = tmp_path / "big"
    for i in range(30):
        (root / f"a{i:02d}").mkdir(parents=True)
    late = _repo(home, root / "zz_repo")
    _git(home, "-C", str(late), "config", "remote.origin.url", f"https://{TOKEN}@github.com/a/b")
    monkeypatch.setattr(cs, "MAX_WALK_DIRS", 10)
    result = cs.run_scan(_ctx(home, [root]))
    assert result["roots"][0]["truncated"] is True
    assert result["complete"] is False


@needs_git
def test_r2_5_full_walk_is_complete(home, tmp_path):
    root = tmp_path / "ws"
    _repo(home, root / "r")
    result = cs.run_scan(_ctx(home, [root]))
    assert result["roots"][0]["truncated"] is False
    assert result["complete"] is True


@needs_git
@has_mkfifo
def test_r2_6_fifo_repo_config_is_skipped_quickly(home, tmp_path):
    root = tmp_path / "ws"
    for i in range(4):
        repo = _repo(home, root / f"r{i}")
        (repo / ".git" / "config").unlink()
        os.mkfifo(repo / ".git" / "config")
    started = time.monotonic()
    result = cs.run_scan(_ctx(home, [root]))
    assert time.monotonic() - started < 5.0
    assert result["roots"][0]["truncated"] is True


@needs_git
def test_r2_6_repo_reads_respect_the_deadline(home, tmp_path, monkeypatch):
    root = tmp_path / "ws"
    repo = _repo(home, root / "r")
    _git(home, "-C", str(repo), "config", "remote.origin.url", f"https://{TOKEN}@github.com/a/b")
    monkeypatch.setattr(cs, "REPO_READ_SECONDS", 0.0)
    result = cs.run_scan(_ctx(home, [root]))
    assert not _url_token_steps(result)
    assert result["roots"][0]["truncated"] is True and result["complete"] is False


@needs_git
@pytest.mark.asyncio
async def test_r2_7_roots_removed_mid_scan_are_not_cached(home, tmp_path):
    import asyncio

    a = tmp_path / "A"
    repo = _repo(home, a / "r")
    _git(home, "-C", str(repo), "config", "remote.origin.url", f"https://{TOKEN}@github.com/a/b")
    gate = threading.Event()
    db = Database(tmp_path / "navide.db")
    db.kv_set(cs.ROOTS_KV_KEY, [str(a)], now=1)

    def factory(roots):
        ctx = _ctx(home, [Path(p) for p, _ in roots])
        real = ctx.run

        def slow(argv, **kw):
            gate.wait(5)
            return real(argv, **kw)

        ctx.run = slow
        return ctx

    svc = cs.CredentialsService(db_getter=lambda: db, workspace_roots=lambda: [], context_factory=factory,
                                system_dirs=lambda: [home / ".ssh"])
    task = asyncio.ensure_future(svc.scan(force=True))
    await asyncio.sleep(0.2)
    await asyncio.get_running_loop().run_in_executor(None, svc.roots_set, [])
    gate.set()
    await task
    after = await svc.scan()
    assert after["roots"] == []
    assert not _url_token_steps(after)


def test_r2_8_keychain_item_ids_are_not_recomputable(home):
    dump = 'class: "inet"\nattributes:\n    "acct"<blob>="alice"\n    "srvr"<blob>="github.com"\n'

    def run(argv, **kw):
        return cs.RunResult(0, dump) if Path(argv[0]).name == "security" else cs.RunResult(1)

    ctx = _ctx(home, [], which=lambda n: "/fake/security" if n == "security" else None, run=run)
    first = [i["id"] for i in cs.run_scan(ctx)["items"] if i["kind"] == "keychain-item"]
    second = [i["id"] for i in cs.run_scan(ctx)["items"] if i["kind"] == "keychain-item"]
    guess = cs._fingerprint("item", "keychain-item", "internet-password||github.com|alice|")
    assert len(first) == 1 and guess not in first and first != second


def test_r2_10_cli_config_hosts_are_validated(home):
    cfg = home / ".config" / "gh"
    cfg.mkdir(parents=True)
    (cfg / "hosts.yml").write_text("github.com@evil.example/x?:\n    oauth_token: gho_zzz\n    user: me\n")
    ctx = _ctx(home, [], which=lambda n: None)
    ctx.env = {"HOME": str(home), "GH_CONFIG_DIR": str(cfg)}
    result = cs.run_scan(ctx)
    plaintext = [f for f in result["findings"] if f["code"] == "cli-token-plaintext"]
    assert plaintext and all(f["links"] == [] for f in plaintext)
    assert "evil.example" not in json.dumps([f["links"] for f in result["findings"]])
    assert cs._host_links("github.com@evil.example/x?", {"github.com@evil.example/x?"}) == []
    assert cs._host_links("git.corp.example:8443", {"git.corp.example:8443"}) != []


@needs_git
def test_r2_11_masked_helper_context_gets_no_mismatched_step(home):
    key = "credential.https://me:SECRETPW@host.example.helper"
    _git(home, "config", "--global", "--add", key, "store")
    _git(home, "config", "--global", "--add", key, "store")
    result = cs.run_scan(_ctx(home, []))
    dup = [f for f in result["findings"] if f["code"] == "helper-duplicate"]
    assert dup and all(f["manual_fix"] and not f["steps"] for f in dup)
    assert "SECRETPW" not in json.dumps(result)


@pytest.mark.asyncio
async def test_r2_9_findings_docstring_no_longer_mentions_steps():
    from agent_team_backend.mcp_server import server as plan_mcp

    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    assert "steps" not in (tools["credentials_findings"].description or "")


# ══ Security review round 3 (R3-1, R3-2, R3-4) ══════════════════════════════


@pytest.mark.parametrize("bad", ["@x", "=x", "~x", "+x", ".x", ":x", "_x"])
def test_r3_1_scanned_values_must_start_alphanumeric_or_slash(bad):
    assert cs.safe_command("git", "-C", cs.StepValue(bad)) is None
    assert cs.safe_command("git", "-C", cs.StepValue("/a/b"), cs.StepValue("x1@y")) == "git -C /a/b x1@y"


def test_r3_1_remote_names_may_not_start_with_a_digit():
    assert cs.safe_command("git", "remote", "set-url", "--", cs.RemoteName("1origin"), cs.StepValue("https://h/x")) is None
    assert cs.safe_command("git", "remote", "set-url", "--", cs.RemoteName("origin2"), cs.StepValue("https://h/x")) == \
        "git remote set-url -- origin2 https://h/x"


@needs_git
@pytest.mark.parametrize("name", ["@upstream", "=x", "~x", "+x", "9lives"])
def test_r3_1_hostile_remote_name_starts_need_a_manual_fix(home, tmp_path, name):
    root = tmp_path / "ws"
    repo = _repo(home, root / "r")
    _git(home, "-C", str(repo), "config", f"remote.{name}.url", f"https://{TOKEN}@github.com/a/b")
    findings = _url_token_steps(cs.run_scan(_ctx(home, [root])))
    assert findings and all(f["manual_fix"] and not f["steps"] for f in findings)


@pytest.mark.asyncio
async def test_r3_2_a_scan_from_an_older_roots_generation_is_not_joined(tmp_path):
    import asyncio

    gate = threading.Event()
    seen_roots: list[list[str]] = []
    keep = tmp_path / "keep"
    keep.mkdir()
    db = Database(tmp_path / "navide.db")
    db.kv_set(cs.ROOTS_KV_KEY, [str(keep)], now=1)

    def factory(roots):
        seen_roots.append([p for p, _ in roots])
        if len(seen_roots) == 1:
            gate.wait(5)
        return _ctx(tmp_path, [Path(p) for p, _ in roots], which=lambda n: None, system_dirs=[])

    svc = cs.CredentialsService(db_getter=lambda: db, workspace_roots=lambda: [], context_factory=factory,
                                system_dirs=lambda: [])
    old = asyncio.ensure_future(svc.scan(force=True))
    await asyncio.sleep(0.2)
    await asyncio.get_running_loop().run_in_executor(None, svc.roots_set, [])
    new = asyncio.ensure_future(svc.scan(force=True))
    await asyncio.sleep(0.05)
    gate.set()
    await old
    result = await new
    assert result["roots"] == []
    assert seen_roots[-1] == []


def test_r3_4_yaml_host_keys_may_carry_a_port():
    gh = "git.corp.example:8443:\n    oauth_token: gho_x\n    user: me\n"
    assert cs.yaml_token_hosts(gh) == {"git.corp.example:8443": True}
    glab = "hosts:\n    gitlab.corp.example:8443:\n        token: x\n        api_host: gitlab.corp.example:8443\n"
    assert cs.yaml_token_hosts(glab) == {"gitlab.corp.example:8443": True}
    assert cs.yaml_token_hosts("github.com:\n    oauth_token: x\n") == {"github.com": True}


def test_r3_4_port_host_from_cli_config_gets_trusted_links(home):
    cfg = home / ".config" / "glab-cli"
    cfg.mkdir(parents=True)
    (cfg / "config.yml").write_text("hosts:\n    gitlab.corp.example:8443:\n        token: x\n")
    ctx = _ctx(home, [], which=lambda n: None)
    result = cs.run_scan(ctx)
    finding = next(f for f in result["findings"] if f["code"] == "cli-token-plaintext")
    assert finding["params"]["host"] == "gitlab.corp.example:8443"
    assert finding["links"][0]["url"] == "https://gitlab.corp.example:8443/-/user_settings/personal_access_tokens"
