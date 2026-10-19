import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createSignInConfirm,
  planAgentSignIn,
  runAgentSignIn,
  type AgentSignInAccounts,
  type AgentSignInConfirmRequest,
  type AgentSignInDeps,
} from '../agentSignIn'

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

// LOW-3 (review #433): an agent's sign-in waits for the user's yes in the main
// window. Declining, the deadline passing, the window moving to another
// workspace or the account becoming the user's own meanwhile opens no pane.
describe('runAgentSignIn', () => {
  const NOW = 1_000_000
  function deps(over: Partial<AgentSignInDeps> = {}): AgentSignInDeps & { spawned: unknown[]; asked: AgentSignInConfirmRequest[] } {
    const spawned: unknown[] = []
    const asked: AgentSignInConfirmRequest[] = []
    return {
      spawned,
      asked,
      accounts: accounts(),
      currentWorkspace: () => '/ws/alpha',
      callerPane: (id) => (id === 'pa' ? { workspacePath: '/ws/alpha', name: 'builder' } : undefined),
      accountLabel: (_agentKey, profileId) => `label:${profileId}`,
      confirm: async (request) => { asked.push(request); return 'confirmed' },
      spawn: async (plan) => { spawned.push(plan); return 'login-1' },
      now: () => NOW,
      ...over,
    }
  }
  const args = { agentKey: 'codex', profileId: 'p-parked', mode: 'isolated', reason: 'quota​ ran out', confirmBy: NOW + 45_000 }

  it('asks the user, then opens the sign-in once they agree', async () => {
    const d = deps()
    expect(await runAgentSignIn(args, 'pa', d)).toEqual({ status: 'started', loginPaneId: 'login-1' })
    expect(d.asked).toEqual([{
      agentKey: 'codex', profileId: 'p-parked', mode: 'isolated', accountLabel: 'label:p-parked',
      callerPaneId: 'pa', callerName: 'builder', workspacePath: '/ws/alpha', reason: 'quota​ ran out',
      confirmBy: NOW + 45_000,
    }])
    expect(d.spawned).toEqual([{ kind: 'isolated', agentKey: 'codex', profileId: 'p-parked' }])
  })

  it('opens nothing when the user declines', async () => {
    const d = deps({ confirm: async () => 'declined' })
    expect((await runAgentSignIn(args, 'pa', d)).status).toBe('declined')
    expect(d.spawned).toEqual([])
  })

  it('opens nothing when the confirmation runs out', async () => {
    const d = deps({ confirm: async () => 'expired' })
    expect((await runAgentSignIn(args, 'pa', d)).status).toBe('confirm-timeout')
    expect(d.spawned).toEqual([])
  })

  it('opens nothing while another agent sign-in is waiting for the user', async () => {
    const d = deps({ confirm: async () => 'busy' })
    expect((await runAgentSignIn(args, 'pa', d)).status).toBe('busy')
    expect(d.spawned).toEqual([])
  })

  it('never asks without a deadline the backend is still waiting for', async () => {
    for (const confirmBy of [undefined, 'soon', NOW]) {
      const d = deps()
      expect((await runAgentSignIn({ ...args, confirmBy }, 'pa', d)).status).toBe('bad-request')
      expect(d.asked).toEqual([])
    }
  })

  it('refuses before asking when the caller is not in the workspace on screen', async () => {
    const d = deps({ currentWorkspace: () => '/ws/beta' })
    expect((await runAgentSignIn(args, 'pa', d)).status).toBe('wrong-workspace')
    const unknown = deps()
    expect((await runAgentSignIn(args, 'gone', unknown)).status).toBe('wrong-workspace')
    expect(d.asked).toEqual([])
    expect(unknown.asked).toEqual([])
  })

  it("opens nothing when the window left the caller's workspace while the user was asked", async () => {
    let shown = '/ws/alpha'
    const d = deps({
      currentWorkspace: () => shown,
      confirm: async () => { shown = '/ws/beta'; return 'confirmed' },
    })
    expect((await runAgentSignIn(args, 'pa', d)).status).toBe('workspace-changed')
    expect(d.spawned).toEqual([])
  })

  it('opens nothing when the account became the active one while the user was asked', async () => {
    let active: string | null = null
    const d = deps({
      accounts: accounts({ defaultProfileId: () => active }),
      confirm: async () => { active = 'p-parked'; return 'confirmed' },
    })
    expect((await runAgentSignIn(args, 'pa', d)).status).toBe('needs-user')
    expect(d.spawned).toEqual([])
  })

  it('refuses what planAgentSignIn refuses without asking', async () => {
    const d = deps()
    expect((await runAgentSignIn({ ...args, profileId: 'p-active' }, 'pa', d)).status).toBe('needs-user')
    expect(d.asked).toEqual([])
  })

  it('reports a sign-in pane that did not start', async () => {
    const d = deps({ spawn: async () => undefined })
    expect((await runAgentSignIn(args, 'pa', d)).status).toBe('spawn-failed')
  })
})

describe('createSignInConfirm', () => {
  afterEach(() => { vi.useRealTimers() })
  const request = (confirmBy: number): AgentSignInConfirmRequest => ({
    agentKey: 'codex', profileId: 'p-parked', mode: 'isolated', accountLabel: 'Work', callerPaneId: 'pa',
    callerName: 'builder', workspacePath: '/ws/alpha', reason: 'r', confirmBy,
  })

  it('holds the request until the user answers', async () => {
    const gate = createSignInConfirm()
    const answer = gate.ask(request(Date.now() + 45_000))
    expect(gate.pending.value?.profileId).toBe('p-parked')
    gate.answer(true)
    expect(await answer).toBe('confirmed')
    expect(gate.pending.value).toBeNull()
  })

  it('takes a no as declined', async () => {
    const gate = createSignInConfirm()
    const answer = gate.ask(request(Date.now() + 45_000))
    gate.answer(false)
    expect(await answer).toBe('declined')
  })

  it('closes itself at the deadline, and a late yes changes nothing', async () => {
    vi.useFakeTimers()
    const gate = createSignInConfirm()
    const answer = gate.ask(request(Date.now() + 45_000))
    vi.advanceTimersByTime(45_000)
    expect(await answer).toBe('expired')
    expect(gate.pending.value).toBeNull()
    gate.answer(true)
    expect(await answer).toBe('expired')
  })

  it('asks one at a time', async () => {
    const gate = createSignInConfirm()
    const first = gate.ask(request(Date.now() + 45_000))
    expect(await gate.ask(request(Date.now() + 45_000))).toBe('busy')
    gate.answer(false)
    expect(await first).toBe('declined')
  })
})
