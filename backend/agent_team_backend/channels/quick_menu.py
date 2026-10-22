"""Quick menu: ``/prompts`` in a bound chat answers with buttons for the user's prompt
skills (Settings → Prompts), ``/skills`` with the CLI skills the bound pane's vendor can
be asked to run, and ``/mcp`` with MCP servers, read-only. ``/menu`` only points to them.

A button's callback data is ``nv2:<kind>:<token>``: kind ``p`` (prompt skill), ``s``
(skill) or ``g`` (go to a page); the token is a short random key into this table, so
neither a prompt id nor a skill name has to fit Telegram's 1-64 bytes, Discord's
1-100 chars or Slack's 2000. A token dies with its menu (``MENU_TTL_S``) and the
table is memory only: a backend restart expires every menu.

Lists are read when ``/menu`` is sent and checked again when a button is pressed,
so a prompt deleted or a skill taken away in between answers "gone".
"""

from __future__ import annotations

import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable

CALLBACK_PREFIX = "nv2:"
TOKEN_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789"
TOKEN_LENGTH = 8
MENU_TTL_S = 1800.0
MAX_MENUS = 200
# A menu's buttons stay pressable for its last few renders (a page edited away,
# or left on a message a failed edit replaced); older ones are dropped, so
# paging back and forth cannot pile tokens up for the menu's whole TTL.
MAX_RENDERS_PER_MENU = 3

_CALLBACK_RE = re.compile(rf"^nv2:([psgnm]):([{TOKEN_ALPHABET}]{{{TOKEN_LENGTH}}})$")
_MENTION_RE = re.compile(r"^(?:<[@!][^>]*>\s*)+")
_PICK_RE = re.compile(r"^/menu(?:@(\S+))?\s+(\d{1,3})$", re.IGNORECASE)
_MCP_PICK_RE = re.compile(r"^/mcp(?:@(\S+))?\s+(\d{1,3})$", re.IGNORECASE)
_SCOPED_PICK_RES = {
    "p": re.compile(r"^/prompts(?:@(\S+))?\s+(\d{1,3})$", re.IGNORECASE),
    "s": re.compile(r"^/skills(?:@(\S+))?\s+(\d{1,3})$", re.IGNORECASE),
}
# Tool names shown for one of Navide's MCP servers; the rest are counted.
MCP_TOOLS_SHOWN = 30
# A name typed after the vendor's skill prefix: anything else could split the command.
_SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

# How a user runs a skill by name in each CLI, only where the vendor's own docs or
# binary say so; a vendor missing here gets no Skills group.
SKILL_INVOCATION: dict[str, str] = {
    # https://code.claude.com/docs/en/skills — "put its name at the start of your message": /deploy
    "claude": "/{name}",
    # https://learn.chatgpt.com/docs/build-skills — "run /skills or type $ to mention a skill"
    "codex": "${name}",
    # https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-skills —
    # "include the skill name in your prompt, preceded by a forward slash"
    "copilot": "/{name}",
    # https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/ — "type it as a slash
    # command using the Skill's name: /<skill-name>"
    "qwen": "/{name}",
    # Kimi Code CLI's binary help text: "/skill:<name>" (moonshotai kimi-cli docs agree)
    "kimi": "/skill:{name}",
}


@dataclass(frozen=True)
class Layout:
    per_row: int
    rows: int  # item rows per page; the page row comes on top of these
    label_max: int


# Telegram documents no button count; Discord allows 5 buttons a row and 5 rows
# (40 components in all); Slack 25 elements an actions block, button text ~30
# shown of 75. Labels are kept short enough to show whole on every one.
LAYOUTS: dict[str, Layout] = {
    "telegram": Layout(per_row=2, rows=5, label_max=30),
    "discord": Layout(per_row=5, rows=4, label_max=30),
    "slack": Layout(per_row=5, rows=4, label_max=30),
}
DEFAULT_LAYOUT = Layout(per_row=2, rows=4, label_max=30)

STRINGS: dict[str, dict[str, str]] = {
    "zh-TW": {
        "title": "⚡ 快捷選單 · pane「{pane}」",
        "title_prompts": "💬 Prompts · pane「{pane}」",
        "title_skills": "🧩 Skills · pane「{pane}」",
        "title_mcp": "🔌 MCP · pane「{pane}」",
        "mcp_cli_group": "🔌 {agent} 的 MCP server（{count} 個）：CLI 自己管理，Navide 看不到狀態與工具",
        "mcp_navide_group": "🧭 Navide 用（{count} 個）：這些 server 不會接到 pane 的 CLI",
        "mcp_empty": "沒有 MCP server：這個 pane 的 CLI 設定裡沒有，Navide 也沒有設定",
        "mcp_pick_hint": "回覆 /mcp <編號> 查看詳情",
        "bad_pick_mcp": "⚠️ 沒有這個編號，請重新傳 /mcp",
        "mcp_expired": "⚠️ 這個選單已過期，請重新傳 /mcp",
        "mcp_gone": "⚠️「{name}」已不存在，請重新傳 /mcp",
        "mcp_on": "啟用",
        "mcp_off": "停用",
        "mcp_valid": "設定可解讀",
        "mcp_invalid": "設定無法解讀",
        "mcp_status_connected": "已連線",
        "mcp_status_starting": "啟動中",
        "mcp_status_error": "錯誤",
        "mcp_status_disabled": "已停用",
        "mcp_timeout": "讀取逾時",
        "mcp_tool_count": "{count} 個工具",
        "mcp_source": "來源：{source}",
        "mcp_tools_title": "工具（{count} 個）：",
        "mcp_no_tools": "沒有工具",
        "mcp_more": "…還有 {count} 個",
        "mcp_cli_note": "CLI 自己管理，Navide 看不到狀態與工具",
        "mcp_navide_note": "Navide 用，不會接到 pane 的 CLI",
        "page": "第 {page}/{pages} 頁",
        "counts": "💬 Prompts {prompts} 個 · 🧩 Skills {skills} 個",
        "no_skill_syntax": "（這個 pane 的 CLI 沒有已查證的 skill 呼叫方式，不列出 Skills）",
        "prev": "◀ 上一頁",
        "next": "下一頁 ▶",
        "not_bound": "此聊天室尚未連接 pane；在 Navide 的 pane 聊天按鈕連接後再傳 /prompts、/skills 或 /mcp",
        "no_buttons": "這個平台不支援按鈕，無法顯示快捷選單",
        "empty": "沒有可用的 prompt 或 skill；到 Navide 設定的 Prompts／Skills 新增",
        "empty_prompts": "沒有可用的 prompt；到 Navide 設定的 Prompts 新增",
        "empty_skills": "這個 pane 的 CLI 沒有可用的 skill；到 Navide 設定的 Skills 新增",
        "expired": "⚠️ 這個選單已過期，請重新傳 /prompts 或 /skills",
        "gone": "⚠️「{name}」已不存在或已停用，請重新傳 /prompts 或 /skills",
        "sent": "▶ 已送出：{name}",
        "pick_hint": "回覆 /menu <編號> 送出",
        "pick_hint_p": "回覆 /prompts <編號> 送出",
        "pick_hint_s": "回覆 /skills <編號> 送出",
        "menu_moved": "⚡ 快捷選單已拆成三個指令，請改用 /prompts、/skills、/mcp",
        "bad_pick": "⚠️ 沒有這個編號，請重新傳 /prompts 或 /skills",
        "send_failed": "⚠️ 無法顯示快捷選單：{error}",
        "shares_title": "🔗 有效的分享連結（最近 {count} 筆）",
        "shares_line": "{n}. {title} · {kind} · 開啟 {opens} 次 · 到期 {expires} · {short}",
        "shares_hint": "按「撤銷」或傳 /revoke <前 6 碼> 撤銷連結",
        "shares_untitled": "（無標題）",
        "shares_empty": "目前沒有有效的分享連結",
        "shares_failed": "⚠️ 無法處理分享連結：{error}",
        "shares_expired": "⚠️ 這個按鈕已過期，請重新傳 /shares",
        "revoke_button": "🗑 撤銷 {short}",
        "revoked": "✅ 已撤銷「{title}」（{short}）",
        "revoke_none": "找不到前幾碼為「{prefix}」的有效連結，沒有撤銷任何連結；傳 /shares 查看",
        "revoke_ambiguous": "有 {count} 筆有效連結的開頭是「{prefix}」，沒有撤銷任何連結；請多打幾碼",
        "revoke_usage": "用法：/revoke <連結代碼前 6 碼>；傳 /shares 查看代碼",
        "share_created": "🔗 已建立分享連結 · {kind} · 到期 {expires} · {short}",
        "share_masked": "已遮罩 {count} 處",
        "share_opened": "👀「{title}」（{short}）被新的裝置開啟，累計開啟 {opens} 次",
    },
    "en-US": {
        "title": "⚡ Quick menu · pane \"{pane}\"",
        "title_prompts": "💬 Prompts · pane \"{pane}\"",
        "title_skills": "🧩 Skills · pane \"{pane}\"",
        "title_mcp": "🔌 MCP · pane \"{pane}\"",
        "mcp_cli_group": "🔌 {agent}'s MCP servers ({count}): managed by the CLI itself; Navide cannot see their status or tools",
        "mcp_navide_group": "🧭 For Navide ({count}): these servers are not connected to the pane's CLI",
        "mcp_empty": "No MCP servers: none in this pane's CLI config, and none set up in Navide",
        "mcp_pick_hint": "Reply /mcp <number> for details",
        "bad_pick_mcp": "⚠️ No such number. Send /mcp again",
        "mcp_expired": "⚠️ This menu has expired. Send /mcp again",
        "mcp_gone": "⚠️ \"{name}\" no longer exists. Send /mcp again",
        "mcp_on": "on",
        "mcp_off": "off",
        "mcp_valid": "config readable",
        "mcp_invalid": "config not understood",
        "mcp_status_connected": "connected",
        "mcp_status_starting": "starting",
        "mcp_status_error": "error",
        "mcp_status_disabled": "disabled",
        "mcp_timeout": "timed out",
        "mcp_tool_count": "{count} tools",
        "mcp_source": "Source: {source}",
        "mcp_tools_title": "Tools ({count}):",
        "mcp_no_tools": "No tools",
        "mcp_more": "…and {count} more",
        "mcp_cli_note": "Managed by the CLI itself; Navide cannot see its status or tools",
        "mcp_navide_note": "For Navide; not connected to the pane's CLI",
        "page": "Page {page}/{pages}",
        "counts": "💬 Prompts {prompts} · 🧩 Skills {skills}",
        "no_skill_syntax": "(No verified way to run a skill in this pane's CLI, so Skills are not listed)",
        "prev": "◀ Previous",
        "next": "Next ▶",
        "not_bound": "This chat is not connected to a pane. Connect it from the pane's chat button in Navide, then send /prompts, /skills or /mcp",
        "no_buttons": "This platform has no buttons, so the quick menu cannot be shown",
        "empty": "No prompts or skills to offer. Add them under Prompts / Skills in Navide's settings",
        "empty_prompts": "No prompts to offer. Add them under Prompts in Navide's settings",
        "empty_skills": "This pane's CLI has no skills to offer. Add them under Skills in Navide's settings",
        "expired": "⚠️ This menu has expired. Send /prompts or /skills again",
        "gone": "⚠️ \"{name}\" no longer exists or is turned off. Send /prompts or /skills again",
        "sent": "▶ Sent: {name}",
        "pick_hint": "Reply /menu <number> to send one",
        "pick_hint_p": "Reply /prompts <number> to send one",
        "pick_hint_s": "Reply /skills <number> to send one",
        "menu_moved": "⚡ The quick menu is now three commands: use /prompts, /skills or /mcp",
        "bad_pick": "⚠️ No such number. Send /prompts or /skills again",
        "send_failed": "⚠️ The quick menu could not be shown: {error}",
        "shares_title": "🔗 Active share links (newest {count})",
        "shares_line": "{n}. {title} · {kind} · opened {opens}× · expires {expires} · {short}",
        "shares_hint": "Press Revoke, or send /revoke <first 6 characters>, to revoke a link",
        "shares_untitled": "(untitled)",
        "shares_empty": "No active share links",
        "shares_failed": "⚠️ Share links could not be handled: {error}",
        "shares_expired": "⚠️ This button has expired. Send /shares again",
        "revoke_button": "🗑 Revoke {short}",
        "revoked": "✅ Revoked \"{title}\" ({short})",
        "revoke_none": "No active link starts with \"{prefix}\", so nothing was revoked. Send /shares to see them",
        "revoke_ambiguous": "{count} active links start with \"{prefix}\", so nothing was revoked. Type more characters",
        "revoke_usage": "Usage: /revoke <first 6 characters of the link code>. Send /shares to see the codes",
        "share_created": "🔗 Share link created · {kind} · expires {expires} · {short}",
        "share_masked": "{count} masked",
        "share_opened": "👀 \"{title}\" ({short}) was opened on a new device, {opens} opens in all",
    },
    "ja-JP": {
        "title": "⚡ クイックメニュー · pane「{pane}」",
        "title_prompts": "💬 Prompts · pane「{pane}」",
        "title_skills": "🧩 Skills · pane「{pane}」",
        "title_mcp": "🔌 MCP · pane「{pane}」",
        "mcp_cli_group": "🔌 {agent} の MCP server（{count} 件）：CLI 自身が管理しているため、Navide からは状態もツールも見えません",
        "mcp_navide_group": "🧭 Navide 用（{count} 件）：これらの server は pane の CLI には接続されません",
        "mcp_empty": "MCP server がありません。この pane の CLI の設定にも、Navide にもありません",
        "mcp_pick_hint": "詳細は /mcp <番号> と返信してください",
        "bad_pick_mcp": "⚠️ その番号はありません。もう一度 /mcp を送ってください",
        "mcp_expired": "⚠️ このメニューは期限切れです。もう一度 /mcp を送ってください",
        "mcp_gone": "⚠️「{name}」はもう存在しません。もう一度 /mcp を送ってください",
        "mcp_on": "有効",
        "mcp_off": "無効",
        "mcp_valid": "設定は読み取り可能",
        "mcp_invalid": "設定を読み取れません",
        "mcp_status_connected": "接続済み",
        "mcp_status_starting": "起動中",
        "mcp_status_error": "エラー",
        "mcp_status_disabled": "無効",
        "mcp_timeout": "読み取りタイムアウト",
        "mcp_tool_count": "ツール {count} 件",
        "mcp_source": "設定元：{source}",
        "mcp_tools_title": "ツール（{count} 件）：",
        "mcp_no_tools": "ツールはありません",
        "mcp_more": "…ほか {count} 件",
        "mcp_cli_note": "CLI 自身が管理しているため、Navide からは状態もツールも見えません",
        "mcp_navide_note": "Navide 用。pane の CLI には接続されません",
        "page": "{page}/{pages} ページ",
        "counts": "💬 Prompts {prompts} 件 · 🧩 Skills {skills} 件",
        "no_skill_syntax": "（この pane の CLI には確認済みの skill 呼び出し方法がないため、Skills は表示しません）",
        "prev": "◀ 前へ",
        "next": "次へ ▶",
        "not_bound": "このチャットは pane に接続されていません。Navide の pane のチャットボタンで接続してから /prompts、/skills、/mcp のいずれかを送ってください",
        "no_buttons": "このプラットフォームはボタンに対応していないため、クイックメニューを表示できません",
        "empty": "使える prompt も skill もありません。Navide の設定の Prompts／Skills で追加してください",
        "empty_prompts": "使える prompt がありません。Navide の設定の Prompts で追加してください",
        "empty_skills": "この pane の CLI で使える skill がありません。Navide の設定の Skills で追加してください",
        "expired": "⚠️ このメニューは期限切れです。もう一度 /prompts か /skills を送ってください",
        "gone": "⚠️「{name}」は存在しないか無効になっています。もう一度 /prompts か /skills を送ってください",
        "sent": "▶ 送信しました：{name}",
        "pick_hint": "送るには /menu <番号> と返信してください",
        "pick_hint_p": "送るには /prompts <番号> と返信してください",
        "pick_hint_s": "送るには /skills <番号> と返信してください",
        "menu_moved": "⚡ クイックメニューは 3 つのコマンドに分かれました。/prompts、/skills、/mcp を使ってください",
        "bad_pick": "⚠️ その番号はありません。もう一度 /prompts か /skills を送ってください",
        "send_failed": "⚠️ クイックメニューを表示できませんでした：{error}",
        "shares_title": "🔗 有効な共有リンク（最新 {count} 件）",
        "shares_line": "{n}. {title} · {kind} · 開封 {opens} 回 · 期限 {expires} · {short}",
        "shares_hint": "「取り消し」を押すか、/revoke <先頭 6 文字> を送るとリンクを取り消せます",
        "shares_untitled": "（タイトルなし）",
        "shares_empty": "有効な共有リンクはありません",
        "shares_failed": "⚠️ 共有リンクを処理できませんでした：{error}",
        "shares_expired": "⚠️ このボタンは期限切れです。もう一度 /shares を送ってください",
        "revoke_button": "🗑 取り消し {short}",
        "revoked": "✅「{title}」（{short}）を取り消しました",
        "revoke_none": "「{prefix}」で始まる有効なリンクがないため、何も取り消していません。/shares で確認してください",
        "revoke_ambiguous": "「{prefix}」で始まる有効なリンクが {count} 件あるため、何も取り消していません。もう少し長く入力してください",
        "revoke_usage": "使い方：/revoke <リンクコードの先頭 6 文字>。/shares でコードを確認できます",
        "share_created": "🔗 共有リンクを作成しました · {kind} · 期限 {expires} · {short}",
        "share_masked": "{count} 件をマスク",
        "share_opened": "👀「{title}」（{short}）が新しいデバイスで開かれました。累計 {opens} 回",
    },
}
DEFAULT_LANGUAGE = "zh-TW"


def text(lang: str, key: str, **kw: Any) -> str:
    return STRINGS.get(lang, STRINGS[DEFAULT_LANGUAGE])[key].format(**kw)


def strip_mention(body: str, identity: str = "") -> str:
    """``body`` without a leading Slack/Discord mention (``<@U123>``) or the bot's own
    ``@name`` (``identity``), so a command addressed to the bot reads as typed."""
    rest = _MENTION_RE.sub("", (body or "").strip()).strip()
    name = identity.lstrip("@").lower()
    if name and rest.lower().startswith("@" + name) and rest[len(name) + 1:len(name) + 2] in ("", " ", "\n"):
        rest = rest[len(name) + 1:].strip()
    return rest


def is_menu_command(body: str, identity: str = "") -> bool:
    """``/menu`` or a bare ``/start`` (Telegram's first contact, when it carries no link
    code), optionally ``@bot``-addressed or after a leading mention. A command addressed
    to another bot (``/menu@other``) is not ours."""
    return menu_scope(body, identity) == "all"


# The commands that open a quick menu, and which of its groups each one lists.
_MENU_SCOPES = {"/menu": "all", "/start": "all", "/prompts": "p", "/skills": "s", "/mcp": "mcp"}


def menu_scope(body: str, identity: str = "") -> str | None:
    """``"all"`` for ``/menu`` (as ``is_menu_command``), ``"p"`` for ``/prompts``, ``"s"``
    for ``/skills``, ``"mcp"`` for ``/mcp``; None for anything else, a command addressed
    to another bot included."""
    rest = strip_mention(body, identity)
    if not rest.startswith("/") or " " in rest:
        return None
    head, _, bot = rest.partition("@")
    if bot and identity and bot.lower() != identity.lstrip("@").lower():
        return None
    return _MENU_SCOPES.get(head.lower())


def menu_pick(body: str, identity: str = "") -> int | None:
    """The number in ``/menu <n>``: an item of the text menu a platform without buttons got."""
    return _pick(_PICK_RE, body, identity)


def mcp_pick(body: str, identity: str = "") -> int | None:
    """The number in ``/mcp <n>``: a server of the text ``/mcp`` list."""
    return _pick(_MCP_PICK_RE, body, identity)


def scoped_pick(body: str, identity: str = "") -> tuple[str, int] | None:
    """``("p", n)`` for ``/prompts <n>``, ``("s", n)`` for ``/skills <n>``: an item of
    that command's text menu."""
    for scope, pattern in _SCOPED_PICK_RES.items():
        n = _pick(pattern, body, identity)
        if n is not None:
            return scope, n
    return None


def _pick(pattern: re.Pattern[str], body: str, identity: str) -> int | None:
    m = pattern.match(strip_mention(body, identity))
    if m is None or (m.group(1) and identity and m.group(1).lower() != identity.lstrip("@").lower()):
        return None
    n = int(m.group(2))
    return n if n > 0 else None


def mcp_cli_detail(lang: str, row: dict[str, Any], agent_key: str) -> str:
    """One of the CLI's own servers: allowlisted fields only (see mcp_menu)."""
    return "\n".join([
        f"🔌 {row['name']}",
        f"{agent_key} · {row['transport']} · {text(lang, 'mcp_on' if row['enabled'] else 'mcp_off')}"
        f" · {text(lang, 'mcp_valid' if row['valid'] else 'mcp_invalid')}",
        text(lang, "mcp_source", source=row["source"]),
        text(lang, "mcp_cli_note"),
    ])


def mcp_navide_detail(lang: str, row: dict[str, Any], tools: list[str] | None) -> str:
    """One of Navide's servers and its tool names; ``tools`` None: tools/list timed out."""
    lines = [f"🧭 {row['name']}", text(lang, "mcp_navide_note"), _mcp_status(lang, row["status"])]
    if row["status"] == "connected":
        if tools is None:
            lines.append(text(lang, "mcp_timeout"))
        elif not tools:
            lines.append(text(lang, "mcp_no_tools"))
        else:
            lines.append(text(lang, "mcp_tools_title", count=len(tools)))
            lines += ["• " + _clip(t, 64) for t in tools[:MCP_TOOLS_SHOWN]]
            if len(tools) > MCP_TOOLS_SHOWN:
                lines.append(text(lang, "mcp_more", count=len(tools) - MCP_TOOLS_SHOWN))
    return "\n".join(lines)


def _mcp_status(lang: str, status: str) -> str:
    return text(lang, "mcp_timeout" if status == "timeout" else f"mcp_status_{status}")


def parse_callback(data: str) -> tuple[str, str] | None:
    m = _CALLBACK_RE.match(data or "")
    return (m.group(1), m.group(2)) if m else None


def skill_command(agent_key: str, name: str) -> str:
    return SKILL_INVOCATION[agent_key].format(name=name)


def agent_skills(store: Any, agent_key: str) -> list[str]:
    """Skill names ``agent_key`` can run: shared ones routed to it (all of them for a CLI
    that reads the shared root itself), its own native ones, and natives delivered to it."""
    if agent_key not in SKILL_INVOCATION:
        return []
    listing = store.list_skills()
    agent = next((a for a in listing.get("agents") or [] if a.get("key") == agent_key), {})
    shared = [s for s in listing.get("skills") or [] if s.get("valid")]
    names: list[str] = []
    if agent.get("reads_shared_root"):
        names += [str(s["name"]) for s in shared]
    elif agent.get("state") == "wired":
        routed = set(store.targets_for(agent_key))
        names += [str(s["name"]) for s in shared if s["name"] in routed]
    delivered = set(store.native_targets_for(agent_key))
    names += [
        str(n["name"]) for n in listing.get("native") or []
        if n.get("valid") and (n.get("owner_agent") == agent_key or n.get("real_path") in delivered)
    ]
    out: list[str] = []
    for name in names:
        if _SKILL_NAME_RE.fullmatch(name) and name not in out:
            out.append(name)
    return sorted(out, key=str.lower)


@dataclass(frozen=True)
class Item:
    kind: str  # "p" | "s" | "n" (a CLI's MCP server) | "m" (Navide's MCP server)
    key: str  # prompt skill id | skill name | MCP server name
    label: str
    line: str = ""  # the /mcp list's line for it; the label when empty


@dataclass
class Menu:
    id: str
    location_key: str
    pane_id: str
    agent_key: str
    lang: str
    title: str
    pages: list[list[list[Item]]]
    skills_supported: bool
    counts: tuple[int, int]
    created: float
    message_id: str = ""
    scope: str = "all"  # "all" (/menu), "p" (/prompts), "s" (/skills) or "mcp" (/mcp)


@dataclass(frozen=True)
class Press:
    menu: Menu
    kind: str  # "p" | "s" | "n" | "m" | "g"
    key: str  # prompt id | skill name | MCP server name | page number
    label: str


@dataclass
class _Token:
    menu_id: str
    kind: str
    key: str
    label: str


def _clip(label: str, limit: int) -> str:
    label = " ".join(label.split())
    return label if len(label) <= limit else label[: limit - 1] + "…"


def _items(menu: Menu) -> list[Item]:
    return [item for page in menu.pages for row in page for item in row]


def _heading(menu: Menu, numbered: bool = False) -> list[str]:
    """The title lines: /menu counts both groups; /prompts and /skills name their one group;
    /mcp lists both of its groups, each under its note (numbered for the text menu)."""
    if menu.scope == "mcp":
        items = _items(menu)
        native = [(n, i) for n, i in enumerate(items, 1) if i.kind == "n"]
        navide = [(n, i) for n, i in enumerate(items, 1) if i.kind == "m"]
        lines = [text(menu.lang, "title_mcp", pane=menu.title)]
        for header, group in ((text(menu.lang, "mcp_cli_group", agent=menu.agent_key or "?", count=len(native)), native),
                              (text(menu.lang, "mcp_navide_group", count=len(navide)), navide)):
            lines.append(header)
            lines += [f"{n}. {i.line}" if numbered else f"• {i.line}" for n, i in group]
        return lines
    if menu.scope != "all":
        return [text(menu.lang, "title_prompts" if menu.scope == "p" else "title_skills", pane=menu.title)]
    lines = [text(menu.lang, "title", pane=menu.title),
             text(menu.lang, "counts", prompts=menu.counts[0], skills=menu.counts[1])]
    if not menu.skills_supported:
        lines.append(text(menu.lang, "no_skill_syntax"))
    return lines


def paginate(prompts: list[Item], skills: list[Item], layout: Layout) -> list[list[list[Item]]]:
    """Rows of ``per_row`` buttons, a group never sharing a row, ``rows`` rows a page."""
    rows = [g[i:i + layout.per_row] for g in (prompts, skills) for i in range(0, len(g), layout.per_row)]
    return [rows[i:i + layout.rows] for i in range(0, len(rows), layout.rows)]


@dataclass
class QuickMenus:
    clock: Callable[[], float] = time.monotonic
    _menus: dict[str, Menu] = field(default_factory=dict)
    _tokens: dict[str, _Token] = field(default_factory=dict)
    _renders: dict[str, list[list[str]]] = field(default_factory=dict)  # menu id -> tokens per render

    def create(self, *, platform: str, location_key: str, pane_id: str, pane_title: str,
               agent_key: str, lang: str, prompts: list[dict[str, Any]], skills: list[str],
               scope: str = "all") -> Menu | None:
        """A menu for this snapshot, or None when it would have no buttons."""
        layout = LAYOUTS.get(platform, DEFAULT_LAYOUT)
        p_items = [Item("p", str(p["id"]), _clip("💬 " + str(p["name"]), layout.label_max)) for p in prompts]
        s_items = [Item("s", name, _clip("🧩 " + name, layout.label_max)) for name in skills]
        if not p_items and not s_items:
            return None
        self._prune()
        menu = Menu(
            id=self._new_key(self._menus), location_key=location_key, pane_id=pane_id,
            agent_key=agent_key, lang=lang, title=pane_title,
            pages=paginate(p_items, s_items, layout), skills_supported=agent_key in SKILL_INVOCATION,
            counts=(len(p_items), len(s_items)), created=self.clock(), scope=scope,
        )
        self._menus[menu.id] = menu
        return menu

    def create_mcp(self, *, platform: str, location_key: str, pane_id: str, pane_title: str,
                   agent_key: str, lang: str, native: list[dict[str, Any]],
                   navide: list[dict[str, Any]]) -> Menu | None:
        """The /mcp list: ``native`` (mcp_menu.native_rows) then ``navide``
        (mcp_menu.navide_rows); only their allowlisted fields are read."""
        layout = LAYOUTS.get(platform, DEFAULT_LAYOUT)
        n_items = [Item("n", str(r["name"]), _clip("🔌 " + str(r["name"]), layout.label_max),
                        f"🔌 {r['name']} · {r['transport']} · {text(lang, 'mcp_on' if r['enabled'] else 'mcp_off')}")
                   for r in native]
        m_items = []
        for r in navide:
            line = f"🧭 {r['name']} · {_mcp_status(lang, str(r['status']))}"
            if r["status"] == "connected" and r["tool_count"] is not None:
                line += " · " + text(lang, "mcp_tool_count", count=r["tool_count"])
            m_items.append(Item("m", str(r["name"]), _clip("🧭 " + str(r["name"]), layout.label_max), line))
        if not n_items and not m_items:
            return None
        self._prune()
        menu = Menu(
            id=self._new_key(self._menus), location_key=location_key, pane_id=pane_id,
            agent_key=agent_key, lang=lang, title=pane_title, pages=paginate(n_items, m_items, layout),
            skills_supported=True, counts=(len(n_items), len(m_items)), created=self.clock(), scope="mcp",
        )
        self._menus[menu.id] = menu
        return menu

    def render(self, menu: Menu, page: int) -> tuple[str, list[list[tuple[str, str]]]]:
        """The message text and button rows for ``page`` (0-based, clamped)."""
        page = max(0, min(page, len(menu.pages) - 1))
        lines = _heading(menu)
        if len(menu.pages) > 1:
            lines[0] += "　" + text(menu.lang, "page", page=page + 1, pages=len(menu.pages))
        rows = [[(item.label, self._mint(menu, item.kind, item.key, item.label)) for item in row]
                for row in menu.pages[page]]
        nav: list[tuple[str, str]] = []
        if page > 0:
            nav.append((text(menu.lang, "prev"), self._mint(menu, "g", str(page - 1), "")))
        if page < len(menu.pages) - 1:
            nav.append((text(menu.lang, "next"), self._mint(menu, "g", str(page + 1), "")))
        if nav:
            rows.append(nav)
        renders = self._renders.setdefault(menu.id, [])
        renders.append([data[len(CALLBACK_PREFIX) + 2:] for row in rows for _, data in row])
        while len(renders) > MAX_RENDERS_PER_MENU:
            for token in renders.pop(0):
                self._tokens.pop(token, None)
        return "\n".join(lines), rows

    def render_text(self, menu: Menu) -> str:
        """The whole menu as numbered lines, for a platform without buttons."""
        if menu.scope == "mcp":
            return "\n".join([*_heading(menu, numbered=True), text(menu.lang, "mcp_pick_hint")])
        lines = _heading(menu)
        lines += [f"{n}. {item.label}" for n, item in enumerate(_items(menu), 1)]
        lines.append(text(menu.lang, {"p": "pick_hint_p", "s": "pick_hint_s"}.get(menu.scope, "pick_hint")))
        return "\n".join(lines)

    def latest(self, location_key: str, mcp: bool = False, scope: str | None = None) -> Menu | None:
        """The newest live menu sent to ``location_key``: an /mcp list when ``mcp``, else
        any other, so ``/menu <n>`` and ``/mcp <n>`` never pick from each other's list;
        only one of ``scope`` ("p" or "s") when given, for ``/prompts <n>``, ``/skills <n>``."""
        now = self.clock()
        live = [m for m in self._menus.values()
                if m.location_key == location_key and now - m.created <= MENU_TTL_S
                and (m.scope == "mcp") == mcp and (scope is None or m.scope == scope)]
        return live[-1] if live else None

    def pick(self, location_key: str, number: int, mcp: bool = False, scope: str | None = None) -> Press | None:
        """Item ``number`` (1-based) of the newest live menu at ``location_key``."""
        menu = self.latest(location_key, mcp, scope)
        items = _items(menu) if menu is not None else []
        if not 0 < number <= len(items):
            return None
        item = items[number - 1]
        return Press(menu, item.kind, item.key, item.label)

    def press(self, kind: str, token: str, location_key: str) -> Press | None:
        """The live press ``token`` stands for, pressed in ``location_key``; None once expired."""
        entry = self._tokens.get(token)
        menu = self._menus.get(entry.menu_id) if entry is not None else None
        if entry is None or menu is None or entry.kind != kind or menu.location_key != location_key:
            return None
        if self.clock() - menu.created > MENU_TTL_S:
            self._drop(menu.id)
            return None
        return Press(menu, entry.kind, entry.key, entry.label)

    def _mint(self, menu: Menu, kind: str, key: str, label: str) -> str:
        token = self._new_key(self._tokens)
        self._tokens[token] = _Token(menu.id, kind, key, label)
        return f"{CALLBACK_PREFIX}{kind}:{token}"

    def _new_key(self, taken: dict[str, Any]) -> str:
        while True:
            key = "".join(secrets.choice(TOKEN_ALPHABET) for _ in range(TOKEN_LENGTH))
            if key not in taken:
                return key

    def _drop(self, menu_id: str) -> None:
        self._menus.pop(menu_id, None)
        self._renders.pop(menu_id, None)
        for token in [t for t, e in self._tokens.items() if e.menu_id == menu_id]:
            del self._tokens[token]

    def _prune(self) -> None:
        now = self.clock()
        for menu in [m for m in self._menus.values() if now - m.created > MENU_TTL_S]:
            self._drop(menu.id)
        while len(self._menus) >= MAX_MENUS:
            self._drop(next(iter(self._menus)))
