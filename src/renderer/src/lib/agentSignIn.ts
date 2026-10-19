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
