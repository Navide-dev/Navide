import { ref, watch, onScopeDispose } from 'vue'
import type { DiscoveredRepo, DiscoverReposResponse, GitStatus } from './useGit'
import { normalizeWorkspacePath } from './useGit'
import type { GitTransport } from '#git-feature'

export interface RepoBadge {
  branch: string
  dirtyCount: number
  /** Set when the status read failed, so the tab never shows a fake clean repo. */
  error?: string
}

export interface DiscoveredRepoWithBadge extends DiscoveredRepo {
  badge: RepoBadge
}

export function useRepoDiscovery(
  workspacePath: () => string,
  transport: GitTransport,
) {
  const { send, on } = transport
  const repositories = ref<DiscoveredRepoWithBadge[]>([])
  const discoverySkipped = ref(false)
  /** True while the latest scan failed, so the caller can tell the user. */
  const discoveryFailed = ref(false)
  let forcedWorkspace = ''

  async function refresh(force = false): Promise<void> {
    const ws = workspacePath()
    if (!ws) {
      repositories.value = []
      discoverySkipped.value = false
      forcedWorkspace = ''
      return
    }

    let discovered: DiscoveredRepo[] = []
    try {
      const resp = await send<DiscoverReposResponse>(
        'git.discover_repositories',
        { workspace_path: ws, force },
      )
      if (workspacePath() !== ws) return
      if (!resp.ok || !resp.payload?.ok) {
        discoveryFailed.value = true
        return
      }
      discoveryFailed.value = false
      if (force) forcedWorkspace = ws
      const skipped = resp.payload.skipped === 'cloud_storage'
      if (skipped && forcedWorkspace === ws) return
      discovered = resp.payload.repositories ?? []
      discoverySkipped.value = skipped
    } catch {
      if (workspacePath() === ws) discoveryFailed.value = true
      return
    }

    // Fetch lightweight status badge for each repo in parallel.
    const withBadges = await Promise.all(
      discovered.map(async (repo) => {
        let badge: RepoBadge = { branch: repo.branch, dirtyCount: 0 }
        try {
          const sr = await send<GitStatus>('git.status', {
            workspace_path: repo.abs_path,
            include_ignored: false,
          })
          // A failed or timed-out read arrives as { ok: false, error } inside a
          // successful envelope (#144); only a payload with is_git_repo is a status.
          if (sr.ok && sr.payload && typeof sr.payload.is_git_repo === 'boolean') {
            const s = sr.payload
            badge = {
              branch: s.branch || repo.branch,
              dirtyCount: s.staged.length + s.unstaged.length + s.untracked.length,
            }
          } else {
            const payloadError = (sr.payload as { error?: unknown } | null)?.error
            badge.error = sr.error?.message
              || (typeof payloadError === 'string' ? payloadError : '')
              || 'Unable to load Git status'
          }
        } catch (error) {
          badge.error = error instanceof Error ? error.message : String(error)
        }
        return { ...repo, badge }
      }),
    )

    if (workspacePath() === ws) {
      repositories.value = withBadges
    }
  }

  async function adopt(discovered: DiscoveredRepo[]): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    forcedWorkspace = ws
    discoverySkipped.value = false
    const withAdoptedBadges = await Promise.all(
      discovered.map(async (repo) => {
        let badge: RepoBadge = { branch: repo.branch, dirtyCount: 0 }
        try {
          const sr = await send<GitStatus>('git.status', {
            workspace_path: repo.abs_path,
            include_ignored: false,
          })
          // A failed or timed-out read arrives as { ok: false, error } inside a
          // successful envelope (#144); only a payload with is_git_repo is a status.
          if (sr.ok && sr.payload && typeof sr.payload.is_git_repo === 'boolean') {
            const s = sr.payload
            badge = {
              branch: s.branch || repo.branch,
              dirtyCount: s.staged.length + s.unstaged.length + s.untracked.length,
            }
          } else {
            const payloadError = (sr.payload as { error?: unknown } | null)?.error
            badge.error = sr.error?.message
              || (typeof payloadError === 'string' ? payloadError : '')
              || 'Unable to load Git status'
          }
        } catch (error) {
          badge.error = error instanceof Error ? error.message : String(error)
        }
        return { ...repo, badge }
      }),
    )
    if (workspacePath() === ws) repositories.value = withAdoptedBadges
  }

  // Re-discover when workspace changes.
  const _stopWatch = watch(workspacePath, () => void refresh(), { immediate: true })
  onScopeDispose(_stopWatch)

  // Re-discover on git.changed broadcasts for this workspace (or a repo nested
  // inside it — badge statuses register watchers under each repo's abs_path).
  // Reacting to every workspace made each window re-scan all repos and fan out
  // a git.status per repo on any disk change anywhere.
  //
  // A change to the workspace folder itself (not inside one of its repos) can
  // only matter by adding or removing a repo. While rescans for it keep finding
  // the same repos, each next one waits twice as long, up to 30 s: a home
  // folder the OS writes into constantly used to rescan, and read every repo's
  // status, every 400 ms. A repo's own change keeps the plain 400 ms debounce.
  let _timer: ReturnType<typeof setTimeout> | null = null
  let _quietRescans = 0
  watch(workspacePath, () => { _quietRescans = 0 })
  const repoKeys = () => repositories.value.map((r) => r.abs_path).join('\n')
  async function rescanForFolderChange(): Promise<void> {
    const before = repoKeys()
    await refresh()
    _quietRescans = repoKeys() === before ? _quietRescans + 1 : 0
  }
  const _offChanged = on('git.changed', (payload: unknown) => {
    const p = payload as { workspace_path?: string }
    const ws = workspacePath()
    let folderOnly = false
    if (p?.workspace_path && ws) {
      // Windows paths differ in separators and case; compare one normal form.
      const changed = normalizeWorkspacePath(p.workspace_path)
      const root = normalizeWorkspacePath(ws)
      const prefix = root.endsWith('/') ? root : root + '/'
      if (changed !== root && !changed.startsWith(prefix)) return
      folderOnly = changed === root
    }
    if (folderOnly) {
      if (_timer !== null && _quietRescans > 0) return
      if (_timer !== null) clearTimeout(_timer)
      _timer = setTimeout(() => {
        _timer = null
        void rescanForFolderChange()
      }, Math.min(400 * 2 ** _quietRescans, 30_000))
      return
    }
    if (_timer !== null) clearTimeout(_timer)
    _timer = setTimeout(() => {
      _timer = null
      void refresh()
    }, 400)
  })
  onScopeDispose(() => {
    _offChanged()
    if (_timer !== null) clearTimeout(_timer)
  })

  return { repositories, discoverySkipped, discoveryFailed, refresh, adopt }
}
