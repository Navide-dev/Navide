"""Level x source (x taint) -> allow / ask / deny.

Pure and deterministic; the matrix is the approved plan's decision table
(Phase 0 decisions recorded in GUARD-CONTRACT.md):

| source \\ level           | critical | high             | normal |
|--------------------------|----------|------------------|--------|
| local                    | ask      | allow (+audit)   | allow  |
| relay (chat approval)    | deny     | deny (need local)| allow  |
| remote / agent           | ask      | allow (+audit)   | allow  |
| tainted pane, any source | ask      | ask              | allow  |

Relay wins over taint: a chat approval can never become "ask", because the
person answering is not at the computer. The relay row also holds while the
Guard switch is off (see enforced()). Unparseable commands count as
"high" on a tainted pane; only a whole-command glob allow lowers that
(apply_taint_allow).

The matrix is fixed. What the user edits is the level going into it: a
level per built-in rule (apply_overrides; FLOOR_RULES never below high) and
their own deny / allow patterns (apply_user_rules).
"""

from __future__ import annotations

import fnmatch

from .builtin_rules import FLOOR_RULES, RULES_BY_ID
from .classify import LEVEL_ORDER, single_command

_MATRIX = {
    "local": {"critical": "ask", "high": "allow", "normal": "allow"},
    "relay": {"critical": "deny", "high": "deny", "normal": "allow"},
    "remote": {"critical": "ask", "high": "allow", "normal": "allow"},
    "agent": {"critical": "ask", "high": "allow", "normal": "allow"},
}


def effective_level(level: str, *, parseable: bool, tainted: bool) -> str:
    if tainted and not parseable and LEVEL_ORDER[level] < LEVEL_ORDER["high"]:
        return "high"
    return level


def enforced(enabled: bool, source: str) -> bool:
    """Whether the matrix applies. The Guard switch turns it off everywhere
    except the chat relay: approving a high/critical action from chat always
    needs someone at the computer, whatever the switch says."""
    return enabled or source == "relay"


def decide(level: str, source: str, *, tainted: bool) -> str:
    row = _MATRIX.get(source, _MATRIX["agent"])
    action = row[level]
    if source != "relay" and tainted and level in ("high", "critical"):
        return "ask"
    return action


def rule_level(rule_id: str, overrides: dict[str, str], verdict_level: str) -> tuple[str, str]:
    """(default, effective) level of one rule a verdict reported. A rule the
    table does not know keeps the verdict's level, which errs on the side of
    asking."""
    rule = RULES_BY_ID.get(rule_id)
    if rule is None:
        return verdict_level, verdict_level
    level = overrides.get(rule_id, rule.level)
    if level not in LEVEL_ORDER:
        level = rule.level
    if rule_id in FLOOR_RULES and LEVEL_ORDER[level] < LEVEL_ORDER["high"]:
        level = "high"
    return rule.level, level


def apply_overrides(level: str, rule_ids: tuple[str, ...], overrides: dict[str, str]) -> str:
    """Re-grade a verdict with the user's built-in rule levels: the highest
    effective level among the rules it reported."""
    if not overrides or not any(r in overrides for r in rule_ids):
        return level
    out = "normal"
    for r in rule_ids:
        eff = rule_level(r, overrides, level)[1]
        if LEVEL_ORDER[eff] > LEVEL_ORDER[out]:
            out = eff
    return out


def pattern_matches(pattern: str, subject: str) -> bool:
    """Glob when the pattern has glob characters, otherwise substring."""
    pattern = (pattern or "").strip()
    if not pattern or not subject:
        return False
    if any(ch in pattern for ch in "*?["):
        return fnmatch.fnmatchcase(subject, pattern)
    return pattern in subject


def apply_user_rules(level: str, rule_ids: tuple[str, ...], subject: str, rules: list[dict]) -> tuple[str, tuple[str, ...]]:
    """Deny patterns raise the level to theirs (critical or high; rows from
    before levels existed are critical) and are never undone by an allow;
    allow patterns lower high to normal (never critical — a critical action
    always needs a human)."""
    denies = [r for r in rules if r.get("kind") == "deny" and pattern_matches(r.get("pattern", ""), subject)]
    if denies:
        for r in denies:
            deny_level = r.get("level") if r.get("level") in ("critical", "high") else "critical"
            if LEVEL_ORDER[deny_level] > LEVEL_ORDER[level]:
                level = deny_level
        return level, rule_ids + tuple(f"user-deny:{r.get('id')}" for r in denies)
    if level == "high":
        for r in rules:
            if r.get("kind") == "allow" and pattern_matches(r.get("pattern", ""), subject):
                return "normal", rule_ids + (f"user-allow:{r.get('id')}",)
    return level, rule_ids


def apply_taint_allow(
    graded: str, before: str, after: str, rule_ids: tuple[str, ...], subject: str, rules: list[dict], source: str
) -> tuple[str, tuple[str, ...]]:
    """Lower a high that only taint caused (effective_level raised `before`
    to `after`, and the user's patterns left `graded` as it was) back to
    normal when an allow pattern with glob characters matches the whole
    command, and only when the command is a single simple command
    (classify.single_command). A substring pattern never does, so text slipped
    into a command cannot release what Guard could not analyse; a command
    graded high, or one a deny matched, is never released here; a chat
    approval (relay) stays denied."""
    if source == "relay" or after == before or before != graded or not single_command(subject):
        return after, rule_ids
    for r in rules:
        pattern = (r.get("pattern") or "").strip()
        if r.get("kind") == "allow" and any(ch in pattern for ch in "*?[") and pattern_matches(pattern, subject):
            return "normal", rule_ids + (f"user-allow:{r.get('id')}",)
    return after, rule_ids
