/**
 * submitStall.ts
 *
 * The last look injectText (App.vue) takes before it reports a message
 * "never submitted": Enter went out three times and the input box never
 * showed it let go. On the 0.2.37 Linux VM (run 20261103-183841) that was a
 * frozen screen, not an unsent message: the backend's event loop stalled 4–6 s
 * at a time (2–8 s measured), the terminal output and the turn events reach
 * the window through it, and Claude Code's stop hook, which curls the backend,
 * took 34 s. The kickoff had been taken; the run was failed while the agent
 * worked on it for 38 s.
 *
 * So before that verdict the pane gets a grace window in which any sign that
 * the CLI took the message counts: a turn event since the first Enter, a new
 * busy line on screen (spinner, running stop hooks, "Worked for"), or the box
 * reading as submitted once the screen catches up.
 */

/** Grace before "never submitted": the 34 s stop hook measured under the stall
 *  (its curl to the backend is what a turn event waits behind too), plus one
 *  worst 8 s stall, rounded up. */
export const SUBMIT_STALL_GRACE_MS = 45_000

/** A CLI working on a turn, read off one screen line. Claude Code draws a
 *  spinner line ("✻ Manifesting… (running Stop hooks… 1/2 · 34s)") and leaves
 *  "✻ Worked for 38s" when the turn ends; Codex and others say "esc to
 *  interrupt". */
const BUSY_LINE_RES = [
  /esc to interrupt/i,
  /running stop hooks/i,
  /^\S\s+[A-Z][a-z]+…\s*\(/,
  /^\S\s+[A-Z][a-z]+ for (?:\d+h\s*)?(?:\d+m\s*)?\d+s\b/,
]

/** The screen's busy lines, trimmed. */
export function busyLines(screen: string): string[] {
  return screen
    .split('\n')
    .map((l) => l.replace(/[│┃]/g, '').trim())
    .filter((l) => BUSY_LINE_RES.some((re) => re.test(l)))
}

/** A busy line that was not on screen before the first Enter: the previous
 *  turn's "Worked for 12s" left in the transcript says nothing about ours. */
export function newBusyLine(before: readonly string[], screen: string): boolean {
  const seen = new Set(before)
  return busyLines(screen).some((l) => !seen.has(l))
}

export type LateSubmit = 'turn' | 'busy' | 'screen'

/** What showed, within the grace window, that the CLI took the message —
 *  null when nothing did, 'aborted' once the pane is gone. */
export async function awaitLateSubmit(deps: {
  /** A turn started or ended, or agent activity, since the first Enter. */
  turnSeen: () => boolean
  /** A busy line not on screen before the first Enter. */
  busySeen: () => boolean
  /** The input box now reads as submitted. */
  screenSubmitted: () => boolean
  aborted: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  graceMs?: number
  pollMs?: number
}): Promise<LateSubmit | 'aborted' | null> {
  const deadline = deps.now() + (deps.graceMs ?? SUBMIT_STALL_GRACE_MS)
  const pollMs = deps.pollMs ?? 500
  for (;;) {
    if (deps.aborted()) return 'aborted'
    if (deps.turnSeen()) return 'turn'
    if (deps.busySeen()) return 'busy'
    if (deps.screenSubmitted()) return 'screen'
    if (deps.now() >= deadline) return null
    await deps.sleep(pollMs)
  }
}

/** After a kickoff was judged never submitted: did the pane start a turn
 *  anyway, within `windowMs`? Then the run's verdict and the agent disagree. */
export async function awaitTurnAfterFailure(deps: {
  turnSeen: () => boolean
  alive: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  windowMs?: number
  pollMs?: number
}): Promise<boolean> {
  const deadline = deps.now() + (deps.windowMs ?? 2 * SUBMIT_STALL_GRACE_MS)
  const pollMs = deps.pollMs ?? 1_000
  for (;;) {
    if (deps.turnSeen()) return true
    if (!deps.alive() || deps.now() >= deadline) return false
    await deps.sleep(pollMs)
  }
}
