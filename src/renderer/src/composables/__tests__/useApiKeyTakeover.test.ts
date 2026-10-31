import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useApiKeyTakeover, useLoginResetNotice } from '../useApiKeyTakeover'

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

describe('the takeover in App.vue', () => {
  const app = readFileSync(resolve('src/renderer/src/App.vue'), 'latin1')
  const start = app.indexOf('useApiKeyTakeover(backend, {')
  const block = app.slice(start, app.indexOf('useLoginResetNotice(usageVersion', start))

  it('never forces a running pane, so a turn or unsent input survives', () => {
    expect(block).toContain('rebuildPaneViaResume')
    expect(block).not.toContain('forceWhenRunning')
  })

  it('offers continue, since nobody asked for this reopen', () => {
    expect(block).toContain('offerContinue: true')
  })

  it('leaves sign-in panes alone', () => {
    expect(block).toContain('!p.isLogin')
  })
})
