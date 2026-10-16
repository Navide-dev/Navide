import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { NativeBackendStore } from './plugins/pluginNativeBackendStore'
import type { PluginIpcOptions } from './plugins/pluginIpc'

// Uninstalling a plugin must forget every native-backend decision about it
// (consent, the disable switch, per-workspace file-change grants), so that a
// reinstall asks again. The forget lives in the storage-cleanup hook index.ts
// hands to the plugin IPC; this pins that wiring.

const userDataRoot = mkdtempSync(join(tmpdir(), 'plugin-remove-native-consent-'))
const nativeBackendRoot = join(userDataRoot, 'plugin-native-backends')
const captured = vi.hoisted(() => ({ options: undefined as PluginIpcOptions | undefined }))

// index.ts runs the Linux keyring preflight at import; never spawn dbus-send here.
vi.mock('./linuxKeyring', () => ({ applyLinuxKeyringPreflight: () => false }))
vi.mock('./plugins/pluginIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plugins/pluginIpc')>()
  return {
    ...actual,
    registerPluginIpc: (...args: Parameters<typeof actual.registerPluginIpc>) => {
      captured.options = args[5]
      return actual.registerPluginIpc(...args)
    },
  }
})
vi.mock('electron', () => {
  const app = {
    isPackaged: false,
    getPath: () => userDataRoot,
    setPath: () => {},
    getName: () => 'Navide',
    getVersion: () => '0.0.0-test',
    on: () => {},
    once: () => {},
    setName: () => {},
    // Never resolves: nothing that waits for app-ready runs in this test.
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
    commandLine: { hasSwitch: () => false, appendSwitch: () => {} },
    setAboutPanelOptions: () => {},
  }
  class BrowserWindow {
    static getAllWindows(): unknown[] { return [] }
    static getFocusedWindow(): unknown { return null }
    static fromWebContents(): unknown { return null }
    static fromId(): unknown { return null }
  }
  return {
    app,
    BrowserWindow,
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {}, unhandle: () => {} },
    dialog: {
      showMessageBox: () => Promise.resolve({ response: 0 }),
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
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

afterAll(() => rmSync(userDataRoot, { recursive: true, force: true }))

describe('plugin removal forgets native-backend decisions', () => {
  // Importing the whole src/main/index.ts module graph overruns the default
  // 5s budget once vitest runs other files alongside this one.
  const IMPORT_INDEX_TIMEOUT_MS = 20_000

  it('drops consent, disable and workspace-write grants for the removed plugin only', async () => {
    const seed = new NativeBackendStore(nativeBackendRoot)
    seed.setEnabled(true)
    for (const pluginId of ['acme.demo', 'acme.other']) {
      seed.grantConsent(pluginId, { binarySha256: 'a'.repeat(64), permissionsKey: '{}', packageVersion: '1.0.0' })
      seed.setWorkspaceWrite(pluginId, '/workspace', true)
    }
    seed.setDisabled('acme.demo', true)

    await import('./index')
    const cleanup = captured.options?.cleanupPluginStorage
    expect(cleanup, 'index.ts gives the plugin IPC no storage cleanup hook').toBeTypeOf('function')

    await cleanup!('acme.demo')

    const reloaded = new NativeBackendStore(nativeBackendRoot)
    expect(reloaded.record('acme.demo')).toEqual({})
    expect(reloaded.record('acme.other')).toMatchObject({
      consent: { packageVersion: '1.0.0' },
      workspaceWrite: ['/workspace'],
    })
    // The global switch is the user's, not the plugin's.
    expect(reloaded.isEnabled()).toBe(true)
  }, IMPORT_INDEX_TIMEOUT_MS)

  it('hands the plugin IPC the native backend data root, so removal can delete it', async () => {
    await import('./index')
    expect(captured.options?.nativeBackendDataRoot).toBe(join(nativeBackendRoot, 'data'))
  }, IMPORT_INDEX_TIMEOUT_MS)
})
