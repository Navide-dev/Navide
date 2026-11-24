"""/status's per-pane cards: vendor, model, account (name and a masked email), quota,
running or not, last action, the prompt a stuck pane shows. Many panes fold the idle
ones; the section keeps inside its character budget; no secret, whole email or home
folder reaches the chat."""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from agent_team_backend.channels import redact, status_card
from agent_team_backend.channels.mirror import status_word

from .test_manager import Env, env  # noqa: F401 — fixture shared with the manager suite

NOW = datetime(2026, 11, 25, 9, 0, tzinfo=timezone.utc)


def _row(pid: str, name: str, status: str = "idle") -> dict[str, Any]:
    return {"pane_id": pid, "name": name, "display_status": status}


def _render(rows: list[tuple[dict[str, Any], dict[str, Any]]], **kw: Any) -> str:
    return status_card.render("zh-TW", rows, status_word, now=NOW, **kw)


def test_a_card_shows_every_fact() -> None:
    reset = NOW.replace(hour=13, minute=30).isoformat()
    info = {
        "agent": "claude", "agent_label": "Claude Code", "model": "claude-opus-5-5", "effort": "high",
        "status": "running",
        "account": {"name": "工作帳號", "email": "worker" + "@example.com"},
        "quota": {"window": "5 小時", "used_percent": 42.4, "resets_at": reset, "stale": False},
        "last": {"type": "turn_complete", "text": "Build finished: 3 warnings", "age_seconds": 30},
    }
    text = _render([(_row("p1", "main", "running"), info)])
    assert "🔄 執行中 main · Claude Code · claude-opus-5-5 (high)" in text
    assert "👤 工作帳號 · w***@example.com" in text
    assert "worker@" not in text
    assert "📊 已用 42%（5 小時）" in text and "重置" in text
    assert "📝 最後動作：完成 · Build finished: 3 warnings" in text


def test_a_stuck_pane_shows_its_prompt_without_secrets_or_home() -> None:
    secret = "sk-" + secrets.token_hex(12)
    redact.add_secret(secret)
    prompt = f"Allow edit to {Path.home()}/proj/app.ts with {secret}?\n1. Yes\n2. No"
    info = {"agent": "codex", "status": "awaiting", "prompt": prompt}
    text = _render([(_row("p1", "tester", "awaiting"), info)])
    assert "⚠️ 等確認 tester · codex" in text
    assert "❓ 卡在提示：Allow edit to ~/proj/app.ts" in text
    assert secret not in text and str(Path.home()) not in text
    assert "\n1." not in text  # one line


def test_the_default_account_and_a_running_turn() -> None:
    info = {"agent": "claude", "account": {"name": ""}, "last": {"type": "agent_active", "age_seconds": 125}}
    text = _render([(_row("p1", "main"), info)])
    assert "👤 預設帳號" in text
    assert "📝 最後動作：執行中（2 分鐘前開始）" in text


def test_many_panes_fold_the_idle_ones() -> None:
    info = {"agent": "claude"}
    rows = [(_row("p0", "main"), info)]
    rows += [(_row(f"p{i}", f"idle{i}"), info) for i in range(1, 8)]
    rows += [(_row("pr", "runner", "running"), info), (_row("pa", "asker", "awaiting"), info)]
    text = _render(rows)
    assert "main" in text and "runner" in text and "asker" in text
    assert "💤 其餘 7 個閒置分格：idle1、idle2" in text
    assert "閒置 idle1" not in text  # no full card


def test_panes_without_facts_add_no_section() -> None:
    assert _render([(_row("p1", "main"), {}), (_row("p2", "docs"), {})]) == ""


def test_the_section_keeps_inside_its_budget() -> None:
    long_last = {"type": "turn_complete", "text": "x" * 500, "age_seconds": 1}
    rows = [(_row(f"p{i}", f"run{i}", "running"), {"last": long_last}) for i in range(40)]
    text = _render(rows)
    assert len(text) <= status_card.CARDS_MAX_CHARS + 80
    assert "沒列出" in text


def test_headline_window_is_the_one_closest_to_its_limit() -> None:
    snap = {"stale": True, "windows": [
        {"kind": "session", "label": "5h", "usedPercent": 20.0, "resetsAt": "2026-11-25T12:00:00Z"},
        {"kind": "weekly", "label": "7d", "usedPercent": 81.0, "resetsAt": "2026-11-28T00:00:00Z"},
    ]}
    assert status_card.headline_window(snap) == {
        "window": "7d", "used_percent": 81.0, "resets_at": "2026-11-28T00:00:00Z", "stale": True}
    assert status_card.headline_window({"windows": []}) is None
    assert status_card.headline_window(None) is None


async def test_status_reply_carries_the_cards(env: Env) -> None:  # noqa: F811
    async def card(pane_id: str) -> dict[str, Any]:
        return {"agent": "claude", "agent_label": "Claude Code", "model": "claude-opus-5-5",
                "account": {"name": "工作帳號", "email": "worker" + "@example.com"}}

    env.m._seams.pane_card = card
    await env.inbound("/status")
    status = next(t for t in reversed(env.tg.texts()) if t.startswith("📋"))
    assert "— 分格明細 —" in status
    assert "Claude Code · claude-opus-5-5" in status
    assert "w***@example.com" in status


async def test_a_failing_card_still_answers_status(env: Env) -> None:  # noqa: F811
    async def card(pane_id: str) -> dict[str, Any]:
        raise RuntimeError("window gone")

    env.m._seams.pane_card = card
    await env.inbound("/status")
    assert any(t.startswith("📋") for t in env.tg.texts())
