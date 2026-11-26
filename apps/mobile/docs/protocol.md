# Mobile client protocol (v1)

What the phone sends and expects. JSON text frames over one WebSocket.

## Pairing

1. The desktop shows a QR code:
   `navide://pair?v=1&d=<desktopId>&k=<desktopKey>&n=<desktopNonce>&c=<code>`
   `desktopKey` is the desktop's Ed25519 public key (base64url). The code is
   single use and expires within minutes. The QR carries no credential.
2. The phone sends
   `{type:"mobile.pair.redeem", code, desktopId, phoneKey, phoneNonce, deviceName}`.
   Replies: `{type:"mobile.pair.pending"}`, or
   `{type:"error", code:"rate_limited"|"invalid_code"|"expired"}`.
3. Both screens show six digits:
   `sha256("navide/mobile-pair/v1" ‖ desktopKey ‖ phoneKey ‖ desktopNonce ‖ phoneNonce)`,
   first four bytes as a big-endian integer, mod 1,000,000. The desktop key
   comes from the camera, so a relay that substitutes the phone key makes the
   digits differ.
4. The user presses Trust on the desktop. The phone receives
   `{type:"mobile.pair.approved", phoneId, token, deviceName, signature}`, where
   `signature` is the desktop's Ed25519 signature over
   `"navide/mobile-approval/v1\n<desktopId>\n<phoneKey>\n<phoneNonce>"`.
   The phone verifies it with the key from the QR before storing anything.
   A declined request arrives as `{type:"mobile.pair.rejected"}`.

## Session

- `{type:"mobile.hello", phoneId, token}` → `{type:"mobile.ready"}`
- `{type:"mobile.roster", desktops:[{deviceId, deviceName, panes:[PaneSummary]}]}`
  — a full snapshot on every change. `PaneSummary` is exactly
  `{name, agentKey, status, awaitingKind, workspace}`; the app ignores any
  other field.
- `{type:"ping"}` every 20 s. A connection with no frame for 50 s is treated
  as dead. Reconnects back off from 1 s to 30 s with jitter, and reconnect
  immediately when the app returns to the foreground.
- Removal on the desktop: `{type:"mobile.revoked"}` or close code 4401. The
  app deletes its stored credential and returns to the pairing screen.

## Not in v1

Push notifications (`registerPushToken` is a placeholder), dispatching
work, answering prompts, and pane output.
