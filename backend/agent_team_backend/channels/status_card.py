"""The per-pane cards /status adds under the pane tree: vendor, model, quota, account,
running or not, last action, and the prompt a pane is stuck on.

Pure formatting. A card's facts come from ``Seams.pane_card`` (one window probe plus
cached reads, never a quota fetch). With many panes only the running, stuck and failing
ones (and the bound pane itself) get a full card; the idle rest fold into one line, and
the whole section stays inside ``CARDS_MAX_CHARS`` so the reply fits one Telegram
message next to the tree. Every free text (a prompt, a last turn) is redacted, has the
user's home folder shortened to ``~``, and is cut to one line.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .. import prompt_skills
from . import redact

FULL_CARDS_MAX = 5  # more panes than this: idle ones fold into one line
CARDS_MAX_CHARS = 2400  # the tree, details and cards together stay under Telegram's 4096
PROMPT_CHARS = 120
LAST_CHARS = 80
FOLDED_NAMES_MAX = 8
_ACTIVE = ("running", "starting", "awaiting", "error")

STRINGS: dict[str, dict[str, str]] = {
    "zh-TW": {
        "heading": "— 分格明細 —",
        "account": "👤 {account}",
        "quota_used": "📊 已用 {pct}%（{window}）",
        "quota_reset": " · {when} 重置",
        "quota_stale": "（舊資料）",
        "last_done": "📝 最後動作：完成 · {text}",
        "last_active": "📝 最後動作：執行中（{age}前開始）",
        "last_done_bare": "📝 最後動作：完成（{age}前）",
        "prompt": "❓ 卡在提示：{text}",
        "folded": "💤 其餘 {count} 個閒置分格：{names}",
        "cut": "…還有 {count} 個分格沒列出，傳 /status 到各自的聊天室查看",
        "default_account": "預設帳號",
        "age_s": "{n} 秒", "age_m": "{n} 分鐘", "age_h": "{n} 小時",
    },
    "en-US": {
        "heading": "— Panes —",
        "account": "👤 {account}",
        "quota_used": "📊 {pct}% used ({window})",
        "quota_reset": " · resets {when}",
        "quota_stale": " (stale)",
        "last_done": "📝 Last action: done · {text}",
        "last_active": "📝 Last action: running (started {age} ago)",
        "last_done_bare": "📝 Last action: done ({age} ago)",
        "prompt": "❓ Stuck on a prompt: {text}",
        "folded": "💤 {count} more idle pane(s): {names}",
        "cut": "…{count} more pane(s) not listed; send /status in their own chats",
        "default_account": "Default account",
        "age_s": "{n}s", "age_m": "{n} min", "age_h": "{n} h",
    },
    "ja-JP": {
        "heading": "— pane の詳細 —",
        "account": "👤 {account}",
        "quota_used": "📊 {pct}% 使用（{window}）",
        "quota_reset": " · {when} にリセット",
        "quota_stale": "（古いデータ）",
        "last_done": "📝 最後の動作：完了 · {text}",
        "last_active": "📝 最後の動作：実行中（{age}前に開始）",
        "last_done_bare": "📝 最後の動作：完了（{age}前）",
        "prompt": "❓ プロンプトで停止中：{text}",
        "folded": "💤 ほかに待機中の pane {count} 個：{names}",
        "cut": "…ほかに {count} 個の pane は省略しました。各チャットで /status を送ってください",
        "default_account": "既定のアカウント",
        "age_s": "{n} 秒", "age_m": "{n} 分", "age_h": "{n} 時間",
    },
    "zh-CN": {
        "heading": "— pane 明细 —",
        "account": "👤 {account}",
        "quota_used": "📊 已用 {pct}%（{window}）",
        "quota_reset": " · {when} 重置",
        "quota_stale": "（旧数据）",
        "last_done": "📝 最后动作：完成 · {text}",
        "last_active": "📝 最后动作：运行中（{age}前开始）",
        "last_done_bare": "📝 最后动作：完成（{age}前）",
        "prompt": "❓ 卡在提示：{text}",
        "folded": "💤 其余 {count} 个空闲 pane：{names}",
        "cut": "…还有 {count} 个 pane 没列出，请在各自的聊天室发送 /status 查看",
        "default_account": "默认账号",
        "age_s": "{n} 秒", "age_m": "{n} 分钟", "age_h": "{n} 小时",
    },
    "ko-KR": {
        "heading": "— pane 상세 —",
        "account": "👤 {account}",
        "quota_used": "📊 {pct}% 사용（{window}）",
        "quota_reset": " · {when} 초기화",
        "quota_stale": " (오래된 데이터)",
        "last_done": "📝 마지막 동작: 완료 · {text}",
        "last_active": "📝 마지막 동작: 실행 중 ({age} 전 시작)",
        "last_done_bare": "📝 마지막 동작: 완료 ({age} 전)",
        "prompt": "❓ 프롬프트에서 멈춤: {text}",
        "folded": "💤 그 밖의 유휴 pane {count}개: {names}",
        "cut": "…pane {count}개는 표시하지 않았습니다. 각 채팅에서 /status를 보내세요",
        "default_account": "기본 계정",
        "age_s": "{n}초", "age_m": "{n}분", "age_h": "{n}시간",
    },
    "es-ES": {
        "heading": "— Panes —",
        "account": "👤 {account}",
        "quota_used": "📊 {pct}% usado ({window})",
        "quota_reset": " · se restablece {when}",
        "quota_stale": " (datos antiguos)",
        "last_done": "📝 Última acción: terminado · {text}",
        "last_active": "📝 Última acción: en ejecución (empezó hace {age})",
        "last_done_bare": "📝 Última acción: terminado (hace {age})",
        "prompt": "❓ Detenido en un aviso: {text}",
        "folded": "💤 {count} pane(s) inactivos más: {names}",
        "cut": "…{count} pane(s) más sin mostrar; envía /status en sus propios chats",
        "default_account": "Cuenta predeterminada",
        "age_s": "{n} s", "age_m": "{n} min", "age_h": "{n} h",
    },
    "fr-FR": {
        "heading": "— Panes —",
        "account": "👤 {account}",
        "quota_used": "📊 {pct} % utilisé ({window})",
        "quota_reset": " · réinitialisé à {when}",
        "quota_stale": " (données anciennes)",
        "last_done": "📝 Dernière action : terminé · {text}",
        "last_active": "📝 Dernière action : en cours (commencé il y a {age})",
        "last_done_bare": "📝 Dernière action : terminé (il y a {age})",
        "prompt": "❓ Bloqué sur une invite : {text}",
        "folded": "💤 {count} autre(s) pane(s) inactif(s) : {names}",
        "cut": "…{count} pane(s) non listé(s) ; envoyez /status dans leurs propres discussions",
        "default_account": "Compte par défaut",
        "age_s": "{n} s", "age_m": "{n} min", "age_h": "{n} h",
    },
    "de-DE": {
        "heading": "— Panes —",
        "account": "👤 {account}",
        "quota_used": "📊 {pct} % verbraucht ({window})",
        "quota_reset": " · Zurücksetzung {when}",
        "quota_stale": " (veraltete Daten)",
        "last_done": "📝 Letzte Aktion: fertig · {text}",
        "last_active": "📝 Letzte Aktion: läuft (seit {age})",
        "last_done_bare": "📝 Letzte Aktion: fertig (vor {age})",
        "prompt": "❓ Wartet auf eine Abfrage: {text}",
        "folded": "💤 {count} weitere(r) inaktive(r) Pane(s): {names}",
        "cut": "…{count} weitere(r) Pane(s) nicht aufgeführt; sende /status in deren eigenen Chats",
        "default_account": "Standardkonto",
        "age_s": "{n} s", "age_m": "{n} Min.", "age_h": "{n} Std.",
    },
    "pt-BR": {
        "heading": "— Panes —",
        "account": "👤 {account}",
        "quota_used": "📊 {pct}% usado ({window})",
        "quota_reset": " · reinicia {when}",
        "quota_stale": " (dados antigos)",
        "last_done": "📝 Última ação: concluído · {text}",
        "last_active": "📝 Última ação: em execução (começou há {age})",
        "last_done_bare": "📝 Última ação: concluído (há {age})",
        "prompt": "❓ Parado em um prompt: {text}",
        "folded": "💤 Mais {count} pane(s) ocioso(s): {names}",
        "cut": "…mais {count} pane(s) não listado(s); envie /status nos próprios chats deles",
        "default_account": "Conta padrão",
        "age_s": "{n} s", "age_m": "{n} min", "age_h": "{n} h",
    },
    "ru-RU": {
        "heading": "— Панели —",
        "account": "👤 {account}",
        "quota_used": "📊 Использовано {pct}% ({window})",
        "quota_reset": " · сброс {when}",
        "quota_stale": " (устаревшие данные)",
        "last_done": "📝 Последнее действие: готово · {text}",
        "last_active": "📝 Последнее действие: выполняется (начато {age} назад)",
        "last_done_bare": "📝 Последнее действие: готово ({age} назад)",
        "prompt": "❓ Ждёт ответа на запрос: {text}",
        "folded": "💤 Ещё простаивающих pane: {count}: {names}",
        "cut": "…ещё {count} pane не показано; отправьте /status в их собственных чатах",
        "default_account": "Аккаунт по умолчанию",
        "age_s": "{n} с", "age_m": "{n} мин", "age_h": "{n} ч",
    },
    "vi-VN": {
        "heading": "— Chi tiết pane —",
        "account": "👤 {account}",
        "quota_used": "📊 Đã dùng {pct}% ({window})",
        "quota_reset": " · đặt lại lúc {when}",
        "quota_stale": " (dữ liệu cũ)",
        "last_done": "📝 Hành động cuối: xong · {text}",
        "last_active": "📝 Hành động cuối: đang chạy (bắt đầu {age} trước)",
        "last_done_bare": "📝 Hành động cuối: xong ({age} trước)",
        "prompt": "❓ Đang dừng ở lời nhắc: {text}",
        "folded": "💤 Còn {count} pane đang rảnh: {names}",
        "cut": "…còn {count} pane chưa liệt kê; gửi /status trong cuộc trò chuyện của chúng",
        "default_account": "Tài khoản mặc định",
        "age_s": "{n} giây", "age_m": "{n} phút", "age_h": "{n} giờ",
    },
}


def text(lang: str, key: str, **kw: Any) -> str:
    table = STRINGS.get(lang) or STRINGS[prompt_skills.DEFAULT_LANGUAGE]
    template = table.get(key) or STRINGS[prompt_skills.DEFAULT_LANGUAGE][key]
    return template.format(**kw) if kw else template


def _home_safe(value: str) -> str:
    home = str(Path.home())
    return value.replace(home, "~") if home and home != "/" else value


def one_line(value: str, limit: int) -> str:
    """Redacted whole, home shortened, then cut: a cut first could split a secret
    where redaction no longer recognises it."""
    flat = " ".join(_home_safe(redact.redact_text(str(value or ""))).split())
    return flat if len(flat) <= limit else flat[:limit - 1] + "…"


def _age(lang: str, seconds: float) -> str:
    s = int(max(seconds, 0))
    if s < 60:
        return text(lang, "age_s", n=s)
    if s < 3600:
        return text(lang, "age_m", n=s // 60)
    return text(lang, "age_h", n=s // 3600)


def _reset_time(value: Any, now: datetime) -> str:
    """``14:30`` today, ``11/26 14:30`` another day; "" when unreadable."""
    try:
        when = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return ""
    local = when.astimezone() if when.tzinfo else when
    return local.strftime("%H:%M") if local.date() == now.date() else local.strftime("%m/%d %H:%M")


def _quota_line(lang: str, quota: dict[str, Any], now: datetime) -> str:
    pct = quota.get("used_percent")
    if not isinstance(pct, (int, float)):
        return ""
    line = text(lang, "quota_used", pct=round(pct), window=quota.get("window") or "-")
    when = _reset_time(quota["resets_at"], now) if quota.get("resets_at") else ""
    if when:
        line += text(lang, "quota_reset", when=when)
    if quota.get("stale"):
        line += text(lang, "quota_stale")
    return line


def _account_line(lang: str, account: dict[str, Any], group: bool) -> str:
    """The whole email in a direct chat (the user's own); masked anywhere others may read."""
    name = str(account.get("name") or "") or text(lang, "default_account")
    email = str(account.get("email") or "")
    if group:
        email = redact.mask_emails(email)
    return text(lang, "account", account=f"{name} · {email}" if email else name)


def card(lang: str, row: dict[str, Any], info: dict[str, Any], status_word: Callable[[str], str],
         now: datetime, *, group: bool = True) -> str:
    """One pane: ``<status> <name> · <vendor> · <model>`` and its indented facts."""
    head = [str(row["name"])]
    vendor = str(info.get("agent_label") or info.get("agent") or "")
    if vendor:
        head.append(vendor)
    model = str(info.get("model") or "")
    if model:
        effort = str(info.get("effort") or "")
        head.append(f"{model} ({effort})" if effort else model)
    lines = [f"{status_word(row_status(row, info))} {' · '.join(head)}"]
    if info.get("account"):
        lines.append(_account_line(lang, info["account"], group))
    if info.get("quota"):
        quota = _quota_line(lang, info["quota"], now)
        if quota:
            lines.append(quota)
    last = info.get("last") or {}
    if last.get("type") == "agent_active":
        lines.append(text(lang, "last_active", age=_age(lang, float(last.get("age_seconds") or 0))))
    elif last.get("type") == "turn_complete":
        said = one_line(str(last.get("text") or ""), LAST_CHARS)
        lines.append(text(lang, "last_done", text=said) if said
                     else text(lang, "last_done_bare", age=_age(lang, float(last.get("age_seconds") or 0))))
    if row_status(row, info) == "awaiting" and info.get("prompt"):
        lines.append(text(lang, "prompt", text=one_line(str(info["prompt"]), PROMPT_CHARS)))
    return "\n".join([lines[0], *(f"　{x}" for x in lines[1:])])


def row_status(row: dict[str, Any], info: dict[str, Any]) -> str:
    """The window's badge when it answered, else the registry's."""
    return str(info.get("status") or row.get("display_status") or "")


def render(lang: str, rows: list[tuple[dict[str, Any], dict[str, Any]]], status_word: Callable[[str], str],
           *, group: bool = True, now: datetime | None = None, budget: int = CARDS_MAX_CHARS) -> str:
    """The card section for ``rows`` (bound pane first), or "" when no pane has facts.

    Up to FULL_CARDS_MAX panes each get a card. Beyond that only the first (the bound
    pane) and the active ones do, and the idle rest are folded into one line of names.
    ``group`` (any chat not known to be direct) masks account emails.
    Cards past ``budget`` characters are dropped whole and counted instead."""
    rows = [r for r in rows if r[1]]  # a pane with no facts adds nothing to its tree line
    if not rows:
        return ""
    now = now or datetime.now().astimezone()
    if len(rows) <= FULL_CARDS_MAX:
        full, folded = rows, []
    else:
        full = [r for i, r in enumerate(rows) if i == 0 or row_status(*r) in _ACTIVE]
        folded = [r for r in rows if r not in full]
    out = [text(lang, "heading")]
    used = len(out[0])
    dropped = 0
    for row, info in full:
        block = card(lang, row, info, status_word, now, group=group)
        if used + len(block) + 1 > budget:
            dropped += 1
            continue
        out.append(block)
        used += len(block) + 1
    if folded:
        names = [str(r["name"]) for r, _ in folded]
        shown = "、".join(names[:FOLDED_NAMES_MAX]) + ("…" if len(names) > FOLDED_NAMES_MAX else "")
        line = text(lang, "folded", count=len(names), names=one_line(shown, 300))
        if used + len(line) + 1 <= budget:
            out.append(line)
        else:
            dropped += len(folded)
    if dropped:
        out.append(text(lang, "cut", count=dropped))
    return "\n".join(out)


def headline_window(snapshot: dict[str, Any] | None) -> dict[str, Any] | None:
    """The quota window closest to its limit in a usage snapshot, as
    {window, used_percent, resets_at, stale}; None without a reading."""
    if not isinstance(snapshot, dict):
        return None
    windows = [w for w in snapshot.get("windows") or [] if isinstance(w, dict)
               and isinstance(w.get("usedPercent"), (int, float))]
    if not windows:
        return None
    top = max(windows, key=lambda w: float(w["usedPercent"]))
    return {"window": str(top.get("label") or top.get("kind") or ""), "used_percent": float(top["usedPercent"]),
            "resets_at": top.get("resetsAt"), "stale": bool(snapshot.get("stale"))}
