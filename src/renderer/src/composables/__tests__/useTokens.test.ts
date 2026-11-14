import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { TOKENS_NOTICE_REFRESH_MS, useTokens, type TokensSnapshot } from '../useTokens'
import { createMockBackend, withScope, flush } from './mockBackend'

function snapshot(workspacePath: string): TokensSnapshot {
  const bucket = { input: 1, output: 2, calls: 1 }
  return {
    workspace_path: workspacePath,
    workspace: {
      current_run: null,
      runs: [],
      cumulative: { totals: bucket, by_vendor: {}, by_stage: {}, by_group: {} },
      live_by_session: {}
    },
    global: { all_time: bucket, by_vendor: {}, by_day: {} }
  }
}

describe('useTokens', () => {
  it('loads a snapshot on connect', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.snapshot', snapshot('/ws'))
    const wp = ref('/ws')

    const { result, scope } = withScope(() => useTokens(mock.backend, wp))
    await flush()

    expect(mock.sent.some((s) => s.type === 'tokens.snapshot')).toBe(true)
    expect(result.snapshot.value?.workspace_path).toBe('/ws')
    scope.stop()
  })

  it('does NOT fetch while disconnected', async () => {
    const mock = createMockBackend('starting')
    const { result, scope } = withScope(() => useTokens(mock.backend, ref('/ws')))
    await flush()

    expect(mock.sent).toHaveLength(0)
    expect(result.snapshot.value).toBeNull()
    scope.stop()
  })

  it('applies a tokens.changed broadcast for the current workspace', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.snapshot', snapshot('/ws'))
    const { result, scope } = withScope(() => useTokens(mock.backend, ref('/ws')))
    await flush()

    const updated = snapshot('/ws')
    updated.workspace.cumulative.totals.calls = 99
    mock.emit('tokens.changed', updated)
    expect(result.snapshot.value?.workspace.cumulative.totals.calls).toBe(99)
    scope.stop()
  })

  it('drops a tokens.changed broadcast for a sibling workspace', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.snapshot', snapshot('/ws'))
    const { result, scope } = withScope(() => useTokens(mock.backend, ref('/ws')))
    await flush()

    mock.emit('tokens.changed', snapshot('/other'))
    expect(result.snapshot.value?.workspace_path).toBe('/ws')
    scope.stop()
  })

  it('surfaces a backend error', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.snapshot', null, { ok: false, error: { code: 'X', message: 'boom' } })
    const { result, scope } = withScope(() => useTokens(mock.backend, ref('/ws')))
    await flush()

    expect(result.lastError.value).toBe('boom')
    scope.stop()
  })

  it('declares its workspace and follows it', async () => {
    const mock = createMockBackend('connected')
    const wp = ref('/ws')
    const { scope } = withScope(() => useTokens(mock.backend, wp))
    expect(mock.tokenWatches).toEqual(['/ws'])
    wp.value = '/other'
    await flush()
    expect(mock.tokenWatches).toEqual(['/other'])
    scope.stop()
    expect(mock.tokenWatches).toEqual([])
  })

  it('refetches once for a burst of notices about its workspace, without the global history', async () => {
    vi.useFakeTimers()
    try {
      const mock = createMockBackend('connected')
      mock.setResponse('tokens.snapshot', snapshot('/ws'))
      const { result, scope } = withScope(() => useTokens(mock.backend, ref('/ws')))
      await vi.advanceTimersByTimeAsync(0)
      const fetches = () => mock.sent.filter((s) => s.type === 'tokens.snapshot')
      expect(fetches()[0].payload).toEqual({ workspace_path: '/ws', global: 'all_time' })

      const updated = snapshot('/ws')
      updated.workspace.cumulative.totals.calls = 42
      mock.setResponse('tokens.snapshot', updated)
      mock.emit('tokens.notice', { workspace_path: '/other', version: 1 })
      for (let v = 2; v < 12; v++) mock.emit('tokens.notice', { workspace_path: '/ws', version: v })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(fetches()).toHaveLength(2)
      expect(result.snapshot.value?.workspace.cumulative.totals.calls).toBe(42)

      // Another burst within the window waits for it, then fetches once.
      mock.emit('tokens.notice', { workspace_path: '/ws', version: 12 })
      mock.emit('tokens.notice', { workspace_path: '/ws', version: 13 })
      await vi.advanceTimersByTimeAsync(TOKENS_NOTICE_REFRESH_MS / 2)
      expect(fetches()).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(TOKENS_NOTICE_REFRESH_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(fetches()).toHaveLength(3)
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
