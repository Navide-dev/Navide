"""Security review round 7 of the D1 approval hold (sec-review7)."""

from __future__ import annotations

import pytest

from agent_team_backend import app, sync_approvals
from tests.test_sync_engine import FakeSettingsStore
from tests.test_sync_scope_adapters import account_key  # noqa: F401


@pytest.fixture(autouse=True)
def _own_app_data(tmp_path, monkeypatch):
    data_dir = tmp_path / "app-data"
    monkeypatch.setattr(app, "app_data_dir", lambda: data_dir)
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore(), raising=False)


class _Adapter:
    scope = "skill-files"

    def __init__(self):
        self.applied = []

    def apply(self, item_id, payload):
        self.applied.append(item_id)
        return True


# ── R7-1: an approved hold that no longer opens is kept, not dropped ───────
def test_land_approved_keeps_an_approved_hold_whose_payload_does_not_open(tmp_path, account_key):
    payload = {"v": 1, "files": {"SKILL.md": {"blob": "a" * 64, "kid": "k", "size": 1}}}
    assert sync_approvals.hold("skill-files", "big", payload, local=None, kind="new", summary={"name": "big"})
    d = sync_approvals.entry("skill-files", "big")["digest"]
    sync_approvals.set_status("skill-files", "big", sync_approvals.APPROVED,
                              token=sync_approvals._approval_token("skill-files", "big", d))
    sync_approvals._stash_path("skill-files", "big").write_text("garbage")
    adapter = _Adapter()
    sync_approvals.land_approved(adapter)
    assert adapter.applied == []
    assert sync_approvals.entry("skill-files", "big") is not None       # kept: fails closed
    assert "big" in sync_approvals.withheld("skill-files")


# ── R7-2: the startup cleanup never leaves the data dir ─────────────────────
def test_cleanup_skips_a_files_root_that_is_a_symlink(tmp_path):
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / "fetch-precious.txt").write_text("keep")
    (victim / "review-notes.md").write_text("keep")
    root = sync_approvals._stash_dir()
    root.mkdir(parents=True)
    (root / "files").symlink_to(victim, target_is_directory=True)
    sync_approvals.clean_leftover_temps(None)
    assert (victim / "fetch-precious.txt").exists() and (victim / "review-notes.md").exists()


def test_cleanup_skips_a_staging_dir_outside_the_data_dir(tmp_path):
    victim = tmp_path / "elsewhere"
    victim.mkdir()
    (victim / "review-mine.md").write_text("keep")
    sync_approvals.clean_leftover_temps(victim)
    assert (victim / "review-mine.md").exists()
    linked = tmp_path / "app-data" / "skill-blobs"
    linked.parent.mkdir(parents=True, exist_ok=True)
    linked.symlink_to(victim, target_is_directory=True)
    sync_approvals.clean_leftover_temps(linked)
    assert (victim / "review-mine.md").exists()


def test_cleanup_still_removes_its_own_leftovers(tmp_path):
    files = sync_approvals._stash_dir() / "files" / "skill-files" / "h"
    files.mkdir(parents=True)
    (files / "fetch-x.tmp").write_text("plain")
    staging = tmp_path / "app-data" / "skill-blobs"
    staging.mkdir(parents=True)
    (staging / "review-y").write_text("plain")
    (staging / ("a" * 64)).write_text("blob")
    sync_approvals.clean_leftover_temps(staging)
    assert not (files / "fetch-x.tmp").exists() and not (staging / "review-y").exists()
    assert (staging / ("a" * 64)).exists()
