"""Request-triggered, nonblocking CLI risk sampling and backend-owned actions."""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import time
from collections import Counter
from dataclasses import dataclass

from . import osplat
from .applog import backend_port_file
from .cli_risk_observers import DISK_TIMEOUT, DNS_TTL, DiskSample, ExpectedAddresses, ExpectedResolver, scan_disk
from .cli_risk_store import CliRiskStore, project
from .cli_vendors.registry import expected_hosts_for_context, vendor

log = logging.getLogger(__name__)
DISK_INTERVAL = 300.0
LOOPBACK = ("127.0.0.1", "::1")
MAX_LOCAL = 8  # pane processes kept per endpoint


def process_dict(info, pid: int) -> dict:
    """``name``/``command`` are None when unknown, never an empty string."""
    return {"pid": pid, "name": getattr(info, "name", None), "command": getattr(info, "command", None)}


def discovered_backend_port() -> int | None:
    """Port in the discovery file the CLI hooks and MCP server connect to.

    Another Navide instance (installed vs dev) may have written it, so it is
    consulted alongside the port this process is bound to.
    """
    try:
        text = backend_port_file().read_text(encoding="utf-8").strip()
        return int(text) if text else None
    except (OSError, ValueError):
        return None


@dataclass(frozen=True)
class RiskPane:
    pane_id: str
    vendor: str
    pids: tuple[int, ...]
    hosts: tuple[str, ...] = ()
    roots: tuple[str, ...] = ()
    disk_status: str = "unsupported"


def active_panes(terminals, owners: dict) -> list[RiskPane]:
    """Reuse the bounded descendant snapshots, including CLI tools and MCP."""
    panes = []
    for session_id, (pane_id, pids) in terminals.memory_pid_groups().items():
        if session_id not in owners:
            continue
        terminal = terminals.get(session_id)
        spec = vendor(terminal.agent_key) if terminal else None
        if spec is None:
            continue
        context = getattr(terminal, "risk_context", None)
        hosts: tuple[str, ...] = ()
        roots: tuple[str, ...] = ()
        disk_status = "unsupported"
        if context is not None:
            hosts = expected_hosts_for_context(spec, context)
            if spec.data_dirs:
                try:
                    declared = spec.data_dirs(context)
                    if len(declared) > 64 or any(not root.is_absolute() for root in declared):
                        disk_status = "unknown"
                    else:
                        roots = tuple(sorted(set(map(str, declared))))
                        disk_status = "unknown" if roots else "unsupported"
                except (OSError, ValueError, TypeError):
                    disk_status = "unknown"
        panes.append(RiskPane(pane_id, spec.key, tuple(pids), hosts, roots, disk_status))
    return panes


class CliRiskService:
    def __init__(self, store: CliRiskStore, *, clock=time.time,
                 network_collector=None, disk_collector=scan_disk, resolver=None,
                 listener_resolver=None, process_describer=None):
        self.store = store
        self.clock = clock
        self.network_collector = network_collector or osplat.collect_cli_connections
        self.listener_resolver = listener_resolver or osplat.resolve_loopback_listeners
        self.process_describer = process_describer or osplat.cli_network.describe_processes
        self.disk_collector = disk_collector
        self.resolver = resolver or ExpectedResolver(clock=clock)
        self.bound_port: int | None = None
        self._snapshot = store.snapshot()
        self._disk_attempts = {key: value["at"] for key, value in store.records["attempts"].items()}
        self._network_task: asyncio.Task | None = None
        self._disk_task: asyncio.Task | None = None
        self._apply_lock = asyncio.Lock()
        self._closed = False

    def request(self, panes: list[RiskPane]) -> dict:
        """Schedule at most one sweep of each kind; return completed state only."""
        result = self.current(panes)
        if self._closed or not panes:
            return result
        if self._network_task is None or self._network_task.done():
            self._network_task = asyncio.create_task(self._network(panes))
        if self._disk_task is None or self._disk_task.done():
            now = self.clock()
            vendors = {pane.vendor for pane in panes if pane.roots}
            due = {key for key in vendors if key not in self._disk_attempts
                   or now - self._disk_attempts[key] >= DISK_INTERVAL}
            if due:
                self._disk_attempts.update({key: now for key in due})
                self._disk_task = asyncio.create_task(self._disk(panes, due, now))
        return result

    def current(self, panes: list[RiskPane]) -> dict:
        return project(self._snapshot, panes, self.clock())

    def _internal_endpoints(self) -> frozenset[tuple[str, int]]:
        """Loopback endpoints of Navide backends: a CLI calling its own host
        (hooks, the navide MCP server) is not an unexpected connection. Only
        these exact ports are excluded, never loopback as a whole."""
        ports = {port for port in (self.bound_port, discovered_backend_port()) if port}
        return frozenset((ip, port) for ip in LOOPBACK for port in ports)

    async def _apply(self, operation, *args):
        await self._apply_all([(operation, *args)])

    async def _apply_all(self, calls: list[tuple]):
        """Apply one sweep's observations in a single worker hop with a single
        snapshot, so a sweep costs one snapshot however many panes it covers."""
        async with self._apply_lock:
            def apply():
                for operation, *args in calls:
                    operation(*args)
                return self.store.snapshot()
            self._snapshot = await asyncio.to_thread(apply)

    async def _network(self, panes: list[RiskPane]):
        try:
            if self.network_collector is osplat.cli_network.unsupported:
                now = self.clock()
                await self._apply_all([(self.store.apply_network, pane.pane_id, pane.vendor,
                                        "unsupported", {}, ExpectedAddresses("unsupported"), now)
                                       for pane in panes])
                return
            supported = [pane for pane in panes if pane.hosts]
            expected_by_profile = {}
            deadline = time.monotonic() + 8.0
            for pane in supported:
                profile = (pane.vendor, pane.hosts)
                if profile not in expected_by_profile:
                    if time.monotonic() >= deadline:
                        expected_by_profile[profile] = ExpectedAddresses("unknown")
                    else:
                        allowed = await asyncio.to_thread(self.store.allowed_hosts, pane.vendor)
                        expected_by_profile[profile] = await self.resolver.resolve(pane.hosts + allowed)
            comparable = [pane for pane in supported
                          if expected_by_profile[(pane.vendor, pane.hosts)].status == "successful"]
            sample = await self.network_collector(sorted({pid for pane in comparable for pid in pane.pids})) if comparable else None
            internal = await asyncio.to_thread(self._internal_endpoints)
            now = self.clock()
            observed = {}
            for pane in panes:
                expected = expected_by_profile.get((pane.vendor, pane.hosts), ExpectedAddresses("unsupported"))
                status = expected.status
                connections = []
                if expected.status == "successful":
                    status = sample.status
                    if expected.observed_at is None or not 0 <= now - expected.observed_at < DNS_TTL:
                        status = "unknown"
                    if status == "successful":
                        connections = [c for c in sample.connections
                                       if c.pid in pane.pids and c.ip not in expected.addresses
                                       and (c.ip, c.port) not in internal]
                observed[pane.pane_id] = (expected, status, connections)
            details = await self._attribute([c for _, _, found in observed.values() for c in found])
            calls = []
            for pane in panes:
                expected, status, connections = observed[pane.pane_id]
                endpoints = Counter((c.ip, c.port) for c in connections)
                calls.append((self.store.apply_network, pane.pane_id, pane.vendor,
                              status, endpoints, expected, now,
                              {key: details(key, connections) for key in endpoints}))
            await self._apply_all(calls)
        except Exception:  # A failed background observation must not break resource responses.
            log.exception("CLI network observation failed")
            now = self.clock()
            await self._apply_all([(self.store.apply_network, pane.pane_id, pane.vendor,
                                    "unknown", {}, ExpectedAddresses("unknown"), now)
                                   for pane in panes])

    async def _attribute(self, connections: list):
        """Who is on each end, captured now because either process can exit
        before anyone looks: the pane processes that opened an endpoint and,
        for a loopback endpoint, the process listening on that port. One
        listener listing and one process read per poll, however many
        connections share a port or a pid."""
        ports = sorted({c.port for c in connections if ipaddress.ip_address(c.ip).is_loopback})
        listeners = {}
        if ports:
            try:
                listeners = await self.listener_resolver(ports)
            except Exception:
                log.exception("CLI loopback listener resolution failed")
        try:
            processes = await asyncio.to_thread(self.process_describer, {c.pid for c in connections})
        except Exception:
            log.exception("CLI process description failed")
            processes = {}

        def details(key, pane_connections):
            ip, port = key
            pids = sorted({c.pid for c in pane_connections if (c.ip, c.port) == key})
            result = {"local": [process_dict(processes.get(pid), pid) for pid in pids[:MAX_LOCAL]]}
            if ipaddress.ip_address(ip).is_loopback:
                listener = listeners.get(port)
                result["listener"] = ({"status": "resolved", **process_dict(listener.process, listener.process.pid)}
                                      if listener is not None and listener.status == "resolved" and listener.process
                                      else {"status": "unknown"})
            return result
        return details

    async def _disk(self, panes: list[RiskPane], due: set[str], attempted: float):
        roots = sorted({(pane.vendor, root) for pane in panes if pane.vendor in due for root in pane.roots})
        try:
            await self._apply(self.store.mark_attempts, sorted(due), attempted)
            deadline = time.monotonic() + DISK_TIMEOUT
            for vendor_key, root in roots:
                try:
                    if time.monotonic() >= deadline:
                        sample = DiskSample("unknown")
                    elif self.disk_collector is scan_disk:
                        sample = await asyncio.to_thread(scan_disk, root, deadline=deadline)
                    else:
                        sample = await asyncio.to_thread(self.disk_collector, root)
                except Exception:
                    sample = DiskSample("unknown")
                await self._apply(self.store.apply_disk, vendor_key, root, sample, self.clock())
        except Exception:
            log.exception("CLI disk observation could not be persisted")

    async def action(self, panes: list[RiskPane], pane_id: str, signal_id: str, action: str) -> dict:
        pane = next((pane for pane in panes if pane.pane_id == pane_id), None)
        state = self.current(panes).get(pane_id, {})
        if pane is None or not any(signal["id"] == signal_id for signal in state.get("signals", [])):
            raise ValueError("unknown current pane signal")
        await self._apply(self.store.action, pane_id, pane.vendor, signal_id, action, self.clock())
        return self.current(panes)

    async def close(self):
        self._closed = True
        tasks = [task for task in (self._network_task, self._disk_task) if task is not None]
        if tasks:
            # Let a running DB transaction settle before the application closes
            # its shared connection. The collectors have bounded work budgets.
            await asyncio.gather(*tasks, return_exceptions=True)
