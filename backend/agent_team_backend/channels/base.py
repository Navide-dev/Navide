"""Shared types for chat-channel adapters (Telegram, Discord, Slack, ...).

Every adapter implements ``ChannelAdapter``. The manager owns the pipeline
(gate, pairing, bindings, delivery); an adapter only speaks its platform's
wire protocol and turns platform events into ``InboundMessage`` values.

Adapters own their receive loop: ``start()`` spawns an asyncio task and
returns, never blocking the event loop.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, BinaryIO, Callable, Literal, Protocol

if TYPE_CHECKING:
    from .report import Caption

Platform = Literal[
    "telegram", "discord", "slack", "feishu", "dingtalk", "matrix", "mattermost", "imessage"
]
Lifecycle = Literal["stopped", "starting", "ready", "recovering", "blocked"]

# Reconnect policy shared by every adapter (OpenClaw model). The first retry is
# short so a network blip or a wake from sleep recovers in seconds; doubling
# still reaches the cap after eight failures.
RECONNECT_BASE_S = 5.0
RECONNECT_CAP_S = 600.0
RECONNECT_JITTER = 0.2
STALL_WATCHDOG_S = 120.0
RETRY_AFTER_CAP_S = 60.0


@dataclass(frozen=True)
class Location:
    """Where one pane lives on a platform."""

    platform: str
    account: str
    chat_id: str
    thread_id: str = ""
    title: str = ""

    def key(self) -> str:
        return f"{self.platform}:{self.account}:{self.chat_id}:{self.thread_id}"


@dataclass(frozen=True)
class InboundAttachment:
    """A file a chat message carries, not yet downloaded."""

    kind: str  # photo | document | video | audio | voice | animation | video_note | file
    name: str  # as the platform reports it (unsanitized); may be ""
    size: int | None  # bytes, when the platform says
    mime: str
    ref: str  # what the adapter's ``download`` needs (Telegram file_id, a CDN / url_private URL)


@dataclass
class InboundMessage:
    platform: str
    account: str
    chat_id: str
    thread_id: str
    sender_id: str
    sender_name: str
    text: str
    message_id: str
    is_direct: bool
    ts: float
    # Button press payload (permission relay); empty for plain text.
    callback_data: str = ""
    # The platform message id this message replies to ("" when none or unknown).
    reply_to_id: str = ""
    # The replied-to message's text and sender, when the platform's payload carries them
    # ("" otherwise); the manager quotes them above the text it delivers to the pane.
    reply_to_text: str = ""
    reply_to_sender: str = ""
    # Who wrote the replied-to message: only this bot's own messages, the sender's own and
    # allowlisted senders' are quoted, so a reply cannot carry a stranger's text into a pane.
    reply_to_sender_id: str = ""
    reply_to_self: bool = False
    # Files the message carries; the manager downloads them only for an allowed sender.
    attachments: list[InboundAttachment] = field(default_factory=list)

    def location_key(self) -> str:
        return Location(self.platform, self.account, self.chat_id, self.thread_id).key()


@dataclass
class AdapterStatus:
    lifecycle: Lifecycle = "stopped"
    connected: bool = False
    reconnect_attempts: int = 0
    last_error: str = ""
    last_connected_at: float | None = None
    last_inbound_at: float | None = None
    identity: str = ""  # e.g. "@navide_bot"


@dataclass(frozen=True)
class Capabilities:
    threads: bool
    create_location: bool
    edit: bool
    typing: bool
    buttons: bool
    text_limit: int


Emit = Callable[[InboundMessage], Awaitable[None]]


class ChannelAdapter(Protocol):
    platform: str
    capabilities: Capabilities
    status: AdapterStatus

    async def start(self, emit: Emit) -> None: ...

    async def stop(self) -> None: ...

    async def send_text(
        self, loc: Location, text: str, *, buttons: list[tuple[str, str]] | None = None
    ) -> list[str]:
        """Send ``text`` (already chunked or not) and return the message ids."""
        ...

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None:
        """Replace the message with ``text``; any buttons it carried are removed."""
        ...

    async def send_typing(self, loc: Location) -> None: ...

    async def create_location(self, chat_id: str, title: str) -> Location: ...

    def token_fingerprint(self) -> str:
        """sha256 hex of the credential, used by the manager's token lease."""
        ...


ButtonRows = list[list[tuple[str, str]]]  # rows of (label, callback data)


class MenuAdapter(Protocol):
    """Optional, beside ``capabilities.buttons``: buttons laid out in rows (the quick menu)."""

    async def send_menu(self, loc: Location, text: str, rows: ButtonRows) -> str:
        """Send one message carrying ``rows`` and return its id."""
        ...

    async def edit_menu(self, loc: Location, message_id: str, text: str, rows: ButtonRows) -> None:
        """Replace the menu message's text and buttons."""
        ...


class MediaAdapter(Protocol):
    """Optional: an adapter that can fetch a chat's files and send files to it."""

    upload_max_bytes: int  # the platform's documented per-file upload limit

    async def download(self, att: InboundAttachment, dest: Path, max_bytes: int) -> int:
        """Write the file to ``dest`` and return its size; raise ``MediaTooLarge`` past
        ``max_bytes`` (``dest`` is then removed) or ``ChannelSendError`` on failure."""
        ...

    async def send_file(self, loc: Location, fh: BinaryIO, filename: str,
                        caption: "Caption | None" = None) -> list[str]:
        """Post the already-open, already-checked file ``fh`` as ``filename`` with its report
        card ``caption`` and return the message ids (the card's too, when it is a message of
        its own). Read it from ``fh`` only: reopening by path would undo the check."""
        ...


class MediaTooLarge(Exception):
    """A download passed its size cap."""


class ChannelAuthError(Exception):
    """The credential was rejected (401/403/404-on-token). Stop retrying."""


class ChannelSendError(Exception):
    """A send failed. ``retryable`` is true only when the request provably did not go out."""

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


def backoff_delay(attempt: int, rand: float) -> float:
    """Reconnect delay for ``attempt`` (1-based); ``rand`` in [0, 1) supplies jitter."""
    base = min(RECONNECT_BASE_S * (2 ** max(0, attempt - 1)), RECONNECT_CAP_S)
    return base * (1 - RECONNECT_JITTER + 2 * RECONNECT_JITTER * rand)
