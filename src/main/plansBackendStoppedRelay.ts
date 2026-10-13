/** The part of a BrowserWindow the relay needs. */
export interface NoticeWindow {
  isDestroyed(): boolean
  webContents: {
    isLoading(): boolean
    send(channel: string, payload: unknown): void
  }
}

/**
 * Tells a main window that a workspace's headless Plans backend stopped for
 * good (`plans:backendStopped`). With no main window open, or the one found
 * still loading its page (its listener not registered yet), the notice is held
 * and `flush` hands it to the next window that finishes loading, so it is never
 * dropped unseen. A workspace is held once however often it is reported.
 */
export function createPlansBackendStoppedRelay(deps: {
  find: (workspacePath: string) => NoticeWindow | null
  fallback: () => NoticeWindow | null
}): { notify(workspacePath: string): void; flush(win: NoticeWindow): void } {
  const held: string[] = []
  const usable = (win: NoticeWindow | null): win is NoticeWindow =>
    !!win && !win.isDestroyed() && !win.webContents.isLoading()
  const send = (win: NoticeWindow, workspacePath: string): void => {
    win.webContents.send('plans:backendStopped', { workspacePath })
  }
  return {
    notify(workspacePath) {
      const found = deps.find(workspacePath)
      const target = found && !found.isDestroyed() ? found : deps.fallback()
      if (usable(target)) send(target, workspacePath)
      else if (!held.includes(workspacePath)) held.push(workspacePath)
    },
    flush(win) {
      if (!usable(win)) return
      for (const workspacePath of held.splice(0)) send(win, workspacePath)
    },
  }
}
