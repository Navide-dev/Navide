"""The Windows exec-form guard hook for Claude Code, and its fallback.

Claude Code 2.1.139+ runs a hook with `args` directly, with no shell; on
Windows that takes PowerShell's cold start out of the guard hook. Anything
older, or a version no probe has seen, keeps the PowerShell hook exactly.
"""

from __future__ import annotations

import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from agent_team_backend import claude_hooks, hook_auth, osplat
from tests.test_claude_hooks import _run_to_completion

DENY = b'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'
ALLOW = b'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
USER_HOOK = {"matcher": "Bash", "hooks": [{"type": "command", "command": "mine.cmd"}]}


@pytest.fixture(autouse=True)
def _push_channel_off(monkeypatch):
    monkeypatch.setattr(claude_hooks, "_rewake_wanted", lambda: False)


@pytest.fixture
def on_windows(monkeypatch):
    """The installer's view of a Windows box (the text is only executed on one)."""
    if osplat.platform_id != "win32":
        from agent_team_backend.osplat import _windows

        monkeypatch.setattr(osplat, "platform_id", "win32")
        monkeypatch.setattr(osplat, "scripts", _windows.scripts)


def _version(monkeypatch, version):
    monkeypatch.setattr(claude_hooks, "_known_claude_version", lambda: version)


def _port_file() -> str:
    return str(hook_auth.header_file().parent / "backend-port")


def _guards(settings: Path) -> list[dict]:
    pre = json.loads(settings.read_text(encoding="utf-8"))["hooks"]["PreToolUse"]
    return [h for e in pre for h in e["hooks"] if h.get("timeout") == claude_hooks._GUARD_TIMEOUT_S]


def _powershell_guard(port_file: str) -> dict:
    return {
        **osplat.scripts.hook_entry(claude_hooks._build_guard_command(port_file)),
        "timeout": claude_hooks._GUARD_TIMEOUT_S,
    }


def test_a_new_enough_claude_gets_the_exec_form(on_windows, monkeypatch, tmp_path) -> None:
    _version(monkeypatch, (2, 1, 139))
    port_file = _port_file()
    entry = claude_hooks.guard_hook_entry(port_file)
    script = Path(port_file).parent / "navide-guard.cmd"
    assert entry == {"type": "command", "command": "cmd.exe", "args": ["/d", "/c", str(script)], "timeout": 10}
    text = script.read_bytes().decode("ascii")
    assert "/hooks/claude/pretooluse" in text and "%~dp0backend-port" in text and "%~dp0hook-auth" in text
    assert text.rstrip().endswith("exit /b 0")


@pytest.mark.parametrize("version", [None, (2, 1, 138), (1, 9, 999)], ids=["unknown", "2.1.138", "1.x"])
def test_an_older_or_unknown_claude_keeps_the_powershell_hook(on_windows, monkeypatch, version) -> None:
    _version(monkeypatch, version)
    port_file = _port_file()
    assert claude_hooks.guard_hook_entry(port_file) == _powershell_guard(port_file)
    assert not (Path(port_file).parent / "navide-guard.cmd").exists()


@pytest.mark.parametrize("dirname", ["Navide (work)", "a&b", "100%"])
def test_a_path_cmd_cannot_quote_keeps_the_powershell_hook(on_windows, monkeypatch, tmp_path, dirname) -> None:
    _version(monkeypatch, (2, 1, 287))
    data = tmp_path / dirname
    data.mkdir()
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(data))
    port_file = _port_file()
    assert claude_hooks.guard_hook_entry(port_file) == _powershell_guard(port_file)


def test_the_qwen_guard_hook_never_takes_the_exec_form(on_windows, monkeypatch) -> None:
    _version(monkeypatch, (2, 1, 287))
    assert claude_hooks.guard_hook_entry(_port_file(), endpoint="qwen")["shell"] == "powershell"


def test_an_upgrade_replaces_the_powershell_guard_and_keeps_user_hooks(on_windows, monkeypatch, tmp_path) -> None:
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"hooks": {"PreToolUse": [USER_HOOK]}}), encoding="utf-8")
    port_file = _port_file()
    _version(monkeypatch, None)
    claude_hooks.install_hooks(port_file, settings_file=settings)
    assert _guards(settings) == [_powershell_guard(port_file)]

    _version(monkeypatch, (2, 1, 287))
    for _ in range(3):
        claude_hooks.install_hooks(port_file, settings_file=settings)
    pre = json.loads(settings.read_text(encoding="utf-8"))["hooks"]["PreToolUse"]
    assert pre[0] == USER_HOOK
    (guard,) = _guards(settings)
    assert guard["command"] == "cmd.exe"
    # The signal hook beside it is unchanged.
    assert len([h for e in pre for h in e["hooks"]]) == 3

    # And back: a probe that no longer sees a new enough build restores it.
    _version(monkeypatch, (2, 1, 100))
    claude_hooks.install_hooks(port_file, settings_file=settings)
    assert _guards(settings) == [_powershell_guard(port_file)]

    _version(monkeypatch, (2, 1, 287))
    claude_hooks.install_hooks(port_file, settings_file=settings)
    claude_hooks.uninstall_hooks(settings_file=settings)
    assert json.loads(settings.read_text(encoding="utf-8"))["hooks"] == {"PreToolUse": [USER_HOOK]}


def test_a_changed_probe_reinstalls_and_an_unchanged_one_does_not(monkeypatch) -> None:
    store: dict = {}

    class FakeDb:
        def kv_get(self, key, default=None):
            return store.get(key, default)

        def kv_set(self, key, value, *, now):
            store[key] = value

    from agent_team_backend import onboarding_deps

    monkeypatch.setattr(onboarding_deps, "_get_db", lambda: FakeDb())
    installs: list[str] = []
    monkeypatch.setattr(claude_hooks, "install_hooks", lambda port_file, **_kw: installs.append(port_file))
    monkeypatch.setattr(claude_hooks, "_probe_claude_version", lambda: (2, 1, 287))
    claude_hooks._refresh_claude_version("p")
    assert claude_hooks._known_claude_version() == (2, 1, 287) and installs == ["p"]
    claude_hooks._refresh_claude_version("p")
    assert installs == ["p"]
    monkeypatch.setattr(claude_hooks, "_probe_claude_version", lambda: None)
    claude_hooks._refresh_claude_version("p")
    assert claude_hooks._known_claude_version() is None and installs == ["p", "p"]


def test_the_posix_guard_hook_is_unchanged(monkeypatch, tmp_path) -> None:
    # Pinned to the text earlier builds wrote: the exec form is Windows-only.
    if osplat.platform_id == "win32" or osplat.paths.resolve_program("curl") is None:
        pytest.skip("pins the POSIX curl rendering")
    header = hook_auth.header_file()
    _version(monkeypatch, (2, 1, 287))
    assert claude_hooks.guard_hook_entry("/tmp/port-file") == {
        "type": "command",
        "command": (
            "# agent-team-hook kind=guard\n"
            "PORT=$(cat /tmp/port-file 2>/dev/null); [ -n \"$PORT\" ] && curl -fsS -m 9 -X POST "
            "-H 'Content-Type: application/json' -H 'X-Agent-Team-Event: pre_tool_use' "
            f"-H @{header} -H \"X-Navide-Pane-Token: $NAVIDE_GUARD_PANE_TOKEN\" "
            "--data-binary @- \"http://127.0.0.1:$PORT/hooks/claude/pretooluse\" || true"
        ),
        "timeout": 10,
    }


# ── executed for real: Windows only ──────────────────────────────────────────


def _serve(status: int, body: bytes):
    received: list[tuple[str, bytes, str | None]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            received.append((
                self.path,
                self.rfile.read(int(self.headers["Content-Length"])),
                self.headers.get("X-Navide-Pane-Token"),
            ))
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = 60
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    return server, thread, received


@pytest.fixture
def exec_hook(monkeypatch, tmp_path):
    if osplat.platform_id != "win32":
        pytest.skip("runs cmd.exe")
    _version(monkeypatch, (2, 1, 287))
    # A space and non-ASCII in the data dir: user names carry both.
    data = tmp_path / "Navide 使用者"
    data.mkdir()
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(data))
    entry = claude_hooks.guard_hook_entry(_port_file())
    assert entry["command"] == "cmd.exe"
    # A list, so Python quotes it the way Node does for Claude Code's spawn.
    return [entry["command"], *entry["args"]], Path(_port_file())


PAYLOAD = '{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"C:/工作區"}'


@pytest.mark.parametrize("status,body,expected", [
    (200, DENY, DENY.decode()), (200, ALLOW, ALLOW.decode()), (403, b"", ""),
], ids=["deny", "allow", "403"])
@pytest.mark.parametrize("token", ["pane-token-123", None])
def test_the_exec_form_prints_the_decision_and_exits_zero(exec_hook, monkeypatch, status, body, expected, token) -> None:
    argv, port_file = exec_hook
    if token is None:
        monkeypatch.delenv("NAVIDE_GUARD_PANE_TOKEN", raising=False)
    else:
        monkeypatch.setenv("NAVIDE_GUARD_PANE_TOKEN", token)
    server, thread, received = _serve(status, body)
    port_file.write_text(f"{server.server_port}\n", encoding="utf-8")
    try:
        result = _run_to_completion(argv, PAYLOAD, timeout=45)
        thread.join(timeout=61)
    finally:
        server.server_close()
    assert received and received[0][:2] == ("/hooks/claude/pretooluse", PAYLOAD.encode())
    assert (received[0][2] or None) == token
    assert (result.returncode, result.stdout) == (0, expected)


def test_the_exec_form_without_a_port_file_is_no_decision(exec_hook) -> None:
    argv, _port_file_path = exec_hook
    result = _run_to_completion(argv, PAYLOAD, timeout=45)
    assert (result.returncode, result.stdout) == (0, "")


def test_the_exec_form_with_the_backend_down_is_no_decision(exec_hook) -> None:
    argv, port_file = exec_hook
    server = HTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    port = server.server_port
    server.server_close()
    port_file.write_text(str(port), encoding="utf-8")
    result = _run_to_completion(argv, PAYLOAD, timeout=45)
    assert (result.returncode, result.stdout) == (0, "")


def test_python_quotes_the_script_path_like_node(exec_hook) -> None:
    # What cmd receives is `cmd.exe /d /c "<path with a space>"`: exactly two
    # quotes, which `cmd /c` keeps.
    argv, _ = exec_hook
    assert subprocess.list2cmdline(argv).endswith(f'/c "{argv[-1]}"')
