import json
import re
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import psutil
import pytest

from agent_team_backend import osplat
from agent_team_backend.claude_hooks import _build_curl_command, _build_rewake_command
from tests import hook_shell


def _run_to_completion(
    argv: list[str], payload: str, *, timeout: float
) -> subprocess.CompletedProcess[str]:
    """Run the hook, and on a timeout take its whole tree down with it.

    `subprocess.run` kills only the process it started, so a hook that hangs
    would leave the curl it spawned behind — and on Windows a survivor of the
    test session has been enough to stop the CI job from ever finishing.
    """
    process = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        # Not a bare `text=True`: that decodes with the console code page, so a
        # payload carrying a non-ASCII path raised UnicodeEncodeError on
        # Windows before the hook was ever reached.
        encoding="utf-8",
        errors="replace",
    )
    try:
        stdout, stderr = process.communicate(payload, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            root = psutil.Process(process.pid)
            for child in root.children(recursive=True):
                child.kill()
        except psutil.Error:
            pass
        process.kill()
        process.communicate()
        raise
    return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)


def _run_hook(tmp_path, event_kind: str, body: bytes, endpoint: str = "claude"):
    """Run one installed hook command against a one-shot HTTP server.

    Returns (payloads the server received, the command's stdout) — stdout being
    the interesting half, because that is the only channel a CLI reads a hook's
    decision from.
    """
    # Which shell this text is for is the installer's declaration, not a guess:
    # `shell=True` would hand it to cmd.exe on Windows, and bash would get
    # PowerShell there. Resolved before the server thread starts, so a box with
    # neither shell skips rather than leaving one hanging.
    port_file = tmp_path / "backend.port"
    argv = hook_shell.shell_argv(
        osplat.scripts.hook_entry(
            _build_curl_command(str(port_file), event_kind, endpoint=endpoint)
        )
    )
    received: list[bytes] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers["Content-Length"])
            received.append(self.rfile.read(length))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    # Room for powershell.exe to start on a busy Windows runner — sh returns
    # long before any of these. The cap was kept short while a hung hook could
    # leave its curl behind and stall the whole job; _run_to_completion takes
    # the tree down now, so a slow start no longer has to look like a failure.
    server.timeout = 45
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    port_file.write_text(str(server.server_port), encoding="utf-8")
    payload = '{"hook_event_name":"Stop","session_id":"session-1"}'

    try:
        result = _run_to_completion(argv, payload, timeout=45)
    finally:
        thread.join(timeout=46)
        server.server_close()

    assert received == [payload.encode()]
    # One trailing line ending is the shell's, not the hook's: PowerShell ends
    # a native command's output with a newline where sh passes curl's bytes
    # through untouched, and a CLI parsing the JSON object cannot tell. Every
    # other byte is compared exactly.
    return received, result.stdout.removesuffix("\n").removesuffix("\r")


def test_stop_hook_puts_the_response_on_stdout_where_the_cli_reads_decisions(tmp_path) -> None:
    """A queued inter-CLI message comes back as the Stop hook's own decision,
    and Claude Code only ever sees it if the hook prints it."""
    decision = b'{"decision":"block","reason":"[Navide MSG] from: builder"}'

    _received, stdout = _run_hook(tmp_path, "stop", decision)

    assert stdout == decision.decode()


def test_stop_hook_hands_a_non_ascii_decision_over_byte_for_byte(tmp_path) -> None:
    """The backend answers with raw UTF-8 (JSONResponse), and on Windows
    PowerShell re-coded it through the console code page on its way to stdout,
    so a message in Chinese reached the agent garbled -- #147 on the Stop path."""
    decision = '{"decision":"block","reason":"[Navide MSG] from: 指揮\\n請修正：日本語、한국어 🚀"}'.encode()

    _received, stdout = _run_hook(tmp_path, "stop", decision)

    assert stdout == decision.decode()


def test_other_events_still_discard_the_response(tmp_path) -> None:
    # Their replies are acks, and an unrecognized object on a hook's stdout is
    # reported to the user as a hook error.
    _received, stdout = _run_hook(tmp_path, "pre_tool_use", b'{"ok":true}')

    assert stdout == ""


def test_qwens_stop_hook_keeps_discarding_the_response(tmp_path) -> None:
    # qwen borrows this builder; the decision contract is claude's alone.
    _received, stdout = _run_hook(tmp_path, "stop", b'{"ok":true}', endpoint="qwen")

    assert stdout == ""


def _run_rewake(tmp_path, body: bytes) -> subprocess.CompletedProcess[str]:
    """Run the installed rewake waiter against a one-shot server answering `body`."""
    port_file = tmp_path / "backend.port"
    argv = hook_shell.shell_argv(osplat.scripts.hook_entry(_build_rewake_command(str(port_file))))

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = 45
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    port_file.write_text(str(server.server_port), encoding="utf-8")
    try:
        return _run_to_completion(argv, '{"hook_event_name":"Stop"}', timeout=45)
    finally:
        thread.join(timeout=46)
        server.server_close()


def test_rewake_delivers_a_multiline_non_ascii_body_intact(tmp_path) -> None:
    """#147: on Windows a multi-line body reached the agent as `System.Object[]`
    and CJK as `?`, while the sender saw `delivered`. The envelope Navide sends
    always has a header line, so multi-line is the normal case."""
    message = "[Navide MSG] from: 指揮\n請修正 #147：多行中文、日本語、한국어 🚀\n第三行"

    result = _run_rewake(tmp_path, message.encode("utf-8"))

    assert result.returncode == 2
    assert "System.Object[]" not in result.stderr
    assert result.stderr.replace("\r\n", "\n") == message + "\n"


def test_rewake_with_a_blank_body_wakes_nobody(tmp_path) -> None:
    result = _run_rewake(tmp_path, b"\n\n")

    assert result.returncode == 0
    assert result.stderr == ""


def test_without_curl_the_hook_still_delivers_and_prints_the_decision(tmp_path, monkeypatch) -> None:
    """Ubuntu Desktop ships without curl. Written on such a box, the hook is
    spelled with python3 and must behave exactly like the curl one: same body
    to the backend, same decision back on stdout, and the auth header still
    loaded from the header file rather than the command."""
    from agent_team_backend.osplat import _posix_paths

    if osplat.scripts is not _posix_paths.scripts:
        pytest.skip("the sh rendering is the POSIX box's; Windows writes PowerShell")
    if shutil.which("python3") is None:
        pytest.skip("python3 is what the fallback runs with")

    monkeypatch.setattr(
        _posix_paths, "resolve_program", lambda name, *, path=None: None if name == "curl" else name
    )
    port_file = tmp_path / "backend.port"
    command = _build_curl_command(str(port_file), "stop")
    assert "curl -fsS" not in command
    assert "python3 -c" in command

    decision = b'{"decision":"block","reason":"[Navide MSG] from: builder"}'
    seen_headers: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            seen_headers.update({k: v for k, v in self.headers.items()})
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.send_header("Content-Length", str(len(decision)))
            self.end_headers()
            self.wfile.write(decision)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = 45
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    port_file.write_text(str(server.server_port), encoding="utf-8")
    try:
        result = _run_to_completion(
            hook_shell.shell_argv(osplat.scripts.hook_entry(command)),
            '{"hook_event_name":"Stop"}',
            timeout=45,
        )
    finally:
        thread.join(timeout=46)
        server.server_close()

    assert result.returncode == 0, result.stderr
    assert result.stdout.removesuffix("\n") == decision.decode()
    assert seen_headers.get("X-Agent-Team-Event") == "stop"
    assert seen_headers.get("Content-Type") == "application/json"
    # The secret travels in the header file, never in the settings.json text.
    from agent_team_backend import hook_auth

    assert hook_auth.token() not in command
    assert seen_headers.get(hook_auth.HEADER) == hook_auth.token()


def test_dev_instance_does_not_overwrite_production_hook(tmp_path) -> None:
    from agent_team_backend.claude_hooks import install_hooks

    settings_file = tmp_path / "settings.json"
    prod_port_file = tmp_path / "production" / "backend.port"
    prod_port_file.parent.mkdir(parents=True, exist_ok=True)
    prod_port_file.write_text("50000", encoding="utf-8")

    # Install production hook
    install_hooks(str(prod_port_file), settings_file=settings_file)
    initial_content = settings_file.read_text(encoding="utf-8")
    # Through the JSON, not the raw text: a Windows path's backslashes are
    # escaped in the file.
    commands = [
        h["command"]
        for entries in json.loads(initial_content)["hooks"].values()
        for entry in entries
        for h in entry.get("hooks", [])
    ]
    assert any(str(prod_port_file) in c for c in commands)

    # Attempt to install dev hook (port_file containing -dev)
    dev_port_file = tmp_path / "Agent-Team-dev" / "backend-port"
    dev_port_file.parent.mkdir(parents=True, exist_ok=True)
    dev_port_file.write_text("60000", encoding="utf-8")

    res = install_hooks(str(dev_port_file), settings_file=settings_file)
    assert res.get("status") == "skipped"
    # Settings file remains pointing to production port file
    assert settings_file.read_text(encoding="utf-8") == initial_content



def test_subagent_stop_hook_is_installed(tmp_path) -> None:
    """The event that closes the loop's blind spot must actually get written.

    PreToolUse alone can only count subagents going in. Without SubagentStop
    nothing ever counts one coming back out, so the pending count would climb
    and never fall — worse than not counting at all.
    """
    from agent_team_backend.claude_hooks import install_hooks

    settings_file = tmp_path / "settings.json"
    port_file = tmp_path / "port"
    port_file.write_text("1234")
    install_hooks(str(port_file), settings_file=settings_file)

    import json

    hooks = json.loads(settings_file.read_text())["hooks"]
    assert "SubagentStop" in hooks, "SubagentStop hook was not installed"
    commands = [
        h["command"]
        for entry in hooks["SubagentStop"]
        for h in entry.get("hooks", [])
    ]
    assert any("kind=subagent_stop" in c for c in commands)
    # It is a plain signal hook: its response is discarded, unlike Stop's.
    # How a shell spells "discard" (`-o /dev/null`, `-o NUL`) is the renderer's
    # business, so the expected text comes from the same seam the installer
    # wrote the command through rather than from a literal here.
    shape = dict(
        port_file=str(port_file),
        header_file=str(tmp_path / "hook-auth"),
        url_path="/hooks/claude",
        event="subagent_stop",
        timeout_s=2,
    )
    sink = re.search(r"-o \S+", osplat.scripts.hook_post_json(**shape, keep_body=False))
    assert sink, "the renderer no longer discards a signal hook's response"
    # It really is the discard, not boilerplate the kept-body form shares.
    assert sink.group(0) not in osplat.scripts.hook_post_json(**shape, keep_body=True)
    assert all(sink.group(0) in c for c in commands)


def test_subagent_stop_hook_reaches_the_endpoint(tmp_path) -> None:
    payloads, stdout = _run_hook(tmp_path, "subagent_stop", b'{"ok":true}')
    assert payloads, "the hook sent nothing"
    assert stdout == "", "a signal hook's response must not reach the CLI"


def test_permission_request_hook_never_answers_the_dialog(tmp_path) -> None:
    """PermissionRequest is report-only: whatever the backend replies, nothing
    reaches the CLI, so Claude Code shows its own dialog exactly as before.
    A body on stdout here would be read as an allow/deny decision."""
    payloads, stdout = _run_hook(
        tmp_path, "permission_request",
        b'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    )
    assert payloads, "the hook sent nothing"
    assert stdout == "", "the permission hook must never hand Claude a decision"


def test_a_windows_install_writes_powershell_and_says_so(tmp_path, monkeypatch) -> None:
    """On Windows a hook's `command` runs under Git Bash, or PowerShell when
    Git Bash is not installed — and the entry declares which it was written
    for. Nothing here can assume sh, so the renderer is the seam and this
    exercises its Windows arm on whatever machine runs the suite.
    """
    from agent_team_backend import claude_hooks, osplat
    from agent_team_backend.osplat import _windows

    monkeypatch.setattr(osplat, "scripts", _windows.scripts)
    monkeypatch.setattr(claude_hooks, "_rewake_wanted", lambda: True)

    settings_file = tmp_path / "settings.json"
    port_file = tmp_path / "port"
    port_file.write_text("1234", encoding="utf-8")
    claude_hooks.install_hooks(str(port_file), settings_file=settings_file)

    entries = [
        h
        for event in json.loads(settings_file.read_text(encoding="utf-8"))["hooks"].values()
        for entry in event
        for h in entry.get("hooks", [])
    ]
    assert entries
    for hook in entries:
        assert hook["shell"] == "powershell"
        # The marker comment, then one PowerShell line — `#` comments in both
        # shells, so the marker still reads the same to the installer.
        marker, command = hook["command"].split("\n", 1)
        assert marker.startswith("# agent-team-hook")
        assert "\n" not in command
        assert command.startswith("$PORT = $null; try { $PORT = [IO.File]::ReadAllLines(")
        assert "curl.exe" in command
        assert command.endswith("exit 0") or command.endswith("exit 2 }; exit 0")

    rewake = [h for h in entries if h.get("asyncRewake")]
    assert rewake, "the rewake waiter was not installed"
    assert "[Console]::OpenStandardError()" in rewake[0]["command"]


@pytest.mark.parametrize("content", ['{"model": "opus", // a comment\n}', "[1, 2]"])
def test_an_unreadable_settings_file_is_left_untouched(tmp_path, content) -> None:
    """A settings.json that does not parse to an object is the user's, not ours.

    Reading it as an empty dict and writing back would replace every setting
    the user has with nothing but our hooks.
    """
    from agent_team_backend.claude_hooks import install_hooks

    settings_file = tmp_path / "settings.json"
    settings_file.write_text(content, encoding="utf-8")
    port_file = tmp_path / "port"
    port_file.write_text("1234")

    result = install_hooks(str(port_file), settings_file=settings_file)

    assert result["installed"] is False
    assert result["reason"] == "settings.json unparseable"
    assert settings_file.read_text(encoding="utf-8") == content
    assert not (tmp_path / "settings.json.pre-agent-team.bak").exists()


@pytest.mark.skipif(osplat.platform_id == "win32", reason="POSIX symlinks and modes")
def test_install_and_removal_keep_a_symlinked_settings_file_and_its_mode(tmp_path) -> None:
    """A dotfiles-managed settings.json is a symlink, and may hold an API key
    behind 0600. Writing it must change the file it points at, not replace
    the link with a plain file, and must not widen its mode."""
    import os
    import stat

    from agent_team_backend.claude_hooks import hooks_present, install_hooks, uninstall_hooks

    real = tmp_path / "dotfiles" / "claude-settings.json"
    real.parent.mkdir()
    real.write_text(json.dumps({"env": {"ANTHROPIC_API_KEY": "sk-secret"}}), encoding="utf-8")
    real.chmod(0o600)
    link = tmp_path / "claude" / "settings.json"
    link.parent.mkdir()
    link.symlink_to(real)
    port_file = tmp_path / "port"
    port_file.write_text("1234")

    assert install_hooks(str(port_file), settings_file=link)["installed"] is True
    assert link.is_symlink() and hooks_present(real)
    assert stat.S_IMODE(os.stat(real).st_mode) == 0o600

    assert uninstall_hooks(settings_file=link)["removed"] is True
    assert link.is_symlink() and not hooks_present(real)
    assert stat.S_IMODE(os.stat(real).st_mode) == 0o600
    assert json.loads(real.read_text(encoding="utf-8"))["env"] == {"ANTHROPIC_API_KEY": "sk-secret"}
