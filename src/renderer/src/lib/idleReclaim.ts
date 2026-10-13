/**
 * Whether a CLI pane may have its process reclaimed for memory.
 *
 * An idle CLI never gives back what it allocated — a claude process holds
 * 200-300MB of GPU slabs for as long as it lives, whether or not anyone is
 * talking to it. Reclaiming ends the process and leaves the pane as the same
 * click-to-resume placeholder a restart shows, so the cost is one resume and
 * the saving is the whole process.
 *
 * That trade is only acceptable while the user loses nothing they did not
 * choose to lose, which is what this file decides. It is a pure function over a
 * snapshot so every "no" is testable on its own: the reasons are the interesting
 * part, not the yes.
 */

/** Everything the decision reads, flattened out of App.vue's pane state. */
export interface ReclaimCandidate {
  /** False for a pane that is already a placeholder — nothing to reclaim. */
  realized: boolean
  /** A restore in flight; its process is on the way in, not idle. */
  restoring: boolean
  /** The pane the user is looking at. Reading a long answer is using it. */
  focused: boolean
  /** Empty when the conversation cannot be resumed — then this would be a
   *  permanent close nobody asked for. */
  resumeSessionId: string
  rebuilding: boolean
  loopActive: boolean
  /** Anything other than 'ready' means work the user started is still running. */
  preparationStatus: string
  injectionStatus: string
  spawnReportPending: boolean
  /** False when the pane has no live TerminalPane ref to ask. */
  hasRef: boolean
  /** 'idle' | 'running' | 'awaiting' | … — the pane's own badge state. */
  displayStatus: string
  /** Typed but unsent text. It lives only in the CLI's input line. */
  hasDraft: boolean
  /** Newest of (agent output, user keystroke). 0 when neither ever happened. */
  lastTouchedAt: number
  /** The manager pipeline is scraping this pane's buffer for its next
   *  dispatch. It sits idle and unfocused for as long as its workers take. */
  managerRouting: boolean
  /** The pipeline's cross-stage ("global") Manager router is live and this is
   *  the Manager pane it reads. Separate from managerRouting: the global
   *  Manager lives in ONE stage and the per-stage router that owned it is
   *  disposed the moment that stage ends, while the global router keeps reading
   *  it for the whole run. */
  globalManagerRouting: boolean
  /** A stage watcher is polling this pane for its completion sentinel. */
  stageWatched: boolean
  /** Undelivered cross-pane messages are queued for it. */
  hasQueuedMessages: boolean
}

/** Why this pane is not reclaimable, or null when it is. */
export type ReclaimBlock =
  | 'not-realized'
  | 'restoring'
  | 'focused'
  | 'no-resume-id'
  | 'rebuilding'
  | 'loop-active'
  | 'preparing'
  | 'injecting'
  | 'spawn-report-pending'
  | 'no-ref'
  | 'manager-routing'
  | 'global-manager-routing'
  | 'stage-watched'
  | 'has-queued-messages'
  | 'not-idle'
  | 'has-draft'
  | 'never-touched'
  | 'too-recent'

export function reclaimBlockedBy(
  pane: ReclaimCandidate,
  thresholdMs: number,
  now: number
): ReclaimBlock | null {
  if (!pane.realized) return 'not-realized'
  if (pane.restoring) return 'restoring'
  if (pane.focused) return 'focused'
  if (!pane.resumeSessionId) return 'no-resume-id'
  if (pane.rebuilding) return 'rebuilding'
  if (pane.loopActive) return 'loop-active'
  if (pane.preparationStatus !== 'ready') return 'preparing'
  if (pane.injectionStatus === 'pending') return 'injecting'
  if (pane.spawnReportPending) return 'spawn-report-pending'
  if (!pane.hasRef) return 'no-ref'
  // The three below are all the same shape: something OUTSIDE the pane is
  // holding on to it. Every guard above this point reads the pane's own state,
  // which is why these were missing — a pane can be idle by every measure it
  // knows about itself and still be the thing another subsystem is waiting on.
  //
  // They sit above the idle check because none of them is about idleness: the
  // reclaim is wrong here however long the pane has been quiet, and the reason
  // the caller logs should name who was holding it.
  //
  // `resumeContinueAvailable` was a fourth here and was WRONG. It looks like the
  // same shape — a pane parked at the prompt, waiting for the user to press
  // Continue — but the offer is not lost by reclaiming: the realize path sets
  // the flag again whenever it resumes, which it always does for a reclaimed
  // pane (its saved record carries the session id). Nothing was protected, and
  // the flag has no expiry, so every pane opened once after a restart and then
  // left alone became permanently unreclaimable — the exact population this
  // feature exists to reclaim. Do not add it back without an expiry.
  //
  // The manager reads this pane's buffer to route the next dispatch. Its ref
  // goes with the reclaim, so the router silently reads '' forever after.
  if (pane.managerRouting) return 'manager-routing'
  // The cross-stage Manager. managerRouting cannot see it: the global Manager
  // sits in stage 01 and that stage's router is disposed when the stage ends,
  // and in manager mode it has no watcher either — so from stage 02 on it was
  // reclaimable while still being the pane every worker's ASK/REPORT is routed
  // through. Reclaiming it made globalManagerPaneId() return null (it requires
  // `realized`) and globalManagerRouterScan() bail on its first line, with no
  // log. Tied to the router actually being live, so a completed or aborted run
  // releases the pane instead of blocking it forever.
  if (pane.globalManagerRouting) return 'global-manager-routing'
  // A stage watcher polls this pane for its completion sentinel, and nothing
  // rebuilds one: realize skips role injection, which is where watchers start.
  // The stage would wait on a slot that can no longer report.
  if (pane.stageWatched) return 'stage-watched'
  // Queued messages are failed as 'pane-closed' the moment the CLI goes, and
  // their senders are told the pane closed — which it did not.
  if (pane.hasQueuedMessages) return 'has-queued-messages'
  // 'awaiting' is the CLI holding a question open. That pane is idle by every
  // timing measure and is the single worst one to take away.
  if (pane.displayStatus !== 'idle') return 'not-idle'
  if (pane.hasDraft) return 'has-draft'
  // No signal at all is not evidence of age — leave it alone rather than treat
  // it as infinitely old.
  if (!pane.lastTouchedAt) return 'never-touched'
  if (now - pane.lastTouchedAt < thresholdMs) return 'too-recent'
  return null
}

/** Whether this pane is the one in front of the user.
 *
 *  Two ids, because neither on its own is the answer. `requested` is what was
 *  last asked to focus; `effective` is what resolveFocusedPane actually put on
 *  the stage, which differs whenever the request is null, names a minimized
 *  pane, or names one in another workspace. Reading only `requested` let the
 *  sweep reclaim the pane the user was looking at; reading only `effective`
 *  would drop the request the moment it pointed off-stage.
 *
 *  It lives here, next to the guard it feeds, because App.vue cannot be
 *  mounted in a test — a decision left inline there is one no test can run. */
export function focusedForReclaim(
  requested: string | null,
  effective: string | null,
  paneId: string,
): boolean {
  return requested === paneId || effective === paneId
}

/** reclaimBlockedBy for the timed sweep, with Settings → Resource limits'
 *  "also reclaim the focused pane after N hours".
 *
 *  Each workspace window keeps one pane focused, and the focus guard keeps that
 *  pane forever — commander panes sat idle for 12+ hours. `focusedThresholdMs`
 *  0 (the default) is today's rule. Otherwise a focused pane nobody has touched
 *  for that long is judged as if unfocused: only the focus guard is lifted, so
 *  a pane awaiting an answer, holding a draft or not resumable is still kept,
 *  and a pane with no signal at all is never taken as old. */
export function focusedReclaimBlockedBy(
  pane: ReclaimCandidate,
  thresholdMs: number,
  focusedThresholdMs: number,
  now: number
): ReclaimBlock | null {
  const stale = focusedThresholdMs > 0 && pane.lastTouchedAt > 0 && now - pane.lastTouchedAt >= focusedThresholdMs
  return reclaimBlockedBy(pane.focused && stale ? { ...pane, focused: false } : pane, thresholdMs, now)
}

/** Threshold for a reclaim the user asked for by name.
 *
 *  Every other guard still applies — the focused pane, one awaiting an answer,
 *  one with unsent text and one that cannot be resumed are all still refused.
 *  Only the waiting is skipped, because a person pressing "reclaim now" has
 *  already answered the question the timer exists to answer. */
export const RECLAIM_NOW_THRESHOLD_MS = 0

/** Guard for a reclaim aimed at panes the user picked out one by one — the
 *  right-clicked pane, or the multi-selection.
 *
 *  The focus guard exists so nothing is taken from in front of the user
 *  without asking. Picking the pane is the asking, and multi-select hands
 *  focus to the last pane clicked, so keeping the guard here always dropped
 *  one of the selection. Every other guard still applies. */
export function namedReclaimBlockedBy(pane: ReclaimCandidate, now: number): ReclaimBlock | null {
  return reclaimBlockedBy({ ...pane, focused: false }, RECLAIM_NOW_THRESHOLD_MS, now)
}

/** Lower bound on the configured threshold, so a bad stored value cannot turn
 *  the sweep into "reclaim as soon as it stops typing". */
export const IDLE_RECLAIM_MIN_MINUTES = 15
export const IDLE_RECLAIM_DEFAULT_MINUTES = 30

/** The stored value that means "no timed reclaim, however long a pane sits".
 *
 *  A sentinel rather than a number because every number in this setting is a
 *  duration the floor clamps: '0' does not mean off, it means 15 minutes. The
 *  same word the resume-behavior select already uses for the same idea. */
export const IDLE_RECLAIM_NEVER = 'never'

/** Whether the stored threshold switches the timed sweep off entirely. */
export function idleReclaimDisabled(stored: string): boolean {
  return stored.trim().toLowerCase() === IDLE_RECLAIM_NEVER
}

export function idleReclaimThresholdMs(stored: string): number {
  // The callers that matter check idleReclaimDisabled first and never sweep.
  // Answering with an unreachable threshold rather than a fallback duration
  // means a caller that forgot still reclaims nothing, instead of quietly
  // reclaiming on the 30-minute default the user just switched off.
  if (idleReclaimDisabled(stored)) return Number.POSITIVE_INFINITY
  const parsed = Number.parseInt(stored, 10)
  const minutes = Number.isFinite(parsed)
    ? Math.max(parsed, IDLE_RECLAIM_MIN_MINUTES)
    : IDLE_RECLAIM_DEFAULT_MINUTES
  return minutes * 60_000
}
