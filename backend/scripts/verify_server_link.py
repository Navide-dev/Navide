"""End-to-end interface check: server_link.py against a *real* Navide-Server.

backend/tests/test_server_link.py runs against an in-process fake WebSocket we
wrote ourselves from the contract. A fake built from our reading of the contract
answers with our misreadings too, so it can only ever confirm that the code
agrees with itself. This script removes that circularity: it drives the real
``ServerLink`` — the same requests, the same reply parsing, the same push
handlers — against a running server, and checks what actually comes back.

Two links are opened for the *same member* on two different deviceIds, because
the server's identity model is a person and "one person, two machines" is the
case where a message can be echoed back to its own sender.

Sections 1-8 walk the happy path. Sections 9-14 are the boundaries a working
deployment actually meets: a message key that arrives twice, a policy that
refuses, a pane whose id changed under a cached hint, two devices discovering
each other's panes, a device that went offline, and the server itself going away
mid-session and coming back. Section 16 covers the account path itself:
registering, signing in, and what a freshly registered account can see.

Usage (server must already be running)::

    uv --project backend run python backend/scripts/verify_server_link.py

The script registers its own account on startup, so nothing has to exist first.

Environment:
    NAVIDE_WS            WebSocket URL (default ws://localhost:8787/ws)
    NAVIDE_MEMBER_TOKEN  reuse an existing account credential; unset = register one
    NAVIDE_SERVER_DIR    server checkout, used only by section 14 to run a
                         *disposable second instance* it may kill and restart
                         (default ~/Desktop/Navide-Server/server)
    NAVIDE_VERIFY_PORT   port for that disposable instance (default 8799)

Section 14 never touches the server under NAVIDE_WS: killing a shared instance
would take down whoever else is using it. It launches its own process, on its
own port, against its own throwaway database outside the server's repo.

It is deliberately *not* a pytest module: a test that needs a server running
somewhere else would fail the suite on every machine that does not have one.

Every run uses freshly generated deviceIds so repeated runs never inherit state
(a policy set by a previous run would hide "never configured" behaviour), and it
cleans up the session rows it created. It never writes to the server's repo.

One thing it cannot clean up: the accounts it registers (one in section 10, one
in section 16). The server has no delete-account call, so every run leaves a
``verify-*@example.com`` account behind. That is the server's data model, not an
unclean script.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import json
import os
import secrets
import shutil
import socket
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Everything below writes to app-data, and since the trust store landed that
# includes real device pins and real policy sequence numbers — in navide.db and
# in the login Keychain. A verification run that burned this machine's policy
# sequence would leave the *actual* install unable to verify its own policy, so
# the whole run is pointed at a throwaway directory. Set before the import
# because ``app`` opens navide.db at module scope. Overriding rather than
# defaulting on purpose: an operator who happens to have the variable pointing
# at their real data dir must not be taken at their word here.
_DATA_DIR = tempfile.mkdtemp(prefix="navide-verify-data-")
os.environ["AGENT_TEAM_DATA_DIR"] = _DATA_DIR

from agent_team_backend import (  # noqa: E402
    agent_messaging,
    app,
    device_identity,
    device_pairing,
    device_signing,
    remote_roster,
    server_link,
    trust_store,
)
from agent_team_backend.credential_vault import CredentialVault  # noqa: E402
from agent_team_backend import device_crypto, server_link, sync_keyring  # noqa: E402
from agent_team_backend.server_link import ServerLink, ServerLinkConfig  # noqa: E402

# The other half of the isolation: the trust store's document lives in the
# credential vault, which on macOS is the login Keychain. Rooted in the
# throwaway directory and forced onto the file backend so a verification run
# never adds, updates or deletes a real Keychain item.
app.credential_vault = CredentialVault(
    root=Path(_DATA_DIR) / "vault", real_home=Path(_DATA_DIR) / "home", platform="linux"
)

URL = os.environ.get("NAVIDE_WS") or "ws://localhost:8787/ws"
# 兩層收斂之後沒有 bootstrap admin，也沒有邀請——憑證唯一的來源是自己註冊。
# 這個值在 main() 開頭由 _ensure_token() 填上；環境變數只是「我已經有一個帳號」的覆寫路徑。
TOKEN = os.environ.get("NAVIDE_MEMBER_TOKEN") or ""
SERVER_DIR = Path(
    os.environ.get("NAVIDE_SERVER_DIR")
    or (Path.home() / "Desktop" / "Navide-Server" / "server")
)
VERIFY_PORT = int(os.environ.get("NAVIDE_VERIFY_PORT") or "8799")

WORKSPACE_PATH = "/tmp/navide-verify-ws"
WORKSPACE_LABEL = "navide-verify-ws"
PANE_ID = "verify-pane-1"
#: The id the same pane gets after a detach — section 11's stale-hint case.
PANE_ID_2 = "verify-pane-1-reattached"
PANE_NAME = "receiver"

# Per-run device ids. The server's DEVICE_ID_RE is [A-Za-z0-9._:-]{8,128}.
RUN = secrets.token_hex(4)
DEVICE_A = f"verify-a-{RUN}"
DEVICE_B = f"verify-b-{RUN}"
#: Section 14 only, against the disposable server.
DEVICE_C = f"verify-c-{RUN}"
DEVICE_D = f"verify-d-{RUN}"
#: Section 17 only: two devices of one account, each with its own sync store.
DEVICE_E = f"verify-e-{RUN}"
DEVICE_F = f"verify-f-{RUN}"
#: The address every A→B message in sections 6-11 uses.
TO_B = {"deviceId": DEVICE_B, "workspace": WORKSPACE_LABEL, "paneName": PANE_NAME}
SENDER = {"workspace": WORKSPACE_LABEL, "paneName": "sender", "paneId": "verify-sender"}


def allow_a_policy(member_id: str, device_id: str = DEVICE_A) -> dict[str, Any]:
    """A policy letting exactly one device drive the verify pane."""
    return {
        "version": 1,
        "default": "deny",
        "rules": [
            {
                "from": {"memberId": member_id, "deviceId": device_id},
                "to": {"workspace": WORKSPACE_LABEL, "paneName": PANE_NAME},
                "action": "allow",
            }
        ],
    }

async def write_policy(writer: ServerLink, owner: ServerLink, document: dict[str, Any]) -> dict:
    """Store *document* as *owner*'s policy, signed by *owner*.

    The signature is what makes the document a policy at all: an unsigned one is
    read as "no policy" and denies everything (see ``_verified_policy``). Note
    who does what here — *owner* signs, *writer* transmits. The split is kept
    because it names the two roles, but since L3 the server refuses a write
    aimed at another device, so every fixture below passes ``writer is owner``.
    The hostile-relay shape — someone else handing back a document they cannot
    author — is asserted on its own in the C2 section rather than being the
    ambient way fixtures are written. The script's real check survives either
    way: ``policy.set``'s reply never touches ``_policy_revision`` (only the
    refetch at 906 and the ``policy.changed`` handler at 1074 do), so ``owner``
    still learns about the change from the push and not from its own write.
    """
    signed = await asyncio.to_thread(owner._signed_policy, document)
    return await writer._request("policy.set", {"deviceId": owner._device_id, "policy": signed})


_passed = 0
_failed = 0


def check(cond: bool, label: str, extra: Any = None) -> bool:
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  ✓ {label}")
    else:
        _failed += 1
        detail = "" if extra is None else f"  -> {json.dumps(extra, ensure_ascii=False, default=str)}"
        print(f"  ✗ {label}{detail}")
    return cond


# ---- device identity --------------------------------------------------------

# ServerLink reads this machine's device id from device_identity at auth time,
# and there is only one of those per process. A ContextVar is what lets two
# links in one process each keep their own: asyncio.create_task and
# asyncio.to_thread both copy the current context, so the value set right before
# link.start() is the one that link keeps for every reconnect.
_current_device: contextvars.ContextVar[str] = contextvars.ContextVar("verify_device", default="")
_real_device_id = device_identity.device_id
_real_candidates = device_identity.candidate_node_ids
_real_local_ids = device_identity.local_ids


def _device_id() -> str:
    return _current_device.get() or _real_device_id()


def _candidate_node_ids(member_id: str) -> list[str]:
    """The link asks for candidates now, not for one id.

    Patching ``device_id`` alone stopped reaching the link when ids became
    per-account — every scenario below would have run against whatever the real
    machine holds, and the script would have gone on reporting passes for a
    path it was no longer driving.
    """
    forced = _current_device.get()
    return [forced] if forced else _real_candidates(member_id)


def _local_ids() -> set[str]:
    forced = _current_device.get()
    return {forced} if forced else _real_local_ids()


def _claim_node_id(member_id: str, value: str, *, replacing: bool = False) -> None:
    """A forced identity is the scenario's, not the machine's: recording it
    would leave this script's fixtures in the real identity file."""
    if _current_device.get():
        return
    _real_claim(member_id, value, replacing=replacing)


_real_claim = device_identity.claim_node_id
device_identity.device_id = _device_id  # type: ignore[assignment]
device_identity.candidate_node_ids = _candidate_node_ids  # type: ignore[assignment]
device_identity.local_ids = _local_ids  # type: ignore[assignment]
device_identity.claim_node_id = _claim_node_id  # type: ignore[assignment]


# ---- the signing key a receiver pins on first contact -----------------------

# A receiver takes its first pin for a device from the *candidate* key the
# session directory advertises. That cache (``remote_roster``) is one
# module-level map, and every link in this process replaces it wholesale on each
# ``sessions.changed`` — dropping its own rows as it goes. With two links here
# standing in for two machines, whichever refreshed last decides whose rows
# survive, so "is A's key visible to B right now" would be a race rather than a
# check.
#
# It is also, in one process, always the same key: ``device_signing`` has one
# keypair per machine and this script is one machine pretending to be several.
# So the *lookup* is answered directly and everything downstream of it — the
# signature check, the pin, the ring, the notice — is the real code path.
_real_sign_key_for = remote_roster.sign_public_key_for


def _sign_key_for(device_id: str) -> str:
    if device_id.startswith(("verify-a-", "verify-b-", "verify-c-", "verify-d-", "verify-m-")):
        return device_signing.public_key()
    return _real_sign_key_for(device_id)


remote_roster.sign_public_key_for = _sign_key_for  # type: ignore[assignment]


# ---- what actually reached a pane -------------------------------------------

# ServerLink hands an inbound message to the window that owns the pane by
# broadcasting agent_msg.deliver. No window is attached to this script, so that
# broadcast is both the proof a message was injected and — by its absence — the
# proof a refused one never was. Recorded here rather than inferred from acks:
# an ack says what this side decided, a broadcast says what it did.
_delivered: list[dict[str, Any]] = []
_real_broadcast = app.broadcast


async def _record_broadcast(event: Any, **kwargs: Any) -> None:
    if isinstance(event, dict) and event.get("type") == "agent_msg.deliver":
        _delivered.append(event.get("payload") or {})
    await _real_broadcast(event, **kwargs)


app.broadcast = _record_broadcast  # type: ignore[assignment]


def delivered(msg_key: str) -> list[dict[str, Any]]:
    return [p for p in _delivered if p.get("msg_key") == msg_key]


# ---- instrumentation --------------------------------------------------------


class Recorder:
    """Everything one link sent and everything the server pushed back."""

    def __init__(self, link: ServerLink, name: str) -> None:
        self.name = name
        self.calls: list[dict[str, Any]] = []
        self.pending: list[dict[str, Any]] = []
        self.acked: list[dict[str, Any]] = []
        self.directories: list[dict[str, Any]] = []

        original_request = link._request

        async def request(msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
            reply = await original_request(msg_type, payload)
            self.calls.append({"type": msg_type, "payload": payload, "reply": reply})
            return reply

        link._request = request  # type: ignore[method-assign]

        original_pending = link._on_message_pending

        async def on_pending(payload: Any) -> None:
            self.pending.append(payload if isinstance(payload, dict) else {})
            await original_pending(payload)

        link._on_message_pending = on_pending  # type: ignore[method-assign]

        original_acked = link._on_message_acked

        def on_acked(payload: Any) -> None:
            self.acked.append(payload if isinstance(payload, dict) else {})
            original_acked(payload)

        link._on_message_acked = on_acked  # type: ignore[method-assign]

        original_apply = link._apply_directory

        def on_directory(payload: Any) -> None:
            # Records both halves of the roster path: the one fetch per
            # connection and every sessions.changed push after it.
            self.directories.append(payload if isinstance(payload, dict) else {})
            original_apply(payload)

        link._apply_directory = on_directory  # type: ignore[method-assign]

    def last(self, msg_type: str) -> dict[str, Any] | None:
        for entry in reversed(self.calls):
            if entry["type"] == msg_type:
                return entry
        return None


async def until(predicate, label: str, timeout: float = 15.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.05)
    print(f"  ✗ timed out waiting for {label}")
    return False


async def open_link(
    device_id: str, name: str, url: str = "", token: str = ""
) -> tuple[ServerLink, Recorder]:
    target = url or URL
    # The credential is a parameter because section 14's disposable server has
    # its own database and therefore its own account; everything else uses the
    # one this script registers for itself at startup.
    credential = token or TOKEN
    link = ServerLink(
        config_loader=lambda: ServerLinkConfig(url=target, token=credential),
        token_clearer=lambda: None,
        device_name=f"verify-{name}",
    )
    recorder = Recorder(link, name)
    _current_device.set(device_id)
    started = await link.start()
    if not started:
        raise SystemExit("ServerLink refused to start; check NAVIDE_WS / token")
    # Authenticated, not merely identified: the member id is settled partway
    # through the hello, and what follows it (the pin, the keyring binding)
    # still runs before the link will carry a request. Waiting on the id alone
    # let the first send land in that gap and come back LINK_OFFLINE.
    ok = await until(lambda: link._authenticated or bool(link.terminated_reason), f"{name} auth")
    if not ok or link.terminated_reason:
        raise SystemExit(f"{name} failed to authenticate: {link.terminated_reason}")
    return link, recorder


# ---- pairing two links in this process ---------------------------------------

# A message from a device this machine has not paired with is refused before the
# policy is consulted (REASON_NOT_PAIRED), and the only thing that writes a pin
# is a completed SAS exchange. So two links that are to exchange messages have
# to pair first, through the real server: request, response, both confirms.
#
# One thing cannot be checked here: that the six digits *match*. This process
# is one machine standing in for two, so both ends hold the same signing and
# encryption keys, and the SAS orders its inputs by signing key — with the two
# keys equal the tie falls the same way on both sides and the nonces land in
# opposite slots. Two real machines never share a key. Everything else — the
# frames, the signatures, the pins with both keys, the sync-key offer that
# follows — is the production path, driven end to end.


async def pair_links(initiator: ServerLink, responder: ServerLink, label: str) -> bool:
    x_id, y_id = initiator._device_id, responder._device_id
    check(
        await until(lambda: initiator._device_online(y_id), f"{label}: 對方在線上"),
        f"{label}: 配對前 server 已回報對方在線上",
    )
    started = await initiator.start_pairing(y_id)
    check(
        isinstance(started, dict) and started.get("ok") is True,
        f"{label}: start_pairing 送出 pair-request",
        started,
    )
    def _state(device_id: str) -> str:
        pairing = device_pairing.get(device_id)
        return pairing.state if pairing else ""

    both_waiting = await until(
        lambda: _state(x_id) == _state(y_id) == device_pairing.STATE_AWAITING_LOCAL,
        f"{label}: 兩端都拿到雙方 nonce",
    )
    check(both_waiting, f"{label}: request/response 走完，兩端都等自己的人按下確認")
    mine = device_pairing.get(y_id)
    theirs = device_pairing.get(x_id)
    check(
        bool(mine and theirs)
        and mine.their_enc_key == theirs.their_enc_key == device_crypto.public_key()
        and mine.their_key == theirs.their_key == device_signing.public_key(),
        f"{label}: 兩端從 frame（不是目錄）拿到對方的簽章鍵與加密鍵",
    )
    # Two people press. Order does not matter; each side sends exactly one confirm.
    answered_y = await responder.confirm_pairing(x_id, accept=True)
    answered_x = await initiator.confirm_pairing(y_id, accept=True)
    check(
        answered_x.get("ok") is True and answered_y.get("ok") is True,
        f"{label}: 兩端都確認",
        {"x": answered_x, "y": answered_y},
    )

    def _pinned() -> bool:
        a, b = trust_store.pin_for(x_id), trust_store.pin_for(y_id)
        return bool(
            a and b and a.get("approved") and b.get("approved")
            and a.get("encKey") and b.get("encKey")
        )

    pinned = await until(_pinned, f"{label}: 兩端寫入 pin")
    check(pinned, f"{label}: 兩端都釘選了對方的簽章鍵＋加密鍵（approved）", {
        "x": trust_store.pin_for(x_id), "y": trust_store.pin_for(y_id)
    })
    # The pins can be written before the last confirm frame has crossed the
    # server, so the exchange records are the last thing to go.
    check(
        await until(
            lambda: device_pairing.get(x_id) is None and device_pairing.get(y_id) is None,
            f"{label}: 交換記錄清空",
        ),
        f"{label}: 配對完成後沒有殘留的交換",
    )
    return pinned


# ---- a server this script is allowed to kill --------------------------------


def _port_open(port: int) -> bool:
    with contextlib.closing(socket.socket()) as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


async def _wait_for_port(port: int, want_open: bool, timeout: float = 30.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if _port_open(port) is want_open:
            return True
        await asyncio.sleep(0.1)
    return False


class DisposableServer:
    """A second Navide-Server this script owns outright.

    Section 14 has to watch a link survive its server disappearing, and the only
    honest way to test that is to make one disappear. The instance under
    NAVIDE_WS is shared — taking it down would break whoever else is on it — so
    this starts a private one: own port, own database in a temp dir, never a
    write inside the server's checkout. `tsx` is invoked directly rather than
    through `npm start` so that terminating the process terminates the server
    rather than a wrapper that outlives it.
    """

    def __init__(self, port: int, db_dir: Path) -> None:
        self.port = port
        self.url = f"ws://localhost:{port}/ws"
        self._db = db_dir / "verify.db"
        self._proc: Any = None
        #: 這台有自己的資料庫，主 server 的 token 在這裡不存在——所以它需要自己的帳號。
        #: 先前是靠把 NAVIDE_ADMIN_TOKEN 傳進去、讓 bootstrap admin 鑄出同一組 token，
        #: 那條路隨 bootstrap admin 一起沒了。註冊一次即可：重啟時 DB 還在，帳號還在。
        self.token: str = ""

    async def _ensure_account(self) -> None:
        if self.token:
            return
        created = await server_link.account_request(
            self.url,
            "auth.register",
            {"email": f"verify-disposable-{RUN}@example.com",
             "password": f"verify-pwd-{secrets.token_hex(8)}"},
        )
        self.token = str(created.get("token") or "")
        if not self.token:
            raise RuntimeError(f"拋棄式 server 的 auth.register 沒有回傳 token：{created}")

    async def start(self) -> None:
        tsx = SERVER_DIR / "node_modules" / ".bin" / "tsx"
        if not tsx.exists():
            raise FileNotFoundError(f"{tsx} not found (set NAVIDE_SERVER_DIR)")
        if _port_open(self.port):
            raise RuntimeError(f"port {self.port} is already in use")
        self._proc = await asyncio.create_subprocess_exec(
            str(tsx),
            "src/index.ts",
            cwd=str(SERVER_DIR),
            env={
                **os.environ,
                "PORT": str(self.port),
                "NAVIDE_DB_PATH": str(self._db),
            },
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        if not await _wait_for_port(self.port, True):
            raise RuntimeError(f"the disposable server never listened on {self.port}")
        await self._ensure_account()

    async def stop(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None or proc.returncode is not None:
            return
        proc.terminate()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(proc.wait(), 10)
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        await _wait_for_port(self.port, False, timeout=10)


# ---- the checks -------------------------------------------------------------


async def _ensure_token() -> None:
    """沒有 bootstrap admin 之後，這支腳本的第一個憑證只能自己註冊來。

    放在 main() 最前面而不是各檢查裡：後面每一條 open_link 都吃 TOKEN，
    少了它整份腳本會在第一個連線就全倒，而那種倒法看起來像 server 壞了。
    """
    global TOKEN
    if TOKEN:
        return
    email = f"verify-boot-{RUN}@example.com"
    created = await server_link.account_request(
        URL, "auth.register", {"email": email, "password": f"verify-pwd-{secrets.token_hex(8)}"}
    )
    TOKEN = str(created.get("token") or "")
    if not TOKEN:
        raise RuntimeError(f"auth.register 沒有回傳 token：{created}")
    print(f"   已註冊驗證用帳號 {created.get('memberId')}（{email}）")


async def main() -> int:
    print(f"== 目標 {URL} ==")
    print(f"   deviceA={DEVICE_A}  deviceB={DEVICE_B}")

    await _ensure_token()

    agent_messaging.register(PANE_ID, PANE_NAME, WORKSPACE_PATH, agent_key="claude")

    link_a, rec_a = await open_link(DEVICE_A, "A")
    link_b, rec_b = await open_link(DEVICE_B, "B")

    try:
        print("\n== 1. auth.hello ==")
        hello = rec_a.last("auth.hello")
        payload = (hello or {}).get("reply", {}).get("payload") or {}
        check(bool(hello) and hello["reply"].get("ok") is True, "帶 deviceId 的 auth.hello 被接受", hello)
        check(link_a.member_id == str(payload.get("memberId") or ""), "程式碼解析出的 memberId 與回應相符", payload)
        check(payload.get("deviceId") == DEVICE_A, "回應回帶同一個 deviceId", payload)
        check(
            all(k in payload for k in ("memberId", "displayName", "deviceId")),
            "回應欄位齊全（memberId/displayName/deviceId）",
            payload,
        )

        print("\n== 2. sessions.sync ==")
        await until(lambda: rec_a.last("sessions.sync") is not None, "A sessions.sync")
        sync = rec_a.last("sessions.sync") or {}
        sync_reply = sync.get("reply", {})
        sync_payload = sync_reply.get("payload") or {}
        check(sync_reply.get("ok") is True, "全量上報被接受", sync_reply)
        rows = sync_payload.get("sessions")
        check(isinstance(rows, list) and len(rows) == 1, "回應 sessions 是清單且長度相符", sync_payload)
        row = rows[0] if isinstance(rows, list) and rows else {}
        check(
            isinstance(row, dict) and bool(row.get("sessionId")) and row.get("paneId") == PANE_ID,
            "每列都帶 sessionId 與 paneId（程式碼靠這兩欄建表）",
            row,
        )
        check(isinstance(sync_payload.get("removed"), list), "回應帶 removed 清單", sync_payload)
        synced_id = link_a._session_ids.get(PANE_ID, "")
        check(bool(synced_id), "ServerLink 記下了 server 發的 sessionId", link_a._session_ids)

        print("\n== 3. sessions.upsert 自然鍵 (deviceId, paneId) ==")
        payload_for_pane = server_link._session_payload(agent_messaging.get(PANE_ID))
        link_a._session_ids.pop(PANE_ID, None)
        first_ok = await link_a._upsert(PANE_ID, payload_for_pane)
        first_id = link_a._session_ids.get(PANE_ID, "")
        link_a._session_ids.pop(PANE_ID, None)
        second_ok = await link_a._upsert(PANE_ID, payload_for_pane)
        second_id = link_a._session_ids.get(PANE_ID, "")
        check(first_ok and second_ok, "不帶 sessionId 的 upsert 被接受", rec_a.last("sessions.upsert"))
        check(
            bool(first_id) and first_id == second_id,
            "同一個 (deviceId, paneId) 兩次 upsert 對回同一列",
            {"first": first_id, "second": second_id},
        )
        check(
            bool(first_id) and first_id == synced_id,
            "自然鍵對回的正是 sessions.sync 建的那一列",
            {"upsert": first_id, "sync": synced_id},
        )
        # Same paneId on the other device must be a *different* row.
        payload_b = dict(payload_for_pane)
        link_b._session_ids.pop(PANE_ID, None)
        await link_b._upsert(PANE_ID, payload_b)
        check(
            link_b._session_ids.get(PANE_ID, "") not in ("", first_id),
            "另一台裝置的同一個 paneId 是不同列（自然鍵含 deviceId）",
            {"a": first_id, "b": link_b._session_ids.get(PANE_ID)},
        )

        print("\n== 4. sessions.remove ==")
        throwaway = f"verify-throwaway-{RUN}"
        await link_a._upsert(throwaway, dict(payload_for_pane, paneId=throwaway, title="throwaway"))
        removed_id = link_a._session_ids.get(throwaway, "")
        check(bool(removed_id), "先建立一筆待刪的 session", {"sessionId": removed_id})
        await link_a._remove(throwaway)
        directory = await link_a._request("sessions.directory", {})
        listed = (directory.get("payload") or {}).get("sessions") or []
        check(
            bool(removed_id)
            and removed_id not in [str(s.get("sessionId")) for s in listed if isinstance(s, dict)],
            "sessions.remove 之後那一列真的不在目錄裡",
            {"sessionId": removed_id},
        )
        check(throwaway not in link_a._session_ids, "ServerLink 也把本地映射清掉了", link_a._session_ids)

        print("\n== 5. policy.get（沒設過） ==")
        policy_call = rec_b.last("policy.get") or {}
        policy_payload = (policy_call.get("reply") or {}).get("payload") or {}
        check(
            policy_payload.get("revision") == 0,
            "沒設過的裝置回 revision 0",
            policy_payload,
        )
        check(
            policy_payload.get("policy") == {"version": 1, "default": "deny", "rules": []},
            "沒設過的裝置回空政策（deny-by-default）",
            policy_payload,
        )
        check(
            link_b._policy_revision == 0 and link_b._policy is None,
            "server 的空白政策沒有簽章，所以不算政策（快取是 None，全拒）",
            {"revision": link_b._policy_revision, "policy": link_b._policy},
        )
        # Not an accusation, though: a machine that has never written a policy
        # is the ordinary starting state, and it must not produce a warning.
        check(
            not [
                n
                for n in trust_store.notices()
                if n["kind"] == trust_store.NOTICE_POLICY_UNVERIFIED
            ],
            "沒設過政策不會被當成被竄改（不留告警）",
            trust_store.notices(),
        )

        # Grant device A permission to drive device B's pane, so the delivery
        # path below exercises "allowed" rather than stopping at the policy gate.
        set_reply = await write_policy(link_b, link_b, allow_a_policy(link_a.member_id))
        check(set_reply.get("ok") is True, "（前置）裝置 B 為自己寫入允許 A 的政策", set_reply)
        await until(lambda: link_b._policy_revision == 1, "B 收到 policy.changed 並重抓")
        check(link_b._policy_revision == 1, "policy.changed 推播讓 B 的快取升到 revision 1")

        print("\n== 5b. 配對 A↔B（SAS 交換走真 server） ==")
        # Nothing below reaches a pane without this: an unpaired sender is
        # refused with REASON_NOT_PAIRED before the policy is even read.
        check(
            trust_store.pin_for(DEVICE_A) is None and trust_store.pin_for(DEVICE_B) is None,
            "配對前兩端互相沒有 pin（訊息會被拒為 not-paired）",
        )
        check(await pair_links(link_a, link_b, "A↔B"), "A↔B 配對完成")

        # The account sync key rides the same channel once the two are paired:
        # rotate here, offer to every eligible peer, and watch the offer land.
        # Both links share this process's keyring, so "B can read A's new
        # records" is not something this run can prove — the two-process
        # script covers that. What is proved is the wire: the offer is
        # sealed to the pinned key, carried by the real server, and adopted
        # by the receiving link's handler rather than dropped or refused.
        sync_keyring.ensure_account_key()
        rotated_kid = sync_keyring.rotate_account_key()
        offers = await link_a.offer_sync_key_to_peers()
        check(
            offers.get("offered") == [DEVICE_B],
            "輪替後 offer_sync_key_to_peers 只送給已配對的同帳號裝置 B",
            offers,
        )
        offer_landed = await until(
            lambda: any(
                (device_pairing.parse(m.get("text")) or {}).get("kind")
                == device_pairing.SYNC_KEY_OFFER
                for m in rec_b.pending
            ),
            "B 收到 sync-key-offer",
        )
        check(offer_landed, "sync-key-offer 經真 server 送達 B")
        offer_key = next(
            (
                m.get("msgKey") for m in rec_b.pending
                if (device_pairing.parse(m.get("text")) or {}).get("kind")
                == device_pairing.SYNC_KEY_OFFER
            ),
            "",
        )
        check(
            await until(
                lambda: any(
                    m.get("msgKey") == offer_key and m.get("state") == "delivered"
                    for m in rec_a.acked
                ),
                "offer 被 B 端 handler 接受",
            ),
            "B 端的 handler 接受了 offer（acked delivered，不是 rejected）",
            [m for m in rec_a.acked if m.get("msgKey") == offer_key],
        )
        check(
            sync_keyring.active_key_id() == rotated_kid,
            "offer 往返後 ring 仍是輪替後的那把（同血緣同 gen＝冪等）",
        )

        print("\n== 6/7. messages.send / messages.pending ==")
        msg_key = f"verify:{RUN}:{secrets.token_hex(4)}"
        send_reply = await link_a.send_message(
            to={"deviceId": DEVICE_B, "workspace": WORKSPACE_LABEL, "paneName": PANE_NAME},
            sender={"workspace": WORKSPACE_LABEL, "paneName": "sender", "paneId": "verify-sender"},
            text="hello from device A",
            msg_key=msg_key,
        )
        check(
            isinstance(send_reply, dict) and send_reply.get("ok") is True,
            "裝置 A 的 messages.send 被接受",
            send_reply,
        )
        check(
            (send_reply or {}).get("payload", {}).get("state") == "pending",
            "回應 state=pending",
            send_reply,
        )
        got = await until(lambda: any(m.get("msgKey") == msg_key for m in rec_b.pending), "B messages.pending")
        check(got, "裝置 B 真的收到 messages.pending")
        pushed = next((m for m in rec_b.pending if m.get("msgKey") == msg_key), {})
        check(
            isinstance(pushed.get("from"), dict) and isinstance(pushed.get("to"), dict),
            "推播帶 from/to 物件（程式碼靠它們做政策判斷與定址）",
            pushed,
        )
        check(
            (pushed.get("to") or {}).get("paneName") == PANE_NAME
            and (pushed.get("to") or {}).get("workspace") == WORKSPACE_LABEL,
            "推播的 to.workspace / to.paneName 原樣送達",
            pushed.get("to"),
        )
        # Sealed to the pinned encryption key, so the relay carries ciphertext
        # and the original only reappears once B's handler opens it.
        check(
            bool(pushed.get("cipher")) and not pushed.get("text"),
            "推播帶密文、不帶原文（封給 pin 裡的加密鍵）",
            {k: pushed.get(k) for k in ("cipher", "text")},
        )
        check(
            not any(m.get("msgKey") == msg_key for m in rec_a.pending),
            "裝置 A 沒有收到自己送出的訊息（迴圈防護）",
            rec_a.pending,
        )
        # Awaited rather than read straight after the push: the recorder sees
        # the raw frame, while resolution happens further down the handler —
        # and on a *first* contact that handler also verifies a signature and
        # takes a pin, both off the loop. Reading immediately was checking
        # whether this machine is fast, not whether it resolved.
        check(
            await until(
                lambda: link_b._inbound.get(msg_key, {}).get("pane_id") == PANE_ID,
                "B 解析到本機 pane",
            ),
            "B 端把訊息解析到本機 pane（政策放行、位址解析成功）",
            link_b._inbound.get(msg_key),
        )
        check(
            delivered(msg_key) and delivered(msg_key)[0].get("content") == "hello from device A",
            "B 端解開密文後原文送進 pane",
            delivered(msg_key),
        )

        print("\n== 8. messages.ack -> messages.acked ==")
        # This is the verdict the receiving window reports over agent_msg.delivered;
        # no window is attached to this script, so it is injected at that seam.
        claimed = link_b.note_delivery_result(msg_key, True, json.dumps({"key": "ok"}))
        check(claimed, "B 把投遞結果認領為這條連線的訊息")
        await until(lambda: any(m.get("msgKey") == msg_key for m in rec_a.acked), "A messages.acked")
        acked = next((m for m in rec_a.acked if m.get("msgKey") == msg_key), {})
        check(bool(acked), "裝置 A 收到 messages.acked", rec_a.acked)
        check(acked.get("state") == "delivered", "acked 帶 state=delivered", acked)
        check(acked.get("ackPaneId") == PANE_ID, "acked 帶 ackPaneId（收端解析到的 pane）", acked)

        print("\n== 9. 重複 msgKey 只注入一次 ==")
        # The server stores messages with INSERT OR REPLACE and pushes on every
        # send, so a repeated key really does arrive twice — the dedupe under
        # test is the receiver's, and this is the only place it meets a real one.
        dup_key = f"verify:{RUN}:dup"
        first = await link_a.send_message(to=TO_B, sender=SENDER, text="once only", msg_key=dup_key)
        check(isinstance(first, dict) and first.get("ok") is True, "第一次送出被接受", first)
        check(await until(lambda: len(delivered(dup_key)) == 1, "第一次注入"), "第一次確實注入到 pane")
        second = await link_a.send_message(to=TO_B, sender=SENDER, text="once only", msg_key=dup_key)
        check(
            isinstance(second, dict) and second.get("ok") is True,
            "同一個 msgKey 再送一次 server 仍接受（去重責任在收端）",
            second,
        )
        pushed_twice = await until(
            lambda: len([m for m in rec_b.pending if m.get("msgKey") == dup_key]) == 2,
            "B 第二次收到 messages.pending",
        )
        check(pushed_twice, "server 真的推播了兩次（否則這條沒有驗到去重）")
        await asyncio.sleep(0.5)
        check(len(delivered(dup_key)) == 1, "重複的 msgKey 只注入一次", delivered(dup_key))

        print("\n== 10. 政策拒絕／允許的真實往返 ==")
        # Three things are checked here, and they are opposites on purpose:
        #   * an unvouched-for machine of your own is held to the rules like
        #     anyone else — signing the account in on a second device is no
        #     longer the grant by itself, because the identity in that first
        #     message came over the wire;
        #   * once vouched for, a deny-everything policy does NOT stand between
        #     two machines of the same person;
        #   * a *different* account does not get as far as the policy at all,
        #     so this section registers one and checks it is turned away.
        deny_set = await write_policy(
            link_b,
            link_b,
            {
                "version": 1,
                "default": "deny",
                # A well-formed rule that simply does not name device A.
                "rules": [
                    {
                        "from": {"memberId": link_a.member_id, "deviceId": f"{DEVICE_A}-other"},
                        "to": {"workspace": WORKSPACE_LABEL, "paneName": PANE_NAME},
                        "action": "allow",
                    }
                ],
            },
        )
        check(deny_set.get("ok") is True, "（前置）把 B 的政策改成只允許別的裝置", deny_set)
        check(
            await until(lambda: link_b._policy_revision == 2, "B 的政策升到 revision 2"),
            "policy.changed 讓 B 換上新政策",
        )
        # --- your own second machine, unpaired and then paired again ---
        # Two halves, and the first one is the reason this section exists.
        # Signing the account in on a second device is not the grant: the
        # member id in a message is the relay's word, and the only thing that
        # makes a device *yours* here is a pairing two people confirmed. So B
        # unpairs A (the account view's "unpair" button, forget_device) and
        # A's next message is refused before the policy is even read —
        # REASON_NOT_PAIRED, not policy-denied, because there is no pin to
        # verify it against.
        #
        # Asserting only the second half would leave this line green after
        # somebody removed the gate — and removing it is exactly the tempting
        # "fix" when this section goes red.
        forgotten = await asyncio.to_thread(trust_store.forget_device, DEVICE_A)
        check(forgotten.get("found") is True, "（前置）B 端解除與 A 的配對", forgotten)
        unpaired_key = f"verify:{RUN}:own-unpaired"
        unpaired_send = await link_a.send_message(
            to=TO_B, sender=SENDER, text="before pairing again", msg_key=unpaired_key
        )
        check(
            isinstance(unpaired_send, dict) and unpaired_send.get("ok") is True,
            "server 接受送出（配對是收端的事，不是 server 的）",
            unpaired_send,
        )
        check(
            await until(
                lambda: any(m.get("msgKey") == unpaired_key for m in rec_a.acked),
                "A 收到未配對裝置的 acked",
            ),
            "未配對的自家裝置也會回報結果",
        )
        unpaired_ack = next((m for m in rec_a.acked if m.get("msgKey") == unpaired_key), {})
        check(
            unpaired_ack.get("reason") == server_link.REASON_NOT_PAIRED,
            "未配對的自家裝置在政策之前就被拒（not-paired，不進 own-device 環）",
            unpaired_ack,
        )
        check(
            delivered(unpaired_key) == [],
            "而且沒有送進 pane",
            delivered(unpaired_key),
        )

        # Pair again, the way two people do. B starts it this time: A still
        # pins B, so from A's side there is nothing to start — and a pairing
        # begun from the side that forgot is exactly the route the account
        # view offers after an unpair.
        check(await pair_links(link_b, link_a, "B↔A 重新配對"), "（前置）B 重新與 A 配對")

        own_key = f"verify:{RUN}:own-device"
        own_send = await link_a.send_message(
            to=TO_B, sender=SENDER, text="from my other machine", msg_key=own_key
        )
        check(
            isinstance(own_send, dict) and own_send.get("ok") is True,
            "server 接受送出（政策是收端的事，不是 server 的）",
            own_send,
        )
        check(
            await until(lambda: len(delivered(own_key)) == 1, "B 注入了自己另一台機器送來的訊息"),
            "已核准的自家第二台機器不受 pane 政策約束",
            delivered(own_key),
        )
        check(
            not any(m.get("msgKey") == own_key for m in rec_a.acked),
            "沒有被拒的 acked（豁免不是靠政策放行）",
        )
        link_b.note_delivery_result(own_key, True, json.dumps({"key": "ok"}))

        # --- a different account cannot reach this machine at all ---
        # Invites went with the tenant layer, so a second identity now comes
        # from a second registration. That also moved where the refusal
        # happens: `messages.send` requires the target device to belong to the
        # sender's own account, so a stranger is turned away by the server
        # before any pane policy is consulted. What is checked here is
        # therefore the isolation itself — a second account sees none of the
        # first account's devices, panes or messages.
        other_email = f"verify-policy-{RUN}@example.com"
        other_password = f"verify-pwd-{secrets.token_hex(8)}"
        other_account: dict[str, Any] = {}
        try:
            other_account = await server_link.account_request(
                URL,
                "auth.register",
                {
                    "email": other_email,
                    "password": other_password,
                    "displayName": f"policy-probe-{RUN}",
                },
            )
        except Exception as err:  # noqa: BLE001
            print(f"  （註冊第二個帳號失敗：{err}）")
        other_token = str(other_account.get("token") or "")
        check(
            bool(other_token),
            "（前置）另外註冊一個帳號當第二個身分",
            {key: value for key, value in other_account.items() if key != "token"},
        )
        link_c, rec_c = await open_link(f"{DEVICE_A}-other-account", "C", token=other_token)
        try:
            check(
                link_c.member_id and link_c.member_id != link_a.member_id,
                "C 是另一個帳號（不是 A 的另一台裝置）",
                {"a": link_a.member_id, "c": link_c.member_id},
            )
            # No directory assertion here on purpose: every link in this
            # process shares one agent_messaging registry, so C re-registers
            # the same local pane under its *own* account the moment it
            # connects — the row it then reads back is its own, and the check
            # would pass or fail for a reason that has nothing to do with
            # isolation. Section 16 asks that question from a link opened
            # after the registry is empty, which is where it can be answered.
            denied_key = f"verify:{RUN}:denied"
            denied_send = await link_c.send_message(
                to=TO_B,
                sender=dict(SENDER, workspace=WORKSPACE_LABEL),
                text="should be refused",
                msg_key=denied_key,
            )
            check(
                isinstance(denied_send, dict) and denied_send.get("ok") is False,
                "C 送不到 B（別的帳號的裝置一律當作不存在）",
                denied_send,
            )
            check(
                ((denied_send or {}).get("error") or {}).get("code") == "NOT_FOUND",
                "錯誤碼是 NOT_FOUND，不洩漏那台裝置存不存在",
                denied_send,
            )
            check(
                delivered(denied_key) == [], "被拒的訊息完全沒有廣播給 renderer", delivered(denied_key)
            )
            check(
                not any(m.get("msgKey") == denied_key for m in rec_c.acked),
                "訊息沒有進到系統，所以也沒有 acked",
                rec_c.acked,
            )
        finally:
            await link_c.stop()

        # --- C1, against a real server: a message nobody signed ---
        # The relay's move, reproduced end to end. `messages.send` is called
        # raw so the frame carries no `sig`, exactly as a relay writing its own
        # message would — the server stores and pushes it (it does not verify,
        # and must not), and the refusal happens at the receiver.
        #
        # Sent from A, which is now the only sender the server lets reach B at
        # all. That does not weaken the check: authenticity is settled *before*
        # the own-machine exemption, so an unsigned frame claiming to be from
        # your own other machine is refused exactly like a stranger's.
        unsigned_key = f"verify:{RUN}:unsigned"
        unsigned = await link_a._request(
            "messages.send",
            {"to": TO_B, "msgKey": unsigned_key, "text": "unsigned injection"},
        )
        check(unsigned.get("ok") is True, "server 收下未簽章的訊息（驗證不是它的事）", unsigned)
        check(
            await until(
                lambda: any(m.get("msgKey") == unsigned_key for m in rec_a.acked),
                "A 收到未簽章訊息的 acked",
            ),
            "未簽章的訊息也會被回報",
        )
        unsigned_ack = next((m for m in rec_a.acked if m.get("msgKey") == unsigned_key), {})
        check(
            unsigned_ack.get("reason") == server_link.REASON_UNAUTHENTICATED,
            "未簽章的訊息被拒為 unauthenticated（在政策與自家豁免之前）",
            unsigned_ack,
        )
        check(
            delivered(unsigned_key) == [],
            "未簽章的訊息完全沒有進到 pane",
            delivered(unsigned_key),
        )

        # --- and one whose signature is real but covers another message ---
        lifted_key = f"verify:{RUN}:lifted"
        lifted_sig = await asyncio.to_thread(
            device_signing.sign_message,
            msg_key=f"{lifted_key}-something-else",
            from_device=link_a._device_id,
            to_device=DEVICE_B,
            kind="text",
            body="lifted",
        )
        await link_a._request(
            "messages.send",
            {"to": TO_B, "msgKey": lifted_key, "text": "lifted", "sig": lifted_sig},
        )
        check(
            await until(
                lambda: any(m.get("msgKey") == lifted_key for m in rec_a.acked),
                "A 收到被搬過來的簽章的 acked",
            ),
            "簽章對不上訊息時也會回報",
        )
        lifted_ack = next((m for m in rec_a.acked if m.get("msgKey") == lifted_key), {})
        check(
            lifted_ack.get("reason") == server_link.REASON_UNAUTHENTICATED,
            "把別則訊息的簽章搬過來一樣被拒（msgKey 綁在簽章裡）",
            lifted_ack,
        )

        # --- C2, against a real server: an unsigned policy is no policy ---
        # Two defences stack over this document, which *would* let everyone
        # through, and they are worth checking apart from each other because
        # they fail in different worlds.
        forged_document = {"version": 1, "default": "allow", "rules": []}
        # The outer one is L3: the server refuses a write aimed at another
        # device, so "took over an account, rewrote a receiver's rules" is
        # turned away before any signature is consulted. This used to be the
        # admin-rewrite path and it is the reason this section exists.
        cross_write = await link_a._request(
            "policy.set", {"deviceId": DEVICE_B, "policy": forged_document}
        )
        check(
            cross_write.get("ok") is False
            and (cross_write.get("error") or {}).get("code") == "FORBIDDEN",
            "server 擋掉跨裝置的政策寫入（L3）",
            cross_write,
        )
        # The inner one is the one that still stands when the server itself is
        # hostile, which is the case C2 is actually about. B writes it for
        # itself so the ownership check is satisfied and the *client's*
        # signature verification is the only thing left that can refuse it.
        forged = await link_b._request(
            "policy.set", {"deviceId": DEVICE_B, "policy": forged_document}
        )
        check(forged.get("ok") is True, "server 收下未簽章的政策（它不解讀，也不該解讀）", forged)
        check(
            await until(lambda: link_b._policy_revision == 3, "B 抓到那份未簽章的政策"),
            "policy.changed 讓 B 去讀了那份文件",
        )
        check(
            link_b._policy is None,
            "未簽章的政策＝沒有政策（C2 的核心保證）",
            link_b._policy,
        )
        check(
            bool(
                [
                    n
                    for n in trust_store.notices()
                    if n["kind"] == trust_store.NOTICE_POLICY_UNVERIFIED
                ]
            ),
            "而且留下告警，不是無聲地全拒",
            trust_store.notices(),
        )

        allow_set = await write_policy(link_b, link_b, allow_a_policy(link_a.member_id))
        check(allow_set.get("ok") is True, "（前置）把 B 的政策改回允許 A", allow_set)
        check(
            await until(lambda: link_b._policy_revision == 4, "B 的政策升到 revision 4"),
            "policy.changed 讓 B 換回允許政策（未簽章那份佔掉了 revision 3）",
        )
        check(
            not [
                n
                for n in trust_store.notices()
                if n["kind"] == trust_store.NOTICE_POLICY_UNVERIFIED
            ],
            "重新寫一份簽章政策就把告警清掉了（那是唯一的出口）",
            trust_store.notices(),
        )
        allowed_key = f"verify:{RUN}:allowed"
        await link_a.send_message(to=TO_B, sender=SENDER, text="now allowed", msg_key=allowed_key)
        check(
            await until(lambda: len(delivered(allowed_key)) == 1, "允許後的訊息被注入"),
            "同一條路徑在政策允許時真的送達",
        )
        link_b.note_delivery_result(allowed_key, True, json.dumps({"key": "ok"}))
        check(
            await until(
                lambda: any(m.get("msgKey") == allowed_key for m in rec_a.acked), "A 收到 acked"
            ),
            "允許的往返也回報給發送端",
        )
        allowed_ack = next((m for m in rec_a.acked if m.get("msgKey") == allowed_key), {})
        check(allowed_ack.get("state") == "delivered", "acked 是 delivered", allowed_ack)

        print("\n== 11. paneId hint 失效後重新解析 ==")
        # A detach or reattach mints a new pane id, so a sender's cached hint
        # goes stale while the address itself stays correct.
        agent_messaging.unregister(PANE_ID)
        agent_messaging.register(PANE_ID_2, PANE_NAME, WORKSPACE_PATH, agent_key="claude")
        stale_key = f"verify:{RUN}:stale"
        await link_a.send_message(
            to=dict(TO_B, paneId=PANE_ID), sender=SENDER, text="find me anyway", msg_key=stale_key
        )
        check(
            await until(
                lambda: any(m.get("msgKey") == stale_key for m in rec_b.pending),
                "B 收到帶舊 paneId 的推播",
            ),
            "帶 hint 的訊息送達收端",
        )
        stale_push = next((m for m in rec_b.pending if m.get("msgKey") == stale_key), {})
        check(
            (stale_push.get("to") or {}).get("paneId") == PANE_ID,
            "server 原樣轉發 to.paneId（hint 真的有到收端，這條才有意義）",
            stale_push.get("to"),
        )
        check(
            await until(lambda: len(delivered(stale_key)) == 1, "重新解析後注入"),
            "失效的 hint 沒有讓投遞失敗",
        )
        check(
            delivered(stale_key) and delivered(stale_key)[0].get("target_pane_id") == PANE_ID_2,
            "重新解析到新的 pane id",
            delivered(stale_key),
        )
        link_b.note_delivery_result(stale_key, True, json.dumps({"key": "ok"}))
        check(
            await until(
                lambda: any(m.get("msgKey") == stale_key for m in rec_a.acked), "A 收到 acked"
            ),
            "重新解析後的結果回報給發送端",
        )
        stale_ack = next((m for m in rec_a.acked if m.get("msgKey") == stale_key), {})
        check(
            stale_ack.get("ackPaneId") == PANE_ID_2,
            "ack 把新的 pane id 回帶給發送端（快取才更新得了）",
            stale_ack,
        )

        print("\n== 12. 遠端名冊：兩台裝置互相看得見對方的 pane ==")
        # The half stage 2 left out. Without it an agent can address
        # `<device>/<workspace>/<pane>` but has no way to learn that any device
        # or pane exists, so the whole cross-device path needs a human to paste
        # a device id in.
        check(bool(rec_a.directories), "連線建立時就抓過一次 sessions.directory")
        before = len(rec_a.directories)
        # Nudge both reporters: this script has no ws_handlers calling
        # server_link.roster_changed(), so nothing else would push before the
        # 30s sweep.
        link_a.notify_roster_changed()
        link_b.notify_roster_changed()

        def _both_devices_listed() -> bool:
            if len(rec_a.directories) <= before:
                return False
            rows = (rec_a.directories[-1] or {}).get("sessions") or []
            listed = {str(r.get("deviceId") or "") for r in rows if isinstance(r, dict)}
            return {DEVICE_A, DEVICE_B} <= listed

        check(
            await until(_both_devices_listed, "A 收到含兩台裝置的 sessions.changed"),
            "名冊變更由 server 主動推播（不必輪詢）",
        )
        rows = [r for r in ((rec_a.directories[-1] or {}).get("sessions") or []) if isinstance(r, dict)]
        row_b = next((r for r in rows if r.get("deviceId") == DEVICE_B), {})
        check(
            all(
                key in row_b
                for key in ("deviceId", "workspace", "workspacePath", "paneId", "title", "status", "hostOnline")
            ),
            "目錄每一列都帶定址與狀態需要的欄位",
            row_b,
        )
        check(row_b.get("hostOnline") is True, "B 在線時它的列 hostOnline=true", row_b)
        # deviceName is what lets a person address a machine by a name instead of
        # copying a UUID, so it is asserted rather than merely noted: the server
        # joins it in from the devices table, and a regression there would show
        # up as addressing silently falling back to device ids.
        check(
            row_b.get("deviceName") == "verify-B",
            "目錄帶 deviceName（auth.hello 報的那個名字，經 devices 表 join 回來）",
            row_b.get("deviceName"),
        )

        # Both directions, from one snapshot: the only difference between the
        # two views is which device is "me".
        remote_roster.replace(rows, local_device_id=DEVICE_A)
        a_view = {p.address for p in remote_roster.list_panes()}
        check(
            not any(p.device_id == DEVICE_A for p in remote_roster.list_panes()),
            "A 的遠端名冊不含自己的 pane（本機那份在 agent_messaging）",
            sorted(a_view),
        )
        check(
            f"{DEVICE_B}/{WORKSPACE_LABEL}/{PANE_NAME}" in a_view,
            "A 看得到 B 上的 pane，位址可直接複製去送",
            sorted(a_view),
        )
        remote_roster.replace(rows, local_device_id=DEVICE_B)
        b_view = {p.address for p in remote_roster.list_panes()}
        check(
            f"{DEVICE_A}/{WORKSPACE_LABEL}/{PANE_NAME}" in b_view,
            "B 也看得到 A 上的 pane",
            sorted(b_view),
        )

        remote_roster.replace(rows, local_device_id=DEVICE_A)
        target = f"{DEVICE_B}/{WORKSPACE_LABEL}/{PANE_NAME}"
        check(
            agent_messaging.parse_target(target).device_id == "",
            "（前提）非 UUID 形狀的 deviceId 舊的形狀判定認不出來",
        )
        match = agent_messaging.parse_remote_target(target)
        check(
            match.address is not None and match.address.device_id == DEVICE_B,
            "名冊讓這個位址解析得出裝置（形狀判定之外的第二次解讀）",
            {"error": match.error},
        )
        # The point of deviceName: a person addresses "the laptop", not a UUID.
        named = agent_messaging.parse_remote_target(
            f"verify-B/{WORKSPACE_LABEL}/{PANE_NAME}"
        )
        check(
            named.address is not None and named.address.device_id == DEVICE_B,
            "人類可讀的裝置名解析到同一台裝置（使用者不必複製 UUID）",
            {"error": named.error},
        )
        # The server stores the name exactly as auth.hello reported it and never
        # resolves anything by it, so the case a person types is ours to forgive.
        cased = agent_messaging.parse_remote_target(
            f"VeRiFy-b/{WORKSPACE_LABEL}/{PANE_NAME}"
        )
        check(
            cased.address is not None and cased.address.device_id == DEVICE_B,
            "裝置名大小寫不同也解析得到（server 原樣存名字，比對規則由本機定）",
            {"error": cased.error},
        )
        # One assertion guarding two layers, which is why it is here and not
        # only in test_remote_roster.py — do not remove it as a duplicate.
        #
        #   application: an id is opaque and machine-minted, so folding its case
        #   could only ever make two distinct devices collide.
        #   storage: the id arrives from the server's directory. A MySQL schema
        #   on a *_ci collation returns rows for a query that differs only in
        #   case, and the roster would then answer for a device nobody asked
        #   for. SQLite is always binary, so a local run cannot see this at all.
        #
        # Against the production server this is the check that proves the
        # deployment's collation, not just this module's comparison.
        wrong_case_id = DEVICE_B.upper()
        folded = agent_messaging.parse_remote_target(
            f"{wrong_case_id}/{WORKSPACE_LABEL}/{PANE_NAME}"
        )
        check(
            folded.address is None,
            "deviceId 大小寫不同「不」該解析得到（id 精確比對；在 *_ci collation 的 MySQL 上會失敗）",
            {"queried": wrong_case_id, "resolved": folded.address.device_id if folded.address else None},
        )

        # A device leaving changes no session row, so only presence.changed
        # reports it — without that push the roster would keep saying B is
        # reachable. Stopping B here also sets up section 13.
        await link_b.stop()
        check(
            await until(
                lambda: bool(remote_roster.list_panes())
                and all(p.offline for p in remote_roster.list_panes() if p.device_id == DEVICE_B),
                "A 的名冊把 B 的 pane 標成離線",
            ),
            "presence.changed 讓離線裝置的 pane 立刻變成 offline",
            sorted((p.address, p.host_online, p.status) for p in remote_roster.list_panes()),
        )
        # B is gone, so it can no longer clean up after itself; this member is
        # an admin, so A removes its rows instead of leaving them on a shared
        # server.
        for row_left in rows:
            if row_left.get("deviceId") == DEVICE_B and row_left.get("sessionId"):
                await link_a._request("sessions.remove", {"sessionId": row_left["sessionId"]})
        remote_roster._reset_for_test()

        print("\n== 13. DEVICE_OFFLINE ==")
        # link_b was stopped and its rows removed at the end of section 12.
        await asyncio.sleep(0.6)
        offline_reply = await link_a.send_message(
            to={"deviceId": DEVICE_B, "workspace": WORKSPACE_LABEL, "paneName": PANE_NAME},
            sender=None,
            text="you are gone",
            msg_key=f"verify:{RUN}:offline",
        )
        check(
            isinstance(offline_reply, dict) and offline_reply.get("ok") is False,
            "對已離線裝置送出被拒",
            offline_reply,
        )
        check(
            ((offline_reply or {}).get("error") or {}).get("code") == "DEVICE_OFFLINE",
            "錯誤碼是 DEVICE_OFFLINE",
            offline_reply,
        )
    finally:
        with_cleanup = [link_a]
        for link in with_cleanup:
            try:
                await link._request("sessions.sync", {"sessions": []})
            except Exception as err:  # noqa: BLE001
                print(f"  (cleanup) sessions.sync failed: {err}")
        await link_a.stop()
        await link_b.stop()
        agent_messaging._reset_for_test()

    await check_server_outage()
    await check_account_flow()

    print(f"\n== 結果：{_passed} 通過 / {_failed} 失敗 ==")
    return 1 if _failed else 0


async def check_server_outage() -> None:
    """Section 14: the server disappears mid-session, then comes back.

    Runs against its own disposable instance, so the shared one under NAVIDE_WS
    is never taken down. Everything here is about a *configured* link: the
    no-server-configured path is a different branch entirely and is covered by
    backend/tests (it must never reach this module at all).
    """
    print("\n== 14. Server 中途斷線與自動恢復 ==")
    if not SERVER_DIR.exists():
        check(False, f"找不到 server 目錄 {SERVER_DIR}（用 NAVIDE_SERVER_DIR 指定）")
        return

    db_dir = Path(tempfile.mkdtemp(prefix="navide-verify-db-"))
    disposable = DisposableServer(VERIFY_PORT, db_dir)
    link_c: ServerLink | None = None
    link_d: ServerLink | None = None
    try:
        try:
            await disposable.start()
        except Exception as err:  # noqa: BLE001
            check(False, f"無法啟動可拋棄的 server：{err}")
            return
        check(True, f"在 port {VERIFY_PORT} 起了一台自己的 server（不動 {URL}）")

        agent_messaging.register(PANE_ID, PANE_NAME, WORKSPACE_PATH, agent_key="claude")
        link_c, _ = await open_link(DEVICE_C, "C", disposable.url, disposable.token)
        link_d, rec_d = await open_link(DEVICE_D, "D", disposable.url, disposable.token)
        granted = await write_policy(
            link_d, link_d, allow_a_policy(link_c.member_id, DEVICE_C)
        )
        check(granted.get("ok") is True, "（前置）允許 C 驅動 D 的 pane", granted)
        await until(lambda: link_d._policy_revision == 1, "D 收到政策")
        check(await pair_links(link_c, link_d, "C↔D"), "（前置）C↔D 配對完成")

        to_d = {"deviceId": DEVICE_D, "workspace": WORKSPACE_LABEL, "paneName": PANE_NAME}

        cached_policy = link_d._policy

        await disposable.stop()
        check(
            await until(lambda: link_c._ws is None, "C 察覺連線斷了"),
            "server 消失後連線狀態被清掉",
        )
        # t6/t12: an authorization decision must not depend on the control plane
        # being reachable at the moment a message lands.
        check(
            link_d._policy == cached_policy and link_d._policy_revision == 1,
            "斷線期間 D 的政策快取原封不動（仍可判斷處理中的訊息）",
            {"revision": link_d._policy_revision},
        )

        loop = asyncio.get_running_loop()
        started_at = loop.time()
        down_reply = await asyncio.wait_for(
            link_c.send_message(
                to=to_d, sender=SENDER, text="while down", msg_key=f"verify:{RUN}:down"
            ),
            timeout=5.0,
        )
        elapsed = loop.time() - started_at
        check(
            isinstance(down_reply, dict) and down_reply.get("ok") is False,
            "斷線期間送出直接失敗",
            down_reply,
        )
        # The point of the whole exercise: a connection problem must not come
        # back looking like a bad address.
        check(
            ((down_reply or {}).get("error") or {}).get("code") == server_link.LINK_OFFLINE,
            "錯誤碼是 LINK_OFFLINE（不是 unknown-device，也不是 server 的拒絕）",
            down_reply,
        )
        check(
            elapsed < 1.0,
            f"而且是立刻失敗：{elapsed:.2f}s（不是 {server_link.REQUEST_TIMEOUT_S:.0f}s 逾時）",
        )

        await disposable.start()
        # No one restarts the link: the reconnect backoff is the only thing that
        # can change the answer, and this is the check that it does.
        recovered = await until(
            lambda: bool(link_c and link_c._authenticated and link_d and link_d._authenticated),
            "C/D 自己重連並重新認證",
            timeout=90.0,
        )
        check(recovered, "server 回來後兩條連線都自動接回（沒有人手動介入）")
        if not recovered:
            return

        resume_key = f"verify:{RUN}:resumed"
        resumed = await link_c.send_message(
            to=to_d, sender=SENDER, text="after recovery", msg_key=resume_key
        )
        check(
            isinstance(resumed, dict) and resumed.get("ok") is True,
            "恢復後同一條 link 又送得出去",
            resumed,
        )
        check(
            await until(lambda: len(delivered(resume_key)) == 1, "恢復後的訊息被注入"),
            "恢復是完整的：訊息真的送進收端 pane，不只是連線接回來",
        )
        check(
            bool(rec_d.pending) and link_d._policy_revision == 1,
            "重連後政策重新抓回同一個 revision，收端仍照原政策放行",
            {"revision": link_d._policy_revision},
        )
    finally:
        for link in (link_c, link_d):
            if link is not None:
                with contextlib.suppress(Exception):
                    await link._request("sessions.sync", {"sessions": []})
                await link.stop()
        await disposable.stop()
        shutil.rmtree(db_dir, ignore_errors=True)
        agent_messaging._reset_for_test()


async def check_account_flow() -> None:
    """Section 16: registering and signing in, end to end against a real server.

    This is the only place the account path is exercised against a server rather
    than a fake. It matters because the two calls run *before* a token exists —
    they cannot use the long-lived link, so a mistake here is invisible to every
    test that starts from an authenticated connection.

    The last check is the important one: an account registered here is a
    separate identity, so it must not be able to see the pane the first account
    registered at the top of this script. That is the account boundary observed
    from the desktop side, not from the server's own test suite.
    """
    print("\n== 16. 帳號註冊與登入 ==")
    stamp = RUN
    email = f"verify-{stamp}@example.com"
    dummy_pass = f"verify-pwd-{secrets.token_hex(8)}"

    try:
        created = await server_link.account_request(
            URL, "auth.register", {"email": email, "password": dummy_pass}
        )
    except Exception as err:  # noqa: BLE001
        check(False, f"註冊失敗：{err}")
        return

    token = str(created.get("token") or "")
    member_id = str(created.get("memberId") or "")
    check(bool(token), "註冊回傳長期 token", {k: v for k, v in created.items() if k != "token"})
    check(bool(member_id), "註冊建立了一個新帳號", member_id)
    # 角色與租戶都隨兩層收斂移除：回應不該再帶它們。這是負面斷言——
    # 欄位悄悄留著比缺少更難發現，因為沒有任何東西會壞掉。
    check(
        "role" not in created and "tenantId" not in created,
        "註冊回應不再帶 role / tenantId",
        {k: created.get(k) for k in ("role", "tenantId") if k in created},
    )

    # Same email twice must not silently create a second account.
    try:
        await server_link.account_request(URL, "auth.register", {"email": email, "password": dummy_pass})
        check(False, "重複 email 應該被拒")
    except server_link.AccountError as err:
        check(err.code == "EMAIL_TAKEN", "重複 email → EMAIL_TAKEN", err.code)

    try:
        await server_link.account_request(URL, "auth.login", {"email": email, "password": f"wrong-{stamp}"})
        check(False, "錯誤密碼應該被拒")
    except server_link.AccountError as err:
        check(err.code == "AUTH_REJECTED", "錯誤密碼 → AUTH_REJECTED", err.code)

    try:
        signed_in = await server_link.account_request(
            URL, "auth.login", {"email": email, "password": dummy_pass}
        )
    except Exception as err:  # noqa: BLE001
        check(False, f"登入失敗：{err}")
        return
    check(signed_in.get("token") == token, "登入取回同一組裝置 token")
    check(signed_in.get("memberId") == member_id, "登入回報同一個帳號")

    # The token must actually work as a device credential.
    device = f"verify-acct-{stamp}"
    _current_device.set(device)
    link = ServerLink(
        config_loader=lambda: ServerLinkConfig(url=URL, token=token),
        token_clearer=lambda: None,
        device_name="verify-account",
    )
    try:
        started = await link.start()
        check(started, "用註冊拿到的 token 可以建立連線")
        authed = await until(
            lambda: bool(link.member_id) or bool(link.terminated_reason), "account auth"
        )
        check(authed and not link.terminated_reason, "auth.hello 接受這組 token", link.terminated_reason)
        check(link.member_id == member_id, "連線回報的帳號與註冊時相同", link.member_id)

        directory = await link._request("sessions.directory", {})
        sessions = ((directory.get("payload") or {}).get("sessions")) or []
        names = [str(row.get("paneId") or "") for row in sessions]
        check(
            PANE_ID not in names and PANE_ID_2 not in names,
            "新租戶看不到 admin 租戶登記的 pane（跨租戶隔離，從桌面端這側觀察）",
            names,
        )
    finally:
        await link.stop()
        print(
            f"  （留下一個帳號 {email}：server 沒有刪除租戶的介面，"
            f"所以每跑一次就多一個測試租戶，不是腳本沒清乾淨）"
        )


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
