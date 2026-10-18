// ui.pane.open's answer, and what a `requireResume` caller (a chat's wake) is told. Such a
// caller must get the pane back on its saved conversation or nothing: a pane that opened on
// a fresh session is never reported as realized to it, and every answer says which session
// the pane was launched on so the caller can check it is the one it asked for.

/** Outcomes that mean a CLI now runs the saved conversation (or already did). */
const RESUMED_OUTCOMES = new Set(['opened', 'already-open'])

/** A realize that was already running answers for whoever started it, which may not have
 *  required the saved conversation: a fresh open is a refusal for one that does. */
export function joinedRealizeOutcome<T extends string>(outcome: T, requireResume: boolean): T | 'fresh-refused' {
  return requireResume && outcome === 'fresh' ? 'fresh-refused' : outcome
}

export interface PaneOpenAnswer {
  realized: boolean
  reason: string
  paneId: string
  /** The session the pane was launched on: '' for a fresh one, null when not known. */
  launchedSessionId: string | null
}

export function paneOpenAnswer(opts: {
  paneId: string
  reason: string
  realized: boolean
  requireResume: boolean
  launchedSessionId: string | undefined
}): PaneOpenAnswer {
  const reason = joinedRealizeOutcome(opts.reason, opts.requireResume)
  const realized = opts.realized && (!opts.requireResume || RESUMED_OUTCOMES.has(reason))
  return { realized, reason, paneId: opts.paneId, launchedSessionId: opts.launchedSessionId ?? null }
}
