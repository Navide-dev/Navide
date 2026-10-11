"""What a share link's content is masked for, warned about, or refused.

A share link publishes a file outside the account, and a published secret
cannot be taken back, so the content is scanned before it is encrypted:

* **High-confidence formats are masked.** The guard's ``_SECRET_PATTERNS``
  (``sk-``, ``ghp_``, ``xox?-``, ``AKIA…``, JWTs, bot tokens, Authorization
  headers, URL credentials …) plus PEM private-key blocks. Their precision is
  what makes rewriting the user's document acceptable.
* **Heuristic hits only warn.** ``settings_bundle._SECRET_HINT_RE`` matches
  every long hex or base64 run, so on its own it would flag each commit SHA
  and each inline screenshot; 40-character SHAs are skipped. A ``transcript``
  is command output nobody reviewed line by line, so there the long runs are
  masked as well.
* **``data:`` URIs are left alone.** An inline image is base64, not text a
  reader could lift a secret from, and rewriting any byte of it breaks the
  picture.

A finding names the line and a category, never the matched value — the same
"say where, not what" rule as the sync secret warnings.

``refusal`` is the path check: the outbound attachment rules Channels already
apply (system and credential folders, key and token file names, Navide's own
data) plus the CLIs' memory files, which never leave the machine.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .channels import media
from .guard.engine import _SECRET_PATTERNS
from .native_memory import MEMORY_SOURCES
from .settings_bundle import _SECRET_HINT_RE

#: One category per guard pattern, in the guard's order.
_GUARD_CATEGORIES = (
    "api-key",
    "github-token",
    "slack-token",
    "aws-access-key",
    "jwt",
    "bot-token",
    "authorization-header",
    "bearer-token",
    "credential-assignment",
    "credential-flag",
    "url-credentials",
)
if len(_GUARD_CATEGORIES) != len(_SECRET_PATTERNS):  # pragma: no cover - caught by the test suite
    raise RuntimeError("share_scan: guard._SECRET_PATTERNS changed; name the new pattern's category")

_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----.*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----",
    re.DOTALL,
)

#: (pattern, replacement template, category), checked in this order.
HIGH_CONFIDENCE: tuple[tuple[re.Pattern[str], str, str], ...] = (
    (_PRIVATE_KEY_RE, "<redacted private key>", "private-key"),
    *((pattern, repl, category) for (pattern, repl), category in zip(_SECRET_PATTERNS, _GUARD_CATEGORIES)),
)

_DATA_URI_RE = re.compile(r"data:[\w/+.-]+(?:;[\w=.+-]+)*,[A-Za-z0-9+/=%_.-]*")
_SHA1_RE = re.compile(r"[0-9a-fA-F]{40}")
#: A heuristic hit this long is a value (a hex or base64 run), not a keyword.
_RUN_MIN = 32

#: Kinds whose heuristic hits are masked rather than only warned about.
_MASK_HEURISTICS = frozenset({"transcript"})

MASKED = "masked"
WARNED = "warned"


@dataclass(frozen=True)
class Finding:
    line: int
    category: str
    action: str  # MASKED or WARNED


@dataclass(frozen=True)
class ScanResult:
    text: str
    findings: list[Finding]


def _overlaps(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    return any(start < s_end and s_start < end for s_start, s_end in spans)


def scan(text: str, *, kind: str) -> ScanResult:
    """``text`` with its secrets masked, and where each finding was."""
    skip = [m.span() for m in _DATA_URI_RE.finditer(text)]
    edits: list[tuple[int, int, str, str]] = []  # start, end, replacement, category
    for pattern, repl, category in HIGH_CONFIDENCE:
        for m in pattern.finditer(text):
            if m.start() == m.end() or _overlaps(*m.span(), skip):
                continue
            edits.append((m.start(), m.end(), m.expand(repl), category))
    # Two patterns can match the same secret ("Authorization: Bearer x"): the
    # earliest, then longest, wins and the rest are dropped.
    edits.sort(key=lambda e: (e[0], -(e[1] - e[0])))
    masked: list[tuple[int, int, str, str]] = []
    for edit in edits:
        if not masked or edit[0] >= masked[-1][1]:
            masked.append(edit)
    taken = [(s, e) for s, e, _, _ in masked]

    warned: list[tuple[int, int]] = []
    for m in _SECRET_HINT_RE.finditer(text):
        start, end = m.span()
        if _overlaps(start, end, skip) or _overlaps(start, end, taken):
            continue
        if _SHA1_RE.fullmatch(m.group(0)):
            continue
        if kind in _MASK_HEURISTICS and end - start >= _RUN_MIN:
            masked.append((start, end, "<redacted>", "possible-secret"))
        else:
            warned.append((start, end))
    masked.sort()

    findings = [Finding(text.count("\n", 0, s) + 1, category, MASKED) for s, _, _, category in masked]
    findings += [Finding(text.count("\n", 0, s) + 1, "possible-secret", WARNED) for s, _ in warned]
    findings.sort(key=lambda f: f.line)

    out: list[str] = []
    cursor = 0
    for start, end, replacement, _ in masked:
        out.append(text[cursor:start])
        out.append(replacement)
        cursor = end
    out.append(text[cursor:])
    return ScanResult("".join(out), findings)


# ---- paths ---------------------------------------------------------------------

_MEMORY_NAMES = frozenset(
    {src.relative[-1].casefold() for src in MEMORY_SOURCES if not src.glob} | {"memory.md"}
)

_MESSAGES = {
    "not_absolute": "Only an absolute path can be shared.",
    "parent_ref": "A path with '..' cannot be shared.",
    "missing": "The file does not exist.",
    "not_file": "Only a single file can be shared.",
    "denied_name": "This file name looks like a key, credential or token file, which is never shared.",
    "system": "Files in system, credential or Navide data folders are never shared.",
    "hard_link": "A file with more than one name (a hard link) is never shared.",
    "changed": "The file changed or became unreadable while it was checked.",
    "memory": "Agent memory files (CLAUDE.md, AGENTS.md and the like) are never shared.",
}


@dataclass(frozen=True)
class Refusal:
    code: str
    message: str


def _is_memory(real: Path) -> bool:
    if real.name.casefold() in _MEMORY_NAMES:
        return True
    # Auto-memory folders (~/.claude/projects/<p>/memory/*.md) sit below a dot folder.
    parts = [p.casefold() for p in real.parts]
    return any(p == "memory" and any(q.startswith(".") for q in parts[:i]) for i, p in enumerate(parts))


def refusal(raw: str) -> Refusal | None:
    """Why ``raw`` can never be shared, or None when it may be."""
    real, reason = media.resolve_outbound(raw)
    if real is None:
        return Refusal(reason, _MESSAGES.get(reason, "This file cannot be shared."))
    if _is_memory(real):
        return Refusal("memory", _MESSAGES["memory"])
    return None
