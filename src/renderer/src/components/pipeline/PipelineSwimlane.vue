<script setup lang="ts">
// Swimlane view: the graph's longest-path layers as columns, parallel steps
// stacked inside. It only ever draws what columns can say; reject loops, gate
// forks and layer-skipping links become badges that jump to the canvas
// (plan §6.1). Gestures are reported as intents — the editor turns them into
// graph ops (pipelineGraphEdits) so both views share one history.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { layerGraph, type GraphNode, type NodeRunState, type PipelineGraph } from '../../lib/pipelineGraph'
import type { LaneBadge } from '../../lib/pipelineGraphEdits'
import type { Stage } from '../../data/stages'
import PipelineNodeCard from './PipelineNodeCard.vue'
import { DND_NODE, DND_PALETTE, stagesByLayer, type PaletteItem } from './pipelineEditorModel'
import { vTruncate } from '@navide/plugin-ui/foundation'

export interface LaneTarget {
  mode: 'into' | 'newLayer'
  layer: number
}

const props = defineProps<{
  graph: PipelineGraph
  /** Stages derived from the graph — one per layer that holds a slot. */
  stages: Stage[]
  roleLabels: Record<string, string>
  agentLabels: Record<string, string>
  runNodes: Record<string, NodeRunState>
  badges: Map<string, LaneBadge[]>
  now: number
  selectedId: string | null
  locked: boolean
  canReorder: boolean
}>()
const emit = defineEmits<{
  (e: 'select', id: string | null): void
  (e: 'drop-item', item: PaletteItem, target: LaneTarget): void
  (e: 'move-node', id: string, target: LaneTarget): void
  (e: 'reorder', from: number, to: number): void
  (e: 'remove', id: string): void
  (e: 'badge', badge: LaneBadge): void
  (e: 'request-add', target: LaneTarget, anchor: HTMLElement): void
  (e: 'edit-layer', layer: number): void
  (e: 'reorder-refused'): void
}>()
const { t } = useI18n()

const byId = computed(() => new Map(props.graph.nodes.map((n) => [n.id, n])))
const lanes = computed(() => {
  const { layers, triggers } = layerGraph(props.graph)
  // A layer's stage is the derived stage holding its slot nodes; gate-only
  // layers have none and are titled as a checkpoint.
  const stageOf = stagesByLayer(layers, (id) => byId.value.get(id)?.kind, props.stages)
  const columns = layers.map((ids, i) => {
    const nodes = ids.map((id) => byId.value.get(id)!).filter(Boolean)
    return { index: i, nodes, stage: stageOf[i], gateOnly: !nodes.some((n) => n.kind === 'slot') }
  })
  return { columns, triggers: triggers.map((id) => byId.value.get(id)!).filter(Boolean) }
})

/** Run state of the link INTO a column: live while anything in it runs or
 *  waits, done once every step in it has finished. */
function flowState(col: { nodes: GraphNode[] }): '' | 'live' | 'done' {
  const states = col.nodes.map((n) => props.runNodes[n.id]?.status)
  if (states.some((s) => s === 'running' || s === 'awaiting')) return 'live'
  if (states.length && states.every((s) => s === 'done' || s === 'skipped')) return 'done'
  return ''
}

function columnTitle(col: { index: number; stage?: Stage; gateOnly: boolean }): string {
  if (col.gateOnly) return t('pipelineEditor.lane.checkpoint')
  return col.stage?.shortTitle || col.stage?.title || t('pipelineEditor.lane.layer', { n: col.index + 1 })
}

function roleOf(n: GraphNode): string {
  return n.slot?.roleKey ? (props.roleLabels[n.slot.roleKey] ?? n.slot.roleKey) : ''
}

// ── Drag and drop ────────────────────────────────────────────────────────────
const hover = ref<string>('')
let draggingId = ''

function onCardDragStart(e: DragEvent, id: string): void {
  if (props.locked || !e.dataTransfer) return
  draggingId = id
  e.dataTransfer.setData(DND_NODE, id)
  e.dataTransfer.effectAllowed = 'move'
}
function onDragEnd(): void { draggingId = ''; hover.value = '' }

function accepts(e: DragEvent): boolean {
  const types = e.dataTransfer?.types ?? []
  return !props.locked && (types.includes(DND_PALETTE) || types.includes(DND_NODE))
}
function onOver(e: DragEvent, key: string): void {
  if (!accepts(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DND_NODE) ? 'move' : 'copy'
  hover.value = key
}
function onLeave(e: DragEvent, key: string): void {
  const next = e.relatedTarget as Node | null
  if (next && (e.currentTarget as HTMLElement).contains(next)) return
  if (hover.value === key) hover.value = ''
}
function onDrop(e: DragEvent, target: LaneTarget): void {
  hover.value = ''
  if (!accepts(e) || !e.dataTransfer) return
  e.preventDefault()
  const nodeId = e.dataTransfer.getData(DND_NODE) || draggingId
  if (nodeId) { emit('move-node', nodeId, target); draggingId = ''; return }
  const raw = e.dataTransfer.getData(DND_PALETTE)
  if (!raw) return
  try { emit('drop-item', JSON.parse(raw) as PaletteItem, target) } catch { /* not ours */ }
}

// ── Overflow cue: layers off to the right are announced, not just cut ───────
const scroller = ref<HTMLElement | null>(null)
const hiddenRight = ref(0)
function measure(): void {
  const el = scroller.value
  if (!el) return
  const edge = el.scrollLeft + el.clientWidth
  // A layer counts as hidden once more than a sliver of it is cut off.
  hiddenRight.value = Array.from(el.querySelectorAll<HTMLElement>('.lane'))
    .filter((lane) => lane.offsetLeft + lane.offsetWidth > edge + 24).length
}
function showMore(): void {
  const el = scroller.value
  if (!el) return
  const edge = el.scrollLeft + el.clientWidth
  const next = Array.from(el.querySelectorAll<HTMLElement>('.lane')).find((lane) => lane.offsetLeft + lane.offsetWidth > edge + 24)
  el.scrollTo({ left: Math.max(0, (next?.offsetLeft ?? el.scrollWidth) - 56), behavior: 'smooth' })
}
let resize: ResizeObserver | null = null
onMounted(() => {
  void nextTick(measure)
  if (typeof ResizeObserver !== 'undefined' && scroller.value) {
    resize = new ResizeObserver(() => measure())
    resize.observe(scroller.value)
  }
})
onBeforeUnmount(() => resize?.disconnect())
watch(() => props.graph, () => { void nextTick(measure) })

// ── Keyboard ─────────────────────────────────────────────────────────────────
function onCardKey(e: KeyboardEvent, id: string, layer: number): void {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emit('select', id); return }
  if (props.locked) return
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); emit('remove', id); return }
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault()
    const to = layer + (e.key === 'ArrowLeft' ? -1 : 1)
    if (to < 0) emit('move-node', id, { mode: 'newLayer', layer: 0 })
    else if (to >= lanes.value.columns.length) emit('move-node', id, { mode: 'newLayer', layer: lanes.value.columns.length })
    else emit('move-node', id, { mode: 'into', layer: to })
  }
}

function shiftColumn(index: number, delta: -1 | 1): void {
  if (!props.canReorder) { emit('reorder-refused'); return }
  emit('reorder', index, index + delta)
}
</script>

<template>
  <div class="lane-wrap">
  <div ref="scroller" class="lane-scroll" :class="{ 'has-more': hiddenRight > 0 }" @click.self="emit('select', null)" @scroll.passive="measure">
    <div class="lanes" @click.self="emit('select', null)">
      <!-- Lead-in: where the run starts. -->
      <div class="lane-start">
        <PipelineNodeCard
          v-for="n in lanes.triggers" :key="n.id" :data-node-id="n.id"
          class="lane-trigger" :node="n" :selected="selectedId === n.id"
          :run="runNodes[n.id]" :now="now"
          tabindex="0" @click="emit('select', n.id)" @keydown.enter="emit('select', n.id)"
        />
      </div>

      <template v-for="col in lanes.columns" :key="col.index">
        <!-- Gutter: drop here (or press +) to insert a whole layer. -->
        <div
          class="lane-gutter" :class="[{ 'is-hot': hover === `g${col.index}` }, flowState(col) ? `is-${flowState(col)}` : '']"
          @dragover="onOver($event, `g${col.index}`)" @dragleave="onLeave($event, `g${col.index}`)"
          @drop="onDrop($event, { mode: 'newLayer', layer: col.index })"
        >
          <span class="lane-flow" aria-hidden="true"></span>
          <button
            v-if="!locked" type="button" class="lane-insert"
            :aria-label="t('pipelineEditor.lane.insert-layer', { n: col.index + 1 })"
            :title="t('pipelineEditor.lane.insert-layer', { n: col.index + 1 })"
            @click="emit('request-add', { mode: 'newLayer', layer: col.index }, $event.currentTarget as HTMLElement)"
          >+</button>
        </div>

        <section
          class="lane" :class="{ 'is-hot': hover === `c${col.index}`, 'is-gate': col.gateOnly }"
          :aria-label="columnTitle(col)"
          @dragover="onOver($event, `c${col.index}`)" @dragleave="onLeave($event, `c${col.index}`)"
          @drop="onDrop($event, { mode: 'into', layer: col.index })"
        >
          <header class="lane-head">
            <span class="lane-index">{{ col.index + 1 }}</span>
            <span class="lane-title" v-truncate>{{ columnTitle(col) }}</span>
            <span v-if="col.nodes.length > 1" class="lane-par">{{ t('pipelineEditor.lane.parallel', { n: col.nodes.length }) }}</span>
            <span class="lane-tools">
              <button
                v-if="!locked" type="button" class="lane-tool" :disabled="col.index === 0"
                :aria-label="t('pipelineEditor.lane.move-left')" :title="t('pipelineEditor.lane.move-left')"
                @click="shiftColumn(col.index, -1)"
              ><svg viewBox="0 0 16 16"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg></button>
              <button
                v-if="!locked" type="button" class="lane-tool" :disabled="col.index === lanes.columns.length - 1"
                :aria-label="t('pipelineEditor.lane.move-right')" :title="t('pipelineEditor.lane.move-right')"
                @click="shiftColumn(col.index, 1)"
              ><svg viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5" /></svg></button>
              <button
                v-if="col.stage" type="button" class="lane-tool"
                :aria-label="t('pipelineEditor.lane.settings')" :title="t('pipelineEditor.lane.settings')"
                @click="emit('edit-layer', col.index)"
              ><svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg></button>
            </span>
          </header>
          <ul class="lane-cards">
            <li v-for="n in col.nodes" :key="n.id">
              <PipelineNodeCard
                :data-node-id="n.id"
                :node="n" :role-label="roleOf(n)" :agent-label="n.slot ? agentLabels[n.slot.agentKey] : ''"
                :run="runNodes[n.id]" :now="now" :selected="selectedId === n.id"
                :badges="badges.get(n.id)"
                class="lane-card" :class="{ 'is-locked': locked }"
                tabindex="0" :draggable="!locked"
                @dragstart="onCardDragStart($event, n.id)" @dragend="onDragEnd"
                @click="emit('select', n.id)"
                @keydown="onCardKey($event, n.id, col.index)"
                @badge="emit('badge', $event)"
              />
            </li>
          </ul>
          <button
            v-if="!locked && !col.gateOnly" type="button" class="lane-add"
            @click="emit('request-add', { mode: 'into', layer: col.index }, $event.currentTarget as HTMLElement)"
          >{{ t('pipelineEditor.lane.add-parallel') }}</button>
        </section>
      </template>

      <!-- Tail: drop here (or press +) to append a layer. -->
      <div
        class="lane-gutter lane-gutter--tail" :class="{ 'is-hot': hover === 'tail' }"
        @dragover="onOver($event, 'tail')" @dragleave="onLeave($event, 'tail')"
        @drop="onDrop($event, { mode: 'newLayer', layer: lanes.columns.length })"
      >
        <span class="lane-flow" aria-hidden="true"></span>
      </div>
      <button
        v-if="!locked" type="button" class="lane-append" :class="{ 'is-hot': hover === 'append', 'is-first': !lanes.columns.length }"
        @dragover="onOver($event, 'append')" @dragleave="onLeave($event, 'append')"
        @drop="onDrop($event, { mode: 'newLayer', layer: lanes.columns.length })"
        @click="emit('request-add', { mode: 'newLayer', layer: lanes.columns.length }, $event.currentTarget as HTMLElement)"
      >
        <span class="lane-append-plus" aria-hidden="true">+</span>
        <template v-if="lanes.columns.length">{{ t('pipelineEditor.lane.append-layer') }}</template>
        <template v-else>
          <strong class="lane-append-title">{{ t('pipelineEditor.state.empty-title') }}</strong>
          <span class="lane-append-body">{{ t('pipelineEditor.state.empty-body') }}</span>
        </template>
      </button>
    </div>
  </div>
  <button v-if="hiddenRight > 0" type="button" class="lane-more" @click="showMore">
    {{ t('pipelineEditor.lane.more', { n: hiddenRight }, hiddenRight) }}
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
  </button>
  </div>
</template>

<style scoped>
.lane-wrap { position: relative; height: 100%; }
/* Layers past the right edge fade out instead of being sliced off. */
.lane-scroll.has-more {
  -webkit-mask-image: linear-gradient(to right, rgb(0 0 0) calc(100% - 72px), transparent);
  mask-image: linear-gradient(to right, rgb(0 0 0) calc(100% - 72px), transparent);
}
.lane-scroll {
  position: relative;
  height: 100%;
  overflow: auto;
  /* A quiet engineering grid: the same dot field the canvas uses, so the two
     views read as one surface seen two ways. */
  background-color: var(--bg-base);
  background-image: radial-gradient(color-mix(in srgb, var(--text-muted) 22%, transparent) 1px, transparent 1px);
  background-size: 20px 20px;
}
.lanes {
  display: flex;
  align-items: flex-start;
  min-height: 100%;
  width: max-content;
  padding: var(--space-7) var(--space-7) var(--space-8);
  box-sizing: border-box;
}
.lane-start { display: flex; flex-direction: column; gap: var(--space-3); padding-top: 44px; }
.lane-trigger { --pnc-w: 156px; min-height: 56px; cursor: pointer; }

.lane {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  --pnc-w: 100%;
  width: 248px;
  padding: var(--space-3) var(--space-3) var(--space-3);
  box-sizing: border-box;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--bg-subtle) 82%, transparent);
  border: 1px solid var(--border-muted);
  transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.lane.is-gate { width: 212px; }
.lane.is-hot {
  border-color: var(--accent-emphasis);
  background: color-mix(in srgb, var(--accent-emphasis) 7%, var(--bg-subtle));
}
.lane-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 28px;
}
.lane-index {
  display: grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  border-radius: var(--radius-pill);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.lane-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lane-par { font-size: var(--font-2xs); color: var(--text-muted); white-space: nowrap; }
.lane-tools { display: flex; gap: 2px; opacity: 0.55; transition: opacity var(--motion-fast) var(--ease-out); }
.lane:hover .lane-tools, .lane:focus-within .lane-tools { opacity: 1; }
.lane-tool {
  display: grid;
  place-items: center;
  width: var(--icon-btn-sm);
  height: var(--icon-btn-sm);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.lane-tool svg { width: 14px; height: 14px; fill: currentColor; stroke: currentColor; stroke-width: 0; }
.lane-tool svg path { fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.lane-tool:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.lane-tool:disabled { opacity: 0.35; cursor: default; }
.lane-tool:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }

.lane-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.lane-card { cursor: grab; }
.lane-card.is-locked { cursor: pointer; }
.lane-card:focus-visible, .lane-trigger:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 2px; }

.lane-add {
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-card);
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--font-xs);
  padding: var(--space-2);
  cursor: pointer;
  transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}
.lane-add:hover { color: var(--accent-fg); border-color: var(--accent-emphasis); }
.lane-add:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }

/* Gutter: the flow arrow between layers doubles as the insert target. */
.lane-gutter {
  position: relative;
  align-self: stretch;
  width: 40px;
  flex: none;
}
.lane-gutter--tail { width: 32px; }
.lane-flow {
  position: absolute;
  left: 10px;
  right: 10px;
  top: 82px;
  height: 0;
  border-top: 1.5px solid var(--border-strong);
}
.lane-flow::after {
  content: '';
  position: absolute;
  right: -1px;
  top: -4.5px;
  border-left: 6px solid var(--border-strong);
  border-top: 3.5px solid transparent;
  border-bottom: 3.5px solid transparent;
}
.lane-insert {
  position: absolute;
  left: 50%;
  top: 82px;
  transform: translate(-50%, -50%) scale(0.6);
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--accent-emphasis);
  background: var(--bg-elevated);
  color: var(--accent-fg);
  font-size: var(--font-md);
  line-height: 1;
  opacity: 0;
  cursor: pointer;
  transition: opacity var(--motion-fast) var(--ease-out), transform var(--motion-base) var(--ease-out);
}
.lane-scroll:hover .lane-insert { opacity: 0.35; transform: translate(-50%, -50%) scale(0.8); }
.lane-gutter:hover .lane-insert,
.lane-insert:focus-visible,
.lane-gutter.is-hot .lane-insert { opacity: 1; transform: translate(-50%, -50%) scale(1); }
.lane-insert:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 2px; }
.lane-gutter.is-hot .lane-flow { border-top-color: var(--accent-emphasis); }
/* Run state on the link into a column: green once it finished, a flowing
   accent line while it runs — the swimlane's version of the canvas edges. */
.lane-gutter.is-done .lane-flow { border-top-color: var(--success-emphasis); }
.lane-gutter.is-done .lane-flow::after { border-left-color: var(--success-emphasis); }
.lane-gutter.is-live .lane-flow {
  border-top: none;
  height: 2px;
  margin-top: -0.5px;
  background: repeating-linear-gradient(90deg, var(--accent-emphasis) 0 6px, transparent 6px 11px);
  background-size: 22px 2px;
  animation: lane-flow 0.9s linear infinite;
}
.lane-gutter.is-live .lane-flow::after { border-left-color: var(--accent-emphasis); top: -3.5px; }
@keyframes lane-flow { to { background-position: 22px 0; } }

.lane-append {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 168px;
  min-height: 132px;
  margin-top: 44px;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--font-xs);
  cursor: pointer;
  transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.lane-append-plus { font-size: var(--font-xl); line-height: 1; }
.lane-append.is-first {
  width: 300px;
  min-height: 184px;
  padding: var(--space-5);
  border-width: 1.5px;
  text-align: center;
}
.lane-append-title { font-size: var(--font-sm); font-weight: 600; color: var(--text-primary); }
.lane-append-body { font-size: var(--font-xs); line-height: var(--lh-base); }
.lane-append:hover, .lane-append.is-hot {
  color: var(--accent-fg);
  border-color: var(--accent-emphasis);
  background: color-mix(in srgb, var(--accent-emphasis) 6%, transparent);
}
.lane-append:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 2px; }

.lane-more {
  position: absolute;
  right: var(--space-5);
  bottom: var(--space-5);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 30px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-pill);
  background: var(--bg-overlay);
  box-shadow: var(--shadow-popover);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-xs);
  white-space: nowrap;
  cursor: pointer;
  animation: lane-more-in var(--motion-base) var(--ease-out) both;
}
.lane-more svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.lane-more:hover { border-color: var(--accent-emphasis); color: var(--accent-fg); }
.lane-more:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 2px; }
@keyframes lane-more-in { from { opacity: 0; transform: translateX(8px); } }
@media (prefers-reduced-motion: reduce) {
  .lane-more { animation: none; }
  .lane, .lane-insert, .lane-append, .lane-add, .lane-tools { transition: none; }
  .lane-gutter.is-live .lane-flow { animation: none; }
}
</style>
