"""Persistence and successful observation transitions, with disposable SQLite."""

import pytest

from agent_team_backend.cli_risk import RiskPane
from agent_team_backend.cli_risk_observers import DiskFile, DiskSample, ExpectedAddresses, MIB100
from agent_team_backend.cli_risk_store import CliRiskStore, iso, project
from agent_team_backend.db import Database


@pytest.fixture
def store(tmp_path):
    db = Database(tmp_path / "navide.db")
    yield CliRiskStore(db)
    db.close()


def pane(root="/fixture", pane_id="pane", vendor="test"):
    return RiskPane(pane_id, vendor, (10,), ("192.0.2.1",), (root,))


def signals(store, now=100, panes=None):
    return project(store.snapshot(), panes or [pane()], now)["pane"]["signals"]


def disk(store, files, now, root="/fixture", vendor="test"):
    store.apply_disk(vendor, root, DiskSample("successful", files), now)


def network(store, now=100, endpoints=None, pane_id="pane", vendor="test"):
    store.apply_network(pane_id, vendor, "successful", endpoints if endpoints is not None else {("198.51.100.2", 443): 2},
                        ExpectedAddresses("successful", frozenset({"192.0.2.1"}), now), now)


def test_baseline_excludes_preexisting_and_new_root(store):
    opaque = DiskFile(150 * 1024 * 1024, True)
    disk(store, {"/fixture/old": opaque}, 100)
    disk(store, {"/fixture/old": opaque}, 200)
    disk(store, {"/other/old": opaque}, 200, root="/other")
    assert not signals(store, 200)
    assert not signals(store, 200, [pane("/other")])
    disk(store, {"/fixture/old": opaque, "/fixture/new": opaque}, 300)
    assert [s["path"] for s in signals(store, 300)] == ["/fixture/new"]


def test_present_unknown_absent_rebirth_same_bucket_persists(store):
    path = "/fixture/new.enc"
    disk(store, {}, 100)
    disk(store, {path: DiskFile(150 * 1024 * 1024, True)}, 200)
    assert signals(store, 200)[0]["severity"] == "yellow"
    store.apply_disk("test", "/fixture", DiskSample("unknown"), 300)
    assert signals(store, 300)[0]["stale"]
    disk(store, {path: DiskFile(151 * 1024 * 1024, True)}, 400)
    assert signals(store, 400)[0]["severity"] == "yellow"
    disk(store, {}, 500)
    assert not signals(store, 500)
    restarted = CliRiskStore(store.db)
    disk(restarted, {path: DiskFile(199 * 1024 * 1024, True)}, 600)
    result = signals(restarted, 600)[0]
    assert result["severity"] == "red"
    assert result["absentObservedAt"] == iso(500)
    assert result["sizeClass"] == 1


def test_different_size_bucket_and_replacement_without_absence_stay_yellow(store):
    path = "/fixture/new"
    disk(store, {}, 100)
    disk(store, {path: DiskFile(MIB100 + 1, True)}, 200)
    disk(store, {path: DiskFile(2 * MIB100 - 1, True)}, 300)
    assert signals(store, 300)[0]["severity"] == "yellow"
    disk(store, {}, 400)
    disk(store, {path: DiskFile(2 * MIB100, True)}, 500)
    assert signals(store, 500)[0]["severity"] == "yellow"


def test_24h_window_is_first_observation_not_mtime_or_late_growth(store):
    disk(store, {}, 100)
    disk(store, {"/fixture/file": DiskFile(1, False)}, 200)
    disk(store, {"/fixture/file": DiskFile(MIB100 + 1, True)}, 200 + 86401)
    assert not signals(store, 200 + 86401)


def test_recognized_or_small_files_not_candidates(store):
    disk(store, {}, 100)
    disk(store, {"/fixture/recognized": DiskFile(MIB100 + 1, False),
                 "/fixture/exact": DiskFile(MIB100, True)}, 200)
    assert not signals(store, 200)


def test_network_successful_absence_resets_first_seen_and_unknown_retains(store):
    network(store)
    network(store, 150)
    assert signals(store, 150)[0]["firstObservedAt"] == iso(100)
    store.apply_network("pane", "test", "unknown", {}, ExpectedAddresses("unknown"), 160)
    result = project(store.snapshot(), [pane()], 160)["pane"]
    assert result["signals"][0]["stale"]
    assert result["network"] == {"status": "unknown", "lastSuccessAt": iso(150)}
    network(store, 200, {})
    assert not signals(store, 200)
    network(store, 300)
    assert signals(store, 300)[0]["firstObservedAt"] == iso(300)
    assert signals(CliRiskStore(store.db), 301)[0]["stale"]


@pytest.mark.parametrize("action", ["ignore", "allow"])
def test_exact_ip_action_all_ports_all_vendor_panes_and_restart(store, action):
    network(store)
    network(store, pane_id="other", endpoints={("198.51.100.2", 8443): 1, ("198.51.100.3", 443): 1})
    network(store, pane_id="foreign", vendor="different")
    signal = signals(store)[0]
    store.action("pane", "test", signal["id"], action, 101)
    # A late collector after Ignore/Allow cannot resurrect the finding.
    network(store, 102)
    panes = [pane(), pane(pane_id="other"), pane(pane_id="foreign", vendor="different")]
    view = project(CliRiskStore(store.db).snapshot(), panes, 102)
    assert view["pane"]["signals"] == []
    assert [s["ip"] for s in view["other"]["signals"]] == ["198.51.100.3"]
    assert len(view["foreign"]["signals"]) == 1
    assert store.allowed_hosts("test") == (("198.51.100.2",) if action == "allow" else ())


def test_disk_ignore_path_covers_other_size_classes(store):
    disk(store, {}, 100)
    disk(store, {"/fixture/new": DiskFile(MIB100 + 1, True)}, 200)
    signal = signals(store, 200)[0]
    with pytest.raises(ValueError):
        store.action("pane", "test", signal["id"], "allow", 201)
    store.action("pane", "test", signal["id"], "ignore", 201)
    disk(store, {"/fixture/new": DiskFile(2 * MIB100 + 1, True)}, 202)
    assert not signals(store, 202)


def test_red_first_stable_order_and_expired_dns_stale(store):
    disk(store, {}, 100)
    disk(store, {"/fixture/new": DiskFile(MIB100 + 1, True)}, 110)
    network(store, 120)
    disk(store, {}, 130)
    disk(store, {"/fixture/new": DiskFile(MIB100 + 1, True)}, 140)
    assert [s["severity"] for s in signals(store, 140)] == ["red", "yellow"]
    assert all(s["stale"] for s in signals(store, 1000))


@pytest.mark.parametrize("bad", [("wrong-pane", "test", "ignore"), ("pane", "wrong-vendor", "allow"), ("pane", "test", "delete")])
def test_store_rejects_unowned_or_invalid_actions(store, bad):
    network(store)
    with pytest.raises(ValueError):
        store.action(bad[0], bad[1], signals(store)[0]["id"], bad[2], 101)
    with pytest.raises(ValueError):
        store.action("pane", "test", "/arbitrary/path", "ignore", 101)


def test_allow_and_unrelated_settings_merge_share_transaction(store, monkeypatch):
    import concurrent.futures
    import json
    import threading
    from agent_team_backend.ui_settings import UiSettingsStore

    network(store)
    signal_id = signals(store)[0]["id"]
    ui = UiSettingsStore(path=store.db.path.with_name("ui_settings.json"), db=store.db)
    read_started, release, action_started, action_finished = (threading.Event() for _ in range(4))
    original_get = ui.get
    def held_get():
        result = original_get()
        read_started.set()
        release.wait(2)
        return result
    monkeypatch.setattr(ui, "get", held_get)
    def allow():
        action_started.set()
        store.action("pane", "test", signal_id, "allow", 101)
        action_finished.set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        write = pool.submit(ui.set, {"appearance": "dark"})
        assert read_started.wait(1)
        action = pool.submit(allow)
        assert action_started.wait(1)
        try:
            assert not action_finished.wait(0.05), "Allow must wait for the earlier settings RMW"
        finally:
            release.set()
        write.result(2)
        action.result(2)
    persisted = store.db.kv_get("ui_settings")
    assert persisted["appearance"] == "dark"
    assert persisted["agentTeam.cliAllowedHosts.test"] == ["198.51.100.2"]
    assert json.loads(store.db.path.with_name("ui_settings.json").read_text()) == persisted


def test_empty_network_sample_becomes_unknown_when_expected_set_expires(store):
    store.apply_network("pane", "test", "successful", {},
                        ExpectedAddresses("successful", frozenset({"192.0.2.1"}), 100), 350)
    state = project(store.snapshot(), [pane()], 401)["pane"]
    assert state["signals"] == []
    assert state["network"] == {"status": "unknown", "lastSuccessAt": iso(350)}


def test_projection_walks_the_signal_table_once_however_many_panes(store):
    """Signals are never deleted, only made inactive, so the table grows for
    the app's lifetime. Walking all of it once per pane stalled the event loop
    for seconds with dozens of panes; it is filtered once per projection."""
    network(store, 100, pane_id="pane")
    network(store, 100, {("198.51.100.9", 443): 2}, pane_id="other")
    network(store, 150, {}, pane_id="other")  # now inactive, still recorded
    snap = store.snapshot()
    reads = []

    class CountingSignals(dict):
        def values(self):
            reads.append(1)
            return super().values()

    counted = {**snap, "signals": CountingSignals(snap["signals"])}
    panes = [pane(pane_id="pane"), pane(pane_id="other"), *(pane(pane_id=f"p{i}") for i in range(30))]

    assert project(counted, panes, 160) == project(snap, panes, 160)
    assert len(reads) == 1
    result = project(snap, panes, 160)
    assert len(result["pane"]["signals"]) == 1
    assert result["other"]["signals"] == []
