"""Request scheduling and real handler contracts without launching the app."""

import asyncio
import threading
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent_team_backend import app, applog, cli_risk, ws_handlers
from agent_team_backend.cli_risk import CliRiskService, RiskPane
from agent_team_backend.cli_risk_observers import DiskFile, DiskSample, ExpectedAddresses, MIB100
from agent_team_backend.cli_risk_store import CliRiskStore
from agent_team_backend.cli_vendors.registry import risk_runtime_context
from agent_team_backend.db import Database
from agent_team_backend.osplat.cli_network import Connection, NetworkSample


@pytest.fixture
def store(tmp_path):
    db = Database(tmp_path / "navide.db")
    yield CliRiskStore(db)
    db.close()


def pane(pane_id="pane", roots=("/fixture",), hosts=("192.0.2.1",)):
    return RiskPane(pane_id, "test", (10, 11), hosts, roots)


def resolver(now):
    return SimpleNamespace(resolve=AsyncMock(return_value=ExpectedAddresses("successful", frozenset({"192.0.2.1"}), now)))


async def settle(service):
    await asyncio.gather(*(task for task in (service._network_task, service._disk_task) if task is not None))


async def test_request_returns_completed_only_one_flight_and_30_pane_latency(store):
    gate = asyncio.Event()
    disk_release = threading.Event()
    calls = []
    async def network(pids):
        calls.append(tuple(pids))
        await gate.wait()
        return NetworkSample("successful", (Connection(11, "198.51.100.4", 443),))
    def disk(root):
        disk_release.wait(2)
        return DiskSample("successful", {})
    service = CliRiskService(store, clock=lambda: 100, network_collector=network,
                             disk_collector=disk, resolver=resolver(100))
    panes = [pane(str(i)) for i in range(30)]
    try:
        started = time.perf_counter()
        first = service.request(panes)
        elapsed = time.perf_counter() - started
        assert elapsed < 0.1
        assert all(not item["signals"] for item in first.values())
        tasks = service._network_task, service._disk_task
        for _ in range(10):
            service.request(panes)
            await asyncio.sleep(0)
        assert (service._network_task, service._disk_task) == tasks
        gate.set()
        disk_release.set()
        await settle(service)
        result = service.current(panes)
        assert all(item["signals"][0]["ip"] == "198.51.100.4" for item in result.values())
        assert calls == [(10, 11)]  # The MCP/tool descendant belongs to the pane.
        print(f"30-pane completed-state response: {elapsed * 1000:.3f} ms")
    finally:
        gate.set()
        disk_release.set()
        await service.close()


async def test_disk_five_minute_attempt_throttle_including_failure_and_restart(store):
    now = [100.0]
    disk_calls = []
    def disk(root):
        disk_calls.append(root)
        raise PermissionError("fixture")
    service = CliRiskService(store, clock=lambda: now[0], disk_collector=disk)
    unsupported = [pane(hosts=())]
    assert service.request([]) == {}
    assert service._disk_task is None and service._network_task is None
    service.request(unsupported)
    await settle(service)
    now[0] = 399
    service.request(unsupported)
    await settle(service)
    assert len(disk_calls) == 1
    await service.close()
    service = CliRiskService(CliRiskStore(store.db), clock=lambda: now[0], disk_collector=disk)
    service.request(unsupported)
    await settle(service)
    assert len(disk_calls) == 1
    now[0] = 400
    service.request(unsupported)
    await settle(service)
    assert len(disk_calls) == 2
    await service.close()


@pytest.mark.parametrize("expected_status,network_status,signal", [
    ("successful", "successful", True), ("unknown", "successful", False),
    ("successful", "unknown", False), ("successful", "unsupported", False),
])
async def test_positive_negative_unknown_and_unsupported(store, expected_status, network_status, signal):
    known = ExpectedAddresses(expected_status, frozenset({"192.0.2.1"}), 100)
    network = AsyncMock(return_value=NetworkSample(network_status, (
        Connection(10, "192.0.2.1", 443), Connection(11, "198.51.100.1", 8443), Connection(99, "198.51.100.2", 443))))
    service = CliRiskService(store, clock=lambda: 100, network_collector=network,
                             resolver=SimpleNamespace(resolve=AsyncMock(return_value=known)))
    panes = [pane(roots=())]
    service.request(panes)
    await settle(service)
    result = service.current(panes)["pane"]
    assert bool(result["signals"]) is signal
    if signal:
        assert len(result["signals"]) == 1 and result["signals"][0]["ip"] == "198.51.100.1"
    if expected_status == "unknown":
        network.assert_not_called()
    await service.close()


async def test_own_backend_loopback_ports_are_not_unexpected(store, tmp_path):
    """A CLI calling Navide back (hooks, the navide MCP server) is internal:
    the bound port and the discovery-file port are excluded, other loopback
    ports and other addresses still count."""
    applog.backend_port_file().write_text("50410", encoding="utf-8")
    known = ExpectedAddresses("successful", frozenset({"192.0.2.1"}), 100)
    network = AsyncMock(return_value=NetworkSample("successful", (
        Connection(10, "127.0.0.1", 50410), Connection(10, "::1", 50410),
        Connection(11, "127.0.0.1", 64796), Connection(11, "127.0.0.1", 50411),
        Connection(11, "198.51.100.1", 50410))))
    service = CliRiskService(store, clock=lambda: 100, network_collector=network,
                             resolver=SimpleNamespace(resolve=AsyncMock(return_value=known)))
    service.bound_port = 64796
    panes = [pane(roots=())]
    service.request(panes)
    await settle(service)
    flagged = {(signal["ip"], signal["port"]) for signal in service.current(panes)["pane"]["signals"]}
    assert flagged == {("127.0.0.1", 50411), ("198.51.100.1", 50410)}
    await service.close()


async def test_expired_expected_snapshot_during_collection_retains_stale(store):
    store.apply_network("pane", "test", "successful", {("198.51.100.1", 443): 1},
                        ExpectedAddresses("successful", frozenset(), 100), 100)
    service = CliRiskService(store, clock=lambda: 500, resolver=resolver(100),
                             network_collector=AsyncMock(return_value=NetworkSample("successful")))
    service.request([pane(roots=())])
    await settle(service)
    assert service.current([pane(roots=())])["pane"]["signals"][0]["stale"]
    await service.close()


async def test_action_race_inflight_collector_does_not_resurrect(store):
    now = 100
    store.apply_network("pane", "test", "successful", {("198.51.100.1", 443): 1},
                        ExpectedAddresses("successful", frozenset(), now), now)
    gate = asyncio.Event()
    started = asyncio.Event()
    async def network(pids):
        started.set()
        await gate.wait()
        return NetworkSample("successful", (Connection(10, "198.51.100.1", 443),))
    service = CliRiskService(store, clock=lambda: now, resolver=resolver(now), network_collector=network)
    panes = [pane(roots=())]
    current = service.request(panes)
    await started.wait()
    signal_id = current["pane"]["signals"][0]["id"]
    action = await service.action(panes, "pane", signal_id, "ignore")
    assert not action["pane"]["signals"]
    gate.set()
    await settle(service)
    assert not service.current(panes)["pane"]["signals"]
    await service.close()


class FakeSession:
    def __init__(self, terminal):
        self.messages = []
        self.terminals = SimpleNamespace(
            memory_pid_groups=lambda: {"sid": (terminal.pane_id, [10, 11])},
            get=lambda sid: terminal if sid == "sid" else None,
        )
    async def send_json(self, value):
        self.messages.append(value)


@pytest.fixture
def handler_env(tmp_path, monkeypatch, store):
    context = risk_runtime_context({"HOME": str(tmp_path), "USERPROFILE": str(tmp_path)}, tmp_path)
    terminal = SimpleNamespace(agent_key="test", pane_id="backend-pane", risk_context=context)
    spec = SimpleNamespace(key="test", expected_hosts=("192.0.2.1",), network_override_env_vars=(),
                           data_dirs=None)
    monkeypatch.setattr(cli_risk, "vendor", lambda key: spec if key == "test" else None)
    session = FakeSession(terminal)
    monkeypatch.setattr(app, "_PTY_OWNERS", {"sid": session})
    service = CliRiskService(store, clock=lambda: 100, resolver=resolver(100),
                             network_collector=AsyncMock(return_value=NetworkSample("successful")))
    monkeypatch.setattr(app, "cli_risk_service", service)
    return session, service


async def test_handler_resource_cache_schedules_and_delivers_latest_snapshot(handler_env, monkeypatch):
    session, service = handler_env
    monkeypatch.setattr(ws_handlers, "_resource_sweep_lock", asyncio.Lock())
    monkeypatch.setattr(ws_handlers, "_resource_sweep_cache", {"at": time.monotonic(), "payload": {"panes": []}})
    await ws_handlers.terminal_resource_usage(session, "id", "terminal.resource_usage", {})
    assert "backend-pane" in session.messages[-1]["payload"]["cliRisks"]
    await settle(service)
    # Completed state is independent of the still-valid CPU cache.
    await service._apply(service.store.apply_network, "backend-pane", "test", "successful",
                         {("198.51.100.8", 443): 1}, ExpectedAddresses("successful", frozenset(), 100), 100)
    await ws_handlers.terminal_resource_usage(session, "id2", "terminal.resource_usage", {})
    assert session.messages[-1]["payload"]["cliRisks"]["backend-pane"]["signals"][0]["ip"] == "198.51.100.8"
    await service.close()


async def test_handler_action_rejects_foreign_owner_forged_id_and_accepts_exact_signal(handler_env, monkeypatch):
    session, service = handler_env
    await service._apply(service.store.apply_network, "backend-pane", "test", "successful",
                         {("198.51.100.8", 443): 1}, ExpectedAddresses("successful", frozenset(), 100), 100)
    panes = cli_risk.active_panes(session.terminals, app._PTY_OWNERS)
    signal_id = service.current(panes)["backend-pane"]["signals"][0]["id"]
    payload = {"paneId": "backend-pane", "signalId": signal_id, "action": "allow"}
    monkeypatch.setattr(app, "_PTY_OWNERS", {"sid": object()})
    await ws_handlers.terminal_cli_risk_action(session, "id", "terminal.cli_risk_action", payload)
    assert session.messages[-1]["error"]["code"] == "TERMINAL_NOT_OWNED"
    monkeypatch.setattr(app, "_PTY_OWNERS", {"sid": session})
    await ws_handlers.terminal_cli_risk_action(session, "id", "terminal.cli_risk_action", {**payload, "signalId": "/arbitrary"})
    assert session.messages[-1]["error"]["code"] == "BAD_REQUEST"
    await ws_handlers.terminal_cli_risk_action(session, "id", "terminal.cli_risk_action", payload)
    assert session.messages[-1]["payload"]["cliRisks"]["backend-pane"]["signals"] == []
    assert service.store.allowed_hosts("test") == ("198.51.100.8",)
    await service.close()


def test_active_panes_require_live_ownership_and_safe_context(handler_env, monkeypatch):
    session, _ = handler_env
    assert cli_risk.active_panes(session.terminals, {}) == []
    assert cli_risk.active_panes(session.terminals, app._PTY_OWNERS)[0].pids == (10, 11)
    terminal = session.terminals.get("sid")
    terminal.risk_context = None
    result = cli_risk.active_panes(session.terminals, app._PTY_OWNERS)[0]
    assert not result.roots and not result.hosts


async def test_action_during_cpu_collection_cannot_return_old_risk(handler_env, monkeypatch):
    session, service = handler_env
    await service._apply(service.store.apply_network, "backend-pane", "test", "successful",
                         {("198.51.100.8", 443): 1}, ExpectedAddresses("successful", frozenset(), 100), 100)
    # Isolate the response race from collection; the earlier tests drive the
    # real scheduling path with controlled collectors.
    monkeypatch.setattr(service, "request", service.current)
    monkeypatch.setattr(ws_handlers, "_resource_sweep_lock", asyncio.Lock())
    monkeypatch.setattr(ws_handlers, "_resource_sweep_cache", {"at": 0, "payload": None})
    collecting = asyncio.Event()
    release = asyncio.Event()
    async def collect(_session):
        collecting.set()
        await release.wait()
        return {"panes": []}
    monkeypatch.setattr(ws_handlers, "_collect_resource_usage", collect)
    query = asyncio.create_task(ws_handlers.terminal_resource_usage(session, "poll", "terminal.resource_usage", {}))
    await collecting.wait()
    panes = cli_risk.active_panes(session.terminals, app._PTY_OWNERS)
    signal_id = service.current(panes)["backend-pane"]["signals"][0]["id"]
    await service.action(panes, "backend-pane", signal_id, "ignore")
    release.set()
    await query
    assert session.messages[-1]["payload"]["cliRisks"]["backend-pane"]["signals"] == []
    await service.close()


async def test_alternate_relative_and_symlink_root_projects_after_restart(store, tmp_path):
    from agent_team_backend.cli_vendors.registry import vendor

    workspace = tmp_path / "workspace"
    data = tmp_path / "data"
    workspace.mkdir()
    data.mkdir()
    context = risk_runtime_context({"HOME": str(tmp_path), "USERPROFILE": str(tmp_path), "CODEX_HOME": "../data"}, workspace)
    root = str(vendor("codex").data_dirs(context)[0])
    now = [100.0]
    service = CliRiskService(store, clock=lambda: now[0])
    panes = [pane(roots=(root,), hosts=())]
    service.request(panes)
    await settle(service)
    assert service.current(panes)["pane"]["disk"]["status"] == "successful"
    with (data / "new.enc").open("wb") as stream:
        stream.write(b"\xff\x00opaque")
        stream.truncate(150 * 1024 * 1024)
    now[0] = 400
    service.request(panes)
    await settle(service)
    found = service.current(panes)["pane"]["signals"]
    assert found[0]["path"] == str((data / "new.enc").resolve())
    await service.close()
    restart = CliRiskService(CliRiskStore(store.db), clock=lambda: now[0])
    assert restart.current(panes)["pane"]["signals"][0]["stale"]
    alias = tmp_path / "alias"
    try:
        alias.symlink_to(data, target_is_directory=True)
    except OSError as err:
        await restart.close()
        pytest.skip(f"symlinks unavailable: {err}")
    now[0] = 700
    alias_panes = [pane(roots=(str(alias),), hosts=())]
    restart.request(alias_panes)
    await settle(restart)
    assert restart.current(alias_panes)["pane"]["signals"][0]["id"] == found[0]["id"]
    alias.unlink()
    alias.symlink_to(alias, target_is_directory=True)
    now[0] = 1000
    restart.request(alias_panes)
    await settle(restart)
    stale = restart.current(alias_panes)["pane"]["signals"]
    assert stale[0]["id"] == found[0]["id"] and stale[0]["stale"]
    reloaded = CliRiskStore(store.db)
    from agent_team_backend.cli_risk_store import project
    assert project(reloaded.snapshot(), alias_panes, now[0])["pane"]["signals"][0]["stale"]
    await restart.close()


async def test_handler_vendor_wide_disk_action_across_owners_and_homes(handler_env, monkeypatch, tmp_path):
    session, service = handler_env
    home_a, home_b = tmp_path / "a", tmp_path / "b"
    from agent_team_backend.cli_vendors.base import VendorRuntimeContext
    terminals = {
        "sid": SimpleNamespace(agent_key="test", pane_id="backend-pane",
                               risk_context=VendorRuntimeContext(home=home_a, cwd=home_a, env={})),
        "sid-b": SimpleNamespace(agent_key="test", pane_id="other-pane",
                                 risk_context=VendorRuntimeContext(home=home_b, cwd=home_b, env={})),
    }
    spec = SimpleNamespace(key="test", expected_hosts=(), network_override_env_vars=(),
                           data_dirs=lambda ctx: (ctx.home,))
    monkeypatch.setattr(cli_risk, "vendor", lambda key: spec)
    session.terminals = SimpleNamespace(
        memory_pid_groups=lambda: {key: (term.pane_id, [10]) for key, term in terminals.items()},
        get=terminals.get,
    )
    monkeypatch.setattr(app, "_PTY_OWNERS", {"sid": session, "sid-b": object()})
    await service._apply(service.store.apply_disk, "test", str(home_b), DiskSample("successful", {}), 90)
    await service._apply(service.store.apply_disk, "test", str(home_b),
                         DiskSample("successful", {str(home_b / "new"): DiskFile(MIB100 + 1, True)}), 100)
    panes = cli_risk.active_panes(session.terminals, app._PTY_OWNERS)
    signal_id = service.current(panes)["backend-pane"]["signals"][0]["id"]
    payload = {"paneId": "other-pane", "signalId": signal_id, "action": "ignore"}
    await ws_handlers.terminal_cli_risk_action(session, "foreign", "terminal.cli_risk_action", payload)
    assert session.messages[-1]["error"]["code"] == "TERMINAL_NOT_OWNED"
    await service._apply(service.store.apply_disk, "foreign-vendor", str(home_b), DiskSample("successful", {}), 90)
    await service._apply(service.store.apply_disk, "foreign-vendor", str(home_b),
                         DiskSample("successful", {str(home_b / "foreign"): DiskFile(MIB100 + 1, True)}), 100)
    foreign_id = next(key for key, value in service.store.records["signals"].items()
                      if value["vendor"] == "foreign-vendor")
    await ws_handlers.terminal_cli_risk_action(session, "wrong-vendor", "terminal.cli_risk_action",
                                             {**payload, "paneId": "backend-pane", "signalId": foreign_id})
    assert session.messages[-1]["error"]["code"] == "BAD_REQUEST"
    await service._apply(service.store.apply_network, "other-pane", "test", "successful",
                         {("198.51.100.8", 443): 1}, ExpectedAddresses("successful", frozenset(), 100), 100)
    foreign_network_id = next(key for key, value in service.store.records["signals"].items()
                              if value["kind"] == "network")
    await ws_handlers.terminal_cli_risk_action(session, "wrong-network-pane", "terminal.cli_risk_action",
                                             {**payload, "paneId": "backend-pane", "signalId": foreign_network_id})
    assert session.messages[-1]["error"]["code"] == "BAD_REQUEST"
    # Same displayed disk evidence is actionable from the locally owned pane.
    await ws_handlers.terminal_cli_risk_action(session, "local", "terminal.cli_risk_action", {**payload, "paneId": "backend-pane"})
    risks = session.messages[-1]["payload"]["cliRisks"]
    assert risks["backend-pane"]["signals"] == []
    assert all(s["kind"] == "network" for s in risks["other-pane"]["signals"])
    await service.close()


async def test_windows_unsupported_skips_dns(store):
    from agent_team_backend.osplat.cli_network import unsupported
    dns = resolver(100)
    service = CliRiskService(store, clock=lambda: 100, resolver=dns, network_collector=unsupported)
    service.request([pane(roots=())])
    await settle(service)
    dns.resolve.assert_not_called()
    assert service.current([pane(roots=())])["pane"]["network"]["status"] == "unsupported"
    await service.close()


async def test_sweep_cost_stays_flat_with_60_panes_and_10k_history(store):
    """One network sweep over 60 panes with 10,000 historical signals: one
    snapshot per sweep, no rewrite of history, and the snapshot carries only
    active signals. The old path deep-copied the whole table once per pane
    (~18 s of CPU per sweep on a real 10k-signal store)."""
    history = {}
    for i in range(10_000):
        owner = f"dead-{i // 10}" if i < 9_400 else f"live-{i % 60}"
        history[f"h{i}"] = {"kind": "network", "pane": owner, "vendor": "test", "target": f"198.51.100.{i % 250}",
                            "active": False, "data": {"id": f"h{i}", "kind": "network", "severity": "yellow",
                                                      "vendor": "test", "ip": "198.51.100.1", "port": 443,
                                                      "history": [{"at": "x", "connections": 1}] * 10}}
    store._commit({"signals": history})

    async def network(pids):
        return NetworkSample("successful", tuple(Connection(pid, "198.51.100.7", 443) for pid in pids))

    service = CliRiskService(store, clock=lambda: 100, network_collector=network,
                             disk_collector=lambda root: DiskSample("successful", {}), resolver=resolver(100))
    panes = [RiskPane(f"live-{i}", "test", (1000 + i,), ("192.0.2.1",), ()) for i in range(60)]
    snapshots, written = [], []
    original_snapshot, original_commit = store.snapshot, store._commit
    store.snapshot = lambda: snapshots.append(1) or original_snapshot()
    store._commit = lambda changes, **kw: (written.append(len(changes.get("signals", {}))),
                                           original_commit(changes, **kw))[1]
    try:
        started = time.perf_counter()
        service.request(panes)
        await settle(service)
        elapsed = time.perf_counter() - started
    finally:
        await service.close()

    assert len(snapshots) == 1
    assert sum(written) == 60  # one new signal per pane; inactive history untouched
    assert len(service._snapshot["signals"]) == 60
    assert all(len(view["signals"]) == 1 for view in service.current(panes).values())
    assert elapsed < 2.0, f"sweep took {elapsed:.2f}s"
