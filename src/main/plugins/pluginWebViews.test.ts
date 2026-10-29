import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isPluginWebGuest,
  looksSecret,
  MAX_ATTACHED_VIEWS,
  MAX_VIEWS_PER_PLUGIN,
  PluginWebViewRegistry,
  WebViewError,
  webPartitionFor,
  type WebGuestSession,
  type WebGuestView,
  type WebHostSurface,
} from './pluginWebViews'
import type { WebViewInfo } from './webCapability'

type Listener = (...args: any[]) => void

class FakeEmitter {
  readonly listeners = new Map<string, Listener[]>()
  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

class FakeContents extends FakeEmitter {
  destroyed = false
  url = 'about:blank'
  loads: string[] = []
  stopped = 0
  closed = 0
  windowOpenHandler: ((details: { url: string }) => { action: 'deny' }) | null = null
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = []
  attached = false
  readonly debuggerEvents = new FakeEmitter()
  readonly debugger = {
    on: (event: string, listener: Listener): unknown => this.debuggerEvents.on(event, listener),
    isAttached: (): boolean => this.attached,
    attach: (): void => { this.attached = true },
    detach: (): void => { this.attached = false },
    sendCommand: async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      this.sent.push({ method, ...(params === undefined ? {} : { params }) })
      return { ok: method }
    },
  }
  readonly navigationHistory = {
    canGoBack: (): boolean => true,
    canGoForward: (): boolean => false,
    goBack: vi.fn(),
    goForward: vi.fn(),
  }
  isDestroyed(): boolean { return this.destroyed }
  async loadURL(url: string): Promise<void> { this.loads.push(url); this.url = url }
  getURL(): string { return this.url }
  getTitle(): string { return 'Title' }
  isLoading(): boolean { return false }
  stop(): void { this.stopped += 1 }
  reloads = 0
  reload(): void { this.reloads += 1 }
  close(): void { this.closed += 1; this.destroyed = true; this.emit('destroyed') }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void { this.windowOpenHandler = handler }
  async capturePage(): Promise<any> {
    const jpeg = Buffer.from('jpeg')
    return { isEmpty: () => false, getSize: () => ({ width: 1000, height: 800 }), resize: () => ({ toJPEG: () => jpeg }), toJPEG: () => jpeg }
  }
}

class FakeView implements WebGuestView {
  readonly webContents = new FakeContents()
  bounds: unknown = null
  visible = true
  constructor(readonly options: { partition: string; backgroundThrottling: boolean }) {}
  setBounds(rect: unknown): void { this.bounds = rect }
  setVisible(visible: boolean): void { this.visible = visible }
}

class FakeSession extends FakeEmitter implements WebGuestSession {
  permissionHandler: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null = null
  checkHandler: (() => boolean) | null = null
  displayHandler: ((request: unknown, callback: (streams: Record<string, never>) => void) => void) | null = null
  cleared = 0
  authCleared = 0
  hostsCleared = 0
  setPermissionRequestHandler(handler: NonNullable<FakeSession['permissionHandler']>): void { this.permissionHandler = handler }
  setPermissionCheckHandler(handler: () => boolean): void { this.checkHandler = handler }
  setDisplayMediaRequestHandler(handler: NonNullable<FakeSession['displayHandler']>): void { this.displayHandler = handler }
  async clearStorageData(): Promise<void> { this.cleared += 1 }
  async clearCache(): Promise<void> {}
  async clearAuthCache(): Promise<void> { this.authCleared += 1 }
  async clearHostResolverCache(): Promise<void> { this.hostsCleared += 1 }
}

function setup() {
  const views: FakeView[] = []
  const sessions = new Map<string, FakeSession>()
  const changes: Array<{ pluginId: string; views: WebViewInfo[] }> = []
  const registry = new PluginWebViewRegistry({
    createView: (options) => {
      const view = new FakeView(options)
      views.push(view)
      return view
    },
    session: (partition) => {
      let session = sessions.get(partition)
      if (!session) {
        session = new FakeSession()
        sessions.set(partition, session)
      }
      return session
    },
    onChanged: (pluginId, list) => changes.push({ pluginId, views: list }),
  })
  return { registry, views, sessions, changes }
}

function host(key = 'host-1', bounds = { x: 100, y: 50, width: 800, height: 600 }) {
  const children: WebGuestView[] = []
  const surface: WebHostSurface & { children: WebGuestView[]; shown: boolean; rect: typeof bounds | null } = {
    key,
    children,
    shown: true,
    rect: bounds,
    addChildView: (view) => { children.push(view) },
    removeChildView: (view) => { children.splice(children.indexOf(view), 1) },
    bounds: () => surface.rect,
    visible: () => surface.shown,
  }
  return surface
}

function errorOf(fn: () => unknown): WebViewError {
  try {
    fn()
  } catch (error) {
    if (error instanceof WebViewError) return error
    throw error
  }
  throw new Error('expected a WebViewError')
}

async function rejectionOf(promise: Promise<unknown>): Promise<WebViewError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof WebViewError) return error
    throw error
  }
  throw new Error('expected a WebViewError')
}

const nextTick = (): Promise<void> => new Promise(resolve => queueMicrotask(resolve))

describe('partition isolation', () => {
  it('gives each plugin its own persistent partition', () => {
    const { registry, views } = setup()
    registry.create('navide.browser', { space: 'a' }, 'user')
    registry.create('acme.docs', { space: 'b' }, 'user')
    expect(views.map(view => view.options.partition)).toEqual([
      'persist:navide-web:navide.browser',
      'persist:navide-web:acme.docs',
    ])
  })

  it('refuses a plugin id that could name another partition', () => {
    expect(errorOf(() => webPartitionFor('../x')).code).toBe('INVALID_ARGUMENT')
    expect(errorOf(() => webPartitionFor('')).code).toBe('INVALID_ARGUMENT')
  })

  it('never shows one plugin the views of another', () => {
    const { registry } = setup()
    const { viewId } = registry.create('acme.docs', { space: 'b' }, 'agent')
    expect(registry.list('navide.browser')).toEqual([])
    expect(errorOf(() => registry.close('navide.browser', viewId, true)).code).toBe('INVALID_ARGUMENT')
    expect(errorOf(() => registry.attach('navide.browser', viewId, { x: 0, y: 0, width: 10, height: 10 }, host())).code)
      .toBe('INVALID_ARGUMENT')
  })

  it('clears only the calling plugin partition', async () => {
    const { registry, sessions } = setup()
    registry.create('navide.browser', { space: 'a' }, 'user')
    registry.create('acme.docs', { space: 'b' }, 'user')
    await registry.clearData('navide.browser')
    expect(sessions.get('persist:navide-web:navide.browser')?.cleared).toBe(1)
    expect(sessions.get('persist:navide-web:acme.docs')?.cleared).toBe(0)
    expect(sessions.get('persist:navide-web:navide.browser')).toMatchObject({ authCleared: 1, hostsCleared: 1 })
    expect(sessions.get('persist:navide-web:acme.docs')).toMatchObject({ authCleared: 0, hostsCleared: 0 })
  })
})

describe('navigation allowlist', () => {
  it('refuses to create or navigate to a non-http(s) URL', () => {
    const { registry } = setup()
    expect(errorOf(() => registry.create('navide.browser', { space: 'a', url: 'file:///etc/passwd' }, 'user')).code)
      .toBe('INVALID_ARGUMENT')
    const { viewId } = registry.create('navide.browser', { space: 'a' }, 'user')
    expect(errorOf(() => registry.navigate('navide.browser', { viewId, url: 'javascript:alert(1)' })).code)
      .toBe('INVALID_ARGUMENT')
  })

  it('blocks a page from navigating or redirecting off the allowlist', () => {
    const { registry, views } = setup()
    registry.create('navide.browser', { space: 'a' }, 'user')
    const contents = views[0].webContents
    for (const event of ['will-navigate', 'will-redirect']) {
      const blocked = { preventDefault: vi.fn() }
      contents.emit(event, blocked, 'file:///Users/someone/.ssh/id_rsa')
      expect(blocked.preventDefault).toHaveBeenCalled()
      const allowed = { preventDefault: vi.fn() }
      contents.emit(event, allowed, 'https://example.com/')
      expect(allowed.preventDefault).not.toHaveBeenCalled()
    }
    const frame = { preventDefault: vi.fn(), url: 'chrome://settings', isMainFrame: true }
    contents.emit('will-frame-navigate', frame)
    expect(frame.preventDefault).toHaveBeenCalled()
  })

  it('stops a browser-initiated main-frame load that leaves the allowlist', () => {
    const { registry, views } = setup()
    registry.create('navide.browser', { space: 'a' }, 'user')
    const contents = views[0].webContents
    contents.emit('did-start-navigation', { url: 'file:///etc/hosts', isMainFrame: true })
    expect(contents.stopped).toBe(1)
    expect(contents.loads.at(-1)).toBe('about:blank')
  })

  it('opens an allowed window.open as a sibling view and never opens a window', () => {
    const { registry, views } = setup()
    const pane = { paneId: 'p-a', workspace: '/w' }
    const opener = registry.create('navide.browser', { space: 'task' }, 'agent', pane)
    const contents = views[0].webContents
    expect(contents.windowOpenHandler?.({ url: 'https://example.com/popup' })).toEqual({ action: 'deny' })
    expect(contents.loads).toEqual(['about:blank'])
    expect(views).toHaveLength(2)
    const popup = views[1]
    // Through create's guards: same partition, guest exemption, agent rule for throttling, wired guest.
    expect(popup.options).toEqual({ partition: webPartitionFor('navide.browser'), backgroundThrottling: false })
    expect(isPluginWebGuest(popup.webContents)).toBe(true)
    expect(popup.webContents.loads).toEqual(['https://example.com/popup'])
    expect(popup.webContents.windowOpenHandler).not.toBeNull()
    const info = registry.list('navide.browser').find(view => view.viewId !== opener.viewId)!
    expect(info).toMatchObject({ space: 'task', owner: 'agent', control: 'agent', state: 'running', openerViewId: opener.viewId })
    expect(registry.list('navide.browser').find(view => view.viewId === opener.viewId)).not.toHaveProperty('openerViewId')
    // The popup belongs to the opener's pane: another pane cannot see it.
    expect(registry.list('navide.browser', pane).map(view => view.viewId)).toContain(info.viewId)
    expect(registry.list('navide.browser', { paneId: 'p-b', workspace: '/w' })).toEqual([])
  })

  it('keeps a popup with the user when the user has taken over its agent opener', async () => {
    const { registry, views } = setup()
    const pane = { paneId: 'p-a', workspace: '/w' }
    const opener = registry.create('navide.browser', { space: 'task' }, 'agent', pane)
    registry.takeControl('navide.browser', opener.viewId)
    views[0].webContents.windowOpenHandler?.({ url: 'https://example.com/popup' })
    const popup = registry.list('navide.browser').find(view => view.viewId !== opener.viewId)!
    expect(popup).toMatchObject({ space: 'task', owner: 'agent', control: 'user', openerViewId: opener.viewId })
    await expect(registry.cdp('navide.browser', popup.viewId, 'Accessibility.getFullAXTree', {}, pane))
      .rejects.toMatchObject({ code: 'USER_IN_CONTROL', reason: 'manual_takeover' })
    registry.returnControl('navide.browser', popup.viewId)
    expect(registry.list('navide.browser').find(view => view.viewId === popup.viewId)).toMatchObject({ control: 'agent' })
  })

  it('gives a popup of a user Space to the user, in the same Space', () => {
    const { registry, views } = setup()
    const opener = registry.create('navide.browser', { space: 'mine' }, 'user')
    views[0].webContents.windowOpenHandler?.({ url: 'https://example.com/login' })
    expect(views[1].options.backgroundThrottling).toBe(true)
    const popup = registry.list('navide.browser').find(view => view.viewId !== opener.viewId)!
    expect(popup).toMatchObject({ space: 'mine', owner: 'user', control: 'user', state: 'idle', openerViewId: opener.viewId })
  })

  it('does nothing for a window.open off the allowlist', () => {
    const { registry, views } = setup()
    registry.create('navide.browser', { space: 'a' }, 'user')
    const contents = views[0].webContents
    for (const url of ['file:///etc/hosts', 'javascript:alert(1)', 'chrome://settings']) {
      expect(contents.windowOpenHandler?.({ url })).toEqual({ action: 'deny' })
    }
    expect(views).toHaveLength(1)
    expect(contents.loads).toEqual(['about:blank'])
  })

  it('loads a popup in the opener once the plugin has its maximum of views', () => {
    const { registry, views } = setup()
    for (let index = 0; index < MAX_VIEWS_PER_PLUGIN; index++) registry.create('navide.browser', { space: `s-${index}` }, 'user')
    const contents = views[0].webContents
    expect(contents.windowOpenHandler?.({ url: 'https://example.com/popup' })).toEqual({ action: 'deny' })
    expect(views).toHaveLength(MAX_VIEWS_PER_PLUGIN)
    expect(contents.loads.at(-1)).toBe('https://example.com/popup')
  })

  it('exempts its guests from the global navigation block', () => {
    const { registry, views } = setup()
    registry.create('navide.browser', { space: 'a' }, 'user')
    expect(isPluginWebGuest(views[0].webContents)).toBe(true)
    expect(isPluginWebGuest({})).toBe(false)
  })
})

describe('permissions', () => {
  it('denies every permission and hands an agent view to the user', async () => {
    const { registry, views, sessions } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'a' }, 'agent')
    const session = sessions.get('persist:navide-web:navide.browser')!
    const callback = vi.fn()
    session.permissionHandler?.(views[0].webContents, 'geolocation', callback)
    expect(callback).toHaveBeenCalledWith(false)
    expect(session.checkHandler?.()).toBe(false)
    const view = registry.list('navide.browser').find(entry => entry.viewId === viewId)!
    expect(view).toMatchObject({ control: 'user', state: 'need-action' })
    const error = await rejectionOf(registry.cdp('navide.browser', viewId, 'Runtime.evaluate', { expression: '1' }))
    expect(error).toMatchObject({ code: 'USER_IN_CONTROL', reason: 'permission' })
  })

  it('answers client certificate, Bluetooth and HTTP auth requests with nothing', () => {
    const { registry, views } = setup()
    registry.create('navide.browser', { space: 'a' }, 'agent')
    const contents = views[0].webContents
    const certificate = { preventDefault: vi.fn() }
    const pickCertificate = vi.fn()
    contents.emit('select-client-certificate', certificate, 'https://mtls.example.com/', [{ subjectName: 'me' }], pickCertificate)
    expect(certificate.preventDefault).toHaveBeenCalled()
    expect(pickCertificate).toHaveBeenCalledWith()
    const bluetooth = { preventDefault: vi.fn() }
    const pickDevice = vi.fn()
    contents.emit('select-bluetooth-device', bluetooth, [{ deviceId: 'd1', deviceName: 'Keyboard' }], pickDevice)
    expect(bluetooth.preventDefault).toHaveBeenCalled()
    expect(pickDevice).toHaveBeenCalledWith('')
    const login = { preventDefault: vi.fn() }
    const answer = vi.fn()
    contents.emit('login', login, { url: 'https://example.com/' }, { isProxy: false, host: 'example.com' }, answer)
    expect(login.preventDefault).toHaveBeenCalled()
    expect(answer).toHaveBeenCalledWith()
  })

  it('cancels downloads and screen capture requests', () => {
    const { registry, sessions } = setup()
    registry.create('navide.browser', { space: 'a' }, 'user')
    const session = sessions.get('persist:navide-web:navide.browser')!
    const download = { preventDefault: vi.fn() }
    session.emit('will-download', download)
    expect(download.preventDefault).toHaveBeenCalled()
    const callback = vi.fn()
    session.displayHandler?.({}, callback)
    expect(callback).toHaveBeenCalledWith({})
  })
})

describe('user in control', () => {
  it('refuses cdp on a user-owned view', async () => {
    const { registry, views } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'mine' }, 'user')
    const error = await rejectionOf(registry.cdp('navide.browser', viewId, 'Runtime.evaluate', {}))
    expect(error).toMatchObject({ code: 'USER_IN_CONTROL', reason: 'user-owned' })
    expect(views[0].webContents.sent).toEqual([])
  })

  it('refuses the bridge closing a user-owned view', () => {
    const { registry } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'mine' }, 'user')
    expect(errorOf(() => registry.close('navide.browser', viewId, true))).toMatchObject({
      code: 'USER_IN_CONTROL',
      reason: 'user-owned',
    })
    registry.close('navide.browser', viewId, false)
    expect(registry.list('navide.browser')).toEqual([])
  })

  it('hands control to the user on a click or key press, not on hover', async () => {
    const { registry, views } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    const contents = views[0].webContents
    contents.emit('before-mouse-event', {}, { type: 'mouseMove' })
    await expect(registry.cdp('navide.browser', viewId, 'Runtime.evaluate', {})).resolves.toEqual({ ok: 'Runtime.evaluate' })
    contents.emit('before-mouse-event', {}, { type: 'mouseDown' })
    const error = await rejectionOf(registry.cdp('navide.browser', viewId, 'Runtime.evaluate', {}))
    expect(error).toMatchObject({ code: 'USER_IN_CONTROL', reason: 'manual_takeover' })

    const second = registry.create('navide.browser', { space: 'agent-2' }, 'agent')
    views[1].webContents.emit('before-input-event', {}, { type: 'keyDown' })
    expect(registry.list('navide.browser').find(view => view.viewId === second.viewId)?.control).toBe('user')
  })

  it('does not treat the agent own CDP input as a takeover', async () => {
    const { registry, views } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    const contents = views[0].webContents
    contents.debugger.sendCommand = async (method: string) => {
      // The Host's own Page.enable on attach is not the agent's input.
      if (method.startsWith('Input.')) contents.emit('before-mouse-event', {}, { type: 'mouseDown' })
      return { ok: method }
    }
    await registry.cdp('navide.browser', viewId, 'Input.dispatchMouseEvent', { type: 'mousePressed' })
    expect(registry.list('navide.browser')[0].control).toBe('agent')
  })

  it('a user navigation takes the view, returnControl gives it back', async () => {
    const { registry } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    registry.navigate('navide.browser', { viewId, action: 'reload' })
    expect(registry.list('navide.browser')[0].control).toBe('user')
    registry.returnControl('navide.browser', viewId)
    expect(registry.list('navide.browser')[0].control).toBe('agent')
    await expect(registry.cdp('navide.browser', viewId, 'Runtime.evaluate', {})).resolves.toBeDefined()
  })

  it('takeControl hands an agent view to the user', async () => {
    const { registry } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    registry.takeControl('navide.browser', viewId)
    expect((await rejectionOf(registry.cdp('navide.browser', viewId, 'Runtime.evaluate', {})))).toMatchObject({
      code: 'USER_IN_CONTROL',
      reason: 'manual_takeover',
    })
  })

  it('need-action hands control to the user until it is returned', async () => {
    const { registry } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    registry.setState('navide.browser', viewId, 'need-action', 'Solve the captcha')
    expect(registry.list('navide.browser')[0]).toMatchObject({ control: 'user', state: 'need-action', note: 'Solve the captcha' })
    expect((await rejectionOf(registry.cdp('navide.browser', viewId, 'Runtime.evaluate', {}))).code).toBe('USER_IN_CONTROL')
    registry.returnControl('navide.browser', viewId)
    expect(registry.list('navide.browser')[0]).toMatchObject({ control: 'agent', state: 'running' })
  })

  it('detaches the debugger on every takeover and re-attaches on the next agent cdp', async () => {
    const { registry, views, sessions } = setup()
    const takeovers: Array<(viewId: string, contents: (typeof views)[number]['webContents']) => void> = [
      (_viewId, contents) => contents.emit('before-mouse-event', {}, { type: 'mouseDown' }),
      (_viewId, contents) => contents.emit('before-input-event', {}, { type: 'keyDown' }),
      (viewId) => registry.takeControl('navide.browser', viewId),
      (viewId) => registry.navigate('navide.browser', { viewId, action: 'reload' }),
      (viewId) => registry.setState('navide.browser', viewId, 'need-action', 'Sign In'),
      (_viewId, contents) => sessions.get('persist:navide-web:navide.browser')!.permissionHandler?.(contents, 'geolocation', () => {}),
      (viewId) => registry.setOwner('navide.browser', viewId, 'user'),
    ]
    for (const [index, takeOver] of takeovers.entries()) {
      const { viewId } = registry.create('navide.browser', { space: `agent-${index}` }, 'agent')
      const contents = views[index].webContents
      await registry.cdp('navide.browser', viewId, 'Runtime.evaluate', { expression: '1' })
      expect(contents.attached, `takeover ${index}`).toBe(true)
      takeOver(viewId, contents)
      expect(contents.attached, `takeover ${index}`).toBe(false)
      if (registry.list('navide.browser').find(view => view.viewId === viewId)?.owner === 'agent') {
        registry.returnControl('navide.browser', viewId)
      } else {
        registry.setOwner('navide.browser', viewId, 'agent')
      }
      await registry.cdp('navide.browser', viewId, 'Runtime.evaluate', { expression: '2' })
      expect(contents.attached, `takeover ${index}`).toBe(true)
    }
  })

  it('setOwner moves a Space between the user and the agent', async () => {
    const { registry } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'mine' }, 'user')
    registry.setOwner('navide.browser', viewId, 'agent')
    await expect(registry.cdp('navide.browser', viewId, 'Runtime.evaluate', {})).resolves.toBeDefined()
    registry.setOwner('navide.browser', viewId, 'user')
    expect((await rejectionOf(registry.cdp('navide.browser', viewId, 'Runtime.evaluate', {}))).reason).toBe('user-owned')
    expect(errorOf(() => registry.returnControl('navide.browser', viewId)).reason).toBe('user-owned')
    expect(errorOf(() => registry.setState('navide.browser', viewId, 'done')).reason).toBe('user-owned')
  })
})

describe('agent script since load', () => {
  it('is set by Runtime.evaluate and callFunctionOn and cleared when the main frame loads a new document', async () => {
    const { registry, views } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    const contents = views[0].webContents
    const flag = () => registry.list('navide.browser')[0].agentScriptSinceLoad
    expect(flag()).toBe(false)
    await registry.cdp('navide.browser', viewId, 'DOMSnapshot.captureSnapshot', {})
    await registry.cdp('navide.browser', viewId, 'Input.insertText', { text: 'a' })
    expect(flag()).toBe(false)
    await registry.cdp('navide.browser', viewId, 'Runtime.evaluate', { expression: '1' })
    expect(flag()).toBe(true)
    contents.emit('did-navigate-in-page', {}, 'https://example.com/#a', true)
    expect(flag()).toBe(true)
    contents.emit('did-navigate', {}, 'https://example.com/next')
    expect(flag()).toBe(false)
    await registry.cdp('navide.browser', viewId, 'Runtime.callFunctionOn', { functionDeclaration: 'function () {}' })
    expect(flag()).toBe(true)
  })

  it('stays set when the main frame commits a new document while the script is in flight', async () => {
    const { registry, views } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    const contents = views[0].webContents
    const flag = () => registry.list('navide.browser')[0].agentScriptSinceLoad
    // The evaluate can land in the document that commits while it is on the wire.
    contents.debugger.sendCommand = async () => {
      contents.emit('did-navigate', {}, 'https://example.com/next')
      return {}
    }
    await registry.cdp('navide.browser', viewId, 'Runtime.evaluate', { expression: '1' })
    expect(flag()).toBe(true)
    contents.debugger.sendCommand = async () => {
      contents.emit('did-navigate', {}, 'https://example.com/again')
      throw new Error('Execution context was destroyed.')
    }
    await expect(registry.cdp('navide.browser', viewId, 'Runtime.callFunctionOn', {})).rejects.toBeDefined()
    expect(flag()).toBe(true)
  })

  it('reloads the page when the agent hands it to the user with its script in it', async () => {
    const { registry, views } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    await registry.cdp('navide.browser', viewId, 'Runtime.evaluate', { expression: '1' })
    registry.setState('navide.browser', viewId, 'need-action', 'Sign In')
    expect(views[0].webContents.reloads).toBe(1)
    expect(registry.list('navide.browser')[0]).toMatchObject({ control: 'user', state: 'need-action' })
  })

  it('does not reload on an agent hand-off when the agent ran no script in the page', async () => {
    const { registry, views } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    await registry.cdp('navide.browser', viewId, 'Input.insertText', { text: 'a' })
    registry.setState('navide.browser', viewId, 'need-action', 'Sign In')
    expect(views[0].webContents.reloads).toBe(0)
    expect(registry.list('navide.browser')[0]).toMatchObject({ control: 'user', state: 'need-action', agentScriptSinceLoad: false })
  })

  it('never reloads when the user takes over by clicking, typing or the take-over button', async () => {
    const { registry, views, sessions } = setup()
    const takeovers: Array<(viewId: string, contents: (typeof views)[number]['webContents']) => void> = [
      (_viewId, contents) => contents.emit('before-mouse-event', {}, { type: 'mouseDown' }),
      (_viewId, contents) => contents.emit('before-input-event', {}, { type: 'keyDown' }),
      (viewId) => registry.takeControl('navide.browser', viewId),
      (_viewId, contents) => sessions.get('persist:navide-web:navide.browser')!.permissionHandler?.(contents, 'geolocation', () => {}),
      (viewId) => registry.setOwner('navide.browser', viewId, 'user'),
    ]
    for (const [index, takeOver] of takeovers.entries()) {
      const { viewId } = registry.create('navide.browser', { space: `agent-${index}` }, 'agent')
      const contents = views[index].webContents
      await registry.cdp('navide.browser', viewId, 'Runtime.evaluate', { expression: '1' })
      takeOver(viewId, contents)
      expect(contents.reloads, `takeover ${index}`).toBe(0)
      expect(registry.list('navide.browser').find(view => view.viewId === viewId)?.agentScriptSinceLoad, `takeover ${index}`).toBe(true)
    }
  })
})

describe('cdp scope', () => {
  it('refuses methods that reach past the page', async () => {
    const { registry, views } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    for (const method of [
      'Target.createTarget',
      'Browser.setDownloadBehavior',
      'Page.setDownloadBehavior',
      'DOM.setFileInputFiles',
      'Input.dispatchDragEvent',
      'Network.loadNetworkResource',
      'Storage.clearDataForOrigin',
      'SystemInfo.getInfo',
      'IO.read',
    ]) {
      expect((await rejectionOf(registry.cdp('navide.browser', viewId, method, {}))).code, method).toBe('CAPABILITY_DENIED')
    }
    expect((await rejectionOf(registry.cdp('navide.browser', viewId, 'Page.navigate', { url: 'file:///etc/hosts' }))).code)
      .toBe('INVALID_ARGUMENT')
    expect(views[0].webContents.sent).toEqual([])
    await registry.cdp('navide.browser', viewId, 'Page.navigate', { url: 'https://example.com/' })
    await registry.cdp('navide.browser', viewId, 'Accessibility.getFullAXTree', {})
    // Page.enable is the Host's own, sent once when it attaches the debugger.
    expect(views[0].webContents.sent.map(entry => entry.method)).toEqual(['Page.enable', 'Page.navigate', 'Accessibility.getFullAXTree'])
  })

  it('refuses cookie, cache, interception and persistent-injection methods inside page domains', async () => {
    const { registry, views } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    for (const method of [
      'Network.getCookies',
      'Network.getAllCookies',
      'Network.setCookie',
      'Network.setCookies',
      'Network.deleteCookies',
      'Network.clearBrowserCookies',
      'Network.clearBrowserCache',
      'Network.setRequestInterception',
      'Network.enable',
      'Fetch.enable',
      'Fetch.continueRequest',
      'Fetch.fulfillRequest',
      'Fetch.getResponseBody',
      'Page.addScriptToEvaluateOnNewDocument',
      'Page.reload',
      'Runtime.addBinding',
      'DOMStorage.setDOMStorageItem',
      'DOMStorage.removeDOMStorageItem',
      'DOMStorage.clear',
      'DOMStorage.getDOMStorageItems',
    ]) {
      expect((await rejectionOf(registry.cdp('navide.browser', viewId, method, {}))).code, method).toBe('CAPABILITY_DENIED')
    }
    expect(views[0].webContents.sent).toEqual([])
  })

  it('allows every method the Navide Browser backend sends', async () => {
    const { registry, views } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    const methods = [
      'Accessibility.getFullAXTree',
      'DOM.focus',
      'DOM.getBoxModel',
      'DOM.resolveNode',
      'DOM.scrollIntoViewIfNeeded',
      'DOMSnapshot.captureSnapshot',
      'Input.dispatchKeyEvent',
      'Input.dispatchMouseEvent',
      'Input.insertText',
      'Page.captureScreenshot',
      'Page.getNavigationHistory',
      'Page.handleJavaScriptDialog',
      'Page.navigateToHistoryEntry',
      'Runtime.callFunctionOn',
      'Runtime.evaluate',
    ]
    for (const method of methods) await registry.cdp('navide.browser', viewId, method, {})
    expect(views[0].webContents.sent.map(entry => entry.method)).toEqual(['Page.enable', ...methods])
  })

  it('reports a CDP failure as CDP_ERROR with a bounded message', async () => {
    const { registry, views } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    views[0].webContents.debugger.sendCommand = async () => { throw new Error('No node with given id'.repeat(100)) }
    const error = await rejectionOf(registry.cdp('navide.browser', viewId, 'DOM.resolveNode', { backendNodeId: 1 }))
    expect(error.code).toBe('CDP_ERROR')
    expect(error.message.length).toBeLessThanOrEqual(500)
  })
})

describe('attach and lifecycle', () => {
  it('starts agent views in the background, unthrottled and unattached', () => {
    const { registry, views } = setup()
    registry.create('navide.browser', { space: 'agent' }, 'agent')
    expect(views[0].options.backgroundThrottling).toBe(false)
    expect(views[0].visible).toBe(false)
    expect(registry.list('navide.browser')[0]).toMatchObject({ owner: 'agent', control: 'agent', state: 'running', attached: false })
  })

  it('places the view relative to the plugin view, clamped inside it', () => {
    const { registry, views } = setup()
    const surface = host()
    const { viewId } = registry.create('navide.browser', { space: 'a' }, 'user')
    registry.attach('navide.browser', viewId, { x: 10, y: 20, width: 5000, height: 300 }, surface)
    expect(surface.children).toEqual([views[0]])
    expect(views[0].bounds).toEqual({ x: 110, y: 70, width: 790, height: 300 })
    expect(views[0].visible).toBe(true)
    surface.rect = { x: 0, y: 0, width: 400, height: 200 }
    registry.hostChanged('host-1')
    expect(views[0].bounds).toEqual({ x: 10, y: 20, width: 390, height: 180 })
    surface.shown = false
    registry.hostChanged('host-1')
    expect(views[0].visible).toBe(false)
  })

  it('keeps several views attached at once, each at its own clamped rect', () => {
    const { registry, views } = setup()
    const surface = host()
    const first = registry.create('navide.browser', { space: 'a' }, 'user')
    const second = registry.create('navide.browser', { space: 'b' }, 'user')
    registry.attach('navide.browser', first.viewId, { x: 0, y: 0, width: 400, height: 300 }, surface)
    registry.attach('navide.browser', second.viewId, { x: 400, y: 300, width: 9000, height: 9000 }, surface)
    expect(surface.children).toEqual([views[0], views[1]])
    expect(registry.list('navide.browser').map(view => view.attached)).toEqual([true, true])
    expect(views[0].bounds).toEqual({ x: 100, y: 50, width: 400, height: 300 })
    expect(views[1].bounds).toEqual({ x: 500, y: 350, width: 400, height: 300 })
    surface.rect = { x: 0, y: 0, width: 600, height: 400 }
    registry.hostChanged('host-1')
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 400, height: 300 })
    expect(views[1].bounds).toEqual({ x: 400, y: 300, width: 200, height: 100 })
    registry.hostClosed('host-1')
    expect(surface.children).toEqual([])
    expect(registry.list('navide.browser').map(view => view.attached)).toEqual([false, false])
  })

  it('moves a view attached to another host instead of attaching it twice', () => {
    const { registry, views } = setup()
    const one = host('host-1')
    const two = host('host-2')
    const { viewId } = registry.create('navide.browser', { space: 'a' }, 'user')
    const rect = { x: 0, y: 0, width: 100, height: 100 }
    registry.attach('navide.browser', viewId, rect, one)
    registry.attach('navide.browser', viewId, rect, two)
    expect(one.children).toEqual([])
    expect(two.children).toEqual([views[0]])
  })

  it('refuses a view past the attach cap with LIMIT_REACHED and keeps the others', () => {
    const { registry, views } = setup()
    const surface = host()
    const rect = { x: 0, y: 0, width: 10, height: 10 }
    const ids = Array.from({ length: MAX_ATTACHED_VIEWS + 1 }, (_, index) =>
      registry.create('navide.browser', { space: `s-${index}` }, 'user').viewId)
    for (const viewId of ids.slice(0, MAX_ATTACHED_VIEWS)) registry.attach('navide.browser', viewId, rect, surface)
    expect(errorOf(() => registry.attach('navide.browser', ids[MAX_ATTACHED_VIEWS], rect, surface)).code).toBe('LIMIT_REACHED')
    expect(surface.children).toEqual(views.slice(0, MAX_ATTACHED_VIEWS))
    // Re-placing an attached view is not a new attach, and a detach frees a slot.
    registry.attach('navide.browser', ids[0], { x: 5, y: 5, width: 10, height: 10 }, surface)
    registry.detach('navide.browser', ids[1])
    registry.attach('navide.browser', ids[MAX_ATTACHED_VIEWS], rect, surface)
    expect(registry.list('navide.browser').filter(view => view.attached)).toHaveLength(MAX_ATTACHED_VIEWS)
    // The cap is per plugin.
    const other = registry.create('acme.web', { space: 'x' }, 'user')
    registry.attach('acme.web', other.viewId, rect, host('acme-host'))
  })

  it('refuses a view past the per-plugin cap with LIMIT_REACHED', () => {
    const { registry } = setup()
    const ids = Array.from({ length: MAX_VIEWS_PER_PLUGIN }, (_, index) =>
      registry.create('navide.browser', { space: `s-${index}` }, index % 2 === 0 ? 'user' : 'agent').viewId)
    expect(errorOf(() => registry.create('navide.browser', { space: 'more' }, 'user')).code).toBe('LIMIT_REACHED')
    expect(errorOf(() => registry.create('navide.browser', { space: 'more' }, 'agent', { paneId: 'p', workspace: '/w' })).code)
      .toBe('LIMIT_REACHED')
    expect(registry.create('acme.web', { space: 'x' }, 'user').viewId).toEqual(expect.any(String))
    registry.close('navide.browser', ids[0], false)
    expect(registry.create('navide.browser', { space: 'again' }, 'user').viewId).toEqual(expect.any(String))
  })

  it('keeps views running when their window closes and destroys them with the plugin', () => {
    const { registry, views } = setup()
    const surface = host()
    const { viewId } = registry.create('navide.browser', { space: 'a' }, 'agent')
    registry.attach('navide.browser', viewId, { x: 0, y: 0, width: 10, height: 10 }, surface)
    registry.hostClosed('host-1')
    expect(surface.children).toEqual([])
    expect(views[0].webContents.closed).toBe(0)
    expect(registry.list('navide.browser')[0].attached).toBe(false)
    registry.destroyPlugin('navide.browser')
    expect(views[0].webContents.closed).toBe(1)
    expect(registry.list('navide.browser')).toEqual([])
  })

  it('creates a 17th Space and more, each in the plugin partition and kept to the pane that created it', () => {
    const { registry, views } = setup()
    const panes = Array.from({ length: 20 }, (_, index) => ({ paneId: `p-${index}`, workspace: '/w' }))
    const created = panes.map((pane, index) => registry.create('navide.browser', { space: `pane-${index}` }, 'agent', pane).viewId)
    registry.create('acme.web', { space: 'other' }, 'user')
    expect(new Set(created).size).toBe(20)
    expect(views.slice(0, 20).map((view) => view.options.partition)).toEqual(Array(20).fill(webPartitionFor('navide.browser')))
    expect(views[20].options.partition).toBe(webPartitionFor('acme.web'))
    for (const [index, pane] of panes.entries()) {
      expect(registry.list('navide.browser', pane).map((view) => view.viewId)).toEqual([created[index]])
    }
  })

  it('coalesces change notifications per plugin', async () => {
    const { registry, changes } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'a' }, 'agent')
    registry.setState('navide.browser', viewId, 'done')
    await nextTick()
    expect(changes).toHaveLength(1)
    expect(changes[0].views[0]).toMatchObject({ viewId, state: 'done' })
  })

  it('captures a JPEG data URL', async () => {
    const { registry } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'a' }, 'agent')
    await expect(registry.capture('navide.browser', viewId, 200)).resolves.toEqual({
      dataUrl: `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`,
    })
  })
})

describe('javascript dialogs', () => {
  async function agentView() {
    const env = setup()
    const { viewId } = env.registry.create('navide.browser', { space: 'agent' }, 'agent')
    const contents = env.views[0].webContents
    await env.registry.cdp('navide.browser', viewId, 'Runtime.evaluate', { expression: '1' })
    const info = () => env.registry.list('navide.browser')[0]
    return { ...env, viewId, contents, info }
  }

  it('enables the Page domain once per debugger attach', async () => {
    const { registry, viewId, contents } = await agentView()
    await registry.cdp('navide.browser', viewId, 'Runtime.evaluate', { expression: '2' })
    expect(contents.sent.filter(entry => entry.method === 'Page.enable')).toHaveLength(1)
    registry.takeControl('navide.browser', viewId)
    registry.returnControl('navide.browser', viewId)
    await registry.cdp('navide.browser', viewId, 'Runtime.evaluate', { expression: '3' })
    expect(contents.sent.filter(entry => entry.method === 'Page.enable')).toHaveLength(2)
    // One listener however often the debugger attaches.
    expect(contents.debuggerEvents.listeners.get('message')).toHaveLength(1)
  })

  it('records an opening dialog, truncated, and clears it when it closes', async () => {
    const { registry, contents, info, changes } = await agentView()
    expect(info()).not.toHaveProperty('dialog')
    contents.debuggerEvents.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'm'.repeat(800), defaultPrompt: 'd'.repeat(800), url: 'https://example.com/' })
    expect(info().dialog).toEqual({ type: 'prompt', message: 'm'.repeat(500), defaultPrompt: 'd'.repeat(500) })
    await nextTick()
    expect(changes.at(-1)?.views[0].dialog?.type).toBe('prompt')
    contents.debuggerEvents.emit('message', {}, 'Page.javascriptDialogClosed', { result: true })
    expect(info()).not.toHaveProperty('dialog')
    contents.debuggerEvents.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert', message: 'hi', defaultPrompt: 'ignored' })
    expect(info().dialog).toEqual({ type: 'alert', message: 'hi' })
    contents.debuggerEvents.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'unknown', message: 'x' })
    expect(info().dialog).toEqual({ type: 'alert', message: 'hi' })
    await expect(registry.cdp('navide.browser', registry.list('navide.browser')[0].viewId, 'Page.handleJavaScriptDialog', { accept: true }))
      .resolves.toEqual({ ok: 'Page.handleJavaScriptDialog' })
  })

  it('clears the dialog when the debugger detaches and when the main frame navigates', async () => {
    const { registry, viewId, contents, info } = await agentView()
    contents.debuggerEvents.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Leave?' })
    expect(info().dialog?.type).toBe('confirm')
    registry.takeControl('navide.browser', viewId)
    expect(contents.attached).toBe(false)
    expect(info()).not.toHaveProperty('dialog')
    registry.returnControl('navide.browser', viewId)
    await registry.cdp('navide.browser', viewId, 'Runtime.evaluate', { expression: '1' })
    contents.debuggerEvents.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'beforeunload', message: '' })
    expect(info().dialog?.type).toBe('beforeunload')
    contents.emit('did-navigate', {}, 'https://example.com/next')
    expect(info()).not.toHaveProperty('dialog')
  })

  it('never lets the plugin send Page.enable itself', async () => {
    const { registry } = setup()
    const { viewId } = registry.create('navide.browser', { space: 'agent' }, 'agent')
    expect((await rejectionOf(registry.cdp('navide.browser', viewId, 'Page.enable', {}))).code).toBe('CAPABILITY_DENIED')
  })
})

describe('file upload', () => {
  const temps: string[] = []
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function fixture() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'navide-web-upload-')))
    temps.push(base)
    const workspace = join(base, 'workspace')
    const outside = join(base, 'outside')
    mkdirSync(join(workspace, 'sub'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(workspace, 'a.txt'), 'a')
    writeFileSync(join(workspace, 'sub', 'b.txt'), 'b')
    writeFileSync(join(outside, 'secret.txt'), 's')
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link.txt'))
    symlinkSync(join(workspace, 'a.txt'), join(outside, 'into.txt'))
    // A sibling whose name starts with the workspace's.
    mkdirSync(`${workspace}-evil`)
    writeFileSync(join(`${workspace}-evil`, 'c.txt'), 'c')
    const env = setup()
    const caller = { paneId: 'p-a', workspace }
    const { viewId } = env.registry.create('navide.browser', { space: 'task' }, 'agent', caller)
    return { ...env, base, workspace, outside, caller, viewId }
  }

  const upload = (files: unknown) => ({ backendNodeId: 7, files })

  it('passes Host-private copies of files inside the calling pane workspace, with the other params as they were', async () => {
    const { registry, views, workspace, outside, caller, viewId } = fixture()
    await registry.cdp('navide.browser', viewId, 'DOM.setFileInputFiles', upload([join(workspace, 'a.txt'), join(workspace, 'sub', 'b.txt'), join(outside, 'into.txt')]), caller)
    const sent = views[0].webContents.sent.at(-1)!
    expect(sent.method).toBe('DOM.setFileInputFiles')
    const files = (sent.params as { backendNodeId: number; files: string[] }).files
    expect((sent.params as { backendNodeId: number }).backendNodeId).toBe(7)
    // The page gets copies, never a workspace path it could later read through a swapped link.
    expect(files.map((file) => basename(file))).toEqual(['a.txt', 'b.txt', 'a.txt'])
    for (const file of files) expect(file.startsWith(workspace)).toBe(false)
    expect(files.map((file) => readFileSync(file, 'utf8'))).toEqual(['a', 'b', 'a'])
    expect(statSync(files[0]).mode & 0o077).toBe(0)
    // A later change to the source does not reach the copy the page holds.
    writeFileSync(join(workspace, 'a.txt'), 'changed')
    expect(readFileSync(files[0], 'utf8')).toBe('a')
    // Closing the view removes its copies.
    registry.close('navide.browser', viewId, true, caller)
    for (const file of files) expect(existsSync(file)).toBe(false)
  })

  it('discloses every upload on the view and in the result, and flags names that look like secrets', async () => {
    const { registry, views, workspace, caller, viewId } = fixture()
    writeFileSync(join(workspace, '.env'), 'K=V')
    mkdirSync(join(workspace, 'keys'))
    writeFileSync(join(workspace, 'keys', 'server.pem'), 'pem')
    await views[0].webContents.loadURL('https://upload.example.com/form?x=1')
    const result = await registry.cdp('navide.browser', viewId, 'DOM.setFileInputFiles',
      upload([join(workspace, 'sub', 'b.txt'), join(workspace, '.env'), join(workspace, 'keys', 'server.pem')]), caller)
    expect(result).toMatchObject({
      ok: 'DOM.setFileInputFiles',
      uploaded: [
        { file: 'sub/b.txt', origin: 'https://upload.example.com', sensitive: false },
        { file: '.env', origin: 'https://upload.example.com', sensitive: true },
        { file: 'keys/server.pem', origin: 'https://upload.example.com', sensitive: true },
      ],
    })
    expect((result as { warning: string }).warning).toContain('.env, keys/server.pem')
    const info = registry.list('navide.browser').find(view => view.viewId === viewId)!
    expect(info.uploads?.map(({ file, origin, sensitive }) => [file, origin, sensitive])).toEqual([
      ['sub/b.txt', 'https://upload.example.com', false],
      ['.env', 'https://upload.example.com', true],
      ['keys/server.pem', 'https://upload.example.com', true],
    ])
    expect(Number.isNaN(Date.parse(info.uploads![0].at))).toBe(false)
    // A plain upload has no warning; the records keep only the newest 20.
    for (let index = 0; index < 20; index++) {
      const plain = await registry.cdp('navide.browser', viewId, 'DOM.setFileInputFiles', upload([join(workspace, 'a.txt')]), caller)
      expect(plain).not.toHaveProperty('warning')
    }
    const uploads = registry.list('navide.browser').find(view => view.viewId === viewId)!.uploads!
    expect(uploads).toHaveLength(20)
    expect(uploads.every(record => record.file === 'a.txt')).toBe(true)
  })

  it('records nothing for a refused upload or a failed command', async () => {
    const { registry, views, outside, workspace, caller, viewId } = fixture()
    await rejectionOf(registry.cdp('navide.browser', viewId, 'DOM.setFileInputFiles', upload([join(outside, 'secret.txt')]), caller))
    views[0].webContents.debugger.sendCommand = async () => { throw new Error('No node with given id') }
    await rejectionOf(registry.cdp('navide.browser', viewId, 'DOM.setFileInputFiles', upload([join(workspace, 'a.txt')]), caller))
    expect(registry.list('navide.browser').find(view => view.viewId === viewId)).not.toHaveProperty('uploads')
  })

  it.each([
    ['.env', true], ['.env.local', true], ['server.pem', true], ['id_ed25519', true], ['id_rsa.pub', true],
    ['aws-credentials.json', true], ['client_secret.json', true], ['github-token.txt', true], ['TOKEN', true],
    ['report.pdf', false], ['environment.md', false], ['photo.png', false], ['identity.txt', false],
  ])('flags %s as secret-looking: %s', (name, expected) => {
    expect(looksSecret(name)).toBe(expected)
  })

  it('refuses files outside the workspace, through a symlink, relative, missing, or not a file', async () => {
    const { registry, views, workspace, outside, caller, viewId } = fixture()
    for (const files of [
      [join(outside, 'secret.txt')],
      [join(workspace, 'link.txt')],
      [join(workspace, '..', 'outside', 'secret.txt')],
      [join(`${workspace}-evil`, 'c.txt')],
      [join(workspace, 'a.txt'), join(outside, 'secret.txt')],
      ['a.txt'],
      [join(workspace, 'missing.txt')],
      [join(workspace, 'sub')],
      [workspace],
      [7],
      [],
      join(workspace, 'a.txt'),
      undefined,
      Array(17).fill(join(workspace, 'a.txt')),
    ]) {
      const error = await rejectionOf(registry.cdp('navide.browser', viewId, 'DOM.setFileInputFiles', upload(files), caller))
      expect(error.code, JSON.stringify(files)).toBe('CAPABILITY_DENIED')
    }
    expect(views[0].webContents.sent).toEqual([])
    await registry.cdp('navide.browser', viewId, 'DOM.setFileInputFiles', upload(Array(16).fill(join(workspace, 'a.txt'))), caller)
    expect(views[0].webContents.sent.at(-1)?.method).toBe('DOM.setFileInputFiles')
  })

  it('refuses an upload with no caller, a caller without a workspace, or a workspace at the root', async () => {
    const { registry, views, workspace } = fixture()
    const shared = registry.create('navide.browser', { space: 'shared' }, 'user')
    registry.setOwner('navide.browser', shared.viewId, 'agent')
    const files = upload([join(workspace, 'a.txt')])
    for (const caller of [undefined, { paneId: null, workspace: null }, { paneId: 'p-a', workspace: 'relative/ws' }, { paneId: 'p-a', workspace: '/' }, { paneId: 'p-a', workspace: join(workspace, 'gone') }]) {
      const error = await rejectionOf(registry.cdp('navide.browser', shared.viewId, 'DOM.setFileInputFiles', files, caller))
      expect(error.code, JSON.stringify(caller)).toBe('CAPABILITY_DENIED')
    }
    expect(views[1].webContents.sent).toEqual([])
  })
})
