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
    reopen: vi.fn(async () => {}),
    announce: vi.fn(),
  }
  const scope = effectScope()
  scope.run(() => useApiKeyTakeover(backend as never, deps))
  return { fire: (raw: unknown) => listener!(raw), deps, scope, unsubscribe }
}

describe('useApiKeyTakeover', () => {
  it('reopens only the panes this window owns', () => {
    const { fire, deps } = harness()
    fire({ profileId: 'k1', name: 'Project', paneIds: ['p1', 'other-window', 'p2'] })
    expect(deps.reopen.mock.calls).toEqual([['p1', 'k1'], ['p2', 'k1']])
    expect(deps.announce).toHaveBeenCalledWith('Project')
  })

  it('says nothing when none of the panes are here', () => {
    const { fire, deps } = harness()
    fire({ profileId: 'k1', paneIds: ['other-window'] })
    expect(deps.reopen).not.toHaveBeenCalled()
    expect(deps.announce).not.toHaveBeenCalled()
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

  it('stays quiet when the CLI is not spending a key', async () => {
    expect(await run([true, false], false)).not.toHaveBeenCalled()
  })
})
