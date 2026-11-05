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
"""

from __future__ import annotations

import json
import logging
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
    " cache_write_1h, output, source_file)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
            from .cli_vendors.claude import ClaudeLogReader

            _claude_reader = ClaudeLogReader()
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


def _row(usage: TokenUsage, workspace: str, pane: str) -> tuple:
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
    )


class CostLedger:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._db.migrate("cost_ledger", 1, _create_schema_v1)
        self._keyless_vendors: set[str] = set()

    def _accept(self, usage: TokenUsage) -> bool:
        if usage.dedup_key:
            return True
        if usage.vendor not in self._keyless_vendors:
            self._keyless_vendors.add(usage.vendor)
            log.warning("cost ledger: %s events carry no dedup_key; skipped", usage.vendor)
        return False

    def record(self, usage: TokenUsage, workspace: str = "", pane: str = "") -> bool:
        """Insert one call. Never raises: the token sink must not depend on it.
        Returns True when a new row was written."""
        try:
            if not self._accept(usage):
                return False
            with self._db.transaction() as cur:
                cur.execute(_INSERT, _row(usage, workspace, pane))
                return cur.rowcount == 1
        except Exception as err:  # noqa: BLE001
            log.warning("cost ledger write failed: %s", err)
            return False

    def record_many(self, events: Iterable[TokenUsage]) -> tuple[int, int]:
        """Batch insert for the backfill. Returns (written, skipped)."""
        rows, skipped = [], 0
        for ev in events:
            if self._accept(ev):
                rows.append(_row(ev, "", ""))
            else:
                skipped += 1
        if not rows:
            return 0, skipped
        with self._db.transaction() as cur:
            before = cur.execute("SELECT total_changes()").fetchone()[0]
            cur.executemany(_INSERT, rows)
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
    from .cli_vendors.claude import ClaudeLogReader
    from .cli_vendors.codex import CodexLogReader

    ledger = CostLedger(Database(Path(argv[1])))
    written, skipped = backfill(ledger, [ClaudeLogReader(), CodexLogReader()])
    print(f"written={written} skipped={skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
