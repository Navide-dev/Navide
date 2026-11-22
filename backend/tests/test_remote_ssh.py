"""SSH Remote panes: the target shape, and what never leaves this machine.

The private key is named by path and never opened; agent forwarding is never
on. Opening a pane is not built yet, so ``remote_ssh.connect`` must answer
``REMOTE_SSH_UNSUPPORTED`` rather than hang.
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


def _connect(monkeypatch: pytest.MonkeyPatch, settings: dict[str, Any], target: Any) -> dict[str, Any]:
    async def read() -> dict[str, Any]:
        return settings

    monkeypatch.setattr(remote_devcontainer_ws, "_settings", read)
    sock = _Sock()
    asyncio.run(asyncio.wait_for(
        remote_devcontainer_ws.remote_ssh_connect(sock, "m1", "remote_ssh.connect", {"target": target}), 5))
    return sock.sent[-1]


def test_connect_is_refused_while_the_switch_is_off(monkeypatch):
    reply = _connect(monkeypatch, {}, {"host": "build-box"})
    assert reply["error"]["code"] == "REMOTE_DISABLED"


def test_connect_answers_unsupported_without_running_ssh(monkeypatch):
    async def no_ssh(*_a, **_k):
        pytest.fail("ssh must not run yet")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", no_ssh)
    reply = _connect(monkeypatch, {rd.SETTING_KEY: True}, {"host": "build-box", "port": 22})
    assert reply["error"]["code"] == "REMOTE_SSH_UNSUPPORTED"


def test_connect_rejects_a_bad_target(monkeypatch):
    reply = _connect(monkeypatch, {rd.SETTING_KEY: True}, {"host": "-oProxyCommand=x"})
    assert reply["error"]["code"] == "BAD_REQUEST"
