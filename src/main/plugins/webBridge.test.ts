import { describe, expect, it } from 'vitest'
import { PlansBridgeError } from './plansBridge'
import { PluginWebViewRegistry, type WebGuestSession, type WebGuestView } from './pluginWebViews'
import { dispatchWebBridge } from './webBridge'
import type { WebViewInfo } from './webCapability'

type Listener = (...args: unknown[]) => void

function fakeGuest(sent: string[]): WebGuestView & { emit(event: string, ...args: unknown[]): void } {
  const listeners = new Map<string, Listener[]>()
  let destroyed = false
  let attached = false
  const contents = {
    isDestroyed: () => destroyed,
    loadURL: async () => {},
    getURL: () => 'about:blank',
    getTitle: () => '',
    isLoading: () => false,
    stop: () => {},
    reload: () => {},
    close: () => { destroyed = true; for (const listener of listeners.get('destroyed') ?? []) listener() },
    on: (event: string, listener: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
    setWindowOpenHandler: () => {},
    capturePage: async () => { throw new Error('unused') },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} },
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true },
      detach: () => { attached = false },
      sendCommand: async (method: string) => {
        sent.push(method)
        if (method === 'DOM.resolveNode') throw new Error('y'.repeat(800))
        return { method }
      },
    },
  }
  return {
    webContents: contents,
    setBounds: () => {},
    setVisible: () => {},
    emit: (event, ...args) => { for (const listener of listeners.get(event) ?? []) listener(...args) },
  }
}

function setup() {
  const sent: string[] = []
  const guests: Array<ReturnType<typeof fakeGuest>> = []
  const session: WebGuestSession = {
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
    setDisplayMediaRequestHandler: () => {},
    on: () => undefined,
    clearStorageData: async () => {},
    clearCache: async () => {},
    clearAuthCache: async () => {},
    clearHostResolverCache: async () => {},
  }
  const registry = new PluginWebViewRegistry({
    createView: () => {
      const guest = fakeGuest(sent)
      guests.push(guest)
      return guest
    },
    session: () => session,
    onChanged: () => {},
  })
  return { registry, sent, guests }
}

async function bridgeError(promise: Promise<unknown>): Promise<PlansBridgeError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PlansBridgeError)
    return error as PlansBridgeError
  }
  throw new Error('expected a Bridge error')
}

describe('dispatchWebBridge', () => {
  it('creates agent views and runs the web operations for the bound plugin', async () => {
    const { registry, sent } = setup()
    const created = await dispatchWebBridge(registry, 'acme.web', 'create', { space: 'task', url: 'https://example.com/' })
    expect(created).toEqual({ viewId: expect.any(String) })
    const viewId = (created as { viewId: string }).viewId
    expect(registry.list('acme.web')[0]).toMatchObject({ viewId, owner: 'agent', control: 'agent', state: 'running' })
    await expect(dispatchWebBridge(registry, 'acme.web', 'list', {})).resolves.toEqual({ views: registry.list('acme.web') })
    await expect(dispatchWebBridge(registry, 'acme.web', 'cdp', { viewId, method: 'Page.getNavigationHistory' }))
      .resolves.toEqual({ result: { method: 'Page.getNavigationHistory' } })
    expect(sent).toEqual(['Page.getNavigationHistory'])
    await expect(dispatchWebBridge(registry, 'acme.web', 'setState', { viewId, state: 'done', note: 'ok' }))
      .resolves.toEqual({ ok: true })
    expect(registry.list('acme.web')[0]).toMatchObject({ state: 'done', note: 'ok' })
    await expect(dispatchWebBridge(registry, 'acme.web', 'close', { viewId })).resolves.toEqual({ ok: true })
    expect(registry.list('acme.web')).toEqual([])
  })

  it('lists a user-owned Space without its URL, title or note', async () => {
    const { registry, guests } = setup()
    const user = registry.create('acme.web', { space: 'mine', url: 'https://mail.example.com/inbox' }, 'user')
    guests[0]!.webContents.getURL = () => 'https://mail.example.com/inbox/secret-thread'
    guests[0]!.webContents.getTitle = () => 'Secret thread - Mail'
    const agent = await dispatchWebBridge(registry, 'acme.web', 'create', { space: 'task' }) as { viewId: string }
    guests[1]!.webContents.getURL = () => 'https://example.com/task'
    guests[1]!.webContents.getTitle = () => 'Task'
    registry.setState('acme.web', agent.viewId, 'running', 'Reading')
    const listed = await dispatchWebBridge(registry, 'acme.web', 'list', {}) as { views: Array<Record<string, unknown>> }
    expect(listed.views).toEqual([
      { viewId: user.viewId, space: 'mine', owner: 'user', control: 'user', state: 'idle', url: '', title: '', loading: false, attached: false },
      expect.objectContaining({ viewId: agent.viewId, owner: 'agent', url: 'https://example.com/task', title: 'Task', note: 'Reading' }),
    ])
    expect(registry.list('acme.web')[0]).toMatchObject({ url: 'https://mail.example.com/inbox/secret-thread', title: 'Secret thread - Mail' })
  })

  it('refuses invalid requests and another plugin\'s views', async () => {
    const { registry } = setup()
    const { viewId } = await dispatchWebBridge(registry, 'acme.web', 'create', { space: 'task' }) as { viewId: string }
    for (const [operation, args] of [
      ['list', { pluginId: 'acme.web' }],
      ['create', { space: 'task', url: 'file:///etc/passwd' }],
      ['cdp', { viewId, method: 'not a method' }],
      ['navigate', { viewId }],
    ] as const) {
      expect((await bridgeError(dispatchWebBridge(registry, 'acme.web', operation, args))).code).toBe('INVALID_ARGUMENT')
    }
    expect((await bridgeError(dispatchWebBridge(registry, 'acme.other', 'close', { viewId }))).code).toBe('INVALID_ARGUMENT')
    expect((await bridgeError(dispatchWebBridge(registry, 'acme.other', 'cdp', { viewId, method: 'Page.getNavigationHistory' }))).code)
      .toBe('INVALID_ARGUMENT')
    await expect(dispatchWebBridge(registry, 'acme.other', 'list', {})).resolves.toEqual({ views: [] })
  })

  it('answers USER_IN_CONTROL with the reason while the user controls or owns the view', async () => {
    const { registry, sent, guests } = setup()
    const { viewId } = await dispatchWebBridge(registry, 'acme.web', 'create', { space: 'task' }) as { viewId: string }
    guests[0]!.emit('before-input-event', {}, { type: 'keyDown' })
    const takeover = await bridgeError(dispatchWebBridge(registry, 'acme.web', 'cdp', { viewId, method: 'Page.getNavigationHistory' }))
    expect(takeover.code).toBe('USER_IN_CONTROL')
    expect(takeover.data).toEqual({ reason: 'manual_takeover' })

    const user = registry.create('acme.web', { space: 'mine' }, 'user')
    const owned = await bridgeError(dispatchWebBridge(registry, 'acme.web', 'cdp', { viewId: user.viewId, method: 'Page.getNavigationHistory' }))
    expect(owned.code).toBe('USER_IN_CONTROL')
    expect(owned.data).toEqual({ reason: 'user-owned' })
    expect((await bridgeError(dispatchWebBridge(registry, 'acme.web', 'close', { viewId: user.viewId }))).data)
      .toEqual({ reason: 'user-owned' })
    expect(sent).toEqual([])
  })

  it('keeps a pane to the Spaces it created, in its own workspace', async () => {
    const { registry, sent } = setup()
    const paneA = { paneId: 'p-a', workspace: '/w' }
    const paneB = { paneId: 'p-b', workspace: '/w' }
    const { viewId } = await dispatchWebBridge(registry, 'acme.web', 'create', { space: 'pane-a' }, paneA) as { viewId: string }
    await expect(dispatchWebBridge(registry, 'acme.web', 'list', {}, paneB)).resolves.toEqual({ views: [] })
    for (const caller of [paneB, { paneId: 'p-a', workspace: '/other' }, { paneId: null, workspace: null }]) {
      for (const [operation, args] of [
        ['cdp', { viewId, method: 'Page.getNavigationHistory' }],
        ['setState', { viewId, state: 'done' }],
        ['close', { viewId }],
      ] as const) {
        expect((await bridgeError(dispatchWebBridge(registry, 'acme.web', operation, args, caller))).code).toBe('INVALID_ARGUMENT')
      }
    }
    expect(sent).toEqual([])
    await expect(dispatchWebBridge(registry, 'acme.web', 'list', {}, paneA)).resolves.toEqual({ views: registry.list('acme.web') })
    await dispatchWebBridge(registry, 'acme.web', 'cdp', { viewId, method: 'Page.getNavigationHistory' }, paneA)
    expect(sent).toEqual(['Page.getNavigationHistory'])
  })

  it('lets any pane use a Space the user handed to agents', async () => {
    const { registry, sent } = setup()
    const paneA = { paneId: 'p-a', workspace: '/w' }
    const paneB = { paneId: 'p-b', workspace: '/v' }
    const handed = registry.create('acme.web', { space: 'shopping' }, 'user')
    registry.setOwner('acme.web', handed.viewId, 'agent')
    const taken = await dispatchWebBridge(registry, 'acme.web', 'create', { space: 'pane-a' }, paneA) as { viewId: string }
    registry.setOwner('acme.web', taken.viewId, 'user')
    registry.setOwner('acme.web', taken.viewId, 'agent')
    for (const viewId of [handed.viewId, taken.viewId]) {
      await dispatchWebBridge(registry, 'acme.web', 'cdp', { viewId, method: 'Page.getNavigationHistory' }, paneB)
    }
    expect(sent).toHaveLength(2)
    const listed = await dispatchWebBridge(registry, 'acme.web', 'list', {}, paneB) as unknown as { views: WebViewInfo[] }
    expect(listed.views.map(view => view.viewId)).toEqual([handed.viewId, taken.viewId])
  })

  it('maps a failed CDP command to CDP_ERROR with its message and a denied method to CAPABILITY_DENIED', async () => {
    const { registry } = setup()
    const { viewId } = await dispatchWebBridge(registry, 'acme.web', 'create', { space: 'task' }) as { viewId: string }
    const failed = await bridgeError(dispatchWebBridge(registry, 'acme.web', 'cdp', { viewId, method: 'DOM.resolveNode' }))
    expect(failed.code).toBe('CDP_ERROR')
    expect(failed.data).toEqual({ message: 'y'.repeat(500) })
    expect((await bridgeError(dispatchWebBridge(registry, 'acme.web', 'cdp', { viewId, method: 'Target.getTargets' }))).code)
      .toBe('CAPABILITY_DENIED')
  })
})
