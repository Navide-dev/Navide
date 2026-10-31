import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useApiKeys, type ApiKeyRow } from '../useApiKeys'

const ROW: ApiKeyRow = {
  id: 'k1',
  kind: 'api-key',
  agentKey: 'claude',
  name: 'Project',
  last4: '7F2A',
  monthlyReminderUsd: 50,
  createdAt: 1,
}

function harness(send: (type: string, payload: unknown) => Promise<unknown>) {
  const listeners = new Map<string, (raw: unknown) => void>()
  const unsubscribe = vi.fn()
  const backend = {
    send: vi.fn(send),
    on: (type: string, cb: (raw: unknown) => void) => {
      listeners.set(type, cb)
      return unsubscribe
    },
  }
  const scope = effectScope()
  const api = scope.run(() => useApiKeys(backend as never))!
  return { api, backend, listeners, scope, unsubscribe }
}

describe('useApiKeys', () => {
  it('reads the list from the response payload', async () => {
    const { api } = harness(async () => ({
      ok: true,
      payload: { ok: true, keys: [ROW], supportedAgents: ['claude', 'codex'] },
    }))
    await api.refresh()
    expect(api.keys.value).toEqual([ROW])
    expect(api.keysForAgent('codex')).toEqual([])
    expect(api.supportedAgents.value).toEqual(['claude', 'codex'])
  })

  it('keeps the list when the backend refuses', async () => {
    const { api } = harness(async () => ({ ok: true, payload: { ok: false, error_code: 'main-window-only' } }))
    await api.refresh()
    expect(api.keys.value).toEqual([])
  })

  it('follows api_keys.changed', () => {
    const { api, listeners } = harness(async () => ({ ok: true, payload: {} }))
    listeners.get('api_keys.changed')!({ keys: [ROW], supportedAgents: ['claude'] })
    expect(api.keys.value).toEqual([ROW])
  })

  it('answers with the backend payload', async () => {
    const { api } = harness(async () => ({ ok: true, payload: { ok: false, error_code: 'wrong-vendor' } }))
    expect(await api.create('codex', 'a', 'x', null)).toEqual({ ok: false, error_code: 'wrong-vendor' })
  })

  it('turns a dropped connection into an error answer', async () => {
    const { api } = harness(async () => {
      throw new Error('closed')
    })
    expect(await api.remove('k1')).toEqual({ ok: false, error_code: 'internal-error' })
  })

  it('stops listening when its scope ends', () => {
    const { scope, unsubscribe } = harness(async () => ({ ok: true, payload: {} }))
    scope.stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
