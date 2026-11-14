/**
 * failedRunStop.ts
 *
 * What a run that failed does to the agents of its other slots. On the 0.2.37
 * Linux VM (70e669130, run 20261103-204149) one slot parked on a permission
 * box failed the run, and the manager slot, whose kickoff had gone out a
 * moment earlier, kept working: it printed MANAGER-READY, ran `touch RAN.txt`
 * and parked on a permission box of its own. In an unattended webhook run
 * (bypass permissions) nothing stops such an agent. So a failed run presses
 * the stop key of every other slot still in a turn, and leaves the prompt of
 * every slot parked on one. The panes stay open for the person to read.
 *
 * The pane's status is not enough on its own: the manager's Enter went out
 * 200 ms before the failure, and the turn it started shows on the badge only
 * once agent_active arrives (up to 2 s later on Windows). So a pane this run
 * sent its role or kickoff to, with no turn end since, counts as working too;
 * and for a while after the failure, a pane that turns busy is stopped then.
 */

/** 'interrupt': the pane is in a turn, press its vendor's interrupt key (the
 *  pane's stop button). 'dismiss': it is parked on a prompt, leave it with
 *  Esc rather than sit on Yes/No. null: idle, starting, exited — nothing. */
export type FailedRunStop = 'interrupt' | 'dismiss'

export function failedRunStop(displayStatus: string | undefined): FailedRunStop | null {
  if (displayStatus === 'running') return 'interrupt'
  if (displayStatus === 'awaiting') return 'dismiss'
  return null
}

/** How long after the failure a pane that turns busy is still stopped. */
export const FAILED_RUN_WATCH_MS = 30_000

/** Stop the panes now, then watch the rest for FAILED_RUN_WATCH_MS: each is
 *  stopped at most once. A pane the person typed into since the failure is
 *  theirs and left alone; once the run goes on (resume, restart, a new run)
 *  nothing more is pressed. */
export async function stopFailedRunPanes(deps: {
  paneIds: readonly string[]
  status: (paneId: string) => string | undefined
  /** This run sent the pane its role or kickoff, and no turn end since. */
  sentUnfinished: (paneId: string) => boolean
  /** The person typed into the pane since the failure. */
  userTouched: (paneId: string) => boolean
  runGoesOn: () => boolean
  stop: (paneId: string, how: FailedRunStop) => Promise<void>
  sleep: (ms: number) => Promise<void>
  now: () => number
  windowMs?: number
  pollMs?: number
}): Promise<void> {
  const deadline = deps.now() + (deps.windowMs ?? FAILED_RUN_WATCH_MS)
  const pollMs = deps.pollMs ?? 500
  const pending = new Set(deps.paneIds)
  for (;;) {
    for (const paneId of [...pending]) {
      if (deps.runGoesOn()) return
      if (deps.userTouched(paneId)) {
        pending.delete(paneId)
        continue
      }
      const how = failedRunStop(deps.status(paneId)) ?? (deps.sentUnfinished(paneId) ? 'interrupt' : null)
      if (!how) continue
      pending.delete(paneId)
      await deps.stop(paneId, how)
    }
    if (pending.size === 0 || deps.now() >= deadline) return
    await deps.sleep(pollMs)
    if (deps.runGoesOn()) return
  }
}
