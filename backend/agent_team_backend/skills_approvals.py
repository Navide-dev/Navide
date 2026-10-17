"""User approval gate between an agent's skills_install request and the write.

An MCP caller can only file a pending request here; the shared library is
written when the user approves it in the Navide window (the WS decide handler).
Records live in memory and are lost on backend restart, like the previews they
point at.

The same registry carries agent requests to install, update, roll back or
remove a Navide plugin (contract section 6): records with a `plugin-*` kind,
decided only through `plugins.agent_request.decide` with a window-minted
confirmation. Skill records are `kind: "skill"` and behave as before.
"""
from __future__ import annotations

import asyncio
import copy
import threading
import time
import uuid
from typing import Any

from .plugins.agent_tools_contract import APPROVAL_KINDS, PLUGIN_APPROVAL_TTL_S
from .skills_store import SkillsStoreError, SkillValidationError

MAX_FINISHED = 32
TERMINAL = frozenset({"installed", "rejected", "failed", "expired"})
PLUGIN_KINDS = frozenset(APPROVAL_KINDS) - {"skill"}


class SkillApprovalError(SkillsStoreError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ApprovalRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._records: dict[str, dict[str, Any]] = {}

    def _expire(self) -> None:
        """Caller holds the lock."""
        now = time.time()
        for record in self._records.values():
            if record["status"] == "pending" and record["expires_at"] <= now:
                record["status"] = "expired"
        # Only skill records are pruned; plugin requests have no count limit.
        finished = [key for key, value in self._records.items()
                    if value["kind"] == "skill" and value["status"] in TERMINAL]
        for key in finished[:-MAX_FINISHED]:
            self._records.pop(key)

    def request(self, *, owner: str, targets: list[str] | None, preview: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._expire()
            for record in self._records.values():
                if (record["status"] == "rejected" and record["owner"] == owner
                        and record["preview_id"] == preview["preview_id"]):
                    raise SkillApprovalError(
                        "SKILL_APPROVAL_REJECTED", "the user rejected installing this preview"
                    )
                if (record["status"] == "pending" and record["owner"] == owner
                        and record["preview_id"] == preview["preview_id"]
                        and record["expected_digest"] == preview["digest"]):
                    if record["targets"] != targets:
                        raise SkillValidationError(
                            "an approval for this preview is already pending with different targets"
                        )
                    return copy.deepcopy(record)
            approval_id = uuid.uuid4().hex
            self._records[approval_id] = {
                "approval_id": approval_id,
                "kind": "skill",
                "owner": owner,
                "preview_id": preview["preview_id"],
                "expected_digest": preview["digest"],
                "targets": copy.deepcopy(targets),
                "name": preview["name"],
                "source": copy.deepcopy(preview["source"]),
                "digest": preview["digest"],
                "files": copy.deepcopy(preview["files"]),
                "skill_md": preview["skill_md"],
                "warnings": list(preview["warnings"]),
                "expires_at": preview["expires_at"],
                "status": "pending",
                "result": None,
                "error": None,
                "created_at": time.time(),
            }
            return copy.deepcopy(self._records[approval_id])

    def request_plugin(
        self,
        *,
        kind: str,
        requester: dict[str, Any],
        reason: str,
        target: dict[str, Any],
        card: dict[str, Any] | None,
        diff: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """File an agent's plugin request; the same `owner` key returns the pending one."""
        if kind not in PLUGIN_KINDS:
            raise SkillApprovalError("BAD_REQUEST", f"unknown plugin request kind: {kind!r}")
        version = target.get("version") if isinstance(target, dict) else None
        if (not isinstance(target, dict)
                or not all(isinstance(target.get(key), str) and target[key] for key in ("id", "namespace", "name"))
                or (kind != "plugin-remove" and not (isinstance(version, str) and version))):
            raise SkillApprovalError("BAD_REQUEST", "a plugin request needs a target id, namespace, name and version")
        owner = f"{kind}:{target['id']}@{version if kind != 'plugin-remove' else ''}"
        with self._lock:
            self._expire()
            for record in self._records.values():
                if record["status"] == "pending" and record["owner"] == owner:
                    return copy.deepcopy(record)
            approval_id = uuid.uuid4().hex
            created_at = time.time()
            self._records[approval_id] = {
                "approval_id": approval_id,
                "kind": kind,
                "owner": owner,
                "requester": copy.deepcopy(requester),
                # Written by the agent; the approval card labels it as such.
                "reason": reason,
                "target": copy.deepcopy(target),
                "card": copy.deepcopy(card),
                "diff": copy.deepcopy(diff),
                "status": "pending",
                "error": None,
                "created_at": created_at,
                "expires_at": created_at + PLUGIN_APPROVAL_TTL_S,
            }
            return copy.deepcopy(self._records[approval_id])

    def get(self, approval_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._expire()
            record = self._records.get(approval_id)
            return copy.deepcopy(record) if record else None

    def pending(self, *, plugin: bool = False) -> list[dict[str, Any]]:
        """Pending skill requests, or with `plugin` the pending plugin requests."""
        with self._lock:
            self._expire()
            return [copy.deepcopy(r) for r in self._records.values()
                    if r["status"] == "pending" and (r["kind"] != "skill") == plugin]

    def claim(self, approval_id: str, status: str, *, plugin: bool = False) -> dict[str, Any]:
        """Move a pending request to `status`; any other state is refused.

        A skill decision never reaches a plugin request and the other way round.
        """
        prefix = "PLUGIN" if plugin else "SKILL"
        with self._lock:
            self._expire()
            record = self._records.get(approval_id)
            if record is None or (record["kind"] != "skill") != plugin:
                raise SkillApprovalError(f"{prefix}_APPROVAL_NOT_FOUND", "approval request not found")
            if record["status"] != "pending":
                raise SkillApprovalError(
                    f"{prefix}_APPROVAL_NOT_PENDING", f"approval request is already {record['status']}"
                )
            record["status"] = status
            return copy.deepcopy(record)

    def finish(self, approval_id: str, status: str, *, result: Any = None, error: str | None = None) -> None:
        with self._lock:
            record = self._records.get(approval_id)
            if record is not None:
                record.update(status=status, result=copy.deepcopy(result), error=error)

    def _reset_for_test(self) -> None:
        with self._lock:
            self._records.clear()


registry = ApprovalRegistry()


def public(record: dict[str, Any]) -> dict[str, Any]:
    """What the approval dialog shows; the preview token stays in the backend."""
    return {key: value for key, value in record.items() if key not in {"preview_id", "expected_digest"}}


async def wait(approval_id: str, timeout: float) -> dict[str, Any] | None:
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        record = registry.get(approval_id)
        if record is None or record["status"] not in {"pending", "installing"}:
            return record
        if time.monotonic() >= deadline:
            return record
        await asyncio.sleep(0.2)


async def decide(approval_id: str, approve: bool, installer: Any) -> dict[str, Any]:
    """Apply the user's decision; approval counts as shared-root write consent."""
    from . import app, skills_events
    from .ipc import make_event

    record = registry.claim(approval_id, "installing" if approve else "rejected")
    if approve:
        try:
            result = await asyncio.to_thread(
                installer.install, record["preview_id"], record["expected_digest"],
                owner_key=record["owner"], targets=record["targets"], consent=True,
            )
        except Exception as err:  # noqa: BLE001 - never leave a claimed request stuck in "installing"
            registry.finish(approval_id, "failed", error=str(err))
        else:
            registry.finish(approval_id, "installed", result=result)
            if result.get("changed", True):
                await skills_events.notify_skills_changed(result["name"], "installed")
    final = registry.get(approval_id) or record
    await app.broadcast(make_event(
        "skills.install_approval_resolved",
        {"approval_id": approval_id, "status": final["status"], "error": final["error"]},
    ))
    return public(final)


async def decide_plugin(approval_id: str, approve: bool) -> dict[str, Any]:
    """Apply the user's decision on an agent's plugin request.

    Approval moves it to `applying`. The main window then runs prepareInstall ->
    trust dialog -> commitInstall itself and reports `completed` or `failed`
    through `registry.finish`; that wiring comes with the request tools (B2-c).
    """
    from . import app
    from .ipc import make_event

    final = registry.claim(approval_id, "applying" if approve else "rejected", plugin=True)
    await app.broadcast(make_event(
        "plugins.agent_request_resolved",
        {"approval_id": approval_id, "status": final["status"], "error": final["error"]},
    ))
    return final
