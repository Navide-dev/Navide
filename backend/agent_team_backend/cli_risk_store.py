"""Durable observations and user decisions for the CLI risk projection."""

from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone

from .cli_risk_observers import DNS_TTL, MIB100, DiskSample, ExpectedAddresses
from .cli_risk_ranges import SharedRangeStore
from .db import Database
from .ui_settings import UiSettingsStore


def iso(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def identity(*parts: str) -> str:
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:32]


HISTORY_KEEP = 10  # distinct observations kept per network signal


def _brief(process: dict) -> dict:
    return {key: process[key] for key in ("status", "pid", "name") if key in process}


def attribution(old: dict, detail: dict, count: int, now: float) -> dict:
    """Merge one poll's process attribution into a network signal's data.

    A listener that resolved before and is unknown now keeps the earlier
    answer and its time: it is what the process was while observed, and the
    process may simply have exited. ``history`` gets a row only when what was
    seen changes; otherwise the newest row's time moves forward.
    """
    data: dict = {}
    if "local" in detail:
        data["local"] = detail["local"]
    listener = detail.get("listener")
    if listener is not None:
        previous = old.get("listener")
        if listener["status"] != "resolved" and previous and previous.get("status") == "resolved":
            listener = previous
        elif listener["status"] == "resolved":
            listener = {**listener, "observedAt": iso(now)}
        data["listener"] = listener
    row = {"at": iso(now), "connections": count, "local": [_brief(p) for p in data.get("local", [])]}
    if listener is not None:
        row["listener"] = _brief(listener)
    history = list(old.get("history", []))
    if history and {**history[-1], "at": None} == {**row, "at": None}:
        history[-1] = row
    else:
        history = (history + [row])[-HISTORY_KEEP:]
    data["history"] = history
    return data


class CliRiskStore:
    """Record store, called serially by the service's application lock.

    Collector work never mutates these records. Observation application and
    actions share one transaction boundary, so a late sample cannot undo an
    Ignore or Allow. Per-root inventory retains successful absence history.
    """

    def __init__(self, db: Database):
        self.db = db
        self.settings = UiSettingsStore(path=db.path.with_name("ui_settings.json"), db=db)
        self.ranges = SharedRangeStore(db)
        with db.transaction() as cur:
            cur.execute("CREATE TABLE IF NOT EXISTS cli_risk_records ("
                        "category TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, "
                        "PRIMARY KEY(category, key))")
            rows = cur.execute("SELECT category, key, data FROM cli_risk_records").fetchall()
        self.records: dict[str, dict[str, dict]] = {
            "roots": {}, "signals": {}, "availability": {}, "decisions": {}, "attempts": {}, "aliases": {}
        }
        for row in rows:
            self.records[row["category"]][row["key"]] = json.loads(row["data"])
        # A new backend has no current observation, even if the last run did.
        for value in self.records["availability"].values():
            value["status"] = "unknown"

    def _commit(self, changes: dict[str, dict[str, dict]], *, allowed=None, now=0.0):
        with self.db.transaction() as cur:
            for category, entries in changes.items():
                for key, value in entries.items():
                    cur.execute(
                        "INSERT INTO cli_risk_records(category,key,data) VALUES(?,?,?) "
                        "ON CONFLICT(category,key) DO UPDATE SET data=excluded.data",
                        (category, key, json.dumps(value, separators=(",", ":"))),
                    )
            if allowed is not None:
                vendor, ip = allowed
                settings = self.settings.get()
                key = f"agentTeam.cliAllowedHosts.{vendor}"
                values = settings.get(key, [])
                if not isinstance(values, list):
                    values = []
                values = sorted(set(value for value in values if isinstance(value, str)) | {ip})
                if not self.settings.set({key: values}):
                    raise ValueError("allowed-address settings exceed storage limit")
        for category, entries in changes.items():
            self.records[category].update(entries)

    def allowed_hosts(self, vendor: str) -> tuple[str, ...]:
        settings = self.db.kv_get("ui_settings", {})
        values = settings.get(f"agentTeam.cliAllowedHosts.{vendor}", [])
        return tuple(value for value in values if isinstance(value, str)) if isinstance(values, list) else ()

    def _availability(self, kind: str, owner: str, status: str, now: float) -> dict:
        old = self.records["availability"].get(identity(kind, owner), {})
        value = {**old, "status": status, "observedAt": iso(now)}
        if status == "successful":
            value["lastSuccessAt"] = iso(now)
        return value

    def mark_attempts(self, vendors: list[str], now: float):
        self._commit({"attempts": {vendor: {"at": now} for vendor in vendors}})

    def apply_network(self, pane: str, vendor: str, status: str,
                      endpoints: dict[tuple[str, int], int], expected: ExpectedAddresses,
                      now: float, details: dict[tuple[str, int], dict] | None = None):
        availability = self._availability("network", pane, status, now)
        changes: dict[str, dict] = {}
        if status == "successful":
            availability["expectedSetObservedAt"] = iso(expected.observed_at)
            for key, old in self.records["signals"].items():
                if old["kind"] == "network" and old["pane"] == pane:
                    changes[key] = {**old, "active": False}
            for (ip, port), count in endpoints.items():
                key = identity("network", vendor, pane, ip, str(port))
                old = self.records["signals"].get(key, {})
                data = {
                    "id": key, "kind": "network", "severity": "yellow", "vendor": vendor,
                    "scope": "pane", "ip": ip, "port": port, "connections": count,
                    "firstObservedAt": old["data"]["firstObservedAt"] if old.get("active") else iso(now),
                    "lastObservedAt": iso(now), "expectedSetObservedAt": iso(expected.observed_at),
                    "stale": False,
                }
                if details and (ip, port) in details:
                    data.update(attribution(old["data"] if old.get("active") else {},
                                            details[(ip, port)], count, now))
                # Record-only: a shared-CDN address is kept for the dialog but
                # never lights the pill on its own.
                shared = self.ranges.label_for(ip)
                if shared:
                    data["sharedCdn"] = shared
                changes[key] = {"kind": "network", "pane": pane, "vendor": vendor,
                                "target": ip, "active": True, "data": data}
        self._commit({"availability": {identity("network", pane): availability}, "signals": changes})

    def apply_disk(self, vendor: str, root: str, sample: DiskSample, now: float):
        alias_key = identity(vendor, root)
        previous_root = self.records["aliases"].get(alias_key, {}).get("root")
        root = ((sample.root or previous_root) if sample.status == "successful"
                else (previous_root or sample.root)) or root
        root_key = identity(vendor, root)
        availability = self._availability("disk", root_key, sample.status, now)
        updates: dict[str, dict] = {"availability": {identity("disk", root_key): availability},
                                  "aliases": {alias_key: {"root": root}}}
        if sample.status != "successful":
            self._commit(updates)
            return
        previous = self.records["roots"].get(root_key)
        inventory = copy.deepcopy(previous["files"]) if previous else {}
        current = sample.files or {}
        signals: dict[str, dict] = {}
        for key, old in self.records["signals"].items():
            if old["kind"] == "disk" and old["root"] == root_key:
                signals[key] = {**old, "active": False}
        for path, entry in inventory.items():
            if path not in current and entry["present"]:
                entry["present"] = False
                entry["lastAbsentAt"] = iso(now)
                for history in entry["flagged"].values():
                    history["absentAt"] = iso(now)
        for path, observed in current.items():
            entry = inventory.get(path)
            if entry is None:
                entry = {"present": True, "firstSeen": now if previous else None, "flagged": {}}
                inventory[path] = entry
            elif not entry["present"]:
                entry["firstSeen"] = now
            entry["present"] = True
            entry["lastPresentAt"] = iso(now)
            size_class = observed.size // MIB100
            key = identity("disk", vendor, path, str(size_class))
            old = self.records["signals"].get(key, {})
            recent = entry["firstSeen"] is not None and 0 <= now - entry["firstSeen"] <= 86400
            if observed.size <= MIB100 or not observed.opaque or not (recent or old.get("active")):
                continue
            history = entry["flagged"].setdefault(str(size_class), {})
            absent = history.get("absentAt")
            red = bool(absent) or (old.get("active") and old["data"]["severity"] == "red")
            data = {
                "id": key, "kind": "disk", "severity": "red" if red else "yellow", "vendor": vendor,
                "scope": "vendor", "path": path, "bytes": observed.size, "sizeClass": size_class,
                "firstObservedAt": old["data"]["firstObservedAt"] if old.get("active") else iso(now),
                "lastObservedAt": iso(now), "stale": False,
            }
            if absent:
                data["absentObservedAt"] = absent
            signals[key] = {"kind": "disk", "root": root_key, "vendor": vendor,
                            "target": path, "active": True, "data": data}
        updates["signals"] = signals
        updates["roots"] = {root_key: {"vendor": vendor, "root": root, "files": inventory,
                                      "lastSuccessAt": iso(now)}}
        self._commit(updates)

    def action(self, pane: str, vendor: str, signal_id: str, action: str, now: float):
        signal = self.records["signals"].get(signal_id)
        if action not in ("ignore", "allow") or not signal or not signal["active"]:
            raise ValueError("unknown signal or action")
        if signal["vendor"] != vendor or (signal["kind"] == "network" and signal["pane"] != pane):
            raise ValueError("signal does not belong to pane")
        if action == "allow" and signal["kind"] != "network":
            raise ValueError("only a displayed network IP can be allowed")
        key = identity(vendor, signal["kind"], signal["target"])
        self._commit({"decisions": {key: {"action": action}}},
                     allowed=(vendor, signal["target"]) if action == "allow" else None, now=now)

    def snapshot(self) -> dict:
        # Inventories stay in the worker/store; request projection only copies
        # findings and small availability records.
        return copy.deepcopy({category: self.records[category]
                              for category in ("signals", "availability", "decisions", "aliases")})


def project(snapshot: dict, panes: list, now: float) -> dict[str, dict]:
    result: dict[str, dict] = {}
    roots_by_vendor: dict[str, set[str]] = {}
    for pane in panes:
        roots_by_vendor.setdefault(pane.vendor, set()).update(
            identity(pane.vendor, snapshot["aliases"].get(identity(pane.vendor, root), {}).get("root", root))
            for root in pane.roots
        )

    def availability(kind, owner):
        value = snapshot["availability"].get(identity(kind, owner), {})
        status = value.get("status", "unknown")
        if status == "successful":
            age = now - datetime.fromisoformat(value["lastSuccessAt"].replace("Z", "+00:00")).timestamp()
            if age < 0 or age > DNS_TTL:
                status = "unknown"
            if kind == "network" and "expectedSetObservedAt" in value:
                dns_age = now - datetime.fromisoformat(value["expectedSetObservedAt"].replace("Z", "+00:00")).timestamp()
                if not 0 <= dns_age < DNS_TTL:
                    status = "unknown"
        return {"status": status, **({"lastSuccessAt": value["lastSuccessAt"]} if "lastSuccessAt" in value else {})}

    # Signals are never deleted, only made inactive, so the table only grows;
    # filter it once rather than once per pane (that ran on the event loop).
    active = [value for value in snapshot["signals"].values() if value["active"]]
    for pane in panes:
        network = availability("network", pane.pane_id)
        if not pane.hosts:
            network["status"] = "unsupported"
        roots = roots_by_vendor[pane.vendor]
        disks = [availability("disk", root) for root in roots]
        disk = {"status": "successful" if disks and all(d["status"] == "successful" for d in disks)
                else "unknown" if disks else pane.disk_status}
        successes = [d["lastSuccessAt"] for d in disks if "lastSuccessAt" in d]
        if successes:
            disk["lastSuccessAt"] = min(successes)
        signals = []
        for value in active:
            if value["vendor"] != pane.vendor:
                continue
            if value["kind"] == "network" and value["pane"] != pane.pane_id:
                continue
            if value["kind"] == "disk" and value["root"] not in roots:
                continue
            if identity(pane.vendor, value["kind"], value["target"]) in snapshot["decisions"]:
                continue
            data = copy.deepcopy(value["data"])
            data["stale"] = (network if value["kind"] == "network" else disk)["status"] != "successful"
            if data["kind"] == "network" and now - datetime.fromisoformat(data["expectedSetObservedAt"].replace("Z", "+00:00")).timestamp() >= DNS_TTL:
                data["stale"] = True
                network["status"] = "unknown" if pane.hosts else "unsupported"
            signals.append(data)
        signals.sort(key=lambda s: ("sharedCdn" in s, 0 if s["severity"] == "red" else 1, s["firstObservedAt"], s["id"]))
        result[pane.pane_id] = {"signals": signals, "network": network, "disk": disk}
    return result
