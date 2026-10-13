<script setup lang="ts">
// Node settings panel. For a step: what feeds it (upstream outputs), how it
// runs (CLI, role, kickoff prompt, and whatever fields its Role declares in
// `properties`), and — while a run is live — a read-only tail of its pane.
// For a layer: the stage metadata the engine reads (title, sentinel, …).
//
// Every field commits on change as one undoable graph command, so typing is
// cheap and the history holds "edit prompt", not one entry per keystroke.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../../composables/useBackend'
import type { Role } from '../../composables/useRoles'
import type { Stage, StageSlot } from '../../data/stages'
import {
  isPropertyVisible,
  upstreamOf,
  type GraphNode,
  type GraphOp,
  type PipelineGraph,
  type RoleProperty,
  type StageMetaPatch,
} from '../../lib/pipelineGraph'
import { elapsedOf, formatElapsed, formatTokens, nodeTitle, type RunSnapshot } from './pipelineEditorModel'

type ParamValue = string | number | boolean

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  graph: PipelineGraph
  /** The node being inspected, or null when a layer is. */
  node: GraphNode | null
  /** The stage behind the inspected layer (layer mode). */
  stage: Stage | null
  roles: Role[]
  agentOptions: Array<{ key: string; label: string }>
  run: RunSnapshot
  now: number
  locked: boolean
  workspacePath: string
}>()
const emit = defineEmits<{
  (e: 'edit', label: string, ops: GraphOp[]): void
  (e: 'stage-meta', stageId: string, patch: StageMetaPatch, previous: StageMetaPatch): void
  (e: 'remove', id: string): void
  (e: 'close'): void
  (e: 'open-pane', paneId: string): void
  (e: 'restart-from', nodeId: string): void
  (e: 'gate', nodeId: string, decision: 'approve' | 'reject', comment: string): void
}>()
const { t } = useI18n()

const tab = ref<'settings' | 'live' | 'output'>('settings')
const n = computed(() => props.node)
const runState = computed(() => (n.value ? props.run.nodes[n.value.id] : undefined))
const role = computed(() => props.roles.find((r) => r.key === n.value?.slot?.roleKey))
const roleProps = computed<RoleProperty[]>(() => role.value?.properties ?? [])
const params = computed<Record<string, ParamValue>>(() => n.value?.slot?.params ?? {})
const visibleProps = computed(() =>
  roleProps.value.filter((p) => isPropertyVisible(p, params.value, roleProps.value))
)
const upstream = computed(() => {
  if (!n.value) return []
  const ids = upstreamOf(props.graph, n.value.id)
  return ids.map((id) => props.graph.nodes.find((x) => x.id === id)!).filter((x) => x && x.kind !== 'trigger')
})
const glyph = computed(() => (role.value?.label || title.value).trim().charAt(0).toUpperCase() || '?')
const title = computed(() => {
  if (n.value) return nodeTitle(n.value)
  return props.stage?.shortTitle || props.stage?.title || ''
})
const kindLabel = computed(() => {
  if (!n.value) return t('pipelineEditor.inspector.layer')
  return t(`pipelineEditor.inspector.kind-${n.value.kind}`)
})

watch(() => n.value?.id, () => {
  if (tab.value !== 'settings' && !runState.value) tab.value = 'settings'
})

// ── Commits ──────────────────────────────────────────────────────────────────
function editSlot(field: keyof StageSlot, value: unknown, label: string): void {
  const node = n.value
  if (!node?.slot || props.locked) return
  if (node.slot[field] === value) return
  const ops: GraphOp[] = [{ op: 'update_node', id: node.id, slot: { [field]: value } as Partial<StageSlot> }]
  // The node label mirrors the slot label (a slot's identity), so keep both.
  if (field === 'label') ops[0] = { op: 'update_node', id: node.id, label: String(value), slot: { label: String(value) } }
  emit('edit', label, ops)
}
function editParam(name: string, value: ParamValue): void {
  const node = n.value
  if (!node?.slot || props.locked) return
  if (params.value[name] === value) return
  // params is replaced whole (contract: no deep merge), so send the full map.
  emit('edit', t('pipelineEditor.history.edit-field', { field: name }), [
    { op: 'update_node', id: node.id, slot: { params: { ...params.value, [name]: value } } },
  ])
}
function editGate(prompt: string): void {
  const node = n.value
  if (!node || node.kind !== 'gate' || props.locked) return
  if ((node.gate?.prompt ?? '') === prompt) return
  emit('edit', t('pipelineEditor.history.edit-gate'), [{ op: 'set_gate', id: node.id, prompt }])
}
function editLabel(label: string): void {
  const node = n.value
  if (!node || props.locked || !label.trim()) return
  if (node.kind === 'slot') editSlot('label', label.trim(), t('pipelineEditor.history.rename'))
  else if ((node.label ?? '') !== label.trim()) emit('edit', t('pipelineEditor.history.rename'), [{ op: 'update_node', id: node.id, label: label.trim() }])
}
function togglePin(): void {
  const node = n.value
  if (!node || node.kind !== 'slot' || props.locked) return
  emit('edit', t(node.pinned ? 'pipelineEditor.history.unpin' : 'pipelineEditor.history.pin'), [
    { op: 'set_pin', id: node.id, pinned: !node.pinned },
  ])
}

const STAGE_FIELDS = ['title', 'shortTitle', 'sentinel', 'allowQuestions', 'docQuery'] as const
function editStage(field: (typeof STAGE_FIELDS)[number], value: string | boolean): void {
  const s = props.stage
  if (!s || props.locked) return
  if (s[field] === value) return
  emit('stage-meta', s.id, { [field]: value } as StageMetaPatch, { [field]: s[field] } as StageMetaPatch)
}

const valueOf = (e: Event): string => (e.target as HTMLInputElement).value

// ── Prompt variables ─────────────────────────────────────────────────────────
const promptEl = ref<HTMLTextAreaElement | null>(null)
const PREV_SUMMARY = '{{prev.summary}}'
const VARIABLES = ['{{task}}', PREV_SUMMARY]
async function insertVariable(v: string): Promise<void> {
  const el = promptEl.value
  const node = n.value
  if (!el || !node?.slot || props.locked) return
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  const next = el.value.slice(0, start) + v + el.value.slice(end)
  editSlot('kickoffBody', next, t('pipelineEditor.history.edit-prompt'))
  await nextTick()
  el.focus()
  el.setSelectionRange(start + v.length, start + v.length)
}
/** Append a variable on its own line (the hand-off chip: the prompt need not
 *  be focused). */
function appendVariable(v: string): void {
  const node = n.value
  if (!node?.slot || props.locked) return
  const body = node.slot.kickoffBody
  editSlot('kickoffBody', body ? `${body.replace(/\s+$/, '')}\n${v}` : v, t('pipelineEditor.history.edit-prompt'))
}
function glyphOf(u: GraphNode): string {
  if (u.kind === 'gate') return '◆'
  const label = props.roles.find((r) => r.key === u.slot?.roleKey)?.label || nodeTitle(u)
  return label.trim().charAt(0).toUpperCase() || '?'
}
function onVarDragStart(e: DragEvent, v: string): void {
  e.dataTransfer?.setData('text/plain', v)
}

// ── Live view: a read-only tail of the node's pane transcript ────────────────
// Deliberately text, not an embedded xterm: every live terminal costs GPU
// memory (~187 MB floor per claude pane), and the transcript is already
// ANSI-stripped and width-safe. "Open pane" goes to the real terminal.
const liveText = ref('')
const liveError = ref('')
let liveTimer: number | null = null
const livePre = ref<HTMLElement | null>(null)

async function pollLive(): Promise<void> {
  const state = runState.value
  const node = n.value
  if (!state?.paneId || !node?.slot) return
  try {
    const resp = await props.backend.send<{ ok: boolean; text: string; total_chunks: number }>('terminal.history', {
      workspace_path: props.workspacePath,
      agent_key: node.slot.agentKey,
      pane_id: state.paneId,
      max_bytes: 24_000,
    })
    if (!resp.ok || !resp.payload?.ok) { liveError.value = t('pipelineEditor.inspector.live-unavailable'); return }
    liveError.value = ''
    const stick = livePre.value ? livePre.value.scrollHeight - livePre.value.scrollTop - livePre.value.clientHeight < 24 : true
    liveText.value = resp.payload.text.slice(-12_000)
    if (stick) { await nextTick(); livePre.value?.scrollTo({ top: livePre.value.scrollHeight }) }
  } catch {
    liveError.value = t('pipelineEditor.inspector.live-unavailable')
  }
}
function stopLive(): void {
  if (liveTimer !== null) { window.clearInterval(liveTimer); liveTimer = null }
}
watch(
  () => [tab.value, runState.value?.paneId, n.value?.id] as const,
  ([which, paneId]) => {
    stopLive()
    liveText.value = ''
    if (which !== 'live' || !paneId) return
    void pollLive()
    liveTimer = window.setInterval(() => { void pollLive() }, 2000)
  },
  { immediate: true }
)
onBeforeUnmount(stopLive)

const gateComment = ref('')
// Only a live run can take a decision: a run aborted at a gate keeps the gate
// recorded (resume waits on it again) but nothing is listening for an answer.
const isAwaitingGate = computed(() =>
  n.value?.kind === 'gate' && props.run.state === 'running' &&
  (runState.value?.status === 'awaiting' || props.run.gate === n.value?.id)
)

const elapsed = computed(() => formatElapsed(elapsedOf(runState.value, props.now)))
const tokens = computed(() => formatTokens(runState.value?.tokens))
</script>

<template>
  <aside class="pi" :aria-label="t('pipelineEditor.inspector.aria', { name: title })">
    <header class="pi-head">
      <!-- The same tile as the node card, so the panel reads as that node. -->
      <span v-if="n" class="pi-glyph" :class="`pi-glyph--${n.kind}`" aria-hidden="true">
        <svg v-if="n.kind === 'trigger'" viewBox="0 0 16 16"><path d="M5 3.5v9l7-4.5z" /></svg>
        <svg v-else-if="n.kind === 'gate'" viewBox="0 0 16 16"><path d="M8 1.8 14.2 8 8 14.2 1.8 8z" /></svg>
        <template v-else>{{ glyph }}</template>
      </span>
      <div class="pi-heading">
        <span class="pi-kind">
          {{ kindLabel }}
          <span v-if="runState" class="pi-status" :class="`is-${runState.status}`">
            <span class="pi-status-dot" aria-hidden="true"></span>{{ t(`pipelineEditor.status.${runState.status}`) }}
          </span>
        </span>
        <h2 class="pi-title">{{ title }}</h2>
      </div>
      <button type="button" class="pi-icon" :aria-label="t('action.close')" :title="t('action.close')" @click="emit('close')">
        <svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </header>

    <nav v-if="n && n.kind === 'slot'" class="pi-tabs" role="tablist">
      <button
        v-for="k in (['settings', 'live', 'output'] as const)" :key="k" type="button" role="tab"
        class="pi-tab" :class="{ 'is-active': tab === k }" :aria-selected="tab === k"
        @click="tab = k"
      >
        {{ t(`pipelineEditor.inspector.tab-${k}`) }}
        <span v-if="k === 'live' && runState?.status === 'running'" class="pi-live-dot" aria-hidden="true"></span>
      </button>
    </nav>

    <!-- A gate waiting on you leads with the decision; the read-only note
         would otherwise push the one actionable thing down. -->
    <p v-if="locked && !isAwaitingGate" class="pi-lock">{{ t('pipelineEditor.inspector.locked') }}</p>

    <div class="pi-body">
      <!-- ── Layer (stage) settings ─────────────────────────────────────── -->
      <template v-if="!n && stage">
        <label class="pi-field">
          <span class="pi-label">{{ t('label.title') }}</span>
          <input :value="stage.title" type="text" spellcheck="false" :disabled="locked" @change="editStage('title', valueOf($event))" />
        </label>
        <label class="pi-field">
          <span class="pi-label">{{ t('label.short-title') }}</span>
          <input :value="stage.shortTitle" type="text" spellcheck="false" :disabled="locked" @change="editStage('shortTitle', valueOf($event))" />
        </label>
        <label class="pi-field">
          <span class="pi-label">{{ t('label.sentinel') }}</span>
          <input :value="stage.sentinel" type="text" spellcheck="false" placeholder="---DONE---" :disabled="locked" @change="editStage('sentinel', valueOf($event))" />
          <span class="pi-help">{{ t('pipelineEditor.inspector.sentinel-help') }}</span>
        </label>
        <label class="pi-switch">
          <input type="checkbox" :checked="!!stage.allowQuestions" :disabled="locked" @change="editStage('allowQuestions', ($event.target as HTMLInputElement).checked)" />
          <span class="pi-switch-track" aria-hidden="true"></span>
          <span>{{ t('hint.pause-for-user-answers') }}</span>
        </label>
        <label class="pi-field">
          <span class="pi-label">{{ t('label.context7-doc-query') }}</span>
          <input :value="stage.docQuery ?? ''" type="text" spellcheck="false" :placeholder="t('label.doc-query-placeholder')" :disabled="locked" @change="editStage('docQuery', valueOf($event))" />
        </label>
      </template>

      <!-- ── Trigger ────────────────────────────────────────────────────── -->
      <template v-else-if="n?.kind === 'trigger'">
        <p class="pi-prose">{{ t('pipelineEditor.inspector.trigger-help') }}</p>
      </template>

      <!-- ── Gate ───────────────────────────────────────────────────────── -->
      <template v-else-if="n?.kind === 'gate'">
        <section v-if="isAwaitingGate" class="pi-decision">
          <h3>{{ t('pipelineEditor.gate.awaiting') }}</h3>
          <p>{{ n.gate?.prompt || t('pipelineEditor.gate.default-prompt') }}</p>
          <textarea v-model="gateComment" rows="2" :placeholder="t('pipelineEditor.gate.comment')" spellcheck="false"></textarea>
          <div class="pi-row">
            <button type="button" class="pi-btn pi-btn--primary" @click="emit('gate', n.id, 'approve', gateComment); gateComment = ''">{{ t('pipelineEditor.gate.approve') }}</button>
            <button type="button" class="pi-btn" @click="emit('gate', n.id, 'reject', gateComment); gateComment = ''">{{ t('pipelineEditor.gate.reject') }}</button>
          </div>
        </section>
        <label class="pi-field">
          <span class="pi-label">{{ t('label.label') }}</span>
          <input :value="n.label ?? ''" type="text" spellcheck="false" :disabled="locked" @change="editLabel(valueOf($event))" />
        </label>
        <label class="pi-field">
          <span class="pi-label">{{ t('pipelineEditor.inspector.gate-prompt') }}</span>
          <textarea :value="n.gate?.prompt ?? ''" rows="3" spellcheck="false" :placeholder="t('pipelineEditor.gate.default-prompt')" :disabled="locked" @change="editGate(valueOf($event))"></textarea>
          <span class="pi-help">{{ t('pipelineEditor.inspector.gate-help') }}</span>
        </label>
      </template>

      <!-- ── Slot: settings ─────────────────────────────────────────────── -->
      <template v-else-if="n?.kind === 'slot' && n.slot && tab === 'settings'">
        <section v-if="upstream.length" class="pi-inputs" :aria-label="t('pipelineEditor.inspector.inputs')">
          <h3 class="pi-section">{{ t('pipelineEditor.inspector.inputs') }}</h3>
          <ul>
            <li v-for="u in upstream" :key="u.id" class="pi-input">
              <span class="pi-input-glyph" aria-hidden="true">{{ glyphOf(u) }}</span>
              <span class="pi-input-name">{{ nodeTitle(u) }}</span>
              <span class="pi-input-state" :class="`is-${run.nodes[u.id]?.status ?? 'idle'}`">
                {{ run.nodes[u.id] ? t(`pipelineEditor.status.${run.nodes[u.id].status}`) : t('pipelineEditor.inspector.not-run') }}
              </span>
              <p v-if="run.nodes[u.id]?.summary" class="pi-input-summary">{{ run.nodes[u.id].summary }}</p>
            </li>
          </ul>
          <!-- Where that output goes: into this step's prompt, one click away. -->
          <p class="pi-handoff">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2.5v6.5a2 2 0 0 0 2 2h5.5M10 8.5l2.5 2.5L10 13.5" /></svg>
            <span>{{ t('pipelineEditor.inspector.handoff') }}</span>
            <button type="button" class="pi-var pi-handoff-chip" :disabled="locked" @click="appendVariable(PREV_SUMMARY)" v-text="PREV_SUMMARY"></button>
          </p>
        </section>

        <label class="pi-field">
          <span class="pi-label">{{ t('label.label') }}</span>
          <input :value="n.slot.label" type="text" spellcheck="false" :disabled="locked" @change="editLabel(valueOf($event))" />
        </label>
        <div class="pi-grid">
          <label class="pi-field">
            <span class="pi-label">{{ t('label.agent') }}</span>
            <select :value="n.slot.agentKey" :disabled="locked" @change="editSlot('agentKey', valueOf($event), t('pipelineEditor.history.edit-cli'))">
              <option v-for="a in agentOptions" :key="a.key" :value="a.key">{{ a.label }}</option>
            </select>
          </label>
          <label class="pi-field">
            <span class="pi-label">{{ t('pipelineEditor.inspector.role') }}</span>
            <select :value="n.slot.roleKey" :disabled="locked" @change="editSlot('roleKey', valueOf($event), t('pipelineEditor.history.edit-role'))">
              <option value="">{{ t('label.unassigned') }}</option>
              <option v-for="r in roles" :key="r.key" :value="r.key">{{ r.label }}</option>
            </select>
          </label>
        </div>

        <div class="pi-field">
          <label class="pi-label" for="pi-prompt">{{ t('label.kickoff-body') }}</label>
          <textarea
            id="pi-prompt" ref="promptEl" :value="n.slot.kickoffBody" rows="7" spellcheck="false" class="pi-mono"
            :disabled="locked" @change="editSlot('kickoffBody', valueOf($event), t('pipelineEditor.history.edit-prompt'))"
          ></textarea>
          <span class="pi-vars">
            <span class="pi-help">{{ t('pipelineEditor.inspector.variables') }}</span>
            <button
              v-for="v in VARIABLES" :key="v" type="button" class="pi-var" draggable="true" :disabled="locked"
              @dragstart="onVarDragStart($event, v)" @click="insertVariable(v)"
            >{{ v }}</button>
          </span>
        </div>

        <label class="pi-switch">
          <input type="checkbox" :checked="!!n.slot.isCommander" :disabled="locked" @change="editSlot('isCommander', ($event.target as HTMLInputElement).checked, t('pipelineEditor.history.edit-manager'))" />
          <span class="pi-switch-track" aria-hidden="true"></span>
          <span><strong>{{ t('label.designate-global-manager') }}</strong> {{ t('hint.global-manager-desc-short') }}</span>
        </label>

        <!-- Fields the Role declares; shown/hidden by displayOptions. -->
        <section v-if="roleProps.length" class="pi-props">
          <h3 class="pi-section">{{ t('pipelineEditor.inspector.role-fields', { role: role?.label ?? '' }) }}</h3>
          <template v-for="p in visibleProps" :key="p.name">
            <label v-if="p.type === 'boolean'" class="pi-switch">
              <input type="checkbox" :checked="!!(params[p.name] ?? p.default)" :disabled="locked" @change="editParam(p.name, ($event.target as HTMLInputElement).checked)" />
              <span class="pi-switch-track" aria-hidden="true"></span>
              <span>{{ p.label || p.name }}</span>
            </label>
            <div v-else-if="p.type === 'options' && (p.options?.length ?? 0) <= 4" class="pi-field">
              <span class="pi-label">{{ p.label || p.name }}</span>
              <span class="pi-seg" role="radiogroup" :aria-label="p.label || p.name">
                <button
                  v-for="o in p.options" :key="String(o.value)" type="button" role="radio"
                  class="pi-seg-btn" :class="{ 'is-on': (params[p.name] ?? p.default) === o.value }"
                  :aria-checked="(params[p.name] ?? p.default) === o.value" :disabled="locked"
                  @click="editParam(p.name, o.value)"
                >{{ o.label ?? String(o.value) }}</button>
              </span>
              <span v-if="p.description" class="pi-help">{{ p.description }}</span>
            </div>
            <label v-else class="pi-field">
              <span class="pi-label">{{ p.label || p.name }}<span v-if="p.required" class="pi-req" :title="t('pipelineEditor.inspector.required')">*</span></span>
              <select v-if="p.type === 'options'" :value="params[p.name] ?? p.default" :disabled="locked" @change="editParam(p.name, valueOf($event))">
                <option v-for="o in p.options" :key="String(o.value)" :value="o.value">{{ o.label ?? String(o.value) }}</option>
              </select>
              <input
                v-else-if="p.type === 'number'" type="number" :value="params[p.name] ?? p.default" :disabled="locked"
                @change="editParam(p.name, Number(valueOf($event)))"
              />
              <textarea
                v-else-if="p.type === 'text' || p.type === 'template'" rows="3" spellcheck="false"
                :class="{ 'pi-mono': p.type === 'template' }" :value="String(params[p.name] ?? p.default ?? '')" :disabled="locked"
                @change="editParam(p.name, valueOf($event))"
              ></textarea>
              <input v-else type="text" spellcheck="false" :value="String(params[p.name] ?? p.default ?? '')" :disabled="locked" @change="editParam(p.name, valueOf($event))" />
              <span v-if="p.description" class="pi-help">{{ p.description }}</span>
            </label>
          </template>
        </section>
        <p v-else-if="n.slot.roleKey" class="pi-help pi-help--block">{{ t('pipelineEditor.inspector.no-role-fields') }}</p>
      </template>

      <!-- ── Slot: live view ────────────────────────────────────────────── -->
      <template v-else-if="n?.kind === 'slot' && tab === 'live'">
        <div v-if="!runState?.paneId" class="pi-empty">
          <p>{{ t('pipelineEditor.inspector.live-empty') }}</p>
        </div>
        <template v-else>
          <pre ref="livePre" class="pi-live" aria-live="off">{{ liveText || '…' }}</pre>
          <p v-if="liveError" class="pi-help">{{ liveError }}</p>
          <div class="pi-row">
            <button type="button" class="pi-btn" @click="emit('open-pane', runState.paneId!)">{{ t('pipelineEditor.inspector.open-pane') }}</button>
          </div>
        </template>
      </template>

      <!-- ── Slot: output ───────────────────────────────────────────────── -->
      <template v-else-if="n?.kind === 'slot' && tab === 'output'">
        <dl v-if="runState" class="pi-stats">
          <div><dt>{{ t('pipelineEditor.inspector.status') }}</dt><dd>{{ t(`pipelineEditor.status.${runState.status}`) }}</dd></div>
          <div v-if="elapsed"><dt>{{ t('pipelineEditor.inspector.elapsed') }}</dt><dd>{{ elapsed }}</dd></div>
          <div v-if="tokens"><dt>{{ t('pipelineEditor.inspector.tokens') }}</dt><dd>{{ tokens }}</dd></div>
          <div v-if="(runState.attempts ?? 0) > 1"><dt>{{ t('pipelineEditor.inspector.attempts') }}</dt><dd>{{ runState.attempts }}</dd></div>
        </dl>
        <p v-if="runState?.summary" class="pi-summary">{{ runState.summary }}</p>
        <div v-else class="pi-empty"><p>{{ t('pipelineEditor.inspector.output-empty') }}</p></div>
      </template>
    </div>

    <footer v-if="n && n.kind !== 'trigger'" class="pi-foot">
      <button
        v-if="n.kind === 'slot'" type="button" class="pi-btn" :class="{ 'is-on': n.pinned }" :disabled="locked"
        :aria-pressed="!!n.pinned" :title="t('pipelineEditor.inspector.pin-help')" @click="togglePin"
      >{{ n.pinned ? t('pipelineEditor.inspector.unpin') : t('pipelineEditor.inspector.pin') }}</button>
      <button
        v-if="n.kind === 'slot' && run.state !== 'running' && run.pipelineId" type="button" class="pi-btn"
        :title="t('pipelineEditor.inspector.restart-help')" @click="emit('restart-from', n.id)"
      >{{ t('pipelineEditor.inspector.restart-from') }}</button>
      <span class="pi-spacer"></span>
      <button type="button" class="pi-btn pi-btn--danger" :disabled="locked" @click="emit('remove', n.id)">{{ t('action.delete') }}</button>
    </footer>
  </aside>
</template>

<style scoped>
.pi {
  display: flex;
  flex-direction: column;
  width: 380px;
  height: 100%;
  min-height: 0;
  background: var(--bg-elevated);
  border-left: 1px solid var(--border-default);
  box-sizing: border-box;
}
.pi-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-4) var(--space-3);
}
.pi-heading { flex: 1; min-width: 0; display: grid; gap: 2px; }
.pi-kind { display: flex; align-items: center; gap: var(--space-2); font-size: var(--font-xs); color: var(--text-muted); }
.pi-glyph {
  display: grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-md);
  font-weight: 600;
}
.pi-glyph svg { width: 16px; height: 16px; fill: currentColor; }
.pi-glyph--trigger { background: color-mix(in srgb, var(--success-emphasis) 16%, transparent); color: var(--success-fg); }
.pi-glyph--gate { background: color-mix(in srgb, var(--attention-emphasis) 18%, transparent); color: var(--attention-fg); }
.pi-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--bg-muted);
  color: var(--text-secondary);
  line-height: 18px;
}
.pi-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border-strong); }
.pi-status.is-running .pi-status-dot { background: var(--accent-emphasis); }
.pi-status.is-done .pi-status-dot, .pi-status.is-skipped .pi-status-dot { background: var(--success-emphasis); }
.pi-status.is-awaiting { background: var(--attention-subtle); color: var(--attention-fg); }
.pi-status.is-awaiting .pi-status-dot { background: var(--attention-emphasis); }
.pi-status.is-failed .pi-status-dot, .pi-status.is-rejected .pi-status-dot, .pi-status.is-aborted .pi-status-dot { background: var(--danger-emphasis); }
.pi-title {
  margin: 0;
  font-size: var(--font-lg);
  font-weight: 600;
  line-height: var(--lh-tight);
  color: var(--text-bright);
  overflow-wrap: anywhere;
}
.pi-icon {
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
.pi-icon svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; fill: none; }
.pi-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
.pi-icon:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }

.pi-tabs { display: flex; gap: var(--space-4); padding: 0 var(--space-4); border-bottom: 1px solid var(--border-muted); }
.pi-tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) 0;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--font-sm);
  cursor: pointer;
}
.pi-tab::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: var(--radius-pill);
  background: var(--accent-emphasis);
  transform: scaleX(0);
  transition: transform var(--motion-base) var(--ease-out);
}
.pi-tab.is-active { color: var(--text-primary); }
.pi-tab.is-active::after { transform: scaleX(1); }
.pi-tab:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 2px; border-radius: var(--radius-xs); }
.pi-live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-emphasis); }

.pi-lock {
  margin: var(--space-3) var(--space-4) 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--attention-subtle);
  color: var(--attention-fg);
  font-size: var(--font-xs);
}

.pi-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
}
.pi-section { margin: 0 0 var(--space-2); font-size: var(--font-xs); font-weight: 600; color: var(--text-secondary); }
.pi-field { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.pi-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); }
.pi-label { font-size: var(--font-xs); font-weight: 500; color: var(--text-secondary); }
.pi-req { color: var(--danger-fg); margin-left: 2px; }
.pi-help { font-size: var(--font-2xs); line-height: var(--lh-base); color: var(--text-muted); }
.pi-help--block { margin: 0; }
.pi-prose { margin: 0; font-size: var(--font-sm); line-height: var(--lh-loose); color: var(--text-secondary); }
.pi input[type='text'],
.pi input[type='number'],
.pi select,
.pi textarea {
  width: 100%;
  box-sizing: border-box;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-inset);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-sm);
  transition: border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
}
.pi input[type='text'], .pi input[type='number'], .pi select { height: var(--control-h-md); padding-top: 0; padding-bottom: 0; }
.pi textarea { resize: vertical; line-height: var(--lh-base); }
.pi .pi-mono { font-family: var(--font-mono); font-size: var(--font-xs); }
.pi input:focus, .pi select:focus, .pi textarea:focus {
  outline: none;
  border-color: var(--accent-emphasis);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-emphasis) 18%, transparent);
}
.pi input:disabled, .pi select:disabled, .pi textarea:disabled { opacity: 0.6; cursor: not-allowed; }

.pi-vars { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); margin-top: var(--space-1); }
.pi-var {
  padding: 1px var(--space-2);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-pill);
  background: var(--bg-muted);
  color: var(--accent-fg);
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
  cursor: grab;
}
.pi-var:hover:not(:disabled) { border-color: var(--accent-emphasis); }
.pi-var:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }

/* Switch built on a real checkbox, so keyboard and screen readers get the
   native control. */
.pi-switch {
  position: relative;
  display: grid;
  grid-template-columns: 30px 1fr;
  align-items: start;
  gap: var(--space-3);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
  color: var(--text-secondary);
  cursor: pointer;
}
.pi-switch input { position: absolute; opacity: 0; width: 30px; height: 18px; margin: 0; cursor: pointer; }
.pi-switch-track {
  position: relative;
  width: 30px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  box-sizing: border-box;
  transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}
.pi-switch-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: transform var(--motion-base) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.pi-switch input:checked + .pi-switch-track { background: var(--accent-emphasis); border-color: var(--accent-emphasis); }
.pi-switch input:checked + .pi-switch-track::after { transform: translateX(12px); background: var(--text-on-emphasis); }
.pi-switch input:focus-visible + .pi-switch-track { outline: 2px solid var(--accent-focus); outline-offset: 2px; }
.pi-switch strong { color: var(--text-primary); font-weight: 600; }

.pi-seg { display: inline-flex; padding: 2px; border-radius: var(--radius-control); background: var(--bg-inset); border: 1px solid var(--border-default); align-self: flex-start; }
.pi-seg-btn {
  padding: 3px var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-xs);
  cursor: pointer;
}
.pi-seg-btn.is-on { background: var(--bg-elevated); color: var(--text-primary); box-shadow: var(--shadow-popover); }
.pi-seg-btn:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }

.pi-inputs ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.pi-input {
  display: grid;
  grid-template-columns: 22px 1fr auto;
  align-items: center;
  gap: 2px var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
}
.pi-input-name { font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); }
.pi-input-state { font-size: var(--font-2xs); color: var(--text-muted); }
.pi-input-state.is-done { color: var(--success-fg); }
.pi-input-state.is-running { color: var(--accent-fg); }
.pi-input-glyph {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
  font-weight: 600;
}
.pi-handoff {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2) 0 0;
  padding-left: 6px;
  font-size: var(--font-2xs);
  color: var(--text-muted);
}
.pi-handoff svg { flex: none; width: 14px; height: 14px; fill: none; stroke: var(--border-strong); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.pi-input-summary { grid-column: 2 / -1; margin: 0; font-size: var(--font-2xs); line-height: var(--lh-base); color: var(--text-secondary); }
.pi-props { display: flex; flex-direction: column; gap: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--border-muted); }

.pi-decision {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--attention-emphasis) 50%, transparent);
  background: var(--attention-subtle);
}
.pi-decision h3 { margin: 0; font-size: var(--font-sm); color: var(--attention-fg); }
.pi-decision p { margin: 0; font-size: var(--font-xs); color: var(--text-primary); }

.pi-live {
  flex: 1;
  min-height: 240px;
  margin: 0;
  padding: var(--space-3);
  overflow: auto;
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
  line-height: var(--lh-base);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pi-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--space-3); margin: 0; }
.pi-stats div { display: grid; gap: 2px; }
.pi-stats dt { font-size: var(--font-2xs); color: var(--text-muted); }
.pi-stats dd { margin: 0; font-size: var(--font-md); font-variant-numeric: tabular-nums; color: var(--text-primary); }
.pi-summary { margin: 0; font-size: var(--font-sm); line-height: var(--lh-loose); color: var(--text-primary); white-space: pre-wrap; }
.pi-empty { display: grid; place-items: center; min-height: 160px; text-align: center; }
.pi-empty p { margin: 0; max-width: 260px; font-size: var(--font-xs); line-height: var(--lh-base); color: var(--text-muted); }

.pi-foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-muted);
}
.pi-row { display: flex; gap: var(--space-2); }
.pi-spacer { flex: 1; }
.pi-btn {
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-xs);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}
.pi-btn:hover:not(:disabled) { background: var(--bg-hover); }
.pi-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.pi-btn:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.pi-btn.is-on { border-color: var(--done-emphasis); color: var(--done-fg); }
.pi-btn--primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.pi-btn--primary:hover:not(:disabled) { background: var(--accent-bright); }
.pi-btn--danger { color: var(--danger-fg); }
.pi-btn--danger:hover:not(:disabled) { border-color: var(--danger-emphasis); background: var(--danger-subtle); }

@media (prefers-reduced-motion: reduce) {
  .pi-tab::after, .pi-switch-track, .pi-switch-track::after, .pi-btn, .pi input, .pi select, .pi textarea { transition: none; }
}
</style>
