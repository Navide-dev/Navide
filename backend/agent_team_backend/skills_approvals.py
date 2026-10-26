"""User approval gate between an agent's skills_install request and the write.

An MCP caller can only file a pending request here; the shared library is
written when the user approves it in the Navide window (the WS decide handler).
Records live in memory and are lost on backend restart, like the previews they
point at.

The same registry carries agent requests to install, update, roll back or
remove a Navide plugin (contract section 6): records with a `plugin-*` kind,
decided only through `plugins.agent_request.decide` with a window-minted
confirmation. Skill records are `kind: "skill"` and behave as before.

A skills_set_delivery change that reaches a CLI the skill does not reach yet
is a skill record too, with `action: "delivery"`; narrowing never
files one.
"""
from __future__ import annotations

import asyncio
import copy
import logging
import re
import threading
import time
import uuid
from typing import Any

from .plugins.agent_tools_contract import APPROVAL_KINDS, FORM_APPROVAL_KINDS, FORM_APPROVAL_TTL_S, PLUGIN_APPROVAL_TTL_S
from .plugins.external_content import neutralize_external_text
from .skills_store import SkillsStoreError, SkillValidationError

MAX_FINISHED = 32
# A delivery request has no preview to expire with; it lasts as long as one would.
DELIVERY_APPROVAL_TTL_S = 15 * 60
TERMINAL = frozenset({"installed", "rejected", "failed", "expired"})
PLUGIN_KINDS = frozenset(APPROVAL_KINDS) - {"skill"} - frozenset(FORM_APPROVAL_KINDS)
_REQUESTER_KEYS = frozenset({"paneId", "paneName", "workspace", "callerKind"})

log = logging.getLogger(__name__)


def _agent_text(value: str) -> str:
    """Text an agent wrote, as the approval card shows it: the external-content
    treatment (``neutralize_external_text``: Cc except tab and LF, bidi,
    zero-width and line or paragraph separators removed, NFKC, boundary lines
    and markers broken). No length limit."""
    return neutralize_external_text(value)


def _disabled_by(value: Any) -> dict[str, Any]:
    """Who disabled the package, as a plugin-enable card shows it; unknown reads as the user."""
    if not isinstance(value, dict) or value.get("by") not in {"user", "agent"}:
        return {"by": "user", "at": None, "agent": None}
    at = value.get("at")
    at = float(at) if isinstance(at, (int, float)) and not isinstance(at, bool) else None
    agent = value.get("agent")
    if value["by"] != "agent" or not isinstance(agent, dict) or agent.get("callerKind") not in {"pane", "external", "host"}:
        return {"by": value["by"], "at": at, "agent": None} if value["by"] == "user" else {"by": "user", "at": at, "agent": None}
    text = {key: (_agent_text(agent[key]) if isinstance(agent.get(key), str) else None) for key in ("paneId", "paneName")}
    return {"by": "agent", "at": at, "agent": {"callerKind": agent["callerKind"], **text}}


def _plugin_requester(requester: Any) -> dict[str, Any]:
    if not isinstance(requester, dict) or set(requester) - {"tainted"} != _REQUESTER_KEYS:
        raise SkillApprovalError("BAD_REQUEST", "the requester must name paneId, paneName, workspace and callerKind")
    if requester["callerKind"] not in {"pane", "external", "host"}:
        raise SkillApprovalError("BAD_REQUEST", "unknown requester callerKind")
    cleaned: dict[str, Any] = {"callerKind": requester["callerKind"]}
    for key in ("paneId", "paneName", "workspace"):
        value = requester[key]
        if value is not None and not isinstance(value, str):
            raise SkillApprovalError("BAD_REQUEST", f"requester {key} must be a string or null")
        cleaned[key] = None if value is None else _agent_text(value)
    # S8-M1: present only for a tainted pane, so a clean request keeps its shape.
    if requester.get("tainted") is True:
        cleaned["tainted"] = True
    return cleaned


_SHA256_HEX = re.compile(r"[0-9a-f]{64}")
_STAGING_ID = re.compile(r"[0-9a-f]{32}")


def _file_target_ok(target: dict[str, Any]) -> bool:
    """A plugin-install-file target: what the Host staged (W1, S2)."""
    digest = target.get("digest")
    return (
        isinstance(target.get("path"), str) and bool(target["path"])
        and target.get("packageKind") in ("file", "folder")
        and isinstance(target.get("stagingId"), str) and _STAGING_ID.fullmatch(target["stagingId"]) is not None
        # A folder has no single digest: it is loaded in place and may change.
        and (digest is None if target["packageKind"] == "folder" else isinstance(digest, str) and _SHA256_HEX.fullmatch(digest) is not None)
    )


class SkillApprovalError(SkillsStoreError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ApprovalRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._records: dict[str, dict[str, Any]] = {}
        # approval_id -> page-load id of the main window that approved a plugin
        # request and is carrying it out (B2-c); not part of the record shape.
        self._applying_by: dict[str, str] = {}
        # approval_id -> that window, once another window settled the request
        # (recovery): its own late result is still recorded, once.
        self._settled_from: dict[str, str] = {}

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

    def request_delivery(
        self,
        *,
        owner: str,
        skill_id: str,
        name: str,
        real_path: str,
        targets: list[str] | None,
        enabled: bool | None,
        expected_revision: str,
        current: dict[str, Any],
    ) -> dict[str, Any]:
        """File an agent's skills_set_delivery change that widens delivery.

        A skill record with ``action: "delivery"``; install records carry no
        action. ``current`` is the delivery before the change, for the card.
        """
        with self._lock:
            self._expire()
            for record in self._records.values():
                if (record.get("action") != "delivery" or record["owner"] != owner
                        or record["skill_id"] != skill_id or record["expected_revision"] != expected_revision
                        or record["targets"] != targets or record["enabled"] != enabled):
                    continue
                if record["status"] == "rejected":
                    raise SkillApprovalError(
                        "SKILL_APPROVAL_REJECTED", "the user rejected this delivery change"
                    )
                if record["status"] == "pending":
                    return copy.deepcopy(record)
            approval_id = uuid.uuid4().hex
            created_at = time.time()
            self._records[approval_id] = {
                "approval_id": approval_id,
                "kind": "skill",
                "action": "delivery",
                "owner": owner,
                "skill_id": skill_id,
                "name": name,
                "real_path": real_path,
                "targets": copy.deepcopy(targets),
                "enabled": enabled,
                "expected_revision": expected_revision,
                "current": copy.deepcopy(current),
                "expires_at": created_at + DELIVERY_APPROVAL_TTL_S,
                "status": "pending",
                "result": None,
                "error": None,
                "created_at": created_at,
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
        disabled: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """File an agent's plugin request; the same `owner` key returns the pending one."""
        if kind not in PLUGIN_KINDS:
            raise SkillApprovalError("BAD_REQUEST", f"unknown plugin request kind: {kind!r}")
        version = target.get("version") if isinstance(target, dict) else None
        if (not isinstance(target, dict)
                or not all(isinstance(target.get(key), str) and target[key] for key in ("id", "namespace", "name"))
                or (kind != "plugin-remove" and not (isinstance(version, str) and version))):
            raise SkillApprovalError("BAD_REQUEST", "a plugin request needs a target id, namespace, name and version")
        if target["id"] != f"{target['namespace']}.{target['name']}":
            raise SkillApprovalError("BAD_REQUEST", "the target id must be <namespace>.<name>")
        if not isinstance(reason, str):
            raise SkillApprovalError("BAD_REQUEST", "the reason must be a string")
        if kind == "plugin-install-file" and not _file_target_ok(target):
            raise SkillApprovalError(
                "BAD_REQUEST", "a file request needs the staged path, digest, stagingId and package kind",
            )
        requester = _plugin_requester(requester)
        owner = f"{kind}:{target['id']}@{version if kind != 'plugin-remove' else ''}"
        if kind == "plugin-install-file":
            # Two files of one id and version are two requests.
            owner += f"#{target['digest'] or target['path']}"
        with self._lock:
            self._expire()
            for record in self._records.values():
                if record["status"] == "pending" and record["owner"] == owner:
                    # A coalesced card names its first requester; a tainted later one is disclosed too.
                    if requester.get("tainted") is True:
                        record["requester"]["tainted"] = True
                    return copy.deepcopy(record)
            approval_id = uuid.uuid4().hex
            created_at = time.time()
            self._records[approval_id] = {
                "approval_id": approval_id,
                "kind": kind,
                "owner": owner,
                "requester": requester,
                # Written by the agent; the approval card labels it as such.
                "reason": _agent_text(reason),
                "target": copy.deepcopy(target),
                "card": copy.deepcopy(card),
                "diff": copy.deepcopy(diff),
                # plugin-enable: who disabled the package; null for every other kind.
                "disabled": _disabled_by(disabled) if kind == "plugin-enable" else None,
                "status": "pending",
                "error": None,
                "created_at": created_at,
                "expires_at": created_at + PLUGIN_APPROVAL_TTL_S,
            }
            return copy.deepcopy(self._records[approval_id])

    def request_form(
        self,
        *,
        kind: str,
        requester: dict[str, Any],
        reason: str,
        target: dict[str, Any],
        draft: dict[str, Any],
    ) -> dict[str, Any]:
        """File an agent's draft for a main-window form (P4 *_fill).

        Nothing is sent anywhere by filing: the window opens the form with the
        draft, and only the user's Submit moves it to ``applying`` (the same
        decide/finish path as a plugin request). A second draft for the same
        form and target while one is pending replaces that draft and reason.
        """
        if kind not in FORM_APPROVAL_KINDS:
            raise SkillApprovalError("BAD_REQUEST", f"unknown form request kind: {kind!r}")
        if not isinstance(target, dict) or not all(
            isinstance(target.get(key), str) for key in ("id", "namespace", "name")
        ):
            raise SkillApprovalError("BAD_REQUEST", "a form request needs a target id, namespace and name")
        if not isinstance(reason, str):
            raise SkillApprovalError("BAD_REQUEST", "the reason must be a string")
        if not isinstance(draft, dict) or not isinstance(draft.get("fields"), dict):
            raise SkillApprovalError("BAD_REQUEST", "a form request needs draft fields")
        requester = _plugin_requester(requester)
        owner = f"{kind}:{target['id']}@{target.get('version') or ''}"
        with self._lock:
            self._expire()
            for record in self._records.values():
                if record["status"] == "pending" and record["owner"] == owner:
                    record.update(reason=_agent_text(reason), draft=copy.deepcopy(draft), requester=requester)
                    return copy.deepcopy(record)
            approval_id = uuid.uuid4().hex
            created_at = time.time()
            self._records[approval_id] = {
                "approval_id": approval_id,
                "kind": kind,
                "owner": owner,
                "requester": requester,
                "reason": _agent_text(reason),
                "target": {"version": None, "fromVersion": None, **copy.deepcopy(target)},
                "card": None,
                "diff": None,
                "disabled": None,
                # The agent's field values; the form marks each as written by an agent.
                "draft": copy.deepcopy(draft),
                "status": "pending",
                "error": None,
                "created_at": created_at,
                "expires_at": created_at + FORM_APPROVAL_TTL_S,
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

    def plugin_requests(self) -> list[dict[str, Any]]:
        """Plugin requests still open: pending, and applying (approved, being carried out)."""
        with self._lock:
            self._expire()
            return [copy.deepcopy(r) for r in self._records.values()
                    if r["kind"] != "skill" and r["status"] in {"pending", "applying"}]

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
            if record is not None and record["kind"] != "skill":
                log.warning("refusing to finish plugin request %s through the skill path", approval_id)
                return
            if record is not None:
                record.update(status=status, result=copy.deepcopy(result), error=error)

    def set_applying_by(self, approval_id: str, window_id: str) -> None:
        with self._lock:
            if window_id:
                self._applying_by[approval_id] = window_id

    def applying_by(self, approval_id: str) -> str:
        """The page-load id of the main window carrying out an approved request, or ""."""
        with self._lock:
            return self._applying_by.get(approval_id, "")

    def finish_plugin(
        self, approval_id: str, status: str, *, error: str | None = None, window_id: str = ""
    ) -> dict[str, Any]:
        """End an approved plugin request: only applying -> completed | failed.

        When another window settled the request (recovery, review-370 R2) and
        the window that was carrying it out reports afterwards, its result is
        what actually happened: the record takes it, marked ``finished_late``,
        and keeps what recovery had said under ``settled``. Once only.
        """
        with self._lock:
            record = self._records.get(approval_id)
            if record is None or record["kind"] == "skill":
                raise SkillApprovalError("PLUGIN_APPROVAL_NOT_FOUND", "approval request not found")
            if (
                window_id and status in {"completed", "failed"}
                and record["status"] in {"completed", "failed"}
                and self._settled_from.get(approval_id) == window_id
            ):
                del self._settled_from[approval_id]
                record["settled"] = {"status": record["status"], "error": record["error"]}
                record.update(status=status, error=error, finished_late=True)
                return copy.deepcopy(record)
            if record["status"] != "applying" or status not in {"completed", "failed"}:
                log.warning("refusing plugin request %s: %s -> %s", approval_id, record["status"], status)
                raise SkillApprovalError(
                    "PLUGIN_APPROVAL_NOT_APPLYING",
                    f"approval request is {record['status']}; only applying ends as completed or failed",
                )
            record.update(status=status, error=error)
            holder = self._applying_by.pop(approval_id, None)
            if holder and window_id != holder:
                # Settled by another window: the holder may still report what it did.
                self._settled_from[approval_id] = holder
            return copy.deepcopy(record)

    def _reset_for_test(self) -> None:
        with self._lock:
            self._records.clear()
            self._applying_by.clear()
            self._settled_from.clear()


registry = ApprovalRegistry()


def public(record: dict[str, Any]) -> dict[str, Any]:
    """What the approval dialog shows; the preview token stays in the backend."""
    return {key: value for key, value in record.items()
            if key not in {"preview_id", "expected_digest", "expected_revision"}}


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
    """Apply the user's decision; approving an install counts as shared-root write consent.

    A delivery request is applied with the revision the agent saw, so a change
    made since then fails instead of overwriting it.
    """
    from . import app, skills_events
    from .ipc import make_event

    record = registry.claim(approval_id, "installing" if approve else "rejected")
    if approve and record.get("action") == "delivery":
        try:
            result = await asyncio.to_thread(
                app.skills_store.set_delivery,
                name="" if record["real_path"] else record["name"], real_path=record["real_path"],
                targets=record["targets"], expected_revision=record["expected_revision"],
                enabled=record["enabled"],
            )
        except Exception as err:  # noqa: BLE001 - never leave a claimed request stuck in "installing"
            registry.finish(approval_id, "failed", error=str(err))
        else:
            registry.finish(approval_id, "installed", result=result)
            if result["changed"]:
                await skills_events.notify_skills_changed(result["name"], "delivery_changed")
    elif approve:
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


async def decide_plugin(approval_id: str, approve: bool, *, window_id: str = "") -> dict[str, Any]:
    """Apply the user's decision on an agent's plugin request.

    Approval moves it to `applying`. The main window then runs prepareInstall ->
    trust dialog -> commitInstall itself and reports `completed` or `failed`
    through `registry.finish_plugin`; that wiring comes with the request tools
    (B2-c). An `applying` record does not expire; B2-c recovers the ones left
    when the app restarts.
    """
    from . import app
    from .ipc import make_event

    final = registry.claim(approval_id, "applying" if approve else "rejected", plugin=True)
    if approve:
        # Recovery after a reload leaves alone what a still-open window is applying.
        registry.set_applying_by(approval_id, window_id)
    await app.broadcast(make_event(
        "plugins.agent_request_resolved",
        {"approval_id": approval_id, "status": final["status"], "error": final["error"]},
    ))
    return final
