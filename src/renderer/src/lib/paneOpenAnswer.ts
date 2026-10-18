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

/** A pane as far as "who runs which conversation" goes: a realized pane's own session, or
 *  the session a placeholder would be restored onto (normalized either way). */
export interface SessionHolder {
  id: string
  agentKey: string
  sessionId: string
  realized: boolean
  restoring: boolean
}

/** Whether a pane other than `paneId` runs, is being restored onto, or is queued in this
 *  cold restore (`scheduled`) for the same conversation: opening `paneId` onto it too would
 *  put a second CLI on one session. */
export function sessionHeldElsewhere(
  holders: readonly SessionHolder[],
  paneId: string,
  agentKey: string,
  sessionId: string,
  scheduled: ReadonlySet<string>,
): boolean {
  if (!sessionId) return false
  return holders.some((h) => h.id !== paneId && h.agentKey === agentKey && h.sessionId === sessionId
    && (h.realized || h.restoring || scheduled.has(h.id)))
}

/** Conversations a chat's wake brought back, which a later restore must not open a second
 *  time. A wake claims its session when it starts and keeps it only when it opened; any
 *  other outcome lets restores of that session through again, as they are on main. */
export class WakeClaims {
  private readonly held = new Set<string>()
  private readonly byPane = new Map<string, string>()

  claim(paneId: string, sessionKey: string): void {
    this.held.add(sessionKey)
    this.byPane.set(paneId, sessionKey)
  }

  settle(paneId: string, outcome: string): void {
    const sessionKey = this.byPane.get(paneId)
    this.byPane.delete(paneId)
    if (sessionKey !== undefined && !RESUMED_OUTCOMES.has(outcome)) this.held.delete(sessionKey)
  }

  holds(sessionKey: string): boolean {
    return this.held.has(sessionKey)
  }
}
