"""Cross-device sync: the engine, the keyring, and the prompts adapter.

The engine is driven against ``FakeServer`` — an in-memory implementation of
``docs/en-US/cloud-sync-protocol.md`` — rather than a mock, because the
behaviour worth protecting is the *conversation*: a push that carries a stale
``baseRev`` has to come back as a conflict, and nothing below is true if the
server half is a stub that always says yes.

Two devices are simulated by two (store, adapter, engine) triples sharing one
FakeServer and one account key, which is exactly the real arrangement.
"""

from __future__ import annotations

import re

import pytest

from agent_team_backend import device_signing, sync_engine, sync_keyring, sync_scopes
from agent_team_backend.db import Database


# ── the far end ──────────────────────────────────────────────────────────────
class FakeServer:
    """Accounts-scoped record store with the protocol's conflict rule.

    Mirrors Navide-Server ``server/src/handlers/sync.ts`` where it matters:
    item ids are checked against the server's pattern, ``cursor`` is the
    scope's current maximum rev (not the last rev of the page), ``more`` is
    "the page is full and its last row is still below the cursor", and a
    conflict on a row the server does not hold comes back as a rev-0
    tombstone rather than nothing.
    """

    ITEM_ID = re.compile(r"^[A-Za-z0-9._:@+-]{1,200}$")
    MAX_ITEMS = 64
    MAX_BODY = 512 * 1024
    MAX_PUSH_TOTAL = 768 * 1024
    MAX_PULL_PAGE = 500
    DEFAULT_PULL_PAGE = 200

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict] = {}
        self.cursors: dict[str, int] = {}
        self.pushes = 0

    async def request(self, msg_type: str, payload: dict) -> dict:
        try:
            if msg_type == "sync.pull":
                return {"ok": True, "payload": self._pull(payload)}
            if msg_type == "sync.push":
                self.pushes += 1
                return {"ok": True, "payload": self._push(payload)}
        except _BadRequest as err:
            return {"ok": False, "error": {"code": "BAD_REQUEST", "message": str(err)}}
        return {"ok": False, "error": {"code": "BAD_REQUEST", "message": msg_type}}

    def _pull(self, payload: dict) -> dict:
        scope = payload["scope"]
        since = int(payload.get("since") or 0)
        limit = payload.get("limit")
        limit = self.DEFAULT_PULL_PAGE if limit is None else int(limit)
        if limit < 1 or limit > self.MAX_PULL_PAGE:
            raise _BadRequest(f"limit must be in 1..{self.MAX_PULL_PAGE}")
        cursor = self.cursors.get(scope, 0)
        items = sorted(
            (dict(r) for (s, _), r in self.rows.items() if s == scope and r["rev"] > since),
            key=lambda r: r["rev"],
        )
        page = items[:limit]
        return {
            "scope": scope,
            "cursor": cursor,
            "items": page,
            "more": len(page) == limit and page[-1]["rev"] < cursor,
        }

    def _parse_push(self, raw: list) -> list[dict]:
        if len(raw) > self.MAX_ITEMS:
            raise _BadRequest(f"at most {self.MAX_ITEMS} items")
        seen: set[str] = set()
        total = 0
        for item in raw:
            item_id = item.get("itemId") if isinstance(item.get("itemId"), str) else ""
            if not self.ITEM_ID.match(item_id):
                raise _BadRequest(f"itemId does not match: {item_id[:64]}")
            if item_id in seen:
                raise _BadRequest(f"duplicate itemId: {item_id}")
            seen.add(item_id)
            if not item.get("updatedAt"):
                raise _BadRequest("updatedAt is required")
            deleted = item.get("deleted") in (1, True)
            body = item.get("body") or ""
            if deleted and body:
                raise _BadRequest("a deleted item may not carry a body")
            if not deleted and not body:
                raise _BadRequest("a live item must carry a body")
            size = len(body.encode("utf-8"))
            if size > self.MAX_BODY:
                raise _BadRequest("body too large")
            total += size
            if total > self.MAX_PUSH_TOTAL:
                raise _BadRequest("push too large")
        return raw

    def _push(self, payload: dict) -> dict:
        scope = payload["scope"]
        items = self._parse_push(payload["items"])
        accepted, conflicts = [], []
        for item in items:
            item_id = item["itemId"]
            current = self.rows.get((scope, item_id))
            current_rev = int(current["rev"]) if current else 0
            if int(item.get("baseRev") or 0) != current_rev:
                conflicts.append(dict(current) if current else self.absent(item_id))
                continue
            rev = self.cursors.get(scope, 0) + 1
            self.cursors[scope] = rev
            deleted = 1 if item.get("deleted") in (1, True) else 0
            self.rows[(scope, item_id)] = {
                "itemId": item_id,
                "rev": rev,
                "updatedAt": item["updatedAt"],
                "deviceId": item.get("deviceId") or item.get("_device") or "",
                "deleted": deleted,
                "body": (item.get("body") or None) if not deleted else None,
                "sig": item.get("sig") or None,
            }
            accepted.append({"itemId": item_id, "rev": rev})
        return {
            "scope": scope,
            "cursor": self.cursors.get(scope, 0),
            "accepted": accepted,
            "conflicts": conflicts,
        }

    @staticmethod
    def absent(item_id: str) -> dict:
        """The server's answer for a conflict on a row it does not hold."""
        return {
            "itemId": item_id, "rev": 0, "updatedAt": None, "deviceId": None,
            "deleted": 1, "body": None, "sig": None,
        }


class _BadRequest(Exception):
    pass


class DictScope:
    """A scope adapter backed by a plain dict."""

    def __init__(self, scope: str = "prompts", items: dict | None = None) -> None:
        self.scope = scope
        self.items = dict(items or {})

    def snapshot(self) -> dict:
        return dict(self.items)

    def apply(self, item_id: str, payload) -> None:
        if payload is None:
            self.items.pop(item_id, None)
        else:
            self.items[item_id] = payload


class Device:
    """One machine: its own local state, its own view, one shared server."""

    def __init__(self, tmp_path, server: FakeServer, name: str, items=None) -> None:
        self.name = name
        self.adapter = DictScope(items=items)
        self.store = sync_engine.SyncStore(Database(tmp_path / f"{name}.db"))

        async def request(msg_type: str, payload: dict) -> dict:
            if msg_type == "sync.push":
                for item in payload["items"]:
                    item["deviceId"] = name
            return await server.request(msg_type, payload)

        self.engine = sync_engine.SyncEngine(
            self.store,
            request,
            device_id=lambda: name,
            enabled=lambda _scope: True,
            # Every simulated device signs with this process's one key, and
            # each is pinned: the real arrangement for an account's own devices.
            signing_key_for=lambda _device: self.own_key,
        )
        self.engine.register(self.adapter)

    @property
    def own_key(self) -> str:
        return device_signing.public_key()

    async def sync(self) -> dict:
        return await self.engine.sync("prompts")


@pytest.fixture
def account_key():
    sync_keyring.ensure_account_key()
    yield
    sync_keyring.forget_account_key()


# ── the keyring ──────────────────────────────────────────────────────────────
def test_record_round_trips_under_the_account_key(account_key):
    wire = sync_keyring.encrypt('{"a":1}', scope="prompts", item_id="p1")
    assert sync_keyring.decrypt(wire, scope="prompts", item_id="p1") == '{"a":1}'


def test_a_record_cannot_be_replayed_as_another_item(account_key):
    """Scope and item are AEAD associated data, so a lifted body will not open."""
    wire = sync_keyring.encrypt('{"a":1}', scope="prompts", item_id="p1")
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.decrypt(wire, scope="prompts", item_id="p2")
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.decrypt(wire, scope="mcp", item_id="p1")


def test_encrypt_refuses_without_a_key():
    sync_keyring.forget_account_key()
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.encrypt("{}", scope="prompts", item_id="p1")


def test_a_second_account_key_is_refused_not_adopted(account_key, monkeypatch):
    """Adopting it would make everything already written unreadable, silently."""
    from agent_team_backend import device_crypto

    other = sync_keyring._encode(b"\x01" * 32)
    monkeypatch.setattr(device_crypto, "open_sealed", lambda *a, **k: other)
    with pytest.raises(sync_keyring.KeyConflict):
        sync_keyring.accept_wrapped("ignored", from_device="dev-b", to_device="dev-a")


# ── one device, one round ────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_a_new_item_reaches_the_other_device(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "hello"}})
    b = Device(tmp_path, server, "dev-b")

    await a.sync()
    await b.sync()

    assert b.adapter.items == {"p1": {"id": "p1", "prompt": "hello"}}


@pytest.mark.asyncio
async def test_nothing_is_pushed_twice(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "hello"}})
    await a.sync()
    pushes = server.pushes
    await a.sync()
    # The second round finds the snapshot hash unchanged and sends no batch.
    assert server.pushes == pushes


@pytest.mark.asyncio
async def test_a_delete_propagates(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "hello"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()

    a.adapter.items.pop("p1")
    await a.sync()
    await b.sync()

    assert b.adapter.items == {}


# ── the rule that matters: never overwrite silently ──────────────────────────
@pytest.mark.asyncio
async def test_two_devices_editing_one_item_conflict_rather_than_overwrite(
    tmp_path, account_key
):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "one"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    assert b.adapter.items["p1"]["prompt"] == "one"

    a.adapter.items["p1"] = {"id": "p1", "prompt": "from A"}
    b.adapter.items["p1"] = {"id": "p1", "prompt": "from B"}
    await a.sync()
    await b.sync()

    # B's edit is untouched on disk and the clash is recorded for the user.
    assert b.adapter.items["p1"]["prompt"] == "from B"
    conflicts = b.store.conflicts("prompts")
    assert [c["itemId"] for c in conflicts] == ["p1"]
    assert conflicts[0]["local"]["prompt"] == "from B"
    assert conflicts[0]["remote"]["prompt"] == "from A"


@pytest.mark.asyncio
async def test_a_pull_never_lands_on_an_unpushed_local_edit(tmp_path, account_key):
    """B edits offline; A's change arrives first. B's work must survive."""
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "one"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()

    b.adapter.items["p1"] = {"id": "p1", "prompt": "B was offline"}
    a.adapter.items["p1"] = {"id": "p1", "prompt": "A won the race"}
    await a.sync()
    await b.engine._pull(b.adapter)  # pull only: the half that could overwrite

    assert b.adapter.items["p1"]["prompt"] == "B was offline"
    assert b.store.conflict_ids("prompts") == {"p1"}


@pytest.mark.asyncio
async def test_a_conflicted_item_is_skipped_by_both_directions(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "one"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    a.adapter.items["p1"] = {"id": "p1", "prompt": "from A"}
    b.adapter.items["p1"] = {"id": "p1", "prompt": "from B"}
    await a.sync()
    await b.sync()

    pushes = server.pushes
    await b.sync()
    assert server.pushes == pushes           # nothing sent while unresolved
    assert b.adapter.items["p1"]["prompt"] == "from B"  # nothing applied either


# ── resolving ────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_keeping_the_remote_copy_writes_it_in(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "one"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    a.adapter.items["p1"] = {"id": "p1", "prompt": "from A"}
    b.adapter.items["p1"] = {"id": "p1", "prompt": "from B"}
    await a.sync()
    await b.sync()

    b.engine.resolve("prompts", "p1", sync_engine.KEEP_REMOTE)
    assert b.adapter.items["p1"]["prompt"] == "from A"
    assert b.store.conflict_ids("prompts") == set()

    pushes = server.pushes
    await b.sync()
    assert server.pushes == pushes  # agreed with the server: nothing to send


@pytest.mark.asyncio
async def test_keeping_the_local_copy_wins_the_next_round(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "one"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    a.adapter.items["p1"] = {"id": "p1", "prompt": "from A"}
    b.adapter.items["p1"] = {"id": "p1", "prompt": "from B"}
    await a.sync()
    await b.sync()

    b.engine.resolve("prompts", "p1", sync_engine.KEEP_LOCAL)
    await b.sync()
    await a.sync()

    assert a.adapter.items["p1"]["prompt"] == "from B"


@pytest.mark.asyncio
async def test_resolve_rejects_an_unknown_choice(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b")
    with pytest.raises(sync_engine.SyncError):
        b.engine.resolve("prompts", "p1", "whatever")


# ── gates ────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_a_disabled_scope_never_reaches_the_wire(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1"}})
    a.engine._enabled = lambda _scope: False
    result = await a.sync()
    assert result["skipped"] == "disabled"
    assert server.pushes == 0


@pytest.mark.asyncio
async def test_no_account_key_means_no_sync_not_plaintext(tmp_path):
    sync_keyring.forget_account_key()
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1"}})
    result = await a.sync()
    assert result["skipped"] == "no-key"
    assert server.rows == {}


# ── the prompts adapter ──────────────────────────────────────────────────────
def test_prompts_scope_reads_and_writes_the_settings_list(monkeypatch):
    from agent_team_backend import app

    class FakeSettings:
        def __init__(self):
            self.doc = {}

        def get(self):
            return dict(self.doc)

        def set(self, updates):
            self.doc.update(updates)
            return dict(updates)

    fake = FakeSettings()
    monkeypatch.setattr(app, "ui_settings_store", fake)
    scope = sync_scopes.PromptsScope(gate=False)  # the approval hold has its own tests

    scope.apply("p1", {"id": "p1", "prompt": "hello", "isDefault": True})
    assert scope.snapshot() == {"p1": {"id": "p1", "prompt": "hello", "isDefault": True}}
    # The renderer mirrors the default skill's prompt; a backend write must too.
    assert fake.doc[sync_scopes.LOOP_PROMPT_KEY] == "hello"

    scope.apply("p1", None)
    assert scope.snapshot() == {}


def test_exactly_one_prompt_stays_the_default(monkeypatch):
    """Two devices each promoting a different skill must not produce two."""
    from agent_team_backend import app

    class FakeSettings:
        def __init__(self):
            self.doc = {
                sync_scopes.PROMPT_SKILLS_KEY: [
                    {"id": "p1", "isDefault": True},
                    {"id": "p2", "isDefault": False},
                ]
            }

        def get(self):
            return dict(self.doc)

        def set(self, updates):
            self.doc.update(updates)
            return dict(updates)

    fake = FakeSettings()
    monkeypatch.setattr(app, "ui_settings_store", fake)
    scope = sync_scopes.PromptsScope()

    scope.apply("p2", {"id": "p2", "isDefault": True})
    defaults = [s["id"] for s in fake.doc[sync_scopes.PROMPT_SKILLS_KEY] if s["isDefault"]]
    assert len(defaults) == 1


# ── the MCP adapter ──────────────────────────────────────────────────────────
class FakeMcpStore:
    def __init__(self, servers=None):
        self.servers = list(servers or [])

    def list_servers(self):
        return [dict(s) for s in self.servers]

    def replace_servers(self, servers, expected_revision=None):
        self.servers = [dict(s) for s in servers]
        return self.list_servers()


def test_mcp_scope_round_trips_a_server(monkeypatch):
    from agent_team_backend import app

    store = FakeMcpStore([{"name": "one", "url": "https://example.test"}])
    monkeypatch.setattr(app, "mcp_settings_store", store)
    scope = sync_scopes.McpScope(gate=False)  # the approval hold has its own tests

    assert set(scope.snapshot()) == {"one"}
    scope.apply("two", {"name": "two", "url": "https://other.test"})
    assert set(scope.snapshot()) == {"one", "two"}
    scope.apply("one", None)
    assert set(scope.snapshot()) == {"two"}


def test_mcp_scope_never_reads_the_native_reflection(monkeypatch):
    """Only Navide's own records sync; a CLI's own config file is not ours."""
    from agent_team_backend import app

    store = FakeMcpStore([{"name": "one"}])
    calls = []
    store.list_native = lambda: calls.append("native") or []  # type: ignore[attr-defined]
    monkeypatch.setattr(app, "mcp_settings_store", store)
    sync_scopes.McpScope().snapshot()
    assert calls == []


# ── the skills decision adapter ──────────────────────────────────────────────
class FakeSkillsStore:
    def __init__(self, names=()):
        self.skills = {n: {"enabled": True, "targets": None} for n in names}
        self.calls = []

    def list_skills(self):
        return {
            "skills": [
                {"name": n, "enabled": v["enabled"], "targets": v["targets"]}
                for n, v in self.skills.items()
            ]
        }

    def set_enabled(self, name, enabled):
        self.calls.append(("enabled", name, enabled))
        self.skills[name]["enabled"] = enabled

    def set_targets(self, name, agents):
        self.calls.append(("targets", name, agents))
        self.skills[name]["targets"] = agents


class FakeSettingsStore:
    def __init__(self, doc=None):
        self.doc = dict(doc or {})

    def get(self):
        return dict(self.doc)

    def set(self, updates):
        self.doc.update(updates)
        return dict(updates)


def test_a_decision_for_an_absent_skill_is_remembered_not_dropped(monkeypatch):
    """Otherwise the next snapshot lacks it, and the engine reads that as a
    delete — one machine missing a skill would switch it off everywhere."""
    from agent_team_backend import app

    skills = FakeSkillsStore()  # this machine has no skills at all
    monkeypatch.setattr(app, "skills_store", skills)
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    scope = sync_scopes.SkillsStateScope()

    scope.apply("writer", {"enabled": False, "targets": ["codex"]})

    assert scope.snapshot() == {"writer": {"enabled": False, "targets": ["codex"]}}
    assert skills.calls == []  # nothing applied: the skill is not here


def test_a_decision_for_a_present_skill_is_applied(monkeypatch):
    from agent_team_backend import app

    skills = FakeSkillsStore(["writer"])
    monkeypatch.setattr(app, "skills_store", skills)
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    scope = sync_scopes.SkillsStateScope()

    scope.apply("writer", {"enabled": False, "targets": ["codex"]})

    assert ("enabled", "writer", False) in skills.calls
    assert ("targets", "writer", ["codex"]) in skills.calls


def test_what_is_installed_here_wins_over_what_was_remembered(monkeypatch):
    from agent_team_backend import app

    skills = FakeSkillsStore(["writer"])
    monkeypatch.setattr(app, "skills_store", skills)
    monkeypatch.setattr(
        app,
        "ui_settings_store",
        FakeSettingsStore({sync_scopes.SKILLS_INTENT_KEY: {"writer": {"enabled": False, "targets": []}}}),
    )
    snap = sync_scopes.SkillsStateScope().snapshot()
    assert snap["writer"]["enabled"] is True  # the store, not the stale intent


# ── the memory adapter ───────────────────────────────────────────────────────
def test_memory_scope_lists_user_scope_files_only(monkeypatch, tmp_path):
    from agent_team_backend import native_memory, sync_scopes as scopes

    # Real files: the adapter checks each one is a readable UTF-8 file.
    (tmp_path / "home.md").write_text("home\n")
    (tmp_path / "repo.md").write_text("repo\n")

    class FakeFile:
        def __init__(self, scope, relative, path):
            self.scope, self.relative, self.path = scope, relative, path
            self.exists, self.error = True, ""
            self.readers = ("claude",)

    files = [
        FakeFile(native_memory.USER_SCOPE, ".claude/CLAUDE.md", str(tmp_path / "home.md")),
        FakeFile(native_memory.PROJECT_SCOPE, "CLAUDE.md", str(tmp_path / "repo.md")),
    ]
    monkeypatch.setattr(native_memory, "scan", lambda *a, **k: files)
    monkeypatch.setattr(native_memory, "read", lambda path, *a, **k: {"text": f"text of {path}", "exists": True})

    snap = scopes.MemoryScope().snapshot()
    assert set(snap) == {".claude:CLAUDE.md"}


def test_memory_scope_refuses_to_delete_a_users_file(monkeypatch):
    """A delete arriving from another machine must not remove an instruction
    file here — it is the user's file, not ours."""
    from agent_team_backend import native_memory, sync_scopes as scopes

    saved = []
    monkeypatch.setattr(native_memory, "save", lambda *a, **k: saved.append(a))
    scopes.MemoryScope().apply(".claude/CLAUDE.md", None)
    assert saved == []


# ── skill content (Phase 4) ──────────────────────────────────────────────────
def _make_store(tmp_path, monkeypatch):
    from agent_team_backend.skills_store import SkillsStore

    root = tmp_path / "agents" / "skills"
    store = SkillsStore(
        root=root,
        state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime",
        native_roots=[tmp_path / "native"],
    )
    return store, root


def test_content_travels_for_a_skill_navide_created(tmp_path, monkeypatch):
    store, root = _make_store(tmp_path, monkeypatch)
    store.create_skill("writer", "writes", consent=True)
    (root / "writer" / "scripts").mkdir(parents=True)
    # write_bytes, not write_text: on Windows the text mode turns "\n" into
    # "\r\n" on disk, and export_content reads bytes verbatim (a script must
    # travel unchanged), so a text-mode fixture would assert a different file
    # there than here.
    (root / "writer" / "scripts" / "go.sh").write_bytes(b"echo hi\n")

    content = store.export_content("writer")
    assert content is not None
    assert "SKILL.md" in content
    assert content["scripts/go.sh"] == {"t": "text", "v": "echo hi\n"}
    # The marker is recreated on the far side, never carried.
    assert ".navide" not in content


def test_content_does_not_travel_for_the_users_own_skill(tmp_path, monkeypatch):
    store, root = _make_store(tmp_path, monkeypatch)
    theirs = root / "theirs"
    theirs.mkdir(parents=True)
    (theirs / "SKILL.md").write_text("---\nname: theirs\n---\nbody\n", encoding="utf-8")

    assert store.export_content("theirs") is None


def test_build_artefacts_are_not_uploaded(tmp_path, monkeypatch):
    store, root = _make_store(tmp_path, monkeypatch)
    store.create_skill("tooling", "", consent=True)
    cache = root / "tooling" / "__pycache__"
    cache.mkdir()
    (cache / "x.cpython-314.pyc").write_bytes(b"\x00\x01")
    (root / "tooling" / ".DS_Store").write_bytes(b"\x00")

    content = store.export_content("tooling")
    assert content is not None
    assert list(content) == ["SKILL.md"]


def test_incoming_content_lands_as_a_managed_skill(tmp_path, monkeypatch):
    store, root = _make_store(tmp_path, monkeypatch)
    ok = store.import_content(
        "arrived",
        {
            "SKILL.md": {"t": "text", "v": "---\nname: arrived\ndescription: d\n---\nbody\n"},
            "refs/note.md": {"t": "text", "v": "note\n"},
        },
    )
    assert ok is True
    assert (root / "arrived" / "SKILL.md").is_file()
    assert (root / "arrived" / "refs" / "note.md").read_text() == "note\n"
    assert (root / "arrived" / ".navide").is_file()  # ours, so ours to edit later


def test_incoming_content_never_displaces_the_users_own_skill(tmp_path, monkeypatch):
    """The one outcome this whole feature must never produce."""
    store, root = _make_store(tmp_path, monkeypatch)
    theirs = root / "writer"
    theirs.mkdir(parents=True)
    (theirs / "SKILL.md").write_text("the user's own\n", encoding="utf-8")

    ok = store.import_content(
        "writer", {"SKILL.md": {"t": "text", "v": "from another machine\n"}}
    )

    assert ok is False
    assert (theirs / "SKILL.md").read_text() == "the user's own\n"


def test_incoming_content_refuses_a_path_that_climbs_out(tmp_path, monkeypatch):
    store, root = _make_store(tmp_path, monkeypatch)
    for bad in ("../escape.md", "/etc/passwd", "a/../../b.md", "", "sub/"):
        ok = store.import_content(
            "evil", {"SKILL.md": {"t": "text", "v": "x"}, bad: {"t": "text", "v": "x"}}
        )
        assert ok is False, bad
    assert not (root / "evil").exists()
    assert not (tmp_path / "escape.md").exists()


def test_incoming_content_without_a_skill_file_is_refused(tmp_path, monkeypatch):
    store, root = _make_store(tmp_path, monkeypatch)
    assert store.import_content("empty", {"notes.md": {"t": "text", "v": "x"}}) is False
    assert not (root / "empty").exists()


def test_binary_attachments_survive_the_round_trip(tmp_path, monkeypatch):
    store, root = _make_store(tmp_path, monkeypatch)
    store.create_skill("art", "", consent=True)
    raw = bytes(range(256))
    (root / "art" / "logo.bin").write_bytes(raw)

    content = store.export_content("art")
    assert content["logo.bin"]["t"] == "b64"

    store2, root2 = _make_store(tmp_path / "second", monkeypatch)
    assert store2.import_content("art", content) is True
    assert (root2 / "art" / "logo.bin").read_bytes() == raw


# ── handing the account key to a second device ───────────────────────────────
def _bare_link():
    """A ServerLink with no connection: only the key decisions are exercised."""
    from agent_team_backend import server_link

    link = server_link.ServerLink(connect=lambda url: None, config_loader=lambda: None)
    link._device_id = "dev-a"
    return link


@pytest.mark.asyncio
async def test_the_first_device_of_an_account_mints_the_key(monkeypatch):
    from agent_team_backend import server_link, trust_store

    monkeypatch.setattr(trust_store, "load", lambda: {"pins": {}})
    link = _bare_link()
    sent: list = []
    monkeypatch.setattr(link, "_send_pair_frame", lambda *a, **k: sent.append(a))

    assert await link.ensure_sync_key() is True
    assert sync_keyring.has_account_key() is True
    assert sent == []  # nobody to ask
    sync_keyring.forget_account_key()


@pytest.mark.asyncio
async def test_a_machine_with_paired_peers_never_mints_a_second_key(monkeypatch):
    """The failure this guards against is silent: both sides keep working, and
    each writes records the other can never read."""
    from agent_team_backend import server_link, trust_store

    monkeypatch.setattr(trust_store, "load", lambda: {"pins": {"dev-b": {}}})
    monkeypatch.setattr(server_link, "SYNC_KEY_WAIT_S", 0.3)
    link = _bare_link()
    asked: list = []

    async def _send(device_id, kind, **fields):
        asked.append((device_id, kind))
        return True

    monkeypatch.setattr(link, "_send_pair_frame", _send)

    assert await link.ensure_sync_key() is False
    assert sync_keyring.has_account_key() is False
    assert asked == [("dev-b", server_link.SYNC_KEY_REQUEST)]


@pytest.mark.asyncio
async def test_an_offer_from_a_paired_device_is_adopted(monkeypatch, account_key):
    """The offer is opened with this device's own key, so the round trip is
    driven through device_crypto rather than a stub."""
    from agent_team_backend import device_crypto, server_link

    wanted = sync_keyring.account_key()
    sync_keyring.forget_account_key()
    link = _bare_link()
    monkeypatch.setattr(link, "_spawn", lambda coro: coro.close())
    sealed = device_crypto.seal(
        sync_keyring._encode(wanted),
        recipient_public_key=device_crypto.public_key(),
        from_device="dev-b",
        to_device="dev-a",
    )

    await link._adopt_sync_key("dev-b", sealed)

    assert sync_keyring.account_key() == wanted
    sync_keyring.forget_account_key()


@pytest.mark.asyncio
async def test_a_different_key_is_reported_and_the_held_one_survives(monkeypatch, account_key):
    from agent_team_backend import device_crypto, server_link

    mine = sync_keyring.account_key()
    link = _bare_link()
    monkeypatch.setattr(link, "_spawn", lambda coro: coro.close())
    theirs = device_crypto.seal(
        sync_keyring._encode(b"\x02" * 32),
        recipient_public_key=device_crypto.public_key(),
        from_device="dev-b",
        to_device="dev-a",
    )

    await link._adopt_sync_key("dev-b", theirs)

    assert sync_keyring.account_key() == mine  # kept, not replaced


@pytest.mark.asyncio
async def test_a_device_without_a_key_offers_nothing(monkeypatch):
    from agent_team_backend import server_link

    sync_keyring.forget_account_key()
    link = _bare_link()
    sent: list = []
    monkeypatch.setattr(link, "_send_pair_frame", lambda *a, **k: sent.append(a))

    assert await link._offer_sync_key("dev-b") is False
    assert sent == []


# ── the blocking half stays off the event loop ───────────────────────────────
@pytest.mark.asyncio
async def test_the_disk_work_of_a_round_runs_in_a_worker_thread(tmp_path, account_key):
    """A round reads every skill tree and instruction file and encrypts each
    record. On the loop that is a stall the backend's own watchdog calls a
    fault at two seconds, so the adapter must be touched from a worker."""
    import threading

    server = FakeServer()
    device = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "hello"}})
    loop_thread = threading.get_ident()
    seen: list[int] = []

    original = device.adapter.snapshot
    device.adapter.snapshot = lambda: (seen.append(threading.get_ident()), original())[1]

    await device.sync()

    assert seen, "the adapter was never asked what it holds"
    assert loop_thread not in seen, "snapshot() ran on the event loop thread"


@pytest.mark.asyncio
async def test_incoming_items_are_applied_off_the_loop_too(tmp_path, account_key):
    import threading

    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "hello"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()

    loop_thread = threading.get_ident()
    seen: list[int] = []
    original = b.adapter.apply
    b.adapter.apply = lambda item_id, payload: (
        seen.append(threading.get_ident()),
        original(item_id, payload),
    )[1]

    await b.sync()

    assert seen, "nothing was applied"
    assert loop_thread not in seen, "apply() ran on the event loop thread"


@pytest.mark.asyncio
async def test_a_failing_key_offer_cannot_break_pairing(monkeypatch, account_key):
    """`_finish_pairing` awaits the offer as its last step, and the only except
    above it is a narrow PairingError — so anything escaping here would come out
    of the pairing exchange after the pin was already written."""
    from agent_team_backend import trust_store

    link = _bare_link()
    # Both of these must succeed, or the failure below is never reached: the
    # first version of this test passed a bogus public key, wrap_for raised
    # first, and the guard being tested was never entered. The mutation that
    # moves the send back outside the guard is what exposed it.
    link._own_member = "m1"
    monkeypatch.setattr(
        trust_store,
        "pin_for",
        lambda _d: {"approved": True, "memberId": "m1", "encKey": "valid-looking"},
    )
    monkeypatch.setattr(sync_keyring, "wrap_for", lambda **kw: "sealed")

    reached = []

    async def _explode(*a, **k):
        reached.append(a)
        raise RuntimeError("the socket went away mid-send")

    monkeypatch.setattr(link, "_send_pair_frame", _explode)

    assert await link._offer_sync_key("dev-b") is False  # swallowed, not raised
    assert reached, "the send was never attempted, so nothing was proven"


# ── the upgrade must not re-seal what an older release still has to read ─────
async def test_an_item_sealed_before_kids_were_recorded_is_not_pushed_again(
    tmp_path, account_key
):
    """A blank sealed_kid means "v1 body, or unknown" — never "retired key".

    Reading it as retired made the first sync after an upgrade re-seal and
    re-push every item in every scope. A device still on the older release
    cannot open a v2 body: it drops the record with a log line and advances
    its cursor regardless, so that item silently never reaches it again.
    """
    server = FakeServer()
    device = Device(tmp_path, server, "a", items={"p1": {"v": 1}})
    assert (await device.sync())["pushed"] == 1
    pushed_rev = device.store.state("prompts", "p1").rev

    # Exactly the row an upgrade leaves behind: agreed, unchanged, and with no
    # record of which key sealed it.
    state = device.store.state("prompts", "p1")
    device.store.set_state(
        "prompts",
        "p1",
        rev=state.rev,
        synced_hash=state.synced_hash,
        deleted=False,
        sealed_kid="",
    )

    assert (await device.sync())["pushed"] == 0, "an unchanged v1 body was re-sealed"
    assert device.store.state("prompts", "p1").rev == pushed_rev


async def test_a_rotation_still_pushes_what_the_retired_key_sealed(tmp_path, account_key):
    """The sibling of the above: a concrete, non-active key id does re-push,
    which is the one thing the rotation path asks of the engine."""
    server = FakeServer()
    device = Device(tmp_path, server, "a", items={"p1": {"v": 1}})
    assert (await device.sync())["pushed"] == 1

    state = device.store.state("prompts", "p1")
    device.store.set_state(
        "prompts",
        "p1",
        rev=state.rev,
        synced_hash=state.synced_hash,
        deleted=False,
        sealed_kid="retired-kid",
    )

    assert (await device.sync())["pushed"] == 1


# ── a scope that is off does not move items, however it was asked ────────────
def _disabled_device(tmp_path, server, name, items=None):
    device = Device(tmp_path, server, name, items=items)
    device.engine._enabled = lambda _scope: False
    return device


async def test_push_items_refuses_a_scope_that_is_switched_off(tmp_path, account_key):
    """`sync` skips a disabled scope but `push_items` used to check only that an
    adapter and a key existed — so anything that could reach the local
    WebSocket could send an item while the UI showed the scope switched off."""
    server = FakeServer()
    device = _disabled_device(tmp_path, server, "a", items={"p1": {"v": 1}})

    with pytest.raises(sync_engine.SyncError, match="switched off"):
        await device.engine.push_items("prompts", ["p1"])

    assert server.rows == {}, "an item left the machine anyway"
    assert server.pushes == 0


async def test_pull_items_refuses_a_scope_that_is_switched_off(tmp_path, account_key):
    """Taking a record down and putting it into use is the same decision as
    sending one, and answers to the same switch."""
    server = FakeServer()
    source = Device(tmp_path, server, "src", items={"p1": {"v": 1}})
    assert (await source.sync())["pushed"] == 1

    device = _disabled_device(tmp_path, server, "b")
    with pytest.raises(sync_engine.SyncError, match="switched off"):
        await device.engine.pull_items("prompts", ["p1"])

    assert device.adapter.items == {}, "an item was applied anyway"


async def test_a_sensitive_scope_that_is_off_is_not_asked_to_describe_itself(
    tmp_path, account_key
):
    """`inventory` answers a disabled scope on purpose — somebody deciding
    whether to switch one on wants to see what it would bring down. That holds
    while looking is free, and a sensitive adapter's snapshot is not: the
    credentials one opens every stored secret to build it."""
    server = FakeServer()
    device = _disabled_device(tmp_path, server, "a", items={"p1": {"v": 1}})
    device.adapter.sensitive = True
    opened: list[str] = []
    plain_snapshot = device.adapter.snapshot

    def _watched_snapshot():
        opened.append("snapshot")
        return plain_snapshot()

    device.adapter.snapshot = _watched_snapshot

    result = await device.engine.inventory("prompts")

    assert result["status"] == sync_engine.INVENTORY_DISABLED
    assert result["items"] == []
    assert opened == [], "the adapter was asked to open its secrets anyway"


async def test_an_ordinary_scope_that_is_off_still_lists_its_two_sides(
    tmp_path, account_key
):
    """The gate above is about secrets, not about being switched off: a scope
    that holds none still answers, which is what the look-first flow needs."""
    server = FakeServer()
    device = _disabled_device(tmp_path, server, "a", items={"p1": {"v": 1}})

    result = await device.engine.inventory("prompts")

    assert result["status"] == sync_engine.INVENTORY_OK
    assert [item["itemId"] for item in result["items"]] == ["p1"]
