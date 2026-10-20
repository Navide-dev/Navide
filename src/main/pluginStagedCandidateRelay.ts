import type { NoticeWindow } from './plansBackendStoppedRelay'

/** A first install staged without Restart that the launch could not promote. */
export interface PluginStagedCandidateNotice {
  pluginId: string
  version: string
  reason: string
}

/** L3: an approved update switched versions. */
export interface PluginSwitchNotice {
  pluginId: string
  fromVersion: string
  toVersion: string
  source: 'marketplace' | 'local-unsigned'
  at: number
}

/** A package staged beside the active one, found at launch. */
export interface PluginStagedUpdate {
  pluginId: string
  activeVersion: string
  stagedVersion: string
}

/**
 * Tells the main window what the launch found among staged plugin packages:
 * a first install it could not activate (`plugins:stagedCandidateNotActivated`)
 * and the packages staged beside an active one (`plugins:stagedUpdates`), so
 * the user learns why a plugin is missing or not on its newest version and
 * can apply it. With no main window open, or the one found still loading (its
 * listener not registered yet), each notice is held and `flush` hands it to the
 * next main window that finishes loading, so it is never dropped unseen.
 */
export function createPluginStagedCandidateRelay(deps: {
  window: () => NoticeWindow | null
}): {
  notify(notice: PluginStagedCandidateNotice): void
  notifyStagedUpdates(updates: PluginStagedUpdate[]): void
  notifySwitched(notice: PluginSwitchNotice): void
  flush(win: NoticeWindow): void
} {
  const held: Array<{ channel: string; payload: unknown }> = []
  const usable = (win: NoticeWindow | null): win is NoticeWindow =>
    !!win && !win.isDestroyed() && !win.webContents.isLoading()
  const deliver = (channel: string, payload: unknown): void => {
    const target = deps.window()
    if (usable(target)) target.webContents.send(channel, payload)
    else held.push({ channel, payload })
  }
  return {
    notify(notice) {
      deliver('plugins:stagedCandidateNotActivated', notice)
    },
    notifyStagedUpdates(updates) {
      deliver('plugins:stagedUpdates', updates)
    },
    notifySwitched(notice) {
      deliver('plugins:switched', notice)
    },
    flush(win) {
      if (!usable(win)) return
      for (const { channel, payload } of held.splice(0)) win.webContents.send(channel, payload)
    },
  }
}
