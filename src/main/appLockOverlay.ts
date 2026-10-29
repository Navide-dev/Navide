// The App Lock screen: one WebContentsView laid over the whole content area of
// every visible window — main windows, the editor, Plans, Git, Token Monitor.
// The window underneath keeps running and rendering (terminals keep their
// scrollback); the view only covers it and takes the keyboard focus.

import { BrowserWindow, WebContentsView } from 'electron'

import { APP_LOCK_BACKGROUND } from '../shared/appLock'

export const APP_LOCK_QUERY = 'app_lock'

export interface AppLockOverlayOptions {
  preloadPath: string
  entry: { url: string } | { filePath: string }
}

interface Cover {
  win: BrowserWindow
  view: WebContentsView
  resize: () => void
  focus: () => void
}

export class AppLockOverlay {
  private readonly covers = new Map<number, Cover>()
  private active = false
  private raiseTimer: ReturnType<typeof setInterval> | null = null
  private refocus: BrowserWindow | null = null

  constructor(private readonly options: AppLockOverlayOptions) {}

  /** Whether an IPC sender is one of the lock screens. */
  isLockScreen(webContentsId: number): boolean {
    for (const cover of this.covers.values()) {
      if (!cover.view.webContents.isDestroyed() && cover.view.webContents.id === webContentsId) return true
    }
    return false
  }

  show(): void {
    if (this.active) return
    this.active = true
    this.refocus = BrowserWindow.getFocusedWindow()
    for (const win of BrowserWindow.getAllWindows()) this.cover(win)
    // A plugin view or file picker added after locking would sit above the
    // lock screen; put the lock screen back on top.
    this.raiseTimer = setInterval(() => this.raise(), 1000)
  }

  hide(): void {
    if (!this.active) return
    this.active = false
    if (this.raiseTimer) clearInterval(this.raiseTimer)
    this.raiseTimer = null
    for (const cover of [...this.covers.values()]) this.uncover(cover)
    const target = this.refocus
    this.refocus = null
    if (target && !target.isDestroyed()) target.webContents.focus()
  }

  /** Hook for every new window: cover it too if it shows up while locked. */
  watch(win: BrowserWindow): void {
    win.on('show', () => this.cover(win))
    // A window created already visible emits no 'show'.
    setImmediate(() => this.cover(win))
  }

  private cover(win: BrowserWindow): void {
    // Hidden utility windows (plugin preflight, PDF rendering) are never
    // shown, so there is nothing to hide; `watch` covers them if they appear.
    if (!this.active || win.isDestroyed() || !win.isVisible() || this.covers.has(win.id)) return
    const view = new WebContentsView({ webPreferences: {
      preload: this.options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true,
    } })
    view.setBackgroundColor(APP_LOCK_BACKGROUND)
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', event => event.preventDefault())
    const resize = (): void => {
      if (win.isDestroyed()) return
      const { width, height } = win.getContentBounds()
      view.setBounds({ x: 0, y: 0, width, height })
    }
    const focus = (): void => {
      if (!view.webContents.isDestroyed()) view.webContents.focus()
    }
    const cover: Cover = { win, view, resize, focus }
    this.covers.set(win.id, cover)
    win.on('resize', resize)
    win.on('focus', focus)
    win.once('closed', () => this.uncover(cover))
    // A crashed lock screen would leave the window bare: put up a new one.
    view.webContents.once('render-process-gone', () => {
      this.uncover(cover)
      this.cover(win)
    })
    view.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed() && win.isFocused()) view.webContents.focus()
    })
    win.contentView.addChildView(view)
    resize()
    const entry = this.options.entry
    if ('url' in entry) {
      const url = new URL(entry.url)
      url.searchParams.set(APP_LOCK_QUERY, '1')
      void view.webContents.loadURL(url.href).catch(() => {})
    } else {
      void view.webContents.loadFile(entry.filePath, { query: { [APP_LOCK_QUERY]: '1' } }).catch(() => {})
    }
  }

  private uncover(cover: Cover): void {
    if (this.covers.get(cover.win.id) !== cover) return
    this.covers.delete(cover.win.id)
    if (!cover.win.isDestroyed()) {
      cover.win.off('resize', cover.resize)
      cover.win.off('focus', cover.focus)
      cover.win.contentView.removeChildView(cover.view)
    }
    if (!cover.view.webContents.isDestroyed()) cover.view.webContents.close()
  }

  private raise(): void {
    for (const { win, view } of this.covers.values()) {
      if (win.isDestroyed()) continue
      const children = win.contentView.children
      if (children[children.length - 1] !== view) win.contentView.addChildView(view)
    }
  }
}
