"""What a share link's content is masked for, warned about, or refused.

A share link publishes a file outside the account, and a published secret
cannot be taken back, so the content is scanned before it is encrypted:

* **High-confidence formats are masked.** The guard's ``_SECRET_PATTERNS``
  (``sk-``, ``ghp_``, ``xox?-``, ``AKIA…``, JWTs, bot tokens, Authorization
  headers, URL credentials …) plus PEM private-key blocks. Their precision is
  what makes rewriting the user's document acceptable.
* **Heuristic hits only warn.** ``settings_bundle._SECRET_HINT_RE`` matches
  every long hex or base64 run, so on its own it would flag each commit SHA
  and each inline screenshot; 40-character SHAs are skipped.
* **Inline media is exempt from the heuristic only.** A base64
  ``data:image|font|audio|video`` payload is not flagged as a "long run";
  high-confidence formats are masked wherever they sit, and a payload with
  non-base64 text glued on is masked as a disguise.

Masked text becomes ``[redacted]`` — square brackets, so the marker reads the
same in a JSON string and in HTML (``<redacted>`` would become an element).
Quoted values are recognised with every quote spelling a plan file carries:
plain, backslash-escaped (plan-meta is JSON) and HTML entities (visible
markup is escaped), and the value ends at the same spelling it opened with.

A finding names the line and a category, never the matched value — the same
"say where, not what" rule as the sync secret warnings.

``refusal`` is the path check: the outbound attachment rules Channels already
apply (system and credential folders, key and token file names, Navide's own
data) plus the CLIs' memory files, which never leave the machine.
"""

from __future__ import annotations

import bisect
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


# Every pattern below is bounded: no unbounded run is followed by something
# that can fail, so a long adversarial line costs time proportional to its
# length (a run that scans to the end of a line and then fails, once per
# possible start, is quadratic). Keys are at most 64+64 characters around the
# keyword, values at most 4096, URL passwords 256, private-key bodies 16 KiB.
_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN (?:[A-Z0-9]{1,16} ){0,4}PRIVATE KEY(?: BLOCK)?-----"
    # the body up to its END line, never across another BEGIN; or cut short
    r"(?:(?:(?!-----BEGIN ).){0,16384}?-----END (?:[A-Z0-9]{1,16} ){0,4}PRIVATE KEY(?: BLOCK)?-----"
    r"|[A-Za-z0-9+/=\s\\]{0,16384})",
    re.DOTALL,
)
# The guard's "/bot<anything>/" is right for a command line and wrong for a
# document, where it rewrites /bottles/ and /both; a share wants the token shape.
_BOT_URL = (re.compile(r"/bot(\d{5,}:[A-Za-z0-9_-]{30,256})(?=/|\b)"), "/bot[redacted]", "bot-token")
#: The guard's JWT shape with bounded segments, and no start inside a
#: base64url run ("-ey-ey-ey…" is not three tokens).
_JWT = (
    re.compile(r"(?<![A-Za-z0-9_-])ey[A-Za-z0-9_-]{10,4096}+\.[A-Za-z0-9_-]{10,4096}+\.[A-Za-z0-9_-]{10,4096}+"),
    "[redacted]",
    "jwt",
)
_REDACTED = "[redacted]"
#: Every way a plan file spells a quote: plain, JSON-escaped (plan-meta, also
#: as backslash-u0022, and escaped once more when the text itself held a
#: backslashed quote), and as an HTML entity (escaped visible markup, also
#: after backslashes). Longest first, so a value ends at the very spelling
#: it began with. The doubled-backslash branches start only at the first
#: backslash of a run: tried at every one, a long run is quadratic (B7-1).
_QUOTE = (
    r"""(?:(?<!\\)(?:\\\\)+\\"|(?<!\\)(?:\\\\)+\\&quot;|\\u0022|\\&quot;|\\"|\\'|&quot;|&\#0*34;|&\#x0*22;"""
    r"""|&\#0*39;|&\#x0*27;|&apos;|"|')"""
)
#: Suffixes that make a credential word name something that is not a secret:
#: tokens, tokenizer, passwordless, secretary, passwordHash, token_url,
#: max_tokens… Any other suffix (tokenValue, password_hash_salt,
#: OPENAI_API_KEY_PROD, token2) is still a credential key. Longer
#: alternatives first: the repetition is possessive and does not retry.
_SAFE_SUFFIX = (
    r"(?:izer|ize|less|ary|hash|policy|name|endpoint|url|uri|type|ttl|count|length|len|used"
    r"|reset|ref|manager|min|max|rules|rule|field|label|prompt|hint|header|path|file|s)"
)
#: A credential-looking key: any prefix (client_secret, auth_token,
#: refreshToken, MYSQL_PWD), any suffix but the ones above. "auth" is left
#: out on purpose: author, authority and oauth_url are far more common in a
#: plan than auth secrets. "pwd" is captured, because a pwd whose value is a
#: path is the working directory, not a password.
_CRED_KEY = (
    r"\w{0,64}?(?:secret|passw(?:or)?d|passphrase|token|api[_-]?key|apikey|private[_-]?key"
    r"|signing[_-]?key|encryption[_-]?key|access[_-]?key|(?P<pwd>pwd))"
    rf"(?!(?:[_-]?{_SAFE_SUFFIX})++(?!\w))\w{{0,64}}(?!\w)"
)
_CRED_PREFIX = rf"(?<!\w){_QUOTE}?{_CRED_KEY}{_QUOTE}?\s{{0,64}}[:=]\s{{0,64}}"
#: A pwd value that starts like a path (/, ~, ., or a Windows drive) is a directory.
_PWD_PATH = r"(?(pwd)(?![/~.]|[A-Za-z]:\\))"
#: A backslash pair inside an unquoted value (C:\\Users\\x, or the doubled
#: backslashes of the same path inside JSON) — but never a backslashed quote,
#: which is the end of a surrounding JSON string. The pair and the single
#: character below never match the same text, so this cannot backtrack.
_ESCAPE_PAIR = r"""\\(?![\"'&]|u0022)\S"""
#: The same inside the plan-meta JSON island, where backslash-n, -r and -t
#: are a line break or a tab and end the value (B5-2). Elsewhere they are
#: just as likely a path (C:\\Users\\neil) or a literal, and the value
#: goes on: masking too much beats leaking the rest (B7-2).
_JSON_ESCAPE_PAIR = r"""\\(?![\"'&nrt]|u0022)\S"""
#: A credential key with a quoted value: the whole value goes, spaces
#: included, and an escaped quote inside it does not end it. The two value
#: branches never match the same character (a backslash starts an escape,
#: anything else is one character), so a long run of backslashes with no
#: closing quote cannot backtrack exponentially.
_QUOTED_CREDENTIAL = (
    re.compile(
        rf"(?i)({_CRED_PREFIX}(?P<q>{_QUOTE})){_PWD_PATH}(?:(?!(?P=q))(?:\\.|[^\\\n])){{1,4096}}(?=(?P=q))"
    ),
    r"\1" + _REDACTED,
    "credential-assignment",
)
#: The same, with the closing quote missing: mask up to the next space,
#: quote, backslash or markup, as an unquoted value would be.
def _unclosed_credential(pair: str) -> tuple[re.Pattern[str], str, str]:
    return (
        re.compile(rf"(?i)({_CRED_PREFIX}{_QUOTE}){_PWD_PATH}(?:{pair}|[^\s\"'\\&<>]){{1,4096}}"),
        r"\1" + _REDACTED,
        "credential-assignment",
    )


_UNCLOSED_CREDENTIAL = _unclosed_credential(_ESCAPE_PAIR)
#: Values that are settings or type names, not secrets: literals, a number
#: of at most 5 digits (a port, a size, a count — 12345678 is a PIN), and the
#: words a schema or a code sample puts after a key.
_NOT_A_SECRET = (
    r"(?!(?:true|false|null|none|undefined|string|number|boolean|required|optional)(?![\w-]))"
    r"(?![0-9]{1,5}(?![^\s'\"&<>,;\\]))"
)
#: The same keys with a bare value (.env, YAML). The value stops at a
#: backslash, so the \" that closes a surrounding JSON string survives.
def _bare_credential(pair: str) -> tuple[re.Pattern[str], str, str]:
    return (
        re.compile(
            rf"(?i)((?<!\w){_CRED_KEY}\s{{0,64}}[:=]\s{{0,64}})(?!{_QUOTE}){_PWD_PATH}{_NOT_A_SECRET}"
            rf"(?:{pair}|[^\s'\"&<>,;\\]){{4,4096}}"
        ),
        r"\1" + _REDACTED,
        "credential-assignment",
    )


_BARE_CREDENTIAL = _bare_credential(_ESCAPE_PAIR)
#: The unquoted-value patterns as they read inside the plan-meta island
#: (``_JSON_ESCAPE_PAIR``), and where that island is.
_IN_JSON = {
    id(_UNCLOSED_CREDENTIAL[0]): _unclosed_credential(_JSON_ESCAPE_PAIR)[0],
    id(_BARE_CREDENTIAL[0]): _bare_credential(_JSON_ESCAPE_PAIR)[0],
}
_JSON_ISLAND_OPEN_RE = re.compile(r'<script\b[^>]{0,256}\bid="plan-meta"[^>]{0,256}>')
#: user:password@ in a URL, also with no user (redis://:pw@host), a "/" in
#: the password, or an "@" in it (up to the last "@" before the host). A port
#: followed by a path (localhost:5173/@vite) is not a password, and neither is
#: anything whose "@" directly follows a "/". The password is at most 256
#: characters and never crosses a quote, "<", ">" or ",".
_URL_CREDENTIALS = (
    re.compile(
        r"(://[^/\s:@\"'<>,]{0,256}:)(?!\d+/)"
        r"(?:[^\s@\"'<>,]|@(?=[^\s/@\"'<>,]{0,256}@)){1,256}(?<!/)@(?=[\w.\[-])"
    ),
    r"\1" + _REDACTED + "@",
    "url-credentials",
)
#: Provider token shapes the guard list does not cover.
_PROVIDERS = (
    (r"AIza[\w-]{35}", "google-api-key"),
    (r"glpat-[\w-]{20,256}", "gitlab-token"),
    (r"[sr]k_(?:live|test)_[0-9A-Za-z]{24,256}", "stripe-key"),
    (r"npm_[A-Za-z0-9]{36}", "npm-token"),
    (r"hf_[A-Za-z0-9]{30,256}", "huggingface-token"),
    (r"(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}", "aws-access-key"),
    (r"xapp-\d-[\w-]{1,256}", "slack-app-token"),
    (r"SG\.[\w-]{22}\.[\w-]{43}", "sendgrid-key"),
    (r"pypi-AgE[\w-]{50,512}", "pypi-token"),
    (r"\d{8,10}:AA[\w-]{33}", "telegram-bot-token"),
    (r"[MNO][\w-]{23,25}\.[\w-]{6}\.[\w-]{27,128}", "discord-bot-token"),
)

#: (pattern, replacement template, category), checked in this order.
HIGH_CONFIDENCE: tuple[tuple[re.Pattern[str], str, str], ...] = (
    (_PRIVATE_KEY_RE, "[redacted private key]", "private-key"),
    _QUOTED_CREDENTIAL,
    _UNCLOSED_CREDENTIAL,
    _BARE_CREDENTIAL,
    _URL_CREDENTIALS,
    _BOT_URL,
    _JWT,
    *(
        (_share_form(pattern), repl.replace("<redacted>", _REDACTED), category)
        for (pattern, repl), category in zip(_SECRET_PATTERNS, _GUARD_CATEGORIES)
        # Replaced share-side: _BOT_URL needs the token shape, _JWT is
        # bounded, and the credential keys are _QUOTED/_BARE_CREDENTIAL's list.
        if category not in ("bot-token", "credential-assignment", "jwt")
    ),
    *((re.compile(_B + src), _REDACTED, category) for src, category in _PROVIDERS),
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

#: Kinds whose heuristic hits are masked rather than only warned about: none
#: of the kinds that can be shared.
_MASK_HEURISTICS: frozenset[str] = frozenset()

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


class _Spans:
    """Sorted, non-overlapping spans, asked "does [start, end) touch one?"
    in O(log n) — a linear walk per hit made a text with many findings
    quadratic."""

    def __init__(self, spans: list[tuple[int, int]]) -> None:
        self._starts = [s for s, _ in spans]
        self._ends = [e for _, e in spans]

    def overlaps(self, start: int, end: int) -> bool:
        i = bisect.bisect_left(self._starts, end) - 1  # the last span starting before end
        return i >= 0 and self._ends[i] > start


def _line_of(newlines: list[int], pos: int) -> int:
    return bisect.bisect_left(newlines, pos) + 1


def _newlines(text: str) -> list[int]:
    return [i for i, ch in enumerate(text) if ch == "\n"]


def _json_islands(text: str) -> list[tuple[int, int]]:
    """The plan-meta island bodies, in order. An opener with no "</script>"
    after it closes nothing, and neither can any opener after it, so the
    search stops there instead of rescanning the rest from every opener."""
    islands: list[tuple[int, int]] = []
    pos = 0
    while (m := _JSON_ISLAND_OPEN_RE.search(text, pos)) is not None:
        end = text.find("</script>", m.end())
        if end < 0:
            break
        islands.append((m.end(), end))
        pos = end + len("</script>")
    return islands


def _high_confidence(text: str) -> list[tuple[int, int, str, str]]:
    edits: list[tuple[int, int, str, str]] = []  # start, end, replacement, category
    islands = _json_islands(text)
    starts = [a for a, _ in islands]

    def in_island(i: int) -> bool:
        k = bisect.bisect_right(starts, i) - 1
        return k >= 0 and i < islands[k][1]

    for pattern, repl, category in HIGH_CONFIDENCE:
        json_form = _IN_JSON.get(id(pattern))
        if json_form is None or not islands:
            matches = list(pattern.finditer(text))
        else:
            # Outside the island the text form; inside it the JSON form.
            matches = [m for m in pattern.finditer(text) if not in_island(m.start())]
            for a, b in islands:
                matches += json_form.finditer(text, a, b)
        for m in matches:
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
    high = _Spans([(s, e) for s, e, _, _ in masked])
    skip: list[tuple[int, int]] = []
    for m in _DATA_URI_RE.finditer(text):
        glued = _GLUED_RUN.match(text, m.end()).end()
        if glued > m.end():
            if not high.overlaps(m.start(1), glued):
                masked.append((m.start(1), glued, _REDACTED, "possible-secret"))
        else:
            skip.append(m.span())
    masked.sort()
    exempt = _Spans(skip)
    taken = _Spans([(s, e) for s, e, _, _ in masked])

    warned: list[tuple[int, str]] = []
    for m in _SECRET_HINT_RE.finditer(text):
        start, end = m.span()
        if exempt.overlaps(start, end) or taken.overlaps(start, end):
            continue
        if _SHA1_RE.fullmatch(m.group(0)):
            continue
        if kind in _MASK_HEURISTICS and end - start >= _RUN_MIN:
            masked.append((start, end, _REDACTED, "possible-secret"))
        else:
            warned.append((start, "possible-secret"))
    masked.sort()

    newlines = _newlines(text)
    findings = [Finding(_line_of(newlines, s), category, MASKED) for s, _, _, category in masked]
    findings += [Finding(_line_of(newlines, pos), category, WARNED) for pos, category in warned]

    # A token split by zero-width or written in full-width characters reads
    # the same to a person; check a normalised copy and warn about what only
    # it shows. Removing zero-width characters and NFKC keep line breaks.
    folded = unicodedata.normalize("NFKC", _ZERO_WIDTH_RE.sub("", text))
    if folded != text:
        plain = {text[s:e] for s, e, _, _ in masked}
        folded_newlines = _newlines(folded)
        for start, end, _, category in _high_confidence(folded):
            if folded[start:end] not in plain:
                findings.append(Finding(_line_of(folded_newlines, start), f"obfuscated-{category}", WARNED))
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
        return None, Refusal("whitespace", _MESSAGES["whitespace"])
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
