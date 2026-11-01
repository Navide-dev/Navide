"""Multi-vendor wire protocols.

A protocol is credential/endpoint knowledge shared by SEVERAL vendors, so it
belongs to none of them: opencode and pi both store an Anthropic OAuth grant
in their own auth files and read Claude quota with it. Vendor modules import
protocols; protocols import nothing vendor-specific.
"""

from __future__ import annotations

import time

from ..usage_common import HTTP_TIMEOUT, _epoch_to_iso, _num, _snapshot, _window, parse_retry_after

# ---- Anthropic OAuth usage (opencode, pi; claude itself reads its CLI's
# /usage panel instead — see cli_vendors/claude.py after R12) ---------------

CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_BETA_HEADER = "oauth-2025-04-20"


def claude_token_expired(oauth: dict, now_ms: float | None = None) -> bool:
    expires = _num(oauth.get("expiresAt"))
    if expires is None:
        return False
    now = time.time() * 1000 if now_ms is None else now_ms
    return now >= expires


_CLAUDE_NAMED_WINDOWS = (
    ("five_hour", "session", "Session (5h)"),
    ("seven_day", "weekly", "Weekly (all models)"),
    ("seven_day_opus", "weekly-model", "Weekly (Opus)"),
    ("seven_day_sonnet", "weekly-model", "Weekly (Sonnet)"),
)


def normalize_claude(data: dict) -> tuple[list[dict], str | None]:
    windows: list[dict] = []
    for key, kind, label in _CLAUDE_NAMED_WINDOWS:
        entry = data.get(key)
        if not isinstance(entry, dict):
            continue
        pct = _num(entry.get("utilization"))
        if pct is None:
            continue
        windows.append(_window(kind, label, pct, entry.get("resets_at")))
    # Mirrors CodexBar's ClaudeScopedWeeklyLimitMapper: drop the "all models"
    # aggregate row and de-duplicate by model slug.
    seen_models: set[str] = set()
    for entry in data.get("limits") or []:
        if not isinstance(entry, dict):
            continue
        # is_active is deliberately NOT a filter — enforceable scoped limits
        # report False in practice (CodexBar finding).
        if entry.get("kind") != "weekly_scoped" or entry.get("group") != "weekly":
            continue
        pct = _num(entry.get("percent"))
        scope_model = ((entry.get("scope") or {}).get("model")) or {}
        model = scope_model.get("display_name")
        model_id = scope_model.get("id")
        if pct is None or not model:
            continue
        slug = (model_id or model).strip().lower()
        if slug in ("all models", "all-models") or slug.endswith("-all-models"):
            continue
        if slug in seen_models:
            continue
        seen_models.add(slug)
        # Null-id "promotional" buckets (e.g. Fable) are surfaced as-is like any
        # other per-model window: the quota is real, so never hide or relabel it.
        windows.append(_window("weekly-model", f"{model} only", pct, entry.get("resets_at")))
    plan = None
    return windows, plan


# Codex classifies a rate window by its ``limit_window_seconds`` (mirrors
# CodexBar's CodexRateWindowNormalizer), not by position — the API does not
# guarantee primary=Session / secondary=Weekly ordering.


async def fetch_claude_oauth(oauth: dict | None) -> dict:
    """Claude usage for an Anthropic OAuth credential another CLI stores.

    The claude provider itself no longer comes through here — it reads the
    CLI's own ``/usage`` panel (see :mod:`claude_cli_usage`). What remains are
    opencode and pi, which keep an Anthropic OAuth grant inside their own auth
    files; there is no vendor CLI to delegate to for those, so this call stays.
    It identifies itself as Navide, the same as every other provider fetcher:
    this app previously sent ``claude-code/<version>``, built by running
    ``claude --version``, which claimed to be a client it is not."""
    if oauth is None:
        return _snapshot("claude", "no-credentials")
    if claude_token_expired(oauth):
        return _snapshot("claude", "expired")
    import httpx

    headers = {
        "Authorization": f"Bearer {oauth['accessToken']}",
        "anthropic-beta": CLAUDE_BETA_HEADER,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Navide",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(CLAUDE_USAGE_URL, headers=headers)
    if resp.status_code == 401:
        return _snapshot("claude", "expired")
    if resp.status_code == 429:
        snap = _snapshot("claude", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("claude", "error", error=f"HTTP {resp.status_code}")
    windows, plan = normalize_claude(resp.json())
    return _snapshot("claude", "ok", windows=windows, plan_type=plan)


# ---- ChatGPT wham/usage (codex, pi) ---------------------------------------
# pi stores an openai-codex OAuth grant in its own auth file and reads the
# same ``wham/usage`` endpoint the codex provider uses.

CODEX_DEFAULT_BASE = "https://chatgpt.com/backend-api"


def codex_usage_url(base: str) -> str:
    path = "/wham/usage" if "/backend-api" in base else "/api/codex/usage"
    return base + path


_CODEX_POSITIONAL = (
    ("primary_window", ("session", "Session (5h)")),
    ("secondary_window", ("weekly", "Weekly")),
)


_CODEX_WINDOW_ROLES = {
    300: ("session", "Session (5h)"),
    10080: ("weekly", "Weekly"),
}
# Positional fallback for entries whose window length can't classify them.


def _codex_window_minutes(entry: dict) -> int | None:
    secs = _num(entry.get("limit_window_seconds"))
    return int(secs // 60) if secs is not None else None


def _codex_window_role(entry: dict) -> tuple[str, str] | None:
    minutes = _codex_window_minutes(entry)
    if minutes is None:
        return None
    return _CODEX_WINDOW_ROLES.get(minutes)


def _resolve_codex_roles(rate: dict) -> list[tuple[dict, tuple[str, str]]]:
    """Assign (kind, label) to each present window. Prefer classification by
    window length; fall back to position only when length can't decide or
    would collide, so two windows never share a role."""
    present: list[tuple[int, dict, tuple[str, str]]] = []
    for index, (key, pos_role) in enumerate(_CODEX_POSITIONAL):
        entry = rate.get(key)
        if isinstance(entry, dict):
            present.append((index, entry, pos_role))

    resolved: dict[int, tuple[dict, tuple[str, str]]] = {}
    taken: set[str] = set()
    pending: list[tuple[int, dict, tuple[str, str]]] = []
    for index, entry, pos_role in present:
        role = _codex_window_role(entry)
        if role is not None and role[0] not in taken:
            taken.add(role[0])
            resolved[index] = (entry, role)
        else:
            pending.append((index, entry, pos_role))

    all_roles = [pos_role for _, pos_role in _CODEX_POSITIONAL]
    for index, entry, pos_role in pending:
        if pos_role[0] not in taken:
            role = pos_role
        else:
            remaining = [r for r in all_roles if r[0] not in taken]
            role = remaining[0] if remaining else pos_role
        taken.add(role[0])
        resolved[index] = (entry, role)
    return [resolved[i] for i in sorted(resolved)]


def _codex_windows(rate: dict) -> list[dict]:
    windows: list[dict] = []
    for entry, (kind, label) in _resolve_codex_roles(rate):
        pct = _num(entry.get("used_percent"))
        if pct is None:
            continue
        windows.append(_window(kind, label, pct,
                               _epoch_to_iso(entry.get("reset_at")),
                               window_minutes=_codex_window_minutes(entry)))
    return windows


def codex_absent_windows(rate: dict) -> list[str]:
    """``["session"]`` when the answer holds one window and it is the weekly
    one by its own length, else ``[]``. A window whose length or figure cannot
    be read proves nothing about the other one."""
    entries = [rate.get(key) for key, _ in _CODEX_POSITIONAL]
    present = [entry for entry in entries if entry is not None]
    if len(present) != 1 or not isinstance(present[0], dict):
        return []
    entry = present[0]
    role = _CODEX_WINDOW_ROLES.get(_codex_window_minutes(entry))
    if role is None or role[0] != "weekly" or _num(entry.get("used_percent")) is None:
        return []
    return ["session"]


def _codex_credits(data: dict) -> dict | None:
    credits = data.get("credits")
    if not isinstance(credits, dict):
        return None
    balance = credits.get("balance")
    parsed = _num(balance)
    return {
        "hasCredits": bool(credits.get("has_credits")),
        "unlimited": bool(credits.get("unlimited")),
        "balance": parsed if parsed is not None else balance,
    }


def _codex_extra_windows(data: dict) -> list[dict]:
    extra: list[dict] = []
    for item in data.get("additional_rate_limits") or []:
        if not isinstance(item, dict):
            continue
        rate = item.get("rate_limit")
        if not isinstance(rate, dict):
            continue
        windows = _codex_windows(rate)
        if windows:
            extra.append({"name": item.get("limit_name"), "windows": windows})
    return extra


def normalize_codex(data: dict) -> tuple[list[dict], str | None]:
    windows = _codex_windows(data.get("rate_limit") or {})
    plan = data.get("plan_type") if isinstance(data.get("plan_type"), str) else None
    return windows, plan
