import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import type { useBackend } from './useBackend'
import { stageDefToFrontend, type Stage } from '../data/stages'

/**
 * Per-window stages cache. Loads from backend on mount and refreshes whenever
 * the backend broadcasts a `stages.changed` event matching the current active
 * pipeline. Reconnect-safe.
 */
export function useStages(
  backend: ReturnType<typeof useBackend>,
  getActivePipelineId?: () => string,
  /** Called with the stages an accepted `stages.changed` carried, plus its
   *  `reason`. A consumer holding an open draft needs the reason to tell a
   *  role repoint (`role_rename`) from an ordinary edit. */
  onChanged?: (stages: Stage[], reason: string) => void
) {
  const stages = ref<Stage[]>([])
  const stagesPath = shallowRef<string>('')
  const isLoaded = ref<boolean>(false)
  const loading = ref<boolean>(false)
  const error = ref<string>('')

  let unsubChanged: (() => void) | null = null
  let unsubBackend: (() => void) | null = null

  async function refresh(pipelineId?: string): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const pid = pipelineId ?? getActivePipelineId?.() ?? undefined
      const resp = await backend.send<{
        stages: Record<string, unknown>[]
        path: string
        pipeline_id: string
      }>('stages.list', pid ? { pipeline_id: pid } : {})
      // A load made under the active id is stale once that id has moved on:
      // the first load goes out under the 'default' placeholder before
      // pipelines.list answers, and could land after the real id's (#417).
      if (pipelineId === undefined && getActivePipelineId && getActivePipelineId() !== pid) return
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'failed to load stages'
        return
      }
      stages.value = resp.payload.stages.map(stageDefToFrontend)
      stagesPath.value = resp.payload.path
      isLoaded.value = true
    } catch (err) {
      error.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  // Subscribe to backend broadcasts. Only apply if the changed pipeline matches
  // the currently active pipeline (ignore edits to other pipelines).
  unsubChanged = backend.on('stages.changed', (raw) => {
    const payload = raw as {
      stages: Record<string, unknown>[]
      pipeline_id?: string
      reason?: string
    }
    if (!payload?.stages) return
    const activePid = getActivePipelineId?.() ?? ''
    const changedPid = payload.pipeline_id ?? ''
    // Accept if no filter, or if changed pipeline matches active
    if (!changedPid || !activePid || changedPid === activePid) {
      const next = payload.stages.map(stageDefToFrontend)
      stages.value = next
      onChanged?.(next, payload.reason ?? '')
    }
  })

  // Initial load — wait until backend is connected then fetch. Also re-fetch on reconnect.
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

  const stageById = computed(() =>
    stages.value.reduce(
      (acc, s) => {
        acc[s.id] = s
        return acc
      },
      {} as Record<string, Stage>
    )
  )

  return { stages, stageById, stagesPath, isLoaded, loading, error, refresh }
}
