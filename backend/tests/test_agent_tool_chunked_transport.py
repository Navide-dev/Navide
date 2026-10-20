"""Chunked transfer between the core and the Host (agent-tools contract 4.4, A2 and R2)."""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server.server import _Caller, request_host_agent_workspace_backend
from agent_team_backend.plugins import agent_tools_contract as contract


# Most CPU time one event-loop step may take. `time.thread_time` counts in
# whole scheduler ticks on Windows (15.625 ms), so a step of a little over one
# tick reads as two (31.25 ms): there the budget is three ticks. A step that
# parses a whole result on the loop costs hundreds of milliseconds, so both
# budgets still catch it.
LOOP_SLICE_BUDGET_S = 0.047 if sys.platform == "win32" else 0.02


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
    # Handed on as the pieces that came; the proxy's helper process parses them.
    assert "result" not in response
    assert _sha("".join(response["result_pieces"])) == _sha(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
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


async def _loop_step_times(
    monkeypatch: pytest.MonkeyPatch, work: Any, steps: list[tuple[float, float]] | None = None
) -> tuple[Any, list[tuple[float, float]]]:
    """``work``'s result and when (``time.thread_time``) every event-loop step
    taken meanwhile started and ended: every callback the loop runs, a task's
    step between two awaits included, is one step. CPU time leaves out the OS
    pausing the process, so a busy machine does not change it; garbage is
    collected first, so a collection of the test's own garbage is not counted.
    ``steps``, when given, is filled as the steps end: while a step runs,
    ``len(steps)`` is its index."""
    import gc
    import time

    gc.collect()
    steps = [] if steps is None else steps
    run = asyncio.events.Handle._run

    def timed(handle: asyncio.events.Handle) -> None:
        started = time.thread_time()
        try:
            run(handle)
        finally:
            steps.append((started, time.thread_time()))

    monkeypatch.setattr(asyncio.events.Handle, "_run", timed)
    try:
        # Hand back before and after, so `work` starts in a measured step and
        # the step it ends in is counted before the result is read.
        await asyncio.sleep(0)
        result = await work
        await asyncio.sleep(0)
    finally:
        monkeypatch.setattr(asyncio.events.Handle, "_run", run)
    return result, steps


async def _longest_loop_slice(monkeypatch: pytest.MonkeyPatch, work: Any) -> tuple[Any, float]:
    """``work``'s result and the most CPU time one event-loop step took meanwhile."""
    result, steps = await _loop_step_times(monkeypatch, work)
    return result, max((ended - started for started, ended in steps), default=0.0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "shape",
    [
        pytest.param(lambda: _big(10 * 1_048_576), id="one 10 MiB string"),
        pytest.param(lambda: {"rows": [{"k": i, "v": "abcdefgh中"} for i in range(345_000)]}, id="10 MiB of small values"),
        pytest.param(
            lambda: {"rows": [{"k": i, "v": "abcdefgh中"} for i in range(345_000)], "odd": "a\ud800b"},
            id="10 MiB with a lone surrogate",
        ),
    ],
)
async def test_10_mib_of_arguments_never_stalls_the_event_loop(monkeypatch: pytest.MonkeyPatch, shape: Any) -> None:
    arguments = shape()
    received: list[str] = []
    summaries: list[dict[str, Any]] = []

    async def host(event: dict[str, Any]) -> bool:
        if event["type"] == contract.AGENT_CAPABILITY_REQUEST_CHUNK_EVENT:
            received.append(event["payload"]["data"])
            return True
        summaries.append(event["payload"]["payload"]["argumentChunks"])
        plan_mcp.resolve_agent_capability(event["payload"]["request_id"], {"ok": True, "result": True})
        return True

    monkeypatch.setattr(app, "unicast_host", host)
    response, longest = await _longest_loop_slice(monkeypatch, request_host_agent_workspace_backend(
        "acme.devmap", "/workspace", {"arguments": arguments}, caller=_Caller(kind="external"), agent_tool=_agent_tool(),
    ))
    assert response == {"ok": True, "result": True}
    assert len(received) >= 80
    # CPU time the loop's thread spent between two hand-backs: what a slow
    # step costs every other pane, whatever the machine's load.
    assert longest < LOOP_SLICE_BUDGET_S, f"the loop ran {longest * 1000:.1f} ms of CPU without handing back"
    # Checked after the measurement: the pieces join to the arguments' spelling.
    joined = contract.reassemble_agent_tool_payload_text(
        [{"seq": seq, "data": data} for seq, data in enumerate(received)], summaries[0]
    )
    assert joined["ok"] and joined["text"] == contract.agent_tool_payload_text(arguments)


def test_the_sliced_spelling_is_the_contract_spelling() -> None:
    long = ('a"b\\c\n\u0001中😀' * 40_000)
    for value in (
        {"a": 1, "b": [1.5, -0.0, 1e300, None, True, False], "c": {"中": "😀"}},
        {"text": long, "list": [long[:7], {"k": long}]},
        ["x" * 200_000, 3],
        "plain",
        {},
        {"rows": [{"k": i, "v": "ab中😀", "f": i / 3, "n": None, "t": True} for i in range(5_000)]},
        {"outer": {f"key{i}": {"inner": list(range(i % 7)), "s": "q\"" * (i % 5)} for i in range(3_000)}},
        ([1, (2, 3)], {1: "int key", "s": 2}),
        {"deep": [[[[{"x": "y" * 30_000}]]]]},
    ):
        assert "".join(plan_mcp._spell_parts(value)) == contract.agent_tool_payload_text(value)  # noqa: SLF001
    with pytest.raises(ValueError):
        list(plan_mcp._spell_parts({"n": float("nan")}))  # noqa: SLF001


@pytest.mark.asyncio
async def test_a_call_cancelled_while_its_pieces_go_never_sends_the_request(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[str] = []
    third_piece = asyncio.Event()

    async def host(event: dict[str, Any]) -> bool:
        events.append(event["type"])
        if events.count(contract.AGENT_CAPABILITY_REQUEST_CHUNK_EVENT) == 3:
            third_piece.set()
        await asyncio.sleep(0.001)
        return True

    monkeypatch.setattr(app, "unicast_host", host)
    call = asyncio.create_task(request_host_agent_workspace_backend(
        "acme.devmap", "/workspace", {"arguments": _big(3 * 1_048_576)}, caller=_Caller(kind="external"), agent_tool=_agent_tool(),
    ))
    await third_piece.wait()
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    await asyncio.sleep(0.2)
    # The plugin never runs a call its caller cancelled.
    assert "agent.capability.request" not in events
    assert 3 <= events.count(contract.AGENT_CAPABILITY_REQUEST_CHUNK_EVENT) < 24
    assert plan_mcp._agent_capability_pending.pending == {}
    assert plan_mcp._agent_transfers == {}


@pytest.mark.asyncio
async def test_only_a_full_result_piece_restarts_the_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _host_session()
    seen: list[float] = []

    async def host(event: dict[str, Any]) -> bool:
        request_id = event["payload"]["request_id"]

        async def answer() -> None:
            await _send(session, contract.AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE, {
                "request_id": request_id, "seq": 0, "data": "x" * contract.AGENT_TOOL_CHUNK_BYTES,
            })
            seen.append(plan_mcp._agent_transfers[request_id]["activity"])
            await asyncio.sleep(0.05)
            await _send(session, contract.AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE, {"request_id": request_id, "seq": 1, "data": "y"})
            seen.append(plan_mcp._agent_transfers[request_id]["activity"])
            await _send(session, "agent.capability.result", {"request_id": request_id, "response": {
                "ok": True, "resultChunks": {"chunks": 2, "bytes": contract.AGENT_TOOL_CHUNK_BYTES + 1},
            }})

        asyncio.get_running_loop().create_task(answer())
        return True

    monkeypatch.setattr(app, "unicast_host", host)
    response = await request_host_agent_workspace_backend(
        "acme.devmap", "/workspace", {"arguments": {}}, caller=_Caller(kind="external"), agent_tool=_agent_tool(),
    )
    assert response["ok"] is True and response["result_pieces"] == ["x" * contract.AGENT_TOOL_CHUNK_BYTES, "y"]
    # The short last piece did not restart the wait (contract 4.4, Timing).
    assert seen[1] == seen[0]


@pytest.mark.asyncio
async def test_cut_arguments_are_the_contract_pieces_lone_surrogates_too() -> None:
    for arguments in ({"s": "a\ud800" * 100_000}, _big(300_000), {"rows": [{"k": i, "v": "中"} for i in range(20_000)]}):
        text = contract.agent_tool_payload_text(arguments)
        cut = await plan_mcp._agent_tool_argument_pieces({"payload": {"arguments": arguments}})  # noqa: SLF001
        assert cut is not None
        pieces, size = cut
        assert pieces == contract.split_agent_tool_payload_text(text)
        assert size == contract.utf8_byte_length(text)
    assert await plan_mcp._agent_tool_argument_pieces({"payload": {"arguments": {"a": 1}}}) is None  # noqa: SLF001


@pytest.mark.asyncio
async def test_a_host_that_registers_again_hears_the_result_helper_state(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend.mcp_server import plugin_agent_tools as proxy

    monkeypatch.setattr(app, "_HOST_SESSION_TOKEN", "host-secret")
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    # Idle (never started): nothing to tell, the registration answer comes last.
    await _send(session, "host.register", {"token": "host-secret"})
    assert session.websocket.sent[-1]["payload"] == {"registered": True}  # type: ignore[attr-defined]
    monkeypatch.setattr(proxy._result_worker, "state", "unavailable")  # noqa: SLF001
    monkeypatch.setattr(proxy._result_worker, "last_error", "it did not say it was ready within 30 s")  # noqa: SLF001
    again = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(again, {"id": "h2", "type": "host.register", "payload": {"token": "host-secret"}})
    sent = again.websocket.sent  # type: ignore[attr-defined]
    assert sent[0]["payload"] == {"registered": True}
    assert sent[1]["type"] == contract.AGENT_TOOLS_RESULT_HELPER_EVENT
    assert sent[1]["payload"]["state"] == "unavailable"
    assert sent[1]["payload"]["lastError"] == "it did not say it was ready within 30 s"
