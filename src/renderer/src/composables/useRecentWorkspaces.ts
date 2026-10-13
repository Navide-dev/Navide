import { onScopeDispose, ref, shallowRef } from 'vue'
import type { useBackend } from './useBackend'

export interface RecentWorkspace {
  path: string
  name: string
  last_opened_at: string
  pinned: boolean
  last_known_state: string
  last_known_task: string
  /** Whether the folder still exists on disk (backend-annotated). */
  exists: boolean
}

/** What every workspace.* reply carries besides the list itself. */
interface RecentPayload {
  recent: RecentWorkspace[]
  /** Storage safety bound; null = off. */
  limit?: number | null
  /** How many entries that bound has ever trimmed. */
  trimmed?: number
}

/**
 * Per-window recent-workspaces cache. Loads from backend on connect and
 * refreshes whenever the backend broadcasts `workspace.recent_changed`
 * (triggered by any window's touch / pin / unpin). Reconnect-safe.
 * Mirrors the useRoles / useStages pattern.
 */
export function useRecentWorkspaces(backend: ReturnType<typeof useBackend>) {
  const recent = ref<RecentWorkspace[]>([])
  const path = shallowRef<string>('')
  const loaded = ref<boolean>(false)
  const loading = ref<boolean>(false)
  const error = ref<string>('')
  const limit = ref<number | null>(null)
  const trimmed = ref<number>(0)

  function apply(payload: RecentPayload): void {
    recent.value = payload.recent
    if (payload.limit !== undefined) limit.value = payload.limit
    if (payload.trimmed !== undefined) trimmed.value = payload.trimmed
  }

  let unsubChanged: (() => void) | null = null
  let unsubBackend: (() => void) | null = null

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const resp = await backend.send<RecentPayload & { path: string }>(
        'workspace.list_recent',
        {}
      )
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'failed to load recent workspaces'
        return
      }
      apply(resp.payload)
      path.value = resp.payload.path
      loaded.value = true
    } catch (err) {
      error.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  /** `open` lists workspaces open in a window, which the limit never trims. */
  async function touch(p: string, state = '', task = '', open: string[] = []): Promise<boolean> {
    try {
      const resp = await backend.send<RecentPayload>('workspace.touch', {
        path: p,
        state,
        task,
        open
      })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'touch failed'
        return false
      }
      apply(resp.payload)
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'touch failed'
      return false
    }
  }

  async function pin(p: string): Promise<boolean> {
    try {
      const resp = await backend.send<{ recent: RecentWorkspace[] }>('workspace.pin', { path: p })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'pin failed'
        return false
      }
      recent.value = resp.payload.recent
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'pin failed'
      return false
    }
  }

  async function unpin(p: string): Promise<boolean> {
    try {
      const resp = await backend.send<{ recent: RecentWorkspace[] }>('workspace.unpin', { path: p })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'unpin failed'
        return false
      }
      recent.value = resp.payload.recent
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'unpin failed'
      return false
    }
  }

  async function setLimit(next: number | null): Promise<boolean> {
    try {
      const resp = await backend.send<RecentPayload>('workspace.set_recent_limit', { limit: next })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'set limit failed'
        return false
      }
      apply(resp.payload)
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'set limit failed'
      return false
    }
  }

  async function remove(p: string): Promise<boolean> {
    try {
      const resp = await backend.send<{ recent: RecentWorkspace[] }>('workspace.remove', { path: p })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'remove failed'
        return false
      }
      recent.value = resp.payload.recent
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'remove failed'
      return false
    }
  }

  // Keep the cache in sync across windows.
  unsubChanged = backend.on('workspace.recent_changed', (raw) => {
    const payload = raw as RecentPayload
    if (payload?.recent) apply(payload)
  })

  // Initial load once connected; re-fetch on reconnect.
  let lastStatus = backend.status.value
  function maybeLoad(): void {
    if (backend.status.value === 'connected') void refresh()
  }
  maybeLoad()
  unsubBackend = (() => {
    const id = window.setInterval(() => {
      if (backend.status.value !== lastStatus) {
        lastStatus = backend.status.value
        maybeLoad()
      }
    }, 500)
    return () => window.clearInterval(id)
  })()

  onScopeDispose(() => {
    unsubChanged?.()
    unsubBackend?.()
  })

  return { recent, path, loaded, loading, error, limit, trimmed, refresh, touch, pin, unpin, remove, setLimit }
}
