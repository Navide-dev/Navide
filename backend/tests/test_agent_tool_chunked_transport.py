"""Chunked transfer between the core and the Host (agent-tools contract 4.4, A2 and R2)."""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server.server import _Caller, request_host_agent_workspace_backend
from agent_team_backend.plugins import agent_tools_contract as contract


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _host_session() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.host_authenticated = True
    return session


def _agent_tool(timeout_ms: int = 30_000) -> dict[str, Any]:
    return {
        "tool": {"name": "devmap_read", "plugin_version": "1.0.0", "sync_revision": 1},
        "caller": {"kind": "external", "paneId": None, "workspace": None, "verifiedTo": "caller-kind"},
        "timeout_ms": timeout_ms,
    }


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _big(size: int) -> dict[str, Any]:
    unit = "abc中文😀"
    return {"rows": unit * (size // len(unit.encode("utf-8")) + 1)}


async def _send(session: app.Session, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    await app.handle_message(session, {"id": f"m-{len(session.websocket.sent)}", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_10_mib_arguments_go_in_pieces_and_a_10_mib_result_comes_back_in_pieces(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arguments = _big(10 * 1_048_576)
    result = _big(10 * 1_048_576)
    session = _host_session()
    events: list[dict[str, Any]] = []
    answered: list[asyncio.Task[Any]] = []

    async def host(event: dict[str, Any]) -> bool:
        events.append(event)
        if event["type"] != "agent.capability.request":
            return True
        request = event["payload"]

        async def answer() -> None:
            # The Host joins the argument pieces it received before the request.
            pieces = [e["payload"] for e in events if e["type"] == contract.AGENT_CAPABILITY_REQUEST_CHUNK_EVENT]
            joined = contract.reassemble_agent_tool_payload_text(pieces, request["payload"]["argumentChunks"])
            assert joined["ok"]
            assert _sha(joined["text"]) == _sha(contract.agent_tool_payload_text(arguments))
            text = json.dumps(result, separators=(",", ":"), ensure_ascii=False)
            out = contract.split_agent_tool_payload_text(text)
            for seq, data in enumerate(out):
                reply = await _send(session, contract.AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE, {
                    "request_id": request["request_id"], "seq": seq, "data": data,
                })
                assert reply["payload"] == {"ok": True, "accepted": True}
            await _send(session, "agent.capability.result", {"request_id": request["request_id"], "response": {
                "ok": True,
                "resultChunks": {"chunks": len(out), "bytes": contract.utf8_byte_length(text)},
                "meta": {"durationMs": 1, "resultBytes": contract.utf8_byte_length(text), "crossWorkspace": False},
            }})

        answered.append(asyncio.create_task(answer()))
        return True

    monkeypatch.setattr(app, "unicast_host", host)
    response = await request_host_agent_workspace_backend(
        "acme.devmap", "/workspace", {"arguments": arguments}, caller=_Caller(kind="external"), agent_tool=_agent_tool(),
    )
    await asyncio.gather(*answered)
    pieces = [e for e in events if e["type"] == contract.AGENT_CAPABILITY_REQUEST_CHUNK_EVENT]
    assert len(pieces) >= 80
    assert events[-1]["type"] == "agent.capability.request"
    assert set(events[-1]["payload"]["payload"]) == {"argumentChunks"}
    assert response["ok"] is True
    assert _sha(json.dumps(response["result"], sort_keys=True)) == _sha(json.dumps(result, sort_keys=True))
    assert response["meta"]["resultBytes"] > 10 * 1_048_576
    assert plan_mcp._agent_capability_pending.pending == {}
    assert plan_mcp._agent_transfers == {}


@pytest.mark.asyncio
async def test_small_arguments_still_travel_inline(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[dict[str, Any]] = []

    async def host(event: dict[str, Any]) -> bool:
        events.append(event)
        plan_mcp.resolve_agent_capability(event["payload"]["request_id"], {"ok": True, "result": {"x": 1}})
        return True

    monkeypatch.setattr(app, "unicast_host", host)
    response = await request_host_agent_workspace_backend(
        "acme.devmap", "/workspace", {"arguments": {"a": 1}}, caller=_Caller(kind="external"), agent_tool=_agent_tool(),
    )
    assert response == {"ok": True, "result": {"x": 1}}
    assert [e["type"] for e in events] == ["agent.capability.request"]
    assert events[0]["payload"]["payload"] == {"arguments": {"a": 1}}


@pytest.mark.asyncio
async def test_a_result_piece_out_of_order_fails_the_call_at_once(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _host_session()

    async def host(event: dict[str, Any]) -> bool:
        request_id = event["payload"]["request_id"]

        async def answer() -> None:
            full = "x" * contract.AGENT_TOOL_CHUNK_BYTES
            first = await _send(session, contract.AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE, {"request_id": request_id, "seq": 0, "data": full})
            assert first["payload"]["accepted"] is True
            again = await _send(session, contract.AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE, {"request_id": request_id, "seq": 0, "data": full})
            assert again["payload"]["accepted"] is False

        asyncio.get_running_loop().create_task(answer())
        return True

    monkeypatch.setattr(app, "unicast_host", host)
    response = await request_host_agent_workspace_backend(
        "acme.devmap", "/workspace", {"arguments": {}}, caller=_Caller(kind="external"), agent_tool=_agent_tool(),
    )
    assert response["error_code"] == "PLUGIN_TOOL_CHUNKS_INVALID"
    assert response["reason"] == "seq"


@pytest.mark.asyncio
async def test_progress_keeps_the_wait_alive_past_its_window_and_silence_still_ends_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(contract, "AGENT_TOOL_CHUNK_IDLE_MS", 300)
    monkeypatch.setattr(plan_mcp, "_HOST_ANSWER_GRACE_S", 0.1)
    session = _host_session()

    async def lively_host(event: dict[str, Any]) -> bool:
        request_id = event["payload"]["request_id"]

        async def answer() -> None:
            for _ in range(8):  # about 1.6 s, four times the 0.4 s window
                await asyncio.sleep(0.2)
                reply = await _send(session, contract.AGENT_CAPABILITY_PROGRESS_MESSAGE, {"request_id": request_id, "phase": "execution"})
                assert reply["payload"]["accepted"] is True
            await _send(session, "agent.capability.result", {"request_id": request_id, "response": {"ok": True, "result": "late"}})

        asyncio.get_running_loop().create_task(answer())
        return True

    monkeypatch.setattr(app, "unicast_host", lively_host)
    alive = await request_host_agent_workspace_backend(
        "acme.devmap", "/workspace", {"arguments": {}}, caller=_Caller(kind="external"), agent_tool=_agent_tool(timeout_ms=100),
    )
    assert alive == {"ok": True, "result": "late"}

    async def silent_host(event: dict[str, Any]) -> bool:
        return True

    monkeypatch.setattr(app, "unicast_host", silent_host)
    started = asyncio.get_running_loop().time()
    silent = await request_host_agent_workspace_backend(
        "acme.devmap", "/workspace", {"arguments": {}}, caller=_Caller(kind="external"), agent_tool=_agent_tool(timeout_ms=100),
    )
    assert silent["error_code"] == "host_timeout"
    assert asyncio.get_running_loop().time() - started < 2


@pytest.mark.asyncio
async def test_pieces_and_progress_need_an_authenticated_host_and_a_pending_request() -> None:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    refused = await _send(session, contract.AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE, {"request_id": "mcp:1", "seq": 0, "data": "x"})
    assert refused["error"]["code"] == "UNAUTHORIZED"
    refused = await _send(session, contract.AGENT_CAPABILITY_PROGRESS_MESSAGE, {"request_id": "mcp:1", "phase": "execution"})
    assert refused["error"]["code"] == "UNAUTHORIZED"

    session.host_authenticated = True
    unknown = await _send(session, contract.AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE, {"request_id": "mcp:gone", "seq": 0, "data": "x"})
    assert unknown["payload"] == {"ok": True, "accepted": False}
    unknown = await _send(session, contract.AGENT_CAPABILITY_PROGRESS_MESSAGE, {"request_id": "mcp:gone", "phase": "result"})
    assert unknown["payload"] == {"ok": True, "accepted": False}
    malformed = await _send(session, contract.AGENT_CAPABILITY_PROGRESS_MESSAGE, {"request_id": "mcp:gone", "phase": "later"})
    assert malformed["error"]["code"] == "BAD_REQUEST"
