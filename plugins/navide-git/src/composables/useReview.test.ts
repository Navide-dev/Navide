import { effectScope } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useReview } from './useReview'
import { createPluginGitReviewPort, type PluginCapabilitySdk } from '../pluginSurfacePorts'
import type { GitReviewPort, GitReviewResult } from '../ports/gitSurface'

const RESULT: GitReviewResult = { summary: 'ok', verdict: 'approve', findings: [] }

function fakeSdk() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const request = vi.fn(async (type: string, _payload?: Record<string, unknown>) => {
    if (type === 'aiCli.reviewStart') return { ok: true, payload: { reviewId: 'r1' }, error: null }
    if (type === 'aiCli.listModels') return { ok: true, payload: { ok: true, models: [{ name: 'qwen' }, { name: '' }] }, error: null }
    if (type === 'aiCli.getModelPreferences') return { ok: true, payload: { provider: 'ollama', model: 'qwen' }, error: null }
    return { ok: true, payload: { ok: true }, error: null }
  })
  const sdk = {
    request,
    subscribe: (type: string, cb: (payload: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), cb])
      return () => listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== cb))
    },
  } as unknown as PluginCapabilitySdk
  const emit = (type: string, payload: unknown) => { for (const l of listeners.get(type) ?? []) l(payload) }
  return { sdk, request, emit, listeners }
}

describe('createPluginGitReviewPort', () => {
  it('starts a branch review through aiCli.reviewStart with only the given fields', async () => {
    const { sdk, request } = fakeSdk()
    const port = createPluginGitReviewPort(sdk)
    await expect(port.start({ mode: 'branch', base: 'main', compare: 'feature' })).resolves.toBe('r1')
    expect(request).toHaveBeenCalledWith('aiCli.reviewStart', { mode: 'branch', base: 'main', compare: 'feature' })
    await port.start({ mode: 'working' })
    expect(request).toHaveBeenLastCalledWith('aiCli.reviewStart', { mode: 'working' })
  })

  it('reads model preferences and lists named models', async () => {
    const { sdk } = fakeSdk()
    const port = createPluginGitReviewPort(sdk)
    await expect(port.getModelPreferences()).resolves.toEqual({ provider: 'ollama', model: 'qwen' })
    await expect(port.listModels()).resolves.toEqual(['qwen'])
  })

  it('passes review events on with their review id and ignores malformed ones', () => {
    const { sdk, emit } = fakeSdk()
    const port = createPluginGitReviewPort(sdk)
    const onError = vi.fn()
    port.onError(onError)
    emit('aiCli.reviewError', { message: 'no id' })
    emit('aiCli.reviewError', { reviewId: 'r1', message: 'boom' })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('r1', 'boom')
  })

  it('throws the Host error when a call fails', async () => {
    const { sdk, request } = fakeSdk()
    request.mockResolvedValueOnce({ ok: false, payload: null, error: { code: 'CAPABILITY_DENIED', message: 'denied' } } as never)
    await expect(createPluginGitReviewPort(sdk).start({ mode: 'working' })).rejects.toThrow('denied')
  })
})

function controllablePort() {
  const handlers = { result: [] as Array<(id: string, r: GitReviewResult) => void>, end: [] as Array<(id: string) => void>, error: [] as Array<(id: string, m: string) => void> }
  let resolveStart: (id: string) => void = () => {}
  const port: GitReviewPort = {
    start: vi.fn(() => new Promise<string>((resolve) => { resolveStart = resolve })),
    stop: vi.fn(async () => {}),
    onResult: (cb) => { handlers.result.push(cb); return () => {} },
    onEnd: (cb) => { handlers.end.push(cb); return () => {} },
    onError: (cb) => { handlers.error.push(cb); return () => {} },
    getModelPreferences: vi.fn(async () => ({ provider: '', model: '' })),
    setModelPreferences: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
  }
  return { port, handlers, resolveStart: (id: string) => resolveStart(id) }
}

describe('useReview', () => {
  it('keeps a result that arrives before the Host returns the review id', async () => {
    const { port, handlers, resolveStart } = controllablePort()
    const scope = effectScope()
    const review = scope.run(() => useReview(port))!
    const started = review.startReview({ mode: 'working' })
    handlers.result.forEach((h) => h('r1', RESULT))
    handlers.result.forEach((h) => h('other', { ...RESULT, summary: 'not mine' }))
    resolveStart('r1')
    await started
    expect(review.reviewResult.value).toEqual(RESULT)
    handlers.end.forEach((h) => h('r1'))
    expect(review.isReviewing.value).toBe(false)
    expect(review.reviewError.value).toBe('')
    scope.stop()
  })

  it('stops the Host review when the user stopped before it started', async () => {
    const { port, resolveStart } = controllablePort()
    const scope = effectScope()
    const review = scope.run(() => useReview(port))!
    const started = review.startReview({ mode: 'working' })
    review.stopReview()
    resolveStart('r1')
    await started
    expect(port.stop).toHaveBeenCalledWith('r1')
    scope.stop()
  })

  it('reports a review that ended without a result', async () => {
    const { port, handlers, resolveStart } = controllablePort()
    const scope = effectScope()
    const review = scope.run(() => useReview(port))!
    const started = review.startReview({ mode: 'working' })
    resolveStart('r1')
    await started
    handlers.end.forEach((h) => h('r1'))
    expect(review.reviewError.value).not.toBe('')
    scope.stop()
  })
})
