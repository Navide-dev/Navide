"""A pane that is not online: what its chat is told, in the Navide language, and the limits
on waking it back onto its own conversation from the chat (``/wake`` or the wake button)."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable

COOLDOWN_S = 300.0  # between two wakes of one binding
DAILY_MAX = 10  # wakes of one binding per local day
STASH_MAX = 20  # messages kept for the wake to deliver, per binding
STASH_TTL_S = 1800.0  # a kept message older than this is not delivered by a later wake
PREVIEW_CHARS = 40  # of a message the chat is told was not sent

STRINGS: dict[str, dict[str, str]] = {
    "zh-TW": {
        "offline": "⚠️ pane 目前不在線上：它所在的 Navide 視窗沒有開著，或 pane 已關閉",
        "offline_wake": "⚠️ pane 目前不在線上。喚醒會接回原本的對話，這則訊息會在喚醒後或 pane 回到線上時自動送進去（最多暫存 {max} 則、{minutes} 分鐘內有效；Navide 重啟會清掉，沒送出的會再告訴你）",
        "not_sent_overflow": "⚠️ 暫存已滿 {max} 則，最舊的 {count} 則沒有送進去：{items}。請重送",
        "not_sent_expired": "⚠️ 這 {count} 則暫存超過 {minutes} 分鐘已失效，沒有送進去：{items}。請重送",
        "not_sent_restart": "⚠️ Navide 重啟了，暫存的這 {count} 則沒有送進去：{items}。請重送",
        "not_sent_queue_full": "⚠️ pane 的排隊已滿，暫存的這 {count} 則沒有送進去：{items}。請稍後重送",
        "open_elsewhere": "⚠️ 這段對話已經在另一個 pane 開著，沒有喚醒；請在電腦上那個 pane 繼續",
        "offline_wake_nothing_kept": "⚠️ pane 目前不在線上，沒有可以中斷的工作。喚醒會接回原本的對話",
        "no_window": "⚠️ pane 目前不在線上，而且電腦上沒有開著任何 Navide 視窗，無法喚醒。請先在電腦上打開 Navide",
        "waking": "⏳ 喚醒中…",
        "woke": "✅ 已喚醒，接回原本的對話",
        "woke_sent": "✅ 已喚醒，接回原本的對話；暫存的 {count} 則訊息已送進去",
        "already_online": "pane 已在線上，不需要喚醒",
        "busy": "⚠️ 另一個 pane 正在喚醒，請稍後再試",
        "cooldown": "⚠️ 剛喚醒過，請 {wait} 秒後再試",
        "daily": "⚠️ 這個聊天室今天已喚醒 {max} 次，已達上限，明天再試",
        "quota": "⚠️ {agent} 額度已用完，喚醒了也無法回應，所以沒有喚醒",
        "unresumable": "⚠️ 原本的對話接不回來（{reason}），沒有喚醒；Navide 不會改開新的對話",
        "failed": "⚠️ 喚醒失敗（{reason}），pane 仍不在線上",
        "reason_missing": "找不到這段對話的紀錄",
        "reason_no_resume": "這個 CLI 不支援接回對話",
        "reason_unavailable": "對話紀錄已不在電腦上",
        "reason_fresh": "Navide 的接續設定是重新開始，不接回舊對話",
        "reason_window": "Navide 視窗沒有回應",
        "reason_mismatch": "接回的不是原本那段對話",
        "reason_not_restored": "Navide 視窗沒有把這個 pane 帶回來",
        "reason_refused": "Navide 視窗拒絕重新開啟這個 pane",
        "reason_ask": "Navide 的接續設定為每次詢問，請到電腦上開啟",
    },
    "en-US": {
        "offline": "⚠️ The pane is not online: the Navide window it belongs to is not open, or the pane was closed",
        "offline_wake": "⚠️ The pane is not online. Waking it resumes its own conversation; this message is sent in once it is awake or back online (up to {max} messages are kept, for {minutes} minutes; a Navide restart clears them, and you are told which were not sent)",
        "not_sent_overflow": "⚠️ The keep list is full ({max}); the oldest {count} message(s) were not sent: {items}. Please resend",
        "not_sent_expired": "⚠️ These {count} kept message(s) are older than {minutes} minutes and were not sent: {items}. Please resend",
        "not_sent_restart": "⚠️ Navide restarted; these {count} kept message(s) were not sent: {items}. Please resend",
        "not_sent_queue_full": "⚠️ The pane's queue is full; these {count} kept message(s) were not sent: {items}. Please resend later",
        "open_elsewhere": "⚠️ This conversation is already open in another pane, so nothing was woken; continue in that pane on the computer",
        "offline_wake_nothing_kept": "⚠️ The pane is not online, so there is nothing to interrupt. Waking it resumes its own conversation",
        "no_window": "⚠️ The pane is not online and no Navide window is open on the computer, so it cannot be woken. Open Navide on the computer first",
        "waking": "⏳ Waking…",
        "woke": "✅ Awake, back on its own conversation",
        "woke_sent": "✅ Awake, back on its own conversation; the {count} kept message(s) were sent in",
        "already_online": "The pane is already online; there is nothing to wake",
        "busy": "⚠️ Another pane is being woken; try again shortly",
        "cooldown": "⚠️ Woken a moment ago; try again in {wait} s",
        "daily": "⚠️ This chat has woken its pane {max} times today, the daily limit; try again tomorrow",
        "quota": "⚠️ {agent} is out of quota and could not answer, so the pane was not woken",
        "unresumable": "⚠️ Its own conversation cannot be resumed ({reason}), so the pane was not woken; Navide never starts a new conversation instead",
        "failed": "⚠️ Waking failed ({reason}); the pane is still not online",
        "reason_missing": "no record of the conversation was found",
        "reason_no_resume": "this CLI cannot resume a conversation",
        "reason_unavailable": "the conversation is no longer on the computer",
        "reason_fresh": "Navide is set to start fresh instead of resuming",
        "reason_window": "the Navide window did not answer",
        "reason_mismatch": "the pane came back on a different conversation",
        "reason_not_restored": "the Navide window did not bring this pane back",
        "reason_refused": "the Navide window refused to reopen this pane",
        "reason_ask": "Navide is set to ask every time; open it on the computer",
    },
    "ja-JP": {
        "offline": "⚠️ pane は現在オフラインです：所属する Navide ウィンドウが開いていないか、pane が閉じられています",
        "offline_wake": "⚠️ pane は現在オフラインです。起動すると元の会話に戻り、このメッセージは起動後またはオンライン復帰時に自動で送られます（保留は最大 {max} 件、{minutes} 分間有効。Navide を再起動すると消え、送れなかったものはお知らせします）",
        "not_sent_overflow": "⚠️ 保留が上限の {max} 件に達したため、古い {count} 件は送られませんでした：{items}。もう一度送ってください",
        "not_sent_expired": "⚠️ 保留していた {count} 件は {minutes} 分を過ぎたため送られませんでした：{items}。もう一度送ってください",
        "not_sent_restart": "⚠️ Navide が再起動したため、保留していた {count} 件は送られませんでした：{items}。もう一度送ってください",
        "not_sent_queue_full": "⚠️ pane の待ち行列がいっぱいのため、保留していた {count} 件は送られませんでした：{items}。しばらくしてからもう一度送ってください",
        "open_elsewhere": "⚠️ この会話はすでに別の pane で開いているため、起動しませんでした。パソコンでその pane から続けてください",
        "offline_wake_nothing_kept": "⚠️ pane は現在オフラインのため、中断するものはありません。起動すると元の会話に戻ります",
        "no_window": "⚠️ pane はオフラインで、パソコンで Navide のウィンドウが一つも開いていないため起動できません。先にパソコンで Navide を開いてください",
        "waking": "⏳ 起動中…",
        "woke": "✅ 起動しました。元の会話に戻っています",
        "woke_sent": "✅ 起動しました。元の会話に戻り、保留していた {count} 件のメッセージを送りました",
        "already_online": "pane はすでにオンラインです。起動は不要です",
        "busy": "⚠️ 別の pane を起動中です。しばらくしてからもう一度お試しください",
        "cooldown": "⚠️ 起動したばかりです。{wait} 秒後にもう一度お試しください",
        "daily": "⚠️ このチャットは今日すでに {max} 回起動しており、上限に達しました。明日もう一度お試しください",
        "quota": "⚠️ {agent} の利用枠を使い切っているため応答できず、起動しませんでした",
        "unresumable": "⚠️ 元の会話に戻れないため（{reason}）、起動しませんでした。Navide が代わりに新しい会話を始めることはありません",
        "failed": "⚠️ 起動に失敗しました（{reason}）。pane はまだオフラインです",
        "reason_missing": "この会話の記録が見つかりません",
        "reason_no_resume": "この CLI は会話の再開に対応していません",
        "reason_unavailable": "会話の記録がもうパソコンにありません",
        "reason_fresh": "Navide の設定が再開せずに新しく始める設定になっています",
        "reason_window": "Navide のウィンドウが応答しませんでした",
        "reason_mismatch": "別の会話で戻ってきました",
        "reason_not_restored": "Navide のウィンドウがこの pane を戻しませんでした",
        "reason_refused": "Navide のウィンドウがこの pane の再オープンを拒否しました",
        "reason_ask": "Navide の設定が毎回確認になっています。パソコンで開いてください",
    },
}
DEFAULT_LANGUAGE = "zh-TW"

# Why a resume cannot happen (wake seam codes) -> the reason shown; anything else is a failure.
UNRESUMABLE_REASONS = {
    "no-record": "reason_missing",
    "workspace-required": "reason_missing",
    "unknown-session-id": "reason_unavailable",
    "malformed-session-id": "reason_missing",
    "session-unavailable": "reason_unavailable",
    "resume-unavailable": "reason_unavailable",
    "no-session-support": "reason_no_resume",
    "fresh-refused": "reason_fresh",
    "session-mismatch": "reason_mismatch",
    "ask-refused": "reason_ask",
}
# A wake that failed for another known reason -> the reason shown.
FAILURE_REASONS = {"pane-not-restored": "reason_not_restored", "window-refused": "reason_refused",
                   "window-timeout": "reason_window"}


def text(lang: str, key: str, **kw: Any) -> str:
    return STRINGS.get(lang, STRINGS[DEFAULT_LANGUAGE])[key].format(**kw)


def outcome_text(lang: str, result: dict[str, Any]) -> str:
    """The chat's answer to a wake that did not bring the pane back."""
    code = str(result.get("code") or "")
    if code == "no-window":
        return text(lang, "no_window")
    if code == "session-open-elsewhere":
        return text(lang, "open_elsewhere")
    if code == "quota":
        return text(lang, "quota", agent=str(result.get("agent") or "CLI"))
    if code in UNRESUMABLE_REASONS:
        return text(lang, "unresumable", reason=text(lang, UNRESUMABLE_REASONS[code]))
    reason = text(lang, FAILURE_REASONS.get(code, "reason_window"))
    return text(lang, "failed", reason=reason)


def preview(body: str) -> str:
    """A short single-line quote of a message, for telling the chat it was not sent."""
    line = " ".join((body or "").split())
    return line if len(line) <= PREVIEW_CHARS else line[:PREVIEW_CHARS - 1] + "…"


def quoted(previews: list[str]) -> str:
    return "、".join(f"「{p}」" for p in previews)


@dataclass
class WakeLimits:
    """One wake at a time; per binding (its chat location) a cooldown and a daily cap.

    Only a wake that got as far as opening something counts: one refused up front (no
    window, out of quota, a conversation that cannot be resumed) leaves the limits alone."""

    clock: Callable[[], float] = time.monotonic
    today: Callable[[], str] = lambda: time.strftime("%Y-%m-%d")
    waking: str = ""  # the location being woken now
    _last: dict[str, float] = field(default_factory=dict)
    _count: dict[str, tuple[str, int]] = field(default_factory=dict)  # location -> (day, wakes)

    def refusal(self, key: str, lang: str) -> str:
        """Why ``key`` may not wake now, or ""."""
        if self.waking:
            return text(lang, "busy")
        day, count = self._count.get(key, ("", 0))
        if day == self.today() and count >= DAILY_MAX:
            return text(lang, "daily", max=DAILY_MAX)
        last = self._last.get(key)
        if last is not None and self.clock() - last < COOLDOWN_S:
            return text(lang, "cooldown", wait=int(COOLDOWN_S - (self.clock() - last)) + 1)
        return ""

    def begin(self, key: str) -> None:
        self.waking = key

    def end(self, key: str, *, counted: bool) -> None:
        self.waking = ""
        if not counted:
            return
        self._last[key] = self.clock()
        day, count = self._count.get(key, ("", 0))
        today = self.today()
        self._count[key] = (today, count + 1 if day == today else 1)
