/**
 * Minimise, maximise and close for platforms that do not draw their own.
 *
 * Every window in this app is created with `titleBarStyle: 'hidden'` so the
 * renderer can draw the bar itself. On macOS that is safe: the system still
 * paints the traffic lights over the window. On Windows and Linux it is not —
 * the window comes up genuinely frameless, and until this module existed there
 * was no minimise, no maximise and no close anywhere in the process. A window
 * that cannot be closed from inside the app is not a cosmetic problem, so
 * these handlers exist on every platform and the renderer decides whether to
 * draw buttons for them.
 *
 * The handlers act on the window that sent the message rather than on a
 * focused-window lookup: a click in a plugin's <webview> arrives from a guest
 * whose owning window is unambiguous, while "the focused window" is a race
 * against whatever the user did between the click and the IPC.
 */

import { app, BrowserWindow, ipcMain } from 'electron'

import { isMac } from '../shared/osplat'

/** Sent to a window whose maximised state changed, so its button can follow. */
export const MAXIMIZE_CHANGED = 'window:maximize-changed'

/**
 * Title-bar options for a window whose content will not draw its own controls.
 *
 * The app's own windows hide the title bar and draw a replacement, so on
 * Windows and Linux they render `WindowControls` into it. Plugin contribution
 * windows cannot: their content is a plugin bundle with no Host bridge, and
 * reaching across that boundary to share the component is exactly what
 * `gitComposition.test.ts` exists to prevent.
 *
 * So for those windows the honest answer off macOS is the system's own frame —
 * which is already how the Plans contribution window is created on every
 * platform. macOS keeps the hidden bar, because there the system still paints
 * the traffic lights over it and nothing is lost.
 */
export function systemFrameUnlessMac(): { titleBarStyle?: 'hidden' } {
  return isMac() ? { titleBarStyle: 'hidden' } : {}
}

/**
 * Title-bar options for a window that took the system's frame on every
 * platform and is being brought in line with the rest of the app.
 *
 * The inverse of the above, and deliberately not the same as "what every other
 * window does". Those windows hide the bar everywhere, which is free on macOS
 * because the system still paints the traffic lights over them — but a window
 * that ships with a system frame today would visibly change there, and macOS
 * is explicitly staying as it is. So this hides the bar only where we draw the
 * replacement, and leaves macOS alone.
 */
export function drawnFrameWhereNeeded(): { titleBarStyle?: 'hidden' } {
  return isMac() ? {} : { titleBarStyle: 'hidden' }
}

function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  // `fromWebContents` misses guests: a <webview> has its own WebContents whose
  // window is the host's, which is what `getOwnerBrowserWindow` resolves.
  const win =
    BrowserWindow.fromWebContents(event.sender) ??
    (event.sender as unknown as { getOwnerBrowserWindow?: () => BrowserWindow | null })
      .getOwnerBrowserWindow?.() ??
    null
  return win && !win.isDestroyed() ? win : null
}

const lastPublished = new WeakMap<BrowserWindow, boolean>()

function publishMaximized(win: BrowserWindow, onlyIfChanged = false): void {
  if (win.isDestroyed()) return
  const state = win.isMaximized()
  if (onlyIfChanged && lastPublished.get(win) === state) return
  lastPublished.set(win, state)
  if (!win.webContents.isDestroyed()) {
    win.webContents.send(MAXIMIZE_CHANGED, state)
  }
}

/**
 * Wire the three controls plus the state query, once for the whole process.
 *
 * Also subscribes every window that gets created from here on, so a window
 * added later — a plugin contribution window, a detached group — gets the
 * same behaviour without its creation site having to remember.
 */
export function installWindowControls(): void {
  ipcMain.handle('window:minimize', (event) => {
    const win = senderWindow(event)
    // `minimizable` is false for some plugin contribution windows; asking
    // anyway throws on Windows rather than being ignored.
    if (win?.isMinimizable()) win.minimize()
    return { ok: Boolean(win) }
  })

  ipcMain.handle('window:toggleMaximize', (event) => {
    const win = senderWindow(event)
    if (!win) return { ok: false, maximized: false }
    if (!win.isMaximizable()) return { ok: false, maximized: win.isMaximized() }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { ok: true, maximized: win.isMaximized() }
  })

  ipcMain.handle('window:close', (event) => {
    const win = senderWindow(event)
    // `close()`, not `destroy()`: the app's own 'close' handlers decide
    // whether to prompt, save layout, or veto, exactly as they do for a
    // native title bar button.
    win?.close()
    return { ok: Boolean(win) }
  })

  ipcMain.handle('window:isMaximized', (event) => {
    const win = senderWindow(event)
    return { maximized: win ? win.isMaximized() : false }
  })

  app.on('browser-window-created', (_event, win) => {
    const onChange = (): void => publishMaximized(win)
    win.on('maximize', onChange)
    win.on('unmaximize', onChange)
    // Leaving full screen lands in a different state than it left; without
    // this the button keeps the icon it had before the transition.
    win.on('enter-full-screen', onChange)
    win.on('leave-full-screen', onChange)
    if (isMac()) return
    // Linux window managers can restore a window (drag off the top, Super+Down,
    // leaving a tile) without an `unmaximize`, and an X11 maximize settles
    // after the call returns — so the button could keep "Restore" on a window
    // that no longer is. Re-check on the events that do arrive, sending only
    // when the answer changed.
    const recheck = (): void => publishMaximized(win, true)
    win.on('resize', recheck)
    win.on('restore', recheck)
    win.on('focus', recheck)
  })
}
