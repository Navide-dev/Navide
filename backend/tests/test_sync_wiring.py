"""How sync rounds reach the renderer and how local saves reach sync.

The engine's own behaviour is in ``test_sync_engine_core``; these pin the
seams around it: the ``sync.result`` event, ``sync.status``, the account
switch, and the debounced round after a local save.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

import pytest

from agent_team_backend import app, server_link


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


# ── sync.result / sync.status ────────────────────────────────────────────────
async def test_the_links_engine_broadcasts_every_result(monkeypatch):
    sent: list[dict[str, Any]] = []

    async def broadcast(event, exclude=None):
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", broadcast)
    link = server_link.ServerLink()
    engine = link.sync_engine()
    engine._enabled = lambda _s: False
    result = await engine.sync("prompts")
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    events = [e for e in sent if e.get("type") == "sync.result"]
    assert [e["payload"] for e in events] == [result]


async def test_sync_status_carries_the_last_results_and_the_account(monkeypatch):
    last = {"prompts": {"scope": "prompts", "ok": True}}
    monkeypatch.setattr(server_link, "sync_last_results", lambda: last)

    async def status():
        return {"state": "connected", "accountEmail": "me@example.com", "memberId": "m-1"}

    monkeypatch.setattr(server_link, "status", status)
    session = _session()
    await app.handle_message(session, {"id": "s1", "type": "sync.status", "payload": {}})
    payload = session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert payload["last"] == last
    assert payload["account"] == {"email": "me@example.com", "memberId": "m-1"}


def test_no_link_means_no_last_results(monkeypatch):
    monkeypatch.setattr(server_link, "_link", None)
    assert server_link.sync_last_results() == {}


# ── ACC: switching accounts ──────────────────────────────────────────────────
class _Settings:
    def __init__(self, values: dict) -> None:
        self.values = values

    def get(self) -> dict:
        return dict(self.values)

    def set(self, updates: dict) -> dict:
        self.values.update(updates)
        return updates


def test_an_account_change_forgets_every_scope_and_switches_them_all_off(tmp_path, monkeypatch):
    from agent_team_backend import sync_engine, sync_scopes
    from agent_team_backend.db import Database

    store = sync_engine.SyncStore(Database(tmp_path / "s.db"))
    for scope in ("prompts", "mcp", "skills", "memory", "skill-files"):
        store.set_state(scope, "i", rev=3, synced_hash="h", deleted=False)
        store.set_cursor(scope, 3)
    store.record_conflict("prompts", "c", local={"a": 1}, remote=None, remote_rev=4, remote_device="d")
    settings = _Settings({sync_scopes.SCOPES_SETTING: {s: True for s in sync_engine.SCOPES}})
    monkeypatch.setattr(sync_scopes, "_settings", lambda: settings)
    monkeypatch.setattr(app, "sync_store", store)

    sync_scopes.on_account_changed()

    for scope in ("prompts", "mcp", "skills", "memory", "skill-files"):
        assert store.states(scope) == {} and store.cursor(scope) == 0
    assert store.conflicts(None) == []
    assert not any(sync_scopes.enabled_scopes().values())


async def test_an_account_change_while_the_app_was_closed_is_still_noticed(monkeypatch):
    from agent_team_backend import sync_scopes

    calls: list[str] = []
    monkeypatch.setattr(sync_scopes, "on_account_changed", lambda: calls.append("cleared"))
    settings = _Settings({server_link.SYNC_ACCOUNT_SETTING: "ns-a"})
    monkeypatch.setattr(server_link, "_settings_store", lambda: settings)
    # A fresh process: nothing settled in memory yet.
    monkeypatch.setattr(server_link, "_settled_account", server_link._UNREAD)
    await server_link._note_account("ns-b")
    assert calls == ["cleared"]
    assert settings.values[server_link.SYNC_ACCOUNT_SETTING] == "ns-b"
    # Restart again as the same account: nothing to clear.
    monkeypatch.setattr(server_link, "_settled_account", server_link._UNREAD)
    await server_link._note_account("ns-b")
    assert calls == ["cleared"]


async def test_a_first_sign_in_on_a_fresh_install_clears_nothing(monkeypatch):
    from agent_team_backend import sync_scopes

    calls: list[str] = []
    monkeypatch.setattr(sync_scopes, "on_account_changed", lambda: calls.append("cleared"))
    settings = _Settings({})
    monkeypatch.setattr(server_link, "_settings_store", lambda: settings)
    monkeypatch.setattr(server_link, "_settled_account", server_link._UNREAD)
    await server_link._note_account("ns-a")
    assert calls == []


# ── local saves start a round ────────────────────────────────────────────────
class _Linked:
    _authenticated = True


@pytest.fixture
def rounds(monkeypatch):
    """Record the rounds sync_soon starts; scopes on, link up, no delay."""
    from agent_team_backend import sync_scopes

    started: list[str] = []

    async def sync_now(scope=""):
        started.append(scope)
        return []

    monkeypatch.setattr(server_link, "sync_now", sync_now)
    monkeypatch.setattr(server_link, "SYNC_SOON_DELAY_S", 0.01)
    monkeypatch.setattr(server_link, "_link", _Linked())
    monkeypatch.setattr(sync_scopes, "scope_enabled", lambda _s: True)
    return started


async def _settle() -> None:
    await asyncio.sleep(0.05)


async def test_saves_in_quick_succession_start_one_round(rounds):
    for _ in range(3):
        server_link.sync_soon("prompts")
    await _settle()
    assert rounds == ["prompts"]


async def test_a_save_to_a_scope_that_is_off_starts_nothing(rounds, monkeypatch):
    from agent_team_backend import sync_scopes

    monkeypatch.setattr(sync_scopes, "scope_enabled", lambda _s: False)
    server_link.sync_soon("prompts")
    await _settle()
    assert rounds == []


async def test_a_save_while_not_connected_starts_nothing(rounds, monkeypatch):
    monkeypatch.setattr(server_link, "_link", None)
    server_link.sync_soon("mcp")
    await _settle()
    assert rounds == []


async def test_saving_the_prompt_list_starts_a_prompts_round(rounds, monkeypatch):
    from agent_team_backend import sync_scopes

    monkeypatch.setattr(app.ui_settings_store, "set", lambda updates: dict(updates))

    async def broadcast(event, exclude=None):
        return None

    monkeypatch.setattr(app, "broadcast", broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "u1", "type": "ui.settings.set",
        "payload": {"updates": {sync_scopes.PROMPT_SKILLS_KEY: []}},
    })
    await app.handle_message(session, {
        "id": "u2", "type": "ui.settings.set", "payload": {"updates": {"theme": "dark"}},
    })
    await _settle()
    assert rounds == ["prompts"]


async def test_saving_a_memory_file_starts_a_memory_round(rounds, monkeypatch):
    from agent_team_backend import native_memory

    monkeypatch.setattr(native_memory, "save", lambda *a, **k: {"ok": True})
    session = _session()
    await app.handle_message(session, {
        "id": "m1", "type": "memory.save", "payload": {"path": "/x/CLAUDE.md", "text": "hi"},
    })
    await _settle()
    assert rounds == ["memory"]


async def test_a_skill_change_starts_a_skills_round(rounds, monkeypatch):
    from agent_team_backend import ws_handlers

    async def notify(name, change):
        return None

    monkeypatch.setattr(ws_handlers, "notify_skills_changed", notify)
    await ws_handlers._run_skill_operation(
        _session(), "k1", "skills.set_enabled", lambda: {"ok": True}, name="s"
    )
    await _settle()
    assert rounds == ["skills"]


async def test_saving_mcp_servers_starts_an_mcp_round(rounds, monkeypatch):
    class Store:
        path = "/nowhere/mcp.json"
        revision = 1

        def replace_servers(self, servers, expected_revision=None):
            return servers

    class Manager:
        async def reload(self, path):
            return None

    monkeypatch.setattr(app, "mcp_settings_store", Store())
    monkeypatch.setattr(app, "mcp_manager", Manager())
    session = _session()
    await app.handle_message(session, {
        "id": "c1", "type": "mcp.save_servers", "payload": {"servers": []},
    })
    assert session.websocket.sent[0]["payload"].get("ok") is True, session.websocket.sent  # type: ignore[attr-defined]
    await _settle()
    assert rounds == ["mcp"]


def test_the_links_engine_checks_pins_against_its_member(monkeypatch):
    from agent_team_backend import trust_store

    monkeypatch.setattr(trust_store, "pin_for", lambda _d: {"signKey": "KEY", "memberId": "m-other"})
    link = server_link.ServerLink()
    link.member_id = "m-me"
    assert link.sync_engine()._signing_key_for("dev-x") == ""
    link.member_id = "m-other"
    assert link.sync_engine()._signing_key_for("dev-x") == "KEY"


# ── security review: switching accounts must fail closed ─────────────────────
def _seeded(tmp_path, monkeypatch, settings):
    from agent_team_backend import sync_engine, sync_scopes
    from agent_team_backend.db import Database

    store = sync_engine.SyncStore(Database(tmp_path / "s.db"))
    for scope in ("prompts", "memory", "skills"):
        store.set_state(scope, "i", rev=3, synced_hash="h", deleted=False)
        store.set_cursor(scope, 3)
    monkeypatch.setattr(app, "sync_store", store)
    monkeypatch.setattr(sync_scopes, "_settings", lambda: settings)
    monkeypatch.setattr(server_link, "_settings_store", lambda: settings)
    return store


async def test_a_keychain_that_will_not_answer_at_boot_is_not_a_sign_out(tmp_path, monkeypatch):
    # B1: an unreadable token means "cannot tell", never "signed out".
    from agent_team_backend import sync_engine, sync_scopes

    settings = _Settings({
        server_link.SYNC_ACCOUNT_SETTING: "ns-a",
        sync_scopes.SCOPES_SETTING: {s: s != "credentials" for s in sync_engine.SCOPES},
    })
    store = _seeded(tmp_path, monkeypatch, settings)

    class LockedVault:
        def read_app_secret(self, _name):
            raise RuntimeError("User interaction is not allowed")

    async def broadcast(event, exclude=None):
        return None

    monkeypatch.setattr(app, "credential_vault", LockedVault())
    monkeypatch.setattr(app, "broadcast", broadcast)
    monkeypatch.setattr(server_link, "_settled_account", server_link._UNREAD)
    monkeypatch.setattr(server_link, "_link", None)
    await server_link.start()
    assert sync_scopes.enabled_scopes()["prompts"] is True
    assert store.cursor("prompts") == 3
    assert settings.values[server_link.SYNC_ACCOUNT_SETTING] == "ns-a"


async def test_a_real_sign_out_at_boot_still_lets_go(tmp_path, monkeypatch):
    from agent_team_backend import sync_engine, sync_scopes

    settings = _Settings({
        server_link.SYNC_ACCOUNT_SETTING: "ns-a",
        sync_scopes.SCOPES_SETTING: {s: s != "credentials" for s in sync_engine.SCOPES},
    })
    store = _seeded(tmp_path, monkeypatch, settings)

    class EmptyVault:
        def read_app_secret(self, _name):
            return None

    async def broadcast(event, exclude=None):
        return None

    monkeypatch.setattr(app, "credential_vault", EmptyVault())
    monkeypatch.setattr(app, "broadcast", broadcast)
    monkeypatch.setattr(server_link, "_settled_account", server_link._UNREAD)
    monkeypatch.setattr(server_link, "_link", None)
    monkeypatch.setattr(sync_scopes, "credentials_scope", lambda: type("C", (), {"clear_imported": lambda self: None})())
    await server_link.start()
    assert not any(sync_scopes.enabled_scopes().values())
    assert store.cursor("prompts") == 0


async def test_a_switch_that_fails_halfway_stays_closed_and_is_retried(tmp_path, monkeypatch):
    # B3: switch scopes off first; record the new account only once cleanup worked.
    from agent_team_backend import sync_scopes

    settings = _Settings({
        server_link.SYNC_ACCOUNT_SETTING: "ns-a",
        sync_scopes.SCOPES_SETTING: {"prompts": True, "memory": True},
    })
    store = _seeded(tmp_path, monkeypatch, settings)
    failing = True

    class Creds:
        scope = "credentials"

        def clear_imported(self):
            if failing:
                raise RuntimeError("database is locked")

    async def broadcast(event, exclude=None):
        return None

    monkeypatch.setattr(app, "broadcast", broadcast)
    monkeypatch.setattr(sync_scopes, "credentials_scope", lambda: Creds())
    monkeypatch.setattr(server_link, "_settled_account", server_link._UNREAD)
    await server_link._note_account("ns-b")
    assert sync_scopes.enabled_scopes()["prompts"] is False      # closed
    assert settings.values[server_link.SYNC_ACCOUNT_SETTING] == "ns-a"
    assert server_link._switch_pending is True
    # While the switch is unfinished nothing syncs, whatever the switches say.
    sync_scopes.set_scope_enabled("prompts", True)
    link = server_link.ServerLink()
    assert link.sync_engine()._enabled("prompts") is False
    failing = False
    await server_link._note_account("ns-b")                       # a reconnect retries
    assert settings.values[server_link.SYNC_ACCOUNT_SETTING] == "ns-b"
    assert server_link._switch_pending is False
    assert store.cursor("prompts") == 0
    assert sync_scopes.enabled_scopes()["prompts"] is False


def test_an_account_change_lets_go_of_detached_marks(tmp_path, monkeypatch):
    # B2: "kept here, not pushed back" marks belong to the account they came from.
    from agent_team_backend import sync_scopes

    settings = _Settings({"sync-detached": {"memory": {"X": "digest"}}})
    _seeded(tmp_path, monkeypatch, settings)
    sync_scopes.on_account_changed()
    assert not settings.values.get("sync-detached")


def test_forget_detached_drops_one_scope_or_all(tmp_path, monkeypatch):
    from agent_team_backend import sync_scopes

    settings = _Settings({"sync-detached": {"memory": {"X": "d"}, "skills": {"Y": "d"}}})
    monkeypatch.setattr(sync_scopes, "_settings", lambda: settings)
    sync_scopes.forget_detached("memory")
    assert settings.values["sync-detached"] == {"skills": {"Y": "d"}}
    sync_scopes.forget_detached()
    assert not settings.values.get("sync-detached")


def test_an_account_change_resets_the_skill_files_adapter(tmp_path, monkeypatch):
    # B7: its retry counters and oversized list describe the old account.
    from agent_team_backend import sync_scopes

    _seeded(tmp_path, monkeypatch, _Settings({}))
    calls: list[str] = []

    class SkillFiles:
        def reset(self):
            calls.append("reset")

    monkeypatch.setattr(sync_scopes, "_skill_files", SkillFiles())
    sync_scopes.on_account_changed()
    assert calls == ["reset"]


def test_the_links_engine_forgets_detached_marks_when_a_reset_forgets_a_scope(monkeypatch):
    from agent_team_backend import sync_scopes

    calls: list[str] = []
    monkeypatch.setattr(sync_scopes, "forget_detached", lambda scope=None: calls.append(scope))
    link = server_link.ServerLink()
    link.sync_engine()._on_forget("memory")
    assert calls == ["memory"]


def test_an_account_change_forgets_the_marks_detach_wrote(tmp_path, monkeypatch):
    # The marks the scope adapters write (detach) and the ones an account
    # change drops (forget_detached) live under one ui_settings key.
    from agent_team_backend import sync_scopes

    settings = _Settings({})
    _seeded(tmp_path, monkeypatch, settings)
    sync_scopes.detach("memory", "X", {"text": "kept"})
    assert sync_scopes.without_detached("memory", {"X": {"text": "kept"}}) == {}
    sync_scopes.on_account_changed()
    assert sync_scopes.without_detached("memory", {"X": {"text": "kept"}}) == {"X": {"text": "kept"}}


def test_an_account_change_resets_the_registered_skill_files_adapter(tmp_path, monkeypatch):
    # B7 against the real adapter the link registers, not a stand-in.
    from agent_team_backend import sync_scopes

    _seeded(tmp_path, monkeypatch, _Settings({}))
    monkeypatch.setattr(sync_scopes, "_skill_files", None)
    adapter = sync_scopes.skill_files_scope()
    adapter._download_failures["old"] = ("digest", sync_scopes.MAX_DOWNLOAD_ATTEMPTS)
    assert adapter.failed() == ["old"]
    sync_scopes.on_account_changed()
    assert adapter.failed() == []


async def test_switching_back_after_a_failed_switch_reopens_sync(tmp_path, monkeypatch):
    # R-B4: A -> B fails; signing in as A again must not leave sync shut.
    from agent_team_backend import sync_scopes

    settings = _Settings({server_link.SYNC_ACCOUNT_SETTING: "ns-a"})
    _seeded(tmp_path, monkeypatch, settings)

    class Creds:
        scope = "credentials"

        def clear_imported(self):
            raise RuntimeError("database is locked")

    monkeypatch.setattr(sync_scopes, "credentials_scope", lambda: Creds())
    monkeypatch.setattr(server_link, "_settled_account", server_link._UNREAD)
    await server_link._note_account("ns-b")
    assert server_link._switch_pending is True
    await server_link._note_account("ns-a")
    assert server_link._switch_pending is False


async def test_a_reply_over_the_frame_limit_reaches_the_engine_as_frame_too_large(monkeypatch):
    # A server with no reply byte cap: the socket closes with 1009 and the
    # engine has to hear that, not a plain drop, to ask for smaller pages.
    import websockets

    from agent_team_backend import sync_engine

    async def handler(ws):
        await ws.recv()
        await ws.send("x" * (2 * 1024 * 1024))
        with contextlib.suppress(Exception):
            await ws.wait_closed()

    async with websockets.serve(handler, "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        ws = await websockets.connect(f"ws://127.0.0.1:{port}")
        await ws.send("hi")
        with contextlib.suppress(websockets.ConnectionClosed):
            async for _ in ws:
                pass
        assert server_link._close_code_sent(ws) == 1009

        link = server_link.ServerLink()
        link._ws = ws

        async def dropped(msg_type, payload):
            raise ConnectionError("navide-server connection closed")

        monkeypatch.setattr(link, "_request", dropped)
        with pytest.raises(sync_engine.FrameTooLarge):
            await link._sync_request("sync.pull", {"scope": "prompts"})


async def test_an_ordinary_drop_stays_a_connection_error_for_the_engine(monkeypatch):
    from agent_team_backend import sync_engine

    link = server_link.ServerLink()
    link._ws = None

    async def dropped(msg_type, payload):
        raise ConnectionError("navide-server connection closed")

    monkeypatch.setattr(link, "_request", dropped)
    with pytest.raises(ConnectionError) as caught:
        await link._sync_request("sync.pull", {"scope": "prompts"})
    assert not isinstance(caught.value, sync_engine.FrameTooLarge)


def test_the_sync_engine_is_handed_the_sync_request():
    link = server_link.ServerLink()
    assert link.sync_engine()._request == link._sync_request


def test_an_account_change_drops_pending_approvals_when_the_scopes_offer_it(tmp_path, monkeypatch):
    # D1's approval queue holds items of the account they arrived under.
    from agent_team_backend import sync_scopes

    _seeded(tmp_path, monkeypatch, _Settings({}))
    calls: list[object] = []
    monkeypatch.setattr(sync_scopes, "forget_approvals", lambda scope=None: calls.append(scope), raising=False)
    sync_scopes.on_account_changed()
    assert calls == [None]
