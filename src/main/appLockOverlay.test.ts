import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The lock screen goes over every visible window and only covers it: the
// window underneath is never hidden, reloaded or touched. Electron is a fake.
const h = vi.hoisted(() => ({ windows: [] as unknown[], focused: null as unknown, nextId: 100 }))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeWebContents extends Emitter {
    id = h.nextId++
    destroyed = false
    loaded: string | null = null
    focusCalls = 0
    isDestroyed = (): boolean => this.destroyed
    close = (): void => { this.destroyed = true }
    focus = (): void => { this.focusCalls++ }
    setWindowOpenHandler = (): void => {}
    loadURL = async (url: string): Promise<void> => { this.loaded = url }
    loadFile = async (file: string, opts: { query: Record<string, string> }): Promise<void> => {
      this.loaded = `${file}?${new URLSearchParams(opts.query)}`
    }
  }
  class WebContentsView {
    webContents = new FakeWebContents()
    bounds: unknown = null
    setBackgroundColor(): void {}
    setBounds(b: unknown): void { this.bounds = b }
  }
  const BrowserWindow = {
    getAllWindows: () => h.windows,
    getFocusedWindow: () => h.focused,
  }
  return { BrowserWindow, WebContentsView }
})

import type { BrowserWindow } from 'electron'

import { AppLockOverlay } from './appLockOverlay'

class FakeWindow extends EventEmitter {
  static next = 1
  id = FakeWindow.next++
  visible = true
  destroyed = false
  webContents = { focus: vi.fn() }
  contentView = {
    children: [] as unknown[],
    addChildView: (v: unknown) => {
      this.contentView.children = this.contentView.children.filter((c) => c !== v).concat(v)
    },
    removeChildView: (v: unknown) => {
      this.contentView.children = this.contentView.children.filter((c) => c !== v)
    },
  }
  isDestroyed = (): boolean => this.destroyed
  isVisible = (): boolean => this.visible
  isFocused = (): boolean => h.focused === this
  getContentBounds = () => ({ x: 40, y: 60, width: 800, height: 600 })
}

type View = { webContents: { id: number; loaded: string | null; isDestroyed(): boolean }; bounds: unknown }
const top = (win: FakeWindow) => win.contentView.children.at(-1) as View | undefined

let overlay: AppLockOverlay
beforeEach(() => {
  vi.useFakeTimers()
  h.windows = []
  h.focused = null
  overlay = new AppLockOverlay({ preloadPath: '/p/app-lock-preload.js', entry: { filePath: '/r/index.html' } })
})
afterEach(() => vi.useRealTimers())

describe('AppLockOverlay', () => {
  it('covers every visible window with the lock page and skips hidden ones', () => {
    const shown = new FakeWindow()
    const hidden = new FakeWindow()
    hidden.visible = false
    const existing = { id: 'terminal' }
    shown.contentView.children.push(existing)
    h.windows = [shown, hidden]
    overlay.show()
    const view = top(shown)!
    expect(shown.contentView.children[0]).toBe(existing)
    expect(view.webContents.loaded).toBe('/r/index.html?app_lock=1')
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 800, height: 600 })
    expect(overlay.isLockScreen(view.webContents.id)).toBe(true)
    expect(hidden.contentView.children).toHaveLength(0)
  })

  it('covers a window that appears while locked, once it is shown', () => {
    overlay.show()
    const late = new FakeWindow()
    late.visible = false
    overlay.watch(late as unknown as BrowserWindow)
    late.visible = true
    late.emit('show')
    expect(top(late)?.webContents.loaded).toContain('app_lock=1')
  })

  it('covers a window created already visible while locked', () => {
    overlay.show()
    const late = new FakeWindow()
    overlay.watch(late as unknown as BrowserWindow)
    vi.advanceTimersByTime(0)
    expect(top(late)?.webContents.loaded).toContain('app_lock=1')
  })

  it('puts itself back on top when another view is added after locking', () => {
    const win = new FakeWindow()
    h.windows = [win]
    overlay.show()
    const lock = top(win)
    win.contentView.children.push({ id: 'file-picker' })
    vi.advanceTimersByTime(1000)
    expect(top(win)).toBe(lock)
  })

  it('removes only its own view on unlock, closes it, and refocuses the window', () => {
    const win = new FakeWindow()
    const existing = { id: 'terminal' }
    win.contentView.children.push(existing)
    h.windows = [win]
    h.focused = win
    overlay.show()
    const lock = top(win)!
    overlay.hide()
    expect(win.contentView.children).toEqual([existing])
    expect(lock.webContents.isDestroyed()).toBe(true)
    expect(overlay.isLockScreen(lock.webContents.id)).toBe(false)
    expect(win.webContents.focus).toHaveBeenCalled()
  })

  it('does not cover anything while unlocked', () => {
    const win = new FakeWindow()
    overlay.watch(win as unknown as BrowserWindow)
    win.emit('show')
    expect(win.contentView.children).toHaveLength(0)
  })
})
