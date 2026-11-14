import { describe, it, expect, vi } from 'vitest'
import type { AgentAccountSwitchAccounts } from '../agentAccountSwitch'
import {
  planAgentPaneAccountSwitch,
  runAgentPaneAccountSwitch,
  type AgentPaneAccountSwitchDeps,
  type AgentPaneAccountTarget,
} from '../agentPaneAccountSwitch'
import { createAccountSwitchQueue } from '../accountSwitchQueue'

// Plan mcp-pane-cli-usage_213031 P4: cli_account_switch with pane_id moves one
// claude pane to another account's own folder, the way the badge's "switch
// only this pane" does. Nothing asks the user (plan agent-0-2-42_3f728e): an
// idle pane moves at once, a working one once its turn ends, and nothing here
// can switch the live login.
function accounts(): AgentAccountSwitchAccounts {
  const profiles: Record<string, { agentKey: string; name: string }> = {
    a13: { agentKey: 'claude', name: 'Account 13' },
    a14: { agentKey: 'claude', name: 'Account 14' },
    c1: { agentKey: 'codex', name: 'Codex' },
  }
  return {
    findProfile: (id) => (id ? profiles[id] : undefined),
    defaultProfileId: () => 'a13',
    aliasFor: () => undefined,
  }
}

const panes: Record<string, AgentPaneAccountTarget> = {
  follower: { agentKey: 'claude', name: 'follower', isLogin: false, fixed: false, profileId: 'a13' },
  fixed: { agentKey: 'claude', name: 'fixed', isLogin: false, fixed: true, profileId: 'a14' },
  login: { agentKey: 'claude', name: 'login', isLogin: true, fixed: false, profileId: 'a13' },
  coder: { agentKey: 'codex', name: 'coder', isLogin: false, fixed: false, profileId: 'c1' },
}

function deps(over: Partial<AgentPaneAccountSwitchDeps> = {}): AgentPaneAccountSwitchDeps {
  return {
    accounts: accounts(),
    folderAgent: 'claude',
    pane: (id) => panes[id],
    dirSignedIn: (id) => id === 'a14',
    paneBusy: () => false,
    movePane: vi.fn(async () => undefined),
    queue: createAccountSwitchQueue({ setTimer: () => 0, clearTimer: () => undefined }),
    onSettled: vi.fn(),
    ...over,
  }
}

const ask = (over: Record<string, unknown> = {}) => ({
  agentKey: 'claude', profileId: 'a14', paneId: 'follower', reason: 'use 14', confirmBy: 5000, ...over,
})

describe('planAgentPaneAccountSwitch', () => {
  it('moves a following or fixed claude pane to a signed-in account folder', () => {
    expect(planAgentPaneAccountSwitch({ agentKey: 'claude', profileId: 'a14', paneId: 'follower' }, deps()))
      .toEqual({ kind: 'move', agentKey: 'claude', paneId: 'follower', paneName: 'follower', targetId: 'a14', fromId: 'a13' })
  })

  it.each([
    [{ agentKey: 'claude', profileId: 'a14', paneId: '' }, 'bad-request'],
    [{ agentKey: 'codex', profileId: 'c1', paneId: 'coder' }, 'unsupported'],
    [{ agentKey: 'claude', profileId: 'a14', paneId: 'missing' }, 'unknown-pane'],
    [{ agentKey: 'claude', profileId: 'a14', paneId: 'login' }, 'unknown-pane'],
    [{ agentKey: 'claude', profileId: '__default__', paneId: 'follower' }, 'unsupported'],
    [{ agentKey: 'claude', profileId: 'c1', paneId: 'follower' }, 'unknown-profile'],
    [{ agentKey: 'claude', profileId: 'a14', paneId: 'fixed' }, 'already-active'],
    [{ agentKey: 'claude', profileId: 'a13', paneId: 'fixed' }, 'needs-user'],
  ])('refuses %j with %s', (req, code) => {
    expect(planAgentPaneAccountSwitch(req, deps())).toMatchObject({ kind: 'refused', code })
  })
})

describe('runAgentPaneAccountSwitch', () => {
  const args = { agentKey: 'claude', profileId: 'a14', paneId: 'follower', reason: 'use 14' }

  it('moves only that pane at once when it is idle', async () => {
    const d = deps()
    expect(await runAgentPaneAccountSwitch(args, d)).toEqual({
      status: 'switched-pane', from: 'Account 13', to: 'Account 14', paneName: 'follower', fromProfileId: 'a13',
    })
    expect(d.movePane).toHaveBeenCalledWith('follower', 'a14')
  })

  it('refuses what the plan refuses, without moving', async () => {
    const d = deps()
    expect((await runAgentPaneAccountSwitch({ ...args, paneId: 'coder', agentKey: 'codex' }, d)).status).toBe('unsupported')
    expect(d.movePane).not.toHaveBeenCalled()
  })

  it('queues a working pane and moves it once idle', async () => {
    let busy = true
    const d = deps({ paneBusy: () => busy })
    expect(await runAgentPaneAccountSwitch(args, d)).toMatchObject({ status: 'queued', waiting: 1 })
    expect(d.movePane).not.toHaveBeenCalled()
    await d.queue.tick()
    expect(d.movePane).not.toHaveBeenCalled()
    busy = false
    await d.queue.tick()
    expect(d.movePane).toHaveBeenCalledWith('follower', 'a14')
    expect(d.onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'switched-pane' }))
  })

  it('keeps waiting when the pane got busy between the check and the move', async () => {
    const d = deps({ movePane: vi.fn(async () => 'busy') })
    expect((await runAgentPaneAccountSwitch(args, d)).status).toBe('queued')
    expect(d.queue.size).toBe(1)
  })

  it('passes another move failure on as its code', async () => {
    const d = deps({ movePane: vi.fn(async () => 'spawn-failed') })
    expect(await runAgentPaneAccountSwitch(args, d)).toEqual({ status: 'refused', code: 'spawn-failed' })
  })
})
