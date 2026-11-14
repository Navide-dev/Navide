import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { loginSpent, reopenOnKey, useApiKeyTakeover, useLoginResetNotice } from '../useApiKeyTakeover'
import type { UsageSnapshot, UsageWindow } from '../useUsage'

function harness() {
  let listener: ((raw: unknown) => void) | undefined
  const unsubscribe = vi.fn()
  const backend = {
    on: (type: string, cb: (raw: unknown) => void) => {
      expect(type).toBe('quota_failover.api_key_takeover')
      listener = cb
      return unsubscribe
    },
  }
  const deps = {
    ownsPane: (id: string) => id !== 'other-window',
    reopen: vi.fn(async (_paneId: string, _profileId: string): Promise<unknown> => undefined),
    announce: vi.fn(),
    announceFolderLogin: vi.fn(),
  }
  const scope = effectScope()
  scope.run(() => useApiKeyTakeover(backend as never, deps))
  return { fire: (raw: unknown) => listener!(raw), deps, scope, unsubscribe }
}

describe('useApiKeyTakeover', () => {
  it('reopens only the panes this window owns', async () => {
    const { fire, deps } = harness()
    fire({ profileId: 'k1', name: 'Project', paneIds: ['p1', 'other-window', 'p2'] })
    await vi.waitFor(() => expect(deps.announce).toHaveBeenCalledWith('Project', 0))
    expect(deps.reopen.mock.calls).toEqual([['p1', 'k1'], ['p2', 'k1']])
  })

  it('reopens on a folder login the same way, and does not call it paid', async () => {
    const { fire, deps } = harness()
    deps.reopen.mockImplementation(async (paneId: string) => (paneId === 'p2' ? 'busy' : undefined))
    fire({ profileId: 'w1', name: 'Work', paneIds: ['p1', 'p2'], paid: false })
    await vi.waitFor(() => expect(deps.announceFolderLogin).toHaveBeenCalledWith('Work', 1))
    expect(deps.reopen.mock.calls).toEqual([['p1', 'w1'], ['p2', 'w1']])
    expect(deps.announce).not.toHaveBeenCalled()
  })

  it('counts a busy pane that stayed', async () => {
    const { fire, deps } = harness()
    deps.reopen.mockImplementation(async (paneId: string) => (paneId === 'p2' ? 'busy' : undefined))
    fire({ profileId: 'k1', name: 'Project', paneIds: ['p1', 'p2'] })
    await vi.waitFor(() => expect(deps.announce).toHaveBeenCalledWith('Project', 1))
  })

  it('counts a reopen that threw', async () => {
    const { fire, deps } = harness()
    deps.reopen.mockImplementation(async () => {
      throw new Error('gone')
    })
    fire({ profileId: 'k1', name: 'Project', paneIds: ['p1'] })
    await vi.waitFor(() => expect(deps.announce).toHaveBeenCalledWith('Project', 1))
  })

  it('leaves the telling to the window that owns the panes', async () => {
    const { fire, deps } = harness()
    fire({ profileId: 'k1', paneIds: ['other-window'] })
    await Promise.resolve()
    expect(deps.reopen).not.toHaveBeenCalled()
    expect(deps.announce).not.toHaveBeenCalled()
  })

  it('still says so when no pane moved anywhere', async () => {
    const { fire, deps } = harness()
    fire({ profileId: 'k1', name: 'Project', paneIds: [] })
    await vi.waitFor(() => expect(deps.announce).toHaveBeenCalledWith('Project', 0))
  })

  it('stops listening when its scope ends', () => {
    const { scope, unsubscribe } = harness()
    scope.stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

describe('useLoginResetNotice', () => {
  async function run(readings: (boolean | null)[], spendingKey = true) {
    const version = ref(0)
    const announce = vi.fn()
    let current: boolean | null = null
    const scope = effectScope()
    scope.run(() =>
      useLoginResetNotice(version, {
        agents: ['claude'],
        spendingKey: () => spendingKey,
        logins: () => [null],
        isSpent: () => current,
        announce,
      }),
    )
    for (const reading of readings) {
      current = reading
      version.value += 1
      await nextTick()
    }
    return announce
  }

  it('speaks once when a spent login comes back', async () => {
    expect(await run([true, false, false])).toHaveBeenCalledTimes(1)
  })

  it('stays quiet at start, when the login was never spent', async () => {
    expect(await run([false, false])).not.toHaveBeenCalled()
  })

  it('does not read a missing reading as a reset', async () => {
    expect(await run([true, null])).not.toHaveBeenCalled()
  })

  it('notices a reset by the clock when no new reading arrives', () => {
    vi.useFakeTimers()
    try {
      const version = ref(0)
      const announce = vi.fn()
      let spent = true
      const scope = effectScope()
      scope.run(() =>
        useLoginResetNotice(version, {
          agents: ['codex'],
          spendingKey: () => true,
          logins: () => [null],
          isSpent: () => spent,
          announce,
        }, 1000),
      )
      vi.advanceTimersByTime(1000)
      spent = false
      vi.advanceTimersByTime(1000)
      expect(announce).toHaveBeenCalledWith('codex')
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays quiet when the CLI is not spending a key', async () => {
    expect(await run([true, false], false)).not.toHaveBeenCalled()
  })
})

describe('reopenOnKey', () => {
  function run(readiness: { ready: boolean; reason?: string }) {
    const rebuild = vi.fn(async () => undefined)
    return { rebuild, result: reopenOnKey('p1', 'k1', { readiness: async () => readiness, rebuild }) }
  }

  it.each(['permission-pending', 'input-pending', 'busy'])('leaves a pane that is %s alone', async (reason) => {
    const { rebuild, result } = run({ ready: false, reason })
    expect(await result).toBe(reason)
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('reopens a pane that is ready', async () => {
    const { rebuild, result } = run({ ready: true })
    expect(await result).toBeUndefined()
    expect(rebuild).toHaveBeenCalledWith('p1', 'k1')
  })
})

describe('loginSpent', () => {
  const now = Date.parse('2026-11-01T12:00:00Z')
  const past = '2026-11-01T11:00:00Z'
  const future = '2026-11-03T00:00:00Z'

  function snap(windows: Partial<UsageWindow>[], status = 'ok'): UsageSnapshot {
    return { status, windows } as unknown as UsageSnapshot
  }
  const spent = (kind: string, resetsAt: string | null) => ({ kind, usedPercent: 100, resetsAt, expired: false })

  it('has no answer without a reading', () => {
    expect(loginSpent(undefined, now)).toBeNull()
  })

  it('has no answer for a failed reading, which says nothing about a reset', () => {
    expect(loginSpent(snap([spent('session', past)], 'error'), now)).toBeNull()
  })

  it('stays spent while the weekly window is out, though the session one has reset', () => {
    expect(loginSpent(snap([spent('session', past), spent('weekly', future)]), now)).toBe(true)
  })

  it('stays spent when a reset time is unknown', () => {
    expect(loginSpent(snap([spent('session', null)]), now)).toBe(true)
  })

  it('is back when every spent window has reset', () => {
    expect(loginSpent(snap([spent('session', past), spent('weekly', past)]), now)).toBe(false)
  })

  it('is back when nothing is spent', () => {
    expect(loginSpent(snap([{ kind: 'session', usedPercent: 40, resetsAt: future, expired: false }]), now)).toBe(false)
  })
})

describe('the takeover in App.vue', () => {
  const app = readFileSync(resolve('src/renderer/src/App.vue'), 'latin1')
  const start = app.indexOf('useApiKeyTakeover(backend, {')
  const block = app.slice(start, app.indexOf('useLoginResetNotice(usageVersion', start))

  it('asks the same readiness a quota switch asks, and never forces', () => {
    expect(block).toContain('quotaPaneReadiness(id, { needsResume: false })')
    expect(block).toContain('preserveScrollback: true')
    expect(block).not.toContain('forceWhenRunning')
  })

  it('offers continue, since nobody asked for this reopen', () => {
    expect(block).toContain('offerContinue: true')
  })

  it('leaves sign-in panes alone', () => {
    expect(block).toContain('!p.isLogin')
  })
})
