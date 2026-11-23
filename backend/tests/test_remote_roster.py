"""remote_roster: the cache of panes living on other machines.

Nothing here talks to a server — the module never does either, it only holds
what server_link hands it. These pin the cache's own rules: what a directory row
has to carry to be addressable, that this device's own rows never come back as
remote ones, the bound, and how a device label is matched.
"""

from __future__ import annotations

import pytest

from agent_team_backend import agent_messaging, remote_roster

LOCAL = "local-device"
FAR = "far-device"


@pytest.fixture(autouse=True)
def _clean() -> None:
    remote_roster._reset_for_test()
    agent_messaging._reset_for_test()
    yield
    remote_roster._reset_for_test()
    agent_messaging._reset_for_test()


def row(**overrides: object) -> dict:
    base = {
        "sessionId": "sess-1",
        "deviceId": FAR,
        "workspace": "proj",
        "workspacePath": "/home/other/proj",
        "title": "reviewer",
        "paneId": "p-far-1",
        "agentKey": "claude",
        "status": "waiting",
        "hostOnline": True,
    }
    base.update(overrides)
    return base


# ---- empty is the normal state ----------------------------------------------


def test_an_untouched_roster_is_empty():
    assert remote_roster.list_panes() == []
    assert remote_roster.devices_named(FAR) == []
    assert agent_messaging.parse_remote_target(f"{FAR}/proj/reviewer").address is None


# ---- reading the directory --------------------------------------------------


def test_a_row_becomes_an_addressable_pane():
    remote_roster.replace([row()], local_device_id=LOCAL)
    (pane,) = remote_roster.list_panes()
    assert pane.address == f"{FAR}/proj/reviewer"
    assert pane.to_dict() == {
        "name": "reviewer",
        "address": f"{FAR}/proj/reviewer",
        "device": FAR,
        "workspace": "proj",
        "workspace_path": "/home/other/proj",
        "agent_key": "claude",
        "busy": False,
        "offline": False,
        "host_online": True,
        "status": "waiting",
    }


def test_this_devices_own_sessions_are_never_remote():
    """agent_messaging already holds them with live state; the server's copy is
    whatever was last reported, so keeping both would give one pane two
    answers."""
    remote_roster.replace(
        [row(sessionId="s1", deviceId=LOCAL), row(sessionId="s2")], local_device_id=LOCAL
    )
    assert [p.device_id for p in remote_roster.list_panes()] == [FAR]


@pytest.mark.parametrize("missing", ["deviceId", "workspace", "title"])
def test_a_row_that_cannot_be_addressed_is_dropped(missing: str):
    """Those three *are* the address; a row without one could only be listed as
    a target nobody can name."""
    remote_roster.replace([row(**{missing: ""})], local_device_id=LOCAL)
    assert remote_roster.list_panes() == []


def test_rows_that_are_not_dicts_or_carry_no_session_id_are_skipped():
    remote_roster.replace(["nope", None, row(sessionId=""), row()], local_device_id=LOCAL)
    assert len(remote_roster.list_panes()) == 1


def test_replace_is_wholesale_not_a_merge():
    remote_roster.replace([row(sessionId="s1", title="one")], local_device_id=LOCAL)
    remote_roster.replace([row(sessionId="s2", title="two")], local_device_id=LOCAL)
    assert [p.pane_name for p in remote_roster.list_panes()] == ["two"]


def test_the_cache_is_bounded(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(remote_roster, "MAX_PANES", 3)
    remote_roster.replace(
        [row(sessionId=f"s{i}", title=f"pane{i}") for i in range(10)], local_device_id=LOCAL
    )
    assert len(remote_roster.list_panes()) == 3


# ---- busy / offline ---------------------------------------------------------


@pytest.mark.parametrize(
    "status,host_online,busy,offline",
    [
        ("running", True, True, False),
        ("waiting", True, False, False),
        # One window reconnecting on a machine that is otherwise fine.
        ("disconnected", True, False, True),
        ("exited", True, False, True),
        # The whole machine is away, whatever the last reported status was.
        ("waiting", False, False, True),
        ("running", False, True, True),
    ],
)
def test_status_and_host_presence_both_feed_offline(
    status: str, host_online: bool, busy: bool, offline: bool
):
    remote_roster.replace([row(status=status, hostOnline=host_online)], local_device_id=LOCAL)
    (pane,) = remote_roster.list_panes()
    assert (pane.busy, pane.offline) == (busy, offline)


def test_presence_reflags_devices_without_a_session_change():
    """A device dropping off changes no session row, so sessions.changed never
    fires for it — presence.changed is the only signal."""
    remote_roster.replace(
        [row(sessionId="s1"), row(sessionId="s2", deviceId="other-device")],
        local_device_id=LOCAL,
    )
    remote_roster.set_online_devices({FAR})
    by_device = {p.device_id: p for p in remote_roster.list_panes()}
    assert by_device[FAR].host_online is True
    assert by_device["other-device"].host_online is False
    assert by_device["other-device"].offline is True


# ---- device labels ----------------------------------------------------------


def test_a_device_answers_to_its_id_and_to_its_name():
    remote_roster.replace([row(deviceName="Studio Mac")], local_device_id=LOCAL)
    assert remote_roster.devices_named(FAR) == [FAR]
    assert remote_roster.devices_named("Studio Mac") == [FAR]
    (pane,) = remote_roster.list_panes()
    # The advertised address stays the id form even when a name is known.
    assert pane.device_label == "Studio Mac"
    assert pane.address == f"{FAR}/proj/reviewer"


@pytest.mark.parametrize("typed", ["studio mac", "STUDIO MAC", "Studio mAc"])
def test_a_device_name_is_matched_whatever_the_case(typed: str):
    """Someone who named the machine "Studio Mac" types "studio mac" — the name
    is human text, and the server neither normalises nor resolves by it."""
    remote_roster.replace([row(deviceName="Studio Mac")], local_device_id=LOCAL)
    assert remote_roster.devices_named(typed) == [FAR]
    assert (
        agent_messaging.parse_remote_target(f"{typed}/proj/reviewer").address.device_id == FAR
    )


@pytest.mark.parametrize("typed", ["FAR-DEVICE", "Far-Device"])
def test_a_device_id_stays_an_exact_match(typed: str):
    """Unlike the name: an id is machine-issued and opaque, so folding its case
    could only make two distinct ids answer to one label."""
    remote_roster.replace([row(deviceId="far-device", deviceName="Studio Mac")], local_device_id=LOCAL)
    assert remote_roster.devices_named(typed) == []


def test_a_shared_device_name_reports_every_match():
    remote_roster.replace(
        [
            row(sessionId="s1", deviceId="d1", deviceName="laptop"),
            row(sessionId="s2", deviceId="d2", deviceName="laptop"),
        ],
        local_device_id=LOCAL,
    )
    assert remote_roster.devices_named("laptop") == ["d1", "d2"]


def test_names_that_differ_only_in_case_collide_and_are_refused():
    """Case folding makes these one name, which must widen the *ambiguous*
    answer, not resolve to whichever device the directory listed first: sending
    an instruction to the wrong machine is not undone by reading an error."""
    remote_roster.replace(
        [
            row(sessionId="s1", deviceId="d1", deviceName="Laptop"),
            row(sessionId="s2", deviceId="d2", deviceName="laptop"),
        ],
        local_device_id=LOCAL,
    )
    assert remote_roster.devices_named("LAPTOP") == ["d1", "d2"]
    refused = agent_messaging.parse_remote_target("laptop/proj/reviewer")
    assert refused.address is None
    assert refused.code == "ambiguous-device"


def test_clear_forgets_everything():
    remote_roster.replace([row()], local_device_id=LOCAL)
    remote_roster.clear()
    assert remote_roster.list_panes() == []


# ---- the policy editor's device picker ---------------------------------------


def test_devices_are_listed_once_with_their_pane_count():
    remote_roster.replace(
        [
            row(sessionId="s1", deviceId="d1", deviceName="Laptop", title="reviewer"),
            row(sessionId="s2", deviceId="d1", deviceName="Laptop", title="builder"),
            row(sessionId="s3", deviceId="d2", deviceName="Desktop"),
        ],
        local_device_id=LOCAL,
    )
    assert remote_roster.list_devices() == [
        {"deviceId": "d2", "deviceName": "Desktop", "paneCount": 1},
        {"deviceId": "d1", "deviceName": "Laptop", "paneCount": 2},
    ]


def test_a_device_the_server_never_named_is_still_listed_by_id():
    """deviceName is not on a session row today, so the picker has to stay
    usable with nothing but ids — the rule is written against the id anyway."""
    remote_roster.replace([row(deviceId="d1")], local_device_id=LOCAL)
    assert remote_roster.list_devices() == [
        {"deviceId": "d1", "deviceName": "", "paneCount": 1}
    ]


def test_this_machine_is_not_offered_as_a_remote_source():
    remote_roster.replace(
        [row(sessionId="s1", deviceId=LOCAL), row(sessionId="s2", deviceId=FAR)],
        local_device_id=LOCAL,
    )
    assert [device["deviceId"] for device in remote_roster.list_devices()] == [FAR]


# ---- which segment is down --------------------------------------------------


@pytest.mark.parametrize(
    "status, host_online, reason",
    [
        # The far machine has no connection to the server at all.
        ("waiting", False, "device-offline"),
        ("disconnected", False, "device-offline"),
        # The machine is there; the window holding the pane lost its backend.
        ("disconnected", True, "window-disconnected"),
        # The machine is there; the CLI behind the pane is gone.
        ("exited", True, "session-ended"),
        ("error", True, "session-ended"),
        ("stopped", True, "session-ended"),
    ],
)
def test_an_offline_row_names_the_segment_that_is_down(status: str, host_online: bool, reason: str):
    """2026-11-22: a remote pane read host_online=false and the report could not
    say whether the far machine, its window or this machine's link was down."""
    remote_roster.replace([row(status=status, hostOnline=host_online)], local_device_id=LOCAL)
    (pane,) = remote_roster.list_panes()
    view = pane.to_dict()
    assert view["offline"] is True
    assert view["offline_reason"] == reason


def test_a_reachable_row_carries_no_offline_reason():
    remote_roster.replace([row()], local_device_id=LOCAL)
    (pane,) = remote_roster.list_panes()
    assert "offline_reason" not in pane.to_dict()
