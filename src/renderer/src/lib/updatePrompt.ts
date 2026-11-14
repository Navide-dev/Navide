/**
 * updatePrompt.ts — keep Navide's own keystrokes out of a CLI's startup
 * update menu.
 *
 * Codex opens with "Update available" and "1. Update now" preselected, so the
 * Enter that follows a typed prompt (kickoff, a cli_send message) would run a
 * global install on the user's behalf and quit the CLI. Every path that is
 * about to type into a pane asks `clearUpdatePrompt` first:
 *
 *  - the exact menu (`pattern`) is skipped with the vendor's own one-time skip
 *    key (Esc), and the caller types its text afterwards;
 *  - anything that only looks like it (`suspect`) is left alone: the pane is
 *    held as awaiting and the caller stops — never an Enter;
 *  - a menu that is still there after the skip key is held the same way.
 *
 * Kept out of App.vue so the suite can drive it: same reason startupTrust.ts
 * lives here.
 */

import { AGENT_SPECS } from '@navide/plugin-shell'

export type UpdatePromptState = 'none' | 'known' | 'suspect'

function specFor(agentKey: string | undefined) {
  return agentKey ? AGENT_SPECS.find((s) => s.agentKey === agentKey)?.updatePrompt : undefined
}

/** What the visible screen shows of this vendor's update menu. */
export function updatePromptState(agentKey: string | undefined, screen: string): UpdatePromptState {
  const spec = specFor(agentKey)
  if (!spec) return 'none'
  const text = screen.replace(/\s+/g, ' ').trim()
  if (spec.pattern.test(text)) return 'known'
  return spec.suspect.test(text) ? 'suspect' : 'none'
}

/** True while either pattern matches: the pane is parked on the menu. */
export function screenShowsUpdatePrompt(agentKey: string | undefined, screen: string): boolean {
  return updatePromptState(agentKey, screen) !== 'none'
}

/** 'clear' = no menu, go on. 'skipped' = the menu was skipped and is gone;
 *  anything typed before that was dropped by the CLI, so type it again.
 *  'blocked' = the menu (or something like it) is still up: do not type and
 *  do not press Enter. */
export type UpdatePromptOutcome = 'clear' | 'skipped' | 'blocked'

const SKIP_ATTEMPTS = 2
const SKIP_WAIT_MS = 3_000
const POLL_MS = 250

export async function clearUpdatePrompt(deps: {
  agentKey: string | undefined
  readScreen: () => string
  send: (keys: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** One diagnostic line per decision, for ui_diagnostics. */
  record: (code: 'update-prompt.skipped' | 'update-prompt.blocked', message: string) => void
}): Promise<UpdatePromptOutcome> {
  const spec = specFor(deps.agentKey)
  if (!spec) return 'clear'
  let state = updatePromptState(deps.agentKey, deps.readScreen())
  if (state === 'none') return 'clear'
  for (let attempt = 1; state === 'known' && attempt <= SKIP_ATTEMPTS; attempt++) {
    await deps.send(spec.skipKeys)
    const deadline = deps.now() + SKIP_WAIT_MS
    while (deps.now() < deadline) {
      await deps.sleep(POLL_MS)
      state = updatePromptState(deps.agentKey, deps.readScreen())
      if (state === 'none') {
        deps.record('update-prompt.skipped', `${deps.agentKey} update menu skipped with its skip key (attempt ${attempt}); the text is typed again`)
        return 'skipped'
      }
    }
  }
  deps.record(
    'update-prompt.blocked',
    state === 'known'
      ? `${deps.agentKey} update menu still shown after ${SKIP_ATTEMPTS} skip keys; holding the pane, no Enter sent`
      : `${deps.agentKey} screen looks like an update menu Navide does not recognize; holding the pane, no key sent`,
  )
  return 'blocked'
}
