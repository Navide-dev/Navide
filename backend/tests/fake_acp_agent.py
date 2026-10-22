"""A stand-in ACP agent for the acp_client tests: JSON-RPC over stdio, per spec.

    python fake_acp_agent.py <scenario>

Scenarios (what a session/prompt does):
  reply           stream two agent_message_chunk updates, then end_turn
  permission      ask session/request_permission, say which option came back, end_turn
  cancel          stream, then wait; on session/cancel answer stopReason "cancelled"
  ignore_cancel   stream, then never answer the prompt, whatever comes in
  ask_navide      call fs/read_text_file on the client, report the error code, end_turn
  bad_lines       write a non-JSON line and a JSON non-message first, then reply
  big             one agent_message_chunk of 2 MiB, then end_turn
  exit            write "fatal: boom" to stderr, exit with code 3 in the middle of the turn
  version2        answer initialize with protocolVersion 2

Process scenarios (for acp_sessions), with $ACP_FAKE_PIDFILE naming a file
that gets "<own pid> <child pid>":
  child           start a grandchild that sleeps; exit on stdin EOF, leaving it
  stubborn        like child, but ignore stdin EOF and SIGTERM

The session id is "s-1"; session/load replays one user and one agent chunk.
Standard library only; it reads stdin line by line in one thread.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time

SCENARIO = sys.argv[1] if len(sys.argv) > 1 else "reply"
SESSION = "s-1"
_next_id = 1000


def send(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def update(kind: str, **fields) -> None:
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": SESSION, "update": {"sessionUpdate": kind, **fields}}})


def chunk(text: str, kind: str = "agent_message_chunk") -> None:
    update(kind, content={"type": "text", "text": text})


def answer(request_id, result) -> None:
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


def ask(method: str, params: dict) -> dict:
    """A request to the client; reads until its answer, returns the message."""
    global _next_id
    _next_id += 1
    send({"jsonrpc": "2.0", "id": _next_id, "method": method, "params": params})
    for line in sys.stdin:
        message = json.loads(line)
        if message.get("id") == _next_id and "method" not in message:
            return message
    sys.exit(0)


def prompt(request_id) -> None:
    if SCENARIO == "bad_lines":
        sys.stdout.write("this is not json\n")
        sys.stdout.write(json.dumps({"hello": "world"}) + "\n")
        sys.stdout.flush()
    if SCENARIO == "big":
        chunk("x" * (2 * 1024 * 1024))
        answer(request_id, {"stopReason": "end_turn"})
        return
    if SCENARIO == "permission":
        reply = ask("session/request_permission", {
            "sessionId": SESSION,
            "toolCall": {"toolCallId": "t-1", "title": "Write notes.md", "kind": "edit", "status": "pending"},
            "options": [
                {"optionId": "yes", "name": "Allow once", "kind": "allow_once"},
                {"optionId": "no", "name": "Reject", "kind": "reject_once"},
            ],
        })
        chunk(f"outcome={json.dumps(reply.get('result', {}).get('outcome'))}")
        answer(request_id, {"stopReason": "end_turn"})
        return
    if SCENARIO == "ask_navide":
        reply = ask("fs/read_text_file", {"sessionId": SESSION, "path": "/etc/hosts"})
        chunk(f"error={reply.get('error', {}).get('code')}")
        answer(request_id, {"stopReason": "end_turn"})
        return
    chunk("Hello")
    chunk(", world")
    if SCENARIO == "exit":
        sys.stderr.write("fatal: boom\n")
        sys.stderr.flush()
        sys.exit(3)
    if SCENARIO in ("cancel", "ignore_cancel"):
        for line in sys.stdin:
            message = json.loads(line)
            if message.get("method") == "session/cancel" and SCENARIO == "cancel":
                answer(request_id, {"stopReason": "cancelled"})
                return
        sys.exit(0)
    answer(request_id, {"stopReason": "end_turn"})


def start_child() -> None:
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
    with open(os.environ["ACP_FAKE_PIDFILE"], "w") as f:
        f.write(f"{os.getpid()} {child.pid}")


def main() -> None:
    if SCENARIO in ("child", "stubborn"):
        start_child()
        if SCENARIO == "stubborn" and hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
    for line in sys.stdin:
        message = json.loads(line)
        method, request_id = message.get("method"), message.get("id")
        params = message.get("params") or {}
        if method == "initialize":
            answer(request_id, {
                "protocolVersion": 2 if SCENARIO == "version2" else params.get("protocolVersion"),
                "agentCapabilities": {"loadSession": True, "sessionCapabilities": {"list": {}}},
                "agentInfo": {"name": "fake-acp", "version": "0.0.1"},
                "authMethods": [],
                "echoClientCapabilities": params.get("clientCapabilities"),
            })
        elif method == "session/new":
            answer(request_id, {"sessionId": SESSION})
        elif method == "session/load":
            chunk("earlier question", kind="user_message_chunk")
            chunk("earlier answer")
            answer(request_id, None)
        elif method == "session/list":
            answer(request_id, {"sessions": [{"sessionId": SESSION, "cwd": params.get("cwd") or "/"}]})
        elif method == "session/prompt":
            prompt(request_id)
        elif request_id is not None:
            send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "no such method"}})

    if SCENARIO == "stubborn":
        time.sleep(300)


if __name__ == "__main__":
    main()
