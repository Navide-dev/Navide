/**
 * useSyncInventory.ts
 *
 * One shared read of `sync.inventory` for the Navide Cloud page: the per-scope
 * counts on the Sync sub-tab and the device list on the Devices sub-tab use
 * the same result. It asks one scope per request and only for the synced
 * asset scopes (prompts, MCP, skills): an inventory without a scope also
 * reads credentials, which this page has no business fetching. Concurrent
 * refreshes share one round.
 */
import { ref } from 'vue'
import type { useBackend } from './useBackend'
import {
  CLOUD_SCOPES,
  readSyncInventory,
  type SyncDevice,
  type SyncInventoryView,
  type SyncRow,
  type SyncScopeView,
} from '../lib/sharing'

type Backend = ReturnType<typeof useBackend>

/** Each scope is a server round trip; the default 10 s is too short on a slow link. */
const INVENTORY_TIMEOUT_MS = 30_000

const view = ref<SyncInventoryView | null>(null)
const error = ref('')
const loading = ref(false)
let inflight: Promise<void> | null = null

export interface ScopeCounts {
  local: number
  cloud: number
  inSync: number
  conflict: number
  /** The newest cloud write in this scope, or null when there is none. */
  lastWrite: { deviceId: string; at: string } | null
}

export function scopeCounts(items: SyncRow[]): ScopeCounts {
  let lastWrite: ScopeCounts['lastWrite'] = null
  for (const row of items) {
    if (row.remotePresent && row.updatedAt && (!lastWrite || row.updatedAt > lastWrite.at)) {
      lastWrite = { deviceId: row.deviceId, at: row.updatedAt }
    }
  }
  return {
    local: items.filter((row) => row.localPresent).length,
    cloud: items.filter((row) => row.remotePresent).length,
    inSync: items.filter((row) => row.state === 'in-sync').length,
    conflict: items.filter((row) => row.state === 'conflict').length,
    lastWrite,
  }
}

/** A time for display, or '—' when it is missing or not a time at all. */
export function formatWhen(at: string): string {
  if (!at) return '—'
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

type ScopeRead = { ok: true; view: SyncInventoryView } | { ok: false; message: string }

async function readScope(backend: Backend, scope: string): Promise<ScopeRead> {
  try {
    const resp = await backend.send('sync.inventory', { scope }, INVENTORY_TIMEOUT_MS)
    if (!resp.ok) return { ok: false, message: resp.error?.message ?? 'error' }
    return { ok: true, view: readSyncInventory(resp.payload) }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

function merge(reads: ScopeRead[]): SyncInventoryView {
  const scopes: Record<string, SyncScopeView> = {}
  const scopeEnabled: Record<string, boolean> = {}
  const devices = new Map<string, SyncDevice>()
  let anyConnected = false
  CLOUD_SCOPES.forEach((scope, i) => {
    const read = reads[i]
    if (!read.ok) {
      scopes[scope] = { scope, status: 'error', error: read.message, items: [] }
      return
    }
    if (read.view.status !== 'not-connected') anyConnected = true
    scopes[scope] = read.view.scopes[scope] ?? { scope, status: 'error', error: '', items: [] }
    if (scope in read.view.scopeEnabled) scopeEnabled[scope] = read.view.scopeEnabled[scope]
    for (const device of read.view.devices) {
      const known = devices.get(device.deviceId)
      devices.set(device.deviceId, {
        deviceId: device.deviceId,
        deviceName: device.deviceName || known?.deviceName || '',
        lastSeenAt: [device.lastSeenAt, known?.lastSeenAt ?? ''].sort().pop() ?? '',
        lastWriteAt: [device.lastWriteAt, known?.lastWriteAt ?? ''].sort().pop() ?? '',
      })
    }
  })
  return {
    status: anyConnected ? 'ok' : 'not-connected',
    scopes,
    devices: [...devices.values()].sort((a, b) => b.lastWriteAt.localeCompare(a.lastWriteAt)),
    scopeEnabled,
  }
}

export function useSyncInventory(backend: Backend) {
  function refresh(): Promise<void> {
    if (inflight) return inflight
    loading.value = true
    inflight = (async () => {
      try {
        const reads = await Promise.all(CLOUD_SCOPES.map((scope) => readScope(backend, scope)))
        const failed = reads.filter((read): read is { ok: false; message: string } => !read.ok)
        if (failed.length === reads.length) {
          error.value = failed[0]?.message ?? 'error'
          view.value = null
          return
        }
        error.value = ''
        view.value = merge(reads)
      } finally {
        loading.value = false
        inflight = null
      }
    })()
    return inflight
  }
  return { view, error, loading, refresh }
}

/** Test hook: forget the shared result between mounts. */
export function resetSyncInventoryForTest(): void {
  view.value = null
  error.value = ''
  loading.value = false
  inflight = null
}
