"""Sender gate: pairing codes and the per-bot allowlist.

Two layers (OpenClaw): the chat id says *where* a pane lives, the sender id says
*who* may talk to it. Only the sender id is gated here; group membership never
grants access. An unknown sender in a DM gets a pairing code the user approves
in Settings; an unknown sender in a group is dropped silently. Each bot
(platform, account) has its own list: approving a sender on one bot admits
them there only.

Codes: 8 chars from an alphabet without look-alikes, ``secrets`` module,
expire after an hour, at most 3 pending per bot.
"""

from __future__ import annotations

import re
import secrets
import time
from dataclasses import dataclass

from .store import DEFAULT_ACCOUNT, ChannelStore, PairingRequest

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
CODE_TTL_S = 3600
MAX_PENDING = 3
INVITE_TTL_S = 600
MAX_LIVE_INVITES = 5


def new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def normalize_code(code: str) -> str:
    return "".join(ch for ch in (code or "").upper() if ch.isalnum())


@dataclass
class PairingOutcome:
    """Result of an unknown DM sender knocking."""

    request: PairingRequest | None
    created: bool  # False: an existing pending code was reused
    full: bool = False  # True: the bot already has MAX_PENDING pending codes


class SenderGate:
    def __init__(self, store: ChannelStore, *, now=time.time) -> None:
        self._store = store
        self._now = now

    def is_allowed(self, platform: str, sender_id: str, account: str = DEFAULT_ACCOUNT) -> bool:
        return bool(sender_id) and self._store.is_allowed(platform, sender_id, account)

    def has_linked(self, platform: str, account: str = DEFAULT_ACCOUNT) -> bool:
        """Whether any user is linked to (allowed on) this bot."""
        return any(r["account"] == account for r in self._store.list_allow(platform))

    def prune(self) -> None:
        self._store.delete_pairing_older_than(self._now() - CODE_TTL_S)

    def request_pairing(self, platform: str, sender_id: str, sender_name: str, chat_id: str,
                        account: str = DEFAULT_ACCOUNT) -> PairingOutcome:
        self.prune()
        pending = self._store.list_pairing(platform, account)
        for req in pending:
            if req.sender_id == sender_id:
                return PairingOutcome(req, created=False)
        if len(pending) >= MAX_PENDING:
            return PairingOutcome(None, created=False, full=True)
        existing = {r.code for r in self._store.list_pairing(None)}
        code = new_code()
        while code in existing:
            code = new_code()
        req = PairingRequest(platform, code, sender_id, sender_name, chat_id, int(self._now()), account)
        self._store.add_pairing(req)
        return PairingOutcome(req, created=True)

    def approve(self, platform: str, code: str) -> PairingRequest | None:
        self.prune()
        req = self._store.pop_pairing(platform, normalize_code(code))
        if req is None:
            return None
        self._store.add_allow(platform, req.sender_id, req.sender_name, int(self._now()), req.account)
        return req

    def reject(self, platform: str, code: str) -> PairingRequest | None:
        return self._store.pop_pairing(platform, normalize_code(code))


@dataclass(frozen=True)
class LinkInvite:
    """A one-time code the user sends the bot to link their chat account (no approval step)."""

    platform: str
    code: str
    target: str  # "direct" | "group": which deep link was offered; either chat kind may redeem it
    created_at: float
    account: str = DEFAULT_ACCOUNT  # the bot whose link was offered; only it may redeem the code

    @property
    def expires_at(self) -> float:
        return self.created_at + INVITE_TTL_S


# Slack/Discord put ``<@U123>`` anywhere in the text; Mattermost ``@name``, Matrix
# ``Display Name: `` and DingTalk's stripped mention all sit in front of the command.
_ANGLE_MENTION = re.compile(r"<[@!#][^>]*>")
_LINK_TEXT = re.compile(r"(?:^|\s)(?:/start(?:@\S+)?|link)\s+([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})$", re.IGNORECASE)
_BARE_CODE = re.compile(r"[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}")


def parse_link_code(text: str) -> str:
    """The invite code ending ``/start CODE``, ``/start@bot CODE`` or ``link CODE`` (whatever
    mention precedes it), or a message that is only ``CODE``; "" otherwise."""
    rest = _ANGLE_MENTION.sub(" ", text or "").strip()
    m = _LINK_TEXT.search(rest)
    if m:
        return normalize_code(m.group(1))
    return normalize_code(rest) if _BARE_CODE.fullmatch(rest) else ""


class LinkInvites:
    """In-memory invites, per bot: a backend restart drops them, which only costs a new click."""

    def __init__(self, *, now=time.time) -> None:
        self._now = now
        self._live: dict[tuple[str, str], list[LinkInvite]] = {}

    def _prune(self, platform: str, account: str) -> list[LinkInvite]:
        now = self._now()
        live = [i for i in self._live.get((platform, account), []) if i.expires_at > now]
        self._live[(platform, account)] = live
        return live

    def create(self, platform: str, target: str, account: str = DEFAULT_ACCOUNT) -> LinkInvite:
        live = self._prune(platform, account)
        taken = {i.code for i in live}
        code = new_code()
        while code in taken:
            code = new_code()
        invite = LinkInvite(platform, code, target, self._now(), account)
        # The oldest goes first: a user clicking again must never be locked out for the TTL.
        live.append(invite)
        del live[:-MAX_LIVE_INVITES]
        return invite

    def consume(self, platform: str, code: str, account: str = DEFAULT_ACCOUNT) -> LinkInvite | None:
        code = normalize_code(code)
        live = self._prune(platform, account)
        for i, invite in enumerate(live):
            if code and invite.code == code:
                del live[i]
                return invite
        return None
