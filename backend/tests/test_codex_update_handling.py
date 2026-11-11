"""Codex's startup update menu: Navide's side of it.

- The vendor's own check is switched off per launch with `-c` arguments
  (Dep.autoupdate_args), defaulting to on for codex and switchable back.
- "Update available" comes from codex's own version.json plus the npm
  registry, faked here: no test reaches the network or runs a real install.
- The one-click update is gated: one per machine, every codex pane idle.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio

from agent_team_backend import agent_messaging, app, ws_handlers
from agent_team_backend import onboarding_deps as ob
from tests.test_spawn_env_request import _create, _quiet_spawn, _session  # noqa: F401

_REAL_NPM_QUERY = ob._npm_query
CODEX_ARGS = ["-c", "check_for_update_on_startup=false"]


def _patch_state(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ob, "_flag_path", lambda: tmp_path / "app-data" / "onboarding.json")
    monkeypatch.setattr(ob, "_legacy_flag_path", lambda: tmp_path / "legacy" / "onboarding.json")


# ── autoupdate_args (the launch-argument switch) ──────────────────────────────
def test_codex_declares_the_launch_argument_switch() -> None:
    dep = ob.DEPS_BY_ID["codex"]
    assert list(dep.autoupdate_args) == CODEX_ARGS
    assert dep.autoupdate_env == ""


def test_codex_defaults_to_navide_managed_updates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_state(monkeypatch, tmp_path)
    assert ob.cli_autoupdate_policy("codex") == "manual"
    assert ob.spawn_args_for("codex") == CODEX_ARGS
    # An env-switched CLI keeps its old default.
    assert ob.cli_autoupdate_policy("claude") == "vendor"
    assert ob.spawn_args_for("claude") == []


def test_codex_can_be_switched_back_to_asking_itself(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_state(monkeypatch, tmp_path)
    assert ob.set_cli_autoupdate_policy("codex", "vendor")["ok"] is True
    assert ob.cli_autoupdate_policy("codex") == "vendor"
    assert ob.spawn_args_for("codex") == []
    assert ob.spawn_env_for("codex") == {}

    assert ob.set_cli_autoupdate_policy("codex", "manual")["ok"] is True
    assert ob.spawn_args_for("codex") == CODEX_ARGS


def test_spawn_args_for_unknown_or_unswitched_agents_is_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_state(monkeypatch, tmp_path)
    assert ob.spawn_args_for("grok") == []
    assert ob.spawn_args_for("nope") == []
    assert ob.set_cli_autoupdate_policy("grok", "manual")["ok"] is False


@pytest.mark.asyncio
async def test_spawn_appends_the_arguments_to_the_command(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app.onboarding_deps, "spawn_args_for", lambda key: CODEX_ARGS if key == "claude" else [])
    session = _session()

    await _create(session, {})

    command = session.terminals.created[0]["command"]  # type: ignore[attr-defined]
    assert command[-1].endswith(" -c check_for_update_on_startup=false")


@pytest.mark.asyncio
async def test_spawn_leaves_the_command_alone_without_arguments(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app.onboarding_deps, "spawn_args_for", lambda _key: [])
    session = _session()

    await _create(session, {})

    command = session.terminals.created[0]["command"]  # type: ignore[attr-defined]
    assert "check_for_update_on_startup" not in " ".join(command)


# ── "update available" ────────────────────────────────────────────────────────
def _codex_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, latest: str | None) -> Path:
    home = tmp_path / "codex-home"
    home.mkdir()
    monkeypatch.setenv("CODEX_HOME", str(home))
    monkeypatch.setattr(ob, "default_profiles_root", lambda: tmp_path / "profiles")
    if latest is not None:
        (home / "version.json").write_text(json.dumps({
            "latest_version": latest, "last_checked_at": "2026-11-12T00:00:00Z", "dismissed_version": None,
        }), encoding="utf-8")
    return home


def test_update_available_reads_codex_version_json(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _codex_home(monkeypatch, tmp_path, "0.167.1")
    dep = ob.DEPS_BY_ID["codex"]
    assert ob._update_available(dep, "0.166.0") == "0.167.1"
    assert ob._update_available(dep, "0.167.1") == ""
    assert ob._update_available(dep, "0.168.0") == ""
    assert ob._update_available(dep, "") == ""


@pytest.fixture(autouse=True)
def _no_registry(monkeypatch: pytest.MonkeyPatch):
    """No test here reaches the npm registry; the lookup tests use a shim."""
    monkeypatch.setattr(ob, "_npm_query", lambda _package: "")
    ob._NPM_LATEST.clear()
    yield
    ob._NPM_LATEST.clear()


def test_update_available_takes_the_newer_of_cache_and_registry(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _codex_home(monkeypatch, tmp_path, "0.167.0")
    monkeypatch.setattr(ob, "_npm_query", lambda package: "0.167.1" if package == "@openai/codex" else "")
    dep = ob.DEPS_BY_ID["codex"]
    # The dependency probe never asks the registry itself...
    assert ob._update_available(dep, "0.166.0") == "0.167.0"
    # ...update_notices does, and the probe then reads that answer.
    assert ob._update_available(dep, "0.166.0", query_registry=True) == "0.167.1"
    assert ob._update_available(dep, "0.166.0") == "0.167.1"


def test_update_notices_lists_only_clis_with_a_newer_release(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _codex_home(monkeypatch, tmp_path, None)
    monkeypatch.setattr(ob, "_npm_query", lambda _package: "0.167.1")
    versions = {"codex": "0.166.0"}
    monkeypatch.setattr(ob, "detect_dep", lambda dep, quick=False: {"version": versions.get(dep.id, "")})
    assert ob.update_notices() == {"codex": {"version": "0.166.0", "latest_version": "0.167.1"}}
    versions["codex"] = "0.167.1"
    assert ob.update_notices() == {}


def test_update_available_ignores_a_malformed_cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    home = _codex_home(monkeypatch, tmp_path, None)
    (home / "version.json").write_text("{not json", encoding="utf-8")
    assert ob._update_available(ob.DEPS_BY_ID["codex"], "0.166.0") == ""
    (home / "version.json").write_text(json.dumps({"latest_version": "latest"}), encoding="utf-8")
    assert ob._update_available(ob.DEPS_BY_ID["codex"], "0.166.0") == ""


def test_update_available_is_only_for_deps_that_declare_a_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob, "_npm_query", lambda _package: "99.0.0")
    assert ob._update_available(ob.DEPS_BY_ID["claude"], "1.0.0") == ""


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell shim")
def test_npm_query_runs_npm_view_against_a_fake_npm(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """The real lookup, against a shim that records its arguments."""
    shim = tmp_path / "bin"
    shim.mkdir()
    log = tmp_path / "npm-calls.log"
    npm = shim / "npm"
    npm.write_text(f'#!/bin/sh\necho "$*" >> "{log}"\necho 0.167.1\n', encoding="utf-8")
    npm.chmod(npm.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{shim}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setattr(ob, "_npm_query", _REAL_NPM_QUERY)

    assert ob._npm_latest("@openai/codex") == "0.167.1"
    assert ob._npm_latest("@openai/codex") == "0.167.1"  # cached
    assert log.read_text(encoding="utf-8").splitlines() == ["view @openai/codex version"]


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell shim")
def test_npm_query_rejects_output_that_is_not_a_version(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    shim = tmp_path / "bin"
    shim.mkdir()
    npm = shim / "npm"
    npm.write_text("#!/bin/sh\necho 'npm ERR! offline'\nexit 1\n", encoding="utf-8")
    npm.chmod(npm.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{shim}{os.pathsep}{os.environ.get('PATH', '')}")
    assert _REAL_NPM_QUERY("@openai/codex") == ""


# ── the update gate ───────────────────────────────────────────────────────────
@pytest.fixture
def registry():
    agent_messaging._reset_for_test()
    ws_handlers._GATED_UPDATE_RUN.clear()
    yield
    agent_messaging._reset_for_test()
    ws_handlers._GATED_UPDATE_RUN.clear()


def _pane(pane_id: str, agent_key: str, *, busy: bool = False, status: str = "idle") -> None:
    agent_messaging.register(pane_id, pane_id, "/ws", agent_key=agent_key)
    agent_messaging.set_busy(pane_id, busy, status)


def test_gate_is_open_when_every_codex_pane_is_idle(registry: None) -> None:
    _pane("codex-a", "codex")
    _pane("codex-b", "codex", status="exited")
    _pane("claude-a", "claude", busy=True, status="running")
    assert ws_handlers._update_gate("codex") == {"blocked": False, "reason": "", "busy_panes": []}


@pytest.mark.parametrize("busy,status", [(True, "idle"), (False, "running"), (False, "starting"), (False, "awaiting")])
def test_gate_closes_while_a_codex_pane_is_not_idle(registry: None, busy: bool, status: str) -> None:
    _pane("codex-a", "codex")
    _pane("codex-b", "codex", busy=busy, status=status)
    gate = ws_handlers._update_gate("codex")
    assert gate["blocked"] is True
    assert gate["reason"] == "panes-busy"
    assert gate["busy_panes"] == ["codex-b"]


def test_gate_closes_while_another_gated_update_runs(registry: None) -> None:
    owner = SimpleNamespace(terminals={"run-1": SimpleNamespace(closed=False)})
    ws_handlers._GATED_UPDATE_RUN[:] = [(owner, "run-1")]  # type: ignore[list-item]
    assert ws_handlers._update_gate("codex")["reason"] == "update-running"

    owner.terminals["run-1"].closed = True
    assert ws_handlers._update_gate("codex")["blocked"] is False
    assert ws_handlers._GATED_UPDATE_RUN == []


class _RunTerminals:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.terms: dict[str, SimpleNamespace] = {}

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        term = SimpleNamespace(id=f"run-{len(self.created)}", closed=False)
        self.terms[term.id] = term
        return term

    def get(self, tid: str) -> SimpleNamespace | None:
        return self.terms.get(tid)


async def _run_update(session: app.Session, agent_key: str = "codex") -> dict[str, Any]:
    await app.handle_message(session, {
        "id": "u1", "type": "onboarding.run",
        "payload": {"kind": "maintenance", "agent_key": agent_key, "action": "update"},
    })
    return session.websocket.sent[-1]["payload"]  # type: ignore[attr-defined]


@pytest_asyncio.fixture
async def run_session(monkeypatch: pytest.MonkeyPatch, registry: None):
    # Never resolve (or run) a real binary: the command is only recorded.
    monkeypatch.setattr(app.onboarding_deps, "resolve_run", lambda request: {
        "ok": True, "needs_terminal": True, "command": f"{request.get('agent_key')} update",
    })
    session = _session()
    session.terminals = _RunTerminals()  # type: ignore[assignment]
    yield session
    for term_id in list(session.terminals.terms):  # type: ignore[attr-defined]
        app._PTY_OWNERS.pop(term_id, None)


@pytest.mark.asyncio
async def test_update_is_refused_while_a_codex_pane_works(run_session: app.Session) -> None:
    _pane("codex-a", "codex", busy=True, status="running")
    reply = await _run_update(run_session)
    assert reply["ok"] is False
    assert reply["gate"]["reason"] == "panes-busy"
    assert reply["gate"]["busy_panes"] == ["codex-a"]
    assert run_session.terminals.created == []  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_only_one_gated_update_runs_at_a_time(run_session: app.Session) -> None:
    _pane("codex-a", "codex")
    first = await _run_update(run_session)
    assert first["ok"] is True and first["run_id"] == "run-1"

    second = await _run_update(run_session)
    assert second["ok"] is False
    assert second["gate"]["reason"] == "update-running"
    assert len(run_session.terminals.created) == 1  # type: ignore[attr-defined]

    run_session.terminals.terms["run-1"].closed = True  # type: ignore[attr-defined]
    third = await _run_update(run_session)
    assert third["ok"] is True


@pytest.mark.asyncio
async def test_an_ungated_update_is_unaffected(run_session: app.Session) -> None:
    _pane("claude-a", "claude", busy=True, status="running")
    reply = await _run_update(run_session, "claude")
    assert reply["ok"] is True


@pytest.mark.asyncio
async def test_update_gate_handler_reports_the_gate(registry: None) -> None:
    _pane("codex-a", "codex", status="awaiting")
    session = _session()
    await app.handle_message(session, {"id": "g1", "type": "onboarding.update_gate", "payload": {"agent_key": "codex"}})
    reply = session.websocket.sent[-1]["payload"]  # type: ignore[attr-defined]
    assert reply == {"ok": True, "blocked": True, "reason": "panes-busy", "busy_panes": ["codex-a"]}
