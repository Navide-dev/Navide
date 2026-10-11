"""``/shares`` and ``/revoke <prefix>`` in a bound chat: the account's live share links,
and revoking one of them. Also the two share-link notices (``notify_link_created``,
``notify_link_opened``) that the rest of the backend calls.

Only what ``share_links.list_links`` returns is shown, which never holds a link's
URL or key; ``copy_link`` is never called from a chat. A link is named by the first
``SHORT_LEN`` characters of its id.

A revoke button's callback data is ``nv3:r:<token>``, the token a short random key
into this table (like ``quick_menu``'s), so the full link id never rides in a
button. Tokens are memory only and die after ``quick_menu.MENU_TTL_S``.
"""

from __future__ import annotations

import functools
import logging
import re
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from . import quick_menu, report

log = logging.getLogger(__name__)

CALLBACK_PREFIX = "nv3:"
SHORT_LEN = 6
MAX_LISTED = 10
MAX_TOKENS = 2000

_CALLBACK_RE = re.compile(
    rf"^nv3:r:([{quick_menu.TOKEN_ALPHABET}]{{{quick_menu.TOKEN_LENGTH}}})$")
# A share link (share_links.link_url) in whatever shape a reply gives it: any case, with
# or without a scheme, percent-encoded or JSON-escaped, a full-width colon, and a line
# break or zero-width character anywhere inside the id or the key. Linear: the classes
# a quantifier repeats never overlap with what may follow them.
_BRK = "[\\r\\n\u200b\u200c\u200d\u2060\ufeff]"
_SL = r"(?:/|\\/|%2f)"
_HASH, _AMP, _EQ = r"(?:#|%23)", r"(?:&|%26)", r"(?:=|%3d)"
_SCHEME = rf"(?:https?(?::|\uff1a|%3a){_SL}{_SL})?"
# The id runs until something that cannot be part of it: a break followed by more id
# characters still counts, so an id cut by a line break is caught whole.
_ID = (rf"(?:{_BRK}*[A-Za-z0-9_-]){{22,64}}?"
       rf"(?={_BRK}*(?:[^A-Za-z0-9_\-\r\n\u200b\u200c\u200d\u2060\ufeff]|\Z))")
_KEY = rf"{_HASH}(?:[^\s#]*?{_AMP})?k{_EQ}(?:{_BRK}*[A-Za-z0-9_-]){{0,43}}"
# share.navide.dev links always; another host's /s/<id> only with the key after it.
_LINK_RE = re.compile(
    rf"({_SCHEME}share\.navide\.dev{_SL}s{_SL})({_ID})(?:{_BRK}*{_KEY})?"
    rf"|({_SCHEME}[a-z0-9.-]{{1,253}}{_SL}s{_SL})({_ID}){_BRK}*{_KEY}", re.IGNORECASE)
# A key on its own after a #k= / &k= marker, wherever it stands.
_KEY_RE = re.compile(rf"(?:{_HASH}|{_AMP})k{_EQ}(?:{_BRK}*[A-Za-z0-9_-]){{43}}", re.IGNORECASE)


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


def _cut_link(m: re.Match[str]) -> str:
    prefix, link_id = (m.group(1), m.group(2)) if m.group(1) is not None else (m.group(3), m.group(4))
    return prefix + re.sub(_BRK, "", link_id)[:SHORT_LEN] + "…"


@functools.lru_cache(maxsize=4)
def _known_keys_re(keys: tuple[str, ...]) -> re.Pattern[str] | None:
    """The keys this process built, each allowed a break between any two characters."""
    if not keys:
        return None
    return re.compile("|".join(f"{_BRK}*".join(map(re.escape, key)) for key in keys))


def mask_links(text: str) -> str:
    """``text`` with every share link cut to its first characters and every key dropped,
    for anywhere but a known direct chat (and for logs): a link in any shape, a key after a
    ``#k=`` marker anywhere, and any key this process built, even written on its own."""
    from .. import share_links

    text = _LINK_RE.sub(_cut_link, text)
    text = _KEY_RE.sub("…", text)
    known = _known_keys_re(share_links.known_key_fragments())
    return known.sub("…", text) if known is not None else text


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


# --- notices ---------------------------------------------------------------------------
#
# A notice only ever goes to a bound direct chat: the one the creator picked, else the
# one bound to the pane that created the link; with neither, nobody is told. Nothing
# is sent unless Navide Cloud is connected and chat channels are on, so with no share
# links (or no Cloud) chat behaves as before.
#
# "Direct" is the kind a chat was remembered with, which each adapter decides. Known
# trade-off: Matrix has no reliable direct flag on a joined room, so it counts a room
# with exactly two joined members as direct (matrix.py). A two-member room is then
# treated as private: it can be picked, gets notices and sees share links whole.


def created_text(lang: str, link: dict[str, Any]) -> str:
    summary = quick_menu.text(lang, "share_created", kind=link.get("kind") or "",
                              expires=_when(link.get("expiresAt")), short=short(link))
    masked = int(link.get("maskedTotal") or 0)
    if masked:
        summary += " · " + quick_menu.text(lang, "share_masked", count=masked)
    return report.Caption(title(lang, link), summary, str(link.get("url") or "")).plain()


def opened_text(lang: str, link: dict[str, Any], opens: int) -> str:
    return quick_menu.text(lang, "share_opened", title=title(lang, link), short=short(link), opens=opens)


def _running_manager() -> Any:
    """The chat manager when a notice may go out at all, else None."""
    from .. import server_link
    from . import get_manager

    if server_link.link_state() != server_link.STATE_CONNECTED:
        return None
    manager = get_manager()
    return manager if manager is not None and manager.store.global_enabled() else None


async def notify_link_created(link: dict[str, Any]) -> None:
    """A link this machine just made, which its creator asked to have sent to chat."""
    try:
        manager = _running_manager()
        if manager is not None:
            await manager.notify_share_created(link)
    except Exception as exc:  # noqa: BLE001 — a notice must not break creating the link
        log.warning("channels: the share-link created notice failed: %s", mask_links(str(exc)))


async def notify_link_opened(event: dict[str, Any]) -> None:
    """``links.opened`` as the server pushed it: {linkId, openCount, openedAt, newViewer}."""
    try:
        manager = _running_manager()
        if manager is not None:
            await manager.notify_share_opened(event)
    except Exception as exc:  # noqa: BLE001 — a notice must not break the link
        log.warning("channels: the share-link opened notice failed: %s", mask_links(str(exc)))
