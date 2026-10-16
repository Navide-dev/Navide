"""The bidirectional tools composed, rather than each proven alone.

Every tool here has its own unit tests. This asks the different question the
audit was about: do they make the round trip that was missing — one agent
sending, the other reading and answering, either side able to take it back or
learn who is waiting?

Written after a hand-run smoke script found a real defect the unit suites
could not: the three-language docs described cli_whoami's answer as nested
under a `you` key, while the tool answers flat. Nothing compared the two, so
nothing went red. The shape assertions below are that comparison.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean() -> Any:
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()
    plan_mcp._idle_waiters.clear()
    yield
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()
    plan_mcp._idle_waiters.clear()


@pytest.fixture
def broadcasts(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake(event: dict[str, Any], **_kw: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake)
    return events


def _ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _pair() -> None:
    agent_messaging.register("pa", "alice", "/ws/demo")
    agent_messaging.register("pb", "bob", "/ws/demo", spawned_by="pa")


@pytest.mark.asyncio
async def test_whoami_answers_flat_exactly_as_its_docstring_says() -> None:
    """The defect the smoke run found. The docs claimed a `you` wrapper the
    tool has never produced, so an agent following them would read undefined
    from every field. Pinned against the docstring, which is what an MCP
    client actually reads."""
    _pair()

    me = await plan_mcp.cli_whoami(_ctx("pb"))

    assert "you" not in me, "the answer is flat; a wrapper would break every caller"
    assert {"ok", "caller", "name", "address", "pane_id", "workspace_path"} <= set(me)
    assert me["pane_id"] == "pb"
    assert me["name"] == "bob"


@pytest.mark.asyncio
async def test_the_three_language_tables_describe_the_shape_that_ships() -> None:
    """Docs and docstring disagreed once and nothing noticed. This compares
    the tool's own return keys against what the tables promise."""
    import pathlib
    import re

    root = pathlib.Path(__file__).resolve().parents[2]
    _pair()
    real = set(await plan_mcp.cli_whoami(_ctx("pb"))) - {"ok"}

    for locale in ("en-US", "zh-TW", "ja-JP"):
        table = (root / "docs" / locale / "external-mcp-control.md").read_text(encoding="utf-8")
        row = next(ln for ln in table.splitlines() if "`cli_whoami`" in ln)
        promised = set(re.findall(r"[a-z_]+(?=[,}?])", row.split("`{ok,")[1]))
        missing = real - promised - {"same_workspace"}
        assert not missing, f"{locale} omits {sorted(missing)} from cli_whoami's answer"
        assert "you" not in promised, f"{locale} still describes a `you` wrapper"


@pytest.mark.asyncio
async def test_a_message_can_be_sent_threaded_and_taken_back(
    broadcasts: list[dict[str, Any]],
) -> None:
    """Send with a reply link, then withdraw it — the two halves the audit
    added, exercised in the order they happen."""
    _pair()

    sent = await plan_mcp.cli_send("bob", "have a look", _ctx("pa"), reply_to="k-earlier")
    assert sent["ok"] is True
    assert broadcasts[0]["payload"]["reply_to"] == "k-earlier"
    key = sent["msg_key"]

    async def window_answers() -> None:
        for _ in range(200):
            if any(e["type"] == "agent_msg.cancel" for e in broadcasts):
                plan_mcp.record_delivery_result(key, False, '{"key":"cancelled"}')
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(window_answers())
    taken_back = await plan_mcp.cli_cancel_message(key, _ctx("pa"))
    await task

    assert taken_back["status"] == "cancelled"
    # And the sender's own query agrees — a withdrawal must never read as a
    # failure, which is what would invite the resend it was meant to prevent.
    assert (await plan_mcp.cli_check_message(key, _ctx("pa")))["status"] == "cancelled"


@pytest.mark.asyncio
async def test_an_empty_inbox_summary_says_how_much_it_remembers(
    broadcasts: list[dict[str, Any]],
) -> None:
    """"Nothing stuck" and "the process forgot everything" produced identical
    output before this. They must not now."""
    _pair()
    await plan_mcp.cli_send("bob", "one", _ctx("pa"))
    await plan_mcp.cli_send("bob", "two", _ctx("pa"))

    box = await plan_mcp.cli_inbox_summary(_ctx("pa"))

    assert box["count"] == 0, "neither send is stuck"
    assert box["tracked"] >= 2, "but both are still remembered"
    assert box["tracking_since_s"] >= 0


@pytest.mark.asyncio
async def test_the_pane_being_waited_on_can_see_it(
    broadcasts: list[dict[str, Any]],
) -> None:
    """The bite scenario: B keeps digging because it cannot see A's clock.

    Note the setup — cli_wait_idle returns at once when the target has no
    recorded activity ("already idle"), so nobody waits and nothing registers.
    Making bob look busy first is what puts the call into its polling loop.
    """
    _pair()
    app._record_pane_activity("pb", "agent_active", "")

    waiter = asyncio.create_task(
        plan_mcp.cli_wait_idle("bob", _ctx("pa"), timeout_s=1.5)
    )
    await asyncio.sleep(0.25)

    seen = (await plan_mcp.cli_whoami(_ctx("pb"))).get("waiting_on_me") or []
    assert len(seen) == 1, f"bob should see alice waiting, got {seen}"
    assert seen[0].get("name") == "alice" or seen[0].get("pane_id") == "pa"
    assert isinstance(seen[0]["waiting_s"], (int, float))

    waiter.cancel()
    try:
        await waiter
    except asyncio.CancelledError:
        pass
    await asyncio.sleep(0.05)

    # A cancelled wait must unwind its registration, or the pane looks
    # permanently waited-on and the signal stops meaning anything.
    assert "waiting_on_me" not in await plan_mcp.cli_whoami(_ctx("pb"))
