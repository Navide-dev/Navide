import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitTransport } from '../../../../shared/gitCompatibility'
import { sameWorkspacePath, useGitStatusBadges } from '../useGitStatusBadges'

const WS = 'C:\\Users\\navide\\repo'

function fakeTransport(opts: { isRepo: boolean; echo?: boolean }) {
  const handlers: Array<(payload: unknown) => void> = []
  const status = ref('connected')
  const send = vi.fn(async (type: string) => {
    // A backend GitWatcher that reports its own status read as a change.
    if (opts.echo) setTimeout(() => { for (const h of handlers) h({ workspace_path: WS }) }, 50)
    if (type !== 'git.status') throw new Error(`unexpected ${type}`)
    return {
      ok: true,
      payload: { is_git_repo: opts.isRepo, staged: [], unstaged: [{ path: 'a.ts', status: 'M' }], untracked: [] },
      error: null,
    }
  })
  const transport = {
    status,
    send,
    on: (type: string, handler: (payload: unknown) => void) => {
      if (type === 'git.changed') handlers.push(handler)
      return () => { handlers.splice(handlers.indexOf(handler), 1) }
    },
  } as unknown as GitTransport
  const fire = (workspace_path?: string) => { for (const h of handlers) h({ workspace_path }) }
  return { transport, send, status, fire, handlers }
}

async function advance(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 50) await vi.advanceTimersByTimeAsync(50)
}

describe('useGitStatusBadges', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('reads only git.status and exposes it', async () => {
    const t = fakeTransport({ isRepo: true })
    const scope = effectScope()
    const badges = scope.run(() => useGitStatusBadges(() => WS, t.transport))!
    await badges.load()
    expect(t.send).toHaveBeenCalledWith('git.status', { workspace_path: WS })
    expect(badges.status.value?.unstaged).toEqual([{ path: 'a.ts', status: 'M' }])
    scope.stop()
    expect(t.handlers).toHaveLength(0)
  })

  it('reloads 300 ms after a git.changed for its own workspace only', async () => {
    const t = fakeTransport({ isRepo: true })
    const scope = effectScope()
    scope.run(() => useGitStatusBadges(() => WS, t.transport))
    t.fire('/somewhere/else')
    await advance(1_000)
    expect(t.send).not.toHaveBeenCalled()
    t.fire('c:/users/navide/repo/')
    await advance(250)
    expect(t.send).not.toHaveBeenCalled()
    await advance(100)
    expect(t.send).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  // A non-repository folder whose watcher echoes every status read: 300 ms
  // doubling to 30 s fits 7 reads in 60 s; 10 leaves slack for the first load.
  it('backs off on a folder that is not a repository and keeps reporting changes', async () => {
    const t = fakeTransport({ isRepo: false, echo: true })
    const scope = effectScope()
    const badges = scope.run(() => useGitStatusBadges(() => WS, t.transport))!
    await badges.load()
    await advance(60_000)
    scope.stop()
    expect(t.send.mock.calls.length).toBeLessThanOrEqual(10)
  })

  it('re-reads after the backend reconnects', async () => {
    const t = fakeTransport({ isRepo: true })
    const scope = effectScope()
    scope.run(() => useGitStatusBadges(() => WS, t.transport))
    t.status.value = 'disconnected'
    await nextTick()
    t.status.value = 'connected'
    await nextTick()
    expect(t.send).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('drops the previous workspace badges when the workspace changes', async () => {
    const t = fakeTransport({ isRepo: true })
    const ws = ref(WS)
    const scope = effectScope()
    const badges = scope.run(() => useGitStatusBadges(() => ws.value, t.transport))!
    await badges.load()
    ws.value = '/other'
    await nextTick()
    expect(badges.status.value).toBeNull()
    scope.stop()
  })

  it('compares Windows paths regardless of case and separators', () => {
    expect(sameWorkspacePath('C:\\Users\\Me\\', 'c:/users/me')).toBe(true)
    expect(sameWorkspacePath('/Users/Me', '/users/me')).toBe(false)
  })
})
