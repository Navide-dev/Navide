// The Shipped Log panel (built-in navide.shipped-log): which workspace's panel
// is open, and the `ship_log.*` requests behind it. Module-level singleton
// state like useEvolve's, so the sidebar menus, the Schedule panel's system
// job row and App.vue's mount all open the same panel.
//
// Every request is sent from this module only, and only on a click in the
// panel: an agent reaches ui.* commands through ui_invoke, and none of these
// is one (see shippedLogNoUiActions.test.ts).
import { readonly, ref } from 'vue'
import type { useBackend } from './useBackend'

type Backend = ReturnType<typeof useBackend>

const RPC_TIMEOUT_MS = 15_000

export type ShipBasis = 'agent' | 'branch' | 'tag' | 'hook' | 'ci'
export type ShipSourceKind = 'commit' | 'config' | 'migration' | 'other'

export interface ShipItem {
  key: string
  at: number
  summary: string
  kind: 'added' | 'fixed' | 'changed' | 'recorded' | 'detected'
  bases: ShipBasis[]
  source_kind: ShipSourceKind
  hash: string
  short_hash: string
  ref?: string
  tags: string[]
  sensitive: boolean
  edited?: boolean
  config_label?: string
  detection_id?: number
  rule?: string
  pane?: string
}

export interface ShipReport {
  since: string
  until: string | null
  branch: string | null
  count: number
  omitted: number
  pending_detections: number
  warnings: string[]
  items: ShipItem[]
}

export interface ShipConfig {
  key: string
  label: string
  location: string
  environment: string
  note: string
  updated_at: number
  removed_at: number | null
}

export interface ShipDigestSettings {
  digest_enabled: boolean
  digest_at: string
  digest_tz: string
  digest_skip_empty: boolean
}

export interface ShipDigestState {
  settings: ShipDigestSettings
  job_id: string
  next_run_at: number | null
  last_run_at: number | null
  last_status: string | null
  last_skip_reason: string | null
}

export type ShipResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** The window choices the panel offers, as the backend's `since` words. */
export const SHIP_WINDOWS = ['今天', '昨天', '7d', '30d'] as const

const panelWorkspace = ref<string | null>(null)

export function openShippedLogPanel(workspace: string): void {
  if (workspace) panelWorkspace.value = workspace
}

export function closeShippedLogPanel(): void {
  panelWorkspace.value = null
}

export function useShippedLogPanel() {
  return { panelWorkspace: readonly(panelWorkspace), open: openShippedLogPanel, close: closeShippedLogPanel }
}

/** One `ship_log.*` request; the backend always answers a dict with `ok`. */
export async function shipLogCall<T>(
  backend: Backend,
  type: string,
  payload: Record<string, unknown>,
): Promise<ShipResult<T>> {
  try {
    const resp = await backend.send<T & { ok?: boolean; error?: string }>(type, payload, RPC_TIMEOUT_MS)
    const body = resp.payload as { ok?: boolean; error?: string } | null | undefined
    if (!resp.ok) return { ok: false, error: resp.error?.message ?? `${type} failed` }
    if (!body || body.ok === false) return { ok: false, error: body?.error ?? `${type} failed` }
    return { ok: true, data: resp.payload as T }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

export function __resetShippedLogForTest(): void {
  panelWorkspace.value = null
}
