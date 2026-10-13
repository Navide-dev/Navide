<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { useReview } from '../composables/useReview'
import type { ReviewFinding } from '../composables/useReview'
import type { useBackend } from '../composables/useBackend'
import type { useGit } from '../composables/useGit'
import { setDiagnostics, clearDiagnostics, diagnosticsKey } from '../editor/diagnostics'
import type { Diagnostic } from '../editor/diagnostics'

const props = defineProps<{
  workspacePath: string
  backend: ReturnType<typeof useBackend>
  gitStatus: ReturnType<typeof useGit>['gitStatus']['value']
  gitBranches: ReturnType<typeof useGit>['gitBranches']['value']
  hideHeader?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open-file', payload: { filepath: string; line: number | null }): void
  (e: 'ask-ai-fix', text: string): void
}>()

const { isReviewing, reviewResult, reviewError, reviewElapsed, startReview, stopReview } = useReview(props.backend)

// Sync review findings → diagnosticsStore so Problems panel and gutter icons update.
watch(reviewResult, (result) => {
  if (!result) return
  const byFile = new Map<string, Diagnostic[]>()
  for (const f of result.findings) {
    if (!f.file || f.line == null) continue
    const sev: Diagnostic['severity'] =
      f.severity === 'critical' ? 'error' : f.severity === 'warning' ? 'warning' : 'info'
    const arr = byFile.get(f.file) ?? []
    arr.push({ relPath: f.file, wsPath: props.workspacePath, line: f.line, col: 0, severity: sev, message: f.title, source: 'review' })
    byFile.set(f.file, arr)
  }
  for (const [relPath, diags] of byFile) setDiagnostics(diagnosticsKey(props.workspacePath, relPath), diags)
})

const mode = ref<'working' | 'branch'>('working')
const baseBranch = ref('main')
const compareBranch = ref('')

// Model picker
type ProviderKey = 'ollama' | 'anthropic' | 'openai' | 'google' | 'groq' | 'deepseek' | 'mistral' | 'xai' | 'openai_compatible'

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  ollama: 'Ollama (Local)',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral AI',
  xai: 'xAI (Grok)',
  openai_compatible: 'Custom (OpenAI-compatible)',
}

const PROVIDER_MODELS: Partial<Record<ProviderKey, string[]>> = {
  anthropic: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  mistral: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
  xai: ['grok-3-mini', 'grok-3', 'grok-2'],
}

const provider = ref<ProviderKey>('ollama')
const currentModel = ref('')
const ollamaModels = ref<string[]>([])
const staticModels = computed(() => PROVIDER_MODELS[provider.value] ?? [])

onMounted(async () => {
  const r = await props.backend.send<Record<string, string>>('ai.chat.settings.get', {})
  if (r.ok && r.payload) {
    const p = r.payload.provider as ProviderKey
    if (p) provider.value = p
    if (r.payload.model) currentModel.value = r.payload.model
  }
  const mr = await props.backend.send<{ ok: boolean; models?: { name: string }[] }>('analyzer.models', {})
  if (mr.ok && mr.payload?.models) {
    ollamaModels.value = mr.payload.models.map((m: { name: string }) => m.name).filter(Boolean)
  }
})

async function saveModel() {
  await props.backend.send('ai.chat.settings.set', {
    provider: provider.value,
    model: currentModel.value,
  })
}

const localBranches = computed(() =>
  (props.gitBranches as { name: string; is_remote: boolean; is_current: boolean }[])
    .filter(b => !b.is_remote)
    .map(b => b.name)
)

const currentBranch = computed(() =>
  (props.gitBranches as { name: string; is_current: boolean }[]).find(b => b.is_current)?.name ?? ''
)

async function doReview() {
  dismissed.value = new Set()
  severityFilter.value = 'all'
  showDismissed.value = false
  await saveModel()
  await startReview({
    workspacePath: props.workspacePath,
    mode: mode.value,
    base: mode.value === 'branch' ? baseBranch.value : undefined,
    compare: mode.value === 'branch' ? (compareBranch.value || currentBranch.value) : undefined,
  })
}

// ── Management UI state ────────────────────────────────────────────────────

type SeverityFilter = 'all' | 'critical' | 'warning' | 'suggestion'
const severityFilter = ref<SeverityFilter>('all')
const showDismissed = ref(false)
const dismissed = ref<Set<string>>(new Set())

function toggleDismiss(id: string) {
  const s = new Set(dismissed.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  dismissed.value = s
}

function openFindingFile(f: ReviewFinding): void {
  if (!f.file) return
  emit('open-file', { filepath: f.file, line: f.line })
}

function askAiFix(f: ReviewFinding): void {
  const loc = f.file ? (f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``) : ''
  const text = `Fix this code review issue${loc ? ` in ${loc}` : ''}:\n\n**${f.title}**\n\n${f.body}`
  emit('ask-ai-fix', text)
}

const countOf = (sev: ReviewFinding['severity']) =>
  reviewResult.value?.findings.filter(f => f.severity === sev && !dismissed.value.has(f.id)).length ?? 0

const dismissedCount = computed(() => dismissed.value.size)

const filterOptions = computed(() => [
  { key: 'all' as SeverityFilter,        label: 'All',        count: reviewResult.value?.findings.filter(f => !dismissed.value.has(f.id)).length ?? 0 },
  { key: 'critical' as SeverityFilter,   label: '🔴 Critical', count: countOf('critical') },
  { key: 'warning' as SeverityFilter,    label: '🟡 Warning',  count: countOf('warning') },
  { key: 'suggestion' as SeverityFilter, label: '🔵 Suggest',  count: countOf('suggestion') },
])

const visibleFindings = computed(() => {
  if (!reviewResult.value) return []
  return reviewResult.value.findings.filter(f => {
    if (dismissed.value.has(f.id) && !showDismissed.value) return false
    if (severityFilter.value !== 'all' && f.severity !== severityFilter.value) return false
    return true
  })
})

const VERDICT_META = {
  approve:               { icon: '✅', label: 'Approve',                    cls: 'verdict-approve' },
  approve_with_comments: { icon: '⚠️', label: 'Approve with minor comments', cls: 'verdict-warn' },
  request_changes:       { icon: '❌', label: 'Request changes',              cls: 'verdict-reject' },
}
const verdictMeta = computed(() =>
  reviewResult.value ? (VERDICT_META[reviewResult.value.verdict] ?? VERDICT_META.approve_with_comments) : null
)
</script>

<template>
  <div class="review-pane">
    <!-- Header -->
    <div v-if="!hideHeader" class="panel-header">
      <span class="panel-title">{{ $t('label.ai-review') }}</span>
      <div class="spacer" />
      <button class="hdr-btn" title="Close" @click="emit('close')">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/>
        </svg>
      </button>
    </div>

    <!-- Controls -->
    <div class="controls">
      <div class="model-row">
        <select class="model-select" v-model="provider" @change="saveModel">
          <option v-for="(label, key) in PROVIDER_LABELS" :key="key" :value="key">{{ label }}</option>
        </select>
        <select v-if="provider === 'ollama'" class="model-select model-select--flex" v-model="currentModel" @change="saveModel">
          <option v-for="m in ollamaModels" :key="m" :value="m">{{ m }}</option>
          <option v-if="currentModel && !ollamaModels.includes(currentModel)" :value="currentModel">{{ currentModel }}</option>
        </select>
        <input
          v-else-if="provider === 'openai_compatible'"
          class="model-select model-select--flex model-input"
          v-model="currentModel"
          placeholder="Model name (e.g. llama-3.3-70b)"
          @change="saveModel"
        />
        <select v-else class="model-select model-select--flex" v-model="currentModel" @change="saveModel">
          <option v-for="m in staticModels" :key="m" :value="m">{{ m }}</option>
          <option v-if="currentModel && !staticModels.includes(currentModel)" :value="currentModel">{{ currentModel }}</option>
        </select>
      </div>

      <div class="mode-row">
        <span class="mode-label">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px;opacity:0.7">
            <path d="M2 2.5A2.5 2.5 0 1 1 5 5H4v1h6V5h-1a2.5 2.5 0 1 1 2.5-2.5v.085l.447.224A1.5 1.5 0 0 1 13 4.5V8a1.5 1.5 0 0 1-1.5 1.5H10v1h.5A1.5 1.5 0 0 1 12 12v1.5a2.5 2.5 0 1 1-1 0V12a.5.5 0 0 0-.5-.5H5.5A.5.5 0 0 0 5 12v1.5a2.5 2.5 0 1 1-1 0V12a1.5 1.5 0 0 1 1.5-1.5H6v-1H4.5A1.5 1.5 0 0 1 3 8V4.5a1.5 1.5 0 0 1 .553-1.191L4 3.085V2.5A2.5 2.5 0 0 1 2 2.5z"/>
          </svg>
          {{ mode === 'working' ? 'Working Changes' : `${baseBranch} → ${compareBranch || currentBranch}` }}
        </span>
        <button class="branch-toggle" @click="mode = mode === 'branch' ? 'working' : 'branch'">
          {{ mode === 'branch' ? '✕ ' + $t('action.cancel') : '↔ Branch Diff' }}
        </button>
      </div>

      <div v-if="mode === 'branch'" class="branch-row">
        <span class="branch-label">{{ $t('label.base') }}</span>
        <select class="branch-select" v-model="baseBranch">
          <option v-for="b in localBranches" :key="b" :value="b">{{ b }}</option>
          <option v-if="!localBranches.includes('main')" value="main">main</option>
          <option v-if="!localBranches.includes('master')" value="master">master</option>
        </select>
        <span class="branch-arrow">→</span>
        <select class="branch-select" v-model="compareBranch">
          <option value="">{{ currentBranch || 'HEAD' }} (current)</option>
          <option v-for="b in localBranches" :key="b" :value="b">{{ b }}</option>
        </select>
      </div>

      <div class="action-row">
        <button v-if="!isReviewing" class="btn-primary" :disabled="!workspacePath" @click="doReview">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px">
            <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm3.669 10.081a.5.5 0 0 1-.67.225L8 8.698V5a.5.5 0 0 1 1 0v3.1l2.586 1.293a.5.5 0 0 1 .083.688z"/>
          </svg>
          {{ $t('action.start-review') }}
        </button>
        <button v-else class="btn-stop" @click="stopReview">{{ $t('action.stop-streaming') }}</button>
        <span v-if="isReviewing" class="reviewing-indicator">{{ $t('label.analyzing') }}</span>
      </div>
    </div>

    <!-- Error -->
    <div v-if="reviewError" class="review-error">{{ reviewError }}</div>

    <!-- Analyzing spinner -->
    <div v-if="isReviewing" class="analyzing-state">
      <div class="spinner" />
      <span>{{ $t('label.analyzing') }} <span class="elapsed-time">({{ reviewElapsed }}s)</span></span>
    </div>

    <!-- Empty hint -->
    <div v-else-if="!reviewResult && !reviewError" class="empty-hint">
      <svg width="24" height="24" viewBox="0 0 16 16" fill="currentColor" style="opacity:0.3;margin-bottom:8px">
        <path d="M1.5 2.75C1.5 1.784 2.284 1 3.25 1h9.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 12.75 12H9.06l.72 1.5h1.47a.75.75 0 0 1 0 1.5H4.75a.75.75 0 0 1 0-1.5h1.47L6.94 12H3.25A1.75 1.75 0 0 1 1.5 10.25v-7.5zm1.5 0v7.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-9.5a.25.25 0 0 0-.25.25z"/>
      </svg>
      <p>{{ $t('hint.review-instructions') }}</p>
    </div>

    <!-- Management UI -->
    <div v-else-if="reviewResult" class="review-output">
      <!-- Verdict -->
      <div class="verdict-bar" :class="verdictMeta?.cls">
        <span class="verdict-icon">{{ verdictMeta?.icon }}</span>
        <span class="verdict-label">{{ verdictMeta?.label }}</span>
      </div>

      <!-- Summary -->
      <p class="summary-text">{{ reviewResult.summary }}</p>

      <!-- Severity filter + dismissed toggle -->
      <div class="filter-bar">
        <button
          v-for="f in filterOptions" :key="f.key"
          class="filter-pill" :class="{ active: severityFilter === f.key }"
          @click="severityFilter = f.key"
        >
          {{ f.label }}<span class="pill-count">{{ f.count }}</span>
        </button>
        <button class="filter-pill dismissed-pill" :class="{ active: showDismissed }" @click="showDismissed = !showDismissed">
          Dismissed<span v-if="dismissedCount" class="pill-count">{{ dismissedCount }}</span>
        </button>
      </div>

      <!-- Finding cards -->
      <div class="findings-list">
        <div
          v-for="f in visibleFindings" :key="f.id"
          class="finding-card" :class="[`sev-${f.severity}`, { 'is-dismissed': dismissed.has(f.id) }]"
        >
          <div class="finding-header">
            <span class="sev-badge" :class="`sev-badge--${f.severity}`">
              {{ f.severity === 'critical' ? '🔴' : f.severity === 'warning' ? '🟡' : '🔵' }}
            </span>
            <span
              class="finding-file" v-truncate
              :class="{ 'finding-file--link': !!f.file }"
              :title="f.file ? 'Open file' : undefined"
              @click="openFindingFile(f)"
            >{{ f.file || '(general)' }}<span v-if="f.line" class="finding-line">:{{ f.line }}</span></span>
            <button class="finding-ai-btn" title="Ask AI to fix" @click="askAiFix(f)">✦ Ask AI</button>
            <button
              class="dismiss-btn"
              :title="dismissed.has(f.id) ? 'Restore' : 'Dismiss'"
              @click="toggleDismiss(f.id)"
            >{{ dismissed.has(f.id) ? '↩' : '✕' }}</button>
          </div>
          <div class="finding-title">{{ f.title }}</div>
          <div class="finding-body">{{ f.body }}</div>
        </div>

        <div v-if="!visibleFindings.length && reviewResult.findings.length === 0" class="no-findings">
          No findings — looks good!
        </div>
        <div v-else-if="!visibleFindings.length" class="no-findings">
          No {{ severityFilter === 'all' ? '' : severityFilter + ' ' }}findings to show.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.review-pane {
  display: flex; flex-direction: column; height: 100%;
  background: var(--bg-base); color: var(--text-primary);
  font-size: var(--font-xs); overflow: hidden;
}

/* Header */
.panel-header {
  display: flex; align-items: center; gap: 2px;
  padding: 1px 6px; border-bottom: 1px solid var(--border-muted);
  min-height: 24px; flex-shrink: 0; background: var(--bg-base);
}
.panel-title {
  font-size: 9px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 1px; color: var(--text-secondary); padding: 0 4px;
}
.spacer { flex: 1; }
.hdr-btn {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; background: transparent; border: none;
  border-radius: 4px; color: var(--text-muted); cursor: pointer; padding: 0;
}
.hdr-btn:hover { color: var(--text-primary); background: var(--bg-active); }

/* Controls */
.controls {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px 8px 6px; border-bottom: 1px solid var(--border-muted); flex-shrink: 0;
}
.model-row { display: flex; align-items: center; gap: 4px; }
.model-select {
  padding: 2px 4px; font-size: var(--font-2xs);
  background: var(--bg-subtle); border: 1px solid var(--border-default);
  border-radius: 4px; color: var(--text-primary); cursor: pointer; min-width: 0;
}
.model-select--flex { flex: 1; }
.model-input { font-family: inherit; }
.mode-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.mode-label { display: flex; align-items: center; font-size: var(--font-2xs); font-weight: 600; color: var(--text-primary); }
.branch-toggle {
  padding: 2px 7px; font-size: var(--font-3xs); border-radius: 4px;
  border: 1px solid var(--border-default); background: transparent;
  color: var(--text-muted); cursor: pointer; white-space: nowrap;
}
.branch-toggle:hover { color: var(--accent-fg); border-color: var(--accent-emphasis); }
.branch-row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.branch-label { font-size: var(--font-3xs); color: var(--text-muted); white-space: nowrap; }
.branch-arrow { color: var(--text-muted); font-size: var(--font-2xs); }
.branch-select {
  flex: 1; min-width: 80px; padding: 2px 4px; font-size: var(--font-2xs);
  background: var(--bg-subtle); border: 1px solid var(--border-default);
  border-radius: 4px; color: var(--text-primary); cursor: pointer;
}
.action-row { display: flex; align-items: center; gap: 8px; }
.btn-primary {
  display: flex; align-items: center; padding: 4px 10px; font-size: var(--font-2xs); font-weight: 600;
  background: var(--success-emphasis); color: var(--text-on-emphasis); border: none; border-radius: 5px; cursor: pointer;
}
.btn-primary:hover { background: var(--success-strong); }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-stop {
  padding: 4px 10px; font-size: var(--font-2xs); font-weight: 600;
  background: var(--danger-subtle); color: var(--danger-fg);
  border: 1px solid var(--danger-muted); border-radius: 5px; cursor: pointer;
}
.btn-stop:hover { background: var(--danger-emphasis); color: var(--text-on-emphasis); }
.reviewing-indicator { font-size: var(--font-2xs); color: var(--text-muted); font-style: italic; }

/* Error */
.review-error {
  padding: 6px 10px; font-size: var(--font-2xs); color: var(--danger-fg);
  background: var(--danger-subtle); border-bottom: 1px solid var(--danger-muted); flex-shrink: 0;
}

/* Analyzing state */
.analyzing-state {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--text-muted); font-size: var(--font-2xs);
}
.spinner {
  width: 18px; height: 18px; border: 2px solid var(--border-default);
  border-top-color: var(--accent-fg); border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.elapsed-time { color: var(--text-muted); font-size: var(--font-3xs); }

/* Empty hint */
.empty-hint {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  color: var(--text-muted); font-size: var(--font-xs); text-align: center; gap: 4px;
}
.empty-hint p { max-width: 220px; line-height: 1.6; }

/* Management output area */
.review-output {
  flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 0;
}

/* Verdict bar */
.verdict-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; font-size: var(--font-2xs); font-weight: 600; flex-shrink: 0;
}
.verdict-approve  { background: var(--diff-add-bg); color: var(--success-fg); border-bottom: 1px solid color-mix(in srgb, var(--success-fg) 25%, transparent); }
.verdict-warn     { background: color-mix(in srgb, var(--attention-fg) 12%, transparent); color: var(--warning-fg); border-bottom: 1px solid color-mix(in srgb, var(--attention-fg) 25%, transparent); }
.verdict-reject   { background: var(--diff-del-bg);  color: var(--danger-fg);  border-bottom: 1px solid color-mix(in srgb, var(--danger-fg) 25%, transparent); }
.verdict-icon { font-size: var(--font-sm); }

/* Summary */
.summary-text {
  margin: 0; padding: 8px 12px 6px;
  font-size: var(--font-2xs); line-height: 1.6; color: var(--text-secondary);
  border-bottom: 1px solid var(--border-muted); flex-shrink: 0;
}

/* Filter bar */
.filter-bar {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  padding: 6px 10px; border-bottom: 1px solid var(--border-muted); flex-shrink: 0;
}
.filter-pill {
  display: flex; align-items: center; gap: 4px;
  padding: 2px 8px; font-size: var(--font-3xs); border-radius: 20px;
  border: 1px solid var(--border-default); background: transparent;
  color: var(--text-muted); cursor: pointer; white-space: nowrap;
}
.filter-pill:hover { color: var(--text-primary); border-color: var(--border-strong, var(--border-default)); }
.filter-pill.active { background: var(--accent-subtle); color: var(--accent-fg); border-color: var(--accent-muted); }
.pill-count {
  background: var(--bg-subtle); border-radius: 10px;
  padding: 0 5px; font-size: 9px; color: var(--text-muted);
}
.dismissed-pill { margin-left: auto; }

/* Findings list */
.findings-list {
  flex: 1; overflow-y: auto; padding: 8px;
  display: flex; flex-direction: column; gap: 6px;
}
.finding-card {
  border: 1px solid var(--border-muted); border-radius: 6px;
  background: var(--bg-subtle); overflow: hidden;
}
.finding-card.is-dismissed { opacity: 0.45; }
.finding-card.sev-critical { border-left: 3px solid var(--danger-fg); }
.finding-card.sev-warning  { border-left: 3px solid var(--warning-fg); }
.finding-card.sev-suggestion { border-left: 3px solid var(--accent-fg); }

.finding-header {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border-bottom: 1px solid var(--border-muted);
  background: var(--bg-base);
}
.sev-badge { font-size: var(--font-2xs); flex-shrink: 0; }
.finding-file {
  flex: 1; font-size: var(--font-3xs); font-family: monospace;
  color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.finding-file--link { cursor: pointer; }
.finding-file--link:hover { color: var(--accent-fg); text-decoration: underline; }
.finding-line { color: var(--text-muted); }
.finding-ai-btn {
  background: transparent; border: 1px solid var(--border-muted); cursor: pointer;
  color: var(--accent-fg); font-size: 9px; line-height: 1;
  padding: 1px 5px; border-radius: 3px; flex-shrink: 0; white-space: nowrap;
}
.finding-ai-btn:hover { background: color-mix(in srgb, var(--accent-fg) 12%, transparent); }
.dismiss-btn {
  background: transparent; border: none; cursor: pointer;
  color: var(--text-muted); font-size: var(--font-xs); line-height: 1;
  padding: 0 2px; border-radius: 3px; flex-shrink: 0;
}
.dismiss-btn:hover { color: var(--text-primary); background: var(--bg-hover-strong); }

.finding-title {
  padding: 5px 10px 2px; font-size: var(--font-2xs); font-weight: 600; color: var(--text-primary);
}
.finding-body {
  padding: 2px 10px 8px; font-size: var(--font-2xs); line-height: 1.55; color: var(--text-secondary);
}

.no-findings {
  display: flex; align-items: center; justify-content: center;
  padding: 24px; color: var(--text-muted); font-size: var(--font-2xs); font-style: italic;
}
</style>
