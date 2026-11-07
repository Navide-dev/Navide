import { ref, watch, onScopeDispose } from 'vue'
import type { GitTransport } from '../../../shared/gitCompatibility'

/** The part of a `git.status` answer the Explorer badges read. */
export interface GitStatusEntry {
  path: string
  status: string
}

export interface GitStatusSnapshot {
  is_git_repo: boolean
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
  untracked: GitStatusEntry[]
}

/** Normalised for comparison: forward slashes, no trailing slash, and lower
 *  case for a Windows path (drive letter or UNC), whose file system ignores
 *  case — `C:\Users\me` and `c:/users/me` are one folder. */
export function normalizeWorkspacePath(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/(.)\/+$/, '$1')
  return /^[a-zA-Z]:(\/|$)/.test(p) || p.startsWith('//') ? p.toLowerCase() : p
}

export function sameWorkspacePath(a: string, b: string): boolean {
  return normalizeWorkspacePath(a) === normalizeWorkspacePath(b)
}

/**
 * Git status for the Explorer's file badges, read straight from the backend
 * git service: one `git.status` per load, refreshed on `git.changed` for this
 * workspace and on reconnect. The Git panel itself belongs to the navide-git
 * plugin; this reads nothing else (no log, branches or credentials).
 *
 * A workspace that is not a repository backs off like the plugin's panel:
 * each further change that still finds no repository waits twice as long,
 * from 300 ms up to 30 s, so a folder the OS writes into constantly cannot
 * keep git busy.
 */
export function useGitStatusBadges(workspacePath: () => string, transport: GitTransport) {
  const status = ref<GitStatusSnapshot | null>(null)
  let quietReloads = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  async function load(): Promise<void> {
    const ws = workspacePath()
    if (!ws) {
      status.value = null
      return
    }
    try {
      const resp = await transport.send<GitStatusSnapshot>('git.status', { workspace_path: ws })
      if (workspacePath() !== ws) return
      const ok = resp.ok && !!resp.payload && typeof resp.payload.is_git_repo === 'boolean'
      if (ok) status.value = resp.payload as GitStatusSnapshot
      quietReloads = ok && status.value?.is_git_repo ? 0 : quietReloads + 1
    } catch {
      if (workspacePath() === ws) quietReloads += 1
    }
  }

  // The caller loads a new workspace together with its tree; this only drops
  // the old workspace's badges and back-off.
  watch(workspacePath, () => {
    status.value = null
    quietReloads = 0
  })

  const stopReconnect = watch(
    () => transport.status.value,
    (s) => { if (s === 'connected' && workspacePath()) void load() },
  )

  const offChanged = transport.on('git.changed', (payload: unknown) => {
    const p = payload as { workspace_path?: string } | null
    if (p?.workspace_path && !sameWorkspacePath(p.workspace_path, workspacePath())) return
    // Backing off: let the pending reload run instead of pushing it out.
    if (timer !== null && quietReloads > 0) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void load()
    }, Math.min(300 * 2 ** quietReloads, 30_000))
  })

  onScopeDispose(() => {
    stopReconnect()
    offChanged()
    if (timer !== null) { clearTimeout(timer); timer = null }
  })

  return { status, load }
}
