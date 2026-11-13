import { describe, it, expect } from 'vitest'
import { runAgentAccountSwitch, type AgentAccountSwitchAccounts, type AgentAccountSwitchDeps } from '../agentAccountSwitch'
import { createAccountSwitchQueue } from '../accountSwitchQueue'
import { runAgentPaneAccountSwitch, type AgentPaneAccountSwitchDeps } from '../agentPaneAccountSwitch'
import { runAgentSignIn, type AgentSignInDeps } from '../agentSignIn'

// Reproduction for the 0.2.42 Linux VM finding (2026-11-13): an account added
// while the window was open was refused as "unknown-profile" by the window
// answering ui.accounts.switch, until that window reloaded. The refusal is
// decided against the window's cached account list (useCliProfiles), never
// against the backend. These tests pin the fix: a cache miss re-reads the
// list once before refusing, for the CLI-wide switch, the one-pane switch and
// the agent sign-in alike.
function staleAccounts(agentKey: string) {
  const backend: Record<string, { agentKey: string; name: string }> = {
    'p-a': { agentKey, name: 'Account 1' },
    'p-new': { agentKey, name: 'vm-test-b' },
  }
  let cached: Record<string, { agentKey: string; name: string }> = { 'p-a': backend['p-a'] }
  const state = { refreshes: 0 }
  const accounts = {
    findProfile: (id: string | null | undefined) => (id ? cached[id] : undefined),
    defaultProfileId: () => 'p-a',
    aliasFor: () => undefined,
    loginIsGlobal: () => false,
    refresh: async () => { state.refreshes += 1; cached = { ...backend } },
  }
  return { accounts, state }
}

describe('runAgentAccountSwitch with a stale account cache', () => {
  it('re-reads the account list once before answering unknown-profile', async () => {
    const backend: Record<string, { agentKey: string; name: string }> = {
      'p-a': { agentKey: 'codex', name: 'Account 1' },
      'p-new': { agentKey: 'codex', name: 'vm-test-b' },
    }
    // The window's cache was filled before p-new existed.
    let cached: Record<string, { agentKey: string; name: string }> = { 'p-a': backend['p-a'] }
    let refreshes = 0
    const accounts: AgentAccountSwitchAccounts & { refresh: () => Promise<void> } = {
      findProfile: (id) => (id ? cached[id] : undefined),
      defaultProfileId: () => 'p-a',
      aliasFor: () => undefined,
      refresh: async () => { refreshes += 1; cached = { ...backend } },
    }
    const calls: Array<[string, string | null]> = []
    const deps: AgentAccountSwitchDeps = {
      accounts,
      switchAccount: async (agentKey, profileId) => { calls.push([agentKey, profileId]); return { ok: true } },
      busyPanes: async () => 0,
      queue: createAccountSwitchQueue({ setTimer: () => 0, clearTimer: () => undefined }),
      onSettled: () => undefined,
    }

    const outcome = await runAgentAccountSwitch({ agentKey: 'codex', profileId: 'p-new', reason: 'vm test' }, deps)

    expect(refreshes).toBe(1)
    expect(outcome.status).toBe('switched')
    expect(calls).toEqual([['codex', 'p-new']])
  })

  it('still refuses an account the backend does not have either, after one re-read', async () => {
    const { accounts, state } = staleAccounts('codex')
    const deps: AgentAccountSwitchDeps = {
      accounts,
      switchAccount: async () => ({ ok: true }),
      busyPanes: async () => 0,
      queue: createAccountSwitchQueue({ setTimer: () => 0, clearTimer: () => undefined }),
      onSettled: () => undefined,
    }
    const outcome = await runAgentAccountSwitch({ agentKey: 'codex', profileId: 'nope', reason: 'r' }, deps)
    expect(outcome.status).toBe('unknown-profile')
    expect(state.refreshes).toBe(1)
  })
})

describe('runAgentPaneAccountSwitch with a stale account cache', () => {
  it('re-reads the account list once before answering unknown-profile', async () => {
    const { accounts, state } = staleAccounts('claude')
    const moved: Array<[string, string]> = []
    const deps: AgentPaneAccountSwitchDeps = {
      accounts,
      folderAgent: 'claude',
      pane: () => ({ agentKey: 'claude', name: 'worker', isLogin: false, fixed: false, profileId: 'p-a' }),
      dirSignedIn: () => true,
      paneBusy: () => false,
      movePane: async (paneId, profileId) => { moved.push([paneId, profileId]); return undefined },
      queue: createAccountSwitchQueue({ setTimer: () => 0, clearTimer: () => undefined }),
      onSettled: () => undefined,
    }
    const outcome = await runAgentPaneAccountSwitch({ agentKey: 'claude', profileId: 'p-new', paneId: 'pane-1' }, deps)
    expect(state.refreshes).toBe(1)
    expect(outcome.status).toBe('switched-pane')
    expect(moved).toEqual([['pane-1', 'p-new']])
  })
})

describe('runAgentSignIn with a stale account cache', () => {
  it('re-reads the account list once before answering unknown-profile', async () => {
    const { accounts, state } = staleAccounts('codex')
    const spawned: unknown[] = []
    const deps: AgentSignInDeps = {
      accounts,
      currentWorkspace: () => '/ws',
      callerPane: () => ({ workspacePath: '/ws', name: 'smoke-codex' }),
      accountLabel: () => 'vm-test-b',
      confirm: async () => 'confirmed',
      spawn: async (plan) => { spawned.push(plan); return 'login-1' },
      now: () => 0,
    }
    const args = { agentKey: 'codex', profileId: 'p-new', mode: 'isolated', reason: 'r', confirmBy: 60_000 }
    const outcome = await runAgentSignIn(args, 'pa', deps)
    expect(state.refreshes).toBe(1)
    expect(outcome).toEqual({ status: 'started', loginPaneId: 'login-1' })
    expect(spawned).toEqual([{ kind: 'isolated', agentKey: 'codex', profileId: 'p-new' }])
  })
})
