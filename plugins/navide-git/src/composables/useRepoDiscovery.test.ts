// @vitest-environment happy-dom
import { effectScope } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { GitTransport } from '#git-feature'
import { useRepoDiscovery } from './useRepoDiscovery'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('useRepoDiscovery forced refresh ownership', () => {
  it('does not let a later skipped automatic refresh replace an accepted forced result', async () => {
    const forcedBadge = deferred<unknown>()
    const skippedBadge = deferred<unknown>()
    let discoverCall = 0
    let statusCall = 0
    const send = vi.fn(async (type: string) => {
      if (type === 'git.discover_repositories') {
        discoverCall += 1
        if (discoverCall === 1) {
          return { ok: true, payload: { ok: true, skipped: 'cloud_storage', repositories: [] } }
        }
        if (discoverCall === 2) {
          return {
            ok: true,
            payload: {
              ok: true,
              repositories: [{ rel_path: 'repo', abs_path: '/ws/repo', branch: 'main' }],
            },
          }
        }
        return {
          ok: true,
          payload: {
            ok: true,
            skipped: 'cloud_storage',
            repositories: [{ rel_path: '.', abs_path: '/ws', branch: 'main' }],
          },
        }
      }
      statusCall += 1
      return statusCall === 1 ? forcedBadge.promise : skippedBadge.promise
    })
    const transport = { send, on: () => () => undefined } as unknown as GitTransport
    const scope = effectScope()
    const discovery = scope.run(() => useRepoDiscovery(() => '/ws', transport))!
    await flush()

    const forced = discovery.refresh(true)
    await flush()
    expect(statusCall).toBe(1)
    const automatic = discovery.refresh()
    await flush()

    forcedBadge.resolve({
      ok: true,
      payload: { branch: 'main', staged: [], unstaged: [], untracked: [] },
    })
    await forced
    skippedBadge.resolve({
      ok: true,
      payload: { branch: 'main', staged: [], unstaged: [], untracked: [] },
    })
    await automatic

    expect(discovery.repositories.value.map((repo) => repo.abs_path)).toEqual(['/ws/repo'])
    expect(discovery.discoverySkipped.value).toBe(false)
    scope.stop()
  })
})

describe('useRepoDiscovery failure and Windows paths', () => {
  it('marks the badge when the status read failed instead of showing a clean repo', async () => {
    // get_status reports a failed or timed-out read inside a successful envelope (#144).
    const send = vi.fn(async (type: string) => type === 'git.discover_repositories'
      ? { ok: true, payload: { ok: true, repositories: [{ rel_path: 'a', abs_path: '/ws/a', branch: 'main' }] } }
      : { ok: true, payload: { ok: false, error: 'git timed out' } })
    const transport = { send, on: () => () => undefined } as unknown as GitTransport
    const scope = effectScope()
    const discovery = scope.run(() => useRepoDiscovery(() => '/ws', transport))!
    await flush()
    await flush()
    expect(discovery.repositories.value[0].badge).toEqual({
      branch: 'main', dirtyCount: 0, error: 'git timed out',
    })

    await discovery.adopt([{ rel_path: 'b', abs_path: '/ws/b', branch: 'dev' }])
    expect(discovery.repositories.value[0].badge).toEqual({
      branch: 'dev', dirtyCount: 0, error: 'git timed out',
    })
    scope.stop()
  })
  it('flags a failed scan and clears the flag once a scan succeeds (MED-5)', async () => {
    let fail = true
    const send = vi.fn(async (type: string) => {
      if (type !== 'git.discover_repositories') return { ok: true, payload: { branch: 'main', staged: [], unstaged: [], untracked: [] } }
      return fail
        ? { ok: false, payload: null, error: { code: 'BACKEND_ERROR', message: 'down' } }
        : { ok: true, payload: { ok: true, repositories: [] } }
    })
    const transport = { send, on: () => () => undefined } as unknown as GitTransport
    const scope = effectScope()
    const discovery = scope.run(() => useRepoDiscovery(() => '/ws', transport))!
    await flush()
    expect(discovery.discoveryFailed.value).toBe(true)

    fail = false
    await discovery.refresh()
    expect(discovery.discoveryFailed.value).toBe(false)
    scope.stop()
  })

  it('re-scans on a git.changed event from a nested repository with backslash paths (MED-5)', async () => {
    vi.useFakeTimers()
    try {
      let changed: ((payload: unknown) => void) | null = null
      const send = vi.fn(async () => ({ ok: true, payload: { ok: true, repositories: [] } }))
      const transport = {
        send,
        on: (type: string, cb: (payload: unknown) => void) => { if (type === 'git.changed') changed = cb; return () => undefined },
      } as unknown as GitTransport
      const scope = effectScope()
      scope.run(() => useRepoDiscovery(() => 'C:\\ws', transport))
      await vi.advanceTimersByTimeAsync(0)
      const before = send.mock.calls.length
      changed!({ workspace_path: 'C:\\ws\\sub' })
      await vi.advanceTimersByTimeAsync(500)
      expect(send.mock.calls.length).toBeGreaterThan(before)
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-scans for a folder change only when it can add or remove a repo', async () => {
    // A home folder with nested repos: a file written beside them used to
    // re-read every repo's status (Windows VM, homews samples.txt).
    vi.useFakeTimers()
    try {
      let changed: ((payload: unknown) => void) | null = null
      const send = vi.fn(async () => ({ ok: true, payload: { ok: true, repositories: [] } }))
      const transport = {
        send,
        on: (type: string, cb: (payload: unknown) => void) => { if (type === 'git.changed') changed = cb; return () => undefined },
      } as unknown as GitTransport
      const scope = effectScope()
      scope.run(() => useRepoDiscovery(() => '/home/u', transport))
      await vi.advanceTimersByTimeAsync(0)
      const scans = () => send.mock.calls.filter(([type]) => type === 'git.discover_repositories').length
      const before = scans()

      changed!({ workspace_path: '/home/u', paths: [{ rel_path: 'wh/samples.txt', change: 'modified' }] })
      await vi.advanceTimersByTimeAsync(500)
      expect(scans()).toBe(before)

      changed!({ workspace_path: '/home/u', paths: [{ rel_path: 'new/.git/HEAD', change: 'created' }] })
      await vi.advanceTimersByTimeAsync(500)
      expect(scans()).toBe(before + 1)

      // A directory-only window carries no paths: it may be a repo moved in.
      changed!({ workspace_path: '/home/u', paths: [] })
      await vi.advanceTimersByTimeAsync(31_000)
      expect(scans()).toBe(before + 2)
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
