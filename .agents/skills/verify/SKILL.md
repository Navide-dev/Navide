---
name: verify
description: How to drive this repo's runtime surfaces for verification — isolated backend over WebSocket; UI is user-tested manually.
---

# Verifying changes in Agent-Team

## Backend (FastAPI + WebSocket)

Launch an isolated instance (never reuse the running app's backend — the port
discovery file would collide):

```bash
AGENT_TEAM_DATA_DIR=<scratch>/data \
  uv --project backend run python -m agent_team_backend --port 8931 --log-level warning
```

- WS endpoint: `ws://127.0.0.1:8931/ws?t=<token>` — **the token is required**.
  Read it from `<scratch>/data/backend-ws-token` (0600, minted fresh on every
  backend start). Connecting without it closes with code 4403 rather than
  answering, which is the point: that socket dispatches `terminal.create` with
  a caller-supplied command, and a WebSocket handshake is not subject to the
  same-origin policy, so any web page could otherwise reach it. See
  `backend/agent_team_backend/ws_auth.py`.
- Request frame: `{"id": uuid, "type": "<msg_type>", "payload": {...}, "timestamp": iso}`
- Response frame: `{"id", "type", "ok", "payload"}`; events have no matching `id` — filter by id.
- Client: `websockets` is already in the backend venv
  (`uv --project backend run python <script>`).
- Message types dispatch in `backend/agent_team_backend/app.py` `handle_message`
  (grep `elif msg_type ==` — the file is ~2.7K lines, use offset/limit reads).
- Side effect (observed 2026-07-13): startup runs `claude_hooks.install_hooks`,
  which rewrites the agent-team hook's port_file path in the user's REAL
  `~/.Codex/settings.json` — even with `AGENT_TEAM_DATA_DIR` isolation. A
  running app instance rewrites it back on its own, but if no app is running,
  check/restore that path after killing the isolated backend.

To prove event-loop non-blocking: fire concurrent heavy requests
(`fs.list_files_flat` with a no-match query walks the whole tree) against a
synthetic 50K-file tree in scratch, then time a light request mid-flight —
it must return in ms, not after the walks.

## Frontend / Electron UI

Never drive the UI (no cliclick/screencapture/AppleScript — repo rule).
Verify renderer logic at the unit level (`bun run test:run <files>` — never
bare `bun test`, which runs Bun's own runner instead of Vitest), then hand the
user concrete manual steps: which pane to open, what to click, what they should see.
