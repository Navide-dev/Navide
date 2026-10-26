import { shallowRef, type ShallowRef } from 'vue'

/**
 * Which sign-in an agent may open for an account (MCP cli_account_sign_in,
 * reached through the UI action bus as ui.accounts.signIn).
 *
 * Only the sign-ins Settings → Accounts already offers that move no credential
 * the user is running on: an isolated sign-in for a parked account (it lands in
 * that account's own slot), or a claude sign-in inside an account's own folder.
 * The active account, the built-in Default and a vendor whose sign-in replaces
 * the live credential while it runs are left to the user — Settings asks them
 * first, or switches accounts first, and an agent must do neither.
 */

export type AgentSignInMode = 'isolated' | 'folder'

/** Why a message, a chat line or a key press addressed to a CLI sign-in pane
 *  is refused (backend error_code login-pane-input-refused): only the user
 *  types into one, or an agent could finish the sign-in on its own account. */
export const SIGN_IN_PANE_INPUT_REFUSAL =
  'only the user types into a CLI sign-in pane (login-pane-input-refused)'

export interface AgentSignInRequest {
  agentKey: string
  profileId: string
  mode: AgentSignInMode
}

/** The slice of useCliProfiles this needs (cached state, no backend call). */
export interface AgentSignInAccounts {
  findProfile: (id: string | null | undefined) => { agentKey: string } | undefined
  defaultProfileId: (agentKey: string) => string | null
  loginIsGlobal: (agentKey: string) => boolean
}

export type AgentSignInPlan =
  | { kind: 'isolated'; agentKey: string; profileId: string }
  | { kind: 'folder'; profileId: string }
  | {
      kind: 'refused'
      code: 'bad-request' | 'unknown-profile' | 'unsupported' | 'needs-user'
      message: string
    }

const DEFAULT_SLOT_ID = '__default__'
/** Claude Code is the CLI that keeps a login inside an account's own config dir. */
const FOLDER_SIGN_IN_AGENT = 'claude'

export function planAgentSignIn(req: AgentSignInRequest, accounts: AgentSignInAccounts): AgentSignInPlan {
  const { agentKey, profileId, mode } = req
  if (mode !== 'isolated' && mode !== 'folder') {
    return { kind: 'refused', code: 'bad-request', message: `mode must be "isolated" or "folder" (got ${JSON.stringify(mode)})` }
  }
  if (profileId === DEFAULT_SLOT_ID) {
    return {
      kind: 'refused',
      code: 'needs-user',
      message: 'the built-in Default account signs in on the live login; the user starts that in Settings → Accounts',
    }
  }
  const profile = accounts.findProfile(profileId)
  if (!profile || profile.agentKey !== agentKey) {
    return { kind: 'refused', code: 'unknown-profile', message: `no ${agentKey} account "${profileId}" in Settings → Accounts` }
  }
  if (mode === 'folder' && agentKey !== FOLDER_SIGN_IN_AGENT) {
    return { kind: 'refused', code: 'unsupported', message: `signing in inside an account folder is offered for ${FOLDER_SIGN_IN_AGENT} only` }
  }
  // Before either mode: the account the user runs on is theirs to sign in.
  if (accounts.defaultProfileId(agentKey) === profileId) {
    return {
      kind: 'refused',
      code: 'needs-user',
      message: 'the active account is the one the user runs on; the user signs it in from Settings → Accounts',
    }
  }
  if (mode === 'folder') return { kind: 'folder', profileId }
  if (accounts.loginIsGlobal(agentKey)) {
    return {
      kind: 'refused',
      code: 'needs-user',
      message: `a ${agentKey} sign-in replaces the live credential while it runs; the user starts that in Settings → Accounts`,
    }
  }
  return { kind: 'isolated', agentKey, profileId }
}

/** What the main window shows the user before an agent's sign-in starts
 *  (review #433 LOW-3). `reason` is the agent's own text. */
export interface AgentSignInConfirmRequest {
  agentKey: string
  profileId: string
  mode: AgentSignInMode
  accountLabel: string
  callerPaneId: string
  callerName: string
  /** Where the sign-in pane opens: the calling pane's workspace. */
  workspacePath: string
  reason: string
  /** The backend cut the reason to its length cap; the dialog says so. */
  reasonTruncated: boolean
  /** Epoch ms after which a yes no longer counts (the backend's deadline). */
  confirmBy: number
}

export type AgentSignInConfirmAnswer = 'confirmed' | 'declined' | 'expired' | 'busy'

/** One agent sign-in waiting for the user at a time: `pending` is what the
 *  dialog shows, `answer` is the user's click. The request closes itself at
 *  its deadline, or when `signal` aborts (the backend withdrew it or the
 *  window lost the backend), and an answer after that changes nothing.
 *  Also holds an agent's account switch (lib/agentAccountSwitch). */
export function createSignInConfirm<T extends { confirmBy: number } = AgentSignInConfirmRequest>(): {
  pending: Readonly<ShallowRef<T | null>>
  ask: (request: T, signal?: AbortSignal) => Promise<AgentSignInConfirmAnswer>
  answer: (confirmed: boolean) => void
} {
  // Annotated, not inferred: shallowRef's overloads do not resolve for a generic T.
  const pending: ShallowRef<T | null> = shallowRef(null)
  let settle: ((answer: AgentSignInConfirmAnswer) => void) | null = null

  function ask(request: T, signal?: AbortSignal): Promise<AgentSignInConfirmAnswer> {
    if (signal?.aborted) return Promise.resolve('expired')
    if (pending.value) return Promise.resolve('busy')
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish('expired'), Math.max(0, request.confirmBy - Date.now()))
      const onAbort = (): void => { if (settle === mine) finish('expired') }
      const mine = (answer: AgentSignInConfirmAnswer): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(answer)
      }
      settle = mine
      signal?.addEventListener('abort', onAbort)
      pending.value = request
    })
  }

  function finish(answer: AgentSignInConfirmAnswer): void {
    const done = settle
    settle = null
    pending.value = null
    done?.(answer)
  }

  return { pending, ask, answer: (confirmed) => finish(confirmed ? 'confirmed' : 'declined') }
}

/** What runAgentSignIn needs from the main window. */
export interface AgentSignInDeps {
  accounts: AgentSignInAccounts
  currentWorkspace: () => string | null
  callerPane: (paneId: string) => { workspacePath: string; name: string } | undefined
  accountLabel: (agentKey: string, profileId: string) => string
  confirm: (request: AgentSignInConfirmRequest, signal?: AbortSignal) => Promise<AgentSignInConfirmAnswer>
  /** Opens the sign-in pane the way Settings → Accounts does; the new pane's
   *  id, or undefined when none started. */
  spawn: (plan: Exclude<AgentSignInPlan, { kind: 'refused' }>) => Promise<string | undefined>
  now: () => number
}

const CONFIRM_REFUSALS: Record<Exclude<AgentSignInConfirmAnswer, 'confirmed'>, { status: string; message: string }> = {
  declined: { status: 'declined', message: 'the user declined the sign-in' },
  expired: { status: 'confirm-timeout', message: 'the user did not answer the sign-in confirmation in time' },
  busy: { status: 'busy', message: "another agent's sign-in is waiting for the user; ask again later" },
}

/** MCP cli_account_sign_in in the main window: refuse what planAgentSignIn
 *  refuses, ask the user, and open the sign-in pane in the caller's own
 *  workspace only on their yes — checked again after they answer, since the
 *  window or the accounts may have changed while they were asked. */
export async function runAgentSignIn(
  args: Record<string, unknown>,
  callerPaneId: string,
  deps: AgentSignInDeps,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const agentKey = String(args.agentKey ?? '')
  const profileId = String(args.profileId ?? '')
  const mode = args.mode as AgentSignInMode
  const request = { agentKey, profileId, mode }
  const plan = planAgentSignIn(request, deps.accounts)
  if (plan.kind === 'refused') return { status: plan.code, message: plan.message }
  const confirmBy = typeof args.confirmBy === 'number' ? args.confirmBy : NaN
  if (!Number.isFinite(confirmBy) || confirmBy <= deps.now()) {
    return { status: 'bad-request', message: 'the sign-in request carries no confirmation deadline still open' }
  }
  const workspace = deps.currentWorkspace()
  if (!workspace) return { status: 'no-workspace', message: 'this window has no workspace open to start a sign-in pane in' }
  const caller = deps.callerPane(callerPaneId)
  if (!caller || caller.workspacePath !== workspace) {
    return { status: 'wrong-workspace', message: "the sign-in pane opens in the caller's workspace, which this window is not showing" }
  }

  const answer = await deps.confirm({
    ...request,
    accountLabel: deps.accountLabel(agentKey, profileId),
    callerPaneId,
    callerName: caller.name,
    workspacePath: caller.workspacePath,
    reason: String(args.reason ?? ''),
    reasonTruncated: args.reasonTruncated === true,
    confirmBy,
  }, signal)
  // A yes for a request the backend withdrew meanwhile is a lapsed one.
  if (answer !== 'confirmed' || signal?.aborted) return CONFIRM_REFUSALS[answer === 'confirmed' ? 'expired' : answer]

  if (deps.currentWorkspace() !== caller.workspacePath) {
    return { status: 'workspace-changed', message: "the window left the caller's workspace while the user was asked; nothing was opened" }
  }
  const now = planAgentSignIn(request, deps.accounts)
  if (now.kind === 'refused') return { status: now.code, message: now.message }
  const loginPaneId = await deps.spawn(now)
  if (!loginPaneId) return { status: 'spawn-failed', message: 'the sign-in pane did not start' }
  return { status: 'started', loginPaneId }
}
