"""Quick menu: ``/menu`` in a bound chat answers with buttons for the user's prompt skills
(Settings → Prompts) and the CLI skills the bound pane's vendor can be asked to run.

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

_CALLBACK_RE = re.compile(rf"^nv2:([psg]):([{TOKEN_ALPHABET}]{{{TOKEN_LENGTH}}})$")
_MENTION_RE = re.compile(r"^(?:<[@!][^>]*>\s*)+")
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
        "page": "第 {page}/{pages} 頁",
        "counts": "💬 Prompts {prompts} 個 · 🧩 Skills {skills} 個",
        "no_skill_syntax": "（這個 pane 的 CLI 沒有已查證的 skill 呼叫方式，不列出 Skills）",
        "prev": "◀ 上一頁",
        "next": "下一頁 ▶",
        "not_bound": "此聊天室尚未連接 pane；在 Navide 的 pane 聊天按鈕連接後再傳 /menu",
        "no_buttons": "這個平台不支援按鈕，無法顯示快捷選單",
        "empty": "沒有可用的 prompt 或 skill；到 Navide 設定的 Prompts／Skills 新增",
        "expired": "⚠️ 這個選單已過期，請重新傳 /menu",
        "gone": "⚠️「{name}」已不存在或已停用，請重新傳 /menu",
        "sent": "▶ 已送出：{name}",
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
        "share_group_no_link": "群組不顯示完整連結；請在私訊或 Navide 的分享分頁取得",
        "share_opened": "👀「{title}」（{short}）被新的裝置開啟，累計開啟 {opens} 次",
    },
    "en-US": {
        "title": "⚡ Quick menu · pane \"{pane}\"",
        "page": "Page {page}/{pages}",
        "counts": "💬 Prompts {prompts} · 🧩 Skills {skills}",
        "no_skill_syntax": "(No verified way to run a skill in this pane's CLI, so Skills are not listed)",
        "prev": "◀ Previous",
        "next": "Next ▶",
        "not_bound": "This chat is not connected to a pane. Connect it from the pane's chat button in Navide, then send /menu",
        "no_buttons": "This platform has no buttons, so the quick menu cannot be shown",
        "empty": "No prompts or skills to offer. Add them under Prompts / Skills in Navide's settings",
        "expired": "⚠️ This menu has expired. Send /menu again",
        "gone": "⚠️ \"{name}\" no longer exists or is turned off. Send /menu again",
        "sent": "▶ Sent: {name}",
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
        "share_group_no_link": "Full links are not shown in groups. Get it in a direct chat or Navide's Share tab",
        "share_opened": "👀 \"{title}\" ({short}) was opened on a new device, {opens} opens in all",
    },
    "ja-JP": {
        "title": "⚡ クイックメニュー · pane「{pane}」",
        "page": "{page}/{pages} ページ",
        "counts": "💬 Prompts {prompts} 件 · 🧩 Skills {skills} 件",
        "no_skill_syntax": "（この pane の CLI には確認済みの skill 呼び出し方法がないため、Skills は表示しません）",
        "prev": "◀ 前へ",
        "next": "次へ ▶",
        "not_bound": "このチャットは pane に接続されていません。Navide の pane のチャットボタンで接続してから /menu を送ってください",
        "no_buttons": "このプラットフォームはボタンに対応していないため、クイックメニューを表示できません",
        "empty": "使える prompt も skill もありません。Navide の設定の Prompts／Skills で追加してください",
        "expired": "⚠️ このメニューは期限切れです。もう一度 /menu を送ってください",
        "gone": "⚠️「{name}」は存在しないか無効になっています。もう一度 /menu を送ってください",
        "sent": "▶ 送信しました：{name}",
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
        "share_group_no_link": "グループには完全なリンクを表示しません。ダイレクトチャットか Navide の共有タブで取得してください",
        "share_opened": "👀「{title}」（{short}）が新しいデバイスで開かれました。累計 {opens} 回",
    },
}
DEFAULT_LANGUAGE = "zh-TW"


def text(lang: str, key: str, **kw: Any) -> str:
    return STRINGS.get(lang, STRINGS[DEFAULT_LANGUAGE])[key].format(**kw)


def is_menu_command(body: str, identity: str = "") -> bool:
    """``/menu`` or a bare ``/start`` (Telegram's first contact, when it carries no link
    code), optionally ``@bot``-addressed or after a leading Slack/Discord mention. A
    command addressed to another bot (``/menu@other``) is not ours."""
    rest = _MENTION_RE.sub("", (body or "").strip()).strip()
    if not rest.startswith("/") or " " in rest:
        return False
    head, _, bot = rest.partition("@")
    if bot and identity and bot.lower() != identity.lstrip("@").lower():
        return False
    return head.lower() in ("/menu", "/start")


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
    kind: str  # "p" | "s"
    key: str  # prompt skill id | skill name
    label: str


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


@dataclass(frozen=True)
class Press:
    menu: Menu
    kind: str  # "p" | "s" | "g"
    key: str  # prompt id | skill name | page number
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
               agent_key: str, lang: str, prompts: list[dict[str, Any]], skills: list[str]) -> Menu | None:
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
            counts=(len(p_items), len(s_items)), created=self.clock(),
        )
        self._menus[menu.id] = menu
        return menu

    def render(self, menu: Menu, page: int) -> tuple[str, list[list[tuple[str, str]]]]:
        """The message text and button rows for ``page`` (0-based, clamped)."""
        page = max(0, min(page, len(menu.pages) - 1))
        lines = [text(menu.lang, "title", pane=menu.title)]
        if len(menu.pages) > 1:
            lines[0] += "　" + text(menu.lang, "page", page=page + 1, pages=len(menu.pages))
        lines.append(text(menu.lang, "counts", prompts=menu.counts[0], skills=menu.counts[1]))
        if not menu.skills_supported:
            lines.append(text(menu.lang, "no_skill_syntax"))
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
