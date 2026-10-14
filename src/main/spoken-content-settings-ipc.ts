// Settings → Voice → Read aloud: open Accessibility › Spoken Content so the user
// can download a better system voice (e.g. 美佳 Premium). An app cannot install
// system voices itself. The destination is fixed here, like legal:open — the
// renderer cannot name a URL.

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { UNTRUSTED_SENDER } from './ipcSender'

// com.apple.Accessibility-Settings.extension accepts x-apple.systempreferences
// URLs; "SpokenContent" is the anchor its search extension routes to (checked
// against macOS 27.2). Where the anchor is not honored, the Accessibility pane
// still opens and the renderer's hint names the rest of the path.
export const SPOKEN_CONTENT_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Accessibility-Settings.extension?SpokenContent'

interface Deps {
  openExternal: (url: string) => Promise<void>
  isTrusted: (event: IpcMainInvokeEvent) => boolean
  isMac: () => boolean
}

export function registerSpokenContentSettingsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: Deps,
): void {
  ipc.handle('system:open-spoken-content-settings', async (event) => {
    if (!deps.isTrusted(event)) return UNTRUSTED_SENDER
    if (!deps.isMac()) return { ok: false, error: 'Spoken Content settings exist only on macOS' }
    try {
      await deps.openExternal(SPOKEN_CONTENT_SETTINGS_URL)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
}
