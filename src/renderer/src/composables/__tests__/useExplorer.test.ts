// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { useExplorer, type FsEntry } from '../useExplorer'
import type { GitStatusSnapshot } from '../useGitStatusBadges'
import { createMockBackend, withScope, flush } from './mockBackend'

function entries(): FsEntry[] {
  return [
    { name: 'src', rel_path: 'src', is_dir: true, is_hidden: false, is_noise: false },
    { name: 'README.md', rel_path: 'README.md', is_dir: false, is_hidden: false, is_noise: false },
  ]
}

describe('useExplorer', () => {
  beforeEach(() => {
    try { sessionStorage.clear() } catch { /* ignore */ }
  })

  it('loadDir caches entries from fs.list_dir', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: entries() })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    await result.loadDir('')
    expect(result.childrenCache.value.get('')).toHaveLength(2)
    expect(mock.sent.some((s) => s.type === 'fs.list_dir')).toBe(true)
    scope.stop()
  })

  it('surfaces an error when the backend reports failure', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', null, { ok: false, error: { code: 'X', message: 'boom' } })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    await result.loadDir('')
    expect(result.error.value).toBeTruthy()
    // Failures record a per-dir error and leave the cache untouched.
    expect(result.childrenCache.value.has('')).toBe(false)
    expect(result.dirErrors.value.get('')).toBe('boom')
    scope.stop()
  })

  it('a failed expand records a per-dir error and re-expand retries', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: false, error: 'permission denied' })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    await result.toggleDir('src')
    expect(result.isExpanded('src')).toBe(true)
    expect(result.childrenCache.value.has('src')).toBe(false)
    expect(result.dirErrors.value.get('src')).toBe('permission denied')

    // Collapse and re-expand: the dir is uncached, so the load retries.
    await result.toggleDir('src')
    mock.setResponse('fs.list_dir', { ok: true, entries: entries() })
    await result.toggleDir('src')
    expect(result.childrenCache.value.get('src')).toHaveLength(2)
    expect(result.dirErrors.value.has('src')).toBe(false)
    scope.stop()
  })

  it('stores the truncated flag per dir and clears it on a full reload', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: entries(), truncated: true })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    await result.loadDir('')
    expect(result.truncatedDirs.value.has('')).toBe(true)

    mock.setResponse('fs.list_dir', { ok: true, entries: entries() })
    await result.loadDir('')
    expect(result.truncatedDirs.value.has('')).toBe(false)
    scope.stop()
  })

  it('pruneDir drops the dir and its descendants from expanded/cache state', async () => {
    const mock = createMockBackend('connected')
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    result.expanded.value = new Set(['src', 'src/sub', 'src2', 'other'])
    result.childrenCache.value = new Map([
      ['', entries()],
      ['src', []],
      ['src/sub', []],
      ['src2', []],
    ])
    result.pruneDir('src')
    // 'src2' shares the prefix string but is not a descendant — it must survive.
    expect(result.expanded.value).toEqual(new Set(['src2', 'other']))
    expect([...result.childrenCache.value.keys()].sort()).toEqual(['', 'src2'])
    scope.stop()
  })

  it('pruneDir with renamedTo keeps the subtree expanded under the new path', () => {
    const mock = createMockBackend('connected')
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    result.expanded.value = new Set(['src', 'src/sub', 'other'])
    result.pruneDir('src', 'lib')
    expect(result.expanded.value).toEqual(new Set(['lib', 'lib/sub', 'other']))
    scope.stop()
  })

  it('toggleDir expands and lazy-loads, collapse keeps no children walk', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: entries() })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    await result.toggleDir('src')
    expect(result.isExpanded('src')).toBe(true)
    expect(result.childrenCache.value.has('src')).toBe(true)
    await result.toggleDir('src')
    expect(result.isExpanded('src')).toBe(false)
    scope.stop()
  })

  it('setShowHidden persists and reloads with show_hidden=true', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: entries() })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    result.setShowHidden(true)
    await flush()
    expect(result.showHidden.value).toBe(true)
    expect(sessionStorage.getItem('agentTeam.explorerShowHidden')).toBe('1')
    const last = mock.sent.filter((s) => s.type === 'fs.list_dir').at(-1)
    expect((last?.payload as { show_hidden?: boolean }).show_hidden).toBe(true)
    scope.stop()
  })

  it('git.changed triggers a visible refresh', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: entries() })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    await result.loadDir('')
    const before = mock.sent.filter((s) => s.type === 'fs.list_dir').length
    mock.emit('git.changed', { workspace_path: '/ws' })
    await flush()
    const after = mock.sent.filter((s) => s.type === 'fs.list_dir').length
    expect(after).toBeGreaterThan(before)
    scope.stop()
  })

  it('ignores git.changed events from other workspaces', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: entries() })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    await result.loadDir('')
    const before = mock.sent.filter((s) => s.type === 'fs.list_dir').length

    mock.emit('git.changed', { workspace_path: '/other-ws' })
    await flush()
    expect(mock.sent.filter((s) => s.type === 'fs.list_dir').length).toBe(before)

    // A payload without workspace_path still refreshes (safety, like useGit).
    mock.emit('git.changed', {})
    await flush()
    expect(mock.sent.filter((s) => s.type === 'fs.list_dir').length).toBeGreaterThan(before)
    scope.stop()
  })

  it('window focus refreshes the visible tree, throttled to one per 5s', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: entries() })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    await result.loadDir('')
    const count = (): number => mock.sent.filter((s) => s.type === 'fs.list_dir').length
    const before = count()

    window.dispatchEvent(new Event('focus'))
    await flush()
    const afterFirst = count()
    expect(afterFirst).toBeGreaterThan(before)

    // Second focus within the 5s window: throttled, no new listing.
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(count()).toBe(afterFirst)

    // Past the window: refreshes again.
    const realNow = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 5001)
    window.dispatchEvent(new Event('focus'))
    await flush()
    const afterSecond = count()
    expect(afterSecond).toBeGreaterThan(afterFirst)

    // Scope disposal removes the listener.
    scope.stop()
    nowSpy.mockReturnValue(realNow + 60000)
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(count()).toBe(afterSecond)
    nowSpy.mockRestore()
  })

  it('skips the focus refresh while isRefreshBlocked returns true', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: entries() })
    const wp = ref('/ws')
    let blocked = true
    const { result, scope } = withScope(() =>
      useExplorer(mock.backend, wp, { isRefreshBlocked: () => blocked })
    )
    await result.loadDir('')
    const count = (): number => mock.sent.filter((s) => s.type === 'fs.list_dir').length
    const before = count()

    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(count()).toBe(before)

    // A blocked focus must not consume the throttle window: unblocking and
    // focusing again refreshes immediately.
    blocked = false
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(count()).toBeGreaterThan(before)
    scope.stop()
  })

  it('buildStatusMap: staged wins, untracked → U, unstaged → letter', () => {
    const mock = createMockBackend('connected')
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    const status = {
      staged: [{ path: 'a.ts', status: 'M' }],
      unstaged: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'M' }],
      untracked: [{ path: 'c.ts', status: '?' }],
    } as unknown as GitStatusSnapshot
    const map = result.buildStatusMap(status)
    expect(map.get('a.ts')).toEqual({ letter: 'M', staged: true })   // staged overrides unstaged
    expect(map.get('b.ts')).toEqual({ letter: 'M', staged: false })
    expect(map.get('c.ts')).toEqual({ letter: 'U', staged: false })
    expect(result.buildStatusMap(null).size).toBe(0)
    scope.stop()
  })
})
