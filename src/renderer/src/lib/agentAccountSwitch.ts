import type { SetDefaultResult } from '../composables/useCliProfiles'
import type { AccountSwitchQueue, SwitchOutcome } from './accountSwitchQueue'

/**
 * A switch of a CLI account someone other than the user's click asked for —
 * an agent (MCP cli_account_switch) or a chat button — reached through the UI
 * action bus as ui.accounts.switch (plan agent-0-2-42_3f728e).
 *
 * It is the user's own click, without the questions: the window's own switch
 * handler (cliAccountSwitch) runs with the vendor and the account and nothing
 * else — no force, no restoreLive. Where the user's click would ask before
 * restarting running panes, this waits for those panes to go idle instead
 * (accountSwitchQueue) and answers "queued" at once; a changed live login the
 * click would ask about is refused (LIVE_DRIFT), never assumed. The caller
 * hears back a status and account display names only: never an email the
 * user did not use as a name, a credential or a backend message.
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
  | { kind: 'refused'; code: 'bad-request' | 'unknown-profile' | 'already-active' | 'stale'; message: string }

export const DEFAULT_SLOT_ID = '__default__'

/** The name a requester may see for an account: the user's alias or the
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

/** `expectedFrom` (an account id, '__default__' for Default) refuses as
 *  "stale" when the CLI's active account is no longer that one. */
export function planAgentAccountSwitch(
  req: { agentKey: string; profileId: string; expectedFrom?: string | null },
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
  if (req.expectedFrom != null && req.expectedFrom !== (fromId ?? DEFAULT_SLOT_ID)) {
    return { kind: 'refused', code: 'stale', message: `${agentKey} switched account since that request was made; nothing was switched` }
  }
  if (fromId === targetId) {
    return { kind: 'refused', code: 'already-active', message: `${agentKey} already runs on that account; nothing was switched` }
  }
  return { kind: 'switch', agentKey, targetId, fromId }
}

/** Who asked, as the window shows it. */
export interface AccountSwitchRequester {
  source: string
  name: string
}

/** Read `args.requester` (set by the backend, never by an agent). */
export function switchRequester(args: Record<string, unknown>): AccountSwitchRequester | undefined {
  const raw = args.requester as { source?: unknown; name?: unknown } | undefined
  if (!raw || typeof raw !== 'object') return undefined
  const source = String(raw.source ?? '')
  const name = String(raw.name ?? '')
  return source ? { source, name } : undefined
}

/** What runAgentAccountSwitch needs from the main window. */
export interface AgentAccountSwitchDeps {
  accounts: AgentAccountSwitchAccounts
  /** The window's own switch handler (cliAccountSwitch), called with the
   *  vendor, the account, and the unattended hook for running panes. */
  switchAccount: (
    agentKey: string,
    profileId: string | null,
    opts: { unattended: { restartRunning: (count: number) => Promise<boolean> } },
  ) => Promise<SetDefaultResult>
  /** Panes of `agentKey` working now, in EVERY window (the backend's view
   *  joined with this window's): a forced switch restarts them all. */
  busyPanes: (agentKey: string) => Promise<number>
  queue: AccountSwitchQueue
  /** A switch that answered "queued" ended (or was superseded). */
  onSettled: (outcome: SwitchOutcome) => void
}

/** Run a CLI-wide switch now, or queue it behind the busy panes. */
export async function runAgentAccountSwitch(
  args: Record<string, unknown>,
  deps: AgentAccountSwitchDeps,
): Promise<SwitchOutcome> {
  const request = {
    agentKey: String(args.agentKey ?? ''),
    profileId: String(args.profileId ?? ''),
    expectedFrom: typeof args.expectedFrom === 'string' ? args.expectedFrom : null,
  }
  const plan = planAgentAccountSwitch(request, deps.accounts)
  if (plan.kind === 'refused') return { status: plan.code, message: plan.message }
  const key = `agent:${plan.agentKey}`
  // The newest request wins: whatever was parked for this CLI is replaced.
  deps.queue.supersede(key)
  // A queued run switches only from the account the request was made against.
  const fromAtRequest = plan.fromId ?? DEFAULT_SLOT_ID

  const attempt = async (): Promise<SwitchOutcome> => {
    const now = planAgentAccountSwitch({ ...request, expectedFrom: fromAtRequest }, deps.accounts)
    if (now.kind === 'refused') return { status: now.code, message: now.message }
    const from = agentFacingAccountName(deps.accounts, now.agentKey, now.fromId)
    const to = agentFacingAccountName(deps.accounts, now.agentKey, now.targetId)
    let deferred = false
    const res = await deps.switchAccount(now.agentKey, now.targetId, {
      unattended: {
        // The user's click would ask before restarting these; this restarts
        // them only once none of them is working, and otherwise waits.
        restartRunning: async () => {
          if ((await deps.busyPanes(now.agentKey)) === 0) return true
          deferred = true
          return false
        },
      },
    })
    if (res.ok) {
      return { status: res.needsLogin ? 'switched-signed-out' : 'switched', from, to, fromProfileId: fromAtRequest }
    }
    if (deferred && res.code === 'PANES_RUNNING') {
      return { status: 'queued', waiting: Math.max(1, await deps.busyPanes(now.agentKey)), from, to, fromProfileId: fromAtRequest }
    }
    // The code only: a backend message is unreviewed text.
    return { status: 'refused', code: res.code ?? 'unknown' }
  }

  const first = await attempt()
  if (first.status === 'queued') {
    deps.queue.enqueue({
      key,
      waiting: () => deps.busyPanes(plan.agentKey),
      run: attempt,
      settle: deps.onSettled,
      show: { agentKey: plan.agentKey, to: String(first.to ?? ''), waiting: Number(first.waiting ?? 1) },
    })
  }
  return first
}
