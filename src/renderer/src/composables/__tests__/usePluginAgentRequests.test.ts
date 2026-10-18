// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECOVERY_GRACE_MS, usePluginAgentRequests } from '../usePluginAgentRequests'
import { reconnectDelayMs, WS_RECONNECT_BASE_MS } from '../../../../shared/wsClient'

describe('usePluginAgentRequests', () => {
  afterEach(() => {
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  it('mints the finish confirmation for the approval_id and the status it reports', async () => {
    const trustConfirm = vi.fn(async () => ({ nonce: 'n', expires: '1', mac: 'm' }))
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { trustConfirm }
    const send = vi.fn(async () => ({ ok: true, payload: {} }))
    const requests = usePluginAgentRequests({ send } as never)
    await requests.finish('abc', { status: 'failed', error: 'interrupted' })
    expect(trustConfirm).toHaveBeenCalledWith('plugins.agent_request.finish', '', 'abc:failed')
    expect(send).toHaveBeenCalledWith('plugins.agent_request.finish', {
      approval_id: 'abc', status: 'failed', error: 'interrupted', confirmation: { nonce: 'n', expires: '1', mac: 'm' },
    })
  })

  it('recovers only what no open main window is carrying out', async () => {
    const trustConfirm = vi.fn(async () => ({ nonce: 'n', expires: '1', mac: 'm' }))
    const listInstalled = vi.fn(async () => [])
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { trustConfirm, plugins: { listInstalled } }
    const target = { id: 'a.b', namespace: 'a', name: 'b', version: '1.0.0', fromVersion: null }
    const send = vi.fn(async (type: string, _payload?: unknown) => type === 'plugins.agent_requests.list'
      ? {
          ok: true,
          payload: {
            requests: [
              { approval_id: 'live', kind: 'plugin-install', status: 'applying', target },
              { approval_id: 'gone', kind: 'plugin-install', status: 'applying', target },
            ],
            applyingInLiveWindow: ['live'],
          },
        }
      : { ok: true, payload: {} })
    await usePluginAgentRequests({ send } as never).recover(0)
    const finished = send.mock.calls.filter(([type]) => type === 'plugins.agent_request.finish')
    expect(finished.map(([, payload]) => (payload as unknown as { approval_id: string }).approval_id)).toEqual(['gone'])
  })

  it('looks again after a grace and leaves what a reconnected window claimed back (review-370 R2)', async () => {
    vi.useFakeTimers()
    try {
      const trustConfirm = vi.fn(async () => ({ nonce: 'n', expires: '1', mac: 'm' }))
      const listInstalled = vi.fn(async () => [])
      ;(window as unknown as { agentTeam: unknown }).agentTeam = { trustConfirm, plugins: { listInstalled } }
      const target = { id: 'a.b', namespace: 'a', name: 'b', version: '1.0.0', fromVersion: null }
      const applying = (id: string) => ({ approval_id: id, kind: 'plugin-install', status: 'applying', target })
      // First look: window A is between sockets, so nothing looks claimed.
      const looks = [
        { requests: [applying('reconnected'), applying('gone'), applying('settled')], applyingInLiveWindow: [] },
        // After the grace: A is back and claims its request; another one finished meanwhile.
        { requests: [applying('reconnected'), applying('gone')], applyingInLiveWindow: ['reconnected'] },
      ]
      const send = vi.fn(async (type: string, _payload?: unknown) => type === 'plugins.agent_requests.list'
        ? { ok: true, payload: looks.shift() }
        : { ok: true, payload: {} })
      const done = usePluginAgentRequests({ send } as never).recover(5000)
      await vi.advanceTimersByTimeAsync(4999)
      expect(send.mock.calls.filter(([type]) => type === 'plugins.agent_request.finish')).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await done
      const finished = send.mock.calls.filter(([type]) => type === 'plugins.agent_request.finish')
      expect(finished.map(([, payload]) => (payload as unknown as { approval_id: string }).approval_id)).toEqual(['gone'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes its grace from the reconnect backoff: the first three attempts and a handshake (MED-2 on #383)', () => {
    expect(RECOVERY_GRACE_MS).toBe(reconnectDelayMs(0) + reconnectDelayMs(1) + reconnectDelayMs(2) + WS_RECONNECT_BASE_MS)
    expect(RECOVERY_GRACE_MS).toBe(12_000)
    // At least the first two reconnects, with room to spare.
    expect(RECOVERY_GRACE_MS).toBeGreaterThan(reconnectDelayMs(0) + reconnectDelayMs(1))
  })

  it.each([
    { backAtMs: 6_000, settled: [] as string[] },
    { backAtMs: 13_000, settled: ['a-request'] },
  ])('window A back at $backAtMs ms: the default grace settles $settled', async ({ backAtMs, settled }) => {
    vi.useFakeTimers()
    try {
      const trustConfirm = vi.fn(async () => ({ nonce: 'n', expires: '1', mac: 'm' }))
      const listInstalled = vi.fn(async () => [])
      ;(window as unknown as { agentTeam: unknown }).agentTeam = { trustConfirm, plugins: { listInstalled } }
      const target = { id: 'a.b', namespace: 'a', name: 'b', version: '1.0.0', fromVersion: null }
      const started = Date.now()
      const send = vi.fn(async (type: string, _payload?: unknown) => type === 'plugins.agent_requests.list'
        ? {
            ok: true,
            payload: {
              requests: [{ approval_id: 'a-request', kind: 'plugin-install', status: 'applying', target }],
              // Window A claims its request back once it has reconnected.
              applyingInLiveWindow: Date.now() - started >= backAtMs ? ['a-request'] : [],
            },
          }
        : { ok: true, payload: {} })
      const done = usePluginAgentRequests({ send } as never).recover()
      await vi.advanceTimersByTimeAsync(RECOVERY_GRACE_MS)
      await done
      const finished = send.mock.calls.filter(([type]) => type === 'plugins.agent_request.finish')
      expect(finished.map(([, payload]) => (payload as unknown as { approval_id: string }).approval_id)).toEqual(settled)
      for (const [, payload] of finished) expect(payload).toMatchObject({ status: 'failed', error: 'interrupted' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves finish with the stored record, late or not', async () => {
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { trustConfirm: vi.fn(async () => ({})) }
    const approval = { approval_id: 'abc', status: 'completed', error: null, finished_late: true,
      settled: { status: 'failed', error: 'interrupted' } }
    const send = vi.fn(async () => ({ ok: true, payload: { approval } }))
    expect(await usePluginAgentRequests({ send } as never).finish('abc', { status: 'completed', error: null }))
      .toEqual(approval)
  })
})
