import { describe, it, expect, vi } from 'vitest'
import type { AgentAccountSwitchAccounts } from '../agentAccountSwitch'
import {
  planAgentPaneAccountSwitch,
  runAgentPaneAccountSwitch,
  type AgentPaneAccountSwitchDeps,
  type AgentPaneAccountTarget,
} from '../agentPaneAccountSwitch'

// Plan mcp-pane-cli-usage_213031 P4: cli_account_switch with pane_id moves one
// claude pane to another account's own folder, the way the badge's "switch
// only this pane" does. The user is asked first; only their yes reaches the
// window's single-pane move, and nothing here can switch the live login.
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
    callerPane: () => ({ workspacePath: '/ws/alpha', name: 'lead' }),
    accountLabel: (_key, id) => `label:${id}`,
    confirm: vi.fn(async () => 'confirmed' as const),
    movePane: vi.fn(async () => undefined),
    now: () => 1000,
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
  it('asks the user, naming the pane, then moves only that pane', async () => {
    const d = deps()
    const result = await runAgentPaneAccountSwitch(ask(), 'caller', d)
    expect(result).toEqual({ status: 'switched-pane', from: 'Account 13', to: 'Account 14' })
    expect(d.confirm).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: 'claude', paneName: 'follower', fromLabel: 'label:a13', toLabel: 'label:a14', callerName: 'lead',
    }), undefined)
    expect(d.movePane).toHaveBeenCalledWith('follower', 'a14')
  })

  it('moves nothing when the user says no', async () => {
    const d = deps({ confirm: vi.fn(async () => 'declined' as const) })
    expect(await runAgentPaneAccountSwitch(ask(), 'caller', d)).toMatchObject({ status: 'declined' })
    expect(d.movePane).not.toHaveBeenCalled()
  })

  it('refuses before asking when the plan refuses', async () => {
    const d = deps()
    expect(await runAgentPaneAccountSwitch(ask({ profileId: 'nope' }), 'caller', d)).toMatchObject({ status: 'unknown-profile' })
    expect(d.confirm).not.toHaveBeenCalled()
  })

  it('reports a pane the user kept running as restart-declined', async () => {
    const d = deps({ movePane: vi.fn(async () => 'declined') })
    expect(await runAgentPaneAccountSwitch(ask(), 'caller', d)).toEqual({ status: 'restart-declined', code: 'declined' })
  })

  it('passes another move failure on as its code', async () => {
    const d = deps({ movePane: vi.fn(async () => 'spawn-failed') })
    expect(await runAgentPaneAccountSwitch(ask(), 'caller', d)).toEqual({ status: 'refused', code: 'spawn-failed' })
  })
})
