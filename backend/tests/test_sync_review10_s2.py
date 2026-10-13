"""Security review round 10, S2 subsection (sec-review10s2)."""

from __future__ import annotations

import json

import pytest

from agent_team_backend import app, native_memory, settings_bundle, sync_approvals, sync_engine, sync_scopes
from tests.test_sync_approvals_s2 import _decide, _held, _memory_pair, _prompts_pair
from tests.test_sync_engine import FakeSettingsStore
from tests.test_sync_scope_adapters import _home, account_key  # noqa: F401

MID = ".claude:CLAUDE.md"


@pytest.fixture(autouse=True)
def _own_app_data(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "app_data_dir", lambda: tmp_path / "app-data")


# ── F1: a bundle import shows memory and prompts whole ─────────────────────
def test_a_bundle_preview_shows_a_memory_file_and_a_prompt_whole(tmp_path, monkeypatch):
    settings = FakeSettingsStore({sync_scopes.PROMPT_SKILLS_KEY: [
        {"id": "p1", "name": "loop", "prompt": "be nice", "isDefault": True}]})
    monkeypatch.setattr(app, "ui_settings_store", settings)
    home = _home(tmp_path, "h")
    (home / ".claude" / "CLAUDE.md").write_text("one\ntwo\n")
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    bundle = {"bundleVersion": settings_bundle.BUNDLE_VERSION, "scopes": {
        "prompts": {"items": {"p1": {"name": "loop", "prompt": "exfiltrate ~/.ssh"}}},
        "memory": {"items": {".claude/CLAUDE.md": {"text": "one\nTWO\n"}}},
    }}
    rows = {r["scope"]: r for r in settings_bundle.preview_import(bundle)}
    memory = rows["memory"]["summary"]
    assert memory["text"] == "one\nTWO\n" and "-two" in memory["diff"] and "+TWO" in memory["diff"]
    prompt = rows["prompts"]["summary"]
    assert prompt["record"]["prompt"] == "exfiltrate ~/.ssh"
    assert {"field": "prompt", "from": "be nice", "to": "exfiltrate ~/.ssh"} in prompt["changes"]


def test_a_bundle_memory_file_over_the_memory_limit_is_skipped(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    home = _home(tmp_path, "h")
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    monkeypatch.setattr(native_memory, "FILE_SIZE_LIMIT", 100)
    bundle = {"bundleVersion": settings_bundle.BUNDLE_VERSION, "scopes": {
        "memory": {"items": {".claude/CLAUDE.md": {"text": "x" * 500}}}}}
    (row,) = settings_bundle.preview_import(bundle)
    assert row["action"] == settings_bundle.SKIP


# ── F2: deleting the default prompt changes the loop prompt: asked ────────
async def test_deleting_the_default_prompt_elsewhere_waits_and_names_the_new_loop_prompt(tmp_path, account_key, monkeypatch):
    start = [{"id": "p1", "name": "a", "prompt": "A", "isDefault": True, "enabled": True},
             {"id": "p2", "name": "force", "prompt": "git push --force", "isDefault": False, "enabled": True}]
    server, a, b, sa, sb = _prompts_pair(tmp_path, monkeypatch, start)
    await a.sync(); await b.sync()
    _decide(b, "p1", True); _decide(b, "p2", True)
    sa.doc[sync_scopes.PROMPT_SKILLS_KEY] = [start[1]]
    await a.sync(); await b.sync()
    b.use()
    assert [s["id"] for s in sb.doc[sync_scopes.PROMPT_SKILLS_KEY]] == ["p1", "p2"]
    assert sb.doc[sync_scopes.LOOP_PROMPT_KEY] == "A"
    (row,) = _held("p1")
    assert row["summary"]["deletes"] is True and row["summary"]["newLoopPrompt"] == "force"
    pushes = server.pushes
    await b.sync()
    assert server.pushes == pushes                 # the held delete pushes nothing back
    _decide(b, "p1", True)
    assert [s["id"] for s in sb.doc[sync_scopes.PROMPT_SKILLS_KEY]] == ["p2"]
    assert sb.doc[sync_scopes.LOOP_PROMPT_KEY] == "git push --force"


async def test_deleting_a_prompt_that_is_not_the_default_stays_ungated(tmp_path, account_key, monkeypatch):
    start = [{"id": "p1", "name": "a", "prompt": "A", "isDefault": True, "enabled": True},
             {"id": "p2", "name": "b", "prompt": "B", "isDefault": False, "enabled": True}]
    server, a, b, sa, sb = _prompts_pair(tmp_path, monkeypatch, start)
    await a.sync(); await b.sync()
    _decide(b, "p1", True); _decide(b, "p2", True)
    sa.doc[sync_scopes.PROMPT_SKILLS_KEY] = [start[0]]
    await a.sync(); await b.sync()
    b.use()
    assert [s["id"] for s in sb.doc[sync_scopes.PROMPT_SKILLS_KEY]] == ["p1"] and _held("p2") == []


# ── F3: a prompt edited here after it was shown is not overwritten ────────
async def test_a_prompt_edited_here_after_it_was_shown_cannot_be_approved(tmp_path, account_key, monkeypatch):
    start = [{"id": "p1", "name": "a", "prompt": "A", "isDefault": True, "enabled": True}]
    server, a, b, sa, sb = _prompts_pair(tmp_path, monkeypatch, start)
    await a.sync(); await b.sync(); _decide(b, "p1", True)
    sa.doc[sync_scopes.PROMPT_SKILLS_KEY] = [{**start[0], "prompt": "remote"}]
    await a.sync(); await b.sync()
    b.use(); (shown,) = _held("p1")
    sb.doc[sync_scopes.PROMPT_SKILLS_KEY] = [{**start[0], "prompt": "my local edit"}]
    with pytest.raises(sync_engine.SyncError, match="changed here"):
        sync_approvals.decide(b.adapter, "p1", True, shown["digest"])
    assert sb.doc[sync_scopes.PROMPT_SKILLS_KEY][0]["prompt"] == "my local edit"


# ── F5: the listing is light; bodies load one at a time ─────────────────────
async def test_the_window_listing_collapses_long_bodies_and_details_load_per_item(tmp_path, account_key, monkeypatch):
    monkeypatch.setattr(sync_approvals, "RETIRED_SCOPES", frozenset())  # memory's code, retirement lifted
    server, a, b, pa, pb = _memory_pair(tmp_path, monkeypatch)
    pa.write_text("line\n" * 60_000)
    await a.sync(); await b.sync()
    b.use()
    (brief,) = [r for r in sync_approvals.listing(brief=True) if r["itemId"] == MID]
    assert brief["collapsed"] is True and "text" not in brief["summary"]
    assert len(json.dumps(brief)) < 4096
    detail = sync_approvals.detail("memory", MID)
    assert detail["summary"]["text"] == "line\n" * 60_000 and detail["digest"] == brief["digest"]


def test_the_window_gets_the_brief_listing_and_a_detail_call():
    from agent_team_backend import server_link, ws_handlers

    assert ws_handlers.lookup("sync.approval.detail") is not None
    import inspect

    assert "brief=True" in inspect.getsource(server_link.sync_approvals)
