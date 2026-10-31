import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useApiKeyTakeover } from '../useApiKeyTakeover'

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
