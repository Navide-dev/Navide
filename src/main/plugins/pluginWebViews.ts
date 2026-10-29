import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, parse, sep } from 'node:path'
import {
  isAllowedWebUrl,
  type WebAgentCaller,
  type WebControlReason,
  type WebViewControl,
  type WebViewDialog,
  type WebViewInfo,
  type WebViewOwner,
  type WebViewRect,
  type WebViewState,
} from './webCapability'

/** Host side of the `web` system namespace: plugin-owned browser views.
 *
 * Every boundary that keeps a plugin (and the agent driving its backend) in
 * its lane lives here, not in the plugin: one persistent partition per
 * plugin, a sandboxed guest with no preload, an http(s)-only navigation
 * allowlist, denied permission requests, the owner/control flags that make
 * `cdp` answer USER_IN_CONTROL, a per-method CDP allowlist that keeps the
 * debugger inside the page (no cookies, no interception, no persistent
 * scripts, no download directory, no other targets; file chooser paths only
 * for regular files inside the calling pane's workspace), and per-plugin caps
 * on live and attached views. The Electron objects are injected so the rules
 * are tested without a browser. */

export type WebViewErrorCode =
  | 'INVALID_ARGUMENT'
  | 'USER_IN_CONTROL'
  | 'CAPABILITY_DENIED'
  | 'CDP_ERROR'
  | 'LIMIT_REACHED'

export class WebViewError extends Error {
  readonly code: WebViewErrorCode
  readonly reason: WebControlReason | undefined

  constructor(code: WebViewErrorCode, options: { reason?: WebControlReason; message?: string } = {}) {
    super(options.message ?? code)
    this.name = 'WebViewError'
    this.code = code
    this.reason = options.reason
  }
}

type Listener = (...args: any[]) => void

/** The subset of Electron's WebContents the registry uses. */
export interface WebGuestContents {
  isDestroyed(): boolean
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  stop(): void
  reload(): void
  close(): void
  on(event: string, listener: Listener): unknown
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  capturePage(): Promise<{ isEmpty(): boolean; getSize(): { width: number; height: number }; resize(options: { width: number }): { toJPEG(quality: number): Buffer } ; toJPEG(quality: number): Buffer }>
  navigationHistory: { canGoBack(): boolean; canGoForward(): boolean; goBack(): void; goForward(): void }
  debugger: {
    isAttached(): boolean
    attach(protocolVersion?: string): void
    detach(): void
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
    on(event: string, listener: Listener): unknown
  }
}

export interface WebGuestView {
  readonly webContents: WebGuestContents
  setBounds(rect: WebViewRect): void
  setVisible(visible: boolean): void
}

export interface WebGuestSession {
  setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void): void
  setPermissionCheckHandler(handler: () => boolean): void
  setDisplayMediaRequestHandler(handler: (request: unknown, callback: (streams: Record<string, never>) => void) => void): void
  on(event: string, listener: Listener): unknown
  clearStorageData(): Promise<void>
  clearCache(): Promise<void>
  clearAuthCache(): Promise<void>
  clearHostResolverCache(): Promise<void>
}

/** The plugin view a web view is stacked on: its window's content view and
 *  the plugin view's own bounds in window coordinates. */
export interface WebHostSurface {
  readonly key: string
  addChildView(view: WebGuestView): void
  removeChildView(view: WebGuestView): void
  /** Plugin view bounds in window coordinates; null when the surface is gone. */
  bounds(): WebViewRect | null
  visible(): boolean
}

export interface PluginWebViewDeps {
  createView(options: { partition: string; backgroundThrottling: boolean }): WebGuestView
  session(partition: string): WebGuestSession
  /** Called (coalesced per microtask) whenever a plugin's view list changes. */
  onChanged(pluginId: string, views: WebViewInfo[]): void
}

export const DEFAULT_CAPTURE_WIDTH = 480
const CDP_PROTOCOL_VERSION = '1.3'
const MAX_CDP_ERROR_MESSAGE = 500
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Live views per plugin; `create` and popups past it are LIMIT_REACHED. */
export const MAX_VIEWS_PER_PLUGIN = 32
/** Views one plugin may have attached at once (a 3×3 grid of Spaces). */
export const MAX_ATTACHED_VIEWS = 9
const MAX_DIALOG_TEXT = 500
const MAX_UPLOAD_FILES = 16
const DIALOG_TYPES: readonly string[] = ['alert', 'confirm', 'prompt', 'beforeunload']

/** The only CDP methods the plugin may send: exactly what the Navide Browser
 *  backend uses to read and drive a page. Anything else is refused, which
 *  keeps out the cookie jar (shared with the user's own Spaces), the cache,
 *  request interception (`Fetch.*`, `Network.setRequestInterception`),
 *  scripts and bindings that outlive a page (`Page.addScriptToEvaluateOnNewDocument`,
 *  `Runtime.addBinding`), DOM storage, the download directory and every other
 *  target. `DOM.setFileInputFiles` is allowed only with files the Host checked
 *  are regular files inside the calling pane's workspace; `Page.enable` is the
 *  Host's own (for dialog events), never the plugin's. */
const CDP_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'Accessibility.getFullAXTree',
  'DOM.focus',
  'DOM.getBoxModel',
  'DOM.resolveNode',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.setFileInputFiles',
  'DOMSnapshot.captureSnapshot',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Page.captureScreenshot',
  'Page.getNavigationHistory',
  'Page.handleJavaScriptDialog',
  'Page.navigate',
  'Page.navigateToHistoryEntry',
  'Runtime.callFunctionOn',
  'Runtime.evaluate',
])

/** Persistent partition for one plugin's web views (kept across restarts). */
export function webPartitionFor(pluginId: string): string {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) throw new WebViewError('INVALID_ARGUMENT')
  return `persist:navide-web:${pluginId}`
}

/** Guests that the global `web-contents-created` navigation block must skip:
 *  their navigation is governed by the registry's own allowlist instead. */
const guestContents = new WeakSet<object>()

function mayUse(entry: WebViewEntry, caller: WebAgentCaller): boolean {
  return entry.agentPane === null
    || (entry.agentPane.paneId === caller.paneId && entry.agentPane.workspace === caller.workspace)
}

export function isPluginWebGuest(contents: object): boolean {
  return guestContents.has(contents)
}

interface WebViewEntry {
  readonly viewId: string
  readonly pluginId: string
  readonly space: string
  readonly view: WebGuestView
  owner: WebViewOwner
  /** The pane (in its workspace) that created an agent view. Null for a
   *  Space the user owns or handed to agents: any pane may use that one. */
  agentPane: WebAgentCaller | null
  control: WebViewControl
  reason: WebControlReason | undefined
  state: WebViewState
  note: string | undefined
  host: WebHostSurface | null
  rect: WebViewRect | null
  /** In-flight CDP Input.* calls: input observed meanwhile is the agent's. */
  agentInput: number
  /** The agent ran script in the current document (Runtime.evaluate or
   *  callFunctionOn); it may outlive a detach until the next document. */
  agentScriptSinceLoad: boolean
  /** The view whose window.open created this one. */
  readonly openerViewId: string | undefined
  /** A JS dialog open in the page, seen through the agent's debugger. */
  dialog: WebViewDialog | null
  /** The debugger 'message' listener is installed (once per contents). */
  dialogListener: boolean
}

export class PluginWebViewRegistry {
  private readonly views = new Map<string, WebViewEntry>()
  private readonly guardedSessions = new Set<string>()
  private readonly pendingChanges = new Set<string>()

  constructor(private readonly deps: PluginWebViewDeps) {}

  /** With `caller` (the bridge), another pane's views are left out. */
  list(pluginId: string, caller?: WebAgentCaller): WebViewInfo[] {
    return [...this.views.values()]
      .filter(entry => entry.pluginId === pluginId && (caller === undefined || mayUse(entry, caller)))
      .map(entry => this.info(entry))
  }

  /** `web.create` (owner user) or bridge `create` (owner agent, for `caller`). */
  create(
    pluginId: string,
    request: { space: string; url?: string },
    owner: WebViewOwner,
    caller?: WebAgentCaller,
  ): { viewId: string } {
    return this.spawn(pluginId, request, owner, owner === 'agent' && caller ? { ...caller } : null, undefined)
  }

  /** `create` and popups: every view goes through the same guards. */
  private spawn(
    pluginId: string,
    request: { space: string; url?: string },
    owner: WebViewOwner,
    agentPane: WebAgentCaller | null,
    openerViewId: string | undefined,
  ): { viewId: string } {
    const partition = webPartitionFor(pluginId)
    if (request.url !== undefined && !isAllowedWebUrl(request.url)) throw new WebViewError('INVALID_ARGUMENT')
    if (this.countViews(pluginId, false) >= MAX_VIEWS_PER_PLUGIN) throw new WebViewError('LIMIT_REACHED')
    this.guardSession(partition)
    // An agent's view runs in the background, never attached: it must not be
    // throttled while nobody watches it.
    const view = this.deps.createView({ partition, backgroundThrottling: owner !== 'agent' })
    guestContents.add(view.webContents)
    const entry: WebViewEntry = {
      viewId: randomUUID(),
      pluginId,
      space: request.space,
      view,
      owner,
      agentPane,
      control: owner,
      reason: owner === 'user' ? 'user-owned' : undefined,
      state: owner === 'agent' ? 'running' : 'idle',
      note: undefined,
      host: null,
      rect: null,
      agentInput: 0,
      agentScriptSinceLoad: false,
      openerViewId,
      dialog: null,
      dialogListener: false,
    }
    this.views.set(entry.viewId, entry)
    this.wireGuest(entry)
    view.setVisible(false)
    void view.webContents.loadURL(request.url ?? 'about:blank').catch(() => undefined)
    this.changed(pluginId)
    return { viewId: entry.viewId }
  }

  /** Stack the view on the caller's plugin view at its own rect; several
   *  views may be attached at once, up to MAX_ATTACHED_VIEWS per plugin. */
  attach(pluginId: string, viewId: string, rect: WebViewRect, host: WebHostSurface): void {
    const entry = this.entry(pluginId, viewId)
    if (!entry.host && this.countViews(pluginId, true) >= MAX_ATTACHED_VIEWS) throw new WebViewError('LIMIT_REACHED')
    if (entry.host && entry.host.key !== host.key) this.detachEntry(entry)
    if (!entry.host) {
      host.addChildView(entry.view)
      entry.host = host
    }
    entry.rect = { ...rect }
    this.layout(entry)
    this.changed(pluginId)
  }

  detach(pluginId: string, viewId: string): void {
    const entry = this.entry(pluginId, viewId)
    if (!entry.host) return
    this.detachEntry(entry)
    this.changed(pluginId)
  }

  /** Re-place every view stacked on a host whose bounds or visibility moved. */
  hostChanged(hostKey: string): void {
    for (const entry of this.views.values()) {
      if (entry.host?.key === hostKey) this.layout(entry)
    }
  }

  /** The host surface is going away; its views keep running in the background. */
  hostClosed(hostKey: string): void {
    const plugins = new Set<string>()
    for (const entry of this.views.values()) {
      if (entry.host?.key !== hostKey) continue
      this.detachEntry(entry)
      plugins.add(entry.pluginId)
    }
    for (const pluginId of plugins) this.changed(pluginId)
  }

  /** `web.navigate`: a user action, so an agent's view passes to the user. */
  navigate(pluginId: string, request: { viewId: string; url?: string; action?: 'back' | 'forward' | 'reload' | 'stop' }): void {
    const entry = this.entry(pluginId, request.viewId)
    if (request.url !== undefined && !isAllowedWebUrl(request.url)) throw new WebViewError('INVALID_ARGUMENT')
    this.takeOver(entry, 'manual_takeover')
    const contents = entry.view.webContents
    if (request.url !== undefined) void contents.loadURL(request.url).catch(() => undefined)
    else if (request.action === 'back') { if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack() }
    else if (request.action === 'forward') { if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward() }
    else if (request.action === 'reload') contents.reload()
    else if (request.action === 'stop') contents.stop()
    this.changed(pluginId)
  }

  /** `web.setOwner` (user gesture): hand a Space to the agent or take it back. */
  setOwner(pluginId: string, viewId: string, owner: WebViewOwner): void {
    const entry = this.entry(pluginId, viewId)
    entry.owner = owner
    // A Space the user hands to agents has no pane: any pane may use it.
    entry.agentPane = null
    entry.control = owner
    entry.reason = owner === 'user' ? 'user-owned' : undefined
    if (owner === 'agent' && entry.state === 'need-action') entry.state = 'running'
    if (owner === 'user') this.detachDebugger(entry)
    this.changed(pluginId)
  }

  /** `web.takeControl` (user gesture): the user's "take over" button. */
  takeControl(pluginId: string, viewId: string): void {
    const entry = this.entry(pluginId, viewId)
    this.takeOver(entry, 'manual_takeover')
    this.changed(pluginId)
  }

  /** `web.returnControl` (user gesture): the agent may drive its view again. */
  returnControl(pluginId: string, viewId: string): void {
    const entry = this.entry(pluginId, viewId)
    if (entry.owner !== 'agent') throw new WebViewError('USER_IN_CONTROL', { reason: 'user-owned' })
    entry.control = 'agent'
    entry.reason = undefined
    if (entry.state === 'need-action') entry.state = 'running'
    this.changed(pluginId)
  }

  /** Bridge `setState`: need-action hands control to the user. */
  setState(pluginId: string, viewId: string, state: WebViewState, note?: string, caller?: WebAgentCaller): void {
    const entry = this.entry(pluginId, viewId, caller)
    if (entry.owner !== 'agent') throw new WebViewError('USER_IN_CONTROL', { reason: 'user-owned' })
    entry.state = state
    entry.note = note
    if (state === 'need-action') {
      this.takeOver(entry, 'manual_takeover')
      // The agent asked the user in: there is no user input to lose, so the
      // page its script ran in is reloaded before the user types anything.
      const contents = entry.view.webContents
      if (entry.agentScriptSinceLoad && !contents.isDestroyed()) contents.reload()
    }
    this.changed(pluginId)
  }

  /** `byAgent`: the bridge may only close the agent's own views. */
  close(pluginId: string, viewId: string, byAgent: boolean, caller?: WebAgentCaller): void {
    const entry = this.entry(pluginId, viewId, caller)
    if (byAgent && entry.owner !== 'agent') throw new WebViewError('USER_IN_CONTROL', { reason: 'user-owned' })
    this.destroyEntry(entry)
    this.changed(pluginId)
  }

  /** Bridge `cdp`: only while the agent owns and controls the view. */
  async cdp(
    pluginId: string,
    viewId: string,
    method: string,
    params?: Record<string, unknown>,
    caller?: WebAgentCaller,
  ): Promise<unknown> {
    const entry = this.entry(pluginId, viewId, caller)
    this.assertAgentInControl(entry)
    if (!CDP_ALLOWED_METHODS.has(method)) throw new WebViewError('CAPABILITY_DENIED')
    if (method === 'Page.navigate' && !isAllowedWebUrl(params?.url)) throw new WebViewError('INVALID_ARGUMENT')
    if (method === 'DOM.setFileInputFiles') params = { ...params, files: workspaceFiles(params?.files, caller) }
    const contents = entry.view.webContents
    if (contents.isDestroyed()) throw new WebViewError('INVALID_ARGUMENT')
    if (!contents.debugger.isAttached()) {
      try {
        contents.debugger.attach(CDP_PROTOCOL_VERSION)
      } catch (error) {
        throw new WebViewError('CDP_ERROR', { message: cdpMessage(error) })
      }
      this.watchDialogs(entry)
      // Host-internal: dialog events need the Page domain. Not awaited, so a
      // page blocked on a dialog cannot stall the agent's command behind it.
      try {
        contents.debugger.sendCommand('Page.enable').catch(() => undefined)
      } catch {
        /* Dialog events are a convenience; the agent's command still runs. */
      }
    }
    const script = method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn'
    if (script) entry.agentScriptSinceLoad = true
    const input = method.startsWith('Input.')
    if (input) entry.agentInput += 1
    try {
      return await contents.debugger.sendCommand(method, params)
    } catch (error) {
      throw new WebViewError('CDP_ERROR', { message: cdpMessage(error) })
    } finally {
      if (input) entry.agentInput -= 1
      // A document that committed while the script was in flight may be the one it ran in.
      if (script) entry.agentScriptSinceLoad = true
      // The user may have taken over while the command ran; the next one is refused.
    }
  }

  /** `web.capture`: a JPEG data URL for the Spaces overview card. */
  async capture(pluginId: string, viewId: string, maxWidth = DEFAULT_CAPTURE_WIDTH): Promise<{ dataUrl: string }> {
    const entry = this.entry(pluginId, viewId)
    const image = await entry.view.webContents.capturePage()
    if (image.isEmpty()) return { dataUrl: '' }
    const { width } = image.getSize()
    const jpeg = width > maxWidth ? image.resize({ width: maxWidth }).toJPEG(70) : image.toJPEG(70)
    return { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` }
  }

  /** `web.clearData` (user gesture) and plugin removal: wipe the partition. */
  async clearData(pluginId: string): Promise<void> {
    const session = this.deps.session(webPartitionFor(pluginId))
    await session.clearStorageData()
    await session.clearCache()
    // HTTP auth answers and resolved hosts would otherwise outlive the wipe.
    await session.clearAuthCache()
    await session.clearHostResolverCache()
  }

  /** Plugin disabled, removed or revoked: every view goes. */
  destroyPlugin(pluginId: string): void {
    let any = false
    for (const entry of [...this.views.values()]) {
      if (entry.pluginId !== pluginId) continue
      this.destroyEntry(entry)
      any = true
    }
    if (any) this.changed(pluginId)
  }

  private assertAgentInControl(entry: WebViewEntry): void {
    if (entry.owner !== 'agent') throw new WebViewError('USER_IN_CONTROL', { reason: 'user-owned' })
    if (entry.control !== 'agent') {
      throw new WebViewError('USER_IN_CONTROL', { reason: entry.reason ?? 'manual_takeover' })
    }
  }

  private takeOver(entry: WebViewEntry, reason: WebControlReason): void {
    if (entry.owner !== 'agent' || entry.control === 'user') return
    entry.control = 'user'
    entry.reason = reason
    if (reason === 'permission') entry.state = 'need-action'
    this.detachDebugger(entry)
  }

  /** The user now drives the page: drop the agent's debugger session so
   *  nothing set through it outlives the takeover. The next agent
   *  `cdp`, once control is back, attaches again. Script already running in
   *  the page survives this; only a reload clears it. */
  private detachDebugger(entry: WebViewEntry): void {
    entry.dialog = null
    const contents = entry.view.webContents
    if (contents.isDestroyed()) return
    try {
      if (contents.debugger.isAttached()) contents.debugger.detach()
    } catch {
      /* Detaching a debugger that the page already dropped. */
    }
  }

  private entry(pluginId: string, viewId: string, caller?: WebAgentCaller): WebViewEntry {
    const entry = this.views.get(viewId)
    // Another plugin's or another pane's view id is indistinguishable from an unknown one.
    if (!entry || entry.pluginId !== pluginId) throw new WebViewError('INVALID_ARGUMENT')
    if (caller !== undefined && !mayUse(entry, caller)) throw new WebViewError('INVALID_ARGUMENT')
    return entry
  }

  private info(entry: WebViewEntry): WebViewInfo {
    const contents = entry.view.webContents
    const alive = !contents.isDestroyed()
    return {
      viewId: entry.viewId,
      space: entry.space,
      owner: entry.owner,
      control: entry.control,
      state: entry.state,
      ...(entry.note === undefined ? {} : { note: entry.note }),
      url: alive ? contents.getURL() : '',
      title: alive ? contents.getTitle() : '',
      loading: alive ? contents.isLoading() : false,
      attached: entry.host !== null,
      agentScriptSinceLoad: entry.agentScriptSinceLoad,
      ...(entry.openerViewId === undefined ? {} : { openerViewId: entry.openerViewId }),
      ...(entry.dialog === null ? {} : { dialog: { ...entry.dialog } }),
    }
  }

  private countViews(pluginId: string, attachedOnly: boolean): number {
    let count = 0
    for (const entry of this.views.values()) {
      if (entry.pluginId === pluginId && (!attachedOnly || entry.host !== null)) count += 1
    }
    return count
  }

  /** Once per contents: track JS dialogs through the agent's debugger. The
   *  events only arrive while it is attached with the Page domain enabled. */
  private watchDialogs(entry: WebViewEntry): void {
    if (entry.dialogListener) return
    entry.dialogListener = true
    entry.view.webContents.debugger.on('message', (_event: unknown, method: string, params: Record<string, unknown> | undefined) => {
      if (this.views.get(entry.viewId) !== entry) return
      if (method === 'Page.javascriptDialogOpening') {
        const type = params?.type
        if (typeof type !== 'string' || !DIALOG_TYPES.includes(type)) return
        entry.dialog = {
          type: type as WebViewDialog['type'],
          message: typeof params?.message === 'string' ? params.message.slice(0, MAX_DIALOG_TEXT) : '',
          ...(type === 'prompt' && typeof params?.defaultPrompt === 'string'
            ? { defaultPrompt: params.defaultPrompt.slice(0, MAX_DIALOG_TEXT) }
            : {}),
        }
        this.changed(entry.pluginId)
      } else if (method === 'Page.javascriptDialogClosed') {
        if (entry.dialog === null) return
        entry.dialog = null
        this.changed(entry.pluginId)
      }
    })
  }

  /** A page's window.open: a sibling view in the same Space, with the
   *  opener's owner and pane, through `spawn`'s guards. At the view cap the
   *  URL loads in the opener instead. */
  private openPopup(opener: WebViewEntry, url: string): void {
    if (this.views.get(opener.viewId) !== opener) return
    try {
      this.spawn(opener.pluginId, { space: opener.space, url }, opener.owner,
        opener.agentPane === null ? null : { ...opener.agentPane }, opener.viewId)
    } catch (error) {
      // Only the cap falls back; nothing else may turn a popup into a window.
      if (error instanceof WebViewError && error.code === 'LIMIT_REACHED') {
        void opener.view.webContents.loadURL(url).catch(() => undefined)
      }
    }
  }

  private layout(entry: WebViewEntry): void {
    const host = entry.host
    if (!host || !entry.rect) return
    const bounds = host.bounds()
    if (!bounds || !host.visible()) {
      entry.view.setVisible(false)
      return
    }
    // The rect is relative to the plugin view; clamp it inside that view so a
    // plugin cannot paint a page over the rest of the window.
    const x = Math.min(Math.max(0, Math.round(entry.rect.x)), bounds.width)
    const y = Math.min(Math.max(0, Math.round(entry.rect.y)), bounds.height)
    const width = Math.max(0, Math.min(Math.round(entry.rect.width), bounds.width - x))
    const height = Math.max(0, Math.min(Math.round(entry.rect.height), bounds.height - y))
    entry.view.setBounds({ x: bounds.x + x, y: bounds.y + y, width, height })
    entry.view.setVisible(width > 0 && height > 0)
  }

  private detachEntry(entry: WebViewEntry): void {
    const host = entry.host
    entry.host = null
    entry.rect = null
    entry.view.setVisible(false)
    if (host) {
      try {
        host.removeChildView(entry.view)
      } catch {
        /* The host window is already gone. */
      }
    }
  }

  private destroyEntry(entry: WebViewEntry): void {
    this.detachEntry(entry)
    this.views.delete(entry.viewId)
    const contents = entry.view.webContents
    if (contents.isDestroyed()) return
    try {
      if (contents.debugger.isAttached()) contents.debugger.detach()
    } catch {
      /* Detaching a debugger that the page already dropped. */
    }
    contents.close()
  }

  private changed(pluginId: string): void {
    if (this.pendingChanges.has(pluginId)) return
    this.pendingChanges.add(pluginId)
    queueMicrotask(() => {
      this.pendingChanges.delete(pluginId)
      this.deps.onChanged(pluginId, this.list(pluginId))
    })
  }

  private entryForContents(contents: unknown): WebViewEntry | undefined {
    for (const entry of this.views.values()) {
      if (entry.view.webContents === contents) return entry
    }
    return undefined
  }

  /** Once per partition: deny every permission, device and screen request. */
  private guardSession(partition: string): void {
    if (this.guardedSessions.has(partition)) return
    this.guardedSessions.add(partition)
    const session = this.deps.session(partition)
    session.setPermissionRequestHandler((contents, _permission, callback) => {
      callback(false)
      const entry = this.entryForContents(contents)
      if (entry && entry.owner === 'agent') {
        this.takeOver(entry, 'permission')
        this.changed(entry.pluginId)
      }
    })
    session.setPermissionCheckHandler(() => false)
    session.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    // Downloads would write outside the plugin's reach; not offered yet.
    session.on('will-download', (event: { preventDefault(): void }) => event.preventDefault())
    for (const chooser of ['select-hid-device', 'select-serial-port', 'select-usb-device']) {
      session.on(chooser, (event: { preventDefault(): void }, _details: unknown, callback: (id?: string) => void) => {
        event.preventDefault()
        callback()
      })
    }
  }

  private wireGuest(entry: WebViewEntry): void {
    const contents = entry.view.webContents
    const refuse = (event: { preventDefault(): void }, url: string): void => {
      if (!isAllowedWebUrl(url)) event.preventDefault()
    }
    contents.on('will-navigate', refuse)
    contents.on('will-redirect', refuse)
    contents.on('will-frame-navigate', (event: { preventDefault(): void; url: string; isMainFrame: boolean }) => {
      if (event.isMainFrame && !isAllowedWebUrl(event.url)) event.preventDefault()
    })
    // Browser-initiated loads (history, CDP) skip will-navigate: stop any main
    // frame load that leaves the allowlist after the fact.
    contents.on('did-start-navigation', (event: { url: string; isMainFrame: boolean }) => {
      if (!event.isMainFrame || isAllowedWebUrl(event.url)) return
      contents.stop()
      void contents.loadURL('about:blank').catch(() => undefined)
    })
    // Electron never opens a window: the registry makes the popup a view.
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedWebUrl(url)) this.openPopup(entry, url)
      return { action: 'deny' }
    })
    // Electron's defaults would hand a site the first client certificate in the
    // store and the first Bluetooth device found; refuse both, and cancel HTTP
    // auth prompts, so an agent-opened site learns nothing about this machine.
    // Electron routes the app-level `select-client-certificate` to the
    // requesting webContents, so this covers guests and nothing else.
    contents.on('select-client-certificate', (event: { preventDefault(): void }, _url: string, _list: unknown, callback: () => void) => {
      event.preventDefault()
      callback()
    })
    contents.on('select-bluetooth-device', (event: { preventDefault(): void }, _devices: unknown, callback: (deviceId: string) => void) => {
      event.preventDefault()
      callback('')
    })
    contents.on('login', (event: { preventDefault(): void }, _response: unknown, _authInfo: unknown, callback: () => void) => {
      event.preventDefault()
      callback()
    })
    contents.on('before-input-event', (_event: unknown, input: { type: string }) => {
      if (input.type === 'keyDown' || input.type === 'rawKeyDown' || input.type === 'char') this.userInput(entry)
    })
    contents.on('before-mouse-event', (_event: unknown, mouse: { type: string }) => {
      // Hovering over a page the agent drives is watching, not taking over.
      if (mouse.type === 'mouseDown' || mouse.type === 'mouseWheel') this.userInput(entry)
    })
    // A main-frame navigation (a reload included) replaces the document and
    // with it any script the agent left there; in-page navigations do not.
    contents.on('did-navigate', () => {
      entry.agentScriptSinceLoad = false
      entry.dialog = null
    })
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) {
      contents.on(event, () => this.changed(entry.pluginId))
    }
    contents.on('destroyed', () => {
      if (this.views.get(entry.viewId) !== entry) return
      this.detachEntry(entry)
      this.views.delete(entry.viewId)
      this.changed(entry.pluginId)
    })
  }

  private userInput(entry: WebViewEntry): void {
    if (entry.agentInput > 0 || entry.owner !== 'agent' || entry.control === 'user') return
    this.takeOver(entry, 'manual_takeover')
    this.changed(entry.pluginId)
  }
}

/** `DOM.setFileInputFiles` files: 1 to MAX_UPLOAD_FILES absolute paths, each
 *  (symlinks resolved) a regular file strictly inside the calling pane's
 *  workspace (also resolved). Returns the resolved paths, so what the page
 *  gets is what was checked; anything else is CAPABILITY_DENIED. */
function workspaceFiles(files: unknown, caller: WebAgentCaller | undefined): string[] {
  const deny = (): never => { throw new WebViewError('CAPABILITY_DENIED') }
  if (!caller || typeof caller.workspace !== 'string' || !isAbsolute(caller.workspace)) deny()
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_UPLOAD_FILES) deny()
  let root: string
  try {
    root = realpathSync(caller!.workspace as string)
  } catch {
    return deny()
  }
  // A workspace at the file system root would contain every file.
  if (root === parse(root).root) deny()
  const prefix = root.endsWith(sep) ? root : root + sep
  return (files as unknown[]).map((file) => {
    if (typeof file !== 'string' || !isAbsolute(file)) deny()
    let real: string
    try {
      real = realpathSync(file as string)
      if (!statSync(real).isFile()) deny()
    } catch {
      return deny()
    }
    if (!real.startsWith(prefix)) deny()
    return real
  })
}

function cdpMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, MAX_CDP_ERROR_MESSAGE)
}
