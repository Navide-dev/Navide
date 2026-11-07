"""Read-only daily quota curves from the quota ledger's samples.

For each (agent, account slot, window kind) the highest ``used_percent`` seen
on each local day of a range, plus the latest reading. Source: the
``quota_samples`` table quota_ledger already writes on every poll (every
vendor, every account, de-duplicated readings). Nothing here writes, and
nothing imports usage_service or quota_failover: this only reads what they
already recorded.

A sample is written only when the reading changes, so a day without a sample
still had the previous reading — unless that reading's window reset before
the day began. Each day's peak is therefore the max of that day's samples and
the reading carried in from before it.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from .db import Database

MAX_DAYS = 90


def _day_starts(days: int, utc_offset_min: int, now: float) -> list[tuple[str, float]]:
    tz = timezone(timedelta(minutes=utc_offset_min))
    today = datetime.fromtimestamp(now, tz).replace(hour=0, minute=0, second=0, microsecond=0)
    out = []
    for back in range(days - 1, -1, -1):
        start = today - timedelta(days=back)
        out.append((start.date().isoformat(), start.timestamp()))
    return out


def daily_peaks(
    db: Database, days: int = 7, utc_offset_min: int = 0, now: float | None = None
) -> dict[str, Any]:
    """{ok, days: [YYYY-MM-DD…], accounts: [{agent_key, profile_id, windows:
    [{window_kind, latest: {used_percent, resets_at, fetched_at}, peaks:
    [percent | None per day]}]}]}. ``days`` counts back from today (local to
    ``utc_offset_min``); a day before the first reading is None."""
    days = max(1, min(MAX_DAYS, int(days)))
    utc_offset_min = max(-14 * 60, min(14 * 60, int(utc_offset_min)))
    wall = time.time() if now is None else now
    starts = _day_starts(days, utc_offset_min, wall)
    range_start = starts[0][1]
    with db.transaction() as cur:
        # The last reading before the range (it carries into the first day)
        # and every reading inside it.
        rows = cur.execute(
            "SELECT agent, profile_id, window_kind, used_percent, resets_at, fetched_at"
            " FROM quota_samples s WHERE fetched_at >= ? OR fetched_at = ("
            "  SELECT MAX(fetched_at) FROM quota_samples p WHERE p.agent = s.agent"
            "  AND p.profile_id = s.profile_id AND p.window_kind = s.window_kind"
            "  AND p.fetched_at < ?)"
            " ORDER BY agent, profile_id, window_kind, fetched_at",
            (range_start, range_start),
        ).fetchall()
    series: dict[tuple[str, str, str], list[tuple[float, float, float]]] = {}
    for agent, profile, kind, pct, resets, fetched in rows:
        series.setdefault((agent, profile, kind), []).append((float(fetched), float(pct), float(resets)))

    bounds = [s for _d, s in starts] + [starts[-1][1] + 86400]
    accounts: dict[tuple[str, str], dict[str, Any]] = {}
    for (agent, profile, kind), samples in series.items():
        peaks: list[float | None] = []
        carried: tuple[float, float, float] | None = None
        i = 0
        for d in range(days):
            lo, hi = bounds[d], bounds[d + 1]
            while i < len(samples) and samples[i][0] < lo:
                carried = samples[i]
                i += 1
            peak = carried[1] if carried is not None and carried[2] > lo else None
            if carried is not None and peak is None:
                peak = 0.0  # the carried reading's window reset before this day
            while i < len(samples) and samples[i][0] < hi:
                peak = samples[i][1] if peak is None else max(peak, samples[i][1])
                carried = samples[i]
                i += 1
            peaks.append(None if peak is None else round(peak, 1))
        fetched, pct, resets = samples[-1]
        account = accounts.setdefault(
            (agent, profile), {"agent_key": agent, "profile_id": profile, "windows": []}
        )
        account["windows"].append({
            "window_kind": kind,
            "latest": {"used_percent": pct, "resets_at": resets, "fetched_at": fetched},
            "peaks": peaks,
        })
    return {
        "ok": True,
        "days": [d for d, _s in starts],
        "accounts": [accounts[k] for k in sorted(accounts)],
    }
