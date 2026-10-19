import type { SetDefaultResult } from '../composables/useCliProfiles'
import type { AgentSignInConfirmAnswer } from './agentSignIn'

/**
 * An agent's request to switch a CLI account (MCP cli_account_switch, reached
 * through the UI action bus as ui.accounts.switch; plan mcp_614482 P3).
 *
 * The main window asks the user first. Only their yes calls the window's own
 * switch handler (cliAccountSwitch), with the vendor and the account and
 * nothing else: no force, no restoreLive, no live-drift assumption. Whatever
 * that handler asks on its own (restarting running panes, a changed live
 * login) it still asks the user. The agent hears back a status and account
 * display names only: never an email, a credential or a backend message.
 */

/** The slice of useCliProfiles this needs (cached state, no backend call). */
export interface AgentAccountSwitchAccounts {
  findProfile: (id: string | null | undefined) => { agentKey: string; name: string } | undefined
  defaultProfileId: (agentKey: string) => string | null
  aliasFor: (agentKey: string, profileId: string | null | undefined) => string | undefined
}

export type AgentAccountSwitchPlan =
  /** targetId / fromId null = the built-in Default. */
  | { kind: 'switch'; agentKey: string; targetId: string | null; fromId: string | null }
  | { kind: 'refused'; code: 'bad-request' | 'unknown-profile' | 'already-active'; message: string }

const DEFAULT_SLOT_ID = '__default__'

/** The name an agent may see for an account: the user's alias or the
 *  account's given name, never the signed-in email accountLabel prefers. */
export function agentFacingAccountName(
  accounts: AgentAccountSwitchAccounts,
  agentKey: string,
  profileId: string | null,
): string {
  const alias = accounts.aliasFor(agentKey, profileId)
  if (alias) return alias
  if (profileId === null) return 'Default'
  return accounts.findProfile(profileId)?.name ?? profileId
}

export function planAgentAccountSwitch(
  req: { agentKey: string; profileId: string },
  accounts: AgentAccountSwitchAccounts,
): AgentAccountSwitchPlan {
  const { agentKey, profileId } = req
  if (!agentKey || !profileId) {
    return { kind: 'refused', code: 'bad-request', message: 'agent and profile_id are required' }
  }
  const targetId = profileId === DEFAULT_SLOT_ID ? null : profileId
  if (targetId !== null && accounts.findProfile(targetId)?.agentKey !== agentKey) {
    return { kind: 'refused', code: 'unknown-profile', message: `no ${agentKey} account "${profileId}" in Settings → Accounts` }
  }
  const fromId = accounts.defaultProfileId(agentKey)
  if (fromId === targetId) {
    return { kind: 'refused', code: 'already-active', message: `${agentKey} already runs on that account; nothing was switched` }
  }
  return { kind: 'switch', agentKey, targetId, fromId }
}

/** What the main window shows the user before an agent's switch runs.
 *  `reason` is the agent's own text. */
export interface AgentAccountSwitchConfirmRequest {
  agentKey: string
  fromLabel: string
  toLabel: string
  callerPaneId: string
  callerName: string
  /** The calling pane's workspace, so the user can tell which agent asked. */
  workspacePath: string
  reason: string
  /** The backend cut the reason to its length cap; the dialog says so. */
  reasonTruncated: boolean
  /** Epoch ms after which a yes no longer counts (the backend's deadline). */
  confirmBy: number
}

/** What runAgentAccountSwitch needs from the main window. */
export interface AgentAccountSwitchDeps {
  accounts: AgentAccountSwitchAccounts
  callerPane: (paneId: string) => { workspacePath: string; name: string } | undefined
  /** The user-facing label (may be an email: the user sees it, the agent does not). */
  accountLabel: (agentKey: string, profileId: string | null) => string
  confirm: (request: AgentAccountSwitchConfirmRequest, signal?: AbortSignal) => Promise<AgentSignInConfirmAnswer>
  /** The window's own switch handler (cliAccountSwitch), called with the
   *  vendor and the account only. */
  switchAccount: (agentKey: string, profileId: string | null) => Promise<SetDefaultResult>
  now: () => number
}

const CONFIRM_REFUSALS: Record<Exclude<AgentSignInConfirmAnswer, 'confirmed'>, { status: string; message: string }> = {
  declined: { status: 'declined', message: 'the user declined the account switch' },
  expired: { status: 'confirm-timeout', message: 'the user did not answer the account switch in time' },
  busy: { status: 'busy', message: "another agent's account switch is waiting for the user; ask again later" },
}

/** MCP cli_account_switch in the main window: refuse what
 *  planAgentAccountSwitch refuses, ask the user, and switch only on their
 *  yes — planned again after they answer, since the accounts may have
 *  changed while they were asked. */
export async function runAgentAccountSwitch(
  args: Record<string, unknown>,
  callerPaneId: string,
  deps: AgentAccountSwitchDeps,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const request = { agentKey: String(args.agentKey ?? ''), profileId: String(args.profileId ?? '') }
  const plan = planAgentAccountSwitch(request, deps.accounts)
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
  }, signal)
  // A yes for a request the backend withdrew meanwhile is a lapsed one.
  if (answer !== 'confirmed' || signal?.aborted) return CONFIRM_REFUSALS[answer === 'confirmed' ? 'expired' : answer]

  const now = planAgentAccountSwitch(request, deps.accounts)
  if (now.kind === 'refused') return { status: now.code, message: now.message }
  const from = agentFacingAccountName(deps.accounts, now.agentKey, now.fromId)
  const to = agentFacingAccountName(deps.accounts, now.agentKey, now.targetId)
  const res = await deps.switchAccount(now.agentKey, now.targetId)
  if (res.ok) return { status: res.needsLogin ? 'switched-signed-out' : 'switched', from, to }
  // The handler asked the user to restart the running panes, and they said no.
  if (res.code === 'PANES_RUNNING') return { status: 'restart-declined', code: res.code }
  // The code only: a backend message is unreviewed text.
  return { status: 'refused', code: res.code ?? 'unknown' }
}
