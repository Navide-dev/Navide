"""Security review round 6 of the D1 approval hold (sec-review6)."""

from __future__ import annotations

import json
import os

import pytest

from agent_team_backend import app, mcp_manager, mcp_settings, sync_approvals, sync_scopes
from tests.test_skill_files_sync import SMALL, Device, FakeStore, _run
from tests.test_sync_approvals import _mcp_pair, _names, _server
from tests.test_sync_engine import FakeServer, FakeSettingsStore
from tests.test_sync_scope_adapters import _mcp, account_key  # noqa: F401


@pytest.fixture(autouse=True)
def _own_app_data(tmp_path, monkeypatch):
    data_dir = tmp_path / "app-data"
    monkeypatch.setattr(app, "app_data_dir", lambda: data_dir)
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore(), raising=False)


def _held(item_id):
    return [h for h in sync_approvals.listing() if h["itemId"] == item_id]


def _decide(dev, item_id, approve):
    dev.use()
    (row,) = _held(item_id)
    return sync_approvals.decide(dev.adapter, item_id, approve, row["digest"])


async def _approved_base(tmp_path, monkeypatch, base):
    server, a, b, a_store, b_store = _mcp_pair(tmp_path, monkeypatch)
    a.use(); a_store.replace_servers([base])
    await a.sync(); await b.sync()
    _decide(b, base["name"], True)
    return server, a, b, a_store, b_store


# ── R6-1: real paths load and sync; only synced records are checked ────────
LEGIT = {
    "cjk": "/Users/me/文件/伺服器/run.js",
    "nfd_e": "/Users/me/Café/run.js",
    "arabic": "/Users/me/مشروع/run.js",
    "persian_zwnj": "/Users/me/می‌خواهم/run.js",
    "emoji_vs16": "/Users/me/❤️-proj/run.js",
    "emoji_zwj": "/Users/me/\U0001F468‍\U0001F4BB/run.js",
    "nbsp": "/Users/me/My Project/run.js",
    "macos_screenshot_nnbsp": "/Users/me/Desktop/Screenshot 2026-01-01 at 10.00.00 PM.png",
}


@pytest.mark.parametrize("key", sorted(LEGIT))
def test_a_real_unicode_path_is_a_valid_server(key):
    mcp_settings.MCPStdioServerSetting(name="x", command="node", args=[LEGIT[key]])


@pytest.mark.parametrize("key", sorted(LEGIT))
async def test_a_real_unicode_path_syncs_for_approval(tmp_path, account_key, monkeypatch, key):
    server, a, b, a_store, b_store = _mcp_pair(tmp_path, monkeypatch)
    a.use(); a_store.replace_servers([{**_mcp("x"), "command": "node", "args": [LEGIT[key]]}])
    await a.sync(); await b.sync()
    b.use()
    (row,) = _held("x")
    assert row["summary"]["args"] == [LEGIT[key]]


def test_existing_config_with_any_character_still_loads_every_server(tmp_path):
    path = tmp_path / "mcp.json"
    path.write_text(json.dumps([
        {"name": "good", "transport": "stdio", "command": "node", "args": ["/srv/ok.js"]},
        {"name": "shot", "transport": "stdio", "command": "node",
         "args": ["/Users/me/Desktop/Screenshot 2026-01-01 at 10.00.00 PM.png"]},
        {"name": "odd", "transport": "stdio", "command": "node", "args": ["safe‮.js"]},
    ]), encoding="utf-8")
    names = {s["name"] for s in mcp_settings.MCPSettingsStore(path).list_servers()}
    assert names == {"good", "shot", "odd"}
    assert {s.name for s in mcp_manager.load_mcp_config(path)} == {"good", "shot", "odd"}


@pytest.mark.parametrize("field, value", [
    ("command", "np​x"), ("command", "np‮x"), ("args", ["safe‮.js"]),
    ("args", ["a b"]), ("args", ["aㅤb"]), ("args", ["a⁠b"]),
])
async def test_a_synced_record_hiding_characters_is_refused(tmp_path, account_key, monkeypatch, field, value):
    server, a, b, a_store, b_store = _mcp_pair(tmp_path, monkeypatch)
    record = {**_mcp("x"), field: value}
    a.adapter.local_snapshot = lambda: {"x": record}
    await a.sync(); await b.sync()
    b.use()
    assert _held("x") == [] and "x" not in _names(b_store)


def test_approval_rechecks_what_runs(tmp_path, account_key, monkeypatch):
    class Adapter:
        scope = "mcp"

        def apply(self, item_id, payload):
            raise AssertionError("must not land")

    bad = {**_mcp("x"), "args": ["safe‮.js"]}
    assert sync_approvals.hold("mcp", "x", bad, local=None, kind="new",
                               summary=sync_scopes._mcp_summary("x", bad))
    (row,) = _held("x")
    with pytest.raises(Exception, match="hid"):
        sync_approvals.decide(sync_scopes.McpScope(), "x", True, row["digest"])


# ── R6-2: any hold that does not open fails closed ─────────────────────────
async def test_a_pending_new_hold_that_does_not_open_pushes_no_delete(tmp_path, account_key, monkeypatch):
    server, a, b, a_store, b_store = _mcp_pair(tmp_path, monkeypatch)
    a.use(); a_store.replace_servers([_mcp("legit")])
    await a.sync(); await b.sync()
    b.use()
    assert _held("legit")
    sync_approvals._stash_path("mcp", "legit").write_text("garbage")
    r = await b.sync()
    assert "legit" in r["held"]
    await b.sync(); await a.sync()
    a.use()
    assert "legit" in _names(a_store) and server.rows[("mcp", "legit")]["deleted"] == 0


async def test_a_pending_change_whose_payload_is_lost_pushes_nothing(tmp_path, account_key, monkeypatch):
    base = _mcp("x")
    server, a, b, a_store, b_store = await _approved_base(tmp_path, monkeypatch, base)
    a.use(); a_store.replace_servers([{**base, "command": "/opt/new-legit"}])
    await a.sync(); await b.sync()
    b.use()
    sync_approvals._stash_path("mcp", "x").unlink()
    r = await b.sync()
    assert "x" in r["held"]
    await a.sync()
    a.use()
    assert _server(a_store, "x")["command"] == "/opt/new-legit"
    b.use()
    (row,) = _held("x")
    with pytest.raises(Exception):
        sync_approvals.decide(b.adapter, "x", True, row["digest"])
    assert _held("x")                                         # still held, not dropped


# ── R6-3 / R6-6: the review cache ───────────────────────────────────────────
@pytest.fixture
def blobs(tmp_path):
    root = tmp_path / "s3"
    root.mkdir()
    s = FakeStore(root, SMALL)
    yield s
    s.close()


def _make_big(store, name, size=300 * 1024):
    store.create_skill(name, "d", consent=True)
    files = {"clip.bin": b"\0" + os.urandom(size), "run.sh": b"#!/bin/sh\necho hi\n"}
    for rel, data in files.items():
        (store.root / name / rel).write_bytes(data)
    return files


def _cache_bytes():
    root = sync_approvals._stash_dir() / "files"
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file()) if root.exists() else 0


def _use(dev, monkeypatch):
    monkeypatch.setattr(app, "skills_store", dev.store, raising=False)
    monkeypatch.setattr(app, "app_data_dir", lambda: dev.data_dir, raising=False)


def test_rejecting_a_large_skill_drops_its_review_cache(tmp_path, monkeypatch, blobs, account_key):
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    b = Device(tmp_path, "b", server, blobs)
    _make_big(a.store, "big")
    _run(a.settle(monkeypatch)); _run(b.settle(monkeypatch))
    _use(b, monkeypatch)
    assert _cache_bytes() > 300 * 1024
    (row,) = _held("big")
    sync_approvals.decide(b.adapter, "big", False, row["digest"])
    assert _cache_bytes() == 0


def test_the_review_cache_is_capped_across_holds(tmp_path, monkeypatch, blobs, account_key):
    monkeypatch.setattr(sync_scopes, "MAX_REVIEW_CACHE_BYTES", 500 * 1024)
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    b = Device(tmp_path, "b", server, blobs)
    _make_big(a.store, "one")
    _make_big(a.store, "two")
    _run(a.settle(monkeypatch)); _run(b.settle(monkeypatch))
    _use(b, monkeypatch)
    rows = {r["itemId"]: r for r in sync_approvals.listing()}
    reviewed = [r for r in rows.values() if r["displayable"]]
    waiting = [r for r in rows.values() if not r["displayable"]]
    assert len(reviewed) == 1 and len(waiting) == 1
    assert "space" in waiting[0]["summary"]["unavailable"]
    assert _cache_bytes() <= 500 * 1024
    # Deciding the reviewed one frees the space; the other is reviewed next round.
    sync_approvals.decide(b.adapter, reviewed[0]["itemId"], False, reviewed[0]["digest"])
    _run(b.settle(monkeypatch))
    _use(b, monkeypatch)
    assert _held(waiting[0]["itemId"])[0]["displayable"] is True


def test_review_temp_files_are_private_and_leftovers_are_cleaned(tmp_path, monkeypatch, blobs, account_key):
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    b = Device(tmp_path, "b", server, blobs)
    _make_big(a.store, "big")
    seen = []
    real = sync_approvals.seal_held_file

    def spy(scope, item_id, d, rel, source):
        seen.append((source.stat().st_mode & 0o777, source.parent.stat().st_mode & 0o777))
        return real(scope, item_id, d, rel, source)

    monkeypatch.setattr(sync_approvals, "seal_held_file", spy)
    _run(a.settle(monkeypatch)); _run(b.settle(monkeypatch))
    if os.name != "nt":
        assert seen and all(mode == 0o600 and parent == 0o700 for mode, parent in seen)
    _use(b, monkeypatch)
    # Leftovers from a crash: a fetch temp in the hold area, a review temp in staging.
    files_root = sync_approvals._stash_dir() / "files"
    stray = files_root / "skill-files" / "somehold" / "fetch-abc.tmp"
    stray.parent.mkdir(parents=True, exist_ok=True)
    stray.write_bytes(b"plaintext")
    staging = b.data_dir / "skill-blobs"
    staging.mkdir(parents=True, exist_ok=True)
    (staging / "review-abc").write_bytes(b"plaintext")
    sync_approvals.clean_leftover_temps(staging)
    assert not stray.exists() and not (staging / "review-abc").exists()
