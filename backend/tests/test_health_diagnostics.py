"""/health carries a cheap load reading: event-loop lag and the default pool.

The shared default executor is where starvation shows first (list_recent,
plans, usage, ps snapshots all queue there), and until now nothing reported
it short of the 2s loop_watchdog stall log. The reading must never cost the
route its answer: a failure to measure drops the block, not the response.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agent_team_backend import app as app_module


@pytest.fixture
def client() -> TestClient:
    return TestClient(app_module.app, base_url="http://127.0.0.1")


def test_health_reports_loop_lag_and_default_pool(client: TestClient) -> None:
    body = client.get("/health").json()

    assert body["status"] == "ok"
    diag = body["diagnostics"]
    assert isinstance(diag["loop_lag_ms"], (int, float)) and diag["loop_lag_ms"] >= 0
    pool = diag["default_pool"]
    assert set(pool) == {"threads", "max_workers", "queued"}
    assert all(isinstance(v, int) and v >= 0 for v in pool.values())


def test_health_still_answers_when_measuring_fails(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_a, **_k):
        raise RuntimeError("probe broke")

    monkeypatch.setattr(app_module, "_default_pool_reading", boom)

    body = client.get("/health").json()

    assert body["status"] == "ok"
    assert "diagnostics" not in body
