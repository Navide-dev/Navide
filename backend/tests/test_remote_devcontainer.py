"""Remote devcontainer panes: command assembly, token handling, env hygiene."""

from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from agent_team_backend import remote_devcontainer as rd
from agent_team_backend.mcp_server import wiring

CM = Path("/tmp/navide-test-cm")
SPEC = {"host": "mac-mini-ubuntu", "container": "devc-navide-app", "network": {"mode": "host"}}


def _fake_token() -> str:
    # Built at runtime so no token-shaped literal sits in the repository.
    return "tok" + "-" + "x" * 8 + str(random.randint(1000, 9999))


def _argv(agent: str = "claude", spec=SPEC) -> list[str]:
    return rd.pane_argv(spec, agent, pane_id="pane-1", local_port=49161, remote_port=45000, control_path_dir=CM)


def test_off_unless_exactly_true() -> None:
    assert not rd.enabled(None)
    assert not rd.enabled({})
    assert not rd.enabled({rd.SETTING_KEY: "true"})
    assert rd.enabled({rd.SETTING_KEY: True})


@pytest.mark.parametrize("host", ["", "-oProxyCommand=x", "a b", "host;rm", "$(x)", "a/b"])
def test_rejects_hosts_that_could_be_options_or_shell(host: str) -> None:
    with pytest.raises(rd.RemoteSpecError):
        rd.validate_host(host)


@pytest.mark.parametrize("host", ["mac-mini-ubuntu", "dev@box.local", "10.0.0.5"])
def test_accepts_ssh_aliases(host: str) -> None:
    assert rd.validate_host(host) == host


@pytest.mark.parametrize("name", ["", "-x", "a b", "a;b", "a'b"])
def test_rejects_bad_container_names(name: str) -> None:
    with pytest.raises(rd.RemoteSpecError):
        rd.validate_container(name)


def test_bridge_needs_an_ipv4_gateway() -> None:
    assert rd.validate_network({"mode": "bridge", "gateway": "172.17.0.1"}) == {
        "mode": "bridge", "gateway": "172.17.0.1"}
    with pytest.raises(rd.RemoteSpecError):
        rd.validate_network({"mode": "bridge", "gateway": "x;y"})
    with pytest.raises(rd.RemoteSpecError):
        rd.validate_network({"mode": "none"})


def test_pane_command_carries_utf8_and_no_keystroke_obscuring() -> None:
    argv = _argv()
    assert argv[:2] == ["ssh", "-tt"]
    assert "ObscureKeystrokeTiming=no" in argv
    assert "ForwardAgent=no" in argv
    assert "ControlMaster=auto" in argv
    assert "ExitOnForwardFailure=yes" in argv
    assert "-A" not in argv
    script = argv[-1]
    assert "LANG=C.UTF-8" in script and "LC_ALL=C.UTF-8" in script
    assert "docker exec -it" in script and "devc-navide-app" in script


def test_tunnel_binds_loopback_for_host_network() -> None:
    argv = _argv()
    assert argv[argv.index("-R") + 1] == "127.0.0.1:45000:127.0.0.1:49161"
    assert "http://127.0.0.1:45000/plan-mcp?pane=pane-1" in argv[-1]


def test_tunnel_binds_gateway_for_bridge_network() -> None:
    spec = {**SPEC, "network": {"mode": "bridge", "gateway": "172.17.0.1"}}
    argv = _argv(spec=spec)
    assert argv[argv.index("-R") + 1] == "172.17.0.1:45000:127.0.0.1:49161"
    assert "http://172.17.0.1:45000/plan-mcp" in argv[-1]


def test_token_is_never_on_the_command_line() -> None:
    token = wiring.caller_token("pane-1")
    try:
        for agent in rd.AGENTS:
            joined = " ".join(_argv(agent))
            assert token not in joined
            assert "&t=" not in joined
    finally:
        wiring.release_pane_token("pane-1")


def test_claude_reads_its_config_as_content_with_a_bearer_from_env() -> None:
    argv = _argv("claude")
    script = argv[-1]
    assert "--mcp-config" in script
    # The JSON document is shell-quoted inside the remote line; recover it.
    import shlex

    inner = shlex.split(script.split("exec docker exec", 1)[1])
    document = json.loads(inner[inner.index("--mcp-config") + 1])
    entry = document["mcpServers"][wiring.SERVER_NAME]
    assert entry["headers"] == {"Authorization": "Bearer ${NAVIDE_MCP_TOKEN}"}
    assert "/plan-mcp?pane=pane-1" in json.dumps(document)
    assert not any(part.endswith(".json") and part.startswith("/") for part in inner)


def test_codex_takes_the_token_by_variable_name() -> None:
    script = _argv("codex")[-1]
    assert 'bearer_token_env_var="NAVIDE_MCP_TOKEN"' in script
    assert "-e NAVIDE_MCP_TOKEN" in script


def test_other_agents_are_refused() -> None:
    with pytest.raises(rd.RemoteSpecError):
        _argv("gemini")


def test_echo_is_off_before_the_token_is_requested() -> None:
    script = _argv()[-1]
    assert script.index("stty -echo") < script.index("printf") < script.index("read -r NAVIDE_MCP_TOKEN")
    assert script.index("read -r") < script.index("stty echo;")


def test_token_feeder_waits_for_the_request_even_split_across_reads() -> None:
    written: list[str] = []
    token = _fake_token()
    feeder = rd.TokenFeeder(token, written.append)
    feeder.feed(b"Welcome to host\r\n")
    assert written == []
    half = len(rd.TOKEN_REQUEST) // 2
    feeder.feed(b"motd" + rd.TOKEN_REQUEST[:half])
    assert written == []
    feeder.feed(rd.TOKEN_REQUEST[half:] + b"more")
    assert written == [token + "\r"]
    feeder.feed(rd.TOKEN_REQUEST)
    assert written == [token + "\r"], "the token is written exactly once"


def test_spawn_env_keeps_only_what_ssh_needs() -> None:
    secret_name = "ANTHROPIC" + "_API_KEY"
    environ = {
        "PATH": "/usr/bin", "HOME": "/h", "SSH_AUTH_SOCK": "/s", "LC_CTYPE": "UTF-8",
        secret_name: "fake", "OPENAI_API_KEY": "fake", "CODEX_HOME": "/c", "CLAUDE_CONFIG_DIR": "/d",
    }
    removed = rd.spawn_env_remove(environ)
    assert secret_name in removed and "OPENAI_API_KEY" in removed
    assert "CODEX_HOME" in removed and "CLAUDE_CONFIG_DIR" in removed
    assert "PATH" not in removed and "SSH_AUTH_SOCK" not in removed and "LC_CTYPE" not in removed


def test_parse_container_list() -> None:
    text = (
        "/devc-old-test\texited\tbridge\t\n"
        "/devc-website\trunning\tbridge\t172.17.0.1 \n"
        "/devc-navide-app\trunning\thost\t\n"
        "garbage line\n"
        "/bad name\trunning\thost\t\n"
    )
    rows = rd.parse_container_list(text)
    assert [r["name"] for r in rows] == ["devc-navide-app", "devc-website", "devc-old-test"]
    assert rows[0]["network"] == {"mode": "host"}
    assert rows[1]["network"] == {"mode": "bridge", "gateway": "172.17.0.1"}
    assert rows[2]["running"] is False
    assert rows[2]["network"]["mode"] == "unsupported"


def test_list_and_probe_are_batch_mode_and_validate() -> None:
    argv = rd.list_argv("mac-mini-ubuntu", CM)
    assert "BatchMode=yes" in argv and "-T" in argv
    probe = rd.probe_argv(SPEC, "codex", local_port=49161, remote_port=45000, control_path_dir=CM)
    assert "BatchMode=yes" in probe
    assert "command -v codex" in probe[-1]
    assert probe[probe.index("-R") + 1] == "127.0.0.1:45000:127.0.0.1:49161"
    assert "Authorization" not in probe[-1] and "NAVIDE_MCP_TOKEN" not in probe[-1]
    with pytest.raises(rd.RemoteSpecError):
        rd.list_argv("-oProxyCommand=evil", CM)
    with pytest.raises(rd.RemoteSpecError):
        rd.probe_argv(SPEC, "gemini", local_port=1, remote_port=2, control_path_dir=CM)


@pytest.mark.parametrize(("line", "status"), [
    ("MCP:401", "ok"), ("MCP:000none", "unreachable"), ("MCP:000", "unreachable"),
    ("MCP:none", "unknown"), ("MCP:", "unknown"), ("MCP:404", "http-404"),
])
def test_parse_probe(line: str, status: str) -> None:
    result = rd.parse_probe(f"CLI:/usr/bin/claude\nVER:2.1.0 (Claude Code)\n{line}\n")
    assert result == {"cli_path": "/usr/bin/claude", "cli_version": "2.1.0 (Claude Code)", "mcp": status}


def test_control_dir_is_owner_only(tmp_path, monkeypatch) -> None:
    if rd.os.name == "nt":
        assert rd.control_dir() is None
        return
    path = rd.control_dir()
    assert path is not None
    assert path.stat().st_mode & 0o077 == 0
    assert len(f"{path}/" + "x" * 40) < 100
    assert "ControlPath" not in " ".join(rd.ssh_base_options(None))


def test_module_never_touches_ssh_keys_or_agent() -> None:
    source = Path(rd.__file__).read_text(encoding="utf-8")
    code = source.split('"""', 2)[2]  # skip the module docstring that names them
    assert "ssh-add" not in code
    assert "~/.ssh" not in code and ".ssh/" not in code
