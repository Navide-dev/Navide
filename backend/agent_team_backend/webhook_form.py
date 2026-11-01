"""The form trigger: a page a person fills in, which starts a run.

A browser cannot carry a Bearer key, so the secret token in the URL is the
permission. That is weaker than a webhook's key: a URL ends up in browser
history and tunnel logs, which is why a form is reachable from this computer
only until it is ticked as public, one form at a time.

Pure functions. Every value that reaches the page is escaped, the page runs no
script and loads nothing, and a POST needs a token this page issued within the
last half hour, so another site cannot submit it on someone's behalf.
"""

from __future__ import annotations

import hashlib
import hmac
import html
import json
import re
from typing import Any
from urllib.parse import parse_qs

FIELD_TYPES = ("text", "textarea", "number", "email", "date", "select", "checkbox")
MAX_FIELDS = 20
MAX_LABEL = 120
MAX_OPTIONS = 50
CSRF_TTL_S = 30 * 60

CONTENT_SECURITY_POLICY = (
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
)

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_STYLE = (
    "body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#1c2024}"
    "h1{font-size:20px}label{display:block;margin:14px 0 4px;font-weight:600}"
    "input:not([type=checkbox]),textarea,select{width:100%;box-sizing:border-box;padding:7px 9px;font:inherit;"
    "border:1px solid #c5c9ce;border-radius:6px}textarea{min-height:110px}"
    "button{margin-top:18px;padding:8px 16px;font:inherit;border:0;border-radius:6px;background:#2f6feb;color:#fff}"
    "p.err{color:#b3261e}@media (prefers-color-scheme:dark){body{background:#14171a;color:#e6e8ea}"
    "input:not([type=checkbox]),textarea,select{background:#1d2125;color:inherit;border-color:#3a4047}}"
)


class FormInvalid(ValueError):
    """A form definition the store refuses."""


class SubmissionInvalid(ValueError):
    """A submission that does not fit its form."""


def normalize_fields(fields: Any) -> list[dict[str, Any]]:
    """The definition as stored: named by position, so a label can be anything."""
    if not isinstance(fields, list) or not 1 <= len(fields) <= MAX_FIELDS:
        raise FormInvalid(f"a form needs 1..{MAX_FIELDS} fields")
    out: list[dict[str, Any]] = []
    for index, field in enumerate(fields):
        kind = field.get("type") if isinstance(field, dict) else None
        label = str(field.get("label") or "").strip() if isinstance(field, dict) else ""
        if kind not in FIELD_TYPES:
            raise FormInvalid(f"unknown field type {kind!r}")
        if not label or len(label) > MAX_LABEL:
            raise FormInvalid("a field needs a label")
        options = [str(o).strip() for o in field.get("options") or [] if str(o).strip()]
        if kind == "select" and not 1 <= len(options) <= MAX_OPTIONS:
            raise FormInvalid(f"a list needs 1..{MAX_OPTIONS} options")
        out.append({
            "name": f"f{index}", "label": label, "type": kind, "required": field.get("required") is True,
            **({"options": options} if kind == "select" else {}),
        })
    return out


def mint_csrf(secret: bytes, trigger_id: str, now: int) -> str:
    stamp = str(now)
    return f"{stamp}.{hmac.new(secret, f'{trigger_id}:{stamp}'.encode(), hashlib.sha256).hexdigest()}"


def csrf_valid(secret: bytes, trigger_id: str, token: str, now: int) -> bool:
    stamp, _, _ = token.partition(".")
    if not stamp.isdigit() or not 0 <= now - int(stamp) <= CSRF_TTL_S:
        return False
    return hmac.compare_digest(mint_csrf(secret, trigger_id, int(stamp)).encode(), token.encode("utf-8", "replace"))


def _input(field: dict[str, Any]) -> str:
    name = html.escape(field["name"], quote=True)
    required = " required" if field["required"] else ""
    if field["type"] == "textarea":
        return f'<textarea id="{name}" name="{name}" maxlength="20000"{required}></textarea>'
    if field["type"] == "select":
        options = "".join(f"<option>{html.escape(o)}</option>" for o in field["options"])
        return f'<select id="{name}" name="{name}"{required}><option value=""></option>{options}</select>'
    return f'<input id="{name}" name="{name}" type="{field["type"]}"{required}>'


def render_page(title: str, fields: list[dict[str, Any]], csrf: str, *, error: str = "") -> bytes:
    rows = "".join(
        f'<label for="{html.escape(f["name"], quote=True)}">{html.escape(f["label"])}</label>{_input(f)}'
        for f in fields
    )
    problem = f'<p class="err">{html.escape(error)}</p>' if error else ""
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{html.escape(title)}</title><style>{_STYLE}</style></head><body>"
        f'<h1>{html.escape(title)}</h1>{problem}<form method="post">'
        f'<input type="hidden" name="_csrf" value="{html.escape(csrf, quote=True)}">{rows}'
        '<button type="submit">Send</button></form></body></html>'
    ).encode()


def render_message(title: str, message: str) -> bytes:
    """A fixed answer: nothing a run produces ever comes back through a form."""
    return (
        f'<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(title)}</title>'
        f"<style>{_STYLE}</style></head><body><h1>{html.escape(title)}</h1><p>{html.escape(message)}</p></body></html>"
    ).encode()


def parse_body(text: str) -> dict[str, str]:
    try:
        parsed = parse_qs(text, keep_blank_values=True, max_num_fields=MAX_FIELDS + 2, strict_parsing=False)
    except ValueError:
        raise SubmissionInvalid("too many fields") from None
    return {key: values[-1] for key, values in parsed.items()}


def _checked(field: dict[str, Any], value: str) -> Any:
    kind = field["type"]
    if kind == "checkbox":
        return value != ""
    if not value:
        if field["required"]:
            raise SubmissionInvalid(f"{field['label']} is required")
        return ""
    if kind == "number":
        try:
            float(value)
        except ValueError:
            raise SubmissionInvalid(f"{field['label']} must be a number") from None
    elif kind == "email" and not _EMAIL.match(value):
        raise SubmissionInvalid(f"{field['label']} must be an email address")
    elif kind == "date" and not _DATE.match(value):
        raise SubmissionInvalid(f"{field['label']} must be a date")
    elif kind == "select" and value not in field["options"]:
        raise SubmissionInvalid(f"{field['label']} is not one of the choices")
    return value


def submission_text(fields: list[dict[str, Any]], values: dict[str, str]) -> str:
    """What the agent gets: the form's own labels and what was entered, and
    nothing a client added beyond the fields the form has."""
    answers = {f["label"]: _checked(f, values.get(f["name"], "")) for f in fields}
    return json.dumps(answers, ensure_ascii=False)
