import { describe, it, expect } from 'vitest'
import {
  agentFacingAccountName,
  planAgentAccountSwitch,
  runAgentAccountSwitch,
  switchRequester,
  type AgentAccountSwitchAccounts,
  type AgentAccountSwitchDeps,
} from '../agentAccountSwitch'
import { createAccountSwitchQueue } from '../accountSwitchQueue'
import type { SetDefaultResult } from '../../composables/useCliProfiles'

// Plan agent-0-2-42_3f728e: an agent (or a chat button) switches a CLI
// account through the window's own switch handler, with nothing asked. Where
// the user's click would ask before restarting running panes, the switch
// waits for them to be idle; the requester hears back a status and account
// display names only, never an email.
function accounts(over: Partial<AgentAccountSwitchAccounts> = {}): AgentAccountSwitchAccounts {
  const profiles: Record<string, { agentKey: string; name: string; nameIsCustom?: boolean }> = {
    'p-a': { agentKey: 'claude', name: 'Account 1' },
    'p-b': { agentKey: 'claude', name: 'Work', nameIsCustom: true },
    'p-c': { agentKey: 'codex', name: 'Account 1' },
  }
  return {
    findProfile: (id) => (id ? profiles[id] : undefined),
    defaultProfileId: () => 'p-a',
    aliasFor: (_agentKey, id) => (id && profiles[id]?.nameIsCustom ? profiles[id].name : undefined),
    ...over,
  }
}

describe('agentFacingAccountName', () => {
  it('names an account by the alias or its given name, never by email', () => {
    expect(agentFacingAccountName(accounts(), 'claude', 'p-b')).toBe('Work')
    expect(agentFacingAccountName(accounts(), 'claude', 'p-a')).toBe('Account 1')
    expect(agentFacingAccountName(accounts(), 'claude', null)).toBe('Default')
    expect(agentFacingAccountName(accounts({ aliasFor: () => 'Personal' }), 'claude', null)).toBe('Personal')
  })
})

describe('planAgentAccountSwitch', () => {
  it('switches to another account of the same vendor', () => {
    expect(planAgentAccountSwitch({ agentKey: 'claude', profileId: 'p-b' }, accounts()))
      .toEqual({ kind: 'switch', agentKey: 'claude', targetId: 'p-b', fromId: 'p-a' })
  })

  it('takes "__default__" as the built-in Default', () => {
    expect(planAgentAccountSwitch({ agentKey: 'claude', profileId: '__default__' }, accounts()))
      .toEqual({ kind: 'switch', agentKey: 'claude', targetId: null, fromId: 'p-a' })
  })

  it('refuses an account of another vendor or one that does not exist', () => {
    expect(planAgentAccountSwitch({ agentKey: 'claude', profileId: 'p-c' }, accounts()))
      .toMatchObject({ kind: 'refused', code: 'unknown-profile' })
    expect(planAgentAccountSwitch({ agentKey: 'claude', profileId: 'nope' }, accounts()))
      .toMatchObject({ kind: 'refused', code: 'unknown-profile' })
    expect(planAgentAccountSwitch({ agentKey: '', profileId: 'p-a' }, accounts()))
      .toMatchObject({ kind: 'refused', code: 'bad-request' })
  })

  it('refuses as stale when the active account is not the one expected', () => {
    expect(planAgentAccountSwitch({ agentKey: 'claude', profileId: 'p-b', expectedFrom: 'p-c' }, accounts()))
      .toMatchObject({ kind: 'refused', code: 'stale' })
    expect(planAgentAccountSwitch({ agentKey: 'claude', profileId: 'p-b', expectedFrom: 'p-a' }, accounts()))
      .toMatchObject({ kind: 'switch' })
    expect(planAgentAccountSwitch({ agentKey: 'claude', profileId: 'p-b', expectedFrom: '__default__' }, accounts({ defaultProfileId: () => null })))
      .toMatchObject({ kind: 'switch' })
  })

  it('does nothing for the account already in use', () => {
    expect(planAgentAccountSwitch({ agentKey: 'claude', profileId: 'p-a' }, accounts()))
      .toMatchObject({ kind: 'refused', code: 'already-active' })
    expect(planAgentAccountSwitch({ agentKey: 'claude', profileId: '__default__' }, accounts({ defaultProfileId: () => null })))
      .toMatchObject({ kind: 'refused', code: 'already-active' })
  })
})

describe('switchRequester', () => {
  it('reads the backend-set requester, or nothing', () => {
    expect(switchRequester({ requester: { source: 'telegram', name: 'Telegram @me' } })).toEqual({ source: 'telegram', name: 'Telegram @me' })
    expect(switchRequester({})).toBeUndefined()
    expect(switchRequester({ requester: { name: 'x' } })).toBeUndefined()
  })
})

describe('runAgentAccountSwitch', () => {
  function deps(over: { result?: SetDefaultResult; busy?: number } = {}) {
    const calls: Array<[string, string | null]> = []
    const settled: Array<Record<string, unknown>> = []
    let busy = over.busy ?? 0
    const queue = createAccountSwitchQueue({ setTimer: () => 0, clearTimer: () => undefined })
    const d: AgentAccountSwitchDeps = {
      accounts: accounts(),
      switchAccount: async (agentKey, profileId, opts) => {
        calls.push([agentKey, profileId])
        if (over.result) return over.result
        // The handler's PANES_RUNNING branch: the unattended hook answers.
        return (await opts.unattended.restartRunning(1)) ? { ok: true } : { ok: false, code: 'PANES_RUNNING' }
      },
      busyPanes: () => busy,
      queue,
      onSettled: (outcome) => settled.push(outcome),
    }
    return { d, calls, settled, queue, setBusy: (n: number) => { busy = n } }
  }
  const args = { agentKey: 'claude', profileId: 'p-b', reason: 'quota ran out' }

  it('switches at once with the vendor and the account only', async () => {
    const { d, calls } = deps()
    expect(await runAgentAccountSwitch(args, d)).toEqual({ status: 'switched', from: 'Account 1', to: 'Work', fromProfileId: 'p-a' })
    expect(calls).toEqual([['claude', 'p-b']])
  })

  it('reports a switch onto an account with no usable sign-in', async () => {
    const { d } = deps({ result: { ok: true, needsLogin: true } })
    expect((await runAgentAccountSwitch(args, d)).status).toBe('switched-signed-out')
  })

  it('passes a refusal on as its code only', async () => {
    const { d } = deps({ result: { ok: false, code: 'LIVE_DRIFT', message: 'secret detail' } })
    expect(await runAgentAccountSwitch(args, d)).toEqual({ status: 'refused', code: 'LIVE_DRIFT' })
  })

  it('refuses what the plan refuses, without switching', async () => {
    const { d, calls } = deps()
    expect((await runAgentAccountSwitch({ ...args, profileId: 'p-a' }, d)).status).toBe('already-active')
    expect((await runAgentAccountSwitch({ ...args, expectedFrom: 'p-c' }, d)).status).toBe('stale')
    expect(calls).toEqual([])
  })

  it('queues behind busy panes and runs once they are idle', async () => {
    const { d, calls, settled, queue, setBusy } = deps({ busy: 2 })
    expect(await runAgentAccountSwitch(args, d)).toMatchObject({ status: 'queued', waiting: 2 })
    expect(queue.size).toBe(1)
    await queue.tick()
    expect(calls.length).toBe(1)
    setBusy(0)
    await queue.tick()
    expect(calls.length).toBe(2)
    expect(settled).toEqual([{ status: 'switched', from: 'Account 1', to: 'Work', fromProfileId: 'p-a' }])
    expect(queue.size).toBe(0)
  })
})
