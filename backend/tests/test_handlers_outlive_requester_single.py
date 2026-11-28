"""Handlers that write in a thread and then broadcast finish both when the
requester hangs up mid-write (0.2.45 broadcast-decoupling report, item 1).

A thread cannot be cancelled: ws_endpoint cancelling a closed connection's
handler task while it awaits the write leaves the write landing with nothing
after it, so every other window keeps the old state. Each case cancels its
handler during the first thread write and checks that the broadcast which
follows the write still goes out.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers


class _Session:
    def __init__(self) -> None:
        self.sent: list = []
        self._handler_tasks: set = set()
        self.terminals = _Terminals()

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


class _Terminals:
    """Enough of TerminalService for the kill paths: one panel PTY, P1."""

    def __init__(self) -> None:
        self._sessions = {"t1": SimpleNamespace(id="t1", pane_id="P1", metadata={})}

    def live_ids_for_surface(self, surface: str, workspace_path: str) -> list:
        return [("t1", "P1", "")]

    async def kill(self, *_a: Any, **_k: Any) -> None:
        return None


Setup = Callable[[pytest.MonkeyPatch, Path], dict]


def _ws(tmp_path: Path) -> str:
    ws = tmp_path / "ws"
    ws.mkdir(exist_ok=True)
    return str(ws)


def _recent(tmp_path: Path) -> str:
    ws = _ws(tmp_path)
    app_module.recent_workspaces_store.touch(ws)
    return ws


def _project(tmp_path: Path) -> str:
    ws = _ws(tmp_path)
    app_module.project_store.load_or_create(ws)
    return ws


def _previewed(tmp_path: Path) -> str:
    ws = _ws(tmp_path)
    app_module.preview_log.append(ws, change="created", rel_path="a.md", source="user")
    return ws


def _stub(monkeypatch: pytest.MonkeyPatch, target: Any, name: str, result: Any) -> None:
    monkeypatch.setattr(target, name, lambda *_a, **_k: result)


def _trust(monkeypatch: pytest.MonkeyPatch, name: str, result: Any) -> None:
    from agent_team_backend import confirm_token, trust_store

    monkeypatch.setattr(confirm_token, "check", lambda *_a, **_k: "")
    _stub(monkeypatch, trust_store, name, result)


def _link(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import server_link

    async def nothing(*_a: Any, **_k: Any) -> Any:
        return {}

    for name in ("start", "stop", "reconfigure", "status", "logout_on_server", "revoke_pairing"):
        if hasattr(server_link, name):
            monkeypatch.setattr(server_link, name, nothing)
    _stub(monkeypatch, server_link, "replace_access_token", None)


def _blockable(monkeypatch: pytest.MonkeyPatch) -> None:
    """The server-side policy write succeeds and the device had a pending
    access request, which the block then withdraws and announces."""
    from agent_team_backend import server_link

    async def written(*_a: Any, **_k: Any) -> bool:
        return False

    async def policy(*_a: Any, **_k: Any) -> dict:
        return {}

    monkeypatch.setattr(ws_handlers, "_write_policy", written)
    monkeypatch.setattr(ws_handlers, "_policy_payload", policy)
    _stub(monkeypatch, server_link, "forget_access_requests_for_device", True)
    _stub(monkeypatch, server_link, "access_requests", [])


def _pane_gone(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict:
    """dev_time_store has an open interval for P1 in the workspace."""
    ws = _ws(tmp_path)
    _stub(monkeypatch, app_module.dev_time_store, "pane_removed", [ws])
    return {"terminal_session_id": "t1", "surface": "plans", "workspace_path": ""}


def _mirror(tmp_path: Path) -> Any:
    return SimpleNamespace(workspace_path=_ws(tmp_path), ui_spawn_history=[{"paneId": "P1"}])


def _history(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, **payload: Any) -> dict:
    mirror = _mirror(tmp_path)
    _stub(monkeypatch, app_module.project_store, "peek", mirror)
    _stub(monkeypatch, app_module.spawn_history_store, "patch_entry", True)
    for name in ("rename_history_entry", "star_history_entry", "rename_pane"):
        _stub(monkeypatch, app_module.project_store, name, mirror)
    _stub(monkeypatch, app_module.project_store, "set_pane_auto_name", (mirror, True))
    _stub(monkeypatch, app_module.project_store, "set_ui_state", mirror)
    _stub(monkeypatch, app_module.spawn_history_store, "delete_entries", SimpleNamespace(deleted_ids=["P1"]))
    return {"workspace_path": mirror.workspace_path, "pane_id": "P1", **payload}


def _quota(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict:
    _stub(monkeypatch, app_module.pane_account_history, "profile_at", "profile-1")
    _stub(monkeypatch, app_module.quota_ledger, "mark_exhausted", ["five_hour"])
    return {"agent_key": "claude", "pane_id": "P1", "at": "2026-11-19T09:00:00Z"}


def _convenience(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict:
    from agent_team_backend import convenience_wiring

    _stub(monkeypatch, convenience_wiring, "set_feature", None)
    _stub(monkeypatch, app_module.convenience_gate, "listing_feature", {})
    return {"id": "feature-1", "allowed": True}


def _n8n(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict:
    from agent_team_backend.mcp_server import server as plan_mcp

    async def no_nodes() -> dict:
        return {}

    monkeypatch.setattr(plan_mcp, "host_plugin_pipeline_nodes", no_nodes)
    import agent_team_backend.n8n_import as n8n_import

    _stub(monkeypatch, n8n_import, "import_into_store", {})
    return {"json": "{}", "dry_run": False}


def _role(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict:
    app_module.roles_store.upsert(key="tmp-role", label="T", one_line="", system_prompt="x")
    return {"key": "tmp-role"}


def _pipeline(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict:
    pid = app_module.stages_store.create_pipeline("Tmp")["id"]
    return {"pipeline_id": pid, "name": "Renamed"}


CASES: list[tuple[str, Setup]] = [
    ("sync.set_scope", lambda mp, tp: (
        _stub(mp, __import__("agent_team_backend.sync_scopes", fromlist=["x"]), "set_scope_enabled", {"prompts": True}),
        {"scope": "prompts", "enabled": True})[1]),
    ("workspace.touch", lambda mp, tp: {"path": _ws(tp)}),
    ("workspace.set_recent_limit", lambda mp, tp: {"limit": 7}),
    ("workspace.pin", lambda mp, tp: {"path": _recent(tp)}),
    ("workspace.unpin", lambda mp, tp: {"path": _recent(tp)}),
    ("workspace.remove", lambda mp, tp: {"path": _recent(tp)}),
    ("p2p.link.set_paused", lambda mp, tp: (_link(mp), {"paused": True})[1]),
    ("p2p.link.configure", lambda mp, tp: (_link(mp), {"token": ""})[1]),
    ("p2p.account.logout", lambda mp, tp: (_link(mp), {})[1]),
    ("p2p.trust.device.defer", lambda mp, tp: (_trust(mp, "defer_device", True), {"deviceId": "d1"})[1]),
    ("p2p.trust.device.unpair", lambda mp, tp: (_link(mp), _trust(mp, "forget_device", {"found": True}), {"deviceId": "d1"})[2]),
    ("p2p.trust.rebuild", lambda mp, tp: (_link(mp), _trust(mp, "rebuild_locked_store", {}), {})[2]),
    ("p2p.trust.block", lambda mp, tp: (_trust(mp, "note_blocked", None), _blockable(mp), {"deviceId": "d1"})[2]),
    ("roles.upsert", lambda mp, tp: {"key": "tmp-role", "label": "T", "system_prompt": "x"}),
    ("roles.delete", _role),
    ("pipelines.create", lambda mp, tp: {"name": "New"}),
    ("pipelines.rename", _pipeline),
    ("pipelines.delete", _pipeline),
    ("pipelines.set_active", _pipeline),
    ("analyzer.settings.set", lambda mp, tp: {}),
    ("archive.settings.set", lambda mp, tp: {}),
    ("tokens.reset", lambda mp, tp: {"workspace_path": _ws(tp), "scope": "global"}),
    ("devtime.reset", lambda mp, tp: {"workspace_path": _ws(tp)}),
    ("project.set_ui_state", lambda mp, tp: {"workspace_path": _project(tp), "active_tab": "git"}),
    ("pipeline.node_states", lambda mp, tp: {"workspace_path": _ws(tp), "nodes": {}}),
    ("preview.log_append", lambda mp, tp: {"workspace_path": _ws(tp), "change": "created", "rel_path": "a.md"}),
    ("preview.log_clear", lambda mp, tp: {"workspace_path": _previewed(tp)}),
    ("convenience.upgrade_ack", lambda mp, tp: {}),
    ("convenience.set", _convenience),
    ("pipelines.import_n8n", _n8n),
    ("tokens.quota_exhausted", _quota),
    ("terminal.kill", _pane_gone),
    ("terminal.kill_surface", _pane_gone),
    ("project.rename_pane", lambda mp, tp: _history(mp, tp, custom_name="New")),
    ("project.set_pane_auto_name", lambda mp, tp: _history(mp, tp, auto_name="Auto")),
    ("project.rename_spawn_history", lambda mp, tp: _history(mp, tp, custom_name="New")),
    ("project.star_spawn_history", lambda mp, tp: _history(mp, tp, starred=True)),
    ("project.delete_spawn_history", lambda mp, tp: _history(mp, tp, mode="ids", pane_ids=["P1"])),
]


@pytest.fixture
def told() -> asyncio.Event:
    """Set by the first broadcast."""
    return asyncio.Event()


@pytest.fixture
def broadcasts(monkeypatch: pytest.MonkeyPatch, told: asyncio.Event) -> list[dict]:
    events: list[dict] = []

    async def capture(event: Any, *_a: Any, **_k: Any) -> None:
        events.append(event if isinstance(event, dict) else {"type": "tokens"})
        told.set()

    for name in ("broadcast", "broadcast_main_windows", "broadcast_tokens_changed"):
        monkeypatch.setattr(app_module, name, capture)
    return events


@pytest.fixture
def slow_first_write(monkeypatch: pytest.MonkeyPatch) -> asyncio.Event:
    """The first thread write a handler awaits takes a while, as a disk write
    may; that is when the requester hangs up."""
    started = asyncio.Event()
    real_db, real_vault, real_thread = (
        ws_handlers.run_in_db_thread, ws_handlers.vault_to_thread, asyncio.to_thread,
    )

    def slowed(real: Any) -> Any:
        async def run(fn: Any, *args: Any, **kwargs: Any) -> Any:
            if not started.is_set():
                started.set()
                await asyncio.sleep(0.05)
            return await real(fn, *args, **kwargs)
        return run

    monkeypatch.setattr(ws_handlers, "run_in_db_thread", slowed(real_db))
    monkeypatch.setattr(ws_handlers, "vault_to_thread", slowed(real_vault))
    monkeypatch.setattr(asyncio, "to_thread", slowed(real_thread))
    return started


def _handler_for(msg_type: str) -> Any:
    fn = ws_handlers.lookup(msg_type)
    assert fn is not None, msg_type
    return fn


@pytest.mark.parametrize("msg_type,setup", CASES, ids=[c[0] for c in CASES])
async def test_the_broadcast_after_a_write_survives_a_hang_up(
    msg_type: str, setup: Setup, broadcasts: list, told: asyncio.Event,
    slow_first_write: asyncio.Event, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    payload = setup(monkeypatch, tmp_path)
    # Answered in full when nobody hangs up: the case really reaches its broadcast.
    session = _Session()
    task = asyncio.create_task(_handler_for(msg_type)(session, "1", msg_type, payload))
    await asyncio.wait_for(slow_first_write.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # The broadcast follows a commit on the single db-writes thread, whose fsync
    # can take seconds on a slow disk (a Windows runner missed a ~3s budget), so
    # wait for the broadcast itself; the timeout only bounds a real miss.
    try:
        await asyncio.wait_for(told.wait(), timeout=60)
    except TimeoutError:
        pytest.fail(f"{msg_type}: the write landed but no window was told")
