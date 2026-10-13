<script setup lang="ts">
// Pipeline editor: one graph, two ways to see it (plan §6). The swimlane is the
// everyday tidy view; the canvas draws branches, joins, gates and reject
// loops. Both views report gestures; this component turns them into graph ops
// (pipelineGraphEdits) and runs them through the shared, undoable editor
// model. It also owns the node inspector, the quick-add palette and the
// Executions tab.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import { invokeCommand } from '@navide/plugin-ui/shared'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import type { useBackend } from '../../composables/useBackend'
import type { Role } from '../../composables/useRoles'
import { usePipelineGraphEditor, type EditorError, type EditResult } from '../../composables/usePipelineGraphEditor'
import {
  layerGraph,
  type GraphEdge,
  type GraphNode,
  type GraphOp,
  type GraphPosition,
  type StageMetaPatch,
} from '../../lib/pipelineGraph'
import {
  canReorderLayers,
  freshNodeId,
  laneBadges,
  layerIndex,
  opsAddToLayer,
  opsAutoLayout,
  opsInsertLayer,
  opsInsertOnEdge,
  opsMoveToLayer,
  opsPlaceNode,
  opsReorderLayers,
  uniqueLabel,
  type LaneBadge,
} from '../../lib/pipelineGraphEdits'
import { applyGraphOps, DEFAULT_MAX_LOOPS, MAX_LOOPS_CEILING } from '../../lib/pipelineGraph'
import { backendErrorText } from '../../lib/pipelineErrors'
import PipelineSwimlane, { type LaneTarget } from './PipelineSwimlane.vue'
import PipelineCanvas from './PipelineCanvas.vue'
import PipelinePalette from './PipelinePalette.vue'
import PipelineInspector from './PipelineInspector.vue'
import PipelineExecutions from './PipelineExecutions.vue'
import { LIVE_STATUSES, nodeTitle, stagesByLayer, type PaletteItem, type RunSnapshot } from './pipelineEditorModel'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  pipelineId: string
  roles: Role[]
  workspacePath: string
  run: RunSnapshot
  /** A run in this workspace is using this pipeline: edits are refused. */
  locked: boolean
}>()
const emit = defineEmits<{ (e: 'leave'): void }>()
const { t, locale } = useI18n()
const notify = useNotify()

const editor = usePipelineGraphEditor(props.backend, {
  pipelineId: () => props.pipelineId,
  workspacePath: () => props.workspacePath,
  locked: () => props.locked,
})

// ── View state ───────────────────────────────────────────────────────────────
const VIEW_KEY = 'pipeline-editor-view'
function readView(): 'swimlane' | 'canvas' {
  try { return localStorage.getItem(VIEW_KEY) === 'canvas' ? 'canvas' : 'swimlane' } catch { return 'swimlane' }
}
const view = ref<'swimlane' | 'canvas'>(readView())
const PALETTE_KEY = 'pipeline-editor-palette-collapsed'
function readCollapsed(): boolean {
  try { return localStorage.getItem(PALETTE_KEY) === '1' } catch { return false }
}
const paletteCollapsed = ref(readCollapsed())
function togglePalette(): void {
  paletteCollapsed.value = !paletteCollapsed.value
  try { localStorage.setItem(PALETTE_KEY, paletteCollapsed.value ? '1' : '0') } catch { /* private window */ }
}
const tab = ref<'editor' | 'executions'>('editor')
const selectedId = ref<string | null>(null)
const selectedLayer = ref<number | null>(null)
const root = ref<HTMLElement | null>(null)
const canvasRef = ref<InstanceType<typeof PipelineCanvas> | null>(null)

watch(() => props.pipelineId, () => {
  selectedId.value = null
  selectedLayer.value = null
  void editor.load()
}, { immediate: true })

const graph = computed(() => editor.graph.value)
const byId = computed(() => new Map((graph.value?.nodes ?? []).map((n) => [n.id, n])))
const selectedNode = computed<GraphNode | null>(() => (selectedId.value ? byId.value.get(selectedId.value) ?? null : null))
const layerStages = computed(() => {
  if (!graph.value) return []
  const { layers } = layerGraph(graph.value)
  return stagesByLayer(layers, (id) => byId.value.get(id)?.kind, editor.stages.value)
})
const selectedStage = computed(() => (selectedLayer.value === null ? null : layerStages.value[selectedLayer.value] ?? null))
const inspectorOpen = computed(() => !!selectedNode.value || !!selectedStage.value)
const badges = computed(() => (graph.value ? laneBadges(graph.value) : new Map<string, LaneBadge[]>()))
const reorderable = computed(() => (graph.value ? canReorderLayers(graph.value) : false))
const stepCount = computed(() => (graph.value?.nodes ?? []).filter((n) => n.kind !== 'trigger').length)

const roleLabels = computed(() => Object.fromEntries(props.roles.map((r) => [r.key, r.label])))
const agentOptions = CLI_AGENT_SPECS.map((s) => ({ key: s.agentKey, label: s.label }))
const agentLabels = Object.fromEntries(agentOptions.map((a) => [a.key, a.label]))

// A ticking clock only while something is running, for the elapsed timers.
const now = ref(Date.now())
let ticker: number | null = null
watch(
  () => Object.values(props.run.nodes).some((s) => LIVE_STATUSES.has(s.status)),
  (live) => {
    if (live && ticker === null) ticker = window.setInterval(() => { now.value = Date.now() }, 1000)
    if (!live && ticker !== null) { window.clearInterval(ticker); ticker = null }
  },
  { immediate: true }
)
onBeforeUnmount(() => { if (ticker !== null) window.clearInterval(ticker) })

// ── Run strip: the live run, readable from any view ──────────────────────────
const runLive = computed(() => props.run.state === 'running' && props.run.pipelineId === props.pipelineId)
const runProgress = computed(() => {
  const steps = (graph.value?.nodes ?? []).filter((n) => n.kind !== 'trigger')
  const done = steps.filter((n) => ['done', 'skipped'].includes(props.run.nodes[n.id]?.status ?? '')).length
  return { done, total: steps.length }
})
const runningNames = computed(() =>
  (graph.value?.nodes ?? [])
    .filter((n) => props.run.nodes[n.id]?.status === 'running')
    .map((n) => nodeTitle(n))
)
const waitingGate = computed(() => {
  const id = props.run.gate
  return id && runLive.value ? byId.value.get(id) ?? null : null
})
/** "A, B and C" in the UI language's own list style. */
function listNames(names: string[]): string {
  try { return new Intl.ListFormat(String(locale.value), { style: 'short', type: 'conjunction' }).format(names) } catch { return names.join(', ') }
}
function reviewGate(): void {
  if (!waitingGate.value) return
  tab.value = 'editor'
  select(waitingGate.value.id)
}

// ── Errors ───────────────────────────────────────────────────────────────────
function explain(err: EditorError): string {
  if (err.code === 'PIPELINE_RUNNING') return t('pipelineEditor.error.pipeline-running')
  if (err.code === 'GRAPH_INVALID') {
    const first = err.details?.[0] ?? err.message
    if (/cycle/.test(first)) return t('pipelineEditor.error.cycle')
    if (/upstream node/.test(first)) return t('pipelineEditor.error.reject-upstream')
    if (/duplicate edge/.test(first)) return t('pipelineEditor.error.duplicate-edge')
    return t('pipelineEditor.error.invalid', { detail: first })
  }
  if (err.code === 'TRANSPORT') return t('pipelineEditor.error.transport', { message: err.message })
  return backendErrorText(t, err, 'pipelineEditor.error.unknown')
}
async function apply(label: string, ops: GraphOp[], undoOps?: GraphOp[]): Promise<boolean> {
  const result = await editor.execute(label, ops, undoOps)
  if (!result.ok) notify.toast(explain(result.error), { type: 'error' })
  return result.ok
}
watch(() => editor.externalEdits.value, () => {
  notify.toast(t('pipelineEditor.notice.external-edit'), { type: 'info' })
})

// ── Building nodes ───────────────────────────────────────────────────────────
let lastAgent = 'claude'
function nodeFor(item: PaletteItem): GraphNode {
  const g = graph.value!
  if (item.kind === 'gate') {
    return { id: freshNodeId(g, 'gate'), kind: 'gate', label: uniqueLabel(g, t('pipelineEditor.palette.gate')), position: { x: 0, y: 0 }, gate: {} }
  }
  const label = uniqueLabel(g, item.label)
  return {
    id: freshNodeId(g),
    kind: 'slot',
    label,
    position: { x: 0, y: 0 },
    slot: { agentKey: lastAgent as never, roleKey: item.roleKey, label, kickoffBody: '', isCommander: false },
  }
}

/** Ops that add `node`, followed by its canvas placement — placement is part
 *  of the same command, so one undo takes both back. */
function withPlacement(ops: GraphOp[], nodeId: string): GraphOp[] {
  try {
    const after = applyGraphOps(graph.value!, ops)
    return [...ops, ...opsPlaceNode(after, nodeId)]
  } catch {
    return ops
  }
}

async function addAt(item: PaletteItem, target: LaneTarget): Promise<void> {
  if (!graph.value) return
  const node = nodeFor(item)
  const ops = target.mode === 'into'
    ? opsAddToLayer(graph.value, target.layer, node)
    : opsInsertLayer(graph.value, target.layer, node)
  if (await apply(t('pipelineEditor.history.add', { name: nodeTitle(node) }), withPlacement(ops, node.id))) select(node.id)
}

/** Docked-palette pick: after the selected node as a new layer, else at the end. */
async function addFromPalette(item: PaletteItem): Promise<void> {
  if (!graph.value) return
  const layers = layerGraph(graph.value).layers
  const sel = selectedId.value ? layerIndex(graph.value).get(selectedId.value) : undefined
  const at = sel !== undefined ? sel + 1 : layers.length
  await addAt(item, { mode: 'newLayer', layer: Math.max(0, at) })
}

async function dropOnCanvas(item: PaletteItem, position: GraphPosition): Promise<void> {
  if (!graph.value) return
  const node = { ...nodeFor(item), position }
  // Dropped on empty canvas: wire it after the selected node if there is one,
  // so the common "add the next step" gesture needs no extra drag.
  const from = selectedNode.value && selectedNode.value.kind !== 'gate' ? selectedNode.value.id : null
  const ops: GraphOp[] = [{ op: 'add_node', node, after: from ? [from] : [] }]
  if (await apply(t('pipelineEditor.history.add', { name: nodeTitle(node) }), ops)) select(node.id)
}

// ── Quick-add popover ────────────────────────────────────────────────────────
type QuickTarget = { kind: 'lane'; target: LaneTarget } | { kind: 'edge'; edge: GraphEdge }
const quick = ref<{ at: QuickTarget; x: number; y: number } | null>(null)
function openQuick(at: QuickTarget, anchor: HTMLElement): void {
  if (props.locked) return
  const r = anchor.getBoundingClientRect()
  const host = root.value?.getBoundingClientRect()
  const x = Math.min(r.left - (host?.left ?? 0), (host?.width ?? 1200) - 300)
  const y = Math.min(r.bottom - (host?.top ?? 0) + 6, (host?.height ?? 800) - 380)
  quick.value = { at, x: Math.max(8, x), y: Math.max(8, y) }
}
async function quickPick(item: PaletteItem): Promise<void> {
  const q = quick.value
  quick.value = null
  if (!q || !graph.value) return
  if (q.at.kind === 'lane') { await addAt(item, q.at.target); return }
  const node = nodeFor(item)
  if (await apply(t('pipelineEditor.history.add', { name: nodeTitle(node) }), withPlacement(opsInsertOnEdge(q.at.edge, node), node.id))) select(node.id)
}

// ── Other gestures ───────────────────────────────────────────────────────────
function select(id: string | null): void {
  selectedId.value = id
  if (id) selectedLayer.value = null
}
function editLayer(index: number): void {
  selectedId.value = null
  selectedLayer.value = index
}

async function moveNode(id: string, target: LaneTarget): Promise<void> {
  if (!graph.value || byId.value.get(id)?.kind === 'trigger') return
  const ops = opsMoveToLayer(graph.value, id, target.layer, target.mode)
  await apply(t('pipelineEditor.history.move', { name: nodeTitle(byId.value.get(id)!) }), withPlacement(ops, id))
}
async function reorder(from: number, to: number): Promise<void> {
  if (!graph.value) return
  const ops = opsReorderLayers(graph.value, from, to)
  if (!ops) { refuseReorder(); return }
  await apply(t('pipelineEditor.history.reorder'), ops)
}
function refuseReorder(): void {
  notify.toast(t('pipelineEditor.notice.reorder-on-canvas'), { type: 'info' })
}
async function removeNode(id: string): Promise<void> {
  const n = byId.value.get(id)
  if (!n || n.kind === 'trigger') return
  if (await apply(t('pipelineEditor.history.remove', { name: nodeTitle(n) }), [{ op: 'remove_node', id, reconnect: true }])) {
    if (selectedId.value === id) selectedId.value = null
  }
}
async function removeEdge(id: string): Promise<void> {
  await apply(t('pipelineEditor.history.unlink'), [{ op: 'remove_edge', id }])
}
const selectedEdgeId = ref<string | null>(null)
const selectedRejectEdge = computed(() => {
  const e = graph.value?.edges.find((x) => x.id === selectedEdgeId.value)
  return e && e.kind === 'reject' ? e : null
})
const loopsOf = (e: GraphEdge): number => e.maxLoops ?? DEFAULT_MAX_LOOPS
const edgeEndName = (id: string): string => { const n = byId.value.get(id); return n ? nodeTitle(n) : id }
/** The contract has no edge update, so a new budget is the same link removed
 *  and re-added — one command, one undo. */
async function setLoops(e: GraphEdge, n: number): Promise<void> {
  const next = Math.min(MAX_LOOPS_CEILING, Math.max(1, n))
  if (next === loopsOf(e)) return
  await apply(t('pipelineEditor.history.loop-budget'), [
    { op: 'remove_edge', id: e.id },
    { op: 'add_edge', edge: { ...e, maxLoops: next } },
  ])
}

async function connect(edge: GraphEdge): Promise<void> {
  if (graph.value?.edges.some((e) => e.id === edge.id)) return
  await apply(t(edge.kind === 'reject' ? 'pipelineEditor.history.loop' : 'pipelineEditor.history.link'), [{ op: 'add_edge', edge }])
}
async function moveOnCanvas(moves: Array<{ id: string; position: GraphPosition }>): Promise<void> {
  await apply(t('pipelineEditor.history.position'), moves.map((m) => ({ op: 'move_node', id: m.id, position: m.position })))
}
async function tidy(): Promise<void> {
  if (!graph.value) return
  const ops = opsAutoLayout(graph.value)
  if (ops.length) await apply(t('pipelineEditor.history.tidy'), ops)
  canvasRef.value?.zoomToFit()
}
async function editFromInspector(label: string, ops: GraphOp[]): Promise<void> {
  const slotAgent = ops.find((o) => o.op === 'update_node' && o.slot?.agentKey)
  if (slotAgent && slotAgent.op === 'update_node') lastAgent = String(slotAgent.slot!.agentKey)
  await apply(label, ops)
}
async function editStageMeta(stageId: string, patch: StageMetaPatch, previous: StageMetaPatch): Promise<void> {
  await apply(
    t('pipelineEditor.history.edit-layer'),
    [{ op: 'set_stage_meta', stageId, ...patch }],
    [{ op: 'set_stage_meta', stageId, ...previous }]
  )
}

/** Swimlane badge → canvas, framed on the link the badge stands for. */
async function openOnCanvas(b: LaneBadge): Promise<void> {
  await switchView('canvas')
  await canvasRef.value?.focusEdge(b.edgeId)
}

// ── Run control (engine lives in the host; reached as UI commands) ───────────
async function command(id: string, args?: unknown): Promise<void> {
  const result = await invokeCommand(id, args)
  if (!result.ok) notify.toast(result.error ?? t('pipelineEditor.error.command-failed'), { type: 'error' })
}
const control = (action: 'next' | 'abort' | 'resume' | 'restart'): Promise<void> => command(`ui.pipeline.${action}`)
const decideGate = (nodeId: string, decision: 'approve' | 'reject', comment: string): Promise<void> =>
  command(decision === 'approve' ? 'ui.pipeline.gate_pass' : 'ui.pipeline.gate_reject', decision === 'reject' ? { nodeId, comment } : { nodeId })
const restartFrom = (nodeId: string): Promise<void> => command('ui.pipeline.restart_from', { nodeId })
async function openPane(paneId: string): Promise<void> {
  await command('ui.pane.focus', { paneId })
  emit('leave')
}

// ── View switch with a shared-card morph ─────────────────────────────────────
// Cards carry data-node-id in both views. Measure them, switch, measure again,
// and play each card from its old box to its new one (FLIP), so a node is
// never lost in the switch — the one orchestrated motion in this editor.
const entering = ref(false)
const MORPH_MS = 620
let canvasReady: (() => void) | null = null
function onCanvasReady(): void { canvasReady?.(); canvasReady = null }
let unmounted = false
onBeforeUnmount(() => { unmounted = true })

function rects(): Map<string, DOMRect> {
  const out = new Map<string, DOMRect>()
  root.value?.querySelectorAll<HTMLElement>('.pe-view [data-node-id]').forEach((el) => {
    out.set(el.dataset.nodeId!, el.getBoundingClientRect())
  })
  return out
}
async function switchView(next: 'swimlane' | 'canvas'): Promise<void> {
  if (view.value === next) return
  selectedEdgeId.value = null
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const before = reduce ? new Map<string, DOMRect>() : rects()
  const ready = next === 'canvas'
    ? new Promise<void>((resolve) => { canvasReady = resolve; window.setTimeout(resolve, 600) })
    : Promise.resolve()
  view.value = next
  try { localStorage.setItem(VIEW_KEY, next) } catch { /* private window */ }
  if (reduce) return
  entering.value = true
  await nextTick()
  await ready
  // The canvas may take its 600ms fallback; the editor can be gone by then.
  if (unmounted) return
  await new Promise((r) => requestAnimationFrame(() => r(null)))
  const els = Array.from(root.value?.querySelectorAll<HTMLElement>('.pe-view [data-node-id]') ?? [])
    .filter((el) => before.has(el.dataset.nodeId!))
  // Left-to-right stagger, so the flow reads in run order as it reassembles.
  els.sort((a, b) => before.get(a.dataset.nodeId!)!.left - before.get(b.dataset.nodeId!)!.left)
  els.forEach((el, i) => {
    const from = before.get(el.dataset.nodeId!)!
    const to = el.getBoundingClientRect()
    if (!to.width) return
    const dx = from.left - to.left
    const dy = from.top - to.top
    const s = from.width / to.width
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${s})`, transformOrigin: 'top left' },
        { transform: 'none', transformOrigin: 'top left' },
      ],
      { duration: MORPH_MS, delay: Math.min(i * 22, 180), easing: 'cubic-bezier(0.45, 0, 0.15, 1)', fill: 'backwards' }
    )
  })
  window.setTimeout(() => { entering.value = false }, MORPH_MS + 180)
}

// ── Keyboard ─────────────────────────────────────────────────────────────────
function onKey(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    void (e.shiftKey ? editor.redo() : editor.undo()).then(reportStep)
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    void editor.redo().then(reportStep)
  }
}
async function undo(): Promise<void> {
  reportStep(await editor.undo())
}
async function redo(): Promise<void> {
  reportStep(await editor.redo())
}
/** An undo/redo pressed while an edit is still saving did nothing — not a failure to report. */
function reportStep(r: EditResult): void {
  if (!r.ok && r.error.code !== 'WRITE_PENDING') notify.toast(explain(r.error), { type: 'error' })
}

/** Esc, innermost first: the quick-add popover, then the inspector. */
function closeTopLayer(): boolean {
  if (quick.value) { quick.value = null; return true }
  if (inspectorOpen.value) { selectedId.value = null; selectedLayer.value = null; return true }
  return false
}
/** Select the step a stage slot became — the Roles tab's "go to usage". */
let pendingFocus: [string, string] | null = null
watch(graph, (g) => {
  if (g && pendingFocus) { const [id, label] = pendingFocus; pendingFocus = null; focusSlot(id, label) }
})
function focusSlot(stageId: string, slotLabel: string): void {
  if (!graph.value || editor.loading.value) { pendingFocus = [stageId, slotLabel]; return }
  const nodes = graph.value.nodes
  const hit = nodes.find((n) => n.stageId === stageId && n.slot?.label === slotLabel)
    ?? nodes.find((n) => n.stageId === stageId)
  tab.value = 'editor'
  if (hit) select(hit.id)
}
defineExpose({ closeTopLayer, focusSlot, reload: () => editor.load() })

function onDocPointer(e: PointerEvent): void {
  if (!quick.value) return
  const pop = root.value?.querySelector('.pe-quick')
  if (pop && !pop.contains(e.target as Node)) quick.value = null
}
onMounted(() => document.addEventListener('pointerdown', onDocPointer, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointer, true))

// The canvas loses (or regains) the inspector's width when it opens or closes;
// refit once the slide has finished so the graph is not left cut off.
watch(inspectorOpen, () => {
  if (view.value !== 'canvas') return
  window.setTimeout(() => canvasRef.value?.zoomToFit(), 260)
})

const modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'
</script>

<template>
  <div ref="root" class="pe" :class="{ 'is-run-stopped': run.state !== 'running' }" @keydown="onKey">
    <!-- Toolbar: view, tab, history, layout -->
    <div class="pe-bar">
      <!-- The host's own controls (back, pipeline name) lead the one bar, so
           the workspace has a single row of chrome instead of three. -->
      <div v-if="$slots.lead" class="pe-lead"><slot name="lead" /></div>
      <button
        v-if="tab === 'editor'" type="button" class="pe-icon" :aria-pressed="!paletteCollapsed"
        :aria-label="t(paletteCollapsed ? 'pipelineEditor.toolbar.show-palette' : 'pipelineEditor.toolbar.hide-palette')"
        :title="t(paletteCollapsed ? 'pipelineEditor.toolbar.show-palette' : 'pipelineEditor.toolbar.hide-palette')"
        @click="togglePalette"
      ><svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6 2.5v11" /></svg></button>
      <div class="pe-seg" role="tablist" :aria-label="t('pipelineEditor.toolbar.view')">
        <button
          type="button" role="tab" class="pe-seg-btn" :class="{ 'is-on': view === 'swimlane' && tab === 'editor' }"
          :aria-selected="view === 'swimlane' && tab === 'editor'"
          @click="tab = 'editor'; switchView('swimlane')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="3.6" height="11" rx="1" /><rect x="6.2" y="2.5" width="3.6" height="11" rx="1" /><rect x="10.9" y="2.5" width="3.6" height="11" rx="1" /></svg>
          {{ t('pipelineEditor.toolbar.swimlane') }}
        </button>
        <button
          type="button" role="tab" class="pe-seg-btn" :class="{ 'is-on': view === 'canvas' && tab === 'editor' }"
          :aria-selected="view === 'canvas' && tab === 'editor'"
          @click="tab = 'editor'; switchView('canvas')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="2" /><circle cx="12.5" cy="3.8" r="2" /><circle cx="12.5" cy="12.2" r="2" /><path d="M5.4 7.2 10.6 4.6M5.4 8.8l5.2 2.6" /></svg>
          {{ t('pipelineEditor.toolbar.canvas') }}
        </button>
        <button
          type="button" role="tab" class="pe-seg-btn" :class="{ 'is-on': tab === 'executions' }"
          :aria-selected="tab === 'executions'" @click="tab = 'executions'"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 4.8V8l2.2 1.6" /></svg>
          {{ t('pipelineEditor.toolbar.executions') }}
          <span v-if="run.state === 'running' && run.pipelineId === pipelineId" class="pe-live" aria-hidden="true"></span>
        </button>
      </div>

      <span v-if="locked" class="pe-lock" role="status">
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
        {{ t('pipelineEditor.toolbar.locked') }}
      </span>
      <span v-else-if="graph" class="pe-save" role="status" aria-live="polite">
        {{ editor.pending.value ? t('pipelineEditor.toolbar.saving') : (editor.derived.value ? t('pipelineEditor.toolbar.derived') : t('pipelineEditor.toolbar.saved')) }}
      </span>

      <span class="pe-spacer"></span>

      <template v-if="tab === 'editor'">
        <button
          type="button" class="pe-icon" :disabled="!editor.canUndo.value || locked"
          :aria-label="t('pipelineEditor.toolbar.undo', { what: editor.undoLabel.value })"
          :title="editor.undoLabel.value ? `${t('pipelineEditor.toolbar.undo', { what: editor.undoLabel.value })} (${modKey}Z)` : `${t('pipelineEditor.toolbar.undo-none')}`"
          @click="undo"
        ><svg viewBox="0 0 16 16"><path d="M4.5 6.5h5.5a3 3 0 0 1 0 6H7M4.5 6.5 7 4M4.5 6.5 7 9" /></svg></button>
        <button
          type="button" class="pe-icon" :disabled="!editor.canRedo.value || locked"
          :aria-label="t('pipelineEditor.toolbar.redo', { what: editor.redoLabel.value })"
          :title="editor.redoLabel.value ? `${t('pipelineEditor.toolbar.redo', { what: editor.redoLabel.value })} (${modKey}⇧Z)` : `${t('pipelineEditor.toolbar.redo-none')}`"
          @click="redo"
        ><svg viewBox="0 0 16 16"><path d="M11.5 6.5H6a3 3 0 0 0 0 6h3M11.5 6.5 9 4M11.5 6.5 9 9" /></svg></button>
        <template v-if="view === 'canvas'">
          <span class="pe-divider" aria-hidden="true"></span>
          <button type="button" class="pe-text-btn" :disabled="locked" @click="tidy">{{ t('pipelineEditor.toolbar.tidy') }}</button>
          <button type="button" class="pe-icon" :aria-label="t('pipelineEditor.toolbar.fit')" :title="t('pipelineEditor.toolbar.fit')" @click="canvasRef?.fitAll()">
            <svg viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>
          </button>
        </template>
      </template>
      <template v-if="$slots.trail">
        <span class="pe-divider" aria-hidden="true"></span>
        <div class="pe-trail"><slot name="trail" /></div>
      </template>
    </div>

    <!-- The live run, in one line, whichever view is open: progress, what is
         running now, and — when a gate is waiting — the way to it. -->
    <div
      v-if="runLive && tab === 'editor' && graph" class="pe-run" :class="{ 'is-gate': waitingGate }"
      role="status" aria-live="polite"
    >
      <span class="pe-run-meter" aria-hidden="true">
        <span :style="{ width: runProgress.total ? `${(runProgress.done / runProgress.total) * 100}%` : '0%' }"></span>
      </span>
      <span class="pe-run-count">{{ t('pipelineEditor.exec.progress', runProgress) }}</span>
      <template v-if="waitingGate">
        <span class="pe-run-sep" aria-hidden="true"></span>
        <span class="pe-run-text" v-truncate>{{ t('pipelineEditor.run.gate', { name: nodeTitle(waitingGate) }) }}</span>
        <button type="button" class="pe-run-act" @click="reviewGate">{{ t('pipelineEditor.run.review') }}</button>
      </template>
      <template v-else-if="runningNames.length">
        <span class="pe-run-sep" aria-hidden="true"></span>
        <span class="pe-run-dot" aria-hidden="true"></span>
        <span class="pe-run-text" v-truncate>{{ t('pipelineEditor.run.running', { names: listNames(runningNames) }) }}</span>
      </template>
    </div>

    <!-- Body -->
    <div v-if="editor.loadError.value" class="pe-state">
      <p class="pe-state-title">{{ t('pipelineEditor.state.load-failed') }}</p>
      <p>{{ explain(editor.loadError.value) }}</p>
      <button type="button" class="pe-text-btn" @click="editor.load()">{{ t('action.retry') }}</button>
    </div>
    <div v-else-if="!graph" class="pe-state nv-loading nv-loading--inline">{{ t('label.loading-stages') }}</div>

    <div v-else-if="tab === 'editor'" class="pe-main" :class="{ 'has-inspector': inspectorOpen, 'no-palette': paletteCollapsed }">
      <aside v-if="!paletteCollapsed" class="pe-palette" :aria-label="t('pipelineEditor.palette.title')">
        <PipelinePalette :roles="roles" :locked="locked" @pick="addFromPalette" />
      </aside>

      <div class="pe-view" :class="[`pe-view--${view}`, { 'is-entering': entering }]">
        <PipelineSwimlane
          v-if="view === 'swimlane'"
          :graph="graph" :stages="editor.stages.value" :role-labels="roleLabels" :agent-labels="agentLabels"
          :run-nodes="run.nodes" :badges="badges" :now="now" :selected-id="selectedId" :locked="locked"
          :can-reorder="reorderable"
          @select="select" @drop-item="addAt" @move-node="moveNode" @reorder="reorder" @remove="removeNode"
          @badge="openOnCanvas" @request-add="(target, anchor) => openQuick({ kind: 'lane', target }, anchor)"
          @edit-layer="editLayer" @reorder-refused="refuseReorder"
        />
        <PipelineCanvas
          v-else ref="canvasRef"
          :graph="graph" :role-labels="roleLabels" :agent-labels="agentLabels"
          :run-nodes="run.nodes" :now="now" :selected-id="selectedId" :locked="locked"
          @select="select" @move="moveOnCanvas" @connect="connect" @remove-node="removeNode" @remove-edge="removeEdge"
          @insert-on-edge="(edge, anchor) => openQuick({ kind: 'edge', edge }, anchor)"
          @drop-item="dropOnCanvas" @ready="onCanvasReady"
          @select-edge="(id) => { selectedEdgeId = id }"
        />
        <!-- A selected reject loop: its retry budget is the one property a
             link has, so it is edited right where the link is. -->
        <div v-if="view === 'canvas' && selectedRejectEdge" class="pe-edge-panel" role="group" :aria-label="t('pipelineEditor.edge.title')">
          <span class="pe-edge-title">{{ t('pipelineEditor.edge.title') }}</span>
          <span class="pe-edge-desc" v-truncate>{{ t('pipelineEditor.edge.desc', { from: edgeEndName(selectedRejectEdge.from), to: edgeEndName(selectedRejectEdge.to) }) }}</span>
          <span class="pe-stepper">
            <button type="button" :disabled="locked || loopsOf(selectedRejectEdge) <= 1" :aria-label="t('pipelineEditor.edge.fewer')" @click="setLoops(selectedRejectEdge, loopsOf(selectedRejectEdge) - 1)">−</button>
            <span class="pe-stepper-value" aria-live="polite">{{ t('pipelineEditor.edge.max', { n: loopsOf(selectedRejectEdge) }) }}</span>
            <button type="button" :disabled="locked || loopsOf(selectedRejectEdge) >= MAX_LOOPS_CEILING" :aria-label="t('pipelineEditor.edge.more')" @click="setLoops(selectedRejectEdge, loopsOf(selectedRejectEdge) + 1)">+</button>
          </span>
          <button type="button" class="pe-text-btn" :disabled="locked" @click="removeEdge(selectedRejectEdge.id)">{{ t('pipelineEditor.edge.remove') }}</button>
        </div>
        <div v-if="stepCount === 0 && !locked && view === 'canvas'" class="pe-empty" aria-live="polite">
          <p class="pe-empty-title">{{ t('pipelineEditor.state.empty-title') }}</p>
          <p>{{ t('pipelineEditor.state.empty-body') }}</p>
        </div>
      </div>

      <Transition name="pe-slide">
        <PipelineInspector
          v-if="inspectorOpen"
          class="pe-inspector"
          :backend="backend" :graph="graph" :node="selectedNode" :stage="selectedStage"
          :roles="roles" :agent-options="agentOptions" :run="run" :now="now" :locked="locked"
          :workspace-path="workspacePath"
          @edit="editFromInspector" @stage-meta="editStageMeta" @remove="removeNode"
          @close="select(null); selectedLayer = null"
          @open-pane="openPane" @restart-from="restartFrom" @gate="decideGate"
        />
      </Transition>
    </div>

    <PipelineExecutions
      v-else
      class="pe-exec"
      :backend="backend" :workspace-path="workspacePath" :pipeline-id="pipelineId"
      :graph="graph" :run="run" :role-labels="roleLabels" :agent-labels="agentLabels" :now="now"
      @control="control" @gate="decideGate" @select-node="(id) => { tab = 'editor'; select(id) }"
    />

    <div
      v-if="quick" class="pe-quick" role="dialog" :aria-label="t('pipelineEditor.palette.quick-add')"
      :style="{ left: `${quick.x}px`, top: `${quick.y}px` }"
    >
      <PipelinePalette :roles="roles" compact @pick="quickPick" />
    </div>
  </div>
</template>

<style scoped>
.pe {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-base);
}
.pe-bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 44px;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-elevated);
}
.pe-run {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 34px;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--border-muted);
  background: color-mix(in srgb, var(--accent-emphasis) 6%, var(--bg-elevated));
  font-size: var(--font-xs);
  color: var(--text-secondary);
  animation: pe-pop 200ms var(--ease-out) both;
}
.pe-run.is-gate {
  background: var(--attention-subtle);
  border-bottom-color: color-mix(in srgb, var(--attention-emphasis) 40%, transparent);
  color: var(--attention-fg);
}
.pe-run-meter { position: relative; width: 96px; height: 4px; border-radius: var(--radius-pill); background: var(--bg-muted); overflow: hidden; }
.pe-run-meter span { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: var(--success-emphasis); transition: width var(--motion-slow) var(--ease-out); }
.pe-run-count { font-variant-numeric: tabular-nums; color: var(--text-primary); }
.pe-run-sep { width: 1px; height: 14px; background: var(--border-default); }
.pe-run-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-emphasis); animation: pe-breathe 1.6s var(--ease-in-out) infinite; }
.pe-run-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pe-run-act {
  margin-left: auto;
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid color-mix(in srgb, var(--attention-emphasis) 60%, transparent);
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  color: var(--attention-fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.pe-run-act:hover { background: color-mix(in srgb, var(--attention-emphasis) 12%, var(--bg-elevated)); }
.pe-run-act:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
@keyframes pe-breathe { 50% { opacity: 0.35; } }
.pe-lead {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  max-width: 34%;
  padding-right: var(--space-3);
  margin-right: var(--space-1);
  border-right: 1px solid var(--border-default);
}
.pe-trail { display: flex; align-items: center; gap: var(--space-1); }
.pe-seg {
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  border-radius: var(--radius-control);
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
}
.pe-seg-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 26px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-xs);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.pe-seg-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; }
.pe-seg-btn:hover { color: var(--text-primary); }
.pe-seg-btn.is-on { background: var(--bg-elevated); color: var(--text-primary); box-shadow: var(--shadow-popover); }
.pe-seg-btn:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.pe-live { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-emphasis); }

.pe-lock {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 24px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-pill);
  background: var(--attention-subtle);
  color: var(--attention-fg);
  font-size: var(--font-xs);
}
.pe-lock svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.4; }
.pe-save { font-size: var(--font-xs); color: var(--text-muted); }
.pe-spacer { flex: 1; }
.pe-divider { width: 1px; height: 18px; background: var(--border-default); }
.pe-icon {
  display: grid;
  place-items: center;
  width: var(--icon-btn-md);
  height: var(--icon-btn-md);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.pe-icon svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.pe-icon:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.pe-icon:disabled { opacity: 0.35; cursor: default; }
.pe-icon:focus-visible, .pe-text-btn:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.pe-text-btn {
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-xs);
  cursor: pointer;
}
.pe-text-btn:hover:not(:disabled) { background: var(--bg-hover); }
.pe-text-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.pe-main {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
}
.pe-main.has-inspector { grid-template-columns: 248px minmax(0, 1fr) auto; }
.pe-main.no-palette { grid-template-columns: minmax(0, 1fr); }
.pe-main.no-palette.has-inspector { grid-template-columns: minmax(0, 1fr) auto; }
.pe-palette {
  min-height: 0;
  border-right: 1px solid var(--border-default);
  background: var(--bg-subtle);
}
.pe-view { position: relative; min-width: 0; min-height: 0; }
.pe-exec { flex: 1; min-height: 0; }

/* The incoming view's chrome (links, lanes) waits for the cards: it fades in
   as they land, so no link is ever drawn to where a card is not yet. */
.pe-view.is-entering :deep(.lane),
.pe-view.is-entering :deep(.lane-gutter),
.pe-view.is-entering :deep(.lane-append),
.pe-view.is-entering :deep(.vue-flow__edges),
.pe-view.is-entering :deep(.vue-flow__edge-labels),
.pe-view.is-entering :deep(.pcv-minimap) { animation: pe-fade 320ms var(--ease-out) 420ms both; }
.pe-view.is-entering :deep(.lane-card),
.pe-view.is-entering :deep(.lane-trigger) { animation: none; }

.pe-empty {
  position: absolute;
  left: 50%;
  bottom: var(--space-8);
  transform: translateX(-50%);
  max-width: 420px;
  padding: var(--space-4) var(--space-5);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-floating);
  text-align: center;
  pointer-events: none;
}
.pe-empty p { margin: 0; font-size: var(--font-xs); line-height: var(--lh-base); color: var(--text-muted); }
.pe-empty .pe-empty-title { margin-bottom: var(--space-1); font-size: var(--font-sm); font-weight: 600; color: var(--text-primary); }

.pe-edge-panel {
  position: absolute;
  top: var(--space-4);
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-popover);
  border: 1px solid color-mix(in srgb, var(--done-emphasis) 45%, var(--border-default));
  background: var(--bg-overlay);
  box-shadow: var(--shadow-popover);
  font-size: var(--font-xs);
  animation: pe-pop 160ms var(--ease-out) both;
}
.pe-edge-title { font-weight: 600; color: var(--done-fg); white-space: nowrap; }
.pe-edge-desc { color: var(--text-secondary); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pe-stepper { display: inline-flex; align-items: center; border: 1px solid var(--border-default); border-radius: var(--radius-control); overflow: hidden; }
.pe-stepper button {
  width: 24px;
  height: 24px;
  border: none;
  background: var(--bg-elevated);
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
}
.pe-stepper button:hover:not(:disabled) { background: var(--bg-hover); }
.pe-stepper button:disabled { opacity: 0.4; cursor: default; }
.pe-stepper button:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: -2px; }
.pe-stepper-value { min-width: 72px; padding: 0 var(--space-2); text-align: center; font-variant-numeric: tabular-nums; color: var(--text-primary); }
/* A stopped run still shows where it stopped, but nothing on it is live:
   no pulsing dots, no flowing links. */
.pe.is-run-stopped :deep(.pnc-dot),
.pe.is-run-stopped :deep(.pcv-edge.is-live) { animation: none; }
.pe-state {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: var(--space-2);
  flex: 1;
  color: var(--text-muted);
  font-size: var(--font-sm);
}
.pe-state p { margin: 0; }
.pe-state .pe-state-title { font-weight: 600; color: var(--text-primary); }

.pe-quick {
  position: absolute;
  z-index: var(--z-popover);
  width: 288px;
  max-height: 380px;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-popover);
  border: 1px solid var(--border-default);
  background: var(--bg-overlay);
  box-shadow: var(--shadow-overlay);
  overflow: hidden;
  animation: pe-pop 160ms var(--ease-out) both;
}

.pe-slide-enter-active, .pe-slide-leave-active { transition: transform var(--motion-base) var(--ease-out), opacity var(--motion-base) var(--ease-out); }
.pe-slide-enter-from, .pe-slide-leave-to { transform: translateX(24px); opacity: 0; }

@keyframes pe-fade { from { opacity: 0; } }
@keyframes pe-pop { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
@media (prefers-reduced-motion: reduce) {
  .pe-quick, .pe-run, .pe-run-dot, .pe-view.is-entering :deep(*) { animation: none !important; }
  .pe-slide-enter-active, .pe-slide-leave-active, .pe-seg-btn { transition: none; }
}
</style>
