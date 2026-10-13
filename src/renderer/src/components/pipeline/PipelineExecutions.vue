<script setup lang="ts">
// Executions: every run of this pipeline in the workspace — including runs a
// CLI started through MCP — with the graph replayed in that run's final node
// states, and the live run's controls (next / abort / resume / restart, gate
// decisions) that used to live only in the sidebar.
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../../composables/useBackend'
import type { NodeRunState, PipelineGraph } from '../../lib/pipelineGraph'
import PipelineCanvas from './PipelineCanvas.vue'
import { formatElapsed, formatTokens, type RunSnapshot } from './pipelineEditorModel'
import { vTruncate } from '@navide/plugin-ui/foundation'

interface RunRecord {
  run_id: string
  task?: string
  started_at?: string
  ended_at?: string | null
  totals?: { input?: number; output?: number }
  pipeline_id?: string
  outcome?: 'completed' | 'aborted' | 'failed' | string
  node_states?: Record<string, NodeRunState>
}
interface TokensSnapshot {
  workspace_path?: string
  workspace?: { current_run?: RunRecord | null; runs?: RunRecord[] }
}

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  workspacePath: string
  pipelineId: string
  graph: PipelineGraph
  run: RunSnapshot
  roleLabels: Record<string, string>
  agentLabels: Record<string, string>
  now: number
}>()
const emit = defineEmits<{
  (e: 'control', action: 'next' | 'abort' | 'resume' | 'restart'): void
  (e: 'gate', nodeId: string, decision: 'approve' | 'reject', comment: string): void
  (e: 'select-node', id: string): void
}>()
const { t, d } = useI18n()

const current = ref<RunRecord | null>(null)
const past = ref<RunRecord[]>([])
const loading = ref(false)
const failed = ref(false)

function adopt(snap: TokensSnapshot | null | undefined): void {
  current.value = snap?.workspace?.current_run ?? null
  past.value = [...(snap?.workspace?.runs ?? [])].reverse()
}

async function load(): Promise<void> {
  if (!props.workspacePath) { adopt(null); return }
  loading.value = true
  failed.value = false
  try {
    const resp = await props.backend.send<TokensSnapshot>('tokens.snapshot', { workspace_path: props.workspacePath })
    if (resp.ok) adopt(resp.payload)
    else failed.value = true
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}
watch(() => props.workspacePath, () => { void load() }, { immediate: true })
const off = props.backend.on('tokens.changed', (raw) => {
  const snap = raw as TokensSnapshot
  if (snap?.workspace_path === props.workspacePath) adopt(snap)
})
onScopeDispose(() => off())

/** A record belongs here when it names this pipeline. Records written before
 *  runs carried a pipeline id cannot be attributed and are listed apart. */
const mine = (r: RunRecord): boolean => r.pipeline_id === props.pipelineId
/** Live is the run snapshot's word, not the token store's: a resumed run may
 *  have no token record yet, and its gate still needs answering. */
const isLive = computed(() => props.run.state === 'running' && props.run.pipelineId === props.pipelineId)
const LIVE_ID = '__live__'
const liveRun = computed<RunRecord | null>(() => {
  if (!isLive.value) return null
  const c = current.value
  if (c && (mine(c) || !c.pipeline_id)) return c
  return { run_id: LIVE_ID }
})
const runs = computed(() => past.value.filter(mine))
const unattributed = computed(() => past.value.filter((r) => !r.pipeline_id).length)

const selectedId = ref<string>('')
const selected = computed<RunRecord | null>(() => {
  if (liveRun.value && (!selectedId.value || selectedId.value === liveRun.value.run_id)) return liveRun.value
  return runs.value.find((r) => r.run_id === selectedId.value) ?? runs.value[0] ?? null
})
const isLiveSelected = computed(() => !!liveRun.value && selected.value === liveRun.value)
const replayNodes = computed<Record<string, NodeRunState>>(() =>
  isLiveSelected.value ? props.run.nodes : (selected.value?.node_states ?? {})
)

function outcomeOf(r: RunRecord): string {
  if (r === liveRun.value) return props.run.state === 'running' ? 'running' : (props.run.state || 'running')
  return r.outcome || (r.ended_at ? 'ended' : 'unknown')
}
function duration(r: RunRecord): string {
  if (!r.started_at) return ''
  const end = r.ended_at ? Date.parse(r.ended_at) : props.now
  return formatElapsed(end - Date.parse(r.started_at))
}
function tokensOf(r: RunRecord): string {
  return formatTokens((r.totals?.input ?? 0) + (r.totals?.output ?? 0))
}
function when(r: RunRecord): string {
  return r.started_at ? d(new Date(r.started_at), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
}

const progress = computed(() => {
  const ids = props.graph.nodes.filter((n) => n.kind !== 'trigger').map((n) => n.id)
  const done = ids.filter((id) => ['done', 'skipped'].includes(replayNodes.value[id]?.status ?? '')).length
  return { done, total: ids.length }
})
const awaitingGate = computed(() => (isLiveSelected.value ? props.run.gate : null))
const gateComment = ref('')
</script>

<template>
  <div class="px">
    <aside class="px-list" :aria-label="t('pipelineEditor.exec.list')">
      <header class="px-list-head">
        <h2>{{ t('pipelineEditor.exec.title') }}</h2>
        <button type="button" class="px-refresh" :disabled="loading" :aria-label="t('action.retry')" :title="t('action.retry')" @click="load">
          <svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" /></svg>
        </button>
      </header>
      <p v-if="failed" class="px-note">{{ t('pipelineEditor.exec.unreadable') }}</p>
      <ol class="px-runs">
        <li v-if="liveRun">
          <button type="button" class="px-run is-live" :class="{ 'is-selected': isLiveSelected }" @click="selectedId = liveRun.run_id">
            <span class="px-dot px-dot--running" aria-hidden="true"></span>
            <span class="px-run-main">
              <span class="px-run-title">{{ t('pipelineEditor.exec.live') }}</span>
              <span class="px-run-task" v-truncate>{{ liveRun.task || t('pipelineEditor.exec.no-task') }}</span>
            </span>
            <span class="px-run-meta"><span>{{ duration(liveRun) }}</span><span>{{ tokensOf(liveRun) }}</span></span>
          </button>
        </li>
        <li v-for="(r, i) in runs" :key="r.run_id">
          <button type="button" class="px-run" :class="{ 'is-selected': selected === r }" @click="selectedId = r.run_id">
            <span class="px-dot" :class="`px-dot--${outcomeOf(r)}`" aria-hidden="true"></span>
            <span class="px-run-main">
              <span class="px-run-title">
                {{ t('pipelineEditor.exec.run-n', { n: runs.length - i }) }}
                <span class="px-outcome">{{ t(`pipelineEditor.exec.outcome-${outcomeOf(r)}`) }}</span>
              </span>
              <span class="px-run-task" v-truncate>{{ r.task || t('pipelineEditor.exec.no-task') }}</span>
            </span>
            <span class="px-run-meta"><span>{{ when(r) }}</span><span>{{ duration(r) }}</span><span v-if="tokensOf(r)">{{ tokensOf(r) }}</span></span>
          </button>
        </li>
      </ol>
      <div v-if="!liveRun && !runs.length && !loading" class="px-empty">
        <p class="px-empty-title">{{ t('pipelineEditor.exec.empty-title') }}</p>
        <p>{{ t('pipelineEditor.exec.empty-body') }}</p>
      </div>
      <p v-if="unattributed" class="px-note">{{ t('pipelineEditor.exec.unattributed', { count: unattributed }) }}</p>
    </aside>

    <section class="px-stage">
      <div v-if="awaitingGate" class="px-gate" role="alert">
        <span class="px-gate-mark" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 1.8 14.2 8 8 14.2 1.8 8z" /></svg></span>
        <span class="px-gate-text">
          <strong>{{ t('pipelineEditor.gate.awaiting') }}</strong>
          <span>{{ graph.nodes.find((n) => n.id === awaitingGate)?.gate?.prompt || t('pipelineEditor.gate.default-prompt') }}</span>
        </span>
        <input v-model="gateComment" type="text" class="px-gate-input" :placeholder="t('pipelineEditor.gate.comment')" spellcheck="false" />
        <button type="button" class="px-btn px-btn--primary" @click="emit('gate', awaitingGate, 'approve', gateComment); gateComment = ''">{{ t('pipelineEditor.gate.approve') }}</button>
        <button type="button" class="px-btn" @click="emit('gate', awaitingGate, 'reject', gateComment); gateComment = ''">{{ t('pipelineEditor.gate.reject') }}</button>
      </div>

      <header v-if="selected" class="px-head">
        <span class="px-dot" :class="`px-dot--${outcomeOf(selected)}`" aria-hidden="true"></span>
        <span class="px-head-text">
          <strong v-truncate>{{ selected.task || t('pipelineEditor.exec.no-task') }}</strong>
          <span>{{ t(`pipelineEditor.exec.outcome-${outcomeOf(selected)}`) }} · {{ when(selected) }} · {{ duration(selected) }}</span>
        </span>
      </header>
      <div class="px-canvas">
        <PipelineCanvas
          v-if="selected" flow-id="pipeline-executions"
          :graph="graph" :role-labels="roleLabels" :agent-labels="agentLabels"
          :run-nodes="replayNodes" :now="now" :selected-id="null" :locked="true"
          @select="(id) => id && emit('select-node', id)"
        />
        <div v-else class="px-placeholder">
          <p>{{ t('pipelineEditor.exec.pick') }}</p>
        </div>
      </div>

      <footer class="px-bar">
        <span class="px-progress">
          <span class="px-meter" aria-hidden="true"><span :style="{ width: progress.total ? `${(progress.done / progress.total) * 100}%` : '0%' }"></span></span>
          {{ t('pipelineEditor.exec.progress', progress) }}
        </span>
        <span class="px-spacer"></span>
        <template v-if="isLiveSelected && run.state === 'running'">
          <button type="button" class="px-btn" @click="emit('control', 'next')">{{ t('pipelineEditor.exec.next') }}</button>
          <button type="button" class="px-btn px-btn--danger" @click="emit('control', 'abort')">{{ t('pipelineEditor.exec.abort') }}</button>
        </template>
        <template v-else-if="run.pipelineId === pipelineId && run.state !== 'running' && run.state !== 'idle'">
          <button type="button" class="px-btn" @click="emit('control', 'resume')">{{ t('pipelineEditor.exec.resume') }}</button>
          <button type="button" class="px-btn" @click="emit('control', 'restart')">{{ t('pipelineEditor.exec.restart') }}</button>
        </template>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.px { display: grid; grid-template-columns: 300px minmax(0, 1fr); height: 100%; min-height: 0; }
.px-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border-default);
  background: var(--bg-subtle);
}
.px-list-head { display: flex; align-items: center; padding: var(--space-4) var(--space-4) var(--space-2); }
.px-list-head h2 { flex: 1; margin: 0; font-size: var(--font-md); font-weight: 600; color: var(--text-primary); }
.px-refresh {
  display: grid;
  place-items: center;
  width: var(--icon-btn-sm);
  height: var(--icon-btn-sm);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.px-refresh svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.px-refresh:hover { background: var(--bg-hover); color: var(--text-primary); }
.px-refresh:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.px-runs { list-style: none; margin: 0; padding: 0 var(--space-2) var(--space-3); overflow-y: auto; flex: 1; min-height: 0; }
.px-run {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr);
  grid-template-areas: 'dot main' '. meta';
  gap: 2px var(--space-3);
  width: 100%;
  padding: var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.px-run:hover { background: var(--bg-hover); }
.px-run.is-selected {
  background: color-mix(in srgb, var(--accent-emphasis) 10%, transparent);
  box-shadow: inset 2px 0 0 var(--accent-emphasis);
}
.px-run:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: -2px; }
.px-dot { grid-area: dot; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; background: var(--border-strong); }
.px-dot--running { background: var(--accent-emphasis); animation: px-pulse 1.6s var(--ease-in-out) infinite; }
.px-dot--completed { background: var(--success-emphasis); }
.px-dot--aborted, .px-dot--failed { background: var(--danger-emphasis); }
.px-run-main { grid-area: main; display: grid; gap: 2px; min-width: 0; }
.px-run-title { display: flex; align-items: baseline; gap: var(--space-2); font-size: var(--font-sm); font-weight: 600; color: var(--text-primary); }
.px-outcome { font-size: var(--font-2xs); font-weight: 400; color: var(--text-muted); }
.px-run-task { font-size: var(--font-xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.px-run-meta { grid-area: meta; display: flex; gap: var(--space-3); font-size: var(--font-2xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
.px-note { margin: var(--space-2) var(--space-4); font-size: var(--font-2xs); line-height: var(--lh-base); color: var(--text-muted); }
.px-empty { padding: var(--space-6) var(--space-5); }
.px-empty p { margin: 0 0 var(--space-2); font-size: var(--font-xs); line-height: var(--lh-base); color: var(--text-muted); }
.px-empty .px-empty-title { font-size: var(--font-sm); font-weight: 600; color: var(--text-primary); }

.px-stage { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.px-canvas { flex: 1; min-height: 0; position: relative; }
.px-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-elevated);
}
.px-head .px-dot { margin-top: 7px; }
.px-head-text { display: grid; gap: 2px; min-width: 0; }
.px-head-text strong { font-size: var(--font-md); font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.px-head-text span { font-size: var(--font-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
.px-placeholder { display: grid; place-items: center; height: 100%; color: var(--text-muted); font-size: var(--font-sm); }
.px-gate {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--attention-subtle);
  border-bottom: 1px solid color-mix(in srgb, var(--attention-emphasis) 40%, transparent);
}
.px-gate-mark { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--attention-emphasis) 22%, transparent); color: var(--attention-fg); }
.px-gate-mark svg { width: 12px; height: 12px; fill: currentColor; }
.px-gate-text { display: grid; gap: 1px; min-width: 0; flex: 1; font-size: var(--font-xs); color: var(--text-secondary); }
.px-gate-text strong { font-size: var(--font-sm); color: var(--text-primary); }
.px-gate-input {
  width: 220px;
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-inset);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-xs);
}
.px-gate-input:focus { outline: none; border-color: var(--accent-emphasis); }

.px-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-default);
  background: var(--bg-elevated);
}
.px-progress { display: flex; align-items: center; gap: var(--space-3); font-size: var(--font-xs); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.px-meter { position: relative; width: 120px; height: 4px; border-radius: var(--radius-pill); background: var(--bg-muted); overflow: hidden; }
.px-meter span { position: absolute; inset: 0 auto 0 0; background: var(--success-emphasis); border-radius: inherit; transition: width var(--motion-slow) var(--ease-out); }
.px-spacer { flex: 1; }
.px-btn {
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
.px-btn:hover { background: var(--bg-hover); }
.px-btn:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.px-btn--primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.px-btn--primary:hover { background: var(--accent-bright); }
.px-btn--danger { color: var(--danger-fg); }
.px-btn--danger:hover { border-color: var(--danger-emphasis); background: var(--danger-subtle); }

@keyframes px-pulse { 50% { opacity: 0.4; } }
@media (prefers-reduced-motion: reduce) {
  .px-dot--running { animation: none; }
  .px-meter span { transition: none; }
}
</style>
