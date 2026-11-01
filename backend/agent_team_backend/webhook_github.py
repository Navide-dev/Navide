"""GitHub deliveries: the signature, and what of a delivery reaches an agent.

Pure functions. The signature covers the raw body, so it is checked before the
body is parsed, and only X-Hub-Signature-256 counts: the SHA-1 header GitHub
still sends is never looked at.

A delivery is not passed on whole. Issue and pull request bodies, commit
messages and comments are written by anyone who can open one, so an agent gets
a short list of fields. The title stays, and stays attacker-controlled: it goes
through webhook_payload like any other data, and the run is tainted.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

SIGNATURE_HEADER = "x-hub-signature-256"
EVENT_HEADER = "x-github-event"
PING = "ping"
#: Events a trigger may subscribe to. Any other is answered and ignored.
EVENTS = ("push", "pull_request", "issues", "issue_comment", "release", "workflow_run", "check_suite")

_PREFIX = "sha256="
_MAX_FIELD = 300


def signature_valid(secret: str, raw: bytes, header: str) -> bool:
    """Constant-time. A missing or malformed header reaches the same compare,
    so nothing tells those cases from a wrong signature."""
    expected = _PREFIX + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected.encode(), header.encode("utf-8", "replace"))


def _text(value: Any) -> str | int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    return value[:_MAX_FIELD] if isinstance(value, str) else None


def _pick(source: Any, *path: str) -> str | int | None:
    for key in path:
        if not isinstance(source, dict):
            return None
        source = source.get(key)
    return _text(source)


def summary(event: str, body: str) -> str:
    """The fields an agent gets, as JSON text. The subject of the delivery is
    whichever of these objects the event carries."""
    data = json.loads(body)
    subject = next(
        (data[key] for key in ("pull_request", "issue", "release", "workflow_run", "check_suite")
         if isinstance(data.get(key), dict)),
        {},
    )
    fields = {
        "event": _text(event),
        "action": _pick(data, "action"),
        "repository": _pick(data, "repository", "full_name"),
        "ref": _pick(data, "ref"),
        "sender": _pick(data, "sender", "login"),
        "title": _pick(subject, "title") or _pick(subject, "name"),
        "url": _pick(subject, "html_url") or _pick(data, "compare"),
        "number": _pick(subject, "number"),
    }
    return json.dumps({k: v for k, v in fields.items() if v is not None}, ensure_ascii=False)
