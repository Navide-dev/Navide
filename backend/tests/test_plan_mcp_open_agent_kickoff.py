"""cli_open_agent blocks on the KICKOFF verdict, not just the spawn verdict.

The spawn verdict says the pane exists. The task is typed into it afterwards,
and that half was failing silently: the tool had already answered ok, the
caller took "ok" for "delivered", and six minutes later the pane was still
idle with an empty prompt. Now the window emits a second event —
agent_spawn.kickoff — once the injection settles, and the tool waits for it:
the answer carries `kickoff: "sent"` or `kickoff: "failed"` plus a hint to
resend with cli_send, and never a "pending".
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


async def _answer_spawn(pane_id: str = "child-1", name: str = "reviewer") -> str:
    """Stand in for the window: answer the spawn verdict, return the request id."""
    for _ in range(400):
        keys = list(plan_mcp._pending_spawns)
        if keys:
            agent_messaging.register(pane_id, name, "/ws/alpha")
            plan_mcp.resolve_spawn(keys[0], {"ok": True, "pane_id": pane_id, "name": name})
            return keys[0]
        await asyncio.sleep(0.005)
    raise AssertionError("cli_open_agent never broadcast its spawn request")


@pytest.mark.asyncio
async def test_open_agent_answers_kickoff_sent_once_the_window_reports_it(
    captured: list[dict[str, Any]],
) -> None:
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")

    async def window() -> None:
        request_id = await _answer_spawn()
        await asyncio.sleep(0.01)
        assert plan_mcp.resolve_kickoff(
            request_id, {"pane_id": "child-1", "kickoff": "sent"}
        ) is True

    task = asyncio.create_task(window())
    result = await plan_mcp.cli_open_agent("codex", "reviewer", "review the PR", _ctx())
    await task

    assert result == {
        "ok": True,
        "name": "reviewer",
        "address": "alpha/reviewer",
        "pane_id": "child-1",
        "kickoff": "sent",
    }
    # Neither pending entry may outlive the call.
    assert plan_mcp._pending_spawns == {}
    assert plan_mcp._pending_kickoffs == {}


@pytest.mark.asyncio
async def test_open_agent_answers_kickoff_failed_with_a_resend_hint(
    captured: list[dict[str, Any]],
) -> None:
    """A failed kickoff is still ok: True — the pane exists and must not be
    opened again — but the caller is told, in the same answer, what to do."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")

    async def window() -> None:
        request_id = await _answer_spawn()
        plan_mcp.resolve_kickoff(
            request_id,
            {"pane_id": "child-1", "kickoff": "failed", "reason": "typed 2× and never verified"},
        )

    task = asyncio.create_task(window())
    result = await plan_mcp.cli_open_agent("codex", "reviewer", "review the PR", _ctx())
    await task

    assert result["ok"] is True
    assert result["pane_id"] == "child-1"
    assert result["kickoff"] == "failed"
    assert "cli_send" in result["hint"]
    assert "alpha/reviewer" in result["hint"]
    # The window's reason rides along in advisories, next to the gate's notes.
    assert "typed 2× and never verified" in " ".join(result["advisories"])


@pytest.mark.asyncio
async def test_open_agent_treats_an_unverified_kickoff_as_failed(
    captured: list[dict[str, Any]],
) -> None:
    """The return shape has two values only. "unverified" is the window's
    honest word for "bytes written, nothing seen" — to the caller that is a
    task that did not arrive."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")

    async def window() -> None:
        request_id = await _answer_spawn()
        plan_mcp.resolve_kickoff(request_id, {"pane_id": "child-1", "kickoff": "unverified"})

    task = asyncio.create_task(window())
    result = await plan_mcp.cli_open_agent("codex", "reviewer", "review the PR", _ctx())
    await task

    assert result["kickoff"] == "failed"
    assert "cli_send" in result["hint"]
    # But NOT a blind resend: 'unverified' is also what the window answers when
    # its own text is still sitting in the composer, where a resend would
    # submit both as one prompt. The caller is told to look first.
    assert "cli_get_status" in result["hint"]
    assert "never reached" not in result["hint"]


@pytest.mark.asyncio
async def test_open_agent_times_out_the_kickoff_wait_as_failed(
    captured: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """No verdict inside the deadline is a failure, not a hang and not "pending"."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    monkeypatch.setattr(plan_mcp, "_KICKOFF_VERDICT_TIMEOUT_S", 0.05)

    task = asyncio.create_task(_answer_spawn())
    result = await plan_mcp.cli_open_agent("codex", "reviewer", "review the PR", _ctx())
    await task

    assert result["ok"] is True
    assert result["kickoff"] == "failed"
    assert "cli_send" in result["hint"]
    # The window may still be typing it past the deadline (a cold CLI plus its
    # session-marker turn): a resend-now hint would double the task once it
    # lands, so the timeout reads as "look first", not "never arrived".
    assert "cli_get_status" in result["hint"]
    assert "never reached" not in result["hint"]
    assert "may still be typing" in " ".join(result["advisories"])
    assert plan_mcp._pending_kickoffs == {}


@pytest.mark.asyncio
async def test_a_refused_spawn_does_not_wait_for_a_kickoff(
    captured: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nothing was opened, so there is nothing to kick off — and no 45s wait."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    monkeypatch.setattr(plan_mcp, "_KICKOFF_VERDICT_TIMEOUT_S", 30.0)

    async def refuse() -> None:
        for _ in range(400):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                plan_mcp.resolve_spawn(keys[0], {"ok": False, "error": "已達子 pane 上限 (3)"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(refuse())
    result = await asyncio.wait_for(
        plan_mcp.cli_open_agent("codex", "extra", "do a thing", _ctx()), timeout=2.0
    )
    await task

    assert result == {"ok": False, "error": "已達子 pane 上限 (3)"}
    assert plan_mcp._pending_kickoffs == {}


@pytest.mark.asyncio
async def test_a_kickoff_verdict_that_beats_the_spawn_verdict_is_not_lost(
    captured: list[dict[str, Any]],
) -> None:
    """The standalone path types the task BEFORE answering the spawn, so its
    kickoff event can arrive first. The kickoff future must be registered
    before the request is broadcast, not after the spawn verdict."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")

    async def window() -> None:
        for _ in range(400):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                assert plan_mcp.resolve_kickoff(keys[0], {"pane_id": "child-1", "kickoff": "sent"})
                agent_messaging.register("child-1", "reviewer", "/ws/alpha")
                plan_mcp.resolve_spawn(keys[0], {"ok": True, "pane_id": "child-1", "name": "reviewer"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(window())
    result = await plan_mcp.cli_open_agent("codex", "reviewer", "review the PR", _ctx())
    await task

    assert result["kickoff"] == "sent"


@pytest.mark.asyncio
async def test_a_broadcast_that_raises_leaks_no_pending_kickoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only the TimeoutError path and the two verdict paths drop the kickoff
    future. Anything else thrown between registering it and awaiting it — a
    broadcast that raises — used to leave it in the dict for the life of the
    process, one entry per call."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")

    async def exploding_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        raise RuntimeError("no sockets")

    monkeypatch.setattr(app, "broadcast", exploding_broadcast)

    with pytest.raises(RuntimeError):
        await plan_mcp.cli_open_agent("codex", "reviewer", "review the PR", _ctx())

    assert plan_mcp._pending_spawns == {}
    assert plan_mcp._pending_kickoffs == {}


@pytest.mark.asyncio
async def test_a_cancelled_call_leaks_no_pending_kickoff(
    captured: list[dict[str, Any]],
) -> None:
    """The cleanup catches BaseException rather than Exception on purpose.
    CancelledError is not an Exception, and a cli_open_agent whose MCP client
    disconnects mid-wait is cancelled exactly there — an `except Exception`
    would walk past it and leave the future behind, one per dropped call."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    call = asyncio.create_task(
        plan_mcp.cli_open_agent("codex", "reviewer", "review the PR", _ctx())
    )
    for _ in range(400):
        if plan_mcp._pending_spawns:
            break
        await asyncio.sleep(0.005)
    assert plan_mcp._pending_kickoffs, "the kickoff future is registered before the broadcast"
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    assert plan_mcp._pending_spawns == {}
    assert plan_mcp._pending_kickoffs == {}


def test_resolve_kickoff_ignores_an_unknown_request_id() -> None:
    assert plan_mcp.resolve_kickoff("nope", {"kickoff": "sent"}) is False


def test_docstring_no_longer_says_ok_means_only_that_the_pane_exists() -> None:
    doc = plan_mcp.cli_open_agent.__doc__ or ""
    assert "kickoff" in doc
    assert "`ok: true` means the PANE EXISTS — not that the task arrived" not in doc
