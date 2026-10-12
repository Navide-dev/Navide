"""The window's way to an item's earlier versions: sync.versions and
sync.restore_version over the WebSocket, through server_link to the engine."""

from __future__ import annotations

import pytest

from agent_team_backend import server_link, sync_approvals, ws_handlers


class _Session:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


class _Engine:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def versions(self, scope: str, item_id: str) -> list[dict]:
        self.calls.append(("versions", scope, item_id))
        return [{"rev": 3, "updatedAt": "u", "deviceId": "d", "supersededAt": "s"}]

    async def restore(self, scope: str, item_id: str, rev: int) -> dict:
        self.calls.append(("restore", scope, item_id, rev))
        return {"scope": scope, "itemId": item_id, "rev": rev, "held": True}


class _Link:
    _authenticated = True

    def __init__(self) -> None:
        self.engine = _Engine()

    async def ensure_sync_key(self) -> bool:
        return True

    def sync_engine(self) -> _Engine:
        return self.engine


@pytest.fixture(autouse=True)
def _key_held(monkeypatch):
    from agent_team_backend import sync_keyring

    monkeypatch.setattr(sync_keyring, "has_account_key", lambda: True)


async def _ask(msg_type: str, payload: dict) -> dict:
    session = _Session()
    await ws_handlers.lookup(msg_type)(session, "m1", msg_type, payload)
    (reply,) = session.sent
    return reply


async def test_versions_reach_the_engine_and_come_back(monkeypatch) -> None:
    link = _Link()
    monkeypatch.setattr(server_link, "_link", link)
    reply = await _ask("sync.versions", {"scope": "prompts", "itemId": "deploy"})
    assert reply["payload"]["versions"][0]["rev"] == 3
    assert link.engine.calls == [("versions", "prompts", "deploy")]


async def test_a_restore_reports_whether_it_waits_for_approval(monkeypatch) -> None:
    link = _Link()
    monkeypatch.setattr(server_link, "_link", link)
    reply = await _ask("sync.restore_version", {"scope": "mcp", "itemId": "github", "rev": 2})
    assert reply["payload"]["held"] is True
    assert link.engine.calls == [("restore", "mcp", "github", 2)]


@pytest.mark.parametrize("payload", [{"scope": "prompts", "itemId": "x"}, {"scope": "prompts", "itemId": "x", "rev": "2"},
                                     {"scope": "prompts", "itemId": "x", "rev": True}, {"itemId": "x", "rev": 2}])
async def test_a_malformed_restore_is_refused_before_anything_runs(monkeypatch, payload) -> None:
    link = _Link()
    monkeypatch.setattr(server_link, "_link", link)
    reply = await _ask("sync.restore_version", payload)
    assert reply["error"]["code"] == "SYNC_BAD_CHOICE"
    assert link.engine.calls == []


@pytest.mark.parametrize("scope", sorted(sync_approvals.RETIRED_SCOPES | {"credentials"}))
async def test_memory_and_credentials_have_no_history_here(monkeypatch, scope) -> None:
    link = _Link()
    monkeypatch.setattr(server_link, "_link", link)
    for msg_type, extra in (("sync.versions", {}), ("sync.restore_version", {"rev": 1})):
        reply = await _ask(msg_type, {"scope": scope, "itemId": "x", **extra})
        assert "error" in reply
    assert link.engine.calls == []


async def test_no_link_is_said_plainly(monkeypatch) -> None:
    monkeypatch.setattr(server_link, "_link", None)
    reply = await _ask("sync.versions", {"scope": "prompts", "itemId": "x"})
    assert reply["error"]["code"] == "SYNC_VERSIONS_FAILED"
    assert "not connected" in reply["error"]["message"]


async def test_looking_at_history_never_mints_a_key(monkeypatch) -> None:
    """Review D-L2: listing versions went through ensure_sync_key, which mints
    an account key on a machine paired with nobody."""
    from agent_team_backend import sync_keyring

    link = _Link()
    minted: list[str] = []

    async def would_mint() -> bool:
        minted.append("minted")
        return True

    monkeypatch.setattr(link, "ensure_sync_key", would_mint)
    monkeypatch.setattr(sync_keyring, "has_account_key", lambda: False)
    monkeypatch.setattr(server_link, "_link", link)
    for msg_type, extra in (("sync.versions", {}), ("sync.restore_version", {"rev": 1})):
        reply = await _ask(msg_type, {"scope": "prompts", "itemId": "x", **extra})
        assert reply["error"]["code"] in ("SYNC_VERSIONS_FAILED", "SYNC_RESTORE_FAILED")
        assert "account sync key" in reply["error"]["message"]
    assert minted == [] and link.engine.calls == []
