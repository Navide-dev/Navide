// Settings → Resource limits: open Spotlight's privacy settings so the user can
// exclude folders from indexing themselves. Navide never edits the exclusion
// list (it is machine-wide and needs the user's say), and a marker file such as
// .metadata_never_index is no longer honored by current macOS. The destination
// is fixed here, like legal:open — the renderer cannot name a URL.

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { UNTRUSTED_SENDER } from './ipcSender'

export const SPOTLIGHT_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Spotlight-Settings.extension'

interface Deps {
  openExternal: (url: string) => Promise<void>
  isTrusted: (event: IpcMainInvokeEvent) => boolean
  isMac: () => boolean
}

export function registerSpotlightSettingsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: Deps,
): void {
  ipc.handle('system:open-spotlight-settings', async (event) => {
    if (!deps.isTrusted(event)) return UNTRUSTED_SENDER
    if (!deps.isMac()) return { ok: false, error: 'Spotlight settings exist only on macOS' }
    try {
      await deps.openExternal(SPOTLIGHT_SETTINGS_URL)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
}
