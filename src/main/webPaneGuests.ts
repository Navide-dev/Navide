/**
 * Host side of web panes: the `<webview>` guests that show an agent website in
 * a pane (src/shared/webPaneSites.ts). They are not plugin guests — a web pane
 * gets no preload and no Navide API — so the main window's attach hook routes
 * them here before the plugin hook would refuse them.
 *
 * - A guest attaches only on a known site's `persist:web-<site>` partition and
 *   only with a src on that site; its webPreferences are then rewritten to a
 *   sandboxed, isolated page with nothing the tag could have added.
 * - Navigation inside the guest is the site's own business (OAuth redirects to
 *   third-party sign-in pages must work in place), limited to http(s).
 * - window.open is decided here: the site's own domains load in the pane, any
 *   other http(s) URL opens in the system browser.
 * - The user agent is left alone: the webpane spike measured Cloudflare
 *   passing Electron's default UA and blocking a spoofed Chrome one.
 */
import { app, session, webContents, type IpcMain, type WebContents } from 'electron'
import {
  isWebPaneSameSite,
  webPanePartition,
  webPaneSite,
  webPaneSiteForPartition,
  type WebPaneSite,
} from '../shared/webPaneSites'
import type { MutableWebPreferences } from './plugins/pluginGuestAttach'

const guests = new WeakSet<object>()
const guardedPartitions = new Set<string>()

export function isWebPaneGuest(contents: object): boolean {
  return guests.has(contents)
}

/** Keys the `<webview>` tag may contribute that a web pane must not keep. */
const DROPPED_KEYS = [
  'preload',
  'plugins',
  'allowRunningInsecureContent',
  'experimentalFeatures',
  'enableBlinkFeatures',
  'disableBlinkFeatures',
  'nodeIntegrationInWorker',
  'additionalArguments',
] as const

/**
 * Called from the window's 'will-attach-webview' for a `persist:web-` partition.
 * Returns the site (prefs rewritten in place), or null after refusing the
 * attach: an unknown site, or a src off the site.
 */
export function approveWebPaneAttach(
  event: { preventDefault(): void },
  prefs: MutableWebPreferences,
  params: { src?: string },
): WebPaneSite | null {
  const site = webPaneSiteForPartition(typeof prefs['partition'] === 'string' ? prefs['partition'] : undefined)
  if (!site) {
    event.preventDefault()
    return null
  }
  if (!isWebPaneSameSite(site, typeof params.src === 'string' ? params.src : '')) {
    event.preventDefault()
    return null
  }
  for (const key of DROPPED_KEYS) delete prefs[key]
  prefs.partition = webPanePartition(site.id)
  prefs.contextIsolation = true
  prefs.nodeIntegration = false
  prefs.nodeIntegrationInSubFrames = false
  prefs.sandbox = true
  prefs.webSecurity = true
  guardPartition(site.id)
  return site
}

/** Permissions a web pane's site gets: copying to the clipboard and going
 *  fullscreen. Camera, microphone, notifications, location and the rest are
 *  refused — a pane is a window onto the site, not a place it can reach the
 *  machine from. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

function guardPartition(siteId: string): void {
  const partition = webPanePartition(siteId)
  if (guardedPartitions.has(partition)) return
  guardedPartitions.add(partition)
  const ses = session.fromPartition(partition)
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  ses.on('will-download', (e) => e.preventDefault())
}

/** Called from the window's 'did-attach-webview' for a guest approved above. */
export function adoptWebPaneGuest(
  guest: WebContents,
  site: WebPaneSite,
  openExternal: (url: string) => void,
): void {
  guests.add(guest)
  guest.on('will-navigate', (e, url) => {
    if (!/^https?:\/\//i.test(url)) e.preventDefault()
  })
  // Replaces the app-wide handler 'web-contents-created' installed.
  guest.setWindowOpenHandler(({ url }) => {
    if (isWebPaneSameSite(site, url)) void guest.loadURL(url)
    else if (/^https?:\/\//i.test(url)) openExternal(url)
    return { action: 'deny' }
  })
}

/** IPC for the renderer's web panes: memory readout and "sign out and clear". */
export function registerWebPaneIpc(ipc: IpcMain, isTrusted: (event: Electron.IpcMainInvokeEvent) => boolean): void {
  // Resident memory of each guest's renderer process, in MB, keyed by the
  // guest's webContents id. app.getAppMetrics() covers every platform without
  // shelling out; workingSetSize is in KB.
  ipc.handle('webPane:memory', (event, ids: unknown) => {
    if (!isTrusted(event) || !Array.isArray(ids)) return {}
    const byPid = new Map(app.getAppMetrics().map((m) => [m.pid, m.memory.workingSetSize]))
    const out: Record<string, number> = {}
    for (const id of ids) {
      if (typeof id !== 'number') continue
      const wc = webContents.fromId(id)
      if (!wc || !isWebPaneGuest(wc)) continue
      const kb = byPid.get(wc.getOSProcessId())
      if (kb !== undefined) out[String(id)] = Math.round(kb / 1024)
    }
    return out
  })
  ipc.handle('webPane:clearData', async (event, siteId: unknown) => {
    if (!isTrusted(event) || typeof siteId !== 'string' || !webPaneSite(siteId)) return false
    const ses = session.fromPartition(webPanePartition(siteId))
    await ses.clearStorageData()
    await ses.clearCache()
    return true
  })
}
