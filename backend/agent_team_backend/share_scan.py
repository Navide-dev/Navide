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
import unicodedata
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

#: Where a token may start: not right after a letter or digit, so "task-…"
#: is not read as "sk-…". Underscores and punctuation still count as a start.
_B = r"(?<![A-Za-z0-9])"


def _share_form(pattern: re.Pattern[str]) -> re.Pattern[str]:
    """A guard pattern with its leading ``\b`` widened to ``_B``."""
    src = pattern.pattern
    return re.compile(_B + src[2:] if src.startswith(r"\b") else src, pattern.flags)


_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----"
    r"(?:.*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|[A-Za-z0-9+/=\s\\]*)",  # or cut short
    re.DOTALL,
)
# The guard's "/bot<anything>/" is right for a command line and wrong for a
# document, where it rewrites /bottles/ and /both; a share wants the token shape.
_BOT_URL = (re.compile(r"/bot(\d{5,}:[A-Za-z0-9_-]{30,})(?=/|\b)"), "/bot<redacted>", "bot-token")
#: JSON / YAML / .env keys with a quoted value: the whole quoted value goes,
#: spaces included ('SECRET="abc def"' used to keep "def").
_QUOTED_CREDENTIAL = (
    re.compile(
        r"""(?i)(["']?(?:password|passwd|pwd|secret|client[_-]?secret|token|api[_-]?key|apikey|access[_-]?key"""
        r"""|private[_-]?key)["']?\s*[:=]\s*["'])[^"'\n]+"""
    ),
    r"\1<redacted>",
    "credential-assignment",
)
#: Provider token shapes the guard list does not cover.
_PROVIDERS = (
    (r"AIza[\w-]{35}", "google-api-key"),
    (r"glpat-[\w-]{20,}", "gitlab-token"),
    (r"[sr]k_(?:live|test)_[0-9A-Za-z]{24,}", "stripe-key"),
    (r"npm_[A-Za-z0-9]{36}", "npm-token"),
    (r"hf_[A-Za-z0-9]{30,}", "huggingface-token"),
    (r"(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}", "aws-access-key"),
    (r"xapp-\d-[\w-]+", "slack-app-token"),
    (r"SG\.[\w-]{22}\.[\w-]{43}", "sendgrid-key"),
    (r"pypi-AgE[\w-]{50,}", "pypi-token"),
    (r"\d{8,10}:AA[\w-]{33}", "telegram-bot-token"),
    (r"[MNO][\w-]{23,25}\.[\w-]{6}\.[\w-]{27,}", "discord-bot-token"),
)

#: (pattern, replacement template, category), checked in this order.
HIGH_CONFIDENCE: tuple[tuple[re.Pattern[str], str, str], ...] = (
    (_PRIVATE_KEY_RE, "<redacted private key>", "private-key"),
    _QUOTED_CREDENTIAL,
    _BOT_URL,
    *(
        (_share_form(pattern), repl, category)
        for (pattern, repl), category in zip(_SECRET_PATTERNS, _GUARD_CATEGORIES)
        if category != "bot-token"
    ),
    *((re.compile(_B + src), "<redacted>", category) for src, category in _PROVIDERS),
)

#: An inline image, font or media file. Only these are exempt, and only from
#: the heuristic: a high-confidence format is masked wherever it sits.
_DATA_URI_RE = re.compile(r"(?<![\w-])data:(?:image|font|audio|video)/[\w.+-]+;base64,([A-Za-z0-9+/]+={0,2})")
#: What may legitimately follow a data URI's payload; anything glued on (a
#: "-" or "_" is not base64) means the "image" is a disguise.
_GLUED_RUN = re.compile(r"[\w+/=-]*")
_SHA1_RE = re.compile(r"[0-9a-fA-F]{40}")
#: A heuristic hit this long is a value (a hex or base64 run), not a keyword.
_RUN_MIN = 32
_ZERO_WIDTH_RE = re.compile("[​‌‍⁠﻿­]")

#: Kinds whose heuristic hits are masked rather than only warned about.
#: TODO(Phase 3, transcript kind): the length rule masks long file paths in
#: command output; judge runs by entropy before any transcript can be shared.
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


def _high_confidence(text: str) -> list[tuple[int, int, str, str]]:
    edits: list[tuple[int, int, str, str]] = []  # start, end, replacement, category
    for pattern, repl, category in HIGH_CONFIDENCE:
        for m in pattern.finditer(text):
            if m.start() != m.end():
                edits.append((m.start(), m.end(), m.expand(repl), category))
    # Two patterns can match the same secret ("Authorization: Bearer x"): the
    # earliest, then longest, wins and the rest are dropped.
    edits.sort(key=lambda e: (e[0], -(e[1] - e[0])))
    kept: list[tuple[int, int, str, str]] = []
    for edit in edits:
        if not kept or edit[0] >= kept[-1][1]:
            kept.append(edit)
    return kept


def scan(text: str, *, kind: str) -> ScanResult:
    """``text`` with its secrets masked, and where each finding was."""
    masked = _high_confidence(text)
    skip: list[tuple[int, int]] = []
    for m in _DATA_URI_RE.finditer(text):
        glued = _GLUED_RUN.match(text, m.end()).end()
        if glued > m.end():
            if not _overlaps(m.start(1), glued, [(s, e) for s, e, _, _ in masked]):
                masked.append((m.start(1), glued, "<redacted>", "possible-secret"))
        else:
            skip.append(m.span())
    masked.sort()
    taken = [(s, e) for s, e, _, _ in masked]

    warned: list[tuple[int, str]] = []
    for m in _SECRET_HINT_RE.finditer(text):
        start, end = m.span()
        if _overlaps(start, end, skip) or _overlaps(start, end, taken):
            continue
        if _SHA1_RE.fullmatch(m.group(0)):
            continue
        if kind in _MASK_HEURISTICS and end - start >= _RUN_MIN:
            masked.append((start, end, "<redacted>", "possible-secret"))
        else:
            warned.append((start, "possible-secret"))
    masked.sort()

    # A token split by zero-width or written in full-width characters reads
    # the same to a person; check a normalised copy and warn about what only
    # it shows. Removing zero-width characters and NFKC keep line breaks.
    folded = unicodedata.normalize("NFKC", _ZERO_WIDTH_RE.sub("", text))
    if folded != text:
        plain = {text[s:e] for s, e, _, _ in masked}
        for start, end, _, category in _high_confidence(folded):
            if folded[start:end] not in plain:
                warned.append((folded.count("\n", 0, start) + 1, f"obfuscated-{category}"))

    findings = [Finding(text.count("\n", 0, s) + 1, category, MASKED) for s, _, _, category in masked]
    findings += [
        Finding(pos if category.startswith("obfuscated-") else text.count("\n", 0, pos) + 1, category, WARNED)
        for pos, category in warned
    ]
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
    "whitespace": "The path starts or ends with a space; name the file exactly.",
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


def open_shareable(raw: str) -> tuple[media.Outbound | None, Refusal | None]:
    """``raw`` opened for reading after the checks, or why it never may be.

    The returned handle is the very file that passed (``media.open_outbound``
    rechecks it while open), so read from it and use its ``path``; reopening
    by name would read whatever the name points at by then. The caller closes
    the handle. A path with whitespace around it is refused rather than
    trimmed: the check and the read must name the same file.
    """
    if raw != raw.strip():
        return None, Refusal("not_absolute", _MESSAGES["whitespace"])
    out, reason = media.open_outbound(raw)
    if out is None:
        return None, Refusal(reason, _MESSAGES.get(reason, "This file cannot be shared."))
    if _is_memory(out.path):
        out.fh.close()
        return None, Refusal("memory", _MESSAGES["memory"])
    return out, None


def refusal(raw: str) -> Refusal | None:
    """Why ``raw`` can never be shared, or None when it may be."""
    out, refused = open_shareable(raw)
    if out is not None:
        out.fh.close()
    return refused
