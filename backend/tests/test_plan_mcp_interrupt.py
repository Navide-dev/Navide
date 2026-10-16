"""cli_interrupt: asking another CLI pane to stop, without closing it.

The capability chain (per-vendor interrupt byte, the PTY write, onInterrupt in
the renderer) already existed; what was missing was the MCP entry point. These
guard the four things that make the entry point honest rather than merely
present: it reaches the window that owns the pane, it reports the state the
interrupt landed on instead of implying a stop, it never claims to have written
bytes it did not, and it does not blame a cross-device address for a limit that
belongs to the tool.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.mcp_server import (
    server as plan_mcp,
    auth as plan_mcp_auth,
    wiring as plan_mcp_wiring,
)


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _external_ctx() -> Any:
    plan_mcp_auth.set_external_enabled(True)
    params = {"client": "external", "t": plan_mcp_auth.external_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _seed() -> None:
    agent_messaging.register("pa", "caller", "/ws/alpha")
    agent_messaging.register("pw", "worker", "/ws/alpha", agent_key="codex")


def _fake_ui(monkeypatch: pytest.MonkeyPatch, reply: dict[str, Any]) -> list[dict[str, Any]]:
    """Answer every _ui_request with `reply`, recording the calls."""
    calls: list[dict[str, Any]] = []

    async def fake(workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        calls.append({"workspace_path": workspace_path, "op": op, **kwargs})
        return reply

    monkeypatch.setattr(plan_mcp, "_ui_request", fake)
    return calls


@pytest.mark.asyncio
async def test_interrupt_is_addressed_at_the_window_holding_the_TARGET_pane(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The request is about another pane, so only the window that has THAT pane
    can perform it — broadcasting would burn a full timeout against a window
    that has since switched project. The caller identity must not leak in."""
    _seed()
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {"sent": True, "status": "running"}})

    result = await plan_mcp.cli_interrupt("worker", _ctx())

    assert result["ok"] is True
    assert len(calls) == 1
    assert calls[0]["workspace_path"] == "/ws/alpha"
    assert calls[0]["action"] == "ui.pane.interrupt"
    assert calls[0]["args"] == {"paneId": "pw"}
    # Addressed at the target, not at the caller: _pane_caller("pw"), not "pa".
    assert calls[0]["caller"].pane_id == "pw"


@pytest.mark.asyncio
async def test_interrupt_reports_the_status_the_key_landed_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A bare ok:true would read as "the agent stopped". The pane's state at
    the instant of the press is the only thing that lets the caller tell what
    actually happened."""
    _seed()
    _fake_ui(monkeypatch, {"ok": True, "result": {"sent": True, "status": "running"}})

    result = await plan_mcp.cli_interrupt("worker", _ctx())

    assert result["sent"] is True
    assert result["status_before"] == "running"
    assert result["target"] == "alpha/worker"
    assert result["name"] == "worker"


@pytest.mark.asyncio
async def test_interrupting_an_idle_pane_is_answered_not_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Clearing whatever sits in an idle pane's input box is a legitimate
    reason to press the key, so this does not gate — it records. The advisory
    the window computed is what stops the no-op from being silent."""
    _seed()
    _fake_ui(
        monkeypatch,
        {"ok": True, "result": {"sent": True, "status": "idle", "advisories": ["no turn"]}},
    )

    result = await plan_mcp.cli_interrupt("worker", _ctx())

    assert result["ok"] is True
    assert result["sent"] is True
    assert result["status_before"] == "idle"
    assert result["advisories"] == ["no turn"]


@pytest.mark.asyncio
async def test_advisories_are_omitted_when_there_are_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An always-present empty list trains the caller to stop reading the key."""
    _seed()
    _fake_ui(monkeypatch, {"ok": True, "result": {"sent": True, "status": "running"}})

    result = await plan_mcp.cli_interrupt("worker", _ctx())

    assert "advisories" not in result


@pytest.mark.asyncio
async def test_interrupt_reports_when_no_bytes_were_written(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A cold-restore placeholder has no PTY behind it. The renderer no-ops,
    and saying `sent: true` anyway would be the one lie that matters here."""
    _seed()
    _fake_ui(monkeypatch, {"ok": True, "result": {"sent": False, "status": ""}})

    result = await plan_mcp.cli_interrupt("worker", _ctx())

    assert result["ok"] is True
    assert result["sent"] is False


@pytest.mark.asyncio
async def test_a_window_that_does_not_answer_is_a_failure_not_a_quiet_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """cli_get_status degrades to omitting `ui` because it has another source
    for the answer. There is no second way to write into a PTY, so an
    unanswered request here means nothing was sent and must say so."""
    _seed()
    _fake_ui(monkeypatch, {"ok": False, "result": None, "error": "timed out", "error_code": "ui_action_timeout"})

    result = await plan_mcp.cli_interrupt("worker", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "ui_action_timeout"
    assert "timed out" in result["error"]
    assert "sent" not in result


_DEVICE_UUID = "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071"


@pytest.mark.asyncio
async def test_an_id_shaped_device_segment_is_not_reported_as_a_link_problem(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """resolve()'s "unknown-device" is worded for cli_send, which relays before
    it can reach that error, so it blames a missing Navide-Server link. There
    is no relay for an interrupt at any link state — passing that message on
    would send the caller to fix a link that has nothing to do with why this
    failed, and to re-check an address that may be perfectly good."""
    _seed()
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {"sent": True, "status": "running"}})

    result = await plan_mcp.cli_interrupt(f"{_DEVICE_UUID}/alpha/worker", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "interrupt-local-only"
    assert "another device" in result["error"]
    assert "not linked to a Navide-Server" not in result["error"]
    # And it points at the thing that does work across the link.
    assert "cli_send" in result["error"]
    # Nothing was asked of any window.
    assert calls == []


@pytest.mark.asyncio
async def test_a_device_NAME_is_recognised_as_remote_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A device label is not id-shaped, so the local resolver reads it as part
    of a workspace path and answers "unknown workspace" — an address error for
    an address that is right. Only the roster can tell the two apart, which is
    why this goes through message_routing.route rather than reading the local
    error code."""
    _seed()
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {"sent": True, "status": "running"}})
    monkeypatch.setattr(
        agent_messaging,
        "parse_remote_target",
        lambda to: agent_messaging.RemoteTarget(address=agent_messaging.parse_target(to)),
    )

    result = await plan_mcp.cli_interrupt("laptop/alpha/worker", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "interrupt-local-only"
    assert calls == []


@pytest.mark.asyncio
async def test_an_address_that_names_no_device_still_reports_the_address_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The remote re-read must only ever ADD an answer. With no roster behind
    it, a mistyped workspace is still a mistyped workspace — calling it
    "interrupt-local-only" would hide a genuine typo."""
    _seed()
    _fake_ui(monkeypatch, {"ok": True, "result": {"sent": True, "status": "running"}})

    result = await plan_mcp.cli_interrupt("typo/worker", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "unknown-workspace"


@pytest.mark.asyncio
async def test_pane_id_addresses_one_exact_pane(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same rule as every other pane-addressing tool: an id beats the name, so
    two panes sharing a name can still be told apart."""
    agent_messaging.register("pa", "caller", "/ws/alpha")
    agent_messaging.register("pw1", "worker", "/ws/alpha")
    agent_messaging.register("pw2", "worker", "/ws/alpha")
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {"sent": True, "status": "running"}})

    ambiguous = await plan_mcp.cli_interrupt("worker", _ctx())
    assert ambiguous["ok"] is False
    assert ambiguous["error_code"] == "ambiguous-target"

    exact = await plan_mcp.cli_interrupt("", _ctx(), pane_id="pw2")
    assert exact["ok"] is True
    assert calls[-1]["args"] == {"paneId": "pw2"}


@pytest.mark.asyncio
async def test_an_unknown_pane_id_is_refused_before_any_window_is_asked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed()
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {"sent": True, "status": "running"}})

    result = await plan_mcp.cli_interrupt("", _ctx(), pane_id="nope")

    assert result["ok"] is False
    assert result["error_code"] == "unknown-pane-id"
    assert calls == []


@pytest.mark.asyncio
async def test_an_external_caller_must_qualify_the_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A caller with no pane identity has no "own workspace" for a bare name to
    mean, so a bare name would pick an arbitrary project's pane."""
    _seed()
    _fake_ui(monkeypatch, {"ok": True, "result": {"sent": True, "status": "running"}})

    bare = await plan_mcp.cli_interrupt("worker", _external_ctx())
    assert bare["ok"] is False

    qualified = await plan_mcp.cli_interrupt("alpha/worker", _external_ctx())
    assert qualified["ok"] is True


@pytest.mark.asyncio
async def test_the_tool_is_registered_and_addresses_a_pane_by_id() -> None:
    tools = {t.name: t for t in await plan_mcp.server.list_tools()}
    assert "cli_interrupt" in tools
    props = set(tools["cli_interrupt"].inputSchema.get("properties") or {})
    # ctx is injected, never asked of the agent.
    assert props == {"target", "pane_id"}


@pytest.mark.asyncio
async def test_the_description_does_not_promise_a_stop() -> None:
    """The docstring IS the contract an agent reads before calling. It has to
    say a key was pressed and that nothing verifies a stop; a description that
    reads like stop-turn semantics is the failure this whole tool risks."""
    tools = {t.name: t for t in await plan_mcp.server.list_tools()}
    text = (tools["cli_interrupt"].description or "").lower()
    assert "does not stop a turn" in text
    assert "keystroke" in text
    # And it must name the fact that some CLIs treat the key differently.
    assert "clear" in text


@pytest.mark.asyncio
async def test_a_pane_cannot_interrupt_itself() -> None:
    """The call would destroy its own result.

    cli_send refuses a self-send because it would be noise; this refuses for a
    harder reason — the interrupt aborts the turn issuing it, so the answer
    could never come back. A caller that got "ok" here would be reading a
    reply from a turn that no longer exists.
    """
    _seed()

    result = await plan_mcp.cli_interrupt("caller", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "self-interrupt"
    assert "own pane" in result["error"]


@pytest.mark.asyncio
async def test_the_self_guard_does_not_block_a_namesake_elsewhere(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Refusing must key on identity, not on the name matching. A pane in
    another workspace that happens to share your name is a different pane."""
    _seed()
    agent_messaging.register("pother", "caller", "/ws/beta")
    # Nothing answers a real UI request here; unstubbed it sat out the full
    # UI timeout (15 s) before returning.
    _fake_ui(monkeypatch, {"ok": True, "result": {"sent": True, "status": "running"}})

    result = await plan_mcp.cli_interrupt("beta/caller", _ctx())

    assert result.get("error_code") != "self-interrupt"
