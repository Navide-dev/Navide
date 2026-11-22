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


def test_the_argv_never_forwards_the_agent():
    argv = remote_ssh.shell_argv(_target(keyPath="/keys/id_test"), Path("/tmp/cm"))
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


def test_a_missing_key_file_is_not_checked_here():
    # ssh reports a missing key itself; this module never stats the file.
    target = remote_ssh.parse_target({"host": "box", "keyPath": "/nowhere/id_" + "missing"})
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

        return _Term()


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
    assert created["metadata"][remote_ssh.METADATA_KEY] == _SPEC
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
