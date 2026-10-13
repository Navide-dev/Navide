import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (...args: unknown[]) => void

const electron = vi.hoisted(() => {
  const ipcListeners = new Map<string, Set<Listener>>()
  let nextWebContentsId = 100

  class FakeWebContents {
    static instances: FakeWebContents[] = []
    readonly id = nextWebContentsId++
    readonly mainFrame = { parent: null }
    readonly loadCalls: Array<{ method: 'loadFile' | 'loadURL'; value: string; options?: unknown }> = []
    readonly sendCalls: Array<{ channel: string; args: unknown[] }> = []
    readonly listeners = new Map<string, Set<Listener>>()
    windowOpenHandler: (() => unknown) | undefined
    destroyed = false

    constructor() {
      FakeWebContents.instances.push(this)
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? new Set<Listener>()
      listeners.add(listener)
      this.listeners.set(event, listeners)
      return this
    }

    once(event: string, listener: Listener): this {
      const once = (...args: unknown[]) => {
        this.listeners.get(event)?.delete(once)
        listener(...args)
      }
      return this.on(event, once)
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
    }

    loadFile(value: string, options?: unknown): Promise<void> {
      this.loadCalls.push({ method: 'loadFile', value, options })
      return Promise.resolve()
    }

    loadURL(value: string, options?: unknown): Promise<void> {
      this.loadCalls.push({ method: 'loadURL', value, options })
      return Promise.resolve()
    }

    send(channel: string, ...args: unknown[]): void {
      this.sendCalls.push({ channel, args })
    }

    setWindowOpenHandler(handler: () => unknown): void {
      this.windowOpenHandler = handler
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    close(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('destroyed')
    }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = []
    readonly webContents = new FakeWebContents()
    readonly options: unknown

    constructor(options: unknown) {
      this.options = options
      FakeWebContentsView.instances.push(this)
    }
  }

  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []

    constructor() {
      FakeBrowserWindow.instances.push(this)
    }
  }

  return {
    WebContentsView: FakeWebContentsView,
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      on(channel: string, listener: Listener): void {
        const listeners = ipcListeners.get(channel) ?? new Set<Listener>()
        listeners.add(listener)
        ipcListeners.set(channel, listeners)
      },
      removeListener(channel: string, listener: Listener): void {
        ipcListeners.get(channel)?.delete(listener)
      },
    },
    reset(): void {
      ipcListeners.clear()
      FakeWebContents.instances.length = 0
      FakeWebContentsView.instances.length = 0
      FakeBrowserWindow.instances.length = 0
      nextWebContentsId = 100
    },
    emit(channel: string, ...args: unknown[]): void {
      for (const listener of [...(ipcListeners.get(channel) ?? [])]) listener(...args)
    },
    FakeWebContents,
    FakeWebContentsView,
    FakeBrowserWindow,
  }
})

vi.mock('electron', () => electron)

import { TerminalStorageOwnerService } from './terminalStorageOwner'
import type { TerminalStorageOwnerRequest } from '../shared/terminalStorageOwner'

const resumeKey = 'deadbeef-editor-ai-terminal'

function readyEvent(sender: InstanceType<typeof electron.FakeWebContents>, frame = sender.mainFrame): object {
  return { sender, senderFrame: frame }
}

function request(): TerminalStorageOwnerRequest {
  return { operation: 'read', resumeKey }
}

describe('TerminalStorageOwnerService', () => {
  beforeEach(() => {
    electron.reset()
  })

  it('preserves the legacy file path and passes only the terminal owner query', async () => {
    const service = new TerminalStorageOwnerService({
      preloadPath: '/app/terminal-owner-preload.js',
      entry: () => ({ filePath: '/app/legacy-mini-ide/index.html' }),
    })
    try {
      const pending = service.execute('legacy-mini-ide', request())
      const view = electron.FakeWebContentsView.instances[0]
      expect(view.options).toEqual({
        webPreferences: {
          preload: '/app/terminal-owner-preload.js',
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      expect(view.webContents.loadCalls).toEqual([{
        method: 'loadFile',
        value: '/app/legacy-mini-ide/index.html',
        options: { query: { terminal_owner: '1' } },
      }])
      electron.emit('terminal-owner:ready', readyEvent(view.webContents))
      await Promise.resolve()
      const sent = view.webContents.sendCalls[0]
      electron.emit('terminal-owner:response', readyEvent(view.webContents), {
        id: sent.args[0], ok: true, value: null,
      })
      await expect(pending).resolves.toBeNull()
    } finally {
      service.dispose()
    }
  })

  it('keeps the Host dev URL path and existing query while adding the owner query', async () => {
    const service = new TerminalStorageOwnerService({
      preloadPath: '/app/terminal-owner-preload.js',
      entry: () => ({ url: 'http://127.0.0.1:5173/plugins/mini-ide/index.html?workspace=alpha' }),
    })
    try {
      const pending = service.execute('host', request())
      const view = electron.FakeWebContentsView.instances[0]
      expect(view.webContents.loadCalls).toEqual([{
        method: 'loadURL',
        value: 'http://127.0.0.1:5173/plugins/mini-ide/index.html?workspace=alpha&terminal_owner=1',
      }])
      expect(view.options).not.toHaveProperty('webPreferences.partition')
      electron.emit('terminal-owner:ready', readyEvent(view.webContents))
      await Promise.resolve()
      const sent = view.webContents.sendCalls[0]
      electron.emit('terminal-owner:response', readyEvent(view.webContents), {
        id: sent.args[0], ok: true, value: null,
      })
      await expect(pending).resolves.toBeNull()
    } finally {
      service.dispose()
    }
  })

  it('creates an unattached storage owner without creating a user BrowserWindow', async () => {
    const service = new TerminalStorageOwnerService({
      preloadPath: '/app/terminal-owner-preload.js',
      entry: () => ({ filePath: '/app/legacy-mini-ide/index.html' }),
    })
    try {
      const pending = service.execute('legacy-mini-ide', request())
      const view = electron.FakeWebContentsView.instances[0]
      expect(electron.FakeBrowserWindow.instances).toHaveLength(0)
      electron.emit('terminal-owner:ready', readyEvent(view.webContents))
      await Promise.resolve()
      const sent = view.webContents.sendCalls[0]
      electron.emit('terminal-owner:response', readyEvent(view.webContents), {
        id: sent.args[0], ok: true, value: null,
      })
      await expect(pending).resolves.toBeNull()
      expect(view.webContents.isDestroyed()).toBe(false)
    } finally {
      service.dispose()
    }
  })

  it('denies navigation and window.open from the owner view', () => {
    const service = new TerminalStorageOwnerService({
      preloadPath: '/app/terminal-owner-preload.js',
      entry: () => ({ filePath: '/app/legacy-mini-ide/index.html' }),
    })
    try {
      const pending = service.execute('legacy-mini-ide', request())
      const view = electron.FakeWebContentsView.instances[0]
      expect(view.webContents.windowOpenHandler?.()).toEqual({ action: 'deny' })
      const event = { preventDefault: vi.fn() }
      view.webContents.emit('will-navigate', event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
      // Keep the owner startup promise from holding this test open.
      view.webContents.close()
      return expect(pending).rejects.toThrow('Terminal storage owner closed')
    } finally {
      service.dispose()
    }
  })

  it('ignores responses from another sender and from a subframe', async () => {
    const service = new TerminalStorageOwnerService({
      preloadPath: '/app/terminal-owner-preload.js',
      entry: () => ({ filePath: '/app/legacy-mini-ide/index.html' }),
    })
    try {
      const pending = service.execute('legacy-mini-ide', request())
      const view = electron.FakeWebContentsView.instances[0]
      electron.emit('terminal-owner:ready', readyEvent(view.webContents))
      await Promise.resolve()
      const sent = view.webContents.sendCalls[0]
      const other = new electron.FakeWebContents()
      electron.emit('terminal-owner:response', readyEvent(other), { id: sent.args[0], ok: true, value: null })
      electron.emit('terminal-owner:response', { sender: view.webContents, senderFrame: { parent: {} } }, {
        id: sent.args[0], ok: true, value: null,
      })
      let settled = false
      void pending.then(() => { settled = true }, () => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      electron.emit('terminal-owner:response', readyEvent(view.webContents), {
        id: sent.args[0], ok: true, value: null,
      })
      await expect(pending).resolves.toBeNull()
    } finally {
      service.dispose()
    }
  })

  it('survives an owner view whose webContents is gone during an app quit', async () => {
    const service = new TerminalStorageOwnerService({
      preloadPath: '/app/terminal-owner-preload.js',
      entry: () => ({ filePath: '/app/legacy-mini-ide/index.html' }),
    })
    const first = service.execute('legacy-mini-ide', request())
    void first.catch(() => {})
    const stale = electron.FakeWebContentsView.instances[0] as unknown as { webContents: unknown }
    // Electron leaves view.webContents undefined once the view is torn down.
    stale.webContents = undefined
    expect(() => electron.emit('terminal-owner:ready', readyEvent(new electron.FakeWebContents()))).not.toThrow()
    const second = service.execute('legacy-mini-ide', request())
    void second.catch(() => {})
    expect(electron.FakeWebContentsView.instances).toHaveLength(2)
    expect(() => service.dispose()).not.toThrow()
  })

  it('checks canDispatch before creating an owner and again after readiness', async () => {
    const service = new TerminalStorageOwnerService({
      preloadPath: '/app/terminal-owner-preload.js',
      entry: () => ({ filePath: '/app/legacy-mini-ide/index.html' }),
    })
    try {
      const deniedBeforeCreation = service.execute('legacy-mini-ide', request(), () => false)
      await expect(deniedBeforeCreation).rejects.toThrow('Terminal owner request denied')
      expect(electron.FakeWebContentsView.instances).toHaveLength(0)

      let checks = 0
      const deniedAfterReady = service.execute('legacy-mini-ide', request(), () => {
        checks++
        return checks === 1
      })
      const view = electron.FakeWebContentsView.instances[0]
      electron.emit('terminal-owner:ready', readyEvent(view.webContents))
      await expect(deniedAfterReady).rejects.toThrow('Terminal owner request denied')
      expect(checks).toBe(2)
      expect(view.webContents.sendCalls).toHaveLength(0)
    } finally {
      service.dispose()
    }
  })
})
