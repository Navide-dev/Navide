"""SSH Remote panes: the target shape, and what never leaves this machine.

The private key is named by path and never opened; agent forwarding is never
on. ``remote_ssh.connect`` checks the target with one BatchMode ssh call and
names a failure; ``terminal.create`` opens a shell only on a trusted target.
"""

from __future__ import annotations

import asyncio
import builtins
import io
import os
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import remote_devcontainer as rd
from agent_team_backend import remote_devcontainer_ws, remote_ssh


def _target(**extra: Any) -> dict[str, Any]:
    return remote_ssh.parse_target({"host": "build-box", "user": "dev", "port": 2222, **extra})


def test_port_defaults_to_22_and_user_is_optional():
    target = remote_ssh.parse_target({"host": "build-box"})
    assert target == {"host": "build-box", "user": "", "port": 22, "keyPath": ""}
    assert remote_ssh.destination(target) == "build-box"
    assert remote_ssh.destination(_target()) == "dev@build-box"


@pytest.mark.parametrize("payload", [
    {"host": "-oProxyCommand=x"},
    {"host": "a@b"},
    {"host": "box", "user": "-l"},
    {"host": "box", "port": 0},
    {"host": "box", "port": 70000},
    {"host": "box", "port": "x"},
    {"host": "box", "keyPath": "-i"},
    {"host": "box", "keyPath": "relative/key"},
    {"host": "box", "keyPath": "/k\nProxyCommand x"},
    "box",
])
def test_unusable_targets_are_refused(payload):
    with pytest.raises(remote_ssh.SshTargetError):
        remote_ssh.parse_target(payload)


def test_the_argv_never_forwards_the_agent(tmp_path):
    argv = remote_ssh.shell_argv(_target(keyPath=str(tmp_path / "id_test")), Path("/tmp/cm"))
    # No -A, alone or bundled with other short flags (-tA).
    assert not any(p.startswith("-") and not p.startswith("--") and len(p) <= 4 and "A" in p for p in argv)
    assert "ForwardAgent=no" in argv
    assert not any(part.lower() == "forwardagent=yes" for part in argv)
    # The destination comes after "--", so nothing in it can be an option.
    assert argv[argv.index("--") + 1] == "dev@build-box"
    assert argv[argv.index("-p") + 1] == "2222"


def test_the_key_goes_in_as_a_path_and_is_never_opened(tmp_path, monkeypatch):
    # Fake key material assembled at runtime; it must not appear anywhere.
    secret = "-----BEGIN " + "OPENSSH PRIVATE KEY-----\n" + "ZmFrZQ" * 8
    key = tmp_path / "id_fake"
    key.write_text(secret)

    opened: list[str] = []
    real_open, real_io_open = builtins.open, io.open

    def spy(file, *args, **kwargs):
        opened.append(os.fspath(file) if isinstance(file, (str, os.PathLike)) else repr(file))
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", spy)
    monkeypatch.setattr(io, "open", spy)
    monkeypatch.setattr(Path, "read_text", lambda *a, **k: pytest.fail("key read"))
    monkeypatch.setattr(Path, "read_bytes", lambda *a, **k: pytest.fail("key read"))

    target = remote_ssh.parse_target({"host": "build-box", "keyPath": str(key)})
    argv = remote_ssh.shell_argv(target)
    monkeypatch.setattr(builtins, "open", real_open)
    monkeypatch.setattr(io, "open", real_io_open)

    assert str(key) not in opened
    assert argv[argv.index("-i") + 1] == str(key)
    assert "IdentitiesOnly=yes" in argv
    assert secret not in " ".join(argv) and "ZmFrZQ" not in " ".join(argv)
    assert target["keyPath"] == str(key)


def test_a_missing_key_file_is_not_checked_here(tmp_path):
    # ssh reports a missing key itself; this module never stats the file.
    target = remote_ssh.parse_target({"host": "box", "keyPath": str(tmp_path / "nowhere" / ("id_" + "missing"))})
    assert target["keyPath"].endswith("id_missing")


def test_local_credentials_are_kept_out_of_the_spawn_environment():
    fake_key = "sk-" + "test-" + "0" * 8
    env = {"PATH": "/bin", "SSH_AUTH_SOCK": "/tmp/agent.sock", "ANTHROPIC_API_KEY": fake_key, "OPENAI_API_KEY": fake_key}
    removed = set(rd.spawn_env_remove(env))
    assert {"ANTHROPIC_API_KEY", "OPENAI_API_KEY"} <= removed
    # The agent socket stays for local authentication only; ForwardAgent=no
    # keeps it from being offered to the host.
    assert "SSH_AUTH_SOCK" not in removed


class _Sock:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _connect(
    monkeypatch: pytest.MonkeyPatch, settings: dict[str, Any], target: Any, **extra: Any
) -> dict[str, Any]:
    async def read() -> dict[str, Any]:
        return settings

    monkeypatch.setattr(remote_devcontainer_ws, "_settings", read)
    sock = _Sock()
    asyncio.run(asyncio.wait_for(
        remote_devcontainer_ws.remote_ssh_connect(
            sock, "m1", "remote_ssh.connect", {"target": target, **extra}), 5))
    return sock.sent[-1]


def test_connect_is_refused_while_the_switch_is_off(monkeypatch):
    reply = _connect(monkeypatch, {}, {"host": "build-box"})
    assert reply["error"]["code"] == "REMOTE_DISABLED"


def test_connect_rejects_a_bad_target(monkeypatch):
    reply = _connect(monkeypatch, {rd.SETTING_KEY: True}, {"host": "-oProxyCommand=x"})
    assert reply["error"]["code"] == "BAD_REQUEST"


class _Store:
    def __init__(self, settings: dict[str, Any]) -> None:
        self.settings = settings

    def set(self, patch: dict[str, Any]) -> None:
        self.settings.update(patch)


def _fake_ssh(monkeypatch: pytest.MonkeyPatch, settings: dict[str, Any], result: tuple[int, str, str]) -> list[list[str]]:
    from agent_team_backend import app

    calls: list[list[str]] = []

    async def run(argv: list[str]) -> tuple[int, str, str]:
        calls.append(argv)
        return result

    async def in_thread(fn, *args):
        return fn(*args)

    monkeypatch.setattr(remote_devcontainer_ws, "_run_ssh", run)
    monkeypatch.setattr(app, "ui_settings_store", _Store(settings), raising=False)
    monkeypatch.setattr("agent_team_backend.db_executor.run_in_db_thread", in_thread)
    return calls


def test_connect_checks_the_host_and_trusts_it(monkeypatch):
    settings: dict[str, Any] = {rd.SETTING_KEY: True}
    calls = _fake_ssh(monkeypatch, settings, (0, "NAVIDE:OK\n", ""))
    reply = _connect(monkeypatch, settings, {"host": "build-box", "user": "dev", "port": 2222})
    assert reply["ok"] is True
    assert reply["payload"]["spec"] == {"kind": "ssh", "host": "build-box", "user": "dev", "port": 2222, "keyPath": ""}
    argv = calls[0]
    assert "BatchMode=yes" in argv and "ForwardAgent=no" in argv and "ControlPath=none" in argv
    assert argv[argv.index("--") + 1] == "dev@build-box"
    assert remote_ssh.is_trusted(settings, remote_ssh.parse_target({"host": "build-box", "user": "dev", "port": 2222}))


@pytest.mark.parametrize(("code", "stderr", "reason"), [
    (255, "ssh: Could not resolve hostname nope: nodename nor servname provided", "unreachable"),
    (255, "ssh: connect to host box port 22: Connection refused", "unreachable"),
    (255, "ssh: connect to host box port 22: Operation timed out", "unreachable"),
    (124, "timed out", "unreachable"),
    (255, "dev@box: Permission denied (publickey).", "auth"),
    (255, "Load key \"/k/id\": bad permissions", "auth"),
    (255, "Host key verification failed.", "host-key"),
    (255, "@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @", "host-key"),
    (1, "something odd", "other"),
])
def test_a_failed_check_is_named_in_plain_terms(monkeypatch, code, stderr, reason):
    settings: dict[str, Any] = {rd.SETTING_KEY: True}
    _fake_ssh(monkeypatch, settings, (code, "", stderr))
    reply = _connect(monkeypatch, settings, {"host": "box"})
    assert reply["error"]["code"] == "REMOTE_SSH_FAILED"
    assert reply["error"]["details"]["reason"] == reason
    assert remote_ssh.TRUSTED_KEY not in settings


@pytest.mark.parametrize(("stderr", "opens"), [
    ("Permission denied (publickey).", True),
    ("Host key verification failed.", True),
    ("Connection refused", False),
])
def test_force_opens_only_past_a_key_or_host_key_refusal(monkeypatch, stderr, opens):
    # The pane's own interactive ssh can then ask for a passphrase or the fingerprint.
    settings: dict[str, Any] = {rd.SETTING_KEY: True}
    _fake_ssh(monkeypatch, settings, (255, "", stderr))
    reply = _connect(monkeypatch, settings, {"host": "box"}, force=True)
    assert reply["ok"] is opens
    assert (remote_ssh.TRUSTED_KEY in settings) is opens


def test_the_trusted_list_keeps_the_four_fields_newest_first_and_capped():
    rows: list[dict[str, Any]] = []
    for i in range(remote_ssh.TRUSTED_MAX + 5):
        rows = remote_ssh.with_trusted({remote_ssh.TRUSTED_KEY: rows}, _target(host=f"h{i}"))
    assert len(rows) == remote_ssh.TRUSTED_MAX
    assert rows[0] == {"host": f"h{remote_ssh.TRUSTED_MAX + 4}", "user": "dev", "port": 2222, "keyPath": ""}
    # A row with extra or malformed fields is not trusted as written.
    junk = {remote_ssh.TRUSTED_KEY: [{"host": "-oProxyCommand=x"}, "box"]}
    assert remote_ssh.with_trusted(junk, _target()) == [{"host": "build-box", "user": "dev", "port": 2222, "keyPath": ""}]


class _Terms:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []

    def get(self, _tid: str) -> None:
        return None

    def create(self, **kwargs: Any) -> Any:
        self.created.append(kwargs)

        class _Proc:
            pid = 4242

        class _Term:
            id = "t1"
            pane_id = kwargs["pane_id"]
            proc = _Proc()
            metadata = kwargs["metadata"]
            output_taps: list[Any] = []

        self.term = _Term()
        return self.term

    def write(self, _tid: str, text: str) -> None:
        self.written.append(text)

    written: list[str] = []


class _PaneSession(_Sock):
    def __init__(self) -> None:
        super().__init__()
        self.terminals = _Terms()
        self.dead = False


def _create(monkeypatch: pytest.MonkeyPatch, settings: dict[str, Any], payload: dict[str, Any]) -> _PaneSession:
    from agent_team_backend import app

    async def read() -> dict[str, Any]:
        return settings

    monkeypatch.setattr(remote_devcontainer_ws, "_settings", read)
    monkeypatch.setattr(app, "_PTY_OWNERS", {}, raising=False)
    sess = _PaneSession()
    tx = {"cancelled": False, "committed": False, "term_id": ""}
    asyncio.run(remote_devcontainer_ws.create_remote_pane(
        sess, "m2", "terminal.create", {"pane_id": "p1", "cols": 80, "rows": 24, **payload}, tx, "g1"))
    return sess


_SPEC = {"kind": "ssh", "host": "build-box", "user": "dev", "port": 2222, "keyPath": ""}


def test_a_trusted_target_opens_a_login_shell_pane(monkeypatch):
    settings = {rd.SETTING_KEY: True, remote_ssh.TRUSTED_KEY: [{k: v for k, v in _SPEC.items() if k != "kind"}]}
    sess = _create(monkeypatch, settings, {
        "agent_key": "terminal", "remote": dict(_SPEC),
        "metadata": {"credential_env": "x", "workspace_path": "/w"},
    })
    assert sess.sent[-1]["ok"] is True
    created = sess.terminals.created[0]
    assert created["agent_key"] == "terminal"
    assert created["command"] == remote_ssh.shell_argv(_SPEC)
    assert created["command"][:2] == ["ssh", "-tt"]
    # Server-only keys never come from the client; the spec marks the pane.
    assert "credential_env" not in created["metadata"]
    assert created["metadata"][remote_ssh.METADATA_KEY] == {
        **_SPEC, "dir": "~", "cli": "terminal", "sessionId": "", "tmuxSession": ""}
    assert rd.METADATA_KEY not in created["metadata"]
    assert "ANTHROPIC_API_KEY" in rd.spawn_env_remove({"ANTHROPIC_API_KEY": "x"})


def test_an_untrusted_target_from_a_pane_record_runs_no_ssh(monkeypatch):
    sess = _create(monkeypatch, {rd.SETTING_KEY: True}, {"agent_key": "terminal", "remote": dict(_SPEC)})
    assert sess.sent[-1]["error"]["code"] == "REMOTE_UNTRUSTED"
    assert sess.terminals.created == []


@pytest.mark.parametrize("payload", [
    {"agent_key": "claude", "remote": dict(_SPEC)},
    {"agent_key": "terminal", "remote": {**_SPEC, "host": "-oProxyCommand=x"}},
])
def test_an_ssh_pane_is_a_terminal_with_a_valid_target(monkeypatch, payload):
    settings = {rd.SETTING_KEY: True, remote_ssh.TRUSTED_KEY: [{k: v for k, v in _SPEC.items() if k != "kind"}]}
    sess = _create(monkeypatch, settings, payload)
    assert sess.sent[-1]["error"]["code"] == "BAD_REQUEST"
    assert sess.terminals.created == []


def test_no_ssh_pane_while_the_switch_is_off(monkeypatch):
    sess = _create(monkeypatch, {}, {"agent_key": "terminal", "remote": dict(_SPEC)})
    assert sess.sent[-1]["error"]["code"] == "REMOTE_DISABLED"


def test_the_default_port_leaves_an_ssh_config_alias_its_own_port():
    # `-p 22` on the command line would override `Port 2222` in the user's
    # ssh config for that alias; only a port the user changed is passed.
    assert "-p" not in remote_ssh.shell_argv(remote_ssh.parse_target({"host": "my-alias"}))
    assert "-p" not in remote_ssh.preflight_argv(remote_ssh.parse_target({"host": "my-alias", "port": 22}))
    argv = remote_ssh.shell_argv(remote_ssh.parse_target({"host": "my-alias", "port": 2200}))
    assert argv[argv.index("-p") + 1] == "2200"


# ── CLI panes, remote folder, session resume (0.2.48) ──────────────────────

_TRUSTED = {rd.SETTING_KEY: True, remote_ssh.TRUSTED_KEY: [{k: v for k, v in _SPEC.items() if k != "kind"}]}


def test_a_spec_carries_folder_cli_and_session_and_resume_is_never_recorded():
    spec = remote_ssh.parse_spec({**_SPEC, "dir": "~/proj", "cli": "codex", "sessionId": "abc-1", "resume": True})
    assert spec["dir"] == "~/proj" and spec["cli"] == "codex" and spec["resume"] is True
    assert "resume" not in remote_ssh.record_spec(spec)
    assert remote_ssh.parse_spec(dict(_SPEC))["dir"] == "~"


@pytest.mark.parametrize("extra", [
    {"dir": "-oProxyCommand=x"},
    {"dir": "/a\nb"},
    {"cli": "rm"},
    {"sessionId": "../x"},
    {"sessionId": "a b"},
])
def test_unusable_folder_cli_or_session_is_refused(extra):
    with pytest.raises(remote_ssh.SshTargetError):
        remote_ssh.parse_spec({**_SPEC, **extra})


def test_a_terminal_pane_starts_in_the_remote_folder():
    assert remote_ssh.shell_argv(remote_ssh.parse_spec(dict(_SPEC)))[-1] == "dev@build-box"
    argv = remote_ssh.shell_argv(remote_ssh.parse_spec({**_SPEC, "dir": "~/my proj"}))
    assert argv[-1] == "cd ~/'my proj' && exec $SHELL -l"


_NONCE = "0123456789abcdef" * 2


def _cli_spec(**extra: Any) -> dict[str, Any]:
    return remote_ssh.parse_spec({**_SPEC, "dir": "/srv/app", "cli": "claude", **extra})


def test_a_claude_pane_gets_the_tunnel_and_never_the_token_on_the_command_line():
    token = "tok" + "-" + "secret"
    argv = remote_ssh.cli_pane_argv(_cli_spec(sessionId="0f0e"), pane_id="p1", local_port=1234, remote_port=45000, nonce=_NONCE)
    assert argv[argv.index("-R") + 1] == "127.0.0.1:45000:127.0.0.1:1234"
    assert "ExitOnForwardFailure=yes" in argv and "ControlPath=none" in argv and "ForwardAgent=no" in argv
    assert argv[argv.index("--") + 1] == "dev@build-box"
    assert token not in " ".join(argv)
    script = remote_ssh.cli_script(_cli_spec(sessionId="0f0e"), pane_id="p1", remote_port=45000, nonce=_NONCE)
    assert "read -r NAVIDE_MCP_TOKEN" in script and "stty -echo" in script
    assert "cd /srv/app ||" in script
    assert "--resume 0f0e" in script and "--session-id 0f0e" in script
    assert "--continue" not in script and "resume --last" not in script


def test_a_cli_without_navide_tools_gets_no_tunnel_and_no_token():
    spec = _cli_spec(cli="opencode")
    argv = remote_ssh.cli_pane_argv(spec, pane_id="p1", local_port=1234, remote_port=45000, nonce=_NONCE)
    assert "-R" not in argv
    script = remote_ssh.cli_script(spec, pane_id="p1", remote_port=None, nonce=_NONCE)
    assert "NAVIDE_MCP_TOKEN" not in script and script.endswith("exec opencode")


def test_codex_resumes_its_own_id_and_otherwise_reports_the_one_it_chose():
    resumed = remote_ssh.cli_script(_cli_spec(cli="codex", sessionId="abc-1", resume=True), pane_id="p1", remote_port=45000, nonce=_NONCE)
    assert "resume abc-1" in resumed and "navide-resume-miss" in resumed
    fresh = remote_ssh.cli_script(_cli_spec(cli="codex"), pane_id="p1", remote_port=45000, nonce=_NONCE)
    assert " resume " not in fresh and "navide-resume-miss" not in fresh
    assert "navide-session;" in fresh and "rollout-" in fresh


@pytest.mark.parametrize("cli", ["claude", "codex", "opencode"])
@pytest.mark.parametrize("resume", [True, False])
def test_every_script_is_valid_sh(cli, resume):
    import shutil
    import subprocess

    if not shutil.which("sh"):
        pytest.skip("no sh")
    spec = _cli_spec(cli=cli, sessionId="abc-1", resume=resume, dir="~/a b")
    script = remote_ssh.cli_script(spec, pane_id="p1", remote_port=45000 if cli != "opencode" else None, nonce=_NONCE)
    # On stdin: `sh -n` only parses, but the guard against starting a real
    # CLI reads the argv and would see a CLI name in it.
    assert subprocess.run(["sh", "-n"], input=script.encode()).returncode == 0


def test_the_watcher_reads_a_split_session_report_and_a_resume_miss():
    found: list[str] = []
    missed: list[bool] = []
    watcher = remote_ssh.SessionWatcher(_NONCE, found.append, lambda: missed.append(True))
    miss = remote_ssh.RESUME_MISSED + _NONCE.encode() + b"\x07"
    report = remote_ssh.SESSION_REPORT + _NONCE.encode() + b";"
    watcher.feed(b"hello " + miss[:6])
    watcher.feed(miss[6:] + b" more " + report[:5])
    watcher.feed(report[5:] + b"5973b6c0-94b8-487b-a530-2aeb6098ae0e")
    watcher.feed(b"\x07 tail")
    assert missed == [True]
    assert found == ["5973b6c0-94b8-487b-a530-2aeb6098ae0e"]
    watcher.feed(report + b"other\x07")
    assert found == ["5973b6c0-94b8-487b-a530-2aeb6098ae0e"]


def test_output_without_the_launch_nonce_cannot_pass_for_a_report():
    found: list[str] = []
    missed: list[bool] = []
    watcher = remote_ssh.SessionWatcher(_NONCE, found.append, lambda: missed.append(True))
    other = ("f" * 32).encode()
    watcher.feed(remote_ssh.SESSION_REPORT + other + b";attacker-id\x07")
    watcher.feed(remote_ssh.SESSION_REPORT + b"attacker-id\x07")
    watcher.feed(remote_ssh.RESUME_MISSED + other + b"\x07")
    assert found == [] and missed == []


def test_a_claude_pane_never_takes_a_session_id_from_the_host():
    found: list[str] = []
    watcher = remote_ssh.SessionWatcher(_NONCE, None, lambda: None)
    watcher.feed(remote_ssh.SESSION_REPORT + _NONCE.encode() + b";other\x07")
    assert watcher.session_id == "" and found == []


def test_a_cli_pane_is_a_remote_agent_pane_with_the_token_feeder(monkeypatch):
    from agent_team_backend.mcp_server import wiring

    monkeypatch.setattr(wiring, "backend_port", lambda: 1234)
    sess = _create(monkeypatch, _TRUSTED, {"agent_key": "remote", "remote": {**_SPEC, "cli": "claude", "sessionId": "0f0e"}})
    assert sess.sent[-1]["ok"] is True
    created = sess.terminals.created[0]
    assert created["agent_key"] == "remote"
    assert created["command"][-1].startswith("exec $SHELL -ilc ")
    assert len(sess.terminals.term.output_taps) == 2
    assert remote_devcontainer_ws.is_remote_term(sess.terminals.term)
    assert sess.sent[-1]["payload"]["remote"]["sessionId"] == "0f0e"


@pytest.mark.parametrize("payload", [
    {"agent_key": "terminal", "remote": {**_SPEC, "cli": "claude"}},
    {"agent_key": "remote", "remote": dict(_SPEC)},
])
def test_the_agent_key_must_match_what_the_pane_runs(monkeypatch, payload):
    sess = _create(monkeypatch, _TRUSTED, payload)
    assert sess.sent[-1]["error"]["code"] == "BAD_REQUEST"


def test_the_cli_commands_match_the_agent_specs():
    import re

    agents = Path(__file__).resolve().parents[2] / "src/renderer/src/platform/plugin-shell/agents"
    for key, argv in remote_ssh.CLI_COMMANDS.items():
        text = (agents / f"{key}.ts").read_text(encoding="utf-8")
        match = re.search(r"defaultCommand:\s*'([^']*)'", text)
        assert match and match.group(1) == " ".join(argv), key


def test_an_ssh_pane_record_keeps_its_spec_and_session_across_restore(tmp_path):
    from agent_team_backend.projects import ProjectStore

    ws = str(tmp_path)
    store = ProjectStore()
    spec = remote_ssh.record_spec(_cli_spec(cli="codex"))
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="remote", remote=spec)
    store.record_manual_pane_spawn(ws, pane_id="local", agent="claude")
    assert store.set_pane_remote_session(ws, pane_id="p1", session_id="abc-1") is True
    assert store.set_pane_remote_session(ws, pane_id="local", session_id="abc-1") is False
    store.record_manual_pane_spawn(ws, pane_id="p2", previous_pane_id="p1", agent="remote")
    reloaded = {p.pane_id: p for p in ProjectStore().load_or_create(ws).panes}
    assert reloaded["p2"].remote == {**spec, "sessionId": "abc-1"}
    assert reloaded["local"].remote == {}


def test_manual_pane_spawn_records_an_ssh_spec_without_resume(monkeypatch):
    from types import SimpleNamespace

    from agent_team_backend import app, ws_handlers

    recorded: list[Any] = []

    def record(*_a: Any, **kw: Any) -> Any:
        recorded.append(kw)
        return SimpleNamespace(panes=[], to_dict=lambda: {})

    monkeypatch.setattr(app, "project_store", SimpleNamespace(
        record_manual_pane_spawn=record, load_or_create=lambda _w: SimpleNamespace(panes=[])), raising=False)

    async def run(remote: dict[str, Any]) -> list[dict[str, Any]]:
        sess = _Sock()
        try:
            await ws_handlers.manual_pane_spawn(sess, "m1", "manual_pane.spawn", {
                "workspace_path": "/w", "pane_id": "p", "agent": "remote", "remote": remote})
        except Exception:  # noqa: BLE001 — only what reached the store matters here
            pass
        return sess.sent

    asyncio.run(run({**_SPEC, "cli": "claude", "sessionId": "0f0e", "resume": True}))
    assert recorded and recorded[0]["remote"] == {
        **_SPEC, "dir": "~", "cli": "claude", "sessionId": "0f0e", "tmuxSession": ""}
    recorded.clear()
    sent = asyncio.run(run({**_SPEC, "dir": "-x"}))
    assert sent[-1]["error"]["code"] == "BAD_REQUEST" and recorded == []


# ── tmux sessions on the host (0.2.49) ─────────────────────────────────────
#
# The scripts run for real against a fake host: a stand-in `ssh` that runs
# the remote command locally, a stand-in `tmux` that keeps its sessions as
# files, and stand-in CLIs that write down how they were started. Nothing
# real is reached; every value that looks like a secret is built here.

_TMUX = "navide-" + "0123456789abcdef"


def _write_exe(path: Path, body: str) -> None:
    path.write_text("#!/bin/sh\n" + body, encoding="utf-8")
    path.chmod(0o755)


@pytest.fixture
def fake_host(tmp_path):
    import shutil

    if os.name == "nt" or not shutil.which("sh") or not shutil.which("mkfifo"):
        pytest.skip("needs a POSIX sh and mkfifo")
    bin_dir, state, home = tmp_path / "bin", tmp_path / "state", tmp_path / "home"
    for folder in (bin_dir, state, home, home / "proj"):
        folder.mkdir()
    # ssh: skip the options, then run the remote command as the host would.
    _write_exe(bin_dir / "ssh", (
        'printf "%s\\n" "$*" >> "$FAKE_STATE/ssh.log"\n'
        'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n'
        'shift 2; cd "$HOME" && exec /bin/sh -c "$1"\n'
    ))
    # The remote login shell: `-lc`/`-ilc CMD` runs CMD, `-l` is a shell.
    _write_exe(bin_dir / "loginsh", (
        'case "$1" in -*c) exec /bin/sh -c "$2";; esac\n'
        '{ echo "LOGIN-SHELL $(pwd)"; env; } > "$FAKE_STATE/shell.out"\n'
    ))
    _write_exe(bin_dir / "tmux", (
        'printf "%s\\n" "$*" >> "$FAKE_STATE/tmux.log"\n'
        'while :; do case "$1" in -L|-f) shift 2;; *) break;; esac; done\n'
        'case "$1" in\n'
        '  has-session) [ -e "$FAKE_STATE/s-${3#=}" ];;\n'
        # Like tmux: the server keeps the environment of the client that
        # started it, and every session it opens runs in that environment.
        '  start-server)\n'
        '    env > "$FAKE_STATE/start.env"\n'
        '    [ -e "$FAKE_STATE/server.env" ] || export -p > "$FAKE_STATE/server.env"\n'
        '    while [ "$#" -gt 0 ] && [ "$1" != new-session ]; do shift; done\n'
        '    [ "$1" = new-session ] || exit 0; shift\n'
        '    while :; do case "$1" in -d) shift;; -s) n=$2; shift 2;; -c) c=$2; shift 2;; *) break;; esac; done\n'
        '    : > "$FAKE_STATE/s-$n"\n'
        '    ( env -i /bin/sh -c \'. "$1"; cd "$2" && exec /bin/sh -c "$3"\' sh "$FAKE_STATE/server.env" "$c" "$1" \\\n'
        '      > "$FAKE_STATE/inner.out" 2>&1; rm -f "$FAKE_STATE/s-$n" ) </dev/null &\n'
        '    ;;\n'
        '  attach-session) for a; do n=$a; done; echo "ATTACHED ${n#=}";;\n'
        '  kill-session) rm -f "$FAKE_STATE/s-${3#=}";;\n'
        'esac\n'
    ))
    _write_exe(bin_dir / "claude", (
        'printf "%s\\n" "$@" > "$FAKE_STATE/claude.argv"\n'
        'printf "%s" "${NAVIDE_MCP_TOKEN:-}" > "$FAKE_STATE/claude.token"\n'
        'pwd > "$FAKE_STATE/claude.pwd"\n'
    ))
    env = {
        "PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(home), "SHELL": str(bin_dir / "loginsh"),
        "FAKE_STATE": str(state), "TMPDIR": str(tmp_path),
    }
    return {"bin": bin_dir, "state": state, "home": home, "env": env}


def _run_on_host(host: dict[str, Any], argv: list[str], stdin: bytes = b"") -> bytes:
    import subprocess

    done = subprocess.run(argv, input=stdin, capture_output=True, env=host["env"], timeout=20)
    return done.stdout


def _wait_for(path: Path) -> str:
    import time

    deadline = time.monotonic() + 10
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _tmux_claude(**extra: Any) -> dict[str, Any]:
    return _cli_spec(dir="~/proj", sessionId="0f0e", tmuxSession=_TMUX, **extra)


def _claude_argv(spec: dict[str, Any]) -> list[str]:
    return remote_ssh.cli_pane_argv(spec, pane_id="p1", local_port=1234, remote_port=45000, nonce=_NONCE)


def test_a_tmux_session_name_is_kept_and_checked():
    assert remote_ssh.record_spec(_tmux_claude(resume=True))["tmuxSession"] == _TMUX
    for bad in ("navide-x", "work", "navide-0123456789abcdef;rm", "navide-0123456789ABCDEF"):
        with pytest.raises(remote_ssh.SshTargetError):
            remote_ssh.parse_spec({**_SPEC, "tmuxSession": bad})


def test_a_claude_pane_starts_in_its_own_tmux_session_with_the_token_off_the_command_line(fake_host):
    token = "tok-" + os.urandom(6).hex()
    out = _run_on_host(fake_host, _claude_argv(_tmux_claude()), (token + "\n").encode())
    state = fake_host["state"]
    assert rd.TOKEN_REQUEST in out and f"ATTACHED {_TMUX}".encode() in out
    argv = _wait_for(state / "claude.argv").splitlines()
    assert "--session-id" in argv and argv[argv.index("--session-id") + 1] == "0f0e"
    assert "--mcp-config" in argv and "--resume" not in argv
    assert _wait_for(state / "claude.token") == token
    assert Path(_wait_for(state / "claude.pwd").strip()).resolve() == (fake_host["home"] / "proj").resolve()
    tmux_log = (state / "tmux.log").read_text(encoding="utf-8")
    assert f"-L navide -f /dev/null start-server" in tmux_log and f"new-session -d -s {_TMUX}" in tmux_log
    # The token went through the fifo only: on no command line, in no file,
    # and not in the environment the tmux server keeps for every session.
    assert token not in tmux_log and token not in (state / "ssh.log").read_text(encoding="utf-8")
    assert token not in (state / "start.env").read_text(encoding="utf-8")
    assert token not in (state / "server.env").read_text(encoding="utf-8")
    assert not list(Path(fake_host["env"]["TMPDIR"]).glob("tmp*/k"))


def test_a_reconnect_attaches_to_the_session_that_kept_running(fake_host):
    state = fake_host["state"]
    (state / f"s-{_TMUX}").touch()  # the CLI is still running in its session
    out = _run_on_host(fake_host, _claude_argv(_tmux_claude(resume=True)))
    assert f"ATTACHED {_TMUX}".encode() in out
    # Nothing restarted, nothing asked for a token, nothing said "missed".
    assert rd.TOKEN_REQUEST not in out and remote_ssh.RESUME_MISSED not in out
    assert not (state / "claude.argv").exists()
    assert "new-session" not in (state / "tmux.log").read_text(encoding="utf-8")


def test_a_session_gone_with_the_host_resumes_the_conversation_in_a_new_one(fake_host):
    transcript = fake_host["home"] / ".claude" / "projects" / "-proj"
    transcript.mkdir(parents=True)
    (transcript / "0f0e.jsonl").write_text("{}\n", encoding="utf-8")
    out = _run_on_host(fake_host, _claude_argv(_tmux_claude(resume=True)), b"t\n")
    assert f"ATTACHED {_TMUX}".encode() in out
    argv = _wait_for(fake_host["state"] / "claude.argv").splitlines()
    assert argv[argv.index("--resume") + 1] == "0f0e"


def test_without_tmux_on_the_host_the_pane_starts_as_before(fake_host):
    if Path("/usr/bin/tmux").exists() or Path("/bin/tmux").exists():
        pytest.skip("this host has tmux on the base PATH")
    (fake_host["bin"] / "tmux").unlink()
    out = _run_on_host(fake_host, _claude_argv(_tmux_claude()), b"t\n")
    assert b"ATTACHED" not in out
    argv = _wait_for(fake_host["state"] / "claude.argv").splitlines()
    assert argv[argv.index("--session-id") + 1] == "0f0e"


def test_a_terminal_pane_runs_a_login_shell_in_its_session(fake_host):
    spec = remote_ssh.parse_spec({**_SPEC, "dir": "~/proj", "tmuxSession": _TMUX})
    out = _run_on_host(fake_host, remote_ssh.shell_argv(spec))
    assert f"ATTACHED {_TMUX}".encode() in out
    shell = _wait_for(fake_host["state"] / "shell.out").splitlines()[0]
    assert shell.startswith("LOGIN-SHELL ") and shell.endswith("/proj")


def test_closing_the_pane_ends_its_session(fake_host):
    state = fake_host["state"]
    (state / f"s-{_TMUX}").touch()
    argv = remote_ssh.end_session_argv(_tmux_claude())
    assert "BatchMode=yes" in argv and "ControlPath=none" in argv and "ForwardAgent=no" in argv
    _run_on_host(fake_host, argv)
    assert not (state / f"s-{_TMUX}").exists()
    assert f"-L navide kill-session -t ={_TMUX}" in (state / "tmux.log").read_text(encoding="utf-8")


@pytest.mark.parametrize("cli", ["claude", "codex", "opencode"])
def test_every_tmux_script_is_valid_sh_and_reports_to_the_connection(cli):
    import shutil
    import subprocess

    if not shutil.which("sh"):
        pytest.skip("no sh")
    spec = _cli_spec(cli=cli, sessionId="abc-1", resume=True, dir="~/a b", tmuxSession=_TMUX)
    script = remote_ssh.cli_script(spec, pane_id="p1", remote_port=45000 if cli != "opencode" else None, nonce=_NONCE)
    assert subprocess.run(["sh", "-n"], input=script.encode()).returncode == 0
    # Inside tmux the reports go to the ssh connection's terminal.
    if cli != "opencode":
        assert "navide-resume-miss" in script and '> "$o"' in script
    terminal = remote_ssh.terminal_script(remote_ssh.parse_spec({**_SPEC, "tmuxSession": _TMUX}))
    assert subprocess.run(["sh", "-n"], input=terminal.encode()).returncode == 0


class _EndSock:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, msg: dict[str, Any]) -> None:
        self.sent.append(msg)


def test_end_session_reaches_only_a_trusted_target(monkeypatch):
    calls: list[list[str]] = []

    async def settings() -> dict[str, Any]:
        return _TRUSTED

    async def run(argv: list[str]) -> tuple[int, str, str]:
        calls.append(argv)
        return 0, "", ""

    monkeypatch.setattr(remote_devcontainer_ws, "_settings", settings)
    monkeypatch.setattr(remote_devcontainer_ws, "_run_ssh", run)

    def send(remote: dict[str, Any]) -> dict[str, Any]:
        sock = _EndSock()
        asyncio.run(remote_devcontainer_ws.remote_ssh_end_session(sock, "m", "remote_ssh.end_session", {"remote": remote}))
        return sock.sent[-1]

    reply = send({**_SPEC, "cli": "claude", "tmuxSession": _TMUX})
    assert reply["ok"] is True and reply["payload"] == {"ended": True}
    assert calls[-1][-1].endswith(f"kill-session -t ={_TMUX} 2>/dev/null; true'")
    assert send({**_SPEC, "host": "other-box", "tmuxSession": _TMUX})["error"]["code"] == "REMOTE_UNTRUSTED"
    assert send(dict(_SPEC))["error"]["code"] == "BAD_REQUEST"
    assert len(calls) == 1


def test_a_terminal_pane_in_the_server_a_claude_pane_started_gets_no_token(fake_host):
    from agent_team_backend.mcp_server import wiring

    state = fake_host["state"]
    token = "tok-" + os.urandom(6).hex()
    _run_on_host(fake_host, _claude_argv(_tmux_claude()), (token + "\n").encode())
    assert _wait_for(state / "claude.token") == token
    # Even a login shell that exports the variable cannot hand it to tmux.
    host = {**fake_host, "env": {**fake_host["env"], wiring.TOKEN_ENV: token, "navide_k": token}}
    other = "navide-" + "fedcba9876543210"
    spec = remote_ssh.parse_spec({**_SPEC, "dir": "~/proj", "tmuxSession": other})
    _run_on_host(host, remote_ssh.shell_argv(spec))
    shell = _wait_for(state / "shell.out")
    assert shell.startswith("LOGIN-SHELL ")
    assert token not in shell and wiring.TOKEN_ENV not in shell
    assert token not in (state / "start.env").read_text(encoding="utf-8")


def test_a_tmux_pane_keeps_its_tool_port_and_identity():
    spec = _tmux_claude()
    port = remote_ssh.tmux_port(spec)
    low, high = rd.REMOTE_PORT_RANGE
    assert low <= port <= high and port == remote_ssh.tmux_port(_tmux_claude(resume=True))
    assert remote_ssh.tool_identity(spec) == f"ssh-{_TMUX}"
    assert remote_ssh.tool_identity(_cli_spec()) == ""
    argv = _claude_argv(spec)
    # A host still holding the port for a dropped connection must not stop
    # the reattach; without tmux the pane fails and retries on a new port.
    assert "ExitOnForwardFailure=yes" not in argv
    assert "ExitOnForwardFailure=yes" in _claude_argv(_cli_spec())


def test_a_rebuilt_tmux_pane_keeps_its_cli_tools_until_it_is_closed(monkeypatch):
    from agent_team_backend import agent_messaging
    from agent_team_backend.mcp_server import wiring

    monkeypatch.setattr(wiring, "backend_port", lambda: 1234)
    monkeypatch.setattr(wiring, "_PANE_TOKENS", {})
    monkeypatch.setattr(agent_messaging, "_ALIASES", {})
    monkeypatch.setattr(remote_ssh, "_HELD_IDENTITIES", set())
    tool_id = f"ssh-{_TMUX}"
    remote = {**_SPEC, "cli": "claude", "sessionId": "0f0e", "tmuxSession": _TMUX}
    sess = _create(monkeypatch, _TRUSTED, {"agent_key": "remote", "remote": remote, "metadata": {"workspace_path": "/w"}})
    command = sess.terminals.created[0]["command"]
    assert f"pane%3D{tool_id}" in command[-1] or f"pane={tool_id}" in command[-1]
    assert command[command.index("-R") + 1].startswith(f"127.0.0.1:{remote_ssh.tmux_port(remote)}:")
    assert agent_messaging.resolve_alias(tool_id) == "p1"
    token = wiring.bound_pane_token(tool_id)
    assert token
    # The pane is rebuilt under a new id: the old one is forgotten, which
    # releases the tokens of every id that named it.
    agent_messaging._forget_aliases_to("p1")
    agent_messaging._release_caller_tokens(["p1", tool_id])
    assert wiring.bound_pane_token(tool_id) == token
    _create(monkeypatch, _TRUSTED, {"agent_key": "remote", "remote": {**remote, "resume": True},
                                    "metadata": {"workspace_path": "/w"}, "pane_id": "p2"})
    assert wiring.bound_pane_token(tool_id) == token
    assert agent_messaging.resolve_alias(tool_id) == "p2"

    async def run_end(argv: list[str]) -> tuple[int, str, str]:
        return 255, "", "unreachable"

    monkeypatch.setattr(remote_devcontainer_ws, "_run_ssh", run_end)
    agent_messaging._forget_aliases_to("p2")
    sock = _EndSock()
    asyncio.run(remote_devcontainer_ws.remote_ssh_end_session(sock, "m", "remote_ssh.end_session", {"remote": remote}))
    # Closed: the token goes even though the host could not be reached.
    assert sock.sent[-1]["payload"] == {"ended": False}
    assert wiring.bound_pane_token(tool_id) == "" and not remote_ssh.holds_identity(tool_id)
