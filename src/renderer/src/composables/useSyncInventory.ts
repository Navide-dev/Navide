/**
 * useSyncInventory.ts
 *
 * One shared read of `sync.inventory` for the Navide Cloud page: the per-scope
 * counts on the Sync sub-tab and the device list on the Devices sub-tab use
 * the same result, so opening both costs one round trip, not two (the backend
 * lists every remote scope per call). Concurrent refreshes share one request.
 */
import { ref } from 'vue'
import type { useBackend } from './useBackend'
import { readSyncInventory, type SyncInventoryView, type SyncRow } from '../lib/sharing'

type Backend = ReturnType<typeof useBackend>

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

export function useSyncInventory(backend: Backend) {
  function refresh(): Promise<void> {
    if (inflight) return inflight
    loading.value = true
    inflight = (async () => {
      try {
        const resp = await backend.send('sync.inventory', {})
        if (!resp.ok) {
          error.value = resp.error?.message ?? 'error'
          view.value = null
          return
        }
        error.value = ''
        view.value = readSyncInventory(resp.payload)
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
