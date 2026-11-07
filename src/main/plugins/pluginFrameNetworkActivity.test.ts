import { describe, expect, it, vi } from 'vitest'
import type { PluginActivityRow } from './pluginActivity'
import type { PluginFrameAssetMount } from './pluginFrameAssetProtocol'
import {
  PluginFrameNetworkObserver,
  frameWorkspaceOf,
  hostDeclared,
  networkActivityRow,
  networkHostOf,
  refusedConnectHost,
  type ObservedConsoleMessage,
  type ObservedRequestDetails,
  type ObservedSession,
  type ObservedWebContents,
  type SurfaceNetworkPolicy,
} from './pluginFrameNetworkActivity'

const FRAME = 'navide-plugin-frame://aaaa/index.html?workspace_path=%2FUsers%2Fme%2Fproject&v2=1&contribution=main'
const MOUNT: PluginFrameAssetMount = {
  artifactId: 'a'.repeat(64), packageId: 'acme.status', packageVersion: '1.0.0', root: '/pkg', connectHosts: ['api.github.com', '*.example.com'],
}
const SURFACE: SurfaceNetworkPolicy = {
  pluginId: 'acme.board', packageVersion: '2.0.0', workspace: '/Users/me/project', hosts: ['api.github.com'], devOrigin: null,
}

/** A fake session: one listener per webRequest event, as Electron keeps. */
function session() {
  const listeners: Record<string, ((...args: any[]) => void) | null> = { before: null, completed: null, error: null }
  const registrations = { before: 0, completed: 0, error: 0 }
  const ses: ObservedSession = {
    webRequest: {
      onBeforeRequest: (listener) => { listeners.before = listener; registrations.before += 1 },
      onCompleted: (listener) => { listeners.completed = listener; registrations.completed += 1 },
      onErrorOccurred: (listener) => { listeners.error = listener; registrations.error += 1 },
    },
  }
  const decide = (details: ObservedRequestDetails): { cancel?: boolean } => {
    let answer: { cancel?: boolean } = { cancel: undefined }
    listeners.before!(details, (response: { cancel?: boolean }) => { answer = response })
    return answer
  }
  return { ses, listeners, registrations, decide }
}

function contents(ses: ObservedSession) {
  const consoleListeners: Array<(event: ObservedConsoleMessage) => void> = []
  const wc: ObservedWebContents = {
    session: ses,
    on: (_event, listener) => { consoleListeners.push(listener) },
  }
  return { wc, consoleListeners }
}

function observer(options: { surface?: SurfaceNetworkPolicy | null; mount?: PluginFrameAssetMount | null } = {}) {
  const rows: PluginActivityRow[] = []
  const obs = new PluginFrameNetworkObserver({
    mountOf: (url) => (url && url.startsWith('navide-plugin-frame://aaaa/') ? options.mount ?? MOUNT : null),
    surfaceOf: (id) => (id === 7 ? options.surface ?? SURFACE : null),
    record: (row) => { rows.push(row) },
    now: () => 1_792_799_940_000,
  })
  return { obs, rows }
}

describe('network helpers', () => {
  it('reads only the host of a request that leaves the view', () => {
    expect(networkHostOf('https://API.GitHub.com/repos?x=1#f')).toBe('api.github.com')
    expect(networkHostOf('wss://chat.example.com:8443/socket')).toBe('chat.example.com')
    expect(networkHostOf('navide-plugin-frame://aaaa/index.html')).toBeNull()
    expect(networkHostOf('navide-preview://resource/doc.pdf')).toBeNull()
    expect(networkHostOf('data:text/plain,hi')).toBeNull()
    expect(networkHostOf('file:///pkg/index.html')).toBeNull()
    expect(networkHostOf('not a url')).toBeNull()
    expect(networkHostOf(undefined)).toBeNull()
  })

  it('matches declared hosts exactly or below a wildcard', () => {
    expect(hostDeclared(['api.github.com', '*.example.com'], 'api.github.com')).toBe(true)
    expect(hostDeclared(['api.github.com', '*.example.com'], 'a.b.example.com')).toBe(true)
    expect(hostDeclared(['*.example.com'], 'example.com')).toBe(false)
    expect(hostDeclared(['*.example.com'], 'notexample.com')).toBe(false)
    expect(hostDeclared(['api.github.com'], 'github.com')).toBe(false)
  })

  it('recognises a connect-src refusal and nothing else', () => {
    expect(refusedConnectHost(
      "Refused to connect to 'https://tracker.evil.net/collect?x=1' because it violates the following Content Security Policy directive: \"connect-src 'none'\". Note that 'connect-src' was not explicitly set.",
    )).toBe('tracker.evil.net')
    expect(refusedConnectHost(
      "Refused to load the script 'https://cdn.example.com/x.js' because it violates the following Content Security Policy directive: \"script-src 'self'\".",
    )).toBeNull()
    expect(refusedConnectHost('TypeError: Failed to fetch')).toBeNull()
  })

  it('reads the workspace from the frame URL the Host composed', () => {
    expect(frameWorkspaceOf(FRAME)).toBe('/Users/me/project')
    expect(frameWorkspaceOf('navide-plugin-frame://aaaa/index.html')).toBe('')
    expect(frameWorkspaceOf(undefined)).toBe('')
  })

  it('builds a network row under network.<host>, undeclared when refused', () => {
    expect(networkActivityRow({ pluginId: 'acme.a', packageVersion: '1.0.0', workspace: '/w', host: 'api.github.com', outcome: 'allowed', at: 5 })).toEqual({
      plugin_id: 'acme.a', plugin_version: '1.0.0', workspace: '/w', source: 'network', address: 'network.api.github.com', outcome: 'allowed', at: 5, count: 1,
    })
    expect(networkActivityRow({ pluginId: 'acme.a', packageVersion: '1.0.0', workspace: '/w', host: 'x.net', outcome: 'denied', at: 5 })).toMatchObject({
      outcome: 'denied', denied_reason: 'undeclared', address: 'network.x.net',
    })
  })
})

describe('PluginFrameNetworkObserver', () => {
  it('registers once per session and once per contents', () => {
    const { obs } = observer()
    const { ses, registrations } = session()
    const a = contents(ses)
    const b = contents(ses)
    obs.observe(a.wc)
    obs.observe(a.wc)
    obs.observe(b.wc)
    expect(registrations).toEqual({ before: 1, completed: 1, error: 1 })
    expect(a.consoleListeners).toHaveLength(1)
    expect(b.consoleListeners).toHaveLength(1)
  })

  it('cancels a surface request to an undeclared host and records it as refused', () => {
    const { obs, rows } = observer()
    const { ses, decide } = session()
    obs.observe(contents(ses).wc)
    expect(decide({ url: 'https://tracker.evil.net/collect', webContentsId: 7 })).toEqual({ cancel: true })
    expect(rows).toEqual([expect.objectContaining({
      plugin_id: 'acme.board', plugin_version: '2.0.0', workspace: '/Users/me/project', source: 'network',
      address: 'network.tracker.evil.net', outcome: 'denied', denied_reason: 'undeclared', at: 1_792_799_940_000,
    })])
  })

  it('lets a surface reach its declared hosts and records the completed request', () => {
    const { obs, rows } = observer()
    const { ses, decide, listeners } = session()
    obs.observe(contents(ses).wc)
    expect(decide({ url: 'https://api.github.com/repos', webContentsId: 7 })).toEqual({})
    listeners.completed!({ url: 'https://api.github.com/repos', webContentsId: 7 })
    expect(rows).toEqual([expect.objectContaining({ address: 'network.api.github.com', outcome: 'allowed', plugin_id: 'acme.board' })])
  })

  it('leaves requests that are not a plugin view’s alone and records nothing for them', () => {
    const { obs, rows } = observer()
    const { ses, decide, listeners } = session()
    obs.observe(contents(ses).wc)
    expect(decide({ url: 'https://update.example.com/feed', webContentsId: 1 })).toEqual({})
    expect(decide({ url: 'https://api.github.com/x' })).toEqual({})
    listeners.completed!({ url: 'https://update.example.com/feed', webContentsId: 1 })
    expect(rows).toEqual([])
  })

  it('leaves a surface’s own package assets and preview resources alone', () => {
    const { obs, rows } = observer()
    const { ses, decide } = session()
    obs.observe(contents(ses).wc)
    expect(decide({ url: 'file:///pkg/frontend/main/index.js', webContentsId: 7 })).toEqual({})
    expect(decide({ url: 'navide-preview://resource/doc.pdf', webContentsId: 7 })).toEqual({})
    expect(decide({ url: 'data:text/plain,hi', webContentsId: 7 })).toEqual({})
    expect(rows).toEqual([])
  })

  it('does not filter a legacy surface, but still records what it reached', () => {
    const { obs, rows } = observer({ surface: { ...SURFACE, hosts: null } })
    const { ses, decide, listeners } = session()
    obs.observe(contents(ses).wc)
    expect(decide({ url: 'https://anything.example.net/', webContentsId: 7 })).toEqual({})
    listeners.completed!({ url: 'https://anything.example.net/', webContentsId: 7 })
    expect(rows).toEqual([expect.objectContaining({ address: 'network.anything.example.net', outcome: 'allowed' })])
  })

  it('always admits the dev server a surface loads from in development', () => {
    const { obs, rows } = observer({ surface: { ...SURFACE, hosts: [], devOrigin: 'http://localhost:5173' } })
    const { ses, decide } = session()
    obs.observe(contents(ses).wc)
    expect(decide({ url: 'http://localhost:5173/@vite/client', webContentsId: 7 })).toEqual({})
    expect(decide({ url: 'http://localhost:5174/other', webContentsId: 7 })).toEqual({ cancel: true })
    expect(rows).toHaveLength(1)
  })

  it('judges a frame by its mount, not by the receiver window it lives in', () => {
    const { obs, rows } = observer()
    const { ses, decide, listeners } = session()
    obs.observe(contents(ses).wc)
    // The receiver (webContentsId 1) is not a plugin surface; the frame URL names the package.
    expect(decide({ url: 'https://deep.sub.example.com/api', webContentsId: 1, frame: { url: FRAME } })).toEqual({})
    expect(decide({ url: 'https://tracker.evil.net/x', webContentsId: 1, frame: { url: FRAME } })).toEqual({ cancel: true })
    listeners.completed!({ url: 'https://deep.sub.example.com/api', webContentsId: 1, frame: { url: FRAME } })
    expect(rows.map((row) => [row.plugin_id, row.workspace, row.address, row.outcome])).toEqual([
      ['acme.status', '/Users/me/project', 'network.tracker.evil.net', 'denied'],
      ['acme.status', '/Users/me/project', 'network.deep.sub.example.com', 'allowed'],
    ])
  })

  it('refuses a request from a plugin-frame origin that no live mount names', () => {
    const { obs, rows } = observer()
    const { ses, decide } = session()
    obs.observe(contents(ses).wc)
    expect(decide({ url: 'https://api.github.com/', webContentsId: 1, frame: { url: 'navide-plugin-frame://bbbb/index.html' } })).toEqual({ cancel: true })
    expect(rows).toEqual([])
  })

  it('records a frame’s connect-src refusal from the console once, and not again as an error', () => {
    const { obs, rows } = observer()
    const { ses, listeners } = session()
    const { wc, consoleListeners } = contents(ses)
    obs.observe(wc)
    consoleListeners[0]({
      level: 'error',
      message: "Refused to connect to 'https://tracker.evil.net/collect' because it violates the following Content Security Policy directive: \"connect-src https://api.github.com wss://api.github.com\".",
      frame: { url: FRAME },
    })
    consoleListeners[0]({ level: 'warning', message: 'Refused to connect to \'https://x.net/\' because it violates the following Content Security Policy directive: "connect-src', frame: { url: FRAME } })
    consoleListeners[0]({ level: 'error', message: 'Refused to connect to \'https://x.net/\' because it violates the following Content Security Policy directive: "connect-src', frame: { url: 'https://other.example/' } })
    listeners.error!({ url: 'https://tracker.evil.net/collect', webContentsId: 7, error: 'net::ERR_BLOCKED_BY_CLIENT' })
    listeners.error!({ url: 'https://api.github.com/down', webContentsId: 7, error: 'net::ERR_CONNECTION_REFUSED' })
    expect(rows.map((row) => [row.address, row.outcome, row.denied_reason ?? null])).toEqual([
      ['network.tracker.evil.net', 'denied', 'undeclared'],
      ['network.api.github.com', 'error', null],
    ])
  })

  it('never fails a request when the record sink throws', () => {
    const obs = new PluginFrameNetworkObserver({
      mountOf: () => null,
      surfaceOf: () => SURFACE,
      record: () => { throw new Error('sink down') },
    })
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    expect(obs.decide({ url: 'https://tracker.evil.net/', webContentsId: 7 })).toEqual({})
    expect(() => obs.onRequest({ url: 'https://api.github.com/', webContentsId: 7 }, 'allowed')).not.toThrow()
    debug.mockRestore()
  })
})
