import { ref, watch, onScopeDispose, type Ref } from 'vue'
import type { useBackend } from './useBackend'
import type { GitStatusSnapshot } from './useGitStatusBadges'

export interface FsEntry {
  name: string
  rel_path: string
  is_dir: boolean
  is_hidden: boolean
  is_noise: boolean
}

interface ListDirResult {
  ok: boolean
  entries?: FsEntry[]
  truncated?: boolean
  error?: string
}

interface FetchDirResult {
  ok: boolean
  entries: FsEntry[]
  truncated: boolean
  error: string
}

const SHOW_HIDDEN_KEY = 'agentTeam.explorerShowHidden'

/** Minimum gap between window-focus refreshes (there is no fs watcher). */
const FOCUS_REFRESH_INTERVAL_MS = 5000

/**
 * useExplorer — lazy directory tree backed by the `fs.*` WebSocket API.
 *
 * State is per-instance (keyed off the given workspace). Children are loaded on
 * demand and cached; toggling `showHidden` or a `git.changed` event invalidates
 * the cache and reloads whatever is currently expanded. Git status is NOT
 * fetched here — the host merges it as an overlay via {@link statusFor}.
 *
 * Because there is no fs watcher, a window `focus` also refreshes the visible
 * tree (throttled; skipped while `opts.isRefreshBlocked()` is true, e.g. an
 * inline rename/create prompt is open).
 */
export function useExplorer(
  backend: ReturnType<typeof useBackend>,
  workspacePath: Ref<string>,
  opts?: { isRefreshBlocked?: () => boolean }
) {
  const childrenCache = ref<Map<string, FsEntry[]>>(new Map())
  const expanded = ref<Set<string>>(new Set())
  const loadingDirs = ref<Set<string>>(new Set())
  const error = ref('')
  /** Dirs whose last listing was capped by the backend (`truncated: true`). */
  const truncatedDirs = ref<Set<string>>(new Set())
  /** Per-dir load errors so a failed expand is visible instead of rendering empty. */
  const dirErrors = ref<Map<string, string>>(new Map())

  const showHidden = ref<boolean>(
    (() => {
      try {
        // Default to showing hidden files; only off when user explicitly disabled it.
        return sessionStorage.getItem(SHOW_HIDDEN_KEY) !== '0'
      } catch {
        return true
      }
    })()
  )

  function ws(): string {
    return workspacePath.value || ''
  }

  async function fetchDir(rel: string): Promise<FetchDirResult> {
    try {
      const resp = await backend.send<ListDirResult>('fs.list_dir', {
        workspace_path: ws(),
        rel_path: rel,
        show_hidden: showHidden.value,
      })
      const payload = resp.payload
      if (!payload?.ok) {
        const msg = payload?.error || resp.error?.message || 'failed to list directory'
        error.value = msg
        return { ok: false, entries: [], truncated: false, error: msg }
      }
      error.value = ''
      return { ok: true, entries: payload.entries ?? [], truncated: !!payload.truncated, error: '' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed to list directory'
      error.value = msg
      return { ok: false, entries: [], truncated: false, error: msg }
    }
  }

  /** Load (and cache) the children of `rel`. Returns the cached list. */
  async function loadDir(rel: string): Promise<FsEntry[]> {
    const currentWs = ws()
    if (!currentWs) return []
    loadingDirs.value = new Set(loadingDirs.value).add(rel)
    try {
      const res = await fetchDir(rel)
      // Discard results if the workspace changed while the request was in flight.
      if (ws() !== currentWs) return res.entries
      if (!res.ok) {
        // Record a per-dir error and leave the cache untouched: a never-loaded
        // dir stays uncached (so re-expand retries), a previously loaded one
        // keeps its last good entries.
        const errs = new Map(dirErrors.value)
        errs.set(rel, res.error)
        dirErrors.value = errs
        return []
      }
      if (dirErrors.value.has(rel)) {
        const errs = new Map(dirErrors.value)
        errs.delete(rel)
        dirErrors.value = errs
      }
      const trunc = new Set(truncatedDirs.value)
      if (res.truncated) trunc.add(rel)
      else trunc.delete(rel)
      truncatedDirs.value = trunc
      const next = new Map(childrenCache.value)
      next.set(rel, res.entries)
      childrenCache.value = next
      return res.entries
    } finally {
      const s = new Set(loadingDirs.value)
      s.delete(rel)
      loadingDirs.value = s
    }
  }

  function isExpanded(rel: string): boolean {
    return expanded.value.has(rel)
  }

  function isLoading(rel: string): boolean {
    return loadingDirs.value.has(rel)
  }

  /** Expand/collapse a directory, lazy-loading children on first expand. */
  async function toggleDir(rel: string): Promise<void> {
    const next = new Set(expanded.value)
    if (next.has(rel)) {
      next.delete(rel)
      expanded.value = next
      return
    }
    next.add(rel)
    expanded.value = next
    if (!childrenCache.value.has(rel)) await loadDir(rel)
  }

  /** Drop all caches and reload the root + every currently expanded dir. */
  async function reloadAll(): Promise<void> {
    childrenCache.value = new Map()
    const dirs = ['', ...expanded.value]
    await Promise.all(dirs.map((d) => loadDir(d)))
  }

  /** Refresh the root and visible expanded dirs without collapsing anything. */
  async function refreshVisible(): Promise<void> {
    const dirs = ['', ...expanded.value]
    await Promise.all(dirs.map((d) => loadDir(d)))
  }

  /**
   * Drop a dir and all its descendants from expansion/cache/error state after
   * it was renamed or deleted, so refreshes stop hitting the vanished path.
   * On rename, pass `renamedTo` to keep the subtree expanded under its new path.
   */
  function pruneDir(rel: string, renamedTo?: string): void {
    if (!rel) return
    const prefix = rel + '/'
    const matches = (k: string): boolean => k === rel || k.startsWith(prefix)
    const remap = (k: string): string => (k === rel ? renamedTo! : renamedTo + k.slice(rel.length))
    const exp = new Set<string>()
    for (const k of expanded.value) {
      if (!matches(k)) exp.add(k)
      else if (renamedTo) exp.add(remap(k))
    }
    expanded.value = exp
    const cache = new Map(childrenCache.value)
    for (const k of [...cache.keys()]) if (matches(k)) cache.delete(k)
    childrenCache.value = cache
    loadingDirs.value = new Set([...loadingDirs.value].filter((k) => !matches(k)))
    truncatedDirs.value = new Set([...truncatedDirs.value].filter((k) => !matches(k)))
    dirErrors.value = new Map([...dirErrors.value].filter(([k]) => !matches(k)))
  }

  function setShowHidden(value: boolean): void {
    showHidden.value = value
    try {
      sessionStorage.setItem(SHOW_HIDDEN_KEY, value ? '1' : '0')
    } catch {
      /* ignore */
    }
    void reloadAll()
  }

  // ── Git status overlay ────────────────────────────────────────────────────
  /**
   * Build a relPath → status-letter map from a git status. staged paths win
   * (so the Explorer can pass the right `staged` flag when opening a diff).
   */
  function buildStatusMap(status: GitStatusSnapshot | null): Map<string, { letter: string; staged: boolean }> {
    const map = new Map<string, { letter: string; staged: boolean }>()
    if (!status) return map
    for (const e of status.unstaged ?? []) map.set(e.path, { letter: e.status.trim() || 'M', staged: false })
    for (const e of status.untracked ?? []) map.set(e.path, { letter: 'U', staged: false })
    for (const e of status.staged ?? []) map.set(e.path, { letter: e.status.trim() || 'M', staged: true })
    return map
  }

  // ── git.changed → invalidate ──────────────────────────────────────────────
  // Only refresh for events from this workspace (broadcasts reach every
  // session); refresh on a missing workspace_path for safety, like useGit.
  const off = backend.on('git.changed', (payload: unknown) => {
    if (!ws()) return
    const p = payload as { workspace_path?: string } | null
    if (p?.workspace_path && p.workspace_path !== ws()) return
    void refreshVisible()
  })
  onScopeDispose(() => off())

  // ── window focus → refresh ────────────────────────────────────────────────
  // External tools (terminals, other editors) create/delete files without any
  // git.changed event; re-list what's visible when the app regains focus.
  let lastFocusRefreshAt = 0
  function onWindowFocus(): void {
    if (!ws()) return
    if (backend.status.value !== 'connected') return
    if (opts?.isRefreshBlocked?.()) return
    const now = Date.now()
    if (now - lastFocusRefreshAt < FOCUS_REFRESH_INTERVAL_MS) return
    lastFocusRefreshAt = now
    void refreshVisible()
  }
  window.addEventListener('focus', onWindowFocus)
  onScopeDispose(() => window.removeEventListener('focus', onWindowFocus))

  // Reset when the workspace changes.
  watch(workspacePath, () => {
    childrenCache.value = new Map()
    expanded.value = new Set()
    error.value = ''
    truncatedDirs.value = new Set()
    dirErrors.value = new Map()
  })

  return {
    childrenCache,
    expanded,
    showHidden,
    error,
    truncatedDirs,
    dirErrors,
    isExpanded,
    isLoading,
    loadDir,
    toggleDir,
    reloadAll,
    refreshVisible,
    pruneDir,
    setShowHidden,
    buildStatusMap,
  }
}
