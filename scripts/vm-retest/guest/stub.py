# Local stand-in for the Messages API. Logs the whole request, asks for one Bash call, then says done.
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
PORT, CMD, LOG = int(sys.argv[1]), sys.argv[2], sys.argv[3]
def sse(w, name, data):
    w.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode()); w.flush()
def branch(msgs):
    t = json.dumps(msgs, ensure_ascii=False)
    if "[分支回報]" not in t: return ""
    m = __import__("re").findall(r"訊號代碼是 ([0-9a-f]+)", t)
    return f"\n\n---BRANCH:{m[-1]}: true---" if m else ""
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header("content-type","application/json"); self.end_headers(); self.wfile.write(b"{}")
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        if "count_tokens" in self.path:
            self.send_response(200); self.send_header("content-type","application/json"); self.end_headers(); self.wfile.write(b'{"input_tokens":10}'); return
        msgs = body.get("messages", [])
        has_tools = any(t.get("name") == "Bash" for t in body.get("tools", []))
        os_ = __import__("os"); force = os_.path.exists(LOG + ".force") and has_tools
        if force: os_.remove(LOG + ".force")
        done = "tool_result" in json.dumps(msgs) and not force
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"at": __import__("time").time(), "tools": has_tools, "done": done, "n": len(msgs), "messages": msgs}, ensure_ascii=False) + "\n")
        tool = has_tools and not done and not __import__("os").path.exists(LOG + ".notool")
        rule_text = None; bg = None
        # rule "bg": answer with a Bash call that runs in the background; when it finishes Claude starts a turn of its own
        # stub.log.tailsleep (seconds): the next request that carries a tool result waits that long (one shot)
        if has_tools and done and os_.path.exists(LOG + ".tailsleep"):
            sl = int(open(LOG + ".tailsleep").read() or 0); os_.remove(LOG + ".tailsleep"); __import__("time").sleep(sl)
        if has_tools and msgs and os_.path.exists(LOG + ".rules.json"):
            lu = next((m for m in reversed(msgs) if m.get("role") == "user"), msgs[-1]); lc = lu.get("content")
            last = json.dumps([b for b in lc if isinstance(b, dict) and b.get("type") == "text"] if isinstance(lc, list) else lu, ensure_ascii=False)
            if "tool_result" not in last:
                for r in json.load(open(LOG + ".rules.json", encoding="utf-8")):
                    if r["match"] in last:
                        __import__("time").sleep(r.get("sleep", 0)); rule_text = r["text"]; bg = r.get("bg"); break
        # Manager-mode pipeline (kickoffs carry ROLEMGR / ROLEWK): the Manager prints
        # MANAGER-READY and then parks on a Bash permission box; the worker reports late.
        t_all = json.dumps(msgs, ensure_ascii=False); role = "MGR" if "ROLEMGR" in t_all else "WK" if "ROLEWK" in t_all else ""
        pre = ""
        if has_tools and not role and "# Role:" in t_all: tool = False  # role-prompt turn of a Manager-mode slot ends at once
        # stub.log.wkrole: wk's role turn (role "frontend") parks on a permission box, so wk's kickoff is refused and the run fails
        if has_tools and not role and "Frontend" in t_all and os_.path.exists(LOG + ".wkrole") and "tool_result" not in t_all: tool = True
        if has_tools and role == "MGR":
            pre = "---MANAGER-READY---\n" if tool else ("---STAGE-DONE---\n" if "worker report Y" in t_all else "---MANAGER-READY---\n")
        ask = os_.path.exists(LOG + ".ask")  # ASK -> DISPATCH round: wk asks, mgr dispatches, wk then reports
        nonce = (__import__("re").findall(r"Y[0-9a-f]{12}", t_all) or ["?"])[-1]
        if has_tools and role == "MGR" and ask and not tool and "worker ask " + nonce in t_all and "worker report Y" not in t_all:
            pre = "---DISPATCH-START---\nto: wk\nmessage: manager dispatch " + nonce + "\n---DISPATCH-END---\n"
        # stub.log.dup: the Manager answers wk's FIRST report with one more dispatch, so wk sends the same REPORT text in a second turn
        if has_tools and role == "MGR" and not tool and os_.path.exists(LOG + ".dup"):
            k = sum(1 for m in msgs if m.get("role") == "user" and ("worker report " + nonce) in json.dumps(m, ensure_ascii=False))
            if k == 1: pre = "---DISPATCH-START---\nto: wk\nmessage: manager dispatch again " + nonce + "\n---DISPATCH-END---\n"
        # stub.log.mgrslow: the Manager's turn after a report takes 20 s more (keeps the stage open while wk's pane repaints)
        if has_tools and role == "MGR" and not tool and os_.path.exists(LOG + ".mgrslow") and ("worker report " + nonce) in t_all: __import__("time").sleep(20)
        if has_tools and role == "WK":
            tool = False
            if ask and "manager dispatch " + nonce not in t_all:
                __import__("time").sleep(10); pre = "---ASK-START---\ncontent: worker ask " + nonce + "\n---ASK-END---\n"
            else:
                __import__("time").sleep(15 if not ask else 3); pre = "---REPORT-START---\nworker report " + nonce + "\n---REPORT-END---\n"
        wk_fast = has_tools and not role and "Frontend" in t_all and os_.path.exists(LOG + ".wkfast")  # wk parks at once, mgr still in its 6 s role turn
        if has_tools and not wk_fast and not __import__("os").path.exists(LOG + ".instant"): __import__("time").sleep(6)  # touch <log>.instant for the 0 s turn that reproduces the watcher-arm race
        self.send_response(200); self.send_header("content-type","text/event-stream"); self.end_headers()
        w = self.wfile; model = body.get("model", "m")
        if rule_text is not None: tool = False; pre = ""
        if bg:
            sse(w,"message_start",{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":model,"stop_reason":None,"stop_sequence":None,"usage":{"input_tokens":1,"output_tokens":1}}})
            sse(w,"content_block_start",{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_"+__import__("secrets").token_hex(6),"name":"Bash","input":{}}})
            sse(w,"content_block_delta",{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":json.dumps({"command":bg,"description":"t","run_in_background":True})}})
            sse(w,"content_block_stop",{"type":"content_block_stop","index":0})
            sse(w,"message_delta",{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":None},"usage":{"output_tokens":1}})
            sse(w,"message_stop",{"type":"message_stop"}); return
        sse(w,"message_start",{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":model,"stop_reason":None,"stop_sequence":None,"usage":{"input_tokens":1,"output_tokens":1}}})
        if pre and tool:
            sse(w,"content_block_start",{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})
            sse(w,"content_block_delta",{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":pre}})
            sse(w,"content_block_stop",{"type":"content_block_stop","index":0})
            sse(w,"content_block_start",{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_"+__import__("secrets").token_hex(6),"name":"Bash","input":{}}})
            sse(w,"content_block_delta",{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":json.dumps({"command":CMD,"description":"t"})}})
            sse(w,"content_block_stop",{"type":"content_block_stop","index":1})
            sse(w,"message_delta",{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":None},"usage":{"output_tokens":1}})
            sse(w,"message_stop",{"type":"message_stop"}); return
        if pre:
            sse(w,"content_block_start",{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})
            sse(w,"content_block_delta",{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":pre + "finished"}})
            sse(w,"content_block_stop",{"type":"content_block_stop","index":0})
            sse(w,"message_delta",{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":None},"usage":{"output_tokens":1}})
            sse(w,"message_stop",{"type":"message_stop"}); return
        if tool:
            sse(w,"content_block_start",{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_"+__import__("secrets").token_hex(6),"name":"Bash","input":{}}})
            sse(w,"content_block_delta",{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":json.dumps({"command":CMD,"description":"t"})}})
        else:
            sse(w,"content_block_start",{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})
            sse(w,"content_block_delta",{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":rule_text if rule_text is not None else "finished" + branch(msgs)}})
        sse(w,"content_block_stop",{"type":"content_block_stop","index":0})
        sse(w,"message_delta",{"type":"message_delta","delta":{"stop_reason":"tool_use" if tool else "end_turn","stop_sequence":None},"usage":{"output_tokens":1}})
        sse(w,"message_stop",{"type":"message_stop"})
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
