import type { JsonValue } from './index.js'

/** Host browser views (`permissions.system: ["web"]`), as the `web.*` entries
 *  of capabilities-v1.json describe them. */
export type WebViewOwner = 'agent' | 'user'
export type WebViewState = 'idle' | 'running' | 'need-action' | 'done'

export interface WebViewDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  defaultPrompt?: string
}

export interface WebViewUpload {
  file: string
  origin: string
  sensitive: boolean
  at: string
}

export interface WebViewSummary {
  viewId: string
  space: string
  owner: WebViewOwner
  control: WebViewOwner
  state: WebViewState
  note?: string
  url: string
  title: string
  loading: boolean
  attached: boolean
  openerViewId?: string
  dialog?: WebViewDialog
  uploads?: WebViewUpload[]
}

export interface WebViewRect {
  x: number
  y: number
  width: number
  height: number
}

export interface WebParams {
  'web.list': Record<string, never>
  'web.create': { space: string; url?: string }
  'web.attach': { viewId: string; rect: WebViewRect }
  'web.detach': { viewId: string }
  'web.navigate':
    | { viewId: string; url: string; action?: never }
    | { viewId: string; action: 'back' | 'forward' | 'reload' | 'stop'; url?: never }
  'web.setOwner': { viewId: string; owner: WebViewOwner }
  'web.takeControl': { viewId: string }
  'web.returnControl': { viewId: string }
  'web.close': { viewId: string }
  'web.capture': { viewId: string; maxWidth?: number }
  'web.clearData': Record<string, never>
  /** A Chrome DevTools Protocol command on one view (API 1.3.0). */
  'web.cdp': { viewId: string; method: string; params?: { [key: string]: JsonValue } }
}

export interface WebResults {
  'web.list': { views: WebViewSummary[] }
  'web.create': { viewId: string }
  'web.attach': { ok: true }
  'web.detach': { ok: true }
  'web.navigate': { ok: true }
  'web.setOwner': { ok: true }
  'web.takeControl': { ok: true }
  'web.returnControl': { ok: true }
  'web.close': { ok: true }
  'web.capture': { dataUrl: string }
  'web.clearData': { ok: true }
  'web.cdp': { result: JsonValue }
}

export interface WebEventPayloads {
  'web.changed': { views: WebViewSummary[] }
}
