"""Per-call AI usage ledger: the durable record AI development cost is computed from.

One row per model call in ``usage_calls`` (navide.db), keyed on
``(vendor, dedup_key)`` — the dedup key the vendor's log reader already
composes (claude: ``message.id::requestId``; other vendors' keys are prefixed
with the log file, see ledger_key). Writes are INSERT OR IGNORE, so a
replay, a backfill or a crash-and-reread of the same log never counts a call
twice, and any log can be re-ingested safely.

Unlike the tokens.* documents in tokens_store, rows keep the session, the
transcript's own cwd, the model and the four-way token split, which is what a
dollar figure needs. Dollars are never stored: they are computed at query time
from the versioned ``cost_pricing.json``, so a price change re-prices history
without the raw logs. Once a call is here its raw log is no longer needed to
answer "what did this cost".

``usage_daily`` is a view over ``usage_calls`` (day × cwd × vendor × model), so
it can never drift from the rows it sums.

``pane_sessions`` (schema 2) maps each pane to the sessions it ran, written
with every call that names a pane. Rows that name no pane (a backfill, a call
read before its pane claimed the session) take their session's pane from it,
and cost_report compares the two views per pane.

``profile_id`` (schema 3) is the account slot the call ran on, as the token
sink attributed it; '' when unknown. It is stored as an opaque string and never
interpreted here. Upgrading to schema 3 fills it for the last 30 days of rows
whose log lives under a Navide claude profile dir (see profile_from_path).
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any, Iterable

from .db import Database
from .log_readers.base import TokenUsage
from .pane_account_history import parse_event_time

log = logging.getLogger("agent_team_backend.cost_ledger")

PRICING_FILE = Path(__file__).with_name("cost_pricing.json")

_INSERT = (
    "INSERT OR IGNORE INTO usage_calls (vendor, dedup_key, session_id, cwd,"
    " workspace, pane, model, ts, input, cache_read, cache_write_5m,"
    " cache_write_1h, output, source_file, profile_id)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)

# A session-totals row (see _row) only ever moves forward: a re-read that
# started earlier or later lands on the same or a larger total.
_UPSERT_TOTALS = (
    "INSERT INTO usage_calls (vendor, dedup_key, session_id, cwd,"
    " workspace, pane, model, ts, input, cache_read, cache_write_5m,"
    " cache_write_1h, output, source_file, profile_id)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    " ON CONFLICT(vendor, dedup_key) DO UPDATE SET"
    " ts = excluded.ts, input = excluded.input, cache_read = excluded.cache_read,"
    " cache_write_5m = excluded.cache_write_5m, output = excluded.output,"
    " model = CASE WHEN excluded.model != '' THEN excluded.model ELSE model END,"
    " workspace = CASE WHEN excluded.workspace != '' THEN excluded.workspace ELSE workspace END,"
    " pane = CASE WHEN excluded.pane != '' THEN excluded.pane ELSE pane END,"
    " profile_id = CASE WHEN excluded.profile_id != '' THEN excluded.profile_id ELSE profile_id END"
    " WHERE excluded.input + excluded.cache_read + excluded.output"
    " > input + cache_read + output"
)


def _create_schema_v1(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE usage_calls ("
        " vendor TEXT NOT NULL,"
        " dedup_key TEXT NOT NULL,"
        " session_id TEXT NOT NULL,"
        " cwd TEXT NOT NULL,"         # the transcript's own cwd (NFC), not the dir name
        " workspace TEXT NOT NULL,"   # Navide's attributed workspace; '' when unknown
        " pane TEXT NOT NULL,"        # attributed pane slot; '' when unknown
        " model TEXT NOT NULL,"
        " ts INTEGER NOT NULL,"       # unix seconds of the call
        " input INTEGER NOT NULL,"    # uncached input only
        " cache_read INTEGER NOT NULL,"
        " cache_write_5m INTEGER NOT NULL,"
        " cache_write_1h INTEGER NOT NULL,"
        " output INTEGER NOT NULL,"
        " source_file TEXT NOT NULL,"
        " PRIMARY KEY (vendor, dedup_key))"
    )
    cur.execute("CREATE INDEX usage_calls_ts ON usage_calls (ts)")
    cur.execute("CREATE INDEX usage_calls_cwd_ts ON usage_calls (cwd, ts)")
    cur.execute("CREATE INDEX usage_calls_session ON usage_calls (session_id)")
    cur.execute(
        "CREATE VIEW usage_daily AS SELECT"
        " date(ts, 'unixepoch') AS day, cwd, vendor, model,"
        " COUNT(*) AS calls, SUM(input) AS input, SUM(cache_read) AS cache_read,"
        " SUM(cache_write_5m) AS cache_write_5m, SUM(cache_write_1h) AS cache_write_1h,"
        " SUM(output) AS output"
        " FROM usage_calls GROUP BY day, cwd, vendor, model"
    )


def _create_schema_v2(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE pane_sessions ("
        " pane TEXT NOT NULL,"
        " vendor TEXT NOT NULL,"
        " session_id TEXT NOT NULL,"
        " workspace TEXT NOT NULL,"
        " first_ts INTEGER NOT NULL,"
        " last_ts INTEGER NOT NULL,"
        " PRIMARY KEY (pane, vendor, session_id))"
    )
    cur.execute("CREATE INDEX pane_sessions_session ON pane_sessions (vendor, session_id)")


#: How far back the schema-3 upgrade fills profile_id from log paths.
BACKFILL_PROFILE_DAYS = 30

# <...>/cli-profiles/claude/<profile_id>/... ; a removed profile's dir is
# renamed "<profile_id>.deleted-<ns>", the same slot.
_PROFILE_DIR = re.compile(r"[/\\]cli-profiles[/\\]claude[/\\]([^/\\]+?)(?:\.deleted-\d+)?[/\\]")


def profile_from_path(source_file: str) -> str:
    """The claude profile slot a log path lives under, or '' when it is not a
    Navide claude profile dir (a live login's ~/.claude, another vendor)."""
    m = _PROFILE_DIR.search(source_file or "")
    return m.group(1) if m else ""


def _create_schema_v3(cur: sqlite3.Cursor, now: float | None = None) -> None:
    cur.execute("ALTER TABLE usage_calls ADD COLUMN profile_id TEXT NOT NULL DEFAULT ''")
    cur.execute("CREATE INDEX usage_calls_profile_ts ON usage_calls (profile_id, ts)")
    cur.execute("DROP VIEW usage_daily")
    cur.execute(
        "CREATE VIEW usage_daily AS SELECT"
        " date(ts, 'unixepoch') AS day, cwd, vendor, model, profile_id,"
        " COUNT(*) AS calls, SUM(input) AS input, SUM(cache_read) AS cache_read,"
        " SUM(cache_write_5m) AS cache_write_5m, SUM(cache_write_1h) AS cache_write_1h,"
        " SUM(output) AS output"
        " FROM usage_calls GROUP BY day, cwd, vendor, model, profile_id"
    )
    cutoff = int((time.time() if now is None else now) - BACKFILL_PROFILE_DAYS * 86400)
    rows = cur.execute(
        "SELECT rowid, source_file FROM usage_calls"
        " WHERE ts >= ? AND vendor = 'claude' AND source_file LIKE '%cli-profiles%'",
        (cutoff,),
    ).fetchall()
    updates = [(pid, rowid) for rowid, src in rows if (pid := profile_from_path(src))]
    cur.executemany("UPDATE usage_calls SET profile_id = ? WHERE rowid = ?", updates)


_UPSERT_PANE_SESSION = (
    "INSERT INTO pane_sessions (pane, vendor, session_id, workspace, first_ts, last_ts)"
    " VALUES (?, ?, ?, ?, ?, ?)"
    " ON CONFLICT(pane, vendor, session_id) DO UPDATE SET"
    " first_ts = min(first_ts, excluded.first_ts), last_ts = max(last_ts, excluded.last_ts),"
    " workspace = CASE WHEN excluded.workspace != '' THEN excluded.workspace ELSE workspace END"
)


_claude_reader: Any = None


def transcript_cwd(usage: TokenUsage) -> str:
    """The cwd the session really ran in.

    Claude's reader fills usage.cwd from the project-dir name, which is lossy
    (every non-alphanumeric character became "-"), so read the transcript's own
    cwd instead; other vendors already report the session's recorded cwd.
    """
    global _claude_reader
    cwd = usage.cwd
    if usage.vendor == "claude":
        if _claude_reader is None:
            from . import cli_runtime
            from .cli_vendors.claude import ClaudeLogReader

            _claude_reader = cli_runtime.wrap(ClaudeLogReader())
        cwd = _claude_reader._session_cwd(Path(usage.file_path)) or ""
    return unicodedata.normalize("NFC", cwd or "")


#: Vendors whose dedup_key is unique across files. Claude's message.id::requestId
#: is, and a resumed session copies earlier calls into its new transcript, so
#: keying it per file would count those calls twice. Every other reader may key
#: on something only unique inside one log (a byte offset, a line number), so
#: its key is scoped to the file the way tokens_store scopes it.
_GLOBAL_KEY_VENDORS = frozenset({"claude"})


def ledger_key(usage: TokenUsage) -> str:
    if usage.vendor in _GLOBAL_KEY_VENDORS:
        return usage.dedup_key
    return f"{usage.file_path}::{usage.dedup_key}"


def _sql(usage: TokenUsage) -> str:
    return _UPSERT_TOTALS if "ledger_session_totals" in usage.raw else _INSERT


def _profile(profile_id: str) -> str:
    # The sink's own "no account" marker is stored as '' like every other
    # unknown field here.
    pid = str(profile_id or "")
    return "" if pid == "unknown" else pid


def _row(usage: TokenUsage, workspace: str, pane: str, profile_id: str = "") -> tuple:
    totals = usage.raw.get("ledger_session_totals")
    if isinstance(totals, dict):
        # A reader whose events are differences of the CLI's running totals
        # (codex) keys them on the totals, so the same session read from two
        # starting points yields different keys. One row per session holding
        # the latest totals stays exact however the log was read.
        ts = parse_event_time(usage.timestamp)
        return (
            usage.vendor,
            f"{usage.file_path}::session_totals",
            usage.session_id or "",
            transcript_cwd(usage),
            workspace or "",
            pane or "",
            str(totals.get("model") or ""),
            int(ts if ts is not None else time.time()),
            int(totals.get("input", 0)),
            int(totals.get("cache_read", 0)),
            int(totals.get("cache_write", 0)),
            0,
            int(totals.get("output", 0)),
            usage.file_path or "",
            _profile(profile_id),
        )
    cache_read = max(0, int(usage.cache_read_tokens))
    cache_write = max(0, int(usage.cache_creation_tokens))
    write_1h = min(cache_write, max(0, int(usage.raw.get("cache_write_1h", 0) or 0)))
    ts = parse_event_time(usage.timestamp)
    return (
        usage.vendor,
        ledger_key(usage),
        usage.session_id or "",
        transcript_cwd(usage),
        workspace or "",
        pane or "",
        usage.model or "",
        int(ts if ts is not None else time.time()),
        max(0, int(usage.input_tokens) - cache_read - cache_write),
        cache_read,
        cache_write - write_1h,
        write_1h,
        max(0, int(usage.output_tokens)),
        usage.file_path or "",
        _profile(profile_id),
    )


class CostLedger:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._keyless_vendors: set[str] = set()
        self.enabled = False
        self.disabled_reason = ""
        try:
            self._db.migrate("cost_ledger", 1, _create_schema_v1)
            self._db.migrate("cost_ledger", 2, _create_schema_v2)
            self._db.migrate("cost_ledger", 3, _create_schema_v3)
            self.enabled = True
        except Exception as err:  # noqa: BLE001 - the backend starts without the ledger
            self.disabled_reason = f"{type(err).__name__}: {err}"
            log.warning("cost ledger disabled: its schema could not be migrated: %s", self.disabled_reason)

    def _accept(self, usage: TokenUsage) -> bool:
        if usage.dedup_key:
            return True
        if usage.vendor not in self._keyless_vendors:
            self._keyless_vendors.add(usage.vendor)
            log.warning("cost ledger: %s events carry no dedup_key; skipped", usage.vendor)
        return False

    def record(
        self, usage: TokenUsage, workspace: str = "", pane: str = "", profile_id: str = ""
    ) -> bool:
        """Insert one call. Never raises: the token sink must not depend on it.
        Returns True when a new row was written. ``profile_id`` is the account
        slot the sink attributed the call to ("unknown" is stored as '')."""
        if not self.enabled:
            return False
        try:
            if not self._accept(usage):
                return False
            row = _row(usage, workspace, pane, profile_id)
            with self._db.transaction() as cur:
                cur.execute(_sql(usage), row)
                written = cur.rowcount == 1
                if pane and usage.session_id:
                    ts = row[7]
                    cur.execute(_UPSERT_PANE_SESSION, (
                        pane, usage.vendor, usage.session_id, workspace or "", ts, ts,
                    ))
                return written
        except Exception as err:  # noqa: BLE001
            log.warning("cost ledger write failed: %s", err)
            return False

    def report(self, by: str, **filters: Any) -> dict[str, Any]:
        """cost_report over this ledger's database. ValueError while the
        ledger is disabled, as for a bad grouping."""
        if not self.enabled:
            raise ValueError(f"cost ledger is disabled: {self.disabled_reason}")
        return cost_report(self._db, by, **filters)

    def record_many(self, events: Iterable[TokenUsage]) -> tuple[int, int]:
        """Batch insert for the backfill. Returns (written, skipped). A call's
        account is read off its log path (profile_from_path), '' otherwise."""
        rows, skipped = [], 0
        for ev in events:
            if self._accept(ev):
                rows.append((_sql(ev), _row(ev, "", "", profile_from_path(ev.file_path))))
            else:
                skipped += 1
        if not rows:
            return 0, skipped
        with self._db.transaction() as cur:
            before = cur.execute("SELECT total_changes()").fetchone()[0]
            for sql, row in rows:
                cur.execute(sql, row)
            written = cur.execute("SELECT total_changes()").fetchone()[0] - before
        return written, skipped + (len(rows) - written)


def load_pricing(path: Path = PRICING_FILE) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def call_cost_usd(row: dict[str, Any], pricing: dict[str, Any]) -> float | None:
    """Dollar cost of one call (or one summed bucket); None for an unpriced model."""
    price = pricing.get("models", {}).get(row.get("model") or "")
    if price is None:
        return None
    per_token = 1_000_000
    return (
        row["input"] * price["input"]
        + row["cache_read"] * price["cache_read"]
        + row["cache_write_5m"] * price["cache_write_5m"]
        + row["cache_write_1h"] * price["cache_write_1h"]
        + row["output"] * price["output"]
    ) / per_token


_TOKEN_FIELDS = ("input", "cache_read", "cache_write_5m", "cache_write_1h", "output")

# A call's pane: its own, else the pane its session ran in (the latest one, when
# a session moved between panes).
_EFFECTIVE_PANE = (
    "CASE WHEN u.pane != '' THEN u.pane ELSE COALESCE((SELECT ps.pane FROM pane_sessions ps"
    " WHERE ps.vendor = u.vendor AND ps.session_id = u.session_id"
    " ORDER BY ps.last_ts DESC LIMIT 1), '') END"
)

_GROUP_KEYS = {
    "cwd": "u.cwd",
    "pane": "epane",
    "day": "date(u.ts + :off, 'unixepoch')",
    "session": "u.session_id",
    "model": "u.model",
    "account": "u.profile_id",
    # model × account: key "<model>::<profile_id>", split again into the
    # bucket's model and account fields.
    "model_account": "u.model || '::' || u.profile_id",
    # day × model: key "<day>::<model>", split into day and model.
    "day_model": "date(u.ts + :off, 'unixepoch') || '::' || u.model",
}

# Groupings whose key joins two dimensions, and the bucket fields it splits into.
_SPLIT_KEYS = {"model_account": ("model", "account"), "day_model": ("day", "model")}

COST_REPORT_GROUPS = tuple(_GROUP_KEYS)


def _blank_bucket(key: str) -> dict[str, Any]:
    return {"key": key, "calls": 0, **{f: 0 for f in _TOKEN_FIELDS}, "usd": 0.0, "unpriced_calls": 0}


def cost_report(
    db: Database,
    by: str,
    *,
    cwd: str = "",
    pane: str = "",
    since: str = "",
    until: str = "",
    utc_offset_min: int = 0,
    pricing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Tokens and dollars from the ledger, grouped by cwd, pane, day, session,
    model, account (profile_id, '' = unknown) or model_account (key
    "<model>::<profile_id>"; each group also carries ``model`` and ``account``)
    or day_model (key "<day>::<model>", with ``day`` and ``model``).

    ``cwd`` keeps calls made in that folder or below it; ``since`` and ``until``
    are inclusive days (YYYY-MM-DD), UTC unless ``utc_offset_min`` shifts
    them (and the day groupings) to a local calendar. A model the pricing table does not know
    adds its calls to ``unpriced_calls`` and nothing to ``usd``. Grouped by pane,
    the answer also reconciles: per pane, the tokens of the calls that name it
    against the tokens of every call of the sessions mapped to it; ``differences``
    lists the panes where the two disagree.
    """
    if by not in _GROUP_KEYS:
        raise ValueError(f"by must be one of {', '.join(COST_REPORT_GROUPS)}")
    pricing = pricing if pricing is not None else load_pricing()
    params: dict[str, Any] = {"off": int(utc_offset_min) * 60}
    where = []
    if cwd:
        root = unicodedata.normalize("NFC", cwd.rstrip("/\\"))
        where.append("(u.cwd = :root OR substr(u.cwd, 1, :rootlen) IN (:root_fwd, :root_back))")
        params.update(root=root, rootlen=len(root) + 1, root_fwd=root + "/", root_back=root + "\\")
    if since:
        where.append("date(u.ts + :off, 'unixepoch') >= :since")
        params["since"] = since
    if until:
        where.append("date(u.ts + :off, 'unixepoch') <= :until")
        params["until"] = until
    inner = (
        f"SELECT u.*, {_EFFECTIVE_PANE} AS epane FROM usage_calls u"
        + (f" WHERE {' AND '.join(where)}" if where else "")
    )
    outer_where = " WHERE epane = :pane" if pane else ""
    if pane:
        params["pane"] = pane
    sums = ", ".join(f"SUM({f})" for f in _TOKEN_FIELDS)
    key = _GROUP_KEYS[by].replace("u.", "")
    sql = (
        f"SELECT {key} AS k, model, COUNT(*), {sums} FROM ({inner}){outer_where}"
        " GROUP BY k, model"
    )
    buckets: dict[str, dict[str, Any]] = {}
    with db.transaction() as cur:
        rows = cur.execute(sql, params).fetchall()
        for k, model, calls, *tokens in rows:
            bucket = buckets.setdefault(k or "", _blank_bucket(k or ""))
            part = dict(zip(_TOKEN_FIELDS, (int(t or 0) for t in tokens)), model=model)
            bucket["calls"] += calls
            for f in _TOKEN_FIELDS:
                bucket[f] += part[f]
            usd = call_cost_usd(part, pricing)
            if usd is None:
                bucket["unpriced_calls"] += calls
            else:
                bucket["usd"] += usd
        differences = _pane_differences(cur) if by == "pane" else None
    groups = sorted(buckets.values(), key=lambda b: b["usd"], reverse=True)
    for bucket in groups:
        bucket["usd"] = round(bucket["usd"], 4)
        if by in _SPLIT_KEYS:
            first, second = _SPLIT_KEYS[by]
            bucket[first], _, bucket[second] = bucket["key"].partition("::")
    answer: dict[str, Any] = {
        "by": by,
        "groups": groups,
        "pricing": {"version": pricing.get("version"), "effective": pricing.get("effective")},
    }
    if differences is not None:
        answer["differences"] = [d for d in differences if not pane or d["pane"] == pane]
    return answer


def _pane_differences(cur: sqlite3.Cursor) -> list[dict[str, Any]]:
    total = " + ".join(_TOKEN_FIELDS)
    tagged = dict(cur.execute(
        f"SELECT pane, SUM({total}) FROM usage_calls WHERE pane != '' GROUP BY pane"
    ).fetchall())
    mapped = dict(cur.execute(
        f"SELECT ps.pane, SUM({total}) FROM pane_sessions ps"
        " JOIN usage_calls u ON u.vendor = ps.vendor AND u.session_id = ps.session_id"
        " GROUP BY ps.pane"
    ).fetchall())
    return [
        {"pane": p, "tagged_tokens": int(tagged.get(p) or 0), "session_tokens": int(mapped.get(p) or 0)}
        for p in sorted(set(tagged) | set(mapped))
        if int(tagged.get(p) or 0) != int(mapped.get(p) or 0)
    ]


def backfill(ledger: CostLedger, readers: Iterable[Any]) -> tuple[int, int]:
    """Read every jsonl session log the readers know about into usage_calls.

    Only reads the logs and only writes usage_calls — tokens_store and its
    checkpoints are not touched. One transaction per file keeps each write
    window short for a running backend sharing the database.
    """
    written = skipped = 0
    for reader in readers:
        for path in reader.session_files():
            if path.suffix != ".jsonl":
                continue
            try:
                parsed = reader.parse_incremental(path, {})
            except Exception as err:  # noqa: BLE001
                log.warning("backfill: parse %s failed: %s", path, err)
                continue
            w, s = ledger.record_many(parsed.events)
            written += w
            skipped += s
    return written, skipped


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "backfill":
        print("usage: python -m agent_team_backend.cost_ledger backfill <navide.db>")
        return 2
    from . import cli_runtime
    from .cli_vendors.claude import ClaudeLogReader
    from .cli_vendors.codex import CodexLogReader

    # Wrapped like the backend's own readers. This is a separate process that
    # applies no setting, so they read with main's Python code.
    ledger = CostLedger(Database(Path(argv[1])))
    readers = [cli_runtime.wrap(ClaudeLogReader()), cli_runtime.wrap(CodexLogReader())]
    written, skipped = backfill(ledger, readers)
    print(f"written={written} skipped={skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
