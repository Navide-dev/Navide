"""Client side of the Agent Client Protocol (ACP) over stdio.

ACP is JSON-RPC 2.0, one message per line, on the agent's stdin/stdout. This
module speaks it and nothing else: it does not spawn, register or stop the
agent process (``acp_sessions`` does), and it knows no vendor.

What Navide offers the agent is fixed here: ``initialize`` declares no client
filesystem and no client terminal, so an agent cannot ask Navide to read or
write files or run commands for it; it uses its own tools, as it does in a
terminal pane. A request Navide does not serve is answered "method not found".

Nothing is capped: a line is read whole however long it is (a tool call can
carry a large diff), and no count or size limit applies to queued messages.
Design: navide-devmap-mockups/planb/0228/DESIGN-acp-mode.md.
"""

from __future__ import annotations

import asyncio
import inspect
import itertools
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

log = logging.getLogger("agent_team_backend.acp_client")

PROTOCOL_VERSION = 1
CLIENT_CAPABILITIES: dict[str, Any] = {
    "fs": {"readTextFile": False, "writeTextFile": False},
    "terminal": False,
}
STOP_REASONS = frozenset({"end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"})

# JSON-RPC 2.0 error codes.
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603

_READ_CHUNK = 65536

UpdateHandler = Callable[[dict[str, Any]], Awaitable[None] | None]
# Gets the session/request_permission params; returns the chosen optionId, or
# None for "cancelled".
PermissionHandler = Callable[[dict[str, Any]], Awaitable[str | None]]


class AcpError(Exception):
    """The agent answered a request with a JSON-RPC error."""

    def __init__(self, method: str, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"{method}: {message} ({code})")
        self.method = method
        self.code = code
        self.message = message
        self.data = data


class AcpProtocolError(Exception):
    """The agent's answer does not fit the protocol (wrong version, missing field)."""


class AcpClosed(Exception):
    """The agent's output ended (the process exited) before an answer came."""


@dataclass
class AcpInitResult:
    protocol_version: int
    agent_capabilities: dict[str, Any] = field(default_factory=dict)
    agent_info: dict[str, Any] = field(default_factory=dict)
    auth_methods: list[dict[str, Any]] = field(default_factory=list)

    @property
    def load_session(self) -> bool:
        return bool(self.agent_capabilities.get("loadSession"))

    @property
    def list_sessions(self) -> bool:
        caps = self.agent_capabilities.get("sessionCapabilities")
        return isinstance(caps, dict) and caps.get("list") is not None


class AcpClient:
    """One ACP connection: requests out, the agent's requests and updates in.

    ``reader`` is the agent's stdout, ``writer`` its stdin (anything with
    ``write``, ``drain`` and ``close``). ``on_update`` receives every
    ``session/update``'s params in order; ``on_permission`` answers
    ``session/request_permission``. Call ``start()`` before the first request.
    """

    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: Any,
        *,
        on_update: UpdateHandler | None = None,
        on_permission: PermissionHandler | None = None,
    ) -> None:
        self._reader = reader
        self._writer = writer
        self._on_update = on_update
        self._on_permission = on_permission
        self._ids = itertools.count(1)
        self._pending: dict[int, tuple[str, asyncio.Future[Any]]] = {}
        self._write_lock = asyncio.Lock()
        self._read_task: asyncio.Task[None] | None = None
        # session id -> the permission requests the agent is still waiting on.
        self._asking: dict[str, set[asyncio.Task[None]]] = {}
        # Sessions cancelled while their prompt runs: their permission requests
        # are answered "cancelled" on arrival (see cancel / prompt).
        self._cancelled: set[str] = set()
        self._serving: set[asyncio.Task[None]] = set()  # the agent's requests being answered
        self._closed: BaseException | None = None
        self.bad_lines = 0  # lines that were not JSON-RPC messages; logged, then skipped

    # -- lifecycle --------------------------------------------------------

    def start(self) -> None:
        if self._read_task is None:
            self._read_task = asyncio.ensure_future(self._read_loop())

    @property
    def closed(self) -> bool:
        return self._closed is not None

    async def wait_closed(self) -> None:
        if self._read_task is not None:
            await asyncio.shield(self._read_task)

    async def close(self) -> None:
        """Close the agent's stdin (its cue to exit) and stop reading."""
        try:
            self._writer.close()
        except Exception:  # noqa: BLE001
            pass
        if self._read_task is not None and not self._read_task.done():
            self._read_task.cancel()
            try:
                await self._read_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._fail_pending(AcpClosed("the ACP connection was closed"))
        serving = list(self._serving)
        for task in serving:
            task.cancel()
        await asyncio.gather(*serving, return_exceptions=True)

    # -- requests ---------------------------------------------------------

    async def initialize(self, client_info: dict[str, Any] | None = None) -> AcpInitResult:
        params: dict[str, Any] = {
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": CLIENT_CAPABILITIES,
        }
        if client_info:
            params["clientInfo"] = client_info
        result = await self.request("initialize", params)
        if not isinstance(result, dict) or not isinstance(result.get("protocolVersion"), int):
            raise AcpProtocolError("initialize: the agent sent no protocolVersion")
        if result["protocolVersion"] != PROTOCOL_VERSION:
            raise AcpProtocolError(
                f"initialize: the agent speaks ACP version {result['protocolVersion']}, "
                f"Navide speaks {PROTOCOL_VERSION}"
            )
        return AcpInitResult(
            protocol_version=result["protocolVersion"],
            agent_capabilities=_dict(result.get("agentCapabilities")),
            agent_info=_dict(result.get("agentInfo")),
            auth_methods=[m for m in result.get("authMethods") or [] if isinstance(m, dict)],
        )

    async def new_session(self, cwd: str, mcp_servers: list[dict[str, Any]] | None = None) -> str:
        result = await self.request("session/new", {"cwd": cwd, "mcpServers": mcp_servers or []})
        session_id = result.get("sessionId") if isinstance(result, dict) else None
        if not isinstance(session_id, str) or not session_id:
            raise AcpProtocolError("session/new: the agent sent no sessionId")
        return session_id

    async def load_session(
        self, session_id: str, cwd: str, mcp_servers: list[dict[str, Any]] | None = None
    ) -> None:
        """Resume a session; the agent replays its history as session/update first."""
        await self.request(
            "session/load", {"sessionId": session_id, "cwd": cwd, "mcpServers": mcp_servers or []}
        )

    async def list_sessions(self, cwd: str | None = None, cursor: str | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if cwd:
            params["cwd"] = cwd
        if cursor:
            params["cursor"] = cursor
        result = await self.request("session/list", params)
        return result if isinstance(result, dict) else {"sessions": []}

    async def prompt(self, session_id: str, text: str) -> str:
        """Send one prompt and wait for the turn to end; returns its stopReason.

        ACP has no session/stop: a turn ends only when the agent answers this
        request, with stopReason "cancelled" after a ``cancel``.
        """
        # A new turn: an earlier cancel of this session no longer applies.
        self._cancelled.discard(session_id)
        try:
            result = await self.request(
                "session/prompt", {"sessionId": session_id, "prompt": [{"type": "text", "text": text}]}
            )
        finally:
            self._cancelled.discard(session_id)
        reason = result.get("stopReason") if isinstance(result, dict) else None
        if not isinstance(reason, str):
            raise AcpProtocolError("session/prompt: the agent sent no stopReason")
        if reason not in STOP_REASONS:
            log.info("ACP: unknown stopReason %r, passed on as is", reason)
        return reason

    async def cancel(self, session_id: str) -> None:
        """Ask the agent to end the running turn (a notification: no answer).

        The permission requests still open for the session are answered
        "cancelled" here, as the protocol requires of the client, and so is any
        the agent sends from now until its prompt returns.
        """
        self._cancelled.add(session_id)
        for task in list(self._asking.get(session_id, ())):
            task.cancel()
        await self.notify("session/cancel", {"sessionId": session_id})

    async def request(self, method: str, params: dict[str, Any]) -> Any:
        if self._closed is not None:
            raise AcpClosed(f"{method}: the ACP connection is closed")
        request_id = next(self._ids)
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = (method, future)
        try:
            await self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            return await future
        finally:
            self._pending.pop(request_id, None)

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    # -- wire -------------------------------------------------------------

    async def _send(self, message: dict[str, Any]) -> None:
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
        async with self._write_lock:
            try:
                self._writer.write(line.encode("utf-8"))
                await self._writer.drain()
            except (ConnectionError, RuntimeError) as err:
                raise AcpClosed(f"the agent's input is closed: {err}") from err

    async def _read_loop(self) -> None:
        # A bytearray grown in place, searched only past what was already
        # searched: a line of any length is read in linear time.
        buffer = bytearray()
        searched = 0
        try:
            while True:
                chunk = await self._reader.read(_READ_CHUNK)
                if not chunk:
                    break
                buffer += chunk
                while (newline := buffer.find(b"\n", searched)) >= 0:
                    line = bytes(buffer[:newline])
                    del buffer[:newline + 1]
                    searched = 0
                    if line.strip():
                        await self._handle_line(line)
                searched = len(buffer)
            if buffer.strip():
                await self._handle_line(bytes(buffer))
        finally:
            self._fail_pending(AcpClosed("the agent's output ended"))

    def _fail_pending(self, err: BaseException) -> None:
        if self._closed is None:
            self._closed = err
        for _method, future in list(self._pending.values()):
            if not future.done():
                future.set_exception(err)
        for tasks in self._asking.values():
            for task in tasks:
                task.cancel()

    async def _handle_line(self, line: bytes) -> None:
        try:
            message = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            # ValueError covers JSONDecodeError and a number too long to parse;
            # RecursionError, nesting too deep. Skipped like any bad line: the
            # loop must keep reading (a permission request may come next).
            message = None
        if not isinstance(message, dict):
            self.bad_lines += 1
            log.warning("ACP: skipped a line that is not a JSON-RPC message (%d bytes)", len(line))
            return
        method = message.get("method")
        if isinstance(method, str):
            if "id" in message:
                # Its own task: an answer (a person choosing an option) can take
                # as long as it takes, and updates keep flowing meanwhile.
                task = asyncio.ensure_future(self._serve(message["id"], method, message.get("params")))
                self._serving.add(task)
                task.add_done_callback(self._serving.discard)
            else:
                await self._notification(method, message.get("params"))
            return
        if "id" in message and ("result" in message or "error" in message):
            self._answer(message)
            return
        self.bad_lines += 1
        log.warning("ACP: skipped a message that is neither a request, a notification nor a response")

    def _answer(self, message: dict[str, Any]) -> None:
        request_id = message["id"]
        entry = (
            self._pending.get(request_id)
            if isinstance(request_id, int) and not isinstance(request_id, bool) else None
        )
        if entry is None:
            log.warning("ACP: an answer to no request of ours (id %r)", message["id"])
            return
        method, future = entry
        if future.done():
            return
        error = message.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            future.set_exception(AcpError(
                method, code if isinstance(code, int) and not isinstance(code, bool) else INTERNAL_ERROR,
                str(error.get("message") or ""), error.get("data"),
            ))
        else:
            future.set_result(message.get("result"))

    async def _notification(self, method: str, params: Any) -> None:
        if method == "session/update":
            if isinstance(params, dict) and self._on_update is not None:
                try:
                    outcome = self._on_update(params)
                    if inspect.isawaitable(outcome):
                        await outcome
                except Exception as err:  # noqa: BLE001
                    log.warning("ACP: the update handler failed: %s", err)
            return
        log.debug("ACP: notification %s ignored", method)

    async def _serve(self, request_id: Any, method: str, params: Any) -> None:
        if method == "session/request_permission" and isinstance(params, dict):
            await self._ask_permission(request_id, params)
            return
        await self._reply_error(request_id, METHOD_NOT_FOUND, f"Navide does not serve {method}")

    async def _ask_permission(self, request_id: Any, params: dict[str, Any]) -> None:
        session_id = str(params.get("sessionId") or "")
        if session_id in self._cancelled:
            # Sent after (or racing) the cancel: never shown, never allowed.
            await self._reply(request_id, _permission_outcome(None))
            return
        replying = False

        async def ask() -> None:
            nonlocal replying
            option_id = None
            if self._on_permission is not None:
                option_id = await self._on_permission(params)
            replying = True
            await self._reply(request_id, _permission_outcome(option_id))

        task = asyncio.ensure_future(ask())
        self._asking.setdefault(session_id, set()).add(task)
        try:
            await task
        except asyncio.CancelledError:
            # A cancelled turn, or the connection went away: "cancelled" — unless
            # the user's answer was already on its way (one reply per id).
            if self._closed is None and not replying:
                await self._reply(request_id, _permission_outcome(None))
        except Exception as err:  # noqa: BLE001
            log.warning("ACP: the permission handler failed: %s", err)
            await self._reply_error(request_id, INTERNAL_ERROR, "Navide could not ask for permission")
        finally:
            asking = self._asking.get(session_id)
            if asking is not None:
                asking.discard(task)
                if not asking:
                    del self._asking[session_id]

    async def _reply(self, request_id: Any, result: Any) -> None:
        try:
            await self._send({"jsonrpc": "2.0", "id": request_id, "result": result})
        except AcpClosed:
            pass

    async def _reply_error(self, request_id: Any, code: int, message: str) -> None:
        try:
            await self._send({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})
        except AcpClosed:
            pass


def _permission_outcome(option_id: str | None) -> dict[str, Any]:
    if option_id is None:
        return {"outcome": {"outcome": "cancelled"}}
    return {"outcome": {"outcome": "selected", "optionId": option_id}}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}
