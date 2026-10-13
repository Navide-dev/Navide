"""cli_send / cli_list_targets: the MCP face of inter-CLI messaging.

The `---MSG---` output protocol only reaches agents taught it in their kickoff,
so a hand-opened pane cannot discover it. These tools appear in the agent's tool
list on their own and route through the same registry.
"""

from __future__ import annotations

import asyncio
import pathlib
import re
import time
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, model_args, app
from agent_team_backend.mcp_server import server as plan_mcp, auth as plan_mcp_auth, wiring as plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()
    plan_mcp._status_waiters.clear()
    yield
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()
    plan_mcp._status_waiters.clear()


def _external_ctx() -> Any:
    """A Context authenticated as an external client (no pane identity)."""
    plan_mcp_auth.set_external_enabled(True)
    params = {"client": "external", "t": plan_mcp_auth.external_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _host_ctx() -> Any:
    """A Context authenticated as this backend's own CLI wiring (no pane id)."""
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _ctx(pane_id: str | None = "pa", token: str | None = None) -> Any:
    """A Context whose HTTP request carries the pane-identifying query string."""
    if pane_id is None:
        return SimpleNamespace(request_context=SimpleNamespace(request=None))
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token() if token is None else token}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _seed() -> None:
    agent_messaging.register("pa", "sender", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "reviewer", "/ws/beta", agent_key="codex")
    agent_messaging.register("pc", "helper", "/ws/alpha", agent_key="claude")


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


# ── Caller identity ────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_send_refuses_when_the_request_cannot_identify_a_pane(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx(pane_id=None))
    assert result["ok"] is False
    assert "identify your pane" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_send_refuses_a_bad_caller_token(captured: list[dict[str, Any]]) -> None:
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx(token="not-the-token"))
    assert result["ok"] is False
    assert "token rejected" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_send_refuses_a_pane_id_that_is_no_longer_live(
    captured: list[dict[str, Any]],
) -> None:
    """An id naming no pane at all — closed, or its window gone long enough to
    be forgotten. Acting on it would break self-send detection and strip the
    sender's identity. (An id a live pane inherited resolves instead — see
    test_plan_mcp_stale_alias.py.)"""
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx(pane_id="long-gone"))
    assert result["ok"] is False
    assert "stale" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_list_targets_refuses_a_stale_pane_id() -> None:
    _seed()
    result = await plan_mcp.cli_list_targets(_ctx(pane_id="long-gone"))
    assert result["targets"] == []
    assert "stale" in result["error"]


# ── Sending ────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_send_broadcasts_the_delivery(captured: list[dict[str, Any]]) -> None:
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "run the tests", _ctx())

    assert result["ok"] is True
    assert result["target"] == "beta/reviewer"
    assert result["cross_workspace"] is True
    # The result is an agent-facing contract; nothing may quietly join it.
    assert set(result) == {"ok", "target", "cross_workspace", "msg_key"}
    assert len(captured) == 1
    payload = captured[0]["payload"]
    assert captured[0]["type"] == "agent_msg.deliver"
    assert payload["target_pane_id"] == "pb"
    assert payload["from_display"] == "alpha/sender"
    assert payload["content"] == "run the tests"
    assert payload["cross_workspace"] is True
    # This path never went through the frontend's send-side rate limit, so the
    # receiving window has to apply it — otherwise two agents replying to each
    # other through cli_send have no loop guard.
    assert payload["rate_limit"] is True


@pytest.mark.asyncio
async def test_send_to_a_bare_name_stays_in_the_callers_workspace(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_send("helper", "local please", _ctx())

    assert result["ok"] is True
    assert result["cross_workspace"] is False
    assert captured[0]["payload"]["target_pane_id"] == "pc"


@pytest.mark.asyncio
async def test_send_refuses_unknown_ambiguous_and_self(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    agent_messaging.register("pd", "reviewer", "/ws/dup")
    agent_messaging.register("pe", "reviewer", "/ws/dup")

    unknown = await plan_mcp.cli_send("gamma/reviewer", "x", _ctx())
    assert unknown["ok"] is False and "unknown workspace" in unknown["error"]

    ambiguous = await plan_mcp.cli_send("dup/reviewer", "x", _ctx())
    assert ambiguous["ok"] is False and "ambiguous target" in ambiguous["error"]

    myself = await plan_mcp.cli_send("sender", "x", _ctx())
    assert myself["ok"] is False and "your own pane" in myself["error"]

    assert captured == []


@pytest.mark.asyncio
async def test_send_to_a_chat_sender_is_handed_to_the_channel(
    captured: list[dict[str, Any]],
) -> None:
    _seed()

    for kind in ("message", "ack"):
        res = await plan_mcp.cli_send(" telegram:neillu123 ", "done", _ctx(), kind=kind)
        assert res["ok"] is True
        assert res["handed_to_channel"] is True
        assert res["target"] == "telegram:neillu123"
        assert "MSG" in res["note"]

    # A pane name that merely contains a colon is still a pane name.
    unknown = await plan_mcp.cli_send("notaplatform:x", "x", _ctx())
    assert unknown["ok"] is False and unknown["error_code"] == "unknown-target"

    assert captured == []


# ── Addressing one exact pane by id ────────────────────────────────────────
@pytest.mark.asyncio
async def test_pane_id_names_one_of_two_panes_sharing_a_name(
    captured: list[dict[str, Any]],
) -> None:
    """The case a name cannot express: two panes, one workspace, same name."""
    _seed()
    agent_messaging.register("pd", "reviewer", "/ws/dup")
    agent_messaging.register("pe", "reviewer", "/ws/dup")

    by_name = await plan_mcp.cli_send("dup/reviewer", "x", _ctx())
    assert by_name["ok"] is False and by_name["error_code"] == "ambiguous-target"
    # The refusal points at the way out rather than only at renaming.
    assert "pane_id" in by_name["error"]

    result = await plan_mcp.cli_send("", "second one please", _ctx(), pane_id="pe")
    assert result["ok"] is True
    assert result["target"] == "dup/reviewer"
    assert result["cross_workspace"] is True
    assert len(captured) == 1
    assert captured[0]["payload"]["target_pane_id"] == "pe"
    assert captured[0]["payload"]["content"] == "second one please"


@pytest.mark.asyncio
async def test_pane_id_wins_over_a_to_that_would_resolve_elsewhere(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "x", _ctx(), pane_id="pc")
    assert result["ok"] is True
    assert captured[0]["payload"]["target_pane_id"] == "pc"
    assert result["cross_workspace"] is False


@pytest.mark.asyncio
async def test_pane_id_that_names_nothing_is_refused(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_send("", "x", _ctx(), pane_id="nope")
    assert result["ok"] is False
    assert result["error_code"] == "unknown-pane-id"
    assert "cli_list_targets" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_pane_id_follows_a_rebuilt_pane(captured: list[dict[str, Any]]) -> None:
    """An id handed to a CLI before its pane was rebuilt still reaches it."""
    _seed()
    agent_messaging.unregister("pb")
    agent_messaging.register("pb2", "reviewer", "/ws/beta", agent_key="codex")
    agent_messaging.add_aliases("pb2", ["pb"], "/ws/beta")

    result = await plan_mcp.cli_send("", "x", _ctx(), pane_id="pb")
    assert result["ok"] is True
    assert captured[0]["payload"]["target_pane_id"] == "pb2"


@pytest.mark.asyncio
async def test_pane_id_reports_an_offline_pane_as_offline(
    captured: list[dict[str, Any]],
) -> None:
    """Same distinction a name gets: the address is right, the window is away."""
    _seed()
    owner = object()
    agent_messaging.register("pf", "away", "/ws/beta", owner=owner)
    agent_messaging.drop_owner(owner)

    result = await plan_mcp.cli_send("", "x", _ctx(), pane_id="pf")
    assert result["ok"] is False
    assert result["error_code"] == "target-offline"
    assert captured == []


@pytest.mark.asyncio
async def test_pane_id_still_refuses_your_own_pane(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_send("", "x", _ctx(), pane_id="pa")
    assert result["ok"] is False and "your own pane" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_pane_id_frees_an_external_caller_from_qualifying_the_target(
    captured: list[dict[str, Any]],
) -> None:
    """An id is as qualified as an address gets, so the workspace rule that a
    caller without one must name a workspace does not apply."""
    _seed()
    unqualified = await plan_mcp.cli_send("reviewer", "x", _external_ctx())
    assert unqualified["ok"] is False

    result = await plan_mcp.cli_send("", "x", _external_ctx(), pane_id="pb")
    assert result["ok"] is True
    assert captured[0]["payload"]["target_pane_id"] == "pb"
    assert result["cross_workspace"] is True


@pytest.mark.asyncio
async def test_a_bare_name_matching_two_panes_is_refused_and_an_id_gets_through(
    captured: list[dict[str, Any]],
) -> None:
    """The bare name and the qualified address now agree, and the refusal names
    the way out — which is the whole point of the id having become an address."""
    _seed()
    agent_messaging.register("pd", "twin", "/ws/alpha")
    agent_messaging.register("pe", "twin", "/ws/alpha")

    refused = await plan_mcp.cli_send("twin", "x", _ctx())
    assert refused["ok"] is False
    assert refused["error_code"] == "ambiguous-target"
    assert "pane_id" in refused["error"]
    assert captured == []

    delivered = await plan_mcp.cli_send("", "the second twin", _ctx(), pane_id="pe")
    assert delivered["ok"] is True
    assert len(captured) == 1
    assert captured[0]["payload"]["target_pane_id"] == "pe"


@pytest.mark.asyncio
async def test_pane_id_is_ignored_when_blank(captured: list[dict[str, Any]]) -> None:
    """A blank id must not shadow the address — it is simply not given."""
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "x", _ctx(), pane_id="   ")
    assert result["ok"] is True
    assert captured[0]["payload"]["target_pane_id"] == "pb"


@pytest.mark.asyncio
async def test_send_refuses_empty_text(captured: list[dict[str, Any]]) -> None:
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "   ", _ctx())
    assert result["ok"] is False and "empty" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_message_key_is_unique_per_send(captured: list[dict[str, Any]]) -> None:
    _seed()
    await plan_mcp.cli_send("beta/reviewer", "one", _ctx())
    await plan_mcp.cli_send("beta/reviewer", "two", _ctx())
    keys = {e["payload"]["msg_key"] for e in captured}
    assert len(keys) == 2


@pytest.mark.asyncio
async def test_send_returns_the_msg_key_it_broadcast(captured: list[dict[str, Any]]) -> None:
    """Without it the sender cannot ask cli_check_message about its own
    message — the key exists only inside the broadcast payload."""
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "run the tests", _ctx())
    assert result["msg_key"] == captured[0]["payload"]["msg_key"]


# ── cli_check_message ──────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_check_message_reports_queued_until_a_window_answers(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())

    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())

    assert result["ok"] is True
    assert result["status"] == "queued"
    assert result["target"] == "beta/reviewer"
    assert "reason" not in result
    assert "settled_after_s" not in result


@pytest.mark.asyncio
async def test_check_message_reports_a_delivery(captured: list[dict[str, Any]]) -> None:
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    assert plan_mcp.record_delivery_result(sent["msg_key"], True, "") is True

    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())

    assert result["status"] == "delivered"
    assert isinstance(result["settled_after_s"], float)


@pytest.mark.asyncio
async def test_check_message_decodes_the_windows_structured_failure_reason(
    captured: list[dict[str, Any]],
) -> None:
    """The renderer sends its reason as JSON; an agent should read the key,
    not the wire format."""
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    plan_mcp.record_delivery_result(
        sent["msg_key"], False, '{"key":"rate-limit","params":{"seconds":30}}'
    )

    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())

    assert result["status"] == "failed"
    assert result["reason"] == "rate-limit"


@pytest.mark.asyncio
async def test_check_message_keeps_the_note_on_a_message_delivered_into_a_busy_cli(
    captured: list[dict[str, Any]],
) -> None:
    """A panel that waited out its quiet cap still pastes the message; the
    sender should see it went in while the CLI was busy, still as delivered."""
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    plan_mcp.record_delivery_result(sent["msg_key"], True, '{"key":"delivered-while-busy"}')

    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())

    assert result["status"] == "delivered"
    assert result["reason"] == "delivered-while-busy"


@pytest.mark.asyncio
async def test_check_message_keeps_an_undecodable_reason_verbatim(
    captured: list[dict[str, Any]],
) -> None:
    # Rows written before reasons were structured carry a plain sentence.
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    plan_mcp.record_delivery_result(sent["msg_key"], False, "pane closed")

    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())
    assert result["reason"] == "pane closed"


@pytest.mark.asyncio
async def test_check_message_rejects_an_unknown_key() -> None:
    _seed()
    result = await plan_mcp.cli_check_message("nope", _ctx())
    assert result["ok"] is False
    assert "unknown msg_key" in result["error"]


@pytest.mark.asyncio
async def test_check_message_refuses_an_unidentified_caller(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx(pane_id=None))
    assert result["ok"] is False
    assert "identify your pane" in result["error"]


def test_delivery_result_for_a_key_this_server_never_sent_is_ignored() -> None:
    # Every window reports every delivery, including ones the UI sent.
    assert plan_mcp.record_delivery_result("someone-elses-key", True, "") is False


@pytest.mark.asyncio
async def test_message_status_table_is_bounded_by_count(
    captured: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed()
    monkeypatch.setattr(plan_mcp, "_MESSAGE_STATUS_MAX", 3)
    keys = [(await plan_mcp.cli_send("beta/reviewer", f"m{i}", _ctx()))["msg_key"] for i in range(5)]

    assert len(plan_mcp._mcp_message_status) <= 3
    # The oldest sends are the ones evicted; the newest survive.
    assert keys[-1] in plan_mcp._mcp_message_status
    assert keys[0] not in plan_mcp._mcp_message_status


@pytest.mark.asyncio
async def test_message_status_table_is_bounded_by_ttl(
    captured: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed()
    monkeypatch.setattr(plan_mcp, "_MESSAGE_STATUS_TTL_S", 0.0)
    old = (await plan_mcp.cli_send("beta/reviewer", "old", _ctx()))["msg_key"]
    await plan_mcp.cli_send("beta/reviewer", "new", _ctx())

    assert old not in plan_mcp._mcp_message_status


# ── Listing ────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_list_targets_excludes_the_caller_and_flags_own_workspace() -> None:
    _seed()
    result = await plan_mcp.cli_list_targets(_ctx())

    assert result["you"] == "alpha/sender"
    by_address = {t["address"]: t for t in result["targets"]}
    assert set(by_address) == {"beta/reviewer", "alpha/helper"}
    assert by_address["alpha/helper"]["same_workspace"] is True
    assert by_address["beta/reviewer"]["same_workspace"] is False


@pytest.mark.asyncio
async def test_list_targets_carries_the_pane_id_ui_actions_need() -> None:
    """Every ui.pane.* action takes a pane id and rejects a name, so a roster
    without ids names panes it cannot tell you how to close or focus."""
    _seed()
    result = await plan_mcp.cli_list_targets(_ctx())

    by_address = {t["address"]: t for t in result["targets"]}
    assert by_address["beta/reviewer"]["pane_id"] == "pb"
    assert by_address["alpha/helper"]["pane_id"] == "pc"


@pytest.mark.asyncio
async def test_list_targets_carries_the_pane_id_for_a_caller_without_a_pane() -> None:
    """The host/external branch builds its targets separately — the id has to
    survive that path too, and those callers are the ones driving ui_invoke."""
    _seed()
    result = await plan_mcp.cli_list_targets(_external_ctx())

    assert {t["pane_id"] for t in result["targets"]} == {"pa", "pb", "pc"}


@pytest.mark.asyncio
async def test_list_targets_reports_an_unidentified_caller() -> None:
    _seed()
    result = await plan_mcp.cli_list_targets(_ctx(pane_id=None))
    assert result["targets"] == []
    assert "identify your pane" in result["error"]


# ── cli_open_agent ─────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_open_agent_broadcasts_the_request_and_returns_the_verdict(
    captured: list[dict[str, Any]],
) -> None:
    _seed()

    async def answer() -> None:
        # Stand in for the window that owns the requesting pane.
        for _ in range(200):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                agent_messaging.register("new-pane", "reviewer2", "/ws/alpha")
                plan_mcp.resolve_spawn(
                    keys[0], {"ok": True, "pane_id": "new-pane", "name": "reviewer2"}
                )
                plan_mcp.resolve_kickoff(keys[0], {"pane_id": "new-pane", "kickoff": "sent"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    result = await plan_mcp.cli_open_agent("codex", "reviewer2", "review the PR", _ctx())
    await task

    assert result == {
        "ok": True,
        "name": "reviewer2",
        "address": "alpha/reviewer2",
        "pane_id": "new-pane",
        "kickoff": "sent",
    }
    assert len(captured) == 1
    payload = captured[0]["payload"]
    assert captured[0]["type"] == "agent_spawn.request"
    assert payload["requester_pane_id"] == "pa"
    assert payload["agent_key"] == "codex"
    assert payload["name"] == "reviewer2"
    assert payload["task"] == "review the PR"


@pytest.mark.asyncio
async def test_open_agent_forwards_advisories_from_the_verdict(
    captured: list[dict[str, Any]],
) -> None:
    """The window's verdict may carry volume advisories (child/CLI-pane/depth
    counts past their threshold) alongside ok: True — cli_open_agent should
    hand those straight back rather than swallowing them."""
    _seed()

    async def answer() -> None:
        for _ in range(200):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                agent_messaging.register("new-pane", "reviewer3", "/ws/alpha")
                plan_mcp.resolve_spawn(
                    keys[0],
                    {
                        "ok": True,
                        "pane_id": "new-pane",
                        "name": "reviewer3",
                        "advisories": ["此工作區已有 8 個 CLI pane（建議值 8）"],
                    },
                )
                plan_mcp.resolve_kickoff(keys[0], {"pane_id": "new-pane", "kickoff": "sent"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    result = await plan_mcp.cli_open_agent("codex", "reviewer3", "review the PR", _ctx())
    await task

    assert result == {
        "ok": True,
        "name": "reviewer3",
        "address": "alpha/reviewer3",
        "pane_id": "new-pane",
        "kickoff": "sent",
        "advisories": ["此工作區已有 8 個 CLI pane（建議值 8）"],
    }


@pytest.mark.asyncio
async def test_open_agent_surfaces_a_refusal_reason(captured: list[dict[str, Any]]) -> None:
    _seed()

    async def refuse() -> None:
        for _ in range(200):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                plan_mcp.resolve_spawn(keys[0], {"ok": False, "error": "已達子 pane 上限 (3)"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(refuse())
    result = await plan_mcp.cli_open_agent("codex", "extra", "do a thing", _ctx())
    await task

    assert result == {"ok": False, "error": "已達子 pane 上限 (3)"}


@pytest.mark.asyncio
async def test_open_agent_times_out_when_no_window_answers(
    captured: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed()
    monkeypatch.setattr(plan_mcp, "_SPAWN_VERDICT_TIMEOUT_S", 0.05)

    result = await plan_mcp.cli_open_agent("codex", "orphan", "do a thing", _ctx())

    assert result["ok"] is False
    assert "no answer" in result["error"]
    # The pending entry must not leak once the wait gives up.
    assert plan_mcp._pending_spawns == {}


@pytest.mark.asyncio
async def test_open_agent_validates_its_arguments(captured: list[dict[str, Any]]) -> None:
    _seed()
    missing_agent = await plan_mcp.cli_open_agent("", "x", "t", _ctx())
    missing_name = await plan_mcp.cli_open_agent("codex", "  ", "t", _ctx())
    missing_task = await plan_mcp.cli_open_agent("codex", "x", "   ", _ctx())

    assert missing_agent["ok"] is False and "agent is required" in missing_agent["error"]
    assert missing_name["ok"] is False and "name is required" in missing_name["error"]
    assert missing_task["ok"] is False and "task is empty" in missing_task["error"]
    assert captured == []  # nothing broadcast for a malformed call


@pytest.mark.asyncio
async def test_open_agent_opens_a_terminal_with_no_task(captured: list[dict[str, Any]]) -> None:
    """A terminal's task is an optional first command; a bare prompt is a pane."""
    _seed()

    async def answer() -> None:
        for _ in range(200):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                agent_messaging.register("sh-pane", "shell", "/ws/alpha", agent_key="terminal")
                plan_mcp.resolve_spawn(keys[0], {"ok": True, "pane_id": "sh-pane", "name": "shell"})
                plan_mcp.resolve_kickoff(keys[0], {"pane_id": "sh-pane", "kickoff": "sent"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    result = await plan_mcp.cli_open_agent("terminal", "shell", "", _ctx())
    await task

    assert result["ok"] is True and result["pane_id"] == "sh-pane"
    payload = captured[0]["payload"]
    assert payload["agent_key"] == "terminal"
    assert payload["task"] == ""


@pytest.mark.asyncio
async def test_open_agent_refuses_model_effort_or_session_for_a_terminal(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    for kwargs in ({"model": "sonnet"}, {"effort": "high"}, {"session_id": "abc"}):
        result = await plan_mcp.cli_open_agent("terminal", "shell", "ls", _ctx(), **kwargs)
        assert result["ok"] is False and "plain shell" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_open_agent_refuses_an_unidentified_caller(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_open_agent("codex", "x", "t", _ctx(pane_id=None))
    assert result["ok"] is False
    assert "identify your pane" in result["error"]
    assert captured == []


def test_resolve_spawn_ignores_an_unknown_request_id() -> None:
    assert plan_mcp.resolve_spawn("nope", {"ok": True}) is False


# ── busy state ─────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_list_targets_reports_whether_a_target_is_busy() -> None:
    _seed()
    agent_messaging.set_busy("pb", True)
    result = await plan_mcp.cli_list_targets(_ctx())
    busy = {t["address"]: t["busy"] for t in result["targets"]}
    assert busy == {"beta/reviewer": True, "alpha/helper": False}


@pytest.mark.asyncio
async def test_a_terminal_pane_is_a_roster_entry_that_settles_on_quiet_period() -> None:
    """A plain shell has no turn end: once it stops printing (not busy), the
    wait settles on the silence, which is all a terminal can offer."""
    _seed()
    agent_messaging.register("ps", "shell", "/ws/alpha", agent_key="terminal")
    listed = await plan_mcp.cli_list_targets(_ctx())
    # The roster shape is frozen; cli_get_status is where agent_key is read.
    assert "alpha/shell" in {t["address"] for t in listed["targets"]}

    result = await plan_mcp.cli_wait_idle("shell", _ctx(), timeout_s=1.0)
    assert result["idle"] is True and result["source"] == "quiet_period"


def test_set_busy_reports_whether_it_changed() -> None:
    _seed()
    assert agent_messaging.set_busy("pa", True) is True
    assert agent_messaging.set_busy("pa", True) is False
    assert agent_messaging.set_busy("nope", True) is False


def test_re_register_keeps_busy_but_a_fresh_pane_starts_idle() -> None:
    agent_messaging.register("p1", "a", "/ws/alpha")
    agent_messaging.set_busy("p1", True)
    # A rename re-registers the same pane — that is not a state change.
    agent_messaging.register("p1", "renamed", "/ws/alpha")
    entry = agent_messaging.get("p1")
    assert entry is not None and entry.busy is True
    # A pane the registry has never seen starts idle.
    agent_messaging.register("p2", "b", "/ws/alpha")
    fresh = agent_messaging.get("p2")
    assert fresh is not None and fresh.busy is False


@pytest.mark.asyncio
async def test_tools_are_registered_without_a_ctx_argument() -> None:
    tools = {t.name: t for t in await plan_mcp.server.list_tools()}
    assert set(tools) >= {
        "cli_send", "cli_list_targets", "cli_open_agent", "cli_check_message",
        "cli_send_and_wait", "cli_read_log", "cli_get_status", "cli_wait_idle",
    }
    # The Context parameter is injected, never asked of the agent.
    assert set((tools["cli_send"].inputSchema.get("properties") or {})) == {
        "to", "text", "wait_for_delivery_s", "pane_id", "reply_to", "kind", "open_target",
    }
    assert not (tools["cli_list_targets"].inputSchema.get("properties") or {})
    assert set((tools["cli_open_agent"].inputSchema.get("properties") or {})) == {
        "agent", "name", "task", "workspace_path", "model", "effort", "pane_id",
        "session_id", "run_group_id",
    }
    assert set((tools["cli_check_message"].inputSchema.get("properties") or {})) == {"msg_key"}
    assert set((tools["cli_send_and_wait"].inputSchema.get("properties") or {})) == {
        "to", "text", "timeout_s", "pane_id", "reply_to",
    }
    # Every tool that addresses a pane takes an id as the unambiguous
    # alternative to a name; adding one without it has to fail here.
    for name in ("cli_send", "cli_send_and_wait", "cli_read_log",
                 "cli_get_status", "cli_wait_idle"):
        props = set(tools[name].inputSchema.get("properties") or {})
        assert "pane_id" in props, f"{name} cannot address a pane by id"


# ── external / host callers (no pane identity) ──────────────────────────────


@pytest.mark.asyncio
async def test_list_targets_for_an_external_caller_shows_every_pane_as_cross_workspace() -> None:
    _seed()
    result = await plan_mcp.cli_list_targets(_external_ctx())

    assert result["you"] == "external"
    by_address = {t["address"]: t for t in result["targets"]}
    assert set(by_address) == {"alpha/sender", "beta/reviewer", "alpha/helper"}
    assert all(t["same_workspace"] is False for t in by_address.values())


@pytest.mark.asyncio
async def test_send_from_an_external_caller_requires_a_qualified_address(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_send("reviewer", "hi", _external_ctx())
    assert result["ok"] is False
    assert "qualified" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_send_from_an_external_caller_delivers_to_a_qualified_target(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "run the tests", _external_ctx())

    assert result["ok"] is True
    assert result["target"] == "beta/reviewer"
    assert result["cross_workspace"] is True
    assert set(result) == {"ok", "target", "cross_workspace", "msg_key"}
    payload = captured[0]["payload"]
    assert payload["from_pane_id"] == ""
    assert payload["from_display"] == "an external client"


@pytest.mark.asyncio
async def test_send_from_a_host_caller_also_requires_a_qualified_address(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_send("reviewer", "hi", _host_ctx())
    assert result["ok"] is False
    assert "qualified" in result["error"]


@pytest.mark.asyncio
async def test_external_access_disabled_rejects_the_external_credential() -> None:
    ctx = _external_ctx()  # mints a valid external token and enables access
    plan_mcp_auth.set_external_enabled(False)  # then turn access back off

    result = await plan_mcp.cli_list_targets(ctx)

    assert result["targets"] == []
    assert "disabled" in result["error"]


@pytest.mark.asyncio
async def test_open_agent_from_an_external_caller_requires_workspace_path(
    captured: list[dict[str, Any]],
) -> None:
    result = await plan_mcp.cli_open_agent("codex", "x", "task", _external_ctx())
    assert result["ok"] is False
    assert "workspace_path is required" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_open_agent_from_an_external_caller_sends_target_workspace_with_no_parent(
    captured: list[dict[str, Any]],
) -> None:
    async def answer() -> None:
        for _ in range(200):
            # The window holding /ws/ext answers the readiness probe first.
            for probe in list(plan_mcp._ui_invoke_pending.pending):
                plan_mcp.resolve_ui_invoke(probe, {"ok": True, "result": [], "error": None})
            keys = list(plan_mcp._pending_spawns)
            if keys:
                agent_messaging.register("new-pane", "worker", "/ws/ext")
                plan_mcp.resolve_spawn(keys[0], {"ok": True, "pane_id": "new-pane", "name": "worker"})
                plan_mcp.resolve_kickoff(keys[0], {"pane_id": "new-pane", "kickoff": "sent"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    result = await plan_mcp.cli_open_agent(
        "codex", "worker", "do it", _external_ctx(), workspace_path="/ws/ext"
    )
    await task

    assert result == {
        "ok": True,
        "name": "worker",
        "address": "ext/worker",
        "pane_id": "new-pane",
        "kickoff": "sent",
    }
    payload = next(e for e in captured if e["type"] == "agent_spawn.request")["payload"]
    assert payload["requester_pane_id"] == ""
    assert payload["target_workspace"] == "/ws/ext"


@pytest.mark.asyncio
async def test_open_agent_from_a_pane_caller_never_sends_target_workspace(
    captured: list[dict[str, Any]],
) -> None:
    """Backward compatibility: a pane caller's spawn request payload is
    unchanged by the external-caller addition."""
    _seed()

    async def answer() -> None:
        for _ in range(200):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                agent_messaging.register("new-pane", "worker2", "/ws/alpha")
                plan_mcp.resolve_spawn(keys[0], {"ok": True, "pane_id": "new-pane", "name": "worker2"})
                plan_mcp.resolve_kickoff(keys[0], {"pane_id": "new-pane", "kickoff": "sent"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    result = await plan_mcp.cli_open_agent("codex", "worker2", "do it", _ctx())
    await task

    assert result["ok"] is True
    assert "target_workspace" not in captured[0]["payload"]


# ── Offline targets (a disconnected window, not a missing pane) ─────────────
@pytest.mark.asyncio
async def test_send_to_an_offline_target_is_refused_apart_from_unknown_target(
    captured: list[dict[str, Any]],
) -> None:
    """A dropped WS connection used to erase the window's panes, so cli_send
    answered "unknown target" — "you got the name wrong" — for a pane that was
    only unreachable. The two now carry different codes."""
    window = object()
    agent_messaging.register("pa", "sender", "/ws/alpha", owner=object())
    agent_messaging.register("pb", "reviewer", "/ws/beta", owner=window)
    agent_messaging.drop_owner(window)

    offline = await plan_mcp.cli_send("beta/reviewer", "x", _ctx())
    assert offline["ok"] is False
    assert offline["error_code"] == "target-offline"
    assert "offline" in offline["error"]

    missing = await plan_mcp.cli_send("beta/nobody", "x", _ctx())
    assert missing["error_code"] == "unknown-target-in-workspace"
    # Nothing was handed to a window that could not receive it.
    assert captured == []


@pytest.mark.asyncio
async def test_send_works_again_once_the_window_reconnects(
    captured: list[dict[str, Any]],
) -> None:
    window = object()
    agent_messaging.register("pa", "sender", "/ws/alpha", owner=object())
    agent_messaging.register("pb", "reviewer", "/ws/beta", owner=window)
    agent_messaging.drop_owner(window)
    assert (await plan_mcp.cli_send("beta/reviewer", "x", _ctx()))["ok"] is False

    agent_messaging.register("pb", "reviewer", "/ws/beta", owner=object())
    result = await plan_mcp.cli_send("beta/reviewer", "x", _ctx())
    assert result["ok"] is True
    assert len(captured) == 1


@pytest.mark.asyncio
async def test_send_reports_unknown_target_once_the_grace_period_lapses() -> None:
    window = object()
    agent_messaging.register("pa", "sender", "/ws/alpha", owner=object())
    agent_messaging.register("pb", "reviewer", "/ws/beta", owner=window)
    agent_messaging.drop_owner(window)
    agent_messaging.get("pb").offline_since -= agent_messaging.OFFLINE_GRACE_S + 1

    result = await plan_mcp.cli_send("beta/reviewer", "x", _ctx())
    assert result["ok"] is False
    assert result["error_code"] == "unknown-workspace"


@pytest.mark.asyncio
async def test_get_status_of_an_offline_pane_is_not_unknown_target() -> None:
    window = object()
    agent_messaging.register("pa", "sender", "/ws/alpha", owner=object())
    agent_messaging.register("pb", "reviewer", "/ws/beta", owner=window)
    agent_messaging.drop_owner(window)

    result = await plan_mcp.cli_get_status("beta/reviewer", _ctx())
    assert result["ok"] is False
    assert result["error_code"] == "target-offline"


@pytest.mark.asyncio
async def test_list_targets_flags_an_offline_pane_instead_of_hiding_it() -> None:
    window = object()
    agent_messaging.register("pa", "sender", "/ws/alpha", owner=object())
    agent_messaging.register("pb", "reviewer", "/ws/beta", owner=window)
    agent_messaging.drop_owner(window)

    by_address = {t["address"]: t for t in (await plan_mcp.cli_list_targets(_ctx()))["targets"]}
    assert by_address["beta/reviewer"]["offline"] is True

    agent_messaging.register("pb", "reviewer", "/ws/beta", owner=object())
    by_address = {t["address"]: t for t in (await plan_mcp.cli_list_targets(_ctx()))["targets"]}
    assert by_address["beta/reviewer"]["offline"] is False


@pytest.mark.asyncio
async def test_a_pane_whose_own_window_is_offline_keeps_its_credential() -> None:
    """The CLI keeps running through its window's disconnect, so its own
    /plan-mcp credential must not start failing the liveness check."""
    window = object()
    agent_messaging.register("pa", "sender", "/ws/alpha", owner=window)
    agent_messaging.register("pc", "helper", "/ws/alpha", owner=object())
    agent_messaging.drop_owner(window)

    result = await plan_mcp.cli_list_targets(_ctx())
    assert result["you"] == "alpha/sender"


# ── Cross-device targets ───────────────────────────────────────────────────
# A `<device>/<workspace>/<pane>` target is relayed through the server link.
# The link itself is covered by test_server_link.py against a fake WebSocket;
# these cover the branch cli_send takes to reach it.

REMOTE_DEVICE = "11111111-2222-3333-4444-555555555555"


@pytest.mark.asyncio
async def test_a_remote_target_without_a_server_link_answers_exactly_as_before(
    captured: list[dict[str, Any]],
) -> None:
    """The no-server regression line: with nothing configured the answer is
    still today's "unknown device", and nothing is broadcast."""
    _seed()
    result = await plan_mcp.cli_send(f"{REMOTE_DEVICE}/beta/reviewer", "hi", _ctx())
    assert result["ok"] is False
    assert result["error_code"] == "unknown-device"
    assert captured == []


@pytest.mark.asyncio
async def test_a_remote_target_is_relayed_and_tracked(
    monkeypatch: pytest.MonkeyPatch, captured: list[dict[str, Any]]
) -> None:
    from agent_team_backend import server_link

    sent: list[dict[str, Any]] = []

    async def fake_send_message(**kwargs: Any) -> dict[str, Any]:
        sent.append(kwargs)
        return {"ok": True, "payload": {"msgKey": kwargs["msg_key"], "state": "pending"}}

    monkeypatch.setattr(server_link, "send_message", fake_send_message)
    _seed()

    result = await plan_mcp.cli_send(f"{REMOTE_DEVICE}/beta/reviewer", "hi", _ctx())
    assert result["ok"] is True
    assert result["target"] == f"{REMOTE_DEVICE}/beta/reviewer"
    assert result["cross_workspace"] is True
    # Relayed, not injected here.
    assert captured == []
    assert sent[0]["to"] == {
        "deviceId": REMOTE_DEVICE,
        "workspace": "beta",
        "paneName": "reviewer",
    }
    assert sent[0]["sender"] == {"workspace": "alpha", "paneName": "sender", "paneId": "pa"}
    assert sent[0]["text"] == "hi"

    # The outcome is tracked under the same msg_key cli_check_message reads.
    msg_key = result["msg_key"]
    assert (await plan_mcp.cli_check_message(msg_key, _ctx()))["status"] == "queued"
    assert plan_mcp.record_remote_ack(msg_key, "rejected", "policy-denied") is True
    status = await plan_mcp.cli_check_message(msg_key, _ctx())
    # "rejected" stays distinct from "failed": a policy refusal must not be
    # retried, and an agent that cannot tell them apart retries it forever.
    assert status["status"] == "rejected"
    assert status["reason"] == "policy-denied"


@pytest.mark.asyncio
async def test_an_offline_remote_device_is_reported_as_such(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent_team_backend import server_link

    async def fake_send_message(**_kwargs: Any) -> dict[str, Any]:
        return {"ok": False, "error": {"code": "DEVICE_OFFLINE", "message": "no connection"}}

    monkeypatch.setattr(server_link, "send_message", fake_send_message)
    _seed()

    result = await plan_mcp.cli_send(f"{REMOTE_DEVICE}/beta/reviewer", "hi", _ctx())
    assert result["ok"] is False
    # Not "target-offline": the whole machine is unreachable, not one window.
    assert result["error_code"] == "device-offline"


@pytest.mark.asyncio
async def test_a_configured_but_disconnected_server_is_not_an_unknown_device(
    monkeypatch: pytest.MonkeyPatch, captured: list[dict[str, Any]]
) -> None:
    """The whole point of the distinction: "unknown-device" sends the agent to
    check the address it typed, and the address was never the problem."""
    from agent_team_backend import server_link

    async def fake_send_message(**_kwargs: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "error": {"code": server_link.LINK_OFFLINE, "message": "not connected right now"},
        }

    monkeypatch.setattr(server_link, "send_message", fake_send_message)
    _seed()

    result = await plan_mcp.cli_send(f"{REMOTE_DEVICE}/beta/reviewer", "hi", _ctx())
    assert result["ok"] is False
    assert result["error_code"] == "link-offline"
    assert "unknown device" not in result["error"]
    # Not "refused" either: the message never reached a server to be refused.
    assert "refused" not in result["error"]
    assert "not connected right now" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_a_revoked_server_credential_is_reported_as_such(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent_team_backend import server_link

    async def fake_send_message(**_kwargs: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "error": {
                "code": server_link.LINK_UNAUTHORIZED,
                "message": "the navide-server link stopped for good: access revoked",
            },
        }

    monkeypatch.setattr(server_link, "send_message", fake_send_message)
    _seed()

    result = await plan_mcp.cli_send(f"{REMOTE_DEVICE}/beta/reviewer", "hi", _ctx())
    # Distinct from link-offline: retrying this one can never succeed.
    assert result["error_code"] == "link-unauthorized"
    assert "access revoked" in result["error"]


@pytest.mark.asyncio
async def test_this_device_id_still_resolves_locally(
    monkeypatch: pytest.MonkeyPatch, captured: list[dict[str, Any]]
) -> None:
    """A target naming this machine never touches the link."""
    from agent_team_backend import device_identity, server_link

    async def fail(**_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("a local target must not be relayed")

    monkeypatch.setattr(server_link, "send_message", fail)
    _seed()

    me = device_identity.device_id()
    result = await plan_mcp.cli_send(f"{me}/beta/reviewer", "hi", _ctx())
    assert result["ok"] is True
    assert result["target"] == "beta/reviewer"
    assert captured[0]["payload"]["target_pane_id"] == "pb"


# ── Remote pane discovery ──────────────────────────────────────────────────
# Without a remote roster an agent could send to `<device>/<workspace>/<pane>`
# but had no way to learn that any such device or pane existed, which made the
# whole cross-device path unusable without a human pasting a device id in.


@pytest.fixture
def roster() -> Any:
    """Seeds nothing: the default is an empty roster, i.e. a machine with no
    server configured, and most tests in this file must run against that."""
    from agent_team_backend import remote_roster

    remote_roster._reset_for_test()
    yield remote_roster
    remote_roster._reset_for_test()


def _remote_row(**overrides: Any) -> dict[str, Any]:
    row = {
        "sessionId": "sess-1",
        "deviceId": "far-device-id",
        "workspace": "gamma",
        "workspacePath": "/home/other/gamma",
        "title": "builder",
        "paneId": "p-far",
        "agentKey": "codex",
        "status": "waiting",
        "hostOnline": True,
    }
    row.update(overrides)
    return row


@pytest.mark.asyncio
async def test_list_targets_without_a_server_is_byte_for_byte_what_it_always_was(
    roster: Any,
) -> None:
    """The zero-regression line: no server means no remote key at all, not an
    empty one."""
    _seed()
    result = await plan_mcp.cli_list_targets(_ctx())
    assert set(result) == {"you", "targets"}
    assert set(result["targets"][0]) == {
        "name", "address", "pane_id", "workspace_path", "same_workspace", "busy", "offline",
        "realized",
    }


@pytest.mark.asyncio
async def test_list_targets_shows_remote_panes_in_their_own_bucket(roster: Any) -> None:
    _seed()
    roster.replace([_remote_row()], local_device_id="this-device")
    result = await plan_mcp.cli_list_targets(_ctx())

    # The local list is untouched — a remote pane is never mixed into it.
    assert {t["address"] for t in result["targets"]} == {"beta/reviewer", "alpha/helper"}
    (remote,) = result["remote_targets"]
    assert remote == {
        "name": "builder",
        "address": "far-device-id/gamma/builder",
        "device": "far-device-id",
        "workspace": "gamma",
        "workspace_path": "/home/other/gamma",
        "agent_key": "codex",
        "busy": False,
        "offline": False,
        "host_online": True,
        "status": "waiting",
    }


@pytest.mark.asyncio
async def test_a_host_caller_sees_remote_panes_too(roster: Any) -> None:
    _seed()
    roster.replace([_remote_row()], local_device_id="this-device")
    result = await plan_mcp.cli_list_targets(_host_ctx())
    assert result["you"] == "host"
    assert [t["address"] for t in result["remote_targets"]] == ["far-device-id/gamma/builder"]


@pytest.mark.asyncio
async def test_the_advertised_remote_address_is_the_one_cli_send_accepts(
    roster: Any, monkeypatch: pytest.MonkeyPatch, captured: list[dict[str, Any]]
) -> None:
    """The point of listing: an agent copies `address` and it works. The device
    id here is not UUID-shaped, so this only resolves through the roster."""
    from agent_team_backend import server_link

    sent: list[dict[str, Any]] = []

    async def fake_send_message(**kwargs: Any) -> dict[str, Any]:
        sent.append(kwargs)
        return {"ok": True, "payload": {"state": "pending"}}

    monkeypatch.setattr(server_link, "send_message", fake_send_message)
    _seed()
    roster.replace([_remote_row()], local_device_id="this-device")

    address = (await plan_mcp.cli_list_targets(_ctx()))["remote_targets"][0]["address"]
    result = await plan_mcp.cli_send(address, "hi", _ctx())
    assert result["ok"] is True
    assert result["target"] == "far-device-id/gamma/builder"
    assert sent[0]["to"] == {
        "deviceId": "far-device-id",
        "workspace": "gamma",
        "paneName": "builder",
    }
    # Nothing was injected on this machine.
    assert captured == []


@pytest.mark.asyncio
async def test_a_device_name_reaches_the_same_pane(
    roster: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent_team_backend import server_link

    sent: list[dict[str, Any]] = []

    async def fake_send_message(**kwargs: Any) -> dict[str, Any]:
        sent.append(kwargs)
        return {"ok": True, "payload": {"state": "pending"}}

    monkeypatch.setattr(server_link, "send_message", fake_send_message)
    _seed()
    roster.replace([_remote_row(deviceName="studio")], local_device_id="this-device")

    result = await plan_mcp.cli_send("studio/gamma/builder", "hi", _ctx())
    assert result["ok"] is True
    assert sent[0]["to"]["deviceId"] == "far-device-id"


@pytest.mark.asyncio
async def test_a_local_workspace_beats_a_device_of_the_same_name(
    roster: Any, monkeypatch: pytest.MonkeyPatch, captured: list[dict[str, Any]]
) -> None:
    """The protection device names must not break: `two/proj/target` names a
    local workspace today, and a machine called `two` cannot take it away."""
    from agent_team_backend import server_link

    async def fail(**_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("a locally resolvable target must never be relayed")

    monkeypatch.setattr(server_link, "send_message", fail)
    agent_messaging.register("pa", "sender", "/ws/alpha")
    agent_messaging.register("pt", "target", "/two/proj")
    roster.replace(
        [_remote_row(deviceName="two", workspace="proj", title="target")],
        local_device_id="this-device",
    )

    result = await plan_mcp.cli_send("two/proj/target", "hi", _ctx())
    assert result["ok"] is True
    assert captured[0]["payload"]["target_pane_id"] == "pt"


@pytest.mark.asyncio
async def test_an_ambiguous_device_name_is_refused(
    roster: Any, monkeypatch: pytest.MonkeyPatch, captured: list[dict[str, Any]]
) -> None:
    from agent_team_backend import server_link

    async def fail(**_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("an ambiguous device must not be picked for the sender")

    monkeypatch.setattr(server_link, "send_message", fail)
    _seed()
    roster.replace(
        [
            _remote_row(sessionId="s1", deviceId="d1", deviceName="laptop"),
            _remote_row(sessionId="s2", deviceId="d2", deviceName="laptop"),
        ],
        local_device_id="this-device",
    )

    result = await plan_mcp.cli_send("laptop/gamma/builder", "hi", _ctx())
    assert result["ok"] is False
    assert result["error_code"] == "ambiguous-device"
    assert "2 devices" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_an_unknown_target_still_answers_as_before_with_a_roster_loaded(
    roster: Any, captured: list[dict[str, Any]]
) -> None:
    """A roster that matches nothing must not change the error a typo gets."""
    _seed()
    roster.replace([_remote_row()], local_device_id="this-device")
    result = await plan_mcp.cli_send("beta/nobody", "hi", _ctx())
    assert result["error_code"] == "unknown-target-in-workspace"
    assert captured == []


# ── cli_send(reply_to=…) ────────────────────────────────────────────────────
# The one place the MCP path was WEAKER than the bare-line protocol it mirrors:
# an agent handed a `re:` correlation id in its envelope could answer a specific
# message only by printing a ---MSG--- block. The tool had no way to say it.


@pytest.mark.asyncio
async def test_a_reply_carries_the_correlation_id_into_the_delivery(
    captured: list[dict[str, Any]],
) -> None:
    """`reply_to` must reach the receiving window under the SAME payload key the
    bare-line path uses (agent_msg.route in ws_handlers), because both arrive at
    one acceptRemoteMessage — a second spelling would silently unthread every
    reply sent through the tool."""
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "done", _ctx(), reply_to="pb:mcp:abc")

    assert result["ok"] is True
    assert captured[0]["payload"]["reply_to"] == "pb:mcp:abc"


@pytest.mark.asyncio
async def test_a_send_with_no_reply_to_carries_no_such_key(
    captured: list[dict[str, Any]],
) -> None:
    """The payload a non-reply produces must stay exactly what it was: the
    receiving window reads `ev.reply_to` and an empty string is not the same as
    an absent field — it would take the linkReply path with an id nobody ever
    handed out."""
    _seed()
    await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())

    assert "reply_to" not in captured[0]["payload"]


@pytest.mark.asyncio
async def test_a_reply_does_not_change_the_answer_shape(
    captured: list[dict[str, Any]],
) -> None:
    """Threading is a property of the delivery, not of the send's outcome."""
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "done", _ctx(), reply_to="pb:mcp:abc")

    assert set(result) == {"ok", "target", "cross_workspace", "msg_key"}


@pytest.mark.asyncio
async def test_a_reply_addressed_by_pane_id_threads_too(
    captured: list[dict[str, Any]],
) -> None:
    """The id path skips address resolution entirely, so it is a second route
    into _dispatch_delivery and has to carry the same field."""
    _seed()
    result = await plan_mcp.cli_send("", "done", _ctx(), pane_id="pb", reply_to="pb:mcp:abc")

    assert result["ok"] is True
    assert captured[0]["payload"]["reply_to"] == "pb:mcp:abc"


# ── cli_send(kind="ack") ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_an_ack_travels_in_the_delivery_payload(
    captured: list[dict[str, Any]],
) -> None:
    """The receiving window reads `ev.kind` to decide whether to inject, so the
    flag has to reach it or an ack is typed into the pane like anything else."""
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "got it", _ctx(), kind="ack")

    assert result["ok"] is True
    assert captured[0]["payload"]["kind"] == "ack"


@pytest.mark.asyncio
async def test_an_ordinary_send_carries_no_kind(
    captured: list[dict[str, Any]],
) -> None:
    """Same reason a non-reply carries no `reply_to`: the payload every existing
    caller produces must stay byte-for-byte what it was."""
    _seed()
    await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())

    assert "kind" not in captured[0]["payload"]


@pytest.mark.asyncio
async def test_an_unknown_kind_sends_an_ordinary_message(
    captured: list[dict[str, Any]],
) -> None:
    """A typo must not fail a send that would otherwise have gone through, and
    must not silently become an ack nobody reads."""
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx(), kind="acknowledge")

    assert result["ok"] is True
    assert "kind" not in captured[0]["payload"]


@pytest.mark.asyncio
async def test_an_ack_is_refused_rather_than_relayed_to_another_device(
    monkeypatch: pytest.MonkeyPatch, captured: list[dict[str, Any]]
) -> None:
    """The relay frame has no field for `kind`, and there is no capability
    negotiation, so a peer on an older build would type the ack in regardless.
    Refusing keeps the guarantee absolute instead of probabilistic."""
    from agent_team_backend import server_link

    sent: list[dict[str, Any]] = []

    async def fake_send_message(**kwargs: Any) -> dict[str, Any]:
        sent.append(kwargs)
        return {"ok": True, "payload": {"msgKey": kwargs["msg_key"], "state": "pending"}}

    monkeypatch.setattr(server_link, "send_message", fake_send_message)
    _seed()

    result = await plan_mcp.cli_send(
        f"{REMOTE_DEVICE}/beta/reviewer", "got it", _ctx(), kind="ack"
    )

    assert result["ok"] is False
    assert result["error_code"] == "ack-not-relayable"
    # Neither relayed nor delivered locally: refused outright.
    assert sent == []
    assert captured == []


@pytest.mark.asyncio
async def test_an_ordinary_message_still_crosses_devices(
    monkeypatch: pytest.MonkeyPatch, captured: list[dict[str, Any]]
) -> None:
    """The refusal above must be scoped to acks — cross-device sending itself
    is untouched."""
    from agent_team_backend import server_link

    sent: list[dict[str, Any]] = []

    async def fake_send_message(**kwargs: Any) -> dict[str, Any]:
        sent.append(kwargs)
        return {"ok": True, "payload": {"msgKey": kwargs["msg_key"], "state": "pending"}}

    monkeypatch.setattr(server_link, "send_message", fake_send_message)
    _seed()

    result = await plan_mcp.cli_send(f"{REMOTE_DEVICE}/beta/reviewer", "hi", _ctx())

    assert result["ok"] is True
    assert len(sent) == 1


# ── cli_send(wait_for_delivery_s=…) ─────────────────────────────────────────
# The pull loop closed: an agent that sends and moves on never learns what
# became of its message, so these cover the one call that answers in-band.


@pytest.mark.asyncio
async def test_send_without_a_wait_answers_exactly_as_it_always_did(
    captured: list[dict[str, Any]],
) -> None:
    """The default must add nothing: every existing caller parses this shape."""
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())

    assert set(result) == {"ok", "target", "cross_workspace", "msg_key"}


@pytest.mark.asyncio
async def test_send_waits_for_the_delivery_and_reports_it(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    keys: list[str] = []

    async def deliver_shortly() -> None:
        for _ in range(200):
            if captured:
                break
            await asyncio.sleep(0.001)
        key = captured[0]["payload"]["msg_key"]
        keys.append(key)
        while not plan_mcp.record_delivery_result(key, True, ""):
            await asyncio.sleep(0.001)

    task = asyncio.create_task(deliver_shortly())
    started = time.monotonic()
    result = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx(), wait_for_delivery_s=5.0)
    elapsed = time.monotonic() - started
    await task

    assert result["ok"] is True
    assert result["status"] == "delivered"
    assert result["msg_key"] == keys[0]
    assert isinstance(result["settled_after_s"], float)
    assert "hold" not in result
    # It must come back ON the report, not by outliving the timeout. Without
    # this the same assertions pass with the wake-up wiring entirely dead —
    # five seconds later, and the caller's turn paid for every one of them.
    assert elapsed < 2.0


@pytest.mark.asyncio
async def test_a_refused_delivery_still_answers_ok_so_nobody_resends(
    captured: list[dict[str, Any]],
) -> None:
    """ok:false would read as "never sent" and get the work dispatched twice —
    the same reasoning target_lost is built on."""
    _seed()

    async def refuse_shortly() -> None:
        for _ in range(200):
            if captured:
                break
            await asyncio.sleep(0.001)
        key = captured[0]["payload"]["msg_key"]
        while not plan_mcp.record_delivery_result(key, False, '{"key":"pane-closed"}'):
            await asyncio.sleep(0.001)

    task = asyncio.create_task(refuse_shortly())
    result = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx(), wait_for_delivery_s=5.0)
    await task

    assert result["ok"] is True
    assert result["status"] == "failed"
    assert result["reason"] == "pane-closed"


@pytest.mark.asyncio
async def test_waiting_out_the_clock_reports_what_is_holding_the_message(
    captured: list[dict[str, Any]],
) -> None:
    """The case the whole feature exists for: still queued, and now the sender
    knows it is a person typing rather than an agent working."""
    _seed()

    async def report_the_hold() -> None:
        for _ in range(200):
            if captured:
                break
            await asyncio.sleep(0.001)
        key = captured[0]["payload"]["msg_key"]
        while not plan_mcp.record_message_hold(key, {"key": "typing"}):
            await asyncio.sleep(0.001)

    task = asyncio.create_task(report_the_hold())
    result = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx(), wait_for_delivery_s=0.08)
    await task

    assert result["ok"] is True
    assert result["status"] == "queued"
    assert result["hold"] == {"key": "typing"}
    assert isinstance(result["held_for_s"], float)
    assert isinstance(result["waited_s"], float)


@pytest.mark.asyncio
async def test_a_wait_returns_at_once_when_the_outcome_is_already_in(
    captured: list[dict[str, Any]],
) -> None:
    """The report can beat the wait to it — the window answers on another
    request, and nothing orders the two."""
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    plan_mcp.record_delivery_result(sent["msg_key"], True, "")

    started = time.monotonic()
    again = await plan_mcp._with_delivery_wait(sent, 30.0)

    assert again["status"] == "delivered"
    assert time.monotonic() - started < 1.0


@pytest.mark.asyncio
async def test_the_wait_is_capped_at_the_same_two_minutes_as_cli_wait_idle(
    captured: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[float] = []

    async def record_timeout(_msg_key: str, timeout: float) -> None:
        seen.append(timeout)

    monkeypatch.setattr(plan_mcp, "_await_delivery", record_timeout)
    _seed()
    await plan_mcp.cli_send("beta/reviewer", "hi", _ctx(), wait_for_delivery_s=9999.0)

    assert seen == [plan_mcp._WAIT_IDLE_MAX_TIMEOUT_S]


@pytest.mark.asyncio
async def test_a_negative_wait_is_treated_as_no_wait(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx(), wait_for_delivery_s=-5.0)

    assert set(result) == {"ok", "target", "cross_workspace", "msg_key"}


# ── hold reporting (agent_msg.hold_update → cli_check_message) ──────────────


@pytest.mark.asyncio
async def test_check_message_reports_the_hold_the_window_named(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    assert plan_mcp.record_message_hold(sent["msg_key"], {"key": "behind", "n": 2}) is True

    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())

    assert result["status"] == "queued"
    assert result["hold"] == {"key": "behind", "n": 2}
    assert isinstance(result["held_for_s"], float)


@pytest.mark.asyncio
async def test_a_hold_that_changes_replaces_the_one_before_it(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    plan_mcp.record_message_hold(sent["msg_key"], {"key": "mid-turn"})
    plan_mcp.record_message_hold(sent["msg_key"], {"key": "typing"})

    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())
    assert result["hold"] == {"key": "typing"}


@pytest.mark.asyncio
async def test_a_null_hold_means_nothing_is_holding_it_any_more(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    plan_mcp.record_message_hold(sent["msg_key"], {"key": "typing"})
    plan_mcp.record_message_hold(sent["msg_key"], None)

    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())
    assert "hold" not in result
    assert "held_for_s" not in result


@pytest.mark.asyncio
async def test_delivery_clears_the_hold(captured: list[dict[str, Any]]) -> None:
    """What was holding a message stopped being true the moment it went in."""
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    plan_mcp.record_message_hold(sent["msg_key"], {"key": "typing"})
    plan_mcp.record_delivery_result(sent["msg_key"], True, "")

    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())
    assert result["status"] == "delivered"
    assert "hold" not in result
    assert "held_for_s" not in result
    # The stored entry, not only the answer. Every reader guards on status as
    # well, so without this the clearing itself is invisible to the suite — and
    # the next reader that forgets the guard would surface a stale hold.
    assert plan_mcp._mcp_message_status[sent["msg_key"]]["hold"] is None
    assert plan_mcp._mcp_message_status[sent["msg_key"]]["hold_since"] is None


@pytest.mark.asyncio
async def test_a_hold_arriving_after_the_delivery_cannot_resurrect_it(
    captured: list[dict[str, Any]],
) -> None:
    """Two reports racing: the hold must not put a delivered message back on
    "still waiting"."""
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    plan_mcp.record_delivery_result(sent["msg_key"], True, "")

    assert plan_mcp.record_message_hold(sent["msg_key"], {"key": "typing"}) is False
    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())
    assert result["status"] == "delivered"
    assert "hold" not in result


def test_a_hold_for_a_key_this_server_never_sent_is_ignored() -> None:
    # Every window reports for every tracked message it holds, exactly as it
    # does for deliveries.
    assert plan_mcp.record_message_hold("someone-elses-key", {"key": "typing"}) is False


# ── cli_list_targets hold_reason ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_targets_explains_a_busy_pane_with_its_hold_reason(
    captured: list[dict[str, Any]],
) -> None:
    """`busy` on its own is frontend-reported and can be stale; the hold is the
    receiving window's live word for the same pane."""
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    plan_mcp.record_message_hold(sent["msg_key"], {"key": "typing"})

    result = await plan_mcp.cli_list_targets(_ctx())
    reviewer = next(t for t in result["targets"] if t["address"] == "beta/reviewer")

    assert reviewer["hold_reason"] == "typing"


@pytest.mark.asyncio
async def test_list_targets_says_nothing_about_a_pane_holding_nothing_of_ours(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_list_targets(_ctx())

    assert all("hold_reason" not in t for t in result["targets"])


@pytest.mark.asyncio
async def test_a_settled_message_stops_explaining_its_target(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    plan_mcp.record_message_hold(sent["msg_key"], {"key": "typing"})
    plan_mcp.record_delivery_result(sent["msg_key"], True, "")

    result = await plan_mcp.cli_list_targets(_ctx())
    reviewer = next(t for t in result["targets"] if t["address"] == "beta/reviewer")

    assert "hold_reason" not in reviewer


# ── stale holds (cli_check_message / cli_send wait) ─────────────────────────


def _age(msg_key: str, seconds: float) -> None:
    """Backdate a tracked send, so a threshold can be crossed without waiting."""
    plan_mcp._mcp_message_status[msg_key]["created_at"] -= seconds


@pytest.mark.asyncio
async def test_a_message_queued_past_the_threshold_reads_as_stale(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    plan_mcp.record_message_hold(sent["msg_key"], {"key": "typing"})
    _age(sent["msg_key"], plan_mcp._STALE_HOLD_S + 1)

    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())

    assert result["status"] == "queued"
    assert result["stale"] is True
    # Still says why, and still says nothing about having failed.
    assert result["hold"] == {"key": "typing"}
    assert "reason" not in result


@pytest.mark.asyncio
async def test_a_message_queued_with_no_hold_can_still_be_stale(
    captured: list[dict[str, Any]],
) -> None:
    """The case this exists for: nothing ever reported a hold, so `held_for_s`
    has no clock to run on and only the send's own age can answer."""
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    _age(sent["msg_key"], plan_mcp._STALE_HOLD_S + 1)

    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())

    assert result["stale"] is True
    assert "hold" not in result


@pytest.mark.asyncio
async def test_a_message_below_the_threshold_is_not_stale(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    _age(sent["msg_key"], plan_mcp._STALE_HOLD_S - 5)

    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())

    assert "stale" not in result


@pytest.mark.asyncio
async def test_a_settled_message_is_never_stale(captured: list[dict[str, Any]]) -> None:
    """Age alone does not make it stuck — it went in, and old is not stuck."""
    _seed()
    sent = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    plan_mcp.record_delivery_result(sent["msg_key"], True, "")
    _age(sent["msg_key"], plan_mcp._STALE_HOLD_S * 10)

    result = await plan_mcp.cli_check_message(sent["msg_key"], _ctx())

    assert result["status"] == "delivered"
    assert "stale" not in result


@pytest.mark.asyncio
async def test_a_timed_out_wait_says_the_message_is_stale(
    captured: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """An agent that waited and got nothing needs the same verdict in the same
    answer — that is the whole point of waiting in-band."""
    _seed()
    monkeypatch.setattr(plan_mcp, "_STALE_HOLD_S", 0.0)

    result = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx(), wait_for_delivery_s=0.05)

    assert result["ok"] is True
    assert result["status"] == "queued"
    assert result["stale"] is True


# ── cli_inbox_summary ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_inbox_summary_lists_my_stuck_and_failed_sends(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    stuck = await plan_mcp.cli_send("beta/reviewer", "please review the diff", _ctx())
    plan_mcp.record_message_hold(stuck["msg_key"], {"key": "typing"})
    _age(stuck["msg_key"], plan_mcp._STALE_HOLD_S + 1)
    bounced = await plan_mcp.cli_send("beta/reviewer", "and the tests", _ctx())
    plan_mcp.record_delivery_result(bounced["msg_key"], False, "pane-closed")

    result = await plan_mcp.cli_inbox_summary(_ctx())

    assert result["ok"] is True
    assert result["count"] == 2
    first, second = result["messages"]
    assert first["msg_key"] == stuck["msg_key"]
    assert first["status"] == "queued"
    assert first["stale"] is True
    assert first["hold"] == {"key": "typing"}
    assert first["excerpt"] == "please review the diff"
    assert second["status"] == "failed"
    assert second["reason"] == "pane-closed"


@pytest.mark.asyncio
async def test_inbox_summary_leaves_out_what_is_fine(
    captured: list[dict[str, Any]],
) -> None:
    """Delivered, and still on its way in, are both "nothing to do here"."""
    _seed()
    done = await plan_mcp.cli_send("beta/reviewer", "hi", _ctx())
    plan_mcp.record_delivery_result(done["msg_key"], True, "")
    await plan_mcp.cli_send("beta/reviewer", "just sent", _ctx())

    result = await plan_mcp.cli_inbox_summary(_ctx())

    assert result["count"] == 0
    assert result["messages"] == []


@pytest.mark.asyncio
async def test_inbox_summary_answers_about_the_caller_only(
    captured: list[dict[str, Any]],
) -> None:
    """One backend serves every pane; another agent's stuck message is its own
    problem to notice, not something to hand this one."""
    _seed()
    theirs = await plan_mcp.cli_send("beta/reviewer", "from helper", _ctx(pane_id="pc"))
    _age(theirs["msg_key"], plan_mcp._STALE_HOLD_S + 1)

    result = await plan_mcp.cli_inbox_summary(_ctx(pane_id="pa"))

    assert result["count"] == 0

    theirs_view = await plan_mcp.cli_inbox_summary(_ctx(pane_id="pc"))
    assert [m["msg_key"] for m in theirs_view["messages"]] == [theirs["msg_key"]]


@pytest.mark.asyncio
async def test_inbox_summary_refuses_a_caller_it_cannot_identify() -> None:
    _seed()
    result = await plan_mcp.cli_inbox_summary(_ctx(pane_id=None))

    assert result["ok"] is False
    assert "identify your pane" in result["error"]


def test_a_send_and_wait_that_never_arrived_carries_the_stale_verdict() -> None:
    """cli_send_and_wait's not_delivered answer is the sender's only report on a
    message that never went in — it has to say everything cli_send's wait said."""
    sent = {
        "target": "beta/reviewer",
        "msg_key": "k",
        "status": "queued",
        "hold": {"key": "typing"},
        "held_for_s": 130.0,
        "stale": True,
    }

    result = plan_mcp._never_arrived(sent, time.monotonic())

    assert result["source"] == "not_delivered"
    assert result["delivery_status"] == "queued"
    assert result["stale"] is True
    assert result["hold"] == {"key": "typing"}


# ── cli_open_agent: model / effort ─────────────────────────────────────────
@pytest.mark.asyncio
async def test_open_agent_carries_model_and_effort_to_the_window(
    captured: list[dict[str, Any]],
) -> None:
    _seed()

    async def answer() -> None:
        for _ in range(200):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                agent_messaging.register("new-pane", "worker", "/ws/alpha")
                plan_mcp.resolve_spawn(
                    keys[0], {"ok": True, "pane_id": "new-pane", "name": "worker"}
                )
                plan_mcp.resolve_kickoff(keys[0], {"pane_id": "new-pane", "kickoff": "sent"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    result = await plan_mcp.cli_open_agent(
        "claude", "worker", "do the thing", _ctx(), model="opus-5", effort="high"
    )
    await task

    assert result["ok"] is True
    payload = captured[0]["payload"]
    assert payload["model"] == "opus-5"
    assert payload["effort"] == "high"


@pytest.mark.asyncio
async def test_open_agent_omits_model_keys_when_none_was_asked_for(
    captured: list[dict[str, Any]],
) -> None:
    """The shape every existing window already parses: asking for no model
    must leave the payload exactly as it was before these keys existed."""
    _seed()

    async def answer() -> None:
        for _ in range(200):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                agent_messaging.register("new-pane", "worker", "/ws/alpha")
                plan_mcp.resolve_spawn(
                    keys[0], {"ok": True, "pane_id": "new-pane", "name": "worker"}
                )
                plan_mcp.resolve_kickoff(keys[0], {"pane_id": "new-pane", "kickoff": "sent"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    await plan_mcp.cli_open_agent("claude", "worker", "do the thing", _ctx())
    await task

    payload = captured[0]["payload"]
    assert "model" not in payload
    assert "effort" not in payload


@pytest.mark.asyncio
async def test_open_agent_refuses_a_model_the_cli_cannot_take(
    captured: list[dict[str, Any]],
) -> None:
    """droid's interactive command takes neither flag. Refusing before the
    broadcast is the point: the alternative is a pane that starts on the
    default model and looks like it worked."""
    _seed()
    result = await plan_mcp.cli_open_agent(
        "droid", "worker", "do the thing", _ctx(), model="claude-opus-5"
    )
    assert result["ok"] is False
    assert "droid" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_open_agent_refuses_effort_for_a_cli_that_encodes_it_in_the_model(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_open_agent(
        "cursor", "worker", "do the thing", _ctx(), effort="high"
    )
    assert result["ok"] is False
    # The refusal has to say where effort actually goes, or the caller just
    # retries the same way.
    assert "model" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_open_agent_refuses_an_effort_value_outside_the_vocabulary(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_open_agent(
        "antigravity", "worker", "do the thing", _ctx(), effort="xhigh"
    )
    assert result["ok"] is False
    # agy takes low/medium/high only — the error must list them, since the
    # value is plausible (other CLIs do accept xhigh).
    assert "low, medium, high" in result["error"]
    assert captured == []


@pytest.mark.asyncio
async def test_open_agent_accepts_every_effort_a_cli_advertises(
    captured: list[dict[str, Any]],
) -> None:
    """A vocabulary that refuses its own values would be worse than none."""
    from agent_team_backend.cli_vendors import registry

    for value in registry.VENDORS["claude"].known_efforts:
        assert plan_mcp._refuse_unsupported_model("claude", "", value) == ""


@pytest.mark.asyncio
async def test_open_agent_does_not_validate_model_ids() -> None:
    """Model ids change every vendor release; rejecting an unknown one here
    would break the day a CLI ships a new name."""
    assert plan_mcp._refuse_unsupported_model("claude", "a-model-from-2030", "") == ""


@pytest.mark.asyncio
async def test_open_agent_refuses_a_model_that_would_inject_a_flag(
    captured: list[dict[str, Any]],
) -> None:
    """A model id is data placed after `--model`. Left unchecked, a value with
    a space splits into two argv entries and hands the spawn an extra flag —
    reachable by anyone who can call this tool, including a remote agent
    reached through cli_send."""
    _seed()
    result = await plan_mcp.cli_open_agent(
        "claude", "worker", "do the thing", _ctx(),
        model="sonnet --dangerously-skip-permissions",
    )
    assert result["ok"] is False
    assert captured == []


@pytest.mark.asyncio
async def test_open_agent_refuses_a_model_that_is_itself_a_flag(
    captured: list[dict[str, Any]],
) -> None:
    _seed()
    for attack in ("--dangerously-skip-permissions", "-r", "--model"):
        captured.clear()
        result = await plan_mcp.cli_open_agent(
            "claude", "worker", "do the thing", _ctx(), model=attack
        )
        assert result["ok"] is False, attack
        assert captured == [], attack


def test_malformed_model_is_not_reported_as_unsupported() -> None:
    """Saying "this CLI cannot take a model" would send the caller to try
    another CLI with the same injected string."""
    malformed = plan_mcp._refuse_unsupported_model("claude", "sonnet --flag", "")
    unsupported = plan_mcp._refuse_unsupported_model("droid", "sonnet", "")
    assert malformed != ""
    assert unsupported != ""
    assert malformed != unsupported
    assert "droid" not in malformed


def test_shape_guard_still_accepts_every_real_model_id() -> None:
    """The guard checks shape, never identity — it must not reject ids that
    vendors actually ship, now or after a rename."""
    for model_id in (
        "sonnet",
        "openai/gpt-5.6-sol",
        "gpt-5.3-codex-high",
        "anthropic/claude:thinking",
        "model-from-the-future-2099.1",
    ):
        assert plan_mcp._refuse_unsupported_model("claude", model_id, "") == "", model_id


def test_shape_guard_rejects_shell_metacharacters() -> None:
    for attack in ("a;b", "a|b", "a&b", "$(whoami)", "`id`", "a>b", "a b", "a\nb"):
        assert plan_mcp._refuse_unsupported_model("claude", attack, "") != "", attack


def test_shape_guard_answers_exactly_as_the_renderer_does() -> None:
    """This guard's value is that both engines agree, so the two things that
    could make them differ are pinned here: surrounding whitespace is trimmed
    on both sides (so it is accepted, not refused), while an interior newline
    is refused on both. The pattern is anchored \\A/\\Z rather than ^/$ because
    Python's `$` also matches before a trailing newline and JavaScript's does
    not — belt and braces with the trim above."""
    assert plan_mcp._refuse_unsupported_model("claude", "  sonnet\n", "") == ""
    assert plan_mcp._refuse_unsupported_model("claude", "", " high\n") == ""
    assert plan_mcp._refuse_unsupported_model("claude", "a\nb", "") != ""
    assert plan_mcp._refuse_unsupported_model("claude", "a b", "") != ""


def test_shape_guard_agrees_with_the_renderers_copy() -> None:
    """The pattern is deliberately duplicated: the renderer builds argv, this
    side refuses before broadcasting. Duplication only helps while the two
    agree, so the renderer's literal is read here and both are run over the
    same vectors.

    The anchors differ on purpose — `^/$` in JavaScript, `\\A/\\Z` in Python —
    because Python's `$` also matches before a trailing newline. Translating
    them is what makes the comparison meaningful rather than textual."""
    source = (
        pathlib.Path(__file__).resolve().parents[2]
        / "src/renderer/src/platform/plugin-shell/lib/cliModel.ts"
    ).read_text(encoding="utf-8")
    literal = re.search(r"const ARGUMENT_SAFE = /(.+)/\n", source)
    assert literal, "ARGUMENT_SAFE literal not found — did cliModel.ts move?"
    translated = literal.group(1).replace("\\/", "/")
    assert translated.startswith("^") and translated.endswith("$")
    renderer = re.compile(r"\A" + translated[1:-1] + r"\Z")

    for value in (
        "sonnet",
        "openai/gpt-5.6-sol",
        "gpt-5.3-codex-high",
        "anthropic/claude:thinking",
        "-r",
        "--some-flag",
        "sonnet --some-flag",
        "a b",
        "a\nb",
        "a;b",
        "$(whoami)",
        "",
    ):
        mine = model_args.ARGUMENT_SAFE.match(value) is not None
        theirs = renderer.match(value) is not None
        assert mine == theirs, f"{value!r}: backend={mine} renderer={theirs}"


@pytest.mark.asyncio
async def test_send_and_wait_threads_a_reply(captured: list[dict[str, Any]]) -> None:
    """Answering a question is exactly the case reply_to exists for, and this
    is the tool an agent uses to answer and wait. Forwarding it here is what
    stops a threaded conversation from losing its link at the one turn where
    someone actually replied."""
    _seed()
    agent_messaging.register("pb", "worker", "/ws/alpha")

    async def answer() -> None:
        for _ in range(200):
            if captured:
                plan_mcp.record_delivery_result(
                    captured[0]["payload"]["msg_key"], True, ""
                )
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    await plan_mcp.cli_send_and_wait(
        "worker", "here is the answer", _ctx(), timeout_s=0.2, reply_to="k-original"
    )
    await task

    assert captured[0]["payload"]["reply_to"] == "k-original"


@pytest.mark.asyncio
async def test_send_and_wait_without_a_reply_carries_no_key(
    captured: list[dict[str, Any]],
) -> None:
    """The shape every existing caller already parses stays byte-identical."""
    _seed()
    agent_messaging.register("pb", "worker", "/ws/alpha")

    async def answer() -> None:
        for _ in range(200):
            if captured:
                plan_mcp.record_delivery_result(
                    captured[0]["payload"]["msg_key"], True, ""
                )
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    await plan_mcp.cli_send_and_wait("worker", "hi", _ctx(), timeout_s=0.2)
    await task

    assert "reply_to" not in captured[0]["payload"]
