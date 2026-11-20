import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: { defaultSession: { resolveProxy: vi.fn() } } }))

import { PROXY_RESOLVE_RESULT, handleProxyResolveRequest, parseProxyResolveRequest } from './channel-proxy'

function fakeClient() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  return {
    sent,
    send: async (type: string, payload: Record<string, unknown>) => { sent.push({ type, payload }) },
  }
}

describe('channel proxy resolve', () => {
  it('answers with what the system resolver says for the URL', async () => {
    const client = fakeClient()
    const resolveProxy = vi.fn(async () => 'PROXY proxy.corp:8080; DIRECT')
    await handleProxyResolveRequest(client, { request_id: 'proxy:1', url: 'https://api.telegram.org:443/' }, resolveProxy)
    expect(resolveProxy).toHaveBeenCalledWith('https://api.telegram.org/')
    expect(client.sent).toEqual([{
      type: PROXY_RESOLVE_RESULT,
      payload: { request_id: 'proxy:1', response: { ok: true, rules: 'PROXY proxy.corp:8080; DIRECT' } },
    }])
  })

  it('refuses anything but an http(s) URL without resolving it', async () => {
    const client = fakeClient()
    const resolveProxy = vi.fn(async () => 'DIRECT')
    for (const url of ['file:///etc/hosts', 'javascript:1', 'not a url', 42]) {
      await handleProxyResolveRequest(client, { request_id: 'proxy:2', url }, resolveProxy)
    }
    expect(resolveProxy).not.toHaveBeenCalled()
    expect(client.sent.every((s) => (s.payload.response as { ok: boolean }).ok === false)).toBe(true)
  })

  it('reports a resolver failure instead of leaving the backend waiting', async () => {
    const client = fakeClient()
    await handleProxyResolveRequest(client, { request_id: 'proxy:3', url: 'https://x.test/' }, async () => {
      throw new TypeError('boom')
    })
    expect(client.sent[0].payload).toEqual({ request_id: 'proxy:3', response: { ok: false, error: 'TypeError' } })
  })

  it('ignores a request without an id', () => {
    expect(parseProxyResolveRequest({ url: 'https://x.test/' })).toBeNull()
    expect(parseProxyResolveRequest(null)).toBeNull()
  })
})
