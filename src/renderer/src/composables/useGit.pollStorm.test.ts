// @vitest-environment happy-dom
//
// A home-folder workspace on Windows (C:\Users\<name>, not a repository, four
// repositories below it) made the backend start ~1078 git processes a minute:
// every git.changed for the folder re-ran the whole seven-command panel load,
// and the folder's own watcher kept sending git.changed while those commands
// ran. These tests model that echo — the fake backend answers every git read
// with a git.changed for the same folder — and count the git reads.
import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitTransport } from '../../../shared/gitCompatibility'
import { useGit } from './useGit'
import { useRepoDiscovery } from './useRepoDiscovery'

const HOME = 'C:\\Users\\navide'

// Requests the backend answers by spawning git. Discovery reads HEAD files and
// spawns nothing, so it is not counted.
const GIT_SPAWNING = new Set([
  'git.status', 'git.log', 'git.branches', 'git.stash_list', 'git.remotes',
  'git.tags', 'git.worktrees', 'git.config_get',
])

function statusPayload(isRepo: boolean) {
  return {
    is_git_repo: isRepo, branch: isRepo ? 'main' : '', remote_branch: '', ahead: 0, behind: 0,
    staged: [], unstaged: [], untracked: [], ignored: [], operation_in_progress: '',
  }
}

function echoingBackend(opts: { rootIsRepo: boolean; echoPath?: string; repos?: string[] }) {
  const handlers: Array<(payload: unknown) => void> = []
  const counts: Record<string, number> = {}
  let gitReads = 0
  const echo = () => {
    setTimeout(() => {
      for (const h of handlers) h({ workspace_path: opts.echoPath ?? HOME })
    }, 50)
  }
  const send = vi.fn(async (type: string, payload?: { workspace_path?: string }) => {
    counts[type] = (counts[type] ?? 0) + 1
    if (GIT_SPAWNING.has(type)) {
      gitReads += 1
      echo()
    }
    if (type === 'git.status') {
      const isRoot = payload?.workspace_path === HOME
      return { ok: true, payload: statusPayload(isRoot ? opts.rootIsRepo : true), error: null }
    }
    if (type === 'git.discover_repositories') {
      return {
        ok: true,
        payload: {
          ok: true,
          repositories: (opts.repos ?? []).map((name) => ({
            rel_path: name, abs_path: `${HOME}\\${name}`, branch: 'main',
          })),
        },
        error: null,
      }
    }
    // log/branch/stash/... on a folder that is not a repo: git exits 128.
    return opts.rootIsRepo
      ? { ok: true, payload: { ok: true }, error: null }
      : { ok: true, payload: { ok: false, error: 'not a git repository' }, error: null }
  })
  const transport = {
    status: ref('connected'),
    on: (type: string, handler: (payload: unknown) => void) => {
      if (type === 'git.changed') handlers.push(handler)
      return () => {
        const i = handlers.indexOf(handler)
        if (i >= 0) handlers.splice(i, 1)
      }
    },
    send,
  } as unknown as GitTransport
  return { transport, counts, gitReads: () => gitReads }
}

async function advance(ms: number): Promise<void> {
  // Step in small slices so promise continuations run between timers.
  for (let t = 0; t < ms; t += 50) await vi.advanceTimersByTimeAsync(50)
}

describe('Git panel on a workspace that is not a repository', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // N = 20: the mount loads the panel once (8 git reads), then a non-repo
  // workspace answers git.changed with a status read only (1 git read), backed
  // off from 300 ms doubling to a 30 s ceiling — 7 reads fit in 60 s. 15
  // expected, 20 leaves room for one extra reconnect sync. Before the fix the
  // echo re-ran all 7 commands every ~350 ms: about 1,200 reads a minute.
  it('keeps git reads under 20 in 60 s while the folder keeps reporting changes', async () => {
    const backend = echoingBackend({ rootIsRepo: false })
    const scope = effectScope()
    scope.run(() => useGit(() => HOME, backend.transport))
    await advance(60_000)
    scope.stop()
    expect(backend.gitReads()).toBeLessThanOrEqual(20)
    // Only status is re-read; log, branches and the rest can only fail here.
    expect(backend.counts['git.log']).toBe(1)
  })

  it('still re-reads a real repository on every git.changed, 300 ms after it', async () => {
    const backend = echoingBackend({ rootIsRepo: true })
    const scope = effectScope()
    scope.run(() => useGit(() => HOME, backend.transport))
    await advance(1_000)
    const before = backend.counts['git.log'] ?? 0
    await advance(1_000)
    scope.stop()
    // Each round: event 50 ms after the reads, reload 300 ms after the event.
    expect((backend.counts['git.log'] ?? 0) - before).toBeGreaterThanOrEqual(2)
  })

  it('matches a git.changed whose Windows path differs only in case and separators', async () => {
    const backend = echoingBackend({ rootIsRepo: true, echoPath: 'c:/users/navide' })
    const scope = effectScope()
    scope.run(() => useGit(() => HOME, backend.transport))
    await advance(1_000)
    scope.stop()
    expect(backend.counts['git.log'] ?? 0).toBeGreaterThan(1)
  })

  // N = 36: discovery reads one status per repository (4). The mount costs 4,
  // then each git.changed for the folder itself is backed off 400 ms doubling
  // to 30 s while the scan keeps finding the same repositories: 7 rescans in
  // 60 s (0.4 + 0.8 + … + 25.6 s), 32 reads; 36 leaves one rescan of slack.
  // Before the fix every ~450 ms rescan cost 4: about 530 reads a minute.
  it('keeps repository-badge reads under 36 in 60 s for a folder that keeps reporting changes', async () => {
    const backend = echoingBackend({
      rootIsRepo: false, repos: ['hwrepo1', 'hwrepo2', 'hwrepo3', 'hwrepo4'],
    })
    const scope = effectScope()
    scope.run(() => useRepoDiscovery(() => HOME, backend.transport))
    await advance(60_000)
    scope.stop()
    expect(backend.gitReads()).toBeLessThanOrEqual(36)
  })

  it('still refreshes a nested repository badge 400 ms after its own git.changed', async () => {
    const backend = echoingBackend({
      rootIsRepo: false, repos: ['hwrepo1'], echoPath: `${HOME}\\hwrepo1`,
    })
    const scope = effectScope()
    scope.run(() => useRepoDiscovery(() => HOME, backend.transport))
    await advance(2_000)
    scope.stop()
    // mount + one rescan per ~450 ms round
    expect(backend.counts['git.status'] ?? 0).toBeGreaterThanOrEqual(4)
  })
})
