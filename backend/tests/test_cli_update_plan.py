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

#: The symlinked-npm and Homebrew layouts below are POSIX ones. The Windows
#: npm shim tests at the end fake win32 through osplat and run everywhere.
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell shims and paths")


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
@posix_only
def test_npm_install_asks_the_npm_registry(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob, "_npm_query", lambda package: "2.0.0" if package == "@anthropic-ai/claude-code" else "")
    link, _npm = _npm_install(tmp_path, "@anthropic-ai/claude-code", "claude")
    dep = ob.DEPS_BY_ID["claude"]
    assert ob._update_available(dep, "1.0.0", query_registry=True, resolved_path=os.path.realpath(link)) == "2.0.0"


@posix_only
def test_an_unplaced_install_is_never_compared(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob, "_npm_query", lambda _package: "2.0.0")
    elsewhere = _executable(tmp_path / "opt" / "claude")
    assert ob._update_available(ob.DEPS_BY_ID["claude"], "1.0.0", True, str(elsewhere)) == ""


@posix_only
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


@posix_only
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


@posix_only
def test_cask_install_asks_homebrew_not_npm(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob, "_npm_query", lambda _package: "1.0.109")
    prefix = _brew_prefix(monkeypatch, tmp_path, {"casks": [{"version": "1.0.108", "auto_updates": True}]})
    binary = _executable(prefix / "Caskroom" / "copilot-cli" / "1.0.75" / "copilot")
    dep = ob.DEPS_BY_ID["copilot"]
    assert ob._update_available(dep, "1.0.81", True, str(binary)) == "1.0.108"
    assert (tmp_path / "brew-args").read_text().split() == ["info", "--json=v2", "--cask", "copilot-cli"]


# ── which command updates it ──────────────────────────────────────────────────
@posix_only
def test_npm_plan_uses_the_npm_beside_the_binary_pinned(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob, "_npm_query", lambda _package: "0.167.2")
    link, npm = _npm_install(tmp_path, "@openai/codex", "codex")
    plan = ob.update_plan(ob.DEPS_BY_ID["codex"], str(link), os.path.realpath(link), query=True)
    assert plan == {
        "manager": "npm", "reason": "",
        "command": f"{ob.osplat.paths.quote_arg(str(npm))} install -g @openai/codex@0.167.2",
    }


@posix_only
def test_npm_plan_without_a_known_release_installs_latest(tmp_path: Path) -> None:
    link, _npm = _npm_install(tmp_path, "@openai/codex", "codex")
    plan = ob.update_plan(ob.DEPS_BY_ID["codex"], str(link), os.path.realpath(link))
    assert plan["command"].endswith("install -g @openai/codex@latest")


@posix_only
def test_npm_plan_refuses_a_global_folder_it_cannot_write(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    link, _npm = _npm_install(tmp_path, "@openai/codex", "codex")
    real_access = os.access
    monkeypatch.setattr(ob.os, "access", lambda path, mode: False if str(path).endswith("node_modules") else real_access(path, mode))
    plan = ob.update_plan(ob.DEPS_BY_ID["codex"], str(link), os.path.realpath(link))
    assert plan == {"manager": "npm", "command": "", "reason": "npm-prefix-not-writable"}
    assert "sudo" not in json.dumps(plan)


@posix_only
def test_formula_plan_runs_brew_upgrade(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    prefix = _brew_prefix(monkeypatch, tmp_path, {"formulae": [{"versions": {"stable": "0.168.0"}}]})
    binary = _executable(prefix / "Cellar" / "codex" / "0.166.0" / "bin" / "codex")
    plan = ob.update_plan(ob.DEPS_BY_ID["codex"], str(binary), str(binary), query=True)
    assert plan["manager"] == "homebrew"
    assert plan["command"].endswith("/homebrew/bin/brew upgrade codex")


@posix_only
def test_self_updating_cask_runs_the_clis_own_update(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    prefix = _brew_prefix(monkeypatch, tmp_path, {"casks": [{"version": "1.0.108", "auto_updates": True}]})
    binary = _executable(prefix / "Caskroom" / "copilot-cli" / "1.0.75" / "copilot")
    plan = ob.update_plan(ob.DEPS_BY_ID["copilot"], str(binary), str(binary), query=True)
    assert plan["manager"] == "vendor"
    assert plan["command"].endswith("update")


@posix_only
def test_plain_cask_runs_brew_upgrade_cask(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    prefix = _brew_prefix(monkeypatch, tmp_path, {"casks": [{"version": "0.9.0", "auto_updates": False}]})
    binary = _executable(prefix / "Caskroom" / "droid" / "0.8.0" / "droid")
    plan = ob.update_plan(ob.DEPS_BY_ID["droid"], str(binary), str(binary), query=True)
    assert plan["command"].endswith("upgrade --cask droid")


@posix_only
def test_script_install_runs_the_clis_own_update(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    binary = _executable(tmp_path / ".opencode" / "bin" / "opencode")
    plan = ob.update_plan(ob.DEPS_BY_ID["opencode"], str(binary), str(binary))
    assert plan["manager"] == "vendor"
    assert plan["command"].endswith("opencode upgrade")


@posix_only
def test_unplaced_install_gets_no_command(tmp_path: Path) -> None:
    binary = _executable(tmp_path / "opt" / "claude")
    assert ob.update_plan(ob.DEPS_BY_ID["claude"], str(binary), str(binary)) == {
        "manager": "", "command": "", "reason": "unknown-install",
    }


@posix_only
def test_maintenance_update_runs_the_plan(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob, "_npm_query", lambda _package: "0.167.2")
    link, _npm = _npm_install(tmp_path, "@openai/codex", "codex")
    monkeypatch.setattr(ob, "resolve_executable", lambda dep, quick=False: str(link))
    result = ob.maintenance_command("codex", "update")
    assert result["ok"] is True and result["manager"] == "npm"
    assert result["command"].endswith("install -g @openai/codex@0.167.2")


@posix_only
def test_maintenance_update_keeps_the_vendor_command_for_an_unplaced_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    binary = _executable(tmp_path / "opt" / "claude")
    monkeypatch.setattr(ob, "resolve_executable", lambda dep, quick=False: str(binary))
    result = ob.maintenance_command("claude", "update")
    assert result["ok"] is True
    assert result["command"].endswith("update")


@posix_only
def test_maintenance_update_says_why_npm_cannot_write(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    link, _npm = _npm_install(tmp_path, "@openai/codex", "codex")
    monkeypatch.setattr(ob, "resolve_executable", lambda dep, quick=False: str(link))
    monkeypatch.setattr(ob, "update_plan", lambda *a, **k: {"manager": "npm", "command": "", "reason": "npm-prefix-not-writable"})
    result = ob.maintenance_command("codex", "update")
    assert result["ok"] is False and result["reason"] == "npm-prefix-not-writable"


# ── Windows npm shims (faked through osplat.platform_id, so they run anywhere) ─
_CMD_SHIM = (
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\n'
    'CALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n'
    '  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & '
    '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
)
_PS1_SHIM = (
    '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n'
    '$exe=""\nif (Test-Path "$basedir/node$exe") {\n'
    '  & "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args\n'
    '} else {\n  & "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args\n}\n'
)
_SH_SHIM = (
    '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n\n'
    'if [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"\n'
    'else \n  exec node  "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"\nfi\n'
)
_SHIMS = {"codex.cmd": _CMD_SHIM, "codex.ps1": _PS1_SHIM, "codex": _SH_SHIM}


def _windows_npm_prefix(prefix: Path, shim: str) -> Path:
    """A Windows global npm prefix: shims in its root, the package under node_modules."""
    _executable(prefix / "node_modules" / "@openai" / "codex" / "bin" / "codex.js")
    _executable(prefix / "node_modules" / "@openai" / "codex" / "package.json", '{"name": "@openai/codex"}')
    _executable(prefix / "npm.cmd", "@ECHO off\r\n")
    _executable(prefix / "npm")
    return _executable(prefix / shim, _SHIMS[shim])


@pytest.mark.parametrize("shim", sorted(_SHIMS))
@pytest.mark.parametrize("layout", ["AppData/Roaming/npm", "node-v22.11.0-win-x64"])
def test_windows_npm_shim_is_an_npm_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, layout: str, shim: str,
) -> None:
    """%APPDATA%\\npm and a zip Node's prefix both keep the shim beside node_modules."""
    monkeypatch.setattr(ob.osplat, "platform_id", "win32")
    monkeypatch.setattr(ob, "_npm_query", lambda package: "0.167.2" if package == "@openai/codex" else "")
    prefix = tmp_path / layout
    binary = _windows_npm_prefix(prefix, shim)
    dep = ob.DEPS_BY_ID["codex"]

    resolved = ob._resolved_install(str(binary))
    assert Path(resolved) == prefix / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
    assert ob._install_method(resolved) == "npm"
    assert ob._update_available(dep, "0.167.1", query_registry=True, resolved_path=resolved) == "0.167.2"
    npm = ob._npm_beside(str(binary))
    assert npm
    assert ob.update_plan(dep, str(binary), resolved, query=True) == {
        "manager": "npm", "reason": "",
        "command": f"{ob.osplat.paths.quote_arg(npm)} install -g @openai/codex@0.167.2",
    }


def test_maintenance_update_follows_a_windows_npm_shim(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob.osplat, "platform_id", "win32")
    monkeypatch.setattr(ob, "_npm_query", lambda _package: "0.167.2")
    binary = _windows_npm_prefix(tmp_path / "AppData" / "Roaming" / "npm", "codex.cmd")
    monkeypatch.setattr(ob, "resolve_executable", lambda dep, quick=False: str(binary))
    result = ob.maintenance_command("codex", "update")
    assert result["ok"] is True and result["manager"] == "npm"
    assert result["command"].endswith("install -g @openai/codex@0.167.2")


@pytest.mark.parametrize("body", [
    # scoop's shim: runs an app outside any npm prefix.
    '@rem C:\\Users\\me\\scoop\\apps\\codex\\current\\codex.exe\r\n'
    '@"C:\\Users\\me\\scoop\\apps\\codex\\current\\codex.exe" %*\r\n',
    # an npm-looking shim whose package is not there.
    _CMD_SHIM.replace("@openai\\codex", "@openai\\gone"),
    # a target that climbs out of node_modules.
    _CMD_SHIM.replace("node_modules\\@openai\\codex\\bin\\codex.js", "node_modules\\..\\..\\codex.js"),
])
def test_other_windows_cmd_shims_stay_unknown(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, body: str,
) -> None:
    monkeypatch.setattr(ob.osplat, "platform_id", "win32")
    prefix = tmp_path / "scoop" / "shims"
    _executable(prefix / "node_modules" / "@openai" / "codex" / "bin" / "codex.js")
    _executable(tmp_path / "scoop" / "codex.js")
    binary = _executable(prefix / "codex.cmd", body)
    resolved = ob._resolved_install(str(binary))
    assert resolved == os.path.realpath(binary)
    assert ob.update_plan(ob.DEPS_BY_ID["codex"], str(binary), resolved) == {
        "manager": "", "command": "", "reason": "unknown-install",
    }


def test_shims_are_only_followed_on_windows(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob.osplat, "platform_id", "linux")
    binary = _windows_npm_prefix(tmp_path / "npm", "codex")
    assert ob._resolved_install(str(binary)) == os.path.realpath(binary)
