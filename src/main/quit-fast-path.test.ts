import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QUIT_PROGRESS_CHANNEL } from './quit-progress'

// Quitting a session whose backend never started must let the native quit
// proceed: no preventDefault, no staged shutdown overlay. This test drives the
// real `src/main/index.ts` before-quit listener with `electron` mocked, with the
// Host reporting backend "activity" the way a packaged launch does — the
// bundled Plans backend is registered as metadata at startup, which spawns
// nothing but is permanent for the life of the process.

type Listener = (...args: never[]) => unknown

const appListeners: Array<[string, Listener]> = []
const ipcListeners = new Map<string, Listener>()
const windowSends: Array<[string, unknown]> = []
// The quit prompt stays on screen until a test resolves it.
const dialogState = vi.hoisted(() => ({
  prompts: 0,
  focuses: 0,
  answer: null as null | ((value: { response: number; checkboxChecked: boolean }) => void),
}))

// index.ts runs the Linux keyring preflight at import; never spawn dbus-send here.
vi.mock('./linuxKeyring', () => ({ applyLinuxKeyringPreflight: () => false }))
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
    quit: () => {},
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
        focus: () => { dialogState.focuses++ },
        webContents: {
          send: (channel: string, arg: unknown) => { windowSends.push([channel, arg]) },
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
      showMessageBox: () => {
        dialogState.prompts++
        return new Promise((resolve) => { dialogState.answer = resolve })
      },
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    },
    ipcMain: {
      handle: (channel: string, listener: Listener) => { ipcListeners.set(channel, listener) },
      on: (channel: string, listener: Listener) => { ipcListeners.set(channel, listener) },
      removeHandler: () => {},
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

describe('before-quit with nothing running', () => {
  beforeEach(() => {
    appListeners.length = 0
    ipcListeners.clear()
    windowSends.length = 0
    vi.resetModules()
  })

  it('takes the native fast path when only a plugin backend registration exists', { timeout: 60_000 }, async () => {
    // No spy: with hasBackendActivity() reporting live backends only, a launch
    // that merely registered the bundled Plans backend as metadata reports no
    // activity on its own. Stubbing it would weaken the test.
    await import('./index')

    // The renderer owns the confirm-before-quit setting; turn it off so this
    // exercises the non-dialog path.
    const setQuitConfirm = ipcListeners.get('app:setQuitConfirm')
    expect(setQuitConfirm).toBeTypeOf('function')
    ;(setQuitConfirm as (event: unknown, cfg: unknown) => void)({}, { enabled: false })

    const beforeQuit = appListeners.filter(([event]) => event === 'before-quit')
    expect(beforeQuit).toHaveLength(1)
    const preventDefault = vi.fn()
    await (beforeQuit[0]![1] as (event: unknown) => unknown)({ preventDefault })

    expect(preventDefault).not.toHaveBeenCalled()
    expect(windowSends.filter(([channel]) => channel === QUIT_PROGRESS_CHANNEL)).toEqual([])
  })
})

describe('before-quit while the quit prompt is open', () => {
  beforeEach(() => {
    appListeners.length = 0
    ipcListeners.clear()
    windowSends.length = 0
    dialogState.prompts = 0
    dialogState.focuses = 0
    dialogState.answer = null
    vi.resetModules()
  })

  it('a second quit request focuses the open prompt instead of opening another', { timeout: 60_000 }, async () => {
    await import('./index')
    const setQuitConfirm = ipcListeners.get('app:setQuitConfirm') as (event: unknown, cfg: unknown) => void
    setQuitConfirm({}, { enabled: true })
    const beforeQuit = appListeners.find(([event]) => event === 'before-quit')![1] as (event: unknown) => Promise<unknown>

    const first = beforeQuit({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(dialogState.prompts).toBe(1))
    const secondPreventDefault = vi.fn()
    // Not awaited: before the fix this second request opened its own prompt
    // and waited on it.
    void beforeQuit({ preventDefault: secondPreventDefault })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dialogState.prompts).toBe(1)
    expect(secondPreventDefault).toHaveBeenCalled()
    expect(dialogState.focuses).toBe(1)

    // Cancel the one prompt: the app stays open.
    dialogState.answer!({ response: 1, checkboxChecked: false })
    await first
    expect(dialogState.prompts).toBe(1)
  })
})
