/** Request contract for the `web` system namespace: the view capabilities a
 *  plugin's own UI calls, the `web.changed` event, and the native backend's
 *  `web` bridge port. Validators are strict and fail closed; the Host view
 *  manager enforces ownership, control and partition rules on top of them. */

export const WEB_METHODS = [
  'web.list',
  'web.create',
  'web.attach',
  'web.detach',
  'web.navigate',
  'web.setOwner',
  'web.takeControl',
  'web.returnControl',
  'web.close',
  'web.capture',
  'web.clearData',
] as const
export type WebMethod = typeof WEB_METHODS[number]

export const WEB_EVENTS = ['web.changed'] as const

/** Methods the Host refuses unless it observed the user gesture itself. */
export const WEB_GESTURE_METHODS: ReadonlySet<string> = new Set([
  'web.create',
  'web.setOwner',
  'web.takeControl',
  'web.returnControl',
  'web.clearData',
])

export type WebViewOwner = 'agent' | 'user'
/** The pane behind a bridge call, from the Host-verified initiator; null
 *  fields for a caller that is not a pane (an external client or the Host). */
export interface WebAgentCaller { paneId: string | null; workspace: string | null }
export type WebViewControl = 'agent' | 'user'
export type WebViewState = 'idle' | 'running' | 'need-action' | 'done'
/** Why a bridge `cdp` call was refused with USER_IN_CONTROL. */
export type WebControlReason = 'user-owned' | 'manual_takeover' | 'permission'
export interface WebViewRect { x: number; y: number; width: number; height: number }
export interface WebViewInfo {
  viewId: string
  space: string
  owner: WebViewOwner
  control: WebViewControl
  state: WebViewState
  note?: string
  url: string
  title: string
  loading: boolean
  attached: boolean
}

export const WEB_BRIDGE_OPERATIONS = ['list', 'create', 'close', 'cdp', 'setState'] as const
export type WebBridgeOperation = typeof WEB_BRIDGE_OPERATIONS[number]

const MAX_URL_LENGTH = 8192
const MAX_ID_LENGTH = 128
const MAX_NOTE_LENGTH = 500
const MAX_RECT_EXTENT = 16384
const OWNERS: readonly string[] = ['agent', 'user']
const STATES: readonly string[] = ['idle', 'running', 'need-action', 'done']
const NAVIGATE_ACTIONS: readonly string[] = ['back', 'forward', 'reload', 'stop']
const CDP_METHOD = /^[A-Z][A-Za-z]*\.[a-zA-Z]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

const isId = (value: unknown): value is string => boundedString(value, MAX_ID_LENGTH)

/** True only for a parseable http(s) URL without embedded credentials, or for
 *  exactly `about:blank`. Every other scheme (javascript:, file:, data:,
 *  chrome:, devtools:, blob:, view-source:, ...) is refused. */
export function isAllowedWebUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return false
  if (url === 'about:blank') return true
  // The WHATWG parser silently strips whitespace and control characters, so a
  // string containing any is refused before it can be normalized into a
  // different URL than the one that was validated.
  if (/[\u0000- \u007f]/.test(url)) return false
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0 && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

function isRect(value: unknown): value is WebViewRect {
  if (!isRecord(value) || !hasOnlyKeys(value, ['x', 'y', 'width', 'height'])) return false
  const offset = (item: unknown) => typeof item === 'number' && Number.isFinite(item) && item >= 0
  const extent = (item: unknown) => typeof item === 'number' && Number.isFinite(item) &&
    item >= 1 && item <= MAX_RECT_EXTENT
  return offset(value.x) && offset(value.y) && extent(value.width) && extent(value.height)
}

function isCreateRequest(value: Record<string, unknown>): boolean {
  return hasOnlyKeys(value, ['space', 'url']) && isId(value.space) &&
    (value.url === undefined || isAllowedWebUrl(value.url))
}

function isViewIdRequest(value: Record<string, unknown>): boolean {
  return hasOnlyKeys(value, ['viewId']) && isId(value.viewId)
}

/** Validate one view-side `web.*` request against its exact shape. */
export function validateWebRequest(address: string, value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  switch (address) {
    case 'web.list':
    case 'web.clearData':
      return hasOnlyKeys(value, [])
    case 'web.create':
      return isCreateRequest(value)
    case 'web.attach':
      return hasOnlyKeys(value, ['viewId', 'rect']) && isId(value.viewId) && isRect(value.rect)
    case 'web.detach':
    case 'web.close':
    case 'web.takeControl':
    case 'web.returnControl':
      return isViewIdRequest(value)
    case 'web.navigate':
      return hasOnlyKeys(value, ['viewId', 'url', 'action']) && isId(value.viewId) &&
        (value.url === undefined) !== (value.action === undefined) &&
        (value.url === undefined || isAllowedWebUrl(value.url)) &&
        (value.action === undefined || NAVIGATE_ACTIONS.includes(value.action as string))
    case 'web.setOwner':
      return hasOnlyKeys(value, ['viewId', 'owner']) && isId(value.viewId) &&
        OWNERS.includes(value.owner as string)
    case 'web.capture':
      return hasOnlyKeys(value, ['viewId', 'maxWidth']) && isId(value.viewId) &&
        (value.maxWidth === undefined || (Number.isInteger(value.maxWidth) &&
          (value.maxWidth as number) >= 64 && (value.maxWidth as number) <= 2048))
    default:
      return false
  }
}

function isWebViewInfo(value: unknown): value is WebViewInfo {
  return isRecord(value) &&
    hasOnlyKeys(value, ['viewId', 'space', 'owner', 'control', 'state', 'note', 'url', 'title', 'loading', 'attached']) &&
    isId(value.viewId) && isId(value.space) &&
    OWNERS.includes(value.owner as string) && OWNERS.includes(value.control as string) &&
    STATES.includes(value.state as string) &&
    (value.note === undefined || typeof value.note === 'string') &&
    typeof value.url === 'string' && typeof value.title === 'string' &&
    typeof value.loading === 'boolean' && typeof value.attached === 'boolean'
}

/** Validate the `web.changed` payload: `{ views: WebViewInfo[] }`. */
export function validateWebChangedEvent(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['views']) &&
    Array.isArray(value.views) && value.views.every(isWebViewInfo)
}

/** Validate one native-backend request on the `web` bridge port. */
export function validateWebBridgeRequest(operation: string, value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  switch (operation) {
    case 'list':
      return hasOnlyKeys(value, [])
    case 'create':
      return isCreateRequest(value)
    case 'close':
      return isViewIdRequest(value)
    case 'cdp':
      return hasOnlyKeys(value, ['viewId', 'method', 'params']) && isId(value.viewId) &&
        typeof value.method === 'string' && value.method.length <= MAX_ID_LENGTH && CDP_METHOD.test(value.method) &&
        (value.params === undefined || isPlainObject(value.params))
    case 'setState':
      return hasOnlyKeys(value, ['viewId', 'state', 'note']) && isId(value.viewId) &&
        STATES.includes(value.state as string) &&
        (value.note === undefined || (typeof value.note === 'string' && value.note.length <= MAX_NOTE_LENGTH))
    default:
      return false
  }
}
