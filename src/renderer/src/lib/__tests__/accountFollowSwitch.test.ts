import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, unknown>())
const listeners = vi.hoisted(() => new Set<(keys: string[]) => void>())
vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback),
  settingsSet: (key: string, value: unknown) => {
    store.set(key, value)
  },
  onSettingsChanged: (cb: (keys: string[]) => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
}))

import {
  ACCOUNT_FOLLOW_SWITCH_SETTING_KEY,
  DEFAULT_SLOT_ID,
  accountFollowSwitchEnabled,
  effectiveAccount,
  followSwitchRows,
  quotaPeerRows,
  quotaSwitchTargets,
  runFollowSwitchBatch,
  setAccountFollowSwitch,
  useAccountFollowSwitchFlag,
  withFollowSwitch,
  type FollowPaneInput,
} from '../accountFollowSwitch'

function pane(over: Partial<FollowPaneInput> & { id: string }): FollowPaneInput {
  return {
    name: over.id,
    agentKey: 'claude',
    realized: true,
    isLogin: false,
    usageLimited: false,
    busy: false,
    canRebuild: true,
    ...over,
  }
}

const signedIn = new Set(['A', 'C', 'T'])
const dirSignedIn = (id: string): boolean => signedIn.has(id)

describe('accountFollowSwitch flag', () => {
  beforeEach(() => store.clear())

  it('is off by default', () => {
    expect(accountFollowSwitchEnabled()).toBe(false)
  })

  it('is on only for an explicit true', () => {
    store.set(ACCOUNT_FOLLOW_SWITCH_SETTING_KEY, 'true')
    expect(accountFollowSwitchEnabled()).toBe(false)
    store.set(ACCOUNT_FOLLOW_SWITCH_SETTING_KEY, true)
    expect(accountFollowSwitchEnabled()).toBe(true)
  })

  it('keeps the reactive copy in step with this window and with other windows', () => {
    const flag = useAccountFollowSwitchFlag()
    setAccountFollowSwitch(true)
    expect(flag.value).toBe(true)
    expect(store.get(ACCOUNT_FOLLOW_SWITCH_SETTING_KEY)).toBe(true)
    store.set(ACCOUNT_FOLLOW_SWITCH_SETTING_KEY, false)
    for (const cb of listeners) cb([ACCOUNT_FOLLOW_SWITCH_SETTING_KEY])
    expect(flag.value).toBe(false)
  })
})

describe('effectiveAccount', () => {
  it('is the pin when that account signed in inside its own dir', () => {
    expect(effectiveAccount('A', 'B', dirSignedIn)).toBe('A')
  })

  it('is the live account for a pin without a dir sign-in', () => {
    expect(effectiveAccount('B', 'X', dirSignedIn)).toBe('X')
  })

  it('is the Default when nothing is pinned and the Default is live', () => {
    expect(effectiveAccount(undefined, null, dirSignedIn)).toBe(DEFAULT_SLOT_ID)
  })
})

describe('followSwitchRows', () => {
  const opts = { targetId: 'T', outgoingId: 'A', dirSignedIn }

  it('lists dir panes on other accounts and pre-checks the outgoing and out-of-quota ones', () => {
    const rows = followSwitchRows(
      [
        pane({ id: 'p1', profileId: 'A' }),
        pane({ id: 'p2', profileId: 'C' }),
        pane({ id: 'p3', profileId: 'C', usageLimited: true }),
        pane({ id: 'p4', profileId: 'A', busy: true }),
      ],
      opts,
    )
    expect(rows.map((r) => [r.paneId, r.state, r.checked])).toEqual([
      ['p1', 'idle', true],
      ['p2', 'idle', false],
      ['p3', 'quota', true],
      ['p4', 'running', true],
    ])
  })

  it('leaves out panes the switch already reached or cannot move', () => {
    const rows = followSwitchRows(
      [
        pane({ id: 'live-pin', profileId: 'B' }), // no dir sign-in: runs on live
        pane({ id: 'unpinned' }),
        pane({ id: 'default', profileId: DEFAULT_SLOT_ID }),
        pane({ id: 'on-target', profileId: 'T' }),
        pane({ id: 'codex', profileId: 'A', agentKey: 'codex' }),
        pane({ id: 'login', profileId: 'A', isLogin: true }),
        pane({ id: 'placeholder', profileId: 'A', realized: false }),
        pane({ id: 'no-session', profileId: 'A', canRebuild: false }),
      ],
      opts,
    )
    expect(rows).toEqual([])
  })

  it('treats a switch to the Default as target __default__', () => {
    const rows = followSwitchRows([pane({ id: 'p1', profileId: 'A' })], {
      targetId: null,
      outgoingId: 'A',
      dirSignedIn,
    })
    expect(rows.map((r) => r.paneId)).toEqual(['p1'])
  })
})

describe('quotaSwitchTargets', () => {
  it('drops the current account and marks only landable accounts eligible', () => {
    const targets = quotaSwitchTargets(
      [
        { id: null, label: 'Default' },
        { id: 'A', label: 'a', remaining: '0%', exhausted: true },
        { id: 'B', label: 'b' },
        { id: 'C', label: 'c', remaining: '80%' },
      ],
      { current: 'A', liveId: 'B', dirSignedIn },
    )
    expect(targets).toEqual([
      { id: DEFAULT_SLOT_ID, label: 'Default', remaining: '', eligible: false, exhausted: false },
      { id: 'B', label: 'b', remaining: '', eligible: true, exhausted: false },
      { id: 'C', label: 'c', remaining: '80%', eligible: true, exhausted: false },
    ])
  })

  it('lets the Default be chosen when it is the live account', () => {
    const targets = quotaSwitchTargets([{ id: null, label: 'Default' }], {
      current: 'A',
      liveId: null,
      dirSignedIn,
    })
    expect(targets[0].eligible).toBe(true)
  })
})

describe('quotaPeerRows', () => {
  it('lists the other out-of-quota panes on the same account', () => {
    const panes = [
      pane({ id: 'self', profileId: 'A', usageLimited: true }),
      pane({ id: 'peer', profileId: 'A', usageLimited: true }),
      pane({ id: 'fine', profileId: 'A' }),
      pane({ id: 'other', profileId: 'C', usageLimited: true }),
    ]
    const rows = quotaPeerRows(panes, 'self', 'A', (p) => effectiveAccount(p.profileId, 'B', dirSignedIn))
    expect(rows.map((r) => r.paneId)).toEqual(['peer'])
  })
})

describe('runFollowSwitchBatch', () => {
  it('rebuilds idle panes first and waits for a running one to finish its turn', async () => {
    const busy = new Set(['run'])
    const order: string[] = []
    let sleeps = 0
    const failures = await runFollowSwitchBatch(['run', 'idle'], {
      isBusy: (id) => busy.has(id),
      rebuild: async (id) => {
        order.push(id)
        return undefined
      },
      sleep: async () => {
        sleeps += 1
        if (sleeps === 2) busy.delete('run')
      },
    })
    expect(order).toEqual(['idle', 'run'])
    expect(sleeps).toBe(2)
    expect(failures).toEqual([])
  })

  it('reports a pane that never goes idle within the timeout without rebuilding it', async () => {
    const rebuild = vi.fn(async () => undefined)
    const failures = await runFollowSwitchBatch(['run'], {
      isBusy: () => true,
      rebuild,
      sleep: async () => {},
      pollMs: 10,
      timeoutMs: 30,
    })
    expect(rebuild).not.toHaveBeenCalled()
    expect(failures).toEqual([{ id: 'run', reason: 'busy' }])
  })

  it('waits again when a pane turned busy at the last moment, and collects failures', async () => {
    let calls = 0
    const failures = await runFollowSwitchBatch(['p', 'q'], {
      isBusy: () => false,
      rebuild: async (id) => {
        if (id === 'q') throw new Error('boom')
        calls += 1
        return calls === 1 ? 'busy' : undefined
      },
      sleep: async () => {},
    })
    expect(calls).toBe(2)
    expect(failures).toEqual([{ id: 'q', reason: 'boom' }])
  })
})

describe('withFollowSwitch', () => {
  function setup(enabled: boolean, result: { ok: boolean; code?: string }) {
    const base = vi.fn(async () => result)
    const outgoing = vi.fn(() => 'A')
    const afterSwitch = vi.fn(async () => {})
    const handler = withFollowSwitch(base, { enabled: () => enabled, outgoing, afterSwitch })
    return { base, outgoing, afterSwitch, handler }
  }

  it('flag off: passes the call straight through and adds nothing', async () => {
    const result = { ok: true }
    const { base, outgoing, afterSwitch, handler } = setup(false, result)
    const res = await handler('claude', 'T')
    expect(res).toBe(result)
    expect(base).toHaveBeenCalledTimes(1)
    expect(base).toHaveBeenCalledWith('claude', 'T')
    expect(outgoing).not.toHaveBeenCalled()
    expect(afterSwitch).not.toHaveBeenCalled()
  })

  it('flag on: offers the follow step after a successful claude switch, with the account it left', async () => {
    const result = { ok: true }
    const { base, afterSwitch, handler } = setup(true, result)
    const res = await handler('claude', 'T')
    expect(res).toBe(result)
    expect(base).toHaveBeenCalledWith('claude', 'T')
    expect(afterSwitch).toHaveBeenCalledWith('claude', 'A', 'T')
  })

  it('flag on: a refused or declined switch moves nothing', async () => {
    const { afterSwitch, handler } = setup(true, { ok: false, code: 'PANES_RUNNING' })
    await handler('claude', 'T')
    expect(afterSwitch).not.toHaveBeenCalled()
  })

  it('flag on: other CLIs are passed straight through', async () => {
    const { outgoing, afterSwitch, handler } = setup(true, { ok: true })
    await handler('codex', 'T')
    expect(outgoing).not.toHaveBeenCalled()
    expect(afterSwitch).not.toHaveBeenCalled()
  })
})
