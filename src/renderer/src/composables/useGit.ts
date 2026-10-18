import { ref, computed, watch, onScopeDispose } from 'vue'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import type { GitRequestType, GitTransport } from '../../../shared/gitCompatibility'
import type { GitCredentialPort } from '../ports/gitSurface'

export interface GitFileEntry {
  path: string
  status: string
}

export interface GitStatus {
  is_git_repo: boolean
  branch: string
  remote_branch: string
  ahead: number
  behind: number
  staged: GitFileEntry[]
  unstaged: GitFileEntry[]
  untracked: GitFileEntry[]
  ignored: GitFileEntry[]
  operation_in_progress: string // '' | 'merge' | 'rebase' | 'cherry-pick'
  truncated?: boolean // the backend stopped at its entry or byte cap (#144)
}

export interface DiscoveredRepo {
  rel_path: string
  abs_path: string
  branch: string
}

export interface DiscoverReposResponse {
  ok: boolean
  repositories: DiscoveredRepo[]
  truncated?: boolean
  // Present only when the backend declined to walk the tree. On a cloud-synced
  // folder each readdir() can block for minutes, so the scan is opt-in.
  skipped?: 'cloud_storage'
}

export type IgnoreTarget = 'project' | 'nested' | 'local' | 'global'

export interface CheckIgnoreResult {
  ok: boolean
  ignored: boolean
  tracked: boolean
  source: string
  line: number
  pattern: string
  error?: string
}

// The three merge stages git keeps in its index for a conflicted path (1 base,
// 2 ours, 3 theirs). `has_*` distinguishes "this stage does not exist" — normal
// for add/add (no base) and delete/modify (a side missing) — from a read
// failure, which comes back as ok:false instead. `binary` means at least one
// stage is not text, and its content is empty rather than mojibake.
export interface ConflictStages {
  ok: boolean
  base: string
  ours: string
  theirs: string
  has_base: boolean
  has_ours: boolean
  has_theirs: boolean
  binary: boolean
  error?: string
}

// Derived from which stages exist, mirroring git status's AA/DU/UD/DD pairs.
export type ConflictKind =
  | 'both-modified'
  | 'both-added'
  | 'deleted-by-them'
  | 'deleted-by-us'
  | 'both-deleted'
  | 'added-by-us'
  | 'added-by-them'
  | 'unknown'

export interface ConflictEntry {
  path: string
  kind: ConflictKind
}

export interface ListConflictsResult {
  ok: boolean
  conflicts: ConflictEntry[]
  error?: string
}

export interface GitCommit {
  hash: string
  short_hash: string
  message: string
  branches: string[]
  parents: string[]
  author?: string
  date?: string
}

export interface GitBranch {
  name: string
  is_current: boolean
  is_remote: boolean
  tracking: string
  has_local?: boolean
}

export interface GitStashEntry {
  index: number
  ref: string
  message: string
}

export interface GitRemote {
  name: string
  fetch_url: string
  push_url: string
}

export interface GitTag {
  name: string
  commit_hash: string
  message: string
}

export interface GitWorktree {
  path: string
  head: string
  branch: string
  is_main: boolean
  detached: boolean
  bare: boolean
  locked: boolean
  lock_reason: string
  prunable: boolean
  prune_reason: string
}

export interface BlameEntry {
  short_hash: string
  author: string
  date: string
  line_no: number
  content: string
}

export interface DiffBlameLine {
  kind: ' ' | '-' | '+'
  old_no: number | null
  new_no: number | null
  text: string
  author: string
  date: string
  committed: boolean
}

export interface DiffBlameHunk {
  header: string
  lines: DiffBlameLine[]
}

export interface GitCommitDetail {
  hash: string
  short_hash: string
  author_name: string
  author_email: string
  date: string
  message: string
  body: string
  files: string[]
}

// Git's askpass helper is invoked once per field (Username, then Password),
// each as an independent request_id — see git_askpass_helper.py / app.py
// build_credential_request_emitter(). This shape pairs the two requests of a
// single push/pull/fetch operation so the Modal can show both fields at once.
export interface GitCredentialPrompt {
  host: string
  usernameRequestId: string | null
  passwordRequestId: string | null
  username: string
  password: string
}

const emptyStatus = (): GitStatus => ({
  is_git_repo: false,
  branch: '',
  remote_branch: '',
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  ignored: [],
  operation_in_progress: '',
})

export function useGit(
  workspacePath: () => string,
  transport: GitTransport,
  credentialPort: GitCredentialPort = {},
) {
  const { send, on } = transport

  const gitStatus = ref<GitStatus>(emptyStatus())
  const statusError = ref('')
  const statusLoaded = ref(false)
  // Nested git repos found by scanning downward when the root is NOT a repo.
  const discoveredRepos = ref<DiscoveredRepo[]>([])
  // True when the backend skipped the downward scan because the workspace lives
  // on a cloud-synced folder (walking it can block for minutes). Only a user
  // triggered forced scan clears it — nothing retries automatically.
  const discoverySkipped = ref(false)
  let discoveryForceSequence = 0
  let pendingForce: { sequence: number; workspace: string } | null = null
  let acceptedForce: { sequence: number; workspace: string } | null = null
  const showIgnored = ref(false)
  const gitLog = ref<GitCommit[]>([])
  /** Why the last history read failed ('' when it worked). The list keeps its
   *  previous contents either way; the panel shows this beside it. */
  const logError = ref('')
  /** Why the last showCommit() failed ('' when it worked). */
  const commitDetailError = ref('')
  function readFailure(resp: { error?: { message?: string } | null; payload?: unknown }): string {
    const payloadError = (resp.payload as { error?: unknown } | null)?.error
    return resp.error?.message || (typeof payloadError === 'string' ? payloadError : '') || 'unknown error'
  }
  // History view scope (SourceTree-style): 'all' shows every branch's commits as
  // a multi-lane DAG, 'current' shows only HEAD's ancestry. logLimit grows via
  // loadMoreLog() to page through history without breaking the graph.
  const LOG_PAGE = 50
  const LOG_SCOPE_KEY = 'agentTeam.git.logScope'
  const loadLogScope = (): 'all' | 'current' =>
    settingsGet<string | null>(LOG_SCOPE_KEY, null) === 'current' ? 'current' : 'all'
  const logScope = ref<'all' | 'current'>(loadLogScope())
  // Sort order for the history graph (SourceTree-style): 'ancestor' = topo order
  // (default, matches the lane layout), 'date' = strict date order.
  const LOG_ORDER_KEY = 'agentTeam.git.logOrder'
  const loadLogOrder = (): 'ancestor' | 'date' =>
    settingsGet<string | null>(LOG_ORDER_KEY, null) === 'date' ? 'date' : 'ancestor'
  const logOrder = ref<'ancestor' | 'date'>(loadLogOrder())
  const logLimit = ref(LOG_PAGE)
  const gitBranches = ref<GitBranch[]>([])
  const gitStashes = ref<GitStashEntry[]>([])
  const gitRemotes = ref<GitRemote[]>([])
  const gitTags = ref<GitTag[]>([])
  const gitWorktrees = ref<GitWorktree[]>([])
  const gitConfig = ref<Record<string, string>>({})
  const isLoadingStatus = ref(false)
  const isLoadingLog = ref(false)
  const isCommitting = ref(false)
  const isSyncing = ref(false)
  const isFetching = ref(false)
  const isGenerating = ref(false)
  const syncOutput = ref('')
  const syncError = ref('')
  // Single error channel for write operations: captures both ws-not-open
  // rejections and backend {ok:false} responses so failures are never silent.
  const gitError = ref('')
  function clearGitError(): void { gitError.value = '' }
  async function runWrite(
    type: GitRequestType,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    gitError.value = ''
    try {
      // 20s stays above the backend's 15s git-subprocess timeout so a slow but
      // successful write (large stage/commit) isn't cut short by the frontend
      // first with a spurious "request … timeout".
      const resp = await send<{ ok: boolean; error?: string }>(type, payload, 20_000)
      const r = resp.payload ?? { ok: false, error: 'no response' }
      if (!r.ok) gitError.value = r.error || `${type} failed`
      return r
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `${type}: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function loadStatus(): Promise<void> {
    const ws = workspacePath()
    statusError.value = ''
    if (!ws) {
      gitStatus.value = emptyStatus()
      statusLoaded.value = false
      return
    }
    isLoadingStatus.value = true
    try {
      const resp = await send<GitStatus>('git.status', {
        workspace_path: ws,
        include_ignored: showIgnored.value,
      })
      if (resp.ok && resp.payload && typeof resp.payload.is_git_repo === 'boolean' && workspacePath() === ws) {
        gitStatus.value = resp.payload
        statusLoaded.value = true
        // Root isn't a repo — git only searches upward, so scan downward for
        // nested repos to offer in the empty state. Clear stale results first.
        if (resp.payload.is_git_repo) {
          discoveredRepos.value = []
        } else {
          void discoverRepositories()
        }
      } else if (workspacePath() === ws) {
        const payloadError = (resp.payload as { error?: unknown } | null)?.error
        statusError.value = resp.error?.message
          || (typeof payloadError === 'string' ? payloadError : '')
          || 'Unable to load Git status'
      }
    } catch (error) {
      if (workspacePath() === ws) {
        statusError.value = error instanceof Error ? error.message : String(error)
      }
    } finally {
      if (workspacePath() === ws) isLoadingStatus.value = false
    }
  }

  // `force` makes the backend walk the tree even on a cloud-synced path. Pass it
  // only from an explicit user action — the walk is what wedged the backend.
  async function discoverRepositories(force = false): Promise<void> {
    const ws = workspacePath()
    if (!ws) {
      discoveredRepos.value = []
      discoverySkipped.value = false
      return
    }
    const forceSequenceAtStart = discoveryForceSequence
    const pendingForceAtStart = !force && pendingForce?.workspace === ws
      ? pendingForce.sequence
      : 0
    const ownForceSequence = force ? ++discoveryForceSequence : 0
    if (force) pendingForce = { sequence: ownForceSequence, workspace: ws }
    try {
      const resp = await send<DiscoverReposResponse>(
        'git.discover_repositories',
        { workspace_path: ws, force },
      )
      if (resp.ok && resp.payload?.ok && workspacePath() === ws) {
        if (force) {
          acceptedForce = { sequence: ownForceSequence, workspace: ws }
        } else if (
          acceptedForce?.workspace === ws
          && (
            acceptedForce.sequence > forceSequenceAtStart
            || (pendingForceAtStart > 0 && acceptedForce.sequence >= pendingForceAtStart)
          )
        ) {
          return
        }
        discoveredRepos.value = resp.payload.repositories ?? []
        discoverySkipped.value = resp.payload.skipped === 'cloud_storage'
      }
    } catch {
      // transient WS error — leave previous list untouched
    } finally {
      if (force && pendingForce?.sequence === ownForceSequence) pendingForce = null
    }
  }

  async function loadLog(): Promise<boolean> {
    const ws = workspacePath()
    if (!ws) {
      gitLog.value = []
      return false
    }
    const scope = logScope.value  // capture before await to detect scope changes
    isLoadingLog.value = true
    try {
      const resp = await send<{ commits: GitCommit[] }>('git.log', {
        workspace_path: ws,
        n: logLimit.value,
        all: scope === 'all',
        order: logOrder.value,
      })
      if (resp.ok && resp.payload && workspacePath() === ws && logScope.value === scope) {
        gitLog.value = resp.payload.commits ?? []
        logError.value = ''
        return true
      }
      if (!resp.ok && workspacePath() === ws) logError.value = readFailure(resp)
      return false
    } catch (error) {
      // transient WS error — loading flag reset in finally
      if (workspacePath() === ws) logError.value = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      if (workspacePath() === ws && logScope.value === scope) isLoadingLog.value = false
    }
  }

  // Whether more commits may exist beyond what's loaded (full page came back).
  const canLoadMoreLog = computed(() => gitLog.value.length >= logLimit.value)

  async function loadMoreLog(): Promise<void> {
    const prev = logLimit.value
    logLimit.value += LOG_PAGE
    if (!(await loadLog())) logLimit.value = prev
  }

  // Search the full history on the backend (via git log --grep). Returns the
  // matching commits WITHOUT touching gitLog — the history dialog owns a
  // separate state so the main panel keeps showing the latest page.
  async function logSearch(
    query: string,
    opts?: { scope?: 'all' | 'current'; limit?: number; order?: 'ancestor' | 'date' },
  ): Promise<GitCommit[]> {
    const ws = workspacePath()
    if (!ws) return []
    try {
      const resp = await send<{ commits: GitCommit[] }>('git.log', {
        workspace_path: ws,
        n: opts?.limit ?? 50,
        all: (opts?.scope ?? logScope.value) === 'all',
        order: opts?.order ?? logOrder.value,
        query,
      })
      if (resp.ok && resp.payload) return resp.payload.commits ?? []
      return []
    } catch {
      // transient WS error — return empty, don't disturb the main panel
      return []
    }
  }

  async function setLogScope(scope: 'all' | 'current'): Promise<void> {
    if (logScope.value === scope) return
    logScope.value = scope
    logLimit.value = LOG_PAGE
    settingsSet(LOG_SCOPE_KEY, scope)
    await loadLog()
  }

  async function setLogOrder(order: 'ancestor' | 'date'): Promise<void> {
    if (logOrder.value === order) return
    logOrder.value = order
    settingsSet(LOG_ORDER_KEY, order)
    await loadLog()
  }

  async function compareBranches(base: string, compare: string): Promise<{ ok: boolean; stat: string; files: string[]; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, stat: '', files: [], error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; stat: string; files: string[]; error?: string }>(
        'git.compare_branches', { workspace_path: ws, base, compare }
      )
      return resp.payload ?? { ok: false, stat: '', files: [], error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, stat: '', files: [], error: msg }
    }
  }

  async function diffBranches(base: string, compare: string): Promise<string> {
    const ws = workspacePath()
    if (!ws) return ''
    try {
      const resp = await send<{ ok: boolean; diff: string }>('git.diff_branches', { workspace_path: ws, base, compare })
      return resp.ok && resp.payload?.ok ? (resp.payload.diff ?? '') : ''
    } catch {
      return ''
    }
  }

  async function rebaseOn(branch: string): Promise<{ ok: boolean; output?: string; error?: string; conflict_files?: string[] }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; output: string; error: string; conflict_files: string[] }>('git.rebase', { workspace_path: ws, branch }, 20_000)
      if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadLog() }
      else if (resp.ok && resp.payload && !resp.payload.ok) { await loadStatus() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `rebaseOn: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function restoreFileFromBranch(branch: string, filepath: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.restore_from_branch', { workspace_path: ws, branch, filepath })
      if (resp.ok && resp.payload?.ok) await loadStatus()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `restoreFileFromBranch: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function cleanUntracked(dry_run: boolean): Promise<{ ok: boolean; files: string[]; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, files: [], error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; files: string[]; dry_run: boolean; error?: string }>(
        'git.clean', { workspace_path: ws, dry_run }
      )
      if (resp.ok && resp.payload?.ok && !dry_run) await loadStatus()
      return resp.payload ? { ok: resp.payload.ok, files: resp.payload.files ?? [], error: resp.payload.error } : { ok: false, files: [], error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `cleanUntracked: ${msg}`
      return { ok: false, files: [], error: msg }
    }
  }

  async function showCommit(commit_hash: string): Promise<GitCommitDetail | null> {
    const ws = workspacePath()
    if (!ws) return null
    try {
      const resp = await send<GitCommitDetail & { ok: boolean; error?: string }>('git.show_commit', { workspace_path: ws, commit_hash })
      if (resp.ok && resp.payload?.ok) {
        commitDetailError.value = ''
        return resp.payload as GitCommitDetail
      }
      commitDetailError.value = readFailure(resp)
    } catch (error) {
      // network / timeout — caller shows no detail
      commitDetailError.value = error instanceof Error ? error.message : String(error)
    }
    return null
  }

  async function pushUpstream(branch: string, remote = 'origin'): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; output: string; error: string }>(
        'git.push_upstream', await withCredential(ws, { workspace_path: ws, branch, remote }), 30_000
      )
      if (resp.ok && resp.payload?.ok) await loadStatus()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `pushUpstream: ${msg}`
      return { ok: false, error: msg }
    } finally {
      settleCredentialPrompt()
    }
  }

  async function loadWorktrees(): Promise<void> {
    const ws = workspacePath()
    if (!ws) { gitWorktrees.value = []; return }
    try {
      const resp = await send<{ worktrees: GitWorktree[] }>('git.worktrees', { workspace_path: ws })
      if (resp.ok && resp.payload && workspacePath() === ws) gitWorktrees.value = resp.payload.worktrees ?? []
    } catch { /* ignore transient WS errors */ }
  }

  async function addWorktree(worktree_path: string, branch: string, new_branch = false): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; output: string; error: string }>(
        'git.add_worktree', { workspace_path: ws, worktree_path, branch, new_branch }, 20_000
      )
      if (resp.ok && resp.payload?.ok) await loadWorktrees()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `addWorktree: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function removeWorktree(worktree_path: string, force = false): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error: string }>('git.remove_worktree', { workspace_path: ws, worktree_path, force }, 20_000)
      if (resp.ok && resp.payload?.ok) await loadWorktrees()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `removeWorktree: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function pruneWorktrees(): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; output: string; error: string }>('git.prune_worktrees', { workspace_path: ws }, 20_000)
      if (resp.ok && resp.payload?.ok) await loadWorktrees()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `pruneWorktrees: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function lockWorktree(worktree_path: string, reason = ''): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error: string }>('git.lock_worktree', { workspace_path: ws, worktree_path, reason }, 20_000)
      if (resp.ok && resp.payload?.ok) await loadWorktrees()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `lockWorktree: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function unlockWorktree(worktree_path: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error: string }>('git.unlock_worktree', { workspace_path: ws, worktree_path }, 20_000)
      if (resp.ok && resp.payload?.ok) await loadWorktrees()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `unlockWorktree: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function moveWorktree(worktree_path: string, new_path: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; output: string; error: string }>('git.move_worktree', { workspace_path: ws, worktree_path, new_path }, 20_000)
      if (resp.ok && resp.payload?.ok) await loadWorktrees()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `moveWorktree: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function repairWorktrees(): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; output: string; error: string }>('git.repair_worktrees', { workspace_path: ws }, 20_000)
      if (resp.ok && resp.payload?.ok) await loadWorktrees()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `repairWorktrees: ${msg}`
      return { ok: false, error: msg }
    }
  }

  const gitConfigAllowedKeys = ref<string[]>([])

  async function loadGitConfig(): Promise<void> {
    const ws = workspacePath()
    if (!ws) { gitConfig.value = {}; return }
    try {
      const resp = await send<{ ok: boolean; config: Record<string, string>; allowed_keys?: string[] }>('git.config_get', { workspace_path: ws })
      if (resp.ok && resp.payload?.ok && workspacePath() === ws) {
        gitConfig.value = resp.payload.config ?? {}
        if (resp.payload.allowed_keys) gitConfigAllowedKeys.value = resp.payload.allowed_keys
      }
    } catch { /* ignore transient WS errors */ }
  }

  async function setGitConfig(key: string, value: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.config_set', { workspace_path: ws, key, value })
      if (resp.ok && resp.payload?.ok) await loadGitConfig()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `setGitConfig: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function blameFile(filepath: string): Promise<BlameEntry[]> {
    const ws = workspacePath()
    if (!ws) return []
    try {
      const resp = await send<{ ok: boolean; lines: BlameEntry[] }>('git.blame', { workspace_path: ws, filepath })
      return resp.ok && resp.payload?.ok ? resp.payload.lines ?? [] : []
    } catch {
      return []
    }
  }

  async function loadTags(): Promise<void> {
    const ws = workspacePath()
    if (!ws) { gitTags.value = []; return }
    try {
      const resp = await send<{ tags: GitTag[] }>('git.tags', { workspace_path: ws })
      if (resp.ok && resp.payload && workspacePath() === ws) gitTags.value = resp.payload.tags ?? []
    } catch { /* ignore transient WS errors */ }
  }

  async function createTag(name: string, message = '', commit_hash = ''): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.create_tag', { workspace_path: ws, name, message, commit_hash })
      if (resp.ok && resp.payload?.ok) await loadTags()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `createTag: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function deleteTag(name: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.delete_tag', { workspace_path: ws, name })
      if (resp.ok && resp.payload?.ok) await loadTags()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `deleteTag: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function cherryPick(commit_hash: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.cherry_pick', { workspace_path: ws, commit_hash }, 20_000)
      if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadLog() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `cherryPick: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function fileLog(filepath: string, n = 15): Promise<GitCommit[]> {
    const ws = workspacePath()
    if (!ws) return []
    try {
      const resp = await send<{ commits: GitCommit[] }>('git.file_log', { workspace_path: ws, filepath, n })
      return resp.ok && resp.payload ? resp.payload.commits ?? [] : []
    } catch {
      return []
    }
  }

  async function showFile(filepath: string, rev = 'HEAD'): Promise<{ ok: boolean; content: string; error: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, content: '', error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; content: string; error: string }>('git.show_file', { workspace_path: ws, filepath, rev })
      return resp.payload ?? { ok: false, content: '', error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: '', error: msg }
    }
  }

  async function resolveConflictOurs(filepath: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.resolve_ours', { workspace_path: ws, filepath })
      if (resp.ok && resp.payload?.ok) await loadStatus()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `resolveConflictOurs: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function resolveConflictTheirs(filepath: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.resolve_theirs', { workspace_path: ws, filepath })
      if (resp.ok && resp.payload?.ok) await loadStatus()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `resolveConflictTheirs: ${msg}`
      return { ok: false, error: msg }
    }
  }

  const emptyStages = (error: string): ConflictStages => ({
    ok: false, base: '', ours: '', theirs: '',
    has_base: false, has_ours: false, has_theirs: false, binary: false, error,
  })

  /** Read all three merge stages of a conflicted file in one round-trip. */
  async function conflictStages(filepath: string): Promise<ConflictStages> {
    const ws = workspacePath()
    if (!ws) return emptyStages('no workspace')
    try {
      const resp = await send<ConflictStages>('git.conflict_stages', { workspace_path: ws, filepath })
      return resp.payload ?? emptyStages('no response')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return emptyStages(msg)
    }
  }

  /** Enumerate the index's unmerged paths — outlives the merge output that
   *  produced them, so the conflict list survives an app restart. */
  async function listConflicts(): Promise<ListConflictsResult> {
    const ws = workspacePath()
    if (!ws) return { ok: false, conflicts: [], error: 'no workspace' }
    try {
      const resp = await send<ListConflictsResult>('git.list_conflicts', { workspace_path: ws })
      return resp.payload ?? { ok: false, conflicts: [], error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, conflicts: [], error: msg }
    }
  }

  /** Stage a hand-merged file as resolved (plain `git add`, content untouched). */
  async function markResolved(filepath: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>(
        'git.mark_resolved', { workspace_path: ws, filepath }, 20_000,
      )
      if (resp.ok && resp.payload?.ok) await loadStatus()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `markResolved: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function loadRemotes(): Promise<void> {
    const ws = workspacePath()
    if (!ws) { gitRemotes.value = []; return }
    try {
      const resp = await send<{ remotes: GitRemote[] }>('git.remotes', { workspace_path: ws })
      if (resp.ok && resp.payload && workspacePath() === ws) gitRemotes.value = resp.payload.remotes ?? []
    } catch { /* ignore transient WS errors */ }
  }

  async function diffFile(filepath: string, staged = false): Promise<string> {
    const ws = workspacePath()
    if (!ws) return ''
    try {
      const resp = await send<{ ok: boolean; diff: string }>('git.diff_file', { workspace_path: ws, filepath, staged })
      return resp.ok && resp.payload?.ok ? (resp.payload.diff ?? '') : ''
    } catch {
      return ''
    }
  }

  async function diffBlame(filepath: string, staged = false): Promise<DiffBlameHunk[]> {
    const ws = workspacePath()
    if (!ws) return []
    try {
      const resp = await send<{ ok: boolean; hunks: DiffBlameHunk[] }>('git.diff_blame', { workspace_path: ws, filepath, staged })
      return resp.ok && resp.payload?.ok ? (resp.payload.hunks ?? []) : []
    } catch {
      return []
    }
  }

  async function mergeBranch(branch: string): Promise<{ ok: boolean; output?: string; error?: string; conflict_files?: string[] }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; output: string; error: string; conflict_files: string[] }>('git.merge', { workspace_path: ws, branch }, 20_000)
      if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadLog(); await loadBranches() }
      else if (resp.ok && resp.payload && !resp.payload.ok) { await loadStatus() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `mergeBranch: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function mergeInto(target: string): Promise<{ ok: boolean; output?: string; error?: string; conflict_files?: string[]; source_branch?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; output: string; error: string; conflict_files: string[]; source_branch: string }>('git.merge_into', { workspace_path: ws, target }, 20_000)
      // git.changed broadcast from the backend handles all reloads on success;
      // on conflict we still need a status refresh to show the dirty files.
      if (resp.ok && resp.payload && !resp.payload.ok) { await loadStatus() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `mergeInto: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function revertCommit(commit_hash: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.revert', { workspace_path: ws, commit_hash }, 20_000)
      if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadLog() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `revertCommit: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function resetToCommit(commit: string, mode: 'soft' | 'mixed' | 'hard'): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.reset', { workspace_path: ws, commit, mode }, 20_000)
      if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadBranches(); await loadLog() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `resetToCommit: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function addRemote(name: string, url: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.add_remote', { workspace_path: ws, name, url })
      if (resp.ok && resp.payload?.ok) await loadRemotes()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `addRemote: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function removeRemote(name: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.remove_remote', { workspace_path: ws, name })
      if (resp.ok && resp.payload?.ok) await loadRemotes()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `removeRemote: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function loadBranches(): Promise<void> {
    const ws = workspacePath()
    if (!ws) { gitBranches.value = []; return }
    try {
      const resp = await send<{ ok: boolean; branches: GitBranch[] }>('git.branches', { workspace_path: ws })
      if (resp.ok && resp.payload?.ok && workspacePath() === ws) gitBranches.value = resp.payload.branches ?? []
    } catch { /* ignore transient WS errors */ }
  }

  async function loadStashes(): Promise<void> {
    const ws = workspacePath()
    if (!ws) { gitStashes.value = []; return }
    try {
      const resp = await send<{ stashes: GitStashEntry[] }>('git.stash_list', { workspace_path: ws })
      if (resp.ok && resp.payload && workspacePath() === ws) gitStashes.value = resp.payload.stashes ?? []
    } catch { /* ignore transient WS errors */ }
  }

  async function discardFile(path: string): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    await runWrite('git.discard', { workspace_path: ws, files: [path] })
    await loadStatus()
  }

  // Attach the workspace's bound account credential (decrypted on demand from
  // the main-process safeStorage store) to a remote-op payload, so the backend
  // auto-answers GIT_ASKPASS as that account instead of the single host-keyed
  // osxkeychain entry. No binding (or no gitAccounts bridge) → payload is
  // returned unchanged, so the normal interactive askpass flow still applies.
  // Declared with `function` so it hoists above every remote-op caller below.
  async function withCredential<T extends Record<string, unknown>>(ws: string, payload: T): Promise<T> {
    try {
      const credential = await credentialPort.getCredential?.(ws)
      if (credential) return { ...payload, credential }
    } catch {
      /* fall back to interactive askpass */
    }
    return payload
  }

  async function fetchRemote(): Promise<{ ok: boolean; output: string; error: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, output: '', error: 'no workspace' }
    isFetching.value = true
    try {
      const resp = await send<{ ok: boolean; output: string; error: string }>('git.fetch', await withCredential(ws, { workspace_path: ws }), 65_000)
      await loadStatus()
      await loadBranches()
      return resp.payload ?? { ok: false, output: '', error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `fetchRemote: ${msg}`
      return { ok: false, output: '', error: msg }
    } finally {
      isFetching.value = false
      settleCredentialPrompt()
    }
  }

  async function pullOnly(): Promise<{ ok: boolean; output: string; error: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, output: '', error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; output: string; error: string }>('git.pull', await withCredential(ws, { workspace_path: ws }), 65_000)
      await loadStatus()
      return resp.payload ?? { ok: false, output: '', error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `pullOnly: ${msg}`
      return { ok: false, output: '', error: msg }
    } finally {
      settleCredentialPrompt()
    }
  }

  async function pushOnly(remote = '', branch = ''): Promise<{ ok: boolean; output: string; error: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, output: '', error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; output: string; error: string }>('git.push', await withCredential(ws, { workspace_path: ws, remote, branch }), 65_000)
      await loadStatus()
      return resp.payload ?? { ok: false, output: '', error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `pushOnly: ${msg}`
      return { ok: false, output: '', error: msg }
    } finally {
      settleCredentialPrompt()
    }
  }

  async function createBranch(name: string, start_point = ''): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.create_branch', { workspace_path: ws, name, switch_to: true, start_point }, 20_000)
      if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadBranches(); await loadLog() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `createBranch: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function switchBranch(name: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.switch_branch', { workspace_path: ws, name }, 20_000)
      if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadBranches(); await loadLog() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `switchBranch: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function checkoutRemoteBranch(remote_ref: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.checkout_remote_branch', { workspace_path: ws, remote_ref })
      if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadBranches(); await loadLog() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `checkoutRemoteBranch: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function checkoutCommit(commit_hash: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.checkout_commit', { workspace_path: ws, commit_hash })
      if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadBranches(); await loadLog() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `checkoutCommit: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function commitFileDiff(commit_hash: string, filepath: string): Promise<DiffBlameHunk[]> {
    const ws = workspacePath()
    if (!ws) return []
    try {
      const resp = await send<{ ok: boolean; hunks: DiffBlameHunk[]; error?: string }>('git.commit_file_diff', { workspace_path: ws, commit_hash, filepath })
      if (resp.ok && resp.payload?.ok) return resp.payload.hunks ?? []
      gitError.value = `commitFileDiff: ${resp.payload?.error || 'no response'}`
      return []
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `commitFileDiff: ${msg}`
      return []
    }
  }

  async function deleteBranch(name: string, force = false): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.delete_branch', { workspace_path: ws, name, force }, 20_000)
      if (resp.ok && resp.payload?.ok) await loadBranches()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `deleteBranch: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function stashPush(message = '', paths?: string[]): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.stash', { workspace_path: ws, message, paths }, 20_000)
      if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadStashes() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `stashPush: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function stashPop(index = 0): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.stash_pop', { workspace_path: ws, index }, 20_000)
      if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadStashes() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `stashPop: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function stashDrop(index: number): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.stash_drop', { workspace_path: ws, index }, 20_000)
      if (resp.ok && resp.payload?.ok) await loadStashes()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `stashDrop: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function amendCommit(message = ''): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.amend', { workspace_path: ws, message }, 20_000)
      if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadLog() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `amendCommit: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function undoLastCommit(): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.undo_commit', { workspace_path: ws }, 20_000)
      if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadLog() }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `undoLastCommit: ${msg}`
      return { ok: false, error: msg }
    }
  }

  const isInitializing = ref(false)

  async function initRepo(createGitignore = true, targetPath?: string): Promise<{ ok: boolean; error?: string; gitignore_created?: boolean }> {
    // targetPath lets the caller init a specific folder (e.g. a subfolder picked
    // from the empty state) instead of the active workspace.
    const ws = targetPath || workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    isInitializing.value = true
    try {
      const resp = await send<{ ok: boolean; error?: string; gitignore_created?: boolean }>(
        'git.init',
        { workspace_path: ws, create_gitignore: createGitignore },
      )
      if (resp.ok && resp.payload?.ok) {
        // When initializing a different folder the caller re-points the
        // workspace, which reloads status/log on its own — skip the in-place refresh.
        if (!targetPath) {
          await loadStatus()
          await loadLog()
        }
        return { ok: true, gitignore_created: resp.payload.gitignore_created }
      }
      return { ok: false, error: resp.payload?.error || resp.error?.message || 'git init failed' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `initRepo: ${msg}`
      return { ok: false, error: msg }
    } finally {
      isInitializing.value = false
    }
  }

  async function stageFile(path: string): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    await runWrite('git.stage', { workspace_path: ws, files: [path] })
    await loadStatus()
  }

  async function unstageFile(path: string): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    await runWrite('git.unstage', { workspace_path: ws, files: [path] })
    await loadStatus()
  }

  async function stageAll(): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    await runWrite('git.stage_all', { workspace_path: ws })
    await loadStatus()
  }

  async function stageFiles(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    if (!paths.length) return { ok: true }
    const r = await runWrite('git.stage', { workspace_path: ws, files: paths })
    await loadStatus()
    return r
  }

  async function unstageFiles(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    if (!paths.length) return { ok: true }
    const r = await runWrite('git.unstage', { workspace_path: ws, files: paths })
    await loadStatus()
    return r
  }

  async function discardFiles(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    if (!paths.length) return { ok: true }
    const r = await runWrite('git.discard', { workspace_path: ws, files: paths })
    await loadStatus()
    return r
  }

  async function commit(message: string, all = false): Promise<{ ok: boolean; error?: string }> {
    if (!message.trim()) return { ok: false, error: 'Commit message cannot be empty' }
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    isCommitting.value = true
    try {
      const resp = await send<{ ok: boolean; error?: string; hash?: string }>(
        'git.commit',
        { workspace_path: ws, message, all },
        20_000,
      )
      if (resp.ok && resp.payload?.ok) {
        await loadStatus()
        await loadLog()
        return { ok: true }
      }
      return { ok: false, error: resp.payload?.error || resp.error?.message || 'commit failed' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `commit: ${msg}`
      return { ok: false, error: msg }
    } finally {
      isCommitting.value = false
    }
  }

  async function sync(): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    isSyncing.value = true
    syncOutput.value = ''
    syncError.value = ''
    try {
      const resp = await send<{ ok: boolean; pull_output: string; push_output: string; error: string }>(
        'git.sync',
        await withCredential(ws, { workspace_path: ws }),
        65_000,
      )
      if (resp.ok && resp.payload) {
        const { pull_output, push_output, error } = resp.payload
        syncOutput.value = [pull_output, push_output].filter(Boolean).join('\n').trim()
        syncError.value = error || ''
        await loadStatus()
        await loadLog()
      } else {
        syncError.value = resp.error?.message || 'sync failed'
      }
    } catch (e) {
      syncError.value = e instanceof Error ? e.message : String(e)
    } finally {
      isSyncing.value = false
      settleCredentialPrompt()
    }
  }

  async function generateMessage(
    model: string,
    attemptCount = 0,
  ): Promise<{ ok: boolean; message: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, message: '', error: 'no workspace' }
    isGenerating.value = true
    try {
      // Backend bounds context-gathering + LLM call to a single 60s budget
      // (see _GENERATE_MESSAGE_BUDGET_S in git_service.py); this timeout must
      // stay above that budget plus network/serialization margin, or it fires
      // while the backend is still within its own deadline.
      const resp = await send<{ ok: boolean; message: string; error?: string }>(
        'git.generate_message',
        { workspace_path: ws, model, attempt_count: attemptCount },
        75_000,
      )
      if (resp.ok && resp.payload?.ok) {
        return { ok: true, message: resp.payload.message }
      }
      return { ok: false, message: '', error: resp.payload?.error || resp.error?.message || 'generation failed' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, message: '', error: msg }
    } finally {
      isGenerating.value = false
    }
  }

  async function checkStaged(): Promise<{ ok: boolean; errorCount: number; summary: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: true, errorCount: 0, summary: '' }
    try {
      const resp = await send<{ ok: boolean; error_count: number; summary: string }>(
        'git.check_staged',
        { workspace_path: ws },
        35_000,
      )
      if (resp.payload) {
        return { ok: resp.payload.ok, errorCount: resp.payload.error_count, summary: resp.payload.summary }
      }
      return { ok: true, errorCount: 0, summary: '' }
    } catch {
      return { ok: true, errorCount: 0, summary: '' }
    }
  }

  // Hunk / line-level staging: apply a frontend-built patch to the index.
  // reverse=true unstages; cached=false applies to the working tree (discard).
  async function applyPatch(
    patch: string,
    reverse = false,
    cached = true,
  ): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.apply_patch', {
        workspace_path: ws,
        patch,
        reverse,
        cached,
      }, 20_000)
      if (resp.ok && resp.payload?.ok) await loadStatus()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `applyPatch: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function connectToRemote(
    url: string,
  ): Promise<{ ok: boolean; branch?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; branch?: string; error?: string }>(
        'git.connect_to_remote',
        { workspace_path: ws, url },
        60_000,
      )
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `connectToRemote: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function cloneRepo(
    url: string,
    target_dir: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    const tag = `__clone__:${target_dir}`
    _activeCloneTag.value = tag
    try {
      const resp = await send<{ ok: boolean; path: string; error?: string }>('git.clone', {
        url,
        target_dir,
        workspace_path: tag,
      }, 65_000)
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `cloneRepo: ${msg}`
      return { ok: false, error: msg }
    } finally {
      _activeCloneTag.value = null
      settleCredentialPrompt()
    }
  }

  async function addToGitignore(
    pattern: string,
    target: IgnoreTarget = 'project',
    untrack = true,
  ): Promise<{ ok: boolean; error?: string; target_file?: string; untracked?: string[] }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string; target_file?: string; untracked?: string[] }>(
        'git.ignore',
        { workspace_path: ws, pattern, target, untrack },
      )
      if (resp.ok && resp.payload?.ok) await loadStatus()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `addToGitignore: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function checkIgnore(filepath: string): Promise<CheckIgnoreResult> {
    const ws = workspacePath()
    if (!ws) return { ok: false, ignored: false, tracked: false, source: '', line: 0, pattern: '', error: 'no workspace' }
    try {
      const resp = await send<CheckIgnoreResult>('git.check_ignore', { workspace_path: ws, filepath })
      return resp.payload ?? { ok: false, ignored: false, tracked: false, source: '', line: 0, pattern: '', error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, ignored: false, tracked: false, source: '', line: 0, pattern: '', error: msg }
    }
  }

  async function abortOperation(op: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.abort', {
        workspace_path: ws,
        op,
      })
      if (resp.ok && resp.payload?.ok) {
        await loadStatus()
        await loadLog()
      }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `abortOperation: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function stashApply(index: number): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; error?: string }>('git.stash_apply', {
        workspace_path: ws,
        index,
      })
      if (resp.ok && resp.payload?.ok) await loadStatus()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `stashApply: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function pullRebase(): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; output: string; error: string }>('git.pull_rebase', await withCredential(ws, {
        workspace_path: ws,
      }), 65_000)
      if (resp.ok && resp.payload?.ok) {
        await loadStatus()
        await loadLog()
      }
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `pullRebase: ${msg}`
      return { ok: false, error: msg }
    } finally {
      settleCredentialPrompt()
    }
  }

  async function pushForce(remote = '', branch = ''): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    try {
      const resp = await send<{ ok: boolean; output: string; error: string }>('git.push_force', await withCredential(ws, {
        workspace_path: ws, remote, branch,
      }), 65_000)
      if (resp.ok && resp.payload?.ok) await loadStatus()
      return resp.payload ?? { ok: false, error: 'no response' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `pushForce: ${msg}`
      return { ok: false, error: msg }
    } finally {
      settleCredentialPrompt()
    }
  }

  // Refresh when workspace changes
  watch(workspacePath, () => {
    gitStatus.value = emptyStatus()
    statusLoaded.value = false
    gitLog.value = []
    gitBranches.value = []
    gitStashes.value = []
    gitRemotes.value = []
    gitTags.value = []
    gitWorktrees.value = []
    gitConfig.value = {}
    void loadStatus()
    void loadLog()
    void loadBranches()
    void loadStashes()
    void loadRemotes()
    void loadTags()
    void loadWorktrees()
    void loadGitConfig()
  }, { immediate: true })

  // Re-fetch status when the "show ignored files" toggle flips.
  watch(showIgnored, () => { if (workspacePath()) void loadStatus() })

  // No background polling. Like VS Code/Cursor, refresh is purely event-driven:
  // the backend GitWatcher broadcasts git.changed on any disk change. The one
  // gap our cross-process setup has (that an in-editor extension doesn't) is a
  // WebSocket drop — a git.changed emitted while disconnected is lost. So on
  // (re)connect, re-sync once; loadStatus also re-registers this workspace with
  // the backend GitWatcher via git.status. loadLog is also re-called so that
  // windows that open before the WS is ready (e.g. miniIDE) get their history.
  const _stopReconnect = watch(
    () => transport.status.value,
    (s) => {
      if (s === 'connected' && workspacePath()) {
        void loadStatus()
        void loadLog()
        void loadWorktrees()
      }
    },
  )
  onScopeDispose(_stopReconnect)

  // Refresh on backend git.changed broadcast.
  // Debounce at 300 ms so rapid-fire events (e.g. GitWatcher fires once AND
  // app.py broadcasts once for the same operation) collapse into a single reload.
  let _gitChangedTimer: ReturnType<typeof setTimeout> | null = null
  const _offGitChanged = on('git.changed', (payload: unknown) => {
    const p = payload as { workspace_path?: string }
    if (!p?.workspace_path || p.workspace_path === workspacePath()) {
      if (_gitChangedTimer !== null) clearTimeout(_gitChangedTimer)
      _gitChangedTimer = setTimeout(() => {
        _gitChangedTimer = null
        void loadStatus()
        void loadLog()
        void loadBranches()
        void loadStashes()
        void loadRemotes()
        void loadTags()
        void loadWorktrees()
      }, 300)
    }
  })
  onScopeDispose(() => {
    _offGitChanged()
    if (_gitChangedTimer !== null) { clearTimeout(_gitChangedTimer); _gitChangedTimer = null }
  })

  // ── Git credential prompt (askpass) ──────────────────────────────────────
  // null while no push/pull/fetch is waiting on credentials.
  const credentialPrompt = ref<GitCredentialPrompt | null>(null)
  // True once the user has hit "submit". git resolves askpass invocations
  // sequentially (Username, then Password), so the second field's request_id
  // may not exist yet at submit time — this flag keeps the pairing alive
  // (with the Modal hidden) so the still-pending field can be auto-answered
  // with the value already typed, without asking the user again.
  const credentialSubmitting = ref(false)
  const showCredentialPrompt = computed(() => credentialPrompt.value !== null && !credentialSubmitting.value)
  // Set while this composable's cloneRepo() is in flight, tagged with a
  // synthetic id (not a real workspace path) rather than the pane's current
  // workspacePath(). The clone target isn't an open workspace anywhere yet,
  // so unlike every other operation below there's no stable "this is the repo
  // it's for" path to tag events with; using the pane's live, unrelated
  // workspacePath() would (a) drop the event if the pane navigates elsewhere
  // before the prompt arrives, since the filter re-reads workspacePath() live,
  // and (b) pop the prompt in every other window that happens to have that
  // same pre-clone folder open. The synthetic tag only ever matches this one
  // in-flight clone.
  const _activeCloneTag = ref<string | null>(null)

  // Anchored to git's askpass prompt format ("Username for '<url>': " /
  // "Password for '<url>': ") rather than a bare substring test — the URL
  // itself can legitimately contain "username" (e.g. an embedded login
  // https://username@host/...), which a substring test would misclassify.
  function isUsernamePrompt(prompt: string): boolean { return /^username\b/i.test(prompt) }
  function isPasswordPrompt(prompt: string): boolean { return /^password\b/i.test(prompt) }

  const _offCredentialRequest = on('git.credential_request', (payload: unknown) => {
    const p = payload as { request_id?: string; workspace_path?: string; host?: string; prompt?: string }
    if (!p?.request_id) return
    if (p.workspace_path && p.workspace_path !== workspacePath() && p.workspace_path !== _activeCloneTag.value) return
    const host = p.host ?? ''
    const prompt = p.prompt ?? ''
    const field = isUsernamePrompt(prompt) ? 'username' : isPasswordPrompt(prompt) ? 'password' : null

    const current = credentialPrompt.value
    if (!current || current.host !== host) {
      // New pairing (or a stale one for a different host) — start fresh.
      credentialSubmitting.value = false
      credentialPrompt.value = {
        host,
        usernameRequestId: field === 'username' ? p.request_id : null,
        passwordRequestId: field === 'password' ? p.request_id : null,
        username: '',
        password: '',
      }
      return
    }

    // Second field of an already in-flight pairing.
    if (field === 'username') current.usernameRequestId = p.request_id
    else if (field === 'password') current.passwordRequestId = p.request_id

    // The user already submitted while this field's request was still in
    // flight — auto-answer it now with the value they already typed.
    if (credentialSubmitting.value) {
      if (field === 'username') void send('git.credential_submit', { request_id: p.request_id, value: current.username })
      else if (field === 'password') void send('git.credential_submit', { request_id: p.request_id, value: current.password })
      credentialPrompt.value = null
      credentialSubmitting.value = false
    }
  })

  const _offCredentialCancelled = on('git.credential_cancelled', (payload: unknown) => {
    const p = payload as { request_id?: string }
    const current = credentialPrompt.value
    if (!current || !p?.request_id) return
    // Backend timed out or cancelled one of the two pending fields — the
    // whole pairing is now moot, close the modal so the user isn't left
    // staring at an input that will never resolve.
    if (p.request_id === current.usernameRequestId || p.request_id === current.passwordRequestId) {
      credentialPrompt.value = null
      credentialSubmitting.value = false
    }
  })

  onScopeDispose(() => {
    _offCredentialRequest()
    _offCredentialCancelled()
  })

  async function submitCredential(): Promise<void> {
    const current = credentialPrompt.value
    if (!current) return
    credentialSubmitting.value = true
    if (current.usernameRequestId) void send('git.credential_submit', { request_id: current.usernameRequestId, value: current.username })
    if (current.passwordRequestId) void send('git.credential_submit', { request_id: current.passwordRequestId, value: current.password })
    // git always asks for Password last (Username, if asked at all, comes
    // first) — so once passwordRequestId has arrived, this credential round
    // is complete and nothing more is coming, whether or not a username was
    // ever asked for (it's skipped entirely when already known via URL/config).
    // Requiring BOTH ids here left credentialSubmitting stuck true forever on
    // a password-only prompt, which then silently auto-submitted a blank
    // value to the next unrelated request for this host (see _offCredentialRequest).
    if (current.passwordRequestId) {
      credentialPrompt.value = null
      credentialSubmitting.value = false
    }
  }

  async function cancelCredential(): Promise<void> {
    const current = credentialPrompt.value
    if (!current) return
    if (current.usernameRequestId) void send('git.credential_cancel', { request_id: current.usernameRequestId })
    if (current.passwordRequestId) void send('git.credential_cancel', { request_id: current.passwordRequestId })
    credentialPrompt.value = null
    credentialSubmitting.value = false
  }

  // submitCredential()'s passwordRequestId check only catches the pairing
  // completing normally. It stays stuck if Password is never asked at all
  // (e.g. a credential helper already had it cached, so git only needed
  // Username via askpass) — there's no local signal for "no more fields are
  // coming" other than the whole git operation finishing. The backend awaits
  // the entire subprocess (including any askpass round-trips) before replying
  // to the git.* request, so by the time that response arrives no further
  // credential_request for this call can still be in flight — safe to clear
  // a leftover single-field pairing here. Guarded on credentialSubmitting so
  // it never touches an actively-displayed prompt still waiting on the user
  // (which, by the same reasoning, can't coexist with this operation settling).
  function settleCredentialPrompt(): void {
    if (credentialSubmitting.value) {
      credentialPrompt.value = null
      credentialSubmitting.value = false
    }
  }

  return {
    // state
    gitStatus, statusError, logError, commitDetailError, statusLoaded, discoveredRepos, discoverySkipped, showIgnored, gitLog, gitBranches, gitStashes, gitRemotes, gitTags,
    gitWorktrees, gitConfig,
    logScope, logOrder, logLimit, canLoadMoreLog,
    isLoadingStatus, isLoadingLog, isInitializing,
    isCommitting, isSyncing, isFetching, isGenerating,
    syncOutput, syncError,
    gitError, clearGitError,
    // loaders
    loadStatus, discoverRepositories, loadLog, loadMoreLog, logSearch, setLogScope, setLogOrder, loadBranches, loadStashes, loadRemotes, loadTags,
    loadWorktrees, loadGitConfig,
    // init
    initRepo,
    // file operations
    stageFile, unstageFile, stageAll, stageFiles, unstageFiles, discardFiles, discardFile, diffFile,
    fileLog, showFile, resolveConflictOurs, resolveConflictTheirs,
    conflictStages, listConflicts, markResolved,
    cleanUntracked, blameFile, diffBlame,
    // remote
    fetchRemote, pullOnly, pushOnly, pushUpstream, sync,
    addRemote, removeRemote,
    // branches
    createBranch, switchBranch, checkoutRemoteBranch, checkoutCommit, deleteBranch, mergeBranch, mergeInto, rebaseOn,
    compareBranches, diffBranches, restoreFileFromBranch,
    commitFileDiff,
    // stash
    stashPush, stashPop, stashDrop,
    // tags
    createTag, deleteTag,
    // worktrees
    addWorktree, removeWorktree, pruneWorktrees, lockWorktree, unlockWorktree, moveWorktree, repairWorktrees,
    // config
    gitConfigAllowedKeys, setGitConfig,
    // commit
    commit, amendCommit, undoLastCommit, revertCommit, resetToCommit, cherryPick, generateMessage,
    checkStaged,
    showCommit,
    // vscode-parity additions
    applyPatch, cloneRepo, connectToRemote, addToGitignore, checkIgnore, abortOperation, stashApply,
    pullRebase, pushForce,
    // credential prompt (askpass)
    credentialPrompt, showCredentialPrompt, submitCredential, cancelCredential,
  }
}
