// @vitest-environment happy-dom
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {} from '../../plugins/navide-plans/src/provenance'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import { manifestV2CapabilityPolicy } from '../../src/main/plugins/pluginPermissions'

type IpcEvent = { sender: { id: number } }
type IpcHandler = (event: IpcEvent, payload?: unknown) => unknown
type IpcListener = (event: IpcEvent, payload?: unknown) => void

const electronMock = vi.hoisted(() => {
  let nextWebContentsId = 9000
  let nextWindowId = 41
  let senderId = 0

  class FakeWebContents {
    readonly id = nextWebContentsId++
    readonly sent: Array<{ channel: string; args: unknown[] }> = []
    loadedFile?: { path: string; search: string }
    private destroyed = false

    isDestroyed(): boolean {
      return this.destroyed
    }

    send(channel: string, ...args: unknown[]): void {
      this.sent.push({ channel, args })
      if (channel === 'plugin:backend:event') {
        const listener = ipcRendererListeners.get(channel)
        listener?.({ sender: { id: this.id } }, args[0])
      }
    }

    focus(): void {}

    loadFile(path: string, options?: { search?: string }): Promise<void> {
      this.loadedFile = { path, search: options?.search ?? '' }
      return Promise.resolve()
    }

    loadURL(): Promise<void> {
      return Promise.resolve()
    }

    on(): this {
      return this
    }

    once(): this {
      return this
    }

    removeListener(): this {
      return this
    }

    close(): void {
      this.destroyed = true
    }
  }

  const ipcHandlers = new Map<string, IpcHandler>()
  const ipcListeners = new Map<string, IpcListener>()
  const ipcRendererListeners = new Map<string, IpcListener>()
  const invocations: Array<{ channel: string; payload: unknown }> = []
  const views: FakeWebContentsView[] = []

  class FakeWebContentsView {
    readonly webContents = new FakeWebContents()
    readonly options: unknown
    bounds: unknown = null
    visible = false

    constructor(options?: unknown) {
      this.options = options
      views.push(this)
    }

    setBounds(bounds: unknown): void {
      this.bounds = bounds
    }

    setVisible(visible: boolean): void {
      this.visible = visible
    }
  }

  class FakeHostWindow {
    readonly id = nextWindowId++
    readonly children: unknown[] = []
    private readonly hostContentsListeners = new Map<string, Array<(...args: unknown[]) => void>>()
    /** The window document's own contents. The manager watches
     *  `did-start-navigation` here so a host reload reads as a deliberate
     *  teardown of the guests the window carries. Deliberately not a
     *  `FakeWebContents`, which would consume a guest webContents id. */
    readonly webContents = {
      on: (event: string, listener: (...args: unknown[]) => void): void => {
        const list = this.hostContentsListeners.get(event) ?? []
        list.push(listener)
        this.hostContentsListeners.set(event, list)
      },
      removeListener: (event: string, listener: (...args: unknown[]) => void): void => {
        this.hostContentsListeners.set(
          event,
          (this.hostContentsListeners.get(event) ?? []).filter((entry) => entry !== listener)
        )
      },
      emit: (event: string, ...args: unknown[]): void => {
        for (const listener of [...(this.hostContentsListeners.get(event) ?? [])]) listener(...args)
      },
      send: (): void => {},
    }
    readonly contentView = {
      addChildView: (view: unknown): void => {
        this.children.push(view)
      },
      removeChildView: (view: unknown): void => {
        const index = this.children.indexOf(view)
        if (index >= 0) this.children.splice(index, 1)
      },
    }

    isDestroyed(): boolean {
      return false
    }

    isMinimized(): boolean {
      return false
    }

    restore(): void {}

    show(): void {}

    focus(): void {}

    getContentBounds(): { x: number; y: number; width: number; height: number } {
      return { x: 0, y: 0, width: 1280, height: 820 }
    }

    on(): this {
      return this
    }

    removeListener(): this {
      return this
    }
  }

  const ipcRenderer = {
    on(channel: string, listener: IpcListener): void {
      ipcRendererListeners.set(channel, listener)
    },
    removeListener(channel: string, listener: IpcListener): void {
      if (ipcRendererListeners.get(channel) === listener) ipcRendererListeners.delete(channel)
    },
    invoke(channel: string, payload: unknown): Promise<unknown> {
      invocations.push({ channel, payload })
      const handler = ipcHandlers.get(channel)
      if (!handler) return Promise.reject(new Error(`missing IPC handler: ${channel}`))
      return Promise.resolve(handler({ sender: { id: senderId } }, payload))
    },
    send(channel: string, payload?: unknown): void {
      ipcListeners.get(channel)?.({ sender: { id: senderId } }, payload)
    },
  }

  const exposed: Record<string, unknown> = {}

  return {
    FakeHostWindow,
    FakeWebContentsView,
    ipcHandlers,
    ipcListeners,
    ipcRendererListeners,
    invocations,
    views,
    exposed,
    ipcRenderer,
    setSender(id: number): void {
      senderId = id
    },
  }
})

vi.mock('electron', () => {
  return {
    BrowserWindow: electronMock.FakeHostWindow,
    WebContentsView: electronMock.FakeWebContentsView,
    ipcMain: {
      handle(channel: string, handler: IpcHandler): void {
        electronMock.ipcHandlers.set(channel, handler)
      },
      on(channel: string, listener: IpcListener): void {
        electronMock.ipcListeners.set(channel, listener)
      },
    },
    ipcRenderer: electronMock.ipcRenderer,
    contextBridge: {
      exposeInMainWorld(name: string, value: unknown): void {
        electronMock.exposed[name] = value
      },
    },
    __mock: electronMock,
  }
})

const coreWsMock = vi.hoisted(() => {
  class FakeNodeWebSocket {
    static readonly OPEN = 1
    static readonly CONNECTING = 0
    static readonly CLOSED = 3
    static readonly instances: FakeNodeWebSocket[] = []
    readonly sent: string[] = []
    readyState = FakeNodeWebSocket.CONNECTING
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>()

    constructor(readonly url: string) {
      FakeNodeWebSocket.instances.push(this)
      queueMicrotask(() => {
        if (this.readyState === FakeNodeWebSocket.CONNECTING) this.open()
      })
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? []
      listeners.push(listener)
      this.listeners.set(type, listeners)
    }

    send(data: string): void {
      this.sent.push(data)
      const request = JSON.parse(data) as { id: string; type: string }
      queueMicrotask(() => {
        this.emit('message', {
          data: JSON.stringify({
            id: request.id,
            type: request.type,
            ok: true,
            payload: request.type === 'plans.resolve_root'
              ? { root: process.cwd() }
              : request.type === 'plans.ensure_assets'
                ? { ok: true }
                : { settings: {} },
            error: null,
            timestamp: new Date().toISOString(),
          }),
        })
      })
    }

    close(): void {
      if (this.readyState === FakeNodeWebSocket.CLOSED) return
      this.readyState = FakeNodeWebSocket.CLOSED
      this.emit('close', {})
    }

    open(): void {
      if (this.readyState === FakeNodeWebSocket.OPEN) return
      this.readyState = FakeNodeWebSocket.OPEN
      this.emit('open', {})
    }

    private emit(type: string, event: unknown): void {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    }
  }

  return { FakeNodeWebSocket }
})

vi.mock('ws', () => ({ WebSocket: coreWsMock.FakeNodeWebSocket }))

import * as electron from 'electron'
import {
  FrontendPluginManager,
  PLANS_AGENT_BACKEND_METHODS,
  PLANS_BACKEND_METHODS,
  PLANS_PLUGIN_ID,
  registerBundledPlans,
  type PluginLaunchDescriptor,
} from '../../src/main/plugins/frontendPluginManager'
import { createPlansWindowRouter } from '../../src/main/plansWindowRouting'
import { PLANS_PLUGIN_REQUIRES } from '../../src/shared/pluginCapabilities'
import {
  PluginBackendSupervisor,
  createAuthenticatedBackendRuntime,
  type BackendPluginLaunchSpec,
  type BackendRuntimeContext,
} from '../../src/main/plugins/pluginBackendSupervisor'
import { PluginBackendHost } from '../../src/main/plugins/pluginBackendHost'
import {
  createProductionPlansBridgeDispatcher,
  createTestPlansFilesystemPort,
} from '../../src/main/plugins/plansBridge'

interface FakeWebContentsViewLike {
  webContents: {
    id: number
    loadedFile?: { path: string; search: string }
  }
  options: {
    webPreferences?: { additionalArguments?: string[] }
  }
}

const mock = (electron as unknown as {
  __mock: {
    exposed: Record<string, unknown>
    views: FakeWebContentsViewLike[]
    invocations: Array<{ channel: string; payload: unknown }>
    setSender(id: number): void
  }
}).__mock

const packagedFixture = join(process.cwd(), 'dist-test-fixtures/plans/backend/navide-plans')
const packagedFixtureEnabled = process.env.NAVIDE_TEST_PACKAGED_PLANS === '1'
if (packagedFixtureEnabled && !existsSync(packagedFixture)) {
  throw new Error(
    `NAVIDE_TEST_PACKAGED_PLANS=1 requires the packaged fixture at ${packagedFixture}; run pnpm run build:plans:fixture first.`,
  )
}

const runPackagedTest = packagedFixtureEnabled ? it : it.skip

const productionBackend = join(
  process.cwd(),
  process.platform === 'win32'
    ? 'dist-plugins/navide-plans/backend/navide-plans.exe'
    : 'dist-plugins/navide-plans/backend/navide-plans',
)
const productionBackendEnabled =
  process.env.NAVIDE_TEST_PRODUCTION_PLANS_BACKEND === '1' ||
  process.env.NAVIDE_TEST_PRODUCTION_PLANS === '1'
if (productionBackendEnabled && !existsSync(productionBackend)) {
  throw new Error(
    `NAVIDE_TEST_PRODUCTION_PLANS_BACKEND=1 requires the production backend at ${productionBackend}; run pnpm run build:plans:backend first.`,
  )
}

const runProductionBackendTest = productionBackendEnabled ? it : it.skip

const packagedBackendEnvironment: Record<string, string> = {}
for (const key of ['TMPDIR', 'TEMP', 'TMP'] as const) {
  const value = process.env[key]
  if (typeof value === 'string' && value.length > 0) packagedBackendEnvironment[key] = value
}

// Staged official artifacts are keyed by the running App's version.
const appVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version as string

describe('Plans packaged backend composition', () => {
  const managers: FrontendPluginManager[] = []
  const supervisors: PluginBackendSupervisor[] = []
  const originalArgv = [...process.argv]
  const originalWindow = (globalThis as unknown as { window?: unknown }).window
  const originalNav = (globalThis as unknown as { nav?: unknown }).nav
  const originalWindowNav = (window as unknown as { nav?: unknown }).nav
  const originalLocation = window.location.href
  // The preload exposes the Host-admitted frame bridge unless it runs in the
  // view's main frame, which is what every test here loads.
  beforeEach(() => {
    Object.defineProperty(process, 'isMainFrame', { value: true, configurable: true })
  })
  afterEach(async () => {
    delete (process as { isMainFrame?: boolean }).isMainFrame
    vi.restoreAllMocks()
    await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()))
    await Promise.all(managers.splice(0).map((manager) => manager.closeBackendPlugins()))
    process.argv.splice(0, process.argv.length, ...originalArgv)
    window.history.replaceState({}, '', originalLocation)
    if (originalWindowNav === undefined) delete (window as unknown as { nav?: unknown }).nav
    else Object.defineProperty(window, 'nav', { value: originalWindowNav, configurable: true })
    if (originalWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window
    else Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true })
    if (originalNav === undefined) delete (globalThis as unknown as { nav?: unknown }).nav
    else Object.defineProperty(globalThis, 'nav', { value: originalNav, configurable: true })
  })

  runPackagedTest(
    'resolves the Plans root and receives plans.changed through the packaged child',
    async () => {
      const manager = new FrontendPluginManager()
      managers.push(manager)
      const workspacePath = join(process.cwd(), 'src')
      const expectedPlanRoot = process.cwd()
      const packageVersion = '0.1.92'
      const view = {
        id: 'window',
        contributionKey: `${PLANS_PLUGIN_ID}.window`,
        kind: 'custom' as const,
        location: 'window' as const,
        title: 'Plans',
        entryFile: join(expectedPlanRoot, 'src/renderer/plugins/plans/index.html'),
      }
      const descriptor: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: expectedPlanRoot,
        requires: [...PLANS_PLUGIN_REQUIRES],
        capabilityPolicy: {
          kind: 'manifest-v2',
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          grants: [],
        },
        devUrl: '',
        entryFile: view.entryFile,
        views: [view],
      }
      manager.registerDescriptor(descriptor, { builtin: true })
      // The Host hands the child its plan root only under the package's fs
      // Grant, as it does for every filesystem operation.
      manager.setCapabilityGrantResolver((pluginId, version) => {
        if (pluginId !== PLANS_PLUGIN_ID || version !== packageVersion) return null
        return {
          packageVersion,
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          storage: true,
        }
      })
      manager.configurePlansFilesystemService()
      manager.registerBackendActivation({
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: expectedPlanRoot,
        entryFile: packagedFixture,
        protocolVersion: 1,
        activation: 'startup',
        approvedMethods: ['plans.resolve_root'],
        approvedEvents: ['plans.changed'],
        approvedBridgePorts: ['filesystem'],
      })

      const hostWindow = new electronMock.FakeHostWindow()
      // The production bridge is configured explicitly; the package child
      // never receives a direct Node filesystem adapter.
      manager.setBackendWsUrl('ws://plans-core-test')
      const capabilityContext = manager.plansCapabilityContext(packageVersion, workspacePath, view.contributionKey)
      expect(capabilityContext).toBeDefined()
      const handle = await manager.openView(descriptor, view, {
        hostWindow: hostWindow as never,
        bounds: 'fill',
        workspacePath,
        ...(capabilityContext ? { capabilityContext } : {}),
        query: `?window=plans&workspace_path=${encodeURIComponent(workspacePath)}&rel_path=${encodeURIComponent('.agent-team/plans/integration.html')}`,
      })
      const mountedView = mock.views.at(-1)
      expect(mountedView?.options.webPreferences?.additionalArguments).toContain('--plugin-backend=1')
      expect(hostWindow.children).toHaveLength(1)
      const webContents = (hostWindow.children[0] as FakeWebContentsViewLike).webContents
      mock.setSender(webContents.id)
      const coreSocket = coreWsMock.FakeNodeWebSocket.instances.at(-1)
      expect(coreSocket?.url).toBe('ws://plans-core-test')
      coreSocket?.open()
      await flushPromises()

      process.argv.splice(
        0,
        process.argv.length,
        ...originalArgv,
        `--plugin-id=${PLANS_PLUGIN_ID}`,
        '--plugin-backend=1',
      )
      await import('../../src/preload/plugin-preload')
      const nav = mock.exposed.nav
      expect(nav).toBeDefined()
      window.history.replaceState(
        {},
        '',
        `/?window=plans&workspace_path=${encodeURIComponent(workspacePath)}&rel_path=${encodeURIComponent('.agent-team/plans/integration.html')}`,
      )
      Object.defineProperty(globalThis, 'window', {
        value: window,
        configurable: true,
      })
      Object.defineProperty(window, 'nav', { value: nav, configurable: true })
      Object.defineProperty(globalThis, 'nav', { value: nav, configurable: true })

      mock.invocations.length = 0
      // Settings reconciliation currently reports failures through warn while
      // capability plumbing can report errors, so monitor both channels.
      const consoleError = vi.spyOn(console, 'error')
      const consoleWarn = vi.spyOn(console, 'warn')
      let plansSubscription: { dispose(): void } | undefined
      try {
        const plansBackendModule = '../../plugins/navide-plans/src/backend'
        const { plansBackend } = (await import(plansBackendModule)) as {
          plansBackend: {
            call(name: string, args?: unknown): Promise<unknown>
            subscribe(event: string, listener: (payload: unknown) => void): { ready: Promise<void>; dispose(): void }
          }
        }
        let resolveChanged!: (payload: unknown) => void
        const changed = new Promise<unknown>((resolve) => {
          resolveChanged = resolve
        })
        const sub = plansBackend.subscribe(
          'plans.changed',
          resolveChanged,
        )
        plansSubscription = sub
        await sub.ready

        const rootResult = await plansBackend.call('plans.resolve_root', { workspace_path: workspacePath })
        expect(rootResult).toMatchObject({ root: expectedPlanRoot })
        expect(mock.invocations).toContainEqual(expect.objectContaining({
          channel: 'plugin:backend:call',
          payload: expect.objectContaining({
            name: 'plans.resolve_root',
            args: { workspace_path: workspacePath },
          }),
        }))
        await expect(changed).resolves.toEqual({ workspace_path: expectedPlanRoot })
        const diagnostics = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
          .map((args) => args.map(String).join(' '))
          .join('\n')
        expect(diagnostics).not.toMatch(/capability .*not granted|\[settings\] reconcile failed/i)
      } finally {
        consoleError.mockRestore()
        consoleWarn.mockRestore()
        plansSubscription?.dispose()
        manager.destroyInstance(handle.instanceId)
      }
    },
  )

  runPackagedTest(
    'mounts the production PlansApp view and renders the plan list from the packaged child',
    async () => {
      const manager = new FrontendPluginManager()
      managers.push(manager)
      const workspacePath = join(process.cwd(), 'src')
      const expectedPlanRoot = process.cwd()
      const packageVersion = '0.1.92'
      const leftView = {
        id: 'left',
        contributionKey: `${PLANS_PLUGIN_ID}.left`,
        kind: 'custom' as const,
        location: 'left' as const,
        title: 'Plans',
        entryFile: join(expectedPlanRoot, 'src/renderer/plugins/plans/left.html'),
      }
      const windowView = {
        id: 'window',
        contributionKey: `${PLANS_PLUGIN_ID}.window`,
        kind: 'custom' as const,
        location: 'window' as const,
        title: 'Plans',
        entryFile: join(expectedPlanRoot, 'src/renderer/plugins/plans/index.html'),
      }
      const descriptor: PluginLaunchDescriptor = {
        id: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: expectedPlanRoot,
        requires: [...PLANS_PLUGIN_REQUIRES],
        capabilityPolicy: {
          kind: 'manifest-v2',
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          grants: [],
        },
        devUrl: '',
        entryFile: leftView.entryFile,
        views: [leftView, windowView],
      }
      manager.registerDescriptor(descriptor, { builtin: true })
      manager.setCapabilityGrantResolver((pluginId, version) => {
        if (pluginId !== PLANS_PLUGIN_ID || version !== packageVersion) return null
        return {
          packageVersion,
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          storage: true,
        }
      })
      manager.configurePlansFilesystemService()
      manager.registerBackendActivation({
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        packageDir: expectedPlanRoot,
        entryFile: packagedFixture,
        protocolVersion: 1,
        activation: 'startup',
        approvedMethods: ['plans.resolve_root', 'plans.list'],
        approvedEvents: ['plans.changed'],
        approvedBridgePorts: ['filesystem'],
      })

      const hostWindow = new electronMock.FakeHostWindow()
      manager.setBackendWsUrl('ws://plans-core-test')
      const openedWindows: Array<{ hostWindow: InstanceType<typeof electronMock.FakeHostWindow>; query: string }> = []
      const router = createPlansWindowRouter({
        frontendPluginManager: manager,
        openCatalogContributionWindow: async (contributionKey, targetWorkspacePath, extraParams) => {
          const standaloneHostWindow = new electronMock.FakeHostWindow()
          const query = new URLSearchParams({
            workspace_path: targetWorkspacePath,
            contribution: 'window',
            ...(extraParams ?? {}),
          }).toString()
          openedWindows.push({ hostWindow: standaloneHostWindow, query })
          return manager.openContributionWindow(standaloneHostWindow as never, contributionKey, {
            workspacePath: targetWorkspacePath,
            query: `?${query}`,
          })
        },
        migratePlansStorageState: async () => ({ status: 'ready' }),
        isPlansRecoveryEnabled: () => false,
        enterPlansRecovery: () => undefined,
        openLegacyPlanWindow: async () => undefined,
        warnMain: () => undefined,
      })
      manager.setOpenPlansWindowHandler((targetWorkspacePath, relPath) =>
        router.openPlanWindow(targetWorkspacePath, relPath),
      )
      manager.setPublicCapabilityHandler((plan) => manager.executePublicCapability(plan))
      const handle = await manager.openView(descriptor, leftView, {
        hostWindow: hostWindow as never,
        bounds: 'fill',
        workspacePath,
        capabilityContext: manager.plansCapabilityContext(packageVersion, workspacePath, leftView.id),
        query: `?workspace_path=${encodeURIComponent(workspacePath)}&contribution=left`,
      })
      const mountedView = mock.views.at(-1)
      expect(mountedView?.options.webPreferences?.additionalArguments).toContain('--plugin-backend=1')
      const webContents = (hostWindow.children[0] as FakeWebContentsViewLike).webContents
      mock.setSender(webContents.id)
      const coreSocket = coreWsMock.FakeNodeWebSocket.instances.at(-1)
      coreSocket?.open()
      await flushPromises()

      process.argv.splice(
        0,
        process.argv.length,
        ...originalArgv,
        `--plugin-id=${PLANS_PLUGIN_ID}`,
        '--plugin-backend=1',
      )
      await import('../../src/preload/plugin-preload')
      const nav = mock.exposed.nav
      expect(nav).toBeDefined()
      window.history.replaceState(
        {},
        '',
        `/?workspace_path=${encodeURIComponent(workspacePath)}&contribution=left`,
      )
      Object.defineProperty(globalThis, 'window', {
        value: window,
        configurable: true,
      })
      Object.defineProperty(window, 'nav', { value: nav, configurable: true })
      Object.defineProperty(globalThis, 'nav', { value: nav, configurable: true })

      mock.invocations.length = 0
      const consoleError = vi.spyOn(console, 'error')
      const consoleWarn = vi.spyOn(console, 'warn')
      let app: { unmount(): void } | undefined
      try {
        const plansAppModule = '../../plugins/navide-plans/src/PlansApp.vue'
        const { default: PlansApp } = (await import(plansAppModule)) as {
          default: any
        }

        const mountedApp = mount(PlansApp, {
          global: {
            plugins: [i18n],
            stubs: {
              SafeAiCliPanel: true,
            },
          },
        })
        app = mountedApp

        for (let i = 0; i < 50; i++) {
          await flushPromises()
          if (mountedApp.find('.plan-row').exists()) break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }

        expect(mock.invocations).toContainEqual(expect.objectContaining({
          channel: 'plugin:backend:call',
          payload: expect.objectContaining({
            name: 'plans.list',
            // The view pages the list so no response can outgrow a frame.
            args: { offset: 0 },
          }),
        }))

        const row = mountedApp.find('.plan-row')
        expect(row.exists()).toBe(true)
        expect(mountedApp.text()).toContain('Integration Plan')

        // A real left contribution uses the authenticated capability broker and
        // router to create a separate standalone Plans contribution.
        mock.invocations.length = 0
        await row.trigger('click')
        await flushPromises()

        expect(mock.invocations).toContainEqual(expect.objectContaining({
          channel: 'plugin:cap:call',
          payload: expect.objectContaining({
            ns: 'ui',
            method: 'openPlansWindow',
            args: { path: '.agent-team/plans/integration.html' },
          }),
        }))
        expect(openedWindows).toHaveLength(1)
        expect(openedWindows[0].hostWindow).not.toBe(hostWindow)
        expect(openedWindows[0].hostWindow.children).toHaveLength(1)
        const openedQuery = new URLSearchParams(openedWindows[0].query)
        expect(openedQuery.get('contribution')).toBe('window')
        expect(openedQuery.get('rel_path')).toBe('.agent-team/plans/integration.html')
        expect(mock.invocations).not.toContainEqual(expect.objectContaining({
          channel: 'plugin:cap:call',
          payload: expect.objectContaining({
            ns: 'ui',
            method: 'openInEditor',
          }),
        }))

        const diagnostics = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
          .map((args) => args.map(String).join(' '))
          .join('\n')
        expect(diagnostics).not.toMatch(/capability .*not granted|\[settings\] reconcile failed/i)
      } finally {
        consoleError.mockRestore()
        consoleWarn.mockRestore()
        app?.unmount()
        manager.destroyInstance(handle.instanceId)
      }
    },
  )

  runProductionBackendTest(
    'launches the production Plans backend through descriptor/activation/supervisor and completes health and plans.list',
    async () => {
      const tempWorkspace = realpathSync(mkdtempSync(join(tmpdir(), 'navide-plans-packaged-workspace-')))
      const plansDir = join(tempWorkspace, '.agent-team', 'plans')
      mkdirSync(plansDir, { recursive: true })
      const planFile = join(plansDir, 'controlled-plan.html')
      const templateFile = join(plansDir, '_template.html')
      const planMeta = {
        schemaVersion: 1,
        name: 'Controlled Production Plan',
        overview: 'Self-contained integration test plan',
        stage: 'in-progress',
        todos: [
          { id: 't-1', title: 'First task', status: 'done' },
          { id: 't-2', title: 'Second task', status: 'in-progress' },
        ],
      }
      writeFileSync(
        planFile,
        `<!DOCTYPE html><html><head><script id="plan-meta" type="application/json">${JSON.stringify(planMeta)}</script></head><body><h1>Controlled Production Plan</h1></body></html>`,
        'utf8',
      )
      writeFileSync(
        templateFile,
        `<!DOCTYPE html><html><head><script id="plan-meta" type="application/json">{}</script></head><body><h1>{{PLAN_NAME}}</h1><p>{{ONE_SENTENCE_OVERVIEW}}</p><ul><li data-status="pending" data-todo-id="phase-a">Todos</li></ul></body></html>`,
        'utf8',
      )

      try {
        const manager = new FrontendPluginManager()
        managers.push(manager)
        const expectedPlanRoot = tempWorkspace
        const packageVersion = '0.1.0'
        const view = {
          id: 'window',
          contributionKey: `${PLANS_PLUGIN_ID}.window`,
          kind: 'custom' as const,
          location: 'window' as const,
          title: 'Plans',
          entryFile: join(expectedPlanRoot, 'src/renderer/plugins/plans/index.html'),
        }
        const descriptor: PluginLaunchDescriptor = {
          id: PLANS_PLUGIN_ID,
          packageVersion,
          packageDir: expectedPlanRoot,
          requires: [...PLANS_PLUGIN_REQUIRES],
          capabilityPolicy: manifestV2CapabilityPolicy({
            system: ['fs', 'ui', 'aiCli'],
          }),
          devUrl: '',
          entryFile: view.entryFile,
          views: [view],
        }
        manager.registerDescriptor(descriptor, { builtin: true })
        manager.setBackendWsUrl('ws://plans-core-test')
        const filesystemPort = createTestPlansFilesystemPort()
        // The child writes plan files itself; the one bridge call a mutation
        // still makes is resolve_root, so that is where a response is held.
        const resolveRoot = filesystemPort.resolveRoot.bind(filesystemPort)
        let delayMutationResponse = false
        let heldRootRequests = 0
        filesystemPort.resolveRoot = async (arguments_, context) => {
          const result = await resolveRoot(arguments_, context)
          if (!delayMutationResponse) return result
          heldRootRequests++
          return await new Promise((_, reject) => {
            const abort = () => reject(new Error('test: hold the root until the Host call times out'))
            if (context.signal.aborted) {
              abort()
              return
            }
            context.signal.addEventListener('abort', abort, { once: true })
          })
        }
        manager.configurePlansFilesystemService(filesystemPort)
        let packageGrantActive = true
        manager.setCapabilityGrantResolver((pluginId, version) => {
          if (packageGrantActive && pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
            return {
              packageVersion,
              system: ['fs', 'ui', 'aiCli'],
              storage: true,
            }
          }
          return null
        })
        let agentFsAllowed = true
        manager.setExecutionPolicyResolver((_workspacePath) => ({
          policy: {
            schemaVersion: 1,
            mode: 'allowlist',
            system: agentFsAllowed ? ['fs'] : [],
            shell: [],
          },
          revision: 1,
          state: 'user',
        }))

        const activation: BackendPluginLaunchSpec = {
          pluginId: descriptor.id,
          packageVersion,
          packageDir: expectedPlanRoot,
          entryFile: productionBackend,
          protocolVersion: 1,
          activation: 'startup',
          approvedMethods: [
            'plans.resolve_root',
            'plans.list',
            'plans.create',
            'plans.read',
            'plans.update_stage',
            'plans.update_todo',
            'plans.update_archive',
            'plans.delete',
            'fixture.echo',
          ],
          agentMethods: [
            'plans.list',
            'plans.create',
            'plans.read',
            'plans.update_stage',
            'plans.update_todo',
          ],
          approvedEvents: ['plans.changed'],
          approvedBridgePorts: ['filesystem'],
        }
        manager.registerBackendActivation(activation)

        expect(manager.getDescriptor(PLANS_PLUGIN_ID)).toBe(descriptor)
        expect(manager.hasBackendActivation(PLANS_PLUGIN_ID, packageVersion)).toBe(true)

        const supervisor = new PluginBackendSupervisor(activation, {
          environment: packagedBackendEnvironment,
          bridgeDispatcher: createProductionPlansBridgeDispatcher({
            filesystem: filesystemPort,
          }),
          authorizedPlanRoot: { value: expectedPlanRoot },
          resolveExecutionPolicy: (_runtime, workspacePath) => ({
            policy: {
              schemaVersion: 1,
              mode: 'allowlist',
              system: agentFsAllowed ? ['fs'] : [],
              shell: [],
            },
            revision: 1,
            state: 'user',
          }),
        })
        supervisors.push(supervisor)

        const health = await supervisor.start()
        expect(health).toMatchObject({
          value: {
            method: 'navide/health',
            protocolVersion: '2026-07-28',
            requestIdIsNonNull: true,
          },
          serverInfo: {
            name: 'navide.plans',
            version: '0.1.0',
          },
        })

        const runtime: BackendRuntimeContext = {
          pluginId: activation.pluginId,
          packageVersion: activation.packageVersion,
          workspaceId: 'workspace-prod-1',
          instanceId: 'instance-prod-1',
          contributionKey: `${PLANS_PLUGIN_ID}.window`,
          hostWindowId: 'window-prod-1',
          initiator: { kind: 'user', id: 'user-prod-1' },
        }
        const authenticatedRuntime = createAuthenticatedBackendRuntime(runtime)
        const client = supervisor.clientFor(authenticatedRuntime, {
          workspacePath: expectedPlanRoot,
          authorizedPlanRoot: expectedPlanRoot,
        })

        const rootResult = await client.call('plans.resolve_root', {
          workspace_path: expectedPlanRoot,
        })
        expect(rootResult).toEqual({ ok: true, root: expectedPlanRoot })

        const list = (await client.call('plans.list', {})) as Array<{
          rel_path: string
          name: string
          stage?: string
          overview?: string
          todos?: { total: number; by_status: Record<string, number> }
          mtime?: number
          kind: string
          meta?: { schemaVersion?: number; name?: string; stage?: string }
        }>

        expect(Array.isArray(list)).toBe(true)
        expect(list).toHaveLength(1)

        // Verify the production artifact is used rather than the dist-test-fixtures binary:
        // 1. Production artifact path verified:
        expect(activation.entryFile).toBe(productionBackend)
        expect(activation.entryFile).not.toBe(packagedFixture)
        expect(productionBackend).toContain('dist-plugins/navide-plans/backend')

        // 2. Production serverInfo version is 0.1.0, not fixture 0.1.92:
        expect(health.serverInfo?.version).toBe('0.1.0')
        expect(health.serverInfo?.version).not.toBe('0.1.92')

        // 3. The fixture returns a hardcoded mock 'Integration Plan' document;
        //    the production artifact invokes the real filesystem bridge and parses the controlled plan file:
        expect(list).not.toContainEqual(expect.objectContaining({ name: 'Integration Plan' }))
        expect(list[0]).toMatchObject({
          rel_path: '.agent-team/plans/controlled-plan.html',
          name: 'Controlled Production Plan',
          stage: 'in-progress',
          overview: 'Self-contained integration test plan',
          kind: 'plan',
          meta: planMeta,
          todos: {
            total: 2,
            by_status: {
              done: 1,
              'in-progress': 1,
            },
          },
          mtime: expect.any(Number),
        })

        // 4. Fixture wire-test methods (e.g. fixture.echo) do not exist in the production binary:
        await expect(client.call('fixture.echo', { value: 'probe' })).rejects.toMatchObject({
          code: 'PROTOCOL_ERROR',
        })

        // 5. Real Agent CRUD: exercise executeAgentBackendCallForWorkspace against production backend
        const createResponse = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-create-1',
            name: 'plans.create',
            args: {
              name: 'Agent Real Plan',
              overview: 'Self-contained agent plan',
              stage: 'draft',
              todos: [{ id: 'step-1', content: 'First step' }],
            },
          },
        )
        expect(createResponse).toMatchObject({
          reqId: 'agent-create-1',
          ok: true,
          result: {
            rel_path: expect.stringMatching(/^\.agent-team\/plans\/agent-real-plan_[0-9a-f]{6}\.html$/),
            name: 'Agent Real Plan',
            stage: 'draft',
          },
        })
        const createdRelPath = (createResponse as { result: { rel_path: string } }).result.rel_path

        const readResponse = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-read-1',
            name: 'plans.read',
            args: { rel_path: createdRelPath },
          },
        )
        expect(readResponse).toMatchObject({
          reqId: 'agent-read-1',
          ok: true,
          result: {
            rel_path: createdRelPath,
            meta: expect.objectContaining({
              name: 'Agent Real Plan',
              stage: 'draft',
              todos: [expect.objectContaining({ id: 'step-1', content: 'First step', status: 'pending' })],
            }),
          },
        })

        const updateStageResponse = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-stage-1',
            name: 'plans.update_stage',
            args: { rel_path: createdRelPath, stage: 'approved' },
          },
        )
        expect(updateStageResponse).toMatchObject({
          reqId: 'agent-stage-1',
          ok: true,
          result: {
            stage: 'approved',
            approvedAt: expect.any(String),
          },
        })

        const updateTodoResponse = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-todo-1',
            name: 'plans.update_todo',
            args: { rel_path: createdRelPath, todo_id: 'step-1', status: 'done' },
          },
        )
        expect(updateTodoResponse).toMatchObject({
          reqId: 'agent-todo-1',
          ok: true,
          result: expect.objectContaining({ id: 'step-1', status: 'done' }),
        })

        // 6. Execution Policy denial: deny fs capability, assert CAPABILITY_DENIED and zero disk modification
        agentFsAllowed = false
        const createdDiskPath = join(tempWorkspace, createdRelPath)
        const diskContentBeforeDenial = readFileSync(createdDiskPath, 'utf8')
        const diskMtimeBeforeDenial = statSync(createdDiskPath).mtimeMs

        const deniedResponse = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-denied-1',
            name: 'plans.update_stage',
            args: { rel_path: createdRelPath, stage: 'done' },
          },
        )
        expect(deniedResponse).toMatchObject({
          reqId: 'agent-denied-1',
          ok: false,
          error: { code: 'CAPABILITY_DENIED' },
        })

        expect(readFileSync(createdDiskPath, 'utf8')).toBe(diskContentBeforeDenial)
        expect(statSync(createdDiskPath).mtimeMs).toBe(diskMtimeBeforeDenial)

        // 7. Manual/User operation: invoke preload/SDK plansBackend.call on the running instance
        // Confirm manual operation succeeds while agent execution policy denies
        const hostWindow = new electronMock.FakeHostWindow()
        const capabilityContext = manager.plansCapabilityContext(packageVersion, tempWorkspace, view.contributionKey)
        const handle = await manager.openView(descriptor, view, {
          hostWindow: hostWindow as never,
          bounds: 'fill',
          workspacePath: tempWorkspace,
          query: `?window=plans&workspace_path=${encodeURIComponent(tempWorkspace)}&rel_path=${encodeURIComponent(createdRelPath)}`,
          ...(capabilityContext ? { capabilityContext } : {}),
        })
        await manager.waitForBackendBinding(handle.instanceId)
        const webContents = (hostWindow.children[0] as FakeWebContentsViewLike).webContents
        mock.setSender(webContents.id)

        process.argv.splice(
          0,
          process.argv.length,
          ...originalArgv,
          `--plugin-id=${PLANS_PLUGIN_ID}`,
          '--plugin-backend=1',
        )
        await import('../../src/preload/plugin-preload')
        const nav = mock.exposed.nav
        expect(nav).toBeDefined()
        window.history.replaceState(
          {},
          '',
          `/?window=plans&workspace_path=${encodeURIComponent(tempWorkspace)}&rel_path=${encodeURIComponent(createdRelPath)}`,
        )
        Object.defineProperty(globalThis, 'window', { value: window, configurable: true })
        Object.defineProperty(window, 'nav', { value: nav, configurable: true })
        Object.defineProperty(globalThis, 'nav', { value: nav, configurable: true })

        const { plansBackend } = (await import('../../plugins/navide-plans/src/backend')) as {
          plansBackend: {
            call(name: string, args?: unknown): Promise<unknown>
          }
        }

        const manualResult = await plansBackend.call('plans.update_stage', {
          rel_path: createdRelPath,
          stage: 'done',
        })
        expect(manualResult).toMatchObject({ stage: 'done' })
        expect(readFileSync(createdDiskPath, 'utf8')).toMatch(/"stage":\s*"done"/)

        // The packaged child's mutation is held at its root request until the
        // Host call times out. This must never become a legacy write or a Host
        // recovery disposition, and the child never writes without its root.
        agentFsAllowed = true
        delayMutationResponse = true
        const responseLost = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-response-lost-1',
            name: 'plans.update_stage',
            args: { rel_path: createdRelPath, stage: 'in-progress' },
            timeoutMs: 100,
          },
        )
        expect(responseLost).toMatchObject({
          reqId: 'agent-response-lost-1',
          ok: false,
          error: { code: 'TIMEOUT' },
        })
        expect(responseLost).not.toHaveProperty('recoveryDisposition')
        expect(heldRootRequests).toBe(1)
        expect(readFileSync(createdDiskPath, 'utf8')).toMatch(/"stage":\s*"done"/)

        // During revocation no mutation reaches either packaged or legacy
        // filesystem code; after the Grant is gone it remains denied.
        const diskBeforeRevocation = readFileSync(createdDiskPath, 'utf8')
        let finishRevocation!: () => void
        const revoke = vi.spyOn(PluginBackendHost.prototype, 'revokePackageVersion')
          .mockImplementation(() => new Promise<void>((resolve) => { finishRevocation = resolve }))
        const revocation = manager.revokePackageVersion(PLANS_PLUGIN_ID, packageVersion)
        await Promise.resolve()
        const stoppingResponse = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-revoking-1',
            name: 'plans.update_stage',
            args: { rel_path: createdRelPath, stage: 'done' },
          },
        )
        expect(stoppingResponse).toMatchObject({
          ok: false,
          error: { code: 'PLUGIN_STOPPING' },
        })
        expect(stoppingResponse).not.toHaveProperty('recoveryDisposition')
        expect(readFileSync(createdDiskPath, 'utf8')).toBe(diskBeforeRevocation)
        finishRevocation()
        await revocation
        revoke.mockRestore()

        packageGrantActive = false
        const revokedGrantResponse = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-grant-revoked-1',
            name: 'plans.update_stage',
            args: { rel_path: createdRelPath, stage: 'done' },
          },
        )
        expect(revokedGrantResponse).toMatchObject({
          ok: false,
          error: { code: 'CAPABILITY_DENIED' },
        })
        expect(revokedGrantResponse).not.toHaveProperty('recoveryDisposition')
        expect(readFileSync(createdDiskPath, 'utf8')).toBe(diskBeforeRevocation)
        manager.destroyInstance(handle.instanceId)
      } finally {
        rmSync(tempWorkspace, { recursive: true, force: true })
      }
    },
    60_000,
  )

  runProductionBackendTest(
    'loads the Host-selected worktree frontend artifact and exercises real review controls',
    async () => {
      const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'plans-artifact-review-')))
      const relPath = '.agent-team/plans/artifact.html'
      const planPath = join(workspace, relPath)
      mkdirSync(dirname(planPath), { recursive: true })
      const metadata = {
        schemaVersion: 1, name: 'Artifact Review', overview: '', stage: 'in-review', approvedAt: null,
        todos: [{ id: 'todo-1', content: 'Keep preview stable', status: 'pending' }],
        reviewNotes: [
          { id: 'n1', author: 'user', text: 'Original note', resolved: false, reply: '', anchor: 'Goals' },
          { id: 'n2', author: 'ai', text: 'Resolved note', resolved: true, reply: 'Reply retained', anchor: 'Goals' },
        ],
      }
      writeFileSync(planPath, `<!doctype html><html><head><script id="plan-meta" type="application/json">${JSON.stringify(metadata)}</script></head><body><section><h2>Goals</h2><p>Scope</p></section><ul class="todos"><li data-status="pending" data-todo-id="todo-1">Keep preview stable</li></ul></body></html>`)
      const root = document.createElement('div')
      root.id = 'app'
      document.body.appendChild(root)
      const styles: HTMLStyleElement[] = []
      let app: { unmount(): void } | undefined
      const manager = new FrontendPluginManager()
      managers.push(manager)
      try {
        manager.setPlansDiagnosticsEnabled(true)
        expect(registerBundledPlans(manager, { isPackaged: false, resourcesPath: '', artifactVersion: appVersion, devRoot: process.cwd() })).toEqual({ registered: true })
        const descriptor = manager.getDescriptor(PLANS_PLUGIN_ID)!
        const view = descriptor.views!.find((candidate) => candidate.contributionKey === 'navide.plans.window')!
        const packageDirectory = realpathSync(join(
          process.cwd(),
          'dist-plugins',
          'official-artifacts',
          'factory-resources',
          PLANS_PLUGIN_ID,
          appVersion,
          `${process.platform}-${process.arch}`,
          'package',
        ))
        const packageVersion = JSON.parse(readFileSync(join(packageDirectory, 'manifest.json'), 'utf8')).version
        expect(packageVersion).toBe(appVersion)
        expect(manager.getPlansProvenance()).toMatchObject({
          descriptorSource: 'factory-bundle',
          selectionOrigin: 'factory-bundle',
          packageDirectory,
          packageVersion,
          backendExecutable: realpathSync(join(
            packageDirectory,
            'backend',
            process.platform === 'win32' ? 'navide-plans.exe' : 'navide-plans',
          )),
          frontendEntries: {
            'navide.plans.window': join(packageDirectory, 'frontend', 'window', 'index.html'),
          },
        })
        manager.setBackendWsUrl('ws://plans-core-test')
        manager.configurePlansFilesystemService(createTestPlansFilesystemPort())
        manager.setCapabilityGrantResolver(() => ({ packageVersion, system: ['fs', 'ui', 'aiCli'], storage: true }))
        manager.setExecutionPolicyResolver(() => ({
          policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] }, revision: 1, state: 'user',
        }))
        const hostWindow = new electronMock.FakeHostWindow()
        const capabilityContext = manager.plansCapabilityContext(packageVersion, workspace, view.contributionKey)
        const handle = await manager.openView(descriptor, view, {
          hostWindow: hostWindow as never, bounds: 'fill', workspacePath: workspace,
          query: `?workspace_path=${encodeURIComponent(workspace)}&rel_path=${encodeURIComponent(relPath)}&contribution=window&locale=en-US`,
          ...(capabilityContext ? { capabilityContext } : {}),
        })
        await manager.waitForBackendBinding(handle.instanceId)
        const contents = (hostWindow.children[0] as FakeWebContentsViewLike).webContents
        mock.setSender(contents.id)
        expect(contents.loadedFile?.path).toBe(view.entryFile)
        process.argv.splice(0, process.argv.length, ...originalArgv, `--plugin-id=${PLANS_PLUGIN_ID}`, '--plugin-backend=1')
        await import('../../src/preload/plugin-preload')
        Object.defineProperty(window, 'nav', { value: mock.exposed.nav, configurable: true })
        Object.defineProperty(globalThis, 'nav', { value: mock.exposed.nav, configurable: true })
        window.history.replaceState({}, '', `/${contents.loadedFile!.search}`)

        // Execute the entry emitted by Vite, including its bundled Vue/SDK and
        // production composition. This does not import PlansApp source or stub
        // a component. Electron/OS edges are the only simulated surfaces.
        const entry = readFileSync(contents.loadedFile!.path, 'utf8')
        for (const match of entry.matchAll(/<link[^>]+href="([^"]+\.css)"/g)) {
          const style = document.createElement('style')
          style.textContent = readFileSync(resolve(dirname(view.entryFile), match[1]), 'utf8')
          document.head.appendChild(style)
          styles.push(style)
        }
        const script = entry.match(/<script[^>]+src="([^"]+)"/)
        expect(script, 'built frontend entry must select an emitted script').not.toBeNull()
        await import(/* @vite-ignore */ pathToFileURL(resolve(dirname(view.entryFile), script![1])).href)
        app = (root as typeof root & { __vue_app__?: { unmount(): void } }).__vue_app__
        expect(app, 'production entry must mount its app').toBeDefined()
        const config = (await import('../../plugins/navide-plans/vite.config')).default
        expect(window.__NAVIDE_PLANS_PROVENANCE__).toMatchObject({
          packageVersion,
          packageSource: 'factory-bundled',
          buildId: JSON.parse(config.define!.__NAVIDE_PLANS_BUILD_ID__),
        })
        await vi.waitFor(() => expect(root.querySelector('.prt-notes-btn')).not.toBeNull())
        const get = (selector: string) => {
          const element = root.querySelector(selector)
          expect(element, selector).not.toBeNull()
          return new DOMWrapper(element!)
        }
        const calls = (name: string) => mock.invocations.filter((entry) => entry.channel === 'plugin:backend:call' && (entry.payload as { name?: string })?.name === name)
        const frame = get('.plan-doc-frame').element as HTMLIFrameElement
        const originalSrcdoc = frame.srcdoc
        expect(get('.prt-bar .prt-notes-btn').attributes('disabled'), 'Notes must be enabled').toBeUndefined()
        await get('.prt-bar .prt-notes-btn').trigger('click')
        await vi.waitFor(() => expect(root.querySelector('.prt > .prt-panel > .prt-new')).not.toBeNull())
        expect(root.textContent).toContain('Reply retained')
        expect(get('.prt-approve').attributes('disabled')).toBeDefined()
        await get('[data-test="edit-n1"]').trigger('click')
        await vi.waitFor(() => expect(document.activeElement === root.querySelector('[data-test="review-note-edit-input"]')).toBe(true))
        const editsBefore = calls('plans.review_note_edit').length
        await get('[data-test="review-note-edit-input"]').setValue('Edited artifact')
        await get('[data-test="review-note-edit-save"]').trigger('click')
        await vi.waitFor(() => expect(readFileSync(planPath, 'utf8')).toContain('Edited artifact'))
        expect(calls('plans.review_note_edit').length - editsBefore).toBe(1)
        expect(calls('plans.review_note_edit').at(-1)?.payload).toMatchObject({ args: { rel_path: relPath, note_id: 'n1', text: 'Edited artifact' } })
        await vi.waitFor(() => expect(get('[data-test="delete-n1"]').attributes('disabled')).toBeUndefined())
        const deletesBefore = calls('plans.review_note_delete').length
        await get('[data-test="delete-n1"]').trigger('click')
        await vi.waitFor(() => expect(document.querySelector('.modal .card.confirm')).not.toBeNull())
        expect(calls('plans.review_note_delete')).toHaveLength(deletesBefore)
        await new DOMWrapper(document.querySelector('.modal .ghost')!).trigger('click')
        expect(calls('plans.review_note_delete')).toHaveLength(deletesBefore)
        await get('[data-test="delete-n1"]').trigger('click')
        await vi.waitFor(() => expect(document.querySelector('.modal .primary')).not.toBeNull())
        await new DOMWrapper(document.querySelector('.modal .primary')!).trigger('click')
        await vi.waitFor(() => expect(calls('plans.review_note_delete')).toHaveLength(deletesBefore + 1))
        await vi.waitFor(() => expect(readFileSync(planPath, 'utf8')).not.toContain('Edited artifact'))
        expect(get('.plan-doc-frame').element).toBe(frame)
        expect(frame.srcdoc === originalSrcdoc, 'note changes must not reload the preview').toBe(true)

        // Authenticate the actual preview message, rather than calling an
        // exposed Vue method. The emitted runtime supplies this exact token.
        const documentToken = frame.srcdoc.match(/var documentToken = "([0-9a-f]{32})"/)?.[1]
        expect(Boolean(documentToken), 'built preview must have a document token').toBe(true)
        window.dispatchEvent(new MessageEvent('message', {
          source: frame.contentWindow,
          data: { type: 'section-comment', anchor: 'Goals', documentToken },
        }))
        await vi.waitFor(() => expect(root.querySelector('.prt-note-anchor--pending')?.textContent).toContain('Goals'))
        await vi.waitFor(() => expect(document.activeElement === root.querySelector('[data-test="review-note-input"]')).toBe(true))
        const addsBefore = calls('plans.review_note_add').length
        await get('[data-test="review-note-input"]').setValue('Anchored artifact comment')
        await get('[data-test="review-note-input"]').trigger('keydown', { key: 'Enter', isComposing: true })
        expect(calls('plans.review_note_add')).toHaveLength(addsBefore)
        await get('[data-test="review-note-input"]').trigger('keydown', { key: 'Enter' })
        await vi.waitFor(() => expect(readFileSync(planPath, 'utf8')).toContain('Anchored artifact comment'))
        expect(calls('plans.review_note_add')).toHaveLength(addsBefore + 1)
        expect(calls('plans.review_note_add').at(-1)?.payload).toMatchObject({
          args: { rel_path: relPath, text: 'Anchored artifact comment', anchor: 'Goals' },
        })
        expect(readFileSync(planPath, 'utf8')).toMatch(/"anchor":\s*"Goals"/)
        await vi.waitFor(() => expect(get('[data-test="review-note-input"]').attributes('disabled')).toBeUndefined())
        const diskBeforeDenied = readFileSync(planPath, 'utf8')
        for (const method of ['review_note_add', 'review_note_edit', 'review_note_delete', 'review_note_resolve', 'read_document', 'write_document', 'list_directory']) {
          expect(await manager.executeAgentBackendCallForWorkspace(PLANS_PLUGIN_ID, workspace, {
            reqId: `agent-denied-${method}`, name: `plans.${method}`, args: { rel_path: relPath },
          })).toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } })
        }
        expect(readFileSync(planPath, 'utf8')).toBe(diskBeforeDenied)
        manager.destroyInstance(handle.instanceId)
      } finally {
        app?.unmount()
        root.remove()
        styles.forEach((style) => style.remove())
        rmSync(workspace, { recursive: true, force: true })
      }
    },
    60_000,
  )

  runProductionBackendTest(
    'mounts the real PlansApp window and persists Review Notes through the packaged child',
    async () => {
      const tempWorkspace = realpathSync(mkdtempSync(join(tmpdir(), 'navide-plans-review-workspace-')))
      const plansDir = join(tempWorkspace, '.agent-team', 'plans')
      mkdirSync(plansDir, { recursive: true })
      const planFile = join(plansDir, 'real-review-plan.html')
      const initialMeta = {
        schemaVersion: 1,
        name: 'Real Review Plan',
        overview: 'Plan for testing review notes integration',
        stage: 'in-review',
        todos: [
          { id: 'todo-1', content: 'Task 1', status: 'pending' },
        ],
        reviewNotes: [],
      }
      const initialHtml = `<!DOCTYPE html><html><head><script id="plan-meta" type="application/json">${JSON.stringify(initialMeta)}</script></head><body><h1>Real Review Plan</h1><section><h2>Review Notes</h2><ul class="notes"></ul><p class="note">No review notes.</p></section></body></html>`
      writeFileSync(planFile, initialHtml, 'utf8')

      let app: { unmount(): void } | undefined
      try {
        const manager = new FrontendPluginManager()
        managers.push(manager)
        const expectedPlanRoot = tempWorkspace
        const packageVersion = '0.1.0'
        const view = {
          id: 'window',
          contributionKey: `${PLANS_PLUGIN_ID}.window`,
          kind: 'custom' as const,
          location: 'window' as const,
          title: 'Plans',
          entryFile: join(expectedPlanRoot, 'src/renderer/plugins/plans/index.html'),
        }
        const descriptor: PluginLaunchDescriptor = {
          id: PLANS_PLUGIN_ID,
          packageVersion,
          packageDir: expectedPlanRoot,
          requires: [...PLANS_PLUGIN_REQUIRES],
          capabilityPolicy: manifestV2CapabilityPolicy({
            system: ['fs', 'ui', 'aiCli'],
          }),
          devUrl: '',
          entryFile: view.entryFile,
          views: [view],
        }
        manager.registerDescriptor(descriptor, { builtin: true })
        manager.setBackendWsUrl('ws://plans-core-test')
        const filesystemPort = createTestPlansFilesystemPort()
        manager.configurePlansFilesystemService(filesystemPort)
        manager.setCapabilityGrantResolver((pluginId, version) => {
          if (pluginId === PLANS_PLUGIN_ID && version === packageVersion) {
            return {
              packageVersion,
              system: ['fs', 'ui', 'aiCli'],
              storage: true,
            }
          }
          return null
        })
        manager.setExecutionPolicyResolver((_workspacePath) => ({
          policy: {
            schemaVersion: 1,
            mode: 'allowlist',
            system: ['fs'],
            shell: [],
          },
          revision: 1,
          state: 'user',
        }))

        const activation: BackendPluginLaunchSpec = {
          pluginId: descriptor.id,
          packageVersion,
          packageDir: expectedPlanRoot,
          entryFile: productionBackend,
          protocolVersion: 1,
          activation: 'startup',
          approvedMethods: [...PLANS_BACKEND_METHODS],
          agentMethods: [...PLANS_AGENT_BACKEND_METHODS],
          approvedEvents: ['plans.changed'],
          approvedBridgePorts: ['filesystem'],
        }
        manager.registerBackendActivation(activation)

        const supervisor = new PluginBackendSupervisor(activation, {
          environment: packagedBackendEnvironment,
          bridgeDispatcher: createProductionPlansBridgeDispatcher({
            filesystem: filesystemPort,
          }),
          authorizedPlanRoot: { value: expectedPlanRoot },
          resolveExecutionPolicy: (_runtime, _workspacePath) => ({
            policy: {
              schemaVersion: 1,
              mode: 'allowlist',
              system: ['fs'],
              shell: [],
            },
            revision: 1,
            state: 'user',
          }),
        })
        supervisors.push(supervisor)
        await supervisor.start()

        const hostWindow = new electronMock.FakeHostWindow()
        const capabilityContext = manager.plansCapabilityContext(packageVersion, tempWorkspace, view.contributionKey)
        const relPath = '.agent-team/plans/real-review-plan.html'
        const handle = await manager.openView(descriptor, view, {
          hostWindow: hostWindow as never,
          bounds: 'fill',
          workspacePath: tempWorkspace,
          query: `?window=plans&workspace_path=${encodeURIComponent(tempWorkspace)}&rel_path=${encodeURIComponent(relPath)}`,
          ...(capabilityContext ? { capabilityContext } : {}),
        })
        await manager.waitForBackendBinding(handle.instanceId)
        const webContents = (hostWindow.children[0] as FakeWebContentsViewLike).webContents
        mock.setSender(webContents.id)

        process.argv.splice(
          0,
          process.argv.length,
          ...originalArgv,
          `--plugin-id=${PLANS_PLUGIN_ID}`,
          '--plugin-backend=1',
        )
        await import('../../src/preload/plugin-preload')
        const nav = mock.exposed.nav
        expect(nav).toBeDefined()
        window.history.replaceState(
          {},
          '',
          `/?window=plans&workspace_path=${encodeURIComponent(tempWorkspace)}&rel_path=${encodeURIComponent(relPath)}`,
        )
        Object.defineProperty(globalThis, 'window', { value: window, configurable: true })
        Object.defineProperty(window, 'nav', { value: nav, configurable: true })
        Object.defineProperty(globalThis, 'nav', { value: nav, configurable: true })

        const { default: PlansApp } = (await import('../../plugins/navide-plans/src/PlansApp.vue')) as {
          default: any
        }
        const mountedApp = mount(PlansApp, {
          attachTo: document.body,
          global: {
            plugins: [i18n],
            stubs: {
              SafeAiCliPanel: true,
            },
          },
        })
        app = mountedApp

        for (let i = 0; i < 50; i++) {
          await flushPromises()
          if (mountedApp.find('.selected-document').exists()) break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(mountedApp.find('.selected-document').exists()).toBe(true)

        // Verify todo toggle preserves iframe identity and documentToken without remount/flash
        const frameElBefore = mountedApp.find('.plan-doc-frame').element
        const tokenBefore = (mountedApp.vm as any).currentDocumentToken
        expect(tokenBefore).toBeDefined()
        const postMessageMock = vi.fn()
        Object.defineProperty(frameElBefore, 'contentWindow', {
          value: { postMessage: postMessageMock },
          configurable: true,
        })
        await (mountedApp.vm as any).toggleDocTodo('todo-1')
        await flushPromises()
        expect(mountedApp.find('.plan-doc-frame').element).toBe(frameElBefore)
        expect((mountedApp.vm as any).currentDocumentToken).toBe(tokenBefore)
        expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({
          type: 'todo-status-updated',
          todoId: 'todo-1',
          status: 'in-progress',
        }), '*')

        // Open Review Notes Panel
        const reviewNotesOverflow = mountedApp.get('[data-test="review-notes-overflow"]')
        await reviewNotesOverflow.trigger('click')
        await mountedApp.get('[data-test="review-notes-overflow-item"]').trigger('click')
        await flushPromises()

        const panel = mountedApp.find('.prt > .prt-panel')
        expect(panel.exists()).toBe(true)

        const input = mountedApp.find('[data-test="review-note-input"]')
        expect(input.exists()).toBe(true)
        expect(input.attributes('disabled')).toBeUndefined()

        // Enter with IME composing does not submit
        await input.setValue('Draft text')
        await input.trigger('keydown', { key: 'Enter', isComposing: true })
        await flushPromises()
        expect(mountedApp.findAll('.prt-panel .prt-note')).toHaveLength(0)

        // Real Enter submits exactly once through the packaged backend child
        await input.trigger('keydown', { key: 'Enter' })
        for (let i = 0; i < 50; i++) {
          await flushPromises()
          if (mountedApp.findAll('.prt-panel .prt-note').length > 0) break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }

        expect(mountedApp.text()).toContain('Draft text')
        expect(mountedApp.findAll('.prt-panel .prt-note')).toHaveLength(1)

        // Drive the controls rather than exposed component methods. A rendered
        // button is not evidence that its edit or confirmation UI is usable —
        // nor is a rendered NOTE evidence that its buttons are: the toolbar
        // keeps them `:disabled` until the write and its follow-up re-read
        // both settle, while the note itself shows as soon as the write
        // returns (PlansApp pushes into the meta object the toolbar renders).
        // VTU's trigger() silently skips a disabled element, so a click in
        // that window does nothing and the edit input never appears. Wait for
        // the control to be enabled, which is what a user sees before clicking.
        const clickWhenEnabled = async (selector: string): Promise<void> => {
          // The wait spans a real round trip through the packaged child, so
          // it gets more than waitFor's 1s default on a slow runner.
          await vi.waitFor(() => {
            expect(mountedApp.get(selector).attributes('disabled')).toBeUndefined()
          }, { timeout: 5_000 })
          await mountedApp.get(selector).trigger('click')
        }
        await clickWhenEnabled('[data-test="edit-n1"]')
        const editInput = mountedApp.get('[data-test="review-note-edit-input"]')
        expect(editInput.attributes('disabled')).toBeUndefined()
        expect.soft(document.activeElement, 'Edit must focus its input').toBe(editInput.element)
        await editInput.setValue('Edited through the UI')
        await mountedApp.get('[data-test="review-note-edit-save"]').trigger('click')
        await vi.waitFor(() => expect(mountedApp.text()).toContain('Edited through the UI'))
        await clickWhenEnabled('[data-test="delete-n1"]')
        await flushPromises()
        expect.soft(document.querySelector('.modal .card.confirm'), 'Delete must render the application confirmation').not.toBeNull()
        expect(readFileSync(planFile, 'utf8')).toContain('Edited through the UI')
        // Cancel via the application service so a red assertion cannot leave
        // an unresolved confirmation leaking into the rest of the suite.
        useNotify().resolveDialog(false)
        await flushPromises()
        await clickWhenEnabled('[data-test="edit-n1"]')
        await mountedApp.get('[data-test="review-note-edit-input"]').setValue('Draft text')
        await mountedApp.get('[data-test="review-note-edit-save"]').trigger('click')
        await vi.waitFor(() => expect(mountedApp.text()).toContain('Draft text'))

        // Review Notes are metadata-only. They must not cause an incidental iframe
        // reread/remount or materialize note markup into the plan body.
        const liveSrcdoc = mountedApp.find('.plan-doc-frame').attributes('srcdoc') ?? ''
        expect(liveSrcdoc).not.toContain('Draft text')
        expect(liveSrcdoc).not.toContain('data-note-id="n1"')
        expect(mountedApp.find('.plan-doc-frame').element).toBe(frameElBefore)
        expect((mountedApp.vm as any).currentDocumentToken).toBe(tokenBefore)

        // Close and reopen panel retains the note
        const toggleBtn = mountedApp.get('.review-notes-toggle')
        await toggleBtn.trigger('click')
        await flushPromises()
        expect(mountedApp.find('.prt-panel').exists()).toBe(false)
        await toggleBtn.trigger('click')
        await flushPromises()
        expect(mountedApp.findAll('.prt-panel .prt-note')).toHaveLength(1)
        expect(mountedApp.text()).toContain('Draft text')

        // Re-read document through the UI retains the note in the panel
        const planRow = mountedApp.find('.plan-row')
        expect(planRow.exists()).toBe(true)
        await planRow.trigger('click')
        for (let i = 0; i < 50; i++) {
          await flushPromises()
          if (mountedApp.findAll('.prt-panel .prt-note').length > 0) break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(mountedApp.findAll('.prt-panel .prt-note')).toHaveLength(1)
        expect(mountedApp.text()).toContain('Draft text')

        // Reading the document again returns metadata persisted by the packaged child.
        const diskContent = readFileSync(planFile, 'utf8')
        expect(diskContent).toContain('Draft text')
        expect(diskContent).toMatch(/"id":\s*"n1"/)
        expect(diskContent).not.toContain('data-note-id="n1"')

        // An anchored manual note crosses the packaged transport unchanged.
        expect(await (mountedApp.vm as any).addReviewNote('Anchor preserved', 'Goals')).toBe(true)
        const diskWithAnchor = readFileSync(planFile, 'utf8')
        expect(diskWithAnchor).toContain('Anchor preserved')
        expect(diskWithAnchor).toMatch(/"anchor":\s*"Goals"/)

        // Verify MCP/Agent ingress capability denial:
        const agentResponse = await manager.executeAgentBackendCallForWorkspace(
          PLANS_PLUGIN_ID,
          tempWorkspace,
          {
            reqId: 'agent-review-note-add-1',
            name: 'plans.review_note_add',
            args: { rel_path: relPath, text: 'Agent injected note', anchor: '' },
          },
        )
        expect(agentResponse).toMatchObject({
          ok: false,
          error: { code: 'CAPABILITY_DENIED' },
        })

        // Zero disk modification from rejected agent call
        const diskAfterDenied = readFileSync(planFile, 'utf8')
        expect(diskAfterDenied).not.toContain('Agent injected note')

        manager.destroyInstance(handle.instanceId)
      } finally {
        app?.unmount()
        rmSync(tempWorkspace, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
