<script lang="ts">
import type { NodeRunState as RunState, PipelineGraph as Graph } from '../../lib/pipelineGraph'

/** Below this the card text stops being readable at the default font size. */
export const READABLE_ZOOM = 0.72

/** When fitting the whole graph would shrink it past readable, frame the node
 *  that matters instead: the selected one, else what the run is doing, else
 *  the start. null = the fit is readable as it is. */
export function framingTarget(
  fitZoom: number,
  graph: Graph,
  selectedId: string | null,
  runNodes: Record<string, RunState>
): { id: string; zoom: number } | null {
  if (fitZoom >= READABLE_ZOOM) return null
  const live = graph.nodes.find((n) => runNodes[n.id]?.status === 'awaiting')
    ?? graph.nodes.find((n) => runNodes[n.id]?.status === 'running')
  const id = (selectedId && graph.nodes.some((n) => n.id === selectedId) ? selectedId : null)
    ?? live?.id
    ?? graph.nodes.find((n) => n.kind === 'trigger')?.id
    ?? graph.nodes[0]?.id
  return id ? { id, zoom: READABLE_ZOOM } : null
}

/** Minimap node class for a run status: the overview doubles as a progress
 *  map while a run is live. */
export function minimapClass(status: string | undefined): string {
  return status ? `pcv-mm pcv-mm--${status}` : 'pcv-mm'
}
</script>

<script setup lang="ts">
// Free canvas view (Vue Flow): the same graph as the swimlane, with what
// columns cannot draw — branches, joins, approval gates and bounded reject
// loops. Positions are the graph's own; dragging a node, drawing a link or
// inserting on a link is reported as an intent and becomes an undoable graph
// command in the editor.
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  VueFlow,
  getBezierPath,
  useVueFlow,
  type Connection,
  type Edge as FlowEdge,
  type EdgeProps,
  type Node as FlowNode,
  type NodeDragEvent,
} from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import type { GraphEdge, GraphNode, GraphPosition, NodeRunState, PipelineGraph } from '../../lib/pipelineGraph'
import { NODE_SIZE } from '../../lib/pipelineGraphEdits'
import PipelineNodeCard from './PipelineNodeCard.vue'
import { DND_PALETTE, type PaletteItem } from './pipelineEditorModel'

const props = defineProps<{
  graph: PipelineGraph
  roleLabels: Record<string, string>
  agentLabels: Record<string, string>
  runNodes: Record<string, NodeRunState>
  now: number
  selectedId: string | null
  locked: boolean
  /** Instance id, so a second canvas (executions replay) keeps its own viewport. */
  flowId?: string
}>()
const emit = defineEmits<{
  (e: 'select', id: string | null): void
  (e: 'move', moves: Array<{ id: string; position: GraphPosition }>): void
  (e: 'connect', edge: GraphEdge): void
  (e: 'remove-node', id: string): void
  (e: 'remove-edge', id: string): void
  (e: 'insert-on-edge', edge: GraphEdge, anchor: HTMLElement): void
  (e: 'drop-item', item: PaletteItem, position: GraphPosition): void
  (e: 'ready'): void
  (e: 'select-edge', id: string | null): void
}>()
const { t } = useI18n()

const flowId = props.flowId ?? 'pipeline-canvas'
const { fitView, screenToFlowCoordinate, onInit, zoomIn, zoomOut, viewport, setCenter } = useVueFlow(flowId)
const zoomPercent = computed(() => `${Math.round((viewport.value?.zoom ?? 1) * 100)}%`)

const selectedEdge = ref<string | null>(null)
watch(selectedEdge, (id) => emit('select-edge', id))
const hoverEdge = ref<string | null>(null)

const byId = computed(() => new Map(props.graph.nodes.map((n) => [n.id, n])))

const flowNodes = computed<FlowNode[]>(() =>
  props.graph.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: { x: n.position.x, y: n.position.y },
    data: { node: n },
    draggable: !props.locked,
    connectable: !props.locked,
    selected: props.selectedId === n.id,
    width: NODE_SIZE[n.kind].w,
  }))
)

function edgeTone(e: GraphEdge): string {
  const from = props.runNodes[e.from]?.status
  const to = props.runNodes[e.to]?.status
  if (to === 'running' || to === 'awaiting') return 'live'
  if (from === 'done' || from === 'skipped') return 'done'
  return 'idle'
}

/** Lowest node edge on the canvas: reject loops run underneath it. */
const floor = computed(() =>
  Math.max(0, ...props.graph.nodes.map((n) => n.position.y + NODE_SIZE[n.kind].h))
)
/** Each loop gets its own lane under the graph, so two loops never share a
 *  horizontal run. */
const loopLane = computed(() => {
  const lanes = new Map<string, number>()
  props.graph.edges.filter((e) => e.kind === 'reject').forEach((e, i) => lanes.set(e.id, i))
  return lanes
})

const flowEdges = computed<FlowEdge[]>(() =>
  props.graph.edges.map((e) => {
    const reject = (e.kind ?? 'main') === 'reject'
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      sourceHandle: reject ? 'reject-out' : 'out',
      targetHandle: reject ? 'reject-in' : 'in',
      // Above node cards would hide the lane; below them it can pass under.
      zIndex: reject ? 0 : 1,
      type: reject ? 'reject' : 'main',
      data: { edge: e, tone: edgeTone(e), lane: loopLane.value.get(e.id) ?? 0 },
      selected: selectedEdge.value === e.id,
    }
  })
)

function roleOf(n: GraphNode): string {
  return n.slot?.roleKey ? (props.roleLabels[n.slot.roleKey] ?? n.slot.roleKey) : ''
}

// ── Interaction → intents ────────────────────────────────────────────────────
function onDragStop(ev: NodeDragEvent): void {
  if (props.locked) return
  const moves = ev.nodes
    .map((n) => ({ id: n.id, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } }))
    .filter((m) => {
      const before = byId.value.get(m.id)?.position
      return !before || before.x !== m.position.x || before.y !== m.position.y
    })
  if (moves.length) emit('move', moves)
}

function isValidConnection(c: Connection): boolean {
  if (props.locked || !c.source || !c.target || c.source === c.target) return false
  const target = byId.value.get(c.target)
  if (!target || target.kind === 'trigger') return false
  const reject = c.sourceHandle === 'reject-out'
  return reject ? c.targetHandle === 'reject-in' : c.targetHandle === 'in'
}

function onConnect(c: Connection): void {
  if (!isValidConnection(c)) return
  const reject = c.sourceHandle === 'reject-out'
  emit('connect', {
    id: `${reject ? 'r' : 'e'}-${c.source}-${c.target}`,
    from: c.source,
    to: c.target,
    kind: reject ? 'reject' : 'main',
    ...(reject ? { maxLoops: 2 } : {}),
  })
}

function onKey(e: KeyboardEvent): void {
  if (props.locked) return
  if (e.key !== 'Delete' && e.key !== 'Backspace') return
  const target = e.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
  if (selectedEdge.value) { e.preventDefault(); emit('remove-edge', selectedEdge.value); selectedEdge.value = null }
  else if (props.selectedId) { e.preventDefault(); emit('remove-node', props.selectedId) }
}

function onDragOver(e: DragEvent): void {
  if (props.locked || !e.dataTransfer?.types.includes(DND_PALETTE)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
}
function onDrop(e: DragEvent): void {
  const raw = e.dataTransfer?.getData(DND_PALETTE)
  if (props.locked || !raw) return
  e.preventDefault()
  const p = screenToFlowCoordinate({ x: e.clientX, y: e.clientY })
  const size = NODE_SIZE.slot
  try {
    emit('drop-item', JSON.parse(raw) as PaletteItem, { x: Math.round(p.x - size.w / 2), y: Math.round(p.y - size.h / 2) })
  } catch { /* not ours */ }
}

// ── Viewport ─────────────────────────────────────────────────────────────────
/** Fit, then — if that left the cards too small to read — centre the node
 *  that matters at a readable zoom (see framingTarget). */
async function frame(duration = 0): Promise<void> {
  await fitView({ padding: 0.1, maxZoom: 1, duration })
  const target = framingTarget(viewport.value?.zoom ?? 1, props.graph, props.selectedId, props.runNodes)
  if (!target) return
  const n = byId.value.get(target.id)
  if (!n) return
  const size = NODE_SIZE[n.kind]
  await setCenter(n.position.x + size.w / 2, n.position.y + size.h / 2, { zoom: target.zoom, duration })
}
onInit(() => {
  void frame().then(() => emit('ready'))
})

/** Frame one link and select it — the target of a swimlane badge click. */
async function focusEdge(id: string): Promise<void> {
  const e = props.graph.edges.find((x) => x.id === id)
  if (!e) return
  selectedEdge.value = id
  await nextTick()
  await fitView({ nodes: [e.from, e.to], padding: 0.6, maxZoom: 1.1, duration: 420 })
}
/** Readable framing (after layout changes, inspector open/close). */
function zoomToFit(): void { void frame(320) }
/** The whole graph, however small — the explicit "fit" command. */
function fitAll(): void { void fitView({ padding: 0.1, maxZoom: 1, duration: 320 }) }
defineExpose({ focusEdge, zoomToFit, fitAll })

watch(() => props.selectedId, (id) => { if (id) selectedEdge.value = null })

/** Reject loops are routed orthogonally around the whole graph: down from the
 *  source, left along their own lane under the lowest node, up beside the
 *  target and into its left side. Arcing under just the two endpoints cut
 *  through any node stacked between them (parallel steps share a column). */
function rejectPath(p: EdgeProps): { path: string; labelX: number; labelY: number } {
  const r = 14
  const lane = Number((p.data as { lane?: number } | undefined)?.lane ?? 0)
  const low = floor.value + 40 + lane * 22
  const left = p.targetX - 36 - lane * 10
  const sx = p.sourceX
  const sy = p.sourceY
  const tx = p.targetX
  const ty = p.targetY
  if (sx - left < 2 * r) {
    // Degenerate geometry (target right of source): plain curve underneath.
    return { path: `M ${sx} ${sy} C ${sx} ${low}, ${tx} ${low}, ${tx} ${ty}`, labelX: (sx + tx) / 2, labelY: low }
  }
  const path = [
    `M ${sx} ${sy}`,
    `L ${sx} ${low - r}`,
    `Q ${sx} ${low} ${sx - r} ${low}`,
    `L ${left + r} ${low}`,
    `Q ${left} ${low} ${left} ${low - r}`,
    `L ${left} ${ty + r}`,
    `Q ${left} ${ty} ${left + r} ${ty}`,
    `L ${tx} ${ty}`,
  ].join(' ')
  return { path, labelX: (sx + left) / 2, labelY: low }
}
function mainPath(p: EdgeProps): { path: string; labelX: number; labelY: number } {
  const [path, labelX, labelY] = getBezierPath(p)
  return { path, labelX, labelY }
}
</script>

<template>
  <div class="pcv" :class="{ 'is-locked': locked }" tabindex="-1" @keydown="onKey" @dragover="onDragOver" @drop="onDrop">
    <VueFlow
      :id="flowId"
      :nodes="flowNodes"
      :edges="flowEdges"
      :min-zoom="0.25"
      :max-zoom="1.75"
      :delete-key-code="null"
      :nodes-draggable="!locked"
      :nodes-connectable="!locked"
      :elements-selectable="true"
      :is-valid-connection="isValidConnection"
      :snap-to-grid="true"
      :snap-grid="[10, 10]"
      :zoom-on-double-click="false"
      :connection-radius="28"
      @node-drag-stop="onDragStop"
      @node-click="({ node }) => { selectedEdge = null; emit('select', node.id) }"
      @edge-click="({ edge }) => { selectedEdge = edge.id; emit('select', null) }"
      @pane-click="() => { selectedEdge = null; emit('select', null) }"
      @connect="onConnect"
    >
      <Background :gap="20" :size="1.1" class="pcv-bg" />

      <!-- Nodes: one card component per kind; handles sit on the card edges. -->
      <template #node-trigger="{ data }">
        <PipelineNodeCard
          :data-node-id="data.node.id" class="pcv-node pcv-node--trigger"
          :node="data.node" :run="runNodes[data.node.id]" :now="now" :selected="selectedId === data.node.id"
        />
        <Handle id="out" type="source" :position="Position.Right" class="pcv-handle" />
      </template>
      <template #node-slot="{ data }">
        <Handle id="in" type="target" :position="Position.Left" class="pcv-handle" />
        <PipelineNodeCard
          :data-node-id="data.node.id" class="pcv-node"
          :node="data.node" :role-label="roleOf(data.node)" :agent-label="agentLabels[data.node.slot?.agentKey ?? ''] ?? ''"
          :run="runNodes[data.node.id]" :now="now" :selected="selectedId === data.node.id"
        />
        <Handle id="out" type="source" :position="Position.Right" class="pcv-handle" />
        <Handle id="reject-out" type="source" :position="Position.Bottom" class="pcv-handle pcv-handle--reject" :title="t('pipelineEditor.canvas.reject-handle')" />
        <Handle id="reject-in" type="target" :position="Position.Left" class="pcv-handle pcv-handle--loop-in" />
      </template>
      <template #node-gate="{ data }">
        <Handle id="in" type="target" :position="Position.Left" class="pcv-handle" />
        <PipelineNodeCard
          :data-node-id="data.node.id" class="pcv-node pcv-node--gate"
          :node="data.node" :run="runNodes[data.node.id]" :now="now" :selected="selectedId === data.node.id"
        />
        <Handle id="out" type="source" :position="Position.Right" class="pcv-handle" :title="t('pipelineEditor.canvas.pass')" />
        <Handle id="reject-out" type="source" :position="Position.Bottom" class="pcv-handle pcv-handle--reject" :title="t('pipelineEditor.canvas.reject-handle')" />
        <Handle id="reject-in" type="target" :position="Position.Left" class="pcv-handle pcv-handle--loop-in" />
      </template>

      <!-- Forward flow: hover shows "+" to insert a node on the link. -->
      <template #edge-main="p">
        <g @mouseenter="hoverEdge = p.id" @mouseleave="hoverEdge = null">
          <BaseEdge
            :id="p.id" :path="mainPath(p).path"
            class="pcv-edge" :class="[`is-${p.data.tone}`, { 'is-selected': p.selected }]"
            :interaction-width="22"
          />
        </g>
        <EdgeLabelRenderer v-if="!locked">
          <button
            type="button" class="pcv-insert nodrag nopan"
            :class="{ 'is-shown': hoverEdge === p.id || p.selected }"
            :style="{ transform: `translate(-50%, -50%) translate(${mainPath(p).labelX}px, ${mainPath(p).labelY}px)` }"
            :aria-label="t('pipelineEditor.canvas.insert-on-edge')" :title="t('pipelineEditor.canvas.insert-on-edge')"
            @mouseenter="hoverEdge = p.id" @mouseleave="hoverEdge = null"
            @click.stop="emit('insert-on-edge', p.data.edge, $event.currentTarget as HTMLElement)"
          >+</button>
        </EdgeLabelRenderer>
      </template>

      <!-- Reject loop: dashed, arcing underneath, with its loop budget. -->
      <template #edge-reject="p">
        <BaseEdge
          :id="p.id" :path="rejectPath(p).path"
          class="pcv-edge pcv-edge--reject" :class="{ 'is-selected': p.selected }"
          :interaction-width="22"
        />
        <EdgeLabelRenderer>
          <!-- The label is the loop's handle: a dashed line is a thin target,
               the pill is easy to hit and opens the retry-limit panel. -->
          <button
            type="button" class="pcv-loop-label nodrag nopan" :class="{ 'is-selected': p.selected }"
            :style="{ transform: `translate(-50%, -50%) translate(${rejectPath(p).labelX}px, ${rejectPath(p).labelY}px)` }"
            :aria-label="t('pipelineEditor.edge.title')"
            @click.stop="selectedEdge = p.id; emit('select', null)"
          >{{ t('pipelineEditor.canvas.loop-label', { max: p.data.edge.maxLoops ?? 2 }) }}</button>
        </EdgeLabelRenderer>
      </template>

      <MiniMap
        class="pcv-minimap" pannable zoomable :width="132" :height="84"
        :node-border-radius="6" :aria-label="t('pipelineEditor.canvas.minimap')"
        :node-class-name="(n) => minimapClass(runNodes[n.id]?.status)"
      />
    </VueFlow>
    <div class="pcv-zoom" role="group" :aria-label="t('pipelineEditor.canvas.zoom-level')">
      <button type="button" :aria-label="t('pipelineEditor.canvas.zoom-out')" :title="t('pipelineEditor.canvas.zoom-out')" @click="zoomOut({ duration: 160 })">
        <svg viewBox="0 0 16 16"><path d="M4 8h8" /></svg>
      </button>
      <span class="pcv-zoom-level" aria-live="polite">{{ zoomPercent }}</span>
      <button type="button" :aria-label="t('pipelineEditor.canvas.zoom-in')" :title="t('pipelineEditor.canvas.zoom-in')" @click="zoomIn({ duration: 160 })">
        <svg viewBox="0 0 16 16"><path d="M4 8h8M8 4v8" /></svg>
      </button>
      <button type="button" :aria-label="t('pipelineEditor.toolbar.fit')" :title="t('pipelineEditor.toolbar.fit')" @click="fitAll">
        <svg viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.pcv {
  position: relative;
  width: 100%;
  height: 100%;
  background: var(--bg-base);
  outline: none;
}
.pcv :deep(.vue-flow__node) {
  padding: 0;
  border: none;
  background: transparent;
  border-radius: var(--radius-card);
}
.pcv :deep(.vue-flow__node.selected),
.pcv :deep(.vue-flow__node:focus-visible) { outline: none; }
.pcv :deep(.vue-flow__node:focus-visible .pnc) { outline: 2px solid var(--accent-focus); outline-offset: 2px; }
.pcv-node { cursor: grab; }
.pcv-node--trigger { width: 168px; min-height: 56px; }
.pcv-node--gate { width: 196px; min-height: 68px; }
.pcv-bg :deep(circle),
.pcv :deep(.vue-flow__background pattern circle) { fill: color-mix(in srgb, var(--text-muted) 30%, transparent); }

/* Handles: invisible until the node is hovered, so the cards stay calm. */
.pcv :deep(.pcv-handle) {
  width: 10px;
  height: 10px;
  min-width: 0;
  min-height: 0;
  border-radius: 50%;
  border: 2px solid var(--bg-elevated);
  background: var(--border-strong);
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.pcv :deep(.vue-flow__node:hover .pcv-handle),
.pcv :deep(.vue-flow__node.selected .pcv-handle),
.pcv :deep(.vue-flow__handle.connectingto),
.pcv :deep(.vue-flow__handle.connectionindicator:hover) { opacity: 1; }
.pcv :deep(.pcv-handle:hover) { background: var(--accent-emphasis); }
.pcv :deep(.pcv-handle--reject) { background: var(--done-emphasis); left: 38%; }
.pcv :deep(.pcv-handle--loop-in) { top: 78%; width: 8px; height: 8px; background: var(--done-emphasis); }
.pcv :deep(.vue-flow__handle.valid) { background: var(--success-emphasis); opacity: 1; }
/* Read-only: nothing to connect, so no handles at all. */
.pcv.is-locked :deep(.pcv-handle) { opacity: 0 !important; pointer-events: none; }

/* Edges */
.pcv :deep(.pcv-edge) {
  stroke: var(--border-strong);
  stroke-width: 1.6;
  fill: none;
  transition: stroke var(--motion-base) var(--ease-out);
}
.pcv :deep(.pcv-edge.is-done) { stroke: var(--success-emphasis); }
.pcv :deep(.pcv-edge.is-live) {
  stroke: var(--accent-emphasis);
  stroke-dasharray: 6 5;
  animation: pcv-flow 0.9s linear infinite;
}
.pcv :deep(.pcv-edge.is-selected) { stroke: var(--accent-emphasis); stroke-width: 2.4; }
.pcv :deep(.pcv-edge--reject) {
  stroke: var(--done-emphasis);
  stroke-dasharray: 5 5;
}
.pcv :deep(.pcv-edge--reject.is-selected) { stroke: var(--done-emphasis); stroke-width: 2.4; }
.pcv :deep(.vue-flow__connection-path) { stroke: var(--accent-emphasis); stroke-width: 1.6; }

.pcv-insert {
  position: absolute;
  pointer-events: all;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--accent-emphasis);
  background: var(--bg-elevated);
  color: var(--accent-fg);
  font: inherit;
  font-size: var(--font-md);
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  scale: 0.6;
  transition: opacity var(--motion-fast) var(--ease-out), scale var(--motion-base) var(--ease-out);
}
.pcv-insert.is-shown, .pcv-insert:focus-visible { opacity: 1; scale: 1; }
.pcv-insert:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 2px; }

.pcv-loop-label {
  position: absolute;
  pointer-events: all;
  cursor: pointer;
  font: inherit;
  padding: 1px var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--bg-elevated);
  border: 1px solid color-mix(in srgb, var(--done-emphasis) 45%, transparent);
  color: var(--done-fg);
  font-size: var(--font-2xs);
  white-space: nowrap;
}
.pcv-loop-label:hover,
.pcv-loop-label.is-selected { background: color-mix(in srgb, var(--done-emphasis) 14%, var(--bg-elevated)); border-color: var(--done-emphasis); }
.pcv-loop-label:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 2px; }

/* Minimap */
.pcv :deep(.pcv-minimap) {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
  box-shadow: var(--shadow-popover);
}
.pcv :deep(.vue-flow__minimap-node) { fill: var(--bg-muted); stroke: var(--border-strong); }
.pcv :deep(.pcv-mm--done), .pcv :deep(.pcv-mm--skipped) { fill: color-mix(in srgb, var(--success-emphasis) 70%, transparent); stroke: var(--success-emphasis); }
.pcv :deep(.pcv-mm--running) { fill: var(--accent-emphasis); stroke: var(--accent-emphasis); }
.pcv :deep(.pcv-mm--awaiting) { fill: var(--attention-emphasis); stroke: var(--attention-emphasis); }
.pcv :deep(.pcv-mm--failed), .pcv :deep(.pcv-mm--rejected), .pcv :deep(.pcv-mm--aborted) { fill: var(--danger-emphasis); stroke: var(--danger-emphasis); }

/* Zoom: bottom-left, opposite the minimap. */
.pcv-zoom {
  position: absolute;
  left: var(--space-4);
  bottom: var(--space-4);
  z-index: 5;
  display: flex;
  align-items: center;
  padding: 2px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-popover);
}
.pcv-zoom button {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.pcv-zoom button svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.pcv-zoom button:hover { background: var(--bg-hover); color: var(--text-primary); }
.pcv-zoom button:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: -2px; }
.pcv-zoom-level { min-width: 42px; text-align: center; font-size: var(--font-2xs); font-variant-numeric: tabular-nums; color: var(--text-secondary); }
.pcv :deep(.vue-flow__minimap-mask) { fill: color-mix(in srgb, var(--bg-base) 62%, transparent); }

@keyframes pcv-flow { to { stroke-dashoffset: -22; } }
@media (prefers-reduced-motion: reduce) {
  .pcv :deep(.pcv-edge.is-live) { animation: none; }
  .pcv-insert, .pcv :deep(.pcv-handle) { transition: none; }
}
</style>
