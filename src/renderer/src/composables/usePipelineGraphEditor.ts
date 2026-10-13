import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import type { useBackend } from './useBackend'
import { stageDefToFrontend, type Stage } from '../data/stages'
import {
  applyGraphOps,
  validateGraph,
  type GraphOp,
  type PipelineGraph,
} from '../lib/pipelineGraph'

/**
 * One pipeline's graph as the editor sees it, plus the undo/redo history both
 * views share (plan §6.2: switching swimlane ↔ canvas never clears history).
 *
 * Every edit is a Command: the ops that make it, and how to take it back. A
 * graph-only edit is taken back by restoring the graph it replaced
 * (`pipelines.graph.set`); a stage-metadata edit lives outside the graph, so
 * it carries its own inverse ops instead. Edits apply optimistically — the
 * view moves at once — and are rolled back if the backend refuses them.
 * Writes run one at a time, in the order they were made.
 */

export interface EditorError {
  code: string
  message: string
  details?: string[]
}

export type EditResult = { ok: true } | { ok: false; error: EditorError }

interface Command {
  label: string
  before: PipelineGraph
  after: PipelineGraph
  /** Present when restoring `before` cannot undo the edit (stage metadata). */
  undoOps?: GraphOp[]
  redoOps?: GraphOp[]
}

const HISTORY_LIMIT = 100

interface GraphPayload {
  pipeline_id: string
  graph: PipelineGraph
  stages?: Record<string, unknown>[]
  derived?: boolean
  reason?: string
}

const sameGraph = (a: PipelineGraph | null, b: PipelineGraph | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

export function usePipelineGraphEditor(
  backend: ReturnType<typeof useBackend>,
  opts: {
    pipelineId: () => string
    workspacePath: () => string
    /** True while a run uses this pipeline: edits are refused up front instead
     *  of failing after the user has drawn them. */
    locked?: () => boolean
  }
) {
  const graph = shallowRef<PipelineGraph | null>(null)
  const stages = ref<Stage[]>([])
  const derived = ref(false)
  const loading = ref(false)
  const loadError = ref<EditorError | null>(null)
  const pending = ref(0)
  const undoStack = ref<Command[]>([])
  const redoStack = ref<Command[]>([])
  /** Bumped when someone else (MCP, another window) rewrote the graph and the
   *  history had to be dropped — the view says so instead of going quiet. */
  const externalEdits = ref(0)

  const canUndo = computed(() => undoStack.value.length > 0 && pending.value === 0)
  const canRedo = computed(() => redoStack.value.length > 0 && pending.value === 0)
  const undoLabel = computed(() => undoStack.value.at(-1)?.label ?? '')
  const redoLabel = computed(() => redoStack.value.at(-1)?.label ?? '')

  /** The graph the backend last confirmed. A refused write falls back to
   *  this, never to the optimistic graph it was made on: that one may hold an
   *  earlier edit the backend refused too. */
  let confirmed: PipelineGraph | null = null
  let chain: Promise<unknown> = Promise.resolve()
  /** Serialise writes: each starts after the previous one has settled. */
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    pending.value++
    const run = chain.then(job, job)
    chain = run.catch(() => undefined)
    return run.finally(() => { pending.value-- })
  }

  function adopt(payload: GraphPayload): void {
    graph.value = payload.graph
    confirmed = payload.graph
    if (payload.stages) stages.value = payload.stages.map(stageDefToFrontend)
  }

  function errorOf(resp: { error?: { code?: string; message?: string; details?: Record<string, unknown> } | null }, fallback: string): EditorError {
    const details = resp.error?.details?.errors
    return {
      code: resp.error?.code ?? 'ERROR',
      // '' when the backend gave no reason: the view words that itself.
      message: resp.error?.message ?? fallback,
      details: Array.isArray(details) ? details.map(String) : undefined,
    }
  }

  async function load(): Promise<void> {
    const id = opts.pipelineId()
    if (!id) { graph.value = null; return }
    loading.value = true
    loadError.value = null
    try {
      const resp = await backend.send<GraphPayload>('pipelines.graph.get', { pipeline_id: id })
      if (id !== opts.pipelineId()) return
      if (!resp.ok || !resp.payload) { loadError.value = errorOf(resp, ''); return }
      adopt(resp.payload)
      derived.value = !!resp.payload.derived
      undoStack.value = []
      redoStack.value = []
    } catch (err) {
      loadError.value = { code: 'TRANSPORT', message: err instanceof Error ? err.message : String(err) }
    } finally {
      loading.value = false
    }
  }

  function refuseWhileLocked(): EditResult | null {
    return opts.locked?.()
      ? { ok: false, error: { code: 'PIPELINE_RUNNING', message: 'pipeline is running' } }
      : null
  }

  async function sendApply(ops: GraphOp[]): Promise<{ ok: true; payload: GraphPayload } | { ok: false; error: EditorError }> {
    try {
      const resp = await backend.send<GraphPayload>('pipelines.graph.apply', {
        pipeline_id: opts.pipelineId(),
        ops,
        workspace_path: opts.workspacePath(),
      })
      if (!resp.ok || !resp.payload) return { ok: false, error: errorOf(resp, '') }
      return { ok: true, payload: resp.payload }
    } catch (err) {
      return { ok: false, error: { code: 'TRANSPORT', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async function sendSet(target: PipelineGraph): Promise<{ ok: true; payload: GraphPayload } | { ok: false; error: EditorError }> {
    try {
      const resp = await backend.send<GraphPayload>('pipelines.graph.set', {
        pipeline_id: opts.pipelineId(),
        graph: target,
        workspace_path: opts.workspacePath(),
      })
      if (!resp.ok || !resp.payload) return { ok: false, error: errorOf(resp, '') }
      return { ok: true, payload: resp.payload }
    } catch (err) {
      return { ok: false, error: { code: 'TRANSPORT', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  /** Apply `ops` as one undoable step. `undoOps` is for edits a graph
   *  snapshot cannot reverse (stage metadata). */
  function execute(label: string, ops: GraphOp[], undoOps?: GraphOp[]): Promise<EditResult> {
    const locked = refuseWhileLocked()
    if (locked) return Promise.resolve(locked)
    if (!ops.length) return Promise.resolve({ ok: true })
    const current = graph.value
    if (!current) return Promise.resolve({ ok: false, error: { code: 'NO_GRAPH', message: 'no graph loaded' } })
    let next: PipelineGraph
    try {
      next = applyGraphOps(current, ops)
    } catch (err) {
      return Promise.resolve({ ok: false, error: { code: 'GRAPH_INVALID', message: err instanceof Error ? err.message : String(err) } })
    }
    const problems = validateGraph(next)
    if (problems.length) {
      return Promise.resolve({ ok: false, error: { code: 'GRAPH_INVALID', message: problems[0], details: problems } })
    }
    graph.value = next
    return enqueue(async () => {
      // What the backend applies the ops to — and so what undo restores.
      const before = confirmed ?? current
      const result = await sendApply(ops)
      if (!result.ok) {
        // Edits queued behind this one settle the view themselves.
        if (pending.value === 1) graph.value = confirmed
        return result
      }
      adopt(result.payload)
      derived.value = false
      undoStack.value = [...undoStack.value, { label, before, after: result.payload.graph, undoOps, redoOps: undoOps ? ops : undefined }].slice(-HISTORY_LIMIT)
      redoStack.value = []
      return { ok: true } as EditResult
    })
  }

  async function step(from: typeof undoStack, to: typeof redoStack, direction: 'undo' | 'redo'): Promise<EditResult> {
    const locked = refuseWhileLocked()
    if (locked) return locked
    const cmd = from.value.at(-1)
    if (!cmd) return { ok: true }
    // Stepping now would restore a graph the queued write is about to replace.
    if (pending.value) return { ok: false, error: { code: 'WRITE_PENDING', message: 'an edit is still saving' } }
    const target = direction === 'undo' ? cmd.before : cmd.after
    const inverse = direction === 'undo' ? cmd.undoOps : cmd.redoOps
    graph.value = target
    return enqueue(async () => {
      const result = inverse ? await sendApply(inverse) : await sendSet(target)
      if (!result.ok) {
        if (pending.value === 1) graph.value = confirmed
        return result
      }
      adopt(result.payload)
      from.value = from.value.slice(0, -1)
      to.value = [...to.value, cmd]
      return { ok: true } as EditResult
    })
  }

  const undo = (): Promise<EditResult> => step(undoStack, redoStack, 'undo')
  const redo = (): Promise<EditResult> => step(redoStack, undoStack, 'redo')

  // Someone else's write: adopt it, and drop a history that would now restore
  // graphs on top of their change. Our own echoes are ignored — they arrive
  // while the write is pending, or equal what we already hold.
  const offChanged = backend.on('pipeline.graph_changed', (raw) => {
    const payload = raw as GraphPayload
    if (!payload?.graph || payload.pipeline_id !== opts.pipelineId()) return
    if (pending.value > 0) return
    if (sameGraph(graph.value, payload.graph)) {
      if (payload.stages) stages.value = payload.stages.map(stageDefToFrontend)
      return
    }
    adopt(payload)
    derived.value = false
    if (undoStack.value.length || redoStack.value.length) {
      undoStack.value = []
      redoStack.value = []
      externalEdits.value++
    }
  })
  onScopeDispose(() => offChanged())

  return {
    graph,
    stages,
    derived,
    loading,
    loadError,
    pending,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    externalEdits,
    load,
    execute,
    undo,
    redo,
  }
}

export type PipelineGraphEditor = ReturnType<typeof usePipelineGraphEditor>
