"""cli_whoami, and the two other halves of the same asymmetry.

An agent could learn everything about every pane except itself. cli_list_targets
excludes the caller from `targets` and reduces it to `you`, one address string —
so the caller had no `pane_id`, which is the only thing `ui.pane.close`,
`ui.pane.focus` and `ui.pane.getStatus` accept. It could act on any pane but its
own. cli_open_agent had the same gap facing the other way: it knew the child's
pane_id and did not return it, so a parent could not close what it opened. And a
child's parent existed only in the words of its kickoff prompt, so a compaction
erased who its work was owed to.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
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


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


def _ctx(pane_id: str | None = "pa") -> Any:
    if pane_id is None:
        return SimpleNamespace(request_context=SimpleNamespace(request=None))
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


# ── A. the caller can describe itself at all ────────────────────────────────
@pytest.mark.asyncio
async def test_whoami_gives_the_caller_its_own_pane_id() -> None:
    """The gap in one assertion: `you` is a string, so the caller had no id —
    and an id is the only thing every ui.pane.* action accepts."""
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")

    roster = await plan_mcp.cli_list_targets(_ctx())
    assert roster["you"] == "alpha/reviewer"
    assert all(t["pane_id"] != "pa" for t in roster["targets"])  # never in its own list

    me = await plan_mcp.cli_whoami(_ctx())
    assert me["ok"] is True
    assert me["pane_id"] == "pa"


@pytest.mark.asyncio
async def test_whoami_describes_the_caller_the_way_the_roster_describes_a_peer() -> None:
    """Every key cli_list_targets reports about someone else has to be here, or
    the caller is still a second-class citizen in its own roster."""
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "peer", "/ws/alpha", agent_key="codex")
    agent_messaging.set_busy("pa", True)

    roster = await plan_mcp.cli_list_targets(_ctx(pane_id="pb"))
    peer_view = next(t for t in roster["targets"] if t["pane_id"] == "pa")

    me = await plan_mcp.cli_whoami(_ctx(pane_id="pa"))
    for key, value in peer_view.items():
        assert me[key] == value, f"{key} differs from how a peer sees the same pane"
    assert me["name"] == "reviewer"
    assert me["address"] == "alpha/reviewer"
    assert me["workspace_path"] == "/ws/alpha"
    assert me["busy"] is True
    # Its own vendor: reported nowhere else, and the roster does not carry it.
    assert me["agent_key"] == "claude"


@pytest.mark.asyncio
async def test_whoami_gives_a_pane_id_that_disambiguates_a_shared_name() -> None:
    """Same-workspace duplicate names make the caller's own address ambiguous —
    cli_read_log refuses it — and the id is the only way out."""
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "worker", "/ws/alpha", agent_key="codex")
    agent_messaging.register("pc", "onlooker", "/ws/alpha", agent_key="claude")

    resolved = agent_messaging.resolve("pc", "worker")
    assert resolved.pane is None and resolved.code == "ambiguous-target"

    me = await plan_mcp.cli_whoami(_ctx(pane_id="pa"))
    assert me["pane_id"] == "pa"
    assert agent_messaging.get(me["pane_id"]) is not None


@pytest.mark.asyncio
async def test_whoami_reports_a_hold_on_the_caller_itself() -> None:
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")
    plan_mcp._mcp_message_status["k1"] = {
        "target": "alpha/reviewer",
        "status": "queued",
        "created_at": 0,
        "hold": {"key": "typing"},
    }
    try:
        me = await plan_mcp.cli_whoami(_ctx())
        assert me["hold_reason"] == "typing"
    finally:
        plan_mcp._mcp_message_status.pop("k1", None)


@pytest.mark.asyncio
async def test_whoami_refuses_a_caller_it_cannot_identify() -> None:
    result = await plan_mcp.cli_whoami(_ctx(pane_id=None))
    assert result["ok"] is False
    assert "identify your pane" in result["error"]


@pytest.mark.asyncio
async def test_whoami_answers_a_non_pane_caller_with_the_credential_kind() -> None:
    """An external credential is not a pane and must not be handed pane fields
    that would be lies — it gets the same word cli_list_targets' `you` gives."""
    result = await plan_mcp.cli_whoami(_external_ctx())
    assert result == {"ok": True, "caller": "external"}


@pytest.mark.asyncio
async def test_list_targets_still_answers_exactly_as_it_did() -> None:
    """cli_whoami exists so this shape did NOT have to change."""
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "peer", "/ws/alpha", agent_key="codex")

    roster = await plan_mcp.cli_list_targets(_ctx())
    assert set(roster) == {"you", "targets"}
    assert roster["you"] == "alpha/reviewer"
    assert set(roster["targets"][0]) == {
        "name", "address", "pane_id", "workspace_path", "same_workspace",
        "busy", "offline", "realized",
    }


# ── C. who opened me ────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_whoami_names_the_pane_that_opened_the_caller() -> None:
    """The parent's name lived only in the kickoff text; a compaction lost it
    and with it any idea of who the finished work is owed to."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "reviewer", "/ws/alpha", agent_key="codex", spawned_by="pa")

    me = await plan_mcp.cli_whoami(_ctx(pane_id="pb"))
    assert me["spawned_by"] == {
        "pane_id": "pa",
        "name": "lead",
        "address": "alpha/lead",
    }


@pytest.mark.asyncio
async def test_whoami_omits_spawned_by_when_nobody_opened_the_caller() -> None:
    """Absent, not null: a null would read as "opened by nobody in particular",
    which is a different claim from "opened by hand"."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    me = await plan_mcp.cli_whoami(_ctx(pane_id="pa"))
    assert "spawned_by" not in me


@pytest.mark.asyncio
async def test_whoami_follows_the_parent_through_a_rebuild() -> None:
    """The parent was rebuilt around its running CLI and answers to a new id.
    The child still mirrors the retired one, so a plain lookup would call a live
    parent gone."""
    agent_messaging.register("pa2", "lead", "/ws/alpha", agent_key="claude")
    agent_messaging.add_aliases("pa2", ["pa"], "/ws/alpha")
    agent_messaging.register("pb", "reviewer", "/ws/alpha", agent_key="codex", spawned_by="pa")

    me = await plan_mcp.cli_whoami(_ctx(pane_id="pb"))
    assert me["spawned_by"] == {
        "pane_id": "pa2",
        "name": "lead",
        "address": "alpha/lead",
    }


@pytest.mark.asyncio
async def test_whoami_says_the_parent_is_gone_rather_than_inventing_one() -> None:
    agent_messaging.register("pb", "reviewer", "/ws/alpha", agent_key="codex", spawned_by="pa")
    me = await plan_mcp.cli_whoami(_ctx(pane_id="pb"))
    assert me["spawned_by"] == {"pane_id": "pa", "gone": True}


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_the_register_handler_carries_lineage_from_the_window() -> None:
    """The whole data path for C: the pane object's `spawnedBy` reaches the
    registry only through agent_msg.register, and a handler that drops the key
    would leave cli_whoami with nothing to report while every test above still
    passed."""
    session = app.Session(_FakeWebSocket())  # type: ignore[arg-type]
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    await app.handle_message(session, {
        "id": "r1",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "pb",
            "name": "reviewer",
            "workspace_path": "/ws/alpha",
            "agent_key": "codex",
            "spawned_by": "pa",
        },
    })

    me = await plan_mcp.cli_whoami(_ctx(pane_id="pb"))
    assert me["spawned_by"]["address"] == "alpha/lead"


@pytest.mark.asyncio
async def test_the_register_handler_leaves_lineage_empty_when_none_is_sent() -> None:
    """A window on a build that predates the field, and a hand-opened pane, look
    the same here — neither may be given a parent."""
    session = app.Session(_FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {
        "id": "r1",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pb", "name": "solo", "workspace_path": "/ws/alpha"},
    })

    me = await plan_mcp.cli_whoami(_ctx(pane_id="pb"))
    assert "spawned_by" not in me


def test_the_registry_learns_lineage_from_the_owning_window() -> None:
    """spawned_by is renderer state; agent_msg.register is the only way in."""
    entry = agent_messaging.register("pb", "reviewer", "/ws/alpha", spawned_by="pa")
    assert entry.spawned_by == "pa"
    # A re-key (restore mints a new parent id) arrives as a re-register, so the
    # new value must win rather than the old one being carried over.
    again = agent_messaging.register("pb", "reviewer", "/ws/alpha", spawned_by="pa2")
    assert again.spawned_by == "pa2"
    # A pane nobody opened stays empty.
    assert agent_messaging.register("pc", "solo", "/ws/alpha").spawned_by == ""


@pytest.mark.asyncio
async def test_list_targets_still_reports_no_lineage() -> None:
    """The roster is who exists, not who is related to whom — deliberately, and
    cli_whoami must not have leaked lineage into it."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "reviewer", "/ws/alpha", agent_key="codex", spawned_by="pa")

    roster = await plan_mcp.cli_list_targets(_ctx(pane_id="pa"))
    assert all("spawned_by" not in target for target in roster["targets"])


# ── D. whether this machine is linked to a server ───────────────────────────
def _cloud(
    monkeypatch: pytest.MonkeyPatch, state: str, device_id: str = "this-device"
) -> None:
    """Put this machine in a link state without a link (or a Keychain)."""
    from agent_team_backend import server_link

    monkeypatch.setattr(server_link, "link_state", lambda: state)
    monkeypatch.setattr(server_link, "local_device_id", lambda: device_id)


@pytest.mark.asyncio
async def test_whoami_omits_cloud_on_a_machine_with_no_server_link(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Absent, not empty: a machine that never linked must read exactly as it
    did before cross-device addressing existed, so an empty dict — which says
    "there is a link, it just has nothing to report" — is the wrong answer."""
    from agent_team_backend import server_link

    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")
    _cloud(monkeypatch, server_link.STATE_UNCONFIGURED)

    me = await plan_mcp.cli_whoami(_ctx())
    assert "cloud" not in me
    assert set(me) == {
        "ok", "caller", "name", "address", "pane_id", "workspace_path",
        "same_workspace", "agent_key", "busy", "offline", "realized",
        "delegation_hint",
    }


@pytest.mark.asyncio
async def test_whoami_reports_the_link_state_and_this_machines_device_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")
    _cloud(monkeypatch, "connected", device_id="dev-9")

    me = await plan_mcp.cli_whoami(_ctx())
    assert me["cloud"] == {"state": "connected", "device_id": "dev-9"}


@pytest.mark.asyncio
async def test_whoami_reports_a_link_that_is_not_carrying_anything_right_now(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Any state but "unconfigured" is a configured machine, and the word is
    what separates "no server" from "a server this pane cannot reach"."""
    from agent_team_backend import server_link

    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")
    _cloud(monkeypatch, server_link.STATE_UNREACHABLE, device_id="dev-9")

    me = await plan_mcp.cli_whoami(_ctx())
    assert me["cloud"] == {"state": "unreachable", "device_id": "dev-9"}


@pytest.mark.asyncio
async def test_whoami_omits_device_id_before_the_server_has_issued_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A link exists but has no id yet; "" would read as an addressable device
    whose id happens to be empty, so the key goes rather than the value."""
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")
    _cloud(monkeypatch, "connecting", device_id="")

    me = await plan_mcp.cli_whoami(_ctx())
    assert me["cloud"] == {"state": "connecting"}


# ── B. the parent gets the id of what it opened ─────────────────────────────
@pytest.mark.asyncio
async def test_open_agent_returns_the_new_pane_id(
    captured: list[dict[str, Any]],
) -> None:
    """Without it the parent can send to its child but never close or focus it:
    every ui.pane.* action takes an id and refuses a name."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")

    async def answer() -> None:
        for _ in range(400):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                agent_messaging.register("child-1", "reviewer", "/ws/alpha")
                plan_mcp.resolve_spawn(
                    keys[0], {"ok": True, "pane_id": "child-1", "name": "reviewer"}
                )
                plan_mcp.resolve_kickoff(keys[0], {"pane_id": "child-1", "kickoff": "sent"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    result = await plan_mcp.cli_open_agent("codex", "reviewer", "review the PR", _ctx())
    await task

    assert result["ok"] is True
    assert result["pane_id"] == "child-1"
    # The id must actually name the pane, so ui.pane.close can be given it.
    assert agent_messaging.get(result["pane_id"]) is not None


@pytest.mark.asyncio
async def test_open_agent_omits_pane_id_when_the_window_named_none(
    captured: list[dict[str, Any]],
) -> None:
    """Absent, not empty: "" handed to ui.pane.close would look like an address."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")

    async def answer() -> None:
        for _ in range(400):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                plan_mcp.resolve_spawn(keys[0], {"ok": True, "name": "reviewer"})
                plan_mcp.resolve_kickoff(keys[0], {"pane_id": "", "kickoff": "sent"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    result = await plan_mcp.cli_open_agent("codex", "reviewer", "review the PR", _ctx())
    await task

    assert result["ok"] is True
    assert "pane_id" not in result


# ── D. an embedded panel names the window it lives in ───────────────────────
@pytest.mark.asyncio
async def test_a_panel_reports_its_surface_and_window_kind() -> None:
    """A panel and a pane looked identical on the roster, so a reader could
    not tell that `pm-claude` lives in the Pipeline Manager rather than a
    window's pane pool."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    agent_messaging.register(
        "dock-1", "pm-claude", "/ws/alpha", agent_key="claude",
        surface="pm", window_kind="main", deliverable=True,
    )

    roster = await plan_mcp.cli_list_targets(_ctx(pane_id="pa"))
    panel = next(t for t in roster["targets"] if t["pane_id"] == "dock-1")
    assert panel["surface"] == "pm"
    assert panel["window_kind"] == "main"

    me = await plan_mcp.cli_whoami(_ctx(pane_id="dock-1"))
    assert me["surface"] == "pm"
    assert me["window_kind"] == "main"


@pytest.mark.asyncio
async def test_a_window_pane_gains_no_surface_keys() -> None:
    """Absent, not empty: every main-window pane answers with exactly the keys
    it always had."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "peer", "/ws/alpha", agent_key="codex")

    roster = await plan_mcp.cli_list_targets(_ctx(pane_id="pa"))
    assert "surface" not in roster["targets"][0]
    assert "window_kind" not in roster["targets"][0]
    me = await plan_mcp.cli_whoami(_ctx(pane_id="pa"))
    assert "surface" not in me
    assert "window_kind" not in me
