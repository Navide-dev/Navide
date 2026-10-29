import {
  agentFacingAccountName,
  type AgentAccountSwitchAccounts,
  type AgentAccountSwitchConfirmRequest,
} from './agentAccountSwitch'
import type { AgentSignInConfirmAnswer } from './agentSignIn'

/**
 * MCP cli_account_switch with `pane_id` (plan mcp-pane-cli-usage_213031 P4):
 * move ONE claude pane to another account, the way the badge's "switch only
 * this pane" does. The pane is reopened on its conversation in that account's
 * own folder; the CLI's live login and every other pane stay as they are.
 *
 * Nothing new switches anything: the main window asks the user first (the
 * same dialog as a CLI-wide switch, naming the pane), and only their yes calls
 * the window's own single-pane move, which rebuilds the pane with that
 * account's pin exactly as fixing it (📌) or moveFixedAccountPane does. The
 * CLI-wide path (agentAccountSwitch.ts) is untouched.
 */

/** What the dialog shows for a single-pane switch: the CLI-wide request plus
 *  the pane that moves. */
export interface AgentPaneAccountSwitchConfirmRequest extends AgentAccountSwitchConfirmRequest {
  paneName: string
}

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

const DEFAULT_SLOT_ID = '__default__'

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
  callerPane: (paneId: string) => { workspacePath: string; name: string } | undefined
  /** The user-facing label (may be an email: the user sees it, the agent does not). */
  accountLabel: (agentKey: string, profileId: string | null) => string
  confirm: (request: AgentPaneAccountSwitchConfirmRequest, signal?: AbortSignal) => Promise<AgentSignInConfirmAnswer>
  /** The window's single-pane move; resolves a failure token, or undefined
   *  once the pane runs on the account. */
  movePane: (paneId: string, profileId: string) => Promise<string | undefined>
  now: () => number
}

const CONFIRM_REFUSALS: Record<Exclude<AgentSignInConfirmAnswer, 'confirmed'>, { status: string; message: string }> = {
  declined: { status: 'declined', message: 'the user declined the account switch' },
  expired: { status: 'confirm-timeout', message: 'the user did not answer the account switch in time' },
  busy: { status: 'busy', message: "another agent's account switch is waiting for the user; ask again later" },
}

/** Refuse what planAgentPaneAccountSwitch refuses, ask the user, and move the
 *  pane only on their yes, planned again after they answer. */
export async function runAgentPaneAccountSwitch(
  args: Record<string, unknown>,
  callerPaneId: string,
  deps: AgentPaneAccountSwitchDeps,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const request = {
    agentKey: String(args.agentKey ?? ''),
    profileId: String(args.profileId ?? ''),
    paneId: String(args.paneId ?? ''),
  }
  const plan = planAgentPaneAccountSwitch(request, deps)
  if (plan.kind === 'refused') return { status: plan.code, message: plan.message }
  const confirmBy = typeof args.confirmBy === 'number' ? args.confirmBy : NaN
  if (!Number.isFinite(confirmBy) || confirmBy <= deps.now()) {
    return { status: 'bad-request', message: 'the switch request carries no confirmation deadline still open' }
  }
  const caller = deps.callerPane(callerPaneId)
  if (!caller) return { status: 'unknown-caller', message: 'the calling pane is not one of this window\'s panes' }

  const answer = await deps.confirm({
    agentKey: plan.agentKey,
    fromLabel: deps.accountLabel(plan.agentKey, plan.fromId),
    toLabel: deps.accountLabel(plan.agentKey, plan.targetId),
    callerPaneId,
    callerName: caller.name,
    workspacePath: caller.workspacePath,
    reason: String(args.reason ?? ''),
    reasonTruncated: args.reasonTruncated === true,
    confirmBy,
    paneName: plan.paneName,
  }, signal)
  if (answer !== 'confirmed' || signal?.aborted) return CONFIRM_REFUSALS[answer === 'confirmed' ? 'expired' : answer]

  const now = planAgentPaneAccountSwitch(request, deps)
  if (now.kind === 'refused') return { status: now.code, message: now.message }
  const from = agentFacingAccountName(deps.accounts, now.agentKey, now.fromId)
  const to = agentFacingAccountName(deps.accounts, now.agentKey, now.targetId)
  const failure = await deps.movePane(now.paneId, now.targetId)
  if (!failure) return { status: 'switched-pane', from, to }
  // The pane was working and the user kept it running.
  if (failure === 'declined') return { status: 'restart-declined', code: failure }
  return { status: 'refused', code: failure }
}
