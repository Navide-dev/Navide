"""Workspace custom display name: project-document truth + recent-list mirror.

The alias lives in the workspace's own project document, so it stays with the
project folder and is independent per project. It is machine-local:
``.agent-team/`` is git-ignored, so an alias is never committed and never
reaches a teammate. The global recent-workspaces store keeps a ``name`` mirror
so the Welcome / sidebar lists can be drawn without opening every project's db.

Covered here: the store write and its round-trip through disk, clearing the
alias with "", stripping, a legacy project.json without the field, the
load_or_create semantics of the rename (it creates the document rather than
swallowing the write) and the failures that do return None, the handler's
honest ``ok`` plus both broadcasts, the mirror's no-op for an unknown path and
its basename back-fill, ``workspace.touch`` re-seeding the mirror in both
directions without creating files, and that the messaging roster payload's
addressing fields were left untouched by this change (the `<folder>/<pane>`
protocol depends on them).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend import agent_messaging, ws_handlers
from agent_team_backend import app as app_module
from agent_team_backend.projects import ProjectStore
from agent_team_backend.recent_workspaces import RecentWorkspacesStore


def _store_with_project(ws: Path) -> ProjectStore:
    store = ProjectStore()
    store.save(store.load_or_create(str(ws)))
    return store


# ── ProjectStore.set_display_name ──────────────────────────────────────────
def test_stores_display_name_and_round_trips_through_disk(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    result = store.set_display_name(str(tmp_path), "Client Portal")
    assert result is not None
    assert result.display_name == "Client Portal"
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.display_name == "Client Portal"
    # load_or_create reads the same document, not a regenerated default.
    assert ProjectStore().load_or_create(str(tmp_path)).display_name == "Client Portal"


def test_empty_string_clears_the_alias(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_display_name(str(tmp_path), "Client Portal")
    result = store.set_display_name(str(tmp_path), "")
    assert result is not None
    assert result.display_name == ""
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.display_name == ""


def test_display_name_is_stripped(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_display_name(str(tmp_path), "  Client Portal \n")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.display_name == "Client Portal"


def test_whitespace_only_clears_the_alias(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_display_name(str(tmp_path), "Client Portal")
    store.set_display_name(str(tmp_path), "   ")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.display_name == ""


def test_a_workspace_without_a_document_gets_one(tmp_path: Path) -> None:
    """load_or_create, not peek: renaming is an explicit user action on a
    workspace they have open, so there must be no silent no-op path that
    answers the rename with a success the user did not get."""
    store = ProjectStore()
    assert not store.project_file(str(tmp_path)).exists()
    result = store.set_display_name(str(tmp_path), "Client Portal")
    assert result is not None
    assert result.display_name == "Client Portal"
    assert store.project_file(str(tmp_path)).exists()
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.display_name == "Client Portal"


def test_empty_workspace_path_fails_and_creates_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """abspath("") is the process cwd — a real directory. Without the guard an
    empty path would create a project document nobody asked for, in whatever
    folder the backend happens to be running from."""
    monkeypatch.chdir(tmp_path)
    store = ProjectStore()
    assert store.set_display_name("", "Client Portal") is None
    assert store.set_display_name("   ", "Client Portal") is None
    assert not store.project_file(str(tmp_path)).exists()
    assert ProjectStore().peek(str(tmp_path)) is None


def test_nonexistent_workspace_returns_none(tmp_path: Path) -> None:
    """A folder that isn't on disk is a real failure, not a silent success."""
    store = ProjectStore()
    missing = tmp_path / "gone"
    assert store.set_display_name(str(missing), "Client Portal") is None
    assert not missing.exists()


def test_legacy_project_json_without_field_defaults_to_empty(tmp_path: Path) -> None:
    """An old document has no display_name key: default "", not a crash."""
    legacy = tmp_path / ".agent-team" / "project.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_text(json.dumps({
        "id": "p1", "name": "x", "workspace_path": str(tmp_path),
        "created_at": "t", "updated_at": "t",
    }), encoding="utf-8")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.display_name == ""
    # And it is writable from there on.
    store = ProjectStore()
    assert store.set_display_name(str(tmp_path), "Renamed") is not None
    reread = ProjectStore().peek(str(tmp_path))
    assert reread is not None
    assert reread.display_name == "Renamed"


def test_alias_may_duplicate_across_workspaces(tmp_path: Path) -> None:
    """The path is the identifier; the alias is cosmetic and may repeat."""
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    _store_with_project(a).set_display_name(str(a), "Same")
    _store_with_project(b).set_display_name(str(b), "Same")
    peeked_a = ProjectStore().peek(str(a))
    peeked_b = ProjectStore().peek(str(b))
    assert peeked_a is not None and peeked_a.display_name == "Same"
    assert peeked_b is not None and peeked_b.display_name == "Same"


# ── RecentWorkspacesStore.set_name (the mirror) ────────────────────────────
def _recent_store(tmp_path: Path) -> RecentWorkspacesStore:
    return RecentWorkspacesStore(path=tmp_path / "recent-workspaces.json")


def test_set_name_updates_an_existing_entry(tmp_path: Path) -> None:
    store = _recent_store(tmp_path)
    ws = tmp_path / "my-project"
    ws.mkdir()
    store.touch(str(ws))
    store.set_name(str(ws), "Client Portal")
    assert [e["name"] for e in store.list()] == ["Client Portal"]


def test_set_name_on_unknown_path_is_a_noop(tmp_path: Path) -> None:
    """Creating an entry here would surface a never-opened workspace."""
    store = _recent_store(tmp_path)
    ws = tmp_path / "never-opened"
    ws.mkdir()
    store.set_name(str(ws), "Ghost")
    assert store.list() == []


def test_set_name_empty_restores_the_basename(tmp_path: Path) -> None:
    store = _recent_store(tmp_path)
    ws = tmp_path / "my-project"
    ws.mkdir()
    store.touch(str(ws))
    store.set_name(str(ws), "Client Portal")
    store.set_name(str(ws), "")
    assert [e["name"] for e in store.list()] == ["my-project"]


def test_set_name_survives_a_later_touch(tmp_path: Path) -> None:
    """touch() only writes `name` when it creates the entry, so the mirrored
    alias must still be there after the workspace is re-opened."""
    store = _recent_store(tmp_path)
    ws = tmp_path / "my-project"
    ws.mkdir()
    store.touch(str(ws))
    store.set_name(str(ws), "Client Portal")
    store.touch(str(ws), state="completed")
    assert [e["name"] for e in store.list()] == ["Client Portal"]


def test_set_name_persists_across_store_instances(tmp_path: Path) -> None:
    store = _recent_store(tmp_path)
    ws = tmp_path / "my-project"
    ws.mkdir()
    store.touch(str(ws))
    store.set_name(str(ws), "Client Portal")
    assert [e["name"] for e in _recent_store(tmp_path).list()] == ["Client Portal"]


# ── project.set_display_name handler ───────────────────────────────────────
class _Session:
    """Minimal stand-in for app.Session — the handler only sends on it."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


@pytest.fixture
def wired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, list[dict]]:
    """Real stores on tmp_path, broadcasts captured."""
    events: list[dict] = []

    async def fake_broadcast(event: dict, **kwargs: object) -> None:
        events.append(event)

    ws = tmp_path / "my-project"
    ws.mkdir()
    recent = RecentWorkspacesStore(path=tmp_path / "recent-workspaces.json")
    recent.touch(str(ws))
    monkeypatch.setattr(app_module, "project_store", ProjectStore(), raising=False)
    monkeypatch.setattr(app_module, "recent_workspaces_store", recent, raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    return ws, events


async def test_handler_persists_mirrors_and_broadcasts_both_events(
    wired: tuple[Path, list[dict]],
) -> None:
    ws, events = wired
    session = _Session()
    await ws_handlers.project_set_display_name(
        session,  # type: ignore[arg-type]
        "1",
        "project.set_display_name",
        {"workspace_path": str(ws), "display_name": "  Client Portal  "},
    )
    assert session.sent[0]["payload"] == {"ok": True, "display_name": "Client Portal"}
    # Truth: the project document.
    stored = ProjectStore().peek(str(ws))
    assert stored is not None and stored.display_name == "Client Portal"
    # Mirror: the recent-list entry.
    assert [e["name"] for e in app_module.recent_workspaces_store.list()] == [
        "Client Portal"
    ]
    # Both broadcasts, in order.
    assert [e["type"] for e in events] == [
        "project.ui_state_changed",
        "workspace.recent_changed",
    ]
    assert events[0]["payload"] == {
        "workspace_path": str(ws),
        "display_name": "Client Portal",
    }
    assert events[1]["payload"]["reason"] == "display_name"
    assert events[1]["payload"]["recent"][0]["name"] == "Client Portal"


async def test_a_written_rename_reaches_the_other_windows_after_the_requester_hangs_up(
    wired: tuple[Path, list[dict]], monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ws_endpoint cancels a closed connection's handler tasks; the rename is
    already being written in a thread by then, so the windows must hear of it
    (0.2.44 p8; leftover-bugs-0243 report-c)."""
    import asyncio
    import threading
    import time

    ws, events = wired
    store = app_module.project_store
    writing = threading.Event()
    real = store.set_display_name

    def slow_set_display_name(*args: object, **kwargs: object) -> object:
        writing.set()
        time.sleep(0.2)
        return real(*args, **kwargs)

    monkeypatch.setattr(store, "set_display_name", slow_set_display_name)
    session = _Session()
    task = asyncio.create_task(ws_handlers.project_set_display_name(
        session, "1", "project.set_display_name",  # type: ignore[arg-type]
        {"workspace_path": str(ws), "display_name": "Client Portal"},
    ))
    while not writing.is_set():
        await asyncio.sleep(0.005)
    task.cancel()  # the requester hung up mid-write
    with pytest.raises(asyncio.CancelledError):
        await task
    for _ in range(200):
        if len(events) == 2:
            break
        await asyncio.sleep(0.01)

    assert [e["type"] for e in events] == ["project.ui_state_changed", "workspace.recent_changed"]
    assert events[0]["payload"]["display_name"] == "Client Portal"
    assert session.sent == []  # nobody left to answer


async def test_handler_clears_the_alias(wired: tuple[Path, list[dict]]) -> None:
    ws, events = wired
    session = _Session()
    await ws_handlers.project_set_display_name(
        session, "1", "project.set_display_name",  # type: ignore[arg-type]
        {"workspace_path": str(ws), "display_name": "Client Portal"},
    )
    await ws_handlers.project_set_display_name(
        session, "2", "project.set_display_name",  # type: ignore[arg-type]
        {"workspace_path": str(ws), "display_name": ""},
    )
    assert session.sent[1]["payload"] == {"ok": True, "display_name": ""}
    stored = ProjectStore().peek(str(ws))
    assert stored is not None and stored.display_name == ""
    # The mirror falls back to the folder basename, not to an empty label.
    assert [e["name"] for e in app_module.recent_workspaces_store.list()] == [
        "my-project"
    ]


async def test_handler_rejects_an_empty_workspace_path_without_broadcasting(
    wired: tuple[Path, list[dict]],
) -> None:
    """No silent success: the frontend shows this error to the user."""
    _, events = wired
    session = _Session()
    await ws_handlers.project_set_display_name(
        session, "1", "project.set_display_name",  # type: ignore[arg-type]
        {"workspace_path": "", "display_name": "Client Portal"},
    )
    payload = session.sent[0]["payload"]
    assert payload["ok"] is False
    assert payload["error"]
    assert events == []


async def test_handler_reports_a_failed_write_without_broadcasting(
    wired: tuple[Path, list[dict]],
) -> None:
    _, events = wired
    session = _Session()
    await ws_handlers.project_set_display_name(
        session, "1", "project.set_display_name",  # type: ignore[arg-type]
        {"workspace_path": "/nonexistent/workspace", "display_name": "X"},
    )
    payload = session.sent[0]["payload"]
    assert payload["ok"] is False
    assert payload["error"]
    assert events == []


async def test_handler_does_not_add_an_unopened_workspace_to_the_recent_list(
    wired: tuple[Path, list[dict]], tmp_path: Path
) -> None:
    """The alias is stored either way, but the mirror stays a mirror: only
    workspaces the user actually opened appear in the recent list."""
    ws, _ = wired
    other = tmp_path / "other-project"
    other.mkdir()
    session = _Session()
    await ws_handlers.project_set_display_name(
        session, "1", "project.set_display_name",  # type: ignore[arg-type]
        {"workspace_path": str(other), "display_name": "Elsewhere"},
    )
    assert session.sent[0]["payload"]["ok"] is True
    stored = ProjectStore().peek(str(other))
    assert stored is not None and stored.display_name == "Elsewhere"
    assert [e["path"] for e in app_module.recent_workspaces_store.list()] == [str(ws)]


async def test_workspace_touch_reseeds_the_mirror_from_the_project_document(
    wired: tuple[Path, list[dict]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The mirror is a cache and can be missing the alias — this touch creates
    the entry fresh, which carries only the folder basename. The project
    document still holds the alias, so opening the workspace has to pick it
    back up from there."""
    ws, _ = wired
    assert ProjectStore().set_display_name(str(ws), "Client Portal") is not None
    # The recent entry is dropped and the workspace reopened.
    app_module.recent_workspaces_store.remove(str(ws))
    session = _Session()
    await ws_handlers.workspace_touch(
        session, "1", "workspace.touch", {"path": str(ws)}  # type: ignore[arg-type]
    )
    assert [e["name"] for e in app_module.recent_workspaces_store.list()] == [
        "Client Portal"
    ]


async def test_workspace_touch_restores_the_basename_when_the_alias_was_cleared(
    wired: tuple[Path, list[dict]],
) -> None:
    """Re-seeding is UNCONDITIONAL, not only-when-non-empty.

    The project document is the truth in both directions: an alias cleared
    there has to push the folder basename back over a mirror that still holds
    the old name. A guard on ``project.display_name`` being truthy made the
    mirror keep a dead alias forever.
    """
    ws, _ = wired
    session = _Session()
    await ws_handlers.project_set_display_name(
        session, "1", "project.set_display_name",  # type: ignore[arg-type]
        {"workspace_path": str(ws), "display_name": "Client Portal"},
    )
    # Cleared in the project document only — the mirror is left stale, which is
    # what a peer window / an out-of-band write leaves behind.
    assert ProjectStore().set_display_name(str(ws), "") is not None
    assert [e["name"] for e in app_module.recent_workspaces_store.list()] == [
        "Client Portal"
    ]
    await ws_handlers.workspace_touch(
        session, "2", "workspace.touch", {"path": str(ws)}  # type: ignore[arg-type]
    )
    assert [e["name"] for e in app_module.recent_workspaces_store.list()] == [
        "my-project"
    ]


async def test_workspace_touch_creates_no_project_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """peek, never load_or_create: merely being touched must not write files
    inside someone's folder."""
    events: list[dict] = []

    async def fake_broadcast(event: dict, **kwargs: object) -> None:
        events.append(event)

    ws = tmp_path / "untouched"
    ws.mkdir()
    store = ProjectStore()
    monkeypatch.setattr(app_module, "project_store", store, raising=False)
    monkeypatch.setattr(
        app_module,
        "recent_workspaces_store",
        RecentWorkspacesStore(path=tmp_path / "recent-workspaces.json"),
        raising=False,
    )
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    session = _Session()
    await ws_handlers.workspace_touch(
        session, "1", "workspace.touch", {"path": str(ws)}  # type: ignore[arg-type]
    )
    assert not store.project_file(str(ws)).exists()
    assert [e["name"] for e in app_module.recent_workspaces_store.list()] == [
        "untouched"
    ]


# ── Messaging roster payload ───────────────────────────────────────────────
def test_registered_pane_payload_keeps_the_addressing_fields_untouched() -> None:
    """A canary over the roster payload the display-name work reads from.

    `workspace_path` was already there; the frontend started USING it as the
    unique group key for mention menus, because a name is not unique and an
    alias may repeat outright. workspace_label / qualified_name carry the
    `<folder>/<pane>` addressing protocol (and MCP cli_list_targets'
    `address`) and stay exactly as they were — this test goes red if anything
    reshapes them, which is the point of keeping it.
    """
    agent_messaging._reset_for_test()
    try:
        entry = agent_messaging.register("p1", "reviewer", "/Users/me/Agent-Team")
        payload = entry.to_dict()
        assert payload["workspace_path"] == "/Users/me/Agent-Team"
        assert payload["workspace_label"] == "Agent-Team"
        assert payload["qualified_name"] == "Agent-Team/reviewer"
        # The enrichment lives in the agent_msg.list handler, not here: the
        # roster payload itself must NOT grow a display name, or the addressing
        # protocol and the presentation detail start sharing a producer.
        assert "workspace_display_name" not in payload
    finally:
        agent_messaging._reset_for_test()


@pytest.fixture
def roster(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A real recent store on tmp_path plus an empty messaging roster."""
    agent_messaging._reset_for_test()
    store = RecentWorkspacesStore(path=tmp_path / "recent-workspaces.json")
    monkeypatch.setattr(app_module, "recent_workspaces_store", store, raising=False)
    yield store
    agent_messaging._reset_for_test()


async def _list_panes() -> list[dict]:
    session = _Session()
    await ws_handlers.agent_msg_list(
        session, "1", "agent_msg.list", {}  # type: ignore[arg-type]
    )
    return session.sent[0]["payload"]["panes"]


async def test_roster_payload_carries_the_alias_from_the_mirror(
    roster: RecentWorkspacesStore, tmp_path: Path
) -> None:
    ws = tmp_path / "api"
    ws.mkdir()
    roster.touch(str(ws))
    roster.set_name(str(ws), "Client Portal")
    agent_messaging.register("p1", "claude-1", str(ws))

    panes = await _list_panes()
    assert len(panes) == 1
    assert panes[0]["workspace_display_name"] == "Client Portal"
    # Enrichment only: the addressing fields are untouched.
    assert panes[0]["workspace_label"] == "api"
    assert panes[0]["qualified_name"] == "api/claude-1"


async def test_roster_payload_omits_the_field_for_a_path_not_in_the_mirror(
    roster: RecentWorkspacesStore, tmp_path: Path
) -> None:
    """No basename filler: the mirror has no entry for this path, so there is
    nothing to report, and the frontend falls back to `workspace_label` on its
    own. (The mirror could not tell "no alias" from "alias equal to the folder
    name" anyway — it stores the basename for both.)"""
    ws = tmp_path / "never-opened"
    ws.mkdir()
    # A DIFFERENT workspace is in the mirror, so the lookup actually runs and
    # misses. With an empty mirror this test passes even for a backend that
    # fills in the basename, because nothing is looked up at all.
    other = tmp_path / "opened-before"
    other.mkdir()
    roster.touch(str(other))
    agent_messaging.register("p1", "claude-1", str(ws))

    panes = await _list_panes()
    assert "workspace_display_name" not in panes[0]
    assert panes[0]["qualified_name"] == "never-opened/claude-1"


async def test_roster_payload_matches_an_unnormalized_roster_path(
    roster: RecentWorkspacesStore, tmp_path: Path
) -> None:
    """Mirror keys are abspath(expanduser(...)); a roster path is whatever the
    window registered. Comparing them raw fails silently — the field simply
    never appears — so both sides go through the store's normalization."""
    ws = tmp_path / "api"
    ws.mkdir()
    roster.touch(str(ws))
    roster.set_name(str(ws), "Client Portal")
    agent_messaging.register("p1", "claude-1", f"{ws}/./")

    panes = await _list_panes()
    assert panes[0]["workspace_display_name"] == "Client Portal"


async def test_roster_payload_skips_the_mirror_read_when_no_pane_is_registered(
    roster: RecentWorkspacesStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every AI dock polls this every few seconds; with no pane to enrich, the
    sqlite read plus an isdir() per recent entry is pure cost."""
    calls: list[int] = []

    def _counting_list() -> list[dict]:
        calls.append(1)
        return []

    monkeypatch.setattr(roster, "list", _counting_list)
    panes = await _list_panes()
    assert panes == []
    assert calls == []


async def test_roster_payload_reports_the_basename_mirror_for_an_unaliased_workspace(
    roster: RecentWorkspacesStore, tmp_path: Path
) -> None:
    """The mirror IS the display name: with no alias set it holds the folder
    basename, and that is what a section header should read."""
    ws = tmp_path / "api"
    ws.mkdir()
    roster.touch(str(ws))
    agent_messaging.register("p1", "claude-1", str(ws))

    panes = await _list_panes()
    assert panes[0]["workspace_display_name"] == "api"
