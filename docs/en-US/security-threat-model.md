# Security threat model

This is the model every security review of Navide is checked against. A
finding that does not map to one of the four attacker positions below is a
quality issue, not a security one, and is filed as such. Change this file
whenever a trust boundary moves (a new socket, a new token, a new place
untrusted content is rendered); the pull request that moves the boundary
carries the update.

Framework: the Threat Modeling Manifesto's four questions (what are we
building, what can go wrong, what do we do about it, did we do enough) with
STRIDE as the checklist for "what can go wrong".

## What we are building (data flow, in words)

```
 ┌──────────────────────────── one machine, one OS user ──────────────────────────────┐
 │  Electron main ──IPC──▶ renderer windows (main, Editor, Plan, Git)                  │
 │      │                    │ plugin <webview> guests (untrusted plugin UI)           │
 │      │                    │ preview iframes (untrusted HTML, sandbox="")            │
 │      ▼ spawn + ws token   ▼ ws (127.0.0.1, token in 0600 file)                      │
 │  Python backend ◀──ws──── MCP server (per-pane URL: ?pane=&t=, one token per run)   │
 │      │  PTYs for CLI agents      ▲ plugin broker (same socket)                      │
 │      │  hooks: CLI → HTTP /hooks (0600 header file)                                 │
 │      ▼                                                                             │
 │  server_link ──wss──▶ Navide Cloud relay ──▶ peer devices (signed, sealed, SAS-pinned)
 └────────────────────────────────────────────────────────────────────────────────────┘
```

Secrets and where they live: trust store, server token and workspace salt in
the Keychain; the confirm-token key and the host token handed to the backend
over stdin (never the spawn environment, which `ps -E` shows); the ws
token and the hook secret in 0600 files under the app data dir; the pane MCP
token in each pane's command line (known exposure, see L1 in the audit
reports).

Portable CLI credentials (a pasted value Navide injected into a pane's
environment) were removed in 0.2.32. A one-time cleanup
(`portable_credentials_cleanup.py`) erases what a device that used them still
held — the `navide-portable-credential-key` app secret, the
`portable_credentials` kv document and the imported `sync_credential_items`
rows — and makes no vault call on a device that never did. `credentials`
stays in the sync protocol's scope list only so a switch an older build left
on reads as off; there is no adapter for it.

## Attacker positions (who can go wrong)

| # | Position | What they can reach | What must hold |
|---|---|---|---|
| 1 | **A controlled relay or a remote peer** — the Navide Cloud server, or a device on the same account, is hostile. | Every frame that crosses `server_link`; the directory of devices and keys; pairing frames; every synced record, `credentials` included. | The relay is a dumb pipe: it never gains trust. Pins are made by two people comparing a SAS that covers both the signing and the X25519 encryption key; messages are signed by the sender's pinned key and sealed to the recipient; policy documents are signed and sequence-numbered; a paired device gets `RING_SELF`, an unpaired one gets the policy, an unknown one gets nothing. Synced records are ciphertext under the account key the relay never holds; a credential's item id is random, so the rows reveal neither vendor nor account count. |
| 2 | **Another local OS account** on the same machine. | `127.0.0.1` ports; world-readable files (`~/.claude/settings.json` is 0644); `ps` output. | Nothing that authenticates may sit in a world-readable place or in argv. HTTP routes on the backend require the ws token or a per-workspace capability; hook endpoints require the 0600 header file. |
| 3 | **A same-user process holding a token** — the MCP server driving a CLI agent (which may be taking instructions from position 1 or from repository content), or the plugin broker. Has the ws socket or a pane credential. | Every ws handler; every MCP tool; every `ui.*` renderer command. | Trust-changing actions need a confirmation only a window can mint (`confirm_token`, bound to action, device and subject). Pane-private data (an inbox) is served only to the pane it belongs to. Argument shapes that reach a command line are refused, not sanitised. Nothing reachable from here changes what a remote party may do. |
| 4 | **Untrusted content inside a window** — a preview iframe, a plugin webview, a rendered message. | The renderer's DOM and whatever the preload exposes; IPC if the frame can reach `ipcRenderer`. | `contextIsolation` on, `nodeIntegration` off; sensitive IPC handlers accept only the top frame of a real BrowserWindow (`isAppWindowSender`); previews load through capability URLs the frame cannot forge; webview preferences are pinned in `will-attach-webview`. |

Explicitly **not** in the model: a process running as this user that reads
the app's memory or attaches a debugger. No secret the app holds is out of
its reach, and the audits say so wherever a control stops there.

## STRIDE, per boundary

| Boundary | Spoofing | Tampering | Repudiation | Info disclosure | Denial of service | Elevation |
|---|---|---|---|---|---|---|
| Relay ↔ device | pinned sign key, SAS at pairing | signature over frame incl. from/to device | message log with sender identity | sealed box to recipient key | policy caps, replay window (`seenMessages`) | ring from pin, never from a member id the relay states |
| Backend ws | ws token (0600) | confirm token for trust writes | backend.log | fs routes need token / capability | idle reclaim, terminal caps | `_confirmed` on the nine trust actions |
| MCP / pane | pane credential (one token per run — known gap L1) | argument-shape refusal | message log `origin` | inbox bound to caller's pane | wait caps (120 s), list caps | no trust-changing ws type reachable (test-pinned) |
| Renderer IPC | `isAppWindowSender` on sensitive handlers | preload exposes narrow functions | — | previews via capability URL | — | webview prefs pinned |
| Hooks HTTP | 0600 header file read at fire time | vendor allowlist | — | empty 403 body | — | — |

## What we do about it (where the controls are)

- `backend/agent_team_backend/confirm_token.py`, `ws_auth.py`, `hook_auth.py`,
  `trust_store.py`, `device_pairing.py`, `device_signing.py`,
  `device_crypto.py`, `pane_policy.py`, `model_args.py`
- `src/main/ipcSender.ts`, `src/main/plugins/pluginGuestAttach.ts`
- `src/renderer/src/composables/useUiActionBus.ts` (`PANE_PRIVATE_ACTIONS`)
- Navide-Server: `preauth.ts` (two lanes), `throttle.ts` (no IP keys),
  `tokens.ts`, `mailer.ts`

## Did we do enough (how it is checked)

Every control above has a test that goes red when the control is removed;
the audits run that mutation and record the count. The audit reports live in
`.agent-team/plans/` (`security-scan-*`, `security-rescan-*`,
`navide-security-program_*`), and each lists what was **not** verified.
