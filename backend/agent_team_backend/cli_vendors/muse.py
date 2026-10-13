"""Meta Muse Code — spawn, install detection, resume parsing and log reader.

Muse Code is a terminal coding agent Meta released in beta for macOS and
Linux; it installs from a shell script rather than a package manager and is
driven by the ``muse`` binary (``muse exec`` for headless runs). Resuming from
the CLI is the subcommand ``muse resume <id>``, which is the shape
``resume_id_from_command`` parses back out.

Session log layout (data root = ``$XDG_DATA_HOME``, default
``~/.local/share``)::

  <data-root>/muse/sessions/<YYYY>/<MM>/<DD>/<session-id>/session.jsonl
  <data-root>/muse/sessions/.../<session-id>/subagent/<child-id>/session.jsonl
  <data-root>/muse/sessions/.../<session-id>/tool-outputs/

The three date levels are the LOCAL date the session opened, and the session
DIRECTORY's name is the session id (every log file is named session.jsonl).

Every line is an envelope::

  {"schema_version":1,"id":"…","stream":{"kind":"session","id":"<session-id>"},
   "sequence":42,"recorded_at":1786491820389652,"record_type":"event",
   "payload_type":"runtime.session","payload":{"kind":"run","event":{…}}}

``stream.id`` equals the directory name and is the only id ``muse resume``
accepts. The ids INSIDE the payload — ``event.record.owner.session_id``,
``command_intake``'s ``command_id`` and ``session_stream.id`` — are internal
COMMAND ids and differ from it (observed: directory ``b3ef50f0-…`` alongside
``owner.session_id`` ``4c39ad2b-…``); binding to one of those makes every
resume fail, so the session id is only ever taken from the directory name.

``recorded_at`` is a MICROsecond unix timestamp (16 digits) and ``sequence``
increases monotonically.

Field map (every entry verified against real session files):

  cwd            payload_type ``runtime.session.metadata``
                 -> ``payload.record.workspace_root``
  user prompt    payload_type ``runtime.command_intake.received``
                 -> ``payload.record.command.prompt``, only when
                 ``payload.record.command.kind == "turn_submit"``
  assistant text ``event.kind == "assistant_message_committed"``
                 -> ``event.text``
  turn end       ``event.kind == "terminal"`` -> ``event.terminal``
                 (observed "completed"/"failed"; also ``reason``,
                 ``turn_duration_ms``) — an EXPLICIT end-of-turn record, so
                 nothing here infers a turn boundary from silence
  tokens         ``event.kind == "goal_usage_attribution"`` ->
                 ``event.record.quantity.{input,output,cached,reasoning}_tokens``
                 deduped on ``event.record.usage_id``

Token mapping into TokenUsage — the four quantity fields are NOT added up;
``cached_tokens`` and ``reasoning_tokens`` are breakdown detail already
contained in the two totals::

  input_tokens  = quantity.input_tokens
  output_tokens = quantity.output_tokens

muse's own JSONL event schema is not published (``goal_usage_attribution``
appears nowhere in Meta's docs), so this is INFERRED from the semantics of the
Meta Model API that muse runs on — not from a muse definition. The three
upstream statements it rests on:

* https://dev.meta.ai/docs/prompt-caching.md — "``cached_tokens`` is a subset
  of your input tokens, not an extra charge. The cached prefix is still
  counted once in ``input_tokens``".
* https://dev.meta.ai/docs/reasoning.md — "Reasoning tokens count toward both
  your output-token limit and billed completion tokens".
* https://dev.meta.ai/docs/protocols/responses.md — the usage example is
  ``{input_tokens: 69, output_tokens: 163, total_tokens: 232}`` (69 + 163 =
  232), with the breakdown living in ``input_tokens_details.cached_tokens``
  and ``output_tokens_details.reasoning_tokens``. muse's four flat fields are
  that object with the ``*_details`` nesting flattened away.

Same-shaped precedent: copilot's ``assistant_usage_events.input_tokens``
likewise already includes cache reads (measured: 19898 = 9 + 0 + 19889), and
the additive fold there over-reported by roughly double until it was changed
to pass the fields through as-is. (Anthropic is the counterexample that stops
this being generalised: its cache fields ARE additive by documented
definition, so the answer has to come from the provider behind each CLI.)

STILL TO VERIFY, and the only thing that turns the inference into fact: run a
real muse session against a NON-echo provider and confirm
``cached_tokens <= input_tokens`` and ``reasoning_tokens <= output_tokens``.
Every ``goal_usage_attribution`` row in every local session is ALL ZERO (they
were recorded with ``--provider echo``), so ``_main_usage`` returns None for
all of them and the token path has only ever run on synthetic fixtures.

Only rows with ``event.record.owner.requester_kind == "main"`` are counted:
a subagent's usage is attributed into the PARENT log too, and the child's own
``subagent/<id>/session.jsonl`` repeats it, so counting the non-main rows —
or the child files — would double-count. ``event.kind == "model_completed"``
carries the same figures per model call (``event.usage.*`` plus
``duration_ms``) and is deliberately not counted for the same reason.
``quantity.reported`` is a bool the log carries but nothing here filters on:
an unreported row that is genuinely empty is already dropped by the
all-zero check.

Kickoff markers work: ``at-pane:<id>`` lands verbatim in the intake record's
prompt, so marker binding reads it straight out of the file.

Capabilities still unset on purpose:

* ``session_path`` — a known id maps to a directory name, but not to a single
  path: the three date levels are the (unknown) day the session opened. The
  discoverable form is ``session_exists``, which globs those levels.
* credential fields, ``login_home_env``, ``fetch_usage`` — Meta documents
  ``META_API_KEY``, ``muse auth set`` and ``muse logout``, but not where a
  stored credential lives, and no env var relocating the config home
  (settings are read from ``~/.config/muse/settings.json``). Quota is a web
  dashboard only; there is no CLI usage command to call.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    activity_high_water,
    read_jsonl_tail,
    set_activity_high_water,
    user_prompt_text,
)
from .base import ExtensionsSource, ExtensionsSpec  # noqa: F401
from .base import (
    PlatformInstall,
    AccountSwitchSpec,
    Dep,
    SkillsWiring,
    VendorSpec,
    command_text,
    provider_map_extract,
    provider_map_merge,
)

log = logging.getLogger("agent_team_backend.log_readers.muse")

_SESSION_FILE = "session.jsonl"
_SUBAGENT_DIR = "subagent"
#: runtime.session.metadata is the log's first record; a short head scan finds
#: workspace_root without reading a session that has grown to megabytes.
_METADATA_SCAN_LINES = 20
_RECENT_KEYS_MAX = 64
#: Sentinel prefix inside parse_activity's seen_keys set: the assistant text
#: and the terminal record are separate LINES, so the text has to survive
#: between calls (line dedup means a later call never re-reads it).
_TEXT_PREFIX = "muse_text::"
_TEXT_MAX_CHARS = 4_000
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")

#: runtime.session event kinds that prove the agent is doing work. Muse logs
#: its internal task graph in the same stream, so this is a whitelist rather
#: than "every run event": the diagnostic/configuration kinds
#: (context_block_diagnostic, model_request_configured, task_stream_linked,
#: model_input_trace_recorded, resource_usage_sampled, …) say nothing about
#: progress. `side_effect_intent` is muse's closest analogue to a tool_use
#: record — it is where an actual side effect is declared.
_ACTIVE_EVENT_KINDS = frozenset({
    "started",
    "assistant_message_committed",
    "side_effect_intent",
    "model_completed",
    "completed",
    "failed",
})


def muse_data_root() -> Path:
    """Muse's XDG data directory (``$XDG_DATA_HOME``, default
    ``~/.local/share``) — the parent of ``sessions/``."""
    env = (os.environ.get("XDG_DATA_HOME") or "").strip()
    base = Path(env) if env else Path.home() / ".local" / "share"
    return base / "muse"


def muse_sessions_root() -> Path:
    """Root holding the ``<YYYY>/<MM>/<DD>/<session-id>/`` session tree."""
    return muse_data_root() / "sessions"


def _is_main_session_file(path: Path) -> bool:
    """True for a MAIN session's log, false for a subagent's and for siblings.

    A subagent log sits at ``<session>/subagent/<child>/session.jsonl``, so its
    grandparent is literally named ``subagent`` while a main session's
    grandparent is the day directory. Everything else in the session dir
    (.session.lock, cron.db, tool-outputs/) fails the filename test.
    """
    return path.name == _SESSION_FILE and path.parent.parent.name != _SUBAGENT_DIR


def _same_path(a: str, b: str) -> bool:
    """Path equality tolerant of symlinked roots.

    ``workspace_root`` records the RESOLVED launch dir (measured:
    ``/private/tmp/…`` on macOS) while a pane may carry the symlink form
    (``/tmp/…``), so a plain string compare drops those events.
    """
    if not a or not b:
        return False
    if a == b:
        return True
    try:
        return os.path.realpath(a) == os.path.realpath(b)
    except OSError:
        return False


def _iso_from_micros(value: Any) -> str:
    """``recorded_at`` (microsecond unix timestamp) as ISO 8601 ('' when
    unusable). Activity events must carry the record's OWN time: the frontend
    dedups messaging turns by timestamp and treats an unparseable one as
    always-fresh, which would resend a turn after a backend restart."""
    try:
        micros = int(value)
    except (TypeError, ValueError):
        return ""
    try:
        return datetime.fromtimestamp(micros / 1_000_000, timezone.utc).isoformat()
    except (OSError, OverflowError, ValueError):
        return ""


def _int(v: Any) -> int:
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _cap_text(text: str) -> str:
    if len(text) <= _TEXT_MAX_CHARS:
        return text
    half = _TEXT_MAX_CHARS // 2
    return f"{text[:half]}\n…\n{text[-half:]}"


def _read_sentinel(seen_keys: set[str], prefix: str) -> str:
    for k in seen_keys:
        if k.startswith(prefix):
            return k[len(prefix):]
    return ""


def _write_sentinel(seen_keys: set[str], prefix: str, value: str) -> None:
    seen_keys.difference_update({k for k in seen_keys if k.startswith(prefix)})
    if value:
        seen_keys.add(f"{prefix}{value}")


def _run_event(rec: dict) -> dict | None:
    """The ``payload.event`` of a ``runtime.session`` envelope (None for any
    other payload_type, and for the run-start envelope that has no event)."""
    if rec.get("payload_type") != "runtime.session":
        return None
    payload = rec.get("payload")
    event = payload.get("event") if isinstance(payload, dict) else None
    return event if isinstance(event, dict) else None


def _payload_record(rec: dict) -> dict | None:
    """``payload.record`` of a non-run envelope (metadata, command_intake)."""
    payload = rec.get("payload")
    record = payload.get("record") if isinstance(payload, dict) else None
    return record if isinstance(record, dict) else None


def _turn_prompt(rec: dict) -> str | None:
    """The user's prompt from a ``runtime.command_intake.received`` envelope,
    or None when this is not a submitted turn (slash commands, cancels and
    other intake kinds are not user turns)."""
    if rec.get("payload_type") != "runtime.command_intake.received":
        return None
    record = _payload_record(rec)
    command = record.get("command") if record is not None else None
    if not isinstance(command, dict) or command.get("kind") != "turn_submit":
        return None
    return str(command.get("prompt") or "")


def _main_usage(event: dict) -> tuple[str, int, int] | None:
    """``(usage_id, input_tokens, output_tokens)`` for a MAIN-requester
    ``goal_usage_attribution``; None for every other event, for a subagent's
    attribution row, and for an all-zero row (nothing to add).

    ``cached_tokens`` and ``reasoning_tokens`` are deliberately NOT added:
    per the Meta Model API docs cited in the module docstring, the cached
    prefix is a subset of ``input_tokens`` and reasoning is billed inside
    ``output_tokens``, so adding either would double-count. That is inferred
    from the upstream API (muse's own event schema is unpublished) plus the
    measured copilot precedent — verify it by running a session against a
    non-echo provider and checking ``cached_tokens <= input_tokens`` and
    ``reasoning_tokens <= output_tokens``.

    The ``requester_kind == "main"`` filter remains UNVERIFIED: it assumes
    subagent usage arrives under a different value. Only ``"main"`` has ever
    been observed locally; no subagent attribution row has been seen at all,
    so nothing proves this filter drops anything (or that it does not drop
    rows it should keep).

    Both are unexercised because every local ``goal_usage_attribution`` row is
    all zero (``--provider echo`` runs), which this function rejects before
    either decision matters; the tests covering them are fixtures written from
    the same reasoning, not evidence.
    """
    if event.get("kind") != "goal_usage_attribution":
        return None
    record = event.get("record")
    if not isinstance(record, dict):
        return None
    owner = record.get("owner")
    if not isinstance(owner, dict) or owner.get("requester_kind") != "main":
        return None
    quantity = record.get("quantity")
    if not isinstance(quantity, dict):
        return None
    usage_id = str(record.get("usage_id") or "")
    if not usage_id:
        return None
    input_tokens = _int(quantity.get("input_tokens"))
    output_tokens = _int(quantity.get("output_tokens"))
    if input_tokens == 0 and output_tokens == 0:
        return None
    return usage_id, input_tokens, output_tokens


class MuseLogReader(LogReader):
    vendor: str = "muse"

    #: parse_activity walks a dense ascending line counter and resumes from
    #: one high-water mark, so an old file can be seeded to EOF by counting
    #: lines rather than replaying it (log_readers.base).
    activity_resumes_by_line: bool = True

    def project_dirs(self) -> list[Path]:
        root = muse_sessions_root()
        return [root] if root.is_dir() else []

    def watch_dirs(self) -> list[Path]:
        """Watch the stable ancestor that exists.

        The date directories are created per local day — a session started
        after the backend booted lands in a directory nobody subscribed to —
        and on a machine that has never run muse the whole tree is missing.
        Watches are recursive, so subscribing ``sessions/`` covers every future
        day, and falling back to the muse data root covers the first run ever
        (the watcher re-checks this list each rescan, so the narrower root is
        picked up as soon as it appears).
        """
        root = muse_sessions_root()
        if root.is_dir():
            return [root]
        parent = root.parent
        return [parent] if parent.is_dir() else []

    def session_files(self) -> list[Path]:
        """Every MAIN session log: exactly ``<Y>/<M>/<D>/<id>/session.jsonl``.

        The four-level glob already stops at the session directory, so the
        deeper ``subagent/<child>/session.jsonl`` logs are never enumerated;
        the explicit filter keeps that intent visible (counting a child log
        would double-count its tokens, which the parent already attributes).
        """
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for f in root.glob(f"*/*/*/*/{_SESSION_FILE}"):
                    if f.is_file() and _is_main_session_file(f):
                        out.append(f)
            except OSError as err:
                log.debug("glob %s failed: %s", root, err)
        return out

    def _metadata_record(self, path: Path) -> dict | None:
        """The ``runtime.session.metadata`` record (the log's first row)."""
        try:
            with path.open(encoding="utf-8", errors="replace") as fh:
                for _ in range(_METADATA_SCAN_LINES):
                    line = fh.readline()
                    if not line:
                        break
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(rec, dict):
                        continue
                    if rec.get("payload_type") != "runtime.session.metadata":
                        continue
                    return _payload_record(rec)
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
        return None

    def cwd_from_file(self, path: Path) -> str:
        """The session's exact cwd, from the ``runtime.session.metadata``
        record's ``workspace_root`` (the log's first row)."""
        record = self._metadata_record(path)
        return str(record.get("workspace_root") or "") if record is not None else ""

    def version_from_file(self, path: Path) -> str:
        """The CLI build that wrote the session (metadata ``build.semver``)."""
        record = self._metadata_record(path)
        build = record.get("build") if record is not None else None
        return str(build.get("semver") or "") if isinstance(build, dict) else ""

    def session_id_from_path(self, path: Path) -> str:
        """The session id is the DIRECTORY name — every log file is called
        session.jsonl, so the stem carries nothing. Returns '' for siblings
        and for subagent logs so the resume-binding sink never coins an id
        that ``muse resume`` would reject."""
        return path.parent.name if _is_main_session_file(path) else ""

    def has_session(self, session_id: str) -> bool:
        """True when some day directory holds ``<session_id>/session.jsonl``.

        The date levels are not derivable from an id, so they are globbed. The
        id is shape-checked first: it is interpolated into a glob pattern, and
        a stray ``*`` or ``[`` would otherwise match a different session.
        """
        session_id = session_id.strip()
        if not session_id or not _SESSION_ID_RE.match(session_id):
            return False
        for root in self.project_dirs():
            try:
                for f in root.glob(f"*/*/*/{session_id}/{_SESSION_FILE}"):
                    if f.is_file():
                        return True
            except OSError:
                continue
        return False

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        out: list[TokenUsage] = []
        cwd = self.cwd_from_file(path)
        cli_version = self.version_from_file(path)
        session_id = self.session_id_from_path(path)
        try:
            fh = path.open(encoding="utf-8")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return out

        with fh:
            for line_no, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    log.debug("%s:%d malformed JSON, skipping", path.name, line_no)
                    continue
                if not isinstance(rec, dict):
                    continue
                event = _run_event(rec)
                if event is None:
                    continue
                usage = _main_usage(event)
                if usage is None:
                    continue
                usage_id, input_tokens, output_tokens = usage
                if usage_id in seen_keys:
                    continue
                seen_keys.add(usage_id)
                out.append(TokenUsage(
                    vendor="muse",
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cwd=cwd,
                    session_id=session_id,
                    file_path=str(path),
                    dedup_key=usage_id,
                    timestamp=_iso_from_micros(rec.get("recorded_at")),
                    cli_version=cli_version,
                ))
        return out

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """Parse only complete JSONL records after the persisted byte offset.

        Muse appends whole envelopes, so a byte offset plus a short recent
        usage_id window guarantees no double count across a rotation.
        """
        if not _is_main_session_file(path):
            return IncrementalParseResult([], dict(checkpoint))
        records, final_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        recent = (
            [] if rotated
            else [str(k) for k in checkpoint.get("recent_keys", [])][-_RECENT_KEYS_MAX:]
        )
        recent_set = set(recent)
        out: list[TokenUsage] = []
        session_id = self.session_id_from_path(path)
        # The cwd lives in the log's FIRST record, which a tail read has
        # normally already passed — read the head separately for it.
        cwd = self.cwd_from_file(path)
        cli_version = self.version_from_file(path)

        for end, rec in records:
            if rec is None:
                continue
            event = _run_event(rec)
            if event is None:
                continue
            usage = _main_usage(event)
            if usage is None:
                continue
            usage_id, input_tokens, output_tokens = usage
            if usage_id in recent_set:
                continue
            recent.append(usage_id)
            recent = recent[-_RECENT_KEYS_MAX:]
            recent_set = set(recent)
            event_checkpoint = dict(final_checkpoint)
            event_checkpoint["offset"] = end
            event_checkpoint["recent_keys"] = list(recent)
            out.append(TokenUsage(
                vendor="muse",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cwd=cwd,
                session_id=session_id,
                file_path=str(path),
                dedup_key=usage_id,
                timestamp=_iso_from_micros(rec.get("recorded_at")),
                checkpoint=event_checkpoint,
                cli_version=cli_version,
            ))

        final_checkpoint["recent_keys"] = recent
        return IncrementalParseResult(out, final_checkpoint)

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for user prompts and work events, and
        `turn_complete` on the explicit ``terminal`` record.

        Muse writes a real end-of-turn record, so unlike qwen/pi nothing here
        infers a boundary from silence — a pane parked on a long tool call or
        a permission prompt is never mistaken for a finished one.

        The turn's assistant text arrives on an EARLIER line than ``terminal``,
        and line-level dedup means a later call will not re-read it, so the
        text is carried in a seen_keys sentinel between calls and cleared once
        a turn has claimed it.
        """
        if not _is_main_session_file(path):
            return []
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        session_id = self.session_id_from_path(path)
        last_text = _read_sentinel(seen_keys, _TEXT_PREFIX)

        try:
            fh = path.open(encoding="utf-8")
        except OSError:
            return out

        # The line is marked the moment it passes the seen test, before any
        # parse or branch can skip it, and the walk is a dense ascending scan
        # from line 1 — so one high-water mark holds exactly what the per-line
        # keys held, and does not grow with the session. See log_readers.base.
        high_water = activity_high_water(seen_keys)
        last_line = high_water

        try:
            with fh:
                for line_no, raw_line in enumerate(fh, 1):
                    raw = raw_line.strip()
                    if not raw:
                        continue
                    if line_no <= high_water:
                        continue
                    key = f"act:{line_no}"
                    try:
                        rec = json.loads(raw)
                    except json.JSONDecodeError:
                        # An unterminated final line is still being written.
                        # Leave the mark behind it so the completed line is
                        # read on the next poll: advancing past it dropped
                        # that line's events for good, and when the lost line
                        # was the turn's end record the pane stayed
                        # "mid-turn" forever (GitHub #21).
                        if not raw_line.endswith("\n"):
                            break
                        # A terminated line that will not parse is genuinely
                        # corrupt. Step over it for good rather than
                        # re-reading — and re-emitting — the rest of the file
                        # on every poll.
                        last_line = line_no
                        continue
                    last_line = line_no
                    if not isinstance(rec, dict):
                        continue
                    ts = _iso_from_micros(rec.get("recorded_at"))

                    prompt = _turn_prompt(rec)
                    if prompt is not None:
                        # detail="user" is part of the cross-end contract: the
                        # frontend names a pane from the first user-prompt event.
                        out.append(ActivityEvent(
                            vendor="muse", event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts, detail="user",
                            text=user_prompt_text(prompt),
                        ))
                        continue

                    event = _run_event(rec)
                    if event is None:
                        continue
                    kind = str(event.get("kind") or "")

                    if kind == "assistant_message_committed":
                        reply = str(event.get("text") or "").strip()
                        if reply:
                            last_text = _cap_text(reply)

                    if kind in _ACTIVE_EVENT_KINDS:
                        out.append(ActivityEvent(
                            vendor="muse", event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts, detail=kind,
                        ))

                    if kind == "terminal":
                        # Any terminal value ends the turn — the pane is idle
                        # again whether the run completed or failed — and the
                        # value itself rides in `detail`.
                        out.append(ActivityEvent(
                            vendor="muse", event_type="turn_complete",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=f"turn:{line_no}", timestamp=ts,
                            detail=str(event.get("terminal") or ""),
                            text=last_text,
                        ))
                        last_text = ""

        finally:
            set_activity_high_water(seen_keys, last_line)
            _write_sentinel(seen_keys, _TEXT_PREFIX, last_text)
        return out

    # ---- attribution/watch hooks (see log_readers.base.LogReader) --------

    #: `at-pane:<id>` lands verbatim in the intake record's prompt, near the
    #: head of the file, so the generic marker read finds it.
    binds_by_marker_file = True
    emits_session_sink = True
    #: A resumed session opens a NEW session directory and gets no kickoff
    #: marker; the single-unbound-candidate fallback is what captures its id.
    binds_new_session_single_candidate = True

    def workspace_match(
        self, usage: TokenUsage, ws_path: str,
        owner_workspace: str | None = None,
    ) -> bool | None:
        # Reader emits cwd = metadata.workspace_root, the session's exact cwd
        # in its RESOLVED form, so compare through realpath.
        return _same_path(usage.cwd, ws_path)

    def pane_cwd_match(
        self, usage: TokenUsage, pane_cwd: str, pane_id: str
    ) -> bool | None:
        return _same_path(usage.cwd, pane_cwd)


# ---- resume / session ------------------------------------------------------

_RESUME_RE = re.compile(r"^muse\s+resume\s+(\S+)")


def _resume_id_from_command(command) -> str:
    """Session id from a `muse resume <id> ...` command ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return m.group(1) if m else ""


def _session_exists(workspace_path: str, session_id: str) -> bool:
    # Sessions are filed by DATE, not by workspace, so the workspace argument
    # cannot narrow the search; the reader globs the date levels for the
    # session directory. `session_path` stays unset because the same fact cuts
    # the other way: an id maps to a directory NAME, and only a scan can say
    # which day it lives under, so there is no single path to return.
    return MuseLogReader().has_session(session_id)


# ---- vendor spec -----------------------------------------------------------

# Credential store, from Meta's own launcher script (`muse` 1.3.0 is a bash
# launcher that reads the file read-only before delegating to the binary):
# ``$XDG_CONFIG_HOME/muse/auth.json``, default ``~/.config/muse/auth.json``,
# overridable with ``MUSE_AUTH_PATH``; document ``{"providers": {"meta":
# {"mechanism": "oauth", "access_token": ..., "expires_at": <epoch s>}}}``.
# Only the ``meta`` provider is an account, so that is the one scope; other
# ``providers`` keys are left alone by a switch.
MUSE_AUTH_FILE_REL = (".config", "muse", "auth.json")
MUSE_AUTH_PATH_ENV = "MUSE_AUTH_PATH"


def _muse_auth_file(home: Path, env: dict | None = None) -> Path:
    env = os.environ if env is None else env
    explicit = env.get(MUSE_AUTH_PATH_ENV)
    if explicit:
        return Path(explicit)
    xdg = env.get("XDG_CONFIG_HOME")
    return Path(xdg) / "muse" / "auth.json" if xdg else home.joinpath(*MUSE_AUTH_FILE_REL)


def _muse_extract(document: str | None, scope: str) -> str | None:
    return provider_map_extract(document, scope, path=("providers",))


def _muse_merge(document: str | None, scope: str, portion: str | None) -> str:
    return provider_map_merge(document, scope, portion, path=("providers",))


def identity_from_secret(secret):
    """A scoped slot holds the ``providers.meta`` entry: signed in when it
    is an oauth entry with an access token. The file carries no email."""
    data = None
    if secret is not None:
        try:
            data = json.loads(secret)
        except ValueError:
            data = None
    signed_in = (
        isinstance(data, dict)
        and data.get("mechanism") == "oauth"
        and isinstance(data.get("access_token"), str)
        and bool(data["access_token"])
    )
    return {"email": None, "signedIn": signed_in}


# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(sources=(
    ExtensionsSource("cli-json", type_label="Muse plugin", list_argv=("muse", "plugins", "list", "--json"),
        section=("plugins",), native_consent="capability-approve"),
))

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="muse",
    # Login/usage observations do not establish Muse's CLI service host set.
    expected_hosts=(),
    # Same dedicated XDG root as muse_data_root, with the pane's HOME shim.
    data_dirs=lambda ctx: (ctx.path(ctx.env.get("XDG_DATA_HOME", "").strip() or ctx.home / ".local" / "share") / "muse",),
    data_dir_env_vars=("XDG_DATA_HOME",),
    supports_model=True,
    supports_effort=True,
    known_efforts=('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'),
    # Verified 2026-08-15: `muse skills list --source user` reports skills
    # from ~/.claude/skills and ~/.agents/skills. Only HOME relocates those,
    # so this is the one vendor whose shim exists for skills alone.
    skills_supported=True,
    skills_wiring=SkillsWiring(
        root_env="HOME",
        reads_shared_root=True,
        skills_rel=(".agents", "skills"),
    ),
    label="Muse Code (Meta)",
    # `muse login` signs in with a Meta account by having the user approve a
    # code in the browser — a flow a PTY pane can carry. Note META_API_KEY
    # still takes priority over the account login if it is set in the
    # environment. Verified against `muse login --help`, 2026-09-18.
    login_command_args="login",
    # Quota exhaustion text from the 1.3.0 binary's error/goal-status strings
    # ("usage limit reached" is a distinct class from "rate limited") and the
    # quota_hit session failure entry. Source-read only.
    quota_exhausted_patterns=(
        r"(usage limit reached|limited by budget|provider_tier_limit|quota_hit)",
    ),
    # Multi-account: the ``providers.meta`` entry of the launcher-documented
    # auth.json is the account. ``MUSE_AUTH_PATH`` names a FILE, not a home,
    # so it cannot serve as ``login_home_env`` (the vault hands a directory
    # over) — a sign-in runs against the real file and is captured after.
    # The launcher reads the file once per run: restart, then
    # ``muse --resume <id>``.
    live_file=MUSE_AUTH_FILE_REL,
    live_file_resolver=lambda home: _muse_auth_file(home),
    slot_file="auth.json",
    identity_from_secret=identity_from_secret,
    account_switch=AccountSwitchSpec(
        auth_scope="muse",
        method="restart",
        store="compound-file",
        evidence="source",
        verified_version="1.3.0",
        scopes=("meta",),
        extract=_muse_extract,
        merge=_muse_merge,
        # `muse login --help`: META_API_KEY takes priority over the login.
        shadowing_env=("META_API_KEY",),
        resume="native",
        todo="layout from Meta's launcher script only (the binary's own writer not inspected); META_API_KEY in the pane env shadows the file; no real-account round-trip recorded",
    ),
    resume_id_from_command=_resume_id_from_command,
    session_exists=_session_exists,
    make_log_reader=MuseLogReader,
    install_dep=Dep(
        "muse", "Muse Code (Meta)", "Meta Muse Code CLI", "agent_cli",
        ["muse", "--version"],
        install_cmd="curl -fsSL https://dev.meta.ai/install.sh | sh",
        needs_terminal=True, requires_binaries=("curl",), optional=True,
        docs_url="https://dev.meta.ai/products/muse-code",
        # Windows: the official PowerShell installer, per
        # https://dev.meta.ai/docs/muse-code
        install_cmds={"win32": PlatformInstall(
            "irm https://dev.meta.ai/install.ps1 | iex", needs_terminal=True)}),
)
