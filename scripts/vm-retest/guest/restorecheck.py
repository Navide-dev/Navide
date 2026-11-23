# restorecheck.py <root> [label]: after a cold start, what the restore had to work with and what it said about it.
#   Run once before the quit (label "before") and once after each cold start ("cold-1", ...), with the app up.
#   - the project row of <root>/wm/.agent-team/navide.db (kv key "project"), read-only: every pane record's
#     pane_id, name, agent, origin, spawn_status, whether it has a session id, and removed_at;
#   - the restore.* warnings in the app's logs/errors.jsonl (lib/restoreDiagnostics.ts), which outlive the restart;
#   - ui_diagnostics of the workspace window (the renderer ring buffer, this launch only).
# Pass = the workspace has a project row and at least one spawned record, and no restore.* warning was logged.
# Writes restore-<label>.json beside the root's other evidence. Names, ids and codes only: no tokens, no messages
# from the pane.
import json, os, sqlite3, sys
ROOTP = sys.argv[1]; LABEL = sys.argv[2] if len(sys.argv) > 2 else "cold"
sys.argv = [sys.argv[0], ROOTP, "wm", "state"]
exec(open(ROOTP + "/lineage.py", encoding="utf-8").read().split('if phase == "setup":')[0])
PHASE = "restorecheck"
def project_row():
    db = os.path.join(ws, ".agent-team", "navide.db")
    if not os.path.exists(db): return None, "no navide.db"
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        row = con.execute("SELECT value, updated_at FROM kv WHERE key = 'project'").fetchone()
    finally:
        con.close()
    if row is None: return None, "no project row"
    doc = json.loads(row[0])
    panes = [{k: p.get(k) for k in ("pane_id", "custom_name", "agent", "origin", "spawn_status", "removed_at")}
             | {"has_session_id": bool(p.get("session_id"))} for p in doc.get("panes") or []]
    return {"updated_at": row[1], "panes": panes}, ""
def restore_warnings():
    path = data_dir() / "logs" / "errors.jsonl"
    if not path.exists(): return []
    out = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try: e = json.loads(line)
        except ValueError: continue
        if str(e.get("code", "")).startswith("restore."): out.append({k: e.get(k) for k in ("ts", "code", "message")})
    return out
proj, why = project_row(); warns = restore_warnings()
try: diags = external(B(), "ui_diagnostics", {"workspace_path": ws, "limit": 200})
except Exception as err: diags = {"error": type(err).__name__}
(ROOT / f"restore-{LABEL}.json").write_text(json.dumps({"project": proj, "why": why, "restore_warnings": warns,
                                                         "ui_diagnostics": diags}, ensure_ascii=False, indent=1))
spawned = [p for p in (proj or {}).get("panes", []) if p["spawn_status"] == "spawned"]
rec(f"{LABEL}: project row", proj is not None, why or f"{len(proj['panes'])} record(s), {len(spawned)} spawned: "
    + json.dumps([(p["custom_name"], p["origin"], p["spawn_status"]) for p in proj["panes"]], ensure_ascii=False))
rec(f"{LABEL}: no restore.* warning", not warns, json.dumps(warns, ensure_ascii=False)[:300])
print("restorecheck fails", fails, flush=True); sys.exit(1 if fails else 0)
