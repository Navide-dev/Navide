"""Receiver-side pane authorization: may that remote pane drive this pane?

On one machine this layer does not exist — the trust boundary is "same user,
same machine", so any pane may instruct any pane. Cross-device that implicit
premise is gone: this machine may hold a pane nobody remote should touch (the
one running a production deploy). Connection-level authorization cannot cover
it — device A being allowed to reach device B does not mean every pane of A
should command every pane of B. Two layers, and this is the inner one.

The policy belongs to the *receiver*: it describes who may instruct **me**, is
scoped to a deviceId, and is enforced here. The server only stores it verbatim
and never interprets it, so what arrives here is arbitrary remote-authored
JSON: this module treats every input as hostile, never raises, and answers
only "allow" or "deny".

Policy shape (agreed with Navide-Server, not ours to change)::

    {
      "version": 1,
      "default": "deny",
      "rules": [
        {"from": {"memberId": "<id>|*", "deviceId": "<id>|*"},
         "to":   {"workspace": "<label>|*", "paneName": "<name>|*"},
         "action": "allow"}
      ]
    }

Allow-only rules over a deny-by-default base: no deny rules means no rule
precedence to disambiguate. A device that never configured a policy gets the
empty policy at revision 0 from the server, which denies everything — so
"never set up" and "explicitly locked down" behave identically, by design.

That default is what the *caller* applies to senders from other members. It
does not reach your own machines: the receive path lets a message through
without consulting this module when the sender's memberId is the receiver's
own, because signing one account in on two devices is itself the grant. This
module is unaware of that exemption on purpose — it answers "does this policy
allow this sender", not "should this message be delivered".

This module is pure judgement. It does not fetch or cache the policy (t12),
and it is deliberately not wired into the on-machine delivery path — that path
does not need this layer, and attaching it there would change today's
behaviour. The cross-device receive path (t6) is its caller.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

# The only policy version this build understands. See ``is_allowed`` for why an
# unrecognised version is fail-closed rather than fail-open.
POLICY_VERSION = 1

# A wildcard matches a whole field and nothing less: "*" means "any", while
# "deploy-*" is a literal pane name, not a prefix pattern. Reasons:
#   * workspace labels and pane names are free-form user text and may contain
#     "*", "?" or "[" — glob semantics would silently widen a rule the author
#     wrote as a literal name;
#   * partial patterns reintroduce specificity questions ("who wins, `dep*` or
#     `deploy`?") that the allow-only model exists to avoid;
#   * a two-state field (exact or any) is what a checkbox in the policy editor
#     renders and what a human auditing the policy can verify at a glance.
# The failure mode of the narrower rule is refusal, never over-grant.
WILDCARD = "*"

# Fields are compared exactly, case included. memberId/deviceId are opaque
# machine-issued ids where case-folding could only collide distinct ids;
# workspace/paneName are matched against the *resolved* target's real name, the
# same case-sensitive comparison the on-machine addressing already uses. Case
# insensitivity would only ever widen a grant, which is the wrong direction
# under deny-by-default.
#
# ``remote_roster.devices_named`` matches deviceName case-*insensitively*, and
# the difference is intended rather than an inconsistency to iron out: that
# function only turns a human-typed label into a device to aim at, where being
# too strict costs a "device not found" the sender sees immediately, while this
# one decides whether a remote pane may drive a local one, where being too
# loose is unauthorized execution nobody sees. Ids are exact on both sides.
_FIELDS = (
    ("from", "memberId"),
    ("from", "deviceId"),
    ("to", "workspace"),
    ("to", "paneName"),
)


def is_allowed(
    policy: Any,
    *,
    member_id: str,
    device_id: str,
    workspace: str,
    pane_name: str,
) -> bool:
    """Whether *policy* lets the given source instruct the given local pane.

    *policy* is already-parsed JSON of any shape — the caller does not validate
    it and neither does the server. Anything unreadable denies.

    An unrecognised ``version`` is **fail-closed**. Version bumps in this format
    exist to add *constraints* (the plan reserves the field for time windows,
    command filtering and rate policy), so a build that ignored the fields it
    does not understand would grant exactly what the newer policy meant to take
    away — silent unauthorized execution. Fail-closed costs a visible refusal
    until this machine is updated, which is the same state as a device that
    never configured a policy, and the system already handles that state.
    """
    request = {
        "memberId": member_id,
        "deviceId": device_id,
        "workspace": workspace,
        "paneName": pane_name,
    }
    unattested = [key for key, value in request.items() if not _usable(value)]
    if unattested:
        # A missing identity must not be answered by a "*" rule: "any member"
        # means any *known* member, never an unauthenticated one.
        log.warning("pane policy denies a request with no %s", ", ".join(unattested))
        return False

    if not isinstance(policy, dict):
        log.warning("pane policy is %s, not an object — denying", type(policy).__name__)
        return False

    version = policy.get("version")
    # bool is an int subclass, so `True == 1`; exclude it explicitly.
    if isinstance(version, bool) or version != POLICY_VERSION:
        log.warning("pane policy version %r is not supported — denying", version)
        return False

    rules = policy.get("rules")
    if isinstance(rules, list):
        for index, rule in enumerate(rules):
            if _rule_allows(rule, request, index=index):
                return True
    elif rules is not None:
        log.warning("pane policy rules is %s, not a list — ignoring", type(rules).__name__)

    # Only the exact string opens the fallback: a policy editor writes this
    # field, and every near-miss ("Allow", "yes", true) resolves to deny.
    return policy.get("default") == "allow"


def for_grant(policy: Any, grant_id: str) -> Any:
    """*policy* as it applies to a sender paired through *grant_id*.

    A rule written by approving an organisation machine's knock carries the
    ``grantId`` that machine was paired through. Once that grant is gone the
    rule must not come back to life if the machine is paired again under a
    new one, so rules naming a different grant are left out. A rule with no
    ``grantId`` (written by hand, or for this account's own machines) applies
    as it always did. A sender with no grant at all is held to none of the
    grant-tagged rules.
    """
    if not isinstance(policy, dict) or not isinstance(policy.get("rules"), list):
        return policy
    rules = policy["rules"]
    kept = [
        rule
        for rule in rules
        if not (isinstance(rule, dict) and rule.get("grantId") and rule.get("grantId") != grant_id)
    ]
    if len(kept) == len(rules):
        return policy
    return {**policy, "rules": kept}


def validate(policy: Any) -> str:
    """Why *policy* must not be written, or ``""`` when it may be.

    ``is_allowed`` forgives everything, because what it reads was authored
    elsewhere and one bad rule must not void the rules around it. The *write*
    path is the opposite: what leaves this machine was authored by our own
    editor, the server stores it verbatim without ever interpreting it, and a
    rule this build would later skip is a grant the user believes they made.
    Refusing the write is the only moment anyone can be told about it.
    """
    if not isinstance(policy, dict):
        return "policy must be an object"
    version = policy.get("version")
    if isinstance(version, bool) or version != POLICY_VERSION:
        return f"policy version must be {POLICY_VERSION}"
    if policy.get("default") not in ("deny", "allow"):
        return "policy default must be 'deny' or 'allow'"
    rules = policy.get("rules")
    if not isinstance(rules, list):
        return "policy rules must be a list"
    for index, rule in enumerate(rules):
        if not isinstance(rule, dict):
            return f"rule {index} must be an object"
        if rule.get("action") != "allow":
            return f"rule {index} must have action 'allow'"
        for section, key in _FIELDS:
            block = rule.get(section)
            if not isinstance(block, dict) or not _usable(block.get(key)):
                return f"rule {index} needs a {section}.{key} string"
    return ""


def _usable(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _rule_allows(rule: Any, request: dict[str, str], *, index: int) -> bool:
    """Whether one rule grants the request. A malformed rule is skipped and
    logged, never fatal: the policy is remote-authored, and one bad entry must
    not void the rules around it."""
    if not isinstance(rule, dict):
        return _skip(index, f"is {type(rule).__name__}, not an object")
    if rule.get("action") != "allow":
        return _skip(index, f"has action {rule.get('action')!r}, not 'allow'")

    patterns: dict[str, str] = {}
    for section, key in _FIELDS:
        block = rule.get(section)
        if not isinstance(block, dict):
            return _skip(index, f"has no {section} object")
        value = block.get(key)
        if not _usable(value):
            # Blank is not a matcher: an empty pattern next to an empty request
            # field would otherwise read as a match.
            return _skip(index, f"has no {section}.{key} string")
        patterns[key] = value

    return all(
        pattern == WILDCARD or pattern == request[key] for key, pattern in patterns.items()
    )


def _skip(index: int, reason: str) -> bool:
    log.warning("pane policy rule %d %s — skipping it", index, reason)
    return False
