// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { useIssues } from '../useIssues'
import { formatIssueForDispatch } from '../../lib/issueDispatch'
import type { IssueDetail } from '../useIssues'
import { createMockBackend, withScope, flush } from './mockBackend'

const WS = '/tmp/test-workspace'

const ghProvider = {
  ok: true, provider: 'github', host: 'https://github.com/o/r.git',
  cli_available: true, authenticated: true, error: '',
}

const sampleIssue = {
  number: 42, title: 'A bug', state: 'open', author: 'alice',
  labels: ['bug'], assignees: [], updated_at: '2026-06-13T00:00:00Z',
  url: 'https://github.com/o/r/issues/42',
}

describe('useIssues', () => {
  it('does NOT auto-load on init (lazy)', async () => {
    const mock = createMockBackend('connected')
    const { result, scope } = withScope(() => useIssues(() => WS, mock.backend))
    await flush()
    // No provider/list calls until ensureLoaded() is invoked.
    expect(mock.sent.find(s => s.type === 'issues.provider')).toBeUndefined()
    expect(mock.sent.find(s => s.type === 'issues.list')).toBeUndefined()
    expect(result.loadedOnce.value).toBe(false)
    scope.stop()
  })

  it('ensureLoaded loads provider then issues when authenticated', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('issues.provider', ghProvider)
    mock.setResponse('issues.list', { ok: true, provider: 'github', issues: [sampleIssue] })

    const { result, scope } = withScope(() => useIssues(() => WS, mock.backend))
    await result.ensureLoaded()
    await flush()

    expect(result.provider.value.provider).toBe('github')
    expect(result.issues.value).toHaveLength(1)
    expect(result.issues.value[0].number).toBe(42)
    expect(result.loadedOnce.value).toBe(true)
    scope.stop()
  })

  it('ensureLoaded does not list when provider is unknown', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('issues.provider', { ...ghProvider, provider: 'unknown', authenticated: false })

    const { result, scope } = withScope(() => useIssues(() => WS, mock.backend))
    await result.ensureLoaded()
    await flush()

    expect(mock.sent.find(s => s.type === 'issues.list')).toBeUndefined()
    expect(result.loadedOnce.value).toBe(true)
    scope.stop()
  })

  it('does NOT lock loadedOnce when the provider probe fails, and recovers on retry', async () => {
    const mock = createMockBackend('connected')
    // First probe fails (e.g. transient WS error / backend not ready yet).
    mock.setResponse('issues.provider', {}, { ok: false, error: { code: 'x', message: 'boom' } })

    const { result, scope } = withScope(() => useIssues(() => WS, mock.backend))
    await result.ensureLoaded()
    await flush()

    // Stuck on the initial unknown, but NOT locked — otherwise the panel would
    // show "no supported issue host" forever.
    expect(result.provider.value.provider).toBe('unknown')
    expect(result.loadedOnce.value).toBe(false)

    // Backend recovers; a second ensureLoaded now resolves the provider + list.
    mock.setResponse('issues.provider', ghProvider)
    mock.setResponse('issues.list', { ok: true, provider: 'github', issues: [sampleIssue] })
    await result.ensureLoaded()
    await flush()

    expect(result.provider.value.provider).toBe('github')
    expect(result.issues.value).toHaveLength(1)
    expect(result.loadedOnce.value).toBe(true)
    scope.stop()
  })

  it('surfaces a backend list error into issuesError', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('issues.list', { ok: false, provider: 'github', issues: [], error: 'gh not found' })

    const { result, scope } = withScope(() => useIssues(() => WS, mock.backend))
    await result.loadIssues()
    await flush()

    expect(result.issues.value).toHaveLength(0)
    expect(result.issuesError.value).toBe('gh not found')
    scope.stop()
  })

  it('openIssue loads detail with comments', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('issues.get', {
      ok: true,
      issue: { ...sampleIssue, body: 'details', created_at: 'x', comments: [{ author: 'bob', body: 'hi', created_at: 'y' }] },
    })

    const { result, scope } = withScope(() => useIssues(() => WS, mock.backend))
    await result.openIssue(42)
    await flush()

    expect(result.selectedIssue.value?.body).toBe('details')
    expect(result.selectedIssue.value?.comments).toHaveLength(1)
    scope.stop()
  })

  it('createIssue reloads the list on success', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('issues.create', { ok: true, url: 'https://github.com/o/r/issues/99' })
    mock.setResponse('issues.list', { ok: true, provider: 'github', issues: [sampleIssue] })

    const { result, scope } = withScope(() => useIssues(() => WS, mock.backend))
    const r = await result.createIssue('New', 'body')
    await flush()

    expect(r.ok).toBe(true)
    expect(mock.sent.find(s => s.type === 'issues.list')).toBeDefined()
    scope.stop()
  })

  it('createIssue rejects empty title without calling backend', async () => {
    const mock = createMockBackend('connected')
    const { result, scope } = withScope(() => useIssues(() => WS, mock.backend))
    const r = await result.createIssue('   ', 'body')
    expect(r.ok).toBe(false)
    expect(mock.sent.find(s => s.type === 'issues.create')).toBeUndefined()
    scope.stop()
  })

  it('setState sends the new state and reloads', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('issues.set_state', { ok: true })
    mock.setResponse('issues.list', { ok: true, provider: 'github', issues: [] })

    const { result, scope } = withScope(() => useIssues(() => WS, mock.backend))
    const r = await result.setState(42, 'closed')
    await flush()

    expect(r.ok).toBe(true)
    const call = mock.sent.find(s => s.type === 'issues.set_state')
    expect(call?.payload.state).toBe('closed')
    scope.stop()
  })

  it('resets state when workspace changes', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('issues.list', { ok: true, provider: 'github', issues: [sampleIssue] })

    const wsRef = ref(WS)
    const { result, scope } = withScope(() => useIssues(() => wsRef.value, mock.backend))
    await result.loadIssues()
    await flush()
    expect(result.issues.value).toHaveLength(1)

    wsRef.value = '/tmp/other'
    await flush()
    expect(result.issues.value).toHaveLength(0)
    expect(result.loadedOnce.value).toBe(false)
    scope.stop()
  })
})

describe('formatIssueForDispatch', () => {
  const base: IssueDetail = {
    number: 42, title: 'A bug', state: 'open', author: 'alice',
    labels: ['bug'], assignees: [], updated_at: 'x',
    url: 'https://github.com/o/r/issues/42',
    body: 'Steps to reproduce', created_at: 'y', comments: [],
  }

  it('composes number, title, body and link', () => {
    const t = formatIssueForDispatch(base)
    expect(t).toContain('#42 A bug')
    expect(t).toContain('Steps to reproduce')
    expect(t).toContain('Link: https://github.com/o/r/issues/42')
  })

  it('includes comments when present', () => {
    const t = formatIssueForDispatch({
      ...base,
      comments: [{ author: 'bob', body: 'me too', created_at: 'z' }],
    })
    expect(t).toContain('--- comments ---')
    expect(t).toContain('bob: me too')
  })

  it('omits the comments section when there are none', () => {
    const t = formatIssueForDispatch(base)
    expect(t).not.toContain('--- comments ---')
  })

  it('omits the body section when body is empty', () => {
    const t = formatIssueForDispatch({ ...base, body: '   ' })
    expect(t).toContain('#42 A bug')
    // no stray body block — title is immediately followed by the link
    expect(t).not.toMatch(/A bug\n\n\s+\n/)
  })
})
