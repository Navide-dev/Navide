"""One Shipped Log report: the ledger and the deploy branch's git history, merged.

Every item names its basis: ``agent`` (recorded with ship_log_record),
``branch`` (a first-parent commit of the deploy branch), ``tag`` (a tag
created in the window) or ``hook`` (a deploy command a CLI hook saw an agent
run, still unconfirmed). A commit that arrives from more than one source is one
item, deduplicated by its hash. ``ci`` is reserved for a CI-run source;
nothing produces it yet.

A detected command is only a hint: one that failed, one the user confirmed or
dismissed, and one the same pane recorded with ship_log_record within
CONFIRM_WINDOW_S are left out. The user's own line or sensitive mark
(``ship_override``) replaces the item's, and a ``config`` entry whose ref is a
registered setting carries that setting's label.

A git commit nobody recorded gets its plain-language line by rule: the
conventional-commit prefix is dropped and its type picks the verb (``feat`` →
added, ``fix`` → fixed, anything else → changed). No model is called, so no
commit text leaves the machine.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from agent_team_backend import git_service
from agent_team_backend.plugins.builtin.navide_shipped_log import messages
from agent_team_backend.plugins.builtin.navide_shipped_log.ledger import ShipLogLedger, ledger as _default_ledger

BASES = ("agent", "branch", "tag", "hook", "ci")
#: A recorded entry this close to a detected command, from the same pane,
#: confirms it.
CONFIRM_WINDOW_S = 30 * 60
FORMATS = ("text", "json")
#: The most items one report lists; the count past it is reported.
MAX_ITEMS = 200

_RELATIVE_RE = re.compile(r"^(\d{1,3})\s*([dh])$", re.IGNORECASE)
_TODAY = {"今天", "today", "今日"}
_YESTERDAY = {"昨天", "yesterday", "昨日"}
_CONVENTIONAL_RE = re.compile(r"^(?P<type>[A-Za-z]+)(?:\([^)]*\))?!?:\s*(?P<text>.+)$")
_MERGE_PR_RE = re.compile(r"^Merge pull request #\d+ from \S+$")
_HEX_RE = re.compile(r"^[0-9a-fA-F]{7,64}$")


class WindowError(ValueError):
    """A ``since``/``until`` value that names no moment."""


def _local_now(now: datetime | None) -> datetime:
    # An aware ``now`` already names the zone its calendar day is in; only the
    # real clock (or a naive value) takes this machine's zone.
    if now is not None and now.tzinfo is not None:
        return now
    return (now or datetime.now(timezone.utc)).astimezone()


def parse_moment(value: str, now: datetime | None = None) -> datetime:
    """An ISO 8601 date or date-time; a naive value is local time."""
    text = (value or "").strip()
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as err:
        raise WindowError(f"not an ISO 8601 date or time: {value!r}") from err
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=_local_now(now).tzinfo)
    return moment


def parse_window(since: str, until: str = "", now: datetime | None = None) -> tuple[datetime, datetime | None]:
    """``(start, end)`` for ``今天``/``today``, ``昨天``/``yesterday``, ``7d``/``12h``
    or an ISO 8601 date/time; ``until`` (ISO, optional) overrides the end. End
    None means "up to now"."""
    word = (since or "").strip()
    local = _local_now(now)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    end: datetime | None = None
    if word.lower() in _TODAY:
        start = midnight
    elif word.lower() in _YESTERDAY:
        start, end = midnight - timedelta(days=1), midnight
    elif m := _RELATIVE_RE.match(word):
        amount = int(m.group(1))
        start = local - (timedelta(days=amount) if m.group(2).lower() == "d" else timedelta(hours=amount))
    else:
        start = parse_moment(word, now)
    if (until or "").strip():
        end = parse_moment(until, now)
    if end is not None and end <= start:
        raise WindowError("until must be later than since")
    return start, end


def plain(subject: str, body: str = "") -> tuple[str, str]:
    """``(kind, text)`` for a commit: kind is added, fixed or changed."""
    subject = (subject or "").strip()
    first_body_line = next((line.strip() for line in (body or "").splitlines() if line.strip()), "")
    if _MERGE_PR_RE.match(subject) and first_body_line:
        subject = first_body_line
    m = _CONVENTIONAL_RE.match(subject)
    if not m:
        return "changed", subject
    kind = {"feat": "added", "fix": "fixed"}.get(m.group("type").lower(), "changed")
    return kind, m.group("text").strip()


def _match_commit(ref: str, by_hash: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    if not _HEX_RE.match(ref or ""):
        return None
    ref = ref.lower()
    hits = [item for full, item in by_hash.items() if full.startswith(ref)]
    return hits[0] if len(hits) == 1 else None


async def build_report(
    workspace_path: str,
    since: datetime,
    until: datetime | None = None,
    *,
    branch: str = "",
    ledger: ShipLogLedger | None = None,
) -> dict[str, Any]:
    """The merged report, oldest item first."""
    book = ledger or _default_ledger
    warnings: list[str] = []
    deploy = branch.strip() or await git_service.default_deploy_branch(workspace_path) or ""
    commits = await git_service.get_first_parent_log(workspace_path, deploy, since, until) if deploy else []
    tags = await git_service.list_tags_created_between(workspace_path, since, until)
    if branch.strip() and not commits:
        warnings.append(f"branch {deploy!r} has no commits in the window, or does not exist")
    elif not deploy:
        warnings.append("no deploy branch: the workspace has no main or master branch (pass branch)")

    by_hash: dict[str, dict[str, Any]] = {}
    items: list[dict[str, Any]] = []
    for commit in reversed(commits):  # oldest first
        kind, text = plain(commit["subject"], commit["body"])
        item = {"key": f"commit:{commit['hash']}", "at": commit["committed_at"], "summary": text, "kind": kind,
                "bases": ["branch"],
                "source_kind": "commit", "hash": commit["hash"], "short_hash": commit["short_hash"],
                "tags": [], "sensitive": False}
        by_hash[commit["hash"]] = item
        items.append(item)
    for tag in tags:
        item = by_hash.get(tag["commit_hash"])
        if item is None:
            kind, text = plain(tag["subject"])
            item = {"key": f"commit:{tag['commit_hash']}", "at": tag["created_at"], "summary": text, "kind": kind,
                    "bases": [],
                    "source_kind": "commit", "hash": tag["commit_hash"], "short_hash": tag["commit_hash"][:7],
                    "tags": [], "sensitive": False}
            by_hash[tag["commit_hash"]] = item
            items.append(item)
        if "tag" not in item["bases"]:
            item["bases"].append("tag")
        item["tags"].append(tag["name"])

    start_ts, end_ts = int(since.timestamp()), int(until.timestamp()) if until else None
    recorded = book.entries(workspace_path, start_ts, end_ts)
    if recorded.get("disabled"):
        warnings.append(f"the ship log ledger is disabled: {recorded['disabled']}")
    labels = {c["key"]: c["label"] for c in book.configs(workspace_path, include_removed=True)["configs"]}
    for entry in recorded["entries"]:
        item = _match_commit(entry["ref"], by_hash) if entry["source_kind"] == "commit" else None
        if item is not None:
            # The agent's own line is the better one; the git time stays.
            item["summary"] = entry["summary"]
            item["kind"] = "recorded"
            item["bases"].insert(0, "agent")
            item["sensitive"] = item["sensitive"] or entry["sensitive"]
            continue
        item = {"key": entry["key"], "at": entry["at"], "summary": entry["summary"], "kind": "recorded",
                "bases": ["agent"], "source_kind": entry["source_kind"], "hash": "", "short_hash": "",
                "ref": entry["ref"], "tags": [], "sensitive": entry["sensitive"]}
        if entry["source_kind"] == "config" and entry["ref"] in labels:
            item["config_label"] = labels[entry["ref"]]
        items.append(item)

    recorded_by_pane: dict[str, list[int]] = {}
    for entry in recorded["entries"]:
        recorded_by_pane.setdefault(entry["pane"], []).append(entry["at"])
    pending = 0
    for found in book.detections(workspace_path, start_ts, end_ts)["detections"]:
        if not found["ok"] or found["status"] != "pending":
            continue
        if any(abs(at - found["at"]) <= CONFIRM_WINDOW_S for at in recorded_by_pane.get(found["pane"], ())):
            continue
        pending += 1
        items.append({"key": f"detect:{found['id']}", "at": found["at"], "summary": found["excerpt"],
                      "kind": "detected", "bases": ["hook"], "source_kind": "other", "hash": "", "short_hash": "",
                      "tags": [], "sensitive": False, "detection_id": found["id"], "rule": found["rule"],
                      "pane": found["pane"]})

    overrides = book.overrides(workspace_path)
    for item in items:
        mine = overrides.get(item["key"])
        if not mine:
            continue
        if mine["summary"]:
            item["summary"] = mine["summary"]
            item["edited"] = True
        if mine["sensitive"] is not None:
            item["sensitive"] = mine["sensitive"]

    items.sort(key=lambda i: i["at"])
    omitted = max(0, len(items) - MAX_ITEMS)
    return {
        "since": since.isoformat(timespec="seconds"),
        "until": until.isoformat(timespec="seconds") if until else None,
        "branch": deploy or None,
        "count": len(items) - pending,  # shipped items; detected commands are counted apart
        "items": items[-MAX_ITEMS:] if omitted else items,
        "omitted": omitted,
        "pending_detections": pending,
        "warnings": warnings,
    }


def _time(ts: int, now: datetime | None = None) -> str:
    return datetime.fromtimestamp(ts, tz=_local_now(now).tzinfo).strftime("%m-%d %H:%M")


def _source(item: dict[str, Any]) -> str:
    parts = [item["short_hash"]] if item["short_hash"] else [item.get("config_label") or item["source_kind"]]
    parts += item["tags"]
    return " ".join(parts) + " · " + "+".join(item["bases"])


def render_text(report: dict[str, Any], lang: str, *, for_chat: bool, now: datetime | None = None) -> str:
    """One line per item: ``time｜plain line｜source · basis``.

    ``for_chat`` is what leaves the machine: a sensitive item and a detected
    command are each folded into one count line and no ref is shown. Locally
    a sensitive item keeps its summary but never its ref.
    """
    start = report["since"][:16].replace("T", " ")
    detected = [i for i in report["items"] if i["kind"] == "detected"]
    shown = [i for i in report["items"] if not (for_chat and (i["sensitive"] or i["kind"] == "detected"))]
    hidden = sum(1 for i in report["items"] if for_chat and i["sensitive"] and i["kind"] != "detected")
    if not report["items"]:
        return messages.text(lang, "empty", start=start)
    lines = [messages.text(lang, "head", start=start, count=report["count"])]
    for item in shown:
        if item["kind"] == "detected":
            summary = messages.text(lang, "kind_detected", rule=item["rule"]) + f" {item['summary']}"
        elif item["kind"] != "recorded" and not item.get("edited"):
            verb = messages.text(lang, f"kind_{item['kind']}")
            summary = f"{verb} {item['summary']}".strip()
        else:
            summary = item["summary"]
        lines.append(messages.text(lang, "line", time=_time(item["at"], now), text=summary, source=_source(item)))
    if hidden:
        lines.append(messages.text(lang, "sensitive_count", count=hidden))
    if for_chat and detected:
        lines.append(messages.text(lang, "pending_detections", count=len(detected)))
    if report["omitted"]:
        lines.append(messages.text(lang, "omitted", count=report["omitted"]))
    return "\n".join(lines)
