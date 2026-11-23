import { onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { useBackend } from './useBackend'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'

const BENCHMARK_STORAGE_KEY = 'agent-team.benchmark-results'

export interface AnalyzerModel {
  name: string
  size: number
  family: string
  parameter_size: string
}

export type AnalyzerBackend = 'llama_cpp' | 'ollama'

export interface AnalyzerSettings {
  backend: AnalyzerBackend
  ollama_base_url: string
  llama_cli: string
  gguf_path: string
}

export interface AnalyzerHealth {
  ok: boolean
  version?: string
  default_model?: string
  backend?: AnalyzerBackend
  error?: string
  gguf_warning?: string
  gguf_size?: number
}

export interface PullProgress {
  name: string
  status: string
  digest?: string
  total?: number
  completed?: number
}

export interface ClassifyQuestion {
  prompt: string
  type: 'text' | 'choice'
  options: string[]
}

export interface ClassifyResult {
  intent: 'question' | 'completion' | 'in_progress'
  questions: ClassifyQuestion[]
  question?: ClassifyQuestion | null // legacy single-question (= questions[0])
  summary: string
  model?: string
  prompt_eval_count?: number
  eval_count?: number
  total_duration_ms?: number
  _error?: string
}

/** Optional context for attribution of the token usage to a workspace /
 *  pipeline stage / pane in the token stats panel. All fields are best-effort
 *  — backend records under "unknown" if any are missing. */
export interface ClassifyContext {
  workspacePath?: string
  stageId?: string
  paneId?: string
}

export interface BenchmarkTaskResult {
  task_id: string
  passed: boolean
  elapsed_s: number
}

export interface BenchmarkModelResult {
  name: string
  tasks: BenchmarkTaskResult[]
  score: number  // 0-3
  passed: boolean // score >= 2
}

export interface BenchmarkProgress {
  model: string
  task_id: string
  passed: boolean
  elapsed_s: number
  score: number
}

/**
 * Composable around the backend analyzer (Ollama-backed). Caches per-window
 * health + model list, surfaces classify() for the pipeline watcher.
 */
export function useAnalyzer(backend: ReturnType<typeof useBackend>) {
  const health = shallowRef<AnalyzerHealth | null>(null)
  const models = ref<AnalyzerModel[]>([])
  const defaultModel = ref<string>('')
  const loading = ref<boolean>(false)
  const lastError = ref<string>('')
  // When the last poll STARTED, whatever it returned. Keyed on success it
  // never advanced while the backend was down or timing out, so the 30s
  // spacing collapsed to every 5s tick — exactly when each poll was slowest.
  let lastRefreshAt = 0
  // Pane ids currently queued behind a running llama-cli call (analyzer.py's
  // _llama_sem serialises inference; a queued call can wait 10-60s with no
  // other feedback, which otherwise looks like a hung/broken connection).
  const queuedPaneIds = ref<Set<string>>(new Set())

  // ── Analyzer settings ─────────────────────────────────────────────────────
  const analyzerSettings = ref<AnalyzerSettings>({
    backend: 'llama_cpp',
    ollama_base_url: 'http://localhost:11434',
    llama_cli: '',
    gguf_path: '',
  })

  async function refreshSettings(): Promise<void> {
    if (backend.status.value !== 'connected') return
    try {
      const resp = await backend.send<AnalyzerSettings>('analyzer.settings.get', {})
      if (resp.ok && resp.payload) analyzerSettings.value = resp.payload
    } catch (err) {
      lastError.value = String((err as Error).message ?? err)
    }
  }

  async function detectLlamaCli(): Promise<{ found: string[]; recommended: string | null }> {
    if (backend.status.value !== 'connected') return { found: [], recommended: null }
    try {
      const resp = await backend.send<{ found: string[]; recommended: string | null }>(
        'analyzer.detect_llama_cli', {}
      )
      return (resp.ok && resp.payload) ? resp.payload : { found: [], recommended: null }
    } catch {
      return { found: [], recommended: null }
    }
  }

  async function saveSettings(updates: Partial<AnalyzerSettings>): Promise<void> {
    if (backend.status.value !== 'connected') return
    try {
      const resp = await backend.send<AnalyzerSettings>('analyzer.settings.set', updates)
      if (resp.ok && resp.payload) {
        analyzerSettings.value = resp.payload
        // Re-check health immediately so the UI reflects the new backend
        void refreshHealth()
        void refreshOllamaHealth()
        void refreshModels()
      }
    } catch (err) {
      lastError.value = String((err as Error).message ?? err)
    }
  }

  // ── Benchmark state (persisted to the settings store) ────────────────────
  const _stored = settingsGet<string | null>(BENCHMARK_STORAGE_KEY, null)
  const benchmarkResults = ref<BenchmarkModelResult[]>(
    (() => { try { return _stored ? JSON.parse(_stored) : [] } catch { return [] } })()
  )
  const benchmarking = ref<boolean>(false)
  const benchmarkProgress = ref<BenchmarkProgress | null>(null)

  // ── Ollama connectivity (for model management, independent of inference backend) ──
  const ollamaHealth = shallowRef<{ ok: boolean; version?: string; error?: string } | null>(null)

  async function refreshOllamaHealth(): Promise<void> {
    if (backend.status.value !== 'connected') return
    try {
      const resp = await backend.send<{ ok: boolean; version?: string; error?: string }>(
        'analyzer.ollama_health', {}
      )
      if (resp.ok && resp.payload) ollamaHealth.value = resp.payload
    } catch { /* non-fatal */ }
  }

  // ── Ollama model management ───────────────────────────────────────────────
  const pulling = ref<boolean>(false)
  const pullProgress = ref<PullProgress | null>(null)
  const pullError = ref<string>('')

  async function pullModel(name: string): Promise<void> {
    if (backend.status.value !== 'connected') return
    pulling.value = true
    pullProgress.value = { name, status: 'starting' }
    pullError.value = ''
    try {
      await backend.send('analyzer.pull', { name }, 10_000)
    } catch {
      // progress comes via push events; ignore timeout here
    }
  }

  async function deleteModel(name: string): Promise<{ ok: boolean; error?: string }> {
    if (backend.status.value !== 'connected') return { ok: false, error: 'not connected' }
    try {
      const resp = await backend.send<{ ok: boolean; error?: string }>('analyzer.delete', { name })
      if (resp.ok && resp.payload) {
        await refreshModels()
        return resp.payload
      }
      return { ok: false, error: resp.error?.message }
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) }
    }
  }

  async function refreshHealth(): Promise<AnalyzerHealth | null> {
    if (backend.status.value !== 'connected') return null
    try {
      const resp = await backend.send<AnalyzerHealth>('analyzer.health', {})
      if (resp.ok && resp.payload) {
        health.value = resp.payload
        defaultModel.value = resp.payload.default_model ?? defaultModel.value
        return resp.payload
      }
    } catch (err) {
      lastError.value = String((err as Error).message ?? err)
    }
    return null
  }

  async function refreshModels(): Promise<void> {
    if (backend.status.value !== 'connected') return
    loading.value = true
    try {
      const resp = await backend.send<{ models: AnalyzerModel[]; default: string }>(
        'analyzer.models',
        {}
      )
      if (resp.ok && resp.payload) {
        models.value = resp.payload.models
        if (resp.payload.default && !defaultModel.value) {
          defaultModel.value = resp.payload.default
        }
      }
    } catch (err) {
      lastError.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  async function classify(
    text: string,
    model?: string,
    ctx?: ClassifyContext
  ): Promise<ClassifyResult | null> {
    if (!text || text.trim().length === 0) return null
    if (backend.status.value !== 'connected') return null
    try {
      // Ollama inference can take 30–60 s on slower hardware; use a generous
      // timeout so the WS layer doesn't drop the response before it arrives.
      const resp = await backend.send<ClassifyResult>(
        'analyzer.classify',
        {
          text,
          model: model ?? undefined,
          workspace_path: ctx?.workspacePath ?? undefined,
          stage_id: ctx?.stageId ?? undefined,
          pane_id: ctx?.paneId ?? undefined
        },
        60_000
      )
      if (resp.ok && resp.payload) return resp.payload
      lastError.value = resp.error?.message ?? 'classify failed'
      return null
    } catch (err) {
      lastError.value = String((err as Error).message ?? err)
      return null
    } finally {
      if (ctx?.paneId && queuedPaneIds.value.has(ctx.paneId)) {
        const next = new Set(queuedPaneIds.value)
        next.delete(ctx.paneId)
        queuedPaneIds.value = next
      }
    }
  }

  async function benchmark(): Promise<void> {
    if (backend.status.value !== 'connected') return
    if (benchmarking.value) return
    benchmarking.value = true
    benchmarkProgress.value = null
    try {
      // Just kick it off — backend runs in background and pushes events
      await backend.send('analyzer.benchmark', {}, 10_000)
    } catch {
      // timeout or error starting — the done event will reset benchmarking
    }
  }

  // ── Backend push events ───────────────────────────────────────────────────
  const _offBenchmarkProgress = backend.on('analyzer.benchmark_progress', (payload) => {
    benchmarkProgress.value = payload as BenchmarkProgress
  })
  const _offBenchmarkDone = backend.on('analyzer.benchmark_done', (payload) => {
    const p = payload as { results: BenchmarkModelResult[]; cancelled?: boolean }
    // A run stopped part-way has no results: keep the last finished run's.
    if (!p.cancelled) {
      benchmarkResults.value = p.results ?? []
      settingsSet(BENCHMARK_STORAGE_KEY, JSON.stringify(benchmarkResults.value))
    }
    benchmarking.value = false
    benchmarkProgress.value = null
  })
  const _offSettingsChanged = backend.on('analyzer.settings_changed', (payload) => {
    analyzerSettings.value = payload as AnalyzerSettings
  })
  const _offPullProgress = backend.on('analyzer.pull_progress', (payload) => {
    pullProgress.value = payload as PullProgress
  })
  const _offQueued = backend.on('analyzer.queued', (payload) => {
    const p = payload as { pane_id?: string; stage_id?: string; workspace_path?: string }
    if (!p.pane_id) return
    queuedPaneIds.value = new Set(queuedPaneIds.value).add(p.pane_id)
  })
  const _offPullDone = backend.on('analyzer.pull_done', (payload) => {
    const p = payload as { name: string; ok: boolean; error?: string }
    pulling.value = false
    pullProgress.value = null
    if (p.ok) {
      pullError.value = ''
      void refreshModels()
    } else {
      pullError.value = p.error ?? 'pull failed'
    }
  })

  async function refreshAll(): Promise<void> {
    lastRefreshAt = Date.now()
    await refreshSettings()
    await refreshOllamaHealth()
    const h = await refreshHealth()
    if (h?.ok) await refreshModels()
  }

  watch(
    () => backend.status.value,
    (s) => {
      if (s === 'connected') void refreshAll()
      else {
        pulling.value = false
        pullProgress.value = null
        benchmarking.value = false
        benchmarkProgress.value = null
      }
    },
    { immediate: true }
  )

  let pollHandle: number | null = null
  pollHandle = window.setInterval(() => {
    if (backend.status.value !== 'connected') return
    if (Date.now() - lastRefreshAt > 30_000) void refreshAll()
  }, 5_000)

  onScopeDispose(() => {
    if (pollHandle !== null) window.clearInterval(pollHandle)
    _offBenchmarkProgress(); _offBenchmarkDone()
    _offSettingsChanged(); _offPullProgress(); _offPullDone(); _offQueued()
  })

  return {
    health,
    ollamaHealth,
    refreshOllamaHealth,
    models,
    defaultModel,
    loading,
    lastError,
    analyzerSettings,
    refreshSettings,
    saveSettings,
    detectLlamaCli,
    refreshHealth,
    refreshModels,
    classify,
    queuedPaneIds,
    benchmark,
    benchmarkResults,
    benchmarking,
    benchmarkProgress,
    pulling,
    pullProgress,
    pullError,
    pullModel,
    deleteModel,
  }
}
