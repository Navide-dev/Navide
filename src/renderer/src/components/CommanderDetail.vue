<script setup lang="ts">
// A commander's detail page (0.2.51), opened from the sidebar tab or a pane
// header chip. It covers the main stage the way PipelineManagerModal covers the
// window, but measured from `.stage` so the sidebar and the right rail stay in
// view. Overview, duty and memory, bindings, the dispatch tree and the log.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { dispatchedNodes, useCommanders, type CommanderDetailData } from '../composables/useCommanders'
import { useDialogFocus } from '../composables/useDialogFocus'
import { COMMANDER_STATES, type CommanderTreeNode } from '../lib/commander'
import { commanderStateClass, formatCommanderTime, workspaceName } from '../lib/commanderView'

const props = defineProps<{
  agentLabel: (agentKey: string) => string
  /** pane id → its name, for "(dispatched by …)". */
  paneName?: (paneId: string) => string
}>()
const emit = defineEmits<{ (e: 'focus-pane', paneId: string): void }>()

const { t } = useI18n()
const store = useCommanders()

type Tab = 'overview' | 'duty' | 'bindings' | 'tree' | 'log'
const tab = ref<Tab>('overview')
const detail = ref<CommanderDetailData | null>(null)
const root = ref<HTMLElement | null>(null)

const open = computed(() => !!store.detailId.value)
/** The live summary wins over the detail snapshot: broadcasts update it. */
const commander = computed(() => store.byId(store.detailId.value) ?? detail.value?.commander ?? null)
const tree = computed(() => store.trees.value[store.detailId.value] ?? detail.value?.tree ?? null)
const nodes = computed(() => dispatchedNodes(tree.value))
const liveNodes = computed(() => nodes.value.filter((n) => !n.closed_at))
const memoryLines = computed(() => (detail.value?.memory ?? '').split('\n').filter((l) => l.trim()).length)

/** Two-step confirm for downgrade / archive: the first click arms it. */
const confirming = ref<'' | 'downgrade' | 'archive'>('')
// Unsaved edits on the duty tab.
const dutyDraft = ref<string | null>(null)
const stallDraft = ref<number | null>(null)
const saved = ref(false)

async function load(): Promise<void> {
  const id = store.detailId.value
  if (!id) return
  const answer = await store.getDetail(id)
  if (store.detailId.value === id) detail.value = answer
}

watch(() => store.detailId.value, (id, previous) => {
  if (id !== previous) {
    detail.value = null
    tab.value = 'overview'
    confirming.value = ''
    dutyDraft.value = null
    stallDraft.value = null
    saved.value = false
  }
  if (id) void load()
}, { immediate: true })

// ── Placement over the main stage ────────────────────────────────────────────
const box = ref<Record<string, string>>({})
function place(): void {
  const stage = document.querySelector('.stage')
  if (!stage) {
    box.value = {}
    return
  }
  const r = stage.getBoundingClientRect()
  box.value = {
    top: `${r.top}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  }
}
watch(open, (v) => { if (v) void nextTick(place) }, { immediate: true })
onMounted(() => window.addEventListener('resize', place))
onBeforeUnmount(() => window.removeEventListener('resize', place))

useDialogFocus(root)

function close(): void {
  store.detailId.value = ''
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

// ── Header ───────────────────────────────────────────────────────────────────
/** The commander's own chip: its most urgent dispatch, else whether it has a pane. */
const headState = computed(() => {
  for (const s of ['stalled', 'waiting', 'working'] as const) if (liveNodes.value.some((n) => n.state === s)) return s
  return commander.value?.body_live ? 'standby' : 'offline'
})
const headLabel = computed(() => {
  const s = headState.value
  return s === 'standby' || s === 'offline' ? t(`commander.detail.${s}`) : t(`commander.state.${s}`)
})
const headClass = computed(() => commanderStateClass(headState.value === 'standby' ? 'idle' : headState.value === 'offline' ? 'gone' : headState.value))
function openBody(): void {
  const pane = commander.value?.body?.pane_id
  if (pane && commander.value?.body_live) emit('focus-pane', pane)
}

async function act(kind: 'downgrade' | 'archive'): Promise<void> {
  const c = commander.value
  if (!c) return
  if (confirming.value !== kind) {
    confirming.value = kind
    return
  }
  confirming.value = ''
  const ok = kind === 'downgrade' ? await store.downgrade(c.id) : await store.archive(c.id)
  if (ok) close()
}

// ── Duty tab ─────────────────────────────────────────────────────────────────
const dutyValue = computed({
  get: () => dutyDraft.value ?? commander.value?.duty ?? '',
  set: (v: string) => { dutyDraft.value = v; saved.value = false },
})
const stallValue = computed({
  get: () => stallDraft.value ?? commander.value?.stall_minutes ?? 20,
  set: (v: number) => { stallDraft.value = v; saved.value = false },
})
async function saveDuty(): Promise<void> {
  const c = commander.value
  if (!c) return
  const changes: Record<string, unknown> = {}
  if (dutyDraft.value !== null && dutyDraft.value !== c.duty) changes.duty = dutyDraft.value
  if (stallDraft.value !== null && stallDraft.value !== c.stall_minutes) changes.stall_minutes = Number(stallDraft.value)
  if (!Object.keys(changes).length) return
  if (await store.update(c.id, changes)) {
    dutyDraft.value = null
    stallDraft.value = null
    saved.value = true
  }
}

// ── Tree tab ─────────────────────────────────────────────────────────────────
interface TreeRow { node: CommanderTreeNode; depth: number; parent: string }
const treeRows = computed(() => {
  const out: TreeRow[] = []
  const walk = (list: CommanderTreeNode[], depth: number, parent: string): void => {
    for (const node of list) {
      if (node.closed_at) continue
      out.push({ node, depth, parent })
      walk(node.children, depth + 1, node.name || node.pane_id)
    }
  }
  if (tree.value) walk(tree.value.root.children, 0, '')
  return out
})
const stalled = computed(() => liveNodes.value.filter((n) => n.state === 'stalled'))

const logRows = computed(() => [...nodes.value].sort((a, b) => b.opened_at - a.opened_at))

const counts = computed(() =>
  COMMANDER_STATES.filter((s) => s !== 'gone')
    .map((s) => ({ state: s, count: liveNodes.value.filter((n) => n.state === s).length }))
    .filter((x) => x.count > 0)
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && commander"
      ref="root"
      class="cmd-detail"
      :class="{ 'cmd-detail--full': !box.top }"
      :style="box"
      role="dialog"
      aria-modal="true"
      :aria-label="t('commander.detail.aria')"
      data-testid="commander-detail"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="cd-head">
        <span class="cd-icon" :style="{ background: commander.color || 'var(--accent-emphasis)' }" aria-hidden="true">{{ commander.icon || '◎' }}</span>
        <div class="cd-title">
          <div class="cd-name-row">
            <span class="cd-name" v-truncate>{{ commander.name }}</span>
            <span class="cmd-state-chip" :class="headClass" data-testid="commander-head-state">{{ headLabel }}</span>
          </div>
          <div class="cd-duty" v-truncate>
            {{ commander.duty ? t('commander.detail.duty-line', { duty: commander.duty }) : t('commander.detail.duty-none') }}<template v-if="commander.workspaces[0]"> · {{ t('commander.detail.workspace', { name: workspaceName(commander.workspaces[0]) }) }}</template>
          </div>
        </div>
        <div class="cd-actions">
          <button
            class="cd-btn"
            data-testid="commander-downgrade"
            :disabled="store.busy.value || !commander.body"
            :title="t('commander.detail.downgrade-hint')"
            @click="act('downgrade')"
          >{{ confirming === 'downgrade' ? t('commander.detail.confirm-again') : t('commander.detail.downgrade') }}</button>
          <button
            class="cd-btn"
            data-testid="commander-archive"
            :disabled="store.busy.value"
            :title="t('commander.detail.archive-hint')"
            @click="act('archive')"
          >{{ confirming === 'archive' ? t('commander.detail.confirm-again') : t('commander.detail.archive') }}</button>
          <button
            class="cd-btn cd-btn--primary"
            data-testid="commander-open-pane"
            :disabled="!commander.body_live"
            :title="commander.body_live ? '' : t('commander.detail.no-pane')"
            @click="openBody"
          >{{ t('commander.detail.open-pane') }}</button>
          <button class="cd-close" :title="t('commander.detail.close')" :aria-label="t('commander.detail.close')" @click="close">✕</button>
        </div>
      </header>
      <div v-if="store.opError.value" class="cd-error">{{ store.opError.value }}</div>

      <nav class="cd-tabs" role="tablist">
        <button v-for="name in (['overview', 'duty', 'bindings', 'tree', 'log'] as const)" :key="name"
                role="tab" :aria-selected="tab === name" :class="{ active: tab === name }" :data-tab="name" @click="tab = name">
          {{ name === 'overview' ? t('commander.detail.tab-overview')
            : name === 'duty' ? t('commander.detail.tab-duty')
              : name === 'bindings' ? t('commander.detail.tab-bindings', { count: commander.bindings.length })
                : name === 'tree' ? t('commander.detail.tab-tree', { count: treeRows.length })
                  : t('commander.detail.tab-log') }}
        </button>
      </nav>

      <div class="cd-body">
        <!-- Overview -->
        <div v-if="tab === 'overview'" class="cd-grid">
          <section class="cd-card">
            <h3>{{ t('commander.detail.identity') }}</h3>
            <dl class="cd-kv">
              <dt>{{ t('commander.detail.cli') }}</dt>
              <dd>{{ agentLabel(commander.agent_key) }} <span class="cd-pill">{{ t('commander.detail.model') }}：{{ commander.model || t('commander.detail.model-default') }}</span></dd>
              <dt>{{ t('commander.detail.account') }}</dt>
              <dd>{{ commander.account_id || t('commander.detail.account-default') }}</dd>
              <dt>{{ t('commander.detail.body') }}</dt>
              <dd>{{ commander.body && commander.body_live ? `${workspaceName(commander.body.workspace)} / ${paneName?.(commander.body.pane_id) || commander.body.pane_id}` : t('commander.detail.body-none') }}</dd>
              <dt>{{ t('commander.detail.skills') }}</dt>
              <dd><span v-for="s in commander.skills" :key="s" class="cd-pill">{{ s }}</span><span v-if="!commander.skills.length" class="cd-muted">{{ t('commander.detail.none') }}</span></dd>
              <dt>{{ t('commander.detail.mcp') }}</dt>
              <dd><span v-for="s in commander.mcp" :key="s" class="cd-pill">{{ s }}</span><span v-if="!commander.mcp.length" class="cd-muted">{{ t('commander.detail.none') }}</span></dd>
              <dt>{{ t('commander.detail.memory') }}</dt>
              <dd>{{ t('commander.detail.memory-size', { count: memoryLines }) }} <span class="cd-muted">{{ t('commander.detail.memory-note') }}</span></dd>
            </dl>
          </section>
          <div class="cd-col">
            <section class="cd-card">
              <h3>{{ t('commander.detail.bindings-title') }}</h3>
              <ul v-if="commander.bindings.length" class="cd-bindings">
                <li v-for="b in commander.bindings" :key="`${b.kind}:${b.ref_id}`">
                  <span class="cd-kind">{{ b.kind }}</span>
                  <span class="cd-binding-label" v-truncate>{{ b.label }}</span>
                  <span class="cd-binding-state" :class="{ paused: b.paused }">{{ b.paused ? t('commander.detail.binding-paused') : t('commander.detail.binding-active') }}</span>
                </li>
              </ul>
              <p v-else class="cd-muted">{{ t('commander.detail.bindings-empty') }}</p>
            </section>
            <section class="cd-card">
              <h3>{{ t('commander.detail.dispatch-title') }}</h3>
              <div v-if="counts.length" class="cd-chips">
                <span v-for="c in counts" :key="c.state" class="cmd-state-chip" :class="commanderStateClass(c.state)">{{ t(`commander.state.${c.state}`) }} {{ c.count }}</span>
              </div>
              <p v-else class="cd-muted">{{ t('commander.detail.dispatch-none') }}</p>
              <p class="cd-note">{{ t('commander.detail.dispatch-note', { minutes: commander.stall_minutes }) }}</p>
            </section>
          </div>
        </div>

        <!-- Duty and memory -->
        <div v-else-if="tab === 'duty'" class="cd-stack">
          <section class="cd-card">
            <label class="cd-label" for="cd-duty">{{ t('commander.detail.duty-label') }}</label>
            <textarea id="cd-duty" v-model="dutyValue" class="cd-textarea" rows="4" :placeholder="t('commander.detail.duty-placeholder')"></textarea>
            <div class="cd-row">
              <label class="cd-label" for="cd-stall">{{ t('commander.detail.stall-minutes') }}</label>
              <input id="cd-stall" v-model.number="stallValue" class="cd-input cd-input--num" type="number" min="1" />
              <button class="cd-btn cd-btn--primary" data-testid="commander-save-duty" :disabled="store.busy.value || (dutyDraft === null && stallDraft === null)" @click="saveDuty">{{ t('commander.detail.save') }}</button>
              <span v-if="saved" class="cd-muted">{{ t('commander.detail.saved') }}</span>
            </div>
          </section>
          <section class="cd-card">
            <h3>{{ t('commander.detail.memory-readonly') }}</h3>
            <pre v-if="detail?.memory" class="cd-memory">{{ detail.memory }}</pre>
            <p v-else class="cd-muted">{{ t('commander.detail.memory-empty') }}</p>
          </section>
        </div>

        <!-- Bindings -->
        <section v-else-if="tab === 'bindings'" class="cd-card">
          <h3>{{ t('commander.detail.bindings-title') }}</h3>
          <ul v-if="commander.bindings.length" class="cd-bindings">
            <li v-for="b in commander.bindings" :key="`${b.kind}:${b.ref_id}`">
              <span class="cd-kind">{{ b.kind }}</span>
              <span class="cd-binding-label" v-truncate>{{ b.label }}<span v-if="b.target" class="cd-muted"> · {{ b.target }}</span></span>
              <span class="cd-binding-state" :class="{ paused: b.paused }">{{ b.paused ? t('commander.detail.binding-paused') : t('commander.detail.binding-active') }}</span>
            </li>
          </ul>
          <p v-else class="cd-muted">{{ t('commander.detail.bindings-empty') }}</p>
        </section>

        <!-- Dispatch tree -->
        <div v-else-if="tab === 'tree'" class="cd-stack">
          <section class="cd-card">
            <div class="cd-tree-root">
              <span class="cd-icon cd-icon--sm" :style="{ background: commander.color || 'var(--accent-emphasis)' }" aria-hidden="true">{{ commander.icon || '◎' }}</span>
              <strong>{{ commander.name }}</strong>
              <span class="cmd-state-chip" :class="headClass" data-testid="commander-head-state">{{ headLabel }}</span>
            </div>
            <ul v-if="treeRows.length" class="cd-tree">
              <li v-for="{ node, depth, parent } in treeRows" :key="node.pane_id" :style="{ paddingLeft: 18 + depth * 18 + 'px' }" data-testid="commander-tree-row">
                <span class="cmd-dot" :class="commanderStateClass(node.state)" aria-hidden="true"></span>
                <span class="cd-tree-name" v-truncate :title="node.task">{{ node.name || node.pane_id }}<span v-if="depth && parent" class="cd-muted">{{ t('commander.detail.dispatched-by', { name: parent }) }}</span></span>
                <span class="cmd-state-chip cd-tree-chip" :class="commanderStateClass(node.state)">{{ t(`commander.state.${node.state}`) }}</span>
                <span class="cd-tree-task cd-muted" v-truncate>{{ node.task ? t('commander.detail.task', { task: node.task }) : '' }}</span>
                <button class="cd-btn" @click="emit('focus-pane', node.pane_id)">{{ t('commander.detail.go-pane') }}</button>
              </li>
            </ul>
            <p v-else class="cd-muted">{{ t('commander.detail.tree-empty') }}</p>
          </section>
          <div v-for="n in stalled" :key="`stall-${n.pane_id}`" class="cd-stall" data-testid="commander-stall">
            <span class="cmd-state-chip is-stalled">{{ t('commander.state.stalled') }}</span>
            <span class="cd-stall-text">{{ t('commander.detail.stall-banner', { name: n.name || n.pane_id, minutes: commander.stall_minutes }) }}</span>
            <button class="cd-btn cd-btn--primary" @click="emit('focus-pane', n.pane_id)">{{ t('commander.detail.go-pane') }}</button>
          </div>
        </div>

        <!-- Log -->
        <section v-else class="cd-card">
          <ul v-if="logRows.length" class="cd-log">
            <li v-for="n in logRows" :key="`log-${n.pane_id}-${n.opened_at}`">
              <span class="cmd-dot" :class="commanderStateClass(n.closed_at ? 'gone' : n.state)" aria-hidden="true"></span>
              <span class="cd-log-name" v-truncate>{{ n.name || n.pane_id }}</span>
              <span class="cd-muted">{{ t('commander.detail.log-opened', { time: formatCommanderTime(n.opened_at) }) }}</span>
              <span class="cd-muted">{{ n.closed_at ? t('commander.detail.log-closed', { time: formatCommanderTime(n.closed_at) }) : t('commander.detail.log-open') }}</span>
              <span class="cd-log-task cd-muted" v-truncate>{{ n.task }}</span>
            </li>
          </ul>
          <p v-else class="cd-muted">{{ t('commander.detail.log-empty') }}</p>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cmd-detail {
  position: fixed;
  z-index: calc(var(--z-modal) + 100);
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  -webkit-app-region: no-drag;
  outline: none;
  /* Teleported to <body>, outside the app root that sets the UI font. */
  font-family: var(--font-ui);
  color: var(--text-primary);
}
.cmd-detail--full { inset: var(--titlebar-height, 0px) 0 0 0; }
.cd-head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; padding: 18px 20px 12px; }
.cd-icon { width: 44px; height: 44px; border-radius: var(--radius-md); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--text-on-emphasis); font-size: var(--font-lg); }
.cd-icon--sm { width: 20px; height: 20px; font-size: var(--font-2xs); border-radius: var(--radius-xs); }
.cd-title { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.cd-name-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cd-name { font-size: var(--font-lg); font-weight: 700; color: var(--text-bright); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cd-duty { color: var(--text-secondary); font-size: var(--font-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cd-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-left: auto; }
.cd-btn { background: var(--bg-subtle); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: 5px 12px; font-size: var(--font-xs); cursor: pointer; white-space: nowrap; }
.cd-btn:hover:not(:disabled) { background: var(--bg-muted); }
.cd-btn:disabled { opacity: 0.5; cursor: default; }
.cd-btn--primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.cd-btn--primary:hover:not(:disabled) { background: var(--accent-emphasis); filter: brightness(1.08); }
.cd-close { background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: var(--font-md); padding: 2px 6px; }
.cd-error { color: var(--danger-fg); font-size: var(--font-xs); padding: 0 20px 6px; }
.cd-tabs { display: flex; gap: 4px; padding: 0 16px; border-bottom: 1px solid var(--border-muted); overflow-x: auto; }
.cd-tabs button { white-space: nowrap; flex-shrink: 0; background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-secondary); padding: 8px 12px; font-size: var(--font-sm); cursor: pointer; }
.cd-tabs button.active { color: var(--text-bright); border-bottom-color: var(--accent-fg); }
.cd-body { flex: 1; overflow: auto; padding: 16px 20px; min-height: 0; }
.cd-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
@media (max-width: 1100px) { .cd-grid { grid-template-columns: minmax(0, 1fr); } }
.cd-col, .cd-stack { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.cd-card { background: var(--bg-subtle); border: 1px solid var(--border-muted); border-radius: var(--radius-md); padding: 14px 16px; min-width: 0; }
.cd-card h3 { margin: 0 0 12px; font-size: var(--font-xs); font-weight: 600; color: var(--text-secondary); }
.cd-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px 24px; margin: 0; font-size: var(--font-xs); }
.cd-kv dt { color: var(--text-secondary); }
.cd-kv dd { margin: 0; color: var(--text-primary); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.cd-pill { border: 1px solid var(--border-default); border-radius: 999px; padding: 0 8px; font-size: var(--font-2xs); color: var(--text-secondary); line-height: 18px; }
.cd-muted { color: var(--text-muted); font-size: var(--font-2xs); }
.cd-note { color: var(--text-secondary); font-size: var(--font-2xs); margin: 10px 0 0; line-height: var(--lh-base); }
.cd-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.cd-bindings, .cd-tree, .cd-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.cd-bindings li { display: flex; align-items: center; gap: 10px; font-size: var(--font-xs); min-width: 0; }
.cd-kind { flex-shrink: 0; font-size: var(--font-2xs); color: var(--accent-fg); background: var(--accent-subtle); border-radius: var(--radius-xs); padding: 1px 8px; }
.cd-binding-label { flex: 1; min-width: 0; }
.cd-binding-state { flex-shrink: 0; font-size: var(--font-2xs); color: var(--success-fg); }
.cd-binding-state.paused { color: var(--text-muted); }
.cd-label { font-size: var(--font-xs); color: var(--text-secondary); display: block; margin-bottom: 6px; }
.cd-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.cd-row .cd-label { margin: 0; }
.cd-textarea, .cd-input { width: 100%; box-sizing: border-box; background: var(--bg-base); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: 6px 8px; font: inherit; font-size: var(--font-xs); }
.cd-input--num { width: 80px; }
.cd-memory { margin: 0; white-space: pre-wrap; font-size: var(--font-2xs); color: var(--text-primary); max-height: 360px; overflow: auto; }
.cd-tree-root { display: flex; align-items: center; gap: 8px; font-size: var(--font-sm); color: var(--text-bright); margin-bottom: 10px; }
.cd-tree li { display: grid; grid-template-columns: 8px minmax(0, 1.2fr) 120px minmax(0, 1.4fr) max-content; align-items: center; gap: 10px; font-size: var(--font-xs); }
.cd-tree-name, .cd-log-name { color: var(--text-primary); }
.cd-tree-chip { text-align: center; }
.cd-stall { display: flex; align-items: center; gap: 12px; border: 1px solid var(--danger-fg); background: var(--danger-subtle); border-radius: var(--radius-md); padding: 10px 14px; font-size: var(--font-xs); }
.cd-stall-text { flex: 1; color: var(--text-primary); }
.cd-log li { display: grid; grid-template-columns: 8px minmax(0, 1fr) max-content max-content minmax(0, 1.5fr); align-items: center; gap: 12px; font-size: var(--font-xs); }
</style>
