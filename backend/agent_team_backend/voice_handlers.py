"""WebSocket side of push-to-talk voice input (``voice.*``).

Handlers are registered in ws_handlers. One recording at a time: a window
streams base64 s16le mono 16 kHz PCM with ``voice.chunk`` between
``voice.start`` and ``voice.stop``. Nothing here runs until a ``voice.*``
message arrives.

While recording, a per-take loop pushes ``voice.partial`` {sessionId, seq,
committed, tentative} to the recording window about once a second
(LocalAgreement-2 over whisper segments): only the uncommitted window of
audio (about ``WINDOW_CAP_BYTES`` at most) is transcribed; leading segments
(clauses) that two consecutive hypotheses agree on — never the last one, which
may end mid-word — are committed up to a boundary whose timestamp is
trustworthy. Timestamps are only approximate (on a window that ends
mid-speech they can be seconds late), so the next window starts
``_OVERLAP_BYTES`` before that boundary, every new hypothesis — and the tail
pass on stop — first drops the text that repeats the end of the committed text
(``_strip_overlap``, an alignment like whisper_streaming's n-gram overlap
removal), and an advance only stands once the first hypothesis of the new
window re-hears that committed text; otherwise the window steps back toward
where it started (never so far that it outgrows ``WINDOW_CAP_BYTES``), so a
late boundary cannot lose words. ``committed`` only ever grows. Stop transcribes what is left of
the window (again from before an advance its tail does not re-hear) and
answers ``committed + tail``, so the final text always starts with the last
committed text the window was shown.
"""

from __future__ import annotations

import array
import asyncio
import base64
import binascii
import contextlib
import logging
import math
import operator
import os
import re
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import stt_service
from .ipc import make_event, make_response

if TYPE_CHECKING:
    from .app import Session

log = logging.getLogger(__name__)

_BYTES_PER_SECOND = 16_000 * 2
# Hands-free (locked / toggle) takes run up to 5 minutes; hold-to-talk stops
# itself at 60 s in the window.
MAX_PCM_BYTES = _BYTES_PER_SECOND * 300
MIN_PCM_BYTES = int(_BYTES_PER_SECOND * 0.3)
# Whole-take s16 peak below this is a mic that delivered (near-)digital
# silence — a denied/misattributed TCC grant or a dead device — not a quiet
# speaker. ~NT-type's RMS < 0.002 of full scale (pipeline.rs SILENCE_PEAK).
SILENT_PEAK = 64
# Zeros appended before transcription: Whisper clips the last word of audio
# that ends mid-syllable.
_TAIL_PAD_BYTES = _BYTES_PER_SECOND // 2
# A recording whose window stopped talking to us (crashed mid-press) must not
# hold the recorder forever: past the 5 min cap plus slack it is abandoned.
_STALE_AFTER_S = 330.0
DEFAULT_LANGUAGE = "zh"
# Same as the sidecar's DEFAULT_INITIAL_PROMPT; restated here because a
# partial's prompt is this plus the tail of the committed text.
DEFAULT_INITIAL_PROMPT = "以下是繁體中文語音記錄。"
# Chinese scripts the sidecar can convert transcripts to (its `script` field).
SCRIPTS = ("hant-tw", "hans", "none")
# Time between the starts of two partials. The loop polls every
# _PARTIAL_POLL_S, so the first partial starts as soon as it is due and one
# that follows a slow partial starts as soon as that one is done.
PARTIAL_INTERVAL_S = 1.0
_PARTIAL_POLL_S = 0.05
# A partial needs this much audio it has not heard yet, and a window at least
# _PARTIAL_MIN_WINDOW_BYTES long.
_PARTIAL_MIN_NEW_BYTES = _BYTES_PER_SECOND // 2
_PARTIAL_MIN_WINDOW_BYTES = _BYTES_PER_SECOND
# A partial is cancelled (the sidecar aborts it) once it runs this many times
# longer than recent partials took, and never before _PARTIAL_BUDGET_MIN_S.
# Whisper sometimes hallucinates a repetition at the end of a window cut
# mid-speech and decodes it to its token limit, then again at each fallback
# temperature: seconds for a window that normally takes a fraction of one,
# more under load. Partials are optional; the next one hears more audio. A
# cancelled partial counts as having taken its budget, so when every decode
# slows down (load) the budget grows instead of cancelling them all.
_PARTIAL_BUDGET_FACTOR = 3.0
_PARTIAL_BUDGET_MIN_S = 2.0
# A window this long commits all but its last segment even without agreement.
WINDOW_CAP_BYTES = _BYTES_PER_SECOND * 16
# Segment boundaries usable as cut points (see _trusted).
_MIN_SEG_BYTES = _BYTES_PER_SECOND // 5
_BOUNDARY_MARGIN_BYTES = _BYTES_PER_SECOND * 3 // 10
# Audio before a committed boundary that the next window hears again, so a
# boundary timestamp that is late (or early) loses no words; the repeated
# words are removed as text (_strip_overlap). Committed text inside a window
# may be longer after a rollback, hence the generous suffix compared.
_OVERLAP_BYTES = _BYTES_PER_SECOND * 3 // 2
_OVERLAP_MAX_CHARS = 64
# Leading characters of a hypothesis that may be a clipped word before the
# overlap match starts, and the alignment score (+2 per matching character,
# -1 per mismatch or gap) that counts as having re-heard the committed text.
_OVERLAP_MAX_SKIP = 4
_OVERLAP_MIN_SCORE = 5
# Characters past the shortest best alignment that may still count as overlap
# when they reach a segment end with the same score (see _overlap_len).
_OVERLAP_MAX_TIE = 2
# Committed text carried in the prompt for context (whisper keeps <=224 tokens).
_PROMPT_TAIL_CHARS = 120


@dataclass
class _Recording:
    id: str
    owner: Any
    chunks: dict[int, bytes] = field(default_factory=dict)
    size: int = 0
    # Level stats, folded in per chunk so stop does not rescan minutes of audio.
    peak: int = 0
    sum_sq: int = 0
    touched: float = field(default_factory=time.monotonic)
    language: str = DEFAULT_LANGUAGE
    prompt: str | None = None
    # Chinese script the sidecar converts every hypothesis to, so partials,
    # segments and the final text (and _strip_overlap) all compare alike.
    script: str | None = None
    # Streaming state. `committed` only grows; `win_start` is the byte offset
    # where the uncommitted window begins; `prev_segs` holds the previous
    # hypothesis's segments of that window (normalized); `heard` is how many
    # bytes the last partial covered.
    committed: str = ""
    win_start: int = 0
    prev_segs: list[str] = field(default_factory=list)
    heard: int = 0
    # Where the window started before its last advance, while that advance is
    # still unverified (see _apply_hypothesis); None once verified.
    rollback_to: int | None = None
    # End (take bytes) of the audio behind the committed text. A window that
    # starts before it holds committed words again (the overlap).
    committed_until: int = 0
    # Committed text heard before the window starts: the prompt's context.
    # Text inside the window must stay out of the prompt, or whisper skips
    # those words and the overlap is never re-heard (whisper_streaming does
    # the same). `context_before` is what it was before the last advance.
    context: str = ""
    context_before: str = ""
    partial_seq: int = 0
    partial_started: float = 0.0
    # Moving average of how long recent partials took (seconds).
    partial_took: float = 0.0
    ticker: asyncio.Task | None = None
    partial: asyncio.Task | None = None

    def stale(self) -> bool:
        return bool(getattr(self.owner, "dead", False)) or time.monotonic() - self.touched > _STALE_AFTER_S


_active: _Recording | None = None
_download_task: asyncio.Task | None = None
# Set by voice.shutdown (voice input switched off), cleared by every prewarm
# and start. A prewarm or start still awaiting when the switch-off ran finds it
# set after its spawn and stops the sidecar again, instead of leaving it loaded
# for the idle timeout. A later prewarm/start (switched back on) clears it, so a
# late answer from before the switch-off never stops a sidecar that is wanted.
_disabled = False


async def _switched_off() -> bool:
    """True (and the sidecar stopped) if voice input is switched off."""
    if not _disabled:
        return False
    sidecar = stt_service.peek_sidecar()
    if sidecar is not None:
        await sidecar.stop()
    return True


def _take(session: Any, session_id: Any) -> _Recording | None:
    """Detach the active recording if ``session`` owns ``session_id``."""
    global _active
    rec = _active
    if rec is None or rec.id != session_id or rec.owner is not session:
        return None
    _active = None
    _stop_streaming(rec)
    return rec


def _release_active() -> None:
    """Drop the active recording, whoever owns it."""
    global _active
    rec, _active = _active, None
    if rec is not None:
        _stop_streaming(rec)


def _stop_streaming(rec: _Recording) -> None:
    """Stop the partial ticker and abort an in-flight partial."""
    if rec.ticker is not None:
        rec.ticker.cancel()
        rec.ticker = None
    if rec.partial is not None and not rec.partial.done():
        rec.partial.cancel()


def drop_owner(session: Any) -> None:
    """A window disconnected: abandon its recording."""
    if _active is not None and _active.owner is session:
        _release_active()


async def _reply(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    await session.send_json(make_response(msg_id, msg_type, payload))


async def voice_status(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    sidecar = stt_service.peek_sidecar()
    binary = await stt_service.run_blocking(stt_service.sidecar_path)
    await _reply(session, msg_id, msg_type, {
        "ok": True,
        "sidecar": "ok" if binary is not None else "missing",
        "model": await stt_service.run_blocking(stt_service.model_info),
        "running": bool(sidecar and sidecar.running),
        "gpu": sidecar.gpu if sidecar is not None else None,
        "starting": bool(sidecar and sidecar.starting),
        "error": sidecar.last_error if sidecar is not None else None,
    })


async def voice_prewarm(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Load the sidecar ahead of the first press. Claims no recording."""
    global _disabled
    _disabled = False
    began = time.monotonic()
    sidecar = stt_service.peek_sidecar()
    was_running = bool(sidecar and sidecar.running)

    async def refuse(reason: str) -> None:
        log.info("voice.prewarm: not ready reason=%s", reason)
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": reason})

    if await stt_service.run_blocking(stt_service.sidecar_path) is None:
        return await refuse("sidecar-missing")
    if not (await stt_service.run_blocking(stt_service.model_info))["present"]:
        return await refuse("model-missing")
    try:
        await stt_service.get_sidecar().ensure_started()
    except stt_service.SidecarError as err:
        log.warning("voice.prewarm: sidecar failed: %s", err)
        return await refuse("sidecar-failed")
    if await _switched_off():
        return await refuse("disabled")
    log.info("voice.prewarm: ready was_running=%s took_ms=%d", was_running, (time.monotonic() - began) * 1000)
    await _reply(session, msg_id, msg_type, {"ok": True})


async def voice_shutdown(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Voice input was switched off: drop any recording and stop the sidecar."""
    global _disabled
    _disabled = True
    _release_active()
    sidecar = stt_service.peek_sidecar()
    if sidecar is not None:
        await sidecar.stop()
    await _reply(session, msg_id, msg_type, {"ok": True})


async def _broadcast_progress(data: dict) -> None:
    from . import app

    await app.broadcast(make_event("voice.model.progress", data))


async def _run_download() -> None:
    total = stt_service.MODEL_BYTES
    done = 0

    async def progress(bytes_done: int, bytes_total: int) -> None:
        nonlocal done, total
        done, total = bytes_done, bytes_total
        await _broadcast_progress({"bytes": bytes_done, "total": bytes_total, "done": False})

    try:
        if not (await stt_service.run_blocking(stt_service.model_info))["present"]:
            await stt_service.download_model(progress)
    except asyncio.CancelledError:
        raise
    except Exception as err:  # noqa: BLE001
        log.warning("voice model download failed: %s", err)
        # done=True marks the end of the attempt; error says it failed.
        await _broadcast_progress({"bytes": done, "total": total, "done": True, "error": str(err)})
        return
    size = stt_service.MODEL_BYTES
    await _broadcast_progress({"bytes": size, "total": size, "done": True})


async def voice_model_download(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Answer at once; progress reaches every window as voice.model.progress."""
    global _download_task
    if _download_task is None or _download_task.done():
        _download_task = asyncio.create_task(_run_download())
    await _reply(session, msg_id, msg_type, {"ok": True})


async def voice_start(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    global _active, _disabled
    _disabled = False
    if await stt_service.run_blocking(stt_service.sidecar_path) is None:
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "sidecar-missing"})
        return
    if not (await stt_service.run_blocking(stt_service.model_info))["present"]:
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "model-missing"})
        return
    # A window runs one take at a time, so its own earlier claim (a start it
    # gave up on while the sidecar was still loading) is superseded, not busy.
    if _active is not None and _active.owner is not session and not _active.stale():
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "busy"})
        return
    sidecar = stt_service.peek_sidecar()
    if sidecar is None or not sidecar.running:
        log.info("voice.start: sidecar cold; loading it during the take")
        await stt_service.run_blocking(_sweep_stale_pcm)
    rec = _Recording(id=uuid.uuid4().hex, owner=session)
    language = payload.get("language")
    if isinstance(language, str) and language:
        rec.language = language
    prompt = payload.get("initialPrompt")
    if isinstance(prompt, str) and prompt:
        rec.prompt = prompt
    script = payload.get("script")
    if script in SCRIPTS:
        rec.script = script
    _active = rec  # claimed before the (possibly slow) spawn so a second start is busy
    try:
        await stt_service.get_sidecar().ensure_started()
    except stt_service.SidecarError as err:
        log.warning("voice.start: sidecar failed: %s", err)
        if _active is rec:
            _active = None
        reason = "sidecar-missing" if str(err) == "sidecar-missing" else "sidecar-failed"
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": reason})
        return
    if await _switched_off():
        if _active is rec:
            _active = None
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "disabled"})
        return
    rec.touched = time.monotonic()
    if _active is rec:
        rec.ticker = asyncio.create_task(_partial_loop(rec))
    await _reply(session, msg_id, msg_type, {"ok": True, "sessionId": rec.id})


async def voice_chunk(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """No reply. Chunks past the 5 min cap, duplicates and bad frames are dropped."""
    rec = _active
    if rec is None or rec.owner is not session or payload.get("sessionId") != rec.id:
        return
    rec.touched = time.monotonic()
    try:
        data = base64.b64decode(str(payload.get("pcm") or ""), validate=True)
    except (binascii.Error, ValueError):
        return
    seq = payload.get("seq")
    if isinstance(seq, bool) or not isinstance(seq, int):
        seq = max(rec.chunks, default=-1) + 1
    if seq in rec.chunks or not data:
        return
    room = MAX_PCM_BYTES - rec.size
    if room <= 0:
        return
    data = data[: room - (room % 2)] if len(data) > room else data
    rec.chunks[seq] = data
    rec.size += len(data)
    peak, sum_sq = _levels(data)
    rec.peak = max(rec.peak, peak)
    rec.sum_sq += sum_sq


def _levels(pcm: bytes) -> tuple[int, int]:
    """Peak and sum of squares of s16le audio."""
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    if not samples:
        return 0, 0
    return max(max(samples), -min(samples)), sum(map(operator.mul, samples, samples))


def _new_temp_pcm() -> Path:
    """An empty temp file, created before any audio is written, so the caller
    knows the path (and deletes it) even if it is cancelled mid-write."""
    fd, name = tempfile.mkstemp(prefix="navide-voice-", suffix=".pcm")
    os.close(fd)
    return Path(name)


# Serializes temp PCM writes against their cleanup: Windows refuses to delete
# a file that is still open for writing, so a cleanup landing mid-write would
# fail and leave the audio on disk.
_pcm_io_lock = threading.Lock()


def _write_pcm(path: Path, pcm: bytes) -> None:
    """Fill the file _new_temp_pcm made. Never creates it: if a cancelled
    caller's cleanup already removed it (the pool has two workers, so that can
    run first), the audio is not written anywhere; a cleanup that arrives
    mid-write waits for the write, then deletes the file."""
    with _pcm_io_lock:
        try:
            fd = os.open(path, os.O_WRONLY | os.O_TRUNC)
        except FileNotFoundError:
            return
        with os.fdopen(fd, "wb") as fh:
            fh.write(pcm)


# Windows also refuses while another process has the file open without
# FILE_SHARE_DELETE — a virus scanner or indexer looking at the fresh file, or
# a reader that has not closed it yet. Those hold it briefly, so the delete is
# retried for this long rather than leaving the speech on disk.
_REMOVE_RETRY_S = 2.0


def _remove(path: Path) -> None:
    deadline = time.monotonic() + _REMOVE_RETRY_S
    delay = 0.01
    while True:
        try:
            with _pcm_io_lock:
                path.unlink(missing_ok=True)
            return
        except PermissionError:
            if time.monotonic() >= deadline:
                log.warning("voice: cannot delete %s yet; retrying in the background", path.name)
                threading.Thread(target=_remove_later, args=(path,), name="voice-remove", daemon=True).start()
                return
        except OSError as err:
            log.warning("voice: cannot delete %s: %s", path.name, err)
            return
        time.sleep(delay)
        delay = min(delay * 2, 0.2)


_REMOVE_LATER_POLL_S = 0.5


def _remove_later(path: Path) -> None:
    """Keep retrying a delete _remove gave up on, on its own thread so the
    voice pool is not tied up. Whatever holds the file lets go eventually (the
    sidecar reads it for at most a request's timeout); _sweep_stale_pcm only
    catches what is still there after that, at the next take or exit."""
    deadline = time.monotonic() + stt_service.REQUEST_TIMEOUT_S
    while time.monotonic() < deadline:
        time.sleep(_REMOVE_LATER_POLL_S)
        try:
            with _pcm_io_lock:
                path.unlink(missing_ok=True)
            return
        except PermissionError:
            continue
        except OSError as err:
            log.warning("voice: cannot delete %s: %s", path.name, err)
            return
    log.warning("voice: cannot delete %s; it is swept later", path.name)


def _sweep_stale_pcm() -> None:
    """Delete temp audio a failed _remove left behind. Only files older than
    any request could still be reading, so another Navide's take is safe."""
    cutoff = time.time() - stt_service.REQUEST_TIMEOUT_S
    for path in Path(tempfile.gettempdir()).glob("navide-voice-*.pcm"):
        with contextlib.suppress(OSError):
            if path.stat().st_mtime < cutoff:
                path.unlink()


def _pcm_range(rec: _Recording, start: int, end: int) -> bytes:
    """Bytes [start, end) of the take, in seq order, without joining all of it."""
    parts: list[bytes] = []
    offset = 0
    for seq in sorted(rec.chunks):
        data = rec.chunks[seq]
        lo, hi = offset, offset + len(data)
        offset = hi
        if hi <= start:
            continue
        if lo >= end:
            break
        parts.append(data[max(start - lo, 0): min(end, hi) - lo])
    return b"".join(parts)


def _is_word_char(ch: str) -> bool:
    return ch.isascii() and ch.isalnum()


def _join(left: str, right: str) -> str:
    """Concatenate across a window boundary, restoring the space whisper
    trims off before a Latin word."""
    if left and right and left[-1].isascii() and not left[-1].isspace() and _is_word_char(right[0]):
        return left + " " + right
    return left + right


def _norm(text: str) -> str:
    """Segment text for comparison: punctuation and spacing vary run to run."""
    return re.sub(r"[\W_]+", "", text)


def _prompt_for(rec: _Recording) -> str | None:
    """The take's prompt plus recent committed text from before the window;
    None keeps the sidecar's default (so a take with nothing committed before
    its window decodes exactly as before)."""
    if not rec.context:
        return rec.prompt
    return (rec.prompt or DEFAULT_INITIAL_PROMPT) + rec.context[-_PROMPT_TAIL_CHARS:]


def _trusted(segs: list[tuple[str, int, int]], k: int, window_bytes: int) -> bool:
    """Whether the boundary after segment ``k`` is a real time. Whisper's
    token timestamps collapse onto the end of a window that stops mid-speech
    (zero-length segments, or an end at the window's end); only a boundary
    between two segments that both have duration, well inside the window, is
    usable as a cut point."""
    _, t0, t1 = segs[k]
    _, n0, n1 = segs[k + 1]
    return (
        t1 - t0 >= _MIN_SEG_BYTES and n1 - n0 >= _MIN_SEG_BYTES
        and t1 <= window_bytes - _BOUNDARY_MARGIN_BYTES
    )


def _norm_map(texts: list[str]) -> list[tuple[str, int, int]]:
    """Normalized characters of ``texts`` as (char, text index, raw index)."""
    return [
        (ch, i, j) for i, text in enumerate(texts) for j, ch in enumerate(text) if _norm(ch)
    ]


def _overlap_len(done: str, hyp: str, ends: frozenset[int] = frozenset()) -> tuple[int, int]:
    """Align a suffix of ``done`` with a prefix of ``hyp`` (both normalized;
    up to _OVERLAP_MAX_SKIP leading characters of ``hyp`` are free), scoring
    +2 per matching character and -1 per mismatch or gap, so rewordings and
    dropped or extra characters still align. Returns (characters of ``hyp``
    covered, score) for the best alignment, or (0, 0). ``ends`` are the
    lengths of ``hyp`` at which one of its segments ends."""
    n, m = len(done), len(hyp)
    if not n or not m:
        return 0, 0
    neg = -(10 ** 6)
    # prev[j]: best score aligning some suffix-start of done[:i] with hyp[:j].
    prev = [0 if j <= _OVERLAP_MAX_SKIP else neg for j in range(m + 1)]
    for i in range(1, n + 1):
        cur = [0 if j <= _OVERLAP_MAX_SKIP else neg for j in range(m + 1)]
        for j in range(1, m + 1):
            cur[j] = max(
                cur[j],
                prev[j - 1] + (2 if done[i - 1] == hyp[j - 1] else -1),
                prev[j] - 1,
                cur[j - 1] - 1,
            )
        prev = cur
    # On a tie take less of hyp: repeating a character beats losing one.
    # Except up to a segment end: committed text ends where a segment did, so
    # a misheard last character there (a substitution tying with a gap) is
    # still the overlap.
    score, j = max((prev[j], -j) for j in range(m + 1))
    if score <= 0:
        return 0, 0
    j = -j
    j = next((k for k in range(j, min(j + _OVERLAP_MAX_TIE, m) + 1) if prev[k] == score and k in ends), j)
    return j, score


def _strip_overlap(done: str, texts: list[str]) -> tuple[list[str], bool]:
    """``texts`` (a hypothesis's segments, in order) without the leading text
    that repeats the end of the committed text ``done``, and whether it did
    repeat it (an alignment scoring at least _OVERLAP_MIN_SCORE).
    Known cost: a word the speaker really repeats across the boundary
    ("好，好，") is taken for overlap and appears once."""
    tail = _norm(done)[-_OVERLAP_MAX_CHARS:]
    chars = _norm_map(texts)[: 2 * _OVERLAP_MAX_CHARS]
    ends = frozenset(k for k in range(1, len(chars) + 1) if k == len(chars) or chars[k][1] != chars[k - 1][1])
    cut, score = _overlap_len(tail, "".join(ch for ch, _, _ in chars), ends)
    # A very short committed text cannot reach the full score.
    if not cut or score < min(_OVERLAP_MIN_SCORE, 2 * len(tail) - 1):
        return texts, False
    _, idx, pos = chars[cut - 1]
    return [""] * idx + [re.sub(r"^[\W_]+", "", texts[idx][pos + 1:])] + texts[idx + 1:], True


def _apply_hypothesis(rec: _Recording, segments: list, window_bytes: int) -> str:
    """Fold one partial hypothesis of the current window into the take's
    state, advancing the window past what it commits. Returns the tentative
    text."""
    segs: list[tuple[str, int, int]] = []  # (text, start, end) in window bytes
    for seg in segments:
        if isinstance(seg, dict):
            t0 = min(max(int(seg.get("t0_ms") or 0), 0) * 32, window_bytes)
            t1 = min(max(int(seg.get("t1_ms") or 0), 0) * 32, window_bytes)
            segs.append((str(seg.get("text") or ""), t0, max(t0, t1)))
    # The window starts inside audio already committed: drop that text, and
    # segments left empty by it.
    texts, reheard = _strip_overlap(rec.committed, [text for text, _, _ in segs])
    if rec.rollback_to is not None:
        if not reheard:
            # The last advance skipped words (its boundary was late): step
            # back by an overlap, as far as where the advance started but
            # never so far that the window outgrows the cap. Once back there
            # (or at the cap) the advance is settled; until then the next
            # hypothesis checks again.
            end = rec.win_start + window_bytes
            back = max(rec.win_start - _OVERLAP_BYTES, rec.rollback_to, end - WINDOW_CAP_BYTES)
            rec.win_start = min(back, rec.win_start)
            rec.win_start -= rec.win_start % 2
            if rec.win_start <= max(rec.rollback_to, end - WINDOW_CAP_BYTES):
                rec.rollback_to = None
            rec.prev_segs = []
            rec.context = rec.context_before
            return ""
        rec.rollback_to = None
    segs = [(text, t0, t1) for text, (_, t0, t1) in zip(texts, segs) if _norm(text)]
    # The overlap was not recognised (heard as other words): drop segments
    # that lie inside the committed audio and commit nothing by agreement on
    # this hypothesis — holding text as tentative beats committing it twice.
    overlap = max(rec.committed_until - rec.win_start, 0)
    hold = bool(overlap) and not reheard
    if hold:
        segs = [seg for seg in segs if seg[2] > overlap]
    agreed = 0
    while (
        not hold and agreed < len(segs) - 1 and agreed < len(rec.prev_segs)
        and _norm(segs[agreed][0]) == rec.prev_segs[agreed]
    ):
        agreed += 1
    # Commit the agreed segments up to the last boundary that is a real time.
    # A segment with no real duration means whisper collapsed its timestamps
    # (the window ends mid-speech) and stretched the ones before it, often
    # by seconds: no boundary of such a hypothesis is a real time.
    collapsed = any(t1 - t0 < _MIN_SEG_BYTES for _, t0, t1 in segs)
    n = 0 if collapsed else next((k + 1 for k in range(agreed - 1, -1, -1) if _trusted(segs, k, window_bytes)), 0)
    cut = segs[n - 1][2] if n else 0
    if n == 0 and segs and window_bytes >= WINDOW_CAP_BYTES:
        # No usable agreement across a whole window: commit up to its last
        # trusted boundary, or failing that all but the last segment (a lone
        # segment whole), rather than let the window grow.
        n = next((k + 1 for k in range(len(segs) - 2, -1, -1) if _trusted(segs, k, window_bytes)), 0)
        n = n or max(len(segs) - 1, 1)
        cut = segs[n - 1][2] if n < len(segs) else window_bytes
        if collapsed:
            # Stretched times run late: also place the cut by how much of the
            # text lies before it (speech keeps a roughly even pace) and take
            # the earlier. Early only repeats words, which the overlap strips.
            chars = [len(_norm(text)) for text, _, _ in segs]
            cut = min(cut, window_bytes * sum(chars[:n]) // max(sum(chars), 1))
    if n and cut > 0:
        before = rec.committed
        rec.committed = _join(rec.committed, "".join(text for text, _, _ in segs[:n]).strip())
        rec.committed_until = max(rec.committed_until, rec.win_start + cut)
        start = max(cut - _OVERLAP_BYTES, 0)
        if start >= 2:
            rec.rollback_to = rec.win_start
            rec.win_start += start - start % 2
            rec.context_before, rec.context = rec.context, before
    else:
        n = 0
    rec.prev_segs = [_norm(text) for text, _, _ in segs[n:]]
    return "".join(text for text, _, _ in segs[n:]).strip()


async def _transcribe_window(rec: _Recording, end: int, pad: bool, segments: bool) -> dict:
    """Transcribe bytes [win_start, end) of the take. Raises SidecarError."""
    pcm = _pcm_range(rec, rec.win_start, end)
    if pad:
        pcm += bytes(_TAIL_PAD_BYTES)
    path = _new_temp_pcm()
    try:
        await stt_service.run_blocking(_write_pcm, path, pcm)
        return await stt_service.get_sidecar().transcribe(
            path, rec.language, _prompt_for(rec), segments=segments, script=rec.script,
        )
    finally:
        await _remove_before_returning(path)


async def _remove_before_returning(path: Path) -> None:
    """Run _remove and wait for it even through another cancel. A partial is
    cancelled by voice.cancel/voice.stop and, separately, by its own budget
    timeout; if the second lands while the delete is still retrying, a plain
    await ends the task with the speech still on disk."""
    removal = asyncio.ensure_future(stt_service.run_blocking(_remove, path))
    cancelled = False
    while not removal.done():
        try:
            await asyncio.shield(removal)
        except asyncio.CancelledError:
            cancelled = True
    if cancelled:
        raise asyncio.CancelledError
    removal.result()


def _partial_due(rec: _Recording) -> bool:
    return (
        rec.peak >= SILENT_PEAK
        and rec.size - rec.heard >= _PARTIAL_MIN_NEW_BYTES
        and rec.size - rec.win_start >= _PARTIAL_MIN_WINDOW_BYTES
    )


async def _partial_loop(rec: _Recording) -> None:
    """Start partials while ``rec`` is the active take; never queues: none
    starts while the previous one is still running."""
    while True:
        await asyncio.sleep(_PARTIAL_POLL_S)
        if _active is not rec:
            return
        if rec.partial is not None and not rec.partial.done():
            continue
        if time.monotonic() - rec.partial_started >= PARTIAL_INTERVAL_S and _partial_due(rec):
            rec.partial_started = time.monotonic()
            rec.partial = asyncio.create_task(_run_partial(rec))


def _took_average(average: float, took: float) -> float:
    return took if not average else 0.7 * average + 0.3 * took


async def _run_partial(rec: _Recording) -> None:
    end = rec.size
    rec.heard = end
    started = time.monotonic()
    budget = max(_PARTIAL_BUDGET_MIN_S, _PARTIAL_BUDGET_FACTOR * rec.partial_took)
    try:
        result = await asyncio.wait_for(_transcribe_window(rec, end, pad=False, segments=True), budget)
    except asyncio.TimeoutError:
        rec.partial_took = _took_average(rec.partial_took, budget)
        log.info(
            "voice.partial over budget window_ms=%d budget_ms=%d",
            (end - rec.win_start) * 1000 // _BYTES_PER_SECOND, int(budget * 1000),
        )
        return
    except stt_service.SidecarError as err:
        log.info("voice.partial: sidecar failed: %s", err)
        return
    if not result.get("ok"):
        log.info("voice.partial: transcription failed: %s", result.get("error"))
        return
    rec.partial_took = _took_average(rec.partial_took, time.monotonic() - started)
    window = end - rec.win_start
    segments = result.get("segments")
    tentative = _apply_hypothesis(rec, segments if isinstance(segments, list) else [], window)
    log.debug(
        "voice.partial window_ms=%d ms=%d took_ms=%d committed=%d",
        window * 1000 // _BYTES_PER_SECOND, int(result.get("ms") or 0),
        int((time.monotonic() - started) * 1000), len(rec.committed),
    )
    if _active is not rec or getattr(rec.owner, "dead", False):
        return
    rec.partial_seq += 1
    with contextlib.suppress(Exception):
        await rec.owner.send_json(make_event("voice.partial", {
            "sessionId": rec.id, "seq": rec.partial_seq,
            "committed": rec.committed, "tentative": tentative,
        }))


async def voice_stop(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    rec = _take(session, payload.get("sessionId"))
    if rec is None:
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "no-session"})
        return
    size = rec.size
    duration_ms = size * 1000 // _BYTES_PER_SECOND
    peak = rec.peak
    rms = math.sqrt(rec.sum_sq / (size // 2)) if size >= 2 else 0.0
    log.info(
        "voice.stop duration_ms=%d chunks=%d bytes=%d peak=%d rms=%.1f",
        duration_ms, len(rec.chunks), size, peak, rms,
    )
    # Too short to hold a word, or silence from the device: nothing to
    # transcribe. The window tells the two apart from durationMs and peak.
    if size < MIN_PCM_BYTES or peak < SILENT_PEAK:
        await _reply(session, msg_id, msg_type, {
            "ok": True, "text": "", "ms": 0, "durationMs": duration_ms, "peak": peak,
        })
        return
    language = payload.get("language")
    if isinstance(language, str) and language:
        rec.language = language
    prompt = payload.get("initialPrompt")
    if isinstance(prompt, str) and prompt:
        rec.prompt = prompt
    # The sidecar is serial and the tail pass covers everything an in-flight
    # partial was hearing: cancel it (the sidecar aborts it) instead of
    # waiting for it.
    waited = time.monotonic()
    if rec.partial is not None and not rec.partial.done():
        rec.partial.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await rec.partial
    started = time.monotonic()
    redone = False
    while True:
        try:
            result = await _transcribe_window(rec, size, pad=True, segments=True)
        except stt_service.SidecarError as err:
            log.warning("voice.stop: sidecar failed: %s", err)
            await _reply(session, msg_id, msg_type, {"ok": False, "reason": "sidecar-failed"})
            return
        if not result.get("ok"):
            log.warning("voice.stop: transcription failed: %s", result.get("error"))
            await _reply(session, msg_id, msg_type, {"ok": False, "reason": "transcribe-failed"})
            return
        segments = result.get("segments")
        segs = [s for s in segments if isinstance(s, dict)] if isinstance(segments, list) else []
        texts = [str(s.get("text") or "") for s in segs] if segs else [str(result.get("text") or "")]
        texts, reheard = _strip_overlap(rec.committed, texts)
        if rec.rollback_to is None or reheard:
            break
        # An unverified advance that the tail does not re-hear skipped words:
        # redo the tail from where the window was before it.
        rec.win_start, rec.rollback_to, rec.context = rec.rollback_to, None, rec.context_before
        redone = True
    committed_before = len(rec.committed)
    overlap = max(rec.committed_until - rec.win_start, 0)
    if segs and overlap and not reheard:
        # As in _apply_hypothesis: leave out what lies inside committed audio.
        texts = [t for t, s in zip(texts, segs) if int(s.get("t1_ms") or 0) * 32 > overlap]
    rec.committed = _join(rec.committed, "".join(texts).strip())
    log.info(
        "voice.final window_ms=%d waited_ms=%d took_ms=%d committed_before=%d redone=%d",
        (size - rec.win_start) * 1000 // _BYTES_PER_SECOND, int((started - waited) * 1000),
        int((time.monotonic() - started) * 1000), committed_before, redone,
    )
    await _reply(session, msg_id, msg_type, {
        "ok": True,
        "text": rec.committed,
        "ms": int(result.get("ms") or 0),
        "durationMs": duration_ms,
        "peak": peak,
    })


async def voice_cancel(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    _take(session, payload.get("sessionId"))
    await _reply(session, msg_id, msg_type, {"ok": True})


async def shutdown() -> None:
    """Backend exit: stop any download and the sidecar."""
    global _download_task
    _release_active()
    if stt_service.peek_sidecar() is not None:  # voice was used this run
        with contextlib.suppress(Exception):
            await stt_service.run_blocking(_sweep_stale_pcm)
    task, _download_task = _download_task, None
    if task is not None and not task.done():
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
    await stt_service.shutdown()
