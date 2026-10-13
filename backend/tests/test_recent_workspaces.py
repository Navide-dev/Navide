"""RecentWorkspacesStore persistence + capping/pin tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.recent_workspaces import RecentWorkspacesStore


@pytest.fixture
def store(tmp_path: Path) -> RecentWorkspacesStore:
    return RecentWorkspacesStore(path=tmp_path / "recent-workspaces.json")


def _mkdir(tmp_path: Path, name: str) -> str:
    d = tmp_path / name
    d.mkdir()
    return str(d)


def test_touch_adds_entry_to_front(store: RecentWorkspacesStore, tmp_path: Path) -> None:
    a = _mkdir(tmp_path, "a")
    b = _mkdir(tmp_path, "b")
    store.touch(a, state="spawn", task="t-a")
    store.touch(b, state="completed", task="t-b")
    recent = store.list()
    assert [e["name"] for e in recent] == ["b", "a"]
    assert recent[0]["last_known_state"] == "completed"
    assert recent[0]["last_known_task"] == "t-b"


def test_touch_existing_moves_to_front_and_updates(store: RecentWorkspacesStore, tmp_path: Path) -> None:
    a = _mkdir(tmp_path, "a")
    b = _mkdir(tmp_path, "b")
    store.touch(a, state="spawn", task="old")
    store.touch(b)
    store.touch(a, state="completed", task="new")
    recent = store.list()
    assert [e["name"] for e in recent] == ["a", "b"]
    assert recent[0]["last_known_state"] == "completed"
    assert recent[0]["last_known_task"] == "new"


def test_touch_does_not_duplicate(store: RecentWorkspacesStore, tmp_path: Path) -> None:
    a = _mkdir(tmp_path, "a")
    store.touch(a)
    store.touch(a)
    assert len(store.list()) == 1


def test_touch_normalizes_path(store: RecentWorkspacesStore, tmp_path: Path) -> None:
    a = _mkdir(tmp_path, "a")
    store.touch(a)
    store.touch(a + "/")  # trailing slash → same workspace
    assert len(store.list()) == 1


def test_list_annotates_exists(store: RecentWorkspacesStore, tmp_path: Path) -> None:
    a = _mkdir(tmp_path, "a")
    store.touch(a)
    assert store.list()[0]["exists"] is True
    # Remove the folder → entry stays, exists flips to False
    (tmp_path / "a").rmdir()
    entry = store.list()[0]
    assert entry["exists"] is False
    assert entry["name"] == "a"


def test_cap_drops_oldest_unpinned(tmp_path: Path) -> None:
    path = tmp_path / "recent.json"
    path.write_text(json.dumps({"version": 1, "recent": [], "limit": 3}), encoding="utf-8")
    store = RecentWorkspacesStore(path=path)
    for name in ["a", "b", "c", "d"]:
        store.touch(_mkdir(tmp_path, name))
    names = [e["name"] for e in store.list()]
    assert names == ["d", "c", "b"]  # "a" dropped (oldest)


def test_pinned_entries_never_drop(tmp_path: Path) -> None:
    path = tmp_path / "recent.json"
    path.write_text(json.dumps({"version": 1, "recent": [], "limit": 2}), encoding="utf-8")
    store = RecentWorkspacesStore(path=path)
    a = _mkdir(tmp_path, "a")
    store.touch(a)
    store.pin(a)
    store.touch(_mkdir(tmp_path, "b"))
    store.touch(_mkdir(tmp_path, "c"))
    names = [e["name"] for e in store.list()]
    assert "a" in names  # pinned survives despite being oldest
    assert len(names) == 2


def test_pin_unpin_persists(store: RecentWorkspacesStore, tmp_path: Path) -> None:
    a = _mkdir(tmp_path, "a")
    store.touch(a)
    store.pin(a)
    assert store.list()[0]["pinned"] is True
    store.unpin(a)
    assert store.list()[0]["pinned"] is False


def test_pin_unknown_raises(store: RecentWorkspacesStore, tmp_path: Path) -> None:
    with pytest.raises(KeyError):
        store.pin(str(tmp_path / "nope"))


def test_remove_drops_entry(store: RecentWorkspacesStore, tmp_path: Path) -> None:
    a = _mkdir(tmp_path, "a")
    b = _mkdir(tmp_path, "b")
    store.touch(a)
    store.touch(b)
    store.remove(a)
    assert [e["name"] for e in store.list()] == ["b"]


def test_remove_unknown_raises(store: RecentWorkspacesStore, tmp_path: Path) -> None:
    with pytest.raises(KeyError):
        store.remove(str(tmp_path / "nope"))


def test_persistence_roundtrip(tmp_path: Path) -> None:
    path = tmp_path / "recent.json"
    a = _mkdir(tmp_path, "a")
    s1 = RecentWorkspacesStore(path=path)
    s1.touch(a, state="completed", task="hello")
    s1.pin(a)

    s2 = RecentWorkspacesStore(path=path)
    entry = s2.list()[0]
    assert entry["pinned"] is True
    assert entry["last_known_task"] == "hello"


def test_atomic_write_leaves_no_tmp(tmp_path: Path) -> None:
    path = tmp_path / "recent.json"
    store = RecentWorkspacesStore(path=path)
    store.touch(_mkdir(tmp_path, "a"))
    leftovers = [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


def test_corrupt_json_recovers(tmp_path: Path) -> None:
    path = tmp_path / "recent.json"
    path.write_text("{not valid", encoding="utf-8")
    store = RecentWorkspacesStore(path=path)
    assert store.list() == []
    # And it can be written to afterwards
    store.touch(_mkdir(tmp_path, "a"))
    assert len(store.list()) == 1


def test_legacy_json_imported_once_and_retired(tmp_path: Path) -> None:
    path = tmp_path / "recent.json"
    a = _mkdir(tmp_path, "a")
    b = _mkdir(tmp_path, "b")
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "max_size": 20,
                "recent": [
                    {"path": b, "name": "b", "last_opened_at": "2026-01-02T00:00:00Z", "pinned": True},
                    {"path": a, "name": "a", "last_opened_at": "2026-01-01T00:00:00Z", "pinned": False},
                ],
            }
        ),
        encoding="utf-8",
    )
    store = RecentWorkspacesStore(path=path)
    # MRU order preserved through the import.
    assert [e["name"] for e in store.list()] == ["b", "a"]
    assert store.list()[0]["pinned"] is True
    assert not path.exists()
    assert path.with_name(path.name + ".migrated-v1").exists()
    # Second instance reads the imported data (no re-import, no data loss).
    assert [e["name"] for e in RecentWorkspacesStore(path=path).list()] == ["b", "a"]


def _seed(path: Path, recent: list[dict], **extra: object) -> None:
    path.write_text(json.dumps({"version": 1, "recent": recent, **extra}), encoding="utf-8")


def test_default_keeps_far_more_than_the_old_twenty(store: RecentWorkspacesStore, tmp_path: Path) -> None:
    for i in range(60):
        store.touch(_mkdir(tmp_path, f"w{i:02d}"))
    assert len(store.list()) == 60
    assert store.info()["limit"] == 1000


def test_legacy_doc_capped_at_twenty_loads_unchanged_and_keeps_growing(tmp_path: Path) -> None:
    # Every store written before this change carries the old max_size=20
    # default. Its entries must come back exactly as stored, and the next open
    # must not push the oldest one out.
    path = tmp_path / "recent.json"
    entries = [
        {"path": _mkdir(tmp_path, f"old{i:02d}"), "name": f"old{i:02d}",
         "last_opened_at": f"2026-01-{20 - i:02d}T00:00:00Z", "pinned": i == 5}
        for i in range(20)
    ]
    _seed(path, entries, max_size=20)
    store = RecentWorkspacesStore(path=path)
    assert [e["name"] for e in store.list()] == [e["name"] for e in entries]
    store.touch(_mkdir(tmp_path, "new"))
    names = [e["name"] for e in store.list()]
    assert names == ["new"] + [e["name"] for e in entries]


def test_trim_never_drops_open_workspaces(tmp_path: Path) -> None:
    path = tmp_path / "recent.json"
    _seed(path, [], limit=2)
    store = RecentWorkspacesStore(path=path)
    a = _mkdir(tmp_path, "a")
    store.touch(a)
    store.touch(_mkdir(tmp_path, "b"))
    store.touch(_mkdir(tmp_path, "c"), keep=[a + "/"])
    names = [e["name"] for e in store.list()]
    assert names == ["c", "a"]  # b dropped; a is open in a window


def test_trim_is_counted_for_the_ui(tmp_path: Path) -> None:
    path = tmp_path / "recent.json"
    _seed(path, [], limit=1)
    store = RecentWorkspacesStore(path=path)
    assert store.info()["trimmed"] == 0
    store.touch(_mkdir(tmp_path, "a"))
    store.touch(_mkdir(tmp_path, "b"))
    store.touch(_mkdir(tmp_path, "c"))
    assert store.info()["trimmed"] == 2


def test_limit_off_never_trims(tmp_path: Path) -> None:
    path = tmp_path / "recent.json"
    _seed(path, [], limit=1)
    store = RecentWorkspacesStore(path=path)
    store.set_limit(None)
    store.touch(_mkdir(tmp_path, "a"))
    store.touch(_mkdir(tmp_path, "b"))
    assert len(store.list()) == 2
    assert store.info() == {"limit": None, "trimmed": 0}


def test_set_limit_persists_and_rejects_nonsense(store: RecentWorkspacesStore, tmp_path: Path) -> None:
    store.set_limit(300)
    assert RecentWorkspacesStore(path=tmp_path / "recent-workspaces.json").info()["limit"] == 300
    for bad in (0, -1, 2.5, "50", True):
        with pytest.raises(ValueError):
            store.set_limit(bad)  # type: ignore[arg-type]


def test_lowering_the_limit_trims_now_but_spares_open_and_pinned(tmp_path: Path) -> None:
    path = tmp_path / "recent.json"
    store = RecentWorkspacesStore(path=path)
    a, b, c, d = (_mkdir(tmp_path, n) for n in "abcd")
    for p in (a, b, c, d):
        store.touch(p)
    store.pin(a)
    store.set_limit(1, keep=[b])
    assert sorted(e["name"] for e in store.list()) == ["a", "b"]
    assert store.info()["trimmed"] == 2


def test_missing_folder_is_never_trimmed_away_by_itself(store: RecentWorkspacesStore, tmp_path: Path) -> None:
    a = _mkdir(tmp_path, "a")
    store.touch(a)
    (tmp_path / "a").rmdir()
    store.touch(_mkdir(tmp_path, "b"))
    assert [(e["name"], e["exists"]) for e in store.list()] == [("b", True), ("a", False)]


def test_stored_max_size_mirrors_the_limit_for_older_builds(tmp_path: Path) -> None:
    # v0.2.17 and earlier cap at the stored max_size. Mirroring the limit there
    # keeps a downgrade from cutting the list back to the old default of 20.
    from agent_team_backend.recent_workspaces import _KV_KEY

    path = tmp_path / "recent.json"
    _seed(path, [], max_size=20)
    store = RecentWorkspacesStore(path=path)
    stored = lambda: store._db.kv_get(_KV_KEY)["max_size"]  # noqa: E731
    store.touch(_mkdir(tmp_path, "a"))
    assert stored() == 1000
    store.set_limit(300)
    assert stored() == 300
    store.set_limit(None)  # off: old builds have no "off", so give them the default bound
    assert stored() == 1000
