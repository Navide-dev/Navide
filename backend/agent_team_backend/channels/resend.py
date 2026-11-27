"""The resend button on a "not delivered to the pane" notice.

The button stands for the text that did not go in, for a while, and only in the
chat it was sent from. Pressing it puts that text back through the ordinary
inbound path — the same binding, gate and pane checks as typing it again — so
the button is a convenience, never a way around any of them.
"""

from __future__ import annotations

import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from . import quick_menu

CALLBACK_PREFIX = "nv7:"
_CALLBACK_RE = re.compile(r"^nv7:([a-z0-9]{8})$")
MAX_TOKENS = 64
BUTTON_LABEL = "🔁 排回佇列"


def parse_callback(data: str) -> str | None:
    m = _CALLBACK_RE.match(data or "")
    return m.group(1) if m else None


@dataclass
class _Entry:
    location_key: str
    text: str
    created: float


@dataclass
class ResendButtons:
    clock: Callable[[], float] = time.monotonic
    _tokens: dict[str, _Entry] = field(default_factory=dict)

    def button(self, location_key: str, text: str) -> tuple[str, str]:
        """(label, callback data) of a button that resends ``text`` in ``location_key``."""
        self._prune()
        while True:
            token = "".join(secrets.choice(quick_menu.TOKEN_ALPHABET) for _ in range(quick_menu.TOKEN_LENGTH))
            if token not in self._tokens:
                break
        self._tokens[token] = _Entry(location_key, text, self.clock())
        return BUTTON_LABEL, CALLBACK_PREFIX + token

    def press(self, token: str, location_key: str) -> str | None:
        """The text to resend, once; None when expired, used or pressed elsewhere."""
        entry = self._tokens.get(token)
        if entry is None or entry.location_key != location_key:
            return None
        del self._tokens[token]
        if self.clock() - entry.created > quick_menu.MENU_TTL_S:
            return None
        return entry.text

    def _prune(self) -> None:
        now = self.clock()
        for token in [t for t, e in self._tokens.items() if now - e.created > quick_menu.MENU_TTL_S]:
            del self._tokens[token]
        while len(self._tokens) >= MAX_TOKENS:
            del self._tokens[next(iter(self._tokens))]
