"""WS request handlers for ``guard.*`` (registered at the end of ws_handlers.py).

Renderer-only control surface. These are ws request types, not renderer UI
actions, so MCP ``ui_invoke`` (which only forwards ``ui.*`` actions to a
window) cannot reach them — an agent must never be able to switch the guard
off, loosen rules, or clear its own taint mark.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any

from .. import confirm_token
from ..ipc import make_error, make_response
from . import policy, runtime, taint, terminal_policy
from .builtin_rules import BUILTIN_RULES, FLOOR_RULES, LEVELS, RULES_BY_ID
from .classify import LEVEL_ORDER, classify
from .engine import HOOK_SUPPORT

if TYPE_CHECKING:
    from ..app import Session

log = logging.getLogger(__name__)

MESSAGE_TYPES = (
    "guard.status", "guard.set_enabled", "guard.rules.list", "guard.rules.add", "guard.rules.remove",
    "guard.audit.list", "guard.taint.list", "guard.taint.events", "guard.taint.clear", "guard.test",
    "guard.terminal.get", "guard.terminal.set_category", "guard.terminal.add_pattern",
    "guard.terminal.remove_pattern", "guard.terminal.test",
    "guard.builtin.get", "guard.builtin.set_level", "guard.branches.add", "guard.branches.remove",
)


class ConfirmationRequired(Exception):
    """A change that loosens Guard or terminal command protection arrived
    without a live confirmation from the main process (see confirm_token)."""


def _require_confirm(msg_type: str, payload: dict, subject: str) -> None:
    """Loosening Guard or terminal command protection is a trust change: only
    a person's window can mint the confirmation, so MCP and the plugin broker
    — which reach these handlers over the same socket — cannot."""
    reason = confirm_token.check(payload.get("confirm"), action=msg_type, device_id="", subject=subject)
    if reason:
        raise ConfirmationRequired(reason)


def _terminal_state() -> dict[str, Any]:
    store = runtime.store()
    settings = store.terminal_settings()
    return {
        "ok": True,
        "categories": [
            {"id": c.id, "description": c.description, "example": c.example,
             "enabled": c.id not in settings.disabled, "default_enabled": c.id not in terminal_policy.DEFAULT_OFF}
            for c in terminal_policy.CATEGORIES
        ],
        "patterns": [{"id": r["id"], "kind": r["kind"], "pattern": r["pattern"]} for r in store.terminal_patterns()],
    }


def _terminal(msg_type: str, payload: dict) -> dict[str, Any]:
    store = runtime.store()
    if msg_type == "guard.terminal.get":
        return _terminal_state()
    if msg_type == "guard.terminal.set_category":
        category = str(payload.get("id") or "")
        if not isinstance(payload.get("enabled"), bool):
            raise ValueError("enabled must be a boolean")
        if category not in terminal_policy.CATEGORY_IDS:
            raise ValueError(f"unknown category: {category}")
        if not payload["enabled"]:
            _require_confirm(msg_type, payload, f"{category}:off")
        store.terminal_set_category(category, payload["enabled"])
        return _terminal_state()
    if msg_type == "guard.terminal.add_pattern":
        kind = str(payload.get("kind") or "")
        pattern = str(payload.get("pattern") or "").strip()
        if kind not in ("block", "allow"):
            raise ValueError("kind must be 'block' or 'allow'")
        problem = terminal_policy.validate_pattern(pattern)
        if problem:
            raise ValueError(problem)
        if kind == "allow":
            _require_confirm(msg_type, payload, f"allow:{pattern}")
        store.terminal_add_pattern(kind, pattern)
        return _terminal_state()
    if msg_type == "guard.terminal.remove_pattern":
        try:
            pattern_id = int(payload.get("id"))
        except (TypeError, ValueError):
            raise ValueError("id must be an integer") from None
        row = store.terminal_pattern(pattern_id)
        if row is None:
            raise ValueError("no such pattern")
        if row["kind"] == "block":
            _require_confirm(msg_type, payload, str(pattern_id))
        store.terminal_remove_pattern(pattern_id)
        return _terminal_state()
    if msg_type == "guard.terminal.test":
        # The very function every enforcement path calls, minus the audit row
        # and the notice: what this box says is what enforcement does.
        workspace = str(payload.get("workspace") or "")
        refusal = terminal_policy.check_with_store(str(payload.get("command") or ""), workspace=workspace)
        return {"ok": True, "refused": refusal is not None, "refusal": refusal.as_dict() if refusal else None}
    return {"ok": False, "error": f"unknown request {msg_type}"}
_SOURCES = ("local", "relay", "remote", "agent")


def _builtin_state() -> dict[str, Any]:
    store = runtime.store()
    overrides = store.rule_overrides()
    return {
        "ok": True,
        "rules": [
            {"id": r.id, "group": r.group, "description": r.description, "example": r.example,
             "default_level": r.level, "level": policy.rule_level(r.id, overrides, r.level)[1],
             "floor": r.id in FLOOR_RULES}
            for r in BUILTIN_RULES
        ],
        "protected_branches": sorted(store.protected_branches()),
    }


def _builtin(msg_type: str, payload: dict) -> dict[str, Any]:
    """Built-in rule levels and the protected-branch list. Tightening is free;
    lowering a rule or dropping a branch needs the main process's token."""
    store = runtime.store()
    if msg_type == "guard.builtin.get":
        return _builtin_state()
    if msg_type == "guard.builtin.set_level":
        rule_id = str(payload.get("id") or "")
        level = str(payload.get("level") or "")
        if rule_id not in RULES_BY_ID:
            raise ValueError(f"unknown rule: {rule_id}")
        if level not in LEVELS:
            raise ValueError("level must be 'critical', 'high' or 'normal'")
        if rule_id in FLOOR_RULES and level == "normal":
            raise ValueError(f"{rule_id} can be lowered to high at most")
        current = policy.rule_level(rule_id, store.rule_overrides(), RULES_BY_ID[rule_id].level)[1]
        if LEVEL_ORDER[level] < LEVEL_ORDER[current]:
            _require_confirm(msg_type, payload, f"{rule_id}:{level}")
        store.set_rule_level(rule_id, level)
        return _builtin_state()
    if msg_type == "guard.branches.add":
        store.add_protected_branch(str(payload.get("name") or ""))
        return _builtin_state()
    if msg_type == "guard.branches.remove":
        name = str(payload.get("name") or "")
        if name not in store.protected_branches():
            raise ValueError("no such branch")
        _require_confirm(msg_type, payload, name)
        store.remove_protected_branch(name)
        return _builtin_state()
    return {"ok": False, "error": f"unknown request {msg_type}"}


def _dispatch(msg_type: str, payload: dict) -> dict[str, Any]:
    store = runtime.store()
    if msg_type == "guard.status":
        return {
            "ok": True,
            "enabled": store.enabled(),
            "counts": store.audit_counts(time.time() - 86400),
            "hook_support": dict(HOOK_SUPPORT),
        }
    if msg_type == "guard.set_enabled":
        if not isinstance(payload.get("enabled"), bool):
            raise ValueError("enabled must be a boolean")
        store.set_enabled(payload["enabled"])
        return {"ok": True}
    if msg_type == "guard.rules.list":
        return {"ok": True, "rules": store.rules_list()}
    if msg_type == "guard.rules.add":
        kind = str(payload.get("kind") or "")
        pattern = str(payload.get("pattern") or "").strip()
        level = str(payload.get("level") or "critical")
        if kind not in ("allow", "deny"):
            raise ValueError("kind must be 'allow' or 'deny'")
        if kind == "deny" and level not in ("critical", "high"):
            raise ValueError("level must be 'critical' or 'high'")
        if not pattern:
            raise ValueError("pattern is empty")
        if kind == "allow":
            _require_confirm(msg_type, payload, f"allow:{pattern}")
        store.rules_add(kind, pattern, str(payload.get("note") or ""), level)
        return {"ok": True, "rules": store.rules_list()}
    if msg_type == "guard.rules.remove":
        try:
            rule_id = int(payload.get("id"))
        except (TypeError, ValueError):
            raise ValueError("id must be an integer") from None
        row = store.rule_get(rule_id)
        if row is None:
            raise ValueError("no such rule")
        if row["kind"] == "deny":
            _require_confirm(msg_type, payload, str(rule_id))
        store.rules_remove(rule_id)
        return {"ok": True, "rules": store.rules_list()}
    if msg_type == "guard.audit.list":
        pane_id = payload.get("pane_id")
        return {"ok": True, "entries": store.audit_list(payload.get("limit") or 100,
                                                          str(pane_id) if pane_id else None)}
    if msg_type == "guard.taint.list":
        return {"ok": True, "panes": taint.list_tainted()}
    if msg_type == "guard.taint.events":
        pane_id = str(payload.get("pane_id") or "")
        if not pane_id:
            raise ValueError("pane_id is required")
        return {"ok": True, "events": taint.taint_events(pane_id)}
    if msg_type == "guard.taint.clear":
        pane_id = str(payload.get("pane_id") or "")
        if not pane_id:
            raise ValueError("pane_id is required")
        taint.clear_taint(pane_id)
        return {"ok": True}
    if msg_type == "guard.test":
        return _test(payload)
    if msg_type.startswith("guard.terminal."):
        return _terminal(msg_type, payload)
    if msg_type.startswith(("guard.builtin.", "guard.branches.")):
        return _builtin(msg_type, payload)
    return {"ok": False, "error": f"unknown request {msg_type}"}


def _test(payload: dict) -> dict[str, Any]:
    """Settings "try it" box: the same steps as engine._evaluate, no audit,
    no taint lookup, plus which rules matched and how each was graded."""
    command = str(payload.get("command") or "")
    source = str(payload.get("source") or "local")
    if source not in _SOURCES:
        raise ValueError(f"source must be one of {', '.join(_SOURCES)}")
    tainted = bool(payload.get("tainted"))
    workspace = str(payload.get("workspace") or "")
    store = runtime.store()
    overrides, branches = store.grading()
    verdict = classify("shell", {"command": command}, cwd=workspace, workspace=workspace,
                       protected_branches=branches)
    graded = policy.apply_overrides(verdict.level, verdict.rule_ids, overrides)
    rules = store.rules_list()
    level, rule_ids = policy.apply_user_rules(graded, verdict.rule_ids, command, rules)
    raised = policy.effective_level(level, parseable=verdict.parseable, tainted=tainted)
    level, rule_ids = policy.apply_taint_allow(graded, level, raised, rule_ids, command, rules, source)
    action = policy.decide(level, source, tainted=tainted) if policy.enforced(store.enabled(), source) else "allow"
    matched = []
    for rid, reason in zip(verdict.rule_ids, verdict.reasons):
        default, effective = policy.rule_level(rid, overrides, verdict.level)
        matched.append({"id": rid, "reason": reason, "default_level": default, "level": effective})
    by_id = {str(r["id"]): r for r in rules}
    for rid in rule_ids[len(verdict.rule_ids):]:
        kind, _, num = rid.partition(":")
        row = by_id.get(num, {})
        matched.append({"id": rid, "reason": row.get("pattern", ""), "user": kind,
                        "default_level": graded,
                        "level": "normal" if kind == "user-allow" else row.get("level", "critical")})
    return {
        "ok": True,
        "verdict": {
            "level": verdict.level, "rule_ids": list(verdict.rule_ids),
            "reasons": list(verdict.reasons), "parseable": verdict.parseable,
        },
        "graded_level": graded,
        "matched": matched,
        "decision": {"action": action, "level": level, "rule_ids": list(rule_ids), "tainted": tainted},
    }


async def handle(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    try:
        result = _dispatch(msg_type, payload or {})
    except ConfirmationRequired as exc:
        log.warning("refusing %s: %s", msg_type, exc)
        await session.send_json(make_error(msg_id, msg_type, "CONFIRMATION_REQUIRED", str(exc)))
        return
    except ValueError as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — answer instead of dropping the request
        log.exception("guard: %s failed", msg_type)
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    await session.send_json(make_response(msg_id, msg_type, result))
