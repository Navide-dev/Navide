"""An unexpected failure in subscriptions/listen still answers the Host.

navide/call has a catch-all that turns any exception into BACKEND_ERROR, but
the listen branch ran outside it, on a bare daemon thread. A failure there
killed the thread without a frame, and since the Host's subscribe call has no
production timeout, its acknowledged promise hung until the child exited.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

ENTRY = Path(__file__).resolve().parents[2] / "plugins" / "navide-plans" / "backend" / "plans_backend.py"
_spec = importlib.util.spec_from_file_location("plans_backend_listen_failure", ENTRY)
assert _spec and _spec.loader
plans_backend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plans_backend)

LISTEN = {
    "jsonrpc": "2.0",
    "id": "subscription-1",
    "method": "subscriptions/listen",
    "params": {
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": plans_backend.PROTOCOL_REVISION,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {"name": "navide-plans-test", "version": "1"},
        },
        "notifications": {plans_backend.EVENT_FILTER_KEY: ["plans.changed"]},
        "runtime": {
            "pluginId": "navide.plans",
            "packageVersion": "0.1.0",
            "workspaceId": "workspace-hash",
            "instanceId": "instance-1",
            "contributionKey": "navide.plans.mcp",
            "hostWindowId": None,
            "initiator": {"kind": "agent", "source": "mcp", "id": "agent-1"},
        },
    },
}


def test_a_listen_that_fails_unexpectedly_is_answered_with_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    frames: list[Any] = []
    monkeypatch.setattr(plans_backend, "_write_frame", frames.append)

    def no_thread(_subscription: dict[str, Any]) -> None:
        raise RuntimeError("can't start new thread")

    monkeypatch.setattr(plans_backend, "_start_watch", no_thread)

    plans_backend._handle(LISTEN)

    errors = [frame for frame in frames if "error" in frame]
    assert errors == [
        {
            "jsonrpc": "2.0",
            "id": "subscription-1",
            "error": {"code": 1000, "message": "Plugin request failed.", "data": {"code": "BACKEND_ERROR"}},
        }
    ]
    # The failed subscription is not left registered to receive events.
    assert plans_backend._subscription_key("subscription-1") not in plans_backend._subscriptions
