"""Droid (Factory) conversation log reader + vendor spec.

Layout (verified against droid 0.204.0's own session code and a real file on
disk):

  ~/.factory/sessions/<encoded-cwd>/<sessionId>.jsonl          messages
  ~/.factory/sessions/<encoded-cwd>/<sessionId>.settings.json  token totals
  ~/.factory/sessions/                                          flat fallback
  ~/.factory/sessions/btw/                                      forked sessions

The encoding is NOT ``encode_claude_cwd``. Droid replaces only path separators,
so a directory named ``Agent-Team`` keeps its hyphen and a dotted path keeps its
dots, where Claude would flatten both. Reusing Claude's encoder would silently
miss the directory on any path holding a non-alphanumeric character other than
a separator.

Droid's encoder is also not the same on every OS: the macOS/Linux build strips
the leading slash run and rewrites only ``/``, while the Windows build drops
the drive-letter colon and rewrites both backslashes and ``/`` (see
``encode_droid_cwd``). The workspace path has to be encoded with the spelling
the running droid writes, or session discovery and resume look in the wrong
directory.

Record types, from droid's own reader loops (everything else is skipped):
  session_start        first line, carries ``cwd`` / ``lastCwd``
  message              ``message.role`` is only ever "user" or "assistant";
                       ``content`` is an Anthropic-shaped block list
  compaction_state     history compaction bookkeeping
  agent_turn_outcome   ``{turnId, reason, resultKind}`` — the turn boundary

Turn ends are a RECORD, not an inference: droid appends an
``agent_turn_outcome`` line naming why the turn stopped. There is no
``stop_reason`` field anywhere in the file — that name appears in the binary
only inside the bundled Anthropic SDK and in OpenTelemetry attributes.

Per-message token usage is likewise absent. The JSONL carries at most an
opaque ``tokens`` integer; the real breakdown lives in the sidecar
``.settings.json`` as a running session total, which is what this reader
differences into deltas.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

from .base import ExtensionsSource, ExtensionsSpec  # noqa: F401
from .base import AccountSwitchSpec, Dep, PlatformInstall, VendorSpec, command_text
from ..osplat import platform_id as _platform_id
from ..log_readers.base import (
    ActivityEvent,
    LogReader,
    TokenUsage,
    activity_high_water,
    join_text_blocks,
    set_activity_high_water,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.droid")


def _encode_posix_droid_cwd(cwd: str) -> str:
    """The macOS/Linux spelling, read from droid's own encoder: strip trailing
    separators, strip the leading ``/`` run, collapse each remaining ``/`` run
    to a single ``-``, prepend ``-``. Only separators are touched."""
    text = re.sub(r"[\\/]+$", "", cwd)
    text = re.sub(r"^/+", "", text)
    return "-" + re.sub(r"/+", "-", text)


def _encode_windows_droid_cwd(cwd: str) -> str:
    """The Windows spelling, read from droid's own encoder: strip trailing
    separators, drop the drive letter's colon (``C:`` -> ``C``), collapse each
    run of ``\\`` or ``/`` to a single ``-``, prepend ``-``. A UNC path keeps
    its leading separator run, so ``\\\\server\\share`` names the directory
    ``--server-share``."""
    text = re.sub(r"[\\/]+$", "", cwd)
    text = re.sub(r"^([A-Za-z]):", r"\1", text)
    return "-" + re.sub(r"[\\/]+", "-", text)


def encode_droid_cwd(cwd: str, platform: str | None = None) -> str:
    """Droid's session-directory name for a cwd on ``platform``.

    Droid ships a different encoder per OS, so the spelling is not shared:
    macOS/Linux strips the leading slash and rewrites only ``/``, while Windows
    drops the drive-letter colon and rewrites both separators. ``platform``
    defaults to this process's platform (``osplat.platform_id``) and is
    overridable so both spellings can be exercised on any host, including on a
    native Windows runner.
    """
    if (platform or _platform_id) == "win32":
        return _encode_windows_droid_cwd(cwd)
    return _encode_posix_droid_cwd(cwd)


# Credential store (droid 0.206.0 bundle, class XlH): the login is an
# ENCRYPTED blob file under the factory home. Read from the bundle:
#
# * blob = ``<iv>:<tag>:<ciphertext>`` (base64), AES-256-GCM with no AAD and
#   nothing path-bound (functions BkR/eAR);
# * key = 32 random bytes (``randomBytes(32)``) generated once and kept in the
#   OS keyring under service "Factory CLI" with a FIXED account name —
#   "auth-encryption-key-security-cli" when stored through the macOS
#   `security` CLI (blob file ``auth.v2.loginkeychain``), "auth-encryption-key"
#   when stored through keytar (blob file ``auth.v2.keyring``); a "-dev"
#   suffix on non-production tiers. Neither the account name nor the key
#   derivation involves the base directory, so a blob written under
#   ``FACTORY_HOME_OVERRIDE`` (a login home) decrypts in the real home, and
#   two accounts' blobs are interchangeable files. Navide never reads the key.
# * ``FACTORY_DISABLE_KEYRING`` switches to a key FILE (``auth.v2.key``) beside
#   the blob (``auth.v2.file``) — per directory, so a login-home blob would NOT
#   decrypt in the real home. That mode is refused, not swapped.
DROID_AUTH_FILES = ("auth.v2.loginkeychain", "auth.v2.keyring")
DROID_KEYFILE_MODE_FILES = ("auth.v2.key", "auth.v2.file")
DROID_HOME_ENV = "FACTORY_HOME_OVERRIDE"


def _droid_home(home: Path, env: dict | None = None) -> Path:
    env = os.environ if env is None else env
    override = env.get(DROID_HOME_ENV)
    return Path(override) if override else home / ".factory"


def _droid_credential_file(home: Path, env: dict | None = None) -> Path:
    """Whichever keyring-backed blob exists; the `security`-backed name when
    neither does yet. A home in key-file mode (``auth.v2.key`` present) has
    no swappable blob — the vault is told so rather than handed a file
    another directory's key encrypted."""
    root = _droid_home(home, env)
    if (root / DROID_KEYFILE_MODE_FILES[0]).is_file():
        raise ValueError(
            "droid stores its login with a per-directory key file "
            "(FACTORY_DISABLE_KEYRING); the blob cannot be moved between homes"
        )
    for name in DROID_AUTH_FILES:
        if (root / name).is_file():
            return root / name
    return root / DROID_AUTH_FILES[0]


def identity_from_secret(secret):
    """The blob is encrypted with a key Navide never reads: presence is all
    that can be reported. No email, no user id."""
    return {"email": None, "signedIn": bool(secret and secret.strip())}


def droid_sessions_root() -> Path | None:
    """The sessions root, or None when droid has never run on this machine."""
    override = os.environ.get("FACTORY_HOME_OVERRIDE")
    home = Path(override) if override else Path.home() / ".factory"
    root = home / "sessions"
    return root if root.is_dir() else None


def _session_settings_path(path: Path) -> Path:
    """Sidecar holding this session's token totals."""
    return path.parent / f"{path.stem}.settings.json"


def _int(value) -> int:  # noqa: ANN001
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


#: Running-total marker for the sidecar diff. One key, replaced in place: the
#: sidecar reports cumulative counters, so all a later poll needs is the pair
#: already accounted for. Kept off the per-event dedup keys deliberately —
#: see log_readers.base on unbounded seen_keys growth.
_TOKEN_MARK_PREFIX = "droid_tok::"
_TEXT_MARK_PREFIX = "droid_text::"


def _token_mark(seen_keys: set[str]) -> tuple[int, int]:
    for key in seen_keys:
        if key.startswith(_TOKEN_MARK_PREFIX):
            try:
                got_in, got_out = key[len(_TOKEN_MARK_PREFIX):].split(":")
                return int(got_in), int(got_out)
            except ValueError:
                return 0, 0
    return 0, 0


def _set_token_mark(seen_keys: set[str], total_in: int, total_out: int) -> None:
    seen_keys.difference_update(
        {k for k in seen_keys if k.startswith(_TOKEN_MARK_PREFIX)}
    )
    seen_keys.add(f"{_TOKEN_MARK_PREFIX}{total_in}:{total_out}")


def _is_hook_record(msg: dict) -> bool:
    """A hook's own bookkeeping entry, not conversation.

    Droid persists every hook invocation as a role="user" message carrying
    ``hookEventName``. Treating those as prompts would name a pane after a
    shell snippet.
    """
    return bool(msg.get("hookEventName"))


def _has_block(content, block_type: str) -> bool:
    if not isinstance(content, list):
        return False
    return any(
        isinstance(b, dict) and b.get("type") == block_type for b in content
    )


class DroidLogReader(LogReader):
    vendor: str = "droid"

    #: parse_activity walks a dense ascending line counter and resumes from
    #: one high-water mark, so an old file can be seeded to EOF by counting
    #: lines rather than replaying it (log_readers.base).
    activity_resumes_by_line: bool = True

    def _default_root(self) -> Path | None:
        return droid_sessions_root()

    def project_dirs(self) -> list[Path]:
        root = self._default_root()
        return [root] if root is not None else []

    def session_files(self) -> list[Path]:
        """Every session file under the sessions root.

        Covers all three layouts droid's own ``findSessionFile`` looks in: the
        per-cwd subdirectory, the flat root, and ``btw/`` for forks.
        """
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for child in root.iterdir():
                    if child.is_file() and child.suffix == ".jsonl":
                        out.append(child)
                        continue
                    if not child.is_dir():
                        continue
                    try:
                        for f in child.iterdir():
                            if f.is_file() and f.suffix == ".jsonl":
                                out.append(f)
                    except OSError as err:
                        log.debug("enumerate %s failed: %s", child, err)
            except OSError as err:
                log.debug("enumerate %s failed: %s", root, err)
        return out

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only the files under this workspace's own session directory."""
        encoded = encode_droid_cwd(workspace_path)
        out: list[Path] = []
        for root in self.project_dirs():
            d = root / encoded
            if not d.is_dir():
                continue
            try:
                for f in d.iterdir():
                    if f.is_file() and f.suffix == ".jsonl":
                        out.append(f)
            except OSError as err:
                log.debug("enumerate %s failed: %s", d, err)
        return out

    def cwd_from_file(self, path: Path) -> str:
        """The session's working directory, read from its ``session_start``.

        Droid records the absolute path outright, so this is exact rather than
        the best-effort directory-name reversal Claude has to do — a name like
        ``-Users-me-Agent-Team`` cannot be reversed unambiguously, since the
        hyphen in ``Agent-Team`` is indistinguishable from a separator.
        ``lastCwd`` wins over ``cwd`` because droid itself prefers it: ``cwd``
        is the directory the session is FILED under, ``lastCwd`` where it
        actually ran last.
        """
        try:
            with path.open(encoding="utf-8") as fh:
                first = fh.readline()
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return ""
        try:
            rec = json.loads(first)
        except json.JSONDecodeError:
            return ""
        if not isinstance(rec, dict) or rec.get("type") != "session_start":
            return ""
        return str(rec.get("lastCwd") or rec.get("cwd") or "")

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        """Difference the sidecar's running totals into one delta event.

        The JSONL itself has no usage breakdown, so there is nothing per-line
        to read here: droid keeps the counters in ``<id>.settings.json`` and
        rewrites them as the session advances.
        """
        sidecar = _session_settings_path(path)
        try:
            raw = sidecar.read_text(encoding="utf-8")
        except OSError:
            return []
        try:
            doc = json.loads(raw)
        except json.JSONDecodeError:
            log.debug("%s malformed JSON, skipping", sidecar.name)
            return []
        if not isinstance(doc, dict):
            return []
        usage = doc.get("tokenUsage")
        if not isinstance(usage, dict):
            return []

        # Cache counters fold into input, matching TokenUsage's contract.
        total_in = (
            _int(usage.get("inputTokens"))
            + _int(usage.get("cacheCreationTokens"))
            + _int(usage.get("cacheReadTokens"))
        )
        # thinkingTokens is NOT added: droid reports it beside outputTokens
        # rather than inside it in its own UI, and double-counting reasoning
        # would inflate every thinking-heavy turn. Left out until a real
        # authenticated session settles which it is.
        total_out = _int(usage.get("outputTokens"))

        seen_in, seen_out = _token_mark(seen_keys)
        delta_in = total_in - seen_in
        delta_out = total_out - seen_out
        # A shrink means the sidecar was replaced (a fork, a reset), not that
        # tokens were refunded — re-baseline instead of emitting nonsense.
        if delta_in < 0 or delta_out < 0:
            _set_token_mark(seen_keys, total_in, total_out)
            return []
        if delta_in == 0 and delta_out == 0:
            return []

        dedup_key = f"usage::{path.stem}::{total_in}::{total_out}"
        if dedup_key in seen_keys:
            return []
        seen_keys.add(dedup_key)
        _set_token_mark(seen_keys, total_in, total_out)

        return [
            TokenUsage(
                vendor="droid",
                input_tokens=delta_in,
                output_tokens=delta_out,
                cwd=self.cwd_from_file(path),
                session_id=path.stem,
                file_path=str(path),
                dedup_key=dedup_key,
                model=str(doc.get("model") or ""),
            )
        ]

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` per message and `turn_complete` per outcome.

        Every ``agent_turn_outcome`` closes the turn, whatever its ``reason``:
        a cancelled or errored turn has still stopped, and withholding the
        event there would park the pane mid-turn forever. The reason rides on
        ``detail`` so the caller can tell a clean finish from an abort.
        """
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        session_id = path.stem
        try:
            fh = path.open(encoding="utf-8")
        except OSError:
            return out

        high_water = activity_high_water(seen_keys)
        last_line = high_water
        # The outcome can arrive in a later poll than its assistant message.
        last_assistant_text = next(
            (key[len(_TEXT_MARK_PREFIX):] for key in seen_keys
             if key.startswith(_TEXT_MARK_PREFIX)), ""
        )

        try:
            with fh:
                for line_no, raw_line in enumerate(fh, 1):
                    raw = raw_line.strip()
                    if not raw:
                        continue
                    if line_no <= high_water:
                        continue
                    try:
                        rec = json.loads(raw)
                    except json.JSONDecodeError:
                        # Still being written — leave the mark behind it so the
                        # completed line is read next poll. Stepping over a
                        # half-written outcome line is what strands a pane.
                        if not raw_line.endswith("\n"):
                            break
                        last_line = line_no
                        continue
                    last_line = line_no
                    if not isinstance(rec, dict):
                        continue

                    rtype = rec.get("type")
                    ts = str(rec.get("timestamp") or "")

                    if rtype == "agent_turn_outcome":
                        reason = str(rec.get("reason") or "")
                        out.append(ActivityEvent(
                            vendor="droid",
                            event_type="turn_complete",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=f"turn:{line_no}", timestamp=ts,
                            detail=reason, text=last_assistant_text,
                        ))
                        last_assistant_text = ""
                        continue

                    if rtype != "message":
                        continue
                    msg = rec.get("message")
                    if not isinstance(msg, dict):
                        continue

                    role = str(msg.get("role") or "")
                    content = msg.get("content")
                    key = f"act:{line_no}"

                    if role == "assistant":
                        last_assistant_text = join_text_blocks(content, "text")
                        out.append(ActivityEvent(
                            vendor="droid",
                            event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts,
                            detail="assistant",
                        ))
                        continue

                    # role == "user" covers three different things: a real
                    # prompt, a tool result droid files under the user role,
                    # and a hook's bookkeeping entry. Only the first may carry
                    # text, or a pane gets auto-named after a shell snippet.
                    text = ""
                    if (
                        role == "user"
                        and not _is_hook_record(msg)
                        and not _has_block(content, "tool_result")
                    ):
                        last_assistant_text = ""
                        text = user_prompt_text(join_text_blocks(content, "text"))
                    out.append(ActivityEvent(
                        vendor="droid",
                        event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts,
                        detail="user", text=text,
                    ))
        finally:
            set_activity_high_water(seen_keys, last_line)
            seen_keys.difference_update(
                {key for key in seen_keys if key.startswith(_TEXT_MARK_PREFIX)}
            )
            if last_assistant_text:
                seen_keys.add(_TEXT_MARK_PREFIX + last_assistant_text)
        return out


DroidLogReader.emits_session_sink = True
# Droid cannot pin a session id at launch, so the kickoff marker is what binds
# a new session file to the pane that started it; the single-candidate cwd
# fallback covers a marker that never made it into the transcript.
DroidLogReader.binds_by_marker_file = True
DroidLogReader.binds_new_session_single_candidate = True


def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # Reader emits cwd = the session_start record's cwd (lastCwd preferred).
    return bool(usage.cwd and usage.cwd == ws_path)


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return usage.cwd == pane_cwd


DroidLogReader.workspace_match = _workspace_match
DroidLogReader.pane_cwd_match = _pane_cwd_match


# ---- resume / session ------------------------------------------------------

# `-r` and `--resume` are the same option (droid --help, 0.204.0).
_RESUME_RE = re.compile(r"^droid\s+(?:\S+\s+)*(?:--resume|-r)\s+(\S+)")


def _resume_id_from_command(command) -> str:  # noqa: ANN001
    match = _RESUME_RE.match(command_text(command).strip())
    return match.group(1) if match else ""


def _session_path(workspace_path: str, session_id: str) -> Path | None:
    root = droid_sessions_root()
    if root is None:
        return None
    return root / encode_droid_cwd(workspace_path) / f"{session_id}.jsonl"


def _session_exists(workspace_path: str, session_id: str) -> bool:
    """True when this workspace's session file is on disk.

    Also accepts the flat and ``btw/`` layouts droid falls back to, so a forked
    session is not reported missing and replaced with a fresh pane.
    """
    root = droid_sessions_root()
    if root is None:
        return False
    candidates = (
        root / encode_droid_cwd(workspace_path) / f"{session_id}.jsonl",
        root / f"{session_id}.jsonl",
        root / "btw" / f"{session_id}.jsonl",
    )
    return any(p.is_file() for p in candidates)


# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(sources=(
    ExtensionsSource("plugin-dirs", (".factory", "plugins"), "Droid plugin", settings=(".factory", "settings.json")),
    ExtensionsSource("hooks", (".factory", "settings.json"), "Droid hook", section=("hooks",)),
))

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="droid",
    # Factory/custom model service destinations have not been verified here.
    expected_hosts=(),
    # FACTORY_HOME_OVERRIDE relocates the whole tree (droid_sessions_root).
    data_dirs=lambda ctx: (ctx.path(ctx.env.get("FACTORY_HOME_OVERRIDE") or ctx.home / ".factory"),),
    data_dir_env_vars=("FACTORY_HOME_OVERRIDE",),
    label="Droid CLI (Factory)",
    # Quota exhaustion, read from the 0.206.0 bundle (not reproduced live):
    # the structured ``agent_turn_outcome.reason`` value (the reader passes
    # it as the turn_complete detail) plus the TUI banners. Neighbours such
    # as model_authentication_failed / rate_limited are deliberately absent.
    quota_exhausted_patterns=(
        r"^model_usage_exhausted$",
        r"(Standard Usage limit reached|standard credit limits are exhausted|usage quota is exhausted\. Limits reset at)",
    ),
    # Multi-account: the encrypted login blob is swapped as a file (see
    # DROID_AUTH_FILES). A login pane runs under FACTORY_HOME_OVERRIDE, where
    # `droid` writes a fresh blob with the same machine-wide key. Both keyring
    # branches use fixed key names, so the swap is platform-independent; the
    # keytar branch has only been read, not seen running. Restart, then
    # ``droid --resume <uuid>``.
    live_file=(".factory", DROID_AUTH_FILES[0]),
    live_file_resolver=lambda home: _droid_credential_file(home),
    slot_file="auth.v2.blob",
    login_home_secret_file=(DROID_AUTH_FILES[0],),
    login_home_env=DROID_HOME_ENV,
    identity_from_secret=identity_from_secret,
    account_switch=AccountSwitchSpec(
        auth_scope="droid",
        method="restart",
        store="file",
        evidence="source",
        verified_version="0.206.0",
        # FACTORY_API_KEY is verified ahead of the stored login;
        # FACTORY_DISABLE_KEYRING puts the CLI in key-file mode (see above).
        shadowing_env=("FACTORY_API_KEY", "FACTORY_DISABLE_KEYRING"),
        resume="native",
        todo="key/blob layout read from the 0.206.0 bundle (machine-wide keyring key, no path binding); identity unreadable; keytar branch (Linux/Windows) not seen running; no real-account round-trip recorded",
    ),
    resume_id_from_command=_resume_id_from_command,
    session_path=_session_path,
    session_exists=_session_exists,
    home_env_vars=(
        # Relocates the whole ~/.factory tree.
        "FACTORY_HOME_OVERRIDE",
        # Points droid at a settings file for that process only (--settings).
        "FACTORY_RUNTIME_SETTINGS_PATH",
        # Droid stamps its own child processes with this. Inherited by a pane
        # spawned from inside a droid session, it makes that pane a child of
        # the parent's session instead of starting its own — the same class of
        # bug CLAUDE_CODE_CHILD_SESSION causes for claude.
        "DROID_PARENT_SESSION_ID",
    ),
    make_log_reader=DroidLogReader,
    install_dep=Dep("droid", "Droid CLI (Factory)", "Factory AI coding agent", "agent_cli",
        ["droid", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="brew install --cask droid", needs_terminal=True,
        requires_binaries=("brew",),
        optional=True, docs_url="https://docs.factory.ai/cli/getting-started/overview",
        # Windows: the official PowerShell installer, per
        # https://docs.factory.ai/droid-cli/quickstart — not npm, whose builds
        # ship with `droid update` disabled.
        install_cmds={"win32": PlatformInstall(
            "irm https://app.factory.ai/cli/windows | iex", needs_terminal=True)},
        update_cmd="droid update", doctor_cmd="droid doctor",
        config_home_default=".factory"),
)
