// IPC for the fn (🌐) key helper; see fn-key-helper.ts for the service itself.
import { app, ipcMain, shell, type WebContents } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isMac } from '../shared/osplat'
import { logMain } from './main-log'
import { FnKeyService, parseFnKeyLine, type FnKeyLine } from './fn-key-helper'

const HELPER_NAME = 'navide-fn-key'
const INPUT_MONITORING_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'
// Keyboard settings, where "Press 🌐 key to" lives.
const KEYBOARD_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension'

/** Packaged: Contents/Resources/bin; checkout: build/fn-key (pnpm build:fn-key). */
function helperPath(): string | null {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'bin', HELPER_NAME)
    : join(app.getAppPath(), 'build', 'fn-key', HELPER_NAME)
  return existsSync(path) ? path : null
}

function query(path: string, arg: '--check' | '--request'): Promise<FnKeyLine | null> {
  return new Promise((resolve) => {
    execFile(path, [arg], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        const why = err.killed ? 'timed out after 60 s' : err.message
        logMain(`fn-key: ${arg} failed: ${why}${stderr ? ` (${String(stderr).trim()})` : ''}`)
      }
      const line = String(stdout ?? '').split('\n').find((l) => l.trim())
      resolve(line ? parseFnKeyLine(line) : null)
    })
  })
}

/**
 * Registers the voice:fn-key-* handlers. `isMainRenderer` limits subscribing
 * to a main window's own renderer (where voice input lives). Returns the
 * service so the quit path can stop the helper.
 */
export function registerFnKeyIpc(isMainRenderer: (wc: WebContents) => boolean): FnKeyService {
  const service = new FnKeyService({
    supported: isMac(),
    helperPath,
    // stdin stays a pipe: the helper exits when it closes (i.e. when we die).
    spawn: (path, args) => spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'] }),
    query,
    log: logMain,
  })
  const subscribedIds = new Set<number>()

  ipcMain.handle('voice:fn-key-subscribe', (event) => {
    const wc = event.sender
    if (!isMainRenderer(wc)) return service.getStatus()
    const id = wc.id
    // One cleanup per webContents, however often it re-subscribes.
    if (!subscribedIds.has(id)) {
      subscribedIds.add(id)
      wc.once('destroyed', () => {
        subscribedIds.delete(id)
        service.drop(id)
      })
      // A reload starts the renderer over without releasing what it held.
      wc.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) service.drop(id)
      })
    }
    return service.subscribe({
      id,
      send: (channel, payload) => {
        if (!wc.isDestroyed()) wc.send(channel, payload)
      },
    })
  })
  ipcMain.handle('voice:fn-key-unsubscribe', (event) => {
    service.unsubscribe(event.sender.id)
  })
  ipcMain.handle('voice:fn-key-status', () => service.getStatus())
  ipcMain.handle('voice:fn-key-request-permission', () => service.requestPermission())
  ipcMain.handle('voice:fn-key-open-settings', async (_event, which: 'input-monitoring' | 'keyboard') => {
    if (!isMac()) return { ok: false }
    await shell.openExternal(which === 'keyboard' ? KEYBOARD_SETTINGS_URL : INPUT_MONITORING_URL)
    return { ok: true }
  })
  return service
}
