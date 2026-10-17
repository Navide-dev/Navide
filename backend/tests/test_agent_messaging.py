"""Cross-workspace inter-CLI messaging: registry, target resolution, handlers."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, ws_handlers
from agent_team_backend.agent_message_log import AgentMessageLog
from agent_team_backend.db import Database


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


@pytest.fixture
def remote_roster_clean() -> Any:
    """Only for the tests that seed a remote roster. Deliberately not autouse:
    every other test in this file must run against a roster nothing ever
    touched, which is the state of a machine with no server configured."""
    from agent_team_backend import remote_roster

    remote_roster._reset_for_test()
    yield
    remote_roster._reset_for_test()


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


def _seed_two_workspaces() -> None:
    agent_messaging.register("p1", "claude-1", "/ws/alpha", agent_key="claude")
    agent_messaging.register("p2", "reviewer", "/ws/alpha", agent_key="claude")
    agent_messaging.register("p3", "reviewer", "/ws/beta", agent_key="codex")


# ── Registry ───────────────────────────────────────────────────────────────
def test_register_exposes_workspace_label_and_qualified_name() -> None:
    entry = agent_messaging.register("p1", "reviewer", "/Users/me/Agent-Team")
    assert entry.workspace_label == "Agent-Team"
    assert entry.qualified_name == "Agent-Team/reviewer"


def test_register_replaces_existing_entry_so_renames_propagate() -> None:
    agent_messaging.register("p1", "old", "/ws/alpha")
    agent_messaging.register("p1", "new", "/ws/alpha")
    entry = agent_messaging.get("p1")
    assert entry is not None and entry.name == "new"
    assert len(agent_messaging.list_panes()) == 1


def test_register_defaults_to_realized_and_carries_the_flag() -> None:
    live = agent_messaging.register("p1", "a", "/tmp/w", agent_key="claude")
    assert live.realized is True
    assert live.to_dict()["realized"] is True
    placeholder = agent_messaging.register("p2", "b", "/tmp/w", agent_key="claude", realized=False)
    assert placeholder.realized is False
    # Realizing is a re-register, and unlike busy the flag is not carried over:
    # it is the one thing that call exists to change.
    assert agent_messaging.register("p2", "b", "/tmp/w", agent_key="claude").realized is True


def test_same_name_allowed_in_different_workspaces() -> None:
    _seed_two_workspaces()
    names = [(e.workspace_path, e.name) for e in agent_messaging.list_panes()]
    assert ("/ws/alpha", "reviewer") in names
    assert ("/ws/beta", "reviewer") in names


def test_list_panes_filters_by_workspace() -> None:
    _seed_two_workspaces()
    only_beta = agent_messaging.list_panes("/ws/beta")
    assert [e.pane_id for e in only_beta] == ["p3"]


def test_trailing_slash_workspace_is_normalized() -> None:
    agent_messaging.register("p1", "a", "/ws/alpha/")
    assert agent_messaging.list_panes("/ws/alpha")[0].pane_id == "p1"


def test_drop_owner_takes_offline_only_that_windows_panes() -> None:
    win_a, win_b = object(), object()
    agent_messaging.register("p1", "a", "/ws/alpha", owner=win_a)
    agent_messaging.register("p2", "b", "/ws/beta", owner=win_b)
    dropped = agent_messaging.drop_owner(win_a)
    assert dropped == ["p1"]
    # The entry stays — a disconnected window is usually reconnecting — but is
    # flagged, so callers can tell "offline" from "does not exist".
    assert [e.pane_id for e in agent_messaging.list_panes()] == ["p1", "p2"]
    assert agent_messaging.get("p1").offline is True
    assert agent_messaging.get("p2").offline is False


# ── Offline lifecycle ──────────────────────────────────────────────────────
def test_offline_pane_survives_disconnect_and_is_restored_by_reconnect() -> None:
    window = object()
    agent_messaging.register("p1", "a", "/ws/alpha", owner=window)
    agent_messaging.register("p2", "sender", "/ws/alpha", owner=window)
    agent_messaging.set_busy("p1", True)
    agent_messaging.drop_owner(window)

    offline = agent_messaging.get("p1")
    assert offline is not None and offline.offline is True
    assert offline.to_dict()["offline"] is True

    # Reconnect: the window re-runs agent_msg.register for each pane it mirrors.
    reconnected = object()
    agent_messaging.register("p1", "a", "/ws/alpha", owner=reconnected)
    agent_messaging.register("p2", "sender", "/ws/alpha", owner=reconnected)
    restored = agent_messaging.get("p1")
    assert restored is not None
    assert restored.offline is False
    assert restored.offline_since is None
    assert restored.busy is True  # a reconnect is not a state change
    assert agent_messaging.resolve("p2", "a").pane is restored


def test_offline_pane_is_forgotten_after_the_grace_period() -> None:
    window = object()
    agent_messaging.register("p1", "a", "/ws/alpha", owner=window)
    agent_messaging.drop_owner(window)

    entry = agent_messaging.get("p1")
    assert entry is not None
    # Backdate past the grace period; the sweep runs lazily off any read.
    entry.offline_since -= agent_messaging.OFFLINE_GRACE_S + 1
    assert agent_messaging.get("p1") is None
    assert agent_messaging.list_panes() == []


def test_offline_pane_stays_within_the_grace_period() -> None:
    window = object()
    agent_messaging.register("p1", "a", "/ws/alpha", owner=window)
    agent_messaging.drop_owner(window)

    entry = agent_messaging.get("p1")
    assert entry is not None
    entry.offline_since -= agent_messaging.OFFLINE_GRACE_S - 5
    assert agent_messaging.get("p1") is not None


def test_resolving_an_offline_target_is_not_unknown_target() -> None:
    window_a, window_b = object(), object()
    agent_messaging.register("p1", "sender", "/ws/alpha", owner=window_a)
    agent_messaging.register("p2", "reviewer", "/ws/beta", owner=window_b)
    agent_messaging.drop_owner(window_b)

    result = agent_messaging.resolve("p1", "beta/reviewer")
    assert result.pane is None
    assert result.code == "target-offline"
    assert "offline" in result.error
    # The failure a caller must not confuse it with.
    assert agent_messaging.resolve("p1", "beta/nobody").code == "unknown-target-in-workspace"


def test_resolving_an_offline_target_by_bare_name_reports_offline() -> None:
    window = object()
    agent_messaging.register("p1", "sender", "/ws/alpha", owner=window)
    agent_messaging.register("p2", "reviewer", "/ws/alpha", owner=window)
    agent_messaging.drop_owner(window)

    assert agent_messaging.resolve("p1", "reviewer").code == "target-offline"


def test_a_live_pane_wins_over_an_offline_one_with_the_same_address() -> None:
    old_window, new_window = object(), object()
    agent_messaging.register("p1", "sender", "/ws/alpha", owner=old_window)
    agent_messaging.register("old", "reviewer", "/ws/beta", owner=old_window)
    agent_messaging.drop_owner(old_window)
    agent_messaging.register("p1", "sender", "/ws/alpha", owner=new_window)
    agent_messaging.register("new", "reviewer", "/ws/beta", owner=new_window)

    # Both entries exist; the offline one must neither shadow the live pane nor
    # make the address look ambiguous.
    assert agent_messaging.resolve("p1", "beta/reviewer").pane.pane_id == "new"
    assert agent_messaging.resolve("p1", "reviewer").pane is None  # different workspace


# ── Resolution ─────────────────────────────────────────────────────────────
def test_bare_name_resolves_only_within_sender_workspace() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "reviewer")
    assert result.pane is not None and result.pane.pane_id == "p2"
    assert result.cross_workspace is False


def test_bare_name_refuses_two_panes_sharing_a_name() -> None:
    """The bare-name path used to pick whichever registered first, silently —
    the exact thing the qualified path refuses to do. Both spellings of the
    same situation must now give the same answer."""
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "reviewer", "/ws/alpha")
    agent_messaging.register("p3", "reviewer", "/ws/alpha")

    result = agent_messaging.resolve("p1", "reviewer")
    assert result.pane is None
    assert result.code == "ambiguous-target"
    # The way out is an id, and the message has to say so.
    assert result.error is not None and "pane_id" in result.error
    # The UI string takes ws/n/name; a bare name spelled no workspace, so it is
    # synthesized from the sender or the message renders broken.
    assert result.params == {"name": "reviewer", "ws": "alpha", "n": "2"}


def test_a_bare_name_matching_one_live_pane_is_not_ambiguous() -> None:
    """An offline duplicate still inside its grace period must not manufacture
    an ambiguity no live pane is part of — the check runs after _prefer_online."""
    gone, here = object(), object()
    agent_messaging.register("p1", "sender", "/ws/alpha", owner=here)
    agent_messaging.register("old", "reviewer", "/ws/alpha", owner=gone)
    agent_messaging.drop_owner(gone)
    agent_messaging.register("live", "reviewer", "/ws/alpha", owner=here)

    result = agent_messaging.resolve("p1", "reviewer")
    assert result.pane is not None and result.pane.pane_id == "live"


def test_bare_name_never_reaches_another_workspace() -> None:
    agent_messaging.register("p1", "claude-1", "/ws/alpha")
    agent_messaging.register("p3", "reviewer", "/ws/beta")
    result = agent_messaging.resolve("p1", "reviewer")
    assert result.pane is None
    assert result.error is not None and "unknown target" in result.error


def test_qualified_name_reaches_another_workspace() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "beta/reviewer")
    assert result.pane is not None and result.pane.pane_id == "p3"
    assert result.cross_workspace is True


def test_qualified_name_within_own_workspace_is_not_cross_workspace() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "alpha/reviewer")
    assert result.pane is not None and result.pane.pane_id == "p2"
    assert result.cross_workspace is False


def test_absolute_workspace_path_addressing() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "/ws/beta/reviewer")
    assert result.pane is not None and result.pane.pane_id == "p3"


def test_unknown_workspace_is_an_error_not_a_fallback() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "gamma/reviewer")
    assert result.pane is None
    assert result.error is not None and "unknown workspace" in result.error


def test_ambiguous_workspace_basename_refuses_to_guess() -> None:
    agent_messaging.register("p1", "a", "/one/proj")
    agent_messaging.register("p2", "target", "/two/proj")
    agent_messaging.register("p3", "target", "/three/proj")
    result = agent_messaging.resolve("p1", "proj/target")
    assert result.pane is None
    assert result.error is not None and "ambiguous workspace" in result.error


def test_ambiguity_resolved_by_longer_path_suffix() -> None:
    agent_messaging.register("p1", "a", "/one/proj")
    agent_messaging.register("p2", "target", "/two/proj")
    result = agent_messaging.resolve("p1", "two/proj/target")
    assert result.pane is not None and result.pane.pane_id == "p2"


def test_duplicate_name_in_one_workspace_refuses_to_guess() -> None:
    """Two windows can hold the same workspace (a detached run group) and each
    derives handles locally, so the same name can appear twice."""
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "claude-2", "/ws/beta")
    agent_messaging.register("p3", "claude-2", "/ws/beta")
    result = agent_messaging.resolve("p1", "beta/claude-2")
    assert result.pane is None
    assert result.error is not None and "ambiguous target" in result.error


def test_unknown_pane_in_known_workspace() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "beta/nobody")
    assert result.pane is None
    assert result.error is not None and "unknown target" in result.error


def test_empty_and_malformed_targets() -> None:
    _seed_two_workspaces()
    assert agent_messaging.resolve("p1", "").error == "empty target"
    assert agent_messaging.resolve("p1", "beta/").error is not None


def test_every_failure_carries_a_code_and_its_substitutions() -> None:
    """The UI localizes from `code`/`params`; only `error` stays English, and it
    is what the MCP tools hand back to a calling agent."""
    _seed_two_workspaces()
    agent_messaging.register("p4", "claude-2", "/ws/beta")
    agent_messaging.register("p5", "claude-2", "/ws/beta")

    cases = [
        ("", "empty-target", {}),
        ("beta/", "missing-pane-name", {"to": "beta/"}),
        ("nobody", "unknown-target", {"to": "nobody"}),
        ("gamma/reviewer", "unknown-workspace", {"ws": "gamma"}),
        ("beta/nobody", "unknown-target-in-workspace", {"name": "nobody", "ws": "beta"}),
        ("beta/claude-2", "ambiguous-target", {"name": "claude-2", "ws": "beta", "n": "2"}),
    ]
    for target, code, params in cases:
        result = agent_messaging.resolve("p1", target)
        assert result.pane is None, target
        assert result.code == code, target
        assert result.params == params, target
        assert result.error, target


def test_ambiguous_workspace_reports_the_match_count() -> None:
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "reviewer", "/one/shared")
    agent_messaging.register("p3", "reviewer", "/two/shared")

    result = agent_messaging.resolve("p1", "shared/reviewer")

    assert result.pane is None
    assert result.code == "ambiguous-workspace"
    assert result.params == {"ws": "shared", "n": "2"}


def test_successful_resolve_carries_no_error_code() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "beta/reviewer")
    assert result.pane is not None
    assert result.code is None and result.params is None


def test_sender_display_is_always_qualified() -> None:
    _seed_two_workspaces()
    assert agent_messaging.sender_display("p1", "fallback") == "alpha/claude-1"
    assert agent_messaging.sender_display("nope", "fallback") == "fallback"


# ── Device dimension ───────────────────────────────────────────────────────
FOREIGN_DEVICE = "11111111-2222-3333-4444-555555555555"


def _this_device() -> str:
    from agent_team_backend import device_identity

    return device_identity.device_id()


def test_parse_target_splits_one_two_and_three_segment_forms() -> None:
    bare = agent_messaging.parse_target("reviewer")
    assert (bare.device_id, bare.workspace, bare.pane_name) == ("", "", "reviewer")

    two = agent_messaging.parse_target("beta/reviewer")
    assert (two.device_id, two.workspace, two.pane_name) == ("", "beta", "reviewer")

    three = agent_messaging.parse_target(f"{FOREIGN_DEVICE}/beta/reviewer")
    assert (three.device_id, three.workspace, three.pane_name) == (
        FOREIGN_DEVICE,
        "beta",
        "reviewer",
    )
    assert three.local_target == "beta/reviewer"
    assert three.to_string() == f"{FOREIGN_DEVICE}/beta/reviewer"


def test_three_segment_address_for_this_device_resolves_exactly_as_two() -> None:
    _seed_two_workspaces()
    plain = agent_messaging.resolve("p1", "beta/reviewer")
    with_device = agent_messaging.resolve("p1", f"{_this_device()}/beta/reviewer")
    assert with_device.pane is plain.pane
    assert with_device.pane.pane_id == "p3"
    assert with_device.cross_workspace == plain.cross_workspace is True


def test_this_device_segment_also_carries_an_absolute_workspace_path() -> None:
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", f"{_this_device()}//ws/beta/reviewer")
    assert result.pane is not None and result.pane.pane_id == "p3"


def test_unknown_device_is_reported_apart_from_unknown_target() -> None:
    """A foreign device may well be the right address — this registry simply has
    no way to reach it — so it must not read as "that pane does not exist"."""
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", f"{FOREIGN_DEVICE}/beta/reviewer")
    assert result.pane is None
    assert result.code == "unknown-device"
    assert result.params == {
        "device": FOREIGN_DEVICE,
        "to": f"{FOREIGN_DEVICE}/beta/reviewer",
    }
    # It used to say the roster was "not available yet", written before the
    # roster existed and left there after it was added. Every caller that can
    # relay now does so before this is shown, so the only way to see it is to
    # have no link at all — and that is what it has to say.
    assert "not linked to a Navide-Server" in result.error
    assert "not available yet" not in result.error
    assert agent_messaging.resolve("p1", "beta/nobody").code == "unknown-target-in-workspace"


def test_two_segment_and_bare_addressing_is_untouched_by_the_device_dimension() -> None:
    """The hard requirement: nobody on one machine has to rewrite anything."""
    _seed_two_workspaces()
    assert agent_messaging.resolve("p1", "reviewer").pane.pane_id == "p2"
    assert agent_messaging.resolve("p1", "beta/reviewer").pane.pane_id == "p3"
    assert agent_messaging.resolve("p1", "/ws/beta/reviewer").pane.pane_id == "p3"


def test_a_multi_segment_workspace_is_not_mistaken_for_a_device() -> None:
    """`parent/proj/pane` predates devices and still means the workspace
    `parent/proj` — only a UUID-shaped leading segment is read as a device."""
    agent_messaging.register("p1", "a", "/one/proj")
    agent_messaging.register("p2", "target", "/two/proj")
    assert agent_messaging.resolve("p1", "two/proj/target").pane.pane_id == "p2"


def test_a_human_readable_leading_segment_is_read_as_workspace() -> None:
    """`resolve` is local-only addressing and stays that way: a non-UUID leading
    segment is a workspace here and fails as one. Device names are a second
    reading, tried by the caller afterwards — see parse_remote_target."""
    _seed_two_workspaces()
    result = agent_messaging.resolve("p1", "laptop-b/beta/reviewer")
    assert result.code == "unknown-workspace"
    assert result.params == {"ws": "laptop-b/beta"}


# ── Device labels from the remote roster ───────────────────────────────────
# `parse_remote_target` is the second reading of a target, consulted only after
# `resolve` has already failed on it. These pin that ordering, because getting
# it backwards would silently re-point addresses that work today.


def _seed_remote(**overrides: object) -> None:
    from agent_team_backend import remote_roster

    row = {
        "sessionId": "sess-1",
        "deviceId": "far-device",
        "deviceName": "laptop-b",
        "workspace": "beta",
        "workspacePath": "/home/other/beta",
        "title": "reviewer",
        "paneId": "p-far",
        "agentKey": "claude",
        "status": "waiting",
        "hostOnline": True,
    }
    row.update(overrides)
    remote_roster.replace([row], local_device_id="this-device")


def test_parse_remote_target_finds_nothing_without_a_roster() -> None:
    """The no-server line: an empty roster makes every second reading a no-op,
    so the caller's answer is the one it always gave."""
    empty = agent_messaging.parse_remote_target("laptop-b/beta/reviewer")
    assert (empty.address, empty.error, empty.code) == (None, None, None)


def test_a_device_name_resolves_once_the_roster_knows_it(remote_roster_clean) -> None:
    _seed_remote()
    match = agent_messaging.parse_remote_target("laptop-b/beta/reviewer")
    assert match.address is not None
    assert match.address.device_id == "far-device"
    assert match.address.workspace == "beta"
    assert match.address.pane_name == "reviewer"
    # The id form reads the same way, which is what cli_list_targets advertises.
    by_id = agent_messaging.parse_remote_target("far-device/beta/reviewer")
    assert by_id.address is not None and by_id.address.device_id == "far-device"


def test_local_resolution_wins_over_a_device_of_the_same_name(remote_roster_clean) -> None:
    """The protection that must survive device names: `two/proj/target` names a
    workspace today, and a machine called `two` must not take it away. `resolve`
    still answers it, and the caller only ever consults the roster after
    `resolve` has failed."""
    agent_messaging.register("p1", "a", "/one/proj")
    agent_messaging.register("p2", "target", "/two/proj")
    _seed_remote(deviceName="two", workspace="proj", title="target")

    assert agent_messaging.resolve("p1", "two/proj/target").pane.pane_id == "p2"


def test_a_two_segment_target_is_never_read_as_a_device(remote_roster_clean) -> None:
    """`folder/pane` stays a workspace address, matching the rule for id-shaped
    device segments — otherwise a device name would swallow it whole."""
    _seed_remote()
    assert agent_messaging.parse_remote_target("laptop-b/reviewer").address is None


def test_an_ambiguous_device_name_is_refused_not_guessed(remote_roster_clean) -> None:
    from agent_team_backend import remote_roster

    remote_roster.replace(
        [
            {
                "sessionId": f"s{i}",
                "deviceId": f"d{i}",
                "deviceName": "laptop",
                "workspace": "beta",
                "title": "reviewer",
                "status": "waiting",
                "hostOnline": True,
            }
            for i in (1, 2)
        ],
        local_device_id="this-device",
    )
    match = agent_messaging.parse_remote_target("laptop/beta/reviewer")
    assert match.address is None
    assert match.code == "ambiguous-device"
    assert match.params == {"device": "laptop", "n": "2"}


def test_a_pane_name_containing_a_slash_behaves_the_same_with_a_device_segment() -> None:
    """The pane name is the trailing segment, before and after the device
    dimension: everything ahead of it is still the workspace."""
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "feature/x", "/ws/alpha")

    plain = agent_messaging.resolve("p1", "alpha/feature/x")
    with_device = agent_messaging.resolve("p1", f"{_this_device()}/alpha/feature/x")
    assert plain.code == with_device.code == "unknown-workspace"
    assert plain.params == with_device.params == {"ws": "alpha/feature"}


def test_resolve_address_uses_a_matching_pane_id_hint() -> None:
    _seed_two_workspaces()
    address = agent_messaging.Address(
        pane_name="reviewer", workspace="beta", device_id=_this_device(), pane_id="p3"
    )
    result = agent_messaging.resolve_address("p1", address)
    assert result.pane is not None and result.pane.pane_id == "p3"
    assert result.cross_workspace is True


def test_resolve_address_falls_back_when_the_hint_went_stale() -> None:
    """A detach/reattach mints a new pane id; the sender's cached one is not an
    identity, so resolution falls back to (workspace, pane name) and the caller
    reads the new id off the result."""
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("reattached", "reviewer", "/ws/beta")

    address = agent_messaging.Address(
        pane_name="reviewer", workspace="beta", pane_id="detached-old-id"
    )
    result = agent_messaging.resolve_address("p1", address)
    assert result.pane is not None and result.pane.pane_id == "reattached"


def test_resolve_address_ignores_a_hint_that_now_names_another_pane() -> None:
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("recycled", "someone-else", "/ws/beta")
    agent_messaging.register("p3", "reviewer", "/ws/beta")

    address = agent_messaging.Address(
        pane_name="reviewer", workspace="beta", pane_id="recycled"
    )
    assert agent_messaging.resolve_address("p1", address).pane.pane_id == "p3"


def test_resolve_address_hint_for_a_bare_name_stays_in_the_sender_workspace() -> None:
    _seed_two_workspaces()
    address = agent_messaging.Address(pane_name="reviewer", pane_id="p3")
    result = agent_messaging.resolve_address("p1", address)
    # p3 is the /ws/beta pane; a bare name must not reach it, hint or not.
    assert result.pane is not None and result.pane.pane_id == "p2"
    assert result.cross_workspace is False


def test_resolve_address_reports_an_offline_hint_target_as_offline() -> None:
    window = object()
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "reviewer", "/ws/beta", owner=window)
    agent_messaging.drop_owner(window)

    address = agent_messaging.Address(
        pane_name="reviewer", workspace="beta", pane_id="p2"
    )
    assert agent_messaging.resolve_address("p1", address).code == "target-offline"


def test_resolve_address_refuses_a_foreign_device_before_looking_anywhere() -> None:
    _seed_two_workspaces()
    address = agent_messaging.Address(
        pane_name="reviewer", workspace="beta", device_id=FOREIGN_DEVICE, pane_id="p3"
    )
    result = agent_messaging.resolve_address("p1", address)
    assert result.pane is None
    assert result.code == "unknown-device"
    assert result.params["to"] == f"{FOREIGN_DEVICE}/beta/reviewer"


def test_a_uuid_shaped_folder_on_this_machine_is_resolved_here() -> None:
    """M4. `/var/folders/…/T/<uuid>/`, app containers and worktrees put
    UUID-shaped folders in ordinary workspace paths on macOS; an address that
    names a pane on this machine through one must not be sent to another."""
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p-uuid", "reviewer", f"/var/folders/T/{FOREIGN_DEVICE}/proj")

    result = agent_messaging.resolve("p1", f"{FOREIGN_DEVICE}/proj/reviewer")

    assert result.pane is not None and result.pane.pane_id == "p-uuid"


def test_routing_keeps_a_uuid_shaped_folder_address_on_this_machine() -> None:
    from agent_team_backend import message_routing

    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p-uuid", "reviewer", f"/var/folders/T/{FOREIGN_DEVICE}/proj")

    routed = message_routing.route("p1", f"{FOREIGN_DEVICE}/proj/reviewer")

    assert routed.remote is None
    assert routed.pane is not None and routed.pane.pane_id == "p-uuid"


def test_a_foreign_device_with_no_local_match_still_goes_remote() -> None:
    from agent_team_backend import message_routing

    _seed_two_workspaces()

    routed = message_routing.route("p1", f"{FOREIGN_DEVICE}/beta/reviewer")

    assert routed.pane is None
    assert routed.remote is not None and routed.remote.device_id == FOREIGN_DEVICE


# ── Resolution by pane id ──────────────────────────────────────────────────
def test_resolve_pane_id_names_one_of_two_panes_sharing_a_name() -> None:
    """The whole reason an id exists: two panes in one workspace may share a
    name, and `resolve` refuses both rather than guessing."""
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "claude-2", "/ws/beta")
    agent_messaging.register("p3", "claude-2", "/ws/beta")
    assert agent_messaging.resolve("p1", "beta/claude-2").code == "ambiguous-target"

    result = agent_messaging.resolve_pane_id("p1", "p3")

    assert result.pane is not None and result.pane.pane_id == "p3"
    assert result.code is None and result.error is None


def test_resolve_pane_id_follows_the_alias_table() -> None:
    """A window reload or a detach rebuilds the pane around the same running
    CLI under a new id — the id that CLI was handed at spawn time has to keep
    naming it, or every id an agent holds goes stale on a reload."""
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "reviewer", "/ws/beta")
    agent_messaging.unregister("p2")
    agent_messaging.register("p2-rebuilt", "reviewer", "/ws/beta")
    agent_messaging.add_aliases("p2-rebuilt", ["p2"], "/ws/beta")

    result = agent_messaging.resolve_pane_id("p1", "p2")

    assert result.pane is not None and result.pane.pane_id == "p2-rebuilt"


def test_resolve_pane_id_refuses_a_blank_id() -> None:
    # Whitespace has to fail like an empty string: the MCP tools treat a blank
    # id as "not given" and fall back to the address, so a blank one reaching
    # here at all means the caller meant an id and typed nothing.
    _seed_two_workspaces()
    for ident in ("", "   "):
        result = agent_messaging.resolve_pane_id("p1", ident)
        assert result.pane is None, ident
        assert result.code == "empty-target", ident


def test_resolve_pane_id_refuses_an_unknown_id() -> None:
    """Kept apart from "offline": an id nothing answers to means the pane was
    rebuilt around a fresh CLI, and the answer is to read a new id — not to
    retry the one in hand."""
    _seed_two_workspaces()
    result = agent_messaging.resolve_pane_id("p1", "never-existed")

    assert result.pane is None
    assert result.code == "unknown-pane-id"
    assert result.params == {"pane_id": "never-existed"}
    assert result.error is not None and "cli_list_targets" in result.error


def test_resolve_pane_id_reports_an_offline_pane_as_offline() -> None:
    # Same distinction an address gets: the pane is right, its window is away.
    window = object()
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "reviewer", "/ws/beta", owner=window)
    agent_messaging.drop_owner(window)

    result = agent_messaging.resolve_pane_id("p1", "p2")

    assert result.pane is None
    assert result.code == "target-offline"


def test_resolve_pane_id_flags_cross_workspace_like_an_address_does() -> None:
    """`cross_workspace` drives how the delivery is labelled to the recipient,
    so an id must compute it the same way a name does — including for a caller
    with no pane of its own, whose message comes from outside every one."""
    _seed_two_workspaces()

    assert agent_messaging.resolve_pane_id("p1", "p2").cross_workspace is False
    assert agent_messaging.resolve_pane_id("p1", "p3").cross_workspace is True
    assert agent_messaging.resolve_pane_id("", "p2").cross_workspace is True


# ── WS handlers ────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_register_handler_mirrors_pane() -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "r1",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "p1",
            "name": "reviewer",
            "workspace_path": "/ws/alpha",
            "agent_key": "claude",
        },
    })
    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["qualified_name"] == "alpha/reviewer"
    assert agent_messaging.get("p1") is not None


@pytest.mark.asyncio
async def test_register_handler_rejects_missing_fields() -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "r2",
        "type": "agent_msg.register",
        "payload": {"pane_id": "p1"},
    })
    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["error"]["code"] == "BAD_REQUEST"


@pytest.mark.asyncio
async def test_unregister_handler_removes_pane() -> None:
    agent_messaging.register("p1", "a", "/ws/alpha")
    session = _session()
    await app.handle_message(session, {
        "id": "u1",
        "type": "agent_msg.unregister",
        "payload": {"pane_id": "p1"},
    })
    assert agent_messaging.get("p1") is None


@pytest.mark.asyncio
async def test_list_handler_returns_all_workspaces_when_unfiltered() -> None:
    _seed_two_workspaces()
    session = _session()
    await app.handle_message(session, {
        "id": "l1",
        "type": "agent_msg.list",
        "payload": {},
    })
    panes = session.websocket.sent[0]["payload"]["panes"]  # type: ignore[attr-defined]
    assert {p["pane_id"] for p in panes} == {"p1", "p2", "p3"}


@pytest.mark.asyncio
async def test_list_pairs_pane_id_with_its_address() -> None:
    """The drag-to-mention path resolves a dropped pane id to its address
    straight from this listing, so the pairing has to be exact."""
    _seed_two_workspaces()
    session = _session()
    await app.handle_message(session, {
        "id": "l2",
        "type": "agent_msg.list",
        "payload": {},
    })
    panes = session.websocket.sent[0]["payload"]["panes"]  # type: ignore[attr-defined]
    by_id = {p["pane_id"]: p["qualified_name"] for p in panes}
    assert by_id == {
        "p1": "alpha/claude-1",
        "p2": "alpha/reviewer",
        "p3": "beta/reviewer",
    }


@pytest.mark.asyncio
async def test_route_handler_broadcasts_deliver_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_two_workspaces()
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "d1",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "p1",
            "to": "beta/reviewer",
            "content": "run the tests",
            "msg_key": "k1",
        },
    })
    await asyncio.sleep(0)

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["ok"] is True
    assert resp["payload"]["target_pane_id"] == "p3"
    assert resp["payload"]["cross_workspace"] is True

    assert len(events) == 1
    payload = events[0]["payload"]
    assert events[0]["type"] == "agent_msg.deliver"
    assert payload["target_pane_id"] == "p3"
    assert payload["from_display"] == "alpha/claude-1"
    assert payload["content"] == "run the tests"
    assert payload["msg_key"] == "k1"
    # A message that starts a thread carries no correlation id, and the payload
    # stays exactly what an older window expects.
    assert "reply_to" not in payload


@pytest.mark.asyncio
async def test_route_handler_passes_reply_to_through_to_deliver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A reply echoes the correlation id of the message it answers; the registry
    hands it back untouched so the sending window can link the two rows."""
    _seed_two_workspaces()
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "d3",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "p3",
            "to": "alpha/claude-1",
            "content": "all green",
            "msg_key": "k3",
            "reply_to": "p1:7",
        },
    })
    await asyncio.sleep(0)

    assert session.websocket.sent[0]["payload"]["ok"] is True  # type: ignore[attr-defined]
    assert len(events) == 1
    assert events[0]["payload"]["reply_to"] == "p1:7"
    assert events[0]["payload"]["msg_key"] == "k3"


@pytest.mark.asyncio
async def test_route_handler_reports_unresolved_without_broadcasting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_two_workspaces()
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "d2",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "p1",
            "to": "gamma/reviewer",
            "content": "hi",
            "msg_key": "k2",
        },
    })
    await asyncio.sleep(0)

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["ok"] is False
    assert "unknown workspace" in resp["payload"]["error"]
    assert events == []


@pytest.mark.asyncio
async def test_route_handler_refuses_self_send(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_two_workspaces()
    monkeypatch.setattr(app, "broadcast", lambda *a, **k: asyncio.sleep(0))
    session = _session()
    await app.handle_message(session, {
        "id": "d3",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "p1",
            "to": "alpha/claude-1",
            "content": "hi",
            "msg_key": "k3",
        },
    })
    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["ok"] is False
    assert "same pane" in resp["payload"]["error"]


@pytest.mark.asyncio
async def test_delivered_handler_broadcasts_result_to_every_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Including the reporter — a qualified target can resolve inside the same
    window, and excluding it would strand that message in `queued`."""
    captured: list[tuple[dict[str, Any], Any]] = []

    async def fake_broadcast(event: dict[str, Any], **kwargs: Any) -> None:
        captured.append((event, kwargs.get("exclude")))

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "x1",
        "type": "agent_msg.delivered",
        "payload": {"msg_key": "k1", "ok": True},
    })
    await asyncio.sleep(0)

    event, exclude = captured[0]
    assert event["type"] == "agent_msg.delivery_result"
    assert event["payload"] == {"msg_key": "k1", "ok": True, "reason": ""}
    assert exclude is None


@pytest.mark.asyncio
async def test_cancel_handler_relays_the_request_to_every_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The queue lives in the receiving window, so the withdrawal is only
    relayed — including back to the sender, whose own window may own the
    target pane."""
    captured: list[tuple[dict[str, Any], Any]] = []

    async def fake_broadcast(event: dict[str, Any], **kwargs: Any) -> None:
        captured.append((event, kwargs.get("exclude")))

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "c1",
        "type": "agent_msg.cancel",
        "payload": {"msg_key": "k1"},
    })
    await asyncio.sleep(0)

    event, exclude = captured[0]
    assert event["type"] == "agent_msg.cancel"
    assert event["payload"] == {"msg_key": "k1"}
    assert exclude is None
    assert session.websocket.sent[0]["payload"] == {"ok": True}  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_cancel_handler_needs_a_msg_key() -> None:
    session = _session()
    await app.handle_message(session, {"id": "c2", "type": "agent_msg.cancel", "payload": {}})

    assert session.websocket.sent[0]["error"]["code"] == "BAD_REQUEST"  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_delivered_handler_also_settles_a_cli_send_for_cli_check_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A message sent through the MCP cli_send has no window holding its
    msg_key, so the outcome has to be handed to the MCP server too — without
    disturbing the rebroadcast every window relies on."""
    from agent_team_backend.mcp_server import server as plan_mcp

    captured: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        captured.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    plan_mcp._record_message_sent("mcp-key", "beta/reviewer", "pa", "hi")
    try:
        session = _session()
        await app.handle_message(session, {
            "id": "x1",
            "type": "agent_msg.delivered",
            "payload": {"msg_key": "mcp-key", "ok": False, "reason": '{"key":"queue-full"}'},
        })
        await asyncio.sleep(0)

        assert plan_mcp._mcp_message_status["mcp-key"]["status"] == "failed"
        assert plan_mcp._mcp_message_status["mcp-key"]["reason"] == "queue-full"
        assert captured[0]["type"] == "agent_msg.delivery_result"
    finally:
        plan_mcp._mcp_message_status.clear()


@pytest.mark.asyncio
async def test_delivered_handler_also_acks_a_message_relayed_in_from_another_device(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """This handler is the only place a receiving window's verdict is seen, so
    it is where a cross-device message turns into its messages.ack."""
    from agent_team_backend import server_link

    reported: list[tuple[str, bool, str]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        pass

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    monkeypatch.setattr(
        server_link,
        "note_delivery_result",
        lambda key, ok, reason: reported.append((key, ok, reason)) or True,
    )
    session = _session()
    await app.handle_message(session, {
        "id": "x1",
        "type": "agent_msg.delivered",
        "payload": {"msg_key": "remote-key", "ok": True, "reason": ""},
    })
    await asyncio.sleep(0)

    assert reported == [("remote-key", True, "")]


# ── Message-log persistence handlers ───────────────────────────────────────
@pytest.fixture
def message_log(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Swap the app-wide log for one rooted in tmp, like the vault fixture."""
    log = AgentMessageLog(db=Database(tmp_path / "navide.db"))
    monkeypatch.setattr(app, "agent_message_log", log)
    return log


def _log_row(uid: str, created_at: int, **over: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "uid": uid,
        "created_at": created_at,
        "status": "delivered",
        "sender": "alpha/claude-1",
        "recipient": "beta/reviewer",
        "content": f"hello {uid}",
    }
    row.update(over)
    return row


@pytest.mark.asyncio
async def test_log_append_then_snapshot_round_trip(message_log: Any) -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "la1",
        "type": "agent_msg.log_append",
        "payload": {"rows": [_log_row("a:1", 100), _log_row("a:2", 200)]},
    })
    assert session.websocket.sent[0]["payload"] == {"written": 2}  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "ls1",
        "type": "agent_msg.log_snapshot",
        "payload": {},
    })
    rows = session.websocket.sent[1]["payload"]["rows"]  # type: ignore[attr-defined]
    assert [r["uid"] for r in rows] == ["a:1", "a:2"]


@pytest.mark.asyncio
async def test_log_snapshot_clamps_the_limit(message_log: Any) -> None:
    message_log.append([_log_row(f"a:{i}", i) for i in range(1, 4)])
    session = _session()
    await app.handle_message(session, {
        "id": "ls2",
        "type": "agent_msg.log_snapshot",
        "payload": {"limit": 9000},
    })
    assert len(session.websocket.sent[0]["payload"]["rows"]) == 3  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "ls3",
        "type": "agent_msg.log_snapshot",
        "payload": {"limit": 0},
    })
    rows = session.websocket.sent[1]["payload"]["rows"]  # type: ignore[attr-defined]
    assert [r["uid"] for r in rows] == ["a:3"]


@pytest.mark.asyncio
async def test_log_update_handler_patches_status(message_log: Any) -> None:
    message_log.append([_log_row("a:1", 100, status="queued")])
    session = _session()
    await app.handle_message(session, {
        "id": "lu1",
        "type": "agent_msg.log_update",
        "payload": {
            "updates": [
                {"uid": "a:1", "status": "delivered", "delivered_at": 900},
                {"uid": "unknown:1", "status": "failed"},
            ]
        },
    })
    assert session.websocket.sent[0]["payload"] == {"updated": 1}  # type: ignore[attr-defined]
    assert message_log.tail()[0]["status"] == "delivered"


@pytest.mark.asyncio
async def test_log_clear_handler_keeps_in_flight_messages(message_log: Any) -> None:
    message_log.append([
        _log_row("a:1", 100, status="queued"),
        _log_row("a:2", 200, status="delivered"),
    ])
    session = _session()
    await app.handle_message(session, {
        "id": "lc1",
        "type": "agent_msg.log_clear",
        "payload": {},
    })
    assert session.websocket.sent[0]["payload"] == {"deleted": 1}  # type: ignore[attr-defined]
    assert [r["uid"] for r in message_log.tail()] == ["a:1"]


@pytest.mark.asyncio
async def test_log_clear_handler_honors_explicit_keep_statuses(message_log: Any) -> None:
    message_log.append([
        _log_row("a:1", 100, status="queued"),
        _log_row("a:2", 200, status="failed"),
    ])
    session = _session()
    await app.handle_message(session, {
        "id": "lc2",
        "type": "agent_msg.log_clear",
        "payload": {"keep_statuses": ["failed"]},
    })
    assert session.websocket.sent[0]["payload"] == {"deleted": 1}  # type: ignore[attr-defined]
    assert [r["uid"] for r in message_log.tail()] == ["a:2"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("msg_type", "payload"),
    [
        ("agent_msg.log_append", {"rows": "not a list"}),
        ("agent_msg.log_update", {}),
        ("agent_msg.log_clear", {"keep_statuses": "delivered"}),
        ("agent_msg.log_snapshot", {"limit": None}),
        ("agent_msg.log_snapshot", {"limit": "abc"}),
        ("agent_msg.log_snapshot", {"limit": float("inf")}),
    ],
)
async def test_log_handlers_answer_bad_request_for_malformed_payloads(
    message_log: Any, msg_type: str, payload: dict[str, Any]
) -> None:
    session = _session()
    await app.handle_message(session, {"id": "lm1", "type": msg_type, "payload": payload})
    frame = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert frame["ok"] is False
    assert frame["error"]["code"] == "BAD_REQUEST"


@pytest.mark.asyncio
async def test_log_handlers_never_broadcast(
    message_log: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Per-window queries: unlike route/delivered, nothing fans out."""
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    session = _session()
    for msg_id, msg_type, payload in (
        ("nb1", "agent_msg.log_append", {"rows": [_log_row("a:1", 100)]}),
        ("nb2", "agent_msg.log_update", {"updates": [{"uid": "a:1", "status": "failed"}]}),
        ("nb3", "agent_msg.log_snapshot", {}),
        ("nb4", "agent_msg.log_clear", {}),
    ):
        await app.handle_message(session, {"id": msg_id, "type": msg_type, "payload": payload})
    await asyncio.sleep(0)

    assert all(frame["ok"] is True for frame in session.websocket.sent)  # type: ignore[attr-defined]
    assert events == []


def test_handlers_are_registered() -> None:
    for msg_type in (
        "agent_msg.register",
        "agent_msg.unregister",
        "agent_msg.list",
        "agent_msg.route",
        "agent_msg.delivered",
        "agent_msg.log_snapshot",
        "agent_msg.log_append",
        "agent_msg.log_update",
        "agent_msg.log_clear",
    ):
        assert ws_handlers.lookup(msg_type) is not None


def test_every_resolve_code_has_a_ui_string() -> None:
    """The log panel renders `msg.reason-<code>`; a code with no string there
    shows the raw key to the user. Nothing else ties the two layers together,
    so adding a code without its strings has to fail here."""
    import json
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    source = (root / "backend/agent_team_backend/agent_messaging.py").read_text(encoding="utf-8")
    codes = set(re.findall(r'_resolve_error\(\s*\n?\s*"([a-z-]+)"', source))
    assert codes, "no codes found — has _resolve_error been renamed?"

    for locale in ("en-US", "zh-TW"):
        strings = json.loads(
            (root / f"packages/plugin-ui/src/foundation/i18n/locales/{locale}.json").read_text(
                encoding="utf-8"
            )
        )["msg"]
        missing = sorted(c for c in codes if f"reason-{c}" not in strings)
        assert not missing, f"{locale} is missing msg.reason-* for: {missing}"


# ── agent_msg.hold_update ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_hold_update_hands_the_reason_to_the_mcp_server() -> None:
    """Delivery lives in the window, so why a message has not gone in yet
    exists nowhere else — and an MCP caller has no Messages panel to read."""
    from agent_team_backend.mcp_server import server as plan_mcp

    plan_mcp._record_message_sent("mcp-key", "beta/reviewer", "pa", "hi")
    try:
        session = _session()
        await app.handle_message(session, {
            "id": "h1",
            "type": "agent_msg.hold_update",
            "payload": {"msg_key": "mcp-key", "hold": {"key": "typing"}},
        })

        assert session.websocket.sent[0]["payload"]["tracked"] is True  # type: ignore[attr-defined]
        assert plan_mcp._mcp_message_status["mcp-key"]["hold"] == {"key": "typing"}
        assert plan_mcp._mcp_message_status["mcp-key"]["hold_since"] is not None
    finally:
        plan_mcp._mcp_message_status.clear()


@pytest.mark.asyncio
async def test_hold_update_with_a_null_hold_clears_it() -> None:
    from agent_team_backend.mcp_server import server as plan_mcp

    plan_mcp._record_message_sent("mcp-key", "beta/reviewer", "pa", "hi")
    plan_mcp.record_message_hold("mcp-key", {"key": "typing"})
    try:
        session = _session()
        await app.handle_message(session, {
            "id": "h2",
            "type": "agent_msg.hold_update",
            "payload": {"msg_key": "mcp-key", "hold": None},
        })

        assert plan_mcp._mcp_message_status["mcp-key"]["hold"] is None
    finally:
        plan_mcp._mcp_message_status.clear()


@pytest.mark.asyncio
async def test_hold_update_for_a_key_no_window_owns_is_not_an_error() -> None:
    """Every window reports for every tracked message it holds, exactly as it
    does for deliveries — the ones this backend never minted just miss."""
    session = _session()
    await app.handle_message(session, {
        "id": "h3",
        "type": "agent_msg.hold_update",
        "payload": {"msg_key": "not-ours", "hold": {"key": "typing"}},
    })

    sent = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert sent["error"] is None
    assert sent["payload"]["tracked"] is False


@pytest.mark.asyncio
async def test_hold_update_needs_a_msg_key() -> None:
    session = _session()
    await app.handle_message(session, {"id": "h4", "type": "agent_msg.hold_update", "payload": {}})

    assert session.websocket.sent[0]["error"]["code"] == "BAD_REQUEST"  # type: ignore[attr-defined]


def test_the_badge_word_and_the_busy_flag_are_recorded_together():
    """They answer different questions and disagree in both directions, so the
    registry keeps both rather than deriving one from the other."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj", agent_key="claude")

    # A half-typed draft: cannot take an injection, but nothing is working.
    assert agent_messaging.set_busy("p1", True, "idle") is True
    entry = agent_messaging.list_panes()[0]
    assert (entry.busy, entry.display_status) == (True, "idle")

    # A crashed CLI: free to take a message, and that message goes nowhere.
    assert agent_messaging.set_busy("p1", False, "error") is True
    entry = agent_messaging.list_panes()[0]
    assert (entry.busy, entry.display_status) == (False, "error")


def test_a_report_with_no_badge_word_leaves_the_last_one_alone():
    """An older window sends only `busy`. Treating that as "the status is now
    unknown" would blank a word that is still true and make the network view
    flicker back to the legacy fallback once a second."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj", agent_key="claude")
    agent_messaging.set_busy("p1", False, "awaiting")
    agent_messaging.set_busy("p1", True)
    assert agent_messaging.list_panes()[0].display_status == "awaiting"


def test_reporting_the_same_pair_twice_is_not_a_change():
    """The caller dedupes on this answer; a always-changed reply would push a
    roster update to the server every second for every pane."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj", agent_key="claude")
    assert agent_messaging.set_busy("p1", True, "running") is True
    assert agent_messaging.set_busy("p1", True, "running") is False


def test_a_rename_keeps_the_badge_word():
    """Re-registering is a rename or a reconnect, not a state change — the same
    reason `busy` is carried over."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj", agent_key="claude")
    agent_messaging.set_busy("p1", False, "awaiting")
    agent_messaging.register("p1", "reviewer-renamed", "/tmp/proj", agent_key="claude")
    assert agent_messaging.list_panes()[0].display_status == "awaiting"



async def _noop_broadcast(_event: dict[str, Any], **_kwargs: Any) -> None:
    """Swallow the deliver broadcast in tests that are about routing, not it."""


def _mcp_ctx(pane_id: str) -> Any:
    """A cli_send caller identified as *pane_id*, the way the MCP URL does."""
    from types import SimpleNamespace

    from agent_team_backend.mcp_server import wiring as plan_mcp_wiring

    return SimpleNamespace(
        request_context=SimpleNamespace(
            request=SimpleNamespace(
                query_params={"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
            )
        )
    )


# ── The bare-line path and cli_send answer one address the same way ──────────
#
# They did not. Cross-device addressing was built onto cli_send (8cca3aed) and
# the device-name roster came later (a0358412); neither touched agent_msg.route,
# so a `<device>/<ws>/<pane>` target delivered from the tool and answered
# "unknown device" from a printed block, at the same moment, for the same
# string. Both now go through message_routing.route, and these are what say so.


async def _route(session: Any, to: str, *, content: str = "hi") -> dict[str, Any]:
    """One bare-line send through the real handler."""
    await app.handle_message(session, {
        "id": "r1",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "p1",
            "to": to,
            "content": content,
            "msg_key": "mk1",
        },
    })
    await asyncio.sleep(0)
    return session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_a_bare_line_block_reaches_another_device(
    monkeypatch: pytest.MonkeyPatch, remote_roster_clean
) -> None:
    """The reported bug: cli_send delivered, the printed block did not."""
    from agent_team_backend import server_link

    sent: list[dict[str, Any]] = []

    async def fake_send_message(**kwargs: Any) -> dict[str, Any]:
        sent.append(kwargs)
        return {"ok": True, "payload": {"msgKey": kwargs["msg_key"], "state": "pending"}}

    monkeypatch.setattr(server_link, "send_message", fake_send_message)
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    _seed_two_workspaces()

    payload = await _route(_session(), f"{FOREIGN_DEVICE}/beta/reviewer")

    assert payload["ok"] is True
    assert payload["target_display"] == f"{FOREIGN_DEVICE}/beta/reviewer"
    assert payload["cross_workspace"] is True
    # Relayed, not injected into a pane on this machine.
    assert events == []
    assert sent[0]["to"] == {
        "deviceId": FOREIGN_DEVICE,
        "workspace": "beta",
        "paneName": "reviewer",
    }
    assert sent[0]["text"] == "hi"
    # The sender travels with it, or the far side cannot address a reply back.
    assert sent[0]["sender"]["paneId"] == "p1"


@pytest.mark.asyncio
async def test_a_bare_line_block_reaches_a_device_by_name(
    monkeypatch: pytest.MonkeyPatch, remote_roster_clean
) -> None:
    """The second half of cross-device addressing: a name, resolved through the
    roster only after the local reading has failed."""
    from agent_team_backend import server_link

    sent: list[dict[str, Any]] = []

    async def fake_send_message(**kwargs: Any) -> dict[str, Any]:
        sent.append(kwargs)
        return {"ok": True, "payload": {"msgKey": kwargs["msg_key"], "state": "pending"}}

    monkeypatch.setattr(server_link, "send_message", fake_send_message)
    monkeypatch.setattr(app, "broadcast", _noop_broadcast)
    _seed_two_workspaces()
    _seed_remote()

    payload = await _route(_session(), "laptop-b/beta/reviewer")

    assert payload["ok"] is True
    assert sent[0]["to"]["deviceId"] == "far-device"


@pytest.mark.asyncio
async def test_a_local_workspace_still_beats_a_device_of_the_same_name(
    monkeypatch: pytest.MonkeyPatch, remote_roster_clean
) -> None:
    """The invariant a shared resolver must not lose: a target that resolves on
    this machine never reaches the roster, so naming a laptop after a folder
    cannot move an address that works today."""
    from agent_team_backend import server_link

    async def fail_if_called(**_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("a local target must never be relayed")

    monkeypatch.setattr(server_link, "send_message", fail_if_called)
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    _seed_two_workspaces()
    # Two shapes, because they fail differently. A two-segment target is never
    # read as a device at all; a three-segment one is, but only after the
    # workspace reading has been tried and failed.
    agent_messaging.register("p9", "target", "/two/proj")
    _seed_remote(deviceName="beta", workspace="beta", title="reviewer")

    payload = await _route(_session(), "beta/reviewer")

    assert payload["ok"] is True
    assert payload["target_pane_id"] == "p3"
    assert len(events) == 1

    _seed_remote(deviceName="two", workspace="proj", title="target")
    three = await _route(_session(), "two/proj/target")

    assert three["ok"] is True
    assert three["target_pane_id"] == "p9"
    assert len(events) == 2


@pytest.mark.asyncio
async def test_both_paths_refuse_an_ambiguous_device_name_the_same_way(
    monkeypatch: pytest.MonkeyPatch, remote_roster_clean
) -> None:
    """Delivering an instruction to the wrong machine is not something a sender
    can undo after reading about it — and the two paths must not disagree about
    which sends are safe."""
    from agent_team_backend import remote_roster, server_link
    from agent_team_backend.mcp_server import server as plan_mcp

    async def fail_if_called(**_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("an ambiguous device must never be relayed")

    monkeypatch.setattr(server_link, "send_message", fail_if_called)
    monkeypatch.setattr(app, "broadcast", _noop_broadcast)
    _seed_two_workspaces()
    remote_roster.replace(
        [
            {"sessionId": "s1", "deviceId": "d1", "deviceName": "twin",
             "workspace": "beta", "title": "reviewer", "status": "idle",
             "hostOnline": True},
            {"sessionId": "s2", "deviceId": "d2", "deviceName": "twin",
             "workspace": "beta", "title": "reviewer", "status": "idle",
             "hostOnline": True},
        ],
        local_device_id="this-device",
    )

    payload = await _route(_session(), "twin/beta/reviewer")
    tool = await plan_mcp.cli_send("twin/beta/reviewer", "hi", _mcp_ctx("p1"))

    assert payload["ok"] is False
    assert payload["code"] == "ambiguous-device"
    assert tool["ok"] is False
    assert tool["error_code"] == "ambiguous-device"


@pytest.mark.asyncio
async def test_both_paths_report_an_unreachable_link_the_same_way(
    monkeypatch: pytest.MonkeyPatch, remote_roster_clean
) -> None:
    """A link that is down is not an unknown address, and an agent told the
    wrong one of those looks in the wrong place."""
    from agent_team_backend import server_link
    from agent_team_backend.mcp_server import server as plan_mcp

    async def offline(**_kwargs: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "error": {"code": "LINK_OFFLINE", "message": "not connected",
                      "state": "unreachable", "lastError": "timed out"},
        }

    monkeypatch.setattr(server_link, "send_message", offline)
    monkeypatch.setattr(app, "broadcast", _noop_broadcast)
    _seed_two_workspaces()

    payload = await _route(_session(), f"{FOREIGN_DEVICE}/beta/reviewer")
    tool = await plan_mcp.cli_send(f"{FOREIGN_DEVICE}/beta/reviewer", "hi", _mcp_ctx("p1"))

    assert payload["ok"] is False
    assert payload["code"] == "link-offline"
    assert tool["error_code"] == "link-offline"
    # And it is reported at once, in the answer to the send itself.
    assert payload["error"] and "could not be reached" in payload["error"]


@pytest.mark.asyncio
async def test_with_no_link_at_all_both_paths_still_say_unknown_device(
    monkeypatch: pytest.MonkeyPatch, remote_roster_clean
) -> None:
    """The no-server regression line. `send_message` returning None means this
    machine was never configured, and the answer stays what it was before
    cross-device addressing existed — for both paths."""
    from agent_team_backend import server_link
    from agent_team_backend.mcp_server import server as plan_mcp

    async def unconfigured(**_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(server_link, "send_message", unconfigured)
    monkeypatch.setattr(app, "broadcast", _noop_broadcast)
    _seed_two_workspaces()

    payload = await _route(_session(), f"{FOREIGN_DEVICE}/beta/reviewer")
    tool = await plan_mcp.cli_send(f"{FOREIGN_DEVICE}/beta/reviewer", "hi", _mcp_ctx("p1"))

    assert payload["ok"] is False
    assert payload["code"] == "unknown-device"
    assert tool["error_code"] == "unknown-device"


# ── This machine, in any account ─────────────────────────────────────────────


def test_a_fresh_install_recognises_its_own_node_id(tmp_path, monkeypatch):
    """The order a new machine actually goes through, which nothing tested.

    Every other test here calls ``device_id()`` first, and on an upgraded
    machine that value *is* the first account's node — so comparing against it
    looked right. A fresh install never takes that path: it authenticates, and
    ``claim_node_id`` writes ``nodes`` and ``machine_id`` and nothing else. The
    legacy id is minted later, lazily, by something unrelated — a different
    uuid that is nobody's node.

    A message addressed to this machine's own node id was then judged remote:
    it went to the relay, came back, and was refused as not paired. A message
    that never had to leave the machine left it on the way to failing.
    """
    from agent_team_backend import device_identity

    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path))
    # Fresh install order: no device_id() call anywhere before this.
    node = device_identity.candidate_node_ids("")[0]
    device_identity.claim_node_id("m1", node)

    assert agent_messaging.is_local_device(node), "this machine, addressed by its own id"


def test_every_account_this_machine_is_in_counts_as_this_machine(tmp_path, monkeypatch):
    from agent_team_backend import device_identity

    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path))
    legacy = device_identity.device_id()
    device_identity.claim_node_id("m-a", legacy)
    second = device_identity.fresh_node_id()
    device_identity.claim_node_id("m-b", second)

    assert agent_messaging.is_local_device(legacy)
    assert agent_messaging.is_local_device(second)
    assert not agent_messaging.is_local_device(device_identity.fresh_node_id())
    assert not agent_messaging.is_local_device("")
