"""A remote pane is outside every auth pool: read-only checks against the
failover scope code, which this feature does not change."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, quota_failover
from agent_team_backend import remote_devcontainer as rd
from agent_team_backend.cli_vendors import registry


def test_remote_is_not_a_vendor() -> None:
    assert registry.vendor(rd.AGENT_KEY) is None
    assert rd.AGENT_KEY not in quota_failover.capabilities()


@pytest.mark.parametrize("scope", sorted({
    cap["authScope"] for cap in quota_failover.capabilities().values() if cap["authScope"]
}))
def test_no_scope_counts_remote(scope: str) -> None:
    assert rd.AGENT_KEY not in quota_failover.scope_members(scope)


def _term(agent_key: str, pane_id: str, **metadata: Any) -> SimpleNamespace:
    return SimpleNamespace(agent_key=agent_key, pane_id=pane_id, closed=False, cwd="/w", metadata=metadata)


def test_affected_terminals_skips_remote_and_keeps_local_claude(monkeypatch: pytest.MonkeyPatch) -> None:
    terms = {
        "t-local": _term("claude", "local-pane"),
        "t-remote": _term(rd.AGENT_KEY, "remote-pane", remote={
            "host": "h", "container": "c", "network": {"mode": "host"}, "cli": "claude"}),
    }
    owner = SimpleNamespace(terminals=SimpleNamespace(get=terms.get))
    monkeypatch.setattr(app, "_PTY_OWNERS", {tid: owner for tid in terms})
    service = object.__new__(quota_failover.QuotaFailoverService)
    monkeypatch.setattr(service, "_store_matches", lambda *_a: True, raising=False)

    scope = quota_failover.capabilities()["claude"]["authScope"]
    panes = [row["paneId"] for row in service._affected_terminals(scope)]
    assert panes == ["local-pane"]
