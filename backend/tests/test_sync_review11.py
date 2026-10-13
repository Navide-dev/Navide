"""Security review round 11 (four L items)."""

from __future__ import annotations

import sys

import pytest

from agent_team_backend import app, native_memory, settings_bundle, sync_approvals, sync_engine, sync_scopes
from tests.test_settings_bundle import settings, skills  # noqa: F401
from tests.test_sync_approvals_s2 import _decide, _held, _prompts_pair
from tests.test_sync_engine import FakeSettingsStore
from tests.test_sync_scope_adapters import _home, account_key  # noqa: F401


@pytest.fixture(autouse=True)
def _own_app_data(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "app_data_dir", lambda: tmp_path / "app-data")


def P(i, prompt, d=False):
    return {"id": i, "name": i, "prompt": prompt, "isDefault": d, "enabled": True}


# ── N11-1: a bundle memory id is a path, always ────────────────────────────
@pytest.mark.skipif(sys.platform == "win32", reason="Windows cannot name a file with ':' (it reads 'a:' as a drive)")
def test_a_bundle_memory_path_with_a_colon_diffs_against_the_real_file(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    home = _home(tmp_path, "h")
    rules = home / ".cursor" / "rules"
    rules.mkdir(parents=True)
    (rules / "a:b.mdc").write_text("old line\n")
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    bundle = {"bundleVersion": settings_bundle.BUNDLE_VERSION, "scopes": {
        "memory": {"items": {".cursor/rules/a:b.mdc": {"text": "new line\n"}}}}}
    (row,) = settings_bundle.preview_import(bundle)
    assert row["action"] == settings_bundle.OVERWRITE
    assert "-old line" in row["summary"]["diff"]


def test_a_bundle_memory_path_with_a_colon_and_no_such_file_here_is_refused(tmp_path, monkeypatch):
    """Where no file of that name can be (Windows), the row is refused, not crashed."""
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    home = _home(tmp_path, "h")
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    bundle = {"bundleVersion": settings_bundle.BUNDLE_VERSION, "scopes": {
        "memory": {"items": {".cursor/rules/a:b.mdc": {"text": "new line\n"}}}}}
    (row,) = settings_bundle.preview_import(bundle)
    assert row["action"] == settings_bundle.SKIP and "summary" not in row
    out = settings_bundle.apply_import(bundle, {"memory": [".cursor/rules/a:b.mdc"]})
    assert out["results"][0]["action"] == settings_bundle.SKIP


# ── N11-2: a skill re-added after a remote delete can be approved ──────────
def _content(body):
    return {"SKILL.md": {"t": "text", "v": f"---\nname: s\ndescription: d\n---\n{body}\n"}}


def test_a_skill_re_added_after_a_remote_delete_can_be_approved(account_key, settings, skills):  # noqa: F811
    store, root = skills
    adapter = sync_scopes.SkillsStateScope()
    assert store.import_content("s", _content("v1"))
    adapter.apply("s", {"enabled": True, "targets": None, "content": _content("v1")})
    adapter.apply("s", None)                     # a remote delete: kept here, detached
    payload = {"enabled": True, "targets": None, "content": _content("v2")}
    assert adapter.apply("s", payload) is True   # re-added elsewhere: held
    (row,) = _held("s")
    assert sync_approvals.decide(adapter, "s", True, row["digest"])["status"] == "applied"
    assert "v2" in (root / "s" / "SKILL.md").read_text()


# ── N11-3: the successor loop prompt is the one shown ──────────────────────
async def _default_delete_held(tmp_path, monkeypatch):
    start = [P("p1", "A", True), P("p2", "git push --force")]
    server, a, b, sa, sb = _prompts_pair(tmp_path, monkeypatch, start)
    await a.sync(); await b.sync(); _decide(b, "p1", True); _decide(b, "p2", True)
    a.use(); sa.doc[sync_scopes.PROMPT_SKILLS_KEY] = [P("p2", "git push --force")]
    await a.sync(); await b.sync()
    return server, a, b, sa, sb


async def test_the_card_names_the_successor_as_it_is_now(tmp_path, account_key, monkeypatch):
    server, a, b, sa, sb = await _default_delete_held(tmp_path, monkeypatch)
    b.use()
    listed = sb.doc[sync_scopes.PROMPT_SKILLS_KEY]
    sb.doc[sync_scopes.PROMPT_SKILLS_KEY] = [listed[0], P("p0", "local other"), listed[1]]
    (row,) = _held("p1")
    assert row["summary"]["newLoopPrompt"] == "p0"


async def test_approval_is_refused_when_the_successor_changed_after_it_was_shown(tmp_path, account_key, monkeypatch):
    server, a, b, sa, sb = await _default_delete_held(tmp_path, monkeypatch)
    b.use()
    (row,) = _held("p1")
    assert row["summary"]["newLoopPrompt"] == "p2"
    listed = sb.doc[sync_scopes.PROMPT_SKILLS_KEY]
    sb.doc[sync_scopes.PROMPT_SKILLS_KEY] = [listed[0], P("p0", "local other"), listed[1]]
    with pytest.raises(sync_engine.SyncError, match="loop prompt"):
        sync_approvals.decide(b.adapter, "p1", True, row["digest"])
    assert [s["id"] for s in sb.doc[sync_scopes.PROMPT_SKILLS_KEY]] == ["p1", "p0", "p2"]


# ── N11-4: the refusal says why ─────────────────────────────────────────────
async def test_a_default_flag_moved_by_another_approval_is_named_in_the_refusal(tmp_path, account_key, monkeypatch):
    start = [P("p1", "A", True), P("p2", "B")]
    server, a, b, sa, sb = _prompts_pair(tmp_path, monkeypatch, start)
    await a.sync(); await b.sync(); _decide(b, "p1", True); _decide(b, "p2", True)
    a.use(); sa.doc[sync_scopes.PROMPT_SKILLS_KEY] = [P("p1", "A"), P("p2", "B", True)]
    await a.sync(); await b.sync()
    _decide(b, "p2", True)
    with pytest.raises(sync_engine.SyncError, match="another approval changed which prompt is the default"):
        _decide(b, "p1", True)
