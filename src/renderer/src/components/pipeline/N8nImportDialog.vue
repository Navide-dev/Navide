<script setup lang="ts">
// Import an n8n workflow export as a new pipeline. The backend converts it
// (pipelines.import_n8n); a dry run first shows everything the import would
// create — the graph, how each n8n node was converted, the exact text every
// pane and gate will show, and which credentials and secrets were left
// behind — so nothing reaches a pane the user has not seen. Steps that need
// review are disclosed, never a reason to refuse the import.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import type { useBackend } from '../../composables/useBackend'
import type { GraphNode, PipelineGraph } from '../../lib/pipelineGraph'
import { backendErrorText, type BackendErrorLike } from '../../lib/pipelineErrors'
import { useDialogFocus } from '../../composables/useDialogFocus'
import PipelineCanvas from './PipelineCanvas.vue'

type Category = 'native' | 'agent' | 'pending' | 'unsupported'

interface ReportNode {
  name: string
  type: string
  typeVersion: number | string
  category: Category
  result: 'trigger' | 'slot' | 'gate' | 'folded' | 'removed'
  node: string | null
  reason: string
  detail: string
  needsReview: boolean
  actions: string[]
}
interface ImportReport {
  workflow: string
  nodes: ReportNode[]
  stats: {
    nodes: number
    slots: number
    gates: number
    triggers: number
    byCategory: Record<Category, number>
    needsReview: number
  }
  slots: Array<{ id: string; label: string; agentKey: string; kickoffBody: string }>
  gates: Array<{ id: string; label: string; prompt: string }>
  nodeCategories: Record<string, Category>
  secretsRemoved: Array<{ node: string | null; field: string }>
  credentials?: Credential[]
  warnings: string[]
}
interface Credential { type: string; name: string; nodes: string[] }
interface ImportPayload {
  dry_run: boolean
  graph: PipelineGraph
  report: ImportReport
  credentials?: Credential[]
  pipeline?: { id: string }
}

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  open: boolean
  workspacePath: string
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'imported', pipelineId: string): void
}>()
const { t, te } = useI18n()

const TIMEOUT_MS = 30_000
const CATEGORIES: Category[] = ['native', 'agent', 'pending', 'unsupported']
const agentOptions = CLI_AGENT_SPECS.map((s) => ({ key: s.agentKey, label: s.label }))
const agentLabels = Object.fromEntries(agentOptions.map((a) => [a.key, a.label]))

const jsonText = ref('')
const agent = ref('claude')
const busy = ref<'preview' | 'import' | 'file' | null>(null)
const error = ref<{ text: string; detail: string } | null>(null)
const preview = ref<ImportPayload | null>(null)
/** The text the current preview was made from: Import sends exactly that. */
const previewedText = ref('')

const report = computed(() => preview.value?.report ?? null)
const credentials = computed(() => preview.value?.credentials ?? report.value?.credentials ?? [])
const stale = computed(() => !!preview.value && previewedText.value !== jsonText.value)
const canImport = computed(() => !!preview.value && !stale.value && !busy.value)
/** Why Import is disabled, for its tooltip ('' when it is not, or busy). */
const importBlocked = computed(() =>
  !preview.value ? t('pipelineImport.import-blocked-preview') : stale.value ? t('pipelineImport.preview-stale') : ''
)
const needsSubworkflow = computed(
  () => !!report.value?.nodes.some((n) => n.actions.includes('paste-subworkflow'))
)
const graphLabels = computed(
  () => new Map((preview.value?.graph.nodes ?? []).map((n) => [n.id, n.label]))
)

function reset(): void {
  jsonText.value = ''
  busy.value = null
  error.value = null
  preview.value = null
  previewedText.value = ''
}
watch(() => props.open, (open) => { if (!open) reset() })

function showError(err: BackendErrorLike | null | undefined, fallbackKey: string): void {
  const text = backendErrorText(t, err, fallbackKey)
  // The translated N8N_INVALID sentence is generic; the backend's says what
  // exactly is wrong with this file.
  const detail = err?.code === 'N8N_INVALID' && err.message && err.message !== text ? err.message : ''
  error.value = { text, detail }
}

async function run(dryRun: boolean): Promise<ImportPayload | null> {
  const fallbackKey = dryRun ? 'pipelineImport.error.preview-failed' : 'pipelineImport.error.import-failed'
  const text = jsonText.value
  busy.value = dryRun ? 'preview' : 'import'
  error.value = null
  try {
    const resp = await props.backend.send<ImportPayload>(
      'pipelines.import_n8n',
      { json: text, dry_run: dryRun, default_agent: agent.value, workspace_path: props.workspacePath },
      TIMEOUT_MS
    )
    if (!resp.ok || !resp.payload) {
      showError(resp.error, fallbackKey)
      return null
    }
    if (dryRun) {
      preview.value = resp.payload
      previewedText.value = text
    }
    return resp.payload
  } catch (err) {
    error.value = { text: t(fallbackKey), detail: err instanceof Error ? err.message : String(err) }
    return null
  } finally {
    busy.value = null
  }
}

async function runPreview(): Promise<void> {
  if (!jsonText.value.trim()) return
  const ok = await run(true)
  if (!ok) preview.value = null
}

async function runImport(): Promise<void> {
  if (!canImport.value) return
  const payload = await run(false)
  const id = payload?.pipeline?.id
  if (!id) return
  emit('imported', id)
  emit('close')
}

// Each agent step's kickoff names its CLI, so a new CLI needs a new preview.
watch(agent, () => { if (preview.value && !busy.value) void runPreview() })

async function chooseFile(): Promise<void> {
  if (!window.agentTeam?.openJson) return
  busy.value = 'file'
  try {
    const result = await window.agentTeam.openJson({ title: t('pipelineImport.choose-file-title') })
    if (result.ok && result.content !== undefined) jsonText.value = result.content
    else if (result.error) error.value = { text: result.error, detail: '' }
  } finally {
    busy.value = null
  }
}

/** Unsupported nodes share the pending color: both need the user. */
function swatch(category: Category | undefined): string {
  if (category === 'native' || category === 'agent') return category
  return 'pending'
}
const nodeClass = (n: GraphNode): string => {
  const category = report.value?.nodeCategories[n.id]
  return category ? `n8n-cat n8n-cat--${swatch(category)}` : ''
}

function actionLabel(code: string): string {
  const key = `pipelineImport.action-code.${code}`
  return te(key) ? t(key) : code
}

const card = ref<HTMLElement | null>(null)
const textarea = ref<HTMLTextAreaElement | null>(null)
useDialogFocus(card, () => textarea.value)
</script>

<template>
  <div v-if="open" class="n8n-import nv-dialog-scrim">
    <div
      ref="card"
      class="n8n-import-card nv-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="n8n-import-title"
      tabindex="-1"
    >
      <div class="nv-dialog-head">
        <div class="nv-dialog-heading">
          <h4 id="n8n-import-title" class="nv-dialog-title">{{ t('pipelineImport.title') }}</h4>
          <p class="nv-dialog-subtitle">{{ t('pipelineImport.subtitle') }}</p>
        </div>
      </div>

      <div class="nv-dialog-body n8n-body">
        <label class="n8n-field">
          <span class="n8n-label">{{ t('pipelineImport.default-agent') }}</span>
          <select v-model="agent" class="nv-select n8n-agent" :disabled="!!busy">
            <option v-for="a in agentOptions" :key="a.key" :value="a.key">{{ a.label }}</option>
          </select>
          <span class="nv-hint">{{ t('pipelineImport.default-agent-hint') }}</span>
        </label>

        <div class="n8n-field">
          <div class="n8n-label-row">
            <label for="n8n-import-json" class="n8n-label">{{ t('pipelineImport.json-label') }}</label>
            <button type="button" class="nv-btn nv-btn--ghost nv-btn--sm n8n-choose" :disabled="!!busy" @click="chooseFile">
              {{ t('pipelineImport.choose-file') }}
            </button>
          </div>
          <textarea
            id="n8n-import-json" ref="textarea" v-model="jsonText"
            class="nv-input n8n-json" spellcheck="false" rows="6"
            :placeholder="t('pipelineImport.json-placeholder')"
          />
        </div>

        <div class="n8n-preview-row">
          <button
            type="button" class="nv-btn n8n-preview"
            :disabled="!!busy || !jsonText.trim()" @click="runPreview"
          >{{ busy === 'preview' ? t('pipelineImport.previewing') : t('pipelineImport.preview') }}</button>
          <span v-if="stale" class="nv-hint n8n-stale">{{ t('pipelineImport.preview-stale') }}</span>
        </div>

        <div v-if="error" class="n8n-error" role="alert">
          <p>{{ error.text }}</p>
          <p v-if="error.detail" class="n8n-error-detail">{{ error.detail }}</p>
        </div>

        <template v-if="preview && report">
          <!-- a. What the workflow becomes, and what to know before importing. -->
          <section class="n8n-section n8n-summary">
            <dl class="n8n-stats">
              <div><dt>{{ t('pipelineImport.stats.workflow') }}</dt><dd>{{ report.workflow }}</dd></div>
              <div><dt>{{ t('pipelineImport.stats.nodes') }}</dt><dd>{{ report.stats.nodes }}</dd></div>
              <div><dt>{{ t('pipelineImport.stats.slots') }}</dt><dd>{{ report.stats.slots }}</dd></div>
              <div><dt>{{ t('pipelineImport.stats.gates') }}</dt><dd>{{ report.stats.gates }}</dd></div>
              <div><dt>{{ t('pipelineImport.stats.triggers') }}</dt><dd>{{ report.stats.triggers }}</dd></div>
            </dl>
            <ul class="n8n-categories">
              <li v-for="c in CATEGORIES" :key="c" :data-category="c">
                <span class="n8n-swatch" :class="`n8n-swatch--${swatch(c)}`" aria-hidden="true"></span>
                {{ t(`pipelineImport.category.${c}`) }}
                <!-- "Needs review" counts what the banner counts: steps flagged for review. -->
                <strong>{{ c === 'pending' ? report.stats.needsReview : (report.stats.byCategory?.[c] ?? 0) }}</strong>
              </li>
            </ul>
            <div v-if="report.stats.needsReview > 0" class="n8n-notice n8n-notice--review" data-testid="n8n-needs-review">
              <strong>{{ t('pipelineImport.needs-review', { n: report.stats.needsReview }, report.stats.needsReview) }}</strong>
              <span>{{ t('pipelineImport.needs-review-hint') }}</span>
            </div>
            <p v-if="needsSubworkflow" class="n8n-notice" data-testid="n8n-subworkflow">{{ t('pipelineImport.subworkflow') }}</p>
            <p class="n8n-notice" data-testid="n8n-external">{{ t('pipelineImport.external') }}</p>
            <div v-if="report.warnings?.length" class="n8n-warnings">
              <h5>{{ t('pipelineImport.warnings') }}</h5>
              <ul><li v-for="(w, i) in report.warnings" :key="i">{{ w }}</li></ul>
            </div>
          </section>

          <!-- b. The graph as it will be created. -->
          <section class="n8n-section">
            <h5>{{ t('pipelineImport.canvas-title') }}</h5>
            <div class="n8n-canvas">
              <PipelineCanvas
                flow-id="n8n-import-preview"
                :graph="preview.graph" :role-labels="{}" :agent-labels="agentLabels"
                :run-nodes="{}" :now="0" :selected-id="null" :locked="true"
                :node-class="nodeClass"
              />
            </div>
            <ul class="n8n-legend" :aria-label="t('pipelineImport.legend')">
              <li v-for="c in CATEGORIES" :key="c">
                <span class="n8n-swatch" :class="`n8n-swatch--${swatch(c)}`" aria-hidden="true"></span>
                {{ t(`pipelineImport.category.${c}`) }}
              </li>
            </ul>
          </section>

          <!-- c. How every n8n node was converted. -->
          <section class="n8n-section">
            <h5>{{ t('pipelineImport.report-title') }}</h5>
            <div class="n8n-table-wrap">
              <table class="n8n-report">
                <thead>
                  <tr>
                    <th>{{ t('pipelineImport.col.node') }}</th>
                    <th>{{ t('pipelineImport.col.type') }}</th>
                    <th>{{ t('pipelineImport.col.result') }}</th>
                    <th>{{ t('pipelineImport.col.category') }}</th>
                    <th>{{ t('pipelineImport.col.detail') }}</th>
                    <th>{{ t('pipelineImport.col.actions') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in report.nodes" :key="i" class="n8n-row" :class="{ 'is-review': r.needsReview }">
                    <td>
                      {{ r.name }}
                      <span v-if="r.needsReview" class="n8n-review-mark">{{ t('pipelineImport.review-mark') }}</span>
                    </td>
                    <td><code>{{ r.type }}@{{ r.typeVersion }}</code></td>
                    <td>
                      {{ t(`pipelineImport.result.${r.result}`) }}
                      <span v-if="r.node" class="n8n-target">· {{ graphLabels.get(r.node) ?? r.node }}</span>
                    </td>
                    <td>
                      <span class="n8n-swatch" :class="`n8n-swatch--${swatch(r.category)}`" aria-hidden="true"></span>
                      {{ t(`pipelineImport.category.${r.category}`) }}
                    </td>
                    <td class="n8n-detail">{{ r.detail }}</td>
                    <td>
                      <ul v-if="r.actions.length" class="n8n-actions">
                        <li v-for="a in r.actions" :key="a">{{ actionLabel(a) }}</li>
                      </ul>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- d. The exact text each pane and gate will show. -->
          <section v-if="report.slots.length" class="n8n-section">
            <h5>{{ t('pipelineImport.kickoffs-title') }}</h5>
            <p class="nv-hint">{{ t('pipelineImport.kickoffs-hint') }}</p>
            <details v-for="s in report.slots" :key="s.id" class="n8n-kickoff" :data-slot-id="s.id">
              <summary>{{ s.label }} <code>{{ agentLabels[s.agentKey] ?? s.agentKey }}</code></summary>
              <pre>{{ s.kickoffBody }}</pre>
            </details>
          </section>
          <section v-if="report.gates.length" class="n8n-section">
            <h5>{{ t('pipelineImport.gates-title') }}</h5>
            <p class="nv-hint">{{ t('pipelineImport.gates-hint') }}</p>
            <details v-for="g in report.gates" :key="g.id" class="n8n-gate" :data-gate-id="g.id">
              <summary>{{ g.label }}</summary>
              <pre>{{ g.prompt }}</pre>
            </details>
          </section>

          <!-- e. What stays on this machine. -->
          <section v-if="credentials.length" class="n8n-section">
            <h5>{{ t('pipelineImport.credentials-title') }}</h5>
            <p class="nv-hint">{{ t('pipelineImport.credentials-hint') }}</p>
            <ul class="n8n-credentials">
              <li v-for="(c, i) in credentials" :key="i">
                <code>{{ c.type }}</code> {{ c.name }}
                <span class="nv-hint">{{ t('pipelineImport.credentials-used-by', { nodes: c.nodes.join(', ') }) }}</span>
              </li>
            </ul>
          </section>
          <section v-if="report.secretsRemoved.length" class="n8n-section">
            <h5>{{ t('pipelineImport.secrets-title') }}</h5>
            <p class="nv-hint">{{ t('pipelineImport.secrets-hint') }}</p>
            <table class="n8n-secrets">
              <thead>
                <tr><th>{{ t('pipelineImport.col.node') }}</th><th>{{ t('pipelineImport.col.field') }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="(s, i) in report.secretsRemoved" :key="i">
                  <td>{{ s.node ?? '—' }}</td>
                  <td><code>{{ s.field }}</code></td>
                </tr>
              </tbody>
            </table>
          </section>
        </template>
      </div>

      <div class="nv-dialog-actions">
        <button type="button" class="nv-btn n8n-cancel" @click="emit('close')">{{ t('action.cancel') }}</button>
        <button type="button" class="nv-btn nv-btn--primary n8n-import-btn" :disabled="!canImport" :title="importBlocked || undefined" @click="runImport">
          {{ busy === 'import' ? t('pipelineImport.importing') : t('pipelineImport.import') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Mounted inside the Pipeline Manager overlay: above it, like its own modals. */
.n8n-import {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: calc(var(--z-modal) + 121);
}
.n8n-import-card {
  width: min(960px, calc(100vw - 32px));
}
.n8n-body {
  padding-left: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.n8n-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.n8n-label {
  font-weight: 600;
}
.n8n-label-row,
.n8n-preview-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.n8n-label-row {
  justify-content: space-between;
}
.n8n-agent {
  align-self: flex-start;
}
.n8n-json {
  font-family: var(--font-mono);
  font-size: var(--font-xs);
  resize: vertical;
  min-height: 96px;
}
.n8n-error {
  color: var(--danger-fg);
  overflow-wrap: anywhere;
}
.n8n-error p {
  margin: 0;
}
.n8n-error-detail {
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.n8n-section h5 {
  margin: 0 0 6px;
  font-size: var(--font-sm);
  color: var(--text-bright);
}
.n8n-summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.n8n-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  margin: 0;
}
.n8n-stats dt {
  color: var(--text-muted);
  font-size: var(--font-xs);
}
.n8n-stats dd {
  margin: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.n8n-categories,
.n8n-legend,
.n8n-actions,
.n8n-credentials,
.n8n-warnings ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.n8n-categories,
.n8n-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  font-size: var(--font-xs);
}
.n8n-legend {
  margin-top: 6px;
  color: var(--text-secondary);
}
.n8n-swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 3px;
  vertical-align: -1px;
  margin-right: 4px;
}
.n8n-swatch--native { background: var(--success-fg); }
.n8n-swatch--agent { background: var(--accent-fg); }
.n8n-swatch--pending { background: var(--attention-fg); }
.n8n-notice {
  margin: 0;
  padding: 6px 10px;
  border-left: 3px solid var(--border-strong);
  background: var(--bg-subtle);
  border-radius: var(--radius-xs);
}
.n8n-notice--review {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-left-color: var(--attention-fg);
  background: var(--attention-subtle);
}
.n8n-warnings li {
  font-size: var(--font-xs);
  color: var(--warning-fg);
}
.n8n-canvas {
  height: 300px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.n8n-canvas :deep(.vue-flow__node.n8n-cat--native) { box-shadow: 0 0 0 2px var(--success-fg); }
.n8n-canvas :deep(.vue-flow__node.n8n-cat--agent) { box-shadow: 0 0 0 2px var(--accent-fg); }
.n8n-canvas :deep(.vue-flow__node.n8n-cat--pending) { box-shadow: 0 0 0 2px var(--attention-fg); }
.n8n-table-wrap {
  overflow-x: auto;
}
.n8n-report,
.n8n-secrets {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-xs);
}
.n8n-report th,
.n8n-report td,
.n8n-secrets th,
.n8n-secrets td {
  text-align: left;
  vertical-align: top;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-muted);
}
.n8n-report th,
.n8n-secrets th {
  color: var(--text-muted);
  font-weight: 600;
}
.n8n-row.is-review {
  background: var(--attention-subtle);
}
.n8n-review-mark {
  display: inline-block;
  margin-left: 4px;
  padding: 0 5px;
  border: 1px solid var(--attention-muted);
  border-radius: var(--radius-xs);
  color: var(--attention-fg);
  font-size: var(--font-3xs);
  white-space: nowrap;
}
.n8n-target {
  color: var(--text-secondary);
}
.n8n-detail {
  overflow-wrap: anywhere;
}
.n8n-kickoff,
.n8n-gate {
  margin-top: 4px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
}
.n8n-kickoff summary,
.n8n-gate summary {
  cursor: pointer;
}
.n8n-kickoff pre,
.n8n-gate pre {
  margin: 6px 0 2px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: var(--font-xs);
}
.n8n-credentials li {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  padding: 2px 0;
}
</style>
