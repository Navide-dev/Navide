"""Kimi Code CLI conversation log reader.

Format reference: docs/cli-log-formats.md (Kimi section).

Files: <KIMI_CODE_HOME|~/.kimi-code>/sessions/wd_<ws>/session_<uuid>/agents/main/wire.jsonl
Event filter: type=usage.record. Token fields are PER-TURN deltas (usageScope
"turn"), so they are summed as they arrive — NOT cumulative totals like Codex.

cwd: read from the session's state.json (workDir); wire.jsonl carries no cwd.
session_id: the `session_<uuid>` directory name — the exact id accepted by
`kimi --session <id>` / `-S`.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

import re

from .base import ExtensionsSource, ExtensionsSpec  # noqa: F401
from .base import AccountSwitchSpec, Dep, PlatformInstall, McpServerConfig, McpValue, McpWiring, SkillsWiring, VendorSpec, command_text
from ..usage_common import HTTP_TIMEOUT, _epoch_to_iso, _num, _snapshot, _window, parse_retry_after
from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    activity_high_water,
    join_text_blocks,
    read_jsonl_tail,
    set_activity_high_water,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.kimi")

# A Kimi user-facing turn spans MANY usage.record lines (one per agentic step),
# and wire.jsonl carries NO turn-end record — a turn is only implicitly closed
# by the next `turn.prompt`. So turn_complete is emitted at the turn *boundary*:
# the next turn.prompt (or turn.cancel) flushes the previous turn; the latest
# turn, having no following prompt, is flushed once the file goes quiet for
# _TURN_IDLE_MS (wall-clock silence = the turn is done).
_TURN_IDLE_MS = 8_000
_STATE_PREFIX = "kimi_turn::"

# The assistant's reply, persisted inside the watcher-owned seen_keys set (the
# same trick the Copilot reader uses) so a turn whose content.part and closing
# boundary land in different poll batches still carries its text.
_TEXT_PREFIX = "kimi_text::"
_TEXT_MAX_CHARS = 4_000


def _cap_text(text: str) -> str:
    if len(text) <= _TEXT_MAX_CHARS:
        return text
    half = _TEXT_MAX_CHARS // 2
    return f"{text[:half]}\n…\n{text[-half:]}"


def _read_last_text(seen_keys: set[str]) -> str:
    for k in seen_keys:
        if k.startswith(_TEXT_PREFIX):
            return k[len(_TEXT_PREFIX):]
    return ""


def _write_last_text(seen_keys: set[str], text: str) -> None:
    seen_keys.difference_update({k for k in seen_keys if k.startswith(_TEXT_PREFIX)})
    if text:
        seen_keys.add(f"{_TEXT_PREFIX}{text}")


def _read_turn_state(seen_keys: set[str]) -> dict | None:
    """The pending (currently-open) turn, persisted across polls inside the
    watcher-owned seen_keys set. Shape: {idx, last_ms, flushed}."""
    for k in seen_keys:
        if k.startswith(_STATE_PREFIX):
            try:
                val = json.loads(k[len(_STATE_PREFIX):])
            except json.JSONDecodeError:
                return None
            return val if isinstance(val, dict) else None
    return None


def _write_turn_state(seen_keys: set[str], state: dict | None) -> None:
    seen_keys.difference_update(
        {k for k in seen_keys if k.startswith(_STATE_PREFIX)}
    )
    seen_keys.add(_STATE_PREFIX + json.dumps(state, separators=(",", ":")))


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _kimi_home() -> Path:
    env = os.environ.get("KIMI_CODE_HOME")
    return Path(env) if env else Path.home() / ".kimi-code"


def _ts(ms) -> str:  # noqa: ANN001
    """Epoch-ms as a sortable string; wire.jsonl records `time` in epoch ms."""
    try:
        return str(int(ms))
    except (TypeError, ValueError):
        return ""


def _usage_tokens(usage: dict) -> tuple[int, int]:
    """Fold cache reads/creation into input (per TokenUsage design)."""
    input_tokens = (
        _int(usage.get("inputOther"))
        + _int(usage.get("inputCacheRead"))
        + _int(usage.get("inputCacheCreation"))
    )
    return input_tokens, _int(usage.get("output"))


class KimiLogReader(LogReader):
    vendor: str = "kimi"

    #: parse_activity walks a dense ascending line counter and resumes from
    #: one high-water mark, so an old file can be seeded to EOF by counting
    #: lines rather than replaying it (log_readers.base).
    activity_resumes_by_line: bool = True

    def _sessions_root(self) -> Path:
        return _kimi_home() / "sessions"

    def project_dirs(self) -> list[Path]:
        """The single default sessions root (empty list when it doesn't exist).

        Managed-account panes run with KIMI_CODE_HOME pointed at an isolated
        home, but that home's ``sessions`` is symlinked back to the real home
        (credential_vault), so every account's sessions resolve into this one
        root — no separate profile-home scan is needed. Returned as a list for
        the callers that iterate it."""
        default = self._sessions_root()
        return [default] if default.is_dir() else []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for f in root.glob("wd_*/session_*/agents/main/wire.jsonl"):
                    if f.is_file():
                        out.append(f)
            except OSError as err:
                log.debug("glob %s failed: %s", root, err)
        return out

    def has_session(self, session_id: str) -> bool:
        """True if a session dir named `session_id` exists under any workspace
        root (`~/.kimi-code/sessions/wd_*/<session_id>/`). The resume preflight
        uses this to reject bogus ids (e.g. a pre-fix "wire"/"state" history
        record) before they reach a doomed `kimi --session <id>`."""
        session_id = session_id.strip()
        if not session_id.startswith("session_"):
            return False
        for root in self.project_dirs():
            try:
                if any((wd / session_id).is_dir() for wd in root.glob("wd_*")):
                    return True
            except OSError:
                continue
        return False

    def _session_dir(self, path: Path) -> Path:
        # wire.jsonl → agents/main → agents → session_<uuid>
        return path.parent.parent.parent

    def _session_id(self, path: Path) -> str:
        return self._session_dir(path).name

    def _workdir_from_state(self, path: Path) -> str:
        """Read workDir from the session's state.json (wire.jsonl has no cwd)."""
        state = self._session_dir(path) / "state.json"
        try:
            rec = json.loads(state.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return ""
        return str(rec.get("workDir") or "") if isinstance(rec, dict) else ""

    def cwd_from_file(self, path: Path) -> str:
        return self._workdir_from_state(path)

    def session_id_from_path(self, path: Path) -> str:
        """Id is the `session_<uuid>` dir name, NOT the stem (every session
        file is wire.jsonl). Sibling files in the session dir (state.json,
        logs/) are not session files → '' so the resume sink skips them
        instead of coining ids like "state" or "wire"."""
        if path.name != "wire.jsonl":
            return ""
        return self._session_id(path)

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only sessions whose state.json workDir matches this workspace."""
        return [
            p for p in self.session_files()
            if self._workdir_from_state(p) == workspace_path
        ]

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        out: list[TokenUsage] = []
        cwd = self.cwd_from_file(path)
        session_id = self._session_id(path)
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
                if rec.get("type") != "usage.record":
                    continue
                usage = rec.get("usage")
                if not isinstance(usage, dict):
                    continue
                dedup_key = f"kimi::{session_id}::L{line_no}"
                if dedup_key in seen_keys:
                    continue
                input_tokens, output_tokens = _usage_tokens(usage)
                if input_tokens == 0 and output_tokens == 0:
                    continue
                seen_keys.add(dedup_key)
                out.append(
                    TokenUsage(
                        vendor="kimi",
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cwd=cwd,
                        session_id=session_id,
                        file_path=str(path),
                        dedup_key=dedup_key,
                        timestamp=_ts(rec.get("time")),
                        model=str(rec.get("model") or ""),
                    )
                )
        return out

    def parse_incremental(
        self, path: Path, checkpoint: dict
    ) -> IncrementalParseResult:
        """Parse only complete JSONL records after the persisted byte offset.

        wire.jsonl appends whole records (usage.record is written atomically,
        never streamed), so a byte offset alone guarantees no double count.
        """
        records, final_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        cwd = (
            self.cwd_from_file(path)
            if rotated or not checkpoint.get("cwd")
            else str(checkpoint.get("cwd"))
        )
        session_id = self._session_id(path)
        out: list[TokenUsage] = []

        for end, rec in records:
            if rec is None or rec.get("type") != "usage.record":
                continue
            usage = rec.get("usage")
            if not isinstance(usage, dict):
                continue
            input_tokens, output_tokens = _usage_tokens(usage)
            if input_tokens == 0 and output_tokens == 0:
                continue
            event_checkpoint = dict(final_checkpoint)
            event_checkpoint["offset"] = end
            event_checkpoint["cwd"] = cwd
            out.append(
                TokenUsage(
                    vendor="kimi",
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cwd=cwd,
                    session_id=session_id,
                    file_path=str(path),
                    dedup_key=f"kimi::{session_id}::@{end}",
                    timestamp=_ts(rec.get("time")),
                    model=str(rec.get("model") or ""),
                    checkpoint=event_checkpoint,
                )
            )

        final_checkpoint["cwd"] = cwd
        return IncrementalParseResult(out, final_checkpoint)

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for every prompt/usage line, and `turn_complete`
        once per user-facing turn — at the turn *boundary*, not per usage.record.

        A turn is closed (turn_complete emitted) when the next `turn.prompt`
        arrives or `turn.cancel` aborts it. The latest turn has no following
        prompt, so it is flushed once the file has been quiet for _TURN_IDLE_MS
        (wall-clock silence stands in for the turn-end record Kimi never writes).
        `dedup_key` is the turn index, so each turn notifies exactly once.

        turn_complete carries the assistant's closing reply, which is what lets
        Kimi panes send inter-CLI messages: the frontend only parses the
        ---MSG-START--- protocol out of a turn_complete that has text.
        """
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        session_id = self._session_id(path)
        state = _read_turn_state(seen_keys)
        last_text = _read_last_text(seen_keys)

        def _complete(idx: int, ms: int, detail: str) -> ActivityEvent:
            return ActivityEvent(
                vendor="kimi", event_type="turn_complete",
                cwd=cwd, session_id=session_id, file_path=str(path),
                dedup_key=f"turn:{idx}", timestamp=_ts(ms), detail=detail,
                text=last_text,
            )

        try:
            fh = path.open(encoding="utf-8")
        except OSError:
            return out

        # Every rtype branch below — turn.prompt, usage.record, the loop-event
        # one, turn.cancel and the `else` catch-all — marked its line seen, as
        # did the malformed-JSON path, and the walk is a dense ascending scan
        # from line 1. One high-water mark therefore carries the same
        # information without growing with wire.jsonl. See log_readers.base.
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

                    rtype = rec.get("type")
                    ts = _ts(rec.get("time"))
                    tms = _int(rec.get("time"))
                    if rtype == "turn.prompt":
                        # A new prompt closes the previous turn (if still open).
                        if state is not None and not state.get("flushed"):
                            out.append(_complete(
                                int(state["idx"]), int(state.get("last_ms") or 0),
                                "boundary",
                            ))
                            last_text = ""
                        idx = (int(state["idx"]) + 1) if state is not None else 0
                        state = {"idx": idx, "last_ms": tms, "flushed": False}
                        # The prompt's text blocks carry the user's words; the
                        # frontend names the pane from the first user text.
                        out.append(ActivityEvent(
                            vendor="kimi", event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts, detail="prompt",
                            text=user_prompt_text(join_text_blocks(rec.get("input"), "text")),
                        ))
                    elif rtype == "usage.record":
                        if state is not None and not state.get("flushed"):
                            state["last_ms"] = max(int(state.get("last_ms") or 0), tms)
                        out.append(ActivityEvent(
                            vendor="kimi", event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts, detail="usage",
                        ))
                    elif rtype == "context.append_loop_event":
                        if state is not None and state.get("cancelled"):
                            continue
                        if state is not None and not state.get("flushed"):
                            state["last_ms"] = max(int(state.get("last_ms") or 0), tms)
                        # The assistant's visible reply: content.part carries both
                        # `think` and `text` parts, and only the latter is what the
                        # user (and the messaging protocol) sees. Later parts in a
                        # turn replace earlier ones — the closing part is the reply.
                        event = rec.get("event")
                        if isinstance(event, dict) and event.get("type") == "content.part":
                            part = event.get("part")
                            if isinstance(part, dict) and part.get("type") in ("text", "think"):
                                text = str(part.get("text") or "").strip()
                                if text:
                                    # New content disproves an inferred idle
                                    # end; late accounting alone does not.
                                    if state is None or state.get("flushed"):
                                        idx = (int(state["idx"]) + 1) if state is not None else 0
                                        state = {"idx": idx, "last_ms": tms, "flushed": False}
                                    if part.get("type") == "text":
                                        last_text = _cap_text(text)
                    elif rtype == "turn.cancel":
                        if state is not None and not state.get("flushed"):
                            out.append(_complete(
                                int(state["idx"]),
                                max(int(state.get("last_ms") or 0), tms), "cancel",
                            ))
                            state["flushed"] = True
                        if state is not None:
                            state["cancelled"] = True
                            last_text = ""

                # The latest (still-open) turn has no following prompt; flush it once
                # the file has gone quiet long enough to treat the turn as finished.
                if state is not None and not state.get("flushed"):
                    now_ms = int(time.time() * 1000)
                    if now_ms - int(state.get("last_ms") or 0) >= _TURN_IDLE_MS:
                        out.append(_complete(
                            int(state["idx"]), int(state.get("last_ms") or 0), "idle",
                        ))
                        state["flushed"] = True
                        last_text = ""

        finally:
            set_activity_high_water(seen_keys, last_line)
            _write_turn_state(seen_keys, state)
            _write_last_text(seen_keys, last_text)
        return out


# ---- attribution/watch hooks ----------------------------------------------

def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # Reader emits cwd = the session state.json workDir.
    return bool(usage.cwd and usage.cwd == ws_path)


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return usage.cwd == pane_cwd


KimiLogReader.binds_by_marker_file = True
KimiLogReader.binds_new_session_single_candidate = True
KimiLogReader.emits_session_sink = True
KimiLogReader.workspace_match = _workspace_match
KimiLogReader.pane_cwd_match = _pane_cwd_match


# ---- usage quota -----------------------------------------------------------

KIMI_DEFAULT_BASE = "https://api.kimi.com"


def read_kimi_credentials(home: Path, env: dict | None = None,
                          now: float | None = None) -> str | None:
    """``KIMI_CODE_API_KEY`` env wins; otherwise the CLI OAuth file, used only
    while ``expires_at`` is more than 60 s away (matching CodexBar)."""
    env = env or {}
    api_key = env.get("KIMI_CODE_API_KEY")
    if api_key:
        return api_key
    kimi_home = Path(env["KIMI_CODE_HOME"]) if env.get("KIMI_CODE_HOME") else home / ".kimi-code"
    try:
        data = json.loads((kimi_home / "credentials" / "kimi-code.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    token = data.get("access_token")
    expires = _num(data.get("expires_at"))
    if not token or expires is None:
        return None
    now = time.time() if now is None else now
    return token if expires > now + 60 else None


def _kimi_used(detail: dict, limit):
    used = _num(detail.get("used"))
    if used is None:
        rem = _num(detail.get("remaining"))
        if rem is not None and limit is not None:
            used = max(0.0, limit - rem)
    return used


def _kimi_resets(detail: dict):
    r = (detail.get("resetTime") or detail.get("resetAt")
         or detail.get("reset_time") or detail.get("reset_at"))
    return r if isinstance(r, str) else None


def normalize_kimi(data: dict) -> tuple[list[dict], str | None]:
    windows: list[dict] = []
    usage = data.get("usage")
    if isinstance(usage, dict):
        limit = _num(usage.get("limit"))
        used = _kimi_used(usage, limit)
        if limit and used is not None:
            windows.append(_window("weekly", "Weekly", used / limit * 100,
                                   _kimi_resets(usage)))
    # CodexBar's Code-API model nests the 5h rate-limit under
    # ``limits[0].detail`` (KimiRateLimit { window, detail }), not at top level.
    limits = data.get("limits")
    if isinstance(limits, list) and limits and isinstance(limits[0], dict):
        detail = limits[0].get("detail")
        if isinstance(detail, dict):
            limit = _num(detail.get("limit"))
            used = _kimi_used(detail, limit)
            if limit and used is not None:
                windows.append(_window("session", "Rate limit (5h)",
                                       used / limit * 100, _kimi_resets(detail)))
    return windows, None




async def fetch_kimi(home: Path, env: dict | None = None) -> dict:
    import os

    env = env if env is not None else dict(os.environ)
    token = read_kimi_credentials(home, env)
    if token is None:
        return _snapshot("kimi", "no-credentials")
    import httpx

    base = (env.get("KIMI_CODE_BASE_URL") or KIMI_DEFAULT_BASE).rstrip("/")
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "Navide",
        "X-Msh-Platform": "kimi_code_cli",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(f"{base}/coding/v1/usages", headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("kimi", "expired")
    if resp.status_code == 429:
        snap = _snapshot("kimi", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("kimi", "error", error=f"HTTP {resp.status_code}")
    windows, plan = normalize_kimi(resp.json())
    return _snapshot("kimi", "ok", windows=windows, plan_type=plan)




# ---- resume / session ------------------------------------------------------

# Optional-id guard so the capture never swallows a following flag.
_RESUME_RE = re.compile(r"^kimi\s+(?:\S+\s+)*(?:--session|-S)\s+([^-\s]\S*)")


def _resume_id_from_command(command) -> str:
    """Session id from a `kimi ... --session <id>` / `-S <id>` command
    ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return m.group(1) if m else ""


def _session_exists(workspace_path: str, session_id: str) -> bool:
    # Sessions live at ~/.kimi-code/sessions/wd_*/<id>/; verify the id really
    # exists so a bogus record fails preflight instead of launching a doomed
    # `kimi --session <id>` that dead-ends the pane at startup.
    return KimiLogReader().has_session(session_id)


# ---- vendor spec -----------------------------------------------------------

# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(sources=(
    ExtensionsSource("hooks", (".kimi-code", "config.toml"), "Kimi hook", section=("hooks",)),
))

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="kimi",
    # Configurable provider/base URL; no verified default CLI host set here.
    expected_hosts=(),
    # Same runtime root as _kimi_home.
    data_dirs=lambda ctx: (ctx.path(ctx.env.get("KIMI_CODE_HOME") or ctx.home / ".kimi-code"),),
    data_dir_env_vars=("KIMI_CODE_HOME",),
    supports_model=True,
    skills_supported=True,
    # --skills-dir is repeatable but replaces auto-discovery outright, so the
    # roots kimi would have found itself are passed back alongside ours.
    skills_wiring=SkillsWiring(
        flag="--skills-dir",
        replaces_discovery=True,
        discovery_home=((".kimi-code", "skills"), (".agents", "skills")),
        discovery_project=((".agents", "skills"),),
    ),
    label="Kimi Code CLI (Moonshot AI)",
    # No flag and no config variable, so the MCP config can only be reached
    # through the config directory — which kimi, unlike grok and antigravity,
    # relocates with a variable of its own. A url with no transport field is
    # read as streamable HTTP.
    mcp_wiring=McpWiring(
        config=McpServerConfig(
            section=("mcpServers",),
            entry=(("url", McpValue.URL),),
        ),
        config_dir=".kimi-code",
        config_dir_env="KIMI_CODE_HOME",
        config_file=("mcp.json",),
    ),
    login_command_args="login",
    live_file=(".kimi-code", "credentials", "kimi-code.json"),
    slot_file="kimi-code.json",
    login_home_secret_file=("credentials", "kimi-code.json"),
    profile_home_secret_file=("credentials", "kimi-code.json"),
    login_home_env="KIMI_CODE_HOME",
    # Whole-file swap of the OAuth credential; the CLI loads it at startup,
    # so affected panes restart and resume. The layout is read from the
    # installed CLI and exercised by the quota reader, but no A -> B -> A
    # round-trip on two real accounts is on record — "source" until then.
    account_switch=AccountSwitchSpec(
        auth_scope="kimi",
        method="restart",
        store="file",
        evidence="source",
        verified_version="0.39.0",
        # read_kimi_credentials: KIMI_CODE_API_KEY wins over the OAuth file.
        shadowing_env=("KIMI_CODE_API_KEY",),
        resume="native",
        todo="A -> B -> A round-trip on two real accounts not yet recorded",
    ),
    # Late-bound (module global at call time) so tests can monkeypatch.
    fetch_usage=lambda home: fetch_kimi(home),
    resume_id_from_command=_resume_id_from_command,
    session_exists=_session_exists,
    # pi-tui otherwise treats a split ESC prefix as Escape after 10ms. Pane
    # input crosses the renderer/WebSocket/PTY boundary, so give Kimi the same
    # reassembly window pi-tui already uses for remote terminals.
    spawn_env_defaults=(("PI_TUI_ESC_TIMEOUT", "100"),),
    home_env_vars=("KIMI_CODE_HOME",),
    make_log_reader=KimiLogReader,
    # Kimi Code ships `kimi doctor` and `kimi upgrade` (aliased `update`);
    # verified with `kimi --help` on 1.x.
    install_dep=Dep("kimi", "Kimi Code CLI (Moonshot AI)", "Moonshot AI Kimi Code CLI", "agent_cli",
        ["kimi", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
        needs_terminal=True, requires_binaries=("curl",), optional=True,
        # kimi-cli's docs site is being wound down in favour of kimi-code.
        docs_url="https://moonshotai.github.io/kimi-code/",
        # Windows: the official PowerShell installer, per
        # https://moonshotai.github.io/kimi-code/en/guides/getting-started
        # (kimi then needs Git for Windows at first launch, not to install).
        install_cmds={"win32": PlatformInstall(
            "irm https://code.kimi.com/kimi-code/install.ps1 | iex", needs_terminal=True)},
        update_cmd="kimi upgrade",
        doctor_cmd="kimi doctor"),
)
