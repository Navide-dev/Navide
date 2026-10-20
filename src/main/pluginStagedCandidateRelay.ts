import type { NoticeWindow } from './plansBackendStoppedRelay'

/** A first install staged without Restart that the launch could not promote. */
export interface PluginStagedCandidateNotice {
  pluginId: string
  version: string
  reason: string
}

/**
 * Tells the main window that a plugin installed without Restart could not be
 * activated when Navide started (`plugins:stagedCandidateNotActivated`), so
 * the user learns why it is missing and that Settings → Extensions still offers
 * Restart and Discard. With no main window open, or the one found still loading
 * (its listener not registered yet), the notice is held and `flush` hands it to
 * the next main window that finishes loading, so it is never dropped unseen.
 */
export function createPluginStagedCandidateRelay(deps: {
  window: () => NoticeWindow | null
}): { notify(notice: PluginStagedCandidateNotice): void; flush(win: NoticeWindow): void } {
  const held: PluginStagedCandidateNotice[] = []
  const usable = (win: NoticeWindow | null): win is NoticeWindow =>
    !!win && !win.isDestroyed() && !win.webContents.isLoading()
  const send = (win: NoticeWindow, notice: PluginStagedCandidateNotice): void => {
    win.webContents.send('plugins:stagedCandidateNotActivated', notice)
  }
  return {
    notify(notice) {
      const target = deps.window()
      if (usable(target)) send(target, notice)
      else held.push(notice)
    },
    flush(win) {
      if (!usable(win)) return
      for (const notice of held.splice(0)) send(win, notice)
    },
  }
}
