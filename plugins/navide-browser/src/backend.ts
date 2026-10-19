import {
  createPluginCapabilityClient,
  createPluginViewRuntimeClient,
  PluginBackendError,
  type Params,
  type PublicMethod,
} from '@navide/plugin-sdk'
import { parseViews, type WebViewInfo } from './spaces'

export const browserViewRuntime = createPluginViewRuntimeClient()
const pluginCapabilities = createPluginCapabilityClient()

export const BROWSER_WINDOW_CONTRIBUTION = 'navide.browser.window'

export interface WebRect {
  x: number
  y: number
  width: number
  height: number
}

async function invoke(address: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return pluginCapabilities.capabilities.invoke(address as PublicMethod, args as Params<PublicMethod>)
}

/** The `web.*` view capabilities (f38238 §9.2). The Host owns every view. */
export const web = {
  async list(): Promise<WebViewInfo[]> {
    const result = await invoke('web.list') as { views?: unknown } | null
    return parseViews(result?.views)
  },
  async create(space: string, url?: string): Promise<string> {
    const result = await invoke('web.create', url ? { space, url } : { space }) as { viewId?: unknown } | null
    if (typeof result?.viewId !== 'string') throw new PluginBackendError('PROTOCOL_ERROR', 'web.create returned no viewId')
    return result.viewId
  },
  attach: (viewId: string, rect: WebRect) => invoke('web.attach', { viewId, rect }),
  detach: (viewId: string) => invoke('web.detach', { viewId }),
  navigate: (viewId: string, target: { url: string } | { action: 'back' | 'forward' | 'reload' | 'stop' }) =>
    invoke('web.navigate', { viewId, ...target }),
  setOwner: (viewId: string, owner: 'agent' | 'user') => invoke('web.setOwner', { viewId, owner }),
  returnControl: (viewId: string) => invoke('web.returnControl', { viewId }),
  close: (viewId: string) => invoke('web.close', { viewId }),
  async capture(viewId: string, maxWidth: number): Promise<string | null> {
    const result = await invoke('web.capture', { viewId, maxWidth }) as { dataUrl?: unknown } | null
    return typeof result?.dataUrl === 'string' && result.dataUrl.startsWith('data:image/') ? result.dataUrl : null
  },
  clearData: () => invoke('web.clearData'),
}

export function subscribeHostEvent(
  type: string,
  listener: (payload: unknown) => void,
): () => void {
  const subscription = pluginCapabilities.events.subscribe(
    type as Parameters<typeof pluginCapabilities.events.subscribe>[0],
    listener as Parameters<typeof pluginCapabilities.events.subscribe>[1],
  )
  return () => subscription.dispose()
}

export function onWebChanged(listener: (views: WebViewInfo[]) => void): () => void {
  return subscribeHostEvent('web.changed', (payload) => {
    const views = typeof payload === 'object' && payload !== null ? (payload as { views?: unknown }).views : undefined
    listener(parseViews(views))
  })
}

export function openBrowserWindow(): Promise<unknown> {
  return invoke('ui.openPluginWindow', { contributionKey: BROWSER_WINDOW_CONTRIBUTION })
}

export function errorCode(error: unknown): string {
  if (error instanceof PluginBackendError) return error.code
  return error instanceof Error ? error.message : String(error)
}
