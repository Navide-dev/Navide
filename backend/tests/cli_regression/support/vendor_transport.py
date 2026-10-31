"""Synthetic vendor peer: real process, PTY, HTTP and input-file boundaries.

This fixture models the declared transport contract, not a vendor release. It
records only fixture arguments and transport credentials minted by the isolated
backend, never inherited account material. Navide owns all spawn wiring.
"""
from __future__ import annotations

import base64
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import signal
import socketserver
import sys
import time


def _raw_console_input() -> None:
    """Clear the console's processed/line/echo input flags for the REPL loop.

    ConPTY translates a raw `\x03` into CTRL_C_EVENT while the console is in
    processed-input mode, and the CI job starts pytest with
    CREATE_NEW_PROCESS_GROUP, which disables Ctrl+C for every descendant. The
    fake would then neither get a signal nor see the byte in `getwch()`. Real
    Node CLIs put the console in raw mode; clearing these flags makes
    `msvcrt.getwch()` return the raw `\x03`.
    """
    import ctypes

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE
    mode = ctypes.c_uint32()
    if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
        # ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT
        kernel32.SetConsoleMode(handle, mode.value & ~0x0007)


class _Server(HTTPServer):
    def server_bind(self) -> None:
        # HTTPServer.server_bind looks up the host name, which can outlast the
        # harness's wait for TRANSPORT_READY on macos-15 runners.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def main() -> None:
    vendor, root_text, *args = sys.argv[1:]
    if "--version" in args:
        print(f"{vendor} 99.0.0-regression")
        return
    root = Path(root_text)
    audit = root / f"{vendor}.jsonl"

    def record(kind: str, **values) -> None:
        with audit.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"kind": kind, **values}) + "\n")

    record("spawn", argv=args, password=bool(os.environ.get("KILO_SERVER_PASSWORD")),
           opencode_password=bool(os.environ.get("OPENCODE_SERVER_PASSWORD")))

    def option(name: str) -> str:
        return args[args.index(name) + 1]

    if "--port" in args:
        password = os.environ.get("KILO_SERVER_PASSWORD", "")
        auth = "Basic " + base64.b64encode(f"kilo:{password}".encode()).decode()
        composer = ""

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                nonlocal composer
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                payload = json.loads(body) if body else None
                supplied = self.headers.get("Authorization")
                authorized = supplied == auth if vendor == "kilo" else supplied is None
                status = 200 if authorized else 401
                if status == 200 and self.path.endswith("submit-prompt") and (root / "reject-submit").exists():
                    status = 500
                submitted = ""
                if status == 200:
                    if self.path.endswith("append-prompt"):
                        composer += payload["text"]
                    elif self.path.endswith("submit-prompt"):
                        submitted, composer = composer, ""
                    elif self.path.endswith("clear-prompt"):
                        composer = ""
                record("http", path=self.path, body=payload, composer=composer,
                       submitted=submitted, authorized=authorized,
                       has_auth=supplied is not None, status=status)
                self.send_response(status)
                self.send_header("Content-Length", "4")
                self.end_headers()
                self.wfile.write(b"true")

            def log_message(self, *_args):
                pass

        server = _Server((option("--hostname"), int(option("--port"))), Handler)
        print("TRANSPORT_READY", flush=True)
        server.serve_forever()
    elif "--input-file" in args:
        path = Path(option("--input-file"))
        record("watch", empty=path.stat().st_size == 0)
        with path.open(encoding="utf-8") as stream:
            stream.seek(0, 2)  # Qwen ignores content already present at startup.
            print("TRANSPORT_READY", flush=True)
            while True:
                line = stream.readline()
                if line:
                    record("file", value=json.loads(line))
                else:
                    time.sleep(0.01)
    else:
        def interrupted(_signum, _frame):
            record("interrupt", value=3)
            print("INTERRUPT_3", flush=True)

        signal.signal(signal.SIGINT, interrupted)
        if os.name == "nt":
            _raw_console_input()
        else:
            import tty
            tty.setraw(sys.stdin.fileno())
        print("TRANSPORT_READY", flush=True)
        while True:
            if os.name == "nt":
                import msvcrt
                if not msvcrt.kbhit():
                    time.sleep(0.01)
                    continue
                value = msvcrt.getwch()
            else:
                value = sys.stdin.read(1)
            if not value:
                return
            record("interrupt", value=ord(value))
            print(f"INTERRUPT_{ord(value)}", flush=True)


if __name__ == "__main__":
    main()
