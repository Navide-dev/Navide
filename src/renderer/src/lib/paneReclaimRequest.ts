/**
 * Argument and answer helpers for the `ui.pane.reclaim` UI action — the MCP
 * route to the status bar's "reclaim now".
 *
 * The decision itself is idleReclaim's reclaimBlockedBy; this file only reads
 * the request and puts each refusal into words, so an agent that asked for a
 * pane to be reclaimed learns why it was not without knowing the guard codes.
 */
import type { ReclaimBlock } from './idleReclaim'

/** `paneId` as one id or an array of them, blanks and repeats dropped. */
export function reclaimRequestPaneIds(args: unknown): string[] {
  const raw = (args as { paneId?: unknown } | null | undefined)?.paneId
  const list = Array.isArray(raw) ? raw : [raw]
  const ids: string[] = []
  for (const v of list) {
    if (typeof v !== 'string' || !v.trim() || ids.includes(v)) continue
    ids.push(v)
  }
  return ids
}

/** A reclaim refusal: one of the guards, an id that names no pane here, a
 *  pane that left the list during its own kill (its CLI did stop), or a reclaim
 *  that threw. */
export type ReclaimRefusal = ReclaimBlock | 'not-found' | 'gone-after-kill' | 'error'

const REASONS: Record<ReclaimRefusal, string> = {
  'not-found': 'no pane with this id in this window',
  'gone-after-kill': 'its CLI was stopped, but the pane left the window during the kill, so no resume card was left',
  error: 'the reclaim failed partway; check the pane before retrying',
  'not-realized': 'already reclaimed or closed: it is a click-to-resume placeholder',
  restoring: 'a restore is in flight for it',
  focused: 'the user has it focused',
  'no-resume-id': 'its conversation has no session id to resume from, so this would be a permanent close',
  rebuilding: 'it is being rebuilt',
  'loop-active': 'a loop is running in it',
  preparing: 'it is still starting up',
  injecting: 'its role or task is still being injected',
  'spawn-report-pending': 'it still owes its parent a spawn report',
  'no-ref': 'it has no live terminal to ask about its state',
  'manager-routing': 'a pipeline stage router is reading it',
  'global-manager-routing': 'it is the Manager of a running pipeline',
  'stage-watched': 'a pipeline stage is waiting on it to report completion',
  'has-queued-messages': 'messages are queued for it and would be dropped',
  'not-idle': 'it is busy or waiting on an answer, not idle',
  'has-draft': 'it has unsent text in its input line',
  'never-touched': 'it has shown no activity yet, so its age is unknown',
  'too-recent': 'it was active too recently',
}

export function reclaimRefusalReason(reason: ReclaimRefusal): string {
  return REASONS[reason]
}
