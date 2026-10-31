// Dedicated preload for plugin `WebContentsView`s.
//
// Deliberately minimal: it exposes ONLY `window.nav` (brokered capability and
// package-local backend calls, events, and lifecycle helpers). It must NOT
// expose `window.agentTeam` or any of the host's privileged surface — a plugin
// reaches the host solely through brokered calls.
// Node-free by design (request ids come from webcrypto) so it runs under
// `sandbox: true`.

import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from 'electron'
import { PLUGIN_API_VERSION } from '../../packages/plugin-contracts/src/apiVersion'
import { USER_GESTURE_CAPABILITY_ADDRESSES } from '../../packages/plugin-contracts/src/userGesture'

// The manager injects `--plugin-id=<id>` via webPreferences.additionalArguments,
// so the id is authoritative (main also verifies by sender) and not spoofable
// from page content.
const PLUGIN_ID_PREFIX = '--plugin-id='
const PACKAGE_BACKEND_PREFIX = '--plugin-backend='
const pluginId =
  process.argv.find((a) => a.startsWith(PLUGIN_ID_PREFIX))?.slice(PLUGIN_ID_PREFIX.length) ?? ''
const packageBackendEnabled = process.argv.includes(`${PACKAGE_BACKEND_PREFIX}1`)

// ── Host-observed user gesture ────────────────────────────────────────────
// Catalog addresses marked `requiresUserGesture` (`ui.openExternal` and the
// `web.*` ownership, control and data-clearing methods)
// are refused by the Host unless the request carries a gesture the Host itself
// observed. Plugin page script runs in an isolated world and cannot produce a
// trusted event, so `isTrusted` recorded here is not forgeable from page
// content; this listener is registered before any page script runs, so a plugin
// cannot suppress it from its own capture listener either. The window matches
// the browser's transient-activation budget: long enough for a click handler to
// await work before it opens a link, short enough that an unattended view
// cannot reuse an old gesture. Each trusted event authorizes one link open.
const USER_GESTURE_WINDOW_MS = 5_000
let lastUserGestureAt = Number.NEGATIVE_INFINITY
// Typed locally: this preload is compiled without the DOM lib (it is Node-free
// by design), yet a real plugin view always has a window. Unit tests import this
// module without one, so the subscription stays optional.
interface HostGestureTarget {
  addEventListener(
    type: 'pointerdown' | 'keydown',
    listener: (event: { isTrusted: boolean }) => void,
    capture: boolean,
  ): void
}
const hostWindow = (globalThis as { window?: HostGestureTarget }).window
if (hostWindow && typeof hostWindow.addEventListener === 'function') {
  for (const type of ['pointerdown', 'keydown'] as const) {
    hostWindow.addEventListener(
      type,
      (event) => {
        if (event.isTrusted) lastUserGestureAt = performance.now()
      },
      true,
    )
  }
}
function consumeFreshUserGesture(): boolean {
  const fresh = performance.now() - lastUserGestureAt <= USER_GESTURE_WINDOW_MS
  lastUserGestureAt = Number.NEGATIVE_INFINITY
  return fresh
}

interface CapabilityResponse {
  reqId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message?: string }
}

interface BackendSubscriptionRegistration {
  readonly ready: Promise<void>
  readonly settled: Promise<void>
  dispose(): void
}

type EventListener = (data: unknown) => void
const listeners = new Map<string, Set<EventListener>>()
type BackendEventListener = (data: unknown) => void
const backendSubscriptions = new Map<string, {
  event: string
  listener: BackendEventListener
  settle(error?: Error): void
}>()

ipcRenderer.on('plugin:cap:event', (_event, payload: { type: string; data: unknown }) => {
  listeners.get(payload.type)?.forEach((cb) => cb(payload.data))
})

ipcRenderer.on(
  'plugin:backend:event',
  (_event, payload: { subscriptionId: string; event: string; payload: unknown }) => {
    const subscription = backendSubscriptions.get(payload.subscriptionId)
    if (!subscription || subscription.event !== payload.event) return
    subscription.listener(payload.payload)
  },
)

ipcRenderer.on(
  'plugin:backend:status',
  (_event, payload: { subscriptionId: string; ok: boolean; error?: { code: string; message?: string } }) => {
    if (!payload || typeof payload.subscriptionId !== 'string' || payload.ok !== false) return
    const subscription = backendSubscriptions.get(payload.subscriptionId)
    if (!subscription) return
    const error = new Error(
      payload.error?.message ?? 'Plugin backend subscription ended.',
    ) as Error & { code?: string }
    error.code = payload.error?.code ?? 'BACKEND_UNAVAILABLE'
    subscription.settle(error)
  },
)

type ReceiverFrameElement = {
  isConnected: boolean
  setAttribute(name: string, value: string): void
  src: string
}

type ReceiverSlotElement = {
  isConnected: boolean
  append(...nodes: ReceiverFrameElement[]): void
  getAttribute(name: string): string | null
  remove(): void
}

type ReceiverDocument = {
  createElement(tag: 'iframe'): ReceiverFrameElement
  querySelector(selector: string): ReceiverSlotElement | ReceiverFrameElement | null
  querySelectorAll(selector: string): ArrayLike<ReceiverSlotElement>
}

type ReceiverItemClosed = {
  itemId: string
  documentGeneration: number
}

type MountedReceiverItem = {
  receiverId: string
  itemId: string
  host: ReceiverSlotElement
  frame: ReceiverFrameElement
  closed: boolean
}

type PendingReceiverOffer = {
  receiverId: string
  location: 'left' | 'detail'
}

const mountedReceiverItems = new Map<string, MountedReceiverItem>()
const pendingReceiverOffers = new Map<string, PendingReceiverOffer>()
const receiverItemClosedListeners = new Map<string, Set<(item: ReceiverItemClosed) => void>>()
const receiverEditorTargetDisposers = new Map<string, Set<() => void>>()

type ReceiverCloseGuardReason = 'receiver-item-batch' | 'native-window-close' | 'reload' | 'quit'
type ReceiverCloseDecision =
  | { accepted: true; reason: 'accepted' }
  | { accepted: false; reason: 'refused' | 'busy' }
type ReceiverCloseGuardRecord = {
  closeId: string
  phase: 'pending' | 'accepted' | 'cancelled' | 'busy' | 'responding'
  acknowledged: boolean
}
type ReceiverCloseGuardState = {
  active: boolean
  records: Map<string, ReceiverCloseGuardRecord>
  barrier: ReceiverCloseGuardRecord | null
  dispose(): void
}
const receiverCloseGuards = new Map<string, ReceiverCloseGuardState>()

function receiverDocument(): ReceiverDocument {
  return (globalThis as unknown as { document: ReceiverDocument }).document
}

function exactReceiverMountHost(
  dom: ReceiverDocument,
  mountHostId: string,
  location: 'left' | 'detail',
): ReceiverSlotElement | null {
  const candidates = dom.querySelectorAll('[data-plugin-receiver-mount-host][data-plugin-receiver-location]')
  let host: ReceiverSlotElement | null = null
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]
    if (
      !candidate.isConnected ||
      candidate.getAttribute('data-plugin-receiver-mount-host') !== mountHostId ||
      candidate.getAttribute('data-plugin-receiver-location') !== location
    ) continue
    if (host) return null
    host = candidate
  }
  return host
}

function closeMountedReceiverItem(item: MountedReceiverItem): void {
  if (mountedReceiverItems.get(item.itemId) !== item) return
  mountedReceiverItems.delete(item.itemId)
  item.closed = true
  if (item.host.isConnected) item.host.remove()
}

function closeMountedReceiverItems(receiverId: string): void {
  for (const item of [...mountedReceiverItems.values()]) {
    if (item.receiverId === receiverId) closeMountedReceiverItem(item)
  }
}

function clearPendingReceiverOffers(receiverId: string): void {
  for (const [offerId, offer] of pendingReceiverOffers) {
    if (offer.receiverId === receiverId) pendingReceiverOffers.delete(offerId)
  }
}

function clearReceiverEditorTargetListeners(receiverId: string): void {
  for (const dispose of receiverEditorTargetDisposers.get(receiverId) ?? []) dispose()
}

function clearReceiverCloseGuard(receiverId: string): void {
  receiverCloseGuards.get(receiverId)?.dispose()
}

/** A receiver-initiated transaction is settled, so any record it owned can no
 *  longer produce a cancellation. A `busy` result still belongs to a
 *  concurrent preparation and must stay registered. */
function settleReceiverCloseGuard(receiverId: string, result: { closed?: unknown; reason?: unknown }): void {
  if (result?.closed === false && result.reason === 'busy') return
  const state = receiverCloseGuards.get(receiverId)
  if (!state) return
  for (const record of [...state.records.values()]) {
    if (record.phase === 'pending' || record.phase === 'busy') continue
    if (state.records.get(record.closeId) === record) state.records.delete(record.closeId)
    if (state.barrier === record) state.barrier = null
  }
}

ipcRenderer.on('plugin:receiver:item-closed', (_event, payload: unknown) => {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null
  const receiverId = typeof record?.receiverId === 'string' ? record.receiverId : ''
  const itemId = typeof record?.itemId === 'string' ? record.itemId : ''
  const documentGeneration = record?.documentGeneration
  if (
    !receiverId ||
    !itemId ||
    typeof documentGeneration !== 'number' ||
    !Number.isInteger(documentGeneration) ||
    documentGeneration < 0
  ) return
  const item = mountedReceiverItems.get(itemId)
  if (!item || item.receiverId !== receiverId) return
  closeMountedReceiverItem(item)
  const closed = { itemId, documentGeneration }
  receiverItemClosedListeners.get(receiverId)?.forEach((listener) => listener(closed))
})

const nav = {
  apiVersion: PLUGIN_API_VERSION,
  /** Call a host capability. Resolves with the response envelope. */
  callCapability(ns: string, method: string, args?: unknown): Promise<CapabilityResponse> {
    return ipcRenderer.invoke('plugin:cap:call', {
      pluginId,
      ns,
      method,
      args,
      reqId: globalThis.crypto.randomUUID(),
      // The Host owns the catalog gate; only its gesture-gated operations
      // consume this one-shot preload observation.
      userGesture: USER_GESTURE_CAPABILITY_ADDRESSES.includes(`${ns}.${method}`) && consumeFreshUserGesture(),
    })
  },
  /** Fixed Host-owned first-party action bridge used by the bundled Git
   *  package for its existing Git/Issues adapters. The main process validates
   *  the sender, action, method, and workspace before dispatch. */
  callHostAction(action: string, args?: unknown): Promise<CapabilityResponse> {
    return ipcRenderer.invoke('plugin:host:call', {
      action,
      args,
      reqId: globalThis.crypto.randomUUID(),
    })
  },
  /** Fire-and-forget capability call: no response envelope ever comes back.
   *  Used for the per-keystroke terminal.input path, where a request/response
   *  round-trip per key would eat the typing-latency budget. Scoping is still
   *  enforced by the broker (a denied/unmapped cast is silently dropped). */
  castCapability(ns: string, method: string, args?: unknown): void {
    ipcRenderer.send('plugin:cap:cast', {
      pluginId,
      ns,
      method,
      args,
      reqId: globalThis.crypto.randomUUID(),
    })
  },
  /** Call the authenticated package-local Backend Wire child. Identity is
   *  resolved from the sender-bound view in Electron main; this bridge accepts
   * only the opaque request id generated by the SDK. */
  callBackend(
    reqId: string,
    name: string,
    args: unknown,
    timeoutMs?: number,
  ): Promise<CapabilityResponse> {
    return ipcRenderer.invoke('plugin:backend:call', { reqId, name, args, timeoutMs })
  },
  /** Cancel one exact package-local backend request. */
  cancelBackend(reqId: string): void {
    ipcRenderer.send('plugin:backend:cancel', { reqId })
  },
  /** Subscribe to one package-local backend event. The SDK owns the public
   *  Disposable; preload keeps the subscription id private to this sender and
   *  exposes Host acceptance so callers can retain a fallback until ready. */
  subscribeBackend(
    event: string,
    listener: BackendEventListener,
  ): BackendSubscriptionRegistration {
    const subscriptionId = globalThis.crypto.randomUUID()
    let active = true
    let resolveSettled!: () => void
    let rejectSettled!: (error: unknown) => void
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve
      rejectSettled = reject
    })
    const settle = (error?: Error): void => {
      if (!active) return
      active = false
      backendSubscriptions.delete(subscriptionId)
      if (error) rejectSettled(error)
      else resolveSettled()
    }
    const dispose = (): void => {
      if (!active) return
      settle()
      ipcRenderer.send('plugin:backend:cancel', { subscriptionId })
    }
    backendSubscriptions.set(subscriptionId, { event, listener, settle })
    const ready = ipcRenderer.invoke('plugin:backend:subscribe', { subscriptionId, event })
      .then((response: CapabilityResponse) => {
        if (!response || response.reqId !== subscriptionId || typeof response.ok !== 'boolean') {
          const error = new Error(
            'Plugin backend returned an invalid subscription response.',
          ) as Error & { code?: string }
          error.code = 'PROTOCOL_ERROR'
          throw error
        }
        if (!response.ok) {
          const error = new Error(
            response.error?.message ?? 'Plugin backend subscription failed.',
          ) as Error & { code?: string }
          error.code = response.error?.code ?? 'BACKEND_UNAVAILABLE'
          throw error
        }
      })
      .catch((error: unknown) => {
        dispose()
        throw error
      })
    return { ready, settled, dispose }
  },
  /** Subscribe to host-pushed events of a given type. Returns a disposer. */
  on(type: string, cb: EventListener): () => void {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    set.add(cb)
    return () => set!.delete(cb)
  },
  /** Announce the plugin has mounted. */
  ready(): void {
    ipcRenderer.send('plugin:ready')
  },
  /** Ask the host to dismiss (hide) this plugin's own view. Sender-scoped in
   *  main: a view can only ever hide itself. */
  hideSelf(): void {
    ipcRenderer.send('plugin:hideSelf')
  },
  async registerReceiver(registration: {
    protocolVersion: 1
    locations: Array<'left' | 'detail'>
    editorTargets?: { protocolVersion: 1 }
    closeGuard?: { protocolVersion: 1 }
  }): Promise<{ receiverId: string }> {
    const result = await ipcRenderer.invoke('plugin:receiver:register', registration) as { receiverId?: unknown }
    if (typeof result.receiverId !== 'string') throw new Error('Receiver registration is unavailable.')
    clearReceiverCloseGuard(result.receiverId)
    return { receiverId: result.receiverId }
  },
  async listReceiverLeftContributions(receiverId: string): Promise<Array<{ contributionKey: string; title: string; icon: string | null; iconMonochrome: boolean }>> {
    const result = await ipcRenderer.invoke('plugin:receiver:list-left-contributions', { receiverId }) as unknown
    if (!Array.isArray(result) || result.some((entry) =>
      !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof (entry as Record<string, unknown>).contributionKey !== 'string' ||
      typeof (entry as Record<string, unknown>).title !== 'string'
    )) throw new Error('Receiver left contributions are unavailable.')
    return result.map((entry) => {
      const record = entry as Record<string, unknown>
      const icon = typeof record.icon === 'string' && record.icon.length > 0 ? record.icon : null
      return {
        contributionKey: record.contributionKey as string,
        title: record.title as string,
        // Display metadata only: the Host resolves a manifest icon path to a
        // URL a sandboxed frame can paint, and marks silhouettes so receivers
        // can ink them like the app's own icons.
        icon,
        iconMonochrome: icon !== null && record.iconMonochrome === true,
      }
    })
  },
  async openReceiverLeft(receiverId: string, contributionKey: string): Promise<void> {
    const result = await ipcRenderer.invoke('plugin:receiver:open-left', { receiverId, contributionKey }) as { offered?: unknown }
    if (result?.offered !== true) throw new Error('Receiver left contribution is unavailable.')
  },
  async acceptExistingReceiverOffer(
    receiverId: string,
    offerId: string,
    itemId: string,
  ): Promise<{ accepted: true; itemId: string } | { accepted: false; reason: 'refused' | 'busy' | 'unavailable' | 'timeout' }> {
    const pendingOffer = pendingReceiverOffers.get(offerId)
    if (!pendingOffer || pendingOffer.receiverId !== receiverId || pendingOffer.location !== 'detail') {
      throw new Error('Receiver offer is unavailable.')
    }
    pendingReceiverOffers.delete(offerId)
    const result = await ipcRenderer.invoke('plugin:receiver:accept-existing', { receiverId, offerId, itemId }) as { accepted?: unknown; itemId?: unknown; reason?: unknown }
    if (result?.accepted === true && typeof result.itemId === 'string') return { accepted: true, itemId: result.itemId }
    if (
      result?.accepted === false &&
      (result.reason === 'refused' || result.reason === 'busy' || result.reason === 'unavailable' || result.reason === 'timeout')
    ) return { accepted: false, reason: result.reason }
    throw new Error('Receiver offer is unavailable.')
  },
  async mountReceiver(receiverId: string, offerId: string, placement: { mountHostId: string }): Promise<{ itemId: string }> {
    if (!placement || typeof placement.mountHostId !== 'string' || placement.mountHostId.length === 0) {
      throw new Error('Receiver mount host is unavailable.')
    }
    const pendingOffer = pendingReceiverOffers.get(offerId)
    if (!pendingOffer || pendingOffer.receiverId !== receiverId) {
      throw new Error('Receiver offer is unavailable.')
    }
    pendingReceiverOffers.delete(offerId)
    const location = pendingOffer.location
    const mounted = await ipcRenderer.invoke('plugin:receiver:mount', { receiverId, offerId, placement }) as { itemId?: unknown }
    if (typeof mounted.itemId !== 'string') throw new Error('Receiver mount is unavailable.')
    let item: MountedReceiverItem | null = null
    try {
      const dom = receiverDocument()
      const host = exactReceiverMountHost(dom, placement.mountHostId, location)
      if (!host) throw new Error('Receiver mount host is unavailable.')
      const token = globalThis.crypto.randomUUID()
      const frame = dom.createElement('iframe')
      frame.setAttribute('data-plugin-receiver-frame', token)
      frame.src = 'about:blank'
      host.append(frame)
      item = { receiverId, itemId: mounted.itemId, host, frame, closed: false }
      mountedReceiverItems.set(item.itemId, item)
      const selector = `iframe[data-plugin-receiver-frame="${token}"]`
      const child = webFrame.getFrameForSelector(selector)
      if (!child || !frame.isConnected || receiverDocument().querySelector(selector) !== frame) throw new Error('Receiver frame is unavailable.')
      const ready = await ipcRenderer.invoke('plugin:receiver:blank-ready', { itemId: item.itemId, frameToken: child.frameToken }) as { locator?: unknown }
      if (
        item.closed ||
        mountedReceiverItems.get(item.itemId) !== item ||
        exactReceiverMountHost(receiverDocument(), placement.mountHostId, location) !== host ||
        typeof ready.locator !== 'string' ||
        webFrame.getFrameForSelector(selector)?.frameToken !== child.frameToken
      ) throw new Error('Receiver frame changed.')
      frame.src = ready.locator
      return { itemId: item.itemId }
    } catch (error) {
      if (item) closeMountedReceiverItem(item)
      try {
        await ipcRenderer.invoke('plugin:receiver:abort', { receiverId, itemId: mounted.itemId })
      } catch {
        // The Host abort is idempotent; retain the original mount failure.
      }
      throw error
    }
  },
  async requestCloseReceiver(receiverId: string, itemId: string): Promise<{ closed: true } | { closed: false; reason: 'refused' | 'busy' | 'unavailable' | 'timeout' }> {
    const result = await ipcRenderer.invoke('plugin:receiver:request-close', { receiverId, itemId }) as { closed?: unknown; reason?: unknown }
    settleReceiverCloseGuard(receiverId, result)
    if (result?.closed === true) return { closed: true }
    if (
      result?.closed === false &&
      (result.reason === 'refused' || result.reason === 'busy' || result.reason === 'unavailable' || result.reason === 'timeout')
    ) return { closed: false, reason: result.reason }
    return { closed: false, reason: 'unavailable' }
  },
  async requestCloseReceiverTransaction(
    receiverId: string,
    itemIds: readonly string[],
  ): Promise<{ closed: true } | { closed: false; reason: 'refused' | 'busy' | 'unavailable' | 'timeout' }> {
    const result = await ipcRenderer.invoke('plugin:receiver:request-close-transaction', { receiverId, itemIds }) as { closed?: unknown; reason?: unknown }
    settleReceiverCloseGuard(receiverId, result)
    if (result?.closed === true) return { closed: true }
    if (
      result?.closed === false &&
      (result.reason === 'refused' || result.reason === 'busy' || result.reason === 'unavailable' || result.reason === 'timeout')
    ) return { closed: false, reason: result.reason }
    return { closed: false, reason: 'unavailable' }
  },
  abortReceiverItem(receiverId: string, itemId: string): Promise<void> {
    return ipcRenderer.invoke('plugin:receiver:abort', { receiverId, itemId })
  },
  onReceiverItemClosed(receiverId: string, listener: (item: ReceiverItemClosed) => void): () => void {
    const listeners = receiverItemClosedListeners.get(receiverId) ?? new Set<(item: ReceiverItemClosed) => void>()
    listeners.add(listener)
    receiverItemClosedListeners.set(receiverId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) receiverItemClosedListeners.delete(receiverId)
    }
  },
  onReceiverOffer(
    receiverId: string,
    listener: (offer:
      | { offerId: string; contributionKey: string; title: string; location: 'left' }
      | { offerId: string; contributionKey: string; title: string; location: 'detail'; resourceKey: string }
    ) => void,
  ): () => void {
    const handler = (_event: unknown, payload: { receiverId?: string; offer?: { offerId?: unknown; contributionKey?: unknown; title?: unknown; location?: unknown; resourceKey?: unknown } }) => {
      const offer = payload?.offer
      if (
        payload?.receiverId !== receiverId ||
        typeof offer?.offerId !== 'string' ||
        typeof offer.contributionKey !== 'string' ||
        typeof offer.title !== 'string'
      ) return
      const exactOffer = offer.location === 'left'
        ? { offerId: offer.offerId, contributionKey: offer.contributionKey, title: offer.title, location: 'left' as const }
        : offer.location === 'detail' && typeof offer.resourceKey === 'string'
          ? { offerId: offer.offerId, contributionKey: offer.contributionKey, title: offer.title, location: 'detail' as const, resourceKey: offer.resourceKey }
          : null
      if (!exactOffer) return
      pendingReceiverOffers.set(exactOffer.offerId, { receiverId, location: exactOffer.location })
      listener(exactOffer)
    }
    ipcRenderer.on('plugin:receiver:offer', handler)
    return () => ipcRenderer.removeListener('plugin:receiver:offer', handler)
  },
  onReceiverEditorTarget(
    receiverId: string,
    listener: (target: { path: string; line?: number; column?: number; sourceItem: string }) => Promise<{ opened: boolean }>,
  ): () => void {
    let active = true
    const handler = (_event: unknown, payload: unknown): void => {
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      const target = typeof record?.target === 'object' && record.target !== null && !Array.isArray(record.target)
        ? record.target as Record<string, unknown>
        : null
      const eventReceiverId = typeof record?.receiverId === 'string' ? record.receiverId : ''
      const correlation = typeof record?.correlation === 'string' ? record.correlation : ''
      if (!active || eventReceiverId !== receiverId || !correlation || !target || typeof target.path !== 'string' || typeof target.sourceItem !== 'string' ||
        (target.line !== undefined && (typeof target.line !== 'number' || !Number.isInteger(target.line) || target.line <= 0)) ||
        (target.column !== undefined && (typeof target.column !== 'number' || !Number.isInteger(target.column) || target.column <= 0))) return
      const exactTarget = target as { path: string; line?: number; column?: number; sourceItem: string }
      const resolve = (result: { opened: boolean }): void => {
        if (!active) return
        void ipcRenderer.invoke('plugin:receiver:resolve-editor-target', { receiverId, correlation, result }).catch(() => undefined)
      }
      void Promise.resolve().then(() => listener(exactTarget)).then(
        (result) => resolve(result && typeof result.opened === 'boolean' ? result : { opened: false }),
        () => resolve({ opened: false }),
      )
    }
    ipcRenderer.on('plugin:receiver:editor-target', handler)
    const disposers = receiverEditorTargetDisposers.get(receiverId) ?? new Set<() => void>()
    receiverEditorTargetDisposers.set(receiverId, disposers)
    const dispose = (): void => {
      if (!active) return
      active = false
      ipcRenderer.removeListener('plugin:receiver:editor-target', handler)
      disposers.delete(dispose)
      if (disposers.size === 0) receiverEditorTargetDisposers.delete(receiverId)
    }
    disposers.add(dispose)
    return dispose
  },
  onReceiverCloseGuard(
    receiverId: string,
    onPrepare: (reason: ReceiverCloseGuardReason) => Promise<ReceiverCloseDecision>,
    onCancelled: () => void,
  ): () => void {
    if (receiverCloseGuards.has(receiverId)) return () => undefined
    let state!: ReceiverCloseGuardState
    const retire = (record: ReceiverCloseGuardRecord): void => {
      if (state.records.get(record.closeId) === record) state.records.delete(record.closeId)
      if (state.barrier === record) state.barrier = null
    }
    const notifyCancelled = (): void => {
      try {
        onCancelled()
      } catch {
        // A receiver release callback cannot disrupt private close cleanup.
      }
    }
    const resolve = (record: ReceiverCloseGuardRecord, decision: ReceiverCloseDecision): void => {
      if (
        !state.active ||
        receiverCloseGuards.get(receiverId) !== state ||
        record.acknowledged ||
        state.records.get(record.closeId) !== record ||
        record.phase !== 'pending'
      ) return
      record.acknowledged = true
      if (decision.accepted) {
        record.phase = 'accepted'
        void ipcRenderer.invoke('plugin:receiver:resolve-close', { receiverId, closeId: record.closeId, decision }).catch(() => undefined)
        return
      }
      record.phase = 'responding'
      void ipcRenderer.invoke('plugin:receiver:resolve-close', { receiverId, closeId: record.closeId, decision })
        .catch(() => undefined)
        .finally(() => retire(record))
    }
    const resolveBusy = (record: ReceiverCloseGuardRecord): void => {
      if (
        !state.active ||
        receiverCloseGuards.get(receiverId) !== state ||
        record.acknowledged ||
        state.records.get(record.closeId) !== record ||
        record.phase !== 'busy'
      ) return
      record.acknowledged = true
      void ipcRenderer.invoke('plugin:receiver:resolve-close', {
        receiverId,
        closeId: record.closeId,
        decision: { accepted: false, reason: 'busy' },
      }).catch(() => undefined).finally(() => retire(record))
    }
    const closeRequestHandler = (_event: unknown, payload: unknown): void => {
      const request = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      const eventReceiverId = typeof request?.receiverId === 'string' ? request.receiverId : ''
      const closeId = typeof request?.closeId === 'string' ? request.closeId : ''
      const reason = request?.reason
      const documentGeneration = request?.documentGeneration
      if (
        !state.active ||
        receiverCloseGuards.get(receiverId) !== state ||
        eventReceiverId !== receiverId ||
        !closeId ||
        (reason !== 'receiver-item-batch' && reason !== 'native-window-close' && reason !== 'reload' && reason !== 'quit') ||
        typeof documentGeneration !== 'number' ||
        !Number.isInteger(documentGeneration) ||
        documentGeneration < 0 ||
        state.records.has(closeId)
      ) return
      if (state.barrier !== null) {
        const record: ReceiverCloseGuardRecord = { closeId, phase: 'busy', acknowledged: false }
        state.records.set(closeId, record)
        resolveBusy(record)
        return
      }
      const record: ReceiverCloseGuardRecord = { closeId, phase: 'pending', acknowledged: false }
      state.records.set(closeId, record)
      state.barrier = record
      const skipped = Symbol('receiver-close-skipped')
      void Promise.resolve().then<ReceiverCloseDecision | typeof skipped>(() => {
        if (
          !state.active ||
          receiverCloseGuards.get(receiverId) !== state ||
          state.records.get(closeId) !== record ||
          record.phase !== 'pending'
        ) return skipped
        return onPrepare(reason)
      }).then(
        (decision) => {
          if (!state.active || receiverCloseGuards.get(receiverId) !== state || state.records.get(closeId) !== record) return
          if (decision === skipped) {
            if (record.phase === 'cancelled') retire(record)
            return
          }
          if (record.phase === 'cancelled') {
            if (decision && typeof decision === 'object' && decision.accepted === true && decision.reason === 'accepted') {
              notifyCancelled()
            }
            retire(record)
            return
          }
          if (
            !decision ||
            typeof decision !== 'object' ||
            (decision.accepted !== true && decision.accepted !== false) ||
            (decision.accepted === true && decision.reason !== 'accepted') ||
            (decision.accepted === false && decision.reason !== 'refused' && decision.reason !== 'busy')
          ) {
            resolve(record, { accepted: false, reason: 'refused' })
            return
          }
          resolve(record, decision)
        },
        () => {
          if (!state.active || receiverCloseGuards.get(receiverId) !== state || state.records.get(closeId) !== record) return
          if (record.phase === 'cancelled') {
            retire(record)
            return
          }
          resolve(record, { accepted: false, reason: 'refused' })
        },
      )
    }
    const closeCancelledHandler = (_event: unknown, payload: unknown): void => {
      const cancellation = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      const eventReceiverId = typeof cancellation?.receiverId === 'string' ? cancellation.receiverId : ''
      const closeId = typeof cancellation?.closeId === 'string' ? cancellation.closeId : ''
      if (!state.active || receiverCloseGuards.get(receiverId) !== state || eventReceiverId !== receiverId || !closeId) return
      const record = state.records.get(closeId)
      if (!record || record.phase === 'cancelled') return
      if (record.phase === 'busy' || record.phase === 'responding') {
        retire(record)
        return
      }
      const wasAccepted = record.phase === 'accepted'
      record.phase = 'cancelled'
      notifyCancelled()
      if (wasAccepted) retire(record)
    }
    const dispose = (): void => {
      if (!state.active) return
      state.active = false
      ipcRenderer.removeListener('plugin:receiver:close-request', closeRequestHandler)
      ipcRenderer.removeListener('plugin:receiver:close-cancelled', closeCancelledHandler)
      if (receiverCloseGuards.get(receiverId) === state) receiverCloseGuards.delete(receiverId)
      state.records.clear()
      state.barrier = null
    }
    state = { active: true, records: new Map(), barrier: null, dispose }
    receiverCloseGuards.set(receiverId, state)
    ipcRenderer.on('plugin:receiver:close-request', closeRequestHandler)
    ipcRenderer.on('plugin:receiver:close-cancelled', closeCancelledHandler)
    return dispose
  },
  async disposeReceiver(receiverId: string): Promise<void> {
    try {
      await ipcRenderer.invoke('plugin:receiver:dispose', { receiverId })
    } finally {
      closeMountedReceiverItems(receiverId)
      clearPendingReceiverOffers(receiverId)
      clearReceiverEditorTargetListeners(receiverId)
      clearReceiverCloseGuard(receiverId)
      receiverItemClosedListeners.delete(receiverId)
    }
  },
  /** Subscribe to host-pushed open targets — entry-query-shaped params
   *  delivered to an already-running view instead of a reload (so in-page
   *  state such as open tabs survives). Returns a disposer. */
  onOpenTarget(cb: (params: Record<string, string>) => void): () => void {
    const listener = (_event: unknown, params: Record<string, string>): void => cb(params)
    ipcRenderer.on('plugin:openTarget', listener)
    return () => {
      ipcRenderer.removeListener('plugin:openTarget', listener)
    }
  },
}

if (!packageBackendEnabled) {
  const privateSurface = nav as Omit<
    typeof nav,
    'callBackend' | 'cancelBackend' | 'subscribeBackend'
  > & Partial<Pick<typeof nav, 'callBackend' | 'cancelBackend' | 'subscribeBackend'>>
  delete privateSurface.callBackend
  delete privateSurface.cancelBackend
  delete privateSurface.subscribeBackend
}

type FramePortMessage = {
  channel: string
  documentGeneration: number
  payload: unknown
}

type FramePort = IpcRendererEvent['ports'][number]

let framePort: FramePort | null = null
let frameNonce = globalThis.crypto.randomUUID()
let frameGeneration: number | null = null
const frameListeners = new Map<string, Set<EventListener>>()
const frameOpenTargetListeners = new Set<(params: Record<string, string>) => void>()
const framePending = new Map<string, (response: CapabilityResponse) => void>()

function settleFrameTransport(message: string): void {
  for (const resolve of framePending.values()) {
    resolve({ reqId: '', ok: false, error: { code: 'PLUGIN_STOPPING', message } })
  }
  framePending.clear()
  for (const subscription of backendSubscriptions.values()) {
    subscription.settle(new Error(message))
  }
}

// View-level close preparation for a plugin's own (non-composed) view. The
// Host waits for one answer per view: forward to the page's guard when it
// registered one, otherwise accept immediately — no guard means nothing to
// protect, and silence would stall the window close until the Host times out.
ipcRenderer.on('plugin:view:close-request', (_event, payload: unknown) => {
  const request = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null
  const closeId = typeof request?.closeId === 'string' ? request.closeId : ''
  const itemId = typeof request?.itemId === 'string' ? request.itemId : ''
  if (!closeId || !itemId) return
  const subscribers = listeners.get('plugin:view:close-request')
  if (subscribers && subscribers.size > 0) {
    for (const listener of subscribers) {
      try {
        listener(request)
      } catch {
        // A throwing guard cannot answer; the Host's timeout stays authoritative.
      }
    }
    return
  }
  void nav.callCapability('ui', 'resolveDetailClose', {
    closeId,
    itemId,
    decision: { accepted: true, reason: 'accepted' },
  }).catch(() => undefined)
})

ipcRenderer.on('plugin:frame:port', (event, payload: { documentGeneration?: unknown; nonce?: unknown }) => {
  const port = event.ports[0]
  if (framePort || !port || typeof payload?.documentGeneration !== 'number' || payload.nonce !== frameNonce) return
  framePort = port
  frameGeneration = payload.documentGeneration
  framePort.onmessage = (portEvent: { data: FramePortMessage }) => {
    const incoming = portEvent.data
    if (!incoming || incoming.documentGeneration !== frameGeneration) return
    if (incoming.channel === 'plugin:response') {
      const payload = incoming.payload as { requestId?: unknown; response?: CapabilityResponse }
      if (typeof payload?.requestId !== 'string' || !payload.response) return
      const resolve = framePending.get(payload.requestId)
      if (!resolve) return
      framePending.delete(payload.requestId)
      resolve(payload.response)
      return
    }
    if (incoming.channel === 'plugin:cap:event') {
      const payload = incoming.payload as { type?: unknown; data?: unknown }
      if (typeof payload?.type !== 'string') return
      frameListeners.get(payload.type)?.forEach((listener) => listener(payload.data))
      return
    }
    if (incoming.channel === 'plugin:openTarget') {
      const payload = incoming.payload
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
      frameOpenTargetListeners.forEach((listener) => listener(payload as Record<string, string>))
      return
    }
    if (incoming.channel === 'plugin:backend:event') {
      const payload = incoming.payload as { subscriptionId?: unknown; event?: unknown; payload?: unknown }
      if (typeof payload?.subscriptionId !== 'string' || typeof payload.event !== 'string') return
      const subscription = backendSubscriptions.get(payload.subscriptionId)
      if (subscription?.event === payload.event) subscription.listener(payload.payload)
      return
    }
    if (incoming.channel === 'plugin:backend:status') {
      const payload = incoming.payload as { subscriptionId?: unknown; ok?: unknown; error?: { code?: string; message?: string } }
      if (typeof payload?.subscriptionId !== 'string' || payload.ok !== false) return
      const subscription = backendSubscriptions.get(payload.subscriptionId)
      if (!subscription) return
      const error = new Error(payload.error?.message ?? 'Plugin backend subscription ended.') as Error & { code?: string }
      error.code = payload.error?.code ?? 'BACKEND_UNAVAILABLE'
      subscription.settle(error)
      return
    }
    if (incoming.channel === 'plugin:frame:revoked') {
      settleFrameTransport('Plugin frame was revoked.')
      return
    }
    // View-level events (`plugin:view:*`) belong to the page's own runtime
    // bridge. A close request with no registered guard is accepted here: only
    // the frame can answer, and never answering would time the Host out and
    // make the window (or the quit) refuse to close.
    if (typeof incoming.channel === 'string' && incoming.channel.startsWith('plugin:view:')) {
      const subscribers = frameListeners.get(incoming.channel)
      if (subscribers && subscribers.size > 0) {
        subscribers.forEach((listener) => listener(incoming.payload))
        return
      }
      if (incoming.channel === 'plugin:view:close-request') {
        const request = incoming.payload as { closeId?: unknown; itemId?: unknown } | null
        const closeId = typeof request?.closeId === 'string' ? request.closeId : ''
        const itemId = typeof request?.itemId === 'string' ? request.itemId : ''
        if (closeId && itemId) {
          void frameRequest('plugin:cap:call', {
            ns: 'ui',
            method: 'resolveDetailClose',
            args: { closeId, itemId, decision: { accepted: true, reason: 'accepted' } },
            reqId: globalThis.crypto.randomUUID(),
          })
        }
      }
    }
  }
  framePort.onmessageerror = () => settleFrameTransport('Plugin frame transport failed.')
  framePort.start()
})

if (!process.isMainFrame) {
  void ipcRenderer.invoke('plugin:frame:document-ready', { nonce: frameNonce }).catch(() => undefined)
}

function frameRequest(channel: string, payload: unknown, cast = false): Promise<CapabilityResponse> {
  if (!framePort) return Promise.resolve({ reqId: '', ok: false, error: { code: 'BAD_REQUEST', message: 'Plugin frame is not admitted.' } })
  const requestId = globalThis.crypto.randomUUID()
  if (cast) {
    framePort.postMessage({ kind: 'cast', requestId, channel, payload })
    return Promise.resolve({ reqId: requestId, ok: true })
  }
  return new Promise((resolve) => {
    framePending.set(requestId, resolve)
    framePort!.postMessage({ kind: 'invoke', requestId, channel, payload })
  })
}

const frameNav = {
  apiVersion: PLUGIN_API_VERSION,
  callCapability(ns: string, method: string, args?: unknown): Promise<CapabilityResponse> {
    return frameRequest('plugin:cap:call', { ns, method, args, reqId: globalThis.crypto.randomUUID() })
  },
  callHostAction(action: string, args?: unknown): Promise<CapabilityResponse> {
    return frameRequest('plugin:host:call', { action, args, reqId: globalThis.crypto.randomUUID() })
  },
  castCapability(ns: string, method: string, args?: unknown): void {
    void frameRequest('plugin:cap:cast', { ns, method, args, reqId: globalThis.crypto.randomUUID() }, true)
  },
  callBackend(reqId: string, name: string, args: unknown, timeoutMs?: number): Promise<CapabilityResponse> {
    return frameRequest('plugin:backend:call', { reqId, name, args, timeoutMs })
  },
  cancelBackend(reqId: string): void {
    void frameRequest('plugin:backend:cancel', { reqId }, true)
  },
  subscribeBackend(event: string, listener: BackendEventListener): BackendSubscriptionRegistration {
    const subscriptionId = globalThis.crypto.randomUUID()
    let active = true
    let resolveSettled!: () => void
    let rejectSettled!: (error: unknown) => void
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve
      rejectSettled = reject
    })
    const settle = (error?: Error): void => {
      if (!active) return
      active = false
      backendSubscriptions.delete(subscriptionId)
      if (error) rejectSettled(error)
      else resolveSettled()
    }
    const dispose = (): void => {
      if (!active) return
      settle()
      void frameRequest('plugin:backend:cancel', { subscriptionId }, true)
    }
    backendSubscriptions.set(subscriptionId, { event, listener, settle })
    const ready = frameRequest('plugin:backend:subscribe', { subscriptionId, event }).then((response) => {
      if (!response.ok) throw new Error(response.error?.message ?? 'Plugin backend subscription failed.')
    }).catch((error: unknown) => {
      dispose()
      throw error
    })
    return { ready, settled, dispose }
  },
  on(type: string, listener: EventListener): () => void {
    const listeners = frameListeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    frameListeners.set(type, listeners)
    return () => listeners.delete(listener)
  },
  ready(): void { void frameRequest('plugin:ready', {}, true) },
  hideSelf(): void { void frameRequest('plugin:hideSelf', {}, true) },
  onOpenTarget(listener: (params: Record<string, string>) => void): () => void {
    frameOpenTargetListeners.add(listener)
    return () => frameOpenTargetListeners.delete(listener)
  },
}

contextBridge.exposeInMainWorld('nav', process.isMainFrame ? nav : frameNav)
