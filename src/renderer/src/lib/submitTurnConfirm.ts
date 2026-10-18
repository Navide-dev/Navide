/**
 * submitTurnConfirm.ts
 *
 * The second look injectText (App.vue) takes after Enter when the only
 * evidence it has is 'growth' — the terminal reacted, nothing more. A focused
 * TUI repaints on its own, so growth alone has reported a collapsed paste
 * delivered while it still sat unsent in the box. What does mean the CLI took
 * the message is the CLI starting a new turn, so that is what this waits for.
 *
 * Only growth pays the wait. A verdict that watched our own text leave the
 * box, or the CLI's own queue hint appear, is returned untouched and at once.
 */

import type { SubmitEvidence } from './injectEcho'

/** How long to watch for the new turn after a growth-only submit. */
export const SUBMIT_TURN_CONFIRM_MS = 12_000

/** 'turn' once the CLI starts a new turn inside the window, 'unconfirmed'
 *  when it does not, null once the injection is aborted. Any verdict but
 *  'growth' comes back as it went in, without a single sleep.
 *
 *  While watching, a framed box that still holds the collapsed paste
 *  (`collapsedHeld` true) gets ONE more Enter — never on a box that is empty
 *  or cannot be located (false / null). */
export async function confirmWeakSubmit(deps: {
  how: SubmitEvidence
  /** Has the CLI started a turn since the Enter that produced `how`? */
  turnStarted: () => boolean
  collapsedHeld: () => boolean | null
  /** False when the keystroke could not be written. */
  pressEnter: () => Promise<boolean>
  aborted: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  windowMs?: number
  pollMs?: number
}): Promise<SubmitEvidence | null> {
  if (deps.how !== 'growth') return deps.how
  const pollMs = deps.pollMs ?? 250
  const deadline = deps.now() + (deps.windowMs ?? SUBMIT_TURN_CONFIRM_MS)
  let pressed = false
  while (deps.now() < deadline) {
    await deps.sleep(pollMs)
    if (deps.aborted()) return null
    if (deps.turnStarted()) return 'turn'
    if (!pressed && deps.collapsedHeld() === true) {
      pressed = true
      await deps.pressEnter()
    }
  }
  return deps.turnStarted() ? 'turn' : 'unconfirmed'
}
