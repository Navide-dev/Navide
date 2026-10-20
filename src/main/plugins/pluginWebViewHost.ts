import { session, WebContentsView } from 'electron'
import {
  PluginWebViewRegistry,
  type WebGuestSession,
  type WebGuestView,
} from './pluginWebViews'
import type { WebViewInfo } from './webCapability'

/** The production plugin web view registry: real Electron views and sessions
 *  behind the boundaries {@link PluginWebViewRegistry} enforces. */

type WebViewsChangedHook = (pluginId: string, views: WebViewInfo[]) => void

let registry: PluginWebViewRegistry | null = null
let changedHook: WebViewsChangedHook | null = null

/** The plugin manager routes `web.changed` through this hook. */
export function setPluginWebViewChangedHook(hook: WebViewsChangedHook | null): void {
  changedHook = hook
}

export function pluginWebViewRegistry(): PluginWebViewRegistry {
  registry ??= new PluginWebViewRegistry({
    createView: ({ partition, backgroundThrottling }) => new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        safeDialogs: true,
        spellcheck: false,
        backgroundThrottling,
      },
    }) as unknown as WebGuestView,
    session: (partition) => session.fromPartition(partition) as unknown as WebGuestSession,
    onChanged: (pluginId, views) => changedHook?.(pluginId, views),
  })
  return registry
}
