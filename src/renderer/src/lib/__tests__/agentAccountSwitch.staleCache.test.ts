import { describe, it, expect } from 'vitest'
import { runAgentAccountSwitch, type AgentAccountSwitchAccounts, type AgentAccountSwitchDeps } from '../agentAccountSwitch'
import { createAccountSwitchQueue } from '../accountSwitchQueue'

// Reproduction for the 0.2.42 Linux VM finding (2026-11-13): an account added
// while the window was open was refused as "unknown-profile" by the window
// answering ui.accounts.switch, until that window reloaded. The refusal is
// decided against the window's cached account list (useCliProfiles), never
// against the backend. This test pins the expected behaviour: a cache miss
// re-reads the list once before refusing. It FAILS on origin/main today.
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
})
