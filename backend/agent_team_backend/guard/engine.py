"""evaluate(): classify + rule levels + user rules + taint + policy + audit, in one call."""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass

from . import policy, runtime
from .classify import classify
from .taint import is_tainted

log = logging.getLogger(__name__)

EXCERPT_MAX = 300

# Hook support per vendor, per the plan's research table.
HOOK_SUPPORT = {
    v: "block" for v in ("claude", "codex", "copilot", "qwen")
} | {
    v: "none"
    for v in ("cursor", "grok", "kimi", "kilo", "opencode", "pi", "muse", "droid", "aider", "antigravity")
}


@dataclass(frozen=True)
class Decision:
    action: str
    level: str
    rule_ids: tuple[str, ...]
    reason: str
    tainted: bool


_SECRET_PATTERNS = [
    (re.compile(r"\b(sk|pk|rk)-[A-Za-z0-9_\-]{12,}"), "<redacted>"),
    (re.compile(r"\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{12,}"), "<redacted>"),
    (re.compile(r"\bxox[abposr]-[A-Za-z0-9\-]{8,}"), "<redacted>"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "<redacted>"),
    (re.compile(r"\bey[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"), "<redacted>"),
    (re.compile(r"/bot[^/\s\"']+/"), "/bot<redacted>/"),
    (re.compile(r"(?i)(authorization:\s*(bearer|basic|token)\s+)\S+"), r"\1<redacted>"),
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{8,}"), r"\1<redacted>"),
    (re.compile(r"(?i)((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)(['\"]?)[^\s'\"&]+"),
     r"\1\2<redacted>"),
    (re.compile(r"(?i)(--?(?:password|passwd|token|secret|api-key|apikey)(?:=|\s+))(['\"]?)[^\s'\"]+"),
     r"\1\2<redacted>"),
    (re.compile(r"(://[^/\s:@]+:)[^@\s/]+@"), r"\1<redacted>@"),
]


def redact(text: str) -> str:
    for pattern, repl in _SECRET_PATTERNS:
        text = pattern.sub(repl, text)
    return text


def excerpt_of(tool: str, tool_input: dict) -> str:
    raw = tool_input.get("command")
    if isinstance(raw, list):
        raw = " ".join(str(x) for x in raw)
    if not isinstance(raw, str):
        for key in ("file_path", "path", "notebook_path", "text"):
            if isinstance(tool_input.get(key), str):
                raw = tool_input[key]
                break
        else:
            try:
                raw = json.dumps(tool_input, ensure_ascii=False)
            except (TypeError, ValueError):
                raw = str(tool_input)
    text = redact(raw)
    return text if len(text) <= EXCERPT_MAX else text[: EXCERPT_MAX - 1] + "…"


def _reason(action: str, level: str, reasons: tuple[str, ...], source: str, tainted: bool, parseable: bool) -> str:
    what = "; ".join(reasons[:3]) or f"{level} risk"
    if action == "allow":
        return what if level != "normal" else "no dangerous pattern"
    if source == "relay":
        return f"{what} — needs confirmation at the computer, not from chat"
    if tainted:
        why = "this pane received external content"
        if not parseable:
            what = f"{what} (cannot be analysed statically)"
        return f"{what} — {why}; confirm locally"
    return f"{what} — confirm locally"


def evaluate(
    *, pane_id: str, vendor: str, tool: str, tool_input: dict, cwd: str,
    workspace: str, source: str = "local",
) -> Decision:
    try:
        return _evaluate(pane_id=pane_id, vendor=vendor, tool=tool, tool_input=tool_input,
                         cwd=cwd, workspace=workspace, source=source)
    except Exception as err:  # noqa: BLE001
        # Fail mode (Phase 0 decision): relay denies, everything else allows
        # with a visible warning so a guard bug never wedges every CLI.
        log.warning("guard: evaluate failed (%s): %s", source, err, exc_info=True)
        action = "deny" if source == "relay" else "allow"
        reason = f"Navide Guard error, {'denied' if action == 'deny' else 'allowed'}: {err}"
        if source == "relay" or not switched_off():
            _emit_failure(pane_id, reason, action="deny" if action == "deny" else "error")
        return Decision(action, "normal", ("guard-error",), reason, False)


def switched_off() -> bool:
    """Whether the user turned Guard off. A failure that let an action through
    is then not announced: the switch is off, so the notice would read as Guard
    still checking. A switch that cannot be read, or was never read, counts
    as on: this runs on the event loop, so it reads only the in-memory value."""
    try:
        return runtime.enabled_cached() is False
    except Exception:  # noqa: BLE001
        return False


def _emit_failure(pane_id: str, reason: str, *, action: str = "error") -> None:
    """Make a guard error visible in the window: "error" = let through
    undecided (fail-open), "deny" = refused because of it (relay)."""
    try:
        runtime.emit("guard.decision", {
            "pane_id": pane_id, "action": action, "level": "normal", "reason": reason, "excerpt": "",
        })
    except Exception:  # noqa: BLE001 - already failing; the log line above stands
        log.warning("guard: could not report a guard error", exc_info=True)


def _evaluate(*, pane_id, vendor, tool, tool_input, cwd, workspace, source) -> Decision:
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    store = runtime.store()
    overrides, branches = store.grading()
    verdict = classify(tool, tool_input, cwd=cwd, workspace=workspace, protected_branches=branches)
    excerpt = excerpt_of(tool, tool_input)
    graded = policy.apply_overrides(verdict.level, verdict.rule_ids, overrides)
    subject, rules = _subject(tool_input) or excerpt, store.rules_list()
    level, rule_ids = policy.apply_user_rules(graded, verdict.rule_ids, subject, rules)
    tainted = is_tainted(pane_id)
    raised = policy.effective_level(level, parseable=verdict.parseable, tainted=tainted)
    level, rule_ids = policy.apply_taint_allow(graded, level, raised, rule_ids, subject, rules, source)
    enforced = policy.enforced(store.enabled(), source)
    action = policy.decide(level, source, tainted=tainted) if enforced else "allow"
    reason = _reason(action, level, verdict.reasons, source, tainted, verdict.parseable)
    if not enforced and level != "normal":
        reason = f"guard disabled; {reason}"
    decision = Decision(action, level, rule_ids, reason, tainted)
    # Bookkeeping must never overturn the decision: an audit write failing
    # (database is locked) used to raise into evaluate()'s fail-open branch
    # and turn this ask/deny into an allow.
    # A taint raise an allow glob released (level != raised) is audited too.
    if level != "normal" or action != "allow" or level != raised:
        try:
            store.audit_add({
                "ts": time.time(), "pane_id": pane_id or "", "vendor": vendor or "", "source": source,
                "tool": tool or "", "excerpt": excerpt, "level": level, "action": action,
                "rule_ids": rule_ids, "tainted": tainted,
            })
        except Exception:  # noqa: BLE001
            log.warning("guard: audit write failed; decision %s stands", action, exc_info=True)
    if action != "allow":
        try:
            runtime.emit("guard.decision", {
                "pane_id": pane_id, "action": action, "level": level, "reason": reason, "excerpt": excerpt,
            })
        except Exception:  # noqa: BLE001
            log.warning("guard: decision event failed; decision %s stands", action, exc_info=True)
    return decision


def _subject(tool_input: dict) -> str:
    """The string user rules match against: the command, else the path."""
    cmd = tool_input.get("command")
    if isinstance(cmd, list):
        return " ".join(str(x) for x in cmd)
    if isinstance(cmd, str):
        return cmd
    for key in ("file_path", "path", "notebook_path", "text"):
        if isinstance(tool_input.get(key), str):
            return tool_input[key]
    return ""
