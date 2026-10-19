import { describe, it, expect } from 'vitest'
import { planAgentSignIn, type AgentSignInAccounts } from '../agentSignIn'

// An agent may only open the sign-ins Settings → Accounts already offers that
// move no credential the user is running on: an isolated sign-in for a parked
// account, or a claude sign-in inside an account's own folder. Everything else
// — the active account, the built-in Default, a vendor whose sign-in replaces
// the live credential — is the user's to start.
function accounts(over: Partial<AgentSignInAccounts> = {}): AgentSignInAccounts {
  const profiles: Record<string, { agentKey: string }> = {
    'p-active': { agentKey: 'codex' },
    'p-parked': { agentKey: 'codex' },
    'c-parked': { agentKey: 'claude' },
    'k-parked': { agentKey: 'kimi' },
  }
  return {
    findProfile: (id) => (id ? profiles[id] : undefined),
    defaultProfileId: (agentKey) => (agentKey === 'codex' ? 'p-active' : null),
    loginIsGlobal: (agentKey) => agentKey === 'kimi',
    ...over,
  }
}

describe('planAgentSignIn', () => {
  it('opens an isolated sign-in for a parked account', () => {
    expect(planAgentSignIn({ agentKey: 'codex', profileId: 'p-parked', mode: 'isolated' }, accounts()))
      .toEqual({ kind: 'isolated', agentKey: 'codex', profileId: 'p-parked' })
  })

  it('opens a claude sign-in inside an account folder', () => {
    expect(planAgentSignIn({ agentKey: 'claude', profileId: 'c-parked', mode: 'folder' }, accounts()))
      .toEqual({ kind: 'folder', profileId: 'c-parked' })
  })

  it('leaves the active account to the user', () => {
    expect(planAgentSignIn({ agentKey: 'codex', profileId: 'p-active', mode: 'isolated' }, accounts()))
      .toMatchObject({ kind: 'refused', code: 'needs-user' })
  })

  it('leaves the built-in Default to the user', () => {
    expect(planAgentSignIn({ agentKey: 'codex', profileId: '__default__', mode: 'isolated' }, accounts()))
      .toMatchObject({ kind: 'refused', code: 'needs-user' })
  })

  it('leaves a vendor whose sign-in replaces the live credential to the user', () => {
    expect(planAgentSignIn({ agentKey: 'kimi', profileId: 'k-parked', mode: 'isolated' }, accounts()))
      .toMatchObject({ kind: 'refused', code: 'needs-user' })
  })

  it('refuses an account of another vendor or none at all', () => {
    expect(planAgentSignIn({ agentKey: 'claude', profileId: 'p-parked', mode: 'isolated' }, accounts()))
      .toMatchObject({ kind: 'refused', code: 'unknown-profile' })
    expect(planAgentSignIn({ agentKey: 'codex', profileId: 'nope', mode: 'isolated' }, accounts()))
      .toMatchObject({ kind: 'refused', code: 'unknown-profile' })
  })

  it('leaves the active account to the user in folder mode too', () => {
    const active = accounts({ defaultProfileId: (agentKey) => (agentKey === 'claude' ? 'c-parked' : null) })
    expect(planAgentSignIn({ agentKey: 'claude', profileId: 'c-parked', mode: 'folder' }, active))
      .toMatchObject({ kind: 'refused', code: 'needs-user' })
  })

  it('offers folder sign-in for claude only', () => {
    expect(planAgentSignIn({ agentKey: 'codex', profileId: 'p-parked', mode: 'folder' }, accounts()))
      .toMatchObject({ kind: 'refused', code: 'unsupported' })
  })

  it('refuses an unknown mode', () => {
    expect(planAgentSignIn({ agentKey: 'codex', profileId: 'p-parked', mode: 'live' as never }, accounts()))
      .toMatchObject({ kind: 'refused', code: 'bad-request' })
  })
})
