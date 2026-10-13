"""Closing the round-5 residuals of the D1 approval hold.

1. A large skill (skill-files) is reviewed before it is approved: its files
   are downloaded into the hold area, sealed under the account key, and
   previewed like a small skill's. Downloading is not landing; approval lands
   exactly the files previewed, each checked against its SHA-256.
2. A rejected hold whose payload no longer opens fails closed: the rejection
   stays, nothing is pushed for the item, and the round says so.
"""

from __future__ import annotations

import hashlib
import os

import pytest

from agent_team_backend import app, skill_blobs, sync_approvals, sync_scopes
from tests.test_skill_files_sync import SMALL, Device, FakeStore, _big_skill, _run  # noqa: F401
from tests.test_sync_approvals import _mcp_pair, _names
from tests.test_sync_engine import FakeServer, FakeSettingsStore
from tests.test_sync_scope_adapters import _mcp, account_key  # noqa: F401


@pytest.fixture
def blobs(tmp_path):
    root = tmp_path / "s3"
    root.mkdir()
    s = FakeStore(root, SMALL)
    yield s
    s.close()


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore(), raising=False)


def _held(item_id):
    return [h for h in sync_approvals.listing() if h["itemId"] == item_id]


def _use(dev, monkeypatch):
    monkeypatch.setattr(app, "skills_store", dev.store, raising=False)
    monkeypatch.setattr(app, "app_data_dir", lambda: dev.data_dir, raising=False)


def _pair(tmp_path, blobs):
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    b = Device(tmp_path, "b", server, blobs)
    files = _big_skill(a.store)
    files["notes/a.md"] = b"# notes\nsee run.sh\n"
    (a.store.root / "big" / "notes" / "a.md").write_bytes(files["notes/a.md"])
    return server, a, b, files


def _reviewed(tmp_path, monkeypatch, blobs):
    server, a, b, files = _pair(tmp_path, blobs)
    _run(a.settle(monkeypatch))
    _run(b.settle(monkeypatch))
    _use(b, monkeypatch)
    return server, a, b, files


# ── 1. reviewed before approval ──────────────────────────────────────────────
def test_a_large_skill_is_downloaded_for_review_but_not_landed(tmp_path, monkeypatch, blobs, account_key):
    server, a, b, files = _reviewed(tmp_path, monkeypatch, blobs)
    assert not (b.store.root / "big").exists()                 # downloading is not landing
    (row,) = _held("big")
    assert row["displayable"] is True
    s = row["summary"]
    rows = {f["path"]: f for f in s["files"]}
    run_sh = (a.store.root / "big" / "run.sh").read_bytes()
    assert rows["run.sh"]["sha256"] == hashlib.sha256(run_sh).hexdigest()
    assert rows["clip.bin"]["size"] == len(files["clip.bin"])
    assert "name: big" in s["skillMd"] and s["skillMdTruncated"] is False
    previews = {p["path"]: p for p in s["previews"]}
    assert "echo hi" in previews["run.sh"]["preview"]
    # The hold area keeps the files sealed: no plaintext, no executable bit.
    held_dir = sync_approvals._stash_dir()
    for path in held_dir.rglob("*"):
        if path.is_file():
            assert b"echo hi" not in path.read_bytes()
            assert not path.stat().st_mode & 0o111


def test_approval_lands_exactly_the_reviewed_files(tmp_path, monkeypatch, blobs, account_key):
    server, a, b, files = _reviewed(tmp_path, monkeypatch, blobs)
    (row,) = _held("big")
    result = sync_approvals.decide(b.adapter, "big", True, row["digest"])
    assert result["status"] == "applied"
    for rel, data in files.items():
        assert (b.store.root / "big" / rel).read_bytes() == data
    if os.name != "nt":
        assert (b.store.root / "big" / "run.sh").stat().st_mode & 0o100
    assert _held("big") == []
    assert not any(p.is_file() for p in (sync_approvals._stash_dir() / "files").rglob("*"))


def test_a_file_that_changed_after_review_is_not_landed(tmp_path, monkeypatch, blobs, account_key):
    server, a, b, files = _reviewed(tmp_path, monkeypatch, blobs)
    (row,) = _held("big")
    # Swap a reviewed file's sealed copy for another sealed file of the hold.
    held = sync_approvals._held_files_dir("skill-files", "big", row["digest"])
    sealed = sorted(p for p in held.iterdir() if p.is_file())
    sealed[0].write_bytes(sealed[1].read_bytes())
    with pytest.raises(Exception):
        sync_approvals.decide(b.adapter, "big", True, row["digest"])
    assert not (b.store.root / "big").exists()


def test_a_review_download_that_fails_is_not_approvable(tmp_path, monkeypatch, blobs, account_key):
    async def broken(*_a, **_k):
        raise skill_blobs.BlobError("the object store lost it")

    server, a, b, files = _pair(tmp_path, blobs)
    _run(a.settle(monkeypatch))
    monkeypatch.setattr(skill_blobs, "download", broken)
    _run(b.settle(monkeypatch))
    _use(b, monkeypatch)
    (row,) = _held("big")
    assert row["displayable"] is False and "lost it" in row["summary"]["unavailable"]
    with pytest.raises(Exception, match="cannot be shown"):
        sync_approvals.decide(b.adapter, "big", True, row["digest"])


def test_a_skill_too_large_to_review_is_not_downloaded_or_approvable(tmp_path, monkeypatch, blobs, account_key):
    monkeypatch.setattr(sync_scopes, "MAX_REVIEW_BYTES", 1024)
    downloads = []
    real = skill_blobs.download

    async def counting(*args, **kwargs):
        downloads.append(1)
        return await real(*args, **kwargs)

    server, a, b, files = _pair(tmp_path, blobs)
    _run(a.settle(monkeypatch))
    monkeypatch.setattr(skill_blobs, "download", counting)
    _run(b.settle(monkeypatch))
    _use(b, monkeypatch)
    (row,) = _held("big")
    assert downloads == [] and row["displayable"] is False
    assert "too large" in row["summary"]["unavailable"]


# ── 2. a rejection that no longer opens fails closed ────────────────────────
async def test_a_rejected_hold_that_no_longer_opens_pushes_nothing(tmp_path, account_key, monkeypatch):
    server, a, b, a_store, b_store = _mcp_pair(tmp_path, monkeypatch)
    a.use(); a_store.replace_servers([_mcp("legit")])
    await a.sync(); await b.sync()
    b.use()
    (row,) = _held("legit")
    sync_approvals.decide(b.adapter, "legit", False, row["digest"])
    sync_approvals._stash_path("mcp", "legit").write_text("not a sealed payload")
    result = await b.sync()
    assert "legit" in result["held"]                          # surfaced in the round
    assert server.rows[("mcp", "legit")]["deleted"] == 0     # no delete pushed
    b.use()
    assert _held("legit")[0]["status"] == sync_approvals.REJECTED
    await a.sync()
    a.use()
    assert "legit" in _names(a_store)
