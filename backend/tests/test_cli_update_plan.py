"""Updating the CLI install Navide launches (0.2.42).

- The newest release is read from the channel that installed the binary:
  npm, Homebrew, PyPI or GitHub. Every lookup here is faked.
- update_plan picks the command from how the install got there. Fake npm and
  brew executables stand in; nothing is ever installed or upgraded.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path

import pytest

from agent_team_backend import onboarding_deps as ob

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell shims and paths")


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(ob, "_npm_query", lambda _package: "")
    monkeypatch.setattr(ob, "_http_json", lambda _url: None)
    ob._NPM_LATEST.clear()
    ob._LATEST_CACHE.clear()
    yield
    ob._NPM_LATEST.clear()
    ob._LATEST_CACHE.clear()


def _executable(path: Path, body: str = "#!/bin/sh\nexit 0\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def _npm_install(tmp_path: Path, package: str, binary: str) -> tuple[Path, Path]:
    """A global npm layout: <prefix>/bin/{npm,<binary>} and the package under lib."""
    prefix = tmp_path / "node"
    entry = _executable(prefix / "lib" / "node_modules" / package / "bin" / f"{binary}.js")
    npm = _executable(prefix / "bin" / "npm")
    link = prefix / "bin" / binary
    link.symlink_to(entry)
    return link, npm


# ── where the newest release comes from ───────────────────────────────────────
def test_npm_install_asks_the_npm_registry(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob, "_npm_query", lambda package: "2.0.0" if package == "@anthropic-ai/claude-code" else "")
    link, _npm = _npm_install(tmp_path, "@anthropic-ai/claude-code", "claude")
    dep = ob.DEPS_BY_ID["claude"]
    assert ob._update_available(dep, "1.0.0", query_registry=True, resolved_path=os.path.realpath(link)) == "2.0.0"


def test_an_unplaced_install_is_never_compared(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob, "_npm_query", lambda _package: "2.0.0")
    elsewhere = _executable(tmp_path / "opt" / "claude")
    assert ob._update_available(ob.DEPS_BY_ID["claude"], "1.0.0", True, str(elsewhere)) == ""


def test_native_install_uses_the_declared_source(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    pypi = {"info": {"version": "0.90.0"}}
    monkeypatch.setattr(ob, "_http_json", lambda url: pypi if url == "https://pypi.org/pypi/aider-chat/json" else None)
    aider = _executable(tmp_path / ".local" / "share" / "uv" / "tools" / "aider-chat" / "bin" / "aider")
    dep = ob.DEPS_BY_ID["aider"]
    # The probe never queries; a query fills the cache the probe then reads.
    assert ob._update_available(dep, "0.86.2", resolved_path=str(aider)) == ""
    assert ob._update_available(dep, "0.86.2", True, str(aider)) == "0.90.0"
    assert ob._update_available(dep, "0.86.2", resolved_path=str(aider)) == "0.90.0"


def test_github_release_tags_lose_their_v(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob, "_http_json", lambda url: {"tag_name": "v1.19.5"} if "sst/opencode" in url else None)
    assert ob._source_query("github:sst/opencode") == "1.19.5"
    monkeypatch.setattr(ob, "_http_json", lambda _url: {"tag_name": "stable"})
    assert ob._source_query("github:aaif-goose/goose") == ""


def _brew_prefix(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, answer: dict) -> Path:
    """A Homebrew prefix whose `brew info` prints `answer` and records its args."""
    prefix = tmp_path / "homebrew"
    monkeypatch.setattr(ob, "_HOMEBREW_PREFIXES", (f"{prefix.as_posix()}/",))
    log = tmp_path / "brew-args"
    _executable(prefix / "bin" / "brew", f"#!/bin/sh\necho \"$@\" >> '{log}'\ncat <<'JSON'\n{json.dumps(answer)}\nJSON\n")
    return prefix


def test_cask_install_asks_homebrew_not_npm(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob, "_npm_query", lambda _package: "1.0.109")
    prefix = _brew_prefix(monkeypatch, tmp_path, {"casks": [{"version": "1.0.108", "auto_updates": True}]})
    binary = _executable(prefix / "Caskroom" / "copilot-cli" / "1.0.75" / "copilot")
    dep = ob.DEPS_BY_ID["copilot"]
    assert ob._update_available(dep, "1.0.81", True, str(binary)) == "1.0.108"
    assert (tmp_path / "brew-args").read_text().split() == ["info", "--json=v2", "--cask", "copilot-cli"]


# ── which command updates it ──────────────────────────────────────────────────
def test_npm_plan_uses_the_npm_beside_the_binary_pinned(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob, "_npm_query", lambda _package: "0.167.2")
    link, npm = _npm_install(tmp_path, "@openai/codex", "codex")
    plan = ob.update_plan(ob.DEPS_BY_ID["codex"], str(link), os.path.realpath(link), query=True)
    assert plan == {
        "manager": "npm", "reason": "",
        "command": f"{ob.osplat.paths.quote_arg(str(npm))} install -g @openai/codex@0.167.2",
    }


def test_npm_plan_without_a_known_release_installs_latest(tmp_path: Path) -> None:
    link, _npm = _npm_install(tmp_path, "@openai/codex", "codex")
    plan = ob.update_plan(ob.DEPS_BY_ID["codex"], str(link), os.path.realpath(link))
    assert plan["command"].endswith("install -g @openai/codex@latest")


def test_npm_plan_refuses_a_global_folder_it_cannot_write(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    link, _npm = _npm_install(tmp_path, "@openai/codex", "codex")
    real_access = os.access
    monkeypatch.setattr(ob.os, "access", lambda path, mode: False if str(path).endswith("node_modules") else real_access(path, mode))
    plan = ob.update_plan(ob.DEPS_BY_ID["codex"], str(link), os.path.realpath(link))
    assert plan == {"manager": "npm", "command": "", "reason": "npm-prefix-not-writable"}
    assert "sudo" not in json.dumps(plan)


def test_formula_plan_runs_brew_upgrade(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    prefix = _brew_prefix(monkeypatch, tmp_path, {"formulae": [{"versions": {"stable": "0.168.0"}}]})
    binary = _executable(prefix / "Cellar" / "codex" / "0.166.0" / "bin" / "codex")
    plan = ob.update_plan(ob.DEPS_BY_ID["codex"], str(binary), str(binary), query=True)
    assert plan["manager"] == "homebrew"
    assert plan["command"].endswith("/homebrew/bin/brew upgrade codex")


def test_self_updating_cask_runs_the_clis_own_update(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    prefix = _brew_prefix(monkeypatch, tmp_path, {"casks": [{"version": "1.0.108", "auto_updates": True}]})
    binary = _executable(prefix / "Caskroom" / "copilot-cli" / "1.0.75" / "copilot")
    plan = ob.update_plan(ob.DEPS_BY_ID["copilot"], str(binary), str(binary), query=True)
    assert plan["manager"] == "vendor"
    assert plan["command"].endswith("update")


def test_plain_cask_runs_brew_upgrade_cask(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    prefix = _brew_prefix(monkeypatch, tmp_path, {"casks": [{"version": "0.9.0", "auto_updates": False}]})
    binary = _executable(prefix / "Caskroom" / "droid" / "0.8.0" / "droid")
    plan = ob.update_plan(ob.DEPS_BY_ID["droid"], str(binary), str(binary), query=True)
    assert plan["command"].endswith("upgrade --cask droid")


def test_script_install_runs_the_clis_own_update(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    binary = _executable(tmp_path / ".opencode" / "bin" / "opencode")
    plan = ob.update_plan(ob.DEPS_BY_ID["opencode"], str(binary), str(binary))
    assert plan["manager"] == "vendor"
    assert plan["command"].endswith("opencode upgrade")


def test_unplaced_install_gets_no_command(tmp_path: Path) -> None:
    binary = _executable(tmp_path / "opt" / "claude")
    assert ob.update_plan(ob.DEPS_BY_ID["claude"], str(binary), str(binary)) == {
        "manager": "", "command": "", "reason": "unknown-install",
    }


def test_maintenance_update_runs_the_plan(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob, "_npm_query", lambda _package: "0.167.2")
    link, _npm = _npm_install(tmp_path, "@openai/codex", "codex")
    monkeypatch.setattr(ob, "resolve_executable", lambda dep, quick=False: str(link))
    result = ob.maintenance_command("codex", "update")
    assert result["ok"] is True and result["manager"] == "npm"
    assert result["command"].endswith("install -g @openai/codex@0.167.2")


def test_maintenance_update_keeps_the_vendor_command_for_an_unplaced_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    binary = _executable(tmp_path / "opt" / "claude")
    monkeypatch.setattr(ob, "resolve_executable", lambda dep, quick=False: str(binary))
    result = ob.maintenance_command("claude", "update")
    assert result["ok"] is True
    assert result["command"].endswith("update")


def test_maintenance_update_says_why_npm_cannot_write(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    link, _npm = _npm_install(tmp_path, "@openai/codex", "codex")
    monkeypatch.setattr(ob, "resolve_executable", lambda dep, quick=False: str(link))
    monkeypatch.setattr(ob, "update_plan", lambda *a, **k: {"manager": "npm", "command": "", "reason": "npm-prefix-not-writable"})
    result = ob.maintenance_command("codex", "update")
    assert result["ok"] is False and result["reason"] == "npm-prefix-not-writable"
