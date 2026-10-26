// @vitest-environment happy-dom
// useStages owns two things nothing else covered: the `stages.changed` filter
// that keeps another pipeline's stages out of this cache, and the reconnect
// poller — which must die with the scope, because PipelineManagerModal creates
// its own instance and the host creates another.
import { describe, it, expect, vi } from 'vitest'
import { useStages } from '../useStages'
import { createMockBackend, withScope, flush } from './mockBackend'

const rawStage = (id: string, shortTitle: string): Record<string, unknown> => ({
  id,
  title: shortTitle,
  short_title: shortTitle,
  question: '',
  description: '',
  recommended_roles: [],
  sentinel: '',
  allow_questions: false,
  doc_query: '',
  slots: [{ agent_key: 'claude', role_key: '', label: shortTitle, kickoff_body: '' }],
})

describe('useStages', () => {
  it('loads the active pipeline stages on connect', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('stages.list', {
      stages: [rawStage('01', 'Spec')],
      pipeline_id: 'maintenance',
      path: '/data/stages.json',
    })

    const { result, scope } = withScope(() => useStages(mock.backend, () => 'maintenance'))
    await flush()

    expect(mock.sent).toContainEqual(
      expect.objectContaining({ type: 'stages.list', payload: { pipeline_id: 'maintenance' } })
    )
    expect(result.stages.value.map((s) => s.shortTitle)).toEqual(['Spec'])
    expect(result.isLoaded.value).toBe(true)
    scope.stop()
  })

  it('applies a stages.changed broadcast for the active pipeline', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('stages.list', {
      stages: [rawStage('01', 'Spec')],
      pipeline_id: 'default',
      path: '/data/stages.json',
    })

    const { result, scope } = withScope(() => useStages(mock.backend, () => 'default'))
    await flush()

    mock.emit('stages.changed', {
      stages: [rawStage('01', 'Spec'), rawStage('02', 'Build')],
      pipeline_id: 'default',
    })

    expect(result.stages.value.map((s) => s.shortTitle)).toEqual(['Spec', 'Build'])
    scope.stop()
  })

  it('ignores a stages.changed broadcast for a DIFFERENT pipeline', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('stages.list', {
      stages: [rawStage('01', 'Spec')],
      pipeline_id: 'default',
      path: '/data/stages.json',
    })

    const { result, scope } = withScope(() => useStages(mock.backend, () => 'default'))
    await flush()

    mock.emit('stages.changed', {
      stages: [rawStage('99', 'Someone else')],
      pipeline_id: 'maintenance',
    })

    expect(result.stages.value.map((s) => s.shortTitle)).toEqual(['Spec'])
    scope.stop()
  })

  it('applies an unlabelled stages.changed broadcast (no pipeline filter)', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('stages.list', {
      stages: [rawStage('01', 'Spec')],
      pipeline_id: 'default',
      path: '/data/stages.json',
    })

    const { result, scope } = withScope(() => useStages(mock.backend, () => 'default'))
    await flush()

    mock.emit('stages.changed', { stages: [rawStage('02', 'Build')] })

    expect(result.stages.value.map((s) => s.shortTitle)).toEqual(['Build'])
    scope.stop()
  })

  it('stops listening to stages.changed once the scope is disposed', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('stages.list', {
      stages: [rawStage('01', 'Spec')],
      pipeline_id: 'default',
      path: '/data/stages.json',
    })

    const { result, scope } = withScope(() => useStages(mock.backend, () => 'default'))
    await flush()
    scope.stop()

    mock.emit('stages.changed', { stages: [rawStage('02', 'Build')], pipeline_id: 'default' })

    expect(result.stages.value.map((s) => s.shortTitle)).toEqual(['Spec'])
  })

  it('drops the reconnect poller when the scope is disposed', async () => {
    vi.useFakeTimers()
    try {
      const mock = createMockBackend('disconnected')
      mock.setResponse('stages.list', {
        stages: [rawStage('01', 'Spec')],
        pipeline_id: 'default',
        path: '/data/stages.json',
      })

      // Positive control: while the scope is alive, a reconnect re-fetches.
      const live = withScope(() => useStages(mock.backend, () => 'default'))
      expect(mock.sent).toHaveLength(0)
      mock.status.value = 'connected'
      await vi.advanceTimersByTimeAsync(600)
      expect(mock.sent).toHaveLength(1)
      live.scope.stop()

      // Same lifecycle, but disposed before the reconnect: no work, no timer.
      mock.status.value = 'disconnected'
      const disposed = withScope(() => useStages(mock.backend, () => 'default'))
      disposed.scope.stop()
      const before = mock.sent.length
      mock.status.value = 'connected'
      await vi.advanceTimersByTimeAsync(5000)
      expect(mock.sent.length).toBe(before)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  // roles.rename repoints the persisted slots and broadcasts with
  // reason: "role_rename". Consumers holding an open draft need to know which
  // kind of change arrived, so the reason travels with the accepted stages.
  it('hands the accepted stages and the reason to onChanged', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('stages.list', {
      stages: [rawStage('01', 'Spec')],
      pipeline_id: 'default',
      path: '/data/stages.json',
    })
    const seen: { titles: string[]; reason: string }[] = []

    const { scope } = withScope(() =>
      useStages(mock.backend, () => 'default', (stages, reason) => {
        seen.push({ titles: stages.map((s) => s.shortTitle), reason })
      })
    )
    await flush()
    expect(seen).toHaveLength(0)

    mock.emit('stages.changed', {
      stages: [rawStage('01', 'Spec'), rawStage('02', 'Build')],
      pipeline_id: 'default',
      reason: 'role_rename',
    })

    expect(seen).toEqual([{ titles: ['Spec', 'Build'], reason: 'role_rename' }])
    scope.stop()
  })

  it('does not call onChanged for a broadcast the pipeline filter rejected', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('stages.list', {
      stages: [rawStage('01', 'Spec')],
      pipeline_id: 'default',
      path: '/data/stages.json',
    })
    const seen: string[] = []

    const { scope } = withScope(() =>
      useStages(mock.backend, () => 'default', (_stages, reason) => { seen.push(reason) })
    )
    await flush()

    mock.emit('stages.changed', {
      stages: [rawStage('99', 'Elsewhere')],
      pipeline_id: 'maintenance',
      reason: 'role_rename',
    })

    expect(seen).toEqual([])
    scope.stop()
  })

  it('reports an empty reason when the broadcast carries none', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('stages.list', {
      stages: [rawStage('01', 'Spec')],
      pipeline_id: 'default',
      path: '/data/stages.json',
    })
    const seen: string[] = []

    const { scope } = withScope(() =>
      useStages(mock.backend, () => 'default', (_stages, reason) => { seen.push(reason) })
    )
    await flush()

    mock.emit('stages.changed', { stages: [rawStage('02', 'Build')], pipeline_id: 'default' })

    expect(seen).toEqual([''])
    scope.stop()
  })

  it('drops a load made under an active id that has since changed (#417)', async () => {
    // The first load goes out under the 'default' placeholder before
    // pipelines.list answers; if it lands after the reload for the real id,
    // it must not overwrite that with another pipeline's stages.
    const mock = createMockBackend('connected')
    let activeId = 'default'
    const pending: Array<(v: unknown) => void> = []
    mock.backend.send = vi.fn(
      (_type: string, payload: Record<string, unknown> = {}) =>
        new Promise((resolve) => {
          const pid = String(payload.pipeline_id)
          pending.push(() =>
            resolve({
              ok: true,
              payload: { stages: [rawStage('01', pid)], pipeline_id: pid, path: '' },
            }),
          )
        }),
    ) as unknown as typeof mock.backend.send
    const { result, scope } = withScope(() => useStages(mock.backend, () => activeId))
    activeId = 'pl-2'
    const reload = result.refresh('pl-2')
    pending[1](null)
    await reload
    pending[0](null)
    await flush()
    expect(result.stages.value.map((s) => s.shortTitle)).toEqual(['pl-2'])
    scope.stop()
  })
})
