"""The ``rustCliRuntime`` setting: what the switch changes.

There is no toggle in the Settings window yet; the switch is the
``rustCliRuntime`` key of the UI settings document (``ui.settings.set``).

Off (the default, and whenever the setting is absent) means exactly main's
behaviour: every log reader runs its own Python code, and nothing here starts a
process.

On routes three reader calls — ``parse_incremental``, ``parse_activity`` and
``turns_for_session`` — of each CLI whose records the Rust runtime declares
(``native/navide-cli-runtime``) to one long-lived ``navide-cli-runtime serve``
process. Every other reader method, and every CLI the runtime does not observe,
stays on Python. Any failure — no binary, a dead or stalled process, an error
answer — falls back to the Python reader for that call, so turning the switch
on can never stop usage or activity from being read.

How a call is made, and why it cannot hang the backend:

* A writer thread and a reader thread own the process's pipes. A caller only
  queues its request and waits for its answer, with a timeout; it never holds
  a lock while the process works, so one slow read does not hold up another
  (the process reads different files side by side and answers by request id).
* A call that times out kills the process and falls back. Turning the switch
  off sets a flag and kills the process: it takes no lock a call holds, so it
  returns at once on the event loop, and the kill wakes every waiting caller.
* A process that keeps failing is restarted after a growing delay; after
  ``BREAKER_FAILURES`` failures in a row the runtime stays on Python until the
  switch is flipped again, and says so once.

The two sides share their state, so the switch can flip either way
mid-session: usage checkpoints have one format, and the runtime reads and
writes an activity walk's seen-keys bag in the key formats main's readers use
(the ``act_hw::N`` line mark, each reader's pending-reply and turn-tracker
keys), as each CLI's declaration names them.

Applied at backend startup from the stored setting and again by
``ui.settings.set`` whenever the key changes. ``status()`` reports the switch,
the process and, per CLI, how many calls Rust answered and how many fell back.
"""

from __future__ import annotations

import collections
import itertools
import json
import logging
import os
import queue
import subprocess
import sys
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any, Callable

from . import frozen_env, osplat
from .log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    PromptText,
    TokenUsage,
    TurnCall,
    TurnUsage,
)

log = logging.getLogger("agent_team_backend.cli_runtime")

SETTING_KEY = "rustCliRuntime"
BINARY_ENV = "NAVIDE_CLI_RUNTIME_BIN"
_BIN_NAME = "navide-cli-runtime"

#: The crate version this seam is written for (``native/navide-cli-runtime/
#: Cargo.toml``; a test keeps the two equal). The ``observes`` answer carries
#: the binary's, and one that differs is treated as no binary: a runtime of
#: another build answers in a shape this code may not read.
RUNTIME_VERSION = "0.1.0"
#: Where the ``observes`` answer puts the build's identity, beside the CLIs.
RUNTIME_KEY = "_runtime"
#: The lines of the process's stderr kept for the log when it fails, and the
#: longest one kept. The runtime writes no transcript text there (its panic
#: hook prints a location only).
STDERR_LINES = 8
STDERR_LINE_CHARS = 200

#: Longest wait for one answer. A read of a transcript of tens of MB takes
#: well under a second; ten means the process is stuck (a stalled volume, a
#: stopped process), not slow.
CALL_TIMEOUT_S = 10.0
#: Process failures in a row (it died, stalled or would not start) before the
#: runtime stays on Python until the switch is flipped again.
BREAKER_FAILURES = 5
#: Delay before the n-th restart: ``BACKOFF_BASE_S * 2**(n-1)``, capped.
BACKOFF_BASE_S = 1.0
BACKOFF_MAX_S = 60.0
#: A process that has run this long without failing has a clean record again.
HEALTHY_AFTER_S = 120.0
_CLOSE_GRACE_S = 2.0
#: A start that takes longer than this is said once (a binary on a stalled volume).
SLOW_START_S = 3.0
#: A start still not finished after this long is abandoned (a binary on a
#: volume that never answers): the state leaves ``starting``, it counts as one
#: failed start, and a process the start returns later is ended, not installed.
START_DEADLINE_S = 30.0

#: The outcomes counted per CLI. ``rust``: answered by the runtime.
#: ``unsupported``: the runtime declined a store its declaration does not
#: describe, so the Python reader read it (expected; each case is a declared
#: ``Unsupported``). ``unreadable``: the file could not be opened or read, and
#: the Python reader decided what that means, as on main. ``python``: a record
#: in the call is JSON the runtime's parser rejects and Python's ``json`` may
#: accept (a lone surrogate escape, ``NaN``, nesting past 128 levels), so
#: nothing was committed past it and the Python reader read the call; if
#: Python rejects it too (a corrupt line) that reader steps over it, as main
#: does. On an incremental path (usage, activity) the next call is the
#: runtime's again, because the Python reader moved the checkpoint past the
#: record. A whole-file pass (``turns_for_session``, SQLite counters, a full
#: usage pass) has no checkpoint to move: it stays on Python for that file
#: while the record is in it, which costs time and never a record.
#: ``deferred``: the
#: reader asked to make its own reads (one with a failing query on record
#: does, until that query works again), or the call arrived while another
#: caller was starting the process. ``fallback``: a fault — a stalled,
#: dead or failing process, or an error answer.
OUTCOMES = ("rust", "unsupported", "unreadable", "python", "deferred", "fallback")

_enabled = False
# Guards the few module values below. Held only to swap them, never while a
# process is started, written to, read from or waited for.
_state = threading.Lock()
_client: "_Client | None" = None
#: Every process that became `_client` has its own number, and
#: `_failed_generation` is the newest one whose failure has been counted: the
#: callers that were all waiting on one process report one death, not one each.
_generation = 0
_failed_generation = 0
_failures = 0
_failed_at = 0.0
_retry_at = 0.0
_breaker_open = False
#: Set by `shutdown()`: no call starts the process again until the switch is applied.
_stopping = False
#: A caller is starting the process: the others use Python meanwhile, so one
#: failed start is one failure however many callers were waiting to start it.
_starting = False
#: Taken when a start begins and moved on when it is given up on or the switch
#: is applied: a start installs its process only if its number is still current.
_start_epoch = 0
#: When the start in flight began, and whether it was said to be slow.
_start_began = 0.0
_slow_start_logged = False
#: Per calling thread: the last `_client_for_call` stepped aside for a start.
_aside = threading.local()
_no_binary_logged = False
#: What the last process said about its build (``version``, ``declarations``),
#: and why that build is not used (None: it is). Set by the handshake.
_runtime_said: dict[str, Any] | None = None
_unusable: str | None = None
#: (CLI, kind) of the error answers already logged.
_errors_logged: set[tuple[str, str]] = set()
_counts: dict[str, dict[str, int]] = {}


def enabled() -> bool:
    return _enabled


def apply(on: bool) -> None:
    """Make the backend match the switch. Idempotent; never raises, never waits."""
    global _enabled, _failures, _retry_at, _breaker_open, _stopping, _no_binary_logged, _starting, _start_epoch
    global _runtime_said, _unusable
    _enabled = bool(on)
    with _state:
        # Flipping the switch is the way out of a tripped breaker, and out of a
        # start that never ends: one that began before this is ended when it
        # returns, not installed.
        _failures, _retry_at, _breaker_open, _stopping = 0, 0.0, False, False
        _runtime_said, _unusable = None, None
        _start_epoch += 1
        _starting = False
        _errors_logged.clear()
        if not _enabled:
            _no_binary_logged = False
    if not _enabled:
        _drop_client()
    elif binary() is None:
        _log_no_binary()
    log.info("Rust CLI runtime (experimental) %s", "on" if _enabled else "off")


def apply_settings(settings: Any) -> None:
    """apply() from a ui_settings document (absent or not true = off)."""
    apply(isinstance(settings, dict) and settings.get(SETTING_KEY) is True)


def shutdown() -> None:
    """Stop the process at backend shutdown (the setting is left as it is).

    A reader call that arrives afterwards (the token monitor and the ledgers
    read from their own threads) is answered by Python: nothing starts the
    process again until the switch is applied. Waits up to a few seconds for
    the process to go: call it off the event loop.
    """
    global _stopping
    with _state:
        _stopping = True
    closer = _drop_client()
    if closer is not None:
        closer.join(_CLOSE_GRACE_S + 1.0)


def binary() -> Path | None:
    """The runtime executable: ``$NAVIDE_CLI_RUNTIME_BIN``, else the packaged
    ``<resources>/bin`` (where the app's other native sidecars live) in the
    packaged backend, else the repository's release build in a source
    checkout. None when there is none, or when it cannot even be looked for (a
    volume that refuses the lookup): that is no binary, never an error."""
    try:
        override = os.environ.get(BINARY_ENV)
        if override:
            path = Path(override).expanduser()
            return path if path.is_file() else None
        name = osplat.paths.bundled_executable(_BIN_NAME)
        if getattr(sys, "frozen", False):
            folder = Path(frozen_env.packaged_bin_dir())
        else:
            folder = Path(__file__).resolve().parents[2] / "native" / _BIN_NAME / "target" / "release"
        return folder / name if (folder / name).is_file() else None
    except (OSError, RuntimeError):  # RuntimeError: `expanduser` without a home
        return None


def _log_no_binary() -> None:
    global _no_binary_logged
    with _state:
        if _no_binary_logged:
            return
        _no_binary_logged = True
    log.warning(
        "Rust CLI runtime is switched on but %s was not found (set %s, or build "
        "native/navide-cli-runtime); every reader stays on Python",
        osplat.paths.bundled_executable(_BIN_NAME), BINARY_ENV,
    )


def status() -> dict[str, Any]:
    """The switch, the process and the per-CLI call counts (JSON-safe)."""
    with _state:
        client = _client
        if not _enabled:
            state = "off"
        elif _breaker_open:
            state = "stopped-after-failures"
        elif _starting:
            state = "starting"
        elif client is not None and not client.dead:
            state = "running"
        elif time.monotonic() < _retry_at:
            state = "waiting-to-restart"
        else:
            state = "idle"
        calls = {vendor: dict(counts) for vendor, counts in sorted(_counts.items())}
        failures = _failures
        said, unusable = dict(_runtime_said) if _runtime_said is not None else None, _unusable
    return {
        "enabled": _enabled,
        "state": state,
        # A build that is not the one this code is written for counts as none.
        "binary": binary() is not None and unusable is None,
        "failures": failures,
        # What the process said it is (None until its handshake), and why it
        # is not used (None: it is).
        "runtime": {"version": (said or {}).get("version"), "declarations": (said or {}).get("declarations"),
                    "unusable": unusable},
        "calls": calls,
    }


def reset_counts() -> dict[str, dict[str, int]]:
    """Clear the per-CLI call counts; returns what they were."""
    global _counts
    with _state:
        before, _counts = _counts, {}
    return before


def _count(vendor: str, outcome: str) -> None:
    with _state:
        counts = _counts.setdefault(vendor, dict.fromkeys(OUTCOMES, 0))
        counts[outcome] += 1


class PythonReads(Exception):
    """A call whose request cannot be sent as strict UTF-8 JSON: it is the
    Python reader's, and says nothing about the process."""


class _Client:
    """One ``serve`` process: a JSON request per line in, a JSON answer per line
    out, matched by id. Two threads own the pipes; callers only wait."""

    def __init__(self, exe: Path) -> None:
        self._proc = subprocess.Popen(
            [str(exe), "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **osplat.paths.helper_process_options(),
        )
        self._ids = itertools.count(1)
        #: The last lines the process wrote to stderr (bounded).
        self._stderr_tail: "collections.deque[str]" = collections.deque(maxlen=STDERR_LINES)
        self._stderr_done = threading.Event()
        self._waiting: dict[int, "queue.SimpleQueue[dict | None]"] = {}
        self._waiting_lock = threading.Lock()
        self._outbox: "queue.SimpleQueue[bytes | None]" = queue.SimpleQueue()
        self.dead = False
        #: Its number among the processes that became the current one (0: never did).
        self.generation = 0
        #: What the process observes: CLI key -> {"cwd": form}. None until asked.
        self.observed: dict[str, dict] | None = None
        try:
            for target, name in ((self._write, "cli-runtime-write"), (self._read, "cli-runtime-read"),
                                 (self._drain, "cli-runtime-stderr")):
                threading.Thread(target=target, name=name, daemon=True).start()
        except BaseException:
            # No thread may own the pipes (the thread limit): the caller never
            # gets this object, so end and reap the child here.
            self.kill()
            try:
                self._proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                pass
            raise

    def _write(self) -> None:
        stdin = self._proc.stdin
        assert stdin is not None
        try:
            while True:
                line = self._outbox.get()
                if line is None:
                    break
                stdin.write(line)
                stdin.flush()
        except (OSError, ValueError):
            pass  # the process went away; the reader thread reports it
        finally:
            try:
                stdin.close()
            except OSError:
                pass

    def _drain(self) -> None:
        """Keep the last lines of stderr, and never let the pipe fill."""
        stderr = self._proc.stderr
        assert stderr is not None
        try:
            for raw in stderr:
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    self._stderr_tail.append(line[:STDERR_LINE_CHARS])
        except (OSError, ValueError):
            pass
        finally:
            self._stderr_done.set()

    def stderr_text(self) -> str:
        """The kept lines of stderr, joined; once the process has gone (its
        stdout closed), after a short wait for the last of them to be read."""
        if self.dead:
            try:
                self._proc.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
            self._stderr_done.wait(0.5)
        return " | ".join(self._stderr_tail)

    def _read(self) -> None:
        stdout = self._proc.stdout
        assert stdout is not None
        try:
            for raw in stdout:
                try:
                    answer = json.loads(raw)
                except ValueError:
                    continue
                with self._waiting_lock:
                    slot = self._waiting.pop(answer.get("id"), None) if isinstance(answer, dict) else None
                if slot is not None:
                    slot.put(answer)
        except (OSError, ValueError):
            pass
        finally:
            # No more answers will come: wake everyone still waiting. `dead`
            # is set under the lock a call registers under, so a call either
            # is in `_waiting` here or sees `dead`.
            with self._waiting_lock:
                self.dead = True
                waiting, self._waiting = list(self._waiting.values()), {}
            for slot in waiting:
                slot.put(None)

    def call(self, op: str, timeout: float, **fields: Any) -> dict:
        """The process's answer document. Raises OSError when it is gone and
        TimeoutError when it did not answer in time."""
        request_id = next(self._ids)
        try:
            # Strict: no lone surrogate (a path with undecodable bytes, as
            # `surrogateescape` makes one) and no NaN is sent as an escape the
            # process cannot parse. The process stays untouched; the caller's
            # Python reader reads the call.
            line = (json.dumps({"id": request_id, "op": op, **fields}, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
        except (UnicodeEncodeError, ValueError) as err:
            raise PythonReads(str(err)) from None
        slot: "queue.SimpleQueue[dict | None]" = queue.SimpleQueue()
        with self._waiting_lock:
            if self.dead:
                raise OSError("navide-cli-runtime exited")
            self._waiting[request_id] = slot
        self._outbox.put(line)
        try:
            answer = slot.get(timeout=timeout)
        except queue.Empty:
            with self._waiting_lock:
                self._waiting.pop(request_id, None)
            raise TimeoutError(f"navide-cli-runtime did not answer {op} within {timeout:g}s") from None
        if answer is None:
            raise OSError("navide-cli-runtime exited")
        return answer

    def kill(self) -> None:
        """End the process now. Never blocks; wakes every waiting caller."""
        try:
            self._proc.kill()
        except OSError:
            pass
        self._outbox.put(None)

    def close(self) -> None:
        """Let the process finish and reap it (blocks up to the grace period)."""
        self._outbox.put(None)
        try:
            self._proc.wait(timeout=_CLOSE_GRACE_S)
        except subprocess.TimeoutExpired:
            self.kill()
            try:
                self._proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                pass


def _drop_client() -> threading.Thread | None:
    """Forget the process and end it without waiting; the reaping thread is returned."""
    global _client, _known
    with _state:
        client, _client, _known = _client, None, {}
    if client is None:
        return None
    client.kill()
    closer = threading.Thread(target=client.close, name="cli-runtime-close", daemon=True)
    closer.start()
    return closer


def _reap(client: "_Client") -> None:
    """End a process without waiting for it."""
    client.kill()
    threading.Thread(target=client.close, name="cli-runtime-close", daemon=True).start()


def _process_failed(client: "_Client | None", err: BaseException) -> None:
    """A process died, stalled or would not start (``client`` None): end it,
    and schedule (or give up on) the next start.

    One process is one failure. Killing it wakes every caller that was
    waiting on it, and each of them comes here: only the first is counted."""
    global _client, _failed_generation, _failures, _failed_at, _retry_at, _breaker_open
    now = time.monotonic()
    with _state:
        if client is not None:
            if client.generation <= _failed_generation:
                return
            _failed_generation = client.generation
            if _client is client:
                _client = None
        if now - _failed_at > HEALTHY_AFTER_S:
            _failures = 0
        _failures += 1
        _failed_at = now
        _retry_at = now + min(BACKOFF_BASE_S * 2 ** (_failures - 1), BACKOFF_MAX_S)
        tripped = _failures >= BREAKER_FAILURES and not _breaker_open
        _breaker_open = _breaker_open or tripped
        failures = _failures
    # What the process said on stderr before it went: once, with the failure
    # that counted it (a process is one failure).
    tail = client.stderr_text() if client is not None and hasattr(client, "stderr_text") else ""
    if client is not None:
        _reap(client)
    said = f" (stderr: {tail})" if tail else ""
    if tripped:
        log.warning(
            "navide-cli-runtime failed %d times in a row (last: %s%s); readers stay on Python "
            "until the %s setting is switched off and on again", failures, err, said, SETTING_KEY,
        )
    else:
        log.warning("navide-cli-runtime unavailable, using the Python reader: %s%s", err, said)


def _client_for_call() -> "_Client | None":
    """The running process, started if it may be; None means "use Python"."""
    global _client, _generation, _starting, _start_began, _slow_start_logged, _start_epoch
    _aside.stepped = False
    slow_for = abandoned_after = 0.0
    with _state:
        if not _enabled or _breaker_open or _stopping or _unusable is not None:
            return None
        current = _client
        if current is not None and not current.dead:
            return current
        now = time.monotonic()
        if current is None and _starting:
            if now - _start_began > START_DEADLINE_S:
                # Give the start up: whatever it returns later carries an old
                # epoch and is ended, not installed.
                _start_epoch += 1
                _starting = False
                abandoned_after = now - _start_began
            else:
                # One caller starts the process; the others use Python for this call.
                _aside.stepped = True
                if now - _start_began > SLOW_START_S and not _slow_start_logged:
                    _slow_start_logged = True
                    slow_for = now - _start_began
        may_start = current is None and not abandoned_after and not _starting and now >= _retry_at
    if slow_for:
        log.warning("navide-cli-runtime has been starting for %.0f s; readers use Python until it is up", slow_for)
    if abandoned_after:
        _process_failed(None, TimeoutError(f"navide-cli-runtime did not start within {abandoned_after:.0f}s"))
        return None
    if current is not None:
        # It exited on its own between calls.
        _process_failed(current, OSError("navide-cli-runtime exited"))
        return None
    if not may_start:
        return None
    # Looked for outside the lock and before anything is "starting": with no
    # binary there is no start, so no caller steps aside for one.
    try:
        exe = binary()
    except Exception as err:  # noqa: BLE001 — a binary that cannot even be looked for is a failed start
        _process_failed(None, err)
        return None
    if exe is None:
        _log_no_binary()
        return None
    with _state:
        if _starting:
            _aside.stepped = True
            return None
        if not _enabled or _breaker_open or _stopping or _client is not None or time.monotonic() < _retry_at:
            return None
        _start_epoch += 1
        mine = _start_epoch
        _starting, _start_began, _slow_start_logged = True, time.monotonic(), False
    try:
        try:
            fresh = _Client(exe)
        except Exception as err:  # noqa: BLE001 — any failed start falls back to Python and backs off
            with _state:
                current_start = mine == _start_epoch
            if current_start:  # not one that was given up on already
                _process_failed(None, err)
            return None
        with _state:
            if mine == _start_epoch and _enabled and not _stopping:
                _generation += 1
                fresh.generation = _generation
                _client = fresh
                return fresh
        # Switched off, stopped or given up on while it started.
        _reap(fresh)
        return None
    finally:
        with _state:
            if mine == _start_epoch:
                _starting = False


def _declarations_fingerprint() -> str:
    """The runtime's fingerprint (FNV-1a, 64 bit) of the checked-in
    declarations, which the crate prints in the ``observes`` answer for the
    declarations it was built from. Line ends are normalised, as a checkout on
    Windows may convert them."""
    from .cli_vendors import _declared  # not at import: the vendors import this module

    hash_ = 0xCBF29CE484222325
    for byte in _declared.FILE.read_bytes().replace(b"\r\n", b"\n"):
        hash_ = ((hash_ ^ byte) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{hash_:016x}"


def _why_unusable(said: Any) -> str | None:
    """Why the build the process says it is cannot be used, None if it can."""
    if not isinstance(said, dict) or "version" not in said or "declarations" not in said:
        return "it does not say which build it is"
    if said["version"] != RUNTIME_VERSION:
        return f"it is version {said['version']!r}, this backend is written for {RUNTIME_VERSION!r}"
    try:
        expected = _declarations_fingerprint()
    except Exception as err:  # noqa: BLE001 — declarations that cannot be read cannot be matched
        return f"the backend's declarations could not be read ({err})"
    if said["declarations"] != expected:
        return "it was built from other CLI declarations than the backend's cli_declarations.json"
    return None


def _observed(client: "_Client") -> dict[str, dict]:
    global _known, _client, _runtime_said, _unusable
    if client.observed is None:
        answer = client.call("observes", CALL_TIMEOUT_S)
        result = answer.get("result") if answer.get("ok") else None
        result = result if isinstance(result, dict) else {}
        said = result.get(RUNTIME_KEY)
        why = _why_unusable(said)
        with _state:
            _runtime_said = said if isinstance(said, dict) else None
            first = _unusable is None  # callers that shared this handshake say it once
            if why is not None:
                _unusable = why
                if _client is client:
                    _client = None
        if why is not None:
            # As if there were no binary: nothing it answers is used, and it is
            # not started again until the switch is applied.
            client.observed = {}
            _known = {}
            _reap(client)
            if first:
                log.warning("navide-cli-runtime is not used: %s; every reader stays on Python", why)
        else:
            client.observed = {key: value for key, value in result.items() if key != RUNTIME_KEY}
            _known = client.observed
    return client.observed


#: What the last process said it observes: a call for one of these that could
#: not even be sent (the process is waiting to restart, or given up on) still
#: counts as a fallback.
_known: dict[str, dict] = {}


def _call(vendor: str, op: str, **fields: Any) -> "tuple[Any, dict] | None":
    """The runtime's result for a CLI it observes, with what it declares
    about that CLI; None means "use Python"."""
    client = _client_for_call()
    if client is None:
        if getattr(_aside, "stepped", False):
            _count(vendor, "deferred")  # another caller is starting the process: not a fault
        elif _enabled and vendor in _known and binary() is not None:
            _count(vendor, "fallback")
        return None
    try:
        declared = _observed(client).get(vendor)
        if declared is None:
            return None
        answer = client.call(op, CALL_TIMEOUT_S, vendor=vendor, **fields)
    except PythonReads:
        _count(vendor, "python")  # nothing was sent: not a fault, and the process is fine
        return None
    except Exception as err:  # noqa: BLE001 — the Python reader takes over
        _process_failed(client, err)
        _count(vendor, "fallback")
        return None
    if answer.get("ok"):
        _count(vendor, "rust")
        return answer.get("result"), declared
    kind = answer.get("kind")
    if kind == "unsupported":
        _count(vendor, "unsupported")
    elif kind == "io":
        _count(vendor, "unreadable")
    elif kind == "python":
        _count(vendor, "python")
    else:
        _count(vendor, "fallback")
        # A read that fails this way fails on every poll: said once per CLI
        # and kind (until the switch is applied again); `status()` counts all.
        with _state:
            said = (vendor, str(kind)) in _errors_logged
            _errors_logged.add((vendor, str(kind)))
        if not said:
            log.warning("navide-cli-runtime could not answer %s for %s (%s): %s; further such answers are "
                        "counted, not logged", op, vendor, kind, answer.get("error"))
    return None


def _cwd(declared: dict, value: str) -> str:
    """A cwd in the form the CLI's declaration names (the runtime hands it on
    as the transcript wrote it)."""
    return unicodedata.normalize("NFC", value) if declared.get("cwd") == "nfc" else value


def _log_notes(reader: Any, notes: Any) -> None:
    """What main's reader would have logged while reading: through the
    reader's own logger, once per reader and kind, as main warns once."""
    if not notes:
        return
    # Every note is read before any is said, so a malformed one says nothing.
    parsed = [(str(note.get("kind") or note.get("text") or ""), note.get("text")) for note in notes]
    module = sys.modules.get(type(reader).__module__)
    reader_log = getattr(module, "log", None) or log
    try:
        said = reader.__dict__.setdefault("_cli_runtime_notes", set())
    except AttributeError:  # a reader with __slots__: say it every time
        said = set()
    for kind, text in parsed:
        if kind not in said:
            said.add(kind)
            reader_log.warning("%s", text or kind)


def _apply_reads(reader: Any, path: Path, reads: Any) -> None:
    """What the runtime's reads have to tell the registry of read problems a
    reader keeps (OpenCode's and Kilo's ``read_problem()``, which the CLI's
    status shows): recorded and cleared through the reader's own methods, so
    a store the runtime read is disclosed exactly as one the reader read."""
    report, worked = getattr(reader, "_report_problem", None), getattr(reader, "_read_ok", None)
    if not reads or report is None or worked is None:
        return
    # Every entry is read before any is applied, so a malformed one writes
    # nothing to the registry.
    calls = [
        (worked, (read["key"],), {}) if read.get("ok")
        else (report, (read["key"], path, read["reason"], read["detail"]), {"status": read["status"]})
        for read in reads
    ]
    for call, args, kwargs in calls:
        call(*args, **kwargs)


def _reads_itself(reader: Any) -> bool:
    """A reader may ask to make its own reads for now (``reads_itself()``):
    one with a failing query on record does, so that the query which recorded
    the problem is the one that clears it."""
    asks = getattr(reader, "reads_itself", None)
    return bool(asks and asks())


def _ask(reader: Any, op: str, path: Path, **fields: Any) -> "tuple[Any, dict] | None":
    """The runtime's answer to one of `reader`'s calls, with what it declares
    about the CLI; None means the reader reads this one. What the answer said
    beside its result (`notes`, `reads`) is not applied here: each route does
    that once the result has been converted, so an answer that cannot be read
    falls back with nothing applied."""
    vendor = str(reader.vendor)
    if _reads_itself(reader):
        # Counted only for a CLI the process has said it observes. Before the
        # first handshake `_known` is empty, so this is not counted then (it
        # cannot be told from a CLI the runtime never observes); `_call`
        # counts a step-aside for a start in flight without that test.
        if vendor in _known:
            _count(vendor, "deferred")
        return None
    return _call(vendor, op, path=str(path), **fields)


def _apply_side(reader: Any, path: Path, result: dict) -> None:
    """Apply what the answer said beside its result, once it has been read."""
    _log_notes(reader, result.get("notes"))
    _apply_reads(reader, path, result.get("reads"))


# ---- the three routed reader calls ------------------------------------------

#: What a missing or mistyped field in the runtime's answer raises when it is
#: turned into the reader's objects.
_UNREADABLE_ANSWER = (KeyError, TypeError, ValueError, AttributeError, IndexError)


def _bad_answer(reader: Any, op: str, err: BaseException, original: Callable[..., Any], *args: Any) -> Any:
    """The runtime answered, but not in a shape this code reads: a fault, and
    the Python reader reads the call from the state the caller holds (nothing
    of the answer was applied), so the watcher never sees the error."""
    vendor = str(reader.vendor)
    with _state:
        counts = _counts.setdefault(vendor, dict.fromkeys(OUTCOMES, 0))
        counts["rust"] = max(0, counts["rust"] - 1)  # it was counted as answered
        counts["fallback"] += 1
        said = (vendor, "answer") in _errors_logged
        _errors_logged.add((vendor, "answer"))
    if not said:
        log.warning("navide-cli-runtime answered %s for %s in a shape this backend cannot read (%s: %s); "
                    "further such answers are counted, not logged", op, vendor, type(err).__name__, err)
    return original(*args)


def _usage(reader: Any, original: Callable[..., IncrementalParseResult], path: Path, checkpoint: dict) -> IncrementalParseResult:
    answer = _ask(reader, "usage", path, checkpoint=checkpoint or {})
    if answer is None:
        return original(path, checkpoint)
    result, declared = answer
    try:
        events = [
            TokenUsage(
                vendor=e["vendor"],
                input_tokens=e["input_tokens"],
                output_tokens=e["output_tokens"],
                cwd=_cwd(declared, e["cwd"]),
                session_id=e["session_id"],
                file_path=e["file_path"],
                dedup_key=e["dedup_key"],
                timestamp=e["timestamp"],
                model=e["model"],
                checkpoint=e["checkpoint"],
                raw=e["raw"],
                cache_read_tokens=e["cache_read_tokens"],
                cache_creation_tokens=e["cache_creation_tokens"],
                cli_version=e["cli_version"],
            )
            for e in result["events"]
        ]
        parsed = IncrementalParseResult(events, result["checkpoint"])
        _apply_side(reader, path, result)
        return parsed
    except _UNREADABLE_ANSWER as err:
        return _bad_answer(reader, "usage", err, original, path, checkpoint)


def _prompt(text: str, full: str) -> str:
    if not full:
        return text
    out = PromptText(text)
    out.full = full
    return out


def _activity(reader: Any, original: Callable[..., list[ActivityEvent]], path: Path, seen_keys: set[str]) -> list[ActivityEvent]:
    answer = _ask(reader, "activity", path, bag=sorted(seen_keys), now=time.time())
    if answer is None:
        return original(path, seen_keys)
    result, declared = answer
    try:
        # Everything is converted before the caller's bag is touched, so an
        # answer that cannot be read leaves the Python reader its own state.
        bag = list(result["bag"])
        error = result.get("error")
        events = [] if error else [
            ActivityEvent(
                vendor=e["vendor"],
                event_type=e["event_type"],
                cwd=_cwd(declared, e["cwd"]),
                session_id=e["session_id"],
                file_path=e["file_path"],
                dedup_key=e["dedup_key"],
                timestamp=e["timestamp"],
                detail=e["detail"],
                text=_prompt(e["text"], e.get("full", "")),
            )
            for e in result["events"]
        ]
        _apply_side(reader, path, result)
    except _UNREADABLE_ANSWER as err:
        return _bad_answer(reader, "activity", err, original, path, seen_keys)
    seen_keys.clear()
    seen_keys.update(bag)
    if error:
        # main's walk raises here too, after its state is saved.
        raise UnicodeDecodeError("utf-8", b"", 0, 1, str(error))
    return events


def _turns(reader: Any, original: Callable[..., list[TurnUsage]], path: Path, session_id: str = "") -> list[TurnUsage]:
    answer = _ask(reader, "turns", path, session_id=session_id or "", now=time.time())
    if answer is None:
        return original(path, session_id)
    result = answer[0]
    try:
        error = result.get("error")
        out: list[TurnUsage] = []
        for t in [] if error else result["turns"]:
            out.append(TurnUsage(
                turn_index=t["turn_index"],
                session_id=t["session_id"],
                started_at=t["started_at"],
                ended_at=t["ended_at"],
                prompt_excerpt=t["prompt_excerpt"],
                input=t["input"],
                cache_read=t["cache_read"],
                cache_creation=t["cache_creation"],
                output=t["output"],
                calls=[TurnCall(**c) for c in t["calls"]],
                model_calls=t["model_calls"],
                cli_version=t["cli_version"],
            ))
        _apply_side(reader, path, result)
    except _UNREADABLE_ANSWER as err:
        return _bad_answer(reader, "turns", err, original, path, session_id)
    if error:
        # main's strict text-mode pass raises on a transcript that is not UTF-8.
        raise UnicodeDecodeError("utf-8", b"", 0, 1, str(error))
    return out


#: Set on a reader that `wrap` has routed.
_ROUTED = "_cli_runtime_routed"

ROUTES = (("parse_incremental", _usage), ("parse_activity", _activity), ("turns_for_session", _turns))


def wrap(reader: Any) -> Any:
    """Route the reader's three record calls through the switch. Returns the reader.

    The bound methods are replaced on the instance, so the reader keeps its
    class, its attributes and every other method; each call checks the switch.
    A reader is routed once: wrapping it again returns it as it is (a second
    route would ask the runtime twice for every call it declines).
    """
    if not str(getattr(reader, "vendor", "") or "") or getattr(reader, _ROUTED, False):
        return reader
    for name, route in ROUTES:
        original = getattr(reader, name)

        def routed(*args: Any, _route=route, _original=original, **kwargs: Any) -> Any:
            if not _enabled:
                return _original(*args, **kwargs)
            return _route(reader, _original, *args, **kwargs)

        setattr(reader, name, routed)
    setattr(reader, _ROUTED, True)
    return reader
