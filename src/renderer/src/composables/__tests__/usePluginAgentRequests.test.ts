// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePluginAgentRequests } from '../usePluginAgentRequests'

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
})
