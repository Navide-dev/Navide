import type { PluginRescanNotice, PluginUpdateInfo } from './pluginIpc'

/**
 * One periodic pass: the installed-plugin trust refresh, then the update
 * reminder. The update check starts only after the trust refresh settled and
 * its failure is contained here, so it can never alter trust state or
 * quarantine decisions. Detection only — nothing is installed.
 */
export async function refreshTrustThenUpdates(deps: {
  refreshTrust: () => Promise<void>
  checkUpdates: () => Promise<PluginUpdateInfo[]>
  publish: (updates: PluginUpdateInfo[]) => void
  warn: (message: string) => void
}): Promise<void> {
  try {
    await deps.refreshTrust()
  } finally {
    try {
      deps.publish(await deps.checkUpdates())
    } catch (error) {
      deps.warn(
        `[main] plugin update check failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

/** D-f: hand the rescan notices of the last check to the open main windows.
 *  They are cleared only once at least one window received them; with none
 *  open they go back to wait for the next check (review L1 on #371). */
export function publishRescanNotices(deps: {
  take: () => PluginRescanNotice[]
  restore: (notices: PluginRescanNotice[]) => void
  /** Sends to every open main window; returns how many received them. */
  send: (notices: PluginRescanNotice[]) => number
}): void {
  const notices = deps.take()
  if (notices.length === 0) return
  if (deps.send(notices) === 0) deps.restore(notices)
}
