"""Email the registry admin when an item enters a review queue.

One plain-text email per item, sent through Amazon SES with the host's
instance role (boto3 picks the role up from instance metadata, so no key is
configured anywhere). The email carries only the kind, the package id, the
submission time and the admin page link. One daemon worker sends from a
bounded queue after the submission committed; the same item is emailed at
most once an hour, a full queue drops the email, and a failure is logged and
never reaches the submitter or the review itself.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from .config import Settings

_log = logging.getLogger(__name__)

VERSION = "version"
TESTPLACE_CODE = "testplace_code"
PROMOTION = "promotion"
DEVELOPER = "developer"

# kind -> (label, admin page path)
KINDS: dict[str, tuple[str, str]] = {
    VERSION: ("listing version", "/admin/review"),
    TESTPLACE_CODE: ("Testplace public code", "/admin/testplace"),
    PROMOTION: ("Testplace promotion", "/admin/testplace"),
    DEVELOPER: ("developer application", "/admin/developers"),
}

_TAIPEI = timezone(timedelta(hours=8))
REPEAT_WINDOW_SECONDS = 3600
QUEUE_SIZE = 100

Sender = Callable[[str, str, str, str], None]
"""(from, to, subject, body) -> None; raises on failure."""


class ReviewNotifier:
    def __init__(self, *, to: str, sender_address: str, admin_base: str, send: Sender) -> None:
        self.to = to
        self.sender_address = sender_address
        self.admin_base = admin_base
        self._send = send
        self._queue: queue.Queue[tuple[str, str, datetime | None]] = queue.Queue(maxsize=QUEUE_SIZE)
        self._recent: dict[tuple[str, str], float] = {}
        self._lock = threading.Lock()
        self._worker: threading.Thread | None = None

    def pending(self, kind: str, item: str, submitted_at: datetime | None = None) -> bool:
        """Queue the email for one item now waiting for review. False when it
        was skipped: the same item was emailed within the hour, or the queue is full."""
        now = time.monotonic()
        with self._lock:
            self._recent = {k: t for k, t in self._recent.items() if now - t < REPEAT_WINDOW_SECONDS}
            # Applications carry no per-applicant id (one pending per account
            # already bounds them), so only the other kinds are de-duplicated.
            if kind != DEVELOPER and (kind, item) in self._recent:
                return False
            try:
                self._queue.put_nowait((kind, item, submitted_at))
            except queue.Full:
                _log.warning("review notify dropped: queue full, kind=%s item=%s", kind, item)
                return False
            self._recent[(kind, item)] = now
            if self._worker is None:
                self._worker = threading.Thread(target=self._run, name="review-notify", daemon=True)
                self._worker.start()
        return True

    def _run(self) -> None:
        while True:
            kind, item, submitted_at = self._queue.get()
            self.send_now(kind, item, submitted_at)

    def send_now(self, kind: str, item: str, submitted_at: datetime | None = None) -> bool:
        try:
            subject, body = self.message(kind, item, submitted_at)
            self._send(self.sender_address, self.to, subject, body)
            return True
        except Exception as exc:  # never let the email affect the submission
            _log.warning("review notify failed: kind=%s item=%s error=%s", kind, item, _error_code(exc))
            return False

    def message(self, kind: str, item: str, submitted_at: datetime | None) -> tuple[str, str]:
        label, path = KINDS[kind]
        item = "".join(ch for ch in item if ch.isprintable())[:200]
        at = submitted_at or datetime.now(timezone.utc)
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        subject = f"[Navide Registry] Pending review: {label} {item}"
        body = "\n".join(
            [
                f"A {label} is waiting for review.",
                "",
                f"Item: {item}",
                f"Submitted: {at.astimezone(timezone.utc):%Y-%m-%d %H:%M} UTC"
                f" ({at.astimezone(_TAIPEI):%Y-%m-%d %H:%M} Taipei)",
                f"Review: {self.admin_base}{path}",
                "",
            ]
        )
        return subject, body


def _error_code(exc: Exception) -> str:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        code = response.get("Error", {}).get("Code")
        if code:
            return str(code)
    return type(exc).__name__


def ses_sender(region: str) -> Sender:
    client = None
    lock = threading.Lock()

    def send(sender_address: str, to: str, subject: str, body: str) -> None:
        nonlocal client
        with lock:
            if client is None:
                import boto3  # only loaded when the email is configured

                client = boto3.client("sesv2", region_name=region)
        client.send_email(
            FromEmailAddress=sender_address,
            Destination={"ToAddresses": [to]},
            Content={
                "Simple": {
                    "Subject": {"Data": subject, "Charset": "UTF-8"},
                    "Body": {"Text": {"Data": body, "Charset": "UTF-8"}},
                }
            },
        )

    return send


def from_settings(settings: Settings, send: Sender | None = None) -> ReviewNotifier | None:
    if not settings.review_notify_enabled:
        return None
    assert settings.review_notify_from is not None and settings.ses_region is not None
    # The console host serves admin pages at its root; a single-host registry
    # serves them under root_path (no absolute origin is known there).
    admin_base = settings.developer_origin or settings.root_path
    return ReviewNotifier(
        to=settings.review_notify_to,
        sender_address=settings.review_notify_from,
        admin_base=admin_base,
        send=send or ses_sender(settings.ses_region),
    )


def notify(request: object, kind: str, item: str) -> None:
    """Email the admin about one new pending item, if the email is configured."""
    notifier = getattr(request.app.state.registry, "review_notifier", None)  # type: ignore[attr-defined]
    if notifier is not None:
        notifier.pending(kind, item)
