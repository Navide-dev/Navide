"""A scriptable fake Telegram Bot API bound to 127.0.0.1 on an ephemeral port."""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable


class FakeBotApi:
    def __init__(self, token: str = "12345:SECRET", *, username: str = "navide_bot",
                 can_manage_bots: bool | None = None) -> None:
        self.token = token
        self.username = username
        # Left out of getMe when None, as the Bot API did before 9.6.
        self.can_manage_bots = can_manage_bots
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.updates: list[dict[str, Any]] = []
        self._next_update_id = 100
        self._next_message_id = 1
        self._next_thread_id = 50
        # method -> list of scripted error bodies consumed one per call.
        self.errors: dict[str, list[dict[str, Any]]] = {}
        self.handlers: dict[str, Callable[[dict[str, Any]], Any]] = {}
        self.lock = threading.Lock()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler_cls())
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> "FakeBotApi":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()

    # --- scripting ----------------------------------------------------------

    def push_message(self, *, chat_id: int, text: str, sender_id: int = 7, username: str = "alice",
                     chat_type: str = "private", thread_id: int | None = None,
                     topic: bool = False, forum: bool = False) -> int:
        with self.lock:
            uid = self._next_update_id
            self._next_update_id += 1
            mid = self._next_message_id
            self._next_message_id += 1
            msg: dict[str, Any] = {
                "message_id": mid, "date": int(time.time()), "text": text,
                "chat": {"id": chat_id, "type": chat_type, "title": f"chat{chat_id}", "is_forum": forum},
                "from": {"id": sender_id, "is_bot": False, "username": username},
            }
            if thread_id is not None:
                msg["message_thread_id"] = thread_id
            if topic:
                msg["is_topic_message"] = True
            self.updates.append({"update_id": uid, "message": msg})
            return uid

    def push_callback(self, *, chat_id: int, data: str, sender_id: int = 7) -> int:
        with self.lock:
            uid = self._next_update_id
            self._next_update_id += 1
            self.updates.append({"update_id": uid, "callback_query": {
                "id": f"q{uid}", "data": data, "from": {"id": sender_id, "username": "alice"},
                "message": {"message_id": 1, "chat": {"id": chat_id, "type": "private"}},
            }})
            return uid

    def push_managed_bot(self, *, creator_id: int, bot_id: int, bot_username: str = "made_bot",
                         first_name: str = "Navide bot") -> int:
        """A ManagedBotUpdated: ``creator_id`` created (or re-tokened) bot ``bot_id``."""
        with self.lock:
            uid = self._next_update_id
            self._next_update_id += 1
            self.updates.append({"update_id": uid, "managed_bot": {
                "user": {"id": creator_id, "is_bot": False, "first_name": "neil"},
                "bot": {"id": bot_id, "is_bot": True, "first_name": first_name, "username": bot_username},
            }})
            return uid

    def fail(self, method: str, code: int, description: str, retry_after: int | None = None,
             times: int = 1) -> None:
        body: dict[str, Any] = {"ok": False, "error_code": code, "description": description}
        if retry_after is not None:
            body["parameters"] = {"retry_after": retry_after}
        self.errors.setdefault(method, []).extend([body] * times)

    def calls_of(self, method: str) -> list[dict[str, Any]]:
        with self.lock:
            return [p for m, p in self.calls if m == method]

    # --- request handling ---------------------------------------------------

    def _dispatch(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            self.calls.append((method, params))
            errs = self.errors.get(method)
            if errs:
                return errs.pop(0)
        if method in self.handlers:
            return {"ok": True, "result": self.handlers[method](params)}
        if method == "getMe":
            me: dict[str, Any] = {"id": int(self.token.split(":")[0]), "is_bot": True, "first_name": "Navide",
                                  "username": self.username}
            if self.can_manage_bots is not None:
                me["can_manage_bots"] = self.can_manage_bots
            return {"ok": True, "result": me}
        if method == "getUpdates":
            offset = params.get("offset")
            deadline = time.time() + 0.2
            while True:
                with self.lock:
                    if offset is not None:
                        self.updates = [u for u in self.updates if u["update_id"] >= offset]
                    pending = list(self.updates)
                if pending or time.time() > deadline:
                    return {"ok": True, "result": pending}
                time.sleep(0.02)
        if method in ("sendMessage", "editMessageText"):
            with self.lock:
                mid = self._next_message_id
                self._next_message_id += 1
            return {"ok": True, "result": {"message_id": params.get("message_id", mid)}}
        if method == "createForumTopic":
            with self.lock:
                tid = self._next_thread_id
                self._next_thread_id += 1
            return {"ok": True, "result": {"message_thread_id": tid, "name": params.get("name")}}
        return {"ok": True, "result": True}

    def _handler_cls(self) -> type[BaseHTTPRequestHandler]:
        api = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                pass

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                params = json.loads(self.rfile.read(length) or b"{}")
                prefix = f"/bot{api.token}/"
                if not self.path.startswith(prefix):
                    body = {"ok": False, "error_code": 401, "description": "Unauthorized"}
                else:
                    body = api._dispatch(self.path[len(prefix):], params)
                raw = json.dumps(body).encode()
                status = 200 if body.get("ok") else int(body.get("error_code", 400))
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        return Handler
