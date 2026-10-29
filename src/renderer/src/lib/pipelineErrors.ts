// Turns a backend rejection from the pipeline/stage/role handlers into text in
// the UI language. The handlers answer with a stable `code` plus an English
// sentence; codes the editor understands get their own translated message, and
// anything else falls back to the backend's sentence (better than a bare
// "failed") or, without one, the caller's generic key.
//
// The run controls (ui.pipeline.*) and the start refusals do the same with the
// `code`/`params` their errors carry; the English sentence stays for MCP
// callers and is offered here as the toast's Details.

import type { GraphProblem } from './pipelineGraph'

export interface BackendErrorLike {
  code?: string
  message?: string
  details?: Record<string, unknown>
}

type Translate = (key: string, named?: Record<string, unknown>) => string

const KNOWN_CODES: Record<string, string> = {
  PIPELINE_RUNNING: 'pipelineEditor.error.pipeline-running',
  PIPELINE_NOT_FOUND: 'pipelineEditor.error.pipeline-not-found',
  STAGE_NOT_FOUND: 'pipelineErrors.stage-not-found',
  N8N_INVALID: 'pipelineImport.error.invalid',
}

/** `details.reason` of a PIPELINE_REFUSED answer (stages_store.StoreRefused). */
export const REFUSAL_REASONS = [
  'last-pipeline',
  'last-stage',
  'not-builtin',
  'no-seed',
  'stage-id-required',
  'stage-id-invalid',
  'stage-needs-slot',
] as const

export function backendErrorText(
  t: Translate,
  error: BackendErrorLike | null | undefined,
  fallbackKey: string
): string {
  const reason = error?.details?.reason
  if (error?.code === 'PIPELINE_REFUSED' && (REFUSAL_REASONS as readonly unknown[]).includes(reason)) {
    return t(`pipelineErrors.refused.${String(reason)}`)
  }
  const known = error?.code ? KNOWN_CODES[error.code] : undefined
  if (known) return t(known)
  return error?.message || t(fallbackKey)
}

/** `code` on an error a ui.pipeline.* command throws (App.vue). */
export const RUN_ERROR_CODES = [
  'no-workspace',
  'already-running',
  'no-pipeline',
  'not-started',
  'not-running',
  'last-stage',
  'gate-waiting',
  'not-advanced',
  'no-run',
  'nothing-to-resume',
  'not-resumed',
  'not-cleared',
  'stored-not-cleared',
  'no-task',
  'not-at-gate',
  'wrong-gate',
  'node-required',
] as const

/** Why onPipelineStart refused a run (App.vue `refuse`). */
export const START_REFUSAL_CODES = [
  'parent-suspended',
  'switch-failed',
  'stages-load-failed',
  'no-stages',
  'graph-failed',
  'spawn-failed',
  // The backend refused to record the run: another window's run is in
  // progress here (PIPELINE_ALREADY_RUNNING), or the request failed.
  'already-running',
  'not-recorded',
] as const

/** A start refusal as onPipelineStart reports it. */
export interface StartRefusal {
  code: (typeof START_REFUSAL_CODES)[number]
  params?: Record<string, unknown>
}

export interface CodedFailure {
  code?: string
  params?: Record<string, unknown>
}

const isIn = (list: readonly string[], v: unknown): v is string => typeof v === 'string' && list.includes(v)

/** A start refusal in the UI language; '' when its code is unknown. */
export function startRefusalText(t: Translate, refusal: CodedFailure | null | undefined): string {
  return refusal && isIn(START_REFUSAL_CODES, refusal.code)
    ? t(`pipelineErrors.start.${refusal.code}`, refusal.params ?? {})
    : ''
}

/** A refused ui.pipeline.* command in the UI language. `label` turns a node id
 *  (a gate) into the name the user sees. Unknown codes get the generic line. */
export function runErrorText(t: Translate, failure: CodedFailure, label: (id: string) => string = (id) => id): string {
  const params = { ...(failure.params ?? {}) }
  if (failure.code === 'not-started') {
    const start = startRefusalText(t, { code: params.reason as string, params })
    if (start) return start
  }
  if (!isIn(RUN_ERROR_CODES, failure.code)) return t('pipelineEditor.error.command-failed')
  if (typeof params.gate === 'string') params.gate = label(params.gate)
  if (typeof params.asked === 'string') params.asked = label(params.asked)
  return t(`pipelineErrors.run.${failure.code}`, params)
}

/** Graph problem code → message key. Codes not listed read as "other". */
const GRAPH_PROBLEM_KEYS: Record<string, string> = {
  'slot-incomplete': 'pipelineErrors.graph.slot-incomplete',
  'self-loop': 'pipelineErrors.graph.self-loop',
  'edge-into-trigger': 'pipelineErrors.graph.edge-into-trigger',
  'reject-from-trigger': 'pipelineErrors.graph.reject-from-trigger',
  'max-loops-range': 'pipelineErrors.graph.max-loops-range',
  'edge-must-start-at-work': 'pipelineErrors.graph.edge-must-start-at-work',
  'branch-when': 'pipelineErrors.graph.branch-when',
  'retry-config': 'pipelineErrors.graph.retry-config',
  'subpipeline-none': 'pipelineEditor.error.subpipeline-none',
  cycle: 'pipelineEditor.error.cycle',
  'reject-upstream': 'pipelineEditor.error.reject-upstream',
  'duplicate-edge': 'pipelineEditor.error.duplicate-edge',
  // Raised by the backend (stages_store), which sees every pipeline.
  'subpipeline-links': 'pipelineErrors.graph.subpipeline-links',
  'stage-not-found': 'pipelineErrors.stage-not-found',
  'no-graph': 'pipelineErrors.graph.no-graph',
}

export const GRAPH_PROBLEM_MESSAGE_KEYS: readonly string[] = [
  ...new Set(Object.values(GRAPH_PROBLEM_KEYS)),
  'pipelineErrors.graph.other',
  'pipelineErrors.graph.other-at',
]

/** One graph problem in the UI language, naming the step by its label. */
export function graphProblemText(t: Translate, problem: Pick<GraphProblem, 'code' | 'label' | 'params'>): string {
  const key = GRAPH_PROBLEM_KEYS[problem.code]
  const named = { ...(problem.params ?? {}), label: problem.label ?? '' }
  if (key) return t(key, named)
  return problem.label ? t('pipelineErrors.graph.other-at', named) : t('pipelineErrors.graph.other')
}

/** The toast button that shows the English sentence behind a translated
 *  error, for a bug report or a closer look. */
export function detailsAction(
  t: Translate,
  notify: { alert: (message: string, opts?: { title?: string }) => unknown },
  raw: string
): { label: string; run: () => void } | undefined {
  if (!raw) return undefined
  return { label: t('pipelineErrors.details'), run: () => { void notify.alert(raw, { title: t('pipelineErrors.details') }) } }
}
