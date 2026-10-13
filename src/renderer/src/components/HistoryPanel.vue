<script setup lang="ts">
import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { useHistory, type HistoryEvent } from '../composables/useHistory'
import type { useBackend } from '../composables/useBackend'
import type { PipelineStatusView } from './ControlPane.vue'

interface Props {
  backend: ReturnType<typeof useBackend>
  workspacePath: string
  pipeline: PipelineStatusView
}
const props = defineProps<Props>()

// ─────────────────────── Run info: file links + live log ───────────────────
// Moved here from ControlPane so the run's project.json / pipeline.log /
// backend.log links and the supervision log live alongside the timeline.
// Classify a supervision-log line so errors stand out (red) and warnings (yellow).
function logLevel(line: string): '' | 'is-error' | 'is-warn' {
  if (/❌|✕|✗|exception|unreachable|rejection|\berror\b|\bfailed\b|\bthrew\b/i.test(line)) {
    return 'is-error'
  }
  if (/⚠/.test(line)) return 'is-warn'
  return ''
}
async function openPath(p: string): Promise<void> {
  if (!p) return
  if (!window.agentTeam?.openPath) {
    try {
      await navigator.clipboard.writeText(p)
    } catch {
      /* ignore */
    }
    return
  }
  await window.agentTeam.openPath(p)
}
// Auto-scroll the supervision log to the bottom whenever a new entry arrives.
const pipelineLogEl = ref<HTMLElement | null>(null)
watch(
  () => props.pipeline.log.length,
  async () => {
    await nextTick()
    if (pipelineLogEl.value) pipelineLogEl.value.scrollTop = pipelineLogEl.value.scrollHeight
  }
)

const workspacePathRef: Ref<string> = computed(() => props.workspacePath) as unknown as Ref<string>
const { events, path, loading } = useHistory(props.backend, workspacePathRef)

// type → display icon. Unknown types fall back to a neutral dot.
const ICONS: Record<string, string> = {
  pipeline_start: '▶',
  pipeline_complete: '🎉',
  pipeline_abort: '✖',
  stage_advance: '⏭',
  stage_completed: '🏁',
  stage_stalled: '⏰',
  sentinel_detected: '🏁',
  pane_spawn: '＋',
  context_handoff: '📤',
  manager: '🎯',
  question_detected: '❓',
  question_answered: '↩',
  question_auto_answered: '🤖',
  analyzer_result: '🧠',
  warning: '⚠',
  log: '·'
}
function iconFor(t: string): string {
  return ICONS[t] ?? '·'
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString()
  } catch {
    return iso
  }
}

// ─────────────────────── Filters ───────────────────────
const typeFilter = ref<string>('all')
const stageFilter = ref<string>('all')
const search = ref<string>('')

const typeOptions = computed(() => {
  const s = new Set<string>()
  for (const e of events.value) s.add(e.type)
  return ['all', ...Array.from(s).sort()]
})
const stageOptions = computed(() => {
  const s = new Set<string>()
  for (const e of events.value) if (e.stage_id) s.add(e.stage_id)
  return ['all', ...Array.from(s).sort()]
})

const filtered = computed<HistoryEvent[]>(() => {
  const q = search.value.trim().toLowerCase()
  return events.value.filter((e) => {
    if (typeFilter.value !== 'all' && e.type !== typeFilter.value) return false
    if (stageFilter.value !== 'all' && e.stage_id !== stageFilter.value) return false
    if (q && !e.summary.toLowerCase().includes(q)) return false
    return true
  })
})

// ─────────────────────── Row expand ───────────────────────
const expandedIds = ref<Set<string>>(new Set())
function toggle(id: string): void {
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedIds.value = next
}
function detailJson(e: HistoryEvent): string {
  return JSON.stringify(e.detail ?? {}, null, 2)
}

// ─────────────────────── Auto-scroll (stick to bottom) ───────────────────────
// New events append at the bottom (chronological). Keep the timeline pinned to
// the newest row, but only while the user is already near the bottom — if they
// scrolled up to read history, don't yank them back down.
const timelineEl = ref<HTMLElement | null>(null)
const stick = ref(true)

function onScroll(): void {
  const el = timelineEl.value
  if (!el) return
  // tolerance so small layout shifts (row expand, font metrics) stay "stuck"
  stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

watch(
  () => filtered.value.length,
  () => {
    if (!stick.value) return
    nextTick(() => {
      const el = timelineEl.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
)

// ─────────────────────── Export / open ───────────────────────
function exportJsonl(): void {
  const text = filtered.value.map((e) => JSON.stringify(e)).join('\n')
  const blob = new Blob([text], { type: 'application/x-ndjson' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'history.jsonl'
  a.click()
  URL.revokeObjectURL(url)
}
async function openFile(): Promise<void> {
  if (!path.value) return
  try {
    await window.agentTeam?.openPath(path.value)
  } catch {
    /* ignore */
  }
}

// ─────────────────── Draggable split: log (top) ↔ history (bottom) ──────────
// Log region stays visible at all times; drag the divider to resize its height.
// Height is persisted so it survives reloads. Bounds are static (clamped px).
const logHeight = ref<number>(
  parseFloat(settingsGet('agentTeam.history.logHeight', '')) || 160
)
watch(logHeight, (v) => { settingsSet('agentTeam.history.logHeight', String(v)) })

let _logDragStartY = 0
let _logDragStartH = 0
function onLogDividerStart(e: MouseEvent): void {
  _logDragStartY = e.clientY
  _logDragStartH = logHeight.value
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'row-resize'
  document.addEventListener('mousemove', onLogDividerMove)
  document.addEventListener('mouseup', onLogDividerEnd)
  e.preventDefault()
}
function onLogDividerMove(e: MouseEvent): void {
  const h = _logDragStartH + e.clientY - _logDragStartY
  logHeight.value = Math.max(60, Math.min(480, h))
}
function onLogDividerEnd(): void {
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  document.removeEventListener('mousemove', onLogDividerMove)
  document.removeEventListener('mouseup', onLogDividerEnd)
}
</script>

<template>
  <div class="history">
    <div class="run-info">
      <div v-if="pipeline.projectId" class="paths-actions">
        <button v-if="pipeline.projectFile" class="ghost" v-truncate :title="pipeline.projectFile" @click="openPath(pipeline.projectFile)">📄 {{ pipeline.projectFile.split(/[\\/]/).pop() }}</button>
        <button class="ghost" v-truncate :title="pipeline.pipelineLogFile" @click="openPath(pipeline.pipelineLogFile)">📜 pipeline.log</button>
        <button class="ghost" v-truncate :title="pipeline.backendLogFile" @click="openPath(pipeline.backendLogFile)">🪵 backend.log</button>
      </div>
      <div class="log-panel" :style="{ height: logHeight + 'px' }">
        <div class="log-hdr">
          <span class="log-title">›_ Console</span>
          <span v-if="pipeline.log.length" class="log-count">{{ pipeline.log.length }}</span>
        </div>
        <div ref="pipelineLogEl" class="pipeline-log">
          <template v-if="pipeline.log.length">
            <div v-for="(line, i) in pipeline.log" :key="i" class="pipeline-log-line" :class="logLevel(line)">{{ line }}</div>
          </template>
          <div v-else class="pipeline-log-empty">
            <span class="empty-glyph">›_</span>
            <span>{{ $t('label.no-output-yet') }}</span>
          </div>
        </div>
      </div>
      <div class="log-resize" title="Drag to resize log panel" @mousedown="onLogDividerStart">
        <div class="log-resize-grip" />
      </div>
    </div>

    <div class="filters">
      <select v-model="typeFilter" class="flt" title="Filter by type">
        <option v-for="t in typeOptions" :key="t" :value="t">{{ t }}</option>
      </select>
      <select v-model="stageFilter" class="flt" title="Filter by stage">
        <option v-for="s in stageOptions" :key="s" :value="s">
          {{ s === 'all' ? $t('label.all-stages') : $t('label.stage-n', { n: s }) }}
        </option>
      </select>
      <input v-model="search" class="search" type="text" placeholder="🔍 search…" />
    </div>

    <div v-if="loading && events.length === 0" class="msg">{{ $t('label.loading') }}</div>
    <div v-else-if="filtered.length === 0" class="msg">{{ $t('label.no-events') }}</div>

    <div ref="timelineEl" class="timeline" @scroll="onScroll">
      <div
        v-for="e in filtered"
        :key="e.id"
        class="row"
        :class="{ open: expandedIds.has(e.id) }"
        @click="toggle(e.id)"
      >
        <span class="ts">{{ fmtTime(e.ts) }}</span>
        <span class="icon">{{ iconFor(e.type) }}</span>
        <span class="summary">{{ e.summary }}</span>
        <pre v-if="expandedIds.has(e.id) && e.detail" class="detail">{{ detailJson(e) }}</pre>
      </div>
    </div>

    <div class="actions">
      <button class="act" @click="exportJsonl">{{ $t('action.export') }}</button>
      <button class="act" :disabled="!path" @click="openFile">{{ $t('action.open-file') }}</button>
    </div>
  </div>
</template>

<style scoped>
.history {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.run-info {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-muted);
}
.paths-actions {
  display: flex;
  gap: 4px;
}
.paths-actions .ghost {
  flex: 1;
  min-width: 0;
  background: transparent;
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 5px;
  font-size: var(--font-3xs);
  padding: 4px 4px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.paths-actions .ghost:hover {
  background: var(--bg-muted);
}
.log-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin-top: 4px;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  overflow: hidden;
}
.log-hdr {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-bottom: 1px solid var(--bg-subtle);
  background: var(--bg-base);
}
.log-title {
  font-family: Menlo, Monaco, 'Courier New', monospace;
  font-size: var(--font-3xs);
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--text-secondary);
}
.log-count {
  font-size: 9px;
  color: var(--text-muted);
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  padding: 0 6px;
  font-variant-numeric: tabular-nums;
}
.pipeline-log {
  flex: 1;
  min-height: 0;
  padding: 6px 8px;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-family: Menlo, Monaco, 'Courier New', monospace;
  font-size: var(--font-3xs);
}
.pipeline-log-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: var(--font-2xs);
}
.empty-glyph {
  font-family: Menlo, Monaco, 'Courier New', monospace;
  font-size: var(--font-lg);
  color: var(--border-default);
  letter-spacing: 1px;
}
.log-resize {
  flex-shrink: 0;
  height: 7px;
  cursor: row-resize;
  display: flex;
  align-items: center;
  justify-content: center;
}
.log-resize-grip {
  height: 1px;
  width: 100%;
  background: var(--bg-muted);
  transition: background 0.12s, height 0.12s;
}
.log-resize:hover .log-resize-grip {
  height: 3px;
  background: var(--accent-focus);
}
.pipeline-log-line {
  color: var(--text-secondary);
  line-height: var(--lh-base);
  white-space: pre-wrap;
  word-break: break-word;
}
.pipeline-log-line.is-error {
  color: var(--danger-fg);
  font-weight: 600;
}
.pipeline-log-line.is-warn {
  color: var(--attention-fg);
}
.filters {
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-muted);
}
.flt,
.search {
  background: var(--bg-base);
  color: var(--text-bright);
  border: 1px solid var(--border-default);
  border-radius: 5px;
  font-size: var(--font-2xs);
  padding: 3px 5px;
}
.flt {
  flex-shrink: 1;
  min-width: 0;
  max-width: 90px;
}
.search {
  flex: 1;
  min-width: 0;
}
.timeline {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 4px 0;
}
.row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 6px;
  align-items: baseline;
  padding: 3px 8px;
  font-size: var(--font-2xs);
  line-height: 1.45;
  cursor: pointer;
  border-left: 2px solid transparent;
}
.row:hover {
  background: var(--bg-subtle);
}
.row.open {
  background: var(--bg-subtle);
  border-left-color: var(--accent-focus);
}
.ts {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.icon {
  width: 16px;
  text-align: center;
}
.summary {
  color: var(--text-primary);
  word-break: break-word;
}
.detail {
  grid-column: 1 / -1;
  margin: 4px 0 2px;
  padding: 6px 8px;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 5px;
  color: var(--text-secondary);
  font-size: var(--font-3xs);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}
.msg {
  padding: 12px 8px;
  color: var(--text-muted);
  font-size: var(--font-xs);
}
.actions {
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px solid var(--border-muted);
}
.act {
  flex: 1;
  background: var(--bg-base);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 5px;
  font-size: var(--font-2xs);
  padding: 5px 6px;
  cursor: pointer;
}
.act:hover:not(:disabled) {
  background: var(--bg-subtle);
}
.act:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
