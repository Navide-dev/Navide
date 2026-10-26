import type { PluginAgentActionNotice } from './plugins/pluginAgentAction'
import type { NoticeWindow } from './plansBackendStoppedRelay'

/**
 * Tells the main window that an agent disabled or enabled a Navide plugin
 * (`plugins:agentAction`, plan B, B2-c), so the user sees who did it and can
 * undo it. With no main window open, or the one found still loading (its
 * listener not registered yet), the notice is held and `flush` hands it to the
 * next main window that finishes loading, so it is never dropped unseen.
 */
export function createPluginAgentActionRelay(deps: {
  window: () => NoticeWindow | null
}): { notify(notice: PluginAgentActionNotice): void; flush(win: NoticeWindow): void } {
  const held: PluginAgentActionNotice[] = []
  const usable = (win: NoticeWindow | null): win is NoticeWindow =>
    !!win && !win.isDestroyed() && !win.webContents.isLoading()
  const send = (win: NoticeWindow, notice: PluginAgentActionNotice): void => {
    win.webContents.send('plugins:agentAction', notice)
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
