"""acp_client against a real process speaking ACP (tests/fake_acp_agent.py)."""

from __future__ import annotations

import asyncio
import json
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend.acp_client import (
    CLIENT_CAPABILITIES,
    METHOD_NOT_FOUND,
    AcpClient,
    AcpClosed,
    AcpProtocolError,
)

FAKE_AGENT = Path(__file__).with_name("fake_acp_agent.py")


@asynccontextmanager
async def agent(scenario: str = "reply", *, on_permission=None):
    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(FAKE_AGENT), scenario,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    updates: list[dict[str, Any]] = []
    client = AcpClient(proc.stdout, proc.stdin, on_update=updates.append, on_permission=on_permission)
    client.start()
    try:
        yield client, updates, proc
    finally:
        await client.close()
        if proc.returncode is None:
            proc.kill()
        await proc.wait()


def texts(updates: list[dict[str, Any]], kind: str = "agent_message_chunk") -> list[str]:
    return [u["update"]["content"]["text"] for u in updates if u["update"]["sessionUpdate"] == kind]


async def test_initialize_offers_no_filesystem_and_no_terminal() -> None:
    async with agent() as (client, _updates, _proc):
        init = await client.initialize({"name": "Navide", "version": "test"})

    assert init.protocol_version == 1
    assert init.load_session and init.list_sessions
    assert init.agent_info["name"] == "fake-acp"
    assert CLIENT_CAPABILITIES == {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False}


async def test_a_turn_streams_its_updates_and_ends_with_its_stop_reason() -> None:
    async with agent() as (client, updates, _proc):
        await client.initialize()
        session = await client.new_session("/work")
        reason = await client.prompt(session, "hi")

    assert session == "s-1"
    assert reason == "end_turn"
    assert texts(updates) == ["Hello", ", world"]


async def test_a_permission_request_gets_the_chosen_option() -> None:
    asked: list[dict[str, Any]] = []

    async def choose(params: dict[str, Any]) -> str | None:
        asked.append(params)
        return "yes"

    async with agent("permission", on_permission=choose) as (client, updates, _proc):
        await client.initialize()
        session = await client.new_session("/work")
        assert await client.prompt(session, "write it") == "end_turn"

    assert [o["optionId"] for o in asked[0]["options"]] == ["yes", "no"]
    assert texts(updates) == ['outcome={"outcome": "selected", "optionId": "yes"}']


async def test_no_answer_to_a_permission_request_is_cancelled() -> None:
    async with agent("permission", on_permission=lambda _p: _none()) as (client, updates, _proc):
        await client.initialize()
        assert await client.prompt(await client.new_session("/w"), "x") == "end_turn"

    assert texts(updates) == ['outcome={"outcome": "cancelled"}']


async def _none() -> None:
    return None


async def test_cancelling_a_turn_answers_its_open_permission_request_cancelled() -> None:
    waiting = asyncio.Event()

    async def never(_params: dict[str, Any]) -> str | None:
        waiting.set()
        await asyncio.sleep(3600)
        return "yes"

    async with agent("permission", on_permission=never) as (client, updates, _proc):
        await client.initialize()
        session = await client.new_session("/w")
        turn = asyncio.ensure_future(client.prompt(session, "x"))
        await asyncio.wait_for(waiting.wait(), 10)
        await client.cancel(session)
        assert await asyncio.wait_for(turn, 10) == "end_turn"

    assert texts(updates) == ['outcome={"outcome": "cancelled"}']


async def test_cancel_ends_the_turn_with_cancelled() -> None:
    async with agent("cancel") as (client, updates, _proc):
        await client.initialize()
        session = await client.new_session("/w")
        turn = asyncio.ensure_future(client.prompt(session, "long job"))
        while len(texts(updates)) < 2:
            await asyncio.sleep(0.01)
        await client.cancel(session)
        assert await asyncio.wait_for(turn, 10) == "cancelled"


async def test_an_agent_that_ignores_cancel_is_left_running_not_killed() -> None:
    # No session/stop in ACP, and Navide adds no timeout: the turn stays open
    # until the agent answers or its process is ended by someone.
    async with agent("ignore_cancel") as (client, updates, proc):
        await client.initialize()
        session = await client.new_session("/w")
        turn = asyncio.ensure_future(client.prompt(session, "x"))
        while len(texts(updates)) < 2:
            await asyncio.sleep(0.01)
        await client.cancel(session)
        await asyncio.sleep(0.5)
        assert not turn.done() and proc.returncode is None
        proc.kill()
        with pytest.raises(AcpClosed):
            await asyncio.wait_for(turn, 10)


async def test_a_request_navide_does_not_serve_is_method_not_found() -> None:
    async with agent("ask_navide") as (client, updates, _proc):
        await client.initialize()
        assert await client.prompt(await client.new_session("/w"), "read") == "end_turn"

    assert texts(updates) == [f"error={METHOD_NOT_FOUND}"]


async def test_lines_that_are_not_messages_are_skipped() -> None:
    async with agent("bad_lines") as (client, updates, _proc):
        await client.initialize()
        assert await client.prompt(await client.new_session("/w"), "x") == "end_turn"
        assert client.bad_lines == 2

    assert texts(updates) == ["Hello", ", world"]


async def test_a_line_of_any_length_is_read_whole() -> None:
    async with agent("big") as (client, updates, _proc):
        await client.initialize()
        assert await client.prompt(await client.new_session("/w"), "x") == "end_turn"

    assert len(texts(updates)[0]) == 2 * 1024 * 1024


async def test_an_agent_that_exits_mid_turn_fails_the_turn() -> None:
    async with agent("exit") as (client, _updates, proc):
        await client.initialize()
        session = await client.new_session("/w")
        with pytest.raises(AcpClosed):
            await asyncio.wait_for(client.prompt(session, "x"), 10)
        assert await proc.wait() == 3
        assert client.closed
        with pytest.raises(AcpClosed):
            await client.new_session("/w")


async def test_another_protocol_version_is_refused() -> None:
    async with agent("version2") as (client, _updates, _proc):
        with pytest.raises(AcpProtocolError, match="version 2"):
            await client.initialize()


async def test_loading_a_session_replays_its_history_before_returning() -> None:
    async with agent() as (client, updates, _proc):
        await client.initialize()
        await client.load_session("s-1", "/w")
        listed = await client.list_sessions(cwd="/w")

    assert texts(updates, "user_message_chunk") == ["earlier question"]
    assert texts(updates) == ["earlier answer"]
    assert listed["sessions"] == [{"sessionId": "s-1", "cwd": "/w"}]


def test_the_fake_agent_speaks_one_json_message_per_line() -> None:
    # Guard for the fixture itself: every line it writes for a turn parses.
    import subprocess

    lines = [
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1}}),
        json.dumps({"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": "/w", "mcpServers": []}}),
        json.dumps({"jsonrpc": "2.0", "id": 3, "method": "session/prompt",
                    "params": {"sessionId": "s-1", "prompt": [{"type": "text", "text": "hi"}]}}),
    ]
    out = subprocess.run(
        [sys.executable, str(FAKE_AGENT), "reply"], input="\n".join(lines) + "\n",
        capture_output=True, text=True, timeout=30,
    ).stdout
    messages = [json.loads(line) for line in out.splitlines()]
    assert messages[-1] == {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}}
