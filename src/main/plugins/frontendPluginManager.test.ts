import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import type { ResourceViolation } from './pluginBackendResourceWatchdog'
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { isWindows, platformId, setPlatformId } from '../../shared/osplat'
import { AI_CLI_PROFILES } from '../../shared/aiCliProfiles'
import { backendEntryOnDisk } from './installedPlugins'

// Many real fsyncs per test that no assertion can observe; see tests/support/noFsync.ts.
vi.mock('node:fs', async (importOriginal) =>
  (await import('../../../tests/support/noFsync')).withoutFsyncSync(await importOriginal()))
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../../../tests/support/noFsync')).withoutHandleSync(await importOriginal()))

// A frame on a non-special scheme reports its real origin (`scheme://host`);
// `new URL(url).origin` is opaque ("null") for such schemes, so the fixture
// derives the origin the way Electron does.
function frameOrigin(url: string): string {
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.host}`
}

// The platform to restore after a test that switched it: whatever this file
// saw when it loaded — the host, or an injection from a vitest setup file.
// Restoring to the host instead silently undid that injection for every
// later test in the file (see src/shared/platformBaseline.test.ts).
const BASELINE = platformId()

// The manager imports electron for its view lifecycle. A functional stub backs
// both the registry tests (which touch none of it) and the view-lifecycle tests
// below, which drive open/hide/resize/death paths against fakes. The factory
// exports its captured state as `__mock` (hoisted, so it must be self-contained).
vi.mock('electron', () => {
  type Handler = (...args: unknown[]) => unknown
  const ipcHandlers = new Map<string, Handler>()
  const ipcListeners = new Map<string, Handler>()
  const views: unknown[] = []
  const windows: unknown[] = []
  const frameTokens = new Map<string, unknown>()
  const mainFrames = new Map<number, object>()
  let nextWebContentsId = 1000

  class FakeWebContents {
    id = nextWebContentsId++
    mainFrame = {}
    sent: Array<{ channel: string; args: unknown[] }> = []
    loads: string[] = []
    reloads = 0
    focusCount = 0
    private destroyed = false
    private listeners = new Map<string, Handler[]>()
    constructor() {
      mainFrames.set(this.id, this.mainFrame)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    send(channel: string, ...args: unknown[]): void {
      this.sent.push({ channel, args })
    }
    focus(): void {
      this.focusCount++
    }
    loadURL(url: string): Promise<void> {
      this.loads.push(url)
      return Promise.resolve()
    }
    loadFile(file: string, opts?: { search?: string }): Promise<void> {
      this.loads.push(`${file}${opts?.search ?? ''}`)
      return Promise.resolve()
    }
    reload(): void {
      this.reloads++
    }
    on(event: string, cb: Handler): this {
      const list = this.listeners.get(event) ?? []
      list.push(cb)
      this.listeners.set(event, list)
      return this
    }
    once(event: string, cb: Handler): this {
      const wrapper: Handler = (...args) => {
        this.removeListener(event, wrapper)
        return cb(...args)
      }
      return this.on(event, wrapper)
    }
    removeListener(event: string, cb: Handler): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== cb)
      )
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
    }
    close(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('destroyed')
    }
  }

  class WebContentsView {
    webContents = new FakeWebContents()
    bounds: unknown = null
    visible = false
    constructor(_opts?: unknown) {
      views.push(this)
    }
    setBounds(b: unknown): void {
      this.bounds = b
    }
    getBounds(): unknown {
      return this.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
    }
    setVisible(v: boolean): void {
      this.visible = v
    }
  }

  class MessageChannelMain {
    port1: { on: (event: string, cb: (event: { data: unknown }) => void) => void; postMessage: (data: unknown) => void; close: () => void; start: () => void }
    port2: { on: (event: string, cb: (event: { data: unknown }) => void) => void; postMessage: (data: unknown) => void; close: () => void; start: () => void }
    constructor() {
      const listeners1: Array<(event: { data: unknown }) => void> = []
      const listeners2: Array<(event: { data: unknown }) => void> = []
      const port1 = {
        on: (event: string, cb: (event: { data: unknown }) => void): void => { if (event === 'message') listeners1.push(cb) },
        postMessage: (data: unknown): void => { listeners2.forEach((listener) => listener({ data })) },
        close: vi.fn(), start: vi.fn(),
      }
      const port2 = {
        on: (event: string, cb: (event: { data: unknown }) => void): void => { if (event === 'message') listeners2.push(cb) },
        postMessage: (data: unknown): void => { listeners1.forEach((listener) => listener({ data })) },
        close: vi.fn(), start: vi.fn(),
      }
      this.port1 = port1
      this.port2 = port2
    }
  }

  // Constructed by the manager for dedicated plugin host windows (mini-IDE).
  class BrowserWindow {
    options: Record<string, unknown>
    title: string
    destroyed = false
    minimized = false
    shown = false
    focusCount = 0
    contentBounds = { x: 0, y: 0, width: 1000, height: 700 }
    children: unknown[] = []
    private listeners = new Map<string, Handler[]>()
    private hostContentsListeners = new Map<string, Handler[]>()
    /** The window document's own contents. The manager listens for
     *  `did-start-navigation` here so a host reload reads as a deliberate
     *  teardown of the guests the window carries. Deliberately not a
     *  `FakeWebContents`, which would consume a guest webContents id. */
    webContents = {
      on: (event: string, cb: Handler): void => {
        const list = this.hostContentsListeners.get(event) ?? []
        list.push(cb)
        this.hostContentsListeners.set(event, list)
      },
      removeListener: (event: string, cb: Handler): void => {
        this.hostContentsListeners.set(
          event,
          (this.hostContentsListeners.get(event) ?? []).filter((l) => l !== cb)
        )
      },
      emit: (event: string, ...args: unknown[]): void => {
        for (const cb of [...(this.hostContentsListeners.get(event) ?? [])]) cb(...args)
      },
      send: (): void => {},
    }
    contentView = {
      addChildView: (v: unknown): void => {
        this.children.push(v)
      },
      removeChildView: (v: unknown): void => {
        this.children = this.children.filter((c) => c !== v)
      },
    }
    constructor(options?: Record<string, unknown>) {
      this.options = options ?? {}
      this.title = String(options?.title ?? '')
      windows.push(this)
    }
    setTitle(t: string): void {
      this.title = t
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    isMinimized(): boolean {
      return this.minimized
    }
    restore(): void {
      this.minimized = false
    }
    show(): void {
      this.shown = true
    }
    focus(): void {
      this.focusCount++
    }
    getContentBounds(): { x: number; y: number; width: number; height: number } {
      return { ...this.contentBounds }
    }
    on(event: string, cb: Handler): this {
      const list = this.listeners.get(event) ?? []
      list.push(cb)
      this.listeners.set(event, list)
      return this
    }
    once(event: string, cb: Handler): this {
      const wrapper: Handler = (...args) => {
        this.removeListener(event, wrapper)
        return cb(...args)
      }
      return this.on(event, wrapper)
    }
    removeListener(event: string, cb: Handler): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== cb)
      )
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
    }
    close(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }
  }

  const ipcMain = {
    handle: (channel: string, fn: Handler): void => {
      ipcHandlers.set(channel, (event, ...args) => {
        const senderId = (event as { sender?: { id?: unknown } } | undefined)?.sender?.id
        const senderFrame = (event as { senderFrame?: unknown } | undefined)?.senderFrame
        const normalized = senderFrame === undefined && typeof senderId === 'number'
          ? { ...(event as object), senderFrame: mainFrames.get(senderId) ?? null }
          : event
        return fn(normalized, ...args)
      })
    },
    on: (channel: string, fn: Handler): void => {
      ipcListeners.set(channel, (event, ...args) => {
        const senderId = (event as { sender?: { id?: unknown } } | undefined)?.sender?.id
        const senderFrame = (event as { senderFrame?: unknown } | undefined)?.senderFrame
        const normalized = senderFrame === undefined && typeof senderId === 'number'
          ? { ...(event as object), senderFrame: mainFrames.get(senderId) ?? null }
          : event
        return fn(normalized, ...args)
      })
    },
  }

  return {
    WebContentsView,
    MessageChannelMain,
    webFrameMain: {
      fromFrameToken: (_processId: number, token: string): unknown => frameTokens.get(token) ?? null,
    },
    BrowserWindow,
    ipcMain,
    app: {},
    __mock: { ipcHandlers, ipcListeners, views, windows, frameTokens },
  }
})

const wsMock = vi.hoisted(() => {
  class FakeNodeWebSocket {
    static readonly OPEN = 1
    static readonly CONNECTING = 0
    static readonly CLOSED = 3
    static instances: FakeNodeWebSocket[] = []
    readonly url: string
    readonly sent: string[] = []
    readyState = FakeNodeWebSocket.CONNECTING
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>()

    constructor(url: string) {
      this.url = url
      FakeNodeWebSocket.instances.push(this)
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? []
      listeners.push(listener)
      this.listeners.set(type, listeners)
    }

    send(data: string): void {
      this.sent.push(data)
    }

    close(): void {
      this.readyState = FakeNodeWebSocket.CLOSED
      this.emit('close', {})
    }

    open(): void {
      this.readyState = FakeNodeWebSocket.OPEN
      this.emit('open', {})
    }

    receive(message: unknown): void {
      this.emit('message', { data: JSON.stringify(message) })
    }

    private emit(type: string, event: unknown): void {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    }
  }

  return { FakeNodeWebSocket }
})

vi.mock('ws', () => ({ WebSocket: wsMock.FakeNodeWebSocket }))

// The production web view registry over Electron fakes: the real boundaries in
// PluginWebViewRegistry, with guests and sessions that record what they saw.
const webHostMock = vi.hoisted(() => ({
  hook: null as ((pluginId: string, views: unknown[]) => void) | null,
  guests: [] as Array<{ options: { partition: string; backgroundThrottling: boolean }; bounds: unknown; visible: boolean; webContents: { destroyed: boolean; url: string } }>,
  cleared: [] as string[],
}))
vi.mock('./pluginWebViewHost', async () => {
  const { PluginWebViewRegistry } = await import('./pluginWebViews')
  type Listener = (...args: unknown[]) => void
  const registry = new PluginWebViewRegistry({
    createView: (options) => {
      const listeners = new Map<string, Listener[]>()
      const contents = {
        destroyed: false,
        url: 'about:blank',
        isDestroyed: () => contents.destroyed,
        loadURL: async (url: string) => { contents.url = url },
        getURL: () => contents.url,
        getTitle: () => '',
        isLoading: () => false,
        stop: () => {},
        reload: () => {},
        close: () => {
          contents.destroyed = true
          for (const listener of listeners.get('destroyed') ?? []) listener()
        },
        on: (event: string, listener: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
        setWindowOpenHandler: () => {},
        capturePage: async () => ({
          isEmpty: () => false,
          getSize: () => ({ width: 100, height: 50 }),
          resize: () => ({ toJPEG: () => Buffer.from('jpeg') }),
          toJPEG: () => Buffer.from('jpeg'),
        }),
        navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} },
        debugger: { isAttached: () => false, attach: () => {}, detach: () => {}, sendCommand: async () => ({}) },
      }
      const guest = {
        options,
        bounds: null as unknown,
        visible: true,
        webContents: contents,
        setBounds(rect: unknown) { guest.bounds = rect },
        setVisible(visible: boolean) { guest.visible = visible },
      }
      webHostMock.guests.push(guest)
      return guest
    },
    session: (partition) => ({
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      setDisplayMediaRequestHandler: () => {},
      on: () => undefined,
      clearStorageData: async () => { webHostMock.cleared.push(partition) },
      clearCache: async () => {},
      clearAuthCache: async () => {},
      clearHostResolverCache: async () => {},
    }),
    onChanged: (pluginId, views) => webHostMock.hook?.(pluginId, views),
  })
  return {
    pluginWebViewRegistry: () => registry,
    setPluginWebViewChangedHook: (hook: typeof webHostMock.hook) => { webHostMock.hook = hook },
  }
})

import * as electron from 'electron'
import type { BrowserWindow } from 'electron'
import {
  FrontendPluginManager,
  frontendPluginManager,
  isReservedPluginId,
  devPlansPluginDescriptor,
  devPlansV2PluginBundle,
  devGitPluginDescriptor,
  openMiniIdePluginView,
  openPlansPluginView,
  plansQuery,
  openGitLeftPluginView,
  closeGitLeftPluginView,
  GIT_PLUGIN_ID,
  PLANS_PLUGIN_ID,
  PLANS_BACKEND_STOPPED_MESSAGE,
  MINI_IDE_PLUGIN_ID,
  bundledMiniIdeDir,
  bundledPlansDir,
  bundledPlansV2Dir,
  bundledGitDir,
  officialPluginArtifactPackageDir,
  registerBundledMiniIde,
  registerBundledPlans,
  plansFactoryPackageSummary,
  createPluginBackendChildEnvironment,
  sanitizeDiagnosticLines,
  MAX_DIAGNOSTIC_LINE_CHARS,
  MAX_DIAGNOSTIC_LINES_PER_EMISSION,
  builtinPluginDisabledMessage,
  parseAgentToolCallRequest,
  type PluginLaunchDescriptor,
  type PluginViewLaunchDescriptor,
} from './frontendPluginManager'
import { BACKEND_RESTART_BUDGET_SPENT_MESSAGE, PluginBackendHost } from './pluginBackendHost'
import { splitAgentToolPayloadText, utf8ByteLength } from '../../shared/pluginAgentTools'
import { setMainLedgerDataDir } from '../error-ledger'
import { BackendPluginError, PluginBackendSupervisor } from './pluginBackendSupervisor'
import { EditorSelectionGrants } from './editorSelectionGrants'
import type { PlansBridgeContext } from './plansBridge'
import { manifestV2CapabilityPolicy } from './pluginPermissions'
import { PluginActivationSelector } from './pluginActivationSelector'
import {
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  registryReceiptFromEvidence,
  type InstalledRegistryTrustContext,
} from './pluginInstalledTrust'
import {
  canonicalTrustJson,
  type RegistryPackageEnvelope,
  type RegistryTrustMetadata,
} from './pluginRegistryTrust'
import { sha256Hex } from './pluginVerify'
import { makeZip } from './zipFixture'
import {
  HOST_EVENT_SOURCE_PLUGIN_ID,
  type HostCapabilityContext,
  type StorageSnapshotTier,
} from './pluginCapabilityBroker'
import { PluginStorageError } from './pluginStorage'
import type { ExecutionPolicySnapshot } from './executionPolicy'
import type { JsonValue } from '../../../packages/plugin-contracts/src/index'
import type { FilePickerInvocation } from '../filePicker'
import { NativeBackendStore } from './pluginNativeBackendStore'
import { ThirdPartyBackendController, thirdPartyBackendLaunchSpec } from './pluginThirdPartyBackends'
import { readInstalledManifestV2, type ThirdPartyLaunchSpec } from './pluginThirdPartyBackends'
import { PluginAgentToolsHost } from './pluginAgentToolsHost'
import { pluginWebViewRegistry } from './pluginWebViewHost'
import { HOST_DEFAULT_EXECUTION_POLICY, FAIL_CLOSED_EXECUTION_POLICY } from './executionPolicy'
import { webPolicyDeniedMessage } from '../browserAgentStrings'

interface FakeWebContentsLike {
  id: number
  mainFrame: object
  sent: Array<{ channel: string; args: unknown[] }>
  loads: string[]
  reloads: number
  focusCount: number
  isDestroyed(): boolean
  focus(): void
  emit(event: string, ...args: unknown[]): void
  close(): void
}
interface FakeViewLike {
  webContents: FakeWebContentsLike
  bounds: { x: number; y: number; width: number; height: number } | null
  visible: boolean
}
interface FakeWindowLike {
  options: Record<string, unknown>
  title: string
  destroyed: boolean
  minimized: boolean
  shown: boolean
  focusCount: number
  children: unknown[]
  isDestroyed(): boolean
  close(): void
  emit(event: string, ...args: unknown[]): void
}
const { ipcHandlers, ipcListeners, views, windows, frameTokens } = (
  electron as unknown as {
    __mock: {
      ipcHandlers: Map<string, (...args: unknown[]) => unknown>
      ipcListeners: Map<string, (...args: unknown[]) => unknown>
      views: FakeViewLike[]
      windows: FakeWindowLike[]
      frameTokens: Map<string, unknown>
    }
  }
).__mock

interface FakeHostContents {
  isDestroyed(): boolean
  on(event: string, cb: (...args: unknown[]) => void): void
  removeListener(event: string, cb: (...args: unknown[]) => void): void
  emit(event: string, ...args: unknown[]): void
  send?: (channel: string, ...args: unknown[]) => void
}

/** Host-window fake with just the surface the manager touches. */
class FakeBrowserWindow {
  title = ''
  destroyed = false
  minimized = false
  shown = false
  focusCount = 0
  contentBounds = { x: 0, y: 0, width: 1000, height: 700 }
  children: unknown[] = []
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  private hostContentsListeners = new Map<string, Array<(...args: unknown[]) => void>>()
  /** The host document's own contents. The manager watches it so a reload or
   *  navigation of the host window reads as a deliberate guest teardown.
   *
   *  Assigning to `webContents` *merges* rather than replaces, so the tests
   *  that supply their own `send` spy keep the listener surface the manager
   *  wires up on every open. */
  private hostContents: FakeHostContents = {
    isDestroyed: () => false,
    on: (event, cb) => {
      const list = this.hostContentsListeners.get(event) ?? []
      list.push(cb)
      this.hostContentsListeners.set(event, list)
    },
    removeListener: (event, cb) => {
      this.hostContentsListeners.set(
        event,
        (this.hostContentsListeners.get(event) ?? []).filter((l) => l !== cb)
      )
    },
    emit: (event, ...args) => {
      for (const cb of [...(this.hostContentsListeners.get(event) ?? [])]) cb(...args)
    },
  }
  get webContents(): FakeHostContents {
    return this.hostContents
  }
  set webContents(patch: Partial<FakeHostContents>) {
    Object.assign(this.hostContents, patch)
  }
  contentView = {
    addChildView: (v: unknown): void => {
      this.children.push(v)
    },
    removeChildView: (v: unknown): void => {
      this.children = this.children.filter((c) => c !== v)
    },
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  restore(): void {
    this.minimized = false
  }
  show(): void {
    this.shown = true
  }
  focus(): void {
    this.focusCount++
  }
  getContentBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.contentBounds }
  }
  setTitle(t: string): void {
    this.title = t
  }
  on(event: string, cb: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(cb)
    this.listeners.set(event, list)
    return this
  }
  once(event: string, cb: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.removeListener(event, wrapper)
      cb(...args)
    }
    return this.on(event, wrapper)
  }
  removeListener(event: string, cb: (...args: unknown[]) => void): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((l) => l !== cb)
    )
    return this
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
  }
}

function asHost(win: FakeBrowserWindow): BrowserWindow {
  return win as unknown as BrowserWindow
}

function descriptor(id: string): PluginLaunchDescriptor {
  return { id, requires: [], devUrl: '', entryFile: `/plugins/${id}/index.html` }
}

// The agent-tool path takes a result as text (contract 4.4). Here that text is
// spelled from whatever `call` returns (often a spy), as the supervisor spells
// a value; the supervisor's own tests cover how it keeps text.
beforeEach(() => {
  vi.spyOn(PluginBackendHost.prototype, 'callForResultText').mockImplementation(
    async function (this: PluginBackendHost, instanceId, name, args, options) {
      const value = await this.call(instanceId, name, args, options)
      const text = JSON.stringify(value === undefined ? null : value)
      const pieces = splitAgentToolPayloadText(text)
      return { bytes: utf8ByteLength(text), chunks: pieces.length, piece: (index: number) => pieces[index] }
    },
  )
})

describe('backend Host session registration', () => {
  it('re-registers on the new socket when the previous registration is pending', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    ;(host.webContents as FakeHostContents & { id: number }).id = 7000
    ;(host.webContents as FakeHostContents & { mainFrame: object }).mainFrame = {}
    mgr.open(
      asHost(host),
      { id: 'acme.host-session', requires: ['terminal'], devUrl: '', entryFile: '/plugins/acme.host-session/index.html' },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl('ws://backend-old')
    const oldSocket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    oldSocket.open()
    expect(oldSocket.sent.map((raw) => JSON.parse(raw).type)).toContain('host.register')
    expect(JSON.parse(oldSocket.sent[0]!).payload).toMatchObject({
      features: { plans_backend_v2: false },
    })

    mgr.setBackendWsUrl('ws://backend-new')
    const newSocket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    newSocket.open()

    expect(newSocket.sent.map((raw) => JSON.parse(raw).type)).toContain('host.register')
  })

  it('advertises Plans support only after its exact v2 backend activation is registered', () => {
    const mgr = new FrontendPluginManager()
    mgr.open(
      asHost(new FakeBrowserWindow()),
      { id: 'acme.host-session-plans', requires: ['terminal'], devUrl: '', entryFile: '/plugins/acme.host-session-plans/index.html' },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion: '1.0.0',
      packageDir: process.cwd(),
      requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '',
      entryFile: '/plugins/navide.plans/index.html',
      views: [],
    }, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion: '1.0.0',
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: '1.0.0',
      system: ['fs'],
      storage: true,
    }))
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl('ws://backend-plans')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()

    const registration = socket.sent
      .map((raw) => JSON.parse(raw) as { type?: string; payload?: unknown })
      .find((message) => message.type === 'host.register')
    expect(registration?.payload).toMatchObject({
      features: { plans_backend_v2: true },
    })
  })

  it('withdraws Plans support after an unavailable child is observed', () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '',
      entryFile: '/plugins/navide.plans/index.html',
      views: [],
    }, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion,
      system: ['fs'],
      storage: true,
    }))

    expect(mgr.isPlansBackendAvailable()).toBe(true)
    mgr.markPlansBackendUnavailable('child-crash')
    expect(mgr.isPlansBackendAvailable()).toBe(false)
  })

  function plansManagerWithHostObservers(packageVersion = '1.0.0'): {
    mgr: FrontendPluginManager
    childFailed: (instanceId: string) => void
    childRestarted: (instanceId: string, version?: string) => void
    childUnbound: (instanceId: string) => void
    childBudgetSpent: (instanceId: string) => void
  } {
    const mgr = new FrontendPluginManager()
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '',
      entryFile: '/plugins/navide.plans/index.html',
      views: [],
    }, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({ packageVersion, system: ['fs'], storage: true }))
    const host = (mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost
    const observers = host as unknown as {
      onBackendFailure?: (runtime: unknown, error: BackendPluginError) => void
      onBackendRestarted?: (runtime: unknown) => void
      onBackendUnbound?: (runtime: unknown) => void
    }
    return {
      mgr,
      childFailed: (instanceId) => observers.onBackendFailure?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion, instanceId },
        new BackendPluginError('BACKEND_UNAVAILABLE'),
      ),
      childRestarted: (instanceId, version = packageVersion) => observers.onBackendRestarted?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion: version, instanceId },
      ),
      childUnbound: (instanceId) => observers.onBackendUnbound?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion, instanceId },
      ),
      childBudgetSpent: (instanceId) => observers.onBackendFailure?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion, instanceId },
        new BackendPluginError('BACKEND_UNAVAILABLE', BACKEND_RESTART_BUDGET_SPENT_MESSAGE),
      ),
    }
  }

  it('records a backend child it gave up restarting in main.log and the error ledger', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dataDir = mkdtempSync(join(tmpdir(), 'ledger-'))
    setMainLedgerDataDir(dataDir)
    try {
      const { childBudgetSpent } = plansManagerWithHostObservers()
      childBudgetSpent('headless-1')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`${PLANS_PLUGIN_ID} failed too often`))
      const [entry] = readFileSync(join(dataDir, 'logs', 'errors.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      expect(entry).toMatchObject({ source: 'main', code: 'plugin.backend_gave_up' })
      expect(entry.message).toContain(PLANS_PLUGIN_ID)
    } finally {
      setMainLedgerDataDir(null)
      rmSync(dataDir, { recursive: true, force: true })
      warnSpy.mockRestore()
    }
  })

  it('restores Plans support when a failed child comes back after an automatic restart', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { mgr, childFailed, childRestarted } = plansManagerWithHostObservers()

      childFailed('headless-1')
      expect(mgr.isPlansBackendAvailable()).toBe(false)
      childRestarted('headless-1')
      expect(mgr.isPlansBackendAvailable()).toBe(true)
      expect(mgr.plansBackendFallbackAllowed()).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('keeps Plans withdrawn when a child comes back during legacy recovery', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The child dies, then the Host enters legacy recovery (enterPlansRecovery
      // withdraws v2 with its own reason): the recovered session stays legacy.
      const failedFirst = plansManagerWithHostObservers()
      failedFirst.childFailed('headless-1')
      failedFirst.mgr.markPlansBackendUnavailable('Backend plugin is unavailable.')
      failedFirst.childRestarted('headless-1')
      expect(failedFirst.mgr.isPlansBackendAvailable()).toBe(false)
      expect(failedFirst.mgr.plansBackendFallbackAllowed()).toBe(true)

      // Recovery first, then a child failure while in it.
      const recoveredFirst = plansManagerWithHostObservers()
      recoveredFirst.mgr.markPlansBackendUnavailable('package-recovery')
      recoveredFirst.childFailed('headless-1')
      recoveredFirst.childRestarted('headless-1')
      expect(recoveredFirst.mgr.isPlansBackendAvailable()).toBe(false)
      expect(recoveredFirst.mgr.plansBackendFallbackAllowed()).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('keeps Plans withdrawn until every child that died has come back', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { mgr, childFailed, childRestarted } = plansManagerWithHostObservers()

      childFailed('headless-a')
      childFailed('headless-b')
      childRestarted('headless-a')
      expect(mgr.isPlansBackendAvailable()).toBe(false)
      expect(mgr.plansBackendFallbackAllowed()).toBe(true)
      childRestarted('headless-b')
      expect(mgr.isPlansBackendAvailable()).toBe(true)
      expect(mgr.plansBackendFallbackAllowed()).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('stops waiting for a dead child once its view is unbound', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { mgr, childFailed, childRestarted, childUnbound } = plansManagerWithHostObservers()

      childFailed('headless-a')
      childFailed('headless-b')
      childUnbound('headless-b')
      // Unbinding alone is no proof the backend works; the restart is.
      expect(mgr.isPlansBackendAvailable()).toBe(false)
      childRestarted('headless-a')
      expect(mgr.isPlansBackendAvailable()).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('forgets the dead children when the user re-arms Plans', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { mgr, childFailed, childRestarted } = plansManagerWithHostObservers()

      childFailed('headless-a')
      expect(mgr.clearPlansBackendUnavailable()).toBe(true)
      childFailed('headless-c')
      childRestarted('headless-c')
      expect(mgr.isPlansBackendAvailable()).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('keeps Plans withdrawn for another cause even after every dead child came back', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { mgr, childFailed, childRestarted } = plansManagerWithHostObservers()

      childFailed('headless-a')
      childFailed('headless-b')
      mgr.markPlansBackendUnavailable('storage-unavailable')
      childRestarted('headless-a')
      childRestarted('headless-b')
      expect(mgr.isPlansBackendAvailable()).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does not let a child whose restart budget is spent hold Plans withdrawn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Another child is still dead: the spent one stops counting, the other
      // one's restart brings Plans back.
      const twoDead = plansManagerWithHostObservers()
      twoDead.childFailed('headless-a')
      twoDead.childFailed('headless-b')
      twoDead.childBudgetSpent('headless-b')
      expect(twoDead.mgr.isPlansBackendAvailable()).toBe(false)
      twoDead.childRestarted('headless-a')
      expect(twoDead.mgr.isPlansBackendAvailable()).toBe(true)

      // The spent child was the last dead one: nothing will restart it, so
      // Plans comes back at once instead of staying withdrawn for everyone.
      const lastDead = plansManagerWithHostObservers()
      lastDead.childFailed('headless-b')
      lastDead.childBudgetSpent('headless-b')
      expect(lastDead.mgr.isPlansBackendAvailable()).toBe(true)

      // Spent while Plans was ready: the failure does not withdraw it.
      const whileReady = plansManagerWithHostObservers()
      whileReady.childBudgetSpent('headless-b')
      expect(whileReady.mgr.isPlansBackendAvailable()).toBe(true)

      // Another cause still keeps it withdrawn.
      const otherCause = plansManagerWithHostObservers()
      otherCause.childFailed('headless-b')
      otherCause.mgr.markPlansBackendUnavailable('storage-unavailable')
      otherCause.childBudgetSpent('headless-b')
      expect(otherCause.mgr.isPlansBackendAvailable()).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('keeps Plans withdrawn when the child that came back is another package version', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { mgr, childFailed, childRestarted } = plansManagerWithHostObservers()

      childFailed('headless-1')
      childRestarted('headless-1', '0.9.0')
      expect(mgr.isPlansBackendAvailable()).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('rejects an unadmitted iframe while preserving the exact Host frame admission seam', async () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'navide-frame-manager-'))
    try {
      mkdirSync(join(packageDir, 'frontend'), { recursive: true })
      writeFileSync(join(packageDir, 'frontend/index.html'), '<!doctype html>')
      const mgr = new FrontendPluginManager()
      const descriptor: PluginLaunchDescriptor = {
        id: 'acme.frame', packageVersion: '1.0.0', packageDir,
        requires: [], devUrl: '', entryFile: join(packageDir, 'frontend/index.html'),
        capabilityPolicy: manifestV2CapabilityPolicy({}),
        views: [{
          id: 'left', contributionKey: 'acme.frame.left', kind: 'custom', location: 'left',
          title: 'Frame', entryFile: join(packageDir, 'frontend/index.html'),
        }],
      }
      mgr.registerDescriptor(descriptor, { builtin: true })
      mgr.setCapabilityGrantResolver(() => ({
        packageVersion: '1.0.0', system: [], storage: true,
      }))
      const host = new FakeBrowserWindow()
      const parent = {}
      ;(host.webContents as FakeHostContents & { id: number; mainFrame: unknown }).id = 42
      ;(host.webContents as FakeHostContents & { mainFrame: unknown }).mainFrame = parent
      const reserved = await mgr.reservePluginFrameContribution(asHost(host), 'acme.frame.left', '/workspace')
      expect(reserved.ok).toBe(true)
      if (!reserved.ok) return

      const unadmitted = {
        isDestroyed: () => false,
        detached: false,
        frameTreeNodeId: 1,
        parent: {},
        url: 'about:blank',
      }
      expect(mgr.bindPluginFrameBlank(reserved.bindingId, unadmitted as never)).toBe(false)

      const admittedCandidate = { ...unadmitted, parent }
      expect(mgr.bindPluginFrameBlank(reserved.bindingId, admittedCandidate as never)).toBe(true)
      const ready = ipcHandlers.get('plugin:frame:document-ready')
      expect(ready?.({ sender: { id: 42 }, senderFrame: admittedCandidate }, { nonce: 'wrong-nonce' })).toBe(false)
    } finally {
      rmSync(packageDir, { recursive: true, force: true })
    }
  })

  it('admits through the document-ready IPC handler and closes only the selected frame instance', async () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'navide-frame-close-'))
    const closeGrant = vi.spyOn(EditorSelectionGrants.prototype, 'close')
    try {
      mkdirSync(join(packageDir, 'frontend'), { recursive: true })
      writeFileSync(join(packageDir, 'frontend/index.html'), '<!doctype html>')
      const mgr = new FrontendPluginManager()
      const descriptor: PluginLaunchDescriptor = {
        id: 'acme.frame.close', packageVersion: '1.0.0', packageDir,
        requires: [], devUrl: '', entryFile: join(packageDir, 'frontend/index.html'),
        capabilityPolicy: manifestV2CapabilityPolicy({}),
        views: [
          { id: 'left', contributionKey: 'acme.frame.close.left', kind: 'custom', location: 'left', title: 'Left', entryFile: join(packageDir, 'frontend/index.html') },
          { id: 'right', contributionKey: 'acme.frame.close.right', kind: 'custom', location: 'right', title: 'Right', entryFile: join(packageDir, 'frontend/index.html') },
        ],
      }
      mgr.registerDescriptor(descriptor, { builtin: true })
      mgr.setCapabilityGrantResolver(() => ({ packageVersion: '1.0.0', system: [], storage: true }))
      const admitDocument = vi.spyOn(mgr as unknown as {
        admitPluginFrameDocument: (frame: unknown, receiverWebContentsId: number, nonce: string) => boolean
      }, 'admitPluginFrameDocument')
      const host = new FakeBrowserWindow()
      const hostContents = host.webContents as unknown as FakeHostContents & { id: number; mainFrame: object }
      hostContents.id = 314
      hostContents.mainFrame = {}

      const admit = async (contributionKey: string, frameTreeNodeId: number) => {
        const reserved = await mgr.reservePluginFrameContribution(asHost(host), contributionKey, '/workspace')
        expect(reserved.ok).toBe(true)
        if (!reserved.ok) throw new Error('frame reservation failed')
        const frame = {
          detached: false,
          frameTreeNodeId,
          parent: hostContents.mainFrame,
          url: 'about:blank',
          origin: 'null',
          isDestroyed: () => false,
          postMessage: vi.fn(),
        }
        expect(mgr.bindPluginFrameBlank(reserved.bindingId, frame as never)).toBe(true)
        frame.url = reserved.entryUrl
        frame.origin = frameOrigin(reserved.entryUrl)
        hostContents.emit('did-start-navigation', {
          frame,
          isSameDocument: false,
          url: reserved.entryUrl,
        })
        const pending = (mgr as unknown as {
          pendingPluginFrames: Map<string, { frame: unknown; hostWindow: { webContents: { id: number } } }>
        }).pendingPluginFrames.get(reserved.bindingId)
        expect(pending?.frame).toBe(frame)
        expect(pending?.hostWindow.webContents.id).toBe(hostContents.id)
        const running = (mgr as unknown as {
          running: Map<string, { carrier: string; id: string; workspacePath: string | null; capabilityContext?: { runtimeBinding?: { packageVersion?: string } | null } }>
        }).running
        expect([...running.values()][0]).toMatchObject({
          carrier: 'frame',
          id: 'acme.frame.close',
          workspacePath: resolve('/workspace'),
          capabilityContext: { runtimeBinding: { packageVersion: '1.0.0' } },
        })
        const ready = ipcHandlers.get('plugin:frame:document-ready')
        expect(ready).toBeDefined()
        const event = { sender: { id: hostContents.id }, senderFrame: frame }
        const childNonce = `child-document-${frameTreeNodeId}`
        const result = await ready?.(event, { nonce: childNonce })
        expect(admitDocument).toHaveBeenCalledWith(frame, hostContents.id, childNonce)
        expect(result).toBe(true)
        return { reserved, frame }
      }

      const left = await admit('acme.frame.close.left', 11)
      const leftInstanceId = (mgr as unknown as {
        pendingPluginFrames: Map<string, { instanceId: string }>
      }).pendingPluginFrames.get(left.reserved.bindingId)?.instanceId
      expect(leftInstanceId).toEqual(expect.any(String))
      const leftDispose = vi.fn()
      mgr.registerInstanceSubscription(leftInstanceId!, leftDispose)
      const right = await admit('acme.frame.close.right', 12)

      expect(mgr.closePluginFrame(left.reserved.bindingId)).toBe(true)
      expect(mgr.closePluginFrame(left.reserved.bindingId)).toBe(false)
      expect(leftDispose).toHaveBeenCalledTimes(1)
      expect(closeGrant).toHaveBeenCalledWith(leftInstanceId)
      expect(mgr.hasBackendActivity()).toBe(false)
      expect(mgr.closePluginFrame(right.reserved.bindingId)).toBe(true)
      expect(closeGrant).toHaveBeenCalledTimes(2)
    } finally {
      closeGrant.mockRestore()
      rmSync(packageDir, { recursive: true, force: true })
    }
  })
})

describe('registered receiver frame lifecycle', () => {
  type ReceiverSetup = {
    mgr: FrontendPluginManager
    host: FakeBrowserWindow
    receiver: FakeViewLike
    receiverEvent: { sender: { id: number }; senderFrame: object }
    receiverId: string
    descriptor: PluginLaunchDescriptor
    providerView: PluginViewLaunchDescriptor
    workspacePath: string
  }

  async function setupReceiver(withDetailPair = false, withEditorTargets = false, workspacePath = '/workspace', withCloseGuard = false): Promise<ReceiverSetup> {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const hostContents = host.webContents as FakeHostContents & { id: number; mainFrame: object }
    hostContents.id = 7000
    hostContents.mainFrame = {}
    expect(hostContents.id).toBe(7000)
    expect(hostContents.mainFrame).toBeDefined()
    const packageDir = process.cwd()
    const entryFile = join(packageDir, 'package.json')
    const descriptor: PluginLaunchDescriptor = {
      id: 'acme.receiver-lifecycle',
      packageVersion: '1.0.0',
      packageDir,
      requires: [],
      devUrl: '',
      entryFile,
      capabilityPolicy: manifestV2CapabilityPolicy(withDetailPair ? { system: ['ui'] } : {}),
      capabilityContext: {
        publisherEligible: true,
        userGrant: { packageVersion: '1.0.0', system: withDetailPair ? ['ui'] : [] },
        runtimeBinding: {
          pluginId: 'acme.receiver-lifecycle',
          packageVersion: '1.0.0',
          workspaceId: 'workspace-1',
          instanceId: 'host-placeholder',
          audience: 'receiver-test',
        },
      },
      views: [],
    }
    const receiverView: PluginViewLaunchDescriptor = {
      id: 'receiver', contributionKey: 'acme.receiver-lifecycle.receiver', kind: 'custom',
      location: 'window', title: 'Receiver', entryFile,
      receives: {
        protocolVersion: 1, locations: ['left', 'detail'],
        ...(withEditorTargets ? { editorTargets: { protocolVersion: 1 as const } } : {}),
        ...(withCloseGuard ? { closeGuard: { protocolVersion: 1 as const } } : {}),
      },
    }
    const providerView: PluginViewLaunchDescriptor = {
      id: 'provider', contributionKey: 'acme.receiver-lifecycle.provider', kind: 'custom',
      location: 'left', title: 'Provider', entryFile,
      ...(withDetailPair ? { detailView: 'detail' } : {}),
    }
    const detailView: PluginViewLaunchDescriptor = {
      id: 'detail', contributionKey: 'acme.receiver-lifecycle.detail', kind: 'custom',
      location: 'detail', title: 'Detail', entryFile,
      targetSchema: 'plugins/navide-git/schemas/branch-comparison.json',
    }
    descriptor.views = withDetailPair ? [receiverView, providerView, detailView] : [receiverView, providerView]
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.setCapabilityGrantResolver(() => ({ packageVersion: '1.0.0', system: withDetailPair ? ['ui'] : [], storage: true }))
    if (withDetailPair) mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
    const handle = await mgr.openView(descriptor, receiverView, {
      hostWindow: asHost(host), bounds: 'hidden', capabilityContext: descriptor.capabilityContext,
      workspacePath, initiallyVisible: false,
    })
    const running = (mgr as unknown as { running: Map<string, { view: FakeViewLike }> }).running.get(handle.instanceId)
    if (!running) throw new Error('receiver fixture did not create a running view')
    const receiver = running.view
    expect(receiver.webContents.id).not.toBe(7000)
    expect(receiver.webContents.mainFrame).not.toBe(hostContents.mainFrame)
    const receiverEvent = { sender: { id: receiver.webContents.id }, senderFrame: receiver.webContents.mainFrame }
    const register = ipcHandlers.get('plugin:receiver:register')
    const registration = register?.(receiverEvent, {
      protocolVersion: 1, locations: ['left', 'detail'],
      ...(withEditorTargets ? { editorTargets: { protocolVersion: 1 } } : {}),
      ...(withCloseGuard ? { closeGuard: { protocolVersion: 1 } } : {}),
    }) as { receiverId: string }
    expect(registration?.receiverId).toEqual(expect.any(String))
    return { mgr, host, receiver, receiverEvent, receiverId: registration.receiverId, descriptor, providerView, workspacePath }
  }

  async function mountOffer(fixture: ReceiverSetup): Promise<{ itemId: string; offerId: string }> {
    const { mgr, receiver, receiverEvent, receiverId, descriptor, providerView } = fixture
    expect(mgr.offerReceiverProvider(receiverId, descriptor, providerView, fixture.workspacePath)).toEqual({ ok: true })
    const offerMessage = receiver.webContents.sent.at(-1)
    const offerId = (offerMessage?.args[0] as { offer?: { offerId?: unknown } } | undefined)?.offer?.offerId
    expect(offerId).toEqual(expect.any(String))
    const mount = ipcHandlers.get('plugin:receiver:mount')
    const result = await mount?.(receiverEvent, { receiverId, offerId, placement: { mountHostId: `host-${offerId}` } }) as { itemId: string }
    expect(result.itemId).toEqual(expect.any(String))
    return { itemId: result.itemId, offerId: offerId as string }
  }

  async function admitItem(fixture: ReceiverSetup, itemId: string): Promise<{ port: { on: (event: string, cb: (event: { data: unknown }) => void) => void; postMessage: (data: unknown) => void }; frame: { postMessage: ReturnType<typeof vi.fn> } }> {
    const items = (fixture.mgr as unknown as { receiverItems: Map<string, { bindingId: string }> }).receiverItems
    const pending = (fixture.mgr as unknown as { pendingPluginFrames: Map<string, { entryUrl: string }> }).pendingPluginFrames
    const bindingId = items.get(itemId)?.bindingId
    expect(bindingId).toBeTruthy()
    const token = `receiver-frame-${itemId}`
    const frame = {
      processId: 1,
      frameToken: token,
      frameTreeNodeId: 100 + frameTokens.size,
      detached: false,
      parent: fixture.receiver.webContents.mainFrame,
      url: 'about:blank',
      origin: 'null',
      isDestroyed: () => false,
      postMessage: vi.fn(),
    }
    frameTokens.set(token, frame)
    const blankReady = ipcHandlers.get('plugin:receiver:blank-ready')
    const locator = await blankReady?.(
      { sender: { id: fixture.receiver.webContents.id }, senderFrame: fixture.receiver.webContents.mainFrame },
      { itemId, frameToken: token },
    ) as { locator: string }
    expect(locator.locator).toBe(pending.get(bindingId!)?.entryUrl)
    frame.url = locator.locator
    frame.origin = frameOrigin(locator.locator)
    fixture.receiver.webContents.emit('did-start-navigation', {
      frame, isSameDocument: false, url: locator.locator,
    })
    const hostMainFrame = (fixture.host.webContents as FakeHostContents & { mainFrame: object }).mainFrame
    const foreignFrame = { ...frame, frameTreeNodeId: frame.frameTreeNodeId + 1, parent: hostMainFrame }
    const documentReady = ipcHandlers.get('plugin:frame:document-ready')
    expect(documentReady?.(
      { sender: { id: fixture.receiver.webContents.id }, senderFrame: foreignFrame },
      { nonce: `foreign-${itemId}` },
    )).toBe(false)
    const nonce = `document-${itemId}`
    expect(documentReady?.(
      { sender: { id: fixture.receiver.webContents.id }, senderFrame: frame },
      { nonce },
    )).toBe(true)
    expect(frame.postMessage).toHaveBeenCalledTimes(1)
    const [channel, payload, ports] = frame.postMessage.mock.calls[0] as [string, { documentGeneration: number; nonce: string }, Array<{ on: Function; postMessage: Function }>]
    expect(channel).toBe('plugin:frame:port')
    expect(payload).toMatchObject({ documentGeneration: 1, nonce })
    expect(ports).toHaveLength(1)
    return { port: ports[0] as never, frame }
  }

  async function prepareEditorSource(workspacePath = '/workspace', withCloseGuard = false): Promise<{
    fixture: ReceiverSetup
    sourceItemId: string
    sourcePort: Awaited<ReturnType<typeof admitItem>>['port']
    providerMessages: unknown[]
    providerPort: Awaited<ReturnType<typeof admitItem>>['port']
    sourceMessages: unknown[]
    detailItemId: string
  }> {
    const pending = await startEditorSourceWithoutWaitingForDetailResponse(workspacePath, withCloseGuard)
    const offer = pending.fixture.receiver.webContents.sent
      .filter((message) => message.channel === 'plugin:receiver:offer')
      .map((message) => (message.args[0] as { offer?: { offerId?: string; location?: string } }).offer)
      .find((candidate) => candidate?.location === 'detail')
    expect(offer?.offerId).toEqual(expect.any(String))
    const detail = await ipcHandlers.get('plugin:receiver:mount')?.(pending.fixture.receiverEvent, {
      receiverId: pending.fixture.receiverId, offerId: offer?.offerId,
      placement: { mountHostId: `host-${offer?.offerId}` },
    }) as { itemId: string }
    const detailReady = await admitItem(pending.fixture, detail.itemId)
    const sourceMessages: unknown[] = []
    detailReady.port.on('message', (event) => sourceMessages.push(event.data))
    detailReady.port.postMessage({ kind: 'cast', channel: 'plugin:ready', payload: null })
    await vi.waitFor(() => expect(sourceMessages.some((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
    )).toBe(true))
    const initialTarget = (sourceMessages.find((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
    ) as { payload: { data: { targetId: string; revision: number } } }).payload.data
    await expect(resolveDetailTarget(
      detailReady.port,
      sourceMessages,
      'prepare-detail-target-ack',
      initialTarget,
      { applied: true },
    )).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(pending.providerMessages).toContainEqual(expect.objectContaining({
      channel: 'plugin:response', payload: expect.objectContaining({ requestId: pending.detailRequestId }),
    })))
    return {
      fixture: pending.fixture,
      sourceItemId: detail.itemId,
      sourcePort: detailReady.port,
      providerMessages: pending.providerMessages,
      providerPort: pending.providerPort,
      sourceMessages,
      detailItemId: detail.itemId,
    }
  }

  async function openAdditionalDetail(
    prepared: Awaited<ReturnType<typeof prepareEditorSource>>,
    requestId: string,
    compare: string,
  ): Promise<{ itemId: string; port: Awaited<ReturnType<typeof admitItem>>['port']; messages: unknown[] }> {
    const response = new Promise<unknown>((resolve) => {
      prepared.providerPort.on('message', (event) => {
        const message = event.data as { channel?: string; payload?: { requestId?: string; response?: unknown } }
        if (message.channel === 'plugin:response' && message.payload?.requestId === requestId) resolve(message.payload.response)
      })
    })
    const offersBefore = prepared.fixture.receiver.webContents.sent.filter((message) =>
      message.channel === 'plugin:receiver:offer' &&
      (message.args[0] as { offer?: { location?: string } }).offer?.location === 'detail',
    ).length
    prepared.providerPort.postMessage({
      kind: 'invoke', channel: 'plugin:cap:call', requestId,
      payload: { reqId: requestId, ns: 'ui', method: 'openDetail', args: {
        contributionKey: 'acme.receiver-lifecycle.detail',
        target: {
          resource: { kind: 'branch-comparison', repository: '.', base: 'main', compare },
          presentation: { mode: 'branch-diff' },
        },
      } },
    })
    await vi.waitFor(() => expect(prepared.fixture.receiver.webContents.sent.filter((message) =>
      message.channel === 'plugin:receiver:offer' &&
      (message.args[0] as { offer?: { location?: string } }).offer?.location === 'detail',
    )).toHaveLength(offersBefore + 1))
    const offer = prepared.fixture.receiver.webContents.sent
      .filter((message) => message.channel === 'plugin:receiver:offer')
      .map((message) => (message.args[0] as { offer?: { offerId?: string; location?: string } }).offer)
      .filter((candidate) => candidate?.location === 'detail' && candidate.offerId)
      .at(-1)
    const mounted = await ipcHandlers.get('plugin:receiver:mount')?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId,
      offerId: offer?.offerId,
      placement: { mountHostId: `host-${offer?.offerId}` },
    }) as { itemId: string }
    const admitted = await admitItem(prepared.fixture, mounted.itemId)
    const messages: unknown[] = []
    admitted.port.on('message', (event) => messages.push(event.data))
    admitted.port.postMessage({ kind: 'cast', channel: 'plugin:ready', payload: null })
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      channel: 'plugin:cap:event',
      payload: { type: 'plugin:view:detail-target', data: expect.objectContaining({ revision: 1 }) },
    })) )
    const update = (messages.find((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
    ) as { payload: { data: { targetId: string; revision: number } } }).payload.data
    await expect(resolveDetailTarget(admitted.port, messages, `${requestId}-ack`, update, { applied: true })).resolves.toMatchObject({ ok: true })
    await expect(response).resolves.toMatchObject({ ok: true, result: { opened: true } })
    return { itemId: mounted.itemId, port: admitted.port, messages }
  }

  async function startEditorSourceWithoutWaitingForDetailResponse(workspacePath = '/workspace', withCloseGuard = false): Promise<{
    fixture: ReceiverSetup
    sourceItemId: string
    sourcePort: Awaited<ReturnType<typeof admitItem>>['port']
    providerMessages: unknown[]
    providerPort: Awaited<ReturnType<typeof admitItem>>['port']
    detailRequestId: string
  }> {
    const fixture = await setupReceiver(true, true, workspacePath, withCloseGuard)
    const source = await mountOffer(fixture)
    const sourceReady = await admitItem(fixture, source.itemId)
    const providerMessages: unknown[] = []
    sourceReady.port.on('message', (event) => providerMessages.push(event.data))
    sourceReady.port.postMessage({ kind: 'cast', channel: 'plugin:ready', payload: null })
    const detailRequestId = 'detail-pending-until-applied'
    sourceReady.port.postMessage({
      kind: 'invoke', channel: 'plugin:cap:call', requestId: detailRequestId,
      payload: { reqId: detailRequestId, ns: 'ui', method: 'openDetail', args: {
        contributionKey: 'acme.receiver-lifecycle.detail',
        target: {
          resource: { kind: 'branch-comparison', repository: '.', base: 'main', compare: 'pending-ack' },
          presentation: { mode: 'branch-diff' },
        },
      } },
    })
    return {
      fixture,
      sourceItemId: source.itemId,
      sourcePort: sourceReady.port,
      providerMessages,
      providerPort: sourceReady.port,
      detailRequestId,
    }
  }

  async function invokeOpenInEditor(
    port: Awaited<ReturnType<typeof admitItem>>['port'],
    requestId: string,
    args: Record<string, unknown>,
    messages: unknown[],
    waitForResponse = true,
  ): Promise<{ response: Promise<unknown> }> {
    const response = new Promise<unknown>((resolve) => {
      const listener = (event: { data: unknown }) => {
        const message = event.data as { channel?: string; payload?: { requestId?: string; response?: unknown } }
        if (message.channel === 'plugin:response' && message.payload?.requestId === requestId) resolve(message.payload.response)
      }
      port.on('message', listener)
    })
    port.postMessage({ kind: 'invoke', channel: 'plugin:cap:call', requestId,
      payload: { reqId: requestId, ns: 'ui', method: 'openInEditor', args } })
    if (waitForResponse) {
      await vi.waitFor(() => expect(messages.some((message) =>
        (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
        (message as { payload?: { requestId?: string } }).payload?.requestId === requestId,
      )).toBe(true))
    }
    return { response }
  }

  async function resolveDetailTarget(
    port: Awaited<ReturnType<typeof admitItem>>['port'],
    messages: unknown[],
    requestId: string,
    update: { targetId: string; revision: number },
    decision: { applied: true } | { applied: false; reason: 'refused' | 'busy' },
    waitForResponse = true,
  ): Promise<unknown> {
    port.postMessage({ kind: 'invoke', channel: 'plugin:cap:call', requestId,
      payload: { reqId: requestId, ns: 'ui', method: 'resolveDetailTarget', args: {
        targetId: update.targetId, revision: update.revision, decision,
      } } })
    if (waitForResponse) await vi.waitFor(() => expect(messages.some((message) =>
      (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
      (message as { payload?: { requestId?: string } }).payload?.requestId === requestId,
    )).toBe(true))
    return (messages.find((message) =>
      (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
      (message as { payload?: { requestId?: string } }).payload?.requestId === requestId,
    ) as { payload: { response: unknown } } | undefined)?.payload.response
  }

  it('admits the legitimate receiver child after details-first navigation and posts one authenticated port', async () => {
    const fixture = await setupReceiver()
    const item = await mountOffer(fixture)
    const admitted = await admitItem(fixture, item.itemId)
    expect(admitted.port).toBeTruthy()
    expect((fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems.has(item.itemId)).toBe(true)
  })

  it('settles a refused initial detail open false and removes only its provisional item', async () => {
    const prepared = await startEditorSourceWithoutWaitingForDetailResponse()
    await vi.waitFor(() => expect(prepared.fixture.receiver.webContents.sent.some((message) =>
      message.channel === 'plugin:receiver:offer' &&
      (message.args[0] as { offer?: { location?: string } }).offer?.location === 'detail',
    )).toBe(true))
    const detailOffer = prepared.fixture.receiver.webContents.sent
      .filter((message) => message.channel === 'plugin:receiver:offer')
      .map((message) => (message.args[0] as { offer?: { offerId?: string; location?: string } }).offer)
      .find((offer) => offer?.location === 'detail')
    const detail = await ipcHandlers.get('plugin:receiver:mount')?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, offerId: detailOffer?.offerId,
      placement: { mountHostId: `host-${detailOffer?.offerId}` },
    }) as { itemId: string }
    const detailReady = await admitItem(prepared.fixture, detail.itemId)
    const detailMessages: unknown[] = []
    detailReady.port.on('message', (event) => detailMessages.push(event.data))
    detailReady.port.postMessage({ kind: 'cast', channel: 'plugin:ready', payload: null })
    await vi.waitFor(() => expect(detailMessages.some((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
    )).toBe(true))
    const update = (detailMessages.find((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
    ) as { payload: { data: { targetId: string; revision: number } } }).payload.data
    await resolveDetailTarget(detailReady.port, detailMessages, 'initial-refusal', update, { applied: false, reason: 'refused' }, false)
    await vi.waitFor(() => expect(prepared.providerMessages).toContainEqual(expect.objectContaining({
      channel: 'plugin:response', payload: expect.objectContaining({
        requestId: prepared.detailRequestId,
        response: expect.objectContaining({ ok: true, result: { opened: false, reason: 'provider-unavailable' } }),
      }),
    })))
    const items = (prepared.fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems
    expect(items.has(detail.itemId)).toBe(false)
    expect(items.has(prepared.sourceItemId)).toBe(true)
  })

  it('keeps openDetail pending through offer and mount until the initial provider target is applied', async () => {
    const prepared = await startEditorSourceWithoutWaitingForDetailResponse()
    const hasDetailResponse = () => prepared.providerMessages.some((message) =>
      (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
      (message as { payload?: { requestId?: string } }).payload?.requestId === prepared.detailRequestId,
    )
    await vi.waitFor(() => expect(prepared.fixture.receiver.webContents.sent.some((message) =>
      message.channel === 'plugin:receiver:offer' &&
      (message.args[0] as { offer?: { location?: string } }).offer?.location === 'detail',
    )).toBe(true))
    expect(hasDetailResponse()).toBe(false)

    const detailOffer = prepared.fixture.receiver.webContents.sent
      .filter((message) => message.channel === 'plugin:receiver:offer')
      .map((message) => (message.args[0] as { offer?: { offerId?: string; location?: string } }).offer)
      .find((offer) => offer?.location === 'detail')
    expect(detailOffer?.offerId).toEqual(expect.any(String))
    const detail = await ipcHandlers.get('plugin:receiver:mount')?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId,
      offerId: detailOffer?.offerId,
      placement: { mountHostId: `host-${detailOffer?.offerId}` },
    }) as { itemId: string }
    const detailReady = await admitItem(prepared.fixture, detail.itemId)
    const detailMessages: unknown[] = []
    detailReady.port.on('message', (event) => detailMessages.push(event.data))
    detailReady.port.postMessage({ kind: 'cast', channel: 'plugin:ready', payload: null })
    await vi.waitFor(() => expect(detailMessages.some((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
    )).toBe(true))
    expect(hasDetailResponse()).toBe(false)

    const targetMessage = detailMessages.find((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
    ) as { payload: { data: { targetId: string; revision: number } } }
    await expect(resolveDetailTarget(
      detailReady.port,
      detailMessages,
      'initial-target-applied',
      targetMessage.payload.data,
      { applied: true },
    )).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(hasDetailResponse()).toBe(true))
    expect(prepared.providerMessages.find((message) =>
      (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
      (message as { payload?: { requestId?: string } }).payload?.requestId === prepared.detailRequestId,
    )).toMatchObject({ payload: { response: { ok: true, result: { opened: true } } } })
  })

  it('rejects malformed, boolean, wrong-version, and extra-field editor target registrations', async () => {
    const fixture = await setupReceiver()
    const register = ipcHandlers.get('plugin:receiver:register')
    expect(() => register?.(fixture.receiverEvent, {
      protocolVersion: 1, locations: ['left', 'detail'], editorTargets: true,
    })).toThrow()
    expect(() => register?.(fixture.receiverEvent, {
      protocolVersion: 1, locations: ['left', 'detail'], editorTargets: { protocolVersion: 2 },
    })).toThrow()
    expect(() => register?.(fixture.receiverEvent, {
      protocolVersion: 1, locations: ['left', 'detail'], editorTargets: { protocolVersion: 1, extra: false },
    })).toThrow()
  })

  it('rejects malformed, wrong-version, extra-field, and undeclared close-guard registrations', async () => {
    const fixture = await setupReceiver()
    const register = ipcHandlers.get('plugin:receiver:register')
    for (const closeGuard of [
      true,
      { protocolVersion: 2 },
      { protocolVersion: 1, extra: false },
      { protocolVersion: 1, onPrepare: () => undefined },
    ]) {
      expect(() => register?.(fixture.receiverEvent, {
        protocolVersion: 1, locations: ['left', 'detail'], closeGuard,
      }), JSON.stringify(closeGuard)).toThrow()
    }
    // The fixture view does not declare receives.closeGuard, so a live guard is
    // a declaration mismatch rather than an implicit upgrade.
    expect(() => register?.(fixture.receiverEvent, {
      protocolVersion: 1, locations: ['left', 'detail'], closeGuard: { protocolVersion: 1 },
    })).toThrow()
  })

  it('lists left contributions and opens only an authenticated receiver-scoped offer', async () => {
    const fixture = await setupReceiver()
    const list = ipcHandlers.get('plugin:receiver:list-left-contributions')
    expect(list?.(fixture.receiverEvent, { receiverId: fixture.receiverId })).toEqual([
      {
        contributionKey: 'acme.receiver-lifecycle.provider',
        title: 'Provider',
        // Display metadata only: the receiver paints the icon, never learns the plugin.
        icon: null,
        iconMonochrome: false,
      },
    ])

    const open = ipcHandlers.get('plugin:receiver:open-left')
    expect(open?.(fixture.receiverEvent, {
      receiverId: fixture.receiverId,
      contributionKey: 'acme.receiver-lifecycle.provider',
    })).toEqual({ offered: true })
    expect(fixture.receiver.webContents.sent.at(-1)?.channel).toBe('plugin:receiver:offer')

    const foreignEvent = {
      sender: { id: (fixture.host.webContents as FakeHostContents & { id: number }).id },
      senderFrame: fixture.receiver.webContents.mainFrame,
    }
    expect(() => list?.(foreignEvent, { receiverId: fixture.receiverId })).toThrow('receiver left catalog is unavailable')
    expect(() => open?.(fixture.receiverEvent, {
      receiverId: fixture.receiverId,
      contributionKey: 'missing.provider',
    })).toThrow('receiver left contribution is unavailable')
  })

  it('delivers two independent detail targets through list/open-left, mount, ready, and frame-port paths', async () => {
    const fixture = await setupReceiver(true)
    const list = ipcHandlers.get('plugin:receiver:list-left-contributions')
    const open = ipcHandlers.get('plugin:receiver:open-left')
    expect(list?.(fixture.receiverEvent, { receiverId: fixture.receiverId })).toEqual([
      {
        contributionKey: 'acme.receiver-lifecycle.provider',
        title: 'Provider',
        icon: null,
        iconMonochrome: false,
      },
    ])
    expect(open?.(fixture.receiverEvent, { receiverId: fixture.receiverId, contributionKey: 'acme.receiver-lifecycle.provider' }))
      .toEqual({ offered: true })

    const mountOfferId = async (offerId: string): Promise<{ itemId: string }> => {
      return await ipcHandlers.get('plugin:receiver:mount')?.(fixture.receiverEvent, {
        receiverId: fixture.receiverId, offerId,
        placement: { mountHostId: `host-${offerId}` },
      }) as { itemId: string }
    }
    const sourceOffer = (fixture.receiver.webContents.sent.at(-1)?.args[0] as { offer?: { offerId?: string } }).offer
    expect(sourceOffer?.offerId).toEqual(expect.any(String))
    const source = await mountOfferId(sourceOffer?.offerId as string)
    const sourceReady = await admitItem(fixture, source.itemId)
    const sourceMessages: unknown[] = []
    sourceReady.port.on('message', (event) => sourceMessages.push(event.data))
    sourceReady.port.postMessage({ kind: 'cast', channel: 'plugin:ready', payload: null })
    const detailOffers = () => fixture.receiver.webContents.sent
      .filter((message) => message.channel === 'plugin:receiver:offer')
      .map((message) => (message.args[0] as { offer?: Record<string, unknown> }).offer)
      .filter((offer): offer is Record<string, unknown> => offer?.location === 'detail')
    const invokeDetail = async (requestId: string, target: unknown): Promise<{ response: Promise<unknown>; offer: Record<string, unknown> }> => {
      const response = new Promise<unknown>((resolve) => {
        sourceReady.port.on('message', (event) => {
          const message = event.data as { channel?: string; payload?: { requestId?: string; response?: unknown } }
          if (message.channel === 'plugin:response' && message.payload?.requestId === requestId) resolve(message.payload.response)
        })
      })
      const offersBefore = detailOffers().length
      sourceReady.port.postMessage({ kind: 'invoke', channel: 'plugin:cap:call', requestId,
        payload: { reqId: requestId, ns: 'ui', method: 'openDetail', args: {
          contributionKey: 'acme.receiver-lifecycle.detail', target,
        } } })
      await vi.waitFor(() => expect(detailOffers()).toHaveLength(offersBefore + 1))
      expect(sourceMessages.some((message) =>
        (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
        (message as { payload?: { requestId?: string } }).payload?.requestId === requestId,
      )).toBe(false)
      return { response, offer: detailOffers().at(-1)! }
    }
    const targetA = { resource: { kind: 'branch-comparison', repository: '.', base: 'main', compare: 'topic-a' }, presentation: { mode: 'branch-diff' } }
    const targetB = { resource: { kind: 'branch-comparison', repository: '.', base: 'main', compare: 'topic-b' }, presentation: { mode: 'branch-diff' } }
    const openedA = await invokeDetail('detail-a', targetA)
    const offerA = openedA.offer
    const offerAId = offerA?.offerId as string
    expect(offerA).not.toHaveProperty('target')
    expect(JSON.stringify(offerA)).not.toContain('topic-a')
    const detailA = await mountOfferId(offerAId)
    const readyA = await admitItem(fixture, detailA.itemId)
    const messagesA: unknown[] = []
    readyA.port.on('message', (event) => messagesA.push(event.data))
    readyA.port.postMessage({ kind: 'cast', channel: 'plugin:ready', payload: null })
    await vi.waitFor(() => expect(messagesA).toContainEqual(expect.objectContaining({
      channel: 'plugin:cap:event',
      payload: {
        type: 'plugin:view:detail-target',
        data: { targetId: expect.any(String), revision: 1, target: targetA },
      },
    })))
    const updateA = (messagesA.find((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
    ) as { payload: { data: { targetId: string; revision: number } } }).payload.data
    await resolveDetailTarget(readyA.port, messagesA, 'detail-a-ack', updateA, { applied: true })
    await expect(openedA.response).resolves.toMatchObject({ ok: true, result: { opened: true } })

    const openedB = await invokeDetail('detail-b', targetB)
    const offerB = openedB.offer
    const offerBId = offerB?.offerId as string
    expect(offerB?.offerId).not.toBe(offerA?.offerId)
    expect(offerB).not.toHaveProperty('target')
    expect(JSON.stringify(offerB)).not.toContain('topic-b')
    const detailB = await mountOfferId(offerBId)
    const readyB = await admitItem(fixture, detailB.itemId)
    const messagesB: unknown[] = []
    readyB.port.on('message', (event) => messagesB.push(event.data))
    readyB.port.postMessage({ kind: 'cast', channel: 'plugin:ready', payload: null })
    await vi.waitFor(() => expect(messagesB).toContainEqual(expect.objectContaining({
      channel: 'plugin:cap:event',
      payload: {
        type: 'plugin:view:detail-target',
        data: { targetId: expect.any(String), revision: 1, target: targetB },
      },
    })))
    const updateB = (messagesB.find((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
    ) as { payload: { data: { targetId: string; revision: number } } }).payload.data
    await resolveDetailTarget(readyB.port, messagesB, 'detail-b-ack', updateB, { applied: true })
    await expect(openedB.response).resolves.toMatchObject({ ok: true, result: { opened: true } })
    expect(messagesA).not.toContainEqual(expect.objectContaining({
      payload: { type: 'plugin:view:detail-target', data: expect.objectContaining({ target: targetB }) },
    }))
    expect(messagesB).not.toContainEqual(expect.objectContaining({
      payload: { type: 'plugin:view:detail-target', data: expect.objectContaining({ target: targetA }) },
    }))

    const close = ipcHandlers.get('plugin:receiver:request-close')
    const resolveClose = (port: { postMessage: (data: unknown) => void }, requestId: string, closeRequest: { closeId: string; itemId: string }, decision: unknown): void => {
      port.postMessage({ kind: 'invoke', channel: 'plugin:cap:call', requestId,
        payload: { reqId: requestId, ns: 'ui', method: 'resolveDetailClose', args: {
          closeId: closeRequest.closeId, itemId: closeRequest.itemId, decision,
        } } })
    }
    const refusalPromise = close?.(fixture.receiverEvent, { receiverId: fixture.receiverId, itemId: detailA.itemId }) as Promise<unknown>
    await vi.waitFor(() => expect(messagesA.some((message) =>
      (message as { channel?: string } | null)?.channel === 'plugin:view:close-request',
    )).toBe(true))
    const refusalRequest = (messagesA.find((message) =>
      (message as { channel?: string } | null)?.channel === 'plugin:view:close-request',
    ) as { payload: { closeId: string; itemId: string } }).payload
    resolveClose(sourceReady.port, 'wrong-provider', refusalRequest, { accepted: true, reason: 'accepted' })
    await vi.waitFor(() => expect(sourceMessages.some((message) =>
      (message as { channel?: string; payload?: { requestId?: string; response?: { ok?: boolean } } } | null)?.channel === 'plugin:response' &&
      (message as { payload?: { requestId?: string } }).payload?.requestId === 'wrong-provider',
    )).toBe(true))
    const wrongProviderResponse = sourceMessages.find((message) =>
      (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
      (message as { payload?: { requestId?: string } }).payload?.requestId === 'wrong-provider',
    ) as { payload: { response: { ok?: boolean; error?: { code?: string } } } }
    expect(wrongProviderResponse.payload.response).toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
    resolveClose(readyA.port, 'refuse-close', refusalRequest, { accepted: false, reason: 'refused' })
    await expect(refusalPromise).resolves.toEqual({ closed: false, reason: 'refused' })

    const busyPromise = close?.(fixture.receiverEvent, { receiverId: fixture.receiverId, itemId: detailB.itemId }) as Promise<unknown>
    await vi.waitFor(() => expect(messagesB.filter((message) =>
      (message as { channel?: string } | null)?.channel === 'plugin:view:close-request',
    )).toHaveLength(1))
    const busyRequest = (messagesB.find((message) =>
      (message as { channel?: string } | null)?.channel === 'plugin:view:close-request',
    ) as { payload: { closeId: string; itemId: string } }).payload
    resolveClose(readyB.port, 'busy-close', busyRequest, { accepted: false, reason: 'busy' })
    await expect(busyPromise).resolves.toEqual({ closed: false, reason: 'busy' })

    const acceptedPromise = close?.(fixture.receiverEvent, { receiverId: fixture.receiverId, itemId: detailB.itemId }) as Promise<unknown>
    await vi.waitFor(() => expect(messagesB.filter((message) =>
      (message as { channel?: string } | null)?.channel === 'plugin:view:close-request',
    )).toHaveLength(2))
    const acceptedRequest = messagesB.filter((message) =>
      (message as { channel?: string } | null)?.channel === 'plugin:view:close-request',
    ).at(-1) as { payload: { closeId: string; itemId: string } }
    resolveClose(readyB.port, 'accept-close', acceptedRequest.payload, { accepted: true, reason: 'accepted' })
    await expect(acceptedPromise).resolves.toEqual({ closed: true })
  })

  it('prepares receiver close transactions atomically across refusal, timeout, and commit', async () => {
    const prepared = await prepareEditorSource()
    const second = await openAdditionalDetail(prepared, 'atomic-detail-b', 'atomic-b')
    const third = await openAdditionalDetail(prepared, 'atomic-detail-c', 'atomic-c')
    const items = (prepared.fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems
    const closeTransaction = ipcHandlers.get('plugin:receiver:request-close-transaction')
    const requestClose = (itemIds: string[]): Promise<unknown> => closeTransaction?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, itemIds,
    }) as Promise<unknown>
    const detailPorts = [
      { itemId: prepared.detailItemId, port: prepared.sourcePort, messages: prepared.sourceMessages },
      second,
      third,
    ]
    const closeRequests = (messages: unknown[]) => messages.filter((message) =>
      (message as { channel?: string } | null)?.channel === 'plugin:view:close-request',
    ) as Array<{ payload: { closeId: string; itemId: string } }>
    const resolveClose = (
      target: { port: { postMessage: (data: unknown) => void }; messages: unknown[] },
      request: { closeId: string; itemId: string },
      requestId: string,
      decision: { accepted: true; reason: 'accepted' } | { accepted: false; reason: 'refused' | 'busy' },
    ): void => {
      target.port.postMessage({ kind: 'invoke', channel: 'plugin:cap:call', requestId,
        payload: { reqId: requestId, ns: 'ui', method: 'resolveDetailClose', args: {
          closeId: request.closeId, itemId: request.itemId, decision,
        } } })
    }
    const waitForCloseRequests = async (target: { messages: unknown[] }, count: number) => {
      await vi.waitFor(() => expect(closeRequests(target.messages)).toHaveLength(count))
      return closeRequests(target.messages).at(-1)!.payload
    }
    const assertLivePort = async (target: { port: { on: (event: string, cb: (event: { data: unknown }) => void) => void; postMessage: (data: unknown) => void }; messages: unknown[] }, requestId: string) => {
      const response = new Promise<unknown>((resolve) => {
        target.port.on('message', (event) => {
          const message = event.data as { channel?: string; payload?: { requestId?: string; response?: unknown } }
          if (message.channel === 'plugin:response' && message.payload?.requestId === requestId) resolve(message.payload.response)
        })
      })
      target.port.postMessage({ kind: 'invoke', channel: 'plugin:cap:call', requestId, payload: {} })
      await expect(response).resolves.toMatchObject({ ok: false })
    }

    const refused = requestClose(detailPorts.slice(0, 2).map((item) => item.itemId))
    await expect(requestClose([prepared.detailItemId])).resolves.toEqual({ closed: false, reason: 'busy' })
    const requestA = await waitForCloseRequests(detailPorts[0]!, 1)
    const requestB = await waitForCloseRequests(detailPorts[1]!, 1)

    const detailOffers = () => prepared.fixture.receiver.webContents.sent
      .filter((message) => message.channel === 'plugin:receiver:offer')
      .map((message) => (message.args[0] as { offer?: { offerId?: string; location?: string } }).offer)
      .filter((offer): offer is { offerId: string; location: 'detail' } =>
        offer?.location === 'detail' && typeof offer.offerId === 'string')
    const targetUpdateRequestId = 'atomic-target-update-while-closing'
    const targetUpdateResponse = new Promise<unknown>((resolve) => {
      prepared.providerPort.on('message', (event) => {
        const message = event.data as { channel?: string; payload?: { requestId?: string; response?: unknown } }
        if (message.channel === 'plugin:response' && message.payload?.requestId === targetUpdateRequestId) {
          resolve(message.payload.response)
        }
      })
    })
    const detailOffersBeforeTargetUpdate = detailOffers().length
    prepared.providerPort.postMessage({
      kind: 'invoke', channel: 'plugin:cap:call', requestId: targetUpdateRequestId,
      payload: { reqId: targetUpdateRequestId, ns: 'ui', method: 'openDetail', args: {
        contributionKey: 'acme.receiver-lifecycle.detail',
        target: {
          resource: { kind: 'branch-comparison', repository: '.', base: 'main', compare: 'pending-ack' },
          presentation: { mode: 'branch-diff' },
        },
      } },
    })
    await vi.waitFor(() => expect(detailOffers()).toHaveLength(detailOffersBeforeTargetUpdate + 1))
    const targetUpdateOffer = detailOffers().at(-1)!
    const targetMessagesBefore = prepared.sourceMessages.filter((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
    ).length
    await expect(ipcHandlers.get('plugin:receiver:accept-existing')?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, offerId: targetUpdateOffer.offerId, itemId: prepared.detailItemId,
    })).resolves.toEqual({ accepted: false, reason: 'busy' })
    await expect(targetUpdateResponse).resolves.toMatchObject({
      ok: true, result: { opened: false, reason: 'provider-unavailable' },
    })
    expect(prepared.sourceMessages.filter((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
    )).toHaveLength(targetMessagesBefore)

    resolveClose(detailPorts[1]!, requestA, 'atomic-wrong-provider', { accepted: true, reason: 'accepted' })
    await vi.waitFor(() => expect(second.messages.some((message) =>
      (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
      (message as { payload?: { requestId?: string } }).payload?.requestId === 'atomic-wrong-provider',
    )).toBe(true))
    resolveClose(detailPorts[0]!, requestA, 'atomic-accept-a', { accepted: true, reason: 'accepted' })
    for (const [index, decision] of [
      { accepted: false as const, reason: 'refused' as const },
      { accepted: false as const, reason: 'busy' as const },
    ].entries()) {
      const duplicateRequestId = `atomic-duplicate-${index}`
      resolveClose(detailPorts[0]!, requestA, duplicateRequestId, decision)
      await vi.waitFor(() => expect(prepared.sourceMessages.some((message) =>
        (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
        (message as { payload?: { requestId?: string } }).payload?.requestId === duplicateRequestId,
      )).toBe(true))
      expect(prepared.sourceMessages.find((message) =>
        (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
        (message as { payload?: { requestId?: string } }).payload?.requestId === duplicateRequestId,
      )).toMatchObject({ payload: { response: { ok: false, error: { code: 'CAPABILITY_DENIED' } } } })
    }
    resolveClose(detailPorts[1]!, requestB, 'atomic-refuse-b', { accepted: false, reason: 'refused' })
    await expect(refused).resolves.toEqual({ closed: false, reason: 'refused' })
    expect(items.has(prepared.detailItemId)).toBe(true)
    expect(items.has(second.itemId)).toBe(true)
    expect(closeRequests(prepared.sourceMessages).length).toBe(1)
    expect(closeRequests(second.messages).length).toBe(1)
    expect(prepared.sourceMessages.filter((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:close-cancelled',
    )).toHaveLength(1)
    expect(second.messages.filter((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:close-cancelled',
    )).toHaveLength(1)
    await assertLivePort(detailPorts[0]!, 'atomic-live-after-refusal-a')
    await assertLivePort(detailPorts[1]!, 'atomic-live-after-refusal-b')

    vi.useFakeTimers()
    try {
      const timedOut = requestClose(detailPorts.map((item) => item.itemId).slice(0, 2))
      const timeoutA = await waitForCloseRequests(detailPorts[0]!, 2)
      await waitForCloseRequests(detailPorts[1]!, 2)
      resolveClose(detailPorts[0]!, timeoutA, 'atomic-timeout-accept-a', { accepted: true, reason: 'accepted' })
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(timedOut).resolves.toEqual({ closed: false, reason: 'timeout' })
      expect(items.has(prepared.detailItemId)).toBe(true)
      expect(items.has(second.itemId)).toBe(true)
      await assertLivePort(detailPorts[0]!, 'atomic-live-after-timeout-a')
      await assertLivePort(detailPorts[1]!, 'atomic-live-after-timeout-b')
    } finally {
      vi.useRealTimers()
    }

    const closeRequestCountsBeforeCommit = detailPorts.map((item) => closeRequests(item.messages).length)
    const committed = requestClose(detailPorts.map((item) => item.itemId))
    const commitRequests = await Promise.all(detailPorts.map((item, index) =>
      waitForCloseRequests(item, closeRequestCountsBeforeCommit[index]! + 1)))
    detailPorts.forEach((item, index) => {
      resolveClose(item, commitRequests[index]!, `atomic-commit-${index}`, { accepted: true, reason: 'accepted' })
    })
    await expect(committed).resolves.toEqual({ closed: true })
    expect(items.has(prepared.detailItemId)).toBe(false)
    expect(items.has(second.itemId)).toBe(false)
    expect(items.has(third.itemId)).toBe(false)
  })

  it('requires guarded receiver consent before any provider close preparation', async () => {
    const prepared = await prepareEditorSource('/workspace', true)
    const closeTransaction = ipcHandlers.get('plugin:receiver:request-close-transaction')
    const resolveReceiver = ipcHandlers.get('plugin:receiver:resolve-close')
    const receiverPayloads = (): Array<{ receiverId: string; closeId: string; reason: string; documentGeneration: number }> =>
      prepared.fixture.receiver.webContents.sent
        .filter((message) => message.channel === 'plugin:receiver:close-request')
        .map((message) => message.args[0] as { receiverId: string; closeId: string; reason: string; documentGeneration: number })
    const providerCloseRequests = (): Array<{ payload: { closeId: string; itemId: string } }> =>
      prepared.sourceMessages.filter((message) =>
        (message as { channel?: string } | null)?.channel === 'plugin:view:close-request',
      ) as Array<{ payload: { closeId: string; itemId: string } }>

    const pending = closeTransaction?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, itemIds: [prepared.detailItemId],
    }) as Promise<unknown>
    await vi.waitFor(() => expect(receiverPayloads()).toHaveLength(1))
    expect(receiverPayloads()[0]).toEqual({
      receiverId: prepared.fixture.receiverId,
      closeId: expect.any(String),
      reason: 'receiver-item-batch',
      documentGeneration: expect.any(Number),
    })
    expect(providerCloseRequests()).toHaveLength(0)

    const hostContents = prepared.fixture.host.webContents as FakeHostContents & { id: number; mainFrame: object }
    expect(() => resolveReceiver?.(
      { sender: { id: hostContents.id }, senderFrame: hostContents.mainFrame },
      { receiverId: prepared.fixture.receiverId, closeId: receiverPayloads()[0]!.closeId, decision: { accepted: true, reason: 'accepted' } },
    )).toThrow()
    expect(() => resolveReceiver?.(prepared.fixture.receiverEvent, {
      receiverId: 'foreign-receiver', closeId: receiverPayloads()[0]!.closeId, decision: { accepted: true, reason: 'accepted' },
    })).toThrow()
    expect(providerCloseRequests()).toHaveLength(0)

    resolveReceiver?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, closeId: receiverPayloads()[0]!.closeId, decision: { accepted: true, reason: 'accepted' },
    })
    await vi.waitFor(() => expect(providerCloseRequests()).toHaveLength(1))
    expect(() => resolveReceiver?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, closeId: receiverPayloads()[0]!.closeId, decision: { accepted: true, reason: 'accepted' },
    })).toThrow()

    const request = providerCloseRequests()[0]!
    expect(request.payload.itemId).toBe(prepared.detailItemId)
    prepared.sourcePort.postMessage({
      kind: 'invoke', channel: 'plugin:cap:call', requestId: 'guarded-provider-accept',
      payload: { reqId: 'guarded-provider-accept', ns: 'ui', method: 'resolveDetailClose', args: {
        closeId: request.payload.closeId, itemId: request.payload.itemId, decision: { accepted: true, reason: 'accepted' },
      } },
    })
    await expect(pending).resolves.toEqual({ closed: true })
    const items = (prepared.fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems
    expect(items.has(prepared.detailItemId)).toBe(false)
  })

  it('keeps guarded items alive on receiver refusal and cancels both sides after a provider refusal', async () => {
    const prepared = await prepareEditorSource('/workspace', true)
    const closeTransaction = ipcHandlers.get('plugin:receiver:request-close-transaction')
    const resolveReceiver = ipcHandlers.get('plugin:receiver:resolve-close')
    const items = (prepared.fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems
    const receiverPayloads = (): Array<{ closeId: string }> =>
      prepared.fixture.receiver.webContents.sent
        .filter((message) => message.channel === 'plugin:receiver:close-request')
        .map((message) => message.args[0] as { closeId: string })
    const receiverCancellations = (): Array<{ closeId: string }> =>
      prepared.fixture.receiver.webContents.sent
        .filter((message) => message.channel === 'plugin:receiver:close-cancelled')
        .map((message) => message.args[0] as { closeId: string })
    const providerCloseRequests = (): Array<{ payload: { closeId: string; itemId: string } }> =>
      prepared.sourceMessages.filter((message) =>
        (message as { channel?: string } | null)?.channel === 'plugin:view:close-request',
      ) as Array<{ payload: { closeId: string; itemId: string } }>

    const refused = closeTransaction?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, itemIds: [prepared.detailItemId],
    }) as Promise<unknown>
    await vi.waitFor(() => expect(receiverPayloads()).toHaveLength(1))
    resolveReceiver?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, closeId: receiverPayloads()[0]!.closeId, decision: { accepted: false, reason: 'refused' },
    })
    await expect(refused).resolves.toEqual({ closed: false, reason: 'refused' })
    expect(providerCloseRequests()).toHaveLength(0)
    expect(items.has(prepared.detailItemId)).toBe(true)

    const second = closeTransaction?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, itemIds: [prepared.detailItemId],
    }) as Promise<unknown>
    await vi.waitFor(() => expect(receiverPayloads()).toHaveLength(2))
    const secondReceiverRequest = receiverPayloads()[1]!
    resolveReceiver?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, closeId: secondReceiverRequest.closeId, decision: { accepted: true, reason: 'accepted' },
    })
    await vi.waitFor(() => expect(providerCloseRequests()).toHaveLength(1))
    const providerRequest = providerCloseRequests()[0]!
    prepared.sourcePort.postMessage({
      kind: 'invoke', channel: 'plugin:cap:call', requestId: 'guarded-provider-refuse',
      payload: { reqId: 'guarded-provider-refuse', ns: 'ui', method: 'resolveDetailClose', args: {
        closeId: providerRequest.payload.closeId, itemId: providerRequest.payload.itemId, decision: { accepted: false, reason: 'refused' },
      } },
    })
    await expect(second).resolves.toEqual({ closed: false, reason: 'refused' })
    await vi.waitFor(() => expect(receiverCancellations()).toContainEqual({ receiverId: prepared.fixture.receiverId, closeId: secondReceiverRequest.closeId }))
    expect(prepared.sourceMessages.filter((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:close-cancelled',
    )).toHaveLength(1)
    expect(items.has(prepared.detailItemId)).toBe(true)
  })

  it('holds a native window close across receiver consent and provider prepare until commit', async () => {
    const prepared = await prepareEditorSource('/workspace', true)
    const mgr = prepared.fixture.mgr
    const receiverPayloads = (): Array<{ closeId: string; reason: string; receiverId: string }> =>
      prepared.fixture.receiver.webContents.sent
        .filter((message) => message.channel === 'plugin:receiver:close-request')
        .map((message) => message.args[0] as { closeId: string; reason: string; receiverId: string })
    const closeRequestsIn = (messages: unknown[]): Array<{ payload: { closeId: string; itemId: string } }> =>
      messages.filter((message) =>
        (message as { channel?: string } | null)?.channel === 'plugin:view:close-request',
      ) as Array<{ payload: { closeId: string; itemId: string } }>
    const items = (mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems
    expect(items.size).toBe(2)

    const preparation = mgr.prepareWindowClose(asHost(prepared.fixture.host), 'native-window-close')
    await vi.waitFor(() => expect(receiverPayloads()).toHaveLength(1))
    expect(receiverPayloads()[0]).toMatchObject({
      receiverId: prepared.fixture.receiverId, reason: 'native-window-close',
    })
    expect(closeRequestsIn(prepared.providerMessages)).toHaveLength(0)
    expect(closeRequestsIn(prepared.sourceMessages)).toHaveLength(0)

    ipcHandlers.get('plugin:receiver:resolve-close')?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, closeId: receiverPayloads()[0]!.closeId,
      decision: { accepted: true, reason: 'accepted' },
    })
    await vi.waitFor(() => {
      expect(closeRequestsIn(prepared.providerMessages)).toHaveLength(1)
      expect(closeRequestsIn(prepared.sourceMessages)).toHaveLength(1)
    })
    for (const [port, messages, requestId] of [
      [prepared.providerPort, prepared.providerMessages, 'native-left-accept'],
      [prepared.sourcePort, prepared.sourceMessages, 'native-detail-accept'],
    ] as const) {
      const request = closeRequestsIn(messages)[0]!
      port.postMessage({
        kind: 'invoke', channel: 'plugin:cap:call', requestId,
        payload: { reqId: requestId, ns: 'ui', method: 'resolveDetailClose', args: {
          closeId: request.payload.closeId, itemId: request.payload.itemId,
          decision: { accepted: true, reason: 'accepted' },
        } },
      })
    }

    const outcome = await preparation
    expect(outcome).toEqual({ ok: true, id: expect.any(String) })
    expect(items.size).toBe(2)
    mgr.commitWindowClose((outcome as { id: string }).id)
    expect(items.size).toBe(0)
  })

  it('keeps provider items alive and cancels the receiver when a native close is refused', async () => {
    const prepared = await prepareEditorSource('/workspace', true)
    const mgr = prepared.fixture.mgr
    const receiverPayloads = (): Array<{ closeId: string }> =>
      prepared.fixture.receiver.webContents.sent
        .filter((message) => message.channel === 'plugin:receiver:close-request')
        .map((message) => message.args[0] as { closeId: string })
    const providerCloseRequests = (): Array<{ payload: { closeId: string; itemId: string } }> =>
      prepared.sourceMessages.filter((message) =>
        (message as { channel?: string } | null)?.channel === 'plugin:view:close-request',
      ) as Array<{ payload: { closeId: string; itemId: string } }>
    const items = (mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems

    const preparation = mgr.prepareWindowClose(asHost(prepared.fixture.host), 'reload')
    await vi.waitFor(() => expect(receiverPayloads()).toHaveLength(1))
    expect(prepared.fixture.receiver.webContents.sent.filter((message) =>
      message.channel === 'plugin:receiver:close-request').map((message) => (message.args[0] as { reason: string }).reason),
    ).toEqual(['reload'])
    ipcHandlers.get('plugin:receiver:resolve-close')?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, closeId: receiverPayloads()[0]!.closeId,
      decision: { accepted: true, reason: 'accepted' },
    })
    await vi.waitFor(() => expect(providerCloseRequests()).toHaveLength(1))
    const request = providerCloseRequests()[0]!
    prepared.sourcePort.postMessage({
      kind: 'invoke', channel: 'plugin:cap:call', requestId: 'native-window-refuse',
      payload: { reqId: 'native-window-refuse', ns: 'ui', method: 'resolveDetailClose', args: {
        closeId: request.payload.closeId, itemId: request.payload.itemId, decision: { accepted: false, reason: 'refused' },
      } },
    })

    await expect(preparation).resolves.toEqual({ ok: false, reason: 'refused' })
    expect(items.has(prepared.detailItemId)).toBe(true)
    await vi.waitFor(() => expect(prepared.fixture.receiver.webContents.sent.some((message) =>
      message.channel === 'plugin:receiver:close-cancelled' &&
      (message.args[0] as { closeId: string }).closeId === receiverPayloads()[0]!.closeId,
    )).toBe(true))
  })

  it('keeps receiver registrations when a top-level navigation never commits', async () => {
    const fixture = await setupReceiver(false, false, '/workspace', true)
    const contents = fixture.receiver.webContents as unknown as { emit: (event: string, ...args: unknown[]) => void; mainFrame: unknown }
    expect(fixture.mgr.hasWindowCloseParticipants(asHost(fixture.host))).toBe(true)
    contents.emit('did-start-navigation', { frame: contents.mainFrame, isSameDocument: false })
    expect(fixture.mgr.hasWindowCloseParticipants(asHost(fixture.host))).toBe(true)
  })

  it('keeps a receiver that registered during the initial load current across did-finish-load', async () => {
    const fixture = await setupReceiver(false, false, '/workspace', true)
    const contents = fixture.receiver.webContents as unknown as { emit: (event: string, ...args: unknown[]) => void }
    expect(fixture.mgr.hasWindowCloseParticipants(asHost(fixture.host))).toBe(true)

    // The receiver app registers during entry-script execution; the first
    // completed load must not invalidate that registration.
    contents.emit('did-finish-load')
    expect(fixture.mgr.hasWindowCloseParticipants(asHost(fixture.host))).toBe(true)
    const preparation = fixture.mgr.prepareWindowClose(asHost(fixture.host), 'native-window-close')
    await vi.waitFor(() => expect(fixture.receiver.webContents.sent.some((message) =>
      message.channel === 'plugin:receiver:close-request')).toBe(true))
    const request = fixture.receiver.webContents.sent.filter((message) =>
      message.channel === 'plugin:receiver:close-request').at(-1)!
    ipcHandlers.get('plugin:receiver:resolve-close')?.(fixture.receiverEvent, {
      receiverId: fixture.receiverId,
      closeId: (request.args[0] as { closeId: string }).closeId,
      decision: { accepted: false, reason: 'refused' },
    })
    await expect(preparation).resolves.toEqual({ ok: false, reason: 'refused' })

    // Only a committed navigation retires the old registration. It advances
    // before the incoming document registers during load, not on did-finish-load.
    contents.emit('did-navigate')
    expect(fixture.mgr.hasWindowCloseParticipants(asHost(fixture.host))).toBe(false)

    // The incoming document's registration stays current across its load.
    const register = ipcHandlers.get('plugin:receiver:register')
    const reloaded = register?.(fixture.receiverEvent, {
      protocolVersion: 1,
      locations: ['left', 'detail'],
      closeGuard: { protocolVersion: 1 },
    }) as { receiverId: string }
    expect(reloaded.receiverId).toEqual(expect.any(String))
    contents.emit('did-finish-load')
    expect(fixture.mgr.hasWindowCloseParticipants(asHost(fixture.host))).toBe(true)
  })

  it('protects a guarded receiver with zero providers during a native close', async () => {
    const fixture = await setupReceiver(false, false, '/workspace', true)
    const mgr = fixture.mgr
    const receiverPayloads = (): Array<{ closeId: string; reason: string }> =>
      fixture.receiver.webContents.sent
        .filter((message) => message.channel === 'plugin:receiver:close-request')
        .map((message) => message.args[0] as { closeId: string; reason: string })
    const resolveReceiver = ipcHandlers.get('plugin:receiver:resolve-close')

    const refused = mgr.prepareWindowClose(asHost(fixture.host), 'quit')
    await vi.waitFor(() => expect(receiverPayloads()).toHaveLength(1))
    expect(receiverPayloads()[0]).toMatchObject({ reason: 'quit' })
    resolveReceiver?.(fixture.receiverEvent, {
      receiverId: fixture.receiverId, closeId: receiverPayloads()[0]!.closeId,
      decision: { accepted: false, reason: 'busy' },
    })
    await expect(refused).resolves.toEqual({ ok: false, reason: 'busy' })

    const accepted = mgr.prepareWindowClose(asHost(fixture.host), 'quit')
    await vi.waitFor(() => expect(receiverPayloads()).toHaveLength(2))
    resolveReceiver?.(fixture.receiverEvent, {
      receiverId: fixture.receiverId, closeId: receiverPayloads()[1]!.closeId,
      decision: { accepted: true, reason: 'accepted' },
    })
    const outcome = await accepted
    expect(outcome).toEqual({ ok: true, id: expect.any(String) })
    mgr.cancelWindowClose((outcome as { id: string }).id)
  })

  it('times out an unanswered guarded consent and releases the receiver lock for the next request', async () => {
    const prepared = await prepareEditorSource('/workspace', true)
    const closeTransaction = ipcHandlers.get('plugin:receiver:request-close-transaction')
    const receiverPayloads = (): unknown[] =>
      prepared.fixture.receiver.webContents.sent.filter((message) => message.channel === 'plugin:receiver:close-request')
    const providerCloseRequests = (): unknown[] => prepared.sourceMessages.filter((message) =>
      (message as { channel?: string } | null)?.channel === 'plugin:view:close-request')

    vi.useFakeTimers()
    try {
      const timedOut = closeTransaction?.(prepared.fixture.receiverEvent, {
        receiverId: prepared.fixture.receiverId, itemIds: [prepared.detailItemId],
      }) as Promise<unknown>
      await vi.waitFor(() => expect(receiverPayloads()).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(timedOut).resolves.toEqual({ closed: false, reason: 'timeout' })
      expect(providerCloseRequests()).toHaveLength(0)
      const items = (prepared.fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems
      expect(items.has(prepared.detailItemId)).toBe(true)

      const retried = closeTransaction?.(prepared.fixture.receiverEvent, {
        receiverId: prepared.fixture.receiverId, itemIds: [prepared.detailItemId],
      }) as Promise<unknown>
      await vi.waitFor(() => expect(receiverPayloads()).toHaveLength(2))
      const retryRequest = receiverPayloads()[1] as { args: Array<{ closeId: string }> }
      ipcHandlers.get('plugin:receiver:resolve-close')?.(prepared.fixture.receiverEvent, {
        receiverId: prepared.fixture.receiverId, closeId: retryRequest.args[0].closeId, decision: { accepted: false, reason: 'busy' },
      })
      await expect(retried).resolves.toEqual({ closed: false, reason: 'busy' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('directs editor targets with exact receiver correlation and settles only the first current reply', async () => {
    const prepared = await prepareEditorSource()
    const openCall = invokeOpenInEditor(prepared.sourcePort, 'editor-open', {
      path: 'src/main.ts', line: 7, column: 9,
    }, prepared.sourceMessages)
    await vi.waitFor(() => expect(prepared.fixture.receiver.webContents.sent.some((message) =>
      message.channel === 'plugin:receiver:editor-target',
    ), JSON.stringify(prepared.sourceMessages)).toBe(true))
    const targetMessage = prepared.fixture.receiver.webContents.sent.filter((message) =>
      message.channel === 'plugin:receiver:editor-target',
    ).at(-1)
    const targetPayload = targetMessage?.args[0] as {
      receiverId: string
      correlation: string
      target: { path: string; line: number; column: number; sourceItem: string }
    }
    expect(targetPayload).toEqual({
      receiverId: prepared.fixture.receiverId,
      correlation: expect.any(String),
      target: { path: join('src', 'main.ts'), line: 7, column: 9, sourceItem: prepared.sourceItemId },
    })
    const resolve = ipcHandlers.get('plugin:receiver:resolve-editor-target')
    const hostContents = prepared.fixture.host.webContents as FakeHostContents & { id: number; mainFrame: object }
    expect(() => resolve?.(
      { sender: { id: hostContents.id }, senderFrame: hostContents.mainFrame },
      { ...targetPayload, result: { opened: true } },
    )).toThrow()
    expect(() => resolve?.(prepared.fixture.receiverEvent, {
      receiverId: 'stale-receiver', correlation: targetPayload.correlation, result: { opened: true },
    })).toThrow()
    expect(() => resolve?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, correlation: 'stale-correlation', result: { opened: true },
    })).toThrow()
    resolve?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, correlation: targetPayload.correlation, result: { opened: true },
    })
    expect(await (await openCall).response).toEqual({ reqId: 'editor-open', ok: true, result: { opened: true } })
    expect(() => resolve?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, correlation: targetPayload.correlation, result: { opened: false },
    })).toThrow()

    const secondCall = invokeOpenInEditor(prepared.sourcePort, 'editor-refused', {
      path: 'src/other.ts', line: 1, column: 1,
    }, prepared.sourceMessages)
    await vi.waitFor(() => expect(prepared.fixture.receiver.webContents.sent.filter((message) =>
      message.channel === 'plugin:receiver:editor-target',
    )).toHaveLength(2))
    const secondPayload = prepared.fixture.receiver.webContents.sent.filter((message) =>
      message.channel === 'plugin:receiver:editor-target',
    ).at(-1)?.args[0] as { receiverId: string; correlation: string }
    resolve?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId, correlation: secondPayload.correlation, result: { opened: false },
    })
    expect(await (await secondCall).response).toEqual({ reqId: 'editor-refused', ok: true, result: { opened: false } })
  })

  it('rejects invalid or outside editor paths before receiver delivery', async () => {
    const prepared = await prepareEditorSource()
    const before = prepared.fixture.receiver.webContents.sent.filter((message) =>
      message.channel === 'plugin:receiver:editor-target',
    ).length
    const openCall = await invokeOpenInEditor(prepared.sourcePort, 'editor-invalid-path', {
      path: '../outside.ts', line: 1, column: 1,
    }, prepared.sourceMessages)
    expect(await openCall.response).toMatchObject({ ok: false })
    expect(prepared.fixture.receiver.webContents.sent.filter((message) =>
      message.channel === 'plugin:receiver:editor-target',
    )).toHaveLength(before)
  })

  it('accepts an inside symlink and sends its canonical root-relative target', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-editor-canonical-'))
    const realDirectory = join(workspacePath, 'real')
    mkdirSync(realDirectory)
    writeFileSync(join(realDirectory, 'main.ts'), 'export {}')
    symlinkSync(realDirectory, join(workspacePath, 'linked'))
    try {
      const prepared = await prepareEditorSource(workspacePath)
      const openCall = invokeOpenInEditor(prepared.sourcePort, 'editor-symlink-inside', {
        path: 'linked/main.ts', line: 7, column: 9,
      }, prepared.sourceMessages)
      await vi.waitFor(() => expect(prepared.fixture.receiver.webContents.sent.some((message) =>
        message.channel === 'plugin:receiver:editor-target',
      )).toBe(true))
      const target = prepared.fixture.receiver.webContents.sent.filter((message) =>
        message.channel === 'plugin:receiver:editor-target',
      ).at(-1)?.args[0] as { receiverId: string; correlation: string; target: { path: string } }
      expect(target.target.path).toBe(join('real', 'main.ts'))
      ipcHandlers.get('plugin:receiver:resolve-editor-target')?.(prepared.fixture.receiverEvent, {
        receiverId: target.receiverId, correlation: target.correlation, result: { opened: true },
      })
      expect(await (await openCall).response).toMatchObject({ ok: true, result: { opened: true } })
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it.each([
    ['outside symlink ancestor', 'outside-link', false],
    ['dangling outside symlink ancestor', 'dangling-link', false],
  ])('rejects an %s without receiver delivery', async (_name, linkName) => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-editor-symlink-reject-'))
    const outsidePath = mkdtempSync(join(tmpdir(), 'navide-editor-outside-'))
    if (linkName === 'outside-link') writeFileSync(join(outsidePath, 'main.ts'), 'outside')
    try {
      symlinkSync(join(outsidePath, 'main.ts'), join(workspacePath, linkName))
      const prepared = await prepareEditorSource(workspacePath)
      const before = prepared.fixture.receiver.webContents.sent.filter((message) =>
        message.channel === 'plugin:receiver:editor-target',
      ).length
      const openCall = await invokeOpenInEditor(prepared.sourcePort, `editor-${linkName}`, {
        path: `${linkName}/main.ts`,
      }, prepared.sourceMessages)
      expect(await openCall.response).toMatchObject({ ok: true, result: { opened: false } })
      expect(prepared.fixture.receiver.webContents.sent.filter((message) =>
        message.channel === 'plugin:receiver:editor-target',
      )).toHaveLength(before)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(outsidePath, { recursive: true, force: true })
    }
  })

  it('allows a missing ordinary inside leaf and preserves its root-relative spelling', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-editor-missing-leaf-'))
    try {
      const prepared = await prepareEditorSource(workspacePath)
      const openCall = invokeOpenInEditor(prepared.sourcePort, 'editor-missing-leaf', {
        path: 'new/ordinary.ts',
      }, prepared.sourceMessages)
      await vi.waitFor(() => expect(prepared.fixture.receiver.webContents.sent.some((message) =>
        message.channel === 'plugin:receiver:editor-target',
      )).toBe(true))
      const target = prepared.fixture.receiver.webContents.sent.filter((message) =>
        message.channel === 'plugin:receiver:editor-target',
      ).at(-1)?.args[0] as { receiverId: string; correlation: string; target: { path: string } }
      expect(target.target.path).toBe(join('new', 'ordinary.ts'))
      ipcHandlers.get('plugin:receiver:resolve-editor-target')?.(prepared.fixture.receiverEvent, {
        receiverId: target.receiverId, correlation: target.correlation, result: { opened: false },
      })
      expect(await (await openCall).response).toMatchObject({ ok: true, result: { opened: false } })
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('settles false when a symlink target changes before acknowledgement', async () => {
    vi.useFakeTimers()
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-editor-identity-drift-'))
    const realDirectory = join(workspacePath, 'real')
    const outsideDirectory = mkdtempSync(join(tmpdir(), 'navide-editor-drift-outside-'))
    mkdirSync(realDirectory)
    writeFileSync(join(realDirectory, 'main.ts'), 'inside')
    writeFileSync(join(outsideDirectory, 'main.ts'), 'outside')
    const linkPath = join(workspacePath, 'linked')
    symlinkSync(realDirectory, linkPath)
    try {
      const prepared = await prepareEditorSource(workspacePath)
      const openCall = invokeOpenInEditor(prepared.sourcePort, 'editor-identity-drift', {
        path: 'linked/main.ts',
      }, prepared.sourceMessages)
      await vi.waitFor(() => expect(prepared.fixture.receiver.webContents.sent.some((message) =>
        message.channel === 'plugin:receiver:editor-target',
      )).toBe(true))
      const target = prepared.fixture.receiver.webContents.sent.filter((message) =>
        message.channel === 'plugin:receiver:editor-target',
      ).at(-1)?.args[0] as { receiverId: string; correlation: string }
      renameSync(realDirectory, join(workspacePath, 'real-original'))
      symlinkSync(outsideDirectory, realDirectory)
      expect(() => ipcHandlers.get('plugin:receiver:resolve-editor-target')?.(prepared.fixture.receiverEvent, {
        receiverId: target.receiverId, correlation: target.correlation, result: { opened: true },
      })).toThrow()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await (await openCall).response).toMatchObject({ ok: true, result: { opened: false } })
    } finally {
      vi.useRealTimers()
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(outsideDirectory, { recursive: true, force: true })
    }
  })

  it('settles false and ignores a late acknowledgement after receiver disposal', async () => {
    const prepared = await prepareEditorSource()
    const openCall = invokeOpenInEditor(prepared.sourcePort, 'editor-disposed', {
      path: 'src/disposed.ts', line: 2, column: 3,
    }, prepared.sourceMessages, false)
    await vi.waitFor(() => expect(prepared.fixture.receiver.webContents.sent.some((message) =>
      message.channel === 'plugin:receiver:editor-target',
    ), JSON.stringify(prepared.sourceMessages)).toBe(true))
    const targetPayload = prepared.fixture.receiver.webContents.sent.filter((message) =>
      message.channel === 'plugin:receiver:editor-target',
    ).at(-1)?.args[0] as { receiverId: string; correlation: string }
    await ipcHandlers.get('plugin:receiver:dispose')?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId,
    })
    await Promise.resolve()
    expect(prepared.sourceMessages.some((message) =>
      (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
      (message as { payload?: { requestId?: string } }).payload?.requestId === 'editor-disposed',
    )).toBe(false)
    expect(() => ipcHandlers.get('plugin:receiver:list-left-contributions')?.(
      prepared.fixture.receiverEvent, { receiverId: prepared.fixture.receiverId },
    )).toThrow()
    expect(() => ipcHandlers.get('plugin:receiver:resolve-editor-target')?.(prepared.fixture.receiverEvent, {
      receiverId: targetPayload.receiverId, correlation: targetPayload.correlation, result: { opened: true },
    })).toThrow()
  })

  it('reuses one admitted detail item for equivalent resources and advances revisions after refusal', async () => {
    const prepared = await prepareEditorSource()

    const detailOffers = () => prepared.fixture.receiver.webContents.sent
      .filter((message) => message.channel === 'plugin:receiver:offer')
      .map((message) => (message.args[0] as { offer: { location?: string; offerId?: string; resourceKey?: string } }).offer)
      .filter((offer) => offer.location === 'detail')
    const initialOffer = detailOffers()[0]
    expect(initialOffer).toMatchObject({ offerId: expect.any(String), resourceKey: expect.any(String) })
    const itemCount = (prepared.fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems.size
    const assertDetailPortPing = async (requestId: string): Promise<void> => {
      prepared.sourcePort.postMessage({ kind: 'invoke', channel: 'plugin:cap:call', requestId, payload: {} })
      await vi.waitFor(() => expect(prepared.sourceMessages.some((message) =>
        (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
        (message as { payload?: { requestId?: string } }).payload?.requestId === requestId,
      )).toBe(true))
      expect(prepared.sourceMessages.find((message) =>
        (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
        (message as { payload?: { requestId?: string } }).payload?.requestId === requestId,
      )).toMatchObject({ payload: { response: { ok: false } } })
    }

    const openEquivalent = async (requestId: string): Promise<{
      offerId: string
      resourceKey: string
      response: Promise<unknown>
    }> => {
      const target = {
        presentation: { mode: 'branch-diff' },
        resource: { compare: 'pending-ack', base: 'main', repository: '.', kind: 'branch-comparison' },
      }
      const response = new Promise<unknown>((resolve) => {
        prepared.providerPort.on('message', (event) => {
          const message = event.data as { channel?: string; payload?: { requestId?: string; response?: unknown } }
          if (message.channel === 'plugin:response' && message.payload?.requestId === requestId) resolve(message.payload.response)
        })
      })
      prepared.providerPort.postMessage({ kind: 'invoke', channel: 'plugin:cap:call', requestId,
        payload: { reqId: requestId, ns: 'ui', method: 'openDetail', args: {
          contributionKey: 'acme.receiver-lifecycle.detail', target,
        } } })
      expect(prepared.providerMessages.some((message) =>
        (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
        (message as { payload?: { requestId?: string } }).payload?.requestId === requestId,
      )).toBe(false)
      const offer = detailOffers().at(-1)
      expect(offer?.resourceKey).toBe(initialOffer.resourceKey)
      return { ...offer as { offerId: string; resourceKey: string }, response }
    }

    const acceptExisting = async (
      offerId: string,
      requestId: string,
      decision?: { applied: true } | { applied: false; reason: 'refused' | 'busy' },
    ) => {
      const targetMessageCount = prepared.sourceMessages.filter((message) =>
        (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
        (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
      ).length
      const pending = ipcHandlers.get('plugin:receiver:accept-existing')?.(prepared.fixture.receiverEvent, {
        receiverId: prepared.fixture.receiverId, offerId, itemId: prepared.detailItemId,
      }) as Promise<unknown>
      await vi.waitFor(() => expect(prepared.sourceMessages.filter((message) =>
        (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
        (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
      )).toHaveLength(targetMessageCount + 1))
      const update = (prepared.sourceMessages.filter((message) =>
        (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
        (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
      ).at(-1) as { payload: { data: { targetId: string; revision: number } } }).payload.data
      if (decision === undefined) return { pending, revision: update.revision }
      await resolveDetailTarget(prepared.sourcePort, prepared.sourceMessages, requestId, update, decision)
      return { result: await pending, revision: update.revision }
    }

    const reused = await openEquivalent('detail-reuse')
    await expect(acceptExisting(reused.offerId, 'detail-reuse-ack', { applied: true })).resolves.toMatchObject({
      result: { accepted: true, itemId: prepared.detailItemId }, revision: 2,
    })
    await expect(reused.response).resolves.toMatchObject({ ok: true, result: { opened: true } })
    expect((prepared.fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems.size).toBe(itemCount)

    const refusedOffer = await openEquivalent('detail-refused')
    await expect(acceptExisting(refusedOffer.offerId, 'detail-refused-ack', { applied: false, reason: 'refused' })).resolves.toMatchObject({
      result: { accepted: false, reason: 'refused' }, revision: 3,
    })
    await expect(refusedOffer.response).resolves.toMatchObject({ ok: true, result: { opened: false } })
    await assertDetailPortPing('reused-detail-ping-after-refusal')
    const acceptedAgain = await openEquivalent('detail-after-refusal')
    await expect(acceptExisting(acceptedAgain.offerId, 'detail-after-refusal-ack', { applied: true })).resolves.toMatchObject({
      result: { accepted: true, itemId: prepared.detailItemId }, revision: 4,
    })
    await expect(acceptedAgain.response).resolves.toMatchObject({ ok: true, result: { opened: true } })
    expect((prepared.fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems.size).toBe(itemCount)

    vi.useFakeTimers()
    try {
      const timedOut = await openEquivalent('detail-timeout')
      const acceptance = await acceptExisting(timedOut.offerId, 'detail-timeout-accept')
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(acceptance.pending).resolves.toEqual({ accepted: false, reason: 'timeout' })
      await expect(timedOut.response).resolves.toMatchObject({ ok: true, result: { opened: false } })
      expect((prepared.fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems.size).toBe(itemCount)
    } finally {
      vi.useRealTimers()
    }

    await assertDetailPortPing('reused-detail-ping-after-timeout')
  })

  it('times out an unanswered editor target as opened false', async () => {
    vi.useFakeTimers()
    try {
      const prepared = await prepareEditorSource()
      const openCall = invokeOpenInEditor(prepared.sourcePort, 'editor-timeout', {
        path: 'src/timeout.ts', line: 4, column: 5,
      }, prepared.sourceMessages)
      await vi.waitFor(() => expect(prepared.fixture.receiver.webContents.sent.some((message) =>
        message.channel === 'plugin:receiver:editor-target',
      )).toBe(true))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await (await openCall).response).toEqual({ reqId: 'editor-timeout', ok: true, result: { opened: false } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a reused open when its left source tears down without deleting the existing detail item', async () => {
    const prepared = await prepareEditorSource()
    const items = (prepared.fixture.mgr as unknown as {
      receiverItems: Map<string, { bindingId: string; offer: { location?: string } }>
    }).receiverItems
    const leftItem = [...items.entries()].find(([, item]) => item.offer.location === 'left')
    expect(leftItem).toBeTruthy()
    const [leftItemId, leftRecord] = leftItem as [string, { bindingId: string; offer: { location?: string } }]
    expect(leftItemId).not.toBe(prepared.detailItemId)

    const detailOffers = () => prepared.fixture.receiver.webContents.sent
      .filter((message) => message.channel === 'plugin:receiver:offer')
      .map((message) => (message.args[0] as { offer?: { offerId?: string; location?: string; resourceKey?: string } }).offer)
      .filter((offer) => offer?.location === 'detail') as Array<{ offerId: string; location: 'detail'; resourceKey?: string }>
    const existingOffer = detailOffers()[0]
    expect(existingOffer).toMatchObject({ offerId: expect.any(String), location: 'detail' })

    const requestId = 'detail-source-teardown'
    prepared.providerPort.postMessage({
      kind: 'invoke', channel: 'plugin:cap:call', requestId,
      payload: { reqId: requestId, ns: 'ui', method: 'openDetail', args: {
        contributionKey: 'acme.receiver-lifecycle.detail',
        target: {
          resource: { kind: 'branch-comparison', repository: '.', base: 'main', compare: 'pending-ack' },
          presentation: { mode: 'branch-diff' },
        },
      } },
    })
    await vi.waitFor(() => expect(detailOffers()).toHaveLength(2))
    const replacementOffer = detailOffers().at(-1) as { offerId: string; location: 'detail'; resourceKey?: string }
    expect(replacementOffer.resourceKey).toBe(existingOffer.resourceKey)

    const targetMessagesBefore = prepared.sourceMessages.filter((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
    ).length
    const acceptance = ipcHandlers.get('plugin:receiver:accept-existing')?.(prepared.fixture.receiverEvent, {
      receiverId: prepared.fixture.receiverId,
      offerId: replacementOffer.offerId,
      itemId: prepared.detailItemId,
    }) as Promise<unknown>
    await vi.waitFor(() => expect(prepared.sourceMessages.filter((message) =>
      (message as { channel?: string; payload?: { type?: string } } | null)?.channel === 'plugin:cap:event' &&
      (message as { payload?: { type?: string } }).payload?.type === 'plugin:view:detail-target',
    )).toHaveLength(targetMessagesBefore + 1))

    expect(prepared.fixture.mgr.closePluginFrame(leftRecord.bindingId)).toBe(true)
    await expect(acceptance).resolves.toEqual({ accepted: false, reason: 'unavailable' })
    await Promise.resolve()
    expect(prepared.providerMessages.some((message) =>
      (message as { channel?: string; payload?: { requestId?: string } } | null)?.channel === 'plugin:response' &&
      (message as { payload?: { requestId?: string } }).payload?.requestId === requestId,
    )).toBe(false)
    expect(items.has(leftItemId)).toBe(false)
    expect(items.has(prepared.detailItemId)).toBe(true)

    const pingRequestId = 'reused-detail-ping-after-source-teardown'
    const pingResponse = new Promise<unknown>((resolve) => {
      prepared.sourcePort.on('message', (event) => {
        const message = event.data as { channel?: string; payload?: { requestId?: string; response?: unknown } }
        if (message.channel === 'plugin:response' && message.payload?.requestId === pingRequestId) {
          resolve(message.payload.response)
        }
      })
    })
    prepared.sourcePort.postMessage({
      kind: 'invoke', channel: 'plugin:cap:call', requestId: pingRequestId, payload: {},
    })
    await expect(pingResponse).resolves.toMatchObject({ ok: false })
  })

  it('keeps a surviving admitted sibling live for a directed private-port response after aborting another item', async () => {
    const fixture = await setupReceiver()
    const first = await mountOffer(fixture)
    const sibling = await mountOffer(fixture)
    await admitItem(fixture, first.itemId)
    const surviving = await admitItem(fixture, sibling.itemId)
    const abort = ipcHandlers.get('plugin:receiver:abort')
    await abort?.(fixture.receiverEvent, { receiverId: fixture.receiverId, itemId: first.itemId })
    const response = new Promise<{ data: unknown }>((resolve) => surviving.port.on('message', resolve))
    surviving.port.postMessage({
      kind: 'invoke', channel: 'plugin:cap:call', requestId: 'sibling-live-request', payload: {},
    })
    const message = await response
    expect(message.data).toMatchObject({
      channel: 'plugin:response',
      documentGeneration: 1,
      payload: { requestId: 'sibling-live-request', response: { ok: false } },
    })
    expect((fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems.has(sibling.itemId)).toBe(true)
  })

  it('uses the registered receiver WCV id, rejects foreign abort senders, and preserves siblings', async () => {
    const fixture = await setupReceiver()
    const first = await mountOffer(fixture)
    const second = await mountOffer(fixture)
    expect((fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems.has(second.itemId)).toBe(true)
    const hostContents = fixture.host.webContents as FakeHostContents & { id: number }
    const hostMainFrame = (fixture.host.webContents as FakeHostContents & { mainFrame: object }).mainFrame
    const items = (fixture.mgr as unknown as { receiverItems: Map<string, { bindingId: string }> }).receiverItems
    const pending = (fixture.mgr as unknown as { pendingPluginFrames: Map<string, { receiverWebContents: { id: number } }> }).pendingPluginFrames
    const firstBinding = items.get(first.itemId)?.bindingId
    const secondBinding = items.get(second.itemId)?.bindingId
    expect(firstBinding).toBeTruthy()
    expect(secondBinding).toBeTruthy()
    expect(pending.get(firstBinding!)?.receiverWebContents.id).toBe(fixture.receiver.webContents.id)
    expect(pending.get(firstBinding!)?.receiverWebContents.id).not.toBe(hostContents.id)
    expect(fixture.receiver.webContents.mainFrame).not.toBe(hostMainFrame)

    const abort = ipcHandlers.get('plugin:receiver:abort')
    const foreignEvent = { sender: { id: hostContents.id }, senderFrame: fixture.receiver.webContents.mainFrame }
    await abort?.(foreignEvent, { receiverId: fixture.receiverId, itemId: first.itemId })
    await abort?.(fixture.receiverEvent, { receiverId: 'stale-receiver', itemId: first.itemId })
    expect(items.has(first.itemId)).toBe(true)

    await abort?.(fixture.receiverEvent, { receiverId: fixture.receiverId, itemId: first.itemId })
    await abort?.(fixture.receiverEvent, { receiverId: fixture.receiverId, itemId: first.itemId })
    expect(items.has(first.itemId)).toBe(false)
    expect(items.has(second.itemId)).toBe(true)
    expect(pending.has(firstBinding!)).toBe(false)
    expect(pending.has(secondBinding!)).toBe(true)
  })

  it('sends one exact item-closed payload and suppresses later stale cleanup after dispose', async () => {
    const fixture = await setupReceiver()
    const first = await mountOffer(fixture)
    const second = await mountOffer(fixture)
    const abort = ipcHandlers.get('plugin:receiver:abort')
    await abort?.(fixture.receiverEvent, { receiverId: fixture.receiverId, itemId: first.itemId })
    const dispose = ipcHandlers.get('plugin:receiver:dispose')
    await dispose?.(fixture.receiverEvent, { receiverId: fixture.receiverId })
    const closed = fixture.receiver.webContents.sent
      .filter((message) => message.channel === 'plugin:receiver:item-closed')
      .map((message) => message.args[0])
    expect(closed).toEqual([
      { receiverId: fixture.receiverId, itemId: first.itemId, documentGeneration: 0 },
    ])
    await abort?.(fixture.receiverEvent, { receiverId: fixture.receiverId, itemId: first.itemId })
    await dispose?.(fixture.receiverEvent, { receiverId: fixture.receiverId })
    expect(fixture.receiver.webContents.sent.filter((message) => message.channel === 'plugin:receiver:item-closed')).toHaveLength(1)
    expect((fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems.size).toBe(0)
  })

  it('rechecks registration after a delayed reserve and closes the reserved binding before returning an item', async () => {
    const fixture = await setupReceiver()
    expect(fixture.mgr.offerReceiverProvider(fixture.receiverId, fixture.descriptor, fixture.providerView, '/workspace')).toEqual({ ok: true })
    const offerId = ((fixture.receiver.webContents.sent.at(-1)?.args[0] as { offer?: { offerId: string } }).offer?.offerId)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const original = fixture.mgr.reservePluginFrameContribution.bind(fixture.mgr)
    let reserved: Awaited<ReturnType<FrontendPluginManager['reservePluginFrameContribution']>> | undefined
    vi.spyOn(fixture.mgr, 'reservePluginFrameContribution').mockImplementation(async (...args) => {
      await gate
      reserved = await original(...args)
      return reserved
    })
    const mount = ipcHandlers.get('plugin:receiver:mount')
    const mounting = mount?.(fixture.receiverEvent, { receiverId: fixture.receiverId, offerId, placement: { mountHostId: `host-${offerId}` } })
    await Promise.resolve()
    await ipcHandlers.get('plugin:receiver:dispose')?.(fixture.receiverEvent, { receiverId: fixture.receiverId })
    release()
    await expect(mounting).rejects.toThrow('receiver mount is unavailable')
    expect(reserved?.ok).toBe(true)
    const bindingId = reserved?.ok ? reserved.bindingId : ''
    expect((fixture.mgr as unknown as { pendingPluginFrames: Map<string, unknown> }).pendingPluginFrames.has(bindingId)).toBe(false)
    expect((fixture.mgr as unknown as { receiverItems: Map<string, unknown> }).receiverItems.size).toBe(0)
  })
})

describe('createPluginBackendChildEnvironment', () => {
  it('keeps only the temporary-directory variables needed by packaged backends', () => {
    vi.stubEnv('TMPDIR', '/tmp/navide-plugin-backend')
    vi.stubEnv('TEMP', 'C:\\Users\\test\\AppData\\Local\\Temp')
    vi.stubEnv('TMP', 'C:\\Users\\test\\AppData\\Local\\Temp')
    vi.stubEnv('PATH', 'host-path-must-not-cross-boundary')

    try {
      expect(createPluginBackendChildEnvironment()).toEqual({
        TMPDIR: '/tmp/navide-plugin-backend',
        TEMP: 'C:\\Users\\test\\AppData\\Local\\Temp',
        TMP: 'C:\\Users\\test\\AppData\\Local\\Temp',
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('isReservedPluginId', () => {
  it('flags first-party and internal Host identities, not third-party ids', () => {
    expect(isReservedPluginId('navide.mini-ide')).toBe(true)
    expect(isReservedPluginId('navide.noop')).toBe(true)
    expect(isReservedPluginId('navide.plans')).toBe(true)
    expect(isReservedPluginId(HOST_EVENT_SOURCE_PLUGIN_ID)).toBe(true)
    expect(isReservedPluginId('acme.demo')).toBe(false)
  })
})

describe('plansCapabilityContext', () => {
  it('fails closed until the exact package-version grant is available', () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '2.0.0'
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/index.html',
      views: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs', 'ui', 'aiCli'] }),
    }, { builtin: true })

    expect(mgr.plansCapabilityContext(packageVersion, process.cwd())).toBeNull()

    const grant = {
      packageVersion,
      system: ['fs', 'ui', 'aiCli'] as const,
      storage: true,
    }
    mgr.setCapabilityGrantResolver(() => grant)

    expect(mgr.plansCapabilityContext(packageVersion, process.cwd())).toMatchObject({
      publisherEligible: true,
      userGrant: grant,
      runtimeBinding: {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        audience: 'plans-window',
      },
    })
    expect(mgr.plansCapabilityContext('2.0.1', process.cwd())).toBeNull()
  })

  it('requires filesystem permission in both the Manifest policy and the Grant', () => {
    const policyWithoutFs = new FrontendPluginManager()
    policyWithoutFs.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion: '2.0.0',
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/index.html',
      views: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['ui'] }),
    }, { builtin: true })
    policyWithoutFs.setCapabilityGrantResolver(() => ({
      packageVersion: '2.0.0',
      system: ['ui'],
      storage: true,
    }))
    expect(policyWithoutFs.plansCapabilityContext('2.0.0', process.cwd())).toBeNull()

    const grantWithoutFs = new FrontendPluginManager()
    grantWithoutFs.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion: '2.0.0',
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/index.html',
      views: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs', 'ui'] }),
    }, { builtin: true })
    grantWithoutFs.setCapabilityGrantResolver(() => ({
      packageVersion: '2.0.0',
      system: ['ui'],
      storage: true,
    }))
    expect(grantWithoutFs.plansCapabilityContext('2.0.0', process.cwd())).toBeNull()
  })

  it('does not bind a v2 Plans view when the matched policy and Grant omit fs', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '2.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/frontend/window/index.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['ui'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['ui'] }),
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion, system: ['ui'], storage: true },
      runtimeBinding: {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        workspaceId: mgr.workspaceIdForPath('/workspace'),
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindView')
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        capabilityContext: context,
      })
      expect(bind).not.toHaveBeenCalled()
      mgr.destroyInstance(handle.instanceId)
    } finally {
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })
})

describe('Plans private filesystem grant revalidation', () => {
  it('denies a revoked Grant before the filesystem service can be called', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '2.0.0'
    const workspacePath = process.cwd()
    const grant = {
      packageVersion,
      system: ['fs'] as const,
      storage: true,
    }
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html',
      views: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
    }, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    let activeGrant: typeof grant | null = grant
    mgr.setCapabilityGrantResolver(() => activeGrant)
    const service = vi
      .spyOn(
        mgr as unknown as {
          sendPublicBackend: (
            wsType: string,
            payload: Record<string, unknown>,
            beforeDispatch?: () => boolean,
          ) => Promise<unknown>
        },
        'sendPublicBackend',
      )
      .mockResolvedValue({ content: 'draft' })
    const internals = mgr as unknown as {
      sendPlansFilesystemService: (
        operation: string,
        payload: Record<string, unknown>,
        context: PlansBridgeContext,
      ) => Promise<unknown>
    }
    const context: PlansBridgeContext = {
      runtime: {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        workspaceId: mgr.workspaceIdForPath(workspacePath),
        instanceId: 'plans-view-1',
        contributionKey: 'navide.plans.window',
        hostWindowId: 'window-1',
        initiator: { kind: 'user', id: 'user-1' },
      },
      workspacePath,
      authorizedPlanRoot: workspacePath,
      requestId: 'bridge-test-1',
      signal: new AbortController().signal,
      emit: () => undefined,
    }
    try {
      await expect(internals.sendPlansFilesystemService(
        'fs.read_file',
        { rel_path: 'draft.html' },
        context,
      )).resolves.toEqual({ content: 'draft' })
      expect(service).toHaveBeenCalledOnce()

      activeGrant = null
      await expect(internals.sendPlansFilesystemService(
        'fs.read_file',
        { rel_path: 'draft.html' },
        context,
      )).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      expect(service).toHaveBeenCalledOnce()
    } finally {
      service.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  // Re-arm after legacy recovery used to keep a dead headless MCP child cached.
  // The next agent call hit it, withdrew v2 again, and every filesystem Bridge
  // request of the live Plans view was then denied - the Plans list showed
  // "Plugin capability was denied." moments after the retry.
  it('re-arms Plans v2 without a dead headless child withdrawing it under a live view', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '2.0.0'
    const workspacePath = process.cwd()
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html',
      views: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
    }, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({ packageVersion, system: ['fs'], storage: true }))
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] },
      revision: 1,
      state: 'user',
    }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindWorkspace')
      .mockResolvedValueOnce('headless-dead')
      .mockResolvedValueOnce('headless-fresh')
    const unbind = vi.spyOn(PluginBackendHost.prototype, 'unbindView').mockResolvedValue(undefined)
    const call = vi.spyOn(PluginBackendHost.prototype, 'call').mockImplementation(async (instanceId) => {
      if (instanceId === 'headless-dead') throw new BackendPluginError('BACKEND_UNAVAILABLE')
      return [] as never
    })
    const service = vi
      .spyOn(
        mgr as unknown as {
          sendPublicBackend: (wsType: string, payload: Record<string, unknown>) => Promise<unknown>
        },
        'sendPublicBackend',
      )
      .mockResolvedValue({ entries: [] })
    const internals = mgr as unknown as {
      sendPlansFilesystemService: (
        operation: string,
        payload: Record<string, unknown>,
        context: PlansBridgeContext,
      ) => Promise<unknown>
    }
    const viewContext: PlansBridgeContext = {
      runtime: {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        workspaceId: mgr.workspaceIdForPath(workspacePath),
        instanceId: 'plans-left-1',
        contributionKey: 'navide.plans.left',
        hostWindowId: 'window-1',
        initiator: { kind: 'user', id: 'user-1' },
      },
      workspacePath,
      authorizedPlanRoot: workspacePath,
      requestId: 'bridge-rearm-1',
      signal: new AbortController().signal,
      emit: () => undefined,
    }
    try {
      // The headless child dies; the agent call withdraws v2 (legacy recovery).
      await expect(mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        workspacePath,
        { reqId: 'agent-list-dead', name: 'plans.list', args: {} },
      )).resolves.toMatchObject({ ok: false })
      expect(mgr.isPlansBackendAvailable()).toBe(false)

      // The user retries v2.
      expect(mgr.clearPlansBackendUnavailable()).toBe(true)
      expect(unbind).toHaveBeenCalledWith('headless-dead')

      // An agent call right after the retry must reach a fresh child ...
      await expect(mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        workspacePath,
        { reqId: 'agent-list-fresh', name: 'plans.list', args: {} },
      )).resolves.toMatchObject({ ok: true })
      expect(call).toHaveBeenLastCalledWith('headless-fresh', 'plans.list', {}, expect.anything())
      expect(mgr.isPlansBackendAvailable()).toBe(true)

      // ... so the live view's list keeps its filesystem access.
      await expect(internals.sendPlansFilesystemService(
        'fs.read_file',
        { rel_path: 'draft.html' },
        viewContext,
      )).resolves.toEqual({ entries: [] })
    } finally {
      service.mockRestore()
      call.mockRestore()
      unbind.mockRestore()
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('does not let a call on a headless child the retry discarded withdraw Plans v2 again', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '2.0.0'
    const workspacePath = process.cwd()
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html',
      views: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
    }, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({ packageVersion, system: ['fs'], storage: true }))
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] },
      revision: 1,
      state: 'user',
    }))
    let stopInFlight: (error: unknown) => void = () => undefined
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindWorkspace').mockResolvedValue('headless-old')
    const call = vi.spyOn(PluginBackendHost.prototype, 'call').mockImplementation(
      () => new Promise((_resolve, reject) => { stopInFlight = reject }),
    )
    // Unbinding a child rejects its in-flight calls, as the Host does.
    const unbind = vi.spyOn(PluginBackendHost.prototype, 'unbindView').mockImplementation(async () => {
      stopInFlight(new BackendPluginError('PLUGIN_STOPPING'))
    })
    try {
      // An agent runs a long plans call on the headless child ...
      const inFlight = mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        workspacePath,
        { reqId: 'agent-list-long', name: 'plans.list', args: {} },
      )
      await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())

      // ... while v2 is withdrawn for another reason and the user retries it.
      mgr.markPlansBackendUnavailable('view-failure')
      expect(mgr.clearPlansBackendUnavailable()).toBe(true)
      expect(unbind).toHaveBeenCalledWith('headless-old')

      // The discarded child's stop fails that call, but is not a sign that
      // the backend is unavailable: the retry stays in effect.
      await expect(inFlight).resolves.toMatchObject({ ok: false, error: { code: 'PLUGIN_STOPPING' } })
      expect(mgr.isPlansBackendAvailable()).toBe(true)
    } finally {
      call.mockRestore()
      unbind.mockRestore()
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  // A child that spent its restart budget is never restarted. Its workspace's
  // agent calls must fail before dispatch with the recovery steps, and the other
  // workspaces must keep using v2.
  it('refuses agent calls for a workspace whose child is given up, before dispatch and without withdrawing Plans', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mgr = new FrontendPluginManager()
    const packageVersion = '2.0.0'
    const spentWorkspace = process.cwd()
    const otherWorkspace = mkdtempSync(join(tmpdir(), 'navide-plans-other-'))
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html',
      views: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
    }, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({ packageVersion, system: ['fs'], storage: true }))
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] },
      revision: 1,
      state: 'user',
    }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindWorkspace')
      .mockImplementation(async (_runtime, _packageDir, workspacePath) =>
        workspacePath === spentWorkspace ? 'headless-spent' : 'headless-other')
    const call = vi.spyOn(PluginBackendHost.prototype, 'call').mockResolvedValue([] as never)
    const host = (mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost
    const observers = host as unknown as {
      onBackendFailure?: (runtime: unknown, error: BackendPluginError) => void
      onBackendUnbound?: (runtime: unknown) => void
    }
    const agentList = (workspacePath: string, reqId: string) =>
      mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID, workspacePath, { reqId, name: 'plans.list', args: {} },
      )
    const stopped = vi.fn()
    mgr.setPlansBackendStoppedHandler(stopped)
    try {
      await expect(agentList(spentWorkspace, 'spent-1')).resolves.toMatchObject({ ok: true })
      await expect(agentList(otherWorkspace, 'other-1')).resolves.toMatchObject({ ok: true })

      // A failure that will be restarted is not reported to the user.
      observers.onBackendFailure?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion, instanceId: 'headless-spent' },
        new BackendPluginError('BACKEND_UNAVAILABLE'),
      )
      expect(stopped).not.toHaveBeenCalled()
      const giveUp = () => observers.onBackendFailure?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion, instanceId: 'headless-spent' },
        new BackendPluginError('BACKEND_UNAVAILABLE', BACKEND_RESTART_BUDGET_SPENT_MESSAGE),
      )
      giveUp()
      expect(stopped).toHaveBeenCalledTimes(1)
      expect(stopped).toHaveBeenCalledWith({ workspacePath: spentWorkspace })
      // Reported once per instance, however often it is seen again.
      giveUp()
      expect(stopped).toHaveBeenCalledTimes(1)
      call.mockClear()

      await expect(agentList(spentWorkspace, 'spent-2')).resolves.toMatchObject({
        ok: false,
        error: { code: 'BACKEND_UNAVAILABLE', message: PLANS_BACKEND_STOPPED_MESSAGE },
      })
      expect(call).not.toHaveBeenCalled()
      expect(mgr.isPlansBackendAvailable()).toBe(true)

      await expect(agentList(otherWorkspace, 'other-2')).resolves.toMatchObject({ ok: true })
      expect(call).toHaveBeenLastCalledWith('headless-other', 'plans.list', {}, expect.anything())
      // Refused calls do not report it again.
      expect(stopped).toHaveBeenCalledTimes(1)

      // Once its view is unbound the instance is no longer refused.
      observers.onBackendUnbound?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion, instanceId: 'headless-spent' },
      )
      await expect(agentList(spentWorkspace, 'spent-3')).resolves.toMatchObject({ ok: true })
    } finally {
      call.mockRestore()
      bind.mockRestore()
      warnSpy.mockRestore()
      await mgr.closeBackendPlugins()
      rmSync(otherWorkspace, { recursive: true, force: true })
    }
  })

  // Opening Plans for the workspace is how the user brings a given-up child
  // back: the next agent call binds a fresh one, once per open.
  it('replaces a given-up headless child when Plans is opened for its workspace', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mgr = new FrontendPluginManager()
    const packageVersion = '2.0.0'
    const spentWorkspace = process.cwd()
    const otherWorkspace = mkdtempSync(join(tmpdir(), 'navide-plans-other-'))
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({ packageVersion, system: ['fs'], storage: true }))
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] },
      revision: 1,
      state: 'user',
    }))
    let spentBinds = 0
    const bindWorkspace = vi.spyOn(PluginBackendHost.prototype, 'bindWorkspace')
      .mockImplementation(async (_runtime, _packageDir, workspacePath) =>
        workspacePath === spentWorkspace ? `headless-spent-${++spentBinds}` : 'headless-other')
    const bindView = vi.spyOn(PluginBackendHost.prototype, 'bindView').mockResolvedValue()
    const unbind = vi.spyOn(PluginBackendHost.prototype, 'unbindView').mockResolvedValue(undefined)
    const call = vi.spyOn(PluginBackendHost.prototype, 'call').mockResolvedValue([] as never)
    const host = (mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost
    const observers = host as unknown as {
      onBackendFailure?: (runtime: unknown, error: BackendPluginError) => void
    }
    const agentList = (workspacePath: string, reqId: string) =>
      mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID, workspacePath, { reqId, name: 'plans.list', args: {} },
      )
    const openPlans = async (workspacePath: string): Promise<void> => {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(new FakeBrowserWindow()),
        bounds: 'fill',
        workspacePath,
        capabilityContext: {
          publisherEligible: false,
          userGrant: { packageVersion, system: ['fs'], storage: true },
          runtimeBinding: {
            pluginId: PLANS_PLUGIN_ID,
            packageVersion,
            workspaceId: mgr.workspaceIdForPath(workspacePath),
            instanceId: null,
            audience: view.contributionKey,
          },
        },
      })
      await mgr.waitForBackendBinding(handle.instanceId)
    }
    try {
      await expect(agentList(spentWorkspace, 'spent-1')).resolves.toMatchObject({ ok: true })
      await expect(agentList(otherWorkspace, 'other-1')).resolves.toMatchObject({ ok: true })
      observers.onBackendFailure?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion, instanceId: 'headless-spent-1' },
        new BackendPluginError('BACKEND_UNAVAILABLE', BACKEND_RESTART_BUDGET_SPENT_MESSAGE),
      )
      await expect(agentList(spentWorkspace, 'spent-2')).resolves.toMatchObject({ ok: false })

      // Opening Plans for another workspace leaves both children alone.
      await openPlans(otherWorkspace)
      expect(bindView).toHaveBeenCalledTimes(1)
      expect(unbind).not.toHaveBeenCalled()
      await expect(agentList(spentWorkspace, 'spent-3')).resolves.toMatchObject({ ok: false })

      // Opening it for the given-up workspace replaces that child once.
      await openPlans(spentWorkspace)
      expect(unbind).toHaveBeenCalledTimes(1)
      expect(unbind).toHaveBeenCalledWith('headless-spent-1')
      call.mockClear()
      await expect(agentList(spentWorkspace, 'spent-4')).resolves.toMatchObject({ ok: true })
      expect(call).toHaveBeenLastCalledWith('headless-spent-2', 'plans.list', {}, expect.anything())

      // Opening it again does not replace the fresh child.
      await openPlans(spentWorkspace)
      expect(unbind).toHaveBeenCalledTimes(1)
      expect(spentBinds).toBe(2)
      await expect(agentList(otherWorkspace, 'other-2')).resolves.toMatchObject({ ok: true })
      expect(call).toHaveBeenLastCalledWith('headless-other', 'plans.list', {}, expect.anything())
    } finally {
      call.mockRestore()
      unbind.mockRestore()
      bindView.mockRestore()
      bindWorkspace.mockRestore()
      warnSpy.mockRestore()
      await mgr.closeBackendPlugins()
      rmSync(otherWorkspace, { recursive: true, force: true })
    }
  })

  // The child reads and writes its plan files itself and asks for the root
  // before each request, so resolve_root is where the Grant and an agent's
  // Execution Policy are enforced for those accesses.
  it('checks the Grant and an agent Execution Policy before handing the child its plan root', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '2.0.0'
    const workspacePath = realpathSync(process.cwd())
    const grant = { packageVersion, system: ['fs'] as const, storage: true }
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html',
      views: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
    }, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    let activeGrant: typeof grant | null = grant
    mgr.setCapabilityGrantResolver(() => activeGrant)
    let allowedSystem: string[] = ['fs']
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: allowedSystem, shell: [] }, revision: 1, state: 'user',
    }) as never)
    mgr.configurePlansFilesystemService()
    const dispatcher = (mgr as unknown as {
      pluginBackendHost: { bridgeDispatcher: { dispatch: (request: unknown, context: PlansBridgeContext) => Promise<unknown> } }
    }).pluginBackendHost.bridgeDispatcher
    const user = { kind: 'user', id: 'user-1' } as const
    const agent = { kind: 'agent', source: 'mcp', id: 'agent-1' } as const
    const resolveRoot = (initiator: typeof user | typeof agent): Promise<unknown> => dispatcher.dispatch(
      { id: 'bridge-root-1', origin: { kind: 'call', requestId: 'call-1' }, port: 'filesystem', operation: 'resolve_root', arguments: {} },
      {
        runtime: {
          pluginId: PLANS_PLUGIN_ID,
          packageVersion,
          workspaceId: mgr.workspaceIdForPath(workspacePath),
          instanceId: 'plans-view-1',
          contributionKey: 'navide.plans.window',
          hostWindowId: 'window-1',
          initiator,
        },
        workspacePath,
        authorizedPlanRoot: workspacePath,
        requestId: 'bridge-root-1',
        signal: new AbortController().signal,
        emit: () => undefined,
      },
    )
    try {
      await expect(resolveRoot(user)).resolves.toEqual({ root: workspacePath })
      await expect(resolveRoot(agent)).resolves.toEqual({ root: workspacePath })

      allowedSystem = []
      await expect(resolveRoot(agent)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      // The Execution Policy governs agents only; the user's own view is unaffected.
      await expect(resolveRoot(user)).resolves.toEqual({ root: workspacePath })

      activeGrant = null
      await expect(resolveRoot(user)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })

      // The long-lived watcher is gated the same way: without the Grant it is
      // refused at once instead of watching the workspace.
      const aborter = new AbortController()
      const watched = dispatcher.dispatch(
        { id: 'bridge-watch-1', origin: { kind: 'subscription', requestId: 'sub-1' }, port: 'filesystem', operation: 'watch', arguments: { rel_path: '' } },
        {
          runtime: {
            pluginId: PLANS_PLUGIN_ID,
            packageVersion,
            workspaceId: mgr.workspaceIdForPath(workspacePath),
            instanceId: 'plans-view-1',
            contributionKey: 'navide.plans.window',
            hostWindowId: 'window-1',
            initiator: user,
          },
          workspacePath,
          authorizedPlanRoot: workspacePath,
          requestId: 'bridge-watch-1',
          signal: aborter.signal,
          emit: () => undefined,
        },
      )
      const outcome = await Promise.race([
        watched.then(() => 'resolved', (error: unknown) => error),
        new Promise((resolve) => setTimeout(() => resolve('still-watching'), 500)),
      ])
      aborter.abort()
      await watched.catch(() => undefined)
      expect(outcome).toMatchObject({ code: 'CAPABILITY_DENIED' })
    } finally {
      await mgr.closeBackendPlugins()
    }
  })
})

describe('devPlansPluginDescriptor', () => {
  it('resolves v2 artifacts from explicit version and target coordinates while legacy paths stay unchanged', () => {
    const source = { isPackaged: true, resourcesPath: '/resources', artifactVersion: '4.5.6' }
    expect(officialPluginArtifactPackageDir(source, MINI_IDE_PLUGIN_ID, 'universal')).toBe(
      join('/resources', 'official-artifacts', MINI_IDE_PLUGIN_ID, '4.5.6', 'universal', 'package')
    )
    expect(bundledPlansV2Dir(source)).toBe(
      join('/resources', 'official-artifacts', PLANS_PLUGIN_ID, '4.5.6', `${process.platform}-${process.arch}`, 'package')
    )
    expect(bundledPlansDir(source)).toBe(join('/resources', 'plugins', 'plans'))
    expect(bundledGitDir(source)).toBe(join('/resources', 'plugins', 'git'))
    expect(officialPluginArtifactPackageDir(
      { isPackaged: false, resourcesPath: '', artifactVersion: '4.5.6', devRoot: '/repo' },
      MINI_IDE_PLUGIN_ID,
      'universal',
    )).toBe(join(
      '/repo',
      'dist-plugins',
      'official-artifacts',
      'factory-resources',
      MINI_IDE_PLUGIN_ID,
      '4.5.6',
      'universal',
      'package',
    ))
  })

  it('does not discover a combined Plans version from a sibling artifact directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-explicit-version-'))
    try {
      const decoy = join(
        root,
        'dist-plugins',
        'official-artifacts',
        'factory-resources',
        PLANS_PLUGIN_ID,
        '9.9.9',
        `${process.platform}-${process.arch}`,
        'package',
      )
      mkdirSync(join(decoy, 'frontend/left'), { recursive: true })
      mkdirSync(join(decoy, 'frontend/window'), { recursive: true })
      mkdirSync(join(decoy, 'backend'), { recursive: true })
      writeFileSync(join(decoy, 'manifest.json'), readFileSync('plugins/navide-plans/manifest.json'))
      writeFileSync(join(decoy, 'frontend/left/index.html'), '<!doctype html>')
      writeFileSync(join(decoy, 'frontend/window/index.html'), '<!doctype html>')
      const backendEntry = join(decoy, 'backend/navide-plans')
      writeFileSync(backendEntry, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      chmodSync(backendEntry, 0o700)

      expect(devPlansV2PluginBundle('1.2.3', root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the universal Git artifact path for an explicit development version', () => {
    expect(devGitPluginDescriptor('4.5.6', '/repo').entryFile).toBe(
      join('/repo', 'dist-plugins', 'official-artifacts', 'factory-resources', GIT_PLUGIN_ID, '4.5.6', 'universal', 'package', 'frontend/window/index.html')
    )
  })

  it('describes the navide.plans dev bundle with the plans-only event grant', () => {
    const desc = devPlansPluginDescriptor()
    expect(desc.id).toBe(PLANS_PLUGIN_ID)
    expect(desc.id).toBe('navide.plans')
    expect(desc.requires).toEqual(['fs', 'ui', 'plans', 'terminal'])
    // Built separately (vite.plans.config.ts) — never served by the dev server.
    expect(desc.devUrl).toBe('')
    expect(desc.entryFile.endsWith(join('dist-plugins', 'plans', 'index.html'))).toBe(true)
  })

  it('registers only via the builtin/official path (reserved id)', () => {
    const mgr = new FrontendPluginManager()
    expect(() => mgr.registerDescriptor(devPlansPluginDescriptor())).toThrow(/reserved/)
    expect(() =>
      mgr.registerDescriptor(devPlansPluginDescriptor(), { builtin: true })
    ).not.toThrow()
    expect(mgr.getDescriptor(PLANS_PLUGIN_ID)?.id).toBe('navide.plans')
  })

  it('keeps fixed Host development bundles out of explicit-package inventory', () => {
    const mgr = new FrontendPluginManager()
    mgr.registerDeveloperDescriptor(devPlansPluginDescriptor())
    expect(mgr.getDescriptor(PLANS_PLUGIN_ID)?.id).toBe(PLANS_PLUGIN_ID)
    expect(mgr.listInstalledPackages()).toEqual([])
  })

  it('registers the bundled Plans frontend without activating a backend fixture', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-bundle-'))
    try {
      const dir = join(root, 'dist-plugins', 'plans')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({ id: PLANS_PLUGIN_ID, version: '0.1.92', entry: 'index.html', requires: [] }),
      )
      writeFileSync(join(dir, 'index.html'), '<!doctype html>')

      const mgr = new FrontendPluginManager()
      expect(registerBundledPlans(mgr, {
        isPackaged: false,
        resourcesPath: '',
        artifactVersion: '0.1.92',
        devRoot: root,
      })).toEqual({ registered: true })
      expect(mgr.getDescriptor(PLANS_PLUGIN_ID)?.packageVersion).toBeUndefined()
      expect(mgr.hasBackendActivity()).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('registers the already-verified installed Plans backend before bundled fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-installed-'))
    const packageDir = join(root, 'navide.plans')
    const backendEntry = join(packageDir, 'backend', 'navide-plans')
    try {
      mkdirSync(join(packageDir, 'frontend'), { recursive: true })
      mkdirSync(join(packageDir, 'backend'), { recursive: true })
      writeFileSync(join(packageDir, 'frontend', 'index.html'), '<!doctype html>')
      writeFileSync(join(packageDir, 'frontend', 'left.html'), '<!doctype html>')
      writeFileSync(backendEntry, '#!/bin/sh\n')
      chmodSync(backendEntry, 0o700)
      const canonicalPackageDir = realpathSync(packageDir)
      const packageVersion = '2.0.0'
      const mgr = new FrontendPluginManager()
      mgr.registerDescriptor(
        {
          id: PLANS_PLUGIN_ID,
          packageVersion,
          packageDir: canonicalPackageDir,
          requires: [],
          devUrl: '',
          entryFile: join(packageDir, 'frontend', 'index.html'),
          views: [
            {
              id: 'left',
              contributionKey: `${PLANS_PLUGIN_ID}.left`,
              kind: 'custom',
              location: 'left',
              title: 'Plans',
              entryFile: join(packageDir, 'frontend', 'left.html'),
            },
            {
              id: 'window',
              contributionKey: `${PLANS_PLUGIN_ID}.window`,
              kind: 'custom',
              location: 'window',
              title: 'Plans',
              entryFile: join(packageDir, 'frontend', 'index.html'),
            },
          ],
          capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs', 'ui'] }),
        },
        { official: true },
      )

      expect(registerBundledPlans(mgr, {
        isPackaged: false,
        resourcesPath: '',
        artifactVersion: '2.0.0',
        devRoot: join(root, 'no-bundled-copy'),
        installedActivation: {
          pluginId: PLANS_PLUGIN_ID,
          packageVersion,
          packageDir: canonicalPackageDir,
          views: [],
          backend: { entryFile: backendEntry, protocolVersion: 1, activation: 'startup' },
          provenance: 'official-registry',
          artifactDigest: 'ab'.repeat(32),
        },
      })).toEqual({ registered: true })
      expect(mgr.hasBackendActivation(PLANS_PLUGIN_ID, packageVersion)).toBe(true)
      await mgr.closeBackendPlugins()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a backend activation before its selected package descriptor exists', () => {
    const mgr = new FrontendPluginManager()

    expect(() => mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion: '1.0.0',
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_ACTIVATION',
      message: 'Backend activation has no selected package descriptor.',
    }))
    expect(mgr.hasBackendActivity()).toBe(false)
  })

  it('registers an installed backend-only activation only for its exact package identity', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.backend-only'
    const packageVersion = '1.0.0'
    const packageDir = process.cwd()
    const activation = {
      pluginId,
      packageVersion,
      packageDir,
      entryFile: '/plugins/acme.backend-only/backend',
      protocolVersion: 1 as const,
      activation: 'startup' as const,
      approvedMethods: ['backend.run'],
      approvedEvents: [],
    }

    mgr.registerInstalledPackage(
      { id: pluginId, packageVersion, requires: [] },
      undefined,
      {},
      packageDir,
    )
    mgr.registerBackendActivation(activation)

    expect(mgr.hasBackendActivation(pluginId, packageVersion)).toBe(true)
    expect(mgr.getBackendActivation(pluginId, packageVersion)).toEqual(
      expect.objectContaining({ pluginId, packageVersion }),
    )

    await mgr.revokePackageVersion(pluginId, packageVersion)
    expect(mgr.hasBackendActivation(pluginId, packageVersion)).toBe(false)

    // The dynamic activation catalog may restore this Host-verified
    // backend-only version after the restart drain completes.
    mgr.registerBackendActivation(activation)
    expect(mgr.hasBackendActivation(pluginId, packageVersion)).toBe(true)

    await mgr.closeBackendPlugins()
  })

  it('keeps a disabled package in the inventory but registers neither its views nor its backend', () => {
    const mgr = new FrontendPluginManager()
    const disabled = new Set(['acme.disabled', 'navide.git'])
    mgr.setDisabledPluginResolver((id) => disabled.has(id))
    const packageDir = process.cwd()
    const viewDescriptor: PluginLaunchDescriptor = { ...descriptor('acme.disabled'), packageVersion: '1.0.0', packageDir }

    mgr.registerInstalledPackage({ id: 'acme.disabled', packageVersion: '1.0.0', requires: [] }, viewDescriptor, {}, packageDir)

    expect(mgr.isPluginDisabled('acme.disabled')).toBe(true)
    expect(mgr.getDescriptor('acme.disabled')).toBeUndefined()
    expect(mgr.listInstalledPackages()).toMatchObject([{ id: 'acme.disabled', packageVersion: '1.0.0' }])
    expect(() => mgr.registerBackendActivation({
      pluginId: 'acme.disabled',
      packageVersion: '1.0.0',
      packageDir,
      entryFile: '/plugins/acme.disabled/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: [],
      approvedEvents: [],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_ACTIVATION', message: 'Backend plugin is disabled.' }))
    expect(mgr.hasBackendActivation('acme.disabled', '1.0.0')).toBe(false)
    // First-party ids are never disabled by this switch.
    expect(mgr.isPluginDisabled('navide.git')).toBe(false)

    disabled.delete('acme.disabled')
    mgr.registerInstalledPackage({ id: 'acme.disabled', packageVersion: '1.0.0', requires: [] }, viewDescriptor, {}, packageDir)
    expect(mgr.getDescriptor('acme.disabled')?.packageVersion).toBe('1.0.0')
  })

  it('rejects a backend-only activation with a mismatched installed package root', () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.backend-only'
    mgr.registerInstalledPackage(
      { id: pluginId, packageVersion: '1.0.0', requires: [] },
      undefined,
      {},
      process.cwd(),
    )

    expect(() => mgr.registerBackendActivation({
      pluginId,
      packageVersion: '1.0.0',
      packageDir: join(process.cwd(), 'src'),
      entryFile: '/plugins/acme.backend-only/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['backend.run'],
      approvedEvents: [],
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_ACTIVATION',
      message: 'Backend activation does not match the installed package identity.',
    }))
  })

  it('rejects a backend activation whose package root is not the selected descriptor root', () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: '/plugins/navide.plans/index.html',
      views: [],
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })

    expect(() => mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: join(process.cwd(), 'src'),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_ACTIVATION' }))
  })

  it('rejects and tears down a Plans view when backend binding fails', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion, system: ['fs'], storage: true },
      runtimeBinding: {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        workspaceId: 'bound-workspace',
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      capabilityContext: context,
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion,
      system: ['fs'],
      storage: true,
    }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindView').mockImplementation(() => {
      throw new Error('binding race')
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const host = new FakeBrowserWindow()
    try {
      await expect(mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace',
        capabilityContext: context,
      })).rejects.toThrow('binding race')

      expect((mgr as unknown as { running: Map<string, unknown> }).running.size).toBe(0)
      expect(bind).toHaveBeenCalledOnce()
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('could not bind'))
    } finally {
      warning.mockRestore()
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  // The quit teardown closes every package backend; a quit cancelled after it
  // leaves the app running, so the backends must come back: the activations
  // re-registered and every still-open backend view bound again.
  it('reopens the package backends after a cancelled quit closed them', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion, system: ['fs'], storage: true },
      runtimeBinding: {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        workspaceId: 'bound-workspace',
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      capabilityContext: context,
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({ packageVersion, system: ['fs'], storage: true }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindView').mockResolvedValue()
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace',
        capabilityContext: context,
      })
      expect(bind).toHaveBeenCalledOnce()

      await mgr.closeBackendPlugins()
      expect(mgr.hasBackendActivation(PLANS_PLUGIN_ID, packageVersion)).toBe(false)

      mgr.reopenBackendPlugins()
      expect(mgr.hasBackendActivation(PLANS_PLUGIN_ID, packageVersion)).toBe(true)
      await vi.waitFor(() => expect(bind).toHaveBeenCalledTimes(2))
      expect(bind.mock.calls[1][0]).toMatchObject({ pluginId: PLANS_PLUGIN_ID, instanceId: handle.instanceId })
      mgr.destroyInstance(handle.instanceId)
    } finally {
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('rejects a package Plans call whose workspace path is not sender-bound', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion, system: ['fs'], storage: true },
      runtimeBinding: {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        workspaceId: 'bound-workspace',
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      capabilityContext: context,
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion,
      system: ['fs'],
      storage: true,
    }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindView').mockResolvedValue()
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call')
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace',
        capabilityContext: context,
      })
      const webContents = (host.children[0] as FakeViewLike).webContents
      const invalidTimeout = await ipcHandlers.get('plugin:backend:call')?.(
        { sender: { id: webContents.id } },
        {
          reqId: 'invalid-timeout-1',
          name: 'plans.resolve_root',
          args: { workspace_path: '/workspace' },
          timeoutMs: 0,
        },
      )
      expect(invalidTimeout).toMatchObject({
        reqId: 'invalid-timeout-1',
        ok: false,
        error: { code: 'INVALID_ARGUMENT' },
      })
      expect(hostCall).not.toHaveBeenCalled()
      const response = await ipcHandlers.get('plugin:backend:call')?.(
        { sender: { id: webContents.id } },
        {
          reqId: 'scope-1',
          name: 'plans.resolve_root',
          args: { workspace_path: '/other-workspace' },
        },
      )

      expect(response).toMatchObject({
        reqId: 'scope-1',
        ok: false,
        error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
      })
      expect(hostCall).not.toHaveBeenCalled()
      mgr.destroyInstance(handle.instanceId)
    } finally {
      bind.mockRestore()
      hostCall.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it.each([
    ['provisioning', 'cancel'], ['provisioning', 'timeout'],
    ['migration', 'cancel'], ['migration', 'timeout'],
  ] as const)('reserves Plans create while %s and honors %s', async (phase, ending) => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window', contributionKey: `${PLANS_PLUGIN_ID}.window`, kind: 'custom',
      location: 'window', title: 'Plans', entryFile: '/plugins/navide.plans/index.html',
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion, system: ['fs'], storage: true },
      runtimeBinding: {
        pluginId: PLANS_PLUGIN_ID, packageVersion, workspaceId: 'bound-workspace',
        instanceId: null, audience: view.contributionKey,
      },
    }
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(), requires: [],
      devUrl: '', entryFile: view.entryFile, views: [view],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }), capabilityContext: context,
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend', protocolVersion: 1, activation: 'startup',
      approvedMethods: ['plans.create'], approvedEvents: [], approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({ packageVersion, system: ['fs'], storage: true }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindView').mockResolvedValue()
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call').mockResolvedValue(null as never)
    let release!: (value: boolean) => void
    const paused = new Promise<boolean>((resolve) => { release = resolve })
    const provision = vi.spyOn(
      mgr as unknown as { provisionPlansAssets: (path: string) => Promise<boolean> },
      'provisionPlansAssets',
    ).mockReturnValue(phase === 'provisioning' ? paused : Promise.resolve(true))
    if (phase === 'migration') mgr.setPlansStorageReadinessHandler(() => paused)
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host), bounds: 'fill', workspacePath: '/workspace', capabilityContext: context,
      })
      const sender = { sender: { id: (host.children[0] as FakeViewLike).webContents.id } }
      const payload = { reqId: 'pending-create', name: 'plans.create', args: { workspace_path: '/workspace' }, timeoutMs: 20 }
      const call = ipcHandlers.get('plugin:backend:call')!
      const pending = call(sender, payload)
      // Do not await a duplicate before releasing provisioning: broken code
      // admits it and would otherwise leave the regression test hanging.
      const duplicate = call(sender, payload)
      if (ending === 'cancel') ipcListeners.get('plugin:backend:cancel')?.(sender, { reqId: payload.reqId })
      else await new Promise((resolve) => setTimeout(resolve, 40))
      release(true)
      expect(await duplicate).toMatchObject({ error: { code: 'BAD_REQUEST' } })
      expect(await pending).toMatchObject({ error: { code: ending === 'cancel' ? 'USER_CANCELLED' : 'TIMEOUT' } })
      if (phase === 'provisioning') expect(provision).toHaveBeenCalledOnce()
      else expect(provision).not.toHaveBeenCalled()
      expect(hostCall).not.toHaveBeenCalled()
      mgr.destroyInstance(handle.instanceId)
    } finally {
      release(true)
      bind.mockRestore()
      hostCall.mockRestore()
      provision.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('applies the sender-bound workspace scope to agent Plans calls', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call').mockResolvedValue(null)
    const host = new FakeBrowserWindow()

    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
      })
      const running = (mgr as unknown as {
        running: Map<string, { backendWorkspaceId: string | null }>
      }).running.get(handle.instanceId)
      expect(running).toBeDefined()
      running!.backendWorkspaceId = createHash('sha256').update(resolve('/workspace')).digest('hex')

      const response = await mgr.executeAgentBackendCall(handle.instanceId, {
        reqId: 'agent-scope-1',
        name: 'plans.resolve_root',
        args: { workspace_path: '/other-workspace' },
      })

      expect(response).toMatchObject({
        reqId: 'agent-scope-1',
        ok: false,
        error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
      })
      expect(hostCall).not.toHaveBeenCalled()
      mgr.destroyInstance(handle.instanceId)
    } finally {
      hostCall.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('requires the v2 Manifest context and package grant before an agent backend call', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.agent-backend'
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'main',
      contributionKey: `${pluginId}.main`,
      kind: 'custom',
      location: 'main',
      title: 'Agent backend',
      entryFile: '/plugins/acme.agent-backend/index.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: pluginId,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(descriptor)
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call').mockResolvedValue(null)
    const host = new FakeBrowserWindow()

    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
      })

      await expect(mgr.executeAgentBackendCall(handle.instanceId, {
        reqId: 'agent-backend-context-1',
        name: 'fixture.echo',
        args: null,
      })).resolves.toMatchObject({
        reqId: 'agent-backend-context-1',
        ok: false,
        error: { code: 'CAPABILITY_DENIED' },
      })
      expect(hostCall).not.toHaveBeenCalled()
      mgr.destroyInstance(handle.instanceId)
    } finally {
      hostCall.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('maps a Host resource limit to the stable IPC error code', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
    })
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call').mockRejectedValue(
      new BackendPluginError('RESOURCE_LIMIT'),
    )
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace',
      })
      const webContents = (host.children[0] as FakeViewLike).webContents
      const response = await ipcHandlers.get('plugin:backend:call')?.(
        { sender: { id: webContents.id } },
        {
          reqId: 'resource-limit-1',
          name: 'plans.resolve_root',
          args: { workspace_path: '/workspace' },
        },
      )

      expect(response).toMatchObject({
        reqId: 'resource-limit-1',
        ok: false,
        error: { code: 'RESOURCE_LIMIT' },
      })
      mgr.destroyInstance(handle.instanceId)
    } finally {
      hostCall.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('runs more renderer backend calls at once than the old 64-call cap', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
    })
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call').mockImplementation(async () => {
      await released
      return { root: '/workspace' }
    })
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace',
      })
      const webContents = (host.children[0] as FakeViewLike).webContents
      // User ruling L3: no concurrency cap; the 65th call used to get RESOURCE_LIMIT.
      const responses = Array.from({ length: 100 }, (_, index) =>
        ipcHandlers.get('plugin:backend:call')?.(
          { sender: { id: webContents.id } },
          { reqId: `concurrent-${index}`, name: 'plans.resolve_root', args: { workspace_path: '/workspace' } },
        )
      )
      await vi.waitFor(() => expect(hostCall).toHaveBeenCalledTimes(100))
      release()
      const settled = await Promise.all(responses)
      expect(settled.filter((response) => (response as { ok?: boolean }).ok !== true)).toEqual([])
      mgr.destroyInstance(handle.instanceId)
    } finally {
      release()
      hostCall.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('reports backend activity only while a backend runtime is bound, not for a startup registration', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const packageDir = realpathSync(process.cwd())
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir,
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    // What a packaged launch does: registerBundledPlans() approves the bundled
    // Plans backend as metadata. No child is spawned, so there is no activity.
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir,
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
    })
    expect(mgr.hasBackendActivation(PLANS_PLUGIN_ID, packageVersion)).toBe(true)
    expect(mgr.hasBackendActivity()).toBe(false)

    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace',
      })
      // The view bound a backend runtime: a child is live.
      expect(mgr.hasBackendActivity()).toBe(true)
      mgr.destroyInstance(handle.instanceId)
      // Destroying the view starts the unbind; the child is only stopped by the
      // awaited close() inside it, so the activity lasts until that drain ends.
      expect(mgr.hasBackendActivity()).toBe(true)
      // The last bound runtime is gone; the registration alone is not activity.
      await vi.waitFor(() => expect(mgr.hasBackendActivity()).toBe(false))
    } finally {
      await mgr.closeBackendPlugins()
    }
  })

  /** The packaged Plans shape the quit path is about: a v2 window view plus the
   *  bundled backend activation registered as metadata. */
  function registerPlansPackage(mgr: FrontendPluginManager): {
    packageDescriptor: PluginLaunchDescriptor
    view: NonNullable<PluginLaunchDescriptor['views']>[number]
    packageVersion: string
  } {
    const packageVersion = '1.0.0'
    const packageDir = realpathSync(process.cwd())
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir,
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir,
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
    })
    return { packageDescriptor, view, packageVersion }
  }

  const plansOpenOptions = (host: FakeBrowserWindow): Parameters<FrontendPluginManager['openView']>[2] => ({
    hostWindow: asHost(host),
    bounds: 'fill',
    workspacePath: '/workspace',
    query: '?workspace_path=%2Fworkspace',
  })

  it('reports no backend activity after closeBackendPlugins so the re-entrant before-quit terminates', async () => {
    const mgr = new FrontendPluginManager()
    const { packageDescriptor, view } = registerPlansPackage(mgr)
    const host = new FakeBrowserWindow()
    const handle = await mgr.openView(packageDescriptor, view, plansOpenOptions(host))

    // First quit: index.ts sees activity, prevents the default and runs
    // teardownBackendAndQuit().
    expect(mgr.hasBackendActivity()).toBe(true)
    await mgr.closeBackendPlugins()

    // teardownBackendAndQuit() then calls app.quit(), which re-emits
    // before-quit. No window was ever closed - the quit was prevented - so the
    // Plans record is still live. If the guard still reports activity here the
    // default is prevented again and the App can only be force-killed.
    const running = (mgr as unknown as { running: Map<string, unknown> }).running
    expect(running.has(handle.instanceId)).toBe(true)
    expect(mgr.hasBackendActivity()).toBe(false)
  })

  it('keeps reporting backend activity while a destroyed view backend unbind is still draining', async () => {
    const mgr = new FrontendPluginManager()
    const { packageDescriptor, view } = registerPlansPackage(mgr)
    let releaseClose: () => void = () => {}
    const closing = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    const close = vi.spyOn(PluginBackendSupervisor.prototype, 'close').mockReturnValue(closing)
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(packageDescriptor, view, plansOpenOptions(host))
      expect(mgr.hasBackendActivity()).toBe(true)

      mgr.destroyInstance(handle.instanceId)
      // The record is already out of `running`, but the child is only stopped
      // by the awaited close() inside unbindView. Reporting no activity here
      // takes the native quit fast path, which SIGKILLs the child mid-drain -
      // possibly mid-write to a plan document.
      const running = (mgr as unknown as { running: Map<string, unknown> }).running
      expect(running.size).toBe(0)
      expect(mgr.hasBackendActivity()).toBe(true)

      releaseClose()
      await vi.waitFor(() => expect(mgr.hasBackendActivity()).toBe(false))
    } finally {
      releaseClose()
      close.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('clears the stopping barrier when the revocation sweep throws synchronously', async () => {
    const mgr = new FrontendPluginManager()
    const { packageDescriptor, view, packageVersion } = registerPlansPackage(mgr)
    const sweep = vi
      .spyOn(
        FrontendPluginManager.prototype as unknown as {
          clearGuestReservationsForPackageVersion: (pluginId: string, packageVersion: string) => void
        },
        'clearGuestReservationsForPackageVersion',
      )
      .mockImplementation(() => {
        throw new Error('guest reservation sweep failed')
      })
    try {
      await expect(mgr.revokePackageVersion(PLANS_PLUGIN_ID, packageVersion)).rejects.toThrow(
        'guest reservation sweep failed',
      )
    } finally {
      sweep.mockRestore()
    }

    // A stranded key is permanent: every isPluginStopping /
    // isPackageVersionStopping site then answers PLUGIN_STOPPING for this
    // package for the life of the App, starting with the next open.
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(packageDescriptor, view, plansOpenOptions(host))
      expect(handle.instanceId).toBeTypeOf('string')
      mgr.destroyInstance(handle.instanceId)
    } finally {
      await mgr.closeBackendPlugins()
    }
  })

  it('preserves generic BACKEND_UNAVAILABLE semantics for renderer and fallback while emitting host-only diagnostics on startup failure', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: packageDescriptor.id,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
    })

    const spawnError = new Error('spawn /private/opt/plans ENOENT')
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call').mockRejectedValue(
      new BackendPluginError('BACKEND_UNAVAILABLE', undefined, { cause: spawnError }),
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failureHandler = vi.fn()
    mgr.setPlansBackendFailureHandler(failureHandler)

    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace',
      })
      const webContents = (host.children[0] as FakeViewLike).webContents
      const response = await ipcHandlers.get('plugin:backend:call')?.(
        { sender: { id: webContents.id } },
        {
          reqId: 'call-unavailable-1',
          name: 'plans.resolve_root',
          args: { workspace_path: '/workspace' },
        },
      )

      expect(response).toEqual({
        reqId: 'call-unavailable-1',
        ok: false,
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message: 'Backend plugin is unavailable.',
        },
      })
      expect(JSON.stringify(response)).not.toContain('/private/opt/plans')

      // Simulate child failure callback to verify host-private diagnostic logging and fallback
      const hostInstance = (mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost
      const onStderr = (hostInstance as unknown as { onStderr?: (chunk: string) => void }).onStderr
      onStderr?.('test child stderr\n')
      expect(warnSpy).toHaveBeenCalledWith('[plugin-backend] test child stderr')

      const onBackendFailure = (hostInstance as unknown as { onBackendFailure?: (runtime: unknown, error: unknown) => void }).onBackendFailure
      onBackendFailure?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion, instanceId: handle.instanceId },
        new BackendPluginError('BACKEND_UNAVAILABLE', undefined, { cause: spawnError }),
      )

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[plugin-backend] Backend child failure for navide.plans:'),
      )
      expect(failureHandler).toHaveBeenCalledWith(expect.objectContaining({
        instanceId: handle.instanceId,
        reason: 'Backend plugin is unavailable.',
      }))
      expect(failureHandler.mock.calls[0][0].reason).not.toContain('/private/opt/plans')

      mgr.destroyInstance(handle.instanceId)
    } finally {
      warnSpy.mockRestore()
      hostCall.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('sanitizes package-child stderr with control sequences and newlines, emitting each retained line with trusted host prefix and bounded retention', () => {
    const raw = '\x1b[31;1mfatal:\x1b[0m failed to load /internal/path/lib.so\x1b]0;title\x07\r\n\x00\x082026-09-03T12:00:00.000Z [auth] spoofed admin login\r\nline 3\r'
    const lines = sanitizeDiagnosticLines(raw)
    expect(lines).toEqual([
      'fatal: failed to load /internal/path/lib.so',
      '2026-09-03T12:00:00.000Z [auth] spoofed admin login',
      'line 3',
    ])

    // Verify line length bounding
    const longLine = 'a'.repeat(MAX_DIAGNOSTIC_LINE_CHARS + 50)
    const truncatedLine = sanitizeDiagnosticLines(longLine)
    expect(truncatedLine[0]).toHaveLength(MAX_DIAGNOSTIC_LINE_CHARS + '... [line truncated]'.length)
    expect(truncatedLine[0]).toContain('... [line truncated]')

    // Verify line count bounding
    const manyLines = Array.from({ length: MAX_DIAGNOSTIC_LINES_PER_EMISSION + 20 }, (_, i) => `line ${i}`).join('\n')
    const truncatedLines = sanitizeDiagnosticLines(manyLines)
    expect(truncatedLines).toHaveLength(MAX_DIAGNOSTIC_LINES_PER_EMISSION + 1)
    expect(truncatedLines[truncatedLines.length - 1]).toBe('... [diagnostic lines truncated]')

    // Verify emission via FrontendPluginManager onStderr
    const mgr = new FrontendPluginManager()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const hostInstance = (mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost
      const onStderr = (hostInstance as unknown as { onStderr?: (chunk: string) => void }).onStderr
      onStderr?.(raw)

      expect(warnSpy).toHaveBeenCalledTimes(3)
      for (const call of warnSpy.mock.calls) {
        expect(call[0]).toMatch(/^\[plugin-backend\] /)
        expect(call[0]).not.toContain('\x1b')
        expect(call[0]).not.toContain('\r')
        expect(call[0]).not.toContain('\n')
      }
      expect(warnSpy).toHaveBeenNthCalledWith(1, '[plugin-backend] fatal: failed to load /internal/path/lib.so')
      expect(warnSpy).toHaveBeenNthCalledWith(2, '[plugin-backend] 2026-09-03T12:00:00.000Z [auth] spoofed admin login')
      expect(warnSpy).toHaveBeenNthCalledWith(3, '[plugin-backend] line 3')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('sanitizes package-child failure cause and avoids duplicate full stack/cause entries in host diagnostics', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Plans',
      entryFile: '/plugins/navide.plans/index.html',
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: packageDescriptor.id,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.resolve_root'],
      approvedEvents: ['plans.changed'],
    })

    const pathLikeError = new Error('spawn /custom/private/plans/start ENOENT\x1b[31m\x07\r\n    at Object.spawnProcess (test.ts:1:1)')
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call').mockRejectedValue(
      new BackendPluginError('BACKEND_UNAVAILABLE', undefined, { cause: pathLikeError }),
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failureHandler = vi.fn()
    mgr.setPlansBackendFailureHandler(failureHandler)

    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace',
      })

      // Simulate onBackendFailure with path-like cause
      const hostInstance = (mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost
      const onBackendFailure = (hostInstance as unknown as { onBackendFailure?: (runtime: unknown, error: unknown) => void }).onBackendFailure
      const backendError = new BackendPluginError('BACKEND_UNAVAILABLE', undefined, { cause: pathLikeError })
      onBackendFailure?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion, instanceId: handle.instanceId },
        backendError,
      )

      // Verified failure was logged with trusted prefix on each line, without ANSI or CR injection
      const failureCalls = warnSpy.mock.calls.filter(([arg]) => String(arg).includes('Backend child failure'))
      expect(failureCalls.length).toBeGreaterThanOrEqual(1)
      for (const call of warnSpy.mock.calls) {
        expect(call[0]).toMatch(/^\[plugin-backend\] /)
        expect(call[0]).not.toContain('\x1b')
        expect(call[0]).not.toContain('\r')
      }

      // Now verify that if another failure handler or view-bind catch runs with the same backendError,
      // it avoids duplicate full stack/cause entries
      const callCountBefore = warnSpy.mock.calls.length
      onBackendFailure?.(
        { pluginId: PLANS_PLUGIN_ID, packageVersion, instanceId: handle.instanceId },
        backendError,
      )
      expect(warnSpy.mock.calls.length).toBe(callCountBefore)

      // Recovery payload stays generic and does not leak the path-like cause
      expect(failureHandler).toHaveBeenCalledWith(expect.objectContaining({
        instanceId: handle.instanceId,
        reason: 'Backend plugin is unavailable.',
      }))
      expect(failureHandler.mock.calls[0][0].reason).not.toContain('/custom/private/plans')

      mgr.destroyInstance(handle.instanceId)
    } finally {
      warnSpy.mockRestore()
      hostCall.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })
})

describe('production Plans agent backend routing', () => {
  it.each([
    ['torn down mid-call', 'PLUGIN_STOPPING', true, true],
    ['live instance', 'BACKEND_UNAVAILABLE', false, false],
  ] as const)('withdraws Plans for a failed view call only when the child failed: %s', async (_label, code, tearDown, available) => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window', contributionKey: `${PLANS_PLUGIN_ID}.window`, kind: 'custom', location: 'window',
      title: 'Plans', entryFile: '/plugins/navide.plans/index.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(), requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '', entryFile: view.entryFile, views: [view],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend', protocolVersion: 1, activation: 'startup',
      approvedMethods: ['plans.list'], approvedEvents: [], approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({ packageVersion, system: ['fs'], storage: true }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindView').mockResolvedValue()
    const unbind = vi.spyOn(PluginBackendHost.prototype, 'unbindView').mockResolvedValue()
    const host = new FakeBrowserWindow()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let instanceId = ''
    const hostCall = vi.spyOn(PluginBackendHost.prototype, 'call').mockImplementation(async () => {
      // Closing the view drains its child, which rejects the call in flight.
      if (tearDown) mgr.destroyInstance(instanceId)
      throw new BackendPluginError(code)
    })
    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host), bounds: 'fill', workspacePath: '/workspace',
        capabilityContext: mgr.plansCapabilityContext(packageVersion, '/workspace', view.contributionKey)!,
      })
      instanceId = handle.instanceId
      expect(mgr.isPlansBackendAvailable()).toBe(true)
      const response = await ipcHandlers.get('plugin:backend:call')!(
        { sender: { id: (host.children[0] as FakeViewLike).webContents.id } },
        { reqId: 'teardown-call', name: 'plans.list', args: {} },
      )
      expect(response).toMatchObject({ ok: false, error: { code } })
      expect(mgr.isPlansBackendAvailable()).toBe(available)
      if (!available) {
        // The withdrawal names the call and the code that caused it.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`plans.list failed with ${code}`))
      }
      if (!tearDown) mgr.destroyInstance(handle.instanceId)
    } finally {
      warn.mockRestore()
      hostCall.mockRestore()
      unbind.mockRestore()
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it.each(['ready', 'failed', 'revoked'] as const)('gates renderer and agent storage writes on migration: %s', async (outcome) => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window', contributionKey: `${PLANS_PLUGIN_ID}.window`, kind: 'custom', location: 'window',
      title: 'Plans', entryFile: '/plugins/navide.plans/index.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(), requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '', entryFile: view.entryFile, views: [view],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend', protocolVersion: 1, activation: 'startup',
      approvedMethods: ['plans.list'], approvedEvents: [], approvedBridgePorts: ['filesystem'],
    })
    let granted = true
    mgr.setCapabilityGrantResolver(() => granted ? { packageVersion, system: ['fs'], storage: true } : null)
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindView').mockResolvedValue()
    const host = new FakeBrowserWindow()
    const storage = vi.fn().mockResolvedValue(null)
    mgr.setPublicStorageHandler(storage)
    let release!: (ready: boolean) => void
    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host), bounds: 'fill', workspacePath: '/workspace',
        capabilityContext: mgr.plansCapabilityContext(packageVersion, '/workspace', view.contributionKey)!,
      })
      mgr.setPlansStorageReadinessHandler(() => new Promise<boolean>((resolve) => { release = resolve }))
      const payload = { reqId: 'storage-gate', ns: 'storage', method: 'set', args: { scope: 'workspace', key: 'plans.sort', value: 'title' } }
      for (const origin of ['renderer', 'agent']) {
        granted = true
        const pending = origin === 'renderer'
          ? ipcHandlers.get('plugin:cap:call')!({ sender: { id: (host.children[0] as FakeViewLike).webContents.id } }, payload)
          : mgr.executeAgentCapability(handle.instanceId, payload)
        await Promise.resolve()
        const previousCalls = storage.mock.calls.length
        if (outcome === 'revoked') granted = false
        release(outcome !== 'failed')
        const response = await pending
        expect(response).toMatchObject({ ok: outcome === 'ready' })
        expect(storage).toHaveBeenCalledTimes(previousCalls + (outcome === 'ready' ? 1 : 0))
      }
      mgr.destroyInstance(handle.instanceId)
    } finally {
      release?.(false)
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it.each(['ready', 'failed', 'revoked', 'timeout'] as const)('awaits storage readiness before headless dispatch: %s', async (outcome) => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(), requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '', entryFile: '/plugins/navide.plans/frontend/window/index.html', views: [],
    }, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans', protocolVersion: 1, activation: 'startup',
      approvedMethods: ['plans.list'], agentMethods: ['plans.list'], approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    let granted = true
    mgr.setCapabilityGrantResolver(() => granted ? { packageVersion, system: ['fs'], storage: true } : null)
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] }, revision: 1, state: 'user',
    }))
    let settle!: (ready: boolean) => void
    const readiness = new Promise<boolean>((resolve) => { settle = resolve })
    mgr.setPlansStorageReadinessHandler(() => readiness)
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindWorkspace').mockResolvedValue('headless-storage')
    const call = vi.spyOn(PluginBackendHost.prototype, 'call').mockResolvedValue({ plans: [] } as never)
    try {
      const pending = mgr.executeAgentBackendCallForWorkspace(PLANS_PLUGIN_ID, '/workspace', {
        reqId: 'storage-gate', name: 'plans.list', args: {}, timeoutMs: 20,
      })
      await Promise.resolve()
      expect(bind).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
      if (outcome === 'revoked') granted = false
      if (outcome !== 'timeout') settle(outcome !== 'failed')
      const result = await pending
      if (outcome === 'ready') {
        expect(result.ok).toBe(true)
        expect(call).toHaveBeenCalledOnce()
      } else {
        expect(result).toMatchObject({ ok: false, error: { code: outcome === 'timeout' ? 'TIMEOUT' : outcome === 'failed' ? 'BACKEND_UNAVAILABLE' : 'CAPABILITY_DENIED' } })
        if (outcome === 'failed') {
          // Nothing was dispatched and the agent policy was verified, so the MCP
          // caller may serve the request from its local plan tools rather than
          // fail with "Plans storage is unavailable" for the rest of the session.
          expect(result).toMatchObject({ recoveryDisposition: 'legacy-safe-before-dispatch' })
        } else {
          expect(result).not.toHaveProperty('recoveryDisposition')
        }
        expect(bind).not.toHaveBeenCalled()
        expect(call).not.toHaveBeenCalled()
      }
    } finally {
      settle(false)
      bind.mockRestore()
      call.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('denies non-allowlisted methods before binding and preserves the minted agent Initiator', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html',
      views: [],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list', 'plans.create', 'plans.delete'],
      agentMethods: ['plans.list', 'plans.create'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion,
      system: ['fs'],
      storage: true,
    }))
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] },
      revision: 1,
      state: 'user',
    }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindWorkspace').mockResolvedValue('headless-plans-1')
    const call = vi.spyOn(PluginBackendHost.prototype, 'call').mockResolvedValue({
      rel_path: '.agent-team/plans/agent-plan.html',
    } as never)
    const provision = vi
      .spyOn(
        mgr as unknown as { provisionPlansAssets: (workspacePath: string) => Promise<boolean> },
        'provisionPlansAssets',
      )
      .mockResolvedValue(true)

    try {
      await expect(mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        '/workspace',
        { reqId: 'agent-denied-1', name: 'plans.delete', args: { rel_path: 'plan.html' } },
      )).resolves.toMatchObject({
        reqId: 'agent-denied-1',
        ok: false,
        error: { code: 'CAPABILITY_DENIED' },
      })
      expect(bind).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()

      await expect(mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        '/workspace',
        {
          reqId: 'agent-create-1',
          name: 'plans.create',
          args: { name: 'Agent plan', overview: '', todos: [] },
        },
      )).resolves.toEqual({
        reqId: 'agent-create-1',
        ok: true,
        result: { rel_path: '.agent-team/plans/agent-plan.html' },
      })
      expect(bind).toHaveBeenCalledOnce()
      expect(call).toHaveBeenCalledWith(
        'headless-plans-1',
        'plans.create',
        { name: 'Agent plan', overview: '', todos: [] },
        { initiator: expect.objectContaining({ kind: 'agent', source: 'mcp' }) },
      )

      await expect(mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        '/workspace',
        { reqId: 'agent-list-1', name: 'plans.list', args: {} },
      )).resolves.toMatchObject({ reqId: 'agent-list-1', ok: true })
      expect(bind).toHaveBeenCalledOnce()

      call.mockRejectedValueOnce(new BackendPluginError(
        'PLUGIN_ERROR',
        'child denied',
        { pluginCode: 'CAPABILITY_DENIED' },
      ))
      await expect(mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        '/workspace',
        { reqId: 'agent-denied-child-1', name: 'plans.list', args: {} },
      )).resolves.toMatchObject({
        reqId: 'agent-denied-child-1',
        ok: false,
        error: { code: 'CAPABILITY_DENIED' },
      })

      // A write past the child's size limit keeps its meaning instead of
      // collapsing into the generic plugin failure.
      call.mockRejectedValueOnce(new BackendPluginError(
        'PLUGIN_ERROR',
        'child limit',
        { pluginCode: 'RESOURCE_LIMIT' },
      ))
      await expect(mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        '/workspace',
        { reqId: 'agent-limit-child-1', name: 'plans.list', args: {} },
      )).resolves.toMatchObject({
        reqId: 'agent-limit-child-1',
        ok: false,
        error: { code: 'RESOURCE_LIMIT', message: 'Backend resource limit reached.' },
      })
    } finally {
      provision.mockRestore()
      call.mockRestore()
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('denies the headless route when the exact package Grant is missing', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html',
      views: [],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.create'],
      agentMethods: ['plans.create'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindWorkspace')
    try {
      await expect(mgr.executeAgentBackendCallForWorkspace(
        PLANS_PLUGIN_ID,
        '/workspace',
        {
          reqId: 'agent-no-grant-1',
          name: 'plans.create',
          args: { name: 'Denied plan', overview: '', todos: [] },
        },
      )).resolves.toMatchObject({
        reqId: 'agent-no-grant-1',
        ok: false,
        error: { code: 'CAPABILITY_DENIED' },
      })
      expect(bind).not.toHaveBeenCalled()
    } finally {
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('mints legacy-safe-before-dispatch only after a policy-approved bind failure', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html',
      views: [],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.create'],
      agentMethods: ['plans.create'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({ packageVersion, system: ['fs'], storage: true }))
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] },
      revision: 1,
      state: 'user',
    }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindWorkspace').mockRejectedValue(
      new BackendPluginError('BACKEND_UNAVAILABLE'),
    )
    const provision = vi.spyOn(
      mgr as unknown as { provisionPlansAssets: (workspacePath: string) => Promise<boolean> },
      'provisionPlansAssets',
    ).mockResolvedValue(true)
    try {
      await expect(mgr.executeAgentBackendCallForWorkspace(PLANS_PLUGIN_ID, '/workspace', {
        reqId: 'safe-pre-dispatch', name: 'plans.create', args: { name: 'Safe', overview: '', todos: [] },
      })).resolves.toMatchObject({
        reqId: 'safe-pre-dispatch', ok: false,
        error: { code: 'BACKEND_UNAVAILABLE' },
        recoveryDisposition: 'legacy-safe-before-dispatch',
      })
      await expect(mgr.executeAgentBackendCallForWorkspace(PLANS_PLUGIN_ID, '/workspace', {
        reqId: 'safe-pre-dispatch-after-health-failure',
        name: 'plans.create',
        args: { name: 'Safe Again', overview: '', todos: [] },
      })).resolves.toMatchObject({
        reqId: 'safe-pre-dispatch-after-health-failure', ok: false,
        error: { code: 'BACKEND_UNAVAILABLE' },
        recoveryDisposition: 'legacy-safe-before-dispatch',
      })
      expect(bind).toHaveBeenCalledOnce()
    } finally {
      provision.mockRestore()
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('never mints a recovery disposition once the packaged child call starts', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(), requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }), devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html', views: [],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans', protocolVersion: 1, activation: 'startup',
      approvedMethods: ['plans.create'], agentMethods: ['plans.create'], approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({ packageVersion, system: ['fs'], storage: true }))
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] }, revision: 1, state: 'user',
    }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindWorkspace').mockResolvedValue('headless-plans-1')
    const call = vi.spyOn(PluginBackendHost.prototype, 'call').mockRejectedValue(
      new BackendPluginError('TIMEOUT'),
    )
    const provision = vi.spyOn(
      mgr as unknown as { provisionPlansAssets: (workspacePath: string) => Promise<boolean> },
      'provisionPlansAssets',
    ).mockResolvedValue(true)
    try {
      const response = await mgr.executeAgentBackendCallForWorkspace(PLANS_PLUGIN_ID, '/workspace', {
        reqId: 'post-dispatch', name: 'plans.create', args: { name: 'Post', overview: '', todos: [] },
      }) as unknown as Record<string, unknown>
      expect(response).toMatchObject({ reqId: 'post-dispatch', ok: false, error: { code: 'TIMEOUT' } })
      expect(response).not.toHaveProperty('recoveryDisposition')
      expect(call).toHaveBeenCalledOnce()
    } finally {
      provision.mockRestore()
      call.mockRestore()
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('denies a headless mutation before binding when the current agent policy denies fs', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(), requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }), devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html', views: [],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans', protocolVersion: 1, activation: 'startup',
      approvedMethods: ['plans.create'], agentMethods: ['plans.create'], approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({ packageVersion, system: ['fs'], storage: true }))
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: [] }, revision: 1, state: 'user',
    }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindWorkspace')
    try {
      const response = await mgr.executeAgentBackendCallForWorkspace(PLANS_PLUGIN_ID, '/workspace', {
        reqId: 'policy-denied', name: 'plans.create', args: { name: 'Denied', overview: '', todos: [] },
      }) as unknown as Record<string, unknown>
      expect(response).toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
      expect(response).not.toHaveProperty('recoveryDisposition')
      expect(bind).not.toHaveBeenCalled()
    } finally {
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('returns PLUGIN_STOPPING during revocation and CAPABILITY_DENIED after Grant revocation without binding', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(), requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }), devUrl: '',
      entryFile: '/plugins/navide.plans/frontend/window/index.html', views: [],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans', protocolVersion: 1, activation: 'startup',
      approvedMethods: ['plans.create'], agentMethods: ['plans.create'], approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    let grantActive = true
    mgr.setCapabilityGrantResolver(() => grantActive ? ({ packageVersion, system: ['fs'], storage: true }) : null)
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] }, revision: 1, state: 'user',
    }))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindWorkspace')
    let releaseRevocation!: () => void
    const revocationGate = new Promise<void>((resolve) => { releaseRevocation = resolve })
    const revoke = vi.spyOn(PluginBackendHost.prototype, 'revokePackageVersion').mockImplementation(
      async () => revocationGate,
    )
    try {
      grantActive = false
      const revoked = await mgr.executeAgentBackendCallForWorkspace(PLANS_PLUGIN_ID, '/workspace', {
        reqId: 'grant-revoked', name: 'plans.create', args: { name: 'Revoked', overview: '', todos: [] },
      }) as unknown as Record<string, unknown>
      expect(revoked).toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
      expect(revoked).not.toHaveProperty('recoveryDisposition')
      expect(bind).not.toHaveBeenCalled()
      grantActive = true

      const revocation = mgr.revokePackageVersion(PLANS_PLUGIN_ID, packageVersion)
      await Promise.resolve()
      const stopping = await mgr.executeAgentBackendCallForWorkspace(PLANS_PLUGIN_ID, '/workspace', {
        reqId: 'revocation-in-progress', name: 'plans.create', args: { name: 'Stop', overview: '', todos: [] },
      }) as unknown as Record<string, unknown>
      expect(stopping).toMatchObject({ ok: false, error: { code: 'PLUGIN_STOPPING' } })
      expect(stopping).not.toHaveProperty('recoveryDisposition')
      expect(bind).not.toHaveBeenCalled()

      releaseRevocation()
      await revocation
    } finally {
      revoke.mockRestore()
      bind.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })
})

describe('package-version grant revocation', () => {
  it('disables and destroys only the revoked package version', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.revocable'
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'window',
      contributionKey: `${pluginId}.window`,
      kind: 'custom',
      location: 'window',
      title: 'Revocable',
      entryFile: '/plugins/acme.revocable/index.html',
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: null,
      runtimeBinding: {
        pluginId,
        packageVersion,
        workspaceId: 'workspace-1',
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    const descriptor: PluginLaunchDescriptor = {
      id: pluginId,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
      capabilityContext: context,
    }
    mgr.registerDescriptor(descriptor)
    const revoke = vi
      .spyOn(PluginBackendHost.prototype, 'revokePackageVersion')
      .mockResolvedValue()
    const host = new FakeBrowserWindow()

    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        capabilityContext: context,
      })
      const surface = host.children[0] as FakeViewLike

      await mgr.revokePackageVersion(pluginId, packageVersion)

      expect(revoke).toHaveBeenCalledWith(pluginId, packageVersion)
      expect(surface.visible).toBe(false)
      expect(surface.webContents.isDestroyed()).toBe(true)
      expect((mgr as unknown as { running: Map<string, unknown> }).running.has(handle.instanceId)).toBe(false)
    } finally {
      revoke.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('blocks reopening while a package version is being revoked', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.revocation-gate'
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'main',
      contributionKey: `${pluginId}.main`,
      kind: 'custom',
      location: 'main',
      title: 'Revocation gate',
      entryFile: '/plugins/acme.revocation-gate/index.html',
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: null,
      runtimeBinding: {
        pluginId,
        packageVersion,
        workspaceId: 'workspace-1',
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    const packageDescriptor: PluginLaunchDescriptor = {
      id: pluginId,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
      capabilityContext: context,
    }
    mgr.registerDescriptor(packageDescriptor)
    let finish!: () => void
    const revoke = vi
      .spyOn(PluginBackendHost.prototype, 'revokePackageVersion')
      .mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const host = new FakeBrowserWindow()

    try {
      await mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: '/workspace',
        capabilityContext: context,
      })
      const revocation = mgr.revokePackageVersion(pluginId, packageVersion)
      await Promise.resolve()

      await expect(mgr.openView(packageDescriptor, view, {
        hostWindow: asHost(new FakeBrowserWindow()),
        bounds: 'fill',
        workspacePath: '/workspace',
        capabilityContext: context,
      })).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })

      finish()
      await revocation
      expect(revoke).toHaveBeenCalledWith(pluginId, packageVersion)
    } finally {
      revoke.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('blocks contribution updates while a package version is being revoked', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.contribution-revocation-gate'
    const packageVersion = '1.0.0'
    const contributionKey = `${pluginId}.main`
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'main',
      contributionKey,
      kind: 'custom',
      location: 'main',
      title: 'Revocation update gate',
      entryFile: '/plugins/acme.contribution-revocation-gate/index.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: pluginId,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
      capabilityPolicy: {
        kind: 'manifest-v2',
        system: ['fs'],
        grants: [{ permission: 'system', namespace: 'fs' }],
      },
    }
    mgr.registerDescriptor(descriptor)
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion,
      system: ['fs'],
      storage: true,
    }))
    const host = new FakeBrowserWindow()
    let finish!: () => void
    const revoke = vi
      .spyOn(PluginBackendHost.prototype, 'revokePackageVersion')
      .mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))

    try {
      await expect(mgr.openContribution(asHost(host), contributionKey, {
        bounds: { x: 0, y: 0, width: 300, height: 500 },
        workspacePath: '/workspace',
      })).resolves.toEqual({ ok: true })
      const revocation = mgr.revokePackageVersion(pluginId, packageVersion)

      expect(mgr.updateContribution(
        asHost(host),
        contributionKey,
        { x: 0, y: 0, width: 300, height: 500 },
        true,
      )).toEqual({ ok: false })

      await Promise.resolve()
      finish()
      await revocation
    } finally {
      revoke.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('lifts the stopping gate when a package-version drain rejects', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.failed-drain-gate'
    const packageVersion = '1.0.0'
    const contributionKey = `${pluginId}.main`
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'main',
      contributionKey,
      kind: 'custom',
      location: 'main',
      title: 'Failed drain gate',
      entryFile: '/plugins/acme.failed-drain-gate/index.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: pluginId,
      packageVersion,
      packageDir: process.cwd(),
      requires: [],
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
      capabilityPolicy: {
        kind: 'manifest-v2',
        system: ['fs'],
        grants: [{ permission: 'system', namespace: 'fs' }],
      },
    }
    mgr.registerDescriptor(descriptor)
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion,
      system: ['fs'],
      storage: true,
    }))
    const host = new FakeBrowserWindow()
    const revoke = vi
      .spyOn(PluginBackendHost.prototype, 'revokePackageVersion')
      .mockRejectedValue(new Error('drain failed'))

    try {
      await expect(mgr.revokePackageVersion(pluginId, packageVersion)).rejects.toThrow('drain failed')

      // A failed drain must not leave the contribution permanently refused:
      // the frontend gate covers the teardown sweep, not the child process.
      await expect(mgr.openContribution(asHost(host), contributionKey, {
        bounds: { x: 0, y: 0, width: 300, height: 500 },
        workspacePath: '/workspace',
      })).resolves.toEqual({ ok: true })
    } finally {
      revoke.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })
})

describe('immutable package restart frontend seam', () => {
  it('drains old work behind a plugin barrier and restores native placement from the current descriptor only', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.restartable'
    const oldVersion = '1.0.0'
    const newVersion = '2.0.0'
    const contributionKey = `${pluginId}.main`
    const oldView: PluginViewLaunchDescriptor = {
      id: 'main', contributionKey, kind: 'custom', location: 'main', title: 'Restartable',
      entryFile: '/plugins/acme.restartable/v1/index.html',
    }
    const newView: PluginViewLaunchDescriptor = { ...oldView, entryFile: '/plugins/acme.restartable/v2/index.html' }
    const makeDescriptor = (packageVersion: string, view: PluginViewLaunchDescriptor): PluginLaunchDescriptor => ({
      id: pluginId, packageVersion, packageDir: process.cwd(), requires: [], devUrl: '',
      entryFile: view.entryFile, views: [view], capabilityPolicy: manifestV2CapabilityPolicy({ system: [] }),
    })
    const oldDescriptor = makeDescriptor(oldVersion, oldView)
    const newDescriptor = makeDescriptor(newVersion, newView)
    const oldContext: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion: oldVersion, system: [], storage: true },
      runtimeBinding: {
        pluginId, packageVersion: oldVersion, workspaceId: 'workspace-1', instanceId: null, audience: contributionKey,
      },
    }
    mgr.registerDescriptor(oldDescriptor)
    mgr.setCapabilityGrantResolver((_id, packageVersion) => ({ packageVersion, system: [], storage: true }))
    const revoke = vi.spyOn(PluginBackendHost.prototype, 'revokePackageVersion').mockResolvedValue()
    const host = new FakeBrowserWindow()
    try {
      await mgr.openView(oldDescriptor, oldView, {
        hostWindow: asHost(host), bounds: { x: 5, y: 7, width: 450, height: 320 },
        workspacePath: '/workspace', query: '?workspace_path=%2Fworkspace&file_grant=stale', capabilityContext: oldContext,
      })
      const oldSurface = host.children[0] as FakeViewLike

      const transaction = await mgr.beginPackageRestart(pluginId, oldVersion)
      expect(revoke).toHaveBeenCalledWith(pluginId, oldVersion)
      expect(oldSurface.webContents.isDestroyed()).toBe(true)

      mgr.registerDescriptor(newDescriptor)
      mgr.setPluginStorageSnapshotSelection(pluginId, {
        activeVersion: newVersion,
        previousVersion: oldVersion,
      })
      await expect(mgr.openView(newDescriptor, newView, {
        hostWindow: asHost(new FakeBrowserWindow()), bounds: 'fill', workspacePath: '/workspace',
        capabilityContext: {
          ...oldContext,
          userGrant: { packageVersion: newVersion, system: [], storage: true },
          runtimeBinding: { ...oldContext.runtimeBinding!, packageVersion: newVersion },
        },
      })).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })

      const restoring = mgr.restorePackageRestart(transaction, newVersion)
      const restoredSurface = host.children[0] as FakeViewLike
      expect(restoredSurface.webContents.loads).toEqual([
        `${newView.entryFile}?workspace_path=%2Fworkspace`,
      ])
      ipcListeners.get('plugin:ready')?.({ sender: { id: restoredSurface.webContents.id } })
      await expect(restoring).resolves.toEqual({ restoredInstances: 1, skippedDestroyedHostWindows: 0 })
      mgr.completePackageRestart(transaction)

      const restored = [...(mgr as unknown as { running: Map<string, {
        capabilityContext: HostCapabilityContext | null
      }> }).running.values()][0]
      expect(restored?.capabilityContext?.runtimeBinding?.packageVersion).toBe(newVersion)
      expect(restored?.capabilityContext?.storageSnapshots).toEqual(new Map([
        ['candidate', newVersion], ['active', newVersion], ['previous', oldVersion],
      ]))
    } finally {
      revoke.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('preflights hidden candidate views without a catalog entry or capability binding', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor: PluginLaunchDescriptor = {
      id: 'acme.candidate', packageVersion: '2.0.0', packageDir: process.cwd(), requires: [], devUrl: '',
      entryFile: '/plugins/acme.candidate/index.html',
      views: [{
        id: 'main', contributionKey: 'acme.candidate.main', kind: 'custom', location: 'main', title: 'Candidate',
        entryFile: '/plugins/acme.candidate/index.html',
      }],
    }
    const host = new FakeBrowserWindow()
    const onFailure = vi.fn()
    mgr.setActivationFailureHandler(onFailure)

    const preflight = mgr.preflightPackageFrontend(descriptor, asHost(host))
    const surface = host.children[0] as FakeViewLike
    const running = [...(mgr as unknown as { running: Map<string, {
      capabilityContext: HostCapabilityContext | null
    }> }).running.values()][0]
    expect(running?.capabilityContext).toBeNull()
    expect(mgr.getDescriptor(descriptor.id)).toBeUndefined()
    ipcListeners.get('plugin:ready')?.({ sender: { id: surface.webContents.id } })

    await expect(preflight).resolves.toBeUndefined()
    expect(host.children).toHaveLength(0)
    expect(mgr.listContributionCatalog()).toEqual([])
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('reports a destroyed Host window explicitly instead of treating the placement as restored', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.destroyed-host'
    const oldVersion = '1.0.0'
    const newVersion = '2.0.0'
    const view: PluginViewLaunchDescriptor = {
      id: 'main', contributionKey: `${pluginId}.main`, kind: 'custom', location: 'main', title: 'Destroyed host',
      entryFile: '/plugins/acme.destroyed-host/index.html',
    }
    const descriptor = (packageVersion: string): PluginLaunchDescriptor => ({
      id: pluginId, packageVersion, packageDir: process.cwd(), requires: [], devUrl: '', entryFile: view.entryFile,
      views: [view], capabilityPolicy: manifestV2CapabilityPolicy({ system: [] }),
    })
    const oldDescriptor = descriptor(oldVersion)
    const host = new FakeBrowserWindow()
    mgr.registerDescriptor(oldDescriptor)
    mgr.setCapabilityGrantResolver((_id, packageVersion) => ({ packageVersion, system: [], storage: true }))
    const oldContext: HostCapabilityContext = {
      publisherEligible: false, userGrant: { packageVersion: oldVersion, system: [], storage: true },
      runtimeBinding: { pluginId, packageVersion: oldVersion, workspaceId: 'workspace-1', instanceId: null, audience: view.contributionKey },
    }
    const revoke = vi.spyOn(PluginBackendHost.prototype, 'revokePackageVersion').mockResolvedValue()
    try {
      await mgr.openView(oldDescriptor, view, {
        hostWindow: asHost(host), bounds: 'fill', workspacePath: '/workspace', capabilityContext: oldContext,
      })
      const transaction = await mgr.beginPackageRestart(pluginId, oldVersion)
      host.destroyed = true
      mgr.registerDescriptor(descriptor(newVersion))
      mgr.setPluginStorageSnapshotSelection(pluginId, { activeVersion: newVersion, previousVersion: oldVersion })

      await expect(mgr.restorePackageRestart(transaction, newVersion)).resolves.toEqual({
        restoredInstances: 0, skippedDestroyedHostWindows: 1,
      })
      mgr.completePackageRestart(transaction)
    } finally {
      revoke.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('completes a restart with an in-window guest open, leaving its remount to the renderer', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.pending-guest'
    const oldVersion = '1.0.0'
    const newVersion = '2.0.0'
    const view: PluginViewLaunchDescriptor = {
      id: 'left', contributionKey: `${pluginId}.left`, kind: 'custom', location: 'left', title: 'Guest',
      entryFile: '/plugins/acme.pending-guest/index.html',
    }
    const descriptor = (packageVersion: string): PluginLaunchDescriptor => ({
      id: pluginId, packageVersion, packageDir: process.cwd(), requires: [], devUrl: '', entryFile: view.entryFile,
      views: [view], capabilityPolicy: manifestV2CapabilityPolicy({ system: [] }),
    })
    const host = new FakeBrowserWindow()
    mgr.registerDescriptor(descriptor(oldVersion))
    mgr.setCapabilityGrantResolver((_id, packageVersion) => ({ packageVersion, system: [], storage: true }))
    const revoke = vi.spyOn(PluginBackendHost.prototype, 'revokePackageVersion').mockResolvedValue()
    try {
      await expect(mgr.prepareGuestContribution(asHost(host), view.contributionKey, {
        workspacePath: '/workspace', query: '?workspace_path=%2Fworkspace',
      })).resolves.toMatchObject({ ok: true })
      const transaction = await mgr.beginPackageRestart(pluginId, oldVersion)
      mgr.registerDescriptor(descriptor(newVersion))
      mgr.setPluginStorageSnapshotSelection(pluginId, { activeVersion: newVersion, previousVersion: oldVersion })

      // L2: the in-window guest is its renderer's to remount: the restart
      // completes, counts it, and the renderer prepares the new version.
      await expect(mgr.restorePackageRestart(transaction, newVersion)).resolves.toEqual({
        restoredInstances: 0,
        skippedDestroyedHostWindows: 0,
        rendererRemounts: 1,
      })
      expect(() => mgr.completePackageRestart(transaction)).not.toThrow()
      await expect(mgr.prepareGuestContribution(asHost(host), view.contributionKey, {
        workspacePath: '/workspace', query: '?workspace_path=%2Fworkspace',
      })).resolves.toMatchObject({ ok: true })
    } finally {
      revoke.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('closes drained placements when the selected package has no frontend', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.to-backend-only'
    const oldVersion = '1.0.1'
    const view: PluginViewLaunchDescriptor = {
      id: 'main', contributionKey: `${pluginId}.main`, kind: 'custom', location: 'window', title: 'Window',
      entryFile: '/plugins/acme.to-backend-only/index.html',
    }
    const oldDescriptor: PluginLaunchDescriptor = {
      id: pluginId, packageVersion: oldVersion, packageDir: process.cwd(), requires: [], devUrl: '',
      entryFile: view.entryFile, views: [view], capabilityPolicy: manifestV2CapabilityPolicy({ system: [] }),
    }
    const host = new FakeBrowserWindow()
    const close = vi.fn()
    Object.assign(host, { close })
    mgr.registerDescriptor(oldDescriptor)
    mgr.setCapabilityGrantResolver((_id, packageVersion) => ({ packageVersion, system: [], storage: true }))
    const revoke = vi.spyOn(PluginBackendHost.prototype, 'revokePackageVersion').mockResolvedValue()
    try {
      await mgr.openView(oldDescriptor, view, {
        hostWindow: asHost(host), bounds: 'fill', workspacePath: '/workspace', closeHostOnHide: true,
        capabilityContext: {
          publisherEligible: false, userGrant: { packageVersion: oldVersion, system: [], storage: true },
          runtimeBinding: { pluginId, packageVersion: oldVersion, workspaceId: 'workspace-1', instanceId: null, audience: view.contributionKey },
        },
      })
      const transaction = await mgr.beginPackageRestart(pluginId, oldVersion)
      mgr.registerInstalledPackage({ id: pluginId, requires: [], packageVersion: '1.0.0' }, undefined, {}, process.cwd())
      expect(() => mgr.completePackageRestart(transaction)).toThrow(/required placements/)

      mgr.completePackageRestartWithoutFrontend(transaction)
      expect(close).toHaveBeenCalledTimes(1)
      expect((mgr as unknown as { restartingPluginIds: Set<string> }).restartingPluginIds.has(pluginId)).toBe(false)
      expect(() => mgr.completePackageRestart(transaction)).toThrow(/not active/)
    } finally {
      revoke.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('refuses to drop placements while the selected package still has a frontend', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.still-frontend'
    const view: PluginViewLaunchDescriptor = {
      id: 'main', contributionKey: `${pluginId}.main`, kind: 'custom', location: 'main', title: 'Main',
      entryFile: '/plugins/acme.still-frontend/index.html',
    }
    mgr.registerDescriptor({
      id: pluginId, packageVersion: '1.0.0', packageDir: process.cwd(), requires: [], devUrl: '',
      entryFile: view.entryFile, views: [view], capabilityPolicy: manifestV2CapabilityPolicy({ system: [] }),
    })
    const revoke = vi.spyOn(PluginBackendHost.prototype, 'revokePackageVersion').mockResolvedValue()
    try {
      const transaction = await mgr.beginPackageRestart(pluginId, '1.0.0')
      expect(() => mgr.completePackageRestartWithoutFrontend(transaction)).toThrow(/still has a frontend/)
      mgr.cancelPackageRestart(transaction)
    } finally {
      revoke.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })
})

describe('registerDescriptor reserved-id guard', () => {
  it('refuses a third-party plugin claiming a reserved built-in id', () => {
    const mgr = new FrontendPluginManager()
    expect(() => mgr.registerDescriptor(descriptor('navide.mini-ide'))).toThrow(/reserved/)
    expect(() => mgr.registerDescriptor(descriptor(HOST_EVENT_SOURCE_PLUGIN_ID))).toThrow(
      /not a plugin id/
    )
    expect(() =>
      mgr.registerDescriptor(descriptor(HOST_EVENT_SOURCE_PLUGIN_ID), { builtin: true })
    ).toThrow(/not a plugin id/)
    expect(mgr.getDescriptor('navide.mini-ide')).toBeUndefined()
  })

  it('allows the host itself to register a built-in id', () => {
    const mgr = new FrontendPluginManager()
    expect(() =>
      mgr.registerDescriptor(descriptor('navide.mini-ide'), { builtin: true })
    ).not.toThrow()
    expect(mgr.getDescriptor('navide.mini-ide')?.id).toBe('navide.mini-ide')
  })

  it('allows an officially-verified install to register a reserved id', () => {
    const mgr = new FrontendPluginManager()
    expect(() =>
      mgr.registerDescriptor(descriptor('navide.mini-ide'), { official: true })
    ).not.toThrow()
    expect(mgr.getDescriptor('navide.mini-ide')?.id).toBe('navide.mini-ide')
  })

  it('keeps a bundled frontend inactive until an official backend-only install is removed', () => {
    const mgr = new FrontendPluginManager()
    const bundled = devPlansPluginDescriptor()
    mgr.registerInstalledPackage(
      { id: PLANS_PLUGIN_ID, requires: [] },
      undefined,
      { official: true }
    )

    mgr.registerBuiltin(bundled)

    expect(mgr.getDescriptor(PLANS_PLUGIN_ID)).toBeUndefined()
    expect(mgr.listInstalledPackages()).toEqual([{ id: PLANS_PLUGIN_ID, requires: [] }])

    mgr.removeInstalledPlugin(PLANS_PLUGIN_ID)

    expect(mgr.getDescriptor(PLANS_PLUGIN_ID)).toBe(bundled)
    expect(mgr.listInstalledPackages()).toEqual([])
  })

  it('can remove an installed package without restoring its remembered builtin', () => {
    const mgr = new FrontendPluginManager()
    const bundled = devPlansPluginDescriptor()
    mgr.registerBuiltin(bundled)
    mgr.registerInstalledPackage(
      { id: PLANS_PLUGIN_ID, requires: [], provenance: 'official-registry' },
      undefined,
      { official: true },
    )

    mgr.removeInstalledPlugin(PLANS_PLUGIN_ID, { restoreBuiltin: false })

    expect(mgr.getDescriptor(PLANS_PLUGIN_ID)).toBeUndefined()
    expect(mgr.listInstalledPackages()).toEqual([])
  })

  it('registers an ordinary third-party descriptor', () => {
    const mgr = new FrontendPluginManager()
    mgr.registerDescriptor(descriptor('acme.demo'))
    expect(mgr.getDescriptor('acme.demo')?.id).toBe('acme.demo')
  })

  it('lists validated Manifest v2 view contributions for Host discovery', () => {
    const mgr = new FrontendPluginManager()
    mgr.registerDescriptor({
      ...descriptor('acme.files'),
      views: [
        {
          id: 'left',
          contributionKey: 'acme.files.left',
          kind: 'custom',
          location: 'left',
          title: 'Files',
          entryFile: '/plugins/acme.files/frontend/left/index.html',
        },
        {
          id: 'window',
          contributionKey: 'acme.files.window',
          kind: 'custom',
          location: 'window',
          title: 'Files window',
          entryFile: '/plugins/acme.files/frontend/window/index.html',
        },
      ],
    })
    expect(mgr.listViewContributions()).toEqual([
      expect.objectContaining({
        contributionKey: 'acme.files.left',
        location: 'left',
      }),
      expect.objectContaining({
        contributionKey: 'acme.files.window',
        location: 'window',
      }),
    ])
    expect(mgr.listContributionCatalog()).toEqual([
      {
        pluginId: 'acme.files',
        packageVersion: null,
        contributionKey: 'acme.files.left',
        title: 'Files',
        iconFile: null,
        kind: 'custom',
        location: 'left',
        manifestOrder: 0,
      },
      {
        pluginId: 'acme.files',
        packageVersion: null,
        contributionKey: 'acme.files.window',
        title: 'Files window',
        iconFile: null,
        kind: 'custom',
        location: 'window',
        manifestOrder: 1,
      },
    ])
  })

  it('derives an exact per-instance context when a catalog contribution opens', async () => {
    const mgr = new FrontendPluginManager()
    const packageDescriptor: PluginLaunchDescriptor = {
      ...descriptor('acme.files'),
      packageVersion: '1.2.3',
      capabilityPolicy: {
        kind: 'manifest-v2',
        system: ['fs'],
        grants: [{ permission: 'system', namespace: 'fs' }],
      },
      views: [{
        id: 'left',
        contributionKey: 'acme.files.left',
        kind: 'custom',
        location: 'left',
        title: 'Files',
        entryFile: '/plugins/acme.files/frontend/left/index.html',
      }],
    }
    mgr.registerInstalledPackage(
      { id: 'acme.files', requires: ['fs'], provenance: 'official-registry' },
      packageDescriptor,
    )
    const resolveGrant = vi.fn(() => ({
      packageVersion: '1.2.3',
      system: ['fs'] as const,
      storage: true,
    }))
    mgr.setCapabilityGrantResolver(resolveGrant)
    const host = new FakeBrowserWindow()

    await expect(mgr.openContribution(asHost(host), 'acme.files.left', {
      bounds: { x: 0, y: 0, width: 300, height: 500 },
      workspacePath: '/workspace',
    })).resolves.toEqual({ ok: true })

    expect(resolveGrant).toHaveBeenCalledWith('acme.files', '1.2.3')
    const running = [...(mgr as unknown as {
      running: Map<string, { capabilityContext: HostCapabilityContext | null }>
    }).running.values()]
    expect(running[0].capabilityContext).toMatchObject({
      publisherEligible: false,
      userGrant: { packageVersion: '1.2.3', system: ['fs'], storage: true },
      runtimeBinding: {
        pluginId: 'acme.files',
        packageVersion: '1.2.3',
        instanceId: expect.any(String),
        workspaceId: expect.any(String),
        audience: 'acme.files.left',
      },
      storageSnapshotTier: 'active',
    })
  })

  it('binds the lifecycle-selected previous Mini-IDE storage snapshot', async () => {
    const mgr = new FrontendPluginManager()
    const packageDescriptor: PluginLaunchDescriptor = {
      id: MINI_IDE_PLUGIN_ID,
      packageVersion: '2.0.0',
      requires: ['ui'],
      capabilityPolicy: { kind: 'manifest-v2', system: ['ui'], grants: [] },
      devUrl: '',
      entryFile: '/plugins/mini-ide/index.html',
      views: [{
        id: 'left',
        contributionKey: 'navide.mini-ide.left',
        kind: 'custom',
        location: 'left',
        title: 'Mini IDE',
        entryFile: '/plugins/mini-ide/index.html',
      }],
    }
    mgr.registerDescriptor(packageDescriptor, { builtin: true })
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: '2.0.0',
      system: ['ui'],
      storage: true,
    }))
    mgr.setMiniIdeStorageSnapshotContext('2.0.0', '1.9.0')

    await expect(mgr.openContribution(asHost(new FakeBrowserWindow()), 'navide.mini-ide.left', {
      bounds: 'fill',
      workspacePath: '/workspace',
    })).resolves.toEqual({ ok: true })

    const running = [...(mgr as unknown as {
      running: Map<string, { capabilityContext: HostCapabilityContext | null }>
    }).running.values()]
    expect([...running[0].capabilityContext!.storageSnapshots!.entries()]).toEqual([
      ['candidate', '2.0.0'],
      ['active', '2.0.0'],
      ['previous', '1.9.0'],
    ])
  })

  it('derives the same workspace identity across manager instances', () => {
    const first = new FrontendPluginManager().gitCapabilityContext(
      '1.0.0',
      '/workspace/project/../project',
      'git-left',
    )
    const second = new FrontendPluginManager().gitCapabilityContext(
      '1.0.0',
      '/workspace/project',
      'git-window',
    )

    expect(first.runtimeBinding?.workspaceId).toBe(second.runtimeBinding?.workspaceId)
    expect(first.runtimeBinding?.workspaceId).toMatch(/^[a-f0-9]{64}$/)
  })

  it('fails closed when a catalog contribution lacks an exact approved grant', async () => {
    const mgr = new FrontendPluginManager()
    const packageDescriptor: PluginLaunchDescriptor = {
      ...descriptor('acme.files'),
      packageVersion: '1.2.3',
      capabilityPolicy: { kind: 'manifest-v2', system: ['fs'], grants: [] },
      views: [{
        id: 'left',
        contributionKey: 'acme.files.left',
        kind: 'custom',
        location: 'left',
        title: 'Files',
        entryFile: '/plugins/acme.files/frontend/left/index.html',
      }],
    }
    mgr.registerInstalledPackage(
      { id: 'acme.files', requires: ['fs'], provenance: 'official-registry' },
      packageDescriptor,
    )
    mgr.setCapabilityGrantResolver(() => null)

    await expect(mgr.openContribution(asHost(new FakeBrowserWindow()), 'acme.files.left', {
      bounds: { x: 0, y: 0, width: 300, height: 500 },
      workspacePath: '/workspace',
    })).resolves.toEqual({ ok: false, error: 'package-version capability grant is missing' })
  })

  it('reports an early selected-v2 activation failure exactly once', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor: PluginLaunchDescriptor = {
      id: 'navide.git',
      packageVersion: '1.0.0',
      requires: ['fs'],
      capabilityPolicy: { kind: 'manifest-v2', system: ['fs'], grants: [] },
      devUrl: '',
      entryFile: '/plugins/navide.git/frontend/left/index.html',
      views: [{
        id: 'left',
        contributionKey: 'navide.git.left',
        kind: 'custom',
        location: 'left',
        title: 'Git',
        entryFile: '/plugins/navide.git/frontend/left/index.html',
      }],
    }
    mgr.registerInstalledPackage(
      { id: 'navide.git', requires: ['fs'], provenance: 'official-registry' },
      descriptor,
      { official: true },
    )
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: '1.0.0', system: ['fs'], storage: true,
    }))
    const onFailure = vi.fn()
    mgr.setActivationFailureHandler(onFailure)
    const host = new FakeBrowserWindow()
    await mgr.openContribution(asHost(host), 'navide.git.left', {
      bounds: { x: 0, y: 0, width: 300, height: 500 },
      workspacePath: '/workspace',
    })
    const webContents = (host.children[0] as FakeViewLike).webContents as unknown as {
      emit(event: string, ...args: unknown[]): void
    }

    webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'file:///plugin', true)
    webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'file:///plugin', true)

    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(onFailure).toHaveBeenCalledWith({
      pluginId: 'navide.git',
      packageVersion: '1.0.0',
      reason: 'entry load failed: NAME_NOT_RESOLVED (-105)',
    })
  })

  /** Open the granted Manifest v2 Git left view and hand back its guest. */
  async function openGitLeftForFailure(): Promise<{
    mgr: FrontendPluginManager
    host: FakeBrowserWindow
    webContents: { emit(event: string, ...args: unknown[]): void }
    onFailure: ReturnType<typeof vi.fn>
  }> {
    const mgr = new FrontendPluginManager()
    const packageDescriptor: PluginLaunchDescriptor = {
      ...descriptor('navide.git'),
      packageVersion: '1.0.0',
      capabilityPolicy: { kind: 'manifest-v2', system: ['fs'], grants: [] },
      views: [{
        id: 'left',
        contributionKey: 'navide.git.left',
        kind: 'custom',
        location: 'left',
        title: 'Git',
        entryFile: '/plugins/navide.git/frontend/left/index.html',
      }],
    }
    mgr.registerInstalledPackage(
      { id: 'navide.git', requires: ['fs'], provenance: 'official-registry' },
      packageDescriptor,
      { official: true },
    )
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: '1.0.0', system: ['fs'], storage: true,
    }))
    const onFailure = vi.fn()
    mgr.setActivationFailureHandler(onFailure)
    const host = new FakeBrowserWindow()
    await mgr.openContribution(asHost(host), 'navide.git.left', {
      bounds: { x: 0, y: 0, width: 300, height: 500 },
      workspacePath: '/workspace',
    })
    return {
      mgr,
      host,
      webContents: (host.children[0] as FakeViewLike).webContents as unknown as {
        emit(event: string, ...args: unknown[]): void
      },
      onFailure,
    }
  }

  // `destroyed` alone cannot tell a fault from an ordinary teardown, and the
  // load phase is not a usable proxy for it: a region re-preparing for another
  // workspace tears its guest down seconds *after* the entry loaded. So the
  // Host marks every deliberate teardown, and only an unmarked one is a fault.

  it('blames the plugin for a guest that dies on its own before its entry loaded', async () => {
    const { webContents, onFailure } = await openGitLeftForFailure()

    webContents.emit('destroyed')

    expect(onFailure).toHaveBeenCalledWith({
      pluginId: 'navide.git',
      packageVersion: '1.0.0',
      reason: 'plugin renderer exited before readiness',
    })
  })

  it('blames the plugin for a guest that dies on its own after its entry loaded', async () => {
    const { webContents, onFailure } = await openGitLeftForFailure()

    webContents.emit('did-finish-load')
    webContents.emit('destroyed')

    expect(onFailure).toHaveBeenCalledWith({
      pluginId: 'navide.git',
      packageVersion: '1.0.0',
      reason: 'plugin renderer exited before readiness',
    })
  })

  it('does not blame the plugin when the Host closed the region itself', async () => {
    const { mgr, host, webContents, onFailure } = await openGitLeftForFailure()
    webContents.emit('did-finish-load')

    // What a renderer-side slot re-preparing for another workspace does first.
    // A Host-driven teardown forgets the record before the guest dies, so
    // `destroyed` finds nothing to blame — no flag needed.
    mgr.closeContribution(asHost(host), 'navide.git.left')
    webContents.emit('destroyed')

    expect(onFailure).not.toHaveBeenCalled()
  })

  it('does not blame the plugin when the host document navigates away', async () => {
    const { host, webContents, onFailure } = await openGitLeftForFailure()
    webContents.emit('did-finish-load')

    // A host window reload runs no renderer unmount hook, so this listener is
    // the only thing that marks the guests it takes down as deliberate.
    host.webContents.emit('did-start-navigation', {}, 'file:///index.html', false, true)
    webContents.emit('destroyed')

    expect(onFailure).not.toHaveBeenCalled()
  })

  it('still blames the plugin for an in-page navigation of the host', async () => {
    const { host, webContents, onFailure } = await openGitLeftForFailure()
    webContents.emit('did-finish-load')

    // A hash/history change does not unload the document, so it must not
    // excuse a guest that dies afterwards.
    host.webContents.emit('did-start-navigation', {}, 'file:///index.html#git', true, true)
    webContents.emit('destroyed')

    expect(onFailure).toHaveBeenCalledWith({
      pluginId: 'navide.git',
      packageVersion: '1.0.0',
      reason: 'plugin renderer exited before readiness',
    })
  })

  it('starts the v2 readiness timeout only after the entry finishes loading', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDescriptor: PluginLaunchDescriptor = {
        ...descriptor('navide.git'),
        packageVersion: '1.0.0',
        capabilityPolicy: { kind: 'manifest-v2', system: ['fs'], grants: [] },
        views: [{
          id: 'left',
          contributionKey: 'navide.git.left',
          kind: 'custom',
          location: 'left',
          title: 'Git',
          entryFile: '/plugins/navide.git/frontend/left/index.html',
        }],
      }
      mgr.registerInstalledPackage(
        { id: 'navide.git', requires: ['fs'], provenance: 'official-registry' },
        packageDescriptor,
        { official: true },
      )
      mgr.setCapabilityGrantResolver(() => ({
        packageVersion: '1.0.0', system: ['fs'], storage: true,
      }))
      const onFailure = vi.fn()
      mgr.setActivationFailureHandler(onFailure)
      const host = new FakeBrowserWindow()
      await mgr.openContribution(asHost(host), 'navide.git.left', {
        bounds: { x: 0, y: 0, width: 300, height: 500 },
        workspacePath: '/workspace',
      })
      const webContents = (host.children[0] as FakeViewLike).webContents as unknown as {
        emit(event: string, ...args: unknown[]): void
        reloads: number
      }

      await vi.advanceTimersByTimeAsync(10_000)
      expect(onFailure).not.toHaveBeenCalled()

      // A missed budget buys one reload before it is allowed to cost the
      // session its v2 activation.
      webContents.emit('did-finish-load')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(webContents.reloads).toBe(1)
      expect(onFailure).not.toHaveBeenCalled()

      webContents.emit('did-finish-load')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(webContents.reloads).toBe(1)
      expect(onFailure).toHaveBeenCalledWith({
        pluginId: 'navide.git',
        packageVersion: '1.0.0',
        reason: 'plugin readiness handshake timed out',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a guest that reports ready after its reload keep the activation', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDescriptor: PluginLaunchDescriptor = {
        ...descriptor('navide.git'),
        packageVersion: '1.0.0',
        capabilityPolicy: { kind: 'manifest-v2', system: ['fs'], grants: [] },
        views: [{
          id: 'left',
          contributionKey: 'navide.git.left',
          kind: 'custom',
          location: 'left',
          title: 'Git',
          entryFile: '/plugins/navide.git/frontend/left/index.html',
        }],
      }
      mgr.registerInstalledPackage(
        { id: 'navide.git', requires: ['fs'], provenance: 'official-registry' },
        packageDescriptor,
        { official: true },
      )
      mgr.setCapabilityGrantResolver(() => ({
        packageVersion: '1.0.0', system: ['fs'], storage: true,
      }))
      const onFailure = vi.fn()
      mgr.setActivationFailureHandler(onFailure)
      const host = new FakeBrowserWindow()
      await mgr.openContribution(asHost(host), 'navide.git.left', {
        bounds: { x: 0, y: 0, width: 300, height: 500 },
        workspacePath: '/workspace',
      })
      const webContents = (host.children[0] as FakeViewLike).webContents as unknown as {
        emit(event: string, ...args: unknown[]): void
        reloads: number
        id: number
      }

      webContents.emit('did-finish-load')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(webContents.reloads).toBe(1)

      webContents.emit('did-finish-load')
      ipcListeners.get('plugin:ready')?.({ sender: { id: webContents.id } })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(onFailure).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a timeout when readiness arrives before did-finish-load', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDescriptor: PluginLaunchDescriptor = {
        ...descriptor('navide.git'),
        packageVersion: '1.0.0',
        capabilityPolicy: { kind: 'manifest-v2', system: ['fs'], grants: [] },
        views: [{
          id: 'left',
          contributionKey: 'navide.git.left',
          kind: 'custom',
          location: 'left',
          title: 'Git',
          entryFile: '/plugins/navide.git/frontend/left/index.html',
        }],
      }
      mgr.registerInstalledPackage(
        { id: 'navide.git', requires: ['fs'], provenance: 'official-registry' },
        packageDescriptor,
        { official: true },
      )
      mgr.setCapabilityGrantResolver(() => ({
        packageVersion: '1.0.0', system: ['fs'], storage: true,
      }))
      const onFailure = vi.fn()
      mgr.setActivationFailureHandler(onFailure)
      const host = new FakeBrowserWindow()
      await mgr.openContribution(asHost(host), 'navide.git.left', {
        bounds: { x: 0, y: 0, width: 300, height: 500 },
        workspacePath: '/workspace',
      })
      const webContents = (host.children[0] as FakeViewLike).webContents as unknown as {
        id: number
        emit(event: string, ...args: unknown[]): void
      }

      ipcListeners.get('plugin:ready')?.({ sender: { id: webContents.id } })
      webContents.emit('did-finish-load')
      await vi.advanceTimersByTimeAsync(10_000)

      expect(onFailure).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('durable plugin selector startup wiring', () => {
  function writeTrustedActivePackage(root: string, pluginId: string): {
    trust: InstalledRegistryTrustContext
    selection: { packageVersion: string; target: string; artifactDigest: string }
  } {
    const version = '1.0.0'
    const target = 'universal'
    const packageDir = join(root, pluginId, version, target, 'package')
    mkdirSync(join(packageDir, 'frontend'), { recursive: true })
    const manifest = JSON.stringify({
      schemaVersion: 2,
      apiVersion: '^1.0.0',
      id: pluginId,
      name: 'Recovery',
      version,
      publisher: 'acme',
      permissions: {},
      marketplace: { description: 'Recovery test plugin', license: 'MIT' },
      contributes: {
        views: [{
          id: 'main',
          kind: 'custom',
          location: 'main',
          title: 'Recovery',
          entry: 'frontend/index.html',
        }],
      },
    })
    const archive = new Uint8Array(makeZip([
      { name: 'manifest.json', data: manifest },
      { name: 'frontend/index.html', data: '<!doctype html>' },
    ]))
    writeFileSync(join(packageDir, 'manifest.json'), manifest)
    writeFileSync(join(packageDir, 'frontend', 'index.html'), '<!doctype html>')
    writeFileSync(join(packageDir, REGISTRY_ARTIFACT_NAME), archive)

    const rootKey = generateKeyPairSync('ed25519')
    const signerKey = generateKeyPairSync('ed25519')
    const rootPem = rootKey.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const signerPem = signerKey.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const signed = (value: unknown, key = signerKey.privateKey): string =>
      edSign(null, Buffer.from(canonicalTrustJson(value)), key).toString('base64')
    const artifactDigest = sha256Hex(archive)
    const envelope: RegistryPackageEnvelope = {
      schemaVersion: 1,
      artifactDigest,
      packageId: pluginId,
      version,
      target,
      publisherId: 'acme',
      keyId: 'selector-test',
      signedAt: '2026-08-16T11:00:00.000Z',
    }
    const metadata: RegistryTrustMetadata = {
      schemaVersion: 1,
      registryProfile: 'official',
      rootFingerprint: `sha256:${'1'.repeat(64)}`,
      generatedAt: '2026-08-16T10:00:00.000Z',
      expiresAt: '2026-08-17T10:00:00.000Z',
      signers: [{
        keyId: 'selector-test',
        publicKey: signerPem,
        status: 'active',
        notBefore: '2026-08-01T00:00:00.000Z',
        notAfter: '2026-09-01T00:00:00.000Z',
      }],
      blockedPublishers: [],
      blockedPackages: [],
    }
    writeFileSync(
      join(packageDir, REGISTRY_RECEIPT_NAME),
      JSON.stringify(registryReceiptFromEvidence({
        packageId: pluginId,
        version,
        publisherId: 'acme',
        target,
        artifactDigest,
        envelope,
        envelopeSignature: signed(envelope),
      })),
    )
    return {
      trust: {
        pinnedRootKey: rootPem,
        snapshot: {
          schemaVersion: 1,
          metadata,
          metadataSignature: signed(metadata, rootKey.privateKey),
        },
        expectedTarget: target,
        now: new Date('2026-08-16T12:00:00.000Z'),
      },
      selection: { packageVersion: version, target, artifactDigest },
    }
  }

  it('projects the selected active and previous package versions into generic storage', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-selector-projection-'))
    try {
      const selector = new PluginActivationSelector(root)
      selector.stageCandidate('acme.storage', {
        packageVersion: '1.0.0',
        target: 'universal',
        artifactDigest: '11'.repeat(32),
      })
      selector.activateCandidate('acme.storage')
      selector.stageCandidate('acme.storage', {
        packageVersion: '2.0.0',
        target: 'universal',
        artifactDigest: '22'.repeat(32),
      })
      selector.activateCandidate('acme.storage')

      const mgr = new FrontendPluginManager()
      mgr.projectPluginStorageSnapshotSelections(root)

      const selections = (mgr as unknown as {
        pluginStorageSnapshotSelections: Map<string, { activeVersion: string; previousVersion?: string }>
      }).pluginStorageSnapshotSelections
      expect(selections.get('acme.storage')).toEqual({
        activeVersion: '2.0.0',
        previousVersion: '1.0.0',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-verifies the exact recovered active package before scanning after a cold interrupted activation', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-selector-cold-recovery-'))
    try {
      const pluginId = 'acme.recovery'
      const { trust, selection } = writeTrustedActivePackage(root, pluginId)
      const selector = new PluginActivationSelector(root)
      selector.stageCandidate(pluginId, selection)
      selector.activateCandidate(pluginId)
      selector.stageCandidate(pluginId, {
        packageVersion: '2.0.0', target: 'universal', artifactDigest: '22'.repeat(32),
      })
      selector.beginActivation(pluginId)

      const result = new FrontendPluginManager().loadInstalledPlugins(root, {
        provenance: 'official-registry', trust,
      })

      expect(result.loaded).toEqual([pluginId])
      expect(result.errors).toEqual([])
      expect(new PluginActivationSelector(root).read(pluginId)).toMatchObject({
        active: selection,
        candidate: { packageVersion: '2.0.0' },
      })
      expect(new PluginActivationSelector(root).read(pluginId)?.activation).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not recover or register when the exact retained rollback package no longer verifies', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-selector-recovery-trust-failure-'))
    try {
      const pluginId = 'acme.recovery'
      const { trust, selection } = writeTrustedActivePackage(root, pluginId)
      const selector = new PluginActivationSelector(root)
      selector.stageCandidate(pluginId, selection)
      selector.activateCandidate(pluginId)
      const candidate = {
        packageVersion: '2.0.0', target: 'universal', artifactDigest: '22'.repeat(32),
      }
      selector.stageCandidate(pluginId, candidate)
      selector.beginActivation(pluginId)
      selector.activateCandidate(pluginId)
      writeFileSync(
        join(root, pluginId, selection.packageVersion, selection.target, 'package', REGISTRY_ARTIFACT_NAME),
        'tampered retained artifact',
      )

      const result = new FrontendPluginManager().loadInstalledPlugins(root, {
        provenance: 'official-registry', trust,
      })

      expect(result.loaded).toEqual([])
      expect(result.activationCatalog).toEqual([])
      expect(result.errors.join(' ')).toMatch(/interrupted lifecycle recovery blocked/i)
      expect(new PluginActivationSelector(root).read(pluginId)).toMatchObject({
        active: candidate,
        previous: selection,
        activation: { kind: 'candidate', phase: 'promoted' },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an official package when its verified digest differs from the durable active selector', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-selector-digest-'))
    try {
      const pluginId = 'acme.digest'
      const version = '1.0.0'
      const packageDir = join(root, pluginId, version, 'universal', 'package')
      mkdirSync(join(packageDir, 'frontend'), { recursive: true })
      const manifest = JSON.stringify({
        schemaVersion: 2,
        apiVersion: '^1.0.0',
        id: pluginId,
        name: 'Digest',
        version,
        publisher: 'acme',
        permissions: {},
        marketplace: { description: 'Digest test plugin', license: 'MIT' },
        contributes: {
          views: [{
            id: 'main',
            kind: 'custom',
            location: 'main',
            title: 'Digest',
            entry: 'frontend/index.html',
          }],
        },
      })
      const archive = new Uint8Array(makeZip([
        { name: 'manifest.json', data: manifest },
        { name: 'frontend/index.html', data: '<!doctype html>' },
      ]))
      writeFileSync(join(packageDir, 'manifest.json'), manifest)
      writeFileSync(join(packageDir, 'frontend', 'index.html'), '<!doctype html>')
      writeFileSync(join(packageDir, REGISTRY_ARTIFACT_NAME), archive)

      const rootKey = generateKeyPairSync('ed25519')
      const signerKey = generateKeyPairSync('ed25519')
      const rootPem = rootKey.publicKey.export({ type: 'spki', format: 'pem' }).toString()
      const signerPem = signerKey.publicKey.export({ type: 'spki', format: 'pem' }).toString()
      const signed = (value: unknown, key = signerKey.privateKey): string =>
        edSign(null, Buffer.from(canonicalTrustJson(value)), key).toString('base64')
      const digest = sha256Hex(archive)
      const envelope: RegistryPackageEnvelope = {
        schemaVersion: 1,
        artifactDigest: digest,
        packageId: pluginId,
        version,
        target: 'universal',
        publisherId: 'acme',
        keyId: 'selector-test',
        signedAt: '2026-08-16T11:00:00.000Z',
      }
      const metadata: RegistryTrustMetadata = {
        schemaVersion: 1,
        registryProfile: 'official',
        rootFingerprint: `sha256:${'1'.repeat(64)}`,
        generatedAt: '2026-08-16T10:00:00.000Z',
        expiresAt: '2026-08-17T10:00:00.000Z',
        signers: [{
          keyId: 'selector-test',
          publicKey: signerPem,
          status: 'active',
          notBefore: '2026-08-01T00:00:00.000Z',
          notAfter: '2026-09-01T00:00:00.000Z',
        }],
        blockedPublishers: [],
        blockedPackages: [],
      }
      writeFileSync(
        join(packageDir, REGISTRY_RECEIPT_NAME),
        JSON.stringify(registryReceiptFromEvidence({
          packageId: pluginId,
          version,
          publisherId: 'acme',
          target: 'universal',
          artifactDigest: digest,
          envelope,
          envelopeSignature: signed(envelope),
        }))
      )

      const selector = new PluginActivationSelector(root)
      selector.stageCandidate(pluginId, {
        packageVersion: version,
        target: 'universal',
        artifactDigest: '00'.repeat(32),
      })
      selector.activateCandidate(pluginId)

      const mgr = new FrontendPluginManager()
      const trust: InstalledRegistryTrustContext = {
        pinnedRootKey: rootPem,
        snapshot: {
          schemaVersion: 1,
          metadata,
          metadataSignature: signed(metadata, rootKey.privateKey),
        },
        expectedTarget: 'universal',
        now: new Date('2026-08-16T12:00:00.000Z'),
      }
      const result = mgr.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust,
      })

      expect(result.loaded).toEqual([])
      expect(result.activationCatalog).toEqual([])
      expect(result.errors.join(' ')).toMatch(/digest/i)
      expect(mgr.getDescriptor(pluginId)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('loadInstalledPlugins official receipt gate', () => {
  const official = generateKeyPairSync('ed25519')
  const officialPem = official.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  let root: string
  let envBefore: string | undefined

  function writePlugin(id: string, receipt?: Record<string, unknown>): void {
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ id, version: '1.0.0', entry: 'index.html', requires: [] })
    )
    writeFileSync(join(dir, 'index.html'), '<!doctype html>')
    if (receipt) writeFileSync(join(dir, '.navide-receipt.json'), JSON.stringify(receipt))
  }

  function writeV2Plugin(
    directory: string,
    options: {
      id: string
      version?: string
      frontend?: boolean
      backend?: boolean
      receipt?: Record<string, unknown>
    }
  ): void {
    const dir = join(root, directory)
    const version = options.version ?? '1.0.0'
    const manifest = {
      schemaVersion: 2,
      apiVersion: '^1.0.0',
      id: options.id,
      name: options.id,
      version,
      publisher: options.id.split('.')[0],
      permissions: {},
      marketplace: { description: `${options.id} test plugin`, license: 'MIT' },
      contributes: options.frontend
        ? {
            views: [
              {
                id: 'main',
                kind: 'custom',
                location: 'main',
                title: 'Main',
                entry: 'frontend/index.html',
              },
            ],
          }
        : undefined,
      backend: options.backend
        ? {
            entry: 'backend/plugin',
            protocolVersion: 1,
            activation: 'startup',
          }
        : undefined,
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    if (options.frontend) {
      mkdirSync(join(dir, 'frontend'), { recursive: true })
      writeFileSync(join(dir, 'frontend', 'index.html'), '<!doctype html>')
    }
    if (options.backend) {
      mkdirSync(join(dir, 'backend'), { recursive: true })
      const backendPath = join(dir, backendEntryOnDisk('backend/plugin'))
      writeFileSync(backendPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      chmodSync(backendPath, 0o700)
    }
    if (options.receipt) {
      writeFileSync(join(dir, '.navide-receipt.json'), JSON.stringify(options.receipt))
    }
  }

  function officialReceipt(id: string): Record<string, unknown> {
    const digest = 'ab'.repeat(32)
    const signature = edSign(null, Buffer.from(digest, 'ascii'), official.privateKey).toString(
      'base64'
    )
    return { id, version: '1.0.0', digest, signature }
  }

  it('loads a validated Host-bundled Manifest v2 package through the installed runtime', () => {
    writeV2Plugin('factory-git', { id: 'navide.git', frontend: true })
    const mgr = new FrontendPluginManager()

    const result = mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git')

    expect(result).toMatchObject({ loaded: true, pluginId: 'navide.git', packageVersion: '1.0.0' })
    expect(mgr.getDescriptor('navide.git')?.packageVersion).toBe('1.0.0')
    expect(mgr.listInstalledPackages()).toEqual([
      {
        id: 'navide.git',
        requires: [],
        packageVersion: '1.0.0',
        manifestPermissions: { system: [] },
        provenance: 'factory-bundled',
      },
    ])
  })

  it('lists the App-bundled Plans package for the Bundled section only while its factory v2 package is live', () => {
    const empty = new FrontendPluginManager()
    expect(plansFactoryPackageSummary(empty, false)).toEqual({
      id: 'navide.plans',
      version: null,
      active: false,
      optedOut: false,
    })

    writeV2Plugin('factory-plans', { id: 'navide.plans', frontend: true })
    const mgr = new FrontendPluginManager()
    expect(mgr.loadFactoryPlugin(join(root, 'factory-plans'), 'navide.plans').loaded).toBe(true)
    expect(plansFactoryPackageSummary(mgr, false)).toEqual({
      id: 'navide.plans',
      version: '1.0.0',
      active: true,
      optedOut: false,
    })
    // Legacy recovery serves Plans from the old bundle, not this package.
    expect(plansFactoryPackageSummary(mgr, true)).toEqual({
      id: 'navide.plans',
      version: null,
      active: false,
      optedOut: false,
    })
  })

  it('treats the App-bundled Git package as publisher-eligible only after an exact grant', async () => {
    writeV2Plugin('factory-git', { id: 'navide.git', frontend: true })
    const mgr = new FrontendPluginManager()
    expect(mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git').loaded).toBe(true)
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: '1.0.0',
      system: [],
      storage: true,
    }))
    const host = new FakeBrowserWindow()

    await expect(mgr.openContribution(asHost(host), 'navide.git.main', {
      bounds: { x: 0, y: 0, width: 300, height: 500 },
      workspacePath: '/workspace',
    })).resolves.toEqual({ ok: true })

    const running = [...(mgr as unknown as {
      running: Map<string, { capabilityContext: HostCapabilityContext | null }>
    }).running.values()]
    expect(running[0].capabilityContext).toMatchObject({
      publisherEligible: true,
      userGrant: { packageVersion: '1.0.0', system: [], storage: true },
      runtimeBinding: { pluginId: 'navide.git', packageVersion: '1.0.0' },
    })
  })

  it('does not let a Host-bundled package replace an active Registry package', () => {
    writeV2Plugin('factory-git', { id: 'navide.git', version: '1.0.0', frontend: true })
    const mgr = new FrontendPluginManager()
    mgr.registerInstalledPackage(
      { id: 'navide.git', requires: [], provenance: 'official-registry' },
      {
        ...descriptor('navide.git'),
        packageVersion: '2.0.0',
        capabilityPolicy: { kind: 'manifest-v2', system: [], grants: [] },
      },
      { official: true },
    )

    expect(mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git')).toMatchObject({
      loaded: false,
      reason: 'installed package is active',
    })
    expect(mgr.getDescriptor('navide.git')?.packageVersion).toBe('2.0.0')
  })

  it('restores the factory package after legacy recovery, which the plain load refuses', () => {
    writeV2Plugin('factory-git', { id: 'navide.git', frontend: true })
    const mgr = new FrontendPluginManager()
    expect(mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git').loaded).toBe(true)
    // Recovery replaces the descriptor but leaves the package registered, so
    // the plain factory load has no way back — this was why a downgraded
    // session could only reach v2 again by restarting the App.
    mgr.replaceBuiltinForRecovery(descriptor('navide.git'))
    expect(mgr.getDescriptor('navide.git')?.packageVersion).toBeUndefined()
    expect(mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git')).toMatchObject({
      loaded: false,
      reason: 'installed package is active',
    })

    expect(mgr.restoreFactoryAfterRecovery(join(root, 'factory-git'), 'navide.git')).toMatchObject({
      restored: true,
      activation: { pluginId: 'navide.git', packageVersion: '1.0.0' },
    })
    expect(mgr.getDescriptor('navide.git')?.packageVersion).toBe('1.0.0')
  })

  it('leaves the restored factory contribution openable, not marked stopping', async () => {
    writeV2Plugin('factory-git', { id: 'navide.git', frontend: true })
    const mgr = new FrontendPluginManager()
    expect(mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git').loaded).toBe(true)
    mgr.setCapabilityGrantResolver(() => ({ packageVersion: '1.0.0', system: [], storage: true }))
    mgr.replaceBuiltinForRecovery(descriptor('navide.git'))
    // Let the recovery revocation settle so only the restore path can mark the
    // package version stopping.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mgr.restoreFactoryAfterRecovery(join(root, 'factory-git'), 'navide.git')).toMatchObject({
      restored: true,
    })

    await expect(mgr.openContribution(asHost(new FakeBrowserWindow()), 'navide.git.main', {
      bounds: { x: 0, y: 0, width: 300, height: 500 },
      workspacePath: '/workspace',
    })).resolves.toEqual({ ok: true })
  })

  it('refuses to restore a factory package that is not in legacy recovery', () => {
    writeV2Plugin('factory-git', { id: 'navide.git', frontend: true })
    const mgr = new FrontendPluginManager()
    expect(mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git').loaded).toBe(true)

    expect(mgr.restoreFactoryAfterRecovery(join(root, 'factory-git'), 'navide.git')).toEqual({
      restored: false,
      reason: 'plugin is not in legacy recovery',
    })
  })

  it('rejects a factory package whose manifest claims another identity', () => {
    writeV2Plugin('factory-git', { id: 'acme.git', frontend: true })
    const mgr = new FrontendPluginManager()

    expect(mgr.loadFactoryPlugin(join(root, 'factory-git'), 'navide.git')).toMatchObject({
      loaded: false,
      reason: expect.stringMatching(/expected.*navide\.git/i),
    })
    expect(mgr.listInstalledPackages()).toEqual([])
  })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-plugins-'))
    envBefore = process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY'] = officialPem
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (envBefore === undefined) delete process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    else process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY'] = envBefore
  })

  it('registers a navide. plugin whose receipt verifies against the pinned key', () => {
    writePlugin('navide.mini-ide', officialReceipt('navide.mini-ide'))
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(errors).toEqual([])
    expect(loaded).toContain('navide.mini-ide')
    expect(mgr.getDescriptor('navide.mini-ide')).toBeDefined()
  })

  it('does not let a self-hosted Registry context activate a reserved legacy package', () => {
    writePlugin('navide.mini-ide', officialReceipt('navide.mini-ide'))
    const mgr = new FrontendPluginManager()
    const result = mgr.loadInstalledPlugins(root, {
      provenance: 'official-registry',
      trust: {
        pinnedRootKey: officialPem,
        snapshot: null,
        registryAuthority: 'self-hosted',
        officialRegistryUrl: 'https://server.navide.dev/registry',
      },
    })
    expect(result.loaded).toEqual([])
    expect(result.errors.join(' ')).toMatch(/App-authorized Official Registry/)
    expect(mgr.getDescriptor('navide.mini-ide')).toBeUndefined()
  })

  it('refuses a navide. plugin without a receipt', () => {
    writePlugin('navide.mini-ide')
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(loaded).toEqual([])
    expect(errors.join(' ')).toMatch(/receipt/)
    expect(mgr.getDescriptor('navide.mini-ide')).toBeUndefined()
  })

  it('refuses a navide. plugin whose receipt was signed by a different key', () => {
    const rogue = generateKeyPairSync('ed25519')
    const digest = 'cd'.repeat(32)
    const signature = edSign(null, Buffer.from(digest, 'ascii'), rogue.privateKey).toString(
      'base64'
    )
    writePlugin('navide.mini-ide', { id: 'navide.mini-ide', version: '1.0.0', digest, signature })
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(loaded).toEqual([])
    expect(errors.join(' ')).toMatch(/pinned official key/)
  })

  it('falls back to the shipped pin when no env override is set', () => {
    // Without an override the pin comes from OFFICIAL_PUBLISHER_KEY_PEM, so this
    // test-only key is refused for MISMATCHING the pin — not for the absence of
    // one. That distinction is what proves the shipped constant is wired in; if
    // it were ever emptied, the message would revert to "no pinned official".
    delete process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    writePlugin('navide.mini-ide', officialReceipt('navide.mini-ide'))
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(loaded).toEqual([])
    expect(errors.join(' ')).toMatch(/pinned official key/)
    expect(errors.join(' ')).not.toMatch(/no pinned official/)
  })

  it('loads third-party plugins with no receipt requirement', () => {
    writePlugin('acme.demo')
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(errors).toEqual([])
    expect(loaded).toEqual(['acme.demo'])
  })

  it('returns validated frontend-only, backend-only, and combined v2 activations', () => {
    writeV2Plugin('backend-only', { id: 'acme.skills', backend: true })
    writeV2Plugin('combined', { id: 'acme.files', frontend: true, backend: true })
    writeV2Plugin('frontend-only', { id: 'acme.viewer', frontend: true })

    const mgr = new FrontendPluginManager()
    const { loaded, errors, activationCatalog } = mgr.loadInstalledPlugins(root, {
      provenance: 'developer-local-unpacked',
    })

    expect(errors).toEqual([])
    expect([...loaded].sort()).toEqual(['acme.files', 'acme.viewer'])
    expect(activationCatalog.map((entry) => entry.pluginId).sort()).toEqual([
      'acme.files',
      'acme.skills',
      'acme.viewer',
    ])
    expect(
      activationCatalog.find((entry) => entry.pluginId === 'acme.skills')?.backend
    ).toMatchObject({ protocolVersion: 1, activation: 'startup' })
    expect(
      activationCatalog.find((entry) => entry.pluginId === 'acme.viewer')?.backend
    ).toBeUndefined()
    expect(mgr.listInstalledPackages().map((pkg) => pkg.id).sort()).toEqual([
      'acme.files',
      'acme.skills',
      'acme.viewer',
    ])
  })

  describe('explicit Developer Mode package selection', () => {
    it('loads one explicitly selected frontend package only when opted in', () => {
      writeV2Plugin('viewer', { id: 'acme.viewer', frontend: true })
      const mgr = new FrontendPluginManager()

      expect(mgr.loadExplicitDeveloperPlugin(join(root, 'viewer'), false)).toMatchObject({
        loaded: false,
        error: expect.stringMatching(/opt-in/),
      })
      expect(mgr.loadExplicitDeveloperPlugin(join(root, 'viewer'), true)).toEqual({
        loaded: true,
        pluginId: 'acme.viewer',
      })
      expect(mgr.listInstalledPackages()).toEqual([
        {
          id: 'acme.viewer',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'developer-local-unpacked',
          warning: 'Unsigned local unpacked plugin — Developer Mode only',
        },
      ])
    })

    it('loads a legacy v1 sideload only with explicit local provenance', () => {
      writePlugin('legacy', undefined)
      const manifestPath = join(root, 'legacy', 'manifest.json')
      writeFileSync(
        manifestPath,
        JSON.stringify({ id: 'acme.legacy', version: '1.0.0', entry: 'index.html', requires: [] })
      )
      const mgr = new FrontendPluginManager()
      expect(mgr.loadExplicitDeveloperPlugin(join(root, 'legacy'), true)).toEqual({
        loaded: true,
        pluginId: 'acme.legacy',
      })
      expect(mgr.listInstalledPackages()).toEqual([
        {
          id: 'acme.legacy',
          requires: [],
          provenance: 'developer-local-unpacked',
          warning: 'Unsigned local unpacked plugin — Developer Mode only',
        },
      ])
    })

    it('does not scan a selected parent directory', () => {
      writeV2Plugin('viewer', { id: 'acme.viewer', frontend: true })
      const mgr = new FrontendPluginManager()
      expect(mgr.loadExplicitDeveloperPlugin(root, true)).toMatchObject({
        loaded: false,
        error: expect.stringMatching(/manifest/),
      })
      expect(mgr.listInstalledPackages()).toEqual([])
    })

    it.each([
      ['missing path', undefined, /explicit package directory/],
      ['reserved id', 'navide-spoof', /reserved/],
      ['backend package', 'backend', /backend/],
    ])('rejects Developer Mode %s', (_label, selected, expected) => {
      if (selected === 'navide-spoof') {
        writeV2Plugin(selected, { id: 'navide.spoof', frontend: true })
      } else if (selected === 'backend') {
        writeV2Plugin(selected, { id: 'acme.backend', backend: true })
      }
      const mgr = new FrontendPluginManager()
      const selectedPath = selected === undefined ? undefined : join(root, selected)
      expect(mgr.loadExplicitDeveloperPlugin(selectedPath, true)).toMatchObject({
        loaded: false,
        error: expect.stringMatching(expected),
      })
      expect(mgr.listInstalledPackages()).toEqual([])
    })

    it('rejects invalid manifests before registering a local package', () => {
      const dir = join(root, 'invalid')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'manifest.json'), '{"schemaVersion":2}')
      const mgr = new FrontendPluginManager()
      expect(mgr.loadExplicitDeveloperPlugin(dir, true)).toMatchObject({
        loaded: false,
        error: expect.stringMatching(/manifest|invalid/),
      })
      expect(mgr.listInstalledPackages()).toEqual([])
    })
  })

  it('rejects duplicate package identities without blocking unrelated v2 packages', () => {
    writeV2Plugin('files-v1', {
      id: 'acme.files',
      version: '1.0.0',
      frontend: true,
      backend: true,
    })
    writeV2Plugin('files-v2', {
      id: 'acme.files',
      version: '2.0.0',
      frontend: true,
      backend: true,
    })
    writeV2Plugin('viewer', { id: 'acme.viewer', frontend: true })

    const mgr = new FrontendPluginManager()
    const { loaded, errors, activationCatalog } = mgr.loadInstalledPlugins(root, {
      provenance: 'developer-local-unpacked',
    })

    expect(errors.join(' ')).toMatch(/duplicate plugin packages/)
    expect(errors.join(' ')).toContain(join(root, 'files-v1'))
    expect(errors.join(' ')).toContain(join(root, 'files-v2'))
    expect(loaded).toEqual(['acme.viewer'])
    expect(activationCatalog.map((entry) => entry.pluginId)).toEqual(['acme.viewer'])
    expect(mgr.getDescriptor('acme.files')).toBeUndefined()
    expect(mgr.listInstalledPackages().map((pkg) => pkg.id)).toEqual(['acme.viewer'])
  })

  it('rejects a v1 frontend and v2 backend-only package with the same id', () => {
    writePlugin('acme.demo')
    writeV2Plugin('backend-copy', { id: 'acme.demo', backend: true })
    writeV2Plugin('viewer', { id: 'acme.viewer', frontend: true })

    const mgr = new FrontendPluginManager()
    const { loaded, errors, activationCatalog } = mgr.loadInstalledPlugins(root, {
      provenance: 'developer-local-unpacked',
    })

    expect(errors.join(' ')).toMatch(/acme\.demo: duplicate plugin packages/)
    expect(errors.join(' ')).toContain(join(root, 'acme.demo'))
    expect(errors.join(' ')).toContain(join(root, 'backend-copy'))
    expect(loaded).toEqual(['acme.viewer'])
    expect(activationCatalog.map((entry) => entry.pluginId)).toEqual(['acme.viewer'])
    expect(mgr.getDescriptor('acme.demo')).toBeUndefined()
    expect(mgr.listInstalledPackages().map((pkg) => pkg.id)).toEqual(['acme.viewer'])
  })

  it('removes a stale frontend descriptor when an install becomes backend-only', () => {
    const mgr = new FrontendPluginManager()
    mgr.registerInstalledPackage(
      { id: 'acme.demo', requires: ['git'] },
      descriptor('acme.demo')
    )
    expect(mgr.getDescriptor('acme.demo')).toBeDefined()

    mgr.registerInstalledPackage({ id: 'acme.demo', requires: [] })

    expect(mgr.getDescriptor('acme.demo')).toBeUndefined()
    expect(mgr.listInstalledPackages()).toEqual([{ id: 'acme.demo', requires: [] }])
  })

  it('keeps a reserved backend-only package behind the official receipt gate', () => {
    writeV2Plugin('navide-skills', { id: 'navide.skills', backend: true })
    const mgr = new FrontendPluginManager()

    const { loaded, errors, activationCatalog } = mgr.loadInstalledPlugins(root)

    expect(loaded).toEqual([])
    expect(activationCatalog).toEqual([])
    expect(errors.join(' ')).toMatch(/Registry trust context/)
    expect(mgr.listInstalledPackages()).toEqual([])
  })

  it('does not accept a legacy digest receipt for a v2 reserved package', () => {
    writeV2Plugin('navide-skills', {
      id: 'navide.skills',
      backend: true,
      receipt: officialReceipt('navide.skills'),
    })
    const mgr = new FrontendPluginManager()

    const { loaded, errors, activationCatalog } = mgr.loadInstalledPlugins(root)

    expect(loaded).toEqual([])
    expect(errors.join(' ')).toMatch(/Registry trust context/)
    expect(activationCatalog).toEqual([])
    expect(mgr.listInstalledPackages()).toEqual([])
  })

  it('stops and unregisters a v2 frontend when refreshed trust quarantines it', () => {
    writeV2Plugin('viewer', { id: 'acme.viewer', frontend: true })
    const mgr = new FrontendPluginManager()
    const loaded = mgr.loadInstalledPlugins(root, {
      provenance: 'developer-local-unpacked',
    })
    expect(loaded.loaded).toEqual(['acme.viewer'])

    const decisions = mgr.refreshInstalledPluginTrust(root, {
      pinnedRootKey: officialPem,
      snapshot: null,
    })

    expect(decisions).toEqual([
      expect.objectContaining({ pluginId: 'acme.viewer', action: 'quarantine' }),
    ])
    expect(mgr.getDescriptor('acme.viewer')).toBeUndefined()
    expect(mgr.listInstalledPackages()).toEqual([])
  })
})

describe('bundled mini-IDE builtin resolution', () => {
  let root: string

  /** Write a valid bundled mini-IDE dir (manifest + entry) under `dir`. */
  function writeBundled(dir: string, manifest?: Record<string, unknown>): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(
        manifest ?? {
          id: MINI_IDE_PLUGIN_ID,
          version: '1.0.0',
          entry: 'index.html',
          requires: ['fs', 'git'],
        }
      )
    )
    writeFileSync(join(dir, 'index.html'), '<!doctype html>')
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-bundled-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves resourcesPath/plugins/mini-ide when packaged', () => {
    expect(bundledMiniIdeDir({ isPackaged: true, resourcesPath: '/res', artifactVersion: '1.2.3' })).toBe(
      join('/res', 'plugins', 'mini-ide')
    )
  })

  it('resolves dist-plugins/mini-ide under the dev root when unpackaged', () => {
    expect(
      bundledMiniIdeDir({ isPackaged: false, resourcesPath: '/res', artifactVersion: '1.2.3', devRoot: '/repo' })
    ).toBe(join('/repo', 'dist-plugins', 'mini-ide'))
  })

  it('registers the bundled copy as builtin when nothing is installed (packaged)', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    writeBundled(dir)
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root, artifactVersion: '1.0.0' })
    expect(result.registered).toBe(true)
    const desc = mgr.getDescriptor(MINI_IDE_PLUGIN_ID)
    expect(desc?.entryFile).toBe(join(dir, 'index.html'))
    expect(desc?.requires).toEqual(['fs', 'git'])
  })

  it('registers the dev dist-plugins copy when unpackaged', () => {
    const dir = join(root, 'dist-plugins', 'mini-ide')
    writeBundled(dir)
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, {
      isPackaged: false,
      resourcesPath: '/unused',
      artifactVersion: '1.0.0',
      devRoot: root,
    })
    expect(result.registered).toBe(true)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)?.entryFile).toBe(join(dir, 'index.html'))
  })

  it('an already-installed (official) copy takes precedence over the bundled copy', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    writeBundled(dir)
    const mgr = new FrontendPluginManager()
    const installed: PluginLaunchDescriptor = {
      id: MINI_IDE_PLUGIN_ID,
      requires: ['fs'],
      devUrl: '',
      entryFile: '/userData/plugins/navide.mini-ide/index.html',
    }
    mgr.registerDescriptor(installed, { official: true })

    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root, artifactVersion: '1.0.0' })
    expect(result.registered).toBe(true)
    // Installed copy stays active; the bundled one is only the fallback.
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)?.entryFile).toBe(installed.entryFile)
  })

  it('removing the installed override reverts to the bundled builtin', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    writeBundled(dir)
    const mgr = new FrontendPluginManager()
    mgr.registerDescriptor(
      {
        id: MINI_IDE_PLUGIN_ID,
        requires: ['fs'],
        devUrl: '',
        entryFile: '/userData/plugins/navide.mini-ide/index.html',
      },
      { official: true }
    )
    registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root, artifactVersion: '1.0.0' })

    mgr.removeInstalledPlugin(MINI_IDE_PLUGIN_ID)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)?.entryFile).toBe(join(dir, 'index.html'))
  })

  it('a missing bundled dir is refused without crashing (dialog fallback)', () => {
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root, artifactVersion: '1.0.0' })
    expect(result.registered).toBe(false)
    expect(result.reason).toBeTruthy()
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)).toBeUndefined()
  })

  it('an invalid bundled manifest is refused without crashing', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), 'not json at all')
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root, artifactVersion: '1.0.0' })
    expect(result.registered).toBe(false)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)).toBeUndefined()
  })

  it('a bundled manifest claiming a different id is refused', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    writeBundled(dir, {
      id: 'acme.impostor',
      version: '1.0.0',
      entry: 'index.html',
      requires: [],
    })
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root, artifactVersion: '1.0.0' })
    expect(result.registered).toBe(false)
    expect(result.reason).toMatch(/acme\.impostor/)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)).toBeUndefined()
  })

  it('a bundled dir whose entry file is missing is refused', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ id: MINI_IDE_PLUGIN_ID, version: '1.0.0', entry: 'index.html', requires: [] })
    )
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root, artifactVersion: '1.0.0' })
    expect(result.registered).toBe(false)
    expect(result.reason).toMatch(/entry file missing/)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)).toBeUndefined()
  })
})

describe('view lifecycle (open / hideSelf / resize / death paths)', () => {
  const OPEN_TARGET = 'plugin:openTarget'

  function openView(
    mgr: FrontendPluginManager,
    host: FakeBrowserWindow,
    id: string,
    query?: string
  ): FakeViewLike {
    const before = views.length
    mgr.open(asHost(host), { ...descriptor(id), query }, 'fill')
    // Existing-view opens create no new fake; return the plugin's current view.
    return views.length > before ? views[views.length - 1] : views[before - 1]
  }

  function openTargets(view: FakeViewLike): Record<string, string>[] {
    return view.webContents.sent
      .filter((m) => m.channel === OPEN_TARGET)
      .map((m) => m.args[0] as Record<string, string>)
  }

  it('leaves the host title alone when mirrorTitle is not requested', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    host.title = 'my-repo — Navide'
    const view = openView(mgr, host, 'acme.a', '?workspace_path=/ws')
    // A plugin embedded in a shared window must never rename that window.
    view.webContents.emit('page-title-updated', {}, 'something — Acme')
    expect(host.title).toBe('my-repo — Navide')
  })

  it('hideSelf hides only the calling sender view', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openView(mgr, host, 'acme.a', '?workspace_path=/ws')
    const before = views.length
    mgr.open(asHost(host), descriptor('acme.b'), { x: 0, y: 0, width: 10, height: 10 })
    const viewB = views[before]
    expect(viewA.visible).toBe(true)
    expect(viewB.visible).toBe(true)

    const hide = ipcListeners.get('plugin:hideSelf')
    expect(hide).toBeDefined()
    hide!({ sender: { id: viewA.webContents.id } })
    expect(viewA.visible).toBe(false)
    expect(viewB.visible).toBe(true)

    // Unknown sender → no-op (never hides someone else's view).
    hide!({ sender: { id: 999999 } })
    expect(viewB.visible).toBe(true)
  })

  it('drops the running record when the webContents dies and reopen recreates', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const first = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    expect(first.webContents.loads).toHaveLength(1)

    // Simulate renderer death (any path other than manager.destroy()).
    first.webContents.close()

    const countBefore = views.length
    const second = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    expect(views.length).toBe(countBefore + 1) // recreated, not reused
    expect(second).not.toBe(first)
    expect(second.webContents.loads).toHaveLength(1)
  })

  it('delivers a changed open target to the running view without reloading', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws&http_url=http://x')
    view.webContents.emit('did-finish-load')

    openView(mgr, host, 'acme.editor', '?workspace_path=/ws&filepath=src/a.ts&line=7')
    expect(view.webContents.loads).toHaveLength(1) // no reload
    expect(openTargets(view)).toEqual([
      { workspace_path: '/ws', filepath: 'src/a.ts', line: '7' },
    ])
  })

  it('queues an open target racing the first load and flushes on did-finish-load', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    // Second open arrives before the entry finished loading.
    openView(mgr, host, 'acme.editor', '?workspace_path=/ws&filepath=b.ts')
    expect(openTargets(view)).toEqual([])

    view.webContents.emit('did-finish-load')
    expect(openTargets(view)).toEqual([{ workspace_path: '/ws', filepath: 'b.ts' }])
  })

  it('delivers an out-of-workspace open (file_ws) in-page without reloading', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws&http_url=http://x')
    view.webContents.emit('did-finish-load')

    // `file_ws` names the external file's own root; the workspace is unchanged,
    // so the view must keep its open tabs and just receive the target.
    openView(mgr, host, 'acme.editor', '?workspace_path=/ws&file_ws=/elsewhere&filepath=notes.md')
    expect(view.webContents.loads).toHaveLength(1) // no reload
    expect(openTargets(view)).toEqual([
      { workspace_path: '/ws', file_ws: '/elsewhere', filepath: 'notes.md' },
    ])
  })

  it('reloads the entry when the workspace changes (legacy routing)', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws-a')
    view.webContents.emit('did-finish-load')

    openView(mgr, host, 'acme.editor', '?workspace_path=/ws-b')
    expect(view.webContents.loads).toHaveLength(2) // reloaded with new params
    expect(openTargets(view)).toEqual([]) // no in-page delivery on reload
  })

  it('sizes a fill view to the host content bounds and tracks host resize', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    host.contentBounds = { x: 0, y: 0, width: 800, height: 600 }
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 800, height: 600 })

    host.contentBounds = { x: 0, y: 0, width: 1024, height: 768 }
    host.emit('resize')
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1024, height: 768 })

    // Hidden views stop tracking (listener removed on hide).
    mgr.deactivate('acme.editor')
    host.contentBounds = { x: 0, y: 0, width: 500, height: 400 }
    host.emit('resize')
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1024, height: 768 })
  })

  describe('fill view across window-state changes off macOS', () => {
    const baseline = platformId()
    afterEach(() => {
      setPlatformId(baseline)
      vi.useRealTimers()
    })

    it.each(['linux', 'win32'] as const)('follows a maximize that fires no resize (%s)', (platform) => {
      setPlatformId(platform)
      const mgr = new FrontendPluginManager()
      const host = new FakeBrowserWindow()
      host.contentBounds = { x: 0, y: 0, width: 1100, height: 694 }
      const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')

      host.contentBounds = { x: 0, y: 0, width: 1214, height: 702 }
      host.emit('maximize')
      expect(view.bounds).toEqual({ x: 0, y: 0, width: 1214, height: 702 })
      mgr.deactivate('acme.editor')
    })

    it('reads the bounds again once the window manager has settled (GNOME reports stale bounds)', () => {
      setPlatformId('linux')
      vi.useFakeTimers()
      const mgr = new FrontendPluginManager()
      const host = new FakeBrowserWindow()
      host.contentBounds = { x: 0, y: 0, width: 1100, height: 694 }
      const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')

      host.emit('resize') // fired while the old size is still reported
      host.contentBounds = { x: 0, y: 0, width: 1214, height: 702 }
      expect(view.bounds).toEqual({ x: 0, y: 0, width: 1100, height: 694 })
      vi.advanceTimersByTime(200)
      expect(view.bounds).toEqual({ x: 0, y: 0, width: 1214, height: 702 })

      // Hidden views stop tracking, settle timer included.
      host.emit('maximize')
      mgr.deactivate('acme.editor')
      host.contentBounds = { x: 0, y: 0, width: 500, height: 400 }
      vi.advanceTimersByTime(200)
      host.emit('unmaximize')
      expect(view.bounds).toEqual({ x: 0, y: 0, width: 1214, height: 702 })
    })

    it('keeps macOS on the resize event alone', () => {
      setPlatformId('darwin')
      const mgr = new FrontendPluginManager()
      const host = new FakeBrowserWindow()
      host.contentBounds = { x: 0, y: 0, width: 800, height: 600 }
      const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
      host.contentBounds = { x: 0, y: 0, width: 1024, height: 768 }
      host.emit('maximize')
      expect(view.bounds).toEqual({ x: 0, y: 0, width: 800, height: 600 })
      host.emit('resize')
      expect(view.bounds).toEqual({ x: 0, y: 0, width: 1024, height: 768 })
      mgr.deactivate('acme.editor')
    })
  })

  it('re-opening a running view reveals and focuses the hosting window', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    host.minimized = true
    host.shown = false

    openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    expect(view.visible).toBe(true)
    expect(host.minimized).toBe(false)
    expect(host.shown).toBe(true)
    expect(host.focusCount).toBeGreaterThan(0)
  })

  it('cross-window open keeps the view on its original host and focuses that host', () => {
    const mgr = new FrontendPluginManager()
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()
    const view = openView(mgr, hostA, 'acme.editor', '?workspace_path=/ws')

    openView(mgr, hostB, 'acme.editor', '?workspace_path=/ws&filepath=c.ts')
    expect(hostA.children).toContain(view)
    expect(hostB.children).not.toContain(view)
    expect(hostA.focusCount).toBeGreaterThan(0)
    expect(hostB.focusCount).toBe(0)
  })
})

describe('opaque view instance ownership', () => {
  function dispatchEvent(mgr: FrontendPluginManager, event: string, payload: unknown): void {
    ;(mgr as unknown as { dispatchEvent(event: string, payload: unknown): void }).dispatchEvent(
      event,
      payload
    )
  }

  function eventsOf(
    view: FakeViewLike,
    type: string
  ): Array<{ type: string; data: Record<string, unknown> }> {
    return view.webContents.sent
      .filter((message) => message.channel === 'plugin:cap:event')
      .map((message) => message.args[0] as { type: string; data: Record<string, unknown> })
      .filter((event) => event.type === type)
  }

  function output(id: string, data: string): Record<string, unknown> {
    return { terminal_session_id: id, pane_id: 'p', sequence: 1, data, stream: 'stdout' }
  }

  function packageDescriptor(id = 'acme.multi-view'): PluginLaunchDescriptor {
    return {
      id,
      packageVersion: '1.0.0',
      requires: [],
      devUrl: '',
      entryFile: `/plugins/${id}/fallback.html`,
      views: [
        {
          id: 'left',
          contributionKey: `${id}.left`,
          kind: 'custom',
          location: 'left',
          title: 'Left',
          entryFile: `/plugins/${id}/left.html`,
        },
        {
          id: 'window',
          contributionKey: `${id}.window`,
          kind: 'custom',
          location: 'window',
          title: 'Window',
          entryFile: `/plugins/${id}/window.html`,
        },
      ],
    }
  }

  function v2Context(options: {
    pluginId?: string
    packageVersion?: string
    workspaceId?: string
    audience?: string
    sessionId?: string
  } = {}): HostCapabilityContext {
    const binding = {
      pluginId: options.pluginId ?? 'acme.multi-view',
      packageVersion: options.packageVersion ?? '1.0.0',
      workspaceId: options.workspaceId ?? 'workspace-1',
      instanceId: 'host-placeholder',
      audience: options.audience ?? 'shared-audience',
    }
    return {
      publisherEligible: true,
      userGrant: { packageVersion: binding.packageVersion, system: ['fs', 'aiCli'] },
      runtimeBinding: binding,
      ...(options.sessionId
        ? { sessionBindings: new Map([[options.sessionId, binding]]) }
        : {}),
    }
  }

  function v2PackageDescriptor(id = 'acme.multi-view'): PluginLaunchDescriptor {
    return {
      ...packageDescriptor(id),
      requires: ['terminal'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs', 'aiCli'] }),
      capabilityContext: v2Context({ pluginId: id }),
    }
  }

  function v2WindowDescriptor(id = 'acme.window-target'): PluginLaunchDescriptor {
    const descriptor = v2PackageDescriptor(id)
    return {
      ...descriptor,
      views: [descriptor.views![1]!],
    }
  }

  it('creates independently addressable opaque instances for one package', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()

    const left = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(hostA),
      bounds: { x: 1, y: 2, width: 300, height: 400 },
    })
    const window = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(hostB),
      bounds: { x: 5, y: 6, width: 700, height: 500 },
    })

    expect(left.instanceId).toBeTruthy()
    expect(window.instanceId).toBeTruthy()
    expect(left.instanceId).not.toBe(window.instanceId)
    expect(left.instanceId).not.toBe(packageDesc.id)
    expect(window.instanceId).not.toBe(packageDesc.id)
    expect(hostA.children).toHaveLength(1)
    expect(hostB.children).toHaveLength(1)
    expect((hostA.children[0] as FakeViewLike).webContents.loads).toEqual([
      packageDesc.views![0].entryFile,
    ])
    expect((hostB.children[0] as FakeViewLike).webContents.loads).toEqual([
      packageDesc.views![1].entryFile,
    ])
    expect(hostA.focusCount).toBeGreaterThan(0)
    expect(hostB.focusCount).toBeGreaterThan(0)
    expect((hostA.children[0] as FakeViewLike).webContents.focusCount).toBeGreaterThan(0)
    expect((hostB.children[0] as FakeViewLike).webContents.focusCount).toBeGreaterThan(0)
  })

  it('mints a receiver-owned file grant for new and reused window contribution targets', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor = v2WindowDescriptor()
    mgr.registerDescriptor(descriptor)
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: descriptor.packageVersion!,
      system: ['fs', 'aiCli'],
      storage: true,
    }))
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'window-target-workspace-')))
    try {
      const firstPath = join(workspacePath, 'first.ts')
      const secondPath = join(workspacePath, 'second.ts')
      const firstHost = new FakeBrowserWindow()
      const firstOpening = mgr.openContributionWindow(
        asHost(firstHost),
        descriptor.views![0]!.contributionKey,
        {
          workspacePath,
          query: `?workspace_path=${encodeURIComponent(workspacePath)}&filepath=first.ts&file_grant=caller-grant`,
          trustedEditorFileTarget: { path: firstPath },
        },
      )
      const firstView = firstHost.children[0] as FakeViewLike
      firstView.webContents.emit('did-finish-load')
      const firstResult = await firstOpening
      expect(firstResult).toEqual({ ok: true })
      const firstLoaded = new URLSearchParams(firstView.webContents.loads[0]!.split('?')[1])
      // A trusted target is withheld from the bootstrap URL until the initial
      // backend binding has completed. The renderer must never receive the
      // caller's grant or an unbound file target during that await.
      expect(firstLoaded.get('file_grant')).toBeNull()
      expect(firstLoaded.get('filepath')).toBeNull()

      const running = (mgr as unknown as {
        running: Map<string, { hostWindow: FakeBrowserWindow; capabilityContext: HostCapabilityContext | null }>
      }).running
      const firstInstanceId = [...running.entries()].find(([, plugin]) => plugin.hostWindow === firstHost)?.[0]
      expect(firstInstanceId).toBeTruthy()
      const firstPlugin = running.get(firstInstanceId!)!
      const firstBinding = firstPlugin.capabilityContext!.runtimeBinding!
      const grants = (mgr as unknown as {
        editorSelectionGrants: {
          resolve: (owner: { instanceId: string; workspaceId: string; packageVersion: string }, grant: unknown, kind: 'file') => string
        }
      }).editorSelectionGrants
      const firstOwner = {
        instanceId: firstInstanceId!,
        workspaceId: firstBinding.workspaceId!,
        packageVersion: firstBinding.packageVersion,
      }
      const firstTarget = firstView.webContents.sent.at(-1)
      expect(firstTarget?.channel).toBe('plugin:openTarget')
      const firstParams = firstTarget?.args[0] as Record<string, string>
      const firstGrant = firstParams.file_grant
      expect(firstGrant).toBeTruthy()
      expect(firstGrant).not.toBe('caller-grant')
      expect(grants.resolve(firstOwner, firstGrant, 'file')).toBe(firstPath)

      const reused = await mgr.openContributionWindow(
        asHost(firstHost),
        descriptor.views![0]!.contributionKey,
        {
          workspacePath,
          query: `?workspace_path=${encodeURIComponent(workspacePath)}&filepath=second.ts&file_grant=caller-reused`,
          trustedEditorFileTarget: { path: secondPath },
        },
      )
      expect(reused).toEqual({ ok: true })
      expect(firstView.webContents.loads).toHaveLength(1)
      const target = firstView.webContents.sent.at(-1)
      expect(target?.channel).toBe('plugin:openTarget')
      const secondParams = target?.args[0] as Record<string, string>
      expect(secondParams.file_grant).toBeTruthy()
      expect(secondParams.file_grant).not.toBe('caller-reused')
      expect(grants.resolve(firstOwner, secondParams.file_grant, 'file')).toBe(secondPath)

      await expect(mgr.openContributionWindow(
        asHost(firstHost),
        descriptor.views![0]!.contributionKey,
        {
          workspacePath,
          query: `?workspace_path=${encodeURIComponent(workspacePath)}&file_grant=caller-only`,
        },
      )).resolves.toEqual({ ok: true })
      const strippedTarget = firstView.webContents.sent.at(-1)?.args[0] as Record<string, string>
      expect(strippedTarget.file_grant).toBeUndefined()

      expect(() => grants.resolve(
        { ...firstOwner, instanceId: 'sibling-instance' },
        secondParams.file_grant,
        'file',
      )).toThrow(/owned by this instance/)
      expect(() => grants.resolve(
        { ...firstOwner, workspaceId: 'sibling-workspace' },
        secondParams.file_grant,
        'file',
      )).toThrow(/owned by this instance/)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('withholds a new target when its live dispatch gate expires during binding', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor = v2WindowDescriptor('acme.window-target-gated')
    mgr.registerDescriptor(descriptor)
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: descriptor.packageVersion!,
      system: ['fs', 'aiCli'],
      storage: true,
    }))
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'window-target-gated-')))
    try {
      const host = new FakeBrowserWindow()
      let active = true
      vi.spyOn(mgr, 'waitForBackendBinding').mockResolvedValue()
      const opening = mgr.openContributionWindow(
        asHost(host),
        descriptor.views![0]!.contributionKey,
        {
          workspacePath,
          query: `?workspace_path=${encodeURIComponent(workspacePath)}&filepath=main.ts&file_grant=caller-grant`,
          trustedEditorFileTarget: { path: join(workspacePath, 'main.ts') },
          canDispatch: () => active,
        },
      )
      await Promise.resolve()
      const view = host.children[0] as FakeViewLike
      expect(view).toBeDefined()
      active = false
      view.webContents.emit('did-finish-load')
      await expect(opening).resolves.toEqual({ ok: false, error: 'request is no longer active' })
      expect(host.children).toHaveLength(0)
      const loaded = new URLSearchParams(view.webContents.loads[0]!.split('?')[1])
      expect(loaded.get('file_grant')).toBeNull()
      expect(loaded.get('filepath')).toBeNull()
      expect(view.webContents.sent.filter(({ channel }) => channel === 'plugin:openTarget')).toHaveLength(0)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('rejects a trusted target whose canonical path changes while binding is pending', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor = v2WindowDescriptor('acme.window-target-canonical')
    mgr.registerDescriptor(descriptor)
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: descriptor.packageVersion!,
      system: ['fs', 'aiCli'],
      storage: true,
    }))
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'window-target-canonical-')))
    try {
      const targetPath = join(workspacePath, 'target.ts')
      const replacementPath = join(workspacePath, 'replacement.ts')
      writeFileSync(targetPath, 'original')
      writeFileSync(replacementPath, 'replacement')
      const expectedCanonicalPath = realpathSync(targetPath)
      vi.spyOn(mgr, 'waitForBackendBinding').mockResolvedValue()
      const host = new FakeBrowserWindow()
      const opening = mgr.openContributionWindow(
        asHost(host),
        descriptor.views![0]!.contributionKey,
        {
          workspacePath,
          query: `?workspace_path=${encodeURIComponent(workspacePath)}&filepath=target.ts`,
          trustedEditorFileTarget: { path: targetPath, expectedCanonicalPath, workspaceOnly: true },
        },
      )
      await Promise.resolve()
      const view = host.children[0] as FakeViewLike
      expect(view).toBeDefined()
      rmSync(targetPath)
      symlinkSync(replacementPath, targetPath)
      view.webContents.emit('did-finish-load')

      await expect(opening).resolves.toEqual({
        ok: false,
        error: 'selected resource changed before opening',
      })
      expect(host.children).toHaveLength(0)
      expect(view.webContents.sent.filter(({ channel }) => channel === 'plugin:openTarget')).toHaveLength(0)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('replays the last receiver target after a readiness retry without its expired request gate', async () => {
    vi.useFakeTimers()
    const mgr = new FrontendPluginManager()
    const descriptor = v2WindowDescriptor('acme.window-target-retry')
    mgr.registerDescriptor(descriptor)
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: descriptor.packageVersion!,
      system: ['fs', 'aiCli'],
      storage: true,
    }))
    mgr.setActivationFailureHandler(vi.fn())
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'window-target-retry-')))
    try {
      const targetPath = join(workspacePath, 'target.ts')
      writeFileSync(targetPath, 'target')
      const host = new FakeBrowserWindow()
      const contribution = descriptor.views![0]!.contributionKey
      await mgr.openContributionWindow(asHost(host), contribution, {
        workspacePath,
        query: `?workspace_path=${encodeURIComponent(workspacePath)}`,
      })
      const view = host.children[0] as FakeViewLike
      view.webContents.emit('did-finish-load')
      let active = true
      await expect(mgr.openContributionWindow(asHost(host), contribution, {
        workspacePath,
        query: `?workspace_path=${encodeURIComponent(workspacePath)}&filepath=target.ts`,
        trustedEditorFileTarget: { path: targetPath },
        canDispatch: () => active,
      })).resolves.toEqual({ ok: true })
      const beforeRetry = view.webContents.sent.filter(({ channel }) => channel === 'plugin:openTarget')
      expect(beforeRetry).toHaveLength(1)

      // The original request has ended by the time the readiness budget causes
      // a guest reload. Replay uses only the receiver-owned delivered params.
      active = false
      await vi.advanceTimersByTimeAsync(10_000)
      expect(view.webContents.reloads).toBe(1)
      let reopenActive = true
      const canceled = mgr.openContributionWindow(asHost(host), contribution, {
        workspacePath,
        query: `?workspace_path=${encodeURIComponent(workspacePath)}&filepath=target.ts`,
        trustedEditorFileTarget: { path: targetPath },
        canDispatch: () => reopenActive,
      })
      reopenActive = false
      view.webContents.emit('did-finish-load')
      await expect(canceled).resolves.toEqual({ ok: false, error: 'request is no longer active' })
      const afterRetry = view.webContents.sent.filter(({ channel }) => channel === 'plugin:openTarget')
      expect(afterRetry).toHaveLength(2)
      expect(afterRetry[1]!.args[0]).toEqual(afterRetry[0]!.args[0])
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('does not let a readiness retry replay overwrite a target reopened while loading', async () => {
    vi.useFakeTimers()
    const mgr = new FrontendPluginManager()
    const descriptor = v2WindowDescriptor('acme.window-target-retry-reopen')
    mgr.registerDescriptor(descriptor)
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: descriptor.packageVersion!,
      system: ['fs', 'aiCli'],
      storage: true,
    }))
    mgr.setActivationFailureHandler(vi.fn())
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'window-target-retry-reopen-')))
    try {
      const firstPath = join(workspacePath, 'first.ts')
      const secondPath = join(workspacePath, 'second.ts')
      writeFileSync(firstPath, 'first')
      writeFileSync(secondPath, 'second')
      const host = new FakeBrowserWindow()
      const contribution = descriptor.views![0]!.contributionKey
      await mgr.openContributionWindow(asHost(host), contribution, {
        workspacePath,
        query: `?workspace_path=${encodeURIComponent(workspacePath)}`,
      })
      const view = host.children[0] as FakeViewLike
      view.webContents.emit('did-finish-load')
      await mgr.openContributionWindow(asHost(host), contribution, {
        workspacePath,
        query: `?workspace_path=${encodeURIComponent(workspacePath)}&filepath=first.ts`,
        trustedEditorFileTarget: { path: firstPath },
      })

      await vi.advanceTimersByTimeAsync(10_000)
      expect(view.webContents.reloads).toBe(1)
      const reopening = mgr.openContributionWindow(asHost(host), contribution, {
        workspacePath,
        query: `?workspace_path=${encodeURIComponent(workspacePath)}&filepath=second.ts`,
        trustedEditorFileTarget: { path: secondPath },
        canDispatch: () => true,
      })
      // The entry is still loading, so the old replay waits for the new
      // document and the reopened target cannot be sent into stale content.
      expect(view.webContents.sent.filter(({ channel }) => channel === 'plugin:openTarget')).toHaveLength(1)
      view.webContents.emit('did-finish-load')
      await expect(reopening).resolves.toEqual({ ok: true })
      const targets = view.webContents.sent
        .filter(({ channel }) => channel === 'plugin:openTarget')
        .map(({ args }) => args[0] as Record<string, string>)
      expect(targets).toHaveLength(3)
      expect(targets.at(-1)?.file_grant).toBeTruthy()
      const grants = (mgr as unknown as {
        editorSelectionGrants: { resolve: (owner: unknown, grant: unknown, kind: 'file') => string }
      }).editorSelectionGrants
      const running = (mgr as unknown as {
        running: Map<string, { capabilityContext: HostCapabilityContext | null }>
      }).running
      const plugin = [...running.values()][0]
      const binding = plugin.capabilityContext!.runtimeBinding!
      expect(grants.resolve({
        instanceId: binding.instanceId!,
        workspaceId: binding.workspaceId!,
        packageVersion: binding.packageVersion,
      }, targets.at(-1)!.file_grant, 'file')).toBe(secondPath)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('delivers Host-contained HTML preview targets without file grants on fresh and reused windows', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor = v2WindowDescriptor('acme.window-html-preview')
    mgr.registerDescriptor(descriptor)
    mgr.setCapabilityGrantResolver(() => ({
      packageVersion: descriptor.packageVersion!,
      system: ['fs', 'aiCli'],
      storage: true,
    }))
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'window-html-preview-')))
    try {
      const firstPath = join(workspacePath, 'first.html')
      const secondPath = join(workspacePath, 'second.html')
      writeFileSync(firstPath, '<p>first</p>')
      writeFileSync(secondPath, '<p>second</p>')
      const host = new FakeBrowserWindow()
      const contribution = descriptor.views![0]!.contributionKey
      const firstOpening = mgr.openContributionWindow(asHost(host), contribution, {
        workspacePath,
        query: `?workspace_path=${encodeURIComponent(workspacePath)}&filepath=forged.html&rel_path=stale.html&file_ws=/outside&file_grant=caller`,
        trustedEditorFileTarget: {
          path: firstPath,
          expectedCanonicalPath: realpathSync(firstPath),
          workspaceOnly: true,
        },
      })
      const view = host.children[0] as FakeViewLike
      view.webContents.emit('did-finish-load')
      await expect(firstOpening).resolves.toEqual({ ok: true })
      const bootstrap = new URLSearchParams(view.webContents.loads[0]!.split('?')[1])
      expect(bootstrap.get('filepath')).toBeNull()
      expect(bootstrap.get('file_ws')).toBeNull()
      expect(bootstrap.get('file_grant')).toBeNull()
      view.webContents.emit('did-finish-load')
      const firstTarget = view.webContents.sent.at(-1)?.args[0] as Record<string, string>
      expect(firstTarget).toMatchObject({ filepath: realpathSync(firstPath) })
      expect(firstTarget.file_ws).toBeUndefined()
      expect(firstTarget.file_grant).toBeUndefined()
      expect(firstTarget.rel_path).toBeUndefined()

      await expect(mgr.openContributionWindow(asHost(host), contribution, {
        workspacePath,
        query: `?workspace_path=${encodeURIComponent(workspacePath)}&filepath=forged-second.html&file_ws=/outside&file_grant=caller-second`,
        trustedEditorFileTarget: {
          path: secondPath,
          expectedCanonicalPath: realpathSync(secondPath),
          workspaceOnly: true,
        },
      })).resolves.toEqual({ ok: true })
      const reusedTarget = view.webContents.sent.at(-1)?.args[0] as Record<string, string>
      expect(reusedTarget).toMatchObject({ filepath: realpathSync(secondPath) })
      expect(reusedTarget.file_ws).toBeUndefined()
      expect(reusedTarget.file_grant).toBeUndefined()

      const stalePath = join(workspacePath, 'stale.html')
      const replacementPath = join(workspacePath, 'replacement.html')
      writeFileSync(stalePath, '<p>stale</p>')
      writeFileSync(replacementPath, '<p>replacement</p>')
      const expectedStalePath = realpathSync(stalePath)
      rmSync(stalePath)
      symlinkSync(replacementPath, stalePath)
      const sentBeforeStale = view.webContents.sent.length
      await expect(mgr.openContributionWindow(asHost(host), contribution, {
        workspacePath,
        query: `?workspace_path=${encodeURIComponent(workspacePath)}&filepath=stale.html`,
        trustedEditorFileTarget: {
          path: stalePath,
          expectedCanonicalPath: expectedStalePath,
          workspaceOnly: true,
        },
      })).resolves.toEqual({ ok: false, error: 'selected resource changed before opening' })
      expect(view.webContents.sent).toHaveLength(sentBeforeStale)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('refuses a preview target when the Plans window contribution is missing', async () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    await expect(mgr.openContributionWindow(
      asHost(host),
      'navide.plans.window',
      {
        workspacePath: '/workspace',
        query: '?workspace_path=%2Fworkspace&filepath=plan.html&file_grant=caller',
        trustedEditorFileTarget: {
          path: '/workspace/plan.html',
          workspaceOnly: true,
        },
      },
    )).resolves.toEqual({ ok: false, error: 'contribution is not installed' })
    expect(host.children).toHaveLength(0)
  })

  it('resolves stale catalog objects against the current registered package', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)

    const stalePackage: PluginLaunchDescriptor = {
      ...packageDesc,
      views: packageDesc.views!.map((view) => ({
        ...view,
        entryFile: '/plugins/stale/forged.html',
      })),
    }
    mgr.setCapabilityContext(packageDesc.id, null)

    const host = new FakeBrowserWindow()
    await mgr.openView(stalePackage, stalePackage.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
    })

    expect((host.children[0] as FakeViewLike).webContents.loads).toEqual([
      packageDesc.views![0].entryFile,
    ])
  })

  it('targets bounds, visibility, focus, and destruction by handle only', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()
    const left = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(hostA),
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    })
    const window = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(hostB),
      bounds: { x: 10, y: 20, width: 200, height: 150 },
    })
    const leftView = hostA.children[0] as FakeViewLike
    const windowView = hostB.children[0] as FakeViewLike

    mgr.setBounds(left.instanceId, { x: 1, y: 2, width: 300, height: 250 })
    expect(leftView.bounds).toEqual({ x: 1, y: 2, width: 300, height: 250 })
    expect(windowView.bounds).toEqual({ x: 10, y: 20, width: 200, height: 150 })

    mgr.deactivate(left.instanceId)
    expect(leftView.visible).toBe(false)
    expect(windowView.visible).toBe(true)
    const hostFocusBeforeActivate = hostA.focusCount
    const viewFocusBeforeActivate = leftView.webContents.focusCount
    mgr.activate(left.instanceId)
    expect(leftView.visible).toBe(true)
    expect(hostA.focusCount).toBe(hostFocusBeforeActivate)
    expect(leftView.webContents.focusCount).toBe(viewFocusBeforeActivate)

    mgr.focusInstance(left.instanceId)
    expect(hostA.focusCount).toBeGreaterThan(hostFocusBeforeActivate)
    expect(leftView.webContents.focusCount).toBeGreaterThan(viewFocusBeforeActivate)

    mgr.destroyInstance(left.instanceId)
    expect(leftView.webContents.isDestroyed()).toBe(true)
    expect(hostA.children).not.toContain(leftView)
    expect(windowView.webContents.isDestroyed()).toBe(false)
    expect(hostB.children).toContain(windowView)

    mgr.setBounds(window.instanceId, { x: 9, y: 8, width: 700, height: 600 })
    expect(windowView.bounds).toEqual({ x: 9, y: 8, width: 700, height: 600 })
  })

  it('cleans a dead v2 instance without disturbing its sibling', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()
    const left = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(hostA),
      bounds: 'fill',
    })
    const window = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(hostB),
      bounds: 'fill',
    })
    const leftView = hostA.children[0] as FakeViewLike
    const windowView = hostB.children[0] as FakeViewLike
    const staleSender = leftView.webContents.id

    leftView.webContents.close()

    expect(leftView.webContents.isDestroyed()).toBe(true)
    expect(hostA.children).not.toContain(leftView)
    expect(windowView.webContents.isDestroyed()).toBe(false)
    mgr.setBounds(window.instanceId, { x: 4, y: 5, width: 600, height: 400 })
    expect(windowView.bounds).toEqual({ x: 4, y: 5, width: 600, height: 400 })

    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()
    await expect(
      call!({ sender: { id: staleSender } }, { reqId: 'dead', ns: 'ping', method: 'ping', args: {} })
    ).resolves.toEqual({
      reqId: '',
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'unknown plugin sender' },
    })
    expect(window.instanceId).toBeTruthy()
  })

  it('does not let a child frame inherit the native sender identity', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const host = new FakeBrowserWindow()
    await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
    })
    const view = host.children[0] as FakeViewLike
    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()

    await expect(call!(
      {
        sender: { id: view.webContents.id },
        senderFrame: {
          isDestroyed: () => false,
          parent: {},
          frameTreeNodeId: 77,
          url: 'file:///unadmitted-child.html',
        },
      },
      { reqId: 'child-inherit', ns: 'ping', method: 'ping', args: {} },
    )).resolves.toEqual({
      reqId: '',
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'unknown plugin sender' },
    })
  })

  it('destroys every live instance when a package is removed', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()
    await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(hostA),
      bounds: 'fill',
    })
    await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(hostB),
      bounds: 'fill',
    })
    const leftView = hostA.children[0] as FakeViewLike
    const windowView = hostB.children[0] as FakeViewLike

    mgr.removeInstalledPlugin(packageDesc.id)

    expect(leftView.webContents.isDestroyed()).toBe(true)
    expect(windowView.webContents.isDestroyed()).toBe(true)
    expect(hostA.children).toHaveLength(0)
    expect(hostB.children).toHaveLength(0)
  })

  it('keeps v1 and v2 instances independent for the same package id', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const legacyHost = new FakeBrowserWindow()
    const v2Host = new FakeBrowserWindow()
    mgr.open(
      asHost(legacyHost),
      { id: packageDesc.id, requires: [], devUrl: '', entryFile: '/plugins/legacy/index.html' },
      'fill'
    )
    const legacyView = legacyHost.children[0] as FakeViewLike
    const v2 = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(v2Host),
      bounds: 'fill',
    })
    const v2View = v2Host.children[0] as FakeViewLike

    mgr.destroy(v2.instanceId)
    expect(v2View.webContents.isDestroyed()).toBe(false)
    mgr.destroyInstance(v2.instanceId)
    expect(legacyView.webContents.isDestroyed()).toBe(false)
    expect(v2View.webContents.isDestroyed()).toBe(true)

    mgr.destroy(packageDesc.id)
    expect(legacyView.webContents.isDestroyed()).toBe(true)
  })

  it('routes v2 events to their authenticated instance and audience', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = v2PackageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()
    const leftContext = v2Context({ audience: 'left-audience', sessionId: 'left-session' })
    const windowContext = v2Context({ audience: 'window-audience', sessionId: 'window-session' })
    const left = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(hostA),
      bounds: 'fill',
      capabilityContext: leftContext,
    })
    const window = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(hostB),
      bounds: 'fill',
      capabilityContext: windowContext,
    })
    const leftView = hostA.children[0] as FakeViewLike
    const windowView = hostB.children[0] as FakeViewLike

    const leftSource = { ...leftContext.runtimeBinding!, instanceId: left.instanceId }
    const windowSource = { ...windowContext.runtimeBinding!, instanceId: window.instanceId }
    mgr.dispatchPublicCapabilityEvent(
      packageDesc.id,
      'aiCli.output',
      { sessionId: 'left-session', data: 'left only' },
      leftSource
    )
    expect(eventsOf(leftView, 'aiCli.output')).toHaveLength(1)
    expect(eventsOf(windowView, 'aiCli.output')).toHaveLength(0)

    mgr.dispatchPublicCapabilityEvent(
      packageDesc.id,
      'aiCli.output',
      { sessionId: 'window-session', data: 'window only' },
      windowSource
    )
    expect(eventsOf(leftView, 'aiCli.output')).toHaveLength(1)
    expect(eventsOf(windowView, 'aiCli.output')).toHaveLength(1)

    // Shared backend fan-out carries no authenticated public-event source and
    // must not be treated as an AI CLI event source.
    dispatchEvent(mgr, 'aiCli.output', { sessionId: 'left-session', data: 'unbound' })
    expect(eventsOf(leftView, 'aiCli.output')).toHaveLength(1)

    mgr.dispatchPublicCapabilityEvent(
      packageDesc.id,
      'aiCli.output',
      { sessionId: 'left-session', data: 'stale' },
      { ...leftSource, instanceId: 'stale-instance' }
    )
    expect(eventsOf(leftView, 'aiCli.output')).toHaveLength(1)

    const fileEvent = { changes: [{ path: 'README.md', kind: 'changed' }] }
    mgr.dispatchPublicCapabilityEvent(packageDesc.id, 'workspace.filesChanged', fileEvent, {
      pluginId: HOST_EVENT_SOURCE_PLUGIN_ID,
      packageVersion: '1.0.0',
      workspaceId: 'workspace-1',
      instanceId: null,
      audience: null,
    })
    expect(eventsOf(leftView, 'workspace.filesChanged')).toHaveLength(1)
    expect(eventsOf(windowView, 'workspace.filesChanged')).toHaveLength(1)

    mgr.dispatchPublicCapabilityEvent(packageDesc.id, 'workspace.filesChanged', fileEvent, {
      pluginId: HOST_EVENT_SOURCE_PLUGIN_ID,
      packageVersion: '2.0.0',
      workspaceId: 'workspace-1',
      instanceId: null,
      audience: null,
    })
    expect(eventsOf(leftView, 'workspace.filesChanged')).toHaveLength(1)
    expect(eventsOf(windowView, 'workspace.filesChanged')).toHaveLength(1)
  })

  it('routes Mini-IDE PTY bytes to the public AI CLI event consumed by its panel', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDesc = v2PackageDescriptor(MINI_IDE_PLUGIN_ID)
      const context = v2Context({ pluginId: MINI_IDE_PLUGIN_ID, sessionId: 'mini-session' })
      mgr.registerDescriptor({ ...packageDesc, capabilityContext: context }, { official: true })
      const host = new FakeBrowserWindow()
      const handle = await mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(host),
        bounds: 'fill',
        capabilityContext: context,
      })
      const view = host.children[0] as FakeViewLike
      mgr.noteTerminalRoutes(handle.instanceId, 'terminal.create', {
        terminal_session_id: 'mini-session',
      })

      dispatchEvent(mgr, 'terminal.output', {
        terminal_session_id: 'mini-session',
        data: new TextEncoder().encode('PR133_FAKE_CODEX_READY'),
      })
      vi.advanceTimersByTime(12)
      expect(eventsOf(view, 'aiCli.output')).toEqual([{
        type: 'aiCli.output',
        data: { sessionId: 'mini-session', data: 'PR133_FAKE_CODEX_READY' },
      }])
      expect(eventsOf(view, 'terminal.output')).toHaveLength(0)

      dispatchEvent(mgr, 'terminal.exit', {
        terminal_session_id: 'mini-session',
        exit_code: 0,
      })
      expect(eventsOf(view, 'aiCli.exited')).toEqual([{
        type: 'aiCli.exited',
        data: { sessionId: 'mini-session', exitCode: 0 },
      }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('decodes public PTY bytes per session and flushes the UTF-8 tail before exit', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDesc = v2PackageDescriptor('navide.git')
      const context = v2Context({ pluginId: 'navide.git', sessionId: 'binary-session' })
      mgr.registerDescriptor({ ...packageDesc, capabilityContext: context }, { official: true })
      const host = new FakeBrowserWindow()
      const handle = await mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(host),
        bounds: 'fill',
        capabilityContext: context,
      })
      const view = host.children[0] as FakeViewLike
      mgr.noteTerminalRoutes(handle.instanceId, 'terminal.create', {
        terminal_session_id: 'binary-session',
      })

      dispatchEvent(mgr, 'terminal.output', {
        terminal_session_id: 'binary-session',
        data: new Uint8Array([0xe2]),
      })
      vi.advanceTimersByTime(12)
      expect(eventsOf(view, 'aiCli.output')).toHaveLength(0)

      dispatchEvent(mgr, 'terminal.output', {
        terminal_session_id: 'binary-session',
        data: new Uint8Array([0x82, 0xac]),
      })
      vi.advanceTimersByTime(12)
      expect(eventsOf(view, 'aiCli.output')).toContainEqual({
        type: 'aiCli.output',
        data: { sessionId: 'binary-session', data: '€' },
      })

      dispatchEvent(mgr, 'terminal.output', {
        terminal_session_id: 'binary-session',
        data: 'A',
      })
      dispatchEvent(mgr, 'terminal.output', {
        terminal_session_id: 'binary-session',
        data: new Uint8Array([0xe2, 0x82, 0xac]),
      })
      vi.advanceTimersByTime(12)
      expect(eventsOf(view, 'aiCli.output')).toContainEqual({
        type: 'aiCli.output',
        data: { sessionId: 'binary-session', data: 'A€' },
      })

      dispatchEvent(mgr, 'terminal.output', {
        terminal_session_id: 'binary-session',
        data: new Uint8Array([0xe2]),
      })
      vi.advanceTimersByTime(12)
      dispatchEvent(mgr, 'terminal.exit', {
        terminal_session_id: 'binary-session',
        exit_code: 0,
      })
      expect(eventsOf(view, 'aiCli.output')).toContainEqual({
        type: 'aiCli.output',
        data: { sessionId: 'binary-session', data: '�' },
      })
      expect(eventsOf(view, 'aiCli.exited')).toContainEqual({
        type: 'aiCli.exited',
        data: { sessionId: 'binary-session', exitCode: 0 },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not route workspace events across packages sharing version and workspace', async () => {
    const mgr = new FrontendPluginManager()
    const firstPackage = v2PackageDescriptor('acme.files-one')
    const secondPackage = v2PackageDescriptor('acme.files-two')
    mgr.registerDescriptor(firstPackage)
    mgr.registerDescriptor(secondPackage)
    const firstHost = new FakeBrowserWindow()
    const secondHost = new FakeBrowserWindow()

    await mgr.openView(firstPackage, firstPackage.views![0], {
      hostWindow: asHost(firstHost),
      bounds: 'fill',
      capabilityContext: v2Context({ pluginId: firstPackage.id }),
    })
    await mgr.openView(secondPackage, secondPackage.views![0], {
      hostWindow: asHost(secondHost),
      bounds: 'fill',
      capabilityContext: v2Context({ pluginId: secondPackage.id }),
    })

    const payload = { changes: [{ path: 'README.md', kind: 'changed' }] }
    mgr.dispatchPublicCapabilityEvent(firstPackage.id, 'workspace.filesChanged', payload, {
      pluginId: HOST_EVENT_SOURCE_PLUGIN_ID,
      packageVersion: '1.0.0',
      workspaceId: 'workspace-1',
      instanceId: null,
      audience: null,
    })

    expect(eventsOf(firstHost.children[0] as FakeViewLike, 'workspace.filesChanged')).toHaveLength(1)
    expect(eventsOf(secondHost.children[0] as FakeViewLike, 'workspace.filesChanged')).toHaveLength(0)
  })

  it('treats omitted and undefined context as the registry context, while null denies access', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = v2PackageDescriptor()
    const registryContext = v2Context({ audience: 'registry-audience', sessionId: 'registry-session' })
    mgr.registerDescriptor({ ...packageDesc, capabilityContext: registryContext })

    const omittedHost = new FakeBrowserWindow()
    const undefinedHost = new FakeBrowserWindow()
    const deniedHost = new FakeBrowserWindow()
    const omitted = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(omittedHost),
      bounds: 'fill',
    })
    const withUndefined = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(undefinedHost),
      bounds: 'fill',
      capabilityContext: undefined,
    })
    await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(deniedHost),
      bounds: 'fill',
      capabilityContext: null,
    })

    const source = (instanceId: string) => ({
      ...registryContext.runtimeBinding!,
      instanceId,
    })
    mgr.dispatchPublicCapabilityEvent(
      packageDesc.id,
      'aiCli.output',
      { sessionId: 'registry-session', data: 'allowed' },
      source(omitted.instanceId)
    )
    mgr.dispatchPublicCapabilityEvent(
      packageDesc.id,
      'aiCli.output',
      { sessionId: 'registry-session', data: 'also allowed' },
      source(withUndefined.instanceId)
    )

    expect(eventsOf(omittedHost.children[0] as FakeViewLike, 'aiCli.output')).toHaveLength(1)
    expect(eventsOf(undefinedHost.children[0] as FakeViewLike, 'aiCli.output')).toHaveLength(1)
    expect(eventsOf(deniedHost.children[0] as FakeViewLike, 'aiCli.output')).toHaveLength(0)
  })

  it('rejects an override whose package identity or grant version is not canonical', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = v2PackageDescriptor()
    mgr.registerDescriptor(packageDesc)

    for (const context of [
      v2Context({ pluginId: 'acme.other' }),
      v2Context({ packageVersion: '2.0.0' }),
      {
        ...v2Context(),
        userGrant: { packageVersion: '2.0.0', system: ['fs', 'aiCli'] as const },
      },
    ]) {
      await expect(
        mgr.openView(packageDesc, packageDesc.views![0], {
          hostWindow: asHost(new FakeBrowserWindow()),
          bounds: 'fill',
          capabilityContext: context,
        })
      ).rejects.toThrow(/context/i)
    }
  })

  it('validates v2 identity and rebinds context even under a legacy policy', async () => {
    const mgr = new FrontendPluginManager()
    const context = v2Context({ audience: 'legacy-policy-audience' })
    const packageDesc = { ...packageDescriptor(), capabilityContext: context }
    mgr.registerDescriptor(packageDesc)
    const host = new FakeBrowserWindow()

    mgr.open(asHost(host), packageDesc, 'fill')
    const legacyView = host.children[0] as FakeViewLike
    const running = (mgr as unknown as {
      running: Map<string, { instanceId: string; capabilityContext: HostCapabilityContext | null }>
    }).running
    const instance = [...running.values()].find(
      (candidate) => candidate.capabilityContext?.runtimeBinding?.audience === 'legacy-policy-audience'
    )
    expect(instance?.capabilityContext?.runtimeBinding?.instanceId).toBeTruthy()
    expect(instance?.capabilityContext?.runtimeBinding?.instanceId).not.toBe(
      context.runtimeBinding?.instanceId
    )
    expect(legacyView.webContents.isDestroyed()).toBe(false)
    expect(() =>
      mgr.open(
        asHost(host),
        { ...packageDesc, capabilityContext: v2Context({ pluginId: 'acme.other' }) },
        'fill'
      )
    ).toThrow(/context/i)

    await expect(
      mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(new FakeBrowserWindow()),
        bounds: 'fill',
        capabilityContext: v2Context({ packageVersion: '2.0.0' }),
      })
    ).rejects.toThrow(/context/i)
  })

  it('keeps v2 PTY restrictions when opened through the legacy adapter', () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = v2PackageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const host = new FakeBrowserWindow()

    mgr.open(asHost(host), packageDesc, 'fill')
    mgr.noteTerminalRoutes(packageDesc.id, 'terminal.create', {
      terminal_session_id: 'legacy-open-v2-session',
    })

    expect(
      mgr.filterTerminalReattachPayload(packageDesc.id, {
        terminal_session_ids: ['legacy-open-v2-session', 'unknown'],
      }).terminal_session_ids
    ).toEqual(['legacy-open-v2-session'])

    mgr.setCapabilityContext(
      packageDesc.id,
      v2Context({ audience: 'changed-audience' })
    )

    expect(
      mgr.filterTerminalReattachPayload(packageDesc.id, {
        terminal_session_ids: ['legacy-open-v2-session', 'unknown'],
      }).terminal_session_ids
    ).toEqual([])
  })

  it('leaves the running context unchanged when a replacement context is invalid', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = v2PackageDescriptor()
    const context = v2Context({ audience: 'stable-audience', sessionId: 'stable-session' })
    mgr.registerDescriptor({ ...packageDesc, capabilityContext: context })
    const host = new FakeBrowserWindow()
    const handle = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
    })

    expect(() =>
      mgr.setCapabilityContext(packageDesc.id, v2Context({ packageVersion: '2.0.0' }))
    ).toThrow(/context/i)
    const source = { ...context.runtimeBinding!, instanceId: handle.instanceId }
    mgr.dispatchPublicCapabilityEvent(
      packageDesc.id,
      'aiCli.output',
      { sessionId: 'stable-session', data: 'unchanged' },
      source
    )
    expect(eventsOf(host.children[0] as FakeViewLike, 'aiCli.output')).toHaveLength(1)
  })

  it('updates session bindings without detaching a route with the same live tuple', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDesc = v2PackageDescriptor()
      const oldContext = v2Context({ audience: 'same-audience', sessionId: 'old-session' })
      mgr.registerDescriptor({ ...packageDesc, capabilityContext: oldContext })
      const host = new FakeBrowserWindow()
      const handle = await mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(host),
        bounds: 'fill',
      })
      mgr.noteTerminalRoutes(handle.instanceId, 'terminal.create', {
        terminal_session_id: 'stable-route',
      })

      const newContext = v2Context({ audience: 'same-audience', sessionId: 'new-session' })
      mgr.setCapabilityContext(packageDesc.id, newContext)
      dispatchEvent(mgr, 'terminal.output', output('stable-route', 'still attached'))
      vi.advanceTimersByTime(12)

      expect(eventsOf(host.children[0] as FakeViewLike, 'terminal.output')).toHaveLength(1)
      const source = { ...newContext.runtimeBinding!, instanceId: handle.instanceId }
      mgr.dispatchPublicCapabilityEvent(
        packageDesc.id,
        'aiCli.output',
        { sessionId: 'new-session', data: 'new binding reached the view' },
        source
      )
      expect(eventsOf(host.children[0] as FakeViewLike, 'aiCli.output')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('detaches routes when the tuple changes or the grant is revoked', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDesc = v2PackageDescriptor()
      const context = v2Context({ audience: 'original-audience' })
      mgr.registerDescriptor({ ...packageDesc, capabilityContext: context })
      const host = new FakeBrowserWindow()
      const handle = await mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(host),
        bounds: 'fill',
      })
      const view = host.children[0] as FakeViewLike
      mgr.noteTerminalRoutes(handle.instanceId, 'terminal.create', {
        terminal_session_id: 'detached-route',
      })

      mgr.setCapabilityContext(
        packageDesc.id,
        v2Context({ audience: 'new-audience' })
      )
      dispatchEvent(mgr, 'terminal.output', output('detached-route', 'must drop'))
      vi.advanceTimersByTime(12)
      expect(eventsOf(view, 'terminal.output')).toHaveLength(0)

      mgr.noteTerminalRoutes(handle.instanceId, 'terminal.reattach', {
        alive: ['detached-route'],
      })
      mgr.setCapabilityContext(packageDesc.id, {
        ...v2Context({ audience: 'new-audience' }),
        userGrant: null,
      })
      expect(
        mgr.filterTerminalReattachPayload(handle.instanceId, {
          terminal_session_ids: ['detached-route'],
        }).terminal_session_ids
      ).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an empty workspace or audience binding before mounting', async () => {
    for (const context of [
      v2Context({ workspaceId: '' }),
      v2Context({ audience: '' }),
    ]) {
      const mgr = new FrontendPluginManager()
      const packageDesc = v2PackageDescriptor()
      mgr.registerDescriptor({ ...packageDesc, capabilityContext: context })
      const host = new FakeBrowserWindow()
      await expect(
        mgr.openView(packageDesc, packageDesc.views![0], {
          hostWindow: asHost(host),
          bounds: 'fill',
        })
      ).rejects.toThrow(/context/i)
      expect(host.children).toHaveLength(0)
    }
  })

  it('drops a v2 instance batch without affecting a sibling', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDesc = v2PackageDescriptor()
      mgr.registerDescriptor(packageDesc)
      const hostA = new FakeBrowserWindow()
      const hostB = new FakeBrowserWindow()
      const left = await mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(hostA),
        bounds: 'fill',
        capabilityContext: v2Context({ audience: 'left-audience' }),
      })
      await mgr.openView(packageDesc, packageDesc.views![1], {
        hostWindow: asHost(hostB),
        bounds: 'fill',
        capabilityContext: v2Context({ audience: 'window-audience' }),
      })
      const leftView = hostA.children[0] as FakeViewLike
      const windowView = hostB.children[0] as FakeViewLike

      mgr.noteTerminalRoutes(left.instanceId, 'terminal.create', { terminal_session_id: 't-14-batch' })
      ;(
        mgr as unknown as {
          dispatchEvent(event: string, payload: unknown): void
        }
      ).dispatchEvent('terminal.output', {
        terminal_session_id: 't-14-batch',
        data: 'sibling output',
        sequence: 1,
      })
      leftView.webContents.close()
      vi.advanceTimersByTime(12)

      expect(leftView.webContents.isDestroyed()).toBe(true)
      expect(windowView.webContents.isDestroyed()).toBe(false)
      const outputs = windowView.webContents.sent
        .filter((message) => message.channel === 'plugin:cap:event')
        .map((message) => message.args[0] as { type: string; data: Record<string, unknown> })
        .filter((event) => event.type === 'terminal.output')
      expect(outputs).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reattaches a detached v2 PTY only with the full ownership tuple', async () => {
    vi.useFakeTimers()
    try {
      const mgr = new FrontendPluginManager()
      const packageDesc = v2PackageDescriptor()
      mgr.registerDescriptor(packageDesc)
      const originalHost = new FakeBrowserWindow()
      const siblingHost = new FakeBrowserWindow()
      const originalContext = v2Context({ audience: 'left-audience' })
      const siblingContext = v2Context({ audience: 'sibling-audience' })
      const original = await mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(originalHost),
        bounds: 'fill',
        capabilityContext: originalContext,
      })
      const sibling = await mgr.openView(packageDesc, packageDesc.views![1], {
        hostWindow: asHost(siblingHost),
        bounds: 'fill',
        capabilityContext: siblingContext,
      })
      const originalView = originalHost.children[0] as FakeViewLike
      const siblingView = siblingHost.children[0] as FakeViewLike
      mgr.noteTerminalRoutes(original.instanceId, 'terminal.create', {
        terminal_session_id: 't-v2-reconnect',
      })
      originalView.webContents.close()

      expect(
        mgr.filterTerminalReattachPayload(sibling.instanceId, {
          terminal_session_ids: ['t-v2-reconnect'],
        }).terminal_session_ids
      ).toEqual([])

      for (const context of [
        v2Context({ workspaceId: 'workspace-2', audience: 'left-audience' }),
        v2Context({ audience: 'other-audience' }),
      ]) {
        const wrongOwner = await mgr.openView(packageDesc, packageDesc.views![0], {
          hostWindow: asHost(new FakeBrowserWindow()),
          bounds: 'fill',
          capabilityContext: context,
        })
        expect(
          mgr.filterTerminalReattachPayload(wrongOwner.instanceId, {
            terminal_session_ids: ['t-v2-reconnect'],
          }).terminal_session_ids
        ).toEqual([])
      }

      const reopenedHost = new FakeBrowserWindow()
      const reopened = await mgr.openView(packageDesc, packageDesc.views![0], {
        hostWindow: asHost(reopenedHost),
        bounds: 'fill',
        capabilityContext: v2Context({ audience: 'left-audience' }),
      })
      expect(
        mgr.filterTerminalReattachPayload(reopened.instanceId, {
          terminal_session_ids: ['t-v2-reconnect', 'unknown'],
        }).terminal_session_ids
      ).toEqual(['t-v2-reconnect'])

      mgr.noteTerminalRoutes(reopened.instanceId, 'terminal.reattach', {
        alive: ['t-v2-reconnect'],
        dead: [],
      })
      dispatchEvent(mgr, 'terminal.output', output('t-v2-reconnect', 'reconnected'))
      vi.advanceTimersByTime(12)
      expect(eventsOf(reopenedHost.children[0] as FakeViewLike, 'terminal.output')).toHaveLength(1)
      expect(eventsOf(siblingView, 'terminal.output')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('disposes subscriptions for only the destroyed instance', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const left = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(new FakeBrowserWindow()),
      bounds: 'fill',
    })
    const sibling = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(new FakeBrowserWindow()),
      bounds: 'fill',
    })
    const leftDispose = vi.fn()
    const siblingDispose = vi.fn()
    const unregisterLeft = mgr.registerInstanceSubscription(left.instanceId, leftDispose)
    mgr.registerInstanceSubscription(sibling.instanceId, siblingDispose)

    unregisterLeft()
    expect(leftDispose).toHaveBeenCalledTimes(1)

    mgr.destroyInstance(left.instanceId)

    expect(leftDispose).toHaveBeenCalledTimes(1)
    expect(siblingDispose).not.toHaveBeenCalled()
  })

  it('loads each v2 contribution entry file in renderer dev mode', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://renderer.test')
    try {
      const mgr = new FrontendPluginManager()
      const packageDesc = { ...packageDescriptor(), devUrl: 'http://package.test' }
      mgr.registerDescriptor(packageDesc)
      const host = new FakeBrowserWindow()

      await mgr.openView(packageDesc, packageDesc.views![1], {
        hostWindow: asHost(host),
        bounds: 'fill',
      })

      expect((host.children[0] as FakeViewLike).webContents.loads).toEqual([
        packageDesc.views![1].entryFile,
      ])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rejects unknown contribution keys and plugin-supplied or sibling instance ids', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc = packageDescriptor()
    mgr.registerDescriptor(packageDesc)
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()
    const left = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(hostA),
      bounds: 'fill',
    })
    const window = await mgr.openView(packageDesc, packageDesc.views![1], {
      hostWindow: asHost(hostB),
      bounds: 'fill',
    })
    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()

    await expect(
      mgr.openView(
        packageDesc,
        { ...packageDesc.views![0], contributionKey: 'acme.multi-view.spoof' },
        {
          hostWindow: asHost(new FakeBrowserWindow()),
          bounds: 'fill',
        }
      )
    ).rejects.toThrow(/not registered by the Host package descriptor/)

    const response = await call!(
      { sender: { id: (hostB.children[0] as FakeViewLike).webContents.id } },
      { reqId: 'spoofed', instanceId: left.instanceId, ns: 'ping', method: 'ping', args: {} }
    )
    expect(response).toEqual({
      reqId: 'spoofed',
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'instance identity is Host-owned' },
    })
    await expect(
      call!(
        { sender: { id: (hostB.children[0] as FakeViewLike).webContents.id } },
        { reqId: 'undefined-instance', instanceId: undefined, ns: 'ping', method: 'ping', args: {} }
      )
    ).resolves.toEqual({
      reqId: 'undefined-instance',
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'instance identity is Host-owned' },
    })
    expect(window.instanceId).not.toBe(left.instanceId)

    const staleSender = (hostB.children[0] as FakeViewLike).webContents.id
    mgr.destroyInstance(window.instanceId)
    await expect(
      call!({ sender: { id: staleSender } }, { reqId: 'stale', ns: 'ping', method: 'ping', args: {} })
    ).resolves.toEqual({
      reqId: '',
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'unknown plugin sender' },
    })
  })

  it('rebinds v2 capability context to the Host-generated instance', async () => {
    const mgr = new FrontendPluginManager()
    const packageDesc: PluginLaunchDescriptor = {
      ...packageDescriptor(),
      id: 'acme.runtime-view',
      requires: ['shell'],
      capabilityPolicy: manifestV2CapabilityPolicy({ shell: 'allowlist' }),
      capabilityContext: {
        publisherEligible: false,
        userGrant: { packageVersion: '1.0.0', system: [], shell: 'allowlist' },
        runtimeBinding: {
          pluginId: 'acme.runtime-view',
          packageVersion: '1.0.0',
          workspaceId: 'workspace-1',
          instanceId: 'plugin-supplied-instance',
          audience: 'audience-1',
        },
      },
    }
    mgr.registerDescriptor(packageDesc)
    const host = new FakeBrowserWindow()
    const handle = await mgr.openView(packageDesc, packageDesc.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
    })
    const plans: unknown[] = []
    mgr.setPublicCapabilityHandler((plan) => {
      plans.push(plan)
      return { accepted: true }
    })
    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()

    const response = await call!(
      { sender: { id: (host.children[0] as FakeViewLike).webContents.id } },
      { reqId: 'r1', ns: 'shell', method: 'run', args: { command: 'git status' } }
    )
    expect(response).toMatchObject({ ok: true, result: { accepted: true } })
    expect(plans[0]).toMatchObject({ runtime: { instanceId: handle.instanceId } })
    expect(plans[0]).not.toMatchObject({ runtime: { instanceId: 'plugin-supplied-instance' } })
  })
})

describe('terminal PTY routing + output micro-batching', () => {
  const CAP_EVENT = 'plugin:cap:event'

  interface DispatchSeam {
    dispatchEvent(event: string, payload: unknown): void
  }

  function dispatch(mgr: FrontendPluginManager, event: string, payload: unknown): void {
    ;(mgr as unknown as DispatchSeam).dispatchEvent(event, payload)
  }

  function eventsOf(
    view: FakeViewLike,
    type: string
  ): Array<{ type: string; data: Record<string, unknown> }> {
    return view.webContents.sent
      .filter((m) => m.channel === CAP_EVENT)
      .map((m) => m.args[0] as { type: string; data: Record<string, unknown> })
      .filter((e) => e.type === type)
  }

  function openTerminalPlugin(
    mgr: FrontendPluginManager,
    host: FakeBrowserWindow,
    id: string,
    requires: string[] = ['terminal']
  ): FakeViewLike {
    const before = views.length
    mgr.open(
      asHost(host),
      { id, requires, devUrl: '', entryFile: `/plugins/${id}/index.html` },
      { x: 0, y: 0, width: 10, height: 10 }
    )
    return views.length > before ? views[views.length - 1] : views[before - 1]
  }

  function output(id: string, data: string, sequence = 1): Record<string, unknown> {
    return { terminal_session_id: id, pane_id: 'p', sequence, data, stream: 'stdout' }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers batched output ONLY to the plugin whose create bound the session', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')

    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })
    dispatch(mgr, 'terminal.output', output('t-1', 'hi'))
    vi.advanceTimersByTime(12)

    expect(eventsOf(viewA, 'terminal.output')).toHaveLength(1)
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0)
  })

  it('coalesces an output burst into one IPC send with concatenated data', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openTerminalPlugin(mgr, host, 'acme.term-a')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })

    dispatch(mgr, 'terminal.output', output('t-1', 'he', 1))
    dispatch(mgr, 'terminal.output', output('t-1', 'll', 2))
    dispatch(mgr, 'terminal.output', output('t-1', 'o', 3))
    expect(eventsOf(view, 'terminal.output')).toHaveLength(0) // still batching
    vi.advanceTimersByTime(12)

    const got = eventsOf(view, 'terminal.output')
    expect(got).toHaveLength(1)
    expect(got[0].data.data).toBe('hello')
    expect(got[0].data.sequence).toBe(3) // last event's fields ride along
  })

  it('flushes pending output before terminal.exit and retires the route', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })

    dispatch(mgr, 'terminal.output', output('t-1', 'bye'))
    dispatch(mgr, 'terminal.exit', { terminal_session_id: 't-1', exit_code: 0 })

    // Output landed BEFORE exit despite the batch window (ordering barrier).
    const all = viewA.webContents.sent
      .filter((m) => m.channel === CAP_EVENT)
      .map((m) => (m.args[0] as { type: string }).type)
    expect(all).toEqual(['terminal.output', 'terminal.exit'])
    expect(eventsOf(viewB, 'terminal.exit')).toHaveLength(0)

    // The route is gone: later output for the id is DROPPED (never fanned out).
    dispatch(mgr, 'terminal.output', output('t-1', 'late'))
    vi.advanceTimersByTime(12)
    expect(eventsOf(viewA, 'terminal.output')).toHaveLength(1) // just the flush
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0)
  })

  it('drops output/exit for sessions no plugin bound (no fan-out)', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')

    dispatch(mgr, 'terminal.output', output('t-9', 'orphan'))
    dispatch(mgr, 'terminal.exit', { terminal_session_id: 't-9', exit_code: 0 })
    vi.advanceTimersByTime(12)

    expect(eventsOf(viewA, 'terminal.output')).toHaveLength(0)
    expect(eventsOf(viewA, 'terminal.exit')).toHaveLength(0)
  })

  it('registers every alive session from a reattach response', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-b', 'terminal.reattach', { alive: ['t-1', 't-2'], dead: [] })

    dispatch(mgr, 'terminal.output', output('t-1', 'a'))
    dispatch(mgr, 'terminal.output', output('t-2', 'b'))
    vi.advanceTimersByTime(12)

    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(2)
    expect(eventsOf(viewA, 'terminal.output')).toHaveLength(0)
  })

  it('destroy drops pending batches and keeps the route marked — output never leaks', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })

    dispatch(mgr, 'terminal.output', output('t-1', 'secret'))
    mgr.destroy('acme.term-a')
    vi.advanceTimersByTime(12)
    // The dead view's pending batch is dropped, never fanned out to others.
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0)

    // The route entry is RETAINED with the dead owner: later output for the id
    // is dropped, not delivered to unrelated plugins.
    dispatch(mgr, 'terminal.output', output('t-1', 'later'))
    vi.advanceTimersByTime(12)
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0)
  })

  it('a renderer crash runs the same terminal teardown as destroy()', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })

    dispatch(mgr, 'terminal.output', output('t-1', 'secret'))
    viewA.webContents.close() // crash path — fires the 'destroyed' hook
    vi.advanceTimersByTime(12)
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0) // batch dropped

    // Route retained: the crashed plugin's session is still owned by it, so a
    // sibling's reattach may not claim it (see the filter test below).
    const filtered = mgr.filterTerminalReattachPayload('acme.term-b', {
      terminal_session_ids: ['t-1'],
      cols: 0,
      rows: 0,
    })
    expect(filtered.terminal_session_ids).toEqual([])
  })

  it('re-claim after teardown: the SAME plugin reattaches and delivery resumes', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    openTerminalPlugin(mgr, host, 'acme.term-a')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })
    mgr.destroy('acme.term-a')

    // A stale sender cannot use the retained route as an authentication token.
    expect(
      mgr.filterTerminalReattachPayload('acme.term-a', {
        terminal_session_ids: ['t-1'],
      }).terminal_session_ids
    ).toEqual([])

    // Reopened view of the same plugin: its own retained id passes the filter…
    const reopened = openTerminalPlugin(mgr, host, 'acme.term-a')
    const payload = mgr.filterTerminalReattachPayload('acme.term-a', {
      terminal_session_ids: ['t-1'],
    })
    expect(payload.terminal_session_ids).toEqual(['t-1'])

    // …and after the reattach response re-registers, delivery resumes.
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.reattach', { alive: ['t-1'], dead: [] })
    dispatch(mgr, 'terminal.output', output('t-1', 'back'))
    vi.advanceTimersByTime(12)
    expect(eventsOf(reopened, 'terminal.output')).toHaveLength(1)
  })

  it('reattach filter strips ids owned by another plugin, keeps own and unknown ids', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    openTerminalPlugin(mgr, host, 'acme.term-a')
    openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-a' })
    mgr.noteTerminalRoutes('acme.term-b', 'terminal.create', { terminal_session_id: 't-b' })

    const payload = mgr.filterTerminalReattachPayload('acme.term-b', {
      terminal_session_ids: ['t-a', 't-b', 't-unknown'],
      cols: 80,
      rows: 24,
    })
    // The live sibling's session is stripped; own + never-seen ids pass
    // (never-seen covers app-restart re-claims and non-broker PTYs).
    expect(payload.terminal_session_ids).toEqual(['t-b', 't-unknown'])
    expect(payload.cols).toBe(80) // other fields untouched

    // A payload without an ids array passes through unchanged.
    const untouched = { cols: 80 }
    expect(mgr.filterTerminalReattachPayload('acme.term-b', untouched)).toBe(untouched)

    const fresh = openTerminalPlugin(mgr, host, 'acme.term-fresh')
    expect(
      mgr.filterTerminalReattachPayload('acme.term-fresh', {
        terminal_session_ids: ['after-host-restart'],
      }).terminal_session_ids
    ).toEqual(['after-host-restart'])
    expect(fresh.webContents.isDestroyed()).toBe(false)
  })

  it('cancels an in-flight create and kills a late committed success exactly once', async () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openTerminalPlugin(mgr, host, 'acme.term-pending')
    mgr.setBackendWsUrl('ws://plugin-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()

    const create = call!({ sender: { id: view.webContents.id } }, {
      reqId: 'create',
      ns: 'terminal',
      method: 'create',
      args: { pane_id: 'pane-pending', create_generation: 'generation-1' },
    }) as Promise<unknown>
    await Promise.resolve()
    const createRequest = JSON.parse(socket.sent.at(-1)!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(createRequest.type).toBe('terminal.create')

    mgr.destroy('acme.term-pending')
    const cancelRequest = JSON.parse(socket.sent.at(-1)!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(cancelRequest.type).toBe('terminal.create.cancel')
    expect(cancelRequest.payload).toEqual({
      pane_id: 'pane-pending',
      create_generation: 'generation-1',
    })
    expect(socket.sent.map((raw) => JSON.parse(raw).type)).not.toContain('terminal.kill')

    socket.receive({
      id: cancelRequest.id,
      type: 'terminal.create.cancel',
      ok: true,
      payload: { cancelled: false },
      error: null,
      timestamp: '',
    })
    socket.receive({
      id: createRequest.id,
      type: 'terminal.create',
      ok: true,
      payload: {
        terminal_session_id: 'late-session',
        pane_id: 'pane-pending',
        create_generation: 'generation-1',
      },
      error: null,
      timestamp: '',
    })
    await expect(create).resolves.toMatchObject({ ok: true })

    const killRequests = socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> })
      .filter((request) => request.type === 'terminal.kill')
    expect(killRequests).toHaveLength(1)
    expect(killRequests[0].payload).toEqual({
      terminal_session_id: 'late-session',
      force: true,
    })

    // A duplicate late response cannot trigger a second cleanup request.
    socket.receive({
      id: createRequest.id,
      type: 'terminal.create',
      ok: true,
      payload: {
        terminal_session_id: 'late-session',
        pane_id: 'pane-pending',
        create_generation: 'generation-1',
      },
      error: null,
      timestamp: '',
    })
    expect(
      socket.sent.map((raw) => JSON.parse(raw).type).filter((type) => type === 'terminal.kill')
    ).toHaveLength(1)

    dispatch(mgr, 'terminal.output', output('late-session', 'must drop'))
    vi.advanceTimersByTime(12)
    expect(eventsOf(view, 'terminal.output')).toHaveLength(0)
    expect(
      mgr.filterTerminalReattachPayload('acme.term-pending', {
        terminal_session_ids: ['late-session'],
      }).terminal_session_ids
    ).toEqual([])
  })

  it('does not kill a late create response with invalid ownership metadata', async () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openTerminalPlugin(mgr, host, 'acme.term-invalid-late')
    mgr.setBackendWsUrl('ws://plugin-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()

    const create = call!({ sender: { id: view.webContents.id } }, {
      reqId: 'create-invalid-late',
      ns: 'terminal',
      method: 'create',
      args: { pane_id: 'pane-invalid-late', create_generation: 'generation-invalid-late' },
    }) as Promise<unknown>
    await Promise.resolve()
    const createRequest = JSON.parse(socket.sent.at(-1)!) as { id: string }
    mgr.destroy('acme.term-invalid-late')
    const cancelRequest = JSON.parse(socket.sent.at(-1)!) as { id: string }

    socket.receive({
      id: cancelRequest.id,
      type: 'terminal.create.cancel',
      ok: true,
      payload: { cancelled: false },
      error: null,
      timestamp: '',
    })
    socket.receive({
      id: createRequest.id,
      type: 'terminal.create',
      ok: true,
      payload: {
        terminal_session_id: 42,
        pane_id: 'pane-invalid-late',
        create_generation: 'generation-invalid-late',
      },
      error: null,
      timestamp: '',
    })
    await expect(create).resolves.toMatchObject({ ok: true })
    expect(socket.sent.map((raw) => JSON.parse(raw).type)).not.toContain('terminal.kill')
  })

  it('invalidates an in-flight reattach without sending a kill or reviving its routes', async () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openTerminalPlugin(mgr, host, 'acme.term-reattach')
    mgr.setBackendWsUrl('ws://plugin-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()

    const reattach = call!({ sender: { id: view.webContents.id } }, {
      reqId: 'reattach',
      ns: 'terminal',
      method: 'reattach',
      args: { terminal_session_ids: ['late-session'] },
    }) as Promise<unknown>
    await Promise.resolve()
    const request = JSON.parse(socket.sent.at(-1)!) as { id: string; type: string }
    expect(request.type).toBe('terminal.reattach')
    mgr.destroy('acme.term-reattach')
    expect(socket.sent.map((raw) => JSON.parse(raw).type)).not.toContain('terminal.kill')

    socket.receive({
      id: request.id,
      type: 'terminal.reattach',
      ok: true,
      payload: { alive: ['late-session'], dead: [] },
      error: null,
      timestamp: '',
    })
    await expect(reattach).resolves.toMatchObject({ ok: true })
    dispatch(mgr, 'terminal.output', output('late-session', 'must drop'))
    vi.advanceTimersByTime(12)
    expect(eventsOf(view, 'terminal.output')).toHaveLength(0)
  })
})

describe('cast channel (IPC_CAST / handleCast)', () => {
  function openPlugin(
    mgr: FrontendPluginManager,
    host: FakeBrowserWindow,
    id: string,
    requires: string[]
  ): FakeViewLike {
    const before = views.length
    mgr.open(
      asHost(host),
      { id, requires, devUrl: '', entryFile: `/plugins/${id}/index.html` },
      { x: 0, y: 0, width: 10, height: 10 }
    )
    return views.length > before ? views[views.length - 1] : views[before - 1]
  }

  function castPayload(ns: string, method: string): Record<string, unknown> {
    return { ns, method, args: { terminal_session_id: 't-1', data: 'x' }, reqId: 'r1' }
  }

  it('accepts whitelisted casts from a known sender (terminal.input / log_sent)', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.term', ['terminal'])
    mgr.noteTerminalRoutes('acme.term', 'terminal.create', { terminal_session_id: 't-1' })
    // No backend transport in tests — reaching 'no-backend' proves the cast
    // passed sender, shape, scoping AND the whitelist.
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'input'), view.webContents.mainFrame as never)).toBe('no-backend')
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'log_sent'), view.webContents.mainFrame as never)).toBe(
      'no-backend'
    )
  })

  it('rejects non-whitelisted backend types (mirror of the shim CAST_TYPES)', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.term', ['terminal'])
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'resize'), view.webContents.mainFrame as never)).toBe(
      'not-castable'
    )
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'kill'), view.webContents.mainFrame as never)).toBe(
      'not-castable'
    )
  })

  it('rejects casts for namespaces the manifest never granted', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.fsonly', ['fs'])
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'input'), view.webContents.mainFrame as never)).toBe('denied')
  })

  it('rejects terminal request controls from a sibling route owner', async () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const owner = openPlugin(mgr, host, 'acme.term-owner', ['terminal'])
    const sibling = openPlugin(mgr, host, 'acme.term-sibling', ['terminal'])
    mgr.noteTerminalRoutes('acme.term-owner', 'terminal.create', { terminal_session_id: 't-owner' })
    const call = ipcHandlers.get('plugin:cap:call')
    expect(call).toBeDefined()

    await expect(
      call!({ sender: { id: sibling.webContents.id } }, {
        reqId: 'foreign',
        ns: 'terminal',
        method: 'resize',
        args: { terminal_session_id: 't-owner', cols: 80, rows: 24 },
      })
    ).resolves.toEqual({
      reqId: 'foreign',
      ok: false,
      error: { code: 'CAPABILITY_DENIED', message: 'terminal session is not owned by this view' },
    })
    expect(owner.webContents.isDestroyed()).toBe(false)
  })

  it('rejects unmapped methods, unknown senders and malformed payloads', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.term', ['terminal'])
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'nope'), view.webContents.mainFrame as never)).toBe('unmapped')
    expect(mgr.handleCast(999999, castPayload('terminal', 'input'))).toBe('unknown-sender')
    expect(mgr.handleCast(view.webContents.id, { nope: true }, view.webContents.mainFrame as never)).toBe('malformed')
  })

  it('is wired to the plugin:cap:cast IPC channel', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.term', ['terminal'])
    const cast = ipcListeners.get('plugin:cap:cast')
    expect(cast).toBeDefined()
    expect(() =>
      cast!({ sender: { id: view.webContents.id } }, castPayload('terminal', 'input'))
    ).not.toThrow()
  })
})

describe('mini-IDE dedicated window (openMiniIdePluginView)', () => {
  // These tests exercise the module-level singleton + dedicated-window path, so
  // each test must close the live window (module state resets via 'closed').
  beforeEach(() => {
    frontendPluginManager.registerDescriptor({
      id: MINI_IDE_PLUGIN_ID,
      requires: JSON.parse(readFileSync(resolve('src/renderer/plugins/mini-ide/plugin.json'), 'utf8')).requires,
      devUrl: '',
      entryFile: '/plugins/mini-ide/index.html',
    }, { builtin: true })
  })

  afterEach(() => {
    for (const win of windows) {
      if (!win.isDestroyed()) win.close()
    }
    frontendPluginManager.destroy(MINI_IDE_PLUGIN_ID)
    setPlatformId(BASELINE)
  })

  function lastWindow(): FakeWindowLike {
    return windows[windows.length - 1]
  }
  function lastView(): FakeViewLike {
    return views[views.length - 1]
  }

  it('creates a dedicated host window with the legacy editor options', async () => {
    // The hidden title bar is the macOS shape; other platforms get the system
    // frame (systemFrameUnlessMac), so pin the platform this test describes.
    setPlatformId('darwin')
    const winsBefore = windows.length
    const ok = await openMiniIdePluginView('/ws', 'http://h:1')
    expect(ok).toBe(true)
    expect(windows.length).toBe(winsBefore + 1)
    const win = lastWindow()
    expect(win.options).toMatchObject({
      width: 1100,
      height: 760,
      title: 'Mini-IDE',
      titleBarStyle: 'hidden',
      backgroundColor: '#0d1117',
    })
    // The view attaches to the dedicated window and fills its content bounds.
    const view = lastView()
    expect(win.children).toContain(view)
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
  })

  it('delivers Host language changes to an already open Mini-IDE through its shipped ui capability', async () => {
    await openMiniIdePluginView('/ws', '', { locale: 'en-US' })
    const view = lastView()
    view.webContents.emit('did-finish-load')
    view.webContents.sent.length = 0
    for (const locale of ['ja-JP', 'en-US']) {
      frontendPluginManager.dispatchHostSettingsChanged({ settings: { 'agent-team:language': locale } })
      expect(view.webContents.sent.at(-1)).toEqual({
        channel: 'plugin:cap:event',
        args: [{ type: 'ui.settings_changed', data: { source: 'host', settings: { 'agent-team:language': locale } } }],
      })
    }
  })

  it('passes Japanese into the initial editor query and reuses the view for language changes', async () => {
    await openMiniIdePluginView('/ws', '', { locale: 'ja-JP', filepath: 'a.ts' }, 'light')
    const view = lastView()
    expect(view.webContents.loads[0]).toContain('locale=ja-JP')
    view.webContents.emit('did-finish-load')
    await openMiniIdePluginView('/ws', '', { locale: 'en-US', filepath: 'b.ts' }, 'light')
    expect(lastView()).toBe(view)
    expect(view.webContents.loads).toHaveLength(1)
    expect(view.webContents.sent.filter(message => message.channel === 'plugin:openTarget').at(-1)?.args[0])
      .toMatchObject({ locale: 'en-US', filepath: 'b.ts' })
  })

  it('passes the current theme in the entry query', async () => {
    await openMiniIdePluginView('/ws', '', {}, 'light')
    expect(lastView().webContents.loads[0]).toContain('theme=light')
  })

  it('mirrors the plugin page title onto the dedicated host window', async () => {
    await openMiniIdePluginView('/ws', 'http://h:1')
    const win = lastWindow()
    // The host's own webContents is blank; without mirroring the window would
    // keep its creation-time title in the macOS Window menu forever.
    expect(win.title).toBe('Mini-IDE')
    lastView().webContents.emit('page-title-updated', {}, 'main.ts — Mini-IDE')
    expect(win.title).toBe('main.ts — Mini-IDE')
  })

  it('ignores an empty page title so the window keeps its feature name', async () => {
    await openMiniIdePluginView('/ws', 'http://h:1')
    const win = lastWindow()
    lastView().webContents.emit('page-title-updated', {}, '')
    expect(win.title).toBe('Mini-IDE')
  })

  it('reopen restores and focuses the dedicated window without reloading', async () => {
    await openMiniIdePluginView('/ws', '', {}, 'light')
    const win = lastWindow()
    const view = lastView()
    view.webContents.emit('did-finish-load')
    win.minimized = true

    const winsBefore = windows.length
    await openMiniIdePluginView('/ws', '', { filepath: 'a.ts' }, 'light')
    expect(windows.length).toBe(winsBefore) // same window reused
    expect(win.minimized).toBe(false)
    expect(win.focusCount).toBeGreaterThan(0)
    expect(view.webContents.loads).toHaveLength(1) // no reload
    const targets = view.webContents.sent.filter((m) => m.channel === 'plugin:openTarget')
    expect(targets).toHaveLength(1)
    expect(targets[0].args[0]).toMatchObject({ workspace_path: '/ws', filepath: 'a.ts' })
  })

  it('a theme change alone does not reload the running view', async () => {
    await openMiniIdePluginView('/ws', '', {}, 'light')
    const view = lastView()
    view.webContents.emit('did-finish-load')

    await openMiniIdePluginView('/ws', '', {}, 'dark-github')
    expect(view.webContents.loads).toHaveLength(1) // still the first load
  })

  it('hideSelf closes the dedicated window and tears the view down', async () => {
    await openMiniIdePluginView('/ws')
    const win = lastWindow()
    const view = lastView()

    const hide = ipcListeners.get('plugin:hideSelf')
    expect(hide).toBeDefined()
    hide!({ sender: { id: view.webContents.id } })
    expect(win.destroyed).toBe(true)
    expect(view.webContents.isDestroyed()).toBe(true)
  })

  it('close then reopen recreates the window and view cleanly', async () => {
    await openMiniIdePluginView('/ws')
    const win1 = lastWindow()
    win1.close()

    const winsBefore = windows.length
    const viewsBefore = views.length
    const ok = await openMiniIdePluginView('/ws')
    expect(ok).toBe(true)
    expect(windows.length).toBe(winsBefore + 1) // fresh window
    expect(views.length).toBe(viewsBefore + 1) // fresh view
    expect(lastWindow()).not.toBe(win1)
    expect(lastView().webContents.loads).toHaveLength(1)
  })

  it('rejects a recovery target whose canonical path changed before grant minting', async () => {
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'mini-recovery-target-')))
    try {
      const targetPath = join(workspacePath, 'target.ts')
      const replacementPath = join(workspacePath, 'replacement.ts')
      writeFileSync(targetPath, 'original')
      writeFileSync(replacementPath, 'replacement')
      const expectedCanonicalPath = realpathSync(targetPath)
      rmSync(targetPath)
      symlinkSync(replacementPath, targetPath)
      frontendPluginManager.setCapabilityContext(MINI_IDE_PLUGIN_ID, {
        publisherEligible: true,
        userGrant: { packageVersion: '1.0.0', system: ['fs'] },
        runtimeBinding: {
          pluginId: MINI_IDE_PLUGIN_ID,
          packageVersion: '1.0.0',
          workspaceId: 'legacy-workspace',
          instanceId: 'legacy-instance',
          audience: 'legacy-mini-ide',
        },
      })
      const viewsBefore = views.length
      const ok = await openMiniIdePluginView(
        workspacePath,
        '',
        { filepath: 'target.ts', file_ws: workspacePath },
        '',
        { trustedEditorFileTarget: { path: targetPath, expectedCanonicalPath } },
      )
      expect(ok).toBe(false)
      expect(views).toHaveLength(viewsBefore)
      expect(lastWindow().destroyed).toBe(true)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('withholds a legacy recovery target until the existing entry finishes loading', async () => {
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'mini-recovery-ready-')))
    const externalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mini-recovery-external-')))
    try {
      const targetPath = join(externalRoot, 'picked.html')
      writeFileSync(targetPath, '<p>picked</p>')
      frontendPluginManager.setCapabilityContext(MINI_IDE_PLUGIN_ID, {
        publisherEligible: true,
        userGrant: { packageVersion: '1.0.0', system: ['fs'] },
        runtimeBinding: {
          pluginId: MINI_IDE_PLUGIN_ID,
          packageVersion: '1.0.0',
          workspaceId: 'legacy-workspace',
          instanceId: 'legacy-instance',
          audience: 'legacy-mini-ide',
        },
      })
      expect(await openMiniIdePluginView(workspacePath)).toBe(true)
      const view = lastView()
      const reopening = openMiniIdePluginView(
        workspacePath,
        '',
        { filepath: 'picked.html', file_ws: externalRoot, file_grant: 'caller-grant' },
        '',
        {
          canDispatch: () => true,
          trustedEditorFileTarget: {
            path: targetPath,
            expectedCanonicalPath: realpathSync(targetPath),
          },
        },
      )
      expect(view.webContents.loads).toHaveLength(1)
      expect(view.webContents.sent.filter(({ channel }) => channel === 'plugin:openTarget')).toHaveLength(0)

      view.webContents.emit('did-finish-load')
      expect(await reopening).toBe(true)
      const target = view.webContents.sent.at(-1)
      expect(target?.channel).toBe('plugin:openTarget')
      const params = target?.args[0] as Record<string, string>
      expect(params.filepath).toBe('picked.html')
      expect(params.file_grant).toBeTruthy()
      expect(params.file_grant).not.toBe('caller-grant')
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(externalRoot, { recursive: true, force: true })
    }
  })
})

describe('ui.open_in_editor host capability — workspace containment / caller root', () => {
  const CALL = 'plugin:cap:call'

  /** Open a `ui`-granted view bound to /ws and return the call seam. */
  function openUiPlugin(): {
    mgr: FrontendPluginManager
    view: FakeViewLike
    opens: Array<Record<string, string>>
    call: (args: Record<string, unknown>) => Promise<{
      ok?: boolean
      result?: unknown
      error?: { code: string; message: string }
    }>
  } {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    mgr.open(
      asHost(host),
      {
        id: 'acme.viewer',
        requires: ['ui'],
        devUrl: '',
        entryFile: '/plugins/acme.viewer/index.html',
        query: '?workspace_path=/ws',
      },
      'fill'
    )
    const view = views[views.length - 1]
    const opens: Array<Record<string, string>> = []
    mgr.setOpenInEditorHandler((params) => {
      opens.push(params)
      return true
    })
    const handler = ipcHandlers.get(CALL)
    expect(handler).toBeDefined()
    return {
      mgr,
      view,
      opens,
      call: async (args) =>
        (await handler!({ sender: { id: view.webContents.id } }, {
          reqId: 'r1',
          ns: 'ui',
          method: 'open_in_editor',
          args,
        })) as { ok?: boolean; error?: { code: string; message: string } },
    }
  }

  it('uses the host-assigned workspace when the call names no root', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: 'src/app.ts' })
    expect(resp.error).toBeUndefined()
    expect(opens).toEqual([{ workspace_path: resolve('/ws'), filepath: join('src', 'app.ts') }])
  })

  it('rejects a traversal that escapes the workspace', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: '../../Users/neillu/.ssh/id_rsa' })
    expect(resp.error?.code).toBe('BAD_REQUEST')
    expect(opens).toEqual([])
  })

  it('rejects an absolute path outside the workspace', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: '/etc/passwd' })
    expect(resp.error?.code).toBe('BAD_REQUEST')
    expect(opens).toEqual([])
  })

  it('honours a call-supplied root', async () => {
    const { opens, call } = openUiPlugin()
    // Opening a file that lives outside the view's workspace: the caller names
    // the file's own root, and the target is normalized against it.
    const resp = await call({ workspace_path: '/elsewhere', filepath: 'notes/todo.md' })
    expect(resp.error).toBeUndefined()
    expect(opens).toEqual([{ workspace_path: resolve('/elsewhere'), filepath: join('notes', 'todo.md') }])
  })

  it('rejects a traversal that escapes a call-supplied root', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ workspace_path: '/elsewhere', filepath: '../secrets/key' })
    expect(resp.error?.code).toBe('BAD_REQUEST')
    expect(opens).toEqual([])
  })

  it('normalizes an absolute filepath against a call-supplied root', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ workspace_path: '/elsewhere', filepath: '/elsewhere/notes/todo.md' })
    expect(resp.error).toBeUndefined()
    expect(opens).toEqual([{ workspace_path: resolve('/elsewhere'), filepath: join('notes', 'todo.md') }])
  })

  it('normalizes an in-workspace path before handing it downstream', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: 'src/../README.md' })
    expect(resp.error).toBeUndefined()
    expect(opens).toEqual([{ workspace_path: resolve('/ws'), filepath: 'README.md' }])
  })

  it('rejects a bare workspace reference (no file to open)', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: '.' })
    expect(resp.error?.code).toBe('BAD_REQUEST')
    expect(opens).toEqual([])
  })
})

describe('Manifest v2 capability runtime deferral', () => {
  const CALL = 'plugin:cap:call'

  function openV2External(): {
    view: FakeViewLike
    opened: string[]
    call: (url: string) => Promise<{ ok?: boolean; error?: { code: string; message?: string } }>
  } {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    mgr.open(
      asHost(host),
      {
        id: 'acme.links',
        requires: ['ui'],
        capabilityPolicy: manifestV2CapabilityPolicy({ system: ['ui'] }),
        devUrl: '',
        entryFile: '/plugins/acme.links/index.html',
      },
      'fill'
    )
    const view = views[views.length - 1]
    const opened: string[] = []
    mgr.setHostShellHandlers({
      openExternal: async (url) => {
        opened.push(url)
        return { ok: true }
      },
      revealPath: () => ({ ok: true }),
      openWorkspace: () => ({ ok: true }),
      pickFolder: async () => null,
    })
    const handler = ipcHandlers.get(CALL)
    expect(handler).toBeDefined()
    return {
      view,
      opened,
      call: async (url) =>
        (await handler!({ sender: { id: view.webContents.id } }, {
          reqId: 'r1',
          ns: 'ui',
          method: 'open_external',
          args: { url },
        })) as { ok?: boolean; error?: { code: string; message?: string } },
    }
  }

  it('denies deferred v2 host capabilities before reaching the host', async () => {
    const { opened, call } = openV2External()
    expect((await call('https://example.com')).error?.code).toBe('CAPABILITY_DENIED')
    expect(opened).toEqual([])
  })

  it('passes an authenticated public plan to the Host-owned executor', async () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    mgr.open(
      asHost(host),
      {
        id: 'acme.shell',
        requires: ['shell'],
        capabilityPolicy: manifestV2CapabilityPolicy({ shell: 'allowlist' }),
        capabilityContext: {
          publisherEligible: false,
          userGrant: { packageVersion: '1.0.0', system: [], shell: 'allowlist' },
          runtimeBinding: {
            pluginId: 'acme.shell',
            packageVersion: '1.0.0',
            workspaceId: 'workspace-1',
            instanceId: 'instance-1',
            audience: 'audience-1',
          },
        },
        devUrl: '',
        entryFile: '/plugins/acme.shell/index.html',
      },
      'fill'
    )
    const view = views[views.length - 1]
    const plans: unknown[] = []
    mgr.setPublicCapabilityHandler((plan) => {
      plans.push(plan)
      return { accepted: true }
    })
    const handler = ipcHandlers.get(CALL)
    expect(handler).toBeDefined()
    const response = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'r1',
      ns: 'shell',
      method: 'run',
      args: { command: 'git status' },
    })
    expect(response).toMatchObject({ ok: true, result: { accepted: true } })
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ kind: 'public', address: 'shell.run' })

    mgr.setPublicCapabilityHandler(() => {
      throw new Error('sensitive host detail')
    })
    const failed = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'r2',
      ns: 'shell',
      method: 'run',
      args: { command: 'git status' },
    })
    expect(failed).toEqual({
      reqId: 'r2',
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'public capability failed' },
    })
  })

  it('routes an authorized storage call to the durable storage seam', async () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const storageSnapshots = new Map<StorageSnapshotTier, string>([
      ['candidate', '2.0.0'],
      ['active', '1.0.0'],
      ['previous', '0.9.0'],
    ])
    mgr.open(
      asHost(host),
      {
        id: 'acme.storage',
        packageVersion: '1.0.0',
        requires: [],
        capabilityPolicy: manifestV2CapabilityPolicy({ system: [] }),
        capabilityContext: {
          publisherEligible: false,
          userGrant: { packageVersion: '1.0.0', system: [], storage: true },
          runtimeBinding: {
            pluginId: 'acme.storage',
            packageVersion: '1.0.0',
            workspaceId: 'workspace-1',
            instanceId: 'instance-1',
            audience: 'audience-1',
          },
          storageSnapshots,
          storageSnapshotTier: 'active',
        },
        devUrl: '',
        entryFile: '/plugins/acme.storage/index.html',
        views: [
          {
            id: 'main',
            contributionKey: 'acme.storage.main',
            kind: 'custom',
            location: 'main',
            title: 'Storage',
            entryFile: '/plugins/acme.storage/index.html',
          },
        ],
      },
      'fill'
    )
    const view = views[views.length - 1]
    const executions: unknown[] = []
    mgr.setPublicStorageHandler((execution) => {
      executions.push(execution)
      return null
    })
    const handler = ipcHandlers.get(CALL)
    expect(handler).toBeDefined()

    const response = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'storage-1',
      ns: 'storage',
      method: 'set',
      args: { scope: 'workspace', key: 'layout', value: { compact: true } },
    })
    expect(response).toEqual({ reqId: 'storage-1', ok: true, result: null })
    expect(executions[0]).toMatchObject({
      address: 'storage.set',
      partition: { pluginId: 'acme.storage', workspaceId: 'workspace-1', key: 'layout' },
      snapshot: { tier: 'active', packageVersion: '1.0.0' },
    })

    mgr.setPublicStorageHandler(() => {
      throw new PluginStorageError('STORAGE_QUOTA_EXCEEDED', 'storage quota exceeded')
    })
    const failed = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'storage-2',
      ns: 'storage',
      method: 'set',
      args: { scope: 'workspace', key: 'layout', value: { compact: true } },
    })
    expect(failed).toEqual({
      reqId: 'storage-2',
      ok: false,
      error: { code: 'STORAGE_QUOTA_EXCEEDED', message: 'storage quota exceeded' },
    })

    let nested: unknown = null
    for (let index = 0; index < 129; index += 1) nested = [nested]
    const invalidDepth = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'storage-depth',
      ns: 'storage',
      method: 'set',
      args: { scope: 'plugin', key: 'depth', value: nested },
    })
    expect(invalidDepth).toEqual({
      reqId: 'storage-depth',
      ok: false,
      error: { code: 'INVALID_ARGUMENT', message: "invalid request for 'storage.set'" },
    })
  })

  it('notifies matching plugin storage instances after successful mutations only', async () => {
    const mgr = new FrontendPluginManager()
    const storageDescriptor = (
      id: string,
      workspacePath: string,
      storageSnapshotTier: StorageSnapshotTier = 'active',
      packageVersion = '1.0.0',
    ): PluginLaunchDescriptor => ({
      id,
      packageVersion,
      requires: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['ui'] }),
      capabilityContext: {
        publisherEligible: false,
        userGrant: { packageVersion, system: ['ui'], storage: true },
        runtimeBinding: {
          pluginId: id,
          packageVersion,
          workspaceId: mgr.workspaceIdForPath(workspacePath),
          instanceId: null,
          audience: `${id}.main`,
        },
        storageSnapshots: new Map([
          ['candidate', packageVersion],
          ['active', packageVersion],
          ['previous', '0.9.0'],
        ]),
        storageSnapshotTier,
      },
      devUrl: '',
      entryFile: `/plugins/${id}/index.html`,
      views: [{
        id: 'main',
        contributionKey: `${id}.main`,
        kind: 'custom',
        location: 'main',
        title: id,
        entryFile: `/plugins/${id}/index.html`,
      }],
    })
    const firstDescriptor = storageDescriptor('acme.storage-owned', '/workspace')
    mgr.registerDescriptor(firstDescriptor)
    const firstHost = new FakeBrowserWindow()
    const firstHandle = await mgr.openView(firstDescriptor, firstDescriptor.views![0], {
      hostWindow: asHost(firstHost),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: firstDescriptor.capabilityContext,
    })
    const first = { mgr, view: firstHost.children[0] as FakeViewLike, instanceId: firstHandle.instanceId }
    const secondDescriptor = storageDescriptor('acme.storage-owned', '/other-workspace')
    const secondHost = new FakeBrowserWindow()
    await mgr.openView(secondDescriptor, secondDescriptor.views![0], {
      hostWindow: asHost(secondHost),
      bounds: 'fill',
      workspacePath: '/other-workspace',
      capabilityContext: secondDescriptor.capabilityContext,
    })
    const secondView = secondHost.children[0] as FakeViewLike
    const candidateDescriptor = storageDescriptor('acme.storage-owned', '/candidate-workspace', 'candidate')
    const candidateHost = new FakeBrowserWindow()
    await mgr.openView(candidateDescriptor, candidateDescriptor.views![0], {
      hostWindow: asHost(candidateHost),
      bounds: 'fill',
      workspacePath: '/candidate-workspace',
      capabilityContext: candidateDescriptor.capabilityContext,
    })
    const candidateView = candidateHost.children[0] as FakeViewLike

    const otherDescriptor: PluginLaunchDescriptor = {
      id: 'acme.storage-other',
      packageVersion: '1.0.0',
      requires: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['ui'] }),
      capabilityContext: {
        publisherEligible: false,
        userGrant: { packageVersion: '1.0.0', system: ['ui'], storage: true },
        runtimeBinding: {
          pluginId: 'acme.storage-other',
          packageVersion: '1.0.0',
          workspaceId: mgr.workspaceIdForPath('/workspace'),
          instanceId: null,
          audience: 'acme.storage-other.main',
        },
        storageSnapshots: new Map([
          ['candidate', '1.0.0'],
          ['active', '1.0.0'],
          ['previous', '0.9.0'],
        ]),
        storageSnapshotTier: 'active',
      },
      devUrl: '',
      entryFile: '/plugins/acme.storage-other/index.html',
      views: [{
        id: 'main',
        contributionKey: 'acme.storage-other.main',
        kind: 'custom',
        location: 'main',
        title: 'Other storage',
        entryFile: '/plugins/acme.storage-other/index.html',
      }],
    }
    mgr.registerDescriptor(otherDescriptor)
    const otherHost = new FakeBrowserWindow()
    await mgr.openView(otherDescriptor, otherDescriptor.views![0], {
      hostWindow: asHost(otherHost),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: otherDescriptor.capabilityContext,
    })
    const otherView = otherHost.children[0] as FakeViewLike
    const viewsToCheck = [first.view, secondView, candidateView, otherView]
    for (const view of viewsToCheck) view.webContents.sent.length = 0

    mgr.setPublicStorageHandler(() => null)
    const handler = ipcHandlers.get(CALL)
    expect(handler).toBeDefined()
    await expect(handler!({ sender: { id: first.view.webContents.id } }, {
      reqId: 'storage-plugin-set',
      ns: 'storage',
      method: 'set',
      args: { scope: 'plugin', key: 'agentTeam.git.logScope', value: 'all' },
    })).resolves.toMatchObject({ ok: true })

    const storageEvents = (view: FakeViewLike) => view.webContents.sent.filter((message) =>
      (message.args[0] as { type?: string }).type === 'ui.pluginStorageChanged')
    expect(storageEvents(first.view)).toEqual([expect.objectContaining({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.pluginStorageChanged',
        data: {
          scope: 'plugin',
          key: 'agentTeam.git.logScope',
          value: 'all',
          deleted: false,
        },
      }],
    })])
    expect(storageEvents(secondView)).toHaveLength(1)
    expect(storageEvents(candidateView)).toHaveLength(0)
    expect(storageEvents(otherView)).toHaveLength(0)

    const firstRuntime = (mgr as unknown as {
      running: Map<string, { capabilityContext?: HostCapabilityContext | null }>
    }).running.get(first.instanceId)?.capabilityContext?.runtimeBinding
    expect(firstRuntime).toBeDefined()
    ;(mgr as unknown as {
      dispatchPluginStorageChanged: (plan: unknown, scope: 'plugin' | 'workspace', key: string, value: JsonValue, deleted: boolean) => void
    }).dispatchPluginStorageChanged({
      kind: 'public',
      address: 'storage.set',
      scope: 'plugin',
      args: { scope: 'plugin', key: 'versioned', value: true },
      runtime: { ...firstRuntime!, packageVersion: '2.0.0' },
      storage: {
        partition: { pluginId: 'acme.storage-owned', workspaceId: null, key: 'versioned' },
        snapshot: { pluginId: 'acme.storage-owned', tier: 'active', packageVersion: '2.0.0' },
      },
    }, 'plugin', 'versioned', true, false)
    expect(storageEvents(first.view)).toHaveLength(1)
    expect(storageEvents(secondView)).toHaveLength(1)
    expect(storageEvents(candidateView)).toHaveLength(0)
    expect(storageEvents(otherView)).toHaveLength(0)

    for (const view of viewsToCheck) view.webContents.sent.length = 0
    await expect(handler!({ sender: { id: first.view.webContents.id } }, {
      reqId: 'storage-workspace-set',
      ns: 'storage',
      method: 'set',
      args: { scope: 'workspace', key: 'agentTeam.gitTabRepo', value: '/workspace' },
    })).resolves.toMatchObject({ ok: true })
    expect(storageEvents(first.view)).toHaveLength(1)
    expect(storageEvents(secondView)).toHaveLength(0)
    expect(storageEvents(candidateView)).toHaveLength(0)
    expect(storageEvents(otherView)).toHaveLength(0)

    for (const view of viewsToCheck) view.webContents.sent.length = 0
    await expect(handler!({ sender: { id: first.view.webContents.id } }, {
      reqId: 'storage-plugin-delete',
      ns: 'storage',
      method: 'delete',
      args: { scope: 'plugin', key: 'agentTeam.git.logScope' },
    })).resolves.toMatchObject({ ok: true })
    expect(storageEvents(first.view)[0].args[0]).toMatchObject({
      type: 'ui.pluginStorageChanged',
      data: {
        scope: 'plugin',
        key: 'agentTeam.git.logScope',
        value: null,
        deleted: true,
      },
    })
    expect(storageEvents(secondView)).toHaveLength(1)
    expect(storageEvents(candidateView)).toHaveLength(0)

    for (const view of viewsToCheck) view.webContents.sent.length = 0
    mgr.setPublicStorageHandler(() => {
      throw new PluginStorageError('INTERNAL_ERROR', 'storage failed')
    })
    await expect(handler!({ sender: { id: first.view.webContents.id } }, {
      reqId: 'storage-plugin-failed',
      ns: 'storage',
      method: 'set',
      args: { scope: 'plugin', key: 'agentTeam.git.logScope', value: 'all' },
    })).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } })
    expect(storageEvents(first.view)).toHaveLength(0)
    expect(storageEvents(secondView)).toHaveLength(0)
    expect(storageEvents(candidateView)).toHaveLength(0)
    expect(storageEvents(otherView)).toHaveLength(0)
  })

  it('keeps the selected storage tier fixed for a live v2 instance', async () => {
    const mgr = new FrontendPluginManager()
    const activeContext: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion: '1.0.0', system: [], storage: true },
      runtimeBinding: {
        pluginId: 'acme.storage-tier',
        packageVersion: '1.0.0',
        workspaceId: 'workspace-1',
        instanceId: null,
        audience: 'audience-1',
      },
      storageSnapshots: new Map([
        ['candidate', '1.0.0'],
        ['active', '1.0.0'],
      ]),
      storageSnapshotTier: 'active',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: 'acme.storage-tier',
      packageVersion: '1.0.0',
      requires: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: [] }),
      capabilityContext: activeContext,
      devUrl: '',
      entryFile: '/plugins/acme.storage-tier/index.html',
      views: [
        {
          id: 'main',
          contributionKey: 'acme.storage-tier.main',
          kind: 'custom',
          location: 'main',
          title: 'Storage tier',
          entryFile: '/plugins/acme.storage-tier/index.html',
        },
      ],
    }
    mgr.registerDescriptor(descriptor)
    await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(new FakeBrowserWindow()),
      bounds: 'fill',
    })
    expect(() =>
      mgr.setCapabilityContext('acme.storage-tier', {
        ...activeContext,
        storageSnapshotTier: 'candidate',
      })
    ).toThrow(/tier is fixed/)
  })

  it('routes workspace events only with a matching Host source binding', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const binding = {
      pluginId: 'acme.files',
      packageVersion: '1.0.0',
      workspaceId: 'workspace-1',
      instanceId: null,
      audience: null,
    } as const
    mgr.open(
      asHost(host),
      {
        id: 'acme.files',
        requires: ['fs'],
        capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
        capabilityContext: {
          publisherEligible: false,
          userGrant: { packageVersion: '1.0.0', system: ['fs'] },
          runtimeBinding: binding,
        },
        devUrl: '',
        entryFile: '/plugins/acme.files/index.html',
      },
      'fill'
    )
    const view = views[views.length - 1]
    const eventPayload = { changes: [{ path: 'README.md', kind: 'changed' }] }
    mgr.dispatchPublicCapabilityEvent('acme.files', 'workspace.filesChanged', eventPayload, {
      ...binding,
      pluginId: HOST_EVENT_SOURCE_PLUGIN_ID,
    })
    expect(view.webContents.sent).toContainEqual({
      channel: 'plugin:cap:event',
      args: [{ type: 'workspace.filesChanged', data: eventPayload }],
    })

    const before = view.webContents.sent.length
    mgr.dispatchPublicCapabilityEvent('acme.files', 'workspace.filesChanged', eventPayload, {
      ...binding,
      pluginId: HOST_EVENT_SOURCE_PLUGIN_ID,
      workspaceId: 'workspace-2',
    })
    expect(view.webContents.sent).toHaveLength(before)
  })
})

describe('first-party Git private bridge', () => {
  const HOST_CALL = 'plugin:host:call'
  const CAPABILITY_CALL = 'plugin:cap:call'

  function gitDescriptor(
    mgr: FrontendPluginManager,
    workspacePath = '/workspace',
    audience = 'git-left',
    packageVersion = '1.0.0',
  ): PluginLaunchDescriptor {
    return {
      id: 'navide.git',
      packageVersion,
      requires: ['terminal'],
      capabilityPolicy: manifestV2CapabilityPolicy({
        system: ['fs', 'ui', 'aiCli'],
        shell: 'allowlist',
      }),
      capabilityContext: mgr.gitCapabilityContext(packageVersion, workspacePath, audience),
      devUrl: '',
      entryFile: '/plugins/navide.git/index.html',
      views: [
        {
          id: 'left',
          contributionKey: 'navide.git.left',
          kind: 'custom',
          location: 'left',
          title: 'Git',
          entryFile: '/plugins/navide.git/left.html',
        },
      ],
    }
  }

  async function openGitView(workspacePath = '/workspace', audience = 'git-left'): Promise<{
    mgr: FrontendPluginManager
    view: FakeViewLike
    host: FakeBrowserWindow
    sent: Array<{ channel: string; args: unknown[] }>
    instanceId: string
  }> {
    const mgr = new FrontendPluginManager()
    const descriptor = gitDescriptor(mgr, workspacePath, audience)
    mgr.registerDescriptor(descriptor, { builtin: true })
    const host = new FakeBrowserWindow()
    const sent: Array<{ channel: string; args: unknown[] }> = []
    ;(host as unknown as { webContents: { send: (channel: string, ...args: unknown[]) => void } }).webContents = {
      send: (channel, ...args) => sent.push({ channel, args }),
    }
    const handle = await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath,
      capabilityContext: descriptor.capabilityContext,
    })
    return { mgr, view: host.children[0] as FakeViewLike, host, sent, instanceId: handle.instanceId }
  }

  function plansDescriptor(
    mgr: FrontendPluginManager,
    workspacePath = '/workspace',
    audience = 'plans-window',
  ): PluginLaunchDescriptor {
    const packageVersion = '0.1.0'
    const view = {
      id: 'window',
      contributionKey: `${PLANS_PLUGIN_ID}.window`,
      kind: 'custom' as const,
      location: 'window' as const,
      title: 'Plans',
      entryFile: '/path/to/plans/window.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: '/path/to/plans',
      requires: ['fs', 'ui', 'plans', 'terminal'],
      capabilityPolicy: {
        kind: 'manifest-v2',
        system: ['fs', 'ui', 'aiCli'],
        shell: 'allowlist',
        grants: [],
      },
      devUrl: '',
      entryFile: '/path/to/plans/window.html',
      views: [view],
    }
    mgr.setCapabilityGrantResolver((pluginId, version) => {
      if (pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
        return {
          packageVersion,
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          storage: true,
        }
      }
      return null
    })
    descriptor.capabilityContext = mgr.plansCapabilityContext(packageVersion, workspacePath, audience)
    return descriptor
  }

  async function openPlansView(workspacePath = '/workspace', audience = 'plans-window', diagnostics = false): Promise<{
    mgr: FrontendPluginManager
    view: FakeViewLike
    host: FakeBrowserWindow
    sent: Array<{ channel: string; args: unknown[] }>
    instanceId: string
  }> {
    const mgr = new FrontendPluginManager()
    mgr.setPlansDiagnosticsEnabled(diagnostics)
    const descriptor = plansDescriptor(mgr, workspacePath, audience)
    mgr.registerDescriptor(descriptor, { builtin: true })
    const capabilityContext = mgr.plansCapabilityContext(descriptor.packageVersion!, workspacePath, audience)
    const host = new FakeBrowserWindow()
    const sent: Array<{ channel: string; args: unknown[] }> = []
    ;(host as unknown as { webContents: { send: (channel: string, ...args: unknown[]) => void } }).webContents = {
      send: (channel, ...args) => sent.push({ channel, args }),
    }
    const handle = await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath,
      capabilityContext,
      query: '?plans_diagnostics=1&plans_package_version=spoofed&plans_package_source=spoofed',
    })
    return { mgr, view: host.children[0] as FakeViewLike, host, sent, instanceId: handle.instanceId }
  }

  async function call(
    view: FakeViewLike,
    action: string,
    args: Record<string, unknown>,
    reqId = 'git-1'
  ): Promise<Record<string, unknown>> {
    const handler = ipcHandlers.get(HOST_CALL)
    expect(handler).toBeDefined()
    return (await handler!({ sender: { id: view.webContents.id } }, {
      reqId,
      action,
      args,
    })) as Record<string, unknown>
  }

  async function publicCall(
    view: FakeViewLike,
    ns: string,
    method: string,
    args: Record<string, unknown>,
    reqId = 'public-git-1',
  ): Promise<Record<string, unknown>> {
    const handler = ipcHandlers.get(CAPABILITY_CALL)
    expect(handler).toBeDefined()
    return (await handler!({ sender: { id: view.webContents.id } }, {
      reqId,
      ns,
      method,
      args,
    })) as Record<string, unknown>
  }

  it('dispatches typed public Git requests while retaining the private identity guard', async () => {
    const { mgr, view } = await openGitView()
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
    mgr.setBackendWsUrl('ws://public-git-status-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()

    const operation = publicCall(view, 'shell', 'gitStatus', { repositoryPath: '.' }, 'public-git-status')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0]!) as { id: string; type: string; payload: Record<string, unknown> }
    expect(request.type).toBe('git.status')
    expect(request.payload).toEqual({ workspace_path: resolve('/workspace') })
    socket.receive({ id: request.id, type: request.type, ok: true, payload: { branch: 'main' }, error: null, timestamp: '' })
    await expect(operation).resolves.toEqual({ reqId: 'public-git-status', ok: true, result: { branch: 'main' } })

    await expect(call(view, 'git.request', {
      type: 'git.status',
      payload: { workspace_path: '/workspace', instanceId: 'forged' },
    }, 'private-identity-guard')).resolves.toMatchObject({
      reqId: 'private-identity-guard',
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })
    expect(socket.sent).toHaveLength(1)
  })

  it('passes on the shell.run cut disclosure as the broker sent it, and nothing else changes', async () => {
    const { mgr, view } = await openGitView()
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
    mgr.setBackendWsUrl('ws://public-shell-run-truncation-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const answer = async (reqId: string, payload: Record<string, unknown>) => {
      const operation = publicCall(view, 'shell', 'run', { command: 'git log' }, reqId)
      await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0))
      const request = JSON.parse(socket.sent.at(-1)!) as { id: string; type: string }
      expect(request.type).toBe('shell.run')
      socket.sent.length = 0
      socket.receive({ id: request.id, type: request.type, ok: true, payload, error: null, timestamp: '' })
      return operation
    }

    await expect(answer('cut', {
      ok: true, output: 'o'.repeat(8000), stdout: 'o'.repeat(8000), stderr: 'e'.repeat(8000), exit_code: 0,
      truncated: true, stdoutBytes: 9000, stderrBytes: 12000,
    })).resolves.toEqual({
      reqId: 'cut', ok: true,
      result: { exitCode: 0, stdout: 'o'.repeat(8000), stderr: 'e'.repeat(8000), truncated: true, stdoutBytes: 9000, stderrBytes: 12000 },
    })
    await expect(answer('whole', {
      ok: true, output: 'abc\n', stdout: 'abc\n', stderr: '', exit_code: 0, truncated: false, stdoutBytes: 4,
    })).resolves.toEqual({
      reqId: 'whole', ok: true, result: { exitCode: 0, stdout: 'abc\n', stderr: '', truncated: false, stdoutBytes: 4 },
    })
    // A broker that sends no disclosure gives exactly the old result.
    await expect(answer('old', { ok: true, output: 'abc\n', stdout: 'abc\n', stderr: '', exit_code: 0 }))
      .resolves.toEqual({ reqId: 'old', ok: true, result: { exitCode: 0, stdout: 'abc\n', stderr: '' } })
  })

  it('denies an agent public Git plan before opening a backend connection', async () => {
    const { mgr, view, instanceId } = await openGitView()
    const socketsBefore = wsMock.FakeNodeWebSocket.instances.length
    const handler = vi.fn()
    mgr.setPublicCapabilityHandler(handler)
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: [] },
      revision: 1,
      state: 'user',
    }))

    await expect(mgr.executeAgentCapability(instanceId, {
      reqId: 'denied-public-git',
      ns: 'shell',
      method: 'gitStatus',
      args: { repositoryPath: '.' },
    })).resolves.toMatchObject({
      reqId: 'denied-public-git',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    expect(handler).not.toHaveBeenCalled()
    expect(wsMock.FakeNodeWebSocket.instances).toHaveLength(socketsBefore)
  })

  it('rejects a public clone selection grant owned by another Git instance', async () => {
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'public-git-clone-owner-')))
    try {
      const { mgr, instanceId } = await openGitView(workspacePath)
      const socketsBefore = wsMock.FakeNodeWebSocket.instances.length
      const secondDescriptor = gitDescriptor(mgr, workspacePath, 'git-left')
      const secondHost = new FakeBrowserWindow()
      const secondHandle = await mgr.openView(secondDescriptor, secondDescriptor.views![0], {
        hostWindow: asHost(secondHost),
        bounds: 'fill',
        workspacePath,
        capabilityContext: secondDescriptor.capabilityContext,
      })
      const running = (mgr as unknown as {
        running: Map<string, { capabilityContext?: HostCapabilityContext | null }>
      }).running
      const secondBinding = running.get(secondHandle.instanceId)?.capabilityContext?.runtimeBinding
      expect(secondBinding).toBeDefined()
      const selectionGrants = (mgr as unknown as {
        editorSelectionGrants: { mint: (owner: { instanceId: string; workspaceId: string; packageVersion: string }, path: string, kind: 'directory') => { grant: string } }
      }).editorSelectionGrants
      const target = join(workspacePath, 'clone-target')
      const selected = selectionGrants.mint({
        instanceId: secondBinding!.instanceId!,
        workspaceId: secondBinding!.workspaceId!,
        packageVersion: secondBinding!.packageVersion,
      }, target, 'directory')
      const firstBinding = running.get(instanceId)?.capabilityContext?.runtimeBinding
      expect(firstBinding).toBeDefined()
      const request = {
        kind: 'public' as const,
        address: 'shell.gitClone',
        scope: 'workspace' as const,
        args: {
          repositoryPath: '.',
          url: 'https://github.com/acme/repo.git',
          target_dir: target,
          selectionGrant: selected.grant,
        },
        runtime: firstBinding!,
      }

      await expect(mgr.executePublicCapability(request)).rejects.toThrow(/owned by this instance/)
      expect(wsMock.FakeNodeWebSocket.instances).toHaveLength(socketsBefore)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('dispatches public Git account methods through the fixed mapping and bound workspace', async () => {
    const { mgr, view } = await openGitView('/workspace', 'git-history')
    const bind = vi.fn()
    const unbind = vi.fn()
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [{ id: 'account-1', label: 'GitHub', host: 'github.com', username: 'alice', tokenLast4: '1234' }],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind,
      unbind,
      getBinding: () => 'account-1',
      getCredential: () => null,
    })
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))

    await expect(publicCall(view, 'ui', 'listGitAccounts', {}, 'public-account-list')).resolves.toEqual({
      reqId: 'public-account-list',
      ok: true,
      result: {
        available: true,
        accounts: [{ id: 'account-1', label: 'GitHub', host: 'github.com', username: 'alice', tokenLast4: '1234' }],
      },
    })
    await expect(publicCall(view, 'ui', 'bindGitAccount', { accountId: 'account-1' }, 'public-account-bind')).resolves.toEqual({
      reqId: 'public-account-bind',
      ok: true,
      result: { accountId: 'account-1' },
    })
    expect(bind).toHaveBeenCalledWith(resolve('/workspace'), 'account-1')

    await expect(publicCall(view, 'ui', 'bindGitAccount', {
      accountId: 'account-1',
      workspace_path: '/other-workspace',
    }, 'public-account-forged-workspace')).resolves.toMatchObject({
      reqId: 'public-account-forged-workspace',
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    })
    expect(bind).toHaveBeenCalledTimes(1)
    expect(unbind).not.toHaveBeenCalled()
  })

  it('denies an agent public Git account plan before invoking account handlers', async () => {
    const { mgr, instanceId } = await openGitView()
    const bind = vi.fn()
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind,
      unbind: () => undefined,
      getBinding: () => null,
      getCredential: () => null,
    })
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: [] },
      revision: 1,
      state: 'user',
    }))

    await expect(mgr.executeAgentCapability(instanceId, {
      reqId: 'denied-public-account',
      ns: 'ui',
      method: 'bindGitAccount',
      args: { accountId: 'account-1' },
    })).resolves.toMatchObject({
      reqId: 'denied-public-account',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    expect(bind).not.toHaveBeenCalled()
  })

  it('opens the Host file picker with bound view context and Host-owned search', async () => {
    const { mgr, instanceId } = await openGitView('/workspace', 'git-file-picker')
    mgr.setBackendWsUrl('ws://public-file-picker-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const runtime = (
      mgr as unknown as {
        running: Map<string, { capabilityContext: HostCapabilityContext }>
      }
    ).running.get(instanceId)!.capabilityContext.runtimeBinding!
    const invocationRef: { current: Pick<FilePickerInvocation, 'request' | 'canDispatch' | 'search'> | null } = { current: null }
    const open = vi.fn(async (candidate: FilePickerInvocation) => {
      invocationRef.current = candidate
      const matches = await candidate.search(candidate.request.query as string)
      return { opened: matches.length > 0 }
    })
    const cancelInstance = vi.fn()
    const cancelSession = vi.fn()
    mgr.setFilePickerHost({ open, cancelInstance, cancelSession })

    const pending = mgr.executePublicCapability({
      kind: 'public',
      address: 'ui.openFilePicker',
      scope: 'workspace',
      runtime,
      args: {
        query: 'read',
        candidates: ['README.md'],
        line: 4,
      },
    })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0]!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(request).toMatchObject({
      type: 'fs.list_files_flat',
      payload: { workspace_path: '/workspace', query: 'read', max_results: 20 },
    })
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: { ok: true, files: ['README.md'], truncated: false },
      error: null,
      timestamp: '',
    })
    await expect(pending).resolves.toEqual({ opened: true })
    expect(open).toHaveBeenCalledTimes(1)
    expect(invocationRef.current?.request).toEqual({
      query: 'read',
      candidates: ['README.md'],
      line: 4,
    })
    expect(invocationRef.current?.canDispatch()).toBe(true)
    expect(cancelSession).not.toHaveBeenCalled()
  })

  it('rejects a file picker request for a foreign session before Host lookup', async () => {
    const { mgr, instanceId } = await openGitView('/workspace', 'git-file-picker-session')
    const open = vi.fn(async () => ({ opened: true }))
    mgr.setFilePickerHost({ open, cancelInstance: vi.fn(), cancelSession: vi.fn() })
    const runtime = (
      mgr as unknown as {
        running: Map<string, { capabilityContext: HostCapabilityContext }>
      }
    ).running.get(instanceId)!.capabilityContext.runtimeBinding!

    await expect(mgr.executePublicCapability({
      kind: 'public',
      address: 'ui.openFilePicker',
      scope: 'workspace',
      runtime,
      args: {
        query: 'secret',
        candidates: ['secret.txt'],
        sessionId: 'foreign-session',
      },
    })).rejects.toThrow(/session is no longer owned/)
    expect(open).not.toHaveBeenCalled()
  })

  it('invalidates an in-flight file picker when its instance is destroyed', async () => {
    const { mgr, instanceId } = await openGitView('/workspace', 'git-file-picker-teardown')
    const capturedRef: { current: Pick<FilePickerInvocation, 'canDispatch'> | null } = { current: null }
    const cancelInstance = vi.fn()
    mgr.setFilePickerHost({
      open: vi.fn(async (invocation: FilePickerInvocation) => {
        capturedRef.current = invocation
        return { opened: false }
      }),
      cancelInstance,
      cancelSession: vi.fn(),
    })
    const runtime = (
      mgr as unknown as {
        running: Map<string, { capabilityContext: HostCapabilityContext }>
      }
    ).running.get(instanceId)!.capabilityContext.runtimeBinding!

    await expect(mgr.executePublicCapability({
      kind: 'public',
      address: 'ui.openFilePicker',
      scope: 'workspace',
      runtime,
      args: {
        query: 'read',
        candidates: [],
      },
    })).resolves.toEqual({ opened: false })
    expect(capturedRef.current?.canDispatch()).toBe(true)
    mgr.destroyInstance(instanceId)
    expect(cancelInstance).toHaveBeenCalledWith(instanceId)
    expect(capturedRef.current?.canDispatch()).toBe(false)
  })

  it('dispatches public Issue requests with Host-derived workspace and executable policy', async () => {
    const { mgr, view } = await openGitView('/workspace')
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
    mgr.setBackendWsUrl('ws://public-issues-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()

    const operation = publicCall(view, 'shell', 'listIssues', {
      repositoryPath: '.',
      limit: 5,
    }, 'public-issues-list')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0]!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(request.type).toBe('issues.public')
    expect(request.payload).toEqual({
      workspace_path: resolve('/workspace'),
      operation: 'list',
      arguments: { limit: 5 },
      execution_policy: { mode: 'allowlist', shell: ['git', 'gh', 'glab'] },
    })
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: { ok: true, provider: 'github', issues: [] },
      error: null,
      timestamp: '',
    })
    await expect(operation).resolves.toEqual({
      reqId: 'public-issues-list',
      ok: true,
      result: { ok: true, provider: 'github', issues: [] },
    })

    await expect(publicCall(view, 'shell', 'listIssues', {
      repositoryPath: '.',
      limit: 5,
      execution_policy: { mode: 'full', shell: ['sh'] },
    }, 'public-issues-forged-policy')).resolves.toMatchObject({
      reqId: 'public-issues-forged-policy',
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    })
    expect(socket.sent).toHaveLength(1)
  })

  it('derives an agent public Issue policy from the current Host snapshot', async () => {
    const { mgr, instanceId } = await openGitView('/workspace')
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: ['git', 'gh'] },
      revision: 7,
      state: 'user',
    }))
    mgr.setBackendWsUrl('ws://public-agent-issues-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()

    const operation = mgr.executeAgentCapability(instanceId, {
      reqId: 'agent-public-issues',
      ns: 'shell',
      method: 'listIssues',
      args: { limit: 3 },
    })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0]!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(request.type).toBe('issues.public')
    expect(request.payload.execution_policy).toEqual({ mode: 'allowlist', shell: ['git', 'gh'] })
    expect(request.payload).toMatchObject({
      workspace_path: resolve('/workspace'),
      operation: 'list',
      arguments: { limit: 3 },
    })
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: { ok: true, provider: 'github', issues: [] },
      error: null,
      timestamp: '',
    })
    await expect(operation).resolves.toMatchObject({
      reqId: 'agent-public-issues',
      ok: true,
      result: { ok: true, provider: 'github', issues: [] },
    })
  })

  it('denies an agent public Issue request before opening the backend when policy is stale or unavailable', async () => {
    const { mgr, instanceId } = await openGitView('/workspace')
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: [] },
      revision: 1,
      state: 'user',
    }))
    const socketsBefore = wsMock.FakeNodeWebSocket.instances.length

    await expect(mgr.executeAgentCapability(instanceId, {
      reqId: 'denied-agent-public-issues',
      ns: 'shell',
      method: 'listIssues',
      args: {},
    })).resolves.toMatchObject({
      reqId: 'denied-agent-public-issues',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    expect(wsMock.FakeNodeWebSocket.instances).toHaveLength(socketsBefore)

    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: ['git'] },
      revision: 2,
      state: 'corrupt',
    }))
    await expect(mgr.executeAgentCapability(instanceId, {
      reqId: 'denied-corrupt-public-issues',
      ns: 'shell',
      method: 'listIssues',
      args: {},
    })).resolves.toMatchObject({
      reqId: 'denied-corrupt-public-issues',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    expect(wsMock.FakeNodeWebSocket.instances).toHaveLength(socketsBefore)
  })

  it('reads only fixed Host editor preferences through the existing settings backend', async () => {
    const { mgr, view } = await openGitView('/workspace')
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
    mgr.setBackendWsUrl('ws://public-editor-preferences-read-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()

    const operation = publicCall(view, 'ui', 'readEditorPreferences', {}, 'public-editor-preferences-read')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0]!) as { id: string; type: string; payload: Record<string, unknown> }
    expect(request.type).toBe('ui.settings.get')
    expect(request.payload).toEqual({})
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: {
        settings: {
          'agentTeam.yolo': '0',
          'agent-team:theme': 'dark',
          'agentTeam.git.logScope': 'all',
          token: 'must-not-cross',
          'other.setting': { nested: true },
        },
      },
      error: null,
      timestamp: '',
    })

    await expect(operation).resolves.toEqual({
      reqId: 'public-editor-preferences-read',
      ok: true,
      result: {
        preferences: {
          'agentTeam.yolo': '0',
          'agent-team:theme': 'dark',
          'agentTeam.git.logScope': 'all',
        },
      },
    })
  })

  it('writes only a fixed writable Host editor preference through ui.settings.set', async () => {
    const { mgr, view } = await openGitView('/workspace')
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
    mgr.setBackendWsUrl('ws://public-editor-preferences-write-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()

    const operation = publicCall(view, 'ui', 'writeEditorPreference', {
      key: 'agent-team:theme',
      value: 'light',
    }, 'public-editor-preferences-write')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0]!) as { id: string; type: string; payload: Record<string, unknown> }
    expect(request.type).toBe('ui.settings.set')
    expect(request.payload).toEqual({ updates: { 'agent-team:theme': 'light' } })
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: { ok: true },
      error: null,
      timestamp: '',
    })

    await expect(operation).resolves.toEqual({
      reqId: 'public-editor-preferences-write',
      ok: true,
      result: { ok: true },
    })
  })

  it('denies editor preference writes before opening a backend connection when the agent policy omits UI', async () => {
    const { mgr, instanceId } = await openGitView('/workspace')
    const socketsBefore = wsMock.FakeNodeWebSocket.instances.length
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: [] },
      revision: 1,
      state: 'user',
    }))

    await expect(mgr.executeAgentCapability(instanceId, {
      reqId: 'denied-editor-preferences-write',
      ns: 'ui',
      method: 'writeEditorPreference',
      args: { key: 'agent-team:theme', value: 'light' },
    })).resolves.toMatchObject({
      reqId: 'denied-editor-preferences-write',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    expect(wsMock.FakeNodeWebSocket.instances).toHaveLength(socketsBefore)
  })

  it('publishes filtered Host editor preferences to each authorized v2 instance', async () => {
    const { mgr, view } = await openGitView('/workspace')
    view.webContents.sent.length = 0

    mgr.dispatchHostSettingsChanged({
      settings: {
        'agentTeam.yolo': '1',
        'agent-team:language': 'zh-TW',
        'agentTeam.gitTopRatio': 0.4,
        token: 'must-not-cross',
        'unknown.setting': 'ignored',
      },
    })

    expect(view.webContents.sent).toContainEqual({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.editorPreferencesChanged',
        data: {
          preferences: {
            'agentTeam.yolo': '1',
            'agent-team:language': 'zh-TW',
            'agentTeam.gitTopRatio': 0.4,
          },
        },
      }],
    })
    const publicEvent = view.webContents.sent.find((entry) =>
      (entry.args[0] as { type?: string }).type === 'ui.editorPreferencesChanged')
    expect(JSON.stringify(publicEvent)).not.toContain('must-not-cross')
  })

  it('overlays retained v1 mini-IDE settings through the selected snapshot adapter', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor: PluginLaunchDescriptor = {
      id: MINI_IDE_PLUGIN_ID,
      requires: ['ui'],
      devUrl: '',
      entryFile: '/plugins/mini-ide/index.html',
    }
    mgr.registerBuiltin(descriptor)
    const host = new FakeBrowserWindow()
    const instanceId = mgr.open(asHost(host), descriptor, 'fill', { workspacePath: '/workspace' })
    expect(instanceId).toBeTruthy()
    const view = host.children[0] as FakeViewLike
    const reads: Record<string, unknown>[] = []
    const writes: Record<string, unknown>[] = []
    mgr.setMiniIdeLegacyPreferences({
      read: async (settings) => {
        reads.push(settings)
        return { ...settings, 'ide-sidebar-width': 'snapshot-value' }
      },
      write: async (updates) => {
        writes.push(updates)
        const remaining = { ...updates }
        delete remaining['ide-sidebar-width']
        delete remaining['ide-ai-panel-width']
        delete remaining['agentTeam.search.opts']
        return remaining
      },
    })
    mgr.setBackendWsUrl('ws://mini-ide-settings-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const handler = ipcHandlers.get(CAPABILITY_CALL)!

    const read = handler(
      { sender: { id: view.webContents.id } },
      { reqId: 'mini-settings-read', ns: 'ui', method: 'settings_get', args: {} },
    )
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const getRequest = JSON.parse(socket.sent[0]!) as { id: string; type: string }
    socket.receive({
      id: getRequest.id,
      type: getRequest.type,
      ok: true,
      payload: { settings: { 'ide-sidebar-width': 'host-value', 'other.setting': true } },
      error: null,
      timestamp: '',
    })
    await expect(read).resolves.toEqual({
      reqId: 'mini-settings-read',
      ok: true,
      result: { settings: { 'ide-sidebar-width': 'snapshot-value', 'other.setting': true } },
    })
    expect(reads).toEqual([{ 'ide-sidebar-width': 'host-value', 'other.setting': true }])

    const selectedWrite = await handler(
      { sender: { id: view.webContents.id } },
      {
        reqId: 'mini-settings-write-selected',
        ns: 'ui',
        method: 'settings_set',
        args: { updates: { 'ide-sidebar-width': 'new-value' } },
      },
    )
    expect(selectedWrite).toEqual({
      reqId: 'mini-settings-write-selected',
      ok: true,
      result: { ok: true },
    })
    expect(writes).toEqual([{ 'ide-sidebar-width': 'new-value' }])
    expect(socket.sent).toHaveLength(1)

    const mixedWrite = handler(
      { sender: { id: view.webContents.id } },
      {
        reqId: 'mini-settings-write-mixed',
        ns: 'ui',
        method: 'settings_set',
        args: { updates: { 'ide-ai-panel-width': 'new-width', 'other.setting': 1 } },
      },
    )
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const setRequest = JSON.parse(socket.sent[1]!) as { id: string; type: string; payload: unknown }
    expect(setRequest.payload).toEqual({ updates: { 'other.setting': 1 } })
    socket.receive({
      id: setRequest.id,
      type: setRequest.type,
      ok: true,
      payload: { ok: true },
      error: null,
      timestamp: '',
    })
    await expect(mixedWrite).resolves.toMatchObject({ ok: true })

    view.webContents.sent.length = 0
    ;(mgr as unknown as { dispatchEvent: (event: string, payload: unknown) => void }).dispatchEvent(
      'ui.settings_changed',
      { source: 'host', settings: { 'ide-sidebar-width': 'backend', 'other.setting': false } },
    )
    expect(view.webContents.sent).toContainEqual({
      channel: 'plugin:cap:event',
      args: [{ type: 'ui.settings_changed', data: { source: 'host', settings: { 'other.setting': false } } }],
    })
    expect(JSON.stringify(view.webContents.sent)).not.toContain('ide-sidebar-width')
    if (instanceId) mgr.destroyInstance(instanceId)
  })

  it('keeps Plans provenance invisible by default and overrides caller diagnostics when explicitly enabled', async () => {
    const disabled = await openPlansView()
    expect(disabled.view.webContents.loads[0]).not.toContain('plans_diagnostics')
    expect(disabled.view.webContents.loads[0]).not.toContain('plans_package_')
    const enabled = await openPlansView('/workspace', 'plans-window', true)
    const query = new URLSearchParams(enabled.view.webContents.loads[0].split('?')[1])
    expect(query.get('plans_diagnostics')).toBe('1')
    expect(query.get('plans_package_version')).toBe('0.1.0')
    expect(query.get('plans_package_source')).not.toBe('spoofed')
  })

  it('loads the selected factory contribution with its actual provenance regardless of the development environment flag', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'plans-factory-query-')))
    const mgr = new FrontendPluginManager()
    try {
      const packageDir = join(
        root,
        'dist-plugins',
        'official-artifacts',
        'factory-resources',
        PLANS_PLUGIN_ID,
        '0.1.0',
        `${process.platform}-${process.arch}`,
        'package',
      )
      mkdirSync(join(packageDir, 'frontend/left'), { recursive: true })
      mkdirSync(join(packageDir, 'frontend/window'), { recursive: true })
      mkdirSync(join(packageDir, 'backend'), { recursive: true })
      writeFileSync(join(packageDir, 'manifest.json'), readFileSync('plugins/navide-plans/manifest.json'))
      writeFileSync(join(packageDir, 'frontend/left/index.html'), '<!doctype html>')
      writeFileSync(join(packageDir, 'frontend/window/index.html'), '<!doctype html>')
      copyFileSync(process.execPath, join(packageDir, backendEntryOnDisk('backend/navide-plans')))
      expect(registerBundledPlans(mgr, {
        isPackaged: false,
        resourcesPath: '',
        artifactVersion: '0.1.0',
        devRoot: root,
      })).toEqual({ registered: true })
      mgr.setPlansDiagnosticsEnabled(true)
      mgr.setCapabilityGrantResolver(() => ({ packageVersion: '0.1.0', system: ['fs', 'ui', 'aiCli'], storage: true }))
      const descriptor = mgr.getDescriptor(PLANS_PLUGIN_ID)!
      const contribution = descriptor.views!.find((view) => view.location === 'window')!
      const host = new FakeBrowserWindow()
      await mgr.openView({ ...descriptor, entryFile: contribution.entryFile }, contribution, {
        hostWindow: asHost(host), bounds: 'fill', workspacePath: root,
        capabilityContext: mgr.plansCapabilityContext('0.1.0', root, 'plans-window'),
        query: '?plans_package_source=spoofed',
      })
      const loaded = (host.children[0] as FakeViewLike).webContents.loads[0]
      expect(loaded).toContain(contribution.entryFile)
      const query = new URLSearchParams(loaded.split('?')[1])
      expect(query.get('plans_package_source')).toBe('factory-bundled')
      expect(query.get('plans_package_version')).toBe('0.1.0')
    } finally {
      await mgr.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
    // Copies and removes the Node binary (~110 MB) as the package's backend: a
    // file write the size of which no other test here makes. 40–140 ms on an
    // idle machine, 5.4 s on a loaded Linux runner (PR #241), past the 5 s
    // default. Every await above takes the previous step's result, so there is
    // no ordering to fix: the time is the disk's. 30 s, as
    // pluginBackendEscape.test.ts gives its real backend runs.
  }, 30_000)

  it('retains Plans shell actions through the authenticated private bridge', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'plans-shell-')))
    try {
      mkdirSync(join(root, '.agent-team/plans'), { recursive: true })
      writeFileSync(join(root, '.agent-team/plans/draft.html'), '<html></html>')
      const { mgr, view } = await openPlansView(root)
      const dispatchExecution = vi.fn(() => ({ delivered: true }))
      const openPath = vi.fn(async () => ({ ok: true }))
      mgr.setPlansShellHandlers({ dispatchExecution, openPath })
      await expect(call(view, 'plans.shell', { operation: 'dispatch_execution', rel_path: '.agent-team/plans/draft.html', agent_key: 'codex' })).resolves.toMatchObject({ ok: true, result: { delivered: true } })
      expect(dispatchExecution).toHaveBeenCalledTimes(1)
      expect(dispatchExecution).toHaveBeenCalledWith({ workspace_path: root, rel_path: '.agent-team/plans/draft.html', agent_key: 'codex' })
      await expect(call(view, 'plans.shell', { operation: 'open_path', rel_path: '.agent-team/plans/draft.html' })).resolves.toMatchObject({ ok: true, result: { ok: true } })
      expect(openPath).toHaveBeenCalledTimes(1)
      expect(openPath).toHaveBeenCalledWith(join(root, '.agent-team/plans/draft.html'))
      mgr.forwardPlansExecutionResult({ workspace_path: root, rel_path: '.agent-team/plans/draft.html', ok: true })
      expect(view.webContents.sent).toContainEqual({ channel: 'plugin:cap:event', args: [{ type: 'plans.execution-result', data: { workspace_path: root, rel_path: '.agent-team/plans/draft.html', ok: true } }] })
      const count = view.webContents.sent.length
      mgr.forwardPlansExecutionResult({ workspace_path: '/other-workspace', rel_path: '.agent-team/plans/draft.html', ok: false })
      expect(view.webContents.sent).toHaveLength(count)
      for (const args of [
        { operation: 'open_path', rel_path: '/etc/passwd' },
        { operation: 'open_path', rel_path: '../outside.html' },
        { operation: 'open_path', rel_path: '.agent-team/plans/draft.html', workspace_path: '/other' },
        { operation: 'dispatch_execution', rel_path: '.agent-team/plans/draft.html', agent_key: 'unknown' },
      ]) await expect(call(view, 'plans.shell', args)).resolves.toMatchObject({ ok: false })
      expect(openPath).toHaveBeenCalledTimes(1)
      expect(dispatchExecution).toHaveBeenCalledTimes(1)
      mgr.setCapabilityGrantResolver(() => null)
      await expect(call(view, 'plans.shell', { operation: 'open_path', rel_path: '.agent-team/plans/draft.html' })).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('denies Plans shell actions from another first-party package', async () => {
    const { mgr, view } = await openGitView()
    const openPath = vi.fn(async () => ({ ok: true }))
    mgr.setPlansShellHandlers({ dispatchExecution: () => ({ delivered: true }), openPath })
    await expect(call(view, 'plans.shell', { operation: 'open_path', rel_path: '.agent-team/plans/draft.html' })).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('keeps manual calls usable while denying the equivalent agent operation', async () => {
    const { mgr, view, instanceId } = await openGitView()
    const plans: unknown[] = []
    mgr.setExecutionPolicyResolver((): ExecutionPolicySnapshot => ({
      policy: { schemaVersion: 1, mode: 'denylist', system: ['fs'], shell: [] },
      revision: 7,
      state: 'user',
    }))
    mgr.setPublicCapabilityHandler((plan) => {
      plans.push(plan)
      return null
    })
    const capabilityHandler = ipcHandlers.get('plugin:cap:call')
    expect(capabilityHandler).toBeDefined()

    await expect(mgr.executeAgentCapability(instanceId, {
      reqId: 'agent-fs',
      ns: 'fs',
      method: 'listFilesFlat',
      args: { query: '', maxResults: 1 },
    })).resolves.toMatchObject({
      reqId: 'agent-fs',
      ok: false,
      error: { code: 'CAPABILITY_DENIED', message: 'agent execution policy denied the operation' },
    })
    expect(plans).toEqual([])

    await expect(capabilityHandler!({ sender: { id: view.webContents.id } }, {
      reqId: 'manual-fs',
      ns: 'fs',
      method: 'listFilesFlat',
      args: { query: '', maxResults: 1 },
    })).resolves.toMatchObject({ reqId: 'manual-fs', ok: true })
    expect(plans[0]).toMatchObject({
      initiator: { kind: 'user' },
    })

    await expect(mgr.executeAgentCapability(instanceId, {
      reqId: 'forged-agent',
      ns: 'fs',
      method: 'listFilesFlat',
      args: { query: '', maxResults: 1 },
      initiator: { kind: 'user', id: 'forged' },
    })).resolves.toMatchObject({
      reqId: 'forged-agent',
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })
  })

  it('still denies when the policy resolver throws, but says why once in main.log and the ledger', async () => {
    const { mgr, instanceId } = await openGitView()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dataDir = mkdtempSync(join(tmpdir(), 'ledger-'))
    setMainLedgerDataDir(dataDir)
    mgr.setExecutionPolicyResolver(() => {
      throw new Error('policy file unreadable')
    })
    const handler = vi.fn()
    mgr.setPublicCapabilityHandler(handler)
    const call = (reqId: string) => mgr.executeAgentCapability(instanceId, {
      reqId, ns: 'fs', method: 'listFilesFlat', args: { query: '', maxResults: 1 },
    })
    try {
      await expect(call('throwing-1')).resolves.toMatchObject({ ok: false })
      await expect(call('throwing-2')).resolves.toMatchObject({ ok: false })
      expect(handler).not.toHaveBeenCalled()
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('policy file unreadable'))
      expect(warned).toHaveLength(1)
      const lines = readFileSync(join(dataDir, 'logs', 'errors.jsonl'), 'utf8').trim().split('\n')
      expect(lines.map((l) => JSON.parse(l).code)).toEqual(['plugin.policy_resolver_failed'])
    } finally {
      setMainLedgerDataDir(null)
      rmSync(dataDir, { recursive: true, force: true })
      warnSpy.mockRestore()
    }
  })

  it('rechecks a stale agent policy before invoking the public handler', async () => {
    const { mgr, instanceId } = await openGitView()
    let reads = 0
    const allow = (): ExecutionPolicySnapshot => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] },
      revision: 1,
      state: 'user',
    })
    const deny = (): ExecutionPolicySnapshot => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: [] },
      revision: 2,
      state: 'user',
    })
    mgr.setExecutionPolicyResolver(() => {
      reads += 1
      return reads === 1 ? allow() : deny()
    })
    const handler = vi.fn()
    mgr.setPublicCapabilityHandler(handler)

    await expect(mgr.executeAgentCapability(instanceId, {
      reqId: 'stale-agent-policy',
      ns: 'fs',
      method: 'listFilesFlat',
      args: { query: '', maxResults: 1 },
    })).resolves.toMatchObject({
      reqId: 'stale-agent-policy',
      ok: false,
      error: { code: 'CAPABILITY_DENIED', message: 'agent execution policy denied the operation' },
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('applies the global policy to an agent plugin-scoped UI call and withholds it without a user gesture', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.plugin-ui'
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'main',
      contributionKey: `${pluginId}.main`,
      kind: 'custom',
      location: 'main',
      title: 'Plugin UI',
      entryFile: '/plugins/acme.plugin-ui/index.html',
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion, system: ['ui'] },
      runtimeBinding: {
        pluginId,
        packageVersion,
        workspaceId: null,
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    const descriptor: PluginLaunchDescriptor = {
      id: pluginId,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['ui'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['ui'] }),
      capabilityContext: context,
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(descriptor)
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['ui'], shell: [] },
      revision: 1,
      state: 'user',
    }))
    const handler = vi.fn()
    mgr.setPublicCapabilityHandler(handler)
    const host = new FakeBrowserWindow()

    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        capabilityContext: context,
      })

      // The execution policy allows this plugin-scoped UI call without a
      // workspace (otherwise the code below would be CAPABILITY_DENIED), but the
      // Host still withholds a gesture-gated address from an agent-driven call.
      await expect(mgr.executeAgentCapability(handle.instanceId, {
        reqId: 'agent-plugin-ui-1',
        ns: 'ui',
        method: 'openExternal',
        args: { url: 'https://example.com' },
      })).resolves.toMatchObject({
        reqId: 'agent-plugin-ui-1',
        ok: false,
        error: { code: 'USER_CANCELLED' },
      })
      expect(handler).not.toHaveBeenCalled()
    } finally {
      await mgr.closeBackendPlugins()
    }
  })

  it('rechecks the agent policy for a plugin-scoped web call instead of default-allowing it', async () => {
    const mgr = new FrontendPluginManager()
    const pluginId = 'acme.plugin-web'
    const packageVersion = '1.0.0'
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'main',
      contributionKey: `${pluginId}.main`,
      kind: 'custom',
      location: 'main',
      title: 'Plugin Web',
      entryFile: '/plugins/acme.plugin-web/index.html',
    }
    const context: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion, system: ['web'] },
      runtimeBinding: {
        pluginId,
        packageVersion,
        workspaceId: null,
        instanceId: null,
        audience: view.contributionKey,
      },
    }
    const descriptor: PluginLaunchDescriptor = {
      id: pluginId,
      packageVersion,
      packageDir: process.cwd(),
      requires: ['web'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['web'] }),
      capabilityContext: context,
      devUrl: '',
      entryFile: view.entryFile,
      views: [view],
    }
    mgr.registerDescriptor(descriptor)
    let reads = 0
    mgr.setExecutionPolicyResolver((): ExecutionPolicySnapshot => {
      reads += 1
      return reads === 1
        ? { policy: { schemaVersion: 1, mode: 'allowlist', system: ['web'], shell: [] }, revision: 1, state: 'user' }
        : { policy: { schemaVersion: 1, mode: 'denylist', system: [], shell: [] }, revision: 2, state: 'user' }
    })
    const handler = vi.fn()
    mgr.setPublicCapabilityHandler(handler)
    const host = new FakeBrowserWindow()

    try {
      const handle = await mgr.openView(descriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        capabilityContext: context,
      })

      await expect(mgr.executeAgentCapability(handle.instanceId, {
        reqId: 'agent-plugin-web-1',
        ns: 'web',
        method: 'list',
        args: {},
      })).resolves.toMatchObject({
        reqId: 'agent-plugin-web-1',
        ok: false,
        error: { code: 'CAPABILITY_DENIED', message: 'agent execution policy denied the operation' },
      })
      expect(reads).toBe(2)
      expect(handler).not.toHaveBeenCalled()
    } finally {
      await mgr.closeBackendPlugins()
    }
  })

  it('denies Git storage writes outside the approved preference ownership', async () => {
    const { mgr, view } = await openGitView()
    const executions: unknown[] = []
    mgr.setPublicStorageHandler((execution) => {
      executions.push(execution)
      return null
    })
    const handler = ipcHandlers.get(CAPABILITY_CALL)
    expect(handler).toBeDefined()

    const response = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'git-storage-host-key',
      ns: 'storage',
      method: 'set',
      args: { scope: 'plugin', key: 'agentTeam.yolo', value: '0' },
    })

    expect(response).toMatchObject({
      reqId: 'git-storage-host-key',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    expect(executions).toEqual([])
  })

  it('routes only Host-owned read-only settings to Git v2 views', async () => {
    const { mgr, view } = await openGitView()

    mgr.dispatchHostSettingsChanged({
      settings: {
        'agentTeam.yolo': '0',
        'agentTeam.analyzerModel': 'qwen2:latest',
        'agentTeam.git.autoCommit': '1',
        'unknown.setting': 'ignored',
      },
    })

    expect(view.webContents.sent).toContainEqual({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agentTeam.yolo': '0',
            'agentTeam.analyzerModel': 'qwen2:latest',
          },
        },
      }],
    })
    expect(view.webContents.sent).toHaveLength(2)
  })

  it.each(['zh-TW', 'en-US', 'ja-JP'])('routes only Host-owned %s language to v2 Git views', async (locale) => {
    const { mgr, view } = await openGitView()
    // The merged Host dispatches both the public editor-preferences event for
    // views bound to it and the generic host-settings event.
    mgr.dispatchHostSettingsChanged({ settings: { 'agent-team:language': locale, 'unknown.setting': 'ignored' } })
    expect(view.webContents.sent).toEqual([
      {
        channel: 'plugin:cap:event',
        args: [{
          type: 'ui.editorPreferencesChanged',
          data: { preferences: { 'agent-team:language': locale } },
        }],
      },
      {
        channel: 'plugin:cap:event',
        args: [{ type: 'ui.settings_changed', data: { source: 'host', settings: { 'agent-team:language': locale } } }],
      },
    ])
  })

  it('routes Host-owned language settings changes to active Plans v2 views', async () => {
    const { mgr, view } = await openPlansView()

    mgr.dispatchHostSettingsChanged({
      settings: {
        'agent-team:language': 'zh-TW',
        'unknown.setting': 'ignored',
      },
    })

    expect(view.webContents.sent).toContainEqual({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agent-team:language': 'zh-TW',
          },
        },
      }],
    })
    expect(view.webContents.sent).toHaveLength(2)
  })

  it('preserves Git package-private settings contract: Plans receives only Host language and never Git settings or storage', async () => {
    const mgr = new FrontendPluginManager()
    const workspacePath = '/workspace'
    const gitDesc = gitDescriptor(mgr, workspacePath, 'git-left')
    mgr.registerDescriptor(gitDesc, { builtin: true })
    const gitHost = new FakeBrowserWindow()
    const gitSent: Array<{ channel: string; args: unknown[] }> = []
    ;(gitHost as unknown as { webContents: { send: (channel: string, ...args: unknown[]) => void } }).webContents = {
      send: (channel, ...args) => gitSent.push({ channel, args }),
    }
    await mgr.openView(gitDesc, gitDesc.views![0], {
      hostWindow: asHost(gitHost),
      bounds: 'fill',
      workspacePath,
      capabilityContext: gitDesc.capabilityContext,
    })
    const gitView = gitHost.children[0] as FakeViewLike

    const plansDesc = plansDescriptor(mgr, workspacePath, 'plans-window')
    mgr.registerDescriptor(plansDesc, { builtin: true })
    const plansCapabilityContext = mgr.plansCapabilityContext(plansDesc.packageVersion!, workspacePath, 'plans-window')
    const plansHost = new FakeBrowserWindow()
    const plansSent: Array<{ channel: string; args: unknown[] }> = []
    ;(plansHost as unknown as { webContents: { send: (channel: string, ...args: unknown[]) => void } }).webContents = {
      send: (channel, ...args) => plansSent.push({ channel, args }),
    }
    await mgr.openView(plansDesc, plansDesc.views![0], {
      hostWindow: asHost(plansHost),
      bounds: 'fill',
      workspacePath,
      capabilityContext: plansCapabilityContext,
    })
    const plansView = plansHost.children[0] as FakeViewLike

    gitView.webContents.sent.length = 0
    plansView.webContents.sent.length = 0

    // 1. Git-only Host settings: private Git receives them and both v2 views
    // receive the public editor-preference projection.
    mgr.dispatchHostSettingsChanged({
      settings: {
        'agentTeam.yolo': '0',
        'agentTeam.analyzerModel': 'qwen2:latest',
        'agent-team:theme': 'dark',
      },
    })
    expect(gitView.webContents.sent).toHaveLength(2)
    expect(gitView.webContents.sent).toContainEqual({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agentTeam.yolo': '0',
            'agentTeam.analyzerModel': 'qwen2:latest',
            'agent-team:theme': 'dark',
          },
        },
      }],
    })
    expect(plansView.webContents.sent).toHaveLength(1)
    expect(plansView.webContents.sent[0]).toMatchObject({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.editorPreferencesChanged',
        data: {
          preferences: {
            'agentTeam.yolo': '0',
            'agentTeam.analyzerModel': 'qwen2:latest',
            'agent-team:theme': 'dark',
          },
        },
      }],
    })

    gitView.webContents.sent.length = 0
    plansView.webContents.sent.length = 0

    // 2. Mixed Host settings: Git receives git settings, Plans receives ONLY language
    mgr.dispatchHostSettingsChanged({
      settings: {
        'agentTeam.yolo': '1',
        'agent-team:language': 'zh-TW',
      },
    })
    expect(gitView.webContents.sent).toHaveLength(2)
    expect(gitView.webContents.sent).toContainEqual({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agentTeam.yolo': '1',
            'agent-team:language': 'zh-TW',
          },
        },
      }],
    })
    expect(plansView.webContents.sent).toHaveLength(2)
    expect(plansView.webContents.sent).toContainEqual({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agent-team:language': 'zh-TW',
          },
        },
      }],
    })

    gitView.webContents.sent.length = 0
    plansView.webContents.sent.length = 0

    // 3. Plugin-storage settings: Git receives both the public generic event
    // and its existing private compatibility event; Plans receives nothing.
    mgr.setPublicStorageHandler(() => null)
    const handler = ipcHandlers.get(CAPABILITY_CALL)
    await handler!(
      { sender: { id: gitView.webContents.id } },
      {
        reqId: 'git-storage-1',
        ns: 'storage',
        method: 'set',
        args: { scope: 'plugin', key: 'agentTeam.git.logScope', value: 'all' },
      },
    )
    expect(gitView.webContents.sent).toHaveLength(2)
    expect(gitView.webContents.sent).toContainEqual(expect.objectContaining({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.pluginStorageChanged',
        data: {
          scope: 'plugin',
          key: 'agentTeam.git.logScope',
          value: 'all',
          deleted: false,
        },
      }],
    }))
    expect(gitView.webContents.sent).toContainEqual(expect.objectContaining({
      channel: 'plugin:cap:event',
      args: [expect.objectContaining({
        type: 'ui.settings_changed',
        data: expect.objectContaining({ source: 'plugin-storage' }),
      })],
    }))
    expect(plansView.webContents.sent).toHaveLength(0)
  })

  it('preserves legacy Git host settings filtering without language entering legacy Git fan-out', async () => {
    const mgr = new FrontendPluginManager()
    const workspacePath = '/workspace'

    // 1. Register and open legacy (recovery) Git view
    const legacyGit: PluginLaunchDescriptor = {
      id: GIT_PLUGIN_ID,
      requires: ['ui', 'git'],
      devUrl: '',
      entryFile: '/plugins/git/index.html',
    }
    mgr.registerDescriptor(legacyGit, { builtin: true })
    const gitHost = new FakeBrowserWindow()
    const gitSent: Array<{ channel: string; args: unknown[] }> = []
    ;(gitHost as unknown as { webContents: { send: (channel: string, ...args: unknown[]) => void } }).webContents = {
      send: (channel, ...args) => gitSent.push({ channel, args }),
    }
    await mgr.open(asHost(gitHost), legacyGit, 'fill')
    const legacyGitView = gitHost.children[0] as FakeViewLike

    // 2. Register and open Plans v2 view
    const plans = plansDescriptor(mgr, workspacePath, 'plans-window')
    mgr.registerDescriptor(plans, { builtin: true })
    const plansCapabilityContext = mgr.plansCapabilityContext(plans.packageVersion!, workspacePath, 'plans-window')
    const plansHost = new FakeBrowserWindow()
    await mgr.openView(plans, plans.views![0], {
      hostWindow: asHost(plansHost),
      bounds: 'fill',
      workspacePath,
      capabilityContext: plansCapabilityContext,
    })
    const plansView = plansHost.children[0] as FakeViewLike

    legacyGitView.webContents.sent.length = 0
    plansView.webContents.sent.length = 0

    // 3. Dispatch mixed host settings with both git settings and language
    mgr.dispatchHostSettingsChanged({
      settings: {
        'agentTeam.yolo': '1',
        'agent-team:language': 'zh-TW',
      },
    })

    // Plans v2 receives only language
    expect(plansView.webContents.sent).toHaveLength(2)
    expect(plansView.webContents.sent).toContainEqual({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agent-team:language': 'zh-TW',
          },
        },
      }],
    })

    // Explicit recovery Git receives only git read-only settings; language MUST NOT enter legacy Git fan-out
    expect(legacyGitView.webContents.sent).toEqual([{
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agentTeam.yolo': '1',
          },
        },
      }],
    }])

    legacyGitView.webContents.sent.length = 0
    plansView.webContents.sent.length = 0

    // 4. Dispatch language-only settings change
    mgr.dispatchHostSettingsChanged({
      settings: {
        'agent-team:language': 'en-US',
      },
    })

    // Plans v2 receives language through both the public editor contract and
    // its existing private settings contract.
    expect(plansView.webContents.sent).toHaveLength(2)
    expect(plansView.webContents.sent).toContainEqual({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agent-team:language': 'en-US',
          },
        },
      }],
    })

    // Legacy Git fan-out receives NOTHING (language is completely blocked from legacy Git)
    expect(legacyGitView.webContents.sent).toHaveLength(0)
  })

  it('routes Host-owned language settings changes to legacy Plans plugin bundle while keeping legacy Git isolated', async () => {
    const mgr = new FrontendPluginManager()

    // 1. Register and open legacy Plans view
    const legacyPlans: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      requires: ['fs', 'ui', 'plans', 'terminal'],
      devUrl: '',
      entryFile: '/plugins/plans/index.html',
    }
    mgr.registerDescriptor(legacyPlans, { builtin: true })
    const plansHost = new FakeBrowserWindow()
    await mgr.open(asHost(plansHost), legacyPlans, 'fill')
    const legacyPlansView = plansHost.children[0] as FakeViewLike

    // 2. Register and open legacy Git view
    const legacyGit: PluginLaunchDescriptor = {
      id: GIT_PLUGIN_ID,
      requires: ['ui', 'git'],
      devUrl: '',
      entryFile: '/plugins/git/index.html',
    }
    mgr.registerDescriptor(legacyGit, { builtin: true })
    const gitHost = new FakeBrowserWindow()
    await mgr.open(asHost(gitHost), legacyGit, 'fill')
    const legacyGitView = gitHost.children[0] as FakeViewLike

    legacyPlansView.webContents.sent.length = 0
    legacyGitView.webContents.sent.length = 0

    // 3. Dispatch language setting change
    mgr.dispatchHostSettingsChanged({
      settings: {
        'agent-team:language': 'en-US',
      },
    })

    // Legacy Plans receives language update
    expect(legacyPlansView.webContents.sent).toEqual([{
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'host',
          settings: {
            'agent-team:language': 'en-US',
          },
        },
      }],
    }])

    // Legacy Git receives nothing (language never enters Git)
    expect(legacyGitView.webContents.sent).toHaveLength(0)
  })

  it('dispatches authenticated navide.plans.left ui.openPlansWindow call to registered handler', async () => {
    const mgr = new FrontendPluginManager()
    const workspacePath = '/workspace'
    const packageVersion = '0.1.0'
    const viewLeft = {
      id: 'left',
      contributionKey: 'navide.plans.left',
      kind: 'custom' as const,
      location: 'left' as const,
      title: 'Plans',
      entryFile: '/path/to/plans/left.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: '/path/to/plans',
      requires: ['fs', 'ui', 'plans', 'terminal'],
      capabilityPolicy: {
        kind: 'manifest-v2',
        system: ['fs', 'ui', 'aiCli'],
        shell: 'allowlist',
        grants: [],
      },
      devUrl: '',
      entryFile: viewLeft.entryFile,
      views: [viewLeft],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.setCapabilityGrantResolver((pluginId, version) => {
      if (pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
        return {
          packageVersion,
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          storage: true,
        }
      }
      return null
    })
    const capabilityContext = mgr.plansCapabilityContext(packageVersion, workspacePath, 'plans-left')
    const host = new FakeBrowserWindow()
    await mgr.openView(descriptor, viewLeft, {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath,
      capabilityContext,
    })
    const leftView = host.children[0] as FakeViewLike

    const opens: Array<{ workspacePath: string; relPath?: string }> = []
    mgr.setOpenPlansWindowHandler(async (ws, rel) => {
      opens.push({ workspacePath: ws, relPath: rel })
      return true
    })
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))

    const handler = ipcHandlers.get(CAPABILITY_CALL)
    expect(handler).toBeDefined()

    const response = await handler!(
      { sender: { id: leftView.webContents.id } },
      {
        reqId: 'open-plan-left',
        ns: 'ui',
        method: 'openPlansWindow',
        args: { path: '.agent-team/plans/feature.html' },
      },
    )

    expect(response).toEqual({
      reqId: 'open-plan-left',
      ok: true,
      result: { opened: true },
    })
    expect(opens).toEqual([{
      workspacePath,
      relPath: '.agent-team/plans/feature.html',
    }])
  })

  it('bridges navide.plans ui.shareCaps and ui.shareCreate to share.* with codes as values', async () => {
    const mgr = new FrontendPluginManager()
    const workspacePath = '/workspace'
    const packageVersion = '0.1.0'
    const viewWindow = {
      id: 'window',
      contributionKey: 'navide.plans.window',
      kind: 'custom' as const,
      location: 'window' as const,
      title: 'Plans',
      entryFile: '/path/to/plans/window.html',
    }
    const descriptor: PluginLaunchDescriptor = {
      id: PLANS_PLUGIN_ID,
      packageVersion,
      packageDir: '/path/to/plans',
      requires: ['fs', 'ui', 'plans', 'terminal'],
      capabilityPolicy: { kind: 'manifest-v2', system: ['fs', 'ui', 'aiCli'], shell: 'allowlist', grants: [] },
      devUrl: '',
      entryFile: viewWindow.entryFile,
      views: [viewWindow],
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    mgr.setCapabilityGrantResolver((pluginId, version) => (
      pluginId === PLANS_PLUGIN_ID && version === packageVersion
        ? { packageVersion, system: ['fs', 'ui', 'aiCli'], shell: 'allowlist', storage: true }
        : null
    ))
    const capabilityContext = mgr.plansCapabilityContext(packageVersion, workspacePath, 'plans-window')
    const host = new FakeBrowserWindow()
    await mgr.openView(descriptor, viewWindow, { hostWindow: asHost(host), bounds: 'fill', workspacePath, capabilityContext })
    const view = host.children[0] as FakeViewLike
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))

    const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
    let reply: { ok: boolean; payload: unknown; error: { code: string; message: string; details?: Record<string, unknown> } | null }
    ;(mgr as unknown as { ensureBackend: () => unknown }).ensureBackend = () => ({
      send: async (type: string, payload: Record<string, unknown>) => {
        sent.push({ type, payload })
        return reply
      },
    })
    const handler = ipcHandlers.get(CAPABILITY_CALL)!
    const call = (method: string, args: Record<string, unknown>) => handler(
      { sender: { id: view.webContents.id } },
      { reqId: method, ns: 'ui', method, args },
    )

    reply = { ok: true, payload: { links: true }, error: null }
    expect(await call('shareCaps', {})).toEqual({ reqId: 'shareCaps', ok: true, result: { ok: true } })
    reply = { ok: false, payload: null, error: { code: 'NOT_CONFIGURED', message: 'not linked' } }
    expect(await call('shareCaps', {})).toEqual({
      reqId: 'shareCaps', ok: true, result: { ok: false, code: 'NOT_CONFIGURED', message: 'not linked' },
    })

    const link = {
      linkId: 'l1', url: 'https://share.example/l/l1#k', expiresAt: '2026-10-14T00:00:00Z', createdBy: 'user',
      pane: '', agent: '', masked: [{ line: 132, category: 'github-token', action: 'masked' }],
    }
    reply = { ok: true, payload: link, error: null }
    expect(await call('shareCreate', { path: '.agent-team/plans/feature.html', ttlSeconds: 259200, requireLogin: true, sendToChat: true, chatId: 'tg:111' })).toEqual({
      reqId: 'shareCreate',
      ok: true,
      result: {
        ok: true,
        link: { linkId: 'l1', url: link.url, expiresAt: link.expiresAt, masked: link.masked },
      },
    })
    expect(sent.slice(0, 3)).toEqual([
      { type: 'share.caps', payload: {} },
      { type: 'share.caps', payload: {} },
      {
        type: 'share.create',
        payload: { path: resolve(workspacePath, '.agent-team', 'plans', 'feature.html'), kind: 'plan', ttlSeconds: 259200, requireLogin: true, sendToChat: true, chatId: 'tg:111' },
      },
    ])

    reply = { ok: false, payload: null, error: { code: 'SHARE_REFUSED', message: 'never shared', details: { reason: 'memory' } } }
    expect(await call('shareCreate', { path: '.agent-team/plans/feature.html' })).toEqual({
      reqId: 'shareCreate', ok: true, result: { ok: false, code: 'SHARE_REFUSED', message: 'never shared', reason: 'memory' },
    })
    expect(sent[3].payload).toEqual({ path: resolve(workspacePath, '.agent-team', 'plans', 'feature.html'), kind: 'plan' })

    const outside = await call('shareCreate', { path: '../secrets.html' }) as { ok: boolean }
    expect(outside.ok).toBe(false)
    expect(sent).toHaveLength(4)
    // Inside the workspace but not a plan document: refused before any send.
    const notPlan = await call('shareCreate', { path: 'top_abc123.html' }) as { ok: boolean }
    expect(notPlan.ok).toBe(false)
    expect(sent).toHaveLength(4)

    reply = { ok: true, payload: { ok: true, chats: [{ chatId: 'tg:111', platform: 'telegram', name: 'Neil DM' }] }, error: null }
    expect(await call('shareChatTargets', {})).toEqual({
      reqId: 'shareChatTargets', ok: true, result: { ok: true, chats: [{ chatId: 'tg:111', platform: 'telegram', name: 'Neil DM' }] },
    })
    expect(sent[4]).toEqual({ type: 'channels.share_targets', payload: {} })
    reply = { ok: false, payload: null, error: { code: 'UNKNOWN_TYPE', message: 'old backend' } }
    expect(await call('shareChatTargets', {})).toEqual({
      reqId: 'shareChatTargets', ok: true, result: { ok: false, code: 'UNKNOWN_TYPE', message: 'old backend' },
    })
  })

  it('sends ui.shareCreate the canonical plan path, not the raw string it checked', async () => {
    const real = mkdtempSync(join(tmpdir(), 'navide-share-canonical-'))
    const linkParent = mkdtempSync(join(tmpdir(), 'navide-share-link-'))
    try {
      mkdirSync(join(real, '.agent-team', 'plans'), { recursive: true })
      writeFileSync(join(real, '.agent-team', 'plans', 'doc_abc123.html'), '<html></html>')
      const workspacePath = join(linkParent, 'ws')
      symlinkSync(real, workspacePath, 'dir')

      const mgr = new FrontendPluginManager()
      const packageVersion = '0.1.0'
      const viewWindow = {
        id: 'window', contributionKey: 'navide.plans.window', kind: 'custom' as const,
        location: 'window' as const, title: 'Plans', entryFile: '/path/to/plans/window.html',
      }
      const descriptor: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID, packageVersion, packageDir: '/path/to/plans',
        requires: ['fs', 'ui', 'plans', 'terminal'],
        capabilityPolicy: { kind: 'manifest-v2', system: ['fs', 'ui', 'aiCli'], shell: 'allowlist', grants: [] },
        devUrl: '', entryFile: viewWindow.entryFile, views: [viewWindow],
      }
      mgr.registerDescriptor(descriptor, { builtin: true })
      mgr.setCapabilityGrantResolver((pluginId, version) => (
        pluginId === PLANS_PLUGIN_ID && version === packageVersion
          ? { packageVersion, system: ['fs', 'ui', 'aiCli'], shell: 'allowlist', storage: true }
          : null
      ))
      const capabilityContext = mgr.plansCapabilityContext(packageVersion, workspacePath, 'plans-window')
      const host = new FakeBrowserWindow()
      await mgr.openView(descriptor, viewWindow, { hostWindow: asHost(host), bounds: 'fill', workspacePath, capabilityContext })
      const view = host.children[0] as FakeViewLike
      mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
      const sent: Array<Record<string, unknown>> = []
      ;(mgr as unknown as { ensureBackend: () => unknown }).ensureBackend = () => ({
        send: async (_type: string, payload: Record<string, unknown>) => {
          sent.push(payload)
          return { ok: false, payload: null, error: { code: 'SHARE_FAILED', message: 'stop' } }
        },
      })

      await ipcHandlers.get(CAPABILITY_CALL)!(
        { sender: { id: view.webContents.id } },
        { reqId: 'share', ns: 'ui', method: 'shareCreate', args: { path: '.agent-team/plans/./doc_abc123.html' } },
      )

      expect(sent).toHaveLength(1)
      expect(sent[0].path).toBe(join(realpathSync(real), '.agent-team', 'plans', 'doc_abc123.html'))
    } finally {
      rmSync(linkParent, { recursive: true, force: true })
      rmSync(real, { recursive: true, force: true })
    }
  })

  it('routes ui.openPlansWindow for nested repos strictly with .git directory and blocks .git file/symlink escape', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'navide-open-plans-test-'))
    const extDir = mkdtempSync(join(tmpdir(), 'navide-open-ext-test-'))

    try {
      const mgr = new FrontendPluginManager()
      const packageVersion = '0.1.0'
      const viewLeft = {
        id: 'left',
        contributionKey: 'navide.plans.left',
        kind: 'custom' as const,
        location: 'left' as const,
        title: 'Plans',
        entryFile: '/path/to/plans/left.html',
      }
      const descriptor: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: '/path/to/plans',
        requires: ['fs', 'ui', 'plans', 'terminal'],
        capabilityPolicy: {
          kind: 'manifest-v2',
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          grants: [],
        },
        devUrl: '',
        entryFile: viewLeft.entryFile,
        views: [viewLeft],
      }
      mgr.registerDescriptor(descriptor, { builtin: true })
      mgr.setCapabilityGrantResolver((pluginId, version) => {
        if (pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
          return {
            packageVersion,
            system: ['fs', 'ui', 'aiCli'],
            shell: 'allowlist',
            storage: true,
          }
        }
        return null
      })
      const capabilityContext = mgr.plansCapabilityContext(packageVersion, tempDir, 'plans-left')
      const host = new FakeBrowserWindow()
      await mgr.openView(descriptor, viewLeft, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: tempDir,
        capabilityContext,
      })
      const leftView = host.children[0] as FakeViewLike

      const opens: Array<{ workspacePath: string; relPath?: string }> = []
      mgr.setOpenPlansWindowHandler(async (ws, rel) => {
        opens.push({ workspacePath: ws, relPath: rel })
        return true
      })
      mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
      const handler = ipcHandlers.get(CAPABILITY_CALL)!

      // 1. Nested repo with .git directory: ALLOWED
      const nestedDir = join(tempDir, 'packages/subrepo')
      mkdirSync(join(nestedDir, '.git'), { recursive: true })
      mkdirSync(join(nestedDir, '.agent-team/plans'), { recursive: true })
      writeFileSync(join(nestedDir, '.agent-team/plans/nested.html'), '<html></html>')

      const resAllowed = await handler(
        { sender: { id: leftView.webContents.id } },
        {
          reqId: 'open-nested-allowed',
          ns: 'ui',
          method: 'openPlansWindow',
          args: { path: 'packages/subrepo/.agent-team/plans/nested.html' },
        },
      )
      expect(resAllowed).toEqual({
        reqId: 'open-nested-allowed',
        ok: true,
        result: { opened: true },
      })
      expect(opens).toContainEqual({
        workspacePath: tempDir,
        relPath: 'packages/subrepo/.agent-team/plans/nested.html',
      })

      // 2. Nested repo with .git FILE (submodule/worktree): REJECTED
      const subDir = join(tempDir, 'packages/submodule')
      mkdirSync(join(subDir, '.agent-team/plans'), { recursive: true })
      writeFileSync(join(subDir, '.git'), 'gitdir: ../../.git/modules/submodule\n')
      writeFileSync(join(subDir, '.agent-team/plans/sub.html'), '<html></html>')

      const resGitFile = await handler(
        { sender: { id: leftView.webContents.id } },
        {
          reqId: 'open-git-file-rejected',
          ns: 'ui',
          method: 'openPlansWindow',
          args: { path: 'packages/submodule/.agent-team/plans/sub.html' },
        },
      )
      expect(resGitFile).toEqual({
        reqId: 'open-git-file-rejected',
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'public capability failed' },
      })

      // 3. Symlink escape: REJECTED
      const extPlanDir = join(extDir, '.agent-team/plans')
      mkdirSync(extPlanDir, { recursive: true })
      writeFileSync(join(extPlanDir, 'ext.html'), '<html></html>')
      symlinkSync(extPlanDir, join(tempDir, 'linked-plans'), 'dir')

      const resSymlink = await handler(
        { sender: { id: leftView.webContents.id } },
        {
          reqId: 'open-symlink-rejected',
          ns: 'ui',
          method: 'openPlansWindow',
          args: { path: 'linked-plans/ext.html' },
        },
      )
      expect(resSymlink).toEqual({
        reqId: 'open-symlink-rejected',
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'public capability failed' },
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(extDir, { recursive: true, force: true })
    }
  })

  it('routes ui.openInEditor rejecting raw workspace absolute path and accepting relative path', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'navide-open-editor-test-'))
    try {
      const plansDir = join(tempDir, '.agent-team/plans')
      mkdirSync(plansDir, { recursive: true })
      writeFileSync(join(plansDir, 'feature.html'), '<html></html>')

      const mgr = new FrontendPluginManager()
      const packageVersion = '0.1.0'
      const viewLeft = {
        id: 'left',
        contributionKey: 'navide.plans.left',
        kind: 'custom' as const,
        location: 'left' as const,
        title: 'Plans',
        entryFile: '/path/to/plans/left.html',
      }
      const descriptor: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: '/path/to/plans',
        requires: ['fs', 'ui', 'plans', 'terminal'],
        capabilityPolicy: {
          kind: 'manifest-v2',
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          grants: [],
        },
        devUrl: '',
        entryFile: viewLeft.entryFile,
        views: [viewLeft],
      }
      mgr.registerDescriptor(descriptor, { builtin: true })
      mgr.setCapabilityGrantResolver((pluginId, version) => {
        if (pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
          return {
            packageVersion,
            system: ['fs', 'ui', 'aiCli'],
            shell: 'allowlist',
            storage: true,
          }
        }
        return null
      })
      const capabilityContext = mgr.plansCapabilityContext(packageVersion, tempDir, 'plans-left')
      const host = new FakeBrowserWindow()
      await mgr.openView(descriptor, viewLeft, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: tempDir,
        capabilityContext,
      })
      const leftView = host.children[0] as FakeViewLike

      const editorCalls: Array<Record<string, string>> = []
      mgr.setOpenInEditorHandler((params) => {
        editorCalls.push(params)
        return true
      })
      mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))

      const handler = ipcHandlers.get(CAPABILITY_CALL)
      expect(handler).toBeDefined()

      // 1. Raw absolute path within workspace: REJECTED, handler NOT called
      const absPath = join(tempDir, '.agent-team/plans/feature.html')
      const resAbs = await handler!(
        { sender: { id: leftView.webContents.id } },
        {
          reqId: 'open-editor-abs-rejected',
          ns: 'ui',
          method: 'openInEditor',
          args: { path: absPath },
        },
      )
      expect(resAbs).toEqual({
        reqId: 'open-editor-abs-rejected',
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'public capability failed' },
      })
      expect(editorCalls).toHaveLength(0)

      // 2. Valid relative plan path: ACCEPTED, handler called with normalized relative path
      const resRel = await handler!(
        { sender: { id: leftView.webContents.id } },
        {
          reqId: 'open-editor-rel-accepted',
          ns: 'ui',
          method: 'openInEditor',
          args: { path: '.agent-team/plans/feature.html' },
        },
      )
      expect(resRel).toEqual({
        reqId: 'open-editor-rel-accepted',
        ok: true,
        result: { opened: true },
      })
      expect(editorCalls).toEqual([
        {
          workspace_path: resolve(tempDir),
          filepath: join('.agent-team', 'plans', 'feature.html'),
        },
      ])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('opens a plan source reference for a user click but not for an MCP agent', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'navide-plan-source-ref-'))
    try {
      const plansDir = join(tempDir, '.agent-team/plans')
      mkdirSync(plansDir, { recursive: true })
      writeFileSync(join(plansDir, 'feature.html'), '<html></html>')
      mkdirSync(join(tempDir, 'src/main'), { recursive: true })
      writeFileSync(join(tempDir, 'src/main/index.ts'), 'export {}\n')

      const mgr = new FrontendPluginManager()
      const packageVersion = '0.1.0'
      const viewLeft = {
        id: 'left',
        contributionKey: 'navide.plans.left',
        kind: 'custom' as const,
        location: 'left' as const,
        title: 'Plans',
        entryFile: '/path/to/plans/left.html',
      }
      const descriptor: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: '/path/to/plans',
        requires: ['fs', 'ui', 'plans', 'terminal'],
        capabilityPolicy: {
          kind: 'manifest-v2',
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          grants: [],
        },
        devUrl: '',
        entryFile: viewLeft.entryFile,
        views: [viewLeft],
      }
      mgr.registerDescriptor(descriptor, { builtin: true })
      mgr.setCapabilityGrantResolver((pluginId, version) => {
        if (pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
          return {
            packageVersion,
            system: ['fs', 'ui', 'aiCli'],
            shell: 'allowlist',
            storage: true,
          }
        }
        return null
      })
      mgr.setExecutionPolicyResolver(() => ({
        policy: { schemaVersion: 1, mode: 'full', system: [], shell: [] },
        revision: 1,
        state: 'user',
      }))
      const capabilityContext = mgr.plansCapabilityContext(packageVersion, tempDir, 'plans-left')
      const host = new FakeBrowserWindow()
      const handle = await mgr.openView(descriptor, viewLeft, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: tempDir,
        capabilityContext,
      })
      const leftView = host.children[0] as FakeViewLike

      const editorCalls: Array<Record<string, string>> = []
      mgr.setOpenInEditorHandler((params) => {
        editorCalls.push(params)
        return true
      })
      mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))

      const handler = ipcHandlers.get(CAPABILITY_CALL)
      expect(handler).toBeDefined()

      // 1. A user click on a `file:line` reference inside a plan: ACCEPTED
      const resSource = await handler!(
        { sender: { id: leftView.webContents.id } },
        {
          reqId: 'plan-source-accepted',
          ns: 'ui',
          method: 'openInEditor',
          args: { path: 'src/main/index.ts', line: 42 },
        },
      )
      expect(resSource).toEqual({
        reqId: 'plan-source-accepted',
        ok: true,
        result: { opened: true },
      })
      expect(editorCalls).toEqual([
        {
          workspace_path: resolve(tempDir),
          filepath: join('src', 'main', 'index.ts'),
          line: '42',
        },
      ])

      // 2. A user click on a path outside the workspace: REJECTED
      const resEscape = await handler!(
        { sender: { id: leftView.webContents.id } },
        {
          reqId: 'plan-source-escape-rejected',
          ns: 'ui',
          method: 'openInEditor',
          args: { path: '../outside.ts' },
        },
      )
      expect(resEscape).toEqual({
        reqId: 'plan-source-escape-rejected',
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'public capability failed' },
      })
      expect(editorCalls).toHaveLength(1)

      // 3. The same in-workspace source path from an MCP agent: REJECTED
      const resAgentSource = await mgr.executeAgentCapability(handle.instanceId, {
        reqId: 'plan-source-agent-rejected',
        ns: 'ui',
        method: 'openInEditor',
        args: { path: 'src/main/index.ts', line: 42 },
      })
      expect(resAgentSource).toEqual({
        reqId: 'plan-source-agent-rejected',
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'public capability failed' },
      })
      expect(editorCalls).toHaveLength(1)

      // 4. An MCP agent keeps its plan-document reach
      const resAgentPlan = await mgr.executeAgentCapability(handle.instanceId, {
        reqId: 'plan-doc-agent-accepted',
        ns: 'ui',
        method: 'openInEditor',
        args: { path: '.agent-team/plans/feature.html' },
      })
      expect(resAgentPlan).toEqual({
        reqId: 'plan-doc-agent-accepted',
        ok: true,
        result: { opened: true },
      })
      expect(editorCalls).toHaveLength(2)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('labels plugin storage changes so the settings facade accepts only its owned scope', async () => {
    const { mgr, view } = await openGitView()
    mgr.setPublicStorageHandler(() => null)
    const handler = ipcHandlers.get(CAPABILITY_CALL)
    expect(handler).toBeDefined()

    const response = await handler!({ sender: { id: view.webContents.id } }, {
      reqId: 'git-storage-owned-key',
      ns: 'storage',
      method: 'set',
      args: { scope: 'plugin', key: 'agentTeam.git.logScope', value: 'all' },
    })

    expect(response).toEqual({ reqId: 'git-storage-owned-key', ok: true, result: null })
    expect(view.webContents.sent).toContainEqual({
      channel: 'plugin:cap:event',
      args: [{
        type: 'ui.settings_changed',
        data: {
          source: 'plugin-storage',
          scope: 'plugin',
          settings: { 'agentTeam.git.logScope': 'all' },
        },
      }],
    })
  })

  it('routes a validated contribution to its own Host window only', async () => {
    const first = await openGitView()
    const descriptor = gitDescriptor(first.mgr)
    const secondHost = new FakeBrowserWindow()
    const secondSent: Array<{ channel: string; args: unknown[] }> = []
    ;(secondHost as unknown as { webContents: { send: (channel: string, ...args: unknown[]) => void } }).webContents = {
      send: (channel, ...args) => secondSent.push({ channel, args }),
    }
    await first.mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(secondHost),
      bounds: 'fill',
      workspacePath: '/other',
      capabilityContext: first.mgr.gitCapabilityContext('1.0.0', '/other', 'git-window'),
    })

    const response = await call(first.view, 'git.contribution', {
      operation: 'changes_count',
      payload: { count: 4, workspace_path: '/workspace' },
    })

    expect(response).toEqual({ reqId: 'git-1', ok: true, result: { accepted: true } })
    expect(first.sent).toEqual([{
      channel: 'git:contribution-action',
      args: [{ operation: 'changes_count', payload: { count: 4, workspace_path: '/workspace' } }],
    }])
    expect(secondSent).toEqual([])

    const windowResponse = await call(secondHost.children[0] as FakeViewLike, 'git.contribution', {
      operation: 'changes_count',
      payload: { count: 1, workspace_path: '/other' },
    }, 'git-window-contribution')
    expect(windowResponse).toMatchObject({
      reqId: 'git-window-contribution',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })

    const handler = ipcHandlers.get(HOST_CALL)
    const rejected = await handler!({ sender: { id: first.view.webContents.id } }, {
      reqId: 'git-2',
      action: 'git.contribution',
      args: {
        operation: 'changes_count',
        payload: { count: 2, workspace_path: '/other' },
      },
      instanceId: 'forged',
    }) as Record<string, unknown>
    expect(rejected).toEqual({
      reqId: '',
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'instance identity is Host-owned' },
    })
  })

  it('projects only the bound workspace legacy repository selection', async () => {
    const { mgr, view } = await openGitView('/workspace')
    mgr.setBackendWsUrl('ws://git-legacy-selection-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()

    const selection = call(view, 'git.legacyRepoSelection', {
      workspace_path: '/renderer-forged',
      packageVersion: 'renderer-forged',
    }, 'git-legacy-selection')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0]!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(request).toMatchObject({
      type: 'project.peek',
      payload: { workspace_path: resolve('/workspace') },
    })
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: {
        project: {
          ui_git_tab_repo: '/workspace/nested',
          task_description: 'must not cross the private projection',
        },
      },
      error: null,
      timestamp: '',
    })

    await expect(selection).resolves.toEqual({
      reqId: 'git-legacy-selection',
      ok: true,
      result: { selection: '/workspace/nested' },
    })
  })

  it('requires nested Git actions to carry the bound workspace', async () => {
    const { view, sent } = await openGitView()

    const missingWorkspace = await call(view, 'git.contribution', {
      operation: 'open_file',
      payload: { filepath: 'src/app.ts', name: 'app.ts' },
    }, 'git-missing-workspace')
    expect(missingWorkspace).toMatchObject({
      reqId: 'git-missing-workspace',
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })

    const outsideWorkspace = await call(view, 'git.contribution', {
      operation: 'open_diff',
      payload: {
        workspace_path: '/other',
        filepath: 'src/app.ts',
        staged: false,
        name: 'app.ts',
      },
    }, 'git-outside-workspace')
    expect(outsideWorkspace).toMatchObject({
      reqId: 'git-outside-workspace',
      ok: false,
      error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
    })

    const accepted = await call(view, 'git.contribution', {
      operation: 'open_branch_diff',
      payload: { workspace_path: '/workspace/repo', base: 'main', compare: 'feature' },
    }, 'git-bound-workspace')
    expect(accepted).toEqual({ reqId: 'git-bound-workspace', ok: true, result: { accepted: true } })
    expect(sent.at(-1)).toEqual({
      channel: 'git:contribution-action',
      args: [{
        operation: 'open_branch_diff',
        payload: { workspace_path: '/workspace/repo', base: 'main', compare: 'feature' },
      }],
    })
  })

  it.each([
    ['open_file', { workspace_path: '/workspace', filepath: '../../outside.txt', name: 'outside.txt' }],
    ['open_conflict', { workspace_path: '/workspace', filepath: '../../outside.txt', name: 'outside.txt' }],
    ['open_diff', { workspace_path: '/workspace', filepath: '../../outside.txt', staged: false, name: 'outside.txt' }],
    ['open_git_window', { workspace_path: '/workspace', filepath: '../../outside.txt' }],
    ['open_file', { workspace_path: '/workspace', filepath: '/absolute/outside.txt', name: 'outside.txt' }],
    ['open_conflict', { workspace_path: '/workspace', filepath: '/absolute/outside.txt', name: 'outside.txt' }],
    ['open_diff', { workspace_path: '/workspace', filepath: '/absolute/outside.txt', staged: false, name: 'outside.txt' }],
    ['open_git_window', { workspace_path: '/workspace', filepath: '/absolute/outside.txt' }],
  ] as const)('rejects an out-of-workspace %s filepath (%s)', async (operation, payload) => {
    const { view, sent } = await openGitView()

    const response = await call(view, 'git.contribution', { operation, payload }, `git-outside-file-${operation}`)

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
    })
    expect(sent).toEqual([])
  })

  it('accepts an in-workspace relative contribution filepath', async () => {
    const { view, sent } = await openGitView()

    const response = await call(view, 'git.contribution', {
      operation: 'open_file',
      payload: { workspace_path: '/workspace', filepath: 'src/app.ts', name: 'app.ts' },
    }, 'git-in-workspace-file')

    expect(response).toEqual({ reqId: 'git-in-workspace-file', ok: true, result: { accepted: true } })
    expect(sent).toEqual([{
      channel: 'git:contribution-action',
      args: [{
        operation: 'open_file',
        payload: { workspace_path: '/workspace', filepath: 'src/app.ts', name: 'app.ts' },
      }],
    }])
  })

  it('accepts open_workspace only with the exact one-time Host picker grant', async () => {
    const { mgr, view, sent } = await openGitView()
    mgr.setHostShellHandlers({
      openExternal: async () => ({ ok: true }),
      revealPath: () => ({ ok: true }),
      openWorkspace: () => ({ ok: true }),
      pickFolder: async () => '/picked/workspace',
    })

    const picked = await call(view, 'git.contribution', {
      operation: 'pick_workspace',
      payload: {},
    }, 'pick-workspace')
    const grant = (picked.result as { grant?: unknown }).grant
    expect(picked).toMatchObject({
      reqId: 'pick-workspace',
      ok: true,
      result: { path: resolve('/picked/workspace') },
    })
    expect(typeof grant).toBe('string')

    await expect(call(view, 'git.contribution', {
      operation: 'open_workspace',
      payload: { path: '/picked/sibling', grant },
    }, 'forged-workspace')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })

    await expect(call(view, 'git.contribution', {
      operation: 'open_workspace',
      payload: { path: '/picked/workspace', grant },
    }, 'open-picked-workspace')).resolves.toEqual({
      reqId: 'open-picked-workspace',
      ok: true,
      result: { accepted: true },
    })
    expect(sent).toEqual([{
      channel: 'git:contribution-action',
      args: [{ operation: 'open_workspace', payload: { path: resolve('/picked/workspace') } }],
    }])

    await expect(call(view, 'git.contribution', {
      operation: 'open_workspace',
      payload: { path: '/picked/workspace', grant },
    }, 'replayed-workspace')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('opens only an authoritative worktree from the bound git-window workspace', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-worktree-root-'))
    const worktreePath = mkdtempSync(join(tmpdir(), 'navide-git-worktree-known-'))
    const unknownPath = mkdtempSync(join(tmpdir(), 'navide-git-worktree-unknown-'))
    try {
      const { mgr, view } = await openGitView(workspacePath, 'git-window')
      mgr.setBackendWsUrl('ws://git-worktree-open-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()
      const openWorkspace = vi.fn(() => ({ ok: true }))
      mgr.setHostShellHandlers({
        openExternal: async () => ({ ok: true }),
        revealPath: () => ({ ok: true }),
        openWorkspace,
        pickFolder: async () => null,
      })

      const openKnown = call(view, 'git.contribution', {
        operation: 'open_worktree',
        payload: { path: worktreePath },
      }, 'open-known-worktree')
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
      const knownRequest = JSON.parse(socket.sent[0]!)
      expect(knownRequest).toMatchObject({
        type: 'git.worktrees',
        payload: { workspace_path: workspacePath },
      })
      socket.receive({
        id: knownRequest.id,
        type: knownRequest.type,
        ok: true,
        payload: { worktrees: [{ path: worktreePath }] },
        error: null,
        timestamp: '',
      })
      await expect(openKnown).resolves.toEqual({
        reqId: 'open-known-worktree',
        ok: true,
        result: { accepted: true },
      })
      expect(openWorkspace).toHaveBeenCalledWith(realpathSync(worktreePath))

      const openUnknown = call(view, 'git.contribution', {
        operation: 'open_worktree',
        payload: { path: unknownPath },
      }, 'open-unknown-worktree')
      await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
      const unknownRequest = JSON.parse(socket.sent[1]!)
      socket.receive({
        id: unknownRequest.id,
        type: unknownRequest.type,
        ok: true,
        payload: { worktrees: [{ path: worktreePath }] },
        error: null,
        timestamp: '',
      })
      await expect(openUnknown).resolves.toMatchObject({
        reqId: 'open-unknown-worktree',
        ok: false,
        error: { code: 'CAPABILITY_DENIED' },
      })
      expect(openWorkspace).toHaveBeenCalledTimes(1)

      const rejectedLookup = call(view, 'git.contribution', {
        operation: 'open_worktree',
        payload: { path: worktreePath },
      }, 'rejected-worktree-lookup')
      await vi.waitFor(() => expect(socket.sent).toHaveLength(3))
      const rejectedRequest = JSON.parse(socket.sent[2]!)
      socket.receive({
        id: rejectedRequest.id,
        type: rejectedRequest.type,
        ok: false,
        payload: null,
        error: { code: 'GIT_ERROR', message: 'worktrees unavailable' },
        timestamp: '',
      })
      await expect(rejectedLookup).resolves.toMatchObject({
        reqId: 'rejected-worktree-lookup',
        ok: false,
        error: { code: 'BACKEND_ERROR', message: 'worktrees unavailable' },
      })
      expect(openWorkspace).toHaveBeenCalledTimes(1)

      const leftView = await openGitView(workspacePath, 'git-left')
      await expect(call(leftView.view, 'git.contribution', {
        operation: 'open_worktree',
        payload: { path: worktreePath },
      }, 'left-open-worktree')).resolves.toMatchObject({
        reqId: 'left-open-worktree',
        ok: false,
        error: { code: 'CAPABILITY_DENIED' },
      })
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(worktreePath, { recursive: true, force: true })
      rmSync(unknownPath, { recursive: true, force: true })
    }
  })

  it('denies the generic UI route so an arbitrary path cannot become a workspace root', async () => {
    const { view } = await openGitView()

    await expect(call(view, 'ui.request', {
      type: 'ui.open_workspace',
      payload: { workspace_path: '/' },
    }, 'generic-open-workspace')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('routes git.changed once to its matching v2 workspace without blocking a legal legacy subscriber', async () => {
    const first = await openGitView('/workspace')
    const secondHost = new FakeBrowserWindow()
    const secondDescriptor = gitDescriptor(first.mgr, '/other-workspace')
    await first.mgr.openView(secondDescriptor, secondDescriptor.views![0], {
      hostWindow: asHost(secondHost),
      bounds: 'fill',
      workspacePath: '/other-workspace',
      capabilityContext: secondDescriptor.capabilityContext,
    })
    const legacyHost = new FakeBrowserWindow()
    first.mgr.open(asHost(legacyHost), {
      id: 'acme.fs-subscriber',
      requires: ['fs'],
      devUrl: '',
      entryFile: '/plugins/acme.fs-subscriber/index.html',
    }, { x: 0, y: 0, width: 10, height: 10 })

    const dispatch = first.mgr as unknown as {
      dispatchEvent(event: string, payload: unknown, binding?: unknown, targetPluginId?: string): void
    }
    dispatch.dispatchEvent('git.changed', { workspace_path: '/workspace' })
    const events = (view: FakeViewLike) => view.webContents.sent
      .filter((message) => message.channel === 'plugin:cap:event')
      .map((message) => message.args[0] as { type: string })
      .filter((message) => message.type === 'git.changed')
    expect(events(first.view)).toHaveLength(1)
    expect(events(secondHost.children[0] as FakeViewLike)).toHaveLength(0)
    expect(events(legacyHost.children[0] as FakeViewLike)).toHaveLength(1)

    dispatch.dispatchEvent('git.changed', { workspace_path: '/workspace' }, undefined, 'acme.fs-subscriber')
    expect(events(first.view)).toHaveLength(1)
    expect(events(legacyHost.children[0] as FakeViewLike)).toHaveLength(2)
  })

  it('rejects picker grants from another instance, after expiry, and for clone sibling traversal', async () => {
    const first = await openGitView()
    first.mgr.setHostShellHandlers({
      openExternal: async () => ({ ok: true }),
      revealPath: () => ({ ok: true }),
      openWorkspace: () => ({ ok: true }),
      pickFolder: async () => '/picked',
    })
    const descriptor = gitDescriptor(first.mgr)
    const secondHost = new FakeBrowserWindow()
    await first.mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(secondHost),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: first.mgr.gitCapabilityContext('1.0.0', '/workspace', 'git-left'),
    })
    const firstPick = await call(first.view, 'git.contribution', { operation: 'pick_workspace', payload: {} }, 'first-pick')
    const firstGrant = (firstPick.result as { grant: string }).grant

    await expect(call(secondHost.children[0] as FakeViewLike, 'git.contribution', {
      operation: 'open_workspace',
      payload: { path: '/picked', grant: firstGrant },
    }, 'wrong-instance')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })

    const now = Date.now()
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    const expiringPick = await call(first.view, 'git.contribution', { operation: 'pick_workspace', payload: {} }, 'expiring-pick')
    const expiringGrant = (expiringPick.result as { grant: string }).grant
    dateNow.mockReturnValue(now + (5 * 60 * 1000) + 1)
    await expect(call(first.view, 'git.contribution', {
      operation: 'open_workspace',
      payload: { path: '/picked', grant: expiringGrant },
    }, 'expired-grant')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    dateNow.mockRestore()

    first.mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => 'account',
      getCredential: () => ({ username: 'alice', token: 'fixture-secret', expectedHost: 'github.com' }),
    })
    const clonePick = await call(first.view, 'git.contribution', { operation: 'pick_workspace', payload: {} }, 'clone-pick')
    await expect(call(first.view, 'git.request', {
      type: 'git.clone',
      payload: {
        workspace_path: '/workspace',
        url: 'https://github.com/acme/repo.git',
        target_dir: '/picked/../sibling',
        target_grant: (clonePick.result as { grant: string }).grant,
      },
    }, 'clone-sibling-traversal')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('rejects Git contribution paths through a symlink to an outside target', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-workspace-'))
    const outsidePath = mkdtempSync(join(tmpdir(), 'navide-git-outside-'))
    try {
      writeFileSync(join(outsidePath, 'secret.txt'), 'secret')
      symlinkSync(outsidePath, join(workspacePath, 'link'), 'dir')
      const { view, sent } = await openGitView(workspacePath)
      const actions = [
        {
          operation: 'open_file',
          payload: { workspace_path: workspacePath, filepath: 'link/secret.txt', name: 'secret.txt' },
        },
        {
          operation: 'open_conflict',
          payload: { workspace_path: workspacePath, filepath: 'link/secret.txt', name: 'secret.txt' },
        },
        {
          operation: 'open_diff',
          payload: { workspace_path: workspacePath, filepath: 'link/secret.txt', staged: false, name: 'secret.txt' },
        },
        {
          operation: 'open_git_window',
          payload: { workspace_path: workspacePath, filepath: 'link/secret.txt' },
        },
        {
          operation: 'open_path',
          payload: { path: join(workspacePath, 'link', 'secret.txt') },
        },
      ] as const

      for (const [index, action] of actions.entries()) {
        const response = await call(view, 'git.contribution', action, `git-symlink-outside-${index}`)
        expect(response).toMatchObject({
          ok: false,
          error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
        })
      }
      expect(sent).toEqual([])
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(outsidePath, { recursive: true, force: true })
    }
  })

  it('keeps private fs.stat_path inside the symlink-aware workspace boundary', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-stat-workspace-'))
    const outsidePath = mkdtempSync(join(tmpdir(), 'navide-git-stat-outside-'))
    try {
      symlinkSync(outsidePath, join(workspacePath, 'outside-link'), 'dir')
      symlinkSync(join(workspacePath, 'missing-target'), join(workspacePath, 'dangling-link'), 'file')
      const { mgr, view } = await openGitView(workspacePath)
      mgr.setBackendWsUrl('ws://git-stat-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()

      for (const path of ['../outside', 'outside-link', 'dangling-link']) {
        await expect(call(view, 'fs.request', {
          type: 'fs.stat_path',
          payload: { workspace_path: workspacePath, path },
        }, `stat-${path}`)).resolves.toMatchObject({
          ok: false,
          error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
        })
      }
      expect(socket.sent).toEqual([])
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(outsidePath, { recursive: true, force: true })
    }
  })

  it('targets a Git repository nested inside the workspace and still rejects outside roots', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-nested-workspace-'))
    const outsidePath = mkdtempSync(join(tmpdir(), 'navide-git-nested-outside-'))
    try {
      const nestedPath = join(workspacePath, 'nested')
      mkdirSync(nestedPath)
      const { mgr, view } = await openGitView(workspacePath)
      mgr.setBackendWsUrl('ws://git-nested-repo-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()

      // Multi-repo mode gives every repository tab the repository's own
      // absolute path, so a nested repo has to reach the backend as itself.
      const nested = call(view, 'git.request', {
        type: 'git.status',
        payload: { workspace_path: nestedPath },
      }, 'git-nested-status')
      await Promise.resolve()
      const nestedRequest = JSON.parse(socket.sent.at(-1)!) as {
        id: string
        type: string
        payload: Record<string, unknown>
      }
      expect(nestedRequest.type).toBe('git.status')
      expect(nestedRequest.payload).toEqual({ workspace_path: realpathSync(nestedPath) })
      socket.receive({
        id: nestedRequest.id,
        type: nestedRequest.type,
        ok: true,
        payload: { ok: true },
        error: null,
        timestamp: '',
      })
      await expect(nested).resolves.toMatchObject({ ok: true })

      // The workspace root keeps the exact binding the view was opened with.
      const root = call(view, 'git.request', {
        type: 'git.status',
        payload: { workspace_path: workspacePath },
      }, 'git-root-status')
      await Promise.resolve()
      const rootRequest = JSON.parse(socket.sent.at(-1)!) as {
        id: string
        type: string
        payload: Record<string, unknown>
      }
      expect(rootRequest.payload).toEqual({ workspace_path: workspacePath })
      socket.receive({
        id: rootRequest.id,
        type: rootRequest.type,
        ok: true,
        payload: { ok: true },
        error: null,
        timestamp: '',
      })
      await expect(root).resolves.toMatchObject({ ok: true })

      const forwarded = socket.sent.length
      const denied = [outsidePath, join(workspacePath, '..'), join(nestedPath, '..', '..'), '']
      for (const [index, candidate] of denied.entries()) {
        await expect(call(view, 'git.request', {
          type: 'git.status',
          payload: { workspace_path: candidate },
        }, `git-nested-outside-${index}`)).resolves.toMatchObject({
          ok: false,
          error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
        })
      }
      expect(socket.sent.length).toBe(forwarded)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(outsidePath, { recursive: true, force: true })
    }
  })

  it('prewarms Git hidden, deactivated, and reuses the instance when opened', async () => {
    const mgr = new FrontendPluginManager()
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-prewarm-workspace-'))
    try {
      const descriptor = gitDescriptor(mgr, workspacePath, 'git-left')
      mgr.registerDescriptor(descriptor, { builtin: true })
      mgr.setCapabilityGrantResolver(() => descriptor.capabilityContext?.userGrant ?? null)
      const host = new FakeBrowserWindow()

      await expect(mgr.ensureContribution(asHost(host), 'navide.git.left', {
        workspacePath,
        capabilityContext: descriptor.capabilityContext,
      })).resolves.toEqual({ ok: true })

      const hidden = host.children[0] as FakeViewLike
      expect(hidden.visible).toBe(false)
      const running = (mgr as unknown as {
        running: Map<string, { view: FakeViewLike }>
        contributionInstances: Map<string, { instanceId: string }>
      }).running
      const instanceId = [...running.keys()][0]
      expect(instanceId).toBeDefined()
      ;(mgr as unknown as {
        dispatchEvent(event: string, payload: unknown): void
      }).dispatchEvent('git.changed', { workspace_path: workspacePath, changes_count: 4 })
      expect(hidden.webContents.sent).toContainEqual({
        channel: 'plugin:cap:event',
        args: [{ type: 'git.changed', data: { workspace_path: workspacePath, changes_count: 4 } }],
      })

      await expect(mgr.openContribution(asHost(host), 'navide.git.left', {
        workspacePath,
        bounds: { x: 0, y: 0, width: 320, height: 480 },
        capabilityContext: descriptor.capabilityContext,
      })).resolves.toEqual({ ok: true })
      expect(hidden.visible).toBe(true)
      expect([...running.keys()]).toEqual([instanceId])
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('rejects first-party filesystem mutations inside the Git metadata tree', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-mutation-workspace-'))
    try {
      mkdirSync(join(workspacePath, '.git'))
      writeFileSync(join(workspacePath, '.git', 'config'), '[core]\n')
      writeFileSync(join(workspacePath, 'ordinary.txt'), 'ordinary')
      const { mgr, view } = await openGitView(workspacePath)
      mgr.setBackendWsUrl('ws://git-mutation-boundary-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()

      const requests = [
        {
          type: 'fs.write_file',
          payload: { workspace_path: workspacePath, rel_path: '.git/config', content: 'changed' },
        },
        {
          type: 'fs.write_file',
          payload: { workspace_path: workspacePath, rel_path: '.git\\config', content: 'changed' },
        },
        {
          type: 'fs.delete',
          payload: { workspace_path: workspacePath, rel_path: '.git/config' },
        },
        {
          type: 'fs.rename',
          payload: { workspace_path: workspacePath, src_rel: 'ordinary.txt', dst_rel: '.git/moved' },
        },
        {
          type: 'fs.rename',
          payload: { workspace_path: workspacePath, src_rel: '.git/config', dst_rel: 'moved' },
        },
      ] as const

      for (const [index, request] of requests.entries()) {
        await expect(call(view, 'fs.request', request, `git-mutation-${index}`)).resolves.toMatchObject({
          ok: false,
          error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
        })
      }
      expect(socket.sent).toEqual([])
      expect(readFileSync(join(workspacePath, 'ordinary.txt'), 'utf8')).toBe('ordinary')
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('rejects public fs.writeFile before it reaches the backend for Git metadata', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-public-fs-workspace-'))
    try {
      mkdirSync(join(workspacePath, '.git'))
      writeFileSync(join(workspacePath, '.git', 'config'), '[core]\n')
      const { mgr } = await openGitView(workspacePath)
      mgr.setBackendWsUrl('ws://public-fs-mutation-boundary-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()
      const runtime = (
        mgr as unknown as {
          running: Map<string, { capabilityContext: HostCapabilityContext }>
        }
      ).running.get([...(
        mgr as unknown as { running: Map<string, unknown> }
      ).running.keys()][0]!)!.capabilityContext.runtimeBinding!

      await expect(mgr.executePublicCapability({
        kind: 'public',
        address: 'fs.writeFile',
        scope: 'workspace',
        runtime,
        args: { path: '.git/config', content: 'changed' },
      })).rejects.toThrow(/Git metadata/)
      expect(socket.sent).toEqual([])
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('forwards public filesystem encoding and editor metadata without dropping backend conflicts', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-public-fs-editor-metadata-'))
    try {
      const { mgr } = await openGitView(workspacePath)
      mgr.setBackendWsUrl('ws://public-fs-editor-metadata-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()
      const runtime = (
        mgr as unknown as {
          running: Map<string, { capabilityContext: HostCapabilityContext }>
        }
      ).running.get([...(
        mgr as unknown as { running: Map<string, unknown> }
      ).running.keys()][0]!)!.capabilityContext.runtimeBinding!

      const dispatch = async (address: 'fs.readFile' | 'fs.writeFile', args: Record<string, unknown>, response: unknown) => {
        const pending = mgr.executePublicCapability({
          kind: 'public', address, scope: 'workspace', runtime, args,
        })
        await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
        const request = JSON.parse(socket.sent.pop()!) as { id: string; type: string; payload: Record<string, unknown> }
        socket.receive({ id: request.id, type: request.type, ok: true, payload: response, error: null, timestamp: '' })
        return { request, result: await pending }
      }

      const read = await dispatch('fs.readFile', { path: 'document.txt', encoding: 'utf16le' }, {
        ok: true,
        content: 'ok',
        encoding: 'UTF-16LE',
        bom: true,
        mtime: 123,
        size: 2,
        ext: '.txt',
      })
      expect(read.request.payload).toEqual({ workspace_path: workspacePath, rel_path: 'document.txt', encoding_override: 'utf16le' })
      expect(read.result).toEqual({
        ok: true,
        content: 'ok',
        encoding: 'UTF-16LE',
        bom: true,
        mtime: 123,
        size: 2,
        ext: '.txt',
      })

      const binary = await dispatch('fs.readFile', { path: 'image.bin' }, {
        ok: false,
        error: 'Binary file',
        is_binary: true,
        is_image: false,
        size: 4,
        ext: '.bin',
      })
      expect(binary.result).toEqual({
        ok: false,
        error: 'Binary file',
        is_binary: true,
        is_image: false,
        size: 4,
        ext: '.bin',
        content: '',
      })

      const failed = await dispatch('fs.readFile', { path: 'missing.txt' }, {
        ok: false,
        error: 'File not found',
        size: 0,
        ext: '.txt',
      })
      expect(failed.result).toEqual({
        ok: false,
        error: 'File not found',
        size: 0,
        ext: '.txt',
        content: '',
      })

      const write = await dispatch('fs.writeFile', {
        path: 'document.txt', content: 'updated', encoding: 'utf8', expectedMtime: 0,
      }, { ok: true })
      expect(write.request.payload).toEqual({
        workspace_path: workspacePath, rel_path: 'document.txt', content: 'updated', encoding: 'utf8', expected_mtime: 0,
      })

      const omitted = await dispatch('fs.writeFile', { path: 'document.txt', content: 'updated again' }, { ok: false, conflict: true })
      expect(omitted.request.payload).toEqual({ workspace_path: workspacePath, rel_path: 'document.txt', content: 'updated again' })
      expect(omitted.result).toEqual({ ok: false, conflict: true })
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('routes external selected read, write, and stat requests to the selected file workspace', async () => {
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'navide-public-fs-selected-workspace-')))
    const externalPath = realpathSync(mkdtempSync(join(tmpdir(), 'navide-public-fs-selected-external-')))
    try {
      writeFileSync(join(externalPath, 'notes.txt'), 'external')
      const { mgr } = await openGitView(workspacePath)
      mgr.setBackendWsUrl('ws://public-fs-selected-file-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()
      const running = (mgr as unknown as {
        running: Map<string, { capabilityContext: HostCapabilityContext }>
      }).running
      const instanceId = [...running.keys()].at(-1)!
      const runtime = running.get(instanceId)!.capabilityContext.runtimeBinding!
      const selectionGrants = (mgr as unknown as {
        editorSelectionGrants: { mint: (owner: { instanceId: string; workspaceId: string; packageVersion: string }, path: string, kind: 'file') => { grant: string } }
      }).editorSelectionGrants
      const selected = selectionGrants.mint({
        instanceId: runtime.instanceId!,
        workspaceId: runtime.workspaceId!,
        packageVersion: runtime.packageVersion,
      }, join(externalPath, 'notes.txt'), 'file')

      const dispatch = async (
        address: 'fs.readFile' | 'fs.writeFile' | 'fs.stat',
        args: Record<string, unknown>,
        response: unknown,
      ) => {
        const before = socket.sent.length
        const pending = mgr.executePublicCapability({
          kind: 'public', address, scope: 'workspace', runtime, args,
        })
        await vi.waitFor(() => expect(socket.sent).toHaveLength(before + 1))
        const request = JSON.parse(socket.sent.at(-1)!) as { id: string; type: string; payload: Record<string, unknown> }
        socket.receive({ id: request.id, type: request.type, ok: true, payload: response, error: null, timestamp: '' })
        return { request, result: await pending }
      }

      const read = await dispatch('fs.readFile', { path: 'notes.txt', selectionGrant: selected.grant }, { content: 'external' })
      expect(read.request.payload).toEqual({ workspace_path: externalPath, rel_path: 'notes.txt' })
      expect(read.result).toEqual({ content: 'external' })

      const write = await dispatch('fs.writeFile', {
        path: 'notes.txt', content: 'updated', selectionGrant: selected.grant,
      }, { ok: true })
      expect(write.request.payload).toEqual({ workspace_path: externalPath, rel_path: 'notes.txt', content: 'updated' })

      const stat = await dispatch('fs.stat', { path: 'notes.txt', selectionGrant: selected.grant }, { exists: true })
      expect(stat.request.payload).toEqual({ workspace_path: externalPath, path: join(externalPath, 'notes.txt') })
      expect(stat.result).toEqual({ exists: true })

      const sent = socket.sent.length
      await expect(mgr.executePublicCapability({
        kind: 'public', address: 'fs.readFile', scope: 'workspace', runtime,
        args: { path: 'sibling.txt', selectionGrant: selected.grant },
      })).rejects.toThrow(/selected file/)
      expect(socket.sent).toHaveLength(sent)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(externalPath, { recursive: true, force: true })
    }
  })

  it('forwards fs.listDirectory showHidden only when provided', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-public-fs-list-hidden-'))
    try {
      const { mgr } = await openGitView(workspacePath)
      mgr.setBackendWsUrl('ws://public-fs-list-hidden-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()
      const runtime = (
        mgr as unknown as { running: Map<string, { capabilityContext: HostCapabilityContext }> }
      ).running.get([...(
        mgr as unknown as { running: Map<string, unknown> }
      ).running.keys()][0]!)!.capabilityContext.runtimeBinding!
      const dispatch = async (args: Record<string, unknown>, response: unknown) => {
        const pending = mgr.executePublicCapability({
          kind: 'public', address: 'fs.listDirectory', scope: 'workspace', runtime, args,
        })
        await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
        const request = JSON.parse(socket.sent.pop()!) as { id: string; type: string; payload: Record<string, unknown> }
        socket.receive({ id: request.id, type: request.type, ok: true, payload: response, error: null, timestamp: '' })
        return { request, result: await pending }
      }
      const listed = await dispatch({ path: 'src' }, {
        ok: true,
        entries: [
          { name: 'src', rel_path: 'src', is_dir: true, is_hidden: false, is_noise: false },
          { name: 'README.md', kind: 'file' },
        ],
        truncated: true,
      })
      expect(listed.request.payload).toEqual({ workspace_path: workspacePath, rel_path: 'src' })
      expect(listed.result).toEqual({
        ok: true,
        entries: [
          { name: 'src', kind: 'directory', rel_path: 'src', is_dir: true, is_hidden: false, is_noise: false },
          { name: 'README.md', kind: 'file' },
        ],
        truncated: true,
      })

      const hidden = await dispatch({ path: 'src', showHidden: false }, {
        ok: false,
        error: 'not a directory',
      })
      expect(hidden.request.payload).toEqual({
        workspace_path: workspacePath, rel_path: 'src', show_hidden: false,
      })
      expect(hidden.result).toEqual({ ok: false, error: 'not a directory', entries: [] })
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('rejects Git contribution paths through a dangling symlink', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-workspace-'))
    const outsidePath = mkdtempSync(join(tmpdir(), 'navide-git-outside-'))
    try {
      symlinkSync(join(outsidePath, 'missing-target'), join(workspacePath, 'dangling'), 'file')
      const { view, sent } = await openGitView(workspacePath)
      const actions = [
        {
          operation: 'open_file',
          payload: { workspace_path: workspacePath, filepath: 'dangling/secret.txt', name: 'secret.txt' },
        },
        {
          operation: 'open_path',
          payload: { path: join(workspacePath, 'dangling', 'secret.txt') },
        },
      ] as const

      for (const [index, action] of actions.entries()) {
        const response = await call(view, 'git.contribution', action, `git-symlink-dangling-${index}`)
        expect(response).toMatchObject({
          ok: false,
          error: { code: 'WORKSPACE_SCOPE_VIOLATION' },
        })
      }
      expect(sent).toEqual([])
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(outsidePath, { recursive: true, force: true })
    }
  })

  it('allows an internal symlink and a missing ordinary leaf inside the workspace', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'navide-git-workspace-'))
    try {
      mkdirSync(join(workspacePath, 'real-dir'))
      writeFileSync(join(workspacePath, 'real-dir', 'app.ts'), 'export {}')
      symlinkSync(join(workspacePath, 'real-dir'), join(workspacePath, 'inside-link'), 'dir')
      const { view, sent } = await openGitView(workspacePath)

      const internalLink = await call(view, 'git.contribution', {
        operation: 'open_file',
        payload: { workspace_path: workspacePath, filepath: 'inside-link/app.ts', name: 'app.ts' },
      }, 'git-symlink-inside')
      expect(internalLink).toMatchObject({ ok: true, result: { accepted: true } })

      const missingLeaf = await call(view, 'git.contribution', {
        operation: 'open_path',
        payload: { path: join(workspacePath, 'new-dir', 'new-file.ts') },
      }, 'git-missing-leaf')
      expect(missingLeaf).toMatchObject({ ok: true, result: { accepted: true } })
      expect(sent).toHaveLength(2)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('keeps account credentials Host-owned and workspace-scoped', async () => {
    const { mgr, view } = await openGitView()
    const bind = vi.fn()
    const unbind = vi.fn()
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [{ id: 'account-1', label: 'GitHub', host: 'github.com', username: 'alice', tokenLast4: '1234' }],
      add: () => ({ id: 'account-2', label: 'GitLab', host: 'gitlab.com', username: 'bob', tokenLast4: '5678' }),
      update: () => undefined,
      remove: () => undefined,
      bind,
      unbind,
      getBinding: () => 'account-1',
      getCredential: () => ({ username: 'alice', token: 'secret-token', expectedHost: 'github.com' }),
    })

    const listed = await call(view, 'git.account', { operation: 'list', payload: {} }, 'git-list')
    expect(listed).toEqual({
      reqId: 'git-list',
      ok: true,
      result: {
        available: true,
        accounts: [{ id: 'account-1', label: 'GitHub', host: 'github.com', username: 'alice', tokenLast4: '1234' }],
      },
    })

    await expect(call(view, 'git.account', {
      operation: 'bind',
      payload: { accountId: 'account-1' },
    }, 'git-bind')).resolves.toMatchObject({ ok: true, result: { accountId: 'account-1' } })
    expect(bind).toHaveBeenCalledWith(resolve('/workspace'), 'account-1')

    await expect(call(view, 'git.account', {
      operation: 'unbind',
      payload: {},
    }, 'git-unbind')).resolves.toMatchObject({ ok: true, result: { accountId: null } })
    expect(unbind).toHaveBeenCalledWith(resolve('/workspace'))

    await expect(call(view, 'git.account', {
      operation: 'bind',
      payload: { accountId: 'account-1', workspace_path: '/other' },
    }, 'git-bind-forged-workspace')).resolves.toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })
    expect(bind).toHaveBeenCalledTimes(1)

    const response = await call(view, 'git.account', {
      operation: 'get_credential',
      payload: { workspace_path: '/workspace' },
    })
    expect(response).toMatchObject({
      reqId: 'git-1',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })

    const denied = await call(view, 'git.account', {
      operation: 'get_credential',
      payload: { workspace_path: '/other' },
    }, 'git-2')
    expect(denied).toMatchObject({
      reqId: 'git-2',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('limits account actions to Git left and window audiences', async () => {
    const { mgr, view } = await openGitView('/workspace', 'git-history')
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => null,
      getCredential: () => null,
    })

    await expect(call(view, 'git.account', {
      operation: 'list',
      payload: {},
    }, 'git-account-wrong-audience')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('requires the first-party allowlist shell policy and grant for Git requests', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor = gitDescriptor(mgr)
    descriptor.capabilityPolicy = manifestV2CapabilityPolicy({
      system: ['fs', 'ui', 'aiCli'],
    })
    mgr.registerDescriptor(descriptor, { builtin: true })
    const host = new FakeBrowserWindow()
    const handle = await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: descriptor.capabilityContext,
    })

    const response = await call(host.children[0] as FakeViewLike, 'git.request', {
      type: 'git.status',
      payload: { workspace_path: '/workspace' },
    })
    expect(handle.instanceId).toBeTruthy()
    expect(response).toMatchObject({
      reqId: 'git-1',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('requires publisher eligibility and an allowlist grant for Issues requests', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor = gitDescriptor(mgr)
    descriptor.capabilityContext = {
      ...descriptor.capabilityContext!,
      publisherEligible: false,
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    const host = new FakeBrowserWindow()
    await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: descriptor.capabilityContext,
    })

    const response = await call(host.children[0] as FakeViewLike, 'issues.request', {
      type: 'issues.list',
      payload: { workspace_path: '/workspace', limit: 10 },
    })
    expect(response).toMatchObject({
      reqId: 'git-1',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('rejects Git requests when the shell mode is full instead of allowlist', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor = gitDescriptor(mgr)
    descriptor.capabilityPolicy = manifestV2CapabilityPolicy({
      system: ['fs', 'ui', 'aiCli'],
      shell: 'full',
    })
    descriptor.capabilityContext = {
      ...descriptor.capabilityContext!,
      userGrant: { ...descriptor.capabilityContext!.userGrant!, shell: 'full' },
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    const host = new FakeBrowserWindow()
    await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: descriptor.capabilityContext,
    })

    const response = await call(host.children[0] as FakeViewLike, 'git.request', {
      type: 'git.status',
      payload: { workspace_path: '/workspace' },
    })
    expect(response).toMatchObject({
      reqId: 'git-1',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('rejects Git requests when the package grant omits shell access', async () => {
    const mgr = new FrontendPluginManager()
    const descriptor = gitDescriptor(mgr)
    descriptor.capabilityContext = {
      ...descriptor.capabilityContext!,
      userGrant: {
        packageVersion: '1.0.0',
        system: ['fs', 'ui', 'aiCli'],
        storage: true,
      },
    }
    mgr.registerDescriptor(descriptor, { builtin: true })
    const host = new FakeBrowserWindow()
    await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: descriptor.capabilityContext,
    })

    const response = await call(host.children[0] as FakeViewLike, 'git.request', {
      type: 'git.status',
      payload: { workspace_path: '/workspace' },
    })
    expect(response).toMatchObject({
      reqId: 'git-1',
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('injects the bound credential only into Host-to-backend remote Git requests', async () => {
    const { mgr, view } = await openGitView()
    mgr.setBackendWsUrl('ws://git-credential-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => 'account-1',
      getCredential: (workspacePath) => workspacePath === resolve('/workspace')
        ? { username: 'alice', token: 'secret-token', expectedHost: 'github.com' }
        : null,
    })

    const operation = call(view, 'git.request', {
      type: 'git.push',
      payload: { workspace_path: '/workspace', remote: 'origin', branch: 'main' },
    })
    await Promise.resolve()
    const request = JSON.parse(socket.sent.at(-1)!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(request.type).toBe('git.push')
    expect(request.payload).toEqual({
      workspace_path: resolve('/workspace'),
      remote: 'origin',
      branch: 'main',
      credential: { username: 'alice', token: 'secret-token', expectedHost: 'github.com' },
    })
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: { ok: true },
      error: null,
      timestamp: '',
    })
    await expect(operation).resolves.toMatchObject({ ok: true })

    const rawCredential = await call(view, 'git.request', {
      type: 'git.push',
      payload: {
        workspace_path: '/workspace',
        credential: { username: 'mallory', token: 'plugin-supplied' },
      },
    }, 'git-raw-credential')
    expect(rawCredential).toMatchObject({
      reqId: 'git-raw-credential',
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })
    expect(socket.sent.map((raw) => JSON.parse(raw).payload.credential?.token)).not.toContain('plugin-supplied')
  })

  it('bounds the size of a temp preview file the Git view may open', async () => {
    const { view, sent } = await openGitView()
    const ok = await call(view, 'git.contribution', {
      operation: 'open_temp_file', payload: { name: 'a.txt', content: 'x'.repeat(1024) },
    })
    expect(ok).toMatchObject({ ok: true })
    const tooLarge = await call(view, 'git.contribution', {
      operation: 'open_temp_file', payload: { name: 'big.txt', content: 'x'.repeat(10 * 1024 * 1024 + 1) },
    }, 'git-big-temp')
    expect(tooLarge).toMatchObject({ reqId: 'git-big-temp', ok: false, error: { code: 'BAD_REQUEST' } })
    expect(sent.filter((entry) => JSON.stringify(entry).includes('big.txt'))).toEqual([])
  })

  it('keeps slow remote Git requests pending past the generic 10s deadline and still settles them', async () => {
    const { mgr, view } = await openGitView()
    mgr.setBackendWsUrl('ws://git-slow-remote-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    vi.useFakeTimers()
    try {
      let settled: unknown = null
      const operation = call(view, 'git.request', {
        type: 'git.push',
        payload: { workspace_path: '/workspace', remote: 'origin', branch: 'main' },
      }).then((response) => { settled = response; return response })
      await vi.advanceTimersByTimeAsync(0)
      const request = JSON.parse(socket.sent.at(-1)!) as { id: string; type: string }
      expect(request.type).toBe('git.push')
      // Interactive credential entry or a slow remote: the backend has not answered yet.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(settled).toBeNull()
      socket.receive({ id: request.id, type: request.type, ok: true, payload: { ok: true }, error: null, timestamp: '' })
      await expect(operation).resolves.toMatchObject({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('still expires a local Git read at the short deadline', async () => {
    const { mgr, view } = await openGitView()
    mgr.setBackendWsUrl('ws://git-local-timeout-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    vi.useFakeTimers()
    try {
      const operation = call(view, 'git.request', {
        type: 'git.status',
        payload: { workspace_path: '/workspace' },
      })
      await vi.advanceTimersByTimeAsync(25_000)
      await expect(operation).resolves.toMatchObject({ ok: false, error: { code: 'BACKEND_ERROR' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves Git-native authentication when no Host credential is bound', async () => {
    const { mgr, view } = await openGitView()
    mgr.setBackendWsUrl('ws://git-credential-required-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const getCredential = vi.fn(() => null)
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => null,
      getCredential,
    })

    const operation = call(view, 'git.request', {
      type: 'git.push',
      payload: { workspace_path: '/workspace', remote: 'origin', branch: 'main' },
    }, 'git-with-native-auth')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0]!)
    expect(request.payload).toMatchObject({
      workspace_path: resolve('/workspace'),
      remote: 'origin',
      branch: 'main',
    })
    expect(request.payload.credential_owner_nonce).toEqual(expect.any(String))
    expect(request.payload).not.toHaveProperty('credential')
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: { ok: true },
      error: null,
      timestamp: '',
    })
    await expect(operation).resolves.toMatchObject({ ok: true })
    expect(getCredential).toHaveBeenCalledWith(resolve('/workspace'))
  })

  it('releases an interactive credential owner when the backend is unavailable', async () => {
    const { mgr, view } = await openGitView()
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => null,
      getCredential: () => null,
    })

    await expect(call(view, 'git.request', {
      type: 'git.fetch',
      payload: { workspace_path: '/workspace' },
    }, 'git-no-backend-owner')).resolves.toMatchObject({
      ok: false,
      error: { code: 'BACKEND_ERROR' },
    })
    const owners = (mgr as unknown as { gitCredentialOwners: Map<string, unknown> }).gitCredentialOwners
    expect(owners.size).toBe(0)
  })

  it('routes interactive credential prompts and replies to the exact requesting instance', async () => {
    const first = await openGitView('/workspace', 'git-left')
    const secondDescriptor = gitDescriptor(first.mgr, '/workspace', 'git-left')
    const secondHost = new FakeBrowserWindow()
    await first.mgr.openView(secondDescriptor, secondDescriptor.views![0], {
      hostWindow: asHost(secondHost),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: secondDescriptor.capabilityContext,
    })
    const secondView = secondHost.children[0] as FakeViewLike
    first.mgr.setBackendWsUrl('ws://git-interactive-credential-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    first.mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => null,
      getCredential: () => null,
    })

    await expect(call(first.view, 'git.request', {
      type: 'git.fetch',
      payload: {
        workspace_path: '/workspace',
        credential_owner_nonce: 'renderer-chosen',
      },
    }, 'git-forged-credential-owner')).resolves.toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })

    const operation = call(first.view, 'git.request', {
      type: 'git.fetch',
      payload: { workspace_path: '/workspace' },
    }, 'git-interactive-fetch')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const fetchRequest = JSON.parse(socket.sent[0]!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(fetchRequest.payload.credential_owner_nonce).toMatch(/^[a-f0-9-]{36}$/)

    socket.receive({
      id: 'credential-event',
      type: 'git.credential_request',
      payload: {
        request_id: 'askpass-1',
        workspace_path: '/workspace',
        host: 'github.com',
        prompt: "Username for 'https://github.com': ",
        credential_owner_nonce: fetchRequest.payload.credential_owner_nonce,
      },
      timestamp: '',
    })
    const credentialEvents = (view: FakeViewLike) => view.webContents.sent.filter(
      (message) => message.channel === 'plugin:cap:event' &&
        (message.args[0] as { type?: string }).type === 'git.credential_request',
    )
    const publicCredentialEvents = (view: FakeViewLike, type: string) => view.webContents.sent.filter(
      (message) => message.channel === 'plugin:cap:event' &&
        (message.args[0] as { type?: string }).type === type,
    )
    expect(credentialEvents(first.view)).toHaveLength(1)
    expect(credentialEvents(secondView)).toHaveLength(0)
    expect(publicCredentialEvents(first.view, 'shell.gitCredentialRequested')).toEqual([{
      channel: 'plugin:cap:event',
      args: [{
        type: 'shell.gitCredentialRequested',
        data: {
          requestId: 'askpass-1',
          host: 'github.com',
          prompt: "Username for 'https://github.com': ",
        },
      }],
    }])
    expect(publicCredentialEvents(secondView, 'shell.gitCredentialRequested')).toHaveLength(0)
    const publicRequest = first.view.webContents.sent.find((message) =>
      (message.args[0] as { type?: string }).type === 'shell.gitCredentialRequested')
    expect(JSON.stringify(publicRequest)).not.toContain('credential_owner_nonce')
    expect(JSON.stringify(publicRequest)).not.toContain('/workspace')

    socket.receive({
      id: 'credential-event-wrong-workspace',
      type: 'git.credential_request',
      payload: {
        request_id: 'askpass-wrong-workspace',
        workspace_path: '/other-workspace',
        host: 'github.com',
        prompt: 'must not route',
        credential_owner_nonce: fetchRequest.payload.credential_owner_nonce,
      },
      timestamp: '',
    })
    expect(publicCredentialEvents(first.view, 'shell.gitCredentialRequested')).toHaveLength(1)
    expect(credentialEvents(first.view)).toHaveLength(1)
    expect(publicCredentialEvents(secondView, 'shell.gitCredentialRequested')).toHaveLength(0)

    await expect(call(secondView, 'git.request', {
      type: 'git.credential_submit',
      payload: { request_id: 'askpass-1', value: 'forged' },
    }, 'forged-submit')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    expect(socket.sent).toHaveLength(1)

    const submit = call(first.view, 'git.request', {
      type: 'git.credential_submit',
      payload: { request_id: 'askpass-1', value: 'alice' },
    }, 'owner-submit')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const submitRequest = JSON.parse(socket.sent[1]!)
    expect(submitRequest.type).toBe('git.credential_submit')
    socket.receive({
      id: submitRequest.id,
      type: submitRequest.type,
      ok: true,
      payload: { ok: true },
      error: null,
      timestamp: '',
    })
    await expect(submit).resolves.toMatchObject({ ok: true })

    socket.receive({
      id: fetchRequest.id,
      type: fetchRequest.type,
      ok: true,
      payload: { ok: true },
      error: null,
      timestamp: '',
    })
    await expect(operation).resolves.toMatchObject({ ok: true })

    const secondOperation = call(first.view, 'git.request', {
      type: 'git.fetch',
      payload: { workspace_path: '/workspace' },
    }, 'git-interactive-fetch-cancelled')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3))
    const secondFetchRequest = JSON.parse(socket.sent[2]!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    socket.receive({
      id: 'credential-event-2',
      type: 'git.credential_request',
      payload: {
        request_id: 'askpass-2',
        workspace_path: '/workspace',
        host: 'gitlab.com',
        prompt: 'Username: ',
        credential_owner_nonce: secondFetchRequest.payload.credential_owner_nonce,
      },
      timestamp: '',
    })
    socket.receive({
      id: secondFetchRequest.id,
      type: secondFetchRequest.type,
      ok: true,
      payload: { ok: true },
      error: null,
      timestamp: '',
    })
    await expect(secondOperation).resolves.toMatchObject({ ok: true })
    expect(publicCredentialEvents(first.view, 'shell.gitCredentialCancelled')).toEqual([{
      channel: 'plugin:cap:event',
      args: [{
        type: 'shell.gitCredentialCancelled',
        data: { requestId: 'askpass-2' },
      }],
    }])
    expect(publicCredentialEvents(secondView, 'shell.gitCredentialCancelled')).toHaveLength(0)
  })

  it('keeps public terminal view state bound to the authenticated contribution', async () => {
    const opened = await openGitView('/workspace', 'git-window')
    const runtime = (
      opened.mgr as unknown as {
        running: Map<string, { capabilityContext: HostCapabilityContext }>
      }
    ).running.get(opened.instanceId)!.capabilityContext.runtimeBinding!
    const execute = (address: string, args: Record<string, unknown>) =>
      opened.mgr.executePublicCapability({
        kind: 'public',
        address,
        scope: 'workspace',
        runtime,
        args,
      })
    const requests: Array<{ origin: string; request: Record<string, unknown> }> = []
    opened.mgr.setTerminalStorageHandler(async (origin, request, canDispatch) => {
      requests.push({ origin, request: request as unknown as Record<string, unknown> })
      expect(canDispatch()).toBe(true)
      return {
        fontSize: 14,
        lastSize: { cols: 100, rows: 30 },
        ptyId: 'private-pty',
        snapshot: 'nv1:private-history',
      }
    })

    await expect(execute('aiCli.readTerminalView', {})).resolves.toMatchObject({
      fontSize: 14,
      lastSize: { cols: 100, rows: 30 },
      snapshot: 'nv1:private-history',
    })
    const context = (
      opened.mgr as unknown as {
        running: Map<string, { capabilityContext: HostCapabilityContext }>
      }
    ).running.get(opened.instanceId)!.capabilityContext
    context.sessionBindings = new Map([['owned-session', runtime]])

    await expect(execute('aiCli.saveTerminalView', {
      sessionId: 'owned-session',
      snapshots: ['nv1:owned-history'],
    })).resolves.toEqual({})
    await expect(execute('aiCli.setTerminalFontSize', {
      fontSize: 16,
    })).resolves.toEqual({})

    expect(requests.map(({ origin, request }) => [origin, request.operation])).toEqual([
      ['host', 'read'],
      ['host', 'snapshot'],
      ['host', 'font'],
    ])
    expect(JSON.stringify(requests)).not.toContain('private-pty')
  })

  it('lists the opt-in terminal profile registry with fixed full-screen metadata', async () => {
    const opened = await openGitView('/workspace', 'git-window')
    const runtime = (
      opened.mgr as unknown as {
        running: Map<string, { capabilityContext: HostCapabilityContext }>
      }
    ).running.get(opened.instanceId)!.capabilityContext.runtimeBinding!
    const result = await opened.mgr.executePublicCapability({
      kind: 'public',
      address: 'aiCli.listProfiles',
      scope: 'workspace',
      runtime,
      args: { terminalView: true },
    }) as { profiles: unknown[] }
    expect(result.profiles).toEqual(expect.arrayContaining([
      { id: 'droid', label: 'Droid', bracketedPaste: true },
      { id: 'claude', label: 'Claude Code', fullScreenTui: true, bracketedPaste: true },
      { id: 'codex', label: 'Codex', bracketedPaste: true, shiftEnterSequence: '\x1b[13;2u' },
    ]))
  })

  it('drops native terminal resource requests when the session binding is wrong', async () => {
    const opened = await openGitView('/workspace', 'git-window')
    const ownerCalls: unknown[] = []
    opened.mgr.setTerminalStorageHandler(async () => {
      ownerCalls.push('unexpected')
      return null
    })
    await expect(publicCall(opened.view, 'aiCli', 'saveTerminalView', {
      sessionId: 'sibling-session',
      snapshots: ['nv1:history'],
    }, 'terminal-wrong-session')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    expect(ownerCalls).toHaveLength(0)
  })

  it('skips the AI terminal owner release while the app is quitting', async () => {
    const opened = await openGitView('/workspace', 'git-window')
    const operations: string[] = []
    opened.mgr.setTerminalStorageHandler(async (_origin, request) => {
      operations.push(request.operation)
      return null
    })
    const internal = opened.mgr as unknown as {
      running: Map<string, unknown>
      terminalStorageIdentity(plugin: unknown): unknown
      releaseAiTerminalOwner(plugin: unknown, identity: unknown): void
    }
    const plugin = internal.running.get(opened.instanceId)!
    const identity = internal.terminalStorageIdentity(plugin)
    expect(identity).toBeTruthy()
    let quitting = true
    opened.mgr.setAppQuittingProbe(() => quitting)
    internal.releaseAiTerminalOwner(plugin, identity)
    await Promise.resolve()
    expect(operations).toEqual([])
    quitting = false
    internal.releaseAiTerminalOwner(plugin, identity)
    await Promise.resolve()
    expect(operations).toEqual(['release'])
  })

  it('allows selection reporting after exit without a session id while retaining session checks when supplied', async () => {
    const opened = await openGitView('/workspace', 'git-window')
    opened.mgr.setPublicCapabilityHandler((plan) => opened.mgr.executePublicCapability(plan))

    await expect(publicCall(opened.view, 'aiCli', 'reportTerminalSelection', {
      selection: 'copied after exit',
    }, 'terminal-selection-after-exit')).resolves.toMatchObject({ ok: true })

    await expect(publicCall(opened.view, 'aiCli', 'reportTerminalSelection', {
      sessionId: 'sibling-session',
      selection: 'must be denied',
    }, 'terminal-selection-sibling')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
  })

  it('buffers early AI output and resumes a detached session by Host tuple', async () => {
    vi.useFakeTimers()
    try {
      const first = await openGitView('/workspace', 'git-window')
      first.mgr.setBackendWsUrl('ws://git-ai-resume-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()
      const runtimeOf = (instanceId: string) => (
        first.mgr as unknown as {
          running: Map<string, { capabilityContext: HostCapabilityContext }>
        }
      ).running.get(instanceId)!.capabilityContext.runtimeBinding!

      await expect(first.mgr.executePublicCapability({
        kind: 'public',
        address: 'aiCli.listProfiles',
        scope: 'workspace',
        runtime: runtimeOf(first.instanceId),
        args: {},
      })).resolves.toMatchObject({
        profiles: expect.arrayContaining([{ id: 'claude', label: 'Claude Code' }]),
      })

      const start = first.mgr.executePublicCapability({
        kind: 'public',
        address: 'aiCli.startSession',
        scope: 'workspace',
        runtime: runtimeOf(first.instanceId),
        args: {
          profileId: 'claude',
          requestId: 'start-1',
          cols: 80,
          rows: 24,
          yolo: true,
        },
      })
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
      const create = JSON.parse(socket.sent[0]!)
      expect(create.type).toBe('terminal.create')
      // The Host must hand the backend the documented command shape: a POSIX
      // `[shell, flags, line]` wrapper, or a single string off Windows. The
      // YOLO flag belongs inside that line, never as a top-level argv element
      // (the Git sidebar regression that joined `--flag -c 'hooks…'`).
      const command = create.payload.command
      const commandLine = Array.isArray(command) ? command.at(-1) : command
      expect(commandLine).toBe('claude --dangerously-skip-permissions')
      if (Array.isArray(command)) expect(command).toHaveLength(3)

      socket.receive({
        id: 'early-output',
        type: 'terminal.output',
        payload: {
          terminal_session_id: 'ai-session-1',
          pane_id: create.payload.pane_id,
          sequence: 1,
          data: 'early output',
        },
        timestamp: '',
      })
      expect(first.view.webContents.sent.some((message) =>
        message.channel === 'plugin:cap:event' &&
        (message.args[0] as { type?: string }).type === 'aiCli.output'
      )).toBe(false)

      socket.receive({
        id: create.id,
        type: create.type,
        ok: true,
        payload: {
          terminal_session_id: 'ai-session-1',
          pane_id: create.payload.pane_id,
          create_generation: 'start-1',
        },
        error: null,
        timestamp: '',
      })
      await expect(start).resolves.toEqual({ sessionId: 'ai-session-1' })
      await vi.advanceTimersByTimeAsync(12)
      expect(first.view.webContents.sent).toContainEqual({
        channel: 'plugin:cap:event',
        args: [{ type: 'aiCli.output', data: { sessionId: 'ai-session-1', data: 'early output' } }],
      })

      first.mgr.destroyInstance(first.instanceId)
      const descriptor = gitDescriptor(first.mgr, '/workspace', 'git-window')
      const secondHost = new FakeBrowserWindow()
      const second = await first.mgr.openView(descriptor, descriptor.views![0], {
        hostWindow: asHost(secondHost),
        bounds: 'fill',
        workspacePath: '/workspace',
        capabilityContext: descriptor.capabilityContext,
      })
      const resume = first.mgr.executePublicCapability({
        kind: 'public',
        address: 'aiCli.resumeSession',
        scope: 'workspace',
        runtime: runtimeOf(second.instanceId),
        args: { cols: 100, rows: 30 },
      })
      await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
      const reattach = JSON.parse(socket.sent[1]!)
      expect(reattach).toMatchObject({
        type: 'terminal.reattach',
        payload: { terminal_session_ids: ['ai-session-1'], cols: 100, rows: 30 },
      })
      socket.receive({
        id: reattach.id,
        type: reattach.type,
        ok: true,
        payload: { alive: ['ai-session-1'], dead: [] },
        error: null,
        timestamp: '',
      })
      await expect(resume).resolves.toEqual({ sessionId: 'ai-session-1', profileId: 'claude' })
      expect(socket.sent.map((raw) => JSON.parse(raw).type)).toEqual([
        'terminal.create',
        'terminal.reattach',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('wraps every Git sidebar CLI profile in the backend command contract', async () => {
    vi.useFakeTimers()
    try {
      for (const [index, profileId] of Object.keys(AI_CLI_PROFILES).entries()) {
        const view = await openGitView('/workspace', 'git-window')
        view.mgr.setBackendWsUrl(`ws://git-sidebar-shape-${index}`)
        const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
        socket.open()
        const runtime = (
          view.mgr as unknown as {
            running: Map<string, { capabilityContext: HostCapabilityContext }>
          }
        ).running.get(view.instanceId)!.capabilityContext.runtimeBinding!
        const requestId = `shape-${index}`
        const start = view.mgr.executePublicCapability({
          kind: 'public',
          address: 'aiCli.startSession',
          scope: 'workspace',
          runtime,
          args: { profileId, requestId, cols: 80, rows: 24, yolo: true },
        })
        await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
        const create = JSON.parse(socket.sent[0]!)
        expect(create.type, profileId).toBe('terminal.create')

        const profile = AI_CLI_PROFILES[profileId as keyof typeof AI_CLI_PROFILES]
        const flag = 'yoloFlag' in profile ? profile.yoloFlag : undefined
        const command = create.payload.command as string | string[]
        // Never the raw executable argv `[binary, flag]` whose last element the
        // backend joined `-c 'hooks.SessionStart=…'` onto (the bug).
        const words = (Array.isArray(command) ? command.at(-1)! : command).split(' ')
        if (isWindows()) expect(typeof command, profileId).toBe('string')
        else expect(command, profileId).toHaveLength(3)
        expect(words[0], profileId).toBe(profile.command)
        if (flag) expect(words, profileId).toContain(flag)

        socket.receive({
          id: create.id,
          type: create.type,
          ok: true,
          payload: {
            terminal_session_id: `session-${profileId}`,
            pane_id: create.payload.pane_id,
            create_generation: requestId,
          },
          error: null,
          timestamp: '',
        })
        await start
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers an owned AI terminal through a symlinked workspace without clearing its PTY', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-ai-symlink-recovery-')))
    const workspace = join(root, 'real-workspace')
    const alias = join(root, 'linked-workspace')
    mkdirSync(workspace)
    symlinkSync(workspace, alias, 'dir')
    try {
      const opened = await openGitView(alias, 'git-window')
      const operations: Array<{ operation: string; ptyId?: string | null }> = []
      opened.mgr.setTerminalStorageHandler(async (_origin, request) => {
        operations.push(request)
        return { fontSize: 12, lastSize: null, ptyId: 'live-pty', snapshot: null }
      })
      opened.mgr.setBackendWsUrl('ws://git-ai-symlink-recovery-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()
      const runtime = (
        opened.mgr as unknown as {
          running: Map<string, { capabilityContext: HostCapabilityContext }>
        }
      ).running.get(opened.instanceId)!.capabilityContext.runtimeBinding!
      const resume = opened.mgr.executePublicCapability({
        kind: 'public', address: 'aiCli.resumeSession', scope: 'workspace', runtime,
        args: { cols: 80, rows: 24, persistView: true },
      })
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
      const request = JSON.parse(socket.sent[0]!)
      expect(request.payload.expected_workspace_path).toBe(alias)
      socket.receive({
        id: request.id, type: request.type, ok: true,
        payload: {
          alive: ['live-pty'], dead: [],
          sessions: { 'live-pty': {
            agent_key: 'claude', workspace_path: workspace, origin: 'navide.git',
          } },
        },
        error: null, timestamp: '',
      })
      await expect(resume).resolves.toEqual({ sessionId: 'live-pty', profileId: 'claude' })
      expect(operations).not.toContainEqual(expect.objectContaining({ operation: 'session', ptyId: null }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('attests the Host allowlisted profiles before persisted ledger reattach effects', async () => {
    const opened = await openGitView('/workspace', 'git-window')
    opened.mgr.setTerminalStorageHandler(async () => ({
      fontSize: 12,
      lastSize: null,
      ptyId: null,
      snapshot: null,
    }))
    opened.mgr.setBackendWsUrl('ws://git-ai-profile-attestation-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const internal = opened.mgr as unknown as {
      running: Map<string, { capabilityContext: HostCapabilityContext }>
      wsClient: unknown
      aiSessions: Map<string, Record<string, unknown>>
    }
    const plugin = internal.running.get(opened.instanceId)!
    const runtime = plugin.capabilityContext.runtimeBinding!
    internal.aiSessions.set('attested-session', {
      sessionId: 'attested-session',
      profileId: 'claude',
      pluginId: runtime.pluginId,
      packageVersion: runtime.packageVersion,
      workspaceId: runtime.workspaceId,
      audience: runtime.audience,
      attachedInstanceId: null,
      client: internal.wsClient,
      createdAt: Date.now(),
      persistView: true,
    })

    const resume = opened.mgr.executePublicCapability({
      kind: 'public',
      address: 'aiCli.resumeSession',
      scope: 'workspace',
      runtime,
      args: { cols: 100, rows: 30, persistView: true },
    })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0]!) as {
      type: string
      payload: Record<string, unknown>
    }
    expect(request.type).toBe('terminal.reattach')
    expect(request.payload.expected_profile_ids).toEqual(plugin.capabilityContext.aiCliProfiles)
    expect(request.payload.expected_workspace_path).toBe(resolve('/workspace'))
    expect(request.payload.expected_origin).toBe('navide.git')

    socket.receive({
      id: JSON.parse(socket.sent[0]!).id,
      type: request.type,
      ok: true,
      payload: { alive: ['attested-session'], dead: [] },
      error: null,
      timestamp: '',
    })
    await expect(resume).resolves.toEqual({ sessionId: 'attested-session', profileId: 'claude' })
  })

  it('rejects a detached ledger session whose profile is no longer Host-allowlisted before backend dispatch', async () => {
    const opened = await openGitView('/workspace', 'git-window')
    opened.mgr.setBackendWsUrl('ws://git-ai-revoked-profile-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const internal = opened.mgr as unknown as {
      running: Map<string, { capabilityContext: HostCapabilityContext }>
      wsClient: unknown
      aiSessions: Map<string, Record<string, unknown>>
    }
    const plugin = internal.running.get(opened.instanceId)!
    const runtime = plugin.capabilityContext.runtimeBinding!
    plugin.capabilityContext.aiCliProfiles = ['claude']
    internal.aiSessions.set('revoked-profile-session', {
      sessionId: 'revoked-profile-session',
      profileId: 'droid',
      pluginId: runtime.pluginId,
      packageVersion: runtime.packageVersion,
      workspaceId: runtime.workspaceId,
      audience: runtime.audience,
      attachedInstanceId: null,
      client: internal.wsClient,
      createdAt: Date.now(),
    })

    await expect(opened.mgr.executePublicCapability({
      kind: 'public',
      address: 'aiCli.resumeSession',
      scope: 'workspace',
      runtime,
      args: { cols: 100, rows: 30 },
    })).resolves.toBeNull()
    expect(socket.sent).toHaveLength(0)
  })

  it('rejects a start request whose profile is no longer Host-allowlisted before backend dispatch', async () => {
    const opened = await openGitView('/workspace', 'git-ai-start-revoked-profile-test')
    opened.mgr.setBackendWsUrl('ws://git-ai-start-revoked-profile-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const internal = opened.mgr as unknown as {
      running: Map<string, { capabilityContext: HostCapabilityContext }>
    }
    const plugin = internal.running.get(opened.instanceId)!
    const runtime = plugin.capabilityContext.runtimeBinding!
    plugin.capabilityContext.aiCliProfiles = ['claude']

    await expect(opened.mgr.executePublicCapability({
      kind: 'public',
      address: 'aiCli.startSession',
      scope: 'workspace',
      runtime,
      args: { profileId: 'droid', requestId: 'revoked-start', cols: 80, rows: 24 },
    })).rejects.toThrow(/profile 'droid' is not available/)
    expect(socket.sent).toHaveLength(0)
  })

  it('bounds and expires AI output that arrives before session creation commits', async () => {
    vi.useFakeTimers()
    try {
      const opened = await openGitView('/workspace', 'git-window')
      opened.mgr.setBackendWsUrl('ws://git-ai-early-buffer-test')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()
      const runtime = (
        opened.mgr as unknown as {
          running: Map<string, { capabilityContext: HostCapabilityContext }>
        }
      ).running.get(opened.instanceId)!.capabilityContext.runtimeBinding!
      const start = opened.mgr.executePublicCapability({
        kind: 'public',
        address: 'aiCli.startSession',
        scope: 'workspace',
        runtime,
        args: { profileId: 'claude', requestId: 'bounded-start', cols: 80, rows: 24 },
      })
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
      const create = JSON.parse(socket.sent[0]!)
      for (let index = 0; index < 130; index += 1) {
        socket.receive({
          id: `early-${index}`,
          type: 'terminal.output',
          payload: {
            terminal_session_id: 'bounded-session',
            pane_id: create.payload.pane_id,
            sequence: index,
            data: String(index),
          },
          timestamp: '',
        })
      }
      const buffers = (
        opened.mgr as unknown as {
          earlyAiEvents: Map<string, { events: unknown[] }>
        }
      ).earlyAiEvents
      expect([...buffers.values()][0]?.events).toHaveLength(128)

      await vi.advanceTimersByTimeAsync(5_001)
      socket.receive({
        id: create.id,
        type: create.type,
        ok: true,
        payload: {
          terminal_session_id: 'bounded-session',
          pane_id: create.payload.pane_id,
          create_generation: 'bounded-start',
        },
        error: null,
        timestamp: '',
      })
      await expect(start).resolves.toEqual({ sessionId: 'bounded-session' })
      await vi.advanceTimersByTimeAsync(12)
      expect(opened.view.webContents.sent.some((message) =>
        message.channel === 'plugin:cap:event' &&
        (message.args[0] as { type?: string }).type === 'aiCli.output'
      )).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('injects a bound credential for a matching HTTPS clone host only', async () => {
    const { mgr, view } = await openGitView()
    mgr.setBackendWsUrl('ws://git-clone-host-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => 'account-1',
      getCredential: () => ({ username: 'alice', token: 'fixture-secret', expectedHost: 'github.com' }),
    })

    await expect(call(view, 'git.request', {
      type: 'git.clone',
      payload: { workspace_path: '/workspace', url: 'https://gitlab.com/acme/repo.git', target_dir: '/tmp/repo' },
    }, 'clone-host-mismatch')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CREDENTIAL_REQUIRED' },
    })
    expect(socket.sent).toEqual([])

    await expect(call(view, 'git.request', {
      type: 'git.clone',
      payload: { workspace_path: '/workspace', url: 'https://github.com/acme/repo.git', target_dir: '/tmp/repo' },
    }, 'clone-without-grant')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_DENIED' },
    })
    expect(socket.sent).toEqual([])

    mgr.setHostShellHandlers({
      openExternal: async () => ({ ok: true }),
      revealPath: () => ({ ok: true }),
      openWorkspace: () => ({ ok: true }),
      pickFolder: async () => '/tmp',
    })
    const picked = await call(view, 'git.contribution', { operation: 'pick_workspace', payload: {} }, 'clone-parent-pick')
    const targetGrant = (picked.result as { grant: string }).grant

    const pending = call(view, 'git.request', {
      type: 'git.clone',
      payload: {
        workspace_path: '/workspace',
        url: 'https://github.com/acme/repo.git',
        target_dir: '/tmp/repo',
        target_grant: targetGrant,
      },
    }, 'clone-host-match')
    await Promise.resolve()
    const request = JSON.parse(socket.sent.at(-1)!) as { id: string; type: string; payload: Record<string, unknown> }
    expect(request.payload.credential).toEqual({ username: 'alice', token: 'fixture-secret', expectedHost: 'github.com' })
    socket.receive({ id: request.id, type: request.type, ok: true, payload: { ok: true, path: '/tmp/repo' }, error: null, timestamp: '' })
    const cloned = await pending
    expect(cloned).toMatchObject({ ok: true, result: { path: '/tmp/repo', openWorkspaceGrant: expect.any(String) } })
    await expect(call(view, 'git.contribution', {
      operation: 'open_workspace',
      payload: {
        path: '/tmp/repo',
        grant: (cloned.result as { openWorkspaceGrant: string }).openWorkspaceGrant,
      },
    }, 'open-cloned-workspace')).resolves.toMatchObject({ ok: true })
  })

  it('opens a git-window clone through the Host seam after consuming only its exact derived grant', async () => {
    const { mgr, view, sent } = await openGitView('/workspace', 'git-window')
    const opened: string[] = []
    mgr.setHostShellHandlers({
      openExternal: async () => ({ ok: true }),
      revealPath: () => ({ ok: true }),
      openWorkspace: (path) => {
        opened.push(path)
        return { ok: true }
      },
      pickFolder: async () => '/private/tmp',
    })
    mgr.setBackendWsUrl('ws://git-window-clone-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => 'account-1',
      getCredential: () => ({ username: 'alice', token: 'fixture-secret', expectedHost: 'github.com' }),
    })

    const picked = await call(view, 'git.contribution', { operation: 'pick_workspace', payload: {} }, 'window-clone-pick')
    const clone = call(view, 'git.request', {
      type: 'git.clone',
      payload: {
        workspace_path: '/workspace',
        url: 'https://github.com/acme/repo.git',
        target_dir: '/private/tmp/repo',
        target_grant: (picked.result as { grant: string }).grant,
      },
    }, 'window-clone')
    await Promise.resolve()
    const request = JSON.parse(socket.sent.at(-1)!) as { id: string; type: string }
    socket.receive({ id: request.id, type: request.type, ok: true, payload: { ok: true, path: '/private/tmp/repo' }, error: null, timestamp: '' })
    const cloned = await clone
    const derivedGrant = (cloned.result as { openWorkspaceGrant: string }).openWorkspaceGrant

    const sameVersion = gitDescriptor(mgr, '/workspace', 'git-window')
    const sameVersionHost = new FakeBrowserWindow()
    await mgr.openView(sameVersion, sameVersion.views![0], {
      hostWindow: asHost(sameVersionHost),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: sameVersion.capabilityContext,
    })
    const differentVersion = gitDescriptor(mgr, '/workspace', 'git-window', '2.0.0')
    const differentVersionHost = new FakeBrowserWindow()
    mgr.registerDescriptor(differentVersion, { builtin: true })
    await mgr.openView(differentVersion, differentVersion.views![0], {
      hostWindow: asHost(differentVersionHost),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: differentVersion.capabilityContext,
    })

    for (const [candidate, path, reqId] of [
      [sameVersionHost.children[0] as FakeViewLike, '/private/tmp/repo', 'window-wrong-instance'],
      [differentVersionHost.children[0] as FakeViewLike, '/private/tmp/repo', 'window-wrong-version'],
      [view, '/private/tmp/other', 'window-wrong-path'],
    ] as const) {
      await expect(call(candidate, 'git.contribution', {
        operation: 'open_workspace', payload: { path, grant: derivedGrant },
      }, reqId)).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
    }

    await expect(call(view, 'git.contribution', {
      operation: 'open_workspace', payload: { path: '/private/tmp/repo', grant: derivedGrant },
    }, 'window-open-clone')).resolves.toEqual({
      reqId: 'window-open-clone', ok: true, result: { accepted: true },
    })
    expect(opened).toEqual([resolve('/private/tmp/repo')])
    expect(sent).toEqual([])

    await expect(call(view, 'git.contribution', {
      operation: 'open_workspace', payload: { path: '/private/tmp/repo', grant: derivedGrant },
    }, 'window-replay')).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
  })

  it('does not inject a credential into Issues requests', async () => {
    const { mgr, view } = await openGitView()
    mgr.setBackendWsUrl('ws://git-issues-test')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const getCredential = vi.fn(() => ({ username: 'alice', token: 'secret-token', expectedHost: 'github.com' }))
    mgr.setGitAccountHandlers({
      available: () => true,
      list: () => [],
      add: () => ({ id: 'unused', label: 'unused', host: 'github.com', username: 'unused', tokenLast4: '0000' }),
      update: () => undefined,
      remove: () => undefined,
      bind: () => undefined,
      unbind: () => undefined,
      getBinding: () => 'account-1',
      getCredential,
    })

    const operation = call(view, 'issues.request', {
      type: 'issues.list',
      payload: { workspace_path: '/workspace', limit: 10 },
    })
    await Promise.resolve()
    const request = JSON.parse(socket.sent.at(-1)!) as { id: string; type: string; payload: Record<string, unknown> }
    expect(request.payload).toEqual({ workspace_path: resolve('/workspace'), limit: 10 })
    expect(getCredential).not.toHaveBeenCalled()
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: { ok: true, issues: [] },
      error: null,
      timestamp: '',
    })
    await expect(operation).resolves.toMatchObject({ ok: true })

    const localOperation = call(view, 'git.request', {
      type: 'git.status',
      payload: { workspace_path: '/workspace' },
    }, 'git-local-no-credential')
    await Promise.resolve()
    const localRequest = JSON.parse(socket.sent.at(-1)!) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    expect(localRequest.type).toBe('git.status')
    expect(localRequest.payload).toEqual({ workspace_path: resolve('/workspace') })
    socket.receive({
      id: localRequest.id,
      type: localRequest.type,
      ok: true,
      payload: { ok: true },
      error: null,
      timestamp: '',
    })
    await expect(localOperation).resolves.toMatchObject({ ok: true })
    expect(getCredential).not.toHaveBeenCalled()
  })
})

describe('Git left legacy rollback composition', () => {
  it('returns an explicit legacy fallback after replacing a live v2 left view', async () => {
    const host = new FakeBrowserWindow()
    Object.defineProperty(host, 'id', { value: 77 })
    const v2: PluginLaunchDescriptor = {
      id: 'navide.git',
      packageVersion: '2.0.0',
      requires: ['terminal'],
      capabilityPolicy: manifestV2CapabilityPolicy({
        system: ['fs', 'ui', 'aiCli'],
        shell: 'allowlist',
      }),
      capabilityContext: frontendPluginManager.gitCapabilityContext('2.0.0', '/workspace', 'git-left'),
      devUrl: '',
      entryFile: '/plugins/navide-git/index.html',
      views: [
        {
          id: 'left',
          contributionKey: 'navide.git.left',
          kind: 'custom',
          location: 'left',
          title: 'Git',
          entryFile: '/plugins/navide-git/left.html',
        },
      ],
    }
    const legacy: PluginLaunchDescriptor = {
      id: 'navide.git',
      requires: [],
      devUrl: '',
      entryFile: '/plugins/git/index.html',
    }

    frontendPluginManager.replaceBuiltinForRecovery(v2)
    await expect(openGitLeftPluginView(
      asHost(host),
      '/workspace',
      { x: 0, y: 0, width: 400, height: 300 },
      '',
      '',
      {
        git_yolo: '0',
        git_analyzer_model: 'qwen2:latest',
        git_theme_custom: '{}',
      },
    )).resolves.toEqual({ ok: true })
    expect((host.children[0] as FakeViewLike).webContents.loads).toEqual([
      '/plugins/navide-git/left.html?workspace_path=%2Fworkspace&git_yolo=0&git_analyzer_model=qwen2%3Alatest&git_theme_custom=%7B%7D&v2=1&contribution=left',
    ])

    frontendPluginManager.replaceBuiltinForRecovery(legacy)
    await expect(openGitLeftPluginView(
      asHost(host),
      '/workspace',
      { x: 0, y: 0, width: 400, height: 300 },
    )).resolves.toEqual({ ok: true, fallback: 'legacy' })
    expect(host.children).toHaveLength(0)
    expect(closeGitLeftPluginView(asHost(host))).toEqual({ ok: true })
  })

  describe('plansQuery and openPlansPluginView locale propagation', () => {
    it('formats plansQuery with validated locale', () => {
      const q1 = new URLSearchParams(plansQuery('/workspace', 'http://127.0.0.1:1', 'plan.html', 'dark', 'en-US'))
      expect(q1.get('workspace_path')).toBe('/workspace')
      expect(q1.get('http_url')).toBe('http://127.0.0.1:1')
      expect(q1.get('rel_path')).toBe('plan.html')
      expect(q1.get('theme')).toBe('dark')
      expect(q1.get('locale')).toBe('en-US')
      expect(q1.get('v2')).toBe('1')
      expect(q1.get('contribution')).toBe('window')

      const q2 = new URLSearchParams(plansQuery('/workspace', '', '', '', 'zh-TW'))
      expect(q2.get('locale')).toBe('zh-TW')

      const q3 = new URLSearchParams(plansQuery('/workspace', '', '', '', '  en-US  '))
      expect(q3.get('locale')).toBe('en-US')

      const q4 = new URLSearchParams(plansQuery('/workspace', '', '', '', 'fr-FR'))
      expect(q4.get('locale')).toBe('zh-TW')

      const q5 = new URLSearchParams(plansQuery('/workspace', '', '', ''))
      expect(q5.get('locale')).toBe('zh-TW')
    })

    it('passes validated locale through openPlansPluginView for legacy Plans descriptor', async () => {
      const legacyPlans: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        requires: ['fs', 'ui', 'plans', 'terminal'],
        devUrl: '',
        entryFile: '/plugins/plans/index.html',
      }
      frontendPluginManager.registerDescriptor(legacyPlans, { builtin: true })
      const host = new FakeBrowserWindow()

      const opened = await openPlansPluginView(
        asHost(host),
        '/workspace',
        'http://127.0.0.1:1234',
        '.agent-team/plans/my-plan.html',
        'dark',
        'en-US',
      )
      expect(opened).toBe(true)
      expect(host.children).toHaveLength(1)
      const view = host.children[0] as FakeViewLike
      expect(view.webContents.loads[0]).toContain('locale=en-US')
      expect(view.webContents.loads[0]).toContain('workspace_path=%2Fworkspace')
    })

    it('passes validated locale through openPlansPluginView for v2 Plans descriptor', async () => {
      const packageVersion = '0.1.92'
      const packageDir = realpathSync(process.cwd())
      const v2Plans: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir,
        requires: ['fs', 'ui', 'plans', 'terminal'],
        capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs', 'ui', 'aiCli'], shell: 'allowlist' }),
        devUrl: '',
        entryFile: '/plugins/navide-plans/index.html',
        views: [
          {
            id: 'left',
            contributionKey: `${PLANS_PLUGIN_ID}.left`,
            kind: 'custom',
            location: 'left',
            title: 'Plans',
            entryFile: '/plugins/navide-plans/left.html',
          },
          {
            id: 'window',
            contributionKey: `${PLANS_PLUGIN_ID}.window`,
            kind: 'custom',
            location: 'window',
            title: 'Plans',
            entryFile: '/plugins/navide-plans/window.html',
          },
        ],
      }
      frontendPluginManager.registerDescriptor(v2Plans, { builtin: true })
      frontendPluginManager.registerBackendActivation({
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir,
        entryFile: '/plugins/navide-plans/backend/navide-plans',
        protocolVersion: 1,
        activation: 'startup',
        approvedMethods: ['plans.list'],
        agentMethods: ['plans.list'],
        approvedEvents: ['plans.changed'],
        approvedBridgePorts: ['filesystem'],
      })
      frontendPluginManager.setCapabilityGrantResolver((pluginId, version) => {
        if (pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
          return {
            packageVersion,
            system: ['fs', 'ui', 'aiCli'],
            shell: 'allowlist',
            storage: true,
          }
        }
        return null
      })

      const host = new FakeBrowserWindow()
      const opened = await openPlansPluginView(
        asHost(host),
        packageDir,
        'http://127.0.0.1:1234',
        '.agent-team/plans/my-plan.html',
        'dark',
        'en-US',
      )
      expect(opened).toBe(true)
    })
  })
})

describe('workspace display name for plugin window titles', () => {
  type Sent = { id: string; type: string; payload: Record<string, unknown> }
  const recentEntry = (path: string, name: string) => ({
    path,
    name,
    last_opened_at: '2026-01-01T00:00:00Z',
    pinned: false,
    last_known_state: '',
    last_known_task: '',
    exists: true,
  })

  async function answerListRecent(
    socket: InstanceType<typeof wsMock.FakeNodeWebSocket>,
    recent: unknown[],
  ): Promise<Sent> {
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0]!) as Sent
    expect(request).toMatchObject({ type: 'workspace.list_recent' })
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: { recent, path: '/tmp/recent.json' },
      error: null,
      timestamp: '',
    })
    return request
  }

  it('reports the alias the recent-list mirror has for the workspace, trimmed', async () => {
    const mgr = new FrontendPluginManager()
    mgr.setBackendWsUrl('ws://workspace-alias-test')
    const pending = mgr.peekWorkspaceDisplayName('/workspace')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    await answerListRecent(socket, [
      recentEntry(resolve('/other'), 'Other'),
      recentEntry(resolve('/workspace'), '  Navide  '),
    ])
    await expect(pending).resolves.toBe('Navide')
  })

  it('reports no alias when the mirror holds the folder basename — its own "no alias"', async () => {
    const mgr = new FrontendPluginManager()
    mgr.setBackendWsUrl('ws://workspace-alias-basename-test')
    const pending = mgr.peekWorkspaceDisplayName('/workspace')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    // touch() writes the basename for a workspace with no alias.
    await answerListRecent(socket, [recentEntry(resolve('/workspace'), 'workspace')])
    await expect(pending).resolves.toBe('')
  })

  // The canary for the read being pure. `project.peek` registers the path as a
  // workspace and provisions `.agent-team/plans/` inside it; opening a
  // sub-folder in the editor used to do exactly that to the sub-folder. The
  // mirror never holds a sub-folder, so the answer is '' and nothing is
  // written anywhere.
  it('reports no alias for a path the mirror does not hold, and never sends project.peek', async () => {
    const mgr = new FrontendPluginManager()
    mgr.setBackendWsUrl('ws://workspace-alias-miss-test')
    const pending = mgr.peekWorkspaceDisplayName('/workspace/drafts')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    await answerListRecent(socket, [recentEntry(resolve('/workspace'), 'Navide')])
    await expect(pending).resolves.toBe('')
    const types = socket.sent.map((raw) => (JSON.parse(raw) as Sent).type)
    expect(types).toEqual(['workspace.list_recent'])
    expect(types).not.toContain('project.peek')
  })

  it('matches the mirror entry through a trailing slash on either side', async () => {
    const mgr = new FrontendPluginManager()
    mgr.setBackendWsUrl('ws://workspace-alias-slash-test')
    const pending = mgr.peekWorkspaceDisplayName('/workspace/')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    await answerListRecent(socket, [recentEntry(`${resolve('/workspace')}/`, 'Navide')])
    await expect(pending).resolves.toBe('Navide')
  })

  it('reports no alias when the listing is not a list', async () => {
    const mgr = new FrontendPluginManager()
    mgr.setBackendWsUrl('ws://workspace-alias-malformed-test')
    const pending = mgr.peekWorkspaceDisplayName('/workspace')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0]!) as Sent
    socket.receive({
      id: request.id,
      type: request.type,
      ok: true,
      payload: { recent: null },
      error: null,
      timestamp: '',
    })
    await expect(pending).resolves.toBe('')
  })

  it('gives up rather than hold a window open when the backend does not answer', async () => {
    const mgr = new FrontendPluginManager()
    mgr.setBackendWsUrl('ws://workspace-alias-timeout-test')
    // WsClient.send waits up to 10s of its own and queues while the transport
    // is down; the race is what brings that down to a title-sized wait.
    await expect(mgr.peekWorkspaceDisplayName('/workspace', 5)).resolves.toBe('')
  })

  it('reports no alias without a backend url or a workspace at all', async () => {
    const mgr = new FrontendPluginManager()
    await expect(mgr.peekWorkspaceDisplayName('/workspace')).resolves.toBe('')
    mgr.setBackendWsUrl('ws://workspace-alias-no-workspace-test')
    await expect(mgr.peekWorkspaceDisplayName('')).resolves.toBe('')
  })
})

describe('plansQuery workspace alias', () => {
  it('carries a resolved alias and leaves the param out when there is none', () => {
    const aliased = new URLSearchParams(plansQuery('/ws/agent-team', '', '', '', 'zh-TW', '  Navide  '))
    expect(aliased.get('workspace_display_name')).toBe('Navide')
    expect(aliased.get('workspace_path')).toBe('/ws/agent-team')

    for (const alias of ['', '   ']) {
      const plain = new URLSearchParams(plansQuery('/ws/agent-team', '', '', '', 'zh-TW', alias))
      expect(plain.has('workspace_display_name')).toBe(false)
    }
    expect(new URLSearchParams(plansQuery('/ws/agent-team', '', '', '', 'zh-TW')).has('workspace_display_name')).toBe(false)
  })
})

describe('third-party workspace filesystem (real package bridge, port and grant check)', () => {
  // The package bridge is obtained through a macOS sandbox admission built on
  // host temp paths; Windows refuses third-party backends before that (v1).
  it.skipIf(isWindows())('reads and writes only through its own live grant, at the bound workspace root, without touching Plans rules', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'third-party-fs-')))
    const workspace = join(root, 'workspace')
    const packageDir = join(root, 'package')
    mkdirSync(workspace)
    mkdirSync(join(packageDir, 'backend'), { recursive: true })
    writeFileSync(join(packageDir, 'backend', 'acme-indexer'), 'binary', { mode: 0o700 })
    writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.indexer', name: 'Indexer', version: '1.0.0', publisher: 'acme',
      permissions: { system: ['fs'] },
      marketplace: { description: 'Index files.', license: 'MIT' },
      contributes: { views: [{ id: 'left', kind: 'custom', location: 'left', title: 'Indexer', entry: 'frontend/left/index.html' }] },
      backend: { entry: 'backend/acme-indexer', protocolVersion: 1, activation: 'startup', methods: ['files.search'] },
    }))
    const spec = thirdPartyBackendLaunchSpec({
      pluginId: 'acme.indexer', packageVersion: '1.0.0', packageDir, views: [],
      backend: { entryFile: join(packageDir, 'backend', 'acme-indexer'), protocolVersion: 1, activation: 'startup' },
    })!
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'left', contributionKey: 'acme.indexer.left', kind: 'custom', location: 'left', title: 'Indexer',
      entryFile: join(packageDir, 'frontend/left/index.html'),
    }
    const pluginDescriptor: PluginLaunchDescriptor = {
      id: 'acme.indexer', packageVersion: '1.0.0', packageDir, requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '', entryFile: view.entryFile, views: [view],
    }
    const mgr = new FrontendPluginManager()
    let grant: { packageVersion: string; system: Array<'fs'>; storage: boolean } | null = {
      packageVersion: '1.0.0', system: ['fs'], storage: true,
    }
    mgr.setCapabilityGrantResolver(() => grant)
    mgr.registerDescriptor(pluginDescriptor, { builtin: true })
    mgr.registerBackendActivation(spec)
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindView').mockResolvedValue(undefined)
    const service = vi.spyOn(
      mgr as unknown as { sendPublicBackend: (type: string, payload: Record<string, unknown>, before?: () => boolean) => Promise<unknown> },
      'sendPublicBackend',
    ).mockImplementation(async (_type, _payload, before) => {
      if (before && !before()) throw new Error('request denied before dispatch')
      return { ok: true, content: 'hello', mtime: 1 }
    })
    const store = new NativeBackendStore(join(root, 'store'))
    store.setEnabled(true)
    const promptWorkspaceWrite = vi.fn(async () => false)
    const controller = new ThirdPartyBackendController({
      store,
      dataRoot: join(root, 'data'),
      probe: { platform: 'darwin', sandboxExec: () => '/usr/bin/sandbox-exec', bubblewrap: () => null },
      promptConsent: async () => true,
      promptWorkspaceWrite,
      filesystemPort: () => mgr.createWorkspaceFilesystemPort(),
      watchResources: () => ({ dispose: () => undefined, sample: async () => null, terminate: async (item: ResourceViolation) => item, keepRunning: () => 0 }),
    })
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(pluginDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: workspace,
        capabilityContext: {
          publisherEligible: false,
          userGrant: grant,
          runtimeBinding: {
            pluginId: 'acme.indexer', packageVersion: '1.0.0',
            workspaceId: mgr.workspaceIdForPath(workspace), instanceId: null, audience: view.contributionKey,
          },
        } as HostCapabilityContext,
      })
      expect(bind).toHaveBeenCalled()
      const admission = await controller.admit(spec, workspace)
      expect(admission.workspaceRoot).toBe(workspace)
      const context = (instanceId: string, overrides: Partial<PlansBridgeContext> = {}): PlansBridgeContext => ({
        runtime: {
          pluginId: 'acme.indexer', packageVersion: '1.0.0', workspaceId: mgr.workspaceIdForPath(workspace),
          instanceId, contributionKey: view.contributionKey, hostWindowId: 'w', initiator: { kind: 'user', id: 'u' },
        },
        workspacePath: workspace,
        authorizedPlanRoot: workspace,
        requestId: 'bridge:1',
        signal: new AbortController().signal,
        emit: () => undefined,
        ...overrides,
      })
      const request = (operation: string, args: Record<string, unknown> = { rel_path: 'a.txt' }) => ({
        id: 'bridge:1', origin: { kind: 'call' as const, requestId: 'r' }, port: 'filesystem' as const, operation, arguments: args as never,
      })

      await expect(admission.bridgeDispatcher.dispatch(request('read_file'), context(handle.instanceId)))
        .resolves.toEqual({ content: 'hello', mtime: 1 })
      expect(service).toHaveBeenLastCalledWith('fs.read_file', { rel_path: 'a.txt', workspace_path: workspace }, expect.any(Function))

      // Writes need the separate per-workspace grant.
      service.mockClear()
      await expect(admission.bridgeDispatcher.dispatch(request('write_file', { rel_path: 'a.txt', content: 'x' }), context(handle.instanceId)))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      expect(service).not.toHaveBeenCalled()
      store.setWorkspaceWrite('acme.indexer', workspace, true)
      await admission.bridgeDispatcher.dispatch(request('write_file', { rel_path: 'a.txt', content: 'x' }), context(handle.instanceId))
      expect(service).toHaveBeenLastCalledWith('fs.write_file', expect.objectContaining({ workspace_path: workspace }), expect.any(Function))

      // Another instance, another workspace root, or an agent initiator is refused.
      service.mockClear()
      await expect(admission.bridgeDispatcher.dispatch(request('read_file'), context('not-running')))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      await expect(admission.bridgeDispatcher.dispatch(request('read_file'), context(handle.instanceId, { authorizedPlanRoot: root })))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      const agent = context(handle.instanceId)
      await expect(admission.bridgeDispatcher.dispatch(request('read_file'), {
        ...agent, runtime: { ...agent.runtime, initiator: { kind: 'agent', source: 'mcp', id: 'a' } as never },
      })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      expect(service).not.toHaveBeenCalled()

      // Revoking the user Grant takes effect at the next dispatch.
      grant = null
      await expect(admission.bridgeDispatcher.dispatch(request('read_file'), context(handle.instanceId)))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })

      // Plans' own grant rule is unchanged: it never admits a third-party runtime.
      grant = { packageVersion: '1.0.0', system: ['fs'], storage: true }
      const plansInternals = mgr as unknown as {
        sendPlansFilesystemService: (operation: string, payload: Record<string, unknown>, context: PlansBridgeContext) => Promise<unknown>
      }
      await expect(plansInternals.sendPlansFilesystemService('fs.read_file', { rel_path: 'a.txt', workspace_path: workspace }, context(handle.instanceId)))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      mgr.destroyInstance(handle.instanceId)
    } finally {
      bind.mockRestore()
      service.mockRestore()
      await mgr.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('third-party backend shell broker (real package bridge, port and grant check)', () => {
  // Same admission prerequisites as the filesystem suite above (macOS sandbox
  // admission on host temp paths; Windows refuses third-party backends in v1).
  it.skipIf(isWindows())('runs allowlisted commands as the view shell.run does, only through its own live shell grant at the bound root', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'third-party-shell-')))
    const workspace = join(root, 'workspace')
    const packageDir = join(root, 'package')
    mkdirSync(workspace)
    mkdirSync(join(packageDir, 'backend'), { recursive: true })
    writeFileSync(join(packageDir, 'backend', 'acme-indexer'), 'binary', { mode: 0o700 })
    writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.indexer', name: 'Indexer', version: '1.0.0', publisher: 'acme',
      permissions: { shell: 'allowlist' },
      marketplace: { description: 'Index files.', license: 'MIT' },
      contributes: { views: [{ id: 'left', kind: 'custom', location: 'left', title: 'Indexer', entry: 'frontend/left/index.html' }] },
      backend: { entry: 'backend/acme-indexer', protocolVersion: 1, activation: 'startup', methods: ['files.search'] },
    }))
    const spec = thirdPartyBackendLaunchSpec({
      pluginId: 'acme.indexer', packageVersion: '1.0.0', packageDir, views: [],
      backend: { entryFile: join(packageDir, 'backend', 'acme-indexer'), protocolVersion: 1, activation: 'startup' },
    })!
    expect(spec.approvedBridgePorts).toEqual(['shell'])
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'left', contributionKey: 'acme.indexer.left', kind: 'custom', location: 'left', title: 'Indexer',
      entryFile: join(packageDir, 'frontend/left/index.html'),
    }
    const pluginDescriptor: PluginLaunchDescriptor = {
      id: 'acme.indexer', packageVersion: '1.0.0', packageDir, requires: ['shell'],
      capabilityPolicy: manifestV2CapabilityPolicy({ shell: 'allowlist' }),
      devUrl: '', entryFile: view.entryFile, views: [view],
    }
    const mgr = new FrontendPluginManager()
    let grant: { packageVersion: string; system: never[]; shell?: 'allowlist'; storage: boolean } | null = {
      packageVersion: '1.0.0', system: [], shell: 'allowlist', storage: true,
    }
    mgr.setCapabilityGrantResolver(() => grant)
    mgr.registerDescriptor(pluginDescriptor, { builtin: true })
    mgr.registerBackendActivation(spec)
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindView').mockResolvedValue(undefined)
    let answer: Record<string, unknown> = { ok: true, stdout: 'abc123\n', stderr: '', exit_code: 0 }
    const service = vi.spyOn(
      mgr as unknown as { sendPublicBackend: (type: string, payload: Record<string, unknown>, before?: () => boolean) => Promise<unknown> },
      'sendPublicBackend',
    ).mockImplementation(async (_type, _payload, before) => {
      if (before && !before()) throw new Error('request denied before dispatch')
      return answer
    })
    const store = new NativeBackendStore(join(root, 'store'))
    store.setEnabled(true)
    const controller = new ThirdPartyBackendController({
      store,
      dataRoot: join(root, 'data'),
      probe: { platform: 'darwin', sandboxExec: () => '/usr/bin/sandbox-exec', bubblewrap: () => null },
      promptConsent: async () => true,
      shellPort: () => mgr.createThirdPartyShellPort(),
      watchResources: () => ({ dispose: () => undefined, sample: async () => null, terminate: async (item: ResourceViolation) => item, keepRunning: () => 0 }),
    })
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(pluginDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: workspace,
        capabilityContext: {
          publisherEligible: false,
          userGrant: grant,
          runtimeBinding: {
            pluginId: 'acme.indexer', packageVersion: '1.0.0',
            workspaceId: mgr.workspaceIdForPath(workspace), instanceId: null, audience: view.contributionKey,
          },
        } as HostCapabilityContext,
      })
      expect(bind).toHaveBeenCalled()
      const admission = await controller.admit(spec, workspace)
      expect(admission.workspaceRoot).toBe(workspace)
      const context = (instanceId: string, overrides: Partial<PlansBridgeContext> = {}): PlansBridgeContext => ({
        runtime: {
          pluginId: 'acme.indexer', packageVersion: '1.0.0', workspaceId: mgr.workspaceIdForPath(workspace),
          instanceId, contributionKey: view.contributionKey, hostWindowId: 'w', initiator: { kind: 'user', id: 'u' },
        },
        workspacePath: workspace,
        authorizedPlanRoot: workspace,
        requestId: 'bridge:1',
        signal: new AbortController().signal,
        emit: () => undefined,
        ...overrides,
      })
      const request = (command: string) => ({
        id: 'bridge:1', origin: { kind: 'call' as const, requestId: 'r' }, port: 'shell' as const, operation: 'run', arguments: { command },
      })

      // The same backend message and mode as a view's shell.run: the Python
      // Host shell broker parses argv and refuses auth subcommands and -c/-C.
      await expect(admission.bridgeDispatcher.dispatch(request('git rev-parse HEAD'), context(handle.instanceId)))
        .resolves.toEqual({ exitCode: 0, stdout: 'abc123\n', stderr: '' })
      expect(service).toHaveBeenLastCalledWith(
        'shell.run',
        { workspace_path: workspace, command: 'git rev-parse HEAD', host_mode: 'allowlist' },
        expect.any(Function),
        expect.any(Number),
      )

      // A broker policy refusal (for example `gh auth token`) is a denial, not output.
      answer = { ok: false, error: 'command is not allowed by the public shell policy' }
      await expect(admission.bridgeDispatcher.dispatch(request('gh auth token'), context(handle.instanceId)))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      answer = { ok: true, stdout: '', stderr: 'fatal', exit_code: 128 }
      await expect(admission.bridgeDispatcher.dispatch(request('git rev-parse nope'), context(handle.instanceId)))
        .resolves.toEqual({ exitCode: 128, stdout: '', stderr: 'fatal' })
      // The broker's cut disclosure reaches a native backend as sent.
      answer = { ok: true, stdout: 'a'.repeat(8000), stderr: '', exit_code: 0, truncated: true, stdoutBytes: 8001 }
      await expect(admission.bridgeDispatcher.dispatch(request('git log'), context(handle.instanceId)))
        .resolves.toEqual({ exitCode: 0, stdout: 'a'.repeat(8000), stderr: '', truncated: true, stdoutBytes: 8001 })

      // Another instance, another root, or an agent initiator is refused.
      service.mockClear()
      await expect(admission.bridgeDispatcher.dispatch(request('git status'), context('not-running')))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      await expect(admission.bridgeDispatcher.dispatch(request('git status'), context(handle.instanceId, { authorizedPlanRoot: root })))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      const agent = context(handle.instanceId)
      await expect(admission.bridgeDispatcher.dispatch(request('git status'), {
        ...agent, runtime: { ...agent.runtime, initiator: { kind: 'agent', source: 'mcp', id: 'a' } as never },
      })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      expect(service).not.toHaveBeenCalled()

      // Revoking the user Grant's shell mode takes effect at the next dispatch.
      grant = { packageVersion: '1.0.0', system: [], storage: true }
      await expect(admission.bridgeDispatcher.dispatch(request('git status'), context(handle.instanceId)))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      grant = null
      await expect(admission.bridgeDispatcher.dispatch(request('git status'), context(handle.instanceId)))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
      expect(service).not.toHaveBeenCalled()
      mgr.destroyInstance(handle.instanceId)
    } finally {
      bind.mockRestore()
      service.mockRestore()
      await mgr.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // 0.2.25: an agent tool call gets no shell. dispatchShell admits an agent
  // read tool's read-only VCS command and a write tool's command with the DB3
  // answer, but the real port (thirdPartyShellGrantAllows) serves only a
  // user-initiated call from a live view, so both are refused before the
  // broker. Opening it would widen what agents can do: the user's decision,
  // disclosed in the consent dialog.
  it.skipIf(isWindows())('refuses shell.run to an agent tool call, read or write, at the real shell port', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'third-party-shell-agent-')))
    const workspace = join(root, 'workspace')
    const packageDir = join(root, 'package')
    mkdirSync(workspace)
    mkdirSync(join(packageDir, 'backend'), { recursive: true })
    writeFileSync(join(packageDir, 'backend', 'acme-indexer'), 'binary', { mode: 0o700 })
    writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.indexer', name: 'Indexer', version: '1.0.0', publisher: 'acme',
      permissions: { shell: 'allowlist' },
      marketplace: { description: 'Index files.', license: 'MIT' },
      contributes: { views: [{ id: 'left', kind: 'custom', location: 'left', title: 'Indexer', entry: 'frontend/left/index.html' }] },
      backend: { entry: 'backend/acme-indexer', protocolVersion: 1, activation: 'startup', methods: ['files.search'] },
    }))
    const spec = thirdPartyBackendLaunchSpec({
      pluginId: 'acme.indexer', packageVersion: '1.0.0', packageDir, views: [],
      backend: { entryFile: join(packageDir, 'backend', 'acme-indexer'), protocolVersion: 1, activation: 'startup' },
    })!
    const view: NonNullable<PluginLaunchDescriptor['views']>[number] = {
      id: 'left', contributionKey: 'acme.indexer.left', kind: 'custom', location: 'left', title: 'Indexer',
      entryFile: join(packageDir, 'frontend/left/index.html'),
    }
    const pluginDescriptor: PluginLaunchDescriptor = {
      id: 'acme.indexer', packageVersion: '1.0.0', packageDir, requires: ['shell'],
      capabilityPolicy: manifestV2CapabilityPolicy({ shell: 'allowlist' }),
      devUrl: '', entryFile: view.entryFile, views: [view],
    }
    const mgr = new FrontendPluginManager()
    const grant = { packageVersion: '1.0.0', system: [] as never[], shell: 'allowlist' as const, storage: true }
    mgr.setCapabilityGrantResolver(() => grant)
    mgr.registerDescriptor(pluginDescriptor, { builtin: true })
    mgr.registerBackendActivation(spec)
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindView').mockResolvedValue(undefined)
    const service = vi.spyOn(
      mgr as unknown as { sendPublicBackend: (type: string, payload: Record<string, unknown>, before?: () => boolean) => Promise<unknown> },
      'sendPublicBackend',
    ).mockImplementation(async (_type, _payload, before) => {
      if (before && !before()) throw new Error('request denied before dispatch')
      return { ok: true, stdout: 'main\n', stderr: '', exit_code: 0 }
    })
    const store = new NativeBackendStore(join(root, 'store'))
    store.setEnabled(true)
    // An admitted agent tool call, as FrontendPluginManager.agentToolCallFor reports it.
    let call: { pluginId: string; risk: 'read' | 'write'; workspaceRoot: string } | undefined
    const controller = new ThirdPartyBackendController({
      store,
      dataRoot: join(root, 'data'),
      probe: { platform: 'darwin', sandboxExec: () => '/usr/bin/sandbox-exec', bubblewrap: () => null },
      promptConsent: async () => true,
      shellPort: () => mgr.createThirdPartyShellPort(),
      agentToolCall: (id) => (id === 'agent-call' ? call : undefined),
      watchResources: () => ({ dispose: () => undefined, sample: async () => null, terminate: async (item: ResourceViolation) => item, keepRunning: () => 0 }),
    })
    const host = new FakeBrowserWindow()
    try {
      const handle = await mgr.openView(pluginDescriptor, view, {
        hostWindow: asHost(host),
        bounds: 'fill',
        workspacePath: workspace,
        capabilityContext: {
          publisherEligible: false,
          userGrant: grant,
          runtimeBinding: {
            pluginId: 'acme.indexer', packageVersion: '1.0.0',
            workspaceId: mgr.workspaceIdForPath(workspace), instanceId: null, audience: view.contributionKey,
          },
        } as HostCapabilityContext,
      })
      const admission = await controller.admit(spec, workspace)
      const context = (initiator: PlansBridgeContext['runtime']['initiator']): PlansBridgeContext => ({
        runtime: {
          pluginId: 'acme.indexer', packageVersion: '1.0.0', workspaceId: mgr.workspaceIdForPath(workspace),
          instanceId: handle.instanceId, contributionKey: view.contributionKey, hostWindowId: 'w', initiator,
        },
        workspacePath: workspace,
        authorizedPlanRoot: workspace,
        requestId: 'bridge:1',
        signal: new AbortController().signal,
        emit: () => undefined,
      })
      const run = (command: string, initiator: PlansBridgeContext['runtime']['initiator']) => admission.bridgeDispatcher.dispatch({
        id: 'bridge:1', origin: { kind: 'call' as const, requestId: 'r' }, port: 'shell' as const, operation: 'run', arguments: { command },
      }, context(initiator))
      const agent = { kind: 'agent', source: 'mcp', id: 'agent-call' } as never

      // Everything a call needs is in place: the user's own call runs.
      await expect(run('git status', { kind: 'user', id: 'u' })).resolves.toEqual({ exitCode: 0, stdout: 'main\n', stderr: '' })
      service.mockClear()

      // A read tool, read-only VCS command: past dispatchShell, refused by the port.
      call = { pluginId: 'acme.indexer', risk: 'read', workspaceRoot: workspace }
      await expect(run('git status', agent)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED', message: 'Shell capability is denied.' })
      // A write tool with the user's DB3 answer: the same.
      call = { pluginId: 'acme.indexer', risk: 'write', workspaceRoot: workspace }
      store.setAgentToolWrite('acme.indexer', '1.0.0', store.record('acme.indexer').consent!.grantedAt, workspace)
      for (const command of ['git status', 'git commit -m x']) {
        await expect(run(command, agent)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED', message: 'Shell capability is denied.' })
      }
      // Nothing reached the shell broker.
      expect(service).not.toHaveBeenCalled()
      mgr.destroyInstance(handle.instanceId)
    } finally {
      bind.mockRestore()
      service.mockRestore()
      await mgr.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('agent capability requests the Host cannot serve', () => {
  type SentMessage = { id: string; type: string; payload: Record<string, unknown> }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  function connectHost(id: string, registered: boolean): {
    mgr: FrontendPluginManager
    socket: InstanceType<typeof wsMock.FakeNodeWebSocket>
  } {
    const mgr = new FrontendPluginManager()
    mgr.open(
      asHost(new FakeBrowserWindow()),
      { id, requires: ['terminal'], devUrl: '', entryFile: `/plugins/${id}/index.html` },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl(`ws://${id}`)
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    if (registered) {
      const registration = sentOf(socket).find((message) => message.type === 'host.register')!
      socket.receive({
        id: registration.id,
        type: 'host.register',
        ok: true,
        payload: { registered: true },
        error: null,
        timestamp: '',
      })
    }
    return { mgr, socket }
  }

  function sentOf(socket: InstanceType<typeof wsMock.FakeNodeWebSocket>): SentMessage[] {
    return socket.sent.map((raw) => JSON.parse(raw) as SentMessage)
  }

  function resultsOf(socket: InstanceType<typeof wsMock.FakeNodeWebSocket>): SentMessage[] {
    return sentOf(socket).filter((message) => message.type === 'agent.capability.result')
  }

  function request(socket: InstanceType<typeof wsMock.FakeNodeWebSocket>, payload: unknown): void {
    socket.receive({ type: 'agent.capability.request', payload })
  }

  const legacyRequest = (requestId: string): Record<string, unknown> => ({
    request_id: requestId,
    instance_id: 'missing-instance',
    operation: 'capability',
    payload: { reqId: 'inner', ns: 'fs', method: 'read', args: {} },
  })

  it('answers a malformed request with BAD_REQUEST instead of staying silent', async () => {
    const { socket } = connectHost('acme.agent-malformed', true)
    await flush()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      request(socket, { request_id: 'req-malformed', operation: 'capability' })
      await flush()

      const results = resultsOf(socket)
      expect(results).toHaveLength(1)
      expect(results[0].payload).toEqual({
        request_id: 'req-malformed',
        response: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'BAD_REQUEST' }) }),
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('req-malformed'))
    } finally {
      warn.mockRestore()
    }
  })

  it('logs a malformed request without a request id and sends nothing', async () => {
    const { socket } = connectHost('acme.agent-malformed-no-id', true)
    await flush()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      request(socket, ['not', 'an', 'object'])
      await flush()

      expect(resultsOf(socket)).toHaveLength(0)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[plugin-backend]'))
    } finally {
      warn.mockRestore()
    }
  })

  it('answers BACKEND_UNAVAILABLE when the Host session is not registered', async () => {
    const { socket } = connectHost('acme.agent-unregistered', false)
    await flush()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      request(socket, legacyRequest('req-unregistered'))
      await flush()

      const results = resultsOf(socket)
      expect(results).toHaveLength(1)
      expect(results[0].payload).toEqual({
        request_id: 'req-unregistered',
        response: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'BACKEND_UNAVAILABLE' }) }),
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('req-unregistered'))
    } finally {
      warn.mockRestore()
    }
  })

  it('logs and answers the requesting client when it is no longer the current one', async () => {
    const { mgr } = connectHost('acme.agent-stale', true)
    await flush()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const staleSend = vi.fn(() => Promise.reject(new Error('ws not open')))
    try {
      await (mgr as unknown as {
        handleAgentCapabilityRequest: (client: unknown, payload: unknown) => Promise<void>
      }).handleAgentCapabilityRequest({ send: staleSend }, legacyRequest('req-stale'))

      expect(staleSend).toHaveBeenCalledOnce()
      expect(staleSend).toHaveBeenCalledWith(
        'agent.capability.result',
        {
          request_id: 'req-stale',
          response: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'BACKEND_UNAVAILABLE' }) }),
        },
        10_000,
      )
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('req-stale'))
    } finally {
      warn.mockRestore()
    }
  })

  it('logs and answers with an error when the session lapses while the request runs', async () => {
    const { mgr, socket } = connectHost('acme.agent-lapsed', true)
    await flush()
    let finish!: (response: unknown) => void
    const execute = vi.spyOn(mgr, 'executeAgentCapability').mockImplementation(
      () => new Promise((settle) => { finish = settle as (response: unknown) => void }),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      request(socket, legacyRequest('req-lapsed'))
      await flush()
      expect(execute).toHaveBeenCalledOnce()

      // A token change drops the registration while the call is in flight.
      mgr.setBackendHostToken('rotated-token')
      finish({ reqId: 'inner', ok: true, result: { secret: 'must not leave' } })
      await flush()

      const results = resultsOf(socket)
      expect(results).toHaveLength(1)
      expect(results[0].payload).toEqual({
        request_id: 'req-lapsed',
        response: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'BACKEND_UNAVAILABLE' }) }),
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('req-lapsed'))
    } finally {
      warn.mockRestore()
      execute.mockRestore()
    }
  })

  it('keeps the registration through a Plans call that re-marks an already withdrawn backend', async () => {
    const mgr = new FrontendPluginManager()
    const packageVersion = '1.0.0'
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(), requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '', entryFile: '/plugins/navide.plans/frontend/window/index.html', views: [],
    }, { builtin: true })
    mgr.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID, packageVersion, packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans', protocolVersion: 1, activation: 'startup',
      approvedMethods: ['plans.list'], agentMethods: ['plans.list'], approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    mgr.setCapabilityGrantResolver(() => ({ packageVersion, system: ['fs'], storage: true }))
    mgr.setExecutionPolicyResolver(() => ({
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] }, revision: 1, state: 'user',
    }))
    // Legacy recovery: storage readiness stays false for the rest of the session.
    mgr.setPlansStorageReadinessHandler(async () => false)
    mgr.open(
      asHost(new FakeBrowserWindow()),
      { id: 'acme.agent-plans-recovery', requires: ['terminal'], devUrl: '', entryFile: '/plugins/acme.agent-plans-recovery/index.html' },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl('ws://acme.agent-plans-recovery')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const answered = new Set<string>()
    const answerRegistrations = (): void => {
      for (const message of sentOf(socket)) {
        if (message.type !== 'host.register' || answered.has(message.id)) continue
        answered.add(message.id)
        socket.receive({
          id: message.id, type: 'host.register', ok: true,
          payload: { registered: true }, error: null, timestamp: '',
        })
      }
    }
    answerRegistrations()
    await flush()
    // The child dies once; the withdrawn feature is re-advertised and accepted.
    mgr.markPlansBackendUnavailable('child-unavailable')
    await flush()
    answerRegistrations()
    await flush()
    const registrationsBefore = sentOf(socket).filter((message) => message.type === 'host.register').length
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      request(socket, {
        request_id: 'req-plans-recovery',
        target: { plugin_id: PLANS_PLUGIN_ID, workspace_path: '/workspace' },
        operation: 'backend',
        payload: { reqId: 'mcp:1', name: 'plans.list', args: {} },
      })
      await flush()

      const results = resultsOf(socket)
      expect(results).toHaveLength(1)
      // The legacy fallback verdict reaches the MCP caller instead of
      // "Host backend session lapsed while the request ran".
      expect(results[0].payload).toEqual({
        request_id: 'req-plans-recovery',
        response: expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'BACKEND_UNAVAILABLE', message: 'Plans storage is unavailable' }),
          recoveryDisposition: 'legacy-safe-before-dispatch',
        }),
      })
      // Nothing about the advertised features changed, so nothing is re-sent.
      expect(sentOf(socket).filter((message) => message.type === 'host.register')).toHaveLength(registrationsBefore)
    } finally {
      warn.mockRestore()
      await mgr.closeBackendPlugins()
    }
  })

  it('answers BACKEND_ERROR when executing the request throws', async () => {
    const { mgr, socket } = connectHost('acme.agent-throws', true)
    await flush()
    const execute = vi.spyOn(mgr, 'executeAgentCapability').mockRejectedValue(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      request(socket, legacyRequest('req-throws'))
      await flush()

      const results = resultsOf(socket)
      expect(results).toHaveLength(1)
      expect(results[0].payload).toEqual({
        request_id: 'req-throws',
        response: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'BACKEND_ERROR' }) }),
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('req-throws'))
    } finally {
      warn.mockRestore()
      execute.mockRestore()
    }
  })

  it('still answers a well-formed request on the current client exactly once', async () => {
    const { socket } = connectHost('acme.agent-normal', true)
    await flush()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      request(socket, legacyRequest('req-normal'))
      await flush()

      const results = resultsOf(socket)
      expect(results).toHaveLength(1)
      expect(results[0].payload).toEqual({
        request_id: 'req-normal',
        response: { reqId: 'inner', ok: false, error: { code: 'BAD_REQUEST', message: 'unknown plugin instance' } },
      })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

// B2-a: the backend's read-only Marketplace MCP tools ask the Host over its
// authenticated session; only the registered session's client is answered.
describe('marketplace.query requests from the backend', () => {
  type SentMessage = { id: string; type: string; payload: Record<string, unknown> }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  function connectHost(id: string, registered: boolean): {
    mgr: FrontendPluginManager
    socket: InstanceType<typeof wsMock.FakeNodeWebSocket>
  } {
    const mgr = new FrontendPluginManager()
    mgr.open(
      asHost(new FakeBrowserWindow()),
      { id, requires: ['terminal'], devUrl: '', entryFile: `/plugins/${id}/index.html` },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl(`ws://${id}`)
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    if (registered) {
      const registration = (socket.sent.map((raw) => JSON.parse(raw) as SentMessage))
        .find((message) => message.type === 'host.register')!
      socket.receive({ id: registration.id, type: 'host.register', ok: true, payload: { registered: true }, error: null, timestamp: '' })
    }
    return { mgr, socket }
  }

  const resultsOf = (socket: InstanceType<typeof wsMock.FakeNodeWebSocket>): SentMessage[] =>
    socket.sent.map((raw) => JSON.parse(raw) as SentMessage).filter((m) => m.type === 'marketplace.query.result')

  it('answers from the installed handler on the registered session', async () => {
    const { mgr, socket } = connectHost('acme.mq-ok', true)
    const handler = vi.fn(async () => ({ ok: true as const, result: { kind: 'installed' as const, items: [] } }))
    mgr.setMarketplaceQueryHandler(handler)
    await flush()

    socket.receive({ type: 'marketplace.query.request', payload: { request_id: 'mq:1', query: { kind: 'installed' } } })
    await flush()

    expect(handler).toHaveBeenCalledWith({ kind: 'installed' })
    expect(resultsOf(socket).map((m) => m.payload)).toEqual([
      { request_id: 'mq:1', ok: true, result: { kind: 'installed', items: [] } },
    ])
  })

  it('answers HOST_UNAVAILABLE without asking the handler when the session is not registered', async () => {
    const { mgr, socket } = connectHost('acme.mq-unregistered', false)
    const handler = vi.fn()
    mgr.setMarketplaceQueryHandler(handler)
    await flush()

    socket.receive({ type: 'marketplace.query.request', payload: { request_id: 'mq:2', query: { kind: 'installed' } } })
    await flush()

    expect(handler).not.toHaveBeenCalled()
    expect(resultsOf(socket).map((m) => m.payload)).toEqual([
      expect.objectContaining({ request_id: 'mq:2', ok: false, error_code: 'HOST_UNAVAILABLE' }),
    ])
  })

  it('refuses extra fields as BAD_REQUEST and reports a throwing handler as HOST_UNAVAILABLE', async () => {
    const { mgr, socket } = connectHost('acme.mq-bad', true)
    mgr.setMarketplaceQueryHandler(async () => { throw new Error('boom') })
    await flush()

    socket.receive({ type: 'marketplace.query.request', payload: { request_id: 'mq:3', query: {}, initiator: 'x' } })
    socket.receive({ type: 'marketplace.query.request', payload: { request_id: 'mq:4', query: { kind: 'installed' } } })
    await flush()

    expect(resultsOf(socket).map((m) => m.payload)).toEqual([
      expect.objectContaining({ request_id: 'mq:3', ok: false, error_code: 'BAD_REQUEST' }),
      { request_id: 'mq:4', ok: false, error: 'boom', error_code: 'HOST_UNAVAILABLE' },
    ])
  })
})

// B2-c: an agent's plugins_disable / plugins_enable reaches the Host over its
// authenticated session; only the registered session's client is answered.
describe('plugins.agent_action requests from the backend', () => {
  type SentMessage = { id: string; type: string; payload: Record<string, unknown> }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  function connectHost(id: string, registered: boolean): {
    mgr: FrontendPluginManager
    socket: InstanceType<typeof wsMock.FakeNodeWebSocket>
  } {
    const mgr = new FrontendPluginManager()
    mgr.open(
      asHost(new FakeBrowserWindow()),
      { id, requires: ['terminal'], devUrl: '', entryFile: `/plugins/${id}/index.html` },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl(`ws://${id}`)
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    if (registered) {
      const registration = (socket.sent.map((raw) => JSON.parse(raw) as SentMessage))
        .find((message) => message.type === 'host.register')!
      socket.receive({ id: registration.id, type: 'host.register', ok: true, payload: { registered: true }, error: null, timestamp: '' })
    }
    return { mgr, socket }
  }

  const resultsOf = (socket: InstanceType<typeof wsMock.FakeNodeWebSocket>): SentMessage[] =>
    socket.sent.map((raw) => JSON.parse(raw) as SentMessage).filter((m) => m.type === 'plugins.agent_action.result')
  const request = {
    request_id: 'pa:1', action: 'disable', plugin_id: 'nerdtechnic.devmap',
    requester: { paneId: 'p-41', paneName: 'dev', workspace: '/w', callerKind: 'pane' },
  }

  it('answers from the installed handler on the registered session', async () => {
    const { mgr, socket } = connectHost('acme.pa-ok', true)
    const handler = vi.fn(async () => ({ ok: true as const, pluginId: 'nerdtechnic.devmap', pluginVersion: '0.2.0', disabled: true, changed: true }))
    mgr.setPluginAgentActionHandler(handler)
    await flush()

    socket.receive({ type: 'plugins.agent_action.request', payload: request })
    await flush()

    expect(handler).toHaveBeenCalledWith(request)
    expect(resultsOf(socket).map((m) => m.payload)).toEqual([
      { request_id: 'pa:1', ok: true, pluginId: 'nerdtechnic.devmap', pluginVersion: '0.2.0', disabled: true, changed: true },
    ])
  })

  it('answers HOST_UNAVAILABLE without asking the handler when the session is not registered', async () => {
    const { mgr, socket } = connectHost('acme.pa-unregistered', false)
    const handler = vi.fn()
    mgr.setPluginAgentActionHandler(handler)
    await flush()

    socket.receive({ type: 'plugins.agent_action.request', payload: { ...request, request_id: 'pa:2' } })
    await flush()

    expect(handler).not.toHaveBeenCalled()
    expect(resultsOf(socket).map((m) => m.payload)).toEqual([
      expect.objectContaining({ request_id: 'pa:2', ok: false, error_code: 'HOST_UNAVAILABLE' }),
    ])
  })

  it('reports a throwing handler as ACTION_FAILED', async () => {
    const { mgr, socket } = connectHost('acme.pa-throw', true)
    mgr.setPluginAgentActionHandler(async () => { throw new Error('busy') })
    await flush()

    socket.receive({ type: 'plugins.agent_action.request', payload: { ...request, request_id: 'pa:3' } })
    await flush()

    expect(resultsOf(socket).map((m) => m.payload)).toEqual([
      { request_id: 'pa:3', ok: false, error: 'busy', error_code: 'ACTION_FAILED' },
    ])
  })
})

describe('installed package inventory scope disclosure', () => {
  it('keeps declared filesystem scopes in the listed inventory as a copy', () => {
    const mgr = new FrontendPluginManager()
    const scopes = { fs: { read: ['.acme/notes'], write: ['.acme/notes'] } }
    mgr.registerInstalledPackage({
      id: 'acme.notes',
      requires: ['fs'],
      packageVersion: '1.0.0',
      manifestPermissions: { system: ['fs'], scopes },
    })

    const [listed] = mgr.listInstalledPackages()
    expect(listed.manifestPermissions).toEqual({ system: ['fs'], scopes })
    listed.manifestPermissions!.scopes!.fs!.write!.push('mutated')
    scopes.fs.read.push('mutated')
    expect(mgr.listInstalledPackages()[0].manifestPermissions?.scopes).toEqual({
      fs: { read: ['.acme/notes'], write: ['.acme/notes'] },
    })
  })
})

// Closing a window that hosts embedded AI panels (AiCliDock) ends them: the
// manager owns the main process's backend connection, so it sends the
// terminal.kill_surface. During an app quit nothing is sent — the panels'
// records stay 'spawned' and restore next launch.
describe('FrontendPluginManager — ending a closed window\'s AI panels', () => {
  function sentOfType(socket: { sent: string[] }, type: string): Array<Record<string, unknown>> {
    return socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> })
      .filter((request) => request.type === type)
      .map((request) => request.payload)
  }

  it('sends terminal.kill_surface for the surface and workspace', () => {
    const mgr = new FrontendPluginManager()
    mgr.setBackendWsUrl('ws://dock-close-test')
    mgr.endDockSurface('plans', '/ws/a')
    // The first send connects the manager's transport; queued sends go out on open.
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    expect(socket.url).toBe('ws://dock-close-test')
    socket.open()
    mgr.endDockSurface('git')
    expect(sentOfType(socket, 'terminal.kill_surface')).toEqual([
      { surface: 'plans', workspace_path: '/ws/a' },
      { surface: 'git', workspace_path: '' },
    ])
  })

  it('sends nothing while the app is quitting', () => {
    const mgr = new FrontendPluginManager()
    mgr.setBackendWsUrl('ws://dock-close-test-quit')
    const before = wsMock.FakeNodeWebSocket.instances.length
    let quitting = true
    mgr.setAppQuittingProbe(() => quitting)
    mgr.endDockSurface('editor')
    // Not even a connection is opened for it.
    expect(wsMock.FakeNodeWebSocket.instances.length).toBe(before)
    quitting = false
    mgr.endDockSurface('editor')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    expect(sentOfType(socket, 'terminal.kill_surface')).toEqual([{ surface: 'editor', workspace_path: '' }])
  })

  it('does nothing before a backend is known', () => {
    const mgr = new FrontendPluginManager()
    expect(() => mgr.endDockSurface('plans', '/ws/a')).not.toThrow()
  })

  it('warns about panels the backend could not end', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const mgr = new FrontendPluginManager()
      mgr.setBackendWsUrl('ws://dock-close-failed-test')
      mgr.endDockSurface('git', '/ws/a')
      const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
      socket.open()
      const request = socket.sent
        .map((raw) => JSON.parse(raw) as { id: string; type: string })
        .find((sent) => sent.type === 'terminal.kill_surface')!
      socket.receive({
        id: request.id,
        type: 'terminal.kill_surface',
        ok: true,
        payload: {
          ok: true,
          pane_ids: ['git-b'],
          failed: [{ pane_id: 'git-a', terminal_session_id: 't-git-a', error: 'kill failed' }],
        },
        error: null,
        timestamp: '',
      })
      await vi.waitFor(() => {
        expect(warn.mock.calls.map((call) => String(call[0])).join('\n'))
          .toContain('git-a (t-git-a): kill failed')
      })
    } finally {
      warn.mockRestore()
    }
  })

  // Removing a built-in plugin with nothing to take over ends its panels: their
  // PTYs are not in the AI-session ledger, so no other removal step reaches them.
  it('ends the panels of a removed built-in plugin that no fallback replaces', () => {
    const mgr = new FrontendPluginManager()
    mgr.setBackendWsUrl('ws://dock-removal-test')
    mgr.registerInstalledPackage({ id: PLANS_PLUGIN_ID, requires: [] }, undefined, { official: true })
    mgr.removeInstalledPlugin(PLANS_PLUGIN_ID)
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    expect(socket.url).toBe('ws://dock-removal-test')
    socket.open()
    expect(sentOfType(socket, 'terminal.kill_surface')).toEqual([{ surface: 'plans', workspace_path: '' }])
  })

  it('leaves the panels running when a built-in fallback takes over', () => {
    const mgr = new FrontendPluginManager()
    mgr.setBackendWsUrl('ws://dock-removal-fallback-test')
    const before = wsMock.FakeNodeWebSocket.instances.length
    mgr.registerBuiltin(devPlansPluginDescriptor())
    mgr.registerInstalledPackage({ id: PLANS_PLUGIN_ID, requires: [] }, undefined, { official: true })
    mgr.removeInstalledPlugin(PLANS_PLUGIN_ID)
    expect(wsMock.FakeNodeWebSocket.instances.length).toBe(before)
  })

  it('ends no panel for a plugin without a panel surface', () => {
    const mgr = new FrontendPluginManager()
    mgr.setBackendWsUrl('ws://dock-removal-thirdparty-test')
    const before = wsMock.FakeNodeWebSocket.instances.length
    mgr.registerInstalledPackage({ id: 'acme.demo', requires: [] })
    mgr.removeInstalledPlugin('acme.demo')
    expect(wsMock.FakeNodeWebSocket.instances.length).toBe(before)
  })

  it('warns when the backend refuses the kill', async () => {
    const mgr = new FrontendPluginManager()
    const send = vi.fn(() => Promise.reject(new Error('backend down')))
    ;(mgr as unknown as { ensureBackend: () => unknown }).ensureBackend = () => ({ send })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      mgr.endDockSurface('plans', '/ws/a')
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('terminal.kill_surface'), expect.any(Error)))
    } finally {
      warn.mockRestore()
    }
  })
})

describe('agent tool call request shape (shared fixture with the core proxy)', () => {
  const fixture = JSON.parse(readFileSync(
    join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures/agent-tool-call-requests.json'), 'utf8',
  )) as {
    valid: Array<{ name: string; request: Record<string, unknown>; hostVerifiedTo: string }>
    invalid: Array<{ name: string; request: Record<string, unknown> }>
  }
  it.each(fixture.valid.map((entry) => [entry.name, entry] as const))('accepts %s', (_name, entry) => {
    const parsed = parseAgentToolCallRequest(entry.request)
    expect(parsed).not.toBeNull()
    const caller = entry.request.caller as { kind: string; paneId: string | null }
    expect(parsed!.caller).toEqual({
      kind: caller.kind, paneId: caller.paneId, workspace: (entry.request.caller as { workspace: string | null }).workspace,
    })
    // The Host never keeps the sent label; it derives its own from the kind.
    expect(parsed!.caller).not.toHaveProperty('verifiedTo')
    expect(parsed!.caller.kind === 'pane' ? 'pane' : 'caller-kind').toBe(entry.hostVerifiedTo)
  })
  it.each(fixture.invalid.map((entry) => [entry.name, entry] as const))('refuses %s', (_name, entry) => {
    expect(parseAgentToolCallRequest(entry.request)).toBeNull()
  })
})

// Plan B1-b: the generalized Host route for third-party agent tools.
describe('third-party agent tool calls (contract 4.2)', () => {
  type SentMessage = { id: string; type: string; payload: Record<string, unknown> }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  const settle = async (): Promise<void> => {
    await flush()
    await new Promise((done) => setTimeout(done, 0))
    await flush()
  }

  interface Fixture {
    mgr: FrontendPluginManager
    socket: InstanceType<typeof wsMock.FakeNodeWebSocket>
    root: string
    workspace: string
    spec: () => ThirdPartyLaunchSpec
    switches: { enabled: boolean; externalCallers: boolean }
    disabled: Set<string>
    consented: { value: boolean }
    confirmWrite: ReturnType<typeof vi.fn>
    gate: PluginAgentToolsHost
    bind: MockInstance<PluginBackendHost['bindAgentToolWorkspace']>
    call: MockInstance<PluginBackendHost['call']>
    policy: { value: ExecutionPolicySnapshot }
    grant: { value: { packageVersion: string; system: Array<'fs' | 'web'>; storage: boolean } | null }
    openWorkspaces: Set<string>
    cleanup: () => Promise<void>
  }

  function sentOf(socket: InstanceType<typeof wsMock.FakeNodeWebSocket>): SentMessage[] {
    return socket.sent.map((raw) => JSON.parse(raw) as SentMessage)
  }

  async function fixture(options: { enabled?: boolean; register?: boolean; system?: Array<'fs' | 'web'> } = {}): Promise<Fixture> {
    const system = options.system ?? ['fs']
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tools-')))
    const workspace = join(root, 'workspace')
    const packageDir = join(root, 'package')
    mkdirSync(workspace)
    mkdirSync(join(packageDir, 'backend'), { recursive: true })
    writeFileSync(join(packageDir, 'backend', 'devmap'), 'binary', { mode: 0o700 })
    writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 2, apiVersion: '^1.0.0', id: 'nerdtechnic.devmap', name: 'Dev map', version: '0.2.0', publisher: 'nerdtechnic',
      permissions: { system },
      marketplace: { description: 'Dev map.', license: 'MIT' },
      backend: { entry: 'backend/devmap', protocolVersion: 1, activation: 'startup', methods: ['devmap.read', 'devmap.setStatus'] },
    }))
    const parsed = readInstalledManifestV2(packageDir)
    const agentTools = [
      { name: 'devmap_read', method: 'devmap.read', risk: 'read', title: 'Read dev map', description: 'Read the dev map.', inputSchema: { type: 'object', properties: {} } },
      { name: 'devmap_set_status', method: 'devmap.setStatus', risk: 'write', title: 'Set block status', description: 'Set a block status.', inputSchema: { type: 'object', required: ['block_id'], properties: { block_id: { type: 'string' } } } },
    ]
    const registered = thirdPartyBackendLaunchSpec(
      { pluginId: 'nerdtechnic.devmap', packageVersion: '0.2.0', packageDir, views: [], backend: { entryFile: join(packageDir, 'backend', 'devmap'), protocolVersion: 1, activation: 'startup' } },
      { ...parsed, backend: { ...parsed.backend!, agentTools } as never },
    )!
    const mgr = new FrontendPluginManager()
    const grant: Fixture['grant'] = { value: { packageVersion: '0.2.0', system, storage: true } }
    mgr.setCapabilityGrantResolver(() => grant.value)
    const policy: Fixture['policy'] = { value: { policy: HOST_DEFAULT_EXECUTION_POLICY, revision: 1, state: 'default' } }
    mgr.setExecutionPolicyResolver(() => policy.value)
    mgr.registerDescriptor({
      id: 'nerdtechnic.devmap', packageVersion: '0.2.0', packageDir, requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system }), devUrl: '', entryFile: join(packageDir, 'index.html'), views: [],
    }, { builtin: true })
    mgr.registerBackendActivation(registered)
    const spec = () => mgr.getBackendActivation('nerdtechnic.devmap', '0.2.0') as ThirdPartyLaunchSpec
    const switches = { enabled: options.enabled ?? true, externalCallers: false }
    const disabled = new Set<string>()
    const consented = { value: true }
    const confirmWrite = vi.fn(async () => true)
    const gate = new PluginAgentToolsHost({
      switches: () => ({ ...switches }),
      setSwitches: (change) => Object.assign(switches, change),
      listPackages: () => (spec() ? [spec()] : []),
      isDisabled: (pluginId) => disabled.has(pluginId),
      hasConsent: async () => consented.value,
      agentToolSince: () => '2026-10-01T00:00:00.000Z',
      setAgentMethods: (pluginId, version, methods) => mgr.setThirdPartyAgentMethods(pluginId, version, methods),
      confirmWrite,
      send: (payload) => mgr.sendAgentToolsSync(payload),
    })
    mgr.setAgentToolsHost(gate)
    const openWorkspaces = new Set([workspace])
    mgr.setAgentToolWorkspaceResolver((candidate) => openWorkspaces.has(candidate))
    const bind = vi.spyOn(PluginBackendHost.prototype, 'bindAgentToolWorkspace').mockResolvedValue('headless-1')
    const isBound = vi.spyOn(PluginBackendHost.prototype, 'isBound').mockReturnValue(true)
    const call = vi.spyOn(PluginBackendHost.prototype, 'call').mockResolvedValue({ status: 'done' } as never)
    // A running view is what opens the backend connection.
    mgr.open(
      asHost(new FakeBrowserWindow()),
      { id: 'acme.agent-tools-anchor', requires: ['terminal'], devUrl: '', entryFile: '/plugins/acme.agent-tools-anchor/index.html' },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl(`ws://agent-tools-${Math.random()}`)
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    if (options.register !== false) {
      const registration = sentOf(socket).find((message) => message.type === 'host.register')!
      socket.receive({ id: registration.id, type: 'host.register', ok: true, payload: { registered: true }, error: null, timestamp: '' })
      await settle()
    }
    return {
      mgr, socket, root, workspace, spec, switches, disabled, consented, confirmWrite, gate, bind, call, policy, grant, openWorkspaces,
      cleanup: async () => {
        bind.mockRestore()
        isBound.mockRestore()
        call.mockRestore()
        await mgr.closeBackendPlugins()
        rmSync(root, { recursive: true, force: true })
      },
    }
  }

  function toolRequest(f: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      request_id: 'mcp:1',
      operation: 'agentTool',
      target: { plugin_id: 'nerdtechnic.devmap', workspace_path: f.workspace },
      tool: { name: 'devmap_set_status', plugin_version: '0.2.0', sync_revision: 1 },
      caller: { kind: 'pane', paneId: 'p-41', workspace: f.workspace },
      payload: { arguments: { block_id: 'b1', status: 'done' } },
      ...overrides,
    }
  }

  async function ask(f: Fixture, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const before = sentOf(f.socket).filter((message) => message.type === 'agent.capability.result').length
    f.socket.receive({ type: 'agent.capability.request', payload: request })
    for (let i = 0; i < 20; i++) {
      await settle()
      const results = sentOf(f.socket).filter((message) => message.type === 'agent.capability.result')
      if (results.length > before) {
        expect(results.at(-1)!.payload.request_id).toBe(request.request_id)
        return results.at(-1)!.payload.response as Record<string, unknown>
      }
    }
    throw new Error('no agent.capability.result')
  }

  describe('chunked transfer with the core (contract 4.4, A2 and R2)', () => {
    const big = (bytes: number): { rows: string } => ({ rows: 'abc中文😀'.repeat(Math.ceil(bytes / 13)) })
    const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
    const pieces = (text: string): string[] => {
      const out: string[] = []
      let current = ''
      let bytes = 0
      for (const char of text) {
        const size = Buffer.byteLength(char, 'utf8')
        if (bytes + size > 131_072) { out.push(current); current = ''; bytes = 0 }
        current += char
        bytes += size
      }
      out.push(current)
      return out
    }
    /** Answers every request message of `type` the Host sends, as the core would. */
    async function answer(f: Fixture, type: string, accepted: (seq: number) => boolean, until: () => boolean): Promise<number> {
      let answered = 0
      for (let i = 0; i < 2_000 && !until(); i++) {
        await settle()
        for (const message of sentOf(f.socket).filter((m) => m.type === type).slice(answered)) {
          f.socket.receive({ id: message.id, type, ok: true, payload: { ok: true, accepted: accepted(answered) }, error: null, timestamp: '' })
          answered += 1
        }
      }
      return answered
    }

    it("discloses the backend's result helper state in resource usage and tells the windows of each change", async () => {
      const f = await fixture()
      try {
        const heard: unknown[] = []
        f.mgr.onResultHelperState = (state) => heard.push(state)
        expect(f.mgr.backendResourceUsage().backend).toMatchObject({ resultHelper: { state: 'idle', lastError: '' } })
        const unavailable = { state: 'unavailable', lastError: 'it exited before it was ready', since: 1_700_000_000_000 }
        f.socket.receive({ type: 'agent.tools.result_helper', payload: unavailable })
        await settle()
        expect(f.mgr.backendResourceUsage().backend).toEqual({ resultHelper: unavailable })
        expect(heard).toEqual([unavailable])
        // A malformed report changes nothing.
        f.socket.receive({ type: 'agent.tools.result_helper', payload: { state: 'broken', lastError: 1, since: 'x' } })
        await settle()
        expect(heard).toHaveLength(1)
        expect(f.mgr.backendResourceUsage().backend?.resultHelper.state).toBe('unavailable')
        // A new backend session (the backend restarted) starts from idle, not the old state.
        const before = wsMock.FakeNodeWebSocket.instances.length
        f.socket.close()
        await vi.waitFor(() => expect(wsMock.FakeNodeWebSocket.instances.length).toBeGreaterThan(before), { timeout: 10_000 })
        wsMock.FakeNodeWebSocket.instances.at(-1)!.open()
        await vi.waitFor(() => expect(f.mgr.backendResourceUsage().backend?.resultHelper.state).toBe('idle'))
        expect(heard.at(-1)).toMatchObject({ state: 'idle' })
      } finally {
        await f.cleanup()
      }
    })

    it('joins argument pieces sent before the request and calls the plugin with the whole arguments', async () => {
      const f = await fixture()
      try {
        const args = { block_id: 'b1', status: 'done', ...big(1_048_576) }
        const text = JSON.stringify(args)
        const parts = pieces(text)
        parts.forEach((data, seq) => f.socket.receive({ type: 'agent.capability.request_chunk', payload: { request_id: 'mcp:big', seq, data } }))
        const response = await ask(f, toolRequest(f, {
          request_id: 'mcp:big',
          payload: { argumentChunks: { chunks: parts.length, bytes: Buffer.byteLength(text, 'utf8') } },
        }))
        expect(response).toMatchObject({ ok: true })
        expect(f.call).toHaveBeenCalledTimes(1)
        expect(sha(JSON.stringify(f.call.mock.calls[0][2]))).toBe(sha(text))
      } finally {
        await f.cleanup()
      }
    })

    it('refuses a request whose argument pieces came out of order, without calling the plugin', async () => {
      const f = await fixture()
      try {
        f.socket.receive({ type: 'agent.capability.request_chunk', payload: { request_id: 'mcp:bad', seq: 0, data: 'x'.repeat(131_072) } })
        f.socket.receive({ type: 'agent.capability.request_chunk', payload: { request_id: 'mcp:bad', seq: 2, data: '"' } })
        await expect(ask(f, toolRequest(f, { request_id: 'mcp:bad', payload: { argumentChunks: { chunks: 2, bytes: 131_073 } } })))
          .resolves.toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_CHUNKS_INVALID', reason: 'seq' })
        expect(f.call).not.toHaveBeenCalled()
      } finally {
        await f.cleanup()
      }
    })

    it('sends a large result as pieces, each awaited, then the summary in place of the result', async () => {
      const f = await fixture()
      try {
        const result = big(2 * 1_048_576)
        f.call.mockImplementation(async (_instance, _method, _args, options) => {
          options?.onTransferProgress?.('execution')
          return result as never
        })
        f.socket.receive({ type: 'agent.capability.request', payload: toolRequest(f, { request_id: 'mcp:r2' }) })
        const sentPieces = await answer(f, 'agent.capability.result_chunk', () => true,
          () => sentOf(f.socket).some((m) => m.type === 'agent.capability.result'))
        const final = sentOf(f.socket).filter((m) => m.type === 'agent.capability.result').at(-1)!
        const text = JSON.stringify(result)
        const sent = sentOf(f.socket).filter((m) => m.type === 'agent.capability.result_chunk')
        expect(sentPieces).toBe(pieces(text).length)
        expect(sha(sent.map((m) => m.payload.data as string).join(''))).toBe(sha(text))
        expect(sent.map((m) => m.payload.seq)).toEqual(sent.map((_, i) => i))
        const response = final.payload.response as Record<string, unknown>
        expect(response.result).toBeUndefined()
        expect(response.resultChunks).toEqual({ chunks: sent.length, bytes: Buffer.byteLength(text, 'utf8') })
        expect((response.meta as { resultBytes: number }).resultBytes).toBe(Buffer.byteLength(text, 'utf8'))
        // The Host told the core the call was alive when it started it.
        expect(sentOf(f.socket).some((m) => m.type === 'agent.capability.progress' && m.payload.phase === 'execution')).toBe(true)
      } finally {
        await f.cleanup()
      }
    })

    it('stops sending pieces once the core no longer waits for the request', async () => {
      const f = await fixture()
      try {
        f.call.mockResolvedValue(big(2 * 1_048_576) as never)
        f.socket.receive({ type: 'agent.capability.request', payload: toolRequest(f, { request_id: 'mcp:gone' }) })
        await answer(f, 'agent.capability.result_chunk', (seq) => seq < 2, () => false)
        expect(sentOf(f.socket).filter((m) => m.type === 'agent.capability.result_chunk')).toHaveLength(3)
        expect(sentOf(f.socket).some((m) => m.type === 'agent.capability.result')).toBe(false)
      } finally {
        await f.cleanup()
      }
    }, 30_000)
  })

  it('golden: with the master switch off nothing is pushed, agentMethods stay empty, and calls are refused', async () => {
    const f = await fixture({ enabled: false })
    try {
      expect(sentOf(f.socket).some((message) => message.type === 'plugins.agentTools.sync')).toBe(false)
      expect(f.spec().agentMethods).toEqual([])
      expect(PluginBackendHost.prototype.agentToolMethodsFor.call(
        (f.mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost, 'nerdtechnic.devmap', '0.2.0',
      )).toEqual([])
      await expect(ask(f, toolRequest(f))).resolves.toEqual({
        ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'master-switch-off', error: expect.any(String),
      })
      expect(f.bind).not.toHaveBeenCalled()
      expect(f.call).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  })

  it('pushes the catalog when the Host session registers and serves a consented tool with the pane identity', async () => {
    const f = await fixture()
    try {
      const sync = sentOf(f.socket).filter((message) => message.type === 'plugins.agentTools.sync')
      expect(sync).toHaveLength(1)
      expect(sync[0].payload).toMatchObject({ revision: 1, enabled: true, externalCallers: false })
      expect((sync[0].payload.tools as Array<{ name: string; state: string }>).map((entry) => [entry.name, entry.state]))
        .toEqual([['devmap_read', 'available'], ['devmap_set_status', 'available']])
      // Views and the registered activation stay closed to agents; only the
      // agent-tool bindings get the served methods.
      expect(f.spec().agentMethods).toEqual([])
      expect((f.mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost
        .agentToolMethodsFor('nerdtechnic.devmap', '0.2.0')).toEqual(['devmap.read', 'devmap.setStatus'])

      const response = await ask(f, toolRequest(f))
      expect(response).toEqual({
        ok: true, result: { status: 'done' }, meta: { durationMs: expect.any(Number), resultBytes: 17, crossWorkspace: false },
      })
      expect(f.confirmWrite).toHaveBeenCalledWith(expect.objectContaining({ pluginId: 'nerdtechnic.devmap' }), expect.objectContaining({ name: 'devmap_set_status' }), f.workspace)
      expect(f.bind).toHaveBeenCalledWith(
        expect.objectContaining({ pluginId: 'nerdtechnic.devmap', packageVersion: '0.2.0', initiator: { kind: 'user', id: 'host-user' } }),
        expect.any(String),
        f.workspace,
      )
      const [instanceId, method, args, callOptions] = f.call.mock.calls[0] as unknown as [string, string, unknown, { initiator: unknown; timeoutMs: number }]
      expect([instanceId, method, args]).toEqual(['headless-1', 'devmap.setStatus', { block_id: 'b1', status: 'done' }])
      // What is left of the tool's deadline, counted from receipt.
      expect(callOptions.timeoutMs).toBeLessThanOrEqual(30_000)
      expect(callOptions.timeoutMs).toBeGreaterThan(25_000)
      expect(callOptions.initiator).toEqual({
        kind: 'agent', source: 'mcp', id: expect.any(String),
        caller: { kind: 'pane', paneId: 'p-41', workspace: f.workspace, verifiedTo: 'pane' },
      })
      // One headless binding per package version and workspace.
      await ask(f, toolRequest(f, { request_id: 'mcp:2', tool: { name: 'devmap_read', plugin_version: '0.2.0', sync_revision: 1 }, payload: { arguments: {} } }))
      expect(f.bind).toHaveBeenCalledTimes(1)
      expect(f.confirmWrite).toHaveBeenCalledTimes(1)
    } finally {
      await f.cleanup()
    }
  })

  it('targets only open Navide workspaces: never home, a filesystem root or any other directory', async () => {
    const f = await fixture()
    try {
      const other = join(f.root, 'other')
      mkdirSync(other)
      for (const target of [homedir(), '/', other]) {
        await expect(ask(f, toolRequest(f, { target: { plugin_id: 'nerdtechnic.devmap', workspace_path: target } })))
          .resolves.toMatchObject({ ok: false, error_code: 'WORKSPACE_NOT_AUTHORIZED' })
      }
      // Even when a window has the home folder or the root open.
      f.openWorkspaces.add(realpathSync(homedir()))
      f.openWorkspaces.add('/')
      for (const target of [homedir(), '/']) {
        await expect(ask(f, toolRequest(f, { target: { plugin_id: 'nerdtechnic.devmap', workspace_path: target } })))
          .resolves.toMatchObject({ ok: false, error_code: 'WORKSPACE_NOT_AUTHORIZED' })
      }
      // An open workspace the package has no fs Grant for.
      f.openWorkspaces.add(other)
      f.grant.value = { packageVersion: '0.2.0', system: [] as never, storage: true }
      await expect(ask(f, toolRequest(f, { target: { plugin_id: 'nerdtechnic.devmap', workspace_path: other } })))
        .resolves.toMatchObject({ ok: false, error_code: 'WORKSPACE_NOT_AUTHORIZED' })
      expect(f.bind).not.toHaveBeenCalled()
      // Granted: another open workspace than the caller's is served and flagged.
      f.grant.value = { packageVersion: '0.2.0', system: ['fs'], storage: true }
      const cross = await ask(f, toolRequest(f, { target: { plugin_id: 'nerdtechnic.devmap', workspace_path: other } }))
      expect(cross).toMatchObject({ ok: true, meta: { crossWorkspace: true } })
      expect(f.bind).toHaveBeenLastCalledWith(expect.anything(), expect.any(String), other)
      const same = await ask(f, toolRequest(f, { request_id: 'mcp:same' }))
      expect(same).toMatchObject({ ok: true, meta: { crossWorkspace: false } })
    } finally {
      await f.cleanup()
    }
  })

  it('refuses an external caller whose workspace_path names no open workspace, with a clear error', async () => {
    const f = await fixture()
    try {
      await f.gate.setSwitches({ externalCallers: true })
      const closed = join(f.root, 'closed')
      mkdirSync(closed)
      await expect(ask(f, toolRequest(f, {
        caller: { kind: 'external', paneId: null, workspace: null },
        target: { plugin_id: 'nerdtechnic.devmap', workspace_path: closed },
      }))).resolves.toEqual({
        ok: false, error_code: 'WORKSPACE_NOT_AUTHORIZED',
        error: 'An external or Host caller must name an open Navide workspace in workspace_path.',
      })
      expect(f.bind).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  })

  it('gates external and host callers behind DB4', async () => {
    const f = await fixture()
    try {
      const external = { kind: 'external', paneId: null, workspace: null }
      await expect(ask(f, toolRequest(f, { request_id: 'mcp:ext', caller: external })))
        .resolves.toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'external-callers-off' })
      await expect(ask(f, toolRequest(f, { request_id: 'mcp:host', caller: { kind: 'host', paneId: null, workspace: null } })))
        .resolves.toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'external-callers-off' })
      await f.gate.setSwitches({ externalCallers: true })
      await expect(ask(f, toolRequest(f, { request_id: 'mcp:ext2', caller: external }))).resolves.toMatchObject({ ok: true })
      const last = f.call.mock.calls.at(-1) as unknown as [string, string, unknown, { initiator: { caller: unknown } }]
      expect(last[3].initiator.caller).toEqual({ kind: 'external', paneId: null, workspace: null, verifiedTo: 'caller-kind' })
    } finally {
      await f.cleanup()
    }
  })

  it('refuses agent calls into a third-party view by instance id (only agent tools reach third-party code)', async () => {
    const f = await fixture()
    try {
      const instanceId = f.mgr.open(
        asHost(new FakeBrowserWindow()),
        { id: 'nerdtechnic.devmap', requires: ['terminal'], devUrl: '', entryFile: '/plugins/nerdtechnic.devmap/index.html' },
        { x: 0, y: 0, width: 10, height: 10 },
      )!
      await expect(f.mgr.executeAgentBackendCall(instanceId, { reqId: 'r-1', name: 'devmap.read', args: {} }))
        .resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
      expect(f.call).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  })

  it('tells the user where to add web when a saved policy leaves it out', async () => {
    const f = await fixture({ system: ['fs', 'web'] })
    try {
      f.policy.value = { policy: { ...HOST_DEFAULT_EXECUTION_POLICY, system: ['fs', 'ui', 'aiCli'] }, revision: 2, state: 'user' }
      await expect(ask(f, toolRequest(f))).resolves.toMatchObject({
        ok: false,
        error_code: 'EXECUTION_POLICY_DENIED',
        error: 'Your agent Execution Policy allowlist does not include web. Add web in Settings → Navide Plugins → Execution Policy.',
      })
      f.mgr.setUiLocaleResolver(() => 'zh-TW')
      await expect(ask(f, toolRequest(f, { request_id: 'mcp:2' }))).resolves.toMatchObject({
        error: '你的 agent 執行政策 allowlist 沒有包含 web，請到「設定 → Navide 外掛 → 執行政策」加入 web。',
      })
      f.policy.value = { policy: { ...HOST_DEFAULT_EXECUTION_POLICY, mode: 'denylist', system: [] }, revision: 3, state: 'user' }
      await expect(ask(f, toolRequest(f, { request_id: 'mcp:3' }))).resolves.toMatchObject({
        error: webPolicyDeniedMessage('zh-TW', 'denylist'),
      })
      // A refusal that is not about web keeps the generic text.
      f.policy.value = { policy: FAIL_CLOSED_EXECUTION_POLICY, revision: 4, state: 'corrupt' }
      await expect(ask(f, toolRequest(f, { request_id: 'mcp:4' }))).resolves.toMatchObject({
        error: 'The agent execution policy denied the operation.',
      })
      expect(f.call).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  })

  it('refuses before binding: malformed, unknown tool, no grant, declined first write, policy, missing argument', async () => {
    const f = await fixture()
    try {
      await expect(ask(f, toolRequest(f, { caller: { kind: 'pane', paneId: 'p', workspace: f.workspace, extra: 1 } })))
        .resolves.toMatchObject({ ok: false, error_code: 'BAD_REQUEST' })
      await expect(ask(f, toolRequest(f, { caller: { kind: 'external', paneId: 'spoofed', workspace: null } })))
        .resolves.toMatchObject({ ok: false, error_code: 'BAD_REQUEST' })
      await expect(ask(f, toolRequest(f, { tool: { name: 'devmap_nuke', plugin_version: '0.2.0', sync_revision: 1 } })))
        .resolves.toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'tool-not-consented' })
      await expect(ask(f, toolRequest(f, { payload: { arguments: {} } })))
        .resolves.toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_INVALID_ARGUMENTS' })
      await expect(ask(f, toolRequest(f, { target: { plugin_id: 'nerdtechnic.devmap', workspace_path: join(f.root, 'missing') } })))
        .resolves.toMatchObject({ ok: false, error_code: 'WORKSPACE_NOT_AUTHORIZED' })
      f.grant.value = null
      await expect(ask(f, toolRequest(f))).resolves.toMatchObject({ ok: false, error_code: 'WORKSPACE_NOT_AUTHORIZED' })
      f.grant.value = { packageVersion: '0.2.0', system: ['fs'], storage: true }
      f.confirmWrite.mockResolvedValueOnce(false)
      await expect(ask(f, toolRequest(f))).resolves.toMatchObject({ ok: false, error_code: 'WORKSPACE_WRITE_DECLINED' })
      f.policy.value = { policy: FAIL_CLOSED_EXECUTION_POLICY, revision: 2, state: 'corrupt' }
      await expect(ask(f, toolRequest(f))).resolves.toMatchObject({ ok: false, error_code: 'EXECUTION_POLICY_DENIED' })
      f.consented.value = false
      await expect(ask(f, toolRequest(f))).resolves.toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'consent-required' })
      expect(f.bind).not.toHaveBeenCalled()
      expect(f.call).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  })

  it('race: a disable while the first-write dialog is open wins over the earlier checks', async () => {
    const f = await fixture()
    try {
      f.confirmWrite.mockImplementationOnce(async () => {
        f.disabled.add('nerdtechnic.devmap')
        return true
      })
      await expect(ask(f, toolRequest(f))).resolves.toMatchObject({
        ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'plugin-disabled',
      })
      expect(f.bind).not.toHaveBeenCalled()
      expect(f.call).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  })

  it('race: a quarantine while the headless backend binds stops the call before dispatch', async () => {
    const f = await fixture()
    try {
      f.bind.mockImplementationOnce(async () => {
        f.gate.mark('nerdtechnic.devmap', 'quarantined')
        return 'headless-1'
      })
      await expect(ask(f, toolRequest(f))).resolves.toMatchObject({
        ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'plugin-quarantined',
      })
      expect(f.call).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  })

  it('race: a removal while the call runs answers plugin-stopping, and the closed tool stays closed', async () => {
    const f = await fixture()
    try {
      f.call.mockImplementationOnce(async () => {
        // revokePackageVersion drains the child under the call.
        throw new BackendPluginError('PLUGIN_STOPPING')
      })
      await expect(ask(f, toolRequest(f))).resolves.toMatchObject({
        ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'plugin-stopping',
      })
      // The switch turned off afterwards: the methods close and a cached CLI
      // catalog cannot reach the tool any more.
      await f.gate.setSwitches({ enabled: false })
      expect((f.mgr as unknown as { pluginBackendHost: PluginBackendHost }).pluginBackendHost
        .agentToolMethodsFor('nerdtechnic.devmap', '0.2.0')).toEqual([])
      const sync = sentOf(f.socket).filter((message) => message.type === 'plugins.agentTools.sync')
      expect(sync.at(-1)!.payload).toMatchObject({ enabled: false, tools: [] })
      await expect(ask(f, toolRequest(f, { request_id: 'mcp:after' }))).resolves.toMatchObject({
        ok: false, error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason: 'master-switch-off',
      })
    } finally {
      await f.cleanup()
    }
  })

  it('maps backend failures to the contract codes', async () => {
    const f = await fixture()
    try {
      f.call.mockRejectedValueOnce(new BackendPluginError('TIMEOUT'))
      await expect(ask(f, toolRequest(f))).resolves.toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_TIMEOUT' })
      f.call.mockRejectedValueOnce(new BackendPluginError('PLUGIN_ERROR', 'boom', { pluginCode: 'DEVMAP_LOCKED' }))
      await expect(ask(f, toolRequest(f, { request_id: 'mcp:2' }))).resolves.toMatchObject({
        ok: false, error_code: 'PLUGIN_TOOL_FAILED', plugin_error: 'DEVMAP_LOCKED',
      })
    } finally {
      await f.cleanup()
    }
  })

  it('returns a result over 1 MiB whole, with its size (DB9: no result cap)', async () => {
    const f = await fixture()
    try {
      const big = 'x'.repeat(1_048_577)
      f.call.mockResolvedValueOnce(big as never)
      // Contract 4.4, R2: a result longer than one piece reaches the core in
      // pieces (each answered here as the core would), then its summary.
      f.socket.receive({ type: 'agent.capability.request', payload: toolRequest(f, { request_id: 'mcp:big' }) })
      let answered = 0
      for (let i = 0; i < 500 && !sentOf(f.socket).some((m) => m.type === 'agent.capability.result'); i++) {
        await settle()
        for (const piece of sentOf(f.socket).filter((m) => m.type === 'agent.capability.result_chunk').slice(answered)) {
          f.socket.receive({ id: piece.id, type: piece.type, ok: true, payload: { ok: true, accepted: true }, error: null, timestamp: '' })
          answered += 1
        }
      }
      const pieces = sentOf(f.socket).filter((m) => m.type === 'agent.capability.result_chunk')
      const answer = sentOf(f.socket).find((m) => m.type === 'agent.capability.result')!.payload.response as {
        ok: boolean; resultChunks: { chunks: number; bytes: number }; meta: { resultBytes: number }
      }
      expect(answer.ok).toBe(true)
      expect(JSON.parse(pieces.map((m) => m.payload.data as string).join(''))).toBe(big)
      expect(answer.resultChunks).toEqual({ chunks: pieces.length, bytes: 1_048_579 })
      expect(answer.meta.resultBytes).toBe(1_048_579)
    } finally {
      await f.cleanup()
    }
  })

  it('lets only an in-flight agent-tool call on its headless binding reach the workspace filesystem', async () => {
    const f = await fixture()
    try {
      const internals = f.mgr as unknown as {
        thirdPartyFilesystemGrantAllows: (payload: Record<string, unknown>, context: PlansBridgeContext) => boolean
      }
      const context = (instanceId: string, initiator: unknown): PlansBridgeContext => ({
        runtime: {
          pluginId: 'nerdtechnic.devmap', packageVersion: '0.2.0', workspaceId: f.mgr.workspaceIdForPath(f.workspace),
          instanceId, contributionKey: 'nerdtechnic.devmap.agent-tools', hostWindowId: null, initiator: initiator as never,
        },
        workspacePath: f.workspace,
        authorizedPlanRoot: f.workspace,
        requestId: 'bridge:1',
        signal: new AbortController().signal,
        emit: () => undefined,
      } as PlansBridgeContext)
      const payload = { rel_path: 'a.txt', workspace_path: f.workspace }
      const seen: Record<string, boolean> = {}
      f.call.mockImplementationOnce((async (_id: string, _method: string, _args: unknown, options: { initiator: { id: string } }) => {
        const agent = options.initiator
        const allows = () => internals.thirdPartyFilesystemGrantAllows(payload, context('headless-1', agent))
        seen.inCall = allows()
        seen.otherInstance = internals.thirdPartyFilesystemGrantAllows(payload, context('other-instance', agent))
        seen.otherRoot = internals.thirdPartyFilesystemGrantAllows({ ...payload, workspace_path: f.root }, context('headless-1', agent))
        seen.otherInitiator = internals.thirdPartyFilesystemGrantAllows(payload, context('headless-1', { kind: 'agent', source: 'mcp', id: 'forged' }))
        f.grant.value = null
        seen.noGrant = allows()
        f.grant.value = { packageVersion: '0.2.0', system: ['fs'], storage: true }
        f.openWorkspaces.delete(f.workspace)
        seen.workspaceClosed = allows()
        f.openWorkspaces.add(f.workspace)
        f.disabled.add('nerdtechnic.devmap')
        seen.disabled = allows()
        f.disabled.clear()
        f.gate.mark('nerdtechnic.devmap', 'revoked')
        seen.revoked = allows()
        f.gate.clearMark('nerdtechnic.devmap')
        f.switches.enabled = false
        seen.switchOff = allows()
        f.switches.enabled = true
        seen.restored = allows()
        return { status: 'done' }
      }) as never)
      await ask(f, toolRequest(f))
      expect(seen).toEqual({
        inCall: true, otherInstance: false, otherRoot: false, otherInitiator: false, noGrant: false,
        workspaceClosed: false, disabled: false, revoked: false, switchOff: false, restored: true,
      })
      // After the call no agent request reaches the filesystem.
      expect(internals.thirdPartyFilesystemGrantAllows(payload, context('headless-1', { kind: 'agent', source: 'mcp', id: 'a' }))).toBe(false)
    } finally {
      await f.cleanup()
    }
  })

  it('external callers lose filesystem access when DB4 is turned off mid-call', async () => {
    const f = await fixture()
    try {
      await f.gate.setSwitches({ externalCallers: true })
      const internals = f.mgr as unknown as {
        thirdPartyFilesystemGrantAllows: (payload: Record<string, unknown>, context: PlansBridgeContext) => boolean
      }
      let before = false
      let after = true
      f.call.mockImplementationOnce((async (_id: string, _method: string, _args: unknown, options: { initiator: unknown }) => {
        const context = {
          runtime: {
            pluginId: 'nerdtechnic.devmap', packageVersion: '0.2.0', workspaceId: f.mgr.workspaceIdForPath(f.workspace),
            instanceId: 'headless-1', contributionKey: 'k', hostWindowId: null, initiator: options.initiator as never,
          },
          workspacePath: f.workspace, authorizedPlanRoot: f.workspace, requestId: 'b',
          signal: new AbortController().signal, emit: () => undefined,
        } as PlansBridgeContext
        const payload = { rel_path: 'a.txt', workspace_path: f.workspace }
        before = internals.thirdPartyFilesystemGrantAllows(payload, context)
        f.switches.externalCallers = false
        after = internals.thirdPartyFilesystemGrantAllows(payload, context)
        return null
      }) as never)
      await ask(f, toolRequest(f, { caller: { kind: 'external', paneId: null, workspace: null } }))
      expect([before, after]).toEqual([true, false])
    } finally {
      await f.cleanup()
    }
  })

  it('does not dispatch once the deadline passed during the first-write dialog, so a retry writes once', async () => {
    const f = await fixture()
    const realNow = Date.now
    try {
      f.confirmWrite.mockImplementationOnce(async () => {
        const later = realNow() + 31_000
        vi.spyOn(Date, 'now').mockImplementation(() => later)
        return true
      })
      await expect(ask(f, toolRequest(f))).resolves.toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_TIMEOUT' })
      expect(f.bind).not.toHaveBeenCalled()
      expect(f.call).not.toHaveBeenCalled()
      vi.mocked(Date.now).mockRestore()
      await expect(ask(f, toolRequest(f, { request_id: 'mcp:retry' }))).resolves.toMatchObject({ ok: true })
      expect(f.call).toHaveBeenCalledTimes(1)
    } finally {
      Date.now = realNow
      await f.cleanup()
    }
  })

  it('does not dispatch when the bind finishes after the deadline', async () => {
    const f = await fixture()
    const realNow = Date.now
    try {
      f.bind.mockImplementationOnce(async () => {
        const later = realNow() + 31_000
        vi.spyOn(Date, 'now').mockImplementation(() => later)
        return 'headless-1'
      })
      await expect(ask(f, toolRequest(f))).resolves.toMatchObject({ ok: false, error_code: 'PLUGIN_TOOL_TIMEOUT' })
      expect(f.call).not.toHaveBeenCalled()
    } finally {
      Date.now = realNow
      await f.cleanup()
    }
  })

  it('re-checks the workspace and Grant after the dialog and after the bind', async () => {
    const f = await fixture()
    try {
      f.confirmWrite.mockImplementationOnce(async () => {
        f.openWorkspaces.delete(f.workspace)
        return true
      })
      await expect(ask(f, toolRequest(f))).resolves.toMatchObject({ ok: false, error_code: 'WORKSPACE_NOT_AUTHORIZED' })
      expect(f.bind).not.toHaveBeenCalled()
      f.openWorkspaces.add(f.workspace)
      f.bind.mockImplementationOnce(async () => {
        f.grant.value = null
        return 'headless-1'
      })
      await expect(ask(f, toolRequest(f, { request_id: 'mcp:2' }))).resolves.toMatchObject({ ok: false, error_code: 'WORKSPACE_NOT_AUTHORIZED' })
      expect(f.call).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  })

  it('asks the DB3 question for a read tool that shares a write method', async () => {
    const f = await fixture()
    try {
      const shared = f.spec()
      ;(shared.thirdParty as unknown as { agentTools: unknown[] }).agentTools = [
        ...(shared.thirdParty.agentTools ?? []),
        { name: 'devmap_peek', method: 'devmap.setStatus', risk: 'read', title: 'Peek', description: 'Peek.', timeoutMs: 30_000, inputSchema: { type: 'object', properties: {} } },
      ]
      f.confirmWrite.mockResolvedValueOnce(false)
      await expect(ask(f, toolRequest(f, { tool: { name: 'devmap_peek', plugin_version: '0.2.0', sync_revision: 1 }, payload: { arguments: {} } })))
        .resolves.toMatchObject({ ok: false, error_code: 'WORKSPACE_WRITE_DECLINED' })
      expect(f.confirmWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: 'devmap_peek' }), f.workspace)
    } finally {
      await f.cleanup()
    }
  })

  it('evaluates the execution policy for a package that declares no system namespace', () => {
    const mgr = new FrontendPluginManager()
    mgr.setExecutionPolicyResolver(() => ({
      policy: { ...HOST_DEFAULT_EXECUTION_POLICY, mode: 'allowlist', system: [], shell: [] }, revision: 1, state: 'user',
    }))
    const internals = mgr as unknown as {
      agentToolPolicyAllows: (root: string, initiator: unknown, spec: unknown) => boolean
    }
    const spec = { thirdParty: { name: 'x', system: [] } }
    expect(internals.agentToolPolicyAllows('/w', { kind: 'agent', source: 'mcp', id: 'a' }, spec)).toBe(false)
    mgr.setExecutionPolicyResolver(() => ({ policy: HOST_DEFAULT_EXECUTION_POLICY, revision: 1, state: 'default' }))
    expect(internals.agentToolPolicyAllows('/w', { kind: 'agent', source: 'mcp', id: 'a' }, spec)).toBe(true)
  })

  it('never forwards an internal error message to the agent', async () => {
    const f = await fixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      f.confirmWrite.mockRejectedValueOnce(new Error('EACCES: /Users/me/Library/Application Support/Navide/native-backends.json'))
      const response = await ask(f, toolRequest(f))
      expect(response).toEqual({ ok: false, error_code: 'PLUGIN_TOOL_FAILED', error: 'The Navide plugin tool failed.' })
    } finally {
      warn.mockRestore()
      await f.cleanup()
    }
  })

  it('stops and forgets its headless bindings when the tools are no longer served', async () => {
    const f = await fixture()
    const unbind = vi.spyOn(PluginBackendHost.prototype, 'unbindView').mockResolvedValue(undefined)
    try {
      await ask(f, toolRequest(f))
      await f.gate.setSwitches({ enabled: false })
      expect(unbind).toHaveBeenCalledWith('headless-1', 'plugin-stopping')
      expect((f.mgr as unknown as { headlessAgentToolRoots: Map<string, string> }).headlessAgentToolRoots.size).toBe(0)
    } finally {
      unbind.mockRestore()
      await f.cleanup()
    }
  })

  it('keeps the Plans workspace route on its own path', async () => {
    const f = await fixture()
    const plansRoute = vi.spyOn(f.mgr, 'executeAgentBackendCallForWorkspace')
    try {
      f.socket.receive({
        type: 'agent.capability.request',
        payload: {
          request_id: 'plans-1',
          operation: 'backend',
          target: { plugin_id: 'navide.plans', workspace_path: f.workspace },
          payload: { reqId: 'r', name: 'plans.list', args: {} },
        },
      })
      await settle()
      expect(plansRoute).toHaveBeenCalledWith('navide.plans', f.workspace, { reqId: 'r', name: 'plans.list', args: {} })
      expect(f.call).not.toHaveBeenCalled()
    } finally {
      plansRoute.mockRestore()
      await f.cleanup()
    }
  })
})

describe('the Disabled switch for the built-in Plans, Git and Mini-IDE', () => {
  type SentMessage = { id: string; type: string; payload: Record<string, unknown> }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  const gitDescriptor = (): PluginLaunchDescriptor => ({
    ...descriptor(GIT_PLUGIN_ID),
    views: [{
      id: 'window',
      contributionKey: 'navide.git.window',
      kind: 'custom',
      location: 'window',
      title: 'Git',
      entryFile: '/plugins/navide.git/frontend/window/index.html',
    }],
  })

  function registrationOf(disabled: ReadonlySet<string>): SentMessage {
    const mgr = new FrontendPluginManager()
    mgr.setDisabledPluginResolver((pluginId) => disabled.has(pluginId))
    mgr.open(
      asHost(new FakeBrowserWindow()),
      { ...descriptor('acme.builtin-disable-host'), requires: ['terminal'] },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl(`ws://builtin-disable-${[...disabled].join('-') || 'none'}`)
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    return socket.sent
      .map((raw) => JSON.parse(raw) as SentMessage)
      .find((message) => message.type === 'host.register')!
  }

  it('advertises disabled built-ins to the backend only while one is disabled', async () => {
    const enabled = registrationOf(new Set())
    await flush()
    // Nothing disabled: the registration is main's, key for key.
    expect(enabled.payload.features).toEqual({ plans_backend_v2: false })
    const disabled = registrationOf(new Set(['navide.plans', 'acme.not-builtin']))
    expect(disabled.payload.features).toEqual({ plans_backend_v2: false, disabled_plugins: ['navide.plans'] })
  })

  it('re-registers the Host with the new disabled set as soon as a built-in is drained', async () => {
    let disabled = false
    const mgr = new FrontendPluginManager()
    mgr.setDisabledPluginResolver((pluginId) => disabled && pluginId === PLANS_PLUGIN_ID)
    mgr.open(
      asHost(new FakeBrowserWindow()),
      { ...descriptor('acme.builtin-disable-reregister'), requires: ['terminal'] },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl('ws://builtin-disable-reregister')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const registrations = () => socket.sent
      .map((raw) => JSON.parse(raw) as SentMessage)
      .filter((message) => message.type === 'host.register')
    const first = registrations()[0]
    socket.receive({ id: first.id, type: 'host.register', ok: true, payload: { registered: true }, error: null, timestamp: '' })
    await flush()
    expect(registrations()).toHaveLength(1)

    // The store turned unreadable (or the user disabled Plans): drain it.
    disabled = true
    await mgr.suspendBuiltinPlugin(PLANS_PLUGIN_ID)
    await flush()
    const all = registrations()
    expect(all).toHaveLength(2)
    expect(all[1].payload.features).toEqual({ plans_backend_v2: false, disabled_plugins: [PLANS_PLUGIN_ID] })
  })

  it('refuses an agent Plans call with the contract code and no recovery disposition', async () => {
    const mgr = new FrontendPluginManager()
    mgr.setDisabledPluginResolver((pluginId) => pluginId === PLANS_PLUGIN_ID)
    const response = await mgr.executeAgentBackendCallForWorkspace(
      PLANS_PLUGIN_ID,
      '/tmp/builtin-disable-ws',
      { reqId: 'agent-disabled', name: 'plans.create', args: {} },
    )
    expect(response).toEqual({
      reqId: 'agent-disabled',
      ok: false,
      error: { code: 'PLUGIN_TOOL_UNAVAILABLE', message: builtinPluginDisabledMessage(PLANS_PLUGIN_ID) },
      reason: 'plugin-disabled',
    })
    expect(response).not.toHaveProperty('recoveryDisposition')
  })

  it('answers an agent Plans call as before while Plans is enabled', async () => {
    const mgr = new FrontendPluginManager()
    mgr.setDisabledPluginResolver(() => false)
    await expect(mgr.executeAgentBackendCallForWorkspace(
      PLANS_PLUGIN_ID,
      '/tmp/builtin-disable-ws',
      { reqId: 'agent-enabled', name: 'plans.list', args: {} },
    )).resolves.toEqual({
      reqId: 'agent-enabled',
      ok: false,
      error: { code: 'BACKEND_UNAVAILABLE', message: 'Plans agent backend is unavailable' },
    })
  })

  it('keeps a disabled built-in registered but neither lists nor opens its views', async () => {
    let gitDisabled = true
    const mgr = new FrontendPluginManager()
    mgr.setDisabledPluginResolver((pluginId) => gitDisabled && pluginId === GIT_PLUGIN_ID)
    mgr.registerDescriptor(gitDescriptor(), { official: true })
    expect(mgr.getDescriptor(GIT_PLUGIN_ID)).toBeDefined()
    expect(mgr.isBuiltinPluginDisabled(GIT_PLUGIN_ID)).toBe(true)
    expect(mgr.listDisabledBuiltinPlugins()).toEqual([GIT_PLUGIN_ID])
    expect(mgr.listContributionCatalog()).toEqual([])
    await expect(mgr.openContributionWindow(asHost(new FakeBrowserWindow()), 'navide.git.window', {
      workspacePath: '/tmp/builtin-disable-ws',
    })).resolves.toEqual({ ok: false, error: 'contribution is not installed' })
    const registered = mgr.getDescriptor(GIT_PLUGIN_ID)!
    await expect(mgr.openView(registered, registered.views![0], {
      hostWindow: asHost(new FakeBrowserWindow()),
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      workspacePath: '/tmp/builtin-disable-ws',
    } as never)).rejects.toThrow(builtinPluginDisabledMessage(GIT_PLUGIN_ID))

    gitDisabled = false
    expect(mgr.listContributionCatalog().map((entry) => entry.contributionKey)).toEqual(['navide.git.window'])
  })

  it('does not treat a third-party id as a built-in', () => {
    const mgr = new FrontendPluginManager()
    mgr.setDisabledPluginResolver(() => true)
    expect(mgr.isBuiltinPluginDisabled('acme.demo')).toBe(false)
    expect(mgr.listDisabledBuiltinPlugins()).toEqual([GIT_PLUGIN_ID, MINI_IDE_PLUGIN_ID, PLANS_PLUGIN_ID].sort())
  })

  it('drains the real Plans backend activation on Disable and registers it again on Enable', async () => {
    let plansDisabled = false
    const mgr = new FrontendPluginManager()
    mgr.setDisabledPluginResolver((pluginId) => plansDisabled && pluginId === PLANS_PLUGIN_ID)
    mgr.registerDescriptor({
      id: PLANS_PLUGIN_ID,
      packageVersion: '1.0.0',
      packageDir: process.cwd(),
      requires: ['fs'],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }),
      devUrl: '',
      entryFile: '/plugins/navide.plans/index.html',
      views: [],
    }, { builtin: true })
    const spec = {
      pluginId: PLANS_PLUGIN_ID,
      packageVersion: '1.0.0',
      packageDir: process.cwd(),
      entryFile: '/plugins/navide.plans/backend/navide-plans',
      protocolVersion: 1 as const,
      activation: 'startup' as const,
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem' as const],
    }
    mgr.registerBackendActivation(spec)
    expect(mgr.hasBackendActivation(PLANS_PLUGIN_ID, '1.0.0')).toBe(true)

    plansDisabled = true
    await mgr.suspendBuiltinPlugin(PLANS_PLUGIN_ID)
    expect(mgr.hasBackendActivation(PLANS_PLUGIN_ID, '1.0.0')).toBe(false)
    expect(mgr.getDescriptor(PLANS_PLUGIN_ID)?.packageVersion).toBe('1.0.0')

    plansDisabled = false
    mgr.resumeBuiltinPlugin(PLANS_PLUGIN_ID)
    expect(mgr.getBackendActivation(PLANS_PLUGIN_ID, '1.0.0')).toMatchObject({
      entryFile: spec.entryFile,
      agentMethods: ['plans.list'],
    })
    await mgr.closeBackendPlugins()
  })

  it('drains a disabled built-in and re-registers the same backend on Enable', async () => {
    let plansDisabled = true
    const mgr = new FrontendPluginManager()
    mgr.setDisabledPluginResolver((pluginId) => plansDisabled && pluginId === PLANS_PLUGIN_ID)
    mgr.registerDescriptor({ ...descriptor(PLANS_PLUGIN_ID), packageVersion: '1.2.3' }, { official: true })
    const backend = { pluginId: PLANS_PLUGIN_ID, packageVersion: '1.2.3' } as never
    vi.spyOn(mgr, 'getBackendActivation').mockReturnValue(backend)
    const revoke = vi.spyOn(mgr, 'revokePackageVersion').mockResolvedValue(undefined)
    let registered = true
    vi.spyOn(mgr, 'hasBackendActivation').mockImplementation(() => registered)
    const register = vi.spyOn(mgr, 'registerBackendActivation').mockImplementation(() => { registered = true })

    await mgr.suspendBuiltinPlugin(PLANS_PLUGIN_ID)
    expect(revoke).toHaveBeenCalledWith(PLANS_PLUGIN_ID, '1.2.3')
    // Disable keeps the package: its descriptor is still registered.
    expect(mgr.getDescriptor(PLANS_PLUGIN_ID)).toBeDefined()
    expect(() => mgr.resumeBuiltinPlugin(PLANS_PLUGIN_ID)).toThrow(/is disabled/)

    registered = false
    plansDisabled = false
    mgr.resumeBuiltinPlugin(PLANS_PLUGIN_ID)
    expect(register).toHaveBeenCalledWith(backend)
  })
})

describe('plugin activity (D-e)', () => {
  type SentMessage = { id: string; type: string; payload: Record<string, unknown> }

  function connect(id: string): {
    mgr: FrontendPluginManager
    socket: InstanceType<typeof wsMock.FakeNodeWebSocket>
    call: (ns: string, method: string, args: Record<string, unknown>) => Promise<unknown>
  } {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    mgr.open(
      asHost(host),
      { id, requires: ['terminal'], devUrl: '', entryFile: `/plugins/${id}/index.html` },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl(`ws://${id}`)
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const registration = socket.sent.map((raw) => JSON.parse(raw) as SentMessage)
      .find((message) => message.type === 'host.register')!
    socket.receive({ id: registration.id, type: 'host.register', ok: true, payload: { registered: true }, error: null, timestamp: '' })
    const view = host.children[0] as FakeViewLike
    const call = async (ns: string, method: string, args: Record<string, unknown>): Promise<unknown> =>
      ipcHandlers.get('plugin:cap:call')!({ sender: { id: view.webContents.id } }, { reqId: 'r1', ns, method, args })
    return { mgr, socket, call }
  }

  const activityOf = (socket: InstanceType<typeof wsMock.FakeNodeWebSocket>): SentMessage[] =>
    socket.sent.map((raw) => JSON.parse(raw) as SentMessage).filter((m) => m.type === 'plugin.activity.record')

  afterEach(() => { vi.useRealTimers() })

  it('records a third-party plugin call refused as undeclared, in one batch over the Host session', async () => {
    vi.useFakeTimers()
    const { socket, call } = connect('acme.activity')
    await expect(call('fs', 'readFile', { path: '/Users/me/project/a.py' })).resolves.toMatchObject({
      ok: false, error: { code: 'CAP_DENIED' },
    })
    await expect(call('net', 'fetch', { url: 'https://example.test' })).resolves.toMatchObject({ ok: false })
    expect(activityOf(socket)).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    const [batch, ...more] = activityOf(socket)
    expect(more).toEqual([])
    expect(batch.payload.rows).toEqual([
      {
        plugin_id: 'acme.activity', plugin_version: '', workspace: '', source: 'broker',
        // A refused call's path is the plugin's text: never sent (final review part 2, H1).
        address: 'fs.readFile', outcome: 'denied', denied_reason: 'undeclared', fs_path: '<denied>',
        at: expect.any(Number), count: 1,
      },
      {
        plugin_id: 'acme.activity', plugin_version: '', workspace: '', source: 'broker',
        // No capability the broker routes: one fixed address.
        address: '<unknown>', outcome: 'denied', denied_reason: 'undeclared',
        at: expect.any(Number), count: 1,
      },
    ])
  })

  // Review of #397: a planner that throws dispatched nothing, so the write's
  // path is not kept (the plugin wrote it and nothing ran).
  it('records a call whose planning threw as not dispatched', async () => {
    vi.useFakeTimers()
    const { mgr, socket, call } = connect('acme.activity-planner-throws')
    const running = (mgr as unknown as { running: Map<string, { capabilityPolicy: unknown }> }).running
    for (const plugin of running.values()) {
      plugin.capabilityPolicy = new Proxy({}, { get: () => { throw new Error('planner broke') } })
    }
    for (let i = 0; i < 50; i++) {
      await expect(call('fs', 'writeFile', { path: `/Users/me/project/${i}.py`, content: 'x' })).resolves.toMatchObject({
        ok: false, error: { code: 'INVALID_ARGUMENT' },
      })
    }
    await vi.advanceTimersByTimeAsync(1000)
    const [batch] = activityOf(socket)
    expect(batch.payload.rows).toEqual([expect.objectContaining({
      address: 'fs.writeFile', outcome: 'error', fs_path: '<failed>', count: 50,
    })])
  })

  it('answers the plugin the same as before when the backend never takes the batch', async () => {
    vi.useFakeTimers()
    const { socket, call } = connect('acme.activity-unanswered')
    const first = await call('fs', 'readFile', { path: 'a.py' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(activityOf(socket)).toHaveLength(1)  // sent, never answered
    await expect(call('fs', 'readFile', { path: 'a.py' })).resolves.toEqual(first)
  })

  it('does not record the bundled navide.* plugins', async () => {
    vi.useFakeTimers()
    const { socket, call } = connect('navide.activity-builtin')
    await call('fs', 'readFile', { path: 'a.py' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(activityOf(socket)).toEqual([])
  })
  // Every settled backend call reaches the recorder through PluginBackendHost's
  // onCallSettled (pluginBackendHost.test.ts covers that it fires on every path).
  function settleBackendCalls(
    mgr: FrontendPluginManager,
    calls: Array<{ pluginId: string; method: string; outcome: string; declared?: boolean }>,
  ): void {
    const host = (mgr as unknown as { pluginBackendHost: { onCallSettled: (call: unknown) => void } }).pluginBackendHost
    for (const call of calls) host.onCallSettled({ packageVersion: '1.0.0', workspacePath: '/w', declared: true, ...call })
  }

  it('counts a third-party plugin\'s backend calls per method and outcome, in one batch', async () => {
    vi.useFakeTimers()
    const { mgr, socket } = connect('acme.backend-activity')
    settleBackendCalls(mgr, [
      ...Array.from({ length: 500 }, () => ({ pluginId: 'acme.backend-activity', method: 'devmap.block.import', outcome: 'allowed' })),
      { pluginId: 'acme.backend-activity', method: 'devmap.fail', outcome: 'error' },
      { pluginId: 'acme.backend-activity', method: 'devmap.slow', outcome: 'cancelled' },
    ])
    expect(activityOf(socket)).toEqual([])  // never on the call path: batched
    await vi.advanceTimersByTimeAsync(1000)
    const [batch, ...more] = activityOf(socket)
    expect(more).toEqual([])
    const base = { plugin_id: 'acme.backend-activity', plugin_version: '1.0.0', workspace: '/w', source: 'backend', at: expect.any(Number) }
    expect(batch.payload.rows).toEqual([
      { ...base, address: 'backend.devmap.block.import', outcome: 'allowed', count: 500 },
      { ...base, address: 'backend.devmap.fail', outcome: 'error', count: 1 },
      { ...base, address: 'backend.devmap.slow', outcome: 'cancelled', count: 1 },
    ])
  })

  it('does not record the bundled navide.* plugins calling their backend', async () => {
    vi.useFakeTimers()
    const { mgr, socket } = connect('acme.backend-builtin-check')
    settleBackendCalls(mgr, [{ pluginId: 'navide.plans', method: 'plans.list', outcome: 'allowed' }])
    await vi.advanceTimersByTimeAsync(1000)
    expect(activityOf(socket)).toEqual([])
    // Their calls are not even observed: no wrapper cost on the call path.
    const host = (mgr as unknown as { pluginBackendHost: { observesCallsOf: (id: string) => boolean } }).pluginBackendHost
    expect(host.observesCallsOf('navide.plans')).toBe(false)
    expect(host.observesCallsOf('acme.backend-builtin-check')).toBe(true)
  })

  // Review of #374 (H2): undeclared names are the caller's free text, so they
  // are never keys; the number of keys follows the declared methods only.
  it('counts every call of an undeclared method under one address, whatever the name', async () => {
    vi.useFakeTimers()
    const { mgr, socket } = connect('acme.backend-undeclared')
    settleBackendCalls(mgr, Array.from({ length: 1000 }, (_, i) => ({
      pluginId: 'acme.backend-undeclared', method: `made.up.${i}.${'x'.repeat(i % 50)}`, outcome: 'error', declared: false,
    })))
    await vi.advanceTimersByTimeAsync(1000)
    const [batch] = activityOf(socket)
    expect(batch.payload.rows).toEqual([{
      plugin_id: 'acme.backend-undeclared', plugin_version: '1.0.0', workspace: '/w', source: 'backend',
      at: expect.any(Number), address: 'backend.<undeclared>', outcome: 'error', count: 1000,
    }])
  })
})

describe('plugin activity forget (D-e L4)', () => {
  type SentMessage = { id: string; type: string; payload: Record<string, unknown> }

  it('sends plugin.activity.forget over the registered Host session, and nothing without one', async () => {
    const mgr = new FrontendPluginManager()
    mgr.open(
      asHost(new FakeBrowserWindow()),
      { id: 'acme.activity-forget', requires: ['terminal'], devUrl: '', entryFile: '/plugins/acme.activity-forget/index.html' },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl('ws://activity-forget')
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    const sent = (): SentMessage[] => socket.sent.map((raw) => JSON.parse(raw) as SentMessage)
    mgr.forgetPluginActivity('acme.gone')
    await Promise.resolve()
    expect(sent().filter((m) => m.type === 'plugin.activity.forget')).toEqual([])  // not registered yet
    const registration = sent().find((m) => m.type === 'host.register')!
    socket.receive({ id: registration.id, type: 'host.register', ok: true, payload: { registered: true }, error: null, timestamp: '' })
    await vi.waitFor(() => {
      mgr.forgetPluginActivity('acme.gone')  // a no-op until the session is registered
      expect(sent().filter((m) => m.type === 'plugin.activity.forget').length).toBeGreaterThan(0)
    })
    expect(sent().find((m) => m.type === 'plugin.activity.forget')!.payload).toEqual({ plugin_id: 'acme.gone' })
  })
})

// Plan B watchdog option C (contract 5.2): decision rows go to the backend
// over the registered Host session; a failure only warns.
describe('plugin.resource.decision rows to the backend', () => {
  type SentMessage = { id: string; type: string; payload: Record<string, unknown> }
  const row = {
    plugin_id: 'acme.indexer', plugin_version: '1.0.0', item: 'memory' as const,
    usage: 600, threshold: 512, decision: 'notified' as const, at: 1,
  }

  function connect(id: string, registered: boolean) {
    const mgr = new FrontendPluginManager()
    mgr.open(
      asHost(new FakeBrowserWindow()),
      { id, requires: ['terminal'], devUrl: '', entryFile: `/plugins/${id}/index.html` },
      { x: 0, y: 0, width: 10, height: 10 },
    )
    mgr.setBackendHostToken('host-token')
    mgr.setBackendWsUrl(`ws://${id}`)
    const socket = wsMock.FakeNodeWebSocket.instances.at(-1)!
    socket.open()
    if (registered) {
      const registration = (socket.sent.map((raw) => JSON.parse(raw) as SentMessage))
        .find((message) => message.type === 'host.register')!
      socket.receive({ id: registration.id, type: 'host.register', ok: true, payload: { registered: true }, error: null, timestamp: '' })
    }
    return { mgr, socket }
  }
  const sentRows = (socket: InstanceType<typeof wsMock.FakeNodeWebSocket>) =>
    socket.sent.map((raw) => JSON.parse(raw) as SentMessage).filter((m) => m.type === 'plugin.resource.decision')

  it('sends the row on the registered session', async () => {
    const { mgr, socket } = connect('acme.rd-ok', true)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    mgr.recordResourceDecision(row)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(sentRows(socket).map((m) => m.payload)).toEqual([{ rows: [row] }])
  })

  it('without a registered session it only warns and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { mgr, socket } = connect('acme.rd-none', false)
      expect(() => mgr.recordResourceDecision(row)).not.toThrow()
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(sentRows(socket)).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('web.* view capabilities (Host web view registry)', () => {
  const CALL = 'plugin:cap:call'
  type WebResponse = { ok?: boolean; result?: Record<string, unknown>; error?: { code: string; message?: string } }
  let seq = 0

  function webDescriptor(
    mgr: FrontendPluginManager,
    id: string,
    granted: Array<'ui' | 'web'>,
  ): PluginLaunchDescriptor {
    return {
      id,
      packageVersion: '1.0.0',
      requires: [],
      capabilityPolicy: manifestV2CapabilityPolicy({ system: ['web'] }),
      capabilityContext: {
        publisherEligible: false,
        userGrant: { packageVersion: '1.0.0', system: granted },
        runtimeBinding: {
          pluginId: id,
          packageVersion: '1.0.0',
          workspaceId: mgr.workspaceIdForPath('/workspace'),
          instanceId: null,
          audience: `${id}.main`,
        },
      },
      devUrl: '',
      entryFile: `/plugins/${id}/index.html`,
      views: [{
        id: 'main',
        contributionKey: `${id}.main`,
        kind: 'custom',
        location: 'main',
        title: id,
        entryFile: `/plugins/${id}/index.html`,
      }],
    }
  }

  async function openWeb(mgr: FrontendPluginManager, id: string, granted: Array<'ui' | 'web'> = ['web']) {
    const descriptor = webDescriptor(mgr, id, granted)
    mgr.registerDescriptor(descriptor)
    const host = new FakeBrowserWindow()
    const handle = await mgr.openView(descriptor, descriptor.views![0], {
      hostWindow: asHost(host),
      bounds: 'fill',
      workspacePath: '/workspace',
      capabilityContext: descriptor.capabilityContext,
    })
    const view = host.children[0] as FakeViewLike
    const call = async (
      method: string,
      args: Record<string, unknown> = {},
      extra: Record<string, unknown> = {},
    ): Promise<WebResponse> => (await ipcHandlers.get(CALL)!({ sender: { id: view.webContents.id } }, {
      reqId: `web-${method}-${++seq}`,
      ns: 'web',
      method,
      args,
      ...extra,
    })) as WebResponse
    return { host, view, instanceId: handle.instanceId, call }
  }

  function newManager(): FrontendPluginManager {
    const mgr = new FrontendPluginManager()
    mgr.setPublicCapabilityHandler((plan) => mgr.executePublicCapability(plan))
    return mgr
  }

  const gesture = { userGesture: true }
  const webEvents = (view: FakeViewLike) => view.webContents.sent.filter((message) =>
    (message.args[0] as { type?: string }).type === 'web.changed')
  const lastGuest = () => webHostMock.guests[webHostMock.guests.length - 1]!

  it('reaches only the calling plugin\'s own views, with the plugin id taken from the Host binding', async () => {
    const mgr = newManager()
    const a = await openWeb(mgr, 'acme.web-own-a')
    const b = await openWeb(mgr, 'acme.web-own-b')
    const created = await a.call('create', { space: 'mail', url: 'https://example.com/' }, gesture)
    expect(created).toMatchObject({ ok: true, result: { viewId: expect.any(String) } })
    const viewId = created.result!.viewId as string
    expect(lastGuest().options).toEqual({ partition: 'persist:navide-web:acme.web-own-a', backgroundThrottling: true })

    await expect(a.call('list')).resolves.toMatchObject({
      ok: true,
      result: { views: [expect.objectContaining({ viewId, space: 'mail', owner: 'user', control: 'user', attached: false })] },
    })
    await expect(b.call('list')).resolves.toMatchObject({ ok: true, result: { views: [] } })
    // A request cannot name the plugin it acts for.
    const forged = await b.call('list', {}, { pluginId: 'acme.web-own-a' })
    expect(forged.ok ? forged.result : forged.error?.code).toEqual(forged.ok ? { views: [] } : 'BAD_REQUEST')
    for (const [method, args] of [
      ['close', { viewId }],
      ['detach', { viewId }],
      ['attach', { viewId, rect: { x: 0, y: 0, width: 10, height: 10 } }],
      ['navigate', { viewId, url: 'https://example.org/' }],
      ['capture', { viewId }],
    ] as const) {
      await expect(b.call(method, args)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    }
    await expect(b.call('setOwner', { viewId, owner: 'agent' }, gesture))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(pluginWebViewRegistry().list('acme.web-own-a')).toHaveLength(1)
    expect(b.host.children).toHaveLength(1)

    await expect(a.call('attach', { viewId, rect: { x: 5, y: 6, width: 100, height: 50 } }))
      .resolves.toEqual({ reqId: expect.any(String), ok: true, result: { ok: true } })
    expect(a.host.children).toContain(lastGuest())
    expect(lastGuest().bounds).toEqual({ x: 5, y: 6, width: 100, height: 50 })
    await expect(a.call('capture', { viewId })).resolves.toMatchObject({
      ok: true, result: { dataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/) },
    })
    await expect(a.call('detach', { viewId })).resolves.toMatchObject({ ok: true, result: { ok: true } })
    expect(a.host.children).not.toContain(lastGuest())
    await expect(a.call('close', { viewId })).resolves.toMatchObject({ ok: true, result: { ok: true } })
    expect(pluginWebViewRegistry().list('acme.web-own-a')).toEqual([])
  })

  it('refuses the gesture-gated web addresses without a Host-observed user gesture', async () => {
    const mgr = newManager()
    const a = await openWeb(mgr, 'acme.web-gesture')
    await expect(a.call('create', { space: 's' })).resolves.toMatchObject({ ok: false, error: { code: 'USER_CANCELLED' } })
    expect(pluginWebViewRegistry().list('acme.web-gesture')).toEqual([])
    const viewId = (await a.call('create', { space: 's' }, gesture)).result!.viewId as string
    const info = () => pluginWebViewRegistry().list('acme.web-gesture')[0]!
    for (const [method, args] of [
      ['setOwner', { viewId, owner: 'agent' }],
      ['takeControl', { viewId }],
      ['returnControl', { viewId }],
      ['clearData', {}],
    ] as const) {
      await expect(a.call(method, args)).resolves.toMatchObject({ ok: false, error: { code: 'USER_CANCELLED' } })
    }
    expect(info()).toMatchObject({ owner: 'user', control: 'user' })
    expect(webHostMock.cleared).not.toContain('persist:navide-web:acme.web-gesture')

    // USER_IN_CONTROL has no view-side code: it is CAPABILITY_DENIED with the reason.
    await expect(a.call('returnControl', { viewId }, gesture)).resolves.toMatchObject({
      ok: false, error: { code: 'CAPABILITY_DENIED', message: expect.stringContaining('user-owned') },
    })
    await expect(a.call('setOwner', { viewId, owner: 'agent' }, gesture)).resolves.toMatchObject({ ok: true, result: { ok: true } })
    expect(info()).toMatchObject({ owner: 'agent', control: 'agent' })
    await expect(a.call('takeControl', { viewId }, gesture)).resolves.toMatchObject({ ok: true, result: { ok: true } })
    expect(info()).toMatchObject({ owner: 'agent', control: 'user' })
    await expect(a.call('returnControl', { viewId }, gesture)).resolves.toMatchObject({ ok: true, result: { ok: true } })
    expect(info()).toMatchObject({ owner: 'agent', control: 'agent' })
    await expect(a.call('clearData', {}, gesture)).resolves.toMatchObject({ ok: true, result: { ok: true } })
    expect(webHostMock.cleared).toContain('persist:navide-web:acme.web-gesture')
  })

  it('refuses web calls and withholds web.changed without the web grant', async () => {
    const mgr = newManager()
    const granted = await openWeb(mgr, 'acme.web-events')
    const ungranted = await openWeb(mgr, 'acme.web-events', ['ui'])
    const other = await openWeb(mgr, 'acme.web-events-other')
    await expect(ungranted.call('list')).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
    await expect(ungranted.call('create', { space: 's' }, gesture))
      .resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
    for (const view of [granted.view, ungranted.view, other.view]) view.webContents.sent.length = 0

    const viewId = (await granted.call('create', { space: 's' }, gesture)).result!.viewId as string
    await vi.waitFor(() => expect(webEvents(granted.view)).toHaveLength(1))
    expect(webEvents(granted.view)[0]).toMatchObject({
      channel: 'plugin:cap:event',
      args: [{ type: 'web.changed', data: { views: [expect.objectContaining({ viewId, owner: 'user' })] } }],
    })
    expect(webEvents(ungranted.view)).toEqual([])
    expect(webEvents(other.view)).toEqual([])
  })

  it('refuses agent-initiated web calls unless the execution policy names web', async () => {
    const mgr = newManager()
    const a = await openWeb(mgr, 'acme.web-agent')
    const agentCall = (method: string, args: Record<string, unknown> = {}) =>
      mgr.executeAgentCapability(a.instanceId, { reqId: `agent-${method}-${++seq}`, ns: 'web', method, args })
    const policy = (mode: 'allowlist' | 'denylist', system: string[], revision: number) =>
      mgr.setExecutionPolicyResolver(() => ({
        policy: { schemaVersion: 1, mode, system, shell: [] },
        revision,
        state: 'user',
      }) as ExecutionPolicySnapshot)

    policy('allowlist', ['ui'], 1)
    await expect(agentCall('list')).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
    // A denylist written before `web` existed never admits it by omission.
    policy('denylist', [], 2)
    await expect(agentCall('list')).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
    policy('allowlist', ['web'], 3)
    await expect(agentCall('list')).resolves.toMatchObject({ ok: true, result: { views: [] } })
    // An agent never carries a user gesture.
    await expect(agentCall('create', { space: 's' })).resolves.toMatchObject({ ok: false, error: { code: 'USER_CANCELLED' } })
    expect(pluginWebViewRegistry().list('acme.web-agent')).toEqual([])

    // The executor re-checks the live policy itself before any side effect.
    const runtime = (mgr as unknown as {
      running: Map<string, { capabilityContext?: HostCapabilityContext | null }>
    }).running.get(a.instanceId)!.capabilityContext!.runtimeBinding!
    policy('allowlist', ['ui'], 4)
    await expect(mgr.executePublicCapability({
      kind: 'public',
      address: 'web.list',
      scope: 'plugin',
      args: {},
      runtime,
      initiator: { kind: 'agent', source: 'mcp', id: 'agent-1' },
    })).rejects.toThrow(/execution policy/)
  })

  it('refuses to attach to a frame-carried view', async () => {
    const mgr = newManager()
    const a = await openWeb(mgr, 'acme.web-frame')
    const viewId = (await a.call('create', { space: 's' }, gesture)).result!.viewId as string
    const record = (mgr as unknown as {
      running: Map<string, { carrier: string; capabilityContext?: HostCapabilityContext | null }>
    }).running.get(a.instanceId)!
    record.carrier = 'frame'
    try {
      await expect(mgr.executePublicCapability({
        kind: 'public',
        address: 'web.attach',
        scope: 'plugin',
        args: { viewId, rect: { x: 0, y: 0, width: 10, height: 10 } },
        runtime: record.capabilityContext!.runtimeBinding!,
      })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    } finally {
      record.carrier = 'surface'
    }
    expect(a.host.children).toHaveLength(1)
  })

  it('follows the plugin view bounds and visibility, and keeps views running after the view closes', async () => {
    const mgr = newManager()
    const a = await openWeb(mgr, 'acme.web-follow')
    const viewId = (await a.call('create', { space: 's' }, gesture)).result!.viewId as string
    const guest = lastGuest()
    await a.call('attach', { viewId, rect: { x: 5, y: 6, width: 100, height: 50 } })
    mgr.setBounds(a.instanceId, { x: 100, y: 200, width: 300, height: 300 })
    expect(guest.bounds).toEqual({ x: 105, y: 206, width: 100, height: 50 })
    mgr.deactivate(a.instanceId)
    expect(guest.visible).toBe(false)
    mgr.activate(a.instanceId)
    expect(guest.visible).toBe(true)

    mgr.destroyInstance(a.instanceId)
    expect(a.host.children).not.toContain(guest)
    expect(pluginWebViewRegistry().list('acme.web-follow')).toEqual([
      expect.objectContaining({ viewId, attached: false }),
    ])
    expect(guest.webContents.destroyed).toBe(false)
  })

  it('destroys a plugin\'s views when it is removed or its package version is revoked', async () => {
    const mgr = newManager()
    const removed = await openWeb(mgr, 'acme.web-removed')
    await removed.call('create', { space: 's' }, gesture)
    const removedGuest = lastGuest()
    const revoked = await openWeb(mgr, 'acme.web-revoked')
    await revoked.call('create', { space: 's' }, gesture)
    const revokedGuest = lastGuest()

    mgr.preparePluginRemoval('acme.web-removed')
    expect(pluginWebViewRegistry().list('acme.web-removed')).toEqual([])
    expect(removedGuest.webContents.destroyed).toBe(true)
    expect(revokedGuest.webContents.destroyed).toBe(false)

    await mgr.revokePackageVersion('acme.web-revoked', '1.0.0')
    expect(pluginWebViewRegistry().list('acme.web-revoked')).toEqual([])
    expect(revokedGuest.webContents.destroyed).toBe(true)
  })

  it('serves the native backend web Bridge port only to a first-party web backend with the web grant', async () => {
    const mgr = newManager()
    let grantedSystem: Array<'ui' | 'web'> = ['web']
    mgr.setCapabilityGrantResolver((_pluginId, packageVersion) => ({ packageVersion, system: grantedSystem }))
    mgr.configurePlansFilesystemService()
    const dispatcher = (mgr as unknown as {
      pluginBackendHost: { bridgeDispatcher: { dispatch: (request: unknown, context: PlansBridgeContext) => Promise<unknown> } }
    }).pluginBackendHost.bridgeDispatcher
    const bridge = (pluginId: string, operation: string, args: unknown) => dispatcher.dispatch({
      id: `bridge-${++seq}`,
      origin: { kind: 'call', requestId: 'parent-1' },
      port: 'web',
      operation,
      arguments: args,
    }, {
      runtime: {
        pluginId,
        packageVersion: '1.0.0',
        workspaceId: null,
        instanceId: null,
        contributionKey: null,
        hostWindowId: null,
        initiator: { kind: 'agent', source: 'mcp', id: 'agent-1' },
      },
      requestId: `bridge-${seq}`,
      signal: new AbortController().signal,
      emit: () => undefined,
    })

    const created = await bridge('navide.browser', 'create', { space: 'task' }) as { viewId: string }
    expect(pluginWebViewRegistry().list('navide.browser')).toEqual([
      expect.objectContaining({ viewId: created.viewId, owner: 'agent', control: 'agent' }),
    ])
    await expect(bridge('navide.browser', 'list', {})).resolves.toMatchObject({ views: [expect.objectContaining({ viewId: created.viewId })] })
    // Not a first-party web backend, and Plans never declares the port.
    await expect(bridge('acme.browser', 'list', {})).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(bridge('navide.plans', 'list', {})).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    grantedSystem = ['ui']
    await expect(bridge('navide.browser', 'list', {})).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    grantedSystem = ['web']
    await expect(bridge('navide.browser', 'close', { viewId: created.viewId })).resolves.toEqual({ ok: true })
    expect(pluginWebViewRegistry().list('navide.browser')).toEqual([])
  })

  it('gives the web Bridge port the calling pane, so a pane reaches only its own agent Spaces', async () => {
    const mgr = newManager()
    mgr.setCapabilityGrantResolver((_pluginId, packageVersion) => ({ packageVersion, system: ['web'] }))
    mgr.configurePlansFilesystemService()
    const dispatcher = (mgr as unknown as {
      pluginBackendHost: { bridgeDispatcher: { dispatch: (request: unknown, context: PlansBridgeContext) => Promise<unknown> } }
    }).pluginBackendHost.bridgeDispatcher
    const bridge = (paneId: string, operation: string, args: unknown) => dispatcher.dispatch({
      id: `bridge-${++seq}`,
      origin: { kind: 'call', requestId: 'parent-1' },
      port: 'web',
      operation,
      arguments: args,
    }, {
      runtime: {
        pluginId: 'navide.browser',
        packageVersion: '1.0.0',
        workspaceId: null,
        instanceId: null,
        contributionKey: null,
        hostWindowId: null,
        initiator: { kind: 'agent', source: 'mcp', id: `call-${seq}`, caller: { kind: 'pane', paneId, workspace: '/w', verifiedTo: 'pane' } },
      },
      requestId: `bridge-${seq}`,
      signal: new AbortController().signal,
      emit: () => undefined,
    })

    const created = await bridge('p-1', 'create', { space: 'pane-p-1' }) as { viewId: string }
    await expect(bridge('p-2', 'list', {})).resolves.toEqual({ views: [] })
    await expect(bridge('p-2', 'close', { viewId: created.viewId })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(bridge('p-1', 'list', {})).resolves.toMatchObject({ views: [expect.objectContaining({ viewId: created.viewId })] })
    await expect(bridge('p-1', 'close', { viewId: created.viewId })).resolves.toEqual({ ok: true })
  })

  it('clears a removed plugin\'s browser partition only when it declares web', async () => {
    const mgr = newManager()
    const a = await openWeb(mgr, 'acme.web-clear')
    void a
    await mgr.clearPluginWebData('acme.web-clear')
    expect(webHostMock.cleared).toContain('persist:navide-web:acme.web-clear')
    await mgr.clearPluginWebData('acme.not-web')
    expect(webHostMock.cleared).not.toContain('persist:navide-web:acme.not-web')
  })
})
