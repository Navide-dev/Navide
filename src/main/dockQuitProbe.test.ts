import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A window hosting embedded AI panels ends them when it closes, except while
// the app quits (the panels restore next launch). The probe that says "the app
// is quitting" must fall back to false when a plugin vetoes the quit after the
// confirm dialog said Quit — otherwise every later window close leaves its
// panels running. `quitConfirmed` itself keeps its meaning (the main window's
// prompt is not shown again). Drives the real `src/main/index.ts` before-quit
// listener with `electron` mocked, as quit-fast-path.test.ts does.

type Listener = (...args: never[]) => unknown

const appListeners: Array<[string, Listener]> = []
const ipcListeners = new Map<string, Listener>()
const windowSends: Array<[string, unknown]> = []
const dialogState = vi.hoisted(() => ({ response: 0, prompts: 0, lastPrompt: null as { title?: string } | null, notices: [] as Array<{ message?: string; detail?: string }> }))

// The last-window quit only exists off macOS; null keeps the host's answer.
const osState = vi.hoisted(() => ({ mac: null as boolean | null }))
vi.mock('../shared/osplat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/osplat')>()
  return { ...actual, isMac: () => osState.mac ?? actual.isMac() }
})
// app.quit() re-emits before-quit in Electron; here the test drives that
// re-entry itself, so only count the calls.
const appState = vi.hoisted(() => ({ quits: 0 }))
// index.ts runs the Linux keyring preflight at import; never spawn dbus-send here.
vi.mock('./linuxKeyring', () => ({ applyLinuxKeyringPreflight: () => false }))
// The fake window below is never registered as a Navide window (whenReady never
// resolves), so pass every window through: this file checks that a restart is
// broadcast, backendIpc.test.ts checks who it goes to.
vi.mock('./backendIpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backendIpc')>()),
  backendChangedTargets: (windows: unknown[]) => windows,
}))
// A cancelled quit after the teardown restarts the backend; record it in place
// of spawning one.
const backendState = vi.hoisted(() => ({ events: [] as string[] }))
vi.mock('./backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./backend')>()
  return {
    ...actual,
    startBackend: async () => {
      backendState.events.push('backend started')
      const { EventEmitter } = await import('node:events')
      return {
        host: '127.0.0.1', port: 1, shell: '/bin/sh', hostSessionToken: 't', dataDir: '/tmp',
        proc: new EventEmitter(), stop: async () => {},
      }
    },
  }
})
vi.mock('electron', () => {
  const app = {
    isPackaged: false,
    getPath: () => '/tmp/navide-quit-fast-path-test',
    setPath: () => {},
    getName: () => 'Navide',
    getVersion: () => '0.0.0-test',
    on: (event: string, listener: Listener) => { appListeners.push([event, listener]) },
    once: () => {},
    setName: () => {},
    quit: () => { appState.quits++ },
    // Never resolves: no window, no backend — the state this fast path is for.
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
    commandLine: { hasSwitch: () => false, appendSwitch: () => {} },
    setAboutPanelOptions: () => {},
  }
  class BrowserWindow {
    static getAllWindows(): unknown[] {
      return [{
        isDestroyed: () => false,
        destroy: () => {},
        getTitle: () => 'Plans',
        id: 1,
        isFocused: () => true,
        webContents: {
          send: (channel: string, arg: unknown) => {
            windowSends.push([channel, arg])
            if (channel === 'app:quitProgress') backendState.events.push(`quit stage ${String(arg)}`)
          },
        },
      }]
    }
    static getFocusedWindow(): unknown { return null }
    static fromWebContents(): unknown { return null }
    static fromId(): unknown { return null }
  }
  return {
    app,
    BrowserWindow,
    // New frame-asset registration runs at module evaluation; tests only need it inert.
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {}, unhandle: () => {} },
    dialog: {
      showMessageBox: (_win: unknown, opts?: { buttons?: unknown[] }) => {
        // Count only the quit prompt (two buttons), not the refusal notice.
        const options = (opts ?? _win) as { buttons?: unknown[] }
        if (options?.buttons?.length === 2) { dialogState.prompts++; dialogState.lastPrompt = options as { title?: string } }
        else {
          dialogState.notices.push(options as { message?: string; detail?: string })
          backendState.events.push('notice')
        }
        return Promise.resolve({ response: dialogState.response, checkboxChecked: false })
      },
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    },
    ipcMain: {
      handle: (channel: string, listener: Listener) => { ipcListeners.set(channel, listener) },
      on: (channel: string, listener: Listener) => { ipcListeners.set(channel, listener) },
      removeHandler: () => {},
      removeListener: () => {},
      off: () => {},
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    Notification: class { static isSupported(): boolean { return false } show(): void {} },
    powerMonitor: { on: () => {} },
    safeStorage: { isEncryptionAvailable: () => false },
    session: {
      defaultSession: { webRequest: { onHeadersReceived: () => {} } },
      fromPartition: () => ({}),
    },
    shell: { openExternal: () => Promise.resolve(), showItemInFolder: () => {} },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({ popup: () => {} }) },
  }
})

type BeforeQuit = (event: { preventDefault: () => void }) => Promise<unknown>

async function boot(): Promise<{ beforeQuit: BeforeQuit; appQuitting: () => boolean }> {
  await import('./index')
  const { frontendPluginManager } = await import('./plugins/frontendPluginManager')
  // A window with a close participant (a plugin holding a draft) that refuses.
  vi.spyOn(frontendPluginManager, 'hasWindowCloseParticipants').mockReturnValue(true)
  vi.spyOn(frontendPluginManager, 'prepareWindowClose').mockResolvedValue(
    { ok: false, reason: 'refused' } as never,
  )
  const setQuitConfirm = ipcListeners.get('app:setQuitConfirm') as (event: unknown, cfg: unknown) => void
  setQuitConfirm({}, { enabled: true })
  const beforeQuit = appListeners.filter(([event]) => event === 'before-quit')
  expect(beforeQuit).toHaveLength(1)
  return {
    beforeQuit: beforeQuit[0]![1] as unknown as BeforeQuit,
    appQuitting: () => (frontendPluginManager as unknown as { appQuitting: () => boolean }).appQuitting(),
  }
}

/** Whether closing a window would end its embedded AI panels right now: both
 *  places the probe gates — ending the window's dock surface and releasing an
 *  AI terminal's storage owner — get past it. */
async function panelEndingRuns(): Promise<{ endDockSurface: boolean; releaseAiTerminalOwner: boolean }> {
  const { frontendPluginManager } = await import('./plugins/frontendPluginManager')
  const manager = frontendPluginManager as unknown as {
    ensureBackend: () => unknown
    terminalStorageHandler: unknown
    terminalStorageRequest: () => Promise<unknown>
    releaseAiTerminalOwner: (plugin: unknown, identity: { resumeKey: string }) => void
  }
  const ensureBackend = vi.spyOn(manager, 'ensureBackend').mockReturnValue(null)
  const storageRequest = vi.spyOn(manager, 'terminalStorageRequest').mockResolvedValue(undefined)
  const handler = manager.terminalStorageHandler
  manager.terminalStorageHandler = () => undefined
  try {
    frontendPluginManager.endDockSurface('plans', '/ws')
    manager.releaseAiTerminalOwner({}, { resumeKey: 'k' })
    return {
      endDockSurface: ensureBackend.mock.calls.length > 0,
      releaseAiTerminalOwner: storageRequest.mock.calls.length > 0,
    }
  } finally {
    manager.terminalStorageHandler = handler
    ensureBackend.mockRestore()
    storageRequest.mockRestore()
  }
}

describe('embedded AI panels after a cancelled quit', () => {
  beforeEach(() => {
    appListeners.length = 0
    ipcListeners.clear()
    windowSends.length = 0
    dialogState.response = 0
    dialogState.prompts = 0
    dialogState.notices.length = 0
    vi.resetModules()
  })

  it('a plugin veto after the prompt said Quit leaves the app not quitting', { timeout: 60_000 }, async () => {
    const { beforeQuit, appQuitting } = await boot()
    const { WindowRegistry } = await import('./window-registry')
    const clearCleanExit = vi.spyOn(WindowRegistry.prototype, 'clearCleanExit')
    expect(appQuitting()).toBe(false)

    // Cmd+Q → prompt → Quit: the listener re-enters through app.quit().
    await beforeQuit({ preventDefault: vi.fn() })
    expect(dialogState.prompts).toBe(1)
    // The re-entry: a plugin refuses to let its window go.
    const preventDefault = vi.fn()
    await beforeQuit({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()

    // The app stays open, so closing a panel's window must end its panels.
    expect(appQuitting()).toBe(false)
    // The same reset as any cancelled quit, but the refusal notice already
    // told the user: no second "did not quit" notice on top of it.
    expect(clearCleanExit).toHaveBeenCalled()
    expect(dialogState.notices).toHaveLength(1)

    // quitConfirmed keeps its meaning: the next Cmd+Q does not prompt again.
    await beforeQuit({ preventDefault: vi.fn() })
    expect(dialogState.prompts).toBe(1)
    expect(appQuitting()).toBe(false)
  })

  it('a quit cancelled at the prompt leaves the app not quitting', { timeout: 60_000 }, async () => {
    const { beforeQuit, appQuitting } = await boot()
    dialogState.response = 1
    await beforeQuit({ preventDefault: vi.fn() })
    expect(dialogState.prompts).toBe(1)
    expect(appQuitting()).toBe(false)
  })

  it('titles the quit prompt Navide, not the package name Windows/Linux would show', { timeout: 60_000 }, async () => {
    const { beforeQuit } = await boot()
    dialogState.response = 1
    await beforeQuit({ preventDefault: vi.fn() })
    expect(dialogState.lastPrompt?.title).toBe('Navide')
  })

  it('a plugin veto on a quit without the prompt leaves the app not quitting', { timeout: 60_000 }, async () => {
    const { beforeQuit, appQuitting } = await boot()
    const setQuitConfirm = ipcListeners.get('app:setQuitConfirm') as (event: unknown, cfg: unknown) => void
    setQuitConfirm({}, { enabled: false })
    const preventDefault = vi.fn()
    await beforeQuit({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(dialogState.prompts).toBe(0)
    expect(appQuitting()).toBe(false)
    expect(await panelEndingRuns()).toEqual({ endDockSurface: true, releaseAiTerminalOwner: true })
  })

  it('a second Cmd+Q while the first is being prepared leaves the flags to the first', { timeout: 60_000 }, async () => {
    const { beforeQuit, appQuitting } = await boot()
    const { frontendPluginManager } = await import('./plugins/frontendPluginManager')
    let refuse: (value: never) => void = () => {}
    vi.mocked(frontendPluginManager.prepareWindowClose).mockImplementation(
      () => new Promise((resolve) => { refuse = resolve as (value: never) => void }),
    )
    // Prompt → Quit, then the re-entry starts preparing the windows.
    await beforeQuit({ preventDefault: vi.fn() })
    const first = beforeQuit({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(frontendPluginManager.prepareWindowClose).toHaveBeenCalled())
    // Another Cmd+Q lands mid-preparation: held back, flags untouched.
    const second = vi.fn()
    await beforeQuit({ preventDefault: second })
    expect(second).toHaveBeenCalled()
    expect(appQuitting()).toBe(true)

    refuse({ ok: false, reason: 'refused' } as never)
    await first
    expect(appQuitting()).toBe(false)
    expect(await panelEndingRuns()).toEqual({ endDockSurface: true, releaseAiTerminalOwner: true })
  })

  it('reports quitting while the confirmed quit is being prepared', { timeout: 60_000 }, async () => {
    const { beforeQuit, appQuitting } = await boot()
    const { frontendPluginManager } = await import('./plugins/frontendPluginManager')
    let seen: boolean | null = null
    vi.mocked(frontendPluginManager.prepareWindowClose).mockImplementation(async () => {
      seen = appQuitting()
      return { ok: true, id: 'w' } as never
    })
    vi.spyOn(frontendPluginManager, 'commitWindowClose').mockImplementation(() => undefined as never)
    await beforeQuit({ preventDefault: vi.fn() })
    await beforeQuit({ preventDefault: vi.fn() })
    expect(seen).toBe(true)
    expect(appQuitting()).toBe(true)
  })
})

// autoUpdater.quitAndInstall() emits before-quit, which marks the windows
// prepared; an install that then fails or times out leaves the app running, so
// it must clear that flag along with dockQuitInProgress — else every later
// window close keeps its panels running. Source-scanned because the updater
// hooks are wired inside app.whenReady(), which this harness never resolves.
describe('embedded AI panels after an abandoned update install', () => {
  it('clears both quit flags the probe reads', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
    const hook = /onInstallAbandoned: \(\) => \{([^}]*)\}/.exec(mainSource)
    expect(hook, 'index.ts wires no onInstallAbandoned hook').not.toBeNull()
    expect(hook![1]).toContain('dockQuitInProgress = false')
    expect(hook![1]).toContain('quittingWindowsPrepared = false')
  })
})

// Past before-quit, Electron closes every window and silently cancels the quit
// when one of those closes is prevented (a beforeunload, or a close participant
// that appeared after the quit was prepared). No event says so: will-quit just
// never comes. The flags must not stay set — every later window close would
// leave its panels running — and the user must learn why the app did not quit.
describe('embedded AI panels after a quit cancelled while closing windows', () => {
  beforeEach(() => {
    appListeners.length = 0
    ipcListeners.clear()
    windowSends.length = 0
    dialogState.response = 0
    dialogState.prompts = 0
    dialogState.notices.length = 0
    vi.resetModules()
  })

  async function bootNativeQuit(): Promise<{
    beforeQuit: BeforeQuit; willQuit: () => void; quit: () => void; appQuitting: () => boolean
  }> {
    await import('./index')
    const { frontendPluginManager } = await import('./plugins/frontendPluginManager')
    vi.spyOn(frontendPluginManager, 'hasWindowCloseParticipants').mockReturnValue(false)
    vi.spyOn(frontendPluginManager, 'hasBackendActivity').mockReturnValue(false)
    const setQuitConfirm = ipcListeners.get('app:setQuitConfirm') as (event: unknown, cfg: unknown) => void
    setQuitConfirm({}, {
      enabled: false,
      cancelledMessage: 'Navide did not quit',
      cancelledDetail: 'Stopped by: {windows}.',
      cancelledUnknownWindow: 'a window that has closed since',
    })
    const willQuit = appListeners.filter(([event]) => event === 'will-quit')
    const quit = appListeners.filter(([event]) => event === 'quit')
    return {
      beforeQuit: appListeners.find(([event]) => event === 'before-quit')![1] as unknown as BeforeQuit,
      willQuit: () => { for (const [, listener] of willQuit) (listener as () => void)() },
      quit: () => { for (const [, listener] of quit) (listener as () => void)() },
      appQuitting: () => (frontendPluginManager as unknown as { appQuitting: () => boolean }).appQuitting(),
    }
  }

  it('clears the flags and names the window when will-quit never comes', { timeout: 60_000 }, async () => {
    const { beforeQuit, appQuitting } = await bootNativeQuit()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const preventDefault = vi.fn()
      await beforeQuit({ preventDefault })
      expect(preventDefault).not.toHaveBeenCalled()
      expect(appQuitting()).toBe(true)

      expect(await panelEndingRuns()).toEqual({ endDockSurface: false, releaseAiTerminalOwner: false })

      await vi.advanceTimersByTimeAsync(10_000)
      expect(appQuitting()).toBe(false)
      expect(await panelEndingRuns()).toEqual({ endDockSurface: true, releaseAiTerminalOwner: true })
      expect(dialogState.notices).toEqual([
        expect.objectContaining({ title: 'Navide', message: 'Navide did not quit', detail: 'Stopped by: Plans.' }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts the backend and lifts the shutdown screen when the teardown already ran', { timeout: 60_000 }, async () => {
    const { beforeQuit, appQuitting } = await bootNativeQuit()
    const { frontendPluginManager } = await import('./plugins/frontendPluginManager')
    backendState.events.length = 0
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // First pass: a live plugin backend sends the quit through the teardown,
      // which stops the backend and puts up the shutdown screen.
      vi.spyOn(frontendPluginManager, 'reopenBackendPlugins').mockImplementation(() => {
        backendState.events.push('plugin backends reopened')
      })
      vi.mocked(frontendPluginManager.hasBackendActivity).mockReturnValue(true)
      const teardown = vi.fn()
      await beforeQuit({ preventDefault: teardown })
      expect(teardown).toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      // The teardown's app.quit() re-enters with nothing left to stop.
      vi.mocked(frontendPluginManager.hasBackendActivity).mockReturnValue(false)
      await beforeQuit({ preventDefault: vi.fn() })

      // Closing the windows cancels the quit: will-quit never comes.
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => expect(backendState.events).toContain('notice'))
      expect(backendState.events).toEqual([
        'quit stage saving',
        'quit stage stopping',
        'quit stage closing',
        'backend started',
        'plugin backends reopened',
        'quit stage cancelled',
        'notice',
      ])
      // The renderers reconnect on this, as after any backend restart.
      expect(windowSends).toContainEqual(['backend:changed', expect.objectContaining({ status: 'ready' })])
      expect(appQuitting()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // A will-quit listener (ours or anyone's) can still prevent the quit, and
  // then 'quit' never comes. Only 'quit' says the app is really going down.
  it('clears the flags when will-quit comes but the quit is prevented there', { timeout: 60_000 }, async () => {
    const { beforeQuit, willQuit, appQuitting } = await bootNativeQuit()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await beforeQuit({ preventDefault: vi.fn() })
      willQuit()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(appQuitting()).toBe(false)
      expect(await panelEndingRuns()).toEqual({ endDockSurface: true, releaseAiTerminalOwner: true })
    } finally {
      vi.useRealTimers()
    }
  })

  // The AI terminal storage owners and the file picker host take down their
  // IPC listeners when they are disposed, for good. A quit stopped at
  // will-quit keeps the app running, so they must still be there.
  it('keeps the terminal storage owners and the file picker up until the quit is real', { timeout: 60_000 }, async () => {
    const { beforeQuit, willQuit, quit } = await bootNativeQuit()
    const { TerminalStorageOwnerService } = await import('./terminalStorageOwner')
    const { FilePickerHostService } = await import('./filePicker')
    const ownersDisposed = vi.spyOn(TerminalStorageOwnerService.prototype, 'dispose')
    const pickerDisposed = vi.spyOn(FilePickerHostService.prototype, 'dispose')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await beforeQuit({ preventDefault: vi.fn() })
      willQuit()
      expect(ownersDisposed).not.toHaveBeenCalled()
      expect(pickerDisposed).not.toHaveBeenCalled()
      quit()
      expect(ownersDisposed).toHaveBeenCalledTimes(1)
      expect(pickerDisposed).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a quit that reached quit alone', { timeout: 60_000 }, async () => {
    const { beforeQuit, willQuit, quit, appQuitting } = await bootNativeQuit()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await beforeQuit({ preventDefault: vi.fn() })
      willQuit()
      quit()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(appQuitting()).toBe(true)
      expect(dialogState.notices).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

// Off macOS, closing the last window quits the app, so the quit prompt runs
// from that window's close. A confirmed quit must then go the way Cmd+Q does:
// every close participant gets its say before anything is torn down. Stopping
// the backend first killed every PTY, shut the plugin backends and left the
// shutdown screen up when a participant then refused.
describe('the last window closing quits like Cmd+Q (Linux, Windows)', () => {
  beforeEach(() => {
    appListeners.length = 0
    ipcListeners.clear()
    windowSends.length = 0
    dialogState.response = 0
    dialogState.prompts = 0
    dialogState.notices.length = 0
    backendState.events.length = 0
    appState.quits = 0
    osState.mac = false
    vi.resetModules()
  })
  afterEach(() => {
    osState.mac = null
  })

  async function bootLastWindow(): Promise<{
    beforeQuit: BeforeQuit
    closeLastWindow: () => ReturnType<typeof vi.fn>
    quit: () => void
    markCleanExit: ReturnType<typeof vi.spyOn>
    closeBackendPlugins: ReturnType<typeof vi.spyOn>
    appQuitting: () => boolean
  }> {
    const booted = await boot()
    const { frontendPluginManager } = await import('./plugins/frontendPluginManager')
    const { WindowRegistry } = await import('./window-registry')
    const closeHandlers: Array<(event: unknown) => void> = []
    const win = new Proxy({}, {
      get: (_target, key) => key === 'on'
        ? (event: string, handler: (event: unknown) => void) => { if (event === 'close') closeHandlers.push(handler) }
        // App Lock hooks the window's own webContents for keys (appLockOverlay.watch).
        : key === 'webContents' ? { on: () => undefined }
        : () => undefined,
    })
    for (const [event, listener] of appListeners) {
      if (event === 'browser-window-created') (listener as unknown as (e: unknown, w: unknown) => void)({}, win)
    }
    expect(closeHandlers).toHaveLength(1)
    const quitListeners = appListeners.filter(([event]) => event === 'quit')
    backendState.events.length = 0
    return {
      ...booted,
      closeLastWindow: () => {
        const preventDefault = vi.fn()
        closeHandlers[0]!({ preventDefault })
        return preventDefault
      },
      quit: () => { for (const [, listener] of quitListeners) (listener as () => void)() },
      markCleanExit: vi.spyOn(WindowRegistry.prototype, 'markCleanExit'),
      closeBackendPlugins: vi.spyOn(frontendPluginManager, 'closeBackendPlugins'),
    }
  }

  it('a participant refusing leaves the backend, the plugin backends and the windows up', { timeout: 60_000 }, async () => {
    const { beforeQuit, closeLastWindow, markCleanExit, closeBackendPlugins, appQuitting } = await bootLastWindow()
    expect(closeLastWindow()).toHaveBeenCalled()
    await vi.waitFor(() => expect(appState.quits).toBe(1))
    expect(dialogState.prompts).toBe(1)

    // app.quit() re-enters before-quit; the plugin refuses to let its window go.
    const preventDefault = vi.fn()
    await beforeQuit({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()

    // Nothing was torn down: no shutdown screen, no backend or plugin backend
    // stopped, and the run is not marked as a clean exit. The refusal notice
    // is the only thing the user sees.
    expect(backendState.events).toEqual(['notice'])
    expect(closeBackendPlugins).not.toHaveBeenCalled()
    expect(markCleanExit).not.toHaveBeenCalled()
    expect(appQuitting()).toBe(false)
  })

  it('a confirmed quit tears down once, in the same order, and marks a clean exit', { timeout: 60_000 }, async () => {
    const { beforeQuit, closeLastWindow, quit, markCleanExit, appQuitting } = await bootLastWindow()
    const { frontendPluginManager } = await import('./plugins/frontendPluginManager')
    vi.mocked(frontendPluginManager.prepareWindowClose).mockResolvedValue({ ok: true, id: 'w' } as never)
    vi.spyOn(frontendPluginManager, 'commitWindowClose').mockImplementation(() => undefined as never)
    const hasBackendActivity = vi.spyOn(frontendPluginManager, 'hasBackendActivity').mockReturnValue(true)

    closeLastWindow()
    await vi.waitFor(() => expect(appState.quits).toBe(1))
    // Re-entry: the participants agree, and the quit goes round once more.
    await beforeQuit({ preventDefault: vi.fn() })
    expect(appState.quits).toBe(2)
    // Re-entry: the teardown, ending in app.quit().
    await beforeQuit({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(appState.quits).toBe(3))
    // Its re-entry finds nothing left to stop and lets the native quit go.
    hasBackendActivity.mockReturnValue(false)
    const preventDefault = vi.fn()
    await beforeQuit({ preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
    quit()

    expect(backendState.events).toEqual(['quit stage saving', 'quit stage stopping', 'quit stage closing'])
    expect(markCleanExit).toHaveBeenCalled()
    expect(appQuitting()).toBe(true)
  })
})
