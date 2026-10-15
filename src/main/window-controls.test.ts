import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The drawn maximise button follows MAXIMIZE_CHANGED. On Linux a window can
// stop being maximised without an `unmaximize` (VM acceptance 0.2.22: a
// 942x618 window still showing "Restore"), so off macOS the state is
// re-checked on the events that do arrive.

const appEvents = new EventEmitter()
vi.mock('electron', () => ({
  app: { on: (event: string, listener: (...args: unknown[]) => void) => appEvents.on(event, listener) },
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: { handle: () => {} },
}))

const os = vi.hoisted(() => ({ mac: false }))
vi.mock('../shared/osplat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/osplat')>()
  return { ...actual, isMac: () => os.mac }
})

class FakeWindow extends EventEmitter {
  maximized = false
  sent: boolean[] = []
  webContents = {
    isDestroyed: () => false,
    send: (_channel: string, state: boolean) => { this.sent.push(state) },
  }
  isDestroyed(): boolean { return false }
  isMaximized(): boolean { return this.maximized }
}

async function created(): Promise<FakeWindow> {
  const { installWindowControls } = await import('./window-controls')
  installWindowControls()
  const win = new FakeWindow()
  appEvents.emit('browser-window-created', {}, win)
  return win
}

beforeEach(() => {
  appEvents.removeAllListeners()
  vi.resetModules()
})
afterEach(() => { os.mac = false })

describe('window controls maximise state', () => {
  it('corrects a stale Restore when Linux unmaximizes without the event', async () => {
    const win = await created()
    win.maximized = true
    win.emit('maximize')
    expect(win.sent).toEqual([true])

    win.maximized = false // the window manager restored it; no 'unmaximize'
    win.emit('focus')
    expect(win.sent).toEqual([true, false])
  })

  it('re-checks on resize and restore, sending only when the state changed', async () => {
    const win = await created()
    win.emit('resize')
    win.emit('resize')
    expect(win.sent).toEqual([false])
    win.maximized = true
    win.emit('restore')
    win.emit('resize')
    expect(win.sent).toEqual([false, true])
  })

  it('leaves macOS on the maximize/unmaximize/full-screen events alone', async () => {
    os.mac = true
    const win = await created()
    win.maximized = true
    win.emit('focus')
    win.emit('resize')
    win.emit('restore')
    expect(win.sent).toEqual([])
    win.emit('maximize')
    expect(win.sent).toEqual([true])
  })
})
