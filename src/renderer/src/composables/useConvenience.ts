// Convenience features: the writes Navide makes outside its own data
// directory, each under a named feature the user allowed
// (docs/en-US/convenience-features.md). The backend owns the registry, the
// ledger and the log (`convenience.*` RPC, `convenience.changed` broadcast);
// this module mirrors `convenience.list` for the announcements centre and the
// overview in Settings → Extensions.
//
// Module-level singleton state, like useEvolve: App.vue calls
// useConvenience(backend) once, which subscribes to the broadcast and feeds
// the announcements; the overview reads the same state.
import { getCurrentScope, onScopeDispose, readonly, ref, watch } from 'vue'
import type { useBackend } from './useBackend'
import { useAnnouncements } from './useAnnouncements'

type Backend = ReturnType<typeof useBackend>
type Sender = Pick<Backend, 'send'>

export type ConvenienceState = 'allowed' | 'off'
export type ConvenienceReason = 'default' | 'user' | 'removed'
export type ConvenienceAction =
  | 'first' | 'repair' | 'reset' | 'removed' | 'removed-entry' | 'off' | 'allowed' | 'cleanup' | 'cleanup-failed' | 'prompt' | 'refused-unsafe' | 'refused-name' | 'refused-exclude' | 'retract' | 'retract-failed'

export interface ConvenienceTarget {
  path: string
  writtenAt: number
  present: boolean
}

export interface ConvenienceFeature {
  id: string
  /** Agent key, or "all". */
  cli: string
  toggleable: boolean
  state: ConvenienceState
  reason: ConvenienceReason
  targets: ConvenienceTarget[]
}

export interface ConvenienceLogEntry {
  id: number
  /** Epoch seconds. */
  at: number
  feature: string
  action: ConvenienceAction
  target: string
  /** Plain English for the log; UI text comes from i18n by feature/action. */
  detail: string
  backup: string
  notify: boolean
  /** Who triggered the row: "settings" (a Navide window), "ws-client" (any
   *  other client holding the backend token), "" for Navide's own writes.
   *  Absent from a backend older than the field. */
  source?: string
}

export interface ConvenienceUpgradeNotice {
  features: string[]
}

export interface ConvenienceSnapshot {
  features: ConvenienceFeature[]
  notices: ConvenienceLogEntry[]
  upgrade: ConvenienceUpgradeNotice | null
}

export type ConvenienceResult<T> = { ok: true; data: T } | { ok: false; error: string }

const RPC_TIMEOUT_MS = 15_000

const features = ref<ConvenienceFeature[]>([])
const notices = ref<ConvenienceLogEntry[]>([])
const upgrade = ref<ConvenienceUpgradeNotice | null>(null)
const loaded = ref(false)
const loadError = ref('')
/** Bumped by openConvenienceOverview(); the CLI Extensions pane switches to
 *  the overview tab when it changes (or on mount while it is unconsumed). */
const overviewRequest = ref(0)
let overviewConsumed = 0
let boundBackend: Backend | null = null
/** Replies can land out of order; only the newest read is applied. */
let readSeq = 0

async function call<T>(backend: Sender, type: string, payload: Record<string, unknown>): Promise<ConvenienceResult<T>> {
  try {
    const resp = await backend.send<T>(type, payload, RPC_TIMEOUT_MS)
    if (!resp.ok) return { ok: false, error: resp.error?.message || resp.error?.code || `${type} failed` }
    return { ok: true, data: resp.payload as T }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

function publish(): void {
  useAnnouncements().noteConvenience({
    features: features.value,
    notices: notices.value,
    upgrade: upgrade.value,
  })
}

/** Re-read `convenience.list` into the shared state. Uses the bound backend
 *  when none is given. */
export async function refreshConvenience(backend: Sender | null = boundBackend): Promise<boolean> {
  if (!backend) return false
  const seq = ++readSeq
  const res = await call<Partial<ConvenienceSnapshot>>(backend, 'convenience.list', {})
  if (seq !== readSeq) return res.ok
  if (!res.ok) {
    loadError.value = res.error
    return false
  }
  features.value = Array.isArray(res.data?.features) ? res.data.features : []
  notices.value = Array.isArray(res.data?.notices) ? res.data.notices : []
  upgrade.value = res.data?.upgrade ?? null
  loadError.value = ''
  loaded.value = true
  publish()
  return true
}

export async function convenienceHistory(
  backend: Sender,
  opts: { feature?: string; limit?: number } = {}
): Promise<ConvenienceResult<ConvenienceLogEntry[]>> {
  const payload: Record<string, unknown> = {}
  if (opts.feature) payload.feature = opts.feature
  if (opts.limit) payload.limit = opts.limit
  const res = await call<{ entries?: ConvenienceLogEntry[] }>(backend, 'convenience.history', payload)
  if (!res.ok) return res
  return { ok: true, data: Array.isArray(res.data?.entries) ? res.data.entries : [] }
}

/** Allow or turn off one feature. The reply's feature replaces the local
 *  copy at once; a full re-read follows for the notices it may have added. */
export async function setConvenienceAllowed(
  backend: Sender,
  id: string,
  allowed: boolean
): Promise<ConvenienceResult<ConvenienceFeature>> {
  const res = await call<{ feature?: ConvenienceFeature }>(backend, 'convenience.set', { id, allowed })
  if (!res.ok) return res
  const feature = res.data?.feature
  if (!feature) return { ok: false, error: 'convenience.set returned no feature' }
  features.value = features.value.map((f) => (f.id === feature.id ? feature : f))
  publish()
  void refreshConvenience(backend)
  return { ok: true, data: feature }
}

export async function ackConvenienceUpgrade(backend: Sender): Promise<boolean> {
  const res = await call<Record<string, never>>(backend, 'convenience.upgrade_ack', {})
  if (!res.ok) return false
  upgrade.value = null
  publish()
  return true
}

/** Ask the CLI Extensions pane to show the overview tab. The caller opens
 *  Settings at that page. */
export function openConvenienceOverview(): void {
  overviewRequest.value += 1
}

/** True once per openConvenienceOverview() call: the pane reads it on mount
 *  (it mounts on the first visit) and on every later request. */
export function consumeConvenienceOverviewRequest(): boolean {
  if (overviewRequest.value === overviewConsumed) return false
  overviewConsumed = overviewRequest.value
  return true
}

export function useConvenienceState() {
  return {
    features: readonly(features),
    notices: readonly(notices),
    upgrade: readonly(upgrade),
    loaded: readonly(loaded),
    loadError: readonly(loadError),
    overviewRequest: readonly(overviewRequest),
  }
}

/** App-level install: binds the backend, subscribes to `convenience.changed`
 *  and reads the list on every (re)connect. Call once, from App.vue.
 *  `agentLabel` names the CLI in the account prompt row. */
export function useConvenience(backend: Backend, opts: { agentLabel?: (agentKey: string) => string } = {}) {
  boundBackend = backend
  if (opts.agentLabel) useAnnouncements().setConvenienceAgentLabel(opts.agentLabel)

  const off = backend.on('convenience.changed', () => {
    void refreshConvenience(backend)
  })
  const stop = watch(
    () => backend.status.value,
    (status, previous) => {
      if (status === 'connected' && previous !== 'connected') void refreshConvenience(backend)
    },
    { immediate: true }
  )

  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (typeof off === 'function') off()
      stop()
      if (boundBackend === backend) boundBackend = null
    })
  }

  return {
    ...useConvenienceState(),
    refresh: () => refreshConvenience(backend),
    history: (o?: { feature?: string; limit?: number }) => convenienceHistory(backend, o),
    setAllowed: (id: string, allowed: boolean) => setConvenienceAllowed(backend, id, allowed),
    ackUpgrade: () => ackConvenienceUpgrade(backend),
  }
}

/** Test-only: forget the module state. */
export function __resetConvenienceForTest(): void {
  features.value = []
  notices.value = []
  upgrade.value = null
  loaded.value = false
  loadError.value = ''
  overviewRequest.value = 0
  overviewConsumed = 0
  boundBackend = null
  readSeq = 0
}
