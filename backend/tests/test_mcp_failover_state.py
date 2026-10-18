"""cli_failover_state: the quota-failover authority's state, read over MCP.

An agent deciding where to hand work could see each vendor's quota
(cli_usage) but not whether Navide was already switching accounts over an
exhausted one, how much of the automatic-switch budget was left, or that a
half-finished swap was blocking every switch of a vendor. This tool reads the
same ``quota_failover.state()`` the window's announcements are drawn from.

What is pinned here is what such a read must not do: hand back the live
login's identity or fingerprint, raw error text, or evidence lifted from a
pane's output — it passes named fields only — and touch anything but that one
in-memory read: no credential vault, no Keychain, no switch.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend import app as backend_app
from agent_team_backend.mcp_server import (
    server as plan_mcp,
    auth as plan_mcp_auth,
    wiring as plan_mcp_wiring,
)


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _host_ctx() -> Any:
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _bad_ctx() -> Any:
    params = {"pane": "pa", "t": "not-the-token"}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


_LIVE_IDENTITY = {"email": "someone@example.com", "signedIn": True}

_STATE: dict[str, Any] = {
    "policy": "notify",
    "auditDegraded": False,
    "unreconciled": {
        "codex": {
            "transactionId": "tx-u", "agentKey": "codex", "authScope": "codex",
            "fromSlotId": "s1", "toSlotId": "s2", "liveSlotId": "s2", "reason": "quota-exhausted",
            "liveIdentity": _LIVE_IDENTITY,
        },
    },
    "capabilities": {
        "claude": {"supported": True, "method": "hot", "authScope": "claude", "hasSlots": True, "scopes": []},
        "codex": {"supported": True, "method": "restart", "authScope": "codex", "hasSlots": True, "scopes": []},
    },
    "budget": {
        "claude": {"agentKey": "claude", "authScope": "claude", "used": 1, "limit": 3,
                   "windowSec": 18000, "minGapSec": 600, "nextAllowedAt": None},
        "codex": {"agentKey": "codex", "authScope": "codex", "used": 0, "limit": 3,
                  "windowSec": 18000, "minGapSec": 600, "nextAllowedAt": None},
    },
    "epochs": {"claude": 4, "codex": 2},
    "incidents": [
        {
            "id": "inc-1", "agentKey": "claude", "authScope": "claude", "outgoingSlotId": "a",
            "epoch": 4, "state": "awaiting-confirmation", "reason": "quota-exhausted",
            "trusted": True, "attribution": {"excerpt": "pane output that could hold anything"},
            "autoAllowed": False, "tried": ["a"],
            "panes": [{"paneId": "p1", "workspacePath": "/ws/alpha"}],
            "transactionIds": ["tx-1"], "detectedAt": "2026-10-19T00:00:00Z",
            "resetsAt": None, "windowKind": "five_hour", "closedAt": None,
            "updatedAt": "2026-10-19T00:00:01Z",
        },
    ],
    "transactions": [
        {
            "id": "tx-1", "incidentId": "inc-1", "agentKey": "claude", "authScope": "claude",
            "fromSlotId": "a", "toSlotId": "b", "automatic": False,
            "idempotencyKey": "idem-secret-ish", "switchMode": "hot", "restartStrategy": "none",
            "confirmation": {"kind": "new-conversation"}, "state": "preparing", "reason": "quota-exhausted",
            "error": "keychain write failed for 'Claude Code-credentials' (security exited 45)",
            "swapped": False, "epochBefore": 4, "epochAfter": None,
            "panes": [{"paneId": "p1"}], "hotSwitchedPanes": [], "overriddenPanes": [],
            "createdAt": "2026-10-19T00:00:02Z", "committedAt": None, "closedAt": None,
            "liveIdentity": _LIVE_IDENTITY, "liveFingerprint": "0123456789abcdef01234567",
        },
    ],
    "recentIncidents": [
        {"id": "inc-0", "agentKey": "codex", "authScope": "codex", "state": "ready",
         "attribution": {"excerpt": "x"}, "closedAt": "2026-10-18T23:00:00Z"},
    ],
    "recentTransactions": [
        {"id": "tx-0", "incidentId": "inc-0", "agentKey": "codex", "fromSlotId": "s1", "toSlotId": "s2",
         "automatic": True, "state": "settled", "swapped": True,
         "liveIdentity": _LIVE_IDENTITY, "liveFingerprint": "fedcba", "error": None},
    ],
}

#: Keys that must never leave the backend through this tool, at any depth.
_WITHHELD = {"liveIdentity", "liveFingerprint", "error", "idempotencyKey", "attribution", "confirmation"}


class _FakeFailover:
    """quota_failover authority stand-in: state() is the only thing the tool may touch."""

    def __init__(self, state: dict[str, Any]) -> None:
        self._state = state
        self.calls = 0

    def state(self) -> dict[str, Any]:
        self.calls += 1
        return self._state


class _Untouchable:
    """Fails the test the moment anything reads it."""

    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"cli_failover_state touched credential_vault.{name}")


@pytest.fixture
def failover(monkeypatch: pytest.MonkeyPatch) -> _FakeFailover:
    fake = _FakeFailover(_STATE)
    monkeypatch.setattr(backend_app, "quota_failover", fake, raising=False)
    monkeypatch.setattr(backend_app, "credential_vault", _Untouchable(), raising=False)
    return fake


def _keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    return set()


def _text(value: Any) -> str:
    return repr(value)


@pytest.mark.asyncio
async def test_reports_the_authority_state_through_named_fields_only(failover: _FakeFailover) -> None:
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")

    result = await plan_mcp.cli_failover_state(_ctx())

    assert result["ok"] is True
    assert result["policy"] == "notify"
    assert result["auditDegraded"] is False
    assert result["budget"] == _STATE["budget"]
    assert result["capabilities"] == _STATE["capabilities"]
    assert result["unreconciled"]["codex"]["transactionId"] == "tx-u"
    assert result["incidents"][0]["id"] == "inc-1"
    assert result["incidents"][0]["tried"] == ["a"]
    assert result["transactions"][0]["toSlotId"] == "b"
    assert result["recentIncidents"][0]["id"] == "inc-0"
    assert result["recentTransactions"][0]["swapped"] is True
    assert "agent" not in result
    assert failover.calls == 1


@pytest.mark.asyncio
async def test_never_returns_identity_fingerprint_error_text_or_pane_evidence(
    failover: _FakeFailover,
) -> None:
    result = await plan_mcp.cli_failover_state(_host_ctx())

    assert not (_keys(result) & _WITHHELD)
    text = _text(result)
    assert "someone@example.com" not in text
    assert "0123456789abcdef01234567" not in text
    assert "security exited" not in text
    assert "pane output" not in text


@pytest.mark.asyncio
async def test_narrows_to_one_vendor(failover: _FakeFailover) -> None:
    result = await plan_mcp.cli_failover_state(_host_ctx(), agent="  CODEX ")

    assert result["agent"] == "codex"
    assert set(result["unreconciled"]) == {"codex"}
    assert set(result["capabilities"]) == {"codex"}
    assert [b["agentKey"] for b in result["budget"].values()] == ["codex"]
    assert result["incidents"] == []
    assert result["transactions"] == []
    assert [i["id"] for i in result["recentIncidents"]] == ["inc-0"]
    assert [t["id"] for t in result["recentTransactions"]] == ["tx-0"]


@pytest.mark.asyncio
async def test_an_unknown_caller_is_refused_before_anything_is_read(failover: _FakeFailover) -> None:
    result = await plan_mcp.cli_failover_state(_bad_ctx())

    assert result["ok"] is False
    assert "policy" not in result
    assert failover.calls == 0


@pytest.mark.asyncio
async def test_is_registered_with_only_the_agent_filter() -> None:
    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    assert set(tools["cli_failover_state"].inputSchema.get("properties") or {}) == {"agent"}
