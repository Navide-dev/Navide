// @vitest-environment happy-dom
import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { GitTransport } from '#git-feature'
import { useGit } from './useGit'

// A failed read of the history or of one commit used to leave the old list (or
// an empty detail) with nothing saying why. The panel shows these reasons.

type Reply = { ok: boolean; payload: unknown; error: { code: string; message: string } | null }

function transportWith(replies: Record<string, () => Reply>): GitTransport {
  return {
    status: ref('connected'),
    on: () => () => undefined,
    send: vi.fn(async (type: string) => {
      const reply = replies[type]
      return reply ? reply() : { ok: true, payload: null, error: null }
    }),
  } as unknown as GitTransport
}

const commit = { hash: 'a1', short_hash: 'a1', subject: 'first', author: 'me', date: '2026-10-15' }

describe('useGit read errors', () => {
  it('keeps the commit list and names the reason when git.log fails', async () => {
    let log: () => Reply = () => ({ ok: true, payload: { commits: [commit] }, error: null })
    const transport = transportWith({ 'git.log': () => log() })
    const scope = effectScope()
    const git = scope.run(() => useGit(() => '/workspace', transport))!
    expect(await git.loadLog()).toBe(true)
    expect(git.logError.value).toBe('')

    log = () => ({ ok: false, payload: null, error: { code: 'GIT_ERROR', message: 'fatal: bad object' } })
    expect(await git.loadLog()).toBe(false)
    expect(git.logError.value).toBe('fatal: bad object')
    expect(git.gitLog.value).toHaveLength(1)

    log = () => { throw new Error('request timed out') }
    await git.loadLog()
    expect(git.logError.value).toBe('request timed out')

    log = () => ({ ok: true, payload: { commits: [commit] }, error: null })
    await git.loadLog()
    expect(git.logError.value).toBe('')
    scope.stop()
  })

  it('names the reason when a commit cannot be shown', async () => {
    let show: () => Reply = () => ({ ok: true, payload: { ok: false, error: 'bad revision' }, error: null })
    const transport = transportWith({ 'git.show_commit': () => show() })
    const scope = effectScope()
    const git = scope.run(() => useGit(() => '/workspace', transport))!
    expect(await git.showCommit('zz')).toBeNull()
    expect(git.commitDetailError.value).toBe('bad revision')

    show = () => { throw new Error('request timed out') }
    expect(await git.showCommit('zz')).toBeNull()
    expect(git.commitDetailError.value).toBe('request timed out')

    show = () => ({ ok: true, payload: { ok: true, hash: 'a1', files: [] }, error: null })
    expect(await git.showCommit('a1')).not.toBeNull()
    expect(git.commitDetailError.value).toBe('')
    scope.stop()
  })
})
