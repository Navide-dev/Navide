"""onboarding_deps — version detection (3 states), install whitelist, gate, flag."""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import pytest

from agent_team_backend import onboarding_deps as ob
from agent_team_backend.onboarding_deps import Dep, PlatformInstall


# ── detect_dep: ok / outdated / missing ──────────────────────────────────────
_NODE = Dep("node", "Node", "", "foundation", ["node", "--version"],
            r"v?(\d+\.\d+\.\d+)", min_version="22.0.0", install_cmd="brew install node@22")


def _fake_run(stdout: str):
    def run(*_a, **_k):
        return subprocess.CompletedProcess(_a[0] if _a else [], 0, stdout, "")
    return run


def _resolves_to(monkeypatch: pytest.MonkeyPatch, found: str | None) -> None:
    """What the launch seam finds on PATH for every name asked about."""
    monkeypatch.setattr(
        ob.osplat.paths, "resolve_program", lambda _name, *, path=None: found
    )


def test_detect_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    _resolves_to(monkeypatch, "/usr/bin/node")
    monkeypatch.setattr(ob.subprocess, "run", _fake_run("v22.3.0"))
    r = ob.detect_dep(_NODE)
    assert r["status"] == "ok" and r["version"] == "22.3.0"


def test_detect_outdated(monkeypatch: pytest.MonkeyPatch) -> None:
    _resolves_to(monkeypatch, "/usr/bin/node")
    monkeypatch.setattr(ob.subprocess, "run", _fake_run("v18.0.0"))
    r = ob.detect_dep(_NODE)
    assert r["status"] == "outdated" and r["version"] == "18.0.0"


def test_detect_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    _resolves_to(monkeypatch, None)
    r = ob.detect_dep(_NODE)
    assert r["status"] == "missing" and r["version"] == ""


# npm on Windows installs a CLI as a `claude.cmd` batch shim, and CreateProcess
# cannot start one (WinError 193). Without the interpreter in front of it every
# dep's version probe fails and the wizard reports the whole toolchain missing.
def test_detect_probes_a_windows_shim_through_cmd(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend.osplat import _windows

    monkeypatch.setattr(ob.osplat, "paths", _windows.paths)
    monkeypatch.setattr(
        _windows.paths, "resolve_program", lambda _name, *, path=None: r"C:\npm\node.cmd"
    )
    probed: list[list[str]] = []

    def run(cmd, *_a, **_k):
        probed.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 0, "v22.3.0", "")

    monkeypatch.setattr(ob.subprocess, "run", run)
    assert ob.detect_dep(_NODE)["status"] == "ok"
    assert probed == [["cmd.exe", "/d", "/c", r"C:\npm\node.cmd", "--version"]]


# ── install-method classification (picks which official command applies) ──────
def _home(monkeypatch: pytest.MonkeyPatch, home: Path) -> None:
    monkeypatch.setattr(ob.Path, "home", classmethod(lambda _cls: home))


def test_install_method_npm_wins_over_prefix(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _home(monkeypatch, tmp_path)
    npm_in_brew = "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"
    assert ob._install_method(npm_in_brew) == "npm"


def test_install_method_homebrew() -> None:
    assert ob._install_method("/opt/homebrew/bin/ollama") == "homebrew"
    assert ob._install_method("/usr/local/Cellar/uv/0.5.0/bin/uv") == "homebrew"


def test_install_method_native_vendor_installer(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _home(monkeypatch, tmp_path)
    assert ob._install_method(f"{tmp_path}/.local/share/claude/versions/2.1.219") == "native"


def test_install_method_vendor_script(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _home(monkeypatch, tmp_path)
    assert ob._install_method(f"{tmp_path}/.grok/bin/grok") == "script"
    assert ob._install_method(f"{tmp_path}/.local/bin/agy") == "script"


def test_install_method_unknown_is_not_guessed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _home(monkeypatch, tmp_path)
    assert ob._install_method("/usr/bin/claude") == "unknown"
    assert ob._install_method("") == ""


def test_detect_dep_requirements_come_from_the_resolved_install(monkeypatch: pytest.MonkeyPatch) -> None:
    # The platform port moved the foundation deps' Homebrew requirement into
    # install_cmds. `requirements` must follow it, or the wizard stops pulling
    # Homebrew in ahead of node on a Mac that does not have it yet.
    dep = Dep("node", "Node", "", "foundation", ["node", "--version"], r"v?(\d+\.\d+\.\d+)",
              min_version="22.0.0",
              install_cmds={"darwin": PlatformInstall("brew install node", ("brew",))})
    monkeypatch.setattr(ob.osplat, "platform_id", "darwin")
    monkeypatch.setattr(ob.osplat.paths, "resolve_program", lambda _x, *, path=None: None)  # the requirement probe
    _resolves_to(monkeypatch, None)
    r = ob.detect_dep(dep)
    assert r["requirements"] == [{"name": "brew", "ok": False}]


def test_detect_dep_exposes_official_maintenance_commands(monkeypatch: pytest.MonkeyPatch) -> None:
    _resolves_to(monkeypatch, "/usr/local/bin/claude")
    monkeypatch.setattr(ob.subprocess, "run", _fake_run("2.1.219 (Claude Code)"))
    r = ob.detect_dep(ob.DEPS_BY_ID["claude"])
    assert r["update_cmd"] == "claude update"
    assert r["doctor_cmd"] == "claude doctor"
    assert "install_method" in r


def test_registry_carries_update_command_or_docs_for_every_agent_cli() -> None:
    """Every agent CLI must offer an official update path or vendor docs —
    never a Navide-invented command."""
    for dep in ob.DEPS:
        if dep.group != "agent_cli":
            continue
        assert dep.update_cmd or dep.docs_url, dep.id


# ── gate computation ──────────────────────────────────────────────────────────
def _deps(found_ok: bool, cli_ok: bool, ollama_ok: bool) -> list[dict]:
    return [
        {"id": "node", "group": "foundation", "status": "ok" if found_ok else "missing"},
        {"id": "pnpm", "group": "foundation", "status": "ok"},
        {"id": "claude", "group": "agent_cli", "status": "ok" if cli_ok else "missing"},
        {"id": "codex", "group": "agent_cli", "status": "missing"},
        {"id": "ollama", "group": "analyzer", "status": "ok" if ollama_ok else "missing"},
    ]


def test_gate_all_ready() -> None:
    g = ob.compute_gate(_deps(True, True, True), models=["qwen2.5-coder"])
    assert g["all_required_ready"] is True
    assert g["foundation_ready"] and g["has_any_cli"] and g["analyzer_ready"]


def test_gate_blocks_without_cli() -> None:
    g = ob.compute_gate(_deps(True, False, True), models=["m"])
    assert g["has_any_cli"] is False and g["all_required_ready"] is False


def test_gate_analyzer_is_optional() -> None:
    """No model installed → analyzer not ready, but the gate must still open:
    forcing a multi-GB model download to use agent CLIs is not acceptable."""
    g = ob.compute_gate(_deps(True, True, True), models=[])
    assert g["analyzer_ready"] is False and g["all_required_ready"] is True


def test_gate_does_not_require_foundation() -> None:
    """Missing foundation tools must not block first use: the packaged app
    never runs them, and Linux has no in-app install for node/python."""
    g = ob.compute_gate(_deps(False, True, True), models=["m"])
    assert g["foundation_ready"] is False and g["all_required_ready"] is True


# ── install whitelist ─────────────────────────────────────────────────────────
def test_install_unknown_id_rejected() -> None:
    r = ob.install_dep("rm-rf-everything")
    assert r["ok"] is False and "unknown" in r["error"].lower()


@pytest.mark.parametrize("dep_id", ["homebrew", "node"])
def test_install_resolves_the_command_without_running_it(
    monkeypatch: pytest.MonkeyPatch, dep_id: str
) -> None:
    # Interactive (homebrew) or not (node), nothing runs here any more: the
    # command is handed to onboarding.run, which starts it in a visible PTY.
    monkeypatch.setattr(ob.osplat, "platform_id", "darwin")
    # The bootstrap gate asks the seam for each required binary; answer for
    # it so the test is about resolving, not about what this host has.
    monkeypatch.setattr(ob.osplat.paths, "resolve_program", lambda name, *, path=None: f"/usr/bin/{name}")
    def boom(*_a, **_k):
        raise AssertionError("should not run")
    monkeypatch.setattr(ob.subprocess, "run", boom)
    monkeypatch.setattr(ob.subprocess, "Popen", boom)
    r = ob.install_dep(dep_id)
    assert r["ok"] is True
    assert r["command"] == ob.DEPS_BY_ID[dep_id].install_for("darwin").command


def test_python_install_uses_unversioned_formula() -> None:
    # Versioned kegs (python@3.12) only link `python3.12`, never `python3`,
    # so detection (`python3 --version`) would stay missing after a successful
    # install. The unversioned alias links `python3` into the brew prefix.
    assert ob.DEPS_BY_ID["python"].install_for("darwin").command == "brew install python3"


def test_node_install_uses_unversioned_formula() -> None:
    # node@22 is keg-only: it never links `node` into the brew prefix, so
    # detection (`node --version`) would stay missing after a successful install.
    assert ob.DEPS_BY_ID["node"].install_for("darwin").command == "brew install node"


def test_maintenance_command_returns_the_vendor_command(monkeypatch: pytest.MonkeyPatch) -> None:
    ran = []
    monkeypatch.setattr(ob.subprocess, "run", lambda *a, **k: ran.append(a))

    result = ob.maintenance_command("claude", "update")

    assert result == {"ok": True, "needs_terminal": True, "command": "claude update",
                      "docs_url": "https://platform.claude.com/docs/claude-code"}
    assert ran == []  # resolving a command must never execute it


def test_maintenance_command_rejects_unknown_agent_and_action() -> None:
    assert ob.maintenance_command("nope", "update")["ok"] is False
    assert ob.maintenance_command("claude", "rm -rf /")["ok"] is False
    assert ob.maintenance_command("claude", "")["ok"] is False


def _dep_without_update_cmd() -> Dep | None:
    """First agent CLI that ships no official update command.

    Picked dynamically on purpose: naming a vendor here has twice gone stale
    when that vendor later gained an `update_cmd`, silently retiring the
    "Navide never invents a command" invariant this file guards.
    """
    return next(
        (d for d in ob.DEPS if d.group == "agent_cli" and not d.update_cmd),
        None,
    )


def test_maintenance_command_points_at_docs_when_vendor_has_none() -> None:
    dep = _dep_without_update_cmd()
    if dep is None:
        pytest.skip("every agent CLI now ships an update command")
    result = ob.maintenance_command(dep.id, "update")
    assert result["ok"] is False
    assert result["docs_url"] == dep.docs_url
    assert "command" not in result


def test_pull_model_rejects_bad_name() -> None:
    assert ob.pull_model("evil; rm -rf /")["ok"] is False


# ── install: bootstrap gate ──────────────────────────────────────────────────
def test_install_blocked_when_bootstrap_binary_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Fresh Mac without Homebrew: `brew install node` only ever produced a bare
    # exit 127, so the wizard has to name the real blocker instead of running it.
    monkeypatch.setattr(ob.osplat, "platform_id", "darwin")
    monkeypatch.setattr(ob.osplat.paths, "resolve_program", lambda _x, *, path=None: None)

    def boom(*_a: object, **_k: object) -> None:
        raise AssertionError("must not shell out when a requirement is missing")

    monkeypatch.setattr(ob.subprocess, "Popen", boom)
    r = ob.install_dep("node")
    assert r["ok"] is False
    assert r["missing_requirements"] == ["brew"]
    assert "brew" in r["error"]


def test_install_bootstrap_gate_precedes_the_terminal_handoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # claude is needs_terminal: without the gate the app reported success while
    # the terminal it opened just printed "npm: command not found".
    monkeypatch.setattr(ob.osplat.paths, "resolve_program", lambda _x, *, path=None: None)
    r = ob.install_dep("claude")
    assert r["ok"] is False
    assert r["missing_requirements"] == ["npm"]
    assert "needs_terminal" not in r


def test_every_brew_or_npm_install_declares_its_bootstrap_binary() -> None:
    for dep in ob.DEPS:
        if dep.install_cmd.startswith("brew "):
            assert "brew" in dep.requires_binaries, dep.id
        if dep.install_cmd.startswith("npm "):
            assert "npm" in dep.requires_binaries, dep.id


# ── ollama: installed ≠ serving ───────────────────────────────────────────────
def _ollama_list(returncode: int, stdout: str = "", stderr: str = ""):
    def run(*a: object, **_k: object):
        return subprocess.CompletedProcess(a[0] if a else [], returncode, stdout, stderr)
    return run


def test_ollama_status_separates_service_down_from_no_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `ollama list` fails when the daemon is down, which used to be reported
    # identically to "no models installed".
    monkeypatch.setattr(ob.osplat.paths, "resolve_program", lambda _x, *, path=None: "/opt/homebrew/bin/ollama")
    monkeypatch.setattr(
        ob.subprocess, "run", _ollama_list(1, "", "could not connect to ollama app")
    )
    r = ob.detect_ollama_status()
    assert r["reachable"] is False and r["models"] == []
    assert "connect" in r["detail"]


def test_ollama_status_lists_models_when_reachable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.osplat.paths, "resolve_program", lambda _x, *, path=None: "/opt/homebrew/bin/ollama")
    monkeypatch.setattr(
        ob.subprocess, "run", _ollama_list(0, "NAME\tID\nqwen2.5-coder:7b\tabc\n")
    )
    r = ob.detect_ollama_status()
    assert r["reachable"] is True and r["models"] == ["qwen2.5-coder:7b"]


def test_gate_reports_analyzer_blocked_when_service_is_down() -> None:
    deps = [{"id": "ollama", "group": "analyzer", "status": "ok", "optional": False}]
    gate = ob.compute_gate(deps, ["qwen2.5-coder:7b"], False)
    assert gate["ollama_ok"] is True
    assert gate["ollama_service_up"] is False
    assert gate["analyzer_ready"] is False


def test_pull_model_allows_namespaced_names(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.osplat.paths, "resolve_program", lambda _x, *, path=None: "/opt/homebrew/bin/ollama")
    monkeypatch.setattr(ob, "ollama_reachable", lambda: True)
    r = ob.pull_model("hf.co/user/repo:q4")
    assert r["ok"] is True and r["command"].endswith("hf.co/user/repo:q4")


def test_pull_model_rejects_traversal_flags_and_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ob.osplat.paths, "resolve_program", lambda _x, *, path=None: "/opt/homebrew/bin/ollama")
    monkeypatch.setattr(ob, "ollama_reachable", lambda: True)
    assert ob.pull_model("../../etc/passwd")["ok"] is False
    assert ob.pull_model("-rf")["ok"] is False
    assert ob.pull_model("")["ok"] is False


def test_pull_model_blocked_while_the_service_is_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ob.osplat.paths, "resolve_program", lambda _x, *, path=None: "/opt/homebrew/bin/ollama")
    monkeypatch.setattr(ob, "ollama_reachable", lambda: False)
    r = ob.pull_model("qwen2.5-coder:7b")
    assert r["ok"] is False and r["needs_service"] is True


def test_start_ollama_service_hands_back_the_official_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ob.osplat.paths, "resolve_program", lambda name, *, path=None: f"/opt/homebrew/bin/{name}")
    assert ob.start_ollama_service() == {
        "ok": True,
        "needs_terminal": True,
        "command": "brew services start ollama",
    }


def test_start_ollama_service_requires_ollama(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.osplat.paths, "resolve_program", lambda _x, *, path=None: None)
    assert ob.start_ollama_service()["ok"] is False


def test_every_program_lookup_goes_through_the_seam() -> None:
    # `resolve_executable` asked the seam while six sibling checks (install
    # requirements, ollama, brew) still called shutil.which directly. Same
    # question — "is this program on this machine" — so the same answer:
    # on Windows the seam is what knows a bare `npm` is `npm.cmd`, and a
    # presence check that disagrees with the launch that follows it is a
    # wizard that says "installed" and then cannot run the thing.
    source = Path(ob.__file__).read_text(encoding="utf-8")
    assert "shutil.which(" not in source, "ask osplat.paths.resolve_program instead"


def test_local_bin_is_a_path_fallback(tmp_path) -> None:
    # aider / opencode / cursor / kimi install scripts land in ~/.local/bin and
    # export it from a shell rc file the 3s probe can miss.
    from agent_team_backend.osplat import _darwin, _linux

    for paths in (_darwin.paths, _linux.paths):
        assert str(tmp_path / ".local" / "bin") in paths.login_path_fallbacks(tmp_path)


# ── completion flag ───────────────────────────────────────────────────────────
def _patch_flag_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> tuple[Path, Path]:
    """Point both the new and the legacy flag path into tmp_path."""
    flag = tmp_path / "app-data" / "onboarding.json"
    legacy = tmp_path / "legacy" / "onboarding.json"
    monkeypatch.setattr(ob, "_flag_path", lambda: flag)
    monkeypatch.setattr(ob, "_legacy_flag_path", lambda: legacy)
    monkeypatch.delenv("AGENT_TEAM_SKIP_ONBOARDING", raising=False)
    return flag, legacy


def test_complete_flag_roundtrip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    assert ob.is_complete() is False
    ob.set_complete(True)
    assert ob.is_complete() is True


def test_skip_env_forces_complete(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    monkeypatch.setenv("AGENT_TEAM_SKIP_ONBOARDING", "1")
    assert ob.is_complete() is True


def test_legacy_flag_migrated_to_new_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Existing user with only the legacy flag must not see onboarding again."""
    flag, legacy = _patch_flag_paths(monkeypatch, tmp_path)
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text('{"complete": true}', encoding="utf-8")
    assert ob.is_complete() is True
    # First read seeds the stored state, so the legacy file is no longer needed.
    legacy.unlink()
    assert ob.is_complete() is True


def test_legacy_fallback_read_when_copy_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Even if the copy fails, is_complete() falls back to reading the legacy path."""
    _, legacy = _patch_flag_paths(monkeypatch, tmp_path)
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text('{"complete": true}', encoding="utf-8")
    monkeypatch.setattr(ob, "_migrate_legacy_flag", lambda: None)
    assert ob.is_complete() is True


def test_new_flag_wins_over_legacy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A flag already present at the new path is read as-is (no legacy override)."""
    flag, legacy = _patch_flag_paths(monkeypatch, tmp_path)
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text('{"complete": false}', encoding="utf-8")
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text('{"complete": true}', encoding="utf-8")
    assert ob.is_complete() is False


def test_set_complete_writes_new_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    flag, legacy = _patch_flag_paths(monkeypatch, tmp_path)
    ob.set_complete(True)
    # State lands in the app-data database, never in the legacy home file.
    assert (flag.parent / "navide.db").exists()
    assert not legacy.exists()
    assert ob.is_complete() is True


def test_legacy_app_data_json_imported_once_and_retired(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    flag, _legacy = _patch_flag_paths(monkeypatch, tmp_path)
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text(
        '{"complete": true, "dismissed_cli_health": "0123456789abcdef"}',
        encoding="utf-8",
    )
    assert ob.is_complete() is True
    assert ob._dismissed_cli_health_fingerprint() == "0123456789abcdef"
    assert not flag.exists()
    assert flag.with_name(flag.name + ".migrated-v1").exists()
    # Data survives the retired source file.
    assert ob.is_complete() is True


def _exe_name(name: str) -> str:
    """`name` on POSIX; `name.com`/`.exe`/... on Windows, where PATH lookup
    only ever tries the PATHEXT spellings."""
    return ob.osplat.paths.executable_candidates(name)[0]


def _make_executable(path: Path) -> Path:
    if not path.suffix:
        path = path.with_name(_exe_name(path.name))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def _claude_status(path: Path, *, ok: bool = True) -> dict:
    return {
        "id": "claude",
        "status": "ok" if ok else "missing",
        "version": "2.1.210" if ok else "",
        "binary_path": str(path),
        "resolved_path": str(path.resolve()),
        "exit_code": 0 if ok else -9,
        "signal": "" if ok else "SIGKILL",
        "duration_ms": 42,
    }


def test_cli_health_reports_distinct_duplicate_installations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = _make_executable(tmp_path / "nvm" / "claude")
    second = _make_executable(tmp_path / "homebrew" / "claude")
    monkeypatch.setenv("PATH", f"{first.parent}{ob.os.pathsep}{second.parent}")
    monkeypatch.setattr(
        ob,
        "_probe_alternate",
        lambda _dep, _path: {
            "version": "2.1.168", "status": "ok", "exit_code": 0,
            "signal": "", "duration_ms": 10,
        },
    )
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(first)])

    duplicate = next(f for f in health["findings"] if f["type"] == "duplicate_install")
    assert duplicate["agent_key"] == "claude"
    assert [c["version"] for c in duplicate["candidates"]] == ["2.1.210", "2.1.168"]
    assert health["needs_attention"] is True
    assert len(health["fingerprint"]) == 16


def _make_npm_claude_install(prefix: Path) -> tuple[Path, Path, Path]:
    """Create an npm-owned claude install; returns (npm, binary, target)."""
    npm = _make_executable(prefix / "bin" / "npm")
    target = _make_executable(
        prefix / "lib" / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
    )
    binary = prefix / "bin" / _exe_name("claude")
    binary.symlink_to(target)
    return npm, binary, target


def _candidate_entry(path: Path, resolved: Path | None = None) -> dict:
    return {
        "path": str(path),
        "resolved_path": str(resolved if resolved is not None else path),
        "aliases": [str(path)],
    }


def _probe_ok(_dep: object, _path: str) -> dict:
    return {"version": "2.1.214", "status": "ok", "exit_code": 0, "signal": "", "duration_ms": 10}


def _probe_failed(_dep: object, _path: str) -> dict:
    return {"version": "", "status": "failed", "exit_code": 1, "signal": "", "duration_ms": 10}


def test_cli_health_builds_confirmed_npm_removal_for_owned_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    npm, binary, target = _make_npm_claude_install(tmp_path / "node")
    other = _make_executable(tmp_path / "native" / "claude")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
        _candidate_entry(other),
    ])
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary)])
    candidate = health["entries"][0]["candidates"][0]

    assert candidate["install_manager"] == "npm"
    assert str(npm) in candidate["removal_command"]
    assert "uninstall -g @anthropic-ai/claude-code" in candidate["removal_command"]
    assert "Continue? [y/N]" in candidate["removal_command"]


def test_cli_health_removal_command_is_the_terminal_shells_language(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The user runs this in a terminal the app opens, which is PowerShell on
    Windows — where the sh spelling (`read -r`, `case ... esac`) is a syntax
    error before it can ask anything.
    """
    from agent_team_backend import osplat
    from agent_team_backend.osplat import _windows

    _, binary, target = _make_npm_claude_install(tmp_path / "node")
    other = _make_executable(tmp_path / "native" / "claude")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
        _candidate_entry(other),
    ])
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")
    monkeypatch.setattr(osplat, "scripts", _windows.scripts)

    health = ob.build_cli_health([_claude_status(binary)])
    command = health["entries"][0]["candidates"][0]["removal_command"]

    assert command.startswith("Write-Host 'Remove ")
    assert "$a = Read-Host 'Continue? [y/N]'" in command
    assert "if ($a -match '^[Yy]') { & " in command
    assert "uninstall -g @anthropic-ai/claude-code }" in command
    assert "else { Write-Host 'Cancelled.' }" in command
    assert "read -r" not in command


def test_cli_health_never_offers_removal_for_the_only_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, binary, target = _make_npm_claude_install(tmp_path / "node")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
    ])
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary)])
    candidate = health["entries"][0]["candidates"][0]

    assert candidate["removal_command"] == ""
    assert candidate["install_manager"] == ""


def test_cli_health_offers_removal_only_for_the_broken_duplicate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, primary_binary, primary_target = _make_npm_claude_install(tmp_path / "node_a")
    _, broken_binary, broken_target = _make_npm_claude_install(tmp_path / "node_b")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(primary_binary, primary_target),
        _candidate_entry(broken_binary, broken_target),
    ])
    monkeypatch.setattr(ob, "_probe_alternate", _probe_failed)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(primary_binary)])
    candidates = health["entries"][0]["candidates"]
    working = next(c for c in candidates if c["status"] == "ok")
    broken = next(c for c in candidates if c["status"] != "ok")

    assert working["removal_command"] == ""
    assert "uninstall -g @anthropic-ai/claude-code" in broken["removal_command"]


def test_cli_health_allows_removing_a_broken_sole_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, binary, target = _make_npm_claude_install(tmp_path / "node")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
    ])
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary, ok=False)])
    candidate = health["entries"][0]["candidates"][0]

    # Removing a broken install cannot lose a working CLI, so guided removal
    # stays available even without a working backup.
    assert "uninstall -g @anthropic-ai/claude-code" in candidate["removal_command"]


def test_cli_health_blocks_removal_when_backup_is_same_physical_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, binary, target = _make_npm_claude_install(tmp_path / "node")
    wrapper = _make_executable(
        tmp_path / "node" / "lib" / "node_modules" / "@anthropic-ai" / "claude-code" / "cli-wrapper.cjs"
    )
    alias = tmp_path / "node" / "bin" / "claude-alias"
    alias.symlink_to(wrapper)
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
        _candidate_entry(alias, wrapper),
    ])
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary)])
    candidates = health["entries"][0]["candidates"]

    # Both PATH entries live in the same npm prefix: one uninstall removes
    # both, so neither may count the other as a working backup.
    assert [c["removal_command"] for c in candidates] == ["", ""]


def test_cli_health_fingerprint_ignores_removal_gating(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    npm, binary, target = _make_npm_claude_install(tmp_path / "node")
    other = _make_executable(tmp_path / "native" / "claude")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
        _candidate_entry(other),
    ])
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    with_removal = ob.build_cli_health([_claude_status(binary)])
    npm.unlink()  # removal becomes unavailable; probes are unchanged
    without_removal = ob.build_cli_health([_claude_status(binary)])

    assert with_removal["entries"][0]["candidates"][0]["removal_command"] != ""
    assert without_removal["entries"][0]["candidates"][0]["removal_command"] == ""
    assert with_removal["fingerprint"] == without_removal["fingerprint"]


def test_cli_health_collapses_aliases_to_same_physical_binary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = _make_executable(tmp_path / "package" / "claude.exe")
    first = tmp_path / "bin-a" / _exe_name("claude")
    second = tmp_path / "bin-b" / _exe_name("claude")
    first.parent.mkdir()
    second.parent.mkdir()
    first.symlink_to(target)
    second.symlink_to(target)
    monkeypatch.setenv("PATH", f"{first.parent}{ob.os.pathsep}{second.parent}")
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(first)])

    assert health["findings"] == []
    claude = next(entry for entry in health["entries"] if entry["agent_key"] == "claude")
    assert len(claude["candidates"]) == 1
    assert claude["candidates"][0]["aliases"] == [str(first), str(second)]


def test_cli_health_reports_failed_primary_probe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    binary = _make_executable(tmp_path / "bin" / "claude")
    monkeypatch.setenv("PATH", str(binary.parent))
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary, ok=False)])

    failed = next(f for f in health["findings"] if f["type"] == "probe_failed")
    assert failed["primary"]["signal"] == "SIGKILL"
    assert health["needs_attention"] is True


def _probe_primary(
    monkeypatch: pytest.MonkeyPatch, binary: Path, run
) -> dict:
    """detect_dep on the real claude Dep with `binary` as its resolved primary."""
    claude = next(dep for dep in ob.DEPS if dep.id == "claude")
    monkeypatch.setattr(ob, "resolve_executable", lambda _dep, quick=False: str(binary))
    monkeypatch.setattr(ob.subprocess, "run", run)
    return ob.detect_dep(claude)


def _timeout_run(*args, **_kwargs):
    raise subprocess.TimeoutExpired(args[0] if args else [], 8)


def _exit_one_run(*args, **_kwargs):
    return subprocess.CompletedProcess(args[0] if args else [], 1, "", "boom")


def test_cli_health_timed_out_primary_probe_keeps_a_dismissed_guide_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cold-start `--version` timeout is transient: it must not add a
    finding, move the fingerprint, or re-open a guide the user dismissed."""
    first = _make_executable(tmp_path / "nvm" / "claude")
    second = _make_executable(tmp_path / "homebrew" / "claude")
    monkeypatch.setenv("PATH", f"{first.parent}{ob.os.pathsep}{second.parent}")
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_is_that_tool", lambda _dep, _path: True)
    monkeypatch.setattr(ob, "read_update_state", lambda _dep: [])
    dismissed = {"value": ""}
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: dismissed["value"])

    baseline = ob.build_cli_health([_claude_status(first)])
    assert [f["type"] for f in baseline["findings"]] == ["duplicate_install"]
    dismissed["value"] = baseline["fingerprint"]

    timed_out = _probe_primary(monkeypatch, first, _timeout_run)
    assert timed_out["status"] == "ok" and timed_out["probe_timed_out"] is True
    health = ob.build_cli_health([timed_out])

    assert [f["type"] for f in health["findings"]] == ["duplicate_install"]
    assert health["fingerprint"] == baseline["fingerprint"]
    assert health["dismissed"] is True
    assert health["needs_attention"] is False


def test_detect_dep_version_timeout_degrades_instead_of_reporting_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A `--version` that outlives its ceiling found the binary; only the
    grading failed. The spawn probe lets the same timeout through, so calling
    it "not installed" here put the install wizard over a working CLI."""
    binary = _make_executable(tmp_path / "bin" / "claude")
    status = _probe_primary(monkeypatch, binary, _timeout_run)
    assert status["status"] == "ok"
    assert status["version"] == ""
    assert status["binary_path"] == str(binary)
    assert status["probe_timed_out"] is True


def test_detect_dep_exec_error_is_still_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _oserror_run(*_args, **_kwargs):
        raise OSError("exec format error")

    binary = _make_executable(tmp_path / "bin" / "claude")
    status = _probe_primary(monkeypatch, binary, _oserror_run)
    assert status["status"] == "missing"
    assert status["probe_timed_out"] is False


def test_cli_health_definitive_primary_probe_failure_is_still_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A binary that runs and exits non-zero with no version is a persistent
    problem, not a slow start — it still surfaces as probe_failed."""
    binary = _make_executable(tmp_path / "bin" / "claude")
    monkeypatch.setenv("PATH", str(binary.parent))
    monkeypatch.setattr(ob, "read_update_state", lambda _dep: [])
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    status = _probe_primary(monkeypatch, binary, _exit_one_run)
    assert status["probe_timed_out"] is False
    health = ob.build_cli_health([status])

    failed = next(f for f in health["findings"] if f["type"] == "probe_failed")
    assert failed["primary"]["exit_code"] == 1
    assert health["needs_attention"] is True


def test_cli_health_dismissal_is_fingerprint_scoped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    ob.set_complete(True)
    fingerprint = "0123456789abcdef"
    ob.dismiss_cli_health(fingerprint)

    assert ob._dismissed_cli_health_fingerprint() == fingerprint
    assert ob.is_complete() is True

    ob.dismiss_cli_health("invalid")
    assert ob._dismissed_cli_health_fingerprint() == fingerprint


def test_cli_binary_selection_persists_path_without_dismissing_the_guide(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Choosing a binary for one CLI must not silence findings for others:
    the override itself resolves that CLI (see build_cli_health), so nothing
    fingerprint-wide is dismissed on the side."""
    flag, _legacy = _patch_flag_paths(monkeypatch, tmp_path)
    prefix = tmp_path / "node"
    target = _make_executable(
        prefix / "lib" / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
    )
    binary = prefix / "bin" / _exe_name("claude")
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.symlink_to(target)
    monkeypatch.setenv("PATH", str(binary.parent))
    ob.set_complete(True)

    result = ob.select_cli_binary("claude", str(binary))

    assert result == {"ok": True, "agent_key": "claude", "path": str(binary)}
    assert ob.cli_binary_override("claude") == str(binary)
    assert ob._dismissed_cli_health_fingerprint() == ""
    assert ob._read_state() == {
        "complete": True,
        "cli_binary_overrides": {"claude": str(binary)},
    }


def _fail_write(_data: dict) -> None:
    raise OSError("disk full")


def test_state_writes_report_failure_instead_of_swallowing_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    assert ob.set_complete(True) == {"ok": True}
    assert ob.dismiss_cli_health("0123456789abcdef") == {"ok": True}

    monkeypatch.setattr(ob, "_write_state", _fail_write)

    assert ob.set_complete(False) == {"ok": False, "error": "disk full"}
    assert ob.dismiss_cli_health("fedcba9876543210") == {"ok": False, "error": "disk full"}
    assert ob.dismiss_cli_health("invalid") == {"ok": False, "error": "invalid fingerprint"}
    assert ob.is_complete() is True
    assert ob._dismissed_cli_health_fingerprint() == "0123456789abcdef"


async def test_onboarding_write_handlers_answer_ok_false_on_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from types import SimpleNamespace

    from agent_team_backend import ws_handlers

    _patch_flag_paths(monkeypatch, tmp_path)
    monkeypatch.setattr(ob, "_write_state", _fail_write)
    sent: list[dict] = []

    async def send_json(message: dict) -> None:
        sent.append(message)

    session = SimpleNamespace(send_json=send_json)

    await ws_handlers.onboarding_complete(session, "1", "onboarding.complete", {"complete": True})
    await ws_handlers.onboarding_cli_health_dismiss(
        session, "2", "onboarding.cli_health.dismiss", {"fingerprint": "0123456789abcdef"}
    )

    assert [message["payload"] for message in sent] == [
        {"ok": False, "error": "disk full"},
        {"ok": False, "error": "disk full"},
    ]


def _duplicate_claude_installs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, alternate_ok: bool = True
) -> tuple[Path, Path]:
    first = _make_executable(tmp_path / "nvm" / "claude")
    second = _make_executable(tmp_path / "homebrew" / "claude")
    monkeypatch.setenv("PATH", f"{first.parent}{ob.os.pathsep}{second.parent}")
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok if alternate_ok else _probe_failed)
    monkeypatch.setattr(ob, "read_update_state", lambda _dep: [])
    return first, second


def test_cli_health_binary_override_resolves_that_clis_findings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Picking which install Navide launches is the repair for a duplicate
    install — and for a broken primary, since the pick replaces it."""
    _patch_flag_paths(monkeypatch, tmp_path)
    first, second = _duplicate_claude_installs(tmp_path, monkeypatch)
    before = ob.build_cli_health([_claude_status(first, ok=False)])
    assert {f["type"] for f in before["findings"]} == {"probe_failed", "duplicate_install"}

    assert ob.select_cli_binary("claude", str(second))["ok"] is True
    health = ob.build_cli_health([_claude_status(first, ok=False)])

    assert health["findings"] == []
    assert health["fingerprint"] == ""
    assert health["needs_attention"] is False
    # CLI management still lists both installs.
    assert len(health["entries"][0]["candidates"]) == 2


def test_cli_health_override_to_a_broken_install_resolves_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    first, second = _duplicate_claude_installs(tmp_path, monkeypatch, alternate_ok=False)
    assert ob.select_cli_binary("claude", str(second))["ok"] is True

    health = ob.build_cli_health([_claude_status(first)])

    assert [f["type"] for f in health["findings"]] == ["duplicate_install"]
    assert health["needs_attention"] is True


def test_dep_status_reports_the_chosen_binary_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The backend is the only store of the override, so the Settings row
    chip can only learn about it from the status it is sent — the quick
    first paint included."""
    _patch_flag_paths(monkeypatch, tmp_path)
    _first, second = _duplicate_claude_installs(tmp_path, monkeypatch)
    claude = ob.DEPS_BY_ID["claude"]
    assert ob.detect_dep(claude, quick=True)["binary_override"] == ""

    assert ob.select_cli_binary("claude", str(second))["ok"] is True

    assert ob.detect_dep(claude, quick=True)["binary_override"] == str(second)
    quick = next(d for d in ob.quick_status()["deps"] if d["id"] == "claude")
    assert quick["binary_override"] == str(second)
    # Not an agent CLI: never an override.
    assert ob.detect_dep(_NODE, quick=True)["binary_override"] == ""


# ── update state: read back what the CLI itself recorded ─────────────────────
def _write_update_result(home: Path, **fields: object) -> None:
    home.mkdir(parents=True, exist_ok=True)
    record = {"timestamp": "2026-07-25T00:07:12.372Z", "path": "native",
              "outcome": "failed", "status": "install_failed",
              "version_from": "2.1.219", "version_to": None}
    record.update(fields)
    (home / ".last-update-result.json").write_text(json.dumps(record), encoding="utf-8")


def _patch_homes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[Path, Path]:
    """Return (default claude home, profiles root for claude)."""
    _home(monkeypatch, tmp_path)
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    root = tmp_path / ".navide" / "cli-profiles"
    monkeypatch.setattr(ob, "default_profiles_root", lambda: root)
    return tmp_path / ".claude", root / "claude"


def test_read_update_state_covers_default_and_profile_homes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    default_home, profiles = _patch_homes(monkeypatch, tmp_path)
    _write_update_result(default_home, timestamp="2026-07-24T17:37:51.096Z",
                         outcome="success", status="success", version_to="2.1.211")
    _write_update_result(profiles / "4ad13e88")

    records = ob.read_update_state(ob.DEPS_BY_ID["claude"])

    assert [r["scope"] for r in records] == ["profile:4ad13e88", "default"]  # newest first
    assert records[0]["status"] == "install_failed"


def test_read_update_state_ignores_missing_and_corrupt_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    default_home, profiles = _patch_homes(monkeypatch, tmp_path)
    default_home.mkdir(parents=True)
    (default_home / ".last-update-result.json").write_text("{not json", encoding="utf-8")
    (profiles / "empty").mkdir(parents=True)

    assert ob.read_update_state(ob.DEPS_BY_ID["claude"]) == []


def test_read_update_state_is_empty_for_cli_without_state_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_homes(monkeypatch, tmp_path)
    assert ob.read_update_state(ob.DEPS_BY_ID["grok"]) == []


def _claude_health(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, version: str) -> dict:
    binary = _make_executable(tmp_path / "bin" / "claude")
    monkeypatch.setattr(ob, "_distinct_executables", lambda command: (
        [_candidate_entry(binary)] if command == "claude" else []
    ))
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")
    status = _claude_status(binary)
    status["version"] = version
    return ob.build_cli_health([status])


def test_cli_health_surfaces_a_failed_vendor_update(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _default, profiles = _patch_homes(monkeypatch, tmp_path)
    _write_update_result(profiles / "4ad13e88")

    health = _claude_health(monkeypatch, tmp_path, version="2.1.219")

    finding = next(f for f in health["findings"] if f["type"] == "update_failed")
    assert finding["records"][0]["status"] == "install_failed"
    assert finding["records"][0]["scope"] == "profile:4ad13e88"
    assert health["needs_attention"] is True
    entry = next(e for e in health["entries"] if e["agent_key"] == "claude")
    assert entry["update_state"][0]["outcome"] == "failed"


def test_cli_health_ignores_a_failure_the_cli_has_since_moved_past(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _default, profiles = _patch_homes(monkeypatch, tmp_path)
    _write_update_result(profiles / "4ad13e88", version_from="2.1.219")

    health = _claude_health(monkeypatch, tmp_path, version="2.1.230")

    assert [f["type"] for f in health["findings"]] == []
    assert health["needs_attention"] is False


def test_update_failure_does_not_move_the_guide_fingerprint(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The launch guide never shows update_failed (CLI management does), so a
    newer failed auto-update must not change the fingerprint a dismissal is
    keyed by — that re-opened a dismissed guide on the next launch."""
    _default, profiles = _patch_homes(monkeypatch, tmp_path)
    _write_update_result(profiles / "4ad13e88")
    first = _claude_health(monkeypatch, tmp_path, version="2.1.219")["fingerprint"]

    _write_update_result(profiles / "4ad13e88", timestamp="2026-07-26T01:00:00.000Z")
    second = _claude_health(monkeypatch, tmp_path, version="2.1.219")["fingerprint"]

    assert first and first == second


# ── auto-update policy (the vendor's own switch) ─────────────────────────────
def test_autoupdate_defaults_to_vendor_behaviour(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    assert ob.cli_autoupdate_policy("claude") == "vendor"
    assert ob.spawn_env_for("claude") == {}


def test_autoupdate_manual_injects_the_vendor_env_var(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    assert ob.set_cli_autoupdate_policy("claude", "manual")["ok"] is True
    assert ob.cli_autoupdate_policy("claude") == "manual"
    assert ob.spawn_env_for("claude") == {"DISABLE_AUTOUPDATER": "1"}

    ob.set_cli_autoupdate_policy("claude", "vendor")
    assert ob.spawn_env_for("claude") == {}


def test_autoupdate_rejects_agents_without_a_vendor_switch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    assert ob.set_cli_autoupdate_policy("grok", "manual")["ok"] is False
    assert ob.set_cli_autoupdate_policy("claude", "off")["ok"] is False
    assert ob.spawn_env_for("grok") == {}
    assert ob.spawn_env_for("unknown") == {}


def test_cli_health_entries_carry_registry_commands(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Entry commands come from the registry, never from a per-agent hardcode."""
    no_update = _dep_without_update_cmd()
    installed = {"kimi": _make_executable(tmp_path / "bin" / "kimi"),
                 "grok": _make_executable(tmp_path / "bin" / "grok")}
    if no_update is not None:
        cmd = no_update.check_cmd[0]
        installed[cmd] = _make_executable(tmp_path / "bin" / cmd)
    monkeypatch.setattr(ob, "_distinct_executables", lambda command: (
        [_candidate_entry(installed[command])] if command in installed else []
    ))
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    entries = {e["agent_key"]: e for e in ob.build_cli_health([])["entries"]}

    # kimi ships both a doctor and an upgrade subcommand.
    assert entries["kimi"]["diagnostic_command"] == "kimi doctor"
    assert entries["kimi"]["update_command"] == "kimi upgrade"
    assert entries["kimi"]["docs_url"]
    # grok ships an update but no doctor — diagnostics fall back to the probe.
    assert entries["grok"]["update_command"] == "grok update"
    assert entries["grok"]["diagnostic_command"] == "grok --version"
    # A vendor with no official update command gets "" — Navide never invents
    # one (dynamic pick: see _dep_without_update_cmd).
    if no_update is not None:
        assert entries[no_update.id]["update_command"] == ""


def test_cli_health_entries_carry_the_registry_npm_package(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The guide's same-install check needs the package the backend judged by."""
    installed = {"qwen": _make_executable(tmp_path / "bin" / "qwen"),
                 "grok": _make_executable(tmp_path / "bin" / "grok")}
    monkeypatch.setattr(ob, "_distinct_executables", lambda command: (
        [_candidate_entry(installed[command])] if command in installed else []
    ))
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    entries = {e["agent_key"]: e for e in ob.build_cli_health([])["entries"]}

    assert entries["qwen"]["npm_package"] == ob.DEPS_BY_ID["qwen"].npm_package == "@qwen-code/qwen-code"
    assert entries["grok"]["npm_package"] == ""


# ── platform-aware install (Linux port) ───────────────────────────────────────

def test_homebrew_is_not_offered_off_macos() -> None:
    # "Install the macOS package manager" is not a degraded suggestion on
    # Linux, it is a wrong one, so the row should not be listed at all.
    assert ob.DEPS_BY_ID["homebrew"].applies_to("darwin") is True
    assert ob.DEPS_BY_ID["homebrew"].applies_to("linux") is False


def test_linux_uses_each_tool_s_own_installer_not_brew() -> None:
    for dep_id, expected in (
        ("pnpm", "get.pnpm.io"),
        ("uv", "astral.sh"),
        ("ollama", "ollama.com"),
    ):
        command = ob.DEPS_BY_ID[dep_id].install_for("linux").command
        assert expected in command, f"{dep_id}: {command!r}"
        assert "brew" not in command, f"{dep_id} still names brew: {command!r}"


def test_linux_requirements_follow_the_linux_command() -> None:
    # The macOS install of uv needs Homebrew; the Linux one needs curl.
    # Reporting "install brew first" on Linux was the bug this prevents.
    assert ob.DEPS_BY_ID["uv"].install_for("darwin").requires_binaries == ("brew",)
    assert ob.DEPS_BY_ID["uv"].install_for("linux").requires_binaries == ("curl",)


def test_ollama_linux_installer_needs_a_terminal_for_its_sudo_prompt() -> None:
    # Ollama's Linux script calls sudo; run inline the password prompt would
    # be invisible and the install would hang until it timed out.
    assert ob.DEPS_BY_ID["ollama"].install_for("linux").needs_terminal is True
    assert ob.DEPS_BY_ID["ollama"].install_for("darwin").needs_terminal is False


def test_a_platform_with_no_installer_offers_docs_instead_of_a_wrong_command() -> None:
    # Node ships no official Linux script and every distribution's package is
    # a different command, so the honest answer is the docs link.
    node = ob.DEPS_BY_ID["node"]
    assert node.install_for("linux").command == ""
    assert node.docs_url


def test_install_refuses_a_dep_that_does_not_apply_here(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ob.osplat, "platform_id", "linux")
    result = ob.install_dep("homebrew")
    assert result["ok"] is False
    assert "platform" in result["error"]


def test_applicable_deps_hides_only_the_platform_specific_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ob.osplat, "platform_id", "linux")
    ids = {dep.id for dep in ob.applicable_deps()}
    assert "homebrew" not in ids
    assert {"node", "pnpm", "uv", "ollama"} <= ids


def test_the_stuck_credential_message_does_not_name_a_macos_dialog_on_linux(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A credential read stuck for seconds is worth surfacing everywhere, but
    # only macOS has a Keychain dialog to click. On Linux the old wording sent
    # the user looking for a window that does not exist.
    from agent_team_backend import server_link

    link = server_link.ServerLink.__new__(server_link.ServerLink)
    link.terminated_reason = None
    link._authenticated = False
    link.config_read_started = time.time() - 10
    link.last_error = None

    monkeypatch.setattr(server_link.osplat, "platform_id", "linux")
    reason = link.keychain_wait_reason()
    assert reason, "a stuck read must still report something"
    assert "Keychain" not in reason
    assert "macOS" not in reason

    monkeypatch.setattr(server_link.osplat, "platform_id", "darwin")
    assert "Keychain" in link.keychain_wait_reason()
