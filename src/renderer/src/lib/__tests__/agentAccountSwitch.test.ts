import { describe, it, expect } from 'vitest'
import {
  agentFacingAccountName,
  planAgentAccountSwitch,
  runAgentAccountSwitch,
  type AgentAccountSwitchAccounts,
  type AgentAccountSwitchConfirmRequest,
  type AgentAccountSwitchDeps,
} from '../agentAccountSwitch'
import type { SetDefaultResult } from '../../composables/useCliProfiles'

// Plan mcp_614482 P3: an agent asks the main window to switch a CLI account.
// The window asks the user first (Cancel by default); only their yes calls
// the window's own switch handler, with no force and no other option. A no,
// no answer in time or a withdrawn request switches nothing, and the agent
// hears back a status and account display names only, never an email.
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

  it('does nothing for the account already in use', () => {
    expect(planAgentAccountSwitch({ agentKey: 'claude', profileId: 'p-a' }, accounts()))
      .toMatchObject({ kind: 'refused', code: 'already-active' })
    expect(planAgentAccountSwitch({ agentKey: 'claude', profileId: '__default__' }, accounts({ defaultProfileId: () => null })))
      .toMatchObject({ kind: 'refused', code: 'already-active' })
  })
})

describe('runAgentAccountSwitch', () => {
  const NOW = 1_000_000
  const args = { agentKey: 'claude', profileId: 'p-b', reason: 'quota​ ran out', confirmBy: NOW + 45_000 }
  type Calls = { switched: Array<unknown[]>; asked: AgentAccountSwitchConfirmRequest[] }
  function deps(over: Partial<AgentAccountSwitchDeps> = {}, result: SetDefaultResult = { ok: true }): AgentAccountSwitchDeps & Calls {
    const switched: Array<unknown[]> = []
    const asked: AgentAccountSwitchConfirmRequest[] = []
    return {
      switched,
      asked,
      accounts: accounts(),
      callerPane: (id) => (id === 'pa' ? { name: 'builder', workspacePath: '/ws/alpha' } : undefined),
      accountLabel: (_agentKey, profileId) => `label:${profileId ?? 'default'}`,
      confirm: async (request) => { asked.push(request); return 'confirmed' },
      switchAccount: async (...call) => { switched.push(call); return result },
      now: () => NOW,
      ...over,
    }
  }

  it('asks the user, then switches through the window handler with nothing but the account', async () => {
    const d = deps()
    expect(await runAgentAccountSwitch(args, 'pa', d)).toEqual({ status: 'switched', from: 'Account 1', to: 'Work' })
    expect(d.asked).toEqual([{
      agentKey: 'claude', fromLabel: 'label:p-a', toLabel: 'label:p-b',
      callerPaneId: 'pa', callerName: 'builder', workspacePath: '/ws/alpha',
      reason: 'quota​ ran out', reasonTruncated: false, confirmBy: NOW + 45_000,
    }])
    // Exactly (agentKey, profileId): no force, no restoreLive, no options.
    expect(d.switched).toEqual([['claude', 'p-b']])
  })

  it('switches back to the built-in Default as null', async () => {
    const d = deps()
    expect(await runAgentAccountSwitch({ ...args, profileId: '__default__' }, 'pa', d))
      .toEqual({ status: 'switched', from: 'Account 1', to: 'Default' })
    expect(d.switched).toEqual([['claude', null]])
  })

  for (const [answer, status] of [['declined', 'declined'], ['expired', 'confirm-timeout'], ['busy', 'busy']] as const) {
    it(`switches nothing when the confirmation answers ${answer}`, async () => {
      const d = deps({ confirm: async () => answer })
      expect((await runAgentAccountSwitch(args, 'pa', d)).status).toBe(status)
      expect(d.switched).toEqual([])
    })
  }

  it('never asks without a deadline the backend is still waiting for', async () => {
    for (const confirmBy of [undefined, 'soon', NOW]) {
      const d = deps()
      expect((await runAgentAccountSwitch({ ...args, confirmBy }, 'pa', d)).status).toBe('bad-request')
      expect(d.asked).toEqual([])
    }
  })

  it('refuses a caller that is not a pane of this window, without asking', async () => {
    const d = deps()
    expect((await runAgentAccountSwitch(args, 'gone', d)).status).toBe('unknown-caller')
    expect(d.asked).toEqual([])
  })

  it('refuses what planAgentAccountSwitch refuses, without asking', async () => {
    const d = deps()
    expect((await runAgentAccountSwitch({ ...args, profileId: 'p-a' }, 'pa', d)).status).toBe('already-active')
    expect(d.asked).toEqual([])
  })

  it('hands the request signal to the confirmation', async () => {
    const seen: Array<AbortSignal | undefined> = []
    const d = deps({ confirm: async (_request, signal) => { seen.push(signal); return 'expired' } })
    const controller = new AbortController()
    await runAgentAccountSwitch(args, 'pa', d, controller.signal)
    expect(seen).toEqual([controller.signal])
  })

  it('switches nothing for a yes that lands after the request was withdrawn', async () => {
    const controller = new AbortController()
    const d = deps({ confirm: async () => { controller.abort(); return 'confirmed' } })
    expect((await runAgentAccountSwitch(args, 'pa', d, controller.signal)).status).toBe('confirm-timeout')
    expect(d.switched).toEqual([])
  })

  it('switches nothing when the accounts changed while the user was asked', async () => {
    let active: string | null = 'p-a'
    const d = deps({
      accounts: accounts({ defaultProfileId: () => active }),
      confirm: async () => { active = 'p-b'; return 'confirmed' },
    })
    expect((await runAgentAccountSwitch(args, 'pa', d)).status).toBe('already-active')
    expect(d.switched).toEqual([])
  })

  it('says when the account switched to is signed out', async () => {
    const d = deps({}, { ok: true, needsLogin: true, needsLoginReason: 'expired' })
    expect(await runAgentAccountSwitch(args, 'pa', d)).toEqual({ status: 'switched-signed-out', from: 'Account 1', to: 'Work' })
  })

  it('reports the restart the user declined in the window handler', async () => {
    const d = deps({}, { ok: false, code: 'PANES_RUNNING' })
    expect(await runAgentAccountSwitch(args, 'pa', d)).toEqual({ status: 'restart-declined', code: 'PANES_RUNNING' })
  })

  it('passes on a refusal by its code only, never the message', async () => {
    const d = deps({}, { ok: false, code: 'SWITCH_RATE_LIMITED', message: 'raw backend text' })
    const outcome = await runAgentAccountSwitch(args, 'pa', d)
    expect(outcome).toEqual({ status: 'refused', code: 'SWITCH_RATE_LIMITED' })
    expect(JSON.stringify(outcome)).not.toContain('raw backend text')
  })

  it('passes on that the backend cut the reason', async () => {
    const d = deps()
    await runAgentAccountSwitch({ ...args, reasonTruncated: true }, 'pa', d)
    expect(d.asked[0].reasonTruncated).toBe(true)
  })
})
