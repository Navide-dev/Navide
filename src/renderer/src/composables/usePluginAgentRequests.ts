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

  /** Settle the requests still `applying` from before this window started,
   *  leaving alone those another open main window is carrying out. */
  async function recover(): Promise<void> {
    const res = await backend.send<{ requests: PluginRequestRecord[]; applyingInLiveWindow?: string[] }>(
      PLUGIN_APPROVAL_LIST_MESSAGE,
    )
    if (!res.ok || !Array.isArray(res.payload?.requests)) return
    const inLiveWindow = new Set(Array.isArray(res.payload.applyingInLiveWindow) ? res.payload.applyingInLiveWindow : [])
    await recoverApplyingRequests(res.payload.requests, { listInstalled, finish }, inLiveWindow)
  }

  return { finish, listInstalled, recover }
}
