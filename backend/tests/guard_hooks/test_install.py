"""What each vendor's installer writes for Navide Guard's PreToolUse hook.

The guard hook is added beside the existing hooks, never in place of them: the
signal hooks feed activity detection and must keep their exact text, while the
guard hook is the one whose printed body the CLI reads as a decision.
"""

from __future__ import annotations

import json
import shlex
import subprocess
import sys
import threading
import tomllib
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from agent_team_backend import claude_hooks, codex_session_hooks, copilot_hooks, osplat, qwen_hooks
from agent_team_backend.claude_hooks import _build_curl_command
from agent_team_backend.osplat import _windows
from tests import hook_shell
from tests.test_claude_hooks import _run_to_completion


@pytest.fixture(autouse=True, scope="module")
def _warm_powershell():
    # The PowerShell hook tests measure the shell's cold start inside the first
    # test that needs it. Measured here instead, a start that hangs is killed
    # and retried after 50 s rather than waited on for 300 s, which outlived
    # pytest-timeout's 120 s (PR #236, Windows 1/4). Two
    # attempts fit that 120 s even with the 24 s cold start of the arm runner.
    if sys.platform == "win32":
        hook_shell.warm_powershell(attempt_s=50)


@pytest.fixture(autouse=True)
def _push_channel_off(monkeypatch):
    # The rewake waiter is conditional on claude's push channel; pinning it
    # keeps these goldens independent of the test database's switch.
    monkeypatch.setattr(claude_hooks, "_rewake_wanted", lambda: False)


@pytest.fixture(autouse=True)
def _claude_version(monkeypatch):
    # The permission-hold events are written only for a Claude Code that knows
    # them. Pinned to a current build here, never read from the test database.
    monkeypatch.setattr(claude_hooks, "_known_claude_version", lambda: (2, 1, 303))


def _ours(entries: list) -> list[dict]:
    return [
        h for e in entries for h in e.get("hooks", [])
        if claude_hooks._is_ours(str(h.get("command", "")))
    ]


def test_claude_pretooluse_keeps_the_signal_hook_and_adds_a_guard_hook(tmp_path) -> None:
    settings = tmp_path / "settings.json"
    claude_hooks.install_hooks("/tmp/port-file", settings_file=settings)

    hooks = json.loads(settings.read_text())["hooks"]
    pre = _ours(hooks["PreToolUse"])
    assert len(pre) == 2
    signal, guard = pre
    # The signal hook is byte-for-byte what earlier builds wrote.
    assert signal == osplat.scripts.hook_entry(_build_curl_command("/tmp/port-file", "pre_tool_use"))
    assert guard["command"].startswith("# agent-team-hook kind=guard\n")
    assert "/hooks/claude/pretooluse" in guard["command"]
    assert guard["timeout"] == 10
    # The body is the decision: it must reach stdout.
    assert "-o /dev/null" not in guard["command"]
    assert "-m 9 " in guard["command"]


def test_claude_other_events_are_unchanged(tmp_path) -> None:
    settings = tmp_path / "settings.json"
    claude_hooks.install_hooks("/tmp/port-file", settings_file=settings)

    hooks = json.loads(settings.read_text())["hooks"]
    for event, kind in (
        ("Stop", "stop"), ("Notification", "notification"), ("SubagentStop", "subagent_stop"),
        ("PermissionRequest", "permission_request"),
    ):
        assert _ours(hooks[event]) == [
            osplat.scripts.hook_entry(_build_curl_command("/tmp/port-file", kind))
        ], event


def test_claude_per_tool_report_hooks_run_in_the_background(tmp_path) -> None:
    # PostToolUse(Failure) fire once per tool call and only report, so they must
    # not add a blocking hook process to each call; PermissionRequest stays sync.
    settings = tmp_path / "settings.json"
    claude_hooks.install_hooks("/tmp/port-file", settings_file=settings)

    hooks = json.loads(settings.read_text())["hooks"]
    for event, kind in (("PostToolUse", "post_tool_use"), ("PostToolUseFailure", "post_tool_use_failure")):
        assert _ours(hooks[event]) == [
            {**osplat.scripts.hook_entry(_build_curl_command("/tmp/port-file", kind)), "async": True}
        ], event
    assert all("async" not in h for h in _ours(hooks["PermissionRequest"]))


_HOLD_EVENTS = ("PermissionRequest", "PostToolUse", "PostToolUseFailure")


@pytest.mark.parametrize("version, written", [
    (None, False),  # not probed yet: a Claude Code that rejects the file is the worse mistake
    ((2, 0, 56), False),
    ((2, 1, 14), False),
    ((2, 1, 15), True),
    ((2, 1, 303), True),
])
def test_claude_permission_hold_events_need_a_claude_that_knows_them(
    tmp_path, monkeypatch, version, written
) -> None:
    monkeypatch.setattr(claude_hooks, "_known_claude_version", lambda: version)
    settings = tmp_path / "settings.json"
    claude_hooks.install_hooks("/tmp/port-file", settings_file=settings)

    hooks = json.loads(settings.read_text())["hooks"]
    for event in _HOLD_EVENTS:
        assert (event in hooks) is written, event


def test_claude_gated_off_leaves_the_guard_and_every_other_event_byte_identical(
    tmp_path, monkeypatch
) -> None:
    full, gated = tmp_path / "full.json", tmp_path / "gated.json"
    claude_hooks.install_hooks("/tmp/port-file", settings_file=full)
    monkeypatch.setattr(claude_hooks, "_known_claude_version", lambda: None)
    claude_hooks.install_hooks("/tmp/port-file", settings_file=gated)

    written, kept = json.loads(full.read_text())["hooks"], json.loads(gated.read_text())["hooks"]
    assert set(written) - set(kept) == set(_HOLD_EVENTS)
    # PreToolUse carries the Guard hook: the whole event, not just its entries.
    assert len(_ours(kept["PreToolUse"])) == 2
    for event in kept:
        assert kept[event] == written[event], event


def test_claude_downgrade_strips_the_hold_events_and_keeps_the_user_s_own(
    tmp_path, monkeypatch
) -> None:
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"hooks": {"PostToolUse": [
        {"matcher": "Edit", "hooks": [{"type": "command", "command": "mine.sh"}]},
    ]}}))
    claude_hooks.install_hooks("/tmp/port-file", settings_file=settings)
    assert all(event in json.loads(settings.read_text())["hooks"] for event in _HOLD_EVENTS)

    monkeypatch.setattr(claude_hooks, "_known_claude_version", lambda: (2, 1, 14))
    claude_hooks.install_hooks("/tmp/port-file", settings_file=settings)

    hooks = json.loads(settings.read_text())["hooks"]
    assert [e for e in _HOLD_EVENTS if e in hooks] == ["PostToolUse"]
    assert hooks["PostToolUse"] == [{"matcher": "Edit", "hooks": [{"type": "command", "command": "mine.sh"}]}]


def test_claude_version_probe_runs_off_windows_too(monkeypatch) -> None:
    # The permission-hold events depend on the probed version, so the probe is
    # no longer a Windows-only thing.
    probed = threading.Event()
    monkeypatch.setattr(claude_hooks, "_version_refresh_started", False)
    monkeypatch.setattr(claude_hooks, "_refresh_claude_version", lambda port_file: probed.set())

    claude_hooks._start_version_probe("/tmp/port-file")

    assert probed.wait(5)


def test_claude_reinstall_and_uninstall_handle_the_guard_hook(tmp_path) -> None:
    # The marker is what an older installer (the other Navide sharing this
    # settings.json) strips by, so the guard hook must carry it too.
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"hooks": {"PreToolUse": [
        {"matcher": "Bash", "hooks": [{"type": "command", "command": "mine.sh"}]},
    ]}}))
    for _ in range(3):
        claude_hooks.install_hooks("/tmp/port-file", settings_file=settings)
    pre = json.loads(settings.read_text())["hooks"]["PreToolUse"]
    assert len(_ours(pre)) == 2
    assert pre[0] == {"matcher": "Bash", "hooks": [{"type": "command", "command": "mine.sh"}]}

    claude_hooks.uninstall_hooks(settings_file=settings)
    assert json.loads(settings.read_text())["hooks"] == {"PreToolUse": [
        {"matcher": "Bash", "hooks": [{"type": "command", "command": "mine.sh"}]},
    ]}


def test_qwen_installs_a_guard_pretooluse_hook(tmp_path) -> None:
    settings = tmp_path / "settings.json"
    qwen_hooks.install_hooks("/tmp/port-file", settings_file=settings)

    entry = json.loads(settings.read_text())["hooks"]["PreToolUse"]
    assert len(entry) == 1
    (hook,) = entry[0]["hooks"]
    assert hook["type"] == "command"
    assert hook["timeout"] == 10
    assert "/hooks/qwen/pretooluse" in hook["command"]
    assert "-o /dev/null" not in hook["command"]


def test_copilot_guard_hook_keeps_the_body_and_always_exits_zero(tmp_path) -> None:
    copilot_hooks.install_hooks("/tmp/port-file", hooks_directory=tmp_path)

    doc = json.loads((tmp_path / "agent-team.json").read_text())
    (entry,) = doc["hooks"]["preToolUse"]
    assert entry["timeoutSec"] == 10
    for key in ("command", "bash", "powershell"):
        assert "/hooks/copilot/pretooluse" in entry[key]
        assert entry[key].rstrip().endswith("exit 0"), key
    # A non-zero exit DENIES in copilot, but the body must still be printed.
    assert "-o /dev/null" not in entry["bash"]
    assert " >/dev/null" not in entry["bash"]
    assert "-o NUL" not in entry["powershell"]
    # The notification hook is untouched.
    assert "/hooks/copilot\"" in doc["hooks"]["notification"][0]["bash"]


def test_codex_wire_adds_a_parseable_pretooluse_hook(tmp_path) -> None:
    result = codex_session_hooks.wire("codex", {}, {}, tmp_path, tmp_path / "port", tmp_path / "auth")

    values = [a.split("=", 1) for a in shlex.split(result)[1:] if a != "-c"]
    keys = [k for k, _ in values]
    assert keys == ["hooks.SessionStart", "hooks.PreToolUse"]
    parsed = tomllib.loads("v = " + dict(values)["hooks.PreToolUse"])["v"]
    (hook,) = parsed[0]["hooks"]
    assert hook == {"type": "command", "command": codex_session_hooks.guard_hook_command(), "timeout": 10}
    script = hook["command"]
    if script.startswith("powershell.exe "):
        # Windows: the script travels as -EncodedCommand (UTF-16LE, base64).
        import base64

        script = base64.b64decode(script.rsplit(" ", 1)[1]).decode("utf-16-le")
    assert "/hooks/codex/pretooluse" in script
    assert script.endswith("exit 0")


def test_codex_trust_gate_leaves_the_guard_hook_out_too(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(codex_session_hooks, "trust_gate_blocks_injection", lambda: True)
    assert codex_session_hooks.wire("codex", {}, {}, tmp_path, tmp_path / "p", tmp_path / "a") == "codex"


def _serve_once(body: bytes, status: int, listen_s: float):
    received: list[tuple[str, bytes]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            received.append((self.path, self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = listen_s
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    return server, thread, received


@pytest.mark.parametrize("status,body,expected", [
    (200, b'{"hookSpecificOutput":{"permissionDecision":"deny"}}', '{"hookSpecificOutput":{"permissionDecision":"deny"}}'),
    # A 403 (hook secret from another install) is "no decision", not an error.
    (403, b"", ""),
])
def test_claude_guard_hook_prints_the_decision_and_exits_zero(tmp_path, status, body, expected) -> None:
    port_file = tmp_path / "backend.port"
    argv = hook_shell.shell_argv(osplat.scripts.hook_entry(claude_hooks._build_guard_command(str(port_file))))
    ceiling = hook_shell.hang_ceiling(argv, 45)
    # The listener outlives the client, or a slow shell would reach a closed
    # port and the 403 case would pass for the wrong reason.
    server, thread, received = _serve_once(body, status, listen_s=ceiling + 10)
    port_file.write_text(str(server.server_port), encoding="utf-8")
    try:
        result = _run_to_completion(argv, '{"tool_name":"Bash"}', timeout=ceiling)
    except subprocess.TimeoutExpired:
        # Which side of the request it stalled on is the first question.
        pytest.fail(
            f"hook still running after {ceiling:.0f}s (shell cold start "
            f"{hook_shell.cold_start_s(argv):.1f}s); request reached the server: {bool(received)}"
        )
    finally:
        thread.join(timeout=ceiling + 11)
        server.server_close()
    assert received and received[0][0] == "/hooks/claude/pretooluse"
    assert result.returncode == 0
    assert result.stdout.removesuffix("\n").removesuffix("\r") == expected


# Room for the ceiling below; CI's Windows wrapper otherwise stops it at 90 s.
@pytest.mark.timeout(150)
def test_claude_guard_hook_without_a_backend_is_no_decision(tmp_path) -> None:
    argv = hook_shell.shell_argv(osplat.scripts.hook_entry(
        claude_hooks._build_guard_command(str(tmp_path / "absent.port"))
    ))
    # On the windows-11-arm runner a PowerShell run of a hook script stalls
    # for about 23 s at a time, even when `exit 0` (what hang_ceiling's cold
    # start measures) starts in 0.4 s: release run 39898815983, job
    # 120235386516, ran this hook past its 46.2 s ceiling. Two such stalls
    # fit on top of the ceiling; a real hang still fails.
    ceiling = hook_shell.hang_ceiling(argv, 45) + 2 * 25
    result = _run_to_completion(argv, '{"tool_name":"Bash"}', timeout=ceiling)
    assert result.returncode == 0
    assert result.stdout == ""


@pytest.mark.parametrize("build", [
    lambda port: osplat.scripts.hook_entry(claude_hooks._build_guard_command(port)),
    lambda port: osplat.scripts.hook_entry(claude_hooks._build_guard_command(port, endpoint="qwen")),
    lambda port: {"command": copilot_hooks._build_guard_command(port, "bash")},
], ids=["claude", "qwen", "copilot-bash"])
@pytest.mark.parametrize("token", ["pane-token-123", None])
@pytest.mark.parametrize("curl", [True, False], ids=["curl", "python3"])
def test_guard_hook_sends_the_pane_token_from_its_environment(tmp_path, monkeypatch, build, token, curl) -> None:
    from agent_team_backend import guard_hooks
    from agent_team_backend.osplat import _posix_paths

    if not curl:
        if osplat.platform_id == "win32":
            pytest.skip("the python3 spelling is the POSIX fallback")
        real = _posix_paths.resolve_program
        monkeypatch.setattr(_posix_paths, "resolve_program", lambda name: None if name == "curl" else real(name))
    if token is None:
        monkeypatch.delenv(guard_hooks.PANE_TOKEN_ENV, raising=False)
    else:
        monkeypatch.setenv(guard_hooks.PANE_TOKEN_ENV, token)
    seen: list[str | None] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            self.rfile.read(int(self.headers["Content-Length"]))
            seen.append(self.headers.get(guard_hooks.PANE_TOKEN_HEADER))
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args) -> None:
            pass

    port_file = tmp_path / "backend.port"
    argv = hook_shell.shell_argv(build(str(port_file)))
    ceiling = hook_shell.hang_ceiling(argv, 45)
    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = ceiling + 10
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    port_file.write_text(str(server.server_port), encoding="utf-8")
    try:
        result = _run_to_completion(argv, '{"tool_name":"Bash"}', timeout=ceiling)
    finally:
        thread.join(timeout=ceiling + 11)
        server.server_close()
    assert result.returncode == 0
    # Unset, the header is absent or empty: the backend reads both as "no token".
    assert (seen[0] or None) == token


def test_powershell_guard_hook_sends_the_pane_token_header() -> None:
    # Static: this text is executed for real only on a Windows runner.
    from agent_team_backend import guard_hooks

    command = copilot_hooks._build_guard_command("C:/port", "powershell")
    assert f"-H ('{guard_hooks.PANE_TOKEN_HEADER}: ' + $env:{guard_hooks.PANE_TOKEN_ENV})" in command
    assert command.rstrip().endswith("exit 0")


def test_the_hang_ceiling_grows_with_the_shell_cold_start(monkeypatch) -> None:
    # The fixed 45 s budget held on x64 and failed on the windows-11-arm
    # runner, where one PowerShell cold start alone averages about 24 s.
    monkeypatch.setitem(hook_shell._cold_start_s, "slow-shell", 24.0)
    monkeypatch.setitem(hook_shell._cold_start_s, "fast-shell", 0.5)
    assert hook_shell.hang_ceiling(["slow-shell", "-c", "x"], 45) > 45 + 2 * 24.0
    assert hook_shell.hang_ceiling(["fast-shell", "-c", "x"], 45) < 50


def test_a_shell_start_that_hangs_is_killed_and_retried(tmp_path, monkeypatch) -> None:
    # The first start hangs, as powershell.exe once did on the Windows runner;
    # the second exits at once. The hang costs one attempt, not the test.
    marker = tmp_path / "started-once"
    fake = tmp_path / "fake_shell.py"
    fake.write_text(
        "import pathlib, sys, time\n"
        f"marker = pathlib.Path({str(marker)!r})\n"
        "if not marker.exists():\n"
        "    marker.write_text('x')\n"
        "    time.sleep(600)\n",
        encoding="utf-8",
    )
    argv = [sys.executable, str(fake), "x"]
    monkeypatch.setattr(hook_shell, "_cold_start_s", {})
    hook_shell.warm(argv, attempt_s=3)
    assert marker.exists()
    assert hook_shell.cold_start_s(argv) < 3


# What the PowerShell hooks read the port file and made the temp path with
# until 0.2.35, kept here as the reference the .NET form must match.
def _legacy_prelude(port_file: str) -> str:
    return f"$PORT = Get-Content -ErrorAction SilentlyContinue {_windows._ps_quote(port_file)}; "


@pytest.mark.skipif(sys.platform != "win32", reason="runs the PowerShell hook text for real")
@pytest.mark.timeout(300)
def test_powershell_hook_prelude_reads_the_port_file_as_get_content_did(tmp_path) -> None:
    # Same answer for every port file shape a hook can meet, from the legacy
    # cmdlets and from the .NET calls that replaced them. Both forms run in
    # one PowerShell, so the cmdlet module autoload is paid once per test run
    # (39.3 s on the windows-11-arm runner, release dry run 41039191239).
    cases = {
        "absent": None,
        "empty": b"",
        "crlf": b"51234\r\n",
        "bare": b"51234",
        "blank-line": b"\r\n",
        "two-lines": b"51234\r\n9\r\n",
    }
    paths = []
    for name, content in cases.items():
        path = tmp_path / f"{name}.port"
        if content is not None:
            path.write_bytes(content)
        paths.append(str(path))
    report = "[Console]::Out.Write('[' + [bool]$PORT + '|' + \"$PORT\" + ']'); "
    temp = "[Console]::Out.Write('<' + $TMPNAME + '>'); "

    def form(prelude, temp_path: str) -> str:
        return "".join(prelude(p) + report for p in paths) + temp_path + temp

    script = (
        form(_legacy_prelude, "$TMPNAME = Join-Path $env:TEMP 'navide-x'; ")
        + "[Console]::Out.Write('#'); "
        + form(_windows._ps_read_port, "$TMPNAME = [IO.Path]::Combine($env:TEMP, 'navide-x'); ")
        + "exit 0"
    )
    argv = hook_shell.shell_argv({"shell": "powershell", "command": script})
    done = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True,
                          encoding="utf-8", errors="replace", timeout=120)
    assert done.returncode == 0, done.stderr
    legacy_out, dotnet_out = done.stdout.split("#")
    assert dotnet_out == legacy_out
    assert legacy_out.startswith("[False|][False|][True|51234][True|51234][False|][True|51234 9]")


def test_powershell_hooks_load_no_cmdlet_module() -> None:
    # Static: a cmdlet from Microsoft.PowerShell.Management back in any hook
    # text brings the per-run module autoload back with it.
    texts = [
        copilot_hooks._build_guard_command("C:/port", "powershell"),
        _windows.scripts.hook_rewake(port_file="p", header_file="h", url_path="/u", timeout_s=3),
        *(
            _windows.scripts.hook_post_json(port_file="p", header_file="h", url_path="/u",
                                            event="e", timeout_s=3, keep_body=keep)
            for keep in (True, False)
        ),
    ]
    for text in texts:
        for cmdlet in ("Get-Content", "Join-Path", "Remove-Item", "Test-Path", "Set-Content"):
            assert cmdlet not in text
