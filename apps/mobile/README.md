# Navide Mobile

The Navide companion app for iOS and Android (Expo / React Native, one code
base). It lets you see your desktop panes while you are away from the
computer.

This first step covers:

- **Pairing** — scan the code shown in the desktop app under
  Account → Mobile App, compare six digits, and trust the phone on the
  desktop. The desktop owner can remove a phone at any time.
- **Pane overview** — every pane on your paired computers, grouped by
  workspace: name, CLI, and whether it is working, idle, or waiting for you.
- **In-app notifications** — while the app is open: a pane finished, needs
  your approval, or has a question.

Dispatching work, answering prompts and reading output come later.

## What the phone can see

Only five fields per pane: name, CLI kind, status, waiting type and the
workspace folder name. Never pane output, full paths, CLI account
credentials or API keys. The phone's own signing key is created on the
device and stays in the platform keychain/keystore.

## Layout

This app is a standalone package. It is **not** part of the root
workspace: it has its own `package.json`, lockfile and `.npmrc`, and the
desktop's typecheck, tests, packaging and lockfile checks do not include
`apps/`.

```
src/
  App.tsx, useNavide.ts   app shell and state
  connection/             Transport interface, server transport, mock
  identity/               device keys and stored credential (SecureStore)
  features/pairing/       QR offer parsing, six-digit code, pairing screen
  features/panes/         pane overview
  features/notifications/ roster diffing and in-app notifications
  features/settings/      paired computers, unpair
  i18n/                   app strings; generated/ holds desktop status labels
scripts/sync-locales.mjs  copies pane status labels from the desktop catalogs
docs/protocol.md          what the app sends and expects over the connection
```

## Development

Run everything from `apps/mobile`:

```bash
pnpm install
pnpm start          # Expo dev server, mock transport (no network)
pnpm typecheck
pnpm test           # node:test unit tests
pnpm sync:locales   # after desktop pane status strings change
```

### Demo mode

The default transport is a mock with fictional panes and no network; the
real server is used only when both `EXPO_PUBLIC_NAVIDE_TRANSPORT=server` and
`EXPO_PUBLIC_NAVIDE_SERVER_URL` are set.

1. `pnpm install` once, then `pnpm start`.
2. Open the app in Expo Go or a simulator (press `i` or `a` in the Expo
   terminal, or scan its QR code with a phone).
3. On the pairing screen choose **Use demo computer**. After about four
   seconds the demo computer "trusts" the phone and the pane overview opens.
4. Pane states rotate every six seconds, which produces in-app
   notifications.

The mock also exercises the error screens: a pairing offer whose code is
`rate-limited`, `expired` or `rejected` fails the matching way (see
`src/connection/mockTransport.ts`).

## Manual test checklist

### Phone (demo mode)

- [ ] First launch shows "Pair with your computer"; "Scan pairing code" asks
      for camera access, and declining it leaves a way back.
- [ ] Scanning any non-Navide QR code says "This is not a Navide pairing code".
- [ ] "Use demo computer" shows six digits as `123 456`, then opens the
      overview by itself.
- [ ] The overview groups panes by workspace; a pane waiting for you has a
      coloured border, says "Needs your approval" or "Has a question for you",
      and is listed first in its workspace.
- [ ] Within a minute a banner appears for "finished", "needs your approval"
      and "has a question"; tapping it opens Notifications. The tab shows a
      count.
- [ ] Settings lists "Studio Mac". "Simulate removal" returns to the pairing
      screen with the removal notice; reopening the app stays unpaired.
- [ ] "Unpair this phone" also returns to pairing, and the next launch stays
      unpaired.
- [ ] Light and dark mode are both readable; system language zh-TW shows
      Traditional Chinese, anything else unsupported falls back to English.

### Desktop (Account → Mobile App)

- [ ] Signed out: the section is not shown. Signed in with no server
      configured: it says no server is set up.
- [ ] "Add Phone" shows a QR code with a countdown from 5:00; it expires at
      0:00 and "New Code" makes a fresh one.
- [ ] The section explains what the phone can see, and nothing on the page
      says "restrict" or "limit".
- [ ] Trust, Decline and Remove each go through and update the list; with
      the server unreachable each shows an error instead of silently doing
      nothing.

End-to-end pairing with a real phone needs the server side, which is not
available yet.

Push notifications are not part of this step; `Transport.registerPushToken`
marks where they will plug in.

Native builds (`expo prebuild`, `expo run:*`) and EAS cloud builds are not
part of the regular workflow yet; ask before running them.
