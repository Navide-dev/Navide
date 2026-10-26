import { describe, expect, it, vi } from 'vitest'
import {
  isPluginWebGuest,
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
  readonly debugger = {
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

  it('loads window.open in the same view and never opens a window', () => {
    const { registry, views } = setup()
    registry.create('navide.browser', { space: 'a' }, 'user')
    const contents = views[0].webContents
    expect(contents.windowOpenHandler?.({ url: 'https://example.com/popup' })).toEqual({ action: 'deny' })
    expect(contents.loads.at(-1)).toBe('https://example.com/popup')
    expect(contents.windowOpenHandler?.({ url: 'file:///etc/hosts' })).toEqual({ action: 'deny' })
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
      contents.emit('before-mouse-event', {}, { type: 'mouseDown' })
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
    expect(views[0].webContents.sent.map(entry => entry.method)).toEqual(['Page.navigate', 'Accessibility.getFullAXTree'])
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
      'Page.navigateToHistoryEntry',
      'Runtime.callFunctionOn',
      'Runtime.evaluate',
    ]
    for (const method of methods) await registry.cdp('navide.browser', viewId, method, {})
    expect(views[0].webContents.sent.map(entry => entry.method)).toEqual(methods)
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

  it('keeps only one view attached per plugin', () => {
    const { registry, views } = setup()
    const surface = host()
    const first = registry.create('navide.browser', { space: 'a' }, 'user')
    const second = registry.create('navide.browser', { space: 'b' }, 'user')
    const rect = { x: 0, y: 0, width: 100, height: 100 }
    registry.attach('navide.browser', first.viewId, rect, surface)
    registry.attach('navide.browser', second.viewId, rect, surface)
    expect(surface.children).toEqual([views[1]])
    expect(registry.list('navide.browser').map(view => view.attached)).toEqual([false, true])
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
