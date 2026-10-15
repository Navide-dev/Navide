# Release Announcements and Guided Tours

Every Navide release can announce itself inside the app. The announcement is
data — one entry per version in
[`src/renderer/src/lib/whatsNew.ts`](../../src/renderer/src/lib/whatsNew.ts) —
and an entry may carry a **guided tour**: a few steps that dim the window and
point at the UI the release added. There is no separate tour registry; a
version's highlights and its tour live in the same entry.

## Where an announcement appears

All three surfaces read the same entry and behave the same way:

| Surface | When |
|---|---|
| Post-update popup (`WhatsNewModal`) | Once, on the first launch of a version newer than the last one seen (`agentTeam.whatsNew.lastSeenVersion`). A fresh install is only baselined, never shown it. |
| **Help → What's New…** | On request. It shows the newest entry at or below the running version, and closing it records nothing. A dev build shows the newest entry authored, so you can try the next release's announcement before `package.json` is bumped. |
| Announcement centre (📢 in the status bar) | Always lists every shipped entry. A release row whose entry has a tour shows **Take the tour**. |

When the entry has a tour, the popup asks **Take the tour / Not now** instead of
**Got it**. Every surface starts the tour through
`composables/useReleaseTour.ts`. It records `agentTeam.tour.v<version>.done`
only when the tour is taken to its last step, and the popup then offers
**Replay the tour**.

## Adding a release's announcement

1. **Prepend** an entry to `WHATS_NEW` (newest first). Do not retitle the entry
   on top — that entry belongs to an older release. A test fails if versions
   skip a patch number or repeat one.
2. Fill `title` and `highlights`. Each text is `{ 'zh-TW', 'en-US', 'ja-JP' }`,
   and `ja-JP` may be omitted (it falls back to zh-TW). Give it for anything a
   Japanese user will read.
3. For a release worth stopping for, set `major: true`, and choose one of two
   ways to feature it:
   - `spotlight`: one product panel.
   - `features`: two or more side-by-side cards, each with `icon`, `name`,
     `tagline` and `where`.
4. Optionally add a `tour` (next section).
5. Run the tests below.

`release.sh` prints a **WARNING** (not a failure) when the version being
released has no entry, so skipping an announcement is always a decision.

## Adding a tour

`tour` is an array of steps (`TourStep` in
[`lib/tours.ts`](../../src/renderer/src/lib/tours.ts)):

| Field | Meaning |
|---|---|
| `id` | Unique within the tour |
| `prepare` | Optional. `{ kind: 'settings', tab }` opens Settings at a tab; `{ kind: 'close-settings' }` closes it. Runs before the step looks for its anchor. To open a tab not yet listed, add it to `TourPrepare` and to App.vue's `settingsInitialTab` union. |
| `anchor` | Optional CSS selector for the element to spotlight. Prefer stable hooks (`data-settings-section`, `data-testid`) over styling classes. Leave it out for a centred card. |
| `titleKey`, `bodyKey` | i18n keys for the step text |
| `missingKey` | Required when `anchor` is set: shown when the anchor is not on screen (no pane open, feature hidden), saying where the thing is instead |

Step text lives in the locale files
(`packages/plugin-ui/src/foundation/i18n/locales/{en-US,zh-TW,ja-JP}.json`)
under the version's own namespace: `tour.v<major>_<minor>_<patch>`, for example
`tour.v0_2_10`. The shared buttons (`tour.next`, `tour.back`, `tour.skip`,
`tour.done`, `tour.progress`) already exist.

A tour only points. It must not change a setting, and a step whose anchor is
missing still shows (as a centred card), so the tour always reaches its end.

## Worked example: 0.2.10

0.2.10 introduced Channels and Voice Input. Its entry is `major` with two
`features` cards and a six-step tour:

| Step | `prepare` | `anchor` |
|---|---|---|
| `welcome` | close Settings | — (centred) |
| `channels-settings` | Settings → `channels` | `[data-settings-section="channels"]` |
| `channels-pane` | close Settings | `[data-testid="channel-connect"], [data-testid="channel-chip"]` |
| `voice-settings` | Settings → `voice` | `[data-settings-section="voice"]` |
| `voice-dictate` | close Settings | `.xterm-host[data-pane-id]` |
| `done` | — | — (centred) |

Its text is under `tour.v0_2_10.*` in all three locale files.

## What the tests enforce

Run `pnpm exec vitest run src/renderer/src/lib/__tests__ src/renderer/src/components/__tests__/WhatsNewModal.test.ts packages/plugin-ui/src/foundation/i18n/__tests__/locales.test.ts`.
They fail when any of these is broken:

- Versions have no gaps and no duplicates (`whatsNew.test.ts`).
- Every tour step's keys exist and are non-empty in en-US, zh-TW and ja-JP, and
  sit under that version's namespace.
- Anchors are valid selectors, and every anchored step has a `missingKey`.
- Step ids are unique within a tour.
- No `tour.v<x_y_z>` locale namespace is left behind without an entry whose
  tour uses it.
- Locale key sets stay in parity (`locales.test.ts`).
