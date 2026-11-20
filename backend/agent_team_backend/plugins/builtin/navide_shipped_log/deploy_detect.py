"""Deploy commands an agent ran, as its CLI's PostToolUse hook reports them.

Only records. Nothing here can block, delay or change a command: the hook that
feeds it fires after the command finished, and its answer goes nowhere. A
match is one ``ship_detect`` row holding which rule matched and the matching
part of the command, masked; the report lists it as an unconfirmed hint until
someone records the change, confirms it or dismisses it.

Today only Claude Code reports tool results (claude_hooks' PostToolUse and
PostToolUseFailure), so only its ``Bash`` tool is read here.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from agent_team_backend import share_scan
from agent_team_backend.plugins.builtin.navide_shipped_log.ledger import MAX_EXCERPT, ShipLogLedger, ledger as _default

log = logging.getLogger(__name__)

PLUGIN_ID = "navide.shipped-log"
#: Tools whose input is one shell command line.
SHELL_TOOLS = frozenset({"Bash"})

_BRANCHES = r"(?:main|master|production|prod|release)"
#: (rule id, pattern) tried in order on each command of a line, after its
#: leading environment assignments and wrappers are dropped.
RULES: tuple[tuple[str, re.Pattern[str]], ...] = tuple((rule, re.compile(pattern)) for rule, pattern in (
    ("package-publish", r"^(?:npm|pnpm|yarn|bun)\s+(?:npm\s+)?publish\b"),
    ("package-publish", r"^(?:twine\s+upload|uv\s+publish|poetry\s+publish|hatch\s+publish|flit\s+publish"
                        r"|cargo\s+publish|gem\s+push|dotnet\s+nuget\s+push)\b"),
    ("container-push", r"^(?:docker|podman)\s+push\b|^docker\s+buildx\s+build\b.*\s--push\b"),
    ("kubernetes", r"^kubectl\s+(?:apply|rollout\s+restart|set\s+image|replace)\b|^helm\s+(?:upgrade|install|rollback)\b"),
    ("infrastructure", r"^(?:terraform|tofu)\s+apply\b|^pulumi\s+up\b|^aws\s+cloudformation\s+deploy\b"),
    ("platform-deploy", r"^(?:fly|flyctl)\s+deploy\b|^vercel\b.*(?:\s--prod\b|\sdeploy\b)|^netlify\s+deploy\b.*\s--prod\b"
                        r"|^firebase\s+deploy\b|^(?:serverless|sls)\s+deploy\b|^eb\s+deploy\b|^wrangler\s+(?:deploy|publish)\b"
                        r"|^gcloud\s+(?:\S+\s+)*deploy\b|^kamal\s+deploy\b|^railway\s+up\b|^cap\s+\S+\s+deploy\b"),
    ("cloud-update", r"^aws\s+(?:ecs\s+update-service|lambda\s+update-function-code|s3\s+sync)\b"),
    ("github-release", r"^gh\s+release\s+create\b"),
    ("git-push-deploy-branch", rf"^git\s+push\b(?:\s+\S+)*\s+(?:\S+:)?(?:refs/heads/)?{_BRANCHES}(?:\s|$)"
                               r"|^git\s+push\s+heroku\b"),
    ("deploy-script", r"^(?:(?:ba|z)?sh\s+)?(?:\S*/)?(?:deploy|release|publish)[\w.-]*(?:\s|$)"),
    ("deploy-task", r"^make\s+(?:\S+\s+)*(?:deploy|release|publish)[\w:-]*\b"
                    r"|^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:deploy|release)[\w:-]*\b"),
))

_SPLIT_RE = re.compile(r"\s*(?:&&|\|\||;|\||\n)\s*")
_ASSIGNMENT_RE = re.compile(r"^[A-Za-z_]\w*=\S*\s+")
_WRAPPER_RE = re.compile(r"^(?:sudo(?:\s+-\S+)*|time|env|nohup|npx|bunx|(?:pnpm|yarn)\s+dlx|exec)\s+")
_ASSIGNED_VALUE_RE = re.compile(r"(?<![\w-])([A-Za-z_][\w.-]*)=(\S+)")
_SECRET_FLAG_RE = re.compile(
    r"(--?(?:[\w-]*token|[\w-]*password|pass|[\w-]*secret|[\w-]*api-?key|auth|otp|p)\b)(?:=|\s+)(\S+)",
    re.IGNORECASE,
)


def _strip(command: str) -> str:
    text = command.strip()
    while True:
        stripped = _WRAPPER_RE.sub("", _ASSIGNMENT_RE.sub("", text))
        if stripped == text:
            return text
        text = stripped


def match(command: str) -> tuple[str, str] | None:
    """``(rule, the matching command)`` for the first deploy command in a
    shell line, or None."""
    for part in _SPLIT_RE.split(command or ""):
        candidate = _strip(part)
        for rule, pattern in RULES:
            if pattern.search(candidate):
                return rule, candidate
    return None


def mask(command: str) -> str:
    """The command as it may be stored: every assigned value, every value of a
    token/password/secret/key flag and every high-confidence secret replaced,
    email addresses shortened, cut to the excerpt length."""
    from agent_team_backend.channels import redact

    text = _ASSIGNED_VALUE_RE.sub(lambda m: f"{m.group(1)}=***", command)
    text = _SECRET_FLAG_RE.sub(lambda m: f"{m.group(1)} ***", text)
    text = share_scan.scan(text, kind="text").text
    text = redact.redact_text(redact.mask_emails(text))
    text = " ".join(text.split())
    return text if len(text) <= MAX_EXCERPT else text[: MAX_EXCERPT - 1] + "…"


def observe(
    workspace_path: str,
    *,
    pane: str,
    vendor: str,
    ok: bool,
    payload: dict[str, Any],
    book: ShipLogLedger | None = None,
    now: float | None = None,
) -> int | None:
    """Record the deploy command in one tool-result hook payload, if there is
    one. Returns the new row id, or None when nothing was recorded."""
    if str(payload.get("tool_name") or "") not in SHELL_TOOLS:
        return None
    tool_input = payload.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str) or not command.strip():
        return None
    found = match(command)
    if found is None:
        return None
    rule, part = found
    return (book or _default).record_detection(
        workspace_path, at=int(time.time() if now is None else now), pane=pane, vendor=vendor,
        rule=rule, excerpt=mask(part), ok=ok,
    )
