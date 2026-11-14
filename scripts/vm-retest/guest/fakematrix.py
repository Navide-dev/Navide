# fakematrix.py <port>: a minimal local Matrix homeserver for driving Navide's Matrix channel in the test VM.
# No real chat service is involved. One direct room (!dm:local, 2 members) with a test user @tester:local.
#   Client-Server API used by channels/matrix.py: GET account/whoami, GET sync (long-poll), POST rooms/{id}/join,
#   PUT rooms/{id}/send/m.room.message/{txn}, PUT rooms/{id}/typing/{user}, GET profile/{user}/displayname
#   Test control: POST /_test/say {"body": "...", "sender"?: "@tester:local"}  -> queued as an inbound m.room.message
#                 GET  /_test/out  -> every message the bot sent, with timestamps
import json, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote
PORT = int(sys.argv[1]); ROOM = "!dm:local"; BOT = "@navide-bot:local"; TESTER = "@tester:local"
lock = threading.Condition(); events = []; out = []; batch = [0]
def room_block(evs): return {"rooms": {"join": {ROOM: {"summary": {"m.joined_member_count": 2}, "timeline": {"events": evs}}}}}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body):
        d = json.dumps(body).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(d))); self.end_headers(); self.wfile.write(d)
    def _body(self):
        n = int(self.headers.get("Content-Length") or 0); return json.loads(self.rfile.read(n) or b"{}") if n else {}
    def do_GET(self):
        u = urlparse(self.path); p = unquote(u.path); q = parse_qs(u.query)
        if p == "/_test/out":
            with lock: return self._send(200, out)
        if p.endswith("/account/whoami"): return self._send(200, {"user_id": BOT})
        if "/profile/" in p and p.endswith("/displayname"): return self._send(200, {"displayname": "Tester"})
        if p.endswith("/sync"):
            since = (q.get("since") or [""])[0]; timeout = int((q.get("timeout") or ["0"])[0]) / 1000.0
            if not since:
                with lock: return self._send(200, {"next_batch": f"s{len(events)}", **room_block([])})
            start = int(since[1:]) if since[1:].isdigit() else 0; end = time.time() + timeout
            with lock:
                while len(events) <= start and time.time() < end: lock.wait(max(0.05, end - time.time()))
                new = events[start:]; return self._send(200, {"next_batch": f"s{len(events)}", **room_block(new)})
        return self._send(404, {"errcode": "M_UNRECOGNIZED", "error": p})
    def do_POST(self):
        p = unquote(urlparse(self.path).path); b = self._body()
        if p == "/_test/say":
            ev = {"type": "m.room.message", "event_id": "$" + uuid.uuid4().hex, "sender": b.get("sender") or TESTER,
                  "origin_server_ts": int(time.time() * 1000), "content": {"msgtype": "m.text", "body": b["body"]}}
            with lock: events.append(ev); lock.notify_all()
            return self._send(200, {"queued": ev["event_id"], "at": time.time()})
        if p.endswith("/join"): return self._send(200, {"room_id": ROOM})
        return self._send(404, {"errcode": "M_UNRECOGNIZED"})
    def do_PUT(self):
        p = unquote(urlparse(self.path).path); b = self._body()
        if "/send/" in p:
            eid = "$" + uuid.uuid4().hex
            with lock: out.append({"at": time.time(), "event_id": eid, "body": b.get("body"), "rel": b.get("m.relates_to")})
            return self._send(200, {"event_id": eid})
        if "/typing/" in p: return self._send(200, {})
        return self._send(404, {"errcode": "M_UNRECOGNIZED"})
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
