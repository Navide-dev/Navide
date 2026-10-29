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
        "title_prompts": "💬 Prompt 技能 · pane「{pane}」",
        "title_skills": "🧩 技能 · pane「{pane}」",
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
        "counts": "💬 Prompt 技能 {prompts} 個 · 🧩 技能 {skills} 個",
        "no_skill_syntax": "（這個 pane 的 CLI 沒有已查證的 skill 呼叫方式，不列出技能）",
        "prev": "◀ 上一頁",
        "next": "下一頁 ▶",
        "not_bound": "此聊天室尚未連接 pane；在 Navide 的 pane 聊天按鈕連接後再傳 /prompts、/skills 或 /mcp",
        "no_buttons": "這個平台不支援按鈕，無法顯示快捷選單",
        "empty": "沒有可用的 prompt 或 skill；到 Navide 設定的「Prompt 技能」／「技能」新增",
        "empty_prompts": "沒有可用的 prompt；到 Navide 設定的「Prompt 技能」新增",
        "empty_skills": "這個 pane 的 CLI 沒有可用的 skill；到 Navide 設定的「技能」新增",
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
        "title_prompts": "💬 プロンプト · pane「{pane}」",
        "title_skills": "🧩 スキル · pane「{pane}」",
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
        "counts": "💬 プロンプト {prompts} 件 · 🧩 スキル {skills} 件",
        "no_skill_syntax": "（この pane の CLI には確認済みの skill 呼び出し方法がないため、スキルは表示しません）",
        "prev": "◀ 前へ",
        "next": "次へ ▶",
        "not_bound": "このチャットは pane に接続されていません。Navide の pane のチャットボタンで接続してから /prompts、/skills、/mcp のいずれかを送ってください",
        "no_buttons": "このプラットフォームはボタンに対応していないため、クイックメニューを表示できません",
        "empty": "使える prompt も skill もありません。Navide の設定の「プロンプト」／「スキル」で追加してください",
        "empty_prompts": "使える prompt がありません。Navide の設定の「プロンプト」で追加してください",
        "empty_skills": "この pane の CLI で使える skill がありません。Navide の設定の「スキル」で追加してください",
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
    "zh-CN": {
        "title": "⚡ 快捷菜单 · pane“{pane}”",
        "title_prompts": "💬 Prompt 技能 · pane“{pane}”",
        "title_skills": "🧩 技能 · pane“{pane}”",
        "title_mcp": "🔌 MCP · pane“{pane}”",
        "mcp_cli_group": "🔌 {agent} 的 MCP server（{count} 个）：由 CLI 自己管理，Navide 看不到状态与工具",
        "mcp_navide_group": "🧭 Navide 用（{count} 个）：这些 server 不会接到 pane 的 CLI",
        "mcp_empty": "没有 MCP server：这个 pane 的 CLI 设置里没有，Navide 也没有设置",
        "mcp_pick_hint": "回复 /mcp <编号> 查看详情",
        "bad_pick_mcp": "⚠️ 没有这个编号，请重新发送 /mcp",
        "mcp_expired": "⚠️ 这个菜单已过期，请重新发送 /mcp",
        "mcp_gone": "⚠️“{name}”已不存在，请重新发送 /mcp",
        "mcp_on": "启用",
        "mcp_off": "停用",
        "mcp_valid": "设置可解读",
        "mcp_invalid": "设置无法解读",
        "mcp_status_connected": "已连接",
        "mcp_status_starting": "启动中",
        "mcp_status_error": "错误",
        "mcp_status_disabled": "已停用",
        "mcp_timeout": "读取超时",
        "mcp_tool_count": "{count} 个工具",
        "mcp_source": "来源：{source}",
        "mcp_tools_title": "工具（{count} 个）：",
        "mcp_no_tools": "没有工具",
        "mcp_more": "…还有 {count} 个",
        "mcp_cli_note": "由 CLI 自己管理，Navide 看不到状态与工具",
        "mcp_navide_note": "Navide 用，不会接到 pane 的 CLI",
        "page": "第 {page}/{pages} 页",
        "counts": "💬 Prompt 技能 {prompts} 个 · 🧩 技能 {skills} 个",
        "no_skill_syntax": "（这个 pane 的 CLI 没有已查证的 skill 调用方式，不列出技能）",
        "prev": "◀ 上一页",
        "next": "下一页 ▶",
        "not_bound": "此聊天室尚未连接 pane；在 Navide 里用 pane 的聊天按钮连接后，再发送 /prompts、/skills 或 /mcp",
        "no_buttons": "这个平台不支持按钮，无法显示快捷菜单",
        "empty": "没有可用的 prompt 或 skill；到 Navide 设置的“Prompt 技能”／“技能”新增",
        "empty_prompts": "没有可用的 prompt；到 Navide 设置的“Prompt 技能”新增",
        "empty_skills": "这个 pane 的 CLI 没有可用的 skill；到 Navide 设置的“技能”新增",
        "expired": "⚠️ 这个菜单已过期，请重新发送 /prompts 或 /skills",
        "gone": "⚠️“{name}”已不存在或已停用，请重新发送 /prompts 或 /skills",
        "sent": "▶ 已发送：{name}",
        "pick_hint": "回复 /menu <编号> 发送",
        "pick_hint_p": "回复 /prompts <编号> 发送",
        "pick_hint_s": "回复 /skills <编号> 发送",
        "menu_moved": "⚡ 快捷菜单已拆成三个指令，请改用 /prompts、/skills、/mcp",
        "bad_pick": "⚠️ 没有这个编号，请重新发送 /prompts 或 /skills",
        "send_failed": "⚠️ 无法显示快捷菜单：{error}",
        "shares_title": "🔗 有效的分享链接（最近 {count} 条）",
        "shares_line": "{n}. {title} · {kind} · 打开 {opens} 次 · 到期 {expires} · {short}",
        "shares_hint": "按“撤销”或发送 /revoke <前 6 位> 撤销链接",
        "shares_untitled": "（无标题）",
        "shares_empty": "目前没有有效的分享链接",
        "shares_failed": "⚠️ 无法处理分享链接：{error}",
        "shares_expired": "⚠️ 这个按钮已过期，请重新发送 /shares",
        "revoke_button": "🗑 撤销 {short}",
        "revoked": "✅ 已撤销“{title}”（{short}）",
        "revoke_none": "找不到开头为“{prefix}”的有效链接，没有撤销任何链接；发送 /shares 查看",
        "revoke_ambiguous": "有 {count} 条有效链接的开头是“{prefix}”，没有撤销任何链接；请多输入几位",
        "revoke_usage": "用法：/revoke <链接代码前 6 位>；发送 /shares 查看代码",
        "share_created": "🔗 已创建分享链接 · {kind} · 到期 {expires} · {short}",
        "share_masked": "已遮蔽 {count} 处",
        "share_opened": "👀“{title}”（{short}）被新的设备打开，累计打开 {opens} 次",
    },
    "ko-KR": {
        "title": "⚡ 빠른 메뉴 · pane “{pane}”",
        "title_prompts": "💬 프롬프트 · pane “{pane}”",
        "title_skills": "🧩 스킬 · pane “{pane}”",
        "title_mcp": "🔌 MCP · pane “{pane}”",
        "mcp_cli_group": "🔌 {agent}의 MCP 서버({count}개): CLI가 직접 관리하므로 Navide는 상태와 도구를 볼 수 없어요",
        "mcp_navide_group": "🧭 Navide용({count}개): 이 서버들은 pane의 CLI에 연결되지 않아요",
        "mcp_empty": "MCP 서버가 없어요. 이 pane의 CLI 설정에도 없고 Navide에도 설정되어 있지 않아요",
        "mcp_pick_hint": "자세히 보려면 /mcp <번호>로 답장하세요",
        "bad_pick_mcp": "⚠️ 없는 번호예요. /mcp를 다시 보내세요",
        "mcp_expired": "⚠️ 이 메뉴는 만료됐어요. /mcp를 다시 보내세요",
        "mcp_gone": "⚠️ “{name}”이(가) 더 이상 없어요. /mcp를 다시 보내세요",
        "mcp_on": "켜짐",
        "mcp_off": "꺼짐",
        "mcp_valid": "설정 읽기 가능",
        "mcp_invalid": "설정을 해석할 수 없음",
        "mcp_status_connected": "연결됨",
        "mcp_status_starting": "시작 중",
        "mcp_status_error": "오류",
        "mcp_status_disabled": "사용 안 함",
        "mcp_timeout": "시간 초과",
        "mcp_tool_count": "도구 {count}개",
        "mcp_source": "출처: {source}",
        "mcp_tools_title": "도구({count}개):",
        "mcp_no_tools": "도구 없음",
        "mcp_more": "…외 {count}개",
        "mcp_cli_note": "CLI가 직접 관리하므로 Navide는 상태와 도구를 볼 수 없어요",
        "mcp_navide_note": "Navide용이며 pane의 CLI에 연결되지 않아요",
        "page": "{page}/{pages}페이지",
        "counts": "💬 프롬프트 {prompts}개 · 🧩 스킬 {skills}개",
        "no_skill_syntax": "(이 pane의 CLI에서 스킬을 실행하는 확인된 방법이 없어서 스킬은 표시하지 않아요)",
        "prev": "◀ 이전",
        "next": "다음 ▶",
        "not_bound": "이 채팅은 pane에 연결되어 있지 않아요. Navide에서 pane의 채팅 버튼으로 연결한 뒤 /prompts, /skills 또는 /mcp를 보내세요",
        "no_buttons": "이 플랫폼은 버튼을 지원하지 않아서 빠른 메뉴를 표시할 수 없어요",
        "empty": "사용할 수 있는 프롬프트나 스킬이 없어요. Navide 설정의 프롬프트／스킬에서 추가하세요",
        "empty_prompts": "사용할 수 있는 프롬프트가 없어요. Navide 설정의 프롬프트에서 추가하세요",
        "empty_skills": "이 pane의 CLI에서 사용할 수 있는 스킬이 없어요. Navide 설정의 스킬에서 추가하세요",
        "expired": "⚠️ 이 메뉴는 만료됐어요. /prompts 또는 /skills를 다시 보내세요",
        "gone": "⚠️ “{name}”이(가) 더 이상 없거나 꺼져 있어요. /prompts 또는 /skills를 다시 보내세요",
        "sent": "▶ 보냄: {name}",
        "pick_hint": "보내려면 /menu <번호>로 답장하세요",
        "pick_hint_p": "보내려면 /prompts <번호>로 답장하세요",
        "pick_hint_s": "보내려면 /skills <번호>로 답장하세요",
        "menu_moved": "⚡ 빠른 메뉴가 세 개의 명령으로 나뉘었어요. /prompts, /skills, /mcp를 사용하세요",
        "bad_pick": "⚠️ 없는 번호예요. /prompts 또는 /skills를 다시 보내세요",
        "send_failed": "⚠️ 빠른 메뉴를 표시하지 못했어요: {error}",
        "shares_title": "🔗 유효한 공유 링크(최근 {count}개)",
        "shares_line": "{n}. {title} · {kind} · {opens}회 열림 · {expires} 만료 · {short}",
        "shares_hint": "링크를 철회하려면 “철회”를 누르거나 /revoke <앞 6자리>를 보내세요",
        "shares_untitled": "(제목 없음)",
        "shares_empty": "유효한 공유 링크가 없어요",
        "shares_failed": "⚠️ 공유 링크를 처리하지 못했어요: {error}",
        "shares_expired": "⚠️ 이 버튼은 만료됐어요. /shares를 다시 보내세요",
        "revoke_button": "🗑 철회 {short}",
        "revoked": "✅ “{title}”({short})을(를) 철회했어요",
        "revoke_none": "“{prefix}”(으)로 시작하는 유효한 링크가 없어서 아무것도 철회하지 않았어요. /shares를 보내 확인하세요",
        "revoke_ambiguous": "“{prefix}”(으)로 시작하는 유효한 링크가 {count}개라서 아무것도 철회하지 않았어요. 더 많은 문자를 입력하세요",
        "revoke_usage": "사용법: /revoke <링크 코드 앞 6자리>. 코드는 /shares를 보내 확인하세요",
        "share_created": "🔗 공유 링크를 만들었어요 · {kind} · {expires} 만료 · {short}",
        "share_masked": "{count}곳 가림",
        "share_opened": "👀 “{title}”({short})이(가) 새 기기에서 열렸어요. 누적 {opens}회",
    },
    "es-ES": {
        "title": "⚡ Menú rápido · pane «{pane}»",
        "title_prompts": "💬 Prompts · pane «{pane}»",
        "title_skills": "🧩 Skills · pane «{pane}»",
        "title_mcp": "🔌 MCP · pane «{pane}»",
        "mcp_cli_group": "🔌 Servidores MCP de {agent} ({count}): los gestiona la propia CLI; Navide no puede ver su estado ni sus herramientas",
        "mcp_navide_group": "🧭 Para Navide ({count}): estos servidores no están conectados a la CLI del pane",
        "mcp_empty": "No hay servidores MCP: no hay ninguno en la configuración de la CLI de este pane ni configurado en Navide",
        "mcp_pick_hint": "Responde /mcp <número> para ver los detalles",
        "bad_pick_mcp": "⚠️ No existe ese número. Envía /mcp de nuevo",
        "mcp_expired": "⚠️ Este menú ha caducado. Envía /mcp de nuevo",
        "mcp_gone": "⚠️ «{name}» ya no existe. Envía /mcp de nuevo",
        "mcp_on": "activado",
        "mcp_off": "desactivado",
        "mcp_valid": "configuración legible",
        "mcp_invalid": "configuración no interpretable",
        "mcp_status_connected": "conectado",
        "mcp_status_starting": "iniciando",
        "mcp_status_error": "error",
        "mcp_status_disabled": "desactivado",
        "mcp_timeout": "tiempo agotado",
        "mcp_tool_count": "{count} herramientas",
        "mcp_source": "Origen: {source}",
        "mcp_tools_title": "Herramientas ({count}):",
        "mcp_no_tools": "Sin herramientas",
        "mcp_more": "…y {count} más",
        "mcp_cli_note": "Lo gestiona la propia CLI; Navide no puede ver su estado ni sus herramientas",
        "mcp_navide_note": "Para Navide; no está conectado a la CLI del pane",
        "page": "Página {page}/{pages}",
        "counts": "💬 Prompts {prompts} · 🧩 Skills {skills}",
        "no_skill_syntax": "(No hay una forma verificada de ejecutar una skill en la CLI de este pane, así que no se muestran las Skills)",
        "prev": "◀ Anterior",
        "next": "Siguiente ▶",
        "not_bound": "Este chat no está conectado a un pane. Conéctalo desde el botón de chat del pane en Navide y luego envía /prompts, /skills o /mcp",
        "no_buttons": "Esta plataforma no tiene botones, así que no se puede mostrar el menú rápido",
        "empty": "No hay prompts ni skills disponibles. Añádelos en Prompts / Skills, en los ajustes de Navide",
        "empty_prompts": "No hay prompts disponibles. Añádelos en Prompts, en los ajustes de Navide",
        "empty_skills": "La CLI de este pane no tiene skills disponibles. Añádelas en Skills, en los ajustes de Navide",
        "expired": "⚠️ Este menú ha caducado. Envía /prompts o /skills de nuevo",
        "gone": "⚠️ «{name}» ya no existe o está desactivado. Envía /prompts o /skills de nuevo",
        "sent": "▶ Enviado: {name}",
        "pick_hint": "Responde /menu <número> para enviar uno",
        "pick_hint_p": "Responde /prompts <número> para enviar uno",
        "pick_hint_s": "Responde /skills <número> para enviar una",
        "menu_moved": "⚡ El menú rápido ahora son tres comandos: usa /prompts, /skills o /mcp",
        "bad_pick": "⚠️ No existe ese número. Envía /prompts o /skills de nuevo",
        "send_failed": "⚠️ No se pudo mostrar el menú rápido: {error}",
        "shares_title": "🔗 Enlaces compartidos activos (los {count} más recientes)",
        "shares_line": "{n}. {title} · {kind} · abierto {opens} veces · caduca {expires} · {short}",
        "shares_hint": "Pulsa Revocar, o envía /revoke <primeros 6 caracteres>, para revocar un enlace",
        "shares_untitled": "(sin título)",
        "shares_empty": "No hay enlaces compartidos activos",
        "shares_failed": "⚠️ No se pudieron gestionar los enlaces compartidos: {error}",
        "shares_expired": "⚠️ Este botón ha caducado. Envía /shares de nuevo",
        "revoke_button": "🗑 Revocar {short}",
        "revoked": "✅ Revocado «{title}» ({short})",
        "revoke_none": "Ningún enlace activo empieza por «{prefix}», así que no se revocó nada. Envía /shares para verlos",
        "revoke_ambiguous": "{count} enlaces activos empiezan por «{prefix}», así que no se revocó nada. Escribe más caracteres",
        "revoke_usage": "Uso: /revoke <primeros 6 caracteres del código del enlace>. Envía /shares para ver los códigos",
        "share_created": "🔗 Enlace compartido creado · {kind} · caduca {expires} · {short}",
        "share_masked": "{count} ocultados",
        "share_opened": "👀 «{title}» ({short}) se abrió en un dispositivo nuevo; {opens} aperturas en total",
    },
    "fr-FR": {
        "title": "⚡ Menu rapide · pane «\u00a0{pane}\u00a0»",
        "title_prompts": "💬 Prompts · pane «\u00a0{pane}\u00a0»",
        "title_skills": "🧩 Skills · pane «\u00a0{pane}\u00a0»",
        "title_mcp": "🔌 MCP · pane «\u00a0{pane}\u00a0»",
        "mcp_cli_group": "🔌 Serveurs MCP de {agent} ({count})\u00a0: gérés par la CLI elle-même\u00a0; Navide ne voit ni leur état ni leurs outils",
        "mcp_navide_group": "🧭 Pour Navide ({count})\u00a0: ces serveurs ne sont pas connectés à la CLI du pane",
        "mcp_empty": "Aucun serveur MCP\u00a0: aucun dans la configuration de la CLI de ce pane, et aucun configuré dans Navide",
        "mcp_pick_hint": "Répondez /mcp <numéro> pour les détails",
        "bad_pick_mcp": "⚠️ Ce numéro n’existe pas. Renvoyez /mcp",
        "mcp_expired": "⚠️ Ce menu a expiré. Renvoyez /mcp",
        "mcp_gone": "⚠️ «\u00a0{name}\u00a0» n’existe plus. Renvoyez /mcp",
        "mcp_on": "activé",
        "mcp_off": "désactivé",
        "mcp_valid": "configuration lisible",
        "mcp_invalid": "configuration non comprise",
        "mcp_status_connected": "connecté",
        "mcp_status_starting": "démarrage",
        "mcp_status_error": "erreur",
        "mcp_status_disabled": "désactivé",
        "mcp_timeout": "délai dépassé",
        "mcp_tool_count": "{count} outils",
        "mcp_source": "Source\u00a0: {source}",
        "mcp_tools_title": "Outils ({count})\u00a0:",
        "mcp_no_tools": "Aucun outil",
        "mcp_more": "…et {count} de plus",
        "mcp_cli_note": "Géré par la CLI elle-même\u00a0; Navide ne voit ni son état ni ses outils",
        "mcp_navide_note": "Pour Navide\u00a0; non connecté à la CLI du pane",
        "page": "Page {page}/{pages}",
        "counts": "💬 Prompts {prompts} · 🧩 Skills {skills}",
        "no_skill_syntax": "(Aucune méthode vérifiée pour lancer un skill dans la CLI de ce pane, les Skills ne sont donc pas listés)",
        "prev": "◀ Précédent",
        "next": "Suivant ▶",
        "not_bound": "Ce chat n’est connecté à aucun pane. Connectez-le depuis le bouton de chat du pane dans Navide, puis envoyez /prompts, /skills ou /mcp",
        "no_buttons": "Cette plateforme ne prend pas en charge les boutons, le menu rapide ne peut donc pas s’afficher",
        "empty": "Aucun prompt ni skill à proposer. Ajoutez-en sous Prompts / Skills dans les paramètres de Navide",
        "empty_prompts": "Aucun prompt à proposer. Ajoutez-en sous Prompts dans les paramètres de Navide",
        "empty_skills": "La CLI de ce pane n’a aucun skill à proposer. Ajoutez-en sous Skills dans les paramètres de Navide",
        "expired": "⚠️ Ce menu a expiré. Renvoyez /prompts ou /skills",
        "gone": "⚠️ «\u00a0{name}\u00a0» n’existe plus ou est désactivé. Renvoyez /prompts ou /skills",
        "sent": "▶ Envoyé\u00a0: {name}",
        "pick_hint": "Répondez /menu <numéro> pour en envoyer un",
        "pick_hint_p": "Répondez /prompts <numéro> pour en envoyer un",
        "pick_hint_s": "Répondez /skills <numéro> pour en envoyer un",
        "menu_moved": "⚡ Le menu rapide est désormais réparti en trois commandes\u00a0: utilisez /prompts, /skills ou /mcp",
        "bad_pick": "⚠️ Ce numéro n’existe pas. Renvoyez /prompts ou /skills",
        "send_failed": "⚠️ Impossible d’afficher le menu rapide\u00a0: {error}",
        "shares_title": "🔗 Liens de partage actifs ({count} plus récents)",
        "shares_line": "{n}. {title} · {kind} · ouvert {opens}× · expiration\u00a0: {expires} · {short}",
        "shares_hint": "Appuyez sur Révoquer, ou envoyez /revoke <6 premiers caractères>, pour révoquer un lien",
        "shares_untitled": "(sans titre)",
        "shares_empty": "Aucun lien de partage actif",
        "shares_failed": "⚠️ Impossible de traiter les liens de partage\u00a0: {error}",
        "shares_expired": "⚠️ Ce bouton a expiré. Renvoyez /shares",
        "revoke_button": "🗑 Révoquer {short}",
        "revoked": "✅ «\u00a0{title}\u00a0» révoqué ({short})",
        "revoke_none": "Aucun lien actif ne commence par «\u00a0{prefix}\u00a0», rien n’a donc été révoqué. Envoyez /shares pour les voir",
        "revoke_ambiguous": "{count} liens actifs commencent par «\u00a0{prefix}\u00a0», rien n’a donc été révoqué. Tapez plus de caractères",
        "revoke_usage": "Utilisation\u00a0: /revoke <6 premiers caractères du code du lien>. Envoyez /shares pour voir les codes",
        "share_created": "🔗 Lien de partage créé · {kind} · expiration\u00a0: {expires} · {short}",
        "share_masked": "{count} masqués",
        "share_opened": "👀 «\u00a0{title}\u00a0» ({short}) a été ouvert sur un nouvel appareil, {opens} ouvertures au total",
    },
    "de-DE": {
        "title": "⚡ Schnellmenü · pane „{pane}“",
        "title_prompts": "💬 Prompts · pane „{pane}“",
        "title_skills": "🧩 Skills · pane „{pane}“",
        "title_mcp": "🔌 MCP · pane „{pane}“",
        "mcp_cli_group": "🔌 MCP-Server von {agent} ({count}): von der CLI selbst verwaltet; Navide sieht weder ihren Status noch ihre Tools",
        "mcp_navide_group": "🧭 Für Navide ({count}): Diese Server sind nicht mit der CLI des panes verbunden",
        "mcp_empty": "Keine MCP-Server: keine in der CLI-Konfiguration dieses panes und keine in Navide eingerichtet",
        "mcp_pick_hint": "Antworten Sie mit /mcp <Nummer> für Details",
        "bad_pick_mcp": "⚠️ Diese Nummer gibt es nicht. Senden Sie /mcp erneut",
        "mcp_expired": "⚠️ Dieses Menü ist abgelaufen. Senden Sie /mcp erneut",
        "mcp_gone": "⚠️ „{name}“ existiert nicht mehr. Senden Sie /mcp erneut",
        "mcp_on": "an",
        "mcp_off": "aus",
        "mcp_valid": "Konfiguration lesbar",
        "mcp_invalid": "Konfiguration nicht verstanden",
        "mcp_status_connected": "verbunden",
        "mcp_status_starting": "startet",
        "mcp_status_error": "Fehler",
        "mcp_status_disabled": "deaktiviert",
        "mcp_timeout": "Zeitüberschreitung",
        "mcp_tool_count": "{count} Tools",
        "mcp_source": "Quelle: {source}",
        "mcp_tools_title": "Tools ({count}):",
        "mcp_no_tools": "Keine Tools",
        "mcp_more": "…und {count} weitere",
        "mcp_cli_note": "Von der CLI selbst verwaltet; Navide sieht weder seinen Status noch seine Tools",
        "mcp_navide_note": "Für Navide; nicht mit der CLI des panes verbunden",
        "page": "Seite {page}/{pages}",
        "counts": "💬 Prompts {prompts} · 🧩 Skills {skills}",
        "no_skill_syntax": "(Kein geprüfter Weg, in der CLI dieses panes einen Skill auszuführen, daher werden keine Skills aufgeführt)",
        "prev": "◀ Zurück",
        "next": "Weiter ▶",
        "not_bound": "Dieser Chat ist mit keinem pane verbunden. Verbinden Sie ihn über die Chat-Schaltfläche des panes in Navide und senden Sie dann /prompts, /skills oder /mcp",
        "no_buttons": "Diese Plattform unterstützt keine Schaltflächen, daher kann das Schnellmenü nicht angezeigt werden",
        "empty": "Keine Prompts oder Skills verfügbar. Fügen Sie sie in den Navide-Einstellungen unter Prompts / Skills hinzu",
        "empty_prompts": "Keine Prompts verfügbar. Fügen Sie sie in den Navide-Einstellungen unter Prompts hinzu",
        "empty_skills": "Die CLI dieses panes hat keine Skills verfügbar. Fügen Sie sie in den Navide-Einstellungen unter Skills hinzu",
        "expired": "⚠️ Dieses Menü ist abgelaufen. Senden Sie /prompts oder /skills erneut",
        "gone": "⚠️ „{name}“ existiert nicht mehr oder ist ausgeschaltet. Senden Sie /prompts oder /skills erneut",
        "sent": "▶ Gesendet: {name}",
        "pick_hint": "Antworten Sie mit /menu <Nummer>, um einen Eintrag zu senden",
        "pick_hint_p": "Antworten Sie mit /prompts <Nummer>, um einen Eintrag zu senden",
        "pick_hint_s": "Antworten Sie mit /skills <Nummer>, um einen Eintrag zu senden",
        "menu_moved": "⚡ Das Schnellmenü besteht jetzt aus drei Befehlen: Verwenden Sie /prompts, /skills oder /mcp",
        "bad_pick": "⚠️ Diese Nummer gibt es nicht. Senden Sie /prompts oder /skills erneut",
        "send_failed": "⚠️ Das Schnellmenü konnte nicht angezeigt werden: {error}",
        "shares_title": "🔗 Aktive Freigabelinks (neueste {count})",
        "shares_line": "{n}. {title} · {kind} · {opens}× geöffnet · Ablauf {expires} · {short}",
        "shares_hint": "Tippen Sie auf „Widerrufen“ oder senden Sie /revoke <erste 6 Zeichen>, um einen Link zu widerrufen",
        "shares_untitled": "(ohne Titel)",
        "shares_empty": "Keine aktiven Freigabelinks",
        "shares_failed": "⚠️ Freigabelinks konnten nicht verarbeitet werden: {error}",
        "shares_expired": "⚠️ Diese Schaltfläche ist abgelaufen. Senden Sie /shares erneut",
        "revoke_button": "🗑 Widerrufen {short}",
        "revoked": "✅ „{title}“ ({short}) widerrufen",
        "revoke_none": "Kein aktiver Link beginnt mit „{prefix}“, daher wurde nichts widerrufen. Senden Sie /shares, um sie anzuzeigen",
        "revoke_ambiguous": "{count} aktive Links beginnen mit „{prefix}“, daher wurde nichts widerrufen. Geben Sie mehr Zeichen ein",
        "revoke_usage": "Verwendung: /revoke <erste 6 Zeichen des Link-Codes>. Senden Sie /shares, um die Codes anzuzeigen",
        "share_created": "🔗 Freigabelink erstellt · {kind} · Ablauf {expires} · {short}",
        "share_masked": "{count} maskiert",
        "share_opened": "👀 „{title}“ ({short}) wurde auf einem neuen Gerät geöffnet, insgesamt {opens}-mal geöffnet",
    },
    "pt-BR": {
        "title": "⚡ Menu rápido · pane “{pane}”",
        "title_prompts": "💬 Prompts · pane “{pane}”",
        "title_skills": "🧩 Skills · pane “{pane}”",
        "title_mcp": "🔌 MCP · pane “{pane}”",
        "mcp_cli_group": "🔌 Servidores MCP de {agent} ({count}): gerenciados pela própria CLI; o Navide não vê o status nem as ferramentas deles",
        "mcp_navide_group": "🧭 Para o Navide ({count}): estes servidores não estão conectados à CLI do pane",
        "mcp_empty": "Nenhum servidor MCP: nenhum na configuração da CLI deste pane e nenhum configurado no Navide",
        "mcp_pick_hint": "Responda /mcp <número> para ver os detalhes",
        "bad_pick_mcp": "⚠️ Esse número não existe. Envie /mcp de novo",
        "mcp_expired": "⚠️ Este menu expirou. Envie /mcp de novo",
        "mcp_gone": "⚠️ “{name}” não existe mais. Envie /mcp de novo",
        "mcp_on": "ativado",
        "mcp_off": "desativado",
        "mcp_valid": "configuração legível",
        "mcp_invalid": "configuração não interpretável",
        "mcp_status_connected": "conectado",
        "mcp_status_starting": "iniciando",
        "mcp_status_error": "erro",
        "mcp_status_disabled": "desativado",
        "mcp_timeout": "tempo esgotado",
        "mcp_tool_count": "{count} ferramentas",
        "mcp_source": "Origem: {source}",
        "mcp_tools_title": "Ferramentas ({count}):",
        "mcp_no_tools": "Nenhuma ferramenta",
        "mcp_more": "…e mais {count}",
        "mcp_cli_note": "Gerenciado pela própria CLI; o Navide não vê o status nem as ferramentas dele",
        "mcp_navide_note": "Para o Navide; não está conectado à CLI do pane",
        "page": "Página {page}/{pages}",
        "counts": "💬 Prompts {prompts} · 🧩 Skills {skills}",
        "no_skill_syntax": "(Não há uma forma verificada de executar uma skill na CLI deste pane, então as Skills não são listadas)",
        "prev": "◀ Anterior",
        "next": "Próxima ▶",
        "not_bound": "Este chat não está conectado a um pane. Conecte-o pelo botão de chat do pane no Navide e depois envie /prompts, /skills ou /mcp",
        "no_buttons": "Esta plataforma não tem botões, então o menu rápido não pode ser exibido",
        "empty": "Nenhum prompt ou skill disponível. Adicione-os em Prompts / Skills, nas configurações do Navide",
        "empty_prompts": "Nenhum prompt disponível. Adicione-os em Prompts, nas configurações do Navide",
        "empty_skills": "A CLI deste pane não tem skills disponíveis. Adicione-as em Skills, nas configurações do Navide",
        "expired": "⚠️ Este menu expirou. Envie /prompts ou /skills de novo",
        "gone": "⚠️ “{name}” não existe mais ou está desativado. Envie /prompts ou /skills de novo",
        "sent": "▶ Enviado: {name}",
        "pick_hint": "Responda /menu <número> para enviar um",
        "pick_hint_p": "Responda /prompts <número> para enviar um",
        "pick_hint_s": "Responda /skills <número> para enviar uma",
        "menu_moved": "⚡ O menu rápido agora são três comandos: use /prompts, /skills ou /mcp",
        "bad_pick": "⚠️ Esse número não existe. Envie /prompts ou /skills de novo",
        "send_failed": "⚠️ Não foi possível exibir o menu rápido: {error}",
        "shares_title": "🔗 Links de compartilhamento ativos (os {count} mais recentes)",
        "shares_line": "{n}. {title} · {kind} · aberto {opens} vezes · expira {expires} · {short}",
        "shares_hint": "Toque em Revogar, ou envie /revoke <6 primeiros caracteres>, para revogar um link",
        "shares_untitled": "(sem título)",
        "shares_empty": "Nenhum link de compartilhamento ativo",
        "shares_failed": "⚠️ Não foi possível processar os links de compartilhamento: {error}",
        "shares_expired": "⚠️ Este botão expirou. Envie /shares de novo",
        "revoke_button": "🗑 Revogar {short}",
        "revoked": "✅ “{title}” revogado ({short})",
        "revoke_none": "Nenhum link ativo começa com “{prefix}”, então nada foi revogado. Envie /shares para vê-los",
        "revoke_ambiguous": "{count} links ativos começam com “{prefix}”, então nada foi revogado. Digite mais caracteres",
        "revoke_usage": "Uso: /revoke <6 primeiros caracteres do código do link>. Envie /shares para ver os códigos",
        "share_created": "🔗 Link de compartilhamento criado · {kind} · expira {expires} · {short}",
        "share_masked": "{count} mascarados",
        "share_opened": "👀 “{title}” ({short}) foi aberto em um novo dispositivo; {opens} aberturas no total",
    },
    "ru-RU": {
        "title": "⚡ Быстрое меню · pane «{pane}»",
        "title_prompts": "💬 Промпты · pane «{pane}»",
        "title_skills": "🧩 Skills · pane «{pane}»",
        "title_mcp": "🔌 MCP · pane «{pane}»",
        "mcp_cli_group": "🔌 Серверы MCP {agent} ({count}): ими управляет сама CLI; Navide не видит их состояние и инструменты",
        "mcp_navide_group": "🧭 Для Navide ({count}): эти серверы не подключены к CLI pane",
        "mcp_empty": "Серверов MCP нет: их нет ни в конфигурации CLI этого pane, ни в настройках Navide",
        "mcp_pick_hint": "Ответьте /mcp <номер>, чтобы увидеть подробности",
        "bad_pick_mcp": "⚠️ Такого номера нет. Отправьте /mcp ещё раз",
        "mcp_expired": "⚠️ Это меню устарело. Отправьте /mcp ещё раз",
        "mcp_gone": "⚠️ «{name}» больше не существует. Отправьте /mcp ещё раз",
        "mcp_on": "вкл.",
        "mcp_off": "выкл.",
        "mcp_valid": "конфигурация читается",
        "mcp_invalid": "конфигурация не распознана",
        "mcp_status_connected": "подключён",
        "mcp_status_starting": "запускается",
        "mcp_status_error": "ошибка",
        "mcp_status_disabled": "отключён",
        "mcp_timeout": "время ожидания истекло",
        "mcp_tool_count": "инструментов: {count}",
        "mcp_source": "Источник: {source}",
        "mcp_tools_title": "Инструменты ({count}):",
        "mcp_no_tools": "Нет инструментов",
        "mcp_more": "…и ещё {count}",
        "mcp_cli_note": "Управляется самой CLI; Navide не видит его состояние и инструменты",
        "mcp_navide_note": "Для Navide; не подключён к CLI pane",
        "page": "Страница {page}/{pages}",
        "counts": "💬 Промпты: {prompts} · 🧩 Skills: {skills}",
        "no_skill_syntax": "(Для CLI этого pane нет проверенного способа запускать skill, поэтому Skills не показаны)",
        "prev": "◀ Назад",
        "next": "Далее ▶",
        "not_bound": "Этот чат не подключён к pane. Подключите его кнопкой чата pane в Navide, затем отправьте /prompts, /skills или /mcp",
        "no_buttons": "На этой платформе нет кнопок, поэтому быстрое меню показать нельзя",
        "empty": "Нет промптов или skills для выбора. Добавьте их в настройках Navide в разделах «Промпты» и «Skills»",
        "empty_prompts": "Нет промптов для выбора. Добавьте их в настройках Navide в разделе «Промпты»",
        "empty_skills": "У CLI этого pane нет skills для выбора. Добавьте их в настройках Navide в разделе «Skills»",
        "expired": "⚠️ Это меню устарело. Отправьте /prompts или /skills ещё раз",
        "gone": "⚠️ Элемент «{name}» больше не существует или отключён. Отправьте /prompts или /skills ещё раз",
        "sent": "▶ Отправлено: {name}",
        "pick_hint": "Ответьте /menu <номер>, чтобы отправить",
        "pick_hint_p": "Ответьте /prompts <номер>, чтобы отправить",
        "pick_hint_s": "Ответьте /skills <номер>, чтобы отправить",
        "menu_moved": "⚡ Быстрое меню теперь разделено на три команды: используйте /prompts, /skills или /mcp",
        "bad_pick": "⚠️ Такого номера нет. Отправьте /prompts или /skills ещё раз",
        "send_failed": "⚠️ Не удалось показать быстрое меню: {error}",
        "shares_title": "🔗 Действующие ссылки для общего доступа (последние {count})",
        "shares_line": "{n}. {title} · {kind} · открыта {opens} раз · истекает {expires} · {short}",
        "shares_hint": "Чтобы отозвать ссылку, нажмите «Отозвать» или отправьте /revoke <первые 6 символов>",
        "shares_untitled": "(без названия)",
        "shares_empty": "Действующих ссылок для общего доступа нет",
        "shares_failed": "⚠️ Не удалось обработать ссылки для общего доступа: {error}",
        "shares_expired": "⚠️ Эта кнопка устарела. Отправьте /shares ещё раз",
        "revoke_button": "🗑 Отозвать {short}",
        "revoked": "✅ Ссылка «{title}» ({short}) отозвана",
        "revoke_none": "Нет действующей ссылки, начинающейся с «{prefix}», поэтому ничего не отозвано. Отправьте /shares, чтобы их увидеть",
        "revoke_ambiguous": "С «{prefix}» начинается несколько действующих ссылок ({count}), поэтому ничего не отозвано. Введите больше символов",
        "revoke_usage": "Использование: /revoke <первые 6 символов кода ссылки>. Отправьте /shares, чтобы увидеть коды",
        "share_created": "🔗 Ссылка для общего доступа создана · {kind} · истекает {expires} · {short}",
        "share_masked": "скрыто: {count}",
        "share_opened": "👀 Ссылку «{title}» ({short}) открыли на новом устройстве; всего открытий: {opens}",
    },
    "vi-VN": {
        "title": "⚡ Menu nhanh · pane “{pane}”",
        "title_prompts": "💬 Prompt · pane “{pane}”",
        "title_skills": "🧩 Skill · pane “{pane}”",
        "title_mcp": "🔌 MCP · pane “{pane}”",
        "mcp_cli_group": "🔌 Máy chủ MCP của {agent} ({count}): do chính CLI quản lý; Navide không thấy trạng thái hay công cụ của chúng",
        "mcp_navide_group": "🧭 Dành cho Navide ({count}): các máy chủ này không được kết nối với CLI của pane",
        "mcp_empty": "Không có máy chủ MCP: cấu hình CLI của pane này không có, và Navide cũng chưa thiết lập máy chủ nào",
        "mcp_pick_hint": "Trả lời /mcp <số> để xem chi tiết",
        "bad_pick_mcp": "⚠️ Không có số này. Hãy gửi lại /mcp",
        "mcp_expired": "⚠️ Menu này đã hết hạn. Hãy gửi lại /mcp",
        "mcp_gone": "⚠️ “{name}” không còn tồn tại. Hãy gửi lại /mcp",
        "mcp_on": "bật",
        "mcp_off": "tắt",
        "mcp_valid": "cấu hình đọc được",
        "mcp_invalid": "không hiểu được cấu hình",
        "mcp_status_connected": "đã kết nối",
        "mcp_status_starting": "đang khởi động",
        "mcp_status_error": "lỗi",
        "mcp_status_disabled": "đã tắt",
        "mcp_timeout": "hết thời gian chờ",
        "mcp_tool_count": "{count} công cụ",
        "mcp_source": "Nguồn: {source}",
        "mcp_tools_title": "Công cụ ({count}):",
        "mcp_no_tools": "Không có công cụ",
        "mcp_more": "…và còn {count} nữa",
        "mcp_cli_note": "Do chính CLI quản lý; Navide không thấy trạng thái hay công cụ của nó",
        "mcp_navide_note": "Dành cho Navide; không được kết nối với CLI của pane",
        "page": "Trang {page}/{pages}",
        "counts": "💬 Prompt {prompts} · 🧩 Skill {skills}",
        "no_skill_syntax": "(CLI của pane này chưa có cách gọi skill đã được kiểm chứng, nên không liệt kê Skill)",
        "prev": "◀ Trước",
        "next": "Tiếp ▶",
        "not_bound": "Cuộc trò chuyện này chưa được kết nối với pane. Hãy kết nối bằng nút trò chuyện của pane trong Navide, rồi gửi /prompts, /skills hoặc /mcp",
        "no_buttons": "Nền tảng này không có nút bấm, nên không thể hiển thị menu nhanh",
        "empty": "Không có prompt hay skill nào để chọn. Hãy thêm trong mục Prompt / Skill ở cài đặt Navide",
        "empty_prompts": "Không có prompt nào để chọn. Hãy thêm trong mục Prompt ở cài đặt Navide",
        "empty_skills": "CLI của pane này không có skill nào để chọn. Hãy thêm trong mục Skill ở cài đặt Navide",
        "expired": "⚠️ Menu này đã hết hạn. Hãy gửi lại /prompts hoặc /skills",
        "gone": "⚠️ “{name}” không còn tồn tại hoặc đã bị tắt. Hãy gửi lại /prompts hoặc /skills",
        "sent": "▶ Đã gửi: {name}",
        "pick_hint": "Trả lời /menu <số> để gửi một mục",
        "pick_hint_p": "Trả lời /prompts <số> để gửi một mục",
        "pick_hint_s": "Trả lời /skills <số> để gửi một mục",
        "menu_moved": "⚡ Menu nhanh giờ được tách thành ba lệnh: hãy dùng /prompts, /skills hoặc /mcp",
        "bad_pick": "⚠️ Không có số này. Hãy gửi lại /prompts hoặc /skills",
        "send_failed": "⚠️ Không thể hiển thị menu nhanh: {error}",
        "shares_title": "🔗 Liên kết chia sẻ đang hiệu lực ({count} mới nhất)",
        "shares_line": "{n}. {title} · {kind} · đã mở {opens} lần · hết hạn {expires} · {short}",
        "shares_hint": "Nhấn Thu hồi, hoặc gửi /revoke <6 ký tự đầu>, để thu hồi một liên kết",
        "shares_untitled": "(không có tiêu đề)",
        "shares_empty": "Không có liên kết chia sẻ nào đang hiệu lực",
        "shares_failed": "⚠️ Không thể xử lý liên kết chia sẻ: {error}",
        "shares_expired": "⚠️ Nút này đã hết hạn. Hãy gửi lại /shares",
        "revoke_button": "🗑 Thu hồi {short}",
        "revoked": "✅ Đã thu hồi “{title}” ({short})",
        "revoke_none": "Không có liên kết đang hiệu lực nào bắt đầu bằng “{prefix}”, nên không thu hồi gì. Gửi /shares để xem các liên kết",
        "revoke_ambiguous": "Có {count} liên kết đang hiệu lực bắt đầu bằng “{prefix}”, nên không thu hồi gì. Hãy gõ thêm ký tự",
        "revoke_usage": "Cách dùng: /revoke <6 ký tự đầu của mã liên kết>. Gửi /shares để xem các mã",
        "share_created": "🔗 Đã tạo liên kết chia sẻ · {kind} · hết hạn {expires} · {short}",
        "share_masked": "đã che {count} chỗ",
        "share_opened": "👀 “{title}” ({short}) đã được mở trên một thiết bị mới, tổng cộng {opens} lượt mở",
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
