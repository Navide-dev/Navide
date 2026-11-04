import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isWindows } from '../shared/osplat'

/** Whether a top-level navigation stays on the app itself: the dev-server
 *  origin (HMR/reloads), or exactly the app's own index.html. Any other file
 *  whose path merely ends in /renderer/index.html is not the app. */
export function isAppNavigation(url: string, devOrigin: string | null, appIndexPath: string): boolean {
  try {
    const u = new URL(url)
    if (devOrigin && u.origin === devOrigin) return true
    if (u.protocol !== 'file:') return false
    const target = resolve(fileURLToPath(u))
    const own = resolve(appIndexPath)
    return isWindows()
      ? target.toLowerCase() === own.toLowerCase()
      : target === own
  } catch {
    // Malformed URL — treat as not-app and block.
    return false
  }
}

/** The window-open decision for every WebContents. An app window's external
 *  http(s) link goes to the OS browser; a plugin view must use ui.openExternal
 *  (its grant and gesture checks), so its window.open never opens anything. */
export function handleWindowOpen(
  url: string,
  fromPluginView: boolean,
  openExternal: (url: string) => Promise<void>,
): { action: 'deny' } {
  if (!fromPluginView && /^https?:\/\//i.test(url)) void openExternal(url)
  return { action: 'deny' }
}
