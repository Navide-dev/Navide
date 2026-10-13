"""plans.changed pipeline: watcher plans channel, app sink broadcast, lazy watch."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, fs_service
from agent_team_backend.git_watcher import GitWatcher, _RepoHandler
from tests.watcher_arming import arm, arming_delay, wait_until  # noqa: F401


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _plan_html(stage: str) -> str:
    meta = {
        "schemaVersion": 1, "name": "T", "overview": "", "stage": stage,
        "approvedAt": None, "todos": [], "reviewNotes": [],
    }
    island = f'<script type="application/json" id="plan-meta">{json.dumps(meta)}</script>'
    return f"<html><head>{island}</head><body>x</body></html>"


# ── _RepoHandler plans channel ───────────────────────────────────────────


def _handlers(root: Path) -> tuple[_RepoHandler, list[str], list[str]]:
    git_hits: list[str] = []
    plans_hits: list[str] = []
    h = _RepoHandler(
        root.resolve(), str(root),
        lambda ws, _paths: git_hits.append(ws),
        plans_hits.append,
    )
    return h, git_hits, plans_hits


class _FakeEvent:
    def __init__(self, src_path: str, event_type: str = "modified", dest_path: str = "") -> None:
        self.src_path = src_path
        self.event_type = event_type
        self.dest_path = dest_path
        self.is_directory = False


def test_plan_doc_event_fires_plans_channel_not_git(tmp_path: Path) -> None:
    h, git_hits, plans_hits = _handlers(tmp_path)
    h.on_any_event(_FakeEvent(str(tmp_path / ".agent-team" / "plans" / "my-plan_ab12cd.html")))
    assert plans_hits == [str(tmp_path)]
    assert git_hits == []  # .agent-team stays excluded from the git channel


def test_plan_infra_hidden_and_history_do_not_fire(tmp_path: Path) -> None:
    h, _git_hits, plans_hits = _handlers(tmp_path)
    plans = tmp_path / ".agent-team" / "plans"
    for p in (
        plans / "_template.html",
        plans / ".hidden.html",
        plans / "my-plan_ab12cd.html.tmp",
        plans / ".history" / "my-plan_ab12cd" / "20260101T000000_draft.html",
        plans / "_template.plan.md",
        plans / ".hidden.plan.md",
        plans / "my-plan_ab12cd.plan.md.tmp",
        plans / ".history" / "my-plan_ab12cd" / "20260101T000000_draft.plan.md",
        tmp_path / ".agent-team" / "runs" / "x.log",
        tmp_path / "src" / "main.py",
    ):
        h.on_any_event(_FakeEvent(str(p)))
    assert plans_hits == []


def test_markdown_plan_doc_event_fires_plans_channel(tmp_path: Path) -> None:
    h, git_hits, plans_hits = _handlers(tmp_path)
    h.on_any_event(_FakeEvent(str(tmp_path / ".agent-team" / "plans" / "my-plan_ab12cd.plan.md")))
    assert plans_hits == [str(tmp_path)]
    assert git_hits == []  # .agent-team stays excluded from the git channel


def test_markdown_atomic_replace_dest_counts_as_plan_event(tmp_path: Path) -> None:
    h, _git_hits, plans_hits = _handlers(tmp_path)
    plans = tmp_path / ".agent-team" / "plans"
    h.on_any_event(_FakeEvent(
        str(plans / "my-plan_ab12cd.plan.md.tmp"),
        event_type="moved",
        dest_path=str(plans / "my-plan_ab12cd.plan.md"),
    ))
    assert plans_hits == [str(tmp_path)]


def test_atomic_replace_dest_path_counts_as_plan_event(tmp_path: Path) -> None:
    """fs_service writes `<plan>.html.tmp` then os.replace — the move event's
    dest_path is the plan document and must fire the plans channel."""
    h, _git_hits, plans_hits = _handlers(tmp_path)
    plans = tmp_path / ".agent-team" / "plans"
    h.on_any_event(_FakeEvent(
        str(plans / "my-plan_ab12cd.html.tmp"),
        event_type="moved",
        dest_path=str(plans / "my-plan_ab12cd.html"),
    ))
    assert plans_hits == [str(tmp_path)]


@pytest.mark.asyncio
async def test_watcher_plan_write_fires_plans_sink_debounced(tmp_path: Path, arming_delay: float) -> None:
    git_fired: list[str] = []
    plans_fired: list[str] = []

    async def git_sink(ws: str, paths: list[tuple[str, str]]) -> None:
        git_fired.append(ws)

    async def plans_sink(ws: str) -> None:
        plans_fired.append(ws)

    watcher = GitWatcher(git_sink, on_plans_change=plans_sink, debounce_s=0.5)
    watcher.start()
    try:
        plans = tmp_path / ".agent-team" / "plans"
        plans.mkdir(parents=True)
        watcher.watch(str(tmp_path))
        # Probes go through the git channel, so the plans channel stays clean.
        await arm(tmp_path, git_fired, per_probe_s=2.0)
        for _ in range(3):
            (plans / "my-plan_ab12cd.html").write_text(_plan_html("draft"), encoding="utf-8")
        assert await wait_until(lambda: plans_fired)
        # Let a further debounce window pass: the burst must not fire twice.
        await asyncio.sleep(1.0)
        assert plans_fired == [str(tmp_path)]
    finally:
        watcher.stop()


# ── app._broadcast_plans_changed ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_broadcast_plans_changed_snapshots_then_notifies(tmp_path: Path) -> None:
    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    (plans / "my-plan_ab12cd.html").write_text(_plan_html("approved"), encoding="utf-8")
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    app._SESSIONS.add(session)
    try:
        await app._broadcast_plans_changed(str(tmp_path))
        await asyncio.sleep(0)
        snaps = list((plans / ".history" / "my-plan_ab12cd").glob("*_approved.html"))
        assert len(snaps) == 1
        events = [m for m in session.websocket.sent if m.get("type") == "plans.changed"]  # type: ignore[attr-defined]
        assert len(events) == 1
        assert events[0]["payload"] == {"workspace_path": str(tmp_path)}
    finally:
        app._SESSIONS.discard(session)


# ── lazy watch on plans fs access ────────────────────────────────────────


class _WatcherStub:
    def __init__(self) -> None:
        self.watched: list[str] = []

    def watch(self, ws_path: str) -> None:
        self.watched.append(ws_path)


@pytest.mark.asyncio
async def test_fs_list_dir_on_plans_starts_watching(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub = _WatcherStub()
    monkeypatch.setattr(app, "_git_watcher", stub)
    (tmp_path / ".agent-team" / "plans").mkdir(parents=True)
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]

    await app.handle_message(session, {
        "id": "l1", "type": "fs.list_dir",
        "payload": {"workspace_path": str(tmp_path), "rel_path": ".agent-team/plans"},
    })
    assert stub.watched == [str(tmp_path)]

    await app.handle_message(session, {
        "id": "l2", "type": "fs.list_dir",
        "payload": {"workspace_path": str(tmp_path), "rel_path": ""},
    })
    assert stub.watched == [str(tmp_path)]  # non-plans access does not watch


# ── .history stays out of listings ───────────────────────────────────────


def test_list_dir_hides_history_by_default(tmp_path: Path) -> None:
    plans = tmp_path / ".agent-team" / "plans"
    (plans / ".history" / "my-plan_ab12cd").mkdir(parents=True)
    (plans / "my-plan_ab12cd.html").write_text(_plan_html("draft"), encoding="utf-8")

    result = fs_service.list_dir(str(tmp_path), ".agent-team/plans")
    names = [e["name"] for e in result["entries"]]
    assert "my-plan_ab12cd.html" in names
    assert ".history" not in names

    # PlansPane lists with show_hidden=True but drops directories itself;
    # .history must come back flagged as a dir for that filter to hold.
    shown = fs_service.list_dir(str(tmp_path), ".agent-team/plans", show_hidden=True)
    hist = [e for e in shown["entries"] if e["name"] == ".history"]
    assert len(hist) == 1 and hist[0]["is_dir"] is True
