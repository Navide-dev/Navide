"""Large skills across devices: the engine's hooks for the ``skill-files``
scope, and the scope itself end to end over a fake record server and a fake
object store (real HTTP on 127.0.0.1)."""

from __future__ import annotations

import asyncio
import os
import stat
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, skill_blobs, sync_engine, sync_keyring, sync_scopes
from agent_team_backend.db import Database
from agent_team_backend.skills_store import SkillsStore

from .test_skill_blobs import SMALL, FakeStore
from .test_sync_engine import FakeServer, account_key  # noqa: F401 - a fixture


from agent_team_backend import sync_approvals as _sync_approvals  # noqa: E402

_REAL_IS_APPROVED = _sync_approvals.is_approved
_REAL_NEEDS_REVIEW = sync_scopes.SkillFilesScope.__dict__["_needs_review"]

@pytest.fixture(autouse=True)
def _approve_everything(monkeypatch):
    """What these tests check is the transfer, not the approval hold
    (test_sync_approvals*): every manifest counts as one this machine
    already reviewed, so it takes the plain download-and-land path."""
    from agent_team_backend import sync_approvals

    monkeypatch.setattr(sync_approvals, "is_approved", lambda *_a: False)
    monkeypatch.setattr(sync_scopes.SkillFilesScope, "_needs_review", staticmethod(lambda *_a: False))

def _run(coro):
    return asyncio.run(coro)


def _engine(tmp_path: Path, name: str, server: Any, adapter: Any, enabled=lambda _s: True):
    store = sync_engine.SyncStore(Database(tmp_path / f"{name}.db"))

    async def request(kind: str, payload: dict) -> dict:
        if kind == "sync.push":
            for item in payload["items"]:
                item["deviceId"] = name
        return await server.request(kind, payload)

    engine = sync_engine.SyncEngine(
        store, request, device_id=lambda: name, enabled=enabled, signing_key_for=lambda _d: ""
    )
    engine.register(adapter)
    return engine, store


class HookScope:
    """A skill-files-shaped adapter with the engine hooks, driven by flags."""

    scope = "skill-files"

    def __init__(self, items: dict | None = None) -> None:
        self.items = dict(items or {})
        self.applied: dict[str, Any] = {}
        self.ready_answer = True
        self.defer = False
        self.supported = True

    async def prepare(self, request, kick) -> bool:
        return self.supported

    def snapshot(self) -> dict:
        return dict(self.items)

    def refs(self, payload: Any) -> list[str]:
        return sorted(payload.get("blobs", []))

    async def ready(self, item_id: str, payload: Any) -> bool:
        return self.ready_answer

    def apply(self, item_id: str, payload: Any) -> None:
        if self.defer:
            raise sync_engine.DeferItem(item_id)
        self.applied[item_id] = payload
        self.items[item_id] = payload


class RecordingServer(FakeServer):
    def __init__(self) -> None:
        super().__init__()
        self.wire: list[dict] = []

    async def request(self, msg_type: str, payload: dict) -> dict:
        if msg_type == "sync.push":
            self.wire.extend(dict(i) for i in payload["items"])
        return await super().request(msg_type, payload)


# ── engine hooks ─────────────────────────────────────────────────────


def test_skill_files_is_a_protocol_scope_but_not_a_switch() -> None:
    assert "skill-files" in sync_engine.INTERNAL_SCOPES
    assert "skill-files" not in sync_engine.SCOPES


def test_skill_files_rides_with_the_skills_switch(monkeypatch) -> None:
    monkeypatch.setattr(sync_scopes, "enabled_scopes", lambda: {"skills": True})
    assert sync_scopes.scope_enabled("skill-files") is True
    monkeypatch.setattr(sync_scopes, "enabled_scopes", lambda: {"skills": False})
    assert sync_scopes.scope_enabled("skill-files") is False


def test_a_push_names_the_blobs_its_record_uses(tmp_path, account_key) -> None:  # noqa: F811
    server = RecordingServer()
    adapter = HookScope({"big": {"blobs": ["b" * 64, "a" * 64]}})
    engine, _ = _engine(tmp_path, "d1", server, adapter)
    _run(engine.sync("skill-files"))
    assert server.wire[0]["refs"] == ["a" * 64, "b" * 64]


def test_an_item_whose_files_are_not_up_yet_waits(tmp_path, account_key) -> None:  # noqa: F811
    server = RecordingServer()
    adapter = HookScope({"big": {"blobs": ["a" * 64]}})
    adapter.ready_answer = False
    engine, store = _engine(tmp_path, "d1", server, adapter)
    _run(engine.sync("skill-files"))
    assert server.wire == []
    assert store.state("skill-files", "big") is None
    adapter.ready_answer = True
    _run(engine.sync("skill-files"))
    assert [i["itemId"] for i in server.wire] == ["big"]


def test_a_deferred_record_holds_the_cursor_until_it_lands(tmp_path, account_key) -> None:  # noqa: F811
    server = RecordingServer()
    sender, _ = _engine(tmp_path, "d1", server, HookScope({"big": {"blobs": ["a" * 64]}}))
    _run(sender.sync("skill-files"))
    receiver_adapter = HookScope()
    receiver_adapter.defer = True
    receiver, store = _engine(tmp_path, "d2", server, receiver_adapter)
    _run(receiver.sync("skill-files"))
    assert receiver_adapter.applied == {}
    assert store.cursor("skill-files") == 0
    receiver_adapter.defer = False
    _run(receiver.sync("skill-files"))
    assert receiver_adapter.applied == {"big": {"blobs": ["a" * 64]}}
    assert store.cursor("skill-files") == 1


def test_a_server_without_blob_storage_skips_the_round(tmp_path, account_key) -> None:  # noqa: F811
    server = RecordingServer()
    adapter = HookScope({"big": {"blobs": ["a" * 64]}})
    adapter.supported = False
    engine, _ = _engine(tmp_path, "d1", server, adapter)
    result = _run(engine.sync("skill-files"))
    assert (result["scope"], result["skipped"]) == ("skill-files", "unsupported")
    assert server.wire == []


def test_choosing_a_copy_whose_files_are_still_downloading_keeps_the_conflict(tmp_path, account_key) -> None:  # noqa: F811
    server = RecordingServer()
    sender, _ = _engine(tmp_path, "d1", server, HookScope({"big": {"blobs": ["a" * 64]}}))
    _run(sender.sync("skill-files"))
    adapter = HookScope({"big": {"blobs": ["c" * 64]}})
    receiver, store = _engine(tmp_path, "d2", server, adapter)
    _run(receiver.sync("skill-files"))
    assert store.conflict_ids("skill-files") == {"big"}
    adapter.defer = True
    with pytest.raises(sync_engine.SyncError, match="still downloading"):
        receiver.resolve("skill-files", "big", sync_engine.KEEP_REMOTE)
    assert store.conflict_ids("skill-files") == {"big"}


# ── the scope, two devices ───────────────────────────────────────────


class Device:
    def __init__(self, tmp_path: Path, name: str, server: FakeServer, blobs: FakeStore) -> None:
        self.name = name
        self.store = SkillsStore(root=tmp_path / name / "shared", state_path=tmp_path / name / "state.json",
                                 runtime_root=tmp_path / name / "runtime", native_roots=[])
        self.adapter = sync_scopes.SkillFilesScope()
        self.adapter._digests = skill_blobs.DigestCache(Database(tmp_path / f"{name}-digests.db"))
        staging = tmp_path / name / "staging"
        staging.mkdir(parents=True)
        self.data_dir = tmp_path / name / "data"
        self.adapter._staging = lambda: staging

        async def request(kind: str, payload: dict) -> dict:
            if kind.startswith("blobs."):
                return await blobs.request(kind, payload)
            if kind == "sync.push":
                for item in payload["items"]:
                    item["deviceId"] = name
            return await server.request(kind, payload)

        self.engine = sync_engine.SyncEngine(
            sync_engine.SyncStore(Database(tmp_path / f"{name}.db")), request,
            device_id=lambda: name, enabled=lambda _s: True, signing_key_for=lambda _d: "",
        )
        self.engine.register(self.adapter)

    async def settle(self, monkeypatch) -> None:
        """One round, then every transfer it started and the rounds those kick."""
        monkeypatch.setattr(app, "skills_store", self.store, raising=False)
        monkeypatch.setattr(app, "app_data_dir", lambda: self.data_dir, raising=False)
        await self.engine.sync("skill-files")
        for _ in range(50):
            pending = [t for t in list(self.adapter._tasks.values()) + list(self.engine._kicked) if not t.done()]
            if not pending:
                return
            await asyncio.gather(*pending, return_exceptions=True)
        raise AssertionError("transfers did not settle")


@pytest.fixture
def blobs(tmp_path):
    root = tmp_path / "s3"
    root.mkdir()
    s = FakeStore(root, SMALL)
    yield s
    s.close()


def _big_skill(store: SkillsStore) -> dict[str, bytes]:
    store.create_skill("big", "d", consent=True)
    files = {"clip.bin": b"\0" + os.urandom(300 * 1024), "notes/a.md": b"# notes\n", "run.sh": b"#!/bin/sh\necho hi\n"}
    for rel, data in files.items():
        (store.root / "big" / rel).parent.mkdir(parents=True, exist_ok=True)
        (store.root / "big" / rel).write_bytes(data)
    (store.root / "big" / "run.sh").chmod(0o755)
    return files


def test_a_large_skill_reaches_another_device_whole(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    b = Device(tmp_path, "b", server, blobs)
    files = _big_skill(a.store)
    # The settings travelled through ``skills`` and wait for the files on b.
    monkeypatch.setattr(sync_scopes.SkillsStateScope, "_intent",
                        lambda self: {"big": {"enabled": False, "targets": ["codex"]}})

    async def flow() -> None:
        await a.settle(monkeypatch)
        assert ("skill-files", "big") in server.rows
        await b.settle(monkeypatch)

    _run(flow())
    landed = b.store.root / "big"
    for rel, data in files.items():
        assert (landed / rel).read_bytes() == data
    if os.name != "nt":  # Windows has no executable bit; the record still carries it
        assert (landed / "run.sh").stat().st_mode & stat.S_IXUSR
    manifest = b.adapter.snapshot()["big"]["files"]
    assert manifest["run.sh"].get("x") is True and "x" not in manifest["clip.bin"]
    skill = b.store.get_skill("big")["skill"]
    assert skill["enabled"] is False and skill["targets"] == ["codex"]
    # b now names the same files the same way: nothing to send back.
    pushes = server.pushes
    _run(b.settle(monkeypatch))
    assert server.pushes == pushes
    assert not any(b.adapter._staging().iterdir())


@pytest.fixture
def windows_modes(monkeypatch):
    """Windows semantics on a POSIX file system: chmod only toggles read-only
    and a mode never says a file is executable. Returns a switch."""
    real = Path.chmod

    def chmod(self, mode, *args, **kwargs):
        return real(self, 0o644 if mode & stat.S_IWRITE else 0o444, *args, **kwargs)

    def on(enabled: bool) -> None:
        if enabled:
            monkeypatch.setattr(Path, "chmod", chmod)
        else:
            monkeypatch.setattr(Path, "chmod", real)
        monkeypatch.setattr(sync_scopes, "_EXEC_BITS", not enabled and os.name != "nt", raising=False)

    return on


@pytest.mark.skipif(os.name == "nt", reason="the receiving side needs a POSIX file system")
def test_an_executable_that_passes_through_windows_keeps_its_flag(tmp_path, monkeypatch, blobs, account_key, windows_modes) -> None:  # noqa: F811
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    b = Device(tmp_path, "b", server, blobs)
    files = _big_skill(a.store)
    (a.store.root / "big" / "clip.bin").chmod(0o755)  # a binary: no shebang to go by
    _run(a.settle(monkeypatch))
    pushes = server.pushes

    windows_modes(True)
    _run(b.settle(monkeypatch))
    manifest = b.adapter.snapshot()["big"]["files"]
    assert manifest["clip.bin"].get("x") is True and manifest["run.sh"].get("x") is True
    assert manifest["notes/a.md"].get("x") is None
    _run(b.settle(monkeypatch))
    assert server.pushes == pushes  # b sends back nothing that drops the flags

    windows_modes(False)
    c = Device(tmp_path, "c", server, blobs)
    _run(c.settle(monkeypatch))
    for rel in files:
        executable = bool((c.store.root / "big" / rel).stat().st_mode & stat.S_IXUSR)
        assert executable is (rel in {"clip.bin", "run.sh"}), rel


@pytest.mark.skipif(os.name == "nt", reason="the receiving side needs a POSIX file system")
def test_a_script_written_on_windows_lands_executable(tmp_path, monkeypatch, blobs, account_key, windows_modes) -> None:  # noqa: F811
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    b = Device(tmp_path, "b", server, blobs)
    windows_modes(True)
    files = _big_skill(a.store)
    for rel in files:
        assert not (a.store.root / "big" / rel).stat().st_mode & 0o111
    _run(a.settle(monkeypatch))

    windows_modes(False)
    _run(b.settle(monkeypatch))
    landed = b.store.root / "big"
    assert (landed / "run.sh").stat().st_mode & stat.S_IXUSR
    assert not (landed / "clip.bin").stat().st_mode & stat.S_IXUSR
    assert not (landed / "notes" / "a.md").stat().st_mode & stat.S_IXUSR


def test_a_removal_elsewhere_never_deletes_files_here(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    server = FakeServer()
    b = Device(tmp_path, "b", server, blobs)
    _big_skill(b.store)
    monkeypatch.setattr(app, "skills_store", b.store, raising=False)
    assert b.adapter.apply("big", None) is None
    assert (b.store.root / "big" / "clip.bin").exists()


def test_a_skill_that_is_not_navides_here_is_not_fetched(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    b = Device(tmp_path, "b", server, blobs)
    _big_skill(a.store)
    (b.store.root / "big").mkdir(parents=True)
    (b.store.root / "big" / "SKILL.md").write_text("---\nname: big\ndescription: mine\n---\nbody\n")

    async def flow() -> None:
        await a.settle(monkeypatch)
        gets = len(blobs.gets)
        await b.settle(monkeypatch)
        assert len(blobs.gets) == gets

    _run(flow())
    assert (b.store.root / "big" / "SKILL.md").read_text().endswith("body\n")
    assert not (b.store.root / "big" / "clip.bin").exists()


def test_small_skills_stay_in_the_skills_scope(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    a.store.create_skill("small", "d", consent=True)
    (a.store.root / "small" / "notes.md").write_bytes(b"note")
    _run(a.settle(monkeypatch))
    assert ("skill-files", "small") not in server.rows


def test_the_listing_says_blobs_carry_a_large_skill_once_the_server_can(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    _big_skill(a.store)
    monkeypatch.setattr(sync_scopes, "_skill_files", a.adapter)
    monkeypatch.setattr(sync_scopes, "_skill_files", a.adapter)
    listing = sync_scopes.annotate_content_sync(a.store.list_skills(), a.store)
    assert listing["skills"][0]["sync_too_large"] is True  # server not asked yet
    _run(a.adapter.prepare(blobs.request, lambda: None))
    monkeypatch.setattr(sync_scopes, "_skill_files", a.adapter)
    listing = sync_scopes.annotate_content_sync(a.store.list_skills(), a.store)
    assert listing["skills"][0]["sync_too_large"] is False
    assert listing["skills"][0]["sync_via_blobs"] is True


def test_the_skills_record_of_a_large_skill_keeps_its_old_shape(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    """Old builds push back whatever they store; a new field here would be erased."""
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    _big_skill(a.store)
    monkeypatch.setattr(app, "skills_store", a.store, raising=False)
    _run(a.adapter.prepare(blobs.request, lambda: None))
    entry = sync_scopes.SkillsStateScope()._present()["big"]
    assert set(entry) == {"enabled", "targets"}


def _many_files_skill(store: SkillsStore, count: int) -> None:
    store.create_skill("many", "d", consent=True)
    for i in range(count):
        (store.root / "many" / f"f{i:03}.md").write_bytes(f"file {i}\n".encode())


def _counting_stat(blobs, calls):
    real = blobs.request

    async def request(kind, payload):
        if kind == "blobs.stat":
            calls.append(len(payload["blobIds"]))
            if len(payload["blobIds"]) > skill_blobs.STAT_BATCH:
                return {"ok": False, "error": {"code": "BAD_REQUEST", "message": "too many blobIds"}}
        return await real(kind, payload)

    return request


def test_blob_state_is_asked_in_batches_the_server_takes(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    monkeypatch.setattr(skill_blobs, "STAT_BATCH", 50)
    calls: list[int] = []
    monkeypatch.setattr(blobs, "request", _counting_stat(blobs, calls))
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    b = Device(tmp_path, "b", server, blobs)
    _many_files_skill(a.store, 120)

    async def flow() -> None:
        await a.settle(monkeypatch)
        await b.settle(monkeypatch)

    _run(flow())
    assert calls and max(calls) <= 50
    assert ("skill-files", "many") in server.rows
    assert (b.store.root / "many" / "f119.md").read_bytes() == b"file 119\n"


def test_a_skill_with_more_files_than_a_record_may_name_is_reported(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    _many_files_skill(a.store, skill_blobs.MAX_REFS + 10)
    monkeypatch.setattr(app, "skills_store", a.store, raising=False)

    _run(a.settle(monkeypatch))
    assert ("skill-files", "many") not in server.rows  # never pushed, never a tombstone
    assert a.adapter.oversized() == ["many"]
    assert "many" in a.adapter.snapshot()               # still held: absence would read as a delete
    monkeypatch.setattr(sync_scopes, "_skill_files", a.adapter)
    listing = sync_scopes.annotate_content_sync(a.store.list_skills(), a.store)
    row = next(s for s in listing["skills"] if s["name"] == "many")
    assert row["sync_too_large"] is True


def test_files_that_never_download_stop_holding_the_scope(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    """A record whose download keeps failing held the cursor forever, so no
    later skill-files record ever arrived. After a few attempts it is given up
    on (reported, and kept out of the agreed state) and the rest go ahead."""
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    b = Device(tmp_path, "b", server, blobs)
    _big_skill(a.store)
    _run(a.settle(monkeypatch))
    broken = {e["blob"] for e in a.adapter.snapshot()["big"]["files"].values()}
    # a second large skill, pushed after the first
    a.store.create_skill("big2", "d", consent=True)
    (a.store.root / "big2" / "clip.bin").write_bytes(b"\1" + os.urandom(300 * 1024))
    _run(a.settle(monkeypatch))
    assert ("skill-files", "big2") in server.rows

    real = skill_blobs.download

    async def flaky(request, ref, dest, layout, **kw):
        if ref.blob_id in broken:
            raise skill_blobs.BlobError("the object store lost it")
        return await real(request, ref, dest, layout, **kw)

    monkeypatch.setattr(skill_blobs, "download", flaky)
    # Step the engine's clock past any retry backoff, so every round asks again.
    now = [0.0]
    b.engine._clock = lambda: now[0]
    for _ in range(sync_scopes.MAX_DOWNLOAD_ATTEMPTS + 2):
        _run(b.settle(monkeypatch))
        now[0] += 3600
    assert (b.store.root / "big2" / "clip.bin").is_file()
    assert not (b.store.root / "big").exists()
    assert b.adapter.failed() == ["big"]


def test_reset_forgets_everything_the_last_account_left(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    adapter = sync_scopes.SkillFilesScope()

    async def flow() -> None:
        await adapter.prepare(lambda *_a: asyncio.sleep(0), lambda: None)
        started = asyncio.Event()

        async def forever() -> None:
            started.set()
            await asyncio.sleep(3600)

        adapter._start("big", forever)
        await started.wait()
        adapter._transfers["big"] = {"direction": "download", "done": 1, "total": 2}
        adapter._download_failures["big"] = ("d", 3)
        adapter._oversized.add("huge")
        task = adapter._tasks["big"]
        adapter.reset()
        await asyncio.sleep(0)
        assert task.cancelled()
        assert adapter.failed() == [] and adapter.oversized() == []
        assert adapter.transfer("big") is None and adapter._tasks == {}

    _run(flow())


def test_a_large_skill_waits_for_approval_then_lands(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    from agent_team_backend import sync_approvals
    from tests.test_sync_engine import FakeSettingsStore

    # The hold is the subject here (the review itself: test_sync_approvals_large_skills).
    monkeypatch.setattr(sync_approvals, "is_approved", _REAL_IS_APPROVED)
    monkeypatch.setattr(sync_scopes.SkillFilesScope, "_needs_review", _REAL_NEEDS_REVIEW)
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore(), raising=False)
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    b = Device(tmp_path, "b", server, blobs)
    files = _big_skill(a.store)
    _run(a.settle(monkeypatch))
    _run(b.settle(monkeypatch))
    assert not (b.store.root / "big").exists()   # reviewed, not landed
    (held,) = sync_approvals.listing()
    assert held["scope"] == "skill-files" and held["kind"] == "new" and held["displayable"] is True
    assert held["summary"]["executable"] == (["run.sh"] if os.name != "nt" else [])

    monkeypatch.setattr(app, "skills_store", b.store, raising=False)
    monkeypatch.setattr(app, "app_data_dir", lambda: b.data_dir, raising=False)
    assert sync_approvals.decide(b.adapter, "big", True, held["digest"])["status"] == "applied"
    for rel, data in files.items():
        assert (b.store.root / "big" / rel).read_bytes() == data
    assert sync_approvals.listing() == []