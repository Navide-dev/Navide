/**
 * Resolves the system proxy for the backend's chat channels
 * (backend/agent_team_backend/channels/proxy.py).
 *
 * Python reads fixed proxies only; a proxy auto-configuration (PAC) file or automatic
 * discovery (WPAD) is a JavaScript program it cannot run. When a channel has no fixed
 * proxy for a URL, the backend sends `channels.proxy_resolve.request` on the Host socket
 * and this answers `channels.proxy_resolve.result` with what Chromium's resolver says
 * for it (`"PROXY host:port; DIRECT"`), which runs the PAC file. The backend decides what
 * to do with the answer. Nothing here is logged: the answer names the proxy, and the URL
 * names the chat server.
 */
import { session } from 'electron'

export const PROXY_RESOLVE_REQUEST = 'channels.proxy_resolve.request'
export const PROXY_RESOLVE_RESULT = 'channels.proxy_resolve.result'

export type ProxyResolveResponse = { ok: true; rules: string } | { ok: false; error: string }

export interface ProxyResolveClient {
  send(type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown>
}

/** The request's id and URL, or null when there is nothing to answer. Only http(s)
 *  URLs are resolved; the backend asks in that form. */
export function parseProxyResolveRequest(
  payload: unknown,
): { requestId: string; url: string | null } | null {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const requestId = typeof record.request_id === 'string' && record.request_id ? record.request_id : null
  if (requestId === null) return null
  let url: string | null = null
  if (typeof record.url === 'string') {
    try {
      const parsed = new URL(record.url)
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) url = parsed.href
    } catch { /* not a URL */ }
  }
  return { requestId, url }
}

/** Serve one `channels.proxy_resolve.request` from the backend and answer it. */
export async function handleProxyResolveRequest(
  client: ProxyResolveClient,
  payload: unknown,
  resolveProxy: (url: string) => Promise<string> = (url) => session.defaultSession.resolveProxy(url),
): Promise<void> {
  const request = parseProxyResolveRequest(payload)
  if (request === null) return
  let response: ProxyResolveResponse
  if (request.url === null) {
    response = { ok: false, error: 'not an http(s) URL' }
  } else {
    try {
      response = { ok: true, rules: await resolveProxy(request.url) }
    } catch (err) {
      response = { ok: false, error: err instanceof Error ? err.name : 'error' }
    }
  }
  await client.send(PROXY_RESOLVE_RESULT, { request_id: request.requestId, response }, 10_000).catch(() => {
    // The backend waits with its own timeout and falls back to its default.
  })
}
