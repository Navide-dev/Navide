import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import type { useBackend } from './useBackend'

export interface PipelineSummary {
  id: string
  name: string
  builtin: boolean
  stage_count: number
}

/**
 * Global pipelines cache. Loads from backend on mount and refreshes on
 * `pipelines.changed` broadcast. Provides CRUD operations.
 */
export function usePipelines(backend: ReturnType<typeof useBackend>) {
  const pipelines = ref<PipelineSummary[]>([])
  const activePipelineId = shallowRef<string>('default')
  const pipelinesPath = shallowRef<string>('')
  const isLoaded = ref<boolean>(false)
  const loading = ref<boolean>(false)
  const error = ref<string>('')
  /** Backend code of the last failure (e.g. PIPELINE_RUNNING); '' when none. */
  const errorCode = ref<string>('')

  let unsubChanged: (() => void) | null = null
  let unsubBackend: (() => void) | null = null

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const resp = await backend.send<{
        pipelines: PipelineSummary[]
        active_pipeline_id: string
        path: string
      }>('pipelines.list', {})
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'failed to load pipelines'
        errorCode.value = resp.error?.code ?? ''
        return
      }
      pipelines.value = resp.payload.pipelines
      activePipelineId.value = resp.payload.active_pipeline_id
      pipelinesPath.value = resp.payload.path
      isLoaded.value = true
    } catch (err) {
      error.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  unsubChanged = backend.on('pipelines.changed', (raw) => {
    const p = raw as { pipelines: PipelineSummary[]; active_pipeline_id: string }
    if (p?.pipelines) pipelines.value = p.pipelines
    if (p?.active_pipeline_id) activePipelineId.value = p.active_pipeline_id
  })

  let lastStatus = backend.status.value
  function maybeLoad(): void {
    if (backend.status.value === 'connected') void refresh()
  }
  maybeLoad()
  unsubBackend = (() => {
    const id = window.setInterval(() => {
      if (backend.status.value !== lastStatus) {
        lastStatus = backend.status.value
        maybeLoad()
      }
    }, 500)
    return () => window.clearInterval(id)
  })()

  onScopeDispose(() => {
    unsubChanged?.()
    unsubBackend?.()
  })

  const activePipeline = computed(
    () => pipelines.value.find((p) => p.id === activePipelineId.value) ?? null
  )
  const pipelineById = computed(() =>
    pipelines.value.reduce(
      (acc, p) => {
        acc[p.id] = p
        return acc
      },
      {} as Record<string, PipelineSummary>
    )
  )

  async function createPipeline(name: string): Promise<PipelineSummary | null> {
    try {
      const resp = await backend.send<{ pipeline: PipelineSummary; pipelines: PipelineSummary[] }>(
        'pipelines.create',
        { name }
      )
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'create failed'
        errorCode.value = resp.error?.code ?? ''
        return null
      }
      pipelines.value = resp.payload.pipelines
      return resp.payload.pipeline
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'create failed'
      errorCode.value = ''
      return null
    }
  }

  async function renamePipeline(pipelineId: string, name: string): Promise<boolean> {
    try {
      const resp = await backend.send<{ pipeline: PipelineSummary; pipelines: PipelineSummary[] }>(
        'pipelines.rename',
        { pipeline_id: pipelineId, name }
      )
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'rename failed'
        errorCode.value = resp.error?.code ?? ''
        return false
      }
      pipelines.value = resp.payload.pipelines
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'rename failed'
      errorCode.value = ''
      return false
    }
  }

  async function deletePipeline(
    pipelineId: string,
    workspacePath?: string
  ): Promise<boolean> {
    try {
      const resp = await backend.send<{ pipelines: PipelineSummary[] }>('pipelines.delete', {
        pipeline_id: pipelineId,
        workspace_path: workspacePath ?? '',
      })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'delete failed'
        errorCode.value = resp.error?.code ?? ''
        return false
      }
      pipelines.value = resp.payload.pipelines
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'delete failed'
      errorCode.value = ''
      return false
    }
  }

  async function setActivePipeline(
    pipelineId: string,
    workspacePath?: string
  ): Promise<boolean> {
    try {
      const resp = await backend.send<{
        active_pipeline_id: string
        pipelines: PipelineSummary[]
      }>('pipelines.set_active', {
        pipeline_id: pipelineId,
        workspace_path: workspacePath ?? '',
      })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'set active failed'
        errorCode.value = resp.error?.code ?? ''
        return false
      }
      activePipelineId.value = resp.payload.active_pipeline_id
      pipelines.value = resp.payload.pipelines
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'set active failed'
      errorCode.value = ''
      return false
    }
  }

  async function resetBuiltin(
    pipelineId: string,
    workspacePath?: string
  ): Promise<boolean> {
    try {
      const resp = await backend.send<{ pipeline: PipelineSummary; pipelines: PipelineSummary[] }>(
        'pipelines.reset_builtin',
        { pipeline_id: pipelineId, workspace_path: workspacePath ?? '' }
      )
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'reset failed'
        errorCode.value = resp.error?.code ?? ''
        return false
      }
      pipelines.value = resp.payload.pipelines
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'reset failed'
      errorCode.value = ''
      return false
    }
  }

  return {
    pipelines,
    activePipelineId,
    activePipeline,
    pipelineById,
    pipelinesPath,
    isLoaded,
    loading,
    error,
    errorCode,
    refresh,
    createPipeline,
    renamePipeline,
    deletePipeline,
    setActivePipeline,
    resetBuiltin,
  }
}
