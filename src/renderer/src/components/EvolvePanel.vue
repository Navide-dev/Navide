<script setup lang="ts">
// Workspace self-evolution ("自我優化") panel: one workspace's switch, time,
// execution unit, CLI, budget, permission scope, rules, last result and
// history. Opened from the sidebar heading (⋯ menu, right-click menu)
// and from the Schedule panel's read-only system job row.
//
// Everything is per workspace: every request names `workspace`, and nothing
// here is shared with any other workspace's panel. The backend owns the
// settings and history (`evolve.get` / `evolve.set` / `evolve.run_now`); this
// keeps an editable draft and sends only what changed.
import { computed, ref, watch } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import {
  EVOLVE_BOUNDS,
  evolveGet,
  evolveRunNow,
  evolveSet,
  formatEvolveNext,
  useEvolveBadges,
  type EvolveRun,
  type EvolveSettings,
  type EvolveState,
} from '../composables/useEvolve'
import { blockTourWhile } from '../composables/useTourBlockers'
import { isValidHhmm, isValidTimeZone } from '../lib/schedulerJobs'
import type { AgentSpec } from '../platform/plugin-shell/agents/types'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  /** The workspace whose panel is open; null = closed. */
  workspace: string | null
  /** The CLIs this install offers (App's enabledAgentSpecs). */
  agentSpecs?: AgentSpec[]
}>()
const emit = defineEmits<{ close: [] }>()
blockTourWhile(() => !!props.workspace)

const { t, te } = useI18n()
const { badges } = useEvolveBadges()

interface RosterPane {
  pane_id?: string
  name?: string
  workspace_path?: string
  agent_key?: string
}

const state = ref<EvolveState | null>(null)
const draft = ref<EvolveSettings | null>(null)
const loadError = ref('')
const opError = ref('')
const saving = ref(false)
const runPending = ref(false)
const runNotice = ref('')
const showTemplate = ref(false)
/** Ids of legacy jobs the last enable turned off (evolve.set's disabled_legacy). */
const disabledLegacy = ref<string[]>([])
const roster = ref<RosterPane[]>([])
let loadSeq = 0

const isRepo = computed(() => !!state.value?.git.is_repo)
const workspaceName = computed(() => {
  const p = props.workspace ?? ''
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
})

const cliSpecs = computed(() => (props.agentSpecs ?? []).filter((s) => s.agentKey !== 'terminal'))
const agentOptions = computed(() => {
  const list = cliSpecs.value.map((s) => ({ key: s.agentKey, label: s.label }))
  const cur = draft.value?.agent
  if (cur && !list.some((o) => o.key === cur)) list.unshift({ key: cur, label: cur })
  return list
})
const pickedSpec = computed(() => cliSpecs.value.find((s) => s.agentKey === draft.value?.agent))
/** No spec (an agent this install does not list) leaves both fields open:
 *  the backend refuses a model or effort the CLI cannot take. */
const modelSupported = computed(() => !pickedSpec.value || !!pickedSpec.value.modelArgs)
const effortSupported = computed(() => !pickedSpec.value || !!pickedSpec.value.effortArgs)
const knownEfforts = computed(() => pickedSpec.value?.knownEfforts ?? [])

/** CLI panes of THIS workspace only. */
const paneOptions = computed(() =>
  roster.value.filter((p) => p.pane_id && p.workspace_path === props.workspace && p.agent_key !== 'terminal')
)
const missingPane = computed(() => {
  const d = draft.value
  if (!d || d.mode !== 'pane' || !d.pane_id) return null
  return paneOptions.value.some((p) => p.pane_id === d.pane_id) ? null : d
})

const lastRun = computed<EvolveRun | null>(() => state.value?.running ?? state.value?.runs[0] ?? null)
const history = computed(() => (state.value?.runs ?? []).slice(0, 30))

const runsToday = computed(() => {
  const today = new Date()
  return (state.value?.runs ?? []).filter((r) => {
    if (r.status === 'skipped') return false
    const d = new Date(r.started_at)
    return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  }).length
})

const nextRunAt = computed(() => {
  const b = props.workspace ? badges.value[props.workspace] : undefined
  return state.value?.job?.next_run_at ?? b?.next_run_at ?? null
})

const legacyToDisable = computed(() => (state.value?.legacy ?? []).filter((j) => j.enabled))

const errors = computed(() => {
  const d = draft.value
  const out: Partial<Record<keyof EvolveSettings, string>> = {}
  if (!d) return out
  if (!isValidHhmm(d.at)) out.at = t('evolve.error.at')
  if (d.tz && !isValidTimeZone(d.tz)) out.tz = t('evolve.error.tz')
  const range = (key: 'max_runs_per_day' | 'max_fixes' | 'max_minutes') => {
    const [min, max] = EVOLVE_BOUNDS[key]
    const v = d[key]
    if (!Number.isInteger(v) || v < min || v > max) out[key] = t('evolve.error.range', { min, max })
  }
  range('max_runs_per_day')
  range('max_fixes')
  range('max_minutes')
  if (!Number.isInteger(d.token_budget) || d.token_budget <= 0) out.token_budget = t('evolve.error.budget')
  if (d.extra.length > EVOLVE_BOUNDS.extra) out.extra = t('evolve.error.extra', { max: EVOLVE_BOUNDS.extra })
  if (d.mode === 'pane' && !d.pane_id) out.pane_id = t('evolve.error.pane')
  return out
})
const hasErrors = computed(() => Object.keys(errors.value).length > 0)

/** Fields of the draft that differ from what the backend holds. */
const changed = computed<Partial<EvolveSettings>>(() => {
  const d = draft.value
  const s = state.value?.settings
  if (!d || !s) return {}
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(d) as (keyof EvolveSettings)[]) {
    if (key === 'enabled' || key === 'pending_catch_up') continue
    if (d[key] !== s[key]) out[key] = d[key]
  }
  return out as Partial<EvolveSettings>
})
const dirty = computed(() => Object.keys(changed.value).length > 0)

function adopt(next: EvolveState): void {
  state.value = next
  draft.value = { ...next.settings }
  // Non-git workspaces can only propose; show the scope they will really run with.
  if (!next.git.is_repo) draft.value.scope = 'propose'
}

async function load(): Promise<void> {
  const ws = props.workspace
  if (!ws) return
  const seq = ++loadSeq
  const res = await evolveGet(props.backend, ws)
  if (seq !== loadSeq || ws !== props.workspace) return
  if (res.ok) {
    loadError.value = ''
    // Keep the user's unsaved edits when a broadcast re-reads the state.
    const keep = dirty.value ? { ...changed.value } : null
    adopt(res.data)
    if (keep && draft.value) Object.assign(draft.value, keep)
  } else loadError.value = res.error
}

async function loadRoster(): Promise<void> {
  if (props.backend.status.value !== 'connected') return
  try {
    const resp = await props.backend.send<{ panes?: RosterPane[] }>('agent_msg.list', {})
    roster.value = resp.payload?.panes ?? []
  } catch {
    // Keep the last list: a dropped request is not an empty machine.
  }
}

watch(
  () => props.workspace,
  (ws) => {
    state.value = null
    draft.value = null
    loadError.value = ''
    opError.value = ''
    runNotice.value = ''
    showTemplate.value = false
    disabledLegacy.value = []
    if (ws) {
      void load()
      void loadRoster()
    }
  },
  { immediate: true }
)

// evolve.changed replaces this workspace's badge; re-read the panel with it.
watch(
  () => (props.workspace ? badges.value[props.workspace] : undefined),
  (next, prev) => {
    if (next && prev && next !== prev) void load()
  }
)

async function save(extra: Partial<EvolveSettings> = {}): Promise<boolean> {
  const ws = props.workspace
  if (!ws || saving.value) return false
  const settings = { ...changed.value, ...extra }
  if (Object.keys(settings).length === 0) return true
  if (hasErrors.value) {
    opError.value = t('evolve.error.fix-fields')
    return false
  }
  saving.value = true
  opError.value = ''
  try {
    const res = await evolveSet(props.backend, ws, settings)
    if (ws !== props.workspace) return false
    if (!res.ok) {
      opError.value = res.error
      return false
    }
    adopt(res.data)
    if (res.data.disabled_legacy?.length) disabledLegacy.value = res.data.disabled_legacy
    return true
  } finally {
    saving.value = false
  }
}

/** One-click start: the defaults (and any edits) are enough to begin. */
function enable(): Promise<boolean> {
  return save({ enabled: true })
}

function disable(): Promise<boolean> {
  return save({ enabled: false })
}

async function runNow(): Promise<void> {
  const ws = props.workspace
  if (!ws || runPending.value) return
  runPending.value = true
  opError.value = ''
  runNotice.value = ''
  try {
    const res = await evolveRunNow(props.backend, ws)
    if (ws !== props.workspace) return
    if (res.ok) {
      runNotice.value = t('evolve.panel.run-started')
      void load()
    } else {
      const why = res.reason ? reasonText(res.reason) : ''
      opError.value = why ? `${why}（${res.error}）` : res.error
    }
  } finally {
    runPending.value = false
  }
}

function pickPane(id: string): void {
  if (!draft.value) return
  const p = paneOptions.value.find((x) => x.pane_id === id)
  draft.value.pane_id = id
  draft.value.pane_name = p?.name ?? ''
}

function reasonText(reason: string | null | undefined): string {
  if (!reason) return ''
  const key = `evolve.reason.${reason}`
  return te(key) ? t(key) : reason
}

function statusText(status: EvolveRun['status']): string {
  return t(`evolve.status.${status}`)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function fmtDate(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function fmtClock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fmtTokens(n: number | null | undefined): string {
  return typeof n === 'number' ? `${Math.round(n / 1000)}k` : '—'
}
function runSpan(run: EvolveRun): string {
  const start = `${fmtDate(run.started_at)} ${fmtClock(run.started_at)}`
  return run.ended_at ? `${start}–${fmtClock(run.ended_at)}` : start
}

const ledgerName = computed(() => {
  const rel = state.value?.settings.ledger_plan ?? ''
  const base = rel.split('/').pop() ?? rel
  return base.replace(/\.html?$/i, '')
})

async function openLedger(): Promise<void> {
  const rel = state.value?.settings.ledger_plan
  if (!rel || !props.workspace) return
  const res = await window.agentTeam?.openPlansWindow?.({ workspace_path: props.workspace, rel_path: rel })
  if (!res?.ok) opError.value = t('evolve.panel.ledger-open-failed')
}

async function openProposal(rel: string): Promise<void> {
  if (!props.workspace) return
  await window.agentTeam?.openPlansWindow?.({ workspace_path: props.workspace, rel_path: rel })
}
</script>

<template>
  <Teleport to="body">
    <template v-if="workspace">
      <div class="ev-backdrop nv-modal-overlay" @click="emit('close')" />
      <div
        class="ev-card nv-modal-shell nv-modal-shell--standard"
        data-test="evolve-panel"
        :data-workspace="workspace"
        role="dialog"
        @click.stop
        @keydown.esc="emit('close')"
      >
        <div class="ev-head">
          <span class="ev-title">✦ {{ t('evolve.panel.title') }}</span>
          <span class="ev-ws" v-truncate :title="workspace">
            <b>{{ workspaceName }}</b> · {{ workspace }}
            <template v-if="state">
              · <span data-test="git">{{ isRepo ? `git ${state.git.branch}` : t('evolve.panel.not-git') }}</span>
            </template>
          </span>
          <button class="ev-x" data-test="close" :title="t('evolve.panel.close')" @click="emit('close')">✕</button>
        </div>

        <div v-if="loadError" class="ev-err ev-pad" data-test="load-error">{{ loadError }}</div>
        <div v-else-if="!state || !draft" class="ev-pad ev-muted">{{ t('evolve.panel.loading') }}</div>

        <div v-else class="ev-body">
          <!-- Switch -->
          <div v-if="state.settings.enabled" class="ev-status on" data-test="status-on">
            <div class="ev-status-main">
              <div class="ev-status-line">
                <b>{{ t('evolve.panel.enabled') }}</b>
                <template v-if="nextRunAt"> · {{ t('evolve.panel.next', { time: formatEvolveNext(nextRunAt) }) }}</template>
              </div>
              <div class="ev-status-sub">
                {{ t('evolve.panel.runs-today', { n: runsToday, max: state.settings.max_runs_per_day }) }}
                · {{ t('evolve.panel.only-this-workspace') }}
              </div>
            </div>
            <button class="nv-btn" data-test="run-now" :disabled="runPending || !!state.running" @click="runNow">
              ▶ {{ t('evolve.panel.run-now') }}
            </button>
            <button class="nv-btn" data-test="disable" :disabled="saving" @click="disable">
              {{ t('evolve.panel.disable') }}
            </button>
          </div>
          <div v-else class="ev-status off" data-test="status-off">
            <button class="nv-btn nv-btn--primary ev-start" data-test="enable" :disabled="saving" @click="enable">
              {{ t('evolve.panel.one-click') }}
            </button>
            <span class="ev-status-sub">{{ t('evolve.panel.one-click-hint') }}</span>
            <button class="nv-btn" data-test="run-now" :disabled="runPending || !!state.running" @click="runNow">
              ▶ {{ t('evolve.panel.run-now') }}
            </button>
          </div>
          <div v-if="runNotice" class="ev-ok" data-test="run-notice">{{ runNotice }}</div>
          <div v-if="state.settings.pending_catch_up" class="ev-muted" data-test="pending-catch-up">
            {{ t('evolve.panel.pending-catch-up') }}
          </div>

          <div v-if="disabledLegacy.length" class="ev-legacy" data-test="legacy-disabled">
            {{ t('evolve.panel.legacy-disabled', { n: disabledLegacy.length }) }}
          </div>
          <div v-else-if="!state.settings.enabled && legacyToDisable.length" class="ev-legacy" data-test="legacy">
            {{ t('evolve.panel.legacy-hint', { n: legacyToDisable.length }) }}
            <span class="ev-muted">{{ legacyToDisable.map((j) => j.name).join('、') }}</span>
          </div>

          <!-- Disclosure (always shown) -->
          <div class="ev-disclose" data-test="disclosure">
            <b>{{ t('evolve.panel.disclose-title') }}</b>
            <template v-if="isRepo">
              {{ t('evolve.panel.disclose-git', { root: state.git.root, branch: state.git.branch }) }}
              <template v-if="state.git.subdir">{{ t('evolve.panel.disclose-subdir', { subdir: state.git.subdir }) }}</template>
            </template>
            <template v-else>{{ t('evolve.panel.disclose-no-git') }}</template>
          </div>

          <!-- Time -->
          <div class="ev-row">
            <span class="ev-k">{{ t('evolve.field.time') }}</span>
            <div class="ev-v">
              <span class="ev-unit">{{ t('evolve.field.daily') }}</span>
              <input v-model="draft.at" class="nv-input ev-time" data-field="at" type="time" />
              <input v-model="draft.tz" class="nv-input ev-tz" data-field="tz" type="text" spellcheck="false" />
              <select v-model="draft.catch_up" class="nv-select" data-field="catch_up">
                <option value="once">{{ t('evolve.field.catch-up-once') }}</option>
                <option value="skip">{{ t('evolve.field.catch-up-skip') }}</option>
              </select>
              <span v-if="errors.at" class="ev-err">{{ errors.at }}</span>
              <span v-if="errors.tz" class="ev-err">{{ errors.tz }}</span>
            </div>
          </div>

          <!-- Execution unit -->
          <div class="ev-row">
            <span class="ev-k">{{ t('evolve.field.unit') }}</span>
            <div class="ev-v ev-col">
              <label class="ev-radio">
                <input v-model="draft.mode" type="radio" value="auto" data-field="mode-auto" />
                <span>{{ t('evolve.field.unit-auto') }}</span>
                <span class="ev-muted">{{ t('evolve.field.unit-auto-hint') }}</span>
              </label>
              <label class="ev-radio">
                <input v-model="draft.mode" type="radio" value="pane" data-field="mode-pane" />
                <span>{{ t('evolve.field.unit-pane') }}</span>
                <select
                  class="nv-select"
                  data-field="pane"
                  :disabled="draft.mode !== 'pane'"
                  :value="draft.pane_id"
                  @change="pickPane(($event.target as HTMLSelectElement).value)"
                >
                  <option value="" disabled>{{ t('evolve.field.pick-pane') }}</option>
                  <option v-if="missingPane" :value="missingPane.pane_id" data-missing="true">
                    {{ t('evolve.field.pane-gone', { name: missingPane.pane_name || missingPane.pane_id.slice(0, 8) }) }}
                  </option>
                  <option v-for="p in paneOptions" :key="p.pane_id" :value="p.pane_id">
                    {{ p.name || p.pane_id }} · {{ p.agent_key }}
                  </option>
                </select>
              </label>
              <span v-if="draft.mode === 'pane'" class="ev-muted">{{ t('evolve.field.unit-pane-hint') }}</span>
              <span v-if="errors.pane_id" class="ev-err">{{ errors.pane_id }}</span>
            </div>
          </div>

          <!-- CLI / model / effort -->
          <div class="ev-row">
            <span class="ev-k">{{ t('evolve.field.cli') }}</span>
            <div class="ev-v">
              <select v-model="draft.agent" class="nv-select" data-field="agent">
                <option v-for="o in agentOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
              </select>
              <input
                v-model.trim="draft.model"
                class="nv-input ev-model"
                data-field="model"
                type="text"
                spellcheck="false"
                :disabled="!modelSupported"
                :placeholder="modelSupported ? t('evolve.field.model-default') : t('evolve.field.model-unsupported')"
              />
              <select v-if="knownEfforts.length" v-model="draft.effort" class="nv-select" data-field="effort" :disabled="!effortSupported">
                <option value="">{{ t('evolve.field.effort-default') }}</option>
                <option v-for="e in knownEfforts" :key="e" :value="e">effort: {{ e }}</option>
              </select>
              <input
                v-else
                v-model.trim="draft.effort"
                class="nv-input ev-effort"
                data-field="effort"
                type="text"
                spellcheck="false"
                :disabled="!effortSupported"
                :placeholder="effortSupported ? t('evolve.field.effort-default') : t('evolve.field.effort-unsupported')"
              />
            </div>
          </div>

          <!-- Budget -->
          <div class="ev-row">
            <span class="ev-k">{{ t('evolve.field.budget') }}</span>
            <div class="ev-v ev-budget">
              <label>
                <input v-model.number="draft.token_budget" class="nv-input ev-num" data-field="token_budget" type="number" min="1" step="10000" />
                <span class="ev-unit">{{ t('evolve.field.tokens-per-run') }}</span>
              </label>
              <label>
                <input
                  v-model.number="draft.max_runs_per_day"
                  class="nv-input ev-num-s"
                  data-field="max_runs_per_day"
                  type="number"
                  :min="EVOLVE_BOUNDS.max_runs_per_day[0]"
                  :max="EVOLVE_BOUNDS.max_runs_per_day[1]"
                />
                <span class="ev-unit">{{ t('evolve.field.runs-per-day') }}</span>
              </label>
              <label>
                <input
                  v-model.number="draft.max_fixes"
                  class="nv-input ev-num-s"
                  data-field="max_fixes"
                  type="number"
                  :min="EVOLVE_BOUNDS.max_fixes[0]"
                  :max="EVOLVE_BOUNDS.max_fixes[1]"
                />
                <span class="ev-unit">{{ t('evolve.field.fixes-per-run') }}</span>
              </label>
              <label>
                <input
                  v-model.number="draft.max_minutes"
                  class="nv-input ev-num-s"
                  data-field="max_minutes"
                  type="number"
                  :min="EVOLVE_BOUNDS.max_minutes[0]"
                  :max="EVOLVE_BOUNDS.max_minutes[1]"
                />
                <span class="ev-unit">{{ t('evolve.field.minutes-cap') }}</span>
              </label>
              <span v-for="k in (['token_budget', 'max_runs_per_day', 'max_fixes', 'max_minutes'] as const)" v-show="errors[k]" :key="k" class="ev-err" :data-error="k">
                {{ errors[k] }}
              </span>
            </div>
          </div>

          <!-- Permission scope -->
          <div class="ev-row">
            <span class="ev-k">{{ t('evolve.field.scope') }}</span>
            <div class="ev-v ev-col">
              <label class="ev-radio" :class="{ disabled: !isRepo }" :title="isRepo ? '' : t('evolve.field.scope-fix-no-git')">
                <input v-model="draft.scope" type="radio" value="fix" data-field="scope-fix" :disabled="!isRepo" />
                <span>{{ t('evolve.field.scope-fix') }}</span>
              </label>
              <span v-if="!isRepo" class="ev-muted" data-test="scope-fix-reason">{{ t('evolve.field.scope-fix-no-git') }}</span>
              <label class="ev-radio">
                <input v-model="draft.scope" type="radio" value="propose" data-field="scope-propose" />
                <span>{{ t('evolve.field.scope-propose') }}</span>
              </label>
              <span class="ev-muted">{{ t('evolve.field.scope-always-propose') }}</span>
            </div>
          </div>

          <!-- Rules -->
          <div class="ev-row">
            <span class="ev-k">{{ t('evolve.field.rules') }}</span>
            <div class="ev-v ev-col">
              <div>
                {{ t('evolve.field.rules-builtin', { version: state.template.version }) }}
                · <button class="ev-link" data-test="toggle-template" @click="showTemplate = !showTemplate">
                  {{ showTemplate ? t('evolve.field.rules-hide') : t('evolve.field.rules-view') }}
                </button>
              </div>
              <pre v-if="showTemplate" class="ev-template" data-test="template">{{ state.template.text }}</pre>
              <textarea
                v-model="draft.extra"
                class="nv-input ev-extra"
                data-field="extra"
                rows="3"
                :maxlength="EVOLVE_BOUNDS.extra"
                :placeholder="t('evolve.field.extra-placeholder')"
              />
              <span v-if="errors.extra" class="ev-err">{{ errors.extra }}</span>
            </div>
          </div>

          <!-- Last result -->
          <div class="ev-section" data-test="last-result">
            <div class="ev-sec-title">{{ t('evolve.panel.last-result') }}</div>
            <div v-if="!lastRun" class="ev-muted">{{ t('evolve.panel.no-runs') }}</div>
            <template v-else>
              <div>
                <span class="ev-dot" :class="lastRun.status" />
                <b>{{ statusText(lastRun.status) }}</b>
                · {{ runSpan(lastRun) }} · {{ fmtTokens(lastRun.tokens) }} token
                <template v-if="lastRun.pane_name || lastRun.pane_id">
                  · pane「{{ lastRun.pane_name || lastRun.pane_id }}」
                  <span v-if="lastRun.reclaimed" class="ev-muted">{{ t('evolve.panel.reclaimed') }}</span>
                  <span v-else-if="lastRun.reclaimed === false && lastRun.status !== 'running'" class="ev-muted">{{ t('evolve.panel.not-reclaimed') }}</span>
                </template>
              </div>
              <div v-if="lastRun.reason" class="ev-muted">{{ reasonText(lastRun.reason) }}</div>
              <div v-if="lastRun.summary">{{ lastRun.summary }}</div>
              <div v-for="c in lastRun.commits" :key="c.hash" class="ev-mono">
                {{ t('evolve.panel.fix') }} {{ c.hash.slice(0, 7) }} {{ c.title }}
              </div>
              <div v-for="p in lastRun.proposals" :key="p.rel_path">
                {{ t('evolve.panel.proposal') }}
                <button class="ev-link" @click="openProposal(p.rel_path)">{{ p.name || p.rel_path }}</button>
              </div>
            </template>
          </div>

          <!-- History -->
          <div class="ev-section">
            <div class="ev-sec-title">{{ t('evolve.panel.history') }}</div>
            <table v-if="history.length" class="ev-table" data-test="history">
              <thead>
                <tr>
                  <th>{{ t('evolve.history.date') }}</th>
                  <th>{{ t('evolve.history.result') }}</th>
                  <th>{{ t('evolve.history.fixes') }}</th>
                  <th>{{ t('evolve.history.proposals') }}</th>
                  <th>token</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in history" :key="r.id" :data-run-id="r.id">
                  <td>{{ fmtDate(r.started_at) }} {{ fmtClock(r.started_at) }}</td>
                  <td :title="reasonText(r.reason)"><span class="ev-dot" :class="r.status" />{{ statusText(r.status) }}</td>
                  <td>{{ r.commits.length }}</td>
                  <td>{{ r.proposals.length }}</td>
                  <td>{{ fmtTokens(r.tokens) }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="ev-muted">{{ t('evolve.panel.no-runs') }}</div>
          </div>

          <!-- Ledger -->
          <div class="ev-row">
            <span class="ev-k">{{ t('evolve.field.ledger') }}</span>
            <div class="ev-v">
              <button v-if="state.settings.ledger_plan" class="ev-link" data-test="ledger" @click="openLedger">
                {{ ledgerName }} →
              </button>
              <input
                v-model.trim="draft.ledger_plan"
                class="nv-input ev-ledger"
                data-field="ledger_plan"
                type="text"
                spellcheck="false"
                :placeholder="t('evolve.field.ledger-placeholder')"
              />
            </div>
          </div>

          <p v-if="opError" class="ev-err ev-server" data-test="op-error">{{ opError }}</p>
        </div>

        <div class="ev-actions">
          <span v-if="dirty" class="ev-muted">{{ t('evolve.panel.unsaved') }}</span>
          <span class="ev-spacer" />
          <button class="nv-btn" data-test="cancel" @click="emit('close')">{{ t('evolve.panel.close') }}</button>
          <button class="nv-btn nv-btn--primary" data-test="save" :disabled="saving || !dirty" @click="save()">
            {{ t('evolve.panel.save') }}
          </button>
        </div>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.ev-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
}
.ev-card {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 1001;
  width: min(640px, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  font-size: var(--font-xs);
  color: var(--text-primary);
}
.ev-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 8px;
  border-bottom: 1px solid var(--border-muted);
}
.ev-title {
  flex: none;
  font-weight: 600;
  color: var(--text-bright);
}
.ev-ws {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.ev-x {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ev-pad {
  padding: 12px 16px;
}
.ev-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ev-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-control);
  border: 1px solid var(--border-default);
}
.ev-status.on {
  border-color: var(--success-muted);
  background: var(--success-subtle);
}
.ev-status.off {
  border-color: var(--accent-muted);
  background: var(--accent-subtle);
}
.ev-status-main {
  flex: 1;
  min-width: 0;
}
.ev-status.on .ev-status-line b {
  color: var(--success-fg);
}
.ev-status-sub {
  flex: 1;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.ev-start {
  flex: none;
}
.ev-ok {
  font-size: var(--font-2xs);
  color: var(--success-fg);
}
.ev-legacy {
  padding: 5px 8px;
  border: 1px solid var(--attention-muted);
  border-radius: var(--radius-control);
  background: var(--attention-subtle);
  color: var(--attention-fg);
  font-size: var(--font-2xs);
}
.ev-disclose {
  padding: 6px 8px;
  border-left: 2px solid var(--accent-fg);
  background: var(--bg-subtle);
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  line-height: 1.5;
}
.ev-disclose b {
  color: var(--text-primary);
  margin-right: 4px;
}
.ev-row {
  display: flex;
  gap: 10px;
  min-width: 0;
}
.ev-k {
  flex: none;
  width: 72px;
  padding-top: 4px;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.ev-v {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.ev-col {
  flex-direction: column;
  align-items: flex-start;
}
.ev-radio {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.ev-radio.disabled {
  opacity: 0.5;
}
.ev-budget label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ev-time {
  width: 100px;
}
.ev-tz {
  width: 140px;
}
.ev-model {
  width: 180px;
}
.ev-effort {
  width: 90px;
}
.ev-num {
  width: 100px;
}
.ev-num-s {
  width: 64px;
}
.ev-ledger {
  flex: 1;
  min-width: 160px;
}
.ev-extra {
  width: 100%;
  resize: vertical;
  font-family: inherit;
}
.ev-template {
  width: 100%;
  max-height: 220px;
  overflow: auto;
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-control);
  background: var(--bg-base);
  font-size: var(--font-3xs);
  white-space: pre-wrap;
}
.ev-unit,
.ev-muted {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.ev-link {
  appearance: none;
  border: none;
  background: transparent;
  padding: 0;
  font: inherit;
  color: var(--accent-fg);
  cursor: pointer;
}
.ev-link:hover {
  text-decoration: underline;
}
.ev-section {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: 6px;
  border-top: 1px solid var(--border-muted);
}
.ev-sec-title {
  font-weight: 600;
  color: var(--text-bright);
}
.ev-mono {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-2xs);
}
.ev-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 4px;
  border-radius: var(--radius-pill);
  background: var(--text-disabled);
  vertical-align: middle;
}
.ev-dot.ok {
  background: var(--success-fg);
}
.ev-dot.running {
  background: var(--accent-fg);
}
.ev-dot.error,
.ev-dot.timeout {
  background: var(--danger-fg);
}
.ev-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-2xs);
}
.ev-table th,
.ev-table td {
  padding: 2px 6px;
  text-align: left;
  border-bottom: 1px solid var(--border-muted);
}
.ev-table th {
  color: var(--text-secondary);
  font-weight: 600;
}
.ev-err {
  font-size: var(--font-2xs);
  color: var(--danger-bright);
}
.ev-server {
  margin: 0;
  padding: 5px 8px;
  border: 1px solid var(--danger-muted);
  border-radius: var(--radius-control);
  background: var(--danger-subtle);
  word-break: break-word;
}
.ev-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px 12px;
  border-top: 1px solid var(--border-muted);
}
.ev-spacer {
  flex: 1;
}
</style>
