import {
  agentFacingAccountName,
  DEFAULT_SLOT_ID,
  type AgentAccountSwitchAccounts,
} from './agentAccountSwitch'
import type { AccountSwitchQueue, SwitchOutcome } from './accountSwitchQueue'

/**
 * ui.accounts.switch with `paneId` (MCP cli_account_switch pane_id, plan
 * mcp-pane-cli-usage_213031 P4): move ONE claude pane to another account, the
 * way the badge's "switch only this pane" does. The pane is reopened on its
 * conversation in that account's own folder; the CLI's live login and every
 * other pane stay as they are.
 *
 * Nothing asks the user (plan agent-0-2-42_3f728e): the window's own
 * single-pane move runs directly when the pane is idle; a working pane — the
 * calling agent's own, typically — is moved once its turn ends
 * (accountSwitchQueue), never interrupted. The CLI-wide path is
 * agentAccountSwitch.ts.
 */

/** The target pane as the main window sees it. */
export interface AgentPaneAccountTarget {
  agentKey: string
  name: string
  isLogin: boolean
  /** Runs in an account's own folder (not following the live login). */
  fixed: boolean
  /** The account it runs on now; null = the built-in Default. */
  profileId: string | null
}

export type AgentPaneAccountSwitchPlan =
  | { kind: 'move'; agentKey: string; paneId: string; paneName: string; targetId: string; fromId: string | null }
  | {
      kind: 'refused'
      code: 'bad-request' | 'unsupported' | 'unknown-pane' | 'unknown-profile' | 'already-active' | 'needs-user'
      message: string
    }

export interface AgentPaneAccountSwitchPlanDeps {
  accounts: AgentAccountSwitchAccounts
  /** The one CLI with account folders. */
  folderAgent: string
  pane: (paneId: string) => AgentPaneAccountTarget | undefined
  /** Has this account signed in inside its own folder? */
  dirSignedIn: (profileId: string) => boolean
}

export function planAgentPaneAccountSwitch(
  req: { agentKey: string; profileId: string; paneId: string },
  deps: AgentPaneAccountSwitchPlanDeps,
): AgentPaneAccountSwitchPlan {
  const { agentKey, profileId, paneId } = req
  if (!agentKey || !profileId || !paneId) {
    return { kind: 'refused', code: 'bad-request', message: 'agent, profile_id and pane_id are required' }
  }
  if (agentKey !== deps.folderAgent) {
    return {
      kind: 'refused', code: 'unsupported',
      message: `${agentKey} panes all run on its live login; only ${deps.folderAgent} can move one pane to another account`,
    }
  }
  const pane = deps.pane(paneId)
  if (!pane || pane.isLogin || pane.agentKey !== agentKey) {
    return { kind: 'refused', code: 'unknown-pane', message: `no ${agentKey} pane "${paneId}" in this window` }
  }
  if (profileId === DEFAULT_SLOT_ID) {
    return {
      kind: 'refused', code: 'unsupported',
      message: 'the built-in Default account has no folder of its own, so one pane cannot be moved onto it',
    }
  }
  if (deps.accounts.findProfile(profileId)?.agentKey !== agentKey) {
    return { kind: 'refused', code: 'unknown-profile', message: `no ${agentKey} account "${profileId}" in Settings → Accounts` }
  }
  if (pane.fixed && pane.profileId === profileId) {
    return { kind: 'refused', code: 'already-active', message: 'that pane already runs on that account; nothing was switched' }
  }
  if (!deps.dirSignedIn(profileId)) {
    return {
      kind: 'refused', code: 'needs-user',
      message: `account "${profileId}" has not signed in inside its own folder; sign it in with cli_account_sign_in(mode="folder") first`,
    }
  }
  return { kind: 'move', agentKey, paneId, paneName: pane.name, targetId: profileId, fromId: pane.profileId }
}

export interface AgentPaneAccountSwitchDeps extends AgentPaneAccountSwitchPlanDeps {
  /** Is the pane working (a rebuild now would stop its turn)? */
  paneBusy: (paneId: string) => boolean
  /** The window's single-pane move, never asking: resolves a failure token
   *  ('busy' when the pane is working), or undefined once it runs on the account. */
  movePane: (paneId: string, profileId: string) => Promise<string | undefined>
  queue: AccountSwitchQueue
  /** A move that answered "queued" ended (or was superseded). */
  onSettled: (outcome: SwitchOutcome) => void
}

/** Move the pane now, or queue the move until the pane is idle. */
export async function runAgentPaneAccountSwitch(
  args: Record<string, unknown>,
  deps: AgentPaneAccountSwitchDeps,
): Promise<SwitchOutcome> {
  const request = {
    agentKey: String(args.agentKey ?? ''),
    profileId: String(args.profileId ?? ''),
    paneId: String(args.paneId ?? ''),
  }
  const plan = planAgentPaneAccountSwitch(request, deps)
  if (plan.kind === 'refused') return { status: plan.code, message: plan.message }
  const key = `pane:${plan.paneId}`
  deps.queue.supersede(key)

  const attempt = async (): Promise<SwitchOutcome> => {
    const now = planAgentPaneAccountSwitch(request, deps)
    if (now.kind === 'refused') return { status: now.code, message: now.message }
    const from = agentFacingAccountName(deps.accounts, now.agentKey, now.fromId)
    const to = agentFacingAccountName(deps.accounts, now.agentKey, now.targetId)
    const queued = { status: 'queued', waiting: 1, from, to, paneName: now.paneName }
    if (deps.paneBusy(now.paneId)) return queued
    const failure = await deps.movePane(now.paneId, now.targetId)
    if (!failure) {
      return { status: 'switched-pane', from, to, paneName: now.paneName, fromProfileId: now.fromId ?? DEFAULT_SLOT_ID }
    }
    if (failure === 'busy') return queued
    return { status: 'refused', code: failure }
  }

  const first = await attempt()
  if (first.status === 'queued') {
    deps.queue.enqueue({
      key,
      waiting: () => (deps.paneBusy(plan.paneId) ? 1 : 0),
      run: attempt,
      settle: deps.onSettled,
    })
  }
  return first
}
