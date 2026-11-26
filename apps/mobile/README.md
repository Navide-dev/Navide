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

The default transport is a mock with fictional panes; "Use demo computer"
on the pairing screen pairs with it, and Settings has a "Simulate removal"
button. The real server is used only when both
`EXPO_PUBLIC_NAVIDE_TRANSPORT=server` and `EXPO_PUBLIC_NAVIDE_SERVER_URL`
are set.

Push notifications are not part of this step; `Transport.registerPushToken`
marks where they will plug in.

Native builds (`expo prebuild`, `expo run:*`) and EAS cloud builds are not
part of the regular workflow yet; ask before running them.
