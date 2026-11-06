import { ref, watch, onScopeDispose } from 'vue'
import type { DiscoveredRepo, DiscoverReposResponse, GitStatus } from './useGit'
import { normalizeWorkspacePath } from './useGit'
import type { GitTransport } from '../../../shared/gitCompatibility'

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
  // True when the backend skipped the downward scan because the workspace lives
  // on a cloud-synced folder (walking it can block for minutes). Only a user
  // triggered forced scan clears it — nothing retries automatically.
  const discoverySkipped = ref(false)
  // Workspace the user has already paid a forced walk for (via refresh(true) or
  // a result adopted from a child pane). While it matches the current
  // workspace, an automatic refresh that comes back skipped keeps the list the
  // user opted into instead of collapsing it back to the root-only stub.
  let forcedWorkspace = ''

  // Fetch a lightweight status badge for each repo in parallel.
  async function withBadges(
    discovered: DiscoveredRepo[],
  ): Promise<DiscoveredRepoWithBadge[]> {
    return Promise.all(
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
  }

  // `force` makes the backend walk the tree even on a cloud-synced path. Pass it
  // only from an explicit user action — the walk is what wedged the backend.
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
      if (!resp.ok || !resp.payload?.ok || workspacePath() !== ws) return
      if (force) forcedWorkspace = ws
      const skipped = resp.payload.skipped === 'cloud_storage'
      // Don't throw away a result the user already paid a tree walk for.
      if (skipped && forcedWorkspace === ws) return
      discovered = resp.payload.repositories ?? []
      discoverySkipped.value = skipped
    } catch {
      return
    }

    const badged = await withBadges(discovered)

    if (workspacePath() === ws) {
      repositories.value = badged
    }
  }

  // Adopt a repository list a child pane already fetched with force: true. One
  // user click must cost exactly one backend walk, so this takes over the
  // result rather than issuing a second git.discover_repositories.
  async function adopt(discovered: DiscoveredRepo[]): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    forcedWorkspace = ws
    discoverySkipped.value = false
    const badged = await withBadges(discovered)
    if (workspacePath() === ws) {
      repositories.value = badged
    }
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

  return { repositories, discoverySkipped, refresh, adopt }
}
