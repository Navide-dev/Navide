"""Control-plane link to Navide-Server: this machine's pane roster, published.

The backend is the *client* here. It dials out to a Navide-Server the user
configured, authenticates with a long-lived access token, and reports the CLI
panes it knows about so agents on other devices can address them. Nothing
listens for inbound connections — ``/ws`` stays loopback only — so this file
adds no reachable surface beyond one outbound WebSocket.

**One link per backend process, not per workspace.** The backend is the only
process that sees every open workspace at once, and ``agent_messaging._PANES``
is already process-wide, so a single connection carries the roster of all of
them. A per-workspace connection would multiply the server's device rows for
one machine and break the "device" identity the whole addressing scheme rests
on.

Wire protocol (agreed with Navide-Server)::

    request   {id, type, payload}
    response  {id, type: "<type>.result", ok, payload|error}
    event     {type, payload}            server push, no id

**Transient and terminal failures take different paths, on purpose.** A dropped
socket is transient: reconnect with backoff, re-send ``auth.hello`` (the server
upserts on the same deviceId) and re-report the whole roster — the same shape
the renderer already uses when it re-runs ``agent_msg.register`` after a WS
reconnect. A rejected or revoked credential is terminal: the answer cannot
change by asking again, so the link stops for good and says why. Running a
revoked account through the reconnect backoff would knock on the server's door
every 30 seconds forever while the user sees nothing at all.

**Delivery reuses the on-machine path rather than duplicating it.** A message
relayed in from another device is broadcast as the same ``agent_msg.deliver``
event a local ``cli_send`` produces, so the receiving window's idle gate, rate
limit, queue cap and message log all apply unchanged; this module only adds the
receiver-side policy check the on-machine path does not need, and translates the
window's ``agent_msg.delivered`` verdict back into ``messages.ack``.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import hashlib
import json
import logging
import os
import platform
import secrets
import ssl
import time
from dataclasses import dataclass
from typing import Any, Callable

import certifi
import websockets

from . import (
    agent_messaging,
    device_crypto,
    device_identity,
    device_pairing,
    device_signing,
    device_trust,
    osplat,
    pane_policy,
    remote_roster,
    sync_keyring,
    trust_store,
)

log = logging.getLogger("agent_team_backend.server_link")

#: ui_settings key holding the Navide-Server WebSocket URL (e.g.
#: ``ws://localhost:8787/ws``). Empty or absent means "no server configured",
#: which keeps this whole module inert. It lives in ui_settings rather than a
#: private store so the Settings UI can write it through the existing
#: ``ui.settings.set`` handler without new plumbing.
# The one address every install talks to. Hard-coded on purpose: the server is
# a service this product operates, not a field each user configures — a typo'd
# address produced a link that silently never dialled, and there was no correct
# value for the user to discover on their own.
#
# NAVIDE_SERVER_URL overrides it for local development (point at ws://localhost:8787/ws)
# and for the verification scripts. Nothing in the UI writes it.
DEFAULT_SERVER_URL = "wss://server.navide.dev/ws"
SERVER_URL_ENV = "NAVIDE_SERVER_URL"

# Kept only so an install carrying the old user-entered address can have it
# ignored and cleared; nothing reads it as a source any more.
SERVER_URL_SETTING = "agentTeam.p2p.serverUrl"
# The signed-in email, kept in plain ui_settings rather than the vault: it is
# not a credential, and the Settings pane needs it to say *which* account is
# connected. The token it was exchanged for is the secret, and that stays in
# the vault.
ACCOUNT_EMAIL_SETTING = "agentTeam.p2p.accountEmail"

#: Vault secret name for the access token. It is a *long-lived* credential —
#: the server neither expires nor rotates it, the only way it stops working is
#: an admin revoking it — so it is stored once and read back, never refreshed.
ACCESS_TOKEN_SECRET = "navide-server-token"

#: Reported in ``auth.hello`` so the server can tell client kinds apart.
CLIENT_NAME = "navide-desktop"

#: Reconnect backoff, matching the renderer's own WS client ceiling
#: (``reconnectMaxMs`` in src/shared/wsClient.ts) so a network blip is ridden
#: out on the same timescale everywhere.
RECONNECT_BASE_S = 1.0
RECONNECT_MAX_S = 30.0

#: How long a request may wait for its ``.result`` frame.
REQUEST_TIMEOUT_S = 20.0

#: Roster changes arrive as nudges (see ``roster_changed``), but two of the
#: registry's mutations have no handler behind them: ``drop_owner`` flags panes
#: offline and ``purge_expired`` forgets them lazily, from whatever read path
#: happens to run next. So the reporter also re-scans on this interval rather
#: than trusting the nudges to be complete.
ROSTER_SWEEP_S = 30.0

#: Coalescing pause after a report. A window reconnecting re-registers every
#: pane it mirrors, which would otherwise be one upsert per pane per nudge.
ROSTER_DEBOUNCE_S = 0.5

#: How often to ask the server whether the account's email has been confirmed,
#: while it has not been. Nothing tells this machine on its own: the link learns
#: the answer at auth.hello and never again, so a person who clicked the link in
#: their browser sat in front of "we sent you a link" until they restarted.
#: Polling stops the moment the answer is yes, so this runs only during the
#: minutes right after signing up.
VERIFY_POLL_S = 30.0

#: The same question against a server too old to answer it. Still asked, so a
#: server upgraded under a running link is noticed without restarting anything,
#: but at a gap that makes the wasted round trip not worth counting.
VERIFY_RETRY_S = 60.0

#: The fallback vocabulary, used only when the owning window has not reported a
#: badge word — see ``_pane_status``. It used to be the *whole* vocabulary: the
#: enum ``sessions.upsert`` enforces had four values, so the seven states a
#: sidebar can show were renamed down into two here, and a pane whose CLI had
#: died was published as "waiting". The enum is wider now and the badge word is
#: passed through, which leaves these three as the answer to a smaller question:
#: what to say when all we know is the delivery flag. Mid-turn is "running",
#: anything else is "waiting", and a pane whose window has disconnected is
#: "disconnected" — transient, not
#: terminal. That distinction is the remote half of the local target-offline
#: code: the pane is still there and expected back once its window reconnects.
#: Reporting it as "waiting" would be indistinguishable from a healthy idle
#: pane, and "exited" would claim the session ended when it has not. A restore
#: placeholder is the second thing "disconnected" covers — see _pane_status.
STATUS_BUSY = "running"
STATUS_IDLE = "waiting"
STATUS_OFFLINE = "disconnected"

#: Local-only, and deliberately outside the four values above: the contract's
#: enum has no word for "restored but never opened", and inventing one the
#: server would reject with BAD_REQUEST is how a pane disappears from the
#: roster entirely. It is substituted into this device's own rows in
#: ``network_snapshot`` and never sent anywhere. The wording matches the
#: sidebar's ``paneStatus.waiting`` ("not opened") on purpose — the same pane
#: must not be called two different things in two places.
STATUS_NOT_OPENED = "not-opened"

#: Bounds on the inbound-message bookkeeping below. Same shape as the MCP
#: server's ``_mcp_message_status``: a count cap plus a TTL, because nothing
#: outlives the process and an unbounded map fed by a remote peer is a leak
#: with a sender attached to it.
MESSAGE_MEMORY_MAX = 500
MESSAGE_MEMORY_TTL_S = 3600.0

#: How long a message this device relayed may go unanswered before it asks the
#: server what became of it, and how often it asks again after that. The
#: server pushes `messages.acked` exactly once, to whatever connection is open
#: at that moment, so an ack that lands during a reconnect is otherwise gone;
#: `messages.get` is the contract's answer to that, and nothing called it.
RECONCILE_AFTER_S = 60.0
RECONCILE_INTERVAL_S = 60.0

#: Acked by a receiver whose own handling of the message failed. Retrying may
#: well succeed, which is why it is "failed" and not "rejected".
REASON_RECEIVER_ERROR = "receiver-error"

#: Hold keys for a relayed message the far side has not answered yet, as
#: cli_check_message reports them. They tell "its pane is mid-turn, the message
#: waits for it" apart from "nothing over there has said anything", which were
#: one indistinguishable "queued".
HOLD_REMOTE_BUSY = "remote-busy"
HOLD_REMOTE_UNREPORTED = "remote-unreported"

#: The three answers a receiver can give (the server's own ACK_STATES).
_ACK_STATES = ("delivered", "failed", "rejected")

#: Error codes this module answers ``send_message`` with when a server *is*
#: configured but the message cannot leave this machine. They are deliberately
#: not server codes — the request never reached one — and they exist so that a
#: connection state cannot be mistaken for a bad address. Without them the
#: caller falls back to the "unknown device" answer it gives when no server is
#: configured at all, which reads as "you typed the wrong machine" for what is
#: really "the link is down, try again in a moment".
#:
#: LINK_OFFLINE is transient (the reconnect loop is working on it);
#: LINK_UNAUTHORIZED is terminal (the credential was rejected or revoked, and
#: retrying can only produce the same answer until the user signs in again).
#: Answered when a message could not be sealed for a peer that has published a
#: key before. Deliberately a link-level code and not a server one: the message
#: never left this machine, and the caller must not read it as "the far end
#: refused" — nothing over there has heard of it.
#: Where the receiver's own signature over its own policy lives. Inside the
#: document rather than beside it, so the server's contract is unchanged: it
#: still stores one opaque JSON object verbatim and still never interprets it.
POLICY_SIGNATURE_FIELD = "_sig"

LINK_ENCRYPTION_FAILED = "p2p-encryption-failed"
#: Refused because this machine cannot read its own trust record. Distinct from
#: an encryption failure: nothing is wrong with the message, this machine is
#: simply not in a state where it can tell one sender from another.
LINK_TRUST_UNAVAILABLE = "p2p-trust-unavailable"

#: The one word every unauthenticated inbound message is refused with. Kept
#: single on purpose, exactly as "policy-denied" covers both blocked and merely
#: unauthorized: telling a sender *which* of "no signature", "unknown key" and
#: "wrong key" applied would let the relay map out this machine's pin table.
REASON_UNAUTHENTICATED = "unauthenticated"

#: Where a pairing frame is addressed. The relay requires a workspace and a
#: pane name on every message, and a pairing frame has neither — it addresses a
#: machine. So it carries a reserved pair that cannot collide: both halves start
#: with an underscore, which no workspace folder or pane name does. The receiver
#: routes on the body's kind and never looks at these, but the wire needs them
#: filled and the relay is not ours to change.
PAIRING_WORKSPACE = "_navide"
PAIRING_PANE = "_pairing"

#: The account sync key travels between two ALREADY PAIRED devices on the same
#: reserved address as the pairing exchange. It rides that channel rather than
#: a new one because the signature check in front of it is the one that matters
#: here — a frame from a pinned device is verified against the pinned key — and
#: because the wrapped key inside is sealed to the recipient regardless of what
#: carries it. The kinds are device_pairing's, because that is what decides
#: which kinds may be written and which are recognised on arrival.
SYNC_KEY_REQUEST = device_pairing.SYNC_KEY_REQUEST
SYNC_KEY_OFFER = device_pairing.SYNC_KEY_OFFER

#: How long a device with no key waits for a paired peer to hand one over.
SYNC_KEY_WAIT_S = 8.0

#: What a device that has never been paired with is told. Distinct from
#: "policy-denied" on purpose: the rules are not what refused it, and the sender
#: needs to know that the fix is a pairing rather than a rule.
REASON_NOT_PAIRED = "not-paired"
#: The field of a message the signature covers. Signed alongside the digest so
#: a ciphertext cannot be re-presented as plaintext under a valid signature.
BODY_CIPHER = "cipher"
BODY_TEXT = "text"
LINK_OFFLINE = "LINK_OFFLINE"
LINK_UNAUTHORIZED = "LINK_UNAUTHORIZED"

#: What the Settings UI shows for the link. These exist because "I saved a URL
#: and a token, is it working?" is otherwise unanswerable from the frontend: a
#: wrong URL and a rejected token both end with no messages getting through, but
#: only one of them is worth retyping the token for. UNREACHABLE is transient
#: (the reconnect loop keeps trying), UNAUTHORIZED is terminal.
STATE_UNCONFIGURED = "unconfigured"
STATE_CONNECTING = "connecting"
STATE_CONNECTED = "connected"
STATE_UNREACHABLE = "unreachable"
STATE_UNAUTHORIZED = "unauthorized"

#: Reading the stored credential is taking long enough that something is asking
#: a person for permission. On macOS the Keychain prompts the first time a newly
#: signed build reads an item the previous signature created, and ``security``
#: simply waits — so the link sits before its first dial with nothing to report:
#: no error, no attempt on the server, and a "connecting" that had already run
#: for twelve minutes when this was found. It is its own state because the
#: answer is "go and click Allow", which no amount of waiting produces.
STATE_WAITING_KEYCHAIN = "waiting-for-keychain"

#: How long a credential read may take before it is assumed to be waiting on a
#: person rather than on a disk.
CONFIG_READ_PATIENCE_S = 3.0

#: An auth.hello that has not been answered by here is not going to be. The dial
#: itself is bounded by the websockets client's own open timeout; this covers
#: the gap after it, where a socket that opened and then said nothing would
#: otherwise hold the loop for ever — no error, no retry, and from outside
#: indistinguishable from the Keychain wait above, which it is not: there is
#: nobody to click anything.
DIAL_TIMEOUT_S = 45.0


class ServerLinkTerminated(RuntimeError):
    """A failure that would answer the same way on every retry."""


@dataclass(frozen=True)
class ServerLinkConfig:
    url: str = ""
    token: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.url and self.token)


# ---- configuration ----------------------------------------------------------


def _vault():
    # The app-wide singleton, imported late to avoid an import cycle (app
    # imports this module). Tests swap it wholesale, so reading it through app
    # is also what keeps them off the real Keychain.
    from . import app

    return app.credential_vault


def server_url() -> str:
    """The address this install connects to: the built-in one unless overridden.

    A previously stored per-user address is deliberately NOT consulted — an
    install upgrading from the configurable era must move to the real service,
    not keep dialling whatever was typed in months ago.
    """
    override = os.environ.get(SERVER_URL_ENV, "")
    return override.strip() or DEFAULT_SERVER_URL


def account_email() -> str:
    from . import app

    value = app.ui_settings_store.get().get(ACCOUNT_EMAIL_SETTING)
    return value.strip() if isinstance(value, str) else ""


def access_token() -> str:
    """The stored token, or "" when it cannot be had right now.

    Reads are strict — a locked keychain and a dismissed authorisation dialog
    must not read as "signed out", because that answer sends callers down paths
    that erase real state. Strictness belongs at the vault; deciding what to do
    about it belongs here, and for a configuration read the answer is "no
    configuration this time round". The link's loop already treats a missing
    token as "not configured yet" and dials again later, which is the right
    behaviour for a keychain that was locked for a moment.
    """
    try:
        return (_vault().read_app_secret(ACCESS_TOKEN_SECRET) or "").strip()
    except Exception as err:  # noqa: BLE001 - a vault that will not answer is not a logout
        log.warning("the navide-server token could not be read (%s)", err)
        return ""


def set_access_token(token: str | None) -> None:
    """Store the Navide-Server access token, or erase it when None/empty."""
    value = (token or "").strip()
    _vault().write_app_secret(ACCESS_TOKEN_SECRET, value or None)


def load_config() -> ServerLinkConfig:
    """Read the link's configuration. Blocking (Keychain); call off the loop.

    An unreadable setting or Keychain answers "not configured" rather than
    raising: a broken cross-device config must never keep the backend from
    starting, and on-machine messaging does not depend on any of this.
    """
    try:
        return ServerLinkConfig(url=server_url(), token=access_token())
    except Exception as err:  # noqa: BLE001
        log.warning("navide-server link configuration is unreadable: %s", err)
        return ServerLinkConfig()


# ---- roster payloads --------------------------------------------------------


def _pane_status(entry: agent_messaging.RegisteredPane) -> str:
    if entry.offline:
        return STATUS_OFFLINE
    # A restore placeholder is neither of the other two: "running" claims an
    # agent is working, "waiting" claims a message sent now would be picked up,
    # and no CLI has been started behind it for either to be true. Its `busy`
    # flag says true — the window reports every pane it cannot inject into as
    # busy, which is the right answer for delivery and the wrong one for a
    # status word — so the flag is deliberately not consulted here.
    #
    # That mismatch used to apply to every pane, not just placeholders: `busy`
    # was the *only* signal this function had, so seven sidebar states collapsed
    # into two words and a crashed pane read as "waiting" — the one word that
    # promises a message would be picked up. `display_status` is the window's
    # own badge word, reported alongside `busy` for exactly this.
    if not entry.realized:
        return STATUS_OFFLINE
    # The window's own badge word, when it reported one. Passed through rather
    # than re-derived: the whole point is that the same pane is called the same
    # thing here and in the sidebar, and any mapping in between is a second
    # place for the two to drift apart.
    if entry.display_status:
        return entry.display_status
    # Nothing reported yet — a window that has not finished its first tick, or
    # an older build that only knows `busy`. Deliberately still the legacy word:
    # "waiting" here means "we only know the delivery flag", which is a smaller
    # claim than "idle" and is the honest one to make.
    return STATUS_BUSY if entry.busy else STATUS_IDLE


#: Where the salt behind ``workspace_digest`` lives. In the vault rather than
#: beside the settings because it is the only thing standing between a digest
#: and the path it was made from: a path is short, structured and highly
#: guessable (``/Users/<name>/Desktop/<project>``), so an unsalted digest of one
#: is reversible by anybody willing to run a dictionary. Salted with a secret
#: that never leaves this machine, it is not.
WORKSPACE_SALT_SECRET = "navide-workspace-digest-salt"

_workspace_salt_cache: bytes = b""


def _workspace_salt() -> bytes:
    """This machine's digest salt, minted on first use.

    A vault that cannot be read falls back to a salt this process invented,
    which changes on every restart. That degrades one thing — two panes in the
    same workspace stop looking related to a remote viewer — and protects the
    thing that matters, which is that the path never leaves in a readable form.
    Failing towards *less* linkability is the right direction for this.
    """
    global _workspace_salt_cache
    if _workspace_salt_cache:
        return _workspace_salt_cache
    try:
        stored = _vault().read_app_secret(WORKSPACE_SALT_SECRET)
        if not stored:
            stored = secrets.token_hex(32)
            _vault().write_app_secret(WORKSPACE_SALT_SECRET, stored)
    except Exception as err:  # noqa: BLE001
        log.warning("workspace digest salt is unavailable (%s); using a per-run one", err)
        stored = secrets.token_hex(32)
    _workspace_salt_cache = stored.encode("utf-8")
    return _workspace_salt_cache


def workspace_digest(path: str) -> str:
    """A stable, non-reversible stand-in for an absolute workspace path.

    The path used to be published verbatim. That was the single largest thing
    the relay learned about a person's work: ``sessions.workspacePath`` is free
    text and in practice holds the whole local path, username included — the
    server's own source notes a pane observed as
    ``/Users/<name>/Downloads/<file>.pdf``.

    Nothing reads it. The remote roster carries it into ``RemotePane`` and the
    account view declares a field for it, and no surface in this codebase
    renders it — so it was pure disclosure with no feature attached.

    A digest rather than an empty string, for one specific reason: the server
    merges this field with ``COALESCE``, so sending nothing would *preserve*
    whatever a previous version already published. A non-empty value overwrites
    it, which means upgrading actually withdraws the old path instead of
    leaving it sitting in the table.
    """
    if not path:
        return ""
    return hashlib.sha256(
        _workspace_salt() + b"\x00" + path.encode("utf-8")
    ).hexdigest()[:16]


def _session_payload(entry: agent_messaging.RegisteredPane) -> dict[str, Any]:
    """One pane as ``sessions.upsert`` wants it.

    ``deviceId`` is deliberately absent: the server takes it from the
    authenticated connection, and sending our own would let a client claim
    another device's sessions.

    ``workspace`` is the device-local folder basename, and it stays in the
    clear because it is half of the ``<workspace>/<pane>`` address a remote
    agent has to type. ``workspacePath`` no longer carries the absolute path —
    see ``workspace_digest``.

    ``title`` also stays in the clear, and that is a limit rather than an
    oversight: it is the other half of the address. A digest cannot be typed by
    the person addressing the pane, so hiding it would mean giving up
    cross-device addressing by name. Reducing it needs a user-chosen alias,
    which is a feature rather than a redaction.
    """
    payload = {
        "title": entry.name,
        "agentKey": entry.agent_key,
        "status": _pane_status(entry),
        # No task concept exists on this side yet; the field is part of the
        # agreed request shape, so it is sent empty rather than omitted.
        "taskId": "",
        "workspacePath": workspace_digest(entry.workspace_path),
        "workspace": entry.workspace_label,
        "paneId": entry.pane_id,
    }
    # An embedded AI panel names its window; a window pane sends exactly the
    # keys above. Today's server keeps fixed columns and drops these, so peers
    # do not see them yet — the local network view fills them from the registry.
    if entry.surface:
        payload["surface"] = entry.surface
    if entry.window_kind:
        payload["windowKind"] = entry.window_kind
    return payload


def _panel_window(
    raw: dict[str, Any], local: agent_messaging.RegisteredPane | None
) -> dict[str, str]:
    """The optional window keys of a network-view pane row: present only for an
    embedded AI panel, so a window pane's row keeps exactly its old keys."""
    surface = local.surface if local else str(raw.get("surface") or "")
    window_kind = local.window_kind if local else str(raw.get("windowKind") or "")
    keys: dict[str, str] = {}
    if surface:
        keys["surface"] = surface
    if window_kind:
        keys["windowKind"] = window_kind
    return keys


def _reason_key(reason: str) -> str:
    """The renderer encodes its delivery reason as JSON (``{"key": ...}``); the
    ack carries the key alone.

    The server stores ``reason`` verbatim and never interprets it, so the keys
    forwarded here are exactly the ones a sender already reads back from
    ``cli_check_message`` on one machine — "rate-limit", "queue-full",
    "inject-failed", "pane-closed". Translating them into a second vocabulary
    would give the same failure two names.
    """
    try:
        parsed = json.loads(reason)
    except (TypeError, ValueError):
        return reason
    if isinstance(parsed, dict) and isinstance(parsed.get("key"), str):
        return parsed["key"]
    return reason


async def _quiet(task: asyncio.Task) -> None:
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await task


@functools.lru_cache(maxsize=1)
def _tls_context() -> ssl.SSLContext:
    """Trust roots a frozen build can actually find, *added to* the usual ones.

    ``ssl.create_default_context()`` looks for roots at OpenSSL's compiled-in
    paths, and PyInstaller freezes the *build* machine's paths into the
    executable — paths that do not exist on the user's machine. So every
    ``wss://`` dial from a packaged backend failed the handshake with
    CERTIFICATE_VERIFY_FAILED, which ``ws_handlers`` flattens into LINK_OFFLINE
    and the account modal renders as "Cannot reach the server": a TLS trust
    problem wearing a network outage's clothes, on an install where the link
    could never work.

    certifi's bundle ships inside the executable and resolves its path at run
    time, so it is the store that is correct when frozen. It is loaded *on top
    of* the default set rather than replacing it, because replacing it would
    trade this bug for its mirror image: someone behind a corporate TLS proxy,
    or with a private root in their Keychain, running from source — connecting
    today, and told "Cannot reach the server" tomorrow by the very fix. httpx
    resolves the same question the same way for every other outbound call this
    process makes (``httpx/_config.py``: SSL_CERT_FILE, else certifi), so the
    two paths agree on what is trusted.
    """
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())
    return context


def _dial(url: str, **kwargs: Any) -> Any:
    """``websockets.connect`` with that trust store attached for TLS dials.

    Synchronous, and free once ``_warm_tls`` has run: the cache turns this into
    a dict lookup. Call that first from anywhere on the event loop.
    """
    if url.lower().startswith("wss://"):
        kwargs.setdefault("ssl", _tls_context())
    return websockets.connect(url, **kwargs)


def _close_code_sent(ws: Any) -> int | None:
    """The close code this side sent on *ws*, if it sent one. A frame over
    ``max_size`` makes websockets close with 1009 and record it here; the code
    the connection reports (``close_code``) is the far side's, 1006 when it
    sent none. Read-only, for ``_sync_request``."""
    sent = getattr(getattr(ws, "protocol", None), "close_sent", None)
    code = getattr(sent, "code", None)
    return int(code) if isinstance(code, int) else None


async def _warm_tls(url: str) -> None:
    """Build the trust store on a worker thread, before anything dials.

    Reading and parsing certifi's bundle is 200-500ms of blocking work, and the
    loop it would block is the one carrying every terminal's output — the same
    reason this module offloads Keychain reads and signing. Doing it here keeps
    ``_dial`` synchronous, so an injected connector still sees the plain
    call signature the tests build against.

    On the same clock as the dial it precedes: ``to_thread`` hands this to the
    shared executor, and a starved executor is a failure this repo has had
    before. Without the timeout the link would sit in STATE_CONNECTING for ever
    — never dialling, never retrying, never reporting — where every other way
    this can fail lands in ``_run``'s backoff.
    """
    if url.lower().startswith("wss://"):
        async with asyncio.timeout(DIAL_TIMEOUT_S):
            await asyncio.to_thread(_tls_context)


class ServerLink:
    """One outbound connection: authenticate, then keep the roster published."""

    def __init__(
        self,
        *,
        connect: Callable[..., Any] | None = None,
        config_loader: Callable[[], ServerLinkConfig] | None = None,
        token_clearer: Callable[[], None] | None = None,
        device_name: str | None = None,
    ) -> None:
        self._connect = connect or _dial
        self._load_config = config_loader or load_config
        self._clear_token = token_clearer or (lambda: set_access_token(None))
        self._device_name = device_name or platform.node() or "unknown"
        self._task: asyncio.Task | None = None
        self._stopped = False
        self._ws: Any = None
        # A socket exists *and* auth.hello was accepted on it. Tracked apart
        # from _ws because the gap between the two is a real state: a request
        # written into it is answered AUTH_REQUIRED, which would surface to the
        # sender as a server refusal rather than "not connected yet".
        self._authenticated = False
        self._next_id = 0
        self._pending: dict[str, asyncio.Future] = {}
        # Single-writer discipline, same as the renderer-facing socket: the
        # websockets protocol forbids concurrent writes on one connection.
        self._send_lock = asyncio.Lock()
        self._roster_dirty = asyncio.Event()
        # pane_id -> the payload last accepted by the server, so an unchanged
        # pane is not re-sent on every sweep.
        self._reported: dict[str, dict[str, Any]] = {}
        # pane_id -> server-issued sessionId, kept across reconnects so an
        # update lands on the same session row instead of minting a new one.
        # Purely an optimisation: the server falls back to (deviceId, paneId),
        # so losing this map costs one extra id lookup, never a duplicate row.
        self._session_ids: dict[str, str] = {}
        # Whether this connection has already sent its full-roster sessions.sync.
        self._synced = False
        # msgKey -> {created_at, pane_id, acked} for every message relayed in
        # from another device. Presence *is* the dedupe set: the server pushes
        # messages.pending to every connection it holds for this device, and a
        # backend restart can briefly leave two open, so the same message can
        # arrive twice. Keyed on msgKey rather than inferred from timestamps —
        # a timestamp that fails to parse falls through and injects twice.
        self._inbound: dict[str, dict[str, Any]] = {}
        #: Messages this device relayed that the far side has not answered:
        #: msgKey -> {sent_at, to}. What the reconciler asks the server about.
        self._outbound: dict[str, dict[str, Any]] = {}
        # Receiver-side pane policy, cached with the revision it came at. None
        # means "never fetched"; the cache is deliberately kept across
        # reconnects so an authorization decision does not depend on the
        # control plane being reachable at the moment a message lands.
        self._policy: Any = None
        self._policy_revision: int | None = None
        # Who knocked and was refused. In memory only: a knock is a prompt for
        # a person sitting there now, not a record to keep, and persisting it
        # would mean deciding where — the policy document belongs to the
        # server, and this is nobody's business but this machine's.
        self._access_requests = device_trust.AccessRequests()
        # Devices this link has ever sealed a message for now live in
        # ``trust_store``, which outlives the process. Held here it was a
        # promise that expired on every backend restart — and a restart is a
        # daily event, not something the relay had to arrange.
        #
        # Why cross-device traffic is refused outright, when it is. See
        # ``trust_store``: an initialised machine whose trust record cannot be
        # read has lost its pins, its policy high-water mark and its
        # no-downgrade list at once, and every one of those fails *silently* if
        # the answer is to start over.
        self._trust_locked = ""
        # The member id pinned for *this link's* credential. Never the one the
        # last auth.hello asserted: that is the value C1 moved.
        self._own_member = ""
        #: The keyring namespace this link bound, or None before identity settled.
        self._sync_namespace: str | None = None
        self._tasks: set[asyncio.Task] = set()
        self._device_id = ""
        #: Whether the id being claimed replaces one the server just refused.
        #: Anything else overwriting a recorded id is how an identity is lost.
        self._replacing_node_id = False
        self.member_id = ""
        # The role auth.hello granted this member: "admin", "member" or
        self.display_name = ""
        # Whether the account's e-mail address has been confirmed, from
        # auth.hello. A soft gate: an unverified account signs in and works
        # normally, it is only flagged (and may not invite anyone). Refreshed
        # on every reconnect and by a resend reply, because the confirming
        # click happens in a browser this process never sees.
        self.email_verified = False
        #: Set when the server does not know ``account.status``, so the poll
        #: below stops asking and re-authenticates instead. Logged once, not
        #: per attempt: it is a fact about the server, not an event.
        self._verify_fallback = False
        # The whole session directory as the server last described it, this
        # device's own rows included. ``remote_roster`` deliberately drops the
        # local ones — an address aimed back at this machine has to resolve
        # against the live local roster — but the account modal's network view
        # has to show the machine the user is sitting at beside the others, so
        # the raw rows are kept here as well. None means "never received one",
        # which an empty directory must not be confused with.
        self._directory: list[dict[str, Any]] | None = None
        #: Built on first use so a link that never connects never touches the
        #: Keychain looking for a sync key.
        self._sync_engine: Any = None
        # Device ids the server last reported online, or None while no
        # presence.changed has arrived. Kept apart from the per-session
        # ``hostOnline`` flag because the two facts arrive on different events
        # (see ``_on_presence_changed``), and because a device with no sessions
        # at all has no row to carry that flag.
        self._online_devices: set[str] | None = None
        self.terminated_reason = ""
        # Why the last dial or session failed, kept so `state()` can tell a
        # server that is not answering apart from one that has not been tried
        # yet. Cleared the moment a connection authenticates.
        self.last_error = ""
        #: When ``last_error`` was recorded, and when the loop will dial again.
        #: A refusal that says only "not connected" leaves a person with no way
        #: to tell "starting up" from "the address is wrong" from "your token
        #: was rejected" — three problems with three different answers, only one
        #: of which is to wait.
        self.last_error_at = 0.0
        self.next_retry_at = 0.0
        #: When the current dial started. Set when dialling actually begins, not
        #: at construction: it used to include the credential read, so "started
        #: 739s ago" was counting time the link had not yet spent connecting.
        self.connecting_since = 0.0
        #: When the in-flight credential read began, or 0.0 when none is.
        self.config_read_started = 0.0

    # ---- lifecycle ----

    async def start(self) -> bool:
        """Dial the server if one is configured.

        Returns False — having done nothing whatsoever, no task, no socket, no
        timer — when there is no URL or no token. "Not set up" has to be
        indistinguishable from "this feature does not exist" for everyone still
        using Navide on one machine.
        """
        config = await asyncio.to_thread(self._load_config)
        if not config.configured:
            log.debug("navide-server link is not configured; staying offline")
            return False
        self._stopped = False
        self._task = asyncio.create_task(self._run())
        return True

    async def stop(self) -> None:
        self._stopped = True
        # No link, no account: the ring stays in the vault for the next
        # sign-in to the same account, but nothing may read it meanwhile.
        sync_keyring.unbind()
        task = self._task
        self._task = None
        for spawned in list(self._tasks):
            spawned.cancel()
            await _quiet(spawned)
        if task is not None:
            task.cancel()
            await _quiet(task)

    def _spawn(self, coro: Any) -> None:
        """Run a coroutine off the read loop.

        Anything that issues a request has to leave the read loop free: the
        reply it waits for is read *by* that loop, so awaiting inline while
        handling a server push deadlocks the connection until the timeout.
        """
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def notify_roster_changed(self) -> None:
        """Ask the reporter to diff the roster. Cheap and idempotent."""
        self._roster_dirty.set()

    def state(self) -> str:
        """One of the STATE_* values, for the Settings UI.

        Order matters: a terminated link still holds whatever the last socket
        error was, and "your token was rejected" is the answer the user has to
        act on.
        """
        if self.terminated_reason:
            return STATE_UNAUTHORIZED
        if self._authenticated:
            return STATE_CONNECTED
        # Before the socket errors, because a read that is waiting on a person
        # has not reached the socket at all — and reporting it as "connecting"
        # is what made this invisible for twelve minutes.
        if (
            self.config_read_started
            and time.time() - self.config_read_started > CONFIG_READ_PATIENCE_S
        ):
            return STATE_WAITING_KEYCHAIN
        if self.last_error:
            return STATE_UNREACHABLE
        return STATE_CONNECTING

    # ---- connection loop ----

    async def _run(self) -> None:
        delay = RECONNECT_BASE_S
        while not self._stopped:
            config = await self._read_config()
            if not config.configured:
                log.info(
                    "navide-server link stopping: the server URL or access token "
                    "is no longer configured"
                )
                # The remote roster was this server's answer to "who else is
                # out there"; with no server, there is no one else.
                remote_roster.clear()
                return
            self.connecting_since = time.time()
            try:
                authenticated = await self._session(config)
            except asyncio.CancelledError:
                raise
            except ServerLinkTerminated as err:
                self.terminated_reason = str(err)
                log.error("navide-server link stopped for good: %s", err)
                return
            except Exception as err:  # noqa: BLE001
                authenticated = False
                self.last_error = str(err) or type(err).__name__
                self.last_error_at = time.time()
                log.warning("navide-server link failed (%s)", err)
            if self.terminated_reason:
                # Set by a server push (auth.revoked) rather than raised.
                log.error("navide-server link stopped for good: %s", self.terminated_reason)
                return
            if self._stopped:
                return
            if authenticated:
                # A link that lived long enough to authenticate is not the case
                # the backoff exists to damp; start over from the short delay.
                delay = RECONNECT_BASE_S
            log.info("navide-server link retrying in %.0fs", delay)
            self.next_retry_at = time.time() + delay
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_S)

    def keychain_wait_reason(self) -> str:
        """The sentence for a credential read that is waiting on a person, or
        "" when none is. Shared by the status the panel polls and the refusal a
        caller gets, so the two never disagree about where the link is."""
        if self.state() != STATE_WAITING_KEYCHAIN:
            return ""
        waited = max(0, int(time.time() - self.config_read_started))
        # The state is worth surfacing on every platform — a credential read
        # that has not returned in seconds is stuck on something — but only
        # macOS has a Keychain dialog to go and click. Told to a Linux user
        # whose home is on a slow disk, that sentence sends them looking for a
        # window that does not exist.
        if osplat.platform_id == "darwin":
            return (
                "waiting for Keychain access — a macOS permission dialog may be "
                f"open ({waited}s so far); the link has not dialled yet"
            )
        return (
            f"the stored credential is taking unusually long to read ({waited}s "
            "so far); the link has not dialled yet"
        )

    async def _read_config(self) -> Any:
        """Read the stored credential, visibly.

        Deliberately not given a timeout. On macOS this can be waiting for a
        person to click Allow on a Keychain prompt, and cancelling that is the
        wrong answer — the read is legitimate and will succeed the moment they
        do. What was wrong was that it was *silent*: the link reported
        "connecting" while it had not yet tried to connect to anything, so a
        machine that never reached the server looked identical to one that was
        merely slow.
        """
        self.config_read_started = time.time()
        log.info("reading the navide-server credential")
        try:
            return await asyncio.to_thread(self._load_config)
        finally:
            took = time.time() - self.config_read_started
            self.config_read_started = 0.0
            if took > CONFIG_READ_PATIENCE_S:
                log.warning(
                    "reading the navide-server credential took %.1fs — on macOS "
                    "that usually means a Keychain permission dialog was open",
                    took,
                )
            else:
                log.info("read the navide-server credential in %.2fs", took)

    async def _session(self, config: ServerLinkConfig) -> bool:
        """One connection, from dial to close. Returns whether it authenticated."""
        authenticated = False
        await _warm_tls(config.url)
        async with self._connect(config.url) as ws:
            self._ws = ws
            reader = asyncio.create_task(self._read_loop(ws))
            try:
                # Only the hello is on a clock. The session that follows is
                # supposed to last as long as the connection does — the first
                # version of this put the whole of `_session` under the timeout,
                # which quietly killed every link after forty-five seconds.
                #
                # A socket that opens and then says nothing is the case this
                # covers: without it the loop waits for ever, with no error and
                # no retry, which from outside looks like the Keychain wait
                # above and is not — there is nobody to click anything.
                async with asyncio.timeout(DIAL_TIMEOUT_S):
                    await self._authenticate(config)
                authenticated = True
                self._authenticated = True
                self.last_error = ""
                self.last_error_at = 0.0
                self.next_retry_at = 0.0
                # A fresh connection knows nothing about what this backend told
                # the previous one, so the whole roster is flattened again.
                self._reported.clear()
                self._synced = False
                self._roster_dirty.set()
                # Any policy.changed pushed while this device was away was
                # missed, so the cached revision cannot be trusted after a
                # reconnect. One fetch per connection, not per message.
                await self._refresh_policy()
                # Same reasoning for the other direction's roster: every
                # sessions.changed pushed while this device was away was missed,
                # so the cache is realigned from a full directory read once per
                # connection and kept current by the push after that.
                await self._refresh_directory()
                # Everything written on other devices while this one was away
                # is waiting behind a cursor, and no `sync.changed` will be
                # re-sent for it. One catch-up round per connection; deliberately
                # spawned rather than awaited, because a large first sync must
                # not hold the session open before its reader starts.
                self._spawn(self._sync_all())
                # Messages in both directions whose answer the dropped
                # connection may have swallowed: acks this device could not send,
                # and acks for its own sends that were pushed while it was away.
                self._spawn(self._resend_unsent_acks())
                reconciler = asyncio.create_task(self._reconcile_loop())
                reporter = asyncio.create_task(self._report_loop())
                # Deliberately *not* in the wait below. That set means "the
                # connection is over when any of these finishes", and this task
                # is designed to finish: it returns the moment the address is
                # confirmed, which for an already-verified account is
                # immediately. Putting it there tore the session down a
                # millisecond after it authenticated, and `_run` dialled again
                # one second later, for ever — a reconnect loop on every normal
                # account, caused by the one task whose whole point was to end.
                verifier = asyncio.create_task(self._verify_loop())
                try:
                    done, _ = await asyncio.wait(
                        {reader, reporter}, return_when=asyncio.FIRST_COMPLETED
                    )
                    for finished in done:
                        finished.result()
                finally:
                    reporter.cancel()
                    await _quiet(reporter)
                    verifier.cancel()
                    await _quiet(verifier)
                    reconciler.cancel()
                    await _quiet(reconciler)
            finally:
                reader.cancel()
                await _quiet(reader)
                self._ws = None
                self._authenticated = False
                self._fail_pending(ConnectionError("navide-server link closed"))
        return authenticated

    async def _read_loop(self, ws: Any) -> None:
        try:
            async for raw in ws:
                await self._handle(raw)
        finally:
            self._fail_pending(ConnectionError("navide-server connection closed"))

    async def _handle(self, raw: Any) -> None:
        try:
            message = json.loads(raw)
        except (TypeError, ValueError):
            log.warning("navide-server sent a frame that is not JSON; ignoring it")
            return
        if not isinstance(message, dict):
            return
        msg_id = str(message.get("id") or "")
        future = self._pending.pop(msg_id, None) if msg_id else None
        if future is not None:
            if not future.done():
                future.set_result(message)
            return
        msg_type = str(message.get("type") or "")
        if msg_type == "auth.revoked":
            await self._on_revoked(message.get("payload"))
            return
        if msg_type == "messages.pending":
            self._spawn(self._on_message_pending(message.get("payload")))
            return
        if msg_type == "messages.acked":
            self._on_message_acked(message.get("payload"))
            return
        if msg_type == "sync.changed":
            self._spawn(self._on_sync_changed(message.get("payload")))
            return
        if msg_type == "policy.changed":
            self._spawn(self._on_policy_changed(message.get("payload")))
            return
        if msg_type == "sessions.changed":
            # Carries the whole directory, so it needs no follow-up request and
            # is applied inline rather than off the read loop.
            self._apply_directory(message.get("payload"))
            return
        if msg_type == "presence.changed":
            self._on_presence_changed(message.get("payload"))
            return
        if msg_type == "account.verified":
            # The browser tab that confirmed the address is not this process, so
            # this push is the only thing that connects the two. Polling below
            # covers the server that cannot send it.
            self._spawn(self._on_account_verified())
            return
        log.debug("navide-server event %r is not wired yet; ignoring it", msg_type)

    def sync_engine(self) -> Any:
        """This link's sync engine, built once.

        The engine is handed ``_request`` rather than the link itself: it has
        no business reaching into the connection, and a plain callable is what
        lets the tests drive it against a stub server.
        """
        if self._sync_engine is None:
            from . import app, sync_engine as engine_mod, sync_scopes
            from .ipc import make_event

            def _broadcast(delta: dict[str, Any]) -> None:
                # Same event ui.settings.set sends, so every open window
                # converges on a synced change the way it does on a local one.
                self._spawn(
                    app.broadcast(make_event("ui.settings_changed", {"settings": delta}))
                )

            def _result(result: dict[str, Any]) -> None:
                # Every round's outcome, per scope, to every window: a Settings
                # pane that only learns what happened when it asks shows a
                # sync that failed an hour ago as fine.
                self._spawn(app.broadcast(make_event("sync.result", result)))

            engine = engine_mod.SyncEngine(
                app.sync_store,
                self._sync_request,
                device_id=lambda: self._device_id,
                enabled=lambda scope: not _switch_pending and sync_scopes.scope_enabled(scope),
                on_result=_result,
                account_member=lambda: self.member_id,
                on_forget=sync_scopes.forget_detached,
            )
            engine.register(sync_scopes.PromptsScope(broadcast=_broadcast))
            async def _mcp_changed() -> None:
                # What a save in Settings does (mcp.save_servers), plus telling
                # the windows, which re-read the list unless mid-edit.
                await app.mcp_manager.reload(app.mcp_settings_store.path)
                await app.broadcast(
                    make_event("mcp.servers_changed", {"revision": str(app.mcp_settings_store.revision)})
                )

            engine.register(sync_scopes.McpScope(on_change=_mcp_changed))
            engine.register(sync_scopes.SkillsStateScope())
            # Files of skills too large for one record, as blobs; rides with
            # the Skills switch. Its transfers report progress to every window.
            skill_files = sync_scopes.skill_files_scope()
            skill_files.set_notify(
                lambda progress: self._spawn(app.broadcast(make_event("skills.sync_progress", progress)))
            )
            engine.register(skill_files)
            engine.register(sync_scopes.MemoryScope())
            # One instance, shared with the spawn and sign-out paths; see
            # sync_scopes.credentials_scope.
            engine.register(sync_scopes.credentials_scope())
            self._sync_engine = engine
        return self._sync_engine

    async def _offer_sync_key(self, device_id: str) -> bool:
        """Wrap this account's sync key for one paired device and send it.

        Nothing in here may raise. ``_finish_pairing`` awaits it as its last
        step, and the only ``except`` above that is a narrow ``PairingError`` —
        so an exception escaping this would come out of the pairing exchange
        itself, after the pin was already written. The send is inside the guard
        for that reason: it was outside it once, which made this docstring a
        claim the code did not keep.
        """
        try:
            if not await asyncio.to_thread(sync_keyring.has_account_key):
                return False
            # The recipient key comes from the pin the pairing wrote — the one
            # the six digits covered — and never from the directory. The
            # directory is the relay's word, and a relay that could name the
            # recipient here would be handed every record in the account. A
            # pin taken before the encryption key was part of the exchange
            # has none, and is refused rather than completed from the
            # directory: pairing again is the fix, not trusting the relay once.
            pin = await asyncio.to_thread(trust_store.pin_for, device_id)
            recipient = self._sync_key_peer(pin, device_id=device_id, kind=SYNC_KEY_OFFER)
            if not recipient:
                return False
            wrapped = await asyncio.to_thread(
                sync_keyring.wrap_for,
                recipient_public_key=recipient,
                from_device=self._device_id,
                to_device=device_id,
                namespace=self._sync_namespace,
            )
            return await self._send_pair_frame(device_id, SYNC_KEY_OFFER, wrapped=wrapped)
        except Exception as err:  # noqa: BLE001 - pairing must survive this
            log.warning("could not hand the sync key to %s: %s", device_id, err)
            return False

    def _sync_key_peer(self, pin: dict[str, Any] | None, *, device_id: str, kind: str) -> str:
        """The encryption key the account sync key may travel to or from
        *device_id*, or "" with the reason logged.

        Paired is not enough. A pairing is a fact about *machines* — this one
        and that one compared six digits — and pins exist for other people's
        machines too, the ones the pane policy lets drive a pane here. The
        account key is a fact about an *account*: it opens every synced
        record, so it goes only to a device the pin says belongs to this
        account's own member, approved, and whose pairing pinned an
        encryption key. The member id in the pin was written by the pairing
        from this machine's own credential context, never from the frame.
        The same test guards both directions: a request from a device that
        must not hold the key is not answered, and an offer from one is not
        adopted, because an adopted key decides which records this machine
        can read and whose it writes into.
        """
        if not isinstance(pin, dict):
            log.info("ignoring a %s from %s: that device is not paired with this one", kind, device_id)
            return ""
        if pin.get("approved") is not True:
            log.info("ignoring a %s from %s: that pairing was never approved", kind, device_id)
            return ""
        if not self._own_member or str(pin.get("memberId") or "") != self._own_member:
            log.warning(
                "refusing a %s with %s: that device is paired but belongs to another "
                "account, and the sync key never leaves this one",
                kind, device_id,
            )
            return ""
        recipient = str(pin.get("encKey") or "")
        if not recipient:
            log.warning(
                "refusing a %s with %s: its pairing pinned no encryption key; unpair "
                "that device and pair it again",
                kind, device_id,
            )
            return ""
        return recipient

    async def _adopt_sync_key(self, device_id: str, wrapped: str) -> None:
        """Take the account key a paired device sealed for this one."""
        try:
            await asyncio.to_thread(
                sync_keyring.accept_wrapped,
                wrapped,
                from_device=device_id,
                to_device=self._device_id,
                namespace=self._sync_namespace,
            )
        except sync_keyring.KeyConflict:
            # Two keys exist for one account, which means one of them was
            # minted while the other device was away. Said out loud rather than
            # resolved here: whichever is dropped takes its records with it.
            log.error(
                "%s offered a different sync key; this machine keeps the one it has, "
                "and the two will not read each other's synced records",
                device_id,
            )
        except Exception as err:  # noqa: BLE001 - an unreadable offer is not fatal
            log.warning("the sync key offered by %s did not open: %s", device_id, err)
        else:
            self._spawn(self._sync_all())

    async def offer_sync_key_to_peers(self) -> dict[str, Any]:
        """Hand the current ring to every device that may hold it — after a
        rotation, so the others stop writing under the retired key without
        waiting for their next request. Same gate as any offer
        (``_sync_key_peer``); a device that fails it is listed as skipped, and
        one the relay would not take the frame for likewise.
        """
        offered: list[str] = []
        skipped: list[str] = []
        try:
            pins = (await asyncio.to_thread(trust_store.load)).get("pins") or {}
        except Exception as err:  # noqa: BLE001 - an unreadable store offers to nobody
            log.warning("cannot offer the sync key: the trust store would not answer: %s", err)
            return {"offered": offered, "skipped": skipped, "error": str(err)}
        for device_id, pin in pins.items():
            if device_id == self._device_id:
                continue
            if not self._sync_key_peer(pin, device_id=device_id, kind=SYNC_KEY_OFFER):
                skipped.append(device_id)
            elif await self._offer_sync_key(device_id):
                offered.append(device_id)
            else:
                skipped.append(device_id)
        return {"offered": offered, "skipped": skipped}

    async def ensure_sync_key(self) -> bool:
        """Make sure this machine holds the account key, without minting a second.

        Minting is safe exactly once per account. A machine that mints while a
        paired device is merely offline would write records that device can
        never read — and the failure is silent, because both sides go on
        working. So the rule is narrow: mint only when this machine has paired
        with nobody. With peers present, ask them and wait; if none answers,
        say so and sync nothing.
        """
        if await asyncio.to_thread(sync_keyring.has_account_key):
            return True
        try:
            pins = (await asyncio.to_thread(trust_store.load)).get("pins") or {}
        except Exception as err:  # noqa: BLE001 - an unreadable store is not "no peers"
            log.warning("the trust store would not say who this machine is paired with: %s", err)
            return False
        peers = [device for device in pins if device != self._device_id]
        if not peers:
            try:
                await asyncio.to_thread(sync_keyring.ensure_account_key)
            except sync_keyring.KeyringError as err:
                # No account bound, or an older key waiting to be adopted:
                # both mean "do not mint", and sync stays off until resolved.
                log.warning("not minting a sync key: %s", err)
                return False
            log.info("this is the first device of the account; minted its sync key")
            return True
        asked = 0
        for device in peers:
            if await self._send_pair_frame(device, SYNC_KEY_REQUEST):
                asked += 1
        if asked:
            deadline = time.monotonic() + SYNC_KEY_WAIT_S
            while time.monotonic() < deadline:
                await asyncio.sleep(0.25)
                if await asyncio.to_thread(sync_keyring.has_account_key):
                    return True
        log.info(
            "no paired device answered with the account sync key; syncing nothing "
            "until one of them is online"
        )
        return False

    async def _sync_all(self) -> None:
        """Catch up every enabled scope. Never raises into the session."""
        try:
            from . import sync_scopes

            if not any(sync_scopes.enabled_scopes().values()):
                return  # nothing is switched on: do not even look for a key
            if not await self.ensure_sync_key():
                return
            await self.sync_engine().sync_all()
        except Exception as err:  # noqa: BLE001 - sync is never load-bearing
            log.warning("the sync catch-up round failed: %s", err)

    async def _on_sync_changed(self, payload: Any) -> None:
        """Another device wrote something; read that one scope."""
        data = payload if isinstance(payload, dict) else {}
        scope = str(data.get("scope") or "")
        if not scope:
            return
        try:
            if not await self.ensure_sync_key():
                return
            await self.sync_engine().sync(scope)
        except Exception as err:  # noqa: BLE001 - same reason as above
            log.warning("syncing %s after a change notice failed: %s", scope, err)

    async def _on_revoked(self, payload: Any) -> None:
        """The server withdrew this member's access mid-connection.

        Terminal, not a failed attempt: the connection has already dropped back
        to unauthenticated and every later request answers AUTH_REQUIRED. So the
        stored token goes (it can never work again), the reason is logged where
        a user can find it, and the reconnect loop stops instead of retrying a
        credential that has been taken away.
        """
        data = payload if isinstance(payload, dict) else {}
        reason = str(data.get("reason") or "no reason given")
        member = str(data.get("memberId") or "unknown")
        self.terminated_reason = f"access revoked for member {member}: {reason}"
        log.error(
            "navide-server revoked this device's access (member %s): %s — the stored "
            "access token has been cleared; sign in again to reconnect",
            member,
            reason,
        )
        try:
            await asyncio.to_thread(self._clear_token)
        except Exception as err:  # noqa: BLE001
            log.warning("clearing the navide-server access token failed: %s", err)
        ws = self._ws
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()

    # ---- requests ----

    def _fail_pending(self, error: BaseException) -> None:
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    async def _send_frame(self, frame: dict[str, Any]) -> None:
        """The only place this module writes to the socket (see _send_lock)."""
        ws = self._ws
        if ws is None:
            raise ConnectionError("navide-server link is not connected")
        async with self._send_lock:
            await ws.send(json.dumps(frame))

    async def _request(self, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._next_id += 1
        msg_id = str(self._next_id)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = future
        try:
            await self._send_frame({"id": msg_id, "type": msg_type, "payload": payload})
            reply = await asyncio.wait_for(future, REQUEST_TIMEOUT_S)
        finally:
            self._pending.pop(msg_id, None)
        return reply if isinstance(reply, dict) else {}

    async def _sync_request(self, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        """``_request`` for the sync engine only. A drop caused by a reply too
        big for one frame — this side closed the socket with 1009 — is raised
        as ``sync_engine.FrameTooLarge`` so a pull can ask for smaller pages.
        Only reads the closed connection; the link itself is untouched."""
        ws = self._ws
        try:
            return await self._request(msg_type, payload)
        except ConnectionError as err:
            if _close_code_sent(ws) == 1009:
                from . import sync_engine

                raise sync_engine.FrameTooLarge(str(err)) from err
            raise

    async def _authenticate(self, config: ServerLinkConfig) -> None:
        """Say hello, and settle which id this machine presents to this account.

        The id is per *account*, not per machine. It used to be one value for the
        whole machine, which made a machine something an account could claim:
        sign up a second account from a machine the server already knows and
        every ``auth.hello`` answers ``DEVICE_CONFLICT``, permanently, because
        the id belongs to the first member. The account view reported "access
        token rejected", so people retyped a password that was never wrong.

        The member is known before the reply whenever this credential has worked
        before — the trust store pinned it — so the right id can be offered on
        the first attempt. When it is not known, the id this machine has always
        presented is offered, and the server's refusal is what corrects it.
        """
        hint = await asyncio.to_thread(
            trust_store.member_for_credential, config.url, config.token
        )
        candidates = await asyncio.to_thread(device_identity.candidate_node_ids, hint)
        reply: dict[str, Any] = {}
        for index, candidate in enumerate(candidates):
            self._device_id = candidate
            reply = await self._hello(config)
            if reply.get("ok") or self._conflict_code(reply) != "DEVICE_CONFLICT":
                break
            # Only this one code is worth another attempt, and only because the
            # next attempt offers something different. The other two rejections
            # mean the same thing however often they are asked — see below.
            if index + 1 < len(candidates):
                log.warning(
                    "the server says the id this machine offered belongs to "
                    "another account; offering the next one it already holds"
                )
        # Replacing what is recorded is only allowed when the server refused it,
        # which is exactly the case where more than one candidate was tried.
        self._replacing_node_id = len(candidates) > 1 and self._device_id != candidates[0]
        await self._finish_authenticate(config, reply)

    @staticmethod
    def _conflict_code(reply: dict[str, Any]) -> str:
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        return str(error.get("code") or "")

    async def _hello(self, config: ServerLinkConfig) -> dict[str, Any]:
        return await self._request(
            "auth.hello",
            {
                "credential": config.token,
                "client": CLIENT_NAME,
                "deviceId": self._device_id,
                "deviceName": self._device_name,
                # Published on every hello, not only the first: the server keeps
                # the last key it was told, and a build that stopped sending one
                # would leave peers encrypting to a key this machine no longer
                # holds. Cheap to re-send, expensive to get wrong.
                "publicKey": await asyncio.to_thread(device_crypto.public_key),
                # The signing half, published on the same channel and for the
                # same reason. What the server does with it is distribute a
                # *candidate*: peers pin the first one they verify a message
                # against and stop reading this field afterwards.
                "signPublicKey": await asyncio.to_thread(device_signing.public_key),
            },
        )

    async def _finish_authenticate(
        self, config: ServerLinkConfig, reply: dict[str, Any]
    ) -> None:
        if not reply.get("ok"):
            error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
            code = str(error.get("code") or "AUTH_FAILED")
            detail = str(error.get("message") or "")
            # AUTH_REJECTED means the credential is invalid or disabled and
            # BAD_REQUEST means this build sent a malformed deviceId: neither
            # resolves by asking again, and retrying turns a fixable error into a
            # silent one. That still holds for both of them.
            #
            # DEVICE_CONFLICT used to be listed here for the same reason, and it
            # no longer belongs: it is a statement about the id we offered rather
            # than about the credential, and the caller has already offered a
            # different one. Reaching here with it means even a brand-new id was
            # refused, which is not something asking again can fix either — so it
            # is terminal too, just for a different reason.
            if code == "DEVICE_CONFLICT":
                detail = (
                    "this machine is already registered to another account on "
                    "this server" + (f" ({detail})" if detail else "")
                )
            raise ServerLinkTerminated(
                f"auth.hello was rejected ({code})" + (f": {detail}" if detail else "")
            )
        payload = reply.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        member = str(payload.get("memberId") or "")
        # Recorded only now. The id becomes this machine's node in this account
        # because the server accepted it, not because we chose it — writing it
        # earlier would burn one on every refusal, and a member is capped at ten
        # devices. Claiming the same value again on the next reconnect is a
        # no-op, which is the ordinary case.
        await asyncio.to_thread(
            device_identity.claim_node_id,
            member,
            self._device_id,
            replacing=self._replacing_node_id,
        )
        await self._adopt_member(config, member)
        self.display_name = str(payload.get("displayName") or "")
        self.email_verified = bool(payload.get("emailVerified"))
        # Per connection, not per process: the server this dialled may be a
        # newer one than the last. A sticky flag meant a machine that met an old
        # server once kept the fallback for ever, and never noticed the upgrade.
        self._verify_fallback = False
        log.info(
            "navide-server link authenticated as member %s (%s) for device %s",
            self.member_id or "unknown",
            payload.get("displayName") or "",
            payload.get("deviceId") or "",
        )

    async def _adopt_member(self, config: ServerLinkConfig, claimed: str) -> None:
        """Settle who this machine is, from the pin rather than from the reply.

        ``auth.hello`` answers with a member id and that answer used to *be*
        this machine's identity, which made it the anchor a relay could move:
        name any id, then push a message whose ``from.memberId`` is the same id,
        and the delivery path read it as one of the user's own machines and
        skipped the policy. Pinning it per credential leaves the server able to
        say it once and never able to change its mind.

        The claimed id is still kept on ``member_id`` when the store cannot
        answer, because the Settings pane shows it and a blank there reads as
        "not signed in". It is not what any trust decision reads — see
        ``_own_device``, which consults the pin.
        """
        self.member_id = claimed
        self._own_member = ""
        try:
            self.member_id = await asyncio.to_thread(
                trust_store.adopt_own_member, config.url, config.token, claimed
            )
            # Held on the link rather than read back from the store: the pin is
            # per credential, and the store may hold several. Blank until a pin
            # is settled, which is what keeps `_own_device` from ever answering
            # yes on a machine whose identity is in doubt.
            self._own_member = self.member_id
            # A cache of the store's answer, and the only place it is written.
            # It needs its own sentence because the one above is about
            # `_own_member` and nothing else: that field is per credential and
            # genuinely belongs to the link, while this one is a property of the
            # store — whether this machine may do cross-device traffic at all.
            # It lives here because four hot paths read it (message delivery,
            # policy writes, the roster, the snapshot) and none of them should
            # touch the Keychain. The cost of caching it is that something has
            # to refresh it: adoption is the only writer, so anything that
            # changes the store's answer has to make adoption run again. That is
            # why `p2p.trust.rebuild` reconnects rather than clearing a string.
            self._trust_locked = ""
            await self._bind_sync_keyring(config, self.member_id)
        except trust_store.TrustStoreLocked as err:
            # The link stays up: the account view, the roster and the team
            # management calls do not depend on any of this, and dropping the
            # connection would hide the reason. Message traffic is what stops.
            self._trust_locked = str(err)
            sync_keyring.unbind()
            log.error("cross-device traffic is refused on this machine: %s", err)
            await self._announce_trust_notices()
        except Exception as err:  # noqa: BLE001
            self._trust_locked = f"the device trust store could not be opened ({err})"
            sync_keyring.unbind()
            log.error("cross-device traffic is refused on this machine: %s", err)
            await self._announce_trust_notices()

    async def _bind_sync_keyring(self, config: ServerLinkConfig, member_id: str) -> None:
        """Point the sync keyring at this account's ring, now that the pin says
        which account this is.

        The namespace is the address plus the pinned member, so signing out
        and back in lands on the same ring and a different account lands on a
        different one — which has none, and can read nothing written under
        the first. The ring the first version stored had no account on it.
        It is adopted here only when this credential is the only one this
        machine has ever pinned — same server, same member, by construction —
        so there is exactly one account it can belong to. Otherwise it is left where it is and said so, and the
        keyring refuses to mint until somebody with more evidence decides;
        a fresh key minted over it would orphan every record it wrote.
        """
        namespace = sync_keyring.namespace_for(config.url, member_id)
        sync_keyring.bind(namespace)
        # Named on every key operation this link dispatches off the loop, so
        # one that starts after a sign-out and a different sign-in is refused
        # rather than answered for the new account.
        self._sync_namespace = namespace
        await _note_account(namespace)
        try:
            if not await asyncio.to_thread(sync_keyring.legacy_ring_pending):
                return
            # Server and member both: the trust store's one pinned credential
            # is this (address, token), so the old ring can only have been
            # written while signed in here, as this member. A machine that
            # pinned any second credential — another server, another account,
            # or merely a second sign-in whose server the record does not
            # name — has no such evidence and gets the explicit route.
            sole = await asyncio.to_thread(
                trust_store.only_credential_ever, config.url, config.token
            )
        except Exception as err:  # noqa: BLE001 - an unreadable answer is not evidence
            log.warning("could not tell whether an older sync key needs adopting: %s", err)
            return
        if sole:
            # Attributable, but not adopted here. Adoption moves the key out of
            # the bare-name secret and deletes it, which an older release reads
            # as "no key" and answers by minting a fresh one — orphaning every
            # record the old key wrote, with no way back. A sign-in is not the
            # moment to make a one-way change nobody asked for, and
            # `sync.adopt_legacy_key` already exists for the moment somebody
            # does: `legacy_ring_pending` stays true, so Settings → Sync offers
            # it. That is also what this module says it does — "explicit, once,
            # never inferred" — which this call did not.
            log.info(
                "a sync key from before accounts were bound is stored here and "
                "belongs to %s; Settings offers adopting it",
                member_id,
            )
            return
        log.warning(
            "a sync key from before accounts were bound is stored here, and this "
            "machine has pinned more than one credential; it is not attributed "
            "to %s, and sync stays off for this account until it is adopted or "
            "discarded explicitly",
            member_id,
        )

    # ---- roster reporting ----

    async def _report_loop(self) -> None:
        while True:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._roster_dirty.wait(), ROSTER_SWEEP_S)
            self._roster_dirty.clear()
            await self._report_roster()
            await asyncio.sleep(ROSTER_DEBOUNCE_S)

    async def _report_roster(self) -> None:
        current = {entry.pane_id: _session_payload(entry) for entry in agent_messaging.list_panes()}
        if not self._synced:
            await self._sync(current)
            return
        for pane_id, payload in current.items():
            if self._reported.get(pane_id) == payload:
                continue
            if await self._upsert(pane_id, payload):
                self._reported[pane_id] = payload
        for pane_id in [p for p in self._reported if p not in current]:
            await self._remove(pane_id)

    def _with_session_id(self, pane_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        session_id = self._session_ids.get(pane_id)
        return dict(payload, sessionId=session_id) if session_id else dict(payload)

    async def _sync(self, current: dict[str, dict[str, Any]]) -> None:
        """Flatten the whole roster in one request, right after connecting.

        Reconnecting is the normal case across devices — network changes, sleep,
        a backend restart — so "how do the two sides realign" is the main path,
        not an edge one. A full sync is idempotent and lets the server drop
        whatever is no longer in the list; computing the difference ourselves is
        exactly the kind of code whose mistakes turn into ghost panes that show
        up in the roster and cannot be reached.
        """
        sessions = [self._with_session_id(pane_id, p) for pane_id, p in current.items()]
        reply = await self._request("sessions.sync", {"sessions": sessions})
        if not reply.get("ok"):
            log.warning("navide-server rejected sessions.sync: %s", reply.get("error"))
            return
        result = reply.get("payload")
        rows = result.get("sessions") if isinstance(result, dict) else None
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            pane_id = str(row.get("paneId") or "")
            session_id = str(row.get("sessionId") or "")
            if pane_id and session_id:
                self._session_ids[pane_id] = session_id
        self._reported = dict(current)
        self._synced = True

    async def _remove(self, pane_id: str) -> None:
        """Drop one closed pane without waiting for the next full sync."""
        session_id = self._session_ids.get(pane_id)
        if session_id:
            reply = await self._request("sessions.remove", {"sessionId": session_id})
            # SESSION_GONE: the server no longer has it, which is what removing wanted.
            if not reply.get("ok") and self._conflict_code(reply) != "SESSION_GONE":
                # Retried on the next sweep, and swept up by the sync after the
                # next reconnect either way.
                log.warning(
                    "navide-server rejected sessions.remove for pane %s: %s",
                    pane_id,
                    reply.get("error"),
                )
                return
        self._reported.pop(pane_id, None)
        self._session_ids.pop(pane_id, None)

    async def _upsert(self, pane_id: str, payload: dict[str, Any]) -> bool:
        reply = await self._request("sessions.upsert", self._with_session_id(pane_id, payload))
        if not reply.get("ok"):
            # A per-session rejection is not a connection problem: log it and
            # keep the rest of the roster flowing.
            log.warning(
                "navide-server rejected sessions.upsert for pane %s: %s",
                pane_id,
                reply.get("error"),
            )
            return False
        result = reply.get("payload")
        issued = str(result.get("sessionId") or "") if isinstance(result, dict) else ""
        if issued:
            self._session_ids[pane_id] = issued
        return True

    # ---- pane policy ----

    async def _refresh_policy(self, *, revision: int | None = None) -> None:
        """Fetch this device's pane policy, unless the cache is already at
        *revision*.

        Never raises: a policy this device cannot fetch leaves the previous
        cache in force, and a device that has never fetched one denies
        everything (``pane_policy.is_allowed`` treats None as unusable). Both
        are safe states, and neither is worth dropping the connection over.
        """
        if revision is not None and revision == self._policy_revision:
            return
        try:
            reply = await self._request("policy.get", {"deviceId": self._device_id})
        except Exception as err:  # noqa: BLE001
            log.warning("navide-server policy.get failed: %s", err)
            return
        if not reply.get("ok"):
            log.warning("navide-server rejected policy.get: %s", reply.get("error"))
            return
        payload = reply.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        raw_revision = payload.get("revision")
        # The revision is adopted whatever the document turns out to be: it is
        # only the "have I already fetched this one" hint, and leaving it unset
        # after a document that failed to verify would re-fetch the same bad
        # document on every push.
        self._policy_revision = raw_revision if isinstance(raw_revision, int) else 0
        self._policy = await asyncio.to_thread(self._verified_policy, payload.get("policy"))
        log.info("navide-server pane policy is at revision %s", self._policy_revision)

    def _verified_policy(self, raw: Any) -> Any:
        """The policy this machine will enforce, or None when there is none.

        The server stores this document and hands it back, which means the
        server chooses *which* document comes back — and ``pane_policy`` reads
        whatever it is given. It reads it very carefully (an unknown version
        fails closed, a malformed rule is skipped rather than voiding the rest),
        but every one of those checks is about a *malformed* policy. None of
        them notices a well-formed policy this machine never wrote, and
        ``{"version":1,"default":"allow","rules":[]}`` is well formed.

        So the document carries a signature this device made with its own key,
        over its own sequence number. Two things are checked and the second is
        the one that needed thinking about:

        *The signature verifies against our own signing key.* Nobody else can
        produce it, the server included — it has never held the private half.

        *The sequence is not behind the highest one we ever signed.* Not the
        server's ``revision``: that number is issued by the server, so using it
        for monotonicity would be asking the party with a motive to roll the
        policy back to certify that it had not.

        Anything that does not pass is not a policy. Returning None rather than
        the previous cache is deliberate — ``pane_policy.is_allowed(None)``
        denies everything, which is the state a device that never wrote a policy
        is already in, and the system handles it.
        """
        if self._trust_locked:
            return None
        # Keyed on the id this machine presents to *this* account, so signing in
        # as somebody else starts a new sequence at zero.
        #
        # That reads like a replay hole and is not one — and the reason is three
        # lines down, which is where the next person to notice should look
        # before concluding otherwise. The sequence is the *second* gate. The
        # first is the signature, and `device_signing.policy_payload` covers
        # `{"deviceId", "seq", "policy"}` — so a document signed under the id
        # this machine used to present fails verification here under the new
        # one, and never reaches the comparison. A fresh identity has signed
        # nothing, so there is no document bound to it to replay either.
        #
        # Carrying the old sequence forward would be the actual bug: revisions
        # 1..N under the new identity would all be refused as stale, and the
        # symptom is a user changing a rule and nothing happening.
        seq = trust_store.policy_seq(self._device_id)
        if not isinstance(raw, dict):
            if seq:
                trust_store.note_policy_unverified(
                    "the server returned no policy document", device_id=self._device_id
                )
            return None
        document = {key: value for key, value in raw.items() if key != POLICY_SIGNATURE_FIELD}
        envelope = raw.get(POLICY_SIGNATURE_FIELD)
        if not isinstance(envelope, dict):
            # A device that has never written a policy gets the server's empty
            # deny-everything stand-in, which carries no signature and is not an
            # attack. Once this machine *has* signed one, an unsigned document
            # in its place is a replacement, and says so.
            if seq:
                trust_store.note_policy_unverified(
                    "the stored policy carries no signature", device_id=self._device_id
                )
            return None
        offered = envelope.get("seq")
        if isinstance(offered, bool) or not isinstance(offered, int):
            trust_store.note_policy_unverified(
                "the stored policy has no usable sequence", device_id=self._device_id
            )
            return None
        if offered < seq:
            trust_store.note_policy_unverified(
                "the stored policy is older than the last one written here",
                device_id=self._device_id,
                seq=offered,
            )
            return None
        if not device_signing.verify_policy(
            str(envelope.get("sig") or ""),
            public_key_b64=device_signing.public_key(),
            device_id=self._device_id,
            seq=offered,
            document=document,
        ):
            trust_store.note_policy_unverified(
                "the stored policy was not signed by this machine",
                device_id=self._device_id,
                seq=offered,
            )
            return None
        trust_store.note_policy_seq(self._device_id, offered)
        trust_store.clear_policy_notice()
        return document

    def policy_snapshot(self) -> dict[str, Any]:
        """The cached policy and the revision it came at, for the editor UI.

        Reads the cache rather than the server: the cache is what actually
        decides every inbound message, and it survives a disconnect, so the
        editor can still show the rules that are refusing messages while the
        link is down.
        """
        return {"policy": self._policy, "revision": self._policy_revision}

    def _signed_policy(self, policy: Any) -> Any:
        """Wrap *policy* in this device's own signature. Blocking (Keychain).

        The sequence is reserved — and written down — before the document goes
        out, so a write that fails burns a number instead of leaving one that
        could be reused. Reusing one would let the server replay whichever older
        document shared it, which is the whole check.
        """
        document = policy
        if isinstance(policy, dict):
            document = {k: v for k, v in policy.items() if k != POLICY_SIGNATURE_FIELD}
        seq = trust_store.reserve_policy_seq(self._device_id)
        signature = device_signing.sign_policy(
            device_id=self._device_id, seq=seq, document=document
        )
        return {**document, POLICY_SIGNATURE_FIELD: {"seq": seq, "sig": signature}}

    def _trust_refusal(self) -> dict[str, Any]:
        """Why this machine will not carry cross-device traffic right now."""
        return {
            "ok": False,
            "error": {
                "code": LINK_TRUST_UNAVAILABLE,
                "message": (
                    "Navide cannot read this machine's cross-device trust record, so "
                    "it cannot tell one device from another; cross-device messages "
                    "are refused until that is resolved"
                    + (f" ({self._trust_locked})" if self._trust_locked else "")
                ),
            },
        }

    async def set_policy(self, policy: Any) -> dict[str, Any]:
        """Write this device's policy to the server and adopt the new revision.

        Same shape as ``send_message``: the server's reply frame, or a locally
        minted error frame naming the link state when the write cannot leave
        this machine. Only the device itself (or an admin) may write its policy,
        so there is no target to name beyond our own deviceId.
        """
        if self._ws is None or not self._authenticated:
            return self._unavailable()
        if self._trust_locked:
            return self._trust_refusal()
        try:
            signed = await asyncio.to_thread(self._signed_policy, policy)
        except Exception as err:  # noqa: BLE001
            log.warning("could not sign the pane policy: %s", err)
            return self._trust_refusal()
        try:
            reply = await self._request(
                "policy.set", {"deviceId": self._device_id, "policy": signed}
            )
        except Exception as err:  # noqa: BLE001
            log.warning("navide-server policy.set failed: %s", err)
            return {
                "ok": False,
                "error": {
                    "code": LINK_OFFLINE,
                    "message": (
                        f"the navide-server link failed mid-request ({err}); it "
                        f"reconnects on its own, so retry shortly"
                    ),
                },
            }
        if reply.get("ok"):
            payload = reply.get("payload")
            revision = payload.get("revision") if isinstance(payload, dict) else None
            if isinstance(revision, int) and not isinstance(revision, bool):
                # Adopt what was just written instead of waiting for the
                # policy.changed push: that push is only a nudge, and
                # _refresh_policy skips a revision the cache already holds, so a
                # UI re-reading right after the save must not be shown the
                # policy it just replaced.
                self._policy = policy
                self._policy_revision = revision
                trust_store.clear_policy_notice()
            else:
                # No revision to pin the cache to — re-read rather than guess,
                # since a cache pinned to the wrong revision would ignore the
                # very push that would have corrected it.
                await self._refresh_policy()
        return reply

    async def resend_verification(self) -> dict[str, Any]:
        """Ask the server to re-send this account's verification mail.

        Same shape as ``set_policy``: the server's reply frame, or a locally
        minted error frame naming the link state. The server rate-limits and
        owns the token, so this side neither retries nor invents a cooldown —
        RATE_LIMITED is an answer to show, not one to swallow.
        """
        if self._ws is None or not self._authenticated:
            return self._unavailable()
        try:
            reply = await self._request("auth.verify.resend", {})
        except Exception as err:  # noqa: BLE001
            log.warning("navide-server auth.verify.resend failed: %s", err)
            return {
                "ok": False,
                "error": {
                    "code": LINK_OFFLINE,
                    "message": (
                        f"the navide-server link failed mid-request ({err}); it "
                        f"reconnects on its own, so retry shortly"
                    ),
                },
            }
        if reply.get("ok"):
            payload = reply.get("payload")
            if isinstance(payload, dict) and payload.get("emailVerified"):
                # The user confirmed in a browser since this link authenticated;
                # adopt it now rather than making them wait for a reconnect.
                self.email_verified = True
        return reply

    # ---- cross-account shares ----

    async def _carry(self, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        """One request over the authenticated link, in the reply-frame shape.

        Same contract as ``set_policy`` and ``resend_verification``: the
        server's reply frame, or a locally minted error frame naming the link
        state when the request cannot leave this machine. Nothing is retried
        and nothing is interpreted — the server's own codes come through as
        they are, so the handler can show them.
        """
        if self._ws is None or not self._authenticated:
            return self._unavailable()
        try:
            return await self._request(msg_type, payload)
        except Exception as err:  # noqa: BLE001
            log.warning("navide-server %s failed: %s", msg_type, err)
            return {
                "ok": False,
                "error": {
                    "code": LINK_OFFLINE,
                    "message": (
                        f"the navide-server link failed mid-request ({err}); it "
                        f"reconnects on its own, so retry shortly"
                    ),
                },
            }

    async def create_share(
        self, *, blob: str, size_bytes: int, ttl_seconds: int
    ) -> dict[str, Any]:
        """Store one sealed bundle. The server sees the ciphertext and its size;
        the key never appears in this payload because there is no field for it."""
        return await self._carry(
            "shares.create",
            {"blob": blob, "sizeBytes": size_bytes, "ttlSeconds": ttl_seconds},
        )

    async def claim_share(self, share_id: str) -> dict[str, Any]:
        """Fetch one sealed bundle by id. Opening it is the caller's job."""
        return await self._carry("shares.claim", {"shareId": share_id})

    async def list_shares(self) -> dict[str, Any]:
        """The shares this account published and has not revoked."""
        return await self._carry("shares.list", {})

    async def revoke_share(self, share_id: str) -> dict[str, Any]:
        return await self._carry("shares.revoke", {"shareId": share_id})

    async def list_devices(self) -> dict[str, Any]:
        """The account's devices as the server knows them, for the sharing view."""
        return await self._carry("devices.list", {})

    async def _on_account_verified(self) -> None:
        """The server says this account's address is confirmed."""
        if self.email_verified:
            return
        self.email_verified = True
        log.info("navide-server says this account's email address is verified")
        await self._announce_link_changed()

    async def _announce_link_changed(self) -> None:
        """Tell every window the account header changed under it.

        The account view polls ``p2p.link.status`` while it is open, so this is
        not the only way the news travels — but polling is what made the
        verification notice stale for as long as it was, and a surface that is
        not polling (or is polling something else) has no other signal.
        """
        from . import app
        from .ipc import make_event

        await app.broadcast(make_event("p2p.link.changed", {"status": await status()}))

    async def check_verification(self) -> dict[str, Any]:
        """Ask the server now whether the address has been confirmed.

        The button behind "clicked the link and nothing happened?". Same answer
        shape as the other request wrappers: the server's reply, or a locally
        minted error naming the link state.
        """
        if self._ws is None or not self._authenticated:
            return self._unavailable()
        verified = await self._read_account_status()
        if verified is None:
            # Either the server cannot answer this or the request failed. What
            # this machine currently believes is the honest answer; inventing a
            # reconnect here to go and find a better one is what turned the
            # first version of this into a loop.
            return {"ok": True, "payload": {"emailVerified": self.email_verified}}
        return {"ok": True, "payload": {"emailVerified": verified}}

    async def _read_account_status(self) -> bool | None:
        """``account.status``, or None when this server cannot answer it.

        None covers both "too old to know the verb" and "the request failed",
        because the caller does the same thing with either: fall back, and leave
        what this machine already believes alone. Distinguishing them here would
        only matter if one of them were recoverable by asking again, and neither
        is within the same connection.
        """
        try:
            reply = await self._request("account.status", {})
        except Exception as err:  # noqa: BLE001
            log.debug("navide-server account.status failed: %s", err)
            return None
        if reply.get("ok"):
            payload = reply.get("payload")
            payload = payload if isinstance(payload, dict) else {}
            return bool(payload.get("emailVerified"))
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        if str(error.get("code") or "") == "UNKNOWN_TYPE":
            if not self._verify_fallback:
                self._verify_fallback = True
                log.info(
                    "navide-server does not know account.status; asking every "
                    "%.0fs instead of every %.0fs until it does",
                    VERIFY_RETRY_S,
                    VERIFY_POLL_S,
                )
        return None

    async def _verify_loop(self) -> None:
        """Keep asking whether the address is confirmed, until it is.

        Nothing pushed the answer before this existed: ``auth.hello`` carried it
        and there was no second read, so somebody who confirmed in their browser
        watched "we sent you a link" until the next restart. ``account.verified``
        is the real fix and this is what covers the server that cannot send it.

        Returns rather than idles once the answer is yes, which ends the task
        for the life of the connection.
        """
        while not self.email_verified:
            await asyncio.sleep(
                VERIFY_RETRY_S if self._verify_fallback else VERIFY_POLL_S
            )
            if self.email_verified:
                return
            # Asked again even on a server that did not know the verb last time,
            # just less often. The first version dropped the connection instead,
            # to force a fresh auth.hello — which put a reconnect on a timer
            # inside a loop that reconnects on its own, and there is no version
            # of that idea that is worth what it costs. A server that gets
            # upgraded under a running link starts answering this on its own.
            verified = await self._read_account_status()
            if verified:
                self.email_verified = True
                log.info("navide-server says this account's email address is verified")
                await self._announce_link_changed()
                return

    async def _on_policy_changed(self, payload: Any) -> None:
        """The server says this device's policy moved. Re-fetch only if the
        revision differs from the cached one — the event is a nudge, not the
        policy itself, and re-fetching on every nudge would put the control
        plane back in the path of each message."""
        data = payload if isinstance(payload, dict) else {}
        revision = data.get("revision")
        await self._refresh_policy(revision=revision if isinstance(revision, int) else None)

    # ---- remote roster ----

    async def _refresh_directory(self) -> None:
        """Read the team space's whole session directory into the local cache.

        Never raises, for the same reason ``_refresh_policy`` does not: a
        directory this device could not fetch leaves the previous cache in
        force, which is a worse answer than the truth but a far better one than
        an empty roster or a dropped connection.
        """
        try:
            reply = await self._request("sessions.directory", {})
        except Exception as err:  # noqa: BLE001
            log.warning("navide-server sessions.directory failed: %s", err)
            return
        if not reply.get("ok"):
            log.warning("navide-server rejected sessions.directory: %s", reply.get("error"))
            return
        self._apply_directory(reply.get("payload"))

    def _apply_directory(self, payload: Any) -> None:
        """Replace the remote roster from a directory payload.

        ``sessions.directory`` and the ``sessions.changed`` push carry the same
        shape — the entire directory, this device's own rows included — so both
        land here and both replace wholesale. Our own rows are dropped by
        ``remote_roster.replace``: the server's copy of them is whatever was
        last reported, while ``agent_messaging`` holds the live ones.

        The rows may carry a ``deviceName`` (the server joins the one
        ``auth.hello`` gave it onto every session row); they may equally not,
        because an older server does not. Every reader here falls back to the
        device id, which is always present.

        The raw rows are also kept whole in ``_directory``, local ones included,
        for ``network_snapshot`` — see the note on that field.
        """
        data = payload if isinstance(payload, dict) else {}
        sessions = data.get("sessions")
        rows = sessions if isinstance(sessions, list) else []
        remote_roster.replace(rows, local_device_id=self._device_id)
        # Capped like the roster cache, and for the same reason: the directory
        # is filled by other machines, so it is only as small as they are well
        # behaved.
        self._directory = [row for row in rows if isinstance(row, dict)][
            : remote_roster.MAX_PANES
        ]

    def _on_presence_changed(self, payload: Any) -> None:
        """Re-flag the cached panes when a device joins or leaves.

        A device going offline changes no session row, so it produces no
        ``sessions.changed`` — only this event. Without it the roster would go
        on reporting a machine that has left as reachable until something else
        happened to touch one of its sessions.
        """
        data = payload if isinstance(payload, dict) else {}
        devices = data.get("devices")
        if not isinstance(devices, list):
            return
        online = {
            str(device.get("deviceId") or "")
            for device in devices
            if isinstance(device, dict)
        }
        online.discard("")
        # Kept as well as pushed down, because ``network_snapshot`` has to be
        # able to answer for a device the directory holds no session for.
        self._online_devices = online
        remote_roster.set_online_devices(online)

    async def ensure_directory(self) -> None:
        """Read the directory once if this connection has not carried one yet.

        Every connection fetches it at authentication time and the
        ``sessions.changed`` push keeps it current after that, so this is only
        ever the first read of a link whose fetch failed. It exists so the
        network view is not blank for a whole poll interval in that case.
        """
        if self._directory is None and self.state() == STATE_CONNECTED:
            await self._refresh_directory()

    def _device_name_for(self, device_id: str) -> str:
        """The label the directory knows this device by, or "" — a knock from a
        machine the directory has not mentioned yet still has to be showable."""
        for raw in self._directory or []:
            if str(raw.get("deviceId") or "") == device_id:
                return str(raw.get("deviceName") or "")
        return ""

    async def _announce_access_requests(self) -> None:
        """Tell every window that the knock list changed.

        Broadcast rather than addressed: the list belongs to the machine, not
        to a workspace, and whichever window has the account view open is the
        one that should light up.
        """
        from . import app
        from .ipc import make_event

        await app.broadcast(
            make_event("p2p.access_requests.changed", {"requests": self._access_requests.list()})
        )

    def access_requests(self) -> list[dict[str, Any]]:
        return self._access_requests.list()

    def forget_access_request(self, key: str) -> bool:
        return self._access_requests.forget(key)

    def forget_access_requests_for_device(self, device_id: str) -> int:
        return self._access_requests.forget_device(device_id)

    def network_snapshot(self) -> dict[str, Any]:
        """Every device in this team space, and the panes running on each.

        Answered from the cache whatever the link is doing: a link that dropped
        a second ago does not make the other machines stop existing, and an
        empty list would read as "nobody is signed in". ``state`` is the honest
        half.

        Unlike ``remote_roster`` this keeps this device's own rows. Addressing
        must not see them (the live local roster is the truth there), but the
        whole point of this view is the whole network, and the machine the user
        is sitting at is the one row they can recognise.
        """
        devices: dict[str, dict[str, Any]] = {}
        local = self._device_id
        # This machine knows more about its own panes than the server does. The
        # roster it publishes has four words to spend and "disconnected" is the
        # closest of them to a placeholder, but locally there is no reason to
        # read that compromise back: the registry holds the realized flag
        # itself. Same reason the local row's `online` is taken from the link
        # rather than from presence below — for this one device, the server is
        # not the better-informed party.
        unopened_here = {
            entry.pane_id for entry in agent_messaging.list_panes() if not entry.realized
        }
        # Likewise which window an embedded AI panel lives in: the server drops
        # the keys, the registry has them.
        panels_here = {
            entry.pane_id: entry for entry in agent_messaging.list_panes() if entry.surface
        }

        def entry(device_id: str, device_name: str) -> dict[str, Any]:
            row = devices.get(device_id)
            if row is None:
                row = {
                    "deviceId": device_id,
                    "deviceName": device_name,
                    "isLocal": bool(local) and device_id == local,
                    "online": False,
                    "paneCount": 0,
                    "panes": [],
                }
                devices[device_id] = row
            elif not row["deviceName"] and device_name:
                row["deviceName"] = device_name
            return row

        # This machine is listed even with nothing running on it: "no devices"
        # and "one device with no panes" are different answers, and the second
        # is the one a user who has only just signed in is looking at.
        if local:
            entry(local, self._device_name)

        for raw in self._directory or []:
            device_id = str(raw.get("deviceId") or "")
            if not device_id:
                continue
            row = entry(device_id, str(raw.get("deviceName") or ""))
            pane_id = str(raw.get("paneId") or "")
            status = str(raw.get("status") or "")
            if device_id == local and pane_id in unopened_here:
                status = STATUS_NOT_OPENED
            row["panes"].append(
                {
                    "sessionId": str(raw.get("sessionId") or ""),
                    "paneId": pane_id,
                    "agentKey": str(raw.get("agentKey") or ""),
                    "title": str(raw.get("title") or ""),
                    "workspace": str(raw.get("workspace") or ""),
                    "workspacePath": str(raw.get("workspacePath") or ""),
                    # As the server spelled it, except for this device's own
                    # unopened panes (above): the four values it defines are
                    # translated by the UI, and one this build has never heard
                    # of is shown raw rather than hidden.
                    "status": status,
                    "hostOnline": bool(raw.get("hostOnline")),
                    "startedAt": str(raw.get("startedAt") or ""),
                    **_panel_window(raw, panels_here.get(pane_id) if device_id == local else None),
                }
            )
        for row in devices.values():
            row["paneCount"] = len(row["panes"])
            # The newest thing the directory says about this machine. The server
            # publishes no device-level last-seen, so the freshest session start
            # is the closest honest answer — and an offline row with no date at
            # all reads as "gone", which is not what the roster means.
            row["lastSeenAt"] = max(
                (pane["startedAt"] for pane in row["panes"] if pane["startedAt"]),
                default="",
            )
            row["panes"].sort(key=lambda pane: (pane["workspace"], pane["title"]))
            if row["isLocal"]:
                # Presence is what the *server* can see, and the only thing it
                # can see of this machine is the link being reported on here.
                row["online"] = self.state() == STATE_CONNECTED
            elif self._online_devices is not None:
                row["online"] = row["deviceId"] in self._online_devices
            else:
                # No presence.changed has arrived yet, so the per-session flag
                # is the only thing that has been said about this machine.
                row["online"] = any(pane["hostOnline"] for pane in row["panes"])
            # Where this device stands with *this* machine. The list used to say
            # nothing about it, so a device you had never vouched for looked
            # exactly like one you had — same row, same unpair button — while
            # the card above was asking you to confirm it. Two surfaces, one
            # device, opposite stories.
            device_id = str(row.get("deviceId") or "")
            row["trustState"] = self._trust_state(device_id, is_local=bool(row.get("isLocal")))
            # Whether this row can be paired from here, without waiting for the
            # other machine to send anything. True needs three things: it is
            # undecided, the directory advertises a key to pin, and that key is
            # attributed to this account — pairing on sight is for your own
            # machines, and anyone else's still has to knock first.
            advertised = remote_roster.sign_public_key_for(device_id)
            row["canTrust"] = (
                # Pairing needs both machines present: the exchange is four
                # frames and two people. Offering it against a device that is
                # offline produces a card that waits five minutes and expires,
                # which reads as the button being broken.
                bool(row["online"])
                # Never on an unknown state: offering to pair while the record
                # that says whether we already are cannot be read is offering
                # something this machine cannot check.
                and row["trustState"] == "pending"
                and bool(advertised)
                and bool(self._own_member)
                and self._member_id_for(device_id) == self._own_member
            )
            # The one part of a pairing a server cannot fake, so it has to reach
            # the surface where the pairing is offered. Same digest the pending
            # card compares — vouching from here is the same act, and two
            # different-looking fingerprints for one machine would make the
            # comparison impossible to trust.
            row["signFingerprint"] = (
                device_signing.fingerprint(advertised) if row["canTrust"] else ""
            )
        return {
            "state": self.state(),
            "deviceId": local,
            "memberId": self.member_id,
            # Folded into the same read as the devices for the reason given
            # above them: this view is polled while it is open, and a separate
            # round trip per list would be another chance to draw a picture
            # that is half one moment and half the next. Both are local state —
            # the ledger is in memory here, the block list is in the policy
            # this machine already holds — so neither costs the server
            # anything.
            "accessRequests": self._access_requests.list(),
            "blocked": device_trust.blocked_entries(self._policy),
            # Two things a person has to be told, folded into the same read:
            # a device seen for the first time (a narrative — this is what got
            # pinned) and a pinned device whose key has changed (a refusal in
            # force, with both fingerprints, because "they reinstalled" and
            # "somebody is standing in for them" look identical from here).
            "trustNotices": trust_store.notices(),
            # Pinned devices nobody has vouched for yet. Separate from the
            # notices because a notice can be dismissed and this question
            # cannot be retired by dismissing anything.
            "trustPending": self._pending_approvals(),
            # Exchanges waiting on a person, at either end. Folded into the same
            # read as everything else for the reason given above them: a card
            # asking "do these digits match" must not be half a poll behind the
            # device list it is about.
            "pairings": self.pairing_rows(),
            "trustLocked": self._trust_locked,
            # No rules written under this identity yet, so `is_allowed(None)`
            # refuses everything inbound. That is the correct state — it is
            # where a device that never wrote a policy already is — but it is
            # invisible, and it is now reachable by *recovering*: a machine that
            # heals a DEVICE_CONFLICT lands on a new identity with no rules, and
            # would otherwise sit there connected, apparently fine, receiving
            # nothing. Saying so is the difference between a recovery and a
            # quieter failure.
            "policyEmpty": self._policy is None,
            # Whether that stop is a read that may succeed next time. The card
            # says the same thing either way; what waits on this is the offer to
            # erase everything, which has nothing to erase when the keychain was
            # merely locked for a moment.
            "trustLockedTransient": trust_store.transient_lock(),
            # This device first, then by label: the row a user recognises is
            # the one that should not move as other machines come and go.
            "devices": sorted(
                devices.values(),
                key=lambda d: (not d["isLocal"], d["deviceName"] or d["deviceId"]),
            ),
        }

    # ---- messages ----

    async def _sealed_for(self, to_device: str, text: str) -> dict[str, Any]:
        """What to put on the wire for one recipient: ``cipher`` or ``text``.

        Two rules, and the second is the one that matters:

        *Encrypt whenever the recipient has published a key.* The key travels
        with the session directory, so "has a key" and "is visible to me" are
        the same condition.

        *Never go back to plaintext for a device that once had one.* Without
        this the encryption would be advisory: anything that could make a key
        disappear — a stale roster, a server that omitted the field, a peer
        reconnecting from an older build — would silently turn ciphertext back
        into cleartext, and nothing on either end would say so. Once a peer has
        been seen with a key, a message that cannot be sealed is refused
        instead.

        *A pinned encryption key outranks the directory.* A completed pairing
        pins the X25519 key the six digits covered, and for that device the
        message is sealed to the pin. A directory that then advertises some
        other key is the substitution the pin exists to catch, and the send is
        refused rather than addressed to whoever the relay named. A pin taken
        before the encryption key was part of the exchange holds none, and for
        that device the two rules above still apply as they always did.
        """
        key = remote_roster.public_key_for(to_device)
        pinned = await asyncio.to_thread(trust_store.pinned_encryption_key, to_device)
        if pinned:
            if key and key != pinned:
                raise device_crypto.CryptoError(
                    "the directory names a different encryption key for this device "
                    "than the one its pairing pinned"
                )
            key = pinned
        if key:
            sealed = {
                "cipher": device_crypto.seal(
                    text,
                    recipient_public_key=key,
                    from_device=self._device_id,
                    to_device=to_device,
                )
            }
            # Recorded after sealing and on disk, not before and in memory: the
            # record is what makes the *next* send refuse a vanished key, and a
            # record that did not survive a restart made that refusal a promise
            # the relay only had to wait out.
            try:
                await asyncio.to_thread(trust_store.note_encrypted_peer, to_device)
            except Exception as err:  # noqa: BLE001
                raise device_crypto.CryptoError(
                    f"this device could not record that {to_device} is encrypted ({err})"
                ) from err
            return sealed
        if trust_store.is_encrypted_peer(to_device):
            raise device_crypto.CryptoError("this device published a key before and none is known now")
        # Never seen a key: an un-upgraded peer, which can only read plaintext.
        return {"text": text}

    async def send_message(
        self,
        *,
        to: dict[str, Any],
        sender: dict[str, Any] | None,
        text: str,
        msg_key: str,
    ) -> dict[str, Any] | None:
        """Relay one message to a pane on another device.

        Returns the server's reply frame, or — when this link exists but cannot
        carry the message right now — a locally minted error frame naming the
        link state (see LINK_OFFLINE / LINK_UNAUTHORIZED). It never returns
        None: a ServerLink instance only exists once a server was configured,
        so "there is no link" is the module-level caller's answer, not this
        one's.
        """
        if self._ws is None or not self._authenticated:
            return self._unavailable()
        if self._trust_locked:
            return self._trust_refusal()
        to_device = str(to.get("deviceId") or "")
        try:
            body = await self._sealed_for(to_device, text)
        except device_crypto.CryptoError as err:
            # Refused rather than downgraded. A message that silently went out
            # as plaintext because sealing failed would be the one case the
            # user has no way to notice.
            log.warning("refusing to send unencrypted to %s: %s", to_device, err)
            return {
                "ok": False,
                "error": {
                    "code": LINK_ENCRYPTION_FAILED,
                    "message": (
                        "this message could not be encrypted for that device, and "
                        "Navide does not fall back to sending it in the clear"
                    ),
                },
            }
        kind = BODY_CIPHER if BODY_CIPHER in body else BODY_TEXT
        try:
            signature = await asyncio.to_thread(
                device_signing.sign_message,
                msg_key=msg_key,
                from_device=self._device_id,
                to_device=to_device,
                kind=kind,
                body=body[kind],
            )
        except device_signing.SigningError as err:
            # Refused rather than sent unsigned, for the same reason a message
            # that cannot be sealed is refused rather than sent in the clear:
            # the far side would reject it anyway, and an unsigned message that
            # somehow got through would be one nobody could attribute.
            log.warning("refusing to send an unsigned message to %s: %s", to_device, err)
            return self._trust_refusal()
        payload: dict[str, Any] = {"to": to, "msgKey": msg_key, "sig": signature, **body}
        if sender:
            payload["from"] = sender
        try:
            reply = await self._request("messages.send", payload)
            if reply.get("ok"):
                self._note_outbound(msg_key, to)
            return reply
        except Exception as err:  # noqa: BLE001
            log.warning("navide-server messages.send failed: %s", err)
            return {
                "ok": False,
                "error": {
                    "code": LINK_OFFLINE,
                    "message": (
                        f"the navide-server link failed mid-request ({err}); it "
                        f"reconnects on its own, so retry shortly"
                    ),
                },
            }

    def _unavailable(self) -> dict[str, Any]:
        """Why this configured link cannot carry a message at this instant.

        Fails immediately rather than waiting on a socket that is not there:
        the reconnect loop is the only thing that can change the answer, and it
        runs on its own schedule, so blocking the sender for REQUEST_TIMEOUT_S
        would only turn a clear error into a slow one.

        **The message names which kind of "not connected" this is.** It used to
        say only that the link was configured and not connected, and to retry
        shortly — advice that is right for exactly one of the three states it
        covered. Somebody whose token had been rejected, or whose server address
        was wrong, was told to wait, and waiting was never going to fix it. The
        parts also travel as fields, so a caller that renders its own sentence
        does not have to match on this one's prose.
        """
        state = self.state()
        now = time.time()
        if self.terminated_reason:
            return {
                "ok": False,
                "error": {
                    "code": LINK_UNAUTHORIZED,
                    "message": (
                        f"the navide-server link is unauthorized: "
                        f"{self.terminated_reason} — sign in again"
                    ),
                    "state": state,
                    "lastError": self.terminated_reason,
                    "nextRetryInS": None,
                },
            }
        if state == STATE_WAITING_KEYCHAIN:
            detail = self.keychain_wait_reason()
            return {
                "ok": False,
                "error": {
                    "code": LINK_OFFLINE,
                    "message": detail,
                    "state": state,
                    "lastError": detail,
                    "nextRetryInS": None,
                },
            }
        if state == STATE_UNREACHABLE:
            since = max(0, int(now - self.last_error_at)) if self.last_error_at else 0
            retry_in = max(0, int(self.next_retry_at - now)) if self.next_retry_at else 0
            detail = (
                f"the navide-server link is unreachable: {self.last_error} "
                f"(last try {since}s ago, next in {retry_in}s)"
            )
        else:
            waited = max(0, int(now - self.connecting_since))
            detail = f"the navide-server link is connecting (started {waited}s ago)"
        return {
            "ok": False,
            "error": {
                "code": LINK_OFFLINE,
                "message": detail,
                "state": state,
                "lastError": self.last_error,
                "nextRetryInS": (
                    max(0, int(self.next_retry_at - now)) if self.next_retry_at else None
                ),
            },
        }

    async def _note_inbound(self, msg_key: str) -> bool:
        """Claim a msgKey. False means it was already handled — drop it.

        The server pushes ``messages.pending`` to every connection it holds for
        this device. That is one connection in the steady state, but a backend
        restart can leave the old socket open a moment after the new one is up,
        and then the same message arrives twice.

        The in-memory half above answers the ordinary case — the same socket
        pair, seconds apart. The persisted half answers the one a relay can
        arrange: hold a delivered message, wait for a backend restart, push it
        again. That wait used to be all it took, because this map was rebuilt
        empty every time the process came up, and a restart is a daily event
        rather than something anyone has to engineer.
        """
        if msg_key in self._inbound:
            return False
        now = time.monotonic()
        for key, entry in list(self._inbound.items()):
            if now - entry["created_at"] >= MESSAGE_MEMORY_TTL_S:
                del self._inbound[key]
        # Insertion-ordered, so the front of the dict is the oldest message.
        while len(self._inbound) >= MESSAGE_MEMORY_MAX:
            self._inbound.pop(next(iter(self._inbound)))
        # Claimed before any await. Everything above is synchronous on purpose:
        # the first `await` below yields the loop, and two pushes of the same
        # key would otherwise both get past the membership check while the first
        # was still in a thread — which is the duplicate this method exists to
        # stop, reintroduced by the fix for something else.
        self._inbound[msg_key] = {"created_at": now, "pane_id": "", "acked": False}

        # The persisted half, off the loop. A cold cache makes the read a
        # Keychain read and every 25th record a Keychain write; every other
        # trust_store call on this path already goes through a thread for that
        # reason, and a stalled loop in this backend is a symptom that has cost
        # this project real time before.
        #
        # Checked after the claim rather than before: the claim is what makes
        # the check race-free, and a key already in the ledger is simply left
        # marked handled in memory too.
        if await asyncio.to_thread(trust_store.has_seen_message, msg_key):
            return False
        # Recorded on the claim rather than after delivery: a message that got
        # this far has been handed to the delivery path, and re-running that
        # path is the thing being prevented.
        await asyncio.to_thread(trust_store.note_seen_message, msg_key)
        return True

    async def _authenticate_sender(
        self, data: dict[str, Any], *, msg_key: str, device_id: str, member_id: str
    ) -> bool | None:
        """Whether this message really came from *device_id*, and whether that
        device is one of ours. None means it did not, and must be refused.

        The chain this closes: the relay filled ``from`` and it filled the
        answer to ``auth.hello``, so it could write the same member id into both
        and the delivery path read the result as one of the user's own machines
        — which skips the pane policy outright. Encryption did not help, because
        a sealed box authenticates nobody: the recipient's public key is what
        seals it, and the relay is who hands that key out.

        So a message must carry a signature over
        ``(msgKey, fromDevice, toDevice, which body field, digest of it)``, and
        it is checked against the key this machine **pinned** for that device —
        not against the key the directory is advertising today. Once a device is
        pinned, changing what the directory says about it makes that device
        unreachable, which is the failure that can be seen, rather than
        impersonable, which is the one that cannot.

**A device with no pin is refused, not pinned.** This used to take a pin
        on first contact — trust on first use — which meant a relay that got in
        before the real device did was pinned in its place, and the only thing
        standing between that and the own-device ring was somebody noticing a
        notice. Pins are now written in exactly one place, when a pairing
        completes and two people have compared six digits, so there is no
        longer a path by which merely sending a message earns a key slot.
        """
        signature = str(data.get("sig") or "")
        cipher = str(data.get("cipher") or "")
        kind = BODY_CIPHER if cipher else BODY_TEXT
        body = cipher if cipher else str(data.get("text") or "")
        if not device_id or not signature:
            log.warning("refusing message %s: it carries no sender signature", msg_key)
            return None

        pin = trust_store.pin_for(device_id)
        advertised = remote_roster.sign_public_key_for(device_id)
        if pin is not None:
            key = str(pin.get("signKey") or "")
            if advertised and advertised != key:
                # Recorded before the refusal, not after: the refusal is what
                # the sender sees, and this is the only thing the *receiver*
                # ever gets to see about it.
                await asyncio.to_thread(
                    trust_store.note_key_change,
                    device_id,
                    pinned_key=key,
                    offered_key=advertised,
                    member_id=member_id,
                )
                await self._announce_trust_notices()
                log.error(
                    "device %s now offers a different signing key; refusing message %s",
                    device_id,
                    msg_key,
                )
                return None
        else:
            # Nothing pinned for this device, so there is no relationship to
            # carry a message through. The pairing exchange is the only thing
            # that runs before one exists, and it is routed away from here.
            log.info(
                "refusing message %s: device %s is not paired with this machine",
                msg_key,
                device_id,
            )
            return None

        if not device_signing.verify_message(
            signature,
            public_key_b64=key,
            msg_key=msg_key,
            from_device=device_id,
            to_device=self._device_id,
            kind=kind,
            body=body,
        ):
            log.warning("refusing message %s: its signature does not verify", msg_key)
            return None

        # It reached us again. Whoever said "not now" was answering the attempts
        # they had already seen, so a fresh one puts the row back in front of
        # them; ``note_knock`` is a no-op on every other pin.
        if await asyncio.to_thread(trust_store.note_knock, device_id):
            await self._announce_trust_notices()

        return self._own_device(pin)

    def _own_device(self, pin: dict[str, Any]) -> bool:
        """Whether a pinned device belongs to this account.

        Read from the pin's member id rather than from the message's, and
        compared against the member id pinned for *this* credential rather than
        against whatever the last ``auth.hello`` said. Both halves used to come
        from the relay; now neither does, and neither can be revised once taken.

        Both halves still arrived over the wire on the day the pin was taken,
        though, and that is what the approval check is for. The pinned member
        id was copied out of the first message, which the relay wrote: a relay
        that invents a device id, generates a keypair, signs correctly with it
        and fills in this account's own member id passes every test above. It
        gets exactly one attempt and leaves a notice with a fingerprint on it,
        which is what pinning buys, but until this version nothing stood between
        that attempt and the ring that consults no rules. Now something does,
        and it is a person comparing that fingerprint with the other machine.

        Unapproved is not refused. It drops the sender to the member ring, where
        the pane policy answers, and the policy denies by default and records a
        knock. So the failure of a legitimate new machine is "it asked and is
        waiting", which someone can see and fix, rather than "it vanished".
        """
        pinned = str(pin.get("memberId") or "")
        if not (bool(self._own_member) and pinned == self._own_member):
            return False
        # Missing rather than False on pins written before approval existed, and
        # read the same way: see trust_store.unapproved_devices for why those
        # are not grandfathered.
        return pin.get("approved") is True

    def _trust_state(self, device_id: str, *, is_local: bool) -> str:
        """One word for where a device stands: self, blocked, trusted, pending.

        **This machine is always ``self``, even if the policy names it.** That
        looks like it contradicts the delivery path, where ``blocked`` is
        checked ahead of the own-device shortcut, and it does not: the two
        "own device" are different questions. In ``device_trust.ring`` it means
        *another* machine on your account, which can be blocked and has to be
        refused first. Here it means the machine you are sitting at, which is
        never a remote sender — ``device_trust`` says so in as many words — so
        nothing enforces a block against it. Showing "blocked" on this row would
        be a label with no behaviour behind it, which on a security surface is
        worse than no label at all.

        Everything else is ordered the way the delivery path orders its rings.
        """
        if is_local:
            return "self"
        try:
            pin = trust_store.pin_for(device_id)
        except trust_store.TrustStoreLocked:
            # `pin_for` is safe only for a caller that has already established
            # the store is readable — the delivery path has, this one has not,
            # and it cannot: a read can fail transiently under it. So it answers
            # here instead of taking the whole snapshot down with it.
            #
            # What that cost, before this: the trust store locks, and the one
            # screen that exists to report a locked trust store is the screen
            # this crash removes. `trustLocked` was already in the payload and
            # the red card was already written; nobody saw either, because the
            # handler died before it could say so. The device list does not
            # depend on a pin, so it goes out either way.
            #
            # Empty rather than a guess: "pending" would assert this device is
            # not paired, which may be false, and this is the surface where an
            # unpaired machine looks different from a paired one. Saying nothing
            # is the only honest answer when the record cannot be read, and the
            # reason sits beside it in `trustLocked`.
            return ""
        member_id = str((pin or {}).get("memberId") or "") or member_id_for(device_id)
        if device_trust.is_blocked(self._policy, member_id=member_id, device_id=device_id):
            return "blocked"
        if pin is not None and pin.get("approved") is True:
            return "trusted"
        return "pending"

    def _device_online(self, device_id: str) -> bool:
        """Whether the server currently sees that machine.

        Read from the presence set when there is one, falling back to whether
        any of its panes reported a live host — the same two sources the device
        list itself uses, so the button and the row can never disagree.
        """
        if self._online_devices is not None:
            return device_id in self._online_devices
        return any(
            p.host_online for p in remote_roster.list_panes() if p.device_id == device_id
        )

    def _member_id_for(self, device_id: str) -> str:
        """Which member this link's own directory attributes *device_id* to.

        The module-level ``member_id_for`` answers the same question through the
        process-wide link; this reads the instance it is called on, which is the
        one whose snapshot is being built.
        """
        for row in self._directory or []:
            if str(row.get("deviceId") or "") == device_id:
                return str(row.get("hostMemberId") or row.get("memberId") or "")
        return ""

    def _pending_context(self, device_id: str) -> dict[str, Any]:
        """What this machine knows about a device waiting to be vouched for.

        "Is this f9c30189-79e6-…?" is not a question anybody can answer, so the
        row carries the name the machine calls itself and enough to place it.

        Read from ``remote_roster`` — the *same* source that put the device on
        this list — rather than from ``self._directory``. They come apart, and
        the first version of this read the wrong one: the roster is module-level
        and deliberately survives a disconnect, while ``_directory`` belongs to
        one link instance and starts empty on every reconnect. Enriching from a
        source that can be empty while the candidate list is not is how every
        field came back blank beside a device list that was showing the name.

        The roster is one row per *pane*, so this groups by device.
        """
        panes = [p for p in remote_roster.list_panes() if p.device_id == device_id]
        workspaces: list[str] = []
        for pane in panes:
            if pane.workspace and pane.workspace not in workspaces:
                workspaces.append(pane.workspace)
        name = next((p.device_name for p in panes if p.device_name), "")
        return {
            # Falling back to the raw directory covers a device the roster has
            # dropped but the last payload still mentions.
            "deviceName": name or self._device_name_for(device_id),
            "online": any(p.host_online for p in panes),
            "paneCount": len(panes),
            "workspaces": workspaces,
        }

    def _pending_approvals(self) -> list[dict[str, Any]]:
        """Devices that have knocked and are waiting for someone to vouch.

        Pinned-but-unapproved, and *only* that. A pin is taken when a message
        from that device verifies, so every row here is a machine that actually
        tried to reach this one.

        In practice this is now almost always empty: pins are written by the
        pairing exchange and pairing writes them approved, so the only rows left
        are pins taken under the older rule, on a machine that has been upgraded.
        Those are worth showing — they were never vouched for by anybody — but
        the answer to them is to pair again, not to approve them where they sit.
        """
        pending = []
        for row in trust_store.unapproved_devices():
            device_id = str(row.get("deviceId") or "")
            member_id = str(row.get("memberId") or "")
            # Blocking is an answer to the question this list is asking, so a
            # blocked device has to leave it. Without this the row came back on
            # the next poll three seconds later and the button read as broken —
            # the refusal had in fact been recorded, in the policy, where the
            # list was not looking.
            if device_trust.is_blocked(
                self._policy, member_id=member_id, device_id=device_id
            ):
                continue
            # "Not now" is not an answer, so the pin stays; it only takes the
            # row off the panel until that device knocks again.
            if row.get("dismissedAt"):
                continue
            # The pin records a key and a member, never a name — there was no
            # name to record when it was taken. Asking the directory here is
            # what turns "Is this f9c30189-79e6-…?" into a question somebody can
            # actually answer; a raw uuid is not a machine anyone recognises.
            # ``row`` already carries ``at``: when this machine took the pin,
            # and therefore when that device first reached it.
            pending.append({**row, **self._pending_context(device_id)})
        return pending

    async def _announce_trust_notices(self) -> None:
        """Tell every window that the trust notices changed.

        Broadcast for the same reason the knock list is: a key that changed
        belongs to the machine, not to a workspace, and whichever window has the
        account view open is the one that should say so.
        """
        from . import app
        from .ipc import make_event

        await app.broadcast(
            make_event(
                "p2p.trust_notices.changed",
                {
                    "notices": trust_store.notices(),
                    "pending": trust_store.unapproved_devices(),
                    "locked": self._trust_locked,
                },
            )
        )

    # ---- pairing -------------------------------------------------------------

    async def _send_pair_frame(self, device_id: str, kind: str, **fields: Any) -> bool:
        """Put one pairing frame on the wire. Returns whether the relay took it.

        Signed like any other message and sent in the clear like no other one:
        see device_pairing for why sealing is the wrong tool for the exchange
        that establishes the relationship sealing depends on.
        """
        if self._ws is None or not self._authenticated:
            return False
        text = device_pairing.envelope(kind, **fields)
        msg_key = f"pair-{secrets.token_hex(8)}"
        to = {
            "deviceId": device_id,
            "workspace": PAIRING_WORKSPACE,
            "paneName": PAIRING_PANE,
        }
        try:
            signature = await asyncio.to_thread(
                device_signing.sign_message,
                msg_key=msg_key,
                from_device=self._device_id,
                to_device=device_id,
                kind=BODY_TEXT,
                body=text,
            )
        except device_signing.SigningError as err:
            log.warning("could not sign a %s for %s: %s", kind, device_id, err)
            return False
        payload = {
            "to": to,
            "msgKey": msg_key,
            "sig": signature,
            "text": text,
            "from": {"deviceId": self._device_id, "memberId": self.member_id},
        }
        try:
            reply = await self._request("messages.send", payload)
        except Exception as err:  # noqa: BLE001
            log.warning("could not send a %s to %s: %s", kind, device_id, err)
            return False
        return bool(reply.get("ok"))

    async def _on_pair_frame(
        self,
        frame: dict[str, Any],
        data: dict[str, Any],
        *,
        msg_key: str,
        device_id: str,
        member_id: str,
    ) -> None:
        """One pairing frame from *device_id*.

        Every branch acks: an unanswered frame looks to the sender exactly like
        a machine that is switched off, and "they never replied" is a thing a
        person will wait on rather than retry.
        """
        kind = str(frame.get("kind") or "")
        # Blocked devices are dropped without a word. Answering would tell a
        # machine you refused that you are still here and still listening,
        # which is the one thing a block is supposed to stop.
        if device_trust.is_blocked(
            self._policy, member_id=member_id, device_id=device_id
        ):
            log.info("dropping a %s from blocked device %s", kind, device_id)
            await self._ack(msg_key, "rejected", reason="policy-denied")
            return

        their_key = str(frame.get("signKey") or "")
        existing = device_pairing.get(device_id)
        # Which key this frame has to verify against. The first frame of an
        # exchange carries its own — that is unauthenticated, and the six digits
        # two people compare are what authenticate it afterwards. Every frame
        # after that is checked against the key the exchange already fixed, so
        # the relay cannot swap it once a code is on somebody's screen.
        #
        # "Two people", on both sides, is load-bearing and was not always true.
        # The initiator used to finish on the other end's confirm alone, so on
        # that side nobody ever compared anything and this sentence described a
        # check that did not happen — a relay could answer with its own key and
        # be pinned, approved, having spoken to no one. Both ends confirm now
        # (device_pairing.complete), which is what makes this comment accurate
        # rather than aspirational.
        pin = trust_store.pin_for(device_id)
        key = (
            str((pin or {}).get("signKey") or "")
            or (existing.their_key if existing else "")
            or their_key
        )
        if not key or not device_signing.verify_message(
            str(data.get("sig") or ""),
            public_key_b64=key,
            msg_key=msg_key,
            from_device=device_id,
            to_device=self._device_id,
            kind=BODY_TEXT,
            body=str(data.get("text") or ""),
        ):
            log.warning("refusing a %s from %s: its signature does not verify", kind, device_id)
            await self._ack(msg_key, "rejected", reason=REASON_UNAUTHENTICATED)
            return

        name = self._device_name_for(device_id)
        # Their encryption key, from the frame and only the frame. It is
        # covered by the six digits exactly as the signing key is, and a
        # frame without one is refused by device_pairing rather than
        # completed from the directory.
        their_enc_key = str(frame.get("encKey") or "")
        try:
            if kind == device_pairing.PAIR_REQUEST:
                pairing = device_pairing.accept_request(
                    device_id,
                    device_name=name,
                    their_key=key,
                    their_enc_key=their_enc_key,
                    their_nonce=str(frame.get("nonce") or ""),
                )
                await self._send_pair_frame(
                    device_id,
                    device_pairing.PAIR_RESPONSE,
                    nonce=pairing.our_nonce,
                    signKey=await asyncio.to_thread(device_signing.public_key),
                    encKey=await asyncio.to_thread(device_crypto.public_key),
                )
            elif kind == device_pairing.PAIR_RESPONSE:
                device_pairing.accept_response(
                    device_id,
                    their_key=key,
                    their_enc_key=their_enc_key,
                    their_nonce=str(frame.get("nonce") or ""),
                )
            elif kind in (SYNC_KEY_REQUEST, SYNC_KEY_OFFER):
                # Only between this account's own approved devices. The
                # pairing kinds exist to serve strangers; these two must not,
                # and "paired" alone is not the test — see _sync_key_peer.
                if not self._sync_key_peer(pin, device_id=device_id, kind=kind):
                    pass
                elif kind == SYNC_KEY_REQUEST:
                    await self._offer_sync_key(device_id)
                else:
                    await self._adopt_sync_key(device_id, str(frame.get("wrapped") or ""))
            elif kind == device_pairing.PAIR_CONFIRM:
                # Recorded first, completed second. They may have confirmed
                # before this side's person did, in which case there is nothing
                # to finish yet and the card here stays up.
                #
                # No answer is sent from here. Each side sends exactly one
                # confirm, when its own person presses — so whichever order the
                # two arrive in, both ends have heard from the other by the time
                # either completes. An answer here would be a third frame
                # repeating what this side already said.
                device_pairing.note_peer_confirmed(device_id)
                await self._finish_pairing(device_id, member_id=member_id)
            elif kind == device_pairing.PAIR_REJECT:
                if device_pairing.cancel(device_id) is not None:
                    await asyncio.to_thread(
                        trust_store.note_pairing, device_id, kind="refused", device_name=name
                    )
            elif kind == device_pairing.PAIR_REVOKED:
                # They unpaired. Dropping our side too keeps the two machines
                # from disagreeing about whether they are paired — a state in
                # which one of them silently refuses everything the other sends.
                device_pairing.cancel(device_id)
                removed = await asyncio.to_thread(trust_store.forget_device, device_id)
                if removed.get("found"):
                    await asyncio.to_thread(
                        trust_store.note_pairing, device_id, kind="revoked", device_name=name
                    )
        except device_pairing.PairingError as err:
            log.info("refusing a %s from %s: %s", kind, device_id, err)
            await self._ack(msg_key, "rejected", reason="pairing-refused")
            return

        await self._announce_trust_notices()
        await self._ack(msg_key, "delivered")

    async def _finish_pairing(self, device_id: str, *, member_id: str) -> bool:
        """Both sides said the digits match. Write the pin, once.

        This is the only place a pin is taken. Everything else that used to
        write one — a first message arriving, a button in a list — is gone, so
        "which key does this machine trust for that device" has exactly one
        answer and one moment at which it was decided.
        """
        pairing = device_pairing.complete(device_id)
        if pairing is None:
            return False
        try:
            await asyncio.to_thread(
                trust_store.pin_paired_device,
                device_id,
                sign_key=pairing.their_key,
                enc_key=pairing.their_enc_key,
                member_id=member_id or member_id_for(device_id),
                own_member_id=self._own_member,
            )
        except Exception as err:  # noqa: BLE001
            log.error("could not pin %s after pairing: %s", device_id, err)
            return False
        await asyncio.to_thread(
            trust_store.note_pairing,
            device_id,
            kind="paired",
            device_name=pairing.device_name or self._device_name_for(device_id),
        )
        log.info("paired with device %s", device_id)
        # A device that has just joined cannot read anything already synced
        # until it holds the account key, and there is no better moment to hand
        # it over: the two ends have just authenticated each other by a code a
        # person compared. Failure is logged, not raised — pairing succeeded.
        await self._offer_sync_key(device_id)
        return True

    async def start_pairing(self, device_id: str) -> dict[str, Any]:
        """Ask another device to pair. The local half of the exchange."""
        if self._ws is None or not self._authenticated:
            return self._unavailable()
        if trust_store.pin_for(device_id) is not None:
            return {"ok": False, "error": {"code": "ALREADY_PAIRED",
                                           "message": "that device is already paired"}}
        # Both machines, or neither. The exchange is four frames and two people;
        # started against a machine that is not there it produces a card that
        # waits five minutes and expires, and the person who clicked has no way
        # to tell that from a button that does nothing.
        if not self._device_online(device_id):
            name = self._device_name_for(device_id) or device_id
            return {
                "ok": False,
                "error": {
                    "code": "TARGET_OFFLINE",
                    "message": f"{name} is offline; pairing needs both machines online",
                },
            }
        try:
            pairing = device_pairing.begin(
                device_id, device_name=self._device_name_for(device_id)
            )
        except device_pairing.PairingError as err:
            return {"ok": False, "error": {"code": "PAIRING_BUSY", "message": str(err)}}
        sent = await self._send_pair_frame(
            device_id,
            device_pairing.PAIR_REQUEST,
            nonce=pairing.our_nonce,
            signKey=await asyncio.to_thread(device_signing.public_key),
            encKey=await asyncio.to_thread(device_crypto.public_key),
        )
        if not sent:
            # Nothing is left half-started: the other side has heard nothing, so
            # a card here waiting on a reply would be waiting for ever.
            device_pairing.cancel(device_id)
            return self._unavailable()
        return {"ok": True, "payload": {"state": pairing.state}}

    async def confirm_pairing(self, device_id: str, *, accept: bool) -> dict[str, Any]:
        """This side's answer.

        For the responder that is "do the digits match?"; for the initiator the
        only answer left is to withdraw, because pressing "Pair with…" already
        said what that side wants — see ``device_pairing.complete``.
        """
        if not accept:
            pairing = device_pairing.cancel(device_id)
            if pairing is not None:
                await self._send_pair_frame(device_id, device_pairing.PAIR_REJECT)
            await self._announce_trust_notices()
            return {"ok": True, "payload": {"state": "rejected"}}
        # Both roles answer here. The initiator used to be refused — its intent
        # was treated as given by pressing "Pair with…" — and that is exactly
        # what a relay exploited: it never had to face a person comparing
        # digits. See device_pairing.complete.
        try:
            device_pairing.confirm(device_id)
        except device_pairing.PairingError as err:
            return {"ok": False, "error": {"code": "PAIRING_STATE", "message": str(err)}}
        await self._send_pair_frame(device_id, device_pairing.PAIR_CONFIRM)
        # Only completes if their confirm already arrived. Otherwise the card
        # stays up saying so — the pin waits for both, which is the difference
        # between this and the one-sided button it replaced.
        await self._finish_pairing(device_id, member_id=member_id_for(device_id))
        await self._announce_trust_notices()
        return {"ok": True, "payload": {"state": "confirmed"}}

    async def revoke_pairing(self, device_id: str) -> None:
        """Tell the other side we unpaired, so the two do not disagree."""
        device_pairing.cancel(device_id)
        await self._send_pair_frame(device_id, device_pairing.PAIR_REVOKED)

    def pairing_rows(self) -> list[dict[str, Any]]:
        """The in-flight exchanges, as the account view draws them."""
        our_key = device_signing.public_key()
        our_enc_key = device_crypto.public_key()
        rows = []
        for pairing in device_pairing.active():
            rows.append(
                {
                    "deviceId": pairing.device_id,
                    "deviceName": pairing.device_name or self._device_name_for(pairing.device_id),
                    "role": pairing.role,
                    "state": pairing.state,
                    "code": device_pairing.code_for(
                        pairing, our_key=our_key, our_enc_key=our_enc_key
                    ),
                    "fingerprint": device_signing.fingerprint(pairing.their_key),
                    "startedAt": pairing.started_at,
                }
            )
        return rows

    async def _on_message_pending(self, payload: Any) -> None:
        """A message for a pane on this machine: handled, and always answered.

        This runs as a spawned task, and nothing reads a spawned task's
        exception. So before this wrapper, anything that raised part-way — a
        trust-store read, a Keychain write, the thread pool — left no log line
        and no ack: the sender sat on "queued" for good, and because the key
        had already been claimed, the server re-sending it was dropped as a
        duplicate. Now the failure is logged here and the sender is told.
        """
        data = payload if isinstance(payload, dict) else {}
        msg_key = str(data.get("msgKey") or "")
        try:
            await self._receive_message(data, msg_key)
        except Exception:  # noqa: BLE001 - the one place this task's failure is seen
            log.exception("could not handle relayed message %s", msg_key)
            entry = self._inbound.get(msg_key)
            if entry is not None and not entry["acked"]:
                await self._ack(msg_key, "failed", reason=REASON_RECEIVER_ERROR)

    async def _receive_message(self, data: dict[str, Any], msg_key: str) -> None:
        """Dedupe, authorize, resolve and hand over one relayed message.

        Order matters: dedupe, then authorize, then resolve. Authorizing before
        resolving is what keeps an unauthorized sender from using the ack as a
        probe — "no such pane" and "policy denied" would otherwise map out which
        panes this machine is running.
        """
        if not msg_key:
            log.warning("navide-server pushed a message with no msgKey; ignoring it")
            return
        if not await self._note_inbound(msg_key):
            log.info("navide-server re-sent message %s; ignoring the duplicate", msg_key)
            # The server only re-sends a key when the sender sent it again, and
            # a sender only does that when it never heard back. If this side
            # already answered, the answer was lost on the way: say it again.
            entry = self._inbound.get(msg_key)
            ack = entry.get("ack") if entry is not None else None
            if ack is not None:
                await self._send_ack(msg_key, ack)
            return
        if self._trust_locked:
            # Nothing here can be told apart from anything else while the pins
            # are unreadable, and "deliver it anyway" is the one answer that
            # would make losing them costless.
            log.error("refusing message %s: %s", msg_key, self._trust_locked)
            await self._ack(msg_key, "rejected", reason="trust-unavailable")
            return

        source = data.get("from") if isinstance(data.get("from"), dict) else {}
        target = data.get("to") if isinstance(data.get("to"), dict) else {}
        workspace = str(target.get("workspace") or "")
        pane_name = str(target.get("paneName") or "")

        sender_member = str(source.get("memberId") or "")
        sender_device = str(source.get("deviceId") or "")

        # Pairing frames leave here first. They are the one kind that arrives
        # before any relationship exists, so they cannot go through the check
        # below — which now refuses every unpaired sender — and they address a
        # machine rather than a pane, so nothing further down applies to them.
        # They are plain text by design: nothing in them is secret, and sealing
        # would need a key learned through the relationship they establish.
        frame = device_pairing.parse(data.get("text"))
        if frame is not None:
            await self._on_pair_frame(
                frame,
                data,
                msg_key=msg_key,
                device_id=sender_device,
                member_id=sender_member,
            )
            return

        # Nothing but a pairing frame may use the reserved address. Without this
        # the two halves disagree: the body decides the routing, so a message
        # aimed at the pairing pane with an ordinary body would fall through to
        # pane resolution and look for a pane called "_pairing" — a confusing
        # failure for something that should simply be refused.
        if workspace == PAIRING_WORKSPACE or pane_name == PAIRING_PANE:
            log.warning(
                "refusing message %s: the pairing address carries no pairing frame",
                msg_key,
            )
            await self._ack(msg_key, "rejected", reason="pairing-refused")
            return

        # Authenticity before authorization. Everything below this line reads
        # fields the relay writes; the signature is what says the relay only
        # *carried* them. A message that does not verify never reaches a trust
        # ring, a policy lookup, or the knock ledger — the last of those
        # matters too, or an unauthenticated sender could fill the receiver's
        # screen with knocks from names it invented.
        own_device = await self._authenticate_sender(
            data, msg_key=msg_key, device_id=sender_device, member_id=sender_member
        )
        if own_device is None:
            # One wire reason for two different states — no pin at all, or a
            # signature that did not verify — for the same reason the refusal
            # below has one: telling a sender which of those it hit is telling
            # it whether the device id it guessed exists here.
            reason = (
                REASON_NOT_PAIRED
                if trust_store.pin_for(sender_device) is None
                else REASON_UNAUTHENTICATED
            )
            await self._ack(msg_key, "rejected", reason=reason)
            return
        await self._ensure_policy()
        # Three rings, not one condition: your own machines are one trust
        # domain and never consult the rules, a blocked device is refused ahead
        # of everything including that shortcut, and everyone else is what the
        # rule set is actually for. See device_trust for why each boundary sits
        # where it does. `own_device` is settled above from a signature checked
        # against a pinned key — never from the member id in the message, which
        # the relay writes, and never from the one in auth.hello, which it also
        # writes.
        trust_ring = device_trust.ring(
            self._policy,
            member_id=sender_member,
            device_id=sender_device,
            own_device=own_device,
        )
        # The addressed workspace/paneName are checked, not the resolved pane's:
        # resolution happens after this. `paneName` is matched exactly by the
        # resolver, so it is already the pane's real name; only a workspace
        # written as a longer path suffix ("nest/proj" for the pane labelled
        # "proj") can read differently, and it can only fail to match a rule.
        refused = trust_ring == device_trust.RING_BLOCKED or (
            trust_ring != device_trust.RING_SELF
            and not pane_policy.is_allowed(
                self._policy,
                member_id=sender_member,
                device_id=sender_device,
                workspace=workspace,
                pane_name=pane_name,
            )
        )
        if refused:
            log.warning(
                "refused message %s from device %s to %s/%s (%s)",
                msg_key,
                sender_device,
                workspace,
                pane_name,
                trust_ring,
            )
            if trust_ring != device_trust.RING_BLOCKED:
                # A knock worth showing someone. Blocked senders are left out
                # on purpose — see AccessRequests.
                self._access_requests.record(
                    member_id=sender_member,
                    device_id=sender_device,
                    device_name=self._device_name_for(sender_device),
                    workspace=workspace,
                    pane_name=pane_name,
                )
                await self._announce_access_requests()
            # One wire reason for both, deliberately: telling a sender that it
            # is blocked rather than merely unauthorized hands it an oracle,
            # which is the same reason authorization runs before resolution
            # here. The distinction is kept locally, where it is useful.
            await self._ack(msg_key, "rejected", reason="policy-denied")
            return

        address = agent_messaging.Address(
            pane_name=pane_name,
            workspace=workspace,
            # A hint only: a detach or reattach mints a new pane id, so a stale
            # one falls back to resolving (workspace, paneName) and the ack
            # carries whatever that produced.
            pane_id=str(target.get("paneId") or ""),
        )
        result = agent_messaging.resolve_address("", address)
        if result.pane is None:
            await self._ack(msg_key, "failed", reason=result.code or "unknown-target")
            return

        # Recorded here, once the message is going to land: "has anything been
        # driving my machines" was answerable only from a log file nobody opens.
        # Not a prompt — a paired device is allowed to do this, and asking every
        # time is how people learn to click through — but not silent either.
        await asyncio.to_thread(
            trust_store.note_remote_command,
            sender_device,
            device_name=self._device_name_for(sender_device),
            workspace=workspace,
            pane_name=pane_name,
        )
        await self._announce_trust_notices()

        # Decrypt only after the pane resolved: a message this machine was not
        # going to deliver anyway is one it has no reason to open, and doing the
        # work in the other order would make "did it decrypt" observable through
        # timing on messages that were never going to land.
        cipher = str(data.get("cipher") or "")
        if cipher:
            try:
                text = await asyncio.to_thread(
                    device_crypto.open_sealed,
                    cipher,
                    from_device=str(source.get("deviceId") or ""),
                    to_device=self._device_id,
                )
            except device_crypto.CryptoError:
                # Not "failed" — a retry would fail identically. The sender is
                # told the message was refused, and nothing goes to the pane:
                # delivering the ciphertext as if it were text would type a wall
                # of base64 into somebody's CLI.
                log.warning("could not open the sealed message %s; refusing it", msg_key)
                await self._ack(msg_key, "rejected", reason="undecryptable")
                return
        else:
            # The other half of the downgrade rule. The send side has refused to
            # emit plaintext to a peer known to hold a key ever since that record
            # was made durable — but a rule enforced on only one side is not a
            # rule, it is a preference. A relay that wants cleartext does not
            # need to break the sender; it can ask the receiver, and until now
            # the receiver had nothing to say no with.
            #
            # `is_encrypted_peer` is read from disk, so this survives the restart
            # that the in-memory version could simply be waited out through.
            sender_device = str(source.get("deviceId") or "")
            if sender_device and trust_store.is_encrypted_peer(sender_device):
                log.warning(
                    "refusing plaintext %s from %s, which has been encrypting",
                    msg_key, sender_device,
                )
                # Recorded as well as acked: the sender learning it was refused
                # tells a hostile sender only what it already knew. The notice is
                # for the person at this machine, and it is not dismissible for
                # the same reason a changed key is not — it reports a message
                # that was dropped, and that stays worth seeing.
                try:
                    await asyncio.to_thread(
                        trust_store.note_plaintext_refused, sender_device, msg_key=msg_key
                    )
                except Exception as err:  # noqa: BLE001
                    # The refusal stands either way; only the telling failed.
                    log.warning("could not record the refused downgrade: %s", err)
                await self._ack(msg_key, "rejected", reason="plaintext-downgrade")
                return
            text = str(data.get("text") or "")

        self._inbound[msg_key]["pane_id"] = result.pane.pane_id
        await self._deliver(msg_key, result.pane, source, text)

    async def _deliver(
        self,
        msg_key: str,
        pane: agent_messaging.RegisteredPane,
        source: dict[str, Any],
        text: str,
    ) -> None:
        """Hand the message to the window that owns the pane, on the existing
        on-machine path — the same event a local cli_send emits, so the idle
        gate, queue and message log behave identically for both."""
        from . import app
        from .ipc import make_event

        # A plain terminal runs what it is typed; another device's text is
        # never that. Refused before anything is marked or broadcast — the
        # window refuses it as well, but not only the window.
        if pane.agent_key == "terminal":
            await self._ack(msg_key, "rejected", reason="terminal-external")
            return

        from_display = "/".join(
            part
            for part in (
                str(source.get("deviceId") or ""),
                str(source.get("workspace") or ""),
                str(source.get("paneName") or ""),
            )
            if part
        )
        from .guard.taint import safe_mark_tainted

        safe_mark_tainted(pane.pane_id, "remote", f"message from device {from_display}", msg_key)
        await app.broadcast(
            make_event(
                "agent_msg.deliver",
                {
                    "msg_key": msg_key,
                    "origin": "remote",
                    "target_pane_id": pane.pane_id,
                    "target_workspace_path": pane.workspace_path,
                    "target_name": pane.name,
                    "target_agent_key": pane.agent_key,
                    # No local pane sent this; the display name is the address a
                    # reply would be sent back to.
                    "from_pane_id": "",
                    "from_display": from_display or "another device",
                    "from_workspace_path": "",
                    "from_agent_key": "",
                    "cross_workspace": True,
                    "content": text,
                    # Nothing applied the per-pair rate limit on the way in, so
                    # the receiving window has to. Without it two agents
                    # answering each other across devices have no loop guard.
                    "rate_limit": True,
                },
            )
        )

    def note_delivery_result(self, msg_key: str, ok: bool, reason: str) -> bool:
        """Turn a window's agent_msg.delivered verdict into a messages.ack.

        Returns False for every key that did not come in over this link, which
        is the common case — the same event carries every on-machine delivery.
        """
        entry = self._inbound.get(msg_key)
        if entry is None or entry["acked"] or not entry["pane_id"]:
            return False
        # Claimed before the ack is awaited so a second report cannot double-ack.
        entry["acked"] = True
        key = _reason_key(reason)
        self._spawn(
            self._ack(
                msg_key,
                # Typed into a resumed CLI that has not shown it yet: the ack
                # has no state for that, and "failed" would have the far sender
                # resend work that may already be running. The reason carries
                # the caveat.
                "delivered" if ok or key == "delivery-unconfirmed" else "failed",
                reason=key,
                pane_id=entry["pane_id"],
            )
        )
        return True

    async def _ack(
        self, msg_key: str, state: str, *, reason: str = "", pane_id: str = ""
    ) -> None:
        payload: dict[str, Any] = {"msgKey": msg_key, "state": state}
        if reason:
            payload["reason"] = reason
        # Only sent when the message was actually resolved to a pane: it is how
        # the sender learns the pane id its cached hint should become.
        if pane_id:
            payload["paneId"] = pane_id
        entry = self._inbound.get(msg_key)
        if entry is not None:
            entry["acked"] = True
            # Kept so the answer can be given again: after a dropped connection
            # (see _resend_unsent_acks) or when the sender asks again.
            entry["ack"] = payload
        await self._send_ack(msg_key, payload)

    async def _send_ack(self, msg_key: str, payload: dict[str, Any]) -> None:
        entry = self._inbound.get(msg_key)
        try:
            reply = await self._request("messages.ack", payload)
        except Exception as err:  # noqa: BLE001
            # The connection went, most likely. The sender cannot learn the
            # outcome any other way, so this is retried on the next connection
            # rather than dropped with a log line nobody reads.
            log.warning("navide-server messages.ack for %s failed: %s", msg_key, err)
            if entry is not None:
                entry["ack_unsent"] = True
            return
        if entry is not None:
            entry["ack_unsent"] = False
        if not reply.get("ok"):
            # An answer, not a lost frame: resending would get the same one.
            log.warning(
                "navide-server rejected messages.ack for %s: %s", msg_key, reply.get("error")
            )

    async def _resend_unsent_acks(self) -> None:
        """Deliver the acks a dropped connection swallowed. Once per connection."""
        for msg_key, entry in list(self._inbound.items()):
            ack = entry.get("ack")
            if ack is not None and entry.get("ack_unsent"):
                await self._send_ack(msg_key, ack)

    async def _ensure_policy(self) -> None:
        if self._policy_revision is None:
            await self._refresh_policy()

    def _note_outbound(self, msg_key: str, to: dict[str, Any]) -> None:
        now = time.monotonic()
        for key, entry in list(self._outbound.items()):
            if now - entry["sent_at"] >= MESSAGE_MEMORY_TTL_S:
                del self._outbound[key]
        while len(self._outbound) >= MESSAGE_MEMORY_MAX:
            self._outbound.pop(next(iter(self._outbound)))
        self._outbound[msg_key] = {"sent_at": now, "to": dict(to)}

    async def _reconcile_loop(self) -> None:
        """Ask the server about relayed messages the far side has not answered.

        Once as soon as the connection is up — every ack pushed while this
        device was away was missed — and then every RECONCILE_INTERVAL_S for
        messages older than RECONCILE_AFTER_S.
        """
        min_age_s = 0.0
        while True:
            try:
                await self._reconcile(min_age_s=min_age_s)
            except Exception:  # noqa: BLE001 - nothing awaits this task; keep it alive
                log.exception("reconciling relayed messages failed")
            min_age_s = RECONCILE_AFTER_S
            await asyncio.sleep(RECONCILE_INTERVAL_S)

    async def _reconcile(self, *, min_age_s: float) -> None:
        from .mcp_server import server as plan_mcp

        now = time.monotonic()
        for msg_key, entry in list(self._outbound.items()):
            if now - entry["sent_at"] < min_age_s:
                continue
            try:
                reply = await self._request("messages.get", {"msgKey": msg_key})
            except Exception as err:  # noqa: BLE001 - the next round asks again
                log.info("navide-server messages.get for %s failed: %s", msg_key, err)
                return
            if not reply.get("ok"):
                # Past the server's retention, or never stored: nothing left to
                # learn, and asking every minute until the TTL would be noise.
                self._outbound.pop(msg_key, None)
                continue
            message = (reply.get("payload") or {}).get("message") or {}
            if message.get("state") in _ACK_STATES:
                self._on_message_acked(message)
                continue
            # Still pending: the far side has not answered. Say which kind of
            # silence it is, from the one thing this side can see of that pane.
            plan_mcp.record_message_hold(
                msg_key, {"key": self._silence_kind(entry["to"])}
            )

    @staticmethod
    def _silence_kind(to: dict[str, Any]) -> str:
        device = str(to.get("deviceId") or "")
        name = str(to.get("paneName") or "")
        workspace = str(to.get("workspace") or "")
        for pane in remote_roster.list_panes():
            if pane.device_id == device and pane.pane_name == name and pane.workspace == workspace:
                return HOLD_REMOTE_BUSY if pane.busy else HOLD_REMOTE_UNREPORTED
        return HOLD_REMOTE_UNREPORTED

    def _on_message_acked(self, payload: Any) -> None:
        """The far side reported what became of a message this device sent."""
        from . import app
        from .ipc import make_event
        from .mcp_server import server as plan_mcp

        data = payload if isinstance(payload, dict) else {}
        msg_key = str(data.get("msgKey") or "")
        if not msg_key:
            return
        self._outbound.pop(msg_key, None)
        state = str(data.get("state") or "")
        reason = str(data.get("reason") or "")
        if state == "delivered":
            window_reason = ""
        else:
            window_reason = f"{state or 'failed'}: {reason}" if reason else state or "failed"
        # The sending window's own row as well, not only cli_check_message's
        # table: this broadcast is what settles a local delivery, and without it
        # a message relayed from a printed MSG block sat on "awaiting the target
        # window's report" until the 30-minute backstop failed it — delivered or
        # not. Windows that did not send this key ignore it.
        self._spawn(
            app.broadcast(
                make_event(
                    "agent_msg.delivery_result",
                    {
                        "msg_key": msg_key,
                        "ok": state == "delivered",
                        "reason": window_reason,
                    },
                )
            )
        )
        # `ackPaneId` is the pane id the receiver resolved to. Nothing here
        # caches a remote pane id — cli_send resolves the address every call —
        # so it is only logged; a sender that starts caching would read it here.
        log.debug(
            "navide-server acked message %s: %s (pane %s)",
            msg_key,
            data.get("state"),
            data.get("ackPaneId") or "",
        )
        plan_mcp.record_remote_ack(msg_key, state, reason)


# ---- process-wide link ------------------------------------------------------

_link: ServerLink | None = None


#: The namespace of the account the last link settled on, or None when the
#: process has never settled one or has since signed out. What tells "the
#: same account reconnected" — which changes nothing — from "a different
#: account signed in" or "signed out", both of which let go of everything the
#: previous account imported. Kept at module level because the ServerLink
#: instance is replaced on every reconfigure.
#: ``_UNREAD`` until the first call in this process, which reads the
#: namespace the previous process settled on (``SYNC_ACCOUNT_SETTING``):
#: an account switched while the app was closed is still a switch.
_UNREAD: Any = object()
_settled_account: str | None = _UNREAD

#: ui_settings key holding the namespace (a hash, see
#: ``sync_keyring.namespace_for``) of the last account sync settled on; ""
#: after a sign-out.
SYNC_ACCOUNT_SETTING = "sync-account-namespace"


def _settings_store() -> Any:
    from . import app

    return app.ui_settings_store


def _persisted_account() -> str | None:
    value = _settings_store().get().get(SYNC_ACCOUNT_SETTING)
    return value if isinstance(value, str) and value else None


def _persist_account(namespace: str | None) -> None:
    if _persisted_account() != (namespace or None):
        _settings_store().set({SYNC_ACCOUNT_SETTING: namespace or ""})


#: True from the moment an account change is noticed until everything the
#: previous account left behind has been let go of. Sync runs no round while
#: it is set, whatever the scope switches say; a failed cleanup leaves it set
#: and the next ``_note_account`` (a reconnect, the next start) tries again.
_switch_pending = False


async def _note_account(namespace: str | None) -> None:
    """Record which account is settled now; on a real change, tell the sync
    scopes so imported credentials and every scope's engine state go with the
    account that owned them, and every scope is switched off. The ring is not
    touched — it stays under its own namespace for that account's next
    sign-in.

    The new account is recorded only once that cleanup has succeeded, so a
    cleanup that fails halfway is retried rather than forgotten, and sync
    stays shut (``_switch_pending``) in between.
    """
    global _settled_account, _switch_pending
    previous = _settled_account
    if previous is _UNREAD:
        try:
            previous = await asyncio.to_thread(_persisted_account)
        except Exception as err:  # noqa: BLE001 - the link is not what this protects
            log.warning("could not read the settled sync account: %s", err)
            previous = None
    if previous is None or previous == namespace:
        _settled_account = namespace
        await _record_account(namespace)
        # Back on the account a failed switch was leaving: whatever that
        # switch did let go of belonged to this account, so sync reopens
        # rather than staying shut for a switch that is no longer happening.
        _switch_pending = False
        return
    _switch_pending = True
    link = _link
    if link is not None and link._sync_engine is not None:  # noqa: SLF001 - same module
        link._sync_engine.cancel_rounds()  # noqa: SLF001 - same module
    try:
        from . import sync_scopes

        await asyncio.to_thread(sync_scopes.on_account_changed)
    except Exception as err:  # noqa: BLE001 - retried on the next call
        log.warning("could not let go of the previous account's sync state; will retry: %s", err)
        _settled_account = previous
        return
    _settled_account = namespace
    await _record_account(namespace)
    _switch_pending = False
    try:
        from . import app, sync_scopes
        from .ipc import make_event

        if link is not None and link._sync_engine is not None:  # noqa: SLF001 - same module
            link._sync_engine.forget_results()  # noqa: SLF001 - same module
        scopes = await asyncio.to_thread(sync_scopes.enabled_scopes)
        await app.broadcast(
            make_event("ui.settings_changed", {"settings": {sync_scopes.SCOPES_SETTING: scopes}})
        )
    except Exception as err:  # noqa: BLE001 - the windows catch up on their next read
        log.warning("could not tell the windows the sync scopes changed: %s", err)


async def _record_account(namespace: str | None) -> None:
    try:
        await asyncio.to_thread(_persist_account, namespace)
    except Exception as err:  # noqa: BLE001 - the next start compares again
        log.warning("could not record the settled sync account: %s", err)


def _signed_out() -> bool:
    """Whether the token store answers, and answers "no token".

    ``access_token`` folds "cannot be read right now" (a locked keychain, a
    dismissed prompt) into "", which is right for dialling and wrong here: a
    sign-out lets go of every scope's sync state, and a keychain that was
    locked at boot is not a reason to do that.
    """
    try:
        token = _vault().read_app_secret(ACCESS_TOKEN_SECRET)
    except Exception as err:  # noqa: BLE001 - unreadable is "cannot tell"
        log.info("the navide-server token could not be read; sync state is left as it is (%s)", err)
        return False
    return not (token or "").strip()


async def start() -> None:
    """Start the process's one link, unless no server is configured."""
    global _link
    link = ServerLink()
    if await link.start():
        _link = link
    elif await asyncio.to_thread(_signed_out):
        # Not configured: signed out, or never signed in. Either way whatever
        # the previous account imported must not wait here for the next one.
        # A token that could not be read is neither, and changes nothing.
        await _note_account(None)


async def stop() -> None:
    global _link
    if _link is not None:
        await _link.stop()
        _link = None


async def reconfigure() -> None:
    """Apply a configuration change without restarting the backend.

    ``start()`` runs once at boot, so before this existed a user who filled in
    the server URL and token saw nothing happen — and the failure they got was
    the "unknown device" answer for a machine with no server configured, which
    reads as a typo in the address rather than "the link never dialled".

    Tearing the old link down *before* the new one dials is the whole point:
    two links for one device would both publish the same roster and both take
    delivery of the same relayed message. ``stop()`` on a None link and
    ``start()`` with no configuration are each already no-ops, so clearing the
    settings lands back in the inert state by the same path.
    """
    await stop()
    await start()


async def sync_now(scope: str = "") -> list[dict[str, Any]]:
    """Run a sync round now, for one scope or all of them.

    Answers rather than raises when there is no link: "not connected" is an
    ordinary state for a Settings pane to be told about, and the UI already
    shows the link's own status beside it.
    """
    link = _link
    if link is None or not link._authenticated:  # noqa: SLF001 - same module
        return [{"scope": scope or "all", "skipped": "not-connected"}]
    if not await link.ensure_sync_key():
        return [{"scope": scope or "all", "skipped": "no-key"}]
    engine = link.sync_engine()
    if scope:
        return [await engine.sync(scope)]
    return await engine.sync_all()


#: How long a local save waits for the next one before its round starts.
SYNC_SOON_DELAY_S = 2.0
#: The pending round of each scope, replaced by every save inside the delay.
_sync_soon_tasks: dict[str, "asyncio.Task[None]"] = {}


def sync_soon(scope: str) -> None:
    """A local save of *scope* happened: carry it up shortly.

    Debounced per scope, so a burst of saves (typing in a prompt, toggling
    several skills) becomes one round. Whether the scope is on and the link
    is up is decided when the round would start, not when it was asked for —
    by then either may have changed. Must be called on the event loop.
    """
    pending = _sync_soon_tasks.pop(scope, None)
    if pending is not None and not pending.done():
        pending.cancel()
    task = asyncio.get_running_loop().create_task(_sync_soon(scope))
    _sync_soon_tasks[scope] = task
    task.add_done_callback(
        lambda done: _sync_soon_tasks.pop(scope, None) if _sync_soon_tasks.get(scope) is done else None
    )


async def _sync_soon(scope: str) -> None:
    try:
        await asyncio.sleep(SYNC_SOON_DELAY_S)
        from . import sync_scopes

        link = _link
        if link is None or not link._authenticated:  # noqa: SLF001 - same module
            return
        if not await asyncio.to_thread(sync_scopes.scope_enabled, scope):
            return
        await sync_now(scope)
    except asyncio.CancelledError:
        raise
    except Exception as err:  # noqa: BLE001 - the save itself already succeeded
        log.warning("the sync round after a local %s save failed: %s", scope, err)


def sync_last_results() -> dict[str, dict[str, Any]]:
    """The last round's result of each scope, as ``sync.result`` sent it.

    Empty when there is no link, or its engine has not been built yet: the
    results live on the engine, and a new link (a reconfigure) starts over.
    """
    link = _link
    if link is None or link._sync_engine is None:  # noqa: SLF001 - same module
        return {}
    return link._sync_engine.last_results()  # noqa: SLF001 - same module


async def sync_inventory(scope: str = "") -> dict[str, Any]:
    """What this machine and the account hold, side by side. Reads only.

    Answers rather than raises when there is no link, for the same reason
    ``sync_now`` does: "not connected" is an ordinary thing for a Settings pane
    to be told, and it must not arrive looking like an empty cloud — that reads
    as "nothing is synced" and invites somebody to upload what is already up
    there.

    The local half is left out when the link is down rather than listed on its
    own: reaching the adapters means building the engine, which belongs to the
    link. ``share.inventory`` already lists this machine's own items offline.
    """
    from . import sync_approvals, sync_engine as engine_mod, sync_scopes

    enabled = await asyncio.to_thread(sync_scopes.enabled_scopes)
    link = _link
    connected = link is not None and link._authenticated  # noqa: SLF001 - same module
    # A scope sync no longer offers (memory) is left out of the whole-account
    # listing, and answers "retired" when asked for by name.
    wanted = [scope] if scope else [s for s in engine_mod.SCOPES if s not in sync_approvals.RETIRED_SCOPES]
    scopes: dict[str, Any] = {}
    for name in wanted:
        if name in sync_approvals.RETIRED_SCOPES:
            scopes[name] = {"scope": name, "status": sync_approvals.INVENTORY_RETIRED, "items": []}
        elif name not in engine_mod.SCOPES:
            scopes[name] = {
                "scope": name,
                "status": engine_mod.INVENTORY_UNKNOWN_SCOPE,
                "items": [],
            }
        elif not connected or link is None:
            scopes[name] = {
                "scope": name,
                "status": engine_mod.INVENTORY_NOT_CONNECTED,
                "items": [],
            }
        else:
            try:
                scopes[name] = await link.sync_engine().inventory(name)
            except Exception as err:  # noqa: BLE001 - one bad scope must still list
                log.warning("the inventory of %s could not be read: %s", name, err)
                scopes[name] = {
                    "scope": name,
                    "status": engine_mod.INVENTORY_ERROR,
                    "error": str(err),
                    "items": [],
                }
    directory = await list_devices() if connected else None
    return {
        "status": engine_mod.INVENTORY_OK if connected else engine_mod.INVENTORY_NOT_CONNECTED,
        "scopes": scopes,
        "devices": _inventory_devices(scopes, directory),
        "scopeEnabled": enabled,
    }


def _inventory_devices(
    scopes: dict[str, Any], directory: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """The devices the listed cloud rows were written by, newest write first.

    Two timestamps, named apart because they answer different questions.
    ``lastWriteAt`` is the newest ``updatedAt`` this account's rows carry for
    the device — when it last *wrote* — and is derived here from the rows
    themselves. ``lastSeenAt`` is when the server last saw the device online,
    from ``devices.list``. A machine that has been on all week and changed
    nothing has a fresh ``lastSeenAt`` and a stale ``lastWriteAt``; showing
    only one of them would make it look like one that went away in March.

    ``directory`` is the ``devices.list`` reply frame, or None when it could
    not be asked. Then ``deviceName`` falls back to what the session directory
    knows (today: nothing) and ``lastSeenAt`` to null; the rows are still
    listed, because a name the server would not give is not a reason to hide
    the records it did.
    """
    names = {
        str(row.get("deviceId") or ""): str(row.get("deviceName") or "")
        for row in remote_roster.list_devices()
    }
    seen: dict[str, str | None] = {}
    payload = directory.get("payload") if directory and directory.get("ok") else None
    listed = payload.get("devices") if isinstance(payload, dict) else None
    for row in listed if isinstance(listed, list) else []:
        if not isinstance(row, dict):
            continue
        device_id = str(row.get("deviceId") or "")
        if not device_id:
            continue
        if row.get("deviceName"):
            names[device_id] = str(row["deviceName"])
        seen[device_id] = str(row["lastSeenAt"]) if row.get("lastSeenAt") else None
    latest: dict[str, str] = {}
    for scope_row in scopes.values():
        for item in scope_row.get("items") or []:
            remote = item.get("remote")
            if not isinstance(remote, dict):
                continue
            device_id = str(remote.get("deviceId") or "")
            written_at = str(remote.get("updatedAt") or "")
            if device_id and written_at > latest.get(device_id, ""):
                latest[device_id] = written_at
    return sorted(
        (
            {
                "deviceId": device_id,
                "deviceName": names.get(device_id, ""),
                "lastSeenAt": seen.get(device_id),
                "lastWriteAt": written_at,
            }
            for device_id, written_at in latest.items()
        ),
        key=lambda row: row["lastWriteAt"],
        reverse=True,
    )


async def sync_push_items(scope: str, item_ids: Any) -> list[dict[str, Any]]:
    """Send the chosen items of one scope and report what became of each."""
    from . import sync_approvals

    if scope in sync_approvals.RETIRED_SCOPES:
        raise sync_approvals.RetiredScopeError(scope)
    link = _link
    if link is None or not link._authenticated:  # noqa: SLF001 - same module
        raise ConnectionError("the navide-server link is not connected")
    if not await link.ensure_sync_key():
        raise ConnectionError("this machine does not hold the account sync key")
    return await link.sync_engine().push_items(scope, item_ids)


async def sync_pull_items(scope: str, item_ids: Any) -> list[dict[str, Any]]:
    """Take the chosen items of one scope and report what became of each."""
    from . import sync_approvals

    if scope in sync_approvals.RETIRED_SCOPES:
        raise sync_approvals.RetiredScopeError(scope)
    link = _link
    if link is None or not link._authenticated:  # noqa: SLF001 - same module
        raise ConnectionError("the navide-server link is not connected")
    if not await link.ensure_sync_key():
        raise ConnectionError("this machine does not hold the account sync key")
    return await link.sync_engine().pull_items(scope, item_ids)


def sync_conflicts(scope: str = "") -> list[dict[str, Any]]:
    """Unresolved conflicts, readable whether or not the link is up. MCP
    secrets are masked (``sync_scopes.conflict_preview``)."""
    from . import app, sync_scopes

    return sync_scopes.conflict_preview(app.sync_store.conflicts(scope or None))


def sync_approvals() -> list[dict[str, Any]]:
    """Synced skills and MCP servers waiting for the user's approval
    (``sync_approvals``), readable whether or not the link is up."""
    from . import sync_approvals as approvals

    # Brief: long summaries collapsed; the card loads one whole on opening.
    return approvals.listing(brief=True)


def decide_sync_approval(scope: str, item_id: str, approve: bool, shown_digest: str) -> dict[str, Any]:
    """Approve or reject one held record. Blocking; call off the loop. Goes
    through the link's engine, whose registered adapter writes the record
    (an approved MCP server then reloads like a save in Settings)."""
    from . import sync_approvals as approvals

    link = _link
    if link is None:
        raise ConnectionError("the navide-server link is not running")
    adapter = link.sync_engine()._require_adapter(scope)  # noqa: SLF001 - same package
    return approvals.decide(adapter, item_id, approve, shown_digest)


def resolve_sync_conflict(scope: str, item_id: str, keep: str) -> None:
    """Answer one conflict. Needs the adapters, so it goes through the link."""
    link = _link
    if link is None:
        raise ConnectionError("the navide-server link is not running")
    link.sync_engine().resolve(scope, item_id, keep)


async def status() -> dict[str, Any]:
    """What the Settings UI needs to answer "is my configuration right?".

    Never returns the token: the UI only has to know whether one is stored, and
    a long-lived credential that is echoed back is a credential that leaks into
    a renderer process, a log, or a screenshot.
    """
    link = _link
    if link is not None:
        # A link exists only because start() found both halves, so the token is
        # known to be stored without asking the Keychain again — and the
        # Settings pane polls this while it is open.
        return {
            "state": link.state(),
            "serverUrl": await asyncio.to_thread(server_url),
            "hasToken": True,
            "detail": link.terminated_reason or link.last_error,
            "deviceId": link._device_id,
            "memberId": link.member_id,
            "accountEmail": await asyncio.to_thread(account_email),
            "displayName": getattr(link, "display_name", ""),
            "emailVerified": bool(getattr(link, "email_verified", False)),
            "selfFingerprint": await asyncio.to_thread(self_fingerprint),
            # Read by every surface that has to explain a refusal. The error
            # message above already carries whichever of these was most recent,
            # but it is one string; these are the parts, so a caller can say
            # "still connecting" without matching on prose.
            # The Keychain wait outranks the socket error: it describes where
            # the link actually is, and a stale error from a previous attempt
            # would send somebody looking at the network instead of at the
            # dialog in front of them.
            "lastError": (
                link.keychain_wait_reason()
                or link.terminated_reason
                or link.last_error
            ),
            "lastErrorAt": link.last_error_at or None,
            "nextRetryInS": (
                max(0, int(link.next_retry_at - time.time()))
                if link.next_retry_at
                else None
            ),
        }
    config = await asyncio.to_thread(load_config)
    return {
        "state": STATE_UNCONFIGURED,
        "serverUrl": config.url,
        # Reported even with no URL: it is what lets the token field say "one is
        # already stored" instead of asking for a credential the user cannot see
        # and would have no way to retype.
        "hasToken": bool(config.token),
        "detail": "",
        "deviceId": "",
        "memberId": "",
        "accountEmail": await asyncio.to_thread(account_email),
        "displayName": "",
        # No link means no account to judge; the UI only shows the verification
        # notice for an account it can actually see.
        "emailVerified": False,
        "lastError": "",
        "lastErrorAt": None,
        "nextRetryInS": None,
        # Reported with no link and no account, unlike everything above it: this
        # is the machine's own key, and somebody reading it off this screen for
        # another machine's confirmation box should not have to sign in first.
        "selfFingerprint": await asyncio.to_thread(self_fingerprint),
    }


async def policy_state() -> dict[str, Any]:
    """What the pane-policy editor needs to answer "who may command me?".

    Answered whatever the link is doing, because the policy is cached on this
    machine and a user whose messages are being refused has to be able to read
    the rules doing the refusing. ``editable`` is the honest half: the policy
    lives on the server, so an offline link can show it and not write it.

    Reads no configuration and touches no keychain — the Settings pane polls
    this while it is open, and the unconfigured answer is a constant.
    """
    link = _link
    if link is None:
        return {
            "state": STATE_UNCONFIGURED,
            "editable": False,
            "policy": None,
            "revision": None,
            "deviceId": "",
            "memberId": "",
        }
    state = link.state()
    snapshot = link.policy_snapshot()
    return {
        "state": state,
        # Only a live, authenticated link can carry a policy.set, and a UI that
        # offered the buttons anyway would leave the user believing a rule was
        # saved that never left the machine.
        "editable": state == STATE_CONNECTED,
        "policy": snapshot["policy"],
        "revision": snapshot["revision"],
        "deviceId": link._device_id,
        "memberId": link.member_id,
    }


def self_fingerprint() -> str:
    """This machine's signing key, as the short digest people compare.

    Blocking; call off the event loop. Deliberately the *same* function the
    pending card and the pairing confirmation use — two surfaces rendering one
    key differently would make the comparison they exist for impossible to
    trust, and a person cannot tell a different format from a different key.
    """
    return device_signing.fingerprint(device_signing.public_key())


async def offer_sync_key_to_peers() -> dict[str, Any]:
    """Offer the current ring to every eligible paired device, or say that no
    link is up. Used after ``sync_keyring.rotate_account_key``."""
    if _link is None:
        return {"offered": [], "skipped": [], "error": "not-connected"}
    return await _link.offer_sync_key_to_peers()


async def start_pairing(device_id: str) -> dict[str, Any] | None:
    """Ask another device to pair, or None with no server configured."""
    return None if _link is None else await _link.start_pairing(device_id)


async def confirm_pairing(device_id: str, *, accept: bool) -> dict[str, Any] | None:
    """Answer "do the digits match?", or None with no server configured."""
    return None if _link is None else await _link.confirm_pairing(device_id, accept=accept)


async def revoke_pairing(device_id: str) -> None:
    """Tell a device we unpaired. Silent with no link: there is nobody to tell."""
    if _link is not None:
        await _link.revoke_pairing(device_id)


def own_member_id() -> str:
    """The member id pinned for this link's credential, or "" with no link."""
    return _link._own_member if _link is not None else ""


def link_state() -> str:
    """This machine's link state, without paying for ``status()``.

    ``status()`` answers the Settings UI, so it reaches the Keychain for the
    account email and the fingerprint. A caller that only has to know whether
    cross-device addressing works right now needs none of that, and one of
    those callers is an MCP tool answering on every invocation.
    """
    return _link.state() if _link is not None else STATE_UNCONFIGURED


def local_device_id() -> str:
    """This machine's device id, or "" before a link has one."""
    return _link._device_id if _link is not None else ""


def member_id_for(device_id: str) -> str:
    """Which member the directory says owns *device_id*.

    Only ever used to fill in a pin's memberId. It comes from the server and is
    treated as such: what it decides is whether a device lands in the own-device
    ring, and that ring is gated on approval precisely because this value is the
    server's word rather than proof of anything.
    """
    if _link is None:
        return ""
    for row in _link._directory or []:
        if str(row.get("deviceId") or "") == device_id:
            return str(row.get("hostMemberId") or row.get("memberId") or "")
    return ""


def access_requests() -> list[dict[str, Any]]:
    """Refused knocks, or an empty list when no server was ever configured —
    a machine with no link cannot have been knocked on."""
    return [] if _link is None else _link.access_requests()


def forget_access_request(key: str) -> bool:
    return False if _link is None else _link.forget_access_request(key)


def forget_access_requests_for_device(device_id: str) -> int:
    return 0 if _link is None else _link.forget_access_requests_for_device(device_id)


async def set_policy(policy: Any) -> dict[str, Any] | None:
    """Write this device's pane policy, or None when no server is configured.

    None means the same thing it means for ``send_message``: this machine never
    had a server, so there is no policy anywhere to write. Every other failure
    is a reply frame carrying LINK_OFFLINE or LINK_UNAUTHORIZED.
    """
    if _link is None:
        return None
    return await _link.set_policy(policy)


async def network_snapshot() -> dict[str, Any] | None:
    """Devices and their panes in one read, or None when no server is configured.

    None means what it means everywhere else in this module: this machine never
    had a server, so there is no network to describe. Everything the view needs
    comes back in this one call — the caller polls this and nothing else.
    """
    link = _link
    if link is None:
        return None
    await link.ensure_directory()
    return link.network_snapshot()


async def resend_verification() -> dict[str, Any] | None:
    """Re-send the account verification mail, or None with no server configured.

    None means what it means everywhere else in this module: this machine never
    had a server, so there is no account anywhere to verify.
    """
    if _link is None:
        return None
    return await _link.resend_verification()


async def check_verification() -> dict[str, Any] | None:
    """Ask the server now whether this account's address is confirmed.

    None with no server configured, same as ``resend_verification``.
    """
    if _link is None:
        return None
    return await _link.check_verification()


# Cross-account shares. None with no server configured, same as everything
# above; every other outcome is a reply frame, the server's or a local one.
async def create_share(*, blob: str, size_bytes: int, ttl_seconds: int) -> dict[str, Any] | None:
    if _link is None:
        return None
    return await _link.create_share(blob=blob, size_bytes=size_bytes, ttl_seconds=ttl_seconds)


async def claim_share(share_id: str) -> dict[str, Any] | None:
    if _link is None:
        return None
    return await _link.claim_share(share_id)


async def list_shares() -> dict[str, Any] | None:
    if _link is None:
        return None
    return await _link.list_shares()


async def revoke_share(share_id: str) -> dict[str, Any] | None:
    if _link is None:
        return None
    return await _link.revoke_share(share_id)


async def list_devices() -> dict[str, Any] | None:
    if _link is None:
        return None
    return await _link.list_devices()


def roster_changed() -> None:
    """Tell the link a pane was added, renamed, removed or changed state.

    A no-op when no server is configured, which is what lets the on-machine
    registry call sites nudge it unconditionally.
    """
    if _link is not None:
        _link.notify_roster_changed()


async def send_message(
    *,
    to: dict[str, Any],
    sender: dict[str, Any] | None,
    text: str,
    msg_key: str,
) -> dict[str, Any] | None:
    """Relay a message to a pane on another device, or None if this machine has
    no server configured.

    None means exactly one thing: **no server was ever configured**, so the
    caller falls back to the answer it gave before cross-device addressing
    existed. That is the whole no-server guarantee in one branch.

    A configured server that is merely unreachable is *not* None — it comes back
    as an error frame carrying LINK_OFFLINE or LINK_UNAUTHORIZED. Collapsing the
    two told a user whose server had just gone down that the device id they
    typed was unknown, which sends them to fix an address that was correct.
    """
    if _link is None:
        return None
    return await _link.send_message(to=to, sender=sender, text=text, msg_key=msg_key)


def note_delivery_result(msg_key: str, ok: bool, reason: str) -> bool:
    """Report a local window's delivery verdict for a message relayed in from
    another device. A no-op for every key that did not arrive that way."""
    if _link is None:
        return False
    return _link.note_delivery_result(msg_key, ok, reason)


# ---- account API (register / login) -----------------------------------------
#
# These two calls happen *before* this machine has a token, so they cannot go
# through the long-lived link: that link only dials once a token exists, and
# authenticates before it will carry anything. auth.register and auth.login are
# the server's only unauthenticated endpoints, so each call opens its own
# short-lived connection, sends one frame, and closes.
#
# The password only ever exists inside this function's frame. What gets stored
# is the token the server hands back — the same long-lived credential a user
# would otherwise have pasted in by hand.


class AccountError(Exception):
    """A server-reported failure of an account call, carrying its code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def account_request(
    url: str, msg_type: str, payload: dict[str, Any]
) -> dict[str, Any]:
    """Call one unauthenticated account endpoint over a throwaway connection.

    Raises AccountError for a server-reported failure (so the caller can keep
    the server's own code, e.g. EMAIL_TAKEN) and ConnectionError/TimeoutError
    for anything that stops the call reaching a server at all — the caller
    turns those into a link-level error rather than a credential problem.
    """
    target = (url or "").strip()
    if not target:
        raise ConnectionError("no server url configured")
    # Honour a test's injected connector when one is installed on the link.
    connect = _link._connect if _link is not None else _dial
    frame = json.dumps({"id": "acct-1", "type": msg_type, "payload": payload})
    await _warm_tls(target)
    async with connect(target) as ws:
        await asyncio.wait_for(ws.send(frame), REQUEST_TIMEOUT_S)
        while True:
            raw = await asyncio.wait_for(ws.recv(), REQUEST_TIMEOUT_S)
            try:
                message = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if not isinstance(message, dict):
                continue
            # Ignore anything that is not the reply to this one request; a
            # server is free to push events onto a connection at any time.
            if message.get("id") != "acct-1":
                continue
            if message.get("ok"):
                result = message.get("payload")
                return result if isinstance(result, dict) else {}
            error = message.get("error")
            code = "SERVER_ERROR"
            detail = "account request failed"
            if isinstance(error, dict):
                code = str(error.get("code") or code)
                detail = str(error.get("message") or detail)
            raise AccountError(code, detail)
