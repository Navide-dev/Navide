"""Scope adapters against the rules the real server and the other device hold
them to: the protocol's itemId pattern, deletes that must stay deleted,
refusals that must be reported rather than swallowed, and files that must land
the way they left.

Two devices share one ``StrictServer`` — the test FakeServer plus the itemId
pattern ``Navide-Server/src/handlers/sync.ts`` enforces — and each device swaps
its own stores into ``app`` before every round, the real arrangement.
"""

from __future__ import annotations

import re

import pytest

from agent_team_backend import app, device_signing, native_memory, sync_engine, sync_keyring, sync_scopes
from agent_team_backend.db import Database
from tests.test_sync_engine import FakeServer, FakeSettingsStore

#: Navide-Server sync.ts: one bad id refuses the whole batch.
ITEM_ID = re.compile(r"^[A-Za-z0-9._:@+-]{1,200}$")


@pytest.fixture(autouse=True)
def _approve_everything(monkeypatch):
    """What these tests check is not the approval hold (test_sync_approvals
    is): every synced record counts as approved here."""
    from agent_team_backend import sync_approvals

    monkeypatch.setattr(sync_approvals, "is_approved", lambda *_a: True)


class StrictServer(FakeServer):
    async def request(self, msg_type, payload):
        if msg_type == "sync.push":
            for item in payload["items"]:
                if not ITEM_ID.match(item["itemId"]):
                    return {"ok": False, "error": {"code": "BAD_REQUEST", "message": item["itemId"]}}
        return await super().request(msg_type, payload)


@pytest.fixture
def account_key():
    sync_keyring.ensure_account_key()
    yield
    sync_keyring.forget_account_key()


class Dev:
    """One machine: its own sync store, home and app-level stores."""

    def __init__(self, tmp_path, server, name, monkeypatch, adapter, *, home=None, **stores):
        self.name, self.mp, self.adapter, self.home = name, monkeypatch, adapter, home
        data_dir = tmp_path / f"{name}-data"
        # Its own app data too: sync keeps approval holds there (sync_approvals).
        self.stores = {"ui_settings_store": FakeSettingsStore(), "app_data_dir": lambda: data_dir, **stores}
        self.store = sync_engine.SyncStore(Database(tmp_path / f"{name}.db"))

        async def request(msg_type, payload):
            if msg_type == "sync.push":
                for item in payload["items"]:
                    item["deviceId"] = name
            return await server.request(msg_type, payload)

        self.engine = sync_engine.SyncEngine(
            self.store, request, device_id=lambda: name,
            # One signing key per test process: every device reads as pinned,
            # which is what paired devices of one account are.
            enabled=lambda _s: True, signing_key_for=lambda _d: device_signing.public_key(),
        )
        self.engine.register(adapter)

    def use(self):
        for attr, value in self.stores.items():
            self.mp.setattr(app, attr, value)
        if self.home is not None:
            home = self.home
            self.mp.setattr(native_memory, "_home", lambda: home)

    async def sync(self):
        self.use()
        return await self.engine.sync(self.adapter.scope)


def _home(tmp_path, name):
    home = tmp_path / name
    (home / ".claude").mkdir(parents=True)
    return home


# ── memory: item ids ─────────────────────────────────────────────────────────
async def test_memory_item_ids_pass_the_servers_pattern(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    ha, hb = _home(tmp_path, "a"), _home(tmp_path, "b")
    (ha / ".claude" / "CLAUDE.md").write_text("hello\n")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.MemoryScope(), home=ha)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.MemoryScope(), home=hb)
    await a.sync()
    await b.sync()
    assert (hb / ".claude" / "CLAUDE.md").read_text() == "hello\n"


def test_memory_item_id_is_reversible_and_injective():
    paths = [".claude/CLAUDE.md", ".cursor/rules/a b.mdc", ".cursor/rules/a+b.mdc",
             ".cursor/rules/a:b.mdc", ".cursor/rules/規則.mdc", "x" * 250 + ".md"]
    ids = [sync_scopes.memory_item_id(p) for p in paths]
    assert all(ITEM_ID.match(i) for i in ids)
    assert len(set(ids)) == len(ids)
    assert ids[0] == ".claude:CLAUDE.md"


def test_memory_apply_still_accepts_a_plain_relative_path(tmp_path, monkeypatch):
    """A Bundle v1 file names memory items by their path; it must still import."""
    home = _home(tmp_path, "h")
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    assert sync_scopes.MemoryScope._resolve(".claude/CLAUDE.md") is not None
    assert sync_scopes.MemoryScope._resolve(".claude:CLAUDE.md") is not None


def test_memory_leaves_out_files_only_aider_config_names(tmp_path, monkeypatch):
    """A home ``.aider.conf.yml`` can name any file under the home — a project
    file included — and syncing it would copy that file into another machine's
    home. Only the rows the table declares travel."""
    home = _home(tmp_path, "h")
    (home / ".claude" / "CLAUDE.md").write_text("mine\n")
    (home / "work" / "repo").mkdir(parents=True)
    (home / "work" / "repo" / "NOTES.md").write_text("project notes\n")
    (home / ".aider.conf.yml").write_text("read: [work/repo/NOTES.md]\n")
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    assert any(f.relative == "work/repo/NOTES.md" for f in native_memory.scan())  # still listed in the editor
    scope = sync_scopes.MemoryScope()
    assert set(scope.snapshot_by_path()) == {".claude/CLAUDE.md"}
    assert scope._resolve("work/repo/NOTES.md") is None
    assert scope.apply(sync_scopes.memory_item_id("work/repo/NOTES.md"), {"text": "x"}) is False
    assert (home / "work" / "repo" / "NOTES.md").read_text() == "project notes\n"


def test_memory_apply_writes_through_a_symlinked_file(tmp_path, monkeypatch):
    """Keeping ~/.claude/CLAUDE.md as a link into a dotfiles repo is common;
    a synced write must land in the repo, not replace the link."""
    home = _home(tmp_path, "h")
    (home / "dotfiles").mkdir()
    real = home / "dotfiles" / "CLAUDE.md"
    real.write_text("old\n")
    link = home / ".claude" / "CLAUDE.md"
    link.symlink_to(real)
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    scope = sync_scopes.MemoryScope()
    scope.snapshot()  # the engine always reads before it writes
    assert scope.apply(".claude:CLAUDE.md", {"text": "new\n"}) is True
    assert link.is_symlink()
    assert real.read_text() == "new\n"


# ── deletes: kept here, never pushed back (memory and skills, one rule) ──────
async def test_memory_delete_elsewhere_keeps_the_file_and_does_not_resurrect(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    ha, hb = _home(tmp_path, "a"), _home(tmp_path, "b")
    (ha / ".claude" / "CLAUDE.md").write_text("hello\n")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.MemoryScope(), home=ha)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.MemoryScope(), home=hb)
    await a.sync(); await b.sync()
    (ha / ".claude" / "CLAUDE.md").unlink()
    for _ in range(2):
        await a.sync(); await b.sync()
    assert not (ha / ".claude" / "CLAUDE.md").exists()           # stays deleted where it was deleted
    assert (hb / ".claude" / "CLAUDE.md").read_text() == "hello\n"  # B's file is the user's, kept
    assert server.rows[("memory", ".claude:CLAUDE.md")]["deleted"] == 1
    pushes = server.pushes
    await a.sync(); await b.sync()
    assert server.pushes == pushes                                 # settled

    # Editing the kept copy is a new decision: it goes up again.
    (hb / ".claude" / "CLAUDE.md").write_text("hello again\n")
    await b.sync(); await a.sync()
    assert (ha / ".claude" / "CLAUDE.md").read_text() == "hello again\n"


def _skills(tmp_path, tag):
    from agent_team_backend.skills_store import SkillsStore

    root = tmp_path / tag / "agents" / "skills"
    store = SkillsStore(root=root, state_path=tmp_path / tag / "skills.json",
                        runtime_root=tmp_path / tag / "runtime", native_roots=[tmp_path / tag / "native"])
    return store, root


def _skill_pair(tmp_path, monkeypatch, server=None):
    server = server or StrictServer()
    sa, ra = _skills(tmp_path, "A")
    sb, rb = _skills(tmp_path, "B")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.SkillsStateScope(), skills_store=sa)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.SkillsStateScope(), skills_store=sb)
    return server, a, b, sa, ra, sb, rb


async def test_skill_delete_elsewhere_keeps_the_files_and_does_not_resurrect(tmp_path, account_key, monkeypatch):
    monkeypatch.setattr(sync_scopes.SkillFilesScope, "available", lambda self: False)
    server, a, b, sa, ra, sb, rb = _skill_pair(tmp_path, monkeypatch)
    sa.create_skill("writer", "writes", consent=True)
    await a.sync(); await b.sync()
    assert (rb / "writer" / "SKILL.md").is_file()
    a.use(); sa.delete_skill("writer")
    for _ in range(2):
        await a.sync(); await b.sync()
    assert not (ra / "writer").exists()
    assert (rb / "writer" / "SKILL.md").is_file()
    assert server.rows[("skills", "writer")]["deleted"] == 1
    pushes = server.pushes
    await a.sync(); await b.sync()
    assert server.pushes == pushes


# ── prompts: the default ─────────────────────────────────────────────────────
def _prompts_dev(tmp_path, server, name, monkeypatch, skills=None):
    settings = FakeSettingsStore({sync_scopes.PROMPT_SKILLS_KEY: skills} if skills else None)
    return Dev(tmp_path, server, name, monkeypatch, sync_scopes.PromptsScope(), ui_settings_store=settings), settings


def _defaults(settings):
    return [s["id"] for s in settings.doc[sync_scopes.PROMPT_SKILLS_KEY] if s.get("isDefault")]


async def test_a_new_default_survives_the_round_trip(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    start = [{"id": "y", "prompt": "Y", "isDefault": True}, {"id": "x", "prompt": "X", "isDefault": False}]
    a, sa = _prompts_dev(tmp_path, server, "A", monkeypatch, [dict(s) for s in start])
    b, sb = _prompts_dev(tmp_path, server, "B", monkeypatch)
    await a.sync(); await b.sync()
    assert _defaults(sb) == ["y"]
    # The renderer saves the whole list with the new default.
    sa.doc[sync_scopes.PROMPT_SKILLS_KEY] = [
        {"id": "y", "prompt": "Y", "isDefault": False}, {"id": "x", "prompt": "X", "isDefault": True}]
    for _ in range(2):
        await a.sync(); await b.sync()
    assert _defaults(sb) == ["x"]
    assert _defaults(sa) == ["x"]
    assert sb.doc[sync_scopes.LOOP_PROMPT_KEY] == "X"


def test_the_loop_prompt_follows_the_renderers_default_rule(monkeypatch):
    """The renderer casts the first skill flagged *and enabled*, else the first
    enabled one; the loop-prompt mirror must name the same skill."""
    settings = FakeSettingsStore({sync_scopes.PROMPT_SKILLS_KEY: [
        {"id": "a", "prompt": "A", "isDefault": True, "enabled": False},
        {"id": "b", "prompt": "B", "isDefault": False}]})
    monkeypatch.setattr(app, "ui_settings_store", settings)
    sync_scopes.PromptsScope().apply("c", {"id": "c", "prompt": "C", "isDefault": False})
    assert settings.doc[sync_scopes.LOOP_PROMPT_KEY] == "B"


async def test_a_pulled_prompt_tells_the_windows_without_failing_the_round(tmp_path, account_key, monkeypatch):
    """The engine applies a page in a worker thread; server_link's broadcast
    schedules a task, which only works on the loop. The round must finish and
    the windows must still hear about the change."""
    import asyncio

    server = StrictServer()
    a, _sa = _prompts_dev(tmp_path, server, "A", monkeypatch,
                          [{"id": "p1", "prompt": "1", "isDefault": True}, {"id": "p2", "prompt": "2"}])
    told = []

    async def deliver(delta):
        told.append(delta)

    def broadcast(delta):
        asyncio.get_running_loop().create_task(deliver(delta))  # what server_link._spawn does

    b, sb = _prompts_dev(tmp_path, server, "B", monkeypatch)
    b.adapter._broadcast = broadcast
    await a.sync()
    result = await b.sync()
    await asyncio.sleep(0.05)
    assert result["pulled"] == 2
    assert {s["id"] for s in sb.doc[sync_scopes.PROMPT_SKILLS_KEY]} == {"p1", "p2"}
    assert told


# ── mcp ──────────────────────────────────────────────────────────────────────
def _mcp(name):
    return {"name": name, "transport": "stdio", "command": "npx", "args": [], "env": {}, "enabled": True}


def test_a_refused_mcp_document_is_reported_not_swallowed(tmp_path, monkeypatch):
    from agent_team_backend.mcp_settings import MCPSettingsStore

    store = MCPSettingsStore(tmp_path / "mcp.json")
    store.replace_servers([_mcp(f"s{i}") for i in range(32)])  # the document's cap
    monkeypatch.setattr(app, "mcp_settings_store", store)
    scope = sync_scopes.McpScope()
    assert scope.apply("one-too-many", _mcp("one-too-many")) is False
    assert scope.apply("s0", "not an object") is False
    assert len(store.list_servers()) == 32


async def test_a_synced_mcp_change_reloads_the_servers_and_tells_the_windows(tmp_path, account_key, monkeypatch):
    import asyncio

    from agent_team_backend.mcp_settings import MCPSettingsStore

    server = StrictServer()
    a_store, b_store = MCPSettingsStore(tmp_path / "a.json"), MCPSettingsStore(tmp_path / "b.json")
    a_store.replace_servers([_mcp("docs")])
    changed = []

    async def on_change():
        changed.append(asyncio.get_running_loop())

    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=a_store)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.McpScope(on_change=on_change), mcp_settings_store=b_store)
    await a.sync()
    await b.sync()
    await asyncio.sleep(0.05)
    assert "docs" in {s["name"] for s in b_store.list_servers()}
    assert len(changed) == 1
    await b.sync()  # nothing new: no reload
    await asyncio.sleep(0.05)
    assert len(changed) == 1


async def test_an_mcp_conflict_preview_never_shows_env_or_header_values(tmp_path, account_key, monkeypatch):
    from agent_team_backend import server_link
    from agent_team_backend.mcp_settings import MCPSettingsStore

    server = StrictServer()
    a_store, b_store = MCPSettingsStore(tmp_path / "a.json"), MCPSettingsStore(tmp_path / "b.json")
    a_store.replace_servers([{**_mcp("api"), "env": {"API_KEY": "sk-from-a"}}])
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=a_store)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=b_store)
    await a.sync(); await b.sync()
    a.use(); a_store.replace_servers([{**_mcp("api"), "env": {"API_KEY": "sk-new-a"}}])
    b.use(); b_store.replace_servers([{**_mcp("api"), "env": {"API_KEY": "sk-new-b"}}])
    await a.sync(); await b.sync()
    monkeypatch.setattr(app, "sync_store", b.store)
    rows = server_link.sync_conflicts("mcp")
    assert rows and rows[0]["itemId"] == "api"
    text = repr(rows)
    assert "sk-" not in text
    assert rows[0]["local"]["env"] == {"API_KEY": sync_scopes.MASKED_VALUE}
    # resolve still works from the real payloads
    assert b.store.conflict_payloads("mcp", "api")["local"]["env"] == {"API_KEY": "sk-new-b"}


# ── skills: what export sends is what import takes ──────────────────────────
async def test_a_dotfile_in_a_skill_does_not_stop_it_syncing(tmp_path, account_key, monkeypatch):
    server, a, b, sa, ra, sb, rb = _skill_pair(tmp_path, monkeypatch)
    a.use(); sa.create_skill("tool", "t", consent=True)
    (ra / "tool" / ".env.example").write_bytes(b"X=1\n")
    assert ".env.example" not in sa.export_content("tool")  # import would refuse the whole skill
    revs = []
    for _ in range(3):
        await a.sync(); await b.sync()
        revs.append(server.rows[("skills", "tool")]["rev"])
    assert (rb / "tool" / "SKILL.md").is_file()
    assert revs[-1] == revs[0]  # settled


@pytest.mark.skipif(not sync_scopes._EXEC_BITS, reason="no executable bit on this platform")
async def test_a_small_skill_keeps_its_executable_bit(tmp_path, account_key, monkeypatch):
    import stat

    server, a, b, sa, ra, sb, rb = _skill_pair(tmp_path, monkeypatch)
    a.use(); sa.create_skill("runner", "r", consent=True)
    script = ra / "runner" / "scripts" / "go.sh"
    script.parent.mkdir(parents=True)
    script.write_bytes(b"#!/bin/sh\necho hi\n")
    script.chmod(0o755)
    (ra / "runner" / "notes.txt").write_bytes(b"plain\n")
    await a.sync(); await b.sync()
    landed = rb / "runner" / "scripts" / "go.sh"
    assert landed.stat().st_mode & stat.S_IXUSR
    assert not ((rb / "runner" / "notes.txt").stat().st_mode & stat.S_IXUSR)
    pushes = server.pushes
    await b.sync(); await a.sync()
    assert server.pushes == pushes  # the bit round-trips without a re-push


def test_a_skill_whose_files_are_refused_is_reported_not_held(tmp_path, monkeypatch):
    """Recording the decision anyway would put an entry without the files in
    the next snapshot, which pushes up and erases them from the cloud."""
    store, root = _skills(tmp_path, "B")
    monkeypatch.setattr(app, "skills_store", store)
    settings = FakeSettingsStore()
    monkeypatch.setattr(app, "ui_settings_store", settings)
    theirs = root / "tool"
    theirs.mkdir(parents=True)
    (theirs / "SKILL.md").write_text("---\nname: tool\ndescription: mine\n---\n")  # the user's own, unmarked
    scope = sync_scopes.SkillsStateScope()
    payload = {"enabled": True, "targets": None,
               "content": {"SKILL.md": {"t": "text", "v": "---\nname: tool\ndescription: x\n---\n"}}}
    assert scope.apply("tool", payload) is False
    assert (theirs / "SKILL.md").read_text().endswith("mine\n---\n")
    bad = {"enabled": True, "targets": None, "content": {"../escape": {"t": "text", "v": "x"}}}
    assert scope.apply("other", bad) is False
    assert "other" not in scope.snapshot()
    # A decision with no files still waits in the intent map, as before.
    assert scope.apply("elsewhere", {"enabled": False, "targets": []}) is not False
    assert scope.snapshot()["elsewhere"]["enabled"] is False


# ── memory: what does not travel is said, and an edit is never overwritten ──
async def test_a_memory_file_too_large_for_a_record_is_reported_and_kept(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    ha = _home(tmp_path, "a")
    (ha / ".claude" / "CLAUDE.md").write_text("x" * 400_000)  # under the editor's 1 MB, over a record
    (ha / ".codex").mkdir()
    (ha / ".codex" / "AGENTS.md").write_text("small\n")
    scope = sync_scopes.MemoryScope()
    a = Dev(tmp_path, server, "A", monkeypatch, scope, home=ha)
    await a.sync()
    assert ("memory", ".codex:AGENTS.md") in server.rows
    assert ("memory", ".claude:CLAUDE.md") not in server.rows
    assert scope.oversized() == [".claude:CLAUDE.md"]
    assert ".claude:CLAUDE.md" in scope.snapshot()  # held: absence would read as a delete


def test_memory_apply_does_not_overwrite_an_edit_made_since_the_snapshot(tmp_path, monkeypatch):
    import os

    home = _home(tmp_path, "h")
    target = home / ".claude" / "CLAUDE.md"
    target.write_text("before\n")
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    scope = sync_scopes.MemoryScope()
    scope.snapshot()                       # what the engine compared against
    target.write_text("typed just now\n")  # the editor saves mid-page
    os.utime(target, (1, 1))
    assert scope.apply(".claude:CLAUDE.md", {"text": "from the cloud\n"}) is False
    assert target.read_text() == "typed just now\n"


# ── security review C ────────────────────────────────────────────────────────
class _WindowsNames:
    """``osplat.paths`` as Windows answers the one question skills ask."""

    def file_name_refused(self, name):
        from agent_team_backend.osplat import spec

        return spec.windows_refused_file_name(name)


@pytest.fixture
def on_windows(monkeypatch):
    from agent_team_backend import osplat

    monkeypatch.setattr(osplat, "paths", _WindowsNames())


@pytest.mark.parametrize("relative", ["C:/Users/Public/evil.bat", "D:evil.bat", "SKILL.md:ads", "notes/a:b.md"])
def test_a_skill_path_naming_a_drive_or_stream_is_refused_everywhere(relative):
    from pathlib import PureWindowsPath

    from agent_team_backend import skills_store

    assert skills_store._safe_relative(relative) is None
    # What the refusal is for: on Windows these leave the staging dir or
    # write an alternate data stream.
    staging = PureWindowsPath(r"C:\Users\me\.agents\skills\.demo-abc123")
    joined = staging / relative
    assert not str(joined).lower().startswith(str(staging).lower()) or ":" in joined.name


_WINDOWS_ONLY = ["CON", "nul.txt", "scripts/Aux.md", "COM1", "lpt9.log", "aux.c", "trailing.", "trailing ", "dir./a.md"]


@pytest.mark.parametrize("relative", _WINDOWS_ONLY)
def test_a_name_windows_reserves_is_refused_on_windows(relative, on_windows):
    from agent_team_backend import skills_store

    assert skills_store._safe_relative(relative) is None


@pytest.mark.parametrize("relative", _WINDOWS_ONLY)
def test_a_name_windows_reserves_is_fine_elsewhere(relative, monkeypatch):
    from agent_team_backend import osplat, skills_store
    from agent_team_backend.osplat import _posix_paths

    class Posix:
        def file_name_refused(self, name):
            return _posix_paths.file_name_refused(name)

    monkeypatch.setattr(osplat, "paths", Posix())
    assert skills_store._safe_relative(relative) == relative


@pytest.mark.parametrize("relative", ["SKILL.md", "scripts/run.sh", "console.md", "com10.txt", "a.b/c.md"])
def test_ordinary_skill_paths_still_pass(relative, on_windows):
    from agent_team_backend import skills_store

    assert skills_store._safe_relative(relative) == relative


def test_import_refuses_a_file_that_would_land_outside_the_skill(tmp_path, on_windows):
    from agent_team_backend import skills_store

    store, root = _skills(tmp_path, "S")
    outside = tmp_path / "outside"
    outside.mkdir()
    for relative in ("C:/evil.bat", "SKILL.md:ads", "CON"):
        assert store.import_content("demo", {
            "SKILL.md": {"t": "text", "v": "---\nname: demo\ndescription: d\n---\n"},
            relative: {"t": "text", "v": "x"}}) is False
        src = tmp_path / "blob"
        src.write_bytes(b"x")
        assert store.import_files("demo", {"SKILL.md": src, relative: src}) is False
    assert not (root / "demo").exists()


async def test_a_local_file_this_machine_cannot_read_is_never_overwritten(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    ha, hb = _home(tmp_path, "a"), _home(tmp_path, "b")
    (ha / ".claude" / "CLAUDE.md").write_text("from A\n")
    big = "B" * (native_memory.FILE_SIZE_LIMIT + 10)
    (hb / ".claude" / "CLAUDE.md").write_text(big)
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.MemoryScope(), home=ha)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.MemoryScope(), home=hb)
    await a.sync()
    await b.sync()
    assert (hb / ".claude" / "CLAUDE.md").read_text() == big


def test_a_dangling_link_is_not_written_through(tmp_path, monkeypatch):
    home = _home(tmp_path, "h")
    outside = tmp_path / "outside" / "deep" / "new.txt"
    (home / ".claude" / "CLAUDE.md").symlink_to(outside)
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    assert sync_scopes.MemoryScope().apply(".claude:CLAUDE.md", {"text": "pwn\n"}) is False
    assert not (tmp_path / "outside").exists()
    with pytest.raises(ValueError):
        native_memory.save(str(home / ".claude" / "CLAUDE.md"), "pwn\n", home=home)
    assert not (tmp_path / "outside").exists()


def test_memory_item_ids_are_one_to_one():
    import hashlib
    import random

    long = ".cursor/rules/" + "x" * 250 + ".mdc"
    digest = hashlib.sha256(long.encode()).hexdigest()
    assert sync_scopes.memory_item_id(long) != sync_scopes.memory_item_id("sha256/" + digest)
    assert sync_scopes.memory_item_id(long) != sync_scopes.memory_item_id("sha256:" + digest)
    assert ITEM_ID.match(sync_scopes.memory_item_id(long))
    rnd = random.Random(1)
    alphabet = list("ab./:+@-_ %Z9") + ["\u00e9", "e\u0301", "\\", "\x00", "規"]
    seen: dict[str, str] = {}
    for _ in range(20000):
        s = "".join(rnd.choice(alphabet) for _ in range(rnd.randint(1, 12)))
        assert seen.setdefault(sync_scopes.memory_item_id(s), s) == s


# ── security re-review C ─────────────────────────────────────────────────────
@pytest.mark.parametrize("name", ["COM¹", "com².txt", "LPT³", "con .txt", "NUL  .md", "CONIN$", "conout$.log"])
def test_windows_rule_covers_superscript_ports_and_spaced_names(name):
    from agent_team_backend.osplat.spec import windows_refused_file_name

    assert windows_refused_file_name(name)


@pytest.mark.parametrize("name", ["console.md", "com10.txt", "COM0", "connect.py", "a.b"])
def test_windows_rule_leaves_ordinary_names(name):
    from agent_team_backend.osplat.spec import windows_refused_file_name

    assert not windows_refused_file_name(name)


def _synced_pair(tmp_path, monkeypatch):
    server = StrictServer()
    ha, hb = _home(tmp_path, "a"), _home(tmp_path, "b")
    (ha / ".claude" / "CLAUDE.md").write_text("from A\n")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.MemoryScope(), home=ha)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.MemoryScope(), home=hb)
    return server, a, b, ha / ".claude" / "CLAUDE.md", hb / ".claude" / "CLAUDE.md"


@pytest.mark.parametrize("replace", ["directory", "link-to-directory", "fifo"])
async def test_a_memory_path_that_stops_being_a_file_never_pushes_empty_text(tmp_path, account_key, monkeypatch, replace):
    import os

    if replace == "fifo" and not hasattr(os, "mkfifo"):
        pytest.skip("no FIFOs here")
    server, a, b, pa, pb = _synced_pair(tmp_path, monkeypatch)
    await a.sync(); await b.sync()
    assert pb.read_text() == "from A\n"
    pb.unlink()
    if replace == "directory":
        pb.mkdir()
    elif replace == "link-to-directory":
        (tmp_path / "somedir").mkdir()
        pb.symlink_to(tmp_path / "somedir")
    else:
        os.mkfifo(pb)
    b.use()
    assert ".claude:CLAUDE.md" not in sync_scopes.MemoryScope().snapshot()
    await b.sync(); await a.sync()
    assert pa.read_text() == "from A\n"


async def test_memory_that_is_not_utf8_is_not_sent(tmp_path, account_key, monkeypatch):
    server, a, b, pa, pb = _synced_pair(tmp_path, monkeypatch)
    pa.write_bytes(b"caf\xe9 latin1\n")
    a.use()
    scope = sync_scopes.MemoryScope()
    assert ".claude:CLAUDE.md" not in scope.snapshot()
    await a.sync()
    assert ("memory", ".claude:CLAUDE.md") not in server.rows
    assert pa.read_bytes() == b"caf\xe9 latin1\n"


async def test_an_mcp_conflict_preview_says_which_masked_values_differ(tmp_path, account_key, monkeypatch):
    from agent_team_backend import server_link
    from agent_team_backend.mcp_settings import MCPSettingsStore

    server = StrictServer()
    a_store, b_store = MCPSettingsStore(tmp_path / "a.json"), MCPSettingsStore(tmp_path / "b.json")
    base = {**_mcp("api"), "env": {"KEY": "k0", "SAME": "s"}}
    a_store.replace_servers([base])
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=a_store)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=b_store)
    await a.sync(); await b.sync()
    a.use(); a_store.replace_servers([{**base, "env": {"KEY": "ka", "SAME": "s", "ONLY_A": "x"}}])
    b.use(); b_store.replace_servers([{**base, "env": {"KEY": "kb", "SAME": "s"}}])
    await a.sync(); await b.sync()
    monkeypatch.setattr(app, "sync_store", b.store)
    row = server_link.sync_conflicts("mcp")[0]
    assert row["masked"] == {"env": {"KEY": "differs", "SAME": "same", "ONLY_A": "remote-only"}}
    assert "ka" not in repr(row) and "kb" not in repr(row)

    remote_row = {"scope": "mcp", "itemId": "web", "sealed": False,
                  "local": {"name": "web", "url": "https://x", "headers": {"Authorization": "t0", "X-Old": "o"}},
                  "remote": {"name": "web", "url": "https://x", "headers": {"Authorization": "t0"}}}
    (preview,) = sync_scopes.conflict_preview([remote_row])
    assert preview["masked"] == {"headers": {"Authorization": "same", "X-Old": "local-only"}}


def test_a_stale_round_does_not_write_detach_marks(monkeypatch):
    """A round begun for the previous account (sync-core's round_is_current
    says so) must not write its marks into the next account's settings."""
    settings = FakeSettingsStore()
    monkeypatch.setattr(app, "ui_settings_store", settings)
    monkeypatch.setattr(sync_engine, "round_is_current", lambda: False, raising=False)
    sync_scopes.detach("memory", ".claude:CLAUDE.md", {"text": "x"})
    assert sync_scopes.DETACHED_KEY not in settings.doc
    monkeypatch.setattr(sync_engine, "round_is_current", lambda: True, raising=False)
    sync_scopes.detach("memory", ".claude:CLAUDE.md", {"text": "x"})
    assert ".claude:CLAUDE.md" in settings.doc[sync_scopes.DETACHED_KEY]["memory"]
