import type {
  Disposable,
  JsonValue,
  Params,
  Payload,
  PluginErrorCode,
  PublicEvent,
  PublicMethod,
  Result,
  StorageGetResult,
  StoragePartitionScope,
} from '@navide/plugin-contracts'
import { PluginError } from '@navide/plugin-contracts'

export { PluginError } from '@navide/plugin-contracts'
export type {
  Disposable,
  JsonValue,
  Params,
  Payload,
  PluginErrorCode,
  PublicEvent,
  PublicMethod,
  Result,
  StorageGetResult,
  StoragePartitionScope,
} from '@navide/plugin-contracts'

export interface WorkspaceTarget {
  readonly path: string
  readonly kind: 'file' | 'directory'
}

export interface PluginAppearanceSnapshot {
  readonly locale: string
  readonly colorScheme: 'light' | 'dark'
  readonly themeId: string
  readonly uiScale: number
}

export interface PluginCredentialAccount {
  readonly id: string
  readonly provider: 'github' | 'gitlab' | 'other'
  readonly host: string
  readonly label: string
}

export interface PluginWorkspaceGrant {
  readonly grantId: string
  readonly path: string
}

export interface PluginContext {
  readonly pluginId: string
  readonly packageVersion: string
  readonly contributionKey: string
  readonly instanceId: string
  readonly workspaceId: string
  readonly startupDeadlineMs: number
  readonly capabilities: {
    invoke<M extends PublicMethod>(method: M, params: Params<M>): Promise<Result<M>>
  }
  readonly events: {
    subscribe<E extends PublicEvent>(
      event: E,
      listener: (payload: Payload<E>) => void
    ): Disposable
  }
  readonly lifecycle: {
    reportProgress(message: string): void
  }
  readonly view: {
    hide(): Promise<void>
    openContribution(contributionKey: string): Promise<void>
    setBadge(value: string | number | null): Promise<void>
  }
  readonly appearance: {
    current(): PluginAppearanceSnapshot
    subscribe(listener: (snapshot: PluginAppearanceSnapshot) => void): Disposable
  }
  readonly credentials: {
    listAccounts(): Promise<readonly PluginCredentialAccount[]>
    workspaceBinding(): Promise<string | null>
    openAccountSettings(): Promise<void>
  }
  readonly ui: {
    pickWorkspace(): Promise<PluginWorkspaceGrant | null>
    openWorkspace(grant: PluginWorkspaceGrant): Promise<void>
    revealInWorkspace(path: string): Promise<void>
    openTextPreview(title: string, content: string): Promise<void>
    openSettingsSection(section: string): Promise<void>
  }
  readonly targets: {
    subscribe(listener: (target: WorkspaceTarget | null) => void): Disposable
  }
}

export interface PluginBackendCallOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface PluginBackendSubscription extends Disposable {
  /** Resolves after the Host has accepted the event subscription. */
  readonly ready: Promise<void>
  /** Rejects when the Host/backend ends the subscription unexpectedly. */
  readonly settled: Promise<void>
}

/**
 * Public package-local backend surface. The implementation is supplied by the
 * Host runtime; package code never receives IPC, stdio, HTTP, or executable
 * handles.
 */
export interface PluginBackendClient {
  call<Result extends JsonValue>(
    name: string,
    args: JsonValue,
    options?: PluginBackendCallOptions
  ): Promise<Result>
  subscribe<Payload extends JsonValue>(
    event: string,
    listener: (payload: Payload) => void
  ): PluginBackendSubscription
}

export class PluginBackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PluginBackendError'
  }
}

interface RuntimeBackendResponse {
  reqId: string
  ok: boolean
  result?: JsonValue
  error?: { code: string; message?: string }
}

interface RuntimeBackendSubscription {
  readonly ready: Promise<void>
  readonly settled: Promise<void>
  dispose(): void
}

interface RuntimeCapabilityResponse {
  reqId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message?: string }
}

interface RuntimeCapabilityBridge {
  callCapability(
    namespace: string,
    method: string,
    args?: unknown,
  ): Promise<RuntimeCapabilityResponse>
  on(type: string, listener: (payload: unknown) => void): () => void
}

export type PluginEditorFileTarget = {
  /** Host-validated workspace-relative path. */
  path: string
  /** Optional positive, 1-based position. */
  line?: number
  column?: number
  /** Opaque Host-issued source item, scoped to this paired receiver. */
  sourceItem: string
}

export type PluginEditorTargetOpenResult = { opened: boolean }

export type PluginReceiverCloseGuardReason =
  | 'receiver-item-batch'
  | 'native-window-close'
  | 'reload'
  | 'quit'

export type PluginReceiverCloseGuard = {
  protocolVersion: 1
  onPrepare(reason: PluginReceiverCloseGuardReason): Promise<PluginDetailCloseDecision>
  onCancelled(): void
}

export type PluginReceiverRegistration = {
  protocolVersion: 1
  locations: Array<'left' | 'detail'>
  editorTargets?: {
    protocolVersion: 1
    /** Receives only Host-paired editor targets while this registration is live. */
    onOpen(target: PluginEditorFileTarget): Promise<PluginEditorTargetOpenResult>
  }
  closeGuard?: PluginReceiverCloseGuard
}

export type PluginReceiverOffer =
  | {
    offerId: string
    contributionKey: string
    title: string
    /** Host-authored presentation location; never inferred from a contribution key. */
    location: 'left'
  }
  | {
    offerId: string
    contributionKey: string
    title: string
    /** Host-authored presentation location; never inferred from a contribution key. */
    location: 'detail'
    /** Host-derived opaque canonical-resource identity for receiver-local deduplication. */
    resourceKey: string
  }

export type PluginReceiverOfferAcceptance =
  | { accepted: true; itemId: string }
  | { accepted: false; reason: 'refused' | 'busy' | 'unavailable' | 'timeout' }

export type PluginDetailTargetUpdate = {
  revision: number
  target: JsonValue
}

export type PluginDetailTargetDecision =
  | { applied: true }
  | { applied: false; reason: 'refused' | 'busy' }

/** Receiver-selected DOM host. It controls presentation only, never provider authority. */
export type PluginReceiverMountPlacement = {
  mountHostId: string
}

export type PluginReceiverCloseResult =
  | { closed: true }
  | { closed: false; reason: 'refused' | 'busy' | 'unavailable' | 'timeout' }

export type PluginOpenDetailParams = {
  contributionKey: string
  target: JsonValue
}

export type PluginOpenDetailResult =
  | { opened: true }
  | {
    opened: false
    reason: 'provider-missing' | 'provider-unavailable' | 'receiver-unavailable' | 'receiver-unpaired' | 'receiver-refused'
  }

export type PluginDetailCloseRequest = {
  closeId: string
  itemId: string
  reason: 'user'
  documentGeneration: number
}

export type PluginDetailCloseDecision =
  | { accepted: true; reason: 'accepted' }
  | { accepted: false; reason: 'refused' | 'busy' }

export type PluginReceiverItemClosed = {
  itemId: string
  documentGeneration: number
}

export type PluginReceiverLeftContribution = {
  contributionKey: string
  title: string
  /** Host-resolved icon URL for the contribution, when its manifest declares
   *  one. Display metadata only: the receiver never learns which plugin owns it. */
  icon: string | null
  /** The icon is a single-colour silhouette to paint in the current text colour. */
  iconMonochrome: boolean
}

export interface PluginViewReceiver {
  /** Lists Host-catalogued left contributions eligible for this receiver. */
  listLeftContributions(): Promise<readonly PluginReceiverLeftContribution[]>
  /** Requests a Host-issued offer; the offer arrives through this receiver's registration callback. */
  openLeft(contributionKey: string): Promise<void>
  /** Accepts a matching detail offer by revealing an existing receiver item. */
  acceptExistingOffer(offerId: string, itemId: string): Promise<PluginReceiverOfferAcceptance>
  mount(offerId: string, placement: PluginReceiverMountPlacement): Promise<{ itemId: string }>
  /** Requests the exact provider's guarded normal close; item removal remains Host-notified. */
  requestClose(itemId: string): Promise<PluginReceiverCloseResult>
  /** Requests one all-or-none guarded close transaction without exposing its Host identity. */
  requestCloseTransaction(itemIds: readonly string[]): Promise<PluginReceiverCloseResult>
  /** Idempotently revoke one exact failed offered item without affecting siblings. */
  abort(itemId: string): Promise<void>
  /** Fires after the trusted preload removes the exact item host. */
  onItemClosed(listener: (item: PluginReceiverItemClosed) => void): Disposable
  dispose(): Promise<void>
}

export interface PluginViewRuntimeClient {
  ready(): void
  hide(): void
  registerReceiver(registration: PluginReceiverRegistration, onOffer: (offer: PluginReceiverOffer) => void): Promise<PluginViewReceiver>
  /** Requests the declared paired detail contribution; the Host keeps the target private from the receiver. */
  openDetail(params: PluginOpenDetailParams): Promise<PluginOpenDetailResult>
  /** Delivers a revisioned target to this exact admitted detail provider. */
  onDetailTarget(listener: (update: PluginDetailTargetUpdate) => PluginDetailTargetDecision | Promise<PluginDetailTargetDecision>): Disposable
  /** Lets a provider decide an exact normal close transaction. */
  onPrepareClose(listener: (request: PluginDetailCloseRequest) => PluginDetailCloseDecision | Promise<PluginDetailCloseDecision>): Disposable
  /** Notifies a provider to release a cancelled close preparation without exposing Host identity. */
  onCloseCancelled(listener: () => void): Disposable
  /** Open an installed window contribution using Host-validated target authority. */
  openContributionWindow(params: Params<'ui.openPluginWindow'>): Promise<Result<'ui.openPluginWindow'>>
  onOpenTarget(listener: (target: Record<string, string>) => void): Disposable
  onBackendStatus(listener: (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void): Disposable
}

type PluginReceiverRegistrationWire = {
  protocolVersion: 1
  locations: Array<'left' | 'detail'>
  editorTargets?: { protocolVersion: 1 }
  closeGuard?: { protocolVersion: 1 }
}

interface RuntimeViewBridge {
  ready(): void
  hideSelf(): void
  registerReceiver(registration: PluginReceiverRegistrationWire): Promise<{ receiverId: string }>
  listReceiverLeftContributions(receiverId: string): Promise<PluginReceiverLeftContribution[]>
  openReceiverLeft(receiverId: string, contributionKey: string): Promise<void>
  acceptExistingReceiverOffer(receiverId: string, offerId: string, itemId: string): Promise<PluginReceiverOfferAcceptance>
  mountReceiver(receiverId: string, offerId: string, placement: PluginReceiverMountPlacement): Promise<{ itemId: string }>
  requestCloseReceiver(receiverId: string, itemId: string): Promise<PluginReceiverCloseResult>
  requestCloseReceiverTransaction(receiverId: string, itemIds: readonly string[]): Promise<PluginReceiverCloseResult>
  abortReceiverItem(receiverId: string, itemId: string): Promise<void>
  onReceiverOffer(receiverId: string, listener: (offer: PluginReceiverOffer) => void): () => void
  onReceiverEditorTarget(receiverId: string, listener: (target: PluginEditorFileTarget) => Promise<PluginEditorTargetOpenResult>): () => void
  onReceiverCloseGuard(
    receiverId: string,
    onPrepare: (reason: PluginReceiverCloseGuardReason) => Promise<PluginDetailCloseDecision>,
    onCancelled: () => void,
  ): () => void
  onReceiverItemClosed(receiverId: string, listener: (item: PluginReceiverItemClosed) => void): () => void
  disposeReceiver(receiverId: string): Promise<void>
  onOpenTarget(listener: (target: Record<string, string>) => void): () => void
}

function runtimeCapabilityBridge(): RuntimeCapabilityBridge {
  const bridge = (globalThis as unknown as { nav?: Partial<RuntimeCapabilityBridge> }).nav
  if (
    !bridge ||
    typeof bridge.callCapability !== 'function' ||
    typeof bridge.on !== 'function'
  ) {
    throw new PluginError('BACKEND_UNAVAILABLE', 'Plugin capability runtime is unavailable.')
  }
  return bridge as RuntimeCapabilityBridge
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}

function runtimeViewBridge(): RuntimeViewBridge {
  const bridge = (globalThis as unknown as { nav?: Partial<RuntimeViewBridge> }).nav
  if (
    !bridge ||
    typeof bridge.ready !== 'function' ||
    typeof bridge.onOpenTarget !== 'function'
  ) {
    throw new PluginError('BACKEND_UNAVAILABLE', 'Plugin view runtime is unavailable.')
  }
  return bridge as RuntimeViewBridge
}

/** Public lifecycle/target adapter for package views. The private preload
 * transport remains an SDK implementation detail. */
export function createPluginViewRuntimeClient(): PluginViewRuntimeClient {
  type CloseRecord = {
    phase: 'pending' | 'accepted' | 'cancelled' | 'busy'
    owner: object
  }
  const closeRecords = new Map<string, CloseRecord>()
  let closeBarrier: CloseRecord | null = null
  let closePrepareSubscriptions = 0
  let closeCancellationUnsubscribe: (() => void) | null = null
  const closeCancelledListeners = new Set<() => void>()
  const notifyCloseCancelled = (): void => {
    for (const listener of closeCancelledListeners) {
      try {
        listener()
      } catch {
        // Cancellation release listeners are isolated from one another.
      }
    }
  }
  const maybeDisposeCloseCancellationSubscription = (): void => {
    if (
      closePrepareSubscriptions !== 0 ||
      closeCancelledListeners.size !== 0 ||
      closeRecords.size !== 0 ||
      closeBarrier !== null ||
      !closeCancellationUnsubscribe
    ) return
    closeCancellationUnsubscribe()
    closeCancellationUnsubscribe = null
  }
  const retireCloseRecord = (closeId: string, record: CloseRecord): void => {
    if (closeRecords.get(closeId) === record) closeRecords.delete(closeId)
    if (closeBarrier === record) closeBarrier = null
    maybeDisposeCloseCancellationSubscription()
  }
  const ensureCloseCancellationSubscription = (): void => {
    if (closeCancellationUnsubscribe) return
    closeCancellationUnsubscribe = runtimeCapabilityBridge().on('plugin:view:close-cancelled', payload => {
      const closeId = typeof (payload as { closeId?: unknown } | null)?.closeId === 'string'
        ? (payload as { closeId: string }).closeId
        : ''
      if (!closeId) return
      const record = closeRecords.get(closeId)
      if (!record || record.phase === 'cancelled') return
      if (record.phase === 'busy') {
        retireCloseRecord(closeId, record)
        return
      }
      const wasAccepted = record.phase === 'accepted'
      record.phase = 'cancelled'
      notifyCloseCancelled()
      if (wasAccepted) retireCloseRecord(closeId, record)
    })
  }
  return Object.freeze({
    openDetail: async (params: PluginOpenDetailParams): Promise<PluginOpenDetailResult> => {
      const response = await runtimeCapabilityBridge().callCapability('ui', 'openDetail', params)
      if (!response || typeof response.ok !== 'boolean') {
        throw new PluginError('INTERNAL_ERROR', 'Plugin detail request returned an invalid response.')
      }
      if (!response.ok) {
        throw new PluginError(
          publicCapabilityError(response.error?.code ?? 'INTERNAL_ERROR'),
          response.error?.message ?? 'Plugin detail request failed.',
        )
      }
      const result = response.result as PluginOpenDetailResult
      if (
        !result ||
        typeof result !== 'object' ||
        typeof result.opened !== 'boolean' ||
        (result.opened === false && ![
          'provider-missing', 'provider-unavailable', 'receiver-unavailable', 'receiver-unpaired', 'receiver-refused',
        ].includes(result.reason))
      ) {
        throw new PluginError('INTERNAL_ERROR', 'Plugin detail request returned an invalid result.')
      }
      return result
    },
    onDetailTarget(listener: (update: PluginDetailTargetUpdate) => PluginDetailTargetDecision | Promise<PluginDetailTargetDecision>): Disposable {
      if (typeof listener !== 'function') {
        throw new PluginError('INVALID_ARGUMENT', 'Plugin detail-target listener is invalid.')
      }
      let active = true
      let highestSeenRevision = -1
      let lastAppliedRevision = -1
      let pendingTargetId: string | null = null
      const targetRecords = new Map<string, { revision: number; acknowledged: boolean }>()
      const resolve = (targetId: string, revision: number, decision: PluginDetailTargetDecision): void => {
        const record = targetRecords.get(targetId)
        if (!active || !record || record.revision !== revision || record.acknowledged) return
        record.acknowledged = true
        void runtimeCapabilityBridge().callCapability('ui', 'resolveDetailTarget', {
          targetId,
          revision,
          decision,
        }).catch(() => undefined)
      }
      const unsubscribe = runtimeCapabilityBridge().on('plugin:view:detail-target', payload => {
        const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : null
        const targetId = typeof record?.targetId === 'string' ? record.targetId : ''
        const revision = record?.revision
        const target = record?.target
        if (!active || !targetId || typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || !isJsonValue(target)) return
        if (targetRecords.has(targetId)) return
        targetRecords.set(targetId, { revision, acknowledged: false })
        if (revision <= highestSeenRevision) {
          resolve(targetId, revision, { applied: false, reason: 'refused' })
          return
        }
        highestSeenRevision = revision
        if (pendingTargetId !== null) {
          resolve(targetId, revision, { applied: false, reason: 'busy' })
          return
        }
        pendingTargetId = targetId
        const targetRecord = targetRecords.get(targetId)!
        const skipped = Symbol('detail-target-skipped')
        void Promise.resolve().then(() => {
          if (
            !active ||
            pendingTargetId !== targetId ||
            targetRecords.get(targetId) !== targetRecord ||
            targetRecord.acknowledged
          ) return skipped
          return listener({ revision, target })
        }).then(
          (decision) => {
            if (decision === skipped || !active || targetRecords.get(targetId) !== targetRecord) return
            if (pendingTargetId === targetId) pendingTargetId = null
            if (
              !decision ||
              typeof decision !== 'object' ||
              (decision.applied !== true && decision.applied !== false) ||
              (decision.applied === false && decision.reason !== 'refused' && decision.reason !== 'busy')
            ) {
              resolve(targetId, revision, { applied: false, reason: 'refused' })
              return
            }
            if (decision.applied) {
              if (revision <= lastAppliedRevision) {
                resolve(targetId, revision, { applied: false, reason: 'refused' })
                return
              }
              lastAppliedRevision = revision
            }
            resolve(targetId, revision, decision)
          },
          () => {
            if (!active || targetRecords.get(targetId) !== targetRecord) return
            if (pendingTargetId === targetId) pendingTargetId = null
            resolve(targetId, revision, { applied: false, reason: 'refused' })
          },
        )
      })
      return Object.freeze({ dispose: () => {
        if (!active) return
        active = false
        pendingTargetId = null
        targetRecords.clear()
        unsubscribe()
      } })
    },
    onPrepareClose(listener: (request: PluginDetailCloseRequest) => PluginDetailCloseDecision | Promise<PluginDetailCloseDecision>): Disposable {
      if (typeof listener !== 'function') {
        throw new PluginError('INVALID_ARGUMENT', 'Plugin close-preparation listener is invalid.')
      }
      ensureCloseCancellationSubscription()
      closePrepareSubscriptions += 1
      let active = true
      const owner = {}
      const resolve = (request: PluginDetailCloseRequest, record: CloseRecord, decision: PluginDetailCloseDecision): void => {
        if (!active || closeRecords.get(request.closeId) !== record || record.phase !== 'pending') return
        if (decision.accepted) record.phase = 'accepted'
        else retireCloseRecord(request.closeId, record)
        void runtimeCapabilityBridge().callCapability('ui', 'resolveDetailClose', {
          closeId: request.closeId,
          itemId: request.itemId,
          decision,
        }).catch(() => undefined)
      }
      const resolveBusy = (request: PluginDetailCloseRequest, record: CloseRecord): void => {
        if (!active || closeRecords.get(request.closeId) !== record || record.phase !== 'busy') return
        void runtimeCapabilityBridge().callCapability('ui', 'resolveDetailClose', {
          closeId: request.closeId,
          itemId: request.itemId,
          decision: { accepted: false, reason: 'busy' },
        }).catch(() => undefined).finally(() => retireCloseRecord(request.closeId, record))
      }
      const unsubscribe = runtimeCapabilityBridge().on('plugin:view:close-request', payload => {
        const request = payload as Partial<PluginDetailCloseRequest> | null
        if (
          !active ||
          !request ||
          typeof request.closeId !== 'string' ||
          typeof request.itemId !== 'string' ||
          request.reason !== 'user' ||
          typeof request.documentGeneration !== 'number' ||
          !Number.isInteger(request.documentGeneration) ||
          request.documentGeneration < 0 ||
          closeRecords.has(request.closeId)
        ) return
        const exactRequest = request as PluginDetailCloseRequest
        if (closeBarrier !== null) {
          const busyRecord: CloseRecord = { phase: 'busy', owner }
          closeRecords.set(exactRequest.closeId, busyRecord)
          resolveBusy(exactRequest, busyRecord)
          return
        }
        const record: CloseRecord = { phase: 'pending', owner }
        closeRecords.set(exactRequest.closeId, record)
        closeBarrier = record
        void Promise.resolve().then(() => {
          if (!active || closeRecords.get(exactRequest.closeId) !== record || record.phase !== 'pending') return null
          return listener(exactRequest)
        }).then((decision) => {
          if (!active || closeRecords.get(exactRequest.closeId) !== record) return
          if (decision === null) {
            if (record.phase === 'cancelled') retireCloseRecord(exactRequest.closeId, record)
            return
          }
          if (record.phase === 'cancelled') {
            if (decision && typeof decision === 'object' && decision.accepted === true && decision.reason === 'accepted') {
              notifyCloseCancelled()
            }
            retireCloseRecord(exactRequest.closeId, record)
            return
          }
          if (
            !decision ||
            typeof decision !== 'object' ||
            (decision.accepted !== true && decision.accepted !== false) ||
            (decision.accepted === true && decision.reason !== 'accepted') ||
            (decision.accepted === false && decision.reason !== 'refused' && decision.reason !== 'busy')
          ) {
            resolve(exactRequest, record, { accepted: false, reason: 'refused' })
            return
          }
          resolve(exactRequest, record, decision)
        }).catch(() => {
          if (!active || closeRecords.get(exactRequest.closeId) !== record) return
          if (record.phase === 'cancelled') {
            retireCloseRecord(exactRequest.closeId, record)
            return
          }
          resolve(exactRequest, record, { accepted: false, reason: 'refused' })
        })
      })
      return Object.freeze({ dispose: () => {
        if (!active) return
        active = false
        closePrepareSubscriptions -= 1
        for (const [closeId, record] of closeRecords) {
          if (record.owner === owner) retireCloseRecord(closeId, record)
        }
        unsubscribe()
        maybeDisposeCloseCancellationSubscription()
      } })
    },
    onCloseCancelled(listener: () => void): Disposable {
      if (typeof listener !== 'function') {
        throw new PluginError('INVALID_ARGUMENT', 'Plugin close-cancellation listener is invalid.')
      }
      ensureCloseCancellationSubscription()
      closeCancelledListeners.add(listener)
      return Object.freeze({ dispose: () => {
        closeCancelledListeners.delete(listener)
        maybeDisposeCloseCancellationSubscription()
      } })
    },
    openContributionWindow(params: Params<'ui.openPluginWindow'>): Promise<Result<'ui.openPluginWindow'>> {
      return createPluginCapabilityClient().capabilities.invoke('ui.openPluginWindow', params)
    },
    ready(): void {
      runtimeViewBridge().ready()
    },
    hide(): void {
      runtimeViewBridge().hideSelf()
    },
    async registerReceiver(registration: PluginReceiverRegistration, onOffer: (offer: PluginReceiverOffer) => void): Promise<PluginViewReceiver> {
      if (typeof onOffer !== 'function') throw new PluginError('INVALID_ARGUMENT', 'Receiver offer listener is invalid.')
      const editorTargets = registration.editorTargets
      if (editorTargets && (editorTargets.protocolVersion !== 1 || typeof editorTargets.onOpen !== 'function')) {
        throw new PluginError('INVALID_ARGUMENT', 'Receiver editor-target listener is invalid.')
      }
      const closeGuard = registration.closeGuard
      if (
        closeGuard &&
        (closeGuard.protocolVersion !== 1 || typeof closeGuard.onPrepare !== 'function' || typeof closeGuard.onCancelled !== 'function')
      ) {
        throw new PluginError('INVALID_ARGUMENT', 'Receiver close guard is invalid.')
      }
      const bridge = runtimeViewBridge()
      const { receiverId } = await bridge.registerReceiver({
        protocolVersion: registration.protocolVersion,
        locations: registration.locations,
        ...(editorTargets ? { editorTargets: { protocolVersion: 1 } } : {}),
        ...(closeGuard ? { closeGuard: { protocolVersion: 1 } } : {}),
      })
      let disposed = false
      const offers = bridge.onReceiverOffer(receiverId, onOffer)
      const editorTargetSubscription = editorTargets
        ? bridge.onReceiverEditorTarget(receiverId, (target) =>
          Promise.resolve().then(() => {
            if (disposed) return { opened: false }
            return editorTargets.onOpen(target)
          }).then(
            (result): PluginEditorTargetOpenResult =>
              !disposed && result && typeof result.opened === 'boolean' ? result : { opened: false },
            (): PluginEditorTargetOpenResult => ({ opened: false }),
          )
        )
        : () => undefined
      const closeGuardSubscription = closeGuard
        ? bridge.onReceiverCloseGuard(
          receiverId,
          (reason) => Promise.resolve().then(() => {
            if (disposed) return { accepted: false, reason: 'busy' } as const
            return closeGuard.onPrepare(reason)
          }).then(
            (decision): PluginDetailCloseDecision =>
              !disposed && decision && typeof decision === 'object' &&
              ((decision.accepted === true && decision.reason === 'accepted') ||
                (decision.accepted === false && (decision.reason === 'refused' || decision.reason === 'busy')))
                ? decision
                : { accepted: false, reason: 'refused' },
            (): PluginDetailCloseDecision => ({ accepted: false, reason: 'refused' }),
          ),
          () => {
            if (!disposed) {
              try {
                closeGuard.onCancelled()
              } catch {
                // A receiver release callback cannot disrupt private close cleanup.
              }
            }
          },
        )
        : () => undefined
      const unavailable = (): Promise<never> => Promise.reject(new PluginError('PLUGIN_STOPPING', 'Receiver is disposed.'))
      return Object.freeze({
        listLeftContributions: () => disposed
          ? unavailable()
          : bridge.listReceiverLeftContributions(receiverId),
        openLeft: (contributionKey: string) => disposed
          ? unavailable()
          : bridge.openReceiverLeft(receiverId, contributionKey),
        acceptExistingOffer: (offerId: string, itemId: string) => disposed
          ? unavailable()
          : bridge.acceptExistingReceiverOffer(receiverId, offerId, itemId),
        mount: (offerId: string, placement: PluginReceiverMountPlacement) => disposed
          ? unavailable()
          : bridge.mountReceiver(receiverId, offerId, placement),
        requestClose: (itemId: string) => disposed
          ? unavailable()
          : bridge.requestCloseReceiver(receiverId, itemId),
        requestCloseTransaction: (itemIds: readonly string[]) => disposed
          ? unavailable()
          : bridge.requestCloseReceiverTransaction(receiverId, itemIds),
        abort: (itemId: string) => disposed
          ? unavailable()
          : bridge.abortReceiverItem(receiverId, itemId),
        onItemClosed: (listener: (item: PluginReceiverItemClosed) => void): Disposable => {
          if (disposed) {
            throw new PluginError('PLUGIN_STOPPING', 'Receiver is disposed.')
          }
          if (typeof listener !== 'function') {
            throw new PluginError('INVALID_ARGUMENT', 'Receiver item-close listener is invalid.')
          }
          return Object.freeze({ dispose: bridge.onReceiverItemClosed(receiverId, listener) })
        },
        dispose: async () => {
          if (disposed) return
          disposed = true
          offers()
          editorTargetSubscription()
          closeGuardSubscription()
          await bridge.disposeReceiver(receiverId)
        },
      })
    },
    onOpenTarget(listener: (target: Record<string, string>) => void): Disposable {
      if (typeof listener !== 'function') {
        throw new PluginError('INVALID_ARGUMENT', 'Plugin target listener is invalid.')
      }
      return Object.freeze({ dispose: runtimeViewBridge().onOpenTarget(listener) })
    },
    onBackendStatus(listener: (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void): Disposable {
      return Object.freeze({ dispose: runtimeCapabilityBridge().on('nav.backend_status', payload => {
        const status = (payload as { status?: unknown } | null)?.status
        if (status === 'connecting' || status === 'connected' || status === 'disconnected' || status === 'error') {
          listener(status)
        }
      }) })
    },
  })
}

// Standalone forms of the stateless PluginViewRuntimeClient methods. A bundler
// keeps only the ones a view imports; the client object keeps every method.

/** Same as `createPluginViewRuntimeClient().ready()`. */
export function viewReady(): void {
  runtimeViewBridge().ready()
}

/** Same as `createPluginViewRuntimeClient().hide()`. */
export function hideView(): void {
  runtimeViewBridge().hideSelf()
}

/** Same as `createPluginViewRuntimeClient().openContributionWindow()`. */
export function openContributionWindow(params: Params<'ui.openPluginWindow'>): Promise<Result<'ui.openPluginWindow'>> {
  return createPluginCapabilityClient().capabilities.invoke('ui.openPluginWindow', params)
}

/** Same as `createPluginViewRuntimeClient().onOpenTarget()`. */
export function onOpenTarget(listener: (target: Record<string, string>) => void): Disposable {
  if (typeof listener !== 'function') {
    throw new PluginError('INVALID_ARGUMENT', 'Plugin target listener is invalid.')
  }
  return Object.freeze({ dispose: runtimeViewBridge().onOpenTarget(listener) })
}

/** Same as `createPluginViewRuntimeClient().onBackendStatus()`. */
export function onBackendStatus(listener: (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void): Disposable {
  return Object.freeze({ dispose: runtimeCapabilityBridge().on('nav.backend_status', payload => {
    const status = (payload as { status?: unknown } | null)?.status
    if (status === 'connecting' || status === 'connected' || status === 'disconnected' || status === 'error') {
      listener(status)
    }
  }) })
}

function publicMethodAddress(method: PublicMethod): { namespace: string; name: string } {
  const separator = method.indexOf('.')
  if (separator < 1 || separator === method.length - 1) {
    throw new PluginError('METHOD_NOT_FOUND', `Invalid public capability '${method}'.`)
  }
  return { namespace: method.slice(0, separator), name: method.slice(separator + 1) }
}

function publicCapabilityError(code: string): PluginErrorCode {
  switch (code) {
    case 'CAP_DENIED': return 'CAPABILITY_DENIED'
    case 'UNKNOWN': return 'METHOD_NOT_FOUND'
    case 'BAD_REQUEST': return 'INVALID_ARGUMENT'
    case 'BACKEND_ERROR': return 'BACKEND_UNAVAILABLE'
    case 'CAPABILITY_DENIED':
    case 'METHOD_NOT_FOUND':
    case 'INVALID_ARGUMENT':
    case 'WORKSPACE_SCOPE_VIOLATION':
    case 'USER_CANCELLED':
    case 'TIMEOUT':
    case 'BACKEND_UNAVAILABLE':
    case 'PLUGIN_STOPPING':
    case 'STORAGE_QUOTA_EXCEEDED':
    case 'RESOURCE_LIMIT':
    case 'INTERNAL_ERROR':
      return code
    default:
      return 'INTERNAL_ERROR'
  }
}

/**
 * Public capability/event runtime for package frontends. The private preload
 * transport is resolved inside the SDK; package code receives only the typed
 * capability and Disposable seams declared by PluginContext.
 */
export function createPluginCapabilityClient(): Pick<PluginContext, 'capabilities' | 'events'> {
  return Object.freeze({
    capabilities: Object.freeze({
      async invoke<M extends PublicMethod>(method: M, params: Params<M>): Promise<Result<M>> {
        const address = publicMethodAddress(method)
        const response = await runtimeCapabilityBridge().callCapability(
          address.namespace,
          address.name,
          params,
        )
        if (!response || typeof response.ok !== 'boolean') {
          throw new PluginError('INTERNAL_ERROR', 'Plugin capability returned an invalid response.')
        }
        if (!response.ok) {
          throw new PluginError(
            publicCapabilityError(response.error?.code ?? 'INTERNAL_ERROR'),
            response.error?.message ?? 'Plugin capability request failed.',
          )
        }
        return response.result as Result<M>
      },
    }),
    events: Object.freeze({
      subscribe<E extends PublicEvent>(
        event: E,
        listener: (payload: Payload<E>) => void,
      ): Disposable {
        if (typeof listener !== 'function') {
          throw new PluginError('INVALID_ARGUMENT', 'Plugin event listener is invalid.')
        }
        return Object.freeze({
          dispose: runtimeCapabilityBridge().on(
            event,
            listener as (payload: unknown) => void,
          ),
        })
      },
    }),
  })
}

interface RuntimeBackendBridge {
  callBackend(
    reqId: string,
    name: string,
    args: JsonValue,
    timeoutMs?: number,
  ): Promise<RuntimeBackendResponse>
  cancelBackend(reqId: string): void
  subscribeBackend(
    event: string,
    listener: (payload: JsonValue) => void,
  ): RuntimeBackendSubscription
}

function runtimeBackendBridge(): RuntimeBackendBridge {
  const bridge = (globalThis as unknown as { nav?: Partial<RuntimeBackendBridge> }).nav
  if (
    !bridge ||
    typeof bridge.callBackend !== 'function' ||
    typeof bridge.cancelBackend !== 'function' ||
    typeof bridge.subscribeBackend !== 'function'
  ) {
    throw new PluginBackendError('BACKEND_UNAVAILABLE', 'Plugin backend runtime is unavailable.')
  }
  return bridge as RuntimeBackendBridge
}

function runtimeRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new PluginBackendError('BACKEND_UNAVAILABLE', 'Plugin backend runtime is unavailable.')
  }
  return globalThis.crypto.randomUUID()
}

/** Create the runtime adapter backed by the Host-owned private preload bridge. */
export function createPluginBackendClient(): PluginBackendClient {
  return Object.freeze({
    call<Result extends JsonValue>(
      name: string,
      args: JsonValue,
      options: PluginBackendCallOptions = {},
    ): Promise<Result> {
      const bridge = runtimeBackendBridge()
      const reqId = runtimeRequestId()
      return new Promise<Result>((resolve, reject) => {
        let settled = false
        const cleanup = (): void => {
          options.signal?.removeEventListener('abort', abort)
        }
        const abort = (): void => {
          if (settled) return
          settled = true
          cleanup()
          bridge.cancelBackend(reqId)
          reject(new PluginBackendError('USER_CANCELLED', 'Plugin backend call was cancelled.'))
        }
        const settle = (action: () => void): void => {
          if (settled) return
          settled = true
          cleanup()
          action()
        }
        if (options.signal?.aborted) {
          abort()
          return
        }
        options.signal?.addEventListener('abort', abort, { once: true })
        let request: Promise<RuntimeBackendResponse>
        try {
          request = bridge.callBackend(reqId, name, args, options.timeoutMs)
        } catch (error) {
          settle(() => reject(error))
          return
        }
        void request.then((response) => {
          settle(() => {
            if (!response || response.reqId !== reqId || typeof response.ok !== 'boolean') {
              reject(new PluginBackendError('PROTOCOL_ERROR', 'Plugin backend returned an invalid response.'))
              return
            }
            if (!response.ok) {
              reject(new PluginBackendError(
                response.error?.code ?? 'BACKEND_UNAVAILABLE',
                response.error?.message ?? 'Plugin backend request failed.'
              ))
              return
            }
            resolve(response.result as Result)
          })
        }).catch((error: unknown) => {
          settle(() => reject(error))
        })
      })
    },
    subscribe<Payload extends JsonValue>(
      event: string,
      listener: (payload: Payload) => void,
    ): PluginBackendSubscription {
      if (!event || typeof listener !== 'function') {
        throw new PluginBackendError('INVALID_ARGUMENT', 'Plugin backend subscription is invalid.')
      }
      const registration = runtimeBackendBridge().subscribeBackend(
        event,
        listener as (payload: JsonValue) => void,
      )
      const asPluginBackendError = (error: unknown): PluginBackendError => {
        if (error instanceof PluginBackendError) return error
        const record = error as { code?: unknown }
        const code = typeof record?.code === 'string' ? record.code : 'BACKEND_UNAVAILABLE'
        const message = error instanceof Error
          ? error.message
          : 'Plugin backend subscription failed.'
        return new PluginBackendError(code, message)
      }
      const ready = registration.ready.catch((error: unknown) => {
        throw asPluginBackendError(error)
      })
      const settled = registration.settled.catch((error: unknown) => {
        throw asPluginBackendError(error)
      })
      return Object.freeze({ ready, settled, dispose: registration.dispose })
    },
  })
}

export interface PluginSettingsStore {
  get(key: string): Promise<JsonValue | undefined>
  set(key: string, value: JsonValue): Promise<void>
  delete(key: string): Promise<boolean>
}

export function createPluginSettingsStore(
  context: PluginContext,
  scope: StoragePartitionScope = 'plugin'
): PluginSettingsStore {
  return Object.freeze({
    async get(key: string) {
      const result = await context.capabilities.invoke('storage.get', { scope, key })
      return result.found ? result.value : undefined
    },
    async set(key: string, value: JsonValue) {
      await context.capabilities.invoke('storage.set', { scope, key, value })
    },
    delete(key: string) {
      return context.capabilities.invoke('storage.delete', { scope, key })
    },
  })
}

export interface PluginViewState<T extends JsonValue> {
  /** The last saved value, or the fallback when there is none or it cannot be read. Never rejects. */
  restore(): Promise<T>
  /** Remember `value`. Writes run one at a time; only the newest pending value is written. */
  save(value: T): void
  /** Resolves once every saved value has been written (or failed to). */
  flush(): Promise<void>
}

/** View state that survives a reload of the view: a Developer Mode reload, an
 *  update, or Restart Plugin. It lives in Host-managed storage under
 *  `view-state:<key>`, so it needs no permission. Call `ready()` without
 *  waiting for `restore()`; a reload is prepared in a view with no storage
 *  access, where `restore()` returns the fallback. */
export function createPluginViewState<T extends JsonValue>(
  key: string,
  fallback: T,
  options: {
    scope?: StoragePartitionScope
    context?: Pick<PluginContext, 'capabilities'>
  } = {},
): PluginViewState<T> {
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('view state key must be a non-empty string')
  const scope = options.scope ?? 'plugin'
  const storageKey = `view-state:${key}`
  let context = options.context
  const capabilities = () => (context ??= createPluginCapabilityClient()).capabilities
  let pending: { value: T } | null = null
  let writing: Promise<void> | null = null
  const drain = async (): Promise<void> => {
    while (pending) {
      const { value } = pending
      pending = null
      try {
        await capabilities().invoke('storage.set', { scope, key: storageKey, value })
      } catch {
        // State is a convenience: a failed write leaves the previous value.
      }
    }
    writing = null
  }
  return Object.freeze({
    async restore() {
      try {
        const result = await capabilities().invoke('storage.get', { scope, key: storageKey })
        return result.found ? (result.value as T) : fallback
      } catch {
        return fallback
      }
    },
    save(value: T) {
      pending = { value }
      writing ??= drain()
    },
    async flush() {
      await writing
    },
  })
}

export interface PluginDefinition {
  readonly activate: (context: PluginContext) => void | Promise<void>
}

export function definePlugin(
  activate: (context: PluginContext) => void | Promise<void>
): PluginDefinition {
  return Object.freeze({ activate })
}
