"""Keep chat-platform credentials out of logs without touching log levels.

httpx logs every request URL at INFO, and the Telegram Bot API puts the token
in the URL (``/bot<token>/method``). A filter on the ``httpx`` logger rewrites
that segment, plus any registered secret substring, before the record is
emitted.
"""

from __future__ import annotations

import logging
import re

_BOT_SEGMENT_RE = re.compile(r"/bot[^/\s\"']+/")
REDACTED = "<redacted>"
MIN_SECRET_LEN = 8


class SecretRedactFilter(logging.Filter):
    def __init__(self) -> None:
        super().__init__()
        self._secrets: set[str] = set()

    def add_secret(self, secret: str) -> None:
        if isinstance(secret, str) and len(secret) >= MIN_SECRET_LEN:
            self._secrets.add(secret)

    def redact(self, text: str) -> str:
        text = _BOT_SEGMENT_RE.sub(f"/bot{REDACTED}/", text)
        for secret in self._secrets:
            if secret in text:
                text = text.replace(secret, REDACTED)
        return text

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 — a malformed record is not ours to break
            return True
        redacted = self.redact(message)
        if redacted != message:
            record.msg = redacted
            record.args = None
        return True


_filter = SecretRedactFilter()


def install(logger_name: str = "httpx") -> SecretRedactFilter:
    """Attach the shared filter once; the logger's level is left untouched."""
    logger = logging.getLogger(logger_name)
    if _filter not in logger.filters:
        logger.addFilter(_filter)
    return _filter


def add_secret(secret: str) -> None:
    _filter.add_secret(secret)


def redact_text(text: str) -> str:
    """``text`` with every registered secret (and bot-token URL segment) masked."""
    return _filter.redact(text)


_EMAIL_RE = re.compile(r"(?<![\w.%+-])([A-Za-z0-9])[A-Za-z0-9._%+-]*@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})")


def mask_emails(text: str) -> str:
    """``text`` with each email address cut to its first character and its
    domain (``r***@example.com``), for text pushed to a chat."""
    return _EMAIL_RE.sub(r"\1***@\2", text)
