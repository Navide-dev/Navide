// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useAnalyzer, type ClassifyResult } from '../useAnalyzer'
import { createMockBackend, withScope, flush } from './mockBackend'

const okResult: ClassifyResult = {
  intent: 'question',
  questions: [{ prompt: '要哪個 DB?', type: 'choice', options: ['PostgreSQL', 'MySQL'] }],
  summary: 'asking db'
}

describe('useAnalyzer', () => {
  it('loads health + models on connect', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('analyzer.health', { ok: true, version: '1.0', default_model: 'qwen2.5-coder' })
    mock.setResponse('analyzer.models', {
      models: [{ name: 'qwen2.5-coder', size: 1, family: 'qwen', parameter_size: '7b' }],
      default: 'qwen2.5-coder'
    })

    const { result, scope } = withScope(() => useAnalyzer(mock.backend))
    await flush()

    expect(result.health.value?.ok).toBe(true)
    expect(result.defaultModel.value).toBe('qwen2.5-coder')
    expect(result.models.value).toHaveLength(1)
    scope.stop()
  })

  it('does not fetch models when health is not ok', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('analyzer.health', { ok: false, error: 'llama-cli not found' })

    const { result, scope } = withScope(() => useAnalyzer(mock.backend))
    await flush()

    expect(result.health.value?.ok).toBe(false)
    expect(mock.sent.some((s) => s.type === 'analyzer.models')).toBe(false)
    scope.stop()
  })

  it('classify() returns the backend result', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('analyzer.health', { ok: true, default_model: 'qwen' })
    mock.setResponse('analyzer.models', { models: [], default: 'qwen' })
    mock.setResponse('analyzer.classify', okResult)

    const { result, scope } = withScope(() => useAnalyzer(mock.backend))
    await flush()

    const r = await result.classify('agent 列出了選項...', 'qwen', { paneId: 'p1' })
    expect(r?.intent).toBe('question')
    expect(r?.questions[0].options).toEqual(['PostgreSQL', 'MySQL'])
    scope.stop()
  })

  it('classify() short-circuits on empty text without hitting the backend', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('analyzer.health', { ok: false })
    const { result, scope } = withScope(() => useAnalyzer(mock.backend))
    await flush()

    const before = mock.sent.length
    const r = await result.classify('   ')
    expect(r).toBeNull()
    expect(mock.sent.length).toBe(before) // no analyzer.classify sent
    scope.stop()
  })

  it('classify() returns null when disconnected', async () => {
    const mock = createMockBackend('disconnected')
    const { result, scope } = withScope(() => useAnalyzer(mock.backend))
    await flush()

    expect(await result.classify('some text')).toBeNull()
    scope.stop()
  })

  it('analyzer.queued adds the pane id, classify() clears it once it resolves', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('analyzer.health', { ok: true, default_model: 'qwen' })
    mock.setResponse('analyzer.models', { models: [], default: 'qwen' })
    mock.setResponse('analyzer.classify', okResult)

    const { result, scope } = withScope(() => useAnalyzer(mock.backend))
    await flush()

    mock.emit('analyzer.queued', { pane_id: 'p1', stage_id: 's1', workspace_path: '/ws' })
    expect(result.queuedPaneIds.value.has('p1')).toBe(true)

    await result.classify('agent 列出了選項...', 'qwen', { paneId: 'p1' })
    expect(result.queuedPaneIds.value.has('p1')).toBe(false)
    scope.stop()
  })

  it('a cancelled benchmark ends the run but keeps the last results', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('analyzer.health', { ok: false })
    const { result, scope } = withScope(() => useAnalyzer(mock.backend))
    await flush()

    const finished = [{ model: 'qwen' }] as unknown as typeof result.benchmarkResults.value
    mock.emit('analyzer.benchmark_done', { results: finished })
    result.benchmarking.value = true
    mock.emit('analyzer.benchmark_done', { results: [], cancelled: true })

    expect(result.benchmarking.value).toBe(false)
    expect(result.benchmarkResults.value).toEqual(finished)
    scope.stop()
  })

  describe('health polling', () => {
    afterEach(() => vi.useRealTimers())

    const healthSends = (mock: ReturnType<typeof createMockBackend>) =>
      mock.sent.filter((s) => s.type === 'analyzer.health').length

    it('a failed health poll is not retried on the next 5s tick', async () => {
      // The Windows stall: each poll timed out (8s), the "last health" stamp
      // never advanced, and the 5s tick re-polled every time — 25 stalls in
      // five minutes on the backend, each one a fresh SSL context.
      vi.useFakeTimers()
      const mock = createMockBackend('connected')
      mock.setRejection('analyzer.health', 'request analyzer.health timeout')

      const { scope } = withScope(() => useAnalyzer(mock.backend))
      await vi.advanceTimersByTimeAsync(0)
      expect(healthSends(mock)).toBe(1)

      await vi.advanceTimersByTimeAsync(25_000)
      expect(healthSends(mock)).toBe(1)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(healthSends(mock)).toBe(2)
      scope.stop()
    })

    it('an empty model list does not shorten the poll spacing either', async () => {
      vi.useFakeTimers()
      const mock = createMockBackend('connected')
      mock.setResponse('analyzer.health', { ok: true, default_model: 'qwen' })
      mock.setResponse('analyzer.models', { models: [], default: 'qwen' })

      const { scope } = withScope(() => useAnalyzer(mock.backend))
      await vi.advanceTimersByTimeAsync(0)
      expect(healthSends(mock)).toBe(1)

      await vi.advanceTimersByTimeAsync(25_000)
      expect(healthSends(mock)).toBe(1)
      scope.stop()
    })
  })
})
