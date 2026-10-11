"""``/shares`` and ``/revoke <prefix>`` in a bound chat: the account's live share links,
and revoking one of them.

Only what ``share_links.list_links`` returns is shown, which never holds a link's
URL or key; ``copy_link`` is never called from a chat. A link is named by the first
``SHORT_LEN`` characters of its id.

A revoke button's callback data is ``nv3:r:<token>``, the token a short random key
into this table (like ``quick_menu``'s), so the full link id never rides in a
button. Tokens are memory only and die after ``quick_menu.MENU_TTL_S``.
"""

from __future__ import annotations

import re
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from . import quick_menu

CALLBACK_PREFIX = "nv3:"
SHORT_LEN = 6
MAX_LISTED = 10
MAX_TOKENS = 2000

_CALLBACK_RE = re.compile(
    rf"^nv3:r:([{quick_menu.TOKEN_ALPHABET}]{{{quick_menu.TOKEN_LENGTH}}})$")


def parse_command(body: str, identity: str = "") -> tuple[str, str] | None:
    """``("shares", "")`` or ``("revoke", <argument>)``, optionally ``@bot``-addressed or
    after a leading Slack/Discord mention; None for anything else, or for a command
    addressed to another bot."""
    rest = quick_menu._MENTION_RE.sub("", (body or "").strip()).strip()
    if not rest.startswith("/"):
        return None
    head, _, arg = rest.partition(" ")
    head, _, bot = head.partition("@")
    if bot and identity and bot.lower() != identity.lstrip("@").lower():
        return None
    head, arg = head.lower(), arg.strip()
    if head == "/shares" and not arg:
        return ("shares", "")
    if head == "/revoke":
        return ("revoke", arg)
    return None


def parse_callback(data: str) -> str | None:
    m = _CALLBACK_RE.match(data or "")
    return m.group(1) if m else None


def valid_prefix(arg: str) -> bool:
    return len(arg) >= SHORT_LEN and not any(c.isspace() for c in arg)


def active(links: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The live links, newest first."""
    live = [link for link in links if link.get("active")]
    return sorted(live, key=lambda link: str(link.get("createdAt") or ""), reverse=True)


def short(link: dict[str, Any]) -> str:
    return str(link.get("linkId") or "")[:SHORT_LEN]


def title(lang: str, link: dict[str, Any]) -> str:
    return " ".join(str(link.get("title") or "").split()) or quick_menu.text(lang, "shares_untitled")


def _when(value: Any) -> str:
    raw = str(value or "")
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return raw or "—"


def render_list(lang: str, links: list[dict[str, Any]]) -> str:
    """The message for ``/shares``; ``links`` already filtered and cut to ``MAX_LISTED``."""
    lines = [quick_menu.text(lang, "shares_title", count=len(links))]
    for i, link in enumerate(links, 1):
        lines.append(quick_menu.text(
            lang, "shares_line", n=i, title=title(lang, link), kind=link.get("kind") or "",
            opens=int(link.get("openCount") or 0), expires=_when(link.get("expiresAt")), short=short(link)))
    lines.append(quick_menu.text(lang, "shares_hint"))
    return "\n".join(lines)


@dataclass
class _Token:
    location_key: str
    link_id: str
    created: float


@dataclass
class RevokeButtons:
    clock: Callable[[], float] = time.monotonic
    _tokens: dict[str, _Token] = field(default_factory=dict)

    def rows(self, platform: str, location_key: str, lang: str,
             links: list[dict[str, Any]]) -> list[list[tuple[str, str]]]:
        layout = quick_menu.LAYOUTS.get(platform, quick_menu.DEFAULT_LAYOUT)
        self._prune()
        buttons = [(quick_menu._clip(quick_menu.text(lang, "revoke_button", short=short(link)), layout.label_max),
                    CALLBACK_PREFIX + "r:" + self._mint(location_key, str(link["linkId"])))
                   for link in links]
        return [buttons[i:i + layout.per_row] for i in range(0, len(buttons), layout.per_row)]

    def press(self, token: str, location_key: str) -> str | None:
        """The link id ``token`` stands for, pressed in ``location_key``; None once expired."""
        entry = self._tokens.get(token)
        if entry is None or entry.location_key != location_key:
            return None
        if self.clock() - entry.created > quick_menu.MENU_TTL_S:
            del self._tokens[token]
            return None
        return entry.link_id

    def _mint(self, location_key: str, link_id: str) -> str:
        while True:
            token = "".join(secrets.choice(quick_menu.TOKEN_ALPHABET) for _ in range(quick_menu.TOKEN_LENGTH))
            if token not in self._tokens:
                break
        self._tokens[token] = _Token(location_key, link_id, self.clock())
        return token

    def _prune(self) -> None:
        now = self.clock()
        for token in [t for t, e in self._tokens.items() if now - e.created > quick_menu.MENU_TTL_S]:
            del self._tokens[token]
        while len(self._tokens) >= MAX_TOKENS:
            del self._tokens[next(iter(self._tokens))]
