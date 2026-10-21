"""Risk declarations use the pane's runtime, never the backend's home or secrets."""

import sys
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors import registry
from agent_team_backend.cli_vendors.base import VendorRuntimeContext, VendorSpec


DEFAULT_ROOTS = {
    "antigravity": ".gemini/antigravity-cli",
    "claude": ".claude",
    "codex": ".codex",
    "copilot": ".copilot",
    "cursor": ".cursor/chats",
    "droid": ".factory",
    "goose": "AppData/Roaming/Block/goose/data" if sys.platform == "win32" else ".local/share/goose",
    "grok": ".grok",
    "kilo": ".local/share/kilo",
    "kimi": ".kimi-code",
    "mcode": ".minimax",
    "muse": ".local/share/muse",
    "opencode": ".local/share/opencode",
    "pi": ".pi/agent",
    "qwen": ".qwen",
}


def test_legacy_spec_construction_keeps_risk_unsupported():
    spec = VendorSpec("test", "Test", (".test", "auth.json"))
    assert spec.live_file == (".test", "auth.json")
    assert spec.expected_hosts == ()
    assert spec.data_dirs is None
    assert spec.data_dir_env_vars == ()
    assert spec.network_override_env_vars == ()


@pytest.mark.parametrize("key", DEFAULT_ROOTS)
def test_default_roots_follow_actual_pane_home(key, tmp_path, monkeypatch):
    home = tmp_path / "pane-home"
    ctx = registry.risk_runtime_context({"HOME": str(home)}, tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path / "wrong-backend-home"))
    roots = registry.VENDORS[key].data_dirs(ctx)
    assert roots == (home / DEFAULT_ROOTS[key],)
    assert all(path.is_absolute() for path in roots)
    assert not home.exists()  # Resolving declarations must not create directories.


@pytest.mark.parametrize(("key", "variable", "suffix"), [
    ("claude", "CLAUDE_CONFIG_DIR", ""),
    ("codex", "CODEX_HOME", ""),
    ("copilot", "COPILOT_HOME", ""),
    ("droid", "FACTORY_HOME_OVERRIDE", ""),
    ("grok", "GROK_HOME", ""),
    ("kimi", "KIMI_CODE_HOME", ""),
    ("mcode", "MINIMAX_DATA_DIR", ""),
    ("mcode", "MAVIS_DATA_DIR", ""),
    ("kilo", "XDG_DATA_HOME", "kilo"),
    ("muse", "XDG_DATA_HOME", "muse"),
    ("opencode", "XDG_DATA_HOME", "opencode"),
    ("pi", "PI_CODING_AGENT_DIR", ""),
    ("qwen", "QWEN_HOME", ""),
])
@pytest.mark.parametrize("relative", [False, True])
def test_isolated_roots_replace_defaults(key, variable, suffix, relative, tmp_path, monkeypatch):
    root = "isolated" if relative else str(tmp_path / "isolated")
    env = {"HOME": str(tmp_path / "pane-home"), variable: root}
    ctx = registry.risk_runtime_context(env, tmp_path)
    monkeypatch.setenv(variable, str(tmp_path / "wrong-backend-root"))
    assert registry.VENDORS[key].data_dirs(ctx) == (tmp_path / "isolated" / suffix,)


def test_split_runtime_roots_and_legacy_precedence(tmp_path):
    env = {
        "HOME": str(tmp_path / "home"),
        "QWEN_HOME": str(tmp_path / "qwen-config"),
        "QWEN_RUNTIME_DIR": str(tmp_path / "qwen-runtime"),
        "PI_CODING_AGENT_DIR": str(tmp_path / "pi-config"),
        "PI_CODING_AGENT_SESSION_DIR": str(tmp_path / "pi-sessions"),
        "MINIMAX_DATA_DIR": str(tmp_path / "minimax"),
        "MAVIS_DATA_DIR": str(tmp_path / "legacy"),
    }
    ctx = registry.risk_runtime_context(env, tmp_path)
    assert registry.VENDORS["qwen"].data_dirs(ctx) == (
        tmp_path / "qwen-config", tmp_path / "qwen-runtime",
    )
    assert registry.VENDORS["pi"].data_dirs(ctx) == (
        tmp_path / "pi-config", tmp_path / "pi-sessions",
    )
    assert registry.VENDORS["mcode"].data_dirs(ctx) == (tmp_path / "minimax",)


def test_aider_does_not_declare_workspace_as_data_root():
    assert registry.VENDORS["aider"].data_dirs is None
    assert set(registry.VENDORS) == set(DEFAULT_ROOTS) | {"aider"}


def test_codex_separate_sqlite_home(tmp_path):
    ctx = registry.risk_runtime_context({
        "HOME": str(tmp_path), "CODEX_HOME": "codex", "CODEX_SQLITE_HOME": "state",
    }, tmp_path)
    assert registry.VENDORS["codex"].data_dirs(ctx) == (tmp_path / "codex", tmp_path / "state")


def test_qwen_expands_tilde_using_pane_home(tmp_path):
    ctx = registry.risk_runtime_context({
        "HOME": str(tmp_path), "QWEN_HOME": "~/config", "QWEN_RUNTIME_DIR": "~/runtime",
    }, tmp_path / "cwd")
    assert registry.VENDORS["qwen"].data_dirs(ctx) == (tmp_path / "config", tmp_path / "runtime")


def test_root_resolution_does_not_read_filesystem(tmp_path, monkeypatch):
    ctx = registry.risk_runtime_context({"HOME": str(tmp_path)}, tmp_path)

    def refuse(*_args, **_kwargs):
        raise AssertionError("Declarations must not access files or use the backend home")

    for name in ("home", "resolve", "stat", "is_dir", "exists", "open", "iterdir"):
        monkeypatch.setattr(Path, name, refuse)
    for key in DEFAULT_ROOTS:
        assert registry.VENDORS[key].data_dirs(ctx)


def test_runtime_capture_drops_credentials_and_redacts_endpoint_values(tmp_path):
    env = {
        "HOME": str(tmp_path), "CODEX_HOME": str(tmp_path / "isolated"),
        "OPENAI_API_KEY": "secret-key", "ANTHROPIC_AUTH_TOKEN": "secret-token",
        "HTTPS_PROXY": "https://user:secret@proxy.example:8443/private?token=secret",
        "OPENAI_BASE_URL": "https://user:secret@api.example/v1?token=secret",
        "UNRELATED": "secret-value",
    }
    ctx = registry.risk_runtime_context(env, tmp_path)
    assert dict(ctx.env) == {
        "HOME": str(tmp_path), "CODEX_HOME": str(tmp_path / "isolated"),
        "HTTPS_PROXY": "1", "OPENAI_BASE_URL": "1",
    }
    assert "secret" not in repr(ctx)
    env["CODEX_HOME"] = "changed-after-spawn"
    assert ctx.env["CODEX_HOME"] == str(tmp_path / "isolated")
    with pytest.raises(TypeError):
        ctx.env["CODEX_HOME"] = "mutated"
    with pytest.raises(FrozenInstanceError):
        ctx.home = tmp_path / "changed"


def test_home_must_come_from_runtime(tmp_path):
    with pytest.raises(ValueError):
        registry.risk_runtime_context({}, tmp_path)
    ctx = registry.risk_runtime_context({"USERPROFILE": str(tmp_path)}, tmp_path)
    assert ctx.home == tmp_path


@pytest.mark.parametrize(("home_key", "expected_dir"), [("HOME", "shell-home"), ("USERPROFILE", "profile")])
def test_home_prefers_runtime_platform_variable(tmp_path, monkeypatch, home_key, expected_dir):
    monkeypatch.setattr(registry.osplat.paths, "home_env_var", lambda: home_key)
    ctx = registry.risk_runtime_context({
        "USERPROFILE": str(tmp_path / "profile"), "HOME": str(tmp_path / "shell-home"),
    }, tmp_path)
    assert ctx.home == tmp_path / expected_dir


@pytest.mark.parametrize(("home", "cwd"), [("relative", "/workspace"), ("/home", "relative")])
def test_nonabsolute_runtime_is_unknown(home, cwd):
    with pytest.raises(ValueError):
        registry.risk_runtime_context({"HOME": home}, cwd)


@pytest.mark.parametrize("key", ["claude", "codex"])
def test_verified_primary_network_defaults(key, tmp_path):
    ctx = registry.risk_runtime_context({"HOME": str(tmp_path)}, tmp_path)
    hosts = registry.expected_hosts_for_context(registry.VENDORS[key], ctx)
    assert ("api.anthropic.com" if key == "claude" else "api.openai.com") in hosts
    assert hosts == registry.VENDORS[key].expected_hosts
    assert 0 < len(hosts) <= 64
    assert len(set(hosts)) == len(hosts)
    assert all(host and "://" not in host and "*" not in host and "/" not in host for host in hosts)


@pytest.mark.parametrize("key", ["claude", "codex"])
@pytest.mark.parametrize("proxy", ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"])
def test_proxy_never_uses_direct_service_defaults(key, proxy, tmp_path):
    ctx = registry.risk_runtime_context({"HOME": str(tmp_path), proxy: "http://proxy.example:8080"}, tmp_path)
    assert registry.expected_hosts_for_context(registry.VENDORS[key], ctx) == ()


@pytest.mark.parametrize("key", ["claude", "codex"])
def test_custom_provider_overrides_remain_unsupported(key, tmp_path):
    spec = registry.VENDORS[key]
    assert spec.network_override_env_vars
    for variable in spec.network_override_env_vars:
        ctx = registry.risk_runtime_context({"HOME": str(tmp_path), variable: "custom"}, tmp_path)
        assert registry.expected_hosts_for_context(spec, ctx) == (), variable


def test_undeclared_networks_stay_unsupported(tmp_path):
    ctx = VendorRuntimeContext(home=tmp_path, env={}, cwd=tmp_path)
    for key, spec in registry.VENDORS.items():
        if key not in {"claude", "codex"}:
            assert registry.expected_hosts_for_context(spec, ctx) == ()
