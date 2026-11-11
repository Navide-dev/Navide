"""kiro (Kiro CLI, AWS) vendor spec, its per-pane home and its turn-end hook.

Wired from the official docs (kiro.dev, read 2026-11-12) with no binary
installed. The end-to-end cases run a fake ``kiro-cli`` written from those
docs: it resolves its home the way ``KIRO_HOME`` is documented to, reads
``settings/mcp.json`` there, and on every turn end runs the command of each
``Stop`` hook in ``hooks/*.json`` with the documented stdin JSON
(``hook_event_name``, ``cwd``, ``session_id``), treating a non-zero exit as a
hook error.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from agent_team_backend import applog, guard_hooks, hook_auth, kiro_hooks
from agent_team_backend.cli_vendors import kiro, registry
from agent_team_backend.cli_vendors.base import VendorRuntimeContext
from agent_team_backend.mcp_server import pane_home

SPEC = registry.VENDORS["kiro"]
URL = "http://127.0.0.1:4567/plan-mcp?pane=p1&t=tok"
SERVER = "navide"

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="the hook command is a POSIX shell line")


# ---- the spec ----


def test_identity() -> None:
    assert SPEC.key == "kiro"
    assert SPEC.label == "Kiro CLI (AWS)"


def test_install_entry_runs_no_installer_on_any_platform() -> None:
    """The official installer is `curl | bash`; Navide only links the docs."""
    dep = SPEC.install_dep
    assert dep is not None
    assert dep.group == "agent_cli"
    assert dep.check_cmd == ["kiro-cli", "--version"]
    assert dep.install_cmd == ""
    assert dep.install_cmds == {}
    assert dep.platforms == ()
    assert dep.docs_url == "https://kiro.dev/docs/cli/"
    assert dep.update_cmd == "kiro-cli update"
    # The CLI documents `diagnostic`; there is no `doctor` subcommand.
    assert dep.doctor_cmd == "kiro-cli diagnostic"


def test_version_regex_reads_a_three_part_version() -> None:
    """The --version line is undocumented; only the number is matched."""
    for line, version in (("kiro-cli 3.2.0", "3.2.0"), ("3.1.4\n", "3.1.4"), ("Kiro CLI v2.37.1", "2.37.1")):
        match = re.search(SPEC.install_dep.version_regex, line)
        assert match is not None and match.group(1) == version, line


def test_navide_holds_no_key_and_switches_no_account() -> None:
    assert SPEC.live_file is None
    assert SPEC.account_switch is None
    assert SPEC.fetch_usage is None
    assert SPEC.login_command_args is None
    assert SPEC.quota_exhausted_patterns == ()


def test_no_resume_model_reader_or_verified_version() -> None:
    assert SPEC.supports_session_resume is False
    assert SPEC.make_log_reader is None
    assert SPEC.supports_model is False
    assert SPEC.supports_effort is False
    assert SPEC.cli_verified_version == ""


def test_extensions_declared_unverified() -> None:
    assert SPEC.extensions is not None
    assert SPEC.extensions.supported is False
    assert SPEC.extensions.sources == ()


def test_data_root_follows_kiro_home(tmp_path: Path) -> None:
    home = tmp_path / "home"
    moved = tmp_path / "moved"
    assert kiro._home(VendorRuntimeContext(home=home, env={}, cwd=tmp_path)) == home / ".kiro"
    assert kiro._home(VendorRuntimeContext(home=home, env={"KIRO_HOME": str(moved)}, cwd=tmp_path)) == moved
    assert SPEC.home_env_vars == ("KIRO_HOME",)


def test_mcp_is_a_per_pane_kiro_home_with_settings_mcp_json() -> None:
    wiring = SPEC.mcp_wiring
    assert wiring is not None
    assert (wiring.config_dir, wiring.config_dir_env, wiring.config_file) == (
        ".kiro", "KIRO_HOME", ("settings", "mcp.json"),
    )
    shim = pane_home.SHIM_SPECS["kiro"]
    assert shim.shims_home is False  # $HOME is left alone, like kimi
    assert shim.spawn_env("/x") == {"KIRO_HOME": "/x"}


def test_the_turn_hook_is_declared_and_names_its_pane_by_token() -> None:
    assert SPEC.install_hooks is not None
    assert SPEC.hook_pane_token is True
    # The startup installer never writes into the user's ~/.kiro.
    assert SPEC.install_hooks("/nonexistent/port")["installed"] is False


# ---- the hook file ----


def test_hook_file_is_one_v3_stop_hook_posting_to_hooks_kiro(tmp_path: Path) -> None:
    document = kiro_hooks.document(str(tmp_path / "port"))
    assert document["version"] == "v1"
    [hook] = document["hooks"]
    assert hook["trigger"] == "Stop"
    assert hook["action"]["type"] == "command"
    assert hook["timeout"] == 5
    command = hook["action"]["command"]
    assert "/hooks/kiro" in command
    assert "X-Agent-Team-Event: stop" in command or "'stop'" in command
    assert guard_hooks.PANE_TOKEN_ENV in command
    # The secret is read from its file at fire time, never written inline.
    assert hook_auth.token() not in command


# ---- the per-pane home ----


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    fake = tmp_path / "home"
    fake.mkdir()
    monkeypatch.setattr(pane_home, "real_home", lambda: fake)
    return fake


@pytest.fixture
def port_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "backend.port"
    monkeypatch.setattr(applog, "backend_port_file", lambda: path)
    return path


def _user_kiro(home: Path) -> Path:
    real = home / ".kiro"
    (real / "settings").mkdir(parents=True)
    (real / "settings" / "cli.json").write_text('{"chat.defaultModel": "auto"}', encoding="utf-8")
    (real / "settings" / "mcp.json").write_text(
        json.dumps({"mcpServers": {"mine": {"command": "my-server"}}}), encoding="utf-8"
    )
    (real / "hooks").mkdir()
    (real / "agents").mkdir()
    return real


def test_shim_links_the_users_kiro_and_owns_only_mcp_json_and_navides_hook(home: Path, port_file: Path) -> None:
    real = _user_kiro(home)
    (real / "hooks" / "lint.json").write_text("{}", encoding="utf-8")
    prepared = pane_home.prepare("kiro", "p1", URL, SERVER)
    assert prepared is not None
    env_var, root_text = prepared
    root = Path(root_text)
    assert env_var == "KIRO_HOME"
    assert root == home / ".navide-panes" / "kiro" / "p1"

    assert (root / "agents").is_symlink()
    assert (root / "settings" / "cli.json").is_symlink()
    mcp = root / "settings" / "mcp.json"
    assert not mcp.is_symlink()
    assert json.loads(mcp.read_text(encoding="utf-8"))["mcpServers"] == {
        "mine": {"command": "my-server"}, SERVER: {"url": URL},
    }

    hooks = root / "hooks"
    assert hooks.is_dir() and not hooks.is_symlink()
    assert (hooks / "lint.json").is_symlink()
    ours = hooks / kiro_hooks.HOOK_FILENAME
    assert not ours.is_symlink()
    assert json.loads(ours.read_text(encoding="utf-8")) == kiro_hooks.document(str(port_file))

    # The user's own tree is not written.
    assert not (real / "hooks" / kiro_hooks.HOOK_FILENAME).exists()
    assert SERVER not in json.loads((real / "settings" / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]


def test_a_linked_hooks_dir_is_replaced_never_written_through(home: Path, port_file: Path) -> None:
    real = _user_kiro(home)
    root = home / ".navide-panes" / "kiro" / "p1"
    root.mkdir(parents=True)
    (root / "hooks").symlink_to(real / "hooks", target_is_directory=True)
    pane_home.prepare("kiro", "p1", URL, SERVER)
    assert not (root / "hooks").is_symlink()
    assert (root / "hooks" / kiro_hooks.HOOK_FILENAME).is_file()
    assert list((real / "hooks").iterdir()) == []


def test_a_hook_kiro_created_inside_the_pane_moves_to_the_users_dir(home: Path, port_file: Path) -> None:
    real = _user_kiro(home)
    pane_home.prepare("kiro", "p1", URL, SERVER)
    root = home / ".navide-panes" / "kiro" / "p1"
    (root / "hooks" / "made-in-pane.json").write_text("{}", encoding="utf-8")
    pane_home.prepare("kiro", "p1", URL, SERVER)
    assert (real / "hooks" / "made-in-pane.json").is_file()
    assert (root / "hooks" / "made-in-pane.json").is_symlink()


def test_no_user_kiro_yet_still_builds_a_wired_home(home: Path, port_file: Path) -> None:
    prepared = pane_home.prepare("kiro", "p1", URL, SERVER)
    assert prepared is not None
    root = Path(prepared[1])
    assert json.loads((root / "settings" / "mcp.json").read_text(encoding="utf-8")) == {
        "mcpServers": {SERVER: {"url": URL}},
    }
    assert (root / "hooks" / kiro_hooks.HOOK_FILENAME).is_file()
    assert not (home / ".kiro").exists()


# ---- end to end with a fake kiro-cli ----

# Written from kiro.dev/docs (cli-commands, settings, mcp/configuration,
# hooks, hooks/types, hooks/actions), read 2026-11-12.
FAKE_KIRO = r'''
import glob, json, os, subprocess, sys, uuid
from pathlib import Path

args = sys.argv[1:]
if args in (["--version"], ["-V"]):
    print("kiro-cli 3.2.0")
    sys.exit(0)
if not args or args[0] != "chat":
    print("error: unrecognized subcommand", file=sys.stderr)
    sys.exit(2)
for flag in args[1:]:
    if flag not in ("--v3", "--trust-all-tools"):
        print(f"error: unexpected argument '{flag}'", file=sys.stderr)
        sys.exit(2)

# KIRO_HOME replaces ~/.kiro when it is an absolute path that is not the
# filesystem root, the home or one of its ancestors.
user_home = Path(os.path.expanduser("~")).resolve()
default = user_home / ".kiro"
raw = os.environ.get("KIRO_HOME", "")
home = default
if raw and os.path.isabs(raw):
    candidate = Path(raw).resolve()
    if candidate != Path(candidate.anchor) and candidate not in (user_home, *user_home.parents):
        home = candidate

try:
    servers = json.loads((home / "settings" / "mcp.json").read_text())["mcpServers"]
except (OSError, ValueError, KeyError):
    servers = {}
for name, entry in sorted(servers.items()):
    print(f"mcp: {name} {entry.get('url') or entry.get('command')}")

session_id = str(uuid.uuid4())
print("ready", flush=True)
for line in sys.stdin:
    print(f"reply: {line.strip()}", flush=True)
    for path in sorted(glob.glob(str(home / "hooks" / "*.json"))):
        try:
            document = json.loads(Path(path).read_text())
        except (OSError, ValueError):
            continue
        for hook in document.get("hooks", []):
            action = hook.get("action") or {}
            if hook.get("trigger") != "Stop" or hook.get("enabled") is False or action.get("type") != "command":
                continue
            payload = {"hook_event_name": "Stop", "cwd": os.getcwd(), "session_id": session_id}
            done = subprocess.run(action["command"], shell=True, input=json.dumps(payload),
                                  text=True, capture_output=True, timeout=hook.get("timeout") or 60)
            if done.returncode != 0:
                print(f"hook error: {hook.get('name')}: {done.stderr.strip()}", flush=True)
'''


class _Capture(BaseHTTPRequestHandler):
    calls: list[dict] = []

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        type(self).calls.append({"path": self.path, "headers": dict(self.headers), "body": json.loads(body)})
        reply = b'{"ok": true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

    def log_message(self, *_args) -> None:
        pass


@pytest.fixture
def backend(port_file: Path):
    _Capture.calls = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Capture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port_file.write_text(str(server.server_address[1]), encoding="utf-8")
    try:
        yield _Capture.calls
    finally:
        server.shutdown()
        server.server_close()


def _run_fake(tmp_path: Path, home: Path, env_extra: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    script = tmp_path / "kiro_cli_fake.py"
    script.write_text(FAKE_KIRO, encoding="utf-8")
    workspace = tmp_path / "ws"
    workspace.mkdir(exist_ok=True)
    env = {k: v for k, v in os.environ.items() if k != "KIRO_HOME"}
    env.update({"HOME": str(home), **env_extra})
    return subprocess.run(
        [sys.executable, str(script), *args], input="hello\n", text=True,
        capture_output=True, env=env, cwd=workspace, timeout=60,
    )


def test_fake_kiro_follows_the_documented_flags(tmp_path: Path, home: Path) -> None:
    assert _run_fake(tmp_path, home, {}, "--version").stdout.strip() == "kiro-cli 3.2.0"
    # The pane's default command and the YOLO flag are accepted.
    assert _run_fake(tmp_path, home, {}, "chat", "--v3", "--trust-all-tools").returncode == 0
    assert _run_fake(tmp_path, home, {}, "chat", "--yolo").returncode == 2


@posix_only
def test_a_pane_kiro_sees_navide_mcp_and_its_stop_hook_names_the_pane(
    tmp_path: Path, home: Path, backend: list[dict]
) -> None:
    real = _user_kiro(home)
    marker = tmp_path / "user-hook-ran"
    (real / "hooks" / "mine.json").write_text(json.dumps({
        "version": "v1",
        "hooks": [{"name": "mine", "trigger": "Stop", "action": {"type": "command", "command": f"touch {shlex.quote(str(marker))}"}}],
    }), encoding="utf-8")
    _, root = pane_home.prepare("kiro", "p1", URL, SERVER)  # type: ignore[misc]
    shim = pane_home.SHIM_SPECS["kiro"]

    done = _run_fake(
        tmp_path, home, {**shim.spawn_env(root), guard_hooks.PANE_TOKEN_ENV: "pane-token-1"}, "chat", "--v3",
    )

    assert done.returncode == 0, done.stderr
    assert f"mcp: {SERVER} {URL}" in done.stdout
    assert "mcp: mine my-server" in done.stdout
    assert "hook error" not in done.stdout
    assert marker.exists(), "the user's own Stop hook still runs in the pane"
    [call] = backend
    assert call["path"] == "/hooks/kiro"
    headers = {k.lower(): v for k, v in call["headers"].items()}
    assert headers["x-agent-team-event"] == "stop"
    assert headers[guard_hooks.PANE_TOKEN_HEADER.lower()] == "pane-token-1"
    assert headers[hook_auth.HEADER.lower()] == hook_auth.token()
    assert call["body"]["hook_event_name"] == "Stop"
    assert os.path.samefile(call["body"]["cwd"], tmp_path / "ws")
    assert call["body"]["session_id"]


@posix_only
def test_kiro_outside_navide_never_posts(tmp_path: Path, home: Path, backend: list[dict]) -> None:
    _user_kiro(home)
    pane_home.prepare("kiro", "p1", URL, SERVER)  # a pane exists, but this run is not in it
    done = _run_fake(tmp_path, home, {}, "chat", "--v3")
    assert done.returncode == 0, done.stderr
    assert f"mcp: {SERVER}" not in done.stdout
    assert backend == []


@posix_only
def test_the_hook_exits_zero_when_navide_is_not_running(
    tmp_path: Path, home: Path, port_file: Path
) -> None:
    """Kiro shows a non-zero hook exit to the agent as an error."""
    _, root = pane_home.prepare("kiro", "p1", URL, SERVER)  # type: ignore[misc]
    port_file.write_text("1", encoding="utf-8")  # nothing listens there
    done = _run_fake(tmp_path, home, {"KIRO_HOME": root}, "chat", "--v3")
    assert done.returncode == 0, done.stderr
    assert "reply: hello" in done.stdout
    assert "hook error" not in done.stdout
