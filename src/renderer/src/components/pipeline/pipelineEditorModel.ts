// View-model helpers shared by the pipeline editor components: what a palette
// item is, how a node's run state reads, and the drag-and-drop payloads both
// views understand. No component state lives here.
import type { GraphNode, NodeRunState, NodeRunStatus } from '../../lib/pipelineGraph'
import type { AgentKey, Stage } from '../../data/stages'

/** Something the palette can place: a Role becomes a slot node; a gate is the
 *  one flow-control node v1 offers (branch/join are drawn with edges). */
export type PaletteItem =
  | { kind: 'role'; roleKey: string; label: string; description: string }
  | { kind: 'gate'; label: string; description: string }

/** MIME types for the editor's HTML5 drag-and-drop, so a drop target can tell
 *  a palette item from a card being moved — and ignore anything else. */
export const DND_PALETTE = 'application/x-navide-pipeline-palette'
export const DND_NODE = 'application/x-navide-pipeline-node'

export interface RunSnapshot {
  /** Pipeline the workspace's run uses; '' when no run. */
  pipelineId: string
  /** Workspace run state ('running', 'paused', 'idle', …). */
  state: string
  nodes: Record<string, NodeRunState>
  /** Node id of the gate awaiting a decision, if any. */
  gate: string | null
}

export const EMPTY_RUN: RunSnapshot = { pipelineId: '', state: 'idle', nodes: {}, gate: null }

/** Statuses that mean the node is doing (or waiting on) something now. */
export const LIVE_STATUSES: ReadonlySet<NodeRunStatus> = new Set(['running', 'awaiting'])

/** "4m12s" / "38s" / "1h02m" — compact, no zero-padded hours. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** "38k" / "1.2M" / "940" tokens. */
export function formatTokens(n: number | undefined): string {
  if (!n || n < 0) return ''
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function elapsedOf(state: NodeRunState | undefined, now: number): number {
  if (!state?.startedAt) return Number.NaN
  const start = Date.parse(state.startedAt)
  const end = state.endedAt ? Date.parse(state.endedAt) : now
  return end - start
}

/** One- or two-letter vendor monogram for the node's CLI tile. */
export function agentMonogram(agentKey: AgentKey | string | undefined): string {
  const k = String(agentKey ?? '')
  if (!k) return '?'
  return k.charAt(0).toUpperCase()
}

export function nodeTitle(node: GraphNode): string {
  return node.slot?.label || node.label || node.id
}

/** The derived stage behind each layer (undefined for gate-only layers, which
 *  produce no stage). deriveStagesFromGraph emits one stage per layer that
 *  holds a slot, in layer order, so the two line up by counting. */
export function stagesByLayer(layers: string[][], nodeKind: (id: string) => string | undefined, stages: Stage[]): Array<Stage | undefined> {
  let next = 0
  return layers.map((ids) => (ids.some((id) => nodeKind(id) === 'slot') ? stages[next++] : undefined))
}
