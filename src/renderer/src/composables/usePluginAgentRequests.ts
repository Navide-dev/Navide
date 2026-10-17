import type { useBackend } from './useBackend'
import {
  PLUGIN_APPROVAL_FINISH_ACTION,
  PLUGIN_APPROVAL_LIST_MESSAGE,
} from '../../../shared/pluginAgentTools'
import {
  recoverApplyingRequests,
  type FinishStatus,
  type InstalledPackage,
  type PluginRequestRecord,
} from '../lib/pluginAgentRequestApply'

/**
 * The window side of agent Navide plugin requests (plan B, B2-c): report the
 * result of an approved request (`plugins.agent_request.finish`, with a trust
 * confirmation only a window can mint, subject `<approval_id>:<status>`), and settle
 * the requests a restart left `applying`. The approval card (D-c) uses
 * `finish` and `listInstalled` as the deps of applyApprovedRequest.
 */
/** How long a request must stay unclaimed before another window settles it
 *  (review-370 R2): a reconnecting window announces itself well within this.
 *  A time window, not a limit on anything. */
export const RECOVERY_GRACE_MS = 5_000

export function usePluginAgentRequests(backend: Pick<ReturnType<typeof useBackend>, 'send'>) {
  async function finish(approvalId: string, result: FinishStatus): Promise<void> {
    // Bound to the status too: a confirmation to report failure cannot report success.
    const confirmation = await window.agentTeam?.trustConfirm(PLUGIN_APPROVAL_FINISH_ACTION, '', `${approvalId}:${result.status}`)
    const res = await backend.send(
      PLUGIN_APPROVAL_FINISH_ACTION,
      { approval_id: approvalId, status: result.status, error: result.error, confirmation },
    )
    if (!res.ok) throw new Error(res.error?.message ?? 'the request could not be finished')
  }

  async function listInstalled(): Promise<InstalledPackage[]> {
    return (await window.agentTeam?.plugins?.listInstalled?.()) ?? []
  }

  async function openRequests(): Promise<{ requests: PluginRequestRecord[]; inLiveWindow: Set<string> } | null> {
    const res = await backend.send<{ requests: PluginRequestRecord[]; applyingInLiveWindow?: string[] }>(
      PLUGIN_APPROVAL_LIST_MESSAGE,
    )
    if (!res.ok || !Array.isArray(res.payload?.requests)) return null
    const live = Array.isArray(res.payload.applyingInLiveWindow) ? res.payload.applyingInLiveWindow : []
    return { requests: res.payload.requests, inLiveWindow: new Set(live) }
  }

  /** Settle the requests still `applying` that no open main window is carrying
   *  out: at this window's first connection, and when the backend says a main
   *  window went away mid-apply (review-370 R1). A request is settled only if it
   *  is still unclaimed after `graceMs`: the window carrying it may just be
   *  reconnecting, and it claims the request back within that time (R2). */
  async function recover(graceMs = RECOVERY_GRACE_MS): Promise<void> {
    const first = await openRequests()
    if (!first) return
    const unclaimed = new Set(
      first.requests
        .filter((r) => r.status === 'applying' && !first.inLiveWindow.has(r.approval_id))
        .map((r) => r.approval_id),
    )
    if (unclaimed.size === 0) return
    if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs))
    const second = graceMs > 0 ? await openRequests() : first
    if (!second) return
    const stillUnclaimed = second.requests.filter((r) => unclaimed.has(r.approval_id))
    await recoverApplyingRequests(stillUnclaimed, { listInstalled, finish }, second.inLiveWindow)
  }

  return { finish, listInstalled, recover }
}
