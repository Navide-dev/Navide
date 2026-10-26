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


# -- hostile or racing input, fed line by line (#584 review) ----------------


class FakeWriter:
    """The agent's stdin: records what Navide writes; drain can be held."""

    def __init__(self) -> None:
        self.lines: list[dict[str, Any]] = []
        self.hold: asyncio.Event | None = None

    def write(self, data: bytes) -> None:
        for line in data.decode("utf-8").splitlines():
            self.lines.append(json.loads(line))

    async def drain(self) -> None:
        if self.hold is not None:
            await self.hold.wait()

    def close(self) -> None:
        pass

    def replies(self, request_id: Any) -> list[dict[str, Any]]:
        return [m for m in self.lines if m.get("id") == request_id and "method" not in m]


def wired(on_permission=None) -> tuple[AcpClient, asyncio.StreamReader, FakeWriter, list[dict[str, Any]]]:
    reader = asyncio.StreamReader()
    writer = FakeWriter()
    updates: list[dict[str, Any]] = []
    client = AcpClient(reader, writer, on_update=updates.append, on_permission=on_permission)  # type: ignore[arg-type]
    client.start()
    return client, reader, writer, updates


def feed(reader: asyncio.StreamReader, message: Any) -> None:
    reader.feed_data((message if isinstance(message, str) else json.dumps(message)).encode("utf-8") + b"\n")


def update(text: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "method": "session/update", "params": {
        "sessionId": "s-1", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}},
    }}


def permission_request(request_id: int) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "method": "session/request_permission", "params": {
        "sessionId": "s-1", "toolCall": {"title": "write"},
        "options": [{"optionId": "yes", "name": "Allow", "kind": "allow_once"}],
    }}


async def settle() -> None:
    for _ in range(20):
        await asyncio.sleep(0)


async def test_output_json_cannot_parse_or_nest_is_skipped_and_reading_goes_on() -> None:
    from agent_team_backend.acp_client import INTERNAL_ERROR, AcpError

    client, reader, writer, updates = wired()
    try:
        pending = asyncio.ensure_future(client.request("session/list", {}))
        await settle()
        request_id = writer.lines[-1]["id"]
        feed(reader, '{"n": ' + "9" * 5000 + "}")  # too many digits: ValueError
        feed(reader, "[" * 200_000)  # too deep: RecursionError
        feed(reader, {"jsonrpc": "2.0", "id": request_id, "error": {"code": "abc", "message": "bad"}})
        feed(reader, update("still reading"))
        await settle()

        with pytest.raises(AcpError) as err:
            await asyncio.wait_for(pending, 5)
        assert err.value.code == INTERNAL_ERROR
        assert [u["update"]["content"]["text"] for u in updates] == ["still reading"]
        assert client.bad_lines == 2 and not client.closed
    finally:
        await client.close()


async def test_a_permission_request_after_cancel_is_answered_cancelled_without_asking() -> None:
    asked: list[dict[str, Any]] = []

    async def choose(params: dict[str, Any]) -> str | None:
        asked.append(params)
        return "yes"

    client, reader, writer, _updates = wired(on_permission=choose)
    try:
        turn = asyncio.ensure_future(client.prompt("s-1", "x"))
        await settle()
        prompt_id = writer.lines[-1]["id"]
        await client.cancel("s-1")
        feed(reader, permission_request(900))  # arrives after the cancel
        await settle()

        assert asked == []
        assert writer.replies(900)[0]["result"] == {"outcome": {"outcome": "cancelled"}}

        feed(reader, {"jsonrpc": "2.0", "id": prompt_id, "result": {"stopReason": "cancelled"}})
        assert await asyncio.wait_for(turn, 5) == "cancelled"
        # The next turn asks again.
        turn = asyncio.ensure_future(client.prompt("s-1", "y"))
        await settle()
        feed(reader, permission_request(901))
        await settle()
        assert len(asked) == 1
        assert writer.replies(901)[0]["result"]["outcome"] == {"outcome": "selected", "optionId": "yes"}
        turn.cancel()
    finally:
        await client.close()


async def test_a_boolean_id_answers_no_request() -> None:
    client, reader, writer, _updates = wired()
    try:
        pending = asyncio.ensure_future(client.request("session/list", {}))
        await settle()
        assert writer.lines[-1]["id"] == 1
        feed(reader, {"jsonrpc": "2.0", "id": True, "result": {"sessions": ["wrong"]}})
        await settle()
        assert not pending.done()
        feed(reader, {"jsonrpc": "2.0", "id": 1, "result": {"sessions": []}})
        assert await asyncio.wait_for(pending, 5) == {"sessions": []}
    finally:
        await client.close()


async def test_a_long_line_arriving_in_pieces_is_read_whole() -> None:
    client, reader, _writer, updates = wired()
    try:
        line = json.dumps(update("x" * (3 * 1024 * 1024))).encode("utf-8")
        for start in range(0, len(line), 4096):
            reader.feed_data(line[start:start + 4096])
            await asyncio.sleep(0)
        reader.feed_data(b"\n")
        await settle()
        assert len(updates[0]["update"]["content"]["text"]) == 3 * 1024 * 1024
    finally:
        await client.close()


async def test_a_cancel_racing_the_users_answer_does_not_reply_twice() -> None:
    client, reader, writer, _updates = wired(on_permission=lambda params: asyncio.sleep(0, "yes"))
    try:
        turn = asyncio.ensure_future(client.prompt("s-1", "x"))
        await settle()
        writer.hold = asyncio.Event()  # the answer is being written...
        feed(reader, permission_request(902))
        await settle()
        cancel = asyncio.ensure_future(client.cancel("s-1"))  # ...when the cancel lands
        await settle()
        writer.hold.set()
        await asyncio.wait_for(cancel, 5)
        await settle()
        assert len(writer.replies(902)) == 1
        turn.cancel()
    finally:
        await client.close()


async def test_close_waits_for_the_requests_it_cancels() -> None:
    started = asyncio.Event()

    async def forever(_params: dict[str, Any]) -> str | None:
        started.set()
        await asyncio.sleep(3600)
        return None

    client, reader, _writer, _updates = wired(on_permission=forever)
    feed(reader, permission_request(903))
    await asyncio.wait_for(started.wait(), 5)
    serving = list(client._serving)  # noqa: SLF001
    assert serving

    await client.close()

    assert all(task.done() for task in serving)
