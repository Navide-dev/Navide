import { INTERRUPTED_RESUME_LIMIT, interruptedRestoreTargetIds } from './resumeBehavior'

/** A pane whose CLI the backend restart ended (its PTY was gone on reconnect). */
export interface LostPane {
  id: string
  /** On screen when the loss was seen: these are resumed as before, uncapped. */
  onScreen: boolean
  /** Running or waiting on an answer when the backend went away. */
  working: boolean
  /** Has a conversation on disk a resume can pick up. */
  canResume: boolean
  /** The pane that spawned this one, when it is still in the window. */
  spawnedBy?: string
}

export type NotResumedReason = 'crash-loop' | 'over-limit' | 'idle-off-screen' | 'no-session'

export interface BackendRestartPlan {
  /** In order: every on-screen pane first (as before H3), then the off-screen
   *  panes that were working, capped, each followed by its waiting parent. */
  resume: string[]
  notResumed: { id: string; reason: NotResumedReason }[]
}

/** Which panes a backend restart brings back by itself.
 *
 *  - On-screen panes keep their old behaviour: all of them, no cap.
 *  - Off-screen panes are new (H3): only the ones that were working, at most
 *    `limit` of them (parents counted, as on a relaunch); the rest stay ended.
 *  - A repeat crash inside one auto-restart budget (`crashLoop`) resumes
 *    nothing: every pane stays ended and is listed.
 *  Nothing here kills or restarts a pane; it only picks. */
export function planBackendRestartResume(
  lost: readonly LostPane[],
  opts: { crashLoop: boolean; limit?: number },
): BackendRestartPlan {
  if (opts.crashLoop) {
    return { resume: [], notResumed: lost.map((p) => ({ id: p.id, reason: 'crash-loop' as const })) }
  }
  const resume = lost.filter((p) => p.onScreen).map((p) => p.id)
  const offScreen = lost.filter((p) => !p.onScreen)
  const notResumed: BackendRestartPlan['notResumed'] = []
  // Every resumable off-screen pane is a candidate, so an idle parent waiting
  // on a working child can ride along; only working ones are picked for themselves.
  const picked = interruptedRestoreTargetIds({
    pending: offScreen.filter((p) => p.canResume).map((p) => ({
      id: p.id,
      interrupted: p.working,
      spawnedBy: p.spawnedBy,
    })),
    visibleIds: [],
    limit: opts.limit ?? INTERRUPTED_RESUME_LIMIT,
  })
  for (const id of picked) if (!resume.includes(id)) resume.push(id)
  for (const p of offScreen) {
    if (resume.includes(p.id)) continue
    if (!p.canResume) notResumed.push({ id: p.id, reason: 'no-session' })
    else if (p.working) notResumed.push({ id: p.id, reason: 'over-limit' })
    else notResumed.push({ id: p.id, reason: 'idle-off-screen' })
  }
  return { resume, notResumed }
}

/** Whether the restart behind this reconnect repeats one this window already
 *  came back from, inside the same auto-restart budget.
 *
 *  The main process numbers a budget's attempts from 1 and counts a respawn
 *  that failed to start as an attempt too, so "attempt > 1" alone would call
 *  a single crash with one failed respawn a loop. What makes it a loop is that
 *  an earlier attempt of this budget already reconnected (`lastReconnected`)
 *  and the backend went down again: attempts only grow within a budget, and a
 *  budget reset (60 s stable) or a manual restart starts again from 1 / none. */
export function isRepeatCrash(
  attempt: number | null | undefined,
  lastReconnected: number | null | undefined,
): boolean {
  return typeof attempt === 'number' && typeof lastReconnected === 'number' && attempt > lastReconnected
}
