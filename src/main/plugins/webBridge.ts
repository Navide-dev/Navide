import type { JsonValue } from '../../../packages/plugin-contracts/src/index'
import { PlansBridgeError } from './plansBridge'
import { WebViewError, type PluginWebViewRegistry } from './pluginWebViews'
import { validateWebBridgeRequest, type WebViewInfo, type WebViewState } from './webCapability'

/** What the agent may see of a view: a user-owned Space shows that it exists
 *  and who controls it, never where the user is or what the page is called. */
function agentView(view: WebViewInfo): WebViewInfo {
  if (view.owner !== 'user') return view
  const { note: _note, ...rest } = view
  return { ...rest, url: '', title: '' }
}

/** The native backend's `web` Bridge port. `pluginId` is the Host-authenticated
 *  backend binding's, never an argument; the registry keeps the backend inside
 *  that plugin's views and refuses `cdp` while the user owns or controls one. */
export async function dispatchWebBridge(
  registry: PluginWebViewRegistry,
  pluginId: string,
  operation: string,
  args: JsonValue,
): Promise<JsonValue> {
  if (!validateWebBridgeRequest(operation, args)) throw new PlansBridgeError('INVALID_ARGUMENT')
  try {
    switch (operation) {
      case 'list':
        return { views: registry.list(pluginId).map(agentView) } as unknown as JsonValue
      case 'create':
        return registry.create(pluginId, {
          space: String(args.space),
          ...(typeof args.url === 'string' ? { url: args.url } : {}),
        }, 'agent')
      case 'close':
        registry.close(pluginId, String(args.viewId), true)
        return { ok: true }
      case 'cdp': {
        const params = args.params as Record<string, unknown> | undefined
        const result = await registry.cdp(pluginId, String(args.viewId), String(args.method), params)
        return { result: (result ?? null) as JsonValue }
      }
      case 'setState':
        registry.setState(
          pluginId,
          String(args.viewId),
          args.state as WebViewState,
          typeof args.note === 'string' ? args.note : undefined,
        )
        return { ok: true }
    }
  } catch (error) {
    if (!(error instanceof WebViewError)) throw error
    if (error.code === 'USER_IN_CONTROL') {
      throw new PlansBridgeError('USER_IN_CONTROL', undefined, { reason: error.reason ?? 'user-owned' })
    }
    if (error.code === 'CDP_ERROR') {
      throw new PlansBridgeError('CDP_ERROR', undefined, { message: error.message })
    }
    throw new PlansBridgeError(error.code)
  }
  throw new PlansBridgeError('METHOD_NOT_FOUND')
}
