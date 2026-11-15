"""Aider CLI (`aider`, pip package `aider-chat`) chat-history reader.

Aider is the only Markdown-format vendor here, and it has NO session-id
concept — this is a deliberately partial integration (marker binding + token
display work; resume is lossy):

  - History is a Markdown file at the git root above the pane cwd (the cwd
    itself when there is no git root). Navide spawns each pane with its OWN
    file there, `.aider.chat.history.<pane-token>.md` (pane-token = the first
    8 chars of the pane UUID), via `--chat-history-file`; aider's own default,
    the per-project shared `.aider.chat.history.md`, is still read for panes
    started before that and for aider runs outside Navide. Every session
    APPENDS to its file; each append is an open-write-close, so content lands
    on disk immediately.
  - A session's boundary is the line aider writes at startup:
        `# aider chat started at YYYY-MM-DD HH:MM:SS`
    This reader defines a session as "the last such section of a history
    file" and coins the session id from the header timestamp plus a
    per-FILE namespace (`aider-<ns>-YYYYMMDD-HHMMSS`; ns = the pane token, or
    a hash of the file path for the shared file) — without it two panes
    starting in the same second collide on one id. Same-second collisions
    WITHIN one file are still tolerated — the last section wins the id.
  - User input is written verbatim with a `#### ` prefix (multi-line input
    continues as `  \\n#### ...`), so the pane kickoff's `at-pane:<paneId>`
    marker is searchable. Markers are honoured ONLY in the file's last
    section — earlier sections belong to historic sessions.
  - Usage lines follow each assistant message:
        `> Tokens: 12k sent, 1.2k received. Cost: $0.01 message, ...`
    sent → input, received → output (per-message values, summed by the sink;
    cost ignored). Numbers appear as `1,234`, `12k` or `8.5k` — parsing is
    deliberately loose.
  - Resume is LOSSY: `aider --restore-chat-history` re-reads the history
    file (possibly LLM-summarized). No id exists to pass, so there is no
    resume-id claim for this vendor; the resume preflight only checks that
    the workspace's history file exists.

Because the history file lives inside each workspace (not under a global CLI
home), project_dirs()/session_files() return empty; discovery is driven by
registered workspaces (session_files_for_workspace + the watcher's periodic
rescan). Workspace roots get no watchdog subscription, so aider events
arrive with up-to-rescan-interval latency.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any

from ._declared import declared
from .base import AccountSwitchSpec, Dep, PlatformInstall, VendorSpec, dotenv_extract, dotenv_merge
from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    activity_high_water,
    set_activity_high_water,
    tail_anchor,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.aider")

HISTORY_NAME = ".aider.chat.history.md"

# Per-pane history file (`aider --chat-history-file`): the legacy name with the
# pane token spliced in. Anchored to exactly 8 lowercase hex chars so aider's
# sibling dotfiles (.aider.input.history, .aider.llm.history, .aider.tags.cache*)
# and user backups (.aider.chat.history.md.bak) are never mistaken for one.
_PANE_FILE_RE = re.compile(r"^\.aider\.chat\.history\.([0-9a-f]{8})\.md$")
_PANE_TOKEN_RE = re.compile(r"^[0-9a-f]{8}$")

_SECTION_RE = re.compile(
    r"^# aider chat started at (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})"
)
_TOKENS_RE = re.compile(
    r"^>\s*Tokens:\s*([\d.,]+k?)\s+sent,\s*([\d.,]+k?)\s+received",
    re.IGNORECASE,
)

# Tail window for locating the last section header (marker scan / session id).
# An active section larger than this triggers a full-file fallback read.
_TAIL_WINDOW_BYTES = 524_288

# Sentinel prefix persisted inside the watcher-owned per-file seen_keys set
# (same trick as Copilot's last-text): the accumulated assistant text of the
# still-open turn, so text split across poll batches still rides the next
# turn_complete.
_TEXT_PREFIX = "aider_text::"

# Cap on the pending turn text kept in seen_keys. Keeps BOTH ends so neither
# a leading QUESTION block nor a trailing sentinel line is lost.
_PENDING_TEXT_MAX_CHARS = 32_000


def _history_dir(cwd: str) -> Path:
    """The git root above `cwd` (the cwd itself when there is none) — where
    aider puts its history file, per-pane or shared."""
    base = Path(cwd)
    for candidate in (base, *base.parents):
        try:
            if (candidate / ".git").exists():
                return candidate
        except OSError:
            break
    return base


def aider_history_path(cwd: str) -> Path:
    """`<git-root>/.aider.chat.history.md` for `cwd` (cwd itself when no git
    root exists above it) — mirrors where aider itself puts the file."""
    return _history_dir(cwd) / HISTORY_NAME


def pane_history_name(pane_id: str) -> str:
    """`.aider.chat.history.<pane-token>.md` — the per-pane history file name
    for `pane_id` (first 8 chars of the pane UUID, lowercased). '' when the
    pane id has no usable token (not a UUID), i.e. no per-pane file exists."""
    token = pane_id.strip()[:8].lower()
    return f".aider.chat.history.{token}.md" if _PANE_TOKEN_RE.match(token) else ""


def aider_pane_history_path(cwd: str, pane_id: str) -> Path | None:
    """The pane's OWN history file next to where the shared one would live.
    None when `pane_id` yields no token (pane predates per-pane files)."""
    name = pane_history_name(pane_id)
    return (_history_dir(cwd) / name) if name else None


def history_namespace(path: Path) -> str:
    """Namespace that makes a session slug unique per history FILE: the pane
    token when the name carries one, else a hash of the file's own path (two
    panes in different workspaces can start in the same second)."""
    m = _PANE_FILE_RE.match(path.name)
    if m:
        return m[1]
    try:
        resolved = str(path.resolve())
    except OSError:
        resolved = str(path)
    return hashlib.md5(resolved.encode("utf-8")).hexdigest()[:8]


def is_history_name(name: str) -> bool:
    """True for the legacy shared history file and every per-pane one."""
    return name == HISTORY_NAME or _PANE_FILE_RE.match(name) is not None


def _slug(m: re.Match[str], ns: str) -> str:
    return f"aider-{ns}-{m[1]}{m[2]}{m[3]}-{m[4]}{m[5]}{m[6]}"


def _iso(m: re.Match[str]) -> str:
    return f"{m[1]}-{m[2]}-{m[3]}T{m[4]}:{m[5]}:{m[6]}"


def _parse_count(s: str) -> int:
    """Loosely parse aider's token counts: `1,234`, `12k`, `8.5k`, `567`."""
    s = s.strip().lower().replace(",", "")
    mult = 1
    if s.endswith("k"):
        mult, s = 1000, s[:-1]
    try:
        return max(0, int(float(s) * mult))
    except ValueError:
        return 0


def _cap_text(text: str) -> str:
    if len(text) <= _PENDING_TEXT_MAX_CHARS:
        return text
    half = _PENDING_TEXT_MAX_CHARS // 2
    return f"{text[:half]}\n…\n{text[-half:]}"


def _read_pending_text(seen_keys: set[str]) -> str:
    for k in seen_keys:
        if k.startswith(_TEXT_PREFIX):
            return k[len(_TEXT_PREFIX):]
    return ""


def _write_pending_text(seen_keys: set[str], text: str) -> None:
    seen_keys.difference_update(
        {k for k in seen_keys if k.startswith(_TEXT_PREFIX)}
    )
    if text:
        seen_keys.add(_TEXT_PREFIX + text)


def _read_text_tail(
    path: Path, checkpoint: dict[str, Any]
) -> tuple[list[tuple[int, str]], dict[str, Any], bool]:
    """Read complete text lines after a byte offset (Markdown analogue of
    base.read_jsonl_tail). A partial trailing line is left unread so a later
    append can complete it; identity/shrink checks restart a replaced or
    truncated file from byte 0."""
    stat = path.stat()
    identity = f"{stat.st_dev}:{stat.st_ino}"
    prior_identity = str(checkpoint.get("identity") or "")
    prior_anchor = str(checkpoint.get("anchor") or "")
    offset = max(0, int(checkpoint.get("offset") or 0))
    rotated = bool(offset and (prior_identity != identity or stat.st_size < offset))

    lines: list[tuple[int, str]] = []
    with path.open("rb") as fh:
        # Same dev:ino and no shrink is not proof of the same file (see
        # base.tail_anchor); a checkpoint from before the anchor existed
        # carries none and is trusted as before.
        if offset and not rotated and prior_anchor and tail_anchor(fh, offset) != prior_anchor:
            rotated = True
        if rotated:
            offset = 0
        committed = offset
        fh.seek(offset)
        while True:
            raw = fh.readline()
            if not raw:
                break
            end = fh.tell()
            if not raw.endswith(b"\n"):
                break
            committed = end
            lines.append(
                (end, raw.decode("utf-8", errors="ignore").rstrip("\r\n"))
            )
        anchor = tail_anchor(fh, committed) if committed else ""

    next_checkpoint = dict(checkpoint)
    next_checkpoint.update(
        {"kind": "aider-md", "offset": committed, "identity": identity, "anchor": anchor}
    )
    return lines, next_checkpoint, rotated


class AiderLogReader(LogReader):
    vendor: str = "aider"

    #: parse_activity walks a dense ascending line counter and resumes from
    #: one high-water mark, so an old file can be seeded to EOF by counting
    #: lines rather than replaying it (log_readers.base).
    activity_resumes_by_line: bool = True

    def project_dirs(self) -> list[Path]:
        """Empty — aider keeps no global session root; history files live in
        each workspace and are discovered via session_files_for_workspace."""
        return []

    def session_files(self) -> list[Path]:
        """Empty — global enumeration is impossible (per-project files)."""
        return []

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """The workspace's history files — the legacy shared one plus every
        per-pane one (empty when none exist). Never returns None: an aider
        scan can't be widened beyond the workspace."""
        if not workspace_path:
            return []
        legacy = aider_history_path(workspace_path)
        out: list[Path] = []
        try:
            if legacy.is_file():
                out.append(legacy)
            for p in sorted(legacy.parent.glob(".aider.chat.history.*.md")):
                if _PANE_FILE_RE.match(p.name) and p.is_file():
                    out.append(p)
        except OSError:
            pass
        return out

    # ---- attribution/watch hooks (see log_readers.base.LogReader) --------

    binds_by_marker_file = True
    emits_session_sink = True

    def marker_scan_text(self, path: Path) -> str | None:
        # Only the LAST started-at section is the live session — an earlier
        # section's marker belongs to a historic session and must never
        # bind. Still true for a per-pane file: it too is appended to by
        # every aider run of that pane.
        return self.last_section(path)[1][:524_288]

    def workspace_match(
        self, usage: TokenUsage, ws_path: str,
        owner_workspace: str | None = None,
    ) -> bool | None:
        # The reader emits cwd = the history file's directory (the session's
        # git root). A workspace registered at a subdirectory of that root
        # still maps to the same file.
        if usage.cwd and usage.cwd == ws_path:
            return True
        if usage.file_path:
            fp = Path(usage.file_path)
            if (
                is_history_name(fp.name)
                and fp.parent == aider_history_path(ws_path).parent
            ):
                return True
        return False

    def pane_cwd_match(
        self, usage: TokenUsage, pane_cwd: str, pane_id: str
    ) -> bool | None:
        # The pane's OWN `--chat-history-file` is its file — that is what
        # lets two aider panes in ONE repo discriminate at all. The
        # per-project shared file is claimable only by a pane that has no
        # per-pane file (started before per-pane files existed), never by
        # one that does.
        own = aider_pane_history_path(pane_cwd, pane_id)
        if own is not None:
            if usage.file_path == str(own):
                return True
            try:
                if own.exists():
                    return False
            except OSError:
                return False
        return usage.file_path == str(aider_history_path(pane_cwd))

    def accepts_watch_path(self, path_str: str) -> bool:
        # History files (shared + per-pane) are Markdown; only those exact
        # filenames are accepted so ordinary workspace .md edits can never
        # flood the queue (aider is otherwise driven by the rescan loop —
        # workspace roots get no watchdog subscription).
        return (
            "/.aider.chat.history." in path_str
            and is_history_name(path_str.rsplit("/", 1)[-1])
        )

    def claims_path(self, path: Path) -> bool:
        """Own every `.aider.chat.history.md` and `.aider.chat.history.
        <pane-token>.md`, wherever they live — the files sit inside arbitrary
        workspaces, outside any fixed root."""
        return is_history_name(path.name)

    def cwd_from_file(self, path: Path) -> str:
        """The history file sits at the session's git root (aider's cwd)."""
        return str(path.parent)

    def session_id_from_path(self, path: Path) -> str:
        """The LAST section's started-at slug — the only 'current session'
        an append-only history file can name. '' for other files."""
        if not is_history_name(path.name):
            return ""
        return self.last_section(path)[0]

    def last_section(self, path: Path) -> tuple[str, str]:
        """(session_id_slug, section_text) of the file's last chat section.

        Reads a bounded tail window first; only a (rare) active section
        larger than the window costs a full read. ('', '') when the file is
        unreadable or contains no section header.
        """
        header_prefix = "# aider chat started at "
        try:
            size = path.stat().st_size
            with path.open("rb") as fh:
                if size > _TAIL_WINDOW_BYTES:
                    fh.seek(size - _TAIL_WINDOW_BYTES)
                text = fh.read().decode("utf-8", errors="ignore")
        except OSError:
            return "", ""
        idx = text.rfind("\n" + header_prefix)
        if idx >= 0:
            section = text[idx + 1:]
        elif text.startswith(header_prefix) and size <= _TAIL_WINDOW_BYTES:
            section = text
        elif size > _TAIL_WINDOW_BYTES:
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                return "", ""
            idx = text.rfind("\n" + header_prefix)
            if idx >= 0:
                section = text[idx + 1:]
            elif text.startswith(header_prefix):
                section = text
            else:
                return "", ""
        else:
            return "", ""
        m = _SECTION_RE.match(section)
        return (_slug(m, history_namespace(path)) if m else ""), section

    # ── token events ────────────────────────────────────────────────────────

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        out: list[TokenUsage] = []
        cwd = self.cwd_from_file(path)
        ns = history_namespace(path)
        section = ""
        section_ts = ""
        try:
            fh = path.open(encoding="utf-8", errors="ignore")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return out

        with fh:
            for line_no, raw in enumerate(fh, 1):
                line = raw.rstrip("\r\n")
                m = _SECTION_RE.match(line)
                if m:
                    section, section_ts = _slug(m, ns), _iso(m)
                    continue
                tm = _TOKENS_RE.match(line)
                if tm is None or not section:
                    continue
                input_tokens, output_tokens = _parse_count(tm[1]), _parse_count(tm[2])
                if input_tokens == 0 and output_tokens == 0:
                    continue
                dedup_key = f"aider::{section}::L{line_no}"
                if dedup_key in seen_keys:
                    continue
                seen_keys.add(dedup_key)
                out.append(
                    TokenUsage(
                        vendor="aider",
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cwd=cwd,
                        session_id=section,
                        file_path=str(path),
                        dedup_key=dedup_key,
                        timestamp=section_ts,
                    )
                )
        return out

    def parse_incremental(
        self, path: Path, checkpoint: dict
    ) -> IncrementalParseResult:
        """Parse only complete lines after the persisted byte offset.

        The file is append-only (a shrink means it was replaced → restart
        from 0). The checkpoint carries the current section id so a mid-file
        resume still attributes usage lines to the right session; a usage
        line seen before any header (pre-checkpoint section) is skipped.
        """
        lines, final_checkpoint, rotated = _read_text_tail(path, checkpoint)
        if rotated:
            section, section_ts = "", ""
        else:
            section = str(checkpoint.get("section") or "")
            section_ts = str(checkpoint.get("section_ts") or "")
        cwd = self.cwd_from_file(path)
        ns = history_namespace(path)
        out: list[TokenUsage] = []

        for end, line in lines:
            m = _SECTION_RE.match(line)
            if m:
                section, section_ts = _slug(m, ns), _iso(m)
                continue
            tm = _TOKENS_RE.match(line)
            if tm is None or not section:
                continue
            input_tokens, output_tokens = _parse_count(tm[1]), _parse_count(tm[2])
            if input_tokens == 0 and output_tokens == 0:
                continue
            event_checkpoint = dict(final_checkpoint)
            event_checkpoint.update(
                {"offset": end, "section": section, "section_ts": section_ts}
            )
            out.append(
                TokenUsage(
                    vendor="aider",
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cwd=cwd,
                    session_id=section,
                    file_path=str(path),
                    dedup_key=f"aider::{section}::@{end}",
                    timestamp=section_ts,
                    checkpoint=event_checkpoint,
                )
            )

        final_checkpoint.update({"section": section, "section_ts": section_ts})
        return IncrementalParseResult(out, final_checkpoint)

    # ── activity ────────────────────────────────────────────────────────────

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """agent_active on prompts / new output, turn_complete per usage line.

        Aider writes exactly one `> Tokens:` line after each completed
        assistant message, so that line is the end-of-message signal and
        carries the turn's accumulated assistant text. Caveat: one user
        command can trigger several assistant messages (reflection loops,
        auto-commit messages), each with its own usage line — turn_complete
        here means "an assistant message finished", slightly noisier than an
        explicit end-of-turn record. Consecutive `#### ` prompt lines
        (multi-line input) coalesce into one prompt event; plain assistant/
        tool output coalesces into one `output` event per poll batch.
        """
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        ns = history_namespace(path)
        section = ""
        pending = _read_pending_text(seen_keys)
        prev_prompt = False
        emitted_output = False
        try:
            fh = path.open(encoding="utf-8", errors="ignore")
        except OSError:
            return out

        def _event(event_type: str, dedup_key: str, detail: str, text: str = "") -> ActivityEvent:
            return ActivityEvent(
                vendor="aider", event_type=event_type,
                cwd=cwd, session_id=section, file_path=str(path),
                dedup_key=dedup_key, detail=detail, text=text,
            )

        # Unlike the JSONL readers, this walk never skips a line outright: a
        # seen line still has to update `section` and `prev_prompt`, so only
        # the emitting work is gated on `is_new`. Every line of the file was
        # marked seen — section headers included, blanks included — so the
        # line number of the last one walked is the whole of what the per-line
        # keys recorded. See log_readers.base.
        high_water = activity_high_water(seen_keys)
        last_line = high_water

        with fh:
            for line_no, raw_line in enumerate(fh, 1):
                line = raw_line.rstrip("\r\n")
                is_new = line_no > high_water
                if is_new and not raw_line.endswith("\n"):
                    # An unterminated final line is still being written.
                    # Leave the mark behind it so the completed line is read
                    # on the next poll: advancing past it would drop the
                    # `> Tokens:` line for good if it landed here, which is
                    # the only turn_complete signal aider gives (GitHub #21).
                    break
                key = f"act:{line_no}"
                last_line = line_no
                m = _SECTION_RE.match(line)
                if m:
                    # Header must update the section even when already seen —
                    # every walk restarts from line 1.
                    section = _slug(m, ns)
                    if is_new:
                        pending = ""
                    prev_prompt = False
                    continue
                if not line.strip():
                    continue
                if line.startswith("#### "):
                    if is_new:
                        pending = ""
                        if not prev_prompt:
                            # First line of the (possibly multi-line) prompt;
                            # the frontend names the pane from it.
                            out.append(_event(
                                "agent_active", key, "prompt",
                                text=user_prompt_text(line[5:]),
                            ))
                    prev_prompt = True
                    continue
                prev_prompt = False
                if _TOKENS_RE.match(line):
                    if is_new:
                        out.append(_event(
                            "turn_complete", f"turn:{line_no}", "usage",
                            text=_cap_text(pending),
                        ))
                        pending = ""
                    continue
                if is_new:
                    if not line.startswith(">"):
                        pending = _cap_text(pending + line + "\n")
                    if not emitted_output:
                        out.append(_event("agent_active", key, "output"))
                        emitted_output = True

        set_activity_high_water(seen_keys, last_line)
        _write_pending_text(seen_keys, pending)
        return out


# ---- vendor spec ----------------------------------------------------------

def _session_lookup_path(workspace_path: str, session_id: str) -> Path:
    """Aider has NO session id: resume is the id-less, lossy
    `aider --restore-chat-history`, which re-reads a history file of the
    workspace. The recorded id (a started-at section slug) is informational
    and never names the file — a slug that no longer matches any section
    after aider summarizes history is still restorable by design, so the
    generic is_file() check on this path is the whole preflight. Report the
    first history file that exists (the shared one or any per-pane
    `--chat-history-file`); with none, the shared path, which then fails the
    is_file() check as before."""
    existing = AiderLogReader().session_files_for_workspace(workspace_path)
    if existing:
        return existing[0]
    return aider_history_path(workspace_path)


# Credentials (aider 0.86.2, main.py load_dotenv_files / onboarding.py): the
# CLI has no login of its own — an account is a provider API key. The one file
# aider itself writes is ``~/.aider/oauth-keys.env`` (its OpenRouter OAuth
# flow appends ``OPENROUTER_API_KEY="…"`` there), and it is the FIRST dotenv
# file loaded, so every later ``.env`` on the git-root/cwd search path and
# every ``--*-api-key`` flag or ``.aider.conf.yml`` value overrides it
# (``load_dotenv(override=True)``, so even the process environment loses to a
# ``.env`` file). Profiles therefore park one ``<PROVIDER>_API_KEY`` line of
# that file per scope; whether the pane actually uses it depends on those
# later sources, which the vault cannot see.
AIDER_KEYS_FILE_REL = (".aider", "oauth-keys.env")
AIDER_ACCOUNT_SCOPES = ("openrouter", "openai", "anthropic", "gemini", "deepseek")


def _aider_env_name(scope: str) -> str:
    return f"{scope.upper()}_API_KEY"


def _aider_extract(document: str | None, scope: str) -> str | None:
    if scope not in AIDER_ACCOUNT_SCOPES:
        return None
    return dotenv_extract(document, (_aider_env_name(scope),))


def _aider_merge(document: str | None, scope: str, portion: str | None) -> str:
    if scope not in AIDER_ACCOUNT_SCOPES:
        raise ValueError(f"aider has no credential scope {scope!r}")
    return dotenv_merge(document, (_aider_env_name(scope),), portion)


def identity_from_secret(secret):
    """A scoped slot holds ``{"<PROVIDER>_API_KEY": "<key>"}``: signed in
    when the key is non-empty. A key names no person."""
    data = None
    if secret is not None:
        try:
            data = json.loads(secret)
        except ValueError:
            data = None
    signed_in = isinstance(data, dict) and any(
        isinstance(v, str) and v.strip() for v in data.values()
    )
    return {"email": None, "signedIn": signed_in}


SPEC = VendorSpec(
    key="aider",
    extensions_none_reason="aider has no extension system to show",
    data_dirs_none_reason="aider keeps its files in the workspace, which is not a data root",
    # Provider/model selection is open-ended; no verified default host set.
    expected_hosts=(),
    # History is a configurable workspace FILE, not a dedicated data root.
    # Declaring its parent would scan unrelated repository/user files.
    data_dirs=None,
    # Verified 2026-08-15: aider's package never mentions "skill".
    skills_supported=False,
    # The only vendor here with no session ids at all: resume is
    # `--chat-history-file <path> --restore-chat-history`, so there is nothing
    # for a caller to name. cli_open_agent refuses `session_id` on this key
    # rather than opening a pane that restores something else. That, and the
    # history-file variables a spawn strips, are the launch declaration's.
    **declared("aider"),
    # Multi-account = one provider API key per profile, parked in and
    # restored to ``~/.aider/oauth-keys.env`` (see AIDER_KEYS_FILE_REL).
    # "manual": there is no conversation to resume — the pane is relaunched
    # into a new chat (``--restore-chat-history`` is a lossy summary), which
    # is the user's call, never the transaction's.
    live_file=AIDER_KEYS_FILE_REL,
    slot_file="credential.json",
    identity_from_secret=identity_from_secret,
    account_switch=AccountSwitchSpec(
        auth_scope="aider",
        method="manual",
        store="compound-file",
        evidence="source",
        verified_version="0.86.2",
        scopes=AIDER_ACCOUNT_SCOPES,
        extract=_aider_extract,
        merge=_aider_merge,
        # A later dotenv file overrides even these, but the process
        # environment itself is overridden BY the dotenv files; the flags that
        # win outright are command-line ones, which arrive through the spawn
        # command, not the environment.
        shadowing_env=(),
        resume="lossy",
        todo="a project .env / .aider.conf.yml / --api-key flag overrides the parked key and is invisible to switch_preflight; --restore-chat-history is a lossy summary, so the user must accept a new conversation",
    ),
    session_path=_session_lookup_path,
    make_log_reader=AiderLogReader,
    # Aider updates via the `--upgrade` FLAG (not a subcommand) and ships no
    # doctor. AIDER_CHECK_UPDATE=false is its own startup update-check
    # opt-out; its global state home is fixed at ~/.aider (no relocating
    # env), so config_home_env stays empty. `aider --version` prints
    # `aider X.Y.Z`.
    install_dep=Dep("aider", "Aider", "Aider AI pair-programming CLI", "agent_cli",
        ["aider", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -LsSf https://aider.chat/install.sh | sh",
        needs_terminal=True, requires_binaries=("curl",), optional=True,
        docs_url="https://aider.chat",
        # Windows: verbatim from https://aider.chat/docs/install.html
        install_cmds={"win32": PlatformInstall(
            'powershell -ExecutionPolicy ByPass -c "irm https://aider.chat/install.ps1 | iex"',
            needs_terminal=True)},
        # `--upgrade` says "from PyPI" while install_cmd above installs through
        # uv, so the two look mismatched. Verified against a real install (uv
        # tool, aider 0.86.2): it works. get_pip_install() builds
        # `sys.executable -m pip install --upgrade aider-chat`, and uv's tool
        # venv ships pip, so the command runs. It is also the more portable
        # choice than `uv tool upgrade` — it upgrades a pip install too.
        # Two consequences worth knowing: it prompts ("Run pip install?") so
        # the update pane waits on the user, and writing into uv's venv with
        # pip leaves uv's own tool metadata stating the old version.
        update_cmd="aider --upgrade",
        latest_source="pypi:aider-chat",
        autoupdate_env="AIDER_CHECK_UPDATE"),
)
